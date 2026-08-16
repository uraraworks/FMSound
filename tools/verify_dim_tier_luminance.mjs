#!/usr/bin/env node
// 未使用パート暗色化機能(利用者指示B)の主条件: 通常 > ミュート > 未使用 の
// 3段階が「実際の輝度順」になっていることを検査する。
//
// 「実際の輝度」の定義: tools/gen_palette.py が upstream/98fmplayer/fmdsp/fmdsp_sprites.h
// から抽出した実RGB(fmdsp/palette.js PALETTES[0]、html/mucom-app.js・html/pmd-app.js
// 両方が使っている唯一のパレット)を、WCAGの相対輝度式(sRGB→線形化してから
// 0.2126R+0.7152G+0.0722Bをとる)で計算した値。色番号の大小や、ガンマ補正無しの
// 単純加重和では順序を誤ることを下の「注意」検査で示す(彩度の高い色は単純加重和
// だと暗く見えるが実際は明るい実例に当たった。fmdsp/trackrow.js冒頭のコメント参照)。
//
// 実行: node tools/verify_dim_tier_luminance.mjs

import { PALETTES } from '../fmdsp/palette.js';
import { COLOR_LABEL, COLOR_TYPE, COLOR_KEY_HILITE, COLOR_MUTED, COLOR_UNUSED } from '../fmdsp/trackrow.js';
import * as rightpane from '../fmdsp/rightpane.js';

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

console.log('=== 3段階(通常>ミュート>未使用)の輝度順検査(fmdsp/trackrow.js, fmdsp/rightpane.js) ===\n');

const palette = PALETTES[0]; // html/mucom-app.js・html/pmd-app.js 両方が使う唯一のパレット
console.log('PALETTES[0] の各色番号のRGBと相対輝度:');
palette.forEach((rgb, i) => {
  console.log(`  index${i}: [${rgb.join(',')}] 相対輝度(WCAG)=${relativeLuminance(rgb).toFixed(4)} 単純加重和=${naiveLuma(rgb).toFixed(1)}`);
});
console.log('');

const lum = (idx) => relativeLuminance(palette[idx]);

// 1. trackrow.js: 通常色(要素ごとに違うので3色すべて) > ミュート > 未使用。
console.log('--- fmdsp/trackrow.js ---');
console.log(`COLOR_LABEL=${COLOR_LABEL}(輝度${lum(COLOR_LABEL).toFixed(4)}) COLOR_TYPE=${COLOR_TYPE}(輝度${lum(COLOR_TYPE).toFixed(4)}) ` +
  `COLOR_KEY_HILITE=${COLOR_KEY_HILITE}(輝度${lum(COLOR_KEY_HILITE).toFixed(4)}) COLOR_MUTED=${COLOR_MUTED}(輝度${lum(COLOR_MUTED).toFixed(4)}) ` +
  `COLOR_UNUSED=${COLOR_UNUSED}(輝度${lum(COLOR_UNUSED).toFixed(4)})`);
for (const [name, idx] of [['COLOR_LABEL', COLOR_LABEL], ['COLOR_TYPE', COLOR_TYPE], ['COLOR_KEY_HILITE', COLOR_KEY_HILITE]]) {
  check(`trackrow: ${name}(輝度${lum(idx).toFixed(4)}) > COLOR_MUTED(輝度${lum(COLOR_MUTED).toFixed(4)})`, lum(idx) > lum(COLOR_MUTED));
}
check(`trackrow: COLOR_MUTED(輝度${lum(COLOR_MUTED).toFixed(4)}) > COLOR_UNUSED(輝度${lum(COLOR_UNUSED).toFixed(4)})`,
  lum(COLOR_MUTED) > lum(COLOR_UNUSED));
check(`trackrow: COLOR_UNUSED(輝度${lum(COLOR_UNUSED).toFixed(4)}) > 背景(index0、輝度${lum(0).toFixed(4)})(黒に埋没しない)`,
  lum(COLOR_UNUSED) > lum(0));

// 2. rightpane.js: レベルメーターPANPOTの通常(COLOR_1)>ミュート(COLOR_5)>未使用(COLOR_UNUSED)。
console.log('\n--- fmdsp/rightpane.js (レベルメーターPANPOT) ---');
check(`rightpane: COLOR_1(輝度${lum(rightpane.COLOR_1).toFixed(4)}) > COLOR_5(輝度${lum(rightpane.COLOR_5).toFixed(4)})`,
  lum(rightpane.COLOR_1) > lum(rightpane.COLOR_5));
check(`rightpane: COLOR_5(輝度${lum(rightpane.COLOR_5).toFixed(4)}) > COLOR_UNUSED(輝度${lum(rightpane.COLOR_UNUSED).toFixed(4)})`,
  lum(rightpane.COLOR_5) > lum(rightpane.COLOR_UNUSED));

// 3. trackrowとrightpaneのミュート色/未使用色が同じ値であること(パート行と
//    レベルメーターで見た目を揃える設計上の要請、fmdsp/trackrow.js冒頭コメント参照)。
check('trackrowとrightpaneでCOLOR_MUTED(=ミュート色)の値が一致', COLOR_MUTED === rightpane.COLOR_5,
  `trackrow.COLOR_MUTED=${COLOR_MUTED} rightpane.COLOR_5=${rightpane.COLOR_5}`);
check('trackrowとrightpaneでCOLOR_UNUSEDの値が一致', COLOR_UNUSED === rightpane.COLOR_UNUSED,
  `trackrow.COLOR_UNUSED=${COLOR_UNUSED} rightpane.COLOR_UNUSED=${rightpane.COLOR_UNUSED}`);

// 4. [注意/参考] ガンマ補正無しの単純加重和だと index7 が index3 より暗く見えるが、
//    WCAGの正しい式では逆転する(index7=[51,51,238]という彩度の高い青は、
//    単純加重和だと過小評価される)。この逆転が実在することを示し、「感覚や単純な
//    式で選ぶと間違える」ことの根拠として残す(本検査の合否には影響しない)。
{
  const naiveSaysDarker = naiveLuma(palette[7]) < naiveLuma(palette[3]);
  const wcagSaysDarker = relativeLuminance(palette[7]) < relativeLuminance(palette[3]);
  check('[注意] index7とindex3の明暗は単純加重和とWCAG式で逆転する(選定にWCAG式を使う根拠)',
    naiveSaysDarker === true && wcagSaysDarker === false,
    `単純加重和: index7<index3=${naiveSaysDarker} / WCAG: index7<index3=${wcagSaysDarker}`);
}

// 5. [陽性対照] わざと壊す: ミュート色と未使用色を入れ替えた場合、この検査が
//    確実にFAILすることを確認する(検査自体が効いていることの確認。利用者指示)。
{
  const brokenMuted = COLOR_UNUSED; // 本来のCOLOR_MUTEDの代わりに、より暗いUNUSEDの値を使う
  const brokenUnused = COLOR_MUTED; // 逆に、より明るいMUTEDの値を使う
  const brokenOrderHolds = lum(brokenMuted) > lum(brokenUnused);
  check('[陽性対照] ミュート色/未使用色を入れ替えると輝度順チェックはFAILする(検査が効いている確認)',
    brokenOrderHolds === false,
    `入れ替え後: muted(輝度${lum(brokenMuted).toFixed(4)}) > unused(輝度${lum(brokenUnused).toFixed(4)}) = ${brokenOrderHolds}`);
}

console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
if (failCount > 0) process.exit(1);
