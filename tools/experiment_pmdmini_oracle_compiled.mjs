#!/usr/bin/env node
// tools/experiment_pmdmini_oracle_check.mjs のやり直し。
// コーディネータの指摘: 手組みの.Mをpmdmini(実pmdwin)に渡すと fopen(MBE86PCM.P86) が
// 一切呼ばれず、原因は「PCM参照メカニズムの不一致」ではなく「.Mを手組みしたこと自体」
// だった。自作PMDコンパイラ(compiler/pmd_mml_compiler.mjs、実データ8本でMC.EXEと
// バイト完全一致まで検証済み)でMMLをコンパイルして得た.Mを両エンジンに食わせる。
//
// 構成: 1本のMMLで同じtonenum(@n)を o3/o4/o5 の順に全音符(c1)で並べる
// (`J @<n> T120 o3c1 o4c1 o5c1`)。ノート境界のフレーム番号は我々の wasm 側
// (flat_track_status.key遷移)で一度だけ実測し(tonenumに依存しない構造なので使い回せる)、
// 同じ秒数をpmdmini側のWAV(44100Hz)にも適用する(=同じテンポ解釈である前提。
// 実測: 3ノート+終了=11.31秒がpmdminiの"plays 11 sec"表示とほぼ一致することを確認済み)。
//
// 権利上の線引き(前回と同じ、厳守):
//   - upstream/pmdmini/src/pmdwin/ は読まない(特にp86drv.cpp)
//   - upstream/pmdminiをビルド・実行するのみ、リンクしない、dist/に混ぜない
//
// 実行: node tools/experiment_pmdmini_oracle_compiled.mjs (150秒で打ち切る、同期実行)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import { compileMml } from '../compiler/pmd_mml_compiler.mjs';
import { writeSongWithPcm } from '../net/pmd-pcm.js';
import { buildPmdChannelMask, FM_CHANNELS, SSG_CHANNELS, RHYTHM_CHANNEL } from '../fmdsp/channel-mask.js';
import {
  parseP86, encodeAdpcmB, p86ToAdpcmTargets, buildPpcFile,
  readTrack, readFrame, estimatePitchHz, FIELD, ADPCM_TRACK_INDEX,
} from './experiment_p86_to_ppc.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = '/Users/haruurara/Downloads/4OpAlice';
const PMDPLAY_BIN = path.join(__dirname, '../upstream/pmdmini/build/pmdplay');
const OUR_SR = 55467;
const PMDMINI_SR = 44100;

const DEADLINE_MS = 150000;
const startTime = Date.now();
function checkDeadline(label) {
  const elapsed = Date.now() - startTime;
  if (elapsed > DEADLINE_MS) {
    console.log(`\n=== 打ち切り: ${label} の時点で ${elapsed}ms 経過(上限${DEADLINE_MS}ms) ===`);
    process.exit(1);
  }
}

function buildMml(tonenum) {
  return `#PCMfile MBE86PCM.P86\nJ @${tonenum} T120 o3c1 o4c1 o5c1\n`;
}

// ============================================================
// 0. ノート境界(フレーム番号、55467Hz基準)を一度だけ実測する
//    (@nの値によらず構造は同じなので使い回せる)
// ============================================================
async function measureTransitions() {
  const { file, errors } = compileMml(buildMml(1), {});
  if (errors.length) throw new Error(`compile失敗: ${JSON.stringify(errors)}`);
  const Module = await createPmdWeb();
  Module.FS.writeFile('/probe.m', file);
  const err = Module.playMusic('/probe.m');
  if (err) throw new Error(`playMusic失敗: ${err}`);
  let lastKey = null;
  const transitions = [];
  for (let i = 0; i < 40000; i++) {
    Module.renderFramesForTest(16);
    const t = readTrack(Module, ADPCM_TRACK_INDEX);
    if (!t) continue;
    const key = t[FIELD.key] & 0xff;
    const playing = t[FIELD.playing];
    if (key !== lastKey) {
      transitions.push({ frame: readFrame(Module), key, playing });
      lastKey = key;
    }
    if (!playing && transitions.length > 1) break;
  }
  return transitions;
}

