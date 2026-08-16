#!/usr/bin/env node
// 右ペイン FRAMES PER SECOND 実装(fmdsp/rightpane.js createFpsCounter/
// tickFpsCounter)の検証。
//
// 背景: 過去の実測で「自動ブラウザのrAFは0回のことも59.97Hzのこともある」
// (feedback_headless_raf_never_runs.md)ことが分かっているため、ブラウザの
// requestAnimationFrameを信頼して測るのではなく、この検査ではNode上で
// performance.now()相当の合成タイムスタンプ列を自分で作り、
// tickFpsCounter()に食わせて挙動を確認する(=描画ループの呼び出し頻度を
// 数える計算ロジック自体が正しいかの検証。実ブラウザでのrAF発火頻度そのものは
// このスクリプトのスコープ外)。
//
// 検証内容:
//   (a) 60Hz相当(16.67ms間隔)のタイムスタンプを1秒ぶん流すと、fpsが60前後になる
//   (b) 30Hz相当(33.3ms間隔)なら30前後になる
//   (c) 1秒未満しか経過していない間は値が更新されない(前回値を保持する)
//   (d) 呼び出し0回(カウンタを作っただけ)ならvalueは0
//   (e) 0除算・異常値でクラッシュしない: 同一ミリ秒に大量に呼ぶ(elapsed=0が
//       続く)、NaN/Infinityを渡す、時刻が巻き戻る、を故意に注入して例外が
//       出ないこと・戻り値が有限数であることを確認する
//
// 実行: node tools/verify_fps_counter.mjs

import { createFpsCounter, tickFpsCounter } from '../fmdsp/rightpane.js';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

console.log('=== FRAMES PER SECOND カウンタ(fmdsp/rightpane.js)検証 ===\n');

// フレーム間隔intervalMsで、合計durationMsぶんタイムスタンプを進めながら
// tickFpsCounter()を呼び続ける。clockはミュータブルな{now}オブジェクトで、
// 複数回の呼び出しをまたいで単調増加のタイムスタンプを共有する(浮動小数点誤差で
// elapsedがわずかに1000を割り込む取りこぼしが起きないよう、区切りぴったりではなく
// 余裕を持たせたdurationMsを渡すこと)。
function runFor(counter, clock, intervalMs, durationMs) {
  let last = counter.value;
  for (let t = 0; t < durationMs; t += intervalMs) {
    clock.now += intervalMs;
    last = tickFpsCounter(counter, clock.now);
  }
  return last;
}

// (a) 60Hz相当
{
  const counter = createFpsCounter();
  const clock = { now: 0 };
  const last = runFor(counter, clock, 1000 / 60, 1100); // 1.1秒ぶん(浮動小数点誤差の余裕を持たせる)
  console.log(`(a) 60Hz相当: fps=${last}`);
  check('(a) 60Hz相当のタイムスタンプでfpsが55-65の範囲', last >= 55 && last <= 65, `fps=${last}`);
}

// (b) 30Hz相当
{
  const counter = createFpsCounter();
  const clock = { now: 0 };
  const last = runFor(counter, clock, 1000 / 30, 1100);
  console.log(`(b) 30Hz相当: fps=${last}`);
  check('(b) 30Hz相当のタイムスタンプでfpsが27-33の範囲', last >= 27 && last <= 33, `fps=${last}`);
}

// (c) 1秒未満では値が更新されない(前回値を保持)
{
  const counter = createFpsCounter();
  const clock = { now: 0 };
  runFor(counter, clock, 1000 / 60, 1100);
  const settled = counter.value;
  check('(c) 前提: 1.1秒ぶん流した時点でfps値が確定している(0のままではない)', settled > 0, `settled=${settled}`);
  // 同じclockを引き継いでさらに500msぶんだけ進める(次の1秒窓の途中)。
  // fps値は変わらないはず。
  runFor(counter, clock, 1000 / 60, 500);
  check('(c) 1秒未満の経過ではfps値が更新されない(前回値を保持)', counter.value === settled,
    `settled=${settled} after=${counter.value}`);
}

// (d) 呼び出し0回ならvalueは0
{
  const counter = createFpsCounter();
  check('(d) tickFpsCounter未呼び出しの初期値は0', counter.value === 0, `value=${counter.value}`);
}

// (e) 故障系: クラッシュせず有限値を返す
{
  const counter = createFpsCounter();
  let threw = false;
  try {
    // 同一ミリ秒(elapsed=0)を1000回連続で呼ぶ。
    for (let i = 0; i < 1000; i++) tickFpsCounter(counter, 0);
    // NaN/Infinity
    tickFpsCounter(counter, NaN);
    tickFpsCounter(counter, Infinity);
    tickFpsCounter(counter, -Infinity);
    // 時刻が巻き戻る(単調増加が壊れたケース)。
    tickFpsCounter(counter, 5000);
    tickFpsCounter(counter, 1000);
    tickFpsCounter(counter, 500);
  } catch (e) {
    threw = true;
    console.error(e);
  }
  check('(e) 異常な呼び出し列(elapsed=0連発/NaN/Infinity/時刻巻き戻し)で例外が出ない', !threw);
  check('(e) 異常入力後もcounter.valueは有限数のまま', Number.isFinite(counter.value), `value=${counter.value}`);
}

console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
if (failCount > 0) process.exit(1);
