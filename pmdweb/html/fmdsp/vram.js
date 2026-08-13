// PC-98 VRAM相当の簡易実装。
// 出典: docs/fmdsp-layout.md §1 (upstream fmdsp-pacc.h:20-21)
//   論理解像度 640x400、パレットインデックス方式、10色 (FMDSP_PALETTE_COLORS)。
//
// 本家(fmdsp-pacc.c)はGPUテクスチャアトラス+矩形バッファ方式だが、
// Web版はCanvas 2Dで十分な速度が出るため、単純な
//   「パレットインデックスのUint8Array」→「ImageDataへ展開してputImageData」
// という直接方式を採る。§9-1で触れられているstatic/streamの2階層ダーティ管理は
// 今回のスコープ(パート行のみ)では簡略化し、毎フレーム全体を描き直す。

export const PC98_W = 640; // fmdsp-pacc.h:20 (docs/fmdsp-layout.md §1)
export const PC98_H = 400; // fmdsp-pacc.h:21 (docs/fmdsp-layout.md §1)

export class Vram {
  constructor(width = PC98_W, height = PC98_H) {
    this.width = width;
    this.height = height;
    // パレットインデックス(0-9)。0 = 背景(黒相当)。
    this.pixels = new Uint8Array(width * height);
  }

  clear(index = 0) {
    this.pixels.fill(index);
  }

  setPixel(x, y, index) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.pixels[y * this.width + x] = index;
  }

  fillRect(x, y, w, h, index) {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + w);
    const y1 = Math.min(this.height, y + h);
    for (let yy = y0; yy < y1; ++yy) {
      const row = yy * this.width;
      for (let xx = x0; xx < x1; ++xx) this.pixels[row + xx] = index;
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
  toImageData(palette) {
    const rgba = new Uint8ClampedArray(this.width * this.height * 4);
    for (let i = 0; i < this.pixels.length; ++i) {
      const color = palette[this.pixels[i]] || [0, 0, 0];
      const o = i * 4;
      rgba[o] = color[0];
      rgba[o + 1] = color[1];
      rgba[o + 2] = color[2];
      rgba[o + 3] = 255;
    }
    return new ImageData(rgba, this.width, this.height);
  }
}
