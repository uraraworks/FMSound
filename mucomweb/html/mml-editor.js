// MML用の簡易コードエディタ配線(行番号ガター+構文色つけ+現在行ハイライト)。
//
// 方針(指示により決定済み): CodeMirror/Monaco等の外部ライブラリは使わない。
// contenteditableも使わない(IME変換中の挙動が不安定になるため)。
// 入力を受けるのは本物の<textarea>のまま、背面に色付きの<pre>を重ねる
// 「透明テキストのtextarea + 背面pre」方式(react-simple-code-editor等で
// 知られる標準的な実装パターン)。
//
// トークン定義はmml-tokens.jsに集約してあり、この中にMML固有の判断は
// 一切書かない(PMD用にルールセットを差し替えるだけで使い回せる)。

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const stickyCache = new WeakMap();
function getSticky(rule) {
  let re = stickyCache.get(rule);
  if (!re) {
    // sticky(y)フラグ下では'^'は(multilineでない限り)「文字列先頭」を指し、
    // 「lastIndexの位置」とは別物になる。lastIndex>0の位置でマッチさせるには
    // '^'とyフラグが競合してしまうため、mml-tokens.js側の可読性のための先頭'^'を
    // ここで取り除く(sticky自体が位置固定の役目を担うので不要になる)。
    // 実測でこの取り違えに気づいた: 200文字連続する音符のうち先頭の1文字しか
    // 色が付かない不具合が発生していた。
    const source = rule.regex.source.replace(/^\^/, '');
    re = new RegExp(source, 'y');
    stickyCache.set(rule, re);
  }
  return re;
}

// 1文字ずつ<span>で区切ると、連続する等幅フォントの文字列が"1本のテキストラン"
// として測定されなくなり、文字境界ごとの端数px丸めが積み重なって
// textarea側(1本のテキストラン)とscrollWidthがずれる(実測: 200文字の連続音符で
// 8pxのズレを確認)。同じ種別のトークンが連続する場合は1つの<span>にまとめて
// テキストランの分断を最小限にすることでこれを防ぐ。
function tokenizeRest(rest, rules) {
  // まずトークン配列を作る({type: 'note'|...|null, text})。
  const tokens = [];
  let i = 0;
  while (i < rest.length) {
    let matched = null;
    for (const rule of rules) {
      const re = getSticky(rule);
      re.lastIndex = i;
      const m = re.exec(rest);
      if (m) {
        matched = { type: rule.type, text: m[0] };
        break;
      }
    }
    if (matched && matched.text.length > 0) {
      tokens.push(matched);
      i += matched.text.length;
    } else {
      tokens.push({ type: null, text: rest[i] });
      i += 1;
    }
  }
  // 隣接する同種別トークンを1つにまとめる(スパン分割による端数px丸めの蓄積を防ぐ)。
  const merged = [];
  for (const t of tokens) {
    const last = merged[merged.length - 1];
    if (last && last.type === t.type) {
      last.text += t.text;
    } else {
      merged.push({ type: t.type, text: t.text });
    }
  }
  let out = '';
  for (const t of merged) {
    out += t.type
      ? `<span class="mml-tok-${t.type}">${escapeHtml(t.text)}</span>`
      : escapeHtml(t.text);
  }
  return out;
}

