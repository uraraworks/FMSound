// FMDSP 右半分(FMDSP_RIGHT_MODE_DEFAULT、旧ORIGINAL相当)レンダラ。
// 出典: docs/fmdsp-layout.md §2「領域の一覧」、正典は
// upstream/98fmplayer/fmdsp/fmdsp-pacc.c の init_default (1119-1435) /
// update_default (1506-1623) と upstream/98fmplayer/fmdsp/fmdsp_sprites.h の定数群。
//
// スコープ(FMSound/tools/gen_sprites.py への委任元の指示どおり):
//   - 静的装飾(ロゴ・タイトル・バージョン・CURL・各種ラベル・目盛)
//   - 動的だが単純な数値/バー/アイコン(経過時間・CLOCK/TIMERB/LOOP・ループバー・
//     CIRCLE・PLAY/STOP/PAUSE状態色)
//   - SPECTRUM/LEVELメーターは「枠・目盛だけ」。バー本体はデータ供給待ちにつき
//     空実装(コメントで明記)。
//
// 座標定数は fmdsp_sprites.h の enum をそのまま転記し、行ごとに file:line を
// 付す(trackrow.js の流儀を踏襲)。読み取れなかった値は「未確認」と明記する。

import { drawText, SmallFont } from './font.js';
import { FONT_SMALL, FONT_MEDIUM } from './font_small.js';
import {
  NUM_W, NUM_H, S_NUM, S_NUM_COLON, S_NUM_BAR,
  LOGO_FM_W, LOGO_DS_W, LOGO_P_W, LOGO_H, LOGO_W,
  S_LOGO_FM, S_LOGO_DS, S_LOGO_P,
  TOP_TEXT_W, TOP_TEXT_H, S_TEXT,
  VER_W, VER_H, S_VER,
  CURL_W, CURL_H, S_CURL_LEFT, S_CURL_RIGHT,
  PLAY_W, PLAY_H, STOP_W, STOP_H, PAUSE_W, PAUSE_H,
  FADE_W, FADE_H, FF_W, FF_H, REW_W, REW_H, FLOPPY_W, FLOPPY_H,
  S_PLAY, S_STOP, S_PAUSE, S_FADE, S_FF, S_REW, S_FLOPPY,
  CIRCLE_W, CIRCLE_H, S_CIRCLE,
  PANPOT_W, PANPOT_H, S_PANPOT,
} from './sprites.js';

const SMALL_FONT = new SmallFont(FONT_SMALL); // font_fmdsp_small (5x6, buf_font_1/1_d相当)
const MEDIUM_FONT = new SmallFont(FONT_MEDIUM); // font_fmdsp_medium (6x8, buf_font_2/2_d相当)

// buf_font_7/buf_solid_7系は本家では「font_fmdsp_small」の別インスタンス
// (fmdsp-pacc.c:825-833 tex_font/tex_fontm の2種類しか無く、7番色版も同じ
// glyphを使い分けているだけ)。本Web版はフォント形状ではなく描画時の color
// 引数で色番号を切り替える(drawText の最終引数)ので、フォントオブジェクトは
// SMALL_FONT/MEDIUM_FONT の2種で足りる。

// --- パレット色番号 ---
// fmdsp-pacc.c:2063-2130 (fmdsp_pacc_render の draw()呼び出し列)より。
// buf_font_1系=1, buf_font_2系=2, buf_font_7系=7, buf_solid_2系=2,
// buf_solid_3系=3, buf_solid_7系=7, buf_panpot_1_d=1, buf_panpot_5_d=5。
const COLOR_1 = 1;
const COLOR_2 = 2;
const COLOR_3 = 3;
const COLOR_7 = 7;

// --- 位置定数 (fmdsp_sprites.h の enum より、file:line は行コメントに個別記載) ---
const LOGO_Y = 1; // :97
const LOGO_FM_X = 312; // :102
const LOGO_DS_X = LOGO_FM_X + LOGO_FM_W + 2; // :103
const LOGO_P_X = LOGO_DS_X + LOGO_DS_W + 2; // :104

const TOP_MUS_X = 397; // :109
const TOP_MUSIC_Y = 7; // :110
const TOP_IC_X = TOP_MUS_X + 14; // :111
const TOP_F_X = TOP_IC_X + 12; // :112
const TOP_ILE_X = TOP_F_X + 4; // :113
const TOP_SELECTOR_X = TOP_ILE_X + 17; // :114
const TOP_AND_X = TOP_SELECTOR_X + 42; // :115
const TOP_STATUS_X = TOP_AND_X + 7; // :116
const TOP_D_X = TOP_STATUS_X + 32; // :117
const TOP_ISPLAY_X = TOP_D_X + 4; // :118
const TOP_VER_X = TOP_ISPLAY_X + 32; // :119
const TOP_TEXT_Y = TOP_MUSIC_Y - 6; // :122
const VER_Y = 8; // :125
const VER_0_X = TOP_VER_X + 15; // :126
const VER_1_X = VER_0_X + 7; // :127
const VER_2_X = VER_1_X + 7; // :128

const DRIVER_TEXT_X = 312; // :129
const DRIVER_TEXT_Y = 27; // :130
const DRIVER_TEXT_2_X = DRIVER_TEXT_X + 9; // :131
const DRIVER_TRI_X = DRIVER_TEXT_2_X + 26; // :132
const DRIVER_TRI_Y = DRIVER_TEXT_Y + 3; // :133
const FILEBAR_TRI_W = 3; // :58
const FILEBAR_TRI_H = 3; // :59

