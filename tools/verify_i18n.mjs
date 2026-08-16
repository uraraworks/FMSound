#!/usr/bin/env node
// ui/i18n.js(ja/en辞書)の整合性検証。
//
// 検証項目:
//   1. jaとenのキー集合が完全一致すること(片方にしか無いキーがあればFAIL)。
//   2. どちらの言語も値が空文字でないこと。
//   3. enの全ての値に日本語文字(ひらがな・カタカナ・漢字)が含まれないこと(訳し忘れ検出)。
//   4. html/index.html に現れる全てのdata-i18n*属性のキーが辞書に存在すること(タイポ検出)。
//   5. 辞書にあるがhtml/ ui/ のどこからも参照されていないキーを警告として列挙する
//      (FAILにはしない。件数は必ず出力する)。
//
// 実行: node tools/verify_i18n.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DICT } from '../ui/i18n.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passed++; else failed++;
  console.log(`[${mark}] ${label}${detail !== undefined ? '\n       ' + detail : ''}`);
}

// 日本語文字(ひらがな・カタカナ・漢字。全角句読点・記号は誤検出を避けるため対象外)。
const JAPANESE_RE = /[぀-ゟ゠-ヿ一-鿿]/;

function walkFiles(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkFiles(full, exts, out);
    } else if (exts.includes(extname(name))) {
      out.push(full);
    }
  }
  return out;
}

function main() {
  console.log('=== tools/verify_i18n.mjs: ui/i18n.js 辞書の整合性検証 ===\n');

  const jaKeys = new Set(Object.keys(DICT.ja));
  const enKeys = new Set(Object.keys(DICT.en));

  // --- 1. キー集合の完全一致 ---
  const onlyJa = [...jaKeys].filter((k) => !enKeys.has(k));
  const onlyEn = [...enKeys].filter((k) => !jaKeys.has(k));
  check(
    '1. jaとenのキー集合が完全一致する',
    onlyJa.length === 0 && onlyEn.length === 0,
    onlyJa.length || onlyEn.length
      ? `jaのみ: [${onlyJa.join(', ')}] / enのみ: [${onlyEn.join(', ')}]`
      : undefined,
  );

  // --- 2. 値が空文字でない ---
  const emptyJa = [...jaKeys].filter((k) => DICT.ja[k].length === 0);
  const emptyEn = [...enKeys].filter((k) => DICT.en[k].length === 0);
  check(
    '2. どちらの言語も値が空文字でない',
    emptyJa.length === 0 && emptyEn.length === 0,
    emptyJa.length || emptyEn.length ? `空のja: [${emptyJa.join(', ')}] / 空のen: [${emptyEn.join(', ')}]` : undefined,
  );

  // --- 3. enの値に日本語文字が含まれない(訳し忘れ検出) ---
  const untranslated = [...enKeys].filter((k) => JAPANESE_RE.test(DICT.en[k]));
  check(
    '3. enの全ての値に日本語文字が含まれない(訳し忘れ検出)',
    untranslated.length === 0,
    untranslated.length ? untranslated.map((k) => `${k}: "${DICT.en[k]}"`).join('\n       ') : undefined,
  );

  // --- 4. html/index.html のdata-i18n*属性キーが辞書に存在する ---
  const indexHtml = readFileSync(join(REPO_ROOT, 'html/index.html'), 'utf-8');
  const attrRe = /data-i18n(?:-title|-placeholder)?="([^"]+)"/g;
  const usedInHtml = new Set();
  let m;
  while ((m = attrRe.exec(indexHtml))) usedInHtml.add(m[1]);
  const missingFromDict = [...usedInHtml].filter((k) => !jaKeys.has(k));
  check(
    '4. html/index.html のdata-i18n*属性キーが辞書に存在する(タイポ検出)',
    missingFromDict.length === 0,
    missingFromDict.length ? `辞書に無いキー: [${missingFromDict.join(', ')}]` : undefined,
  );

  // --- 5. 辞書にあるがhtml/ ui/ のどこからも参照されていないキー(警告のみ) ---
  const sourceFiles = [
    ...walkFiles(join(REPO_ROOT, 'html'), ['.js', '.html']),
    ...walkFiles(join(REPO_ROOT, 'ui'), ['.js']),
  ];
  const sourceText = sourceFiles.map((f) => readFileSync(f, 'utf-8')).join('\n');
  const unused = [...jaKeys].filter((k) => {
    // data-i18n="key" 属性、またはt('key')/t("key")呼び出しのどちらかで見つかれば「使用中」。
    const asAttr = `"${k}"`;
    const asCallSingle = `'${k}'`;
    const asCallDouble = `"${k}"`;
    return !(sourceText.includes(asAttr) || sourceText.includes(asCallSingle) || sourceText.includes(asCallDouble));
  });
  console.log(
    `[INFO] 5. 辞書にあるがhtml/ ui/ から参照されていないキー: ${unused.length}件` +
    (unused.length ? `\n       [${unused.join(', ')}]` : ''),
  );

  console.log(`\n${passed} PASS, ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
