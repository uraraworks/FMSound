#!/usr/bin/env node
// net/library.js(曲ライブラリの保存層、IndexedDB)・net/album-info.js(アルバム/トラック
// 解決)の検証。
//
// IndexedDBはNodeに無いため、ここで最小のフェイクIndexedDB(このファイル内、
// get/put/delete/getAll/clearだけを実装した部分実装)を自前で用意して注入する
// (net/library.js自体は openLibraryDb(idbFactory) で実装を差し替えられる設計にしてある。
// 新しい依存パッケージは足さない、という指示のため)。
//
// 検証項目:
//   (a) 陽性対照: 「何も保存していない状態では一覧が空」を先に確認してから
//       「保存すると出てくる」を確認する(後者だけを見ない)。
//   (b) 同じ出所(URL+書庫内パス、またはローカルのファイル名)を2回保存しても
//       件数が増えない(重複を作らない)。内容が変わっていれば上書きされる
//       (件数は変わらないが内容は更新される)ことも確認する。
//   (c) 削除(deleteSong)・全削除(clearAllSongs)が効く。
//   (d) computeSongId()の同一性判定キーが仕様どおり(URL+書庫内パス / URL単体 / local:ファイル名)。
//   (e) hashBytes()が内容の変化を検出できる(同一バイト列は同じハッシュ、違えば違うハッシュ)。
//   (f) groupSongsIntoAlbums(): アルバムはd88単位(groupPathの有無)でグループ化され、
//       トラックはtrackNumber順に並ぶ。単体ファイル(groupPath無し)は「個別ファイル」に
//       まとまる。
//   (g) net/album-info.js parseTrackList(): 実物のLIST_*.txtの書式(曲名+タブ/複数スペース
//       区切り+ファイル名コード、一部は曲名+作曲者+ファイル名コードの3フィールド)を
//       模した合成データ(著作物である実物のテキストはリポジトリに含めない)で解析できること。
//   (h) 実データ(MCM_sample_20190124.zip、環境変数 MCM_SAMPLE_ZIP)がある場合のみ、
//       実際にzipを展開してアルバム分割・トラック名解決の結果を報告する
//       (tools/verify_d88.mjs / verify_mucom_voice_name.mjs と同じ作法で、未設定なら
//       明示的にスキップする)。
//   (i) 利用者指示(2026-08-16): 書庫を開いた時点で(1曲も再生せずに)中の全曲が
//       ライブラリへ入ること(net/library.js importArchiveSongs())。
//       修正前の実装(「実際に選ばれた1曲だけ」保存)を模した壊れた版を先に用意し、
//       それがこの検査で実際にFAILすることを確認してから(陽性対照)、
//       現在の実装(全曲を1トランザクションで一括保存)がPASSすることを確認する。
//       同じ書庫を2回取り込んでも重複しないこと、55曲程度でも同期的に固まらず
//       完了することも合わせて確認する。
//   (j) net/album-info.js albumLabelFor(): `MML_<ラベル>.d88` の命名規則に乗らない
//       d88(システムディスク等)でも、少なくとも拡張子`.d88`は落ちること。
//
// 実行: node tools/verify_library.mjs
//       MCM_SAMPLE_ZIP=/path/to/mcm.zip node tools/verify_library.mjs (実データ検証込み)

import { readFileSync } from 'node:fs';

import {
  openLibraryDb, saveSong, listSongs, deleteSong, clearAllSongs,
  computeSongId, hashBytes, groupSongsIntoAlbums, importArchiveSongs,
  loadPcmFilesForSong, DB_NAME, PCM_STORE_NAME,
} from '../net/library.js';
import { parseTrackList, albumGroupPathFor, albumLabelFor, resolveTrackInfo } from '../net/album-info.js';

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passed++;
  else failed++;
  console.log(`[${mark}] ${label}${detail !== undefined ? ' - ' + detail : ''}`);
}

// --- Node用の最小フェイクIndexedDB ---------------------------------------------------
// get/put/delete/getAll/clearだけを実装した部分実装(net/library.jsが実際に使う操作の
// みをカバーする。index/cursor等は使っていないので実装しない)。
// 値はMapに入れて保持し、get/getAllの返り値は都度クローンする(structured cloneの
// 「保存後に呼び出し元が値をいじっても保存済みデータへ影響しない」性質を模す)。

function cloneValue(value) {
  if (value instanceof Uint8Array) return value.slice();
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = cloneValue(value[k]);
    return out;
  }
  return value;
}

class FakeRequest {
  constructor() {
    this.onsuccess = null;
    this.onerror = null;
    this.onupgradeneeded = null;
    this.result = undefined;
    this.error = undefined;
  }
  _succeed(result) {
    this.result = result;
    setTimeout(() => { if (this.onsuccess) this.onsuccess({ target: this }); }, 0);
  }
}

class FakeStore {
  constructor(dataMap, keyPath) {
    this.dataMap = dataMap;
    this.keyPath = keyPath;
  }
  get(key) {
    const req = new FakeRequest();
    req._succeed(this.dataMap.has(key) ? cloneValue(this.dataMap.get(key)) : undefined);
    return req;
  }
  put(value) {
    const req = new FakeRequest();
    const key = value[this.keyPath];
    this.dataMap.set(key, cloneValue(value));
    req._succeed(key);
    return req;
  }
  delete(key) {
    const req = new FakeRequest();
    this.dataMap.delete(key);
    req._succeed(undefined);
    return req;
  }
  clear() {
    const req = new FakeRequest();
    this.dataMap.clear();
    req._succeed(undefined);
    return req;
  }
  getAll() {
    const req = new FakeRequest();
    req._succeed([...this.dataMap.values()].map(cloneValue));
    return req;
  }
}

