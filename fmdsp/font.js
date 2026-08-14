// フォント描画。shinonome ROM(曲名・コメント欄用、8x16)と
// font_fmdsp_small/medium(パート行のラベル・数値用、5x6・6x8)の両方を
// 同じ「フォントオブジェクトを受け取るdrawText」で扱えるよう一般化してある。
//
// フォントオブジェクトの共通インタフェース:
//   { w, h, getAnk(code) -> Uint8Array(h bytes, 1byte/row) | null }
// getAnk() が返す1グリフ = 1バイト/行 x h行。ビット順は下記の通り
// shinonome ROM と font_fmdsp_small/medium で同一(MSBが左端)であることを
// 確認済みなので、分岐せず共通の glyphToMask で展開する。
//
// --- shinonome ROM のアドレス計算 (upstream/98fmplayer/fmdsp/font_rom.c) ---
//   ANK (半角8x16, 1byte/row):
//     addr = 0x800 + code*16                                   (font_rom.c: type==ANK)
//   全角 (16x16, 左右2枚の8x16として保持、1byte/row/半分):
//     row = jis >> 8, cell = jis & 0xff
//     addr(JIS_LEFT)  = 0x800 + 0x60*16*2*(row-0x20) + (cell<<5)
//     addr(JIS_RIGHT) = addr(JIS_LEFT) + 16                     (font_rom.c: else branch)
//
// --- ビット順の確認根拠 ---
// 3つのフォントは同じ `font_putchar`/`font_putline` (fmdsp-pacc.c:2172-2184,
// 2186-2260) で描画されており、共通のビット展開式
//   `font[yi] & (1<<(7-xi))` (fmdsp-pacc.c:2179)
// を使う。さらにテクスチャへの事前展開ルーチンでも
//   `data[y*(font->width_half/8+1)+(x/8)] & (1<<(7-x))` (fmdsp-pacc.c:212)
// と、幅(width_half=5/6/8)によらず同一のMSB-左端の式で読んでいる。
// つまり shinonome ROM (font_rom.c, width_half=8) と font_fmdsp_small/medium
// (font_fmdsp_small.c:14-16,26-28, width_half=5/6) はビット順が一致しており、
// 分岐は不要と確認できた。
//
// --- 文字送り幅について ---
// font_putline (fmdsp-pacc.c:2241 `xo += fw;`) は font->width_half をそのまま
// 送り幅として使う。shinonome ROMは8px固定送りだが、font_fmdsp_smallは5px、
// font_fmdsp_mediumは6px送りであり、GLYPH_Wのような固定値は使えない
// (実際に5px/6pxピッチでないと fmdsp_sprites.h の TDETAIL_*_X 等の間隔と
// 合わなくなる)。よって drawText は font.w を都度参照して送る。

const FONT_ROM_FILESIZE = 0x46800; // font.h: FONT_ROM_FILESIZE
const FONT_ROM_GLYPH_BYTES = 16; // 1バイト/行 x 16行 (ANKも全角の片側もこのサイズ)

// shinonome ROM専用の固定値(曲名・コメント欄で使う8x16)。
export const GLYPH_W = 8;
export const GLYPH_H = 16;

export class FmdspFont {
  constructor(romBytes) {
    if (romBytes.length !== FONT_ROM_FILESIZE) {
      throw new Error(
        `shinonome.rom size mismatch: got ${romBytes.length}, expected ${FONT_ROM_FILESIZE}`
      );
    }
    this.rom = romBytes;
    // 共通インタフェース用。
    this.w = GLYPH_W;
    this.h = GLYPH_H;
  }

  static async load(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`failed to fetch ${url}: ${response.status}`);
    const buffer = await response.arrayBuffer();
    return new FmdspFont(new Uint8Array(buffer));
  }

  // ANK (半角8x16)。戻り値は16バイトのUint8Array部分ビュー、範囲外はnull。
  getAnk(code) {
    const addr = 0x800 + (code << 4);
    if (addr + FONT_ROM_GLYPH_BYTES > this.rom.length) return null;
    return this.rom.subarray(addr, addr + FONT_ROM_GLYPH_BYTES);
  }

  // 全角(JIS: 上位バイト<<8|下位バイト)の左半分/右半分。
  getJisHalf(jis, right) {
    const row = (jis >> 8) & 0xff;
    const cell = jis & 0xff;
    let addr = 0x800 + 0x60 * 16 * 2 * (row - 0x20) + (cell << 5);
    if (right) addr += 16;
    if (addr < 0 || addr + FONT_ROM_GLYPH_BYTES > this.rom.length) return null;
    return this.rom.subarray(addr, addr + FONT_ROM_GLYPH_BYTES);
  }
}

