#!/usr/bin/env node
// 課題B: OGP(SNS/チャット共有プレビュー)用の画像を生成する。
//
// 実際のブラウザで曲を再生した瞬間のcanvas.toDataURL()を使う方法も試したが、
// この環境ではツール間で数十KBのbase64文字列を安定して受け渡せず(出力が
// 途中で壊れる実測を確認した)、信頼できなかった。そこで
// tools/render_preview.mjs / tools/render_rightpane_preview.mjs が確立している
// 「本物のfmdsp/描画コード(trackrow.js・rightpane.js)をNodeから直接呼び、
// 素のPNGエンコーダで書き出す」手法をそのまま流用する。ブラウザのcanvas経由
// ではないが、描画ロジック自体はアプリ実行時と完全に同一のコード(モックではない)。
//
// 「メーターやスペクトラムが動いている途中の絵」という要求を満たすため、
// パート行・スペクトラム・レベルメーターに全て非0のばらけた値を与え、
// 静止画でも「再生中」に見える状態を作る。
//
// 実行: node tools/gen_og_image.mjs [出力先.png]

import { deflateSync } from 'node:zlib';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Vram, PC98_W, PC98_H } from '../fmdsp/vram.js';
import { FmdspFont, SmallFont } from '../fmdsp/font.js';
import { FONT_SMALL } from '../fmdsp/font_small.js';
import { PALETTES } from '../fmdsp/palette.js';
import { drawTrackRows, TRACK_DISP_TABLE_OPNA } from '../fmdsp/trackrow.js';
import * as rightpane from '../fmdsp/rightpane.js';

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

// --- パート行: 全て「再生中」に見える、ばらけた値 ---
const FIELD_COUNT = 26;
function makeTrack({
  playing = 1, info = 0, ticks = 48, ticksLeft = 24, key = 0x25, actualKey = 0x25,
  tonenum = 12, volume = 100, gate = 80, detune = 0, status = 'PMD',
  fmslotmask = [0, 0, 0, 0], ppz8Ch = 0, ssgTone = 0, ssgNoise = 0,
} = {}) {
  const d = new Int32Array(FIELD_COUNT);
  d[0] = playing; d[1] = info; d[2] = ticks; d[3] = ticksLeft;
  d[4] = key; d[5] = actualKey; d[6] = tonenum; d[7] = volume;
  d[8] = gate; d[9] = detune;
  for (let i = 0; i < 9; ++i) d[10 + i] = i < status.length ? status.charCodeAt(i) : 0;
  for (let i = 0; i < 4; ++i) d[19 + i] = fmslotmask[i] ? 1 : 0;
  d[23] = ppz8Ch; d[24] = ssgTone; d[25] = ssgNoise;
  return d;
}

function buildEntryTracks() {
  const tracks = [];
  const maxSlot = Math.max(...TRACK_DISP_TABLE_OPNA);
  for (let i = 0; i <= maxSlot; ++i) tracks[i] = makeTrack();
  const statuses = ['PMD', 'FM', 'TIE', 'FM', 'PMD', 'FM', 'SSG', 'SSG', 'SSG'];
  TRACK_DISP_TABLE_OPNA.forEach((slot, row) => {
    tracks[slot] = makeTrack({
      playing: 1,
      key: ((1 + (row % 5)) << 4) | (row % 12),
      actualKey: ((1 + (row % 5)) << 4) | ((row + 1) % 12),
      tonenum: row * 7,
      volume: 40 + row * 9,
      gate: 100 - row * 6,
      detune: row - 4,
      ticks: 48,
      ticksLeft: 48 - row * 4,
      status: statuses[row % statuses.length],
    });
  });
  return tracks;
}

function dummyState() {
  return {
    generatedFrames: BigInt(55467 * 61 + Math.floor(55467 * 0.23)), // 1:01.23相当
    timerbCnt: 4821,
    timerb: 128,
    loopCnt: 0,
    cpuUsage: 0,
    fps: 0,
    timerbCntLoop: 12,
    loopTimerbCnt: 240,
    playing: true,
    stopped: false,
    paused: false,
    frameCnt: 37,
  };
}

// 低域が高く高域へ緩やかに減衰する、いかにも音楽が鳴っていそうなFFT分布。
function dummyFft() {
  const bins = new Uint8Array(rightpane.FFTDISPLEN);
  for (let i = 0; i < bins.length; ++i) {
    const t = i / (bins.length - 1);
    const wobble = (Math.sin(i * 0.7) + 1) * 4;
    bins[i] = Math.max(0, Math.round(24 * (1 - t) ** 1.3 + wobble));
  }
  return bins;
}

