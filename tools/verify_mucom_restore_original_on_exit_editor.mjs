#!/usr/bin/env node
// 課題(利用者提案、2026-08-18): 「編集モードを閉じても、読み込んだ元のMMLに戻らない」
// への対応(html/mucom-app.js restoreOriginalMmlOnExitEditorIfNeeded())の検証。
//
// PMD側(tools/verify_pmd_mml_source_restore_on_editor_reopen.mjs)と違い、MUCOM側は
// 「開くものが常にMMLソースそのもの」なので「元へ戻す」=「編集内容を破棄する」で
// あり、以下の条件を全て満たすときだけ確認ダイアログを出す設計にした:
//   1. lastLoadedRawBytes(読み込んだ元データ)を保持している
//   2. 現在の編集欄の内容が、読み込み時のMML(デコード後テキスト)と異なる
// 確認OKなら元のMMLへ戻す(applyMmlBytes()を再利用。opts.nameは渡さずFILEBARの
// 表示に触れない)。再コンパイルはしないが、mmlDirtyがfalseのまま残ると
// needsCompileNow()が「再コンパイル不要」と誤判定し、次の再生で戻す前の(編集後の)
// 古いコンパイル結果を鳴らしてしまうため、markMmlDirty()で必ず次回コンパイル
// されるようにしている(このテストの[本体]で最も重視する点)。
//
// [本体]の作法について(直前のtools/verify_mucom_voice_bank_survives_edit.mjsの
// 反省を踏まえる): あちらは状態遷移をテスト側で書き写しており、製品コードを
// 壊しても[本体]は落ちず[結線]だけが落ちるという弱さがあった。今回は
// restoreOriginalMmlOnExitEditorIfNeeded() 自体の関数本文をソースから正規表現で
// 丸ごと抽出し、new Function() で実際に評価・実行する(=分岐条件・比較条件・
// 呼び出し順序を一切書き写さず、ソースそのものを動かす)。DOM/wasmに依存する
// 自由変数(lastLoadedRawBytes/lastLoadedEncoding/mmlTextarea/decodeMmlBytesAs/t/
// window/moduleReady/stopPlayback/applyMmlBytes/markMmlDirty)だけをテスト側で
// モックとして注入する。書き写しになっている箇所: モック関数(applyMmlBytesモック
// 等)の「呼ばれたら記録するだけ」という中身自体はテスト側の記述であり、これは
// 製品側のapplyMmlBytes()の実装(net/charset.js等)を検証するものではない
// (それらは他のtools/verify_*.mjsが別途担当している)。ここではあくまで
// restoreOriginalMmlOnExitEditorIfNeeded()自身の分岐・呼び出し配線を検証する。
//
// 実行: node tools/verify_mucom_restore_original_on_exit_editor.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(__dirname, '../html/mucom-app.js');
const src = fs.readFileSync(srcPath, 'utf8');
const i18nPath = path.join(__dirname, '../ui/i18n.js');
const i18nSrc = fs.readFileSync(i18nPath, 'utf8');

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

console.log('=== tools/verify_mucom_restore_original_on_exit_editor.mjs: editor→player遷移でのMML復元の検証 ===\n');

// --- [結線] ------------------------------------------------------------------

const restoreFnFull = extractBlock(
  'restoreOriginalMmlOnExitEditorIfNeeded()',
  /function restoreOriginalMmlOnExitEditorIfNeeded\(\) \{[\s\S]*?\n {2}\}\n/,
);
const btnEditorModeBody = extractBlock(
  'btnEditorMode click handler',
  /btnEditorMode\.addEventListener\('click', \(\) => \{[\s\S]*?\n {2}\}\);\n/,
);

check('[結線] btnEditorModeハンドラは「編集→プレイヤー」遷移のときだけrestoreOriginalMmlOnExitEditorIfNeeded()を呼ぶ',
  /if \(next === 'player' && prevMode === 'editor'\) \{\s*restoreOriginalMmlOnExitEditorIfNeeded\(\);\s*\}/.test(btnEditorModeBody));

