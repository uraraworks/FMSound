#!/usr/bin/env node
// PMD86 `.P86` PCMの結線(第2段階)の実測検証。net/pmd-p86.js p86ToPpc()
// (第1段階、tools/verify_pmd_p86.mjsが検証済み)を、書庫経路・ライブラリ経路・
// ファイル経路(writeSongWithPcm())のどこから曲を開いても実際に鳴るところまで
// 結線したことを検証する。ヘルパ単体(p86ToPpc()を直接呼ぶだけ)では「結線」を
// 見たことにならないため、このスクリプトは必ず本番の窓口(collectPmdPcmFiles()/
// writeSongWithPcm()/net/library.js)を経由させる。
//
// 検証項目:
//   [本体/拡張子]   PMD_PCM_EXTENSIONSに.P86が入り、collectUnsupportedPmdPcmFiles()
//                  からは外れている(.PPSだけが残る)こと
//   [本体/書庫経路] collectPmdPcmFiles(entries, songEntryName)が書庫展開エントリから
//                  .P86を拾うこと(他のPCM拡張子と同じ扱い)
//   [本体/ファイル経路] writeSongWithPcm()が.P86をp86ToPpc()で変換し、
//                  `<拡張子抜きの元の名前>.PPC`としてMEMFSへ書くこと。元の.P86は
//                  書かないこと(バイト完全一致で検証)
//   [本体/ライブラリ経路] importArchiveSongs()->loadPcmFilesForSong()の往復で
//                  .P86の名前とバイト列がそのまま復元され、それを再びwriteSongWithPcm()
//                  へ渡すと同じ.PPCへ変換されること(書庫を経由しなくても鳴る証拠)
//   [E2E]          実データ(kckor_reb.M + MBE86PCM.P86)をwasmコアで再生し、
//                  ADPCM以外を全ミュートしたabsSumが.P86ありで非0、
//                  陰性対照(.P86を渡さない)でほぼ0であること
//   [陽性対照]      writeSongWithPcm()の変換呼び出しを削った版(このファイル内で
//                  独立に組み立てる。本体を書き換えない)で、E2Eのabsサム比較が
//                  陰性対照と同じ「ほぼ0」まで落ちる(症状で落ちる)ことを確認する
//   [変換失敗]      invalid_p86/capacityそれぞれの失敗が
//                  Module.__pmdPcmP86Failuresへ積まれ、describePmdPcmStatus()が
//                  pmd.pcm.p86Invalid/p86Capacityキーを返すこと。capacityは
//                  requiredBytes/maxBytesの実数値がパラメータに載ること
//   [i18n]          ja/en両方にpmd.pcm.p86Invalid/p86Capacityが存在し、
//                  旧pmd.pcm.p86Unsupportedキーが跡形なく消えていること
//   [結線]          html/pmd-app.jsがp86ConversionErrorsをdescribePmdPcmStatus()へ
//                  渡していることを文字列検査する
//
// 実行: node tools/verify_pmd_p86_wiring.mjs
// (pmdweb/build-web/pmdweb.js が事前にビルド済みであること。
//  /Users/haruurara/Downloads/4OpAlice/{kckor_reb.M,MBE86PCM.P86} が必要。
//  600秒を超えたら打ち切る)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import {
  writeSongWithPcm, describePmdPcmStatus, collectPmdPcmFiles,
  collectUnsupportedPmdPcmFiles, PMD_PCM_EXTENSIONS,
} from '../net/pmd-pcm.js';
import { p86ToPpc } from '../net/pmd-p86.js';
import {
  buildPmdChannelMask, FM_CHANNELS, SSG_CHANNELS, RHYTHM_CHANNEL,
} from '../fmdsp/channel-mask.js';
import { DICT as I18N_DICT } from '../ui/i18n.js';
import {
  openLibraryDb, importArchiveSongs, listSongs, loadPcmFilesForSong,
} from '../net/library.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = '/Users/haruurara/Downloads/4OpAlice';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

// 陽性対照専用: 「意図的に壊した入力/経路のもとで本来の主張が成立するか」を表す式が
// false(=本来の主張が崩れて症状で落ちる)であることを確認する。
function checkExpectFail(name, cond, detail) {
  return check(name, cond === false, detail);
}

const DEADLINE_MS = 480000;
const startTime = Date.now();
function checkDeadline(label) {
  const elapsed = Date.now() - startTime;
  if (elapsed > DEADLINE_MS) {
    console.log(`\n=== 打ち切り: ${label} の時点で ${elapsed}ms 経過(上限${DEADLINE_MS}ms) ===`);
    console.log(`実行済み: ${passCount} PASS / ${failCount} FAIL`);
    process.exit(1);
  }
}

