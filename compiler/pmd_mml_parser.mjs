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
export const NOTE_LETTER_TO_BASE_INDEX = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const DEFAULT_MEAS_LEN = 96; // 全音符長の初期値。`C`(v2 3.8節, 0xdf)で変更可能。

// 'v'(大雑把な音量, PMDMML.MAN §5-1)のFM/PCM用変換テーブル。v0〜v16 -> V値。
// 出典: PMDMML.MAN §5-1 の一覧表そのもの(WebFetchで原文確認、本ファイル冒頭コメント参照)。
const V_LOWERCASE_FM_TABLE = [85, 87, 90, 93, 95, 98, 101, 103, 106, 109, 111, 114, 117, 119, 122, 125, 127];
// SSGは v も V も範囲が同一(0-15, PMDMML.MAN §5-1/§5-2)なため、変換テーブルは存在せず
// 素通し(v=V)になっていると推測される。マニュアルにSSG用の変換テーブル記載は無く、
// **この等価性は未実測・未解明のまま採用している**(docs/pmd-compiler-spec.md 6.6節に明記)。

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
const KNOWN_UNIMPLEMENTED_HEADERS = {
  'ppzextend': 'PPZ8用パート拡張(PMDMML.MAN §2-25)。指定した文字列の出現順とPPZ_1〜_8の対応規則が未解明(docs/pmd-compiler-spec-v2.md 2.1節)',
  'detune': 'デチューン数値レンジ拡張モード(引数 Extend)。.M側への反映方法が未解明',
  'lfospeed': 'LFO速度数値レンジ拡張モード(引数 Extend)。.M側への反映方法が未解明',
  'envelopespeed': 'エンベロープ速度数値レンジ拡張モード(引数 Extend)。.M側への反映方法が未解明',
};
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

  const pcmM = PCM_HEADER_RE.exec(raw);
  if (pcmM) {
    const key = PCM_HEADER_KEY[pcmM[1].toLowerCase()];
    header[key] = pcmM[2]; // 最後勝ち(Title等と同じ扱い。§2 全般注記に準拠)
    header[`${key}Line`] = lineNo;
    return true;
  }

  const ffM = FFFILE_HEADER_RE.exec(raw);
  if (ffM) {
    header.fffile = ffM[1]; // 最後勝ち(Title等と同じ扱い)。実体の読み込みはcompileMml側
    header.fffileLine = lineNo;
    return true;
  }

  const genM = GENERIC_HEADER_RE.exec(raw);
  if (genM) {
    const nameRaw = genM[1];
    const argRaw = (genM[2] ?? '').trim().toLowerCase();
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

// 本文(パート文字を除いた部分)を字句解析してイベント列を返す。
// state: {octave, defaultLength(クロック値)} をパートごとに呼び出し元が持ち回す。
// partKind: 'fm' | 'ssg' (v/Vの値域・変換がFM/SSGで異なるため、doc 6.6節)
// globalState: {measLen} 。`C`(全音符長設定)は全パート共通のグローバル設定
// (PMDMML.MAN §4-11「いずれかのパートの頭に設定すれば、すべてのパートに有効」)
// のため、呼び出し元(parseMml)が1つのオブジェクトをすべてのパートへ使い回す。
function tokenizeBody(body, line, state, events, partKind, globalState) {
  let i = 0;
  const n = body.length;

  function readLengthSpec() {
    // 戻り値: クロック値、または null(長さ指定なし=デフォルト長を使う)
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
      clocks = state.defaultLength;
    }
    let dots = 0;
    while (body[i] === '.') { dots++; i++; }
    return dots > 0 ? applyDots(clocks, dots, line) : clocks;
  }

  // '(' ')' (音量相対変化、基本形のみ。v2 3.1節)。[%] [数値]、数値省略時は1。
  // %付きは指定値そのまま(0-255)、%無しは指定値×4(0xe3/0xe2は1byte引数のため、
  // ×4後に1byteへ収まるよう無指定時の数値域を0-63に制限する。doc本文には明記が無いが
  // バイト長の制約から一意に導ける値域)。
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
    const isDefault = !percent && !m;
    if (m) { i += m[0].length; num = parseInt(m[0], 10); } else { num = 1; }
    if (percent) {
      if (num < 0 || num > 255) throw new ParseError(line, `'('/')' の%指定値が範囲外です(0-255): ${num}`);
      return { value: num, isDefault };
    }
    if (num < 0 || num > 63) throw new ParseError(line, `'('/')' の数値が範囲外です(0-63。無指定時は×4され1byteに収める制約から算出): ${num}`);
    return { value: num * 4, isDefault };
  }

  // '{ }' 内(ポルタメント音程指定、v2 3.5節→今回実測で解決)は c/d/e/f/g/a/b/o/</< のみ許可
  // (PMDMML.MAN §4-3)。o/</> はここで state.octave を更新し、これは通常の音符と同じく
  // '}' の外まで持ち越される(PMDの八度レジスタはパート共通の1つの状態のため)。
  function readBraceNote() {
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
        state.octave = oct - 1;
        continue;
      }
      // 標準MML慣習: '<'=オクターブ下, '>'=オクターブ上(参照.M実測、
      // pmdbasic.mmlの`b>c<`で b=0x4b→>後のc=0x50 と1オクターブ上がることを確認。
      // 旧実装は逆(未検証コメント付き)だった)。
      if (body[i] === '<') { i++; state.octave -= 1; continue; }
      if (body[i] === '>') { i++; state.octave += 1; continue; }
      break;
    }
    const nc = body[i];
    if (!(nc in NOTE_LETTER_TO_BASE_INDEX)) {
      throw new ParseError(line, `'{...}' 内には c/d/e/f/g/a/b/o/</> のみ指定できます(PMDMML.MAN §4-3): '${nc ?? ''}'`);
    }
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

  while (i < n) {
    const c = body[i];
    if (/\s/.test(c)) { i++; continue; }

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
      events.push({ type: 'note', line, octave, noteIndex, clocks });
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

    if (c === '&') { i++; events.push({ type: 'tie', line }); continue; }

    if (c === 'o' || c === 'O') {
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'o' の後にオクターブ数値がありません`);
      i += m[0].length;
      const oct = parseInt(m[0], 10);
      // PMDMML.MAN §4-4: oコマンドの範囲は1〜8(既定4)。実バイトのnibbleはこれより
      // 1小さい0-7(参照.M実測、docs/pmd-compiler-spec-v2.md 6章参照)。
      if (oct < 1 || oct > 8) throw new ParseError(line, `オクターブが範囲外です(1-8。PMDMML.MAN §4-4): ${oct}`);
      state.octave = oct - 1;
      continue;
    }
    // 標準MML慣習: '<'=オクターブ下, '>'=オクターブ上(参照.M実測、
    // pmdbasic.mmlの`b>c<`で確認。旧実装は逆(未検証コメント付き)だった)。
    if (c === '<') { i++; state.octave -= 1; continue; }
    if (c === '>') { i++; state.octave += 1; continue; }

    if (c === 'l') {
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'l' の後に音長数値がありません`);
      i += m[0].length;
      let clocks = numericLengthToClocks(parseInt(m[0], 10), line, globalState.measLen);
      let dots = 0;
      while (body[i] === '.') { dots++; i++; }
      if (dots > 0) clocks = applyDots(clocks, dots, line);
      state.defaultLength = clocks;
      continue;
    }
    if (c === 'L') { i++; events.push({ type: 'globalLoop', line }); continue; }

    if (c === '@') {
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'@' の後に音色番号がありません`);
      i += m[0].length;
      events.push({ type: 'tone', line, tonenum: parseInt(m[0], 10) });
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
      // 音量指定2(細かい値、絶対値)。PMDMML.MAN §5-2。FM:0-127 / SSG:0-15 / PCM(ADPCM):0-255
      // (doc本文/pmd-compiler-spec.md 7.2節)。
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'V' の後に音量数値がありません`);
      i += m[0].length;
      const val = parseInt(m[0], 10);
      const max = partKind === 'ssg' ? 15 : partKind === 'adpcm' ? 255 : 127;
      if (val < 0 || val > max) {
        throw new ParseError(line, `'V' の値が範囲外です(${partKind === 'ssg' ? 'SSGは0-15' : partKind === 'adpcm' ? 'PCMは0-255' : 'FMは0-127'}): ${val}`);
      }
      events.push({ type: 'volAbs', line, value: val });
      continue;
    }
    if (c === 'v') {
      // 音量指定1(大雑把な値)。PMDMML.MAN §5-1。FM/PCM:0-16(変換テーブル経由でVへ)/ SSG:0-15(素通し、未解明)。
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'v' の後に音量数値がありません`);
      i += m[0].length;
      const val = parseInt(m[0], 10);
      const max = partKind === 'ssg' ? 15 : 16;
      if (val < 0 || val > max) {
        throw new ParseError(line, `'v' の値が範囲外です(${partKind === 'ssg' ? 'SSGは0-15' : 'FM/PCMは0-16'}): ${val}`);
      }
      const converted = partKind === 'ssg' ? val : V_LOWERCASE_FM_TABLE[val];
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
      events.push({ type: 'measLen', line, value: val });
      continue;
    }

    if (c === 'D') {
      // デチューン設定。PMDMML.MAN §7-1。絶対値`D`=0xfa、相対値`DD`=0xd5(v2 3.9節)。
      i++;
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
        const depthA = parseInt(m[1], 10);
        const delay = m[2] != null ? parseInt(m[2], 10) : 0;
        const speed = m[3] != null ? parseInt(m[3], 10) : 1;
        const depthB = 255;
        if (depthA < -128 || depthA > 127) throw new ParseError(line, `'MP'系の数値1(depth)が範囲外です(-128〜127): ${depthA}`);
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
      events.push({ type: 'lfoBody', line, lfo: lfoNum, delay, speed, depthA, depthB });
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
        // 一方、数値1が一度も明示されていない場合(既存corpus pmdgate.mmlの
        // q-10,5等)は参照.M側に説明の付かない先頭の`fe 01`が現れ、今回の式
        // (既定0との差分)だけでは再現できないことが分かった(未解明のまま。
        // docs/pmd-compiler-spec-v2.md 5章に記録)。そのため退行を避けるべく、
        // 数値1が一度もこのパートで明示されていない場合は、これまで通り
        // 数値2をそのままbit7=1固定で書く旧仕様(既存の設計判断)を維持する。
        let value;
        if (state.qNum1 != null) {
          const heldNum1 = state.qNum1;
          const range = Math.abs(heldNum1 - num2);
          if (range > 127) throw new ParseError(line, `'q'の数値1と数値2の差が範囲外です(127以内。0xb1下位7bit): |${heldNum1}-${num2}|=${range}`);
          value = (num2 < heldNum1 ? 0x80 : 0x00) | range;
        } else {
          value = 0x80 | num2;
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
      const note1 = readBraceNote();
      const note2 = readBraceNote();
      if (body[i] !== '}') {
        throw new ParseError(line, `'{' に対応する '}' がありません(内部は c/d/e/f/g/a/b/o/</> の2音のみ許可、PMDMML.MAN §4-3)`);
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
function tokenizeRhythmKBody(body, line, events, globalState) {
  let i = 0;
  const n = body.length;
  while (i < n) {
    const c = body[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '\\') { i = parseBackslashCommand(body, i, line, events); continue; }
    if (c === 'C') {
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'C' の後に全音符長の数値がありません`);
      i += m[0].length;
      const val = parseInt(m[0], 10);
      if (val < 1 || val > 255) throw new ParseError(line, `'C'(全音符長)の値が範囲外です(1-255): ${val}`);
      globalState.measLen = val;
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
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'l' の後に音長数値がありません`);
      i += m[0].length;
      while (body[i] === '.') i++;
      continue; // Kにはデフォルト音長の概念が無いため読み捨てる
    }
    // 'v'(大雑把な音量)・'V'(細かい音量)・'q'(ゲート)・'_'/'__'(転調)も、実データでは
    // 「ABCDEFGHIJKab l12 o4 !H v14 q1 l16」のようにKと同じ行へ頻繁に混在する
    // (`!H`変数展開の中身に`_`が含まれるケースも実測)。いずれもKには対応する出力先が
    // 無く読み捨てて構わない(o/l/C以外は本当に無視してよいコマンド群、PMDMML.MAN上も
    // 音符/音量/ゲート系はK/Rパートの演奏内容そのものには関与しない)ため、構文だけ
    // 消費して捨てる(範囲チェックはしない。他パート側で同じ文字列がchecked済みのため)。
    if (c === 'v' || c === 'V') {
      i++;
      const m = /^\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'${c}' の後に音量数値がありません`);
      i += m[0].length;
      continue;
    }
    if (c === 'q') {
      i++;
      const m1 = /^\d+/.exec(body.slice(i));
      if (m1) i += m1[0].length;
      if (body[i] === '-') {
        i++;
        const m2 = /^\d+/.exec(body.slice(i));
        if (m2) i += m2[0].length;
      }
      if (body[i] === ',') {
        i++;
        const m3 = /^\d+/.exec(body.slice(i));
        if (m3) i += m3[0].length;
      }
      continue;
    }
    if (c === '_') {
      i++;
      if (body[i] === '_') i++;
      const m = /^[+-]?\d+/.exec(body.slice(i));
      if (!m) throw new ParseError(line, `'_' の後に転調数値がありません`);
      i += m[0].length;
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
    throw new ParseError(line, `Kパートで未対応の文字です: '${c}'（Rパターン選択(R数値)・ループ([ ] :)・全体ループ(L)・\\系コマンドのみ対応）`);
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
      clocks = state.defaultLength;
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
      let clocks = numericLengthToClocks(parseInt(m[0], 10), line, globalState.measLen);
      let dots = 0;
      while (body[i] === '.') { dots++; i++; }
      if (dots > 0) clocks = applyDots(clocks, dots, line);
      state.defaultLength = clocks;
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
// 出典: PMDMML.MAN §3-1 [書式1]・[範囲]。
// DTは仕様上「-3〜3 または 0〜7」の二重表記だが、符号→ビットパターンの対応が
// fmdriver_pmd.c単体からは確認できていない(docs/pmd-compiler-spec.md 1.6.1節「未解明」)。
// v1では安全側に倒し、DTは生の3bit値(0-7)のみ受理する(-3〜3の符号表記は非対応、doc 6.6節に明記)。
function parseToneOperatorLine(cleaned, line, opIndex) {
  const nums = parseIntList(cleaned, line, 10, `音色定義オペレータ${opIndex + 1}行(AR DR SR RR SL TL KS ML DT AMS)`);
  if (!nums) {
    throw new ParseError(line, `音色定義オペレータ${opIndex + 1}行の書式が不正です(AR DR SR RR SL TL KS ML DT AMSの10個の数値が必要): "${cleaned}"`);
  }
  const [ar, dr, sr, rr, sl, tl, ks, ml, dt, ams] = nums;
  const checks = [
    ['AR', ar, 0, 31], ['DR', dr, 0, 31], ['SR', sr, 0, 31], ['RR', rr, 0, 15],
    ['SL', sl, 0, 15], ['TL', tl, 0, 127], ['KS', ks, 0, 3], ['ML', ml, 0, 15],
    ['DT', dt, 0, 7], ['AMS', ams, 0, 1],
  ];
  for (const [name, val, lo, hi] of checks) {
    if (val < lo || val > hi) {
      throw new ParseError(line, `音色定義オペレータ${opIndex + 1}行の${name}が範囲外です(${lo}-${hi}): ${val}`);
    }
  }
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

  const tracks = new Map(); // partLetter -> {events:[], state:{octave, defaultLength}}
  const tones = new Map(); // tonenum -> toneOptions (buildToneEntry用、tonenumはキー側と重複保持)
  const rhythmPatterns = new Map(); // Rパターン番号(0-127) -> {events:[], state:{octave, defaultLength}}
  const header = {
    title: null, composer: null, arranger: null, memo: [],
    titleLine: null, composerLine: null, arrangerLine: null, memoLines: [],
    pcmfile: null, ppzfile: null, ppsfile: null,
    pcmfileLine: null, ppzfileLine: null, ppsfileLine: null,
    fffile: null, fffileLine: null,
  };
  const errors = [];
  const lines = source.split(/\r\n|\r|\n/);
  // `C`(全音符長)は全パート共通のグローバル設定(v2 3.8節)。1つの可変オブジェクトを
  // 全パートのtokenizeBody呼び出しで共有する。
  const globalState = { measLen: DEFAULT_MEAS_LEN };

  // MML変数(`!`, v2 3.4節)の定義を先に一括収集する(ファイル中の出現順に依存しない
  // 二段階処理。定義自体はプリプロセス段階のみで完結し`.M`側のバイトは持たない)。
  const varMap = collectVariableDefs(lines);
  const varSortedNames = [...varMap.keys()].sort((a, b) => b.length - a.length);

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
      if (!rhythmPatterns.has(patNum)) {
        rhythmPatterns.set(patNum, { events: [], state: { octave: 0, defaultLength: 24 } });
      }
      try {
        const rBody = rPatM[2] ?? '';
        const expandedBody = expandVariables(rBody, varMap, varSortedNames, lineNo, new Set());
        const info = rhythmPatterns.get(patNum);
        tokenizeRhythmPatternBody(expandedBody, lineNo, info.state, info.events, globalState);
      } catch (e) {
        if (e instanceof ParseError) errors.push({ line: e.line, message: e.pmdMessage });
        else throw e;
      }
      continue;
    }

    const m = /^([A-Za-z]+)(?:\s+(.*))?$/.exec(trimmed);
    if (!m) {
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
      if (!tracks.has('K')) tracks.set('K', { events: [], state: { octave: 3, defaultLength: 24 } });
      try {
        const expandedBody = expandVariables(body, varMap, varSortedNames, lineNo, new Set());
        tokenizeRhythmKBody(expandedBody, lineNo, tracks.get('K').events, globalState);
      } catch (e) {
        if (e instanceof ParseError) errors.push({ line: e.line, message: e.pmdMessage });
        else throw e;
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
      const upper = ch.toUpperCase();
      if (!PART_LETTERS.includes(upper)) {
        errors.push({
          line: lineNo,
          message: `未対応のパート指定です: '${ch}'（FM1-6=A-F, SSG1-3=G-I, ADPCM=J, リズム=K に対応。PPZ8拡張パートは未解明のため対象外）`,
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
        tracks.set(p, { events: [], state: { octave: 3, defaultLength: 24 } });
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
        tokenizeBody(expandedBody, lineNo, trackInfo.state, trackInfo.events, PART_KIND[p], globalState);
      }
    } catch (e) {
      if (e instanceof ParseError) {
        errors.push({ line: e.line, message: e.pmdMessage });
      } else {
        throw e;
      }
    }
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
