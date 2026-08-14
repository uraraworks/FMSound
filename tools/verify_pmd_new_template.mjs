#!/usr/bin/env node
// html/pmd-app.js PMD_NEW_MML_TEMPLATE の実測確認(2026-08-15 コーディネータ指示:
// MUCOM88側の「新規作成の雛形が無音」不具合修正のついでに、PMD側も念のため確認)。
//
// PMD側は雛形自体にFM音色定義(@ 1 7 0 ...)が最初から含まれているため無音になる
// 理由が無い見込みだが、「表示ではなく実際のPCM出力で確認する」という今回の教訓
// (MUCOM88側は鍵盤表示だけを信じて無音を見逃した)を踏まえ、absSum(PCM絶対値和、
// Module.renderFramesForTest())で数値として確認する。
//
// 実行: node tools/verify_pmd_new_template.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import { compileMml } from '../compiler/pmd_mml_compiler.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let failed = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failed++;
  console.log(`[${mark}] ${label}${detail !== undefined ? ' - ' + detail : ''}`);
}

function extractTemplate() {
  const src = readFileSync(path.join(REPO_ROOT, 'html/pmd-app.js'), 'utf8');
  const m = src.match(/const PMD_NEW_MML_TEMPLATE = `([\s\S]*?)`;/);
  if (!m) throw new Error('PMD_NEW_MML_TEMPLATE が見つかりません(html/pmd-app.js の定義形式が変わった?)');
  return m[1];
}

async function main() {
  const template = extractTemplate();
  console.log('--- 抽出したPMD_NEW_MML_TEMPLATE ---');
  console.log(template);
  console.log('-------------------------------------');

  const { file, errors } = compileMml(template);
  check('雛形がコンパイルエラー無しで.Mになる', errors.length === 0, JSON.stringify(errors));

  const Module = await createPmdWeb();
  Module.FS.writeFile('/edited.M', file);
  const playError = Module.playMusic('/edited.M');
  check('playMusic()がエラーを返さない', playError === '', `error=${playError}`);

  let absSum = 0;
  for (let i = 0; i < 100; i++) absSum += Module.renderFramesForTest(2048);
  check('雛形はabsSum>0(実際に音が出ている。表示ではなくPCM出力で確認)', absSum > 0, `absSum=${absSum}`);

  console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} 件 FAIL`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
