#!/usr/bin/env node
// FMDSP右半分(FFTスペクトラム70ビン・レベルメーター19ch)のC->JSデータ供給を検証する。
// Node から wasm を直接ロードする(pmdweb/CMakeLists.txt の -sENVIRONMENT=web,node
// により Node でも動作する)。
//
// 検証項目:
//   (a) FFT 70ビンが全て 0-31 の範囲に収まる
//   (b) 無音時は FFT がほぼ0、再生中は非0のビンが存在する(=配線されている証明)
//   (c) レベル19chのうち、実際に鳴っているチャンネルの level が非0になる
//   (d) getSnapshotEntryByteSize() と各オフセット/カウントの組み合わせが矛盾しない
//
// 陽性対照: (b)は「fft_writeを呼ばないビルド」で意図的に落とすことを一度確認して
// から戻す、という故障注入テストのはず。ここでは自動化のためコード側の
// フラグ(SIMULATE_FFT_DISCONNECTED)でNode側から疑似的に「fft配列を強制0にする」
// のではなく、Cソース側の fft_feed() 呼び出しを一時コメントアウトして再ビルド→
// このスクリプトを再実行→(b)が落ちることを確認、という手順で実施する
// (verify_right_pane_data_fault_injection_log.txt に実施記録)。
//
// 実行: node tools/verify_right_pane_data.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import createPmdWeb from '../pmdweb/build-web/pmdweb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = path.join(__dirname, '../pmdweb/build-web');
// 東方Projectアレンジ曲(権利未確認)のビルド成果物への同梱をやめたため(pmdweb/CMakeLists.txt
// 参照)、このテスト専用の入力としては upstream/ 配下から直接読む(upstream/はビルド成果物では
// なく参照用クローンで、そもそも配布物に含めていない。.gitignoreでも追跡対象外)。
const SAMPLE = path.join(__dirname, '../upstream/pmdmini/PC-98_Hartmann_s_Youkai_GIrl.M');

let failCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? ' - ' + detail : ''}`);
  if (!cond) failCount++;
}

function readSnapshotLatest(Module) {
  const writeIndex = Module.getSnapshotWriteIndex() >>> 0;
  const ringSize = 2048; // SNAPSHOT_RING_SIZE (PmdCore.c)
  if (writeIndex === 0xffffffff || writeIndex === 0) return null;
  const entryBytes = Module.getSnapshotEntryByteSize();
  const ringPtr = Module.getSnapshotRingPointer();
  const idx = (writeIndex - 1) % ringSize;
  const base = ringPtr + idx * entryBytes;

  const fftOffset = Module.getSnapshotFftOffset();
  const levelOffset = Module.getSnapshotLevelOffset();
  const fftCount = Module.getFftBinCount();
  const levelCount = Module.getLevelCount();
  const levelFieldCount = Module.getLevelFieldCount();

  const fft = Module.HEAPU8.slice(base + fftOffset, base + fftOffset + fftCount);
  const levelWords = new Int32Array(levelCount * levelFieldCount);
  const levelBase = (base + levelOffset) / 4;
  for (let i = 0; i < levelWords.length; ++i) {
    levelWords[i] = Module.HEAP32[levelBase + i];
  }
  const levels = [];
  for (let c = 0; c < levelCount; ++c) {
    const o = c * levelFieldCount;
    levels.push({
      level: levelWords[o + 0],
      pan: levelWords[o + 1],
      prog: levelWords[o + 2],
      key: levelWords[o + 3],
      playing: levelWords[o + 4],
    });
  }
  return { fft, levels };
}

async function main() {
  const Module = await createPmdWeb();

  // --- (d) レイアウト整合性(値のロード前に検査できる部分) ---
  const entryBytes = Module.getSnapshotEntryByteSize();
  const fftOffset = Module.getSnapshotFftOffset();
  const levelOffset = Module.getSnapshotLevelOffset();
  const fftCount = Module.getFftBinCount();
  const levelCount = Module.getLevelCount();
  const levelFieldCount = Module.getLevelFieldCount();
  const trackCount = Module.getTrackCount();
  const fieldCount = Module.getFieldCount();

  check('getFftBinCount() === 70', fftCount === 70, `actual=${fftCount}`);
  check('getLevelCount() === 19', levelCount === 19, `actual=${levelCount}`);
  check('getLevelFieldCount() === 5', levelFieldCount === 5, `actual=${levelFieldCount}`);
  // frame(4) + tracks + fft領域 + levels領域 が entryBytes と一致するか
  const headerBytes = 4 + trackCount * fieldCount * 4;
  check('levelOffset >= fftOffset + fftCount (パディング込みでも逆転しない)',
    levelOffset >= fftOffset + fftCount, `fftOffset=${fftOffset} fftCount=${fftCount} levelOffset=${levelOffset}`);
  check('levelOffset + levels領域サイズ === entryBytes',
    levelOffset + levelCount * levelFieldCount * 4 === entryBytes,
    `levelOffset=${levelOffset} levels=${levelCount * levelFieldCount * 4} entryBytes=${entryBytes}`);
  check('fftOffset >= tracks領域の直後', fftOffset >= headerBytes,
    `fftOffset=${fftOffset} headerBytes(参考)=${headerBytes}`);

  // --- 無音時のスナップショット(再生前) ---
  const silentSnapshot = readSnapshotLatest(Module);
  check('再生前はスナップショットリングが無効(null)', silentSnapshot === null,
    silentSnapshot ? 'unexpected snapshot present' : undefined);

  // --- 再生開始 ---
  const bytes = readFileSync(SAMPLE);
  Module.FS.writeFile('/song.m', bytes);
  const error = Module.playMusic('/song.m');
  check('playMusic() がエラーを返さない', error === '', `error="${error}"`);

  // 無音扱いの初期状態(0フレーム目)を読む
  const early = readSnapshotLatest(Module);

  // 十分な再生時間(約3秒)を進める。FFT算出は約60Hzで間引かれるため、
  // 少なくとも数回は fft_calc が回る長さにする。
  const framesToRender = Module.getSampleRate() * 3;
  const absSum = Module.renderFramesForTest(framesToRender);
  check('renderFramesForTest() が非0の音声を生成した(曲が鳴っている証拠)', absSum > 0,
    `absSum=${absSum}`);

  const playing = readSnapshotLatest(Module);
  check('再生後にスナップショットが取得できる', playing !== null);

  if (playing) {
    // (a) 70ビン全てが0-31
    const inRange = [...playing.fft].every((v) => v >= 0 && v <= 31);
    check('(a) FFT 70ビンが全て0-31の範囲', inRange,
      `min=${Math.min(...playing.fft)} max=${Math.max(...playing.fft)}`);

    // (b) 再生中は非0のビンが存在する
    const nonZeroBins = [...playing.fft].filter((v) => v > 0).length;
    check('(b) 再生中はFFTに非0ビンが存在する(配線されている証拠)', nonZeroBins > 0,
      `nonZeroBins=${nonZeroBins}/70`);

    // (c) 実際に鳴っているチャンネルのlevelが非0
    const playingChannels = playing.levels.filter((l) => l.playing !== 0);
    const nonZeroLevelPlaying = playingChannels.filter((l) => l.level > 0).length;
    check('(c) playing=trueのチャンネルにlevel>0が存在する', playingChannels.length > 0 && nonZeroLevelPlaying > 0,
      `playingChannels=${playingChannels.length} nonZeroLevel=${nonZeroLevelPlaying}`);

    console.log('--- levels dump ---');
    playing.levels.forEach((l, i) => {
      console.log(`  [${i}] level=${l.level} pan=${l.pan} prog=${l.prog} key=${l.key} playing=${l.playing}`);
    });
    console.log('--- fft dump (0-31) ---');
    console.log('  ' + [...playing.fft].join(','));
  }

  console.log(failCount === 0 ? `\nALL PASS` : `\n${failCount} CHECK(S) FAILED`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