// ============================================================
// pmdmini(オラクル)
// ============================================================
function ensurePmdminiBuilt() {
  if (!fs.existsSync(PMDPLAY_BIN)) throw new Error(`pmdplayが見つからない: ${PMDPLAY_BIN}`);
}

function runPmdmini(songBytes) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmdmini-compiled-'));
  const songPath = path.join(workDir, 'ctrl.m');
  fs.writeFileSync(songPath, songBytes);
  fs.copyFileSync(path.join(DATA_DIR, 'MBE86PCM.P86'), path.join(workDir, 'MBE86PCM.P86'));
  const wavPath = path.join(workDir, 'out.wav');
  const log = execFileSync(PMDPLAY_BIN, [songPath, wavPath, '--', '1'], {
    cwd: workDir, timeout: 20000, env: { ...process.env, SDL_AUDIODRIVER: 'dummy' },
  }).toString();
  const p86Opened = log.includes('fopen( ') && log.includes('MBE86PCM.P86');
  const wav = fs.readFileSync(wavPath);
  fs.rmSync(workDir, { recursive: true, force: true });
  return { wav, p86Opened, log };
}

function wavSlice(wav, startSec, durSec) {
  const startIdx = Math.max(0, Math.floor(startSec * PMDMINI_SR));
  const n = Math.floor(durSec * PMDMINI_SR);
  const mono = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const off = 44 + (startIdx + i) * 4;
    if (off + 4 > wav.length) break;
    mono[i] = (wav.readInt16LE(off) + wav.readInt16LE(off + 2)) / 2;
  }
  return mono;
}

// ============================================================
// 我々のwasm経路(疑似PPC)
// ============================================================
async function runOursWasm({ songBytes, ppcBytes, skipFrames, captureFrames }) {
  const Module = await createPmdWeb();
  const pcmFiles = ppcBytes ? [{ name: 'MBE86PCM.PPC', data: ppcBytes }] : [];
  const songDirPath = writeSongWithPcm(Module, { songName: 'ctrl.m', songBytes, pcmFiles });
  const err = Module.playMusic(songDirPath);
  if (err) throw new Error(`playMusic失敗: ${err}`);
  const mask = buildPmdChannelMask(new Set([...FM_CHANNELS, ...SSG_CHANNELS, RHYTHM_CHANNEL]));
  Module.setChannelMask(mask);
  let remain = skipFrames;
  while (remain > 0) {
    const chunk = Math.min(remain, 8192);
    Module.renderFramesForTest(chunk);
    remain -= chunk;
  }
  const absSumProbe = Module.renderFramesForTest(1000);
  const got = Module.testRenderCapture(captureFrames);
  const ptr = Module.testGetCapturePointer();
  const mono = new Float64Array(got);
  for (let i = 0; i < got; i++) {
    const lo = Module.HEAPU8[ptr + i * 4];
    const hi = Module.HEAPU8[ptr + i * 4 + 1];
    let l = lo | (hi << 8);
    if (l >= 0x8000) l -= 0x10000;
    const lo2 = Module.HEAPU8[ptr + i * 4 + 2];
    const hi2 = Module.HEAPU8[ptr + i * 4 + 3];
    let r = lo2 | (hi2 << 8);
    if (r >= 0x8000) r -= 0x10000;
    mono[i] = (l + r) / 2;
  }
  return { mono, absSumProbe };
}

