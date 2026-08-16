#!/usr/bin/env node
// 実機報告(2026-08-17)の検証: 「共有リンクをコピー→別の曲へ切り替えても
// 『コピーしました』表示/コピー失敗時のURLテキスト欄が前の曲のまま残る」不具合。
//
// ui/share-controls.js createShareControls() は実DOM(document)を組み立てる
// 関数だが、そのDOM操作はclassList/textContent/value/setAttribute/append程度の
// ごく基本的な操作しか使わない(innerHTML+querySelector()は2026-08-17の修正で
// document.createElement()の積み上げへ置き換え済み、ui/share-controls.js冒頭の
// コメント参照)。そのため、ブラウザ/JSDOM無しでも「最小限のDOMスタブ」があれば
// createShareControls()自体を実際に呼び出して検証できる。
// tools/verify_share_ui.mjs(DOM非依存の純粋関数だけを対象)と違い、こちらは
// 「呼び出し元(html/mucom-app.js・html/pmd-app.js)が実際に呼ぶ関数
// (markDirty()/markCompiled()/共有ボタンのクリックハンドラ)を通した結果、
// カウンタ・コピー結果メッセージ・音色バンク警告・フォールバックURL欄の4つが
// 期待どおりDOMへ反映されるか」を検証する(実機報告で見つかった不具合は
// まさにこの「反映され忘れ」だったため)。
//
// 検証する経路(実機報告に列挙された全経路を、markDirty()/markCompiled()という
// 実際の呼び出し口を通して検証する。1つだけ試して終わらせない):
//   1. 打鍵相当(markDirty())
//   2. 新規作成相当(markDirty())
//   3. サンプル読み込み相当(markDirty())
//   4. ファイルから開く相当(PMDのplayBytes()が呼ぶmarkDirty())
//   5. ライブラリから開く相当(PMDのplayBytes()/MUCOMのapplyMmlBytes()が呼ぶmarkDirty())
//   6. 共有リンク読み込み相当(markDirty())
//   ↑ mucom-app.js/pmd-app.js側では全て同じ shareControls.markDirty() 呼び出しへ
//     集約されている(html/mucom-app.js・html/pmd-app.jsの該当コメント参照)。
//     この検証では「その集約先(markDirty())を呼べば、実際にDOM上の3表示
//     (カウンタ・コピー結果・フォールバック欄)が揃って消えるか」を確認する。
//     経路ごとに別々の配線ミスが無いことは、コード側で全経路が同じ
//     markDirty()/markCompiled()だけを呼んでいることをテキスト検索で確認済み
//     (html/mucom-app.js・html/pmd-app.jsのコメント「共有可能カウンタ:」を参照)。
//   7. コピー失敗時のフォールバックURL欄も同様に、次の共有で(または曲を
//      変えた時点で)消えること。
//
// 実行: node tools/verify_share_controls_dom.mjs

import { setLang } from '../ui/i18n.js';

setLang('ja');

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passed++; else failed++;
  console.log(`[${mark}] ${label}${detail !== undefined ? '\n       ' + detail : ''}`);
}

// ============================================================
// 最小限のDOMスタブ(classList/textContent/value/style/setAttribute/append/
// addEventListener程度のみ。innerHTMLは文字列を保持するだけで解釈しない)。
// ============================================================
class StubClassList {
  constructor() { this.tokens = new Set(); }
  add(...c) { for (const x of c) this.tokens.add(x); }
  remove(...c) { for (const x of c) this.tokens.delete(x); }
  toggle(c, force) {
    if (force === undefined) {
      if (this.tokens.has(c)) { this.tokens.delete(c); return false; }
      this.tokens.add(c); return true;
    }
    if (force) this.tokens.add(c); else this.tokens.delete(c);
    return force;
  }
  contains(c) { return this.tokens.has(c); }
}

