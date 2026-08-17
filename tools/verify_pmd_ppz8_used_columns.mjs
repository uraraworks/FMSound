#!/usr/bin/env node
// PPZ8列(11-18)の「曲ごとの使用判定」を、実際にwasmドライバを動かして検証する
// (fmdsp/channel-mask.js unusedColumnsFromChannensの第2引数ppz8UsedChannels、
// および html/pmd-app.js draw()内のsticky蓄積ロジックの、実際の駆動データに
// 対する挙動)。
//
// 背景: PmdCore.c/fmdriver.hのtrack_status[...].info(FMDRIVER_TRACK_INFO_PPZ8)
// で判定できると当初想定していたが、実測したところ upstream/98fmplayer/
// fmdriver/fmdriver_pmd.c の pmd_work_status_update() はPPZ8トラックにも
// 常に FMDRIVER_TRACK_INFO_NORMAL を書き込む(5831行)ため使えないと判明した
// (FMDRIVER_TRACK_INFO_PPZ8を実際にセットするのは、このアプリが使わない
// fmdriver_fmp.c側のみ)。代わりに track_status[...].playing が、PPZ8バンクの
// 有無に関わらず、ppz8_init拡張コマンド(0xB4。upstream/98fmplayer/fmdriver/
// fmdriver_pmd.c pmd_cmd_table_adpcm、4249行 pmd_cmdb4_ppz8_init)でそのPPZ8ch
// が起動された瞬間にfalse->trueへ切り替わることを本スクリプトの土台となった
// 実測で確認した(注: pmd_cmd_table_fm側の同位置(0xb4)はpmd_cmd_null_16で
// 無効。ppz8_initはADPCMパートの拡張コマンドとしてのみ機能する)。
//
// `.M`はcompiler/gen_pmd_min.mjs同様の手法で直接バイナリ組み立て(PPZ8バンクは
// 用意できないため、バンク無しのまま。バンクが無くてもtrack_status.playingは
// 切り替わることを確認済み)。
//
// 実行: node tools/verify_pmd_ppz8_used_columns.mjs
// (pmdweb/build-web/pmdweb.js が事前にビルド済みであること)

import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import { buildToneEntry, noteByte } from '../compiler/gen_pmd_min.mjs';
import { unusedColumnsFromChannels, PPZ8_CHANNELS } from '../fmdsp/channel-mask.js';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

const FIELD_COUNT = 26;
const FIELD_PLAYING = 0;
const SNAPSHOT_RING_SIZE = 2048;
const PPZ8_TRACK_START = 13; // FMDRIVER_TRACK_PPZ8_1 (fmdriver.h enum順、html/pmd-app.js参照)

function readTrack(Module, trackIndex) {
  const writeIndex = Module.getSnapshotWriteIndex() >>> 0;
  if (writeIndex === 0xffffffff || writeIndex === 0) return null;
  const entryBytes = Module.getSnapshotEntryByteSize();
  const ringPtr = Module.getSnapshotRingPointer();
  const idx = (writeIndex - 1) % SNAPSHOT_RING_SIZE;
  const base = ringPtr + idx * entryBytes;
  const tracksBase = base + Module.getSnapshotHeaderWordCount() * 4;
  const trackBase = tracksBase + trackIndex * FIELD_COUNT * 4;
  const words = new Int32Array(FIELD_COUNT);
  const base32 = trackBase / 4;
  for (let i = 0; i < FIELD_COUNT; i++) words[i] = Module.HEAP32[base32 + i];
  return words;
}

// `.M`最小バイナリを組み立てる。triggerPpz1=trueなら、ADPCMパートの先頭で
// 0xB4(ppz8_init)によりPPZ8ch1を起動してからPPZ1パートのトラックへ飛ばす
// (fmdriver_pmd.c pmd_cmdb4_ppz8_init、4249-4271行の書式どおり: 8ch分の
// 2byteポインタ×8=16byte、非0のch(=ここではch0/PPZ1のみ)がppzpart->ptrへ
// 反映される)。falseなら通常のFM1単音+ADPCM単音のみ(PPZ8には一切触れない)。
function buildFile({ triggerPpz1 }) {
  const HEADER_LEN = 0x1a;
  const EMPTY_TRACK_OFF = HEADER_LEN;
  const FM1_TRACK_OFF = EMPTY_TRACK_OFF + 1;
  const fm1Note = [0xff, 1, noteByte(4, 0), 96, 0x80];
  const FM1_TRACK_LEN = fm1Note.length;
  const ADPCM_TRACK_OFF = FM1_TRACK_OFF + FM1_TRACK_LEN;

  const adpcmPrefix = triggerPpz1 ? [0xb4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] : [];
  const adpcmNote = [0xff, 1, noteByte(4, 0), 96, 0x80];
  const ADPCM_TRACK_LEN = adpcmPrefix.length + adpcmNote.length;
  const PPZ1_TRACK_OFF = ADPCM_TRACK_OFF + ADPCM_TRACK_LEN;
  const ppz1Track = Uint8Array.from([0xff, 1, noteByte(4, 0), 96, 0x80]);
  const TONE_OFF = PPZ1_TRACK_OFF + ppz1Track.length;

  const tone = buildToneEntry({ tonenum: 1 });
  const relLen = TONE_OFF + tone.length;
  const rel = new Uint8Array(relLen);
  function w16(off, val) { rel[off] = val & 0xff; rel[off + 1] = (val >> 8) & 0xff; }

  w16(0x00, FM1_TRACK_OFF); // FM1
  for (let i = 1; i < 9; i++) w16(i * 2, EMPTY_TRACK_OFF); // FM2-6, SSG1-3
  w16(9 * 2, ADPCM_TRACK_OFF); // ADPCM
  w16(10 * 2, EMPTY_TRACK_OFF); // RHYTHM
  w16(0x16, EMPTY_TRACK_OFF); // r_offset(未使用)
  w16(0x18, TONE_OFF); // tone_ptr
  rel[EMPTY_TRACK_OFF] = 0x80;
  rel.set(Uint8Array.from(fm1Note), FM1_TRACK_OFF);

  const adpcmBytes = new Uint8Array(ADPCM_TRACK_LEN);
  adpcmBytes.set(adpcmPrefix, 0);
  adpcmBytes.set(adpcmNote, adpcmPrefix.length);
  if (triggerPpz1) {
    // 0xb4直後、ch0(PPZ1)ぶんの2byteポインタだけPPZ1_TRACK_OFFへ(LE)。
    // 残り7ch分(ch1-7)は0のままなので起動されない。
    adpcmBytes[1] = PPZ1_TRACK_OFF & 0xff;
    adpcmBytes[2] = (PPZ1_TRACK_OFF >> 8) & 0xff;
  }
  rel.set(adpcmBytes, ADPCM_TRACK_OFF);
  rel.set(ppz1Track, PPZ1_TRACK_OFF);
  rel.set(tone, TONE_OFF);

  const file = new Uint8Array(1 + relLen);
  file[0] = 0; // opm_flag
  file.set(rel, 1);
  return file;
}

