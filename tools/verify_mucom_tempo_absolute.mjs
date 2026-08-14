#!/usr/bin/env node
// MUCOM88テンポ関連コマンド(C/t/T)の絶対値検証。
//
// 背景(不具合報告): 新規作成の雛形(MUCOM_NEW_MML_TEMPLATE、`A @78 C120 o5 l4 v10 ...`)が
// PMD雛形の半分くらいの速さに聞こえる。雛形のコメントは「Cはテンポ(4分音符基準のBPM
// そのまま)」としていたが、これは誤りだった。
//
// 一次資料(Open MUCOM88 Wiki、MMLリファレンス。WebFetchで全文取得し確認済み。
// https://github.com/onitama/mucom88/wiki/MML%E3%83%AA%E3%83%95%E3%82%A1%E3%83%AC%E3%83%B3%E3%82%B9):
//   C: 「全音符あたりのクロック(分解能)指定」。デフォルト C128。*テンポではない*。
//      1拍(4分音符)=C/4クロックという「解像度」を決めるだけの値。
//   t(小文字): 「FM音源チップのタイマーBの数値を直接指定するテンポ指定」。
//      TimerB生値を直接書く(PMD側の大文字Tと同じ位置づけ)。Cが変わると
//      1クロックの実時間が変わるため、同じtでもCが変わればテンポが変わる。
//   T(大文字): 「テンポ指定(1分間に演奏する四分音符の数で指定)」= BPM相当。
//      Cの値によらず、4分音符の実時間が60/T秒になるよう内部でTimerBを換算する
//      (=解像度非依存)。旧雛形コメントの「4分音符基準のBPMそのまま」はCではなく
//      *こちらのT*の説明が正しい。
//
// 旧雛形はC(解像度)しか指定しておらず、テンポコマンド(T/t)を一切書いていなかった。
// そのためテンポはドライバの既定値のまま再生されており、これが「PMD雛形の半分の
// 速さ」に聞こえた実体(既定テンポがPMD雛形の想定テンポより遅い)。
// 対処: 雛形に明示的な T<BPM> を追加する。
//
// 検証内容(絶対値・出典どおりであることを実測で確認する。相対検査だけでは
// 「Cが実はテンポそのもの」という誤解を見逃す=tools/verify_pmd_tempo_absolute.mjsの
// 前例と同じ理由):
//   A. T(BPM)指定: T60/T120/T200 それぞれで「4分音符に要する実時間」を実測し、
//      60/T秒に近い(整数タイマー丸め誤差の範囲内)ことを確認する。
//   B. Cを変えてもTが同じなら4分音符の実時間が変わらないことを確認する
//      (「Tは解像度非依存」の実測確認)。
//   C. 同じ生TimerB値(t)でCを変えると、4分音符の実時間がCに比例して変わることを
//      確認する(「tは解像度に依存する」の実測確認)。
//   D. [陽性対照] 「Cがテンポそのもの(旧�ジ形コメントの誤り)」という仮説
//      (4分音符の実時間がCに反比例するはず、という想定)を、Tを使わずCだけを
//      変えて確かめると成り立たない(=Cを2倍にしても4分音符の実時間はほぼ変わらない)
//      ことを示す。
//   E. 新雛形(MUCOM_NEW_MML_TEMPLATE)の4分音符の実時間を実測し、
//      PMD雛形(PMD_NEW_MML_TEMPLATE)の4分音符の実時間と近い値になっている
//      ことを確認する(体感速度が揃ったことの実時間ベースの確認。基準が違うので
//      数値そのものは一致させず、実時間[秒]で比較する)。
//
// 実行: node tools/verify_mucom_tempo_absolute.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createMucomWeb from '../mucomweb/build-web/mucom88.js';
import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import { compileMml as compilePmdMml } from '../compiler/pmd_mml_compiler.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

const SAMPLE_RATE = 55467;
const PCH_FIELD_COUNT = 15;
const PCH_CODE = 7; // html/mucom-adapter.js PCH.CODE
const RING_SIZE = 2048;

