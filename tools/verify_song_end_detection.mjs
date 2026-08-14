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
//   stopPlayback()(頭出し停止)を呼ぶ。この機構は今も有効(下記E参照)。
//
// MUCOM88側(2026-08-15: 自動終了検出そのものを撤去した。撤去の経緯を記録):
//   実測で判明: GetStatus(MUCOM_STATUS_PLAYING)はcmucom.cppのplayflag
//   (Play()でtrue、Stop()を呼んだ時だけfalse)をそのまま返すだけで、
//   ループしない曲が末尾に到達しても自動ではfalseにならない。そのため
//   代わりに docs/mucom-pchdata-mapping.md §3 の PCHDATA.flag bit0
//   (LOOPEND FLAG)と、パートのcode(音程コード)が一定ポーリング回数
//   変化していないことを組み合わせた判定(html/mucom-app.js
//   checkMucomSongEnded()、2026-08-14実装)を一度は採用した。
//
//   しかし2026-08-15、実機報告(同梱サンプルのループ曲が約6.5秒で止まる)を
//   受けて**実物の2パートMML(tools/sample_fur_elise_mucom.mml)で再測定した
//   ところ、bit0は「authored MMLデータの末尾に到達した」時点で一度立つと、
//   ループが継続していても二度と下がらないと判明した**。つまりbit0は
//   ループ点と曲の終了を区別する情報を最初から持っておらず、code安定判定を
//   組み合わせても「休符・同音連打で3ポーリング以上codeが変わらない瞬間」に
//   誤発火してしまう(下記F参照)。以前の検証(単純な単音階の合成MML、
//   休符・和音・複数パート無し)がこれを再現できなかったのは、実物の楽曲を
//   使っていなかったため(下記Fが実物での再測定)。
//
//   結論: 手元のPCHDATAからMUCOM88の信頼できる終了検出は組み立てられない。
//   「ループする曲が途中で止まる」方が「ループしない曲が終了後に鳴り続ける」
//   より明確に害が大きいため、MUCOM88側の自動停止機能そのものを撤去し、
//   利用者が手動でStopを押す従来の挙動に戻した(html/mucom-app.js。
//   docs/transport-button-state.md 症状⑧)。PMD側はfmdriver_work.playingという
//   ドライバ本体の専用フラグを使っており、この問題(ループ点と終了の区別が
//   できない)は起きないため撤去していない。
//
// 検証内容:
//   A. PMD: ループしない曲(Lコマンド無し)を再生し続けるとdriver_playingが
//      true->falseへ変わる(=曲が終わったことを検出できる)。
//   B. PMD: ループする曲(Lコマンドあり)はdriver_playingが最後までtrueのまま
//      (誤発火しない)。短いサンプル相当の周期でも確認する。
//   C. MUCOM88: html/mucom-app.js に自動終了検出の呼び出し
//      (checkMucomSongEnded/resetMucomEndState、rAFループでのstopPlayback()
//      自動呼び出し)が存在しないこと(撤去が実際に行われ、再発していないことの
//      構造的な確認)。
//   D. MUCOM88: 手動Stop(Module.stopMusic())自体は引き続き機能すること
//      (撤去したのは自動検出だけで、手動操作を壊していないことの確認)。
//   E. [陽性対照/実物] 撤去前のロジック(bit0 + codeの安定判定)を実際の
//      同梱サンプル(sample_fur_elise_mucom.mml、2パート・休符あり)で
//      再現すると、ループの折り返し付近で誤ってtrueになる(=撤去の根拠が
//      実測で裏付けられることの確認。合成MMLではなく実物を使う)。
//
// 実行: node tools/verify_song_end_detection.mjs

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import createMucomWeb from '../mucomweb/build-web/mucom88.js';
import { compileMml as compilePmdMml } from '../compiler/pmd_mml_compiler.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

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
// MUCOM88: 撤去前のロジック(html/mucom-app.jsにはもう存在しない。ここには
// 「なぜ撤去したか」を実物のMMLで裏付けるためだけに残す、独立した再現実装)。
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

  // --- C/D. MUCOM88: 自動終了検出が実際に撤去されていることの構造チェック ---
  console.log('\n--- C/D. MUCOM88: 自動終了検出の撤去確認 ---');
  {
    const mucomSrc = readFileSync(path.join(REPO_ROOT, 'html/mucom-app.js'), 'utf8');
    check('C. checkMucomSongEnded/resetMucomEndStateの呼び出しがhtml/mucom-app.jsに存在しない',
      !/checkMucomSongEnded\(|resetMucomEndState\(/.test(mucomSrc));
    check('D. 手動停止(Module.stopMusic())の呼び出しは引き続き存在する(撤去したのは自動検出だけ)',
      /Module\.stopMusic\(\)/.test(mucomSrc));
  }

  // --- E. 陽性対照(実物): 撤去前ロジックを実際のサンプルMMLで再現すると誤発火する ---
  console.log('\n--- E. [陽性対照/実物] 撤去前ロジックはsample_fur_elise_mucom.mmlで誤発火する ---');
  {
    const realMml = readFileSync(path.join(REPO_ROOT, 'tools/sample_fur_elise_mucom.mml'), 'utf8');
    // 1周あたり約6.5秒(利用者報告どおり)。framesPerPoll=2048@55467Hz(≒37ms/poll)で
    // pollSteps=260なら約9.6秒分、1周目の終わり〜2周目突入までをカバーする。
    const series = await measureMucomEndedSeries(realMml, 260, 2048, true);
    const trueCount = series.filter((v) => v === true).length;
    check('[陽性対照/実物] 実際の同梱MML(2パート・休符あり)ではループ中に誤ってtrueになる',
      trueCount > 0, `true件数=${trueCount}/${series.length}(このロジックはhtml/mucom-app.jsには存在しない)`);
  }

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
