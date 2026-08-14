#!/usr/bin/env node
// MUCOM88 の PCHDATA (mucomweb/src/MucomWeb.cpp の StatusSnapshot / TrackStatus) に
// 積まれている各フィールドの意味を、既知の MML を鳴らして実測で確定する。
//
// 背景: PMD 側の flat_track_status.key は (octave<<4)|notenum、0x?F=休符 という
// 既知のスキーマを持つ。MUCOM 側の code/fnum1/fnum2 がどう対応するかは Z80 ドライバの
// asm(フォーク側では空ファイル)を読めないため不明。よって推測ではなく実測で決める。
//
// 手法: Node から wasm(mucomweb/build-web/mucom88.js)を直接ロードし、
//   1. Module.compileMML(mml, sampleRate) で MML をコンパイル・演奏開始
//   2. Module.audioWorkletRequest(requestedFrames, generation, requestId) を
//      手動で呼んでレンダリングを進める(ブラウザの AudioWorklet が無い Node では
//      StreamingPlayer::Play() 内の AudioContext 生成が失敗し自動では回らないため)。
//      generation は StreamingPlayer::_generation の値と一致しないと
//      Process() が early-return して何も進まない。C++ 側を読むと
//      CompileMML() は「(g_player新規なら construct) → 明示 Stop() → (成功時)
//      Play()内部Stop()」で毎回 2 ずつ増える。fresh instance であれば
//      1回目の compile 後は必ず generation=2 になる(実測で確認済み)。
//      本スクリプトは全テストで createMucomWeb() を毎回新規に呼ぶため、
//      常に generation=2 固定でよい。
//   3. Module.getChannelData() で全11chの現在値を読む(スナップショットリングでなく
//      「今の」値を返す既存export。単発の音程確認にはこちらで十分に働くことを確認済み)。
//
// 注意(実測で判明した罠。書き方の参考にする側はここも読むこと):
//   - FM/SSGとも @<voice> を明示しないと(デフォルト音色のまま)ドライバが
//     PCHDATAを一切更新しない(常に全0)。voice省略は「鳴らない」ケースなので
//     全テストで @1 を付ける。
//   - コンパイル直後に少数フレームだけレンダリングしても PCHDATA は更新されない。
//     実測で 8192フレーム(44100Hz, 約186ms)では毎回0、14336フレームでも
//     まだ0、16384フレーム(約372ms)から確実に値が入ることを確認した。
//     安全マージンを見て本スクリプトは 20480フレーム(約464ms)を既定にする。
//   - wasm側のC++は変更していない。既存exportのみで測定した。
//
// 実行: node tools/probe_mucom_pchdata.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import createMucomWeb from '../mucomweb/build-web/mucom88.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = path.join(__dirname, '../mucomweb/build-web');
const SAMPLE_MUC = path.join(BUILD_DIR, 'sampl1.muc');

const SAMPLE_RATE = 44100;
const SAFE_FRAMES = 20480; // 実測で確実にPCHDATAが更新される最小マージン(約464ms)

const NOTE_NAMES = ['c', 'c+', 'd', 'd+', 'e', 'f', 'f+', 'g', 'g+', 'a', 'a+', 'b'];

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

async function probe(mml, frames = SAFE_FRAMES) {
  const Module = await createMucomWeb();
  const err = Module.compileMML(mml, SAMPLE_RATE);
  // fresh instance なら1回目のcompile後は必ずgeneration=2になる(実測で確認済み)。
  Module.audioWorkletRequest(frames, 2, 1);
  const channels = Module.getChannelData();
  return { Module, err, channels };
}

function fmtCh(c) {
  return `length=${c.length} vnum=${c.vnum} volume=${c.volume} quantize=${c.quantize} ` +
    `detune=${c.detune} fnum1=${c.fnum1} fnum2=${c.fnum2} code=0x${c.code.toString(16)} ` +
    `flag=0b${c.flag.toString(2).padStart(8, '0')} pan=${c.pan} keyon=${c.keyon} ` +
    `alg=${c.alg} chnum=${c.chnum} vnum_org=${c.vnum_org} vol_org=${c.vol_org}`;
}

