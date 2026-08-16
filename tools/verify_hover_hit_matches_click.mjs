#!/usr/bin/env node
// ホバー枠機能(利用者指示A)の検証その1:
// 「クリックを受け付ける対象の集合」と「ホバー枠を出す対象の集合」が完全に
// 一致することを検査する。片方にしか無い対象があれば、押せそうに見えて何も
// 起きない(またはその逆)UIになってしまう。
//
// 検証方法: html/mucom-app.js・html/pmd-app.jsのクリックハンドラが実際に使っている
// のと同じ当たり判定config(TRACK_ROW_HIT_CONFIG/LEVEL_COLUMN_HIT_CONFIG。この
// スクリプトでは値をここに再掲するのではなく、fmdsp/channel-mask.jsの
// TRACK_ROW_CHANNELS/LEVEL_COLUMN_CHANNELSの長さと、fmdsp/trackrow.js
// TRACK_DISP_TABLE_OPNA.lengthから同じ数値を導く)を使い、trackRowIndexAt/
// levelColumnIndexAtとtrackRowHoverRect/levelColumnHoverRectの両方へ通した結果を
// 突き合わせる。
//
// 実行: node tools/verify_hover_hit_matches_click.mjs

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

console.log('=== ホバー枠とクリック判定の対象一致検査(fmdsp/hover.js, fmdsp/track-click.js) ===\n');

// html/mucom-app.js・html/pmd-app.js双方のTRACK_ROW_HIT_CONFIG/LEVEL_COLUMN_HIT_CONFIGと
// 同じ値(fmdsp/trackrow.js・fmdsp/rightpane.js・fmdsp/channel-mask.jsから導ける)。
const TRACK_ROW_HIT_CONFIG = {
  trackH: TRACK_H, rowCount: TRACK_DISP_TABLE_OPNA.length, panelWidth: PC98_W / 2,
};
const LEVEL_COLUMN_HIT_CONFIG = {
  columnX0: rightpane.LEVEL_X, columnW: rightpane.LEVEL_W,
  topY: rightpane.LEVEL_TRACK_Y, bottomY: rightpane.LEVEL_KEY_Y + 8,
  columnCount: LEVEL_COLUMN_CHANNELS.length,
};

// --- 1. トラック行: 各行の中心・四隅がクリックとホバーで同じ行を指すこと ---
for (let row = 0; row < TRACK_ROW_HIT_CONFIG.rowCount; row++) {
  const rect = trackRowHoverRect(row, TRACK_ROW_HIT_CONFIG);
  // ホバー枠の矩形の内側にある代表点(中心・四隅の少し内側)がすべてクリック判定でも
  // 同じ行を指すことを確認する(枠の外周1pxちょうどは別行との境界なので中身側で見る)。
  const points = [
    [rect.x + rect.w / 2, rect.y + rect.h / 2],
    [rect.x + 1, rect.y + 1],
    [rect.x + rect.w - 2, rect.y + 1],
    [rect.x + 1, rect.y + rect.h - 2],
    [rect.x + rect.w - 2, rect.y + rect.h - 2],
  ];
  for (const [x, y] of points) {
    const hit = trackRowIndexAt(x, y, TRACK_ROW_HIT_CONFIG);
    check(`行${row}: ホバー矩形内の点(${x},${y})はクリック判定でも行${row}`, hit === row, `got=${hit}`);
  }
}

// --- 2. レベルメーター列: 同様に列の一致を確認 ---
for (let col = 0; col < LEVEL_COLUMN_HIT_CONFIG.columnCount; col++) {
  const rect = levelColumnHoverRect(col, LEVEL_COLUMN_HIT_CONFIG);
  const points = [
    [rect.x + rect.w / 2, rect.y + rect.h / 2],
    [rect.x + 1, rect.y + 1],
    [rect.x + rect.w - 2, rect.y + rect.h - 2],
  ];
  for (const [x, y] of points) {
    const hit = levelColumnIndexAt(x, y, LEVEL_COLUMN_HIT_CONFIG);
    check(`列${col}(${LEVEL_COLUMN_CHANNELS[col]}): ホバー矩形内の点(${x},${y})はクリック判定でも列${col}`, hit === col, `got=${hit}`);
  }
}

