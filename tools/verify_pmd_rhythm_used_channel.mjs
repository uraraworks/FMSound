#!/usr/bin/env node
// 実機報告(2026-08-18、「編集モードで再生するとレベルメーターのリズム/PCM付近の
// 列が暗くなっている」)の切り分け結果(ii): PCMの結線自体は生きている
// (tools/verify_pmd_ppc_load.mjs・tools/verify_pmd_rhythm.mjs・
// tools/verify_pmd_ppz8_mute.mjsで別途実測済み)が、fmdsp/channel-mask.js
// usedChannelsFromPmdMmlParts()が「曲がリズム(K)を使っている」ことを検出できて
// いなかった。
//
// 真因: compiler/pmd_mml_compiler.mjs/pmd_mml_parser.mjsが2026-08-18中にK/R
// (リズム)へ対応し、parseMml()/compileMml()が返すtracksに'K'キーが実際に
// 含まれるようになった。しかしusedChannelsFromPmdMmlParts()はPART_LETTERS
// (compiler/pmd_mml_parser.mjs、依然としてA-Jのみ、Kを含まない)だけを見て
// いたため、'K'は`PMD_MML_PART_LETTERS.indexOf('K')`が-1になり黙って無視されて
// いた。結果、リズムパートを実際に使い、実際に鳴っている曲でも、レベルメーターの
// RHYTHM列だけが「曲が使っていないパート」(unusedColumnsFromChannels)として
// 暗色化され続けていた。
//
// 実データ(SS_TENG、利用者提供・読み取り専用・リポジトリへコピー禁止)でこの
// スクリプト作成前に実測済み: layout.tracksのkeysに'K'が含まれ、リズムの
// 絶対値和も非0(実際に鳴っている)にもかかわらず、修正前の
// usedChannelsFromPmdMmlParts()の戻り値にRHYTHM_CHANNELが入らなかった。
// このスクリプト自体は第三者データを使わず、同じ構造(Kパートを使うMML)を
// 自前で組み立てて再現する(tools/verify_pmd_unused_channels.mjsと同じ作法)。
//
// 実行: node tools/verify_pmd_rhythm_used_channel.mjs

import { compileMml } from '../compiler/pmd_mml_compiler.mjs';
import {
  usedChannelsFromPmdMmlParts, unusedColumnsFromChannels, PMD_LEVEL_COLUMN_CHANNELS,
  LEVEL_COLUMN_CHANNELS, RHYTHM_CHANNEL, ADPCM_CHANNEL, FM_CHANNELS,
} from '../fmdsp/channel-mask.js';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

console.log('=== tools/verify_pmd_rhythm_used_channel.mjs: リズム(K)使用時のレベルメーター暗色化検証 ===\n');

// A. FM1(パートA)とリズム(パートK)を使うMML。
const mmlAK = 'A t120 o4 l4 cdefgab>c<\nK \\b\\b\\b\\b\\b\\b\\b\\b\n';
const { errors: errorsAK, layout: layoutAK } = compileMml(mmlAK);
check('A. コンパイル成功(FM1+リズムK使用のMML)', errorsAK.length === 0 && layoutAK !== null, JSON.stringify(errorsAK));

if (layoutAK) {
  const trackKeys = Object.keys(layoutAK.tracks);
  check('A. コンパイラのtracksに\'K\'が含まれる(K/R実装済みであることの前提確認)', trackKeys.includes('K'), `tracks=${trackKeys.join(',')}`);

  const usedAK = usedChannelsFromPmdMmlParts(trackKeys);
  check('[本体] RHYTHM(K使用)が使用チャンネルに含まれる(=検出できている)', usedAK.has(RHYTHM_CHANNEL), `used=${[...usedAK].join(',')}`);
  check('[本体] FM1(A使用)も使用チャンネルに含まれる(既存の判定を壊していない)', usedAK.has(FM_CHANNELS[0]));
  check('[本体] ADPCM(Jは書いていない)は使用チャンネルに含まれない(誤検出していない)', !usedAK.has(ADPCM_CHANNEL));

  // レベルメーター描画側(unusedColumnsFromChannels)まで通して、RHYTHM列
  // (index9、fmdsp/channel-mask.js LEVEL_COLUMN_CHANNELSのコメント参照)が
  // unused(暗色化対象)に入っていないことを確認する。
  const rhythmColumn = LEVEL_COLUMN_CHANNELS.indexOf(RHYTHM_CHANNEL);
  check('[結線] LEVEL_COLUMN_CHANNELSでのRHYTHM列indexを検出できる', rhythmColumn >= 0);
  const unusedCols = unusedColumnsFromChannels(usedAK, new Set(), PMD_LEVEL_COLUMN_CHANNELS);
  check('[結線] RHYTHM列(index9)がunused(暗色化対象)に入っていない', !unusedCols.has(rhythmColumn), `unusedCols=${[...unusedCols].join(',')}`);
}

// B. FM1のみを使うMML(Kは書いていない) -> RHYTHMは使用チャンネルに含まれない
//    (=誤って常にRHYTHMを「使用」扱いにする過剰修正になっていないことの確認)。
const mmlAOnly = 'A t120 o4 l4 cdefgab>c<\n';
const { errors: errorsAOnly, layout: layoutAOnly } = compileMml(mmlAOnly);
check('B. コンパイル成功(FM1のみのMML)', errorsAOnly.length === 0 && layoutAOnly !== null);
let usedAOnly = null;
if (layoutAOnly) {
  usedAOnly = usedChannelsFromPmdMmlParts(Object.keys(layoutAOnly.tracks));
  check('B. RHYTHM(Kを書いていない)は使用チャンネルに含まれない', !usedAOnly.has(RHYTHM_CHANNEL));
}

// --- [陽性対照] usedChannelsFromPmdMmlParts()からKの特別扱いを外す(修正前の
//     実装を再現する)と、実際にRHYTHM検出がFAILすることを確認する ---
function usedChannelsFromPmdMmlParts_broken(usedPartLetters, partLetters, partOrder) {
  const used = new Set();
  usedPartLetters.forEach((letter) => {
    const idx = partLetters.indexOf(letter);
    if (idx >= 0) used.add(partOrder[idx]);
  });
  return used;
}
if (layoutAK) {
  // PMD_MML_PART_LETTERS/PMD_MML_PART_ORDERを直接importせず(named exportだが
  // 意図を明確にするため)、修正前の意味そのもの(PART_LETTERS=A-J、Kを含まない)
  // を再現する最小の断片をここで組み立てる。
  const A_TO_J = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
  const ORDER = [...FM_CHANNELS, 'SSG1', 'SSG2', 'SSG3', ADPCM_CHANNEL];
  const brokenUsed = usedChannelsFromPmdMmlParts_broken(Object.keys(layoutAK.tracks), A_TO_J, ORDER);
  check('[陽性対照] Kの特別扱いを外した実装では、同じMMLでもRHYTHMが検出されない(検出器が機能している証拠)',
    !brokenUsed.has(RHYTHM_CHANNEL));
}

console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
process.exit(failCount > 0 ? 1 : 0);
