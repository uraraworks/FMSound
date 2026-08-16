#!/usr/bin/env node
// サンプルMML集(MUCOM88サンプル曲、46曲)全体でのADPCM(Kパート)再生状況を実測する。
//
// 目的: docs/mucom-adpcm-corpus-measurement.md へ記録する実測データを作る。
// tools/verify_mucom_adpcm.mjs が単発のMMLで確かめた「標準PCMバンクが読み込まれて
// いればKパートは鳴る/#pcmが解決できなくても標準バンクで鳴る」という個別の仕組みを、
// 実際のサンプル曲集46曲に対して回し、コンパイル成功数・Kパートを持つ曲数・実際に
// ADPCMが鳴った曲数を数える。
//
// 重要: 製品(html/mucom-app.js)と同じ前処理を通す。具体的には:
//   - `ui/mucom-voice-resolve.js` の resolveMucomVoiceNameRefs() で `@"名前"` を
//     `@番号` へ事前解決する(非ASCII音色名を持つ曲がこれを経ないとコンパイルエラーに
//     なる。html/mucom-app.js compileAndPlay()参照)。
//   - `net/voice-bank.js` の findPairedVoiceBank() で曲と対になるシステムディスクの
//     voice.datを見つけ、見つかれば `#voice <MEMFSパス>` をコンパイル専用テキストの
//     先頭へ注入する(html/mucom-app.js compileAndPlay()と同じ手順)。
//   - Kパート(ADPCM)用の標準PCMバンク(html/mucompcm.bin)をMEMFSへ書き込む
//     (html/mucom-app.js loadPcmBank()と同じ。MucomWeb.cpp CompileMML()が
//     コンパイル成功のたびに読みに行く固定パス)。
//
// テストデータ(サンプルMML集のzip)は著作物(CC BY-NC-ND 4.0、古代祐三氏著作)であり
// リポジトリには絶対にコミットしない。zipの場所は環境変数 MCM_SAMPLE_ZIP で受け取り、
// tools/verify_d88.mjs等と同じ作法にする(未設定なら明示的にエラーで終了する。
// このスクリプト自体の目的が実データの計測であるため、他の検証スクリプトのように
// 「未設定ならスキップ」にはしない)。
//
// 判定基準(このスクリプトが決めたもの。README/help.html等の一般的な説明とは別に、
// ここに明記する):
//   (1) コンパイル成功 = コンパイルログに "#error" を含まない
//       (tools/verify_mucom_adpcm.mjsと同じ判定)。
//   (2) Kパートを持つ曲かどうか = コンパイルログの "[ Total count ]" 行にある
//       "K:<tick数>" が0より大きいこと。これはMUCOM88コンパイラ自身がMMLを解析して
//       出す集計であり、MMLテキストへの正規表現より確実(コメント行やタグ行を
//       誤って拾わない)。Kトラックに休符しか無い曲も「Kパートを持つ」に含まれる
//       (=コンパイラがそのトラックにデータを割り当てている、という基準)。
//   (3) 実際にADPCMが鳴ったか = レンダリング中に一度でも
//       StatusSnapshot.chstat[OPNACH_ADPCM](mucomvm::GetChStatus(10)、ADPCM
//       チャンネルのキーオン状態)が非0になったこと。絶対値和(absSum)は使わない
//       (Kパート単体を分離できないため。他パートの出力に埋もれて誤判定する)。
//
// レンダリングは256フレーム刻み(StatusSnapshotの記録粒度、MucomWeb.cpp
// FramesPerSnapshot)で行い、毎回直後にchstat[ADPCM]を確認する(=見逃しなく
// 追える)。Kパートを持つ曲(上記(2))だけを対象にレンダリングし、ADPCMキーオンを
// 検出した時点で打ち切る(早期終了)。Kパートを持たない曲(コンパイラの集計でK側
// tick数が0)は、ADPCMが鳴りようがないためレンダリングせずに「対象外」として数える。
// 1曲あたりの打ち切り時間は下記 RENDER_BUDGET_SECONDS 秒。打ち切りまで検出できな
// かった曲は「取りこぼした可能性がある曲」として別途数える(黙って除外しない)。
//
// 実行: MCM_SAMPLE_ZIP=/path/to/mcm.zip node tools/measure_mucom_adpcm_corpus.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import createMucomWeb from '../mucomweb/build-web/mucom88.js';
import { extractArchive } from '../net/archive.js';
import { findSongCandidates } from '../net/song-select.js';
import { findPairedVoiceBank } from '../net/voice-bank.js';
import { resolveMucomVoiceNameRefs } from '../ui/mucom-voice-resolve.js';
import { decodeMmlBytes } from '../net/charset.js';
import { MUCOM_DEFAULT_VOICE_NAMES } from '../ui/mucom-voice-table.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PCM_BANK_PATH = path.join(REPO_ROOT, 'html/mucompcm.bin');
const SAMPLE_RATE = 55467;

