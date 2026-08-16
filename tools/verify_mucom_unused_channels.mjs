#!/usr/bin/env node
// 未使用パート暗色化機能(利用者指示B)の検証4: MUCOM88側の「曲が使っていない
// パート」判定(fmdsp/channel-mask.js usedChannelsFromMucomCompileLog)を、
// 実際にwasm側(Module.compileMML)でMMLをコンパイルして得たログで検証する。
//
// Kパート(ADPCM)を使うMMLと使わないMMLの2種類を実際にコンパイルし、
// 判定結果(ADPCM_CHANNELがusedChannelsに含まれるかどうか)が変わることを実測する
// (利用者指示: 同じ判定器が両方で同じ答えを返したらFAIL)。
//
// 実行: node tools/verify_mucom_unused_channels.mjs
// (mucomweb/build-web/mucom88.js が事前にビルド済みであること)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createMucomWeb from '../mucomweb/build-web/mucom88.js';
import {
  usedChannelsFromMucomCompileLog, FM_CHANNELS, SSG_CHANNELS, RHYTHM_CHANNEL, ADPCM_CHANNEL,
} from '../fmdsp/channel-mask.js';

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

async function compileAndGetLog(Module, source) {
  Module.compileMML(source, SAMPLE_RATE);
  const msgPtr = Module.getCompileMessagePointer();
  const msgLen = Module.getCompileMessageLength();
  const bytes = Module.HEAPU8.subarray(msgPtr, msgPtr + msgLen);
  // #error等ASCII部分の判定・"[ Total count ]"行の読み取りにしか使わないため、
  // tools/measure_mucom_adpcm_corpus.mjsと同じくlatin1で足りる。
  return Buffer.from(bytes).toString('latin1');
}

async function main() {
  console.log('=== MUCOM88「曲が使っていないパート」判定の実測検証(fmdsp/channel-mask.js) ===\n');
  const Module = await createMucomWeb();

  // A. FM1(A)とADPCM(K)を両方使うMML -> ADPCM_CHANNELがusedChannelsに含まれるはず。
  const mmlWithK = 'A @78 T120 o4 v100 l4 cdefgab>c<\nK T120 o1 v50 @1c8@1c8@1c8@1c8\n';
  const logWithK = await compileAndGetLog(Module, mmlWithK);
  const usedWithK = usedChannelsFromMucomCompileLog(logWithK);
  check('A. Kパートを使うMML: コンパイルログから使用チャンネルが判定できる(null出ない)',
    usedWithK !== null, `usedWithK=${usedWithK ? [...usedWithK].join(',') : usedWithK}`);
  check('A. Kパートを使うMML: ADPCM_CHANNELが使用チャンネルに含まれる',
    usedWithK?.has(ADPCM_CHANNEL) === true, `usedWithK=${usedWithK ? [...usedWithK].join(',') : usedWithK}`);
  check('A. Kパートを使うMML: FM1が使用チャンネルに含まれる',
    usedWithK?.has(FM_CHANNELS[0]) === true);
  check('A. Kパートを使うMML: 触れていないFM2は使用チャンネルに含まれない(=未使用判定できている)',
    usedWithK?.has(FM_CHANNELS[1]) === false);

  // B. FM1(A)だけを使い、Kパートには触れないMML -> ADPCM_CHANNELは使用チャンネルに
  //    含まれないはず(=「Kパートを使わないMML」)。
  const mmlWithoutK = 'A @78 T120 o4 v100 l4 cdefgab>c<\n';
  const logWithoutK = await compileAndGetLog(Module, mmlWithoutK);
  const usedWithoutK = usedChannelsFromMucomCompileLog(logWithoutK);
  check('B. Kパートを使わないMML: コンパイルログから使用チャンネルが判定できる(null出ない)',
    usedWithoutK !== null, `usedWithoutK=${usedWithoutK ? [...usedWithoutK].join(',') : usedWithoutK}`);
  check('B. Kパートを使わないMML: ADPCM_CHANNELは使用チャンネルに含まれない',
    usedWithoutK?.has(ADPCM_CHANNEL) === false, `usedWithoutK=${usedWithoutK ? [...usedWithoutK].join(',') : usedWithoutK}`);

  // 本体: AとBで同じ判定器(usedChannelsFromMucomCompileLog)が異なる答えを返す
  // (=同一の判定器が両方で同じ答えを返したらFAIL、という利用者指示の主条件)。
  check('[本体] Kパートの有無でADPCM_CHANNELの判定が変わる(同じ判定器が両方で同じ答えを返していない)',
    (usedWithK?.has(ADPCM_CHANNEL) ?? null) !== (usedWithoutK?.has(ADPCM_CHANNEL) ?? null),
    `withK=${usedWithK?.has(ADPCM_CHANNEL)} withoutK=${usedWithoutK?.has(ADPCM_CHANNEL)}`);

  // C. コンパイル失敗ログ(#error)を渡すと、"[ Total count ]"行自体が無いためnullを
  //    返す(でっち上げない。判定不能はnullで表す設計の確認)。
  // "["を閉じずに使う(ループのネスト過多、#error 4)は実測で確実にコンパイルエラーに
  // なることを確認済み(単に未知の文字を混ぜただけのMMLはMUCOM88のパーサが寛容で、
  // 普通にコンパイルが通ってしまい実測で確認できなかった)。
  const brokenMml = 'A [c';
  const brokenLog = await compileAndGetLog(Module, brokenMml);
  const usedBroken = usedChannelsFromMucomCompileLog(brokenLog);
  check('C. コンパイル失敗ログはnull(判定不能。でっち上げない)', usedBroken === null,
    `usedBroken=${usedBroken}`);

  // [陽性対照] わざと壊す: ログ本文を空文字にすると必ずnullになることを確認し、
  // usedChannelsFromMucomCompileLog自体が「何でもSetを返す」壊れた実装になって
  // いないことを確認する。
  check('[陽性対照] 空文字列を渡すとnull(パーサが実際にログ内容を見ている確認)',
    usedChannelsFromMucomCompileLog('') === null);
  check('[陽性対照] "[ Total count ]"はあるが直後の行が空のログはnull',
    usedChannelsFromMucomCompileLog('[ Total count ]\n\n') === null);

  console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
  if (failCount > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