class FakeDatabase {
  constructor() {
    this.stores = new Map(); // name -> Map(key->value)
    this.keyPaths = new Map(); // name -> keyPath
    this.version = 0; // DBバージョン昇格(1→2)検証用(2026-08-18拡張)。
  }
  get objectStoreNames() {
    const stores = this.stores;
    return { contains: (name) => stores.has(name) };
  }
  createObjectStore(name, opts) {
    this.stores.set(name, new Map());
    this.keyPaths.set(name, opts.keyPath);
    return new FakeStore(this.stores.get(name), opts.keyPath);
  }
  transaction(storeNames) {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const db = this;
    return {
      objectStore(name) {
        if (!names.includes(name)) throw new Error(`fake IDB: '${name}' はこのトランザクションのスコープ外です`);
        return new FakeStore(db.stores.get(name), db.keyPaths.get(name));
      },
    };
  }
}

// 【拡張・2026-08-18】DB_VERSION 1→2昇格の検証のため、open()にバージョン番号を渡せる
// ようにした(以前は常に「初回だけonupgradeneeded」という単純化だった)。
// requestedVersion > db.version のときだけonupgradeneededを呼び、その後db.versionを
// 更新する(実IndexedDBの「onupgradeneededはoldVersion<newVersionのときだけ発火する」
// 仕様を最小限模す)。
class FakeIDBFactory {
  constructor() {
    this.databases = new Map();
  }
  /**
   * テスト専用: net/library.jsのopenLibraryDb()を経由せず、「昇格前(DB_VERSION=1)の
   * 既存DB」を直接組み立てて登録する(旧DBからの昇格で曲が消えないことを検証するため。
   * net/library.js自体は無改変のまま検証する、という方針を保つため、この組み立てヘルパは
   * net/library.jsが公開しているDB_NAME/PCM_STORE_NAME定数とkeyPath('id'/'hash'、
   * net/library.jsのcreateObjectStore呼び出しと同じ値)だけを使う)。
   * @param {string} dbName @param {object[]} songs 事前に入れておく曲レコード配列
   */
  seedLegacyV1Database(dbName, songs) {
    const db = new FakeDatabase();
    db.version = 1;
    const store = db.createObjectStore('fmsound-songs', { keyPath: 'id' });
    for (const song of songs) store.put(song);
    this.databases.set(dbName, db);
    return db;
  }
  open(name, version) {
    const req = new FakeRequest();
    const requestedVersion = version ?? 1;
    let db = this.databases.get(name);
    if (!db) {
      db = new FakeDatabase();
      this.databases.set(name, db);
    }
    const oldVersion = db.version;
    const needsUpgrade = requestedVersion > oldVersion;
    setTimeout(() => {
      req.result = db;
      if (needsUpgrade) {
        db.version = requestedVersion;
        if (req.onupgradeneeded) req.onupgradeneeded({ target: req, oldVersion, newVersion: requestedVersion });
      }
      if (req.onsuccess) req.onsuccess({ target: req });
    }, 0);
    return req;
  }
}

// --- (a)(b)(c) 保存層の基本動作 --------------------------------------------------------

async function testStorageLayer() {
  const fakeIdb = new FakeIDBFactory();
  const db = await openLibraryDb(fakeIdb);
  check('openLibraryDb(): フェイクIndexedDBからDBを取得できる', db !== null);
  if (!db) return;

  // (a) 陽性対照: 保存前は必ず空であることを先に確認する(後者(保存後に出てくる)だけを見ない)。
  const beforeAny = await listSongs(db);
  check('陽性対照: 何も保存していない状態では一覧が空', beforeAny.length === 0, `件数=${beforeAny.length}`);

  const songBytesV1 = new TextEncoder().encode('A T120 o5 l4 v10 cdefg');
  const originLocal = { kind: 'local', url: null, archiveName: null, groupPath: null, entryPath: null };
  await saveSong(db, {
    driver: 'mucom', fileName: 'test.muc', title: null, composer: null, trackNumber: null,
    origin: originLocal, bytes: songBytesV1,
  });
  const afterOne = await listSongs(db);
  check('保存すると一覧に出てくる(陽性対照の後半)', afterOne.length === 1, `件数=${afterOne.length}`);
  check('保存したレコードのdriver/fileNameが正しい', afterOne[0]?.driver === 'mucom' && afterOne[0]?.fileName === 'test.muc');
  check('schemaVersionが付与されている', afterOne[0]?.schemaVersion === 1);
  const firstAddedAt = afterOne[0]?.addedAt;

  // (b) 同じ出所・同じ内容を再度保存しても増えない。
  await saveSong(db, {
    driver: 'mucom', fileName: 'test.muc', title: null, composer: null, trackNumber: null,
    origin: originLocal, bytes: songBytesV1,
  });
  const afterDup = await listSongs(db);
  check('重複を作らない: 同一内容の再取り込みで件数が増えない', afterDup.length === 1, `件数=${afterDup.length}`);
  check('内容が変わっていない再取り込みはaddedAtを更新しない', afterDup[0]?.addedAt === firstAddedAt);

  // 同じ出所だが内容が変わった場合は上書きされる(件数は増えないが内容は更新される)。
  const songBytesV2 = new TextEncoder().encode('A T140 o5 l4 v10 cdefgab');
  await saveSong(db, {
    driver: 'mucom', fileName: 'test.muc', title: 'v2', composer: null, trackNumber: null,
    origin: originLocal, bytes: songBytesV2,
  });
  const afterUpdate = await listSongs(db);
  check('内容が変わった同一出所の再取り込みは件数を増やさず上書きする', afterUpdate.length === 1, `件数=${afterUpdate.length}`);
  check('上書き後は新しい内容になっている', afterUpdate[0]?.title === 'v2' && hashBytes(afterUpdate[0]?.bytes) === hashBytes(songBytesV2));
  check('上書きしてもaddedAt(初回保存日時)は保持される', afterUpdate[0]?.addedAt === firstAddedAt);

  // 別の出所(URL由来)を保存すると件数が増える(=検査が「常に1」の壊れた実装ではないことの確認)。
  const originUrl = { kind: 'url', url: 'https://example.com/song.muc', archiveName: null, groupPath: null, entryPath: null };
  await saveSong(db, {
    driver: 'mucom', fileName: 'song.muc', title: null, composer: null, trackNumber: null,
    origin: originUrl, bytes: new TextEncoder().encode('A T100 cdefg'),
  });
  const afterSecond = await listSongs(db);
  check('別の出所を保存すると件数が増える(重複チェックが常にPASSする壊れた検査でないことの確認)', afterSecond.length === 2, `件数=${afterSecond.length}`);

  // (c) 削除
  const idToDelete = afterSecond.find((s) => s.fileName === 'song.muc').id;
  await deleteSong(db, idToDelete);
  const afterDelete = await listSongs(db);
  check('削除が効く', afterDelete.length === 1, `件数=${afterDelete.length}`);

  await clearAllSongs(db);
  const afterClear = await listSongs(db);
  check('全削除が効く', afterClear.length === 0, `件数=${afterClear.length}`);
}

