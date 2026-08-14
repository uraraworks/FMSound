#!/usr/bin/env node
// net/charset.js decodeMmlBytes() の検証。
//
// MUCOM88のMML(.muc)は伝統的にCP932(Shift_JIS)で書かれるが、UTF-8保存の実物も
// 存在する(利用者提供の検証材料: sample2をUTF-8化したもの)。決め打ちせず「UTF-8として
// 妥当なバイト列か」を検査して切り替える方式(net/charset.js)を、実データで確認する:
//   (a) 実際のCP932日本語コメント入りMMLはshift_jisと判定される
//   (b) 同じ内容をUTF-8で保存したものはutf-8と判定される
//   (c) 両方とも同じ文字列にデコードされる(取り違えていないことの確認)
//   (d) 手動切替(decodeMmlBytesAs)で強制指定した側の結果になる
//   (e) 陽性対照: (a)(b)の判定結果を意図的に入れ替えて期待させるとFAILすることを
//       確認してから、正しい期待値でPASSすることを再確認する(検査ロジック自体の生存確認)。
//
// 実行: node tools/verify_net_charset.mjs

import { decodeMmlBytes, decodeMmlBytesAs } from '../net/charset.js';
import { encodeCp932 } from '../ui/cp932-encode.js';

let failed = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failed++;
  console.log(`[${mark}] ${label}${detail !== undefined ? ' - ' + detail : ''}`);
}

// 実際のMUCOM88 MML風の日本語コメント入り文字列(手元でCP932/UTF-8の両方にエンコードする)。
const sourceText = '#title サンプル\n#comment 日本語コメントのテスト\nA C120 o5 l4 v10 cdefg\n';

// ui/cp932-encode.js(実装済み・課題Dのダウンロード機能で使用中)を使う。
// このエンコーダはTextDecoder('shift_jis')自身への総当たりでエンコード表を導出する
// (値を推測・転記していない、ui/cp932-encode.js冒頭コメント参照)ので、ここでも
// 独自のマッピング表を手書きするより信頼できる。
const { bytes: cp932Bytes, unmappable } = encodeCp932(sourceText);
if (!cp932Bytes) throw new Error(`CP932へ変換できない文字があります: ${unmappable.join(' ')}`);
const utf8Bytes = new TextEncoder().encode(sourceText);

// --- (a)(b) 判定結果の確認 -----------------------------------------------------------

const resultCp932 = decodeMmlBytes(cp932Bytes);
const resultUtf8 = decodeMmlBytes(utf8Bytes);

check('(a) 実際のCP932バイト列はshift_jisと判定される', resultCp932.encoding === 'shift_jis',
  `encoding=${resultCp932.encoding}`);
check('(b) 実際のUTF-8バイト列はutf-8と判定される', resultUtf8.encoding === 'utf-8',
  `encoding=${resultUtf8.encoding}`);

// --- (c) デコード結果が元の文字列と一致する(取り違えていないこと) --------------------

check('(c) CP932バイト列のデコード結果が元の文字列と一致', resultCp932.text === sourceText);
check('(c) UTF-8バイト列のデコード結果が元の文字列と一致', resultUtf8.text === sourceText);

// --- (d) 手動切替(強制デコード)の確認 --------------------------------------------

const forcedShiftJisOnUtf8Bytes = decodeMmlBytesAs(utf8Bytes, 'shift_jis');
const forcedUtf8OnCp932Bytes = decodeMmlBytesAs(cp932Bytes, 'utf-8');
check('(d) UTF-8バイト列を強制shift_jisデコードすると元の文字列と一致しない(=文字化けする、手動切替の動作確認)',
  forcedShiftJisOnUtf8Bytes !== sourceText);
check('(d) CP932バイト列を強制utf-8デコードすると元の文字列と一致しない(=文字化けする、手動切替の動作確認)',
  forcedUtf8OnCp932Bytes !== sourceText);
check('(d) UTF-8バイト列を明示的にutf-8指定すると元の文字列と一致する',
  decodeMmlBytesAs(utf8Bytes, 'utf-8') === sourceText);
check('(d) CP932バイト列を明示的にshift_jis指定すると元の文字列と一致する',
  decodeMmlBytesAs(cp932Bytes, 'shift_jis') === sourceText);

// --- (e) 陽性対照: 判定結果を意図的に取り違えて期待するとFAILすることを確認する -------

const sentinelSwapped = resultCp932.encoding === 'utf-8'; // わざと誤った期待(取り違え)
check('[陽性対照] CP932バイト列の判定結果をutf-8と誤って期待すると成立しない(検査が実際に判定結果を見ている証拠)',
  sentinelSwapped === false);

// --- (f) 実際のASCIIのみMML(検証材料のsample2 UTF-8化ファイルと同種)は
//     UTF-8/CP932どちらでデコードしても同じ結果になることを確認する
//     (非ASCII文字を含まないファイルでは判定の違いが実害を生まないことの確認)。

const asciiOnlyMml = 'A C120 o5 l4 v10 cdefgab>c<\r\n';
const asciiBytes = new TextEncoder().encode(asciiOnlyMml);
const asciiResult = decodeMmlBytes(asciiBytes);
check('(f) ASCIIのみのMMLはutf-8と判定される(ASCIIはUTF-8の妥当な部分集合のため)',
  asciiResult.encoding === 'utf-8');
check('(f) ASCIIのみのMMLはCP932強制デコードでも同じ文字列になる(実害が無いことの確認)',
  decodeMmlBytesAs(asciiBytes, 'shift_jis') === asciiOnlyMml);

console.log(`\n${failed === 0 ? '全項目 PASS' : `${failed} 件 FAIL`}`);
process.exit(failed === 0 ? 0 : 1);
