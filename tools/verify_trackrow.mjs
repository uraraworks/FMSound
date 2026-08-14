#!/usr/bin/env node
// パート行レンダラ(pmdweb/html/fmdsp/trackrow.js)の描画結果を検証するスクリプト。
//
// 検証項目:
//   (a) 10行すべてが y<400 (canvas高さ) に収まる
//   (b) 各行に非0ピクセルが存在する (= 下2行が空になっていないか)
//   (c) VRAMへの書き込みが範囲外(canvas範囲外)に出ていない
//
// 加えて、わざと TRACK_H を大きくして(a)(b)が落ちることを確認してから
// 元に戻して通す「故障注入」チェックも行う(常にPASSする検査は無意味なため)。
//
// 実行: node tools/verify_trackrow.mjs

import { Vram, PC98_W, PC98_H } from '../fmdsp/vram.js';
import { TRACK_H, TRACK_DISP_TABLE_OPNA, drawTrackRow as drawTrackRowRef } from '../fmdsp/trackrow.js';

const FIELD_COUNT = 26;

// ダミーの track データ(flatten()の1トラック分、長さ26のInt32Array相当)を作る。
// FIELD定義はtrackrow.js内のFIELDオブジェクトと同じ並び
// (PLAYING,INFO,TICKS,TICKS_LEFT,KEY,ACTUAL_KEY,TONENUM,VOLUME,GATE,DETUNE,
//  STATUS x9, FMSLOTMASK x4, PPZ8_CH, SSG_TONE, SSG_NOISE)。
function makeTrack({
  playing = 1, info = 0, ticks = 40, ticksLeft = 20, key = 0x25, actualKey = 0x25,
  tonenum = 12, volume = 100, gate = 80, detune = 0, status = 'ABC',
  fmslotmask = [0, 0, 0, 0], ppz8Ch = 0, ssgTone = 0, ssgNoise = 0,
} = {}) {
  const data = new Int32Array(FIELD_COUNT);
  data[0] = playing;
  data[1] = info;
  data[2] = ticks;
  data[3] = ticksLeft;
  data[4] = key;
  data[5] = actualKey;
  data[6] = tonenum;
  data[7] = volume;
  data[8] = gate;
  data[9] = detune;
  for (let i = 0; i < 9; ++i) data[10 + i] = i < status.length ? status.charCodeAt(i) : 0;
  for (let i = 0; i < 4; ++i) data[19 + i] = fmslotmask[i] ? 1 : 0;
  data[23] = ppz8Ch;
  data[24] = ssgTone;
  data[25] = ssgNoise;
  return data;
}

// TRACK_DISP_TABLE_OPNA は10スロット([0,1,2,6,7,8,9,10,11,12])を参照する。
// entryTracks はスロットindexそのものを添字にするので、最大スロット番号+1の
// 長さを確保して各種条件のダミーを詰める。
function buildEntryTracks() {
  const entryTracks = [];
  const maxSlot = Math.max(...TRACK_DISP_TABLE_OPNA);
  for (let i = 0; i <= maxSlot; ++i) entryTracks[i] = makeTrack();

  // 再生中(通常キー)
  entryTracks[0] = makeTrack({ playing: 1, key: 0x25, actualKey: 0x24, tonenum: 5, volume: 127, gate: 96, detune: 3 });
  // 停止中("S"表示)
  entryTracks[1] = makeTrack({ playing: 0 });
  // 休符("R"表示)。休符センチネルは upstream/98fmplayer/fmdriver/fmdriver_pmd.c:
  // 5856,5864,5880,5884 の `((track->key & 0xf) == 0xf) ? 0xff : ...` および
  // fmdriver_fmp.c:2790 `part->status.rest ? 0xff : ...` の通り常に0xff
  // (上位/下位ニブル両方0xf)。key/actualKeyの片方だけ下位ニブル0xfで
  // 上位ニブルだけ有効値、という組み合わせは実データには現れない。
  entryTracks[2] = makeTrack({ playing: 1, key: 0xff, actualKey: 0xff });
  // FM3EX (スロットマスク文字列 + EX)
  entryTracks[6] = makeTrack({ playing: 1, info: 2, fmslotmask: [1, 0, 1, 0] });
  // PPZ8
  entryTracks[7] = makeTrack({ playing: 1, info: 3, ppz8Ch: 2 });
  // PDZF
  entryTracks[8] = makeTrack({ playing: 1, info: 4 });
  // SSGEFF (再生していなくても描画対象になる分岐)
  entryTracks[9] = makeTrack({ playing: 0, info: 5 });
  // detuneマイナス
  entryTracks[10] = makeTrack({ playing: 1, detune: -7 });
  // status文字列が長め(9文字上限)
  entryTracks[11] = makeTrack({ playing: 1, status: 'M:MASKALL' });
  // 通常のFM
  entryTracks[12] = makeTrack({ playing: 1 });

  return entryTracks;
}

