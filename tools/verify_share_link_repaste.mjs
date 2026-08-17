#!/usr/bin/env node
// 実機報告(2026-08-17、4件目): 「新規作成やライブラリの曲を表示中に、共有リンクを
// URL欄に貼り付けてEnter押しても更新されず、リロードで更新される」不具合の検証。
//
// 原因: 7ff9d95で入れた`lastHandledHash`による重複排除(tools/verify_share_link_hashchange.mjs
// が検証済み)が、「一度処理したフラグメントを覚えたまま、別の曲へ移っても忘れない」
// 欠陥を持っていた。新規作成やライブラリから曲を選んでも記憶は消えないため、
// 同じ共有リンクを貼り直すと「既に処理済み」と誤判定され、読み込まれない。
//
// 実機での再現手順(親セッションがブラウザで確認済み。docs参照は無し、利用者報告のまま):
//   ① 共有リンクを貼る            → 読み込まれる(true)
//   ② 実際の「新規作成」ボタンを押す → 雛形になる(フラグメントも消える)
//   ③ 同じ共有リンクを貼り直す      → 読み込まれない(false) ← 不具合
//
// 修正: net-load.js watchShareFragmentHashChange()コメント参照。同じ重複排除の記憶
// (lastHandledHash)を、呼び出し元へ`forgetHandledHash()`として公開し、
// 「曲が共有リンク以外の手段で変わったら」(html/mucom-app.js・html/pmd-app.js
// resetTransientMessages()、既存の「一時メッセージをまとめて消す1つの入口」)から
// 呼ぶ。ただし共有リンク自身の読み込み経由(load()の中)では呼ばない
// (呼ぶと直後の重複hashchangeで(a)の重複排除が効かなくなるため)。
//
// このファイルはwatchShareFragmentHashChange()自体の単体検証(dist/net-load.js相手、
// tools/verify_share_link_hashchange.mjsと同じスタブ作法)。
// 「実際のNewボタン/ライブラリ選択のクリックそのもの」まで動かす検証は、wasmと
// 実DOMが要るため、このリポジトリの既存の作法どおりnode単体では持てない
// (tools/verify_transient_message_reset.mjs冒頭コメント参照)。その部分は
// tools/verify_transient_message_reset.mjsが「resetTransientMessages()が
// 新規作成/ライブラリ選択/共有リンク等、既知の全経路から呼ばれているか」を
// ソース検査で担保し、実際のクリック→再貼り付けの一気通貫はブラウザでの
// 手動検証(今回の作業ログ)で行った。
//
// 検証内容:
//   1. [陽性対照] forgetHandledHash()を呼ばない場合、同じ#s1=の再セットは
//      読み込まれない(修正前の不具合そのものの再現。tools/verify_share_link_hashchange.mjsの
//      検証3と同じ挙動だが、ここでは「一度読み込んだ後」を経由させる)。
//   2. [本題] forgetHandledHash()を呼んだ後は、同じ#s1=の再セットでも読み込まれる
//      (①共有リンク読み込み→②forgetHandledHash()(新規作成/ライブラリ選択相当)→
//      ③同じ#s1=を再セット、という実機の再現手順そのもの)。
//   3. 共有リンク自身の読み込み経由(load()の中)でforgetHandledHash()を呼んでも
//      (=呼び出し側の実装を誤ったケース)、直後に同じhashchangeが重複して来ると
//      二重に読み込まれてしまうことを示す(だからload()の中では呼ばない設計にした、
//      という理由の裏付け。html/mucom-app.js・html/pmd-app.jsの実装が実際に
//      load()の中で呼んでいないことはtools/verify_transient_message_reset.mjsの
//      対象外なので、ここではソースを直接検査して確認する)。
//   4. 連続して同じhashchangeが来ても(通常の運用: forgetHandledHash()は
//      load()の中では呼ばれない)無限ループ・二重読み込みが起きないこと。
//   5. アプリ自身の消去(clearShareFragmentFromAddressBar())では引き続き
//      再発火しないこと(既存の検証3-hashchange.mjsのデグレが無いことの再確認)。
//
// 実行: node tools/verify_share_link_repaste.mjs (事前に tools/build_dist.sh が必要)

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

// tools/verify_share_link_hashchange.mjsと同じ最小スタブ。
function makeEnv(initialHash) {
  const listeners = {};
  const win = {
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    _dispatch(type) { for (const fn of (listeners[type] ?? [])) fn(); },
    confirm: () => true,
  };
  const loc = { hash: initialHash, href: `https://example.com/${initialHash}` };
  const hist = {
    replaceState(_state, _title, url) {
      loc.href = url;
      const i = url.indexOf('#');
      loc.hash = i >= 0 ? url.slice(i) : '';
    },
  };
  return { win, loc, hist };
}

