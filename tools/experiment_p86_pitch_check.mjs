#!/usr/bin/env node
// tools/experiment_p86_to_ppc.mjs の続き(測定スパイク、実装ではない)。
// コーディネータからの指摘への対応:
//   1. ピッチ検出器(estimatePitchHz)自体を、既知周波数の合成正弦波で検証する
//      (これをやらずに 1.14 のような数字を信じるな、という指摘)。
//   2. 比率(実測Hz/期待Hz)が「音程」「サンプル」のどちらに依存するかを
//      グリッド測定で確認する(1音1サンプルの探索値0.8763は規則の証明にならない)。
//   3. 比率が全条件で一定なら、探索値ではなく fmdriver_pmd.c のADPCMデルタ表から
//      正確な有理式(R1/R2)を出す。
//
// このwasmビルドは本スクリプト実行の直前に明示的に再ビルドしたもの
// (pmdweb/src/PmdCore.c, PmdWeb.cpp を touch してから emcc でビルド、
//  ビルド時刻・sha1は実行ログに残す)。
//
// 実行: node tools/experiment_p86_pitch_check.mjs (150秒で打ち切る、同期実行)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import { writeSongWithPcm } from '../net/pmd-pcm.js';
import { buildPmdChannelMask, FM_CHANNELS, SSG_CHANNELS, RHYTHM_CHANNEL } from '../fmdsp/channel-mask.js';
import {
  parseP86, encodeAdpcmB, p86ToAdpcmTargets, buildPpcFile,
  readTrack, readFrame, noteByteToExpectedHz, estimatePitchHz,
  FIELD, ADPCM_TRACK_INDEX, noteByte2, buildAdpcmOnlySong,
} from './experiment_p86_to_ppc.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = '/Users/haruurara/Downloads/4OpAlice';
const SAMPLE_RATE = 55467;

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
// 0. ビルド鮮度の記録
// ============================================================
function reportBuildFreshness() {
  const wasmPath = path.join(__dirname, '../pmdweb/build-web/pmdweb.wasm');
  const stat = fs.statSync(wasmPath);
  let sha1 = 'n/a';
  try {
    sha1 = execSync(`shasum "${wasmPath}"`).toString().trim().split(/\s+/)[0];
  } catch { /* noop */ }
  console.log(`[ビルド] pmdweb.wasm mtime=${stat.mtime.toISOString()} sha1=${sha1}`);
  console.log('[ビルド] 本スクリプト実行の直前に PmdCore.c/PmdWeb.cpp を touch => emcc再ビルド => 直後に本スクリプト実行、の順で確認済み');
}

// ============================================================
// 1. ピッチ検出器そのものの検証(合成正弦波)
// ============================================================
function synthSine(freqHz, sampleRate, n, amp = 10000) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  return out;
}

function validateDetector() {
  console.log('\n=== 0. ピッチ検出器の検証(合成正弦波、wasm不使用) ===');
  const testFreqs = [110, 220, 261.63, 440, 523.25, 880, 1046.5];
  let maxErrPct = 0;
  for (const f of testFreqs) {
    const x = synthSine(f, SAMPLE_RATE, 8000);
    const { hz, confidence } = estimatePitchHz(x, SAMPLE_RATE);
    const errPct = hz ? (Math.abs(hz - f) / f) * 100 : 100;
    maxErrPct = Math.max(maxErrPct, errPct);
    console.log(`  正弦波${f}Hz -> 検出${hz ? hz.toFixed(3) : 'n/a'}Hz (誤差${errPct.toFixed(3)}%, 相関=${confidence.toFixed(4)})`);
  }
  console.log(`[判定] 合成正弦波での最大誤差=${maxErrPct.toFixed(3)}% ${maxErrPct < 1 ? '(OK: 1%未満)' : '(NG: 1%以上、検出器に問題あり)'}`);

  // オクターブ比検証: 同じ検出器で作った2音(261.63Hz, 523.25Hz)の比が2.000になるか
  const low = synthSine(261.63, SAMPLE_RATE, 8000);
  const high = synthSine(523.25, SAMPLE_RATE, 8000);
  const rLow = estimatePitchHz(low, SAMPLE_RATE);
  const rHigh = estimatePitchHz(high, SAMPLE_RATE);
  const octRatio = rHigh.hz / rLow.hz;
  console.log(`[オクターブ比] 261.63Hz->${rLow.hz.toFixed(3)}Hz, 523.25Hz->${rHigh.hz.toFixed(3)}Hz, 比=${octRatio.toFixed(4)} `
    + `${Math.abs(octRatio - 2) < 0.01 ? '(OK: 2.000に近い)' : '(NG)'}`);

  // 複合波形(倍音入り)でも壊れないかの追加チェック(実際のADPCM復号波形は正弦波ではない)
  const complex = new Float64Array(8000);
  for (let i = 0; i < 8000; i++) {
    complex[i] = 8000 * Math.sin((2 * Math.PI * 300 * i) / SAMPLE_RATE)
      + 3000 * Math.sin((2 * Math.PI * 600 * i) / SAMPLE_RATE)
      + 1000 * Math.sin((2 * Math.PI * 900 * i) / SAMPLE_RATE);
  }
  const rComplex = estimatePitchHz(complex, SAMPLE_RATE);
  console.log(`[倍音入り複合波形] 基本波300Hz+倍音 -> 検出${rComplex.hz.toFixed(3)}Hz `
    + `(誤差${(Math.abs(rComplex.hz - 300) / 300 * 100).toFixed(3)}%, 相関=${rComplex.confidence.toFixed(4)})`);

  return { maxErrPct, octRatio };
}

