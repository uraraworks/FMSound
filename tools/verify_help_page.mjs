#!/usr/bin/env node
// html/help.html(使い方ページ)の静的検査。
//
// 検査項目:
//   1. data-lang="ja" と data-lang="en" の data-help-section 属性集合が完全一致すること
//      (片方の言語にしか無い節があればFAIL。節名を出力する)。
//   2. 参照している画像ファイル(<img src>)がhtml/help/配下に実在すること。
//   3. 全ての<img>にalt属性があること(空文字もFAIL。空だと意味のあるaltにならない)。
//   4. target="_blank"な<a>に rel="noopener" が付いていること。
//
// npm依存を追加しない(素のregexで最小限のタグ解析をする。DOMパーサは使わない)。
//
// 実行: node tools/verify_help_page.mjs

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const HELP_HTML_PATH = join(REPO_ROOT, 'html/help.html');
const HTML_DIR = join(REPO_ROOT, 'html');

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passed++; else failed++;
  console.log(`[${mark}] ${label}${detail !== undefined ? '\n       ' + detail : ''}`);
}

/** タグ1つぶんの属性文字列から attr="value" を読む(シングルクォートは本ファイルで未使用のため二重引用符のみ対応)。 */
function getAttr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}

function main() {
  console.log('=== tools/verify_help_page.mjs: html/help.html の静的検査 ===\n');

  const html = readFileSync(HELP_HTML_PATH, 'utf-8');

  // --- 1. data-lang="ja"/"en" の data-help-section 集合が一致する ---
  // data-lang と data-help-section の両方を持つ開始タグを拾う(属性の順序は問わない)。
  const tagRe = /<[a-zA-Z][a-zA-Z0-9]*\b[^>]*>/g;
  const jaSections = new Set();
  const enSections = new Set();
  let tm;
  while ((tm = tagRe.exec(html))) {
    const tag = tm[0];
    const dataLang = getAttr(tag, 'data-lang');
    const section = getAttr(tag, 'data-help-section');
    if (!dataLang || !section) continue;
    if (dataLang === 'ja') jaSections.add(section);
    else if (dataLang === 'en') enSections.add(section);
  }
  const onlyJa = [...jaSections].filter((s) => !enSections.has(s));
  const onlyEn = [...enSections].filter((s) => !jaSections.has(s));
  check(
    '1. data-lang="ja"とdata-lang="en"のdata-help-section集合が完全一致する',
    jaSections.size > 0 && onlyJa.length === 0 && onlyEn.length === 0,
    jaSections.size === 0
      ? 'data-help-sectionを持つ要素が1つも見つからなかった'
      : onlyJa.length || onlyEn.length
        ? `jaのみ: [${onlyJa.join(', ')}] / enのみ: [${onlyEn.join(', ')}]`
        : `${jaSections.size}節(${[...jaSections].join(', ')})`,
  );

  // --- 2. <img src>が実在する ---
  const imgRe = /<img\b[^>]*>/g;
  const imgTags = html.match(imgRe) ?? [];
  const missingImages = [];
  for (const tag of imgTags) {
    const src = getAttr(tag, 'src');
    if (!src) continue; // srcが無いこと自体は項目3(alt)とは別問題。ここでは検査しない。
    // help.htmlはhtml/直下にあるので、相対パスはhtml/を起点に解決する。
    const resolved = join(HTML_DIR, src);
    if (!existsSync(resolved)) missingImages.push(src);
  }
  check(
    '2. <img src>が参照する画像ファイルが実在する',
    missingImages.length === 0,
    missingImages.length ? `見つからない: [${missingImages.join(', ')}]` : `${imgTags.length}枚を確認`,
  );

  // --- 3. 全ての<img>にalt属性がある(空文字は不可) ---
  const missingAlt = [];
  for (const tag of imgTags) {
    const alt = getAttr(tag, 'alt');
    const src = getAttr(tag, 'src') ?? '(srcなし)';
    if (alt === null || alt.trim().length === 0) missingAlt.push(src);
  }
  check(
    '3. 全ての<img>に意味のあるalt属性がある(空文字不可)',
    missingAlt.length === 0,
    missingAlt.length ? `altが無い/空: [${missingAlt.join(', ')}]` : undefined,
  );

  // --- 4. target="_blank"なリンクにrel="noopener"が付いている ---
  const aRe = /<a\b[^>]*>/g;
  const aTags = html.match(aRe) ?? [];
  const missingNoopener = [];
  let blankLinkCount = 0;
  for (const tag of aTags) {
    if (getAttr(tag, 'target') !== '_blank') continue;
    blankLinkCount++;
    const rel = getAttr(tag, 'rel') ?? '';
    const hasNoopener = rel.split(/\s+/).includes('noopener');
    if (!hasNoopener) {
      missingNoopener.push(getAttr(tag, 'href') ?? '(hrefなし)');
    }
  }
  check(
    '4. target="_blank"なリンクにrel="noopener"が付いている',
    missingNoopener.length === 0,
    missingNoopener.length
      ? `noopenerが無い: [${missingNoopener.join(', ')}]`
      : `target="_blank"なリンク${blankLinkCount}件を確認`,
  );

  console.log(`\n${passed} PASS, ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