function renderLine(line, rules) {
  // マクロ定義行("#nn{..."): ヘッダタグ扱いしない(cmucom.cpp hasMacro()の判定を
  // そのまま踏襲)。マクロ独自の色分けは仕様未確認のため付けない(素通し)。
  if (rules.macroHeaderRe.test(line)) {
    return escapeHtml(line);
  }
  const trimmed = line.replace(/^[ \t]*/, '');
  if (trimmed.startsWith('#')) {
    // ヘッダ行: 先頭空白 + '#タグ名' + 残りの値、の3分割。
    const leadingLen = line.length - trimmed.length;
    const leading = line.slice(0, leadingLen);
    const rest = line.slice(leadingLen); // '#'以降
    const tagMatch = rest.match(/^#[A-Za-z][A-Za-z0-9_]*|^#/);
    const tagText = tagMatch ? tagMatch[0] : '#';
    const valueText = rest.slice(tagText.length);
    return (
      escapeHtml(leading) +
      `<span class="mml-tok-tag">${escapeHtml(tagText)}</span>` +
      `<span class="mml-tok-tagvalue">${escapeHtml(valueText)}</span>`
    );
  }
  // データ行: 行頭のパート文字(A~K)を切り出してから残りをトークン化する。
  const partMatch = line.match(rules.partLetterRe);
  let out = '';
  let rest = line;
  if (partMatch) {
    const [full, leadingSpace, letter] = partMatch;
    out += escapeHtml(leadingSpace) + `<span class="mml-tok-part">${escapeHtml(letter)}</span>`;
    rest = line.slice(full.length);
  }
  out += tokenizeRest(rest, rules.tokenRules);
  return out;
}

export function renderMmlHighlight(text, rules) {
  return text
    .split('\n')
    .map((line) => renderLine(line, rules))
    .join('\n');
}

/**
 * <textarea>に行番号ガター+背面ハイライト+現在行ハイライトを配線する。
 * @param {Object} opts
 * @param {HTMLTextAreaElement} opts.textarea
 * @param {HTMLElement} opts.gutterInner   - 行番号を描画する要素(縦スクロールのみ同期)
 * @param {HTMLElement} opts.highlightCode - 色付きHTMLを描画する<code>要素
 * @param {HTMLElement} opts.highlightPre  - <pre>要素本体(scrollTop/Left同期対象)
 * @param {HTMLElement} opts.currentLineEl - 現在行ハイライト用の帯要素
 * @param {{tokenRules: Array, macroHeaderRe: RegExp, partLetterRe: RegExp}} opts.rules
 */
export function setupMmlEditor(opts) {
  const { textarea, gutterInner, highlightCode, highlightPre, currentLineEl, rules } = opts;

  function lineHeightPx() {
    const cs = getComputedStyle(textarea);
    const lh = parseFloat(cs.lineHeight);
    return Number.isFinite(lh) ? lh : parseFloat(cs.fontSize) * 1.2;
  }

  function renderGutter(lineCount) {
    let html = '';
    for (let i = 1; i <= lineCount; i++) {
      html += `<div class="mml-gutter-line">${i}</div>`;
    }
    gutterInner.innerHTML = html;
  }

  function render() {
    const text = textarea.value;
    highlightCode.innerHTML = renderMmlHighlight(text, rules) + '\n';
    const lineCount = text.length === 0 ? 1 : text.split('\n').length;
    renderGutter(lineCount);
    updateCurrentLine();
    syncScroll();
  }

  function currentLineNumber() {
    const pos = textarea.selectionStart ?? 0;
    const before = textarea.value.slice(0, pos);
    return before.split('\n').length; // 1-based
  }

  function updateCurrentLine() {
    const line = currentLineNumber();
    const lh = lineHeightPx();
    currentLineEl.style.transform = `translateY(${(line - 1) * lh}px)`;
    currentLineEl.style.height = `${lh}px`;
    const gutterLines = gutterInner.children;
    for (let i = 0; i < gutterLines.length; i++) {
      gutterLines[i].classList.toggle('mml-gutter-line-current', i + 1 === line);
    }
  }

  function syncScroll() {
    highlightPre.scrollTop = textarea.scrollTop;
    highlightPre.scrollLeft = textarea.scrollLeft;
    gutterInner.style.transform = `translateY(${-textarea.scrollTop}px)`;
  }

  textarea.addEventListener('input', render);
  textarea.addEventListener('scroll', syncScroll);
  textarea.addEventListener('click', updateCurrentLine);
  textarea.addEventListener('keyup', updateCurrentLine);
  textarea.addEventListener('select', updateCurrentLine);

  render();

  return {
    render,
    /** 1-based行番号へジャンプし、選択・スクロール・現在行ハイライトを更新する。 */
    jumpToLine(line) {
      const lines = textarea.value.split('\n');
      const clamped = Math.max(1, Math.min(line, lines.length));
      let offset = 0;
      for (let i = 0; i < clamped - 1; i++) offset += lines[i].length + 1;
      const lineLen = lines[clamped - 1].length;
      textarea.focus();
      textarea.setSelectionRange(offset, offset + lineLen);
      const lh = lineHeightPx();
      const targetTop = (clamped - 1) * lh;
      const visibleH = textarea.clientHeight;
      // 対象行が見えていない場合だけスクロールする(見えているのに動かすと
      // 利用者の閲覧位置を無駄に乱すため)。
      if (targetTop < textarea.scrollTop || targetTop + lh > textarea.scrollTop + visibleH) {
        textarea.scrollTop = Math.max(0, targetTop - visibleH / 2);
      }
      syncScroll();
      updateCurrentLine();
    },
  };
}

// エラー出力からの行番号抽出。cmucom.cpp CMucom::Compile()の実装
// ( "#error %d in line %d." / "#unknown error in line %d." )を実測して確認した
// 書式のみを対象にする。それらしい行へのジャンプ(推測)は行わない: マッチしなければ
// nullを返し、呼び出し側は行ジャンプ機能自体を出さない。
const ERROR_LINE_RE = /error\s+.*?in\s+line\s+(\d+)/i;
export function extractErrorLine(compileResultText) {
  if (!compileResultText) return null;
  const m = compileResultText.match(ERROR_LINE_RE);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