const CURL_LEFT_X = 347; // :136
const CURL_RIGHT_X = 509; // :137
const CURL_Y = 80; // :138

const TIME_TEXT_X = 530; // :84
const TIME_X = TIME_TEXT_X + 38; // :85
const TIME_BAR_X = TIME_TEXT_X - 6; // :86
const TIME_TRI_X = TIME_TEXT_X + 31; // :87
const TIME_BAR_W = 3; // :88
const TIME_BAR_H = 14; // :89
const TIME_Y = 22; // :90
const CLOCK_Y = TIME_Y + 19; // :91
const TIMERB_Y = CLOCK_Y + 19; // :92
const LOOPCNT_Y = TIMERB_Y + 19; // :93
const VOLDOWN_Y = LOOPCNT_Y + 19; // :94
const PGMNUM_Y = VOLDOWN_Y + 19; // :95

const CPU_Y = 115; // :73
const CPU_X = 320; // :74
const CPU_BAR_X = CPU_X - 6; // :75
const CPU_NUM_X = CPU_X + 56; // :76
const CPU_NUM_Y = CPU_Y + 2; // :77
const CPU_TRI_X = CPU_X + 43; // :78
const CPU_TRI_Y = CPU_Y + 10; // :79
const FPS_X = CPU_X + 100; // :80
const FPS_BAR_X = FPS_X - 6; // :81
const FPS_NUM_X = FPS_X + 61; // :82
const FPS_TRI_X = FPS_X + 48; // :83

const PLAY_X = 354, PLAY_Y = 77; // :141-142
const STOP_X = 393, STOP_Y = 77; // :145-146
const PAUSE_X = 433, PAUSE_Y = 77; // :149-150
const FADE_X = 481, FADE_Y = 77; // :153-154
const FF_X = 360, FF_Y = 87; // :157-158
const REW_X = 392, REW_Y = 87; // :161-162
const FLOPPY_X = 432, FLOPPY_Y = 87; // :165-166

const SPECTRUM_X = 352; // :71
const SPECTRUM_Y = 207; // :72
const FFTDISPLEN = 70; // upstream/98fmplayer/fft/fft.h:8

const LEVEL_TEXT_X = 318; // :167
const LEVEL_TEXT_Y = 290; // :168
const LEVEL_X = 353 - 16; // :169 (=337)
const LEVEL_Y = 227; // :170
const LEVEL_DISP_W = 14; // :171
const LEVEL_W = 16; // :172
const PANPOT_Y = LEVEL_Y + 64; // :175
const LEVEL_TRACK_Y = LEVEL_Y - 9; // :176
const LEVEL_PROG_Y = PANPOT_Y + 15; // :177
const LEVEL_KEY_Y = LEVEL_PROG_Y + 7; // :178
const FMDSP_LEVEL_COUNT = 19; // fmdsp-pacc.h:16

const NUM_X_TIME = TIME_X; // 経過時間・CLOCK・TIMERB・LOOP共通の桁基準x

// --- ピーク保持・減衰テーブル ---
// fftdropdiv/leveldropdiv 共通の減衰速度テーブル。出典:
//   fmdsp.c:952-955 (fftdropdiv版) / fmdsp-pacc.c:1645-1647,1748-1750
//   (fft用/level用、いずれも同一の値であることを確認済み)。
// 使い方(本家アルゴリズム、fmdsp-pacc.c:1633-1653相当):
//   新しい値 >= 保持値: 保持値を更新しcnt=30にリセット
//   新しい値 < 保持値: cntを1減算。cnt==0になったら dropdiv を1減算、
//     dropdivも0なら divtab[保持値/2] を dropdiv に入れ直し保持値を1減算。
// これによりピークは30フレーム保持後、値が大きいほど速く(小さいほど遅く)減衰する。
export const PEAK_DROP_DIVTAB = [
  32, 16, 8, 8, 4, 4, 4, 4, 2, 2, 2, 2, 2, 2, 2, 2,
];

// --- 静的部分 ---

// ロゴ(FM/DS/P)。fmdsp-pacc.c:1121-1124, buf_logo は pacc_mode_copy
// (スプライト自体にパレット値2/3/9が埋め込まれているので追加の色引数は不要)。
export function drawLogo(vram) {
  vram.blitCopy(S_LOGO_FM, LOGO_FM_W, LOGO_FM_X, LOGO_Y, LOGO_FM_W, LOGO_H);
  vram.blitCopy(S_LOGO_DS, LOGO_DS_W, LOGO_DS_X, LOGO_Y, LOGO_DS_W, LOGO_H);
  vram.blitCopy(S_LOGO_P, LOGO_P_W, LOGO_P_X, LOGO_Y, LOGO_P_W, LOGO_H);
}