function activate(env) {
  globalThis.window = env.win;
  globalThis.location = env.loc;
  globalThis.history = env.hist;
}

console.log('=== tools/verify_share_link_repaste.mjs: 共有リンク貼り直しの検証(実機報告4件目) ===\n');

const env0 = makeEnv('');
activate(env0);
const { watchShareFragmentHashChange, clearShareFragmentFromAddressBar } = await import(DIST_NET_LOAD);

// --- 1. [陽性対照] forgetHandledHash()を呼ばない場合、同じ#s1=の再セットは読み込まれない ---
{
  const env = makeEnv('');
  activate(env);
  const calls = [];
  watchShareFragmentHashChange({ isDirty: () => false, load: () => { calls.push('load'); return Promise.resolve(true); } });

  // ①共有リンクを貼る
  env.loc.hash = '#s1=same';
  env.win._dispatch('hashchange');
  check('1-a. ①共有リンクを貼ると読み込まれる', calls.length === 1, `calls=${JSON.stringify(calls)}`);

  // ②「新規作成」相当(forgetHandledHash()を呼ばない、壊れた実装を模す): hashを空にする
  //   (新規作成は実際にclearShareFragmentFromAddressBar()でhashを消す。ここではその効果
  //   だけを再現し、forgetHandledHash()は意図的に呼ばない)。
  env.loc.hash = '';

  // ③同じ共有リンクを貼り直す
  env.loc.hash = '#s1=same';
  env.win._dispatch('hashchange');
  check('1-b. [陽性対照] forgetHandledHash()を呼ばないと③の貼り直しは読み込まれない(修正前の不具合そのもの)',
    calls.length === 1, `calls=${JSON.stringify(calls)}`);
}

// --- 2. [本題] forgetHandledHash()を呼んだ後は、同じ#s1=の再セットでも読み込まれる ---
{
  const env = makeEnv('');
  activate(env);
  const calls = [];
  const { forgetHandledHash } = watchShareFragmentHashChange({
    isDirty: () => false,
    load: () => { calls.push('load'); return Promise.resolve(true); },
  });

  // ①共有リンクを貼る
  env.loc.hash = '#s1=same';
  env.win._dispatch('hashchange');
  check('2-a. ①共有リンクを貼ると読み込まれる', calls.length === 1, `calls=${JSON.stringify(calls)}`);

  // ②実際の「新規作成」ボタン相当: hashを消し、resetTransientMessages()経由で
  //   forgetHandledHash()を呼ぶ(html/mucom-app.js・html/pmd-app.jsの実装どおり)。
  env.loc.hash = '';
  forgetHandledHash();

  // ③同じ共有リンクを貼り直す
  env.loc.hash = '#s1=same';
  env.win._dispatch('hashchange');
  check('2-b. [本題] forgetHandledHash()を呼んだ後は③の貼り直しが読み込まれる(修正の確認)',
    calls.length === 2, `calls=${JSON.stringify(calls)}`);
}

// --- 3. load()の中でforgetHandledHash()を呼ぶ(誤実装)と、直後の重複hashchangeで
//        二重読み込みが起きてしまうことの確認(だから呼び出し側はload()の中では
//        呼ばない設計にした、という裏付け)。-----------------------------------------
{
  const env = makeEnv('');
  activate(env);
  const calls = [];
  const { forgetHandledHash } = watchShareFragmentHashChange({
    isDirty: () => false,
    // 誤実装: load()の中でforgetHandledHash()を呼んでしまう(viaShareLinkの区別をしない)。
    load: () => { calls.push('load'); forgetHandledHash(); return Promise.resolve(true); },
  });

  env.loc.hash = '#s1=dup';
  env.win._dispatch('hashchange'); // 1回目
  env.win._dispatch('hashchange'); // 直後に(ブラウザの都合等で)重複して飛んできたと仮定
  check('3. [設計の裏付け] load()内でforgetHandledHash()を呼うと、直後の重複hashchangeで二重に読み込まれる',
    calls.length === 2, `calls=${JSON.stringify(calls)}(誤実装の場合。だからload()の中では呼ばない)`);
}