// --- (d) computeSongId() --------------------------------------------------------------

function testComputeSongId() {
  const idArchive1 = computeSongId({ kind: 'url', url: 'https://x/a.zip', entryPath: 'MML_A.d88/x.muc' }, 'x.muc');
  const idArchive2 = computeSongId({ kind: 'url', url: 'https://x/a.zip', entryPath: 'MML_A.d88/x.muc' }, 'x.muc');
  const idArchiveOther = computeSongId({ kind: 'url', url: 'https://x/a.zip', entryPath: 'MML_B.d88/x.muc' }, 'x.muc');
  check('computeSongId(): 同じURL+書庫内パスは同じid', idArchive1 === idArchive2);
  check('computeSongId(): 書庫内パスが違えば別id', idArchive1 !== idArchiveOther);

  const idUrlSingle = computeSongId({ kind: 'url', url: 'https://x/song.muc', entryPath: null }, 'song.muc');
  check('computeSongId(): 単体ファイルURLはURL自身がキー', idUrlSingle === 'url:https://x/song.muc');

  const idLocal1 = computeSongId({ kind: 'local', url: null, entryPath: null }, 'a.muc');
  const idLocal2 = computeSongId({ kind: 'local', url: null, entryPath: null }, 'b.muc');
  check('computeSongId(): ローカルはファイル名がキー', idLocal1 === 'local:a.muc' && idLocal2 === 'local:b.muc');
  check('computeSongId(): ローカルはファイル名が違えば別id', idLocal1 !== idLocal2);
}

// --- (e) hashBytes() --------------------------------------------------------------------

function testHashBytes() {
  const a = new TextEncoder().encode('hello');
  const aCopy = new TextEncoder().encode('hello');
  const b = new TextEncoder().encode('hello!');
  check('hashBytes(): 同一内容は同じハッシュ', hashBytes(a) === hashBytes(aCopy));
  check('hashBytes(): 異なる内容は異なるハッシュ', hashBytes(a) !== hashBytes(b));
}

// --- (f) groupSongsIntoAlbums() ---------------------------------------------------------

function testGroupSongsIntoAlbums() {
  const songs = [
    { id: '1', fileName: 'b.muc', title: 'B曲', trackNumber: 2, origin: { archiveName: 'sample.zip', url: 'https://x/sample.zip', groupPath: ['MML_TEST.d88'] } },
    { id: '2', fileName: 'a.muc', title: 'A曲', trackNumber: 1, origin: { archiveName: 'sample.zip', url: 'https://x/sample.zip', groupPath: ['MML_TEST.d88'] } },
    { id: '3', fileName: 'c.muc', title: 'C曲', trackNumber: 1, origin: { archiveName: 'sample.zip', url: 'https://x/sample.zip', groupPath: ['MML_OTHER.d88'] } },
    { id: '4', fileName: 'local.muc', title: null, trackNumber: null, origin: { kind: 'local', url: null, archiveName: null, groupPath: null } },
  ];
  const albums = groupSongsIntoAlbums(songs);
  check('groupSongsIntoAlbums(): d88単位で3グループ+個別ファイル1グループ = 3件のアルバム', albums.length === 3, `${albums.map((a) => `${a.label}(${a.songs.length})`).join(', ')}`);
  const testAlbum = albums.find((a) => a.label === 'TEST');
  check('groupSongsIntoAlbums(): アルバムラベルがMML_接頭辞/.d88拡張子を落として"TEST"になる', Boolean(testAlbum));
  check('groupSongsIntoAlbums(): アルバム内はtrackNumber順', testAlbum && testAlbum.songs[0].id === '2' && testAlbum.songs[1].id === '1');
  const otherFilesAlbum = albums.find((a) => a.id === 'other');
  check('groupSongsIntoAlbums(): groupPath無しの曲は「個別ファイル」にまとまる', Boolean(otherFilesAlbum) && otherFilesAlbum.songs.length === 1);
  check('groupSongsIntoAlbums(): 「個別ファイル」は常に末尾', albums[albums.length - 1].id === 'other');
}

