#!/usr/bin/env node
// 回帰テスト: 音符/休符/タイ音長の直前に space・tab を書ける記法(バッチ4)。
//
// 経緯: 第三者実データ(MULE_op_loop.MML:122、リポジトリには非同梱)に
// `...f12a12g 12f12` のような、音名`g`と音長`12`の間に半角スペースが1個
// 入る書き方があり、以前の実装は「未対応の文字です: '1'」で落ちていた。
//
// 一次資料: PMDMML.MAN §1-3「数値表記の方法」(http://phroneris.com/music/
// pmdmml-man/pmdmml-man.html で内容確認)に明記:
//   「コマンド名とパラメータ数値の間は、spaceまたはtabで空白を空けても
//   構いませんが、数値が続く場合のカンマ等は、数値の直後にある必要が
//   あります。」
//   [例4] `MA 12, 1, 8, 2` -> 「間のspaceは無視され、MA12,1,8,2と同等になります。」
//   [失敗例] `MB 12 , 1 , 8 , 2` -> 「エラー。数値とカンマの間にはspaceは
//   空けられません。」
// これは特定コマンドだけの例外ではなく§1-3という数値表記全般の規則であり、
// 音符名(c/d/e/f/g/a/b)も「コマンド名」の一種として同じ規則の対象になる。
// そのため compiler/pmd_mml_parser.mjs の readLengthSpec()(tokenizeBody・
// tokenizeRhythmPatternBodyの両方)で、音長数値を読む**直前**のspace/tabを
// 1回だけ許容するようにした。数値の**後ろ側**(カンマの前など)の空白までは
// 緩めていない(§1-3の失敗例の通り、そちらは引き続きエラーにすべき)。
//
// 実行: node tools/verify_pmd_note_length_leading_space.mjs

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { compileMml } from '../compiler/pmd_mml_compiler.mjs';

let passCount = 0;
let failCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

function hex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function compileTrackABytes(body) {
  const source = `A ${body}\n`;
  const { file, errors, layout } = compileMml(source);
  if (errors.length > 0) {
    throw new Error(`コンパイル失敗: ${JSON.stringify(errors)}`);
  }
  const { startAddr, termAddr } = layout.tracks.A;
  return file.subarray(1 + startAddr, 1 + termAddr);
}

function main() {
  // 1. 音符名と音長の間のspace(実データそのままの形): `g 12` は `g12` と同一バイト列。
  {
    const spaced = compileTrackABytes('o4 g 12');
    const tight = compileTrackABytes('o4 g12');
    check('音符と音長の間にspaceがある`g 12`は`g12`と同一バイト列になる(PMDMML.MAN §1-3)',
      arraysEqual(spaced, tight), `spaced=${hex(spaced)} tight=${hex(tight)}`);
  }

  // 2. tabでも同様。
  {
    const spaced = compileTrackABytes('o4 g\t12');
    const tight = compileTrackABytes('o4 g12');
    check('音符と音長の間にtabがある`g\\t12`は`g12`と同一バイト列になる',
      arraysEqual(spaced, tight), `spaced=${hex(spaced)} tight=${hex(tight)}`);
  }

  // 3. 実データそのままの複合パターン(MULE_op_loop.MML:122の一部)がエラーにならない。
  {
    const { errors } = compileMml('A q5cc16c16f4&f12c12f12a12g 12f12\n');
    check('実データ由来のパターン(f4&f12c12f12a12g 12f12)がエラーにならない',
      errors.length === 0, JSON.stringify(errors));
  }

  // 4. 休符(r)でも同様に効く。
  {
    const spaced = compileTrackABytes('r 8');
    const tight = compileTrackABytes('r8');
    check('休符と音長の間のspace(`r 8`)も`r8`と同一バイト列になる',
      arraysEqual(spaced, tight), `spaced=${hex(spaced)} tight=${hex(tight)}`);
  }

  // 5. 音長の**後ろ側**は緩めていない: `q5,10 ,3`のように数値とカンマの間に
  //    spaceがあるケースは§1-3の失敗例通り引き続きエラーになるべき(過剰に
  //    緩めていないことの確認)。
  {
    const { errors } = compileMml('A q5 ,10\n');
    check('数値とカンマの間のspace(`q5 ,10`)は引き続きエラーになる(過剰緩和防止)',
      errors.length > 0, JSON.stringify(errors));
  }

  // 6. [陽性対照] readLengthSpec先頭の空白スキップを無効化すると、上の1が
  //    実際に落ちることを確認する(子プロセスでモジュールを読み直させる)。
  {
    const parserPath = new URL('../compiler/pmd_mml_parser.mjs', import.meta.url);
    const orig = fs.readFileSync(parserPath, 'utf8');
    const NEEDLE = "while (body[i] === ' ' || body[i] === '\\t') i++;\n    if (body[i] === '%') {\n      i++;\n      const m = /^\\d+/.exec(body.slice(i));\n      if (!m) throw new ParseError(line, `'%' の後に数値がありません`);\n      i += m[0].length;\n      return parseInt(m[0], 10);\n    }\n    const m = /^\\d+/.exec(body.slice(i));\n    let clocks;\n    if (m) {\n      i += m[0].length;\n      clocks = numericLengthToClocks(parseInt(m[0], 10), line, globalState.measLen);\n    } else {\n      clocks = resolveDefaultLengthClocks(state.defaultLengthSpec, globalState, line);\n    }\n    let dots = 0;\n    while (body[i] === '.') { dots++; i++; }\n    return dots > 0 ? applyDots(clocks, dots, line) : clocks;\n  }\n\n  // '(' ')'";
    if (!orig.includes(NEEDLE)) {
      throw new Error('陽性対照用のパッチ対象コードが見つかりません(製品コードが変更された可能性)');
    }
    const broken = orig.replace(NEEDLE, NEEDLE.replace("while (body[i] === ' ' || body[i] === '\\t') i++;\n    if (body[i] === '%') {", "if (false) { /* space-skip disabled for positive control */ }\n    if (body[i] === '%') {"));
    fs.writeFileSync(parserPath, broken, 'utf8');
    try {
      const compilerUrl = new URL('../compiler/pmd_mml_compiler.mjs', import.meta.url).href;
      const script = `
        import('${compilerUrl}').then(({ compileMml }) => {
          const r = compileMml('A o4 g 12\\n');
          process.stdout.write(JSON.stringify({ errors: r.errors }));
        }).catch((e) => { process.stdout.write(JSON.stringify({ threw: String(e && e.message) })); });
      `;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
      const parsed = JSON.parse(out);
      const failed = parsed.threw || (parsed.errors && parsed.errors.length > 0);
      check('[陽性対照] 空白スキップを無効化すると`g 12`のコンパイルが失敗する', !!failed, out);
    } finally {
      fs.writeFileSync(parserPath, orig, 'utf8');
    }
  }

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main();
