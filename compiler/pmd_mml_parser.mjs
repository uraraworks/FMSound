// PMD MML パーサ(v1)。文字列 → 中間表現(パートごとのイベント列 + 音色定義)。
//
// 対応範囲は docs/pmd-compiler-spec.md 2.1節の v1 範囲のうち、今回(第2/3/4段階)の担当分:
//   音符・休符・オクターブ(o/</>)・タイ(&)・音長(数値/付点/%)・テンポ(t/T)・
//   ローカルループ([ : ]n)・全体ループ(L)・音色選択(@n、第1段階からの継続利用)・
//   音量(v/V)・SSGパート(G/H/I)・音色定義(@ 音色番号 ALG FB ...)。
// v1範囲外(リズム・PPZ8・FM3拡張・LFO本体/ポルタメント一部・qの数値1等)は対象外。
// J(ADPCM)パートはv2 step3で追加(docs/pmd-compiler-spec-v2.md 1.2節)。
//
// パート行の形式は PMD の慣習に合わせ「行頭にパート文字(A-I)を1つ以上並べ、
// 空白の後にコマンド列を書く」("ABC t120 o4 cdefg" のように複数パートへ同じ内容を流せる)。
// パート文字と音源種別の対応は PMDMML.MAN §1-1-3 の「2. PMDB2.COM等の場合」表に従う
// (A-F=FM1-6, G-I=SSG1-3。J=PCM/K,R=リズムはv1対象外)。
//
// エラーはすべて {line, message} 形式(1-indexed行番号)で返す。エディタのエラー行
// ジャンプに使う想定(MUCOM側の `in line N.` 相当)。

// FM1-6, SSG1-3, ADPCM (doc v1 1.2節 / v2 1.2節の順。配列indexが.M側の11パート
// ヘッダindexと一致する: A-F=idx0-5=FM1-6, G-I=idx6-8=SSG1-3, J=idx9=ADPCM)。
// J(ADPCM)はv2 1.2節で「既存ヘッダ枠を流用、トラック書式もFM/SSGと共通」と確定した
// もの(step3で実装)。K/R(リズム)・PPZ8は未解明が残るため引き続き対象外。
export const PART_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
export const PART_KIND = {
  A: 'fm', B: 'fm', C: 'fm', D: 'fm', E: 'fm', F: 'fm',
  G: 'ssg', H: 'ssg', I: 'ssg',
  J: 'adpcm',
};
// FMパート(A-F)判定用。`C`(measLen)重複バグ再現(下のFM_PART_LETTERS_SET参照箇所)で使う。
const FM_PART_LETTERS_SET = new Set(['A', 'B', 'C', 'D', 'E', 'F']);
export const NOTE_LETTER_TO_BASE_INDEX = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const DEFAULT_MEAS_LEN = 96; // 全音符長の初期値。`C`(v2 3.8節, 0xdf)で変更可能。

// SSG(G-I)の`@n`ソフトウエアエンベロープ対応表(@0-@9)。2026-08-19、MC.EXE ver4.8s
// 実測で全10点確定(FINDINGS.md 9番、PSENV.MML)。出力は`0xF0`+AL/DD/SR/RR
// (ssgEnvOldと同一書式)。推測で埋めていないので、この10件以外の番号はエラーにする。
const SSG_ENVELOPE_TABLE = {
  0: { al: 0, dd: 0, sr: 0, rr: 0 },
  1: { al: 2, dd: -1, sr: 0, rr: 1 },
  2: { al: 2, dd: -2, sr: 0, rr: 1 },
  3: { al: 2, dd: -2, sr: 0, rr: 8 },
  4: { al: 2, dd: -1, sr: 24, rr: 1 },
  5: { al: 2, dd: -2, sr: 24, rr: 1 },
  6: { al: 2, dd: -2, sr: 4, rr: 1 },
  7: { al: 2, dd: 1, sr: 0, rr: 1 },
  8: { al: 1, dd: 2, sr: 0, rr: 1 },
  9: { al: 1, dd: 2, sr: 24, rr: 1 },
};

// 'v'(大雑把な音量, PMDMML.MAN §5-1)のFM/PCM用変換テーブル。v0〜v16 -> V値。
// 出典: PMDMML.MAN §5-1 の一覧表そのもの(WebFetchで原文確認、本ファイル冒頭コメント参照)。
const V_LOWERCASE_FM_TABLE = [85, 87, 90, 93, 95, 98, 101, 103, 106, 109, 111, 114, 117, 119, 122, 125, 127];
// SSGは v も V も範囲が同一(0-15, PMDMML.MAN §5-1/§5-2)なため、変換テーブルは存在せず
// 素通し(v=V)になっていると推測される。マニュアルにSSG用の変換テーブル記載は無く、
// **この等価性は未実測・未解明のまま採用している**(docs/pmd-compiler-spec.md 6.6節に明記)。

// 'v'(大雑把な音量)のPPZ8拡張パート用変換テーブル。PMDMML.MAN §5-1「PCM音源の場合」
// V(1)表(#PCMVolumeがExtendでない既定値。V(2)表は#PCMVolume Extend用、本実装は
// #PCMVolume自体が未対応(既知の未対応ヘッダとして別途エラーになる)のためV(1)固定)。
// v0〜v16 -> 0,16,32,...,240,255(v16のみ256ではなく255、マニュアル表の実測値そのまま)。
// 2026-08-18、自作corpus(tools/pmd-reference/pmdppzord.mml等、MC.EXE ver4.8s実測)で
// v7/v9/v10/v11/v12/v13の6点(いずれもn*16の値)が0xfd(音量絶対値)の引数バイトと
// 1byte単位で完全一致することを確認済み。
const PPZ_V_TABLE = [0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 255];

class ParseError extends Error {
  constructor(line, message) {
    super(message);
    this.line = line;
    this.pmdMessage = message;
  }
}

// MML変数(`!`, v2 3.4節)。出典: PMDMML.MAN §3-2(定義)・§16-1(使用)、WebFetchで原文確認。
// - 定義: 行頭 `!文字列` または `!数値` の直後にSPACE/TAB区切りでMML文字列本体(行末まで)。
//   文字列名は先頭が数字でなければ任意、数値名は0-255。両者は名前空間としては
//   区別されず、同じ命名規則(先頭が数字かどうか)で1つのテーブルとして扱ってよい
//   (マッチング処理上は文字列そのものの前方一致検索のみで、数値/文字列の別を
//   意識する必要が無いため。本実装ではこの単純化を採用)。
// - 名前の認識長は半角30文字まで(§3-2注意1)。それ以上は切り捨てる。
// - 使用: `!`の直後から、定義済み変数名のうち最長一致するものを採用する
//   (§16-1注意1「!bcc!bc!bの順に検索」の通り、長い名前を優先)。
// - ネスト可(値の中に別の`!変数`を含められる)だが再帰は禁止(§3-2「絶対に再帰させないで下さい」)。
//   本実装は再帰を検出したら ParseError にする(マニュアルは「最悪の場合暴走」と警告するのみで
//   検出方法は書いていないため、無限ループを避ける安全側の実装判断)。
// 重複定義時の扱い(同名を複数回`!`定義した場合にどちらが有効か)はPMDMML.MANに明記が無く未解明。
// 実データ3曲では重複定義は出現しなかった(目視確認)。本実装は他の重複コマンド
// (#Title等、v1 8.1節)と同じ「後勝ち」を暫定的に採用する。
const VAR_DEF_LINE_RE = /^!(\S+)[ \t]+(.*)$/;
const VAR_NAME_MAX_LEN = 30; // PMDMML.MAN §3-2 注意1

// ファイル全体を走査してMML変数の定義を集める(出現順・前方の行かどうかは問わない。
// 定義行より前に使用箇所が来るケースは実データには無いが、二段階処理にしておけば
// 順序に依存しない)。戻り値: Map<name, rawValue(未展開)>
function collectVariableDefs(lines) {
  const map = new Map();
  for (const rawLine of lines) {
    let s = rawLine;
    const ci = s.indexOf(';');
    if (ci >= 0) s = s.slice(0, ci);
    const m = VAR_DEF_LINE_RE.exec(s);
    if (!m) continue;
    let name = m[1];
    if (name.length > VAR_NAME_MAX_LEN) name = name.slice(0, VAR_NAME_MAX_LEN);
    map.set(name, m[2]); // 後勝ち(未解明、上記コメント参照)
  }
  return map;
}

// text中の `!変数名` をすべて展開する。長さ降順にソート済みの名前リストを使い、
// `!`の直後位置から前方一致で最長の名前を探す(§16-1注意1)。stackは再帰検出用。
function expandVariables(text, varMap, sortedNames, line, stack) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '!') {
      let matched = null;
      for (const name of sortedNames) {
        if (text.startsWith(name, i + 1)) { matched = name; break; }
      }
      if (matched) {
        if (stack.has(matched)) {
          throw new ParseError(line, `MML変数 '!${matched}' が再帰参照しています(PMDMML.MAN §3-2「絶対に再帰させないで下さい」)`);
        }
        stack.add(matched);
        out += expandVariables(varMap.get(matched), varMap, sortedNames, line, stack);
        stack.delete(matched);
        i += 1 + matched.length;
        continue;
      }
    }
    out += text[i];
    i++;
  }
  return out;
}

// ヘッダ命令(#Title/#Composer/#Arranger/#Memo)。出典: PMDMML.MAN §2-6〜§2-9
// (WebFetchで原文確認。書式は「#コマンド名 + 1個以上のSPACE/TAB + 文字列」、
// 内容は行末(CR)まで。「後ろに;をつけてコメント等は記せません」と明記されている
// ため、他の行と違いこの行だけは';'以降をコメントとして切り捨てない
// (呼び出し元でraw行のまま渡す)。大文字/小文字は原文では#Titleのように先頭大文字
// 固定の表記だが、他コマンド(v/V等)同様に本コンパイラは寛容側に倒し大小無視で受理する。
//
// §2 全般注記: 「#Memo以外のコマンドを重複指定した場合は、後ろの行にあるものが有効」
// →Title/Composer/Arrangerは上書き(最後勝ち)、Memoのみ複数行を順に蓄積(最大128行)。
const HEADER_LINE_RE = /^[ \t]*#(Title|Composer|Arranger|Memo)[ \t]+(.*)$/i;
const MEMO_MAX_LINES = 128; // PMDMML.MAN §2-9 "複数指定が可能で、順に定義されます。最大は128行までです。"

// #PPZExtend(PPZ8用パート拡張、PMDMML.MAN §2-25、WebFetchで原文確認)。
// [書式] #PPZExtend パート記号1[パート記号2...](8つまで)
// [記号] LMNOPQSTUVWXYZabcdefghijklmnopqrstuvwxyz のうちのいずれか
// 本実装は上記からさらに小文字'k'を除外する: 既存のKパート(リズム)混在処理
// (下のparseMml、`/k/i.test(letters)`および`letters.replace(/k/gi,'')`)が
// 大文字小文字を区別せず'k'を全部リズムKとして剥がしてしまうため、小文字'k'を
// PPZExtendの記号として declare すると値が正しく素通りしない(=文字が消える)。
// これは黙って壊れるより宣言時点でエラーにする方が安全という実装判断であり、
// マニュアル自体が小文字kを禁じているわけではない(注意点として明記)。
// 大文字Rは元々リズムパターン定義行(`R数値`)の専用記号として除外されているため
// 記号表にも含まれない。小文字rはRパターン行regex(大文字Rのみに一致)と衝突しないため許可する。
const PPZEXTEND_ALLOWED_CHARS = new Set('LMNOPQSTUVWXYZabcdefghijlmnopqrstuvwxyz'.split(''));
const PPZEXTEND_HEADER_RE = /^[ \t]*#PPZExtend[ \t]+(.*)$/i;

// #PPZExtendは本体のパート文字判定(parseMml本体ループ)より前に確定させておく必要がある
// (ファイル中の出現順に依存させないための安全策。#PPZExtendは通常ファイル先頭に書かれる
// 慣習だが、他のヘッダと同様に「後勝ち」を採用しつつ、body側の文字判定はファイル全体の
// 宣言に対して一貫させる。collectVariableDefsと同じ設計判断)。
// パート記号とPPZ_1〜PPZ_8の対応規則(=宣言順、大文字小文字を区別する固定の対応表では
// ない)は2026-08-18、自作corpus(tools/pmd-reference/ppz*.mml、MC.EXE ver4.8s実測)で
// 確定した。docs/pmd-compiler-spec-v2.md 2.1節参照。
function collectPpzExtend(lines) {
  let letters = null; // 最後に見つかった有効な#PPZExtend行の文字配列(宣言順を保持、後勝ち)
  let letterLine = null;
  const errors = [];
  for (let li = 0; li < lines.length; li++) {
    const m = PPZEXTEND_HEADER_RE.exec(lines[li]);
    if (!m) continue;
    const lineNo = li + 1;
    const arg = m[1].trim();
    if (arg.length === 0) {
      errors.push({ line: lineNo, message: `#PPZExtend の後にパート記号がありません(PMDMML.MAN §2-25)` });
      continue;
    }
    if (arg.length > 8) {
      errors.push({ line: lineNo, message: `#PPZExtend は最大8パートまでです(PMDMML.MAN §2-25「パート記号...(8つまで)」): "${arg}"` });
      continue;
    }
    const chars = [...arg];
    const seen = new Set();
    let ok = true;
    for (const ch of chars) {
      if (!PPZEXTEND_ALLOWED_CHARS.has(ch)) {
        errors.push({ line: lineNo, message: `#PPZExtend に使えない記号です(PMDMML.MAN §2-25 [記号] LMNOPQSTUVWXYZabcdefghijklmnopqrstuvwxyz のいずれか。小文字kは本実装では未対応): '${ch}'` });
        ok = false;
        break;
      }
      if (seen.has(ch)) {
        errors.push({ line: lineNo, message: `#PPZExtend で同じパート記号が重複しています: '${ch}'` });
        ok = false;
        break;
      }
      seen.add(ch);
    }
    if (!ok) continue;
    letters = chars;
    letterLine = lineNo;
  }
  return { letters, letterLine, errors };
}

// #FM3Extend(FM音源3チャネル目のパート拡張、PMDMML.MAN §2-20。WebFetch経由で取得した
// PMDMML.MANの生バイト列をCP932デコード+NEL(0x85)を改行として展開した上で原文確認。
// grepがNEL区切り行を無言で読み飛ばす既知の落とし穴(このファイル冒頭の教訓)があるため、
// 単純なgrepではなくPythonでbytes→text変換してから該当節全文を読んだ)。
//
// [書式] #FM3Extend パート記号1[パート記号2[パート記号3]]] (最大3つ、区切り文字なし)
// [記号] LMNOPQSTUVWXYZabcdefghijklmnopqrstuvwxyz のうちのいずれか
//   →#PPZExtend(§2-25)と全く同じ記号表(原文を突き合わせて確認済み)。従って
//   小文字'k'を除外する理由・大文字Rを含まない理由もPPZEXTEND_ALLOWED_CHARSと同じ
//   (Kパート混在処理・Rパターン定義行との衝突回避)。
// [説明] 「FM音源3のパートを、指定したパート記号で拡張します。最大３ｃｈ分設定可能です。
//   FM音源3チャネル目は、独立して最大４つまでのパートを演奏する事が可能ですが、
//   デフォルトでは(略)、１パートしか定義されていませんので、このコマンドで新たに
//   パート記号を定義します。」
//   本プロジェクトが採用している表2(PMDB2/PMD86/PMDVA、v1 7.3節)では、C=FM3のみが
//   既定で定義されており、D/E/F は既にFM4-6として独立パート(§1-1-3表2)なので、
//   表1(PMD/PMDVA1、D/E/Fを差し替える)の記述はこの実装には適用されない
//   (#FM3Extendで宣言した記号は既存パートを置き換えず、単純に新規追加される)。
const FM3EXTEND_ALLOWED_CHARS = PPZEXTEND_ALLOWED_CHARS;
const FM3EXTEND_HEADER_RE = /^[ \t]*#FM3Extend[ \t]+(.*)$/i;
const FM3EXTEND_MAX_LETTERS = 3;

// #PPZExtendと同じ理由(ファイル中の出現順に依存させない事前確定)でparseMml本体
// ループより前に呼ぶ。ただし2026-08-19時点では「宣言・パート文字としての受理」までが
// 実装範囲で、.M側の出力(0xc6コマンド、upstream/98fmplayer/fmdriver/fmdriver_pmd.c
// :3554 pmd_cmdc6_fm3ex_initが読む3スロット×2byteポインタ表)の**配置場所**は
// MC.EXE実測で確認できていない(#PPZExtendの0xb4はpmdppzord.mml等のMC.EXE実測で
// 配置を確定させたが、この作業ではWebNP2+MC.EXEパイプラインを使う余地が無かった)。
// 「もっともらしい値は正しい番地の証明にならない」という既存の教訓(実際、PPZ8の
// 0xb4配置は最初「ファイル末尾」という推測が外れ、実測で「RHYTHM直後」に訂正された
// 実績がある)を踏まえ、配置を推測実装せず、compiler.mjs側で「構文としては解釈できるが
// .M生成は未対応」という専用エラーで止める(下記compileMml参照)。
function collectFm3Extend(lines) {
  let letters = null;
  let letterLine = null;
  const errors = [];
  for (let li = 0; li < lines.length; li++) {
    const m = FM3EXTEND_HEADER_RE.exec(lines[li]);
    if (!m) continue;
    const lineNo = li + 1;
    const arg = m[1].trim();
    if (arg.length === 0) {
      errors.push({ line: lineNo, message: `#FM3Extend の後にパート記号がありません(PMDMML.MAN §2-20)` });
      continue;
    }
    if (arg.length > FM3EXTEND_MAX_LETTERS) {
      errors.push({ line: lineNo, message: `#FM3Extend は最大${FM3EXTEND_MAX_LETTERS}パートまでです(PMDMML.MAN §2-20「パート記号1[パート記号2[パート記号3]]]」「最大３ｃｈ分設定可能」): "${arg}"` });
      continue;
    }
    const chars = [...arg];
    const seen = new Set();
    let ok = true;
    for (const ch of chars) {
      if (!FM3EXTEND_ALLOWED_CHARS.has(ch)) {
        errors.push({ line: lineNo, message: `#FM3Extend に使えない記号です(PMDMML.MAN §2-20 [記号] LMNOPQSTUVWXYZabcdefghijklmnopqrstuvwxyz のいずれか。小文字kは本実装では未対応): '${ch}'` });
        ok = false;
        break;
      }
      if (seen.has(ch)) {
        errors.push({ line: lineNo, message: `#FM3Extend で同じパート記号が重複しています: '${ch}'` });
        ok = false;
        break;
      }
      seen.add(ch);
    }
    if (!ok) continue;
    letters = chars;
    letterLine = lineNo;
  }
  return { letters, letterLine, errors };
}

// (a) PCMファイル指定系ヘッダ。出典: upstream/98fmplayer/fmdriver/fmdriver_pmd.c の
// pmd_init()(6043-6066) が pmd_get_memo(pmd, -2)=PPZ, -1=PPS, 0=PCM(PPC) を読んで
// pmd->ppzfile/ppsfile/ppcfile へコピーする(ppzfileはさらに','以降をppzfile2へ分離)。
// つまり書き込まないとPCM/PPZ/PPSが鳴らない実害があるため、メモ領域へ実測どおり反映する
// (buildMemoBlock 側、レイアウトはそちらのコメント参照)。書式はTitle等と同じ
// 「#コマンド名 + SPACE/TAB + 文字列(行末まで)」で、';'をコメントとして切り詰めない
// (Title等と同じ理由。ファイル名にセミコロンが使われる可能性を否定できないため安全側)。
const PCM_HEADER_RE = /^[ \t]*#(PCMfile|PPZfile|PPSfile)[ \t]+(.*)$/i;
const PCM_HEADER_KEY = { pcmfile: 'pcmfile', ppzfile: 'ppzfile', ppsfile: 'ppsfile' };

// #FFFile ファイル名[.FF/.FFL] (PMDMML.MAN §2-4)。使用する外部音色ファイル名を
// 指定するだけのヘッダで、ファイルの中身自体はこのパーサでは読まない(PCMfile等と
// 同じ扱い。ファイルシステムアクセスを持たないパーサの責務外)。ファイル名を
// header.fffileへ記録するのみで、実際に音色解決へ反映するのは呼び出し側
// (compileMmlの`ffFile`オプション、渡された生バイト列を使う)が担う。
// 2026-08-18: 以前はKNOWN_UNIMPLEMENTED_HEADERSでエラー扱いだったが、
// compileMml側でffFileオプションによる外部音色解決を実装したため、ヘッダ行自体は
// エラーにせず読み飛ばす(PCM_HEADER_REと同じ経路)よう変更した。
const FFFILE_HEADER_RE = /^[ \t]*#FFFile[ \t]+(.*)$/i;

