// FMSound 共有ブートストラップ。
//
// 1アプリ化の要: 音源ドライバの選択は `?driver=mucom` / `?driver=pmd`(既定はmucom、
// 理由はfooter付近ではなくREADME/報告に記す)。ページはここで選ばれたドライバの
// モジュール(./mucom-app.js または ./pmd-app.js)だけを動的importする。
// 動的import(import())は評価されるまでモジュールを取得・実行しないため、
// これにより「wasmは片方だけ読み込む」を満たす(静的importで両方書くとバンドラ無し
// でも両方のモジュールがロード時に評価され、両方のwasmが読み込まれてしまう)。
//
// このファイルが持つのは「エンジンに依らない共通UI」だけ:
//   - キャンバスの表示サイズ計算(rescale)
//   - フルスクリーン/設定ポップオーバー
//   - ツールバー共通ボタン(再生一時停止/停止/開く/設定/フルスクリーン)の骨組み
//   - ?debug=1 の表示切替
//   - エンジン切替セレクト
// 曲の再生・コンパイル・FMDSP描画・エンジン固有ボタンの追加はengine-app側の責務。

import { PC98_W, PC98_H } from './fmdsp/vram.js';
import { ICONS, iconButton } from './ui/icons.js';
import { setupFullscreen, setupPopover } from './ui/shell.js';
import { FMSOUND_VERSION_FOOTER, FMSOUND_BUILD_ID } from './ui/version.js';
import { EXTENSION_DRIVER_TABLE } from './net/song-select.js';
import { urlBaseName } from './net-load.js';

// --- 課題B(最優先・データ消失防止): ページのどこにファイルを落としても、
// ブラウザの既定動作(そのファイルを開いてページ遷移する。編集中のMMLが画面から
// 消える)を起こさせない。以前は consoleCard 内にしか drop ハンドラが無く、
// カード外に落とすとここに引っかからずブラウザへ抜けていた。
// engine-app の読み込み(下の動的import、失敗もありうる)を待たず、このスクリプト
// の実行直後から効かせる。実際の受け取り処理(視覚的な目印・複数ファイル時の案内)
// は setupPageDropZone() が engine 初期化後に配線する(下部参照)。
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

const VALID_DRIVERS = ['pmd', 'mucom'];
// 既定ドライバ: pmd。このツール一式の目的は「Webで PC-98 のゲームを作る」ことで、
// PC-98の音源ドライバはPMD。MUCOM88はPC-88用で本来は側枝にあたる
// (以前の既定がmucomだったのは、単にPMDよりMUCOM88側のエディタ機能が先に
// 完成していたからで、狙って選んだ既定ではなかった。課題C)。
const DEFAULT_DRIVER = 'pmd';

const params = new URLSearchParams(location.search);
const requestedDriver = params.get('driver');
// ?mml=<URL> で曲を指定できる(net/配線タスク)。?driver= が明示されていればそちらを
// 優先し、無い場合だけURLの拡張子(EXTENSION_DRIVER_TABLE、net/song-select.js)から
// ドライバを推測する。拡張子で判別できない場合(書庫URL等)は既定ドライバのまま
// (書庫の中身は取得後でないと分からず、取得前にどちらのwasmを読み込むか決める
// この段階では中身を見られないため)。
const songUrl = params.get('mml');
function sniffDriverFromUrl(url) {
  const name = urlBaseName(url).toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return EXTENSION_DRIVER_TABLE[name.slice(dot)] ?? null;
}
const driver = VALID_DRIVERS.includes(requestedDriver)
  ? requestedDriver
  : (songUrl && sniffDriverFromUrl(songUrl)) || DEFAULT_DRIVER;

const DRIVER_LABELS = {
  mucom: 'MUCOM88 (PC-8801)',
  pmd: 'PMD (PC-9801)',
};

document.getElementById('fmsoundVersionFooter').textContent = ` — FMSound ${FMSOUND_VERSION_FOOTER}`;
document.getElementById('driverTagline').textContent = `${DRIVER_LABELS[driver]} MMLプレイヤー`;

