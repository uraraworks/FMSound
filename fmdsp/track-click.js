// トラック行クリックミュート機能の、クリック座標 -> トラック行indexへの変換を
// 担う純粋関数群(DOM/canvasに一切依存しない。tools/verify_track_click_hit.mjs参照)。
//
// FMDSPのcanvasはCSSで拡大縮小されるため、getBoundingClientRect()で得られる
// 表示サイズ(CSS px)と、canvas内部解像度(PC98_W x PC98_H = 640x400)の比を
// 必ず考慮しないとクリック位置がずれる(等倍表示でしか試さないと気づけない)。
// html/pmd-app.jsの既存のコメント欄三角クリック処理が同じ変換をすでに行っている
// (canvas.addEventListener('click', ...)内、PC98_W/PC98_H基準)ので、そこから
// 変換式だけを切り出して両アプリ(mucom-app.js/pmd-app.js)で共有する。

// クライアント座標(event.clientX/Y、CSS px)を、canvas内部解像度基準の座標へ
// 変換する。rectはcanvas.getBoundingClientRect()の戻り値(またはそれと同じ形の
// オブジェクト)。rectの表示サイズが0以下(非表示中など)ならnullを返す。
export function canvasPointFromClientClick(clientX, clientY, rect, canvasWidth, canvasHeight) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: (clientX - rect.left) * (canvasWidth / rect.width),
    y: (clientY - rect.top) * (canvasHeight / rect.height),
  };
}

// canvas内部座標(x,y)から、それがどのトラック行(0始まり)に当たるかを返す。
// トラック行はcanvas左半分(x: 0-panelWidth)にのみ存在する
// (docs/fmdsp-layout.md §2: 右半分はrmode=DEFAULTのスペクトラム/レベルメーター
// パネル。本Web版はDEFAULTモード固定で右側にトラック詳細パネルを出していない
// ことをhtml/pmd-app.js・html/mucom-app.jsのrightpane呼び出しで確認済み)。
// 範囲外(行の外・パネル外)なら-1を返す。
export function trackRowIndexAt(canvasX, canvasY, { trackH, rowCount, panelWidth }) {
  if (canvasX < 0 || canvasX >= panelWidth) return -1;
  if (canvasY < 0) return -1;
  const row = Math.floor(canvasY / trackH);
  if (row < 0 || row >= rowCount) return -1;
  return row;
}

// 2026-08-16追加: レベルメーター(fmdsp/rightpane.js drawLevelMeters)クリックで
// リズム等をミュートする機能用。トラック行クリック(上のtrackRowIndexAt)と同じ
// 「canvas内部座標 -> スケール変換済みの当たり判定」の仕組みをそのまま流用する
// (座標変換自体はcanvasPointFromClientClickが等倍でない表示倍率も含めて既に
// 担っているので、ここでは変換後のcanvas内部座標を受け取るだけでよい)。
//
// columnX0/columnW: 列の左端x座標(fmdsp/rightpane.jsのLEVEL_X)と列幅
// (LEVEL_W。バー本体の描画幅LEVEL_DISP_Wより広く列間の余白を含むので、
// 隣接列との間に無反応の帯ができないようこちらを当たり判定に使う)。
// topY/bottomY: 列の縦方向の当たり判定範囲([topY, bottomY))。呼び出し側が
// fmdsp/rightpane.jsの定数(LEVEL_TRACK_Y〜LEVEL_KEY_Y相当)から組み立てる。
// columnCount: クリック可能な列数。呼び出し側(html/mucom-app.js)がMUCOM用に
// LEVEL_COLUMN_CHANNELS.length(=11、PPZ8列は対象外。MUCOM88にPPZ8という概念が
// 無いため)を渡すか、呼び出し側(html/pmd-app.js)がPMD用に
// PMD_LEVEL_COLUMN_CHANNELS.length(=19、PPZ8列(11-18)も対象)を渡すかで決まる
// (fmdsp/channel-mask.js参照)。
// 範囲外なら-1を返す(trackRowIndexAtと同じ流儀)。
export function levelColumnIndexAt(canvasX, canvasY, { columnX0, columnW, topY, bottomY, columnCount }) {
  if (canvasY < topY || canvasY >= bottomY) return -1;
  if (canvasX < columnX0) return -1;
  const col = Math.floor((canvasX - columnX0) / columnW);
  if (col < 0 || col >= columnCount) return -1;
  return col;
}
