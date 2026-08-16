#!/usr/bin/env node
// トラック行クリックミュート機能: クリック座標 -> トラック行indexへの変換
// (fmdsp/track-click.js)を検証する。
//
// 検証の主眼: FMDSPのcanvasはCSSで拡大縮小されている。getBoundingClientRect()の
// 表示サイズとcanvas内部解像度(640x400)の比を考慮しないと、等倍以外でクリック
// 位置がずれる(等倍でしか試さないと気づけない不具合)。ここでは0.5倍・1.5倍・
// 2倍の3種類の表示倍率で、10行それぞれの中心をクリックしたときに正しい行が
// 返ることを検査する。
//
// 実行: node tools/verify_track_click_hit.mjs

import { canvasPointFromClientClick, trackRowIndexAt } from '../fmdsp/track-click.js';
import { TRACK_H, TRACK_DISP_TABLE_OPNA } from '../fmdsp/trackrow.js';
import { PC98_W, PC98_H } from '../fmdsp/vram.js';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

const ROW_COUNT = TRACK_DISP_TABLE_OPNA.length; // 10
const PANEL_WIDTH = PC98_W / 2; // 320 (トラック行は左半分のみ、docs/fmdsp-layout.md §2)

function simulateClick(scale, canvasX, canvasY) {
  // 内部座標(canvasX, canvasY)を「表示上はscale倍」のCSS px座標へ逆算し、
  // クライアント座標としてcanvasPointFromClientClick()へ渡す。offsetは0とする
  // (rect.left/top=0の単純化。この関数のスコープはスケール変換のみ)。
  const rect = { left: 0, top: 0, width: PC98_W * scale, height: PC98_H * scale };
  const clientX = canvasX * scale;
  const clientY = canvasY * scale;
  const point = canvasPointFromClientClick(clientX, clientY, rect, PC98_W, PC98_H);
  return trackRowIndexAt(point.x, point.y, { trackH: TRACK_H, rowCount: ROW_COUNT, panelWidth: PANEL_WIDTH });
}

console.log('=== トラック行クリック判定(fmdsp/track-click.js)検証 ===\n');
console.log(`TRACK_H=${TRACK_H} ROW_COUNT=${ROW_COUNT} PANEL_WIDTH=${PANEL_WIDTH}\n`);

for (const scale of [1, 0.5, 1.5, 2]) {
  console.log(`--- 表示倍率 x${scale} ---`);
  for (let row = 0; row < ROW_COUNT; row++) {
    const centerX = PANEL_WIDTH / 2;
    const centerY = TRACK_H * row + TRACK_H / 2;
    const result = simulateClick(scale, centerX, centerY);
    check(`x${scale}: 行${row}の中心(canvas座標 ${centerX},${centerY.toFixed(1)}) -> 行${row}`,
      result === row, `result=${result}`);
  }
}

// 等倍でないと壊れることを示す故障注入: スケール変換を無視して素通しした場合
// (旧実装相当)、2倍表示でのクリックはズレて誤った行を指すはずである。
{
  const scale = 2;
  const row = 5;
  const canvasX = PANEL_WIDTH / 2;
  const canvasY = TRACK_H * row + TRACK_H / 2;
  const clientX = canvasX * scale;
  const clientY = canvasY * scale;
  // スケール変換を無視(素通し)した誤り実装を模擬。
  const wrongRow = trackRowIndexAt(clientX, clientY, { trackH: TRACK_H, rowCount: ROW_COUNT, panelWidth: PANEL_WIDTH });
  check('[故障注入] スケール変換を無視すると2倍表示で誤った行になる(検査が効いている確認)',
    wrongRow !== row, `expected!=${row}, got=${wrongRow}`);
}

// パネル外(右半分・canvas外)のクリックは-1を返す。
{
  const rect = { left: 0, top: 0, width: PC98_W, height: PC98_H };
  const point = canvasPointFromClientClick(PANEL_WIDTH + 10, 10, rect, PC98_W, PC98_H);
  const row = trackRowIndexAt(point.x, point.y, { trackH: TRACK_H, rowCount: ROW_COUNT, panelWidth: PANEL_WIDTH });
  check('右半分(x>=320)のクリックは行なし(-1)', row === -1, `row=${row}`);
}
{
  const rect = { left: 0, top: 0, width: PC98_W, height: PC98_H };
  const point = canvasPointFromClientClick(10, TRACK_H * ROW_COUNT + 10, rect, PC98_W, PC98_H);
  const row = trackRowIndexAt(point.x, point.y, { trackH: TRACK_H, rowCount: ROW_COUNT, panelWidth: PANEL_WIDTH });
  check('10行の下側のクリックは行なし(-1)', row === -1, `row=${row}`);
}
// 表示サイズ0(非表示中)はnullを返す。
{
  const rect = { left: 0, top: 0, width: 0, height: 0 };
  const point = canvasPointFromClientClick(10, 10, rect, PC98_W, PC98_H);
  check('rect.width/height<=0 のときnullを返す', point === null);
}

console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
if (failCount > 0) process.exit(1);