// ---------------------------------------------------------------------------
// Phase 1: パート文字(A-K) <-> ch index の対応
// ---------------------------------------------------------------------------
async function phase1_channelMapping() {
  console.log('\n=== Phase 1: パート文字(A-K) -> ch index ===');
  console.log('事前予想: A-F=FM1-6(ch0-5) / G=リズム(ch6) / H-J=SSG1-3(ch7-9) / K=ADPCM(ch10)');
  console.log('(sampl1.muc の G パートが v52,21,21,21,20,21,21 という7値のリズムボリューム'
    + 'だったことが根拠。予想は予想であり、以下は実測結果。)\n');

  const mapping = {};
  for (const letter of 'ABCDEFGHIJK') {
    // G(リズム)/K(ADPCM)は@voice省略でも動くが、FM/SSGは@指定が要る(実測で確認済み)。
    // 全パート共通で動く書式にするため@1を付ける(G/Kには@1が無効な値でも実測上エラーにならない)。
    const mml = `${letter} @1o4c1\n`;
    const { err, channels } = await probe(mml);
    if (/error/i.test(err)) {
      console.log(`${letter}: COMPILE ERROR`);
      mapping[letter] = null;
      continue;
    }
    const active = [];
    channels.forEach((c, i) => {
      if (c.keyon !== 0 || c.code !== 0 || c.fnum1 !== 0 || c.fnum2 !== 0) active.push(i);
    });
    mapping[letter] = active.length === 1 ? active[0] : active;
    console.log(`${letter} -> ch${JSON.stringify(mapping[letter])}`);
  }

  const expectedPrediction = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7, I: 8, J: 9, K: 10 };
  // 実測結果(A-K が ch0-10 に直接対応)。これは「予想」ではなく実測で確定した表。
  const measured = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7, I: 8, J: 9, K: 10 };
  let allMatch = true;
  for (const letter of 'ABCDEFGHIJK') {
    if (mapping[letter] !== measured[letter]) allMatch = false;
  }
  check('実測したch対応が事前確定表(A→ch0,...,K→ch10)と一致する', allMatch,
    JSON.stringify(mapping));

  const predictionMatchesGuess = 'ABCDEF'.split('').every(l => mapping[l] === (l.charCodeAt(0) - 65))
    && mapping.G === 6;
  console.log(`\n参考: 事前予想(A-F=FM1-6/G=リズム/H-J=SSG/K=ADPCM)との一致確認 -> `
    + `実測は A,B,C=FM1-3(ch0-2) / D,E,F=SSG1-3(ch3-5) / G=リズム(ch6) / `
    + `H,I,J=FM4-6(ch7-9) / K=ADPCM(ch10)。`
    + `つまり「A-Fが全部FM」という予想は外れ、SSGはD-Fに割り当てられている。`);

  return mapping;
}

// ---------------------------------------------------------------------------
// Phase 2: 音程(FM / SSG) — オクターブ1-8 x 半音12個
// ---------------------------------------------------------------------------
async function phase2_pitchSweep(letter, chIndex, label) {
  console.log(`\n=== Phase 2: 音程スイープ(${label}, part ${letter}, ch${chIndex}) ===`);
  const results = [];
  for (let oct = 1; oct <= 8; oct++) {
    for (let noteIdx = 0; noteIdx < NOTE_NAMES.length; noteIdx++) {
      const note = NOTE_NAMES[noteIdx];
      const mml = `${letter} @1o${oct}${note}1\n`;
      const { channels } = await probe(mml);
      const c = channels[chIndex];
      results.push({ oct, noteIdx, note, code: c.code, fnum1: c.fnum1, fnum2: c.fnum2, keyon: c.keyon });
    }
  }

  // 仮説: code = ((oct-1)<<4) | noteIdx , keyon = (oct-1)*12 + noteIdx
  const codeFormula = (oct, noteIdx) => ((oct - 1) << 4) | noteIdx;
  const keyonFormula = (oct, noteIdx) => (oct - 1) * 12 + noteIdx;

  let codeOk = true, keyonOk = true;
  for (const r of results) {
    if (r.code !== codeFormula(r.oct, r.noteIdx)) codeOk = false;
    if (r.keyon !== keyonFormula(r.oct, r.noteIdx)) keyonOk = false;
  }
  check(`${label}: code = ((oct-1)<<4)|noteIdx が全96件で一致`, codeOk);
  check(`${label}: keyon = (oct-1)*12+noteIdx が全96件で一致`, keyonOk);

  // 陽性対照: わざとオクターブを+1ずらした誤った式を検証し、FAILすることを確認する。
  const wrongCodeFormula = (oct, noteIdx) => (oct << 4) | noteIdx; // オクターブのシフト量を1つずらした誤り
  let wrongOk = true;
  for (const r of results) {
    if (r.code !== wrongCodeFormula(r.oct, r.noteIdx)) { wrongOk = false; break; }
  }
  check(`${label}: 陽性対照(オクターブを+1ずらした誤った式)は不一致(FAILするはず)`, !wrongOk,
    wrongOk ? '誤った式なのに一致してしまった(検査の質に問題あり)' : '意図通りFAILを確認');

  // fnum1/fnum2 の挙動確認
  if (label === 'FM') {
    // 同じ音名でオクターブが上がるとfnum2が+8ずつ増え、fnum1は不変であることを確認
    // (YM2203のF-Number/Block register の典型的な並び: block(3bit)<<3 | 上位3bit, 下位8bit別)
    let fnum2Ok = true;
    for (let noteIdx = 0; noteIdx < NOTE_NAMES.length; noteIdx++) {
      const byOct = results.filter(r => r.noteIdx === noteIdx);
      const fnum1s = new Set(byOct.map(r => r.fnum1));
      if (fnum1s.size !== 1) fnum2Ok = false;
      for (let i = 1; i < byOct.length; i++) {
        if (byOct[i].fnum2 - byOct[i - 1].fnum2 !== 8) fnum2Ok = false;
      }
    }
    check('FM: fnum1は同一音名内でオクターブ不変・fnum2はオクターブ毎に+8', fnum2Ok);
  } else {
    // SSG: fnum1/fnum2 はオクターブに依存せず音名のみで決まる(=絶対周期ではなく
    // オクターブ基準値。実際のPSG周期レジスタへの反映はcode/keyonの絶対音程を元に
    // Z80ドライバ側で別途シフトして書き込んでいると推測されるが、そのシフト後の値は
    // PCHDATAに保存されていない=このexportからは測定不能)。
    let octInvariant = true;
    for (let noteIdx = 0; noteIdx < NOTE_NAMES.length; noteIdx++) {
      const byOct = results.filter(r => r.noteIdx === noteIdx);
      const fnum1s = new Set(byOct.map(r => r.fnum1));
      const fnum2s = new Set(byOct.map(r => r.fnum2));
      if (fnum1s.size !== 1 || fnum2s.size !== 1) octInvariant = false;
    }
    check('SSG: fnum1/fnum2はオクターブに依存せず音名だけで決まる(実測)', octInvariant);
    console.log('  → SSGの絶対音程はfnum1/fnum2からは復元できない(未解明)。'
      + 'code/keyonのオクターブ込みの値を使うこと。');
  }

  return results;
}

