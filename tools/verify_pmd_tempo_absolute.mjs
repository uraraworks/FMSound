#!/usr/bin/env node
// PMDテンポ(`t`/`T`)の絶対値検証。
//
// 背景(不具合報告): 同梱サンプル tools/sample_fur_elise.mml が「t100(テンポ100)なら
// 4分音符=0.6秒のはず」という想定で書かれていたが、実際は超高速で再生された。
// tools/verify_pmd_mml.mjs の既存テンポ検査は「Tを変えたら1tickのフレーム数が変わる」
// という*相対*確認のみで、「t100と書いたら実際に何秒鳴るか」という*絶対*値は
// 一度も検査していなかった。変換式が丸ごと間違っていても相対検査は通ってしまう。
//
// 実測で判明した原因(推測ではなく実測+一次資料で確定):
//   PMDMML.MAN §11-1「tコマンド」: 「C96(デフォルト)の状態では、２分音符＝(tempo値)」
//   つまり `t` が指定するのは *4分音符* のBPMではなく **2分音符のBPM**。
//   (出典: https://wikiwiki.jp/thtools/PMD%20version4.8%20コマンドマニュアル_3 §11-1。
//    WebFetchで全文取得し§11-1原文を確認済み。取得結果はエージェントの報告参照。)
//   よって 4分音符の実時間 = (60/tempo) / 2 = 30/tempo 秒 になる。
//   サンプルが前提にしていた「t100→4分音符0.6秒」は本来のPMD仕様上ありえず、
//   正しくは t100→4分音符0.3秒。「4分音符0.6秒」を得たいなら t50 が正しい。
//   これは98fmplayerドライバ(upstream、読み取り専用)自体の挙動であり、
//   本プロジェクトのコンパイラ/ドライバ側にバグは無かった。バグは
//   サンプルMML側の値の誤り(t100と書くべきでなかった)。
//
// 変換式の出典(すべて upstream/98fmplayer、読むだけ):
//   - `t`(テンポ絶対値) → TimerB: fmdriver_pmd.c:2369-2375 (pmd_cmdfc_tempo, val==0xffの分岐)
//     が pmd_calc_tempo_rev を呼ぶ。本体: fmdriver_pmd.c:356-368。
//       timerb = 0x112c / tempo;              // 0x112c = 4396
//       timerb = 0x100 - timerb;
//       if ((0x112c % tempo) & 0x80) timerb--;
//       if (timerb < 0) timerb = 0;
//   - TimerB値 → 1tickあたりの実フレーム数: libopna/opnatimer.c:5-9,74-114。
//     TIMERB_BITS=12, timerb_cnt は `timerb<<4` から `1<<12` までカウントするので、
//     1tick = (4096 - 16*timerb) 「サンプル」。ここでの「サンプル」は
//     opna_timer_mix() に渡す出力サンプル(=pmdweb/src/PmdCore.c の SAMPLE_RATE=55467Hz)と
//     直結している(opna_timer_mix_oscillo内でopna_mix_oscillo()にそのまま渡している)。
//   - 1tick(=timerB割り込み1回)ごとに `part->len_cnt--` が1回だけ実行される
//     (fmdriver_pmd.c:5120, pmd_part_proc_fm。呼び出し元 pmd_proc_parts は
//     pmd_timerb→pmd_timer→pmd_opna_interruptからtimerB割り込み1回につき1回呼ばれる、
//     fmdriver_pmd.c:5770-5786,5893-5906)。
//     つまり MML側の「クロック値」(96分音符単位、tools/pmd_mml_parser.mjsのMEAS_LEN=96)は
//     そのまま「tick数」であり、4分音符(96/4=24クロック)は24tick。
//
// 検証内容:
//   A. t(絶対値): t=60/100/150 それぞれで「4分音符に要する実フレーム数」を実測し、
//      上記の変換式から計算した理論値(整数演算、ドライバのコードをそのまま再現)と
//      *厳密一致*することを確認する(タイマーは整数カウンタなので誤差は出ない)。
//   B. Aの理論値が PMDMML.MAN の「2分音符=tempo値(1分間)」という仕様の帰結
//      (4分音符の実時間 = 30/tempo秒)と、整数丸め由来の誤差(数%)の範囲で一致することを確認する。
//      丸め誤差の上限は「timerb計算の整数除算で最大1ずれる」ことに由来し、
//      tempo=60/100/150の実測では0.4-1.1%だったため、余裕を持って許容誤差を3%とする。
//   C. [陽性対照] 「サンプルが元々前提にしていた誤った仕様」(4分音符=tempoのBPM、
//      つまり期待値60/tempo秒)を期待値として使うと、Bの許容誤差3%を大きく超えてFAILすることを確認する。
//   D. T(TimerB直接指定): T=50/120/250 で「1tickの実フレーム数」を実測し、
//      (4096-16*T) という理論値と*厳密一致*することを確認する(既存の相対検査を保ったまま追加)。
//   E. [陽性対照] Dで係数を故意に間違えた式(例: 8*(256-T)、係数を半分にした誤り)を使うと
//      FAILすることを確認する。
//
// 実行: node tools/verify_pmd_tempo_absolute.mjs

