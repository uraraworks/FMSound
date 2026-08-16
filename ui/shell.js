// WebNP2/WebX68k と同じ「フルスクリーン対象は .stage ではなく .console-card」規約の
// 共有実装。.stage だけを対象にすると、フルスクリーン中にツールバー(.console-footer)が
// カードの外へ置き去りになり操作不能になる(WebX68k src/style.css の該当コメント参照)。
//
// ネイティブ Fullscreen API が使えない/拒否される環境(埋め込みwebview等)向けに、
// body.pseudo-fullscreen によるCSSベースの疑似フルスクリーンへ自動フォールバックする。

const FULLSCREEN_FALLBACK_MS = 400;

function nativeFullscreenSupported(el) {
  const withWebkit = el;
  const doc = document;
  const hasApi =
    typeof el.requestFullscreen === 'function' || typeof withWebkit.webkitRequestFullscreen === 'function';
  const enabled = document.fullscreenEnabled ?? doc.webkitFullscreenEnabled ?? false;
  return hasApi && enabled;
}

function isCardFullscreen(cardEl) {
  return document.fullscreenElement === cardEl || document.webkitFullscreenElement === cardEl;
}

function isPseudoFullscreen() {
  return document.body.classList.contains('pseudo-fullscreen');
}

/**
 * cardEl(.console-card) のフルスクリーン切り替えをボタンに配線する。
 * ボタンの見た目(active状態/title)は fullscreenchange のたびに自動追従する。
 */
export function setupFullscreen(cardEl, btnEl, labels = {}, onChange) {
  const label = labels.enter ?? 'フルスクリーン';
  const labelExit = labels.exit ?? 'フルスクリーン解除';

  function togglePseudoFullscreen(on) {
    document.body.classList.toggle('pseudo-fullscreen', on);
    updateControl();
  }

  function setFullscreen(makeFullscreen) {
    if (makeFullscreen) {
      if (isCardFullscreen(cardEl)) return;
      const req = cardEl.requestFullscreen?.bind(cardEl) ?? cardEl.webkitRequestFullscreen?.bind(cardEl);
      let settled = false;
      Promise.resolve(req?.()).then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
          togglePseudoFullscreen(true);
        },
      );
      window.setTimeout(() => {
        if (settled || isCardFullscreen(cardEl) || isPseudoFullscreen()) return;
        togglePseudoFullscreen(true);
      }, FULLSCREEN_FALLBACK_MS);
    } else if (isCardFullscreen(cardEl)) {
      const exit = document.exitFullscreen?.bind(document) ?? document.webkitExitFullscreen?.bind(document);
      Promise.resolve(exit?.());
    }
  }

  function updateControl() {
    const nativeFs = isCardFullscreen(cardEl);
    const pseudoFs = isPseudoFullscreen();
    const on = nativeFs || pseudoFs;
    btnEl.classList.toggle('active', on);
    btnEl.title = on ? labelExit : label;
    btnEl.setAttribute('aria-label', btnEl.title);
    btnEl.setAttribute('aria-pressed', on ? 'true' : 'false');
    // ネイティブ全画面が拒否され疑似全画面へ自動フォールバックする経路(setFullscreen内の
    // Promise拒否/タイムアウト)は、クリックハンドラの外側(非同期)でbody.pseudo-fullscreen
    // を付け外しする。呼び出し側がクリックのタイミングだけを見て再計算(rescale等)しようと
    // すると、フォールバック確定前に走ってしまい間に合わない。updateControl()は状態が
    // 確定するすべての経路(fullscreenchangeイベント・疑似トグル・フォールバック)から
    // 呼ばれるため、ここで一括して通知する。
    onChange?.();
  }

  btnEl.addEventListener('click', () => {
    if (isPseudoFullscreen()) {
      togglePseudoFullscreen(false);
      return;
    }
    if (nativeFullscreenSupported(cardEl)) {
      setFullscreen(!isCardFullscreen(cardEl));
      return;
    }
    togglePseudoFullscreen(true);
  });
  document.addEventListener('fullscreenchange', updateControl);
  document.addEventListener('webkitfullscreenchange', updateControl);
  updateControl();
}

/**
 * ツールバーの設定ボタン等に対する軽量ポップオーバー。ボタンの右下に固定配置し、
 * 外側クリック/Escで閉じる(WebNP2の .library-menu と同じ考え方)。
 */
export function setupPopover(btnEl, popoverEl) {
  function place() {
    const rect = btnEl.getBoundingClientRect();
    const margin = 8;
    let top = Math.round(rect.bottom + 6);
    const left = Math.min(rect.left, window.innerWidth - popoverEl.offsetWidth - margin);
    popoverEl.style.left = `${Math.max(margin, Math.round(left))}px`;

    // 課題(2026-08-16、利用者報告): 曲ライブラリのように内容が伸縮するポップオーバーは、
    // ビューポート下端を超える高さになると画面外へはみ出し、下側の内容に一切到達できなく
    // なる(position: fixedなのでページ自体がスクロールできても救えない)。
    // ボタン直下の残り高さで頭打ちにし、ポップオーバー自身の中でスクロールできるようにする
    // (popoverEl側は.settings-popoverのoverflow-y:auto、ui/styles.css参照)。
    //
    // 【追補】ボタン自体がビューポート下端に近い(画面高が小さい等)場合、単純に
    // 「ボタン直下の残り高さ」だけで頭打ちにすると最低限のスクロール領域すら確保できず
    // (実測: 画面高600pxでmaxHeightが数十pxまで潰れ、なお8px程度はみ出す組み合わせが
    // あった)、依然として一部の内容に到達できなくなる。その場合は下ではなく可能な範囲で
    // 上へ寄せてでも、ビューポート内に完全に収まる最低限の高さ(minUsableHeight)を確保する
    // (固定pxを決め打ちにすると別の画面高で同じ問題が再発するため、呼び出し元ごとに
    // 書くのではなくここ1箇所(全ポップオーバー共通)で計算する)。
    const minUsableHeight = Math.min(160, window.innerHeight - margin * 2);
    let maxHeight = window.innerHeight - top - margin;
    if (maxHeight < minUsableHeight) {
      maxHeight = minUsableHeight;
      top = Math.max(margin, window.innerHeight - maxHeight - margin);
    }
    popoverEl.style.top = `${top}px`;
    popoverEl.style.maxHeight = `${Math.max(40, Math.round(maxHeight))}px`;
  }

  function close() {
    popoverEl.classList.add('hidden');
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function onOutside(e) {
    if (popoverEl.contains(e.target) || btnEl.contains(e.target)) return;
    close();
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  function open() {
    popoverEl.classList.remove('hidden');
    place();
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
  }

  btnEl.addEventListener('click', () => {
    if (popoverEl.classList.contains('hidden')) open();
    else close();
  });
  window.addEventListener('resize', () => {
    if (!popoverEl.classList.contains('hidden')) place();
  });

  return { open, close };
}
