// テスト専用の最小LZHエンコーダ(-lh0-/ヘッダレベル1)。
//
// macOSの標準ツールにはLZH書庫を「作成」できるものが無い(brewのlhasaは展開専用)ため、
// tools/verify_net_archive.mjs が「実物のバイト列」として使う .lzh を自前で組み立てる。
// net/lzh.js の復号ロジック(extractLzh)が読むヘッダレイアウトに合わせて、レベル1の
// 固定長フィールドを手で書き出しているだけで、net/lzh.js 側のコードは一切参照しない
// (エンコーダとデコーダが同じ思い込みを共有してしまうと検証にならないため独立実装にした)。
//
// 圧縮方式は -lh0-(無圧縮)のみに限定する。lh5/6/7のLZSS+ハフマン圧縮の「作成」側までは
// このタスクの範囲外(展開側の検証にはstoredで十分)。
//
// ヘッダレイアウト(レベル1、net/lzh.jsのextractLzhが読む範囲):
//   0      : header size (1 byte, 終端マーカー判定にのみ使われる。0以外なら値は任意)
//   1      : header checksum (1 byte, net/lzh.js側は未検証。参考用に計算する)
//   2-6    : method ID "-lh0-" (5 bytes)
//   7-10   : compressed size (u32 LE)
//   11-14  : original size (u32 LE)
//   15-18  : time (u32 LE, MS-DOS date/time形式)
//   19     : attribute (1 byte, 未使用)
//   20     : level (1 byte, =1)
//   21     : name length (1 byte。レベル1では拡張ヘッダでファイル名を持たせるため0にする)
//   22     : CRC16 (2 bytes)
//   24     : OS ID (1 byte)
//   25-    : 拡張ヘッダ列(各: size u16 LE, type 1byte, data...。size=0で終端)
//            type 0x01 = ファイル名(SJIS)
//   ...    : 圧縮データ(=元データそのもの、-lh0-なので)

import { crc16 } from '../net/archive-util.js';

// --- Unicode -> Shift_JIS の最小エンコーダ(テスト用。ASCIIは1バイトそのまま、
//     2バイト文字はTextDecoder('shift_jis')の全域総当たりでリバースマップを構築する) ---

let sjisReverseMap = null;

function buildSjisReverseMap() {
  const map = new Map();
  const decoder = new TextDecoder('shift_jis', { fatal: false });
  const leadRanges = [
    [0x81, 0x9f],
    [0xe0, 0xef],
  ];
  for (const [leadStart, leadEnd] of leadRanges) {
    for (let lead = leadStart; lead <= leadEnd; lead++) {
      for (let trail = 0x40; trail <= 0xfc; trail++) {
        if (trail === 0x7f) continue;
        const decoded = decoder.decode(new Uint8Array([lead, trail]));
        if (decoded.length !== 1) continue;
        if (decoded === '�') continue;
        if (map.has(decoded)) continue;
        map.set(decoded, [lead, trail]);
      }
    }
  }
  return map;
}

/** @param {string} text */
export function encodeSjisBytes(text) {
  if (!sjisReverseMap) sjisReverseMap = buildSjisReverseMap();
  const bytes = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) {
      bytes.push(code);
      continue;
    }
    const pair = sjisReverseMap.get(ch);
    if (!pair) throw new Error(`lzh-encoder: SJISへ変換できない文字です: ${ch}`);
    bytes.push(pair[0], pair[1]);
  }
  return Uint8Array.from(bytes);
}

function toDosDateTime(date) {
  const dosDate =
    (((date.getFullYear() - 1980) & 0x7f) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  return { dosDate, dosTime };
}

function writeU16(arr, off, v) {
  arr[off] = v & 0xff;
  arr[off + 1] = (v >>> 8) & 0xff;
}

function writeU32(arr, off, v) {
  arr[off] = v & 0xff;
  arr[off + 1] = (v >>> 8) & 0xff;
  arr[off + 2] = (v >>> 16) & 0xff;
  arr[off + 3] = (v >>> 24) & 0xff;
}

/**
 * 1エントリ分のレベル1 -lh0- ヘッダ+データを組み立てる。
 * @param {{ name: string, data: Uint8Array }} entry
 */
function buildEntry(entry) {
  const nameBytes = encodeSjisBytes(entry.name);
  const extHeaderSize = 2 + 1 + nameBytes.length; // size(u16) + type(1) + data
  const terminatorSize = 2; // size=0 の終端
  const baseHeaderLen = 22 /* offset0..21 */ + 2 /* CRC16 */ + 1 /* OS ID */;
  const totalHeaderLen = baseHeaderLen + extHeaderSize + terminatorSize;

  const out = new Uint8Array(totalHeaderLen + entry.data.length);

  const { dosDate, dosTime } = toDosDateTime(new Date());
  const rawTime = ((dosDate << 16) | dosTime) >>> 0;

  out[0] = Math.min(255, totalHeaderLen - 2); // header size(終端判定以外は未使用。255超は本テストでは発生しない)
  out[1] = 0; // header checksum(net/lzh.js側は未検証のため0で十分)
  out.set(new TextEncoder().encode('-lh0-'), 2);
  writeU32(out, 7, entry.data.length); // compressed size
  writeU32(out, 11, entry.data.length); // original size
  writeU32(out, 15, rawTime);
  out[19] = 0x20; // attribute(未使用)
  out[20] = 1; // level
  out[21] = 0; // name length(拡張ヘッダ側にファイル名を持たせるため0)

  const crc = crc16(entry.data);
  writeU16(out, 22, crc);
  out[24] = 0x55; // OS ID ('U' 相当。net/lzh.js側は未使用)

  let pos = 25;
  // 拡張ヘッダのsizeフィールドは「このチャンク自身の消費バイト数」(size(2)+type(1)+data)を
  // 表す(parseExtendedHeadersが pos += size で次チャンクへ進む仕様のため、sizeフィールド分も
  // 含めて書く必要がある。ここを「dataのみの長さ」で書くと以後のオフセットが2バイトずれる)。
  writeU16(out, pos, extHeaderSize);
  out[pos + 2] = 0x01; // type: ファイル名
  out.set(nameBytes, pos + 3);
  pos += 3 + nameBytes.length;
  writeU16(out, pos, 0); // 拡張ヘッダ終端
  pos += 2;

  out.set(entry.data, pos);
  pos += entry.data.length;

  return out.subarray(0, pos);
}

/**
 * 複数エントリからレベル1 -lh0- のLZH書庫バイト列を組み立てる。
 * @param {{ name: string, data: Uint8Array }[]} entries
 * @returns {Uint8Array}
 */
export function buildLzhLevel1(entries) {
  const parts = entries.map(buildEntry);
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
