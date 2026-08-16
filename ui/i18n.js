// FMSound の ja/en 切替(辞書方式)。
//
// 設計(利用者指示、発明はしない):
//   - 英語のみへの置き換えではなく、日本語の辞書もここに残す。
//   - 言語の決定順: (1) URLの?lang=ja/?lang=en(この2値以外は無視)
//                    (2) navigator.languageが'ja'始まりならja、それ以外はen。
//   - このモジュール自体はビルド不要の素のES module(依存追加なし)。
//   - tools/verify_i18n.mjs がNode(ブラウザではない)からこのファイルをそのまま
//     importして辞書の整合性を検証する。そのため、モジュール評価の副作用として
//     `location`/`navigator` に触れてはいけない(Nodeには存在せず即クラッシュする)。
//     参照は detectLang() 等の関数の「呼び出し時」に限定する。
//
// 今回(L1)の対象は「利用者が操作する前から画面に出ている固定ラベル」だけ。
// コンパイル結果・エラー理由・再生ボタンの状態表示など、実行時に動的合成される
// メッセージは対象外(次ラウンド。html/pmd-app.js・html/mucom-app.js・
// ui/mml-status.js の該当箇所は未着手のまま)。

export const LANGS = ['ja', 'en'];
export const DEFAULT_LANG = 'en';

const ja = {
  'page.title': 'FMSound — FM音源MMLプレイヤー',

  'toolbar.driverLabel': '音源ドライバ:',
  'toolbar.langLabel': '言語:',
  'toolbar.playPauseInitial': 'コンパイル&再生 (⌘/Ctrl+Enter)',
  'toolbar.stop': '停止 (Esc)',
  'toolbar.open': '曲を開く',
  'toolbar.download': 'ダウンロード',
  'toolbar.settings': '設定',
  'toolbar.fullscreen': 'フルスクリーン',
  'toolbar.fullscreenExit': 'フルスクリーン解除',
  'toolbar.editorMode': 'エディタモードへ切替',
  'toolbar.playerMode': 'プレイヤーモードへ切替',
  'toolbar.newFile': '新規作成',
  'toolbar.library': '曲ライブラリ',

  'settings.title': '設定',
  'settings.sampleRate': 'サンプルレート',
  'settings.calibrationMs': '同期較正(ms)',
  'settings.syncDraw': '音声に同期して描画する',

  'openMenu.title': '曲を開く',
  'openMenu.fromFile': 'ファイルから開く',
  'openMenu.fromUrl': 'URLから開く',
  'openMenu.submit': '実行',
  'openMenu.cancel': '取消',

  'download.title': 'ダウンロード',
  'download.downloadBtn': 'ダウンロード',
  'download.mmlSection': 'MMLソース(編集中の内容)',
  'download.encodingDefault': 'CP932(既定)',
  'download.encodingUtf8': 'UTF-8',
  'download.compiledSection': 'コンパイル済み({label})',
  'download.compileHint': '先にコンパイル&再生(または曲を開く)してください',
  'download.asmSection': 'asmの db 配列(PC-98/PC-88プログラムへ埋め込み用)',
  'download.cp932UnmappableAlert':
    'CP932へ変換できない文字が{count}種類あります:\n{chars}\n\nUTF-8を選ぶか、該当箇所を修正してからやり直してください。',

  'library.title': '曲ライブラリ',
  'library.titleWithCount': '曲ライブラリ({count}曲)',
  'library.unavailable': 'この端末ではライブラリを利用できません(プライベートブラウズ中、または非対応環境の可能性があります)。',
  'library.empty': 'まだ曲がありません。URL指定やドラッグ&ドロップで曲を読み込むと、次回からここに残るようになります。',
  'library.clearAll': 'すべて削除',
  'library.clearAllConfirm': 'このプレイヤーのライブラリ({count}曲)をすべて削除します。よろしいですか?',
  'library.albumCount': '{count}曲',
  'library.albumHeader': '{label}({count}曲)',
  'library.backToAlbums': '← アルバム一覧へ',
  'library.deleteTrack': '削除',
  'library.deleteTrackTitle': '{title} を削除',
};

