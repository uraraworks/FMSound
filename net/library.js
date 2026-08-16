// 曲ライブラリの保存層(IndexedDB)。DOM非依存: indexedDBの実装は呼び出し側から
// 注入できる(既定はグローバルの `indexedDB`)ので、tools/verify_library.mjs では
// このファイル自体は無改変のまま、Node用の最小フェイクIndexedDB(同ファイル内、
// テストコード側)を注入して検証する。
//
// 同一origin注意(利用者指示): GitHub Pagesのユーザーサイトは全リポジトリが同一ホスト
// (uraraworks.github.io)なので、WebNP2/WorkbenchNP2/WebPaint98とIndexedDBを共有する。
// DB名・ストア名はFMSound固有と分かる名前にしてある。
//
// 将来のアプリ間データ受け渡し(README.ja.md「今後の予定」)に備え、レコードの形は
// FMSound内部専用の符号化に閉じず、素直な構造(ドライバ種別・曲名・出所・生バイト列)
// のままにしてある。`schemaVersion` を持たせ、将来のマイグレーションに備える。

const DB_NAME = 'fmsound-library';
const DB_VERSION = 1;
const STORE_NAME = 'fmsound-songs';
export const RECORD_SCHEMA_VERSION = 1;

/** @param {IDBRequest} request */
function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * ライブラリDBを開く。IndexedDBが使えない環境(プライベートブラウズ・古いブラウザ・
 * 権限拒否等)では例外を投げず null を返す(ui/mml-draft.jsのlocalStorage同様、
 * 「保存できないだけで再生自体は続けられる」を満たすため)。
 * @param {IDBFactory | null} [idbFactory] 省略時はグローバルの `indexedDB`(テスト用の注入口)。
 * @returns {Promise<IDBDatabase | null>}
 */
