// アーカイブ展開結果(ArchiveEntry[])から「再生可能な曲」を選び出す層。
// wasm の MEMFS への配置は次のタスク(UI配線)でやるため、ここでは
// 「主ファイル + 関連ファイルの集合」として取り出せるところまでを担当する。

import { baseNameOf } from './archive.js';

/**
 * 拡張子(小文字・ドット付き) -> 音源ドライバ種別の対応表。ここに1行足すだけで
 * 新しい拡張子を再生候補に追加できるよう、判定表をこの1箇所にまとめている。
 * PMD の `.m`/`.m2` は将来のPMD移植向けの予約(現時点ではmucomwebのみ実装済み)。
 */
export const EXTENSION_DRIVER_TABLE = {
  '.muc': 'mucom',
  '.m': 'pmd',
  '.m2': 'pmd',
};

// 実物の検証材料(利用者提供、sample2をUTF-8化してmacOS zipで固めたもの)は中の
// ファイル名が "sample2.mml" で、EXTENSION_DRIVER_TABLE の '.muc' に一致しない
// (2026-08-15 net配線タスクで実測発覚)。拡張子だけで判別できない '.mml' は、
// 実際の中身の先頭がMUCOM88のヘッダ("#mucom88")かどうかを見て判定する
// (拡張子を "きっとmucomだろう"と決め打ちしない。中身で確かめる)。
const MUCOM_HEADER_RE = /^\s*#mucom88\b/i;

/** @param {Uint8Array} data */
function looksLikeMucomHeader(data) {
  if (!data || data.length === 0) return false;
  // ヘッダ判定はASCII範囲だけで足りる(先頭64バイトで十分)。CP932/UTF-8のどちらでも
  // ASCII部分のバイト列は同じなので、文字コード判定より先にここで判定してよい。
  const head = new TextDecoder('ascii', { fatal: false }).decode(data.subarray(0, 64));
  return MUCOM_HEADER_RE.test(head);
}

/** @param {string} name @param {Uint8Array} [data] */
function driverForName(name, data) {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = lower.slice(dot);
  if (EXTENSION_DRIVER_TABLE[ext]) return EXTENSION_DRIVER_TABLE[ext];
  if (ext === '.mml' && looksLikeMucomHeader(data)) return 'mucom';
  return null;
}

/** @param {string} name @param {Uint8Array} [data] */
export function isPlayableFileName(name, data) {
  return driverForName(name, data) !== null;
}

/**
 * MUCOM の曲は `#voice voice.dat` / `#pcm mucompcm.bin` のように、演奏に必要な
 * 別ファイルをMML内から相対パスで参照する。本層では参照解析まではせず(MMLの構文解析が
 * 必要になり、UI配線のタスクの範囲を超えるため)、実務上ほぼ確実に安全側に倒せる方針として
 * 「主ファイルと同じディレクトリに置かれた、主ファイル以外の全エントリ」を関連ファイル候補
 * として一括で持たせる。wasm MEMFS へ書き込む際は、この集合をまるごと配置すればよい。
 * @param {string} path
 */
function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i) : '';
}

/**
 * @typedef {{
 *   entry: import('./archive-util.js').ArchiveEntry,
 *   driver: 'mucom' | 'pmd',
 *   displayName: string,
 *   related: import('./archive-util.js').ArchiveEntry[],
 * }} SongCandidate
 */

/**
 * 展開済みアーカイブエントリ一覧から、再生可能な曲の候補を列挙する。
 * 1つの候補ごとに「主ファイル + 同じディレクトリの関連ファイル集合」を返す。
 * @param {import('./archive-util.js').ArchiveEntry[]} entries
 * @returns {SongCandidate[]}
 */
export function findSongCandidates(entries) {
  const candidates = [];
  for (const entry of entries) {
    const driver = driverForName(entry.name, entry.data);
    if (!driver) continue;
    const dir = dirOf(entry.name);
    const related = entries.filter((other) => other !== entry && dirOf(other.name) === dir);
    candidates.push({ entry, driver, displayName: baseNameOf(entry.name), related });
  }
  return candidates;
}
