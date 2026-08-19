#!/usr/bin/env node
// 測定スパイクの続き(実装ではない)。コーディネータからの指摘への対応:
// 「音名→期待周波数」という自作の物差しでは、PCMサンプル固有の録音ピッチと
// 「変換のレート規約のズレ」を区別できない(自作エンコーダを自作の物差しで
// 測っている)。そこで upstream/pmdmini(GPLv2、P86をネイティブ再生できる
// 参照実装)をビルドして「別プロセスのオラクル」として使い、
//   (A) pmdmini + 本物のMBE86PCM.P86 (ネイティブ.P86サポート)
//   (B) 我々のwasm経路 + 疑似.PPC(1:1変換、tools/experiment_p86_to_ppc.mjs)
// に **全く同じ .M ファイル**(ADPCM単独パート、同じtonenum/音符)を食わせ、
// 出力波形の基本周波数比(A:B)を取る。サンプル固有ピッチ(f0)はA/Bで完全に
// 同一の入力データを参照するので比較の両辺から相殺され、残るのは
// 「レート規約の違い」だけになる(はず)。
//
// --- 権利上の線引き(厳守) ---
//   - upstream/pmdmini をビルドして実行するのは可。出力される音を使うのは問題ない
//   - upstream/pmdmini/src/pmdwin/ のソースは一切読んでいない(特にp86drv.cpp)。
//     ビルド方法はCMakeLists.txt/README.md/sdlplay.cpp/src/pmdmini.h/.cpp
//     (いずれもpmdwin外)から得た。コマンドライン引数の意味・WAV出力形式
//     (44100Hz/16bit/stereo、ヘッダ44byte)もこれらのファイルから読み取った
//   - 我々のコードにpmdminiをリンクしていない(child_processで実行ファイルを
//     呼ぶだけ)。ビルド成果物は upstream/pmdmini/build に置き、dist/には混ぜない
//
// 実行: node tools/experiment_pmdmini_oracle_check.mjs (150秒で打ち切る、同期実行)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import { writeSongWithPcm } from '../net/pmd-pcm.js';
import { buildPmdChannelMask, FM_CHANNELS, SSG_CHANNELS, RHYTHM_CHANNEL } from '../fmdsp/channel-mask.js';
import {
  parseP86, encodeAdpcmB, p86ToAdpcmTargets, buildPpcFile,
  readTrack, readFrame, estimatePitchHz,
  FIELD, ADPCM_TRACK_INDEX, buildAdpcmOnlySong,
} from './experiment_p86_to_ppc.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = '/Users/haruurara/Downloads/4OpAlice';
const PMDPLAY_BIN = path.join(__dirname, '../upstream/pmdmini/build/pmdplay');
const OUR_SAMPLE_RATE = 55467; // pmdweb固定
const PMDMINI_SAMPLE_RATE = 44100; // sdlplay.cpp audio_loop_file()のfreq(pmdwin外のコードで確認)

const DEADLINE_MS = 150000;
const startTime = Date.now();
function checkDeadline(label) {
  const elapsed = Date.now() - startTime;
  if (elapsed > DEADLINE_MS) {
    console.log(`\n=== 打ち切り: ${label} の時点で ${elapsed}ms 経過(上限${DEADLINE_MS}ms) ===`);
    process.exit(1);
  }
}

// ============================================================
// pmdmini(オラクル)をビルド・実行
// ============================================================
function ensurePmdminiBuilt() {
  if (fs.existsSync(PMDPLAY_BIN)) return;
  throw new Error(`pmdplayが見つからない: ${PMDPLAY_BIN} (先にビルドが必要)`);
}

