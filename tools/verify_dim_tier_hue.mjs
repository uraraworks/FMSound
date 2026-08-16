#!/usr/bin/env node
// 段階的暗色表示(fmdsp/dim-tier.js)の主条件(2026-08-17差し替えの目的そのもの)の検査:
// 通常/ミュート/未使用で暗くなった色が、元の色とRGBの比(=色相)を保っていること。
//
// 背景: 旧実装(〜2317820)はパレット番号を付け替えて暗さを表現していた
// (鍵盤ハイライトを通常時色6(緑、[136,255,68])からミュート時色8(青系、
// [0,187,255])へ差し替え)。これに利用者から「通常が緑に対して暗い版は
// 青色になってます。暗くなった感じには見えない」と指摘があった。色相(hue)が
// 変わってしまうため、「暗くなった」ではなく「別の色になった」と見える。
//
// 新実装は色番号を変えず、fmdsp/vram.js Vram#toImageData()で最終RGBへ
// 変換する際に「元の色 x 係数」を掛けるだけ(fmdsp/dim-tier.js DIM_FACTORS)。
// RGB各成分に同じ係数を掛けるので、数学的にはRGBの比が保たれ、HSL色空間の
// 色相(hue)は変化しないはず、というのが実装の主張。これを実際にレンダリング
// して確かめる。
//
// 実行: node tools/verify_dim_tier_hue.mjs

// Node.jsにはブラウザのImageDataが無い(Vram#toImageData()が使う)。テストの都合で
// 最小限のポリフィルを用意する(width/height/dataを保持するだけ。他のtools/verify_*.mjsは
// vram.pixelsを直接読んでtoImageData()自体を避けているが、この検査は「パレット番号→RGB」
// への変換そのもの(=色相が保たれるかどうかの本体)を確かめたいのであえて呼ぶ)。
if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

import { Vram, PC98_W, PC98_H } from '../fmdsp/vram.js';
import { drawTrackRow } from '../fmdsp/trackrow.js';
import { KEY_W, S_KEY_MASK } from '../fmdsp/sprites.js';
import { TIER_NORMAL, TIER_MUTED, TIER_UNUSED, DIM_FACTORS } from '../fmdsp/dim-tier.js';
import { PALETTES } from '../fmdsp/palette.js';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

// HSLの色相(0-360度)だけを取り出す。彩度0(グレー/黒/白)はnull(色相が定義できない)。
function hueDegrees([r, g, b]) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const delta = max - min;
  if (delta < 1e-9) return null;
  let hue;
  if (max === rn) hue = 60 * (((gn - bn) / delta) % 6);
  else if (max === gn) hue = 60 * (((bn - rn) / delta) + 2);
  else hue = 60 * (((rn - gn) / delta) + 4);
  if (hue < 0) hue += 360;
  return hue;
}

