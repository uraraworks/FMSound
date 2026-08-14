#!/usr/bin/env node
// html/net-load.js(net/を実際のUIへ配線する層)の統合検証。
//
// 実HTTPサーバー(127.0.0.1のループバック)を立てて、resolveSongFromUrl()に本物の
// fetch()を通させる(net/fetch.jsを含む一連の経路を素通りさせない)。dist/(build_dist.sh
// で組み立てた実配布物)側のモジュールを検証対象にする理由: html/net-load.js の
// import 相対パス(./net/...)は dist/ に組み立てられて初めて解決できる構成
// (html/*.js から見て fmdsp/ui/compiler/net が兄弟ディレクトリになるのは dist/ の中だけ)
// のため、ここで検証するのは実際に配布されるファイル一式そのもの。
//
// 検証内容:
//   (a) 単体ファイル(.muc、CP932/UTF-8混在)を取得してresolveSongFromUrl()の
//       kind==='single'を確認し、net/charset.jsで文字コードが正しく判定できることを確認する。
//   (b) ZIP書庫(実際に`zip`コマンドで作成)を取得してkind==='archive'、
//       findSongCandidates()相当の結果(candidates)が意図通りであることを確認する。
//       - MUCOM88の拡張子(.muc)は素直に検出される
//       - 実物の検証材料と同じ「.mml拡張子だが中身が#mucom88ヘッダ」のケースも
//         content-sniffで検出される(net/song-select.js looksLikeMucomHeader)
//       - 陽性対照: #mucom88ヘッダの無い.mmlファイルは検出されない(=中身を見た
//         判定が実際に効いていることの確認。すべて検出できてしまう壊れた実装だと
//         このケースがFAILする)
//       - 複数候補(.muc + .mが同居)を書庫に入れたケースでcandidates.length===2に
//         なることを確認する(一覧から選ばせる元データが正しいことの確認)
//   (c) 取得失敗(存在しないパス)時にエラーメッセージが返ることを確認する。
//
// 実行: node tools/verify_net_url_load.mjs (事前に tools/build_dist.sh が必要)

import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_NET_LOAD = path.join(REPO_ROOT, 'dist', 'net-load.js');
const DIST_CHARSET = path.join(REPO_ROOT, 'dist', 'net', 'charset.js');

let failed = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failed++;
  console.log(`[${mark}] ${label}${detail !== undefined ? ' - ' + detail : ''}`);
}

if (!existsSync(DIST_NET_LOAD)) {
  console.error(`FATAL: ${DIST_NET_LOAD} が無い。先に tools/build_dist.sh を実行すること。`);
  process.exit(1);
}

const { resolveSongFromUrl } = await import(DIST_NET_LOAD);
const { decodeMmlBytes } = await import(DIST_CHARSET);
const { encodeCp932 } = await import(path.join(REPO_ROOT, 'ui', 'cp932-encode.js'));

const workDir = mkdtempSync(path.join(tmpdir(), 'fmsound-net-url-load-'));
console.log(`作業ディレクトリ: ${workDir}`);

// --- テスト用ファイルを用意 ------------------------------------------------------

const utf8Text = '#mucom88 1.5\n#title UTF8テスト\nA C120 o5 l4 v10 cdefg\n';
writeFileSync(path.join(workDir, 'song_utf8.muc'), utf8Text, 'utf8');

const { bytes: cp932Bytes } = encodeCp932('#mucom88 1.5\n#title CP932テスト\nA C120 o5 l4 v10 cdefg\n');
writeFileSync(path.join(workDir, 'song_cp932.muc'), cp932Bytes);

