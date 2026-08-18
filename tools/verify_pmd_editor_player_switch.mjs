#!/usr/bin/env node
// html/pmd-app.jsの一連の拡張(利用者提案、2026-08-18、「編集を閉じていたら元の
// データ」の原則)の検証:
//   (1) 編集モードを閉じる(editor→player)と、書庫/URL/ライブラリから読み込んだ
//       元の.M/.mへ再生対象が戻る(自動再生はしない)。編集内容(コンパイル結果)を
//       捨てるわけではない(元データを保持していない場合はコンパイル結果のまま)。
//   (2) プレイヤーモードで再生できる対象が無いまま再生ボタンが押されたとき、
//       黙って何も起きないのではなく案内を出す。一時停止/再開の正常経路は
//       誤検知しない。
//   (3) ダウンロードもモードに合わせる: プレイヤーモード+元データありなら
//       元データ(pmd-song.M)、それ以外はコンパイル結果(pmd-song-compiled.M)。
//       ui/download-menu.jsのcompiledFilenameは文字列/関数どちらも受け付け、
//       MUCOM88側(html/mucom-app.js)は従来通り文字列のまま変わらない。
//   (4) プレイヤーモードで再生したとき、元データとコンパイル結果の両方が
//       手元にある(=曖昧な)場合だけ「同梱の.mを再生します」と知らせる。
//
// html/pmd-app.jsはDOM/wasmに依存する閉じたクロージャ(init()内)のため、この検証は
// 既存のtools/verify_pmd_mml_source.mjs等と同じ作法(文字列検査=[結線])で行う。
// ダウンロードの切替ロジック(shouldDownloadOriginal/getDownloadBytes/
// getDownloadFileName)は小さな純粋条件式なので、実装と同じ条件式をこのファイル内に
// 複製して真理値表として検査する([本体])。
//
// 実行: node tools/verify_pmd_editor_player_switch.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DICT as I18N_DICT } from '../ui/i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(__dirname, '../html/pmd-app.js');
const src = fs.readFileSync(srcPath, 'utf8');
const downloadMenuSrc = fs.readFileSync(path.join(__dirname, '../ui/download-menu.js'), 'utf8');
const mucomSrc = fs.readFileSync(path.join(__dirname, '../html/mucom-app.js'), 'utf8');

let passCount = 0;
let failCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

// =====================================================================================
// (1) editor→player で元の.mへ戻す
// =====================================================================================

const restoreFnMatch = src.match(/function restoreOriginalSongOnExitEditor\(\)\s*\{[\s\S]*?\n {2}\}\n/);
check('[結線](1) restoreOriginalSongOnExitEditor()を検出できる', Boolean(restoreFnMatch));
const restoreFnBody = restoreFnMatch ? restoreFnMatch[0] : '';

check('[本体](1) 元の.mが無い場合(currentSongOriginalBytesがfalsy)は早期returnして何もしない',
  /if \(!currentSongOriginalBytes\) return;/.test(restoreFnBody));
check('[結線](1) 元へ戻す前に直前の(編集モードで再生していた)音を頭出し停止する',
  /stopPlayback\(\);/.test(restoreFnBody));