// --- 合成.P86を1本組み立てる(tools/verify_pmd_p86.js buildFakeP86()を複製。
//     出典と仕組みのコメントも含め同一。改変していない) ---
function buildFakeP86({ tonenum, samples }) {
  const DATA_OFF = 0x610; // 実測値(MBE86PCM.P86の実測)に合わせる
  const totalLen = DATA_OFF + samples.length;
  const buf = new Uint8Array(totalLen);
  const magic = 'PCM86 DATA\n\0';
  for (let i = 0; i < magic.length; i++) buf[i] = magic.charCodeAt(i);
  buf[12] = 0x11; // version
  buf[13] = totalLen & 0xff;
  buf[14] = (totalLen >> 8) & 0xff;
  buf[15] = (totalLen >> 16) & 0xff;
  const off = 16 + tonenum * 6;
  buf[off] = DATA_OFF & 0xff;
  buf[off + 1] = (DATA_OFF >> 8) & 0xff;
  buf[off + 2] = (DATA_OFF >> 16) & 0xff;
  buf[off + 3] = samples.length & 0xff;
  buf[off + 4] = (samples.length >> 8) & 0xff;
  buf[off + 5] = (samples.length >> 16) & 0xff;
  buf.set(samples, DATA_OFF);
  return buf;
}

function buildSineSamples(count) {
  const samples = new Int8Array(count);
  for (let i = 0; i < count; i++) samples[i] = Math.round(100 * Math.sin((2 * Math.PI * i) / 37));
  return samples;
}

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// --- Node用の最小フェイクIndexedDB(tools/verify_library.mjsのものを複製。
//     get/put/getAll/transactionだけを実装した部分実装。net/library.js自体は
//     無改変のまま検証する、という方針を保つため実装は複製しネットワークへは出さない) ---
class FakeRequest {
  constructor() { this.onsuccess = null; this.onupgradeneeded = null; this.result = undefined; }
  _succeed(result) { this.result = result; setTimeout(() => { if (this.onsuccess) this.onsuccess({ target: this }); }, 0); }
}
class FakeStore {
  constructor(dataMap, keyPath) { this.dataMap = dataMap; this.keyPath = keyPath; }
  get(key) { const req = new FakeRequest(); req._succeed(this.dataMap.has(key) ? this.dataMap.get(key) : undefined); return req; }
  put(value) { const req = new FakeRequest(); const key = value[this.keyPath]; this.dataMap.set(key, value); req._succeed(key); return req; }
  delete(key) { const req = new FakeRequest(); this.dataMap.delete(key); req._succeed(undefined); return req; }
  clear() { const req = new FakeRequest(); this.dataMap.clear(); req._succeed(undefined); return req; }
  getAll() { const req = new FakeRequest(); req._succeed([...this.dataMap.values()]); return req; }
}
class FakeDatabase {
  constructor() { this.stores = new Map(); this.keyPaths = new Map(); this.version = 0; }
  get objectStoreNames() { const stores = this.stores; return { contains: (name) => stores.has(name) }; }
  createObjectStore(name, opts) { this.stores.set(name, new Map()); this.keyPaths.set(name, opts.keyPath); return new FakeStore(this.stores.get(name), opts.keyPath); }
  transaction(storeNames) {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const db = this;
    return { objectStore(name) { if (!names.includes(name)) throw new Error(`fake IDB: '${name}' はスコープ外`); return new FakeStore(db.stores.get(name), db.keyPaths.get(name)); } };
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
      if (needsUpgrade) { db.version = requestedVersion; if (req.onupgradeneeded) req.onupgradeneeded({ target: req, oldVersion, newVersion: requestedVersion }); }
      if (req.onsuccess) req.onsuccess({ target: req });
    }, 0);
    return req;
  }
}

const ALL_EXCEPT_ADPCM = new Set([...FM_CHANNELS, ...SSG_CHANNELS, RHYTHM_CHANNEL]);
const PMD_MASK = buildPmdChannelMask(ALL_EXCEPT_ADPCM);

