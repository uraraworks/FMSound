// MUCOM88の `@"名前"` 形式の音色参照を `@番号` へ事前解決する。
//
// 背景(実測で確定済み。docs等の裏取り無しに再調査しないこと):
//   MUCOM88のZ80コンパイラは `@"名前"` の名前部分に非ASCIIバイト(半角カナ等)を
//   含むと必ず `FM Voice not found` で落ちる。
//     A @"flute"c   -> 通る(ASCII名)
//     A @"ｿｳﾙﾍﾞ"c    -> 落ちる(半角カナを含む)
//   ネイティブビルドでCP932生バイトを渡しても同じ結果になるため、embind/UTF-8の
//   符号化経路の問題ではなくZ80側の名前照合そのものの問題と判断した。
//   一方 `@n`(数値指定)はn=0..255の全件が実測で通る。
//   よって「`@"名前"` を、その名前が入っているスロット番号の `@番号` へ
//   事前置換する」ことで回避する。データ自体は既定音色バンクに正しく存在している
//   (半角カナ名のスロットも含め、バイト完全一致で実在する)。
//
// データの出所(バンクを指定しない既定の場合): ui/mucom-voice-table.js
// (tools/gen_mucom_voice_names.pyが upstream/MucomWeb/mucom88/src/bin_voice.h
// から生成した既定音色バンクの「スロット番号 -> 名前(生6バイト)」表。upstream/は
// gitignore対象でビルド時にしか存在しないため、このモジュールはそれを実行時に
// 読みに行かず、生成済みの ui/mucom-voice-table.js だけに依存する)。
//
// 【外部音色バンク対応・2026-08-16】曲が対になるシステムディスクの外部音色バンク
// (net/voice-bank.js、8192byte=256スロット×32byte)を使う場合、`@"名前"` の解決は
// **その外部バンク自身のバイト列から作った名前表**で行わなければならない。
// 埋め込み既定バンクの表のまま外部バンクを読ませると、同じ`@番号`が指す音色が
// バンクによって違う(既定バンクとディスクのvoice.datは多くのスロットで中身が
// 異なることを実測済み、docs/voice-external-bank-experiment.md参照)ため、
// 名前が意図しない別の音色へ解決されてしまう(「@164」が別の楽器を指す、という形の
// 不具合になる)。resolveMucomVoiceNameRefs()の第2引数にバンクの生バイト列を渡すと、
// そのバンクから即席で名前表を作って使う(buildTableFromRawBank())。省略時は
// これまでどおり埋め込み既定バンクの表を使う。
//
// 【不具合修正・2026-08-16、コーディネーター指摘】以前ここには「外部バンク自身の
// 表→見つからなければ既定バンクへフォールバック」という連鎖があった。これは
// net/voice-bank.js側の別の不具合(voice.datの本体開始位置を先頭0byte目と
// 決め打っていたため、実際は4byteのヘッダ分ずれて全スロットが4byteずれて
// 読まれていた)の結果、「外部バンクは名前を1件も持たない」という誤った実測に
// 基づいて追加したものだった。net/voice-bank.js側のオフセット自動検出
// (detectBankOffset())でその不具合を直したところ、実データ(サンプルMML集46曲、
// 対になるシステムディスク8枚)では**外部バンク自身の表だけで98件の`@"名前"`参照が
// 全件解決できる**ことを確認した(フォールバックが実際に発動する例は0件)。
// 誤った土台の上で追加したフォールバックを温存する理由が無いため、削除した。
// `@"名前"`はバンクを使う曲では常にそのバンク自身の表でのみ解決する
// (見つからなければ未解決のまま残す。既定バンクの番号を代わりに使うことはしない)。
//
// 名前の埋め方(パディング)がスロットにより不統一(末尾を空白0x20で埋めるものが
// 大半だが、NUL 0x00で埋めているものも実在する)なので、名前の同一性判定は
// 「末尾の空白(0x20)とNUL(0x00)を取り除いた残りのバイト列が一致するか」で行う。
// 全6バイトが空白またはNULだけ(=中身が無い)のスロットは名前表に含めない。
// この規則は既定バンクにも外部バンクにも同じ規則を適用する(データ形式が同じ
// MUCOM88_VOICEFORMATである以上、どちらも同じ解釈をするのが正しい)。
//
// 重複名について: 上記の正規化後、既定バンクの実データに6件の重複がある(実測、
// tools/verify_mucom_voice_name.mjs参照): 'efctes'(slot0/192), '??????'(slot75/83),
// '7thv01'(slot122/126), '7thv05'(slot175/205), 'p_brs3'(slot176/194),
// 'sbass3'(slot193/196)。同じ名前でも音色の中身(FM/SSGパラメータ)が同一である
// 保証は無いが、名前だけを頼りに `@"名前"` と書いた利用者にとってどちらが
// 「正解」かを判断する材料が無い。よって単純に「最初に見つかった方
// (スロット番号が小さい方)を採用する」とする(推測で優先順位を作らない)。
// 外部バンクの名前表を作るbuildTableFromRawBank()でも同じ規則を使う。
//
// 名前の比較はCP932の生バイト列で行う(JSの文字列比較にすると半角カナの扱いで
// 事故る。ui/cp932-encode.jsのencodeCp932()で符号化してから比較する)。

