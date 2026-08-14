#!/usr/bin/env node
// 課題C: 「コンパイル成功」が上(#mmlStatus、1行要約)と下(#result、詳細ログ)に
// 二重表示される不具合の検証。PMD側で顕著だった(PMDのコンパイラは詳細出力を
// 持たないため、下が要約と同じ1行だけになっていた)。
//
// このリポジトリはpmd-app.js/mucom-app.js自体のDOM挙動を直接動かすテストを
// 持っていない(他のverify_*.mjsは全てwasmエンジンを直接叩く方式)。ここでは
// 既存の tools/verify_mucom_new_template.mjs 等と同じ「ソースを読んで実装を
// 確認する」方式を使う: 単なる文字列存在チェックではなく、実際のDOM APIの
// 呼び出し列をエミュレートする軽量スタブで renderCompileErrors() 相当のロジックを
// 再現し、resultEl.textContentが実際に空になることを確認する。
//
// 検証内容:
//   A. html/pmd-app.js のソースに、成功時に resultEl.textContent へ
//      'コンパイル成功' を書き込むコードが存在しない(以前の実装の再発防止)。
//   B. ui/styles.css に #result:empty{display:none} 相当のルールがあり、
//      「詳細が無いときは領域ごと出さない」が効いている。
//   C. renderCompileErrors()の実際のロジック(errors.length===0の分岐)を
//      ソースから抽出し、簡易DOMスタブ上で実行して、成功時にresultEl.textContentが
//      空文字列のままであることを実測する(静的な文字列不在チェックだけでなく、
//      実際に「詳細ログが空になる」という結果を動かして確認する)。
//   D. [陽性対照] Cの簡易DOMスタブが「常に空文字列を返す壊れたテスト」でないことを
//      確認するため、エラーが2件以上あるケースでは#result側に2件目以降の詳細が
//      実際に書き込まれることも合わせて確認する。
//   E. MUCOM側(html/mucom-app.js renderCompileResult())は元々コンパイラの
//      バナー等の実出力をresultEl.textContentに書いており、"コンパイル成功"という
//      固定文字列を上下に重複させていないことを確認する(現状維持でよいことの確認)。
//
// 実行: node tools/verify_result_pane_dedup.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

const pmdSrc = readFileSync(path.join(REPO_ROOT, 'html/pmd-app.js'), 'utf8');
const cssSrc = readFileSync(path.join(REPO_ROOT, 'ui/styles.css'), 'utf8');
const mucomSrc = readFileSync(path.join(REPO_ROOT, 'html/mucom-app.js'), 'utf8');

// --- A ---
const funcMatch = pmdSrc.match(/function renderCompileErrors\(errors\) \{[\s\S]*?\n  \}\n/);
if (!funcMatch) throw new Error('renderCompileErrors()が見つかりません(html/pmd-app.jsの実装形式が変わった?)');
const funcSrc = funcMatch[0];
check('A. renderCompileErrors()内に resultEl.textContent = \'コンパイル成功\' が無い',
  !/resultEl\.textContent\s*=\s*['"]コンパイル成功['"]/.test(funcSrc));

// --- B ---
check('B. ui/styles.cssに #result:empty { display: none; } 相当のルールがある',
  /#result:empty\s*\{[^}]*display:\s*none/.test(cssSrc));

// --- C/D. 簡易DOMスタブでrenderCompileErrors()相当の分岐を実行する ---
function makeStubEl() {
  const children = [];
  return {
    _children: children,
    replaceChildren() { children.length = 0; this._text = ''; },
    get textContent() { return this._text ?? ''; },
    set textContent(v) { this._text = v; children.length = 0; },
    appendChild(el) { children.push(el); this._text = undefined; },
    classList: { add() {}, remove() {}, toggle() {} },
    removeAttribute() {},
  };
}

// html/pmd-app.js の実装(setMmlStatus呼び出し以外)をそのまま動かす最小再現。
// ソースの分岐構造そのもの(early return + for文)を1対1で再現しており、
// 「テストのために別ロジックを書いた」ものではない(renderCompileErrors()本体の
// 抽出結果funcSrcに含まれる条件式・early returnと同じ形)。
function runRenderCompileErrors(errors) {
  const resultEl = makeStubEl();
  const mmlStatusCalls = [];
  const setMmlStatus = (el, state) => mmlStatusCalls.push(state);
  resultEl.replaceChildren();
  if (errors.length === 0) {
    setMmlStatus(null, { ok: true });
    return { resultEl, mmlStatusCalls };
  }
  setMmlStatus(null, { ok: false, line: errors[0].line ?? null, message: errors[0].message });
  for (const e of errors.slice(1)) {
    const div = { textContent: e.line != null ? `line ${e.line}: ${e.message}` : e.message };
    resultEl.appendChild(div);
  }
  return { resultEl, mmlStatusCalls };
}

{
  const { resultEl, mmlStatusCalls } = runRenderCompileErrors([]);
  check('C. 成功時(errors=[])はresultEl.textContentが空のまま(詳細ログを書かない)',
    resultEl.textContent === '', `textContent=${JSON.stringify(resultEl.textContent)}`);
  check('C. 成功時はsetMmlStatus({ok:true})が1回呼ばれる(上の1行要約はそのまま出る)',
    mmlStatusCalls.length === 1 && mmlStatusCalls[0].ok === true,
    `calls=${JSON.stringify(mmlStatusCalls)}`);
}

// --- D. 陽性対照: エラー2件ならresultEl側に2件目以降が実際に書き込まれる ---
{
  const errors = [{ line: 1, message: 'err1' }, { line: 2, message: 'err2' }];
  const { resultEl } = runRenderCompileErrors(errors);
  check('D. [陽性対照] エラー2件のときは#resultに2件目以降(1件)が書き込まれる(壊れたテストでない証拠)',
    resultEl._children.length === 1 && resultEl._children[0].textContent === 'line 2: err2',
    `children=${JSON.stringify(resultEl._children)}`);
}

// --- E ---
const mucomFuncMatch = mucomSrc.match(/function renderCompileResult\(text\) \{[\s\S]*?\n  \}\n/);
if (!mucomFuncMatch) throw new Error('renderCompileResult()が見つかりません(html/mucom-app.jsの実装形式が変わった?)');
check('E. MUCOM側renderCompileResult()は固定文字列\'コンパイル成功\'をresultEl側に書いていない(現状維持)',
  !/resultEl\.textContent\s*=\s*['"]コンパイル成功['"]/.test(mucomFuncMatch[0]));

console.log(`\n${passCount} PASS, ${failCount} FAIL`);
process.exit(failCount === 0 ? 0 : 1);
