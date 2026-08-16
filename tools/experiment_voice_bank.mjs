#!/usr/bin/env node
// EXPERIMENTAL / not part of the product test suite.
//
// Measures whether MUCOM88's `#voice <file>` tag (external FM voice bank)
// can actually change the rendered audio in the wasm build, once
// mucomweb/patches/0004-compilemml-processheader.patch (experimental,
// NOT applied by CMakeLists.txt) is applied and mucom88.js/.wasm rebuilt.
// See docs/voice-external-bank-experiment.md for the write-up.
//
// Judgment design (do NOT just check "compiled" or "sounds like something"):
//   1. Byte-compare the embedded default bank (bin_voice.h) against a disk
//      voicedat and find slots whose 32-byte content differs.
//   2. Positive control: within the embedded default bank alone (no #voice
//      involved), play two slots with clearly different content and confirm
//      renderFramesForTest() absSum differs. This proves the engine CAN
//      produce an audibly different absSum from different voice bytes.
//   3. Main test: play the SAME slot number once with the embedded default
//      bank (no #voice) and once with #voice pointing at the disk bank
//      (MEMFS) that has different bytes at that same slot number. If
//      absSum differs, #voice loading changed the sound. If it doesn't,
//      #voice is still a no-op even with ProcessHeader() called.
//
// Requires: mucomweb/build-web/mucom88.js built WITH patch 0004 applied
// (see docs/voice-external-bank-experiment.md for build steps).
//
// Run: node tools/experiment_voice_bank.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createMucomWeb from '../mucomweb/build-web/mucom88.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SAMPLE_RATE = 55467;

const VOICE_TEST_DIR = process.env.VOICE_TEST_DIR;
if (!VOICE_TEST_DIR) {
  console.error('VOICE_TEST_DIR env var (dir containing actraiser_voice.dat / embedded_default_voice.dat) is required.');
  process.exit(1);
}

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

async function measureAbsSum(Module, source) {
  const log = await compileAndGetLog(Module, source);
  let absSum = 0;
  for (let i = 0; i < 100; i++) absSum += Module.renderFramesForTest(2048);
  return { absSum, log };
}

async function main() {
  const embeddedDefault = readFileSync(path.join(VOICE_TEST_DIR, 'embedded_default_voice.dat'));
  const diskBank = readFileSync(path.join(VOICE_TEST_DIR, 'actraiser_voice.dat'));

  // --- 1. Byte-diff slots ---
  const diffSlots = [];
  for (let slot = 0; slot < 256; slot++) {
    const a = embeddedDefault.subarray(slot * 32, slot * 32 + 32);
    const b = diskBank.subarray(slot * 32, slot * 32 + 32);
    if (!a.equals(b)) diffSlots.push(slot);
  }
  console.log(`(a) embedded既定バンク vs actraiser disk voicedat: 256スロット中 ${diffSlots.length} 個が中身異なる`);
  check('(a) 中身が異なるスロットが1個以上存在する', diffSlots.length > 0, `件数=${diffSlots.length}`);

  // Pick the target slot for the main test: largest byte-magnitude diff (see analysis).
  const TARGET_SLOT = 29;
  check(`slot${TARGET_SLOT}がembedded/diskで異なることの確認`,
    !embeddedDefault.subarray(TARGET_SLOT * 32, TARGET_SLOT * 32 + 32)
      .equals(diskBank.subarray(TARGET_SLOT * 32, TARGET_SLOT * 32 + 32)));

  const Module = await createMucomWeb();

  // --- 2. Positive control: two different slots within the embedded default bank ---
  const CONTROL_SLOT_A = 0;
  const CONTROL_SLOT_B = TARGET_SLOT;
  const mmlControlA = `A l4 @${CONTROL_SLOT_A} cdefgab\n`;
  const mmlControlB = `A l4 @${CONTROL_SLOT_B} cdefgab\n`;
  const controlA = await measureAbsSum(Module, mmlControlA);
  const controlB = await measureAbsSum(Module, mmlControlB);
  console.log(`(c) 陽性対照: embedded default bank @${CONTROL_SLOT_A} absSum=${controlA.absSum}, @${CONTROL_SLOT_B} absSum=${controlB.absSum}`);
  check('(c) 陽性対照: コンパイルログに#errorを含まない', !/#error/i.test(controlA.log) && !/#error/i.test(controlB.log));
  check('(c) 陽性対照: 既定バンク内の異なるスロットで波形(absSum)が変わる', controlA.absSum !== controlB.absSum,
    `A(@${CONTROL_SLOT_A})=${controlA.absSum} B(@${CONTROL_SLOT_B})=${controlB.absSum}`);

  // --- 3. Main test: same slot number, embedded default vs disk bank via #voice ---
  const mmlNoVoice = `A l4 @${TARGET_SLOT} cdefgab\n`;
  const withoutVoice = await measureAbsSum(Module, mmlNoVoice);
  console.log(`(b) #voiceなし(既定バンク) @${TARGET_SLOT}: absSum=${withoutVoice.absSum}`);

  Module.FS.writeFile('/voicedat_disk.bin', new Uint8Array(diskBank));
  const mmlWithVoice = `#voice /voicedat_disk.bin\nA l4 @${TARGET_SLOT} cdefgab\n`;
  const withVoice = await measureAbsSum(Module, mmlWithVoice);
  console.log(`(b) #voiceあり(disk voicedat) @${TARGET_SLOT}: absSum=${withVoice.absSum}`);
  console.log('--- コンパイルログ(#voiceあり) ---');
  console.log(withVoice.log);
  console.log('----------------------------------');

  check('(b) #voiceあり側のコンパイルログに#errorを含まない', !/#error/i.test(withVoice.log));
  check('(b) #voice読み込みで波形(absSum)が変わる(外部バンクが効いた証拠)',
    withoutVoice.absSum !== withVoice.absSum,
    `without=${withoutVoice.absSum} with=${withVoice.absSum}`);

  // --- Round-trip sanity: embedded bank re-loaded via #voice should reproduce the no-#voice absSum ---
  Module.FS.writeFile('/voicedat_embedded.bin', new Uint8Array(embeddedDefault));
  const mmlRoundtrip = `#voice /voicedat_embedded.bin\nA l4 @${TARGET_SLOT} cdefgab\n`;
  const roundtrip = await measureAbsSum(Module, mmlRoundtrip);
  console.log(`(round-trip) #voice=embedded既定バンクそのもの @${TARGET_SLOT}: absSum=${roundtrip.absSum}`);
  check('(round-trip) 既定バンクをファイル化して#voiceで読ませても absSum は #voiceなしと一致する(整合性確認)',
    roundtrip.absSum === withoutVoice.absSum, `roundtrip=${roundtrip.absSum} no-voice=${withoutVoice.absSum}`);

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
