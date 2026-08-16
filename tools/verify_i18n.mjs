#!/usr/bin/env node
// ui/i18n.js(ja/en辞書)の整合性検証。
//
// 検証項目:
//   1. jaとenのキー集合が完全一致すること(片方にしか無いキーがあればFAIL)。
//   2. どちらの言語も値が空文字でないこと。
//   3. enの全ての値に日本語文字(ひらがな・カタカナ・漢字)が含まれないこと(訳し忘れ検出)。
//   4. html/index.html に現れる全てのdata-i18n*属性のキーが辞書に存在すること(タイポ検出)。
//   5. 辞書にあるがhtml/ ui/ のどこからも参照されていないキーを警告として列挙する
//      (FAILにはしない。件数は必ず出力する)。
//   6. i18nを経由しない日本語文字列リテラルの検出。上の1〜5は「辞書の中」の整合性
//      しか見ておらず、そもそも辞書に入れ忘れて直書きした文字列(html/app.jsの
//      driverTagline実装漏れが実例、2026-08-16利用者報告)を原理的に検出できない。
//      html/*.js ui/*.js html/index.html を走査し、コメント行を除いて日本語文字を
//      含む行を列挙する。
//   7. ja/enのプレースホルダ({files} {url} {status}等の{...}記法)集合が全キーで
//      一致すること(2026-08-16利用者報告への対応)。訳文側でプレースホルダを
//      書き落としても例外にはならず、t()のreplaceAll()が単に置換対象を見つけられない
//      だけなので、利用者の画面に`{fileName}`という文字列がそのまま出て初めて気づく
//      (実行時には誰も気づけない)。順序は問わず、集合として一致するかだけを見る。
//   8. t()に辞書へ存在しないキーを渡すとconsole.warnが出ること(2026-08-16利用者報告)。
//      戻り値がキー文字列そのものになる挙動自体は変えない(空白より読めるものが出る
//      ほうがまし、という利用者判断)が、タイポ・移行漏れに気づけるよう警告は必須。
//
// 実行: node tools/verify_i18n.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DICT, t, setLang } from '../ui/i18n.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passed++; else failed++;
  console.log(`[${mark}] ${label}${detail !== undefined ? '\n       ' + detail : ''}`);
}

// 日本語文字(ひらがな・カタカナ・漢字。全角句読点・記号は誤検出を避けるため対象外)。
const JAPANESE_RE = /[぀-ゟ゠-ヿ一-鿿]/;

function walkFiles(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkFiles(full, exts, out);
    } else if (exts.includes(extname(name))) {
      out.push(full);
    }
  }
  return out;
}

// --- 項目6: L1で「移行完了」と判断したファイル(0件を要求する) ---
// ここに載っていないhtml/*.js・ui/*.js(html/mucom-app.js・html/pmd-app.js等、
// L2=動的合成メッセージへ持ち越した分)は件数・該当行をINFOとして出すだけでFAILにしない。
// 次ラウンドでL2の移行が終わったファイルをこのリストへ移すだけで、進捗がそのまま
// 検査の強化になる(利用者指示の設計)。
// 除外理由の補足:
//   - ui/i18n.js自体は辞書(翻訳の情報源)なので対象外。ここにja文字列があるのは
//     「i18nを経由していない」の逆で、経由させるための定義そのもの。
//   - html/index.htmlは<head>(タイトル/meta/OGP)を除いて判定する。OGP/<title>は
//     利用者指示で今回対象外と明言されており(クローラが?lang=を辿らないため)、
//     このスクリプトが「訳し忘れ」として誤検出しないようにする。
const L1_COMPLETE_FILES = [
  'html/index.html',
  'html/app.js',
  'ui/open-menu.js',
  'ui/download-menu.js',
  'ui/library-panel.js',
  // L2(2026-08-16、今回のラウンド)で移行し終えたファイル。
  // html/mucom-app.js・html/pmd-app.js はここへは入れない: 動的UI文言(再生ボタン・
  // コンパイル結果・サンプル/確認ダイアログ・下書き復元通知・ネットワーク読み込み状態・
  // デバッグ見出し)は全てi18n経由にしたが、PMD_NEW_MML_TEMPLATE/MUCOM_NEW_MML_TEMPLATE
  // (新規作成ボタンで挿入するMML本文そのもの、曲データの一部でUI文言ではない)に
  // 日本語コメントが残るため、意図的に0件を要求しない(報告参照)。
  'html/net-load.js',
  'ui/mml-status.js',
  'ui/mml-caveats.js',
  // 共有UI(2026-08-17新設)。利用者に見える文字列はすべて辞書経由にした。
  'ui/share-controls.js',
];

