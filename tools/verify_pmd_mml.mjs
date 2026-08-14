#!/usr/bin/env node
// PMD MML コンパイラ v1 第2・3段階の検証。
// tools/pmd_mml_compiler.mjs でMML文字列から `.M` を生成し、pmdweb(98fmplayer wasm)へ
// ロードして実再生し、flat_track_status(pmdweb/src/PmdCore.c:37-43)を機械的に照合する。
// 作法・スナップショット読み出しは tools/verify_pmd_min.mjs を踏襲する。
//
// 検査項目(docs/pmd-compiler-spec.md 3.2節に対応):
//   1. 音程列: 代表的な音階を含むMMLの key 遷移列がコンパイラの意図通りか
//   2. 音長: 数値/付点/%指定それぞれで ticks(=part->len、生クロック値)が期待値と一致するか
//   3. テンポ: Tを変えたとき、1tickあたりの実フレーム数(ticks_leftの減少間隔)が実際に変わるか
//   4. ループ: [ ]n を展開した参照MML(手書きで繰り返しを書いたもの)と、
//      ループMMLの再生結果の key 遷移列が一致するか
//   5. タイ(&): flat_track_statusにはFM鍵盤(reg 0x28)への書き込み回数が直接出ていないため、
//      「キーオフ→キーオン(エンベロープ再アタック)があったか」を出力振幅の谷として観測する
//      (fmdriver_pmd.c:2084-2108 の解析: タイは次ノートのkeyon自体は抑止せず、
//      直前ノートの自然end時keyoffを抑止する。結果、タイ無しは各ノート境界でAR再アタックの
//      振幅の谷ができ、タイ有りはエンベロープが連続する。谷の深さ(区間内 min/max 比)を
//      タイの有無の判定指標として使う。
//
// 全項目に陽性対照(誤った期待値・誤ったラベルなら確実にFAILすること)を用意する。
//
// 実行: node tools/verify_pmd_mml.mjs

import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import { compileMml } from '../compiler/pmd_mml_compiler.mjs';
import { noteByte } from '../compiler/gen_pmd_min.mjs';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

const TRACK_FM1_INDEX = 0; // FMDRIVER_TRACK_FM_1 = 0 (fmdriver.h:9)。MMLコンパイラのパートAが対応する。
const FIELD_COUNT = 26; // PmdCore.c:23,37-43
const FIELD = {
  playing: 0, info: 1, ticks: 2, ticks_left: 3, key: 4, actual_key: 5,
  tonenum: 6, volume: 7, gate: 8, detune: 9,
};
const SNAPSHOT_RING_SIZE = 2048;

function readTrack(Module, trackIndex) {
  const writeIndex = Module.getSnapshotWriteIndex() >>> 0;
  if (writeIndex === 0xffffffff || writeIndex === 0) return null;
  const entryBytes = Module.getSnapshotEntryByteSize();
  const ringPtr = Module.getSnapshotRingPointer();
  const idx = (writeIndex - 1) % SNAPSHOT_RING_SIZE;
  const base = ringPtr + idx * entryBytes;
  const tracksBase = base + 4; // frame(uint32)の直後 = tracks[0]
  const trackBase = tracksBase + trackIndex * FIELD_COUNT * 4;
  const words = new Int32Array(FIELD_COUNT);
  const base32 = trackBase / 4;
  for (let i = 0; i < FIELD_COUNT; i++) words[i] = Module.HEAP32[base32 + i];
  return words;
}

