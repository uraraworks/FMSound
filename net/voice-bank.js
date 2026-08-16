// MUCOM88曲(d88由来)に「対になるシステムディスク」の外部音色バンク(voice.dat)を
// 見つける層。DOM非依存(net/song-select.js・net/library.jsから共通で使う。
// tools/verify_voice_bank_pairing.mjsから直接検証できる)。
//
// 背景: サンプルMML集(実データ、archive-util.js経由でd88も展開される)は、
// 曲を収めたディスク `MML_<X>.d88` と、その曲が使う音色バンクを収めた
// システムディスク `MUCOM88_V<バージョン>_<X>.d88` (voice.dat)が対になっている
// (実測、docs/voice-external-bank-experiment.md参照)。対応が無いディスク
// (ALGARNA/SLAP_FIGHT_MDは対になるシステムディスクがzip内に存在しない)は
// 意図的に対象外のままにする(推測でスロットを補わない)。
//
// net/archive.js の extractArchive() は d88 を最大2段まで再帰展開し、内側の
// エントリ名を `<d88のエントリ名>/<内側のファイル名>` にして元のentries一覧へ
// フラットに並べる。つまり「MML_ACTRAISER.d88の中のstg001」は
// "MML_ACTRAISER.d88/STG001.muc" のようなパス名になり、
// 「MUCOM88_V1.5_ACTRAISER.d88の中のvoice.dat」は
// "MUCOM88_V1.5_ACTRAISER.d88/VOICE.DAT" のようなパス名で同じentries一覧に
// 並ぶ(system diskの生バイト列そのものは残らないが、展開済みのvoice.datエントリが
// 既にそこにある。d88をこの層で再度パースする必要は無い)。
//
// 【不具合修正・2026-08-16、コーディネーター指摘】ディスクの`voice.dat`は
// 8192byte(256スロット×32byte、voiceformat.h)ちょうどではなく、実測では
// **8448byte(=4byteの固定ヘッダ + 8192byte本体 + 252byteの末尾埋め草)**だった。
// 8枚全ての先頭4byteが disk非依存の同じ値(`00 60 00 80`)で始まっており、これは
// スロットのデータではなく前段のヘッダ(N88-BASICのバイナリ保存ヘッダ相当と見られる。
// 中身の意味までは未特定)。旧実装は`entry.data.subarray(0, 8192)`のように先頭
// 0byte目からスロット配列だと決め打っており、**全スロットが4byteずれて読まれていた**
// (=全音色が別物にすり替わっていた。波形が変わったこと自体は「作曲時の音色に
// なった」ことの証拠にはならない、というコーディネーターの指摘どおり)。
//
// この修正では「4」を決め打ちしない。埋め込み既定バンクの名前表
// (`ui/mucom-voice-table.js`)と最も多く一致する開始オフセットを、候補オフセット
// (0 .. データ長-8192)を総当たりして選ぶ(detectBankOffset())。実測(サンプル
// MML集の対になるシステムディスク8枚)では、8枚とも一致数が最大になるのは
// オフセット4で、そのときの一致件数は6〜236件(ディスクにより音色の作り込み度が
// 違うため差がある)。オフセット0での一致件数は8枚とも0件だった
// (前回の実装が「外部バンクは名前を1件も持たない」と誤って結論していた原因)。

const MML_DISK_SEGMENT_RE = /^MML_(.+)\.d88$/i;
const VOICEDAT_BASENAME_RE = /^voice\.dat$/i;
export const VOICE_BANK_SIZE = 8192; // MUCOM88_VOICEFORMAT: 256スロット×32byte(voiceformat.h)
const VOICE_SLOT_SIZE = 32;
const VOICE_NAME_OFFSET_IN_SLOT = 26; // voiceformat.h: name[6]はスロット内オフセット26-31
const VOICE_SLOT_COUNT = VOICE_BANK_SIZE / VOICE_SLOT_SIZE; // 256

/** 正規表現の特殊文字をエスケープする。 @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 末尾の空白(0x20)とNUL(0x00)を取り除く。ui/mucom-voice-resolve.jsのtrimTrailingPad()と同じ規則。 @param {Uint8Array} bytes */
function trimTrailingPad(bytes) {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0x20 || bytes[end - 1] === 0x00)) end--;
  return bytes.subarray(0, end);
}

