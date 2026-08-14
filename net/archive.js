// LZH/ZIPアーカイブ展開の公開API。
// PC98/WebNP2/src/api/archive.ts の移植(型注釈を除いただけで、ロジックは無改変)。
// 実際の解析・展開処理は lzh.js / zip.js に分割し、ここでは拡張子判定と振り分けのみ行う。

import { isMetadataEntry } from './archive-util.js';
import { extractLzh } from './lzh.js';
import { extractZip } from './zip.js';

/** ファイル名の拡張子(大文字小文字無視)からLZH/ZIPアーカイブかどうかを判定する。 @param {string} fileName */
export function isArchive(fileName) {
  return /\.(lzh|zip)$/i.test(fileName);
}

/**
 * アーカイブ内エントリ名(サブフォルダ付きパスを含みうる)からファイル名部分のみを取り出す。
 * @param {string} path
 */
export function baseNameOf(path) {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * アーカイブ(LZHまたはZIP)を展開し、格納されている各エントリを返す。
 * OS付随のメタデータエントリ(__MACOSX/、._ファイル、.DS_Store等)はここで一括除外する。
 * ZIP/LZHいずれの展開結果も必ずこの関数を経由するため、両形式に等しく効く。
 * @param {string} fileName @param {Uint8Array} bytes
 * @returns {Promise<import('./archive-util.js').ArchiveEntry[]>}
 */
export async function extractArchive(fileName, bytes) {
  let entries;
  if (/\.lzh$/i.test(fileName)) {
    entries = extractLzh(bytes);
  } else if (/\.zip$/i.test(fileName)) {
    entries = await extractZip(bytes);
  } else {
    throw new Error(`未対応のアーカイブ形式です: ${fileName}`);
  }
  return entries.filter((entry) => !isMetadataEntry(entry.name));
}

/**
 * 拡張子ではなくファイル先頭のマジックバイトからZIP/LZHを判定する。
 * URLの配信元が拡張子の付かないURLの場合に、中身を見てアーカイブかどうかを見分けるために使う。
 * @param {Uint8Array} bytes
 * @returns {'.zip' | '.lzh' | null}
 */
export function sniffArchiveExtension(bytes) {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 && bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)
  ) {
    return '.zip';
  }
  if (
    bytes.length >= 7 &&
    bytes[2] === 0x2d /* '-' */ &&
    bytes[3] === 0x6c /* 'l' */ &&
    (bytes[4] === 0x68 || bytes[4] === 0x7a) /* 'h' or 'z' */ &&
    bytes[6] === 0x2d /* '-' */
  ) {
    return '.lzh';
  }
  return null;
}

/**
 * ファイル名がアーカイブ拡張子でなければ、中身のマジックバイトから判定して
 * 拡張子を補った名前を返す。アーカイブでなければnull。
 * @param {string} fileName @param {Uint8Array} bytes
 */
export function resolveArchiveFileName(fileName, bytes) {
  if (isArchive(fileName)) return fileName;
  const ext = sniffArchiveExtension(bytes);
  return ext ? `${fileName}${ext}` : null;
}
