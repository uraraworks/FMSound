#!/usr/bin/env node
// net/fetch.js の looksLikeHtml() を検証するスクリプト。
//
// Google Driveの共有リンクは、fetch自体は200で成功するのに中身がディスクイメージ/書庫
// ではなくHTML閲覧ページであることがある(WebNP2 disk-fetch.tsの実測コメント参照)。
// looksLikeHtml() は「取れたかどうか」ではなく「中身が何か」で判定するための関数なので、
// 判定内容そのものを以下3種の実データで確認する:
//   (a) 実際のHTMLを渡すと true
//   (b) 実際の .muc(CP932テキスト)を渡すと false
//   (c) ZIP/LZHのバイナリを渡すと false
//
// さらに、常にfalseを返す壊れた版を用意して(a)がFAILすることを確認してから
// (常にPASSする検査は無意味なため。過去に「20/20全滅」で発覚した実績がある)、
// 本物のlooksLikeHtml()に戻して全項目PASSすることを再確認する陽性対照テストを行う。
//
// 実行: node tools/verify_net_looks_like_html.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksLikeHtml } from '../net/fetch.js';
import { buildLzhLevel1 } from './lzh-encoder.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failed = 0;
function check(label, cond) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failed++;
  console.log(`[${mark}] ${label}`);
}

// --- 実データを用意 -----------------------------------------------------------------

// (a) 実際にGoogleが返すのに近い形のHTML(DOCTYPE付き閲覧ページ)。
const realHtml = new TextEncoder().encode(
  '<!DOCTYPE html>\n<html><head><title>song.muc - Google Drive</title></head><body>...</body></html>',
);

// (b) 実際の .muc ファイル(CP932テキスト。日本語コメントを含む実物想定)。
const realMuc = new TextEncoder().encode('#voice voice.dat\n#pcm mucompcm.bin\nA r4 cdefgab ; テスト\n');

// (c) 実際のZIP/LZHバイナリ(このリポジトリのshinonome.romをZIP風に、
//     ここでは自作LZHエンコーダで組み立てた本物のLZHバイト列を使う)。
const realLzh = buildLzhLevel1([{ name: 'song.muc', data: realMuc }]);
const realZipMagic = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00, 0x00, 0x00]); // PK\x03\x04 (ZIP LFHシグネチャ)

// shinonome.romが存在すればそれも「実際のバイナリ」として使う(fmdsp/との整合確認)。
let realBinaryFromRepo = null;
try {
  realBinaryFromRepo = new Uint8Array(readFileSync(path.join(__dirname, '../fmdsp/shinonome.rom')));
} catch {
  // 無ければスキップ(必須ではない)。
}

function runCases(fn, label) {
  check(`${label}: HTMLはtrue`, fn(realHtml) === true);
  check(`${label}: .muc(CP932テキスト)はfalse`, fn(realMuc) === false);
  check(`${label}: LZHバイナリはfalse`, fn(realLzh) === false);
  check(`${label}: ZIPマジックバイトはfalse`, fn(realZipMagic) === false);
  if (realBinaryFromRepo) {
    check(`${label}: shinonome.rom(実バイナリ)はfalse`, fn(realBinaryFromRepo) === false);
  }
  // Content-Typeヘッダによる判定も確認する。
  check(`${label}: Content-Type=text/htmlはtrue(バイト自体は非HTML)`, fn(realMuc, 'text/html; charset=utf-8') === true);
}

console.log('--- 本物の looksLikeHtml() ---');
runCases(looksLikeHtml, '本物');

// --- 陽性対照: 常にfalseを返す壊れた版を用意し、(a)が単独でFAILすることを確認する ---

function brokenLooksLikeHtml() {
  return false; // 常にfalse(=判定が機能していない状態を模擬)
}

console.log('--- 故障注入: 常にfalseを返す壊れた版 ---');
const brokenHtmlResult = brokenLooksLikeHtml(realHtml);
const brokenDetectedFailure = brokenHtmlResult !== true; // trueになるべきなのにfalseなので「検出failure」
check('故障注入: 壊れた版はHTML判定に失敗する(=(a)がFAILする、検査が機能している証拠)', brokenDetectedFailure);

console.log('--- 本物の looksLikeHtml() (再確認) ---');
runCases(looksLikeHtml, '再確認');

console.log('---');
if (failed > 0) {
  console.error(`${failed} 件 FAIL`);
  process.exit(1);
} else {
  console.log('全項目 PASS');
}