import { MUCOM_DEFAULT_VOICE_NAMES } from './mucom-voice-table.js';
import { encodeCp932 } from './cp932-encode.js';

const NAME_FIELD_LENGTH = 6; // voiceformat.h: name[6]
const VOICE_SLOT_SIZE = 32; // voiceformat.h: MUCOM88_VOICEFORMAT 1件のバイト数
const VOICE_NAME_OFFSET = 26; // voiceformat.h: hed(1)+26バイトのビットフィールド群の直後がname[6]

/** 16進文字列(nameHex)をUint8Arrayへ。 @param {string} hex */
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** 末尾の空白(0x20)とNUL(0x00)を取り除く。 @param {Uint8Array} bytes */
function trimTrailingPad(bytes) {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0x20 || bytes[end - 1] === 0x00)) end--;
  return bytes.subarray(0, end);
}

/** 正規化済みバイト列を、Mapのキーに使える文字列へ(16進表現)。 @param {Uint8Array} bytes */
function toKey(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

let cachedDefaultTable = null;

/** 埋め込み既定バンク(ui/mucom-voice-table.js)から「名前 -> スロット番号」表を作る(遅延構築・キャッシュ)。 */
function buildDefaultTable() {
  if (cachedDefaultTable) return cachedDefaultTable;
  const map = new Map();
  for (const { slot, nameHex } of MUCOM_DEFAULT_VOICE_NAMES) {
    const trimmed = trimTrailingPad(hexToBytes(nameHex));
    if (trimmed.length === 0) continue; // 中身の無い名前は対象にしない
    const key = toKey(trimmed);
    if (!map.has(key)) map.set(key, slot); // 重複は最初に見つかった方(スロット番号が小さい方)を採る
  }
  cachedDefaultTable = map;
  return cachedDefaultTable;
}

/**
 * 外部音色バンクの生バイト列(8192byte=256スロット×32byte、MUCOM88_VOICEFORMAT)から
 * 即席で「名前 -> スロット番号」表を作る。buildDefaultTable()と全く同じ正規化・
 * 重複解決規則を適用する(データ形式が同じである以上、解釈も同じであるべき)。
 * バイト数が32の倍数でない・256スロット分に満たない場合も、読める範囲のスロットまでは
 * 処理する(壊れたデータでも例外を投げて再生を止めない。呼び出し側=net/voice-bank.jsの
 * findPairedVoiceBank()が既に8192byte未満のバンクを弾いているため、実運用では
 * 常に256スロットぶん揃っている想定)。
 * @param {Uint8Array} bankBytes
 * @returns {Map<string, number>}
 */
function buildTableFromRawBank(bankBytes) {
  const map = new Map();
  const slotCount = Math.floor(bankBytes.length / VOICE_SLOT_SIZE);
  for (let slot = 0; slot < slotCount; slot++) {
    const nameOffset = slot * VOICE_SLOT_SIZE + VOICE_NAME_OFFSET;
    const raw = bankBytes.subarray(nameOffset, nameOffset + NAME_FIELD_LENGTH);
    const trimmed = trimTrailingPad(raw);
    if (trimmed.length === 0) continue;
    const key = toKey(trimmed);
    if (!map.has(key)) map.set(key, slot);
  }
  return map;
}

/**
 * 音色名(JS文字列)を、音色バンク中のスロット番号へ解決する。
 * 見つからない場合や、CP932へ変換できない文字を含む場合はnullを返す。
 * @param {string} name
 * @param {Map<string, number> | Map<string, number>[]} [table] 省略時は埋め込み既定バンクの表
 *   (buildDefaultTable())。複数の表を配列で渡すと先頭から順に探し、最初に見つかった表の
 *   スロット番号を返す(フォールバック連鎖。resolveMucomVoiceNameRefs()参照:
 *   外部音色バンクを使う場合は「[外部バンクの表, 既定バンクの表]」の順で渡す)。
 * @returns {number | null}
 */
export function resolveVoiceNameToSlot(name, table) {
  const { bytes, unmappable } = encodeCp932(name);
  if (!bytes || unmappable.length > 0) return null;
  if (bytes.length > NAME_FIELD_LENGTH) return null; // 6バイトの名前フィールドに収まらない
  const tables = table ? (Array.isArray(table) ? table : [table]) : [buildDefaultTable()];
  // 名前フィールド側のキーは正規化(末尾パディング除去)済みなので、MML側にも同じ規則を
  // 適用してから比較する。
  //
  // 【不具合修正・2026-08-16】以前はMML側に trimTrailingPad() を掛けておらず、
  // 表側だけが正規化された非対称な比較になっていた。そのため MML が
  // `@"ｿｳﾙﾍﾞ "` のように末尾へ空白を付けて書いていると解決できなかった
  // (実測: `ｿｳﾙﾍﾞ`→201 に対し `ｿｳﾙﾍﾞ `→null。半角カナ固有ではなく `flute ` でも同じ)。
  // 名前フィールドは6バイトの空白詰め固定長で末尾の空白に意味が無いため、
  // 両側を同じ規則で正規化するのが正しい。実データでは stk023(BARE_KNUCKLE)が
  // これに該当し、唯一解決できない曲として残っていた。
  const key = toKey(trimTrailingPad(bytes));
  for (const t of tables) {
    if (t.has(key)) return t.get(key);
  }
  return null;
}

// `@"..."` の形にマッチする箇所だけを対象にする正規表現。単純な文字列置換
// (MML本文中の別の同じ綴りの箇所やコメント相当の記述を巻き込む事故)を避けるため、
// この構文に一致した部分だけを置換対象にする。
const VOICE_NAME_REF_RE = /@"([^"]*)"/g;

