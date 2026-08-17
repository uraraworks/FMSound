#!/usr/bin/env node
// PMDのPCM(.PPC/.PZI/.PVI/.P86/.PPS)が読み込めなかったとき、利用者に理由が
// 表示されることの実測検証。net/pmd-pcm.js describePmdPcmStatus()が生成する
// キー/引数が正しいこと、その材料(pmdweb_get_pcm_*エクスポート)が実際の
// wasmから正しく取れることの両方を見る。
//
// .M バイナリへPCMファイル名をmemoとして埋める生成器
// (buildFmAndAdpcmFileWithMemo)は tools/verify_pmd_ppc_load.mjs のものを
// そのまま流用する(別モジュールとしてexportされていないため、コメントの
// 出典を明記した上でこのファイルにも複製する。ロジックを分岐させない)。
//
// 検証項目:
//   [本体] PCMを添付せずplayMusic -> getPcmName(0)が埋め込んだ名前、
//          getPcmType(0)==='PPC'、getPcmError(0)が真
//   [本体] PCMを添付してplayMusic -> getPcmError(0)が偽
//   [本体] describePmdPcmStatus()が上記slotsに対して不足メッセージのキーを
//          1件返し、引数にファイル名が含まれる
//   [本体] PCMを使っていない曲(memoにPCM名なし)ではdescribePmdPcmStatus()が
//          空配列を返す(使っていない曲に警告を出さない)
//   [本体] PPSスロット・P86の分岐がそれぞれ意図したキーを返す
//   [陽性対照] describePmdPcmStatus()が空配列を返すよう意図的に壊した入力
//          (error全false)で、本来の主張(missingメッセージが出ること)を
//          検証する側のチェックが実際にFAILする(症状で落ちる)ことを確認する
//   [結線] html/pmd-app.jsを実ファイルとして読み、describePmdPcmStatusを
//          呼んでいること・書庫の枝がcollectUnsupportedPmdPcmFilesを渡している
//          ことを文字列検査する
//   [i18n] ja/en両方に3キーが存在し、{files}プレースホルダを含むこと
//
// 実行: node tools/verify_pmd_pcm_missing.mjs
// (pmdweb/build-web/pmdweb.js が事前にビルド済みであること。180秒を超えたら打ち切る)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import { buildToneEntry } from '../compiler/gen_pmd_min.mjs';
import { writeSongWithPcm, describePmdPcmStatus, collectUnsupportedPmdPcmFiles } from '../net/pmd-pcm.js';
import { DICT as I18N_DICT } from '../ui/i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