const editorBranchMatch = /if \(next === 'editor' && prevMode !== 'editor' && moduleReady\) \{[\s\S]*?\n {4}\}\n/.exec(btnEditorModeBody);
if (!editorBranchMatch) throw new Error('「プレイヤー→編集」遷移のif節の抽出に失敗しました');
const editorBranchOnly = editorBranchMatch[0];
check('[結線] 「プレイヤー→編集」遷移のif節はrestoreOriginalMmlOnExitEditorIfNeeded()を呼ばない(既存のstopPlayback()配線のみ)',
  !/restoreOriginalMmlOnExitEditorIfNeeded/.test(editorBranchOnly) && /stopPlayback\(\);/.test(editorBranchOnly));

check('[結線] 復元時のapplyMmlBytes()呼び出しはopts.nameを渡していない(FILEBAR表示に触れない設計)',
  /applyMmlBytes\(lastLoadedRawBytes, \{ forceEncoding: lastLoadedEncoding \}\);/.test(restoreFnFull));

{
  const matches = [...i18nSrc.matchAll(/'confirm\.restoreOriginalOnExitEditor':\s*("([^"]*)"|'([^']*)')/g)];
  check('[結線] confirm.restoreOriginalOnExitEditorキーが2箇所(ja/en)に定義されている', matches.length === 2, `件数=${matches.length}`);
  const allText = matches.map((m) => m[2] ?? m[3]).join(' ');
  check('[結線] ダイアログ文言に「Cmd/Ctrl+Z」等の取り消し可能を示唆する文言が含まれていない(textarea.valueへの直接代入はundoが効くと断定できないため)',
    !/Cmd|Ctrl|undo|元に戻せ/i.test(allText), allText);
}

// --- [本体] restoreOriginalMmlOnExitEditorIfNeeded() の関数本文をソースから抽出し、
//     new Function() で実際に評価・実行する ------------------------------------

const innerBodyMatch = /^function restoreOriginalMmlOnExitEditorIfNeeded\(\) \{\n([\s\S]*)\n {2}\}\n$/.exec(restoreFnFull);
if (!innerBodyMatch) throw new Error('restoreOriginalMmlOnExitEditorIfNeeded()の本体切り出しに失敗しました');
const innerBody = innerBodyMatch[1];

function runRestoreFn({ lastLoadedRawBytes, lastLoadedEncoding, textareaValue, originalText, confirmResult, moduleReady }) {
  const calls = { confirm: 0, confirmMessage: null, stopPlayback: 0, applyMmlBytes: [], markMmlDirty: 0 };
  const mmlTextarea = { value: textareaValue };
  const decodeMmlBytesAs = (bytes, encoding) => {
    // 実際のnet/charset.jsは呼ばず、テスト用の合成データを返すだけの薄いモック
    // (net/charset.js自体の正しさはtools/verify_net_charset.mjsが別途担当している)。
    if (bytes !== lastLoadedRawBytes) throw new Error('想定外のbytesで呼ばれた');
    if (encoding !== lastLoadedEncoding) throw new Error('想定外のencodingで呼ばれた');
    return originalText;
  };
  const t = (key) => key; // 文言そのものはi18n.js側の[結線]チェックで確認済み
  const win = { confirm: (msg) => { calls.confirm += 1; calls.confirmMessage = msg; return confirmResult; } };
  const stopPlayback = () => { calls.stopPlayback += 1; };
  const applyMmlBytes = (bytes, opts) => { calls.applyMmlBytes.push({ bytes, opts }); };
  const markMmlDirty = () => { calls.markMmlDirty += 1; };

  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'lastLoadedRawBytes', 'lastLoadedEncoding', 'mmlTextarea', 'decodeMmlBytesAs', 't', 'window',
    'moduleReady', 'stopPlayback', 'applyMmlBytes', 'markMmlDirty',
    innerBody,
  );
  fn(lastLoadedRawBytes, lastLoadedEncoding, mmlTextarea, decodeMmlBytesAs, t, win, moduleReady, stopPlayback, applyMmlBytes, markMmlDirty);
  return calls;
}

const RAW = new Uint8Array([1, 2, 3]); // 合成データ(中身の値はここでは無関係)
const ORIGINAL_TEXT = 'A cdefg\n';
const EDITED_TEXT = 'A cdefgab\n';