// tools/gen_font_small.py が生成する { w, h, bytesPerGlyph, data } オブジェクト
// (font_small.js の FONT_SMALL / FONT_MEDIUM)に、shinonome ROM と同じ
// getAnk(code) インタフェースを持たせるラッパー。
export class SmallFont {
  constructor({ w, h, bytesPerGlyph, data }) {
    this.w = w;
    this.h = h;
    this.bytesPerGlyph = bytesPerGlyph;
    this.data = data;
  }

  getAnk(code) {
    if (code < 0 || code > 0xff) return null;
    const addr = code * this.bytesPerGlyph;
    if (addr + this.bytesPerGlyph > this.data.length) return null;
    return this.data.subarray(addr, addr + this.bytesPerGlyph);
  }
}

// vram.blitColor が期待する「flat配列+width」形式へ、w x h glyphの
// 1byte/rowビットマップを展開する。MSBが左端(上記コメントの確認根拠を参照)。
function glyphToMask(glyphBytes, w, h) {
  const mask = new Uint8Array(w * h);
  if (!glyphBytes) return mask;
  for (let y = 0; y < h; ++y) {
    const rowByte = glyphBytes[y];
    for (let x = 0; x < w; ++x) {
      if (rowByte & (1 << (7 - x))) mask[y * w + x] = 1;
    }
  }
  return mask;
}

// ANK文字1つをvramに描画する。font は { w, h, getAnk(code) } を持つ
// フォントオブジェクト(FmdspFont / SmallFont のいずれも可)。
// color はパレットインデックス。
export function drawAnkChar(vram, font, code, x, y, color) {
  const glyph = font.getAnk(code);
  const mask = glyphToMask(glyph, font.w, font.h);
  vram.blitColor(mask, font.w, x, y, font.w, font.h, color);
}

// ASCII文字列(半角のみ)を描画する。fmdsp-pacc.c の font_putline のうち
// ANK部分のみを実装したもの。文字送りは font.w (font_putline の `xo += fw` 相当、
// fmdsp-pacc.c:2241)。
//
// 全角対応について: UTF-8(JS文字列)→ SJIS/JIS への変換テーブルが必要になるが、
// フォントROM抽出のスコープには含まれていないため未実装。全角文字が来た場合は
// '?' のANKグリフにフォールバックする(でっちあげを避けるため、変換せず明示的に代替)。
export function drawText(vram, font, str, x, y, color) {
  let cursorX = x;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code > 0xff) {
      // 全角: 未実装(上記コメント参照)。'?' で代替する。
      drawAnkChar(vram, font, 0x3f, cursorX, y, color);
    } else {
      drawAnkChar(vram, font, code, cursorX, y, color);
    }
    cursorX += font.w;
  }
  return cursorX;
}

// --- CP932(SJIS)バイト列描画: font_putline の移植 ---
// 出典: upstream/98fmplayer/fmdsp/fmdsp-pacc.c:2186-2267 (font_putline)。
// ANSIエスケープ(ESC/CSI/SYNC)読み飛ばし・タブ展開・全角(JIS_LEFT/JIS_RIGHT
// 2枚描画)・maxWidth打ち切りをすべて含む。1バイトずつ処理する必要があるため
// JSの文字列(UTF-16)ではなく Uint8Array(CP932バイト列) を直接受け取る。
import { sjisIsMbStart, jisIsHalfwidth, sjis2jis } from './cp932.js';

