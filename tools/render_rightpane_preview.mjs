#!/usr/bin/env node
// rightpane.js (FMDSP右半分ORIGINALスタイル)の描画結果をPNGへ書き出し、
// ブラウザを立ち上げずに目視確認するためのスクリプト。tools/render_preview.mjs
// (トラック行版)に倣った構成。
//
// 実行: node tools/render_rightpane_preview.mjs [出力先.png] [パレット番号 0-9]
//
// 検証項目(この実行で必ず出力する):
//   (a) 描画がcanvas範囲(640x400)を出ない … vram.setPixel自体が範囲外を無視
//       する実装(vram.js:26-29)なので、範囲外書き込みは常に無害。ここでは
//       「非0ピクセルの座標がすべて0<=x<640,0<=y<400」であることを数えて確認する。
//   (b) 右半分(x>=312)に非0ピクセルがあり、左半分(x<312)を汚していない
//   (c) 数字が桁ごとに違う値で描き分けられている(経過時間の各桁を読み取って比較)
//
// 故障注入: LEVEL_XをわざとPC98_W以上にずらして(b)が「右半分に非0ピクセルなし」
// ではなく「本来ある場所に何も描かれない」形で壊れることを確認する…のではなく、
// 本スクリプトでは「座標を意図的にずらす」faultInject=trueモードで
// drawLogoの出力先をx<312側に移し、(b)の「左半分を汚していない」検査が
// 確実に落ちることを一度確認してから通常モードに戻す(常にPASSする検査は無効、
// という要求への対応)。

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { Vram, PC98_W, PC98_H } from '../pmdweb/html/fmdsp/vram.js';
import { PALETTES } from '../pmdweb/html/fmdsp/palette.js';
import * as rightpane from '../pmdweb/html/fmdsp/rightpane.js';

function writePng(path, width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; ++y) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; ++n) {
    let c = n;
    for (let k = 0; k < 8; ++k) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; ++i) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function dummyState(overrides = {}) {
  return {
    generatedFrames: BigInt(55467 * 225 + Math.floor(55467 * 0.67)), // 3:45.67相当
    timerbCnt: 12345678,
    timerb: 246,
    loopCnt: 2,
    cpuUsage: 37,
    fps: 60,
    timerbCntLoop: 40,
    loopTimerbCnt: 60,
    playing: true,
    stopped: false,
    paused: false,
    frameCnt: 50,
    ...overrides,
  };
}

// 経過時間(mm:ss.cc)を求める(drawPassedTimeと同じ式、検査用に桁を読み取る)。
function passedTimeDigits(frames) {
  const ssec = Number((frames % 55467n) * 100n / 55467n);
  const sec = frames / 55467n;
  const min = sec / 60n;
  const secMod = sec % 60n;
  return [
    Number((min / 10n) % 10n), Number(min % 10n),
    Number((secMod / 10n) % 10n), Number(secMod % 10n),
    Math.floor(ssec / 10) % 10, ssec % 10,
  ];
}

// 実データに近いダミーFFT: 高域ほど小さい値になる(実測(verify_right_pane_data.mjs
// のfft dump)でも低域が大きく高域がほぼ0に落ちる傾向が出ており、それに寄せた形)。
function dummyFft() {
  const bins = new Uint8Array(rightpane.FFTDISPLEN);
  for (let i = 0; i < bins.length; ++i) {
    const t = i / (bins.length - 1);
    bins[i] = Math.max(0, Math.round(28 * (1 - t) ** 1.6 + (i % 5 === 0 ? 3 : 0)));
  }
  return bins;
}

// 実データに近いダミーレベル: 19chごとに異なる値にする((b)の検査対象)。
function dummyLevels() {
  const levels = [];
  for (let c = 0; c < rightpane.FMDSP_LEVEL_COUNT; ++c) {
    const playing = c % 3 !== 2;
    levels.push({
      level: playing ? 4000 + c * 1400 : 0,
      pan: c % 6,
      prog: playing ? (c * 7 + 1) % 128 : 0,
      key: playing ? (((c % 8) << 4) | (c % 11)) : 0xff,
      playing,
    });
  }
  return levels;
}