// --- (g) net/album-info.js parseTrackList() (合成データ) -------------------------------
// 実物のLIST_*.txt(著作物、リポジトリに同梱しない)と同じ書式を模した合成データ。
// タブ区切り2フィールド、複数スペース区切り、曲名+作曲者+ファイル名コードの3フィールドを
// それぞれ確認する(実物10種類の書式ばらつきをtools/verify_library.mjs作成時に
// 目視確認した結果、区切りは「タブ1本以上」または「半角スペース2個以上」のどちらか
// である一方、曲名内の単語区切りは半角スペース1個であることが分かっている)。
function testParseTrackListSynthetic() {
  const tabSeparated = '1. Song One\tcode01\r\n2. Song Two\t\tcode02\r\n';
  const tracksTab = parseTrackList(tabSeparated);
  check('parseTrackList(): タブ区切り2フィールドを解析できる',
    tracksTab.length === 2 && tracksTab[0].title === 'Song One' && tracksTab[0].fileNameCode === 'code01' && tracksTab[0].composer === null,
    JSON.stringify(tracksTab));

  const spaceSeparated = '1.  Space Title With Words   code03\r\n';
  const tracksSpace = parseTrackList(spaceSeparated);
  check('parseTrackList(): 複数スペース区切りでも曲名内の単語区切り(スペース1個)を割らない',
    tracksSpace.length === 1 && tracksSpace[0].title === 'Space Title With Words' && tracksSpace[0].fileNameCode === 'code03',
    JSON.stringify(tracksSpace));

  const withComposer = '1. Composed Title             Some Composer\tcode04\r\n';
  const tracksComposer = parseTrackList(withComposer);
  check('parseTrackList(): 曲名+作曲者+ファイル名コードの3フィールドを解析できる',
    tracksComposer.length === 1 && tracksComposer[0].title === 'Composed Title' &&
    tracksComposer[0].composer === 'Some Composer' && tracksComposer[0].fileNameCode === 'code04',
    JSON.stringify(tracksComposer));

  const noNumberPrefix = 'not a track line\r\n1. Real Track\tcode05\r\n';
  const tracksMixed = parseTrackList(noNumberPrefix);
  check('parseTrackList(): 番号プレフィックス("N.")の無い行は無視する', tracksMixed.length === 1 && tracksMixed[0].fileNameCode === 'code05');

  // albumGroupPathFor(): d88セグメントが経路のどこにあっても(zip直下でもサブフォルダでも)拾える。
  const gp1 = albumGroupPathFor('MCM_sample_20190124/MML_BOSCONIAN.d88/bos010.muc');
  const gp2 = albumGroupPathFor('MML_BOSCONIAN.d88/bos010.muc');
  const gp3 = albumGroupPathFor('flat_song.muc');
  check('albumGroupPathFor(): サブフォルダ配下でもd88セグメントを見つける', JSON.stringify(gp1) === JSON.stringify(['MML_BOSCONIAN.d88']));
  check('albumGroupPathFor(): zip直下のd88でも同じ結果', JSON.stringify(gp2) === JSON.stringify(['MML_BOSCONIAN.d88']));
  check('albumGroupPathFor(): d88を含まないパスはnull(=書庫全体が1アルバム)', gp3 === null);
  check('albumLabelFor(): "MML_"接頭辞と".d88"拡張子を落とす', albumLabelFor(['MML_BOSCONIAN.d88'], 'archive.zip') === 'BOSCONIAN');
  check('albumLabelFor(): groupPath無しは書庫のラベルをそのまま使う', albumLabelFor(null, 'archive.zip') === 'archive.zip');

  // resolveTrackInfo(): LIST_*.txtが無い書庫でも例外を投げずnullを返す(壊れない)。
  const noListEntries = [{ name: 'MML_BOSCONIAN.d88/bos010.muc', data: new Uint8Array() }];
  const info = resolveTrackInfo(noListEntries, 'MML_BOSCONIAN.d88/bos010.muc');
  check('resolveTrackInfo(): LIST_*.txtが無い書庫では例外を投げずnullを返す(壊れない)',
    info.trackTitle === null && info.trackNumber === null && info.composer === null);

  // resolveTrackInfo(): LIST_*.txtがあれば対応するファイル名コードでトラック名を拾える。
  const listText = '1. Synthetic Title\tsyn01\r\n';
  const withListEntries = [
    { name: 'MCM_x/MML_TESTALBUM.d88/syn01.muc', data: new Uint8Array() },
    { name: 'MCM_x/LIST_TESTALBUM.txt', data: new TextEncoder().encode(listText) },
  ];
  const info2 = resolveTrackInfo(withListEntries, 'MCM_x/MML_TESTALBUM.d88/syn01.muc');
  check('resolveTrackInfo(): LIST_<ラベル>.txtとMML_<ラベル>.d88が対応づけばトラック名を拾える',
    info2.trackTitle === 'Synthetic Title' && info2.trackNumber === 1, JSON.stringify(info2));

  // 対応づけに失敗した場合(ファイル名コードが一致しない)はフォールバック(null)。
  const info3 = resolveTrackInfo(withListEntries, 'MCM_x/MML_TESTALBUM.d88/unknown_file.muc');
  check('resolveTrackInfo(): 対応するファイル名コードが無ければ無理に当てずnullを返す', info3.trackTitle === null);
}

// --- (h) 実データ(MCM_sample_20190124.zip)でのアルバム分割・トラック名解決 -------------

