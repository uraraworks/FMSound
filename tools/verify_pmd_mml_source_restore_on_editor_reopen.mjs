#!/usr/bin/env node
// 実機報告(2026-08-18、SS_TENGで編集が開けなくなる)の検証:
//   1. 書庫からMMLソース付きの曲を開く(playBytes()経由でcurrentSongMmlSourceTextが
//      埋まる)。
//   2. 編集モードでコンパイル&再生する(compileAndPlay()の末尾で
//      clearCurrentSongMmlSource()が呼ばれ、currentSongMmlSourceTextが消える。
//      これは「今編集中のテキストは曲の識別ではない」という別の目的のための
//      正しい動作)。
//   3. 編集を閉じる(restoreOriginalSongOnExitEditor()が元の.mへpendingUrlSongを
//      差し戻す)。
//   4. 差し戻された曲を再生する(pendingUrlSong消費 → playBytes() →
//      setCurrentSongMmlSource())。
//   5. もう一度編集ボタンを押す。
//
// 真因: restoreOriginalSongOnExitEditor()がpendingUrlSongへ再セットする際、
// MMLソース(mmlSourceText)を持たせていなかった。手順2でcurrentSongMmlSourceTextは
// 一度nullに落ちており、手順3で「元の曲へ戻した」ことにはなってもMMLソースまでは
// 戻っていなかったため、手順4のplayBytes()がmmlSourceText=undefined(デフォルト値
// null)でsetCurrentSongMmlSource()を呼び、currentSongMmlSourceTextがnullのまま
// 確定してしまう。結果、手順5のガード(btnEditorModeハンドラの
// `currentSongIsLoaded && currentSongMmlSourceText == null`)が真になり
// 「この曲にはMMLソースが無いため編集できません」で弾かれる。
//
// 修正: currentSongOriginalBytes等と同じ「読み込んだ元の曲」専用の保管場所として
// currentSongOriginalMmlSourceTextを新設し、compileAndPlay()のclearCurrentSongMmlSource()
// では消さないようにした。restoreOriginalSongOnExitEditor()はこれをpendingUrlSong.
// mmlSourceTextへ渡し、手順4のplayBytes()がsetCurrentSongMmlSource()へ正しいMML
// ソースを渡せるようにする。
//
// html/pmd-app.jsはDOM/wasmに依存する閉じたクロージャのため、既存の
// tools/verify_pmd_editor_player_switch.mjs等と同じ作法(ソースからブロックを抽出
// して構造を検査する[結線]+その値を使って実際にタイムラインを動かす[本体]、
// 陽性対照で検出器自体を確認する)を踏襲する。
//
// 実行: node tools/verify_pmd_mml_source_restore_on_editor_reopen.mjs

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

function extractFn(name, re) {
  const m = re.exec(src);
  if (!m) throw new Error(`${name} の抽出に失敗しました(実装の形が変わった?)`);
  return m[0];
}

