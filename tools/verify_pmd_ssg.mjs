#!/usr/bin/env node
// PMD MML コンパイラ v1 段階(2): SSGパート(G/H/I = SSG1-3)の検証。
// 出典: PMDMML.MAN §1-1-3(パート記号G/H/I=SSG1-3、d2lmirrors/pmd/mc/PMDMML.MAN)。
// flat_track_status上のトラックindexは PMD_PART_* ではなく FMDRIVER_TRACK_* 順
// (upstream/98fmplayer/fmdriver/fmdriver.h:9-29)であり、FM_3_EX_1-3がFM3の直後に
// 挿入されるぶんSSGの位置がズレる。fmdriver_pmd.c:5798-5814 の pmd_track_map[] で
// FMDRIVER_TRACK_SSG_1(=9) -> PMD_PART_SSG_1 の対応が確認できる。
// => SSG1のflat_track_statusインデックスは 9(FM1の6ではない)。
//
// 検査項目:
//   1. SSGパート(G)で音程列が期待通りか(flat_track_statusのkey、FM同様noteByte)
//   2. 音が出ていること(absSum > 0)
//   3. SSGの音量(V, 0-15)がFMと刻み・値域が異なることの確認(V15を超えると内部で
//      クランプされる=fmdriver_pmd.c:1611 `if (vol > 0xf) vol = 0xf`)。
//      flat_track_status.volumeはpart->volそのもの(クランプ前)を返す
//      (fmdriver_pmd.c:5834 `track->volume = part->vol;`)ため、
//      クランプの効果は「出力振幅がV15とV20(範囲外)で同じになる」形で観測する。
//
// 実行: node tools/verify_pmd_ssg.mjs

import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import { compileMml } from './pmd_mml_compiler.mjs';
import { noteByte } from './gen_pmd_min.mjs';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

const TRACK_SSG1_INDEX = 9; // FMDRIVER_TRACK_SSG_1 = 9 (fmdriver.h:18、FM3拡張3chぶんズレる)
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
  const tracksBase = base + 4;
  const trackBase = tracksBase + trackIndex * FIELD_COUNT * 4;
  const words = new Int32Array(FIELD_COUNT);
  const base32 = trackBase / 4;
  for (let i = 0; i < FIELD_COUNT; i++) words[i] = Module.HEAP32[base32 + i];
  return words;
}

// SSGパートは音色テーブル(FM専用)を参照しないため、@1のダミー定義だけあれば足りる
// (SSGトラックが@n(0xff)を使わなければ tones は空でも構わないが、パーサの検査を
// 満たすため最小定義を渡す)。
const TONES = { 1: {} };

async function play(mmlSource, filename, { chunkFrames = 16, maxChunks = 6000, trackIndex = TRACK_SSG1_INDEX, onChunk } = {}) {
  const { file, errors } = compileMml(mmlSource, { tones: TONES });
  if (errors.length > 0) throw new Error(`compile failed: ${JSON.stringify(errors)}`);
  const Module = await createPmdWeb();
  Module.FS.writeFile(`/${filename}`, file);
  const error = Module.playMusic(`/${filename}`);
  if (error !== '') throw new Error(`playMusic failed: ${error}`);

  const dummyTrack = new Int32Array(FIELD_COUNT);
  dummyTrack[FIELD.key] = 0xff;
  dummyTrack[FIELD.playing] = 1;

  let absSum = 0;
  for (let i = 0; i < maxChunks; i++) {
    const chunkAbs = Module.renderFramesForTest(chunkFrames);
    absSum += chunkAbs;
    const track = readTrack(Module, trackIndex) ?? dummyTrack;
    const stop = onChunk ? onChunk(i, chunkAbs, track, absSum) : false;
    if (stop) break;
  }
  return { absSum };
}

async function recordKeySequence(mmlSource, trackIndex) {
  const seq = [];
  let lastKey = null;
  let ended = false;
  await play(mmlSource, 'ssg_seq.m', {
    trackIndex,
    onChunk: (i, chunkAbs, track) => {
      const key = track[FIELD.key] & 0xff;
      if (key !== 0xff && key !== lastKey) {
        seq.push(key);
        lastKey = key;
      }
      if (seq.length > 0 && track[FIELD.playing] === 0) { ended = true; return true; }
      return false;
    },
  });
  return { seq, ended };
}

