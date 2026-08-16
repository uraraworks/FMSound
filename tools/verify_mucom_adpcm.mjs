#!/usr/bin/env node
// MUCOM88 Kパート(ADPCM)が実際に鳴ることの検証。
//
// 背景: Kパートが無音だった原因は、標準PCMバンク(upstream/MucomWeb/mucom88/package/
// mucompcm.bin)を一度も読み込んでいなかったこと(ADPCM再生機構自体は生きている)。
// mucomweb/src/MucomWeb.cpp CompileMML() が g_mucom->LoadPCM("/mucompcm.bin") を
// LoadMusic()/Play()より前に呼ぶよう追加し、html/mucom-app.js がコンパイル前に
// Module.FS.writeFile() でこのバンクをMEMFSの/mucompcm.binへ書き込むようにした。
// このファイルは3条件全てを実測して確認する:
//
//   A. [陰性対照] バンクをMEMFSに置かずにKパートのMMLをレンダリングすると、
//      absSumが0(またはごく小さい閾値以下)であること(=修正前の症状の再現)。
//   B. [本体] バンクを置いた同じMMLのabsSumが明確に非0であること。
//   C. [陽性対照] バンクを置いた状態で `K @1 ...`(kick)と `K @11 ...`
//      (808openhihat)をレンダリングし、absSumが互いに異なること
//      (=PCM番号の違いが出力に出ることの確認。これが取れて初めてAの「0」を
//      意味のある否定として読める)。
//
// PCM番号の対応(upstream/MucomWeb/mucom88/package/mucompcm.bin 情報テーブル、
// オフセット0-15の名前を実測で確認): @1=index0=kick, @11=index10=808openhihat。
// MMLの`@n`記法はupstream/MucomWeb/mucom88/package/sampl1.mucのKパート
// (`@1c8`, `@11c8`等)を参考にした(1-indexedでinfoテーブルのindexに対応)。
//
// 実行: node tools/verify_mucom_adpcm.mjs
// (mucomweb/build-web/mucom88.js が事前にビルド済みであること。README.mdのビルド手順参照)

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createMucomWeb from '../mucomweb/build-web/mucom88.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PCM_BANK_PATH = path.join(REPO_ROOT, 'html/mucompcm.bin');
const SAMPLE_RATE = 55467;

// Kパートのみ(kick=@1)。他パートは一切使わないため、レンダリング結果はADPCMchの
// 出力のみになる(=absSumが他音源の混入で誤って非0になることがない)。
const K_MML_KICK = 'K T120 o1 v50 @1c8@1c8@1c8@1c8\n';
// 陽性対照用: 808openhihat(@11)版。@1版と同じ長さ・音程・音量で楽器番号だけ違う。
const K_MML_OPENHAT = 'K T120 o1 v50 @11c8@11c8@11c8@11c8\n';

// [陰性対照]の許容閾値。バンク未書き込みでもLoadPCM()が呼ばれず#PCM data not
// foundのままADPCM RAMが未初期化の状態でrenderするため、厳密に0にはならず数千程度の
// 残留ノイズが出ることを実測で確認した(絶対値和1872、200回×2048フレーム×2ch=
// 819200サンプル分の合計。1サンプルあたり0.002未満で無音相当)。本体(バンク書き込み後)
// のabsSumは1.9億台と桁違いに大きいため、この閾値は「鳴っていない」と「鳴っている」を
// 十分separateできる(閾値を本体側の値に寄せて緩めてはいない)。
const SILENCE_ABS_SUM_THRESHOLD = 100000;

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

async function main() {
  console.log('=== MUCOM88 Kパート(ADPCM)検証 ===\n');

  const Module = await createMucomWeb();

  // --- A. [陰性対照] PCMバンクを一切書かない状態 ---
  console.log('--- 検証用MML(kick) ---');
  console.log(K_MML_KICK);
  const before = await measureAbsSum(Module, K_MML_KICK);
  console.log('--- コンパイルログ(バンク未書き込み) ---');
  console.log(before.log);
  console.log('------------------------------------------');
  check('A. コンパイルログに#errorを含まない(バンク未書き込み)', !/#error/i.test(before.log));
  check('A. [陰性対照] バンク未書き込みの状態ではabsSumが閾値以下(従来どおり無音相当)',
    before.absSum <= SILENCE_ABS_SUM_THRESHOLD,
    `absSum=${before.absSum} (閾値=${SILENCE_ABS_SUM_THRESHOLD})`);

  // --- B. PCMバンクをMEMFSへ書き込んでから再コンパイル ---
  const bankBytes = readFileSync(PCM_BANK_PATH);
  Module.FS.writeFile('/mucompcm.bin', new Uint8Array(bankBytes));
  console.log(`MEMFSへ書き込んだファイル: /mucompcm.bin (${bankBytes.length} bytes)`);

  const after = await measureAbsSum(Module, K_MML_KICK);
  console.log('--- コンパイルログ(バンク書き込み後・kick) ---');
  console.log(after.log);
  console.log('------------------------------------------------');
  check('D. コンパイルログに#errorを含まない(バンク書き込み後)', !/#error/i.test(after.log));
  check('B. [本体] バンクをMEMFSへ書き込むとabsSumが陰性対照の閾値を明確に上回る(鳴っている)',
    after.absSum > SILENCE_ABS_SUM_THRESHOLD,
    `absSum=${after.absSum} (閾値=${SILENCE_ABS_SUM_THRESHOLD})`);
  check('C0. バンク未書き込み(0)と書き込み後(非0)でabsSumが異なる(MEMFS経由でfopen()が実際に読めている証拠)',
    before.absSum !== after.absSum, `before=${before.absSum} after=${after.absSum}`);

  // --- C. [陽性対照] @1(kick)と@11(808openhihat)でabsSumが異なること ---
  console.log('--- 検証用MML(808openhihat) ---');
  console.log(K_MML_OPENHAT);
  const openhat = await measureAbsSum(Module, K_MML_OPENHAT);
  console.log('--- コンパイルログ(バンク書き込み後・808openhihat) ---');
  console.log(openhat.log);
  console.log('---------------------------------------------------------');
  check('E. コンパイルログに#errorを含まない(808openhihat)', !/#error/i.test(openhat.log));
  check('C. [陽性対照] @1(kick)と@11(808openhihat)でabsSumが異なる(PCM番号の違いが出力に出る証拠)',
    after.absSum !== openhat.absSum, `kick=${after.absSum} openhihat=${openhat.absSum}`);

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
