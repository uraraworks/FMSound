// 課題B: エディタのすぐ上に置く1行の状態表示。
// コンパイル結果の詳細ログ(従来どおり下に残す#result等)とは別の要素で、
// 「成功/失敗の一言+クリックでエラー行へジャンプ」だけを担う。

/** エディタの直上に挿す status 用の要素を作る(呼び出し側がDOMへ挿入する)。 */
export function createMmlStatusEl(id) {
  const el = document.createElement('div');
  el.className = 'mml-status';
  if (id) el.id = id;
  return el;
}

/**
 * 状態表示を更新する。
 * @param {HTMLElement} el
 * @param {{ ok: boolean, line?: number|null, message?: string, onJump?: (line:number)=>void }} state
 */
export function setMmlStatus(el, { ok, line = null, message = '', onJump }) {
  el.onclick = null;
  el.removeAttribute('title');
  el.classList.remove('mml-status-error', 'mml-status-clickable');

  if (ok) {
    el.textContent = 'コンパイル成功';
    return;
  }

  el.classList.add('mml-status-error');
  el.textContent = line != null ? `line ${line}: ${message}` : message;
  if (line != null && typeof onJump === 'function') {
    el.classList.add('mml-status-clickable');
    el.title = `クリックでMML ${line}行目へ移動`;
    el.onclick = () => onJump(line);
  }
}

/**
 * 課題A: 状態表示を「空」に戻す(前回のコンパイル結果を残さない)。
 * 新しいコンパイルを開始したとき・編集内容を消したとき・曲を読み込んだときに呼ぶ。
 * setMmlStatus({ok:true})の「コンパイル成功」とは違い、本当に何も表示しない状態にする。
 */
export function clearMmlStatus(el) {
  el.onclick = null;
  el.removeAttribute('title');
  el.classList.remove('mml-status-error', 'mml-status-clickable');
  el.textContent = '';
}