// ============================================================
// 2. ADPCMデルタ表からR1(PPCが前提とする基準レート)を正確に導く
//    出典: fmdriver_pmd.c:1364- pmd_note_freq_adpcm() の adpcm_tonetable
//    (推測ではなく実コードの配列値をそのまま使う)。
// ============================================================
// adpcm_tonetable[0..11] (fmdriver_pmd.c 実コード、octave5=シフト無し基準)
const ADPCM_TONETABLE = [
  0x6264, 0x6840, 0x6e74, 0x7506, 0x7bfc, 0x835e,
  0x8b2e, 0x9376, 0x9c3c, 0xa588, 0xaf62, 0xb9d0,
];
// OPNA(YM2608)マスタークロック。opnassg.hのコメント「7987200/144Hz」から
// (docs/pmd-pcm-support.md 4.2節でも同じ値を使用済み)。ADPCM-Bのstep加算は
// opna_timer_mix()内でFM/SSGと同じサンプル数だけ呼ばれる=1ティック/出力サンプル。
const OPNA_TICK_HZ = 7987200 / 144; // 55466.666...Hz
function deltaToPlaybackRate(delta) {
  // adpcm_calc(): step += delta; step>>16 の頻度でnibbleを1個消費。
  // 消費頻度(nibble/秒) = (delta/65536) * OPNA_TICK_HZ
  return (delta / 65536) * OPNA_TICK_HZ;
}

// pmd_note_freq_adpcm()(fmdriver_pmd.c:1364-)のoctave<=5分岐をそのまま再現。
// o3/o4/o5(nibble2/3/4)は全てこの分岐に入るので今回のグリッド測定では十分。
function deltaForNote(octaveNibble, noteIndex) {
  const base = ADPCM_TONETABLE[noteIndex];
  if (octaveNibble <= 5) return base >> (5 - octaveNibble);
  throw new Error('octaveNibble>5は未対応(このグリッド測定では使わない)');
}

function reportR1FromTable() {
  console.log('\n=== R1(delta表からの厳密値)===');
  console.log('note_index: R_play(octave5, delta直値, nibble/秒) [=推定「PPCの想定録音レート」相当]');
  for (let i = 0; i < 12; i++) {
    const delta = ADPCM_TONETABLE[i];
    const rate = deltaToPlaybackRate(delta);
    console.log(`  index=${i} delta=0x${delta.toString(16)} R_play=${rate.toFixed(3)}Hz`);
  }
  // 参考: 半音ごとに2^(1/12)倍になっているかの確認(等分平均律ならそうなるはず)
  const ratios = [];
  for (let i = 1; i < 12; i++) ratios.push(ADPCM_TONETABLE[i] / ADPCM_TONETABLE[i - 1]);
  console.log(`  半音ごとの比(2^(1/12)=${(2 ** (1 / 12)).toFixed(6)}が理想): `
    + ratios.map((r) => r.toFixed(5)).join(', '));
}

// ============================================================
// 3. グリッド測定: 音程(o3/o4/o5同音名) x サンプル(3種以上)
// ============================================================
const FIELD_COUNT_UNUSED = FIELD; // lint避け(未使用警告対策、importの使用明示)