// MML文字列を実際に再生し、細かい刻みでスナップショットを採り続ける。
// onChunk(i, absSumDelta, track) を各チャンクごとに呼ぶ。
async function play(mmlSource, filename, { chunkFrames = 32, maxChunks = 4000, tones, onChunk } = {}) {
  const { file, errors } = compileMml(mmlSource, { tones });
  if (errors.length > 0) {
    throw new Error(`compile failed: ${JSON.stringify(errors)}`);
  }
  const Module = await createPmdWeb();
  Module.FS.writeFile(`/${filename}`, file);
  const error = Module.playMusic(`/${filename}`);
  if (error !== '') throw new Error(`playMusic failed: ${error}`);

  // スナップショットリングがまだ1件も書かれていない最初の数チャンクは track が null になりうる。
  // ここで chunk を丸ごと読み飛ばすと、以降の onChunk が受け取る「チャンク番号 i」と
  // 実際に経過したフレーム数(i*chunkFrames)の対応が崩れる(タイ検査など、境界からの
  // 相対チャンク数で波形を突き合わせるテストが壊れる)。ダミー値(無音・休符相当)を
  // 埋めてでも呼び出し回数とフレーム経過を1対1に保つ。
  const dummyTrack = new Int32Array(FIELD_COUNT);
  dummyTrack[FIELD.key] = 0xff;
  dummyTrack[FIELD.actual_key] = 0xff;
  dummyTrack[FIELD.playing] = 1;

  for (let i = 0; i < maxChunks; i++) {
    const absSum = Module.renderFramesForTest(chunkFrames);
    const track = readTrack(Module, TRACK_FM1_INDEX) ?? dummyTrack;
    const stop = onChunk(i, absSum, track, i * chunkFrames);
    if (stop) break;
  }
  return { Module };
}

const TONES = { 1: { tl: [0, 0, 0, 0], ar: [31, 31, 31, 31], rr: [7, 7, 7, 7], alg: 7, fb: 0 } };
const NOTE_LETTERS = ['c', 'c+', 'd', 'd+', 'e', 'f', 'f+', 'g', 'g+', 'a', 'a+', 'b'];

// key(=(oct<<4)|note)の遷移列を記録する(休符0xffは除く、連続同値は畳み込む)。
async function recordKeySequence(mmlSource, { chunkFrames = 16, maxChunks = 6000 } = {}) {
  const seq = [];
  let lastKey = null;
  let sawPlayingFalseAfterSomeNote = false;
  await play(mmlSource, 'seq.m', {
    chunkFrames, maxChunks, tones: TONES,
    onChunk: (i, absSum, track) => {
      const key = track[FIELD.key] & 0xff;
      if (key !== 0xff && key !== lastKey) {
        seq.push(key);
        lastKey = key;
      }
      if (seq.length > 0 && track[FIELD.playing] === 0) {
        sawPlayingFalseAfterSomeNote = true;
        return true; // stop
      }
      return false;
    },
  });
  return { seq, ended: sawPlayingFalseAfterSomeNote };
}