/**
 * MML本文中の `@"名前"` 参照を、解決できたものだけ `@番号` へ置き換える。
 * 表に無い名前は置換しない(そのまま残す。無理に番号を割り当てて「通ったこと」に
 * しない)。
 * @param {string} mmlText
 * @param {Uint8Array} [bankBytes] 省略時は埋め込み既定バンクの表だけで解決する。
 *   この曲が対になる外部音色バンクを使う場合(コンパイル時に実際にそのバンクを
 *   `#voice`で読ませる場合)は、そのバンクの生バイト列を渡すこと。渡した場合、
 *   `@"名前"` は**そのバンク自身の名前表(buildTableFromRawBank())だけ**で解決する
 *   (埋め込み既定バンクへのフォールバックはしない)。
 *
 *   【フォールバックを廃止した経緯・実測、2026-08-16】かつてここには
 *   「①バンク自身の表→②見つからなければ既定バンクの表」というフォールバックが
 *   あったが、それは net/voice-bank.js 側の不具合(voice.datの本体が実際は
 *   4byteのヘッダの後ろから始まるのに、先頭0byte目からと決め打っていたため、
 *   全スロットが4byteずれて読まれていた)が原因で「バンクは名前を1件も
 *   持たない」という誤った実測結果に基づいて追加したものだった。
 *   net/voice-bank.js の detectBankOffset() でその不具合を修正した後、
 *   実データ(サンプルMML集46曲、対になるシステムディスク8枚)で再測定したところ、
 *   バンク自身の表だけで`@"名前"`参照98件全てが解決でき、フォールバックが
 *   実際に発動する例は0件だった。誤った土台の上のフォールバックを温存する
 *   理由が無いため削除した。今後もし本当に名前を保持しない(または壊れた)
 *   バンクに出会った場合は、その`@"名前"`参照は未解決のまま残る
 *   (既定バンクの番号を代わりに割り当てて「通ったことにする」ことはしない)。
 * @returns {{ text: string, replacedCount: number, unresolvedNames: string[] }}
 */
export function resolveMucomVoiceNameRefs(mmlText, bankBytes) {
  const table = bankBytes ? buildTableFromRawBank(bankBytes) : undefined;
  let replacedCount = 0;
  const unresolvedNames = [];
  const text = mmlText.replace(VOICE_NAME_REF_RE, (whole, name) => {
    const slot = resolveVoiceNameToSlot(name, table);
    if (slot === null) {
      unresolvedNames.push(name);
      return whole;
    }
    replacedCount++;
    return `@${slot}`;
  });
  return { text, replacedCount, unresolvedNames };
}
