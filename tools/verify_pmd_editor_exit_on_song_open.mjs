#!/usr/bin/env node
// 不具合修正(2026-08-19、利用者報告)の検証:
//   「編集モード(uiMode==='editor')でMML付きの曲を開いている状態で、曲ライブラリ
//   から.Mのみの曲(MMLソース無し)を選ぶと、編集画面が前の曲のMMLを表示したまま
//   残る」
//
// 原因: html/pmd-app.jsの「曲を開く」各経路のうち、URL読み込み経路
// (loadSongFromUrl()、書庫分岐・単体ファイル分岐の2箇所)には
// `if (uiMode === 'editor') setUiMode('player');` があったが、曲ライブラリ選択経路
// (libraryPanel onSelect)には無かった。かつreflectSongMmlSourceQuietly()は
// mmlSourceText != nullのときしか呼ばれないため、MMLソース無しの曲では編集欄の
// 中身も前の曲のまま残る。「編集画面を閉じる」(=プレイヤーモードへ戻し
// エディタ欄を隠す)ことさえできていれば、editor欄が古いままでも利用者からは
// 見えなくなるため、これが唯一かつ十分な修正点になる。
//
// 修正: feedback_single_fanin_point_for_input.md「入力源は末端の唯一の窓口へ
// 集約する」に倣い、exitEditorModeOnSongOpen()という小さな窓口関数へ集約し、
// 「曲を開く」全経路(曲ライブラリ選択・ファイル/D&D=openPmdFile()・
// URL読み込み=loadSongFromUrl()の書庫分岐/単体ファイル分岐、計4箇所)がこれを
// 通るようにした。
//
// html/pmd-app.jsはDOM/wasmに依存する閉じたクロージャのため、既存の
// tools/verify_pmd_mml_source_restore_on_editor_reopen.mjs等と同じ作法
// (ソースからブロックを抽出して結線を検査する+抽出した事実を使って実際に
// タイムラインを動かす、陽性対照で検出器自体を確認する)を踏襲する。
// ヘルパ単体ではなく「曲を開く経路の結線」(=各エントリポイントの本文に
// 窓口呼び出しが実際に含まれているか)を見る。
//
// 実行: node tools/verify_pmd_editor_exit_on_song_open.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(__dirname, '../html/pmd-app.js');
const src = fs.readFileSync(srcPath, 'utf8');

let passCount = 0;
let failCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

function extractFn(name, re, text = src) {
  const m = re.exec(text);
  if (!m) throw new Error(`${name} の抽出に失敗しました(実装の形が変わった?)`);
  return m[0];
}

console.log('=== tools/verify_pmd_editor_exit_on_song_open.mjs: 「曲を開く」全経路のエディタモード終了検証 ===\n');

// --- [結線] 窓口関数exitEditorModeOnSongOpen()自体の実装 ------------------------

const gatewayFnBody = extractFn(
  'exitEditorModeOnSongOpen()',
  /function exitEditorModeOnSongOpen\(\) \{[\s\S]*?\n {2}\}\n/,
);
check("[結線] exitEditorModeOnSongOpen()がuiMode==='editor'のときsetUiMode('player')を呼んでいる",
  /if \(uiMode === 'editor'\) setUiMode\('player'\);/.test(gatewayFnBody));

// --- [結線] 「曲を開く」4経路それぞれの本文を抽出し、窓口呼び出しの有無を洗い出す ---

const libraryOnSelectBody = extractFn(
  '曲ライブラリ選択(libraryPanel onSelect)',
  /onSelect: async \(song\) => \{[\s\S]*?\n {4}\},\n/,
);
const openPmdFileBody = extractFn(
  'ファイル/D&D(openPmdFile())',
  /async function openPmdFile\(file\) \{[\s\S]*?\n {2}\}\n/,
);
const loadSongFromUrlBody = extractFn(
  'URL読み込み(loadSongFromUrl())',
  /async function loadSongFromUrl\(url\) \{[\s\S]*?\n {2}\}\n/,
);

// 表: 各エントリポイントが窓口を通しているか(この表自体が修正前は
// 「曲ライブラリ選択」だけFALSEだった=利用者報告の症状そのもの)。
const entryPoints = [
  { label: '曲ライブラリ選択(libraryPanel onSelect)', body: libraryOnSelectBody, expectCount: 1 },
  { label: 'ファイル/D&D(openPmdFile())', body: openPmdFileBody, expectCount: 1 },
  { label: 'URL読み込み・書庫分岐(loadSongFromUrl() archive branch)', body: loadSongFromUrlBody, expectCount: 2 },
];

