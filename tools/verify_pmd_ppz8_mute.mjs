#!/usr/bin/env node
// PPZ8列(11-18)のクリックミュート機能の実測検証。
//
// 背景: レベルメーターのホバー枠がADPCM列までで、PPZ8列(11-18)には出ない
// (利用者報告)。従来PPZ8は構造的に鳴らなかったためミュート非対応で問題なかったが、
// PPZ8バンク(.PZI/.PVI)読み込み対応(コミット cb38f21 以降)・メーター曲ごと使用判定
// (b1af53f)で実際に鳴るようになったため、ミュートも要る。
//
// ミュート機構: upstream/98fmplayer/fmdriver/ppz8.h:77-78 ppz8_get_mask()/
// ppz8_set_mask()(8bitマスク)。ppz8.c:208 `if ((1u << p) & (ppz8->mask)) continue;`
// でミックスから外す。PPZ8はOPNAのチャンネルではない(別ミキサー)ため、
// opna_set_mask()系(pmdweb_set_channel_mask())とは別系統
// (pmdweb_set_ppz8_mask()、fmdsp/channel-mask.js buildPpz8Mask())。
//
// 実データ(第三者PZI/PVIファイル)は一切使わない。.PZI形式は
// upstream/98fmplayer/fmdriver/ppz8.c の ppz8_pzi_load() を読んで自前生成する
// (tools/verify_pmd_ppc_load.mjs が.PPCを自前生成しているのと同じ方針)。
// memo経由でppzfile名を.Mへ埋め込む手順は同スクリプトの
// buildFmAndAdpcmFileWithMemo()と同じ pmd_get_memo()/pmd_filenamecopy() 読解に基づく
// (差分はppzfile用にindex補正のflaglowを0x40ではなく0x48にする点。詳細は下記コメント)。
//
// 実行: node tools/verify_pmd_ppz8_mute.mjs
// (pmdweb/build-web/pmdweb.js が事前にビルド済みであること)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import { noteByte } from '../compiler/gen_pmd_min.mjs';
import {
  buildPmdChannelMask, buildPpz8Mask, FM_CHANNELS, SSG_CHANNELS, RHYTHM_CHANNEL, ADPCM_CHANNEL,
  PPZ8_CHANNELS,
} from '../fmdsp/channel-mask.js';
import { writeSongWithPcm } from '../net/pmd-pcm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

const DEADLINE_MS = 180000;
const startTime = Date.now();
function checkDeadline(label) {
  const elapsed = Date.now() - startTime;
  if (elapsed > DEADLINE_MS) {
    console.log(`\n=== 打ち切り: ${label} の時点で ${elapsed}ms 経過(上限${DEADLINE_MS}ms) ===`);
    console.log(`実行済み: ${passCount} PASS / ${failCount} FAIL`);
    process.exit(1);
  }
}