const en = {
  'page.title': 'FMSound — FM Sound MML Player',

  'toolbar.driverLabel': 'Sound driver:',
  'toolbar.langLabel': 'Language:',
  'toolbar.playPauseInitial': 'Compile & Play (⌘/Ctrl+Enter)',
  'toolbar.stop': 'Stop (Esc)',
  'toolbar.open': 'Open song',
  'toolbar.download': 'Download',
  'toolbar.settings': 'Settings',
  'toolbar.fullscreen': 'Fullscreen',
  'toolbar.fullscreenExit': 'Exit fullscreen',
  'toolbar.editorMode': 'Switch to editor mode',
  'toolbar.playerMode': 'Switch to player mode',
  'toolbar.newFile': 'New',
  'toolbar.library': 'Song library',

  'settings.title': 'Settings',
  'settings.sampleRate': 'Sample rate',
  'settings.calibrationMs': 'Sync calibration (ms)',
  'settings.syncDraw': 'Draw synced to audio',

  'openMenu.title': 'Open song',
  'openMenu.fromFile': 'Open from file',
  'openMenu.fromUrl': 'Open from URL',
  'openMenu.submit': 'Go',
  'openMenu.cancel': 'Cancel',

  'download.title': 'Download',
  'download.downloadBtn': 'Download',
  'download.mmlSection': 'MML source (current edits)',
  'download.encodingDefault': 'CP932 (default)',
  'download.encodingUtf8': 'UTF-8',
  'download.compiledSection': 'Compiled ({label})',
  'download.compileHint': 'Compile & play (or open a song) first',
  'download.asmSection': 'asm db array (for embedding into PC-98/PC-88 programs)',
  'download.cp932UnmappableAlert':
    'There are {count} character(s) that cannot be converted to CP932:\n{chars}\n\nChoose UTF-8, or fix the affected characters and try again.',

  'library.title': 'Song library',
  'library.titleWithCount': 'Song library ({count} tracks)',
  'library.unavailable': 'The song library is unavailable on this device (may be private browsing, or an unsupported environment).',
  'library.empty': 'No songs yet. Load one via URL or drag & drop, and it will stay here next time.',
  'library.clearAll': 'Delete all',
  'library.clearAllConfirm': 'This deletes all {count} song(s) in this player’s library. Are you sure?',
  'library.albumCount': '{count} tracks',
  'library.albumHeader': '{label} ({count} tracks)',
  'library.backToAlbums': '← Back to albums',
  'library.deleteTrack': 'Delete',
  'library.deleteTrackTitle': 'Delete {title}',
};

export const DICT = { ja, en };

/**
 * URL(?lang=)とnavigator.languageから言語を決める。
 * 引数はテスト/Node向けの差し込み(既定はブラウザの実値)。
 */
export function detectLang(
  search = typeof location !== 'undefined' ? location.search : '',
  navLang = typeof navigator !== 'undefined' ? navigator.language : '',
) {
  const params = new URLSearchParams(search);
  const urlLang = params.get('lang');
  if (urlLang === 'ja' || urlLang === 'en') return urlLang;
  return navLang && navLang.toLowerCase().startsWith('ja') ? 'ja' : DEFAULT_LANG;
}

let currentLang = null;

/** ページ起動時に1回呼ぶ。以降 getLang()/t() はこの値を使う。 */
export function initLang() {
  currentLang = detectLang();
  return currentLang;
}

export function getLang() {
  return currentLang ?? detectLang();
}

export function setLang(lang) {
  if (LANGS.includes(lang)) currentLang = lang;
}

/**
 * 辞書引き。keyが無ければ警告してjaへフォールバックする(タイポ検出は
 * tools/verify_i18n.mjs側で静的に行うので、ここは実行時の保険)。
 * @param {string} key
 * @param {Record<string,string|number>} [params] - '{name}' プレースホルダの差し込み値
 */
export function t(key, params) {
  const lang = getLang();
  const dict = DICT[lang] ?? DICT[DEFAULT_LANG];
  let value = dict[key];
  if (value === undefined) {
    if (typeof console !== 'undefined') console.warn(`[i18n] missing key: ${key}`);
    value = DICT.ja[key] ?? key;
  }
  if (params) {
    for (const [name, v] of Object.entries(params)) {
      value = value.replaceAll(`{${name}}`, String(v));
    }
  }
  return value;
}

/**
 * data-i18n系属性を持つ要素へ一括で流し込む(index.htmlの静的ラベル向け)。
 *   data-i18n            -> textContent
 *   data-i18n-title      -> title + aria-label
 *   data-i18n-placeholder -> placeholder
 */
export function applyStaticI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const value = t(el.getAttribute('data-i18n-title'));
    el.title = value;
    el.setAttribute('aria-label', value);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
}
