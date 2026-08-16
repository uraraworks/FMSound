#!/usr/bin/env node
// net/voice-bank.js findPairedVoiceBank()/detectBankOffset() の検証(DOM非依存、合成データ)。
// 実データでの確認は手元のサンプルMML集zip(著作物のためリポジトリ非同梱)を使う
// 別スクリプト(スクラッチパッド)で行う。こちらは高速なユニットテスト。
//
// 【不具合修正・2026-08-16、コーディネーター指摘】ディスクのvoice.datは8192byte
// ちょうどではなく、実測では4byteの固定ヘッダを持つ(=8448byte)。旧実装は
// 「先頭0byte目から256スロット」と決め打っており、実データで全スロットが4byteずれて
// 読まれていた(名前が1件も一致しない、という以前の誤った測定結果の直接の原因)。
// この検証では、offset=0決め打ちを再発させないため、(9)でヘッダ付きバンクに対する
// オフセット自動検出そのものをテストする。

import { findPairedVoiceBank, detectBankOffset, VOICE_BANK_SIZE } from '../net/voice-bank.js';
import { encodeCp932 } from '../ui/cp932-encode.js';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
}

// (1)-(8)は「データ長がちょうどVOICE_BANK_SIZE(=候補オフセットが0の1通りしか無い)」
// 合成データなので、名前表の中身自体はこれらのテストの結果を左右しない(空配列でよい)。
const NO_NAMES = [];

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
  const pair = findPairedVoiceBank(entries, 'MML_ACTRAISER.d88/STG001.muc', NO_NAMES);
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
  const pair = findPairedVoiceBank(entries, 'MML_ALGARNA.d88/ALG001.muc', NO_NAMES);
  check('(2) 対が無いディスクはnull(別ディスクのvoice.datを誤って拾わない)', pair === null);
}

// --- (3) d88経由でない曲(zip直下の単体.muc): 対象外 ---
{
  const entries = [
    { name: 'sample2.mml', data: new Uint8Array(10) },
    { name: 'MUCOM88_V1.5_ACTRAISER.d88/VOICE.DAT', data: bank(0xcc) },
  ];
  const pair = findPairedVoiceBank(entries, 'sample2.mml', NO_NAMES);
  check('(3) d88経由でない単体ファイルは対象外(null)', pair === null);
}

// --- (4) "MML_"始まりでないディスク名: 対象外(未知の命名規則を推測で拾わない) ---
{
  const entries = [
    { name: 'SOMETHING_ELSE.d88/foo.muc', data: new Uint8Array(10) },
    { name: 'MUCOM88_V1.5_SOMETHING_ELSE.d88/VOICE.DAT', data: bank(0xdd) },
  ];
  const pair = findPairedVoiceBank(entries, 'SOMETHING_ELSE.d88/foo.muc', NO_NAMES);
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
  const pair = findPairedVoiceBank(entries, 'albumA/MML_FOO.d88/song1.muc', NO_NAMES);
  check('(5) サブフォルダでも同じ階層のバンクを拾う', pair?.bytes[0] === 0x11, pair?.bytes[0]);
  check('(5) 別フォルダの同名ディスクは混同しない', pair?.bytes[0] !== 0x22);
}

// --- (6) 複数バージョンが混在していても命名規則(MUCOM88_V<バージョン>_<X>.d88)に一致すればよい ---
{
  const entries = [
    { name: 'MML_BARE_KNUCKLE2.d88/bare03.muc', data: new Uint8Array(10) },
    { name: 'MUCOM88_V1.7_BARE_KNUCKLE2.d88/VOICE.DAT', data: bank(0x33) },
  ];
  const pair = findPairedVoiceBank(entries, 'MML_BARE_KNUCKLE2.d88/bare03.muc', NO_NAMES);
  check('(6) バージョン違い(V1.7)でも命名規則に一致すれば見つかる', pair?.sysDiskName === 'MUCOM88_V1.7_BARE_KNUCKLE2.d88', pair?.sysDiskName);
}

// --- (7) voice.datが8192byte未満(壊れたデータ)は使わない(安全側フォールバック) ---
{
  const entries = [
    { name: 'MML_ACTRAISER.d88/stg001.muc', data: new Uint8Array(10) },
    { name: 'MUCOM88_V1.5_ACTRAISER.d88/VOICE.DAT', data: new Uint8Array(100) }, // 短すぎる
  ];
  const pair = findPairedVoiceBank(entries, 'MML_ACTRAISER.d88/stg001.muc', NO_NAMES);
  check('(7) 8192byte未満のvoice.datは使わない(null)', pair === null);
}

