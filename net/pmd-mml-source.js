// PMD曲(.M/.m2)の書庫内エントリから、同じディレクトリ・同じベース名のMMLソース
// (`.mml`/`.MML`、大文字小文字無視)を見つける窓口。net/pmd-pcm.js
// collectPmdPcmFiles()と同じ流儀(DOM非依存の純関数。html/pmd-app.jsと検証の
// 両方から同じ関数を本番経路として通す。ヘルパを別に用意して検証だけ通す、
// という形にはしない)。
//
// 背景(利用者報告、2026-08-18): 「SS_TENG_PPZを聞いていたのに、編集ボタンを
// 押したらエリーゼになっている」。原因は編集欄には前に入っていた内容
// (曲を再生してもMMLは経由しないため、`.M`バイナリからは復元できない)が残ること。
// 一方で書庫内には曲と同じディレクトリへ`.mml`が同梱されている実物がある
// (例: SS_TENG_ppz.m に対する SS_TENG_ppz.mml)。これを拾って編集欄へ静かに
// 反映すれば、MMLソースを持つ曲は常に「聞いていた曲のMML」が編集欄に入る。
//
// 取り違え防止(net/pmd-pcm.js collectPmdPcmFiles()と同じ罠、コミット6de2839
// 参照): basenameだけで一致判定すると別ディレクトリの同名`.mml`を誤って拾い
// うる。呼び出し元は必ず「主ファイルと同じディレクトリのエントリ集合」
// (SongCandidate.related、net/song-select.js。既にディレクトリで絞り込み
// 済み)を渡すこと。この関数自身はディレクトリを跨いでは探さない(渡された
// 集合をそのまま信頼し、その中だけで探す)。

import { baseNameOf } from './archive.js';
import { decodeMmlBytes } from './charset.js';

const MML_EXT_RE = /\.mml$/i;

/** @param {string} name */
function stripExt(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(0, i) : name;
}

/**
 * 主ファイル名と「同じディレクトリのエントリ集合」から、同じベース名の
 * `.mml`/`.MML` エントリを探す。複数見つかった場合は集合内で最初に現れたものを
 * 採用する(同じディレクトリに同名`.mml`が複数あるのは通常想定しない構成だが、
 * 「出現順最初」で固定し常に同じ結果になるようにする。collectPmdPcmFiles()の
 * 採用規則と同じ考え方)。
 * @param {string} songName 主ファイルのエントリ名(パスを含んでいてもよい。
 *   basenameだけを使う)
 * @param {{name: string, data: Uint8Array}[]} relatedEntries 主ファイルと
 *   同じディレクトリの他エントリ集合(net/song-select.js SongCandidate.related)。
 *   呼び出し元がディレクトリを絞り込んだ状態で渡すこと(この関数はディレクトリを
 *   見ない)。
 * @returns {{name: string, data: Uint8Array} | null}
 */
export function findMmlSourceEntry(songName, relatedEntries) {
  if (!relatedEntries || relatedEntries.length === 0) return null;
  const songBase = stripExt(baseNameOf(songName)).toLowerCase();
  for (const entry of relatedEntries) {
    const base = baseNameOf(entry.name);
    if (!MML_EXT_RE.test(base)) continue;
    if (stripExt(base).toLowerCase() === songBase) return entry;
  }
  return null;
}

/**
 * findMmlSourceEntry()が見つけたエントリを net/charset.js decodeMmlBytes()で
 * デコードしてテキストとして返す。見つからなければnull(=「この曲にはMMLソースが
 * 無い」)。
 * @param {string} songName
 * @param {{name: string, data: Uint8Array}[]} relatedEntries
 * @returns {string | null}
 */
export function extractMmlSourceText(songName, relatedEntries) {
  const entry = findMmlSourceEntry(songName, relatedEntries);
  if (!entry) return null;
  return decodeMmlBytes(entry.data).text;
}
