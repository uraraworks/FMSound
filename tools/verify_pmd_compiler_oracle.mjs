#!/usr/bin/env node
// tools/compare_pmd_m.mjs (PMD MMLコンパイラの差分オラクル)自体の検証。
//
// 書式はtools/verify_library.mjs(MCM_SAMPLE_ZIP未設定でSKIP)・tools/verify_d88.mjsに
// 合わせた: 実データ(第三者の楽曲)はリポジトリに置けないので、環境変数
// PMD_REF_PAIRS が渡されたときだけ実データ比較を行い、未設定ならその区画はSKIPする。
//
// PMD_REF_PAIRS の書式(カンマ区切りのペア列、各ペアは "MMLパス|参照.Mパス"):
//   PMD_REF_PAIRS="/path/a.mml|/path/a.M,/path/b.mml|/path/b.M" node tools/verify_pmd_compiler_oracle.mjs
//
// 実データ無しでも回る本体の検査:
//   [本体] compareFiles()が (a) 同一の`.M`同士を完全一致と報告する
//   [本体] compareFiles()が (b) 1byteだけ違う`.M`同士の最初の不一致位置を正しく指す
//   [本体] compareFiles()が (c) パート数が違う`.M`同士をヘッダ比較で判別できる
//   [本体] aggregateErrors()が既知のエラーメッセージを機能単位で正しく集計する
//   [陽性対照] 比較ロジックを「常に一致」に壊すと、(b)相当の検出が症状通りに
//              見逃す(検出できない)側になることを確認する
//
// 実データが渡された場合は比較結果を表示するだけ(現時点でエラーが出るのは想定通りなので
// FAIL扱いにしない)。ただし例外で落ちないことは検査する。
//
// 実行: node tools/verify_pmd_compiler_oracle.mjs
// (PMD_REF_PAIRSを付けると実データ区画も走る。単体では10分以内で終わる想定)

import {
  readHeader, computePartRegions, compareByteRanges, compareFiles, aggregateErrors, PART_NAMES,
} from './compare_pmd_m.mjs';
import { compileMml } from '../compiler/pmd_mml_compiler.mjs';
import { buildToneEntry, noteByte } from '../compiler/gen_pmd_min.mjs';
import { decodeMmlBytes } from '../net/charset.js';
import fs from 'node:fs';

let passCount = 0;
let failCount = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${label}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

// --- テスト用`.M`の手組み生成器 ---
// compiler/gen_pmd_min.mjs の buildMinimalPmdFile() (FM1固定)を、任意のパートindex
// (doc 1.2節の順、0=FM1...10=RHYTHM)へ一般化したもの。tools/verify_pmd_ppc_load.mjs等の
// 既存の手組み生成器と同じ発想(ヘッダを直接書き、他パートは全て空トラック0x1aへ)。
const HEADER_LEN = 0x1a;
const EMPTY_TRACK_OFF = HEADER_LEN;
function buildFileWithPartNote(partIndex, { octave = 4, noteIndex = 0, length = 24, tonenum = 1 } = {}) {
  const tone = buildToneEntry({ tonenum });
  const TRACK_OFF = EMPTY_TRACK_OFF + 1;
  const track = Uint8Array.from([0xff, tonenum & 0xff, noteByte(octave, noteIndex), length & 0xff, 0x80]);
  const TONE_OFF = TRACK_OFF + track.length;
  const relLen = TONE_OFF + tone.length;
  const rel = new Uint8Array(relLen);
  function w16(off, val) { rel[off] = val & 0xff; rel[off + 1] = (val >> 8) & 0xff; }
  for (let i = 0; i < 11; i++) w16(i * 2, i === partIndex ? TRACK_OFF : EMPTY_TRACK_OFF);
  w16(0x16, EMPTY_TRACK_OFF);
  w16(0x18, TONE_OFF);
  rel[EMPTY_TRACK_OFF] = 0x80;
  rel.set(track, TRACK_OFF);
  rel.set(tone, TONE_OFF);
  const file = new Uint8Array(1 + relLen);
  file[0] = 0;
  file.set(rel, 1);
  return file;
}

console.log('=== tools/compare_pmd_m.mjs 検証 ===\n');

