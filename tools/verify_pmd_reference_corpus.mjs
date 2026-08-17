#!/usr/bin/env node
// PMD MML コンパイラ(compiler/pmd_mml_compiler.mjs)の回帰検証。
//
// tools/pmd-reference/ 配下の corpus(*.mml、自作・非対称データのみ)を自作コンパイラで
// コンパイルし、同ディレクトリの参照`.M`(PMD公式 MC.EXE ver 4.8s、`/V`オプション付きで
// 生成。詳細は tools/pmd-reference/README.md 参照)と突き合わせる。
//
// 比較ロジックは tools/compare_pmd_m.mjs をそのまま再利用する(パート単位のprefix一致)。
//
// 「現在の一致状態」を tools/pmd-reference/baseline.json に記録し、今回の実行結果と
// 突き合わせる:
//   - ベースラインより悪化したケースがあれば FAIL(コンパイル成功→失敗、一致パート数減少、
//     バイト一致率低下、完全一致→不一致 のいずれか)。
//   - 改善したケース(逆方向の変化)は FAIL にしない。baseline.json の更新を促す案内を出す。
//
// [陽性対照] 参照`.M`のうち1本を1byte壊したコピーを作り、そのケースが実際に
// 「悪化」として検出される(=検査ロジックが本当に不一致を見逃さない)ことを確認する。
// これが通らなければ、実データケースが全部PASSしていても検査自体が壊れている可能性がある
// ため、スクリプト全体を FAIL にする。
//
// 実データには一切依存しない(corpusはすべて自作・非対称データ)。
//
// 実行:
//   node tools/verify_pmd_reference_corpus.mjs
// ベースライン更新(改善を確認した後、意図的に):
//   node tools/verify_pmd_reference_corpus.mjs --update-baseline

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileMml } from '../compiler/pmd_mml_compiler.mjs';
import { decodeMmlBytes } from '../net/charset.js';
import { compareFiles, aggregateErrors } from './compare_pmd_m.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.join(__dirname, 'pmd-reference');
const BASELINE_PATH = path.join(CORPUS_DIR, 'baseline.json');

let passCount = 0;
let failCount = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${label}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

// --- corpus一覧の収集(*.mml があるものすべて) ---
function listCases() {
  return fs.readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.mml'))
    .map((f) => f.slice(0, -('.mml'.length)))
    .sort();
}

// 1ケースを評価する。refBytesOverride があれば参照.Mの代わりにそれを使う(陽性対照用)。
function evaluateCase(stem, { refBytesOverride } = {}) {
  const mmlPath = path.join(CORPUS_DIR, `${stem}.mml`);
  const refPath = path.join(CORPUS_DIR, `${stem}.M`);
  const mmlBytes = new Uint8Array(fs.readFileSync(mmlPath));
  const { text } = decodeMmlBytes(mmlBytes);
  const refBytes = refBytesOverride ?? new Uint8Array(fs.readFileSync(refPath));

  const { file: ownFile, errors } = compileMml(text, {});
  if (errors.length > 0) {
    const agg = aggregateErrors(errors);
    return {
      status: 'compile_error',
      errorCount: errors.length,
      errorFeatures: agg.map((e) => e.feature),
    };
  }
  const cmp = compareFiles(ownFile, refBytes);
  return {
    status: 'compared',
    identical: cmp.summary.totalParts > 0 && cmp.summary.matchedParts === cmp.summary.totalParts
      && cmp.summary.totalByteMatchRate === 1,
    matchedParts: cmp.summary.matchedParts,
    totalParts: cmp.summary.totalParts,
    byteMatchRate: cmp.summary.totalByteMatchRate,
  };
}

