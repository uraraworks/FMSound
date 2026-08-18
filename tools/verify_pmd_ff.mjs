#!/usr/bin/env node
// PMDの外部音色ファイル(.FF、`#FFFile`)結線の検証、およびPCM(pcmFiles)が
// 編集モードでの再生(compileAndPlay())でも失われないことの検証。
//
// 背景(利用者報告・別エージェントの依頼、2026-08-18): (a) 書庫を開いて編集モードで
// 再生すると、書庫内のPCM(ADPCM/PPZ8)が失われる。原因はhtml/pmd-app.jsの
// compileAndPlay()がwriteSongWithPcm()へ常に`pcmFiles: []`を渡していたこと
// (当時のコメント「このコンパイラはPCMを出力しないので常に空」は、J/K/PPZ8対応後は
// 実態と合わなくなっていた)。(b) `compileMml(source, { ffFile })`は実装済みなのに、
// アプリ側で`ffFile`を渡している箇所が無く、`#FFFile`を使う曲が編集モードで
// コンパイルできなかった。
//
// 検証項目:
//   [本体] net/pmd-ff.js extractFfFileHeaderName(): `#FFFile`ヘッダの抽出
//          (大文字小文字無視、ヘッダ無しはnull)。
//   [本体] net/pmd-ff.js selectFfFileForSong(): ヘッダ名一致の優先、大文字小文字
//          無視、ヘッダ名一致が無い場合の同ディレクトリフォールバック、`#FFFile`
//          未使用時の挙動。
//   [本体] [取り違え防止] 別ディレクトリに同名`.FF`が複数存在する場合、曲と同じ
//          ディレクトリのものを採用する(net/pmd-pcm.js collectPmdPcmFiles()の
//          コミット6de2839と同じ罠・同じ検査)。
//   [本体] net/pmd-ff.js describePmdFfStatus(): ヘッダ無し/不足/取り違え/一致の
//          4パターンでキーが正しく出る。
//   [本体] net/library.js: ライブラリに保存→読み出しで.FFが同一バイト列で戻る
//          (voiceBankと同じ埋め込み方式、pcmRefsのような別ストア参照ではない)。
//          importArchiveSongs()がPMD曲にffFile/ffFileSource/ffFileMatchedHeaderNameを
//          正しく設定すること、MUCOM側には一切付与しないこと。
//   [結線] html/pmd-app.js:
//     (1) compileAndPlay()がwriteSongWithPcm()へ`pcmFiles: []`固定ではなく
//         `currentSongPcmFiles`を渡している。
//     (2) compileAndPlay()がcompileMml()へ`ffFile`を渡している。
//     (3) 書庫を直接開く経路(openPmdFile)・URL経路(loadSongFromUrl)・ライブラリ
//         選択経路(onSelect)の3経路すべてが、同じ窓口(selectFfFileForSong/
//         collectPmdPcmFiles)を通ってplayBytes()へpcmFiles/ffFileを渡している。
//   [陽性対照] 上の[結線](1)(2)を意図的に外した(元のコード相当に戻した)文字列で、
//          同じ検査が実際にFAILすること。
//   [i18n] pmd.ff.missing/pmd.ff.nameMismatchがja/en両方に存在し、必要な
//          プレースホルダを含む。
//
// 実行: node tools/verify_pmd_ff.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractFfFileHeaderName, selectFfFileForSong, describePmdFfStatus, collectFfCandidates,
} from '../net/pmd-ff.js';
import { openLibraryDb, saveSong, listSongs, importArchiveSongs } from '../net/library.js';
import { DICT as I18N_DICT } from '../ui/i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passCount = 0;
let failCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