// ZIP書庫を組み立てる(macOSの`zip`コマンド、verify_net_archive.mjsと同じ作法)。
const archiveSrcDir = path.join(workDir, 'archive-src');
execFileSync('mkdir', ['-p', archiveSrcDir]);
const archiveFiles = {
  'song.muc': '#mucom88 1.5\nA C120 o5 l4 v10 cdefg\n', // 拡張子で素直に検出されるはず
  // 実物の検証材料(利用者提供zip)と同じ「.mml拡張子だが中身は#mucom88ヘッダ」のケース。
  'renamed.mml': '#mucom88 1.5\n#title 拡張子はmmlだが中身はmucom\nA C120 o5 l4 v10 cdefg\n',
  // 陽性対照: 同じ.mml拡張子でも#mucom88ヘッダが無いものは検出されないはず。
  'not_mucom.mml': '; これはMUCOM88ヘッダを持たないテキストファイル\nhello\n',
  'song2.m': '\x01\x02\x03PMDバイナリのふり\x00', // PMD側(拡張子.m)の検出確認用(ダミーバイナリ)
};
for (const [name, content] of Object.entries(archiveFiles)) {
  writeFileSync(path.join(archiveSrcDir, name), content, 'utf8');
}
const zipPath = path.join(workDir, 'multi.zip');
execFileSync('zip', ['-9', '-j', zipPath, ...Object.keys(archiveFiles).map((n) => path.join(archiveSrcDir, n))]);

// --- ローカルHTTPサーバーを起動 --------------------------------------------------

const server = http.createServer((req, res) => {
  const filePath = path.join(workDir, decodeURIComponent(req.url.split('?')[0]));
  if (!filePath.startsWith(workDir) || !existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'application/octet-stream' });
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/octet-stream' });
  res.end(readFileSync(filePath));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

try {
  // --- (a) 単体ファイル ---------------------------------------------------------

  const resUtf8 = await resolveSongFromUrl(`${base}/song_utf8.muc`);
  check('(a) UTF-8 .muc: kind===single', resUtf8.kind === 'single', `kind=${resUtf8.kind}`);
  const decUtf8 = decodeMmlBytes(resUtf8.bytes);
  check('(a) UTF-8 .muc: 文字コード判定がutf-8', decUtf8.encoding === 'utf-8', `encoding=${decUtf8.encoding}`);
  check('(a) UTF-8 .muc: デコード結果が元テキストと一致', decUtf8.text === utf8Text);

  const resCp932 = await resolveSongFromUrl(`${base}/song_cp932.muc`);
  const decCp932 = decodeMmlBytes(resCp932.bytes);
  check('(a) CP932 .muc: 文字コード判定がshift_jis', decCp932.encoding === 'shift_jis', `encoding=${decCp932.encoding}`);
  check('(a) CP932 .muc: デコード結果に日本語タイトルが含まれる', decCp932.text.includes('CP932テスト'));

  // --- (b) ZIP書庫 ---------------------------------------------------------------

  const resZip = await resolveSongFromUrl(`${base}/multi.zip`);
  check('(b) ZIP書庫: kind===archive', resZip.kind === 'archive', `kind=${resZip.kind}`);

  const names = resZip.candidates.map((c) => c.entry.name).sort();
  check('(b) song.muc(拡張子で素直に検出)が候補に含まれる', names.includes('song.muc'), names.join(','));
  check('(b) renamed.mml(#mucom88ヘッダのcontent-sniffで検出)が候補に含まれる',
    names.includes('renamed.mml'), names.join(','));
  check('[陽性対照] not_mucom.mml(#mucom88ヘッダ無し)は候補に含まれない(中身を見た判定が効いている証拠)',
    !names.includes('not_mucom.mml'), names.join(','));
  check('(b) song2.m(PMD拡張子)がpmdドライバとして検出される',
    resZip.candidates.some((c) => c.entry.name === 'song2.m' && c.driver === 'pmd'));
  check('(b) mucom候補が2件(song.muc・renamed.mml)、pmd候補が1件(song2.m)、合計3件',
    resZip.candidates.length === 3 &&
    resZip.candidates.filter((c) => c.driver === 'mucom').length === 2 &&
    resZip.candidates.filter((c) => c.driver === 'pmd').length === 1,
    `total=${resZip.candidates.length}`);

  // --- (c) 取得失敗 -----------------------------------------------------------

  let threw = false;
  try {
    await resolveSongFromUrl(`${base}/does-not-exist.muc`);
  } catch (err) {
    threw = true;
    check('(c) 存在しないURLはエラーになり、HTTPステータスがメッセージに含まれる',
      /404/.test(String(err && err.message)), String(err && err.message));
  }
  check('(c) 存在しないURLは例外を投げる', threw);
} finally {
  server.close();
  rmSync(workDir, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? '全項目 PASS' : `${failed} 件 FAIL`}`);
process.exit(failed === 0 ? 0 : 1);