// fmdsp-pacc.c:2172-2184 (font_putchar) の移植。glyphBytes は 1byte/row の
// ビットマップ(shinonome ROMの getAnk/getJisHalf がそのまま返す形式)。
// MSBが左端 (`font[yi] & (1<<(7-xi))`, fmdsp-pacc.c:2179)。
function putGlyph(vram, glyphBytes, x, y, w, h, color) {
  if (!glyphBytes) return;
  for (let yi = 0; yi < h; ++yi) {
    const rowByte = glyphBytes[yi];
    if (!rowByte) continue;
    for (let xi = 0; xi < w; ++xi) {
      if (rowByte & (1 << (7 - xi))) vram.setPixel(x + xi, y + yi, color);
    }
  }
}

// font: { w(=width_half), h, getAnk(code), getJisHalf(jis, right)? } を持つ
// フォントオブジェクト。getJisHalf を持たないフォント(font_fmdsp_small等)は
// 全角相当のコードポイントが来ても font->get() が0を返す本家の挙動
// (font_fmdsp_small.c:9 `if (type != FMDSP_FONT_ANK) return 0;`)に合わせ、
// グリフ無し(何も描かない)として扱う。
//
// bytes: CP932バイト列(Uint8Array)。ESC/CSI/SYNCのANSIエスケープシーケンスを
// 読み飛ばす(fmdsp-pacc.c:2199-2229のstate machineをそのまま移植)。
// maxWidth: 0または省略時は無制限扱い(font_putlineは呼び出し側でtexwidth-xに
// フォールバックするが、drawTextCp932ではvram.width基準にする)。
export function drawTextCp932(vram, font, bytes, x, y, color, maxWidth) {
  const fw = font.w;
  const fh = font.h;
  let xo = 0;
  const limit = maxWidth || (vram.width - x);

  const STATE_NORMAL = 0, STATE_ESC = 1, STATE_CSI = 2, STATE_SYNC = 3;
  let escState = STATE_NORMAL;

  let i = 0;
  let sjisIs2nd = false;
  let sjis1st = 0;
  while (i < bytes.length && bytes[i] !== 0) {
    if (!sjisIs2nd) {
      const c = bytes[i];
      if (!sjisIsMbStart(c)) {
        if (escState !== STATE_NORMAL || c === 0x1b) {
          // fmdsp-pacc.c:2209-2229
          if (escState === STATE_SYNC) {
            escState = STATE_NORMAL;
          } else if (escState === STATE_ESC) {
            if (c === 0x5b /* '[' */) {
              escState = STATE_CSI;
            } else if (c === 0x21 /* '!' */) {
              escState = STATE_SYNC;
            } else {
              escState = STATE_NORMAL;
            }
          } else if (escState === STATE_CSI) {
            if ((0x30 <= c && c <= 0x39) || c === 0x3b /* ';' */) {
              // CSIのパラメータ継続。状態維持。
            } else {
              escState = STATE_NORMAL;
            }
          } else {
            escState = STATE_ESC;
          }
          ++i;
          continue;
        }
        if (c === 0x09 /* '\t' */) {
          // fmdsp-pacc.c:2231-2234
          xo += fw * 8;
          xo -= xo % (fw * 8);
          ++i;
        } else {
          // fmdsp-pacc.c:2235-2242
          if ((xo + fw) > limit) return xo;
          const glyph = font.getAnk ? font.getAnk(c) : null;
          putGlyph(vram, glyph, x + xo, y, fw, fh, color);
          xo += fw;
          ++i;
        }
      } else {
        sjisIs2nd = true;
        sjis1st = c;
        ++i;
      }
    } else {
      // fmdsp-pacc.c:2247-2264
      const sjis2nd = bytes[i];
      ++i;
      const jis = sjis2jis(sjis1st, sjis2nd);
      const half = jisIsHalfwidth(jis);
      if ((xo + fw * (half ? 1 : 2)) > limit) return xo;
      const getHalf = font.getJisHalf ? font.getJisHalf.bind(font) : null;
      putGlyph(vram, getHalf ? getHalf(jis, false) : null, x + xo, y, fw, fh, color);
      xo += fw;
      if (!half) {
        putGlyph(vram, getHalf ? getHalf(jis, true) : null, x + xo, y, fw, fh, color);
        xo += 8;
      }
      sjisIs2nd = false;
    }
  }
  return xo;
}
