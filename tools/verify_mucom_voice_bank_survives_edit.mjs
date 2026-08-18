#!/usr/bin/env node
// PMD側の横展開作業(第1弾、課題C)の検証。
//
// 対象: 「書庫から対になるシステムディスク付きの曲を開く → applyMmlBytes(bytes,
// {voiceBank, voiceBankSource}) で currentVoiceBank が入る → MMLを編集して
// compileAndPlay() を再実行 → それでも外部バンクがコンパイルへ渡り続ける
// (voiceBankApplied === true、#voice 注入が起きる)」こと。
//
// 現状の実装は既に正しい(currentVoiceBankはapplyMmlBytes()が唯一の書き込み窓口で、
// compileAndPlay()は毎回voiceBankAppliedを判定して使うだけで書き換えない)。これを
// 守るテストが無かったため新設する。「編集を閉じたら元データへ戻す」課題(html/
// mucom-app.js applyMmlBytes()/currentSongName周り、PMD側の課題①相当)は今回の
// 対象外で、ここでは触れていない。
//
// html/mucom-app.jsはDOM/wasmに依存する閉じたクロージャのため、既存の
// tools/verify_mucom_voice_name_bank.mjs(合成データでの直接検証)と
// tools/verify_pmd_mml_source_restore_on_editor_reopen.mjs(ソースからブロックを
// 抽出して構造を検査する[結線]+実際に動かす[本体]+[陽性対照])の両方の作法を踏襲する。
//
// 実行: node tools/verify_mucom_voice_bank_survives_edit.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(__dirname, '../html/mucom-app.js');
const src = fs.readFileSync(srcPath, 'utf8');

let passCount = 0;
let failCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

function extractBlock(name, re) {
  const m = re.exec(src);
  if (!m) throw new Error(`${name} の抽出に失敗しました(実装の形が変わった?)`);
  return m[0];
}

console.log('=== tools/verify_mucom_voice_bank_survives_edit.mjs: 外部音色バンクが編集をまたいで維持されるかの検証 ===\n');

// --- [結線] currentVoiceBankの書き込み窓口と、compileAndPlay()での使い方を確認する ---

const applyMmlBytesBody = extractBlock(
  'applyMmlBytes()',
  /function applyMmlBytes\(bytesOrBuffer, opts = \{\}\) \{[\s\S]*?\n {2}\}\n/,
);
const compileAndPlayBody = extractBlock(
  'compileAndPlay()',
  /function compileAndPlay\(\) \{[\s\S]*?\n {2}\}\n/,
);

check('[結線] applyMmlBytes()がcurrentVoiceBankへopts.voiceBank(省略時null)を書き込んでいる',
  /currentVoiceBank\s*=\s*opts\.voiceBank\s*\?\?\s*null;/.test(applyMmlBytesBody));

check('[結線] compileAndPlay()はvoiceBankAppliedをcurrentVoiceBankから毎回計算している',
  /const voiceBankApplied = Boolean\(currentVoiceBank\) && !EXPLICIT_VOICE_TAG_RE\.test\(mml\);/.test(compileAndPlayBody));

// 最重要: compileAndPlay()自身はcurrentVoiceBankへ一切代入しない(=編集して
// 再コンパイルしても前回開いたときの値がそのまま生き続ける)ことを、関数本体の
// 中に代入文が無いことで確認する。
check('[結線] compileAndPlay()の中にcurrentVoiceBankへの代入(書き換え)が無い(=applyMmlBytes()以外は触らない)',
  !/currentVoiceBank\s*=/.test(compileAndPlayBody));

check('[結線] compileAndPlay()はvoiceBankApplied時にVOICE_BANK_MEMFS_PATHへcurrentVoiceBankを書き込んでいる',
  /Module\.FS\.writeFile\(VOICE_BANK_MEMFS_PATH, currentVoiceBank\);/.test(compileAndPlayBody));

check('[結線] compileAndPlay()はvoiceBankApplied時に#voiceヘッダをコンパイル専用テキストへ注入している',
  /mmlForCompile = `#voice \$\{VOICE_BANK_MEMFS_PATH\}\\n\$\{mmlNameResolved\}`;/.test(compileAndPlayBody));

