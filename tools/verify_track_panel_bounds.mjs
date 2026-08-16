#!/usr/bin/env node
// トラック行のホバー枠/クリック当たり判定が右ペインへはみ出す不具合の検証。
//
// 背景(利用者報告、2026-08-17): 「ホバー枠が鍵盤から離れて右ペインのFMDSPロゴまで
// 来ている」。原因はhtml/mucom-app.js・html/pmd-app.jsが渡していた
// panelWidth: PC98_W / 2 (=320)。これは「canvas幅を単純に半分にしただけ」の
// 便宜的な値で、トラック行の実際の描画幅とは無関係だった。panelWidthは
// trackRowHoverRect()(枠の幅)だけでなくtrackRowIndexAt()の当たり判定
// (fmdsp/track-click.js:29 `canvasX >= panelWidth`)にも使われているため、
// 「右ペイン左端をクリックするとトラックがミュートされる」という実害があった。
//
// 修正: fmdsp/trackrow.js TRACK_PANEL_W(鍵盤帯の右端から計算した値、実測と
// 一致することを確認済み。同ファイルのコメント参照)を使うよう変更した。
//
// この検査は:
//   1. ホバー枠の右端が、トラック行の実際の描画右端(実測、drawTrackRows()を
//      レンダリングして直接読む)を超えないこと。
//   2. 右ペイン側の座標(x=312,320,400)でクリック判定がトラック行を返さない
//      (-1になる)こと(実害部分)。
//   3. 逆に、トラック行内の座標(x=0,150,297)では正しい行を返すこと
//      (2だけだと「常に-1を返す」壊れた実装でも通ってしまうため必須)。
//   4. [陽性対照] panelWidthを旧値(PC98_W/2=320)に戻すと1・2がFAILすることを確認。
//
// 実行: node tools/verify_track_panel_bounds.mjs

import { Vram, PC98_W, PC98_H } from '../fmdsp/vram.js';
import { drawTrackRows, createIdleEntryTracks, TRACK_H, TRACK_DISP_TABLE_OPNA, TRACK_PANEL_W } from '../fmdsp/trackrow.js';
import { trackRowIndexAt } from '../fmdsp/track-click.js';
import { trackRowHoverRect } from '../fmdsp/hover.js';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

const ROW_COUNT = TRACK_DISP_TABLE_OPNA.length; // 10
const OLD_PANEL_WIDTH = PC98_W / 2; // 320。修正前の便宜的な値(陽性対照専用)。

console.log('=== トラック行ホバー枠/クリック判定の右端境界 検証(fmdsp/track-click.js, fmdsp/hover.js) ===\n');
console.log(`TRACK_PANEL_W(修正後) = ${TRACK_PANEL_W}  旧PANEL_WIDTH(PC98_W/2) = ${OLD_PANEL_WIDTH}\n`);

// --- 0. 実測: drawTrackRows()を実際にレンダリングし、10行ぶんの矩形の中で
//    非0(=何か描かれた)ピクセルの最大x座標を直接読む。アイドル状態
//    (createIdleEntryTracks())でも鍵盤地板(S_KEY_LEFT/S_KEY_BG/S_KEY_RIGHT)は
//    無条件に毎行描画されるため、この実測だけでトラック行の右端が分かる。
const vram = new Vram(PC98_W, PC98_H);
vram.clear(0);
drawTrackRows(vram, null, createIdleEntryTracks());
let actualMaxX = -1;
for (let y = 0; y < TRACK_H * ROW_COUNT; ++y) {
  for (let x = PC98_W - 1; x > actualMaxX; --x) {
    if (vram.pixels[y * PC98_W + x] !== 0) { actualMaxX = Math.max(actualMaxX, x); break; }
  }
}
console.log(`実測: トラック行10行ぶんの描画範囲で非0ピクセルの最大x = ${actualMaxX}`);
check('実測右端がTRACK_PANEL_W-1と一致する(=298を計算根拠として採用してよい確認)',
  actualMaxX === TRACK_PANEL_W - 1, `actualMaxX=${actualMaxX} TRACK_PANEL_W-1=${TRACK_PANEL_W - 1}`);

// --- 1. ホバー枠の右端が実測描画右端を超えないこと ---
{
  const rect = trackRowHoverRect(0, { trackH: TRACK_H, panelWidth: TRACK_PANEL_W });
  const hoverRightEdgeExclusive = rect.x + rect.w; // 排他的上限(この値未満が枠の範囲)
  console.log(`ホバー枠(TRACK_PANEL_W使用): x=${rect.x} w=${rect.w} 右端(排他)=${hoverRightEdgeExclusive}`);
  check('[本体] ホバー枠の右端が、トラック行の実測描画右端を超えない',
    hoverRightEdgeExclusive <= actualMaxX + 1, `hoverRightEdgeExclusive=${hoverRightEdgeExclusive} actualMaxX+1=${actualMaxX + 1}`);
}

// --- 2. 右ペイン側の座標ではトラック行を返さない(-1) ---
for (const x of [312, 320, 400]) {
  const row = trackRowIndexAt(x, TRACK_H * 0 + 10, { trackH: TRACK_H, rowCount: ROW_COUNT, panelWidth: TRACK_PANEL_W });
  check(`[本体/実害] x=${x}(右ペイン側)のクリックはトラック行を返さない(-1)`, row === -1, `got=${row}`);
}

// --- 3. トラック行内の座標では正しい行を返す(2だけだと「常に-1」でも通ってしまうため必須) ---
for (const x of [0, 150, 297]) {
  for (const row of [0, 3, 9]) {
    const y = TRACK_H * row + 10;
    const result = trackRowIndexAt(x, y, { trackH: TRACK_H, rowCount: ROW_COUNT, panelWidth: TRACK_PANEL_W });
    check(`[本体] x=${x}, 行${row}内(y=${y})のクリックは行${row}を返す`, result === row, `got=${result}`);
  }
}

// --- 4. [陽性対照] panelWidthを旧値(320)に戻すと1・2がFAILすることを確認 ---
{
  const rect = trackRowHoverRect(0, { trackH: TRACK_H, panelWidth: OLD_PANEL_WIDTH });
  const hoverRightEdgeExclusive = rect.x + rect.w;
  const wouldPass1 = hoverRightEdgeExclusive <= actualMaxX + 1;
  check('[陽性対照] 旧panelWidth(320)ではホバー枠が実測右端を超えてしまう(検査1が効いている確認)',
    wouldPass1 === false, `hoverRightEdgeExclusive=${hoverRightEdgeExclusive} actualMaxX+1=${actualMaxX + 1}`);

  let anyFalsePositive = false;
  for (const x of [312, 320]) {
    const row = trackRowIndexAt(x, 10, { trackH: TRACK_H, rowCount: ROW_COUNT, panelWidth: OLD_PANEL_WIDTH });
    if (row !== -1) anyFalsePositive = true;
    console.log(`  [陽性対照] 旧panelWidth(320)でx=${x}: trackRowIndexAt=${row}`);
  }
  check('[陽性対照] 旧panelWidth(320)では右ペイン側の座標(x=312)がトラック行と誤判定される(検査2が効いている確認)',
    anyFalsePositive === true);
}

console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
if (failCount > 0) process.exit(1);
