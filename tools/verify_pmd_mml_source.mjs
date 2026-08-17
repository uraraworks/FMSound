#!/usr/bin/env node
// MMLソース連動(net/pmd-mml-source.js・net/library.js mmlSource・
// html/pmd-app.js結線)の検証。実データは使わない(合成データで足りる)。
//
// 背景(利用者報告、2026-08-18): 「SS_TENGを聞いていたのに、編集ボタンを押したら
// エリーゼになっている」。原因は(a)編集ONで再生を止める設計自体は意図通りだが、
// (b)編集欄には前に入っていた別の曲の内容が残ること。実際には書庫内に曲と
// 同じディレクトリで`.mml`が同梱されている実物があるため、それを拾って編集欄へ
// 反映すれば「聞いていた曲のMML」が編集欄に入るようになる。この検証はその仕組み
// (net/pmd-mml-source.js findMmlSourceEntry()/extractMmlSourceText())と、
// ライブラリ保存(net/library.js mmlSource)・UI結線(html/pmd-app.js)を確認する。
//
// 検証項目:
//   [本体]     同じディレクトリにSONG.MとSONG.MMLがある合成書庫でMMLソースが
//              正しく対応付けられる(別フォルダの同名.mmlを誤って拾わない)。
//   [本体]     拡張子の大文字小文字(.mml/.MML)どちらでも拾える。
//   [本体]     CP932の.mmlが文字化けせずデコードされる(日本語コメント込み)。
//   [本体]     .mmlが無い場合は「ソース無し」と判定される。
//   [本体]     ライブラリに保存→読み出しでMMLソースが同一の文字列で戻る。
//   [陽性対照] 対応付けを壊した状態(basename照合をやめて最初の.mmlを拾う)で、
//              「正しく対応付けられる」検査が実際にFAILすること(取り違えという
//              症状で落ちる側を確認する。「変えたら変わる」だけでは確認しない)。
//   [結線]     html/pmd-app.jsが(a)曲読み込み時にMMLソース抽出を呼んでいること、
//              (b)編集ボタンでソース無しのときモードを切り替えずメッセージを
//              出していること、(c)ライブラリ選択経路でもMMLソースを反映して
//              いることを文字列検査する。
//
// 実行: node tools/verify_pmd_mml_source.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMmlSourceEntry, extractMmlSourceText } from '../net/pmd-mml-source.js';
import { openLibraryDb, saveSong, listSongs, importArchiveSongs } from '../net/library.js';
import { findSongCandidates } from '../net/song-select.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passCount = 0;
let failCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

