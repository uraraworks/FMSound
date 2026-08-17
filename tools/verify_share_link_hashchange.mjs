#!/usr/bin/env node
// 実機報告(2026-08-17): 「新規作成している状態で、共有リンクをアドレスバーに貼り付けると
// 読み込まれない(新しいタブに貼れば読める)」不具合の検証。
//
// 原因: 同じタブでアドレスバーの`#`以降だけを書き換えてもページは再読み込みされない
// (`hashchange`が飛ぶだけの同一文書内の移動)。従来の実装は`#s1=`を起動時にしか
// 読んでいなかったため、貼り付けても何も起きなかった(html/net-load.js
// watchShareFragmentHashChange()コメント参照)。
//
// 「hashchangeはブラウザの挙動でNode上では再現しにくいかもしれない」という前提で
// 着手したが、実際には`window.addEventListener('hashchange', fn)`/`fn()`呼び出し
// そのものはブラウザ固有のAPIではなく、最小限のEventTarget的スタブ(このファイル
// 内のmakeEnv())で足りることが分かった。よって本検証はNode上で
// watchShareFragmentHashChange()の実装(dist/net-load.js、html/net-load.jsの
// ビルド後コピー)を実際に呼び出して確認する(再現できなかった、という結論では
// なかった)。
//
// 検証内容:
//   1. 有効な#s1=へのフラグメント変更でloadが呼ばれること。
//   2. clearShareFragmentFromAddressBar()(history.replaceState()でフラグメントを
//      消す)の後にhashchangeが発火しても(history.replaceState()は仕様上
//      hashchangeを発火させないはずだが、念のため最悪ケースとして手動でも発火させて
//      確認する)、loadが呼ばれないこと。
//      [陽性対照] 同じ発火に対して「常に呼ぶ」素朴な実装なら実際にloadが呼ばれる
//      ことを先に確認し、検出器(というよりガード)が意味のある状況を防いでいる
//      ことを示す。
//   3. 同じ#s1=が再度セットされても(重複貼り付け相当)、不要な再読み込みをしない
//      こと(dedup)。
//   4. 未コンパイルの編集がある(isDirty()===true)ときは確認を挟み、拒否したら
//      loadを呼ばないこと/承諾したら呼ぶこと。
//   5. 壊れたデータ・未知バージョンの検出自体(net/share-link.js decodeShareFragment())
//      は tools/verify_share_link.mjs が担当する(このファイルでは、そのケースでも
//      「起動時と同じ関数(loadに渡した関数)が呼ばれること」=フォールバックせず
//      決め打ちで無視しないことだけを確認する)。
//
// 実行: node tools/verify_share_link_hashchange.mjs (事前に tools/build_dist.sh が必要)

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_NET_LOAD = path.join(REPO_ROOT, 'dist', 'net-load.js');

let failed = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failed++;
  console.log(`[${mark}] ${label}${detail !== undefined ? ' - ' + detail : ''}`);
}

if (!existsSync(DIST_NET_LOAD)) {
  console.error('FATAL: dist/ が無い。先に tools/build_dist.sh を実行すること。');
  process.exit(1);
}

// --- 最小限のwindow/location/historyスタブ -------------------------------------------
//
// history.replaceState()は「URL(とhash)を書き換えるが、hashchange/popstateは
// 発火させない」という実仕様どおりに実装する(MDN: pushState/replaceStateは
// hashchangeを起こさない)。これにより「clearShareFragmentFromAddressBar()自体が
// hashchangeを起こすことは無いはず」という前提を、スタブの実装レベルでも裏付ける。
// その上で検証2では「万一発火した場合」を想定した最悪ケースも別途手動で確認する。
function makeEnv(initialHash) {
  const listeners = {};
  const win = {
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    _dispatch(type) { for (const fn of (listeners[type] ?? [])) fn(); },
    confirm: () => true, // 各テストで上書きする
  };
  const loc = { hash: initialHash, href: `https://example.com/${initialHash}` };
  const hist = {
    replaceState(_state, _title, url) {
      loc.href = url;
      const i = url.indexOf('#');
      loc.hash = i >= 0 ? url.slice(i) : '';
      // 意図的にhashchangeを発火させない(history.replaceState()の実仕様どおり。
      // 上のコメント参照)。
    },
  };
  return { win, loc, hist };
}

