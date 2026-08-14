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
export function setupFullscreen(cardEl, btnEl, labels = {}) {
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
    popoverEl.style.top = `${Math.round(rect.bottom + 6)}px`;
    const left = Math.min(rect.left, window.innerWidth - popoverEl.offsetWidth - 8);
    popoverEl.style.left = `${Math.max(8, Math.round(left))}px`;
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
