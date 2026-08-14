// URL/書庫からの曲読み込みをUIへ配線する共有層。PMD/MUCOM88の両engine-appから使う。
// net/ 側(取得・展開ロジック、完成済み)は無改変で呼ぶだけ。ここが持つのは
// 「URLのファイル名を取り出す」「書庫の再生候補を選ばせるモーダルを出す」
// 「関連ファイルをダウンロードとして取り出せるようにする」の3つだけで、
// wasm側への実際の書き込み・再生開始はengine-app側(html/pmd-app.js・html/mucom-app.js)の
// 責務のまま残す(そちらは駆動するModuleのAPIがエンジンごとに違うため共通化しない)。

import { resolveArchiveFileName, extractArchive, baseNameOf } from './net/archive.js';
import { fetchSongBytes } from './net/fetch.js';
import { findSongCandidates } from './net/song-select.js';

/**
 * URLのパス部分末尾からファイル名相当の文字列を取り出す(拡張子推測・表示名に使う)。
 * `location` が無い環境(Node.jsのverifyスクリプト等)でも動くよう、基準URLの解決に
 * `location.href` が使える場合だけ使う(ブラウザでの相対URL対応、?mml=は通常絶対URLだが
 * 保険として残す)。
 * @param {string} url
 */
export function urlBaseName(url) {
  try {
    const base = typeof location !== 'undefined' ? location.href : undefined;
    const u = new URL(url, base);
    const name = decodeURIComponent(u.pathname.slice(u.pathname.lastIndexOf('/') + 1));
    return name || 'song';
  } catch {
    return 'song';
  }
}

/**
 * URLから曲データを取得し、単体ファイルか書庫かを判定して返す。
 * 書庫の場合はここで展開まで行い、再生候補一覧(findSongCandidates())まで返す
 * (どれを再生するかの選択は呼び出し側の責務)。
 * @param {string} url @param {(loaded:number, total:number|null)=>void} [onProgress]
 * @returns {Promise<
 *   | { kind: 'single', name: string, bytes: Uint8Array }
 *   | { kind: 'archive', candidates: import('./net/song-select.js').SongCandidate[] }
 * >}
 */
export async function resolveSongFromUrl(url, onProgress) {
  const bytes = await fetchSongBytes(url, onProgress);
  const nameFromUrl = urlBaseName(url);
  const archiveFileName = resolveArchiveFileName(nameFromUrl, bytes);
  if (archiveFileName) {
    const entries = await extractArchive(archiveFileName, bytes);
    const candidates = findSongCandidates(entries);
    return { kind: 'archive', candidates };
  }
  return { kind: 'single', name: nameFromUrl, bytes };
}

/**
 * アーカイブエントリ(#voice/#pcm等の関連ファイルを含む)をブラウザのダウンロードとして
 * 取り出す。読み込んで演奏に使うところまでは今回のスコープ外だが、取り出せる状態には
 * しておく(利用者が手元でvoice.dat等を保存できる)。
 * @param {import('./net/archive-util.js').ArchiveEntry} entry
 */
export function downloadArchiveEntry(entry) {
  const blob = new Blob([entry.data], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = baseNameOf(entry.name);
  document.body.appendChild(a);
  a.click();
  a.remove();
  // ui/download-menu.js downloadBytes() と同じ理由でrevokeを少し遅らせる。
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * 書庫内の再生候補一覧から利用者に1つ選ばせるモーダルを表示する。
 * 候補が1件のときは呼び出し側で picker を出さずそのまま使ってよい(ここでは
 * 「選ばせる」ことだけを担当し、0/1件の早期リターン判断は呼び出し側に委ねる)。
 * @param {import('./net/song-select.js').SongCandidate[]} candidates
 * @param {{ title?: string }} [opts]
 * @returns {Promise<import('./net/song-select.js').SongCandidate | null>} null はキャンセル
 */
export function pickSongCandidate(candidates, opts = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'song-picker-overlay';

    const modal = document.createElement('div');
    modal.className = 'song-picker-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', '曲を選択');

    const title = document.createElement('p');
    title.className = 'song-picker-title';
    title.textContent = opts.title ?? `書庫の中から曲を選んでください(${candidates.length}件見つかりました)`;
    modal.appendChild(title);

    const list = document.createElement('ul');
    list.className = 'song-picker-list';
    for (const candidate of candidates) {
      const li = document.createElement('li');
      li.className = 'song-picker-item';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'song-picker-item-btn';
      const driverLabel = candidate.driver === 'mucom' ? 'MUCOM88' : 'PMD';
      btn.textContent = `${candidate.displayName} (${driverLabel})`;
      btn.addEventListener('click', () => {
        cleanup();
        resolve(candidate);
      });
      li.appendChild(btn);

      if (candidate.related.length > 0) {
        const relatedEl = document.createElement('div');
        relatedEl.className = 'song-picker-related';
        relatedEl.append('関連ファイル: ');
        for (const rel of candidate.related) {
          const a = document.createElement('a');
          a.href = 'javascript:void(0);';
          a.textContent = baseNameOf(rel.name);
          a.title = 'クリックでダウンロード(#voice/#pcm等の付随ファイル。読み込みは別途手動で行ってください)';
          a.addEventListener('click', (e) => {
            e.stopPropagation();
            downloadArchiveEntry(rel);
          });
          relatedEl.appendChild(a);
          relatedEl.append(' ');
        }
        li.appendChild(relatedEl);
      }
      list.appendChild(li);
    }
    modal.appendChild(list);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'song-picker-cancel';
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.addEventListener('click', () => {
      cleanup();
      resolve(null);
    });
    modal.appendChild(cancelBtn);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function onKey(e) {
      if (e.key === 'Escape') {
        cleanup();
        resolve(null);
      }
    }
    document.addEventListener('keydown', onKey, true);

    function cleanup() {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
    }
  });
}
