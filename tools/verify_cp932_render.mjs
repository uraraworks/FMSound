#!/usr/bin/env node
// drawTextCp932 (pmdweb/html/fmdsp/font.js) の実描画検証。
// shinonome.rom を読み、CP932バイト列("あいうえお漢字ABC"相当+ANSIエスケープ+半角カナ)を
// 実際に描画し、以下を確認する:
//   (a) 各全角文字のグリフに非0ピクセルがある
//   (b) 隣接する異なる文字のビットマップが互いに異なる(全部同じ字形になっていない)
//   (c) 半角カナ(row 0x29/0x2a)が半角幅で描かれる(カーソル送り量で確認)
//   (d) ANSIエスケープ列が画面に文字として出ない(エスケープ有無で結果が同一)
//
// 故障注入: sjis2jis に +1 のズレを入れた版で (b) が壊れることを確認してから
// 本物に戻して全項目PASSさせる(常にPASSする検査は無意味なため)。

import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vram, PC98_W, PC98_H } from '../pmdweb/html/fmdsp/vram.js';
import { FmdspFont, drawTextCp932 } from '../pmdweb/html/fmdsp/font.js';
import * as cp932 from '../pmdweb/html/fmdsp/cp932.js';
import { PALETTES } from '../pmdweb/html/fmdsp/palette.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const romBytes = new Uint8Array(readFileSync(join(REPO_ROOT, 'pmdweb/html/shinonome.rom')));
const font = new FmdspFont(romBytes);

// CP932バイト列。事前に手動で確認したバイト表現(Shift_JISの一般的な符号化):
//   あ=82A0 い=82A2 漢=8ABF 字=8E9A A=41 B=42 C=43
//   半角カナ相当(JIS row 0x29): SJIS 85 40 (tools/compare_sjis2jis.mjsの探索で確認)
//   ANSIエスケープ: ESC [ 3 1 m (CSI、SGR相当。font_putlineは中身を読み飛ばすだけで
//   意味解釈はしない)
const AH = 0x82, IH = 0x82;
const bytesNoEsc = new Uint8Array([
  0x41, 0x42, // "AB"
  0x82, 0xa0, // あ
  0x82, 0xa2, // い
  0x8a, 0xbf, // 漢
  0x8e, 0x9a, // 字
  0x43, // "C"
  0,
]);
const bytesWithEsc = new Uint8Array([
  0x41, // "A"
  0x1b, 0x5b, 0x33, 0x31, 0x6d, // ESC [ 3 1 m (CSI, 読み飛ばされるはず)
  0x42, // "B"
  0x82, 0xa0,
  0x82, 0xa2,
  0x8a, 0xbf,
  0x8e, 0x9a,
  0x43,
  0,
]);
const halfwidthBytes = new Uint8Array([0x85, 0x40, 0]); // JIS row 0x29 (半角)
const fullwidthRefBytes = new Uint8Array([0x82, 0xa0, 0]); // あ (全角、比較対象)

function renderIsolated(bytes) {
  const vram = new Vram(PC98_W, PC98_H);
  vram.clear(0);
  const xo = drawTextCp932(vram, font, bytes, 0, 0, 1, 0);
  return { vram, xo };
}

function glyphRegionNonZero(vram, x0, y0, w, h) {
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      if (vram.pixels[(y0 + y) * vram.width + (x0 + x)]) return true;
    }
  }
  return false;
}

function bitmapAt(vram, x0, y0, w, h) {
  const out = [];
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) out.push(vram.pixels[(y0 + y) * vram.width + (x0 + x)]);
  }
  return out.join('');
}

