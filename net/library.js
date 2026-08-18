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
//
// 【拡張・2026-08-18】voiceBank(MUCOM88の外部音色バンク)に続き、PMDのPCM参照
// (pcmRefs)も曲レコードへ追加した。ただしvoiceBankと違い生バイト列そのものは
// 埋め込まない(PPZ8バンクは実測でMSPCM3.PZIが2.3MB・mspcm4.pziが894KBあり、
// 書庫内の全曲を一括取り込みするimportArchiveSongs()の仕様上、曲ごとに複製すると
// ストレージ枠を破綻させるため)。実体は内容ハッシュキーの別ストア(PCM_STORE_NAME)へ
// 1件だけ持ち、曲レコードには{name, hash, size}の参照だけを持たせて共有する。
// voiceBankと同じく既存レコードへの追加フィールド(`?? []`で後方互換)のため
// RECORD_SCHEMA_VERSIONは据え置き(=1のまま)。DBのオブジェクトストア構成自体は
// IndexedDBのバージョニング機構(DB_VERSION 1→2、onupgradeneeded)で扱う。

import { albumGroupPathFor, resolveTrackInfo } from './album-info.js';
import { decodeMmlBytes } from './charset.js';
import { findPairedVoiceBank } from './voice-bank.js';
import { collectPmdPcmFiles } from './pmd-pcm.js';
import { extractMmlSourceText } from './pmd-mml-source.js';
import { selectFfFileForSong } from './pmd-ff.js';

