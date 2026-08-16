#!/usr/bin/env node
// ui/i18n.js の言語決定ロジック(detectLang)とURL同期の純粋関数(computeLangSyncUrl)の
// 検証。2026-08-16、利用者判断による優先順位変更(記憶 > URL > navigator.language)への
// 対応。トグルUI(html/app.js)自体はブラウザ依存(localStorage/location/history)なので
// ここでは検証しない。ここで検証するのはNodeから素で呼べる純粋関数2つ:
//   - detectLang(search, navLang, storedLang) -- 引数注入で完結する決定ロジック
//   - computeLangSyncUrl(currentUrl, decidedLang) -- URL文字列を受け取りURL文字列を返す
//
// 検査内容(利用者指示の8ケースをそのまま番号で対応させる):
//   1. 記憶なし + ?lang=en → en
//   2. 記憶なし + パラメータなし + navigatorがja → ja
//   3. 記憶なし + パラメータなし + navigatorがen → en
//   4. 記憶ja + ?lang=en → ja(この変更の要点: 記憶がURLに勝つ)
//   5. 記憶en + navigatorja → en
//   6. 初回の自動判定(storedLang省略)ではstoreLang()を呼ばない
//      (=保存されないこと。initLang()の実装がstoreLang()を呼ばないことを
//       ソースを読んで確認する形にする。ブラウザのlocalStorageに依存せず、
//       ui/i18n.jsのソーステキストにstoreLang(の呼び出しがinitLang内に
//       無いことを機械的に確認する)。
//   7. トグル後の(想定)URLに?lang=が付かないこと、かつ?driver=が残ること
//      (html/app.jsのswitchLang()はlocation.reload()するだけで検索文字列を
//       一切書き換えない設計。ここではその設計をソース上で確認しつつ、
//       computeLangSyncUrl()自身も「?lang=が無い入力には何も足さない」ことを
//       確認する形で二重に担保する)。
//   8. ?lang=が付いていて記憶に上書きされた場合、URLから?lang=が消えること、
//      かつ他のパラメータは残ること(computeLangSyncUrl()の直接検証)。
//
// 実行: node tools/verify_lang_pref.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { detectLang, computeLangSyncUrl } from '../ui/i18n.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passed++; else failed++;
  console.log(`[${mark}] ${label}${detail !== undefined ? '\n       ' + detail : ''}`);
}

