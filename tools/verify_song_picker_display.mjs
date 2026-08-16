#!/usr/bin/env node
// 修正3(利用者報告、2026-08-16): 書庫選択モーダル(html/net-load.js pickSongCandidate())が
// ファイル名のまま並んでいて、曲名で表示する曲ライブラリ(ui/library-panel.js)と表示が
// 食い違っていた問題の検証。
//
// 実装は「新しい解決処理を書かない」方針で、曲ライブラリと同じ net/album-info.js の
// resolveTrackInfo()/albumGroupPathFor()/albumLabelFor() をそのまま使う
// describeSongCandidate()(net/album-info.js、選択画面の1行分の表示文字列を組み立てる関数。
// html/net-load.js pickSongCandidate()がそのまま呼ぶ)を新設した。resolveTrackInfo()自体の
// 正しさは tools/verify_library.mjs で既に検証済みなので、ここで見るのは「選択画面が実際に
// それを使っているか」(=describeSongCandidate()が正しい入出力になっているか)。
//
// describeSongCandidate()をhtml/net-load.jsではなくnet/album-info.js(DOM非依存層)に
// 置いているのは、html/net-load.jsがビルド時に`net/`をhtml/直下へ並べる前提の相対import
// (`./net/archive.js`等)を含み、ソースツリーのままではNode(このverifyスクリプト)から
// 直接importできないため(tools/build_dist.sh参照)。
//
// 検証内容:
//   A. entriesを渡さない場合は従来どおりファイル名表示(後方互換、回帰確認)。
//   B. LIST_*.txtに対応する曲は「<番号>. <曲名> (<ドライバ> / <アルバム名>)」になる。
//   C. LIST_*.txtが無い(対応するエントリが見つからない)曲はファイル名にフォールバックする
//      (無理に当てない)。ただしアルバム名(d88の生名から拡張子を落としたもの)は出る。
//   D. d88に属さない(アルバム無し)曲は書庫ラベルがアルバム名として出る。
//   E. [実データ、MCM_SAMPLE_ZIP設定時のみ] 55曲中46曲が曲名表示、9曲がファイル名表示に
//      なること(tools/verify_library.mjsの実データ検証と同じ期待値)。
//
// 実行: node tools/verify_song_picker_display.mjs
//       MCM_SAMPLE_ZIP=/path/to/mcm.zip node tools/verify_song_picker_display.mjs (実データ検証込み)

import { readFileSync } from 'node:fs';
import { describeSongCandidate } from '../net/album-info.js';

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passed++; else failed++;
  console.log(`[${mark}] ${label}${detail !== undefined ? ' - ' + detail : ''}`);
}