import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import { compileMml } from '../compiler/pmd_mml_compiler.mjs';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

const SAMPLE_RATE = 55467; // pmdweb/src/PmdCore.c: enum SAMPLE_RATE
const FIELD_COUNT = 26;
const FIELD = { playing: 0, ticks: 2, ticks_left: 3, key: 4 };
const SNAPSHOT_RING_SIZE = 2048;

function readTrack(Module, trackIndex) {
  const writeIndex = Module.getSnapshotWriteIndex() >>> 0;
  if (writeIndex === 0xffffffff || writeIndex === 0) return null;
  const entryBytes = Module.getSnapshotEntryByteSize();
  const ringPtr = Module.getSnapshotRingPointer();
  const idx = (writeIndex - 1) % SNAPSHOT_RING_SIZE;
  const base = ringPtr + idx * entryBytes;
  const trackBase = base + Module.getSnapshotHeaderWordCount() * 4 + trackIndex * FIELD_COUNT * 4;
  const words = new Int32Array(FIELD_COUNT);
  const base32 = trackBase / 4;
  for (let i = 0; i < FIELD_COUNT; i++) words[i] = Module.HEAP32[base32 + i];
  return words;
}

// --- 理論値の計算(ドライバのコードをそのまま再現。出典は上のコメント参照) ---
function tempoToTimerb(tempo) {
  // fmdriver_pmd.c:356-368 pmd_calc_tempo_rev
  let timerb = Math.floor(0x112c / tempo);
  timerb = 0x100 - timerb;
  if ((0x112c % tempo) & 0x80) timerb--;
  if (timerb < 0) timerb = 0;
  return timerb & 0xff;
}
function timerbToFramesPerTick(timerb) {
  // libopna/opnatimer.c:5-9,74-114 (TIMERB_BITS=12, timerb_cnt初期値=timerb<<4)
  return (1 << 12) - (timerb << 4);
}

const TONES = { 1: { tl: [0, 0, 0, 0], ar: [31, 31, 31, 31], rr: [7, 7, 7, 7], alg: 7, fb: 0 } };

// MML文字列を実際に再生し、keyの立ち上がり(edge)フレーム位置の列を返す。
async function measureEdges(mml, filename) {
  const { file, errors } = compileMml(mml, { tones: TONES });
  if (errors.length > 0) throw new Error(`compile failed: ${JSON.stringify(errors)}`);
  const Module = await createPmdWeb();
  Module.FS.writeFile(`/${filename}`, file);
  const err = Module.playMusic(`/${filename}`);
  if (err !== '') throw new Error(`playMusic failed: ${err}`);

  const STEP = 4;
  let frame = 0;
  let lastKey = null;
  const edges = [];
  for (let i = 0; i < 200000 && edges.length < 6; i++) {
    Module.renderFramesForTest(STEP);
    frame += STEP;
    const track = readTrack(Module, 0);
    if (!track) continue;
    const key = track[FIELD.key] & 0xff;
    if (key !== 0xff && key !== lastKey) {
      edges.push(frame);
      lastKey = key;
    }
  }
  return edges;
}