// html/mucom-app.js compileAndPlay()と同じ: MMLが既に#voiceヘッダを持っている場合は
// そちらを尊重し、対になるシステムディスクのバンクを上書きしない。
const EXPLICIT_VOICE_TAG_RE = /^[ \t]*#voice\b/im;
const VOICE_BANK_MEMFS_PATH = '/voicebank_ext.dat';

// StatusSnapshot(mucomweb/src/MucomWeb.cpp)のワード配置:
//   word 0-3   = frame, passTick, intCount, maxCount
//   word 4-19  = chstat[16] (OpnaChannelCount=16、mucomvm.h OPNACH_MAX)
//   以降       = tracks[]/fft[]/levels[]
// GetSnapshotHeaderWordCount() は 4+16=20 を返す(MucomWeb.cpp)。
// OPNACH_ADPCM=10 (mucomvm.h、コメント: cmucom.cpp mucomvm::GetChStatus呼び出し箇所)。
const OPNA_CHANNEL_COUNT = 16;
const OPNACH_ADPCM = 10;
const SNAPSHOT_RING_SIZE = 2048; // SnapshotRingSize (MucomWeb.cpp)

const RENDER_BUDGET_SECONDS = 240; // 1曲あたりの打ち切り時間(4分ぶんの音声)
const RENDER_CHUNK_FRAMES = 256; // FramesPerSnapshotと同じ刻みで毎回chstatを確認する

function readLatestAdpcmChstat(Module) {
  const writeIndex = Module.getSnapshotWriteIndex() >>> 0;
  if (writeIndex === 0xffffffff || writeIndex === 0) return 0;
  const entryBytes = Module.getSnapshotEntryByteSize();
  const ringPtr = Module.getSnapshotRingPointer();
  const headerWords = Module.getSnapshotHeaderWordCount(); // 20
  const idx = (writeIndex - 1) % SNAPSHOT_RING_SIZE;
  const base = ringPtr + idx * entryBytes;
  const chstatWordOffset = headerWords - OPNA_CHANNEL_COUNT + OPNACH_ADPCM; // 4 + 10 = 14
  const word = (base / 4) + chstatWordOffset;
  return Module.HEAP32[word];
}

async function compileAndGetLog(Module, source) {
  Module.compileMML(source, SAMPLE_RATE);
  const msgPtr = Module.getCompileMessagePointer();
  const msgLen = Module.getCompileMessageLength();
  const bytes = Module.HEAPU8.subarray(msgPtr, msgPtr + msgLen);
  // CP932の生バイトをそのままlatin1へマップする(tools/verify_mucom_adpcm.mjsと同じ
  // 作法)。#error等ASCII部分の判定にだけ使うので文字化けは問題にならない。
  return Buffer.from(bytes).toString('latin1');
}