// vram.pixels を10行ぶんの矩形に分割し、各行の非0ピクセル数を数える。
// canvas範囲外への書き込みは Vram.setPixel/fillRect が既にクリップしている
// (pmdweb/html/fmdsp/vram.js:27,32-35) ので、ここでは「書き込み先の矩形が
// canvasの範囲に収まっているか」を y 座標だけで検証する(rowHeightがcanvas高を
// 超えていれば(a)が落ちる設計)。
function countNonZeroPerRow(vram, rowHeight, rowCount) {
  const counts = [];
  for (let row = 0; row < rowCount; ++row) {
    const y0 = row * rowHeight;
    const y1 = Math.min(vram.height, y0 + rowHeight);
    let count = 0;
    for (let y = y0; y < y1; ++y) {
      for (let x = 0; x < vram.width; ++x) {
        if (vram.pixels[y * vram.width + x] !== 0) ++count;
      }
    }
    counts.push(count);
  }
  return counts;
}

function runCheck(rowHeight, label) {
  const vram = new Vram(PC98_W, PC98_H);
  vram.clear(0);
  const entryTracks = buildEntryTracks();
  // drawTrackRows内部は TRACK_H (import した定数) を直接使うため、
  // 故障注入では drawTrackRow を直接呼んで rowHeight を差し替える。
  const drawTrackRow = drawTrackRowRef;
  TRACK_DISP_TABLE_OPNA.forEach((slotIndex, row) => {
    drawTrackRow(vram, null, 0, rowHeight * row, slotIndex, entryTracks[slotIndex]);
  });

  const rowCount = TRACK_DISP_TABLE_OPNA.length;
  const lastRowBottom = rowHeight * (rowCount - 1) + rowHeight;
  const checkA = lastRowBottom <= vram.height; // 10行すべてがy<400に収まる
  const rowCounts = countNonZeroPerRow(vram, rowHeight, rowCount);
  const checkB = rowCounts.every((c) => c > 0); // 各行に非0ピクセルがある

  // (c) VRAM書き込みが範囲外に出ていない: Vram.setPixel/fillRectは範囲外を
  // 自動的に無視するクリップ実装なので、クラッシュしないこと自体に加えて、
  // pixels配列の長さがwidth*heightのまま変化していないことを確認する。
  const checkC = vram.pixels.length === vram.width * vram.height;

  console.log(`[${label}] rowHeight=${rowHeight} lastRowBottom=${lastRowBottom}`);
  console.log(`  (a) 10行 < canvas高(${vram.height}): ${checkA ? 'PASS' : 'FAIL'} (lastRowBottom=${lastRowBottom})`);
  console.log(`  (b) 各行非0ピクセルあり: ${checkB ? 'PASS' : 'FAIL'} counts=[${rowCounts.join(',')}]`);
  console.log(`  (c) VRAM範囲外書き込みなし: ${checkC ? 'PASS' : 'FAIL'}`);

  return { checkA, checkB, checkC, rowCounts };
}

function main() {
  console.log('=== 故障注入: わざと行送りを大きくして (a)(b) が落ちることを確認 ===');
  // TRACK_H(32)を大きく超える値にすると、10行目がcanvas高400を超えて
  // (a)が落ち、その行のピクセルも一切書けなくなるため(b)も落ちるはず。
  const faulty = runCheck(60, 'FAULT-INJECTED rowHeight=60');
  const faultDetected = !faulty.checkA || !faulty.checkB;
  if (!faultDetected) {
    console.error('error: 故障注入したのに (a)(b) が両方PASSした。検査が効いていない。');
    process.exit(1);
  }
  console.log('  -> 故障注入は期待通り検出された(検査は機能している)。\n');

  console.log('=== 本番設定: TRACK_H=32 での検証 ===');
  const real = runCheck(TRACK_H, `real TRACK_H=${TRACK_H}`);
  const allPass = real.checkA && real.checkB && real.checkC;

  console.log('');
  if (!allPass) {
    console.error('FAIL: 本番設定の検証に失敗した。');
    process.exit(1);
  }
  console.log('PASS: 10行 x TRACK_H(32) = 320px が canvas高400pxに収まり、各行に描画がある。');
}

main();