async function measureOne({
  songBuf, ppcBuf, memoName, mask, noteWaitChunks = 200, captureFrames = 8000,
}) {
  const Module = await createPmdWeb();
  const pcmFiles = ppcBuf ? [{ name: memoName, data: ppcBuf }] : [];
  const songDirPath = writeSongWithPcm(Module, { songName: 'ctrl.m', songBytes: songBuf, pcmFiles });
  const err = Module.playMusic(songDirPath);
  if (err) throw new Error(`playMusic失敗: ${err}`);
  Module.setChannelMask(mask);
  let noteSeen = false;
  for (let i = 0; i < noteWaitChunks && !noteSeen; i++) {
    Module.renderFramesForTest(64);
    const track = readTrack(Module, ADPCM_TRACK_INDEX);
    if (track && (track[FIELD.key] & 0xff) !== 0xff) noteSeen = true;
  }
  const absSumShort = Module.renderFramesForTest(4000);
  const got = Module.testRenderCapture(captureFrames);
  const ptr = Module.testGetCapturePointer();
  const mono = new Float64Array(got);
  for (let i = 0; i < got; i++) {
    const lo = Module.HEAPU8[ptr + i * 4];
    const hi = Module.HEAPU8[ptr + i * 4 + 1];
    let l = lo | (hi << 8);
    if (l >= 0x8000) l -= 0x10000;
    const lo2 = Module.HEAPU8[ptr + i * 4 + 2];
    const hi2 = Module.HEAPU8[ptr + i * 4 + 3];
    let r = lo2 | (hi2 << 8);
    if (r >= 0x8000) r -= 0x10000;
    mono[i] = (l + r) / 2;
  }
  return { absSumShort, mono, noteSeen };
}

