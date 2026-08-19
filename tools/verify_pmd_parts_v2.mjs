#!/usr/bin/env node
// PMD MML v2構文(docs/pmd-compiler-spec-v2.md)のうち、step3で実装した`J`(ADPCM)パートの検証。
//
// 対象: `J`(ADPCMパート)。docs/pmd-compiler-spec-v2.md 1.2節「ヘッダindex9、既存の11パート
// ポインタ表の空きスロット」「トラックのバイト書式はFM/SSGと共通(0xff=音色/サンプル番号選択、
// 続けて通常の音符バイト)」という確定済みの内容を実装した。`K`/`R`(リズム)・PPZ8は
// 未解明(`@`→ビット対応、MML文字→チャンネル対応)が残っているため今回は対象外のまま。
//
// 検査方針:
//   1. [ヘッダ/トラック] 自前の小さなMMLをcompileMml()でコンパイルし、ヘッダの
//      ADPCMパートポインタ(相対オフセット0x12、11パート表のindex9)とADPCMトラックの
//      生バイト列が「仕様書に書かれた期待値」と一致することを確認する。期待値は
//      HEADER_LEN=0x1a・トラック書式(0xfd=vol, 0xff=tonenum, note/len, 0x80=終端)という
//      spec記載のバイトレイアウトから手で書き下したものであり、コンパイラの出力から
//      逆算していない(tools/verify_pmd_mml_v2_commands.mjsと同じ作法)。
//   2. [実測・鳴る] pmdweb/build-web/pmdweb.jsを使い、compileMml()が生成した`.M`を
//      実際に再生させ、ADPCM以外を全部ミュートした状態でabsSumが非0になることを確認する
//      (=コンパイルされたJパートのトラックが実際にADPCM音源を駆動している証拠)。
//      ADPCMサンプル自体はPPC形式(tools/verify_pmd_channel_mute.mjsの生成ロジックを流用)
//      をテスト専用API Module.testLoadPpcFile()で読み込む。
//   3. [陽性対照] ヘッダのADPCMポインタを意図的に「空トラック」へ差し替えた壊れた`.M`
//      (=Jパートがヘッダに正しく配線されていない状態を模擬)では、同じ手順でabsSumが
//      ほぼ0になる(症状側で実際に落ちることを確認する)。
//   4. [陽性対照] Jパートの音色番号が未定義の場合、compileMml()がエラーを返す
//      (既存の音色番号チェックがJパートにも及んでいることの確認)。
//
// 実行: node tools/verify_pmd_parts_v2.mjs
// (pmdweb/build-web/pmdweb.js が事前にビルド済みであること)

import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import { compileMml } from '../compiler/pmd_mml_compiler.mjs';
import { buildToneEntry, noteByte } from '../compiler/gen_pmd_min.mjs';
import {
  buildPmdChannelMask, FM_CHANNELS, SSG_CHANNELS, ADPCM_CHANNEL, RHYTHM_CHANNEL,
} from '../fmdsp/channel-mask.js';

let passCount = 0;
let failCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

function hex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

console.log('=== PMD MML v2構文(step3): Jパート(ADPCM)の検証 ===\n');

