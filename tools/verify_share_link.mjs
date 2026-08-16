#!/usr/bin/env node
// 曲共有リンク(net/share-link.js、URLのフラグメント`#s1=...`)のエンコード/デコード検証。
//
// 検証対象は dist/(build_dist.sh で組み立てた実配布物)側のモジュール:
//   - dist/net/share-link.js (エンコード/デコード本体)
//   - dist/net-load.js (再export + shareLibraryFileName())
// html/net-load.js の import 相対パス(./net/...)は dist/ に組み立てられて初めて
// 解決できる構成(html/*.js から見て net/ が兄弟ディレクトリになるのは dist/ の中だけ)
// のため、tools/verify_net_url_load.mjs 等の既存検証と同じくdist/側を対象にする。
//
// Node実行環境の確認: CompressionStream/DecompressionStreamはNode 25でグローバルに
// 存在する(標準API、追加npm依存なし)ことを確認済み。net/share-link.js自体もこの
// 標準APIだけを使っており、ブラウザとNodeで同じ実装をそのまま検証できる
// (「検証側だけnode:zlibを使う」といった実装乖離は無い)。
//
// 実行: node tools/verify_share_link.mjs (事前に tools/build_dist.sh が必要)

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_SHARE_LINK = path.join(REPO_ROOT, 'dist', 'net', 'share-link.js');
const DIST_NET_LOAD = path.join(REPO_ROOT, 'dist', 'net-load.js');

let failed = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failed++;
  console.log(`[${mark}] ${label}${detail !== undefined ? ' - ' + detail : ''}`);
}

if (!existsSync(DIST_SHARE_LINK) || !existsSync(DIST_NET_LOAD)) {
  console.error(`FATAL: dist/ が無い。先に tools/build_dist.sh を実行すること。`);
  process.exit(1);
}

if (typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined') {
  console.error('FATAL: このNodeにCompressionStream/DecompressionStreamが無い(想定はNode 25+)。');
  process.exit(1);
}

const {
  encodeShareFragment, decodeShareFragment, buildShareUrl, shareLinkLengthStatus,
  SHARE_LINK_VERSION, SHARE_LINK_URL_LIMIT, MAX_DECOMPRESSED_BYTES,
} = await import(DIST_SHARE_LINK);
const { shareLibraryFileName } = await import(DIST_NET_LOAD);

console.log('=== tools/verify_share_link.mjs: 曲共有リンク(net/share-link.js)の検証 ===\n');

// --- 1. 往復で1文字も変わらないこと ---------------------------------------------------