// --- .PZI(ppz8_pzi_load()、ppz8.c:293-313)を自前生成する ---
// ヘッダ: magic "PZI0"(4byte) + パディング(0x20まで)。
// ボイステーブル: 0x20起点、18byte×128エントリ
//   [+0]start(u32LE)*2, [+4]len(u32LE)*2, [+8]loopstart(u32LE),
//   [+12]loopend(u32LE), [+16]origfreq(u16LE)
//   (ppz8_channel_play()でchannel->ptr=(voice->start>>1)<<16、
//   channel->endptr=((voice->start+voice->len)>>1)<<16 に使われるため、
//   ロード時に*2される分を打ち消して「生のstart/len値=サンプル単位のオフセット/長さ」
//   になるよう、ここでは生のstart/lenをそのままサンプル単位で指定する)
// 波形: 0x20+18*128(=0x920)起点、8bit unsigned(0x80中心)。
//   buf->data[i] = (byte-0x80)<<8 でint16化される(ppz8.c:308-310)。
function buildPziFile({ voices, waveform }) {
  const HEADER_LEN = 0x20;
  const VOICE_TABLE_LEN = 18 * 128;
  const WAVEFORM_OFF = HEADER_LEN + VOICE_TABLE_LEN;
  const buf = new Uint8Array(WAVEFORM_OFF + waveform.length);
  buf[0] = 'P'.charCodeAt(0);
  buf[1] = 'Z'.charCodeAt(0);
  buf[2] = 'I'.charCodeAt(0);
  buf[3] = '0'.charCodeAt(0);
  function w16(off, val) { buf[off] = val & 0xff; buf[off + 1] = (val >> 8) & 0xff; }
  function w32(off, val) {
    buf[off] = val & 0xff;
    buf[off + 1] = (val >> 8) & 0xff;
    buf[off + 2] = (val >> 16) & 0xff;
    buf[off + 3] = (val >> 24) & 0xff;
  }
  for (const v of voices) {
    const off = HEADER_LEN + 18 * v.index;
    // ppz8_pzi_load()はread32le()の結果を*2してvoice->start/lenへ格納し、
    // ppz8_channel_play()側で>>1して打ち消す(コメント参照)ため、ここに書く
    // 生の値=サンプル単位のstart/lenそのものでよい。
    w32(off + 0, v.start);
    w32(off + 4, v.len);
    w32(off + 8, v.loopstart === undefined ? 0xffffffff : v.loopstart);
    w32(off + 12, v.loopend === undefined ? 0xffffffff : v.loopend);
    w16(off + 16, v.origfreq);
  }
  buf.set(waveform, WAVEFORM_OFF);
  return buf;
}

// 振幅の大きい矩形波(絶対値和が明確に非0になるように)。
function buildSquareWave(samples) {
  const buf = new Uint8Array(samples);
  for (let i = 0; i < samples; i++) buf[i] = (i % 32) < 16 ? 0x10 : 0xf0;
  return buf;
}