// --- (a) 同一の`.M`同士 -> 完全一致 ---
{
  const fileA = buildFileWithPartNote(0); // FM1に音符1つ
  const result = compareFiles(fileA, fileA);
  check(
    '[本体](a) 同一の.M同士はパート一致数=全パート数、総バイト一致率=100%',
    result.summary.matchedParts === result.summary.totalParts
      && result.summary.totalParts === 1 // FM1のみ実データ
      && result.summary.totalByteMatchRate === 1,
    `matchedParts=${result.summary.matchedParts}/${result.summary.totalParts} rate=${result.summary.totalByteMatchRate}`,
  );
  check(
    '[本体](a) FM1パートが identical=true',
    result.parts.FM1.identical === true && result.parts.FM1.firstMismatchOffset === null,
  );
}

// --- (b) 1byteだけ違う`.M`同士 -> 最初の不一致位置を正しく指す ---
const fileA = buildFileWithPartNote(0, { length: 24 });
const fileB = fileA.slice(); // clone
// FM1トラックは rel 0x1b(=file index 0x1c)から [0xff, tonenum, noteByte, length, 0x80]。
// lengthバイト(トラック先頭から3byte目、file index 0x1c+3=0x1f)だけ書き換える。
const LENGTH_BYTE_FILE_INDEX = 0x1c + 3;
if (fileB[LENGTH_BYTE_FILE_INDEX] !== ((48) & 0xff)) fileB[LENGTH_BYTE_FILE_INDEX] = 48; else fileB[LENGTH_BYTE_FILE_INDEX] = 12;
{
  const result = compareFiles(fileA, fileB);
  const fm1 = result.parts.FM1;
  check(
    '[本体](b) 1byte差分は完全一致にならない',
    fm1.identical === false,
  );
  check(
    '[本体](b) 最初の不一致オフセットが正しい(パート先頭から3byte目=index3)',
    fm1.firstMismatchOffset === 3,
    `firstMismatchOffset=${fm1.firstMismatchOffset}`,
  );
  check(
    '[本体](b) 一致長が3byte(変更点の手前まで)',
    fm1.matchedLen === 3,
    `matchedLen=${fm1.matchedLen}`,
  );
}

// --- (c) パート数が違う`.M`同士 -> ヘッダ比較で判別できる ---
{
  const fileFm1 = buildFileWithPartNote(0); // FM1のみ
  const fileFm2 = buildFileWithPartNote(1); // FM2のみ
  const result = compareFiles(fileFm1, fileFm2);
  check(
    '[本体](c) FM1: own側に存在・ref側に存在しない',
    result.parts.FM1.ownPresent === true && result.parts.FM1.refPresent === false,
  );
  check(
    '[本体](c) FM2: own側に存在しない・ref側に存在する',
    result.parts.FM2.ownPresent === false && result.parts.FM2.refPresent === true,
  );
  check(
    '[本体](c) ヘッダのパートポインタ表がFM1/FM2で不一致と分かる',
    result.header.own.partPointers.FM1 !== result.header.ref.partPointers.FM1
      && result.header.own.partPointers.FM2 !== result.header.ref.partPointers.FM2,
  );
}

// --- エラー集計: 既知のエラーを含むMMLで機能単位の集計が期待どおりになる ---
{
  // Z: 未対応のパート指定(x1。K/Rは2026-08-18実装したため、未実装パート文字の
  // 例としては存在しない文字'Z'に差し替えた。PPZ8等の未解明パートは専用の
  // #ヘッダエラーで止まるため、単純な「未対応のパート指定」の例としては最も単純な
  // ダミー文字が適切)。A x: 未対応の文字'x'(x2)。A y: 未対応の文字'y'(x1)。
  const mml = ['Z c', 'A x', 'A x', 'A y'].join('\n');
  const { errors } = compileMml(mml, {});
  check('[本体] エラー集計テスト用MMLがちょうど4件のエラーを出す(前提の確認)', errors.length === 4, `errors=${errors.length}`);
  const agg = aggregateErrors(errors);
  const byFeature = Object.fromEntries(agg.map((e) => [e.feature, e.count]));
  check(
    "[本体] エラー集計: 未対応の文字'x'が2件にまとまる",
    byFeature["未対応の文字: 'x'"] === 2,
    JSON.stringify(byFeature),
  );
  check(
    "[本体] エラー集計: 未対応の文字'y'が1件",
    byFeature["未対応の文字: 'y'"] === 1,
  );
  check(
    "[本体] エラー集計: 未対応のパート指定'Z'が1件",
    byFeature["未対応のパート指定: 'Z'"] === 1,
    JSON.stringify(byFeature),
  );
  check(
    '[本体] エラー集計: 種類数が3種(4件が3機能にまとまる)',
    agg.length === 3,
    `agg=${JSON.stringify(agg)}`,
  );
}