async function roundTrip(text) {
  const fragment = await encodeShareFragment(text);
  const bytes = await decodeShareFragment(`#${fragment}`);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

const roundTripCases = {
  'ASCIIのみのMML': '#title Test Song\nT120 L\nA o4 l4 c d e f g a b <c\n',
  '日本語コメントを含むMML(#title等)': '#title エリーゼのために(WoO 59)\n#composer ベートーヴェン\n; 原曲はパブリックドメイン\nA T60 @78 v12 L\n',
  '半角カナを含むMML(音色名参照)': 'A @"ｿｳﾙﾍﾞ" v10 o5 l8 cdefg\n; ﾃｽﾄ用の半角ｶﾅｺﾒﾝﾄ\n',
  '改行がCRLFのもの': '#title CRLF Test\r\nT120 L\r\nA o4 l4 cdefgab<c\r\n',
};

for (const [label, text] of Object.entries(roundTripCases)) {
  const back = await roundTrip(text);
  check(`1. 往復一致: ${label}`, back === text, back === text ? undefined : `expected=${JSON.stringify(text)} actual=${JSON.stringify(back)}`);
}

const sampleFiles = {
  'html/sample_fur_elise_mucom.muc': path.join(REPO_ROOT, 'html', 'sample_fur_elise_mucom.muc'),
  'html/sample_fur_elise.mml': path.join(REPO_ROOT, 'html', 'sample_fur_elise.mml'),
};
/** @type {Record<string, { text: string, url: string, length: number }>} */
const sampleResults = {};
for (const [label, filePath] of Object.entries(sampleFiles)) {
  const text = readFileSync(filePath, 'utf-8');
  const back = await roundTrip(text);
  check(`1. 往復一致(実データ): ${label}`, back === text);
  const driver = label.includes('mucom') ? 'mucom' : 'pmd';
  const built = await buildShareUrl({ mmlText: text, driver, baseHref: 'https://uraraworks.github.io/FMSound/' });
  sampleResults[label] = { text, url: built.url, length: built.length };
}

// --- 2. ?driver= が生成URLに含まれ、往復後も保たれること ------------------------------

for (const driver of ['mucom', 'pmd']) {
  const built = await buildShareUrl({
    mmlText: '#title driver check\nA T120 L cdefg\n',
    driver,
    baseHref: 'https://uraraworks.github.io/FMSound/',
  });
  const url = new URL(built.url);
  check(`2. 生成URLに?driver=${driver}が含まれる`, url.searchParams.get('driver') === driver, built.url);
  // 「往復後」= このURLをもう一度パースしても?driver=が保たれていること
  // (アドレスバー往復に相当。history.replaceState等ブラウザ専用APIは使わずURL自体の
  // 安定性を見る)。
  const reparsed = new URL(url.toString());
  check(`2. ?driver=${driver}が往復後も保たれる`, reparsed.searchParams.get('driver') === driver);
}

// --- 3. 上限判定(4,000字) --------------------------------------------------------------

check('3. shareLinkLengthStatus(4000).overLimit === false(4,000字ちょうどは通る)',
  shareLinkLengthStatus(4000).overLimit === false, JSON.stringify(shareLinkLengthStatus(4000)));
check('3. shareLinkLengthStatus(3999).overLimit === false',
  shareLinkLengthStatus(3999).overLimit === false);
check('3. shareLinkLengthStatus(4001).overLimit === true(超過)',
  shareLinkLengthStatus(4001).overLimit === true);
check('3. shareLinkLengthStatus(4001).overBy === 1(超過した字数が取得できる)',
  shareLinkLengthStatus(4001).overBy === 1, String(shareLinkLengthStatus(4001).overBy));
check('3. shareLinkLengthStatus(4090).overBy === 90',
  shareLinkLengthStatus(4090).overBy === 90, String(shareLinkLengthStatus(4090).overBy));
check('3. SHARE_LINK_URL_LIMIT === 4000', SHARE_LINK_URL_LIMIT === 4000, String(SHARE_LINK_URL_LIMIT));

// 実際にbuildShareUrl()が組み立てた長い曲でも、status.length/overLimitが実URLの
// 長さと矛盾しないことを確認する(算出ロジックが実データでも整合していることの確認)。
for (const [label, { url, length }] of Object.entries(sampleResults)) {
  const status = shareLinkLengthStatus(length);
  check(`3. ${label}: buildShareUrl().length と shareLinkLengthStatus().length が一致`,
    status.length === url.length, `length=${length} url.length=${url.length}`);
}

// --- 4. バージョン: #s1=は読める。#s2=(未知)はエラー -----------------------------------

{
  const fragment = await encodeShareFragment('#title version check\nA cdefg\n');
  check(`4. #${SHARE_LINK_VERSION}=は正常に読める(現行バージョン)`, SHARE_LINK_VERSION === 's1');
  const bytes = await decodeShareFragment(`#${fragment}`);
  check('4. 現行バージョンのフラグメントはbytesを返す(nullでもエラーでもない)', bytes instanceof Uint8Array);
}
{
  const fragment = await encodeShareFragment('#title s2 check\nA cdefg\n');
  const unknownFragment = fragment.replace(/^s1=/, 's2=');
  let threw = false;
  let code = null;
  try {
    await decodeShareFragment(`#${unknownFragment}`);
  } catch (err) {
    threw = true;
    code = err && err.code;
  }
  check('4. #s2=(未知バージョン)はエラーとして扱われる', threw, code);
  check('4. #s2=のエラーコードはshare.unknownVersion', code === 'share.unknownVersion', code);
  // 「エディタに何も入らない」ことの保証は、html/mucom-app.js・html/pmd-app.js側の
  // loadSongFromShareFragment()がこの例外をキャッチしてtrueを返さず(=applyMmlBytes()/
  // mmlTextarea.valueへの代入コードへ到達せず)falseで抜ける構造でコード上保証している
  // (この検証スクリプトはDOM非依存のNode環境のため、実際のエディタDOMを持たない。
  // 該当箇所は html/mucom-app.js loadSongFromShareFragment()・
  // html/pmd-app.js loadSongFromShareFragment() の try/catch を参照)。
}

// --- 5. 壊れたデータ(base64として不正/gzipとして不正) --------------------------------

{
  let threw = false, code = null;
  try {
    await decodeShareFragment(`#${SHARE_LINK_VERSION}=!!!not-valid-base64url!!!`);
  } catch (err) {
    threw = true; code = err && err.code;
  }
  check('5. base64として不正なペイロードはエラーになる', threw, code);
  check('5. エラーコードはshare.invalidBase64', code === 'share.invalidBase64', code);
}
{
  // 正しいbase64urlだが、中身はgzipではない("hello world"の生バイト列)。
  const notGzip = Buffer.from('hello world', 'utf-8').toString('base64url');
  let threw = false, code = null;
  try {
    await decodeShareFragment(`#${SHARE_LINK_VERSION}=${notGzip}`);
  } catch (err) {
    threw = true; code = err && err.code;
  }
  check('5. gzipとして不正なペイロードはエラーになる', threw, code);
  check('5. エラーコードはshare.invalidGzip', code === 'share.invalidGzip', code);
}
{
  // `=`が無い(バージョン区切りが無い)フラグメントもエラーになることの確認
  // (net/share-link.js decodeShareFragment()のshare.malformed分岐)。
  let threw = false, code = null;
  try {
    await decodeShareFragment('#garbage-no-equals-sign');
  } catch (err) {
    threw = true; code = err && err.code;
  }
  check('5. `=`の無い壊れたフラグメントもエラーになる(share.malformed)', threw && code === 'share.malformed', code);
}

// --- 6. 展開後サイズの上限が効くこと ----------------------------------------------------

{
  // gzipは繰り返しパターンに極端に強く圧縮できるため、MAX_DECOMPRESSED_BYTESの2倍の
  // 同一文字列(圧縮後は数KB程度)を使って「上限超過だが共有リンクの4,000字上限には
  // 収まってしまうデータ」を作る(=悪意ある圧縮データの典型的な形)。
  const bomb = 'A'.repeat(MAX_DECOMPRESSED_BYTES * 2);
  const fragment = await encodeShareFragment(bomb);
  check('6. 展開爆弾フラグメント自体は4,000字上限に収まる(圧縮が効いていることの確認)',
    (`${fragment}`.length + 1) <= SHARE_LINK_URL_LIMIT, `fragment.length=${fragment.length}`);
  let threw = false, code = null, params = null;
  try {
    await decodeShareFragment(`#${fragment}`);
  } catch (err) {
    threw = true; code = err && err.code; params = err && err.params;
  }
  check('6. 展開後サイズが上限を超えると中止される', threw, code);
  check('6. エラーコードはshare.decodedTooLarge', code === 'share.decodedTooLarge', code);
  check('6. 上限値(MAX_DECOMPRESSED_BYTES)がエラーparamsに含まれる',
    params && params.limit === MAX_DECOMPRESSED_BYTES, JSON.stringify(params));
}

// --- shareLibraryFileName(): 同じ内容は同じファイル名、違う内容は違うファイル名になる ---
// (net-load.js shareLibraryFileName()コメント参照: 同じ共有リンクを何度開いても
// ライブラリで重複が増えず、違う内容の共有曲は別idになることの確認)。
{
  const bytesA = new TextEncoder().encode('song A');
  const bytesB = new TextEncoder().encode('song B');
  const nameA1 = shareLibraryFileName(bytesA);
  const nameA2 = shareLibraryFileName(bytesA);
  const nameB = shareLibraryFileName(bytesB);
  check('shareLibraryFileName(): 同じ内容は同じファイル名になる', nameA1 === nameA2, `${nameA1} / ${nameA2}`);
  check('shareLibraryFileName(): 違う内容は違うファイル名になる', nameA1 !== nameB, `${nameA1} / ${nameB}`);
}

// --- 空フラグメント(共有リンクではない通常のアクセス) -> null ---------------------------
{
  const none1 = await decodeShareFragment('');
  const none2 = await decodeShareFragment('#');
  check('空のフラグメントはnullを返す(通常のアクセス、エラーにはしない)', none1 === null && none2 === null);
}

console.log(`\n${failed === 0 ? '全項目 PASS' : `${failed} 件 FAIL`}`);
if (failed === 0) {
  console.log('\n--- 参考情報(報告用) ---');
  for (const [label, { length }] of Object.entries(sampleResults)) {
    console.log(`  ${label}: 生成された共有URLの全長 = ${length}字`);
  }
}
process.exit(failed === 0 ? 0 : 1);