// --- 4. 通常の実装(load()の中では呼ばない)なら、連続する同じhashchangeで
//        二重読み込み・無限ループが起きないこと ------------------------------------
{
  const env = makeEnv('');
  activate(env);
  const calls = [];
  const { forgetHandledHash } = watchShareFragmentHashChange({
    isDirty: () => false,
    load: () => { calls.push('load'); return Promise.resolve(true); }, // forgetHandledHash()を呼ばない(正しい実装)
  });

  env.loc.hash = '#s1=dup2';
  env.win._dispatch('hashchange');
  env.win._dispatch('hashchange');
  env.win._dispatch('hashchange');
  check('4. 連続して同じhashchangeが来てもloadは1回しか呼ばれない(無限ループ・二重読み込みが起きない)',
    calls.length === 1, `calls=${JSON.stringify(calls)}`);

  // forgetHandledHash()を呼んだ後でも、hashが変わらなければ再読み込みしない
  // (forgetHandledHash()は「値の記憶」を捨てるだけで、hashchangeが飛んでこない限り
  // 何も起きないことの確認。新規作成等はhashを実際に変える操作を伴うため、この
  // ケース自体は実運用では起きないはずだが、念のため確認する)。
  forgetHandledHash();
  check('4-b. forgetHandledHash()を呼んだだけ(hash変化無し)ではloadが増えない',
    calls.length === 1, `calls=${JSON.stringify(calls)}`);
}

// --- 5. 既存のデグレ確認: アプリ自身の消去では引き続き再発火しない ----------------------
{
  const env = makeEnv('#s1=old');
  activate(env);
  const calls = [];
  watchShareFragmentHashChange({ isDirty: () => false, load: () => { calls.push('load'); return Promise.resolve(true); } });

  clearShareFragmentFromAddressBar();
  env.win._dispatch('hashchange'); // 万一発火した場合の最悪ケース(tools/verify_share_link_hashchange.mjsと同じ)
  check('5. アプリ自身の消去(万一hashchangeが発火しても)ではloadが呼ばれない', calls.length === 0,
    `calls=${JSON.stringify(calls)}`);
}

// --- 6. 呼び出し側(html/mucom-app.js・html/pmd-app.js)が、共有リンク自身の読み込み
//        (loadSongFromShareFragment())ではforgetHandledHash()相当を呼ばない設計に
//        なっていることをソースで確認する(検証3の裏付けが実装にも反映されているか)。--
{
  const mucomSrc = readFileSync(path.join(REPO_ROOT, 'html/mucom-app.js'), 'utf8');
  const pmdSrc = readFileSync(path.join(REPO_ROOT, 'html/pmd-app.js'), 'utf8');

  // MUCOM: loadSongFromShareFragment()の中のapplyMmlBytes()呼び出しにviaShareLink: trueが
  // 渡されていること(applyMmlBytes()がresetTransientMessages()にそのまま伝え、
  // resetTransientMessages()が「viaShareLinkなら forgetHandledShareFragmentHash()を
  // 呼ばない」よう分岐する。html/mucom-app.jsのコメント参照)。
  const mucomShareLoadBlock = /async function loadSongFromShareFragment\(\) \{[\s\S]*?\n  \}\n/.exec(mucomSrc);
  check('6-a. MUCOM loadSongFromShareFragment()がapplyMmlBytes()にviaShareLink: trueを渡している',
    Boolean(mucomShareLoadBlock) && /applyMmlBytes\([^)]*viaShareLink:\s*true/.test(mucomShareLoadBlock[0]),
    mucomShareLoadBlock ? mucomShareLoadBlock[0] : 'ブロックが見つからない');

  // PMD: loadSongFromShareFragment()自身がresetTransientMessages({ viaShareLink: true })を
  // 直接呼んでいること(PMDにはapplyMmlBytes()相当の共通窓口が無いため直接呼ぶ)。
  const pmdShareLoadBlock = /async function loadSongFromShareFragment\(\) \{[\s\S]*?\n  \}\n/.exec(pmdSrc);
  check('6-b. PMD loadSongFromShareFragment()がresetTransientMessages({ viaShareLink: true })を呼んでいる',
    Boolean(pmdShareLoadBlock) && /resetTransientMessages\(\{\s*viaShareLink:\s*true\s*\}\)/.test(pmdShareLoadBlock[0]),
    pmdShareLoadBlock ? pmdShareLoadBlock[0] : 'ブロックが見つからない');
}

// --- 7. 参考: html/net-load.jsとdist/net-load.jsでロジックがずれていないこと -------------
{
  const htmlSrc = readFileSync(path.join(REPO_ROOT, 'html', 'net-load.js'), 'utf8');
  const distSrc = readFileSync(DIST_NET_LOAD, 'utf8');
  const extractFn = (src) => {
    const m = /export function watchShareFragmentHashChange\(\{ isDirty, load \}\) \{[\s\S]*?\n\}\n/.exec(src);
    return m ? m[0] : null;
  };
  const a = extractFn(htmlSrc);
  const b = extractFn(distSrc);
  check('7. html/net-load.jsとdist/net-load.jsでwatchShareFragmentHashChange()の中身が一致する(ビルドの取りこぼし無し)',
    Boolean(a) && a === b, a === b ? undefined : 'ソース抽出結果が異なる');
}

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAIL`}`);
process.exit(failed === 0 ? 0 : 1);