// current が baseline より「悪化」しているかどうかを判定する。
// 戻り値: null(悪化なし、同等含む) | 悪化理由の文字列
function regressionReason(baseline, current) {
  if (baseline.status === 'compared' && current.status === 'compile_error') {
    return `コンパイル成功(パート一致${baseline.matchedParts}/${baseline.totalParts})→失敗(${current.errorCount}件のエラー)`;
  }
  if (baseline.status === 'compile_error' && current.status === 'compile_error') {
    if (current.errorCount > baseline.errorCount) {
      return `エラー件数が増加(${baseline.errorCount}→${current.errorCount})`;
    }
    return null;
  }
  if (baseline.status === 'compile_error' && current.status === 'compared') {
    return null; // 失敗→成功は改善
  }
  // 両方 compared
  if (baseline.identical && !current.identical) {
    return '完全一致→不一致';
  }
  if (current.matchedParts < baseline.matchedParts) {
    return `一致パート数が減少(${baseline.matchedParts}→${current.matchedParts})`;
  }
  const baseRate = baseline.byteMatchRate ?? 0;
  const curRate = current.byteMatchRate ?? 0;
  if (curRate < baseRate - 1e-9) {
    return `総バイト一致率が低下(${(baseRate * 100).toFixed(2)}%→${(curRate * 100).toFixed(2)}%)`;
  }
  return null;
}

function improvementNote(baseline, current) {
  if (baseline.status === 'compile_error' && current.status === 'compared') {
    return 'コンパイル失敗→成功に改善';
  }
  if (baseline.status === 'compared' && current.status === 'compared') {
    if (!baseline.identical && current.identical) return '不一致→完全一致に改善';
    if (current.matchedParts > baseline.matchedParts) return `一致パート数が増加(${baseline.matchedParts}→${current.matchedParts})`;
    const baseRate = baseline.byteMatchRate ?? 0;
    const curRate = current.byteMatchRate ?? 0;
    if (curRate > baseRate + 1e-9) return `総バイト一致率が向上(${(baseRate * 100).toFixed(2)}%→${(curRate * 100).toFixed(2)}%)`;
  }
  return null;
}

function summaryLine(result) {
  if (result.status === 'compile_error') return `コンパイル失敗 ${result.errorCount}件のエラー`;
  return `パート一致 ${result.matchedParts}/${result.totalParts}、バイト一致率 ${((result.byteMatchRate ?? 0) * 100).toFixed(2)}%`
    + (result.identical ? '(完全一致)' : '');
}

// --- メイン ---
console.log('=== PMD MML コンパイラ 回帰検証(参照corpus) ===\n');

const cases = listCases();
check('corpusディレクトリに.mmlファイルが1本以上ある', cases.length > 0, `${cases.length}本`);

if (!fs.existsSync(BASELINE_PATH)) {
  console.log(`\n[FATAL] ベースラインファイルが見つかりません: ${BASELINE_PATH}`);
  process.exit(1);
}
const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));

const updateMode = process.argv.includes('--update-baseline');
const currentResults = {};
let anyImprovement = false;

console.log(`\n--- 実データケース(${cases.length}本) ---`);
for (const stem of cases) {
  const current = evaluateCase(stem);
  currentResults[stem] = current;
  const base = baseline.cases[stem];
  if (!base) {
    console.log(`[NEW]  ${stem}: ${summaryLine(current)} (ベースライン未登録。--update-baseline で登録してください)`);
    continue;
  }
  const reason = regressionReason(base, current);
  if (reason) {
    check(`${stem}: ベースラインからの悪化なし`, false, `${reason} / 現在=${summaryLine(current)}`);
  } else {
    const improved = improvementNote(base, current);
    if (improved) {
      anyImprovement = true;
      console.log(`[PASS] ${stem}: ${improved}(悪化ではないのでPASS扱い。ベースラインの更新を推奨) / 現在=${summaryLine(current)}`);
      passCount++;
    } else {
      check(`${stem}: ベースライン通り(悪化なし)`, true, summaryLine(current));
    }
  }
}