function runPmdminiOracle(songBytes) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmdmini-oracle-'));
  const songPath = path.join(workDir, 'ctrl.m');
  const p86SrcPath = path.join(DATA_DIR, 'MBE86PCM.P86');
  const p86DstPath = path.join(workDir, 'MBE86PCM.P86');
  const wavPath = path.join(workDir, 'out.wav');
  fs.writeFileSync(songPath, songBytes);
  fs.copyFileSync(p86SrcPath, p86DstPath);
  execFileSync(PMDPLAY_BIN, [songPath, wavPath, '--', '1'], {
    cwd: workDir,
    timeout: 20000,
    env: { ...process.env, SDL_AUDIODRIVER: 'dummy' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const wav = fs.readFileSync(wavPath);
  // 標準的な44byte PCM WAVヘッダ(sdlplay.cpp audio_write_wav_header()参照、
  // pmdwin外のコード)。dataチャンクはoffset44から、int16 stereo。
  const dataStart = 44;
  const n = Math.floor((wav.length - dataStart) / 4);
  const mono = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const off = dataStart + i * 4;
    let l = wav.readInt16LE(off);
    let r = wav.readInt16LE(off + 2);
    mono[i] = (l + r) / 2;
  }
  fs.rmSync(workDir, { recursive: true, force: true });
  return mono;
}

// ============================================================
// 我々のwasm経路
// ============================================================
async function runOursWasm({ songBytes, ppcBytes, memoName, mask }) {
  const Module = await createPmdWeb();
  const pcmFiles = ppcBytes ? [{ name: memoName, data: ppcBytes }] : [];
  const songDirPath = writeSongWithPcm(Module, { songName: 'ctrl.m', songBytes, pcmFiles });
  const err = Module.playMusic(songDirPath);
  if (err) throw new Error(`playMusic失敗: ${err}`);
  Module.setChannelMask(mask);
  let noteSeen = false;
  for (let i = 0; i < 200 && !noteSeen; i++) {
    Module.renderFramesForTest(64);
    const track = readTrack(Module, ADPCM_TRACK_INDEX);
    if (track && (track[FIELD.key] & 0xff) !== 0xff) noteSeen = true;
  }
  const absSumShort = Module.renderFramesForTest(4000);
  const got = Module.testRenderCapture(60000);
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
  return { absSumShort, mono, noteSeen };
}

async function main() {
  console.log('=== 測定スパイク: pmdmini(オラクル) vs 疑似PPC 経路の比較 ===\n');
  ensurePmdminiBuilt();
  console.log(`[pmdmini] バイナリ: ${PMDPLAY_BIN}`);
  console.log(`[pmdmini] mtime=${fs.statSync(PMDPLAY_BIN).mtime.toISOString()}`);

  const p86Path = path.join(DATA_DIR, 'MBE86PCM.P86');
  const p86Buf = fs.readFileSync(p86Path);
  const { entries } = parseP86(p86Buf);

  const mask = buildPmdChannelMask(new Set([...FM_CHANNELS, ...SSG_CHANNELS, RHYTHM_CHANNEL]));
  const octaves = [3, 4, 5];
  const noteIndex = 0; // c
  const sampleIdxs = [1, 7, 21, 50, 16]; // 前回グリッドと重ねる+kckor実測値(16)も再確認
  const results = [];

  for (const sampleIdx of sampleIdxs) {
    const entry = entries[sampleIdx];
    if (!entry || entry.len <= 0) { console.log(`sample=${sampleIdx}: エントリなし、スキップ`); continue; }
    const samples = new Int8Array(entry.len);
    for (let i = 0; i < entry.len; i++) samples[i] = p86Buf[entry.start + i];
    // 我々の疑似PPC(1:1変換、tonenum=sampleIdxでP86側と揃える。両エンジンに
    // *同じ*.Mファイルを渡すため)
    const targets = p86ToAdpcmTargets(samples, 1);
    const payload = encodeAdpcmB(targets);
    const ppc = buildPpcFile({ tonenum: sampleIdx, payload });

    for (const octave of octaves) {
      checkDeadline(`oracle比較 sample=${sampleIdx} octave=${octave}`);
      const songBytes = buildAdpcmOnlySong({
        adpcmTonenum: sampleIdx, octaveNibble: octave - 1, noteIndex, lengthTicks: 200, ppcMemoName: 'MBE86PCM.PPC',
      });

      // (A) pmdmini オラクル(本物のMBE86PCM.P86をネイティブ再生)
      const oracleMono = runPmdminiOracle(songBytes);
      const oraclePitch = estimatePitchHz(oracleMono, PMDMINI_SAMPLE_RATE);

      // (B) 我々のwasm経路(疑似PPC、1:1変換)
      const ours = await runOursWasm({
        songBytes, ppcBytes: ppc, memoName: 'MBE86PCM.PPC', mask,
      });
      const oursPitch = estimatePitchHz(ours.mono, OUR_SAMPLE_RATE);

      const ratio = (oraclePitch.hz && oursPitch.hz) ? oraclePitch.hz / oursPitch.hz : null;
      results.push({
        sampleIdx,
        octave,
        oracleHz: oraclePitch.hz,
        oracleConf: oraclePitch.confidence,
        oursHz: oursPitch.hz,
        oursConf: oursPitch.confidence,
        ratio,
      });
      console.log(`sample=${sampleIdx} o${octave}c: pmdmini=${oraclePitch.hz ? oraclePitch.hz.toFixed(2) : 'n/a'}Hz(相関${oraclePitch.confidence.toFixed(3)}) `
        + `ours=${oursPitch.hz ? oursPitch.hz.toFixed(2) : 'n/a'}Hz(相関${oursPitch.confidence.toFixed(3)}) `
        + `比(A:B)=${ratio ? ratio.toFixed(4) : 'n/a'}`);
    }
  }

  console.log('\n=== 表: pmdmini(A) : 我々(B) の周波数比 ===');
  console.log('sample\\octave  ' + octaves.map((o) => `o${o}`).join('       '));
  for (const sampleIdx of sampleIdxs) {
    const row = octaves.map((o) => {
      const r = results.find((x) => x.sampleIdx === sampleIdx && x.octave === o);
      return r && r.ratio !== null ? r.ratio.toFixed(4) : '   n/a';
    });
    console.log(`entry${sampleIdx}`.padEnd(14) + row.join('  '));
  }

  const reliable = results.filter((r) => r.ratio !== null && r.oracleConf >= 0.5 && r.oursConf >= 0.5);
  console.log(`\n信頼できる測定(両側相関>=0.5): ${reliable.length}/${results.length}件`);
  if (reliable.length >= 2) {
    const ratios = reliable.map((r) => r.ratio);
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const sd = Math.sqrt(ratios.reduce((a, b) => a + (b - mean) ** 2, 0) / ratios.length);
    const cv = sd / mean;
    console.log(`比率(A:B)の平均=${mean.toFixed(4)} 標準偏差=${sd.toFixed(4)} 変動係数=${(cv * 100).toFixed(2)}%`);
    console.log(`前回の探索係数0.8763との対応: 1/mean=${(1 / mean).toFixed(4)} (前回はB側をmean倍したい、という意味で1/meanと比較する)`);
    if (cv < 0.15) {
      console.log('[判定] 変動係数15%未満 -> ほぼ一定の定数補正で足りる。');
    } else {
      console.log('[判定] 変動係数15%以上 -> 定数では説明できない(構造的な違いの可能性)。');
    }
  } else {
    console.log('[判定不能] 信頼できる測定が2件未満。');
  }

  // --- 陰性対照: 我々側でPPCを渡さない条件を同じ比較にかける ---
  console.log('\n=== 陰性対照: 我々側にPPCを渡さない条件 ===');
  const negSampleIdx = sampleIdxs[0];
  const negSongBytes = buildAdpcmOnlySong({
    adpcmTonenum: negSampleIdx, octaveNibble: 4, noteIndex, lengthTicks: 200, ppcMemoName: 'MBE86PCM.PPC',
  });
  const oracleMonoForNeg = runPmdminiOracle(negSongBytes);
  const oraclePitchForNeg = estimatePitchHz(oracleMonoForNeg, PMDMINI_SAMPLE_RATE);
  const oursNeg = await runOursWasm({
    songBytes: negSongBytes, ppcBytes: null, memoName: 'MBE86PCM.PPC', mask,
  });
  const oursNegPitch = estimatePitchHz(oursNeg.mono, OUR_SAMPLE_RATE);
  const negRatio = (oraclePitchForNeg.hz && oursNegPitch.hz) ? oraclePitchForNeg.hz / oursNegPitch.hz : null;
  console.log(`pmdmini(本物の音)=${oraclePitchForNeg.hz ? oraclePitchForNeg.hz.toFixed(2) : 'n/a'}Hz(相関${oraclePitchForNeg.confidence.toFixed(3)})`);
  console.log(`我々(PPCなし、absSum=${oursNeg.absSumShort})=${oursNegPitch.hz ? oursNegPitch.hz.toFixed(2) : 'n/a'}Hz(相関${oursNegPitch.confidence.toFixed(3)})`);
  console.log(`比=${negRatio ? negRatio.toFixed(4) : 'n/a'}`);
  const comparatorSane = oursNeg.absSumShort < 1000 // ほぼ無音のはず
    && (negRatio === null || Math.abs(negRatio - 1) > 0.05 || oursNegPitch.confidence < 0.3);
  console.log(`[陰性対照 判定] 比較器は「PPCなし」を正しく「一致しない」と判定できているか: ${comparatorSane ? 'OK' : 'NG(要確認)'} `
    + `(我々側absSum=${oursNeg.absSumShort}, 我々側相関=${oursNegPitch.confidence.toFixed(3)})`);

  console.log('\n=== 完了 ===');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