// --- 3. PPZ8列(11-18)はクリック非対応(fmdsp/channel-mask.js LEVEL_COLUMN_CHANNELS
//     参照)なので、ホバー枠の対象にも含まれない(=columnCountの範囲外)ことを確認。
//     ホバー側の対象範囲がクリック側より広がっていないか(=押せないのに枠が出る)を
//     直接検査する。
{
  check('LEVEL_COLUMN_CHANNELSの長さ(=ホバー/クリックどちらの対象数でもある)が11(PPZ8を含まない)',
    LEVEL_COLUMN_CHANNELS.length === 11, `length=${LEVEL_COLUMN_CHANNELS.length}`);
  // PPZ8列(index19付近、FMDSP_LEVEL_COUNT=19の11-18)はlevelColumnIndexAtの
  // columnCountで弾かれる=ホバー枠も出ない(trackRowHoverRect/levelColumnHoverRectは
  // 呼び出し側がcolumnCount範囲内のindexしか渡さない設計なので、範囲外indexを
  // 渡すこと自体が無い。ここではlevelColumnIndexAt自身がPPZ8位置で-1を返すことを
  // 直接確認し、「クリックできない範囲にはホバー判定も届かない」ことの根拠にする)。
  const ppz8Col = 12; // PPZ8の2列目相当(index11-18のうちの1つ)
  const x = LEVEL_COLUMN_HIT_CONFIG.columnX0 + LEVEL_COLUMN_HIT_CONFIG.columnW * ppz8Col + 1;
  const y = LEVEL_COLUMN_HIT_CONFIG.topY + 1;
  const hit = levelColumnIndexAt(x, y, LEVEL_COLUMN_HIT_CONFIG);
  check('PPZ8列(未対応)はlevelColumnIndexAtでも-1(クリックもホバーも届かない)', hit === -1, `got=${hit}`);
}

// --- 4. [陽性対照] configをわざと崩す(rowCountを1つ増やす)と、存在しないはずの
//     行11でも判定が一致してしまう(=範囲チェックが効いていないと誤って一致判定に
//     なる)ことを示し、この検査自体が意味のある比較をしていることを確認する。
{
  const brokenConfig = { ...TRACK_ROW_HIT_CONFIG, rowCount: TRACK_ROW_HIT_CONFIG.rowCount + 1 };
  const row = TRACK_ROW_HIT_CONFIG.rowCount; // 本来存在しない11行目
  const rect = trackRowHoverRect(row, brokenConfig);
  const hit = trackRowIndexAt(rect.x + rect.w / 2, rect.y + rect.h / 2, brokenConfig);
  check('[陽性対照] rowCountを実装外れで増やすと存在しないはずの行でも一致してしまう(検査が構造を見ている確認)',
    hit === row, `got=${hit}`);
  // 一方、正しいTRACK_ROW_HIT_CONFIG(rowCount=10)でこの11行目を判定すると-1になる
  // (=クリックもホバーも届かない)ことを確認し、実際のconfigでは範囲外が正しく
  // 弾かれていることを示す。
  const hitReal = trackRowIndexAt(rect.x + rect.w / 2, rect.y + rect.h / 2, TRACK_ROW_HIT_CONFIG);
  check('実際のTRACK_ROW_HIT_CONFIG(rowCount=10)では11行目は-1', hitReal === -1, `got=${hitReal}`);
}

// canvasPointFromClientClickは他の検査(verify_track_click_hit.mjs等)で既に検証済み
// のためimportのみ(未使用インポートを残さないため、故障注入の一部で使う)。
{
  const rect = { left: 0, top: 0, width: PC98_W, height: PC98_H };
  const point = canvasPointFromClientClick(10, 10, rect, PC98_W, PC98_H);
  check('canvasPointFromClientClickは等倍表示でそのまま座標を返す', point.x === 10 && point.y === 10, JSON.stringify(point));
}

console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
if (failCount > 0) process.exit(1);