// DB_NAME/STORE_NAME/PCM_STORE_NAMEはexportしてある。net/library.js自体を無改変で
// 検証するtools/verify_library.mjsが、DBバージョン昇格(1→2)検証のために「昇格前の
// 旧DB(曲ストアのみ・PCMストア無し)」をフェイクIndexedDB上に直接組み立てる必要が
// あるため(openLibraryDb()経由では現在のDB_VERSION=2でしか開けない)。
export const DB_NAME = 'fmsound-library';
// 【拡張・2026-08-18】PMDのPCM(.PPC/.PZI/.PVI)をライブラリ選択後も再生できるようにする
// ため、PCM専用ストアを追加した(1→2)。onupgradeneededは新ストアを作るだけで、
// 既存の曲ストア(STORE_NAME)には一切触れない(既存レコードは保持されたまま)。
const DB_VERSION = 2;
const STORE_NAME = 'fmsound-songs';
// PCMストア: キーは内容ハッシュ(hashBytes())。同じPCM(例: 共有音色バンクMSPCM3.PZI)を
// 参照する曲が何十曲あっても実体は1件だけ保存する(書庫を開いた時点で全曲を一括取り込む
// importArchiveSongs()の仕様上、曲ごとに複製するとストレージ枠を破綻させるため)。
export const PCM_STORE_NAME = 'fmsound-pcm';
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
      // DB_VERSION 1→2で追加。既存(v1)のDBを開いたときもここを通るが、既存の
      // STORE_NAMEには触れないため曲は消えない(上のif文と同じ「無ければ作る」形)。
      if (!db.objectStoreNames.contains(PCM_STORE_NAME)) {
        db.createObjectStore(PCM_STORE_NAME, { keyPath: 'hash' });
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
 *
 * 【拡張・2026-08-16】ローカルの書庫(zip/lzh/d88)を開いた場合もentryPathが渡ってくる
 * (importArchiveSongs()参照、kind==='local'でも書庫由来なら渡す)。ファイル名だけでは
 * 同じ書庫内の別ディレクトリにある同名曲が衝突するため、entryPathがあれば
 * `local:<書庫名>::<entryPath>` を使う(URL由来のarchive分岐と同じ考え方)。
 * entryPathが無い(単体ファイル)場合は従来どおりファイル名のみ。
 * @param {{ kind: 'url'|'local', url: string|null, archiveName?: string|null, entryPath: string|null }} origin
 * @param {string} fileName
 */
export function computeSongId(origin, fileName) {
  if (origin.kind === 'url') {
    return origin.entryPath ? `url:${origin.url}::${origin.entryPath}` : `url:${origin.url}`;
  }
  if (origin.entryPath) {
    return `local:${origin.archiveName ?? ''}::${origin.entryPath}`;
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
 *   pcmFiles?: { name: string, data: Uint8Array }[],
 *   mmlSource?: string | null,
 *   ffFile?: Uint8Array | null,
 *   ffFileSource?: string | null,
 *   ffFileMatchedHeaderName?: boolean | null,
 * }} input pcmFiles(PMD専用、PPC/PZI/PVI)は省略時[]扱い(MUCOM側の呼び出しは
 *   このフィールドを渡さないため一切影響しない)。mmlSource(PMD専用、書庫内に
 *   同梱されていた曲のMMLソーステキスト)も同様に省略時null扱い。voiceBankと
 *   同じ考え方(net/pmd-mml-source.js冒頭コメント参照。PCMと違ってテキストは
 *   小さいので内容ハッシュの共有ストアは使わず、レコードのフィールドとして
 *   素直に持たせる)。
 *   ffFile(PMD専用、`#FFFile`が指す外部音色ファイルの生バイト列、net/pmd-ff.js
 *   selectFfFileForSong()の戻り値)も同様に省略時null扱い。【判断】PCM(pcmRefs)は
 *   内容ハッシュ共有ストア(PCM_STORE_NAME)を使うが、.FFはvoiceBankと同じく
 *   レコードへ直接埋め込む: .FFは8192byte固定でvoiceBankと同サイズ、かつ
 *   PPZ8バンク(MB規模、書庫内の全曲で共有)と違い1曲(またはアルバム程度)の
 *   単位で閉じるため、内容ハッシュ共有ストアを新設するほどの理由が無い
 *   (voiceBankの判断コメント=1曲あたり約8KBの複製は許容範囲、と同じ理由)。
 *   ffFileSource(実際に採用した.FFのファイル名)・ffFileMatchedHeaderName
 *   (曲が指定した名前と一致していたか、net/pmd-ff.js describePmdFfStatus()参照)も
 *   一緒に持たせ、ライブラリから選び直したときも同じ案内が出せるようにする。
 * @returns {Promise<string>} 保存したレコードのid
 */
export async function saveSong(db, input) {
  const tx = db.transaction([STORE_NAME, PCM_STORE_NAME], 'readwrite');
  const songStore = tx.objectStore(STORE_NAME);
  const pcmStore = tx.objectStore(PCM_STORE_NAME);
  const { id } = await upsertOne(songStore, pcmStore, input, Date.now());
  return id;
}

/**
 * 曲をまとめて保存する(1トランザクションで書く)。書庫を開いた時点でその中の全曲を
 * 一括取り込みする用途(利用者指示: 「再生した曲だけ」では2度目以降にアルバムを開いても
 * 1曲しか出ない不備があったため、書庫を開いた時点で全曲を入れる仕様に変更した)。
 *
 * 55曲程度でもUIを固めないため、1件ずつ新しいトランザクションを開かず(saveSong()を
 * 55回呼ぶと55個のトランザクションが立つ)、1つのトランザクション内で
 * get→(必要なら)put を曲数ぶん直列に行う。IndexedDBのリクエストは非同期
 * (完了はイベントループに戻ってから通知される)なので、直列にawaitしてもメインスレッドの
 * 描画をブロックしない。
 *
 * 重複判定・上書き規則はsaveSong()と同じ(computeSongId()による同一性判定 + 内容ハッシュ
 * が変わっていなければ書き込み自体を省略)。
 * @param {IDBDatabase} db @param {object[]} inputs saveSong()と同じ形の入力の配列
 * @returns {Promise<{ ids: string[], addedCount: number, unchangedCount: number }>}
 */
export async function saveSongs(db, inputs) {
  const tx = db.transaction([STORE_NAME, PCM_STORE_NAME], 'readwrite');
  const songStore = tx.objectStore(STORE_NAME);
  const pcmStore = tx.objectStore(PCM_STORE_NAME);
  const now = Date.now();
  const ids = [];
  let addedCount = 0;
  let unchangedCount = 0;
  for (const input of inputs) {
    const { id, wasWritten } = await upsertOne(songStore, pcmStore, input, now);
    ids.push(id);
    if (wasWritten) addedCount++;
    else unchangedCount++;
  }
  return { ids, addedCount, unchangedCount };
}

/**
 * PCMファイル(PMDのPPC/PZI/PVI)を内容ハッシュキーでPCMストアへ書き込む。
 * 既に同じハッシュのPCMが保存済みなら書き込みを省略する(=同じPCM(例: 共有音色
 * バンク)を参照する曲が何十曲あっても実体は1件だけになる。importArchiveSongs()が
 * 書庫内の全曲を一括取り込みする以上、複製するとストレージ枠を破綻させるため)。
 * 曲レコードへ埋め込む参照(name/hash/size)だけを返す(生バイト列は曲レコードへ
 * 複製しない)。
 * @param {IDBObjectStore} pcmStore @param {{ name: string, data: Uint8Array }[]} pcmFiles
 * @returns {Promise<{ name: string, hash: string, size: number }[]>}
 */
async function upsertPcmFiles(pcmStore, pcmFiles) {
  const refs = [];
  for (const pcm of pcmFiles) {
    const hash = hashBytes(pcm.data);
    const existing = await promisifyRequest(pcmStore.get(hash));
    if (!existing) {
      await promisifyRequest(pcmStore.put({ hash, data: pcm.data, size: pcm.data.length }));
    }
    refs.push({ name: pcm.name, hash, size: pcm.data.length });
  }
  return refs;
}

/**
 * saveSong()/saveSongs()共通の1件分の更新処理。同じstore(=同じトランザクション)を
 * 使い回せるよう、トランザクションの開始はここでは行わない(呼び出し側の責務)。
 * @param {IDBObjectStore} songStore @param {IDBObjectStore} pcmStore @param {object} input @param {number} now
 * @returns {Promise<{ id: string, wasWritten: boolean }>}
 */
async function upsertOne(songStore, pcmStore, input, now) {
  const id = computeSongId(input.origin, input.fileName);
  const contentHash = hashBytes(input.bytes);
  const existing = await promisifyRequest(songStore.get(id));
  if (existing && existing.contentHash === contentHash) {
    return { id: existing.id, wasWritten: false }; // 内容が変わっていない再取り込みは書き込みを省略する
  }
  // PMDのPCM(.PPC/.PZI/.PVI)参照。importArchiveSongs()がdriver==='pmd'のときだけ
  // pcmFilesを渡すため、MUCOM側の入力には常に存在せず[]になる(=一切影響しない)。
  const pcmRefs = await upsertPcmFiles(pcmStore, input.pcmFiles ?? []);
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
    // #voice(外部音色バンク)対応: 対になるシステムディスクのvoice.datが見つかった曲は
    // ここにそのバイト列(8192byte)を一緒に保存する(net/voice-bank.js参照)。
    // 保存しないと「次回ライブラリから開いたときだけ音が既定バンクに戻ってしまう」
    // 退行になるため、曲本体と同じレコードへ含める判断にした(サイズは1曲あたり
    // 約8KBで許容範囲、archiveを取り直さなくても再生時の音が再現できる)。
    // 対が無い曲(既定バンクのまま)はnull。schemaVersion=1のまま(新規フィールドの
    // 追加のみでマイグレーション不要、既存レコードは読み出し時に`?? null`で扱う)。
    voiceBank: input.voiceBank ?? null,
    voiceBankSource: input.voiceBankSource ?? null,
    // PMDのPCM参照(上のpcmRefs参照)。voiceBankと同じ考え方で、対が無い曲(PPC等を
    // 使わない曲、またはMUCOM側)は[]のまま。schemaVersion=1のまま(新規フィールドの
    // 追加のみでマイグレーション不要、既存レコードは読み出し時に`?? []`で扱う)。
    // 生バイト列そのものではなくPCMストアへの参照(name/hash/size)だけを持つ
    // (内容ハッシュで共有するため。実体はPCM_STORE_NAME側)。
    pcmRefs,
    // MMLソーステキスト(PMD専用、書庫内に同梱されていた`.mml`。
    // net/pmd-mml-source.js findMmlSourceEntry()参照)。対が無い曲(単体ファイル/
    // MUCOM側/mml同梱の無い書庫)はnull。voiceBankと同じくschemaVersionは
    // 据え置き(新規フィールドの追加のみ、既存レコードは読み出し時に`?? null`で扱う)。
    mmlSource: input.mmlSource ?? null,
    // 外部音色ファイル(PMD専用、`#FFFile`)。mmlSourceと同じ考え方(内容ハッシュ
    // 共有はしない、上のsaveSong()コメント参照)。対が無い曲はnull。
    ffFile: input.ffFile ?? null,
    ffFileSource: input.ffFileSource ?? null,
    ffFileMatchedHeaderName: input.ffFileMatchedHeaderName ?? null,
    contentHash,
    addedAt: existing?.addedAt ?? now,
    updatedAt: now,
  };
  await promisifyRequest(songStore.put(record));
  return { id, wasWritten: true };
}

