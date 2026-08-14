// 課題A: 編集中のMMLをlocalStorageへ自動保存し、次回開いたときに復元する。
//
// 将来IndexedDBベースのライブラリ機能を作る予定があるが、今回はそのつなぎとして
// 「1ドライバにつき1件の下書き」だけを持つ最小実装にする(凝った設計にしない)。
//
// 保存のタイミング: input(1打鍵ごと)に直接書くと、長いMMLでは打鍵のたびに
// localStorageへJSON.stringify+同期書き込みが走り主スレッドを塞ぐ。ここでは
// 最後の入力から DEBOUNCE_MS 経ってから1回だけ書く(間引く)。ただしタブを閉じる・
// 裏に回す直前にデバウンス中の最後の数文字を失っては本末転倒なので、
// visibilitychange(hidden化)とpagehideのタイミングでは間引かず即座に書く。

const DEFAULT_DEBOUNCE_MS = 1200;

/** 保存済みの下書きを読む。無い/壊れている場合はnullを返す。 */
export function loadMmlDraft(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.text !== 'string') return null;
    return { text: parsed.text, savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : null };
  } catch {
    return null; // private mode等でlocalStorage自体が使えない場合も含む
  }
}

/**
 * textarea の内容を storageKey へ自動保存する配線。
 * @returns {{ flush: () => void }} flush() は即時保存(デバウンスを待たない)。
 */
export function setupMmlAutosave({ storageKey, textarea, debounceMs = DEFAULT_DEBOUNCE_MS }) {
  let timer = null;

  function saveNow() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ text: textarea.value, savedAt: Date.now() }));
    } catch {
      /* ignore (private mode/容量超過等) */
    }
  }

  function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    saveNow();
  }

  function scheduleSave() {
    if (timer !== null) clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      saveNow();
    }, debounceMs);
  }

  textarea.addEventListener('input', scheduleSave);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flush();
  });
  window.addEventListener('pagehide', flush);

  return { flush };
}

/** 「HH:MM復元しました」のような簡易な日時表記(復元通知に使う)。 */
export function formatSavedAt(savedAt) {
  if (!savedAt) return null;
  const d = new Date(savedAt);
  if (Number.isNaN(d.getTime())) return null;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
