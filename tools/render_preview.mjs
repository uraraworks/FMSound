#!/usr/bin/env node
// パート行レンダラの描画結果を PNG に書き出して目視確認するためのスクリプト。
// ブラウザを立ち上げずに見た目を確認できるようにするのが目的。
//
// 実行: node tools/render_preview.mjs [出力先.png] [パレット番号 0-9]

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { Vram, PC98_W, PC98_H } from '../pmdweb/html/fmdsp/vram.js';
import { SmallFont } from '../pmdweb/html/fmdsp/font.js';
import { FONT_SMALL } from '../pmdweb/html/fmdsp/font_small.js';
import { PALETTES } from '../pmdweb/html/fmdsp/palette.js';
import { TRACK_DISP_TABLE_OPNA, drawTrackRows } from '../pmdweb/html/fmdsp/trackrow.js';

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

// 行ごとに違う状態を入れて、表示の差が目で見えるようにする。
function buildEntryTracks() {
  const tracks = [];
  const maxSlot = Math.max(...TRACK_DISP_TABLE_OPNA);
  for (let i = 0; i <= maxSlot; ++i) tracks[i] = makeTrack();
  TRACK_DISP_TABLE_OPNA.forEach((slot, row) => {
    tracks[slot] = makeTrack({
      playing: row === 3 ? 0 : 1,
      // key = (オクターブ<<4) | ノート番号(0-11)。休符センチネルは 0xff。
      key: row === 4 ? 0xff : ((1 + (row % 5)) << 4) | (row % 12),
      actualKey: row === 4 ? 0xff : ((1 + (row % 5)) << 4) | ((row + 1) % 12),
      tonenum: row * 7,
      volume: 20 + row * 11,
      gate: 100 - row * 8,
      detune: row - 5,
      ticks: 48,
      ticksLeft: 48 - row * 5,
      status: ['PMD', 'FM', 'SSG', 'STOP', 'REST', 'ADPCM', 'LFO', 'TIE', 'PAN', 'END'][row],
    });
  });
  return tracks;
}

function writePng(path, width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; ++y) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
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
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
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

const outPath = process.argv[2] || 'trackrow-preview.png';
const paletteIndex = Number(process.argv[3] ?? 0);
const palette = PALETTES[paletteIndex];

const vram = new Vram(PC98_W, PC98_H);
vram.clear(0);
drawTrackRows(vram, new SmallFont(FONT_SMALL), buildEntryTracks());

// 等倍だと 5x6 フォントが読めないので3倍に拡大して書き出す。
const SCALE = 3;
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

const nonZero = vram.pixels.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0);
console.log(`wrote ${outPath} (${w}x${h}, scale=${SCALE}, palette=${paletteIndex}), nonzero px=${nonZero}`);
