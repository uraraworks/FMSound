#!/usr/bin/env node
// ui/mucom-voice-resolve.js の「外部音色バンク対応」(resolveMucomVoiceNameRefs()の
// 第2引数、buildTableFromRawBank()、フォールバック連鎖)そのものを、合成データで検証する。
//
// 実データ(サンプルMML集の対になるシステムディスク8枚)での実測(2026-08-16)では、
// ディスクの`voice.dat`の名前フィールドが埋め込み既定バンクの名前と1件も一致しなかった
// (重複0件)。そのため実データだけでは「同じ名前が既定バンクと外部バンクで違うスロット
// 番号に解決される」例を再現できない。この検証はその代わりに、合成した外部バンクで
// 「①外部バンク自身の表を優先する」「②見つからなければ既定バンクへフォールバックする」
// という機構そのものが正しく動くことを確認する(実データが機構を使い切らないのは
// データ側の事情であって、機構が壊れていないことは別に確認できる)。

import { resolveVoiceNameToSlot, resolveMucomVoiceNameRefs } from '../ui/mucom-voice-resolve.js';
import { encodeCp932 } from '../ui/cp932-encode.js';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
}

const VOICE_BANK_SIZE = 8192;
const SLOT_SIZE = 32;
const NAME_OFFSET = 26;

/** 指定スロットに名前を書き込んだ、それ以外は空(0x20埋め)の合成バンクを作る。 */
function makeBank(entries) {
  const bank = new Uint8Array(VOICE_BANK_SIZE).fill(0x20); // 空白パディングで初期化
  for (const [slot, name] of entries) {
    const { bytes } = encodeCp932(name);
    const off = slot * SLOT_SIZE + NAME_OFFSET;
    bank.set(bytes, off);
  }
  return bank;
}

const DEFAULT_FLUTE_SLOT = resolveVoiceNameToSlot('flute');
check('前提: "flute"は既定バンクで解決できる', DEFAULT_FLUTE_SLOT !== null, DEFAULT_FLUTE_SLOT);

// --- (1) 外部バンクが同じ名前を別スロットに持つ場合、外部バンクの表が優先される ---
{
  const otherSlot = DEFAULT_FLUTE_SLOT === 10 ? 20 : 10; // 既定スロットとは異なる番号を選ぶ
  const bank = makeBank([[otherSlot, 'flute']]);
  // resolveVoiceNameToSlot(name, table)は「表そのもの」を受け取る低レベルAPIなので、
  // ここでは製品と同じ経路(resolveMucomVoiceNameRefs)で検証する。
  const r = resolveMucomVoiceNameRefs('A @"flute"c\n', bank);
  check('(1) 外部バンクに同名があれば、既定バンクとは違うスロット番号に置換される',
    r.text === `A @${otherSlot}c\n` && otherSlot !== DEFAULT_FLUTE_SLOT,
    `既定=${DEFAULT_FLUTE_SLOT} 外部バンク=${otherSlot} 実際の置換結果="${r.text.trim()}"`);
  check('(1) 置換件数が1件', r.replacedCount === 1);
  check('(1) 未解決名が無い', r.unresolvedNames.length === 0);
}

// --- (2) 外部バンクに名前が無ければ既定バンクへフォールバックする(実データで実際に起きているケース) ---
{
  const bank = makeBank([[5, 'unrelated_name_not_flute'.slice(0, 6)]]); // "flute"を含まないバンク
  const r = resolveMucomVoiceNameRefs('A @"flute"c\n', bank);
  check('(2) 外部バンクに名前が無ければ既定バンクの表へフォールバックする(未解決にならない)',
    r.text === `A @${DEFAULT_FLUTE_SLOT}c\n`, r.text.trim());
  check('(2) フォールバックしても未解決扱いにはならない', r.unresolvedNames.length === 0);
}

// --- (3) 外部バンクにしか存在しない名前も解決できる(既定バンクに無い名前) ---
{
  const bank = makeBank([[7, 'ｵﾘｼﾞﾅﾙ']]); // 既定バンクには存在しない想定の名前
  check('前提: この名前は既定バンクには存在しない', resolveVoiceNameToSlot('ｵﾘｼﾞﾅﾙ') === null);
  const r = resolveMucomVoiceNameRefs('A @"ｵﾘｼﾞﾅﾙ"c\n', bank);
  check('(3) 既定バンクに無い名前でも外部バンクの表から解決できる', r.text === 'A @7c\n', r.text.trim());
}

// --- (4) 外部バンクを渡さない(bankBytes省略)場合は、これまでどおり既定バンクの表のまま(退行なし) ---
{
  const r = resolveMucomVoiceNameRefs('A @"flute"c\n');
  check('(4) バンク省略時は既定バンクの表のまま(既存動作を退行させない)',
    r.text === `A @${DEFAULT_FLUTE_SLOT}c\n`);
}

// --- (5) 実データで実際に起きたことの再現: 外部バンクの名前フィールドが全スロットとも
//         既定バンクと重複しない(実測: 対になるシステムディスク8枚全てで重複0件)場合、
//         全ての@"名前"参照が既定バンクの表へフォールバックし、46/46コンパイル成功を
//         支えている(tools/verify_mucom_voice_name.mjsのF検証、docs参照)。 ---
{
  const bank = new Uint8Array(VOICE_BANK_SIZE); // 全スロット空(名前無し) = 実データに近い最悪ケース
  const r = resolveMucomVoiceNameRefs('A @"flute"c @"ﾀﾑﾀﾑ"c\n', bank);
  check('(5) 外部バンクが名前を全く持たなくても、既定バンクの表で両方解決できる',
    r.unresolvedNames.length === 0 && r.replacedCount === 2, JSON.stringify(r));
}

console.log(`\n${passCount} PASS, ${failCount} FAIL`);
process.exit(failCount === 0 ? 0 : 1);
