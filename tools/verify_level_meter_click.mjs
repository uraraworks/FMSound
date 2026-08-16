#!/usr/bin/env node
// レベルメータークリックミュート機能: クリック座標 -> レベルメーター列indexへの
// 変換(fmdsp/track-click.js levelColumnIndexAt)を検証する。
//
// tools/verify_track_click_hit.mjs と同じ主眼: canvasの表示倍率(CSS px vs
// 内部解像度640x400)を考慮しないと、等倍以外の表示でクリック位置がずれる。
// ここでは0.5倍・1.5倍・2倍の3種類の表示倍率で、クリック対象列(FM1-6,SSG1-3,
// RHYTHM,ADPCM の11列)それぞれの中心をクリックしたときに正しい列が返ることを
// 検査する。PPZ8列(11-18)はマスク非対応につきクリック対象外であることも確認する。
//
// 実行: node tools/verify_level_meter_click.mjs

import { canvasPointFromClientClick, levelColumnIndexAt } from '../fmdsp/track-click.js';
import { LEVEL_X, LEVEL_W, LEVEL_TRACK_Y, LEVEL_KEY_Y } from '../fmdsp/rightpane.js';
import { LEVEL_COLUMN_CHANNELS, channelForLevelColumn } from '../fmdsp/channel-mask.js';
import { PC98_W, PC98_H } from '../fmdsp/vram.js';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

const COLUMN_COUNT = LEVEL_COLUMN_CHANNELS.length; // 11 (FM1-6,SSG1-3,RHYTHM,ADPCM)
const TOP_Y = LEVEL_TRACK_Y;
const BOTTOM_Y = LEVEL_KEY_Y + 8;

function simulateClick(scale, canvasX, canvasY) {
  const rect = { left: 0, top: 0, width: PC98_W * scale, height: PC98_H * scale };
  const clientX = canvasX * scale;
  const clientY = canvasY * scale;
  const point = canvasPointFromClientClick(clientX, clientY, rect, PC98_W, PC98_H);
  return levelColumnIndexAt(point.x, point.y, {
    columnX0: LEVEL_X, columnW: LEVEL_W, topY: TOP_Y, bottomY: BOTTOM_Y, columnCount: COLUMN_COUNT,
  });
}

console.log('=== レベルメータークリック判定(fmdsp/track-click.js)検証 ===\n');
console.log(`LEVEL_X=${LEVEL_X} LEVEL_W=${LEVEL_W} COLUMN_COUNT=${COLUMN_COUNT} topY=${TOP_Y} bottomY=${BOTTOM_Y}\n`);

for (const scale of [1, 0.5, 1.5, 2]) {
  console.log(`--- 表示倍率 x${scale} ---`);
  for (let col = 0; col < COLUMN_COUNT; col++) {
    const centerX = LEVEL_X + LEVEL_W * col + LEVEL_W / 2;
    const centerY = (TOP_Y + BOTTOM_Y) / 2;
    const result = simulateClick(scale, centerX, centerY);
    const channel = channelForLevelColumn(col);
    check(`x${scale}: 列${col}(${channel})の中心 -> 列${col}`, result === col, `result=${result}`);
  }
}

// 故障注入: スケール変換を無視すると2倍表示でズレることを確認する。
{
  const scale = 2;
  const col = 5;
  const canvasX = LEVEL_X + LEVEL_W * col + LEVEL_W / 2;
  const canvasY = (TOP_Y + BOTTOM_Y) / 2;
  const clientX = canvasX * scale;
  const clientY = canvasY * scale;
  const wrongCol = levelColumnIndexAt(clientX, clientY, {
    columnX0: LEVEL_X, columnW: LEVEL_W, topY: TOP_Y, bottomY: BOTTOM_Y, columnCount: COLUMN_COUNT,
  });
  check('[故障注入] スケール変換を無視すると2倍表示で誤った列になる(検査が効いている確認)',
    wrongCol !== col, `expected!=${col}, got=${wrongCol}`);
}

// PPZ8列(11-18)はクリック対象外(channelForLevelColumnがundefined、かつ
// levelColumnIndexAt自体もcolumnCount=11で弾く)。
{
  const col = 12; // PPZ8のどこか
  const centerX = LEVEL_X + LEVEL_W * col + LEVEL_W / 2;
  const centerY = (TOP_Y + BOTTOM_Y) / 2;
  const result = simulateClick(1, centerX, centerY);
  check('PPZ8列(11-18)はクリック対象外(-1)', result === -1, `result=${result}`);
  check('channelForLevelColumn(PPZ8列)はundefined(マスク組み立て非対応)',
    channelForLevelColumn(col) === undefined, `got=${channelForLevelColumn(col)}`);
}

// 縦方向の範囲外(ラベル行より上/KEY行より下)は-1。
{
  const centerX = LEVEL_X + LEVEL_W * 0 + LEVEL_W / 2;
  const resultAbove = simulateClick(1, centerX, TOP_Y - 5);
  const resultBelow = simulateClick(1, centerX, BOTTOM_Y + 5);
  check('列の上端より上のクリックは-1', resultAbove === -1, `result=${resultAbove}`);
  check('列の下端より下のクリックは-1', resultBelow === -1, `result=${resultBelow}`);
}

// LEVEL_COLUMN_CHANNELSの並びがRHYTHM(index9)を含むことの確認(タスクB要求の核心)。
check('LEVEL_COLUMN_CHANNELS[9] === "RHYTHM"(リズムがクリック対象に含まれる)',
  LEVEL_COLUMN_CHANNELS[9] === 'RHYTHM', `got=${LEVEL_COLUMN_CHANNELS[9]}`);

console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
if (failCount > 0) process.exit(1);
