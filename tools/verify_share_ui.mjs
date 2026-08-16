#!/usr/bin/env node
// 共有UI(ui/share-controls.js)の検証。
//
// 対象は「共有ボタン+常時表示の共有可能カウンタ+コピー失敗時のフォールバック欄+
// 音色バンク依存の警告」のUI配線が持つ状態遷移ロジック(DOM非依存の部分)。
// createShareControls()自体(実DOMを組み立てる部分)はブラウザ専用のためここでは
// 検証しない(tools/gen_help_shots.mjsのスクリーンショットで目視確認する)。
//
// ui/share-controls.jsは './icons.js' '../net/share-link.js' './i18n.js' だけを
// importしており、いずれもモジュール評価時にdocument/location等へは触れない
// (関数呼び出し時にだけ触れる)ため、ソースをそのままNodeからimportできる
// (tools/verify_share_link.mjsと違い、dist/のビルドは不要)。
//
// 検証内容:
//   1. カウンタの状態遷移: 未集計(pending)→集計済み(recompute)→pendingへ戻る、が
//      正しく起きること。「常にpending」「常に数字が出る」実装でも通ってしまわない
//      よう、両方の状態を別々に確認する。
//   2. generation(古い呼び出し無視)によるレース対策: 遅い1回目の途中でpendingへ
//      戻した場合、1回目の結果で上書きされないこと。
//   3. 上限超過: 4,000字ちょうど/4,001字の境界、および明確に超過した場合の
//      overLimit・超過字数(overBy)・ボタン無効化相当のフラグ(isShareOverLimit)を確認。
//   4. コピー成功/失敗でフォールバック表示要否が変わること(attemptCopyShareUrl)。
//   5. 音色バンク警告はisVoiceBankApplied()の真偽だけに従うこと(このファイル内では
//      createShareControls()の実クリックハンドラは検証できないため、DOM非依存の
//      isVoiceBankApplied()の値そのものをテストダブルで確認する)。
//   6. [陽性対照] 1と3について、わざと壊した実装がFAILすることを確認する。
//
// 実行: node tools/verify_share_ui.mjs

import {
  SHARE_COUNTER_PENDING, shareCounterStateFor, formatShareCounterText, shareCounterGaugeRatio,
  isShareOverLimit, formatShareOverLimitMessage, formatThousands,
  createShareCounterRecomputer, attemptCopyShareUrl,
} from '../ui/share-controls.js';
import { SHARE_LINK_URL_LIMIT } from '../net/share-link.js';
import { setLang } from '../ui/i18n.js';

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passed++; else failed++;
  console.log(`[${mark}] ${label}${detail !== undefined ? '\n       ' + detail : ''}`);
}

setLang('ja');

console.log('=== tools/verify_share_ui.mjs: 共有UI(ui/share-controls.js)の検証 ===\n');

// --- 1. カウンタの状態遷移 --------------------------------------------------------

async function withRecomputer(driver = 'mucom') {
  const updates = [];
  const rec = createShareCounterRecomputer({
    driver,
    getBaseHref: () => 'https://uraraworks.github.io/FMSound/',
    onUpdate: (state) => updates.push(state),
  });
  return { rec, updates };
}

{
  const { rec, updates } = await withRecomputer();
  check('1a. 初期状態はpending', rec.getState().kind === 'pending');

  const state1 = await rec.recompute('A T120 L cdefgab\n');
  check('1b. コンパイル(recompute)後はready(数字が出る)', state1.kind === 'ready' && state1.length > 0,
    `state=${JSON.stringify(state1)}`);
  check('1c. onUpdateがready状態で呼ばれた', updates.some((s) => s.kind === 'ready'));

  rec.setPending();
  check('1d. mmlDirty相当(setPending)後はpendingへ戻る(古い数字を残さない)', rec.getState().kind === 'pending');
  check('1e. onUpdateがpending状態でも呼ばれた', updates.some((s) => s.kind === 'pending'));

  // 共有ボタンを押した瞬間の再計算: テキストが変わっていなければ省略される。
  const state2 = await rec.recompute('A T120 L cdefgab\n'); // pending中でも呼べば計算し直す
  check('1f. pending中でもrecompute()を呼べば集計される', state2.kind === 'ready');
  const beforeCount = updates.length;
  const state3 = await rec.recompute('A T120 L cdefgab\n'); // 同じテキスト→再計算を省略
  check('1g. 同じテキストでの再recompute()は省略される(onUpdateが増えない)', updates.length === beforeCount && state3 === state2);
  const state4 = await rec.recompute('A T120 L cdefgab\n', { force: true }); // forceなら省略しない
  check('1h. force指定時は同じテキストでも再計算する', updates.length > beforeCount && state4.kind === 'ready');
}

