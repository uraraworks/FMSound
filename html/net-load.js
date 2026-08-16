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
import { albumGroupPathFor, resolveTrackInfo } from './net/album-info.js';
import { openLibraryDb, saveSong } from './net/library.js';

// FILEBAR(FMDSP MUSIC FILEバー)専用の固定ラベル。「読み込み元がファイルでない」
// 経路(下書き復元)向け(課題B追補、2026-08-15、利用者報告)。曲を読み込む経路が
// 増減してもここ1箇所を見れば足りるよう、engine-app側(html/pmd-app.js・
// html/mucom-app.js)の下書き復元ブロックはこの定数をそのままcurrentSongNameへ
// 代入するだけにする。ASCIIのみで構成(fmdsp/rightpane.jsのMEDIUM_FONTはANK専用)。
export const FILEBAR_RESTORED_DRAFT_NAME = '(RESTORED DRAFT)';

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
  return mmlHeaderField(bytes, 'title');
}

/**
 * MMLテキストの `#<field>` 行(大文字小文字無視。MUCOM88の`#title`/PMDテキストの
 * `#Title`等どちらも拾える)から値を取り出す。titleFromMmlHeader()の一般化版
 * (課題: 曲ライブラリの作曲者表示にも同じ抽出が要るため)。
 * @param {Uint8Array} bytes @param {string} field
 */
function mmlHeaderField(bytes, field) {
  let text;
  try {
    ({ text } = decodeMmlBytes(bytes));
  } catch {
    return null;
  }
  const re = new RegExp(`^[ \\t]*#${field}[ \\t]+(.+?)[ \\t]*$`, 'im');
  const m = re.exec(text);
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
 * 単体ファイル取得時の「ファイル名」だけを決める(表示名resolveSingleFileName()とは別)。
 * 課題B(2026-08-15): FMDSPの MUSIC FILE バーは半角専用フォントで描いており、
 * MMLの#titleヘッダ(全角を含みうる)をそのまま渡すと文字が途中で欠けて中途半端に
 * 見える不具合があった。本家どおり「ファイル名」を出す方針にしたため、
 * こちらは#titleへは絶対にフォールバックしない(タイトルを一切見ない)。
 * 優先順位:
 * 1. Content-Disposition のファイル名
 * 2. URL末尾(拡張子が無い等、意味を成さない場合は使わない)
 * どちらも取れなければnull(呼び出し側はFILEBARに何も出さない。捏造しない)。
 * @param {string} url @param {Headers | null} headers
 */
function resolveSingleFileNameOnly(url, headers) {
  return (
    filenameFromContentDisposition(headers) ??
    (looksLikeMeaningfulUrlTail(urlBaseName(url)) ? urlBaseName(url) : null)
  );
}

/**
 * URLから曲データを取得し、単体ファイルか書庫かを判定して返す。
 * 書庫の場合はここで展開まで行い、再生候補一覧(findSongCandidates())まで返す
 * (どれを再生するかの選択は呼び出し側の責務)。
 *
 * name/fileNameを分けている理由(課題B、2026-08-15): nameは人間向けの表示名
 * (#titleへのフォールバックを含む。ツールバーの「読み込みました: ...」用)、
 * fileNameはFMDSPのMUSIC FILEバー専用でファイル名以外へは絶対にフォールバック
 * しない(上のresolveSingleFileNameOnly()参照)。
 * `entries`/`archiveLabel`(archive kindのみ)は曲ライブラリのアルバム/トラック解決
 * (describeArchiveSongOrigin()参照)に使う。書庫展開結果(LIST_*.txt含む)をここで
 * 一度だけ保持しておき、選ばれた候補ごとに再展開しなくて済むようにする。
 * @param {string} url @param {(loaded:number, total:number|null)=>void} [onProgress]
 * @returns {Promise<
 *   | { kind: 'single', name: string | null, fileName: string | null, bytes: Uint8Array }
 *   | { kind: 'archive', candidates: import('./net/song-select.js').SongCandidate['0'][],
 *       entries: import('./net/archive-util.js').ArchiveEntry[], archiveLabel: string }
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
    return { kind: 'archive', candidates, entries, archiveLabel: nameFromUrl };
  }
  return {
    kind: 'single',
    name: resolveSingleFileName(url, bytes, responseHeaders),
    fileName: resolveSingleFileNameOnly(url, responseHeaders),
    bytes,
  };
}

/**
 * 書庫由来の曲(SongCandidate)から、曲ライブラリ保存用の出所情報(origin)と
 * トラック情報(LIST_*.txtから拾えたタイトル/作曲者/トラック番号。取れなければ全てnull)を
 * まとめて組み立てる。アルバムの単位・トラック名解決の実際のロジックはnet/album-info.js
 * (DOM非依存、tools/verify_library.mjsから直接検証できる)に置いてあり、ここではそれを
 * 呼ぶだけ。
 * @param {string} url @param {import('./net/archive-util.js').ArchiveEntry[]} entries
 * @param {string} archiveLabel @param {string} entryPath
 */
export function describeArchiveSongOrigin(url, entries, archiveLabel, entryPath) {
  const groupPath = albumGroupPathFor(entryPath);
  const trackInfo = resolveTrackInfo(entries, entryPath);
  return {
    origin: { kind: 'url', url, archiveName: archiveLabel, groupPath, entryPath },
    trackInfo,
  };
}

// --- 曲ライブラリへの自動取り込み(IndexedDB、net/library.js) -------------------------
//
// DBは初回アクセス時に一度だけ開き、以降は使い回す(呼び出しのたびにopen()すると
// onupgradeneeded等のイベント配線が重複するため)。IndexedDBが使えない環境では
// openLibraryDb()がnullを返すので、以降の呼び出しは全て静かに何もしない
// (ui/mml-draft.jsのlocalStorage同様、保存できないだけで再生自体は継続する)。
let libraryDbPromise = null;
export function getLibraryDb() {
  if (!libraryDbPromise) libraryDbPromise = openLibraryDb();
  return libraryDbPromise;
}

/**
 * 自動取り込み: `?mml=` / ドラッグ&ドロップ / 書庫からの曲選択で読み込んだ曲を
 * IndexedDBへ保存する。保存に失敗しても例外を投げない(呼び出し側は結果を待たずに
 * 進んでよい。失敗時はコンソール警告のみ)。
 *
 * 曲名の優先順位: MMLヘッダ(`#title`/`#Title`。読み込んだ生バイト列から直接判定する。
 * PMDのバイナリ`.M`はテキストとして意味を成さないため単に一致せずnullになるだけで安全)
 * > trackInfo(LIST_*.txt由来、archive経由の読み込みのみ) > null(呼び出し側は
 * ファイル名を表示する)。
 * @param {{ driver: 'mucom'|'pmd', bytes: Uint8Array, fileName: string,
 *   origin: object, trackInfo?: { trackNumber: number|null, trackTitle: string|null, composer: string|null } }} input
 */
export async function persistSongToLibrary(input) {
  try {
    const db = await getLibraryDb();
    if (!db) return;
    const title = titleFromMmlHeader(input.bytes) ?? input.trackInfo?.trackTitle ?? null;
    const composer = mmlHeaderField(input.bytes, 'composer') ?? input.trackInfo?.composer ?? null;
    const trackNumber = input.trackInfo?.trackNumber ?? null;
    await saveSong(db, {
      driver: input.driver,
      fileName: input.fileName,
      title,
      composer,
      trackNumber,
      origin: input.origin,
      bytes: input.bytes,
    });
  } catch (err) {
    console.warn('[net-load] 曲のライブラリ保存に失敗しました(再生は継続します)', err);
  }
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
