#!/usr/bin/env node
// 課題B: 「ループしない曲は再生終了後に停止する」の検証。
//
// PMD側:
//   fmdriver_work.playing(upstream/98fmplayer/fmdriver/fmdriver_pmd.c:5692)を
//   pmdweb/src/PmdCore.c の status_snapshot ヘッダに追加した(driver_playing、
//   SNAPSHOT_HEADER_WORD_COUNT 6->7)。ループしない曲が末尾に到達したときだけ
//   false になり、ループする曲は pmd->loop.looped が true のままなので
//   常に true(html/pmd-app.js SNAPSHOT_HEADER.DRIVER_PLAYING参照)。
//   html/pmd-app.js updateChannelStatus() が true->false の変化を検出したら
//   stopPlayback()(頭出し停止)を呼ぶ。
//
// MUCOM88側:
//   実測で判明: GetStatus(MUCOM_STATUS_PLAYING)はcmucom.cppのplayflag
//   (Play()でtrue、Stop()を呼んだ時だけfalse)をそのまま返すだけで、
//   ループしない曲が末尾に到達しても自動ではfalseにならない
//   (intCountも上限なく増え続ける。tools/verify_mucom_tempo_absolute.mjs等と
//   同じ方法で実測、docs/mucom-tempo-commands.mdの調査と同様に一次資料が
//   無いため実測で確定させた)。そのためこのAPIは使わず、
//   docs/mucom-pchdata-mapping.md §3 で確認済みの PCHDATA.flag bit0
//   (LOOPEND FLAG)と、パートのcode(音程コード)が一定ポーリング回数
//   変化していないことを組み合わせて判定する(html/mucom-app.js
//   checkMucomSongEnded()と同じロジックをここでも実装し、実測で検証する)。
//   bit0単体はループする曲でも最初の1周目で立ってしまう(実測: 本スクリプトの
//   陽性対照参照)ため、「bit0が立ってからもcodeが変化し続けているか」を
//   見て初めてループと非ループを区別できる。
//
// 検証内容:
//   PMD:
//     A. ループしない曲(Lコマンド無し)を再生し続けるとdriver_playingが
//        true->falseへ変わる(=曲が終わったことを検出できる)。
//     B. ループする曲(Lコマンドあり)はdriver_playingが最後までtrueのまま
//        (誤発火しない)。
//   MUCOM88:
//     C. ループしない曲(Lコマンド無し)はcheckMucomSongEnded()相当のロジックが
//        いずれtrueになる。
//     D. ループする曲(Lコマンドあり)は同じ観測時間ではtrueにならない
//        (誤発火しない)。
//     E. [陽性対照] flag bit0単体だけを終了条件にすると、ループする曲でも
//        最初の1周目でtrueになってしまう(=bit0単体では区別できないことの確認。
//        codeの安定性チェックを組み合わせる必要性の証拠)。
//
// 実行: node tools/verify_song_end_detection.mjs

import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import createMucomWeb from '../mucomweb/build-web/mucom88.js';
import { compileMml as compilePmdMml } from '../compiler/pmd_mml_compiler.mjs';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

const SAMPLE_RATE = 55467;

// ---------------------------------------------------------------
// PMD
// ---------------------------------------------------------------
async function measurePmdDriverPlayingSeries(mml, pollSteps, framesPerPoll) {
  const Module = await createPmdWeb();
  const TONES = { 1: { tl: [0, 0, 0, 0], ar: [31, 31, 31, 31], rr: [7, 7, 7, 7], alg: 7, fb: 0 } };
  const { file, errors } = compilePmdMml(mml, { tones: TONES });
  if (errors.length > 0) throw new Error(`PMD compile failed: ${JSON.stringify(errors)}`);
  Module.FS.writeFile('/song_end_probe.m', file);
  const err = Module.playMusic('/song_end_probe.m');
  if (err !== '') throw new Error(`playMusic failed: ${err}`);

  const headerWords = Module.getSnapshotHeaderWordCount();
  check('PMD: SNAPSHOT_HEADER_WORD_COUNTが7(driver_playing追加後)', headerWords === 7,
    `headerWords=${headerWords}`);
  const DRIVER_PLAYING_INDEX = 6;

  const series = [];
  for (let i = 0; i < pollSteps; i++) {
    Module.renderFramesForTest(framesPerPoll);
    const writeIndex = Module.getSnapshotWriteIndex() >>> 0;
    if (writeIndex === 0xffffffff || writeIndex === 0) { series.push(null); continue; }
    const entryBytes = Module.getSnapshotEntryByteSize();
    const ringPtr = Module.getSnapshotRingPointer();
    const idx = (writeIndex - 1) % 2048;
    const base = ringPtr + idx * entryBytes;
    const driverPlaying = Module.HEAP32[base / 4 + DRIVER_PLAYING_INDEX] !== 0;
    series.push(driverPlaying);
  }
  return series;
}

// ---------------------------------------------------------------
// MUCOM88(html/mucom-app.js checkMucomSongEnded()と同じロジック)
// ---------------------------------------------------------------
const MUCOM_CH_COUNT = 11;
const PCH_FIELD_COUNT = 15;
const MUCOM_END_STABLE_POLLS = 3;