// ---------------------------------------------------------------------------
// Phase 3: 休符・タイ・未使用パート
// ---------------------------------------------------------------------------
async function phase3_restTieUnused() {
  console.log('\n=== Phase 3: 休符 / タイ / 未使用パート ===');

  const { channels: restCh } = await probe('A @1o4r1\n');
  const rest = restCh[0];
  console.log('休符(o4 r1):', fmtCh(rest));
  check('休符時は fnum1===0 && fnum2===0 && code===0', rest.fnum1 === 0 && rest.fnum2 === 0 && rest.code === 0);
  check('休符時に flag のbit6は立っている(演奏中と同じ64)', (rest.flag & 0x40) !== 0, `flag=${rest.flag}`);

  const { channels: tieCh } = await probe('A @1o4l16t200c1&c1\n');
  const tie = tieCh[0];
  console.log('タイ(c1&c1):', fmtCh(tie));
  const { channels: plainCh } = await probe('A @1o4c1\n');
  const plain = plainCh[0];
  check('タイ後もcode/fnum1/fnum2は単発ノートと同じ(音程は変わらない)',
    tie.code === plain.code && tie.fnum1 === plain.fnum1 && tie.fnum2 === plain.fnum2);
  console.log('  注: bit4=TIE FLAGのヘッダコメントを狙って測定したが、'
    + 'タイ直後の1点しか読めておらず、タイ特有のbitが単発ノートと異なるかは'
    + `flag値の比較では確認できなかった(tie.flag=${tie.flag}, plain.flag=${plain.flag})。`
    + 'タイのbitを弁別できたとは言えないため未解明として扱う。');

  const { channels: unusedCh } = await probe('B @1o4c1\n'); // Aパートを使わない曲
  const unused = unusedCh[0];
  console.log('未使用パート(このMMLでAは一度も登場しない):', fmtCh(unused));
  check('未使用パートは fnum1===0 && fnum2===0 && code===0 (休符と同じ形)',
    unused.fnum1 === 0 && unused.fnum2 === 0 && unused.code === 0);
  check('「休符」と「未使用パート」はPCHDATAの主要フィールドだけでは区別できない(未解明)',
    unused.length !== rest.length,
    `unused.length=${unused.length} rest.length=${rest.length} (lengthフィールドだけ差がある。`
    + `未使用は255=初期値、休符は減算中の値。この差が信頼できる判別式かは1サンプルのみでは未確定)`);
}

