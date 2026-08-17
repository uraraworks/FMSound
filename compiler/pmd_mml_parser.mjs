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

// ヘッダ命令行かどうかを判定し、該当すれば header へ反映して true を返す。
// 呼び出し元は raw(未加工の行文字列、';'を切り詰める前)を渡すこと。
function tryParseHeaderLine(raw, lineNo, header, errors) {
  const m = HEADER_LINE_RE.exec(raw);
  if (!m) return false;
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

// 数値長 → クロック値。全音符長(既定96、`C`コマンドで変更可)の約数のみ許容
// (PMDMML.MAN §2-11、doc 1.3節)。measLenは呼び出し時点でのグローバル全音符長。
function numericLengthToClocks(n, line, measLen) {
  if (n <= 0 || measLen % n !== 0) {
    throw new ParseError(line, `音長 ${n} は全音符長${measLen}の約数ではありません`);
  }
  return measLen / n;
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
    if (m) { i += m[0].length; num = parseInt(m[0], 10); } else { num = 1; }
    if (percent) {
      if (num < 0 || num > 255) throw new ParseError(line, `'('/')' の%指定値が範囲外です(0-255): ${num}`);
      return num;
    }
    if (num < 0 || num > 63) throw new ParseError(line, `'('/')' の数値が範囲外です(0-63。無指定時は×4され1byteに収める制約から算出): ${num}`);
    return num * 4;
  }

  while (i < n) {
    const c = body[i];
    if (/\s/.test(c)) { i++; continue; }

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
      if (oct < 0 || oct > 7) throw new ParseError(line, `オクターブが範囲外です(0-7。cmd<0x80制約): ${oct}`);
      state.octave = oct;
      continue;
    }
    if (c === '<') { i++; state.octave += 1; continue; } // doc: PC-98系MML慣習で<=オクターブ上(未検証、報告参照)
    if (c === '>') { i++; state.octave -= 1; continue; }

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
      // ソフトウエアLFO本体。PMDMML.MAN §9-1。`.M`側 0xf2は常に4byte固定(v2 3.6節)。
      // 「delayのみ」省略形は今回範囲外(4値すべて必須)。MA/MB/LFO2(0xbf)も範囲外。
      i++;
      const m = /^(\d+)\s*,\s*(\d+)\s*,\s*(-?\d+)\s*,\s*(\d+)/.exec(body.slice(i));
      if (!m) {
        throw new ParseError(line, `'M' の書式が不正です(delay,speed,depthA,depthBの4値すべてが必要。省略形は未対応)`);
      }
      i += m[0].length;
      const delay = parseInt(m[1], 10);
      const speed = parseInt(m[2], 10);
      const depthA = parseInt(m[3], 10);
      const depthB = parseInt(m[4], 10);
      if (delay < 0 || delay > 255) throw new ParseError(line, `'M'のdelayが範囲外です(0-255): ${delay}`);
      if (speed < 0 || speed > 255) throw new ParseError(line, `'M'のspeedが範囲外です(0-255): ${speed}`);
      if (depthA < -128 || depthA > 127) throw new ParseError(line, `'M'のdepthAが範囲外です(-128〜127): ${depthA}`);
      if (depthB < 0 || depthB > 255) throw new ParseError(line, `'M'のdepthBが範囲外です(0-255): ${depthB}`);
      events.push({ type: 'lfoBody', line, delay, speed, depthA, depthB });
      continue;
    }

    if (c === 'q') {
      // 音の切り方の指定2。PMDMML.MAN §4-13。数値2→0xb1(gate_rand_range)、
      // 数値3→0xb3(gate_min)は確定済み(v2 3.3節)。数値1(固定カット量)は
      // `.M`側のバイト表現が未解明のため今回は非対応のまま(推測で埋めない)。
      i++;
      const m1 = /^\d+/.exec(body.slice(i));
      if (m1) {
        throw new ParseError(line, `'q'の数値1(固定カット量)は未対応です(バイト表現が未解明。docs/pmd-compiler-spec-v2.md 3.3/5章参照)`);
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
      if (num2 == null && num3 == null) {
        throw new ParseError(line, `'q'の書式が不正です(数値2('-n')または数値3(',n')の少なくとも一方が必要。単独の数値1は未対応)`);
      }
      if (num2 != null) {
        // bit7=1(減算方向)に固定する設計判断: 0xb1のbit7は「1なら減算方向」
        // (fmdriver_pmd.c:1473-1483)。qは「後ろカット」(発音を短くする)コマンドなので
        // 減算方向で統一する。数値1省略時にどちらの方向を選ぶべきかの一次情報は無く、
        // これは実装上の設計判断であることを明記する(v2 3.3節/5章の未解明とは別軸)。
        events.push({ type: 'gateRandRange', line, value: 0x80 | num2 });
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
      const val = readVolRelArg();
      events.push({ type: isAdd ? 'volInc' : 'volDec', line, value: val });
      continue;
    }

    throw new ParseError(line, `未対応の文字です: '${c}'（v1範囲外、またはPMD_PART_FM_1-6以外のパート機能の可能性）`);
  }
}