/**
 * 曲レコード(listSongs()/library-panel.jsのonSelect()が受け取るレコードそのもの)の
 * pcmRefsを解決し、実際のPCMバイト列に戻す。playBytes()のpcmFilesへそのまま渡せる
 * 形({name, data})で返す。
 *
 * 参照先のPCMがPCMストアに見つからない場合(部分的にDBが消えた等)はその要素を
 * 黙って落とし、残りを返す(例外を投げて再生自体を止めない。無い参照を空データで
 * 埋めることもしない=describePmdPcmStatus()による「PCM不足」の案内が自然に出る
 * ようにするため)。
 * @param {IDBDatabase} db @param {{ pcmRefs?: { name: string, hash: string, size: number }[] }} record
 * @returns {Promise<{ name: string, data: Uint8Array }[]>}
 */
export async function loadPcmFilesForSong(db, record) {
  const refs = record?.pcmRefs ?? [];
  if (refs.length === 0) return [];
  const tx = db.transaction(PCM_STORE_NAME, 'readonly');
  const store = tx.objectStore(PCM_STORE_NAME);
  const results = [];
  for (const ref of refs) {
    const entry = await promisifyRequest(store.get(ref.hash));
    if (entry) results.push({ name: ref.name, data: entry.data });
    // else: 参照先が見つからない要素は落とす(黙って空データを補わない)。
  }
  return results;
}