// --- [陽性対照] 比較ロジックを「常に一致」に壊すと(b)相当の検出が症状通り見逃す ---
{
  // compareByteRanges を使わず、常に「完全一致」を返す壊れた比較関数(意図的な故障注入)。
  function brokenCompareByteRanges(ownBytes, refBytes) {
    return {
      ownLength: ownBytes.length,
      refLength: refBytes.length,
      matchedLen: ownBytes.length,
      identical: true, // 常に一致と嘘をつく
      firstMismatchOffset: null,
      contextOwn: null,
      contextRef: null,
    };
  }
  const headerA = readHeader(fileA);
  const headerB = readHeader(fileB);
  const regionsA = computePartRegions(headerA, fileA.length);
  const regionsB = computePartRegions(headerB, fileB.length);
  const relA = fileA.subarray(1);
  const relB = fileB.subarray(1);
  const ownBytes = relA.subarray(regionsA.FM1.start, regionsA.FM1.end);
  const refBytes = relB.subarray(regionsB.FM1.start, regionsB.FM1.end);

  // 健全性の再確認: 本物のcompareByteRangesは同じ入力に対してちゃんと不一致を検出する
  // (このブロックの前提が壊れていないことの確認。壊れているのはbrokenCompareByteRangesのみ)。
  const realResult = compareByteRanges(ownBytes, refBytes);
  check(
    '[陽性対照・前提確認] 本物のcompareByteRangesは1byte差分を検出する(壊す前の健全性)',
    realResult.identical === false && realResult.firstMismatchOffset === 3,
  );

  const brokenResult = brokenCompareByteRanges(ownBytes, refBytes);
  check(
    '[陽性対照] 比較ロジックを壊すと、実際には1byte差分があるのに"完全一致"と誤判定する'
      + '(=(b)の検出テストが症状通りにFAILする側を確認)',
    brokenResult.identical === true && brokenResult.matchedLen === ownBytes.length,
    `brokenResult.identical=${brokenResult.identical}`,
  );
}

console.log('\n--- 本体の検証はここまで ---\n');

// --- 実データ(あれば)での比較。無ければSKIP ---
const pairsEnv = process.env.PMD_REF_PAIRS;
if (!pairsEnv) {
  console.log('[SKIP] PMD_REF_PAIRS が未設定のため、実データでの比較をスキップします。');
  console.log('       (第三者の楽曲データのためリポジトリに同梱していない。手元のMML/参照.Mのパスを');
  console.log('        "MMLパス|参照.Mパス" のカンマ区切りで環境変数に渡すこと。tools/verify_library.mjs、');
  console.log('        tools/verify_d88.mjsと同じ作法)');
} else {
  const pairs = pairsEnv.split(',').map((s) => s.trim()).filter(Boolean).map((p) => {
    const [mml, ref] = p.split('|');
    return { mml, ref };
  });
  console.log(`[INFO] PMD_REF_PAIRS: ${pairs.length}組の実データ比較を行います。`);
  for (const { mml, ref } of pairs) {
    let threw = false;
    let summaryLine = '';
    try {
      const mmlBytes = new Uint8Array(fs.readFileSync(mml));
      const { text } = decodeMmlBytes(mmlBytes);
      const refBytes = new Uint8Array(fs.readFileSync(ref));
      const { file: ownFile, errors } = compileMml(text, {});
      if (errors.length > 0) {
        const agg = aggregateErrors(errors);
        summaryLine = `コンパイル失敗 ${errors.length}件のエラー / 機能単位${agg.length}種`;
      } else {
        const result = compareFiles(ownFile, refBytes);
        summaryLine = `パート一致 ${result.summary.matchedParts}/${result.summary.totalParts}、`
          + `バイト一致率 ${result.summary.totalByteMatchRate != null ? (result.summary.totalByteMatchRate * 100).toFixed(2) + '%' : 'n/a'}`;
      }
    } catch (e) {
      threw = true;
      summaryLine = `例外: ${e.message}`;
    }
    check(`[実データ] ${mml} は例外で落ちない`, !threw, summaryLine);
  }
}

console.log('\n---');
console.log(`${passCount} 件 PASS / ${failCount} 件 FAIL`);
if (failCount > 0) process.exit(1);
