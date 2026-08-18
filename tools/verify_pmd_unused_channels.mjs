#!/usr/bin/env node
// 未使用パート暗色化機能(利用者指示B)の検証4(PMD側): 「曲が使っていない
// パート」判定(fmdsp/channel-mask.js usedChannelsFromPmdMmlParts)を、
// compiler/pmd_mml_compiler.mjsで実際にMMLをコンパイルした結果で検証する。
// wasm不要(コンパイラ自体は純粋なJS)。
//
// 実行: node tools/verify_pmd_unused_channels.mjs

import { compileMml } from '../compiler/pmd_mml_compiler.mjs';
import {
  usedChannelsFromPmdMmlParts, FM_CHANNELS, SSG_CHANNELS, RHYTHM_CHANNEL, ADPCM_CHANNEL,
} from '../fmdsp/channel-mask.js';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

console.log('=== PMD「曲が使っていないパート」判定の検証(compiler/pmd_mml_compiler.mjs実コンパイル) ===\n');

// A. パートA(FM1)とG(SSG1)を使うMML -> FM1/SSG1が使用チャンネル、FM2やSSG2は未使用。
// 音色定義を書かなければcompileMml()が既定音色1個を自動で補う
// (compiler/pmd_mml_compiler.mjs `if (Object.keys(toneTable).length === 0) toneTable[1] = {};`)
// ため、@1の定義自体は不要(tools/verify_pmd_mml.mjs等、既存の検証群と同じ作法)。
const mmlAG = 'A t120 o4 l4 cdefgab>c<\nG t120 o4 l4 cdefgab>c<\n';
const { file: fileAG, errors: errorsAG, layout: layoutAG } = compileMml(mmlAG);
check('A. コンパイル成功(FM1+SSG1のMML)', errorsAG.length === 0 && fileAG !== null,
  JSON.stringify(errorsAG));
if (layoutAG) {
  const usedAG = usedChannelsFromPmdMmlParts(Object.keys(layoutAG.tracks));
  check('A. FM1(パートA)が使用チャンネルに含まれる', usedAG.has(FM_CHANNELS[0]), `used=${[...usedAG].join(',')}`);
  check('A. SSG1(パートG)が使用チャンネルに含まれる', usedAG.has(SSG_CHANNELS[0]), `used=${[...usedAG].join(',')}`);
  check('A. 触れていないFM2は使用チャンネルに含まれない(=未使用判定できている)', !usedAG.has(FM_CHANNELS[1]));
  // 2026-08-18追記: コンパイラがK(リズム)/J(ADPCM)へ対応した後も、この特定の
  // MML(A・Gパートのみ、K/Jは書いていない)では両方とも「使っていない」が
  // 正しい答えのまま(=触れていないパートは検出されない、という上のFM2の確認と
  // 同じ理由)。「コンパイラが構造的に出力しない」という以前の理由付けは
  // K/R実装(compiler/pmd_mml_compiler.mjs)により古くなったため削除した
  // (K使用時にRHYTHMが検出されることはtools/verify_pmd_rhythm_used_channel.mjsで
  // 別途検証する)。
  check('A. RHYTHM/ADPCMはこのMML(K/Jを書いていない)では使用チャンネルに含まれない',
    !usedAG.has(RHYTHM_CHANNEL) && !usedAG.has(ADPCM_CHANNEL));
}

// B. パートAだけを使うMML(SSG1には触れない) -> SSG1は使用チャンネルに含まれない。
const mmlAOnly = 'A t120 o4 l4 cdefgab>c<\n';
const { errors: errorsAOnly, layout: layoutAOnly } = compileMml(mmlAOnly);
check('B. コンパイル成功(FM1のみのMML)', errorsAOnly.length === 0 && layoutAOnly !== null, JSON.stringify(errorsAOnly));
let usedAOnly = null;
if (layoutAOnly) {
  usedAOnly = usedChannelsFromPmdMmlParts(Object.keys(layoutAOnly.tracks));
  check('B. FM1が使用チャンネルに含まれる', usedAOnly.has(FM_CHANNELS[0]));
  check('B. SSG1は使用チャンネルに含まれない', !usedAOnly.has(SSG_CHANNELS[0]), `used=${[...usedAOnly].join(',')}`);
}

// 本体: AとBで同じ判定器がSSG1について異なる答えを返す(=同一の判定器が両方で
// 同じ答えを返したらFAIL、という利用者指示の主条件をPMD側にも適用)。
if (layoutAG && layoutAOnly) {
  const usedAG2 = usedChannelsFromPmdMmlParts(Object.keys(layoutAG.tracks));
  check('[本体] SSG1(パートG)の有無で使用チャンネル判定が変わる(同じ判定器が両方で同じ答えを返していない)',
    usedAG2.has(SSG_CHANNELS[0]) !== usedAOnly.has(SSG_CHANNELS[0]),
    `withG=${usedAG2.has(SSG_CHANNELS[0])} withoutG=${usedAOnly.has(SSG_CHANNELS[0])}`);
}

// [陽性対照] わざと壊す: 存在しないパート文字('Z'等)を渡しても、
// PMD_MML_PART_LETTERSに無いので静かに無視されること(構造上RHYTHM/ADPCMが
// 絶対に紛れ込まないことの確認。含まれてしまえば「未使用暗色化」がでっち上げに
// なる)。
check('[陽性対照] PART_LETTERSに無い文字(Z)を渡しても使用チャンネルは空集合のまま',
  usedChannelsFromPmdMmlParts(['Z']).size === 0);
check('[陽性対照] 空配列を渡すと使用チャンネルは空集合(全パート未使用扱い)',
  usedChannelsFromPmdMmlParts([]).size === 0);

console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
if (failCount > 0) process.exit(1);