// (b) 動作(パート割当・数値レンジ等)を変える可能性があるが、意味や.M側への反映方法が
// 未解明のヘッダ。黙って読み飛ばすと「コンパイルは通るのに音が違う」という最悪の壊れ方に
// なるため、実装せず専用のエラーメッセージで止める(指示書の原則)。ヘッダ名は
// 大文字小文字を無視して照合する(他ヘッダと同様、寛容側に倒す)。
// 2026-08-18: #Detune/#LFOSpeed/#EnvelopeSpeedはいずれも実装済み(DETUNE_HEADER_RE /
// LFOSPEED_HEADER_RE / ENVSPEED_HEADER_RE、別途処理するためここには残さない。
// 復活させないよう明記しておく)。現時点でこの表は空だが、今後同種の「意味は
// マニュアルに明記されているが.M側出力バイトが未実測」なヘッダが出た場合の
// 置き場として残す。
const KNOWN_UNIMPLEMENTED_HEADERS = {
};

// #Detune Extend/Normal(PMDMML.MAN §2-16)。「Extend」はSSGパート(G,H,I)の頭全てに
// 等価なコマンド"DX1"を指定したのと同じ効果になる、とマニュアルに明記されている
// (推測ではない)。対象パートがSSGのみ(A-FやJには効かない)という点は取り違えやすいが、
// 実測(pmdhdrxt.M: #Detune Extendの参照.MでG/H/Iのみが+3byte増え、A/B-F/Jは
// 変化しないことを確認済み)で裏取りしてある。「Normal」は既定状態そのもの
// (§2-16「ノーマル仕様の場合」)なのでヘッダを見た記録だけ残し、合成コマンドは
// 何も追加しない。
const DETUNE_HEADER_RE = /^[ \t]*#Detune[ \t]+(Extend|Normal)[ \t]*$/i;

// #LFOSpeed Extend/Normal(PMDMML.MAN §2-17)。「Extend」はFM/SSG/ADPCMパート(A〜J)の
// 頭全てに等価なコマンド"MXA1 MXB1"を指定したのと同じ効果になる、とマニュアルに
// 明記されている(推測ではない)。対象パートはA〜J全部(Detuneと異なりSSGに限らない)。
// 実測(PMDLFOXT.MML: #LFOSpeed Extendの参照.MでA〜J全10パートが各+4byte、
// 未使用パートでも増分することを確認。K/L等の非レター枠は変化しない)で裏取りした。
// 「Normal」は既定状態そのものなのでヘッダを見た記録だけ残す。
const LFOSPEED_HEADER_RE = /^[ \t]*#LFOSpeed[ \t]+(Extend|Normal)[ \t]*$/i;

// #EnvelopeSpeed Extend/Normal(PMDMML.MAN §2-18)。「Extend」はSSG/PCMパート(G〜J)の
// 頭全てに等価なコマンド"EX1"を指定したのと同じ効果になる、とマニュアルに明記されている。
// 対象パートはG〜Jの4パート(SSG3+PCM1。LFOSpeedと異なりA〜Fには効かない)。
// 実測(PMDENVXT.MML: #EnvelopeSpeed Extendの参照.MでG〜Jのみ各+2byte、A〜Fは
// 変化しないことを確認)で裏取りした。
const ENVSPEED_HEADER_RE = /^[ \t]*#EnvelopeSpeed[ \t]+(Extend|Normal)[ \t]*$/i;

// 汎用ヘッダ行判定(#で始まる行すべてを拾う。上記いずれにも一致しない未知のヘッダも
// ここで捕まえて専用メッセージを出す。'#'始まりの行が「パート指定または音色定義で
// 始まる必要があります」という無関係なエラーになるのを避けるため)。
const GENERIC_HEADER_RE = /^[ \t]*#(\S+)(?:[ \t]+(.*))?$/;

// ヘッダ命令行かどうかを判定し、該当すれば header へ反映するか、専用エラーを積んで
// true を返す。呼び出し元は raw(未加工の行文字列、';'を切り詰める前)を渡すこと。
function tryParseHeaderLine(raw, lineNo, header, errors) {
  const m = HEADER_LINE_RE.exec(raw);
  if (m) {
    const key = m[1].toLowerCase();
    const text = m[2];
    if (key === 'memo') {
      if (header.memo.length >= MEMO_MAX_LINES) {
        errors.push({ line: lineNo, message: `#Memo が${MEMO_MAX_LINES}行を超えています(PMDMML.MAN §2-9の上限)` });
        return true;
      }
      header.memo.push(text);
      header.memoLines.push(lineNo);
    } else {
      header[key] = text; // 最後に書かれたものが有効(§2 全般注記)
      header[`${key}Line`] = lineNo;
    }
    return true;
  }

  const ppzM = PPZEXTEND_HEADER_RE.exec(raw);
  if (ppzM) {
    // 実際の検証(文字種・重複・8つ以内)と宣言順の確定はparseMml冒頭のcollectPpzExtend()
    // が本体ループより前に一括して行う(このファイルの他ヘッダ同様の情報記録のみここで行う)。
    header.ppzExtend = ppzM[1].trim();
    header.ppzExtendLine = lineNo;
    return true;
  }

  const fm3M = FM3EXTEND_HEADER_RE.exec(raw);
  if (fm3M) {
    // #PPZExtendと同じ二段階方式: 検証・宣言順の確定はparseMml冒頭のcollectFm3Extend()。
    header.fm3Extend = fm3M[1].trim();
    header.fm3ExtendLine = lineNo;
    return true;
  }

  const pcmM = PCM_HEADER_RE.exec(raw);
  if (pcmM) {
    const key = PCM_HEADER_KEY[pcmM[1].toLowerCase()];
    // 2026-08-19実データ実測(MSO_FM_FS_PPZ.MML「#PPZFile mspcm3.PZI」、ALPHA_2022_ppz.MML/
    // SS_TENG_ppz.mmlも同じ書式): 参照.Mのメモ領域には大文字化された値("MSPCM3.PZI")が
    // 書かれている(own旧実装は本文そのまま小文字混じり)。DOSの8.3ファイル名慣習に
    // 合わせてMC.EXEがコンパイル時に大文字化していると判明したため、ここで変換する。
    header[key] = pcmM[2].toUpperCase(); // 最後勝ち(Title等と同じ扱い。§2 全般注記に準拠)
    header[`${key}Line`] = lineNo;
    return true;
  }

  const ffM = FFFILE_HEADER_RE.exec(raw);
  if (ffM) {
    header.fffile = ffM[1]; // 最後勝ち(Title等と同じ扱い)。実体の読み込みはcompileMml側
    header.fffileLine = lineNo;
    return true;
  }

  const detuneM = DETUNE_HEADER_RE.exec(raw);
  if (detuneM) {
    header.detuneExtend = detuneM[1].toLowerCase() === 'extend' ? 'Extend' : 'Normal';
    header.detuneExtendLine = lineNo;
    return true;
  }

  const lfospeedM = LFOSPEED_HEADER_RE.exec(raw);
  if (lfospeedM) {
    header.lfoSpeedExtend = lfospeedM[1].toLowerCase() === 'extend' ? 'Extend' : 'Normal';
    header.lfoSpeedExtendLine = lineNo;
    return true;
  }

  const envspeedM = ENVSPEED_HEADER_RE.exec(raw);
  if (envspeedM) {
    header.envSpeedExtend = envspeedM[1].toLowerCase() === 'extend' ? 'Extend' : 'Normal';
    header.envSpeedExtendLine = lineNo;
    return true;
  }

  const genM = GENERIC_HEADER_RE.exec(raw);
  if (genM) {
    const nameRaw = genM[1];
    const argRaw = (genM[2] ?? '').trim().toLowerCase();
    // Detuneは上の専用正規表現(引数Extend/Normalのみ許可)で既に処理済みのはず。
    // ここまで落ちてきたのは引数が Extend/Normal のどちらでもない(typo・省略等)
    // ケースなので、専用の分かりやすいメッセージで止める(黙って読み飛ばすと動作が
    // 変わるヘッダなので、想定外はエラーにする方針)。
    if (/^(detune|lfospeed|envelopespeed)$/i.test(nameRaw)) {
      errors.push({ line: lineNo, message: `#${nameRaw} の引数が不正です(Extend または Normal のいずれかが必要): "${genM[2] ?? ''}"` });
      return true;
    }
    // "#Detune Extend" のように「ヘッダ名+引数Extend」の形と、"#PPZExtend"のように
    // ヘッダ名自体にExtendを含む形の両方があるため、まずヘッダ名単独で既知表を引き、
    // 無ければ「ヘッダ名+引数」の組み合わせでも引く(Detune/LFOSPeed/EnvelopeSpeed用)。
    const nameKey = nameRaw.toLowerCase();
    const combinedKey = argRaw === 'extend' ? nameKey : null;
    const desc = KNOWN_UNIMPLEMENTED_HEADERS[nameKey] ?? (combinedKey ? KNOWN_UNIMPLEMENTED_HEADERS[combinedKey] : undefined);
    if (desc) {
      errors.push({ line: lineNo, message: `未対応のヘッダです: #${nameRaw}${argRaw ? ' ' + genM[2].trim() : ''}（動作を変える可能性があるため読み飛ばさずエラーにしています。${desc}）` });
    } else {
      errors.push({ line: lineNo, message: `未対応のヘッダです: #${nameRaw}（意味が未解明のため読み飛ばさずエラーにしています）` });
    }
    return true;
  }

  return false;
}

// 数値長 → クロック値。全音符長(既定96、`C`コマンドで変更可)の約数のみ許容
// (PMDMML.MAN §2-11、doc 1.3節)。measLenは呼び出し時点でのグローバル全音符長。
function numericLengthToClocks(n, line, measLen) {
  if (n <= 0 || measLen % n !== 0) {
    throw new ParseError(line, `音長 ${n} は全音符長${measLen}の約数ではありません`);
  }
  return measLen / n;
}

// リズム音源直接コマンド(`\`系、PMDMML.MAN §14)。全パート共通で使える
// (§14冒頭「総てのパートに指定する事が可能」)ため、通常のtokenizeBody・
// Kパート・Rパターン本体の3箇所から共通で呼ぶ。
//
// b/s/c/h/t/i の6文字とビット位置(0xebの下位6bit)の対応、l/m/rと出力位置2bitの対応は
// いずれもマニュアルには明記が無く(§14-1/§14-4)、今回 tools/pmd-reference/pmdunimp.M
// (既存corpus、K/R使用)の実測 + 新規corpusケース(rhbits/rhpan、MC.EXE ver4.8s実測、
// 各音を1つずつ分離して`\b r4 \s r4 \c r4 \h r4 \t r4 \i r4`のように出力させ、
// 0xebの引数バイトを直接読んだ)の2系統で確認した:
//   b=bit0, s=bit1, c=bit2, h=bit3, t=bit4, i=bit5 (マニュアル記載順のまま0から採番)
//   r=0b01, l=0b10, m=0b11 (YM2608パンレジスタのRR/LL 2bitと同じ並び。0b00は未使用)
// \v(個別音量)の対象music番号(1-6)は0xeaの上位3bitをpmdunimp.M実測で解読して
// b=1,s=2,c=3,h=4,t=5,i=6と確認済み(§14-3本文の記載順と一致)。
const RHYTHM_BIT = { b: 0, s: 1, c: 2, h: 3, t: 4, i: 5 };
const RHYTHM_TARGET_NUM = { b: 1, s: 2, c: 3, h: 4, t: 5, i: 6 };
const RHYTHM_PAN_VAL = { r: 1, l: 2, m: 3 };

// body[i] === '\\' の直後から1つの `\`系コマンドを読み、eventsへ積んで次のindexを返す。
// 直前のeventが「dumpフラグが同じrhShot」であれば、そのビットマスクへ合算する
// (PMDMML.MAN §14-1「同時に出力したい場合は、\s\t\iというように指定して下さい」を
// 参照.M実測(pmdunimp.M: `\b\c`→単一の0xeb 05、`\h\s\h\t`→単一の0xeb 1a)で確認した挙動)。
function parseBackslashCommand(body, i, line, events) {
  i++; // '\\' を読み飛ばす
  const c2 = body[i];
  if (c2 === 'V') {
    // マスタボリューム。PMDMML.MAN §14-2。絶対値0xe8(0-63)/相対値0xe6(符号付き1byte)。
    i++;
    let sign = null;
    if (body[i] === '+' || body[i] === '-') { sign = body[i]; i++; }
    const m = /^\d+/.exec(body.slice(i));
    if (!m) throw new ParseError(line, `'\\V' の後に数値がありません(PMDMML.MAN §14-2)`);
    i += m[0].length;
    const val = parseInt(m[0], 10);
    if (sign) {
      const delta = sign === '-' ? -val : val;
      if (delta < -128 || delta > 127) throw new ParseError(line, `'\\V'の相対値が1byte符号付きに収まりません: ${delta}`);
      events.push({ type: 'rhVolRel', line, delta });
    } else {
      if (val < 0 || val > 63) throw new ParseError(line, `'\\V'の値が範囲外です(0-63。PMDMML.MAN §14-2): ${val}`);
      events.push({ type: 'rhVolAbs', line, value: val });
    }
    return i;
  }
  if (c2 === 'v') {
    // 個別音量。PMDMML.MAN §14-3。絶対値0xea(上位3bit=対象1-6/下位5bit=値0-31)、
    // 相対値0xe5(1byte目=対象1-6/2byte目=符号付き差分)。
    i++;
    const t = body[i];
    if (!(t in RHYTHM_TARGET_NUM)) throw new ParseError(line, `'\\v' の後は b/s/c/h/t/i のいずれかです(PMDMML.MAN §14-3): '${t ?? ''}'`);
    i++;
    let sign = null;
    if (body[i] === '+' || body[i] === '-') { sign = body[i]; i++; }
    const m = /^\d+/.exec(body.slice(i));
    if (!m) throw new ParseError(line, `'\\v${t}' の後に数値がありません`);
    i += m[0].length;
    const val = parseInt(m[0], 10);
    if (sign) {
      const delta = sign === '-' ? -val : val;
      if (delta < -128 || delta > 127) throw new ParseError(line, `'\\v${t}'の相対値が1byte符号付きに収まりません: ${delta}`);
      events.push({ type: 'rhVolIndivRel', line, target: RHYTHM_TARGET_NUM[t], delta });
    } else {
      if (val < 0 || val > 31) throw new ParseError(line, `'\\v${t}'の値が範囲外です(0-31。PMDMML.MAN §14-3): ${val}`);
      events.push({ type: 'rhVolIndivAbs', line, target: RHYTHM_TARGET_NUM[t], value: val });
    }
    return i;
  }
  if (c2 === 'l' || c2 === 'm' || c2 === 'r') {
    // 出力位置。PMDMML.MAN §14-4。0xe9(上位3bit=対象1-6/下位2bit=l=2,m=3,r=1)。
    const panVal = RHYTHM_PAN_VAL[c2];
    i++;
    const t = body[i];
    if (!(t in RHYTHM_TARGET_NUM)) throw new ParseError(line, `'\\${c2}' の後は b/s/c/h/t/i のいずれかです(PMDMML.MAN §14-4): '${t ?? ''}'`);
    i++;
    events.push({ type: 'rhPan', line, target: RHYTHM_TARGET_NUM[t], pos: panVal });
    return i;
  }
  if (c2 in RHYTHM_BIT) {
    // ショット/ダンプ制御。PMDMML.MAN §14-1。0xeb(bit7=dump、下位6bit=対象)。
    i++;
    let dump = false;
    if (body[i] === 'p') { dump = true; i++; }
    const bit = 1 << RHYTHM_BIT[c2];
    const last = events[events.length - 1];
    if (last && last.type === 'rhShot' && last.dump === dump) {
      last.bits |= bit;
    } else {
      events.push({ type: 'rhShot', line, bits: bit, dump });
    }
    return i;
  }
  throw new ParseError(line, `未対応の '\\' コマンドです: '\\${c2 ?? ''}'（PMDMML.MAN §14。対応: b/s/c/h/t/i[p], V, v[bschti], l/m/r[bschti]）`);
}

function applyDots(baseClocks, dotCount, line) {
  let total = baseClocks;
  let extra = baseClocks;
  for (let i = 0; i < dotCount; i++) {
    if (extra % 2 !== 0) {
      throw new ParseError(line, `付点(${'.'.repeat(dotCount)})の途中で割り切れないクロック値になりました(base=${baseClocks})`);
    }
    extra = extra / 2;
    total += extra;
  }
  return total;
}

// デフォルト音長('l'コマンド、音符/休符の無指定時に使う値)は固定クロック値ではなく
// 「全音符の何分の1か」という比率(n)+付点数(dots)で保持し、実際にクロック値が必要な
// 都度(音符/休符を読む時点)、その時点でのglobalState.measLen('C'コマンドで変更可能)
// から再計算する。2026-08-19、MC.EXE実測(tools/pmd-reference/pmdwhole.mml: `C72 l4 c`
// `C132 d` `C204 e`)で判明: `l4`確定時のクロック値を`C`変更後も使い回すのは誤りで、
// 「l4」は常に「現在のCの4分の1」を意味する。Rパターン内の無指定'r'が参照元Kの
// その時点のデフォルト音長を継承する既存実装(ensurePatternCompiled呼び出し側)と
// 同じ原則であり、この関数を通常パート・Rパターン本体の両方で共有する。
function resolveDefaultLengthClocks(spec, globalState, line) {
  let clocks = numericLengthToClocks(spec.n, line, globalState.measLen);
  if (spec.dots > 0) clocks = applyDots(clocks, spec.dots, line);
  return clocks;
}