// --- .M本体: ADPCMパートの0xB4(ppz8_init拡張コマンド)でPPZ8chを起動する ---
// (tools/verify_pmd_ppz8_used_columns.mjsのbuildFile()と同じ手法。あちらは
// track_status.playingの検証用でPPZ8バンクを与えなかったが、本スクリプトは
// 実際に音を鳴らす必要があるため上のbuildPziFile()で生成したバンクを併用する)
//
// memo経由のppzfile名埋め込み(pmd_get_memo()、fmdriver_pmd.c:5962-5993)は
// tools/verify_pmd_ppc_load.mjsのbuildFmAndAdpcmFileWithMemo()と同じ仕組みだが、
// index補正のflaglowが異なる: pmd_init()(同ファイル6043-6058行)は
//   pcmfile = pmd_get_memo(pmd, -2)  // ppzfile (index=-2)
//   pcmfile = pmd_get_memo(pmd, -1)  // ppsfile (index=-1)
//   pcmfile = pmd_get_memo(pmd, 0)   // ppcfile (index=0)
// の3回を同じflaglowで呼ぶため、pmd_get_memo()内のindex補正
// (flaglow>=0x42でindex++、flaglow>=0x48でさらにindex++)が全呼び出しに
// 同じだけ効く。flaglow=0x40(verify_pmd_ppc_load.mjsが使う値)だと補正なしで
// index=0のppcfile呼び出しだけがmemoテーブル0番目を拾えるが、ppzfile呼び出しは
// index=-2のまま<0で弾かれる(0を返す)。flaglow=0x48(かつflaghigh=0xfe、
// pmd_get_memo()の「flaglow!=0x40ならflaghigh==0xfeかつflaglow>=0x41必須」条件)
// にすると、ppzfile呼び出しがindex=-2+1+1=0まで補正され、memoテーブル0番目を
// ppzfile名として拾える(ppcfile呼び出しはindex=0+2=2になり、今回用意しない
// 2番目のテーブルエントリを探すが、存在しなければpmd_get_memo()は0を返すだけで
// エラーにはならない)。
function buildFileWithPpz8({ triggerChannels, voiceIndex, ppzMemoName }) {
  const HEADER_LEN = 0x1a;
  const EMPTY_TRACK_OFF = HEADER_LEN;
  const FM1_TRACK_OFF = EMPTY_TRACK_OFF + 1;
  const fm1Note = [0xff, 1, noteByte(4, 0), 96, 0x80];
  const FM1_TRACK_LEN = fm1Note.length;
  const ADPCM_TRACK_OFF = FM1_TRACK_OFF + FM1_TRACK_LEN;

  // 0xb4 + 8ch分の2byteポインタ(LE)。triggerChannelsに含まれるchだけ
  // 実際のトラックオフセットを、それ以外は0(未起動)を書く。
  const ppz8InitPrefix = [0xb4];
  const chPtrPlaceholderStart = ppz8InitPrefix.length;
  for (let ch = 0; ch < 8; ch++) ppz8InitPrefix.push(0, 0); // 後で埋める
  const adpcmNote = [0xff, 1, noteByte(4, 0), 96, 0x80];
  const ADPCM_TRACK_LEN = ppz8InitPrefix.length + adpcmNote.length;

  // 各PPZ8chのノートトラック(全chがtonenum=voiceIndexを使う。ミュートは
  // 「トラック=チャンネル」単位でありボイス番号とは独立、という前提の確認も兼ねる)。
  const ppzNote = [0xff, voiceIndex & 0xff, noteByte(4, 0), 96, 0x80];
  const ppzTrackOffsets = {};
  let cursor = ADPCM_TRACK_OFF + ADPCM_TRACK_LEN;
  for (const ch of triggerChannels) {
    ppzTrackOffsets[ch] = cursor;
    cursor += ppzNote.length;
  }

  // memo文字列(拡張子は実際には使われない。pmd_filenamecopy()が'.'で止める)。
  const memoNameBytes = new TextEncoder().encode(ppzMemoName);
  const MEMO_STR_OFF = cursor;
  const memoStrField = new Uint8Array(memoNameBytes.length + 1);
  memoStrField.set(memoNameBytes, 0);
  const MEMO_TABLE_OFF = MEMO_STR_OFF + memoStrField.length;
  const MEMO_TABLE_LEN = 4; // u16(文字列オフセット) + u16(終端0)
  const MEMO_PTR_FIELD_OFF = MEMO_TABLE_OFF + MEMO_TABLE_LEN;
  const TONE_OFF = MEMO_PTR_FIELD_OFF + 4;

  const toneEntry = new Uint8Array(26); // 音色エントリは今回使わないため全0で足りる
  const relLen = TONE_OFF + toneEntry.length;
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
  adpcmBytes.set(ppz8InitPrefix, 0);
  for (const ch of triggerChannels) {
    const off = chPtrPlaceholderStart + ch * 2;
    adpcmBytes[off] = ppzTrackOffsets[ch] & 0xff;
    adpcmBytes[off + 1] = (ppzTrackOffsets[ch] >> 8) & 0xff;
  }
  adpcmBytes.set(adpcmNote, ppz8InitPrefix.length);
  rel.set(adpcmBytes, ADPCM_TRACK_OFF);
  for (const ch of triggerChannels) rel.set(Uint8Array.from(ppzNote), ppzTrackOffsets[ch]);

  rel.set(memoStrField, MEMO_STR_OFF);
  w16(MEMO_TABLE_OFF, MEMO_STR_OFF); // memoテーブル[0] = ppzfile名の文字列オフセット
  w16(MEMO_TABLE_OFF + 2, 0); // 終端
  w16(MEMO_PTR_FIELD_OFF, MEMO_TABLE_OFF); // toneptr-4 = memoptr
  rel[MEMO_PTR_FIELD_OFF + 2] = 0x48; // toneptr-2 = flaglow(index+2補正、上のコメント参照)
  rel[MEMO_PTR_FIELD_OFF + 3] = 0xfe; // toneptr-1 = flaghigh(flaglow!=0x40に必須の値)
  rel.set(toneEntry, TONE_OFF);

  const file = new Uint8Array(1 + relLen);
  file[0] = 0; // opm_flag
  file.set(rel, 1);
  return file;
}