async function testRealArchiveIfAvailable() {
  const zipPath = process.env.MCM_SAMPLE_ZIP;
  if (!zipPath) {
    console.log('[SKIP] MCM_SAMPLE_ZIP が未設定のため、実データでのアルバム/トラック検証をスキップします。');
    console.log('       (著作物のためリポジトリに同梱していない。tools/verify_d88.mjsと同じ材料)');
    return;
  }
  const { extractArchive } = await import('../net/archive.js');
  const { findSongCandidates } = await import('../net/song-select.js');

  const zipBytes = new Uint8Array(readFileSync(zipPath));
  const archiveLabel = zipPath.split('/').pop();
  const entries = await extractArchive(archiveLabel, zipBytes);
  const candidates = findSongCandidates(entries).filter((c) => c.driver === 'mucom');
  check('実データ: MUCOM88の曲候補が見つかる', candidates.length > 0, `${candidates.length}曲`);

  // 各候補についてアルバム(d88単位)/トラック名解決を行い、合成のSongレコード形にする
  // (曲ライブラリへの実際の保存は行わず、net/album-info.js + net/library.jsの
  // グループ化ロジックだけをここで直接確認する)。
  let resolvedCount = 0;
  let fallbackCount = 0;
  const songs = candidates.map((c, i) => {
    const groupPath = albumGroupPathFor(c.entry.name);
    const trackInfo = resolveTrackInfo(entries, c.entry.name);
    if (trackInfo.trackTitle) resolvedCount++;
    else fallbackCount++;
    return {
      id: String(i),
      fileName: c.displayName,
      title: trackInfo.trackTitle, // このzipの曲は#titleを持たないので基本的にtrackInfo由来
      trackNumber: trackInfo.trackNumber,
      origin: { kind: 'url', url: `file://${zipPath}`, archiveName: archiveLabel, groupPath, entryPath: c.entry.name },
    };
  });

  const albums = groupSongsIntoAlbums(songs);
  check('実データ: アルバムがd88単位で複数に分かれる(1アルバムに集約されていない)', albums.length > 1, `${albums.length}アルバム`);
  console.log(`[INFO] 実データ集計: ${albums.length}アルバム / 合計${songs.length}曲`);
  for (const album of albums) {
    console.log(`[INFO]   - ${album.label}: ${album.songs.length}曲`);
  }
  console.log(`[INFO] LIST_*.txtからトラック名を採れた曲: ${resolvedCount}曲 / ファイル名にフォールバックした曲: ${fallbackCount}曲`);

  // 既知の期待値: tools/verify_d88.mjsは `MML_*.d88`(10枚、合計46曲)だけを見ているが、
  // このzipには加えて `MUCOM88_V1.7_<タイトル>.d88`(V1.7ドライバの動作確認用に同梱された
  // システムディスク3枚: BARE_KNUCKLE2/BOSCONIAN/Etrian_Odyssey、各3曲=9曲)にも
  // MUCOM88のMMLとして認識できる曲が入っている(findSongCandidates()はファイル名ではなく
  // 中身で判定するため、これも正しく曲として拾う)。これらのディスクは`MML_`命名規則にも
  // 乗らず対応する`LIST_*.txt`も無いため、「アルバムとしては別枠(ラベルは生のディスク名)、
  // トラック名はファイル名へフォールバック」になるのが正しい挙動(無理に当てない、の実例)。
  // 合計: 10(MML_*)+3(MUCOM88_V1.7_*) = 13アルバム、46+9 = 55曲。
  check('実データ: 13アルバムに分かれる(MML_*.d88 10枚 + MUCOM88_V1.7_*.d88のうちMMLを含む3枚)', albums.length === 13, `${albums.length}アルバム`);
  check('実データ: 合計55曲(findSongCandidates()が中身で判定した結果、V1.7システムディスク由来の9曲を含む)', songs.length === 55, `${songs.length}曲`);
  check('実データ: MML_*.d88由来の46曲は全てLIST_*.txtからトラック名を拾えている',
    resolvedCount === 46, `拾えた=${resolvedCount}`);
  check('実データ: MUCOM88_V1.7_*.d88由来の9曲はLIST_*.txtが無いためファイル名にフォールバックする(無理に当てない)',
    fallbackCount === 9, `フォールバック=${fallbackCount}`);
  // 利用者指示(2026-08-16): 規則に乗らないアルバム(MUCOM88_V1.7_*.d88由来)でも
  // 見た目を揃えるため、少なくとも拡張子は落ちていること(ラベルに".d88"が残っていないこと)。
  const labelsWithD88Ext = albums.map((a) => a.label).filter((label) => /\.d88$/i.test(label));
  check('実データ: どのアルバムラベルにも".d88"拡張子が残っていない', labelsWithD88Ext.length === 0, JSON.stringify(labelsWithD88Ext));
}

// --- (j) albumLabelFor(): 命名規則に乗らないd88でも拡張子だけは落ちること -----------------

function testAlbumLabelExtensionStrip() {
  check('albumLabelFor(): MML_接頭辞規則に乗る場合は従来どおり(回帰確認)',
    albumLabelFor(['MML_BOSCONIAN.d88'], 'archive.zip') === 'BOSCONIAN');
  check('albumLabelFor(): 規則に乗らないd88(システムディスク等)でも".d88"拡張子は落ちる',
    albumLabelFor(['MUCOM88_V1.7_BOSCONIAN.d88'], 'archive.zip') === 'MUCOM88_V1.7_BOSCONIAN');
  check('albumLabelFor(): 大文字小文字を問わず拡張子を落とす', albumLabelFor(['FOO.D88'], 'archive.zip') === 'FOO');
}

// --- (i) 書庫を開いた時点で全曲がライブラリへ入ること(net/library.js importArchiveSongs()) ---
//
// 修正前(利用者報告、2026-08-16実測): 「?mml=で書庫を開いて55曲の一覧が出た時点では
// 保存件数0、そこから1曲選ぶと1件だけ入る」という不備があった。これを再現した
// 「選ばれた曲だけを保存する」壊れた実装を先に用意し、それがこの検査で実際にFAILする
// ことを確認してから(陽性対照)、現在の実装(候補全部を1トランザクションで一括保存)が
// PASSすることを確認する。

/** 修正前の挙動を模した「選ばれた1曲だけ保存する」実装(陽性対照専用、意図的に壊れている)。 */
async function brokenImportOnlyFirstCandidate({ driver, url, entries, archiveLabel, candidates }, db) {
  const first = candidates[0];
  const trackInfo = resolveTrackInfo(entries, first.entry.name);
  await saveSong(db, {
    driver,
    fileName: first.displayName,
    title: trackInfo.trackTitle,
    composer: trackInfo.composer,
    trackNumber: trackInfo.trackNumber,
    origin: { kind: 'url', url, archiveName: archiveLabel, groupPath: albumGroupPathFor(first.entry.name), entryPath: first.entry.name },
    bytes: first.entry.data,
  });
  return { total: candidates.length, added: 1, unchanged: 0 };
}

function makeSyntheticArchiveCandidates(count) {
  const candidates = [];
  for (let i = 1; i <= count; i++) {
    const fileName = `song${String(i).padStart(2, '0')}.muc`;
    candidates.push({
      driver: 'mucom',
      displayName: fileName,
      entry: { name: `MML_SYNTH.d88/${fileName}`, data: new TextEncoder().encode(`A T120 o5 l4 v${i} cdefg`) },
    });
  }
  return candidates;
}

