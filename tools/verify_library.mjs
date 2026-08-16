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
//
// 実行: node tools/verify_library.mjs
//       MCM_SAMPLE_ZIP=/path/to/mcm.zip node tools/verify_library.mjs (実データ検証込み)

import { readFileSync } from 'node:fs';

import {
  openLibraryDb, saveSong, listSongs, deleteSong, clearAllSongs,
  computeSongId, hashBytes, groupSongsIntoAlbums,
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

class FakeIDBFactory {
  constructor() {
    this.databases = new Map();
  }
  open(name) {
    const req = new FakeRequest();
    const isNew = !this.databases.has(name);
    if (isNew) this.databases.set(name, new FakeDatabase());
    const db = this.databases.get(name);
    setTimeout(() => {
      req.result = db;
      if (isNew && req.onupgradeneeded) req.onupgradeneeded({ target: req });
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
}

// --- 実行 --------------------------------------------------------------------------

await testStorageLayer();
testComputeSongId();
testHashBytes();
testGroupSongsIntoAlbums();
testParseTrackListSynthetic();
await testRealArchiveIfAvailable();

console.log('---');
console.log(`${passed} 件 PASS / ${failed} 件 FAIL`);
if (failed > 0) process.exit(1);