// t<tempo> c4 d4 c4 d4 ... を再生し、定常状態の「4分音符1個ぶんの実フレーム数」を返す
// (最初の1音は無音→発音の立ち上がりオフセットが乗るため、2音目以降の間隔を使う)。
async function measureQuarterNoteFrames(tempo) {
  const edges = await measureEdges(`A t${tempo} @1 o4 c4 d4 c4 d4 c4 d4`, `tabs_${tempo}.m`);
  if (edges.length < 4) return null;
  const diffs = [];
  for (let i = 2; i < edges.length; i++) diffs.push(edges[i] - edges[i - 1]);
  // 全て一致するはず(整数タイマーなので揺らぎは無い)。念のため中央値。
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

// T<timerb> c4 d4 ... を再生し、定常状態の「4分音符(24tick)ぶんの実フレーム数」を返す。
async function measureQuarterNoteFramesForT(timerb) {
  const edges = await measureEdges(`A T${timerb} @1 o4 c4 d4 c4 d4 c4 d4`, `Tabs_${timerb}.m`);
  if (edges.length < 4) return null;
  const diffs = [];
  for (let i = 2; i < edges.length; i++) diffs.push(edges[i] - edges[i - 1]);
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

async function main() {
  console.log('=== PMD テンポ(t/T) 絶対値検証 ===\n');

  // ---------------------------------------------------------------
  // A/B/C. t(絶対値)
  // ---------------------------------------------------------------
  console.log('--- A/B/C. t(テンポ絶対値) ---');
  const tempos = [60, 100, 150];
  const results = [];
  for (const tempo of tempos) {
    const measuredFrames = await measureQuarterNoteFrames(tempo);
    const timerb = tempoToTimerb(tempo);
    const framesPerTick = timerbToFramesPerTick(timerb);
    const theoreticalFrames = 24 * framesPerTick; // 4分音符 = 96/4 = 24 clock(tick)
    results.push({ tempo, measuredFrames, timerb, theoreticalFrames });
    check(`t${tempo}: 測定できた`, measuredFrames !== null, `frames=${measuredFrames}`);
    check(`t${tempo}: 実測フレーム数がドライバの変換式(fmdriver_pmd.c:356-368)から計算した理論値と厳密一致`,
      measuredFrames === theoreticalFrames,
      `measured=${measuredFrames} theoretical=${theoreticalFrames} (timerb=${timerb})`);

    const measuredSec = measuredFrames / SAMPLE_RATE;
    const expectedSecFromSpec = 30 / tempo; // PMDMML.MAN §11-1: 2分音符=tempo(1分間) → 4分音符はその半分の時間
    const relErr = Math.abs(measuredSec - expectedSecFromSpec) / expectedSecFromSpec;
    check(`t${tempo}: 実測秒数がPMDMML.MAN仕様(2分音符=tempoBPM→4分音符=30/tempo秒)の3%以内`,
      relErr <= 0.03,
      `measured=${measuredSec.toFixed(4)}s expected=${expectedSecFromSpec.toFixed(4)}s relErr=${(relErr * 100).toFixed(2)}%`);

    // 陽性対照: サンプルが元々前提にしていた誤った仕様(4分音符=tempoBPM、60/tempo秒)
    const wrongExpectedSec = 60 / tempo;
    const wrongRelErr = Math.abs(measuredSec - wrongExpectedSec) / wrongExpectedSec;
    check(`t${tempo}: [陽性対照] 誤った仕様想定(4分音符=tempoBPM=60/tempo秒)は3%許容を超えてFAILする`,
      wrongRelErr > 0.03,
      `measured=${measuredSec.toFixed(4)}s wrongExpected=${wrongExpectedSec.toFixed(4)}s relErr=${(wrongRelErr * 100).toFixed(2)}%`);
  }

  // ---------------------------------------------------------------
  // D/E. T(TimerB直接指定)
  // ---------------------------------------------------------------
  console.log('\n--- D/E. T(TimerB絶対値) ---');
  const timerbs = [50, 120, 250];
  for (const timerb of timerbs) {
    const measuredFrames = await measureQuarterNoteFramesForT(timerb);
    const framesPerTick = timerbToFramesPerTick(timerb);
    const theoreticalFrames = 24 * framesPerTick;
    check(`T${timerb}: 測定できた`, measuredFrames !== null, `frames=${measuredFrames}`);
    check(`T${timerb}: 実測フレーム数が理論値(4096-16*T、libopna/opnatimer.c)と厳密一致`,
      measuredFrames === theoreticalFrames,
      `measured=${measuredFrames} theoretical=${theoreticalFrames}`);

    // 陽性対照: 係数を半分にした誤り式(8*(256-T)ではなく16*(256-T)が正しい)
    const wrongTheoretical = 24 * (8 * (256 - timerb));
    check(`T${timerb}: [陽性対照] 係数を誤らせた式(8倍)とは一致しない`,
      measuredFrames !== wrongTheoretical,
      `measured=${measuredFrames} wrongTheoretical=${wrongTheoretical}`);
  }

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