async function testBulkArchiveImport() {
  const candidates = makeSyntheticArchiveCandidates(55); // 実データ(MCM_sample_20190124.zip)と同じ規模で確認する
  const archiveInput = { driver: 'mucom', url: 'https://example.com/synth.zip', entries: [], archiveLabel: 'synth.zip', candidates };

  // 陽性対照: 修正前の実装(選ばれた1曲だけ保存)を通すと、この検査は実際にFAILすること。
  {
    const fakeIdb = new FakeIDBFactory();
    const db = await openLibraryDb(fakeIdb);
    await brokenImportOnlyFirstCandidate(archiveInput, db);
    const songs = await listSongs(db);
    check('陽性対照: 修正前の実装(選ばれた1曲だけ保存)ではこの検査は失敗する(55曲中1曲しか入らない)',
      songs.length !== candidates.length, `件数=${songs.length}(期待は${candidates.length}との不一致)`);
  }

  // 本題: 現在の実装(importArchiveSongs())は書庫を開いた時点で全曲を保存する。
  const fakeIdb = new FakeIDBFactory();
  const db = await openLibraryDb(fakeIdb);
  const beforeImport = await listSongs(db);
  check('陽性対照(前半): 取り込み前は0件', beforeImport.length === 0);

  const started = Date.now();
  const result1 = await importArchiveSongs(db, archiveInput);
  const elapsedMs = Date.now() - started;
  const afterImport = await listSongs(db);
  check('書庫を開いた時点で(1曲も選ばずに)全曲がライブラリへ入る',
    afterImport.length === candidates.length, `件数=${afterImport.length}/${candidates.length}`);
  check('importArchiveSongs()の戻り値のtotal/addedが一致する',
    result1.total === candidates.length && result1.added === candidates.length,
    JSON.stringify(result1));
  console.log(`[INFO] 55曲一括取り込みの所要時間: ${elapsedMs}ms(フェイクIndexedDB、参考値)`);

  // 重複判定は既存のまま効く: 同じ書庫をもう一度開いても件数が増えない。
  const result2 = await importArchiveSongs(db, archiveInput);
  const afterSecondImport = await listSongs(db);
  check('同じ書庫を2回取り込んでも件数が増えない(重複判定が効いている)',
    afterSecondImport.length === candidates.length, `件数=${afterSecondImport.length}`);
  check('2回目の取り込みはaddedが0(既に同一内容のため書き込みを省略)', result2.added === 0 && result2.unchanged === candidates.length,
    JSON.stringify(result2));

  // アルバムに組み立てても全曲が1アルバムにまとまっていること(2度目以降にアルバムを
  // 開けば全曲選べる、という当初の目的が満たされていることの確認)。
  const albums = groupSongsIntoAlbums(afterImport);
  const synthAlbum = albums.find((a) => a.label === 'SYNTH');
  check('取り込んだ全曲が1つのアルバム(SYNTH)にまとまっている',
    Boolean(synthAlbum) && synthAlbum.songs.length === candidates.length,
    `${synthAlbum?.songs.length ?? 0}/${candidates.length}`);
}

// --- (k) PMDのPCM(pcmRefs/PCM_STORE_NAME)の共有保存・解決・削除時の孤児回収 ------------
//
// 不具合(利用者報告): 書庫を開いた直後はcollectPmdPcmFiles()が拾ったPCMが
// writeSongWithPcm()と同居して鳴るが、importArchiveSongs()は曲の生バイト列だけを
// 保存しておりPCMを保存していなかった。そのため曲ライブラリから選び直すとPCM無しで
// 再生され無音になる。
//
// バイト列の比較は必ず内容(byte-for-byte)で行う(長さの比較へ弱めない、利用者指示)。

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 決定的な合成PCMバイト列を作る(実データを使わず、テストごとに違う内容にする)。 @param {number} seed @param {number} len */
function makeSyntheticPcm(seed, len) {
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = (seed * 31 + i * 7) & 0xff;
  return bytes;
}

