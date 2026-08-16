#!/usr/bin/env node
// トラック行クリックミュート機能: マスク値組み立ての純粋関数(fmdsp/channel-mask.js)
// を検証する。
//
// 検証の主眼: MUCOM88(fmgen)とPMD(98fmplayer)はFM1-6/SSG1-3のビット位置は同じだが、
// ADPCMとリズムのビット位置が入れ替わっている(下記出典)。両エンジンで期待ビット位置
// が異なることを明示的にテストする(共通マスクを両方へ渡す実装ミスを検出できるように)。
//
// 出典:
//   MUCOM88: upstream/MucomWeb/mucom88/src/fmgen/opna.cpp:494-500
//     (OPNABase::SetChannelMask。bit9=ADPCM、bit10-15=リズム6bit)
//   PMD:     upstream/98fmplayer/libopna/opna.c:59-66、opna.h:14-30
//     (LIBOPNA_CHAN_*。bit9-14=リズム6bit、bit15=ADPCM)
//
// 実行: node tools/verify_channel_mask.mjs

import {
  buildMucomChannelMask, buildPmdChannelMask, channelForRow,
  FM_CHANNELS, SSG_CHANNELS, ADPCM_CHANNEL, RHYTHM_CHANNEL, TRACK_ROW_CHANNELS,
} from '../fmdsp/channel-mask.js';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

function bitsOf(mask) {
  const bits = [];
  for (let i = 0; i < 16; i++) if (mask & (1 << i)) bits.push(i);
  return bits;
}

console.log('=== トラック行ミュートのマスク組み立て(fmdsp/channel-mask.js)検証 ===\n');

// 1. MUCOM88でK(ADPCM)のみミュート -> bit9のみ
{
  const mask = buildMucomChannelMask(new Set([ADPCM_CHANNEL]));
  check('MUCOM88: ADPCMのみミュート -> bit9のみ', mask === (1 << 9), `mask=0x${mask.toString(16)} bits=[${bitsOf(mask)}]`);
}

// 2. PMDでADPCMのみミュート -> bit15のみ
{
  const mask = buildPmdChannelMask(new Set([ADPCM_CHANNEL]));
  check('PMD: ADPCMのみミュート -> bit15のみ', mask === (1 << 15), `mask=0x${mask.toString(16)} bits=[${bitsOf(mask)}]`);
}

// 3. MUCOM88でリズムのみミュート -> bit10-15
{
  const mask = buildMucomChannelMask(new Set([RHYTHM_CHANNEL]));
  const expected = 0x3f << 10;
  check('MUCOM88: リズムのみミュート -> bit10-15', mask === expected, `mask=0x${mask.toString(16)} bits=[${bitsOf(mask)}]`);
}

// 4. PMDでリズムのみミュート -> bit9-14
{
  const mask = buildPmdChannelMask(new Set([RHYTHM_CHANNEL]));
  const expected = 0x3f << 9;
  check('PMD: リズムのみミュート -> bit9-14', mask === expected, `mask=0x${mask.toString(16)} bits=[${bitsOf(mask)}]`);
}

// 5. FM/SSGは両エンジンで同じビットになる(全FM+全SSGをミュート)
{
  const mutedAll = new Set([...FM_CHANNELS, ...SSG_CHANNELS]);
  const mucomMask = buildMucomChannelMask(mutedAll);
  const pmdMask = buildPmdChannelMask(mutedAll);
  const expected = 0x1ff; // bit0-8
  check('FM1-6+SSG1-3: MUCOM88側がbit0-8', mucomMask === expected, `mask=0x${mucomMask.toString(16)}`);
  check('FM1-6+SSG1-3: PMD側がbit0-8(MUCOM88と同じ)', pmdMask === expected, `mask=0x${pmdMask.toString(16)}`);
  check('FM1-6+SSG1-3: 両エンジンのマスク値が一致', mucomMask === pmdMask, `mucom=0x${mucomMask.toString(16)} pmd=0x${pmdMask.toString(16)}`);
}

// 6. 個別FMチャンネルのビット位置(0-5)を1つずつ検査。両エンジン共通。
FM_CHANNELS.forEach((ch, i) => {
  const mucomMask = buildMucomChannelMask(new Set([ch]));
  const pmdMask = buildPmdChannelMask(new Set([ch]));
  check(`${ch}: MUCOM88 bit${i}のみ`, mucomMask === (1 << i), `mask=0x${mucomMask.toString(16)}`);
  check(`${ch}: PMD bit${i}のみ`, pmdMask === (1 << i), `mask=0x${pmdMask.toString(16)}`);
});

// 7. 個別SSGチャンネルのビット位置(6-8)。両エンジン共通。
SSG_CHANNELS.forEach((ch, i) => {
  const bit = 6 + i;
  const mucomMask = buildMucomChannelMask(new Set([ch]));
  const pmdMask = buildPmdChannelMask(new Set([ch]));
  check(`${ch}: MUCOM88 bit${bit}のみ`, mucomMask === (1 << bit), `mask=0x${mucomMask.toString(16)}`);
  check(`${ch}: PMD bit${bit}のみ`, pmdMask === (1 << bit), `mask=0x${pmdMask.toString(16)}`);
});

// 8. [故障注入] わざとエンジンを取り違えて渡すと、ADPCM単体ミュートのつもりが
//    別チャンネルを消す壊れ方になることを確認する(検査自体が効いていることの確認)。
{
  const mucomAdpcmMask = buildMucomChannelMask(new Set([ADPCM_CHANNEL])); // 0x200 (bit9)
  // これをPMD側へそのまま渡してしまった、という想定の故障注入。
  // PMD側のbit9はリズムBDなので、ADPCM(bit15)は無傷のまま=取り違えが検出できる。
  const wronglyAppliedToPmd = mucomAdpcmMask;
  const pmdAdpcmBitSet = (wronglyAppliedToPmd & (1 << 15)) !== 0;
  check('[故障注入] MUCOM用マスクをPMDへ誤って渡すとADPCMビット(15)が立たない(=取り違えが起きたことが分かる)',
    !pmdAdpcmBitSet, `wrongly-applied mask=0x${wronglyAppliedToPmd.toString(16)}`);
}

// 9. 行index(0-9) -> チャンネル名の対応がFM1-6,SSG1-3,ADPCMの順であること。
{
  const expectedOrder = ['FM1', 'FM2', 'FM3', 'FM4', 'FM5', 'FM6', 'SSG1', 'SSG2', 'SSG3', 'ADPCM'];
  const actualOrder = expectedOrder.map((_, i) => channelForRow(i));
  check('行index(0-9) -> チャンネル名の対応順', JSON.stringify(actualOrder) === JSON.stringify(expectedOrder),
    `actual=${JSON.stringify(actualOrder)}`);
  check('TRACK_ROW_CHANNELSの長さは10', TRACK_ROW_CHANNELS.length === 10, `length=${TRACK_ROW_CHANNELS.length}`);
  check('範囲外の行indexはundefined', channelForRow(10) === undefined && channelForRow(-1) === undefined);
}

console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
if (failCount > 0) process.exit(1);