// --- 1. ヘッダ/トラックのバイト一致検証 ---
{
  // 音色@1(TL=0の既定値。tonenum以外は既定でよい)を定義し、Jパートだけを使うMML。
  // v16 -> PPZ_V_TABLE[16]=255(2026-08-19、実データPOPFUL_HOSHI.mml実測でADPCM(J)の
  // 'v'変換テーブルがV_LOWERCASE_FM_TABLEではなくPPZ_V_TABLE(PPZ8拡張と同じPCM系)だと
  // 判明したため訂正。旧仕様(V_LOWERCASE_FM_TABLE[16]=127)は実測に基づかない手書きの
  // 期待値だった。docs/pmd-compiler-real-data-diff-2026-08-19.md参照)。
  const mml = [
    '@ 1 7 0',
    '31 0 0 0 0 0 0 1 0 0',
    '31 0 0 0 0 0 0 1 0 0',
    '31 0 0 0 0 0 0 1 0 0',
    '31 0 0 0 0 0 0 1 0 0',
    'J v16 @1 c4',
  ].join('\n');
  const { file, errors, layout } = compileMml(mml, {});
  check('1a. コンパイル成功(Jパートのみ)', errors.length === 0 && file !== null, JSON.stringify(errors));

  if (file) {
    const HEADER_LEN = 0x1a;
    // レイアウトは本家MC.EXEの出力を実測して確定した(2026-08-18作業、tools/pmd-reference/pmdadpc.M
    // — Jパートだけを使うMMLの参照出力そのもの)。ヘッダの各スロット(A-J, K, r_offset)を
    // index順に処理し、未使用スロットは1つにつき専用の終端バイト(0x80)を1個ずつ消費する。
    // Jより前のA-I(9パート)がすべて未使用なので、A(index0)=0x1a から1byteずつ9個並び、
    // J(index9)の実データは 0x1a+9=0x23 から始まる(pmdadpc.Mのheaderで実測: index9=0x0023)。
    const FIRST_EMPTY_SLOT_OFF = HEADER_LEN; // 0x1a: 最初の未使用スロット(index0=A)
    const UNUSED_SLOTS_BEFORE_J = 9; // index0-8 = A,B,C,D,E,F,G,H,I(いずれも未使用、1byteずつ)
    const ADPCM_TRACK_OFF = FIRST_EMPTY_SLOT_OFF + UNUSED_SLOTS_BEFORE_J; // 0x23: Jの実データ先頭
    const rel = file.subarray(1);

    function read16le(off) { return rel[off] | (rel[off + 1] << 8); }

    // ヘッダ11パート表のindex9=ADPCM(doc 1.2節「ヘッダindex9、既存の11パートポインタ表の
    // 空きスロット」)。相対オフセット = 9*2 = 0x12。
    check('1b. ヘッダのADPCMパートポインタ(index9, offset0x12)がADPCMトラック先頭を指す',
      read16le(0x12) === ADPCM_TRACK_OFF,
      `actual=0x${read16le(0x12).toString(16)} expected=0x${ADPCM_TRACK_OFF.toString(16)}`);
    check('1c. [陽性対照] index9は他のFM/SSGパートのポインタ(0x1a、空トラック)とは異なる',
      read16le(0x12) !== read16le(0x00));

    // ADPCMトラックの中身: 0xfd(vol) 0xff(v16->PPZ_V_TABLE[16]=255) / 0xff(tonenum選択) 0x01 /
    // note(既定オクターブ,c=0)。'J v16 @1 c4'は'o'省略なので既定オクターブ(MMLのo4相当)、
    // nibbleはそれより1小さい3(PMDMML.MAN §4-4、docs/pmd-compiler-spec-v2.md 6章、
    // 参照.M実測で確定)=noteByte(3,0)=0x30 / len=4分音符=96/4=24=0x18 / 0x80(終端)。
    // (トラック書式はFM/SSGと共通、doc 1.2節)。
    const expectedTrack = Uint8Array.from([0xfd, 0xff, 0xff, 0x01, noteByte(3, 0), 24, 0x80]);
    const actualTrack = rel.subarray(ADPCM_TRACK_OFF, ADPCM_TRACK_OFF + expectedTrack.length);

    // ヘッダのRHYTHM(index10, offset0x14)は未対応のまま未使用スロットを指す。新レイアウトでは
    // Jの直後(index10)に専用の終端バイトが割り当てられるので、アドレスはJトラックの直後になる
    // (pmdadpc.Mでも同様にJの直後・0x2cにKの終端バイトが1個ある。今回のトラック内容は違うので
    // 絶対値ではなく「Jの直後」という関係で検証する)。
    const RHYTHM_OFF = ADPCM_TRACK_OFF + expectedTrack.length;
    check('1d. ヘッダのRHYTHM(index10, offset0x14)は未対応のまま、Jトラック直後の未使用スロットを指す',
      read16le(0x14) === RHYTHM_OFF,
      `actual=0x${read16le(0x14).toString(16)} expected=0x${RHYTHM_OFF.toString(16)}`);
    check('1e. ADPCMトラックの生バイト列が仕様どおり(vol/tonenum/note/終端)',
      arraysEqual(actualTrack, expectedTrack),
      `actual=${hex(actualTrack)} expected=${hex(expectedTrack)}`);
    check('1f. [陽性対照] 1byte違う誤り期待値とは一致しない',
      !arraysEqual(actualTrack, Uint8Array.from([0xfd, 0x7f, 0xff, 0x02, noteByte(3, 0), 24, 0x80])));

    check('1g. layout.tracksにJパートが記録されている', layout && Object.prototype.hasOwnProperty.call(layout.tracks, 'J'));
  }
}