// net/voice-bank.js MML_DISK_SEGMENT_RE と同じ命名規則("MML_<X>.d88")。
// findSongCandidates()はサンプルMML集の46曲(MML_<X>.d88収録)だけでなく、対になる
// システムディスク(MUCOM88_V<バージョン>_<X>.d88)自身が同梱しているデモ曲
// (sampl1.muc/sampl2.muc/sampl3.muc)も.mucである以上「再生可能な曲候補」として
// 拾ってしまう(実測: 46曲のはずがcandidates.length=55になった。差の9件は
// sampl1/sampl2/sampl3.mucが3枚のシステムディスクに重複して入っていたもの)。
// 今回の計測対象は「サンプルMML集46曲」なので、エントリ名の一つ上の階層が
// "MML_<X>.d88" という命名規則に一致するものだけに絞る(システムディスク収録の
// デモ曲を除外する)。
const MML_DISK_SEGMENT_RE = /^MML_(.+)\.d88$/i;
function isLibrarySongEntry(entryName) {
  const segments = entryName.split('/');
  if (segments.length < 2) return false;
  return MML_DISK_SEGMENT_RE.test(segments[segments.length - 2]);
}

/** コンパイルログの "[ Total count ]" 行から各パートのtick数を取り出す。 @param {string} log */
function parseTotalCountK(log) {
  const m = /\[ Total count \][^\n]*\n([^\n]*)/.exec(log);
  if (!m) return null;
  const km = /K:(\d+)/.exec(m[1]);
  if (!km) return null;
  return parseInt(km[1], 10);
}

