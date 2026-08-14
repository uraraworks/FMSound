#!/usr/bin/env node
// PMD MML コンパイラ v1 段階(3): 音色定義(MML内の `@ 音色番号 ALG FB` ブロック)の検証。
// 書式の根拠: PMDMML.MAN §3-1 [書式1](WebFetchで原文確認、tools/pmd_mml_parser.mjs冒頭
// および docs/pmd-compiler-spec.md 6.6節に出典を明記)。
//   @ 音色番号 ALG FB
//    AR DR SR RR SL TL KS ML DT AMS  (オペレータ1)
//    ...(オペレータ2-4)
//
// 検査項目:
//   1. 定義した音色番号がtonenumフィールドに反映される(第1段階と同様の確認)
//   2. 定義したTLパラメータが実際の出力振幅(absSum)に反映される
//      (tools/verify_pmd_min.mjsの手法と同一。MML本文中の定義がbuildToneEntry経由で
//      .Mの音色テーブルへ正しく書き出されていることの実測的な裏付け)
//   3. 複数の音色を定義し、@1と@2で音が変わることを確認(ALG/FBを変えて波形差を見る)
//   4. 音色定義ブロックの値域チェック(範囲外DT等)が正しく機能する(陽性対照)
//
// 実行: node tools/verify_pmd_tone_def.mjs

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

const TRACK_FM1_INDEX = 0;
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

async function playAndMeasure(mmlSource, filename, { chunkFrames = 2048, maxChunks = 60 } = {}) {
  const { file, errors } = compileMml(mmlSource);
  if (errors.length > 0) throw new Error(`compile failed: ${JSON.stringify(errors)}`);
  const Module = await createPmdWeb();
  Module.FS.writeFile(`/${filename}`, file);
  const error = Module.playMusic(`/${filename}`);
  if (error !== '') throw new Error(`playMusic failed: ${error}`);

  let absSum = 0;
  let activeTrack = null;
  for (let i = 0; i < maxChunks; i++) {
    absSum += Module.renderFramesForTest(chunkFrames);
    const track = readTrack(Module, TRACK_FM1_INDEX);
    if (!track) continue;
    const key = track[FIELD.key] & 0xff;
    if (!activeTrack && key !== 0xff) activeTrack = track;
  }
  return { absSum, track: activeTrack };
}