/**
 * MMLテキストの `#<field>` 行(大文字小文字無視。MUCOM88の`#title`/PMDテキストの
 * `#Title`等どちらも拾える)から値を取り出す。html/net-load.jsの同名ヘルパーと同じ規則
 * (小さいので重複を許容し、net/をDOM非依存・html/への依存無しに保つ)。
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
 * 書庫を開いた時点で、その中の(指定ドライバの)曲を全部まとめて保存する。
 *
 * 利用者指示(2026-08-16): 以前は「実際に再生した1曲だけ」を保存していたため、
 * 一度も再生していない曲がライブラリに出てこず、「2度目以降にアルバムから曲を選ぶ」
 * という目的を果たせていなかった。書庫を開いた時点(=候補一覧が出た時点、実際に
 * どれを再生するか選ぶ前)で、その書庫内の全曲をまとめて取り込む。
 *
 * 55曲程度でもUIを固めないよう、saveSongs()で1トランザクションにまとめて書く。
 * 重複判定(computeSongId()+内容ハッシュ)はsaveSong()/saveSongs()と共通なので、
 * 同じ書庫を2回取り込んでも件数は増えない。
 *
 * DOM非依存(net/album-info.js・net/charset.jsのみに依存)なので、tools/verify_library.mjs
 * から直接検証できる。html/net-load.js側は「dbが省略されたらブラウザ既定のIndexedDBを
 * 使う」薄いラッパー(importArchiveSongsToLibrary())を持つだけにしてある。
 * @param {IDBDatabase | null} db nullなら何もせず{total, added:0, unchanged:0}を返す
 *   (IndexedDBが使えない環境向け。ui/mml-draft.jsのlocalStorage同様、保存できないだけで
 *   再生自体は継続する)。
 * @param {{ driver: 'mucom'|'pmd', kind?: 'url'|'local', url: string|null,
 *   entries: import('./archive-util.js').ArchiveEntry[], archiveLabel: string,
 *   candidates: import('./song-select.js').SongCandidate[],
 *   defaultVoiceNames?: {slot: number, nameHex: string}[] }} input defaultVoiceNamesは
 *   埋め込み既定バンクの名前表(ui/mucom-voice-table.js MUCOM_DEFAULT_VOICE_NAMES)。
 *   driver==='mucom'かつ対になるシステムディスクが実在する場合のみ使う
 *   (net/voice-bank.js findPairedVoiceBank()がバンク本体の開始オフセットを実測で
 *   特定するのに必須。呼び出し側=html/net-load.jsがimportして渡す)。
 *   `kind`省略時は従来どおり'url'(?mml=/URLから開く経由)。「ファイルから開く」/D&Dで
 *   ローカルの書庫を開いた場合は呼び出し側が`kind: 'local', url: null`を渡す
 *   (課題: ファイルから開く/D&Dの書庫対応、2026-08-16。出所がURLではない以上、
 *   originのkindを実態に合わせる。computeSongId()側もkind==='local'かつ
 *   entryPathありを書庫由来として扱うよう対応済み)。
 * @returns {Promise<{ total: number, added: number, unchanged: number }>}
 */
