// MUCOM88 MML用の構文トークン定義テーブル(1箇所にまとめ、PMD用に差し替え可能にする)。
//
// 出典(推測・当てずっぽうは禁止。実測/ソースで裏取りできたものだけを採用):
//   - upstream/MucomWeb/mucom88/package/readme.txt (UTF-8実測。CP932ではなかった)
//     「チャンネル(A～K)」「A t190@30v15 cdefgab>c」という行の書式の記述、
//     「#voice voice.dat」等#タグの一覧(#mucom88/#voice/#pcm/#composer/#author/
//     #title/#date/#comment/#url)。
//   - upstream/mucom88/src/cmucom.cpp の CMucom::hasMacro()/ProcessHeader()
//     (行頭が'#'ならタグ、ただし直後が'*'+数字ならマクロ定義扱いで除外する実装)。
//   - upstream/mucom88/package/sampl1.muc 等の実サンプル(「e&e4」のようなタイ&の
//     実使用例、「[...]4」のようなループの実使用例)。
//
// コメント記号について: MML仕様書(readme.txt)はコメントの記法を明記しておらず、
// GitHub Wiki(オフライン)参照としている。ローカルで確認できる範囲でcmucom.cppの
// C++側には「行頭が#で始まらないデータ行はタグとして処理されない」以外のコメント
// 除去処理が見当たらなかった(実際のMML本文の構文解析はsrc/bin_17/の埋め込みZ80
// バイナリ内で行われており、C++からは追えない)。
//
// そこで実機(このリポジトリのcompileMML())で実測した:
//   1. 通常のチャンネル行(例 "A cdefg XYZQQQ111")に未知の文字列を混ぜても
//      コンパイルエラーにならない(未知文字は無音でスキップされる)。
//   2. 先頭がA~K/#/*のいずれでもない行("hello world ...")もエラーにならず
//      無視される。
//   3. ";"を挟んでもエラーにならないが、これは";"がコメント開始だからではなく
//      (1)の「未知文字は無音でスキップ」と同じ挙動でしかない(";"に他の文字と
//      違う特別な扱いがある証拠は見つからなかった)。
// 以上から、MUCOM88には他のMML処理系にあるような専用の「コメント記号」は
// 存在しないと判断し、コメントのトークン種別は定義しない(判断がつかないものに
// 色を付けない方針)。#comment タグ(ヘッダタグの一種)とは別物である点に注意。

/**
 * @typedef {Object} MmlTokenRule
 * @property {string} type   - CSSクラス名の末尾(mml-tok-<type>)に使う識別子
 * @property {RegExp} regex  - lastIndex管理はハイライタ側が行うためグローバルフラグ不要
 */

// ヘッダ行(#で始まる行。ただしマクロ定義 "#nn{...}" は除く)を丸ごと1トークンとして
// 扱うための判定・分割は tokenizer 側で行毎に処理する(cmucom.cpp hasMacro()参照)。
export const MUCOM_HEADER_TAG_RE = /^(\s*#)([A-Za-z][A-Za-z0-9_]*)?/;
// hasMacro()の実装通り: '#'の後、最初の'*'の直後の文字が0-9ならマクロ定義。
export const MUCOM_MACRO_HEADER_RE = /^\s*#[^*]*\*[0-9]/;

// データ行内(ヘッダ行を除く)のトークン化ルール。配列の先頭から順に試し、
// 最初にマッチしたものを採用する(alternationの優先順位を明示するため配列化)。
export const MUCOM_TOKEN_RULES = [
  // @音色番号(例: @78, @0) - '@'と直後の数字をひとまとまりの「音色」トークンにする。
  { type: 'voice', regex: /^@[0-9]+/ },
  // ループ [ ]  (readme.txt「[  ﾉ ｶｽﾞ...」エラーメッセージ、サンプルの「[...]4」)
  { type: 'loop', regex: /^[\[\]]/ },
  // タイ & (サンプルの「e&e4」「g&g2」等で実使用を確認)
  { type: 'tie', regex: /^&/ },
  // 数値(音長・オクターブ数値・ループ回数等、まとめて「数値」として色分け)
  { type: 'number', regex: /^[0-9]+/ },
  // 音符/休符 (readme.txtの書式例「cdefgab」+ 休符r。大文字小文字を区別しない)
  { type: 'note', regex: /^[a-gA-Gr]/ },
];

// 行頭のパート文字(A～K、readme.txt「チャンネル(A～K)」)。
// 行頭の空白をスキップした直後の1文字がA~K(大文字小文字問わず)の場合のみ対象。
export const MUCOM_PART_LETTER_RE = /^([ \t]*)([A-Ka-k])/;
