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

import { netError, readU16, readU32 } from './archive-util.js';
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
    throw netError('d88.trackOffsetOutOfRange', { offset: `0x${trackOffset.toString(16)}` });
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
  return decodeMmlBytesAs(bytes, 'shift_jis').replace(/^[\x00 ]+|[\x00 ]+$/g, '');
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
    const nameRawBytes = dirBytes.subarray(pos, pos + 6);
    const name = decodeTrimmedCp932(nameRawBytes);
    const ext = decodeTrimmedCp932(dirBytes.subarray(pos + 6, pos + 9));
    const attr = dirBytes[pos + 9];
    const startCluster = dirBytes[pos + 10];
    if (!name) continue; // 名前が空(実質無効エントリ)は無視
    // 名前(6バイト)+拡張子(3バイト)は固定長フィールドで、バイト列に区切り文字(.)は
    // 存在しない。名前フィールドが空白無しで6バイト使い切られている場合は、拡張子
    // フィールドは「名前の続き」(6文字を超えた分の溢れ)なのでドット無しで連結する。
    // 名前フィールドに空白の余りがある場合のみ、拡張子は本来の拡張子でありドットで連結する。
    // (実測: VOICE+" 1 " -> "VOICE.1"、sq1_10+"3  " -> "sq1_103"。tools/verify_d88.mjs参照)
    const nameFieldFull = !nameRawBytes.includes(0x20) && !nameRawBytes.includes(0x00);
    const fileName = !ext ? name : nameFieldFull ? `${name}${ext}` : `${name}.${ext}`;
    entries.push({ name, ext, fileName, attr, startCluster });
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
    throw netError('d88.fatSectorNotFound', { r: FAT_SECTOR_R });
  }
  for (const dupR of [15, 16]) {
    const dup = bySector.get(dupR);
    if (dup && dup.length >= 256) {
      for (let i = 0; i < 256; i++) {
        if (dup[i] !== fat[i]) {
          throw netError('d88.fatDuplicateMismatch', { dupR, r: FAT_SECTOR_R, offset: i });
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
      throw netError('d88.fatChainLoop', { cluster: cur });
    }
    visited.add(cur);
    if (cur < 0 || cur >= fat.length) {
      throw netError('d88.fatClusterOutOfRange', { cluster: cur });
    }
    clusters.push(cur);
    const v = fat[cur];
    if (v >= 0xc0 && v <= 0xcf) {
      return { clusters, lastValidSectors: v & 0x0f };
    }
    if (v === 0xff) {
      throw netError('d88.fatChainUnusedMarker', { cluster: cur });
    }
    cur = v;
  }
  throw netError('d88.fatChainTooLong');
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
    throw netError('d88.clusterTrackIndexOutOfRange', { cluster });
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
  if (!entry) throw netError('d88.fileNotFound', { fileName });
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

// --- net/archive.js への配線: 書庫展開結果(ArchiveEntry[])としてのd88扱い ------------

const PART_LINE_RE = /^[A-K]\s/;

/**
 * decodeBasicMmlText()の厳格版。VOICE.n等のバイナリ音色データは「トークン化BASICの
 * プログラムではない」ため、1行でもREMマーカー(`:` + 0x8F 0xE9)で始まっていない
 * 行が現れた時点でnullを返して打ち切る(decodeBasicMmlText()はここでも構わず
 * デコードを続けて情報を残す方針だが、それは既知のMMLファイルを読む用途向けであり、
 * 「これはMMLかどうか」を自動判定する用途にはゆるすぎる。実際、VOICE.n等の
 * バイナリを素通しでデコードすると、たまたまバイト列がリンク値や0終端の形に
 * 一致して「行」が生成されてしまい、その中にA〜Kどれかで始まる行が偶然含まれる
 * ケースが実データで確認された)。
 * @param {Uint8Array} bytes
 * @returns {string | null}
 */
export function tryDecodeTokenizedBasicMmlText(bytes) {
  const lines = [];
  let pos = 0;
  while (pos + 4 <= bytes.length) {
    const link = readU16(bytes, pos);
    if (link === 0) break;
    const bodyStart = pos + 4;
    let zero = -1;
    for (let i = bodyStart; i < bytes.length; i++) {
      if (bytes[i] === 0) {
        zero = i;
        break;
      }
    }
    if (zero === -1) break;
    const body = bytes.subarray(bodyStart, zero);
    if (
      body.length < 3 ||
      body[0] !== BASIC_REM_MARKER[0] ||
      body[1] !== BASIC_REM_MARKER[1] ||
      body[2] !== BASIC_REM_MARKER[2]
    ) {
      return null; // REM行でない = トークン化されたMUCOM88 MMLプログラムではない
    }
    lines.push(decodeMmlBytesAs(body.subarray(3), 'shift_jis'));
    pos = zero + 1;
  }
  if (lines.length === 0) return null;
  return lines.join('\n');
}

/**
 * 復元したテキストがMUCOM88のMMLらしいかどうかを、中身を見て判定する。
 * ファイル名の決め打ちはしない(システムディスクとサンプルディスクで収録ファイルの構成が
 * 全く異なり、ファイル名リストはディスクが変われば必ず破綻するため)。
 * 判定基準: 先頭行(タイトルREM等)を除いた行の中に、行頭パート文字A〜Kで始まる行が
 * 1行以上現れること。
 * @param {string | null} text
 */
export function looksLikeMucomMmlText(text) {
  if (!text) return false;
  const lines = text.split('\n').slice(1);
  return lines.some((line) => PART_LINE_RE.test(line));
}

/**
 * d88ディスクの全ディレクトリエントリを、net/archive.js の ArchiveEntry[] 形式で返す。
 * MMLと判定できたファイルは、復元したテキストをUTF-8バイト列にした上で `.muc` 拡張子を
 * 付けて返す(net/song-select.js の拡張子ベース判定にそのまま乗せるため)。
 * MMLと判定できなかったファイル(VOICE.n、ドライバ本体等)は、捨てずに元のファイル名・
 * 生バイト列のまま返す(曲一覧には並ばないが、後続タスクで音色バンクとして参照できる
 * 状態を保つ)。
 * @param {Uint8Array} bytes
 * @returns {import('./archive-util.js').ArchiveEntry[]}
 */
export function extractD88(bytes) {
  const trackOffsets = readTrackOffsets(bytes);
  const dirEntries = readD88Directory(bytes, trackOffsets);
  const fat = readD88Fat(bytes, trackOffsets);
  const out = [];
  for (const e of dirEntries) {
    const raw = readD88FileBytesByCluster(bytes, trackOffsets, fat, e.startCluster);
    const decoded = tryDecodeTokenizedBasicMmlText(raw);
    if (looksLikeMucomMmlText(decoded)) {
      out.push({ name: `${e.fileName}.muc`, data: new TextEncoder().encode(decoded) });
    } else {
      out.push({ name: e.fileName, data: raw });
    }
  }
  return out;
}

const D88_TRACK_OFFSET_TABLE_START = TRACK_OFFSET_TABLE_OFFSET + TRACK_OFFSET_COUNT * 4; // 0x20 + 164*4
const D88_MAX_SECTORS_PER_TRACK = 26; // 2HD(8セクタ/2048B/クラスタ換算)を大きく超える値は実在しない
const D88_MAX_SECTOR_DATA_LENGTH = 1024; // 実測(256B/セクタ)の余裕を見た上限

/**
 * d88コンテナかどうかを、ファイル先頭のマジックバイトではなく構造から判定する。
 * d88はヘッダ先頭16バイトがディスク名(任意文字列、マジックとして弱い)なので、
 * 代わりに (a) 0x1C..0x1Fのディスクサイズ(u32LE)が実際のファイル長と一致すること、
 * (b) 0x20以降のトラックオフセット表(164個のu32LE)が、0以外の値については
 *     ファイル範囲内かつセクタヘッダとして妥当な値(セクタ数・データ長が現実的範囲)を
 *     指していること、を確認する。ゆるい判定はZIP/LZHの誤検出につながるため、
 *     オフセット表に有効なトラックが1つも無い場合や、1つでも範囲外/非現実的な値が
 *     あれば非d88と判定する。
 * @param {Uint8Array} bytes
 */
export function looksLikeD88(bytes) {
  if (bytes.length < D88_TRACK_OFFSET_TABLE_START) return false;
  const declaredSize = readU32(bytes, 0x1c);
  if (declaredSize !== bytes.length) return false;

  let validTrackCount = 0;
  for (let i = 0; i < TRACK_OFFSET_COUNT; i++) {
    const off = readU32(bytes, TRACK_OFFSET_TABLE_OFFSET + i * 4);
    if (off === 0) continue; // トラック無し
    if (off < D88_TRACK_OFFSET_TABLE_START || off + DIRECTORY_ENTRY_SIZE > bytes.length) return false;
    const sectorCount = readU16(bytes, off + 4);
    if (sectorCount === 0 || sectorCount > D88_MAX_SECTORS_PER_TRACK) return false;
    const dataLength = readU16(bytes, off + 14);
    if (dataLength === 0 || dataLength > D88_MAX_SECTOR_DATA_LENGTH) return false;
    validTrackCount++;
  }
  return validTrackCount > 0;
}
