// MUCOM88曲(d88由来)に「対になるシステムディスク」の外部音色バンク(voice.dat)を
// 見つける層。DOM非依存(net/song-select.js・net/library.jsから共通で使う。
// tools/verify_voice_bank_pairing.mjsから直接検証できる)。
//
// 背景: サンプルMML集(実データ、archive-util.js経由でd88も展開される)は、
// 曲を収めたディスク `MML_<X>.d88` と、その曲が使う音色バンクを収めた
// システムディスク `MUCOM88_V<バージョン>_<X>.d88` (voice.dat、8192byte=256スロット
// ×32byte)が対になっている(実測、docs/voice-external-bank-experiment.md参照)。
// 対応が無いディスク(ALGARNA/SLAP_FIGHT_MDは対になるシステムディスクがzip内に
// 存在しない)は意図的に対象外のままにする(推測でスロットを補わない)。
//
// net/archive.js の extractArchive() は d88 を最大2段まで再帰展開し、内側の
// エントリ名を `<d88のエントリ名>/<内側のファイル名>` にして元のentries一覧へ
// フラットに並べる。つまり「MML_ACTRAISER.d88の中のstg001」は
// "MML_ACTRAISER.d88/STG001.muc" のようなパス名になり、
// 「MUCOM88_V1.5_ACTRAISER.d88の中のvoice.dat」は
// "MUCOM88_V1.5_ACTRAISER.d88/VOICE.DAT" のようなパス名で同じentries一覧に
// 並ぶ(system diskの生バイト列そのものは残らないが、展開済みのvoice.datエントリが
// 既にそこにある。d88をこの層で再度パースする必要は無い)。

const MML_DISK_SEGMENT_RE = /^MML_(.+)\.d88$/i;
const VOICEDAT_BASENAME_RE = /^voice\.dat$/i;
export const VOICE_BANK_SIZE = 8192; // MUCOM88_VOICEFORMAT: 256スロット×32byte(voiceformat.h)

/** 正規表現の特殊文字をエスケープする。 @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
 * @returns {{ entry: import('./archive-util.js').ArchiveEntry, bytes: Uint8Array, sysDiskName: string } | null}
 */
export function findPairedVoiceBank(entries, candidateEntryName) {
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
    return { entry, bytes: entry.data.subarray(0, VOICE_BANK_SIZE), sysDiskName: eSysDiskSegment };
  }
  return null;
}
