#!/usr/bin/env node
// PMD `.M` コンパイラ v1 第1段階の検証: tools/gen_pmd_min.mjs で組み立てた
// 「FM1パート1音だけの最小 .M」を pmdweb(98fmplayer wasm)へ直接ロードし、
//   (1) flat_track_status(pmdweb/src/PmdCore.c:37-43) が意図した音程・音色番号になっているか
//   (2) 実際に音声が出ているか(renderFramesForTest の絶対値和)
//   (3) 音色テーブルのTLを変えたら出力が変わるか(陽性対照)
// を機械的に照合する。作法は tools/verify_right_pane_data.mjs / tools/probe_mucom_pchdata.mjs に揃える。
//
// 実行: node tools/verify_pmd_min.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import { buildSingleFmNoteFile, noteByte } from './gen_pmd_min.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
void __dirname;

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

// FMDRIVER_TRACK_FM_1 = 0 (fmdriver.h:9), FIELD_COUNT=26 (PmdCore.c:23,37-43)
const TRACK_FM1_INDEX = 0;
const FIELD_COUNT = 26;
const FIELD = {
  playing: 0, info: 1, ticks: 2, ticks_left: 3, key: 4, actual_key: 5,
  tonenum: 6, volume: 7, gate: 8, detune: 9,
};

function readTrackFm1(Module) {
  const writeIndex = Module.getSnapshotWriteIndex() >>> 0;
  const ringSize = 2048; // SNAPSHOT_RING_SIZE (PmdCore.c)
  if (writeIndex === 0xffffffff || writeIndex === 0) return null;
  const entryBytes = Module.getSnapshotEntryByteSize();
  const ringPtr = Module.getSnapshotRingPointer();
  const idx = (writeIndex - 1) % ringSize;
  const base = ringPtr + idx * entryBytes;
  const tracksBase = base + 4; // frame(uint32)の直後 = tracks[0]
  const trackBase = tracksBase + TRACK_FM1_INDEX * FIELD_COUNT * 4;
  const words = new Int32Array(FIELD_COUNT);
  const base32 = trackBase / 4;
  for (let i = 0; i < FIELD_COUNT; i++) words[i] = Module.HEAP32[base32 + i];
  return words;
}

// 単音は短時間で「終端(0x80)到達→actual_note=0xffにリセット」まで進んでしまうため
// (fmdriver_pmd.c:5161-5164)、一気に数秒レンダリングしてから最後のスナップショットを
// 読むと既に終わった後の状態(key=0xff, playing=0)しか見えない。
// 小刻みにレンダリングしながら「keyが休符でなくなった直後」のスナップショットを
// 別途保持し、音量測定用の absSum は継続して積算する。
async function playAndMeasure(bytes, filename, { chunkFrames = 2048, maxChunks = 200 } = {}) {
  const Module = await createPmdWeb();
  Module.FS.writeFile(`/${filename}`, bytes);
  const error = Module.playMusic(`/${filename}`);
  if (error !== '') throw new Error(`playMusic failed: ${error}`);
  const sampleRate = Module.getSampleRate();

  let absSum = 0;
  let activeTrack = null; // key != 0xff を初めて観測した時点のスナップショット
  let endedAfterActive = false;
  for (let i = 0; i < maxChunks; i++) {
    absSum += Module.renderFramesForTest(chunkFrames);
    const track = readTrackFm1(Module);
    if (!track) continue;
    const key = track[FIELD.key] & 0xff;
    if (!activeTrack && key !== 0xff) {
      activeTrack = track;
    }
    if (activeTrack && track[FIELD.playing] === 0) {
      endedAfterActive = true;
      break;
    }
  }
  return { Module, absSum, track: activeTrack, endedAfterActive, sampleRate };
}