// --- Node用の最小フェイクIndexedDB(tools/verify_library.mjsと同じ最小実装。
//     新しい依存パッケージは足さない、という既存方針を踏襲する) ---
class FakeRequest {
  constructor() { this.onsuccess = null; this.onerror = null; this.result = undefined; }
}
class FakeStore {
  constructor() { this.data = new Map(); }
  get(key) { const r = new FakeRequest(); setTimeout(() => { r.result = this.data.get(key); if (r.onsuccess) r.onsuccess({ target: r }); }, 0); return r; }
  getAll() { const r = new FakeRequest(); setTimeout(() => { r.result = [...this.data.values()]; if (r.onsuccess) r.onsuccess({ target: r }); }, 0); return r; }
  put(value) { const r = new FakeRequest(); const key = this.keyPath === 'hash' ? value.hash : value.id; setTimeout(() => { this.data.set(key, value); r.result = key; if (r.onsuccess) r.onsuccess({ target: r }); }, 0); return r; }
  delete(key) { const r = new FakeRequest(); setTimeout(() => { this.data.delete(key); if (r.onsuccess) r.onsuccess({ target: r }); }, 0); return r; }
  clear() { const r = new FakeRequest(); setTimeout(() => { this.data.clear(); if (r.onsuccess) r.onsuccess({ target: r }); }, 0); return r; }
}
class FakeTx {
  constructor(stores) { this.stores = stores; }
  objectStore(name) { return this.stores[name]; }
}
class FakeDatabase {
  constructor() {
    this.version = 0;
    this.stores = {};
  }
  get objectStoreNames() {
    const names = Object.keys(this.stores);
    return { contains: (n) => names.includes(n) };
  }
  createObjectStore(name, opts) {
    const store = new FakeStore();
    store.keyPath = opts?.keyPath;
    this.stores[name] = store;
    return store;
  }
  transaction(names, _mode) {
    return new FakeTx(this.stores);
  }
}
class FakeIDBFactory {
  constructor() { this.databases = new Map(); }
  open(name, version) {
    const req = new FakeRequest();
    const requestedVersion = version ?? 1;
    let db = this.databases.get(name);
    if (!db) { db = new FakeDatabase(); this.databases.set(name, db); }
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

// --- 合成データの組み立て --------------------------------------------------------------

function utf8(text) { return new TextEncoder().encode(text); }

// CP932 "コメント"(こめんと)のバイト列を手組みする(依存を増やさず、
// 少数の既知の全角文字だけを対応表として持つ最小実装。tools/内の他の検証にも
// 同種の最小手組みCP932エンコーダの前例が無いため、ここでは実測済みの固定バイト列
// (Shift_JISのコード表から拾った値)をそのまま使う)。
const CP932_COMMENT_BYTES = Uint8Array.from([
  0x83, 0x52, // コ
  0x83, 0x81, // メ
  0x83, 0x93, // ン
  0x83, 0x67, // ト
]);

function buildCp932MmlBytes() {
  const prefix = utf8('; ');
  const suffix = utf8('\nA t120 o5 l4 v10 cdefg\n');
  const buf = new Uint8Array(prefix.length + CP932_COMMENT_BYTES.length + suffix.length);
  buf.set(prefix, 0);
  buf.set(CP932_COMMENT_BYTES, prefix.length);
  buf.set(suffix, prefix.length + CP932_COMMENT_BYTES.length);
  return buf;
}

// --- [本体] 同じディレクトリのSONG.M/SONG.MML対応付け(取り違え防止込み) --------------

function testBasenameMatch() {
  const entries = [
    { name: 'ALBUM/SONG.M', data: utf8('binary-song-data') },
    // 罠: 別ディレクトリに同じベース名の.mmlがある(collectPmdPcmFiles()の同名PCM
    // 取り違え不具合、コミット6de2839と同じ形)。しかも配列内の出現順は正しい方
    // (ALBUM/SONG.MML)より前に置く: 「先頭を無条件採用する」壊れた実装が
    // 誤ってこちらを拾うことを保証するため(出現順が偶然正しい側に有利だと
    // 陽性対照が機能しない)。
    { name: 'OTHER/SONG.MML', data: utf8('A t60 zzzz ; wrong directory') },
    { name: 'ALBUM/SONG.MML', data: utf8('A t120 cdefg ; correct') },
  ];
  const candidates = findSongCandidates(entries);
  // findSongCandidates()自体は拡張子.mだけをPMD候補として拾う(net/song-select.js
  // EXTENSION_DRIVER_TABLE)。'.M'は大文字だが判定は小文字化して行うため一致する。
  const songCandidate = candidates.find((c) => c.entry.name === 'ALBUM/SONG.M');
  check('findSongCandidates(): 合成データからALBUM/SONG.Mが曲候補として見つかる', Boolean(songCandidate));
  if (!songCandidate) return;

  check(
    'SongCandidate.relatedにはALBUM配下のSONG.MMLだけが入る(OTHER配下は含まない)',
    songCandidate.related.length === 1 && songCandidate.related[0].name === 'ALBUM/SONG.MML',
    JSON.stringify(songCandidate.related.map((e) => e.name)),
  );

  const found = findMmlSourceEntry(songCandidate.entry.name, songCandidate.related);
  check(
    '[本体] findMmlSourceEntry(): 主ファイルと同じディレクトリのSONG.MMLを正しく対応付ける',
    Boolean(found) && found.name === 'ALBUM/SONG.MML',
    JSON.stringify(found),
  );
  const text = extractMmlSourceText(songCandidate.entry.name, songCandidate.related);
  check(
    '[本体] extractMmlSourceText(): 対応付いたMMLの中身(正しい方)が返る(誤ったOTHER側ではない)',
    text === 'A t120 cdefg ; correct',
    JSON.stringify(text),
  );

  // [陽性対照] 対応付けを壊した実装(basename照合をやめて集合内で最初に見つかった
  // .mmlをそのまま採用する)を用意し、この合成データ(relatedを渡さず全entriesを
  // 渡す=ディレクトリを跨いだ探索を強制する)で「取り違え」という症状として
  // 実際にFAILすることを確認する。「変えたら値が変わる」だけでなく、正しい実装なら
  // 通るはずの主張(=対応付けが正しい)がPASSしないことまで確認する。
  function brokenFindFirstMml(relatedEntries) {
    for (const entry of relatedEntries) {
      if (/\.mml$/i.test(entry.name)) return entry;
    }
    return null;
  }
  // 壊れた実装をディレクトリを跨いだ全entries(OTHERも含む)へ適用する。
  // (この呼び出し方自体が「related=ディレクトリ絞り込み済み集合を渡す」という
  // 契約を破っている状態を模している。壊れた実装がこの契約破りに気づかず、
  // 集合の先頭を無条件に採用することで取り違えが起きる。)
  const brokenFound = brokenFindFirstMml(entries);
  const brokenIsCorrect = Boolean(brokenFound) && brokenFound.name === 'ALBUM/SONG.MML';
  check(
    '[陽性対照] 対応付けを壊した実装(先頭.mmlを無条件採用)は、entries全体を渡すと取り違えて誤ったOTHER側を拾う(=このFAILが検査の有効性を示す)',
    brokenIsCorrect === false,
    `壊れた実装の結果: ${JSON.stringify(brokenFound)}`,
  );
}

// --- [本体] 拡張子の大文字小文字 --------------------------------------------------------

function testExtensionCase() {
  for (const ext of ['.mml', '.MML', '.Mml']) {
    const entries = [
      { name: `DIR/TRACK${ext}`, data: utf8('A t100 cde') },
    ];
    const found = findMmlSourceEntry('DIR/TRACK.M', entries);
    check(`[本体] 拡張子${ext}のMMLソースを大文字小文字無視で拾える`, Boolean(found) && found.name === `DIR/TRACK${ext}`);
  }
}

// --- [本体] CP932デコード ---------------------------------------------------------------

function testCp932Decode() {
  const entries = [{ name: 'DIR/TRACK.mml', data: buildCp932MmlBytes() }];
  const text = extractMmlSourceText('DIR/TRACK.M', entries);
  check(
    '[本体] CP932の.mmlが文字化けせず「コメント」を含む文字列としてデコードされる',
    typeof text === 'string' && text.includes('コメント'),
    JSON.stringify(text),
  );
}

// --- [本体] .mmlが無い場合 ---------------------------------------------------------------

function testNoMmlSource() {
  const entries = [{ name: 'DIR/OTHER.txt', data: utf8('not an mml file') }];
  const found = findMmlSourceEntry('DIR/TRACK.M', entries);
  check('[本体] .mmlが無い場合はnull(ソース無し)と判定される', found === null);
  const text = extractMmlSourceText('DIR/TRACK.M', entries);
  check('[本体] extractMmlSourceText()も同様にnullを返す', text === null);
  const emptyRelated = findMmlSourceEntry('DIR/TRACK.M', []);
  check('[本体] relatedが空配列でも例外を投げずnullを返す', emptyRelated === null);
}

// --- [本体] ライブラリ保存→読み出し ------------------------------------------------------

async function testLibraryRoundTrip() {
  const fakeIdb = new FakeIDBFactory();
  const db = await openLibraryDb(fakeIdb);
  check('openLibraryDb(): フェイクIndexedDBからDBを取得できる', db !== null);
  if (!db) return;

  const mmlText = 'A t120 o5 l4 v10 cdefg ; roundtrip';
  await saveSong(db, {
    driver: 'pmd', fileName: 'roundtrip.M', title: null, composer: null, trackNumber: null,
    origin: { kind: 'local', url: null, archiveName: null, groupPath: null, entryPath: null },
    bytes: utf8('binary-song-data'),
    mmlSource: mmlText,
  });
  const songs = await listSongs(db);
  const saved = songs.find((s) => s.fileName === 'roundtrip.M');
  check(
    '[本体] ライブラリに保存したmmlSourceが同一の文字列で読み出せる',
    Boolean(saved) && saved.mmlSource === mmlText,
    JSON.stringify(saved?.mmlSource),
  );

  // mmlSourceを渡さない曲(MUCOM側の呼び出し等)はnullのままで、他フィールドに影響しない。
  await saveSong(db, {
    driver: 'mucom', fileName: 'no-mml.muc', title: null, composer: null, trackNumber: null,
    origin: { kind: 'local', url: null, archiveName: null, groupPath: null, entryPath: null },
    bytes: utf8('mucom-song'),
  });
  const songs2 = await listSongs(db);
  const savedNoMml = songs2.find((s) => s.fileName === 'no-mml.muc');
  check('[本体] mmlSourceを渡さない保存(MUCOM側)はmmlSource=nullのまま', Boolean(savedNoMml) && savedNoMml.mmlSource === null);

  // importArchiveSongs(): driver==='pmd'のときだけMMLソースを拾い、'mucom'では拾わない
  // (利用者指示の厳密さ、net/library.js importArchiveSongs()のコメント参照)。
  const archiveEntries = [
    { name: 'AL/TRACK.M', data: utf8('binary') },
    { name: 'AL/TRACK.mml', data: utf8('A t100 cde ; from archive') },
  ];
  const pmdCandidates = findSongCandidates(archiveEntries).filter((c) => c.driver === 'pmd');
  const importResultPmd = await importArchiveSongs(db, {
    driver: 'pmd', kind: 'local', url: null, entries: archiveEntries, archiveLabel: 'AL.zip', candidates: pmdCandidates,
  });
  check('[本体] importArchiveSongs(driver=pmd): 書庫内の曲が取り込まれる', importResultPmd.added === 1, JSON.stringify(importResultPmd));
  const songs3 = await listSongs(db);
  const savedFromArchive = songs3.find((s) => s.fileName === 'TRACK.M');
  check(
    '[本体] importArchiveSongs(driver=pmd): 書庫内同梱の.mmlがmmlSourceとして保存される',
    Boolean(savedFromArchive) && savedFromArchive.mmlSource === 'A t100 cde ; from archive',
    JSON.stringify(savedFromArchive?.mmlSource),
  );

  // MUCOM88側の候補は無いはず(archiveEntriesに.mucが無い)なので、代わりに
  // 「driver==='mucom'ならmmlSourceを探しにいかない」ことを、探索対象の.mucを
  // 混ぜた合成データで直接確認する。
  const mixedEntries = [
    { name: 'MC/SONG.muc', data: utf8('#mucom88\nA t100 cde') },
    { name: 'MC/SONG.mml', data: utf8('would-be-picked-up-if-mucom-searched-for-it') },
  ];
  const mucomCandidates = findSongCandidates(mixedEntries).filter((c) => c.driver === 'mucom');
  check('合成データ: MUCOM候補が1件見つかる(前提の確認)', mucomCandidates.length === 1, JSON.stringify(mucomCandidates.map((c) => c.entry.name)));
  const importResultMucom = await importArchiveSongs(db, {
    driver: 'mucom', kind: 'local', url: null, entries: mixedEntries, archiveLabel: 'MC.zip', candidates: mucomCandidates,
  });
  check('importArchiveSongs(driver=mucom): 曲が取り込まれる(前提の確認)', importResultMucom.added === 1);
  const songs4 = await listSongs(db);
  const savedMucom = songs4.find((s) => s.fileName === 'SONG.muc');
  check(
    '[本体] importArchiveSongs(driver=mucom): MUCOM側はmmlSourceを探しにいかず常にnull(PMD専用の分岐が正しく効いている)',
    Boolean(savedMucom) && savedMucom.mmlSource === null,
    JSON.stringify(savedMucom?.mmlSource),
  );
}

// --- [結線] html/pmd-app.js の文字列検査 -------------------------------------------------

function testWiring() {
  const src = fs.readFileSync(path.join(__dirname, '../html/pmd-app.js'), 'utf8');

  check(
    '[結線] pmd-app.jsがnet/pmd-mml-source.jsのextractMmlSourceTextをimportしている',
    /import\s*\{[^}]*extractMmlSourceText[^}]*\}\s*from\s*'\.\/net\/pmd-mml-source\.js'/.test(src),
  );