// --- 4. Jパートの`@n`はFM音色テーブルと無関係(2026-08-18訂正) ---
// 旧実装は「音色未定義エラーがJパートにも及ぶ」ことを陽性対照として検証していたが、
// これは誤りだった。PMDMML.MAN §6-1-5(音色番号指定/PCM音源パートの場合)実測
// (mso_JSM.MML実データ、参照.M実測)により、Jパート(ADPCM)の`@n`はFM音色テーブルの
// 26byteエントリとは無関係に、PCM音色番号としてトラックバイト列へそのまま書かれる
// だけと判明した(compiler/pmd_mml_compiler.mjsのFM_PART_LETTERS制限、同コミットの
// 実測根拠)。よってJパートの`@n`は(SSGパートの`@n`同様)FM音色定義の有無に
// 関係なくエラーにならない。
{
  const mml = 'J @9 c4\n'; // @9はFM音色テーブルには未定義だが、Jパートなので無関係
  const { errors, file } = compileMml(mml, {});
  check('4. Jパートの@nはFM音色テーブル未定義でもエラーにならない(§6-1-5、FM音色と無関係)',
    errors.length === 0 && file !== null, JSON.stringify(errors));
}

// --- 2/3. 実測(wasm再生)。PPC形式のADPCMサンプルをテスト専用APIで読み込み、
//     実際にJパートが音を出すことと、ヘッダの配線が壊れていれば無音になることを確認する。
// (PPC生成ロジックはtools/verify_pmd_channel_mute.mjsから流用。ヘッダ・出典コメントは
// 同ファイル参照)
function buildTestPpcFile({ payload }) {
  const PPC_HEADER_SIZE = 30 + 2 + 4 * 256;
  const buf = new Uint8Array(PPC_HEADER_SIZE + payload.length);
  const magic = 'ADPCM DATA for  PMD ver.4.4-  ';
  for (let i = 0; i < magic.length; i++) buf[i] = magic.charCodeAt(i);
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
function buildAdpcmPayload(length) {
  const buf = new Uint8Array(length);
  for (let i = 0; i < length; i++) buf[i] = (i * 0x5b + 0x37) & 0xff;
  return buf;
}

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
  // 少し長めのADPCMサンプルを鳴らすMML(J v16 @1 c1、全音符=96クロック=1byteに収まる)。
  const mml = [
    '@ 1 7 0',
    '31 0 0 0 0 0 0 1 0 0',
    '31 0 0 0 0 0 0 1 0 0',
    '31 0 0 0 0 0 0 1 0 0',
    '31 0 0 0 0 0 0 1 0 0',
    'J v16 @1 c1',
  ].join('\n');
  const { file, errors } = compileMml(mml, {});
  if (errors.length > 0 || !file) {
    check('2a. コンパイル成功(実測用MML)', false, JSON.stringify(errors));
    console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
    if (failCount > 0) process.exit(1);
    return;
  }
  check('2a. コンパイル成功(実測用MML)', true);

  const ppcBytes = buildTestPpcFile({ payload: buildAdpcmPayload(4096) });
  const ALL_EXCEPT_ADPCM = new Set([...FM_CHANNELS, ...SSG_CHANNELS, RHYTHM_CHANNEL]);

  const Module = await createPmdWeb();

  const absSum = await measure(Module, file, ppcBytes, ALL_EXCEPT_ADPCM);
  console.log(`(実測) ADPCM以外をミュートしてJパートを再生: absSum=${absSum}`);
  check('2b. [本体] compileMml()が生成した`.M`のJパートが実際にADPCM音を出す(absSum非0)',
    absSum > 0, `absSum=${absSum}`);

  // 3. [陽性対照] ヘッダのADPCMポインタを空トラック(0x1a)へ壊す(=Jパートがヘッダに
  // 配線されていない状態を模擬)。fmdriver_pmd.cはこのポインタを読んで再生を始めるため、
  // ここを壊せば「トラックのバイト列自体は正しいのに鳴らない」という、配線漏れの症状を
  // 再現できる。
  const brokenFile = Uint8Array.from(file);
  const HEADER_LEN = 0x1a;
  brokenFile[1 + 0x12] = HEADER_LEN & 0xff; // rel[0x12] (opm_flagバイト分+1)
  brokenFile[1 + 0x13] = (HEADER_LEN >> 8) & 0xff;
  const brokenAbsSum = await measure(Module, brokenFile, ppcBytes, ALL_EXCEPT_ADPCM);
  console.log(`(陽性対照) ADPCMヘッダポインタを空トラックへ壊した場合: absSum=${brokenAbsSum}`);
  check('3. [陽性対照] ヘッダ配線を壊すとabsSumがほぼ0になる(=この検査が配線漏れの症状で実際に落ちる証拠)',
    brokenAbsSum <= absSum * 0.001, `absSum=${brokenAbsSum} (正常時比=${(brokenAbsSum / absSum * 100).toFixed(4)}%)`);

  console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
  if (failCount > 0) process.exit(1);
}

main();
