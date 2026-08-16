#!/usr/bin/env node
// 「ファイルから開く」/ドラッグ&ドロップでも書庫(zip/lzh/d88)を開けるようにした変更の検証。
//
// 経緯: 修正前は html/mucom-app.js・html/pmd-app.js の openMmlFile()/D&Dハンドラが
// 書庫かどうかを一切判定せず、選んだ/落としたファイルのバイト列をそのままMMLテキスト
// としてデコードする経路(applyMmlBytes()/playBytes())へ渡していた。書庫を渡すと
// 無言でコンパイルエラーになる不具合だった(利用者からの依頼で発覚・修正)。
//
// 修正: html/net-load.js に resolveSongFromFile() を新設し、URL経路
// (resolveSongFromUrl())が既に使っている net/archive.js・net/song-select.js の
// 判定・展開・曲候補列挙にそのまま合流させた(判定ロジックを2箇所に書き分けない)。
// html/mucom-app.js openMmlFile() / html/pmd-app.js openPmdFile() は
// resolved.kind==='archive' なら書庫選択モーダル(pickSongCandidate())・ライブラリ
// 一括取り込み(importArchiveSongsToLibrary())を経由し、'single' なら従来どおり
// 直接デコードする。
//
// 検証項目:
//   (a) 判定の純粋関数(net/archive.js isArchive()/resolveArchiveFileName())が
//       .zip/.lzh/.d88 を書庫、.muc/.m/.M をMMLと判定すること。
//   (b) fileInput.accept(html/mucom-app.js・html/pmd-app.js)が書庫拡張子を含み、
//       かつ net/archive.js の ARCHIVE_EXTENSIONS を参照していること(ハードコードされた
//       別の拡張子リストに分岐していないことを、ソースの静的走査で確認する)。
//   (c) resolveSongFromFile()(html/net-load.js、dist/経由)が実際のzip書庫を
//       kind:'archive' として展開し、中の.mucが候補として取り出せること。単体の
//       .mucファイルは kind:'single' になること。
//   (d) 回帰検出(本題): openMmlFile()/openPmdFile() の書庫分岐(resolved.kind==='archive')
//       が、書庫の生バイト列(resolved.bytes)をMMLデコード経路(applyMmlBytes()/
//       playBytes())へ絶対に渡さないこと。ソースを静的に走査し、書庫分岐の中に
//       'resolved.bytes' という参照が一切現れないこと、かつ書庫分岐が必ずreturnで
//       閉じている(素通りしてMMLデコード行へ落ちない)ことを確認する。
//       このチェック自体が実際に機能することを、意図的に壊した合成ソース(=修正前と
//       同じ「書庫分岐が無く、常にresolved.bytesをデコードする」実装を模したもの)に
//       対して実行し、FAILすることを陽性対照として確認する。
//
// 実行: node tools/verify_open_file_archive.mjs (事前に tools/build_dist.sh が必要。
// dist/net-load.js 経由で resolveSongFromFile() を検証するのは verify_net_url_load.mjs と
// 同じ理由: html/*.js の相対import(./net/...)が兄弟ディレクトリとして解決できるのは
// dist/ の中だけのため)。

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { isArchive, ARCHIVE_EXTENSIONS, resolveArchiveFileName } from '../net/archive.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_NET_LOAD = path.join(REPO_ROOT, 'dist', 'net-load.js');

let failed = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failed++;
  console.log(`[${mark}] ${label}${detail !== undefined ? ' - ' + detail : ''}`);
}

// --- (a) 判定の純粋関数 ----------------------------------------------------------------

check('(a) isArchive: .zip/.lzh/.d88(大文字小文字問わず)を書庫と判定する',
  isArchive('foo.zip') && isArchive('foo.ZIP') && isArchive('foo.lzh') && isArchive('foo.LZH') &&
  isArchive('foo.d88') && isArchive('foo.D88'));
check('(a) isArchive: .muc/.m/.M はMML(書庫ではない)と判定する',
  !isArchive('foo.muc') && !isArchive('foo.m') && !isArchive('foo.M'));
