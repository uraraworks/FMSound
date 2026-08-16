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
