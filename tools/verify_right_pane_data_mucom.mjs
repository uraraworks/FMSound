#!/usr/bin/env node
// MUCOM側(mucomweb)のFMDSP右半分(FFT/レベルメーター)のC->JSデータ供給を検証する。
// pmdweb側の tools/verify_right_pane_data.mjs を手本にした兄弟スクリプト。
// また再生開始のAPIもcompileMML(mml, sampleRate)+renderFramesForTest(frames)という
// Node向けテスト専用の直接レンダリング経路を使う(AudioWorklet経由には到達できない、
// MucomWeb.cppのRenderFramesForTest()コメント参照)。
//
// FFTの検証項目:
//   (a) FFT 70ビンが全て 0-31 の範囲に収まる
//   (b) 無音時はFFTがほぼ0、再生中は非0のビンが存在する(=配線されている証明)
//   (c) getSnapshotEntryByteSize() とfftOffset/fftBinCountの組み合わせが矛盾しない
//
// レベルメーター(19ch)の検証項目(fmgenへのpeak-hold追加、
// mucomweb/patches/0002-fmgen-leveldata.patch、後付け):
//   (a) 各levelが非負で、無音時は0
//   (b) 1パートだけ鳴らした時、そのパートに対応するindexだけが非0
//       (=配線とチャンネル対応表の証明。docs/right-pane-data.md §6b参照)
//   (c) 音量を変えるとlevelが変わる(v1とv15で有意にdiffer)
//   (d) getSnapshotEntryByteSize()と各オフセット/カウントが矛盾しない
//
// 陽性対照(FFT): MucomWeb.cppのProcessAudioRequest()/RenderFramesForTest()内の
// FftFeed(...)呼び出しを一時コメントアウトして再ビルド→本スクリプト再実行→
// (b)が単独でFAILすることを確認してから元に戻す、という故障注入テストを
// 実施する(手順・結果は verify_right_pane_data_mucom_fault_injection_log.txt に記録)。
//
// 陽性対照(レベルメーター): MucomWeb.cppのPushSnapshot()内のBuildLevels(...)呼び出しを
// 一時コメントアウトして再ビルド→本スクリプト再実行→レベル系の(b)(c)が単独でFAILする
// ことを確認してから元に戻す(手順・結果はdocs/right-pane-data.mdに記録)。
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

// 最新スナップショットのlevels[](19ch x 5フィールド)を
// [{level,pan,prog,key,playing}, ...] として返す。無効なら null。
function readLatestLevels(Module) {
  const writeIndex = Module.getSnapshotWriteIndex() >>> 0;
  const ringSize = 2048; // SnapshotRingSize (MucomWeb.cpp)
  if (writeIndex === 0xffffffff || writeIndex === 0) return null;
  const entryBytes = Module.getSnapshotEntryByteSize();
  const ringPtr = Module.getSnapshotRingPointer();
  const idx = (writeIndex - 1) % ringSize;
  const base = ringPtr + idx * entryBytes;

  const levelOffset = Module.getSnapshotLevelOffset();
  const levelCount = Module.getLevelCount();
  const fieldCount = Module.getLevelFieldCount();
  const wordBase = (base + levelOffset) / 4;
  const out = [];
  for (let ch = 0; ch < levelCount; ch++) {
    const o = wordBase + ch * fieldCount;
    out.push({
      level: Module.HEAP32[o + 0],
      pan: Module.HEAP32[o + 1],
      prog: Module.HEAP32[o + 2],
      key: Module.HEAP32[o + 3],
      playing: Module.HEAP32[o + 4],
    });
  }
  return out;
}