check('(a) ARCHIVE_EXTENSIONS の全拡張子がisArchive()でも書庫と判定される(2箇所が食い違わないことの確認)',
  ARCHIVE_EXTENSIONS.every((ext) => isArchive(`song${ext}`)),
  JSON.stringify(ARCHIVE_EXTENSIONS));
check('(a) resolveArchiveFileName: 拡張子が無くマジックバイトもMMLなプレーンテキストはnull(書庫ではない)',
  resolveArchiveFileName('song', new TextEncoder().encode('#mucom88 1.5\nA cdefg\n')) === null);

// --- (b) fileInput.accept の静的走査 ----------------------------------------------------

function readSource(relPath) {
  return readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

function acceptLineOf(source) {
  const m = /fileInput\.accept\s*=\s*([^;]+);/.exec(source);
  return m ? m[1] : null;
}

const mucomSrc = readSource('html/mucom-app.js');
const pmdSrc = readSource('html/pmd-app.js');
const mucomAcceptLine = acceptLineOf(mucomSrc);
const pmdAcceptLine = acceptLineOf(pmdSrc);

check('(b) html/mucom-app.js: fileInput.accept 代入が見つかる', mucomAcceptLine !== null);
check('(b) html/pmd-app.js: fileInput.accept 代入が見つかる', pmdAcceptLine !== null);
check('(b) html/mucom-app.js: accept が net/archive.js の ARCHIVE_EXTENSIONS を参照している(拡張子を直書きで複製していない)',
  mucomAcceptLine !== null && /\.\.\.ARCHIVE_EXTENSIONS/.test(mucomAcceptLine), mucomAcceptLine);
check('(b) html/pmd-app.js: accept が net/archive.js の ARCHIVE_EXTENSIONS を参照している(拡張子を直書きで複製していない)',
  pmdAcceptLine !== null && /\.\.\.ARCHIVE_EXTENSIONS/.test(pmdAcceptLine), pmdAcceptLine);
check('(b) html/mucom-app.js: 従来どおり .muc も含む', mucomAcceptLine !== null && /'\.muc'/.test(mucomAcceptLine));
check('(b) html/pmd-app.js: 従来どおり .m/.M も含む',
  pmdAcceptLine !== null && /'\.m'/.test(pmdAcceptLine) && /'\.M'/.test(pmdAcceptLine));
// ARCHIVE_EXTENSIONSがimportされていること自体も確認する(参照だけでimportが無ければ実行時エラーになる)。
check('(b) html/mucom-app.js: ARCHIVE_EXTENSIONS を net-load.js からimportしている',
  /import\s*\{[^}]*ARCHIVE_EXTENSIONS[^}]*\}\s*from\s*'\.\/net-load\.js'/.test(mucomSrc));
check('(b) html/pmd-app.js: ARCHIVE_EXTENSIONS を net-load.js からimportしている',
  /import\s*\{[^}]*ARCHIVE_EXTENSIONS[^}]*\}\s*from\s*'\.\/net-load\.js'/.test(pmdSrc));

// --- (c) resolveSongFromFile(): 実際の書庫展開 -------------------------------------------

if (!existsSync(DIST_NET_LOAD)) {
  console.error(`FATAL: ${DIST_NET_LOAD} が無い。先に tools/build_dist.sh を実行すること。`);
  process.exit(1);
}
const { resolveSongFromFile } = await import(DIST_NET_LOAD);

