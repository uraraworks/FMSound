#!/usr/bin/env node
// tools/gen_version.py が「壁時計を使わず、同じコミットからは常に同じ文字列を
// 生成する」ことを検証する(2026-08-14 コーディネータ指示:
// 「同じコミットで2回ビルドし、生成されたバージョン文字列が完全に一致すること」)。
//
// 手順: gen_version.py を間に1秒以上の待ち(壁時計を使っていたら値が変わる程度の
// 間隔)を挟んで2回実行し、生成された ui/version.js の中身が完全一致するか比較する。
// 一致しなければ壁時計(またはその他の非決定要素)を使っている疑いがあるためFAIL。
//
// 故障注入: 意図的に現在時刻を埋め込む「壊れたgen_version」を模した生成関数を
// 用意し、この検査が実際に差分を検出できることを先に確認してから、本物の
// gen_version.pyを検証する(常にPASSする検査は無効、という要求への対応)。

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const VERSION_JS = path.join(REPO_ROOT, 'ui', 'version.js');
const GEN_SCRIPT = path.join(REPO_ROOT, 'tools', 'gen_version.py');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- 故障注入: 壁時計を使う「壊れた生成」を模擬し、検査がFAILを検出できるか確認 ---
function faultInjectedGenerate() {
  const now = new Date().toISOString();
  writeFileSync(VERSION_JS, `export const FMSOUND_VERSION_FOOTER = ${JSON.stringify(now)};\n`);
}

async function main() {
  faultInjectedGenerate();
  const faultRun1 = readFileSync(VERSION_JS, 'utf8');
  await sleep(1100);
  faultInjectedGenerate();
  const faultRun2 = readFileSync(VERSION_JS, 'utf8');
  if (faultRun1 === faultRun2) {
    console.error('FATAL: 故障注入(壁時計使用)のはずが2回とも一致した。検査ロジックが機能していない。');
    process.exit(1);
  }
  console.log('[故障注入] 壁時計版は1.1秒間隔で実行すると内容が変わることを確認(検査は機能している)。');

  // --- 本番: tools/gen_version.py を2回実行して比較 ---
  execFileSync('python3', [GEN_SCRIPT], { cwd: REPO_ROOT, stdio: 'inherit' });
  const run1 = readFileSync(VERSION_JS, 'utf8');
  await sleep(1100);
  execFileSync('python3', [GEN_SCRIPT], { cwd: REPO_ROOT, stdio: 'inherit' });
  const run2 = readFileSync(VERSION_JS, 'utf8');

  if (run1 !== run2) {
    console.error('FAIL: tools/gen_version.py の出力が2回の実行で食い違った(壁時計等の非決定要素の疑い)。');
    console.error('--- run1 ---\n' + run1);
    console.error('--- run2 ---\n' + run2);
    process.exit(1);
  }

  if (!/FMSOUND_VERSION_OK = true/.test(run1)) {
    console.error('FAIL: FMSOUND_VERSION_OK が true ではない(git情報の取得に失敗している可能性)。');
    console.error(run1);
    process.exit(1);
  }

  console.log('[本番] tools/gen_version.py を1.1秒間隔で2回実行し、出力が完全一致した:');
  console.log(run1);
  console.log('PASS: 同じコミットからのビルドは常に同じバージョン文字列になる(壁時計不使用)。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