// タイトル文字列 "MUSIC FILE SELECTOR & STATUS DISPLAY" + バージョン表示。
// fmdsp-pacc.c:1125-1176。buf_font_2 = color 2、buf_ver は pacc_mode_copy。
// バージョン番号は固定文字列を渡す想定(呼び出し側が FMPLAYER_VERSION_0/1/2
// 相当の文字列を持つ。本Web版に対応する値が無いため引数化する)。
export function drawTitle(vram, version = ['0', '0', '0']) {
  drawText(vram, MEDIUM_FONT, 'MUS', TOP_MUS_X, TOP_MUSIC_Y, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'IC', TOP_IC_X, TOP_MUSIC_Y, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'F', TOP_F_X, TOP_MUSIC_Y, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'ILE', TOP_ILE_X, TOP_MUSIC_Y, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'SELECTOR', TOP_SELECTOR_X, TOP_MUSIC_Y, COLOR_2);
  drawText(vram, MEDIUM_FONT, '&', TOP_AND_X, TOP_MUSIC_Y, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'STATUS', TOP_STATUS_X, TOP_MUSIC_Y, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'D', TOP_D_X, TOP_MUSIC_Y, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'ISPLAY', TOP_ISPLAY_X, TOP_MUSIC_Y, COLOR_2);
  vram.blitCopy(S_VER, VER_W, TOP_VER_X, VER_Y, VER_W, VER_H);
  drawText(vram, MEDIUM_FONT, `${version[0]}.`, VER_0_X, TOP_MUSIC_Y, COLOR_2);
  drawText(vram, MEDIUM_FONT, `${version[1]}.`, VER_1_X, TOP_MUSIC_Y, COLOR_2);
  drawText(vram, MEDIUM_FONT, `${version[2]}`, VER_2_X, TOP_MUSIC_Y, COLOR_2);
  vram.blitCopy(S_TEXT, TOP_TEXT_W, TOP_MUS_X, TOP_TEXT_Y, TOP_TEXT_W, TOP_TEXT_H);
}

// DRIVERラベル+三角インジケータ。fmdsp-pacc.c:1182-1191。
// buf_font_7 = color 7、buf_tri_7 は形状のみ(1x1矩形の三角スプライト、
// FILEBAR_TRI_W/H を流用。fmdsp_sprites.hに専用スプライト定義が見当たらず
// tools/gen_sprites.pyの抽出対象にも含めていないため、ここではベタ塗り
// 三角相当として fillRect で簡略化する。**未確認: 実際のs_filebar_tri形状は
// 三角形だが、本モジュールは矩形で代用しており正確な形は再現していない**)。
export function drawDriverLabel(vram) {
  drawText(vram, SMALL_FONT, 'DR', DRIVER_TEXT_X, DRIVER_TEXT_Y, COLOR_7);
  drawText(vram, SMALL_FONT, 'IVER', DRIVER_TEXT_2_X, DRIVER_TEXT_Y, COLOR_7);
  vram.fillRect(DRIVER_TRI_X, DRIVER_TRI_Y, FILEBAR_TRI_W, FILEBAR_TRI_H, COLOR_7);
}

// CURL(左右装飾)。fmdsp-pacc.c:1192-1199。pacc_mode_copy(スプライト自体に
// 色3が埋め込まれている)。
export function drawCurl(vram) {
  vram.blitCopy(S_CURL_LEFT, CURL_W, CURL_LEFT_X, CURL_Y, CURL_W, CURL_H);
  vram.blitCopy(S_CURL_RIGHT, CURL_W, CURL_RIGHT_X, CURL_Y, CURL_W, CURL_H);
}

// PASSED TIME/CLOCK COUNT/TIMER B CYCLE/LOOP COUNT/VOLUME DOWN/PGM NUMBER の
// ラベル群+区切り線+三角インジケータ。fmdsp-pacc.c:1197-1285。
// VOLUME DOWN / PGM NUMBER の値描画コードはfmdsp-pacc.c内に見当たらず
// (docs/fmdsp-layout.md §6「未解決のまま残った項目」参照)、**未確認のため
// ラベルのみ描画し値は出さない**。
export function drawTimeLabels(vram) {
  vram.fillRect(312, 14, 82, 1, COLOR_2); // fmdsp-pacc.c:1197-1199
  vram.fillRect(395, 14, 239, 1, COLOR_7); // fmdsp-pacc.c:1200-1202
  vram.fillRect(TIME_BAR_X, TIME_Y - 2, TIME_BAR_W, TIME_BAR_H, COLOR_2);
  vram.fillRect(TIME_BAR_X, CLOCK_Y - 2, TIME_BAR_W, TIME_BAR_H, COLOR_2);
  vram.fillRect(TIME_BAR_X, TIMERB_Y - 2, TIME_BAR_W, TIME_BAR_H, COLOR_2);
  vram.fillRect(TIME_BAR_X, LOOPCNT_Y - 2, TIME_BAR_W, TIME_BAR_H, COLOR_2);
  vram.fillRect(TIME_BAR_X, VOLDOWN_Y - 2, TIME_BAR_W, TIME_BAR_H, COLOR_2);
  vram.fillRect(TIME_BAR_X, PGMNUM_Y - 2, TIME_BAR_W, TIME_BAR_H, COLOR_2);
  for (let i = 0; i < 6; ++i) {
    vram.fillRect(TIME_TRI_X, TIME_Y + 8 + 19 * i, FILEBAR_TRI_W, FILEBAR_TRI_H, COLOR_1);
  }

  drawText(vram, MEDIUM_FONT, 'PASSED', TIME_TEXT_X, TIME_Y - 2, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'T', TIME_TEXT_X + 11, TIME_Y + 5, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'IME', TIME_TEXT_X + 15, TIME_Y + 5, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'CLOCK', TIME_TEXT_X, CLOCK_Y - 2, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'COUNT', TIME_TEXT_X + 5, CLOCK_Y + 5, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'T', TIME_TEXT_X, TIMERB_Y - 2, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'IMER', TIME_TEXT_X + 4, TIMERB_Y - 2, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'CYCLE', TIME_TEXT_X + 5, TIMERB_Y + 5, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'LOOP', TIME_TEXT_X, LOOPCNT_Y - 2, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'COUNT', TIME_TEXT_X + 5, LOOPCNT_Y + 5, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'VOLUME', TIME_TEXT_X, VOLDOWN_Y - 2, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'DOWN', TIME_TEXT_X + 10, VOLDOWN_Y + 5, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'PGM', TIME_TEXT_X, PGMNUM_Y - 2, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'NUMBER', TIME_TEXT_X, PGMNUM_Y + 5, COLOR_2);
}