/** ブラウザのFileの代わりに使う最小モック(resolveSongFromFile()が使うのは.name/.arrayBuffer()のみ)。 */
function makeFileMock(name, bytes) {
  return {
    name,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

const workDir = mkdtempSync(path.join(tmpdir(), 'fmsound-open-file-archive-'));
try {
  // 単体の.muc(書庫ではない)。
  const singleMucText = '#mucom88 1.5\n#title 単体ファイル\nA C120 o5 l4 v10 cdefg\n';
  const singleMucBytes = new TextEncoder().encode(singleMucText);
  const singleResolved = await resolveSongFromFile(makeFileMock('song.muc', singleMucBytes));
  check('(c) 単体.mucファイル: kind===single', singleResolved.kind === 'single', `kind=${singleResolved.kind}`);
  check('(c) 単体.mucファイル: bytesが元のファイル内容そのまま', new TextDecoder().decode(singleResolved.bytes) === singleMucText);

  // zip書庫(中に.mucを1本)を実際に`zip`コマンドで組み立てる。
  const archiveSrcDir = path.join(workDir, 'archive-src');
  execFileSync('mkdir', ['-p', archiveSrcDir]);
  const innerMucText = '#mucom88 1.5\n#title 書庫内の曲\nA C120 o5 l4 v10 gfedc\n';
  writeFileSync(path.join(archiveSrcDir, 'inner.muc'), innerMucText, 'utf8');
  const zipPath = path.join(workDir, 'archive.zip');
  execFileSync('zip', ['-9', '-j', zipPath, path.join(archiveSrcDir, 'inner.muc')]);
  const zipBytes = new Uint8Array(readFileSync(zipPath));

  const archiveResolved = await resolveSongFromFile(makeFileMock('archive.zip', zipBytes));
  check('(c) zip書庫ファイル: kind===archive', archiveResolved.kind === 'archive', `kind=${archiveResolved.kind}`);
  check('(c) zip書庫ファイル: archiveLabelがファイル名そのもの', archiveResolved.archiveLabel === 'archive.zip');
  check('(c) zip書庫ファイル: 候補一覧にinner.mucが含まれる',
    archiveResolved.candidates.some((c) => c.entry.name === 'inner.muc' && c.driver === 'mucom'),
    JSON.stringify(archiveResolved.candidates.map((c) => c.entry.name)));
  const innerCandidate = archiveResolved.candidates.find((c) => c.entry.name === 'inner.muc');
  check('(c) zip書庫ファイル: 候補の中身(entry.data)は展開後のMMLテキストと一致する(=生のzipバイト列ではない)',
    innerCandidate && new TextDecoder().decode(innerCandidate.entry.data) === innerMucText);
  // 'archive'結果はkind:'single'専用のbytesフィールドを持たない(呼び出し側が
  // resolved.bytesを不用意に読んでも中身は無い=下の(d)の構造的な裏付け)。
  check('(c) zip書庫ファイル: archive結果はトップレベルの`bytes`フィールドを持たない',
    !('bytes' in archiveResolved));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

// --- (d) 回帰検出: 書庫の生バイト列がMMLデコード経路へ渡らないこと ------------------------

/**
 * ソース文字列から `<indent>(async )?function <name>(...) {` で始まり、同じ字下げの
 * `<indent>}` で終わる関数本体を1つ取り出す(この開発チームのコードは2スペース単位の
 * 一定した字下げを崩さないため、フルのbrace対応パーサではなくこの簡易版で足りる)。
 * @param {string} source @param {string} name
 */
function extractFunctionBody(source, name) {
  const lines = source.split('\n');
  const startRe = new RegExp(`^(\\s*)(async\\s+)?function\\s+${name}\\s*\\(`);
  let startIdx = -1;
  let indent = null;
  for (let i = 0; i < lines.length; i++) {
    const m = startRe.exec(lines[i]);
    if (m) { startIdx = i; indent = m[1]; break; }
  }
  if (startIdx < 0) return null;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i] === `${indent}}`) return lines.slice(startIdx, i + 1).join('\n');
  }
  return null;
}

/**
 * 関数本体から `if (resolved.kind === 'archive') { ... }` のブロック本文(中身のみ、
 * 前後の`if`/閉じ括弧は含まない)を取り出す。extractFunctionBody()と同じ
 * 字下げ前提の簡易版。
 * @param {string} functionBody
 */
function extractArchiveBranchBody(functionBody) {
  const lines = functionBody.split('\n');
  const startRe = /^(\s*)if \(resolved\.kind === 'archive'\) \{$/;
  let startIdx = -1;
  let indent = null;
  for (let i = 0; i < lines.length; i++) {
    const m = startRe.exec(lines[i]);
    if (m) { startIdx = i; indent = m[1]; break; }
  }
  if (startIdx < 0) return null;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i] === `${indent}}`) return lines.slice(startIdx + 1, i).join('\n');
  }
  return null;
}