export async function importArchiveSongs(db, input) {
  const { driver, kind = 'url', url, entries, archiveLabel, candidates, defaultVoiceNames } = input;
  const total = candidates.length;
  if (!db) return { total, added: 0, unchanged: 0 };
  const inputs = candidates.map((c) => {
    const groupPath = albumGroupPathFor(c.entry.name);
    const trackInfo = resolveTrackInfo(entries, c.entry.name);
    // 曲名の優先順位: MMLヘッダ(#title/#Title、読み込んだ生バイト列から直接判定) >
    // trackInfo(LIST_*.txt由来) > null(呼び出し側はファイル名を表示する)。
    const title = mmlHeaderField(c.entry.data, 'title') ?? trackInfo.trackTitle ?? null;
    const composer = mmlHeaderField(c.entry.data, 'composer') ?? trackInfo.composer ?? null;
    // #voice(外部音色バンク)はMUCOM88固有の仕組み(PMDには存在しない)。driverが
    // 'pmd'の場合は対になるシステムディスクを探しにいかない(PMD側には一切影響
    // させない、という要求を型で保証する)。
    const pair = driver === 'mucom' ? findPairedVoiceBank(entries, c.entry.name, defaultVoiceNames) : null;
    // PMDのPCM(.PPC/.PZI/.PVI)はPMD固有の仕組み(MUCOM88には存在しない)。driverが
    // 'mucom'の場合は書庫内PCMを探しにいかない(MUCOM側には一切影響させない、という
    // 要求を型で保証する。上の#voice分岐と対称: driver==='pmd'でのみvoiceBankを
    // 探さないのと同じ考え方を逆方向にも適用する)。
    const pcmFiles = driver === 'pmd' ? collectPmdPcmFiles(entries, c.entry.name) : [];
    // MMLソース(PMD専用、書庫内同梱の`.mml`)。#voice/pcmFilesと同じ考え方で、
    // driverが'mucom'の場合は探しにいかない(MUCOM側には一切影響させない、という
    // 要求を型で保証する)。c.related(SongCandidate、net/song-select.js)は既に
    // 「主ファイルと同じディレクトリのエントリ集合」に絞り込み済みなので、そのまま
    // findMmlSourceEntry()へ渡せる(取り違え防止、net/pmd-mml-source.js冒頭コメント参照)。
    const mmlSource = driver === 'pmd' ? extractMmlSourceText(c.entry.name, c.related) : null;
    // 外部音色ファイル(PMD専用、`#FFFile`)。#voice/pcmFilesと同じ考え方で、driverが
    // 'mucom'の場合は探しにいかない(MUCOM側には一切影響させない)。selectFfFileForSong()は
    // 書庫全体のentries(取り違え防止のディレクトリ判定に必要、net/pmd-ff.js冒頭コメント
    // 参照)とmmlSource(`#FFFile`ヘッダの照合に必要)の両方を要求するため、上のmmlSourceを
    // 計算した後で呼ぶ。
    const ffSelection = driver === 'pmd' ? selectFfFileForSong(entries, c.entry.name, mmlSource) : null;
    return {
      driver,
      fileName: c.displayName,
      title,
      composer,
      trackNumber: trackInfo.trackNumber ?? null,
      origin: { kind, url: kind === 'url' ? url : null, archiveName: archiveLabel, groupPath, entryPath: c.entry.name },
      bytes: c.entry.data,
      voiceBank: pair ? pair.bytes : null,
      voiceBankSource: pair ? pair.sysDiskName : null,
      pcmFiles,
      mmlSource,
      ffFile: ffSelection ? ffSelection.data : null,
      ffFileSource: ffSelection ? ffSelection.name : null,
      ffFileMatchedHeaderName: ffSelection ? ffSelection.matchedHeaderName : null,
    };
  });
  const { addedCount, unchangedCount } = await saveSongs(db, inputs);
  return { total, added: addedCount, unchanged: unchangedCount };
}

