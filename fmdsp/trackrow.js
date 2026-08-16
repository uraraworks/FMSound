// FMDSP風パート行(トラック行)レンダラ。
// 対象: docs/fmdsp-layout.md §3「パート行の内訳」、出典は
// upstream/98fmplayer/fmdsp/fmdsp-pacc.c の
//   track_type_table (26-51), track_disp_table_opna (53-65),
//   init_track_without_key (393-439), update_track_without_key (467-578),
//   update_track_10 (770-797)
// と upstream/98fmplayer/fmdsp/fmdsp_sprites.h の定数群。
//
// フォントの使い分け: パート行のラベル・数値は本家と同じ font_fmdsp_small
// (5x6、tools/gen_font_small.py で抽出した font_small.js の FONT_SMALL)、
// 曲名・コメント欄など16px系の表示は別途 shinonome ROM (font.js の FmdspFont)
// を使う。本モジュールは前者専用。

import { drawText, SmallFont } from './font.js';
import { FONT_SMALL } from './font_small.js';
import {
  NUM_W, NUM_H, KEY_W, KEY_H, KEY_LEFT_W, KEY_RIGHT_W,
  S_NUM, S_KEY_BG, S_KEY_LEFT, S_KEY_RIGHT, S_KEY_MASK, S_DT_SIGN,
} from './sprites.js';
import { TIER_NORMAL, tierFor } from './dim-tier.js';

// パート行専用のフォント。drawTrackRow(s) の font 引数は使わず、常にこれで描く
// (本家 update_track_without_key/init_track_without_key が font_fmdsp_small
// 固定で描いているのと同じ)。
const SMALL_FONT = new SmallFont(FONT_SMALL);

// --- fmdsp_sprites.h 由来の定数(x方向、フォント非依存) ---
const TINFO_X = 47;
const TDETAIL_X = 67;
const TDETAIL_KN_V_X = TDETAIL_X + 13;
const TDETAIL_TN_X = TDETAIL_KN_V_X + 28;
const TDETAIL_TN_V_X = TDETAIL_TN_X + 13;
const TDETAIL_VL_X = TDETAIL_TN_V_X + 20;
const TDETAIL_VL_C_X = TDETAIL_VL_X + 9;
const TDETAIL_VL_V_X = TDETAIL_VL_X + 12;
const TDETAIL_GT_X = TDETAIL_VL_V_X + 19;
const TDETAIL_GT_V_X = TDETAIL_GT_X + 13;
const TDETAIL_DT_X = TDETAIL_GT_V_X + 23;
const TDETAIL_DT_S_X = TDETAIL_DT_X + 13;
const TDETAIL_DT_V_X = TDETAIL_DT_S_X + 4;
const TDETAIL_M_X = 249;
const TDETAIL_M_V_X = TDETAIL_M_X + 8;
const NUM_X = 31;
const KEY_X = 7;
const KEY_Y = 14; // fmdsp_sprites.h:25
const KEY_LEFT_X = 0;
const KEY_OCTAVES = 8;
const BAR_L_X = 66;
const BAR_L_W = 14;
const BAR_X = BAR_L_X + BAR_L_W;
const BAR_Y = 1; // fmdsp_sprites.h:39
const BAR_W = 2;
const BAR_H = 4;
const DT_SIGN_W = 3;
const DT_SIGN_H = 3;

// 本家の行送り。fmdsp_sprites.h:2 `TRACK_H = 32,` (FMDSP_LEFT_MODE_OPNA、
// 10行構成で使う値。13行モードの TRACK_H_S=24 は本Web版未対応)。
export const TRACK_H = 32;

