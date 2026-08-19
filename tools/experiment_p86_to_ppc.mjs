#!/usr/bin/env node
// 測定スパイク(実装ではない): PMD86 の `.P86` PCM を YM2608 ADPCM(`.PPC`相当)へ
// 変換して既存の pmd_ppc_load() に食わせたとき、PCMパートが「正しい音程で」
// 鳴るかを実測する。tools/verify_*.mjs の作法(3条件測定・自前タイムアウト・
// 進行の実測確認)に倣うが、27本の検証群には混ぜない(接頭辞をverify_にしない)。
//
// 対象データ: /Users/haruurara/Downloads/4OpAlice/ (MBE86PCM.P86 + kckor_reb.M)
// このスクリプトはリポジトリ外の私物データを参照する(git addしない)。
//
// --- .P86 形式(実測済み。手読みではなくバイト列を実際に読んで確認した) ---
//   header "PCM86 DATA\n\0" (12B) + version(1B, 0x11) + 全体長3B(LE) +
//   256エントリ×(開始オフセット3B(LE), 長さ3B(LE))(offset 16から、6B/entry)。
//   データ本体はentry[1].start(実測 0x610)から。サンプルは符号付き8bit
//   (末尾が0x00に収束することで既に確認済み、本スクリプトでは再確認しない)。
//
// --- .PPC 形式(pmd_ppc_load(), fmdriver_pmd.c:6072-6100) ---
//   header 30B "ADPCM DATA for  PMD ver.4.4-  " + 予約2B + 256エントリ×
//   (start u16 LE, stop u16 LE)(offset32から)。データは1056バイト目から、
//   opna reg 0x108へ順に書き込まれる(内部でnibble単位のRAM書き込みに変換)。
//   アドレス単位: libopna/opnaadpcm.c addr_conv() は control2 の C2_8BIT
//   (0x02)ビットで reg<<3 (非8bit) / reg<<6 (8bit) を切り替える。**PMDドライバは
//   ADPCM初期化時(fmdriver_pmd.c:6095)にも note-on時(:1963,1971,1974)にも
//   常に reg0x101へ 0x02(C2_8BITビット込み)を書く**ため、実際は常に8bitモード
//   (reg<<6)。バイトアドレス = (reg<<6)>>1 = reg*32、つまり1レジスタカウント
//   = 32バイト = 64サンプル(4bit ADPCM)。
//   (最初 reg<<3/reg*4 だと誤読していた。testWriteOpnaReg()でreg0x108直叩きの
//   最小再現を組み、start=0のときに常に無音/内容非依存の一定波形になる不自然な
//   結果から、control2のC2_8BITビットを見落としていたことに気づいて訂正した。
//   opnaadpcm.cのデコード側を自分で読んで確認、pmdminiは未参照)
//
// --- ピッチ規約の手がかり(fmdriver_pmd.c:1364 pmd_note_freq_adpcm 直前のコメント) ---
//   adpcm_tonetable のコメントに
//     round((16000*2*0x10000/(8000000/144))*(2**((i-7)/12)))
//   とある。「16000Hz」が設計上の基準サンプルレートの手がかり。ただし本スクリプトの
//   「期待周波数」はこの内部設計値ではなく、タスク指定どおり「MML音名から計算した
//   平均律周波数」(A4=440Hz、o4c=中央ハ)を使う。これは実際の利用者が
//   「o5cと書いたらC5の音程で鳴ってほしい」と期待する、製品として意味のある基準。
//
// --- ノート/tonenum の取得方法 ---
//   実ファイル(kckor_reb.M)のADPCMトラックのバイト列を手でデコードする代わりに、
//   既存のスナップショットリング(flat_track_status、tools/verify_pmd_multipart.mjs
//   と同じ読み方)から track[ADPCM].key / .tonenum を直接読む。ドライバ本体が
//   コマンド列を正しく解釈した結果を使うので、独自にコマンドテーブルを
//   再実装する誤りのリスクが無い。
//
// --- ADPCM(YM2608 ADPCM-B)エンコーダ ---
//   upstream/98fmplayer/libopna/opnaadpcm.c の adpcm_calc()(デコード側、
//   98fmplayer本体のコード。pmdminiではない)をそのまま読み、そのcodeを
//   逆方向に貪欲探索するエンコーダを自作した(gen_rhythm_rom.pyのADPCM-A
//   エンコーダと同じ方針)。GPLのupstream/pmdmini/src/pmdwin/は一切参照していない。
//
// --- wasm側の追加(検証専用export) ---
//   renderFramesForTest()はabsSumしか返さずピッチ実測に生波形が必要なため、
//   pmdweb/src/PmdCore.cに `pmdweb_test_render_capture()` /
//   `pmdweb_test_get_capture_pointer()` を追加しビルドし直した(製品UIからは
//   呼ばれない検証専用export。既存のtestWriteOpnaReg等と同じ位置づけ)。
//
// 実行: node tools/experiment_p86_to_ppc.mjs
// (事前に emcc で pmdweb をビルド済みであること。150秒で打ち切る)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import { writeSongWithPcm } from '../net/pmd-pcm.js';
import {
  buildPmdChannelMask, FM_CHANNELS, SSG_CHANNELS, RHYTHM_CHANNEL,
} from '../fmdsp/channel-mask.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = '/Users/haruurara/Downloads/4OpAlice';