// 本文(パート文字を除いた部分)を字句解析してイベント列を返す。
// state: {octave, defaultLengthSpec({n, dots})} をパートごとに呼び出し元が持ち回す。
// partKind: 'fm' | 'ssg' (v/Vの値域・変換がFM/SSGで異なるため、doc 6.6節)
// globalState: {measLen} 。`C`(全音符長設定)は全パート共通のグローバル設定
// (PMDMML.MAN §4-11「いずれかのパートの頭に設定すれば、すべてのパートに有効」)
// のため、呼び出し元(parseMml)が1つのオブジェクトをすべてのパートへ使い回す。
// partLetter: 呼び出し元(parseMml)が「同じ行を複数パートへ流す」ためにパートごとに
// 1回ずつこの関数を呼ぶ際の、今回の呼び出し対象パート文字(1文字)。`|`(MML Skip
// Control、PMDMML.MAN §16-2、WebFetch実測: pigu-a.github.io/pmddocs/pmdmml.htm
// "16.2. MML Skip Control 1")の対象判定に使う。
function tokenizeBody(body, line, state, rawEvents, partKind, globalState, partLetter) {
  let i = 0;
  const n = body.length;
  // `|`(§16-2)によるパート限定。書式は`| [!] [パート文字列]`。
  //   - `|`単独(直後にパート文字が無い)は限定解除(=全パートが対象。既定状態と同じ)。
  //     ヘッダに複数パートを列挙した行の区切りとして「小節線」のように見た目だけ
  //     使われるケース(実データに頻出)は、この「解除」が常にno-opになることで
  //     自然に「無視される」動作になる。
  //   - `|ABC`はA/B/Cのみを対象にする。`|!ABC`はA/B/C**以外**を対象にする
  //     (§16-2実測: 「| [part letters]」で対象を絞り、`!`を前置すると反転)。
  //   - 対象外の間は、後続コマンドを通常通り字句解析はする(カーソルは進める)が、
  //     このtokenizeBody呼び出し(=1パート分)のイベント列には積まない。
  //     これを「events.push」だけを条件付きにするProxyで実現し、既存の大量の
  //     `events.push(...)`呼び出し箇所(本関数内40箇所超)を書き換えずに済ませる。
  let active = true;
  const events = new Proxy(rawEvents, {
    get(target, prop, receiver) {
      if (prop === 'push') {
        return (ev) => { if (active) target.push(ev); return target.length; };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  function readLengthSpec() {
    // 戻り値: クロック値、または null(長さ指定なし=デフォルト長を使う)
    // PMDMML.MAN §1-3「数値表記の方法」: 「コマンド名とパラメータ数値の間は、
    // spaceまたはtabで空白を空けても構いません」(実測例4「MA 12, 1, 8, 2」は
    // 「間のspaceは無視され、MA12,1,8,2と同等になります」)。音符名(c/d/e/f/g/a/b)
    // も「コマンド名」に含まれる一般規則として、直後の音長数値との間の空白を
    // 許容する(実データMULE_op_loop.MML:122 `g 12f12`で確認)。ただし同じ§1-3が
    // 「数値が続く場合のカンマ等は、数値の直後にある必要があります」と明記して
    // おり(失敗例「MB 12 , 1 , 8 , 2」はエラー)、数値の**後ろ側**の空白まで
    // 無条件に緩めるものではない(ここでは数値の**前**だけを1回スキップする)。
    while (body[i] === ' ' || body[i] === '\t') i++;
    if (body[i] === '%') {
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'%' の後に数値がありません`);
      i += m[0].length;
      return parseInt(m[0], 10);
    }
    const m = /^\d+/.exec(body.slice(i));
    let clocks;
    if (m) {
      i += m[0].length;
      clocks = numericLengthToClocks(parseInt(m[0], 10), line, globalState.measLen);
    } else {
      clocks = resolveDefaultLengthClocks(state.defaultLengthSpec, globalState, line);
    }
    let dots = 0;
    while (body[i] === '.') { dots++; i++; }
    return dots > 0 ? applyDots(clocks, dots, line) : clocks;
  }

  // '(' ')' (音量相対変化、基本形のみ。v2 3.1節)。[%] [数値]、数値省略時は1。
  // %付きは指定値そのまま(0-255)。%無し(数値のみ)の倍率はパート種別で異なる
  // (2026-08-19、実データDS4_MAIA.mml(SSG)・MSO_FM_FS_PPZ.MML(PPZ8拡張)実測で判明。
  // 従来は全パート一律×4としていたが、それはFMパートでのみ確認できていた値だった):
  //   - FM: ×4(既存確認分。0xe2/0xe3は1byte引数のため、無指定時の数値域を0-63に
  //     制限する。doc本文には明記が無いがバイト長の制約から一意に導ける値域)。
  //   - SSG(partKind==='ssg'): ×1(無変換。DS4_MAIA.mmlのG/H/Iパート、`(3`→
  //     参照.Mは`e2 03`(=3そのまま)、自作(旧実装)は`e2 0c`(=3×4=12)で食い違っていた)。
  //   - PPZ8拡張(partKind==='ppz'): ×16(MSO_FM_FS_PPZ.MMLのPPZ8拡張パート、
  //     `(2`→参照.Mは`e2 20`(=2×16=32)、自作(旧実装)は`e2 08`(=2×4=8))。
  //   - ADPCM(partKind==='adpcm'): ×16(2026-08-19実測、MSO_ET_Virtual_Intensity_88.MML
  //     line165のJパート(ADPCM)、`(2`→参照.Mは`e2 20`(=2×16=32)、旧実装は`e2 08`
  //     (=2×4=8)。以前「未実測」としていたPPZと同じ×16の推測が実測で確認できた)。
  function readVolRelArg() {
    let percent = false;
    if (body[i] === '%') { percent = true; i++; }
    const m = /^\d+/.exec(body.slice(i));
    let num;
    // 2026-08-18: %も数値も一切無い完全な無指定かどうか(isDefault)。参照.M実測
    // (mso_JSM.MML)で、`(`/`)`を数値無しで書いた場合はMC.EXEが0引数の専用コマンド
    // (0xf3/0xf4、fmdriver_pmd.c:2526-2572)を出力し、値4を1byte引数で書く
    // 0xe2/0xe3(fmdriver_pmd.c:2958-2966)を使うのは数値/%が明示された場合だけ、
    // と判明した(own: e2 04 e2 04 / ref: f3 f3。どちらも「無指定×4=値4」相当だが
    // バイト表現が違う)。isDefaultはこの分岐に使う(compileMml側)。
    // 2026-08-19追記: 実データ実測(INTOPAL=MSO_OF_Into_the_Palace_N.mml、`p1 (1`)で
    // 「数値を明示的に1と書いた場合」も同じくf3/f4(短縮形)になると判明した
    // (own旧実装: e2 04(明示のため長形式) / 参照: f3)。「%も数値も無い」ではなく
    // 「(パーセント指定でなく)数値が1(無指定時の既定値と同じ)」がMC.EXEの短縮形の
    // 判定条件だったと解釈するのが最も単純にこの2点の実測と整合する(この'(' ')'の
    // MML仕様上の既定値がそもそも「1」であるため、無指定=1という理解に合わせて
    // 「数値==1」で統一)。
    const isDefault = !percent && (!m || parseInt(m[0], 10) === 1);
    if (m) { i += m[0].length; num = parseInt(m[0], 10); } else { num = 1; }
    if (percent) {
      if (num < 0 || num > 255) throw new ParseError(line, `'('/')' の%指定値が範囲外です(0-255): ${num}`);
      return { value: num, isDefault };
    }
    const multiplier = partKind === 'ssg' ? 1 : (partKind === 'ppz' || partKind === 'adpcm') ? 16 : 4;
    const maxNum = Math.floor(255 / multiplier);
    if (num < 0 || num > maxNum) throw new ParseError(line, `'('/')' の数値が範囲外です(0-${maxNum}。無指定時は×${multiplier}され1byteに収める制約から算出): ${num}`);
    return { value: num * multiplier, isDefault };
  }

  // '{ }' 内(ポルタメント音程指定、v2 3.5節→今回実測で解決)は c/d/e/f/g/a/b/o/</>
  // のみ許可(PMDMML.MAN §4-3「{ }の中には、c d e f g a b o > < コマンドのみ
  // 指定して下さい」)。o/</> はここで state.octave を更新し、これは通常の音符と
  // 同じく '}' の外まで持ち越される(PMDの八度レジスタはパート共通の1つの状態のため)。
  //
  // バッチ3a: 旧実装は「note1・note2の直後にそれぞれ1回だけo/</>を許す」という
  // 固定順(o/</>* note o/</>* note)を前提にしていたが、実データ(DS4_MAIA.mml:176
  // `d8&{d<a>}16`)で「note2の**後**、'}'の**前**」にオクターブシフトが来る例が
  // 見つかり、これは旧実装では扱えなかった(note2確定後に`}`を期待して失敗)。
  // マニュアルの許可文字列挙は順序を一切規定していないため、「o/</>と音程文字が
  // 任意の順序で混在してよく、その中に音程がちょうど2つ含まれる」という一般形で
  // 読み直すのが正しい(実データの4件全てがこの読みで矛盾なく説明できる: `{g<g>}`
  // `{d<d>}` `{ef}8&f` `{a-<a->}16` `{d<a>}16`)。
  function readBraceOctaveShifts() {
    for (;;) {
      if (body[i] === 'o' || body[i] === 'O') {
        i++;
        const m = /^\d+/.exec(body.slice(i));
        if (!m) throw new ParseError(line, `'{...}' 内の 'o' の後にオクターブ数値がありません`);
        i += m[0].length;
        const oct = parseInt(m[0], 10);
        // PMDMML.MAN §4-4: oコマンドの範囲は1〜8(既定4)。実バイトのnibbleは
        // これより1小さい0-7(参照.M実測、docs/pmd-compiler-spec-v2.md 6章参照:
        // `pmdbasic.mml`の`o5`が参照.M上でnibble=4として符号化されていた)。
        if (oct < 1 || oct > 8) throw new ParseError(line, `'{...}' 内のオクターブが範囲外です(1-8。PMDMML.MAN §4-4): ${oct}`);
        // 2026-08-19実測(MSO_ET_Virtual_Intensity_88.MML、docs/pmd-compiler-real-data-diff-
        // 2026-08-19.md参照): 通常の'o'/'<'/'>'(line 942-952)と同じく`|`制限区間の外
        // (active===false)ではstate.octaveを更新してはいけない。旧実装はactive不問で
        // 常に更新しており、他パート向けの`|`区間を読み飛ばす際に音程が化けていた。
        if (active) state.octave = oct - 1;
        continue;
      }
      // 標準MML慣習: '<'=オクターブ下, '>'=オクターブ上(参照.M実測、
      // pmdbasic.mmlの`b>c<`で b=0x4b→>後のc=0x50 と1オクターブ上がることを確認。
      // 旧実装は逆(未検証コメント付き)だった)。
      if (body[i] === '<') { i++; if (active) state.octave -= 1; continue; }
      if (body[i] === '>') { i++; if (active) state.octave += 1; continue; }
      break;
    }
  }

  // 音程文字(c/d/e/f/g/a/b)が1つあれば読み取って返す。無ければnull(呼び出し側で
  // '{...}' 内の音程がちょうど2個であることを検査するために使う)。
  function tryReadBraceNoteLetter() {
    const nc = body[i];
    if (!(nc in NOTE_LETTER_TO_BASE_INDEX)) return null;
    i++;
    let noteIndex = NOTE_LETTER_TO_BASE_INDEX[nc];
    let octave = state.octave;
    while (body[i] === '+' || body[i] === '#' || body[i] === '-') {
      if (body[i] === '-') noteIndex -= 1; else noteIndex += 1;
      i++;
    }
    if (noteIndex < 0) { noteIndex += 12; octave -= 1; }
    if (noteIndex > 11) { noteIndex -= 12; octave += 1; }
    if (octave < 0 || octave > 7) {
      throw new ParseError(line, `'{...}' 内のオクターブが範囲外です(0-7。cmd<0x80制約): ${octave}`);
    }
    return { octave, noteIndex };
  }

  // '{...}' の中身全体(o/</>と音程が任意順で混在)を読み、音程をちょうど2個集めて返す。
  function readBraceNotes() {
    const notes = [];
    for (;;) {
      readBraceOctaveShifts();
      const note = tryReadBraceNoteLetter();
      if (note) { notes.push(note); continue; }
      break;
    }
    if (notes.length !== 2) {
      throw new ParseError(line, `'{...}' 内には音程(c/d/e/f/g/a/b)をちょうど2つ指定してください(o/</>は任意個数・任意位置に混在可。PMDMML.MAN §4-3): ${notes.length}個`);
    }
    return notes;
  }

  // 擬似エコー('W'、PMDMML.MAN §12-2)展開。state.echoが設定されている間、後続の
  // プレーンな音符トークン(c/d/e/f/g/a/b。タイ圧縮・ポルタメント経由の音符は対象外。
  // 実測データにこの組み合わせの実例が無いため未対応のまま)を seg ティックずつに
  // 分割し、切れ目ごとに0xdd(d<0)/0xde(d>0)コマンドを挟んだ複数のnoteイベント列へ
  // 展開する。2026-08-19、WebNP2+FreeDOS上の実機MC.EXE ver4.8sをPW.MML/PW2.MML/
  // PW3.MMLで実測して確定した仕様(tools/pmd-reference/追加分・FINDINGS.md参照):
  //   - 音符を seg ティックずつに分割して並べる(最後の断片は端数、合計は元の音長)。
  //   - 分割の切れ目ごとに、k番目(1始まり、音符ごとにリセット)の切れ目で
  //     min(|d|*k, 15) * 4 を引数に0xdd/0xdeを挟む。
  //   - d=0 は分割だけ行いコマンドを出さない(解除ではない)。
  function pushEchoAwareNote(octave, noteIndex, clocks) {
    const echo = state.echo;
    if (!echo) { events.push({ type: 'note', line, octave, noteIndex, clocks }); return; }
    const { seg, d } = echo;
    let remaining = clocks;
    let k = 0;
    while (remaining > 0) {
      const segClocks = Math.min(seg, remaining);
      events.push({ type: 'note', line, octave, noteIndex, clocks: segClocks });
      remaining -= segClocks;
      if (remaining > 0) {
        k++;
        if (d !== 0) {
          const value = Math.min(Math.abs(d) * k, 15) * 4;
          events.push({ type: 'pseudoEcho', line, sign: d < 0 ? -1 : 1, value });
        }
      }
    }
  }

  while (i < n) {
    const c = body[i];
    if (/\s/.test(c)) { i++; continue; }

    // `|`(MML Skip Control 1、PMDMML.MAN §16-2。WebFetch実測、
    // pigu-a.github.io/pmddocs/pmdmml.htm "16.2. MML Skip Control 1"): 同じ行に
    // 複数パート文字を並べて書いた場合(例: `ABI |AB o5 @183|I o4@1|  e32&...`)に、
    // `|`以降を「一部のパートだけに向けた内容」へ限定するための区切り。
    //   書式: `|` (対象指定なし。限定解除=全パート対象に戻す)
    //        `|<パート文字列>` (指定パートのみを対象にする)
    //        `|!<パート文字列>` (指定パート以外を対象にする)
    // 対象外のパートに対しては、このtokenizeBody呼び出し(=partLetter 1個分)の
    // イベント列に何も積まない(上のeventsプロキシがactive=falseの間push を
    // 素通しせず捨てる)が、字句解析(カーソル移動)自体は他パート向け内容と
    // 同じ経路でそのまま進める(=パースは共通、出力先だけをパートごとに絞る設計)。
    // 単独の`|`(対象指定なし)は「限定解除」のno-opとして働くため、実データに
    // 頻出する「小節線」的な飾り用法(`|`を区切りとしてただ並べるだけ)は、
    // その都度「全パート対象」を再宣言しているだけで見た目通り無視される。
    if (c === '|') {
      i++;
      const negate = body[i] === '!';
      if (negate) i++;
      // パート文字は大文字のみを対象指定として拾う(実データ・マニュアル例とも
      // すべて大文字表記)。音符名(c/d/e/f/g/a/b)は常に小文字であり、この本体
      // (tokenizeBody)ではパート指定文字(A-J)と音符名を大小文字で区別している
      // (例: 'D'=デチューン、'd'=音符レ)。もし大文字・小文字両方を対象指定に
      // 含めてしまうと、`|`直後にスペース無しで音符が続く「限定解除して即座に
      // 音符へ戻る」パターン(実データ`...|H f32|<`等)で、直後の小文字音符名まで
      // 対象指定として誤って呑み込んでしまう(実測で発覚。`|d4`を`|`+パート指定'd'
      // と誤認識し、後続の'4'が未対応文字エラーになっていた)。
      const m = /^[A-Z]*/.exec(body.slice(i));
      const restrictLetters = m[0];
      i += restrictLetters.length;
      if (restrictLetters === '') {
        active = true; // 対象指定なし(`!`だけの場合も含む) = 限定解除
      } else {
        const upperLetters = restrictLetters.toUpperCase();
        const included = partLetter != null && upperLetters.includes(partLetter.toUpperCase());
        active = negate ? !included : included;
      }
      continue;
    }

    if (c === '/') {
      // コンパイル打ち切り。PMDMML.MAN §16-4「そのパートのCompileを、そこで打ち切ります」。
      // 出力バイトは一切無い(純粋なコンパイル時ディレクティブ)。「そこで打ち切る」は
      // 単にこの行の残りだけでなく、以降の行で同じパート文字が再度現れても以後は
      // 一切コンパイルしない、という意味(§16-4の例が2行にまたがって示している通り)。
      // state.terminated を立てて即座にこの呼び出し自体を終了させ、呼び出し元
      // (parseMml)がこのフラグを見て後続行での同パートの処理を丸ごとスキップする。
      state.terminated = true;
      return;
    }

    if (c === '\\') {
      // リズム音源直接コマンド(`\`系、PMDMML.MAN §14)。「総てのパートに指定する事が
      // 可能」(§14冒頭)なため、FM/SSG/ADPCMパートでもここで受理する。
      i = parseBackslashCommand(body, i, line, events);
      continue;
    }

    if (c in NOTE_LETTER_TO_BASE_INDEX) {
      i++;
      let noteIndex = NOTE_LETTER_TO_BASE_INDEX[c];
      let octave = state.octave;
      // 変化記号: '+'/'#'=シャープ, '-'=フラット(反対隣の音の異名同音として解決する)
      while (body[i] === '+' || body[i] === '#' || body[i] === '-') {
        if (body[i] === '-') noteIndex -= 1; else noteIndex += 1;
        i++;
      }
      if (noteIndex < 0) { noteIndex += 12; octave -= 1; }
      if (noteIndex > 11) { noteIndex -= 12; octave += 1; }
      // 音符バイトは cmd<0x80 でなければならない(doc 1.3節)。(octave<<4)|noteIndex が
      // 0x80以上になると終端マーカー(0x80)やコマンド(0x81-)と衝突するため、
      // オクターブは実質 0-7 のみ有効(全96通り=8オクターブ×12音、スペックの
      // 「o1〜o8」という書き方は俗称で、実際のオクターブ"番号"は0起点で0-7である)。
      if (octave < 0 || octave > 7) {
        throw new ParseError(line, `オクターブが範囲外です(0-7。cmd<0x80制約、doc 1.3節): ${octave}`);
      }
      const clocks = readLengthSpec();
      if (clocks < 1 || clocks > 255) {
        throw new ParseError(line, `音長クロック値が1byteに収まりません: ${clocks}`);
      }
      pushEchoAwareNote(octave, noteIndex, clocks);
      continue;
    }

    if (c === 'W') {
      // 擬似エコー本体('W'、PMDMML.MAN §12-2)。純粋なコンパイル時ディレクティブ
      // (.M側に'W'自体のバイトは無い。以降の音符へpushEchoAwareNote()経由で作用する)。
      // 書式: W<seg>,<d>。segは分割幅(ティック、1-255)、dは減衰の符号付き係数。
      i++;
      const m = /^(\d+)\s*,\s*(-?\d+)/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'W' の後に seg,d の2数値がありません(PMDMML.MAN §12-2)`);
      i += m[0].length;
      const seg = parseInt(m[1], 10);
      const d = parseInt(m[2], 10);
      if (seg < 1 || seg > 255) throw new ParseError(line, `'W'(擬似エコー)のseg(数値1)が範囲外です(1-255。音符分割幅のため): ${seg}`);
      state.echo = { seg, d };
      continue;
    }

    if (c === 'r' || c === 'R') {
      i++;
      const clocks = readLengthSpec();
      if (clocks < 1 || clocks > 255) {
        throw new ParseError(line, `音長クロック値が1byteに収まりません: ${clocks}`);
      }
      events.push({ type: 'rest', line, octave: state.octave, clocks });
      continue;
    }

    if (c === '&') {
      i++;
      // タイ(&)の直後に音長を書く記法(PMDMML.MAN §4-10 書式3「&[音長][.]」)。
      // 「&の直後に音長を指定すると、l+コマンドと同等の扱いとなり、直前の音長に
      // 指定した音長を加算する」(§4-10実測、WebFetch/wikiwiki.jp thtools該当節)。
      // 例: `a8&2` = `a8l+2` = `a8&a2`(直前と同じ音程の音符を指定音長で発行し、
      // タイで繋ぐ)。実装は「tieイベント + 直前ノートと同じ音程・指定音長のnote
      // イベント」を素直に積むだけでよい: 直後のmergeSamePitchTies(同ファイル内、
      // pmd_mml_compiler.mjs)が同音程タイを1個のnoteへ圧縮する処理を既に持っており、
      // それがそのまま「加算」を実現する。`&&`(スラー、書式2/4)は対象外
      // (実データに出現せず、docs/pmd-compiler-spec.md「&&＝スラーとの区別は未解明」
      // のまま。誤って同一視しない)。
      if (body[i] === '&') {
        // '&&'(スラー)は本バッチのスコープ外。未対応の文字として従来通りエラーにする
        // (下のNOTE_LETTER_TO_BASE_INDEX等どのケースにも該当しない2文字目'&'が
        // そのまま「未対応の文字です」に落ちる)。
        events.push({ type: 'tie', line });
        continue;
      }
      if (body[i] === '%' || /\d/.test(body[i] ?? '') || body[i] === '.') {
        let prevNote = null;
        for (let k = events.length - 1; k >= 0; k--) {
          if (events[k].type === 'note') { prevNote = events[k]; break; }
          if (events[k].type !== 'tie') break; // タイ以外を挟んだら直前の音符とみなせない
        }
        // `|`(§16-2)でこのパートが対象外(active=false)の間は、直前の音符が
        // このパートの出力に無くても構文エラーにしない(その音符は別パート向けの
        // 内容であり、このパートには元々関係が無いため。読み飛ばすだけでよい)。
        if (!prevNote && active) {
          throw new ParseError(line, `'&' の直後に音長がありますが、直前に音符がありません(PMDMML.MAN §4-10)`);
        }
        const clocks = readLengthSpec();
        if (active) {
          if (clocks < 1 || clocks > 255) {
            throw new ParseError(line, `音長クロック値が1byteに収まりません: ${clocks}`);
          }
          events.push({ type: 'tie', line });
          events.push({ type: 'note', line, octave: prevNote.octave, noteIndex: prevNote.noteIndex, clocks });
        }
        continue;
      }
      events.push({ type: 'tie', line });
      continue;
    }

    if (c === 'o' || c === 'O') {
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'o' の後にオクターブ数値がありません`);
      i += m[0].length;
      const oct = parseInt(m[0], 10);
      // PMDMML.MAN §4-4: oコマンドの範囲は1〜8(既定4)。実バイトのnibbleはこれより
      // 1小さい0-7(参照.M実測、docs/pmd-compiler-spec-v2.md 6章参照)。
      if (oct < 1 || oct > 8) throw new ParseError(line, `オクターブが範囲外です(1-8。PMDMML.MAN §4-4): ${oct}`);
      // 2026-08-19実データ実測(MSO_ET_Virtual_Intensity_88.mml、`|AB o5 @183|I o4@1|`)で
      // 判明: `|`(Skip Control 1)で対象外にされている間の'o'は、そのパートのオクターブ状態を
      // 一切変更してはいけない(実測: own旧実装はactive不問でstate.octaveを常に更新していた
      // ため、Aパート向けの`o5`の直後に`|I o4@1|`のo4がAにも適用されてしまい、参照.Mより
      // 1オクターブ低いノートを出力していた)。イベント(events.push)と同じくactiveでゲートする。
      if (active) state.octave = oct - 1;
      continue;
    }
    // 標準MML慣習: '<'=オクターブ下, '>'=オクターブ上(参照.M実測、
    // pmdbasic.mmlの`b>c<`で確認。旧実装は逆(未検証コメント付き)だった)。
    // 'o'と同じ理由でactive時のみ適用する(2026-08-19)。
    if (c === '<') { i++; if (active) state.octave -= 1; continue; }
    if (c === '>') { i++; if (active) state.octave += 1; continue; }

    if (c === 'l') {
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'l' の後に音長数値がありません`);
      i += m[0].length;
      const lenN = parseInt(m[0], 10);
      // その時点のCに対する妥当性(約数かどうか)はここで検証しておく。実際に使われる
      // クロック値は、後で音符/休符を読む時点のC(その時点でさらに変わっている
      // 可能性がある)から都度再計算する(resolveDefaultLengthClocks参照)。
      numericLengthToClocks(lenN, line, globalState.measLen);
      let dots = 0;
      while (body[i] === '.') { dots++; i++; }
      // 'o'/'<'/'>'と同じ理由でactive時のみ適用する(2026-08-19、実データでの直接確認は
      // 無いが、Skip Control 1の対象外部分が状態を変更しないという同一原則から適用)。
      if (active) state.defaultLengthSpec = { n: lenN, dots };
      continue;
    }
    if (c === 'L') { i++; events.push({ type: 'globalLoop', line }); continue; }

    if (c === '@') {
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'@' の後に音色番号がありません`);
      i += m[0].length;
      const tonenum = parseInt(m[0], 10);
      // 2026-08-19実測(FINDINGS.md 9番、PSENV.MML): SSG(G-I)の`@n`は、FMのように
      // 音色番号を0xFF+番号で参照するのではなく、内蔵SSGソフトウエアエンベロープ
      // (0-9)を選び、コンパイル時に`0xF0`+AL/DD/SR/RR(ssgEnvOldと同一書式、計5byte)へ
      // その場で展開される。対応表は10点(@0-@9)すべて実測済みで、SSG_ENVELOPE_TABLE
      // (このファイル末尾付近)をそのまま使う。ADPCM(J)の`@n`は展開されず、FMと同じく
      // 0xFF+番号のまま(実測: `J o4 l4 @0 c @1 c` → `ff 00 30 18 ff 01 30 18 80`。
      // 分類メモには「Jも同様のはず」という推測があったが、実測ではJは対象外)。
      // 実測(FINDINGS.md 9番)は@0-@9の10点のみ全数実測済み。それ以外(10以上)の番号は
      // 2026-08-19実データ実測(MSO_ET_Virtual_Intensity_88.MML)で追加確定した:
      // `GD @183`(G=SSG1)・`ABI @177`(I=SSG3)・`ABI ... @183`(I=SSG3、別行)の3箇所とも、
      // 参照.Mでは`0xF0 00 00 00 00`(=SSG_ENVELOPE_TABLE[0]と同一のAL/DD/SR/RRゼロ)に
      // 展開されていた(177,183,225の3点、いずれも表引き失敗時に単純に0番へ丸まる
      // 挙動と整合)。'tone'イベントへフォールバックする旧実装は誤りだったため、
      // SSGパートは範囲に関わらず常にssgEnvOldへ展開し、表に無い番号は
      // SSG_ENVELOPE_TABLE[0](オール0)を使う。
      if (partKind === 'ssg') {
        const env = SSG_ENVELOPE_TABLE[tonenum] ?? SSG_ENVELOPE_TABLE[0];
        events.push({ type: 'ssgEnvOld', line, al: env.al, dd: env.dd, sr: env.sr, rr: env.rr });
      } else {
        events.push({ type: 'tone', line, tonenum });
      }
      continue;
    }

    if (c === 'T' || c === 't') {
      const isTimerB = c === 'T';
      i++;
      if (body[i] === '+' || body[i] === '-') {
        const sign = body[i] === '-' ? -1 : 1;
        i++;
        const m = /^\d+/.exec(body.slice(i));
        if (!m) throw new ParseError(line, `'${c}${sign < 0 ? '-' : '+'}' の後に数値がありません`);
        i += m[0].length;
        const delta = sign * parseInt(m[0], 10);
        if (delta < -128 || delta > 127) throw new ParseError(line, `テンポ相対値が1byte符号付きに収まりません: ${delta}`);
        events.push({ type: 'tempoRel', line, isTimerB, delta });
        continue;
      }
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'${c}' の後に数値がありません`);
      i += m[0].length;
      const val = parseInt(m[0], 10);
      if (isTimerB) {
        if (val < 0 || val > 250) throw new ParseError(line, `TimerB絶対値(T)は0-250です: ${val}`);
      } else {
        if (val < 0 || val > 255) throw new ParseError(line, `テンポ絶対値(t)は0-255です: ${val}`);
      }
      events.push({ type: 'tempoAbs', line, isTimerB, val });
      continue;
    }

    if (c === 'V') {
      // 音量指定2(細かい値、絶対値)。PMDMML.MAN §5-2。FM:0-127 / SSG:0-15 / PCM(ADPCM):0-255。
      // (doc本文/pmd-compiler-spec.md 7.2節)。
      // PPZ8拡張パート: マニュアル同節の[範囲]表には「0〜15(SSG音源,SSGリズム,PPZパート)」
      // という記述もあるが、実測(0xfd引数、上のPPZ_V_TABLEのコメント参照)ではv変換後の値が
      // 208等15を大きく超えており、根拠となる0xfdコマンド自体は1byte(0-255)を素直に読む
      // 実装のため15までに制限する理由がない。このタスクで実測・既知の2件(Rパターン範囲・
      // ALG/FB5行目)と同種の「マニュアル記載と実機の食い違い」と判断し、実測(v変換表と
      // 同じPCM系0-255)を採用する。#PCMVolume等の未対応ヘッダは別途エラーになるため、
      // ここでの選択が音を壊す実害は無い(常にこの1byteをそのまま出力するだけ)。
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'V' の後に音量数値がありません`);
      i += m[0].length;
      const val = parseInt(m[0], 10);
      const max = partKind === 'ssg' ? 15 : (partKind === 'adpcm' || partKind === 'ppz') ? 255 : 127;
      if (val < 0 || val > max) {
        throw new ParseError(line, `'V' の値が範囲外です(${partKind === 'ssg' ? 'SSGは0-15' : (partKind === 'adpcm' || partKind === 'ppz') ? 'PCMは0-255' : 'FMは0-127'}): ${val}`);
      }
      events.push({ type: 'volAbs', line, value: val });
      continue;
    }
    if (c === 'v') {
      // 音量指定1(大雑把な値)。PMDMML.MAN §5-1。FM:0-16(V_LOWERCASE_FM_TABLE経由)/
      // SSG:0-15(素通し、未解明)/ PCM(ADPCM・PPZ8拡張):0-16(PPZ_V_TABLE経由)。
      // PPZ8拡張パートはPCM_V_TABLE(V(1)表、上のコメント参照)を使う(FMのV_LOWERCASE_FM_TABLEとは別表。
      // 実測で確認済み)。ADPCM(J)も同じPPZ_V_TABLEを使う(2026-08-19、実データ
      // POPFUL_HOSHI.mml実測で確定: `v12`→参照.Mは`fd c0`(=PPZ_V_TABLE[12]=192)で、
      // 従来のV_LOWERCASE_FM_TABLE[12]=117とは食い違う。ADPCMもPCM系の音量スケールを
      // 共有すると判明したため、'adpcm'を'ppz'と同じ分岐に統合した)。
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'v' の後に音量数値がありません`);
      i += m[0].length;
      const val = parseInt(m[0], 10);
      const max = partKind === 'ssg' ? 15 : 16;
      if (val < 0 || val > max) {
        throw new ParseError(line, `'v' の値が範囲外です(${partKind === 'ssg' ? 'SSGは0-15' : 'FM/PCMは0-16'}): ${val}`);
      }
      const converted = partKind === 'ssg' ? val : (partKind === 'ppz' || partKind === 'adpcm') ? PPZ_V_TABLE[val] : V_LOWERCASE_FM_TABLE[val];
      events.push({ type: 'volAbs', line, value: converted });
      continue;
    }

    if (c === '[') { i++; events.push({ type: 'loopOpen', line }); continue; }
    if (c === ']') {
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `']' の後にループ回数(n)が必要です(v1では省略不可)`);
      i += m[0].length;
      const count = parseInt(m[0], 10);
      if (count < 0 || count > 255) throw new ParseError(line, `ループ回数が1byteに収まりません: ${count}`);
      events.push({ type: 'loopClose', line, count });
      continue;
    }
    if (c === ':') { i++; events.push({ type: 'loopExit', line }); continue; }

    if (c === 'C') {
      // 全音符長の設定。PMDMML.MAN §4-11。`.M`側 0xdf(v2 3.8節)。全パート共通のグローバル設定。
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'C' の後に全音符長の数値がありません`);
      i += m[0].length;
      const val = parseInt(m[0], 10);
      if (val < 1 || val > 255) throw new ParseError(line, `'C'(全音符長)の値が範囲外です(1-255): ${val}`);
      globalState.measLen = val; // 以降のこのパート・他パートの音長計算に即座に反映する
      // gInjectMeasLen: パートGへの`C`注入(FINDINGS.md 14番)専用の値追跡。
      // 通常パート(A-J、この関数=tokenizeBody)の`C`だけがこれを更新する
      // (KパートのtokenizeRhythmKBody側の`C`は更新しない。下のコメント参照)。
      globalState.gInjectMeasLen = val;
      events.push({ type: 'measLen', line, value: val });
      continue;
    }

    if (c === 'D') {
      i++;
      if (body[i] === 'X') {
        // SSG音源音程補正指定。PMDMML.MAN §7-3。`.M`側 0xcc + 1byte(値0-1)。
        // #Detune Extend(§2-16)の実体そのもの(実測: pmdhdrxt.M、SSGパートの
        // 頭で cc 01 の2byteとして確認、docs/pmd-compiler-spec-v2.md参照)。
        // マニュアル上は[音源]SSGのみの記載だが、既存のD/DD同様パート種別は
        // 検査せずそのまま出力する(他の数値系コマンドと実装方針を揃える)。
        i++;
        const m = /^\d+/.exec(body.slice(i));
        if (!m) throw new ParseError(line, `'DX' の後に数値がありません`);
        i += m[0].length;
        const val = parseInt(m[0], 10);
        if (val < 0 || val > 1) throw new ParseError(line, `'DX' の値が範囲外です(0-1): ${val}`);
        events.push({ type: 'detuneExtend', line, value: val });
        continue;
      }
      // デチューン設定。PMDMML.MAN §7-1。絶対値`D`=0xfa、相対値`DD`=0xd5(v2 3.9節)。
      let relative = false;
      if (body[i] === 'D') { relative = true; i++; }
      const m = /^-?\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'${relative ? 'DD' : 'D'}' の後にデチューン数値がありません`);
      i += m[0].length;
      const val = parseInt(m[0], 10);
      if (val < -32768 || val > 32767) {
        throw new ParseError(line, `'${relative ? 'DD' : 'D'}'(デチューン)の値が範囲外です(-32768〜32767): ${val}`);
      }
      events.push({ type: relative ? 'detuneRel' : 'detuneAbs', line, value: val });
      continue;
    }

    if (c === 'E') {
      // ソフトウエアエンベロープ速度設定(テンポ非依存化)。PMDMML.MAN §8-2。`.M`側
      // 0xc9 + 1byte(値0-1)。#EnvelopeSpeed Extend(§2-18)の実体そのもの(実測:
      // PMDENVXT.MML、G〜Jパートの頭で c9 01 の2byteとして確認、
      // docs/pmd-compiler-spec-v2.md参照)。
      i++;
      if (body[i] === 'X') {
        i++;
        const m = /^\d+/.exec(body.slice(i));
        if (!m) throw new ParseError(line, `'EX' の後に数値がありません`);
        i += m[0].length;
        const val = parseInt(m[0], 10);
        if (val < 0 || val > 1) throw new ParseError(line, `'EX'の値が範囲外です(0-1): ${val}`);
        events.push({ type: 'envSpeedExtend', line, value: val });
        continue;
      }
      // 無印の'E'(SSG/PCMソフトウエアエンベロープ指定、PMDMML.MAN §8-1)。バッチ3a
      // で対応。引数の個数で書式を判別する(マニュアル本文「指定数値が４つの場合は
      // 書式１、５または６個の場合は書式２」)。
      //   書式1(4引数: AL,DD,SR,RR) → `.M`側 0xf0 + 4byte(fmdriver_pmd.c:2650
      //     pmd_cmdf0_env_old実測: 4値ともraw byteをそのままload。DD(数値2)だけ
      //     符号付き-15〜+15、他は0-255)。
      //   書式2(5-6引数: AR,DR,SR,RR,SL,AL[省略時0]) → `.M`側 0xcd + 5byte
      //     (fmdriver_pmd.c:3410 pmd_cmdcd_env_new実測: AR/DR/SRは&0x1f、4byte目は
      //     上位nibble=(SL^0xf)・下位nibble=RR&0xf に詰めて1byte化、5byte目=AL&0xf)。
      // [音源]マニュアル(PMDMML.MAN §8-1)はSSG/PCM(AD,86,PPZ)専用と明記しているが、
      // 2026-08-19、WebNP2+FreeDOS上の実機MC.EXE ver4.8sをPEFM.MMLで実測したところ
      // FMパートでも拒否されず、SSGと同一のコマンドバイト(書式1: 0xf0 + 4byte)を
      // そのまま出力することを確認した(tools/pmd-reference/追加分参照)。よって
      // partKindによる拒否はやめ、全パート種別で受理する。
      {
        const m = /^(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)(?:\s*,\s*(-?\d+))?(?:\s*,\s*(-?\d+))?/.exec(body.slice(i));
        if (m) {
          i += m[0].length;
          const nums = [m[1], m[2], m[3], m[4], m[5], m[6]].filter((x) => x != null).map((x) => parseInt(x, 10));
          if (nums.length === 4) {
            const [al, dd, sr, rr] = nums;
            if (al < 0 || al > 255) throw new ParseError(line, `'E'(ソフトウエアエンベロープ書式1)の数値1(AL)が範囲外です(0-255。PMDMML.MAN §8-1): ${al}`);
            if (dd < -15 || dd > 15) throw new ParseError(line, `'E'(ソフトウエアエンベロープ書式1)の数値2(DD)が範囲外です(-15〜+15。PMDMML.MAN §8-1): ${dd}`);
            if (sr < 0 || sr > 255) throw new ParseError(line, `'E'(ソフトウエアエンベロープ書式1)の数値3(SR)が範囲外です(0-255。PMDMML.MAN §8-1): ${sr}`);
            if (rr < 0 || rr > 255) throw new ParseError(line, `'E'(ソフトウエアエンベロープ書式1)の数値4(RR)が範囲外です(0-255。PMDMML.MAN §8-1): ${rr}`);
            events.push({ type: 'ssgEnvOld', line, al, dd, sr, rr });
            continue;
          }
          const [ar, dr, sr, rr, sl, al = 0] = nums;
          if (ar < 0 || ar > 31) throw new ParseError(line, `'E'(ソフトウエアエンベロープ書式2)の数値1(AR)が範囲外です(0-31。PMDMML.MAN §8-1): ${ar}`);
          if (dr < 0 || dr > 31) throw new ParseError(line, `'E'(ソフトウエアエンベロープ書式2)の数値2(DR)が範囲外です(0-31。PMDMML.MAN §8-1): ${dr}`);
          if (sr < 0 || sr > 31) throw new ParseError(line, `'E'(ソフトウエアエンベロープ書式2)の数値3(SR)が範囲外です(0-31。PMDMML.MAN §8-1): ${sr}`);
          if (rr < 0 || rr > 15) throw new ParseError(line, `'E'(ソフトウエアエンベロープ書式2)の数値4(RR)が範囲外です(0-15。PMDMML.MAN §8-1): ${rr}`);
          if (sl < 0 || sl > 15) throw new ParseError(line, `'E'(ソフトウエアエンベロープ書式2)の数値5(SL)が範囲外です(0-15。PMDMML.MAN §8-1): ${sl}`);
          if (al < 0 || al > 15) throw new ParseError(line, `'E'(ソフトウエアエンベロープ書式2)の数値6(AL)が範囲外です(0-15。PMDMML.MAN §8-1): ${al}`);
          events.push({ type: 'ssgEnvNew', line, ar, dr, sr, rr, sl, al });
          continue;
        }
      }
      i--; // 'E'単独で引数が続かない場合は未対応の文字エラーに落とすため位置を戻す
    }

    if (c === 's') {
      // FM音源使用スロット位置指定。PMDMML.MAN §6-2。`.M`側 0xcf + 1byte(値0-15、
      // fmdriver_pmd.c:3313 pmd_cmdcf_slotmask実測: 1byteをそのままslot_maskへ格納)。
      // [音源]FM専用(マニュアル明記)。
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'s' の後にスロット位置数値がありません`);
      i += m[0].length;
      const val = parseInt(m[0], 10);
      if (val < 0 || val > 15) throw new ParseError(line, `'s'(FM使用スロット)の値が範囲外です(0-15。PMDMML.MAN §6-2): ${val}`);
      if (partKind !== 'fm') throw new ParseError(line, `'s'(FM使用スロット)はFM音源パート専用です(PMDMML.MAN §6-2): partKind=${partKind}`);
      events.push({ type: 'fmSlotMask', line, value: val });
      continue;
    }

    if (c === 'P') {
      // SSG / OPM トーン・ノイズ出力選択。PMDMML.MAN §6-5。`.M`側 0xed + 1byte
      // (fmdriver_pmd.c:2696 pmd_cmded_ssgmix実測: 1byteをそのままssg_mixへ格納)。
      // SSG音源パート向けとして実装する(OPMのHパート向け用法は本コンパイラが
      // OPM/Hに相当するパート種別を扱っていないため未対応のまま。実データはSSGでの
      // 使用のみ確認できた)。
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'P' の後にトーン/ノイズ選択数値がありません`);
      i += m[0].length;
      const val = parseInt(m[0], 10);
      if (val < 1 || val > 3) throw new ParseError(line, `'P'(トーン/ノイズ選択)の値が範囲外です(1-3。PMDMML.MAN §6-5): ${val}`);
      if (partKind !== 'ssg') throw new ParseError(line, `'P'(トーン/ノイズ選択)はSSG音源パート専用です(OPM Hパート向けは未対応。PMDMML.MAN §6-5): partKind=${partKind}`);
      events.push({ type: 'ssgToneNoise', line, value: val });
      continue;
    }

    if (c === 'p') {
      // パン設定1。PMDMML.MAN §13-1。`.M`側 0xec(v2 3.2節)。範囲0-3。
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'p' の後にパン数値がありません`);
      i += m[0].length;
      const val = parseInt(m[0], 10);
      if (val < 0 || val > 3) throw new ParseError(line, `'p'(パン)の値が範囲外です(0-3): ${val}`);
      events.push({ type: 'pan', line, value: val });
      continue;
    }

    if (c === 'w') {
      // SSGノイズ周波数。`.M`側 0xee + 1byte(fmdriver_pmd.c:2686 pmd_cmdee_noise_freq
      // 実測: 1byteをそのままssg_noise_freqへload。YM2149ノイズ周波数レジスタ(0x06)は
      // 5bit幅なので範囲0-31とする)。2026-08-19、WebNP2+FreeDOS上の実機MC.EXE ver4.8sを
      // PWL.MMLで実測して確定(tools/pmd-reference/追加分参照): `G o4 l4 w6 c` →
      // パートG先頭が `ee 06`。SSG音源パート向けとして実装する(大文字'P'と同様、
      // OPMのHパート向け用法は未対応のまま)。
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'w' の後にノイズ周波数数値がありません`);
      i += m[0].length;
      const val = parseInt(m[0], 10);
      if (val < 0 || val > 31) throw new ParseError(line, `'w'(ノイズ周波数)の値が範囲外です(0-31): ${val}`);
      if (partKind !== 'ssg') throw new ParseError(line, `'w'(ノイズ周波数)はSSG音源パート専用です(OPM Hパート向けは未対応): partKind=${partKind}`);
      events.push({ type: 'ssgNoiseFreq', line, value: val });
      continue;
    }

    if (c === '*') {
      // ソフトウエアLFOスイッチ。PMDMML.MAN §9-3。`.M`側 0xf1(v2 3.7節)。範囲0-7。
      // *A/*B(対象明示)は今回範囲外(v2 4章の実装順どおり基本形のみ)。
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'*' の後にLFOスイッチ数値がありません`);
      i += m[0].length;
      const val = parseInt(m[0], 10);
      if (val < 0 || val > 7) throw new ParseError(line, `'*'(LFOスイッチ)の値が範囲外です(0-7): ${val}`);
      events.push({ type: 'lfoSwitch', line, value: val });
      continue;
    }

    if (c === 'M') {
      // ソフトウエアLFO本体。PMDMML.MAN §9-1。`.M`側 0xf2(LFO1)/0xbf(LFO2)は常に
      // 4byte固定(v2 3.6節)。MA/MBでLFO1/LFO2を明示できる(§9-1)。
      // 「delayのみ」省略形(v2 3.6節「未解明」→今回マニュアル実測で解決): §9-1に
      // 「delayのみ単独で指定すると、現在のdelay値のみ変更します」と明記されている。
      // 0xf2/0xbfは常に4byte書く必要があるため、コンパイラ側でspeed/depthA/depthBの
      // 直前値を保持し、delayだけ差し替えて4byte全部を再送出する(state.lfoParams)。
      i++;
      let lfoNum = 1;
      if (body[i] === 'X') {
        // ソフトウエアLFO速度設定(テンポ非依存化)。PMDMML.MAN §9-5。MX/MXA/MXB。
        // `.M`側 MXA=0xca / MXB=0xbb + 1byte(値0-1)。MXはMXAと同等(マニュアル
        // 「MX は MXA と同等です」、実測でも同一バイト列0xca 0x01を確認)。
        // #LFOSpeed Extend(§2-17)の実体そのもの(実測: PMDLFOXT.MML、A〜J全パートの
        // 頭で ca 01 bb 01 の4byteとして確認、docs/pmd-compiler-spec-v2.md参照)。
        i++;
        let target = 'A'; // MX/MXA=LFO1(0xca)、MXB=LFO2(0xbb)
        if (body[i] === 'A') { i++; } else if (body[i] === 'B') { i++; target = 'B'; }
        const m = /^\d+/.exec(body.slice(i));
        if (!m) throw new ParseError(line, `'MX'/'MXA'/'MXB' の後に数値がありません`);
        i += m[0].length;
        const val = parseInt(m[0], 10);
        if (val < 0 || val > 1) throw new ParseError(line, `'MX${target === 'A' ? 'A' : 'B'}'の値が範囲外です(0-1): ${val}`);
        events.push({ type: 'lfoSpeedExtend', line, target, value: val });
        continue;
      }
      if (body[i] === 'P') {
        // MP/MPA/MPB(上昇/下降専用LFO指定、コマンド名は"MP"+"A"/"B"の順)。
        // PMDMML.MAN §9-6。実データ(実測)で
        // 発見: 「M書式バリエーション」と見えたエラーの実体はほぼ全てこれだった
        // (通常のM 4値形/delay単独省略形は実データ上0件、MP系のみが未対応だった)。
        // マニュアル記載「実際にはMA(またはMB) 数値2,数値3,数値1,255 とするのと
        // 同じ」+「LFOをONにします」を、参照.M実測(tools/pmd-reference/pmdmp.mml)で
        // 確定: 0xf2/0xbf(delay=数値2省略時0, speed=数値3省略時1, depthA=数値1,
        // depthB=255固定) に続けて 0xf1/0xbe(LFOスイッチ) に固定値1(音程+同期)を
        // 書く2コマンド構成。状態保持(state.lfoParams)はMP自身は使わない
        // (常に3値とも自己完結)が、後続のdelay単独M省略形のために更新はしておく。
        i++;
        if (body[i] === 'A') { i++; } else if (body[i] === 'B') { i++; lfoNum = 2; }
        const m = /^([+-]?\d+)(?:\s*,\s*(\d+))?(?:\s*,\s*(\d+))?/.exec(body.slice(i));
        if (!m) throw new ParseError(line, `'MP'/'MPA'/'MPB' の後に±数値1がありません(PMDMML.MAN §9-6)`);
        i += m[0].length;
        const depthARaw = parseInt(m[1], 10);
        const delay = m[2] != null ? parseInt(m[2], 10) : 0;
        const speed = m[3] != null ? parseInt(m[3], 10) : 1;
        const depthB = 255;
        // PMDMML.MAN §9-6は数値1(depth)を「-128~127」と説明する(実測: wikiwiki.jp
        // thtools「PMD version4.8 コマンドマニュアル_3」§9-6)。一方、実データ
        // (MULE_op_loop.MML:70/71/80等)には`MP-230`のようにこの範囲を超える値が
        // あり、提供元は8曲全てをPMD98 ver4.8l実機で確認済みと明記している。
        // upstream/98fmplayer(fmdriver/fmdriver_pmd.c、pmd_lfo_tick_waveform、
        // 約515行目)を見ると、`.M`側のdepthは常に1byte(u8s8変換)としてしか
        // 読まれておらず、16bit格納の余地は無い(「16bitかもしれない」という
        // 仮説は棄却)。つまりMC.EXEは数値1をここで範囲チェックせず、Cの
        // signed charへの代入と同じ2の補数切り捨てで1byteへ書き出していると
        // 考えるのが両資料と矛盾しない唯一の説明。ここでも同じ切り捨て
        // (mod 256を-128~127へ正規化)を行う。切り捨て後は常に1byteに収まる
        // ため、範囲チェックは不要(下のsignedByte()呼び出しに委ねる)。
        let depthA = ((depthARaw % 256) + 256) % 256;
        if (depthA > 127) depthA -= 256;
        if (delay < 0 || delay > 255) throw new ParseError(line, `'MP'系の数値2(delay)が範囲外です(0-255): ${delay}`);
        if (speed < 0 || speed > 255) throw new ParseError(line, `'MP'系の数値3(speed)が範囲外です(0-255): ${speed}`);
        events.push({ type: 'lfoBody', line, lfo: lfoNum, delay, speed, depthA, depthB });
        events.push({ type: 'lfoSwitch', line, lfo: lfoNum, value: 1 });
        if (lfoNum === 1) state.lfoParams = { speed, depthA, depthB };
        continue;
      }
      if (body[i] === 'A') { i++; } else if (body[i] === 'B') { i++; lfoNum = 2; }

      const full = /^(\d+)\s*,\s*(\d+)\s*,\s*(-?\d+)\s*,\s*(\d+)/.exec(body.slice(i));
      let delay, speed, depthA, depthB;
      if (full) {
        i += full[0].length;
        delay = parseInt(full[1], 10);
        speed = parseInt(full[2], 10);
        depthA = parseInt(full[3], 10);
        depthB = parseInt(full[4], 10);
        if (lfoNum === 1) state.lfoParams = { speed, depthA, depthB };
      } else {
        const delayOnly = /^\d+/.exec(body.slice(i));
        if (!delayOnly) {
          throw new ParseError(line, `'M'/'MA'/'MB' の書式が不正です(delay,speed,depthA,depthBの4値、delay単独の省略形、またはMP系(§9-6)のいずれかが必要)`);
        }
        i += delayOnly[0].length;
        delay = parseInt(delayOnly[0], 10);
        if (!state.lfoParams) {
          throw new ParseError(line, `'M'をdelay単独で指定していますが、このパートでそれ以前にspeed/depthA/depthBを指定する'M'がありません(PMDMML.MAN §9-1)`);
        }
        ({ speed, depthA, depthB } = state.lfoParams);
      }
      if (delay < 0 || delay > 255) throw new ParseError(line, `'M'のdelayが範囲外です(0-255): ${delay}`);
      if (speed < 0 || speed > 255) throw new ParseError(line, `'M'のspeedが範囲外です(0-255): ${speed}`);
      if (depthA < -128 || depthA > 127) throw new ParseError(line, `'M'のdepthAが範囲外です(-128〜127): ${depthA}`);
      if (depthB < 0 || depthB > 255) throw new ParseError(line, `'M'のdepthBが範囲外です(0-255): ${depthB}`);
      // delay単独省略形(上のelse分岐)は、参照.M実測(tools/pmd-reference/pmdlfo.mml、
      // `M5`が`c2 05`の2byteで出ることを確認)により、4byte全部の再送出ではなく専用の
      // 短縮コマンドを使うと判明: LFO1=0xc2(`pmd_cmdc2_lfo_delay`、upstream/98fmplayer/
      // fmdriver/fmdriver_pmd.c:3652)、LFO2=0xb9(`pmd_cmdb9_lfo2_delay`、同ファイルの
      // コマンドテーブルでc2の7つ後=0xc2-7=0xbb…ではなく実際はテーブル順走査で0xb9、
      // 4380行目付近)。short=trueのとき出力側(sizeOfEvent/emitEvent)は2byte
      // (opcode+delay)だけを書く。
      events.push({ type: 'lfoBody', line, lfo: lfoNum, delay, speed, depthA, depthB, short: !full });
      continue;
    }

    if (c === 'q') {
      // 音の切り方の指定2。PMDMML.MAN §4-13。数値2→0xb1(gate_rand_range)、
      // 数値3→0xb3(gate_min)は既に確定済み(v2 3.3節)。数値1(固定カット量)は
      // 今回、参照.M実測(tools/pmd-reference/pmdq1b.mml)で確定: 0xfe
      // (`pmd_cmdfe_gate_abs`)へ数値1をそのまま1byteで書くだけ(Q(大文字)との
      // 合成は無い。Q自体は本コンパイラ未実装のまま)。バイト列上の並びは
      // 実測で 0xfe(数値1) → 0xb1(数値2) → 0xb3(数値3) の順だったため、
      // pushもこの順で行う。
      i++;
      const m1 = /^\d+/.exec(body.slice(i));
      let num1 = null;
      if (m1) {
        i += m1[0].length;
        num1 = parseInt(m1[0], 10);
        if (num1 < 0 || num1 > 255) throw new ParseError(line, `'q'の数値1が範囲外です(0-255。0xfe): ${num1}`);
      }
      let num2 = null;
      if (body[i] === '-') {
        i++;
        const m2 = /^\d+/.exec(body.slice(i));
        if (!m2) throw new ParseError(line, `'q-' の後に数値2がありません`);
        i += m2[0].length;
        num2 = parseInt(m2[0], 10);
        if (num2 < 0 || num2 > 127) throw new ParseError(line, `'q'の数値2が範囲外です(0-127。0xb1下位7bit): ${num2}`);
      }
      let num3 = null;
      if (body[i] === ',') {
        i++;
        const m3 = /^\d+/.exec(body.slice(i));
        if (!m3) throw new ParseError(line, `'q,' の後に数値3がありません`);
        i += m3[0].length;
        num3 = parseInt(m3[0], 10);
        if (num3 < 0 || num3 > 255) throw new ParseError(line, `'q'の数値3が範囲外です(0-255): ${num3}`);
      }
      if (num1 == null && num2 == null && num3 == null) {
        throw new ParseError(line, `'q'の書式が不正です(数値1・数値2('-n')・数値3(',n')の少なくとも一つが必要)`);
      }
      if (num1 != null) {
        events.push({ type: 'gateAbs', line, value: num1 });
        state.qNum1 = num1; // 数値1は省略時に前の値を保留(PMDMML.MAN §4-13)
      }
      if (num2 != null) {
        // 今回の実測(tools/pmd-reference/pmdq1b.mml、q50-30,15 と q30-90,2の2ケース、
        // どちらも数値1を明示)で判明: 数値1が明示されているとき、0xb1の下位7bitは
        // 数値2そのものではなく |数値1(保留値含む)-数値2| の差分で、bit7は固定ではなく
        // 符号で決まる: 数値2<数値1(=50,30)は0x94=0x80|20(bit7=1)、数値2>数値1
        // (=30,90)は0x3c=0|60(bit7=0)と、2方向とも実測して確認した。
        // 数値1が一度も明示されていない場合(既存corpus pmdgate.mmlの`q-10,5`/`q-20`)は
        // 参照.M側で毎回`fe 01`(gateAbs=1)が先行し、0xb1の値も上と同じ式
        // |heldNum1-数値2|(heldNum1=1固定、符号も同じ規則)で説明できることが判明
        // (pmdgate.mml実測: `q-10,5`→`fe 01 b1 09`(=|1-10|、num2>1でbit7=0)、
        // `q-20`→`fe 01 b1 13`(=|1-20|、bit7=0)の2点とも一致)。つまりMC.EXEは
        // 数値1省略時、その場でだけ暗黙のbaseline=1を仮定してgate_absを一時的に
        // 1へ上書きし(この上書きはstate.qNum1には反映されない=毎回re-emitされる。
        // 2件目のq-20でも`fe 01`が再度現れるのはそのため)、数値2との差分を明示形と
        // 同じ式で計算していると考えるのが両実測点と整合する唯一の説明。
        // state.qNum1(実際にこのパートでユーザーが明示したq数値1)は変更しない。
        let value;
        if (state.qNum1 != null) {
          const heldNum1 = state.qNum1;
          const range = Math.abs(heldNum1 - num2);
          if (range > 127) throw new ParseError(line, `'q'の数値1と数値2の差が範囲外です(127以内。0xb1下位7bit): |${heldNum1}-${num2}|=${range}`);
          value = (num2 < heldNum1 ? 0x80 : 0x00) | range;
        } else {
          const heldNum1 = 1; // MC.EXE実測(pmdgate.mml)によるbaseline
          events.push({ type: 'gateAbs', line, value: heldNum1 });
          const range = Math.abs(heldNum1 - num2);
          if (range > 127) throw new ParseError(line, `'q'の数値1(baseline=1)と数値2の差が範囲外です(127以内。0xb1下位7bit): |1-${num2}|=${range}`);
          value = (num2 < heldNum1 ? 0x80 : 0x00) | range;
        }
        events.push({ type: 'gateRandRange', line, value });
      }
      if (num3 != null) {
        events.push({ type: 'gateMin', line, value: num3 });
      }
      continue;
    }

    if (c === '(' || c === ')') {
      // 音量相対変化、基本形のみ。PMDMML.MAN §5-5。`.M`側 0xe3(')' 加算)/0xe2('(' 減算)
      // (v2 3.1節)。`^`(アクセント)は未解明のため今回は非対応のまま。
      const isAdd = c === ')';
      i++;
      const { value: val, isDefault } = readVolRelArg();
      events.push({ type: isAdd ? 'volInc' : 'volDec', line, value: val, isDefault });
      continue;
    }

    if (c === '{') {
      // ポルタメント指定。PMDMML.MAN §4-3。`.M`側 0xda(v2 3.5節「未解明」→今回
      // fmdriver_pmd.c:3083-3121精読で解決): 引数3byte固定 = note1(1byte,通常の音符
      // バイトと同一形式) / note2(1byte,同형式) / clocks(1byte、音長1のクロック値)。
      // 音長2(ディレイ)は`.M`側に専用フィールドが無く、PMDMML.MAN §4-3の例2
      // 「{cg}4,8 は c8&{cg}8 と同様」の通り、コンパイル時に「note1のピッチをclocks2
      // クロック分だけ発音してtieで繋ぎ、残り(clocks1-clocks2)クロックでポルタメント」
      // という3命令(note+tie+portamento)へ展開する。
      i++;
      const [note1, note2] = readBraceNotes();
      if (body[i] !== '}') {
        throw new ParseError(line, `'{' に対応する '}' がありません(内部は c/d/e/f/g/a/b/o/</> のみ許可、PMDMML.MAN §4-3)`);
      }
      i++;
      const clocks1 = readLengthSpec();
      let clocks2 = null;
      if (body[i] === ',') {
        i++;
        clocks2 = readLengthSpec();
      }
      if (clocks1 < 1 || clocks1 > 255) throw new ParseError(line, `'{}' の音長1がクロック1byteに収まりません: ${clocks1}`);
      if (clocks2 != null) {
        if (clocks2 < 1 || clocks2 > 255) throw new ParseError(line, `'{}' の音長2がクロック1byteに収まりません: ${clocks2}`);
        const glide = clocks1 - clocks2;
        if (glide < 1) {
          throw new ParseError(line, `'{}' の音長2は音長1より短い値である必要があります(PMDMML.MAN §4-3): 音長1=${clocks1}, 音長2=${clocks2}`);
        }
        events.push({ type: 'note', line, octave: note1.octave, noteIndex: note1.noteIndex, clocks: clocks2 });
        events.push({ type: 'tie', line });
        events.push({ type: 'portamento', line, note1, note2, clocks: glide });
      } else {
        events.push({ type: 'portamento', line, note1, note2, clocks: clocks1 });
      }
      continue;
    }

    if (c === '_') {
      // 転調指定。PMDMML.MAN §4-14。`.M`側: 絶対値`_`=0xf5(pmd_cmdf5_transpose,
      // fmdriver_pmd.c:2516-2523)/相対値`__`=0xe7(pmd_cmde7_transpose_rel, :2864-2871)、
      // いずれも1byte符号付き引数(コード・マニュアルの-128〜127レンジが一致)。
      // マニュアルの書式は符号必須(`_ +数値`/`_ -数値`)だが、実データには符号無しの
      // `_0`のような表記があるため、符号省略時は正数として寛容に受理する。
      i++;
      let relative = false;
      if (body[i] === '_') { relative = true; i++; }
      const m = /^([+-]?)(\d+)/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'${relative ? '__' : '_'}' の後に転調数値がありません`);
      i += m[0].length;
      let val = parseInt(m[2], 10);
      if (m[1] === '-') val = -val;
      if (val < -128 || val > 127) {
        throw new ParseError(line, `'${relative ? '__' : '_'}'(転調)の値が範囲外です(-128〜127): ${val}`);
      }
      events.push({ type: relative ? 'transposeRel' : 'transposeAbs', line, value: val });
      continue;
    }

    throw new ParseError(line, `未対応の文字です: '${c}'（v1範囲外、またはPMD_PART_FM_1-6以外のパート機能の可能性）`);
  }
}

