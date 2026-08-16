// 課題(共有UI): ツールバーの「リンクをコピー」ボタンと、常時表示の「共有可能カウンタ」
// (文字数+ゲージ)、コピー失敗時のフォールバック欄、MUCOM88の音色バンク依存警告を
// 組み立てる。エンコード/デコード本体(net/share-link.js、bbbd642で実装済み)は一切
// 変更しない。ここが持つのはUI(HTML/DOM)配線と、その配線から呼ばれる薄い状態管理だけ。
//
// 設計方針(利用者指示):
//   - カウンタは「打鍵のたびに計算しない」。コンパイル(再生)時にだけ集計し、
//     mmlDirty が真の間は「未集計」表示にする(古い数字を残さない)。
//   - 共有ボタンを押した瞬間には必ず再計算する(直近の集計より後に編集された
//     可能性があるため。テキストが同じなら再計算は省く)。
//   - ゲージの見た目はfmdsp/rightpane.jsが既に持つバー表現(背景トラック+塗り、
//     色は暗い色→明るい色)に合わせる。新しい意匠は作らない(ui/styles.cssの
//     .share-counter-gauge*参照)。
//
// テスト容易性のため、DOM非依存の「状態遷移・整形」部分(このファイル前半)と、
// 実際にDOMを組み立てる部分(createShareControls()、後半)を分離してある。
// tools/verify_share_ui.mjs は前半だけを対象に検証する(ブラウザ/DOM不要)。

import { buildShareUrl, shareLinkLengthStatus, SHARE_LINK_URL_LIMIT } from '../net/share-link.js';
import { t } from './i18n.js';
import { ICONS, iconButton } from './icons.js';

// ============================================================================
// DOM非依存: 状態・整形(tools/verify_share_ui.mjsの対象)
// ============================================================================

/** カウンタの「未集計」状態(mmlDirtyが真の間・まだ一度もコンパイルしていない間)。 */
export const SHARE_COUNTER_PENDING = Object.freeze({ kind: 'pending' });

/**
 * 集計済み状態を作る。lengthは共有URL全体の文字数(net/share-link.js buildShareUrl()の
 * 戻り値.lengthそのもの。フラグメントだけでなく`?driver=`等を含む全長)。
 * @param {string} url
 * @param {number} length
 */
export function shareCounterStateFor(url, length) {
  return { kind: 'ready', url, length, status: shareLinkLengthStatus(length) };
}