const DEADLINE_MS = 150000;
const startTime = Date.now();
function checkDeadline(label) {
  const elapsed = Date.now() - startTime;
  if (elapsed > DEADLINE_MS) {
    console.log(`\n=== 打ち切り: ${label} の時点で ${elapsed}ms 経過(上限${DEADLINE_MS}ms) ===`);
    process.exit(1);
  }
}

// ============================================================
// 1. .P86 パーサ
// ============================================================
export function parseP86(buf) {
  const magic = 'PCM86 DATA\n\0';
  for (let i = 0; i < magic.length; i++) {
    if (buf[i] !== magic.charCodeAt(i)) throw new Error(`P86マジック不一致 at ${i}`);
  }
  const version = buf[12];
  const totalLen = buf[13] | (buf[14] << 8) | (buf[15] << 16);
  const entries = [];
  for (let i = 0; i < 256; i++) {
    const off = 16 + i * 6;
    const start = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16);
    const len = buf[off + 3] | (buf[off + 4] << 8) | (buf[off + 5] << 16);
    entries.push({ start, len });
  }
  return { version, totalLen, entries };
}

// ============================================================
// 2. YM2608 ADPCM(ADPCM-B)エンコーダ
//    upstream/98fmplayer/libopna/opnaadpcm.c の adpcm_calc() デコード式を
//    そのまま読んで、逆方向(貪欲選択)にした。
// ============================================================
const ADPCM_STEP_TABLE = [57, 57, 57, 57, 77, 102, 128, 153];

export function encodeAdpcmB(targets16) {
  // targets16: Int16Array相当の目標値列(-32768..32767)
  let acc = 0;
  let adpcmd = 127; // opna_adpcm_reset()の初期値
  const nibbles = new Uint8Array(targets16.length);
  for (let n = 0; n < targets16.length; n++) {
    const target = targets16[n];
    let bestCode = 0;
    let bestErr = Infinity;
    let bestAcc = acc;
    let bestD = adpcmd;
    for (let code = 0; code < 16; code++) {
      let accD = ((code & 7) << 1) | 1;
      if (code & 8) accD = -accD;
      let newAcc = acc + Math.trunc((accD * adpcmd) / 8);
      if (newAcc < -32768) newAcc = -32768;
      if (newAcc > 32767) newAcc = 32767;
      const err = Math.abs(newAcc - target);
      if (err < bestErr) {
        bestErr = err;
        bestCode = code;
        bestAcc = newAcc;
        let newD = Math.trunc((adpcmd * ADPCM_STEP_TABLE[code & 7]) / 64);
        if (newD < 127) newD = 127;
        if (newD > 24576) newD = 24576;
        bestD = newD;
      }
    }
    nibbles[n] = bestCode;
    acc = bestAcc;
    adpcmd = bestD;
  }
  // pack: adpcm_calc()は ramptr偶数(先頭)で data>>=4 (上位nibble)、
  // 奇数で data&=0x0f (下位nibble) を使う。ramptrはstartから0基点で増える。
  const bytes = new Uint8Array(Math.ceil(nibbles.length / 2));
  for (let i = 0; i < nibbles.length; i++) {
    const byteIdx = i >> 1;
    if ((i & 1) === 0) bytes[byteIdx] |= (nibbles[i] & 0xf) << 4;
    else bytes[byteIdx] |= nibbles[i] & 0xf;
  }
  return bytes;
}

