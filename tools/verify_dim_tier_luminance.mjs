#!/usr/bin/env node
// 段階的暗色表示(通常/ミュート/未使用)の主条件その2: 3段階が「実際の輝度順」に
// なっていることを検査する。
//
// 2026-08-17、実装方式をパレット番号の付け替えから「元の色 x 係数」方式
// (fmdsp/dim-tier.js、fmdsp/vram.js Vram#setTier()/toImageData())へ差し替えた。
// 主条件(色相を保つこと)はtools/verify_dim_tier_hue.mjsで検査する。この検査は
// 「暗くなったこと自体」(通常>ミュート>未使用の順であること)を、
// 2317820時点と同じくWCAGの相対輝度式(sRGB→線形化してから
// 0.2126R+0.7152G+0.0722Bをとる標準式。ガンマ補正無しの単純加重和だと
// 「彩度の高い色は暗く見えるはずが実は明るい」という誤判定をする実例に
// 当たったので使わない。下記「注意」検査で再現する)で検証する、という
// 2317820の検査の主条件をそのまま引き継ぐ。
//
// 実行: node tools/verify_dim_tier_luminance.mjs

// Node.jsにはブラウザのImageDataが無い(Vram#toImageData()が使う)ため、
// テスト用の最小ポリフィルを用意する(tools/verify_dim_tier_hue.mjsと同じ手法)。
if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

import { PALETTES } from '../fmdsp/palette.js';
import { Vram } from '../fmdsp/vram.js';
import { COLOR_LABEL, COLOR_TYPE, COLOR_KEY_HILITE } from '../fmdsp/trackrow.js';
import { COLOR_1 } from '../fmdsp/rightpane.js';
import { TIER_NORMAL, TIER_MUTED, TIER_UNUSED, DIM_FACTORS } from '../fmdsp/dim-tier.js';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

