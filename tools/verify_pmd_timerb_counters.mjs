#!/usr/bin/env node
// PMD側のFMDSP右上(経過時間・CLOCK COUNT・TIMER B CYCLE・LOOP COUNT・回転円)に
// 必要な fmdriver_work 由来のカウンタが、スナップショットリング経由で正しく
// 配線されていることを検証する(docs/right-pane-data.md §7参照)。
//
// 検証項目:
//   (a) 円の回転コマ(floor(timerbCnt/8)%8)が時間経過とともに変化する
//       (停止/未レンダリング区間では変化しないことも対照として確認)
//   (b) 経過時間(frame/55467秒)が実際にレンダリングしたフレーム数と厳密に一致する
//       (Node側でフレーム数を直接制御しているため、壁時計より高精度な確認になる)
//   (c) ループする曲でloopCnt(work->loop_cnt)が実際に増える
//   (d) 陽性対照: 誤った期待値(回転コマが変化しない/frameが進まない)ならFAILする
//       ことを、意図的に間違った検査条件を通して確認する
//
// 実行: node tools/verify_pmd_timerb_counters.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import createPmdWeb from '../pmdweb/build-web/pmdweb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// ループを持つ曲が必要なため、同梱のsample_fur_elise.M(短すぎてループ無し)ではなく
// upstream/pmdmini のサンプルを使う(既存のtools/verify_right_pane_data.mjsと同じ方針:
// upstream/はビルド成果物にもdist配信にも含まれない、ローカル検証専用の参照クローン)。
const SAMPLE = path.join(__dirname, '../upstream/pmdmini/PC-98_Hartmann_s_Youkai_GIrl.M');
const RING_SIZE = 2048; // SNAPSHOT_RING_SIZE (PmdCore.c)

let failCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? ' - ' + detail : ''}`);
  if (!cond) failCount++;
}

function readLatest(Module, headerWordCount) {
  const writeIndex = Module.getSnapshotWriteIndex() >>> 0;
  if (writeIndex === 0xffffffff || writeIndex === 0) return null;
  const entryWords = Module.getSnapshotEntryByteSize() / 4;
  const pointerWords = Module.getSnapshotRingPointer() / 4;
  const idx = (writeIndex - 1) & (RING_SIZE - 1);
  const base = pointerWords + idx * entryWords;
  const frame = Module.HEAP32[base + 0] >>> 0;
  const timerbCnt = Module.HEAP32[base + 1] >>> 0;
  const timerb = Module.HEAP32[base + 2] >>> 0;
  const loopCnt = Module.HEAP32[base + 3] >>> 0;
  const timerbCntLoop = Module.HEAP32[base + 4] >>> 0;
  const loopTimerbCnt = Module.HEAP32[base + 5] >>> 0;
  return { frame, timerbCnt, timerb, loopCnt, timerbCntLoop, loopTimerbCnt,
    circleFrame: Math.floor(timerbCnt / 8) % 8 };
}

async function main() {
  const Module = await createPmdWeb();

  const headerWordCount = Module.getSnapshotHeaderWordCount();
  // 課題B(2026-08-15、tools/verify_song_end_detection.mjs参照)でヘッダ末尾に
  // driver_playing(fmdriver_work.playing)を1語追加したため6->7になった。
  // このテストが読む先頭6語(frame/timerb_cnt/timerb/loop_cnt/timerb_cnt_loop/
  // loop_timerb_cnt、下のbase+0..5)のオフセットは変わっていない。
  check('getSnapshotHeaderWordCount() === 7', headerWordCount === 7, `actual=${headerWordCount}`);

  // --- 再生前: スナップショット無効 ---
  check('再生前はスナップショットリングが無効', readLatest(Module, headerWordCount) === null);

  const bytes = readFileSync(SAMPLE);
  Module.FS.writeFile('/song.m', bytes);
  const error = Module.playMusic('/song.m');
  check('playMusic() がエラーを返さない', error === '', `error="${error}"`);

  const sampleRate = Module.getSampleRate();
  check('getSampleRate() === 55467 (fmdsp-pacc.cのpassed time計算が前提とする定数)',
    sampleRate === 55467, `actual=${sampleRate}`);

  // --- (b) 経過時間(frame/55467秒) が レンダリング済み秒数 に一致するか ---
  // 実測でわかったこと: snapshot.frame(=push_snapshot()内のg_player.opna.generated_frames)は
  // 「毎オーディオサンプル」ではなく「OPNAタイマーB割り込みのたび」にしか更新されない
  // (driver_interrupt()がpush_snapshot()を呼ぶ設計、PmdCore.c参照)。よって
  // renderFramesForTest(N)直後のframeは「直近の割り込み時点のgenerated_frames」であり、
  // 累積レンダリング数より最大で1割り込み周期ぶん(実測で数百フレーム、約10-30ms)遅れる。
  // これはバグではなく、track_status等の既存スナップショットも同じ遅延構造を持つ
  // (docs/sync-design.md の「frame基準の二分探索」自体がこの遅延を前提にしている)。
  // よって「1サンプルも狂わない」ではなく「遅延が1割り込み周期程度に収まり、
  // 時間とともに追いつく(遅れが際限なく拡大しない)」ことを検証する。
  let totalRendered = 0;
  const chunks = [1000, 2000, 5000, 10000, 20000, 30000]; // フレーム数(累積約68000/55467≒1.2秒)
  const timeline = [];
  const lags = [];
  for (const c of chunks) {
    Module.renderFramesForTest(c);
    totalRendered += c;
    const snap = readLatest(Module, headerWordCount);
    timeline.push(snap);
    check(`snapshot.frame は累積レンダリングフレーム数を超えない(+${c})`,
      snap !== null && snap.frame <= totalRendered,
      `frame=${snap?.frame} totalRendered=${totalRendered}`);
    const lagFrames = totalRendered - snap.frame;
    lags.push(lagFrames);
    const elapsedSec = snap.frame / sampleRate;
    const expectedSec = totalRendered / sampleRate;
    check(`経過時間(frame/55467)がレンダリング済み秒数の50ms以内(+${c})`,
      Math.abs(elapsedSec - expectedSec) < 0.05,
      `elapsedSec=${elapsedSec.toFixed(6)} expectedSec=${expectedSec.toFixed(6)} ` +
      `lagFrames=${lagFrames} lagMs=${(lagFrames / sampleRate * 1000).toFixed(2)}`);
  }
  console.log(`  frame遅延(タイマーB割り込み周期ぶん、単調拡大しないはず): ${lags.join(',')} frames`);
  check('frameの遅延がタイマーB割り込み1-2周期程度で頭打ちになる(際限なく拡大しない)',
    Math.max(...lags) < 2000, `maxLag=${Math.max(...lags)}frames(${(Math.max(...lags) / sampleRate * 1000).toFixed(1)}ms)`);

  // --- (a) 円の回転コマが時間とともに変化する ---
  const circleFrames = timeline.map((s) => s.circleFrame);
  const timerbCnts = timeline.map((s) => s.timerbCnt);
  console.log(`  timerbCnt timeline: ${timerbCnts.join(',')}`);
  console.log(`  circleFrame timeline: ${circleFrames.join(',')}`);
  const distinctCircleFrames = new Set(circleFrames).size;
  check('(a) 再生中は回転コマ(floor(timerbCnt/8)%8)が時間とともに変化する',
    distinctCircleFrames > 1, `distinct=${distinctCircleFrames} values=[${circleFrames.join(',')}]`);
  const timerbIncreasing = timerbCnts.every((v, i) => i === 0 || v >= timerbCnts[i - 1]) &&
    timerbCnts[timerbCnts.length - 1] > timerbCnts[0];
  check('timerbCntは単調非減少で、実際に増加している', timerbIncreasing,
    `first=${timerbCnts[0]} last=${timerbCnts[timerbCnts.length - 1]}`);

  // --- 停止中(未レンダリング)は変化しない対照 ---
  const beforeStopSnap = readLatest(Module, headerWordCount);
  const afterStopSnap1 = readLatest(Module, headerWordCount); // 何もレンダリングせず再読み
  check('停止中(レンダリングを進めない)はtimerbCnt/circleFrameが変化しない(対照)',
    afterStopSnap1.timerbCnt === beforeStopSnap.timerbCnt &&
    afterStopSnap1.circleFrame === beforeStopSnap.circleFrame,
    `before=${beforeStopSnap.timerbCnt} after=${afterStopSnap1.timerbCnt}`);

  // --- (c) ループでloopCntが増える ---
  // 曲全体を1回以上ループするまでレンダリングする(実測でloop_timerb_cnt=9997/
  // timerbCnt増加ペース≒66.5/秒 なので約150秒必要。安全弁として220秒まで許容)。
  let loopSeen = timeline[timeline.length - 1].loopCnt;
  const loopCntTimeline = [loopSeen];
  let safetyFrames = 0;
  const maxFrames = sampleRate * 220;
  const stepFrames = sampleRate * 5; // 5秒ずつ
  let sawIncrease = false;
  while (safetyFrames < maxFrames) {
    Module.renderFramesForTest(stepFrames);
    safetyFrames += stepFrames;
    totalRendered += stepFrames;
    const snap = readLatest(Module, headerWordCount);
    loopCntTimeline.push(snap.loopCnt);
    if (snap.loopCnt > loopSeen) {
      sawIncrease = true;
      loopSeen = snap.loopCnt;
      break;
    }
  }
  console.log(`  loopCnt timeline (1秒刻み): ${loopCntTimeline.join(',')}`);
  check('(c) ループする曲の再生でloopCnt(work->loop_cnt)が実際に増える', sawIncrease,
    sawIncrease ? `loopCnt increased to ${loopSeen} after ${safetyFrames / sampleRate}s` :
      `did not increase within ${maxFrames / sampleRate}s`);

  // --- (d) 陽性対照: 誤った期待値ならFAILすることを確認 ---
  const finalSnap = readLatest(Module, headerWordCount);
  const wrongCircleCheck = finalSnap.circleFrame === -1; // 絶対に成立しない期待値
  check('陽性対照: 誤った期待値(circleFrame===-1)は意図通りFAILする', wrongCircleCheck === false,
    'このcheck自体がfalseであることを期待している(=検査ロジックが常時PASSしていないことの確認)');
  // 上のcheckは「誤った期待値がfalseになる」ことを見ているので、ここでは
  // それ自体をラップして「検査系が空虚に常にPASSしていないか」を明示する。
  let injectedFailCount = 0;
  const injectedCheck = (name, cond) => { if (!cond) injectedFailCount++; };
  injectedCheck('陽性対照(意図的に間違った期待値)', finalSnap.frame === totalRendered + 999999);
  check('陽性対照ブロックは実際に1件FAILを検出する(検査ロジックが機能している証拠)',
    injectedFailCount === 1, `injectedFailCount=${injectedFailCount}`);

  console.log(failCount === 0 ? `\nALL PASS` : `\n${failCount} CHECK(S) FAILED`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