/**
 * (d)の本体チェック: 「書庫分岐がresolved.bytesを一切参照せず、必ずreturnで閉じている」を
 * 確認する。okならtrue。
 * @param {string} functionBody
 */
function archiveBranchNeverDecodesRawBytes(functionBody) {
  const branch = extractArchiveBranchBody(functionBody);
  if (branch === null) return { ok: false, reason: '書庫分岐(if (resolved.kind === \'archive\'))が見つからない' };
  if (branch.includes('resolved.bytes')) {
    return { ok: false, reason: '書庫分岐の中に resolved.bytes への参照がある(生の書庫バイト列がMMLデコード経路へ渡りうる)' };
  }
  const trimmed = branch.trimEnd();
  if (!/return;\s*$/.test(trimmed)) {
    return { ok: false, reason: '書庫分岐の末尾がreturn;で閉じていない(素通りしてMMLデコード行へ落ちる可能性がある)' };
  }
  return { ok: true };
}

const mucomOpenBody = extractFunctionBody(mucomSrc, 'openMmlFile');
const pmdOpenBody = extractFunctionBody(pmdSrc, 'openPmdFile');
check('(d) html/mucom-app.js: openMmlFile()が見つかる', mucomOpenBody !== null);
check('(d) html/pmd-app.js: openPmdFile()が見つかる', pmdOpenBody !== null);

const mucomCheck = mucomOpenBody ? archiveBranchNeverDecodesRawBytes(mucomOpenBody) : { ok: false, reason: '関数が見つからない' };
const pmdCheck = pmdOpenBody ? archiveBranchNeverDecodesRawBytes(pmdOpenBody) : { ok: false, reason: '関数が見つからない' };
check('(d) [回帰検出・本題] html/mucom-app.js openMmlFile(): 書庫の生バイト列がapplyMmlBytes()(MMLデコード経路)へ渡らない',
  mucomCheck.ok, mucomCheck.reason);
check('(d) [回帰検出・本題] html/pmd-app.js openPmdFile(): 書庫の生バイト列がplayBytes()(MMLデコード経路)へ渡らない',
  pmdCheck.ok, pmdCheck.reason);
check('(d) html/mucom-app.js openMmlFile(): 単体ファイル分岐は従来どおりresolved.bytesをapplyMmlBytes()へ渡す',
  mucomOpenBody !== null && /applyMmlBytes\(resolved\.bytes/.test(mucomOpenBody));
check('(d) html/pmd-app.js openPmdFile(): 単体ファイル分岐は従来どおりresolved.bytesをplayBytes()へ渡す',
  pmdOpenBody !== null && /playBytes\(resolved\.bytes/.test(pmdOpenBody));

// 陽性対照: このチェック自体が実際に機能することを、修正前と同じ「書庫分岐が無く常に
// resolved.bytesをデコードする」壊れた実装を模した合成ソースに対して実行し、FAILする
// ことを確認する(実ファイルは一切書き換えない。checkerの検出力そのものの検証)。
const brokenOpenMmlFile = `
  async function openMmlFile(file) {
    if (!file) return;
    let resolved;
    try {
      resolved = await resolveSongFromFile(file);
    } catch (err) {
      setNetStatus(describeNetError(err), true);
      return;
    }
    clearLoadedUrlFromAddressBar();
    // 修正前の不具合を再現: 書庫かどうかを判定せず、常に生バイト列をMMLとしてデコードする。
    applyMmlBytes(resolved.bytes, { name: resolved.fileName });
    compileAndPlay();
  }
`;
const brokenResult = archiveBranchNeverDecodesRawBytes(brokenOpenMmlFile);
check('[陽性対照] 修正前を模した壊れた実装(書庫分岐が無く常にresolved.bytesをデコード)ではこの検査は実際にFAILする',
  brokenResult.ok === false, brokenResult.reason);

console.log(`\n${failed === 0 ? '全項目 PASS' : `${failed} 件 FAIL`}`);
process.exit(failed === 0 ? 0 : 1);
