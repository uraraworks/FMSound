// ツールバーの「曲を開く」ボタンをメニュー化する共有UI(html/mucom-app.js・html/pmd-app.jsの
// 両方から使う)。見た目・配置の骨組みは ui/download-menu.js に倣い、.settings-popover
// (ui/shell.js setupPopover()によるビューポート内配置・自前スクロール対応)へそのまま
// 相乗りする(利用者指示: 独自の配置計算を作らない)。ここが持つのは
// 「メニュー⇔URL入力欄」の見た目の切替と、実行/取消クリックの配線だけ。
//
// URL取得の実処理(取得→書庫判定→展開→曲選択、ライブラリ取り込み、進捗/エラー表示)は
// 一切ここに置かない。既存の?mml=読み込み経路(html/mucom-app.js・html/pmd-app.jsの
// loadSongFromUrl())へそのまま委譲する(opts.onUrlSubmit)。進捗・失敗の文言表示は
// 呼び出し先が既存のnetStatus領域(ポップオーバーの外、常時表示)へ出すのでここでは
// 何も表示しない(二重に持たない)。
//
// 「実行」を押した時点でポップオーバーを閉じる: 書庫URLの場合、読み込みの続きで
// 書庫選択モーダル(net-load.js pickSongCandidate())が開くことがあるが、この
// ポップオーダーが開いたままだと重なって見える不具合(直前のe2b957f修正と同種)に
// なるため、実行と同時に閉じてモーダル側と競合しないようにする。

/**
 * @param {Object} opts
 * @param {() => void} opts.onFileOpen - 「ファイルから開く」選択時に呼ぶ(fileInput.click()等)
 * @param {(url: string) => void} opts.onUrlSubmit - URL入力欄で「実行」を押したときに呼ぶ
 */
import { t } from './i18n.js';

export function createOpenMenu({ onFileOpen, onUrlSubmit }) {
  const popover = document.createElement('div');
  popover.className = 'settings-popover open-popover hidden';
  document.body.appendChild(popover);

  // setupPopover() が返す close() は呼び出し側(engine-app)がこのpopoverElを渡して
  // 生成するため、生成順の都合でこのモジュール内では直接持てない。setCloseHandler()で
  // 後から差し込む。未設定の間はclassだけ隠すフォールバックにしておく(setupPopover
  // 抜きで使う場合の保険。実プロダクトコードでは常にsetCloseHandler()される想定)。
  let requestClose = () => popover.classList.add('hidden');

  function renderMenu() {
    popover.innerHTML = `
      <p class="settings-popover-title">${t('openMenu.title')}</p>
      <button type="button" class="download-btn open-menu-btn" data-action="file">${t('openMenu.fromFile')}</button>
      <button type="button" class="download-btn open-menu-btn" data-action="url">${t('openMenu.fromUrl')}</button>
    `;
    popover.querySelector('[data-action="file"]').addEventListener('click', () => {
      requestClose();
      onFileOpen();
    });
    popover.querySelector('[data-action="url"]').addEventListener('click', () => {
      renderUrlForm();
    });
  }

  function renderUrlForm() {
    popover.innerHTML = `
      <p class="settings-popover-title">${t('openMenu.fromUrl')}</p>
      <input type="url" class="open-url-input" id="openUrlInput" placeholder="https://..." autocomplete="off">
      <div class="open-url-actions">
        <button type="button" class="download-btn" data-action="submit">${t('openMenu.submit')}</button>
        <button type="button" class="download-btn" data-action="cancel">${t('openMenu.cancel')}</button>
      </div>
    `;
    const input = popover.querySelector('#openUrlInput');
    input.focus();
    popover.querySelector('[data-action="cancel"]').addEventListener('click', () => {
      requestClose();
    });
    function submit() {
      const url = input.value.trim();
      if (!url) return;
      requestClose();
      onUrlSubmit(url);
    }
    popover.querySelector('[data-action="submit"]').addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });
  }

  renderMenu();

  return {
    popoverEl: popover,
    // ポップオーバーを開き直すたびに呼ぶ想定(前回URL入力欄を出していても、
    // 次に開いたときは必ずメニューへ戻す)。
    resetToMenu: renderMenu,
    /** @param {() => void} fn */
    setCloseHandler(fn) {
      requestClose = fn;
    },
  };
}