async function main() {
  console.log('=== PMD MMLコンパイラ v1 段階2: SSGパート 検証 ===\n');

  // ---------------------------------------------------------------
  // 1. 音程列(SSGパートGで)
  // ---------------------------------------------------------------
  console.log('--- 1. 音程列(SSG, パートG) ---');
  const notes = ['c', 'd', 'e', 'f', 'g', 'a', 'b'];
  let mml = 'G T250 o3 ';
  const expected = [];
  for (let n = 0; n < notes.length; n++) {
    mml += `${notes[n]}%8 `;
    // noteByteは半音インデックス。c,d,e,f,g,a,bのnoteIndexは0,2,4,5,7,9,11
    const idx = [0, 2, 4, 5, 7, 9, 11][n];
    expected.push(noteByte(3, idx));
  }
  const { seq, ended } = await recordKeySequence(mml, TRACK_SSG1_INDEX);
  check('SSG(G)パートの演奏が終端まで到達した', ended);
  check('SSG(G)の音程列が期待通り', seq.length === expected.length && seq.every((k, i) => k === expected[i]),
    `expected=${expected.map((k) => k.toString(16)).join(',')} actual=${seq.map((k) => k.toString(16)).join(',')}`);
  const wrongExpected = expected.slice();
  wrongExpected[0] = (wrongExpected[0] + 1) & 0xff;
  check('[陽性対照] 1音だけ誤らせた期待列は一致しない',
    !(seq.length === wrongExpected.length && seq.every((k, i) => k === wrongExpected[i])));

  // 別トラックindex(FM1=0)を読むと一致しないはず(トラックindexの取り違え検出用の陽性対照)
  const wrongIndexRead = await recordKeySequence(mml, 0);
  check('[陽性対照] FM1のトラックindex(0)で読むとSSG(G)の音程列は観測できない(indexの取り違え検出)',
    wrongIndexRead.seq.length === 0 || !wrongIndexRead.seq.every((k, i) => k === expected[i]));

  // ---------------------------------------------------------------
  // 2. 音が出ていること
  // ---------------------------------------------------------------
  console.log('\n--- 2. 出力 ---');
  const { absSum } = await play('G T250 o3 V15 c1', 'ssg_sound.m', { trackIndex: TRACK_SSG1_INDEX, maxChunks: 200 });
  check('SSG(G)で音が出ている(absSum>0)', absSum > 0, `absSum=${absSum}`);

  // ---------------------------------------------------------------
  // 3. SSGの音量刻み・値域がFMと異なる(0-15, クランプされる)ことの確認
  // ---------------------------------------------------------------
  console.log('\n--- 3. SSG音量(0-15、クランプ) ---');
  const { absSum: absV15 } = await play('G T250 o3 V15 c1', 'ssg_v15.m', { trackIndex: TRACK_SSG1_INDEX, maxChunks: 200 });
  const { absSum: absV1 } = await play('G T250 o3 V1 c1', 'ssg_v1.m', { trackIndex: TRACK_SSG1_INDEX, maxChunks: 200 });
  check('SSGでもV15とV1で出力が異なる(音量が効いている)', absV15 !== absV1, `V15=${absV15} V1=${absV1}`);
  check('SSGはV15(大)の方がV1(小)より出力が大きい', absV15 > absV1, `V15=${absV15} V1=${absV1}`);
  check('[陽性対照] SSGでV15の値域チェック: V16を渡すとパースエラーになる(SSGは0-15、doc PMDMML.MAN §5-2)',
    compileMml('G T250 o3 V16 c1', { tones: TONES }).errors.length > 0,
    JSON.stringify(compileMml('G T250 o3 V16 c1', { tones: TONES }).errors));
  check('[陽性対照] FMなら同じV16は範囲内(0-127)としてエラーにならない(SSGとの値域差の確認)',
    compileMml('A @1 T250 o4 V16 c1', { tones: TONES }).errors.length === 0);

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