// docs/fmdsp-layout.md §7 で確認したパレット色番号の出典:
//   fmdsp-pacc.c:2064 color(1)  … buf_font_1 / buf_font_1_d / buf_dt_sign
//   fmdsp-pacc.c:2070 color(3)  … buf_solid_3 系 (未再生/バー背景)
//   fmdsp-pacc.c:2076 color(2)  … buf_font_2 / buf_font_2_d (トラック種別・TINFO)
//   fmdsp-pacc.c:2086 color(7)  … buf_solid_7 系 (レスト/マスク時・現在tick)
//   fmdsp-pacc.c:2110/2112      … 鍵盤ハイライト: masked=8, 通常=6
//     (本Web版はこの2110/2112のmasked分岐=色差し替えを採用しない。理由は下記)。
// COLOR_LABEL/COLOR_TYPE/COLOR_KEY_HILITEはexportして、tools/verify_dim_tier_luminance.mjs
// から直接参照できるようにする。
export const COLOR_LABEL = 1;
export const COLOR_TYPE = 2;
const COLOR_BAR_BG = 3;
const COLOR_BAR_REST = 7;
export const COLOR_KEY_HILITE = 6;
const COLOR_KEY_HILITE_SUB = 8;

// ミュート中/未使用の行の暗色表示について(2026-08-17、方式を全面差し替え)。
//
// 旧方式(パレット番号の付け替え、〜2317820まで)は、通常色6(緑、鍵盤ハイライト)を
// ミュート時に色8(青、COLOR_KEY_HILITE_SUB)へ差し替えていた。これに利用者から
// 「通常が緑に対して暗い版は青色になってます。暗くなった感じには見えない」と
// 指摘があった。既定パレットには色相を保ったまま暗い緑が存在しないため、番号の
// 付け替えでは解決できない(色相そのものが変わってしまう)。
//
// 新方式(利用者判断): 色番号は一切変えず、常にCOLOR_LABEL/COLOR_TYPE/
// COLOR_KEY_HILITE等の通常色のまま描く。「今どの段階(通常/ミュート/未使用)か」は
// fmdsp/dim-tier.jsのTIER_*定数でvram.setTier()へ申告するだけにし、実際に暗く
// するのはfmdsp/vram.js Vram#toImageData()がパレットRGBへ変換する最後の1箇所
// (元の色 x 係数、RGBの比=色相を保ったまま輝度だけ落とす)に一本化した。
// 係数の値・選定理由はfmdsp/dim-tier.js参照。
//
// この結果、鍵盤ハイライトは常に色6(緑)のまま描かれ、ミュート/未使用時は
// 「暗い緑」になる(旧方式の「青になる」問題が構造的に起こらなくなった)。
// COLOR_MUTED/COLOR_UNUSEDという専用の色番号は不要になったため廃止した。

// fmdriver.h の enum FMDRIVER_TRACKTYPE_* / FMDRIVER_TRACK_INFO_* を
// このモジュール内だけの整数定数として再掲(値は upstream ヘッダと一致させる)。
const TRACKTYPE_FM = 0;
const TRACKTYPE_SSG = 1;
const TRACKTYPE_ADPCM = 2;
const TRACKTYPE_PPZ8 = 3;

const TRACK_INFO_NORMAL = 0;
const TRACK_INFO_SSG = 1;
const TRACK_INFO_FM3EX = 2;
const TRACK_INFO_PPZ8 = 3;
const TRACK_INFO_PDZF = 4;
const TRACK_INFO_SSGEFF = 5;

// fmdsp-pacc.c:29-51 track_type_table (type, num) をそのまま転記。
const TRACK_TYPE_TABLE = [
  [TRACKTYPE_FM, 1], [TRACKTYPE_FM, 2], [TRACKTYPE_FM, 3],
  [TRACKTYPE_FM, 3], [TRACKTYPE_FM, 3], [TRACKTYPE_FM, 3],
  [TRACKTYPE_FM, 4], [TRACKTYPE_FM, 5], [TRACKTYPE_FM, 6],
  [TRACKTYPE_SSG, 1], [TRACKTYPE_SSG, 2], [TRACKTYPE_SSG, 3],
  [TRACKTYPE_ADPCM, 1],
  [TRACKTYPE_PPZ8, 1], [TRACKTYPE_PPZ8, 2], [TRACKTYPE_PPZ8, 3],
  [TRACKTYPE_PPZ8, 4], [TRACKTYPE_PPZ8, 5], [TRACKTYPE_PPZ8, 6],
  [TRACKTYPE_PPZ8, 7], [TRACKTYPE_PPZ8, 8],
];

