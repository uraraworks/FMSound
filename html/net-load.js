// URL/書庫からの曲読み込みをUIへ配線する共有層。PMD/MUCOM88の両engine-appから使う。
// net/ 側(取得・展開ロジック、完成済み)は無改変で呼ぶだけ。ここが持つのは
// 「URLのファイル名を取り出す」「書庫の再生候補を選ばせるモーダルを出す」
// 「関連ファイルをダウンロードとして取り出せるようにする」の3つだけで、
// wasm側への実際の書き込み・再生開始はengine-app側(html/pmd-app.js・html/mucom-app.js)の
// 責務のまま残す(そちらは駆動するModuleのAPIがエンジンごとに違うため共通化しない)。

import { resolveArchiveFileName, extractArchive, baseNameOf } from './net/archive.js';
import { fetchSongBytes } from './net/fetch.js';
import { findSongCandidates } from './net/song-select.js';
import { decodeMmlBytes } from './net/charset.js';

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
 * `Content-Disposition` レスポンスヘッダからファイル名を取り出す(RFC 6266)。
 * `filename*=UTF-8''...` を優先し、無ければ `filename="..."` を見る。どちらも
 * 無ければnull。
 * @param {Headers | null} headers
 */
function filenameFromContentDisposition(headers) {
  const cd = headers?.get('content-disposition');
  if (!cd) return null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim()) || null;
    } catch {
      // 不正なパーセントエンコーディングは無視してplainの方を試す。
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  return plain ? plain[1].trim() || null : null;
}

/**
 * MMLテキストの `#title` 行から曲名を取り出す(MUCOM88/PMDいずれもテキストMMLの
 * 慣例として先頭付近に書く)。PMDのコンパイル済み `.M` 等バイナリはテキストとして
 * 意味を成さないため、単に一致しない(=null)だけで安全に素通りする。
 * @param {Uint8Array} bytes
 */
function titleFromMmlHeader(bytes) {
  let text;
  try {
    ({ text } = decodeMmlBytes(bytes));
  } catch {
    return null;
  }
  const m = /^[ \t]*#title[ \t]+(.+?)[ \t]*$/im.exec(text);
  return m ? m[1].trim() || null : null;
}

/**
 * URL末尾を表示名として使ってよいか判定する。「拡張子が無ければ疑う」という
 * 素直な規則(view/edit/download/uc等の一般語を個別に列挙しない): 拡張子付きの
 * 名前だけを信頼する。
 * @param {string} name
 */
function looksLikeMeaningfulUrlTail(name) {
  return /\.[A-Za-z0-9]+$/.test(name);
}

/**
 * 単体ファイル取得時の表示名を優先順位に従って決める:
 * 1. Content-Disposition のファイル名
 * 2. (書庫展開時のファイル名は呼び出し側=archiveの枝で別途扱う)
 * 3. MMLヘッダの #title
 * 4. URL末尾(拡張子が無い等、意味を成さない場合は使わない)
 * どれも取れなければnull(呼び出し側は名前を出さず「読み込みました」とだけ表示する)。
 * @param {string} url @param {Uint8Array} bytes @param {Headers | null} headers
 */
function resolveSingleFileName(url, bytes, headers) {
  return (
    filenameFromContentDisposition(headers) ??
    titleFromMmlHeader(bytes) ??
    (looksLikeMeaningfulUrlTail(urlBaseName(url)) ? urlBaseName(url) : null)
  );
}

/**
 * URLから曲データを取得し、単体ファイルか書庫かを判定して返す。
 * 書庫の場合はここで展開まで行い、再生候補一覧(findSongCandidates())まで返す
 * (どれを再生するかの選択は呼び出し側の責務)。
 * @param {string} url @param {(loaded:number, total:number|null)=>void} [onProgress]
 * @returns {Promise<
 *   | { kind: 'single', name: string | null, bytes: Uint8Array }
 *   | { kind: 'archive', candidates: import('./net/song-select.js').SongCandidate[] }
 * >}
 */
export async function resolveSongFromUrl(url, onProgress) {
  /** @type {Headers | null} */
  let responseHeaders = null;
  const bytes = await fetchSongBytes(url, onProgress, (headers) => {
    responseHeaders = headers;
  });
  const nameFromUrl = urlBaseName(url);
  const archiveFileName = resolveArchiveFileName(nameFromUrl, bytes);
  if (archiveFileName) {
    const entries = await extractArchive(archiveFileName, bytes);
    const candidates = findSongCandidates(entries);
    return { kind: 'archive', candidates };
  }
  return { kind: 'single', name: resolveSingleFileName(url, bytes, responseHeaders), bytes };
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