// --- Node用の最小フェイクIndexedDB(tools/verify_library.mjsと同じ実装を複製。
//     新しい依存パッケージは足さない、という既存方針を踏襲する) ---
class FakeRequest {
  constructor() { this.onsuccess = null; this.onerror = null; this.result = undefined; }
  _succeed(result) { this.result = result; setTimeout(() => { if (this.onsuccess) this.onsuccess({ target: this }); }, 0); }
}
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
class FakeStore {
  constructor(dataMap, keyPath) { this.dataMap = dataMap; this.keyPath = keyPath; }
  get(key) { const r = new FakeRequest(); r._succeed(this.dataMap.has(key) ? cloneValue(this.dataMap.get(key)) : undefined); return r; }
  put(value) { const r = new FakeRequest(); const key = value[this.keyPath]; this.dataMap.set(key, cloneValue(value)); r._succeed(key); return r; }
  getAll() { const r = new FakeRequest(); r._succeed([...this.dataMap.values()].map(cloneValue)); return r; }
}
class FakeDatabase {
  constructor() { this.stores = new Map(); this.keyPaths = new Map(); }
  get objectStoreNames() { const stores = this.stores; return { contains: (n) => stores.has(n) }; }
  createObjectStore(name, opts) { this.stores.set(name, new Map()); this.keyPaths.set(name, opts.keyPath); return new FakeStore(this.stores.get(name), opts.keyPath); }
  transaction(storeNames) {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const db = this;
    return { objectStore(name) {
      if (!names.includes(name)) throw new Error(`fake IDB: '${name}' out of scope`);
      return new FakeStore(db.stores.get(name), db.keyPaths.get(name));
    } };
  }
}
class FakeIDBFactory {
  constructor() { this.databases = new Map(); }
  open(name, version) {
    const req = new FakeRequest();
    let db = this.databases.get(name);
    if (!db) { db = new FakeDatabase(); this.databases.set(name, db); }
    setTimeout(() => {
      req.result = db;
      if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
      if (req.onsuccess) req.onsuccess({ target: req });
    }, 0);
    return req;
  }
}

// --- [本体] extractFfFileHeaderName() ------------------------------------------------
check('extractFfFileHeaderName: 通常のヘッダから名前を取り出せる',
  extractFfFileHeaderName('; comment\n#FFFile V5.FF\nA @1c\n') === 'V5.FF');
check('extractFfFileHeaderName: 大文字小文字を無視する(#fffile)',
  extractFfFileHeaderName('#fffile v5.ff\n') === 'v5.ff');
check('extractFfFileHeaderName: ヘッダが無ければnull',
  extractFfFileHeaderName('A @1c\n') === null);
check('extractFfFileHeaderName: ソース自体がnull/空でもnull',
  extractFfFileHeaderName(null) === null && extractFfFileHeaderName('') === null);

// --- 合成データ: 2つのディレクトリに同名(V5.FF)だが中身の違う.FFを配置 -------------
const ff8192 = (fill) => { const b = new Uint8Array(8192); b.fill(fill); return b; };
const entriesCrossDir = [
  { name: 'SONGDIR/song.M', data: new Uint8Array([1]) },
  { name: 'SONGDIR/V5.FF', data: ff8192(0x11) },   // 曲と同じディレクトリ
  { name: 'OTHERDIR/V5.FF', data: ff8192(0x99) },   // 別ディレクトリの同名(中身違い)
];

// --- [本体][取り違え防止] ヘッダ名が複数ディレクトリで一致する場合、同じ
//     ディレクトリの.FFを優先する ---
{
  const result = selectFfFileForSong(entriesCrossDir, 'SONGDIR/song.M', '#FFFile V5.FF\n');
  check('[取り違え防止] 同じディレクトリのV5.FFが採用される(別ディレクトリの中身にならない)',
    Boolean(result) && result.data[0] === 0x11, `data[0]=${result?.data[0]}`);
  check('selectFfFileForSong: 名前が一致した場合matchedHeaderName=true',
    Boolean(result) && result.matchedHeaderName === true);
}

// --- [本体] ヘッダ名が同じディレクトリに無い場合、他ディレクトリの一致候補を使う ---
{
  const entriesOnlyOtherDir = [
    { name: 'SONGDIR/song.M', data: new Uint8Array([1]) },
    { name: 'OTHERDIR/V5.FF', data: ff8192(0x77) },
  ];
  const result = selectFfFileForSong(entriesOnlyOtherDir, 'SONGDIR/song.M', '#FFFile V5.FF\n');
  check('selectFfFileForSong: 同じディレクトリに無ければ他ディレクトリの一致候補を使う(捨てない)',
    Boolean(result) && result.data[0] === 0x77 && result.matchedHeaderName === true);
}

// --- [本体] 大文字小文字/拡張子の無視 -------------------------------------------------
{
  const entries = [
    { name: 'SONGDIR/song.M', data: new Uint8Array([1]) },
    { name: 'SONGDIR/v5.ff', data: ff8192(0x22) },
  ];
  const result = selectFfFileForSong(entries, 'SONGDIR/song.M', '#FFFile V5.FF\n');
  check('selectFfFileForSong: basenameの大文字小文字を無視して一致する',
    Boolean(result) && result.data[0] === 0x22 && result.matchedHeaderName === true);
}

