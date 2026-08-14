#!/usr/bin/env node
// PMD MML コンパイラ v1 段階(4): 複数パート同時演奏の統合検証。
// 目的: 複数パート(FM×2、および FM+SSG)に別々の音程列を書いたとき、
// 各パートが flat_track_status 上で独立に(互いに干渉せず)期待通りの値になるかを確認する。
// パートごとに長さが違う場合(片方が先に終端に到達する場合)の挙動も確認する。
//
// トラックindexの対応(FMDRIVER_TRACK_*、fmdriver.h:9-29。SSGはFM3拡張3chぶんズレる。
// tools/verify_pmd_ssg.mjs冒頭コメント参照):
//   FM1=0, FM2=1, ..., FM6=8, SSG1=9, SSG2=10, SSG3=11
//
// 実行: node tools/verify_pmd_multipart.mjs

import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import { compileMml } from '../compiler/pmd_mml_compiler.mjs';
import { noteByte } from '../compiler/gen_pmd_min.mjs';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

const TRACK_INDEX = { A: 0, B: 1, C: 2, G: 9, H: 10, I: 11 }; // fmdriver.h:9-29 参照(FM1-2, SSG1-3)
const FIELD_COUNT = 26;
const FIELD = {
  playing: 0, info: 1, ticks: 2, ticks_left: 3, key: 4, actual_key: 5,
  tonenum: 6, volume: 7, gate: 8, detune: 9,
};
const SNAPSHOT_RING_SIZE = 2048;

function readTrack(Module, trackIndex) {
  const writeIndex = Module.getSnapshotWriteIndex() >>> 0;
  if (writeIndex === 0xffffffff || writeIndex === 0) return null;
  const entryBytes = Module.getSnapshotEntryByteSize();
  const ringPtr = Module.getSnapshotRingPointer();
  const idx = (writeIndex - 1) % SNAPSHOT_RING_SIZE;
  const base = ringPtr + idx * entryBytes;
  const tracksBase = base + Module.getSnapshotHeaderWordCount() * 4;
  const trackBase = tracksBase + trackIndex * FIELD_COUNT * 4;
  const words = new Int32Array(FIELD_COUNT);
  const base32 = trackBase / 4;
  for (let i = 0; i < FIELD_COUNT; i++) words[i] = Module.HEAP32[base32 + i];
  return words;
}

const TONES = { 1: { tl: [0, 0, 0, 0], ar: [31, 31, 31, 31], rr: [7, 7, 7, 7], alg: 7, fb: 0 } };

// 複数パートを同時再生し、各パートのkey遷移列を並行して記録する。
async function recordMultiTrackKeySeq(mmlSource, letters, { chunkFrames = 16, maxChunks = 8000 } = {}) {
  const { file, errors } = compileMml(mmlSource, { tones: TONES });
  if (errors.length > 0) throw new Error(`compile failed: ${JSON.stringify(errors)}`);
  const Module = await createPmdWeb();
  Module.FS.writeFile('/multi.m', file);
  const error = Module.playMusic('/multi.m');
  if (error !== '') throw new Error(`playMusic failed: ${error}`);

  const seqs = {};
  const lastKeys = {};
  const endedFlags = {};
  for (const letter of letters) { seqs[letter] = []; lastKeys[letter] = null; endedFlags[letter] = false; }

  for (let i = 0; i < maxChunks; i++) {
    Module.renderFramesForTest(chunkFrames);
    let allEnded = true;
    for (const letter of letters) {
      const track = readTrack(Module, TRACK_INDEX[letter]);
      if (!track) { allEnded = false; continue; }
      const key = track[FIELD.key] & 0xff;
      if (key !== 0xff && key !== lastKeys[letter]) {
        seqs[letter].push(key);
        lastKeys[letter] = key;
      }
      if (seqs[letter].length > 0 && track[FIELD.playing] === 0) endedFlags[letter] = true;
      else allEnded = false;
    }
    if (allEnded) break;
  }
  return { seqs, endedFlags };
}

