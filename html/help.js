// 使い方ページ(html/help.html)のブートストラップ。
//
// アプリ本体(html/app.js)と同じ言語決定・記憶の仕組みにそのまま乗る: ui/i18n.js の
// initLang()(記憶 > ?lang= > navigator.language)をそのまま使い、同じ localStorage
// キー(fmsound-lang)を読み書きする。本体と同一origin配信のため、記憶は自動で共有される
// (本体で選んだ言語のままこのページを開ける/逆も同様)。
//
// このファイルが持つのはUI由来のラベル(見出し以外の固定文言)の流し込みと、
// 本文(data-lang="ja"/"en"のブロック)の表示切替・言語トグルの配線だけ。
// 本文そのもの(長文)は辞書に入れず、html/help.html側に2言語ぶん並べて持たせる
// (利用者指示: 段落ごとに辞書キーを切ると辞書が肥大するため)。

import { initLang, t, applyStaticI18n, storeLang, otherLang, langToggleLabel, withLangParam } from './ui/i18n.js';

const lang = initLang();
document.getElementById('htmlRoot').lang = lang;
document.title = `${t('help.pageTitle')} — FMSound`;
applyStaticI18n();

// --- 「← アプリに戻る」リンク(html/help.html、上下2箇所)にも今表示している言語を
// 引き継がせる(withLangParam()、html/app.js側のヘルプボタンと対で直す。ここも
// 直さないとヘルプ→アプリの往復で今度は逆向きに言語が食い違う)。
document.querySelectorAll('.help-back a').forEach((a) => {
  a.href = withLangParam('./index.html', lang);
});

// --- 本文(data-lang="ja"/"en")の表示切替 ---
// アプリ本体はキーごとに辞書を引くが、ここは「長文の2言語ブロックを両方DOMに置き、
// 表示側だけ切り替える」方式(hidden属性)。data-help-section(節名)はここでは
// 参照しない(tools/verify_help_page.mjsが静的にHTMLを検査する専用の目印のため、
// 実行時のこのスクリプトは関与しない)。
function applyContentLang(activeLang) {
  document.querySelectorAll('[data-lang]').forEach((el) => {
    el.hidden = el.getAttribute('data-lang') !== activeLang;
  });
}
applyContentLang(lang);

// --- 言語切替トグル(html/app.jsのlangToggleBtnと同じ作法) ---
const langToggleBtn = document.getElementById('langToggleBtn');
function updateLangToggleBtn() {
  langToggleBtn.textContent = langToggleLabel(lang);
  langToggleBtn.setAttribute('aria-label', t('toolbar.langToggleAriaLabel'));
}
updateLangToggleBtn();
function switchLang(next) {
  if (next === lang) return;
  storeLang(next);
  location.reload();
}
langToggleBtn.addEventListener('click', () => switchLang(otherLang(lang)));
