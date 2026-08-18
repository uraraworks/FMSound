#!/usr/bin/env node
// 実機報告(2026-08-17、3件目): 「共有リンクから読み込みました」(netStatus)が、
// 新規作成やライブラリから選択しても消えずに残る不具合の検証。
//
// 同じ形の不具合がこれで3回目(1件目=共有可能カウンタ、e64ea91・2件目=
// 「コピーしました」等、7c3ebda・3件目=今回)。原因はいずれも「読み込み経路の
// どれか1つだけ、新しいメッセージを消す配線を書き忘れる」ことだった。今回は
// 個別対処ではなく、html/mucom-app.js・html/pmd-app.js それぞれに置いた
// `resetTransientMessages()`(曲が変わる契機で一時メッセージをまとめて消す
// 「1つの入口」)へ、既知の「曲が変わる経路」全部が実際に配線されているかを
// 検証する。
//
// このリポジトリはmucom-app.js/pmd-app.js自体のDOM挙動を直接動かすテストを
// 持っていない(tools/verify_result_pane_dedup.mjs冒頭コメント参照。wasmが要る
// ため)。ここでも同じ作法(ソースからテキストで関数本体を抽出し、構造を検査する)
// を使う。
//
// 検証内容:
//   A. resetTransientMessages() が実際に3つの一時メッセージ(netStatus/
//      コンパイル結果/共有結果)を全部消していること(そのものの中身を検査)。
//   B. 「曲が変わる経路」のレジストリ(SONG_CHANGE_SITES)を持ち、各経路の
//      関数本体に resetTransientMessages() 呼び出しがあることを検査する。
//      载っていない(=呼んでいない)経路があればFAIL。
//   C. [陽性対照] Bの検出器が実際に「無い」を検出できることを、該当箇所を
//      文字列操作でわざと除去したコピーに対して確認してから、
//      本来のソースでPASSすることを確認する(壊れた検出器でないことの証拠)。
//   D. 消してはいけないもの(共有可能カウンタの数値表示領域・カウンタelの
//      非表示化)がresetTransientMessages()の対象に入っていないこと
//      (=巻き添えにしていないこと)。
//
// 実行: node tools/verify_transient_message_reset.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

const mucomSrc = readFileSync(path.join(REPO_ROOT, 'html/mucom-app.js'), 'utf8');
const pmdSrc = readFileSync(path.join(REPO_ROOT, 'html/pmd-app.js'), 'utf8');

/**
 * ソースから「開始行の正規表現」〜「終了マーカー(行頭からのインデント込み文字列)」
 * までを非貪欲マッチで抜き出す(tools/verify_result_pane_dedup.mjs等、既存スクリプトと
 * 同じ作法)。見つからなければ例外を投げる(実装の形が変わったことに気づけるように、
 * 静かにfalseへフォールバックしない)。
 * @param {string} src @param {RegExp} startRe @param {string} endMarker @param {string} label
 */
function extractBlock(src, startRe, endMarker, label) {
  const m = startRe.exec(src);
  if (!m) throw new Error(`${label} の開始位置が見つかりません(実装の形が変わった?)`);
  const from = m.index;
  const endIdx = src.indexOf(endMarker, from + m[0].length);
  if (endIdx < 0) throw new Error(`${label} の終端(${JSON.stringify(endMarker)})が見つかりません`);
  return src.slice(from, endIdx + endMarker.length);
}

console.log('=== tools/verify_transient_message_reset.mjs: 一時メッセージの消去漏れ検証 ===\n');

// --- A. resetTransientMessages() 自体の中身 ------------------------------------------