// Kパート本体(リズムパターン演奏順、PMDMML.MAN §1-2-1/§1-2-2、doc v2 1.3節)。
// 通常のFM/SSGパートとは全く別の語彙: Rパターン選択(`R数値`。cmd<0x80制約により0-127)、
// ループ([ ] :)、全体ループ(L)、`\`系リズム直接コマンドのみを受理する。
// Rの直後は「休符」ではなく「パターン番号」を意味する点が通常パートと異なる
// (通常パートの'r'/'R'=休符とは名前空間が別、doc 1.3節「cmdの値がそのままRパターン番号」)。
// Kパートは実データ上、他パート文字と同じ行に頻繁に混在する
// (`ABCDEFGHIKJ C192 o4 l8`のように)。'C'(全音符長、全パート共通のグローバル設定)・
// 'o'/'<'/'>'(オクターブ)・'l'(デフォルト音長)は、K自体には音符が無く意味を持たない
// (どのみち出力バイトも無い)ため、構文としては受理してそのまま読み飛ばす
// (エラーにすると「他パートのための設定をKと同じ行に書けない」という実データに
// 合わない制約になってしまう)。'C'だけは全パート共通のglobalStateを更新する
// 必要があるため例外的に処理する(他パートと同じ、0xdfイベントもKのトラックへ積む。
// PMDMML.MAN §4-11の「いずれかのパートの頭に設定すれば、すべてのパートに有効」を
// 素直に読むと、指定した行の全パートの出力に同じ0xdfが載る)。
function tokenizeRhythmKBody(body, line, events, globalState, state, onPatternRef) {
  let i = 0;
  const n = body.length;
  while (i < n) {
    const c = body[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/') {
      // コンパイル打ち切り。PMDMML.MAN §16-4([音源]にR選択/R定義も含まれる)。
      // 通常パート(tokenizeBody)側と同じ扱い: state.terminatedを立てて即座に戻り、
      // 呼び出し元(parseMml)が以降の行のKパート処理をスキップする。
      state.terminated = true;
      return;
    }
    if (c === '\\') { i = parseBackslashCommand(body, i, line, events); continue; }
    if (c === 'C') {
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'C' の後に全音符長の数値がありません`);
      i += m[0].length;
      const val = parseInt(m[0], 10);
      if (val < 1 || val > 255) throw new ParseError(line, `'C'(全音符長)の値が範囲外です(1-255): ${val}`);
      globalState.measLen = val;
      // 注: Kパート内の`C`はglobalState.gInjectMeasLenを更新しない(実測pmdrr96/
      // pmdrr192(C192、既定値96と異なる非既定値!)でもパートGが空トラックのまま
      // だったため。パートGへの注入(FINDINGS.md 14番)は通常パート(A-J、
      // tokenizeBody)側の`C`のみが起点になる)。
      events.push({ type: 'measLen', line, value: val });
      continue;
    }
    if (c === 'o' || c === 'O') {
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'o' の後にオクターブ数値がありません`);
      i += m[0].length;
      continue; // Kには音符が無いため読み捨てる(出力バイトも無い)
    }
    if (c === '<' || c === '>') { i++; continue; }
    if (c === 'l') {
      // Kパート自身に音符は無く出力バイトも無いが、内部のデフォルト音長状態
      // (state.defaultLengthSpec)は実際に更新する必要がある。2026-08-19、MC.EXE実測
      // (PRRL8.MML: `R0 \h r \b r` + `K C96 l8 R0`)で判明: Rパターン内の無指定`r`の
      // 休符長は、Rパターン自身のl指定(あればそちらが優先)が無ければ**参照元Kの
      // その時点のデフォルト音長を継承する**(下のR選択時ensurePatternCompiledへの
      // 呼び出し参照)。読み捨てたままだとこの継承ができないため、以前の「Kには
      // デフォルト音長の概念が無い」という判断を撤回し、実際に更新する。
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'l' の後に音長数値がありません`);
      i += m[0].length;
      const lenN = parseInt(m[0], 10);
      numericLengthToClocks(lenN, line, globalState.measLen); // 妥当性検証のみ
      let dots = 0;
      while (body[i] === '.') { dots++; i++; }
      state.defaultLengthSpec = { n: lenN, dots };
      continue;
    }
    // 'v'(大雑把な音量)・'V'(細かい音量)・'q'(ゲート)・'_'/'__'(転調)も、実データでは
    // 「ABCDEFGHIJKab l12 o4 !H v14 q1 l16」のようにKと同じ行へ頻繁に混在する
    // (`!H`変数展開の中身に`_`が含まれるケースも実測)。
    // 当初は「Kには対応する出力先が無い」と判断し構文だけ消費して捨てていたが、
    // 実データDS4_MAIA.mmlの参照.M実測で誤りと判明: 単独K行(`K !H T175 ... v14 q0 ...`
    // ではなく`ABCDEFGHIJK !H T175 o5 v14 q0 l8`、Kも含む複数パート指定行)のKトラックにも
    // `f5 00`(transposeAbs 0)・`fd 0e`(volAbs 14)・`fe 00`(gateAbs 0)がそのまま出力されて
    // おり、参照.Mの全体長差(328-322=6byte)ともちょうど一致した。つまり黙って捨てていたのは
    // 複数パート指定行のK分配自体ではなく、このtokenizeRhythmKBody内部の意図的な読み捨てが
    // 原因(パート分配ロジック自体は元から複数パート指定行のKへ正しく本文を渡していた)。
    // 他パート(tokenizeBody)と同じイベント種別(volAbs/gateAbs/transposeAbs/transposeRel)を
    // 積むよう変更する。ただしvolAbsの数値変換は実データで検証済みの範囲のみ反映する:
    // v14→fd 0e(=14そのまま、SSGパートと同じ無変換)であり、FM用のV_LOWERCASE_FM_TABLE
    // (v14→122相当)を適用すると参照と一致しないため、Kでは常に無変換(raw)で積む。
    if (c === 'V') {
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'V' の後に音量数値がありません`);
      i += m[0].length;
      const val = parseInt(m[0], 10);
      if (val < 0 || val > 255) throw new ParseError(line, `'V' の値が範囲外です(Kパートは0-255): ${val}`);
      events.push({ type: 'volAbs', line, value: val });
      continue;
    }
    if (c === 'v') {
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'v' の後に音量数値がありません`);
      i += m[0].length;
      const val = parseInt(m[0], 10);
      // 'v'(大雑把な音量)は本来FM/SSG等で変換テーブルを介するが、Kパートでは実データ
      // (v14→fd 0e)実測により無変換と確認済み。範囲は他パートの'V'と同じ0-255までは
      // 実測できていないため、既存'v'の最大値(16)を踏襲して保守的に制限する。
      if (val < 0 || val > 16) throw new ParseError(line, `'v' の値が範囲外です(Kパートは0-16): ${val}`);
      events.push({ type: 'volAbs', line, value: val });
      continue;
    }
    if (c === 'q') {
      i++;
      const m1 = /^\d+/.exec(body.slice(i));
      let num1 = null;
      if (m1) {
        i += m1[0].length;
        num1 = parseInt(m1[0], 10);
        if (num1 < 0 || num1 > 255) throw new ParseError(line, `'q'の数値1が範囲外です(0-255。0xfe): ${num1}`);
      }
      let num2 = null;
      if (body[i] === '-') {
        i++;
        const m2 = /^\d+/.exec(body.slice(i));
        if (!m2) throw new ParseError(line, `'q-' の後に数値2がありません`);
        i += m2[0].length;
        num2 = parseInt(m2[0], 10);
        if (num2 < 0 || num2 > 127) throw new ParseError(line, `'q'の数値2が範囲外です(0-127。0xb1下位7bit): ${num2}`);
      }
      let num3 = null;
      if (body[i] === ',') {
        i++;
        const m3 = /^\d+/.exec(body.slice(i));
        if (!m3) throw new ParseError(line, `'q,' の後に数値3がありません`);
        i += m3[0].length;
        num3 = parseInt(m3[0], 10);
        if (num3 < 0 || num3 > 255) throw new ParseError(line, `'q'の数値3が範囲外です(0-255): ${num3}`);
      }
      if (num1 == null && num2 == null && num3 == null) {
        throw new ParseError(line, `'q'の書式が不正です(数値1・数値2('-n')・数値3(',n')の少なくとも一つが必要)`);
      }
      // 数値2(gateRandRange)の差分計算はtokenizeBody側の'q'実装(PMDMML.MAN §4-13、
      // 参照.M実測)と同じロジックを踏襲する。Kパート単独の実データでは数値1のみ
      // (q0)しか確認できていないため、数値2/数値3の経路は他パートと同一という
      // 前提(共通コマンド0xb1/0xb3のはず)で実装するが、実測未確認のまま。
      if (num1 != null) {
        events.push({ type: 'gateAbs', line, value: num1 });
        state.qNum1 = num1;
      }
      if (num2 != null) {
        // 数値1が一度も明示されていない場合の`fe 01`(baseline=1)扱いは
        // tokenizeBody側の'q'実装(pmdgate.mml実測)と同一ロジックを踏襲する。
        let value;
        if (state.qNum1 != null) {
          const heldNum1 = state.qNum1;
          const range = Math.abs(heldNum1 - num2);
          if (range > 127) throw new ParseError(line, `'q'の数値1と数値2の差が範囲外です(127以内。0xb1下位7bit): |${heldNum1}-${num2}|=${range}`);
          value = (num2 < heldNum1 ? 0x80 : 0x00) | range;
        } else {
          const heldNum1 = 1;
          events.push({ type: 'gateAbs', line, value: heldNum1 });
          const range = Math.abs(heldNum1 - num2);
          if (range > 127) throw new ParseError(line, `'q'の数値1(baseline=1)と数値2の差が範囲外です(127以内。0xb1下位7bit): |1-${num2}|=${range}`);
          value = (num2 < heldNum1 ? 0x80 : 0x00) | range;
        }
        events.push({ type: 'gateRandRange', line, value });
      }
      if (num3 != null) {
        events.push({ type: 'gateMin', line, value: num3 });
      }
      continue;
    }
    if (c === '_') {
      i++;
      let relative = false;
      if (body[i] === '_') { relative = true; i++; }
      const m = /^([+-]?)(\d+)/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'${relative ? '__' : '_'}' の後に転調数値がありません`);
      i += m[0].length;
      let val = parseInt(m[2], 10);
      if (m[1] === '-') val = -val;
      if (val < -128 || val > 127) {
        throw new ParseError(line, `'${relative ? '__' : '_'}'(転調)の値が範囲外です(-128〜127): ${val}`);
      }
      events.push({ type: relative ? 'transposeRel' : 'transposeAbs', line, value: val });
      continue;
    }
    if (c === 'R') {
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'R' の後にRパターン番号がありません(Kパート、PMDMML.MAN §6-7)`);
      i += m[0].length;
      const num = parseInt(m[0], 10);
      // [範囲]の記載は0-255だが、`.M`側の読み出し経路(cmd<0x80のときのみパターン索引として
      // 解釈される、fmdriver_pmd.c:1748)により実際に到達できるのは0-127のみ
      // (docs/pmd-compiler-spec-v2.md 1.3節、マニュアルとの食い違いとして記録済み)。
      if (num < 0 || num > 127) throw new ParseError(line, `Kパートの'R'パターン番号は0-127です(cmd&0x80分岐の制約でこの範囲のみ到達可能。docs/pmd-compiler-spec-v2.md 1.3節): ${num}`);
      // Rパターン本体は参照される時点で初めてコンパイルされる(遅延コンパイル)。
      // 継承させるデフォルト音長は「今このKストリームで有効なdefaultLengthSpec」
      // (直前の'l'反映後の比率+付点。'l'が一度も書かれていなければ既定のl4相当
      // {n:4,dots:0})。2026-08-19 MC.EXE実測(PRRL8/PRRL8B.MML)で確定。この比率は
      // resolveDefaultLengthClocksで参照時点の`C`(全音符長)から都度クロック値へ
      // 変換されるため、生成時に固定クロック値を焼き込んで古い`C`を引きずる
      // (PRR192.MML実測: `K C192 R0`(l指定なし)でも参照先の休符が48クロックになる
      // べきところ、96クロック時代の既定値24を使い回してしまう)心配が無い。
      if (onPatternRef) onPatternRef(num, state.defaultLengthSpec, line);
      events.push({ type: 'rhSelect', line, pattern: num });
      continue;
    }
    if (c === '[') { i++; events.push({ type: 'loopOpen', line }); continue; }
    if (c === ']') {
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `']' の後にループ回数(n)が必要です`);
      i += m[0].length;
      const count = parseInt(m[0], 10);
      if (count < 0 || count > 255) throw new ParseError(line, `ループ回数が1byteに収まりません: ${count}`);
      events.push({ type: 'loopClose', line, count });
      continue;
    }
    if (c === ':') { i++; events.push({ type: 'loopExit', line }); continue; }
    if (c === 'L') { i++; events.push({ type: 'globalLoop', line }); continue; }
    if (c === 'T' || c === 't') {
      // テンポ(絶対値0xfc/相対値も同じ0xfc、tokenizeBody側と同じ書式)。
      // Kパート(リズム)もfmdriver_pmd.cのコマンド分岐テーブルを共有しており、
      // pmd_cmd_table_rhythm(upstream/98fmplayer/fmdriver/fmdriver_pmd.c:4473-4477)の
      // cmd=0xfc(テーブルindex 3、`cmd^0xff`)には他パート表(pmd_cmd_table_fm/ssg/adpcm)
      // と同じ pmd_cmdfc_tempo が割り当てられている(null関数ではない)ため、
      // テンポコマンドはKパートでも実際に機能する「共通コマンド」であると確認できる
      // (v/V/q等、同テーブルでpmd_cmd_nullになっているものとは異なり、テンポは
      // Kパートのトラックに出力しても実際にテンポを変更する)。よってo/l/Cと違い
      // 読み捨てず、他パートと同じtempoAbs/tempoRelイベントを積む。
      const isTimerB = c === 'T';
      i++;
      if (body[i] === '+' || body[i] === '-') {
        const sign = body[i] === '-' ? -1 : 1;
        i++;
        const m = /^\d+/.exec(body.slice(i));
        if (!m) throw new ParseError(line, `'${c}${sign < 0 ? '-' : '+'}' の後に数値がありません`);
        i += m[0].length;
        const delta = sign * parseInt(m[0], 10);
        if (delta < -128 || delta > 127) throw new ParseError(line, `テンポ相対値が1byte符号付きに収まりません: ${delta}`);
        events.push({ type: 'tempoRel', line, isTimerB, delta });
        continue;
      }
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'${c}' の後に数値がありません`);
      i += m[0].length;
      const val = parseInt(m[0], 10);
      if (isTimerB) {
        if (val < 0 || val > 250) throw new ParseError(line, `TimerB絶対値(T)は0-250です: ${val}`);
      } else {
        if (val < 0 || val > 255) throw new ParseError(line, `テンポ絶対値(t)は0-255です: ${val}`);
      }
      events.push({ type: 'tempoAbs', line, isTimerB, val });
      continue;
    }
    throw new ParseError(line, `Kパートで未対応の文字です: '${c}'（Rパターン選択(R数値)・ループ([ ] :)・全体ループ(L)・テンポ(T/t)・\\系コマンドのみ対応）`);
  }
}

