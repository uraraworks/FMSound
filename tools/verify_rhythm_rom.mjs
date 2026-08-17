#!/usr/bin/env node
// tools/gen_rhythm_rom.py が生成した8KBリズムROMの往復検証。
//
// 検証原則: 「自作エンコーダを自作デコーダで検証してはいけない」ため、復号側は
// upstream/98fmplayer/libopna/opnadrum.c の実物をccでビルドしたネイティブ
// ハーネス(tools/rhythm_rom_decode_harness.c)を使う。JS側では復号アルゴリズムを
// 一切再実装しない。
//
// 検証項目:
//  [本体]   6音それぞれの復号結果 vs リサンプル/トリム後の目標波形のRMS誤差
//  [本体]   6音が互いに異なる波形であること(資源の取り違え検出)
//  [陽性対照] ROMの特定領域を意図的にゼロで潰すと、その音の検査だけが落ちること
//  [決定論] gen_rhythm_rom.py を2回実行して同一バイト列になること
//
// 実行: node tools/verify_rhythm_rom.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const GEN_SCRIPT = path.join(REPO_ROOT, 'tools', 'gen_rhythm_rom.py');
const HARNESS_SRC = path.join(REPO_ROOT, 'tools', 'rhythm_rom_decode_harness.c');
const OPNADRUM_C = path.join(REPO_ROOT, 'upstream', '98fmplayer', 'libopna', 'opnadrum.c');
const OPNADRUM_INC = path.join(REPO_ROOT, 'upstream', '98fmplayer', 'libopna');

const SCRATCH = '/private/tmp/claude-501/-Users-haruurara-MyProject--emulator-PC98/efcc7436-b615-4158-b6b9-b184dca6519f/scratchpad';
const ROM_BIN = path.join(SCRATCH, 'rhythm_rom.bin');
const TARGETS_DIR = path.join(SCRATCH, 'rhythm_rom_targets');
const HARNESS_BIN = path.join(SCRATCH, 'rhythm_rom_decode_harness');
const DECODED_DIR = path.join(SCRATCH, 'decoded_verify');
const DECODED_FAULT_DIR = path.join(SCRATCH, 'decoded_verify_fault');
const ROM_RUN1 = path.join(SCRATCH, 'rhythm_rom_run1.bin');
const ROM_RUN2 = path.join(SCRATCH, 'rhythm_rom_run2.bin');
const ROM_FAULT = path.join(SCRATCH, 'rhythm_rom_fault_bd_zeroed.bin');

// opnadrum.h の領域定義(検証専用の陽性対照でBD領域を潰すために必要な最小限のコピー。
// 生成側 tools/gen_rhythm_rom.py の STARTS と同一の値。数値はopnadrum.hからの転記)
const BD_START = 0x0000;
const SD_START = 0x01c0; // BD領域の終端(潰す範囲の境界として使用)

const PARTS = [
  { name: 'BD', div: 3 },
  { name: 'SD', div: 3 },
  { name: 'TOP', div: 3 },
  { name: 'HH', div: 3 },
  { name: 'TOM', div: 6 },
  { name: 'RIM', div: 6 },
];

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', ...opts });
}

function buildHarness() {
  mkdirSync(SCRATCH, { recursive: true });
  run('cc', [
    '-std=c11', '-O2', '-Wall',
    '-I', OPNADRUM_INC,
    '-o', HARNESS_BIN,
    HARNESS_SRC, OPNADRUM_C,
  ]);
}

function decodeRom(romPath, outDir) {
  mkdirSync(outDir, { recursive: true });
  run(HARNESS_BIN, [romPath, outDir]);
  const out = {};
  for (const p of PARTS) {
    const buf = readFileSync(path.join(outDir, `${p.name}.i16`));
    const arr = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
    out[p.name] = arr;
  }
  return out;
}

function loadTarget(name) {
  const buf = readFileSync(path.join(TARGETS_DIR, `${name}.i16`));
  return new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
}

// 目標波形(1ニブル=1値)をdiv回複製して、復号後の出力サンプル列と同じ長さにする。
// (opnadrum.c: 1ニブルの復号値を part[].div 回連続でコピーする実装に合わせる)
function expandByDiv(target, div) {
  const out = new Float64Array(target.length * div);
  for (let i = 0; i < target.length; i++) {
    const v = target[i];
    for (let j = 0; j < div; j++) out[i * div + j] = v;
  }
  return out;
}

function rms(a, b) {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum / n);
}

