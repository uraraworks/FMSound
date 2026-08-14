#!/usr/bin/env node
// MUCOM側(mucomweb)のFMDSP右半分スペクトラムアナライザ(70ビン)のC->JSデータ供給を
// 検証する。pmdweb側の tools/verify_right_pane_data.mjs を手本にした兄弟スクリプト。
// PMD側との違い: MUCOMにはlevels[](leveldata)相当が無い(fmgenにレベル追従が無い、
// スコープ外・docs/right-pane-data.md参照)ため、レベルメーターの検証は行わない。
// また再生開始のAPIもcompileMML(mml, sampleRate)+renderFramesForTest(frames)という
// Node向けテスト専用の直接レンダリング経路を使う(AudioWorklet経由には到達できない、
// MucomWeb.cppのRenderFramesForTest()コメント参照)。
//
// 検証項目:
//   (a) FFT 70ビンが全て 0-31 の範囲に収まる
//   (b) 無音時はFFTがほぼ0、再生中は非0のビンが存在する(=配線されている証明)
//   (c) getSnapshotEntryByteSize() とfftOffset/fftBinCountの組み合わせが矛盾しない
//
// 陽性対照: MucomWeb.cppのProcessAudioRequest()/RenderFramesForTest()内の
// FftFeed(...)呼び出しを一時コメントアウトして再ビルド→本スクリプト再実行→
// (b)が単独でFAILすることを確認してから元に戻す、という故障注入テストを
// 実施する(手順・結果は verify_right_pane_data_mucom_fault_injection_log.txt に記録)。
//
// 実行: node tools/verify_right_pane_data_mucom.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import createMucomWeb from '../mucomweb/build-web/mucom88.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = path.join(__dirname, '../mucomweb/build-web');
const SAMPLE = path.join(BUILD_DIR, 'sampl1.muc');

let failCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? ' - ' + detail : ''}`);
  if (!cond) failCount++;
}

function readLatestFft(Module) {
  const writeIndex = Module.getSnapshotWriteIndex() >>> 0;
  const ringSize = 2048; // SnapshotRingSize (MucomWeb.cpp)
  if (writeIndex === 0xffffffff || writeIndex === 0) return null;
  const entryBytes = Module.getSnapshotEntryByteSize();
  const ringPtr = Module.getSnapshotRingPointer();
  const idx = (writeIndex - 1) % ringSize;
  const base = ringPtr + idx * entryBytes;

  const fftOffset = Module.getSnapshotFftOffset();
  const fftCount = Module.getFftBinCount();
  return Module.HEAPU8.slice(base + fftOffset, base + fftOffset + fftCount);
}

async function main() {
  const Module = await createMucomWeb();

  // --- (c) レイアウト整合性(値のロード前に検査できる部分) ---
  const entryBytes = Module.getSnapshotEntryByteSize();
  const fftOffset = Module.getSnapshotFftOffset();
  const fftCount = Module.getFftBinCount();
  const headerWords = Module.getSnapshotHeaderWordCount();

  check('getFftBinCount() === 70', fftCount === 70, `actual=${fftCount}`);
  check('fftOffset >= header領域の直後', fftOffset >= headerWords * 4,
    `fftOffset=${fftOffset} headerBytes(参考)=${headerWords * 4}`);
  check('fftOffset + fftCount <= entryBytes(パディング込みでもエントリ範囲内)',
    fftOffset + fftCount <= entryBytes,
    `fftOffset=${fftOffset} fftCount=${fftCount} entryBytes=${entryBytes}`);

  // --- 再生前はスナップショットリングが無効 ---
  const beforePlay = readLatestFft(Module);
  check('再生前はスナップショットリングが無効(null)', beforePlay === null,
    beforePlay ? 'unexpected snapshot present' : undefined);

  // --- コンパイル+再生開始 ---
  // .mucはCP932(Shift_JIS)。UTF-8として読むと文字化けしMML構文が壊れるため、
  // 既存ツール(tools/probe_mucom_pchdata.mjs)と同じくバイト列をそのまま
  // 1バイト=1コードポイントとして扱うlatin1で読む。
  const mml = readFileSync(SAMPLE, 'latin1');
  const sampleRate = 55467;
  // compileMML()の戻り値は「エラーの有無」ではなく、常に返るコンパイルログ
  // (mucomCompiler.GetMessageBuffer()、MucomWeb.cpp参照)。成功可否は後続の
  // getSampleRate()/renderFramesForTest()の結果で判定する。
  const compileLog = Module.compileMML(mml, sampleRate);
  check('compileMML() が呼べた(戻り値はログなので参考表示のみ)', typeof compileLog === 'string');

  const actualSampleRate = Module.getSampleRate();
  check('getSampleRate() が指定値と一致', actualSampleRate === sampleRate,
    `actual=${actualSampleRate}`);

  // 約3秒分レンダリング。FFT算出は約60Hzで間引かれるため、少なくとも数回は
  // fft_calc()が回る長さにする。
  const framesToRender = actualSampleRate * 3;
  const absSum = Module.renderFramesForTest(framesToRender);
  check('renderFramesForTest() が非0の音声を生成した(曲が鳴っている証拠)', absSum > 0,
    `absSum=${absSum}`);

  const fft = readLatestFft(Module);
  check('再生後にスナップショットが取得できる', fft !== null);

  if (fft) {
    // (a) 70ビン全てが0-31
    const inRange = [...fft].every((v) => v >= 0 && v <= 31);
    check('(a) FFT 70ビンが全て0-31の範囲', inRange,
      `min=${Math.min(...fft)} max=${Math.max(...fft)}`);

    // (b) 再生中は非0のビンが存在する
    const nonZeroBins = [...fft].filter((v) => v > 0).length;
    check('(b) 再生中はFFTに非0ビンが存在する(配線されている証拠)', nonZeroBins > 0,
      `nonZeroBins=${nonZeroBins}/70`);

    console.log('--- fft dump (0-31) ---');
    console.log('  ' + [...fft].join(','));
  }

  console.log(failCount === 0 ? `\nALL PASS` : `\n${failCount} CHECK(S) FAILED`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
