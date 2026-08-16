#!/usr/bin/env node
// ui/mucom-voice-resolve.js の「外部音色バンク対応」(resolveMucomVoiceNameRefs()の
// 第2引数、buildTableFromRawBank())そのものを、合成データで検証する。
//
// 【不具合修正・2026-08-16、コーディネーター指摘】かつてここには「①外部バンク自身の
// 表→②見つからなければ既定バンクへフォールバック」という連鎖があったが、それは
// net/voice-bank.js側の不具合(voice.dat本体の開始位置を先頭0byte目と決め打っていた
// ため、実際は4byteのヘッダ分ずれて全スロットが4byteずれて読まれていた)による
// 誤った実測(「バンクは名前を1件も持たない」)に基づくものだった。オフセット検出を
// net/voice-bank.js側で直した後、実データ(サンプルMML集46曲、対になるシステム
// ディスク8枚)で再測定したところ、バンク自身の表だけで@"名前"参照98件全てが解決でき、
// フォールバックが発動する例は0件だったため、フォールバックは削除した。
// この検証はフォールバックを「外部バンクにしか無い名前」を解決できることと、
// 「バンクに無い名前は既定バンクへ逃げずに未解決のまま残る」ことの両方を確認する。

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

// --- (1) 外部バンクが同じ名前を別スロットに持つ場合、外部バンクの表が使われる(既定とは異なるスロットになる) ---
{
  const otherSlot = DEFAULT_FLUTE_SLOT === 10 ? 20 : 10; // 既定スロットとは異なる番号を選ぶ
  const bank = makeBank([[otherSlot, 'flute']]);
  const r = resolveMucomVoiceNameRefs('A @"flute"c\n', bank);
  check('(1) 外部バンクに同名があれば、既定バンクとは違うスロット番号に置換される',
    r.text === `A @${otherSlot}c\n` && otherSlot !== DEFAULT_FLUTE_SLOT,
    `既定=${DEFAULT_FLUTE_SLOT} 外部バンク=${otherSlot} 実際の置換結果="${r.text.trim()}"`);
  check('(1) 置換件数が1件', r.replacedCount === 1);
  check('(1) 未解決名が無い', r.unresolvedNames.length === 0);
}

// --- (2) 外部バンクに名前が無ければ、既定バンクへは逃げず未解決のまま残る(フォールバック廃止の確認) ---
{
  const bank = makeBank([[5, 'unrela']]); // "flute"を含まないバンク(既定バンクにだけ存在する名前)
  const r = resolveMucomVoiceNameRefs('A @"flute"c\n', bank);
  check('(2) 外部バンクに名前が無ければ既定バンクへフォールバックしない(未解決のまま残る)',
    r.text === 'A @"flute"c\n' && r.unresolvedNames.length === 1 && r.unresolvedNames[0] === 'flute',
    JSON.stringify(r));
  check('(2) 置換件数は0', r.replacedCount === 0);
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

// --- (5) 外部バンクが名前を全く持たない(全スロット空)場合、全て未解決のまま残る
//         (実データでは起きない想定だが、壊れた/空のバンクへの安全側の挙動として確認する) ---
{
  const bank = new Uint8Array(VOICE_BANK_SIZE); // 全スロット空(名前無し)
  const r = resolveMucomVoiceNameRefs('A @"flute"c @"ﾀﾑﾀﾑ"c\n', bank);
  check('(5) 外部バンクが名前を全く持たない場合、既定バンクへ逃げず両方とも未解決のまま残る',
    r.replacedCount === 0 && r.unresolvedNames.length === 2, JSON.stringify(r));
}

console.log(`\n${passCount} PASS, ${failCount} FAIL`);
process.exit(failCount === 0 ? 0 : 1);
