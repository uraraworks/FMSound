#!/usr/bin/env node
// トラック行クリックミュート機能の実測(MUCOM88側)。tools/verify_channel_mask.mjs
// の純粋関数テストだけでは「マスク値が正しいビット位置になっているか」までしか
// 確認できない。ここではその値を実際にwasm側のOPNA::SetChannelMask()へ渡し、
// 生成される音声のabsSumが期待通りに変化することを実測する(ここが本体)。
//
// MML: FM1(A)とADPCM(K)を同時に鳴らす。
//   A. 何もミュートしない -> absSum(baseline)
//   B. K以外(FM1-6,SSG1-3,リズム)を全部ミュート -> absSumが非0であること
//      (=ADPCMchが残っている証拠。Aと比べて減っているのはFM1が消えたぶん)
//   C. Kだけをミュート -> absSumがAより明確に減ること(=ADPCMchが消えている証拠)
//   D. 全部ミュート -> absSumがほぼ0であること(陽性対照。0にならないなら
//      マスクが効いていない)
// BとCが両方成立して初めて「Kのビットが正しい」と言える。片方だけでは別
// チャンネルを消していても通ってしまう(タスク指示の通り)。
//
// 実行: node tools/verify_mucom_channel_mute.mjs
// (mucomweb/build-web/mucom88.js が事前にビルド済みであること)

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createMucomWeb from '../mucomweb/build-web/mucom88.js';
import {
  buildMucomChannelMask, FM_CHANNELS, SSG_CHANNELS, ADPCM_CHANNEL, RHYTHM_CHANNEL,
} from '../fmdsp/channel-mask.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PCM_BANK_PATH = path.join(REPO_ROOT, 'html/mucompcm.bin');
const SAMPLE_RATE = 55467;

// FM1(A)を長めに、K(ADPCM)はkick(@1)を4連打。tools/verify_mucom_adpcm.mjsの
// K_MML_KICKと同じ楽器番号・長さを踏襲する。
// FM側は音色(@n)を指定しないと無音になる(tools/verify_mucom_new_template.mjs
// 「[陽性対照] `@`無しのMMLはabsSum===0」で確認済みの既知の仕様)。@78は
// tools/verify_mucom_tempo_absolute.mjsが使っている音色番号を流用する。
const MML = 'A @78 T120 o4 v100 l4 cdefgab>c<\nK T120 o1 v50 @1c8@1c8@1c8@1c8\n';

const ALL_MUTABLE = new Set([...FM_CHANNELS, ...SSG_CHANNELS, RHYTHM_CHANNEL, ADPCM_CHANNEL]);
const ALL_EXCEPT_ADPCM = new Set([...FM_CHANNELS, ...SSG_CHANNELS, RHYTHM_CHANNEL]);
const ADPCM_ONLY = new Set([ADPCM_CHANNEL]);
const NONE = new Set();

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
  return Buffer.from(bytes).toString('latin1');
}

// mutedSet: fmdsp/channel-mask.jsの論理チャンネル名の集合。
// 曲を毎回コンパイルし直す(=Kの標準PCMバンクも再読込される。MucomWeb.cpp
// CompileMML()のコメント参照)。マスクはコンパイル後に設定する必要がある
// (コンパイルのたびにg_mucom(=OPNAインスタンス)が作り直されるため、マスクは
// 前回のインスタンスに設定した値を引き継がない)。
async function measure(Module, mutedSet) {
  const log = await compileAndGetLog(Module, MML);
  Module.setChannelMask(buildMucomChannelMask(mutedSet));
  let absSum = 0;
  for (let i = 0; i < 200; i++) absSum += Module.renderFramesForTest(2048);
  return { absSum, log };
}

async function main() {
  console.log('=== MUCOM88 トラック行クリックミュート 実測検証 ===\n');
  console.log('--- MML ---');
  console.log(MML);

  const Module = await createMucomWeb();
  const bankBytes = readFileSync(PCM_BANK_PATH);
  Module.FS.writeFile('/mucompcm.bin', new Uint8Array(bankBytes));
  console.log(`MEMFSへ書き込んだPCMバンク: /mucompcm.bin (${bankBytes.length} bytes)\n`);

  const a = await measure(Module, NONE);
  check('A. コンパイルログに#errorを含まない', !/#error/i.test(a.log));
  console.log(`(a) 何もミュートしない: absSum=${a.absSum}`);

  const b = await measure(Module, ALL_EXCEPT_ADPCM);
  console.log(`(b) K以外を全部ミュート: absSum=${b.absSum}`);
  check('B. [本体] K以外をミュートしてもabsSumが非0(=ADPCMchが残っている証拠)', b.absSum > 0, `absSum=${b.absSum}`);

  const c = await measure(Module, ADPCM_ONLY);
  console.log(`(c) Kだけをミュート: absSum=${c.absSum}`);
  check('C. [本体] KだけミュートするとabsSumが(a)より明確に減る(=ADPCMchが消えている証拠)',
    c.absSum < a.absSum * 0.9, `a=${a.absSum} c=${c.absSum} (c/a=${(c.absSum / a.absSum).toFixed(4)})`);

  const d = await measure(Module, ALL_MUTABLE);
  console.log(`(d) 全部ミュート: absSum=${d.absSum}`);
  const SILENCE_THRESHOLD = a.absSum * 0.001; // (a)比0.1%未満ならほぼ無音とみなす
  check('D. [陽性対照] 全部ミュートするとabsSumがほぼ0(マスクが効いている証拠)',
    d.absSum <= SILENCE_THRESHOLD, `absSum=${d.absSum} (閾値=${SILENCE_THRESHOLD.toFixed(1)}, a比=${(d.absSum / a.absSum * 100).toFixed(4)}%)`);

  console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
  console.log(`実測値まとめ: (a)=${a.absSum} (b)=${b.absSum} (c)=${c.absSum} (d)=${d.absSum}`);
  if (failCount > 0) process.exit(1);
}

main();