// Rパターン本体(PMDMML.MAN §1-2-1/§1-2-2)。実データ3曲は全て`\`系直接コマンド
// (§14)のみで構成されており、`@音色番号`によるPMD内蔵SSGドラムのマスク指定方式
// (§6-1-3、通常の音符文字を使う)は実データに出現しなかったため今回は未実装のまま
// (docs/pmd-compiler-spec-v2.md 1.3節「実装上の優先度としては下がる」)。
// 対応: 休符(r/R)・デフォルト音長(l)・ループ([ ] :)・`\`系コマンド。
// 音符文字(c/d/e/f/g/a/b)・`@`は専用エラーで止める(黙って無視しない)。
function tokenizeRhythmPatternBody(body, line, state, events, globalState) {
  let i = 0;
  const n = body.length;

  function readLengthSpec() {
    // PMDMML.MAN §1-3(上のtokenizeBody内readLengthSpecと同じ根拠): コマンド名
    // (r/R等)と音長数値の間の空白(space/tab)を許容する。
    while (body[i] === ' ' || body[i] === '\t') i++;
    if (body[i] === '%') {
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'%' の後に数値がありません`);
      i += m[0].length;
      return parseInt(m[0], 10);
    }
    const m = /^\d+/.exec(body.slice(i));
    let clocks;
    if (m) {
      i += m[0].length;
      clocks = numericLengthToClocks(parseInt(m[0], 10), line, globalState.measLen);
    } else {
      clocks = resolveDefaultLengthClocks(state.defaultLengthSpec, globalState, line);
    }
    let dots = 0;
    while (body[i] === '.') { dots++; i++; }
    return dots > 0 ? applyDots(clocks, dots, line) : clocks;
  }

  while (i < n) {
    const c = body[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '\\') { i = parseBackslashCommand(body, i, line, events); continue; }
    if (c === 'r' || c === 'R') {
      i++;
      const clocks = readLengthSpec();
      if (clocks < 1 || clocks > 255) throw new ParseError(line, `音長クロック値が1byteに収まりません: ${clocks}`);
      events.push({ type: 'rest', line, octave: 0, clocks });
      continue;
    }
    if (c === 'l') {
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'l' の後に音長数値がありません`);
      i += m[0].length;
      const lenN = parseInt(m[0], 10);
      numericLengthToClocks(lenN, line, globalState.measLen); // 妥当性検証のみ
      let dots = 0;
      while (body[i] === '.') { dots++; i++; }
      state.defaultLengthSpec = { n: lenN, dots };
      continue;
    }
    if (c === '[') { i++; events.push({ type: 'loopOpen', line }); continue; }
    if (c === ']') {
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `']' の後にループ回数(n)が必要です`);
      i += m[0].length;
      const count = parseInt(m[0], 10);
      if (count < 0 || count > 255) throw new ParseError(line, `ループ回数が1byteに収まりません: ${count}`);
      events.push({ type: 'loopClose', line, count });
      continue;
    }
    if (c === ':') { i++; events.push({ type: 'loopExit', line }); continue; }
    throw new ParseError(line, `Rパターン本体で未対応の文字です: '${c}'（休符(r)・デフォルト音長(l)・ループ([ ] :)・\\系コマンドのみ対応。@音色番号によるマスク指定パターン(PMDMML.MAN §6-1-3)は実データに出現しなかったため未実装）`);
  }
}