// CPU POWER COUNT / FRAMES PER SECOND のラベル群。fmdsp-pacc.c:1295-1322。
export function drawCpuFpsLabels(vram) {
  vram.fillRect(CPU_BAR_X, CPU_Y, TIME_BAR_W, TIME_BAR_H, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'CPU', CPU_X, CPU_Y, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'POWER', CPU_X + 17, CPU_Y, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'COUNT', CPU_X + 17, CPU_Y + 7, COLOR_2);
  vram.fillRect(CPU_TRI_X, CPU_TRI_Y, FILEBAR_TRI_W, FILEBAR_TRI_H, COLOR_1);

  vram.fillRect(FPS_BAR_X, CPU_Y, TIME_BAR_W, TIME_BAR_H, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'FRAMES', FPS_X, CPU_Y, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'PER', FPS_X + 32, CPU_Y, COLOR_2);
  drawText(vram, MEDIUM_FONT, 'SECOND', FPS_X + 17, CPU_Y + 7, COLOR_2);
  vram.fillRect(FPS_TRI_X, CPU_TRI_Y, FILEBAR_TRI_W, FILEBAR_TRI_H, COLOR_1);
}

// SPECTRUMラベル群・周波数軸目盛・区切り線。fmdsp-pacc.c:1355-1434。
// 枠のみ(バー本体は drawSpectrumBars を参照、データ供給待ち)。
export function drawSpectrumLabels(vram) {
  drawText(vram, SMALL_FONT, 'SPECTRUM', SPECTRUM_X + 197, SPECTRUM_Y - 71, COLOR_7);
  drawText(vram, SMALL_FONT, 'ANAL', SPECTRUM_X + 241, SPECTRUM_Y - 71, COLOR_7);
  drawText(vram, SMALL_FONT, 'YzER', SPECTRUM_X + 260, SPECTRUM_Y - 71, COLOR_7);
  drawText(vram, SMALL_FONT, 'FREQ', SPECTRUM_X - 24, SPECTRUM_Y + 1, COLOR_1);
  drawText(vram, SMALL_FONT, '250', SPECTRUM_X + 36, SPECTRUM_Y + 1, COLOR_1);
  drawText(vram, SMALL_FONT, '500', SPECTRUM_X + 83, SPECTRUM_Y + 1, COLOR_1);
  drawText(vram, SMALL_FONT, '1', SPECTRUM_X + 133, SPECTRUM_Y + 1, COLOR_1);
  drawText(vram, SMALL_FONT, 'k', SPECTRUM_X + 133 + 6, SPECTRUM_Y + 1, COLOR_1);
  drawText(vram, SMALL_FONT, '2k', SPECTRUM_X + 183, SPECTRUM_Y + 1, COLOR_1);
  drawText(vram, SMALL_FONT, '4k', SPECTRUM_X + 230, SPECTRUM_Y + 1, COLOR_1);

  vram.fillRect(SPECTRUM_X - 2, SPECTRUM_Y - 62, 1, 63, COLOR_2);
  for (let i = 0; i < 32; ++i) {
    const w = (i % 4) === 3 ? 2 : 1;
    const x = SPECTRUM_X - 3 - ((i % 4) === 3 ? 1 : 0);
    vram.fillRect(x, SPECTRUM_Y - 62 + 2 * i, w, 1, COLOR_2);
  }
  // チェッカー柄区切り線(buf_checker_1)。本家はテクスチャの市松模様だが、
  // ここでは1x1ドット単位のチェッカーパターンを直接展開する
  // (fmdsp-pacc.c:862-867 tex_checker の2x2生成に相当)。
  const checkerSpans = [
    [SPECTRUM_X + 1, 34], [SPECTRUM_X + 52, 30], [SPECTRUM_X + 99, 34],
    [SPECTRUM_X + 144, 38], [SPECTRUM_X + 193, 36], [SPECTRUM_X + 240, 40],
  ];
  for (const [x0, w] of checkerSpans) {
    for (let dx = 0; dx < w; dx += 2) vram.setPixel(x0 + dx, SPECTRUM_Y + 4, COLOR_1);
  }
}