const restoreFnBody = extractFn(
  'restoreOriginalSongOnExitEditor()',
  /function restoreOriginalSongOnExitEditor\(\) \{[\s\S]*?\n {2}\}\n/,
);
const playBytesBody = extractFn(
  'playBytes()',
  /async function playBytes\(bytes, name, fileNameForBar = name, pcmFiles = \[\], unsupportedFiles = \[\], mmlSourceText = null, ffFile = null\) \{[\s\S]*?\n {2}\}\n/,
);
const markPendingSongAssetsBody = extractFn(
  'markPendingSongAssets()',
  /function markPendingSongAssets\(\{[\s\S]*?\n {2}\}\n/,
);
const clearAudioAssetsBody = extractFn(
  'clearCurrentSongAudioAssets()',
  /function clearCurrentSongAudioAssets\(\) \{[\s\S]*?\n {2}\}\n/,
);
const compileAndPlayBody = extractFn(
  'compileAndPlay()',
  /function compileAndPlay\(\) \{[\s\S]*?\n {2}\}\n/,
);
const btnEditorModeBody = extractFn(
  'btnEditorMode click handler',
  /btnEditorMode\.addEventListener\('click', \(\) => \{[\s\S]*?\n {2}\}\);\n/,
);

console.log('=== tools/verify_pmd_mml_source_restore_on_editor_reopen.mjs: 元の.m復帰後のMMLソース保持検証 ===\n');

// --- [結線] 各関数がcurrentSongOriginalMmlSourceTextを正しく配線しているか ---------

check('[結線] restoreOriginalSongOnExitEditor()がpendingUrlSong.mmlSourceTextへcurrentSongOriginalMmlSourceTextを渡している',
  /mmlSourceText:\s*currentSongOriginalMmlSourceText/.test(restoreFnBody));

check('[結線] playBytes()が読み込んだ曲のmmlSourceTextをcurrentSongOriginalMmlSourceTextへ保存している',
  /currentSongOriginalMmlSourceText\s*=\s*mmlSourceText;/.test(playBytesBody));

check('[結線] markPendingSongAssets()がmmlSourceText引数を受け取りcurrentSongOriginalMmlSourceTextへ保存している',
  /mmlSourceText\s*=\s*null/.test(markPendingSongAssetsBody)
  && /currentSongOriginalMmlSourceText\s*=\s*mmlSourceText;/.test(markPendingSongAssetsBody));

check('[結線] clearCurrentSongAudioAssets()(新規作成等の「曲を経由しない」境界)がcurrentSongOriginalMmlSourceTextもリセットしている',
  /currentSongOriginalMmlSourceText\s*=\s*null;/.test(clearAudioAssetsBody));

check('[本体] compileAndPlay()はclearCurrentSongMmlSource()を呼ぶが、currentSongOriginalMmlSourceTextへは代入していない(編集中もとの曲の記憶を壊さない)',
  /clearCurrentSongMmlSource\(\);/.test(compileAndPlayBody)
  && !/currentSongOriginalMmlSourceText\s*=/.test(compileAndPlayBody));

const guardMatch = /currentSongIsLoaded && currentSongMmlSourceText == null/.exec(btnEditorModeBody);
check('[結線] btnEditorModeのガード条件式を検出できる', Boolean(guardMatch));
const guardExpr = guardMatch ? guardMatch[0] : 'currentSongIsLoaded && currentSongMmlSourceText == null';

// --- [本体] 実機報告の手順をタイムラインとしてシミュレートする -----------------------
// ソースから抽出した式(guardExpr)をそのまま使い、setCurrentSongMmlSource()/
// clearCurrentSongMmlSource()の意味(コメント参照、ソース607-618行)どおりの状態遷移を
// 再現する。restoreOriginalSongOnExitEditor()/playBytes()自体は複雑(DOM/wasm依存)な
// ため丸ごとは実行できないが、[結線]で確認済みの「何を渡すか」の配線だけをここでも
// 使い、値の受け渡し全体が正しく機能することを確認する。
function evalGuard(state) {
  // eslint-disable-next-line no-new-func
  return new Function('currentSongIsLoaded', 'currentSongMmlSourceText', `return (${guardExpr});`)(
    state.currentSongIsLoaded, state.currentSongMmlSourceText,
  );
}

function simulateTimeline({ restorePassesMmlSource }) {
  const SRC = '#title SS_TENG\nA...';
  const state = {
    currentSongIsLoaded: false,
    currentSongMmlSourceText: null,
    currentSongOriginalBytes: null,
    currentSongOriginalMmlSourceText: null,
  };
  // 手順1: 書庫から曲を開く(openPmdFile()がplayBytes()を直接呼ぶ経路)。
  function playBytesSim(bytes, mmlSourceText) {
    state.currentSongIsLoaded = true;
    state.currentSongMmlSourceText = mmlSourceText; // setCurrentSongMmlSource()相当
    state.currentSongOriginalBytes = bytes;
    state.currentSongOriginalMmlSourceText = mmlSourceText; // 修正後playBytes()の配線
  }
  playBytesSim({ id: 'B' }, SRC);
  check('[本体] 手順1: 曲を開いた直後はエディタボタンが妨げられない',
    evalGuard(state) === false);

  // 手順2: 編集モードでコンパイル&再生する(compileAndPlay()の末尾)。
  state.currentSongIsLoaded = false; // clearCurrentSongMmlSource()
  state.currentSongMmlSourceText = null; // clearCurrentSongMmlSource()
  // currentSongOriginalMmlSourceTextはcompileAndPlay()が触らない([結線]で確認済み)。

  // 手順3: 編集を閉じる(restoreOriginalSongOnExitEditor())。
  const pendingUrlSong = {
    bytes: state.currentSongOriginalBytes,
    mmlSourceText: restorePassesMmlSource ? state.currentSongOriginalMmlSourceText : undefined,
  };

  // 手順4: 差し戻された曲を再生する(pendingUrlSong消費 → playBytes())。
  playBytesSim(pendingUrlSong.bytes, pendingUrlSong.mmlSourceText ?? null);

  // 手順5: もう一度編集ボタンを押す。
  return evalGuard(state);
}

const fixedBlocked = simulateTimeline({ restorePassesMmlSource: true });
check('[本体] 修正後: 元の.mへ戻ったあと再生してから編集ボタンを押しても弾かれない',
  fixedBlocked === false);

// --- [陽性対照] restoreOriginalSongOnExitEditor()がmmlSourceTextを渡さなかった
//     (修正前の実装)場合、同じタイムラインで実際にブロックされることを確認する ---
const brokenBlocked = simulateTimeline({ restorePassesMmlSource: false });
check('[陽性対照] 修正前の配線(mmlSourceTextを渡さない)を再現すると、実際に編集ボタンが弾かれる(検出器が機能している証拠)',
  brokenBlocked === true);

console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
process.exit(failCount > 0 ? 1 : 0);