function main() {
  console.log('=== tools/verify_lang_pref.mjs: 言語決定の優先順位とURL同期の検証 ===\n');

  // --- 1. 記憶なし + ?lang=en → en ---
  check('1. 記憶なし + ?lang=en → en',
    detectLang('?lang=en', '', null) === 'en');

  // --- 2. 記憶なし + パラメータなし + navigatorがja → ja ---
  check('2. 記憶なし + パラメータなし + navigator=ja-JP → ja',
    detectLang('', 'ja-JP', null) === 'ja');

  // --- 3. 記憶なし + パラメータなし + navigatorがen → en ---
  check('3. 記憶なし + パラメータなし + navigator=en-US → en',
    detectLang('', 'en-US', null) === 'en');

  // --- 4. 記憶ja + ?lang=en → ja(この変更の要点) ---
  const case4 = detectLang('?lang=en', 'en-US', 'ja');
  check('4. 記憶=ja + ?lang=en(+navigator=en-US) → ja(記憶がURLに勝つ)',
    case4 === 'ja', `結果=${case4}`);

  // --- 5. 記憶en + navigatorja → en ---
  const case5 = detectLang('', 'ja-JP', 'en');
  check('5. 記憶=en + パラメータなし + navigator=ja-JP → en(記憶がnavigatorにも勝つ)',
    case5 === 'en', `結果=${case5}`);

  // 補足: 不正な記憶値(壊れたlocalStorage等)はURL/navigatorへフォールバックする。
  check('補足. 記憶が不正値(ja/en以外)のときはURL(?lang=)を見る',
    detectLang('?lang=en', 'ja-JP', 'fr') === 'en');
  check('補足. 記憶が不正値かつURLも無いときはnavigatorを見る',
    detectLang('', 'ja-JP', 'fr') === 'ja');

  // --- 6. 初回の自動判定ではstoreLang()を呼ばない ---
  // initLang()はブラウザのlocation/localStorageに依存するためNodeから直接実行できない
  // (モジュール評価時にlocation/navigatorへ触れてはいけない設計、ui/i18n.js冒頭コメント
  // 参照)。ここでは「initLang()の関数本体にstoreLang(という呼び出しが現れないこと」を
  // ソーステキストから機械的に確認する形で担保する(=自動判定の結果を焼き付けるコードが
  // 実装として存在しないことの検出)。
  const i18nSrc = readFileSync(new URL('../ui/i18n.js', import.meta.url), 'utf-8');
  const initLangMatch = i18nSrc.match(/export function initLang\(\)\s*\{[\s\S]*?\n\}/);
  check('6. initLang()の実装にstoreLang(呼び出しが含まれない(自動判定は保存しない)',
    !!initLangMatch && !initLangMatch[0].includes('storeLang('),
    initLangMatch ? undefined : 'initLang()の関数本体を抽出できなかった');

  // --- 7. トグル後のURLに?lang=が付かない・?driver=が残る ---
  // html/app.jsのswitchLang()はstoreLang()の後location.reload()するだけで、URLの
  // 検索文字列(location.search)を一切書き換えない設計(=?driver=を含め、いま付いている
  // パラメータがそのまま残り、?lang=も「付いていなければ付かないまま」になる)。
  // ソース上でその設計(URLSearchParams.set('lang', ...)のような「足す」操作が無い)を
  // 確認しつつ、computeLangSyncUrl()自体も「?lang=が無い入力には何も足さない」ことを
  // 直接検証する(二重の担保)。
  const appJsSrc = readFileSync(new URL('../html/app.js', import.meta.url), 'utf-8');
  const switchLangMatch = appJsSrc.match(/function switchLang\([^)]*\)\s*\{[\s\S]*?\n\}/);
  check('7a. switchLang()の実装が検索文字列へ?lang=を足す操作を含まない',
    !!switchLangMatch && !switchLangMatch[0].includes("searchParams.set('lang'"),
    switchLangMatch ? undefined : 'switchLang()の関数本体を抽出できなかった');
  const driverUrlNoLang = 'https://example.com/FMSound/?driver=mucom';
  const syncedNoLang = computeLangSyncUrl(driverUrlNoLang, 'ja');
  check('7b. ?lang=が無いURLにcomputeLangSyncUrl()は何も足さない(?driver=も維持)',
    syncedNoLang === driverUrlNoLang, `結果=${syncedNoLang}`);

  // --- 8. ?lang=が付いていて記憶に上書きされた場合、?lang=が消えて他は残る ---
  const mismatchUrl = 'https://example.com/FMSound/?driver=pmd&lang=en&debug=1';
  const synced = computeLangSyncUrl(mismatchUrl, 'ja');
  const syncedParams = new URL(synced).searchParams;
  check('8. ?lang=がURLから消える(記憶jaと?lang=enが食い違う場合)',
    !syncedParams.has('lang'), `結果=${synced}`);
  check('8. 他のパラメータ(?driver=・?debug=)は残る',
    syncedParams.get('driver') === 'pmd' && syncedParams.get('debug') === '1',
    `結果=${synced}`);

  // 補足: ?lang=が決定した言語と一致している場合は書き換えない(無駄なreplaceStateをしない)。
  const matchUrl = 'https://example.com/FMSound/?lang=ja&driver=pmd';
  check('補足. ?lang=が決定した言語と一致していれば書き換えない',
    computeLangSyncUrl(matchUrl, 'ja') === matchUrl);

  console.log(`\n${passed} PASS, ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