const TRACK_TYPE_LABEL = {
  [TRACKTYPE_FM]: 'FM',
  [TRACKTYPE_SSG]: 'SSG',
  [TRACKTYPE_ADPCM]: 'ADPCM',
  [TRACKTYPE_PPZ8]: 'PPZ8',
};

// fmdsp-pacc.c:53-65 track_disp_table_opna (FMDSP_LEFT_MODE_OPNA、10行)。
// FMDRIVER_TRACK_* の並び順そのままのスロット番号。
export const TRACK_DISP_TABLE_OPNA = [0, 1, 2, 6, 7, 8, 9, 10, 11, 12];

// PmdCore.c flatten() のフィールド順(FIELD_COUNT=26)。
const FIELD = {
  PLAYING: 0, INFO: 1, TICKS: 2, TICKS_LEFT: 3, KEY: 4, ACTUAL_KEY: 5,
  TONENUM: 6, VOLUME: 7, GATE: 8, DETUNE: 9,
  STATUS: 10, // 9要素 (10..18)
  FMSLOTMASK: 19, // 4要素 (19..22)
  PPZ8_CH: 23, SSG_TONE: 24, SSG_NOISE: 25,
};

const KEY_NAMES = ['C', 'C+', 'D', 'D+', 'E', 'F', 'F+', 'G', 'G+', 'A', 'A+', 'B'];

function statusString(data) {
  let out = '';
  for (let i = 0; i < 9; ++i) {
    const code = data[FIELD.STATUS + i];
    if (code === 0) break;
    out += String.fromCharCode(code & 0xff);
  }
  return out;
}