async function main() {
  console.log('=== PMD MMLコンパイラ v1 段階4: 複数パート統合 検証 ===\n');

  // ---------------------------------------------------------------
  // 1. FM2パート(A, B)に別々の音程列。互いに独立しているか
  // ---------------------------------------------------------------
  console.log('--- 1. FM2パート(A/B)の独立性 ---');
  const mml2fm = `
A @1 T250 o4 c%8 d%8 e%8 f%8
B @1 T250 o5 g%8 f%8 e%8 d%8
`;
  const { seqs: seqs2fm, endedFlags: ended2fm } = await recordMultiTrackKeySeq(mml2fm, ['A', 'B']);
  const expectedA = [0, 2, 4, 5].map((n) => noteByte(4, n));
  const expectedB = [7, 5, 4, 2].map((n) => noteByte(5, n));
  check('パートAが終端まで到達した', ended2fm.A);
  check('パートBが終端まで到達した', ended2fm.B);
  check('パートAの音程列が期待通り(パートBの内容が混入していない)',
    seqs2fm.A.length === expectedA.length && seqs2fm.A.every((k, i) => k === expectedA[i]),
    `expected=${expectedA.map((k) => k.toString(16)).join(',')} actual=${seqs2fm.A.map((k) => k.toString(16)).join(',')}`);
  check('パートBの音程列が期待通り(パートAの内容が混入していない)',
    seqs2fm.B.length === expectedB.length && seqs2fm.B.every((k, i) => k === expectedB[i]),
    `expected=${expectedB.map((k) => k.toString(16)).join(',')} actual=${seqs2fm.B.map((k) => k.toString(16)).join(',')}`);
  // 陽性対照: AとBの期待列を入れ替えたら一致しないはず(2パートが実際に別々の内容である証拠)
  check('[陽性対照] パートAとBの期待列を取り違えると一致しない',
    !(seqs2fm.A.length === expectedB.length && seqs2fm.A.every((k, i) => k === expectedB[i])));

  // ---------------------------------------------------------------
  // 2. FM+SSG混在(A, G)。パート種別をまたいでも独立しているか
  // ---------------------------------------------------------------
  console.log('\n--- 2. FM+SSG混在(A/G)の独立性 ---');
  const mmlFmSsg = `
A @1 T250 o4 c%4 e%4 g%4
G T250 o3 a%4 f%4 d%4
`;
  const { seqs: seqsFmSsg, endedFlags: endedFmSsg } = await recordMultiTrackKeySeq(mmlFmSsg, ['A', 'G']);
  const expectedFmA = [0, 4, 7].map((n) => noteByte(4, n));
  const expectedSsgG = [9, 5, 2].map((n) => noteByte(3, n));
  check('FMパートAが終端まで到達した', endedFmSsg.A);
  check('SSGパートGが終端まで到達した', endedFmSsg.G);
  check('FM(A)の音程列がSSG(G)の内容と混ざらず期待通り',
    seqsFmSsg.A.length === expectedFmA.length && seqsFmSsg.A.every((k, i) => k === expectedFmA[i]),
    `expected=${expectedFmA.map((k) => k.toString(16)).join(',')} actual=${seqsFmSsg.A.map((k) => k.toString(16)).join(',')}`);
  check('SSG(G)の音程列がFM(A)の内容と混ざらず期待通り',
    seqsFmSsg.G.length === expectedSsgG.length && seqsFmSsg.G.every((k, i) => k === expectedSsgG[i]),
    `expected=${expectedSsgG.map((k) => k.toString(16)).join(',')} actual=${seqsFmSsg.G.map((k) => k.toString(16)).join(',')}`);
  check('[陽性対照] FMとSSGの期待列を取り違えると一致しない',
    !(seqsFmSsg.A.length === expectedSsgG.length && seqsFmSsg.A.every((k, i) => k === expectedSsgG[i])));

  // ---------------------------------------------------------------
  // 3. パートごとに長さが違う場合(片方が先に終わる)の挙動
  // ---------------------------------------------------------------
  console.log('\n--- 3. 長さの異なるパート(片方が先に終端到達) ---');
  const mmlDiffLen = `
A @1 T250 o4 c%4
B @1 T250 o4 c%4 d%4 e%4 f%4 g%4 a%4 b%4 c%4 d%4 e%4
`;
  const { seqs: seqsDiff, endedFlags: endedDiff } = await recordMultiTrackKeySeq(mmlDiffLen, ['A', 'B'], { maxChunks: 20000 });
  check('短いパートAが先に終端まで到達する', endedDiff.A);
  check('長いパートBも最終的に終端まで到達する', endedDiff.B);
  check('短いパートAの音程列は1音だけ(後続パートBの影響を受けない)',
    seqsDiff.A.length === 1 && seqsDiff.A[0] === noteByte(4, 0), `actual=${seqsDiff.A.map((k) => k.toString(16)).join(',')}`);
  const expectedLongB = [0, 2, 4, 5, 7, 9, 11, 0, 2, 4].map((n, i) => noteByte(4, n));
  check('長いパートBの音程列が期待通り(短いパートAの終了に引きずられていない)',
    seqsDiff.B.length === expectedLongB.length && seqsDiff.B.every((k, i) => k === expectedLongB[i]),
    `expected=${expectedLongB.map((k) => k.toString(16)).join(',')} actual=${seqsDiff.B.map((k) => k.toString(16)).join(',')}`);
  check('[陽性対照] パートBの音程列を1音だけと誤って期待すると一致しない', !(seqsDiff.B.length === 1));

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