  // (a) 曲読み込み時にMMLソース抽出を呼んでいること(書庫を直接開く経路・URL経路)。
  const extractCalls = src.match(/extractMmlSourceText\(/g) || [];
  check(
    '[結線] (a) 曲読み込み経路でextractMmlSourceText()を呼んでいる箇所が複数ある(書庫を直接開く経路・URL経路)',
    extractCalls.length >= 2,
    `検出数=${extractCalls.length}`,
  );

  // (b) 編集ボタンでソース無しのときモードを切り替えずメッセージを出していること。
  const editorModeHandlerMatch = src.match(/btnEditorMode\.addEventListener\('click', \(\) => \{[\s\S]*?\n {2}\}\);/);
  check('[結線] (b) btnEditorModeのクリックハンドラを検出できる', Boolean(editorModeHandlerMatch));
  const editorModeHandlerBody = editorModeHandlerMatch ? editorModeHandlerMatch[0] : '';
  check(
    '[結線] (b) btnEditorModeハンドラがcurrentSongMmlSourceTextの有無で分岐している',
    /currentSongIsLoaded\s*&&\s*currentSongMmlSourceText\s*==\s*null/.test(editorModeHandlerBody),
  );
  check(
    '[結線] (b) ソース無し判定のときpmd.editor.noMmlSourceを表示してreturnしている(モードを切り替えない)',
    /pmd\.editor\.noMmlSource/.test(editorModeHandlerBody) && /setNetStatus\(t\('pmd\.editor\.noMmlSource'\),\s*true\)/.test(editorModeHandlerBody),
  );
  // 「メッセージを出す分岐」が「モードを切り替える(setUiMode)分岐」より前に
  // returnしていること(=切り替えてしまってからブロックする、という順序ミスを検出する)。
  const guardIdx = editorModeHandlerBody.indexOf('pmd.editor.noMmlSource');
  const setUiModeIdx = editorModeHandlerBody.indexOf('setUiMode(next)');
  check(
    '[結線] (b) ソース無しのガードがsetUiMode(next)より前に書かれている(切替後にブロックする順序ミスでない)',
    guardIdx !== -1 && setUiModeIdx !== -1 && guardIdx < setUiModeIdx,
    `guardIdx=${guardIdx}, setUiModeIdx=${setUiModeIdx}`,
  );

  // i18nキーが辞書に定義されていること。
  const i18nSrc = fs.readFileSync(path.join(__dirname, '../ui/i18n.js'), 'utf8');
  check('[結線] ui/i18n.jsにpmd.editor.noMmlSourceキーがja/en両方にある',
    (i18nSrc.match(/'pmd\.editor\.noMmlSource'/g) || []).length >= 2);

  // (c) ライブラリ選択経路でもMMLソースを反映していること。
  const onSelectMatch = src.match(/onSelect:\s*async\s*\(song\)\s*=>\s*\{[\s\S]*?\n {4}\},/);
  check('[結線] (c) libraryPanelのonSelectハンドラを検出できる', Boolean(onSelectMatch));
  const onSelectBody = onSelectMatch ? onSelectMatch[0] : '';
  check(
    '[結線] (c) onSelectがsong.mmlSourceを参照している',
    /song\.mmlSource/.test(onSelectBody),
  );
  check(
    '[結線] (c) onSelectがplayBytes()へmmlSourceTextを渡している',
    /playBytes\(song\.bytes,\s*song\.fileName,\s*undefined,\s*pcmFiles,\s*\[\],\s*mmlSourceText\)/.test(onSelectBody),
  );

  // サンプル曲(sample_fur_elise)はMMLソースを持つ扱いにすること(取り違えると
  // 初見の利用者が編集できなくなる、という利用者指示の再確認)。
  check(
    '[結線] サンプル(プレイヤーモード分岐)がplayBytes()へMMLソース(text)を渡している',
    /playBytes\(new Uint8Array\(buffer\), 'sample_fur_elise\.M', undefined, \[\], \[\], text\)/.test(src),
  );
  check(
    '[結線] loadDefaultSample()がpendingUrlSongにmmlSourceTextを含めている',
    /pendingUrlSong = \{ bytes: new Uint8Array\(buffer\), name: 'sample_fur_elise\.M', mmlSourceText: text \}/.test(src),
  );

  // --- [本体] 曲のMMLソース読み込み確認ダイアログ(2026-08-18、利用者報告2件:
  //     (1)「サンプルで置き換えます」という文言はサンプルではなく選んだ曲のMMLを
  //     入れる操作には誤り。(2)初見時は同梱サンプルが編集欄へ自動で入っている
  //     (loadDefaultSample())ため、「空でなければ確認」のままだと利用者が
  //     一文字も書いていなくても曲を開くたびに毎回確認が出て邪魔だった。 ---

  check(
    '[本体] ui/i18n.jsにconfirm.songMmlReplaceキーがja/en両方にある',
    (i18nSrc.match(/'confirm\.songMmlReplace'/g) || []).length >= 2,
  );
  check(
    '[本体] confirm.songMmlReplaceはconfirm.sampleReplaceとは別のキーである',
    /'confirm\.songMmlReplace'/.test(i18nSrc) && /'confirm\.sampleReplace'/.test(i18nSrc),
  );
  const jaSongMmlReplaceMatch = i18nSrc.match(/'confirm\.songMmlReplace':\s*'([^']*)'/);
  check(
    '[本体] confirm.songMmlReplace(ja)は「サンプル」ではなく「選んだ曲」を指す文言になっている',
    Boolean(jaSongMmlReplaceMatch) &&
      jaSongMmlReplaceMatch[1].includes('選んだ曲') &&
      !jaSongMmlReplaceMatch[1].includes('サンプル'),
    jaSongMmlReplaceMatch ? jaSongMmlReplaceMatch[1] : '(見つからない)',
  );

