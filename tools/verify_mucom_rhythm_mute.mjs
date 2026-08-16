#!/usr/bin/env node
// レベルメータークリックミュート機能の実測(MUCOM88リズムパート側)。
// tools/verify_level_meter_click.mjs の純粋関数テストだけでは「クリックで
// RHYTHM_CHANNELが正しくトグルされる」ところまでしか確認できない。ここでは
// 実際にfmdsp/channel-mask.jsのRHYTHM_CHANNELをbuildMucomChannelMask()経由で
// wasm側のOPNA::SetChannelMask()へ渡し、生成される音声のabsSumが期待通りに
// 変化することを実測する(ここが本体)。
//
// tools/verify_mucom_channel_mute.mjsの作法(A/B/C/D 4条件)をリズムに適用する:
//   A. 何もミュートしない -> absSum(baseline)
//   B. RHYTHM以外(FM1-6,SSG1-3,ADPCM)を全部ミュート -> absSumが非0であること
//      (=リズムchが残っている証拠)
//   C. RHYTHMだけをミュート -> absSumがAより明確に減ること(=リズムchが消えている証拠)
//   D. 全部ミュート -> absSumがほぼ0であること(陽性対照)
//
// リズムを鳴らすにはtools/verify_mucom_rhythm.mjsと同じくリズムWAV6本を
// MEMFSへ書き込む必要がある(mucomweb/patches/0003-mucomvm-rhythm-path.patch、
// html/rhythm/2608_*.WAV)。
//
// MML: FM1(A、Gパートと重ならない音程)とリズム(G)を同時に鳴らす。
//
// 実行: node tools/verify_mucom_rhythm_mute.mjs
// (mucomweb/build-web/mucom88.js が事前にビルド済みであること)

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createMucomWeb from '../mucomweb/build-web/mucom88.js';
import {
  buildMucomChannelMask, FM_CHANNELS, SSG_CHANNELS, ADPCM_CHANNEL, RHYTHM_CHANNEL,
} from '../fmdsp/channel-mask.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PCM_BANK_PATH = path.join(REPO_ROOT, 'html/mucompcm.bin');
const RHYTHM_DIR = path.join(REPO_ROOT, 'html/rhythm');
const SAMPLE_RATE = 55467;

// FM1(A)を長めに、Gパートでリズム(BD/SD/TOP/HH/TOM/RIMを順に)を鳴らす。
// FM側は音色(@n)を指定しないと無音になる(tools/verify_mucom_new_template.mjs参照)。
const MML = 'A @78 T120 o4 v100 l4 cdefgab>c<\nG t120 l4 @1c@2c@4c@8c@16c@32c\n';

const ALL_MUTABLE = new Set([...FM_CHANNELS, ...SSG_CHANNELS, RHYTHM_CHANNEL, ADPCM_CHANNEL]);
const ALL_EXCEPT_RHYTHM = new Set([...FM_CHANNELS, ...SSG_CHANNELS, ADPCM_CHANNEL]);
const RHYTHM_ONLY = new Set([RHYTHM_CHANNEL]);
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

function writeRhythmSamplesToMemfs(Module) {
  try {
    Module.FS.mkdir('/rhythm');
  } catch (e) {
    // 既に存在(2回目以降の呼び出し)は無視。
  }
  const files = readdirSync(RHYTHM_DIR).filter((f) => f.toUpperCase().endsWith('.WAV'));
  if (files.length !== 6) {
    throw new Error(`html/rhythm/ に想定と異なる本数のWAVがある(6本のはず): ${files.length}本`);
  }
  for (const f of files) {
    const bytes = readFileSync(path.join(RHYTHM_DIR, f));
    Module.FS.writeFile(`/rhythm/${f}`, new Uint8Array(bytes));
  }
  return files;
}

// mutedSet: fmdsp/channel-mask.jsの論理チャンネル名の集合。
async function measure(Module, mutedSet) {
  const log = await compileAndGetLog(Module, MML);
  Module.setChannelMask(buildMucomChannelMask(mutedSet));
  let absSum = 0;
  for (let i = 0; i < 200; i++) absSum += Module.renderFramesForTest(2048);
  return { absSum, log };
}

async function main() {
  console.log('=== MUCOM88 レベルメータークリックミュート(リズム) 実測検証 ===\n');
  console.log('--- MML ---');
  console.log(MML);

  const Module = await createMucomWeb();
  const bankBytes = readFileSync(PCM_BANK_PATH);
  Module.FS.writeFile('/mucompcm.bin', new Uint8Array(bankBytes));
  const rhythmFiles = writeRhythmSamplesToMemfs(Module);
  console.log(`MEMFSへ書き込んだPCMバンク: /mucompcm.bin (${bankBytes.length} bytes)`);
  console.log(`MEMFSへ書き込んだリズムWAV: ${rhythmFiles.join(', ')}\n`);

  const a = await measure(Module, NONE);
  check('A. コンパイルログに#errorを含まない', !/#error/i.test(a.log));
  console.log(`(a) 何もミュートしない: absSum=${a.absSum}`);

  const b = await measure(Module, ALL_EXCEPT_RHYTHM);
  console.log(`(b) RHYTHM以外を全部ミュート: absSum=${b.absSum}`);
  check('B. [本体] RHYTHM以外をミュートしてもabsSumが非0(=リズムchが残っている証拠)',
    b.absSum > 0, `absSum=${b.absSum}`);

  const c = await measure(Module, RHYTHM_ONLY);
  console.log(`(c) RHYTHMだけをミュート: absSum=${c.absSum}`);
  check('C. [本体] RHYTHMだけミュートするとabsSumが(a)より明確に減る(=リズムchが消えている証拠)',
    c.absSum < a.absSum * 0.9, `a=${a.absSum} c=${c.absSum} (c/a=${(c.absSum / a.absSum).toFixed(4)})`);

  const d = await measure(Module, ALL_MUTABLE);
  console.log(`(d) 全部ミュート: absSum=${d.absSum}`);
  const SILENCE_THRESHOLD = a.absSum * 0.001;
  check('D. [陽性対照] 全部ミュートするとabsSumがほぼ0(マスクが効いている証拠)',
    d.absSum <= SILENCE_THRESHOLD, `absSum=${d.absSum} (閾値=${SILENCE_THRESHOLD.toFixed(1)}, a比=${(d.absSum / a.absSum * 100).toFixed(4)}%)`);

  console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
  console.log(`実測値まとめ: (a)=${a.absSum} (b)=${b.absSum} (c)=${c.absSum} (d)=${d.absSum}`);
  if (failCount > 0) process.exit(1);
}

main();
