#!/usr/bin/env node
// dist/(tools/build_dist.shが組み立てるGitHub Pages配信物)配下の全JS/MJS/HTMLについて、
// 相対import指定子(from '...' / import('...') / <script src> / <link href>)が
// (a) dist/の外へ出ていないこと (b) 解決先のファイルが実在すること を検査する。
//
// 背景(2026-08-16〜17): html/help.js が `../ui/i18n.js` (親ディレクトリ参照)を
// importしていた。dist/ 直下(GitHub Pagesではhttps://.../FMSound/直下)では
// `../ui/` は dist/ の外(プロジェクトの外)を指し404になり、help.jsのモジュール読込
// 自体が失敗して中身が一切実行されない(=言語の出し分け・タイトル書き換えが起きない)
// という壊れ方をした。手元の検証サーバはdistをドメイン直下(オリジンのルート)で
// 配信していたため `../` がrootで頭打ちになり「たまたま」正しく解決していて、
// この種の間違いは手元では原理的に検出できなかった(GitHub Pagesがプロジェクト配下
// `/FMSound/` にある場合だけ症状が出る)。
//
// このスクリプトは「dist/を1つのオリジンのルートとして配信する」という前提を
// 静的に模して、各ファイルからの相対パス解決だけでこの種の間違いを機械的に検出する
// (実際にサーバを立てない。パス文字列の解決のみ)。
//
// 検査対象の指定子の集め方(すべて相対パス './' '../' で始まるものだけ。裸指定子や
// 絶対URL・data:は対象外):
//   - JS/MJS: `from '...'` 系の静的import・re-export、`import('...')` の動的import
//     (リテラル文字列のときだけ。html/app.jsの `import(modulePath)` のような変数は
//     静的に追えないため対象外。tools/apply_cache_bust.pyが末尾に付ける `?v=<hash>` は
//     解決前に取り除く)。
//   - HTML: `src="./..."` `href="./..."` (script/link)。同じく `?v=` を除く。
//
// 実行: node tools/verify_dist_import_paths.mjs (事前に tools/build_dist.sh が必要。
// distを指定したい場合は第1引数で上書きできる(スクラッチ環境での陽性対照用)。

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = path.resolve(process.argv[2] ?? path.join(REPO_ROOT, 'dist'));

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passed++; else failed++;
  console.log(`[${mark}] ${label}${detail !== undefined ? '\n       ' + detail : ''}`);
}

// JS: `from '...'` (静的import/re-export) と `import('...')` (動的import、リテラルのみ)
const JS_IMPORT_RE = /\bfrom\s*(['"])(\.\.?\/[^'"]+)\1|\bimport\s*\(\s*(['"])(\.\.?\/[^'"]+)\3\s*\)/g;
// HTML: script src / link href
const HTML_REF_RE = /\b(?:src|href)\s*=\s*(['"])(\.\/[^'"]+\.(?:js|mjs|css))\1/g;

function stripQuery(spec) {
  const q = spec.indexOf('?');
  return q === -1 ? spec : spec.slice(0, q);
}

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

function extractSpecs(text, re, groupsOfInterest) {
  const specs = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    for (const g of groupsOfInterest) {
      if (m[g]) specs.push(m[g]);
    }
  }
  return specs;
}

function main() {
  console.log('=== tools/verify_dist_import_paths.mjs: dist/の相対import/参照がdist外へ出ないことの検査 ===\n');
  console.log(`対象: ${DIST}\n`);

  if (!existsSync(DIST)) {
    console.error(`FATAL: ${DIST} が無い。先に tools/build_dist.sh を実行すること。`);
    process.exit(1);
  }

  const allFiles = walk(DIST);
  const jsFiles = allFiles.filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
  const htmlFiles = allFiles.filter((f) => f.endsWith('.html'));

  check('走査対象が見つかる(JS/MJS 1件以上、HTML 1件以上)',
    jsFiles.length > 0 && htmlFiles.length > 0,
    `js/mjs=${jsFiles.length}件, html=${htmlFiles.length}件`);

  let violations = 0;
  let checkedSpecCount = 0;

  function verifyFile(file, specs, sourceLabel) {
    const dir = path.dirname(file);
    for (const rawSpec of specs) {
      const spec = stripQuery(rawSpec);
      checkedSpecCount++;
      const resolved = path.resolve(dir, spec);
      const rel = path.relative(DIST, resolved);
      const escapesDist = rel.startsWith('..') || path.isAbsolute(rel);
      const exists = !escapesDist && existsSync(resolved) && statSync(resolved).isFile();
      const ok = !escapesDist && exists;
      if (!ok) {
        violations++;
        const reason = escapesDist ? 'dist/の外を指している' : 'ファイルが存在しない';
        check(`${sourceLabel}: '${rawSpec}' → ${reason}`, false,
          `解決先=${resolved}`);
      }
    }
  }

  for (const file of jsFiles) {
    const text = readFileSync(file, 'utf-8');
    const specs = extractSpecs(text, JS_IMPORT_RE, [2, 4]);
    verifyFile(file, specs, `js:${path.relative(DIST, file)}`);
  }

  for (const file of htmlFiles) {
    const text = readFileSync(file, 'utf-8');
    const specs = extractSpecs(text, HTML_REF_RE, [2]);
    verifyFile(file, specs, `html:${path.relative(DIST, file)}`);
  }

  check(`dist/配下の相対import/参照(${checkedSpecCount}件走査)がすべてdist/内の実在ファイルに解決される`,
    violations === 0,
    violations === 0 ? undefined : `${violations}件の違反(内訳は上のFAIL行)`);

  console.log(`\n${passed} PASS, ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