/** @param {IDBDatabase} db @returns {Promise<object[]>} 保存済みの全曲(未加工) */
export async function listSongs(db) {
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const all = await promisifyRequest(store.getAll());
  return all ?? [];
}

/**
 * 曲を削除する。削除後、その曲だけが参照していたPCM(孤児)をPCMストアから回収する
 * (やらないと「削除したのに容量が減らない」ことになる。共有PCMを参照する他の曲が
 * 残っていれば、そのPCMは消さない)。
 * @param {IDBDatabase} db @param {string} id
 */
export async function deleteSong(db, id) {
  const tx = db.transaction([STORE_NAME, PCM_STORE_NAME], 'readwrite');
  const songStore = tx.objectStore(STORE_NAME);
  const pcmStore = tx.objectStore(PCM_STORE_NAME);
  const target = await promisifyRequest(songStore.get(id));
  await promisifyRequest(songStore.delete(id));
  const targetRefs = target?.pcmRefs ?? [];
  if (targetRefs.length === 0) return;
  const remaining = await promisifyRequest(songStore.getAll());
  const stillUsedHashes = new Set();
  for (const song of remaining ?? []) {
    for (const ref of song.pcmRefs ?? []) stillUsedHashes.add(ref.hash);
  }
  for (const ref of targetRefs) {
    if (!stillUsedHashes.has(ref.hash)) {
      await promisifyRequest(pcmStore.delete(ref.hash));
    }
  }
}

/** @param {IDBDatabase} db */
export async function clearAllSongs(db) {
  const tx = db.transaction([STORE_NAME, PCM_STORE_NAME], 'readwrite');
  await promisifyRequest(tx.objectStore(STORE_NAME).clear());
  await promisifyRequest(tx.objectStore(PCM_STORE_NAME).clear());
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