// 構造(ループの対応関係)を検査してリンクを張る。ネストは v1 非対応(単純化のため)。
function linkLoops(events, partLetter) {
  const stack = [];
  for (const ev of events) {
    if (ev.type === 'loopOpen') {
      if (stack.length > 0) {
        throw new ParseError(ev.line, `パート${partLetter}: ネストしたローカルループは v1 非対応です`);
      }
      stack.push(ev);
    } else if (ev.type === 'loopExit') {
      if (stack.length === 0) {
        throw new ParseError(ev.line, `パート${partLetter}: 対応する '[' が無い ':' があります`);
      }
      ev.openRef = stack[stack.length - 1];
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

// 音色定義ブロック(ヘッダ1行+オペレータ4行)を lines[li]から読み進める。
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
  const tracks = new Map(); // partLetter -> {events:[], state:{octave, defaultLength}}
  const tones = new Map(); // tonenum -> toneOptions (buildToneEntry用、tonenumはキー側と重複保持)
  const header = {
    title: null, composer: null, arranger: null, memo: [],
    titleLine: null, composerLine: null, arrangerLine: null, memoLines: [],
  };
  const errors = [];
  const lines = source.split(/\r\n|\r|\n/);
  // `C`(全音符長)は全パート共通のグローバル設定(v2 3.8節)。1つの可変オブジェクトを
  // 全パートのtokenizeBody呼び出しで共有する。
  const globalState = { measLen: DEFAULT_MEAS_LEN };

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

    const m = /^([A-Za-z]+)(?:\s+(.*))?$/.exec(trimmed);
    if (!m) {
      errors.push({ line: lineNo, message: `行はパート指定(A-I)または音色定義(@)で始まる必要があります: "${trimmed}"` });
      continue;
    }
    const letters = m[1];
    const body = m[2] ?? '';
    const partLetters = [];
    for (const ch of letters) {
      const upper = ch.toUpperCase();
      if (!PART_LETTERS.includes(upper)) {
        errors.push({
          line: lineNo,
          message: `未対応のパート指定です: '${ch}'（FM1-6=A-F, SSG1-3=G-I, ADPCM=J に対応。K/Rリズム・PPZ8拡張パートは未解明のため対象外）`,
        });
        continue;
      }
      partLetters.push(upper);
    }
    if (partLetters.length === 0) continue;

    for (const p of partLetters) {
      if (!tracks.has(p)) {
        tracks.set(p, { events: [], state: { octave: 4, defaultLength: 24 } });
      }
    }

    try {
      // 同じ行を複数パートへ流す場合、各パートの state(o/l)は独立に進行する
      // (PMD慣習通り。パートごとに別オブジェクトへ積む必要があるため、パートごとに1回ずつ字句解析する)
      for (const p of partLetters) {
        const trackInfo = tracks.get(p);
        tokenizeBody(body, lineNo, trackInfo.state, trackInfo.events, PART_KIND[p], globalState);
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
  }

  const trackEvents = new Map();
  for (const [p, info] of tracks) trackEvents.set(p, info.events);
  return { tracks: trackEvents, tones, header, errors };
}
