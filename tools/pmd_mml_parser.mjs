// PMD MML パーサ(v1)。文字列 → 中間表現(パートごとのイベント列)。
//
// 対応範囲は docs/pmd-compiler-spec.md 2.1節の v1 範囲のうち、今回(第2・3段階)の担当分:
//   音符・休符・オクターブ(o/</>)・タイ(&)・音長(数値/付点/%)・テンポ(t/T)・
//   ローカルループ([ : ]n)・全体ループ(L)・音色選択(@n、第1段階からの継続利用)。
// v1範囲外(リズム・ADPCM・PPZ8・FM3拡張・LFO・ポルタメント・パン・音量v/V等)は対象外。
//
// パート行の形式は PMD の慣習に合わせ「行頭にパート文字(A-F)を1つ以上並べ、
// 空白の後にコマンド列を書く」("ABC t120 o4 cdefg" のように複数パートへ同じ内容を流せる)。
// v1ではパート文字は FM1-6 = A-F のみ受理する(SSG/ADPCM/リズム等は次段階以降、
// docs 4章の段取り通り)。
//
// エラーはすべて {line, message} 形式(1-indexed行番号)で返す。エディタのエラー行
// ジャンプに使う想定(MUCOM側の `in line N.` 相当)。

export const PART_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F']; // FM1-6 (doc 1.2節の順)
export const NOTE_LETTER_TO_BASE_INDEX = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const MEAS_LEN = 96; // 全音符長。v1は固定(doc 1.3節)。

class ParseError extends Error {
  constructor(line, message) {
    super(message);
    this.line = line;
    this.pmdMessage = message;
  }
}

// 数値長 → クロック値。96の約数のみ許容(PMDMML.MAN §2-11、doc 1.3節)。
function numericLengthToClocks(n, line) {
  if (n <= 0 || MEAS_LEN % n !== 0) {
    throw new ParseError(line, `音長 ${n} は96の約数ではありません(全音符長96固定, v1)`);
  }
  return MEAS_LEN / n;
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
function tokenizeBody(body, line, state, events) {
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
      clocks = numericLengthToClocks(parseInt(m[0], 10), line);
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
      let clocks = numericLengthToClocks(parseInt(m[0], 10), line);
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

// MML全文をパースする。戻り値: { tracks: Map<partLetter, events[]>, errors: [{line,message}] }
// 複数パートに同じ行が指定された場合、各パートに同じイベント列(参照は別オブジェクト)を積む。
export function parseMml(source) {
  const tracks = new Map(); // partLetter -> {events:[], state:{octave, defaultLength}}
  const errors = [];
  const lines = source.split(/\r\n|\r|\n/);

  for (let li = 0; li < lines.length; li++) {
    const lineNo = li + 1;
    let raw = lines[li];
    const commentIdx = raw.indexOf(';');
    if (commentIdx >= 0) raw = raw.slice(0, commentIdx);
    const trimmed = raw.trim();
    if (trimmed === '') continue;

    const m = /^([A-Za-z]+)(?:\s+(.*))?$/.exec(trimmed);
    if (!m) {
      errors.push({ line: lineNo, message: `行はパート指定(A-F)で始まる必要があります: "${trimmed}"` });
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
          message: `未対応のパート指定です: '${ch}'（v1は FM1-6=A-F のみ。SSG/ADPCM/リズム等は次段階）`,
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
        tokenizeBody(body, lineNo, trackInfo.state, trackInfo.events);
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
  return { tracks: trackEvents, errors };
}
