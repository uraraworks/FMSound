// d88ディスクイメージ(PC-98 2HDフロッピーのセクタダンプ)から
// N88-BASICファイルシステム経由でファイルを読み出し、MUCOM88のMML(トークン化N88-BASIC
// プログラムとして保存されている)をテキストへ復元するモジュール。
//
// 対応範囲: d88コンテナの読み取り(トラックオフセット表・セクタヘッダ)、
// N88-BASICのフラットディレクトリ(トラックindex37固定)とFAT(同トラックのR=14)の解析、
// クラスタチェーンからのファイル本体読み出し、トークン化BASICプログラムからのMML本文抽出。
// いずれも実測(サンプルMML集10枚+システムディスク)で確認済みのフォーマットに基づく。
//
// net/archive.js (ZIP/LZH) への配線・UI統合は本モジュールのスコープ外(別タスク)。

import { readU16, readU32 } from './archive-util.js';
import { decodeMmlBytesAs } from './charset.js';

const SECTOR_SIZE = 256;
const SECTORS_PER_CLUSTER = 8;
const CLUSTER_BYTES = SECTOR_SIZE * SECTORS_PER_CLUSTER; // 2048
const TRACK_OFFSET_TABLE_OFFSET = 0x20;
const TRACK_OFFSET_COUNT = 164;
const DIRECTORY_TRACK_INDEX = 37; // C18/H1 (実測: 全サンプルディスクで共通)
const FAT_SECTOR_R = 14; // R=15,16はR=14の複製(実測。多数決/一致確認に使える)
const DIRECTORY_ENTRY_SIZE = 16;
const BASIC_REM_MARKER = [0x3a, 0x8f, 0xe9]; // ':' + REMトークン(0x8FE9)

/**
 * N88-BASICディレクトリの1エントリ。
 * @typedef {{ name: string, ext: string, fileName: string, attr: number, startCluster: number }} D88DirEntry
 */

/**
 * d88コンテナ先頭の164個のトラックオフセット表を読む。値0は「そのトラックは存在しない」。
 * @param {Uint8Array} bytes
 * @returns {Uint32Array}
 */
export function readTrackOffsets(bytes) {
  const offsets = new Uint32Array(TRACK_OFFSET_COUNT);
  for (let i = 0; i < TRACK_OFFSET_COUNT; i++) {
    offsets[i] = readU32(bytes, TRACK_OFFSET_TABLE_OFFSET + i * 4);
  }
  return offsets;
}

/**
 * 1トラック分のセクタを、セクタヘッダ(16バイト)を読みながら列挙する。
 * セクタヘッダ +4 (u16LE) がそのトラックの総セクタ数。
 * トラックオフセットが0(トラック無し)の場合は空配列を返す。
 * @param {Uint8Array} bytes @param {number} trackOffset
 * @returns {{ r: number, data: Uint8Array }[]}
 */
export function readTrackSectors(bytes, trackOffset) {
  if (!trackOffset) return [];
  if (trackOffset + DIRECTORY_ENTRY_SIZE > bytes.length) {
    throw new Error(`d88: トラックオフセットがファイル範囲外です(offset=0x${trackOffset.toString(16)})`);
  }
  const sectorCount = readU16(bytes, trackOffset + 4);
  const sectors = [];
  let pos = trackOffset;
  for (let i = 0; i < sectorCount; i++) {
    if (pos + DIRECTORY_ENTRY_SIZE > bytes.length) break;
    const r = bytes[pos + 2];
    const dataLength = readU16(bytes, pos + 14);
    const dataStart = pos + DIRECTORY_ENTRY_SIZE;
    sectors.push({ r, data: bytes.subarray(dataStart, dataStart + dataLength) });
    pos = dataStart + dataLength;
  }
  return sectors;
}

/**
 * 1トラック分のセクタデータを格納順に連結する(ディレクトリ/FAT/クラスタ読み出し共通)。
 * @param {Uint8Array} bytes @param {number} trackOffset
 */
function readTrackBytes(bytes, trackOffset) {
  const sectors = readTrackSectors(bytes, trackOffset);
  let total = 0;
  for (const s of sectors) total += s.data.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const s of sectors) {
    out.set(s.data, pos);
    pos += s.data.length;
  }
  return out;
}

/**
 * CP932の6バイト(名前)/3バイト(拡張子)フィールドをトリムしてデコードする。
 * @param {Uint8Array} bytes
 */
function decodeTrimmedCp932(bytes) {
  return decodeMmlBytesAs(bytes, 'shift_jis').replace(/[\x00 ]+$/, '');
}

