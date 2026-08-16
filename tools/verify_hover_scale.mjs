#!/usr/bin/env node
// ホバー枠機能(利用者指示A)の検証その2:
// 座標→対象の変換を、等倍でない表示倍率(0.5倍・0.934倍・1.5倍)で検査する。
// 利用者指示の実測値「倍率0.934」を含める(canvasはCSSで拡大縮小されるため、
// 表示サイズが内部解像度640x400の整数倍にならない場面が普通にある)。
//
// 座標変換自体はfmdsp/track-click.jsの既存の純粋関数
// (canvasPointFromClientClick)をそのまま使う(新しく書き起こさない。
// tools/verify_track_click_hit.mjsが等倍以外での検証を先例として持っており、
// このスクリプトはその手法をホバー判定(mousemoveの当たり判定)にも適用したもの)。
//
// 実行: node tools/verify_hover_scale.mjs

import { canvasPointFromClientClick, trackRowIndexAt, levelColumnIndexAt } from '../fmdsp/track-click.js';
import { trackRowHoverRect, levelColumnHoverRect } from '../fmdsp/hover.js';
import { TRACK_H, TRACK_DISP_TABLE_OPNA } from '../fmdsp/trackrow.js';
import { PC98_W, PC98_H } from '../fmdsp/vram.js';
import * as rightpane from '../fmdsp/rightpane.js';
import { LEVEL_COLUMN_CHANNELS } from '../fmdsp/channel-mask.js';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

console.log('=== ホバー座標変換、等倍でない表示倍率での検査(fmdsp/hover.js) ===\n');

const TRACK_ROW_HIT_CONFIG = {
  trackH: TRACK_H, rowCount: TRACK_DISP_TABLE_OPNA.length, panelWidth: PC98_W / 2,
};
const LEVEL_COLUMN_HIT_CONFIG = {
  columnX0: rightpane.LEVEL_X, columnW: rightpane.LEVEL_W,
  topY: rightpane.LEVEL_TRACK_Y, bottomY: rightpane.LEVEL_KEY_Y + 8,
  columnCount: LEVEL_COLUMN_CHANNELS.length,
};

// mousemoveハンドラ(html/mucom-app.js・html/pmd-app.js hitTestCanvas/hitTestTrackOrLevel)
// と同じ手順を模擬する: 表示上はscale倍のCSS px座標を、canvasPointFromClientClickで
// 内部解像度座標へ変換してから当たり判定する。
function simulateHover(scale, canvasX, canvasY) {
  const rect = { left: 0, top: 0, width: PC98_W * scale, height: PC98_H * scale };
  const clientX = canvasX * scale;
  const clientY = canvasY * scale;
  const point = canvasPointFromClientClick(clientX, clientY, rect, PC98_W, PC98_H);
  if (!point) return null;
  const row = trackRowIndexAt(point.x, point.y, TRACK_ROW_HIT_CONFIG);
  if (row >= 0) return { kind: 'row', index: row };
  const col = levelColumnIndexAt(point.x, point.y, LEVEL_COLUMN_HIT_CONFIG);
  if (col >= 0) return { kind: 'col', index: col };
  return null;
}

// 利用者指示の実測値0.934を含む3種の非整数倍率。
for (const scale of [0.5, 0.934, 1.5]) {
  console.log(`--- 表示倍率 x${scale} ---`);
  for (let row = 0; row < TRACK_ROW_HIT_CONFIG.rowCount; row++) {
    const centerX = TRACK_ROW_HIT_CONFIG.panelWidth / 2;
    const centerY = TRACK_H * row + TRACK_H / 2;
    const hit = simulateHover(scale, centerX, centerY);
    check(`x${scale}: 行${row}の中心 -> ホバー対象は行${row}`, hit?.kind === 'row' && hit.index === row, `got=${JSON.stringify(hit)}`);
  }
  for (let col = 0; col < LEVEL_COLUMN_HIT_CONFIG.columnCount; col++) {
    const centerX = LEVEL_COLUMN_HIT_CONFIG.columnX0 + LEVEL_COLUMN_HIT_CONFIG.columnW * col + LEVEL_COLUMN_HIT_CONFIG.columnW / 2;
    const centerY = (LEVEL_COLUMN_HIT_CONFIG.topY + LEVEL_COLUMN_HIT_CONFIG.bottomY) / 2;
    const hit = simulateHover(scale, centerX, centerY);
    check(`x${scale}: 列${col}(${LEVEL_COLUMN_CHANNELS[col]})の中心 -> ホバー対象は列${col}`, hit?.kind === 'col' && hit.index === col, `got=${JSON.stringify(hit)}`);
  }
}

// [故障注入] スケール変換を無視(clientX/Yをそのままcanvas座標として使う)した場合、
// 表示倍率が1から離れるほど誤った行になる(等倍でしか試さないと気づけない不具合の
// 再現)。0.934倍はTRACK_H=32pxに対するズレが小さく偶然一致することがあるため、
// ズレが確実に行境界を越える倍率(2倍、tools/verify_track_click_hit.mjsと同じ)で
// 実演する。
{
  const scale = 2;
  const row = 5;
  const canvasX = TRACK_ROW_HIT_CONFIG.panelWidth / 2;
  const canvasY = TRACK_H * row + TRACK_H / 2;
  const clientX = canvasX * scale;
  const clientY = canvasY * scale;
  const wrongRow = trackRowIndexAt(clientX, clientY, TRACK_ROW_HIT_CONFIG); // スケール変換を素通し
  check('[故障注入] スケール変換を無視すると2倍表示で誤った行になる(検査が効いている確認)',
    wrongRow !== row, `expected!=${row}, got=${wrongRow}`);
}

// ホバー矩形自体もscale非依存(常にcanvas内部座標基準)であることの確認。
{
  const rect = trackRowHoverRect(3, TRACK_ROW_HIT_CONFIG);
  check('trackRowHoverRectはcanvas内部座標のまま(scaleを掛けない)', rect.y === TRACK_H * 3 && rect.h === TRACK_H, JSON.stringify(rect));
  const colRect = levelColumnHoverRect(2, LEVEL_COLUMN_HIT_CONFIG);
  check('levelColumnHoverRectはcanvas内部座標のまま(scaleを掛けない)',
    colRect.x === LEVEL_COLUMN_HIT_CONFIG.columnX0 + LEVEL_COLUMN_HIT_CONFIG.columnW * 2, JSON.stringify(colRect));
}

console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
if (failCount > 0) process.exit(1);
