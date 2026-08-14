#!/usr/bin/env node
// 「MUCOM88の新規作成の雛形が無音」不具合の再発防止検証(2026-08-15 利用者報告)。
//
// 原因: MUCOM88はFMチャンネルの発音に音色バンク選択(`@`)を要求する作りで、
// 未指定だと有効な音色が載らずノートは処理されるが無音になる。FMDSPの鍵盤が動く
// のはドライバがノートを処理している証拠であって、音が出ている証拠ではない
// (表示と音は別物)。表示ではなく実際のPCM出力の絶対値和(absSum、
// Module.renderFramesForTest()、tools/verify_pmd_min.mjsと同じ手法)を測って確認する。
//
// 検査内容:
//   (a) `@`を外した雛形相当のMMLはabsSum===0(無音)であることを確認する
//       (陽性対照: この検査自体が「常に0以外を返して見逃す」壊れた検査でないことの
//       確認も兼ねる。もし(a)がFAILしたら、この検査は無音を検出できていないことになる)。
//   (b) 実際に html/mucom-app.js の MUCOM_NEW_MML_TEMPLATE (`@78`入り)を
//       コンパイル・レンダリングし、absSum>0(非0=鳴っている)であることを確認する。
//   (c) 陽性対照: absSumが「常に0より大きいことにしてしまう」壊れた検査でないことを
//       確認するため、(a)の無音ケースで実際に0になることを再確認してから(b)を見る
//       (0と非0の両方を実測で作り分けられていることの証明)。
//
// 実行: node tools/verify_mucom_new_template.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createMucomWeb from '../mucomweb/build-web/mucom88.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let failed = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failed++;
  console.log(`[${mark}] ${label}${detail !== undefined ? ' - ' + detail : ''}`);
}

async function measureAbsSum(mml) {
  const Module = await createMucomWeb();
  Module.compileMML(mml, 55467);
  let absSum = 0;
  for (let i = 0; i < 100; i++) absSum += Module.renderFramesForTest(2048);
  return absSum;
}

// html/mucom-app.js から実際の雛形定数を取り出す(値のコピペではなく、本物のソースを
// 読んで検証する。定数がずれても検査が追従する)。
function extractTemplate() {
  const src = readFileSync(path.join(REPO_ROOT, 'html/mucom-app.js'), 'utf8');
  const m = src.match(/const MUCOM_NEW_MML_TEMPLATE = `([\s\S]*?)`;/);
  if (!m) throw new Error('MUCOM_NEW_MML_TEMPLATE が見つかりません(html/mucom-app.js の定義形式が変わった?)');
  return m[1];
}

async function main() {
  const template = extractTemplate();
  console.log('--- 抽出したMUCOM_NEW_MML_TEMPLATE ---');
  console.log(template);
  console.log('---------------------------------------');

  check('雛形に音色指定(@)が含まれている(修正の確認)', /@\d/.test(template));

  // (a) `@`を外した(=修正前と同等の)MMLは無音になることを確認する。
  const withoutAt = 'A C120 o5 l4 v10 cdefgab>c<\n';
  const absSumSilent = await measureAbsSum(withoutAt);
  check('[陽性対照] `@`無しのMMLはabsSum===0(無音。修正前の不具合の再現)', absSumSilent === 0,
    `absSum=${absSumSilent}`);

  // (b) 実際の雛形(修正後)は鳴ることを確認する。
  const absSumTemplate = await measureAbsSum(template);
  check('修正後の雛形(MUCOM_NEW_MML_TEMPLATE)はabsSum>0(鳴っている)', absSumTemplate > 0,
    `absSum=${absSumTemplate}`);

  // (c) 検査ロジックの生存確認: 無音(0)と非0を実測で作り分けられていることの再確認。
  check('[陽性対照] 無音ケースと雛形ケースでabsSumが異なる(検査が実際に数値を見ている証拠)',
    absSumSilent !== absSumTemplate, `silent=${absSumSilent} template=${absSumTemplate}`);

  console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} 件 FAIL`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