function makeMucomEndState() {
  return {
    usedParts: new Set(),
    lastCode: new Array(MUCOM_CH_COUNT).fill(null),
    stableCount: new Array(MUCOM_CH_COUNT).fill(0),
  };
}

function checkMucomSongEnded(state, latestI32, headerWords, requireStable) {
  let anyUsed = false;
  let allEnded = true;
  for (let ch = 0; ch < MUCOM_CH_COUNT; ch++) {
    const base = headerWords + ch * PCH_FIELD_COUNT;
    const code = latestI32[base + 7] & 0xff;
    const flag = latestI32[base + 8] & 0xff;
    if (code !== 0) state.usedParts.add(ch);
    if (!state.usedParts.has(ch)) continue;
    anyUsed = true;
    if (code === state.lastCode[ch]) state.stableCount[ch]++;
    else state.stableCount[ch] = 0;
    state.lastCode[ch] = code;
    const loopEnd = (flag & 1) !== 0;
    const partEnded = requireStable ? (loopEnd && state.stableCount[ch] >= MUCOM_END_STABLE_POLLS) : loopEnd;
    if (!partEnded) allEnded = false;
  }
  return anyUsed && allEnded;
}

async function measureMucomEndedSeries(mml, pollSteps, framesPerPoll, requireStable) {
  const Module = await createMucomWeb();
  Module.compileMML(mml, SAMPLE_RATE);
  const headerWords = Module.getSnapshotHeaderWordCount();
  const state = makeMucomEndState();
  const series = [];
  for (let i = 0; i < pollSteps; i++) {
    Module.renderFramesForTest(framesPerPoll);
    const writeIndex = Module.getSnapshotWriteIndex() >>> 0;
    if (writeIndex === 0xffffffff || writeIndex === 0) { series.push(false); continue; }
    const entryBytes = Module.getSnapshotEntryByteSize();
    const ringPtr = Module.getSnapshotRingPointer();
    const idx = (writeIndex - 1) % 2048;
    const base = ringPtr + idx * entryBytes;
    const i32 = new Int32Array(Module.HEAP32.buffer, base, headerWords + MUCOM_CH_COUNT * PCH_FIELD_COUNT);
    series.push(checkMucomSongEnded(state, i32, headerWords, requireStable));
  }
  return series;
}

async function main() {
  console.log('=== 課題B: 曲終了検出の検証 ===\n');

  // --- A/B. PMD ---
  console.log('--- A/B. PMD: driver_playing (fmdriver_work.playing) ---');
  {
    const nonLooping = await measurePmdDriverPlayingSeries('A t150 @1 o4 l4 cdefgab>c<', 60, 2048);
    const becameFalse = nonLooping.some((v) => v === false);
    check('A. ループしない曲(Lなし)は再生し続けるとdriver_playingがfalseになる', becameFalse,
      `series末尾10件=${JSON.stringify(nonLooping.slice(-10))}`);

    const looping = await measurePmdDriverPlayingSeries('A t150 @1 o4 l4 L cdefgab>c<', 200, 2048);
    const allTrue = looping.every((v) => v === true);
    check('B. ループする曲(Lあり)はdriver_playingが最後までtrueのまま(誤発火しない)', allTrue,
      `false件数=${looping.filter((v) => v === false).length}/${looping.length}`);
  }

  // --- C/D. MUCOM88(安定判定つき、実際にアプリで使うロジック) ---
  console.log('\n--- C/D. MUCOM88: flag bit0 + code安定判定 ---');
  {
    const nonLooping = await measureMucomEndedSeries('A @78 T400 o5 l4 v10 cdefgab>c<', 60, 2048 * 5, true);
    const becameTrue = nonLooping.some((v) => v === true);
    check('C. ループしない曲(Lなし)はいずれ終了判定がtrueになる', becameTrue,
      `series末尾10件=${JSON.stringify(nonLooping.slice(-10))}`);

    const looping = await measureMucomEndedSeries('A @78 T400 o5 l4 v10 L cdefgab>c<', 90, 2048 * 5, true);
    const anyTrue = looping.some((v) => v === true);
    check('D. ループする曲(Lあり)は同じ観測時間では終了判定がtrueにならない(誤発火しない)',
      !anyTrue, `true件数=${looping.filter((v) => v === true).length}/${looping.length}`);
  }

  // --- E. 陽性対照: bit0単体では区別できない ---
  console.log('\n--- E. [陽性対照] flag bit0単体はループする曲でも最初の1周目でtrueになる ---');
  {
    const loopingBitOnly = await measureMucomEndedSeries('A @78 T400 o5 l4 v10 L cdefgab>c<', 30, 2048 * 5, false);
    const anyTrue = loopingBitOnly.some((v) => v === true);
    check('[陽性対照] bit0単体(安定判定なし)はループする曲でもtrueになってしまう(誤検出の再現)',
      anyTrue, `true件数=${loopingBitOnly.filter((v) => v === true).length}/${loopingBitOnly.length}`);
  }

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
