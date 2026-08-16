// 曲ライブラリの「アルバム/トラック」表示のための、書庫内アルバム境界とトラック名の解決。
//
// 利用者判断(2026-08-16): アルバムの単位は zip 全体ではなく **d88(ディスク)単位**にする。
// 実データ(MCM_sample_20190124.zip)は1つのd88が1本のゲームのサントラに相当し
// (MML_BOSCONIAN.d88=3曲、MML_THE_SCHEME.d88=7曲…)、zip全体を1アルバムにすると
// 55曲の塊になって一覧が使い物にならないため。d88を含まない書庫は書庫自体が1アルバム、
// 単体ファイル読み込みはアルバム無し(呼び出し側でグループ化しない)。
//
// トラック名: この曲集のMMLはほとんど #title を持たないため、zipに同梱される
// `LIST_<ラベル>.txt`(曲名+トラック番号+ファイル名コードの一覧)から拾う。
// 対応規則は `MML_<ラベル>.d88` <-> `LIST_<ラベル>.txt`(<ラベル>が一致)。
// LIST_*.txt が無い書庫(またはこの曲集以外の書庫)でも例外を投げず、
// 単に「トラック名は取れなかった」(null)として呼び出し側にファイル名フォールバックを促す。

import { baseNameOf } from './archive.js';
import { decodeMmlBytesAs } from './charset.js';

/**
 * 書庫内エントリパス(例: "MCM_sample_20190124/MML_BOSCONIAN.d88/bos010.muc")から、
 * アルバムの境界となる区切りを求める。パスのどこかに `*.d88` セグメントがあれば
 * それをアルバムの単位にする(zip直下にd88を置く配布物・サブフォルダに入れた配布物の
 * どちらでも拾えるよう、先頭固定ではなく全セグメントから探す。net/archive.js の
 * MAX_NEST_DEPTH=2 制約により、d88セグメントは経路中に高々1つしか現れない)。
 * 見つからなければ null(=このエントリは書庫全体を1アルバムとして扱う)。
 * @param {string} entryPath
 * @returns {string[] | null}
 */
export function albumGroupPathFor(entryPath) {
  const segments = entryPath.split('/');
  const d88Index = segments.findIndex((s) => /\.d88$/i.test(s));
  if (d88Index < 0) return null;
  return [segments[d88Index]];
}

/**
 * アルバムの表示ラベルを決める。d88単位のアルバムは `MML_` 接頭辞と `.d88` 拡張子を
 * 落として素のラベル(例: "BOSCONIAN")にする。groupPathが無い(=書庫全体が1アルバム)
 * 場合は書庫自体の表示名(archiveLabel、通常はURL末尾のファイル名)をそのまま使う。
 * @param {string[] | null} groupPath
 * @param {string} archiveLabel
 */
export function albumLabelFor(groupPath, archiveLabel) {
  if (!groupPath || groupPath.length === 0) return archiveLabel;
  const seg = groupPath[groupPath.length - 1];
  const m = /^MML_(.+)\.d88$/i.exec(seg);
  return m ? m[1] : seg;
}

/** 正規表現の特殊文字をエスケープする(ディスクラベルをそのままRegExpへ埋め込むため)。 @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// LIST_*.txt本文の1行 = "<番号>. <曲名>[区切り][作曲者(任意)][区切り]<ファイル名コード>"。
// 区切りは実物10種類(LIST_ACTRAISER.txt 等)を全て確認して決めた: タブ1本以上、または
// 半角スペース2個以上のどちらか。曲名内の単語区切り(半角スペース1個、"Blood Pool ~
// Casandora" 等)を割らないためにスペース1個は区切りに含めない。
// LIST_BARE_KNUCKLE2.txt だけ「曲名(スペース詰め) + 作曲者 + タブ + ファイル名コード」の
// 3フィールド構成(作曲者付き)で、他9本は「曲名 + 区切り + ファイル名コード」の2フィールド。
const FIELD_SEP_RE = /\t+| {2,}/;
const LINE_RE = /^(\d+)\.\s*(.+)$/;

/**
 * `LIST_*.txt` の本文を1行1曲としてパースする。
 * @param {string} text
 * @returns {{ trackNumber: number, title: string, composer: string | null, fileNameCode: string }[]}
 */
export function parseTrackList(text) {
  const tracks = [];
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const parts = m[2].trim().split(FIELD_SEP_RE).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) continue; // ファイル名コードだけでは曲として使えない(タイトル不明)
    tracks.push({
      trackNumber: Number(m[1]),
      title: parts[0],
      composer: parts.length >= 3 ? parts[1] : null,
      fileNameCode: parts[parts.length - 1],
    });
  }
  return tracks;
}

// LIST_Etrian_Odyssey.txt側の既知の表記ゆれ(原資料のタイプミス。ディスク上の実ファイル名は
// "sq1_*"(数字の1)なのに一部の行が "sql_*"(アルファベットのl)になっている)を吸収するための
// 正規化。tools/verify_d88.mjs の normalizeName() と同じ規則(小文字化 + l→1)。
// ファイル名コードの照合にのみ使い、表示するタイトル文字列には適用しない。
function normalizeFileNameCode(name) {
  return name.toLowerCase().replace(/l/g, '1');
}

function stripExt(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(0, i) : name;
}

/**
 * 書庫展開結果(ArchiveEntry[])から、指定エントリに対応する `LIST_*.txt` のトラック名を探す。
 * 見つからなければ(LIST_*.txt自体が無い/対応する行が無い)全てnullを返す
 * (無理に当てない。呼び出し側はファイル名にフォールバックすること)。
 * @param {import('./archive-util.js').ArchiveEntry[]} entries
 * @param {string} entryPath
 * @returns {{ trackNumber: number | null, trackTitle: string | null, composer: string | null }}
 */
export function resolveTrackInfo(entries, entryPath) {
  const notFound = { trackNumber: null, trackTitle: null, composer: null };
  const groupPath = albumGroupPathFor(entryPath);
  if (!groupPath) return notFound;
  const diskSeg = groupPath[groupPath.length - 1];
  const diskLabelMatch = /^MML_(.+)\.d88$/i.exec(diskSeg);
  if (!diskLabelMatch) return notFound; // MML_*.d88という名前規則に乗らない書庫(この曲集専用の対応付けなので諦める)
  const diskLabel = diskLabelMatch[1];

  const listRe = new RegExp(`(?:^|/)LIST_${escapeRegExp(diskLabel)}\\.txt$`, 'i');
  const listEntry = entries.find((e) => listRe.test(e.name));
  if (!listEntry) return notFound;

  const text = decodeMmlBytesAs(listEntry.data, 'shift_jis');
  const tracks = parseTrackList(text);
  const target = normalizeFileNameCode(stripExt(baseNameOf(entryPath)));
  const found = tracks.find((t) => normalizeFileNameCode(t.fileNameCode) === target);
  if (!found) return notFound;
  return { trackNumber: found.trackNumber, trackTitle: found.title, composer: found.composer };
}