for (const [label, src] of [['MUCOM(html/mucom-app.js)', mucomSrc], ['PMD(html/pmd-app.js)', pmdSrc]]) {
  const body = extractBlock(src, /function resetTransientMessages\(opts = \{\}\) \{/, '\n  }\n', `${label} resetTransientMessages()`);
  check(`A. ${label}: resetTransientMessages()がsetNetStatus('', ...)でnetStatusを消す`,
    /setNetStatus\(\s*['"]['"]\s*,/.test(body), body);
  check(`A. ${label}: resetTransientMessages()がclearCompileStatus()でコンパイル結果を消す`,
    /clearCompileStatus\(\)/.test(body), body);
  check(`A. ${label}: resetTransientMessages()がshareControls.markDirty()で共有結果を消す`,
    /shareControls\.markDirty\(\)/.test(body), body);
}

// --- B/C. 「曲が変わる経路」レジストリ ------------------------------------------------
//
// 各経路を「関数本体の抽出方法」+「本体内にresetTransientMessages()呼び出しがあるか」
// の組で登録する。ここに載っていない経路が増えても検出できない(=このリスト自体が
// 全部かどうかは目視で確認するしかない)点は正直に限界として認める。ただし
// 「載っている経路について、書き忘れたら必ず検出する」は保証する(Cで確認)。
const SONG_CHANGE_SITES = {
  'MUCOM applyMmlBytes()(URL/ファイル/書庫/サンプル/ライブラリ選択/共有リンクが共通で通る窓口)': {
    src: mucomSrc,
    startRe: /function applyMmlBytes\(bytesOrBuffer, opts = \{\}\) \{/,
    endMarker: '\n  }\n',
  },
  'MUCOM btnNewMml(新規作成、applyMmlBytes()を経由しない)': {
    src: mucomSrc,
    startRe: /btnNewMml\.addEventListener\('click', function\(\) \{/,
    endMarker: '\n  });\n',
  },
  "PMD playBytes()(URL/ファイル/書庫/ライブラリ選択のバイナリ直接再生が共通で通る窓口)": {
    src: pmdSrc,
    startRe: /async function playBytes\(bytes, name, fileNameForBar = name, pcmFiles = \[\], unsupportedFiles = \[\], mmlSourceText = null, ffFile = null\) \{/,
    endMarker: '\n  }\n',
  },
  'PMD btnNewMml(新規作成、playBytes()を経由しない)': {
    src: pmdSrc,
    startRe: /btnNewMml\.addEventListener\('click', function\(\) \{/,
    endMarker: '\n  });\n',
  },
  'PMD サンプル読み込み(エディタモード、playBytes()を経由しない)': {
    src: pmdSrc,
    startRe: /document\.getElementById\('dlSampleFurElise'\)\.addEventListener\('click', async \(\) => \{/,
    endMarker: '\n  });\n',
  },
  'PMD loadSongFromShareFragment()(共有リンク、playBytes()を経由しない)': {
    src: pmdSrc,
    startRe: /async function loadSongFromShareFragment\(\) \{/,
    endMarker: '\n  }\n',
  },
};

/**
 * コメント(`//`行コメント・`/* *​/`ブロックコメント)を取り除く。日本語コメントの
 * 中で「(resetTransientMessages()コメント参照)」のように関数名そのものへ言及して
 * いる箇所があり、コメントを込みで検査すると「呼んでいる」と誤判定してしまう
 * (実測: 陽性対照の構築中に発覚。呼び出しを消してコメントだけ残したところ、
 * コメント側の言及がそのまま「呼んでいる」判定を通してしまった)。実際の呼び出し
 * (文として実行される箇所)だけを見るため、検査対象からコメントは除く。
 * @param {string} code
 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * レジストリの各経路について、実際にresetTransientMessages()を呼んでいるかを集計する
 * だけの純粋関数(check()を呼ばない。陽性対照(C)で「わざと壊した」状態にも使い回す
 * ため、その場ではPASS/FAIL表示を出さない=このスクリプト自体の合否には数えない)。
 * @param {Record<string, {src:string, startRe:RegExp, endMarker:string}>} sites
 */
function collectRegistryStatus(sites) {
  let allOk = true;
  const missing = [];
  for (const [name, spec] of Object.entries(sites)) {
    const body = stripComments(extractBlock(spec.src, spec.startRe, spec.endMarker, name));
    const hasReset = /resetTransientMessages\(/.test(body);
    if (!hasReset) { allOk = false; missing.push(name); }
  }
  return { allOk, missing };
}

// B. 本来のソースはPASSするはず(この結果だけがスクリプトの合否に数わる)。
const realResult = collectRegistryStatus(SONG_CHANGE_SITES);

// C. [陽性対照] 1経路だけ「わざと呼び忘れた」状態を作ってFAILすることを先に確認する。
//    対象: MUCOM btnNewMml(呼び出しをコメントアウトした偽ソースを作る)。
{
  const brokenMucomSrc = mucomSrc.replace(
    /(btnNewMml\.addEventListener\('click', function\(\) \{[\s\S]*?)resetTransientMessages\(\);/,
    '$1/* わざと呼ばない(陽性対照用) */',
  );
  check('C. [陽性対照の前提] 壊れたソースは実際にresetTransientMessages()呼び出しが1個少ない',
    (mucomSrc.match(/resetTransientMessages\(/g) || []).length ===
    (brokenMucomSrc.match(/resetTransientMessages\(/g) || []).length + 1);

  const brokenSites = { ...SONG_CHANGE_SITES, 'MUCOM btnNewMml(新規作成、applyMmlBytes()を経由しない)': { ...SONG_CHANGE_SITES['MUCOM btnNewMml(新規作成、applyMmlBytes()を経由しない)'], src: brokenMucomSrc } };
  const brokenResult = collectRegistryStatus(brokenSites);
  check('C. [陽性対照] 呼び忘れを実際に検出してFAILする(検出器が壊れていない証拠)',
    !brokenResult.allOk && brokenResult.missing.includes('MUCOM btnNewMml(新規作成、applyMmlBytes()を経由しない)'),
    JSON.stringify(brokenResult.missing));
}

check('B. [本題] 本来のソースは全経路が配線済みでPASSする', realResult.allOk,
  realResult.allOk ? undefined : `未配線: ${realResult.missing.join(' / ')}`);

// --- D. 消してはいけないもの(常時表示)が巻き添えになっていないこと -------------------

for (const [label, src] of [['MUCOM', mucomSrc], ['PMD', pmdSrc]]) {
  const body = extractBlock(src, /function resetTransientMessages\(opts = \{\}\) \{/, '\n  }\n', `${label} resetTransientMessages()`);
  check(`D. ${label}: resetTransientMessages()はcounterEl/shareCounter系のDOMを直接隠していない(markDirty()経由のみ)`,
    !/counterEl|shareCounter|gaugeEl/.test(body), body);
  check(`D. ${label}: resetTransientMessages()はencodingBadge/mmlCaveatに触れていない(常時表示、対象外)`,
    !/encodingBadge|mmlCaveat/.test(body), body);
}

console.log(`\n${passCount} PASS, ${failCount} FAIL`);
process.exit(failCount === 0 ? 0 : 1);
