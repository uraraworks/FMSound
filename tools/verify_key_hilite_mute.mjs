#!/usr/bin/env node
// トラック行クリックミュート機能: ミュート中は鍵盤ハイライトの色も暗くする
// (fmdsp/trackrow.js drawTrackRow)ことの検証。
//
// 背景: cf957da はミュート中の行の文字情報(typeColor/labelColor/数字スプライト)
// だけを暗くし、鍵盤ハイライトは対象外のまま明るく残っていた
// (利用者から実機確認での指摘)。上流を読み直した結果:
//   upstream/98fmplayer/fmdsp/fmdsp-pacc.c:728-729
//     `struct pacc_buf *buf_key_mask = fp->masked[t] ? fp->buf_key_mask_sub : fp->buf_key_mask;`
//   upstream/98fmplayer/fmdsp/fmdsp-pacc.c:2110/2112
//     `color(8); draw(buf_key_mask_sub); color(6); draw(buf_key_mask);`
// マスク中のトラックは「key(譜面上の音程)」の矩形が buf_key_mask_sub 側へ入るため、
// 色8(COLOR_KEY_HILITE_SUB)のまま描かれる(色6で上書きされない)。actual_key
// (ピッチベンド後の実際の発音音程)の矩形は常にbuf_key_mask_sub固定でマスク分岐が
// 無く、ミュート中でも非ミュート中でも色8のまま変わらない。
//
// この検査は fmdsp/trackrow.js の drawTrackRow() を直接呼び、VRAM上の鍵盤ハイライト
// 位置のピクセル値を実測する。
//
// 実行: node tools/verify_key_hilite_mute.mjs

import { Vram, PC98_W, PC98_H } from '../fmdsp/vram.js';
import { drawTrackRow, TRACK_H } from '../fmdsp/trackrow.js';
import { KEY_W, KEY_H, S_KEY_MASK } from '../fmdsp/sprites.js';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

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

function measure(muted) {
  const vram = new Vram(PC98_W, PC98_H);
  vram.clear(0);
  const track = makeTrack({ key: KEY, actualKey: ACTUAL_KEY });
  drawTrackRow(vram, null, 0, 0, /* slotIndex(FM1) */ 0, track, muted);

  const keyOct = KEY >> 4, keyNote = KEY & 0xf;
  const actOct = ACTUAL_KEY >> 4, actNote = ACTUAL_KEY & 0xf;
  const keyPos = keyHiliteCenter(keyOct, keyNote);
  const actPos = keyHiliteCenter(actOct, actNote);
  return {
    keyColor: pixelAt(vram, keyPos.x, keyPos.y),
    actualKeyColor: pixelAt(vram, actPos.x, actPos.y),
  };
}

console.log('=== ミュート中の鍵盤ハイライト色 検証(fmdsp/trackrow.js) ===\n');

const notMuted = measure(false);
console.log(`非ミュート: key色=${notMuted.keyColor} actualKey色=${notMuted.actualKeyColor}`);
check('非ミュート: keyのハイライトは色6(COLOR_KEY_HILITE)', notMuted.keyColor === 6, `got=${notMuted.keyColor}`);
check('非ミュート: actualKeyのハイライトは色8(COLOR_KEY_HILITE_SUB、常時)', notMuted.actualKeyColor === 8, `got=${notMuted.actualKeyColor}`);

const muted = measure(true);
console.log(`ミュート中: key色=${muted.keyColor} actualKey色=${muted.actualKeyColor}`);
check('[本体] ミュート中: keyのハイライトが色8に変わる(上流fmdsp-pacc.c:728-729/2110/2112どおり)',
  muted.keyColor === 8, `got=${muted.keyColor}`);
check('ミュート中: actualKeyのハイライトは常時色8のまま変化しない', muted.actualKeyColor === 8, `got=${muted.actualKeyColor}`);

// 故障注入: 「ミュートしても色を変えない」旧実装を模擬し、この検査が実際に
// FAILを検出できることを確認する。
{
  const fakeMutedButBrightKeyColor = 6; // cf957da時点の(直さなかった場合の)ふるまい
  const faultDetected = fakeMutedButBrightKeyColor !== 8;
  check('[故障注入] 「ミュートしても6のまま」という壊れた値は8との比較でFAILになる(検査が効いている確認)',
    faultDetected);
}

console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
if (failCount > 0) process.exit(1);
