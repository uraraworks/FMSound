#!/usr/bin/env node
// PMD86 `.P86` -> 疑似`.PPC` 変換(net/pmd-p86.js)の実測検証。
// これは第1段階(変換器そのもの)の検証。結線(html/pmd-app.js等)はまだ無いため
// UI経由のテストは行わない。
//
// 検証項目:
//   [実データ]   /Users/haruurara/Downloads/4OpAlice/MBE86PCM.P86 がパースでき、
//               実使用サンプル数(length>0のエントリ数)が30であること
//   [PPCロード]  実データから生成した.PPCが、実物のpmd_ppc_load()
//               (Module.testLoadPpcFile()経由、tools/verify_pmd_channel_mute.mjsと
//               同じ検証専用API)を通ること
//   [不変条件]   生成した.PPCの未使用エントリ(256-30=226個)はstart=stop=0のまま
//               (=使ったエントリだけを書き、他を汚さないこと)
//   [陽性対照]   net/pmd-p86.jsのソースを1箇所(符号付き8bit変換)壊した版を
//               動的に読み込み、ラウンドトリップ忠実度テストが実際に落ちることを確認する
//   [容量ガード] 故障注入: ADPCM RAM(256KB)に収まらない巨大な.P86を食わせ、
//               p86ToPpc()がok:false, error:'capacity'を返すこと(黙って切り詰めない)
//
// 実行: node tools/verify_pmd_p86.mjs (180秒で打ち切り)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import { buildToneEntry, noteByte } from '../compiler/gen_pmd_min.mjs';
import { parseP86, p86ToPpc, encodeAdpcmB, __internal } from '../net/pmd-p86.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

const DEADLINE_MS = 180000;
const startTime = Date.now();
function checkDeadline(label) {
  const elapsed = Date.now() - startTime;
  if (elapsed > DEADLINE_MS) {
    console.log(`\n=== 打ち切り: ${label} の時点で ${elapsed}ms 経過(上限${DEADLINE_MS}ms) ===`);
    console.log(`実行済み: ${passCount} PASS / ${failCount} FAIL`);
    process.exit(1);
  }
}

// --- 最小の.M(FM1トラックのみ)。playMusic()をactive状態にしてtestLoadPpcFileを
//     使えるようにするためだけの器で、ADPCM自体はこのファイルでは鳴らさない。
function buildMinimalFmFile() {
  const fmTone = buildToneEntry({ tonenum: 1, ar: [31, 31, 31, 31], tl: [0, 20, 20, 0], alg: 7 });
  const HEADER_LEN = 0x1a;
  const EMPTY_TRACK_OFF = HEADER_LEN;
  const FM1_TRACK_OFF = EMPTY_TRACK_OFF + 1;
  const fm1Track = Uint8Array.from([0xff, 1, noteByte(4, 0), 96, 0x80]);
  const TONE_OFF = FM1_TRACK_OFF + fm1Track.length;
  const rel = new Uint8Array(TONE_OFF + fmTone.length);
  function w16(off, val) { rel[off] = val & 0xff; rel[off + 1] = (val >> 8) & 0xff; }
  w16(0x00, FM1_TRACK_OFF);
  for (let i = 1; i < 11; i++) w16(i * 2, EMPTY_TRACK_OFF);
  w16(0x16, EMPTY_TRACK_OFF);
  w16(0x18, TONE_OFF);
  rel[EMPTY_TRACK_OFF] = 0x80;
  rel.set(fm1Track, FM1_TRACK_OFF);
  rel.set(fmTone, TONE_OFF);
  const file = new Uint8Array(1 + rel.length);
  file[0] = 0;
  file.set(rel, 1);
  return file;
}