// ADPCM以外を全ミュートして再生し、absSumを実測する(本番のwriteSongWithPcm()経由)。
async function measureAdpcmAbsSum({ songBytes, songName, pcmFiles, chunks = 300 }) {
  const Module = await createPmdWeb();
  const songPath = writeSongWithPcm(Module, { songName, songBytes, pcmFiles });
  const err = Module.playMusic(songPath);
  if (err) throw new Error(`playMusic失敗: ${err}`);
  Module.setChannelMask(PMD_MASK);
  let absSum = 0;
  for (let i = 0; i < chunks; i++) absSum += Module.renderFramesForTest(2048);
  return absSum;
}

// [陽性対照専用] writeSongWithPcm()の.P86変換呼び出しを削った版。net/pmd-pcm.jsを
// 書き換えず、このファイル内だけで独立に組み立てる(本体のwriteSongWithPcm()自体は
// このテスト実行中も正常なまま)。.P86ファイルは単に無視して書かない(=「変換して
// 書く」処理そのものが無かった状態を再現する)。
async function measureAdpcmAbsSumWithoutP86Conversion({ songBytes, songName, pcmFiles, chunks = 300 }) {
  const Module = await createPmdWeb();
  const dir = '/brokensong';
  Module.FS.mkdir(dir);
  const songPath = `${dir}/${songName}`;
  Module.FS.writeFile(songPath, songBytes);
  for (const pcm of pcmFiles) {
    if (/\.P86$/i.test(pcm.name)) continue; // 変換呼び出しを削った(=P86を無視する)
    Module.FS.writeFile(`${dir}/${pcm.name}`, pcm.data);
  }
  const err = Module.playMusic(songPath);
  if (err) throw new Error(`playMusic失敗(broken): ${err}`);
  Module.setChannelMask(PMD_MASK);
  let absSum = 0;
  for (let i = 0; i < chunks; i++) absSum += Module.renderFramesForTest(2048);
  return absSum;
}