function run(sjis2jisImpl, label) {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok, detail });

  // sjis2jisImpl差し替え用に、font.js内部が使うcp932.jsのsjis2jisを直接は
  // 差し替えられない(importでbindされているため)。代わりにdrawTextCp932の
  // 引数fontのgetJisHalfをラップし、常に固定のjisコード(0x2121、全角スペース)
  // のグリフを返すよう壊す。これは「sjis2jisが常に同じ誤ったコードへ変換して
  // しまう」故障を模したもので、異なる文字が同じ(≒空白)ビットマップに潰れる
  // ため(b)を確実に壊す。(+1程度のズレでは隣接JISコードのグリフもたまたま
  // 非空で相異なることが多く、故障注入として弱すぎたため強めた)
  const testFont = sjis2jisImpl === cp932.sjis2jis ? font : {
    w: font.w,
    h: font.h,
    getAnk: (c) => font.getAnk(c),
    getJisHalf: (_jis, right) => font.getJisHalf(0x2121, right),
  };

  // --- (a) 全角文字のグリフに非0ピクセルがある ---
  const { vram: vAh } = renderIsolated(fullwidthRefBytes);
  const ahHasPixels = glyphRegionNonZero(vAh, 0, 0, 16, 16);
  check('a: fullwidth glyph has nonzero pixels (あ)', ahHasPixels,
    `nonzero=${ahHasPixels}`);

  // --- (b) 隣接する異なる文字のビットマップが互いに異なる ---
  // "あ","い","漢","字" をそれぞれ単独描画してビットマップを比較する。
  const chars = [
    { name: 'あ', bytes: new Uint8Array([0x82, 0xa0, 0]) },
    { name: 'い', bytes: new Uint8Array([0x82, 0xa2, 0]) },
    { name: '漢', bytes: new Uint8Array([0x8a, 0xbf, 0]) },
    { name: '字', bytes: new Uint8Array([0x8e, 0x9a, 0]) },
  ];
  const bitmaps = chars.map(({ name, bytes }) => {
    const v = new Vram(PC98_W, PC98_H);
    v.clear(0);
    drawTextCp932(v, testFont, bytes, 0, 0, 1, 0);
    return { name, bitmap: bitmapAt(v, 0, 0, 16, 16) };
  });
  let allDistinct = true;
  for (let i = 0; i < bitmaps.length; ++i) {
    for (let j = i + 1; j < bitmaps.length; ++j) {
      if (bitmaps[i].bitmap === bitmaps[j].bitmap) {
        allDistinct = false;
        results.push({
          name: `b: ${bitmaps[i].name} vs ${bitmaps[j].name} distinct`,
          ok: false,
          detail: 'identical bitmap',
        });
      }
    }
  }
  if (allDistinct) check('b: all sampled fullwidth glyphs distinct', true, '4C2=6 pairs all differ');

  // --- (c) 半角カナ(row0x29/0x2a)が半角幅で描かれる ---
  const { xo: halfXo } = renderIsolated(halfwidthBytes);
  const { xo: fullXo } = renderIsolated(fullwidthRefBytes);
  check('c: halfwidth advance == font.w (half of fullwidth advance)',
    halfXo === font.w && fullXo === font.w * 2,
    `halfXo=${halfXo} fullXo=${fullXo} font.w=${font.w}`);

  // --- (d) ANSIエスケープ列が画面に文字として出ない ---
  const { vram: vNoEsc, xo: xoNoEsc } = renderIsolated(bytesNoEsc);
  const { vram: vWithEsc, xo: xoWithEsc } = renderIsolated(bytesWithEsc);
  let pixelsIdentical = xoNoEsc === xoWithEsc;
  if (pixelsIdentical) {
    for (let i = 0; i < vNoEsc.pixels.length && pixelsIdentical; ++i) {
      if (vNoEsc.pixels[i] !== vWithEsc.pixels[i]) pixelsIdentical = false;
    }
  }
  check('d: ANSI escape sequence produces no visible marks (with-esc == without-esc render)',
    pixelsIdentical, `xoNoEsc=${xoNoEsc} xoWithEsc=${xoWithEsc} pixelsIdentical=${pixelsIdentical}`);

  console.log(`--- ${label} ---`);
  let pass = true;
  for (const r of results) {
    console.log(`  [${r.ok ? 'PASS' : 'FAIL'}] ${r.name} (${r.detail})`);
    if (!r.ok) pass = false;
  }
  return pass;
}

// 1. 故障注入版(誤ったgetJisHalfでsjis2jisの+1ズレを模す)を先に確認する。
//    (b)相当(異なる文字が異なるビットマップになる)が壊れることを期待する。
const injectedPass = run('injected(+1 offset)', 'FAULT INJECTION (expect FAIL)');
console.log(injectedPass
  ? 'UNEXPECTED: fault injection did not break anything (test is not sensitive)'
  : 'OK: fault injection broke the check as expected');

// 2. 本物で全項目PASSさせる。
const realPass = run(cp932.sjis2jis, 'real implementation (expect PASS)');

// --- PNGプレビュー書き出し(実機確認用) ---
function writePng(path, width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; ++y) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
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
  const crc32 = (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; ++i) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return c ^ -1;
  };
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

// コメント欄を含むフルプレビュー: パート行は空、コメント欄(PMDメモモード)に
// タイトル/作曲者/編曲者/メモをCP932で描く。
const { drawComment } = await import('../pmdweb/html/fmdsp/comment.js');
const { SmallFont } = await import('../pmdweb/html/fmdsp/font.js');
const { FONT_SMALL } = await import('../pmdweb/html/fmdsp/font_small.js');
const smallFont = new SmallFont(FONT_SMALL);

const previewVram = new Vram(PC98_W, PC98_H);
previewVram.clear(0);
const commentLines = {
  0: new Uint8Array([...Buffer.from('title: '), 0x82, 0xa0, 0x82, 0xa2, 0x8a, 0xbf, 0x8e, 0x9a, 0]),
  1: new Uint8Array([...Buffer.from('composer '), 0x8a, 0xbf, 0]),
  2: new Uint8Array([...Buffer.from('arranger '), 0x8e, 0x9a, 0]),
  3: new Uint8Array([...Buffer.from('memo line1 '), 0x82, 0xa0, 0]),
};
drawComment(
  previewVram, smallFont, font,
  (line) => (line in commentLines ? commentLines[line].subarray(0, commentLines[line].length - 1) : null),
  true, 0, 1
);
const palette = PALETTES[0];
const SCALE = 2;
const w = PC98_W * SCALE, h = PC98_H * SCALE;
const rgba = Buffer.alloc(w * h * 4);
for (let y = 0; y < h; ++y) {
  for (let x = 0; x < w; ++x) {
    const [r, g, b] = palette[previewVram.pixels[((y / SCALE) | 0) * PC98_W + ((x / SCALE) | 0)]];
    const o = (y * w + x) * 4;
    rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
  }
}
const outPath = join(REPO_ROOT, 'tools/cp932-comment-preview.png');
writePng(outPath, w, h, rgba);
const nonZero = previewVram.pixels.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0);
console.log(`wrote ${outPath} (${w}x${h}, nonzero px=${nonZero})`);

if (injectedPass || !realPass) {
  console.log('OVERALL FAIL');
  process.exit(1);
}
console.log('OVERALL PASS');