function readTrack(Module, trackIndex) {
  const writeIndex = Module.getSnapshotWriteIndex() >>> 0;
  if (writeIndex === 0xffffffff || writeIndex === 0) return null;
  const entryBytes = Module.getSnapshotEntryByteSize();
  const ringPtr = Module.getSnapshotRingPointer();
  const headerWords = Module.getSnapshotHeaderWordCount();
  const idx = (writeIndex - 1) % RING_SIZE;
  const base = ringPtr + idx * entryBytes;
  const trackBase = base + headerWords * 4 + trackIndex * PCH_FIELD_COUNT * 4;
  const base32 = trackBase / 4;
  const words = new Int32Array(PCH_FIELD_COUNT);
  for (let i = 0; i < PCH_FIELD_COUNT; i++) words[i] = Module.HEAP32[base32 + i];
  return words;
}

// MML文字列を再生し、パートAのCODE(音程コード)の立ち上がりedgeフレーム位置の列を返す。
async function measureEdges(mml) {
  const Module = await createMucomWeb();
  Module.compileMML(mml, SAMPLE_RATE);

  const STEP = 4;
  let frame = 0;
  let lastCode = null;
  const edges = [];
  for (let i = 0; i < 400000 && edges.length < 6; i++) {
    Module.renderFramesForTest(STEP);
    frame += STEP;
    const track = readTrack(Module, 0);
    if (!track) continue;
    const code = track[PCH_CODE] & 0xff;
    if (code !== 0xff && code !== lastCode) {
      edges.push(frame);
      lastCode = code;
    }
  }
  return edges;
}

