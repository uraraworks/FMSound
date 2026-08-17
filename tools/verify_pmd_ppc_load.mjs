#!/usr/bin/env node
// PMD側PCM(.PPC)がUIの本番経路(writeSongWithPcm()+Module.playMusic())から
// 実際に読み込まれることの実測検証。tools/verify_pmd_channel_mute.mjs は
// Module.testLoadPpcFile()(製品UIからは呼ばれないテスト専用API)経由でADPCM RAMへ
// 直接流し込んでいたが、このスクリプトはそれを使わない。本番の
// fmplayer_file_load() -> loadppc() -> fmplayer_fileread() のディレクトリ走査
// (upstream/98fmplayer/common/fmplayer_file_unix.c)を実際に通す。
//
// .Mファイルの memo テーブルにPCMファイル名を埋める処理は
// upstream/98fmplayer/fmdriver/fmdriver_pmd.c の pmd_get_memo()(5962行〜)と
// pmd_init()(6055行付近)の実装を読んで組み立てた:
//   - toneptr = read16le(data[0x18])
//   - data[toneptr-2](flaglow)を0x40にするとindex補正(0x42/0x48判定)が効かず、
//     pmd_get_memo(pmd, 0)がmemoテーブルの0番目をそのまま返す
//     (pmd_init()の `pmd_get_memo(pmd, 0)` がppcfileに代入される箇所)。
//   - memoptr = read16le(data[toneptr-4])。memoテーブルは16bit文字列オフセットの
//     並びで、0で終端。pmd_get_memo()は該当indexのオフセットを
//     pmd_check_str()で読み、NUL終端文字列を返す。
//
// 検証項目:
//   [本体]     writeSongWithPcm()で曲ディレクトリへ配置 -> playMusic() ->
//              ADPCM以外を全ミュートしたabsSumが非0(=本番経路で.PPCが読めた証拠)
//   [陽性対照] 同じ曲と.PPCをルート直下に置いた場合はabsSumがほぼ0
//              (=この検査が実際に症状で落ちる側を確認する。壊れた配置で確実にFAIL)
//   [陰性対照] .PPCを置かない場合absSumがほぼ0
//   [結線]     html/pmd-app.jsを実ファイルとして読み、writeSongWithPcmを使っている
//              こと・ルート直下へ直接書く記述が残っていないこと・書庫の枝が
//              collectPmdPcmFilesの結果を渡していることを文字列検査する
//
// 実行: node tools/verify_pmd_ppc_load.mjs
// (pmdweb/build-web/pmdweb.js が事前にビルド済みであること。180秒を超えたら打ち切る)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import { buildToneEntry, noteByte } from '../compiler/gen_pmd_min.mjs';
import {
  buildPmdChannelMask, FM_CHANNELS, SSG_CHANNELS, ADPCM_CHANNEL, RHYTHM_CHANNEL,
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

// --- `.M`バイナリを直接組み立てる(tools/verify_pmd_channel_mute.mjsの
//     buildFmAndAdpcmFile()を、memoテーブル(PCMファイル名)を持てる形に拡張したもの) ---
function buildFmAndAdpcmFileWithMemo({
  fmToneEntry, fmLength = 96, adpcmTonenum = 1, adpcmLength = 96, ppcMemoName,
}) {
  const HEADER_LEN = 0x1a; // 11パート分ポインタ(22) + r_offset(2) + tone_ptr(2)
  const EMPTY_TRACK_OFF = HEADER_LEN;
  const FM1_TRACK_OFF = EMPTY_TRACK_OFF + 1;
  const fm1Track = Uint8Array.from([0xff, 1, noteByte(4, 0), fmLength & 0xff, 0x80]);
  const ADPCM_TRACK_OFF = FM1_TRACK_OFF + fm1Track.length;
  const adpcmTrack = Uint8Array.from([0xff, adpcmTonenum & 0xff, noteByte(4, 0), adpcmLength & 0xff, 0x80]);

  // memo文字列("TEST.PPC\0"。pmd_filenamecopy()は'.'/','で止めるので拡張子部分は
  // 実際には使われないが、実物の.Mに近い形にするためあえて拡張子込みで置く)。
  const memoNameBytes = new TextEncoder().encode(ppcMemoName);
  const MEMO_STR_OFF = ADPCM_TRACK_OFF + adpcmTrack.length;
  const memoStrField = new Uint8Array(memoNameBytes.length + 1); // NUL終端
  memoStrField.set(memoNameBytes, 0);

  // memoテーブル(16bitオフセットの並び、0で終端)。index=0の1エントリだけで足りる
  // (pmd_get_memo()はindex一致で即returnするため、後続エントリの有無を読まない)。
  const MEMO_TABLE_OFF = MEMO_STR_OFF + memoStrField.length;
  const MEMO_TABLE_LEN = 4; // u16(文字列オフセット) + u16(終端0)

  // toneptr-4/-2/-1に置く「memoポインタ+flagバイト」領域。TONE_OFFの直前に置く。
  const MEMO_PTR_FIELD_OFF = MEMO_TABLE_OFF + MEMO_TABLE_LEN;
  const TONE_OFF = MEMO_PTR_FIELD_OFF + 4; // [memoptr u16][flaglow][flaghigh]

  const relLen = TONE_OFF + fmToneEntry.length;
  const rel = new Uint8Array(relLen);
  function w16(off, val) {
    rel[off] = val & 0xff;
    rel[off + 1] = (val >> 8) & 0xff;
  }
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
  rel.set(memoStrField, MEMO_STR_OFF);
  w16(MEMO_TABLE_OFF, MEMO_STR_OFF); // memoテーブル[0] = 文字列オフセット
  w16(MEMO_TABLE_OFF + 2, 0); // 終端
  w16(MEMO_PTR_FIELD_OFF, MEMO_TABLE_OFF); // toneptr-4 = memoptr
  rel[MEMO_PTR_FIELD_OFF + 2] = 0x40; // toneptr-2 = flaglow(index補正なし)
  rel[MEMO_PTR_FIELD_OFF + 3] = 0x00; // toneptr-1 = flaghigh(flaglow==0x40のため未使用)
  rel.set(fmToneEntry, TONE_OFF);

  const file = new Uint8Array(1 + relLen);
  file[0] = 0; // opm_flag
  file.set(rel, 1);
  return file;
}

// --- PPC形式(fmdriver_pmd.c:6076 pmd_ppc_load())のバイト列(tools/verify_pmd_channel_mute.mjsと同一) ---
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

const ALL_EXCEPT_ADPCM = new Set([...FM_CHANNELS, ...SSG_CHANNELS, RHYTHM_CHANNEL]);

// 条件ごとにcreatePmdWeb()を作り直し、状態を持ち越さない。
// placement: 'songDir' (writeSongWithPcm経由・本番と同じ) / 'root' (ルート直下に直接置く
// 陽性対照) / 'none' (.PPCを置かない陰性対照)
async function measure({ fileBytes, ppcBytes, placement }) {
  const Module = await createPmdWeb();
  let songPath;
  if (placement === 'songDir') {
    songPath = writeSongWithPcm(Module, {
      songName: 'TEST.M',
      songBytes: fileBytes,
      pcmFiles: ppcBytes ? [{ name: 'TEST.PPC', data: ppcBytes }] : [],
    });
  } else if (placement === 'root') {
    Module.FS.writeFile('/TEST.M', fileBytes);
    if (ppcBytes) Module.FS.writeFile('/TEST.PPC', ppcBytes);
    songPath = '/TEST.M';
  } else {
    // 'none': songDir経由だが.PPCを渡さない
    songPath = writeSongWithPcm(Module, { songName: 'TEST.M', songBytes: fileBytes, pcmFiles: [] });
  }
  const error = Module.playMusic(songPath);
  if (error) throw new Error(`playMusic failed (placement=${placement}): ${error}`);
  Module.setChannelMask(buildPmdChannelMask(ALL_EXCEPT_ADPCM));
  let absSum = 0;
  for (let i = 0; i < 400; i++) absSum += Module.renderFramesForTest(2048);
  return absSum;
}

// --- [結線]検査: html/pmd-app.jsを実ファイルとして読み、文字列で検査する ---
function verifyWiring() {
  const src = fs.readFileSync(path.join(__dirname, '../html/pmd-app.js'), 'utf8');
  check(
    '[結線] pmd-app.jsがwriteSongWithPcmをimportしている',
    /import\s*\{[^}]*writeSongWithPcm[^}]*\}\s*from\s*'\.\/net\/pmd-pcm\.js'/.test(src),
  );
  check(
    '[結線] pmd-app.jsがcollectPmdPcmFilesをimportしている',
    /import\s*\{[^}]*collectPmdPcmFiles[^}]*\}\s*from\s*'\.\/net\/pmd-pcm\.js'/.test(src),
  );
  // ルート直下へ直接書く旧実装の残骸が無いこと(FS.writeFile('/' + name のような形)。
  const rootWriteRe = /FS\.writeFile\(\s*'\/'\s*\+/;
  check('[結線] ルート直下へ直接書く記述(FS.writeFile(\'/\' + ...))が残っていない', !rootWriteRe.test(src));
  // 書庫の枝(openPmdFile/loadSongFromUrl)がcollectPmdPcmFilesの結果を渡していること。
  // 同名PCM取り違え修正(2026-08-18)で、選ばれた曲の書庫内エントリ名
  // (chosen.entry.name)も第2引数として渡すようになった。
  const archiveBranchCalls = src.match(/collectPmdPcmFiles\(resolved\.entries,\s*chosen\.entry\.name\)/g) || [];
  check(
    '[結線] 書庫の枝(openPmdFile/loadSongFromUrl)が2箇所ともcollectPmdPcmFiles(resolved.entries, chosen.entry.name)を渡している',
    archiveBranchCalls.length >= 2,
    `検出数=${archiveBranchCalls.length}`,
  );
}