async function testPmdPcmSharing() {
  const sharedPcm = makeSyntheticPcm(1, 4096); // 実データのPPZ8バンク(数百KB〜数MB)を模した合成データ(サイズは検証時間短縮のため縮小)
  const pcmName = 'SHARED.PPC';

  // 2曲が同じディレクトリの同じPCMを参照する書庫を合成する。
  const entries = [
    { name: 'DISK/song01.M', data: new TextEncoder().encode('song01-body') },
    { name: 'DISK/song02.M', data: new TextEncoder().encode('song02-body') },
    { name: `DISK/${pcmName}`, data: sharedPcm },
  ];
  const candidates = [
    { driver: 'pmd', displayName: 'song01.M', entry: entries[0] },
    { driver: 'pmd', displayName: 'song02.M', entry: entries[1] },
  ];
  const archiveInput = { driver: 'pmd', url: 'https://example.com/pcmtest.zip', entries, archiveLabel: 'pcmtest.zip', candidates };

  // --- [陽性対照] PCMを保存しない旧挙動(collectPmdPcmFiles()の結果をpcmFilesとして
  // 渡さない = 修正前のimportArchiveSongs())では、ライブラリ選択後の解決が空になり
  // (=無音になる症状そのもの)、この後の本題検査が実際にFAILすることを先に確認する。
  {
    const fakeIdb = new FakeIDBFactory();
    const db = await openLibraryDb(fakeIdb);
    // 修正前のimportArchiveSongs()を模す: pcmFilesを一切渡さずsaveSongsする。
    const brokenInputs = candidates.map((c) => ({
      driver: 'pmd',
      fileName: c.displayName,
      title: null,
      composer: null,
      trackNumber: null,
      origin: { kind: 'url', url: archiveInput.url, archiveName: 'pcmtest.zip', groupPath: null, entryPath: c.entry.name },
      bytes: c.entry.data,
      // pcmFiles省略(=修正前の実装が持っていなかったフィールド)。
    }));
    for (const input of brokenInputs) await saveSong(db, input);
    const brokenSongs = await listSongs(db);
    const brokenSong1 = brokenSongs.find((s) => s.fileName === 'song01.M');
    const resolvedBroken = await loadPcmFilesForSong(db, brokenSong1);
    check(
      '陽性対照: PCMを保存しない旧挙動では、ライブラリ選び直し後のPCM解決が空になる(=無音になる症状そのもの)',
      resolvedBroken.length === 0,
      `resolved=${resolvedBroken.length}件(期待は1件のSHARED.PPCとの不一致)`,
    );
  }

  // --- 本題: 現在の実装 ------------------------------------------------------------
  const fakeIdb = new FakeIDBFactory();
  const db = await openLibraryDb(fakeIdb);
  await importArchiveSongs(db, archiveInput);
  const songs = await listSongs(db);
  const song1 = songs.find((s) => s.fileName === 'song01.M');
  const song2 = songs.find((s) => s.fileName === 'song02.M');
  check('取り込んだ2曲がともにpcmRefsを1件持つ',
    Boolean(song1) && Boolean(song2) && song1.pcmRefs?.length === 1 && song2.pcmRefs?.length === 1,
    JSON.stringify({ ref1: song1?.pcmRefs, ref2: song2?.pcmRefs }));

  // [本体] 元と同一のバイト列が返る(長さだけでなく内容で比較)。
  const resolved1 = await loadPcmFilesForSong(db, song1);
  check('loadPcmFilesForSong(): 元と同一のバイト列が返る(内容比較)',
    resolved1.length === 1 && resolved1[0].name === pcmName && bytesEqual(resolved1[0].data, sharedPcm),
    `件数=${resolved1.length}`);

  // [本体] 同じPCMを参照する曲を複数取り込んでも、PCMストアの実体は1件だけ。
  check('同じPCMを参照する2曲を取り込んでもPCMストアの実体は1件だけ(重複保存していない)',
    db.stores.get(PCM_STORE_NAME).size === 1, `件数=${db.stores.get(PCM_STORE_NAME).size}`);

  // [本体] 同名で中身が違うPCM(JSM/MF88PCM.PPC・YD/MF88PCM.PPC相当)が曲ごとに正しく
  // 別のバイト列に解決される(コミット6de2839の同名解決規則: 曲と同じディレクトリを優先)。
  const pcmA = makeSyntheticPcm(2, 512);
  const pcmB = makeSyntheticPcm(3, 512);
  check('陽性対照: 合成した2つの同名PCMは内容が違う(検査自体が意味を持つことの確認)', !bytesEqual(pcmA, pcmB));
  const dupEntries = [
    { name: 'JSM/song.M', data: new TextEncoder().encode('jsm-song') },
    { name: 'JSM/MF88PCM.PPC', data: pcmA },
    { name: 'YD/song.M', data: new TextEncoder().encode('yd-song') },
    { name: 'YD/MF88PCM.PPC', data: pcmB },
  ];
  const dupCandidates = [
    { driver: 'pmd', displayName: 'jsm-song.M', entry: dupEntries[0] },
    { driver: 'pmd', displayName: 'yd-song.M', entry: dupEntries[2] },
  ];
  const dupFakeIdb = new FakeIDBFactory();
  const dupDb = await openLibraryDb(dupFakeIdb);
  await importArchiveSongs(dupDb, { driver: 'pmd', url: 'https://example.com/dup.zip', entries: dupEntries, archiveLabel: 'dup.zip', candidates: dupCandidates });
  const dupSongs = await listSongs(dupDb);
  const jsmSong = dupSongs.find((s) => s.fileName === 'jsm-song.M');
  const ydSong = dupSongs.find((s) => s.fileName === 'yd-song.M');
  const jsmResolved = await loadPcmFilesForSong(dupDb, jsmSong);
  const ydResolved = await loadPcmFilesForSong(dupDb, ydSong);
  check('同名PCM(JSM/MF88PCM.PPC)は曲ごとに正しく別のバイト列(自ディレクトリのもの)に解決される',
    jsmResolved.length === 1 && bytesEqual(jsmResolved[0].data, pcmA) && !bytesEqual(jsmResolved[0].data, pcmB),
    `jsm.hash=${jsmSong?.pcmRefs?.[0]?.hash}`);
  check('同名PCM(YD/MF88PCM.PPC)は曲ごとに正しく別のバイト列(自ディレクトリのもの)に解決される',
    ydResolved.length === 1 && bytesEqual(ydResolved[0].data, pcmB) && !bytesEqual(ydResolved[0].data, pcmA),
    `yd.hash=${ydSong?.pcmRefs?.[0]?.hash}`);
  check('同名でも中身が違うPCMはPCMストアで別レコード扱い(ハッシュが異なる)',
    jsmSong.pcmRefs[0].hash !== ydSong.pcmRefs[0].hash);

  // [本体] deleteSong(): その曲だけが参照していたPCMは消え、他の曲がまだ参照している
  // PCMは残る。
  check('削除前: PCMストアに1件ある(song1/song2が共有)', db.stores.get(PCM_STORE_NAME).size === 1);
  await deleteSong(db, song1.id);
  check('song1だけを削除しても、song2がまだ参照しているPCMは残る(孤児ではない)',
    db.stores.get(PCM_STORE_NAME).size === 1, `件数=${db.stores.get(PCM_STORE_NAME).size}`);
  await deleteSong(db, song2.id);
  check('参照する曲が0件になったPCMは孤児として回収される(削除後にストレージが減る)',
    db.stores.get(PCM_STORE_NAME).size === 0, `件数=${db.stores.get(PCM_STORE_NAME).size}`);

  // [本体] clearAllSongs(): PCMストアも空になる。
  await importArchiveSongs(dupDb, { driver: 'pmd', url: 'https://example.com/dup.zip', entries: dupEntries, archiveLabel: 'dup.zip', candidates: dupCandidates });
  check('clearAllSongs()前: PCMストアに2件(pcmA/pcmB)ある', dupDb.stores.get(PCM_STORE_NAME).size === 2);
  await clearAllSongs(dupDb);
  check('clearAllSongs(): PCMストアも空になる', dupDb.stores.get(PCM_STORE_NAME).size === 0);

  // [本体] 参照先PCMが存在しない場合、loadPcmFilesForSong()はその要素を落として残りを
  // 返す(例外を投げて再生自体を止めない)。
  const missingFakeIdb = new FakeIDBFactory();
  const missingDb = await openLibraryDb(missingFakeIdb);
  await importArchiveSongs(missingDb, archiveInput);
  const missingSongs = await listSongs(missingDb);
  const missingSong1 = missingSongs.find((s) => s.fileName === 'song01.M');
  const missingHash = missingSong1.pcmRefs[0].hash;
  missingDb.stores.get(PCM_STORE_NAME).delete(missingHash); // DBが部分的に消えた状況を模す
  let threw = false;
  let resolvedAfterLoss;
  try {
    resolvedAfterLoss = await loadPcmFilesForSong(missingDb, missingSong1);
  } catch {
    threw = true;
  }
  check('参照先PCMが無い場合、loadPcmFilesForSong()は例外を投げずその要素を落とす(空データで埋めない)',
    !threw && Array.isArray(resolvedAfterLoss) && resolvedAfterLoss.length === 0,
    `threw=${threw}, resolved=${JSON.stringify(resolvedAfterLoss)}`);

  // [本体] DB_VERSION 1で作った既存DB(曲レコードあり・PCMストアなし)を開いたとき、
  // 曲が消えずに新ストアが作られること(利用者からの実際の退行報告を避けるための検証)。
  const legacyFakeIdb = new FakeIDBFactory();
  const legacySong = {
    schemaVersion: 1,
    id: 'local:legacy.muc',
    driver: 'mucom',
    fileName: 'legacy.muc',
    title: null,
    composer: null,
    trackNumber: null,
    origin: { kind: 'local', url: null, archiveName: null, groupPath: null, entryPath: null },
    bytes: new TextEncoder().encode('A T120 cdefg'),
    voiceBank: null,
    voiceBankSource: null,
    contentHash: hashBytes(new TextEncoder().encode('A T120 cdefg')),
    addedAt: 1000,
    updatedAt: 1000,
    // pcmRefsフィールド自体を持たない(v1のレコード形そのもの)。
  };
  const legacyDbRaw = legacyFakeIdb.seedLegacyV1Database(DB_NAME, [legacySong]);
  check('前提: フェイクDBの直接組み立て時点でPCMストアはまだ存在しない(v1相当)',
    !legacyDbRaw.objectStoreNames.contains(PCM_STORE_NAME));
  const upgradedDb = await openLibraryDb(legacyFakeIdb);
  const songsAfterUpgrade = await listSongs(upgradedDb);
  check('DB_VERSION 1→2への昇格後も既存の曲レコードは消えない',
    songsAfterUpgrade.length === 1 && songsAfterUpgrade[0].id === 'local:legacy.muc',
    `件数=${songsAfterUpgrade.length}`);
  check('DB_VERSION 1→2への昇格でPCMストアが新設される',
    upgradedDb.objectStoreNames.contains(PCM_STORE_NAME));
  // 昇格後のDBでも通常のCRUDが機能すること(新ストアが使い物になることの確認)。
  const afterUpgradeSave = await saveSong(upgradedDb, {
    driver: 'pmd', fileName: 'new-after-upgrade.M', title: null, composer: null, trackNumber: null,
    origin: { kind: 'local', url: null, archiveName: null, groupPath: null, entryPath: null },
    bytes: new TextEncoder().encode('new-song-body'),
    pcmFiles: [{ name: 'X.PPC', data: makeSyntheticPcm(9, 128) }],
  });
  const songsAfterUpgradeSave = await listSongs(upgradedDb);
  check('昇格後のDBでも新規保存(PCM付き)が正常に機能する',
    songsAfterUpgradeSave.length === 2 && upgradedDb.stores.get(PCM_STORE_NAME).size === 1,
    `id=${afterUpgradeSave}`);
}