// 構造(ループの対応関係)を検査してリンクを張る。
// 2026-08-18: 当初「ネストは v1 非対応」として `[` の多重オープンを拒否していたが、
// 実データ(YD、K対応で新たに露出)にネストしたループ([ [ ... ]n ]m 形)が実在すると判明。
// WebNP2+MC.EXE ver4.8sで`;Title NestLoopProbe\nA o4 [ c8 [ d8 e8 ]3 f8 ]2 g8`を実測コンパイルし
// (scratchpad配下、リポジトリ非同梱)、エラー無く98byteの.Mが生成され、外側/内側それぞれの
// `[`/`]`が独立した0xf9(loopOpen)/0xf8(loopClose)ペアとして出力されることを確認した
// (本家がネストを許容している実測根拠)。`.M`側のループ命令(0xf9/0xf8/0xf7、下のemitEvent)は
// 各イベントが自分の対になるイベントへの直接ポインタを持つ設計(グローバルな深さカウンタでは
// ない)なので、この下のスタックによる対応付け自体は元から入れ子に対応できる構造だった
// (単純に「2重目のopenを拒否する」ガードだけが不要に制限をかけていた)。ガードを外し、
// 通常のLIFOスタックで対応付ける(`:` のloopExitは「その時点で最も内側のopenで囲まれている
// ループ」に対応するべきなので、stack最上段を参照するのは元から正しい)。
function linkLoops(events, partLetter) {
  const stack = [];
  for (const ev of events) {
    if (ev.type === 'loopOpen') {
      stack.push(ev);
    } else if (ev.type === 'loopExit') {
      if (stack.length === 0) {
        throw new ParseError(ev.line, `パート${partLetter}: 対応する '[' が無い ':' があります`);
      }
      ev.openRef = stack[stack.length - 1];
      ev.openRef.hasExit = true;
    } else if (ev.type === 'loopClose') {
      if (stack.length === 0) {
        throw new ParseError(ev.line, `パート${partLetter}: 対応する '[' が無い ']' があります`);
      }
      const open = stack.pop();
      ev.openRef = open;
      open.closeRef = ev;
      // loopExit は close の存在が確定した時点で closeRef を辿れるようにする
      // (openRef 経由で ev.closeRef を後から参照できるので個別の再走査は不要)
    }
  }
  if (stack.length > 0) {
    throw new ParseError(stack[0].line, `パート${partLetter}: '[' が ']n' で閉じられていません`);
  }
}

// 音色定義ブロックの1行を前処理する(コメント除去・trim・'='以降の音色名部分を捨てる)。
// PMDMML.MAN §3-1「[備考] 任意の位置に、= 音色名 を表記する事が出来る」のうち、
// v1では行末の '=名前' のみサポートする(簡略化。行の途中への埋め込みは非対応)。
function cleanToneLine(raw) {
  let s = raw;
  const commentIdx = s.indexOf(';');
  if (commentIdx >= 0) s = s.slice(0, commentIdx);
  const eqIdx = s.indexOf('=');
  if (eqIdx >= 0) s = s.slice(0, eqIdx);
  return s.trim();
}