// LEVELラベル群(行見出しON/PAN/PROG/KEY、列見出しFM1/FM4/SSG/RHY/ADP/PPZ)+
// 目盛。fmdsp-pacc.c:1436-1481, 1489-1499。
export function drawLevelLabels(vram) {
  for (let c = 0; c < FMDSP_LEVEL_COUNT; ++c) {
    // buf_horizontal_3 (背景の縦帯) はデータ非依存の枠として静的に描いてよい。
    vram.fillRect(LEVEL_X + LEVEL_W * c, LEVEL_Y, LEVEL_DISP_W, 64, COLOR_3);
  }
  drawText(vram, SMALL_FONT, 'ON', LEVEL_TEXT_X + 5, LEVEL_TEXT_Y, COLOR_1);
  drawText(vram, SMALL_FONT, 'PAN', LEVEL_TEXT_X, LEVEL_TEXT_Y + 8, COLOR_1);
  drawText(vram, SMALL_FONT, 'PROG', LEVEL_TEXT_X - 5, LEVEL_TEXT_Y + 16, COLOR_1);
  drawText(vram, SMALL_FONT, 'KEY', LEVEL_TEXT_X, LEVEL_TEXT_Y + 23, COLOR_1);
  drawText(vram, SMALL_FONT, 'FM1', LEVEL_X + LEVEL_W * 0, LEVEL_TRACK_Y, COLOR_7);
  drawText(vram, SMALL_FONT, 'FM4', LEVEL_X + LEVEL_W * 3, LEVEL_TRACK_Y, COLOR_7);
  drawText(vram, SMALL_FONT, 'SSG', LEVEL_X + LEVEL_W * 6, LEVEL_TRACK_Y, COLOR_7);
  drawText(vram, SMALL_FONT, 'RHY', LEVEL_X + LEVEL_W * 9, LEVEL_TRACK_Y, COLOR_7);
  drawText(vram, SMALL_FONT, 'ADP', LEVEL_X + LEVEL_W * 10, LEVEL_TRACK_Y, COLOR_7);
  drawText(vram, SMALL_FONT, 'PPZ', LEVEL_X + LEVEL_W * 11, LEVEL_TRACK_Y, COLOR_7);

  vram.fillRect(LEVEL_X - 2, LEVEL_Y, 1, 63, COLOR_2);
  for (let i = 0; i < 32; ++i) {
    const extra = (i % 4) === 3 ? 1 : 0;
    vram.fillRect(LEVEL_X - 3 - extra, LEVEL_Y + i * 2, 1 + extra, 1, COLOR_2);
  }
  drawText(vram, SMALL_FONT, '0', LEVEL_X - 9, LEVEL_Y - 1, COLOR_7);
  drawText(vram, SMALL_FONT, '-48', LEVEL_X - 19, LEVEL_Y + 56, COLOR_7);
}

// 静的部分をまとめて1回描画する。初期化時にこれだけ呼べばよい。
export function drawStaticDecorations(vram, version) {
  drawLogo(vram);
  drawTitle(vram, version);
  drawDriverLabel(vram);
  drawCurl(vram);
  drawTimeLabels(vram);
  drawCpuFpsLabels(vram);
  drawSpectrumLabels(vram);
  drawLevelLabels(vram);
}

// --- 動的部分 ---

// tex_num の14フレーム構成 (fmdsp-pacc.c:814, 877-881) を1つの配列にまとめ、
// フレーム番号でアクセスできるようにしたもの。0-9=数字, 10=マスク時ダミー,
// 11=S_NUM_BAR, 12-13=S_NUM_COLON[0..1]。
const NUM_FRAMES = [...S_NUM, S_NUM_BAR, ...S_NUM_COLON];

function drawNumFrame(vram, x, y, frame, color) {
  // S_NUM系のスプライトはパレット値2/3が埋め込み済みなので blitCopy でよい
  // (trackrow.js と同じ流儀)。color引数は将来の拡張用に残すが未使用。
  vram.blitCopy(NUM_FRAMES[frame], NUM_W, x, y, NUM_W, NUM_H);
}

function drawDigits(vram, x, y, value, digitCount) {
  for (let i = 0; i < digitCount; ++i) {
    const num = Math.floor(value / 10 ** (digitCount - 1 - i)) % 10;
    drawNumFrame(vram, x + NUM_W * i, y, num);
  }
}

// 経過時間(mm:ss.cc)。fmdsp-pacc.c:1502-1539。
// frames: opna->generated_frames相当(55467 = 55466.6...Hzのサンプルレート
// 換算に使う本家定数、fmdsp-pacc.c:1504`frames % 55467`をそのまま踏襲)。
export function drawPassedTime(vram, frames) {
  const ssec = Math.floor((Number(frames % 55467n) * 100) / 55467);
  const sec = frames / 55467n;
  const min = sec / 60n;
  const secMod = sec % 60n;
  const num0 = Number((min / 10n) % 10n);
  const num1 = Number(min % 10n);
  const num2 = Number((secMod / 10n) % 10n);
  const num3 = Number(secMod % 10n);
  const num4 = Math.floor(ssec / 10) % 10;
  const num5 = ssec % 10;
  const blinkColon = Number(secMod % 2n); // 0=消灯コロン, 1=点灯コロン (NUM_H*(12+sec%2))
  drawNumFrame(vram, TIME_X + NUM_W * 0, TIME_Y, num0);
  drawNumFrame(vram, TIME_X + NUM_W * 1, TIME_Y, num1);
  drawNumFrame(vram, TIME_X + NUM_W * 2, TIME_Y, 12 + blinkColon);
  drawNumFrame(vram, TIME_X + NUM_W * 3, TIME_Y, num2);
  drawNumFrame(vram, TIME_X + NUM_W * 4, TIME_Y, num3);
  drawNumFrame(vram, TIME_X + NUM_W * 5, TIME_Y, 11); // 常時点灯コロン相当(区切りの"."位置)
  drawNumFrame(vram, TIME_X + NUM_W * 6, TIME_Y, num4);
  drawNumFrame(vram, TIME_X + NUM_W * 7, TIME_Y, num5);
}