// EXPLICIT_VOICE_TAG_RE自体(MML側が既に#voiceを持っていたら外部バンクを使わない、
// という既存仕様)をソースから抽出し、[本体]シミュレーションで実際に使う
// (二重管理を避け、正規表現がずれたらこのテストごと壊れるようにする)。
const explicitVoiceTagReSrc = extractBlock(
  'EXPLICIT_VOICE_TAG_RE',
  /const EXPLICIT_VOICE_TAG_RE = \/[^/]+\/im;/,
);
const explicitVoiceTagReLiteral = /\/([^/]+)\/im;/.exec(explicitVoiceTagReSrc)[1];
const EXPLICIT_VOICE_TAG_RE = new RegExp(explicitVoiceTagReLiteral, 'im');

// --- [本体] 実際の手順をタイムラインとしてシミュレートする ---------------------------
// compileAndPlay()自体はwasm(Module.compileMML等)に依存し丸ごとは実行できないため、
// [結線]で確認済みの「voiceBankAppliedの計算式」をそのまま使い、状態遷移だけを再現する。

function simulateTimeline({ compileMutatesVoiceBank }) {
  const state = { currentVoiceBank: null, currentVoiceBankSource: null };
  const BANK = new Uint8Array([1, 2, 3]); // 合成データ(中身の値はここでは無関係)

  // 手順1: 書庫から対になるシステムディスク付きの曲を開く(applyMmlBytes()相当)。
  function applyMmlBytesSim(opts) {
    // [結線]で確認した式: currentVoiceBank = opts.voiceBank ?? null;
    state.currentVoiceBank = opts.voiceBank ?? null;
    state.currentVoiceBankSource = opts.voiceBankSource ?? null;
  }
  applyMmlBytesSim({ voiceBank: BANK, voiceBankSource: 'SYS_DISK.D88' });

  // compileAndPlay()相当(1回目、開いた直後の再生)。
  function compileAndPlaySim(mml) {
    if (compileMutatesVoiceBank) {
      // [陽性対照用] 修正前に想定される壊れ方: compileAndPlay()がcurrentVoiceBankを
      // 無視/消費してしまう(利用者指示の壊し方「currentVoiceBankをcompileAndPlay内で
      // 無視する」を模したもの)。
      state.currentVoiceBank = null;
    }
    return Boolean(state.currentVoiceBank) && !EXPLICIT_VOICE_TAG_RE.test(mml);
  }

  const firstApplied = compileAndPlaySim('A cdefg\n');

  // 手順2: MMLを編集する(textareaを書き換えるだけで、applyMmlBytes()は経由しない。
  // btnNewMml等、明示的に「曲を切り替える」操作以外は currentVoiceBank に触れない)。
  const editedMml = 'A cdefgab\n'; // 音を1つ足しただけの編集を模す

  // 手順3: 編集後、compileAndPlay()を再実行する(再コンパイル)。
  const secondApplied = compileAndPlaySim(editedMml);

  return { firstApplied, secondApplied, bankStillPresent: Boolean(state.currentVoiceBank) };
}

const fixed = simulateTimeline({ compileMutatesVoiceBank: false });
check('[本体] 修正後(現状の実装)相当: 曲を開いた直後のコンパイルで外部バンクが適用される',
  fixed.firstApplied === true);
check('[本体] 修正後(現状の実装)相当: MMLを編集して再コンパイルしても外部バンクが適用され続ける',
  fixed.secondApplied === true, JSON.stringify(fixed));
check('[本体] 修正後(現状の実装)相当: 2回目のコンパイル後もcurrentVoiceBank自体は消えていない',
  fixed.bankStillPresent === true);

// --- [陽性対照] compileAndPlay()がcurrentVoiceBankを消費・無視する壊れ方をした場合、
//     このテストが実際にFAILすることを確認する(検出器が機能している証拠) ---
const broken = simulateTimeline({ compileMutatesVoiceBank: true });
check('[陽性対照] compileAndPlay()がcurrentVoiceBankを無視(消費)する壊れ方をすると、1回目から外部バンクが適用されない',
  broken.firstApplied === false, JSON.stringify(broken));
check('[陽性対照] 同じ壊れ方では、編集後の再コンパイルでも当然外部バンクが適用されない(=このテストは対象を踏んでいる)',
  broken.secondApplied === false, JSON.stringify(broken));

console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
process.exit(failCount > 0 ? 1 : 0);