// 手順1: 一度も曲を読み込んでいない(新規作成/下書き復元のみ)。戻す元が無い。
const r1 = runRestoreFn({
  lastLoadedRawBytes: null, lastLoadedEncoding: null,
  textareaValue: EDITED_TEXT, originalText: ORIGINAL_TEXT,
  confirmResult: true, moduleReady: true,
});
check('[本体] 手順1: lastLoadedRawBytesが無いときは確認ダイアログを出さない', r1.confirm === 0, JSON.stringify(r1));
check('[本体] 手順1: lastLoadedRawBytesが無いときはapplyMmlBytes()を呼ばない', r1.applyMmlBytes.length === 0);

// 手順2: 読み込み済みだが、編集欄の内容が読み込み時と同じ(差が無い)。
const r2 = runRestoreFn({
  lastLoadedRawBytes: RAW, lastLoadedEncoding: 'utf-8',
  textareaValue: ORIGINAL_TEXT, originalText: ORIGINAL_TEXT,
  confirmResult: true, moduleReady: true,
});
check('[本体] 手順2: 編集欄が読み込み時と同じ内容なら確認ダイアログを出さず黙って切り替える', r2.confirm === 0, JSON.stringify(r2));
check('[本体] 手順2: 同上、applyMmlBytes()も呼ばない(戻す必要が無い)', r2.applyMmlBytes.length === 0);

// 手順3: 差がある状態で編集ボタンを押し、確認ダイアログでキャンセルする。
const r3 = runRestoreFn({
  lastLoadedRawBytes: RAW, lastLoadedEncoding: 'utf-8',
  textareaValue: EDITED_TEXT, originalText: ORIGINAL_TEXT,
  confirmResult: false, moduleReady: true,
});
check('[本体] 手順3: 差があれば確認ダイアログを出す', r3.confirm === 1, JSON.stringify(r3));
check('[本体] 手順3: キャンセルすればapplyMmlBytes()を呼ばない(編集内容のまま)', r3.applyMmlBytes.length === 0);
check('[本体] 手順3: キャンセルすればmarkMmlDirty()も呼ばない', r3.markMmlDirty === 0);
check('[本体] 手順3: キャンセルすればstopPlayback()も呼ばない(再生中の音を止めない)', r3.stopPlayback === 0);

// 手順4: 差がある状態で確認ダイアログをOKする(本命の復元シナリオ)。
const r4 = runRestoreFn({
  lastLoadedRawBytes: RAW, lastLoadedEncoding: 'utf-8',
  textareaValue: EDITED_TEXT, originalText: ORIGINAL_TEXT,
  confirmResult: true, moduleReady: true,
});
check('[本体] 手順4: OKすればapplyMmlBytes()を1回、元のバイト列とforceEncodingだけで呼ぶ(nameは渡さない)',
  r4.applyMmlBytes.length === 1
  && r4.applyMmlBytes[0].bytes === RAW
  && JSON.stringify(r4.applyMmlBytes[0].opts) === JSON.stringify({ forceEncoding: 'utf-8' }),
  JSON.stringify(r4.applyMmlBytes));
check('[本体] 手順4: OKすればmarkMmlDirty()を呼ぶ(mmlDirtyがfalseのまま残って古いコンパイル結果が再生される事故を防ぐ)',
  r4.markMmlDirty === 1);
check('[本体] 手順4: moduleReadyがtrueならstopPlayback()も呼ぶ(古い編集後の音を鳴らしたまま表示だけ戻らないように)',
  r4.stopPlayback === 1);

// 手順5: 手順4と同条件だがmoduleReadyがfalse(Module未初期化の早いタイミング)。
const r5 = runRestoreFn({
  lastLoadedRawBytes: RAW, lastLoadedEncoding: 'utf-8',
  textareaValue: EDITED_TEXT, originalText: ORIGINAL_TEXT,
  confirmResult: true, moduleReady: false,
});
check('[本体] 手順5: moduleReadyがfalseならstopPlayback()を呼ばない(Module未初期化で呼ぶとTDZ/例外になる既存の設計に合わせる)',
  r5.stopPlayback === 0);
check('[本体] 手順5: moduleReadyがfalseでも復元自体(applyMmlBytes()/markMmlDirty())は行う',
  r5.applyMmlBytes.length === 1 && r5.markMmlDirty === 1);

console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
process.exit(failCount > 0 ? 1 : 0);