async function main() {
  const zipPath = process.env.MCM_SAMPLE_ZIP;
  if (!zipPath) {
    console.error('MCM_SAMPLE_ZIP が未設定です。サンプルMML集zipの絶対パスを環境変数で渡してください。');
    console.error('(著作物のためリポジトリには同梱しない。tools/verify_d88.mjs等と同じ作法)');
    process.exit(1);
  }

  console.log('=== MUCOM88サンプル曲集 ADPCM(Kパート)再生状況計測 ===\n');
  const zipBytes = new Uint8Array(readFileSync(zipPath));
  const entries = await extractArchive(path.basename(zipPath), zipBytes);
  console.log(`展開エントリ数: ${entries.length}`);

  const allCandidates = findSongCandidates(entries).filter((c) => c.driver === 'mucom');
  const candidates = allCandidates.filter((c) => isLibrarySongEntry(c.entry.name));
  const excludedSystemDiskDemos = allCandidates.length - candidates.length;
  console.log(`MUCOM88曲候補数(システムディスク同梱デモ込み): ${allCandidates.length}`);
  console.log(`サンプルMML集(MML_<X>.d88)由来の曲候補数: ${candidates.length}`);
  console.log(`除外(システムディスク同梱デモ曲、sampl*.muc等): ${excludedSystemDiskDemos}\n`);

  const Module = await createMucomWeb();
  const bankBytes = readFileSync(PCM_BANK_PATH);
  Module.FS.writeFile('/mucompcm.bin', new Uint8Array(bankBytes));
  console.log(`標準ADPCMバンクをMEMFSへ書き込み: ${bankBytes.length} bytes\n`);

  const results = [];
  let compileFail = 0;
  let compileOk = 0;
  let hasKPart = 0;
  let sounded = 0;
  let notSoundedWithinBudget = 0;
  let unresolvedNameSongs = 0;

  for (const candidate of candidates) {
    const name = candidate.displayName;
    const voicePair = findPairedVoiceBank(entries, candidate.entry.name, MUCOM_DEFAULT_VOICE_NAMES);
    const { text } = decodeMmlBytes(candidate.entry.data);
    const voiceBankApplied = Boolean(voicePair) && !EXPLICIT_VOICE_TAG_RE.test(text);
    const { text: mmlNameResolved, unresolvedNames } =
      resolveMucomVoiceNameRefs(text, voiceBankApplied ? voicePair.bytes : undefined);
    let mmlForCompile = mmlNameResolved;
    if (voiceBankApplied) {
      Module.FS.writeFile(VOICE_BANK_MEMFS_PATH, voicePair.bytes);
      mmlForCompile = `#voice ${VOICE_BANK_MEMFS_PATH}\n${mmlNameResolved}`;
    }
    if (unresolvedNames.length > 0) unresolvedNameSongs++;

    const log = await compileAndGetLog(Module, mmlForCompile);
    const errorMatch = /#error (\d+) in line (\d+)/.exec(log);
    const ok = !errorMatch;

    const row = {
      name,
      voiceBankApplied,
      unresolvedNameCount: unresolvedNames.length,
      compiled: ok,
    };

    if (!ok) {
      compileFail++;
      row.compileError = `#error ${errorMatch[1]} (line ${errorMatch[2]})`;
      results.push(row);
      console.log(`[COMPILE FAIL] ${name} - ${row.compileError}`);
      continue;
    }
    compileOk++;

    const kTicks = parseTotalCountK(log);
    row.kTicks = kTicks;
    row.hasKPart = kTicks !== null && kTicks > 0;
    if (!row.hasKPart) {
      results.push(row);
      console.log(`[NO K PART] ${name} (K:${kTicks})`);
      continue;
    }
    hasKPart++;

    // Kパートを持つ曲だけレンダリングする(上記コメント参照)。
    const frameBudget = SAMPLE_RATE * RENDER_BUDGET_SECONDS;
    let renderedFrames = 0;
    let adpcmSeen = false;
    while (renderedFrames < frameBudget) {
      Module.renderFramesForTest(RENDER_CHUNK_FRAMES);
      renderedFrames += RENDER_CHUNK_FRAMES;
      if (readLatestAdpcmChstat(Module) !== 0) {
        adpcmSeen = true;
        break;
      }
    }
    row.sounded = adpcmSeen;
    row.renderedSeconds = renderedFrames / SAMPLE_RATE;
    row.hitBudget = !adpcmSeen && renderedFrames >= frameBudget;
    if (adpcmSeen) {
      sounded++;
      console.log(`[SOUNDED] ${name} (K:${kTicks}tick, ${row.renderedSeconds.toFixed(1)}s まで再生して検出)`);
    } else {
      notSoundedWithinBudget++;
      console.log(`[NOT SOUNDED] ${name} (K:${kTicks}tick, ${RENDER_BUDGET_SECONDS}s打ち切りまで未検出)`);
    }
    results.push(row);
  }

  console.log('\n=== 集計 ===');
  console.log(`曲候補数: ${candidates.length}`);
  console.log(`コンパイル成功: ${compileOk} / コンパイル失敗: ${compileFail}`);
  console.log(`Kパートを持つ曲(コンパイラ集計でK側tick数>0): ${hasKPart}`);
  console.log(`実際にADPCMキーオンを検出: ${sounded}`);
  console.log(`${RENDER_BUDGET_SECONDS}秒打ち切りまで未検出(取りこぼしの可能性あり): ${notSoundedWithinBudget}`);
  console.log(`外部音色バンク(voice.dat)を適用した曲: ${results.filter((r) => r.voiceBankApplied).length}`);
  console.log(`@"名前"の解決に失敗した曲: ${unresolvedNameSongs}`);

  const out = {
    generatedAt: new Date().toISOString(),
    zipBaseName: path.basename(zipPath),
    candidateCount: candidates.length,
    compileOk,
    compileFail,
    hasKPart,
    sounded,
    notSoundedWithinBudget,
    renderBudgetSeconds: RENDER_BUDGET_SECONDS,
    voiceBankAppliedCount: results.filter((r) => r.voiceBankApplied).length,
    unresolvedNameSongs,
    results,
  };
  process.stdout.write(`\n__RESULT_JSON__${JSON.stringify(out)}__END_RESULT_JSON__\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
