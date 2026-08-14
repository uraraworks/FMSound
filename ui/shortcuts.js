// 課題C: キーボードショートカット(⌘Enter/Ctrl+Enterでコンパイル&再生、Escで停止)。
//
// document側のkeydownで拾う。html/mml-editor.js のtextareaは'input'/'scroll'/
// 'click'/'keyup'/'select'しか listen しておらず keydown を stopPropagation しないため、
// textareaにフォーカスがある状態でもここまでイベントが届く(実測はREADME/報告参照。
// この環境は合成キー入力が届かないことがあるため、自動検証で確認できない場合は
// 正直にその旨を報告すること)。
//
// F5は意図的に一切扱わない(ブラウザの再読み込みそのもの。奪うと編集中のMMLが
// 消える事故になるため、ハンドラの対象外にする)。

export const SHORTCUT_PLAY_HINT = '⌘/Ctrl+Enter';
export const SHORTCUT_STOP_HINT = 'Esc';

/**
 * @param {{ btnPlayPause: HTMLButtonElement, btnStop: HTMLButtonElement, popovers?: (HTMLElement|null)[] }} opts
 */
export function setupTransportShortcuts({ btnPlayPause, btnStop, popovers = [] }) {
  function anyPopoverOpen() {
    return popovers.some((el) => el && !el.classList.contains('hidden'));
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!btnPlayPause.disabled) btnPlayPause.click();
      return;
    }
    if (e.key === 'Escape') {
      // 設定/ダウンロードのポップオーバーはui/shell.js setupPopover()が別途
      // document keydown(capture)でEscを見て閉じる。ここでも同時にEscを
      // 「停止」として扱うと、ポップオーバーを閉じたいだけの操作で音まで
      // 止まってしまうため、開いている間は何もしない。
      if (anyPopoverOpen()) return;
      e.preventDefault();
      if (!btnStop.disabled) btnStop.click();
    }
  });
}