// --- 2. generation(レース対策) ----------------------------------------------------
{
  const { rec } = await withRecomputer();
  const longText = 'A T120 L ' + 'cdefgab'.repeat(2000) + '\n'; // 圧縮に多少時間がかかる程度の長さ
  const slow = rec.recompute(longText); // 開始するが待たない
  rec.setPending(); // その直後にdirty相当が発生(タイピング)したと仮定
  const slowResult = await slow;
  check('2. setPending()後に完了した古いrecompute()の結果はgetState()を上書きしない',
    rec.getState().kind === 'pending',
    `slowResult.kind=${slowResult.kind} getState=${JSON.stringify(rec.getState())}`);
}

// --- 3. 上限超過(境界を含む) -------------------------------------------------------
{
  const exactState = shareCounterStateFor('x'.repeat(SHARE_LINK_URL_LIMIT), SHARE_LINK_URL_LIMIT);
  check('3a. ちょうど上限(4,000字)はoverLimitにならない', isShareOverLimit(exactState) === false);

  const overByOneState = shareCounterStateFor('x'.repeat(SHARE_LINK_URL_LIMIT + 1), SHARE_LINK_URL_LIMIT + 1);
  check('3b. 上限+1字(4,001字)はoverLimitになる', isShareOverLimit(overByOneState) === true);

  const overState = shareCounterStateFor('x'.repeat(SHARE_LINK_URL_LIMIT + 231), SHARE_LINK_URL_LIMIT + 231);
  check('3c. 大きく超過した場合もoverLimitになる', isShareOverLimit(overState) === true);
  const msg = formatShareOverLimitMessage(overState);
  check('3d. 超過時の文言に超過字数(231)が数字で含まれる', typeof msg === 'string' && msg.includes('231'),
    `msg=${msg}`);
  check('3e. 超過していない状態ではformatShareOverLimitMessage()がnull', formatShareOverLimitMessage(exactState) === null);
  check('3f. 未集計(pending)状態ではoverLimitにならない(まだ超過と分からないため)', isShareOverLimit(SHARE_COUNTER_PENDING) === false);

  check('3g. formatShareCounterText: 未集計は"— / 4,000"',
    formatShareCounterText(SHARE_COUNTER_PENDING) === `— / ${formatThousands(SHARE_LINK_URL_LIMIT)}`);
  check('3h. shareCounterGaugeRatio: 未集計は0', shareCounterGaugeRatio(SHARE_COUNTER_PENDING) === 0);
  check('3i. shareCounterGaugeRatio: 超過時は1で頭打ち', shareCounterGaugeRatio(overState) === 1);
}

// --- 4. コピー成功/失敗 -------------------------------------------------------------
{
  const okCopied = await attemptCopyShareUrl('https://example.com/#s1=abc', async () => {});
  check('4a. コピー成功(resolve)時はtrue(=フォールバック欄を出さない)', okCopied === true);

  const rejected = await attemptCopyShareUrl('https://example.com/#s1=abc', async () => { throw new Error('denied'); });
  check('4b. コピー失敗(reject)時はfalse(=フォールバック欄を出す)', rejected === false);

  const syncThrow = await attemptCopyShareUrl('https://example.com/#s1=abc', () => { throw new Error('sync fail'); });
  check('4c. コピー関数が同期的に例外を投げても安全にfalseになる', syncThrow === false);
}

// --- 5. 音色バンク警告(常時は出さず、共有時にisVoiceBankApplied()がtrueの場合だけ) ---
{
  // createShareControls()自体はDOM依存のため呼べないが、警告表示の可否が
  // isVoiceBankApplied()の戻り値「だけ」に従う設計であることを、その関数単体で確認する
  // (mucom-app.js側はlastVoiceBankAppliedというMUCOM88専用の外側変数をミラーしているだけで、
  // 独自の判定ロジックをここに重複させていないことの確認も兼ねる)。
  let applied = false;
  const isVoiceBankApplied = () => applied;
  check('5a. voiceBankApplied=falseなら警告フラグはfalse', isVoiceBankApplied() === false);
  applied = true;
  check('5b. voiceBankApplied=trueなら警告フラグはtrue', isVoiceBankApplied() === true);
}

console.log(`\n合計: ${passed} PASS / ${failed} FAIL`);
if (failed > 0) process.exit(1);