function parseIntList(cleaned, line, expectedCount, what) {
  if (cleaned === '') return null;
  const parts = cleaned.split(/[\s,]+/).filter((t) => t.length > 0);
  if (parts.length !== expectedCount) return null;
  const nums = [];
  for (const p of parts) {
    if (!/^-?\d+$/.test(p)) throw new ParseError(line, `${what}の値が数値ではありません: '${p}'`);
    nums.push(parseInt(p, 10));
  }
  return nums;
}

// 音色定義ヘッダ行("@ 音色番号 ALG FB")を解析する。出典: PMDMML.MAN §3-1 [書式1]。
function parseToneHeader(cleaned, line) {
  const body = cleaned.replace(/^@/, '');
  const nums = parseIntList(body.trim(), line, 3, '音色定義ヘッダ(@ 音色番号 ALG FB)');
  if (!nums) {
    throw new ParseError(line, `音色定義ヘッダの書式が不正です(@ 音色番号 ALG FB の3つの数値が必要): "${cleaned}"`);
  }
  const [tonenum, alg, fb] = nums;
  if (tonenum < 0 || tonenum > 255) throw new ParseError(line, `音色番号が範囲外です(0-255): ${tonenum}`);
  if (alg < 0 || alg > 7) throw new ParseError(line, `ALGが範囲外です(0-7。PMDMML.MAN §3-1): ${alg}`);
  if (fb < 0 || fb > 7) throw new ParseError(line, `FBが範囲外です(0-7。PMDMML.MAN §3-1): ${fb}`);
  return { tonenum, alg, fb };
}

// オペレータ1行("AR DR SR RR SL TL KS ML DT AMS"、10個)を解析する。
// 出典: PMDMML.MAN §3-1 [書式1]・[範囲](WebFetchで原文確認、
// https://pigu-a.github.io/pmddocs/pmdmml.htm)。
// DTは仕様上「-3〜3 または 0〜7」の二重表記(§3-1 Rangeテーブル "DT — -3–3 or 0–7"、
// 同節Example 1の実例でも "18 10  0  6  0   0  0  4 -3   0" のように符号付きの生値が
// そのままMML本文に書かれている)。符号→3bit値の変換規則自体はPMDMML.MAN/
// fmdriver_pmd.c(このリポジトリのupstream/98fmplayer/fmdriver/fmdriver_pmd.cは
// .M再生側のみでMC.EXE側のコンパイル規則は含まない)のどちらにも明記が無いが、
// これはPMD固有の取り決めではなくYM2612/YM2608のDT1レジスタ(reg 0x30系bit6-4)
// そのものの符号付きマグニチュード表現であり(独立した外部一次資料で確認:
// https://www.plutiedev.com/ym2612-registers 「highest bit indicates whether to
// increase(0) or decrease(1)...lowest two bits indicate the magnitude」、
// https://jsgroth.dev/blog/posts/emulating-ym2612-part-2/ 同旨)、
// raw 0-3=DT+0..+3、raw 4-7=DT -0..-3(下位2bitが絶対値、bit2が符号)という
// 業界標準のテーブルに従う。よってv2では:
//   入力が0以上ならそのまま生の3bit値として扱う(従来通り、0-7)。
//   入力が負なら 4 | (|value| & 3) に変換する(-1→5, -2→6, -3→7, -4→4, -5→5, -6→6, -7→7)。
// 2026-08-19、WebNP2+FreeDOS上の実機MC.EXE ver4.8sをPDT.MML/PDT2.MMLで実測し、
// -3〜-1だけでなく-4以下(実測は-7まで)も拒否されず、この式で生値が決まることを
// 確認した(tools/pmd-reference/追加分参照)。よって負値側に下限は無い(マスク演算な
// ので上のとおり4値ループする)。正値側は0-7のみ実測済み(未測定の8以上は従来通り
// 拒否する)。
function parseToneOperatorLine(cleaned, line, opIndex) {
  const nums = parseIntList(cleaned, line, 10, `音色定義オペレータ${opIndex + 1}行(AR DR SR RR SL TL KS ML DT AMS)`);
  if (!nums) {
    throw new ParseError(line, `音色定義オペレータ${opIndex + 1}行の書式が不正です(AR DR SR RR SL TL KS ML DT AMSの10個の数値が必要): "${cleaned}"`);
  }
  const [ar, dr, sr, rr, slRaw, tl, ks, ml, dtRaw, ams] = nums;
  const checks = [
    ['AR', ar, 0, 31], ['DR', dr, 0, 31], ['SR', sr, 0, 31], ['RR', rr, 0, 15],
    ['TL', tl, 0, 127], ['KS', ks, 0, 3], ['ML', ml, 0, 15],
    ['AMS', ams, 0, 1],
  ];
  for (const [name, val, lo, hi] of checks) {
    if (val < lo || val > hi) {
      throw new ParseError(line, `音色定義オペレータ${opIndex + 1}行の${name}が範囲外です(${lo}-${hi}): ${val}`);
    }
  }
  // SLが0-15の範囲外(実データで16〜31等が実在する)でも拒否せず、MC.EXEと同じ
  // 4bitマスクを適用する。2026-08-19、WebNP2+FreeDOS上の実機MC.EXE ver4.8sを
  // PSL.MML/PSL2.MMLで実測して確定(tools/pmd-reference/追加分参照):
  // 17→1, 16→0, 31→15, 18→2 (value & 15。15への飽和ではない)。
  const sl = slRaw & 15;
  if (dtRaw > 7) {
    throw new ParseError(line, `音色定義オペレータ${opIndex + 1}行のDTが範囲外です(-3〜3 または 0〜7。PMDMML.MAN §3-1): ${dtRaw}`);
  }
  // 符号付き表記の生値変換。2026-08-19、WebNP2+FreeDOS上の実機MC.EXE ver4.8sを
  // PDT.MML/PDT2.MMLで実測して確定(tools/pmd-reference/追加分参照): -3〜-1の
  // 範囲だけでなく-4以下(-4〜-7)も拒否されず、生値 = 4 | (|n| & 3) になる
  // (-4→4, -5→5, -6→6, -7→7。従来の「4+|n|」は|n|<=3では同じ結果だが|n|>=4では
  // 範囲外化してしまうため、3bitの下位2bitを取り出す式に一般化した)。
  const dt = dtRaw < 0 ? (4 | ((-dtRaw) & 3)) : dtRaw;
  return { ar, dr, sr, rr, sl, tl, ks, ml, dt, ams };
}

// 音色定義ブロック(ヘッダ1行+オペレータ4行+任意のALG/FB再掲5行目)を
// lines[li]から読み進める。
// 戻り値: { tone: {tonenum, ...buildToneEntry用options}, nextLi }
// 空行・コメントのみの行は読み飛ばす(オペレータ4行が揃うまで先読みを続ける)。
export function parseToneDefBlock(lines, li, lineNo) {
  const header = parseToneHeader(cleanToneLine(lines[li]), lineNo);
  const ops = [];
  let cur = li + 1;
  while (ops.length < 4) {
    if (cur >= lines.length) {
      throw new ParseError(lineNo, `音色定義(@${header.tonenum})のオペレータ行が4行そろう前にファイル末尾に到達しました`);
    }
    const curLineNo = cur + 1;
    const cleaned = cleanToneLine(lines[cur]);
    if (cleaned === '') { cur++; continue; }
    ops.push(parseToneOperatorLine(cleaned, curLineNo, ops.length));
    cur++;
  }
  // オペレータ4行の直後に「ALG,FB」形式の2数値のみの行が続く場合、これは
  // ヘッダ行(@ 音色番号 ALG FB)のALG/FBを再掲する任意の5行目とみなして読み飛ばす。
  // 出典: PMDMML.MAN §3-1にはこの5行目の書式は記載が無い(書式1/2/3はいずれも
  // ヘッダ1行+オペレータ行のみ)。実データ(自作コンパイラ対応対象のPMD_MSサンプル、
  // 第三者データにつき本ファイルへの転記はしない)に、この5行目が付く音色定義が
  // 実在することを確認した。
  //
  // 2026-08-18、WebNP2+FreeDOS上の実機 MC.EXE ver4.8s に `/V` オプション付きで
  // 自作の3ケース(ヘッダ@1 5 3+5行目"2,1"／ヘッダ@1 2 1+5行目"5,3"／5行目無しの
  // 対照)を食わせて実測: 3ケースとも出力の音色エントリ末尾バイト(ALG/FB)は常に
  // **ヘッダ行の値と一致し、5行目の値の影響は一切無かった**(ヘッダ@1 5 3+5行目
  // "2,1" → ALG=5,FB=3のまま。ヘッダ@1 2 1+5行目"5,3" → ALG=2,FB=1のまま)。
  // つまり実機は5行目を構文として許容(エラーにならない)しつつ、値としては
  // 完全に無視する。ヘッダのALG/FBを省略して5行目だけに書く形も実機で試したが、
  // オペレータ行の数値がバイト単位でずれた壊れたエントリになった(PMDMML.MANの
  // 「数値の省略は出来ません」という記載と整合)。よってこの5行目は「ヘッダの
  // ALG/FBを目視確認しやすくするための冗長な再掲(効果なし)」であり、実装側も
  // 値を捨てて読み飛ばすだけでよい(ヘッダの値をそのまま使う)。
  {
    let peek = cur;
    while (peek < lines.length && cleanToneLine(lines[peek]) === '') peek++;
    if (peek < lines.length) {
      const peekCleaned = cleanToneLine(lines[peek]);
      // ここは「あるかもしれない」を確認するだけの投機的な先読みなので、形が
      // 合わない場合(トークン数が2以外、数値以外のトークンを含む、MML変数
      // 参照`!H`等)は例外を投げず単に「5行目は無い」とみなして通常のトップ
      // レベル行処理(次のパート指定/音色定義/変数定義など)に委ねる。
      const peekTokens = peekCleaned.split(/[\s,]+/).filter((t) => t.length > 0);
      const looksLikeAlgFb = peekTokens.length === 2 && peekTokens.every((t) => /^-?\d+$/.test(t));
      if (looksLikeAlgFb) {
        const alg5 = parseInt(peekTokens[0], 10);
        const fb5 = parseInt(peekTokens[1], 10);
        // 形が2数値である以上はALG/FB再掲行だと確定して読み飛ばす対象にする。
        // 値そのものが無効(範囲外)ならエラーにする(黙って無視しない、というv2方針に
        // 従い、書式として受理する5行目でも値の妥当性検査はする。ただし採用はしない)。
        if (alg5 < 0 || alg5 > 7) throw new ParseError(peek + 1, `音色定義ALG/FB再掲5行目のALGが範囲外です(0-7): ${alg5}`);
        if (fb5 < 0 || fb5 > 7) throw new ParseError(peek + 1, `音色定義ALG/FB再掲5行目のFBが範囲外です(0-7): ${fb5}`);
        cur = peek + 1;
      }
    }
  }
  // MML記述順(op1,op2,op3,op4)と、音色テーブルのインデックスs(buildToneEntry()の
  // 第2引数、レジスタオフセット選択 0x30+ch+s*4)が対応する物理スロット順は 1,3,2,4
  // (YM2608のレジスタ配置。upstream/98fmplayer/libopna/opnafm.c:536-539の
  // `s = ((reg&8)>>3)|((reg&4)>>1)` で確認: オフセット0→スロット1, 4→スロット3,
  // 8→スロット2, 12→スロット4)。実データ3曲(単一定義15件、うち1件は複数回定義の
  // 「後勝ち」定義)すべてで、テーブルへ[op1,op3,op2,op4]の順に書き込むと参照`.M`と
  // 完全一致することを確認済み(docs/pmd-compiler-spec-v2.md 3.11節参照)。
  const orderedOps = [ops[0], ops[2], ops[1], ops[3]];
  const tone = {
    tonenum: header.tonenum,
    fb: header.fb,
    alg: header.alg,
    ar: orderedOps.map((o) => o.ar),
    d1r: orderedOps.map((o) => o.dr),
    d2r: orderedOps.map((o) => o.sr),
    rr: orderedOps.map((o) => o.rr),
    sl: orderedOps.map((o) => o.sl),
    tl: orderedOps.map((o) => o.tl),
    ks: orderedOps.map((o) => o.ks),
    mul: orderedOps.map((o) => o.ml),
    dt1: orderedOps.map((o) => o.dt),
    am: orderedOps.map((o) => o.ams),
  };
  return { tone, nextLi: cur - 1 }; // 呼び出し元のfor(li++)で+1されるので-1しておく
}