function activate(env) {
  globalThis.window = env.win;
  globalThis.location = env.loc;
  globalThis.history = env.hist;
}

console.log('=== tools/verify_share_link_hashchange.mjs: 共有リンクの同タブ貼り付け読み込み検証 ===\n');

// dynamic importは最初のactivate()より後でも先でも良い(関数本体は呼び出し時に
// bare identifierのwindow/location/historyを見るため)。
const env0 = makeEnv('');
activate(env0);
const { watchShareFragmentHashChange, clearShareFragmentFromAddressBar } = await import(DIST_NET_LOAD);

// --- 1. 有効な#s1=へのフラグメント変更で読み込まれること -------------------------------
{
  const env = makeEnv(''); // 起動時は共有リンク無し、という状態を模す
  activate(env);
  const calls = [];
  watchShareFragmentHashChange({ isDirty: () => false, load: () => { calls.push('load'); return Promise.resolve(true); } });

  env.loc.hash = '#s1=abcXYZ';
  env.win._dispatch('hashchange');

  check('1. 有効な#s1=への変更でloadが1回呼ばれる', calls.length === 1, `calls=${JSON.stringify(calls)}`);
}

// --- 2. clearShareFragmentFromAddressBar()による消去では読み込みが発火しないこと ---------
{
  const env = makeEnv('#s1=old');
  activate(env);
  const calls = [];
  watchShareFragmentHashChange({ isDirty: () => false, load: () => { calls.push('load'); return Promise.resolve(true); } });

  clearShareFragmentFromAddressBar();
  check('2-a. clearShareFragmentFromAddressBar()自体はhashchangeを起こさない(スタブのhistory.replaceState()実装どおり)',
    env.loc.hash === '', `hash=${JSON.stringify(env.loc.hash)}`);

  // 最悪ケース: 万一hashchangeが発火してしまった場合でも、空フラグメントは
  // 「共有リンクではない」として無視すること(watchShareFragmentHashChange()コメントの
  // (a)参照)。
  env.win._dispatch('hashchange');
  check('2-b. [本題] 消去後に(万一)hashchangeが発火してもloadは呼ばれない',
    calls.length === 0, `calls=${JSON.stringify(calls)}`);
}

// --- 2. 陽性対照: 「常に読み込む」素朴な実装なら、同じ発火で実際にloadが呼ばれること -----
{
  const env = makeEnv('#s1=old');
  activate(env);
  const calls = [];
  // watchShareFragmentHashChange()を使わず、素朴な(ガード無しの)実装を直接登録する。
  env.win.addEventListener('hashchange', () => calls.push('load'));

  clearShareFragmentFromAddressBar();
  env.win._dispatch('hashchange');
  check('2-c. [陽性対照] ガード無しの素朴な実装なら、同じ発火で実際にloadが呼ばれる(検証2-bが無意味な確認でない証拠)',
    calls.length === 1, `calls=${JSON.stringify(calls)}`);
}

// --- 3. 同じ#s1=が再度セットされても不要な読み直しをしないこと ---------------------------
{
  const env = makeEnv('#s1=same');
  activate(env);
  const calls = [];
  watchShareFragmentHashChange({ isDirty: () => false, load: () => { calls.push('load'); return Promise.resolve(true); } });

  // 「同じ値が再度セットされた」を模す(貼り付け直し等)。
  env.loc.hash = '#s1=same';
  env.win._dispatch('hashchange');
  check('3. 起動時と同じ#s1=の再セットではloadを呼ばない(重複読み込み防止。設計: dedup)',
    calls.length === 0, `calls=${JSON.stringify(calls)}`);

  // 続けて実際に違う値へ変わったときは、通常どおり呼ばれることも確認する
  // (dedupが「二度と呼ばれない」壊れ方をしていないことの確認)。
  env.loc.hash = '#s1=different';
  env.win._dispatch('hashchange');
  check('3-b. その後、別の#s1=に変わったときは通常どおりloadが呼ばれる',
    calls.length === 1, `calls=${JSON.stringify(calls)}`);
}