/** 3桁区切りのカンマを入れる(利用者指示の表示例「4,231字」に合わせる)。 */
export function formatThousands(n) {
  return Math.trunc(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** カウンタのテキスト表示(「2344 / 4000」/未集計時は「— / 4000」)。 */
export function formatShareCounterText(state) {
  if (state.kind !== 'ready') return `— / ${formatThousands(SHARE_LINK_URL_LIMIT)}`;
  return `${formatThousands(state.length)} / ${formatThousands(state.status.limit)}`;
}

/** ゲージの塗り率(0〜1、上限を超えても1で頭打ち)。未集計時は0(空のゲージ)。 */
export function shareCounterGaugeRatio(state) {
  if (state.kind !== 'ready') return 0;
  return Math.max(0, Math.min(1, state.length / state.status.limit));
}

/** 上限超過かどうか。未集計時はfalse(まだ超過と分かっていないため)。 */
export function isShareOverLimit(state) {
  return state.kind === 'ready' && state.status.overLimit;
}

/**
 * 上限超過時の文言(「4,231字／上限4,000字。231字ぶん超えています」相当)。
 * 超過していない/未集計のときはnull。
 */
export function formatShareOverLimitMessage(state) {
  if (!isShareOverLimit(state)) return null;
  return t('share.overLimit', {
    length: formatThousands(state.length),
    limit: formatThousands(state.status.limit),
    overBy: formatThousands(state.status.overBy),
  });
}

/**
 * 共有カウンタの再計算を安全に行うヘルパー(DOM操作はonUpdateコールバックに委譲)。
 * 呼び出しごとにgenerationを進め、後発の呼び出しが完了する前に別の呼び出しが
 * 始まった場合、古い方の結果は捨てる(mmlDirtyがtrue→false→trueと素早く
 * 変化する場合の対策。net/share-link.jsの圧縮は非同期なので、呼び出し順と
 * 完了順が入れ替わりうる)。
 *
 * @param {{ driver: 'pmd'|'mucom', getBaseHref: () => string, onUpdate: (state: object) => void }} opts
 */
export function createShareCounterRecomputer({ driver, getBaseHref, onUpdate }) {
  let generation = 0;
  let lastText = null;
  let lastState = SHARE_COUNTER_PENDING;

  function setPending() {
    generation += 1; // 進行中の再計算があれば結果を無視させる
    lastText = null;
    lastState = SHARE_COUNTER_PENDING;
    onUpdate(lastState);
  }

  /**
   * @param {string} mmlText
   * @param {{ force?: boolean }} [opts2] - forceがtrueなら、textが前回と同じでも再計算する
   * @returns {Promise<object>} 再計算後(または省略時は既存)の状態
   */
  async function recompute(mmlText, opts2 = {}) {
    if (!opts2.force && mmlText === lastText && lastState.kind === 'ready') {
      return lastState; // 変わっていなければ再計算を省く(利用者指示)
    }
    const myGeneration = ++generation;
    const { url, length } = await buildShareUrl({ mmlText, driver, baseHref: getBaseHref() });
    if (myGeneration !== generation) return lastState; // 古い呼び出しは無視
    lastText = mmlText;
    lastState = shareCounterStateFor(url, length);
    onUpdate(lastState);
    return lastState;
  }

  return { setPending, recompute, getState: () => lastState };
}

/**
 * クリップボードへのコピーを試みる、DOM非依存の薄いラッパー。copyFnが例外を投げても
 * rejectしても、失敗としてfalseを返す(呼び出し側でtry/catchを重複させないため)。
 * @param {string} url
 * @param {(text: string) => Promise<any>} copyFn
 * @returns {Promise<boolean>}
 */
export async function attemptCopyShareUrl(url, copyFn) {
  try {
    await copyFn(url);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// DOM組み立て(ui/download-menu.jsと同じ「呼び出し元のtoolbar/DOMへ差し込む」作法)
// ============================================================================

/**
 * @param {Object} opts
 * @param {'pmd'|'mucom'} opts.driver          - buildShareUrl()の?driver=に使う値
 * @param {string} opts.driverKey              - 要素id衝突回避用(driverと同じ値でよい)
 * @param {() => string} opts.getMmlText       - 現在のMMLソース文字列を返す
 * @param {() => boolean} [opts.isVoiceBankApplied] - MUCOM88のみ: ディスク固有音色バンク使用中ならtrue
 * @param {() => string} [opts.getBaseHref]    - 既定はlocation.href(検証しやすいよう差し替え可能にする)
 * @param {(text: string) => Promise<any>} [opts.copyFn] - 既定はnavigator.clipboard.writeText
 */
export function createShareControls(opts) {
  const {
    driver, driverKey, getMmlText,
    isVoiceBankApplied = () => false,
    getBaseHref = () => location.href,
    copyFn = (text) => navigator.clipboard.writeText(text),
  } = opts;

  // --- ボタン(ツールバーへ挿入する。他の共通ボタンと同じui/icons.js iconButton()で作る)。
  const buttonEl = iconButton(ICONS.share, t('toolbar.share'));
  buttonEl.id = `btnShare-${driverKey}`;

  // --- カウンタ(数字+ゲージ、常時表示。ツールバー内、ボタンの隣に置く) ---
  const counterEl = document.createElement('div');
  counterEl.className = 'share-counter';
  counterEl.id = `shareCounter-${driverKey}`;
  counterEl.innerHTML = `
    <span class="share-counter-label"></span>
    <span class="share-counter-text"></span>
    <span class="share-counter-gauge"><span class="share-counter-gauge-fill"></span></span>
  `;
  const labelEl = counterEl.querySelector('.share-counter-label');
  const textEl = counterEl.querySelector('.share-counter-text');
  const gaugeFillEl = counterEl.querySelector('.share-counter-gauge-fill');
  labelEl.textContent = t('share.counterLabel');

  // --- コピー結果表示(成功メッセージ/警告)+ コピー失敗時のみ出すフォールバック欄 ---
  // 普段は両方非表示。toolbar.insertAdjacentElement('afterend', ...)で
  // console-footer内、ツールバーの直後に置く想定(呼び出し側で行う)。
  const resultWrapEl = document.createElement('div');
  resultWrapEl.className = 'share-result hidden';
  resultWrapEl.id = `shareResult-${driverKey}`;
  resultWrapEl.innerHTML = `
    <p class="share-result-message" id="shareResultMessage-${driverKey}"></p>
    <p class="share-result-warning hidden" id="shareResultWarning-${driverKey}"></p>
    <input type="text" class="share-fallback-input hidden" id="shareFallbackInput-${driverKey}" readonly>
  `;
  const messageEl = resultWrapEl.querySelector(`#shareResultMessage-${driverKey}`);
  const warningEl = resultWrapEl.querySelector(`#shareResultWarning-${driverKey}`);
  const fallbackInputEl = resultWrapEl.querySelector(`#shareFallbackInput-${driverKey}`);
  fallbackInputEl.setAttribute('aria-label', t('share.fallbackInputAriaLabel'));
  // 読み取り専用の1行欄: フォーカスで全選択(利用者指示、コピーの近道として機能させる)。
  fallbackInputEl.addEventListener('focus', () => fallbackInputEl.select());

  function renderCounter(state) {
    if (state.kind !== 'ready') {
      textEl.textContent = t('share.counterPending');
      counterEl.title = t('share.counterPendingAriaLabel');
      counterEl.setAttribute('aria-label', counterEl.title);
      gaugeFillEl.style.width = '0%';
      gaugeFillEl.classList.remove('share-counter-gauge-fill--over');
      buttonEl.disabled = false;
      buttonEl.title = t('toolbar.share');
      buttonEl.setAttribute('aria-label', buttonEl.title);
      return;
    }
    textEl.textContent = formatShareCounterText(state);
    const overLimit = isShareOverLimit(state);
    counterEl.title = overLimit
      ? formatShareOverLimitMessage(state)
      : t('share.counterAriaLabel', { length: formatThousands(state.length), limit: formatThousands(state.status.limit) });
    counterEl.setAttribute('aria-label', counterEl.title);
    gaugeFillEl.style.width = `${Math.round(shareCounterGaugeRatio(state) * 100)}%`;
    gaugeFillEl.classList.toggle('share-counter-gauge-fill--over', overLimit);
    buttonEl.disabled = overLimit;
    buttonEl.title = overLimit ? formatShareOverLimitMessage(state) : t('toolbar.share');
    buttonEl.setAttribute('aria-label', buttonEl.title);
  }

  renderCounter(SHARE_COUNTER_PENDING);

  const recomputer = createShareCounterRecomputer({ driver, getBaseHref, onUpdate: renderCounter });

  function markDirty() {
    recomputer.setPending();
  }

  /** コンパイル(再生)成功時に呼ぶ。集計だけ行い、コピーはしない。 */
  function markCompiled(mmlText) {
    recomputer.recompute(mmlText).catch((err) => {
      // 集計(URL生成)自体の失敗はUIを壊さない程度に留める(共有ボタン押下時に
      // 改めて再計算されるため、ここでは黙って未集計のままにする)。
      console.error('[share-controls] recompute failed:', err);
    });
  }

  async function handleShareClick() {
    if (buttonEl.disabled) return;
    const mmlText = getMmlText();
    const state = await recomputer.recompute(mmlText); // 押した瞬間に必ず再計算(利用者指示)
    if (isShareOverLimit(state)) return; // renderCounter()側で既にボタンは無効化されている
    const copied = await attemptCopyShareUrl(state.url, copyFn);
    messageEl.textContent = copied ? t('share.copied') : t('share.copyFailed');
    // 課題C: 常時出す注意書きにはしない(利用者指示)。共有時、かつ実際にディスク
    // 固有の音色バンクが適用されている場合だけ出す。
    const warn = isVoiceBankApplied();
    warningEl.textContent = warn ? t('share.voiceBankWarning') : '';
    warningEl.classList.toggle('hidden', !warn);
    resultWrapEl.classList.remove('hidden');
    fallbackInputEl.classList.toggle('hidden', copied);
    if (!copied) {
      fallbackInputEl.value = state.url;
      fallbackInputEl.focus();
      fallbackInputEl.select();
    }
  }
  buttonEl.addEventListener('click', handleShareClick);

  return { buttonEl, counterEl, resultWrapEl, markDirty, markCompiled };
}