// --- [陽性対照] 参照.Mを1byte壊すと「悪化」として検出されることの確認 ---
//
// 注意: corpusの現状は自作コンパイラと参照.Mの一致がごく浅い(先頭数byteで早々に
// 乖離する)ケースが大半のため、機械的に決め打ったオフセットを壊しても「既にズレて
// いる範囲」を壊すだけでスコアが動かず、検出できて当然のはずが見逃す、という誤った
// 陰性対照になりかねない。そこで「現在マッチしている最後のprefixバイト」を実際の
// 比較結果(own vs 元のref)から動的に探し、そこを壊す(=検出できて然るべき最も厳しい
// 条件)。matchedLen>0のパートが1つも無いケースでは陽性対照そのものが成立しないため、
// 他のケースにフォールバックする。
console.log('\n--- [陽性対照] 参照.Mを1byteだけ壊した場合に悪化として検出されるか ---');
{
  function findMatchedByteTarget(stem) {
    const mmlPath = path.join(CORPUS_DIR, `${stem}.mml`);
    const refPath = path.join(CORPUS_DIR, `${stem}.M`);
    const { text } = decodeMmlBytes(new Uint8Array(fs.readFileSync(mmlPath)));
    const refBytes = new Uint8Array(fs.readFileSync(refPath));
    const { file: ownFile, errors } = compileMml(text, {});
    if (errors.length > 0) return null;
    const cmp = compareFiles(ownFile, refBytes);
    for (const [name, p] of Object.entries(cmp.parts)) {
      if (p.matchedLen > 0) {
        // パート先頭からの相対位置 -> ファイル絶対オフセットへ変換するため、
        // ヘッダのパートポインタ(相対オフセット)を使う。
        const rel = cmp.header.ref.partPointers[name];
        if (rel == null) continue;
        const absOffset = 1 + rel + (p.matchedLen - 1); // +1はopmFlag byte分
        if (absOffset < refBytes.length) return { refBytes, absOffset };
      }
    }
    return null;
  }

  let controlStem = null;
  let target = null;
  for (const s of cases) {
    if (baseline.cases[s]?.status !== 'compared') continue;
    target = findMatchedByteTarget(s);
    if (target) { controlStem = s; break; }
  }

  if (!target) {
    check('[陽性対照] 一致バイトを1つも持つケースが無いため陽性対照を実施できない', false, '全ケースがmatchedLen=0(corpus側の前提が崩れている)');
  } else {
    const { refBytes, absOffset } = target;
    const corrupted = refBytes.slice();
    corrupted[absOffset] ^= 0xff;
    check(
      '[陽性対照・前提] 壊す前とは実際に中身が変わっている',
      corrupted[absOffset] !== refBytes[absOffset],
    );

    const baselineForControl = baseline.cases[controlStem];
    const corruptedResult = evaluateCase(controlStem, { refBytesOverride: corrupted });
    const reason = regressionReason(baselineForControl, corruptedResult);
    check(
      `[陽性対照] ${controlStem} の参照.M(一致部分)を1byte壊すと悪化として検出される`,
      reason !== null,
      reason ?? '(検出されなかった。検査ロジックが壊れている可能性)',
    );

    // 健全性の再確認: 壊す前(オリジナル)は悪化として検出されない
    const originalResult = evaluateCase(controlStem);
    const originalReason = regressionReason(baselineForControl, originalResult);
    check(
      `[陽性対照・前提確認] ${controlStem} の壊す前の参照.Mは悪化として検出されない(比較ロジック自体は健全)`,
      originalReason === null,
    );
  }
}

if (updateMode) {
  const newBaseline = { generatedAt: new Date().toISOString(), cases: currentResults };
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(newBaseline, null, 2) + '\n');
  console.log(`\n[INFO] --update-baseline: ${BASELINE_PATH} を現在の結果で更新しました。`);
} else if (anyImprovement) {
  console.log('\n[案内] 改善したケースがあります。確認の上 `node tools/verify_pmd_reference_corpus.mjs --update-baseline` でベースラインを更新してください。');
}

console.log('\n---');
console.log(`${passCount} 件 PASS / ${failCount} 件 FAIL`);
if (failCount > 0) process.exit(1);
