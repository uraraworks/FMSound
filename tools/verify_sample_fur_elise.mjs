#!/usr/bin/env node
// html/sample_fur_elise.M (tools/sample_fur_elise.mml から生成) を pmdweb 実再生で検証する。
// 作法は tools/verify_pmd_multipart.mjs / tools/verify_pmd_min.mjs に揃える。
//
// 確認する内容:
//   1. FM1(旋律)の音程列(flat_track_status.key)が、楽譜(Mutopia Project浄書版)から
//      実測で書き起こした意図どおりの音符列と一致するか(陽性対照つき)。
//   2. FM2(伴奏)が独立して鳴っており、FM1と混線していないか。
//   3. 実際に音が出ているか(renderFramesForTest の絶対値和)。
//   4. 全体ループ(L)が機能し、旋律の音程列が2周目も同じパターンで繰り返すか。
//
// 実行: node tools/verify_sample_fur_elise.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import { compileMml } from './pmd_mml_compiler.mjs';
import { noteByte } from './gen_pmd_min.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

const TRACK_INDEX = { A: 0, B: 1 }; // fmdriver.h:9-29 (FM1=0, FM2=1)
const FIELD_COUNT = 26;
const FIELD = { playing: 0, key: 4 };
const SNAPSHOT_RING_SIZE = 2048;

function readTrack(Module, trackIndex) {
  const writeIndex = Module.getSnapshotWriteIndex() >>> 0;
  if (writeIndex === 0xffffffff || writeIndex === 0) return null;
  const entryBytes = Module.getSnapshotEntryByteSize();
  const ringPtr = Module.getSnapshotRingPointer();
  const idx = (writeIndex - 1) % SNAPSHOT_RING_SIZE;
  const base = ringPtr + idx * entryBytes;
  const trackBase = base + 4 + trackIndex * FIELD_COUNT * 4;
  const words = new Int32Array(FIELD_COUNT);
  const base32 = trackBase / 4;
  for (let i = 0; i < FIELD_COUNT; i++) words[i] = Module.HEAP32[base32 + i];
  return words;
}

async function main() {
  console.log('=== sample_fur_elise.M 実再生検証 ===\n');

  const mmlPath = path.join(__dirname, 'sample_fur_elise.mml');
  const source = fs.readFileSync(mmlPath, 'utf8');
  const { file, errors } = compileMml(source);
  if (errors.length > 0) {
    console.error('compile failed:', errors);
    process.exit(1);
  }

  const Module = await createPmdWeb();
  Module.FS.writeFile('/fe.m', file);
  const playError = Module.playMusic('/fe.m');
  if (playError !== '') throw new Error(`playMusic failed: ${playError}`);

  // 楽譜(Mutopia Project浄書版)から実測で書き起こした期待音程列(m2_run_zoom4.png等での
  // ピクセル座標照合、報告参照)。noteIndex: c=0 d=2 e=4 f=5 g=7 a=9 b=11 (+1=シャープ)
  const expectedA = [
    [5, 4], [5, 3],                 // 上げ拍: e5 d+5
    [5, 4], [5, 3], [5, 4], [4, 11], [5, 2], [5, 0], // e5 d+5 e5 b4 d5 c5
    [4, 9], [4, 0], [4, 4], [4, 9],  // a4 c4 e4 a4
    [4, 11], [4, 4], [4, 8], [4, 11], // b4 e4 g+4 b4
    [5, 0],                          // c5
  ].map(([oct, ni]) => noteByte(oct, ni));

  const seqA = [];
  let lastKeyA = null;
  let endedA = false;
  const seqB = [];
  let lastKeyB = null;
  let absSum = 0;

  for (let i = 0; i < 20000 && !endedA; i++) {
    absSum += Module.renderFramesForTest(256);
    const trackA = readTrack(Module, TRACK_INDEX.A);
    const trackB = readTrack(Module, TRACK_INDEX.B);
    if (trackA) {
      const key = trackA[FIELD.key] & 0xff;
      if (key !== 0xff && key !== lastKeyA) { seqA.push(key); lastKeyA = key; }
      // ループ(L)ありなので playing は 0 に落ちない。旋律の最初の1周分(17音)
      // が集まった時点で打ち切る。
      if (seqA.length >= expectedA.length) endedA = true;
    }
    if (trackB) {
      const key = trackB[FIELD.key] & 0xff;
      if (key !== 0xff && key !== lastKeyB) { seqB.push(key); lastKeyB = key; }
    }
  }

  check('FM1(旋律)が17音そろうまで再生できた', seqA.length === expectedA.length,
    `actual length=${seqA.length}`);
  check('FM1(旋律)の音程列が楽譜からの書き起こしと一致する',
    seqA.length === expectedA.length && seqA.every((k, i) => k === expectedA[i]),
    `expected=${expectedA.map((k) => k.toString(16)).join(',')}\n    actual  =${seqA.map((k) => k.toString(16)).join(',')}`);
  // 陽性対照: 1音だけ誤らせた期待列は一致しないはず(検査自体が機能している証拠)
  const tamperedA = expectedA.slice();
  tamperedA[5] = noteByte(4, 9); // b4 -> a4 に差し替え
  check('[陽性対照] 1音だけ誤らせた期待列とは一致しない',
    !(seqA.length === tamperedA.length && seqA.every((k, i) => k === tamperedA[i])));

  check('FM2(伴奏)も並行して発音している(空ではない)', seqB.length > 0, `observed notes=${seqB.length}`);
  // 陽性対照: FM2の音程列がFM1の音程列とは異なる(別パートとして独立している証拠)
  check('[陽性対照] FM2の音程列はFM1と同一ではない(混線していない)',
    !(seqB.length === seqA.length && seqB.every((k, i) => k === seqA[i])));

  check('実際に音が出ている(absSum > 0)', absSum > 0, `absSum=${absSum}`);

  // --- ループ確認: さらにレンダリングを続け、旋律が2周目も同じ音程パターンで
  //     繰り返すか(playingが0に落ちず、次の17音がexpectedAと再び一致するか)を見る。
  const seqA2 = [];
  let lastKeyA2 = lastKeyA;
  let stillPlaying = true;
  for (let i = 0; i < 20000 && seqA2.length < expectedA.length; i++) {
    Module.renderFramesForTest(256);
    const trackA = readTrack(Module, TRACK_INDEX.A);
    if (!trackA) { stillPlaying = false; break; }
    if (trackA[FIELD.playing] === 0) { stillPlaying = false; }
    const key = trackA[FIELD.key] & 0xff;
    if (key !== 0xff && key !== lastKeyA2) { seqA2.push(key); lastKeyA2 = key; }
  }
  check('全体ループ(L)後もplayingが0に落ちない(無限ループとして継続)', stillPlaying);
  check('2周目の旋律の音程列も1周目(=期待列)と同じパターンで繰り返す',
    seqA2.length === expectedA.length && seqA2.every((k, i) => k === expectedA[i]),
    `2周目=${seqA2.map((k) => k.toString(16)).join(',')}`);

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