async function main() {
  console.log('=== PMD .PPC UI読み込み 実測検証 ===\n');

  const fmTone = buildToneEntry({ tonenum: 1, ar: [31, 31, 31, 31], tl: [0, 20, 20, 0], alg: 7 });
  const fileBytes = buildFmAndAdpcmFileWithMemo({
    fmToneEntry: fmTone, fmLength: 96, adpcmTonenum: 1, adpcmLength: 96, ppcMemoName: 'TEST.PPC',
  });
  const ppcBytes = buildTestPpcFile({ payload: buildAdpcmPayload(4096) });
  console.log(`.M file size=${fileBytes.length} bytes / PPC file size=${ppcBytes.length} bytes\n`);

  checkDeadline('組み立て後');

  const songDirSum = await measure({ fileBytes, ppcBytes, placement: 'songDir' });
  console.log(`[本体] songDir配置(writeSongWithPcm経由): absSum=${songDirSum}`);
  checkDeadline('本体測定後');

  const rootSum = await measure({ fileBytes, ppcBytes, placement: 'root' });
  console.log(`[陽性対照] ルート直下配置: absSum=${rootSum}`);
  checkDeadline('陽性対照測定後');

  const noneSum = await measure({ fileBytes, ppcBytes: null, placement: 'none' });
  console.log(`[陰性対照] .PPCを置かない: absSum=${noneSum}`);
  checkDeadline('陰性対照測定後');

  console.log('');
  check('[本体] songDir配置(本番経路)ではADPCM以外ミュートでもabsSumが非0(=.PPCが読めた証拠)',
    songDirSum > 0, `absSum=${songDirSum}`);

  const threshold = Math.max(songDirSum * 0.01, 1);
  check('[陽性対照] ルート直下配置ではabsSumがほぼ0(=この検査が実際に症状で落ちる側の確認)',
    rootSum <= threshold, `absSum=${rootSum} 閾値=${threshold.toFixed(2)} (songDir比=${songDirSum > 0 ? (rootSum / songDirSum * 100).toFixed(4) : 'n/a'}%)`);

  check('[陰性対照] .PPCを置かない場合absSumがほぼ0',
    noneSum <= threshold, `absSum=${noneSum} 閾値=${threshold.toFixed(2)}`);

  console.log('');
  verifyWiring();

  console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
  console.log(`実測値まとめ: songDir=${songDirSum} root=${rootSum} none=${noneSum}`);
  if (failCount > 0) process.exit(1);
}

main();