function makeStubElement(tag) {
  const attrs = {};
  const listeners = {};
  const el = {
    tagName: tag,
    children: [],
    style: {},
    classList: new StubClassList(),
    _textContent: '',
    _innerHTML: '',
    get textContent() { return this._textContent; },
    set textContent(v) { this._textContent = v; },
    get innerHTML() { return this._innerHTML; },
    set innerHTML(v) { this._innerHTML = v; }, // 解釈はしない(このテストでは使わない)
    append(...nodes) { this.children.push(...nodes); },
    appendChild(node) { this.children.push(node); return node; },
    setAttribute(name, value) { attrs[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((f) => f !== fn);
    },
    // 戻り値の配列を返す(async関数リスナーが返すPromiseを呼び出し側が
    // 確実に待てるようにするため。ネイティブDOMのdispatchEvent()には無い挙動だが、
    // このスタブはテストの同期待ち専用なので割り切る)。
    dispatch(type) { return (listeners[type] || []).slice().map((fn) => fn({ target: el })); },
    focus() {},
    select() {},
    click() { this.dispatch('click'); },
  };
  return el;
}

globalThis.document = {
  createElement: (tag) => makeStubElement(tag),
  createElementNS: (_ns, tag) => makeStubElement(tag),
};

// share-controls.jsはtop-levelでdocumentに触れない(関数内でのみ参照)ため、
// グローバルスタブを定義してからimportすれば動く。
const {
  createShareControls,
} = await import('../ui/share-controls.js');

function readState(controls) {
  return {
    counterText: controls.counterEl.children.find((c) => c.className === 'share-counter-text')?.textContent,
    resultHidden: controls.resultWrapEl.classList.contains('hidden'),
    message: controls.resultWrapEl.children.find((c) => c.className === 'share-result-message')?.textContent,
    warningHidden: controls.resultWrapEl.children.find((c) => c.className.includes('share-result-warning'))?.classList.contains('hidden'),
    fallbackHidden: controls.resultWrapEl.children.find((c) => c.tagName === 'input')?.classList.contains('hidden'),
    fallbackValue: controls.resultWrapEl.children.find((c) => c.tagName === 'input')?.value,
    buttonDisabled: controls.buttonEl.disabled,
  };
}

async function newControls({ mmlText, isVoiceBankApplied = () => false, copyFn }) {
  let currentText = mmlText;
  const controls = createShareControls({
    driver: 'mucom',
    driverKey: 'mucom-domtest',
    getMmlText: () => currentText,
    isVoiceBankApplied,
    getBaseHref: () => 'https://uraraworks.github.io/FMSound/',
    copyFn: copyFn ?? (async () => {}),
  });
  return { controls, setText: (t) => { currentText = t; } };
}

async function clickShareButton(controls) {
  // buttonEl.addEventListener('click', handleShareClick) は非同期関数。
  // スタブのdispatch()はリスナーの戻り値(Promise)をそのまま返すので、
  // それを直接awaitすれば「clickイベント発火→handleShareClick完了」まで
  // 取りこぼしなく待てる(推測でtickを重ねるより確実)。
  const results = controls.buttonEl.dispatch('click');
  await Promise.all(results);
}

async function main() {
  console.log('=== tools/verify_share_controls_dom.mjs: 共有UI DOM反映の検証(実DOM不要のスタブ) ===\n');

  // --- 前提確認: コピー成功でメッセージが出て、フォールバックは出ないこと ---
  {
    const { controls } = await newControls({ mmlText: 'A T120 L cdefgab\n', copyFn: async () => {} });
    await controls.markCompiled('A T120 L cdefgab\n');
    await clickShareButton(controls);
    const s = readState(controls);
    check('前提a. コピー成功で「コピーしました」相当のメッセージが出る', s.message === 'コピーしました', `state=${JSON.stringify(s)}`);
    check('前提b. コピー成功時、フォールバック欄は隠れたまま', s.fallbackHidden === true);
  }

  // --- 経路ごとにbaseline(コピー成功状態)を作り、markDirty()/markCompiled()呼び出しで消えるか確認 ---
  const paths = [
    { label: '1. 打鍵相当(markDirty())', run: (c) => c.markDirty() },
    { label: '2. 新規作成相当(markDirty())', run: (c) => c.markDirty() },
    { label: '3. サンプル読み込み相当(markDirty())', run: (c) => c.markDirty() },
    { label: '4. ファイルから開く相当(markDirty())', run: (c) => c.markDirty() },
    { label: '5. ライブラリから開く相当(markDirty())', run: (c) => c.markDirty() },
    { label: '6. 共有リンク読み込み相当(markDirty())', run: (c) => c.markDirty() },
  ];

  for (const path of paths) {
    const { controls, setText } = await newControls({ mmlText: 'A T120 L cdefgab\n', copyFn: async () => {} });
    setText('A T120 L cdefgab\n');
    await controls.markCompiled('A T120 L cdefgab\n');
    await clickShareButton(controls);
    const before = readState(controls);
    if (before.message !== 'コピーしました' || before.resultHidden !== false) {
      check(path.label, false, `baseline確立に失敗: ${JSON.stringify(before)}`);
      continue;
    }
    path.run(controls);
    const after = readState(controls);
    check(path.label,
      after.resultHidden === true && after.message === '' && after.fallbackValue === '' && after.counterText === '未集計',
      `before=${JSON.stringify(before)}\n       after=${JSON.stringify(after)}`);
  }

  // --- 7. コピー失敗時のフォールバックURL欄も、曲を変えたら消えること ---
  {
    const { controls, setText } = await newControls({
      mmlText: 'A T120 L cdefgab\n',
      copyFn: async () => { throw new Error('[test] forced clipboard failure'); },
    });
    setText('A T120 L cdefgab\n');
    await controls.markCompiled('A T120 L cdefgab\n');
    await clickShareButton(controls);
    const failedState = readState(controls);
    check('7a. コピー失敗時、フォールバック欄に値が入る(前提の確認)',
      failedState.fallbackHidden === false && failedState.fallbackValue.length > 0,
      `state=${JSON.stringify(failedState)}`);
    controls.markDirty(); // 曲を変える相当
    const afterState = readState(controls);
    check('7b. コピー失敗後に曲を変えると、フォールバックURL欄も消える',
      afterState.fallbackHidden === true && afterState.fallbackValue === '',
      `state=${JSON.stringify(afterState)}`);
  }

  // --- 8. 音色バンク警告: isVoiceBankApplied()がtrueのときだけ出る ---
  {
    const { controls } = await newControls({ mmlText: 'A T120 L cdefgab\n', isVoiceBankApplied: () => true, copyFn: async () => {} });
    await controls.markCompiled('A T120 L cdefgab\n');
    await clickShareButton(controls);
    const s = readState(controls);
    check('8. voiceBankApplied=trueのとき警告が表示される', s.warningHidden === false, `state=${JSON.stringify(s)}`);
  }
  {
    const { controls } = await newControls({ mmlText: 'A T120 L cdefgab\n', isVoiceBankApplied: () => false, copyFn: async () => {} });
    await controls.markCompiled('A T120 L cdefgab\n');
    await clickShareButton(controls);
    const s = readState(controls);
    check('9. voiceBankApplied=falseのとき警告は出ない', s.warningHidden === true, `state=${JSON.stringify(s)}`);
  }

  console.log(`\n合計: ${passed} PASS / ${failed} FAIL`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