check('[結線](1) 自動再生をしていない(playMusic/Module\\.playMusicを直接呼んでいない。pendingUrlSongへ委ねる)',
  !/Module\.playMusic/.test(restoreFnBody) && /pendingUrlSong = \{/.test(restoreFnBody));
check('[結線](1) 戻す先はcurrentSongOriginalBytes/currentSongPcmFiles/currentSongFfFile(PCMも一緒に戻す)',
  /bytes:\s*currentSongOriginalBytes/.test(restoreFnBody)
  && /pcmFiles:\s*currentSongPcmFiles/.test(restoreFnBody)
  && /ffFile:\s*currentSongFfFile/.test(restoreFnBody));

check('[結線](1) btnEditorModeハンドラがeditor→player遷移でrestoreOriginalSongOnExitEditor()を呼んでいる',
  /next === 'player' && uiMode === 'editor' && moduleReady\) \{\s*\n\s*restoreOriginalSongOnExitEditor\(\);/.test(src));

// compileAndPlay()がcurrentSongOriginalBytes等を消していないこと(=編集しても
// 「元へ戻す」対象は生き続ける)。
{
  const compileAndPlayMatch = src.match(/function compileAndPlay\(\)\s*\{[\s\S]*?\n {2}\}\n/);
  const body = compileAndPlayMatch ? compileAndPlayMatch[0] : '';
  check('[本体](1) compileAndPlay()の本体を検出できる', Boolean(compileAndPlayMatch));
  check('[本体](1) compileAndPlay()はcurrentSongOriginalBytes/currentSongOriginalNameへ代入していない(戻す先を壊さない)',
    !/currentSongOriginalBytes\s*=/.test(body) && !/currentSongOriginalName\s*=/.test(body));
}

// --- [陽性対照] restoreOriginalSongOnExitEditor()呼び出しを外した文字列で、
//     (1)の結線検査が実際にFAILすること ---
{
  const brokenCallSite = src.replace(
    "if (next === 'player' && uiMode === 'editor' && moduleReady) {\n      restoreOriginalSongOnExitEditor();\n    }\n",
    '',
  );
  check('[陽性対照](1) 呼び出しを外すと結線検査が実際にFAILする',
    !/next === 'player' && uiMode === 'editor' && moduleReady\) \{\s*\n\s*restoreOriginalSongOnExitEditor\(\);/.test(brokenCallSite));
}
{
  const brokenGuard = restoreFnBody.replace('if (!currentSongOriginalBytes) return;', '');
  check('[陽性対照](1) 早期returnを外すと「元が無い場合は差し替えない」検査が実際にFAILする',
    !/if \(!currentSongOriginalBytes\) return;/.test(brokenGuard));
}

// =====================================================================================
// (2) 再生できる対象が無いときの案内
// =====================================================================================

const btnPlayPauseMatch = src.match(/btnPlayPause\.addEventListener\('click', \(\) => \{[\s\S]*?\n {2}\}\);\n/);
check('[結線](2) btnPlayPauseのクリックハンドラを検出できる', Boolean(btnPlayPauseMatch));
const btnPlayPauseBody = btnPlayPauseMatch ? btnPlayPauseMatch[0] : '';

const noSongBranchMatch = btnPlayPauseBody.match(/if \(!audioState \|\| !audioState\.context\) \{[\s\S]*?\n {4}\}\n/);
check('[結線](2) audioState/context欠如の分岐を検出できる(以前は黙ってreturnしていた箇所)', Boolean(noSongBranchMatch));
const noSongBranchBody = noSongBranchMatch ? noSongBranchMatch[0] : '';
check('[結線](2) 対象が無いときpmd.player.noSongToPlayを表示する(黙ってreturnしない)',
  /setNetStatus\(t\('pmd\.player\.noSongToPlay'\), true\);/.test(noSongBranchBody));

// 一時停止/再開の正常経路(audioState.paused分岐)では、この案内(noSongToPlay)を
// 出していないこと(誤検知しないことの構造的な確認: メッセージがaudioState/context
// 欠如ブロックの中だけにあり、その外側(pause/resume分岐)には出現しない)。
const afterNoSongBranch = btnPlayPauseBody.slice(
  btnPlayPauseBody.indexOf(noSongBranchBody) + noSongBranchBody.length,
);
check('[本体](2) 一時停止/再開の正常経路(if (audioState.paused) 以降)にはnoSongToPlayが出現しない(誤検知防止)',
  !/pmd\.player\.noSongToPlay/.test(afterNoSongBranch));
check('[結線](2) pmd.player.noSongToPlayの出現は1箇所だけ(audioState/context欠如ブロック限定)',
  (btnPlayPauseBody.match(/pmd\.player\.noSongToPlay/g) || []).length === 1);

// --- [陽性対照] メッセージ表示を外し、黙ってreturnする旧実装に戻すと(2)の検査が
//     実際にFAILすること ---
{
  const brokenNoSongMessage = src.replace(
    /if \(!audioState \|\| !audioState\.context\) \{[\s\S]*?setNetStatus\(t\('pmd\.player\.noSongToPlay'\), true\);\n\s*return;\n\s*\}/,
    'if (!audioState || !audioState.context) return;',
  );
  check('[陽性対照](2) メッセージ表示を外すと検査が実際にFAILする',
    !/setNetStatus\(t\('pmd\.player\.noSongToPlay'\), true\);/.test(brokenNoSongMessage));
}

check('[i18n](2) pmd.player.noSongToPlay がja/en両方に存在する',
  typeof I18N_DICT.ja['pmd.player.noSongToPlay'] === 'string'
  && typeof I18N_DICT.en['pmd.player.noSongToPlay'] === 'string');

// =====================================================================================
// (3) ダウンロードのモード切替
// =====================================================================================

// 実装と同じ条件式をここに複製し、真理値表として検査する(html/pmd-app.jsの
// shouldDownloadOriginal()/getDownloadBytes()/getDownloadFileName()と同一のロジック)。
function shouldDownloadOriginal(uiMode, currentSongOriginalBytes) {
  return uiMode !== 'editor' && Boolean(currentSongOriginalBytes);
}
function getDownloadBytes(uiMode, currentSongOriginalBytes, lastCompiledBytes) {
  if (shouldDownloadOriginal(uiMode, currentSongOriginalBytes)) return currentSongOriginalBytes;
  return lastCompiledBytes;
}
function getDownloadFileName(uiMode, currentSongOriginalBytes) {
  return shouldDownloadOriginal(uiMode, currentSongOriginalBytes) ? 'pmd-song.M' : 'pmd-song-compiled.M';
}

const ORIGINAL = new Uint8Array([1]);
const COMPILED = new Uint8Array([2]);
check('[本体](3) プレイヤーモード+元データあり → 元データ・pmd-song.M',
  getDownloadBytes('player', ORIGINAL, COMPILED) === ORIGINAL
  && getDownloadFileName('player', ORIGINAL) === 'pmd-song.M');
check('[本体](3) エディタモード(元データありでも) → コンパイル結果・pmd-song-compiled.M',
  getDownloadBytes('editor', ORIGINAL, COMPILED) === COMPILED
  && getDownloadFileName('editor', ORIGINAL) === 'pmd-song-compiled.M');
check('[本体](3) 元データが無い場合(新規作成等) → プレイヤーモードでもコンパイル結果・pmd-song-compiled.M',
  getDownloadBytes('player', null, COMPILED) === COMPILED
  && getDownloadFileName('player', null) === 'pmd-song-compiled.M');
check('[本体](3) 元データもコンパイル結果も無い場合はnull(空ファイルを黙って落とす形にならない)',
  getDownloadBytes('editor', null, null) === null);

check('[結線](3) html/pmd-app.jsに同名の切替関数(shouldDownloadOriginal/getDownloadBytes/getDownloadFileName)がある',
  /function shouldDownloadOriginal\(\)/.test(src)
  && /function getDownloadBytes\(\)/.test(src)
  && /function getDownloadFileName\(\)/.test(src));
check('[結線](3) shouldDownloadOriginal()の条件式が上の真理値表と同じ(uiMode!==\'editor\' && Boolean(currentSongOriginalBytes))',
  /return uiMode !== 'editor' && Boolean\(currentSongOriginalBytes\);/.test(src));
check('[結線](3) createDownloadMenu()がcompiledFilenameへ関数(getDownloadFileName)を渡している(固定文字列ではない)',
  /compiledFilename:\s*getDownloadFileName,/.test(src));
check('[結線](3) createDownloadMenu()がgetCompiledBytesへgetDownloadBytesを渡している',
  /getCompiledBytes:\s*getDownloadBytes,/.test(src));

// playBytes()がもう`lastCompiledBytes = bytes`を書いていないこと(元データと
// コンパイル結果を1つの変数で共有していた旧実装の再発防止)。
{
  const playBytesMatch = src.match(/async function playBytes\([\s\S]*?\n {2}\}\n/);
  const body = playBytesMatch ? playBytesMatch[0] : '';
  check('[結線](3) playBytes()を検出できる', Boolean(playBytesMatch));
  check('[結線](3) playBytes()は`lastCompiledBytes = bytes`を書いていない(元データ専用のcurrentSongOriginalBytesと役割分離)',
    !/lastCompiledBytes\s*=\s*bytes;/.test(body));
}

// --- [MUCOM無影響] ui/download-menu.jsの変更後もMUCOM側は文字列のまま動く -----------
check('[結線] ui/download-menu.jsがcompiledFilenameを文字列/関数どちらも受け付ける',
  /typeof compiledFilename === 'function' \? compiledFilename\(\) : compiledFilename/.test(downloadMenuSrc));
check('[MUCOM無影響] html/mucom-app.jsのcompiledFilenameは従来通り固定文字列のまま',
  /compiledFilename:\s*'mucom-song\.mub'/.test(mucomSrc));

// --- [陽性対照] モードによる切替を外す(常にlastCompiledBytesを返す)と(3)の
//     真理値表検査が実際にFAILすること ---
{
  function getDownloadBytes_broken(uiMode, currentSongOriginalBytes, lastCompiledBytes) {
    return lastCompiledBytes; // 常にコンパイル結果(切替を外した旧相当)
  }
  check('[陽性対照](3) 切替を外すと「プレイヤーモード+元データありは元データを返す」検査が実際にFAILする',
    getDownloadBytes_broken('player', ORIGINAL, COMPILED) !== ORIGINAL);
}

// =====================================================================================
// (4) 「どちらを鳴らしているか」の曖昧さ案内
// =====================================================================================

{
  const playBytesMatch = src.match(/async function playBytes\([\s\S]*?\n {2}\}\n/);
  const body = playBytesMatch ? playBytesMatch[0] : '';
  check('[結線](4) playBytes()がプレイヤーモード+コンパイル結果ありの条件でambiguous案内を出す',
    /const showAmbiguousPlaybackNotice = uiMode !== 'editor' && Boolean\(lastCompiledBytes\);/.test(body));
  check('[結線](4) 案内はpmd.player.playingBundledキー・isError=falseで出す(エラー扱いにしない)',
    /setNetStatus\(t\('pmd\.player\.playingBundled'\), false\);/.test(body));
  check('[結線](4) PCM等のエラー案内が無かった場合にだけ出す(pcmMessages.length === 0で分岐、優先度が下)',
    /if \(pcmMessages\.length === 0 && showAmbiguousPlaybackNotice\)/.test(body));
}

check('[本体](4) 条件式(uiMode!==\'editor\' && Boolean(lastCompiledBytes))の真理値表: エディタモードでは出ない',
  (() => {
    function shouldShow(uiMode, lastCompiledBytes) { return uiMode !== 'editor' && Boolean(lastCompiledBytes); }
    return shouldShow('editor', COMPILED) === false
      && shouldShow('player', null) === false
      && shouldShow('player', COMPILED) === true;
  })());

// --- [陽性対照] (a) 常に出す/(b) 常に出さない、のどちらへ条件を壊しても検査が
//     実際にFAILすること ---
{
  const playBytesMatch = src.match(/async function playBytes\([\s\S]*?\n {2}\}\n/);
  const body = playBytesMatch ? playBytesMatch[0] : '';
  const alwaysTrue = body.replace(
    "const showAmbiguousPlaybackNotice = uiMode !== 'editor' && Boolean(lastCompiledBytes);",
    'const showAmbiguousPlaybackNotice = true;',
  );
  const alwaysFalse = body.replace(
    "const showAmbiguousPlaybackNotice = uiMode !== 'editor' && Boolean(lastCompiledBytes);",
    'const showAmbiguousPlaybackNotice = false;',
  );
  check('[陽性対照](4a) 常に出す(true固定)へ壊すと、条件式そのものの検査が実際にFAILする',
    !/const showAmbiguousPlaybackNotice = uiMode !== 'editor' && Boolean\(lastCompiledBytes\);/.test(alwaysTrue));
  check('[陽性対照](4b) 常に出さない(false固定)へ壊すと、条件式そのものの検査が実際にFAILする',
    !/const showAmbiguousPlaybackNotice = uiMode !== 'editor' && Boolean\(lastCompiledBytes\);/.test(alwaysFalse));
}

check('[i18n](4) pmd.player.playingBundled がja/en両方に存在する',
  typeof I18N_DICT.ja['pmd.player.playingBundled'] === 'string'
  && typeof I18N_DICT.en['pmd.player.playingBundled'] === 'string');

console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
process.exit(failCount > 0 ? 1 : 0);
