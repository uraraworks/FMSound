// PC-98 VRAM相当の簡易実装。
// 出典: docs/fmdsp-layout.md §1 (upstream fmdsp-pacc.h:20-21)
//   論理解像度 640x400、パレットインデックス方式、10色 (FMDSP_PALETTE_COLORS)。
//
// 本家(fmdsp-pacc.c)はGPUテクスチャアトラス+矩形バッファ方式だが、
// Web版はCanvas 2Dで十分な速度が出るため、単純な
//   「パレットインデックスのUint8Array」→「ImageDataへ展開してputImageData」
// という直接方式を採る。§9-1で触れられているstatic/streamの2階層ダーティ管理は
// 今回のスコープ(パート行のみ)では簡略化し、毎フレーム全体を描き直す。

import { TIER_NORMAL, DIM_FACTORS } from './dim-tier.js';

export const PC98_W = 640; // fmdsp-pacc.h:20 (docs/fmdsp-layout.md §1)
export const PC98_H = 400; // fmdsp-pacc.h:21 (docs/fmdsp-layout.md §1)

export class Vram {
  constructor(width = PC98_W, height = PC98_H) {
    this.width = width;
    this.height = height;
    // パレットインデックス(0-9)。0 = 背景(黒相当)。
    this.pixels = new Uint8Array(width * height);
    // 段階的暗色表示(通常/ミュート/未使用、fmdsp/dim-tier.js)用の「このピクセルは
    // 描かれた時点でどの段階だったか」平面。パレットインデックスとは独立に持つ
    // (色番号は変えず、最終RGB展開時にこの段階だけを見て輝度を落とす、という
    // 今回の方式の核。2026-08-17、パレット番号付け替え方式からの置き換え。
    // fmdsp/dim-tier.js冒頭コメント参照)。既定は0=TIER_NORMAL。
    this.tiers = new Uint8Array(width * height);
    // setTier()で切り替える「これから描くピクセルの段階」。setPixel/fillRectが
    // 書き込み時にこの値をtiersへ焼き込む(blitCopy/blitColorは内部でsetPixelを
    // 呼ぶだけなので、追加の変更無しに自動的に段階の対象になる)。
    this.currentTier = TIER_NORMAL;
  }

  // 以降このメソッドを呼び直すまでの描画(setPixel経由の全メソッド)が属する
  // 段階を切り替える。呼び出し側(drawTrackRow/drawLevelMeters等)は描画開始時に
  // 呼び、描き終えたら必ずTIER_NORMAL(0)へ戻すこと(戻し忘れると、続けて描く
  // 無関係な要素まで暗くなってしまう)。
  setTier(tier) {
    this.currentTier = tier;
  }

  clear(index = 0) {
    this.pixels.fill(index);
    this.tiers.fill(TIER_NORMAL);
  }

  setPixel(x, y, index) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = y * this.width + x;
    this.pixels[i] = index;
    this.tiers[i] = this.currentTier;
  }

  fillRect(x, y, w, h, index) {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + w);
    const y1 = Math.min(this.height, y + h);
    for (let yy = y0; yy < y1; ++yy) {
      const row = yy * this.width;
      for (let xx = x0; xx < x1; ++xx) {
        this.pixels[row + xx] = index;
        this.tiers[row + xx] = this.currentTier;
      }
    }
  }

  // fmdsp-pacc.c の pacc_mode_copy 相当: スプライトのパレットインデックスを
  // そのまま書き込む。値0は透明(下地を保持)として扱う。
  // sprite: 長さ w*h の配列(パレットインデックス)。
  blitCopy(sprite, spriteW, x, y, w, h, srcX = 0, srcY = 0) {
    for (let yy = 0; yy < h; ++yy) {
      const sy = srcY + yy;
      for (let xx = 0; xx < w; ++xx) {
        const sx = srcX + xx;
        const value = sprite[sy * spriteW + sx];
        if (value !== 0) this.setPixel(x + xx, y + yy, value);
      }
    }
  }

  // fmdsp-pacc.c の pacc_mode_color / pacc_mode_color_trans 相当: スプライトの
  // 非0ピクセルを一律 `color` で塗る(1bitマスクとして使う)。
  blitColor(mask, maskW, x, y, w, h, color, srcX = 0, srcY = 0) {
    for (let yy = 0; yy < h; ++yy) {
      const sy = srcY + yy;
      for (let xx = 0; xx < w; ++xx) {
        const sx = srcX + xx;
        if (mask[sy * maskW + sx]) this.setPixel(x + xx, y + yy, color);
      }
    }
  }

  // パレット参照してRGBA(Uint8ClampedArray, ImageData互換)へ展開する。
  // palette: [[r,g,b], ...] (0番から順に、docs/fmdsp-layout.md §1 の10色パレット)。
  // dimFactors: 段階(tiers平面の値)ごとの輝度係数。既定はfmdsp/dim-tier.js
  // DIM_FACTORS([1.0, 0.5, 0.25] = 通常/ミュート/未使用)。RGB各成分に同じ係数を
  // 掛けるだけなのでRGBの比(色相)は保たれる(このtoImageData()が「パレット番号
  // →実RGB」に変換する唯一の箇所なので、暗色化はここに一本化してある。個々の
  // 描画関数は色番号を変えず、vram.setTier()で段階を申告するだけでよい)。
  toImageData(palette, dimFactors = DIM_FACTORS) {
    const rgba = new Uint8ClampedArray(this.width * this.height * 4);
    for (let i = 0; i < this.pixels.length; ++i) {
      const color = palette[this.pixels[i]] || [0, 0, 0];
      const factor = dimFactors[this.tiers[i]] ?? 1;
      const o = i * 4;
      rgba[o] = Math.round(color[0] * factor);
      rgba[o + 1] = Math.round(color[1] * factor);
      rgba[o + 2] = Math.round(color[2] * factor);
      rgba[o + 3] = 255;
    }
    return new ImageData(rgba, this.width, this.height);
  }
}
