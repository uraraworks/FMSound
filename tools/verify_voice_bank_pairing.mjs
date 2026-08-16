#!/usr/bin/env node
// net/voice-bank.js findPairedVoiceBank() の検証(DOM非依存、合成データ)。
// 実データでの確認はtools/verify_voice_bank_realdata.mjs(実際のMCM_sample_20190124
// zipを使う、CIには含めない重い検証)を参照。こちらは高速なユニットテスト。

import { findPairedVoiceBank, VOICE_BANK_SIZE } from '../net/voice-bank.js';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
}

function bank(fill) {
  return new Uint8Array(VOICE_BANK_SIZE).fill(fill);
}

// --- (1) 基本ケース: 対になるシステムディスクが見つかる ---
{
  const entries = [
    { name: 'MML_ACTRAISER.d88/STG001.muc', data: new TextEncoder().encode('#mucom88\nA @0 cdefg\n') },
    { name: 'MUCOM88_V1.5_ACTRAISER.d88/VOICE.DAT', data: bank(0xaa) },
    { name: 'MUCOM88_V1.5_ACTRAISER.d88/MUCOM.COM', data: new Uint8Array(100) },
  ];
  const pair = findPairedVoiceBank(entries, 'MML_ACTRAISER.d88/STG001.muc');
  check('(1) 対になるシステムディスクを見つける', pair !== null);
  check('(1) sysDiskNameが正しい', pair?.sysDiskName === 'MUCOM88_V1.5_ACTRAISER.d88', pair?.sysDiskName);
  check('(1) バイト列が8192byte', pair?.bytes.length === VOICE_BANK_SIZE, pair?.bytes.length);
  check('(1) バイト列の中身が一致', pair?.bytes[0] === 0xaa && pair?.bytes[VOICE_BANK_SIZE - 1] === 0xaa);
}

// --- (2) 対が無いディスク(ALGARNA相当): nullを返す(既定バンクへフォールバックする側の前提) ---
{
  const entries = [
    { name: 'MML_ALGARNA.d88/ALG001.muc', data: new Uint8Array(10) },
    // ALGARNA用のMUCOM88_V*ディスクは書庫内に存在しない(実データの事実、docs参照)
    { name: 'MUCOM88_V1.5_ACTRAISER.d88/VOICE.DAT', data: bank(0xbb) }, // 別ディスク、誤マッチしないこと
  ];
  const pair = findPairedVoiceBank(entries, 'MML_ALGARNA.d88/ALG001.muc');
  check('(2) 対が無いディスクはnull(別ディスクのvoice.datを誤って拾わない)', pair === null);
}

// --- (3) d88経由でない曲(zip直下の単体.muc): 対象外 ---
{
  const entries = [
    { name: 'sample2.mml', data: new Uint8Array(10) },
    { name: 'MUCOM88_V1.5_ACTRAISER.d88/VOICE.DAT', data: bank(0xcc) },
  ];
  const pair = findPairedVoiceBank(entries, 'sample2.mml');
  check('(3) d88経由でない単体ファイルは対象外(null)', pair === null);
}

// --- (4) "MML_"始まりでないディスク名: 対象外(未知の命名規則を推測で拾わない) ---
{
  const entries = [
    { name: 'SOMETHING_ELSE.d88/foo.muc', data: new Uint8Array(10) },
    { name: 'MUCOM88_V1.5_SOMETHING_ELSE.d88/VOICE.DAT', data: bank(0xdd) },
  ];
  const pair = findPairedVoiceBank(entries, 'SOMETHING_ELSE.d88/foo.muc');
  check('(4) "MML_"接頭辞でないディスク名は対象外(null)', pair === null);
}

// --- (5) zipのサブフォルダに入っていても、同じ階層のシステムディスクとだけ対応させる ---
{
  const entries = [
    { name: 'albumA/MML_FOO.d88/song1.muc', data: new Uint8Array(10) },
    { name: 'albumA/MUCOM88_V1.5_FOO.d88/VOICE.DAT', data: bank(0x11) },
    // 別フォルダに同名ディスクがあっても混同しない
    { name: 'albumB/MUCOM88_V1.5_FOO.d88/VOICE.DAT', data: bank(0x22) },
  ];
  const pair = findPairedVoiceBank(entries, 'albumA/MML_FOO.d88/song1.muc');
  check('(5) サブフォルダでも同じ階層のバンクを拾う', pair?.bytes[0] === 0x11, pair?.bytes[0]);
  check('(5) 別フォルダの同名ディスクは混同しない', pair?.bytes[0] !== 0x22);
}

// --- (6) 複数バージョンが混在していても命名規則(MUCOM88_V<バージョン>_<X>.d88)に一致すればよい ---
{
  const entries = [
    { name: 'MML_BARE_KNUCKLE2.d88/bare03.muc', data: new Uint8Array(10) },
    { name: 'MUCOM88_V1.7_BARE_KNUCKLE2.d88/VOICE.DAT', data: bank(0x33) },
  ];
  const pair = findPairedVoiceBank(entries, 'MML_BARE_KNUCKLE2.d88/bare03.muc');
  check('(6) バージョン違い(V1.7)でも命名規則に一致すれば見つかる', pair?.sysDiskName === 'MUCOM88_V1.7_BARE_KNUCKLE2.d88', pair?.sysDiskName);
}

// --- (7) voice.datが8192byte未満(壊れたデータ)は使わない(安全側フォールバック) ---
{
  const entries = [
    { name: 'MML_ACTRAISER.d88/stg001.muc', data: new Uint8Array(10) },
    { name: 'MUCOM88_V1.5_ACTRAISER.d88/VOICE.DAT', data: new Uint8Array(100) }, // 短すぎる
  ];
  const pair = findPairedVoiceBank(entries, 'MML_ACTRAISER.d88/stg001.muc');
  check('(7) 8192byte未満のvoice.datは使わない(null)', pair === null);
}

// --- (8) ファイル名の大文字小文字を無視する(実データはVOICE.DAT/voice.dat両方ありうる) ---
{
  const entries = [
    { name: 'MML_ACTRAISER.d88/stg001.muc', data: new Uint8Array(10) },
    { name: 'mucom88_v1.5_actraiser.d88/voice.dat', data: bank(0x44) },
  ];
  const pair = findPairedVoiceBank(entries, 'MML_ACTRAISER.d88/stg001.muc');
  check('(8) 大文字小文字を無視して一致する', pair?.bytes[0] === 0x44, pair?.bytes[0]);
}

console.log(`\n${passCount} PASS, ${failCount} FAIL`);
process.exit(failCount === 0 ? 0 : 1);