// html/pmd-app.js draw()と同じsticky蓄積ロジック(1度でもplaying!==0を観測した
// PPZ8chをpmdPpz8UsedChannelsへ加える)を、この検証専用に再現する。
async function playAndCollectPpz8Used(Module, fileBytes, chunkFrames, maxChunks) {
  Module.FS.writeFile('/ppz8probe.m', fileBytes);
  const error = Module.playMusic('/ppz8probe.m');
  if (error) throw new Error(`playMusic failed: ${error}`);
  const used = new Set();
  for (let i = 0; i < maxChunks; i++) {
    Module.renderFramesForTest(chunkFrames);
    for (let p = 0; p < 8; p++) {
      const track = readTrack(Module, PPZ8_TRACK_START + p);
      if (track && track[FIELD_PLAYING] !== 0) used.add(PPZ8_CHANNELS[p]);
    }
  }
  return used;
}

async function main() {
  console.log('=== PPZ8列(11-18)の曲ごとの使用判定 実測検証 ===\n');

  const Module = await createPmdWeb();

  // A. [本体] PPZ8パートを実際に使う曲(PPZ1をppz8_initで起動)を再生すると、
  //    PPZ1列(11)がunusedに含まれなくなる。PPZ8バンクは読み込んでいない
  //    (用意できないため)が、track_status.playingはバンクの有無に関わらず
  //    切り替わる(上のコメント参照)。
  const fileUsed = buildFile({ triggerPpz1: true });
  const usedA = await playAndCollectPpz8Used(Module, fileUsed, 64, 30);
  console.log(`(A) PPZ1を使う曲: 観測したppz8UsedChannels=${[...usedA].join(',') || '(空)'}`);
  check('A. [本体] PPZ1を起動する曲では、track_status.playingがtrueになる(実測できている)',
    usedA.has('PPZ8_1'), `usedA=${[...usedA]}`);
  const columnsA = unusedColumnsFromChannels(null, usedA);
  check('A. [本体] PPZ1を使う曲では列11(PPZ1)がunusedに含まれない',
    !columnsA.has(11), `unused=${[...columnsA].sort((a, b) => a - b)}`);
  check('A. 触れていないPPZ2-8(列12-18)はunusedのまま',
    [12, 13, 14, 15, 16, 17, 18].every((c) => columnsA.has(c)), `unused=${[...columnsA].sort((a, b) => a - b)}`);

  // B. [本体] PPZ8に一切触れない曲では、従来どおりPPZ8列(11-18)が全てunused。
  const ModuleB = await createPmdWeb();
  const fileUnused = buildFile({ triggerPpz1: false });
  const usedB = await playAndCollectPpz8Used(ModuleB, fileUnused, 64, 30);
  console.log(`(B) PPZ8に触れない曲: 観測したppz8UsedChannels=${[...usedB].join(',') || '(空)'}`);
  check('B. [本体] PPZ8に触れない曲ではtrack_status.playingが一度もtrueにならない',
    usedB.size === 0, `usedB=${[...usedB]}`);
  const columnsB = unusedColumnsFromChannels(null, usedB);
  check('B. [本体] PPZ8に触れない曲ではPPZ8列(11-18)が全てunused',
    [11, 12, 13, 14, 15, 16, 17, 18].every((c) => columnsB.has(c)), `unused=${[...columnsB].sort((a, b) => a - b)}`);

  // C. [陽性対照] 一律unused判定に戻した状態(=sticky観測をせず、常に空集合を
  //    渡す旧実装相当)を、Aと同じ「PPZ1を実際に使っている曲」に対して適用すると、
  //    列11が実際にunusedへ含まれてしまう(=鳴っているのにメーターだけ暗いまま
  //    という、利用者が報告した症状そのものを再現する)。
  const columnsOldStyle = unusedColumnsFromChannels(null, new Set()); // 旧実装は常にこの形
  check('C. [陽性対照] 一律unused判定(旧実装相当)だと、Aと同じ曲でも列11がunusedに含まれてしまう(=暗いままの症状を再現)',
    columnsOldStyle.has(11), `unused=${[...columnsOldStyle].sort((a, b) => a - b)}`);

  console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
  if (failCount > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