// --- 4. 未コンパイルの編集(isDirty()===true)があるときは確認を挟む -----------------------
{
  const env = makeEnv('');
  activate(env);
  const calls = [];
  let confirmAsked = 0;
  env.win.confirm = () => { confirmAsked++; return false; }; // 拒否
  watchShareFragmentHashChange({ isDirty: () => true, load: () => { calls.push('load'); return Promise.resolve(true); } });

  env.loc.hash = '#s1=dirtyTest';
  env.win._dispatch('hashchange');
  check('4-a. isDirty()===trueのとき確認ダイアログを出す', confirmAsked === 1);
  check('4-a. 確認を拒否(false)したらloadを呼ばない', calls.length === 0, `calls=${JSON.stringify(calls)}`);
}
{
  const env = makeEnv('');
  activate(env);
  const calls = [];
  env.win.confirm = () => true; // 承諾
  watchShareFragmentHashChange({ isDirty: () => true, load: () => { calls.push('load'); return Promise.resolve(true); } });

  env.loc.hash = '#s1=dirtyTest2';
  env.win._dispatch('hashchange');
  check('4-b. 確認を承諾(true)したらloadを呼ぶ', calls.length === 1, `calls=${JSON.stringify(calls)}`);
}
{
  // isDirty()===false(コンパイル済み/空の編集欄)のときは確認無しで即読み込む。
  const env = makeEnv('');
  activate(env);
  const calls = [];
  let confirmAsked = 0;
  env.win.confirm = () => { confirmAsked++; return true; };
  watchShareFragmentHashChange({ isDirty: () => false, load: () => { calls.push('load'); return Promise.resolve(true); } });

  env.loc.hash = '#s1=notDirty';
  env.win._dispatch('hashchange');
  check('4-c. isDirty()===falseのときは確認を出さずに読み込む',
    confirmAsked === 0 && calls.length === 1, `confirmAsked=${confirmAsked} calls=${JSON.stringify(calls)}`);
}

// --- 5. 壊れたデータ・未知バージョンでも、起動時と同じload関数を経由して処理されること -----
//     (エラー処理自体の中身はloadSongFromShareFragment()側=起動時と全く同じ関数を
//     そのまま渡す設計により保証される。tools/verify_share_link.mjsがdecodeShareFragment()
//     自体のエラー分類を検証済み)。
{
  const env = makeEnv('');
  activate(env);
  const seenHashes = [];
  // 呼び出し側(html/mucom-app.js・html/pmd-app.js)のloadSongFromShareFragment()を
  // 模したスタブ: 実装はdecodeShareFragment(location.hash)を呼ぶだけなので、
  // ここでは「その時点のlocation.hashを見て呼ばれたか」だけを確認する。
  watchShareFragmentHashChange({
    isDirty: () => false,
    load: () => { seenHashes.push(env.loc.hash); return Promise.resolve(false); },
  });

  env.loc.hash = '#s2=unknownVersion'; // 未知バージョン
  env.win._dispatch('hashchange');
  check('5. 未知バージョン(#s2=)でも起動時と同じload関数が(フォールバックせず)呼ばれる',
    seenHashes.length === 1 && seenHashes[0] === '#s2=unknownVersion', `seenHashes=${JSON.stringify(seenHashes)}`);
}

// --- 6. 参考: 既存のsrc(html/net-load.js)とdist(dist/net-load.js)でロジックが
//     ずれていないこと(ビルドで取りこぼしていないことの最低限の確認) -------------------
{
  const htmlSrc = readFileSync(path.join(REPO_ROOT, 'html', 'net-load.js'), 'utf8');
  const distSrc = readFileSync(DIST_NET_LOAD, 'utf8');
  const extractFn = (src) => {
    const m = /export function watchShareFragmentHashChange\(\{ isDirty, load \}\) \{[\s\S]*?\n\}\n/.exec(src);
    return m ? m[0] : null;
  };
  const a = extractFn(htmlSrc);
  const b = extractFn(distSrc);
  check('6. html/net-load.jsとdist/net-load.jsでwatchShareFragmentHashChange()の中身が一致する(ビルドの取りこぼし無し)',
    Boolean(a) && a === b, a === b ? undefined : 'ソース抽出結果が異なる');
}

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAIL`}`);
process.exit(failed === 0 ? 0 : 1);