// P86の符号付き8bitサンプル列 -> ADPCM-Bターゲット(16bit)へ、リサンプル比resampleRatioで
// 変換する(resampleRatio=1なら1:1、間引き/水増しなしの単純変換)。
// resampleRatio>1: 出力の1サンプルにつき複数の入力サンプルを進める(ダウンサンプル的)。
// resampleRatio<1: 出力を水増しする(線形補間)。
export function p86ToAdpcmTargets(p86Samples, resampleRatio = 1) {
  const outLen = Math.max(1, Math.round(p86Samples.length / resampleRatio));
  const targets = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * resampleRatio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(p86Samples.length - 1, i0 + 1);
    const frac = srcPos - i0;
    const s0 = p86Samples[Math.min(i0, p86Samples.length - 1)];
    const s1 = p86Samples[i1];
    const interp = s0 + (s1 - s0) * frac;
    targets[i] = Math.max(-32768, Math.min(32767, Math.round(interp * 256)));
  }
  return targets;
}

// ============================================================
// 3. 疑似 .PPC バイト列
// ============================================================
// pmd_ppc_load()(fmdriver_pmd.c:6072-6100)は実データを書き込む前に
// ADPCM RAMのアドレス0から0x4c0(1216)バイトぶんゼロを書き込む(reg0x108への
// 空写込みループ)。これはtonenum毎の実データ本体の「前」に必ず存在する共通の
// パディング領域で、ここをstart=0のまま再生するとゼロnibbleの復号結果
// (積分器がゆっくり持ち上がる、ペイロード内容に一切依存しない固定波形)を
// 拾ってしまう。実際、最初の実装(start=0)では複数のresampleRatioで
// 実測周波数が bit-exact に一致するという不自然な結果が出て、これで発覚した。
// レジスタ単位=4バイト(addr_conv(), libopna/opnaadpcm.c)なので
// パディング1216バイト = 304レジスタぶん。startをこの直後に置く。
const PADDING_BYTES = 0x4c0;
const BYTES_PER_REG = 32; // 8bitモード固定(上記コメント参照)。reg*32バイト
const PADDING_REGS = Math.ceil(PADDING_BYTES / BYTES_PER_REG);
export function buildPpcFile({ tonenum, payload }) {
  const PPC_HEADER_SIZE = 30 + 2 + 4 * 256;
  const buf = new Uint8Array(PPC_HEADER_SIZE + payload.length);
  const magic = 'ADPCM DATA for  PMD ver.4.4-  ';
  for (let i = 0; i < magic.length; i++) buf[i] = magic.charCodeAt(i);
  const start = PADDING_REGS;
  // レジスタ単位=32バイト。stopは払い出したpayload全体を覆うよう切り上げ+余裕1。
  const stop = Math.min(0xffff, start + Math.ceil(payload.length / BYTES_PER_REG) + 1);
  const off = 32 + 4 * tonenum;
  buf[off] = start & 0xff;
  buf[off + 1] = (start >> 8) & 0xff;
  buf[off + 2] = stop & 0xff;
  buf[off + 3] = (stop >> 8) & 0xff;
  buf.set(payload, PPC_HEADER_SIZE);
  return buf;
}

// ============================================================
// 4. スナップショット読み取り(tools/verify_pmd_multipart.mjsと同じ作法)
// ============================================================
const FIELD_COUNT = 26;
export const FIELD = { playing: 0, info: 1, ticks: 2, ticks_left: 3, key: 4, actual_key: 5, tonenum: 6 };
const SNAPSHOT_RING_SIZE = 2048;
export const ADPCM_TRACK_INDEX = 12; // FM1..FM3EX3(6)+FM4-6(3)=9, SSG1-3=3 -> ADPCM=12 (fmdriver.h)

// noteByte: 音符バイト = (octave nibble<<4)|noteIndex。MML o値-1がoctave nibble
// (tools/verify_pmd_multipart.mjs冒頭コメントで実測確認済み)。
export function noteByte2(octave, index) { return ((octave & 0xf) << 4) | (index & 0xf); }