const ALL_OPNA_CHANNELS = new Set([...FM_CHANNELS, ...SSG_CHANNELS, RHYTHM_CHANNEL, ADPCM_CHANNEL]);
const MUTE_ALL_OPNA_MASK = buildPmdChannelMask(ALL_OPNA_CHANNELS); // PPZ8以外を全ミュート

// 曲を読み込み・PPZ8マスクを適用してabsSumを測る。
// ppz8MaskSet: Set<string>(PPZ8_CHANNELSの部分集合)。undefinedならsetPpz8Maskを
// 一切呼ばない(=配線前相当。陽性対照用)。
async function measure({ fileBytes, pziBytes, ppz8MaskSet }) {
  const Module = await createPmdWeb();
  const songPath = writeSongWithPcm(Module, {
    songName: 'TEST.M',
    songBytes: fileBytes,
    pcmFiles: [{ name: 'TEST.PZI', data: pziBytes }],
  });
  const error = Module.playMusic(songPath);
  if (error) throw new Error(`playMusic failed: ${error}`);
  Module.setChannelMask(MUTE_ALL_OPNA_MASK); // PPZ8以外を全ミュート(絶対値和をPPZ8だけに絞る)
  if (ppz8MaskSet !== undefined) {
    Module.setPpz8Mask(buildPpz8Mask(ppz8MaskSet));
  }
  let absSum = 0;
  for (let i = 0; i < 200; i++) absSum += Module.renderFramesForTest(2048);
  return { Module, absSum };
}

// スナップショットリングから最新のlevels[11](PPZ8_1)を読む
// (html/pmd-app.js readRightPaneData()と同じ組み立て方)。
const SNAPSHOT_RING_SIZE = 2048;
function readPpz1Level(Module) {
  const writeIndex = Module.getSnapshotWriteIndex() >>> 0;
  if (writeIndex === 0 || writeIndex === 0xffffffff) return null;
  const entryBytes = Module.getSnapshotEntryByteSize();
  const ringPtr = Module.getSnapshotRingPointer();
  const idx = (writeIndex - 1) % SNAPSHOT_RING_SIZE;
  const entryBase = ringPtr + idx * entryBytes;
  const levelFieldCount = Module.getLevelFieldCount();
  const levelBase = (entryBase + Module.getSnapshotLevelOffset()) / 4;
  return Module.HEAP32[levelBase + 11 * levelFieldCount + 0]; // index0=level
}

