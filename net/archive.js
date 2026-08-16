// LZH/ZIPアーカイブ展開の公開API。
// PC98/WebNP2/src/api/archive.ts の移植(型注釈を除いただけで、ロジックは無改変)。
// 実際の解析・展開処理は lzh.js / zip.js に分割し、ここでは拡張子判定と振り分けのみ行う。

import { isMetadataEntry } from './archive-util.js';
import { extractD88, looksLikeD88 } from './d88.js';
import { extractLzh } from './lzh.js';
import { extractZip } from './zip.js';

// zip/lzhの中にd88が入っている(さらにその中に曲がある)、という2段構造の実データが
// あるため、d88エントリが見つかったらそれも展開してエントリ一覧に並べる。
// 無限再帰・zip爆弾を防ぐため、入れ子は2段までしか辿らない
// (depth=1: 最初に渡されたアーカイブ自身。depth=2: その中に見つかったd88の展開。
// depth=2の中でさらにd88が見つかっても、それ以上は展開せず生バイト列のまま残す)。
const MAX_NEST_DEPTH = 2;

/** ファイル名の拡張子(大文字小文字無視)からLZH/ZIP/d88アーカイブかどうかを判定する。 @param {string} fileName */
export function isArchive(fileName) {
  return /\.(lzh|zip|d88)$/i.test(fileName);
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
 * アーカイブ(LZH/ZIP/d88)を展開し、格納されている各エントリを返す。
 * OS付随のメタデータエントリ(__MACOSX/、._ファイル、.DS_Store等)はここで一括除外する。
 * ZIP/LZH/d88いずれの展開結果も必ずこの関数を経由するため、全形式に等しく効く。
 *
 * 展開結果にd88エントリが含まれていた場合、`depth < MAX_NEST_DEPTH` の範囲でそれも
 * 展開し、内側のエントリを `<d88のエントリ名>/<内側のファイル名>` という名前で
 * 元の一覧に並べる(実データが zip の中に d88 が18本、その中にさらに曲、という
 * 2段構造だったため)。深さの上限を超えたd88エントリは展開せず、生バイト列のまま
 * 一覧に残す(取りこぼさないが、それ以上は辿らない)。
 * @param {string} fileName @param {Uint8Array} bytes @param {number} [depth]
 * @returns {Promise<import('./archive-util.js').ArchiveEntry[]>}
 */
export async function extractArchive(fileName, bytes, depth = 1) {
  let entries;
  if (/\.lzh$/i.test(fileName)) {
    entries = extractLzh(bytes);
  } else if (/\.zip$/i.test(fileName)) {
    entries = await extractZip(bytes);
  } else if (/\.d88$/i.test(fileName)) {
    entries = extractD88(bytes);
  } else {
    throw new Error(`未対応のアーカイブ形式です: ${fileName}`);
  }
  entries = entries.filter((entry) => !isMetadataEntry(entry.name));

  if (depth >= MAX_NEST_DEPTH) return entries;

  const expanded = [];
  for (const entry of entries) {
    if (/\.d88$/i.test(entry.name)) {
      const inner = await extractArchive(entry.name, entry.data, depth + 1);
      for (const innerEntry of inner) {
        expanded.push({ ...innerEntry, name: `${entry.name}/${innerEntry.name}` });
      }
    } else {
      expanded.push(entry);
    }
  }
  return expanded;
}

/**
 * 拡張子ではなくファイル先頭のマジックバイト(ZIP/LZH)または構造(d88)からアーカイブ種別を判定する。
 * URLの配信元が拡張子の付かないURLの場合に、中身を見てアーカイブかどうかを見分けるために使う。
 * d88はヘッダ先頭16バイトがディスク名(任意文字列)なのでマジックバイトとして使えず、
 * looksLikeD88()(0x1Cのディスクサイズ・0x20以降のトラックオフセット表の構造的妥当性)で判定する
 * (ZIP/LZHのマジック判定が先に一致すればそちらを優先し、d88の構造チェックはその後に回す)。
 * @param {Uint8Array} bytes
 * @returns {'.zip' | '.lzh' | '.d88' | null}
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
  if (looksLikeD88(bytes)) {
    return '.d88';
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