// 1パートだけ鳴らすMMLをコンパイル・再生し、最新のlevels[]を返す。
async function renderSinglePart(Module, part, note, sampleRate) {
  const mml = `${part} ${note}`;
  const compileLog = Module.compileMML(mml, sampleRate);
  if (Module.getSampleRate() !== sampleRate) {
    throw new Error(`compileMML failed for "${mml}": ${compileLog}`);
  }
  // 0.6秒分。実測(node直実行)では0.3秒だとFM音源のエンベロープ立ち上がり前で
  // absSum=0のまま(音量が実際に出るまでにアタックタイムぶんの遅延がある)。
  // 0.5秒からは非0を確認できたため、安全マージンを見て0.6秒にした。
  Module.renderFramesForTest(Math.round(sampleRate * 0.6));
  return readLatestLevels(Module);
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

  // ============================================================
  // レベルメーター(19ch)の検証
  // ============================================================

  // --- (d) レイアウト整合性 ---
  const levelOffset = Module.getSnapshotLevelOffset();
  const levelCount = Module.getLevelCount();
  const levelFieldCount = Module.getLevelFieldCount();
  check('(d) getLevelCount() === 19', levelCount === 19, `actual=${levelCount}`);
  check('(d) getLevelFieldCount() === 5', levelFieldCount === 5, `actual=${levelFieldCount}`);
  check('(d) levelOffset > fftOffset(fftの後に置いた設計どおり)', levelOffset > fftOffset,
    `levelOffset=${levelOffset} fftOffset=${fftOffset}`);
  check('(d) levelOffset + levelCount*fieldCount*4 <= entryBytes',
    levelOffset + levelCount * levelFieldCount * 4 <= entryBytes,
    `levelOffset=${levelOffset} levelCount=${levelCount} fieldCount=${levelFieldCount} entryBytes=${entryBytes}`);

  // --- (a) 無音時は0、全levelが非負 ---
  {
    // 全パート休符(MML未対応のパートは省略してもtracks[]は0初期化される)。
    const compileLog = Module.compileMML('A r1', sampleRate);
    check('無音MMLがcompileMML()できた', typeof compileLog === 'string');
    Module.renderFramesForTest(Math.round(sampleRate * 0.3));
    const levels = readLatestLevels(Module);
    check('無音再生後にスナップショットが取得できる', levels !== null);
    if (levels) {
      const allNonNegative = levels.every((l) => l.level >= 0);
      check('(a) 全levelが非負', allNonNegative,
        `min=${Math.min(...levels.map((l) => l.level))}`);
      const allZero = levels.every((l) => l.level === 0);
      check('(a) 無音時は全levelが0', allZero,
        `nonzero=${levels.map((l, i) => (l.level !== 0 ? i : null)).filter((i) => i !== null).join(',')}`);
    }
  }

  // --- (b) 1パートだけ鳴らした時、対応するindexだけが非0(チャンネル対応表の実測) ---
  // docs/right-pane-data.md §6bに記録した対応表: index 0-9はFM1-6/SSG1-3/リズム、
  // index10はADPCM、index11-18(PPZ8)はMUCOMに存在しないため対象外。
  //
  // SSG(D,E,F)は`@4`(SSG用音色)を明示しないと無音のまま(probe_mucom_pchdata.mjsの
  // コメントと同じ罠)。ADPCM(K)は`#pcm`ディレクティブでPCMデータを読み込まないと
  // 実際のKeyOnが起きない(docs/mucom-pchdata-mapping.md §実測結果参照)ため、
  // upstream/MucomWeb/mucom88/package/mucompcm.bin を絶対パスで指定する
  // (このリポジトリの成果物ではなく、既存パッケージに元から入っている音色/PCM
  // アセットを検証用に読むだけ。mucomweb/build-web/ 側や本番の音色ロード経路は
  // 変更していない)。
  //
  // リズム(G)は特別扱い: mucomvm::InitSoundSystem()がOPNA::Init()を
  // rhythmpath省略(=nullptr)で呼んでいる(mucomvm.cpp実測)ため、このフォークは
  // *ビルド全体を通じて* リズムPCMサンプルを一切ロードしない
  // (OPNA::RhythmMix()の`rhythm[0].sample && ...`ガードが常にfalseで早期return)。
  // これは今回のパッチが原因ではなく、MucomWeb全体の既存の構造的制約
  // (実機YM2608のリズムサンプルROMデータをこのOSSフォークが同梱していない)。
  // よってindex9は「常に0」が正しい挙動であり、非0を要求するテストにはしない。
  const PCM_PATH = path.join(__dirname, '../upstream/MucomWeb/mucom88/package/mucompcm.bin');
  const SINGLE_PART_CASES = [
    { part: 'A', note: '@1o4c1', index: 0, label: 'FM1' },
    { part: 'B', note: '@1o4c1', index: 1, label: 'FM2' },
    { part: 'C', note: '@1o4c1', index: 2, label: 'FM3' },
    { part: 'H', note: '@1o4c1', index: 3, label: 'FM4' },
    { part: 'I', note: '@1o4c1', index: 4, label: 'FM5' },
    { part: 'J', note: '@1o4c1', index: 5, label: 'FM6' },
    { part: 'D', note: '@4v10o4c1', index: 6, label: 'SSG1' },
    { part: 'E', note: '@4v10o4c1', index: 7, label: 'SSG2' },
    { part: 'F', note: '@4v10o4c1', index: 8, label: 'SSG3' },
    { part: 'G', note: '@8 v52,21,21,21,20,21,21 l16c1', index: 9, label: 'Rhythm', expectAlwaysZero: true },
    { part: 'K', note: '@1v50o1l16c1', index: 10, label: 'ADPCM', prelude: `#pcm ${PCM_PATH}\n` },
  ];
  const mapping = [];
  for (const c of SINGLE_PART_CASES) {
    const mml = `${c.prelude || ''}${c.part} ${c.note}`;
    const compileLog = Module.compileMML(mml, sampleRate);
    // getSampleRate()はコンパイル失敗時も直前の成功値を保持したままなので
    // (g_sampleRateは成功時のみ更新、MucomWeb.cpp CompileMML()参照)、
    // 全ケース同じsampleRateを使う本テストでは成否判定に使えない。
    // 代わりにコンパイルログのエラー文言で判定する。
    const compileFailed = /Error trap|Unknown message|error in line/.test(compileLog);
    if (compileFailed || Module.getSampleRate() !== sampleRate) {
      check(`(b) ${c.label}(part ${c.part}) -> index${c.index}`, false, `compileMML failed: ${compileLog}`);
      continue;
    }
    Module.renderFramesForTest(Math.round(sampleRate * 0.8));
    const levels = readLatestLevels(Module);
    if (!levels) {
      check(`(b) ${c.label}(part ${c.part}) -> index${c.index}`, false, 'no snapshot');
      continue;
    }
    const nonZeroIdx = levels.map((l, i) => (l.level !== 0 ? i : -1)).filter((i) => i >= 0);
    if (c.expectAlwaysZero) {
      // リズムはこのビルドでは構造的に常に無音(上のコメント参照)。
      // 「index9を含めどのindexも非0にならない」ことを確認する(非0が
      // 出たら、リズムサンプルのロード経路が変わった/別chに漏れている
      // ことを示すので、その時はこのテスト自体を見直す)。
      const ok = nonZeroIdx.length === 0;
      check(`(b) ${c.label}(part ${c.part}) は本フォークでは構造的に常に無音(index9も含め全0)`,
        ok, `nonZeroIdx=[${nonZeroIdx.join(',')}]`);
      mapping.push({ ...c, level: levels[c.index].level, ok, actualNonZero: nonZeroIdx, note: '常に無音(既知の制約、パッチ起因ではない)' });
      continue;
    }
    const onlyExpected = nonZeroIdx.length === 1 && nonZeroIdx[0] === c.index;
    const expectedNonZero = levels[c.index].level !== 0;
    check(`(b) ${c.label}(part ${c.part}) 単独再生でindex${c.index}のみ非0`,
      onlyExpected, `nonZeroIdx=[${nonZeroIdx.join(',')}] level[${c.index}]=${levels[c.index].level}`);
    mapping.push({ ...c, level: levels[c.index].level, ok: onlyExpected, actualNonZero: nonZeroIdx });
    if (!onlyExpected && !expectedNonZero) {
      check(`  (参考)${c.label}: index${c.index}自体も非0にならなかった(配線漏れの疑い)`, false);
    }
  }
  console.log('\n--- チャンネル対応表(実測) ---');
  for (const m of mapping) {
    console.log(`  index${m.index} (${m.label}, part ${m.part}): level=${m.level} nonZeroIdx=[${m.actualNonZero.join(',')}] ${m.ok ? 'OK' : 'MISMATCH'}${m.note ? ' - ' + m.note : ''}`);
  }

  // --- (c) 音量を変えるとlevelが変わる(v1 vs v15) ---
  {
    const lowLevels = await renderSinglePart(Module, 'A', '@1v1o4c1', sampleRate);
    const highLevels = await renderSinglePart(Module, 'A', '@1v15o4c1', sampleRate);
    if (lowLevels && highLevels) {
      const low = lowLevels[0].level;
      const high = highLevels[0].level;
      check('(c) v15の音量がv1より有意に大きい(index0=FM1)', high > low * 1.5,
        `v1=${low} v15=${high}`);
    } else {
      check('(c) 音量比較スナップショットが取得できる', false);
    }
  }

  console.log(failCount === 0 ? `\nALL PASS` : `\n${failCount} CHECK(S) FAILED`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
