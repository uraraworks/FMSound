#!/usr/bin/env node
// ホバー枠機能(利用者指示A)の検証: ホバー枠の色(fmdsp/hover.js COLOR_HOVER)が、
// 枠を描く領域(トラック行/レベルメーター列の外周)で既存の描画と同化せず、実際に
// 視認できる変化として現れることを検査する。
//
// 背景(実機で踏んだ不具合): 最初COLOR_HOVER=index4を選んだが、fmdsp/sprites.js
// S_KEY_BG(鍵盤地板、白鍵)がindex4で焼き込まれており、トラック行の枠は鍵盤帯と
// 重なるため、白鍵の上では枠を描いても既存のindex4ピクセルと同化して変化が
// 見えなかった(putImageDataしたcanvasの実ピクセルを読み出して発覚。色の存在有無
// だけを見る検査では検出できない不具合だった)。
//
// 検査方法: 「ホバー無し」と「ホバー有り」の2回、同じ行/列を実際に
// fmdsp/trackrow.js drawTrackRows() / fmdsp/rightpane.js drawLevelMeters() +
// fmdsp/hover.js drawHoverOutline() で描画し、枠の外周ピクセルが
// 「ホバー無しの時点でCOLOR_HOVERで無かった」かつ「ホバー有りの時点でCOLOR_HOVER
// になった」の両方を満たすことを1px単位で確認する。前者が崩れていれば
// 「元から同じ色で、枠を描いても変化なし」の再発を検出できる。
//
// 実行: node tools/verify_hover_color_visibility.mjs

import { Vram, PC98_W, PC98_H } from '../fmdsp/vram.js';
import { drawTrackRows, createIdleEntryTracks, TRACK_H, TRACK_DISP_TABLE_OPNA } from '../fmdsp/trackrow.js';
import * as rightpane from '../fmdsp/rightpane.js';
import { trackRowHoverRect, levelColumnHoverRect, drawHoverOutline, COLOR_HOVER } from '../fmdsp/hover.js';
import { LEVEL_COLUMN_CHANNELS } from '../fmdsp/channel-mask.js';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

console.log('=== ホバー枠の色が既存描画と同化しないことの検査(fmdsp/hover.js) ===\n');

const TRACK_ROW_HIT_CONFIG = { trackH: TRACK_H, rowCount: TRACK_DISP_TABLE_OPNA.length, panelWidth: PC98_W / 2 };
const LEVEL_COLUMN_HIT_CONFIG = {
  columnX0: rightpane.LEVEL_X, columnW: rightpane.LEVEL_W,
  topY: rightpane.LEVEL_TRACK_Y, bottomY: rightpane.LEVEL_KEY_Y + 8,
  columnCount: LEVEL_COLUMN_CHANNELS.length,
};

function perimeterPoints(rect) {
  const { x, y, w, h } = rect;
  const points = [];
  for (let xx = x; xx < x + w; xx++) { points.push([xx, y]); points.push([xx, y + h - 1]); }
  for (let yy = y; yy < y + h; yy++) { points.push([x, yy]); points.push([x + w - 1, yy]); }
  return points;
}

function renderIdleScene() {
  const vram = new Vram(PC98_W, PC98_H);
  vram.clear(0);
  rightpane.drawStaticDecorations(vram, ['26', '08', '16'], 'MUCOM88');
  drawTrackRows(vram, null, createIdleEntryTracks());
  // レベルメーターも「典型的な値」で描いておく(0だと背景色のままで検査にならない)。
  const levels = Array.from({ length: rightpane.FMDSP_LEVEL_COUNT }, () => ({ level: 20, pan: 2, prog: 1, key: 0x44, playing: true }));
  const peakState = rightpane.createPeakState(rightpane.FMDSP_LEVEL_COUNT);
  rightpane.drawLevelMeters(vram, levels, peakState);
  return vram;
}

// --- トラック行10行すべてで検査 ---
for (let row = 0; row < TRACK_ROW_HIT_CONFIG.rowCount; row++) {
  const before = renderIdleScene();
  const rect = trackRowHoverRect(row, TRACK_ROW_HIT_CONFIG);
  const points = perimeterPoints(rect);
  const alreadyHoverColor = points.filter(([x, y]) => before.pixels[y * before.width + x] === COLOR_HOVER);
  check(`行${row}: ホバー無しの時点で枠の外周にCOLOR_HOVER(${COLOR_HOVER})のピクセルが無い(=既存描画と衝突しない)`,
    alreadyHoverColor.length === 0, `衝突数=${alreadyHoverColor.length}/${points.length}`);

  const after = renderIdleScene();
  drawHoverOutline(after, rect, COLOR_HOVER);
  const nowHoverColor = points.filter(([x, y]) => after.pixels[y * after.width + x] === COLOR_HOVER);
  check(`行${row}: ホバー有りの時点で枠の外周が全てCOLOR_HOVERになる`,
    nowHoverColor.length === points.length, `一致数=${nowHoverColor.length}/${points.length}`);
}

// --- レベルメーター列11列すべてで検査 ---
for (let col = 0; col < LEVEL_COLUMN_HIT_CONFIG.columnCount; col++) {
  const before = renderIdleScene();
  const rect = levelColumnHoverRect(col, LEVEL_COLUMN_HIT_CONFIG);
  const points = perimeterPoints(rect);
  const alreadyHoverColor = points.filter(([x, y]) => before.pixels[y * before.width + x] === COLOR_HOVER);
  check(`列${col}(${LEVEL_COLUMN_CHANNELS[col]}): ホバー無しの時点で枠の外周にCOLOR_HOVERのピクセルが無い`,
    alreadyHoverColor.length === 0, `衝突数=${alreadyHoverColor.length}/${points.length}`);

  const after = renderIdleScene();
  drawHoverOutline(after, rect, COLOR_HOVER);
  const nowHoverColor = points.filter(([x, y]) => after.pixels[y * after.width + x] === COLOR_HOVER);
  check(`列${col}(${LEVEL_COLUMN_CHANNELS[col]}): ホバー有りの時点で枠の外周が全てCOLOR_HOVERになる`,
    nowHoverColor.length === points.length, `一致数=${nowHoverColor.length}/${points.length}`);
}

// [陽性対照] わざと壊す: 実際に踏んだ不具合(COLOR_HOVER=4、鍵盤白鍵と同化)を
// 再現し、この検査が「ホバー無しの時点で衝突ゼロ」をFAILさせることを確認する。
{
  const BROKEN_COLOR_HOVER = 4; // S_KEY_BGが焼き込んでいる色(実際に踏んだ不具合)
  const before = renderIdleScene();
  const rect = trackRowHoverRect(0, TRACK_ROW_HIT_CONFIG);
  const points = perimeterPoints(rect);
  const collision = points.filter(([x, y]) => before.pixels[y * before.width + x] === BROKEN_COLOR_HOVER).length;
  check('[陽性対照] COLOR_HOVER=4(旧選定)だと鍵盤白鍵と衝突する(検査が実際に不具合を検出する確認)',
    collision > 0, `衝突数=${collision}/${points.length}`);
}

console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
if (failCount > 0) process.exit(1);
