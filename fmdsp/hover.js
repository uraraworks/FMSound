// ホバー枠(利用者指示A: マウスカーソルが乗っているクリック可能な対象に枠を
// 表示し、押す前にどこが消えるか分かるようにする)。
//
// 座標→対象の当たり判定そのものは新規に書き起こさない。fmdsp/track-click.js の
// 既存の純粋関数(trackRowIndexAt/levelColumnIndexAt、canvasPointFromClientClick)
// をクリック処理と全く同じ引数でそのまま呼び出し、当たった行/列indexを受け取る
// (呼び出し側=html/mucom-app.js・html/pmd-app.jsの役目。tools/verify_hover_hit_matches_click.mjs
// で「クリックが反応する対象の集合」と「ホバー枠が出る対象の集合」が一致することを
// 検査する)。
//
// このモジュールが持つのは「当たった対象を矩形としてどう描くか」だけ:
//   - trackRowHoverRect/levelColumnHoverRect: 当たり判定に使ったのと同じconfig
//     オブジェクト(trackH/panelWidth、columnX0/columnW/topY/bottomY)をそのまま
//     受け取り、同じ数値から矩形を組み立てる。当たり判定用のconfigと矩形計算用の
//     configを別々に書くと数値がズレる余地が生まれるため、あえて同じ形にしてある。
//   - drawHoverOutline: Vram.fillRect()を4回使って1px枠を描くだけ(Vramクラス
//     自体は変更しない)。

// トラック行(行index、fmdsp/trackrow.js TRACK_H基準)のホバー枠矩形。
// config: trackRowIndexAt()へ渡すのと同じ { trackH, panelWidth }(rowCountは
// 矩形計算には不要)。
export function trackRowHoverRect(row, { trackH, panelWidth }) {
  return { x: 0, y: trackH * row, w: panelWidth, h: trackH };
}

// レベルメーター列(列index、fmdsp/rightpane.js LEVEL_*基準)のホバー枠矩形。
// config: levelColumnIndexAt()へ渡すのと同じ { columnX0, columnW, topY, bottomY }
// (columnCountは矩形計算には不要)。
export function levelColumnHoverRect(col, { columnX0, columnW, topY, bottomY }) {
  return { x: columnX0 + columnW * col, y: topY, w: columnW, h: bottomY - topY };
}

// 1px枠を描く。rect={x,y,w,h}(canvas内部座標、PC98_W/PC98_H基準)。
export function drawHoverOutline(vram, rect, color) {
  const { x, y, w, h } = rect;
  if (w <= 0 || h <= 0) return;
  vram.fillRect(x, y, w, 1, color);
  vram.fillRect(x, y + h - 1, w, 1, color);
  vram.fillRect(x, y, 1, h, color);
  vram.fillRect(x + w - 1, y, 1, h, color);
}

// ホバー枠の色。fmdsp/trackrow.js COLOR_MUTED/COLOR_UNUSEDと同じ方針
// (新色を作らずtools/gen_palette.pyの実RGBから選ぶ)。
//
// 最初index4([204,204,187])を試したが、実機で確認したところ鍵盤地板スプライト
// (fmdsp/sprites.js S_KEY_BG、白鍵部分)が最初からindex4で焼き込まれており、
// トラック行の枠は鍵盤帯(y方向でKEY_Y=14〜KEY_Y+KEY_H=31)と重なるため、
// 白鍵の上では枠が既存の色と同化して見えなくなってしまった(実機画面のピクセルを
// 直接読み出して確認: index4のピクセルが鍵盤部分だけで3000箇所以上あった)。
// そのためfmdsp/sprites.jsの全スプライト配列(S_KEY_BG/S_KEY_LEFT/S_KEY_RIGHT/
// S_NUM/S_LOGO_*/S_PANPOT/S_DT_SIGN/S_KEY_MASK等)に焼き込まれている色番号を
// 全数調査した結果、実際に使われているのは {0,1,2,3,4,5,7,9} で、6と8は
// スプライトには焼き込まれていない(dynamicにblitColorで都度指定される色
// =COLOR_KEY_HILITE(6)/COLOR_KEY_HILITE_SUB(8)としてのみ使われ、ホバー矩形が
// 触れる範囲全体に恒常的には存在しない)。ただし6/8は「鍵盤が今まさに光っている」
// 状態と混同する恐れがあるため避けた。9はS_LOGO_FM/S_LOGO_DS/S_LOGO_Pという
// 右ペイン最上部の"FMDSP"ロゴにしか焼き込まれておらず、そのロゴの座標
// (LOGO_Y=1〜、x=312〜352あたり)はトラック行の当たり判定範囲(x:0-320)にも
// レベルメーター列の当たり判定範囲(topY=LEVEL_TRACK_Y=218〜)にも一切重ならない
// (y座標帯が完全に別)。よってindex9はこのモジュールが矩形を描く領域全体で
// 一切他の描画と衝突しない、実測で裏付けた選択。
// 輝度(WCAG相対輝度、trackrow.js冒頭コメントの表参照): index9=[68,102,170]、
// 輝度0.1363。背景(index0、輝度0)よりは明るく視認できるが、強い主張はしない
// 「ここに乗っている」程度の落ち着いた枠として機能する。
export const COLOR_HOVER = 9;