const driverSelect = document.getElementById('driverSelect');
driverSelect.value = driver;
driverSelect.addEventListener('change', () => {
  const next = driverSelect.value;
  if (next === driver) return;
  const url = new URL(location.href);
  url.searchParams.set('driver', next);
  location.href = url.toString();
});

// --- デバッグ表示(?debug=1が付いているときだけ表示) ---
const debugEnabled = params.get('debug') === '1';
document.body.classList.toggle('debug-enabled', debugEnabled);

// --- キャンバス表示サイズの再計算(WebX68k src/main.ts の rescale() に倣う) ---
// mucomweb/html/index.html(旧)の実装をそのまま踏襲(エンジンに依らずPC98_W/H固定
// なので共通化できる)。詳細な設計理由は移設前のコメントを参照(git履歴)。
const canvas = document.getElementById('fmdsp-canvas');
const consoleCard = document.getElementById('consoleCard');
const consoleFooterEl = document.querySelector('.console-footer');

function elHeight(el) {
  return el ? el.getBoundingClientRect().height : 0;
}

function parseLenOrZero(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function isNativeFullscreen() {
  return document.fullscreenElement === consoleCard || document.webkitFullscreenElement === consoleCard;
}

function isPseudoFullscreen() {
  return document.body.classList.contains('pseudo-fullscreen');
}

function computeAvailable() {
  if (isNativeFullscreen()) {
    const rect = consoleCard.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }
  const appStyle = getComputedStyle(document.getElementById('app'));
  const paddingH = parseLenOrZero(appStyle.paddingLeft) + parseLenOrZero(appStyle.paddingRight);
  const paddingV = parseLenOrZero(appStyle.paddingTop) + parseLenOrZero(appStyle.paddingBottom);
  const availWidth = Math.max(1, window.innerWidth - paddingH);
  const availHeight = Math.max(1, window.innerHeight - paddingV);
  return { width: availWidth, height: availHeight };
}

export function rescale() {
  const dpr = window.devicePixelRatio || 1;
  const heightConstrained = isNativeFullscreen() || isPseudoFullscreen();

  let fit;
  if (heightConstrained) {
    const avail = computeAvailable();
    const cardStyle = getComputedStyle(consoleCard);
    const cardGap = parseLenOrZero(cardStyle.rowGap || cardStyle.gap);
    const stageAvailHeight = Math.max(1, avail.height - elHeight(consoleFooterEl) - cardGap);
    const stageAvailWidth = Math.max(1, avail.width);
    fit = Math.min(stageAvailWidth / PC98_W, stageAvailHeight / PC98_H);
  } else {
    const avail = computeAvailable();
    fit = Math.max(1, avail.width) / PC98_W;
  }

  const scale = fit >= 1 ? Math.max(1, Math.floor(fit * dpr) / dpr) : Math.max(0.3, fit);
  if (!Number.isFinite(scale) || scale <= 0) return;

  canvas.style.width = `${PC98_W * scale}px`;
  canvas.style.height = `${PC98_H * scale}px`;
}

window.addEventListener('resize', rescale);
window.addEventListener('orientationchange', rescale);
// visualViewportのresizeは購読しない(ピンチズームで発火するため。既知の罠、
// feedback_visualviewport_refit_breaks_pinch.md参照)。

// --- ツールバー共通ボタン ---
const toolbar = document.getElementById('toolbar');
// 課題C: ボタンのtitleにショートカットを明記する(気づけるようにする目的。
// 実際のキー配線はengine-app側(html/pmd-app.js・html/mucom-app.js)が
// ui/shortcuts.js setupTransportShortcuts()経由で行う)。
const btnPlayPause = iconButton(ICONS.play, 'コンパイル&再生 (⌘/Ctrl+Enter)');
const btnStop = iconButton(ICONS.stop, '停止 (Esc)');
const btnOpenFile = iconButton(ICONS.open, '曲を開く');
const btnDownload = iconButton(ICONS.download, 'ダウンロード');
const btnSettings = iconButton(ICONS.settings, '設定');
const btnFullscreen = iconButton(ICONS.fullscreen, 'フルスクリーン');
// エンジン固有ボタン(MUCOM88のエディタモード切替等)はこのボタンの手前に挿し込む。
toolbar.append(btnPlayPause, btnStop, btnOpenFile, btnDownload, btnSettings, btnFullscreen);
btnPlayPause.disabled = true;
btnStop.disabled = true;

const consoleCardForFullscreen = consoleCard;
setupFullscreen(consoleCardForFullscreen, btnFullscreen, { enter: 'フルスクリーン', exit: 'フルスクリーン解除' }, rescale);
setupPopover(btnSettings, document.getElementById('settingsPopover'));

rescale();
requestAnimationFrame(rescale);

const ctx = {
  driver,
  debugEnabled,
  canvas,
  consoleCard,
  toolbar,
  btnPlayPause,
  btnStop,
  btnOpenFile,
  btnDownload,
  btnSettings,
  settingsPopoverEl: document.getElementById('settingsPopover'),
  btnFullscreen,
  fileInput: document.getElementById('fileInput'),
  songUrl,
  sampleLinksEl: document.getElementById('sampleLinks'),
  enginePaneEl: document.getElementById('enginePane'),
  debugPaneEl: document.getElementById('debugPane'),
  footerCreditsEl: document.getElementById('footerCredits'),
  rescale,
  // 課題B: engine-app(mucom-app.js/pmd-app.js)が init() の中でこれを差し替え、
  // 「ドロップされたFileListを実際に読み込む処理」を登録する。ページ全体の
  // ドロップ受付(setupPageDropZone、下部)はここを呼ぶだけで、曲の解釈自体は
  // 引き続きengine側の責務にする(1件目だけ使う判断もengine側のopenMmlFile等に揃える)。
  handleDroppedFiles: null,
};

// 音源ドライバの選択は?driver=だけで決まり、選ばれた側のモジュールだけを動的import
// する(=選ばれなかった側のwasmは一切fetchされない)。
//
// 課題A(2026-08-15、iPhone利用者の「line 22が...で始まる必要があります」報告):
// GitHub Pagesはヘッダ側でキャッシュを制御できないため、更新のたびにURLそのものを
// 変える。静的import(tools/apply_cache_bust.pyがビルド時に './x.js' へ ?v=<hash> を
// 機械的に付与)と違い、ここはパスを実行時に組み立てる動的importなのでテキスト置換の
// 対象にならない。同じ「コミットハッシュ」を情報源にして自前で付与する。
const modulePath =
  (driver === 'pmd' ? './pmd-app.js' : './mucom-app.js') + `?v=${FMSOUND_BUILD_ID}`;
const engineApp = await import(modulePath);
await engineApp.init(ctx);

// --- 課題B: ページ全体をドロップの受け入れ範囲にする ---
// 「カード上にしか無い」と落とせる場所を探させてしまう問題への対応。ドラッグ中は
// ページ全体に目印(枠+中央のメッセージ、ui/styles.cssの.page-dropzone-active)を出す。
// dragenter/dragleaveは子要素をまたぐたびにも発火する(バブリング)ため、単純な
// on/offだと出入りのたびにちらつく。カウンタで「本当にページの外へ出た」ときだけ
// 目印を消す(よくあるドラッグオーバーレイの実装作法)。
function setupPageDropZone(ctx) {
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth += 1;
    document.body.classList.add('page-dropzone-active');
  });
  window.addEventListener('dragover', (e) => {
    // 継続的にpreventDefault()しないとdropイベント自体が発火しないブラウザがある。
    e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('page-dropzone-active');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('page-dropzone-active');
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || files.length === 0) return;
    if (typeof ctx.handleDroppedFiles === 'function') {
      ctx.handleDroppedFiles(files);
    }
  });
}
setupPageDropZone(ctx);