function testSynthetic() {
  const listText = '1. Synthetic Title\tsyn01\r\n2. Second Song\tsyn02\r\n';
  const entries = [
    { name: 'MCM_x/MML_TESTALBUM.d88/syn01.muc', data: new Uint8Array() },
    { name: 'MCM_x/MML_TESTALBUM.d88/syn02.muc', data: new Uint8Array() },
    { name: 'MCM_x/LIST_TESTALBUM.txt', data: new TextEncoder().encode(listText) },
    // LIST_*.txtの無いd88(システムディスク相当)。
    { name: 'MCM_x/MUCOM88_V1.7_SAMPLE.d88/sampl1.muc', data: new Uint8Array() },
    // d88に属さない単体曲。
    { name: 'flat_song.muc', data: new Uint8Array() },
  ];

  const resolvedCandidate = {
    entry: entries[0], driver: 'mucom', displayName: 'syn01.muc', related: [],
  };
  const fallbackCandidate = {
    entry: entries[3], driver: 'mucom', displayName: 'sampl1.muc', related: [],
  };
  const flatCandidate = {
    entry: entries[4], driver: 'mucom', displayName: 'flat_song.muc', related: [],
  };

  // --- A. entries未指定なら従来どおりファイル名(後方互換) ---
  const noEntriesText = describeSongCandidate(resolvedCandidate, {});
  check('A. entries未指定では従来どおりファイル名表示(回帰確認)',
    noEntriesText === 'syn01.muc (MUCOM88)', noEntriesText);

  // --- B. LIST_*.txtに対応する曲は曲名+番号+アルバム名で出る ---
  const resolvedText = describeSongCandidate(resolvedCandidate, { entries, archiveLabel: 'mcm.zip' });
  check('B. LIST_*.txt対応曲は番号+曲名+ドライバ+アルバム名で表示される',
    resolvedText === '1. Synthetic Title (MUCOM88 / TESTALBUM)', resolvedText);
  check('B. ファイル名(syn01.muc)は表示に出ない(曲名に置き換わっている)',
    !resolvedText.includes('syn01.muc'), resolvedText);

  // --- C. LIST_*.txtが無い曲はファイル名にフォールバック、アルバム名は出る ---
  const fallbackText = describeSongCandidate(fallbackCandidate, { entries, archiveLabel: 'mcm.zip' });
  check('C. LIST_*.txtが無いd88の曲はファイル名にフォールバックする(無理に当てない)',
    fallbackText.includes('sampl1.muc'), fallbackText);
  check('C. フォールバックでもアルバム名(d88の生名、拡張子落とし)は出る',
    fallbackText.includes('MUCOM88_V1.7_SAMPLE'), fallbackText);
  check('C. フォールバックでも".d88"拡張子は残らない', !fallbackText.includes('.d88'), fallbackText);

  // --- D. d88に属さない曲は書庫ラベルがアルバム名として出る ---
  const flatText = describeSongCandidate(flatCandidate, { entries, archiveLabel: 'mcm.zip' });
  check('D. d88に属さない曲は書庫ラベル(archiveLabel)がアルバム名として出る',
    flatText.includes('mcm.zip'), flatText);
}

async function testRealArchiveIfAvailable() {
  const zipPath = process.env.MCM_SAMPLE_ZIP;
  if (!zipPath) {
    console.log('[SKIP] MCM_SAMPLE_ZIP が未設定のため、実データでの検証をスキップします。');
    console.log('       (著作物のためリポジトリに同梱していない。tools/verify_library.mjsと同じ材料)');
    return;
  }
  const { extractArchive } = await import('../net/archive.js');
  const { findSongCandidates } = await import('../net/song-select.js');

  const zipBytes = new Uint8Array(readFileSync(zipPath));
  const archiveLabel = zipPath.split('/').pop();
  const entries = await extractArchive(archiveLabel, zipBytes);
  const candidates = findSongCandidates(entries).filter((c) => c.driver === 'mucom');
  check('実データ: MUCOM88の曲候補が見つかる', candidates.length > 0, `${candidates.length}曲`);

  let titledCount = 0;
  let fileNameFallbackCount = 0;
  for (const candidate of candidates) {
    const text = describeSongCandidate(candidate, { entries, archiveLabel });
    if (text.includes(candidate.displayName)) {
      fileNameFallbackCount++;
    } else {
      titledCount++;
    }
  }
  console.log(`[INFO] 選択画面の表示: 曲名表示=${titledCount}曲 / ファイル名フォールバック=${fileNameFallbackCount}曲`);
  // tools/verify_library.mjs の実データ検証(resolvedCount===46, fallbackCount===9)と同じ期待値。
  check('E. 実データ: 55曲中46曲が曲名表示になる(describeSongCandidate()経由)',
    titledCount === 46, `titledCount=${titledCount}`);
  check('E. 実データ: 9曲はファイル名フォールバックのまま(システムディスク由来、無理に当てない)',
    fileNameFallbackCount === 9, `fileNameFallbackCount=${fileNameFallbackCount}`);
}

async function main() {
  console.log('=== 書庫選択モーダルの曲名/アルバム名表示(describeSongCandidate) 検証 ===\n');
  testSynthetic();
  await testRealArchiveIfAvailable();
  console.log(`\n${passed} PASS, ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
