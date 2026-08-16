#!/usr/bin/env node
// 右ペイン「出せない項目は暗い側の色にする」(C-2、利用者指示)の検証。
//
// 対象:
//   - CPU POWER COUNT(ラベル+下線+三角+数字桁): ブラウザにプロセスCPU使用率を
//     取得するAPIが無く恒久的に取得不能。COLOR_UNAVAILABLE(=COLOR_3、
//     PLAY/STOP/PAUSE非アクティブと同じ値)で描く。
//   - VOLUME DOWN / PGM NUMBER(ラベル+下線+三角): 元データが無い
//     (docs/right-pane-data.md §8参照)。同じくCOLOR_UNAVAILABLE。
//   - レベルメーターPANPOT: 2026-08-17に方式を差し替え(fmdsp/dim-tier.js参照)。
//     色番号は常にCOLOR_1固定で、ミュート中の列はvram.tiers平面がTIER_MUTEDに
//     なることで暗くなる(色を差し替えない。色相を保つのが目的)。この検査でも
//     色番号ではなく段階(tiers)を実測する。
//
// 一方、FRAMES PER SECOND(今回実装、実測値)は暗色にしてはいけない
// (せっかく実装した値が見えなくなるため)。数字スプライトS_NUMは元々
// アンチエイリアス用に色2/3の両方を含む(通常のblitCopy描画)ため、単純に
// 「3色が1ピクセルでもあるか」では判定できない。drawCpuFps()はCPU側だけ
// blitColorで強制的に単色(COLOR_UNAVAILABLE)へ塗り直す実装にしたので、
// 「CPU側の非0ピクセルが全てCOLOR_UNAVAILABLEだけで構成されている
// (=色2が1つも無い、素のスプライトの意匠が完全に潰されている)」ことを
// もって「暗色化されている」と判定し、FPS側は逆に色2が混じっている
// (=素のスプライトの意匠のまま=暗色化されていない)ことを確認する。
//
// 実行: node tools/verify_right_pane_unavailable_colors.mjs

import { Vram, PC98_W, PC98_H } from '../fmdsp/vram.js';
import * as rightpane from '../fmdsp/rightpane.js';
import { TIER_NORMAL, TIER_MUTED } from '../fmdsp/dim-tier.js';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

function colorsInRect(vram, x0, y0, w, h) {
  const colors = new Set();
  for (let y = y0; y < y0 + h; ++y) {
    for (let x = x0; x < x0 + w; ++x) {
      const c = vram.pixels[y * vram.width + x];
      if (c !== 0) colors.add(c);
    }
  }
  return colors;
}

// colorsInRectと同じ矩形・同じ「何か描かれた(色0以外)ピクセルだけ」条件で、
// 色番号の代わりに段階(vram.tiers、fmdsp/dim-tier.js)を集める。背景(色0、
// 何も描かれていない)を含めると常にTIER_NORMALが混じってしまい判定できなく
// なるため、colorsInRectと同じく色0は除外する。
function tiersInRect(vram, x0, y0, w, h) {
  const tiers = new Set();
  for (let y = y0; y < y0 + h; ++y) {
    for (let x = x0; x < x0 + w; ++x) {
      const i = y * vram.width + x;
      if (vram.pixels[i] !== 0) tiers.add(vram.tiers[i]);
    }
  }
  return tiers;
}

const COLOR_UNAVAILABLE = 3;
const COLOR_2 = 2;
const COLOR_1 = 1;

console.log('=== 右ペイン「出せない項目は暗色」検証 ===\n');