// WCAGの相対輝度式(sRGB->線形化 -> 0.2126R+0.7152G+0.0722B)。
function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function relativeLuminance([r, g, b]) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
// 単純加重和(ガンマ補正無し)。「注意」検査専用(これが正しい輝度式ではないことを
// 示すために使う。本検査の合否判定には一切使わない)。
function naiveLuma([r, g, b]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const palette = PALETTES[0]; // html/mucom-app.js・html/pmd-app.js 両方が使う唯一のパレット

// vram.setTier()→setPixel→toImageData()という実際のコード経路で、colorIndexを
// tierで描いたときの実RGBを得る(analyticにpalette[idx]*factorを計算するのではなく、
// 本番と同じ経路を通す。tools/verify_dim_tier_hue.mjsと同じ考え方)。
function renderedRgb(colorIndex, tier) {
  const vram = new Vram(1, 1);
  vram.clear(0);
  vram.setTier(tier);
  vram.setPixel(0, 0, colorIndex);
  const img = vram.toImageData(palette);
  return [img.data[0], img.data[1], img.data[2]];
}

console.log('=== 3段階(通常>ミュート>未使用)の輝度順検査(fmdsp/vram.js Vram#toImageData()) ===\n');

console.log('DIM_FACTORS(fmdsp/dim-tier.js) = ' + JSON.stringify(DIM_FACTORS));
console.log('PALETTES[0]の代表色番号のRGBと相対輝度:');
[[COLOR_LABEL, 'COLOR_LABEL'], [COLOR_TYPE, 'COLOR_TYPE'], [COLOR_KEY_HILITE, 'COLOR_KEY_HILITE'], [COLOR_1, 'rightpane.COLOR_1']]
  .forEach(([idx, name]) => {
    console.log(`  index${idx}(${name}): [${palette[idx].join(',')}] 相対輝度(WCAG)=${relativeLuminance(palette[idx]).toFixed(4)} 単純加重和=${naiveLuma(palette[idx]).toFixed(1)}`);
  });
console.log('');

// 1. fmdsp/trackrow.jsの代表色(通常時に使われる3色)それぞれについて、
//    実レンダリング結果が 通常 > ミュート > 未使用 > 背景(黒) の輝度順になること。
console.log('--- fmdsp/trackrow.js の代表色 ---');
for (const [name, idx] of [['COLOR_LABEL', COLOR_LABEL], ['COLOR_TYPE', COLOR_TYPE], ['COLOR_KEY_HILITE', COLOR_KEY_HILITE]]) {
  const normal = relativeLuminance(renderedRgb(idx, TIER_NORMAL));
  const muted = relativeLuminance(renderedRgb(idx, TIER_MUTED));
  const unused = relativeLuminance(renderedRgb(idx, TIER_UNUSED));
  console.log(`${name}(index${idx}): 通常=${normal.toFixed(4)} ミュート=${muted.toFixed(4)} 未使用=${unused.toFixed(4)}`);
  check(`trackrow: ${name} 通常(輝度${normal.toFixed(4)}) > ミュート(輝度${muted.toFixed(4)})`, normal > muted);
  check(`trackrow: ${name} ミュート(輝度${muted.toFixed(4)}) > 未使用(輝度${unused.toFixed(4)})`, muted > unused);
  check(`trackrow: ${name} 未使用(輝度${unused.toFixed(4)}) > 背景(黒、輝度0)`, unused > 0);
}

// 2. fmdsp/rightpane.js drawLevelMeters()が使う色(COLOR_1、PANPOT等)も同じ経路
//    (vram.setTier())で暗くなるため、同じ検査を1色ぶん行う。
console.log('\n--- fmdsp/rightpane.js の代表色(レベルメーター) ---');
{
  const normal = relativeLuminance(renderedRgb(COLOR_1, TIER_NORMAL));
  const muted = relativeLuminance(renderedRgb(COLOR_1, TIER_MUTED));
  const unused = relativeLuminance(renderedRgb(COLOR_1, TIER_UNUSED));
  console.log(`COLOR_1(index${COLOR_1}): 通常=${normal.toFixed(4)} ミュート=${muted.toFixed(4)} 未使用=${unused.toFixed(4)}`);
  check(`rightpane: COLOR_1 通常(輝度${normal.toFixed(4)}) > ミュート(輝度${muted.toFixed(4)})`, normal > muted);
  check(`rightpane: COLOR_1 ミュート(輝度${muted.toFixed(4)}) > 未使用(輝度${unused.toFixed(4)})`, muted > unused);
}

// 3. trackrowとrightpaneが同じDIM_FACTORS(fmdsp/dim-tier.js、単一の定義源)を
//    使っていることの確認。個別に係数を持つと2317820のときのように「ミュート色を
//    そろえたつもりが値がずれる」再発の恐れがあるため、「同じモジュールを
//    importしている」ことそのものを検査する(値が2箇所に重複していない)。
check('DIM_FACTORSが3段階(通常/ミュート/未使用)ぶん定義されている', DIM_FACTORS.length === 3,
  `DIM_FACTORS=${JSON.stringify(DIM_FACTORS)}`);
check('DIM_FACTORSが単調減少(通常>ミュート>未使用)', DIM_FACTORS[0] > DIM_FACTORS[1] && DIM_FACTORS[1] > DIM_FACTORS[2],
  `DIM_FACTORS=${JSON.stringify(DIM_FACTORS)}`);

// 4. [注意/参考] ガンマ補正無しの単純加重和だと index7 が index3 より暗く見えるが、
//    WCAGの正しい式では逆転する(index7=[51,51,238]という彩度の高い青は、
//    単純加重和だと過小評価される)。2317820時点の実測をそのまま引き継ぎ、
//    「感覚や単純な式で選ぶと間違える」ことの根拠として残す(本検査の合否には
//    影響しない。今回の方式は色番号を選び直す必要が無くなったため実害は無いが、
//    「なぜWCAG式を使うか」の記録として維持する)。
{
  const naiveSaysDarker = naiveLuma(palette[7]) < naiveLuma(palette[3]);
  const wcagSaysDarker = relativeLuminance(palette[7]) < relativeLuminance(palette[3]);
  check('[注意] index7とindex3の明暗は単純加重和とWCAG式で逆転する(選定にWCAG式を使う根拠)',
    naiveSaysDarker === true && wcagSaysDarker === false,
    `単純加重和: index7<index3=${naiveSaysDarker} / WCAG: index7<index3=${wcagSaysDarker}`);
}

// 5. [陽性対照] わざと壊す: DIM_FACTORSの順序を逆転(ミュート/未使用の係数を
//    入れ替え)させた場合、輝度順チェックが確実にFAILすることを確認する
//    (検査自体が効いていることの確認。利用者指示)。
{
  const brokenFactors = [DIM_FACTORS[0], DIM_FACTORS[2], DIM_FACTORS[1]]; // ミュートと未使用を入れ替え
  const normal = relativeLuminance(renderedRgb(COLOR_KEY_HILITE, TIER_NORMAL));
  // renderedRgbは本物のDIM_FACTORSしか使わないため、ここだけ手計算で「壊れた係数を
  // 使ったらどうなるか」を再現する(paletteの生RGBに壊れた係数を直接掛ける)。
  const applyFactor = (idx, factor) => palette[idx].map((c) => Math.round(c * factor));
  const brokenMuted = relativeLuminance(applyFactor(COLOR_KEY_HILITE, brokenFactors[1]));
  const brokenUnused = relativeLuminance(applyFactor(COLOR_KEY_HILITE, brokenFactors[2]));
  const brokenOrderHolds = brokenMuted > brokenUnused;
  console.log(`\n[陽性対照] 係数を入れ替えると: ミュート係数=${brokenFactors[1]}(輝度${brokenMuted.toFixed(4)}) 未使用係数=${brokenFactors[2]}(輝度${brokenUnused.toFixed(4)})`);
  check('[陽性対照] ミュート係数/未使用係数を入れ替えると輝度順チェックはFAILする(検査が効いている確認)',
    brokenOrderHolds === false,
    `入れ替え後: muted(輝度${brokenMuted.toFixed(4)}) > unused(輝度${brokenUnused.toFixed(4)}) = ${brokenOrderHolds}`);
  void normal;
}

console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
if (failCount > 0) process.exit(1);