function verifyWiring() {
  const pmdSrc = fs.readFileSync(path.join(__dirname, '../html/pmd-app.js'), 'utf8');
  check('[結線] pmd-app.jsがModule.setPpz8Maskを呼んでいる', /Module\.setPpz8Mask\(/.test(pmdSrc));
  check('[結線] pmd-app.jsがbuildPpz8Maskをimportしている',
    /import\s*\{[^}]*buildPpz8Mask[^}]*\}\s*from\s*'\.\/fmdsp\/channel-mask\.js'/.test(pmdSrc));
  check('[結線] レベルメーター列の当たり判定がPMD_LEVEL_COLUMN_CHANNELS(19列、PPZ8含む)を使っている',
    /columnCount:\s*PMD_LEVEL_COLUMN_CHANNELS\.length/.test(pmdSrc));
  check('[結線] レベルメータークリックがPMD_LEVEL_COLUMN_CHANNELSを渡してPPZ8列も解決できる',
    /channelForLevelColumn\(hit\.index,\s*PMD_LEVEL_COLUMN_CHANNELS\)/.test(pmdSrc));

  const mucomSrc = fs.readFileSync(path.join(__dirname, '../html/mucom-app.js'), 'utf8');
  check('[結線] mucom-app.jsは無改修(setPpz8Mask/buildPpz8Mask/PMD_LEVEL_COLUMN_CHANNELSを参照しない)',
    !/setPpz8Mask|buildPpz8Mask|PMD_LEVEL_COLUMN_CHANNELS/.test(mucomSrc));

  const maskSrc = fs.readFileSync(path.join(__dirname, '../fmdsp/channel-mask.js'), 'utf8');
  check('[結線] channel-mask.jsがbuildPpz8Maskをexportしている', /export function buildPpz8Mask/.test(maskSrc));
  check('[結線] channel-mask.jsがPMD_LEVEL_COLUMN_CHANNELSをexportしている',
    /export const PMD_LEVEL_COLUMN_CHANNELS/.test(maskSrc));

  const coreSrc = fs.readFileSync(path.join(__dirname, '../pmdweb/src/PmdCore.c'), 'utf8');
  check('[結線] PmdCore.cがpmdweb_set_ppz8_maskを定義している', /void pmdweb_set_ppz8_mask\(unsigned mask\)/.test(coreSrc));
  check('[結線] initialize_synth()がppz8_set_mask(...,0)で曲読み込み直し時にマスクを解除している',
    /ppz8_init\(&g_player\.ppz8,[^;]*;\s*[\s\S]{0,400}?ppz8_set_mask\(&g_player\.ppz8,\s*0\)/.test(coreSrc));

  const webSrc = fs.readFileSync(path.join(__dirname, '../pmdweb/src/PmdWeb.cpp'), 'utf8');
  check('[結線] PmdWeb.cppがsetPpz8MaskをJSへexportしている', /emscripten::function\("setPpz8Mask",\s*&pmdweb_set_ppz8_mask\)/.test(webSrc));
}

