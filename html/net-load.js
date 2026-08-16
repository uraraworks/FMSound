// URL/書庫からの曲読み込みをUIへ配線する共有層。PMD/MUCOM88の両engine-appから使う。
// net/ 側(取得・展開ロジック、完成済み)は無改変で呼ぶだけ。ここが持つのは
// 「URLのファイル名を取り出す」「書庫の再生候補を選ばせるモーダルを出す」
// 「関連ファイルをダウンロードとして取り出せるようにする」の3つだけで、
// wasm側への実際の書き込み・再生開始はengine-app側(html/pmd-app.js・html/mucom-app.js)の
// 責務のまま残す(そちらは駆動するModuleのAPIがエンジンごとに違うため共通化しない)。

import { resolveArchiveFileName, extractArchive, baseNameOf, ARCHIVE_EXTENSIONS } from './net/archive.js';
export { ARCHIVE_EXTENSIONS };
import { fetchSongBytes } from './net/fetch.js';
import { findSongCandidates } from './net/song-select.js';
import { decodeMmlBytes } from './net/charset.js';
import { openLibraryDb, saveSong, importArchiveSongs } from './net/library.js';
import { describeSongCandidate } from './net/album-info.js';
import { t } from './ui/i18n.js';

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
 * `entries`/`archiveLabel`(archive kindのみ)は曲ライブラリの一括取り込み
 * (importArchiveSongsToLibrary()参照)に使う。書庫展開結果(LIST_*.txt含む)をここで
 * 一度だけ保持しておき、候補ごとに再展開しなくて済むようにする。
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
 * ローカルファイル(「ファイルから開く」/ドラッグ&ドロップ)から曲データを取得し、
 * 単体ファイルか書庫かを判定して返す。resolveSongFromUrl()のローカル版
 * (URL取得が無い分だけ薄い)。書庫の展開・曲候補列挙はURL経路と全く同じ関数
 * (resolveArchiveFileName()・extractArchive()・findSongCandidates())を経由するため、
 * ファイル経路とURL経路が別々のロジックに分岐しない(課題: ファイルから開く/D&Dの
 * 書庫対応、2026-08-16。以前はこの判定自体が無く、書庫のバイト列がそのままMMLとして
 * デコードされ無言で壊れていた)。
 *
 * ローカルファイルにはContent-Dispositionヘッダも無いため、表示名/ファイル名は
 * 常に`file.name`をそのまま使う(resolveSongFromUrl()のような優先順位判定は不要)。
 * @param {File} file
 * @returns {Promise<
 *   | { kind: 'single', name: string, fileName: string, bytes: Uint8Array }
 *   | { kind: 'archive', candidates: import('./net/song-select.js').SongCandidate[],
 *       entries: import('./net/archive-util.js').ArchiveEntry[], archiveLabel: string }
 * >}
 */
export async function resolveSongFromFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const archiveFileName = resolveArchiveFileName(file.name, bytes);
  if (archiveFileName) {
    const entries = await extractArchive(archiveFileName, bytes);
    const candidates = findSongCandidates(entries);
    return { kind: 'archive', candidates, entries, archiveLabel: file.name };
  }
  return { kind: 'single', name: file.name, fileName: file.name, bytes };
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

// 曲名の優先順位: MMLヘッダ(`#title`/`#Title`。読み込んだ生バイト列から直接判定する。
// PMDのバイナリ`.M`はテキストとして意味を成さないため単に一致せずnullになるだけで安全)
// > trackInfo(LIST_*.txt由来、archive経由の読み込みのみ) > null(呼び出し側はファイル名を表示する)。
/** @param {Uint8Array} bytes @param {{ trackTitle: string|null, composer: string|null }} [trackInfo] */
function resolveLibraryFields(bytes, trackInfo) {
  return {
    title: titleFromMmlHeader(bytes) ?? trackInfo?.trackTitle ?? null,
    composer: mmlHeaderField(bytes, 'composer') ?? trackInfo?.composer ?? null,
  };
}

/**
 * 自動取り込み(単体ファイル用): `?mml=`で単体ファイルを指定した場合 / ローカルファイル
 * 選択・ドラッグ&ドロップで読み込んだ曲をIndexedDBへ保存する。保存に失敗しても例外を
 * 投げない(呼び出し側は結果を待たずに進んでよい。失敗時はコンソール警告のみ)。
 * 書庫を開いた場合はこちらではなく importArchiveSongsToLibrary() を使う
 * (利用者指示、2026-08-16: 書庫は「再生した曲だけ」ではなく中身を全部取り込む仕様のため)。
 * @param {{ driver: 'mucom'|'pmd', bytes: Uint8Array, fileName: string,
 *   origin: object, trackInfo?: { trackNumber: number|null, trackTitle: string|null, composer: string|null } }} input
 */