async function main() {
  console.log('=== PMD MMLコンパイラ v1 第2・3段階 検証 ===\n');

  // ---------------------------------------------------------------
  // 1. 音程列: 代表的な音階(全96通りではなく低・中・高音域から代表36通り)
  // ---------------------------------------------------------------
  console.log('--- 1. 音程列 ---');
  const pitchOctaves = [0, 4, 7]; // 有効範囲は0-7(cmd<0x80制約。低・中・高音域の代表)
  let pitchMml = 'A @1 T250 o4 ';
  const expectedKeys = [];
  for (const oct of pitchOctaves) {
    pitchMml += `o${oct} `;
    for (let n = 0; n < 12; n++) {
      pitchMml += `${NOTE_LETTERS[n]}%4 `;
      expectedKeys.push(noteByte(oct, n));
    }
  }
  const { seq: pitchSeq, ended: pitchEnded } = await recordKeySequence(pitchMml);
  check('演奏が最後まで到達した(トラック終端0x80観測)', pitchEnded);
  check(
    `音程列が期待通り(${expectedKeys.length}音)`,
    pitchSeq.length === expectedKeys.length && pitchSeq.every((k, i) => k === expectedKeys[i]),
    `expected=${expectedKeys.map((k) => k.toString(16)).join(',')} actual=${pitchSeq.map((k) => k.toString(16)).join(',')}`
  );
  // 陽性対照: 1つだけわざと違う値にした期待列は一致しないはず
  const wrongExpected = expectedKeys.slice();
  wrongExpected[0] = (wrongExpected[0] + 1) & 0xff;
  check('[陽性対照] 意図的に1音だけ誤らせた期待列は一致しない',
    !(pitchSeq.length === wrongExpected.length && pitchSeq.every((k, i) => k === wrongExpected[i])));

  // ---------------------------------------------------------------
  // 2. 音長: 数値/付点/% 指定。各ノート先頭で ticks(=part->len) を照合
  // ---------------------------------------------------------------
  console.log('\n--- 2. 音長 ---');
  // c4 d8 e16 f%12 g4. → 期待クロック [24,12,6,12,36] (異なる音名で境界を判別する)
  const lengthMml = 'A @1 T250 o4 c4 d8 e16 f%12 g4.';
  const lengthNotes = ['c', 'd', 'e', 'f', 'g'];
  const expectedClocks = [24, 12, 6, 12, 36];
  const observedClocks = [];
  let lastLenKey = null;
  await play(lengthMml, 'len.m', {
    chunkFrames: 4, maxChunks: 20000, tones: TONES,
    onChunk: (i, absSum, track) => {
      const key = track[FIELD.key] & 0xff;
      if (key !== 0xff && key !== lastLenKey) {
        observedClocks.push(track[FIELD.ticks]);
        lastLenKey = key;
      }
      if (observedClocks.length >= expectedClocks.length) return true;
      return false;
    },
  });
  check(`音長(ticks)が期待通り: ${lengthNotes.join(',')}`,
    observedClocks.length === expectedClocks.length && observedClocks.every((c, i) => c === expectedClocks[i]),
    `expected=${expectedClocks.join(',')} actual=${observedClocks.join(',')}`);
  const wrongClocks = expectedClocks.slice();
  wrongClocks[2] = wrongClocks[2] + 1;
  check('[陽性対照] 1箇所わざと違う期待クロックにすると一致しない',
    !(observedClocks.length === wrongClocks.length && observedClocks.every((c, i) => c === wrongClocks[i])));

  // ---------------------------------------------------------------
  // 3. テンポ: Tを変えると1tickあたりの実フレーム数が変わるか
  // ---------------------------------------------------------------
  console.log('\n--- 3. テンポ ---');
  async function measureFramesPerTick(tValue) {
    const mml = `A @1 T${tValue} o4 c1`; // 全音符96クロック1個だけ
    const decrementFrames = [];
    let lastTicksLeft = null;
    await play(mml, `tempo_${tValue}.m`, {
      chunkFrames: 4, maxChunks: 30000, tones: TONES,
      onChunk: (i, absSum, track, frame) => {
        const key = track[FIELD.key] & 0xff;
        if (key === 0xff) return false; // まだ発音前
        const tl = track[FIELD.ticks_left];
        if (lastTicksLeft !== null && tl !== lastTicksLeft && tl < lastTicksLeft) {
          decrementFrames.push(frame);
        }
        lastTicksLeft = tl;
        if (decrementFrames.length >= 12) return true;
        return false;
      },
    });
    if (decrementFrames.length < 2) return null;
    const deltas = [];
    for (let i = 1; i < decrementFrames.length; i++) deltas.push(decrementFrames[i] - decrementFrames[i - 1]);
    deltas.sort((a, b) => a - b);
    return deltas[Math.floor(deltas.length / 2)]; // 中央値(境界ノイズを避ける)
  }
  const framesPerTickSlow = await measureFramesPerTick(50);
  const framesPerTickFast = await measureFramesPerTick(250);
  check('T=50 の frames/tick を測定できた', framesPerTickSlow !== null, `value=${framesPerTickSlow}`);
  check('T=250 の frames/tick を測定できた', framesPerTickFast !== null, `value=${framesPerTickFast}`);
  check('T=250(速い)の方がT=50(遅い)よりtickあたりのフレーム数が少ない(=実際に速く演奏される)',
    framesPerTickFast !== null && framesPerTickSlow !== null && framesPerTickFast < framesPerTickSlow,
    `slow(T=50)=${framesPerTickSlow}f/tick, fast(T=250)=${framesPerTickFast}f/tick, ratio=${(framesPerTickSlow / framesPerTickFast).toFixed(2)}`);
  check('[陽性対照] ラベルを取り違えた比較(速い方が遅いと誤って期待)は成立しない',
    !(framesPerTickFast !== null && framesPerTickSlow !== null && framesPerTickFast > framesPerTickSlow));

  // ---------------------------------------------------------------
  // 4. ループ: [ ]n を手動展開した参照と比較
  // ---------------------------------------------------------------
  console.log('\n--- 4. ループ ---');
  const loopedMml = 'A @1 T250 o4 [ c%4 d%4 ]3 e%4';
  const unrolledMml = 'A @1 T250 o4 c%4 d%4 c%4 d%4 c%4 d%4 e%4';
  const { seq: loopedSeq, ended: loopedEnded } = await recordKeySequence(loopedMml);
  const { seq: unrolledSeq } = await recordKeySequence(unrolledMml);
  check('ループ版の演奏が終端まで到達した', loopedEnded);
  check('ループ([c d]3 e)の音程列が手動展開(c d c d c d e)と一致',
    loopedSeq.length === unrolledSeq.length && loopedSeq.every((k, i) => k === unrolledSeq[i]),
    `looped=${loopedSeq.map((k) => k.toString(16)).join(',')} unrolled=${unrolledSeq.map((k) => k.toString(16)).join(',')}`);
  // 陽性対照: 回数を2にした展開(c d c d e)とは一致しないはず
  const wrongUnrolledMml = 'A @1 T250 o4 c%4 d%4 c%4 d%4 e%4';
  const { seq: wrongUnrolledSeq } = await recordKeySequence(wrongUnrolledMml);
  check('[陽性対照] ループ回数を誤らせた展開(2回)とは一致しない',
    !(loopedSeq.length === wrongUnrolledSeq.length && loopedSeq.every((k, i) => k === wrongUnrolledSeq[i])),
    `looped=${loopedSeq.map((k) => k.toString(16)).join(',')} wrongUnrolled=${wrongUnrolledSeq.map((k) => k.toString(16)).join(',')}`);

  // ---------------------------------------------------------------
  // 5. タイ(&): キーオン(エンベロープ+発振位相のリセット)の有無を波形の再現性で判定
  // ---------------------------------------------------------------
  console.log('\n--- 5. タイ(&) ---');
  // 出典解析: fmdriver_pmd.c:2084-2108 (pmd_part_fm_out) + 1456-1495(gate計算) + 5113-1128(mid-note gate check)。
  //   ノート処理直後に「次バイトが0xfb(タイ)か」を覗き見て、そうであれば
  //   keystatus.off_mask=true にする → 今回のノートの自然終了時keyoff(gate_abs既定0、
  //   len_cnt<=gate=0でのみ発火)が抑止される → 次ノートのkeyon書き込み(2097、実は常に
  //   発火するが)は「オフ→オン」の実質的な0->1遷移を伴わない(直前にオフを書いていないため)
  //   → OPNAのエンベロープジェネレータは再アタックせず、発振位相もリセットされない。
  //   一方タイ無しの場合は自然終了時に本物のkeyoff→次ノートのkeyonで確実に0->1遷移が起き、
  //   エンベロープ・位相とも完全リセットされる。
  // flat_track_status には keyon/keyoff の生回数(レジスタ書き込みログ)が無いため、
  // その帰結を「ノート境界の直後の波形が、曲頭の立ち上がり波形とビット単位で再現するか」
  // という形で観測する: 完全リセット(タイ無し)なら発振位相まで初期状態に戻るため
  // 曲頭と数十チャンクにわたり数値が一致するはずだが、タイ有り(エンベロープ・位相とも
  // 継続)ではそのような一致は起きない。境界検出は3節と同じ ticks_left の増加(新ノート
  // 読み込み)を使う。
  async function measureRetriggerSimilarity(mml, label) {
    const chunkFrames = 256;
    const amps = [];
    const tlHistory = [];
    await play(mml, `${label}.m`, {
      chunkFrames, maxChunks: 90, tones: TONES,
      onChunk: (i, absSum, track) => {
        amps.push(absSum);
        tlHistory.push(track[FIELD.ticks_left]);
        return false;
      },
    });
    let s0 = 0;
    while (s0 < amps.length && amps[s0] === 0) s0++;
    // 境界(2音目の開始)は「1音目が本当に鳴り始めた後(s0より十分後)で ticks_left が増加した
    // 最初の点」。s0直後はスナップショットリングがまだ空でダミー値(ticks_left=0)を経由する
    // ため、その立ち上がりを誤って境界と検出しないよう s0+5 以降だけを走査する。
    let boundary = null;
    for (let i = s0 + 5; i < tlHistory.length; i++) {
      if (tlHistory[i] > tlHistory[i - 1]) { boundary = i; break; }
    }
    const K = 25;
    if (boundary === null || s0 + 1 + K > amps.length || boundary + 1 + K > amps.length) {
      return { normSSE: null, amps, boundary, s0 };
    }
    const ref = amps.slice(s0 + 1, s0 + 1 + K); // 曲頭ノートの「立ち上がり直後」の波形パターン
    const seg = amps.slice(boundary + 1, boundary + 1 + K); // 2音目境界の直後の波形パターン
    const sse = ref.reduce((s, r, i) => s + (seg[i] - r) ** 2, 0);
    const refEnergy = ref.reduce((s, r) => s + r * r, 0);
    return { normSSE: refEnergy > 0 ? sse / refEnergy : null, amps, boundary, s0 };
  }
  const tiedMml = 'A @1 T250 o4 c1&c1'; // 同ピッチを2連結(タイ)
  const untiedMml = 'A @1 T250 o4 c1 c1'; // 同ピッチを2つ普通に並べる(毎回keyoff→keyon)
  const tied = await measureRetriggerSimilarity(tiedMml, 'tied');
  const untied = await measureRetriggerSimilarity(untiedMml, 'untied');
  check('タイあり(c1&c1)の境界波形の類似度(normSSE)を測定できた', tied.normSSE !== null, `normSSE=${tied.normSSE}`);
  check('タイなし(c1 c1)の境界波形の類似度(normSSE)を測定できた', untied.normSSE !== null, `normSSE=${untied.normSSE}`);
  check('タイなしの2音目境界は曲頭の立ち上がり波形をほぼ完全に再現する(=本物のkeyoffの後にkeyonが起きた証拠)',
    untied.normSSE !== null && untied.normSSE < 0.02,
    `normSSE=${untied.normSSE?.toFixed(6)}`);
  check('タイありは同じ境界で曲頭ほどの再現をしない(=エンベロープ・位相が継続し、真のkeyoffが起きていない証拠)',
    tied.normSSE !== null && untied.normSSE !== null && tied.normSSE > untied.normSSE,
    `tied normSSE=${tied.normSSE?.toFixed(6)} untied normSSE=${untied.normSSE?.toFixed(6)}`);
  check('[陽性対照] ラベルを取り違えた比較(タイの方が再現度が高いと誤って期待)は成立しない',
    !(tied.normSSE !== null && untied.normSSE !== null && tied.normSSE < untied.normSSE));

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
