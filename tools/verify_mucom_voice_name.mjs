#!/usr/bin/env node
// ui/mucom-voice-resolve.js (MUCOM88の `@"名前"` 音色参照をスロット番号の `@番号` へ
// 事前解決する)の検証。
//
// 背景(実測で確定済み。ui/mucom-voice-resolve.js冒頭コメント参照):
//   MUCOM88のZ80コンパイラは `@"名前"` の名前部分に非ASCIIバイト(半角カナ等)を
//   含むと必ず `FM Voice not found` で落ちる。`A @"flute"c` (ASCII名)は通るが
//   `A @"ｿｳﾙﾍﾞ"c` (半角カナを含む)は落ちる。`@n`(数値指定)はn=0..255全件が通る。
//   既定音色バンク(upstream/MucomWeb/mucom88/src/bin_voice.h)から生成した
//   ui/mucom-voice-table.js を使い、`@"名前"` を該当スロットの `@番号` へ
//   置換することでこの制約を回避する。
//
// 検査内容:
//   A. 陽性対照: ASCII名(`@"flute"`)は置換前から通る。
//   B. 陽性対照(必須): 半角カナ名(`@"ｿｳﾙﾍﾞ"`)は置換前は必ず落ちる
//      (「置換後は通る」だけを見て「常に通る検査」になっていないことの証明)。
//   C. 半角カナ名を resolveMucomVoiceNameRefs() で解決すると `@201`(実測)へ
//      置換され、置換後のMMLはコンパイルが通る。
//   D. 表に無い名前は置換されない(そのまま残り、unresolvedNamesに載る)。
//   E. `@"..."` 以外の箇所(本文中の同じ綴りの文字列)を巻き込まない。
//   F. 実データ(46曲、環境変数 MCM_SAMPLE_ZIP で受け取る。未設定ならSKIP)で
//      置換前/置換後のコンパイル成功数を実測し、置換後の方が増えることを確認する。
//
// 出力の判定にgrep(シェルコマンド)は使わない。MUCOM88のコンパイルメッセージは
// CP932で、grepは2バイト文字の1バイト(0x85)を「NEL改行」と誤認してエラー行を
// 無言で取りこぼす事故が過去の調査で実際に起きている。ここでは常にバイト列
// (Uint8Array/Buffer)としてASCII部分文字列を検査する(bytesInclude()参照)。
//
// 実行: node tools/verify_mucom_voice_name.mjs
//       (46曲の実データも検査する場合) MCM_SAMPLE_ZIP=/path/to/mcm.zip node tools/verify_mucom_voice_name.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createMucomWeb from '../mucomweb/build-web/mucom88.js';
import { resolveVoiceNameToSlot, resolveMucomVoiceNameRefs } from '../ui/mucom-voice-resolve.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SAMPLE_RATE = 44100;

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

/** @param {Uint8Array} bytes @param {string} asciiSubstring バイト列としてのASCII部分一致検査 */
function bytesInclude(bytes, asciiSubstring) {
  const needle = Buffer.from(asciiSubstring, 'ascii');
  return Buffer.from(bytes).includes(needle);
}

/** @param {any} Module @param {string} mml @returns {Uint8Array} コンパイルメッセージの生バイト列 */
function compileAndGetMessageBytes(Module, mml) {
  Module.compileMML(mml, SAMPLE_RATE);
  const ptr = Module.getCompileMessagePointer();
  const len = Module.getCompileMessageLength();
  return Module.HEAPU8.slice(ptr, ptr + len);
}

/**
 * html/mucom-app.js renderCompileResult() と同じ判定(/error/i)をバイト列版で行う。
 * @param {Uint8Array} msgBytes
 */
function isCompileError(msgBytes) {
  // 'error'/'ERROR'/'Error' いずれも小文字化した'error'を含む(実測: 正常時メッセージには
  // 含まれず、エラー時メッセージ(#error N in line M./#Unknown message [ERROR MESSAGE :].等)
  // には必ず含まれる。html/mucom-app.js summarizeMucomError()と同じ前提)。
  const lower = Buffer.from(msgBytes).toString('latin1').toLowerCase();
  return lower.includes('error');
}