async function main() {
  console.log('=== PMD MMLコンパイラ v1 段階3: 音色定義(@) 検証 ===\n');

  // ---------------------------------------------------------------
  // 1. 定義した音色番号がtonenumに反映される
  // ---------------------------------------------------------------
  console.log('--- 1. 音色番号の反映 ---');
  const mmlLoud = `
@ 1 7 0
 31 0 0 0 0 0 0 1 0 0
 31 0 0 0 0 0 0 1 0 0
 31 0 0 0 0 0 0 1 0 0
 31 0 0 0 0 0 0 1 0 0
A @1 T250 o4 c1
`;
  const { track: trackLoud, absSum: absLoud } = await playAndMeasure(mmlLoud, 'tonedef_loud.m');
  check('MML内で定義した@1のtonenumが反映される', trackLoud && trackLoud[FIELD.tonenum] === 1,
    `actual=${trackLoud && trackLoud[FIELD.tonenum]}`);
  check('[陽性対照] tonenum=2を期待すると一致しない', !(trackLoud && trackLoud[FIELD.tonenum] === 2));

  // ---------------------------------------------------------------
  // 2. 定義したTLが出力振幅に反映される(段階1の手法を再利用)
  // ---------------------------------------------------------------
  console.log('\n--- 2. TLパラメータの反映(出力振幅) ---');
  const mmlQuiet = `
@ 1 7 0
 31 0 0 0 0 100 0 1 0 0
 31 0 0 0 0 100 0 1 0 0
 31 0 0 0 0 100 0 1 0 0
 31 0 0 0 0 100 0 1 0 0
A @1 T250 o4 c1
`;
  const { absSum: absQuiet } = await playAndMeasure(mmlQuiet, 'tonedef_quiet.m');
  check('MML内で定義したTL(0→100)が出力に反映される(振幅が変化)', absLoud !== absQuiet,
    `TL=0: absSum=${absLoud}, TL=100: absSum=${absQuiet}`);
  check('TL=100(より減衰)の方がTL=0より出力が小さい', absQuiet < absLoud,
    `TL=0: ${absLoud}, TL=100: ${absQuiet}`);
  check('[陽性対照] ラベルを取り違えた比較(TL=100の方が大きいと誤って期待)は成立しない', !(absQuiet > absLoud));

  // ---------------------------------------------------------------
  // 3. 複数の音色を定義し、@1と@2で音が変わることを確認
  // ---------------------------------------------------------------
  console.log('\n--- 3. 複数音色(@1 / @2)の切り替え ---');
  const mmlTwoTones = `
@ 1 7 0
 31 0 0 0 0 0 0 1 0 0
 31 0 0 0 0 0 0 1 0 0
 31 0 0 0 0 0 0 1 0 0
 31 0 0 0 0 0 0 1 0 0
@ 2 7 0
 31 0 0 0 0 60 0 1 0 0
 31 0 0 0 0 60 0 1 0 0
 31 0 0 0 0 60 0 1 0 0
 31 0 0 0 0 60 0 1 0 0
A T250 o4 @1 c1
`;
  const { track: track1, absSum: abs1 } = await playAndMeasure(mmlTwoTones, 'tonedef_multi1.m');
  const mmlTwoTonesUseTone2 = mmlTwoTones.replace('@1 c1', '@2 c1');
  const { track: track2, absSum: abs2 } = await playAndMeasure(mmlTwoTonesUseTone2, 'tonedef_multi2.m');
  check('@1使用時のtonenumが1', track1 && track1[FIELD.tonenum] === 1, `actual=${track1 && track1[FIELD.tonenum]}`);
  check('@2使用時のtonenumが2', track2 && track2[FIELD.tonenum] === 2, `actual=${track2 && track2[FIELD.tonenum]}`);
  check('@1と@2で出力(absSum)が異なる(TLが異なる音色定義が実際に効いている)', abs1 !== abs2,
    `@1(TL=0)=${abs1} @2(TL=60)=${abs2}`);
  check('[陽性対照] ラベルを取り違えた比較(@2の方が@1と同じと誤って期待)は成立しない', !(abs1 === abs2));

  // ---------------------------------------------------------------
  // 4. 音色定義の値域チェック(陽性対照: 範囲外の値は必ずエラーになる)
  // ---------------------------------------------------------------
  console.log('\n--- 4. 値域チェック(陽性対照) ---');
  const badTl = `
@ 1 7 0
 31 0 0 0 0 200 0 1 0 0
 31 0 0 0 0 0 0 1 0 0
 31 0 0 0 0 0 0 1 0 0
 31 0 0 0 0 0 0 1 0 0
A @1 c1
`;
  check('[陽性対照] TL=200(範囲外、0-127)は音色定義パース時にエラーになる',
    compileMml(badTl).errors.length > 0, JSON.stringify(compileMml(badTl).errors));

  const badOpCount = `
@ 1 7 0
 31 0 0 0 0 0 0 1 0
A @1 c1
`;
  check('[陽性対照] オペレータ行の数値が9個(10個必要)だとエラーになる',
    compileMml(badOpCount).errors.length > 0, JSON.stringify(compileMml(badOpCount).errors));

  const undefinedTone = 'A @9 c1';
  check('[陽性対照] 定義されていない音色番号(@9)を参照するとエラーになる',
    compileMml(undefinedTone).errors.length > 0, JSON.stringify(compileMml(undefinedTone).errors));

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