// 陽性対照専用: condが「意図的に壊した入力のもとで本来の主張が成立するか」を
// 表す式のとき、それがfalse(=本来の主張が崩れて検査が症状で落ちる)であることを
// 確認する。condがtrueのままだと「壊しても検出できない」ことになり、それ自体を
// FAILとして報告する(単に「変えたら変わる」ではなく、症状で落ちることの確認)。
function checkExpectFail(name, cond, detail) {
  return check(name, cond === false, detail);
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

// --- `.M`バイナリ生成(tools/verify_pmd_ppc_load.mjs buildFmAndAdpcmFileWithMemo()を
//     複製。出典と仕組みのコメントも含め同一。改変していない) ---
function noteByte(octave, index) {
  return (octave << 4) | index;
}

function buildFmAndAdpcmFileWithMemo({
  fmToneEntry, fmLength = 96, adpcmTonenum = 1, adpcmLength = 96, ppcMemoName,
}) {
  const HEADER_LEN = 0x1a; // 11パート分ポインタ(22) + r_offset(2) + tone_ptr(2)
  const EMPTY_TRACK_OFF = HEADER_LEN;
  const FM1_TRACK_OFF = EMPTY_TRACK_OFF + 1;
  const fm1Track = Uint8Array.from([0xff, 1, noteByte(4, 0), fmLength & 0xff, 0x80]);
  const ADPCM_TRACK_OFF = FM1_TRACK_OFF + fm1Track.length;
  const adpcmTrack = Uint8Array.from([0xff, adpcmTonenum & 0xff, noteByte(4, 0), adpcmLength & 0xff, 0x80]);

  const memoNameBytes = new TextEncoder().encode(ppcMemoName);
  const MEMO_STR_OFF = ADPCM_TRACK_OFF + adpcmTrack.length;
  const memoStrField = new Uint8Array(memoNameBytes.length + 1); // NUL終端
  memoStrField.set(memoNameBytes, 0);

  const MEMO_TABLE_OFF = MEMO_STR_OFF + memoStrField.length;
  const MEMO_TABLE_LEN = 4; // u16(文字列オフセット) + u16(終端0)

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

// --- PPC形式(fmdriver_pmd.c:6076 pmd_ppc_load())のバイト列(verify_pmd_ppc_load.mjsと同一) ---
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

// 曲ロード後、PCMスロットをJS側のslots配列へ変換する(html/pmd-app.js
// reportPmdPcmStatus()と同じ組み立て方)。
function readPcmSlots(Module) {
  const count = Module.getPcmCount();
  const slots = [];
  for (let i = 0; i < count; i++) {
    slots.push({
      type: Module.getPcmType(i),
      name: Module.getPcmName(i),
      error: Module.getPcmError(i) !== 0,
    });
  }
  return slots;
}

async function main() {
  console.log('=== PMD PCM未読み込み案内 実測検証 ===\n');

  const fmTone = buildToneEntry({ tonenum: 1, ar: [31, 31, 31, 31], tl: [0, 20, 20, 0], alg: 7 });

  // --- ケース1: PCMを参照する曲、PCM本体は与えない(不足ケース) ---
  const fileWithPcmRef = buildFmAndAdpcmFileWithMemo({
    fmToneEntry: fmTone, ppcMemoName: 'TEST.PPC',
  });

  const ModuleMissing = await createPmdWeb();
  {
    const songPath = writeSongWithPcm(ModuleMissing, {
      songName: 'TEST.M', songBytes: fileWithPcmRef, pcmFiles: [],
    });
    const error = ModuleMissing.playMusic(songPath);
    if (error) throw new Error(`playMusic失敗(missing): ${error}`);
  }
  checkDeadline('missing曲再生後');

  const missingSlots = readPcmSlots(ModuleMissing);
  const slot0Missing = missingSlots[0];
  check('[本体] PCM本体を与えない場合、getPcmName(0)が埋め込んだ名前(拡張子抜き、pmd_filenamecopy仕様)',
    slot0Missing.name.trim() === 'TEST', `name="${slot0Missing.name}"`);
  check('[本体] PCM本体を与えない場合、getPcmType(0)==="PPC"',
    slot0Missing.type === 'PPC', `type="${slot0Missing.type}"`);
  check('[本体] PCM本体を与えない場合、getPcmError(0)が真',
    slot0Missing.error === true, `error=${slot0Missing.error}`);

  // --- ケース2: 同じ曲にPCM本体を添付する(成功ケース) ---
  const ModuleAttached = await createPmdWeb();
  {
    const ppcBytes = buildTestPpcFile({ payload: buildAdpcmPayload(4096) });
    const songPath = writeSongWithPcm(ModuleAttached, {
      songName: 'TEST.M', songBytes: fileWithPcmRef,
      pcmFiles: [{ name: 'TEST.PPC', data: ppcBytes }],
    });
    const error = ModuleAttached.playMusic(songPath);
    if (error) throw new Error(`playMusic失敗(attached): ${error}`);
  }
  checkDeadline('attached曲再生後');
  const attachedSlots = readPcmSlots(ModuleAttached);
  check('[本体] PCM本体を添付した場合、getPcmError(0)が偽',
    attachedSlots[0].error === false, `error=${attachedSlots[0].error}`);

  // --- describePmdPcmStatus(): 不足ケースのメッセージ ---
  const missingMessages = describePmdPcmStatus({ slots: missingSlots, unsupportedFiles: [] });
  check('[本体] describePmdPcmStatus()が不足時に1件のメッセージを返す',
    missingMessages.length === 1, `messages=${JSON.stringify(missingMessages)}`);
  check('[本体] 不足メッセージのキーがpmd.pcm.missing',
    missingMessages[0] && missingMessages[0].key === 'pmd.pcm.missing', `key=${missingMessages[0] && missingMessages[0].key}`);
  check('[本体] 不足メッセージの引数filesに"TEST.PPC"が含まれる',
    missingMessages[0] && missingMessages[0].params.files.includes('TEST.PPC'),
    `files="${missingMessages[0] && missingMessages[0].params.files}"`);

  // --- describePmdPcmStatus(): PCM本体を添付した場合はメッセージ無し ---
  const attachedMessages = describePmdPcmStatus({ slots: attachedSlots, unsupportedFiles: [] });
  check('[本体] PCM本体を添付した場合はdescribePmdPcmStatus()が空配列',
    attachedMessages.length === 0, `messages=${JSON.stringify(attachedMessages)}`);

  // --- PPZ1/PPZ2の表示: .PZIか.PVIかをwork.pcmtype/pcmnameだけでは区別できないため
  //     断定せず両方示す(2026-08-17利用者指摘。upstream loadpmdppz()が両方試す実装に
  //     合わせた)。ここで拡張子を片方に決め打ちへ戻すとこの検査が落ちる。
  //     実ファイル経由(wasm)ではなく純関数として検証する(PPS/P86の検証と同じ理由:
  //     この分岐はslotsの内容だけで決まり、wasm側の再現に意味が無いため)。 ---
  const ppzMessages = describePmdPcmStatus({
    slots: [{ type: 'PPZ1', name: 'MYPPZ', error: true }],
    unsupportedFiles: [],
  });
  check('[本体] PPZ1不足時、describePmdPcmStatus()がpmd.pcm.missingを1件返す',
    ppzMessages.length === 1 && ppzMessages[0].key === 'pmd.pcm.missing',
    `messages=${JSON.stringify(ppzMessages)}`);
  check('[本体] PPZ1不足の表示に.PZIと.PVIの両方が含まれる(拡張子を断定しない)',
    ppzMessages[0] && ppzMessages[0].params.files.includes('.PZI') && ppzMessages[0].params.files.includes('.PVI'),
    `files="${ppzMessages[0] && ppzMessages[0].params.files}"`);
  check('[本体] PPZ1の表示文字列の実例が"MYPPZ.PZI / .PVI"',
    ppzMessages[0] && ppzMessages[0].params.files === 'MYPPZ.PZI / .PVI',
    `files="${ppzMessages[0] && ppzMessages[0].params.files}"`);

  // --- ケース3: PCMを一切参照しない曲(memo名を空文字) ---
  const fileWithoutPcmRef = buildFmAndAdpcmFileWithMemo({ fmToneEntry: fmTone, ppcMemoName: '' });
  const ModuleUnused = await createPmdWeb();
  {
    const songPath = writeSongWithPcm(ModuleUnused, {
      songName: 'TEST.M', songBytes: fileWithoutPcmRef, pcmFiles: [],
    });
    const error = ModuleUnused.playMusic(songPath);
    if (error) throw new Error(`playMusic失敗(unused): ${error}`);
  }
  checkDeadline('unused曲再生後');
  const unusedSlots = readPcmSlots(ModuleUnused);
  const unusedMessages = describePmdPcmStatus({ slots: unusedSlots, unsupportedFiles: [] });
  check('[本体] PCMを使っていない曲ではdescribePmdPcmStatus()が空配列(使っていない曲に警告を出さない)',
    unusedMessages.length === 0, `messages=${JSON.stringify(unusedMessages)} name(slot0)="${unusedSlots[0] && unusedSlots[0].name}"`);

  // --- PPSスロットの分岐(純関数として検証。PPSDRV自体はupstream未実装なので
  //     wasm側で実データを再現する必要は無い。fmdriver.h/fmdriver_pmd.c pmd_init()の
  //     pcmerror[3]=true固定という仕様を、slotsに直接反映させて検証する) ---
  const ppsMessages = describePmdPcmStatus({
    slots: [{ type: 'PPS', name: 'DRUMS', error: true }],
    unsupportedFiles: [],
  });
  check('[本体] PPSスロットが使われている場合、pmd.pcm.ppsUnsupportedキーを返す',
    ppsMessages.length === 1 && ppsMessages[0].key === 'pmd.pcm.ppsUnsupported',
    `messages=${JSON.stringify(ppsMessages)}`);
  check('[本体] PPSメッセージの引数filesにスロット名が含まれる',
    ppsMessages[0] && ppsMessages[0].params.files.includes('DRUMS'),
    `files="${ppsMessages[0] && ppsMessages[0].params.files}"`);

  // --- P86の分岐(collectUnsupportedPmdPcmFiles()経由の書庫由来ファイル一覧から) ---
  const unsupportedFromArchive = collectUnsupportedPmdPcmFiles([
    { name: 'songs/DRUM86.P86', data: new Uint8Array(0) },
    { name: 'songs/OTHER.TXT', data: new Uint8Array(0) },
  ]);
  check('[本体] collectUnsupportedPmdPcmFiles()が.P86だけを拾う(basename化・拡張子大文字化)',
    unsupportedFromArchive.length === 1 && unsupportedFromArchive[0].name === 'DRUM86.P86' && unsupportedFromArchive[0].ext === '.P86',
    `result=${JSON.stringify(unsupportedFromArchive)}`);
  const p86Messages = describePmdPcmStatus({ slots: [], unsupportedFiles: unsupportedFromArchive });
  check('[本体] .P86が書庫にある場合、pmd.pcm.p86Unsupportedキーを返す',
    p86Messages.length === 1 && p86Messages[0].key === 'pmd.pcm.p86Unsupported',
    `messages=${JSON.stringify(p86Messages)}`);
  check('[本体] P86メッセージの引数filesにファイル名が含まれる',
    p86Messages[0] && p86Messages[0].params.files.includes('DRUM86.P86'),
    `files="${p86Messages[0] && p86Messages[0].params.files}"`);

  // --- 陽性対照: 不足しているのにerrorを全部falseへ壊した入力では、
  //     「不足メッセージが出る」という本来の主張が成立しなくなる(=検査が症状で落ちる)
  //     ことを確認する。単純に「変えたら変わる」ではなく、元の主張(messages.length===1)
  //     を壊れたデータに対して評価し、それが崩れることそのものを確認する形にする。 ---
  const brokenSlots = missingSlots.map((s) => ({ ...s, error: false }));
  const brokenMessages = describePmdPcmStatus({ slots: brokenSlots, unsupportedFiles: [] });
  checkExpectFail(
    '[陽性対照] error全falseに壊すと、不足メッセージが出るという主張(messages.length===1)は症状で崩れる',
    brokenMessages.length === 1,
    `壊れた入力でのmessages=${JSON.stringify(brokenMessages)}(検出できていれば長さ0になっているはず)`,
  );

  // --- [結線] html/pmd-app.js を実ファイルとして読み、文字列検査する ---
  const appSrc = fs.readFileSync(path.join(__dirname, '../html/pmd-app.js'), 'utf8');
  check('[結線] pmd-app.jsがdescribePmdPcmStatusをimportしている',
    /import\s*\{[^}]*describePmdPcmStatus[^}]*\}\s*from\s*'\.\/net\/pmd-pcm\.js'/.test(appSrc));
  check('[結線] pmd-app.jsがdescribePmdPcmStatus()を実際に呼んでいる',
    /describePmdPcmStatus\(\{/.test(appSrc));
  check('[結線] pmd-app.jsがcollectUnsupportedPmdPcmFilesをimportしている',
    /import\s*\{[^}]*collectUnsupportedPmdPcmFiles[^}]*\}\s*from\s*'\.\/net\/pmd-pcm\.js'/.test(appSrc));
  const unsupportedBranchCalls = appSrc.match(/collectUnsupportedPmdPcmFiles\(resolved\.entries\)/g) || [];
  check('[結線] 書庫の枝が2箇所ともcollectUnsupportedPmdPcmFiles(resolved.entries)を渡している',
    unsupportedBranchCalls.length >= 2, `検出数=${unsupportedBranchCalls.length}`);
  check('[結線] playBytes()がgetPcmCount()を使ってPCM状態を組み立てている',
    /getPcmCount\(\)/.test(appSrc) && /getPcmName\(/.test(appSrc) && /getPcmType\(/.test(appSrc) && /getPcmError\(/.test(appSrc));

  // --- [i18n] ja/en両方に3キーが存在し、{files}プレースホルダを含むこと。
  //     ja/en間の整合性(キー集合一致・プレースホルダ集合一致・訳し忘れ検出)は
  //     tools/verify_i18n.mjs が既に汎用的に検査している(DICT全体を走査するため、
  //     このスクリプトが新設したキーも自動的に対象へ入る)。ここではその前段として
  //     「そもそもキーが存在し{files}を含むか」だけを軽く確認する。 ---
  const PMD_PCM_KEYS = ['pmd.pcm.missing', 'pmd.pcm.ppsUnsupported', 'pmd.pcm.p86Unsupported'];
  for (const lang of ['ja', 'en']) {
    for (const key of PMD_PCM_KEYS) {
      const value = I18N_DICT[lang] && I18N_DICT[lang][key];
      check(`[i18n] ${lang}.${key} が存在し{files}を含む`,
        typeof value === 'string' && value.includes('{files}'), `value="${value}"`);
    }
  }

  console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
  if (failCount > 0) process.exit(1);
}

main();
