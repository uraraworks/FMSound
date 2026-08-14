#!/usr/bin/env node
// PMD MML コンパイラ v1 段階(1): 音量(v/V)の検証。
// 出典: PMDMML.MAN §5-1(v, 大雑把な値, FM/PCM=0-16でVへ変換, SSG=0-15)・
//       §5-2(V, 絶対値, FM=0-127, SSG=0-15)。fmdriver_pmd.c:2347-2355(pmd_cmdfd_vol、
//       0xfdはFM/SSG共通で part->vol に生バイトを代入するだけ)。
// 検査項目:
//   1. V(絶対値)が flat_track_status.volume にそのまま反映されるか(FM)
//   2. Vを変えると実際に出力振幅(absSum)が変わるか(陽性対照つき)
//   3. v(大雑把な値)がPMDMML.MAN §5-1の変換テーブル通りVへ変換されるか(FM)
// 本スクリプトはFMパート(A)のみを対象とする。SSGパートでの音量差分は
// tools/verify_pmd_ssg.mjs(段階2)で扱う。
//
// 実行: node tools/verify_pmd_vol.mjs

import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import { compileMml } from '../compiler/pmd_mml_compiler.mjs';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

const TRACK_FM1_INDEX = 0; // FMDRIVER_TRACK_FM_1 = 0 (fmdriver.h:9)
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

// MMLを再生し、keyが休符でなくなった直後のtrack(=発音直後のスナップショット)と
// その後の一定時間ぶんのabsSum合計を返す。
async function playAndMeasure(mmlSource, filename, { chunkFrames = 2048, maxChunks = 60, trackIndex = TRACK_FM1_INDEX } = {}) {
  const { file, errors } = compileMml(mmlSource, { tones: TONES });
  if (errors.length > 0) throw new Error(`compile failed: ${JSON.stringify(errors)}`);
  const Module = await createPmdWeb();
  Module.FS.writeFile(`/${filename}`, file);
  const error = Module.playMusic(`/${filename}`);
  if (error !== '') throw new Error(`playMusic failed: ${error}`);

  let absSum = 0;
  let activeTrack = null;
  for (let i = 0; i < maxChunks; i++) {
    absSum += Module.renderFramesForTest(chunkFrames);
    const track = readTrack(Module, trackIndex);
    if (!track) continue;
    const key = track[FIELD.key] & 0xff;
    if (!activeTrack && key !== 0xff) activeTrack = track;
  }
  return { absSum, track: activeTrack };
}

async function main() {
  console.log('=== PMD MMLコンパイラ v1 段階1: 音量(v/V) 検証 ===\n');

  // ---------------------------------------------------------------
  // 1. V(絶対値)がそのまま volume フィールドへ反映されるか
  // ---------------------------------------------------------------
  console.log('--- 1. V(絶対値) ---');
  const { track: trackV64 } = await playAndMeasure('A @1 T250 o4 V64 c1', 'v64.m');
  check('V64 -> volume=64', trackV64 && trackV64[FIELD.volume] === 64, `actual=${trackV64 && trackV64[FIELD.volume]}`);
  check('[陽性対照] volume=65を期待すると一致しない', !(trackV64 && trackV64[FIELD.volume] === 65));

  const { track: trackDefault } = await playAndMeasure('A @1 T250 o4 c1', 'vdefault.m');
  check('Vコマンド未使用ならFM初期値108のまま', trackDefault && trackDefault[FIELD.volume] === 108,
    `actual=${trackDefault && trackDefault[FIELD.volume]}`);

  // ---------------------------------------------------------------
  // 2. Vを変えると出力振幅(absSum)が実際に変わるか
  // ---------------------------------------------------------------
  console.log('\n--- 2. 出力振幅 ---');
  const { absSum: absLoud } = await playAndMeasure('A @1 T250 o4 V127 c1', 'vol_loud.m');
  const { absSum: absQuiet } = await playAndMeasure('A @1 T250 o4 V1 c1', 'vol_quiet.m');
  check('V127とV1で出力(absSum)が異なる', absLoud !== absQuiet, `V127=${absLoud} V1=${absQuiet}`);
  check('V127(大)の方がV1(小)より出力が大きい(FMはvolが大きいほど大音量)',
    absLoud > absQuiet, `V127=${absLoud} V1=${absQuiet} ratio=${(absLoud / Math.max(absQuiet, 1)).toFixed(2)}`);
  check('[陽性対照] ラベルを取り違えた比較(V1の方が大きいと誤って期待)は成立しない', !(absQuiet > absLoud));

  // ---------------------------------------------------------------
  // 3. v(大雑把な値)がPMDMML.MAN §5-1の変換テーブル通りVへ変換されるか
  // ---------------------------------------------------------------
  console.log('\n--- 3. v(変換テーブル) ---');
  // 出典: PMDMML.MAN §5-1 v0-v16 -> V85-V127 の表(WebFetchで原文確認)。
  const V_TABLE = [85, 87, 90, 93, 95, 98, 101, 103, 106, 109, 111, 114, 117, 119, 122, 125, 127];
  const sampleV = [0, 8, 16];
  for (const vVal of sampleV) {
    const { track } = await playAndMeasure(`A @1 T250 o4 v${vVal} c1`, `v_${vVal}.m`);
    const expected = V_TABLE[vVal];
    check(`v${vVal} -> V${expected}相当のvolumeになる`, track && track[FIELD.volume] === expected,
      `actual=${track && track[FIELD.volume]}`);
  }
  // 陽性対照: v0はV0ではなくV85であることを確認(変換テーブルを使わず素通ししていたら検出できる)
  const { track: trackV0 } = await playAndMeasure('A @1 T250 o4 v0 c1', 'v0.m');
  check('[陽性対照] v0の実際のvolumeはV0ではない(素通し実装ではないことの確認)',
    trackV0 && trackV0[FIELD.volume] !== 0, `actual=${trackV0 && trackV0[FIELD.volume]}`);

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