export async function persistSongToLibrary(input) {
  try {
    const db = await getLibraryDb();
    if (!db) return;
    const { title, composer } = resolveLibraryFields(input.bytes, input.trackInfo);
    await saveSong(db, {
      driver: input.driver,
      fileName: input.fileName,
      title,
      composer,
      trackNumber: input.trackInfo?.trackNumber ?? null,
      origin: input.origin,
      bytes: input.bytes,
    });
  } catch (err) {
    console.warn('[net-load] failed to save the song to the library (playback continues)', err);
  }
}

/**
 * 自動取り込み(書庫用): 書庫を開いた時点で、その中の(指定ドライバの)曲を全部
 * IndexedDBへ一括保存する。実際のロジック(候補からの入力組み立て・1トランザクション
 * での一括保存)はDOM非依存のnet/library.js importArchiveSongs() に置いてあり
 * (tools/verify_library.mjsから直接検証できる)、ここでは「dbを明示的に渡さなければ
 * ブラウザ既定のIndexedDB(getLibraryDb())を使う」薄いラッパーに徹する。
 *
 * 利用者指示(2026-08-16): 以前は「実際に再生した1曲だけ」を保存していたため、
 * 一度も再生していない曲がライブラリに出てこず、「2度目以降にアルバムから曲を選ぶ」
 * という目的を果たせていなかった。書庫を開いた時点(=候補一覧が出た時点、実際に
 * どれを再生するか選ぶ前)で、その書庫内の全曲をまとめて取り込むようにした。
 *
 * `db` を明示的に渡すとテスト等で保存先を差し替えられる。保存に失敗しても例外を
 * 投げない(失敗時は total=候補数, added=0, unchanged=0 を返し、コンソール警告のみ出す)。
 * @param {{ driver: 'mucom'|'pmd', url: string,
 *   entries: import('./net/archive-util.js').ArchiveEntry[], archiveLabel: string,
 *   candidates: import('./net/song-select.js').SongCandidate[], db?: IDBDatabase | null }} input
 * @returns {Promise<{ total: number, added: number, unchanged: number }>}
 */