// CLOCK COUNT。fmdsp-pacc.c:1541-1550。8桁、右詰め。
export function drawClockCount(vram, clock) {
  let v = BigInt(clock);
  for (let i = 0; i < 8; ++i) {
    const num = Number(v % 10n);
    v /= 10n;
    drawNumFrame(vram, TIME_X + NUM_W * (7 - i), CLOCK_Y, num);
  }
}

// TIMER B CYCLE。fmdsp-pacc.c:1552-1561。3桁、右詰め(TIME_X+NUM_W*5起点)。
export function drawTimerBCycle(vram, timerb) {
  let v = timerb & 0xff;
  for (let i = 0; i < 3; ++i) {
    const num = v % 10;
    v = Math.floor(v / 10);
    drawNumFrame(vram, TIME_X + NUM_W * (7 - i), TIMERB_Y, num);
  }
}

// LOOP COUNT。fmdsp-pacc.c:1563-1572。4桁、右詰め。
export function drawLoopCount(vram, loopCnt) {
  let v = loopCnt & 0xff;
  for (let i = 0; i < 4; ++i) {
    const num = v % 10;
    v = Math.floor(v / 10);
    drawNumFrame(vram, TIME_X + NUM_W * (7 - i), LOOPCNT_Y, num);
  }
}

// CPU POWER COUNT / FRAMES PER SECOND。fmdsp-pacc.c:1573-1594。各3桁。
export function drawCpuFps(vram, cpuusage, fps) {
  let c = cpuusage;
  for (let i = 0; i < 3; ++i) {
    const num = c % 10;
    c = Math.floor(c / 10);
    drawNumFrame(vram, CPU_NUM_X + NUM_W * (2 - i), CPU_NUM_Y, num);
  }
  let f = fps;
  for (let i = 0; i < 3; ++i) {
    const num = f % 10;
    f = Math.floor(f / 10);
    drawNumFrame(vram, FPS_NUM_X + NUM_W * (2 - i), CPU_NUM_Y, num);
  }
}

// ループ進捗バー。fmdsp-pacc.c:1595-1610。
// timerbCntLoop/loopTimerbCnt から現在位置(0-72)を計算しマーカーを置く。
// playing==false のときはマーカーを描かない(本家 `if (fp->work->playing)`)。
export function drawLoopBar(vram, { timerbCntLoop, loopTimerbCnt, playing, loopCnt }) {
  let pos = 0;
  if (loopTimerbCnt) {
    pos = Math.floor((timerbCntLoop * (72 + 1 - 4)) / loopTimerbCnt);
  }
  vram.fillRect(352, 70, 144, 4, COLOR_3); // buf_vertical_3 背景
  if (playing) {
    vram.fillRect(352 + pos * 2, 70, 8, 4, COLOR_2); // buf_vertical_2 マーカー
  }
  vram.fillRect(496, 70, 16, 4, loopCnt ? COLOR_7 : COLOR_3);
}

// CIRCLE(回転インジケータ)。fmdsp-pacc.c:1611-1623。
// clockCounter: work->timerb_cnt相当(内部で/8%8する)。paused時はframeCounterの
// %32>=16判定で消灯コマ(clock=8)にする。
export function drawCircle(vram, { playing, paused, timerbCnt, frameCnt }) {
  let clock = 8;
  if (playing) {
    if (paused && (frameCnt % 32) >= 16) {
      clock = 8;
    } else {
      clock = Math.floor(timerbCnt / 8) % 8;
    }
  }
  vram.blitCopy(S_CIRCLE[clock], CIRCLE_W, 312, 70, CIRCLE_W, CIRCLE_H); // CIRCLE_X=312,CIRCLE_Y=70 (:107-108)
}

// PLAY/STOP/PAUSE/FADE/FF/REW/FLOPPY アイコン。fmdsp-pacc.c:2113-2130。
// PLAY/STOP/PAUSEのみ状態に応じて色2(アクティブ)/3(非アクティブ)を切替。
// FADE/FF/REW/FLOPPYは常に同じ見た目(埋め込みパレット値のままblitCopy)。
export function drawTransportIcons(vram, { playing, stopped, paused }) {
  vram.blitColor(S_PLAY, PLAY_W, PLAY_X, PLAY_Y, PLAY_W, PLAY_H, playing ? COLOR_2 : COLOR_3);
  vram.blitColor(S_STOP, STOP_W, STOP_X, STOP_Y, STOP_W, STOP_H, stopped ? COLOR_2 : COLOR_3);
  vram.blitColor(S_PAUSE, PAUSE_W, PAUSE_X, PAUSE_Y, PAUSE_W, PAUSE_H, paused ? COLOR_2 : COLOR_3);
  vram.blitCopy(S_FADE, FADE_W, FADE_X, FADE_Y, FADE_W, FADE_H);
  vram.blitCopy(S_FF, FF_W, FF_X, FF_Y, FF_W, FF_H);
  vram.blitCopy(S_REW, REW_W, REW_X, REW_Y, REW_W, REW_H);
  vram.blitCopy(S_FLOPPY, FLOPPY_W, FLOPPY_X, FLOPPY_Y, FLOPPY_W, FLOPPY_H);
}

