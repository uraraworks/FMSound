#!/usr/bin/env node
// MUCOM88 リズムパート(Gパート)が実際に鳴ることの検証。
//
// 背景: docs/rhythm-feasibility.md の調査どおり、原因は
// upstream/MucomWeb/mucom88/src/mucomvm.cpp:192 の `opn->Init(baseclock, 8000, 0)` が
// rhythmpath を渡していないことだった。mucomweb/patches/0003-mucomvm-rhythm-path.patch で
// rhythmpath="/rhythm/" 固定を渡すようにし、html/mucom-app.js がコンパイル前に
// Module.FS.writeFile() でリズムWAV6本をMEMFSのその場所へ書き込むようにした。
// このファイルは「MEMFSへ書けばfopen()経由で本当に読めるか」というdocs/rhythm-feasibility.md
// 1.5節の【未検証】事項を実地で確認する。
//
// 検査内容:
//   A. [陽性対照] リズムWAVをMEMFSへ一切書かない状態でGパートのMMLをコンパイル・
//      レンダリングすると、従来どおり無音(absSum===0)であること。
//      (このファイル自身が「常に非0を返す壊れた検査」でないことの証明。
//      2608_BD.WAV等を一切読んでいないので鳴りようがない、という消極的な確認ではなく、
//      実際にrenderFramesForTest()の絶対値和を測って0であることを確認する)
//   B. リズムWAV6本(html/rhythm/2608_*.WAV)をMEMFSへ書いてから同じMMLを
//      再コンパイル・再レンダリングすると absSum>0(鳴っている)になること。
//   C. Aで使ったMMLと同じインスタンス・同じプロセス内でBを確認しているため、
//      A→Bの遷移(0→非0)自体が「書けば読める」ことの直接証拠になる。
//   D. コンパイルログに #error を含まない(MML自体は正しく処理できている)。
//
// 使うMMLは自作(このファイル内に直書き。著作物ではない短い技術検証用の音符列)。
// docs/rhythm-feasibility.md 2.1節で確認したMUCOM88の仕様どおり、Gパートの
// 音程文字(c等)自体には楽器の意味は無く、直前の`@値`(ビット合計。+1=BD, +2=SD,
// +4=TOP(ライドシンバル), +8=HH, +16=TOM, +32=RIM)が発音楽器を決める
// (出典: Open MUCOM88 Wiki「MMLリファレンス」、2026-08-16 WebFetchで確認。
// 本ファイルはその仕様の要約に基づく独自の検証用MMLであり、Wiki本文の転載はしていない)。
//
// 実行: node tools/verify_mucom_rhythm.mjs
// (mucomweb/build-web/mucom88.js が事前にビルド済みであること。README.mdのビルド手順参照)

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createMucomWeb from '../mucomweb/build-web/mucom88.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const RHYTHM_DIR = path.join(REPO_ROOT, 'html/rhythm');
const SAMPLE_RATE = 55467;

// BD, SD, TOP(ライドシンバル), HH, TOM, RIM を1個ずつ順番に鳴らすだけの短いMML。
// FM/SSG/ADPCMパートは一切使わないため、レンダリング結果はリズムchの出力のみになる
// (=absSumがリズム以外の音源の混入で誤って非0になることがない)。
const RHYTHM_MML = 'G t120 l4 @1c@2c@4c@8c@16c@32c\n';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

async function compileAndGetLog(Module, source) {
  Module.compileMML(source, SAMPLE_RATE);
  const msgPtr = Module.getCompileMessagePointer();
  const msgLen = Module.getCompileMessageLength();
  const bytes = Module.HEAPU8.subarray(msgPtr, msgPtr + msgLen);
  // CP932の生バイトをそのままlatin1へマップし、#error等のASCII部分だけをバイト列で見る
  // (grepでの誤検出事故はfeedback_grep_silently_skips_nel_lines.md参照。ここではgrepを
  // 使わず文字列のindexOf/正規表現で判定する)。
  return Buffer.from(bytes).toString('latin1');
}

async function measureAbsSum(Module, source) {
  const log = await compileAndGetLog(Module, source);
  let absSum = 0;
  for (let i = 0; i < 200; i++) absSum += Module.renderFramesForTest(2048);
  return { absSum, log };
}

function writeRhythmSamplesToMemfs(Module) {
  try {
    Module.FS.mkdir('/rhythm');
  } catch (e) {
    // 既に存在(このプロセス内で2回目に呼ばれた場合)は無視。
  }
  const files = readdirSync(RHYTHM_DIR).filter((f) => f.toUpperCase().endsWith('.WAV'));
  if (files.length !== 6) {
    throw new Error(`html/rhythm/ に想定と異なる本数のWAVがある(6本のはず): ${files.length}本 [${files.join(', ')}]`);
  }
  for (const f of files) {
    const bytes = readFileSync(path.join(RHYTHM_DIR, f));
    Module.FS.writeFile(`/rhythm/${f}`, new Uint8Array(bytes));
  }
  return files;
}

async function main() {
  console.log('=== MUCOM88 リズムパート(Gパート)検証 ===\n');
  console.log('--- 検証用MML ---');
  console.log(RHYTHM_MML);
  console.log('------------------');

  const Module = await createMucomWeb();

  // --- A. [陽性対照] リズムWAVを一切書かない状態 ---
  const before = await measureAbsSum(Module, RHYTHM_MML);
  console.log('--- コンパイルログ(WAV未書き込み) ---');
  console.log(before.log);
  console.log('--------------------------------------');
  check('A. コンパイルログに#errorを含まない(WAV未書き込み)', !/#error/i.test(before.log));
  check('A. [陽性対照] リズムWAV未書き込みの状態ではabsSum===0(従来どおり無音)',
    before.absSum === 0, `absSum=${before.absSum}`);

  // --- B. リズムWAV6本をMEMFSへ書き込んでから再コンパイル ---
  const written = writeRhythmSamplesToMemfs(Module);
  console.log(`MEMFSへ書き込んだファイル: ${written.join(', ')}`);

  const after = await measureAbsSum(Module, RHYTHM_MML);
  console.log('--- コンパイルログ(WAV書き込み後) ---');
  console.log(after.log);
  console.log('--------------------------------------');
  check('D. コンパイルログに#errorを含まない(WAV書き込み後)', !/#error/i.test(after.log));
  check('B. リズムWAVをMEMFSへ書き込むとabsSum>0(鳴っている)',
    after.absSum > 0, `absSum=${after.absSum}`);

  // --- C. 0→非0の遷移そのものが「書けば読める」ことの直接証拠 ---
  check('C. WAV未書き込み(0)と書き込み後(非0)でabsSumが異なる(MEMFS経由でfopen()が実際に読めている証拠)',
    before.absSum !== after.absSum, `before=${before.absSum} after=${after.absSum}`);

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
