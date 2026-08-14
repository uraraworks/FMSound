#!/usr/bin/env node
// net/fetch.js の fetchSongBytes() を検証するスクリプト。
//
// 実ネットワークでの確認について(正直に切り分けること):
//   - GitHub raw / jsDelivr は「取得できる」ことが実測で分かっている
//     (WebNP2 disk-fetch.tsの実運用実績)ので、実際にfetchして確認する。
//     ネットワークが使えない環境では該当項目をSKIPし、その旨を明記する。
//   - Google Drive / Dropbox / OneDrive は、実物の共有リンクが1本無いと本当の確認が
//     できない(自前のHTTPサーバ相手だと全部通ってしまい、本番で破綻した実績がある)。
//     よってここでは「ホスト判定ロジックがそう書かれていること」の確認のみ行い、
//     実リンクでの検証は未実施として明記する。取れたふりはしない。
//
// 実行: node tools/verify_net_fetch.mjs

import { fetchSongBytes, looksLikeHtml, NET_PROXY_BASE } from '../net/fetch.js';

let failed = 0;
let skipped = 0;
function check(label, cond) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failed++;
  console.log(`[${mark}] ${label}`);
}
function skip(label, reason) {
  skipped++;
  console.log(`[SKIP] ${label} (${reason})`);
}

check('NET_PROXY_BASE は既定で空文字(中継しない)', NET_PROXY_BASE === '');

// --- 実ネットワーク確認: GitHub raw / jsDelivr(取得できることが既知) --------------------

const REAL_TARGETS = [
  { label: 'GitHub raw (uraraworks/WebNP2 package.json)', url: 'https://raw.githubusercontent.com/uraraworks/WebNP2/master/package.json' },
  { label: 'jsDelivr (uraraworks/WebNP2 package.json)', url: 'https://cdn.jsdelivr.net/gh/uraraworks/WebNP2@master/package.json' },
];

for (const { label, url } of REAL_TARGETS) {
  try {
    const bytes = await fetchSongBytes(url);
    check(`実ネットワーク: ${label} を取得できる`, bytes.length > 0 && !looksLikeHtml(bytes));
  } catch (err) {
    // ネットワーク自体が使えない環境かどうかを軽く切り分ける(DNS解決失敗等はネットワーク不可の合図)。
    const msg = String(err && err.message);
    if (/ENOTFOUND|ECONNREFUSED|ネットワークエラー|fetch failed/i.test(msg)) {
      skip(`実ネットワーク: ${label}`, `ネットワークが使えない可能性: ${msg}`);
    } else {
      check(`実ネットワーク: ${label} を取得できる`, false);
      console.error(`  -> ${msg}`);
    }
  }
}

// --- ホスト判定ロジックの確認(実リンクなし。コードがそう書かれていることのみ確認) --------

console.log('--- Google Drive/Dropbox/OneDrive: ロジック確認のみ(実リンクでの検証は未実施) ---');

{
  // 中継未設定(既定)でOneDriveの共有リンクを渡すと、直接取得を試さず専用の案内で即例外になる
  // ことを確認する(実際にOneDriveへ到達できるかどうかは別問題であり、ここでは分岐ロジックのみ)。
  let threw = false;
  let message = '';
  try {
    await fetchSongBytes('https://1drv.ms/u/s!Abc123FakeIdNotReal');
  } catch (err) {
    threw = true;
    message = String(err && err.message);
  }
  check('OneDriveホストは直接fetchを試さず即座に専用エラーになる', threw && /OneDrive/.test(message));
}

{
  // 中継未設定(既定)でGoogle Driveの共有ページURLを渡すと、直接fetchしてもHTML閲覧ページが
  // 返るはず(disk-fetch.tsの実測どおりなら)なので、「直接取得できません」という案内になる
  // ことを期待する。ただしこれは実際にGoogleへ到達して確認するテストであり、
  // 「実リンクでの検証」に該当する。存在しないIDでも到達自体はできるため、ネットワークが
  // 使える環境であれば実行される。
  try {
    const bytes = await fetchSongBytes('https://drive.google.com/file/d/0000000000000000000000000000/view?usp=sharing');
    // ここに来た場合、HTMLではなく何らかのバイト列を取得できたことになる(通常は起きない想定)。
    check('Google Drive(存在しないID): HTMLではない何かが返った(想定外)', !looksLikeHtml(bytes));
    console.log('  -> 注意: これは実リンクでの検証ではない(存在しないIDのため、実際の共有ファイル取得は未確認)');
  } catch (err) {
    const msg = String(err && err.message);
    if (/ENOTFOUND|ECONNREFUSED|fetch failed/i.test(msg)) {
      skip('Google Drive(存在しないID)への到達確認', `ネットワークが使えない可能性: ${msg}`);
    } else {
      // HTML判定に引っかかって「直接取得できません」等のエラーになるのが期待される正常系。
      check('Google Drive(存在しないID): HTML誤取得を検出してエラーになる', /HTML|直接取得できません/.test(msg));
    }
  }
  console.log('  -> 【重要】実物のGoogle Drive/Dropbox共有リンクでの検証は未実施。存在しないIDでの' +
    '到達確認のみ(disk-fetch.ts側の実測知見をそのまま移植したというロジック上の確認に留まる)。');
}

console.log('---');
console.log(`SKIP: ${skipped} 件`);
if (failed > 0) {
  console.error(`${failed} 件 FAIL`);
  process.exit(1);
} else {
  console.log('全項目 PASS(SKIPを除く)');
}