// --- (l) [結線] html/pmd-app.jsのライブラリ選択経路が解決したPCMをplayBytes()へ渡すこと ---
// (文字列検査。DOM無しでpmd-app.js全体を評価するのは重いため、他ファイルと同じく
// tools/verify_pmd_pcm_missing.mjs等の作法(文字列検査)に倣う)。

function testPmdAppLibraryWiring() {
  const src = readFileSync(new URL('../html/pmd-app.js', import.meta.url), 'utf-8');
  check('html/pmd-app.js: loadPcmFilesForSong()をimportしている',
    /import\s*\{\s*loadPcmFilesForSong\s*\}\s*from\s*['"]\.\/net\/library\.js['"]/.test(src));
  const onSelectMatch = /onSelect:\s*async\s*\(song\)\s*=>\s*\{[\s\S]*?\n\s{4}\},/.exec(src);
  check('html/pmd-app.js: library-panelのonSelectブロックが見つかる', Boolean(onSelectMatch));
  const onSelectBody = onSelectMatch ? onSelectMatch[0] : '';
  check('html/pmd-app.js: onSelect内でloadPcmFilesForSong()を呼んでいる',
    /loadPcmFilesForSong\(/.test(onSelectBody));
  // 【拡張・2026-08-18】MMLソース連動(tools/verify_pmd_mml_source.mjs参照)で
  // playBytes()に6番目の引数(mmlSourceText)が加わったため、pcmFilesの直後で
  // 閉じることをもう要求しない(呼び出し自体・pcmFilesの位置は変わっていない)。
  check('html/pmd-app.js: onSelect内で解決したpcmFilesをplayBytes()へ渡している',
    /playBytes\(\s*song\.bytes\s*,\s*song\.fileName\s*,\s*undefined\s*,\s*pcmFiles\s*,/.test(onSelectBody));
}

// --- 実行 --------------------------------------------------------------------------

await testStorageLayer();
testComputeSongId();
testHashBytes();
testGroupSongsIntoAlbums();
testParseTrackListSynthetic();
testAlbumLabelExtensionStrip();
await testBulkArchiveImport();
await testPmdPcmSharing();
testPmdAppLibraryWiring();
await testRealArchiveIfAvailable();

console.log('---');
console.log(`${passed} 件 PASS / ${failed} 件 FAIL`);
if (failed > 0) process.exit(1);