/**
 * N88-BASICのフラットディレクトリ(トラックindex37固定)を読み、有効なエントリを返す。
 * 各エントリは16バイト: 名前(6)+拡張子(3)+属性(1)+開始クラスタ(1)+未使用(5)。
 * 先頭バイトが0xFFのエントリ(欠番)は読み飛ばし、0x00でディレクトリ終端とみなして打ち切る。
 * @param {Uint8Array} bytes @param {Uint32Array} trackOffsets
 * @returns {D88DirEntry[]}
 */
export function readD88Directory(bytes, trackOffsets) {
  const dirBytes = readTrackBytes(bytes, trackOffsets[DIRECTORY_TRACK_INDEX]);
  const entries = [];
  for (let pos = 0; pos + DIRECTORY_ENTRY_SIZE <= dirBytes.length; pos += DIRECTORY_ENTRY_SIZE) {
    const first = dirBytes[pos];
    if (first === 0x00) break; // ディレクトリ終端
    if (first === 0xff) continue; // 欠番エントリ
    const name = decodeTrimmedCp932(dirBytes.subarray(pos, pos + 6));
    const ext = decodeTrimmedCp932(dirBytes.subarray(pos + 6, pos + 9));
    const attr = dirBytes[pos + 9];
    const startCluster = dirBytes[pos + 10];
    if (!name) continue; // 名前が空(実質無効エントリ)は無視
    entries.push({ name, ext, fileName: ext ? `${name}.${ext}` : name, attr, startCluster });
  }
  return entries;
}

/**
 * FAT(1クラスタ1バイトのクラスタ管理テーブル)を、ディレクトリと同じトラックの
 * セクタR=14から読む。R=15/16はR=14の複製なので、両方存在する場合は一致確認に使い、
 * 一致しなければ(破損の疑いとして)例外を投げる。R=14自体が見つからなければ例外。
 * @param {Uint8Array} bytes @param {Uint32Array} trackOffsets
 * @returns {Uint8Array} 256バイトのFATテーブル
 */
export function readD88Fat(bytes, trackOffsets) {
  const sectors = readTrackSectors(bytes, trackOffsets[DIRECTORY_TRACK_INDEX]);
  const bySector = new Map(sectors.map((s) => [s.r, s.data]));
  const fat = bySector.get(FAT_SECTOR_R);
  if (!fat || fat.length < 256) {
    throw new Error(`d88: FATセクタ(R=${FAT_SECTOR_R})が見つからないか256バイト未満です`);
  }
  for (const dupR of [15, 16]) {
    const dup = bySector.get(dupR);
    if (dup && dup.length >= 256) {
      for (let i = 0; i < 256; i++) {
        if (dup[i] !== fat[i]) {
          throw new Error(`d88: FATの複製(R=${dupR})がR=${FAT_SECTOR_R}と一致しません(offset=${i})`);
        }
      }
    }
  }
  return fat.slice(0, 256);
}

/**
 * FATを辿ってクラスタチェーンを求める。0xC0|n(0xC1〜0xD0)で終端(nは最終クラスタの有効セクタ数)。
 * ループ・範囲外参照・未使用マーカー(0xFF)への到達は破損として例外を投げる。
 * @param {Uint8Array} fat @param {number} startCluster
 * @returns {{ clusters: number[], lastValidSectors: number }}
 */
export function followFatChain(fat, startCluster) {
  const clusters = [];
  const visited = new Set();
  let cur = startCluster;
  for (let step = 0; step < fat.length + 1; step++) {
    if (visited.has(cur)) {
      throw new Error(`d88: FATチェーンにループを検出しました(cluster=${cur})`);
    }
    visited.add(cur);
    if (cur < 0 || cur >= fat.length) {
      throw new Error(`d88: FATチェーンのクラスタ番号が範囲外です(cluster=${cur})`);
    }
    clusters.push(cur);
    const v = fat[cur];
    if (v >= 0xc0 && v <= 0xcf) {
      return { clusters, lastValidSectors: v & 0x0f };
    }
    if (v === 0xff) {
      throw new Error(`d88: FATチェーンが未使用マーカーに到達しました(cluster=${cur})`);
    }
    cur = v;
  }
  throw new Error('d88: FATチェーンが長すぎます(ループ検出の上限を超えました)');
}

/**
 * 1クラスタ分(トラックindex=cluster//2、前半/後半=cluster%2)のバイト列を読む。
 * byteLimitを指定すると先頭からその長さだけ切り出す(最終クラスタの有効セクタ数の反映用)。
 * @param {Uint8Array} bytes @param {Uint32Array} trackOffsets @param {number} cluster @param {number} [byteLimit]
 */
