#!/usr/bin/env node
// トラック行クリックミュート機能の実測(PMD側)。tools/verify_mucom_channel_mute.mjs
// のPMD版。opna_set_mask()(libopna/opna.c)を実際に叩き、ADPCMビット(bit15、
// MUCOM88とは逆位置!)が本当にADPCMチャンネルだけを消しているかを実測する。
//
// PMD側の制約: 本Web版のMML(compiler/pmd_mml_compiler.mjs)はADPCM/リズムパートを
// サポートしていない(v1範囲外、compiler/pmd_mml_parser.mjs:463のエラーメッセージ
// 参照)。加えて本Web版はPPC/PVIファイル読み込みをUIから一切提供していないため、
// ADPCM RAMは常にゼロ初期化のままで、通常の再生経路では「鳴らしようがない」。
// そこでこのスクリプトは検証専用に:
//   1. PmdCore.cへ追加した pmdweb_test_load_ppc_file() (Module.testLoadPpcFile)
//      経由で、PPC形式(fmdriver_pmd.c:6076 pmd_ppc_load())のバイト列を
//      MEMFS経由でADPCM RAMへ流し込む(製品UIからは呼ばれないテスト専用API)。
//   2. `.M`ファイル自体はcompiler/gen_pmd_min.mjs同様の手法で直接バイナリ組み立て
//      (MMLコンパイラを経由しない)、FM1パートとADPCMパートを同時に鳴らす。
//
// MML相当の内容: FM1(トーンあり、単音)とADPCM(tonenum=1、PPCで読み込んだ
// サンプルを1回再生)を同時に鳴らす。
//   A. 何もミュートしない -> absSum(baseline)
//   B. ADPCM以外(FM1-6,SSG1-3,リズム)を全部ミュート -> absSumが非0であること
//      (=ADPCMchが残っている証拠)
//   C. ADPCMだけをミュート -> absSumがAより明確に減ること(=ADPCMchが消えている証拠)
//   D. 全部ミュート -> absSumがほぼ0であること(陽性対照)
//
// 実行: node tools/verify_pmd_channel_mute.mjs
// (pmdweb/build-web/pmdweb.js が事前にビルド済みであること)

import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import { buildToneEntry, noteByte } from '../compiler/gen_pmd_min.mjs';
import {
  buildPmdChannelMask, FM_CHANNELS, SSG_CHANNELS, ADPCM_CHANNEL, RHYTHM_CHANNEL,
} from '../fmdsp/channel-mask.js';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

// --- `.M`バイナリを直接組み立てる(compiler/gen_pmd_min.mjsの手法を、
//     ADPCMパートを含む形に拡張したもの。このファイル専用、MMLコンパイラは
//     使わない)。出典はすべてdocs/pmd-compiler-spec.md 1.1-1.3節/compiler/
//     gen_pmd_min.mjsのコメント参照。 ---
function buildFmAndAdpcmFile({ fmToneEntry, fmLength = 96, adpcmTonenum = 1, adpcmLength = 96 }) {
  const HEADER_LEN = 0x1a; // 11パート分ポインタ(22) + r_offset(2) + tone_ptr(2)
  const EMPTY_TRACK_OFF = HEADER_LEN;
  const FM1_TRACK_OFF = EMPTY_TRACK_OFF + 1;
  const fm1Track = Uint8Array.from([0xff, 1, noteByte(4, 0), fmLength & 0xff, 0x80]);
  const ADPCM_TRACK_OFF = FM1_TRACK_OFF + fm1Track.length;
  // ADPCMパートのトラック書式はFMと同じ(0xff=音色/サンプル番号選択
  // (pmd_cmdff_tonenum_adpcm、fmdriver_pmd.c:2307)、続けて通常の音符バイト)。
  const adpcmTrack = Uint8Array.from([0xff, adpcmTonenum & 0xff, noteByte(4, 0), adpcmLength & 0xff, 0x80]);
  const TONE_OFF = ADPCM_TRACK_OFF + adpcmTrack.length;

  const relLen = TONE_OFF + fmToneEntry.length;
  const rel = new Uint8Array(relLen);
  function w16(off, val) {
    rel[off] = val & 0xff;
    rel[off + 1] = (val >> 8) & 0xff;
  }
  // 11パート分のポインタ(FM1-6, SSG1-3, ADPCM(idx9), RHYTHM(idx10)。
  // docs/pmd-compiler-spec.md 1.2節の順)。
  w16(0x00, FM1_TRACK_OFF); // FM1
  for (let i = 1; i < 6; i++) w16(i * 2, EMPTY_TRACK_OFF); // FM2-6
  for (let i = 6; i < 9; i++) w16(i * 2, EMPTY_TRACK_OFF); // SSG1-3
  w16(9 * 2, ADPCM_TRACK_OFF); // ADPCM
  w16(10 * 2, EMPTY_TRACK_OFF); // RHYTHM
  w16(0x16, EMPTY_TRACK_OFF); // r_offset(未使用)
  w16(0x18, TONE_OFF); // tone_ptr

  rel[EMPTY_TRACK_OFF] = 0x80;
  rel.set(fm1Track, FM1_TRACK_OFF);
  rel.set(adpcmTrack, ADPCM_TRACK_OFF);
  rel.set(fmToneEntry, TONE_OFF);

  const file = new Uint8Array(1 + relLen);
  file[0] = 0; // opm_flag
  file.set(rel, 1);
  return file;
}