// ---------------------------------------------------------------------------
// Phase 4: volume / quantize / detune
// ---------------------------------------------------------------------------
async function phase4_volQuantDetune() {
  console.log('\n=== Phase 4: volume / quantize / detune ===');

  const cases = [
    { mml: 'A @1v10q4D-18o4c1\n', v: 10, q: 4, d: -18 },
    { mml: 'A @1v5q7D20o4c1\n', v: 5, q: 7, d: 20 },
    { mml: 'A @1v0q0D0o4c1\n', v: 0, q: 0, d: 0 },
  ];
  let quantizeOk = true;
  let volOrgOk = true;
  let volumeOffsetOk = true;
  let detuneOk = true;
  for (const t of cases) {
    const { channels } = await probe(t.mml);
    const c = channels[0];
    console.log(`v${t.v} q${t.q} D${t.d} ->`, fmtCh(c));
    if (c.quantize !== t.q) quantizeOk = false;
    if (c.vol_org !== t.v) volOrgOk = false;
    // cmucom.cpp:2318 "vol_org = result->volume - 4; if (vol_org<0) vol_org=0;" より
    // volume = v_org + 4 のはず(v_org=0の時はvolume>=4になるのでこの式では検証不可、
    // その他2ケースのみ厳密一致を見る)
    if (t.v > 0 && c.volume !== t.v + 4) volumeOffsetOk = false;
    const signedDetune = c.detune > 32767 ? c.detune - 65536 : c.detune;
    if (signedDetune !== t.d) detuneOk = false;
  }
  check('quantize フィールドはMMLのqの値をそのまま反映する', quantizeOk);
  check('vol_org フィールドはMMLのvの値をそのまま反映する(cmucom.cpp:2318のvol_org計算と一致)', volOrgOk);
  check('volume フィールドは vol_org+4 (v=0以外の2件で確認。v=0はvol_org側で0クリップされるため対象外)',
    volumeOffsetOk);
  check('detune フィールドは符号付き16bitとして解釈すればMMLのDの値と一致する', detuneOk);
}

// ---------------------------------------------------------------------------
// Phase 5: sampl1.muc による独立検証(別MMLでの再現性チェック)
// ---------------------------------------------------------------------------
async function phase5_validateAgainstSample() {
  console.log('\n=== Phase 5: sampl1.muc(測定に使っていない実MML)での再現性検証 ===');
  const Module = await createMucomWeb();
  const mml = readFileSync(SAMPLE_MUC, 'latin1');
  const err = Module.compileMML(mml, SAMPLE_RATE);
  if (/error/i.test(err)) {
    check('sampl1.muc がコンパイルエラー無く読み込める', false, err);
    return;
  }
  check('sampl1.muc がコンパイルエラー無く読み込める', true);

  // Part A(ch0)冒頭は "e8r4.r4edc8 d8.g&g2 g8f8e4r4 r4cde8e8.f8.c8 c8.d8r<g8>" @o6。
  // code の遷移を1024フレーム刻みで追跡し、e,d,c,d,g,f,e,c,d,e,f,c,d,<g(o5)というMML上の
  // 音名列と一致するかを確認する。休符・タイによる重複(同じcodeが続く)は1つに畳み込む。
  const decode = (code) => {
    const oct = (code >> 4) + 1;
    const note = code & 0xf;
    return note < 12 ? `o${oct}${NOTE_NAMES[note]}` : null;
  };
  const expectedSeq = ['o6e', 'o6d', 'o6c', 'o6d', 'o6g', 'o6f', 'o6e', 'o6c', 'o6d', 'o6e', 'o6f', 'o6c', 'o6d', 'o5g'];
  const observedSeq = [];
  let prevCode = null;
  for (let i = 0; i < 400 && observedSeq.length < expectedSeq.length; i++) {
    Module.audioWorkletRequest(1024, 2, 1);
    const c = Module.getChannelData()[0];
    if (c.code !== prevCode && c.code !== 0) {
      const d = decode(c.code);
      if (d && d !== observedSeq[observedSeq.length - 1]) observedSeq.push(d);
      prevCode = c.code;
    }
  }
  const seqMatches = expectedSeq.every((v, i) => observedSeq[i] === v);
  check('sampl1.muc part A(ch0)のcode遷移がMML上の音名列(e,d,c,d,g,f,e,c,d,e,f,c,d,<g)と一致',
    seqMatches, `expected=${JSON.stringify(expectedSeq)} observed=${JSON.stringify(observedSeq)}`);
}

async function main() {
  await phase1_channelMapping();
  await phase2_pitchSweep('A', 0, 'FM');
  await phase2_pitchSweep('D', 3, 'SSG');
  await phase3_restTieUnused();
  await phase4_volQuantDetune();
  await phase5_validateAgainstSample();

  console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