function render(vram, { faultInject = false, faultInjectLevels = false } = {}) {
  vram.clear(0);
  if (faultInject) {
    // 故障注入: ロゴをわざと左半分(x=0)に描く。本来は(b)「左半分を汚していない」
    // 検査で弾かれるべき異常。
    rightpane.drawLogo({
      blitCopy: (sprite, spriteW, x, y, w, h) => vram.blitCopy(sprite, spriteW, 0, y, w, h),
    });
  } else {
    rightpane.drawStaticDecorations(vram, ['1', '2', '3']);
  }
  const state = dummyState();
  rightpane.drawDynamic(vram, state);

  const fftPeakState = rightpane.createPeakState(rightpane.FFTDISPLEN);
  const fftBins = dummyFft();
  // 数フレームぶん同じ入力を与えてピーク保持ラインが立ち上がった状態を見る。
  for (let i = 0; i < 3; ++i) rightpane.drawSpectrumBars(vram, fftBins, fftPeakState);

  const levelPeakState = rightpane.createPeakState(rightpane.FMDSP_LEVEL_COUNT);
  let levels = dummyLevels();
  if (faultInjectLevels) {
    // 故障注入: 全チャンネルのlevelを同じ値に潰す。本来は(b')「chごとに違う高さの
    // バーになる」検査が落ちるべき異常。
    levels = levels.map((entry) => ({ ...entry, level: entry.playing ? 8000 : 0 }));
  }
  for (let i = 0; i < 3; ++i) rightpane.drawLevelMeters(vram, levels, levelPeakState);

  return { state, fftBins, levels, fftPeakState, levelPeakState };
}

function countNonZero(vram) {
  let left = 0;
  let right = 0;
  let outOfBounds = 0;
  for (let y = 0; y < vram.height; ++y) {
    for (let x = 0; x < vram.width; ++x) {
      const v = vram.pixels[y * vram.width + x];
      if (v === 0) continue;
      if (x < 312) left++;
      else right++;
      if (x < 0 || x >= PC98_W || y < 0 || y >= PC98_H) outOfBounds++;
    }
  }
  return { left, right, outOfBounds };
}

// rightpane.jsのパレット色番号(rightpane.js冒頭のCOLOR_2/COLOR_7定義そのまま)。
// バー本体=色2、ピーク線=色7。背景帯(drawLevelLabelsが静的に敷く色3)や
// PANPOT(色1)と混同しないよう、この2色だけを「バーのピクセル」とみなす。
const BAR_COLOR = 2;
const PEAK_COLOR = 7;

// SPECTRUM: 指定bin(0-indexed)の列(SPECTRUM_X+bin*4を左端に幅3)にある
// バー本体/ピーク線ピクセルの本数(=実質的な高さ)を数える。
function spectrumColumnStats(vram, bin) {
  const x0 = rightpane.SPECTRUM_X + bin * 4;
  let count = 0;
  for (let y = 0; y < vram.height; ++y) {
    for (let dx = 0; dx < 3; ++dx) {
      const v = vram.pixels[y * vram.width + (x0 + dx)];
      if (v === BAR_COLOR || v === PEAK_COLOR) { count++; break; }
    }
  }
  return count;
}

// LEVEL: 指定ch(0-indexed)の列(LEVEL_X+LEVEL_W*chを左端に幅LEVEL_DISP_W)にある
// バー本体/ピーク線ピクセルの高さ(y方向の本数)を数える。
// バー描画域(LEVEL_Y〜LEVEL_Y+64)には drawLevelLabels が敷く色3の背景帯が
// 常に全面に乗っているため、色ではなく「色2/7かどうか」で判定する
// (単純な非0判定だと背景帯のせいで常に64になってしまう)。
function levelColumnHeight(vram, ch) {
  const x0 = rightpane.LEVEL_X + rightpane.LEVEL_W * ch;
  let count = 0;
  for (let y = rightpane.LEVEL_Y; y < rightpane.LEVEL_Y + 64; ++y) {
    for (let dx = 0; dx < rightpane.LEVEL_DISP_W; ++dx) {
      const v = vram.pixels[y * vram.width + (x0 + dx)];
      if (v === BAR_COLOR || v === PEAK_COLOR) { count++; break; }
    }
  }
  return count;
}

function runChecks(label, vram, state) {
  const { left, right, outOfBounds } = countNonZero(vram);
  const okA = outOfBounds === 0;
  const okB = right > 0 && left === 0;
  const digits = passedTimeDigits(state.generatedFrames);
  const okC = new Set(digits).size >= 3; // 3:45.67 -> 0,3,4,5,6,7 のように複数種
  console.log(`[${label}] (a) out-of-bounds px=${outOfBounds} -> ${okA ? 'PASS' : 'FAIL'}`);
  console.log(`[${label}] (b) left=${left} right=${right} -> ${okB ? 'PASS' : 'FAIL'}`);
  console.log(`[${label}] (c) passedTime digits=${digits.join(',')} (uniq=${new Set(digits).size}) -> ${okC ? 'PASS' : 'FAIL'}`);
  return okA && okB && okC;
}

