#!/usr/bin/env node
// PMDリズム(Gパート)がwasm側へ結線されたことの実測検証。
// tools/gen_rhythm_rom.py が生成した pmdweb/src/rhythm_rom.c を
// PmdCore.c の initialize_synth() が opna_drum_set_rom() で流し込むように
// なった(2026-08-18)。本スクリプトはそれを実データではなく手組みの
// レジスタ操作で確認する。
//
// リズム音源のレジスタ仕様(libopna/opnadrum.c opna_drum_writereg()参照、
// YM2608実機のリズム音源レジスタと同じ):
//   reg 0x11: total level (bit0-5)
//   reg 0x18-0x1d: 各音(BD,SD,TOP,HH,TOM,RIM)のpan/level
//                  (bit7=left, bit6=right, bit0-4=level)
//   reg 0x10: キーオン(bit0-5=BD/SD/TOP/HH/TOM/RIM, bit7=1でキーオフ)
// 個別に鳴らすMML経路(pmd_cmdeb_opnarhythm等、fmdriver_pmd.c)を組み立てるより、
// テスト専用API Module.testWriteOpnaReg() でレジスタを直接叩くほうが単純で
// 確実なため、タスク指示に従いこちらを採用する。
//
// 検証項目:
//   1. [本体] FM/SSG/ADPCMを全部ミュートした状態でリズムを全音キーオンし、
//      absSumが非0であること。
//   2. [本体] 6音(BD/SD/TOP/HH/TOM/RIM)を個別にキーオンし、それぞれ非0かつ
//      互いに異なること(同じ波形を6回渡す取り違えの検出)。
//   3. [陽性対照] Module.testResetDrumNoRom() (opna_drum_reset()のみを呼び、
//      opna_drum_set_rom()を呼ばない= 結線前のPmdCore.cが実際に置かれていた
//      状態を再現)の直後は、1と同じ手順でも絶対値和が0であること。
//   4. [結線] pmdweb/CMakeLists.txtにrhythm_rom.cがあること、PmdCore.cが
//      opna_drum_set_romを呼んでいることの文字列検査。
//
// 実行: node tools/verify_pmd_rhythm.mjs
// (pmdweb/build-web/pmdweb.js が事前にビルド済みであること)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import {
  buildPmdChannelMask, FM_CHANNELS, SSG_CHANNELS, ADPCM_CHANNEL, RHYTHM_CHANNEL,
} from '../fmdsp/channel-mask.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

// --- 空の`.M`(全パート未使用)。playMusic()を通すためだけの最小ファイル ---
// docs/pmd-compiler-spec.md 1.1-1.3節 / compiler/gen_pmd_min.mjs と同じ
// ヘッダレイアウト。11パート分のポインタを全部「即終了トラック」に向ける。
function buildEmptyFile() {
  const HEADER_LEN = 0x1a;
  const EMPTY_TRACK_OFF = HEADER_LEN;
  const relLen = EMPTY_TRACK_OFF + 1;
  const rel = new Uint8Array(relLen);
  function w16(off, val) {
    rel[off] = val & 0xff;
    rel[off + 1] = (val >> 8) & 0xff;
  }
  for (let i = 0; i < 11; i++) w16(i * 2, EMPTY_TRACK_OFF);
  w16(0x16, EMPTY_TRACK_OFF); // r_offset
  w16(0x18, EMPTY_TRACK_OFF); // tone_ptr(音色未使用)
  rel[EMPTY_TRACK_OFF] = 0x80; // トラック即終了
  const file = new Uint8Array(1 + relLen);
  file[0] = 0; // opm_flag
  file.set(rel, 1);
  return file;
}

const RHYTHM_REG_TOTAL_LEVEL = 0x11;
const RHYTHM_REG_PAN_LEVEL_BASE = 0x18; // +0..5
const RHYTHM_REG_KEY = 0x10;
const DRUM_NAMES = ['BD', 'SD', 'TOP', 'HH', 'TOM', 'RIM'];