// 動的部分(枠内の値)をまとめて1フレームぶん描画する。
// SPECTRUM/LEVELの中身は含まない(drawSpectrumBars/drawLevelMeters参照)。
export function drawDynamic(vram, state) {
  drawPassedTime(vram, state.generatedFrames);
  drawClockCount(vram, state.timerbCnt);
  drawTimerBCycle(vram, state.timerb);
  drawLoopCount(vram, state.loopCnt);
  drawCpuFps(vram, state.cpuUsage, state.fps);
  drawLoopBar(vram, state);
  drawCircle(vram, state);
  drawTransportIcons(vram, state);
}

// --- SPECTRUM/LEVEL バー本体 ---
// データ源: docs/right-pane-data.md (wasm export)。
// ピーク保持・減衰の状態(生値の最大値+保持フレーム数+減衰ペース)は
// 「呼び出し側が持つ」(index.htmlがcreatePeakStateで作った状態オブジェクトを
// rAFを跨いで使い回す)。本モジュールの stepPeak/drawSpectrumBars/drawLevelMeters
// はその状態オブジェクトを受け取って書き換えるだけで、状態自体の所有権は
// 呼び出し側に残る。

// ピーク保持状態オブジェクトを作る。count個ぶんの3並列配列(Uint8Array)。
export function createPeakState(count) {
  return {
    data: new Uint8Array(count),    // 保持中のピーク値(0-31程度)
    cnt: new Uint8Array(count),     // ピーク保持フレーム数の残り(0-30)
    dropdiv: new Uint8Array(count), // 減衰までの追加ウェイト(PEAK_DROP_DIVTAB参照)
  };
}

// 1ch/1binぶんのピーク更新。fmdsp-pacc.c:1633-1653(fft)/1741-1750(level)相当。
// アルゴリズム(本家どおり、線形減衰に置き換えない):
//   新しい生値 >= 保持値: 保持値を更新しcnt=30にリセット(ピークホールド開始)
//   新しい生値 <  保持値: cntを1減算。cnt==0になったら
//     dropdivが残っていれば1減算するだけ(まだ減衰させない)。
//     dropdivが0ならPEAK_DROP_DIVTAB[保持値/2]をdropdivに入れ直し、保持値を1減算
//     (値が大きいほどdivtabの値が大きく=減衰が遅い、値が小さいほど速く減衰する)。
function stepPeak(state, index, raw) {
  if (state.data[index] <= raw) {
    state.data[index] = raw;
    state.cnt[index] = 30;
    return;
  }
  if (state.cnt[index]) {
    state.cnt[index]--;
    return;
  }
  if (!state.data[index]) return;
  if (state.dropdiv[index]) {
    state.dropdiv[index]--;
    return;
  }
  state.dropdiv[index] = PEAK_DROP_DIVTAB[Math.floor(state.data[index] / 2)];
  state.data[index]--;
}

// SPECTRUM(FFT)バー本体。fmdsp-pacc.c:1625-1659。
// rawBins: 長さFFTDISPLEN(=70)、各要素0-31(docs/right-pane-data.md §3、
//   fft/fft.h の `struct fmplayer_fft_disp_data` コメント "0-31, 4 per 6db" どおり)。
// peakState: createPeakState(FFTDISPLEN)で作った状態(呼び出し側が保持し続ける)。
//   この関数を呼ぶたびにpeakStateを1フレームぶん更新する。
export function drawSpectrumBars(vram, rawBins, peakState) {
  for (let x = 0; x < FFTDISPLEN; ++x) {
    const h = rawBins[x] || 0;
    // buf_horizontal_2_d相当: 生値バー(色2)。h===0のときは何も描かない
    // (fillRectにh*2=0を渡しても実質何も塗らないが、明示的にskipする)。
    if (h > 0) {
      vram.fillRect(SPECTRUM_X + x * 4, SPECTRUM_Y - 62 + (32 - h) * 2, 3, h * 2, COLOR_2);
    }
    stepPeak(peakState, x, h);
  }
  for (let x = 0; x < FFTDISPLEN; ++x) {
    const peak = peakState.data[x];
    if (peak > 0) {
      // buf_horizontal_7_d相当: ピーク保持ライン(色7、高さ1px)。
      vram.fillRect(SPECTRUM_X + x * 4, SPECTRUM_Y - peak * 2, 3, 1, COLOR_7);
    }
  }
}

// レベル生値(leveldata_read()の値、0が無音)を0-32段のバー高さへ変換する。
// 出典: fmdsp-pacc.c:1732-1734、docs/fmdsp-layout.md §4「データ源の対応表」
// (`20*log10(level/32768)`を48dBレンジ・32段で正規化)。この式は出典から
// そのまま転記したもので、独自の近似・線形化はしていない。
function levelToBars(rawLevel) {
  if (!rawLevel) return 0;
  const db = 20 * Math.log10(rawLevel / (1 << 15));
  const fllevel = (db / 48 + 1) * 32;
  // 本家: `unsigned llevel = 0; if (fllevel > 0.0f) llevel = fllevel;`
  // (float->unsigned代入は0方向切り捨て。fllevel>0なのでMath.floorで等価)。
  return fllevel > 0 ? Math.floor(fllevel) : 0;
}