async function main() {
  console.log('=== PMD86 .P86 結線(第2段階) 実測検証 ===\n');

  // --- [本体/拡張子] ---
  check('[本体/拡張子] PMD_PCM_EXTENSIONSに.P86が含まれる', PMD_PCM_EXTENSIONS.includes('.P86'), `PMD_PCM_EXTENSIONS=${JSON.stringify(PMD_PCM_EXTENSIONS)}`);
  const unsupported = collectUnsupportedPmdPcmFiles([
    { name: 'songs/DRUM86.P86', data: new Uint8Array(0) },
    { name: 'songs/DRUM.PPS', data: new Uint8Array(0) },
    { name: 'songs/OTHER.TXT', data: new Uint8Array(0) },
  ]);
  check('[本体/拡張子] collectUnsupportedPmdPcmFiles()はもう.P86を拾わない(.PPSだけ)',
    unsupported.length === 1 && unsupported[0].ext === '.PPS',
    `result=${JSON.stringify(unsupported)}`);

  // --- [本体/書庫経路] ---
  const fakeP86Bytes = buildFakeP86({ tonenum: 1, samples: buildSineSamples(200) });
  const archiveEntries = [
    { name: 'DISK/song.M', data: new TextEncoder().encode('dummy') },
    { name: 'DISK/MBE86PCM.P86', data: fakeP86Bytes },
  ];
  const archivePcmFiles = collectPmdPcmFiles(archiveEntries, 'DISK/song.M');
  const p86FromArchive = archivePcmFiles.find((f) => f.name === 'MBE86PCM.P86');
  check('[本体/書庫経路] collectPmdPcmFiles()が書庫展開エントリから.P86を拾う',
    !!p86FromArchive && bytesEqual(p86FromArchive.data, fakeP86Bytes),
    `拾った件数=${archivePcmFiles.length}`);
  checkDeadline('書庫経路検証後');

  // --- [本体/ファイル経路] writeSongWithPcm()が.P86を疑似.PPCへ変換して書く ---
  {
    const Module = await createPmdWeb();
    const songPath = writeSongWithPcm(Module, {
      songName: 'song.M',
      songBytes: new TextEncoder().encode('dummy'),
      pcmFiles: [{ name: 'MBE86PCM.P86', data: fakeP86Bytes }],
    });
    const dir = path.posix.dirname(songPath);
    const names = Module.FS.readdir(dir).filter((n) => n !== '.' && n !== '..');
    check('[本体/ファイル経路] 元の.P86はMEMFSへ書かれない', !names.includes('MBE86PCM.P86'), `names=${JSON.stringify(names)}`);
    check('[本体/ファイル経路] `<拡張子抜きの元の名前>.PPC`としてMEMFSへ書かれる', names.includes('MBE86PCM.PPC'), `names=${JSON.stringify(names)}`);
    const written = Module.FS.readFile(`${dir}/MBE86PCM.PPC`);
    const expected = p86ToPpc(fakeP86Bytes);
    check('[本体/ファイル経路] 書き込まれたバイト列がp86ToPpc()の出力とバイト完全一致',
      expected.ok && bytesEqual(written, expected.bytes),
      `written.length=${written.length} expected.length=${expected.ok ? expected.bytes.length : 'N/A'}`);
    check('[本体/ファイル経路] 変換成功時はModule.__pmdPcmP86Failuresが空', (Module.__pmdPcmP86Failures || []).length === 0,
      `failures=${JSON.stringify(Module.__pmdPcmP86Failures)}`);
  }
  checkDeadline('ファイル経路検証後');

  // --- [本体/ライブラリ経路] importArchiveSongs() -> loadPcmFilesForSong() の往復 ---
  {
    const candidates = [{ driver: 'pmd', displayName: 'song.M', entry: archiveEntries[0] }];
    const archiveInput = {
      driver: 'pmd', url: 'https://example.com/p86test.zip', entries: archiveEntries,
      archiveLabel: 'p86test.zip', candidates,
    };
    const fakeIdb = new FakeIDBFactory();
    const db = await openLibraryDb(fakeIdb);
    await importArchiveSongs(db, archiveInput);
    const songs = await listSongs(db);
    const song = songs.find((s) => s.fileName === 'song.M');
    check('[本体/ライブラリ経路] 取り込んだ曲がpcmRefsを1件持つ(.P86も他のPCMと同じく保存される)',
      Boolean(song) && song.pcmRefs?.length === 1, `pcmRefs=${JSON.stringify(song?.pcmRefs)}`);
    const resolved = await loadPcmFilesForSong(db, song);
    const resolvedP86 = resolved.find((f) => f.name === 'MBE86PCM.P86');
    check('[本体/ライブラリ経路] loadPcmFilesForSong()が.P86の名前とバイト列をそのまま復元する',
      !!resolvedP86 && bytesEqual(resolvedP86.data, fakeP86Bytes),
      `resolved=${JSON.stringify(resolved.map((f) => f.name))}`);

    // ライブラリから復元したpcmFilesを、書庫を経由せず直接writeSongWithPcm()へ渡す
    // (=ライブラリ選択後の再生と同じ経路)。書庫経路と同じ.PPCへ変換されることを確認する。
    if (resolvedP86) {
      const Module = await createPmdWeb();
      const songPath = writeSongWithPcm(Module, {
        songName: 'song.M', songBytes: new TextEncoder().encode('dummy'), pcmFiles: resolved,
      });
      const dir = path.posix.dirname(songPath);
      const written = Module.FS.readFile(`${dir}/MBE86PCM.PPC`);
      const expected = p86ToPpc(fakeP86Bytes);
      check('[本体/ライブラリ経路] ライブラリ復元したpcmFilesでもwriteSongWithPcm()が同じ.PPCへ変換する(書庫経由と同一)',
        expected.ok && bytesEqual(written, expected.bytes));
    }
  }
  checkDeadline('ライブラリ経路検証後');

  // --- [E2E] 実データ(kckor_reb.M + MBE86PCM.P86)で実際に鳴ることを実測する ---
  const songPath86 = path.join(DATA_DIR, 'kckor_reb.M');
  const p86Path = path.join(DATA_DIR, 'MBE86PCM.P86');
  if (!fs.existsSync(songPath86) || !fs.existsSync(p86Path)) {
    console.log(`\n[SKIP] E2E: 実データが見つからない(${songPath86} / ${p86Path})`);
  } else {
    const realSongBytes = new Uint8Array(fs.readFileSync(songPath86));
    const realP86Bytes = new Uint8Array(fs.readFileSync(p86Path));

    const withP86Sum = await measureAdpcmAbsSum({
      songBytes: realSongBytes, songName: 'kckor_reb.M', pcmFiles: [{ name: 'MBE86PCM.P86', data: realP86Bytes }],
    });
    console.log(`[E2E] .P86ありでのADPCM absSum=${withP86Sum}`);
    checkDeadline('E2E本体測定後');

    const withoutSum = await measureAdpcmAbsSum({
      songBytes: realSongBytes, songName: 'kckor_reb.M', pcmFiles: [],
    });
    console.log(`[陰性対照] .P86を渡さない場合のADPCM absSum=${withoutSum}`);
    checkDeadline('E2E陰性対照測定後');

    const brokenSum = await measureAdpcmAbsSumWithoutP86Conversion({
      songBytes: realSongBytes, songName: 'kckor_reb.M', pcmFiles: [{ name: 'MBE86PCM.P86', data: realP86Bytes }],
    });
    console.log(`[陽性対照] 変換呼び出しを削った版でのADPCM absSum=${brokenSum}`);
    checkDeadline('E2E陽性対照測定後');

    check('[E2E] .P86ありでADPCM absSumが非0(実際に鳴っている証拠)', withP86Sum > 0, `absSum=${withP86Sum}`);
    const threshold = Math.max(withP86Sum * 0.01, 1);
    check('[陰性対照] .P86を渡さない場合はabsSumがほぼ0',
      withoutSum <= threshold, `absSum=${withoutSum} 閾値=${threshold.toFixed(2)}`);
    checkExpectFail(
      '[陽性対照] 変換呼び出しを削ると、「.P86を渡せば鳴る」という主張は症状で崩れる(absSumが陰性対照並みまで落ちる)',
      brokenSum > threshold,
      `broken absSum=${brokenSum} 閾値=${threshold.toFixed(2)}(壊れていれば陰性対照の${withoutSum}に近いはず)`,
    );
    check('[陽性対照] 変換呼び出しを削った版のabsSumは、そのままエラーで落ちたのではなく"鳴らなくなった"(数値として観測できる)',
      Number.isFinite(brokenSum) && brokenSum >= 0, `absSum=${brokenSum}`);

    console.log(`\n実測値まとめ: withP86=${withP86Sum} without=${withoutSum} broken=${brokenSum}`);
  }

  // --- [変換失敗] invalid_p86 / capacity のそれぞれをwriteSongWithPcm()経由で発火させる ---
  {
    // invalid_p86: マジックを壊した.P86
    const invalidP86 = new Uint8Array(fakeP86Bytes);
    invalidP86[0] = 0x00; // マジック不一致にする
    const Module = await createPmdWeb();
    writeSongWithPcm(Module, {
      songName: 'song.M', songBytes: new TextEncoder().encode('dummy'),
      pcmFiles: [{ name: 'BROKEN.P86', data: invalidP86 }],
    });
    const failures = Module.__pmdPcmP86Failures || [];
    check('[変換失敗/invalid] 壊れた.P86はMEMFSへ書かれず、__pmdPcmP86Failuresへerror:invalid_p86が積まれる',
      failures.length === 1 && failures[0].error === 'invalid_p86' && failures[0].name === 'BROKEN.P86',
      `failures=${JSON.stringify(failures)}`);
    const messages = describePmdPcmStatus({ slots: [], unsupportedFiles: [], p86ConversionErrors: failures });
    check('[変換失敗/invalid] describePmdPcmStatus()がpmd.pcm.p86Invalidキーを返す',
      messages.length === 1 && messages[0].key === 'pmd.pcm.p86Invalid' && messages[0].params.file === 'BROKEN.P86',
      `messages=${JSON.stringify(messages)}`);
  }
  checkDeadline('invalid_p86検証後');

  {
    // capacity: ADPCM RAM(256KB)を超える巨大な.P86(tools/verify_pmd_p86.mjsの
    // 「1エントリだけでADPCM RAMを超える」構成と同じ考え方)
    const hugeSamples = new Int8Array(600000);
    for (let i = 0; i < hugeSamples.length; i++) hugeSamples[i] = (i % 200) - 100;
    const hugeP86 = buildFakeP86({ tonenum: 10, samples: hugeSamples });
    const Module = await createPmdWeb();
    writeSongWithPcm(Module, {
      songName: 'song.M', songBytes: new TextEncoder().encode('dummy'),
      pcmFiles: [{ name: 'HUGE.P86', data: hugeP86 }],
    });
    const failures = Module.__pmdPcmP86Failures || [];
    check('[変換失敗/capacity] 巨大な.P86はMEMFSへ書かれず、__pmdPcmP86Failuresへerror:capacityが積まれる',
      failures.length === 1 && failures[0].error === 'capacity' && failures[0].name === 'HUGE.P86',
      `failures=${JSON.stringify(failures)}`);
    const messages = describePmdPcmStatus({ slots: [], unsupportedFiles: [], p86ConversionErrors: failures });
    const msg = messages[0];
    check('[変換失敗/capacity] describePmdPcmStatus()がpmd.pcm.p86Capacityキーを、requiredBytes/maxBytesの実数値付きで返す',
      messages.length === 1 && msg.key === 'pmd.pcm.p86Capacity'
        && typeof msg.params.requiredBytes === 'number' && msg.params.requiredBytes > 0
        && typeof msg.params.maxBytes === 'number' && msg.params.requiredBytes > msg.params.maxBytes,
      `messages=${JSON.stringify(messages)}`);
  }
  checkDeadline('capacity検証後');

  // --- 曲を読み込むたびに前回の失敗を持ち越さないこと(cleanupPreviousSongDir()と
  //     同じ考え方: 積みっぱなしにすると前の曲のエラーが次の曲にも表示され続ける) ---
  {
    const Module = await createPmdWeb();
    const invalidP86 = new Uint8Array(fakeP86Bytes);
    invalidP86[0] = 0x00;
    writeSongWithPcm(Module, {
      songName: 'first.M', songBytes: new TextEncoder().encode('dummy'),
      pcmFiles: [{ name: 'BROKEN.P86', data: invalidP86 }],
    });
    check('[変換失敗/持ち越し] 1曲目は失敗が積まれる', (Module.__pmdPcmP86Failures || []).length === 1);
    writeSongWithPcm(Module, {
      songName: 'second.M', songBytes: new TextEncoder().encode('dummy'), pcmFiles: [],
    });
    check('[変換失敗/持ち越し] 別の曲(.P86を使わない)を読み込むと前回の失敗は消える(持ち越さない)',
      (Module.__pmdPcmP86Failures || []).length === 0, `failures=${JSON.stringify(Module.__pmdPcmP86Failures)}`);
  }
  checkDeadline('持ち越し検証後');

  // --- [i18n] ja/en両方にp86Invalid/p86Capacityが存在し、旧p86Unsupportedが消えていること ---
  for (const lang of ['ja', 'en']) {
    const invalidVal = I18N_DICT[lang]?.['pmd.pcm.p86Invalid'];
    check(`[i18n] ${lang}.pmd.pcm.p86Invalidが存在し{file}を含む`,
      typeof invalidVal === 'string' && invalidVal.includes('{file}'), `value="${invalidVal}"`);
    const capacityVal = I18N_DICT[lang]?.['pmd.pcm.p86Capacity'];
    check(`[i18n] ${lang}.pmd.pcm.p86Capacityが存在し{file}{requiredBytes}{maxBytes}を含む`,
      typeof capacityVal === 'string' && capacityVal.includes('{file}') && capacityVal.includes('{requiredBytes}') && capacityVal.includes('{maxBytes}'),
      `value="${capacityVal}"`);
    check(`[i18n] ${lang}に旧キーpmd.pcm.p86Unsupportedが残っていない`,
      I18N_DICT[lang]?.['pmd.pcm.p86Unsupported'] === undefined);
  }
  check('[i18n] pmd.pcm.missingの文面から「PMD86は未対応」の一文が削除されている(ja)',
    !I18N_DICT.ja['pmd.pcm.missing'].includes('PMD86') , `value="${I18N_DICT.ja['pmd.pcm.missing']}"`);
  check('[i18n] pmd.pcm.missingの文面から「PMD86は未対応」の一文が削除されている(en)',
    !I18N_DICT.en['pmd.pcm.missing'].includes('PMD86'), `value="${I18N_DICT.en['pmd.pcm.missing']}"`);
  check('[i18n] pmd.pcm.missingの文面はPPSDRV未対応の案内はそのまま残す(ja)',
    I18N_DICT.ja['pmd.pcm.missing'].includes('PPSDRV'));
  check('[i18n] pmd.pcm.missingの文面はPPSDRV未対応の案内はそのまま残す(en)',
    I18N_DICT.en['pmd.pcm.missing'].includes('PPSDRV'));

  // --- [結線] html/pmd-app.jsを実ファイルとして読み、文字列検査する ---
  const appSrc = fs.readFileSync(path.join(__dirname, '../html/pmd-app.js'), 'utf8');
  check('[結線] pmd-app.jsがModule.__pmdPcmP86Failuresを読んでいる', /__pmdPcmP86Failures/.test(appSrc));
  check('[結線] pmd-app.jsがp86ConversionErrorsをdescribePmdPcmStatus()へ渡している',
    /describePmdPcmStatus\(\{[\s\S]{0,200}p86ConversionErrors/.test(appSrc));
  check('[結線] pmd-app.jsに旧p86Unsupportedへの参照が残っていない', !/p86Unsupported/.test(appSrc));

  console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
  if (failCount > 0) process.exit(1);
}

main();
