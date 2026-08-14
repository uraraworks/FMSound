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

// --- PMD MML用のトークン定義 ---
//
// 出典: docs/pmd-compiler-spec.md、tools/pmd_mml_parser.mjs(現在地: compiler/pmd_mml_parser.mjs)
// の実装そのもの。「実際にコンパイラが認識する記号だけを色付けする」方針
// (推測でトークンを決めない)のため、パーサのtokenizeBody()が受理する文字だけを
// 対象にしている。パーサが大文字小文字を区別する箇所(音符 c-b は小文字のみ、
// o/O・T/t・V/v は両方等)はそのまま反映した。
//
// コメント記法について(必ず確認すること、との指示のため出典を明記する):
//   PMDMML.MAN §1-4「コメントの表記方法」(WebFetch+生バイト実測でCP932デコードして
//   確認済み、tools/PMDMML.MAN取得ログ相当)によれば
//     1. ';' から改行までを行コメントにできる(§16-5)
//     2. 行頭が空白/TABで始まる行は ';' が無くても行全体がコメット扱いになる
//     3. '`'(バッククォート)で囲むと複数行/行内コメントになる(§16-6)
//   のうち、tools/pmd_mml_parser.mjs(compiler/pmd_mml_parser.mjs) が実装しているのは
//   1.の ';' 行コメントのみ(parseMml()冒頭でraw.indexOf(';')により除去)。
//   2.と3.はコンパイラ未実装(マニュアル通りに書くと現状のパーサはエラーにする)。
//   ここで '`' を色付けすると「コメントとして安全に書ける」という誤った見た目に
//   なってしまうため、判断がつかない(=未実装の)ものとして意図的に色を付けない。
export const PMD_TOKEN_RULES = [
  // ';' から行末までの行コメント(PMDMML.MAN §1-4、パーサ実装あり)。
  { type: 'comment', regex: /^;.*/ },
  // @音色番号(例: @1, @78) - tokenizeBody() の '@' + 数値。
  { type: 'voice', regex: /^@[0-9]+/ },
  // ループ [ ] : (tokenizeBody()の'['=loopOpen, ']n'=loopClose, ':'=loopExit)。
  { type: 'loop', regex: /^[\[\]:]/ },
  // 全体ループ L (globalLoop)。
  { type: 'loop', regex: /^L/ },
  // タイ &
  { type: 'tie', regex: /^&/ },
  // オクターブ操作 o/O(数値付き)・</>(相対1段)。
  { type: 'octave', regex: /^[oO<>]/ },
  // デフォルト音長 l(小文字のみ、パーサはLを別コマンド=globalLoopとして扱う)。
  { type: 'length', regex: /^l/ },
  // テンポ T(TimerB絶対/相対)/t(テンポ絶対/相対)。
  { type: 'tempo', regex: /^[Tt]/ },
  // 音量 V(絶対値・細かい)/v(絶対値・大雑把)。
  { type: 'vol', regex: /^[Vv]/ },
  // 数値(音長数値・オクターブ数値・音色番号・ループ回数等をまとめて「数値」として色分け)。
  { type: 'number', regex: /^[0-9]+/ },
  // 音符/休符(小文字cdefgabのみ有効。大文字A-Gはパーサ非対応のため対象外)。
  // 休符はr/Rどちらも有効(tokenizeBody()参照)。
  { type: 'note', regex: /^[cdefgabrR]/ },
];

// PMDにはMUCOM88のようなマクロ定義行("#nn{...}")の仕組みが無い(v1コンパイラは
// '#'始まりの行を一切扱わない)。setupMmlEditor()はmacroHeaderReを必須で使うため、
// 「絶対にマッチしない」ダミー正規表現を渡す(空の否定先読み)。
export const PMD_MACRO_HEADER_RE = /(?!)/;

// 行頭のパート文字(A～I、PART_LETTERS=FM1-6,SSG1-3。compiler/pmd_mml_parser.mjs参照)。
// パーサは複数文字の連続指定("ABC cdefg"のように同じMMLを複数パートへ)を許すため、
// MUCOM版と異なり1文字ではなく連続するA-Iをまとめて1トークンにする。
export const PMD_PART_LETTER_RE = /^([ \t]*)([A-Ia-i]+)/;