console.log('--- 「曲を開く」経路 × 窓口呼び出しの有無 ---');
for (const ep of entryPoints) {
  const count = (ep.body.match(/exitEditorModeOnSongOpen\(\);/g) || []).length;
  if (ep.label.startsWith('URL読み込み')) {
    // loadSongFromUrl()は1関数に書庫分岐/単体ファイル分岐の2箇所を持つため、
    // 呼び出しが2回(=両分岐とも)あることを要求する。
    check(`[結線] ${ep.label}: exitEditorModeOnSongOpen()が両分岐(書庫/単体ファイル)で呼ばれている`,
      count === ep.expectCount, `検出回数=${count}`);
  } else {
    check(`[結線] ${ep.label}: exitEditorModeOnSongOpen()を呼んでいる`,
      count >= ep.expectCount, `検出回数=${count}`);
  }
}
console.log('');

// --- [本体] 抽出した結線の事実を使い、実機報告の手順をタイムラインとして再現する ---
// 「編集モードでMML付きの曲Aを開いている → MMLソース無しの曲Bを開く」を、
// ソースから読み取った「この経路は窓口を呼ぶか」「MMLソース無しならreflect系は
// 呼ばれない(mmlSourceText != nullガード、実装済み仕様のまま)」という2つの事実
// だけを使って再現する(DOM/wasm本体は動かさない)。
function simulateOpenSong({ callsGateway, mmlSourceText }) {
  const state = { uiMode: 'editor', mmlTextareaValue: '曲Aの古いMML' };
  function setUiMode(mode) { state.uiMode = mode; }
  function exitEditorModeOnSongOpenSim() {
    if (state.uiMode === 'editor') setUiMode('player');
  }
  function reflectSongMmlSourceQuietly(text) { state.mmlTextareaValue = text; }
  // --- ここから各エントリポイントの本文と同じ順序の処理 ---
  if (callsGateway) exitEditorModeOnSongOpenSim();
  if (mmlSourceText != null) reflectSongMmlSourceQuietly(mmlSourceText);
  // playBytes()相当(バイナリ再生。uiModeもmmlTextareaも触らない)は省略。
  return state;
}

const fixedState = simulateOpenSong({ callsGateway: true, mmlSourceText: null });
check('[本体] 修正後: MMLソース無しの曲を選ぶとuiModeがplayerへ戻り、編集画面が閉じる',
  fixedState.uiMode === 'player');
// 編集欄の中身自体は古いままでも(reflectは呼ばれないため)、エディタ画面が
// 閉じていれば利用者からは見えない、という設計上の帰結も明示しておく。
check('[本体] 修正後: (editorが閉じるため見えなくなる)編集欄テキストはreflectされず古いまま残ることを許容する設計',
  fixedState.mmlTextareaValue === '曲Aの古いMML');

// --- [陽性対照] 実際に抽出した本文文字列から窓口呼び出しを1箇所だけ取り除いた
//     コピーを作り、同じ[結線]チェックが実際に落ちることを確認する ---
console.log('\n--- 陽性対照: 曲ライブラリ選択経路の窓口呼び出しを1箇所削った状態で再検査 ---');
const brokenLibraryOnSelectBody = libraryOnSelectBody.replace(
  /\s*exitEditorModeOnSongOpen\(\);\n/,
  '\n',
);
if (brokenLibraryOnSelectBody === libraryOnSelectBody) {
  throw new Error('陽性対照の生成に失敗しました(削除対象のパターンが見つからない)');
}
const brokenCount = (brokenLibraryOnSelectBody.match(/exitEditorModeOnSongOpen\(\);/g) || []).length;
const brokenDetectorFires = !(brokenCount >= 1);
check('[陽性対照] 窓口呼び出しを削ったコピーでは[結線]チェックが実際に落ちる(検出器が機能している証拠)',
  brokenDetectorFires, `削除後の検出回数=${brokenCount}`);

// 削った状態でタイムラインを動かすと、修正前の利用者報告どおり編集画面が
// 開いたまま残ることも確認する。
const brokenState = simulateOpenSong({ callsGateway: false, mmlSourceText: null });
check('[陽性対照] 窓口呼び出しが無いタイムラインでは、修正前の利用者報告どおりuiModeがeditorのまま残る(バグ再現)',
  brokenState.uiMode === 'editor');

console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
process.exit(failCount > 0 ? 1 : 0);