// ADPCM単独パートだけの最小.Mを組み立てる。tools/verify_pmd_ppc_load.mjsの
// buildFmAndAdpcmFileWithMemo()と同じ組み立て方式(出典・仕組みのコメントは
// 同ファイル参照)。FMパートを使わない分だけ簡略化。
export function buildAdpcmOnlySong({ adpcmTonenum, octaveNibble, noteIndex, lengthTicks, ppcMemoName }) {
  const HEADER_LEN = 0x1a;
  const EMPTY_TRACK_OFF = HEADER_LEN;
  const ADPCM_TRACK_OFF = EMPTY_TRACK_OFF + 1;
  const adpcmTrack = Uint8Array.from([
    0xff, adpcmTonenum & 0xff, noteByte2(octaveNibble, noteIndex), lengthTicks & 0xff, 0x80,
  ]);
  const memoNameBytes = new TextEncoder().encode(ppcMemoName);
  const MEMO_STR_OFF = ADPCM_TRACK_OFF + adpcmTrack.length;
  const memoStrField = new Uint8Array(memoNameBytes.length + 1);
  memoStrField.set(memoNameBytes, 0);
  const MEMO_TABLE_OFF = MEMO_STR_OFF + memoStrField.length;
  const MEMO_PTR_FIELD_OFF = MEMO_TABLE_OFF + 4;
  const TONE_OFF = MEMO_PTR_FIELD_OFF + 4;

  const rel = new Uint8Array(TONE_OFF + 1);
  function w16(off, val) { rel[off] = val & 0xff; rel[off + 1] = (val >> 8) & 0xff; }
  for (let i = 0; i < 9; i++) w16(i * 2, EMPTY_TRACK_OFF); // FM1-6, SSG1-3(空)
  w16(9 * 2, ADPCM_TRACK_OFF);
  w16(10 * 2, EMPTY_TRACK_OFF); // RHYTHM(空)
  w16(0x16, EMPTY_TRACK_OFF);
  w16(0x18, TONE_OFF);
  rel[EMPTY_TRACK_OFF] = 0x80;
  rel.set(adpcmTrack, ADPCM_TRACK_OFF);
  rel.set(memoStrField, MEMO_STR_OFF);
  w16(MEMO_TABLE_OFF, MEMO_STR_OFF);
  w16(MEMO_TABLE_OFF + 2, 0);
  w16(MEMO_PTR_FIELD_OFF, MEMO_TABLE_OFF);
  rel[MEMO_PTR_FIELD_OFF + 2] = 0x40; // flaglow=0x40(index補正なし)
  rel[MEMO_PTR_FIELD_OFF + 3] = 0x00;

  const file = new Uint8Array(1 + rel.length);
  file[0] = 0;
  file.set(rel, 1);
  return file;
}

export function readTrack(Module, trackIndex) {
  const writeIndex = Module.getSnapshotWriteIndex() >>> 0;
  if (writeIndex === 0xffffffff || writeIndex === 0) return null;
  const entryBytes = Module.getSnapshotEntryByteSize();
  const ringPtr = Module.getSnapshotRingPointer();
  const idx = (writeIndex - 1) % SNAPSHOT_RING_SIZE;
  const base = ringPtr + idx * entryBytes;
  const tracksBase = base + Module.getSnapshotHeaderWordCount() * 4;
  const trackBase = tracksBase + trackIndex * FIELD_COUNT * 4;
  const base32 = trackBase / 4;
  const words = new Int32Array(FIELD_COUNT);
  for (let i = 0; i < FIELD_COUNT; i++) words[i] = Module.HEAP32[base32 + i];
  return words;
}

export function readFrame(Module) {
  const writeIndex = Module.getSnapshotWriteIndex() >>> 0;
  if (writeIndex === 0xffffffff || writeIndex === 0) return -1;
  const entryBytes = Module.getSnapshotEntryByteSize();
  const ringPtr = Module.getSnapshotRingPointer();
  const idx = (writeIndex - 1) % SNAPSHOT_RING_SIZE;
  const base = (ringPtr + idx * entryBytes) / 4;
  return Module.HEAP32[base] >>> 0; // frameはヘッダ先頭(uint32_t frame)
}

// ============================================================
// 5. 音名 -> 期待周波数(平均律、A4=440Hz)
//    音符バイトの上位nibble(オクターブ)は MML の o 値より 1 小さい
//    (tools/verify_pmd_multipart.mjs 冒頭コメントで既に実測確認済み)。
// ============================================================
export function noteByteToExpectedHz(noteByteVal) {
  const nibbleOctave = (noteByteVal >> 4) & 0xf;
  const index = noteByteVal & 0xf;
  if (index === 0xf) return null; // rest
  const mmlOctave = nibbleOctave + 1;
  return 440 * 2 ** (mmlOctave - 4) * 2 ** ((index - 9) / 12);
}

