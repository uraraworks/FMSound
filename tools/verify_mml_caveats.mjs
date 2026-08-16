#!/usr/bin/env node
// ui/mml-caveats.js の検証。
//
// 背景(利用者判断・2026-08-16): formatMmlCaveatMessage() は以前、#voice/#pcm使用と
// リズム(G)パート使用の両方を1行の注意書きにして画面へ出していたが、リズムの一文
// (「リズム音源は代替サンプルで再生されます...」)だけ画面表示から外した。
// 理由: #voice/#pcmは今も実害がある(音色が既定になりADPCMが無音)一方、リズムは
// 「鳴らない」から「鳴るが波形が違う」へ実害が下がったため。detectMmlCaveats()の
// usesRhythm検出そのものは残している(ui/mml-caveats.js冒頭コメント参照)。
//
// このファイルは素のテキスト処理(wasm/ブラウザ不要)なので単体で検証できる。
//
// 検査内容:
//   A. リズムのみを使うMMLでは formatMmlCaveatMessage() が null を返す
//      (=画面に文言が出ない)こと。
//   B. #voiceを使うMMLでは文言が出ること(こちらを消していない証明。回帰確認)。
//   C. [陽性対照] 「削除前の実装」相当(missingRefs/usesRhythmの両方を文言化する
//      旧ロジック)を用意し、Aと同じ入力を渡すと文言が出ていたことを示す
//      (「消したら出なくなった」だけでなく「消す前は出ていた」ことの確認)。
//   D. 両方(#voice/#pcmとリズム)を同時に使うMMLでは、#voice/#pcmの文言だけが
//      出て、リズムの一文は含まれないこと(部分的な取りこぼしがないことの確認)。
//   E. どちらも使わないMMLではnullを返す(回帰確認)。
//   F. [48edad2の仕上げ、2026-08-16] #pcm の標準バンク名判定:
//      (a) `#pcm mucompcm.bin` は同梱済みバンクなので警告に出ないこと。
//      (b) `#pcm` に標準バンク以外のファイル名を指定した場合は従来どおり警告に出ること。
//      (c) `#voice voice.dat` の挙動(今回対象外)が変わっていないこと(回帰の検出)。
//
// 実行: node tools/verify_mml_caveats.mjs

import { detectMmlCaveats, formatMmlCaveatMessage } from '../ui/mml-caveats.js';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

