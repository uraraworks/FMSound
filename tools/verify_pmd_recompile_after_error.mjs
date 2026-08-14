#!/usr/bin/env node
// 課題A回帰テスト: 「エラーを直してもエラーが消えない」の再発防止。
//
// 利用者報告: PMD側のエディタで、わざと不正な文字を入れてコンパイル→エラー表示。
// その後、元に戻してコンパイルし直してもエラーが消えない。
//
// 実測での切り分け(2026-08-14、報告と合わせて調査した結果):
//   - compiler/pmd_mml_compiler.mjs・pmd_mml_parser.mjs はどちらも呼び出しごとに
//     フリーなローカル変数だけで完結する純粋関数で、モジュール直下の可変状態を
//     一切持たない。「1回目のエラーが2回目のコンパイル結果に混線する」ような
//     経路は無い。ブラウザで実際に「エラー→修正→再コンパイル」を繰り返しても
//     html/pmd-app.js の #result 表示(エラー文字列/「コンパイル成功」)は
//     毎回コンパイル対象(その時点のtextarea.value)を正しく反映して更新された。
//   - 一方、再生ボタンの「青いドット(コンパイル待ちマーク)」表示は別の実在する
//     不具合を持っていた: 以前は needsCompile 判定に globalThis.pmdAudioState?.playback
//     (AudioWorkletの非同期'playback'通知で立つ)を使っており、コンパイル成功
//     直後・その通知が届く前の一瞬は「まだコンパイルが必要」と誤表示していた
//     (rAFが遅延・停止する環境では体感できるほど残る)。これは「コンパイルの成否」を
//     「実際に音が出始めたか」で代用してしまっていたパターンで、報告の症状
//     (状態が最新のコンパイル結果を反映しない)と同じ根であるため、html/pmd-app.js を
//     専用フラグ(hasCompiled)に切り替えて修正した(html/mucom-app.js側も同じ
//     パターンがクリックハンドラにあったため合わせて修正)。
//
// このスクリプトは「エラー→修正→再コンパイルでエラーが消える」サイクルを、
// compiler/pmd_mml_compiler.mjs 単体(ブラウザ不要)と、pmdweb wasm を通した
// 実再生(html/pmd-app.js compileAndPlay()相当の手順)の両方で機械的に確認する。
//
// 実行: node tools/verify_pmd_recompile_after_error.mjs

import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import { compileMml } from '../compiler/pmd_mml_compiler.mjs';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

async function main() {
  console.log('=== 課題A回帰テスト: PMD MMLコンパイラ「エラー→修正→再コンパイル」===\n');

  const BAD_MML = 'A o4 c4 d4 e4 @999'; // 未定義の音色番号(パーサ後の意味検査で弾かれる)
  const FIXED_MML = 'A o4 c4 d4 e4 @1'; // 同じ内容を修正しただけ(「元に戻す」相当)

  // --- 1. compileMml() 単体(JSのみ、ブラウザ不要) ---
  console.log('--- 1. compileMml() 単体: 同一プロセス内で連続呼び出し ---');
  const bad1 = compileMml(BAD_MML);
  check('1回目(不正なMML)はエラーを返す', bad1.errors.length > 0, JSON.stringify(bad1.errors));

  const fixed1 = compileMml(FIXED_MML);
  check('2回目(修正後のMML)はエラー無しでコンパイルできる(1回目のエラーが残っていない)',
    fixed1.errors.length === 0 && fixed1.file != null,
    JSON.stringify(fixed1.errors));

  // 陽性対照: 「エラーのままのMMLをもう一度コンパイルしてもエラーが返る」ことを確認し、
  // 上のPASSが「常にエラー無しを返すだけの壊れた検査」でないことを保証する。
  const bad2 = compileMml(BAD_MML);
  check('[陽性対照] 不正なMMLを3回目に渡すと再びエラーになる(常にPASSする検査ではない証拠)',
    bad2.errors.length > 0, JSON.stringify(bad2.errors));

  // 何度もエラー→成功を繰り返しても安定して同じ結果になるか(モジュール直下の
  // 可変状態が無いことの追加確認)。
  let stable = true;
  for (let i = 0; i < 5; i++) {
    const e = compileMml(BAD_MML);
    const f = compileMml(FIXED_MML);
    if (e.errors.length === 0 || f.errors.length !== 0) { stable = false; break; }
  }
  check('エラー/成功を5往復しても毎回正しい結果になる', stable);

  // --- 2. pmdweb(wasm)を通した実再生: html/pmd-app.js compileAndPlay()と同じ手順 ---
  console.log('\n--- 2. pmdweb(wasm)実再生: compileAndPlay()と同じ手順を2回連続で実行 ---');
  const Module = await createPmdWeb();

  function compileAndPlayLike(mml) {
    // html/pmd-app.js compileAndPlay() の手順そのもの:
    // compileMml() → errorsがあれば再生せず終了、無ければ FS.writeFile + playMusic。
    const { file, errors } = compileMml(mml);
    if (errors.length > 0) return { played: false, errors };
    Module.FS.writeFile('/edited.M', file);
    const error = Module.playMusic('/edited.M');
    return { played: error === '', errors: [], playError: error };
  }

  const badPlay = compileAndPlayLike(BAD_MML);
  check('1回目(不正なMML)は再生されない(JS側コンパイルで弾かれる)', !badPlay.played && badPlay.errors.length > 0);

  const fixedPlay = compileAndPlayLike(FIXED_MML);
  check('2回目(修正後のMML)は正常に再生開始できる(playMusic()がエラー文字列を返さない)',
    fixedPlay.played, JSON.stringify(fixedPlay));

  // スナップショットリングが実際に動き出しているか(=本当に「再生できた」ことの
  // 独立した裏取り。playMusic()の戻り値だけでなく末端の状態を見る)。
  const invalidIndex = 0xffffffff;
  let sawActiveRing = false;
  for (let i = 0; i < 200 && !sawActiveRing; i++) {
    Module.renderFramesForTest(32);
    const wi = Module.getSnapshotWriteIndex() >>> 0;
    if (wi !== invalidIndex && wi !== 0) sawActiveRing = true;
  }
  check('修正後の再生でスナップショットリングが実際に動き出した(末端の状態で裏取り)', sawActiveRing);

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