// ============================================================
// 6. 自己相関によるピッチ推定
// ============================================================
// 単純な「全区間で正規化自己相関が最大のlag」を取ると、実波形はlag=0付近の
// 隣接サンプル相関が常に一番高くなりがちで、探索範囲の下限(=maxHzの境界)に
// 張り付く誤検出をする(実際に本スクリプトの初回実装でこれを踏んだ:
// 複数の全く違うペイロードで「bit-exact同一の実測周波数」という不自然な結果に
// なり、原因を追うとlag=minLagへの張り付きだった)。
// 対策: YIN等で使われる「lag=0から最初に相関が下がりきる(谷)まで進み、
// その後の最大ピークを取る」方式にする(周期性がある場合、谷の後に
// 明確な山が来ることを利用する)。
export function estimatePitchHz(samplesMono, sampleRate, { minHz = 60, maxHz = 1500 } = {}) {
  const n = samplesMono.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += samplesMono[i];
  mean /= n;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = samplesMono[i] - mean;

  let energy0 = 0;
  for (let i = 0; i < n; i++) energy0 += x[i] * x[i];
  if (energy0 <= 0) return { hz: null, confidence: 0 };

  const minLag = Math.max(1, Math.floor(sampleRate / maxHz));
  const maxLag = Math.min(n - 1, Math.ceil(sampleRate / minHz));
  const norms = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const count = n - lag;
    for (let i = 0; i < count; i++) sum += x[i] * x[i + lag];
    norms.push(sum / energy0);
  }
  if (norms.length === 0) return { hz: null, confidence: 0 };

  let i = 0;
  while (i + 1 < norms.length && norms[i + 1] < norms[i]) i++; // 谷まで下る
  let bestIdx = i;
  for (let j = i; j < norms.length; j++) {
    if (norms[j] > norms[bestIdx]) bestIdx = j;
  }
  const bestLag = minLag + bestIdx;
  return { hz: sampleRate / bestLag, confidence: norms[bestIdx] };
}

// ============================================================
// メイン
// ============================================================
export async function readCapture(Module, frames) {
  const got = Module.testRenderCapture(frames);
  const ptr = Module.testGetCapturePointer();
  // ビルド設定(pmdweb/CMakeLists.txt EXPORTED_RUNTIME_METHODS)がHEAP16を
  // 公開していない(FS,HEAP32,HEAPU8のみ)ため、公開済みのHEAPU8からリトル
  // エンディアンの符号付き16bitを自前で組み立てる。
  const mono = new Float64Array(got);
  for (let i = 0; i < got * 2; i += 2) {
    const lo = Module.HEAPU8[ptr + i * 2];
    const hi = Module.HEAPU8[ptr + i * 2 + 1];
    let l = lo | (hi << 8);
    if (l >= 0x8000) l -= 0x10000;
    const lo2 = Module.HEAPU8[ptr + i * 2 + 2];
    const hi2 = Module.HEAPU8[ptr + i * 2 + 3];
    let r = lo2 | (hi2 << 8);
    if (r >= 0x8000) r -= 0x10000;
    mono[i / 2] = (l + r) / 2;
  }
  return mono;
}

