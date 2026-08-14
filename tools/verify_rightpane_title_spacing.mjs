#!/usr/bin/env node
// タイトル行(drawTitle)の断片間隔を「開始X + 文字数×送り幅」の数値計算で検証する。
// 「はみ出しが減った」ではなく「9断片(+バージョン欄)が正しい位置に並び、
// 隣と重なっていない」ことを手計算コメントだけに頼らず機械的に確認するための
// スクリプト(2026-08-14 コーディネータ指示: フォント取り違え修正 + バージョン欄
// 仕様変更の両方を検証する)。
//
// 検証する2グループ:
//   (A) "MUSIC FILE SELECTOR & STATUS DISPLAY" の9断片。
//       fmdsp/rightpane.js の TOP_*_X 定数(fmdsp_sprites.h由来、上流と完全一致)と
//       SMALL_FONT(送り5px、フォント取り違え修正後の実際の値)を使って、
//       各断片の終端X = 開始X + 文字数*送り幅 が、次の断片の開始Xとの差で
//       「単語内(同じ単語の続き) = -1px(1px詰めて自然につながる)」
//       「単語間(別の単語) = +2px(空白ぶんの間隔)」になっていることを確認する。
//       この±の対応関係自体は upstream の観察結果(background節)から得た経験則で、
//       本スクリプトはそれが実際の座標定数と送り幅の組み合わせで成立していることを
//       計算で裏取りする。
//   (B) バージョン欄(YY.MM.DD、VER_0/1/2_X)。コーディネータ指示により
//       上流のX間隔(7px)から12px間隔に変更した箇所。2桁の数字部分(ピリオドは
//       upstream設計と同じ理由で計算に含めない、後述)が次のフィールド開始Xと
//       ぶつからないこと、最終フィールドがキャンバス右端(PC98_W=640)に
//       収まることを確認する。
//
// ピリオドを幅計算に含めない理由: upstream自体が「1文字+ピリオド」を
// 間隔7px(文字幅5pxより2px広いだけ)に詰め込む設計になっており(fmdsp_sprites.h:
// 126-128)、"元の文字1文字+ピリオド"=2文字*5px=10pxのうち3pxがそもそも次の
// セルへはみ出す前提でレイアウトされている(ピリオドのグリフ自体は5px幅セルの
// 左寄りにしか点が無く、視覚的な文字同士の重なりは起きない)。今回の変更は
// この「ピリオドは間隔計算に数えない」という upstream の比率をそのまま2桁化した
// ものなので、本チェックも同じ基準(数字部分のみ)で判定する。
//
// 故障注入: 送り幅を意図的に6px(修正前のMEDIUM_FONT相当)にすり替えて、
// 単語内の想定(-1px)が崩れる(隣の断片へめり込む)ことを確認してから、
// 実際の5pxで正常判定に戻す。常にPASSする検査は無効という要求への対応。

import { SmallFont, drawText } from '../fmdsp/font.js';
import { FONT_SMALL } from '../fmdsp/font_small.js';
import { PC98_W } from '../fmdsp/vram.js';

const REAL_FONT_W = new SmallFont(FONT_SMALL).w; // 5のはず(fmdsp/font_small.js)

// --- (A) タイトル9断片 ---
// x は fmdsp/rightpane.js の TOP_*_X 定数と同じ値(:56-66付近、fmdsp_sprites.h
// 109-119 の転記)。word は同じ単語なら同一ラベルにして判定に使う。
const TITLE_FRAGMENTS = [
  { text: 'MUS', x: 397, word: 'MUSIC' },
  { text: 'IC', x: 411, word: 'MUSIC' },
  { text: 'F', x: 423, word: 'FILE' },
  { text: 'ILE', x: 427, word: 'FILE' },
  { text: 'SELECTOR', x: 444, word: 'SELECTOR' },
  { text: '&', x: 486, word: '&' },
  { text: 'STATUS', x: 493, word: 'STATUS' },
  { text: 'D', x: 525, word: 'DISPLAY' },
  { text: 'ISPLAY', x: 529, word: 'DISPLAY' },
];

// --- (B) バージョン欄(2026-08-14仕様、YY.MM.DD) ---
// x は fmdsp/rightpane.js の VER_0/1/2_X (:93-95)。digits=2桁の数字部分だけを
// 幅計算対象にする(上記コメント参照)。
const VERSION_FIELDS = [
  { digits: 'YY', x: 576 },
  { digits: 'MM', x: 588 },
  { digits: 'DD', x: 600 },
];
// タイトル最終断片(ISPLAY)とバージョンアイコン(S_VER, VER_W=13px@TOP_VER_X=561)
// の間隔も一緒に確認する。
const TOP_ISPLAY_X = 529;
const ISPLAY_CHARS = 6;
const TOP_VER_X = 561;
const VER_W = 13;

function checkTitleFragments(fontW, { faultInject } = {}) {
  const results = [];
  let allOk = true;
  for (let i = 0; i < TITLE_FRAGMENTS.length - 1; ++i) {
    const cur = TITLE_FRAGMENTS[i];
    const next = TITLE_FRAGMENTS[i + 1];
    const end = cur.x + cur.text.length * fontW;
    const gap = next.x - end;
    const sameWord = cur.word === next.word;
    const expected = sameWord ? -1 : 2;
    const ok = gap === expected;
    if (!ok) allOk = false;
    results.push({
      from: cur.text, to: next.text, sameWord, end, nextX: next.x, gap, expected, ok,
    });
  }
  return { allOk, results };
}