  // reflectSongMmlSourceQuietly()(曲のMMLソースを編集欄へ静かに反映する唯一の
  // 窓口。書庫・URL・ライブラリ選択のいずれもここを通る)の本体をDOM無しで
  // 文字列検査する: (i)確認文にconfirm.songMmlReplaceを使っていること、
  // (ii)確認の要否をmmlDirty(利用者の未保存の編集)で判定していること、
  // (iii)「空でなければ確認」(dlSampleFurElise側の判定)を流用していないこと。
  const reflectMatch = src.match(/function reflectSongMmlSourceQuietly\(text\) \{[\s\S]*?\n {2}\}/);
  check('[本体] reflectSongMmlSourceQuietly()を検出できる', Boolean(reflectMatch));
  const reflectBody = reflectMatch ? reflectMatch[0] : '';
  check(
    '[本体] 曲のMMLソース読み込み経路はconfirm.songMmlReplaceを表示する(confirm.sampleReplaceを流用していない)',
    /t\('confirm\.songMmlReplace'\)/.test(reflectBody) && !/t\('confirm\.sampleReplace'\)/.test(reflectBody),
  );
  check(
    '[本体] 曲のMMLソース読み込み経路はmmlDirtyがtrueのときだけ確認する',
    /if\s*\(\s*mmlDirty\s*\)\s*\{/.test(reflectBody),
  );
  check(
    '[本体] 曲のMMLソース読み込み経路は「編集欄が空でなければ確認」(value.trim().length > 0)を使っていない',
    !/mmlTextarea\.value\.trim\(\)\.length\s*>\s*0/.test(reflectBody),
  );

  // dlSampleFurElise(サンプル読み込み側)の条件は従来のまま
  // (「編集欄が空でなければ確認」+confirm.sampleReplace)であることを確認する。
  // あちらは利用者が明示的に「サンプルを読む」と操作した結果であり、曲のMML
  // ソース読み込みとは意図的に条件を揃えていない(reflectSongMmlSourceQuietly()の
  // コメント参照)。
  const dlSampleMatch = src.match(
    /document\.getElementById\('dlSampleFurElise'\)\.addEventListener\('click', async \(\) => \{[\s\S]*?\n {2}\}\);/,
  );
  check('[本体] dlSampleFurEliseのクリックハンドラを検出できる', Boolean(dlSampleMatch));
  const dlSampleBody = dlSampleMatch ? dlSampleMatch[0] : '';
  check(
    '[本体] サンプル読み込み側は従来通り「編集欄が空でなければ確認」+confirm.sampleReplaceのまま',
    /mmlTextarea\.value\.trim\(\)\.length\s*>\s*0/.test(dlSampleBody) &&
      /t\('confirm\.sampleReplace'\)/.test(dlSampleBody),
  );
}

async function main() {
  console.log('=== tools/verify_pmd_mml_source.mjs: MMLソース連動の検証 ===\n');
  testBasenameMatch();
  testExtensionCase();
  testCp932Decode();
  testNoMmlSource();
  await testLibraryRoundTrip();
  testWiring();
  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main();