function stripJsComments(text) {
  // ブロックコメント /* ... */ を先に全体除去してから行ごとに処理する。
  // 除去は空文字ではなく「マッチ内の改行だけ残す」形にする(単純に''へ置換すると
  // 複数行コメントぶん行数が縮み、以降の行番号が全部ズレる実装ミスを一度やった)。
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''));
  return noBlock.split(/\r\n|\r|\n/).map((line) => {
    // 「//」を行コメントの開始として扱うが、"https://" のような URL 内の "//" は
    // 除外する(直前の文字が ':' の場合はコメント開始とみなさない)。
    let idx = 0;
    while (true) {
      idx = line.indexOf('//', idx);
      if (idx === -1) return line;
      if (idx === 0 || line[idx - 1] !== ':') return line.slice(0, idx);
      idx += 2;
    }
  });
}

function stripHtmlComments(text) {
  // 同上の理由でマッチ内の改行だけ残す(行番号を保つ)。
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));
}

// 言語名(endonym、html/index.htmlの<option>日本語</option>等)のように、翻訳の
// 対象ではなく「常にその表記で固定」が正しいものだけの例外マーカー。同じ行に
// このトークンを含むコメントを置くと、その行は日本語判定の対象から外れる
// (コメント除去より前の"生の行"で判定するため、行コメント扱いにされても効く)。
// 濫用防止: マーカーには理由(なぜ翻訳しないか)を併記すること。
const EXEMPT_MARKER = 'i18n-exempt';

function findJapaneseLines(relPath, absPath) {
  const text = readFileSync(absPath, 'utf-8');
  const rawLines = text.split(/\r\n|\r|\n/);
  let lines;
  if (extname(absPath) === '.html') {
    // <head>除外は行数がズレると誤対応するので、行ごとに空へ置換する形で行う
    // (stripHtmlHeadを直接使わず、headの範囲だけ検出して該当行を空文字にする)。
    const headMatch = text.match(/<head\b[^>]*>[\s\S]*?<\/head>/i);
    let headStartLine = -1;
    let headEndLine = -1;
    if (headMatch) {
      const before = text.slice(0, headMatch.index);
      headStartLine = before.split(/\r\n|\r|\n/).length - 1;
      headEndLine = headStartLine + headMatch[0].split(/\r\n|\r|\n/).length - 1;
    }
    lines = stripHtmlComments(text).split(/\r\n|\r|\n/).map((line, i) =>
      i >= headStartLine && i <= headEndLine ? '' : line,
    );
  } else {
    lines = stripJsComments(text);
  }
  const hits = [];
  lines.forEach((line, i) => {
    if (rawLines[i] && rawLines[i].includes(EXEMPT_MARKER)) return;
    if (JAPANESE_RE.test(line)) hits.push({ line: i + 1, text: line.trim() });
  });
  return hits;
}