function readClusterBytes(bytes, trackOffsets, cluster, byteLimit = CLUSTER_BYTES) {
  const trackIndex = Math.floor(cluster / 2);
  const half = cluster % 2;
  if (trackIndex >= trackOffsets.length) {
    throw new Error(`d88: クラスタ番号からトラックindexが範囲外になりました(cluster=${cluster})`);
  }
  const trackBytes = readTrackBytes(bytes, trackOffsets[trackIndex]);
  const start = half * CLUSTER_BYTES;
  return trackBytes.subarray(start, Math.min(start + byteLimit, trackBytes.length));
}

/**
 * ディレクトリエントリの開始クラスタからFATを辿り、ファイル本体のバイト列を読み出す。
 * 最終クラスタはFATの有効セクタ数(0xC0|n)ぶんだけを採用し、残りの未使用領域は含めない。
 * @param {Uint8Array} bytes @param {Uint32Array} trackOffsets @param {Uint8Array} fat @param {number} startCluster
 */
export function readD88FileBytesByCluster(bytes, trackOffsets, fat, startCluster) {
  const { clusters, lastValidSectors } = followFatChain(fat, startCluster);
  const parts = clusters.map((cluster, i) => {
    const isLast = i === clusters.length - 1;
    const limit = isLast ? lastValidSectors * SECTOR_SIZE : CLUSTER_BYTES;
    return readClusterBytes(bytes, trackOffsets, cluster, limit);
  });
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/**
 * ディレクトリからファイル名(拡張子込み、大文字小文字無視)でエントリを探し、本体バイト列を読む。
 * @param {Uint8Array} bytes @param {string} fileName
 */
export function readD88FileBytes(bytes, fileName) {
  const trackOffsets = readTrackOffsets(bytes);
  const entries = readD88Directory(bytes, trackOffsets);
  const entry = entries.find((e) => e.fileName.toLowerCase() === fileName.toLowerCase());
  if (!entry) throw new Error(`d88: ファイルが見つかりません: ${fileName}`);
  const fat = readD88Fat(bytes, trackOffsets);
  return readD88FileBytesByCluster(bytes, trackOffsets, fat, entry.startCluster);
}

/**
 * トークン化N88-BASICプログラムのバイト列からMML本文を復元する。
 * 各行は `<次行へのリンクu16LE><行番号u16LE>本文0x00終端` の形式で連続しており、
 * 本文は `:` + REMトークン(0x8F 0xE9) の後ろにMML本文がCP932で入っている。
 * **次行リンクが0になった時点でファイル終端**として打ち切る(それ以降のバイト列は
 * FATの有効セクタ数の丸めによるスラック領域であり、ファイルの実内容ではないため
 * 読んではならない。過去の調査ツールはリンクを見ずにREMマーカーを闇雲に走査しており、
 * スラック領域に残っていた別ファイルの残骸まで行として拾って末尾が壊れる不具合があった)。
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodeBasicMmlText(bytes) {
  const lines = [];
  let pos = 0;
  while (pos + 4 <= bytes.length) {
    const link = readU16(bytes, pos);
    if (link === 0) break; // ファイル終端
    const bodyStart = pos + 4;
    let zero = -1;
    for (let i = bodyStart; i < bytes.length; i++) {
      if (bytes[i] === 0) {
        zero = i;
        break;
      }
    }
    if (zero === -1) break; // 行が閉じる前にバッファ境界に達した(それ以上は読めない)
    const body = bytes.subarray(bodyStart, zero);
    if (
      body.length >= 3 &&
      body[0] === BASIC_REM_MARKER[0] &&
      body[1] === BASIC_REM_MARKER[1] &&
      body[2] === BASIC_REM_MARKER[2]
    ) {
      lines.push(decodeMmlBytesAs(body.subarray(3), 'shift_jis'));
    } else {
      // REMマーカーが無い行は通常発生しない想定だが、情報を失わないようそのままデコードして残す
      lines.push(decodeMmlBytesAs(body, 'shift_jis'));
    }
    pos = zero + 1;
  }
  return lines.join('\n');
}

/**
 * ディレクトリからファイル名でMUCOM88 MMLファイルを探し、本体を読んでMMLテキストへ復元する。
 * @param {Uint8Array} bytes @param {string} fileName
 */
export function readD88MmlText(bytes, fileName) {
  return decodeBasicMmlText(readD88FileBytes(bytes, fileName));
}