// 色相の差(0-180度、周回を考慮)。
function hueDiff(a, b) {
  if (a === null || b === null) return a === b ? 0 : 180; // 片方だけ無彩色なら別色相扱い
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// 許容誤差(度): Math.round()による量子化誤差(1チャンネルあたり最大±0.5/255)が
// 色相計算に伝播した場合の見積もり。ここで検査する色(COLOR_KEY_HILITE等)は
// 各チャンネルが2桁以上あるため、量子化による色相ずれは実測でも1度未満に収まる
// (下のログ出力で実際の差を毎回表示し、この閾値が緩すぎないことを目視でも
// 確認できるようにしてある)。「別の色になった」レベルの誤り(旧実装の
// 緑→青、100度以上のずれ)を確実に検出できれば十分なので、量子化誤差の
// 見積もりに手厚く余裕を持たせても主条件の検出力は損なわれない。
const HUE_TOLERANCE_DEG = 2.0;

console.log('=== 段階的暗色表示の色相保持(主条件)検査 ===\n');
console.log(`HUE_TOLERANCE_DEG=${HUE_TOLERANCE_DEG}(Math.round量子化の見積もり余裕)\n`);

// --- 1. isolatedなVram+dim-tierパイプラインでの色相保持(fmdsp/trackrow.js COLOR_LABEL/
//    COLOR_TYPE/COLOR_KEY_HILITE、fmdsp/rightpane.js COLOR_1に相当する色番号)。
//    vram.setTier()→setPixel→toImageData という実際に使われている変換経路そのものを検査する。
{
  console.log('--- 1. Vram#toImageData()の色相保持(直接検査) ---');
  const palette = PALETTES[0];
  const testColorIndexes = [1, 2, 6]; // COLOR_LABEL / COLOR_TYPE / COLOR_KEY_HILITE
  for (const idx of testColorIndexes) {
    const base = palette[idx];
    const baseHue = hueDegrees(base);
    console.log(`index${idx}: base=[${base.join(',')}] hue=${baseHue?.toFixed(2)}°`);
    for (const [tierName, tier] of [['TIER_MUTED', TIER_MUTED], ['TIER_UNUSED', TIER_UNUSED]]) {
      const vram = new Vram(1, 1);
      vram.clear(0);
      vram.setTier(tier);
      vram.setPixel(0, 0, idx);
      const img = vram.toImageData(palette);
      const rendered = [img.data[0], img.data[1], img.data[2]];
      const renderedHue = hueDegrees(rendered);
      const diff = hueDiff(baseHue, renderedHue);
      console.log(`  ${tierName}(係数${DIM_FACTORS[tier]}): rendered=[${rendered.join(',')}] hue=${renderedHue?.toFixed(2)}° 差=${diff.toFixed(3)}°`);
      check(`index${idx} ${tierName}: 色相差が${HUE_TOLERANCE_DEG}度以内(色相を保っている)`,
        diff <= HUE_TOLERANCE_DEG, `diff=${diff.toFixed(3)}°`);
    }
  }
}

// --- 2. drawTrackRow()の実際の統合経路(鍵盤ハイライト)での色相保持。
//    verify_key_hilite_mute.mjsと同じ手法でピクセル位置を特定し、実レンダリング結果を測る。
{
  console.log('\n--- 2. drawTrackRow()鍵盤ハイライトの色相保持(統合検査) ---');
  const KEY_X = 7; // fmdsp/trackrow.js内部定数の転記(tools/verify_key_hilite_mute.mjsと同じ)
  const KEY_Y = 14;
  const FIELD_COUNT = 26;

  function keyHiliteCenter(octave, note) {
    const noteMaskRow0 = S_KEY_MASK[note];
    let colOffset = -1;
    for (let x = 0; x < KEY_W; ++x) {
      if (noteMaskRow0[x]) { colOffset = x; break; }
    }
    if (colOffset < 0) throw new Error(`S_KEY_MASK[${note}]の1行目に非0ピクセルが無い`);
    return { x: KEY_X + KEY_W * octave + colOffset, y: KEY_Y };
  }

  function makeTrack(key) {
    const data = new Int32Array(FIELD_COUNT);
    data[0] = 1; // playing
    data[4] = key;
    data[5] = key;
    return data;
  }

  const KEY = 0x25; // オクターブ2、音F
  const pos = keyHiliteCenter(KEY >> 4, KEY & 0xf);

  function renderKeyColor(muted, unused) {
    const vram = new Vram(PC98_W, PC98_H);
    vram.clear(0);
    drawTrackRow(vram, null, 0, 0, 0, makeTrack(KEY), muted, unused);
    const img = vram.toImageData(PALETTES[0]);
    const o = (pos.y * vram.width + pos.x) * 4;
    return [img.data[o], img.data[o + 1], img.data[o + 2]];
  }

  const normalRgb = renderKeyColor(false, false);
  const mutedRgb = renderKeyColor(true, false);
  const unusedRgb = renderKeyColor(false, true);
  const normalHue = hueDegrees(normalRgb);
  const mutedHue = hueDegrees(mutedRgb);
  const unusedHue = hueDegrees(unusedRgb);
  console.log(`通常: [${normalRgb.join(',')}] hue=${normalHue?.toFixed(2)}°`);
  console.log(`ミュート: [${mutedRgb.join(',')}] hue=${mutedHue?.toFixed(2)}° 差=${hueDiff(normalHue, mutedHue).toFixed(3)}°`);
  console.log(`未使用: [${unusedRgb.join(',')}] hue=${unusedHue?.toFixed(2)}° 差=${hueDiff(normalHue, unusedHue).toFixed(3)}°`);

  check('[本体/主条件] 鍵盤ハイライト: ミュート中も色相が保たれる(緑のまま暗くなる)',
    hueDiff(normalHue, mutedHue) <= HUE_TOLERANCE_DEG, `差=${hueDiff(normalHue, mutedHue).toFixed(3)}°`);
  check('[本体/主条件] 鍵盤ハイライト: 未使用時も色相が保たれる(緑のまま暗くなる)',
    hueDiff(normalHue, unusedHue) <= HUE_TOLERANCE_DEG, `差=${hueDiff(normalHue, unusedHue).toFixed(3)}°`);
  // 暗さの方向も同時に確認(色相だけ保たれて明るさが変わっていない、という
  // 誤りを排除するため。主条件は色相だが、そもそも暗くなっていなければ
  // このタスクの目的自体を満たさない)。
  const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b; // 目視確認用の簡易値(判定には使わない)
  check('[参考] ミュートは通常より暗い(RGB各成分が小さい)',
    mutedRgb.every((c, i) => c <= normalRgb[i]) && mutedRgb.some((c, i) => c < normalRgb[i]));
  check('[参考] 未使用はミュートよりさらに暗い(RGB各成分が小さい)',
    unusedRgb.every((c, i) => c <= mutedRgb[i]) && unusedRgb.some((c, i) => c < mutedRgb[i]));
  void luma;
}

// --- 3. 陽性対照: 「色相が変わる実装」(旧・パレット番号付け替え方式)を模擬すると、
//    このチェックが確実にFAILすることを確認する(検査が効いていることの確認)。
//    旧実装は鍵盤ハイライトを通常時色6(緑)からミュート時色8(青系)へ差し替えていた。
//    ここではPALETTES[0]のindex6/index8を直接比較し、「色番号を差し替える」という
//    旧方式を再現した場合に色相差が閾値を超えてFAILすることを示す。
{
  console.log('\n--- 3. [陽性対照] 旧方式(パレット番号付け替え)を模擬するとFAILする ---');
  const palette = PALETTES[0];
  const oldNormalHue = hueDegrees(palette[6]); // 旧実装の通常色(緑)
  const oldMutedHue = hueDegrees(palette[8]); // 旧実装のミュート色(青系、色8への差し替え)
  const diff = hueDiff(oldNormalHue, oldMutedHue);
  console.log(`index6(旧通常,緑)=hue${oldNormalHue?.toFixed(2)}° index8(旧ミュート,青系)=hue${oldMutedHue?.toFixed(2)}° 差=${diff.toFixed(2)}°`);
  check('[陽性対照] 旧方式(index6→index8への差し替え)は色相差が閾値を超えてFAILになる(検査が効いている確認)',
    diff > HUE_TOLERANCE_DEG, `差=${diff.toFixed(2)}° > 閾値${HUE_TOLERANCE_DEG}°`);
}

console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
if (failCount > 0) process.exit(1);
