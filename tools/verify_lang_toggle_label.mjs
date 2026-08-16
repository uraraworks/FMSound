#!/usr/bin/env node
// ui/i18n.js の言語切替ボタン用の純粋関数の検証(2026-08-16、利用者判断:
// JA/ENの2ボタンから1つのトグルボタンへの変更)。
//
// 検証対象:
//   - langToggleLabel(lang) -- ボタンに表示する文字列(「現在の言語」ではなく
//     「押したら切り替わる先の言語」をendonymで返す)。
//   - otherLang(lang) -- 切り替え先の言語コード。
//   - toolbar.langToggleAriaLabel -- aria-labelの辞書キー。ja/enどちらの値も
//     空でないこと(tools/verify_i18n.mjsは辞書全体の整合性を見るが、ここでは
//     「この変更で追加したキーが実際に両言語とも埋まっているか」をピンポイントで見る)。
//
// 実行: node tools/verify_lang_toggle_label.mjs

import { langToggleLabel, otherLang, DICT, t, setLang } from '../ui/i18n.js';

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passed++; else failed++;
  console.log(`[${mark}] ${label}${detail !== undefined ? '\n       ' + detail : ''}`);
}

function main() {
  console.log('=== tools/verify_lang_toggle_label.mjs: 言語切替ボタンの表示文字列の検証 ===\n');

  // --- langToggleLabel(): jaを渡すと英語側(English)を返す ---
  const jaResult = langToggleLabel('ja');
  check('1. langToggleLabel("ja") === "English"', jaResult === 'English', `結果=${jaResult}`);

  // --- langToggleLabel(): enを渡すと日本語側(日本語)を返す ---
  const enResult = langToggleLabel('en');
  check('2. langToggleLabel("en") === "日本語"', enResult === '日本語', `結果=${enResult}`);

  // --- 今回の変更の要点: 現在の言語と同じものを返さない ---
  check('3. langToggleLabel("ja") は現在の言語(ja)のendonym("日本語")を返さない',
    jaResult !== '日本語', `結果=${jaResult}`);
  check('4. langToggleLabel("en") は現在の言語(en)のendonym("English")を返さない',
    enResult !== 'English', `結果=${enResult}`);

  // --- otherLang(): 常に現在と異なる言語コードを返す ---
  check('5. otherLang("ja") === "en"', otherLang('ja') === 'en');
  check('6. otherLang("en") === "ja"', otherLang('en') === 'ja');

  // --- aria-labelは辞書(ui/i18n.js)から引く。両言語とも空でないこと ---
  check('7. DICT.ja["toolbar.langToggleAriaLabel"] が空でない',
    typeof DICT.ja['toolbar.langToggleAriaLabel'] === 'string' && DICT.ja['toolbar.langToggleAriaLabel'].length > 0,
    `結果="${DICT.ja['toolbar.langToggleAriaLabel']}"`);
  check('8. DICT.en["toolbar.langToggleAriaLabel"] が空でない',
    typeof DICT.en['toolbar.langToggleAriaLabel'] === 'string' && DICT.en['toolbar.langToggleAriaLabel'].length > 0,
    `結果="${DICT.en['toolbar.langToggleAriaLabel']}"`);

  // --- t()経由でも同じ値が引けること(setLang()でtの参照言語を切り替えて確認) ---
  setLang('ja');
  const ariaJa = t('toolbar.langToggleAriaLabel');
  check('9. setLang("ja")後、t("toolbar.langToggleAriaLabel") === DICT.jaの値',
    ariaJa === DICT.ja['toolbar.langToggleAriaLabel'], `結果="${ariaJa}"`);
  setLang('en');
  const ariaEn = t('toolbar.langToggleAriaLabel');
  check('10. setLang("en")後、t("toolbar.langToggleAriaLabel") === DICT.enの値',
    ariaEn === DICT.en['toolbar.langToggleAriaLabel'], `結果="${ariaEn}"`);

  console.log(`\n${passed} PASS, ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