async function main() {
  console.log('=== PPZ8列(11-18)クリックミュート 実測検証 ===\n');

  const SAMPLES = 4096;
  const pziBytes = buildPziFile({
    voices: [{ index: 1, start: 0, len: SAMPLES, origfreq: 8000 }],
    waveform: buildSquareWave(SAMPLES),
  });
  console.log(`合成PZIファイルサイズ=${pziBytes.length} bytes (voice[1]: ${SAMPLES}samples矩形波)\n`);

  // ch0(PPZ8_1)とch5(PPZ8_6)の2chを同時に起動する曲。
  const fileBoth = buildFileWithPpz8({ triggerChannels: [0, 5], voiceIndex: 1, ppzMemoName: 'TEST.PZI' });
  checkDeadline('ファイル組み立て後');

  // A. [本体]+[陽性対照] マスクを送らない(配線前相当)ときは音が出ている
  //    (=この後のマスク検査が実際にFAILしうる状態からスタートしていることの確認)。
  const unmasked = await measure({ fileBytes: fileBoth, pziBytes, ppz8MaskSet: undefined });
  console.log(`(A) マスク未送信(配線前相当): absSum=${unmasked.absSum}`);
  check('A. [陽性対照] マスクを送らない状態ではPPZ8の音が出ている(検査対象が実在する)',
    unmasked.absSum > 1000, `absSum=${unmasked.absSum}`);
  checkDeadline('A測定後');

  // B. [本体] 全PPZ8ch(0xff)をミュートすると絶対値和が明確に下がる。
  const mutedAll = await measure({ fileBytes: fileBoth, pziBytes, ppz8MaskSet: new Set(PPZ8_CHANNELS) });
  console.log(`(B) 全PPZ8chミュート: absSum=${mutedAll.absSum}`);
  const threshold = Math.max(unmasked.absSum * 0.01, 1);
  check('B. [本体] 全PPZ8chミュートで絶対値和がほぼ0まで下がる(マスクしたら音が消える)',
    mutedAll.absSum <= threshold, `absSum=${mutedAll.absSum} 閾値=${threshold.toFixed(2)} (未ミュート比=${(mutedAll.absSum / unmasked.absSum * 100).toFixed(4)}%)`);
  checkDeadline('B測定後');

  // C. [本体] ch0(PPZ8_1、bit0)だけミュート -> ch5(PPZ8_6)は鳴り続けるので、
  //    絶対値和はA(両方鳴っている)より下がるがB(両方ミュート)ほどではない。
  const mutedCh0 = await measure({ fileBytes: fileBoth, pziBytes, ppz8MaskSet: new Set(['PPZ8_1']) });
  console.log(`(C) PPZ8_1(bit0)のみミュート: absSum=${mutedCh0.absSum}`);
  check('C. [本体] PPZ8_1のみミュートすると絶対値和がAより下がる(自分自身は消える)',
    mutedCh0.absSum < unmasked.absSum * 0.9, `absSum=${mutedCh0.absSum} A=${unmasked.absSum}`);
  check('C. [本体] PPZ8_1のみミュートしてもBほどには下がらない(他ch=PPZ8_6は影響を受けない)',
    mutedCh0.absSum > unmasked.absSum * 0.2, `absSum=${mutedCh0.absSum} A=${unmasked.absSum}`);
  checkDeadline('C測定後');

  // D. [本体] ch5(PPZ8_6、bit5)だけミュート -> Cと対称の結果になるはず。
  //    Cと合わせて「ビット割り当てが1文字/1桁違いで取り違えていないか」を検出する
  //    (bit0とbit5を取り違えていれば、CとDの結果が入れ替わって見える)。
  const mutedCh5 = await measure({ fileBytes: fileBoth, pziBytes, ppz8MaskSet: new Set(['PPZ8_6']) });
  console.log(`(D) PPZ8_6(bit5)のみミュート: absSum=${mutedCh5.absSum}`);
  check('D. [本体] PPZ8_6のみミュートすると絶対値和がAより下がる(自分自身は消える)',
    mutedCh5.absSum < unmasked.absSum * 0.9, `absSum=${mutedCh5.absSum} A=${unmasked.absSum}`);
  check('D. [本体] PPZ8_6のみミュートしてもBほどには下がらない(他ch=PPZ8_1は影響を受けない)',
    mutedCh5.absSum > unmasked.absSum * 0.2, `absSum=${mutedCh5.absSum} A=${unmasked.absSum}`);
  checkDeadline('D測定後');

  // E. [本体] Cで実際にミュートされて消えたのがPPZ8_1(ch0)側の寄与だと確認するため、
  //    「使っていないch(未起動のPPZ8_3=bit2)」をミュートしても絶対値和が
  //    ほぼ変わらないことを見る(=マスクを送ること自体は減衰の原因ではない)。
  const mutedUnusedCh = await measure({ fileBytes: fileBoth, pziBytes, ppz8MaskSet: new Set(['PPZ8_3']) });
  console.log(`(E) 未起動chのPPZ8_3(bit2)のみミュート: absSum=${mutedUnusedCh.absSum}`);
  const nearUnchangedThreshold = Math.max(unmasked.absSum * 0.02, 1);
  check('E. [対照] 使っていないchをミュートしても絶対値和はほぼ変わらない(取り違えていれば動く)',
    Math.abs(mutedUnusedCh.absSum - unmasked.absSum) <= nearUnchangedThreshold,
    `absSum=${mutedUnusedCh.absSum} A=${unmasked.absSum} 差=${Math.abs(mutedUnusedCh.absSum - unmasked.absSum)} 閾値=${nearUnchangedThreshold.toFixed(2)}`);
  checkDeadline('E測定後');

  // F. [本体] 曲を読み込み直すとマスクが解除されている(initialize_synth()の
  //    ppz8_set_mask(&g_player.ppz8, 0)、PmdCore.c参照)。
  //    同一Moduleでミュート->再生し直し->マスクを送らずに測定、の順で確認する。
  {
    const Module = await createPmdWeb();
    let songPath = writeSongWithPcm(Module, {
      songName: 'TEST.M', songBytes: fileBoth, pcmFiles: [{ name: 'TEST.PZI', data: pziBytes }],
    });
    let error = Module.playMusic(songPath);
    if (error) throw new Error(`playMusic failed: ${error}`);
    Module.setChannelMask(MUTE_ALL_OPNA_MASK);
    Module.setPpz8Mask(buildPpz8Mask(new Set(PPZ8_CHANNELS))); // 全ミュート
    let absSumMuted = 0;
    for (let i = 0; i < 50; i++) absSumMuted += Module.renderFramesForTest(2048);
    console.log(`(F-1) 1曲目をミュートして再生: absSum=${absSumMuted}`);

    // 曲を読み込み直す(playMusic()が内部でpmdweb_stop_music()->initialize_synth()を
    // 呼ぶ。html/pmd-app.jsも同じ経路)。JS側からsetPpz8Maskは一切呼ばない。
    songPath = writeSongWithPcm(Module, {
      songName: 'TEST2.M', songBytes: fileBoth, pcmFiles: [{ name: 'TEST.PZI', data: pziBytes }],
    });
    error = Module.playMusic(songPath);
    if (error) throw new Error(`playMusic(2回目) failed: ${error}`);
    Module.setChannelMask(MUTE_ALL_OPNA_MASK); // PPZ8以外のミュートは毎回明示するのが製品の作法
    let absSumReloaded = 0;
    for (let i = 0; i < 200; i++) absSumReloaded += Module.renderFramesForTest(2048);
    console.log(`(F-2) 読み込み直し後(setPpz8Mask未送信): absSum=${absSumReloaded}`);
    check('F. [本体] 曲を読み込み直すとPPZ8マスクが解除されている(音が戻る)',
      absSumReloaded > unmasked.absSum * 0.5, `absSum=${absSumReloaded} 参考(A)=${unmasked.absSum}`);
  }
  checkDeadline('F測定後');

  // G-0. [実測] 依頼事項3: ppz8.c leveldata_update()(222行付近)がマスク済み
  //    チャンネルでもレベルを更新してしまわないかの実測。PmdCore.c
  //    pmdweb_set_ppz8_mask()コメント・build_levels()コメントで「更新される
  //    (upstream FM/SSG/ADPCM/リズムと同じ構造)」と結論づけた根拠を、ここで
  //    実測として裏付ける: PPZ8_1をミュートした状態で鳴らし続け、
  //    levels[11](PPZ8_1)がミュート後も0のまま張り付かず動き続けることを確認する。
  {
    const Module = await createPmdWeb();
    const songPath = writeSongWithPcm(Module, {
      songName: 'TEST.M', songBytes: fileBoth, pcmFiles: [{ name: 'TEST.PZI', data: pziBytes }],
    });
    const error = Module.playMusic(songPath);
    if (error) throw new Error(`playMusic failed: ${error}`);
    Module.setChannelMask(MUTE_ALL_OPNA_MASK);
    Module.setPpz8Mask(buildPpz8Mask(new Set(['PPZ8_1']))); // PPZ8_1(ch0)だけミュート、音は消える(上のC参照)
    const samples = [];
    for (let i = 0; i < 40; i++) {
      Module.renderFramesForTest(2048);
      const level = readPpz1Level(Module);
      if (level !== null) samples.push(level);
    }
    const nonZeroCount = samples.filter((v) => v > 0).length;
    console.log(`(G-0) ミュート中のlevels[11](PPZ8_1)サンプル: 非0=${nonZeroCount}/${samples.length}件 (例: ${samples.slice(0, 5).join(',')})`);
    check('G-0. [実測] マスク済みPPZ8_1でもleveldataは動き続ける(バー本体は表示側のdim-tierで暗くする設計、PmdCore.c参照)',
      nonZeroCount > 0, `非0=${nonZeroCount}/${samples.length}`);
  }
  checkDeadline('G-0測定後');

  // G. [本体] MUCOM88側の挙動が変わっていないこと(既存 verify_mucom_channel_mute.mjs
  //    が別途実測するが、ここではモジュール結線レベルで「MUCOM経路にPPZ8マスクが
  //    一切紛れ込んでいない」ことを検査する。実音での確認は既存スクリプトに委ねる
  //    ため、ここでは[結線]検査として扱う)。
  console.log('');
  verifyWiring();

  console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
  if (failCount > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