// 1トラック分を描画する。x,y は行の左上。data は flatten() の1トラック分
// (Int32Array長26、index.htmlのentry.subarray(1+track*fieldCount, ...)相当)。
// font 引数は未使用(呼び出し側との互換のため残すだけ)。パート行は本家と同じ
// font_fmdsp_small (SMALL_FONT) 固定で描く。曲名/コメント欄は別モジュールで
// shinonome ROM を使う想定(このモジュールのスコープ外)。
export function drawTrackRow(vram, font, x, y, slotIndex, data, muted = false, unused = false) {
  const smallFont = SMALL_FONT;
  const [type, num] = TRACK_TYPE_TABLE[slotIndex];
  // 段階の優先順位(未使用 > ミュート > 通常)はtierFor()に集約済み
  // (fmdsp/dim-tier.js。unusedはmutedを兼ねた見た目になる=曲が使っていない
  // パートを利用者がさらにミュートしても、元々鳴らないので見た目を変える必要が無い)。
  // この行が属する段階をvramへ申告する。以降このブロック内の
  // 描画(setPixel経由の全メソッド、drawText/blitCopy/blitColor/fillRectいずれも)は
  // 色番号を変えずに済み、最終的な暗さはVram#toImageData()側の係数乗算(色相を保つ)
  // だけで決まる(fmdsp/dim-tier.js参照)。関数を抜ける前に必ずTIER_NORMALへ戻す
  // (呼び出し順に依存せず、常にこの関数の中だけで段階の開始/終了が閉じるように
  // finallyで戻す)。
  const tier = tierFor(muted, unused);
  vram.setTier(tier);
  try {
  const typeColor = COLOR_TYPE;
  const labelColor = COLOR_LABEL;
  const playing = data[FIELD.PLAYING] !== 0;
  const info = data[FIELD.INFO];
  const key = data[FIELD.KEY];
  const actualKey = data[FIELD.ACTUAL_KEY];
  const tonenum = data[FIELD.TONENUM];
  const volume = data[FIELD.VOLUME];
  const gate = data[FIELD.GATE];
  const detune = data[FIELD.DETUNE];
  const ticks = data[FIELD.TICKS];
  const ticksLeft = data[FIELD.TICKS_LEFT];

  // --- 行0: トラック番号(数字スプライト) + 種別ラベル + TINFO(EX/EFF等) ---
  // fmdsp-pacc.c:472-485 (update_track_without_key)。NUMスプライトは
  // y+1 (fmdsp-pacc.c:480,484)。
  // 数字スプライトはblitCopy(スプライトに焼き込まれた色番号2/3、アンチエイリアス用の
  // 2階調をそのまま使う)。段階による暗さはtoImageData側の係数乗算で自動的にかかる
  // ため、旧方式のような「ミュート中はblitColorへ切り替えて塗り直す」分岐は不要になった
  // (焼き込み済みの2階調のアンチエイリアスも保たれたまま暗くなる、という副次的な改善)。
  const num1 = Math.floor(num / 10) % 10;
  const num2 = num % 10;
  vram.blitCopy(S_NUM[num1], NUM_W, x + NUM_X, y + 1, NUM_W, NUM_H);
  vram.blitCopy(S_NUM[num2], NUM_W, x + NUM_X + NUM_W, y + 1, NUM_W, NUM_H);

  drawText(vram, smallFont, TRACK_TYPE_LABEL[type] || '', x + 1, y, typeColor);

  // --- 行1(y+6): ラベル+値 (TRACK./KN:/TN:/Vl:/GT:/DT:/M:) ---
  // fmdsp-pacc.c:412-438 (init_track_without_key), 522-556 (update_track_without_key)。
  const lineY = y + 6;

  // TINFO: fmdsp-pacc.c:486-521 のうち読み取れた分岐のみ実装。
  // (元コードは"EX"をy行、スロットマスク文字列をy+6行に描く。他はy+6行のみ)
  if (playing || info === TRACK_INFO_SSGEFF) {
    if (info === TRACK_INFO_PPZ8) {
      drawText(vram, smallFont, 'PPZ8', x + TINFO_X, lineY, typeColor);
    } else if (info === TRACK_INFO_PDZF) {
      drawText(vram, smallFont, 'PDZF', x + TINFO_X, lineY, typeColor);
    } else if (info === TRACK_INFO_FM3EX) {
      const mask = [19, 20, 21, 22].map((i) => data[i] !== 0);
      const slotStr = ['1', '2', '3', '4'].map((c, i) => (mask[i] ? ' ' : c)).join('');
      drawText(vram, smallFont, 'EX', x + TINFO_X + 5, y, typeColor);
      drawText(vram, smallFont, slotStr, x + TINFO_X, lineY, typeColor);
    }
    // SSG/SSGEFFのノイズ周波数表示は fp->work->ssg_noise_freq (グローバル値)が
    // 必要で、flat_track_status には含まれていないため未実装。
  }
  drawText(vram, smallFont, 'TRACK.', x + 1, lineY, labelColor);
  drawText(vram, smallFont, 'KN:', x + TDETAIL_X, lineY, labelColor);
  if (!playing) {
    // fmdsp-pacc.c:522-525: TDETAIL_KN_V_X+5 (1文字ぶん右、"o%d%s"より短いため)。
    drawText(vram, smallFont, 'S', x + TDETAIL_KN_V_X + 5, lineY, labelColor);
  } else if ((key & 0xf) === 0xf) {
    drawText(vram, smallFont, 'R', x + TDETAIL_KN_V_X + 5, lineY, labelColor);
  } else {
    const name = KEY_NAMES[key & 0xf] || '';
    drawText(vram, smallFont, `o${key >> 4}${name}`, x + TDETAIL_KN_V_X, lineY, labelColor);
  }
  drawText(vram, smallFont, 'TN:', x + TDETAIL_TN_X, lineY, labelColor);
  drawText(vram, smallFont, String(tonenum).padStart(3, '0'), x + TDETAIL_TN_V_X, lineY, labelColor);
  drawText(vram, smallFont, 'Vl', x + TDETAIL_VL_X, lineY, labelColor);
  drawText(vram, smallFont, ':', x + TDETAIL_VL_C_X, lineY, labelColor);
  drawText(vram, smallFont, String(volume).padStart(3, '0'), x + TDETAIL_VL_V_X, lineY, labelColor);
  drawText(vram, smallFont, 'GT:', x + TDETAIL_GT_X, lineY, labelColor);
  drawText(vram, smallFont, String(gate).padStart(3, '0'), x + TDETAIL_GT_V_X, lineY, labelColor);
  drawText(vram, smallFont, 'DT:', x + TDETAIL_DT_X, lineY, labelColor);
  drawText(vram, smallFont, String(Math.abs(detune)).padStart(3, '0'), x + TDETAIL_DT_V_X, lineY, labelColor);
  const sign = detune === 0 ? 0 : (detune < 0 ? 1 : 2);
  vram.blitColor(S_DT_SIGN[sign], DT_SIGN_W, x + TDETAIL_DT_S_X, lineY + 2, DT_SIGN_W, DT_SIGN_H, labelColor);
  drawText(vram, smallFont, 'M:', x + TDETAIL_M_X, lineY, labelColor);
  drawText(vram, smallFont, statusString(data), x + TDETAIL_M_V_X, lineY, labelColor);

  // --- 鍵盤(y+KEY_Y) ---
  // fmdsp-pacc.c:770-797 (update_track_10)。KEY_Y=14 (fmdsp_sprites.h:25)。
  const keyBandY = y + KEY_Y;
  vram.blitCopy(S_KEY_LEFT, KEY_LEFT_W, x + KEY_LEFT_X, keyBandY, KEY_LEFT_W, KEY_H);
  for (let i = 0; i < KEY_OCTAVES; ++i) {
    vram.blitCopy(S_KEY_BG, KEY_W, x + KEY_X + KEY_W * i, keyBandY, KEY_W, KEY_H);
  }
  vram.blitCopy(S_KEY_RIGHT, KEY_RIGHT_W, x + KEY_X + KEY_W * KEY_OCTAVES, keyBandY, KEY_RIGHT_W, KEY_H);

  // ノート番号(key & 0xf)は本来 0-11。本家(fmdsp-pacc.c:784,793)は範囲検査せず
  // 高さ KEY_H*12 のテクスチャへのオフセットに使うだけなので、範囲外が来ても
  // GPU側のサンプリングで済み落ちない。JSの配列参照は undefined になり例外で
  // rAF ループごと止まるため、ここでは明示的に弾く。
  // (実データでは休符=0xff がオクターブ側のガードで先に落ちるため到達しない)
  const noteInRange = (k) => (k & 0xf) < S_KEY_MASK.length;

  if (playing || info === TRACK_INFO_SSGEFF) {
    const actualOctave = actualKey >> 4;
    if (actualOctave >= 0 && actualOctave < KEY_OCTAVES && noteInRange(actualKey)) {
      // actual_key(ピッチベンド/LFO適用後の実際の発音音程)は本家でも常に
      // buf_key_mask_sub(色8)固定(fmdsp-pacc.c:719-726、masked分岐が無い)。
      // ミュート状態に関わらず色番号自体は変えない(段階による暗さは
      // vram.setTier()経由でこのブロック全体に自動的にかかる)。
      vram.blitColor(
        S_KEY_MASK[actualKey & 0xf], KEY_W,
        x + KEY_X + KEY_W * actualOctave, keyBandY, KEY_W, KEY_H,
        COLOR_KEY_HILITE_SUB
      );
    }
    const octave = key >> 4;
    if (octave >= 0 && octave < KEY_OCTAVES && noteInRange(key)) {
      // key(譜面上の音程)のハイライト。本家 fmdsp-pacc.c:728-729/2110/2112は
      // マスク中に色8(青系)へ差し替えるが、2026-08-17に利用者から「通常が緑に
      // 対して暗い版は青色になっている。暗くなった感じには見えない」と指摘があり、
      // この色差し替え(=upstreamの`masked`分岐)を採用しないことにした
      // (利用者判断、fmdsp/dim-tier.js冒頭コメント参照)。常に色6(COLOR_KEY_HILITE、
      // 緑)のまま描き、ミュート/未使用時は「暗い緑」になる(色相を保つ)。
      vram.blitColor(
        S_KEY_MASK[key & 0xf], KEY_W,
        x + KEY_X + KEY_W * octave, keyBandY, KEY_W, KEY_H,
        COLOR_KEY_HILITE
      );
    }
  }

  // ゲージバー(fmdsp-pacc.c:561-577)。y+BAR_Y (BAR_Y=1、fmdsp_sprites.h:39)。
  // 本家は tex_solid(1x1)を伸縮させて描く単色矩形なので、スプライトではなく
  // vram.fillRect を使う。
  const barY = y + BAR_Y;
  const isRest = (key & 0xf) === 0xf;
  const barColor = !playing ? COLOR_BAR_BG : (isRest ? COLOR_BAR_REST : typeColor);
  vram.fillRect(x + BAR_L_X, barY, BAR_L_W - 1, BAR_H, barColor);
  const width = ticksLeft >> 2;
  const fillColor = !playing ? COLOR_BAR_BG : (isRest ? COLOR_BAR_REST : typeColor);
  vram.fillRect(x + BAR_X, barY, BAR_W * width, BAR_H, fillColor);
  vram.fillRect(x + BAR_X + BAR_W * width, barY, BAR_W * (64 - width), BAR_H, COLOR_BAR_BG);
  vram.fillRect(x + BAR_X + BAR_W * (ticks >> 2), barY, BAR_W, BAR_H, COLOR_BAR_REST);
  } finally {
    // 必ず通常段階へ戻す。ここでの戻し忘れは、次にこの行のy範囲へ描く
    // 無関係な要素(例えば右ペインの静的装飾との重なり)まで暗くしてしまう。
    vram.setTier(TIER_NORMAL);
  }
}