// --- PPC形式(fmdriver_pmd.c:6076 pmd_ppc_load())のバイト列を組み立てる ---
// ヘッダ: "ADPCM DATA for  PMD ver.4.4-  "(30byte) + 予約2byte + 256エントリの
// start/stopアドレス表(4byte×256=1024byte)。以降が生ADPCMデータ。
// アドレスレジスタの単位はopnaadpcm.c addr_conv() (4bitモード: nibble_addr=reg<<3、
// byte_addr=nibble_addr>>1=reg*4)なので、reg単位はRAM上4byte刻みに相当する。
// start=0(RAM先頭、pmd_ppc_load()内のDMA書き込み前処理0x4c0byteぶんの無音助走
// 部分を含む)、stop=0x7ff(=RAMの先頭8192byteをカバー、4096byteの実データを
// 十分に収める)とし、厳密な助走オフセット計算はせず余裕を持たせた。
function buildTestPpcFile({ payload }) {
  const PPC_HEADER_SIZE = 30 + 2 + 4 * 256;
  const buf = new Uint8Array(PPC_HEADER_SIZE + payload.length);
  const magic = 'ADPCM DATA for  PMD ver.4.4-  ';
  for (let i = 0; i < magic.length; i++) buf[i] = magic.charCodeAt(i);
  // tonenum=1のアドレス表(start=0, stop=0x7ff)。他のtonenumは0のまま(start===stop===0、
  // 使わない)。
  const TONE_NUM = 1;
  const start = 0;
  const stop = 0x7ff;
  const off = 32 + 4 * TONE_NUM;
  buf[off] = start & 0xff;
  buf[off + 1] = (start >> 8) & 0xff;
  buf[off + 2] = stop & 0xff;
  buf[off + 3] = (stop >> 8) & 0xff;
  buf.set(payload, PPC_HEADER_SIZE);
  return buf;
}

// 非ゼロ・非一様なパターン(0x00/0xffの繰り返しは特定コーデックで「無変化」に
// 落ちる懸念があるため避ける)。ADPCM復号後の音質は問わない(ミュートの
// on/offを絶対値和で区別できれば十分)。
function buildAdpcmPayload(length) {
  const buf = new Uint8Array(length);
  for (let i = 0; i < length; i++) buf[i] = (i * 0x5b + 0x37) & 0xff;
  return buf;
}

const ALL_MUTABLE = new Set([...FM_CHANNELS, ...SSG_CHANNELS, RHYTHM_CHANNEL, ADPCM_CHANNEL]);
const ALL_EXCEPT_ADPCM = new Set([...FM_CHANNELS, ...SSG_CHANNELS, RHYTHM_CHANNEL]);
const ADPCM_ONLY = new Set([ADPCM_CHANNEL]);
const NONE = new Set();

async function measure(Module, fileBytes, ppcBytes, mutedSet) {
  Module.FS.writeFile('/test.M', fileBytes);
  const error = Module.playMusic('/test.M');
  if (error) throw new Error(`playMusic failed: ${error}`);
  Module.FS.writeFile('/test.ppc', ppcBytes);
  const loaded = Module.testLoadPpcFile('/test.ppc');
  if (!loaded) throw new Error('testLoadPpcFile failed');
  Module.setChannelMask(buildPmdChannelMask(mutedSet));
  let absSum = 0;
  for (let i = 0; i < 200; i++) absSum += Module.renderFramesForTest(2048);
  return absSum;
}

async function main() {
  console.log('=== PMD トラック行クリックミュート 実測検証 ===\n');

  const fmTone = buildToneEntry({ tonenum: 1, ar: [31, 31, 31, 31], tl: [0, 20, 20, 0], alg: 7 });
  const fileBytes = buildFmAndAdpcmFile({ fmToneEntry: fmTone, fmLength: 96, adpcmTonenum: 1, adpcmLength: 96 });
  const ppcBytes = buildTestPpcFile({ payload: buildAdpcmPayload(4096) });
  console.log(`.M file size=${fileBytes.length} bytes / PPC file size=${ppcBytes.length} bytes\n`);

  const Module = await createPmdWeb();

  const a = await measure(Module, fileBytes, ppcBytes, NONE);
  console.log(`(a) 何もミュートしない: absSum=${a}`);

  const b = await measure(Module, fileBytes, ppcBytes, ALL_EXCEPT_ADPCM);
  console.log(`(b) ADPCM以外を全部ミュート: absSum=${b}`);
  check('B. [本体] ADPCM以外をミュートしてもabsSumが非0(=ADPCMchが残っている証拠)', b > 0, `absSum=${b}`);

  const c = await measure(Module, fileBytes, ppcBytes, ADPCM_ONLY);
  console.log(`(c) ADPCMだけをミュート: absSum=${c}`);
  check('C. [本体] ADPCMだけミュートするとabsSumが(a)より明確に減る(=ADPCMchが消えている証拠)',
    c < a * 0.9, `a=${a} c=${c} (c/a=${(c / a).toFixed(4)})`);

  const d = await measure(Module, fileBytes, ppcBytes, ALL_MUTABLE);
  console.log(`(d) 全部ミュート: absSum=${d}`);
  const SILENCE_THRESHOLD = a * 0.001;
  check('D. [陽性対照] 全部ミュートするとabsSumがほぼ0(マスクが効いている証拠)',
    d <= SILENCE_THRESHOLD, `absSum=${d} (閾値=${SILENCE_THRESHOLD.toFixed(1)}, a比=${(d / a * 100).toFixed(4)}%)`);

  console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
  console.log(`実測値まとめ: (a)=${a} (b)=${b} (c)=${c} (d)=${d}`);
  if (failCount > 0) process.exit(1);
}

main();
