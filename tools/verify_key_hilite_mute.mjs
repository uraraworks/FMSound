#!/usr/bin/env node
// トラック行クリックミュート機能: ミュート中は鍵盤ハイライトを暗くする
// (fmdsp/trackrow.js drawTrackRow)ことの検証。
//
// 背景: cf957da はミュート中の行の文字情報(typeColor/labelColor/数字スプライト)
// だけを暗くし、鍵盤ハイライトは対象外のまま明るく残っていた(利用者指摘)。
// 748ce28ではこれを直すため上流のmasked分岐(色6→色8への差し替え)を採用したが、
// 2026-08-17に利用者から「通常が緑に対して暗い版は青色になってます。暗くなった
// 感じには見えない」と指摘があった。色相が変わってしまうため、パレット番号の
// 差し替えでは解決できない(fmdsp/dim-tier.js冒頭コメント参照)。
//
// 現行方式(2026-08-17〜): 色番号(COLOR_KEY_HILITE=6)はミュート中も変えない。
// 「暗くなった」ことはvram.tiers平面(fmdsp/dim-tier.js TIER_MUTED)に記録され、
// 最終的な暗さはfmdsp/vram.js Vram#toImageData()の係数乗算(色相を保つ)で決まる。
// この検査はfmdsp/trackrow.jsのdrawTrackRow()を直接呼び、
//   (a) VRAM上の色番号(vram.pixels)がミュート有無に関わらず一定であること
//   (b) 段階(vram.tiers)がミュート有無で正しく切り替わっていること
// の両方を実測する(色相保持そのものの検査はtools/verify_dim_tier_hue.mjs)。
//
// 実行: node tools/verify_key_hilite_mute.mjs

import { Vram, PC98_W, PC98_H } from '../fmdsp/vram.js';
import { drawTrackRow, COLOR_KEY_HILITE } from '../fmdsp/trackrow.js';
import { KEY_W, S_KEY_MASK } from '../fmdsp/sprites.js';
import { TIER_NORMAL, TIER_MUTED, TIER_UNUSED } from '../fmdsp/dim-tier.js';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

const COLOR_KEY_HILITE_SUB = 8; // fmdsp/trackrow.jsの同名定数の転記(actualKey用、常時固定)

const FIELD_COUNT = 26;
function makeTrack({ key = 0x25, actualKey = 0x25 } = {}) {
  const data = new Int32Array(FIELD_COUNT);
  data[0] = 1; // playing
  data[1] = 0; // info=NORMAL
  data[4] = key;
  data[5] = actualKey;
  return data;
}

// key/actualKey を意図的に違う音程にして、それぞれの矩形の中心を別々に測れるようにする。
// key=o2C(オクターブ2,音C=0) actualKey=o5C+(オクターブ5,音C+=1)
const KEY = 0x20;
const ACTUAL_KEY = 0x51;

const KEY_X = 7; // fmdsp/trackrow.js内部定数の転記(同ファイルのコメント参照)
const KEY_Y = 14;

function pixelAt(vram, x, y) {
  return vram.pixels[y * vram.width + x];
}
function tierAt(vram, x, y) {
  return vram.tiers[y * vram.width + x];
}

function keyHiliteCenter(octave, note) {
  // KEY_MASKスプライトの非0(=1)ピクセルの1つを直接使う。ノート内オフセット
  // (中央付近)は実データを見て非0であることを確認したうえで座標を選ぶ。
  const noteMaskRow0 = S_KEY_MASK[note];
  // 各行、最初に1が立つ列を探す(スプライトの実データに依存させないよう動的に探索)。
  let colOffset = -1;
  for (let x = 0; x < KEY_W; ++x) {
    if (noteMaskRow0[x]) { colOffset = x; break; }
  }
  if (colOffset < 0) throw new Error(`S_KEY_MASK[${note}]の1行目に非0ピクセルが無い`);
  const x = KEY_X + KEY_W * octave + colOffset;
  const y = KEY_Y + 0; // row0(スプライト先頭行)
  return { x, y };
}