// --- 合成.P86を1本組み立てる(実データに依存しない単体テスト用) ---
function buildFakeP86({ tonenum, samples }) {
  const DATA_OFF = 0x610; // 実測値(MBE86PCM.P86の実測と同じ配置)に合わせる
  const totalLen = DATA_OFF + samples.length;
  const buf = new Uint8Array(totalLen);
  const magic = 'PCM86 DATA\n\0';
  for (let i = 0; i < magic.length; i++) buf[i] = magic.charCodeAt(i);
  buf[12] = 0x11; // version
  buf[13] = totalLen & 0xff;
  buf[14] = (totalLen >> 8) & 0xff;
  buf[15] = (totalLen >> 16) & 0xff;
  const off = 16 + tonenum * 6;
  buf[off] = DATA_OFF & 0xff;
  buf[off + 1] = (DATA_OFF >> 8) & 0xff;
  buf[off + 2] = (DATA_OFF >> 16) & 0xff;
  buf[off + 3] = samples.length & 0xff;
  buf[off + 4] = (samples.length >> 8) & 0xff;
  buf[off + 5] = (samples.length >> 16) & 0xff;
  buf.set(samples, DATA_OFF);
  return buf;
}

// サイン波を符号付き8bit(-100..100)に量子化した合成サンプル列。
// 正負両方をまたぐ波形にすることで、符号変換を間違えるバグ(陽性対照)が
// 相関を大きく崩すようにする。
function buildSineSamples(count) {
  const samples = new Int8Array(count);
  for (let i = 0; i < count; i++) {
    const v = Math.round(100 * Math.sin((2 * Math.PI * i) / 37));
    samples[i] = v;
  }
  return samples;
}

// 独立実装のADPCM-Bデコーダ。upstream/98fmplayer/libopna/opnaadpcm.c
// adpcm_calc()の式をこのテストファイル内で改めて書き起こしたもの
// (net/pmd-p86.jsのencodeAdpcmB()内部のシミュレーションをコピーしたのではなく、
// 同じ仕様書(fmdriver_pmd.c由来のコメント)から独立に再実装している。
// エンコーダが壊れていればここでの再構成精度が落ちる、という復号側の検算)。
const ADPCM_STEP_TABLE = [57, 57, 57, 57, 77, 102, 128, 153];
function decodeAdpcmB(bytes, sampleCount) {
  let acc = 0;
  let d = 127;
  const out = new Int16Array(sampleCount);
  for (let n = 0; n < sampleCount; n++) {
    const byteIdx = n >> 1;
    const nibble = (n & 1) === 0 ? (bytes[byteIdx] >> 4) & 0xf : bytes[byteIdx] & 0xf;
    let accD = ((nibble & 7) << 1) | 1;
    if (nibble & 8) accD = -accD;
    acc += Math.trunc((accD * d) / 8);
    if (acc < -32768) acc = -32768;
    if (acc > 32767) acc = 32767;
    out[n] = acc;
    let newD = Math.trunc((d * ADPCM_STEP_TABLE[nibble & 7]) / 64);
    if (newD < 127) newD = 127;
    if (newD > 24576) newD = 24576;
    d = newD;
  }
  return out;
}

function pearsonCorrelation(a, b) {
  const n = a.length;
  let meanA = 0; let meanB = 0;
  for (let i = 0; i < n; i++) { meanA += a[i]; meanB += b[i]; }
  meanA /= n; meanB /= n;
  let num = 0; let denA = 0; let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA; const db = b[i] - meanB;
    num += da * db; denA += da * da; denB += db * db;
  }
  if (denA === 0 || denB === 0) return 0;
  return num / Math.sqrt(denA * denB);
}

// 与えられたp86ToPpc実装(モジュール)に対して、正弦波ラウンドトリップの相関係数を
// 実測する。合成.P86 -> p86ToPpc() -> テーブルからpayload位置を割り出し ->
// 独立デコーダで復号 -> 元の目標値(サンプル*256)との相関。
function measureRoundTripCorrelation(p86Module) {
  const TONENUM = 5;
  const samples = buildSineSamples(200);
  const fakeP86 = buildFakeP86({ tonenum: TONENUM, samples });
  const result = p86Module.p86ToPpc(fakeP86);
  if (!result.ok) throw new Error(`p86ToPpc failed unexpectedly: ${result.message}`);
  const PPC_TABLE_OFFSET = 32;
  const PPC_HEADER_SIZE = 30 + 2 + 4 * 256;
  const BYTES_PER_REG = 32;
  const tOff = PPC_TABLE_OFFSET + 4 * TONENUM;
  const startReg = result.bytes[tOff] | (result.bytes[tOff + 1] << 8);
  const stopReg = result.bytes[tOff + 2] | (result.bytes[tOff + 3] << 8);
  if (startReg === 0 && stopReg === 0) throw new Error('テーブルにエントリが書かれていない');
  const payloadByteLen = Math.ceil(samples.length / 2);
  const streamStart = PPC_HEADER_SIZE; // 唯一の使用エントリなのでpayloadは先頭に来る
  const payload = result.bytes.slice(streamStart, streamStart + payloadByteLen);
  const decoded = decodeAdpcmB(payload, samples.length);
  const expected = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] * 256;
    expected[i] = Math.max(-32768, Math.min(32767, v));
  }
  return pearsonCorrelation(decoded, expected);
}