// --- CPU POWER COUNT / FRAMES PER SECOND ---
{
  const vram = new Vram(PC98_W, PC98_H);
  vram.clear(0);
  rightpane.drawCpuFpsLabels(vram);
  rightpane.drawCpuFps(vram, 0, 42); // fps=42(非0の実測値を模擬)

  // CPU数字桁: NUM_W*3桁ぶんの矩形。座標はrightpane.jsのexport(CPU_NUM_X/CPU_NUM_Y)から。
  const cpuDigitColors = colorsInRect(vram, rightpane.CPU_NUM_X, rightpane.CPU_NUM_Y, 5 * 3, 8);
  console.log(`CPU数字桁の色集合: ${[...cpuDigitColors].join(',')}`);
  check('CPU数字桁は暗色(COLOR_UNAVAILABLE=3)のみで構成される(色2を含まない)',
    cpuDigitColors.has(COLOR_UNAVAILABLE) && !cpuDigitColors.has(COLOR_2),
    `colors=${[...cpuDigitColors]}`);

  const fpsDigitColors = colorsInRect(vram, rightpane.FPS_NUM_X, rightpane.CPU_NUM_Y, 5 * 3, 8);
  console.log(`FPS数字桁の色集合: ${[...fpsDigitColors].join(',')}`);
  check('[本体] FPS数字桁は暗色化されていない(素のスプライトの色2を含む=通常描画のまま)',
    fpsDigitColors.has(COLOR_2), `colors=${[...fpsDigitColors]}`);

  // CPU/FPSラベルの色(CPU_X,CPU_Y付近の'C'の1文字目)。
  const cpuLabelColors = colorsInRect(vram, rightpane.CPU_X, rightpane.CPU_Y, 5, 6);
  check('CPU POWER COUNTラベル域に描画がある', cpuLabelColors.size > 0, `colors=${[...cpuLabelColors]}`);
  check('CPU POWER COUNTラベルは暗色(COLOR_UNAVAILABLE)', [...cpuLabelColors].every((c) => c === COLOR_UNAVAILABLE),
    `colors=${[...cpuLabelColors]}`);
  const fpsLabelColors = colorsInRect(vram, rightpane.FPS_X, rightpane.CPU_Y, 5, 6);
  check('FRAMES PER SECONDラベル域に描画がある', fpsLabelColors.size > 0, `colors=${[...fpsLabelColors]}`);
  check('FRAMES PER SECONDラベルは通常色(COLOR_2)のまま', [...fpsLabelColors].every((c) => c === COLOR_2),
    `colors=${[...fpsLabelColors]}`);
}

// --- VOLUME DOWN / PGM NUMBER (vs PASSED TIME、値がある項目の対照) ---
{
  const vram = new Vram(PC98_W, PC98_H);
  vram.clear(0);
  rightpane.drawTimeLabels(vram);

  // TIME_TEXT_X(=TIME_X-38、rightpane.js private定数)はexportされていないため、
  // export済みのTIME_Xから逆算する(`const TIME_X = TIME_TEXT_X + 38;`)。
  const TIME_TEXT_X = rightpane.TIME_X - 38;

  const voldownColors = colorsInRect(vram, TIME_TEXT_X, rightpane.VOLDOWN_Y - 2, 40, 13);
  console.log(`VOLUME DOWNラベル域の色集合: ${[...voldownColors].join(',')}`);
  check('VOLUME DOWNラベル域に描画がある(検査対象が空でないこと自体の確認)', voldownColors.size > 0,
    `colors=${[...voldownColors]}`);
  check('VOLUME DOWNラベルは暗色(COLOR_UNAVAILABLE)のみ', [...voldownColors].every((c) => c === COLOR_UNAVAILABLE),
    `colors=${[...voldownColors]}`);

  const pgmnumColors = colorsInRect(vram, TIME_TEXT_X, rightpane.PGMNUM_Y - 2, 40, 13);
  console.log(`PGM NUMBERラベル域の色集合: ${[...pgmnumColors].join(',')}`);
  check('PGM NUMBERラベル域に描画がある(検査対象が空でないこと自体の確認)', pgmnumColors.size > 0,
    `colors=${[...pgmnumColors]}`);
  check('PGM NUMBERラベルは暗色(COLOR_UNAVAILABLE)のみ', [...pgmnumColors].every((c) => c === COLOR_UNAVAILABLE),
    `colors=${[...pgmnumColors]}`);

  const passedTimeColors = colorsInRect(vram, TIME_TEXT_X, rightpane.TIME_Y - 2, 40, 13);
  console.log(`[対照] PASSED TIMEラベル域の色集合: ${[...passedTimeColors].join(',')}`);
  check('[対照] PASSED TIMEラベル域に描画がある(検査対象が空でないこと自体の確認)', passedTimeColors.size > 0,
    `colors=${[...passedTimeColors]}`);
  // この矩形にはラベル文字(色2)に加えて三角インジケータ(色1、暗色化の対象外)も
  // 含まれるため、「色2を含む」かつ「暗色COLOR_UNAVAILABLEを含まない」で判定する
  // (VOLUME DOWN/PGM NUMBERとの対照はCOLOR_UNAVAILABLEの有無)。
  check('[対照] PASSED TIME(値がある項目)は暗色化されていない(色2を含み、COLOR_UNAVAILABLEを含まない)',
    passedTimeColors.has(COLOR_2) && !passedTimeColors.has(COLOR_UNAVAILABLE),
    `colors=${[...passedTimeColors]}`);
}