export async function importArchiveSongsToLibrary(input) {
  try {
    const db = input.db !== undefined ? input.db : await getLibraryDb();
    return await importArchiveSongs(db, input);
  } catch (err) {
    console.warn('[net-load] failed to bulk-import the archive into the library (playback continues)', err);
    return { total: input.candidates.length, added: 0, unchanged: 0 };
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
 * 取得に成功したURLをアドレスバーへ反映する(`?mml=<url>` の形にする)。URL入力UI
 * (ui/open-menu.js)から読み込んだ曲を、そのままリンクとして他人に渡せるようにするため
 * (利用者指示)。`history.replaceState` のみを使い、ページの再読み込みは起こさない。
 * 既存の `?driver=` 等、他のクエリパラメータは保持する(URLSearchParams.set()は
 * 対象キーだけを書き換えるため、他のパラメータへは触れない)。
 * `location`/`history` が使えない環境(Node.jsのverifyスクリプト等)では何もしない。
 * @param {string} url
 */
export function reflectLoadedUrlInAddressBar(url) {
  if (typeof location === 'undefined' || typeof history === 'undefined') return;
  try {
    const next = new URL(location.href);
    next.searchParams.set('mml', url);
    history.replaceState(history.state, '', next.toString());
  } catch {
    // location.hrefが不正/historyが使えない環境向けの保険。反映できなくても
    // 曲自体の読み込みは既に成功しているため、例外は投げない。
  }
}

/**
 * reflectLoadedUrlInAddressBar() の対になる関数: URLではない経路(新規作成/
 * ファイルから開く/曲ライブラリからの選択)で編集欄・再生対象を差し替えたとき、
 * アドレスバーに残った `?mml=<旧URL>` を取り除く。
 *
 * 【不具合修正・2026-08-16、利用者報告】新規作成ボタンは編集欄・下書き・
 * コンパイル状態・注意書きまで消していたが、アドレスバーの `?mml=` には
 * 触れていなかった。そのためリロードすると「編集欄は新規作成の雛形なのに、
 * 消したはずの書庫を再度読みに行って書庫選択モーダル/ライブラリが開いてしまう」
 * (アドレスバーの内容と実際に開いているものが食い違う)状態になっていた。
 * ファイルから開く/曲ライブラリ選択も同じ構造の食い違いを起こしうるため、
 * それらの経路でも呼ぶ(html/mucom-app.js・html/pmd-app.js参照)。
 *
 * reflectLoadedUrlInAddressBar()と同じく `history.replaceState` のみを使い、
 * ページの再読み込みは起こさない。既存の `?driver=` 等、他のクエリパラメータは
 * 保持する(searchParams.delete()は対象キーだけを取り除くため、他のパラメータへは
 * 触れない)。`location`/`history` が使えない環境では何もしない。
 */
export function clearLoadedUrlFromAddressBar() {
  if (typeof location === 'undefined' || typeof history === 'undefined') return;
  try {
    const next = new URL(location.href);
    if (!next.searchParams.has('mml')) return;
    next.searchParams.delete('mml');
    history.replaceState(history.state, '', next.toString());
  } catch {
    // location.hrefが不正/historyが使えない環境向けの保険。反映できなくても
    // 曲自体の切り替えは既に成功しているため、例外は投げない。
  }
}

/**
 * 書庫内の再生候補一覧から利用者に1つ選ばせるモーダルを表示する。
 *
 * 【修正3・2026-08-16、利用者報告】各候補の表示文字列はDOM非依存の
 * `net/album-info.js` の `describeSongCandidate()` に切り出してある(そちらの
 * コメント参照。曲ライブラリと同じ`resolveTrackInfo()`/`albumGroupPathFor()`/
 * `albumLabelFor()`を再利用し、Node(tools/verify_song_picker_display.mjs)から
 * 単体で検証できるようにするため)。
 * 候補が1件のときは呼び出し側で picker を出さずそのまま使ってよい(ここでは
 * 「選ばせる」ことだけを担当し、0/1件の早期リターン判断は呼び出し側に委ねる)。
 * @param {import('./net/song-select.js').SongCandidate[]} candidates
 * @param {{ title?: string, entries?: import('./net/archive-util.js').ArchiveEntry[], archiveLabel?: string }} [opts]
 * @returns {Promise<import('./net/song-select.js').SongCandidate | null>} null はキャンセル
 */
// 「いま開いているこの書庫選択モーダルを閉じる」ための取消関数(無ければnull)。
// 曲ライブラリ(ui/library-panel.js)側と全画面オーバーレイで重なる不具合対策
// (2026-08-16、利用者報告)。このモーダルはPromiseで結果を返す一回性のUIで
// setupPopover()のような{open,close}管理下に無いため、モジュール外(engine-app側)
// から閉じられるようここだけ最小限の状態を持つ。
let activeSongPickerCancel = null;

export function closeActiveSongPicker() {
  if (activeSongPickerCancel) activeSongPickerCancel();
}

export function pickSongCandidate(candidates, opts = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'song-picker-overlay';

    const modal = document.createElement('div');
    modal.className = 'song-picker-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', t('picker.ariaLabel'));

    const title = document.createElement('p');
    title.className = 'song-picker-title';
    title.textContent = opts.title ?? t('picker.title', { count: candidates.length });
    modal.appendChild(title);

    const list = document.createElement('ul');
    list.className = 'song-picker-list';
    for (const candidate of candidates) {
      const li = document.createElement('li');
      li.className = 'song-picker-item';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'song-picker-item-btn';
      btn.textContent = describeSongCandidate(candidate, opts);
      btn.addEventListener('click', () => {
        cleanup();
        resolve(candidate);
      });
      li.appendChild(btn);

      if (candidate.related.length > 0) {
        const relatedEl = document.createElement('div');
        relatedEl.className = 'song-picker-related';
        relatedEl.append(t('picker.relatedFilesLabel'));
        for (const rel of candidate.related) {
          const a = document.createElement('a');
          a.href = 'javascript:void(0);';
          a.textContent = baseNameOf(rel.name);
          a.title = t('picker.relatedFileDownloadTitle');
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
    cancelBtn.textContent = t('picker.cancel');
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
    activeSongPickerCancel = () => {
      cleanup();
      resolve(null);
    };

    function cleanup() {
      document.removeEventListener('keydown', onKey, true);
      activeSongPickerCancel = null;
      overlay.remove();
    }
  });
}
