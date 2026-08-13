#!/usr/bin/env node
// verify_sjis2jis.c (C本物) と cp932.js (JS移植) の sjis2jis() を全域比較する。
// 使い方:
//   node tools/compare_sjis2jis.mjs          通常検証
//   node tools/compare_sjis2jis.mjs --inject 故障注入(+1ズレ)で不一致検出を確認してから戻す
//
// 「自作実装を自作の相手役でテストしても誤解は検出できない」ため、片側は
// 必ずCコンパイラでビルドした本物のupstreamコードを使う(memory: feedback_selftest_both_sides_selfmade)。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sjisIsMbStart, sjis2jis } from '../pmdweb/html/fmdsp/cp932.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const inject = process.argv.includes('--inject');

// --- 1. C版をビルド・実行 ---
const workDir = mkdtempSync(join(tmpdir(), 'verify_sjis2jis-'));
const binPath = join(workDir, 'verify_sjis2jis');
execFileSync('cc', ['-std=c11', '-o', binPath, join(REPO_ROOT, 'tools/verify_sjis2jis.c')], {
  stdio: 'inherit',
});
const cOutput = execFileSync(binPath, [], { encoding: 'utf8' });
const cLines = cOutput.trim().split('\n');

// --- 2. JS版を同じ全域で計算 ---
let mismatches = [];
let checked = 0;
for (const line of cLines) {
  const [aHex, bHex, jisHexExpected] = line.split(' ');
  const a = parseInt(aHex, 16);
  const b = parseInt(bHex, 16);
  const expected = parseInt(jisHexExpected, 16);
  let actual = sjis2jis(a, b);
  if (inject) actual = (actual + 1) & 0xffff; // 故障注入: わざと+1ズラす
  checked++;
  if (actual !== expected) {
    mismatches.push({ a: aHex, b: bHex, expected: jisHexExpected, actual: actual.toString(16).padStart(4, '0') });
  }
}

// sjis_is_mb_start自体もJS版が同じ判定をしているか確認(Cの出力行数と
// JS側がtrueと判定する1st byte集合が一致するか)。
let mbStartMismatch = false;
for (let a = 0; a < 256; a++) {
  const cSaysStart = cLines.some((l) => parseInt(l.split(' ')[0], 16) === a);
  const jsSaysStart = sjisIsMbStart(a);
  if (cSaysStart !== jsSaysStart) {
    mbStartMismatch = true;
    console.error(`sjis_is_mb_start mismatch at 0x${a.toString(16)}: C(any 2nd-byte row present)=${cSaysStart} JS=${jsSaysStart}`);
  }
}

console.log(`checked ${checked} combinations (inject=${inject})`);
if (mismatches.length === 0 && !mbStartMismatch) {
  console.log(inject ? 'UNEXPECTED PASS (fault injection did not get caught!)' : 'PASS: sjis2jis matches C reference for all combinations');
  process.exit(inject ? 1 : 0);
} else {
  console.log(`FAIL: ${mismatches.length} mismatches` + (mbStartMismatch ? ' (+ sjis_is_mb_start mismatch)' : ''));
  for (const m of mismatches.slice(0, 10)) {
    console.log(`  1st=${m.a} 2nd=${m.b} expected=${m.expected} actual=${m.actual}`);
  }
  process.exit(inject ? 0 : 1);
}