// 10行(FMDSP_LEFT_MODE_OPNA)ぶんをまとめて描画する。
// entryTracks: index.html 側で作る「trackスロット index -> flatten済みInt32配列」の配列。
// mutedRows: ミュート中の行index(0-9)の集合(Set<number>)。省略時は誰もミュート
// されていない(トラック行クリックミュート機能、docs参照はfmdsp/channel-mask.js)。
// unusedRows: 曲が使っていない行index(0-9)の集合(Set<number>)。省略時は
// 誰も未使用扱いにしない(2026-08-17追加。判定できないときは呼び出し側が
// 空集合を渡すこと。fmdsp/channel-mask.js unusedRowsFromChannels参照)。
export function drawTrackRows(vram, font, entryTracks, mutedRows = EMPTY_MUTED_ROWS, unusedRows = EMPTY_MUTED_ROWS) {
  TRACK_DISP_TABLE_OPNA.forEach((slotIndex, row) => {
    const data = entryTracks[slotIndex];
    drawTrackRow(vram, font, 0, TRACK_H * row, slotIndex, data, mutedRows.has(row), unusedRows.has(row));
  });
}

const EMPTY_MUTED_ROWS = new Set();

// PmdCore.c flatten() 相当のフラットレイアウト長。FIELD(上記)の最終フィールド
// SSG_NOISE=25 が0始まりの最終indexなので+1で26。
export const FIELD_COUNT = 26;