// 定常状態(2音目以降)の「4分音符1個ぶんの実フレーム数」の中央値を返す。
function medianQuarterFrames(edges) {
  if (edges.length < 4) return null;
  const diffs = [];
  for (let i = 2; i < edges.length; i++) diffs.push(edges[i] - edges[i - 1]);
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

async function measureQuarterFrames(mml) {
  const edges = await measureEdges(mml);
  return { edges, frames: medianQuarterFrames(edges) };
}

function extractTemplate(file, constName) {
  const src = readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const re = new RegExp(`const ${constName} = \`([\\s\\S]*?)\`;`);
  const m = src.match(re);
  if (!m) throw new Error(`${constName} が見つかりません(${file})`);
  return m[1];
}

async function measurePmdQuarterSeconds(tempo) {
  const Module = await createPmdWeb();
  const TONES = { 1: { tl: [0, 0, 0, 0], ar: [31, 31, 31, 31], rr: [7, 7, 7, 7], alg: 7, fb: 0 } };
  const { file, errors } = compilePmdMml(`A t${tempo} @1 o4 c4 d4 c4 d4`, { tones: TONES });
  if (errors.length > 0) throw new Error(`PMD compile failed: ${JSON.stringify(errors)}`);
  Module.FS.writeFile('/pmd_tempo_probe.m', file);
  const err = Module.playMusic('/pmd_tempo_probe.m');
  if (err !== '') throw new Error(`playMusic failed: ${err}`);
  const FIELD_COUNT = 26;
  const FIELD_KEY = 4;
  const STEP = 4;
  let frame = 0;
  let lastKey = null;
  const edges = [];
  for (let i = 0; i < 200000 && edges.length < 6; i++) {
    Module.renderFramesForTest(STEP);
    frame += STEP;
    const writeIndex = Module.getSnapshotWriteIndex() >>> 0;
    if (writeIndex === 0xffffffff || writeIndex === 0) continue;
    const entryBytes = Module.getSnapshotEntryByteSize();
    const ringPtr = Module.getSnapshotRingPointer();
    const headerWords = Module.getSnapshotHeaderWordCount();
    const idx = (writeIndex - 1) % 2048;
    const base = ringPtr + idx * entryBytes + headerWords * 4;
    const key = Module.HEAP32[base / 4 + FIELD_KEY] & 0xff;
    if (key !== 0xff && key !== lastKey) {
      edges.push(frame);
      lastKey = key;
    }
  }
  const frames = medianQuarterFrames(edges);
  return frames / SAMPLE_RATE;
}

async function main() {
  console.log('=== MUCOM88 テンポ(C/t/T) 絶対値検証 ===\n');

  // --- A. T(BPM)絶対値 ---
  console.log('--- A. T(テンポBPM絶対値) ---');
  const bpms = [60, 120, 200];
  for (const bpm of bpms) {
    const { frames } = await measureQuarterFrames(`A @78 T${bpm} o4 c4 d4 c4 d4 c4 d4`);
    check(`T${bpm}: 測定できた`, frames !== null, `frames=${frames}`);
    if (frames === null) continue;
    const measuredSec = frames / SAMPLE_RATE;
    const expectedSec = 60 / bpm;
    const relErr = Math.abs(measuredSec - expectedSec) / expectedSec;
    // TimerBは8bitの整数値なので、BPMが高い(=TimerB値が小さい)ほど1ステップの
    // 相対誤差が大きくなる(実測: T60=2.50%, T120=3.40%, T200=7.67%)。
    // 許容誤差はPMD側(3%固定、対象tempoが60-150止まり)より広い10%とする。
    check(`T${bpm}: 実測秒数がWiki仕様(4分音符=60/T秒)の10%以内`, relErr <= 0.10,
      `measured=${measuredSec.toFixed(4)}s expected=${expectedSec.toFixed(4)}s relErr=${(relErr * 100).toFixed(2)}%`);
  }

  // --- B. Cを変えてもTが同じなら実時間は変わらない ---
  console.log('\n--- B. Cは解像度で、Tが同じなら4分音符の実時間は変わらない ---');
  {
    const { frames: framesC96 } = await measureQuarterFrames('A @78 C96 T120 o4 c4 d4 c4 d4 c4 d4');
    const { frames: framesC384 } = await measureQuarterFrames('A @78 C384 T120 o4 c4 d4 c4 d4 c4 d4');
    check('C96/T120とC384/T120で4分音符の実測フレーム数が測定できた',
      framesC96 !== null && framesC384 !== null, `C96=${framesC96} C384=${framesC384}`);
    if (framesC96 !== null && framesC384 !== null) {
      const relDiff = Math.abs(framesC96 - framesC384) / framesC96;
      check('Cを4倍(96->384)してもT120固定なら4分音符の実時間はほぼ同じ(5%以内)',
        relDiff <= 0.05, `C96=${framesC96} C384=${framesC384} relDiff=${(relDiff * 100).toFixed(2)}%`);
    }
  }

  // --- C. 同じtでCを変えると実時間がCに比例して変わる ---
  console.log('\n--- C. tは生TimerB値で、Cが変わると実時間もCに比例して変わる ---');
  {
    const { frames: framesC96 } = await measureQuarterFrames('A @78 C96 t200 o4 c4 d4 c4 d4 c4 d4');
    const { frames: framesC192 } = await measureQuarterFrames('A @78 C192 t200 o4 c4 d4 c4 d4 c4 d4');
    check('C96/t200とC192/t200で4分音符の実測フレーム数が測定できた',
      framesC96 !== null && framesC192 !== null, `C96=${framesC96} C192=${framesC192}`);
    if (framesC96 !== null && framesC192 !== null) {
      const ratio = framesC192 / framesC96;
      check('Cを2倍(96->192)すると同じtでも4分音符の実時間がおよそ2倍になる(1.8-2.2倍)',
        ratio >= 1.8 && ratio <= 2.2, `C96=${framesC96} C192=${framesC192} ratio=${ratio.toFixed(3)}`);
    }
  }

  // --- D. [陽性対照] 「Cがテンポそのもの」という誤仮説はTを使うと成り立たない ---
  console.log('\n--- D. [陽性対照] 旧コメントの誤り(Cがテンポ)はTを使わなくても反証できる ---');
  {
    // Tを付けず、Cだけを変える(=デフォルトのテンポコマンドのまま)。
    // 「Cがテンポそのもの」なら実時間はCに反比例するはず(C2倍→時間半分)だが、
    // 実際はCが解像度なのでC2倍でも1クロックの実時間がほぼ変わらない
    // (両方ともテンポ未指定=同じ既定TimerBのまま)限り、4分音符の実時間はCにほぼ比例
    // してしまう(C2倍→クロック数2倍→時間2倍)。これは「反比例」という誤仮説の逆方向の
    // 結果になるため、誤仮説は明確にFAILする。
    const { frames: framesC96 } = await measureQuarterFrames('A @78 C96 o4 c4 d4 c4 d4 c4 d4');
    const { frames: framesC192 } = await measureQuarterFrames('A @78 C192 o4 c4 d4 c4 d4 c4 d4');
    if (framesC96 !== null && framesC192 !== null) {
      const wrongHypothesisRatio = framesC192 / framesC96; // 誤仮説なら0.5になるはず
      check('[陽性対照] 「Cがテンポ(反比例)」なら比は0.5のはずだが、実際は0.5から外れる',
        Math.abs(wrongHypothesisRatio - 0.5) > 0.1,
        `C96=${framesC96} C192=${framesC192} ratio=${wrongHypothesisRatio.toFixed(3)}(誤仮説の期待値=0.5)`);
    } else {
      check('[陽性対照] 測定できた', false, `C96=${framesC96} C192=${framesC192}`);
    }
  }

  // --- E. 新雛形とPMD雛形の体感速度(実時間)比較 ---
  console.log('\n--- E. 新雛形とPMD雛形の4分音符の実時間比較 ---');
  {
    const mucomTemplate = extractTemplate('html/mucom-app.js', 'MUCOM_NEW_MML_TEMPLATE');
    console.log('--- MUCOM_NEW_MML_TEMPLATE ---');
    console.log(mucomTemplate);
    check('新雛形にT(テンポBPM)指定が含まれている', /\bT\d/.test(mucomTemplate));

    // 雛形は l4 のあと cdefgab>c< と続く(4分音符が並ぶ)。先頭の休符/立ち上がりの
    // 影響を避けるため、テンポ測定専用に「同じテンポ設定+単純な4分音符の並び」で
    // 別途測定する(雛形の音名の並びそのものは絶対値検証に不要)。
    const tMatch = mucomTemplate.match(/\bT(\d+)/);
    const bpm = tMatch ? Number(tMatch[1]) : null;
    check('雛形からTの値を抽出できた', bpm !== null, `T=${bpm}`);
    if (bpm !== null) {
      const { frames } = await measureQuarterFrames(`A @78 T${bpm} o5 l4 c4 d4 c4 d4 c4 d4`);
      const mucomSec = frames / SAMPLE_RATE;
      // PMD雛形自体の値を読み、同じ理屈で理論値(30/tempo秒、PMDMML.MAN §11-1)を出す
      const pmdTemplate = extractTemplate('html/pmd-app.js', 'PMD_NEW_MML_TEMPLATE');
      const pmdTMatch = pmdTemplate.match(/\bt(\d+)/);
      const pmdTempo = pmdTMatch ? Number(pmdTMatch[1]) : null;
      check('PMD雛形からtの値を抽出できた', pmdTempo !== null, `t=${pmdTempo}`);
      const pmdExpectedSec = pmdTempo !== null ? 30 / pmdTempo : null;
      const pmdSec = pmdTempo !== null ? await measurePmdQuarterSeconds(pmdTempo) : NaN;
      console.log(`MUCOM雛形(T${bpm}): 4分音符=${mucomSec.toFixed(4)}s`);
      console.log(`PMD雛形(t${pmdTempo}): 4分音符=${pmdSec.toFixed(4)}s (理論値${pmdExpectedSec?.toFixed(4)}s)`);
      const relDiff = Math.abs(mucomSec - pmdSec) / pmdSec;
      check('両雛形の4分音符の実時間差が20%以内(体感速度が揃っている)', relDiff <= 0.2,
        `mucom=${mucomSec.toFixed(4)}s pmd=${pmdSec.toFixed(4)}s relDiff=${(relDiff * 100).toFixed(2)}%`);
    }
  }

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