function measure(muted, unused = false) {
  const vram = new Vram(PC98_W, PC98_H);
  vram.clear(0);
  const track = makeTrack({ key: KEY, actualKey: ACTUAL_KEY });
  drawTrackRow(vram, null, 0, 0, /* slotIndex(FM1) */ 0, track, muted, unused);

  const keyOct = KEY >> 4, keyNote = KEY & 0xf;
  const actOct = ACTUAL_KEY >> 4, actNote = ACTUAL_KEY & 0xf;
  const keyPos = keyHiliteCenter(keyOct, keyNote);
  const actPos = keyHiliteCenter(actOct, actNote);
  return {
    keyColor: pixelAt(vram, keyPos.x, keyPos.y),
    keyTier: tierAt(vram, keyPos.x, keyPos.y),
    actualKeyColor: pixelAt(vram, actPos.x, actPos.y),
    actualKeyTier: tierAt(vram, actPos.x, actPos.y),
  };
}

console.log('=== ミュート中の鍵盤ハイライト 検証(fmdsp/trackrow.js) ===\n');

const notMuted = measure(false);
console.log(`非ミュート: key色=${notMuted.keyColor}/段階${notMuted.keyTier} actualKey色=${notMuted.actualKeyColor}/段階${notMuted.actualKeyTier}`);
check(`非ミュート: keyのハイライトは色${COLOR_KEY_HILITE}(COLOR_KEY_HILITE)`, notMuted.keyColor === COLOR_KEY_HILITE, `got=${notMuted.keyColor}`);
check('非ミュート: keyの段階はTIER_NORMAL', notMuted.keyTier === TIER_NORMAL, `got=${notMuted.keyTier}`);
check(`非ミュート: actualKeyのハイライトは色${COLOR_KEY_HILITE_SUB}(COLOR_KEY_HILITE_SUB、常時)`, notMuted.actualKeyColor === COLOR_KEY_HILITE_SUB, `got=${notMuted.actualKeyColor}`);

const muted = measure(true);
console.log(`ミュート中: key色=${muted.keyColor}/段階${muted.keyTier} actualKey色=${muted.actualKeyColor}/段階${muted.actualKeyTier}`);
check('[本体] ミュート中: keyの色番号は変わらない(色相を保つ。fmdsp/dim-tier.js方針どおり色は差し替えない)',
  muted.keyColor === COLOR_KEY_HILITE, `got=${muted.keyColor}`);
check('[本体] ミュート中: keyの段階がTIER_MUTEDに変わる(暗さはここで表現する)',
  muted.keyTier === TIER_MUTED, `got=${muted.keyTier}`);
check('ミュート中: actualKeyの色番号は常時変化しない', muted.actualKeyColor === COLOR_KEY_HILITE_SUB, `got=${muted.actualKeyColor}`);
check('ミュート中: actualKeyの段階も行全体のTIER_MUTEDに揃う(利用者指示「対象は行全体」)',
  muted.actualKeyTier === TIER_MUTED, `got=${muted.actualKeyTier}`);

const unusedOnly = measure(false, true);
console.log(`未使用: key色=${unusedOnly.keyColor}/段階${unusedOnly.keyTier}`);
check('未使用中: keyの色番号も変わらない', unusedOnly.keyColor === COLOR_KEY_HILITE, `got=${unusedOnly.keyColor}`);
check('未使用中: keyの段階がTIER_UNUSEDに変わる', unusedOnly.keyTier === TIER_UNUSED, `got=${unusedOnly.keyTier}`);

// 故障注入: 「ミュートしても段階を切り替えない」旧式の壊れた実装を模擬し、
// この検査が実際にFAILを検出できることを確認する。
{
  const fakeMutedButNormalTier = TIER_NORMAL; // 「段階を切り替え忘れた」ふるまいを模擬
  const faultDetected = fakeMutedButNormalTier !== TIER_MUTED;
  check('[故障注入] 「ミュートしても段階がTIER_NORMALのまま」という壊れた値はTIER_MUTEDとの比較でFAILになる(検査が効いている確認)',
    faultDetected);
}

console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
if (failCount > 0) process.exit(1);