async function main() {
  console.log('=== 測定スパイク: 自作コンパイラ製.Mでpmdmini(オラクル) vs 疑似PPC 経路を比較 ===\n');
  ensurePmdminiBuilt();
  console.log(`[pmdmini] ${PMDPLAY_BIN} mtime=${fs.statSync(PMDPLAY_BIN).mtime.toISOString()}`);

  // --- ゲート: fopen(MBE86PCM.P86)が呼ばれるか。2回まで試す ---
  let gatePassed = false;
  for (let attempt = 1; attempt <= 2 && !gatePassed; attempt++) {
    const { file, errors } = compileMml(buildMml(21), {});
    if (errors.length) { console.log(`[ゲート試行${attempt}] compile失敗: ${JSON.stringify(errors)}`); continue; }
    const { p86Opened, log } = runPmdmini(file);
    console.log(`[ゲート試行${attempt}] fopen(MBE86PCM.P86)が呼ばれた: ${p86Opened}`);
    if (!p86Opened) console.log(log);
    gatePassed = p86Opened;
  }
  if (!gatePassed) {
    console.log('\n[打ち切り] 2回試してもfopen(MBE86PCM.P86)が呼ばれない。ここで停止する。');
    process.exit(1);
  }
  checkDeadline('ゲート通過後');

  // --- ノート境界を実測 ---
  const transitions = await measureTransitions();
  console.log('\nノート境界(55467Hz基準):', JSON.stringify(transitions));
  const [t0, t1, t2, t3] = transitions; // key=0x20(o3)@t0, 0x30(o4)@t1, 0x40(o5)@t2, end@t3
  const segments = [
    { octave: 3, startFrame: t0.frame + 2000, durSec: 1.5 },
    { octave: 4, startFrame: t1.frame + 2000, durSec: 1.5 },
    { octave: 5, startFrame: t2.frame + 2000, durSec: 1.5 },
  ];
  checkDeadline('境界実測後');

  const p86Buf = fs.readFileSync(path.join(DATA_DIR, 'MBE86PCM.P86'));
  const { entries } = parseP86(p86Buf);
  const sampleIdxs = [21, 50, 7, 1, 16];
  const results = [];

  for (const sampleIdx of sampleIdxs) {
    const entry = entries[sampleIdx];
    if (!entry || entry.len <= 0) { console.log(`sample=${sampleIdx}: エントリなし、スキップ`); continue; }
    checkDeadline(`sample=${sampleIdx} 開始前`);
    const { file: songBytes, errors } = compileMml(buildMml(sampleIdx), {});
    if (errors.length) { console.log(`sample=${sampleIdx}: compile失敗 ${JSON.stringify(errors)}`); continue; }

    const { wav: oracleWav } = runPmdmini(songBytes);

    const rawSamples = new Int8Array(entry.len);
    for (let i = 0; i < entry.len; i++) rawSamples[i] = p86Buf[entry.start + i];
    const payload = encodeAdpcmB(p86ToAdpcmTargets(rawSamples, 1));
    const ppc = buildPpcFile({ tonenum: sampleIdx, payload });

    for (const seg of segments) {
      checkDeadline(`sample=${sampleIdx} o${seg.octave}`);
      const startSec = seg.startFrame / OUR_SR;
      const oracleMono = wavSlice(oracleWav, startSec, seg.durSec);
      const oraclePitch = estimatePitchHz(oracleMono, PMDMINI_SR);

      const ours = await runOursWasm({
        songBytes, ppcBytes: ppc, skipFrames: seg.startFrame, captureFrames: Math.round(seg.durSec * OUR_SR),
      });
      const oursPitch = estimatePitchHz(ours.mono, OUR_SR);

      const ratio = (oraclePitch.hz && oursPitch.hz) ? oraclePitch.hz / oursPitch.hz : null;
      results.push({
        sampleIdx, octave: seg.octave, oracleHz: oraclePitch.hz, oracleConf: oraclePitch.confidence,
        oursHz: oursPitch.hz, oursConf: oursPitch.confidence, ratio,
      });
      console.log(`sample=${sampleIdx} o${seg.octave}c: pmdmini=${oraclePitch.hz ? oraclePitch.hz.toFixed(2) : 'n/a'}Hz(相関${oraclePitch.confidence.toFixed(3)}) `
        + `ours=${oursPitch.hz ? oursPitch.hz.toFixed(2) : 'n/a'}Hz(相関${oursPitch.confidence.toFixed(3)}) 比(A:B)=${ratio ? ratio.toFixed(4) : 'n/a'}`);
    }
  }

  console.log('\n=== 表: pmdmini(A) : 我々(B) の周波数比 ===');
  console.log('sample\\octave  o3       o4       o5');
  for (const sampleIdx of sampleIdxs) {
    const row = [3, 4, 5].map((o) => {
      const r = results.find((x) => x.sampleIdx === sampleIdx && x.octave === o);
      return r && r.ratio !== null ? r.ratio.toFixed(4) : '   n/a';
    });
    console.log(`entry${sampleIdx}`.padEnd(14) + row.join('  '));
  }

  const reliable = results.filter((r) => r.ratio !== null && r.oracleConf >= 0.5 && r.oursConf >= 0.5);
  console.log(`\n信頼できる測定(両側相関>=0.5): ${reliable.length}/${results.length}件`);
  let meanRatio = null;
  if (reliable.length >= 2) {
    const ratios = reliable.map((r) => r.ratio);
    meanRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const sd = Math.sqrt(ratios.reduce((a, b) => a + (b - meanRatio) ** 2, 0) / ratios.length);
    const cv = sd / meanRatio;
    console.log(`比率(A:B)平均=${meanRatio.toFixed(4)} 標準偏差=${sd.toFixed(4)} 変動係数=${(cv * 100).toFixed(2)}%`);
    console.log(`前回の探索係数0.8763との対応: 1/mean=${(1 / meanRatio).toFixed(4)}`);
    console.log(cv < 0.15
      ? '[判定] 変動係数15%未満 -> ほぼ一定の定数補正で足りる。'
      : '[判定] 変動係数15%以上 -> 定数では説明できない。');
  } else {
    console.log('[判定不能] 信頼できる測定が2件未満。');
  }

  // --- 陰性対照: 我々側PPCなし ---
  console.log('\n=== 陰性対照: 我々側にPPCを渡さない ===');
  const { file: negSong } = compileMml(buildMml(21), {});
  const oracleNegWav = runPmdmini(negSong).wav;
  const oracleNegMono = wavSlice(oracleNegWav, segments[2].startFrame / OUR_SR, segments[2].durSec);
  const oracleNegPitch = estimatePitchHz(oracleNegMono, PMDMINI_SR);
  const oursNeg = await runOursWasm({
    songBytes: negSong, ppcBytes: null, skipFrames: segments[2].startFrame, captureFrames: Math.round(segments[2].durSec * OUR_SR),
  });
  const oursNegPitch = estimatePitchHz(oursNeg.mono, OUR_SR);
  console.log(`pmdmini(本物)=${oracleNegPitch.hz ? oracleNegPitch.hz.toFixed(2) : 'n/a'}Hz(相関${oracleNegPitch.confidence.toFixed(3)})`);
  console.log(`我々(PPCなし、absSumProbe=${oursNeg.absSumProbe})=${oursNegPitch.hz ? oursNegPitch.hz.toFixed(2) : 'n/a'}Hz(相関${oursNegPitch.confidence.toFixed(3)})`);
  const comparatorSane = oursNeg.absSumProbe < 5000
    && (oursNegPitch.hz === null || oursNegPitch.confidence < 0.3
      || Math.abs(oursNegPitch.hz / oracleNegPitch.hz - 1) > 0.05);
  console.log(`[陰性対照 判定] 比較器は正しく「一致しない」と言えているか: ${comparatorSane ? 'OK' : 'NG(要確認)'}`);

  console.log('\n=== 完了 ===');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