function main() {
  console.log('=== tools/verify_i18n.mjs: ui/i18n.js 辞書の整合性検証 ===\n');

  const jaKeys = new Set(Object.keys(DICT.ja));
  const enKeys = new Set(Object.keys(DICT.en));

  // --- 1. キー集合の完全一致 ---
  const onlyJa = [...jaKeys].filter((k) => !enKeys.has(k));
  const onlyEn = [...enKeys].filter((k) => !jaKeys.has(k));
  check(
    '1. jaとenのキー集合が完全一致する',
    onlyJa.length === 0 && onlyEn.length === 0,
    onlyJa.length || onlyEn.length
      ? `jaのみ: [${onlyJa.join(', ')}] / enのみ: [${onlyEn.join(', ')}]`
      : undefined,
  );

  // --- 2. 値が空文字でない ---
  const emptyJa = [...jaKeys].filter((k) => DICT.ja[k].length === 0);
  const emptyEn = [...enKeys].filter((k) => DICT.en[k].length === 0);
  check(
    '2. どちらの言語も値が空文字でない',
    emptyJa.length === 0 && emptyEn.length === 0,
    emptyJa.length || emptyEn.length ? `空のja: [${emptyJa.join(', ')}] / 空のen: [${emptyEn.join(', ')}]` : undefined,
  );

  // --- 3. enの値に日本語文字が含まれない(訳し忘れ検出) ---
  // 例外: toolbar.langToggleAriaLabel は意図的に逆転させている(2026-08-16、
  // 利用者判断)。言語切替ボタンの可視文字(ui/i18n.js langToggleLabel())は
  // 「押したら切り替わる先の言語」をendonymで出すため、aria-labelもそれに言語を
  // 揃える設計。結果としてjaの値が英語("Switch to English")、enの値が日本語
  // ("日本語に切り替える")になるのが正しく、これは訳し忘れではないので
  // このキーだけ検出対象から除外する(ui/i18n.js該当キーのコメントも参照)。
  const I18N_DIRECTION_EXEMPT_KEYS = ['toolbar.langToggleAriaLabel'];
  const untranslated = [...enKeys].filter(
    (k) => !I18N_DIRECTION_EXEMPT_KEYS.includes(k) && JAPANESE_RE.test(DICT.en[k]),
  );
  check(
    '3. enの全ての値に日本語文字が含まれない(訳し忘れ検出)',
    untranslated.length === 0,
    untranslated.length ? untranslated.map((k) => `${k}: "${DICT.en[k]}"`).join('\n       ') : undefined,
  );

  // --- 4. html/index.html のdata-i18n*属性キーが辞書に存在する ---
  const indexHtml = readFileSync(join(REPO_ROOT, 'html/index.html'), 'utf-8');
  const attrRe = /data-i18n(?:-title|-placeholder)?="([^"]+)"/g;
  const usedInHtml = new Set();
  let m;
  while ((m = attrRe.exec(indexHtml))) usedInHtml.add(m[1]);
  const missingFromDict = [...usedInHtml].filter((k) => !jaKeys.has(k));
  check(
    '4. html/index.html のdata-i18n*属性キーが辞書に存在する(タイポ検出)',
    missingFromDict.length === 0,
    missingFromDict.length ? `辞書に無いキー: [${missingFromDict.join(', ')}]` : undefined,
  );

  // --- 5. 辞書にあるがhtml/ ui/ のどこからも参照されていないキー(警告のみ) ---
  const sourceFiles = [
    ...walkFiles(join(REPO_ROOT, 'html'), ['.js', '.html']),
    ...walkFiles(join(REPO_ROOT, 'ui'), ['.js']),
  ];
  const sourceText = sourceFiles.map((f) => readFileSync(f, 'utf-8')).join('\n');
  const unused = [...jaKeys].filter((k) => {
    // data-i18n="key" 属性、またはt('key')/t("key")呼び出しのどちらかで見つかれば「使用中」。
    const asAttr = `"${k}"`;
    const asCallSingle = `'${k}'`;
    const asCallDouble = `"${k}"`;
    return !(sourceText.includes(asAttr) || sourceText.includes(asCallSingle) || sourceText.includes(asCallDouble));
  });
  console.log(
    `[INFO] 5. 辞書にあるがhtml/ ui/ から参照されていないキー: ${unused.length}件` +
    (unused.length ? `\n       [${unused.join(', ')}]` : ''),
  );

  // --- 6. i18nを経由しない日本語文字列リテラルの検出 ---
  const allTargets = [
    ...walkFiles(join(REPO_ROOT, 'html'), ['.js']),
    ...walkFiles(join(REPO_ROOT, 'ui'), ['.js']),
    join(REPO_ROOT, 'html/index.html'),
    join(REPO_ROOT, 'html/help.html'),
  ].filter(
    (f) =>
      f !== join(REPO_ROOT, 'ui/i18n.js') && // 辞書自体は対象外(上のコメント参照)
      // html/help.html(使い方ページ)は data-lang="ja"/"en" 方式(html/help.htmlの
      // コメント・タスク指示参照)で、日本語の本文がそのままHTMLに存在するのが正常な
      // 設計。他ファイルと同じ「i18n非経由の日本語=訳し忘れ」という前提が成り立たない
      // ため、0件を要求する検査対象から明示的に除外する(黙って対象外にせず、ここで
      // 理由を明記する)。data-lang集合の整合性はtools/verify_help_page.mjsが別途担保する。
      f !== join(REPO_ROOT, 'html/help.html'),
  );

  for (const abs of allTargets) {
    const rel = abs.slice(REPO_ROOT.length).replace(/\\/g, '/');
    const hits = findJapaneseLines(rel, abs);
    const isL1 = L1_COMPLETE_FILES.includes(rel);
    if (isL1) {
      check(
        `6. [L1完了/0件要求] ${rel} にi18n未経由の日本語文字列が無い`,
        hits.length === 0,
        hits.length ? hits.map((h) => `L${h.line}: ${h.text}`).join('\n       ') : undefined,
      );
    } else if (hits.length > 0) {
      console.log(
        `[INFO] 6. [L2持ち越し] ${rel}: 日本語文字列を含む行 ${hits.length}件\n       ` +
        hits.map((h) => `L${h.line}: ${h.text}`).join('\n       '),
      );
    }
  }

  // --- 7. ja/enのプレースホルダ集合が全キーで一致する ---
  const PLACEHOLDER_RE = /\{([^}]+)\}/g;
  function extractPlaceholders(str) {
    const set = new Set();
    let pm;
    PLACEHOLDER_RE.lastIndex = 0;
    while ((pm = PLACEHOLDER_RE.exec(str))) set.add(pm[1]);
    return set;
  }
  function placeholderSetsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
  }
  const placeholderMismatches = [];
  for (const k of jaKeys) {
    if (!enKeys.has(k)) continue; // 項目1で既に検出済みのキーは対象外
    const jaPh = extractPlaceholders(DICT.ja[k]);
    const enPh = extractPlaceholders(DICT.en[k]);
    if (!placeholderSetsEqual(jaPh, enPh)) {
      placeholderMismatches.push(`${k}: ja={${[...jaPh].join(', ')}} en={${[...enPh].join(', ')}}`);
    }
  }
  check(
    '7. 全キーでja/enのプレースホルダ集合が一致する({...}の書き落とし検出)',
    placeholderMismatches.length === 0,
    placeholderMismatches.length ? placeholderMismatches.join('\n       ') : undefined,
  );

  // --- 8. t()に未知キーを渡すとconsole.warnが出る ---
  const originalWarn = console.warn;
  let warned = false;
  let warnedWith = '';
  console.warn = (...args) => { warned = true; warnedWith = args.join(' '); };
  let returnedValue;
  try {
    setLang('en');
    returnedValue = t('__verify_i18n_intentionally_missing_key__');
  } finally {
    console.warn = originalWarn;
  }
  check(
    '8. t()に辞書へ存在しないキーを渡すとconsole.warnが出る',
    warned,
    warned ? `warn: ${warnedWith} / 戻り値: ${JSON.stringify(returnedValue)}` : `戻り値: ${JSON.stringify(returnedValue)}`,
  );

  console.log(`\n${passed} PASS, ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
