// FMSound 共有ブートストラップ。
//
// 1アプリ化の要: エンジンの選択は `?engine=mucom` / `?engine=pmd`(既定はmucom、
// 理由はfooter付近ではなくREADME/報告に記す)。ページはここで選ばれたエンジンの
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
import { FMSOUND_VERSION_FOOTER } from './ui/version.js';

const VALID_ENGINES = ['mucom', 'pmd'];
// 既定エンジン: mucom。理由(報告にも記載): MUCOM88側は本タスク以前から
// エディタ機能まで含めて完成しており実績が長い。既定を変えると
// 「素のURL(?engineなし)でアクセスした既存ユーザー」の体験が変わってしまうため、
// 後方互換の意味でもmucomを既定にする。
const DEFAULT_ENGINE = 'mucom';

const params = new URLSearchParams(location.search);
const requestedEngine = params.get('engine');
const engine = VALID_ENGINES.includes(requestedEngine) ? requestedEngine : DEFAULT_ENGINE;

const ENGINE_LABELS = {
  mucom: 'MUCOM88 (PC-8801)',
  pmd: 'PMD (PC-9801)',
};

document.getElementById('fmsoundVersionFooter').textContent = ` — FMSound ${FMSOUND_VERSION_FOOTER}`;
document.getElementById('engineTagline').textContent = `${ENGINE_LABELS[engine]} MMLプレイヤー`;

const engineSelect = document.getElementById('engineSelect');
engineSelect.value = engine;
engineSelect.addEventListener('change', () => {
  const next = engineSelect.value;
  if (next === engine) return;
  const url = new URL(location.href);
  url.searchParams.set('engine', next);
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
const btnPlayPause = iconButton(ICONS.play, 'コンパイル&再生');
const btnStop = iconButton(ICONS.stop, '停止');
const btnOpenFile = iconButton(ICONS.open, '曲を開く');
const btnSettings = iconButton(ICONS.settings, '設定');
const btnFullscreen = iconButton(ICONS.fullscreen, 'フルスクリーン');
// エンジン固有ボタン(MUCOM88のエディタモード切替等)はこのボタンの手前に挿し込む。
toolbar.append(btnPlayPause, btnStop, btnOpenFile, btnSettings, btnFullscreen);
btnPlayPause.disabled = true;
btnStop.disabled = true;

const consoleCardForFullscreen = consoleCard;
setupFullscreen(consoleCardForFullscreen, btnFullscreen, { enter: 'フルスクリーン', exit: 'フルスクリーン解除' }, rescale);
setupPopover(btnSettings, document.getElementById('settingsPopover'));

rescale();
requestAnimationFrame(rescale);

const ctx = {
  engine,
  debugEnabled,
  canvas,
  consoleCard,
  toolbar,
  btnPlayPause,
  btnStop,
  btnOpenFile,
  btnSettings,
  btnFullscreen,
  fileInput: document.getElementById('fileInput'),
  sampleLinksEl: document.getElementById('sampleLinks'),
  enginePaneEl: document.getElementById('enginePane'),
  debugPaneEl: document.getElementById('debugPane'),
  footerCreditsEl: document.getElementById('footerCredits'),
  rescale,
};

// エンジンの選択は?engine=だけで決まり、選ばれた側のモジュールだけを動的import
// する(=選ばれなかった側のwasmは一切fetchされない)。
const modulePath = engine === 'pmd' ? './pmd-app.js' : './mucom-app.js';
const engineApp = await import(modulePath);
await engineApp.init(ctx);