async function main() {
  console.log('=== PMD86 .P86 -> 疑似.PPC 変換 実測検証 ===\n');

  // --- [実データ] ---
  const p86Path = '/Users/haruurara/Downloads/4OpAlice/MBE86PCM.P86';
  if (!fs.existsSync(p86Path)) {
    console.log(`実データが見つからない: ${p86Path}`);
    process.exit(1);
  }
  const p86Buf = new Uint8Array(fs.readFileSync(p86Path));
  const parsed = parseP86(p86Buf);
  check('[実データ] parseP86が非nullを返す', parsed !== null);
  const usedCount = parsed ? parsed.entries.filter((e) => e.length > 0).length : -1;
  check('[実データ] 実使用サンプル数(length>0のエントリ数)が30', usedCount === 30, `実測=${usedCount}`);
  checkDeadline('実データパース後');

  const conversion = p86ToPpc(p86Buf);
  check('[実データ] p86ToPpc()がok:trueを返す(実データがADPCM RAMに収まる)', conversion.ok, conversion.ok ? `requiredBytes=${conversion.requiredBytes}` : conversion.message);
  checkDeadline('実データ変換後');

  // --- [不変条件] 未使用エントリはstart=stop=0のまま ---
  if (conversion.ok) {
    let untouchedOk = true;
    let touchedCount = 0;
    for (let i = 0; i < 256; i++) {
      const off = __internal.PPC_TABLE_OFFSET + 4 * i;
      const start = conversion.bytes[off] | (conversion.bytes[off + 1] << 8);
      const stop = conversion.bytes[off + 2] | (conversion.bytes[off + 3] << 8);
      const usedHere = parsed.entries[i] && parsed.entries[i].length > 0;
      if (usedHere) { touchedCount++; continue; }
      if (start !== 0 || stop !== 0) untouchedOk = false;
    }
    check('[不変条件] 未使用エントリ(226個)はテーブルがstart=stop=0のまま', untouchedOk, `使用エントリ数=${touchedCount}`);
  }

  // --- [PPCロード] 実物のpmd_ppc_load()を通す ---
  if (conversion.ok) {
    const Module = await createPmdWeb();
    const minimalFm = buildMinimalFmFile();
    Module.FS.writeFile('/probe.M', minimalFm);
    const playErr = Module.playMusic('/probe.M');
    if (playErr) throw new Error(`playMusic失敗: ${playErr}`);
    Module.FS.writeFile('/gen.ppc', conversion.bytes);
    const loaded = Module.testLoadPpcFile('/gen.ppc');
    // Emscripten側のbool戻り値はJSでは true/false(1/0のどちらかは実装依存)として
    // 渡ってくるため、真偽値として評価する(verify_pmd_channel_mute.mjsのifも同様)。
    check('[PPCロード] 生成した.PPCがpmd_ppc_load()(実物)を通る', !!loaded, `戻り値=${loaded}`);
  }
  checkDeadline('PPCロード検証後');

  // --- [陽性対照] net/pmd-p86.jsの符号変換を1箇所壊した版で、
  //     ラウンドトリップ相関係数テストが実際に落ちることを確認する ---
  const goodCorrelation = measureRoundTripCorrelation({ p86ToPpc });
  check('[陽性対照/正常系] 正しい実装ではサイン波ラウンドトリップの相関係数が高い(>0.9)',
    goodCorrelation > 0.9, `相関=${goodCorrelation.toFixed(4)}`);

  const srcPath = path.join(__dirname, '../net/pmd-p86.js');
  const srcText = fs.readFileSync(srcPath, 'utf8');
  const needle = 'const signed8 = raw > 127 ? raw - 256 : raw;';
  if (!srcText.includes(needle)) throw new Error('陽性対照: 壊す対象の行が見つからない(net/pmd-p86.jsが変更された?)');
  const brokenText = srcText.replace(needle, 'const signed8 = raw; // BROKEN(陽性対照用: 符号変換を無効化)');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmd-p86-broken-'));
  const brokenPath = path.join(tmpDir, 'pmd-p86-broken.js');
  fs.writeFileSync(brokenPath, brokenText);
  const brokenModule = await import(`file://${brokenPath}`);
  const brokenCorrelation = measureRoundTripCorrelation(brokenModule);
  check('[陽性対照/破壊系] 符号変換を壊すとラウンドトリップの相関係数が明確に落ちる',
    brokenCorrelation < goodCorrelation - 0.2,
    `正常=${goodCorrelation.toFixed(4)} 破壊後=${brokenCorrelation.toFixed(4)}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  checkDeadline('陽性対照後');

  // --- [容量ガード] 故障注入: ADPCM RAMに収まらない巨大な.P86 ---
  // 256エントリ全部を最大長(0xffffff)近くにすると当然メモリを食い過ぎるので、
  // 「1エントリだけでADPCM RAM(256KB)を超える」構成で確実に発火させる。
  {
    const hugeSamples = new Int8Array(600000); // 600000/2=300000バイト > 256KB
    for (let i = 0; i < hugeSamples.length; i++) hugeSamples[i] = (i % 200) - 100;
    // buildFakeP86はtotalLenをDATA_OFF+samples.lengthにするだけで問題ない
    const hugeP86 = buildFakeP86({ tonenum: 10, samples: hugeSamples });
    const hugeResult = p86ToPpc(hugeP86);
    check('[容量ガード] 巨大な.P86ではok:falseかつerror:capacityを返す(黙って切り詰めない)',
      hugeResult.ok === false && hugeResult.error === 'capacity',
      hugeResult.ok ? '(ok:trueが返ってしまった)' : `error=${hugeResult.error} requiredBytes=${hugeResult.requiredBytes} maxBytes=${hugeResult.maxBytes}`);
    if (hugeResult.ok === false && hugeResult.error === 'capacity') {
      check('[容量ガード] requiredBytesが実際にmaxBytesを超えている(数値の妥当性)',
        hugeResult.requiredBytes > hugeResult.maxBytes,
        `requiredBytes=${hugeResult.requiredBytes} maxBytes=${hugeResult.maxBytes}`);
    }
  }
  checkDeadline('容量ガード検証後');

  // --- 追加の不変条件: 空のP86(全エントリ長0)は常にok:trueで、
  //     ヘッダのみ(payload無し)を返す ---
  {
    const emptyP86 = buildFakeP86({ tonenum: 0, samples: new Int8Array(0) });
    // tonenum=0でlength=0のエントリを書くとentries[0].length===0なのでparseP86上は
    // 「未使用」扱いになる(意図通り: 空データは使用扱いにしない)
    const emptyResult = p86ToPpc(emptyP86);
    check('[不変条件] 全エントリ未使用の.P86はok:trueかつrequiredBytesが予約領域(PADDING_BYTES)ぴったり',
      emptyResult.ok === true && emptyResult.requiredBytes === __internal.PADDING_BYTES,
      emptyResult.ok ? `requiredBytes=${emptyResult.requiredBytes} (期待=${__internal.PADDING_BYTES})` : emptyResult.message);
  }

  // --- parseP86の失敗系(不変ではなく基本の妥当性) ---
  {
    const garbage = new Uint8Array(20).fill(0xff);
    check('[異常系] マジック不一致のバイト列はparseP86がnullを返す', parseP86(garbage) === null);
    check('[異常系] 短すぎるバイト列はparseP86がnullを返す', parseP86(new Uint8Array(4)) === null);
  }

  console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
  if (failCount > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  console.log(`\n=== 例外終了: ${passCount} PASS / ${failCount} FAIL ===`);
  process.exit(1);
});