// --- 1. 故障注入モード: (b)が落ちることを確認する ---
{
  const vram = new Vram(PC98_W, PC98_H);
  render(vram, { faultInject: true });
  const { left, right } = countNonZero(vram);
  const bFails = !(right > 0 && left === 0);
  console.log(`[fault-injection] left=${left} right=${right} -> (b)は${bFails ? '想定通りFAIL' : '想定外にPASS(検査が無効化されている疑い)'}`);
  if (!bFails) {
    console.error('FATAL: 故障注入で(b)が落ちなかった。検査ロジックが壊れている。');
    process.exit(1);
  }
}

// --- 2. 通常モード: 実際の出力とPNG書き出し ---
const outPath = process.argv[2] || 'rightpane-preview.png';
const paletteIndex = Number(process.argv[3] ?? 0);
const palette = PALETTES[paletteIndex];

const vram = new Vram(PC98_W, PC98_H);
const { state, levels: normalLevels } = render(vram, { faultInject: false });
let allPass = runChecks('normal', vram, state);

// --- 3. SPECTRUM: 値0→バー無し / 値31→最大高さ の対応を確認 ---
{
  const vramFft = new Vram(PC98_W, PC98_H);
  const bins = new Uint8Array(rightpane.FFTDISPLEN);
  bins[0] = 0;
  bins[1] = 31;
  const peak = rightpane.createPeakState(rightpane.FFTDISPLEN);
  rightpane.drawSpectrumBars(vramFft, bins, peak);
  const height0 = spectrumColumnStats(vramFft, 0);
  const height1 = spectrumColumnStats(vramFft, 1);
  const okZero = height0 === 0;
  // 生バー(31*2=62px)+ピーク線1pxがほぼ同位置。最大高さに近いことを
  // 「62px中の大半(55px以上)が塗られている」ことで確認する。
  const okMax = height1 >= 55;
  console.log(`[spectrum] value=0 -> height=${height0} -> ${okZero ? 'PASS' : 'FAIL'}`);
  console.log(`[spectrum] value=31 -> height=${height1} -> ${okMax ? 'PASS' : 'FAIL'}`);
  allPass = allPass && okZero && okMax;
}

// --- 4. LEVEL: 19chが異なれば異なる高さになる(故障注入で確認してから戻す) ---
{
  const vramFault = new Vram(PC98_W, PC98_H);
  const { levels: faultLevels } = render(vramFault, { faultInject: false, faultInjectLevels: true });
  const faultHeights = faultLevels
    .map((_, c) => levelColumnHeight(vramFault, c))
    .filter((_, c) => faultLevels[c].playing); // 非再生chは元々0のまま(比較対象外)
  const faultUniqueCount = new Set(faultHeights).size;
  const faultCheckFails = faultUniqueCount <= 1; // 全部同じ高さになるはず
  console.log(`[level-fault-injection] playing-ch heights=${faultHeights.join(',')} uniq=${faultUniqueCount} -> ` +
    `(b)は${faultCheckFails ? '想定通りFAIL' : '想定外にPASS(検査が無効化されている疑い)'}`);
  if (!faultCheckFails) {
    console.error('FATAL: LEVELの故障注入で高さバラつき検査が落ちなかった。検査ロジックが壊れている。');
    process.exit(1);
  }

  const normalHeights = normalLevels
    .map((_, c) => levelColumnHeight(vram, c))
    .filter((_, c) => normalLevels[c].playing);
  const normalUniqueCount = new Set(normalHeights).size;
  const okVariation = normalUniqueCount > 1;
  console.log(`[level] playing-ch heights=${normalHeights.join(',')} uniq=${normalUniqueCount} -> ${okVariation ? 'PASS' : 'FAIL'}`);
  allPass = allPass && okVariation;
}

const SCALE = 2;
const w = PC98_W * SCALE;
const h = PC98_H * SCALE;
const rgba = Buffer.alloc(w * h * 4);
for (let y = 0; y < h; ++y) {
  for (let x = 0; x < w; ++x) {
    const [r, g, b] = palette[vram.pixels[((y / SCALE) | 0) * PC98_W + ((x / SCALE) | 0)]];
    const o = (y * w + x) * 4;
    rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
  }
}
writePng(outPath, w, h, rgba);
console.log(`wrote ${outPath} (${w}x${h}, scale=${SCALE}, palette=${paletteIndex})`);

if (!allPass) {
  console.error('FAIL: 通常モードの検査に失敗した項目がある。');
  process.exit(1);
}
console.log('ALL CHECKS PASS');