async function main() {
  console.log('=== 測定スパイク: .P86 -> 疑似.PPC ピッチ実測 ===\n');

  const p86Path = path.join(DATA_DIR, 'MBE86PCM.P86');
  const songPath = path.join(DATA_DIR, 'kckor_reb.M');
  if (!fs.existsSync(p86Path) || !fs.existsSync(songPath)) {
    console.log(`データが見つからない: ${p86Path} / ${songPath}`);
    process.exit(1);
  }
  const p86Buf = fs.readFileSync(p86Path);
  const songBuf = fs.readFileSync(songPath);
  const { entries } = parseP86(p86Buf);
  console.log(`P86: ${p86Buf.length}バイト, 非空entry数=${entries.filter((e) => e.len > 0).length}`);
  checkDeadline('P86パース後');

  // --- 6a. 実ドライバでノート/tonenumを実測(コマンド列の手デコードをしない) ---
  const probeSampleRate = 55467; // pmdweb固定(README参照)
  {
    const Module = await createPmdWeb();
    const dummyPpc = buildPpcFile({ tonenum: 1, payload: new Uint8Array(64) });
    const songDirPath = writeSongWithPcm(Module, {
      songName: 'kckor_reb.M',
      songBytes: songBuf,
      pcmFiles: [{ name: 'MBE86PCM.PPC', data: dummyPpc }],
    });
    const err = Module.playMusic(songDirPath);
    if (err) throw new Error(`playMusic失敗(probe): ${err}`);

    const CHUNK = 128;
    const MAX_CHUNKS = 20000;
    let noteFound = null;
    let tonenumFound = null;
    let framesElapsedAtNote = 0;
    const frame0 = readFrame(Module);
    for (let i = 0; i < MAX_CHUNKS; i++) {
      Module.renderFramesForTest(CHUNK);
      const track = readTrack(Module, ADPCM_TRACK_INDEX);
      if (track) {
        const key = track[FIELD.key] & 0xff;
        if (key !== 0xff && noteFound === null) {
          noteFound = key;
          tonenumFound = track[FIELD.tonenum];
          framesElapsedAtNote = (i + 1) * CHUNK;
          break;
        }
      }
      checkDeadline(`probeループ ${i}`);
    }
    const frame1 = readFrame(Module);
    console.log(`[probe] frame進行: ${frame0} -> ${frame1} (実際に進んだ証拠)`);
    if (noteFound === null) {
      console.log('[probe] ADPCMパートのノートが見つからなかった(曲がADPCMを使っていない可能性)');
      process.exit(1);
    }
    const expectedHz = noteByteToExpectedHz(noteFound);
    console.log(`[probe] 検出note byte=0x${noteFound.toString(16)} tonenum=${tonenumFound} `
      + `期待周波数=${expectedHz ? expectedHz.toFixed(2) : 'n/a'}Hz framesElapsedAtNote=${framesElapsedAtNote}`);

    global.__probeResult = { noteFound, tonenumFound, expectedHz, framesElapsedAtNote };
  }
  checkDeadline('probe完了後');

  const { tonenumFound, expectedHz, framesElapsedAtNote } = global.__probeResult;
  const entry = entries[tonenumFound] && entries[tonenumFound].len > 0
    ? entries[tonenumFound]
    : entries.find((e) => e.len > 0);
  if (!entry) throw new Error('P86に有効なエントリが無い');
  console.log(`使用するP86エントリ: tonenum=${tonenumFound} start=${entry.start} len=${entry.len}`);

  // 符号付き8bitサンプルとして読む
  const p86Samples = new Int8Array(entry.len);
  for (let i = 0; i < entry.len; i++) p86Samples[i] = p86Buf[entry.start + i];

  const ALL_EXCEPT_ADPCM = new Set([...FM_CHANNELS, ...SSG_CHANNELS, RHYTHM_CHANNEL]);
  const mask = buildPmdChannelMask(ALL_EXCEPT_ADPCM);

  async function measureCondition({ ppcBytes, label }) {
    const Module = await createPmdWeb();
    const pcmFiles = ppcBytes ? [{ name: 'MBE86PCM.PPC', data: ppcBytes }] : [];
    const songDirPath = writeSongWithPcm(Module, { songName: 'kckor_reb.M', songBytes: songBuf, pcmFiles });
    const err = Module.playMusic(songDirPath);
    if (err) throw new Error(`playMusic失敗(${label}): ${err}`);
    Module.setChannelMask(mask);
    const frame0 = readFrame(Module);
    // ノート直前まで進める
    let remain = framesElapsedAtNote;
    while (remain > 0) {
      const chunk = Math.min(remain, 8192);
      Module.renderFramesForTest(chunk);
      remain -= chunk;
    }
    const frameMid = readFrame(Module);
    // absSum測定(短い窓)
    const absSumShort = Module.renderFramesForTest(4000);
    // 生波形キャプチャ(ピッチ解析用)。上のabsSumで4000フレーム消費済みなので
    // 続きから追加でキャプチャする。
    const monoCapture = await readCapture(Module, 8000);
    const frame1 = readFrame(Module);
    console.log(`[${label}] frame: ${frame0} -> skip -> ${frameMid} -> +absSum区間 -> +capture区間 -> ${frame1}`);
    return { absSumShort, monoCapture };
  }

  // --- (a) 陰性対照: PPCなし ---
  const negative = await measureCondition({ ppcBytes: null, label: '陰性対照' });
  console.log(`[陰性対照] absSum(4000frame)=${negative.absSumShort}`);
  checkDeadline('陰性対照後');

  // --- (b)+(c) 本命: 1:1変換(resampleRatio=1) ---
  async function runWithRatio(resampleRatio, label) {
    const targets = p86ToAdpcmTargets(p86Samples, resampleRatio);
    const payload = encodeAdpcmB(targets);
    const ppc = buildPpcFile({ tonenum: tonenumFound, payload });
    const result = await measureCondition({ ppcBytes: ppc, label });
    const pitch = estimatePitchHz(result.monoCapture, probeSampleRate);
    const ratio = pitch.hz && expectedHz ? pitch.hz / expectedHz : null;
    console.log(`[${label}] absSum(4000frame)=${result.absSumShort} 実測周波数=${pitch.hz ? pitch.hz.toFixed(2) : 'n/a'}Hz `
      + `(相関=${pitch.confidence.toFixed(3)}) 期待周波数=${expectedHz.toFixed(2)}Hz 比率=${ratio ? ratio.toFixed(4) : 'n/a'}`);
    return { ...result, pitch, ratio };
  }

  const main1to1 = await runWithRatio(1, '本命(1:1変換)');
  checkDeadline('本命測定後');

  console.log('\n=== 判定 ===');
  const negSilent = negative.absSumShort <= Math.max(main1to1.absSumShort * 0.01, 1);
  console.log(`(a) 陰性対照が無音相当: ${negSilent} (absSum=${negative.absSumShort} vs 本命=${main1to1.absSumShort})`);
  console.log(`(b) 本命で音が出た: ${main1to1.absSumShort > 0} (absSum=${main1to1.absSumShort})`);
  console.log(`(c) 周波数比(実測/期待): ${main1to1.ratio !== null ? main1to1.ratio.toFixed(4) : 'n/a'} (相関=${main1to1.pitch.confidence.toFixed(3)})`);

  if (main1to1.pitch.confidence < 0.5) {
    console.log(`\n[注意] tonenum=${tonenumFound}(kckor_reb.M実測)の相関=${main1to1.pitch.confidence.toFixed(3)}は低く、`
      + '自己相関によるピッチ推定自体が信頼できない可能性がある(生P86データ単体でも同様に低相関'
      + '=打楽器/SE的な非周期音の可能性)。係数探索はスキップし、代わりに周期性が明瞭な別エントリを'
      + '「既知の音名」で単独に鳴らす追加測定で変換パイプラインのピッチ保存性を切り分ける。');
  } else if (main1to1.ratio !== null && Math.abs(main1to1.ratio - 1) > 0.03) {
    console.log('\n--- 比率が1.00から外れているため、リサンプル比を変えて再測定する ---');
    // ratio(実測/期待)>1 なら実際より高く鳴っている=データを間引き過ぎ=もっと多くの
    // 入力サンプルを1出力ぶんに詰め込む(resampleRatioを上げる)方向で近づく、の逆も同様。
    const candidateRatios = [main1to1.ratio, 1 / main1to1.ratio, 2, 0.5, 1.5, 1 / 1.5]
      .filter((r) => r > 0.1 && r < 10);
    let bestCandidate = null;
    for (const rr of candidateRatios) {
      checkDeadline(`係数探索 ${rr}`);
      const res = await runWithRatio(rr, `係数候補 resampleRatio=${rr.toFixed(4)}`);
      if (res.ratio !== null) {
        const dist = Math.abs(res.ratio - 1);
        if (!bestCandidate || dist < bestCandidate.dist) {
          bestCandidate = { resampleRatio: rr, ratio: res.ratio, dist };
        }
      }
    }
    if (bestCandidate) {
      console.log(`\n最も1.00に近づいた係数: resampleRatio=${bestCandidate.resampleRatio.toFixed(4)} `
        + `-> 比率=${bestCandidate.ratio.toFixed(4)}`);
    }
  } else {
    console.log('\n比率がほぼ1.00: 係数調整は不要と判断');
  }

  // ==========================================================
  // 追加測定: 変換パイプライン自体のピッチ保存性を、周期性が明瞭な
  // P86エントリを「既知の音名」で単独に鳴らして切り分ける。
  // (事前に生P86データへ自己相関をかけて谷→山の形が明瞭なエントリを選定済み:
  //  entry21は相関0.89、entry16(kckor_reb.M実測)は相関0.36と大きく劣る)
  // ==========================================================
  console.log('\n=== 追加測定: 既知音名での単独再生(entry21, o5c) ===');
  checkDeadline('追加測定開始前');

  // noteByte2 / buildAdpcmOnlySong はモジュール先頭(FIELD/ADPCM_TRACK_INDEX付近)で
  // export済みのものを使う(tools/experiment_p86_pitch_check.mjsと共有するため)。

  const CONTROLLED_TONENUM = 5; // kckor_reb.M側のtonenum(=16)と衝突しないダミー番号
  const controlledEntry = entries[21];
  const controlledSamples = new Int8Array(controlledEntry.len);
  for (let i = 0; i < controlledEntry.len; i++) controlledSamples[i] = p86Buf[controlledEntry.start + i];

  const controlledSongBytes = buildAdpcmOnlySong({
    adpcmTonenum: CONTROLLED_TONENUM,
    octaveNibble: 4, // MML o5相当(音符バイトのoctave nibbleはo値-1)
    noteIndex: 0, // c (C5, 期待523.25Hz)
    lengthTicks: 200,
    ppcMemoName: 'CTRL.PPC',
  });
  const controlledExpectedHz = noteByteToExpectedHz(noteByte2(4, 0));

  async function measureControlled({ ppcBytes, label }) {
    const Module = await createPmdWeb();
    const pcmFiles = ppcBytes ? [{ name: 'CTRL.PPC', data: ppcBytes }] : [];
    const songDirPath = writeSongWithPcm(Module, { songName: 'ctrl.m', songBytes: controlledSongBytes, pcmFiles });
    const err = Module.playMusic(songDirPath);
    if (err) throw new Error(`playMusic失敗(${label}): ${err}`);
    Module.setChannelMask(mask);
    // ノート直前まで進める(この曲は即座にノートが来る想定なので短いchunkで探す)
    let framesElapsed = 0;
    let noteSeen = false;
    for (let i = 0; i < 200 && !noteSeen; i++) {
      Module.renderFramesForTest(64);
      framesElapsed += 64;
      const track = readTrack(Module, ADPCM_TRACK_INDEX);
      if (track && (track[FIELD.key] & 0xff) !== 0xff) noteSeen = true;
    }
    const absSumShort = Module.renderFramesForTest(4000);
    const monoCapture = await readCapture(Module, 8000);
    return { absSumShort, monoCapture, framesElapsed };
  }

  const ctrlNegative = await measureControlled({ ppcBytes: null, label: '追加測定 陰性対照' });
  console.log(`[追加測定 陰性対照] absSum(4000frame)=${ctrlNegative.absSumShort}`);
  checkDeadline('追加測定 陰性対照後');

  const ctrlTargets = p86ToAdpcmTargets(controlledSamples, 1);
  const ctrlPayload = encodeAdpcmB(ctrlTargets);
  const ctrlPpc = buildPpcFile({ tonenum: CONTROLLED_TONENUM, payload: ctrlPayload });
  const ctrlMain = await measureControlled({ ppcBytes: ctrlPpc, label: '追加測定 本命' });
  const ctrlPitch = estimatePitchHz(ctrlMain.monoCapture, probeSampleRate);
  const ctrlRatio = ctrlPitch.hz ? ctrlPitch.hz / controlledExpectedHz : null;
  console.log(`[追加測定 本命(entry21,1:1変換,o5c指定)] absSum=${ctrlMain.absSumShort} `
    + `実測周波数=${ctrlPitch.hz ? ctrlPitch.hz.toFixed(2) : 'n/a'}Hz(相関=${ctrlPitch.confidence.toFixed(3)}) `
    + `期待周波数=${controlledExpectedHz.toFixed(2)}Hz 比率=${ctrlRatio ? ctrlRatio.toFixed(4) : 'n/a'}`);
  checkDeadline('追加測定 本命後');

  console.log('\n=== 追加測定 判定 ===');
  console.log(`(a) 陰性対照が無音相当: ${ctrlNegative.absSumShort <= Math.max(ctrlMain.absSumShort * 0.01, 1)} `
    + `(absSum=${ctrlNegative.absSumShort} vs 本命=${ctrlMain.absSumShort})`);
  console.log(`(b) 本命で音が出た: ${ctrlMain.absSumShort > 0}`);
  console.log(`(c) 周波数比(実測/期待): ${ctrlRatio !== null ? ctrlRatio.toFixed(4) : 'n/a'} (相関=${ctrlPitch.confidence.toFixed(3)})`);

  console.log('\n=== 完了 ===');
}

// tools/experiment_p86_pitch_check.mjs がこのファイルの関数群をimportするため、
// importされただけではmain()を実行しない(直接 `node tools/experiment_p86_to_ppc.mjs`
// された場合のみ実行する)。
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('FATAL:', e);
    process.exit(1);
  });
}