// MML全文をパースする。戻り値:
//   { tracks: Map<partLetter, events[]>, tones: Map<tonenum, toneOptions>,
//     header: {title, composer, arranger: string|null, memo: string[]}, errors: [{line,message}] }
// 複数パートに同じ行が指定された場合、各パートに同じイベント列(参照は別オブジェクト)を積む。
export function parseMml(source) {
  // DOS text-mode EOF marker (Ctrl-Z / 0x1A / SUB)。実データ3曲すべてでファイル末尾に
  // 1個だけ出現(`...\r\n\x1a\r\n`、16進実測で確認)。CRLFで行分割すると単独の行として
  // 残り、パート指定でも音色定義でもないため「行はパート指定(A-I)または音色定義(@)で
  // 始まる必要があります」の誤エラーになっていた不具合。DOS上のテキストエディタ/
  // コンパイラは通例この文字以降を読まない(EOFとして扱う)ため、以降を丸ごと切り捨てる。
  //
  // 2026-08-18追記: 上のindexOf('\x1a')は生バイトが素通りする経路(latin1等)でしか
  // 効かず、実データ3曲でJSM/YD/SS_TENGとも各1件「空行相当」の誤エラーが依然残って
  // いた。実測したところ、`net/charset.js`のdecodeMmlBytes()が使う
  // `new TextDecoder('shift_jis')`はNode(ICU)実装がバイト0x1Aを U+001A ではなく
  // U+001C にデコードするクセを持つ(node -e でC0域0x00-0x1Fを全数当たって確認:
  // 0x1a→0x1c。WHATWG Encoding仕様のShift_JISデコーダはASCII域を恒等写像するはずだが、
  // 実行環境の実挙動としてこれが出る)。実データ3曲のファイル中に生バイト0x1Cは1個も
  // 存在しない(python3で確認済み)ため、「decodeMmlBytes経由で読んだテキストに
  // U+001Cが現れたら、それは元バイト0x1AのEOFマーカがこの経路で化けたもの」と
  // 実務上みなしてよい。\x1a・\x1c どちらか先に現れた方で切り捨てる。
  const idx1a = source.indexOf('\x1a');
  const idx1c = source.indexOf('\x1c');
  const eofMarkerIdx = idx1a < 0 ? idx1c : (idx1c < 0 ? idx1a : Math.min(idx1a, idx1c));
  if (eofMarkerIdx >= 0) source = source.slice(0, eofMarkerIdx);

  const tracks = new Map(); // partLetter -> {events:[], state:{octave, defaultLengthSpec}}
  const tones = new Map(); // tonenum -> toneOptions (buildToneEntry用、tonenumはキー側と重複保持)
  // Rパターン番号(0-127) -> {events:[], state:{octave, defaultLengthSpec}}。
  // 2026-08-19実測(FINDINGS.md 12番)により、パターン本体は定義行の字句順ではなく
  // **Kパートから最初に参照(R<n>)された時点**で遅延コンパイルする(下のrawPatternBodies/
  // ensurePatternCompiled参照)。無指定`r`の休符長がKパート側の`l`設定(パターン定義行より
  // 後ろに書かれていても)を継承する挙動が、定義時点での即時コンパイルでは再現できないため。
  const rhythmPatterns = new Map();
  const rawPatternBodies = new Map(); // patNum -> [{body, lineNo}, ...](本体テキストのみ、未コンパイル)
  const compiledPatternNums = new Set();
  const header = {
    title: null, composer: null, arranger: null, memo: [],
    titleLine: null, composerLine: null, arrangerLine: null, memoLines: [],
    pcmfile: null, ppzfile: null, ppsfile: null,
    pcmfileLine: null, ppzfileLine: null, ppsfileLine: null,
    fffile: null, fffileLine: null,
    ppzExtend: null, ppzExtendLine: null, ppzExtendLetters: [],
    fm3Extend: null, fm3ExtendLine: null, fm3ExtendLetters: [],
    detuneExtend: null, detuneExtendLine: null,
    lfoSpeedExtend: null, lfoSpeedExtendLine: null,
    envSpeedExtend: null, envSpeedExtendLine: null,
  };
  const errors = [];
  const lines = source.split(/\r\n|\r|\n/);
  // `C`(全音符長)は全パート共通のグローバル設定(v2 3.8節)。1つの可変オブジェクトを
  // 全パートのtokenizeBody呼び出しで共有する。
  // gInjectMeasLen: パートGへの`C`注入(FINDINGS.md 14番)専用に追跡する値。
  // 通常パート(A-J)側の`C`コマンドでのみ更新される(Kパート内の`C`では更新しない、
  // 上のtokenizeRhythmKBody内コメント参照)。実測(実データALPHA_2022_ppz.MML、
  // `AB T191 C96`のあとに`GHI ...`でGが初めて登場するケース)により、注入の条件は
  // 「`C`コマンドが一度でも書かれたか」ではなく「その時点の値がDEFAULT_MEAS_LEN(96、
  // 既定値)と異なるか」だと判明した。ALPHAの`C96`は既定値と同じ値を明示的に
  // 書いているだけなので注入は起きない(Gトラックの参照.M実測で0x80単独=空トラック
  // だったことを確認済み)。PG1〜PG9.MML(FINDINGS.md 14番)の実測ケースは全て
  // 非既定値(72/132/204)だったため、この2つの仮説("Cが使われたか"/"既定値と違うか")
  // を区別できていなかった。
  const globalState = { measLen: DEFAULT_MEAS_LEN, gInjectMeasLen: DEFAULT_MEAS_LEN };

  // MML変数(`!`, v2 3.4節)の定義を先に一括収集する(ファイル中の出現順に依存しない
  // 二段階処理。定義自体はプリプロセス段階のみで完結し`.M`側のバイトは持たない)。
  const varMap = collectVariableDefs(lines);
  const varSortedNames = [...varMap.keys()].sort((a, b) => b.length - a.length);

  // Rパターンの遅延コンパイル(上のrhythmPatterns宣言コメント参照)。Kパートが
  // 'R<n>' を初めて参照した時点で、その時のKのdefaultLengthをパターン本体の
  // 初期値として与えつつ実際にトークナイズする。2回目以降の参照は既にコンパイル済みの
  // ものをそのまま使い回す(再コンパイルしない。PMD公式コンパイラがパターン本体を
  // 共有バイト列として1つだけ持つ設計に合わせた実装判断で、複数回・異なる文脈からの
  // 参照で結果が変わるケースは実測できていない)。
  function ensurePatternCompiled(patNum, seedDefaultLengthSpec, refLine) {
    if (compiledPatternNums.has(patNum)) return;
    compiledPatternNums.add(patNum);
    const chunks = rawPatternBodies.get(patNum);
    if (!chunks) {
      errors.push({ line: refLine, message: `未定義のRパターンを参照しています: R${patNum}` });
      return;
    }
    const info = { events: [], state: { octave: 0, defaultLengthSpec: seedDefaultLengthSpec } };
    rhythmPatterns.set(patNum, info);
    for (const { body, lineNo } of chunks) {
      try {
        const expandedBody = expandVariables(body, varMap, varSortedNames, lineNo, new Set());
        tokenizeRhythmPatternBody(expandedBody, lineNo, info.state, info.events, globalState);
      } catch (e) {
        if (e instanceof ParseError) errors.push({ line: e.line, message: e.pmdMessage });
        else throw e;
      }
    }
  }

  // #PPZExtend(v2 2.1節)も同様に本体ループより前に確定させる(collectPpzExtendの
  // コメント参照)。宣言順=PPZ_1〜_8の対応(2026-08-18確定)。
  const ppzResult = collectPpzExtend(lines);
  for (const e of ppzResult.errors) errors.push(e);
  const ppzExtendLetters = ppzResult.letters ?? [];
  const ppzExtendSet = new Set(ppzExtendLetters);
  header.ppzExtendLetters = ppzExtendLetters;

  // #FM3Extend(v2への追記、PMDMML.MAN §2-20)もPPZExtendと同じく本体ループより前に
  // 確定させる(collectFm3Extendのコメント参照)。
  const fm3Result = collectFm3Extend(lines);
  for (const e of fm3Result.errors) errors.push(e);
  const fm3ExtendLetters = fm3Result.letters ?? [];
  const fm3ExtendSet = new Set(fm3ExtendLetters);
  header.fm3ExtendLetters = fm3ExtendLetters;
  // #PPZExtendと#FM3Extendの記号は同じ文字表を共有するため、両方に同じ文字を
  // 宣言すると「その文字はPPZ8拡張なのかFM3ch拡張なのか」が一意に決まらなくなる。
  // マニュアルに明記は無いが、他の重複宣言(同一ヘッダ内の重複)と同様、黙って
  // 片方を採用するより宣言時点でエラーにする方が安全側(このプロジェクトの一貫方針)。
  for (const ch of fm3ExtendLetters) {
    if (ppzExtendSet.has(ch)) {
      errors.push({ line: fm3Result.letterLine ?? 1, message: `#FM3Extend の記号 '${ch}' は #PPZExtend でも宣言されています(同じ記号を両方で使うことはできません)` });
    }
  }

  // Rパターン本体テキストの事前収集(軽量プリスキャン)。実データ(pmdunimp.mml等)で
  // 「K R0」のようにKパートからの参照がパターン定義行より前に出現する構成が実在する
  // (下のensurePatternCompiledは参照時点で遅延コンパイルするため、本文テキスト自体は
  // 参照より前に必ず手元に無ければならない)。ヘッダ解析等の副作用は起こさず、
  // 単純に「R<数値> ...」形式の行を集めるだけの軽い一致判定に留める(本処理と同じ
  // 正規表現・コメント除去規則を使うが、エラー報告や状態更新はしない=本処理側の
  // 対応するブロックが最終的な妥当性検査を担う)。
  for (let li = 0; li < lines.length; li++) {
    const lineNo = li + 1;
    let raw = lines[li];
    const commentIdx = raw.indexOf(';');
    if (commentIdx >= 0) raw = raw.slice(0, commentIdx);
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    const rPatPre = /^R(\d+)(?:[ \t]+(.*))?$/.exec(trimmed);
    if (rPatPre) {
      const patNum = parseInt(rPatPre[1], 10);
      if (patNum < 0 || patNum > 127) continue; // 範囲外は本処理側のループで正式にエラー化する
      if (!rawPatternBodies.has(patNum)) rawPatternBodies.set(patNum, []);
      rawPatternBodies.get(patNum).push({ body: rPatPre[2] ?? '', lineNo });
    }
  }

  for (let li = 0; li < lines.length; li++) {
    const lineNo = li + 1;
    // ヘッダ命令(#Title等)は';'をコメントとして切り詰めない生の行で判定する
    // (PMDMML.MAN §2-6〜§2-9: 「後ろに;をつけてコメント等は記せません」)。
    if (tryParseHeaderLine(lines[li], lineNo, header, errors)) continue;
    let raw = lines[li];
    const commentIdx = raw.indexOf(';');
    if (commentIdx >= 0) raw = raw.slice(0, commentIdx);
    const trimmed = raw.trim();
    if (trimmed === '') continue;

    if (trimmed[0] === '!') {
      // MML変数定義行(PMDMML.MAN §3-2)。上でまとめて収集済みなので、ここでは
      // 構文として妥当な定義行であることだけ確認してスキップする(パート指定行としては扱わない)。
      if (!VAR_DEF_LINE_RE.test(trimmed)) {
        errors.push({ line: lineNo, message: `MML変数定義の書式が不正です(PMDMML.MAN §3-2「!文字列 MML文字列」または「!数値 MML文字列」、名前と値の間にSPACE/TABが必要): "${trimmed}"` });
      }
      continue;
    }

    if (trimmed[0] === '@') {
      // 音色定義ブロック(PMDMML.MAN §3-1)。行頭 '@' はトラック行(A-I)とは衝突しない。
      try {
        const { tone, nextLi } = parseToneDefBlock(lines, li, lineNo);
        // 複数回定義は「後勝ち」(実データとの突き合わせで実測、v2 3.11節→本ファイル冒頭コメント参照)。
        tones.set(tone.tonenum, tone);
        li = nextLi;
      } catch (e) {
        if (e instanceof ParseError) {
          errors.push({ line: e.line, message: e.pmdMessage });
          // ブロックの残り(想定5行=ヘッダ+オペレータ4行)を読み飛ばし、後続行が
          // パート指定行として誤ってエラー扱いされる無関係な連鎖エラーを避ける。
          li = Math.min(li + 4, lines.length - 1);
        } else {
          throw e;
        }
      }
      continue;
    }

    // Rパターン定義行(`R数値 ...`、PMDMML.MAN §1-2-1)。通常のパート指定行(A-J/K)とは
    // 別体系(パートではなく「パターン表エントリ」、doc v2 1.3節)なので、パート文字の
    // 一般判定より前に専用の正規表現で拾う(`R`の直後は空白無しで数字が続くため、
    // 通常のパート行regexにはそもそもマッチしない=誤って一般エラーになっていた)。
    const rPatM = /^R(\d+)(?:[ \t]+(.*))?$/.exec(trimmed);
    if (rPatM) {
      const patNum = parseInt(rPatM[1], 10);
      if (patNum < 0 || patNum > 127) {
        errors.push({ line: lineNo, message: `Rパターン番号は0-127です(cmd&0x80分岐の制約でこの範囲のみ到達可能。docs/pmd-compiler-spec-v2.md 1.3節): ${patNum}` });
        continue;
      }
      // 本文は上のプリスキャンで既に rawPatternBodies へ収集済み(遅延コンパイル、
      // 上のrhythmPatterns宣言コメント参照)。ここでは行の妥当性検査のみ行い、
      // 実際のトークナイズはKパートからの参照時(ensurePatternCompiled)まで待つ。
      continue;
    }

    // パート指定直後の数字(「小節番号」的な飾り記法)。PMDMML.MAN §1-1-2実測
    // (WebFetchで原文確認): 「AC1 @1v13cdefg」の例に対し「"1" is ignored.」と明記
    // されている(=チャンネル記号の直後に数字を書いても構文エラーにならず、
    // その数字自体は単に読み捨てられる。§1-1-2「especially useful for rhythm
    // parts」ともあり、可読性のための飾り記法)。数字の直後はSPACE/TABを挟んで
    // 本文が続く(§1-1-1「通常はSPACE/TAB区切りが必要」)ため、正規表現も
    // [A-Za-z]+ の直後に任意の数字列を許し、その後は従来通り空白+本文または
    // 行末を要求する形にする。
    const m = /^([A-Za-z]+)\d*(?:[ \t]+(.*))?$/.exec(trimmed);
    if (!m) {
      // 装飾のみの行(例: 「++++++++++++++++++++++++++++++」「---」「++ [ M A I N
      // T H E M E ] ++」)。PMDMML.MAN §1-1-1 Incorrect Example 1(WebFetchで原文確認):
      // 行頭がチャンネル記法として認識できない行について「Because MML does not
      // recognize this, it will not treat it as a command.」と明記されており、
      // エラーにはならず単に「コマンドとして扱われない」(=無視される)。
      // §1-1-2にも「存在しないチャンネルを指定してもエラーにならずスキップされる」
      // という同種の寛容な扱いが明記されている。本実装ではこの原則を、行頭が
      // レター/@/#/!のいずれでもない(=このパーサが構文として解釈しうる可能性が
      // 一切無い)行に限定して適用する: 数字始まりや通常のアルファベット始まりの
      // 崩れた行は引き続きエラーにし(実データのタイプミス等を検出する診断価値を
      // 残す)、記号だけの飾り行だけを安全側に「読み飛ばす」。提供者よりPMD98
      // ver4.8lでのコンパイル確認済みと明記されている実データの「+++」「---」系
      // 飾りコメント行はこの原則で説明できる。
      if (!/^[A-Za-z0-9@#!]/.test(trimmed)) {
        continue;
      }
      errors.push({ line: lineNo, message: `行はパート指定(A-I)または音色定義(@)で始まる必要があります: "${trimmed}"` });
      continue;
    }
    const letters = m[1];
    const body = m[2] ?? '';

    // Kパート(リズムパターン演奏順、doc v2 1.3節)。通常パートとは全く別の語彙
    // (tokenizeRhythmKBody)を使う。実データ3曲の実測で「ABCDEFGHIJK t120...」のように
    // 他パート文字と同じ行にKが混在する書き方が多数出現したため(PMD慣習:
    // 同じ行に列挙したパート全部へ同じ本文を流す)、Kが混在していても他パート文字は
    // 通常通りtokenizeBodyへ、Kだけ別途tokenizeRhythmKBodyへ本文を流す
    // (当初「K混在は未対応」としていたが、実データ実測でこの制約が誤りだと判明したため撤回)。
    // lettersToScan: このあとの通常パート走査(下のfor文)へ渡す、この行専用の文字列。
    // 2026-08-18(重大バグ修正): 以前は `var lettersForRest` をこの if ブロック内で
    // 宣言していたが、`var` は(ブロックスコープではなく)parseMml関数全体にホイストされる
    // ため、Kを含む行を1回処理すると、その値が**後続のK非含有行にまで残留**していた。
    // 特に「K」単独行(letters="K"のみ)を通ると lettersForRest="" になり、
    // `lettersForRest ?? letters` は空文字列をnullish扱いしない(??はnull/undefinedのみ
    // フォールバック)ため、以降**Kを含まない行も含めて全て空パート扱いで黙ってスキップ**
    // されていた(エラーは一切出ない)。実データJSMで実測: 出力543byte(参照.M 11,040byte、
    // 185本あるパート行のうち大半の内容が消えていた)。コンパイルが「成功」を名乗りながら
    // 曲のほとんどを黙って捨てる、このプロジェクトが最も避けたい壊れ方だった。
    // 行ごとに独立させ、このifブロックの外へ一切の状態を持ち出さないよう書き直す
    // (常にその行自身のletters基準。「黙って捨てない」の構造的保証として、以降
    // パート指定を跨いだ暗黙の状態共有は行わない設計にする)。
    let lettersToScan = letters;
    if (/k/i.test(letters)) {
      if (!tracks.has('K')) tracks.set('K', { events: [], state: { octave: 3, defaultLengthSpec: { n: 4, dots: 0 }, terminated: false } });
      const kTrack = tracks.get('K');
      // '/'(PMDMML.MAN §16-4)でKパートが既に打ち切られていれば、以降の行は
      // このパートについて一切コンパイルしない(通常パートと同じ規則)。
      if (!kTrack.state.terminated) {
        try {
          const expandedBody = expandVariables(body, varMap, varSortedNames, lineNo, new Set());
          tokenizeRhythmKBody(expandedBody, lineNo, kTrack.events, globalState, kTrack.state, ensurePatternCompiled);
        } catch (e) {
          if (e instanceof ParseError) errors.push({ line: e.line, message: e.pmdMessage });
          else throw e;
        }
      }
      // letters中のK以外の文字は下の通常経路へそのまま続ける(letters/bodyは変更しない。
      // 下のfor文がPART_LETTERS.includes判定で自然にKを弾いてくれるので、Kをここで
      // letters から取り除く必要は無い。ただしそのままだと後段で「未対応のパート指定: 'K'」
      // エラーが重複して出てしまうため、この行だけKを取り除いた文字列を使う)。
      lettersToScan = letters.replace(/k/gi, '');
      if (lettersToScan === '') continue;
    }

    const partLetters = [];
    for (const ch of lettersToScan) {
      // PPZ8拡張パート(#PPZExtendで宣言済みの記号、v2 2.1節)は大文字小文字を区別する
      // (通常パート文字A-Jはtoupperで寛容に受理するが、PPZExtendの記号表は大文字L-Z
      // (Rを除く)と小文字a-zの両方を含み、既存のFM/SSG/ADPCM文字と衝突しないよう
      // 設計されているため、宣言された記号そのものと完全一致で判定する)。
      if (ppzExtendSet.has(ch) || fm3ExtendSet.has(ch)) {
        partLetters.push(ch);
        continue;
      }
      const upper = ch.toUpperCase();
      if (!PART_LETTERS.includes(upper)) {
        errors.push({
          line: lineNo,
          message: `未対応のパート指定です: '${ch}'（FM1-6=A-F, SSG1-3=G-I, ADPCM=J, リズム=K に対応。PPZ8拡張パートを使うには#PPZExtend、FM3ch拡張パートを使うには#FM3Extendで先に宣言してください。PMDMML.MAN §2-25/§2-20）`,
        });
        continue;
      }
      partLetters.push(upper);
    }
    if (partLetters.length === 0) continue;

    for (const p of partLetters) {
      if (!tracks.has(p)) {
        // 既定オクターブ: PMDMML.MAN §4-4の既定値はo4(1-8系)。nibble表現は
        // -1した3(oコマンド未実装当時の名残でoctave:4だったが、oコマンドの
        // 符号化修正(oct-1)に合わせてここも合わせる)。
        const newTrack = { events: [], state: { octave: 3, defaultLengthSpec: { n: 4, dots: 0 }, terminated: false } };
        // 2026-08-19実測(FINDINGS.md 14番、PG1〜PG9.MML): MML中に`C`(全音符長)が
        // 1つでも現れると、パートG(SSG1)の**トラックが作られた時点**で有効だった
        // `C`の値が、そのトラック絶対先頭に注入される(`0xdf`+1byte)。
        // ここは「Gがこの行で初めて登場した」瞬間(=このパートの本文がまだ
        // tokenizeBodyされる前)なので、globalState.measLenは「このG行より前に
        // 宣言されたC」の値のまま(このG行自身のCがまだ反映されていない)。
        // これにより`A C72 c`/`G C204 c`のような「Gの行自身にもCがある」ケースでも
        // 「最後の値」ではなく「Gのトラックが作られた時点の値」(C72)が正しく
        // 注入される(自身のC204は下のtokenizeBody呼び出しで後ろに追加される)。
        // 注入条件は「値がDEFAULT_MEAS_LEN(既定値96)と異なるか」(gInjectMeasLen、
        // 上のglobalState初期化コメント参照。実データALPHAで確定)。
        if (p === 'G' && globalState.gInjectMeasLen !== DEFAULT_MEAS_LEN) {
          newTrack.events.push({ type: 'measLen', line: lineNo, value: globalState.gInjectMeasLen });
        }
        tracks.set(p, newTrack);
      }
    }

    try {
      // MML変数(`!`)の展開はトークナイズの直前、行ごとに行う(§16-1: FM/SSG/PCM等の
      // 本文中で使用可能。パート指定文字自体や#系ヘッダ行・音色定義ブロックは対象外)。
      const expandedBody = expandVariables(body, varMap, varSortedNames, lineNo, new Set());
      // 同じ行を複数パートへ流す場合、各パートの state(o/l)は独立に進行する
      // (PMD慣習通り。パートごとに別オブジェクトへ積む必要があるため、パートごとに1回ずつ字句解析する)
      for (const p of partLetters) {
        const trackInfo = tracks.get(p);
        // '/'(コンパイル打ち切り、PMDMML.MAN §16-4)で既に打ち切られたパートは、
        // 以降の行に同じパート文字が再度現れても一切コンパイルしない。
        if (trackInfo.state.terminated) continue;
        // FM3Extendパートは実体がFM3chの拡張(§2-20「FM音源3のパートを...拡張します」)
        // なのでkind='fm'(FM用のv/V変換表・オクターブ範囲などが通常のFMパートA-Fと
        // 同じに扱われる)。2026-08-19のMC.EXE実測(バッチ5)で'E'(ソフトウエア
        // エンベロープ)はFM系パートでも受理されると判明したため(partKindによる
        // 拒否は撤去済み、tools/verify_pmd_ssg_misc_commands.mjs参照)、FM3Extend
        // パートでもEはpartKindでは拒否されない。
        const kind = ppzExtendSet.has(p) ? 'ppz' : (fm3ExtendSet.has(p) ? 'fm' : PART_KIND[p]);
        const beforeLen = trackInfo.events.length;
        tokenizeBody(expandedBody, lineNo, trackInfo.state, trackInfo.events, kind, globalState, p);
        // 2026-08-19実測(FINDINGS.md 10番、PC1〜PC9/PCA/PCB/PCC.MML): パート指定に
        // FMパート(A-F)が1つ以上含まれ、かつGが含まれる行では、`C`(measLen)の出力が
        // Gのトラックにのみ2回出る(MC.EXEのFM→SSG境界の実装上の癖と思われるが、
        // バイト一致が目的のためそのまま再現する)。重複するのはCコマンドだけで、
        // 同じ行のv/q/*等は対象外。FMを含まない行(GHI/GHIJK等)ではGも1回のまま。
        //
        // 複製の挿入位置(2026-08-19、実データMULE_op_loop.mml実測で訂正): 当初は
        // 「このCイベントの直後」に複製を挿入していたが、PC1〜PCC.MMLはいずれもCが
        // 行頭かつその時点でGトラックが空だったため、「直後」と「Gトラック全体の
        // 絶対先頭」を区別できていなかった。実データはCより前の行(`ABCDEFGHI !H`
        // →transposeAbs)が既にGトラックへ積まれているケースで、参照.Mでは複製が
        // その`transposeAbs`より**前**(トラック絶対先頭)に来ることを確認した
        // (自作(旧実装): `f5 00 df c0 df c0`(transpose,C,C) / 参照: `df c0 f5 00 df c0`
        // (C,transpose,C)。つまり複製は「行内で直後」ではなく「トラック絶対先頭」)。
        if (p === 'G' && partLetters.some((letter) => FM_PART_LETTERS_SET.has(letter))) {
          const newEvents = trackInfo.events.slice(beforeLen);
          const measLenEvents = newEvents.filter((ev) => ev.type === 'measLen');
          if (measLenEvents.length > 0) {
            trackInfo.events.unshift(...measLenEvents.map((ev) => ({ ...ev })));
          }
        }
      }
    } catch (e) {
      if (e instanceof ParseError) {
        errors.push({ line: e.line, message: e.pmdMessage });
      } else {
        throw e;
      }
    }
  }

  // 2026-08-19実測(FINDINGS.md 14番): MML中の(通常パートA-J側の)`C`がDEFAULT_MEAS_LEN
  // (既定値96)と異なる値になったのに、パートGが一度も明示的に登場しなかった場合でも、
  // Gのトラックは(空トラックではなく)`C`の最終値1つだけを積んだトラックとして出力される。
  // 実測解釈は「Gのトラックが作られた時点で有効だった値」で、Gが明示的に使われない曲では
  // トラック作成が(ファイル全体を読み終えた)最後になるため、結果的にファイル中最後の
  // `C`の値になる。
  if (globalState.gInjectMeasLen !== DEFAULT_MEAS_LEN && !tracks.has('G')) {
    tracks.set('G', {
      events: [{ type: 'measLen', line: 0, value: globalState.gInjectMeasLen }],
      state: { octave: 3, defaultLengthSpec: { n: 4, dots: 0 }, terminated: false },
    });
  }

  // Kから一度も参照されなかった(=定義だけされた)Rパターンも、既存の「パターン番号は
  // 0から連番」チェックやパターン索引表の構築に必要なため、既定の初期defaultLengthSpec
  // ({n:4, dots:0}、l4相当。C=96のとき24クロック)で遅延コンパイルしておく。
  // 実測(FINDINGS.md 12番)はいずれもK参照ありのケースのため、Kから参照されない場合の
  // 実機挙動は未確認だが、少なくとも「未定義パターン参照」エラーになったり出力から
  // 消えたりする既存の互換性は保つ。
  for (const patNum of rawPatternBodies.keys()) {
    ensurePatternCompiled(patNum, { n: 4, dots: 0 }, rawPatternBodies.get(patNum)[0]?.lineNo ?? 1);
  }

  if (errors.length === 0) {
    for (const [p, info] of tracks) {
      try {
        linkLoops(info.events, p);
      } catch (e) {
        if (e instanceof ParseError) errors.push({ line: e.line, message: e.pmdMessage });
        else throw e;
      }
    }
    for (const [num, info] of rhythmPatterns) {
      try {
        linkLoops(info.events, `R${num}`);
      } catch (e) {
        if (e instanceof ParseError) errors.push({ line: e.line, message: e.pmdMessage });
        else throw e;
      }
    }
  }

  const trackEvents = new Map();
  for (const [p, info] of tracks) trackEvents.set(p, info.events);
  const rhythmPatternEvents = new Map();
  for (const [num, info] of rhythmPatterns) rhythmPatternEvents.set(num, info.events);
  return { tracks: trackEvents, tones, header, rhythmPatterns: rhythmPatternEvents, errors };
}