function dummyLevels() {
  const levels = [];
  for (let c = 0; c < rightpane.FMDSP_LEVEL_COUNT; ++c) {
    const playing = c % 4 !== 3;
    levels.push({
      level: playing ? 3000 + ((c * 1777) % 9000) : 0,
      pan: c % 6,
      prog: playing ? (c * 11 + 3) % 128 : 0,
      key: playing ? (((c % 8) << 4) | (c % 11)) : 0xff,
      playing,
    });
  }
  return levels;
}

async function main() {
  const outPath = process.argv[2] || 'html/og-image.png';
  const palette = PALETTES[0];

  const vram = new Vram(PC98_W, PC98_H);
  vram.clear(0);

  // 2026-08-15のFMSoundバージョン欄相当(実データに寄せる。og-image再生成のたびに
  // 変わっても実害はないため決め打ちでよい)。
  rightpane.drawStaticDecorations(vram, ['26', '08', '15']);

  // FmdspFont.load()はブラウザのfetch()前提なので、Nodeではreadfileから直接構築する
  // (tools/verify_cp932_render.mjs等、他のNode検証スクリプトと同じ読み方)。
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const romBytes = new Uint8Array(readFileSync(join(__dirname, '../fmdsp/shinonome.rom')));
  const fmdspFont = new FmdspFont(romBytes);
  const smallFont = new SmallFont(FONT_SMALL);
  drawTrackRows(vram, fmdspFont, buildEntryTracks());

  const state = dummyState();
  rightpane.drawDynamic(vram, state);

  const fftPeakState = rightpane.createPeakState(rightpane.FFTDISPLEN);
  const fftBins = dummyFft();
  for (let i = 0; i < 4; ++i) rightpane.drawSpectrumBars(vram, fftBins, fftPeakState);

  const levelPeakState = rightpane.createPeakState(rightpane.FMDSP_LEVEL_COUNT);
  const levels = dummyLevels();
  for (let i = 0; i < 4; ++i) rightpane.drawLevelMeters(vram, levels, levelPeakState);

  // --- 640x400のFMDSP画面を、OGP標準サイズ1200x630のキャンバスへ収める ---
  // ヘッダー(--header-bg: #0c0c0c)と同系色のレターボックスにして、ページの
  // 黒いコンソール部にそのまま馴染む見た目にする。
  const OUT_W = 1200;
  const OUT_H = 630;
  const SCALE = Math.min(OUT_W / PC98_W, OUT_H / PC98_H); // 1.575
  const drawW = Math.round(PC98_W * SCALE);
  const drawH = Math.round(PC98_H * SCALE);
  const offX = Math.floor((OUT_W - drawW) / 2);
  const offY = Math.floor((OUT_H - drawH) / 2);

  const BG = [12, 12, 12]; // --header-bg
  const rgba = Buffer.alloc(OUT_W * OUT_H * 4);
  for (let y = 0; y < OUT_H; ++y) {
    for (let x = 0; x < OUT_W; ++x) {
      const o = (y * OUT_W + x) * 4;
      const ix = x - offX;
      const iy = y - offY;
      let r, g, b;
      if (ix >= 0 && ix < drawW && iy >= 0 && iy < drawH) {
        const srcX = Math.min(PC98_W - 1, (ix / SCALE) | 0);
        const srcY = Math.min(PC98_H - 1, (iy / SCALE) | 0);
        [r, g, b] = palette[vram.pixels[srcY * PC98_W + srcX]];
      } else {
        [r, g, b] = BG;
      }
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
    }
  }
  writePng(outPath, OUT_W, OUT_H, rgba);

  const nonZero = vram.pixels.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0);
  console.log(`wrote ${outPath} (${OUT_W}x${OUT_H}, fmdsp scale=${SCALE.toFixed(3)}), fmdsp nonzero px=${nonZero}`);
  if (nonZero < 1000) {
    console.error('FAIL: FMDSP画面がほぼ空(nonzero px too low)。og-imageとして不適切。');
    process.exit(1);
  }
  void smallFont; // (コメント欄描画は今回のOG画像では使わないが、importは検証済みモジュールのまま残す)
}

main();