/** 正規化済みバイト列をMapのキー用文字列(16進)へ。 @param {Uint8Array} bytes */
function toKey(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/** 16進文字列(nameHex)をUint8Arrayへ。 @param {string} hex */
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/**
 * 埋め込み既定バンクの名前表(ui/mucom-voice-table.js の形式)から、
 * 「正規化後の名前キー」の集合を作る(重複は1件扱いでよい。ここでは一致数を
 * 数えるためだけに使うので、どのスロットの名前かは要らない)。
 * @param {{slot: number, nameHex: string}[]} defaultVoiceNames
 * @returns {Set<string>}
 */
function buildDefaultNameKeySet(defaultVoiceNames) {
  const set = new Set();
  for (const { nameHex } of defaultVoiceNames) {
    const trimmed = trimTrailingPad(hexToBytes(nameHex));
    if (trimmed.length === 0) continue;
    set.add(toKey(trimmed));
  }
  return set;
}

/**
 * 生バイト列の指定オフセットを起点に256スロットぶん読んだとき、埋め込み既定バンクの
 * 名前表と一致する名前が何件あるかを数える。
 * @param {Uint8Array} rawBytes @param {number} offset @param {Set<string>} defaultNameKeySet
 */
function countNameMatchesAtOffset(rawBytes, offset, defaultNameKeySet) {
  let matches = 0;
  for (let slot = 0; slot < VOICE_SLOT_COUNT; slot++) {
    const nameStart = offset + slot * VOICE_SLOT_SIZE + VOICE_NAME_OFFSET_IN_SLOT;
    const nameEnd = nameStart + 6;
    if (nameEnd > rawBytes.length) break;
    const trimmed = trimTrailingPad(rawBytes.subarray(nameStart, nameEnd));
    if (trimmed.length === 0) continue;
    if (defaultNameKeySet.has(toKey(trimmed))) matches++;
  }
  return matches;
}

/**
 * 音色バンクの生バイト列(ヘッダの有無・長さが不明)の中から、256スロット×32byteの
 * 本体が実際に始まる位置を実測で推定する。候補オフセット(0 .. データ長-8192)を
 * 総当たりし、埋め込み既定バンクの名前表と最も多く一致するオフセットを採用する
 * (「4byteヘッダ」と決め打ちしない。ディスクの流儀が変われば追随できる)。
 *
 * 一致件数が0のオフセットしか無い場合(=このバンクの名前フィールドが既定バンクの
 * どの名前とも一致しない)は、最も自然な既定値としてオフセット0を返す
 * (=旧実装と同じ「ヘッダ無し」扱い。判断材料が無いので決め打ちを増やさない)。
 * @param {Uint8Array} rawBytes @param {{slot: number, nameHex: string}[]} defaultVoiceNames
 * @returns {{ offset: number, matchCount: number }}
 */
export function detectBankOffset(rawBytes, defaultVoiceNames) {
  const defaultNameKeySet = buildDefaultNameKeySet(defaultVoiceNames);
  const maxOffset = rawBytes.length - VOICE_BANK_SIZE;
  let bestOffset = 0;
  let bestCount = -1;
  for (let offset = 0; offset <= maxOffset; offset++) {
    const count = countNameMatchesAtOffset(rawBytes, offset, defaultNameKeySet);
    if (count > bestCount) {
      bestCount = count;
      bestOffset = offset;
    }
  }
  return { offset: bestOffset, matchCount: Math.max(bestCount, 0) };
}

/**
 * 曲(候補)のentry.nameから、対になりうるシステムディスクの音色バンクを探す。
 * 見つからなければnull(呼び出し側は既定バンクのまま鳴らす。エラーではない)。
 *
 * 対象になるのは「d88から展開された曲」だけ(entry.nameが
 * `<...>/MML_<X>.d88/<ファイル名>` の形のもの)。単体ファイルやzip直下の.mucは
 * d88経由ではないためnullを返す(退行させない対象: 単体ファイル読み込み全般)。
 * @param {import('./archive-util.js').ArchiveEntry[]} entries 書庫全体の展開済みエントリ一覧
 * @param {string} candidateEntryName 曲候補(SongCandidate.entry.name)
 * @param {{slot: number, nameHex: string}[]} defaultVoiceNames 埋め込み既定バンクの名前表
 *   (ui/mucom-voice-table.js の MUCOM_DEFAULT_VOICE_NAMES)。バンク本体の開始オフセットを
 *   実測で特定するために必須(呼び出し側でimportして渡すこと。net/がui/を直接
 *   importしない、という既存の依存方向を保つため引数で受け取る設計にしている)。
 * @returns {{ entry: import('./archive-util.js').ArchiveEntry, bytes: Uint8Array, sysDiskName: string,
 *   bankOffset: number, nameMatchCount: number } | null}
 */
export function findPairedVoiceBank(entries, candidateEntryName, defaultVoiceNames) {
  const segments = candidateEntryName.split('/');
  if (segments.length < 2) return null; // d88経由でない(zip直下の単体ファイル等)
  const mmlDiskSegment = segments[segments.length - 2];
  const m = MML_DISK_SEGMENT_RE.exec(mmlDiskSegment);
  if (!m) return null; // "MML_<X>.d88" という命名規則に一致しないディスク
  const x = m[1];
  const parentPrefix = segments.slice(0, segments.length - 2).join('/');
  const sysDiskRe = new RegExp(`^MUCOM88_V[0-9.]+_${escapeRegExp(x)}\\.d88$`, 'i');

  for (const entry of entries) {
    const eSegments = entry.name.split('/');
    if (eSegments.length !== segments.length) continue; // 同じ階層深さ(=書庫内の同じ並び)のみ対象
    const eParentPrefix = eSegments.slice(0, eSegments.length - 2).join('/');
    if (eParentPrefix !== parentPrefix) continue;
    const eSysDiskSegment = eSegments[eSegments.length - 2];
    if (!sysDiskRe.test(eSysDiskSegment)) continue;
    const eFileSegment = eSegments[eSegments.length - 1];
    if (!VOICEDAT_BASENAME_RE.test(eFileSegment)) continue;
    if (!entry.data || entry.data.length < VOICE_BANK_SIZE) continue; // 不完全なデータは使わない(安全側)
    if (!defaultVoiceNames) {
      // 呼び出し側の実装ミスで名前表を渡し忘れたまま「対が見つかった」ことにすると、
      // オフセット特定ができず沈黙して先頭0byte目から読む(=4byteずれの再発)危険がある。
      // 警告で済ませず、ここで確実に気付けるように例外にする。
      throw new Error(
        'findPairedVoiceBank: defaultVoiceNames (ui/mucom-voice-table.js MUCOM_DEFAULT_VOICE_NAMES) ' +
          'is required once a paired system disk entry is actually found (bank offset detection needs it).',
      );
    }
    const { offset, matchCount } = detectBankOffset(entry.data, defaultVoiceNames);
    return {
      entry,
      bytes: entry.data.subarray(offset, offset + VOICE_BANK_SIZE),
      sysDiskName: eSysDiskSegment,
      bankOffset: offset,
      nameMatchCount: matchCount,
    };
  }
  return null;
}