function checkVersionFields(fontW) {
  const results = [];
  let allOk = true;
  // ISPLAY末尾 -> VERアイコン先頭(word境界+2pxの想定、アイコンだが同じ「区切り」扱い)
  {
    const end = TOP_ISPLAY_X + ISPLAY_CHARS * fontW;
    const gap = TOP_VER_X - end;
    const ok = gap === 2;
    if (!ok) allOk = false;
    results.push({ from: 'ISPLAY', to: 'VERアイコン', end, nextX: TOP_VER_X, gap, expected: 2, ok });
  }
  // VERアイコン -> VER_0_X (アイコン幅13px、+2pxの区切り想定)
  {
    const end = TOP_VER_X + VER_W;
    const gap = VERSION_FIELDS[0].x - end;
    const ok = gap === 2;
    if (!ok) allOk = false;
    results.push({ from: 'VERアイコン', to: VERSION_FIELDS[0].digits, end, nextX: VERSION_FIELDS[0].x, gap, expected: 2, ok });
  }
  // フィールド間(数字2桁ぶんのみで計算、ピリオドは数えない。上記コメント参照)
  for (let i = 0; i < VERSION_FIELDS.length - 1; ++i) {
    const cur = VERSION_FIELDS[i];
    const next = VERSION_FIELDS[i + 1];
    const end = cur.x + cur.digits.length * fontW;
    const gap = next.x - end;
    const ok = gap === 2;
    if (!ok) allOk = false;
    results.push({ from: cur.digits, to: next.digits, end, nextX: next.x, gap, expected: 2, ok });
  }
  // 最終フィールドがキャンバス右端(PC98_W)に収まるか
  const last = VERSION_FIELDS[VERSION_FIELDS.length - 1];
  const lastEnd = last.x + last.digits.length * fontW;
  const fits = lastEnd <= PC98_W;
  if (!fits) allOk = false;
  results.push({ from: last.digits, to: `canvas右端(${PC98_W})`, end: lastEnd, nextX: PC98_W, gap: PC98_W - lastEnd, expected: '>=0', ok: fits });
  return { allOk, results };
}

function printResults(label, { allOk, results }) {
  console.log(`--- ${label} ---`);
  for (const r of results) {
    const mark = r.ok ? 'OK' : 'NG';
    console.log(
      `  [${mark}] ${r.from}(end=${r.end}) -> ${r.to}(x=${r.nextX}): gap=${r.gap} (期待 ${r.expected})`
      + (r.sameWord !== undefined ? ` [${r.sameWord ? '単語内' : '単語間'}]` : ''),
    );
  }
  console.log(`  => ${allOk ? 'ALL OK' : 'FAIL'}`);
  return allOk;
}

// --- 故障注入: MEDIUM_FONT相当(送り6px)ですり替えて壊れることを確認 ---
const faultTitle = checkTitleFragments(6);
const faultOk = printResults('故障注入(送り6px, 修正前のMEDIUM_FONT相当)', faultTitle);
if (faultOk) {
  console.error('FATAL: 故障注入のはずが全断片OKになった。検査ロジックが機能していない。');
  process.exit(1);
}
console.log('  -> 期待通りFAILを検出(検査は機能している)。\n');

// --- 本番: 実際のSmallFont幅で検証 ---
if (REAL_FONT_W !== 5) {
  console.error(`FATAL: SmallFont(FONT_SMALL).w が想定(5)と異なる: ${REAL_FONT_W}`);
  process.exit(1);
}
const titleResult = checkTitleFragments(REAL_FONT_W);
const titleOk = printResults(`本番(送り${REAL_FONT_W}px, SMALL_FONT実測)`, titleResult);

const versionResult = checkVersionFields(REAL_FONT_W);
const versionOk = printResults(`バージョン欄(送り${REAL_FONT_W}px)`, versionResult);

// drawTextの実装(font.w刻みでcursorXを進める)が本チェックの前提と一致しているかも
// 実際にdrawTextを走らせて自己チェックする(前提のズレを検出するため)。
{
  const fakeVram = { blitColor() {} };
  const font = new SmallFont(FONT_SMALL);
  const endX = drawText(fakeVram, font, 'ILE', 427, 0, 2);
  const expectedEnd = 427 + 3 * REAL_FONT_W;
  if (endX !== expectedEnd) {
    console.error(`FATAL: drawText()の返り値(${endX})が想定終端(${expectedEnd})と食い違う。本チェックの前提(font.w刻み)が崩れている。`);
    process.exit(1);
  }
  console.log(`drawText()の実測終端(${endX})が想定と一致 -> 本チェックの前提は妥当。`);
}

console.log('');
if (titleOk && versionOk) {
  console.log('PASS: タイトル9断片とバージョン欄3フィールドの間隔がすべて想定通り(重なりなし)。');
  process.exit(0);
} else {
  console.error('FAIL: 間隔の想定と食い違う箇所がある。上記NG行を確認。');
  process.exit(1);
}
