#!/usr/bin/env node
// tools/pmd-reference/ corpus の回帰検証: 各 .mml の #Title 行と、対応する参照.M
// (PMD公式 MC.EXE 実測物)に埋め込まれた曲名文字列が一致しているかを確認する。
//
// 背景: pmdff1 で発覚した事故。参照.Mを生成した後に.mmlのタイトル行だけが書き換えられ、
// ペアの対応が壊れていた(参照.M側は`FFTest2`のままなのに.mml側は`Corpus FFFile Priority`に
// なっており、その15文字ぶんが丸ごとバイトずれとして「コンパイラのバグ」に見えていた)。
// 参照.Mは実測物なので後から作り直せない。.mmlを編集したときに参照.Mを再生成し忘れると
// 静かにペアが壊れる。この検証はその再発を検出する。
//
// 判定方法: #Title の値を encodeCp932 でバイト列化し、参照.M中に(タイトルテーブルの
// null終端を挟んだ形で)そのまま含まれているかを探す。#Titleが無いケースはスキップする
// (タイトル自体を検証対象にしていないケースのため)。
//
// [陽性対照] pmdff1 のペアを意図的に「事故が起きた直後の状態」(参照.Mはそのまま、
// .mmlのタイトルだけ長い別文字列に差し替え)にコピーし、このスクリプトの検出ロジックが
// 実際に不一致として検出することを確認する。
//
// 実行:
//   node tools/verify_pmd_reference_title_sync.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeCp932 } from '../compiler/cp932.mjs';
import { decodeMmlBytes } from '../net/charset.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.join(__dirname, 'pmd-reference');

let passCount = 0;
let failCount = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${label}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

function extractTitle(mmlText) {
  const m = mmlText.match(/^#Title[ \t]+(.+?)\s*$/m);
  return m ? m[1] : null;
}

// 参照.M中にタイトルのバイト列がヌル終端(前後どちらかにも0x00が来る想定)で
// 含まれているかを確認する。単純な部分文字列検索(indexOf)で十分:
// タイトルテーブルはascii範囲でこれほど長い一致が他の目的で偶然生じることはまず無い。
function titleFoundInRef(refBytes, titleBytes) {
  if (titleBytes.length === 0) return true; // 空タイトルは検証対象外
  const hay = Buffer.from(refBytes);
  const needle = Buffer.from(titleBytes);
  return hay.indexOf(needle) !== -1;
}

function listCases() {
  return fs.readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.mml'))
    .map((f) => f.slice(0, -('.mml'.length)))
    .sort();
}

console.log('=== PMD corpus: #Title と参照.M埋め込み曲名の対応チェック ===\n');

const cases = listCases();
let checkedCount = 0;
let skippedCount = 0;

for (const stem of cases) {
  const mmlPath = path.join(CORPUS_DIR, `${stem}.mml`);
  const refPath = path.join(CORPUS_DIR, `${stem}.M`);
  if (!fs.existsSync(refPath)) {
    console.log(`[SKIP] ${stem}: 参照.Mが無い`);
    skippedCount++;
    continue;
  }
  const { text } = decodeMmlBytes(new Uint8Array(fs.readFileSync(mmlPath)));
  const title = extractTitle(text);
  if (title === null) {
    skippedCount++;
    continue;
  }
  const { bytes: titleBytes } = encodeCp932(title);
  const refBytes = new Uint8Array(fs.readFileSync(refPath));
  checkedCount++;
  check(`${stem}: #Title "${title}" が参照.Mに含まれる`, titleFoundInRef(refBytes, titleBytes));
}

console.log(`\n(${checkedCount}件チェック、${skippedCount}件スキップ(#Title無し/参照.M無し))`);

// --- [陽性対照] 事故が起きた直後の状態を模した組を作り、検出できることを確認 ---
console.log('\n--- [陽性対照] .mmlのタイトルだけ書き換わった壊れたペアを検出できるか ---');
{
  const refBytes = new Uint8Array(fs.readFileSync(path.join(CORPUS_DIR, 'pmdff1.M')));
  const brokenTitle = 'Corpus FFFile Priority'; // 事故発生時に実際に.mmlに入っていた値
  const { bytes: brokenTitleBytes } = encodeCp932(brokenTitle);
  const detected = !titleFoundInRef(refBytes, brokenTitleBytes);
  check('壊れたペア(タイトル不一致)が実際に検出される', detected);

  const { bytes: correctTitleBytes } = encodeCp932('FFTest2');
  const notFlagged = titleFoundInRef(refBytes, correctTitleBytes);
  check('[陽性対照・前提確認] 修復後の正しいペアは誤検出されない', notFlagged);
}

console.log(`\n${passCount} 件 PASS / ${failCount} 件 FAIL`);
process.exit(failCount > 0 ? 1 : 0);
