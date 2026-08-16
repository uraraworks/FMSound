// ZIPアーカイブ展開モジュール。
// PC98/WebNP2/src/api/zip.ts の移植(型注釈を除いただけで、ロジックは無改変)。
// End Of Central Directory (EOCD) をファイル末尾から探索し、Central Directory を列挙、
// 各エントリの Local File Header からデータ位置を求めて展開する。
// 圧縮方式は stored(0) と deflate(8) のみ対応。deflate は DecompressionStream('deflate-raw') を使用する。

import { crc32, decodeDosDateTime, decodeSjisName, netError, readU16, readU32 } from './archive-util.js';

const EOCD_SIG = 0x06054b50;
const CDFH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_SIZE = 65535;

/** ファイル末尾からEOCDシグネチャを探索し、その開始オフセットを返す。 @param {Uint8Array} bytes */
function findEocd(bytes) {
  const minPos = Math.max(0, bytes.length - EOCD_MIN_SIZE - MAX_COMMENT_SIZE);
  for (let i = bytes.length - EOCD_MIN_SIZE; i >= minPos; i--) {
    if (readU32(bytes, i) === EOCD_SIG) {
      const commentLen = readU16(bytes, i + 20);
      if (i + EOCD_MIN_SIZE + commentLen === bytes.length) return i;
    }
  }
  throw netError('zip.eocdNotFound');
}

/** deflate-raw 圧縮データを DecompressionStream で伸張する。 @param {Uint8Array} compressed */
async function inflateRaw(compressed) {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  // Uint8Array のコピーを渡す(subarray由来のバッファ全体書き込みを避けるため)。
  void writer.write(compressed.slice());
  void writer.close();

  const reader = stream.readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * ZIPアーカイブ全体を解析し、格納されている各エントリを展開して返す。
 * @param {Uint8Array} bytes
 * @returns {Promise<import('./archive-util.js').ArchiveEntry[]>}
 */
export async function extractZip(bytes) {
  const eocdPos = findEocd(bytes);
  const cdEntryCount = readU16(bytes, eocdPos + 10);
  const cdOffset = readU32(bytes, eocdPos + 16);

  const entries = [];
  let pos = cdOffset;
  for (let i = 0; i < cdEntryCount; i++) {
    if (readU32(bytes, pos) !== CDFH_SIG) {
      throw netError('zip.centralDirSignatureInvalid');
    }
    const gpFlag = readU16(bytes, pos + 8);
    const method = readU16(bytes, pos + 10);
    const modTime = readU16(bytes, pos + 12);
    const modDate = readU16(bytes, pos + 14);
    const crcExpected = readU32(bytes, pos + 16);
    const compSize = readU32(bytes, pos + 20);
    const uncompSize = readU32(bytes, pos + 24);
    const fnLen = readU16(bytes, pos + 28);
    const extraLen = readU16(bytes, pos + 30);
    const commentLen = readU16(bytes, pos + 32);
    const localOffset = readU32(bytes, pos + 42);

    const nameBytes = bytes.subarray(pos + 46, pos + 46 + fnLen);
    const isUtf8 = (gpFlag & 0x0800) !== 0;
    let name = isUtf8 ? new TextDecoder('utf-8').decode(nameBytes) : decodeSjisName(nameBytes);
    name = name.replace(/\\/g, '/');

    pos += 46 + fnLen + extraLen + commentLen;

    if (name.endsWith('/')) {
      continue; // ディレクトリエントリは一覧から除外する
    }

    if (readU32(bytes, localOffset) !== LFH_SIG) {
      throw netError('zip.localHeaderSignatureInvalid', { name });
    }
    const lfhFnLen = readU16(bytes, localOffset + 26);
    const lfhExtraLen = readU16(bytes, localOffset + 28);
    const dataStart = localOffset + 30 + lfhFnLen + lfhExtraLen;
    const compressed = bytes.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) {
      if (compSize !== uncompSize) {
        throw netError('zip.storedSizeMismatch', { name });
      }
      data = compressed.slice();
    } else if (method === 8) {
      data = await inflateRaw(compressed);
    } else {
      throw netError('zip.unsupportedMethod', { method, name });
    }

    const actualCrc = crc32(data);
    if (actualCrc !== crcExpected) {
      throw netError('zip.crcMismatch', {
        name,
        expected: `0x${crcExpected.toString(16)}`,
        actual: `0x${actualCrc.toString(16)}`,
      });
    }

    entries.push({ name, data, mtime: decodeDosDateTime(modDate, modTime) });
  }
  return entries;
}
