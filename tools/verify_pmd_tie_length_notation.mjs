#!/usr/bin/env node
// 回帰テスト: タイ(&)の直後に音長を書く記法(PMDMML.MAN §4-10 書式3「&[音長][.]」)。
//
// 実データ第三者MML(バッチ2作業、8本中で最多の未対応パターン)に頻出する
// `e-8&2`・`c&2`・`f&4&4&8`・`b-2&8`・`e-&e-2&4..`・`c2&16&8` のような記法。
// §4-10実測(WebFetch、wikiwiki.jp thtools「PMD version4.8 コマンドマニュアル_2」):
//   「&の直後に音長を指定すると、l+コマンドと同等の扱いとなり、直前の音長に
//   指定した音長を加算する」。例: `a8&2` = `a8l+2` = `a8&a2`。
// つまり「タイ + 直前と同じ音程・指定音長の音符」と等価であるはず。
// compiler/pmd_mml_compiler.mjs の mergeSamePitchTies (同音程タイの圧縮、
// 2026-08-18導入)がこの「加算」を最終的に実現する側なので、このテストは
// `c4&2`(短縮記法)と`c4&c2`(完全形、既存対応済み)が**同一バイト列**に
// コンパイルされることを確認する。
//
// 実行: node tools/verify_pmd_tie_length_notation.mjs

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { compileMml } from '../compiler/pmd_mml_compiler.mjs';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

function compileOk(mml) {
  const r = compileMml(mml, { tones: { 1: {} } });
  if (r.errors && r.errors.length > 0) {
    throw new Error(`compile failed for "${mml}": ${JSON.stringify(r.errors)}`);
  }
  return r.file;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function main() {
  // 1. 短縮記法(`c4&2`)と完全形(`c4&c2`)が同じバイト列になる(§4-10「l+コマンドと
  //    同等」「a8&2 = a8&a2」の直接確認)。
  {
    const short = compileOk('A @1 o4 c4&2');
    const full = compileOk('A @1 o4 c4&c2');
    check('c4&2 と c4&c2 が同一バイト列にコンパイルされる(§4-10)', bytesEqual(short, full),
      `short=${short.length}byte full=${full.length}byte`);
  }

  // 2. `&`の連鎖(`f4&4&8` = f4&f4&f8、実データMSO_FM_FS_PPZ.MML等に頻出)。
  {
    const chain = compileOk('A @1 o4 f4&4&8');
    const full = compileOk('A @1 o4 f4&f4&f8');
    check('f4&4&8 の連鎖が f4&f4&f8 と同一バイト列になる', bytesEqual(chain, full),
      `chain=${chain.length}byte full=${full.length}byte`);
  }

  // 3. 付点との組み合わせ(`e-&e-2&4..`、実データDS4_MAIA.mml等)。
  {
    const dotted = compileOk('A @1 o4 e-&e-2&4..');
    const full = compileOk('A @1 o4 e-&e-2&e-4..');
    check('付点付きの短縮記法(&4..)が完全形と同一バイト列になる', bytesEqual(dotted, full),
      `dotted=${dotted.length}byte full=${full.length}byte`);
  }

  // 4. 従来の「音符+&+音符」(音程省略なしの後方互換ケース)が壊れていないこと。
  {
    const r = compileMml('A @1 o4 c4&d4', { tones: { 1: {} } });
    check('従来のtie(音程を書く後方互換ケース、c4&d4)は引き続きエラーにならない',
      r.errors.length === 0, JSON.stringify(r.errors));
  }

  // 5. 直前に音符が無い状態で`&2`を書くとエラーになること(暴走防止)。
  {
    const r = compileMml('A @1 o4 &2', { tones: { 1: {} } });
    check('直前に音符が無い&2はエラーになる', r.errors.length > 0, JSON.stringify(r.errors));
  }

  // 6. [陽性対照] 意図的に短縮記法を「未対応」扱いへ戻すと、上の1が実際に落ちることを
  //    確認する(製品コードの分岐条件を反転させて一時的に壊し、子プロセスで
  //    新しいモジュールグラフとして読み直させる。同一プロセス内でのdynamic
  //    importはNodeのESMキャッシュにより無効化できないため子プロセス経由にする)。
  {
    const parserPath = new URL('../compiler/pmd_mml_parser.mjs', import.meta.url);
    const orig = fs.readFileSync(parserPath, 'utf8');
    const NEEDLE = "if (body[i] === '%' || /\\d/.test(body[i] ?? '') || body[i] === '.') {";
    if (!orig.includes(NEEDLE)) {
      throw new Error('陽性対照用のパッチ対象コードが見つかりません(製品コードが変更された可能性)');
    }
    const broken = orig.replace(NEEDLE, "if (false && (body[i] === '%' || /\\d/.test(body[i] ?? '') || body[i] === '.')) {");
    fs.writeFileSync(parserPath, broken, 'utf8');
    try {
      const compilerUrl = new URL('../compiler/pmd_mml_compiler.mjs', import.meta.url).href;
      const script = `
        import('${compilerUrl}').then(({ compileMml }) => {
          const r = compileMml('A @1 o4 c4&2', { tones: { 1: {} } });
          process.stdout.write(JSON.stringify({ errors: r.errors }));
        }).catch((e) => { process.stdout.write(JSON.stringify({ threw: String(e && e.message) })); });
      `;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
      const parsed = JSON.parse(out);
      const failed = parsed.threw || (parsed.errors && parsed.errors.length > 0);
      check('[陽性対照] 短縮記法の分岐を無効化すると c4&2 のコンパイルが失敗する', !!failed, out);
    } finally {
      fs.writeFileSync(parserPath, orig, 'utf8');
    }
  }

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main();