export function openLibraryDb(idbFactory) {
  const idb = idbFactory ?? (typeof indexedDB !== 'undefined' ? indexedDB : null);
  if (!idb) return Promise.resolve(null);
  return new Promise((resolve) => {
    let request;
    try {
      request = idb.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

// --- 同一性判定・内容ハッシュ --------------------------------------------------------

/**
 * 曲の同一性判定キー(重複防止に使う)。
 * 出所URL + 書庫内エントリパスの組(archive由来)、URL単体(単体ファイルURL由来)、
 * または `local:<ファイル名>`(D&D・ローカルファイル選択由来。URLが無いためファイル名で
 * 代用する。同名の別内容ファイルを読み込んだ場合は下のsaveSong()の「内容が変わっていれば
 * 上書き」規則で吸収する)。
 * @param {{ kind: 'url'|'local', url: string|null, entryPath: string|null }} origin
 * @param {string} fileName
 */
export function computeSongId(origin, fileName) {
  if (origin.kind === 'url') {
    return origin.entryPath ? `url:${origin.url}::${origin.entryPath}` : `url:${origin.url}`;
  }
  return `local:${fileName}`;
}

/** FNV-1a(32bit)。暗号強度は不要(内容が変わったかどうかの安価な検出用)なので依存を増やさずここで実装する。 @param {Uint8Array} bytes */
export function hashBytes(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// --- CRUD ----------------------------------------------------------------------------

/**
 * 曲を保存する(無ければ追加、あれば更新)。
 *
 * 重複を作らない規則: id(computeSongId())が一致する既存レコードがあれば、内容
 * (hashBytes()の一致)を見て「変わっていなければ何もしない(addedAt/updatedAtを
 * 不必要に更新しない)」「変わっていれば上書き(同じidのまま内容だけ差し替え、
 * addedAtは初回のまま保持)」のどちらかにする。新しいレコードとして追加はしない
 * (=同じ出所を2回読み込んでも一覧が2件に増えない)。
 *
 * @param {IDBDatabase} db
 * @param {{
 *   driver: 'mucom' | 'pmd',
 *   fileName: string,
 *   title: string | null,
 *   composer: string | null,
 *   trackNumber: number | null,
 *   origin: { kind: 'url'|'local', url: string|null, archiveName: string|null, groupPath: string[]|null, entryPath: string|null },
 *   bytes: Uint8Array,
 * }} input
 * @returns {Promise<string>} 保存したレコードのid
 */
export async function saveSong(db, input) {
  const id = computeSongId(input.origin, input.fileName);
  const contentHash = hashBytes(input.bytes);
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  const existing = await promisifyRequest(store.get(id));
  if (existing && existing.contentHash === contentHash) {
    return existing.id; // 内容が変わっていない再取り込みは書き込みを省略する
  }
  const now = Date.now();
  const record = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    id,
    driver: input.driver,
    fileName: input.fileName,
    title: input.title ?? null,
    composer: input.composer ?? null,
    trackNumber: input.trackNumber ?? null,
    origin: input.origin,
    bytes: input.bytes,
    contentHash,
    addedAt: existing?.addedAt ?? now,
    updatedAt: now,
  };
  await promisifyRequest(store.put(record));
  return id;
}

/** @param {IDBDatabase} db @returns {Promise<object[]>} 保存済みの全曲(未加工) */
export async function listSongs(db) {
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const all = await promisifyRequest(store.getAll());
  return all ?? [];
}

/** @param {IDBDatabase} db @param {string} id */
export async function deleteSong(db, id) {
  const tx = db.transaction(STORE_NAME, 'readwrite');
  await promisifyRequest(tx.objectStore(STORE_NAME).delete(id));
}

/** @param {IDBDatabase} db */
export async function clearAllSongs(db) {
  const tx = db.transaction(STORE_NAME, 'readwrite');
  await promisifyRequest(tx.objectStore(STORE_NAME).clear());
}

// --- アルバム/トラック表示 -------------------------------------------------------------

const OTHER_ALBUM_ID = 'other';
const OTHER_ALBUM_LABEL = '個別ファイル';

/**
 * アルバムの単位はd88(ディスク)。曲のorigin.groupPathがあればそれをアルバム境界とし、
 * 無ければ(単体ファイル読み込み・D&D等)「個別ファイル」の1グループへまとめる
 * (利用者指示: 「単体ファイルを開いた場合は、アルバム無し(または「その他」相当)に入れる」)。
 * @param {{ kind: string, url: string|null, archiveName: string|null, groupPath: string[]|null }} origin
 */
function albumKeyFor(origin) {
  if (origin && origin.groupPath && origin.groupPath.length > 0) {
    const archiveKey = origin.url ?? origin.archiveName ?? '';
    return {
      id: `album:${archiveKey}::${origin.groupPath.join('/')}`,
      label: origin.archiveName ? albumLabelForGroupPath(origin.groupPath, origin.archiveName) : origin.groupPath.join('/'),
    };
  }
  return { id: OTHER_ALBUM_ID, label: OTHER_ALBUM_LABEL };
}

// album-info.jsのalbumLabelFor()と同じ規則をここでも使うが、循環import(album-info.js側は
// archive.js/charset.jsにしか依存せずlibrary.jsを知らない設計にしたい)を避けるため、
// 同じロジックを直接importして使う(重複実装はしない)。
import { albumLabelFor as albumLabelForGroupPath } from './album-info.js';

/**
 * 曲一覧(listSongs()の結果)を「アルバム > トラック」の2段に組み立てる。
 * アルバムはラベルの辞書順(「個別ファイル」は常に末尾)、トラックはtrackNumber昇順
 * (無ければタイトル/ファイル名の辞書順で末尾に回す)。
 * @param {object[]} songs
 * @returns {{ id: string, label: string, songs: object[] }[]}
 */
export function groupSongsIntoAlbums(songs) {
  const albums = new Map();
  for (const song of songs) {
    const key = albumKeyFor(song.origin ?? {});
    if (!albums.has(key.id)) albums.set(key.id, { id: key.id, label: key.label, songs: [] });
    albums.get(key.id).songs.push(song);
  }
  const list = [...albums.values()];
  for (const album of list) {
    album.songs.sort((a, b) => {
      if (a.trackNumber != null && b.trackNumber != null) return a.trackNumber - b.trackNumber;
      if (a.trackNumber != null) return -1;
      if (b.trackNumber != null) return 1;
      return (a.title ?? a.fileName).localeCompare(b.title ?? b.fileName);
    });
  }
  list.sort((a, b) => {
    if (a.id === OTHER_ALBUM_ID) return 1;
    if (b.id === OTHER_ALBUM_ID) return -1;
    return a.label.localeCompare(b.label);
  });
  return list;
}
