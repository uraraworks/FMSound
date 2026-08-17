#!/usr/bin/env node
// net/fetch.js の rewriteDropboxUrl() と、Dropboxを直接取得側(skipDirectから除外)へ
// 回す配線ロジックを検証するスクリプト。
//
// 実測(ブラウザのfetchで確認済み、再調査不要):
//   https://www.dropbox.com/scl/fi/.../file.zip?rlkey=...&dl=0 は www.dropbox.com のままだと
//   dl=0/dl=1いずれもCORSで失敗するが、ホストを dl.dropboxusercontent.com に置換すると
//   パス・クエリそのままで200・CORS通過する(curl/Node fetchはCORSを強制しないため
//   この判定はブラウザでしか測れず、ここでは実測結果を前提としたロジック検証のみ行う)。
//
// このスクリプトはネットワークへ出ない。global.fetch を差し替えて、
// 「どのURLへ・何回・どの順でfetchが呼ばれたか」だけを見る。
//
// 実行: node tools/verify_net_dropbox_rewrite.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'net', 'config.js');

let failed = 0;
function check(label, cond) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failed++;
  console.log(`[${mark}] ${label}`);
}

// --- 1. rewriteDropboxUrl() 単体(純関数): 中継設定に依存しないので既定のconfig.jsのまま import --------

const { rewriteDropboxUrl } = await import('../net/fetch.js');

const DROPBOX_TEST_URL = 'https://www.dropbox.com/scl/fi/m7r349wurx7tb87ymwvd9/PMD_MS_sample.zip?rlkey=abcDEF123xyz&dl=0';
const DROPBOX_BARE_HOST_URL = 'https://dropbox.com/scl/fi/abc123/other.zip?rlkey=zzz999&dl=1';

/** ホストが dl.dropboxusercontent.com に置換され、パス・クエリが完全に保持されているかを判定する。 */
function hostReplacedPathQueryKept(rewriteFn, url) {
  const before = new URL(url);
  const after = new URL(rewriteFn(url));
  return (
    after.hostname === 'dl.dropboxusercontent.com' &&
    after.pathname === before.pathname &&
    after.search === before.search
  );
}

check(
  'www.dropbox.com -> dl.dropboxusercontent.com に置換され、パス/rlkeyを含むクエリが保持される(dl=0)',
  hostReplacedPathQueryKept(rewriteDropboxUrl, DROPBOX_TEST_URL)
);
check(
  'dropbox.com(wwwなし) -> dl.dropboxusercontent.com に置換され、パス/クエリが保持される(dl=1のまま書き換えない)',
  hostReplacedPathQueryKept(rewriteDropboxUrl, DROPBOX_BARE_HOST_URL)
);

// クエリを勝手に書き換えていないこと(dl=0のままであること)を明示的に確認する。
{
  const after = new URL(rewriteDropboxUrl(DROPBOX_TEST_URL));
  check('dl=0はdl=1へ書き換えられずそのまま保持される', after.searchParams.get('dl') === '0');
}
{
  const after = new URL(rewriteDropboxUrl(DROPBOX_BARE_HOST_URL));
  check('dl=1もそのまま保持される(勝手に書き換えない)', after.searchParams.get('dl') === '1');
}

// 冪等性: 既に dl.dropboxusercontent.com のURLを渡しても変化しない。
{
  const already = 'https://dl.dropboxusercontent.com/scl/fi/m7r349wurx7tb87ymwvd9/PMD_MS_sample.zip?rlkey=abcDEF123xyz&dl=0';
  check('dl.dropboxusercontent.comのURLは冪等(渡しても変化しない)', rewriteDropboxUrl(already) === already);
}

// 非Dropboxホストは一切変更されないこと。
const UNTOUCHED_URLS = [
  'https://raw.githubusercontent.com/uraraworks/WebNP2/master/package.json',
  'https://drive.google.com/file/d/FAKEID0000000000000000000000/view?usp=sharing',
  'https://example.com/song.zip?token=xyz',
];
for (const url of UNTOUCHED_URLS) {
  check(`非Dropboxホストは変更されない: ${new URL(url).hostname}`, rewriteDropboxUrl(url) === url);
}