async function main() {
  console.log('=== 段階1: 最小.Mを組み立てて再生し、flat_track_status を照合 ===\n');

  const OCTAVE = 4;
  const NOTE_INDEX = 0; // 'c'
  const TONENUM = 1;
  const LENGTH = 24; // 96/4 = 4分音符

  const bytesLoud = buildSingleFmNoteFile({
    tonenum: TONENUM,
    octave: OCTAVE,
    noteIndex: NOTE_INDEX,
    length: LENGTH,
    toneOverrides: { tl: [0, 0, 0, 0], alg: 7, fb: 0 },
  });

  console.log(`生成した .M: ${bytesLoud.length} bytes`);
  console.log('  hex: ' + Buffer.from(bytesLoud).toString('hex'));

  const { absSum: absSumLoud, track: trackLoudRaw, endedAfterActive, sampleRate } =
    await playAndMeasure(bytesLoud, 'min_loud.m');

  const expectedKey = noteByte(OCTAVE, NOTE_INDEX);

  check('レンダリング中にkeyが休符(0xff)以外になった瞬間を観測できた', trackLoudRaw !== null);
  check('その後トラックが終端(0x80)まで到達した(1音鳴らして終わる想定通り)', endedAfterActive);
  const trackLoud = trackLoudRaw ?? new Int32Array(FIELD_COUNT).fill(-1);

  console.log('\n--- flat_track_status[FM1] (TL=0 variant) ---');
  console.log(`  playing=${trackLoud[FIELD.playing]} tonenum=${trackLoud[FIELD.tonenum]} ` +
    `key=0x${(trackLoud[FIELD.key] & 0xff).toString(16)} volume=${trackLoud[FIELD.volume]} ` +
    `gate=${trackLoud[FIELD.gate]} ticks=${trackLoud[FIELD.ticks]}`);

  check('tonenum が @1 の通り 1 になっている', trackLoud[FIELD.tonenum] === TONENUM,
    `actual=${trackLoud[FIELD.tonenum]}`);
  check(`key が意図した (oct<<4)|note = 0x${expectedKey.toString(16)} と一致`,
    (trackLoud[FIELD.key] & 0xff) === expectedKey,
    `actual=0x${(trackLoud[FIELD.key] & 0xff).toString(16)}`);
  check('volume が FM初期値 108 のまま(Vコマンド未使用)', trackLoud[FIELD.volume] === 108,
    `actual=${trackLoud[FIELD.volume]}`);

  // 陽性対照(検査ロジック自体の生存確認): わざと違う値を期待させて FAIL することを確認する。
  const sentinelWrongKey = (expectedKey + 1) & 0xff;
  const sentinelCheckShouldFail = (trackLoud[FIELD.key] & 0xff) === sentinelWrongKey;
  check('[陽性対照] 意図的に誤ったkey期待値は一致しない(検査自体が壊れていない証明)',
    sentinelCheckShouldFail === false,
    `wrong-expected=0x${sentinelWrongKey.toString(16)} actual=0x${(trackLoud[FIELD.key] & 0xff).toString(16)}`);

  check('renderFramesForTest() が非0の音声を生成した(音が出ている証拠)', absSumLoud > 0,
    `absSum=${absSumLoud} sampleRate=${sampleRate}`);

  // --- 陽性対照: 音色パラメータ(TL)を変えたら出力が変わるか ---
  console.log('\n=== 段階2: 音色TLを変えて出力が変わることを確認(陽性対照) ===\n');
  const bytesQuiet = buildSingleFmNoteFile({
    tonenum: TONENUM,
    octave: OCTAVE,
    noteIndex: NOTE_INDEX,
    length: LENGTH,
    toneOverrides: { tl: [100, 100, 100, 100], alg: 7, fb: 0 },
  });
  const { absSum: absSumQuiet, track: trackQuietRaw } = await playAndMeasure(bytesQuiet, 'min_quiet.m');
  const trackQuiet = trackQuietRaw ?? new Int32Array(FIELD_COUNT).fill(-1);

  console.log(`  TL=0   absSum=${absSumLoud}`);
  console.log(`  TL=100 absSum=${absSumQuiet}`);

  check('tonenum/keyはTLを変えても変化しない(TL以外は同一データの確認)',
    trackQuiet[FIELD.tonenum] === TONENUM && (trackQuiet[FIELD.key] & 0xff) === expectedKey);
  check('[陽性対照] TLを0→100に上げると出力(absSum)が変化する(音色テーブルが効いている証拠)',
    absSumQuiet !== absSumLoud && absSumLoud > 0 && absSumQuiet >= 0,
    `absSumLoud=${absSumLoud} absSumQuiet=${absSumQuiet} ratio=${(absSumQuiet / absSumLoud).toFixed(4)}`);
  check('[陽性対照] TL=100(より減衰)の方がTL=0より出力が小さい',
    absSumQuiet < absSumLoud,
    `absSumLoud=${absSumLoud} absSumQuiet=${absSumQuiet}`);

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