async function main() {
  const Module = await createMucomWeb();

  // --- A. 陽性対照: ASCII名は置換前から通る ---
  const asciiMml = 'A @"flute"c\n';
  const asciiBytes = compileAndGetMessageBytes(Module, asciiMml);
  check('A: ASCII名 @"flute" は置換前(原文のまま)でもコンパイルが通る', !isCompileError(asciiBytes),
    Buffer.from(asciiBytes).toString('latin1').split('\n')[0]);

  // --- B. 陽性対照(必須): 半角カナ名は置換前は必ず落ちる ---
  const kanaName = 'ｿｳﾙﾍﾞ';
  const kanaMmlBefore = `A @"${kanaName}"c\n`;
  const kanaBytesBefore = compileAndGetMessageBytes(Module, kanaMmlBefore);
  const kanaFailedBefore = isCompileError(kanaBytesBefore) && bytesInclude(kanaBytesBefore, 'error');
  check(
    'B(陽性対照・必須): 半角カナ名 @"ｿｳﾙﾍﾞ" は置換前(原文のまま)だと必ずコンパイルエラーになる',
    kanaFailedBefore,
    `isCompileError=${isCompileError(kanaBytesBefore)}`,
  );
  // "常に通る検査"になっていないことの補強確認(FM Voice not foundという文言そのもの)。
  // メッセージ本文は#error行の直後にCP932の日本語(FM Voice not foundの日本語訳)を含む。
  // "(FM Voice not found)"のASCII部分は環境非依存でバイト一致するので、これも見る。
  check(
    'B補強: エラーメッセージに "(FM Voice not found)" が含まれる(想定どおりの原因での失敗)',
    bytesInclude(kanaBytesBefore, '(FM Voice not found)'),
  );

  // --- 表引き自体の確認(実測値との一致) ---
  check('表引き: "ｿｳﾙﾍﾞ" は既定音色バンクのslot201に解決される(実測値)', resolveVoiceNameToSlot(kanaName) === 201,
    `実測=${resolveVoiceNameToSlot(kanaName)}`);
  check('表引き: "ﾀﾑﾀﾑ" は既定音色バンクのslot164に解決される(実測値)', resolveVoiceNameToSlot('ﾀﾑﾀﾑ') === 164);
  check('表引き: "ﾎﾞﾝｺﾞ" は既定音色バンクのslot163に解決される(実測値)', resolveVoiceNameToSlot('ﾎﾞﾝｺﾞ') === 163);
  check('表引き: 重複名"efctes"は最初に見つかった方(slot0)に解決される', resolveVoiceNameToSlot('efctes') === 0);

  // --- 末尾パディングの正規化(2026-08-16の不具合修正の回帰防止) ---
  // 名前フィールドは6バイトの空白詰め固定長で末尾の空白に意味が無い。以前は表側だけを
  // 正規化しMML側を正規化しない非対称な比較になっていたため、MMLが `@"ｿｳﾙﾍﾞ "` のように
  // 末尾へ空白を付けて書いていると解決できなかった(実データの stk023 が該当)。
  // 半角カナ固有の問題ではないので、ASCII名でも同じことを確認する。
  check('末尾空白: "ｿｳﾙﾍﾞ " は "ｿｳﾙﾍﾞ" と同じslot201に解決される',
    resolveVoiceNameToSlot('ｿｳﾙﾍﾞ ') === 201, `実測=${resolveVoiceNameToSlot('ｿｳﾙﾍﾞ ')}`);
  check('末尾空白: "ﾀﾑﾀﾑ " も同じslot164に解決される(半角カナ固有ではない確認1)',
    resolveVoiceNameToSlot('ﾀﾑﾀﾑ ') === 164, `実測=${resolveVoiceNameToSlot('ﾀﾑﾀﾑ ')}`);
  check('末尾空白: ASCII名 "flute " も "flute" と同じslotに解決される(半角カナ固有ではない確認2)',
    resolveVoiceNameToSlot('flute ') === resolveVoiceNameToSlot('flute') &&
    resolveVoiceNameToSlot('flute') !== null,
    `"flute "=${resolveVoiceNameToSlot('flute ')} "flute"=${resolveVoiceNameToSlot('flute')}`);
  // 陰性側: 正規化を入れたせいで「何でも当たる」ようになっていないこと。
  check('末尾空白: 空文字は解決されない(nullのまま)', resolveVoiceNameToSlot('') === null);
  check('末尾空白: 存在しない名前は末尾空白の有無にかかわらず解決されない',
    resolveVoiceNameToSlot('存在しない名前') === null && resolveVoiceNameToSlot('zzzzz ') === null);

  // --- C. 解決後は通る ---
  const { text: kanaMmlAfter, replacedCount, unresolvedNames: kanaUnresolved } = resolveMucomVoiceNameRefs(kanaMmlBefore);
  check('C: 半角カナ名の置換結果が "@201" を含む(スロット番号への置換)', kanaMmlAfter.includes('@201'), kanaMmlAfter);
  check('C: 置換件数replacedCountが1', replacedCount === 1, `実測=${replacedCount}`);
  check('C: 置換できなかった名前は無い(unresolvedNamesが空)', kanaUnresolved.length === 0, JSON.stringify(kanaUnresolved));
  const kanaBytesAfter = compileAndGetMessageBytes(Module, kanaMmlAfter);
  check('C: 置換後のMML( @"ｿｳﾙﾍﾞ" -> @201 )はコンパイルが通る', !isCompileError(kanaBytesAfter),
    Buffer.from(kanaBytesAfter).toString('latin1').split('\n')[0]);

  // --- D. 表に無い名前は置換されない ---
  const unknownName = 'nonexistent_voice_xyz';
  const unknownMml = `A @"${unknownName}"c\n`;
  const unknownResult = resolveMucomVoiceNameRefs(unknownMml);
  check('D: 表に無い名前はそのまま残る(置換されない)', unknownResult.text === unknownMml, unknownResult.text);
  check('D: 表に無い名前はunresolvedNamesに載る', unknownResult.unresolvedNames.includes(unknownName),
    JSON.stringify(unknownResult.unresolvedNames));
  check('D: 表に無い名前を含む置換ではreplacedCountが0', unknownResult.replacedCount === 0);

  // --- E. `@"..."` 以外の箇所を巻き込まない ---
  // 本文中に"flute"という綴りが@"..."以外の形でも登場するMMLを用意し、そちら側は
  // 手を付けず、@"flute"の方だけがスロット番号へ置換されることを確認する。
  const mixedMml = 'A @"flute"c flute r flute\n';
  const mixedResult = resolveMucomVoiceNameRefs(mixedMml);
  const expectedMixed = `A @${resolveVoiceNameToSlot('flute')}c flute r flute\n`;
  check(
    'E: @"..."以外の箇所(本文中の同じ綴り"flute")を巻き込まず、@"flute"だけがスロット番号に置換される',
    mixedResult.text === expectedMixed,
    `実測="${mixedResult.text}" 期待="${expectedMixed}"`,
  );
  // 陽性対照: もし単純な文字列置換(mml.replaceAll('flute', slot))だったら、本文中の
  // "flute"まで巻き込まれて上とは異なる結果になることを確認する(検査自体が
  // 「常にPASSしてしまう」ものになっていないことの証明)。
  const naiveReplaceAllResult = mixedMml.replaceAll('flute', String(resolveVoiceNameToSlot('flute')));
  check(
    'E陽性対照: 単純なreplaceAll方式なら本文中の"flute"まで巻き込まれ、上の期待値とは異なる結果になる' +
      '(=このMMLはE検査が"常にPASS"ではないことの証拠になる)',
    naiveReplaceAllResult !== expectedMixed,
    naiveReplaceAllResult,
  );

  // --- F. 実データ(46曲)での検証 ---
  const zipPath = process.env.MCM_SAMPLE_ZIP;
  if (!zipPath) {
    console.log('[SKIP] MCM_SAMPLE_ZIP が未設定のため、46曲の実データを使う検証(F)はスキップします。');
    console.log('       (サンプルMML集は著作物のためリポジトリに同梱していない。手元のzipパスを環境変数で渡すこと)');
  } else {
    const { extractArchive } = await import('../net/archive.js');
    const { findSongCandidates } = await import('../net/song-select.js');
    const { decodeMmlBytes } = await import('../net/charset.js');

    const zipBytes = new Uint8Array(readFileSync(zipPath));
    const entries = await extractArchive(/\.zip$/i.test(zipPath) ? zipPath : `${zipPath}.zip`, zipBytes);
    const songs = findSongCandidates(entries).filter((s) => /\/MML_.*\.d88\//i.test(s.entry.name));
    check('F: MML_*.d88由来の曲が46件見つかる(実データ)', songs.length === 46, `実測=${songs.length}`);

    let successBefore = 0;
    let successAfter = 0;
    let totalReplaced = 0;
    const unresolvedAcrossSongs = new Set();
    const flippedToSuccess = [];

    for (const song of songs) {
      const { text: mmlText } = decodeMmlBytes(song.entry.data);
      const beforeBytes = compileAndGetMessageBytes(Module, mmlText);
      const beforeOk = !isCompileError(beforeBytes);
      if (beforeOk) successBefore++;

      const { text: resolvedText, replacedCount, unresolvedNames } = resolveMucomVoiceNameRefs(mmlText);
      totalReplaced += replacedCount;
      for (const n of unresolvedNames) unresolvedAcrossSongs.add(n);

      const afterBytes = compileAndGetMessageBytes(Module, resolvedText);
      const afterOk = !isCompileError(afterBytes);
      if (afterOk) successAfter++;
      if (!beforeOk && afterOk) flippedToSuccess.push(song.entry.name);
    }

    console.log(`--- F: 46曲コンパイル結果 ---`);
    console.log(`  置換前 成功数: ${successBefore} / 46`);
    console.log(`  置換後 成功数: ${successAfter} / 46`);
    console.log(`  合計置換件数(@"名前"->@番号): ${totalReplaced}`);
    console.log(`  解決できなかった名前(重複除く): ${JSON.stringify([...unresolvedAcrossSongs])}`);
    console.log(`  置換前失敗->置換後成功に転じた曲: ${flippedToSuccess.length}件`);
    for (const name of flippedToSuccess) console.log(`    - ${name}`);

    check('F: 置換後のコンパイル成功数が置換前より増えている', successAfter > successBefore,
      `${successBefore} -> ${successAfter}`);
    check('F: 少なくとも1曲は置換前失敗->置換後成功に転じている', flippedToSuccess.length > 0,
      `${flippedToSuccess.length}件`);
  }

  console.log('---');
  console.log(`${passCount} 件 PASS / ${failCount} 件 FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