// --- 2. 陽性対照: 「置換されないという症状」で上のチェックが実際にFAILすることを確認する ------
//    (「変えたら変わる」ではなく、置換ロジックを無効化した場合に上と同じ判定関数が
//     ちゃんとFAILを検出できることを確認する。identityUrlは置換前の挙動相当。)
{
  const identityUrl = (u) => u; // 意図的に「置換しない」実装(置換前の挙動を模す)
  const controlDetectsFailure = hostReplacedPathQueryKept(identityUrl, DROPBOX_TEST_URL) === false;
  check(
    '陽性対照: 置換を無効化(identity)すると「ホストが置換される」判定が症状どおりFAILする',
    controlDetectsFailure
  );
}

// --- 3. skipDirect配線: Dropboxは直接取得を試す側、Google Driveは中継側のまま ------------------
//    (中継設定ありの前提が必要。net/fetch.jsは './config.js' を相対importしており、
//     同一プロセス内でクエリ文字列を変えて再importしてもNode ESMのモジュールキャッシュは
//     入れ子のconfig.js importまでは剥がしてくれない(実測: 再import後もNET_PROXY_BASEが
//     旧値のままだった)。そのため中継設定を反映した状態で確実に検証するには、config.jsを
//     書き換えたうえで別プロセス(node子プロセス)を起動しそちらでimportし直す必要がある。
//     子プロセス内でglobal.fetchを差し替えて記録するだけなので、ここでもネットワークへは
//     出ない。config.jsは.gitignore対象の生成物であり、テスト後に元の内容へ復元する。)

const originalConfig = readFileSync(CONFIG_PATH, 'utf8');
const FAKE_PROXY = 'https://proxy.example.invalid';

function writeConfig(proxyBase) {
  writeFileSync(
    CONFIG_PATH,
    `// verify_net_dropbox_rewrite.mjs が一時生成(テスト後に復元される)。\nexport const NET_PROXY_BASE = ${JSON.stringify(proxyBase)};\n`,
    'utf8'
  );
}

// 子プロセス側で実行するスクリプト。global.fetchを記録用スタブに差し替えたうえで
// Dropbox/Google Driveそれぞれの共有リンクをfetchSongBytesへ渡し、実際にfetch()が
// 呼ばれたURL列をJSONでstdoutへ出す(ネットワークには一切出ない)。
const CHILD_SCRIPT = `
import { fetchSongBytes } from '../net/fetch.js';

function fakeSuccessResponse() {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name === 'content-type' ? 'application/zip' : null) },
    body: null,
    arrayBuffer: async () => new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer,
  };
}

async function callsFor(url) {
  const calls = [];
  global.fetch = async (u) => {
    calls.push(String(u));
    return fakeSuccessResponse();
  };
  await fetchSongBytes(url);
  return calls;
}

const dropboxCalls = await callsFor(${JSON.stringify(DROPBOX_TEST_URL)});
const driveCalls = await callsFor('https://drive.google.com/file/d/FAKEID0000000000000000000000/view?usp=sharing');
process.stdout.write(JSON.stringify({ dropboxCalls, driveCalls }));
`;

try {
  writeConfig(FAKE_PROXY);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT], {
    cwd: __dirname,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.status !== 0) {
    check('子プロセスでの配線確認スクリプトが正常終了する', false);
    console.error(result.stderr);
  } else {
    const { dropboxCalls, driveCalls } = JSON.parse(result.stdout);
    check(
      'Dropbox共有リンク: 中継設定ありでも最初に直接fetchを試す(中継URLではない)',
      dropboxCalls.length === 1 && !dropboxCalls[0].startsWith(FAKE_PROXY)
    );
    check(
      'Dropbox共有リンク: 直接fetchのURLホストが dl.dropboxusercontent.com に置換されている',
      dropboxCalls[0]?.startsWith('https://dl.dropboxusercontent.com/')
    );
    check(
      'Google Drive共有リンク: 中継設定ありでは直接fetchを試さず、最初から中継URLを叩く(skipDirect維持)',
      driveCalls.length === 1 && driveCalls[0].startsWith(`${FAKE_PROXY}/fetch?url=`)
    );
  }
} finally {
  writeFileSync(CONFIG_PATH, originalConfig, 'utf8');
  check('net/config.js を元の内容へ復元した', readFileSync(CONFIG_PATH, 'utf8') === originalConfig);
}

console.log('---');
if (failed > 0) {
  console.error(`${failed} 件 FAIL`);
  process.exit(1);
} else {
  console.log('全項目 PASS');
}