// 全音を最大音量で鳴らす設定を書いた上でキーオンする(mask: どの音をキーオンするか)
function keyOnDrums(Module, drumMask) {
  Module.testWriteOpnaReg(RHYTHM_REG_TOTAL_LEVEL, 0x3f); // total levelを最大音量側に
  for (let d = 0; d < 6; d++) {
    Module.testWriteOpnaReg(RHYTHM_REG_PAN_LEVEL_BASE + d, 0x80 | 0x40 | 0x1f); // L+R, level最大
  }
  Module.testWriteOpnaReg(RHYTHM_REG_KEY, drumMask & 0x3f);
}

const ALL_EXCEPT_RHYTHM = new Set([...FM_CHANNELS, ...SSG_CHANNELS, ADPCM_CHANNEL]);

async function measureRhythm(Module, emptyFile, drumMask, { noRom = false } = {}) {
  Module.FS.writeFile('/test.M', emptyFile);
  const error = Module.playMusic('/test.M');
  if (error) throw new Error(`playMusic failed: ${error}`);
  Module.setChannelMask(buildPmdChannelMask(ALL_EXCEPT_RHYTHM));
  if (noRom) Module.testResetDrumNoRom();
  keyOnDrums(Module, drumMask);
  let absSum = 0;
  for (let i = 0; i < 200; i++) absSum += Module.renderFramesForTest(2048);
  return absSum;
}

async function main() {
  console.log('=== PMD リズム(Gパート) wasm結線 実測検証 ===\n');

  const emptyFile = buildEmptyFile();
  const Module = await createPmdWeb();

  // 1. [本体] 全音キーオンで非0
  const allSum = await measureRhythm(Module, emptyFile, 0x3f);
  console.log(`(1) 6音同時キーオン(FM/SSG/ADPCMミュート): absSum=${allSum}`);
  check('1. [本体] リズムのみでabsSumが非0(=リズムが鳴っている証拠)', allSum > 0, `absSum=${allSum}`);

  // 2. [本体] 6音個別、非0かつ互いに異なる
  const perDrum = [];
  for (let d = 0; d < 6; d++) {
    const sum = await measureRhythm(Module, emptyFile, 1 << d);
    perDrum.push(sum);
    console.log(`    ${DRUM_NAMES[d]}: absSum=${sum}`);
  }
  const allNonZero = perDrum.every((s) => s > 0);
  check('2a. [本体] 6音それぞれのabsSumが非0', allNonZero, `values=${perDrum.join(',')}`);
  const distinctCount = new Set(perDrum).size;
  check('2b. [本体] 6音のabsSumが互いに異なる(=同じ波形の取り違えでない)',
    distinctCount === 6, `distinct=${distinctCount}/6 values=${perDrum.join(',')}`);

  // 3. [陽性対照] set_romを呼ばない状態(=結線前の症状)では無音のまま
  const noRomSum = await measureRhythm(Module, emptyFile, 0x3f, { noRom: true });
  console.log(`(3) opna_drum_set_rom()未呼び出し(結線前の症状再現): absSum=${noRomSum}`);
  check('3. [陽性対照] ROM未セット時は無音(結線前の症状で実際にFAILする側を確認)',
    noRomSum === 0, `absSum=${noRomSum}`);

  // 4. [結線] ソース上の配線を文字列検査
  const cmakeText = fs.readFileSync(path.join(REPO_ROOT, 'pmdweb/CMakeLists.txt'), 'utf8');
  check('4a. [結線] pmdweb/CMakeLists.txtにsrc/rhythm_rom.cがある',
    /src\/rhythm_rom\.c/.test(cmakeText));
  const coreText = fs.readFileSync(path.join(REPO_ROOT, 'pmdweb/src/PmdCore.c'), 'utf8');
  check('4b. [結線] PmdCore.cがopna_drum_set_rom()を呼んでいる',
    /opna_drum_set_rom\s*\(/.test(coreText));
  check('4c. [結線] opna_drum_set_rom()呼び出しがopna_reset()より後(reset内のopna_drum_resetでdataがnullに戻るため)',
    coreText.indexOf('opna_reset(&g_player.opna)') < coreText.indexOf('opna_drum_set_rom('));

  console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
  console.log(`実測値まとめ: 全音=${allSum} 個別=[${perDrum.join(',')}] 陽性対照(no rom)=${noRomSum}`);
  if (failCount > 0) process.exit(1);
}

main();