// LEVELメーター(19ch)バー本体+PANPOT+PROG/KEY。fmdsp-pacc.c:1660-1805。
// levels: 長さFMDSP_LEVEL_COUNT(=19)の配列、各要素は
//   docs/right-pane-data.md §2 のflat_level_status 5フィールドをそのまま
//   { level, pan, prog, key, playing } という形にしたもの(wasm export由来の生値)。
// peakState: createPeakState(FMDSP_LEVEL_COUNT)で作った状態。
//
// 制約により本実装では省略している項目(出典未確認/データ未供給。捏造しない):
//   - masked(ミュート状態)はエクスポートされた5フィールドに含まれていない
//     (docs/right-pane-data.md §2の表を参照、maskedは記載なし)。このため
//     PANPOTは常に非マスク相当の色1で描く(fmdsp-pacc.c:1765-1769の
//     `masked ? buf_panpot_5_d : buf_panpot_1_d` のfalse分岐に相当)。
//   - RHYTHM(index 9)のPROG/KEYはB/S/T・H/T/R表示だが、元データが
//     opna->drum.drums[].playingで別経路(エクスポートされていない)のため
//     描画しない(依頼メモ「PROG/KEYは19ch中18ch分(RHYTHMを除く)」どおり)。
export function drawLevelMeters(vram, levels, peakState) {
  for (let c = 0; c < FMDSP_LEVEL_COUNT; ++c) {
    const entry = levels[c] || {};
    const llevel = levelToBars(entry.level || 0);
    if (llevel > 0) {
      // buf_horizontal_2_d相当: 生値バー(色2)。
      vram.fillRect(
        LEVEL_X + LEVEL_W * c, LEVEL_Y + (64 - llevel * 2),
        LEVEL_DISP_W, llevel * 2, COLOR_2
      );
    }
    stepPeak(peakState, c, llevel);
    const peak = peakState.data[c];
    if (peak > 0) {
      // buf_horizontal_7_d相当: ピーク保持ライン(色7、高さ1px)。
      vram.fillRect(
        LEVEL_X + LEVEL_W * c, LEVEL_Y + (62 - peak * 2),
        LEVEL_DISP_W, 1, COLOR_7
      );
    }

    // PANPOT。fmdsp-pacc.c:1765-1769。pan(0-5)をS_PANPOTの該当フレームへ。
    const pan = Number.isInteger(entry.pan) ? entry.pan : 5;
    const panSprite = S_PANPOT[pan] ?? S_PANPOT[5];
    vram.blitColor(
      panSprite, PANPOT_W,
      LEVEL_X + LEVEL_W * c - 1, PANPOT_Y, PANPOT_W, PANPOT_H,
      COLOR_1
    );

    if (c === 9) continue; // RHYTHM列: PROG/KEYは未供給データにつき描画しない

    // PROG(音色番号、3桁)。fmdsp-pacc.c:1770-1774の非RHYTHM分岐。
    const prog = entry.prog || 0;
    drawText(
      vram, SMALL_FONT, String(Math.max(0, Math.min(999, prog))).padStart(3, '0'),
      LEVEL_X + LEVEL_W * c, LEVEL_PROG_Y, COLOR_1
    );

    // KEY(現在鍵盤番号)。fmdsp-pacc.c:1793-1803。非再生時・オクターブ内
    // ノート番号(下位4bit)が12以上(=不正値)のときは"---"。
    const key = entry.key || 0;
    const oct = (key >> 4) & 0xff;
    const n = key & 0xf;
    const playing = !!entry.playing;
    const keyText = (playing && n < 12)
      ? String(Math.max(0, Math.min(999, oct * 12 + n))).padStart(3, '0')
      : '---';
    drawText(vram, SMALL_FONT, keyText, LEVEL_X + LEVEL_W * c, LEVEL_KEY_Y, COLOR_1);
  }
}

// LEVELのPANPOT/PROG/KEY枠だけ(データ非依存部分)を描いておきたい場合の
// 補助。本家は毎フレームstream系として描き直すため静的専用APIは無いが、
// 「枠だけ」要求に応え、色1のPANPOT基準スプライト(OFF相当=index5)を
// プレースホルダとして敷いておく。実データが来たら drawLevelMeters で
// 上書きすればよい。
export function drawLevelPlaceholders(vram) {
  for (let c = 0; c < FMDSP_LEVEL_COUNT; ++c) {
    vram.blitColor(
      S_PANPOT[5], PANPOT_W,
      LEVEL_X + LEVEL_W * c - 1, PANPOT_Y, PANPOT_W, PANPOT_H,
      COLOR_1
    );
  }
}

export {
  TIME_X, TIME_Y, CLOCK_Y, TIMERB_Y, LOOPCNT_Y, VOLDOWN_Y, PGMNUM_Y,
  CPU_X, CPU_Y, CPU_NUM_X, CPU_NUM_Y, FPS_X, FPS_NUM_X,
  SPECTRUM_X, SPECTRUM_Y, FFTDISPLEN,
  LEVEL_X, LEVEL_Y, LEVEL_W, LEVEL_DISP_W, PANPOT_Y, LEVEL_PROG_Y, LEVEL_KEY_Y,
  FMDSP_LEVEL_COUNT,
};
