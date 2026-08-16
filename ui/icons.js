// WebNP2 / WebX68k と同じ「インラインSVGアイコン」の作り方を共有化したもの
// (src/ui/player.ts の svgIcon()/iconButton() を踏襲)。
// viewBox="0 0 24 24" / stroke=currentColor / stroke-width=2 / round cap+join で統一する。

export const ICON_SIZE = 20;

/**
 * pathD をストローク描画するSVGを作る。extra には <circle>/<rect> 等の追加要素を
 * 生SVG文字列として渡せる(塗りつぶしアイコンなど、パス1本で表現しづらい形用)。
 */
export function svgIcon(pathD, extra = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(ICON_SIZE));
  svg.setAttribute('height', String(ICON_SIZE));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `<path d="${pathD}"/>${extra}`;
  return svg;
}

/** ツールバー用のアイコンのみボタン(.icon-btn)を組み立てる。 */
export function iconButton(icon, label, extraClass = '') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = extraClass ? `icon-btn ${extraClass}` : 'icon-btn';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.append(svgIcon(icon.path ?? icon, icon.extra ?? ''));
  return btn;
}

// プレイヤー系ツールバーで使う最小限のアイコン集合。
// play/stop は塗りつぶし図形の方が視認性が高いため、pathD は空にして extra の
// <rect>/<path fill> で表現する(svgIcon()の第2引数)。
export const ICONS = {
  play: { path: '', extra: '<path d="M8 5l11 7-11 7V5z" fill="currentColor" stroke="none"/>' },
  stop: { path: '', extra: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>' },
  // 縦棒2本＝一時停止(再開時は同じボタンをplayアイコンへ差し替える運用を想定せず、
  // active状態(CSS .icon-btn.active)とtitle/aria-labelの文言切替だけで表す)。
  pause: {
    path: '',
    extra:
      '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/>' +
      '<rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/>',
  },
  // フォルダを開く＝曲を開く(ローカルファイル選択)。
  open: 'M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7z',
  // 課題B: 折れ角付きの用紙+プラス＝新規作成(「曲を開く」「ダウンロード」と同じツールバー列に置く)。
  newFile: {
    path: 'M6 3h7l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M13 3v5h5',
    extra: '<path d="M9 14.5h6 M12 11.5v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  },
  // スライダー3本(つまみ付き)＝設定。
  settings: {
    path: 'M4 6h16 M4 12h16 M4 18h16',
    extra:
      '<circle cx="8" cy="6" r="1.6" fill="currentColor" stroke="none"/>' +
      '<circle cx="15" cy="12" r="1.6" fill="currentColor" stroke="none"/>' +
      '<circle cx="10" cy="18" r="1.6" fill="currentColor" stroke="none"/>',
  },
  // 鉛筆＝MML編集(エディタモード切替)。
  edit: 'M4 20l1-4L15 6l3 3L8 19l-4 1z M13 7l3 3',
  // WebNP2/WebX68kと同じ四隅矢印＝フルスクリーン。
  fullscreen:
    'M4 9V5a1 1 0 0 1 1-1h4 M15 4h4a1 1 0 0 1 1 1v4 M20 15v4a1 1 0 0 1-1 1h-4 M9 20H5a1 1 0 0 1-1-1v-4',
  // 課題D: 下向き矢印+受け皿＝ダウンロード。
  download: 'M12 3v11 M7 10l5 5 5-5 M4 20h16',
  // 曲ライブラリ: 音符＋リスト(取り込み済みの曲一覧を開く)。
  library: {
    path: 'M9 18V5l11-2v13 M4 21h6 M15 19h6',
    extra:
      '<circle cx="6" cy="18" r="2.2" fill="currentColor" stroke="none"/>' +
      '<circle cx="18" cy="16" r="2.2" fill="currentColor" stroke="none"/>',
  },
};