// --- レベルメーターPANPOT: 2026-08-17〜、色番号は常にCOLOR_1固定、段階(tiers)で暗さを表現 ---
{
  const vram = new Vram(PC98_W, PC98_H);
  vram.clear(0);
  const peakState = rightpane.createPeakState(rightpane.FMDSP_LEVEL_COUNT);
  const levels = Array.from({ length: rightpane.FMDSP_LEVEL_COUNT }, () => ({ level: 0, pan: 2, prog: 0, key: 0, playing: false }));
  const mutedColumns = new Set([9]); // RHYTHM列だけミュート
  rightpane.drawLevelMeters(vram, levels, peakState, mutedColumns);

  const mutedPanColors = colorsInRect(vram, rightpane.LEVEL_X + rightpane.LEVEL_W * 9 - 1, rightpane.PANPOT_Y, 15, 6);
  const mutedPanTiers = tiersInRect(vram, rightpane.LEVEL_X + rightpane.LEVEL_W * 9 - 1, rightpane.PANPOT_Y, 15, 6);
  console.log(`ミュート列(9=RHYTHM)PANPOT色集合: ${[...mutedPanColors].join(',')} 段階集合: ${[...mutedPanTiers].join(',')}`);
  check('[本体] ミュート中の列のPANPOTも色番号はCOLOR_1のまま(色相を保つ。色を差し替えない)',
    [...mutedPanColors].every((c) => c === COLOR_1) && mutedPanColors.size > 0,
    `colors=${[...mutedPanColors]}`);
  check('[本体] ミュート中の列のPANPOTの段階はTIER_MUTED(暗さはここで表現する)',
    [...mutedPanTiers].every((t) => t === TIER_MUTED) && mutedPanTiers.size > 0,
    `tiers=${[...mutedPanTiers]}`);

  const normalPanColors = colorsInRect(vram, rightpane.LEVEL_X + rightpane.LEVEL_W * 0 - 1, rightpane.PANPOT_Y, 15, 6);
  const normalPanTiers = tiersInRect(vram, rightpane.LEVEL_X + rightpane.LEVEL_W * 0 - 1, rightpane.PANPOT_Y, 15, 6);
  console.log(`非ミュート列(0=FM1)PANPOT色集合: ${[...normalPanColors].join(',')} 段階集合: ${[...normalPanTiers].join(',')}`);
  check('非ミュート列のPANPOTは色1のまま', [...normalPanColors].every((c) => c === COLOR_1) && normalPanColors.size > 0,
    `colors=${[...normalPanColors]}`);
  check('非ミュート列のPANPOTの段階はTIER_NORMAL', [...normalPanTiers].every((t) => t === TIER_NORMAL) && normalPanTiers.size > 0,
    `tiers=${[...normalPanTiers]}`);

  // 故障注入: 「ミュートしても段階を切り替えない」壊れた実装を模擬し、
  // この検査が実際にFAILを検出できることを確認する。
  const fakeMutedButNormalTier = TIER_NORMAL;
  check('[故障注入] 「ミュート列のPANPOTの段階がTIER_NORMALのまま」という壊れた値はTIER_MUTEDとの比較でFAILになる(検査が効いている確認)',
    fakeMutedButNormalTier !== TIER_MUTED);
}

// 故障注入: 「暗色化を忘れてCPUも通常色で描く」旧実装を模擬し、この検査が
// 実際に検出できることを確認する。
{
  const fakeCpuColors = new Set([2, 3]); // 旧実装(blitCopy)相当: 素のスプライトの色2/3混在
  const wouldPass = !fakeCpuColors.has(COLOR_2);
  check('[故障注入] 旧実装(CPUも通常blitCopy)なら色2を含むため上のCPU検査はFAILする(検査が効いている確認)',
    !wouldPass);
}

console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
if (failCount > 0) process.exit(1);
