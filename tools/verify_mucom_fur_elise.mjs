#!/usr/bin/env node
// 課題D: MUCOM88版「エリーゼのために」サンプル(tools/sample_fur_elise_mucom.mml)の検証。
// PMD版(tools/sample_fur_elise.mml)と同じ音符の移植であることのコメントは
// ソース側に記載済み。ここでは「実際に鳴ること」を数値で確認する(鍵盤やFFTの
// 動きではなく、実際のPCM出力の絶対値和=absSumを見る。html/mucom-app.js
// MUCOM_NEW_MML_TEMPLATE修正時と同じ手法、tools/verify_mucom_new_template.mjs参照)。
//
// 検証内容:
//   A. コンパイルエラーが無い。
//   B. コンパイルログに両パート(A/B)のTotal countが0でない(=両パートとも
//      実際にノートが積まれている)ことが出典どおり出ている。
//   C. 実際にレンダリングするとabsSum>0(鳴っている)。
//   D. [陽性対照] 片方のパートだけ(A単独/B単独)を鳴らしてもそれぞれabsSum>0に
//      なる(=absSumが「常に非0を返す壊れた検査」でないことの確認。片方だけを
//      無音化しても検出できることを示す)。
//   E. 4分音符の実時間がPMD版(tools/sample_fur_elise.mml、t30)と近い値になっている
//      (体感速度が揃っていることの実時間ベースの確認。tools/verify_mucom_tempo_absolute.mjs
//      と同じ手法)。
//
// 実行: node tools/verify_mucom_fur_elise.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createMucomWeb from '../mucomweb/build-web/mucom88.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SAMPLE_RATE = 55467;

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

const mml = readFileSync(path.join(REPO_ROOT, 'tools/sample_fur_elise_mucom.mml'), 'utf8');

async function compileAndGetLog(source) {
  const Module = await createMucomWeb();
  Module.compileMML(source, SAMPLE_RATE);
  const msgPtr = Module.getCompileMessagePointer();
  const msgLen = Module.getCompileMessageLength();
  const bytes = Module.HEAPU8.subarray(msgPtr, msgPtr + msgLen);
  const log = Buffer.from(bytes).toString('latin1'); // CP932の生バイトをそのまま文字コードにマップして#error等のASCII部分だけ見る
  return { Module, log };
}

async function measureAbsSum(source) {
  const { Module } = await compileAndGetLog(source);
  let absSum = 0;
  for (let i = 0; i < 200; i++) absSum += Module.renderFramesForTest(2048);
  return absSum;
}

async function main() {
  console.log('=== MUCOM88版 エリーゼのために サンプル検証 ===\n');

  const { log } = await compileAndGetLog(mml);
  console.log('--- コンパイルログ ---');
  console.log(log);
  console.log('----------------------');

  check('A. コンパイルログに#errorを含まない(コンパイルエラー無し)', !/#error/i.test(log), );

  const totalCountMatch = log.match(/\[ Total count \]\s*\nA:(\d+) B:(\d+)/);
  check('B. コンパイルログからTotal count(A/B)を抽出できた', totalCountMatch !== null,
    totalCountMatch ? `A:${totalCountMatch[1]} B:${totalCountMatch[2]}` : undefined);
  if (totalCountMatch) {
    check('B. パートAのTotal countが0でない', Number(totalCountMatch[1]) > 0, `A:${totalCountMatch[1]}`);
    check('B. パートBのTotal countが0でない', Number(totalCountMatch[2]) > 0, `B:${totalCountMatch[2]}`);
  }

  const absSumBoth = await measureAbsSum(mml);
  check('C. 両パートを再生するとabsSum>0(鳴っている)', absSumBoth > 0, `absSum=${absSumBoth}`);

  // --- D. 陽性対照: 片方のパートだけでも鳴る(absSumが常に非0を返す壊れた検査でない証拠) ---
  const onlyA = mml.split('\n').filter((line) => !/^B\b/.test(line)).join('\n');
  const onlyB = mml.split('\n').filter((line) => !/^A\b/.test(line)).join('\n');
  const absSumA = await measureAbsSum(onlyA);
  const absSumB = await measureAbsSum(onlyB);
  check('D. [陽性対照] パートAだけでもabsSum>0', absSumA > 0, `absSum=${absSumA}`);
  check('D. [陽性対照] パートBだけでもabsSum>0', absSumB > 0, `absSum=${absSumB}`);
  check('D. [陽性対照] A単独/B単独/両方でabsSumの値が異なる(検査が実際に数値を見ている証拠)',
    absSumA !== absSumBoth && absSumB !== absSumBoth,
    `A=${absSumA} B=${absSumB} both=${absSumBoth}`);

  // --- E. PMD版との実時間比較 ---
  const tMatch = mml.match(/\bT(\d+)/);
  check('E. サンプルからTの値を抽出できた', tMatch !== null, tMatch ? `T=${tMatch[1]}` : undefined);
  if (tMatch) {
    const bpm = Number(tMatch[1]);
    const expectedQuarterSec = 60 / bpm; // docs/mucom-tempo-commands.md: T=BPM相当
    const pmdSrc = readFileSync(path.join(REPO_ROOT, 'tools/sample_fur_elise.mml'), 'utf8');
    // 行頭がパート文字(A/B)で始まる実際のMMLコマンド行だけを見る(コメント中に
    // 「t50は速すぎた」のような過去の検討値への言及があり、単純な\bt(\d+)\bだと
    // そちらを誤って拾ってしまう)。
    const pmdTMatch = pmdSrc.match(/^[A-K]\s+t(\d+)/m);
    check('E. PMD版サンプルからtの値を抽出できた', pmdTMatch !== null, pmdTMatch ? `t=${pmdTMatch[1]}` : undefined);
    if (pmdTMatch) {
      const pmdTempo = Number(pmdTMatch[1]);
      const pmdExpectedQuarterSec = 30 / pmdTempo; // PMDMML.MAN §11-1
      const relDiff = Math.abs(expectedQuarterSec - pmdExpectedQuarterSec) / pmdExpectedQuarterSec;
      check('E. MUCOM版(T)とPMD版(t)の4分音符の理論実時間が10%以内で一致(体感速度が揃っている)',
        relDiff <= 0.10,
        `mucom=${expectedQuarterSec.toFixed(4)}s(T${bpm}) pmd=${pmdExpectedQuarterSec.toFixed(4)}s(t${pmdTempo}) relDiff=${(relDiff * 100).toFixed(2)}%`);
    }
  }

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