// --- (8) ファイル名の大文字小文字を無視する(実データはVOICE.DAT/voice.dat両方ありうる) ---
{
  const entries = [
    { name: 'MML_ACTRAISER.d88/stg001.muc', data: new Uint8Array(10) },
    { name: 'mucom88_v1.5_actraiser.d88/voice.dat', data: bank(0x44) },
  ];
  const pair = findPairedVoiceBank(entries, 'MML_ACTRAISER.d88/stg001.muc', NO_NAMES);
  check('(8) 大文字小文字を無視して一致する', pair?.bytes[0] === 0x44, pair?.bytes[0]);
}

// --- (9) 【本題】固定ヘッダ付きバンク(実データ相当)のオフセットを自動検出する ---
{
  const HEADER_LEN = 4; // 実測したディスクのヘッダ長(00 60 00 80)と同じ長さ
  const TAIL_PAD = 252; // 実測(8448 = 4 + 8192 + 252)と同じ末尾埋め草
  const SLOT_SIZE = 32;
  const NAME_OFFSET = 26;
  const defaultNames = [
    { slot: 0, nameHex: Buffer.from(encodeCp932('efctes').bytes).toString('hex') },
    { slot: 1, nameHex: Buffer.from(encodeCp932('dgt1').bytes).toString('hex') },
    { slot: 200, nameHex: Buffer.from(encodeCp932('ﾀﾑﾀﾑ').bytes).toString('hex') },
  ];
  const raw = new Uint8Array(HEADER_LEN + VOICE_BANK_SIZE + TAIL_PAD).fill(0x20);
  raw.set([0x00, 0x60, 0x00, 0x80], 0); // 実測したヘッダの値をそのまま模す(値自体に依存しない実装であることの確認も兼ねる)
  for (const { slot, nameHex } of defaultNames) {
    const off = HEADER_LEN + slot * SLOT_SIZE + NAME_OFFSET;
    const bytes = Buffer.from(nameHex, 'hex');
    raw.set(bytes, off);
  }
  const { offset, matchCount } = detectBankOffset(raw, defaultNames);
  check('(9) ヘッダ付きバンクの正しい開始オフセットを検出する(決め打ちではなく実測でHEADER_LEN=4と一致)',
    offset === HEADER_LEN, `検出結果=${offset}`);
  check('(9) 一致件数が名前を仕込んだ3件と一致する', matchCount === 3, matchCount);

  const entries = [
    { name: 'MML_X.d88/song.muc', data: new Uint8Array(10) },
    { name: 'MUCOM88_V1.0_X.d88/voice.dat', data: raw },
  ];
  const pair = findPairedVoiceBank(entries, 'MML_X.d88/song.muc', defaultNames);
  check('(9) findPairedVoiceBank()もヘッダ分ずらして切り出す(bankOffset)',
    pair?.bankOffset === HEADER_LEN, pair?.bankOffset);
  check('(9) 切り出したバイト列の長さは常にVOICE_BANK_SIZE', pair?.bytes.length === VOICE_BANK_SIZE);
  check('(9) 切り出したバイト列のslot0名前フィールドが正しく読める(ヘッダを飛ばせている)',
    Buffer.from(pair.bytes.subarray(26, 32)).toString('latin1').trim() === 'efctes',
    Buffer.from(pair.bytes.subarray(26, 32)).toString('latin1'));

  // 【回帰確認】もし旧実装のようにオフセット0決め打ちで切り出していたら、
  // slot0の名前フィールドにはヘッダの残り(0x20埋め)しか入らず一致しないはず、
  // という「壊れていたら検出できる」ことの陽性対照。
  const brokenSlice = raw.subarray(0, VOICE_BANK_SIZE);
  const brokenName = Buffer.from(brokenSlice.subarray(26, 32)).toString('latin1').trim();
  check('(9) 陽性対照: オフセット0決め打ちだと名前が読めない(このテストが無意味でない証拠)',
    brokenName !== 'efctes', `offset0で読むと="${brokenName}"`);
}

console.log(`\n${passCount} PASS, ${failCount} FAIL`);
process.exit(failCount === 0 ? 0 : 1);