function main() {
  let failed = false;

  console.log('=== 1. tools/gen_rhythm_rom.py を実行してROM/ターゲットを生成 ===');
  run('python3', [GEN_SCRIPT], { stdio: 'inherit' });

  console.log('\n=== 2. 決定論チェック(2回生成して同一バイト列か) ===');
  copyFileSync(ROM_BIN, ROM_RUN1);
  run('python3', [GEN_SCRIPT], { stdio: 'ignore' });
  copyFileSync(ROM_BIN, ROM_RUN2);
  const bin1 = readFileSync(ROM_RUN1);
  const bin2 = readFileSync(ROM_RUN2);
  const deterministic = bin1.equals(bin2);
  console.log(deterministic
    ? `PASS: 2回の生成結果が完全一致(${bin1.length} bytes)`
    : 'FAIL: 2回の生成結果が食い違った(非決定要素の疑い)');
  if (!deterministic) failed = true;

  console.log('\n=== 3. ネイティブ復号ハーネス(upstream/opnadrum.c本物)をビルド ===');
  buildHarness();
  console.log(`ビルド完了: ${HARNESS_BIN}`);

  console.log('\n=== 4. 本体復号 & RMS誤差評価 ===');
  const decoded = decodeRom(ROM_BIN, DECODED_DIR);

  // 閾値の根拠: このADPCM-Aは12bit差分積分(steps[]最大値1552を<<4した実効ステップ
  // 幅は約24832)を持つ適応符号化であり、量子化誤差はサンプルごとに最大でも
  // 概ね1ステップ相当(出力スケールで最大537程度、<<4後)に収まる設計。
  // 有意な誤差(=符号化の破綻や資源取り違え)ならRMSは数千〜1万超になる一方、
  // 正常な量子化誤差はfull-scale(32768)の数%程度に収まるはず、という考えで
  // 「RMS <= full-scaleの8%(=2621)」を閾値とした。これは実測値に後から
  // 合わせたものではなく、量子化ステップ幅の見積もりから先に決めている。
  const RMS_THRESHOLD = 32768 * 0.08; // 2621.44

  const results = [];
  for (const p of PARTS) {
    const target = loadTarget(p.name);
    const expanded = expandByDiv(target, p.div);
    const dec = decoded[p.name];
    const err = rms(expanded, dec);
    const effRate = 7987200 / 144 / p.div;
    const msActual = (dec.length / p.div) / effRate * 1000;
    const pass = err <= RMS_THRESHOLD && dec.length === expanded.length;
    results.push({ name: p.name, samples: dec.length, ms: msActual, rms: err, pass });
    console.log(
      `  ${p.name}: samples=${dec.length} (${msActual.toFixed(1)}ms) `
      + `RMS=${err.toFixed(1)} (閾値${RMS_THRESHOLD.toFixed(1)}) `
      + `len match=${dec.length === expanded.length} -> ${pass ? 'PASS' : 'FAIL'}`
    );
    if (!pass) failed = true;
  }

  console.log('\n=== 5. 6音の相互区別チェック(取り違え検出) ===');
  for (let i = 0; i < PARTS.length; i++) {
    for (let j = i + 1; j < PARTS.length; j++) {
      const a = decoded[PARTS[i].name];
      const b = decoded[PARTS[j].name];
      const n = Math.min(a.length, b.length);
      let sameCount = 0;
      for (let k = 0; k < n; k++) if (a[k] === b[k]) sameCount++;
      const sameRatio = n > 0 ? sameCount / n : 1;
      // 完全に同一素材を渡してしまった場合、長さも波形も一致するはず。
      // 長さが違う、または大部分(95%超)が一致しない限りは「別物」とみなす。
      const distinct = a.length !== b.length || sameRatio < 0.95;
      console.log(
        `  ${PARTS[i].name} vs ${PARTS[j].name}: len ${a.length}/${b.length}, `
        + `一致率=${(sameRatio * 100).toFixed(1)}% -> ${distinct ? 'PASS(別物)' : 'FAIL(同一疑い)'}`
      );
      if (!distinct) failed = true;
    }
  }

  console.log('\n=== 6. 陽性対照: BD領域をゼロ潰しして「その音だけ」検査が落ちることを確認 ===');
  const romBytes = Uint8Array.from(readFileSync(ROM_BIN));
  const faultRom = Buffer.from(romBytes);
  for (let i = BD_START; i < SD_START; i++) faultRom[i] = 0x00;
  writeFileSync(ROM_FAULT, faultRom);
  const decodedFault = decodeRom(ROM_FAULT, DECODED_FAULT_DIR);

  let faultOk = true;
  for (const p of PARTS) {
    const target = loadTarget(p.name);
    const expanded = expandByDiv(target, p.div);
    const dec = decodedFault[p.name];
    const err = rms(expanded, dec);
    const pass = err <= RMS_THRESHOLD;
    const expectFail = p.name === 'BD';
    const ok = expectFail ? !pass : pass;
    console.log(
      `  [故障注入後] ${p.name}: RMS=${err.toFixed(1)} `
      + `-> ${pass ? 'PASS' : 'FAIL'} (期待: ${expectFail ? 'FAILすべき' : 'PASSのまま'}) `
      + `${ok ? 'OK' : 'NG(検査が症状を検出できていない)'}`
    );
    if (!ok) faultOk = false;
  }
  if (!faultOk) {
    console.error('FAIL: 陽性対照が機能していない(BD破壊時にBDだけが落ちる、という前提が崩れた)');
    failed = true;
  } else {
    console.log('PASS: BD領域をゼロ潰しするとBDの検査だけが落ち、他は影響を受けないことを確認');
  }

  console.log('\n=== 結果 ===');
  if (failed) {
    console.error('FAIL: 検証項目に失敗があった。上記ログ参照。');
    process.exit(1);
  } else {
    console.log('PASS: すべての検証項目に合格');
  }
}

main();