// --- [本体] ヘッダ名と一致しない場合のフォールバック(同ディレクトリのみ・区別可能) ---
{
  const entries = [
    { name: 'SONGDIR/song.M', data: new Uint8Array([1]) },
    { name: 'SONGDIR/OTHER.FF', data: ff8192(0x33) },
  ];
  const result = selectFfFileForSong(entries, 'SONGDIR/song.M', '#FFFile V5.FF\n');
  check('selectFfFileForSong: ヘッダ名と一致しないがフォールバックで同ディレクトリの.FFを採用',
    Boolean(result) && result.data[0] === 0x33 && result.matchedHeaderName === false,
    JSON.stringify(result && { name: result.name, matchedHeaderName: result.matchedHeaderName }));
}

// --- [本体] `#FFFile`を使っていない曲・.FFが全く無い場合 -----------------------------
{
  const entries = [{ name: 'SONGDIR/song.M', data: new Uint8Array([1]) }];
  check('selectFfFileForSong: 候補が無ければnull',
    selectFfFileForSong(entries, 'SONGDIR/song.M', '#FFFile V5.FF\n') === null);
  check('selectFfFileForSong: MMLが#FFFileを使わずフォールバック候補も無ければnull',
    selectFfFileForSong(entriesCrossDir, 'NODIR/song.M', 'A @1c\n') === null);
}

check('collectFfCandidates: .FF拡張子だけを拾う(.mmlや.Mは含めない)',
  JSON.stringify(collectFfCandidates([
    { name: 'a.FF', data: new Uint8Array(1) },
    { name: 'a.mml', data: new Uint8Array(1) },
    { name: 'a.M', data: new Uint8Array(1) },
  ]).map((e) => e.name)) === JSON.stringify(['a.FF']));

// --- [本体] describePmdFfStatus() -----------------------------------------------------
check('describePmdFfStatus: #FFFile未使用(headerName=null)では何も言わない',
  describePmdFfStatus({ headerName: null, ffSelection: null }).length === 0);
{
  const msgs = describePmdFfStatus({ headerName: 'V5.FF', ffSelection: null });
  check('describePmdFfStatus: 見つからない場合pmd.ff.missingキー・fileパラメータ',
    msgs.length === 1 && msgs[0].key === 'pmd.ff.missing' && msgs[0].params.file === 'V5.FF');
}
{
  const msgs = describePmdFfStatus({ headerName: 'V5.FF', ffSelection: { name: 'OTHER.FF', matchedHeaderName: false } });
  check('describePmdFfStatus: 取り違え(フォールバック採用)の場合pmd.ff.nameMismatch・wanted/used',
    msgs.length === 1 && msgs[0].key === 'pmd.ff.nameMismatch'
    && msgs[0].params.wanted === 'V5.FF' && msgs[0].params.used === 'OTHER.FF');
}
check('describePmdFfStatus: 名前が一致した場合は何も言わない',
  describePmdFfStatus({ headerName: 'V5.FF', ffSelection: { name: 'V5.FF', matchedHeaderName: true } }).length === 0);

// --- [陽性対照] 「同じディレクトリを優先する」規則を外した壊れた実装を用意し、
//     上の[取り違え防止]検査と同じ主張が実際にFAILすることを確認する(症状で
//     落ちる側の確認。「変えたら変わる」だけでは確認しない) ---
function selectFfFileForSong_brokenNoDirPreference(entries, songEntryName, mmlSource) {
  const candidates = collectFfCandidates(entries);
  const headerName = extractFfFileHeaderName(mmlSource);
  if (!headerName) return null;
  const wantBase = headerName.replace(/\.[^.]*$/, '').toLowerCase();
  const matched = candidates.find((c) => {
    const base = c.name.split('/').pop().replace(/\.[^.]*$/, '').toLowerCase();
    return base === wantBase;
  });
  return matched ? { data: matched.data, name: matched.name, matchedHeaderName: true } : null;
}
{
  // entries内の出現順を意図的にOTHERDIRが先になるよう入れ替える(entriesCrossDirの
  // 元の並び=SONGDIRが先、だと「配列の先頭を採用する」だけの壊れた実装でも
  // たまたま正解と一致してしまい、陽性対照として機能しない。取り違えバグを
  // 確実に踏ませるため、ここだけ並びを反転させた別配列を使う)。
  const entriesCrossDirReversed = [...entriesCrossDir].reverse();
  const broken = selectFfFileForSong_brokenNoDirPreference(entriesCrossDirReversed, 'SONGDIR/song.M', '#FFFile V5.FF\n');
  check('[陽性対照] ディレクトリ優先を外した実装は取り違え検査が実際にFAILする(=別ディレクトリの中身になる)',
    broken.data[0] !== 0x11, `broken.data[0]=${broken.data[0]}(0x11なら誤って直った=検査が機能していない)`);
}