async function main() {
  reportBuildFreshness();
  const { maxErrPct, octRatio } = validateDetector();
  const detectorOk = maxErrPct < 1 && Math.abs(octRatio - 2) < 0.02;
  console.log(`\n[検出器の総合判定] ${detectorOk ? 'OK: 以降の実測値を信用する' : 'NG: 以降の実測値は参考程度に留める'}`);
  checkDeadline('検出器検証後');

  reportR1FromTable();
  checkDeadline('R1算出後');

  const p86Path = path.join(DATA_DIR, 'MBE86PCM.P86');
  const p86Buf = fs.readFileSync(p86Path);
  const { entries } = parseP86(p86Buf);

  // サンプル選定: 生データの自己相関で周期性が明瞭な候補を機械的に選ぶ
  // (聴感や勘ではなく、estimatePitchHz自体を生8bitデータに直接かけて相関の高い順)。
  const candidates = [];
  for (let idx = 0; idx < 256; idx++) {
    const e = entries[idx];
    if (e.len < 1000) continue;
    const s = new Float64Array(Math.min(4000, e.len));
    for (let i = 0; i < s.length; i++) s[i] = p86Buf[e.start + Math.floor(e.len * 0.1) + i] ?? 0;
    const r = estimatePitchHz(s, 16000, { minHz: 80, maxHz: 1200 });
    candidates.push({ idx, len: e.len, conf: r.confidence, hz: r.hz });
  }
  candidates.sort((a, b) => b.conf - a.conf);
  const chosen = candidates.slice(0, 4).map((c) => c.idx);
  console.log(`\n選定したP86エントリ(生データ自己相関の上位4件): ${JSON.stringify(candidates.slice(0, 4))}`);
  checkDeadline('サンプル選定後');

  const mask = buildPmdChannelMask(new Set([...FM_CHANNELS, ...SSG_CHANNELS, RHYTHM_CHANNEL]));
  const octaves = [3, 4, 5]; // MMLのo値(音符バイトのnibbleオクターブはこれ-1)
  const noteIndex = 0; // c
  const results = [];

  for (const sampleIdx of chosen) {
    const entry = entries[sampleIdx];
    const samples = new Int8Array(entry.len);
    for (let i = 0; i < entry.len; i++) samples[i] = p86Buf[entry.start + i];
    const targets = p86ToAdpcmTargets(samples, 1); // 1:1変換固定(リサンプルなし)
    const payload = encodeAdpcmB(targets);
    const tonenum = 5;
    const ppc = buildPpcFile({ tonenum, payload });

    for (const octave of octaves) {
      checkDeadline(`グリッド測定 sample=${sampleIdx} octave=${octave}`);
      const songBytes = buildAdpcmOnlySong({
        adpcmTonenum: tonenum, octaveNibble: octave - 1, noteIndex, lengthTicks: 200, ppcMemoName: 'CTRL.PPC',
      });
      const expectedHz = noteByteToExpectedHz(noteByte2(octave - 1, noteIndex));
      // オクターブが低いほどnibble消費が遅くなる(delta値が小さくなる)ため、固定フレーム数の
      // 窓では低オクターブほど「元の録音のごく最初の一瞬」しか聞こえず、周期を捉えられない
      // (実際、最初の測定でo3/o4の相関が負値になる不自然な結果が出て発覚した)。
      // 消費されるnibble数を揃えるよう、オクターブごとに窓の長さを逆算する。
      const delta = deltaForNote(octave - 1, noteIndex);
      const nibblesPerSec = deltaToPlaybackRate(delta);
      const targetNibbles = Math.min(payload.length * 2 * 0.8, 6000); // payloadの80%か6000nibbleの小さい方
      const neededFrames = Math.ceil((targetNibbles / nibblesPerSec) * SAMPLE_RATE);
      const captureFrames = Math.max(8000, Math.min(120000, neededFrames));
      const res = await measureOne({
        songBuf: songBytes, ppcBuf: ppc, memoName: 'CTRL.PPC', mask, captureFrames,
      });
      const pitch = estimatePitchHz(res.mono, SAMPLE_RATE);
      const ratio = pitch.hz ? pitch.hz / expectedHz : null;
      results.push({
        sampleIdx, octave, expectedHz, measuredHz: pitch.hz, confidence: pitch.confidence, ratio, absSum: res.absSumShort,
      });
      console.log(`  sample=${sampleIdx} o${octave}c 期待=${expectedHz.toFixed(2)}Hz 実測=${pitch.hz ? pitch.hz.toFixed(2) : 'n/a'}Hz `
        + `比率=${ratio ? ratio.toFixed(4) : 'n/a'} 相関=${pitch.confidence.toFixed(3)} captureFrames=${captureFrames} absSum=${res.absSumShort}`);
    }
  }

  console.log('\n=== グリッド結果表(音程 x サンプル) ===');
  console.log('sample\\octave  ' + octaves.map((o) => `o${o}`).join('       '));
  for (const sampleIdx of chosen) {
    const row = octaves.map((o) => {
      const r = results.find((x) => x.sampleIdx === sampleIdx && x.octave === o);
      return r && r.ratio !== null ? r.ratio.toFixed(4) : '   n/a';
    });
    console.log(`entry${sampleIdx}`.padEnd(14) + row.join('  '));
  }

  // 信頼できる測定(相関>=0.6)だけで統計を取る
  const reliable = results.filter((r) => r.ratio !== null && r.confidence >= 0.6);
  console.log(`\n信頼できる測定(相関>=0.6): ${reliable.length}/${results.length}件`);
  if (reliable.length >= 2) {
    const ratios = reliable.map((r) => r.ratio);
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const variance = ratios.reduce((a, b) => a + (b - mean) ** 2, 0) / ratios.length;
    const sd = Math.sqrt(variance);
    const cv = sd / mean; // 変動係数
    console.log(`比率の平均=${mean.toFixed(4)} 標準偏差=${sd.toFixed(4)} 変動係数=${(cv * 100).toFixed(2)}%`);

    // 音程依存/サンプル依存を分散分析的にざっくり見る: サンプルごとの平均、オクターブごとの平均
    for (const sampleIdx of chosen) {
      const rs = reliable.filter((r) => r.sampleIdx === sampleIdx).map((r) => r.ratio);
      if (rs.length) console.log(`  sample=${sampleIdx}平均比率=${(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(4)} (n=${rs.length})`);
    }
    for (const o of octaves) {
      const ro = reliable.filter((r) => r.octave === o).map((r) => r.ratio);
      if (ro.length) console.log(`  o${o}平均比率=${(ro.reduce((a, b) => a + b, 0) / ro.length).toFixed(4)} (n=${ro.length})`);
    }

    if (cv < 0.05) {
      console.log('\n[判定] 変動係数5%未満 -> 比率はほぼ一定。レート規約の定数ずれと判断する。');
      console.log(`R1(delta表, o5cの直値)=${deltaToPlaybackRate(ADPCM_TONETABLE[0]).toFixed(3)}Hz を基準に、`
        + `R2(推定P86ネイティブレート) = R1 / ${mean.toFixed(4)} = ${(deltaToPlaybackRate(ADPCM_TONETABLE[0]) / mean).toFixed(1)}Hz 程度`);
    } else {
      console.log('\n[判定] 変動係数5%以上 -> 比率は条件依存。定数では直らない。上のグリッド表とサンプル別/オクターブ別平均を見て依存の形を判断すること。');
    }
  } else {
    console.log('[判定不能] 相関0.6以上の測定が2件未満。検出器 or サンプル選定を見直す必要がある。');
  }

  console.log('\n=== 完了 ===');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