// 削除前の実装(旧formatMmlCaveatMessage())を独立して再現したもの。現行実装からの
// コピーではなく、このファイル内で完結させて「現行実装を書き換えても陽性対照だけは
// 変わらない」ようにする。
function legacyFormatMmlCaveatMessage(caveats) {
  const parts = [];
  if (caveats.missingRefs.length > 0) {
    const files = [...new Set(caveats.missingRefs.map((r) => r.file))].join(', ');
    parts.push(`この曲は ${files} を参照していますが読み込めません。音色とドラムが本来と異なります。`);
  }
  if (caveats.usesRhythm) {
    parts.push('リズム音源は代替サンプルで再生されます(本物のYM2608とは波形が異なります)。');
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

const RHYTHM_ONLY_MML = 'G t120 l4 @1c@2c@4c\n';
const VOICE_ONLY_MML = '#voice voice.dat\nA @1 t120 l4 cdefg\n';
// 標準バンク名(48edad2でMEMFSへ同梱済み)を指す#pcmは解決できる(F-a)。
const PCM_STANDARD_BANK_MML = '#pcm mucompcm.bin\nA @1 t120 l4 cdefg\n';
// 標準バンク以外を指す#pcmは、依然として同梱されていないので解決できない(F-b)。
const PCM_OTHER_BANK_MML = '#pcm my_custom_bank.bin\nA @1 t120 l4 cdefg\n';
const BOTH_MML = '#voice voice.dat\nG t120 l4 @1c@2c\nA @1 t120 l4 cdefg\n';
const NEITHER_MML = 'A @78 T120 o5 l4 v10 cdefgab>c<\n';

function main() {
  console.log('=== ui/mml-caveats.js 検証 ===\n');

  // --- A. リズムのみ: 現行実装は文言なし ---
  const rhythmOnly = detectMmlCaveats(RHYTHM_ONLY_MML);
  check('A. リズムのみのMMLでusesRhythmを検出する(検出そのものは残っている)',
    rhythmOnly.usesRhythm === true && rhythmOnly.missingRefs.length === 0,
    JSON.stringify(rhythmOnly));
  const rhythmOnlyMessage = formatMmlCaveatMessage(rhythmOnly);
  check('A. リズムのみのMMLでは現行実装は文言を出さない(null)',
    rhythmOnlyMessage === null, `message=${JSON.stringify(rhythmOnlyMessage)}`);

  // --- C. [陽性対照] 同じ入力を旧実装に渡すと文言が出ていたことを示す ---
  const legacyRhythmOnlyMessage = legacyFormatMmlCaveatMessage(rhythmOnly);
  check('C. [陽性対照] 同じ入力(リズムのみ)を旧実装に渡すと文言が出る(消す前は出ていた証明)',
    typeof legacyRhythmOnlyMessage === 'string' && /リズム/.test(legacyRhythmOnlyMessage),
    `legacyMessage=${JSON.stringify(legacyRhythmOnlyMessage)}`);

  // --- B. #voice/#pcmは文言が出る(消していない証明) ---
  const voiceOnly = detectMmlCaveats(VOICE_ONLY_MML);
  const voiceOnlyMessage = formatMmlCaveatMessage(voiceOnly);
  check('B. #voiceを使うMMLでは文言が出る',
    typeof voiceOnlyMessage === 'string' && voiceOnlyMessage.includes('voice.dat'),
    `message=${JSON.stringify(voiceOnlyMessage)}`);

  // --- F. #pcmの標準バンク名判定(48edad2の仕上げ) ---
  const pcmStandard = detectMmlCaveats(PCM_STANDARD_BANK_MML);
  const pcmStandardMessage = formatMmlCaveatMessage(pcmStandard);
  check('F-a. #pcm mucompcm.bin(標準バンク)は警告に出ない',
    pcmStandard.missingRefs.length === 0 && pcmStandardMessage === null,
    `missingRefs=${JSON.stringify(pcmStandard.missingRefs)} message=${JSON.stringify(pcmStandardMessage)}`);

  const pcmOther = detectMmlCaveats(PCM_OTHER_BANK_MML);
  const pcmOtherMessage = formatMmlCaveatMessage(pcmOther);
  check('F-b. #pcm my_custom_bank.bin(標準バンク以外)は従来どおり警告に出る',
    typeof pcmOtherMessage === 'string' && pcmOtherMessage.includes('my_custom_bank.bin'),
    `message=${JSON.stringify(pcmOtherMessage)}`);

  const voiceRegression = detectMmlCaveats(VOICE_ONLY_MML);
  const voiceRegressionMessage = formatMmlCaveatMessage(voiceRegression);
  check('F-c. #voice voice.dat の挙動は変わっていない(回帰確認)',
    voiceRegression.missingRefs.length === 1 &&
      typeof voiceRegressionMessage === 'string' && voiceRegressionMessage.includes('voice.dat'),
    `missingRefs=${JSON.stringify(voiceRegression.missingRefs)} message=${JSON.stringify(voiceRegressionMessage)}`);

  // --- D. 両方使うMML: #voiceの文言だけが出て、リズムの一文は含まれない ---
  const both = detectMmlCaveats(BOTH_MML);
  const bothMessage = formatMmlCaveatMessage(both);
  check('D. #voice+リズムの両方を使うMMLでもusesRhythmはtrue(検出は残る)',
    both.usesRhythm === true && both.missingRefs.length === 1);
  check('D. #voice+リズムの両方を使うMMLでは#voiceの文言のみが出る',
    typeof bothMessage === 'string' && bothMessage.includes('voice.dat'),
    `message=${JSON.stringify(bothMessage)}`);
  check('D. リズムの一文(「リズム音源は代替サンプル」)は含まれない',
    typeof bothMessage === 'string' && !/リズム/.test(bothMessage),
    `message=${JSON.stringify(bothMessage)}`);

  // --- E. どちらも使わないMMLではnull(回帰確認) ---
  const neither = detectMmlCaveats(NEITHER_MML);
  const neitherMessage = formatMmlCaveatMessage(neither);
  check('E. #voice/#pcm/リズムのいずれも使わないMMLではnull',
    neitherMessage === null, `message=${JSON.stringify(neitherMessage)}`);

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main();