// 2026-08-15: 曲が読み込まれていない/停止中でもパート行の「枠」(鍵盤地板・
// TRACK./KN:/TN:/Vl:/GT:/DT:/M:等のラベル、KN:はplaying=falseなので"S")を
// 描くためのプレースホルダデータ。
//
// 出典確認: 上流(fmdsp-pacc.c)はパート行を「曲の有無」で出し分けていない。
// update_track_without_key/update_track_10 は fp->work が指す
// fmdriver_track_status を毎フレーム無条件に読んで描画するだけで、
// 「曲が読み込まれていない」状態を特別扱いする分岐は存在しない
// (fp->work 自体が起動直後から静的に確保された構造体を指し続ける設計のため、
// 全フィールド0の「未再生」状態がそのまま描かれる。C側で「表示するかどうか」を
// 曲の有無で切り替えるコードは無いことをfmdsp-pacc.c全文で確認済み)。
// 全フィールド0のデータは drawTrackRow() 内で自然に「playing=false」分岐
// (KN:S、鍵盤ハイライト無し、バーは背景色)に落ちるため、上流と同じ見た目になる。
export function createIdleEntryTracks() {
  const maxSlot = TRACK_DISP_TABLE_OPNA.reduce((m, v) => Math.max(m, v), 0);
  return Array.from({ length: maxSlot + 1 }, () => new Int32Array(FIELD_COUNT));
}