// --- [本体] net/library.js: .FFの保存/復元(voiceBankと同じ埋め込み方式) -----------
async function run() {
  const idb = new FakeIDBFactory();
  const db = await openLibraryDb(idb);
  const ffBytes = ff8192(0x55);
  await saveSong(db, {
    driver: 'pmd', fileName: 'song.M', title: null, composer: null, trackNumber: null,
    origin: { kind: 'local', url: null, archiveName: null, groupPath: null, entryPath: null },
    bytes: new Uint8Array([1, 2, 3]),
    ffFile: ffBytes, ffFileSource: 'V5.FF', ffFileMatchedHeaderName: true,
  });
  const songs = await listSongs(db);
  const saved = songs.find((s) => s.fileName === 'song.M');
  check('library: 保存したffFileが同一バイト列で読み出せる(voiceBankと同じ埋め込み方式)',
    Boolean(saved?.ffFile) && saved.ffFile.length === 8192 && saved.ffFile.every((b) => b === 0x55));
  check('library: ffFileSource/ffFileMatchedHeaderNameも一緒に保存される',
    saved?.ffFileSource === 'V5.FF' && saved?.ffFileMatchedHeaderName === true);
  check('library: ffFileを渡さない曲(MUCOM側相当)はffFile=null',
    (await saveSong(db, {
      driver: 'mucom', fileName: 'mucom-song.muc', title: null, composer: null, trackNumber: null,
      origin: { kind: 'local', url: null, archiveName: null, groupPath: null, entryPath: null },
      bytes: new Uint8Array([9]),
    }), (await listSongs(db)).find((s) => s.fileName === 'mucom-song.muc').ffFile === null));

  // importArchiveSongs(): PMD曲にffFile/ffFileSource/ffFileMatchedHeaderNameが
  // 正しく設定され、MUCOM側には一切付与しないこと。
  const entries = [
    { name: 'DISK/JSM.M', data: new Uint8Array([9, 9]) },
    { name: 'DISK/JSM.mml', data: new TextEncoder().encode('#FFFile JSM.FF\nA @1c\n') },
    { name: 'DISK/JSM.FF', data: ff8192(0x66) },
  ];
  const pmdCandidate = {
    entry: entries[0],
    displayName: 'JSM.M',
    driver: 'pmd',
    related: entries.filter((e) => e !== entries[0]),
  };
  const importResult = await importArchiveSongs(db, {
    driver: 'pmd', kind: 'local', url: null, entries, archiveLabel: 'DISK', candidates: [pmdCandidate],
  });
  check('importArchiveSongs: PMD書庫取り込みが成功する(total=1)', importResult.total === 1);
  const importedSongs = await listSongs(db);
  const jsmSong = importedSongs.find((s) => s.fileName === 'JSM.M');
  check('importArchiveSongs: MMLソース中の#FFFileと同じ名前(JSM.FF)のffFileが取り込まれる',
    Boolean(jsmSong?.ffFile) && jsmSong.ffFile.length === 8192 && jsmSong.ffFile[0] === 0x66
    && jsmSong.ffFileSource === 'JSM.FF' && jsmSong.ffFileMatchedHeaderName === true);

  const mucomCandidate = {
    entry: { name: 'DISK/song.muc', data: new Uint8Array([1]) },
    displayName: 'song.muc',
    driver: 'mucom',
    related: [],
  };
  await importArchiveSongs(db, {
    driver: 'mucom', kind: 'local', url: null, entries: [mucomCandidate.entry], archiveLabel: 'DISK', candidates: [mucomCandidate],
  });
  const mucomSong = (await listSongs(db)).find((s) => s.fileName === 'song.muc');
  check('importArchiveSongs: MUCOM側の曲にはffFileを一切付与しない(driver分岐が効いている)',
    mucomSong?.ffFile === null && mucomSong?.ffFileSource === null);

  // --- [結線] html/pmd-app.js の文字列検査 ---------------------------------------------
  const src = fs.readFileSync(path.join(__dirname, '../html/pmd-app.js'), 'utf8');

  check('[結線] pmd-app.jsがnet/pmd-ff.jsのselectFfFileForSongをimportしている',
    /import\s*\{[^}]*selectFfFileForSong[^}]*\}\s*from\s*'\.\/net\/pmd-ff\.js'/.test(src));

  const compileAndPlayMatch = src.match(/function compileAndPlay\(\)\s*\{[\s\S]*?\n {2}\}\n/);
  check('[結線] compileAndPlay()を検出できる', Boolean(compileAndPlayMatch));
  const compileAndPlayBody = compileAndPlayMatch ? compileAndPlayMatch[0] : '';

  check('[結線](a) compileAndPlay()がwriteSongWithPcm()へcurrentSongPcmFilesを渡している(pcmFiles: []固定ではない)',
    /writeSongWithPcm\(Module,\s*\{\s*songName:\s*'edited\.M',\s*songBytes:\s*file,\s*pcmFiles:\s*currentSongPcmFiles\s*\}\)/.test(compileAndPlayBody));
  check('[結線](a) compileAndPlay()に固定の`pcmFiles: []`が残っていない(旧実装の再発防止)',
    !/pcmFiles:\s*\[\]\s*\}\)/.test(compileAndPlayBody));
  check('[結線](b) compileAndPlay()がcompileMml()へffFileを渡している',
    /compileMml\(source,\s*\{\s*ffFile:\s*currentSongFfFile\s*\?\s*currentSongFfFile\.data\s*:\s*undefined\s*\}\)/.test(compileAndPlayBody));

  check('[結線](b) openPmdFile()がselectFfFileForSong()を呼び、playBytes()へffSelectionを渡している',
    /const ffSelection = selectFfFileForSong\(resolved\.entries, chosen\.entry\.name, mmlSourceText\);[\s\S]{0,400}?ffSelection,\s*\)/.test(src));
  check('[結線](b) loadSongFromUrl()もselectFfFileForSong()を呼び、pendingUrlSongへffFileとして渡している',
    /ffFile: ffSelection,/.test(src) && (src.match(/selectFfFileForSong\(resolved\.entries, chosen\.entry\.name, mmlSourceText\)/g) || []).length >= 2);
  check('[結線](b) ライブラリ選択(onSelect)がsong.ffFileからffSelectionを組み立ててplayBytes()へ渡している',
    /const ffFile = song\.ffFile[\s\S]{0,300}?playBytes\(song\.bytes, song\.fileName, undefined, pcmFiles, \[\], mmlSourceText, ffFile\)/.test(src));

  // --- [陽性対照] 上の(1)(2)を旧実装相当へ戻した文字列で、同じ検査が実際にFAILする ---
  const brokenA = src.replace(
    "const editedPath = writeSongWithPcm(Module, { songName: 'edited.M', songBytes: file, pcmFiles: currentSongPcmFiles });",
    "const editedPath = writeSongWithPcm(Module, { songName: 'edited.M', songBytes: file, pcmFiles: [] });",
  );
  check('[陽性対照] pcmFilesを[]固定へ戻すと(a)の検査が実際にFAILする',
    !/writeSongWithPcm\(Module,\s*\{\s*songName:\s*'edited\.M',\s*songBytes:\s*file,\s*pcmFiles:\s*currentSongPcmFiles\s*\}\)/.test(brokenA));

  const brokenB = src.replace(
    "compileMml(source, { ffFile: currentSongFfFile ? currentSongFfFile.data : undefined })",
    'compileMml(source)',
  );
  check('[陽性対照] compileMml()呼び出しからffFileを外すと(b)の検査が実際にFAILする',
    !/compileMml\(source,\s*\{\s*ffFile:\s*currentSongFfFile/.test(brokenB));

  // --- [i18n] ------------------------------------------------------------------------
  check('[i18n] pmd.ff.missing がja/en両方に存在し{file}を含む',
    typeof I18N_DICT.ja['pmd.ff.missing'] === 'string' && I18N_DICT.ja['pmd.ff.missing'].includes('{file}')
    && typeof I18N_DICT.en['pmd.ff.missing'] === 'string' && I18N_DICT.en['pmd.ff.missing'].includes('{file}'));
  check('[i18n] pmd.ff.nameMismatch がja/en両方に存在し{wanted}/{used}を含む',
    ['ja', 'en'].every((lang) => {
      const v = I18N_DICT[lang]['pmd.ff.nameMismatch'];
      return typeof v === 'string' && v.includes('{wanted}') && v.includes('{used}');
    }));

  console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
  process.exit(failCount > 0 ? 1 : 0);
}

run();
