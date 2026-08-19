#!/usr/bin/env node
// 回帰テスト: `C`(全音符長)を変更したあと、デフォルト音長`l`のクロック値を
// その時点の新しい`C`から都度再計算すること。
//
// 経緯: `l4`は「全音符の4分の1」という**比率**の指定であり、`l4`確定時点の
// クロック値を固定で持ち回るのは誤り。`C`を書き換えた後に無指定の音符/休符が
// 出てくれば、その時点の`C`を元に再計算しなければならない。
// 2026-08-19、MC.EXE ver4.8s実測(tools/pmd-reference/pmdwhole.mml、参照.M実測):
//   `A C72 o4 l4 c`  → c(無指定=l4適用)は 72/4=18クロック
//   `A C132 d`       → d(無指定=l4適用)は 132/4=33クロック(18のままではない)
//   `A C204 e`       → e(無指定=l4適用)は 204/4=51クロック(18のままではない)
// パートAの参照.M実バイト: df 48 30 12 df 84 32 21 df cc 34 33 80
// (0x12=18, 0x21=33, 0x33=51。旧実装はいずれも0x12=18のまま使い回していた)。
//
// Rパターン内の無指定`r`が参照元Kのその時点のデフォルト音長を継承する既存実装
// (ensurePatternCompiled)と同じ原則を、通常パート(tokenizeBody)・Rパターン本体
// (tokenizeRhythmPatternBody)の両方で共有する(resolveDefaultLengthClocks)。
//
// 実行: node tools/verify_pmd_c_relength_default_length.mjs

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

function main() {
  // 1. pmdwhole.mmlそのもの(参照.M実測ケース、docs参照)と同じ内容をインラインで
  //    再現し、パートAのバイト列が期待通り(C変更ごとにl4のクロック値が再計算
  //    される)であることを確認する。
  {
    const src = '#Title RelengthTest\nA C72 o4 l4 c\nA C132 d\nA C204 e\n';
    const r = compileMml(src, {});
    check('コンパイルエラーが無い', (r.errors ?? []).length === 0, JSON.stringify(r.errors));
    const events = r.layout?.tracks?.A?.events ?? [];
    const notes = events.filter((e) => e.type === 'note');
    check('音符イベントが3個ある', notes.length === 3, JSON.stringify(notes.map((n) => n.clocks)));
    check('1音目(C72直後のl4無指定c)は72/4=18クロック', notes[0]?.clocks === 18, `clocks=${notes[0]?.clocks}`);
    check('2音目(C132変更後の無指定d)は132/4=33クロック(18のままではない)', notes[1]?.clocks === 33, `clocks=${notes[1]?.clocks}`);
    check('3音目(C204変更後の無指定e)は204/4=51クロック(18のままではない)', notes[2]?.clocks === 51, `clocks=${notes[2]?.clocks}`);
  }

  // 2. 付点付きのデフォルト音長(l4.)でも同様に、Cが変わった後の付点込みクロック値が
  //    再計算されることを確認する(l4.はC=96で27クロック、C=192なら54クロック)。
  {
    const src = 'A C96 o4 l4. c\nA C192 d\n';
    const r = compileMml(src, {});
    check('付点ケース: コンパイルエラーが無い', (r.errors ?? []).length === 0, JSON.stringify(r.errors));
    const notes = (r.layout?.tracks?.A?.events ?? []).filter((e) => e.type === 'note');
    check('付点ケース1音目(C96のl4.)は24*1.5=36クロック',
      notes[0]?.clocks === 36, `clocks=${notes[0]?.clocks}`);
    check('付点ケース2音目(C192変更後のl4.)は48*1.5=72クロック(36のままではない)',
      notes[1]?.clocks === 72, `clocks=${notes[1]?.clocks}`);
  }

  // 3. 明示的な音長指定(`c8`のように音符に直接書く場合)はその場のCから即座に
  //    確定するため、後続のC変更では影響を受けないことを確認する(l由来の
  //    デフォルト音長とは異なる既存の正しい挙動を壊していないことの確認)。
  {
    const src = 'A C96 o4 c8\nA C192 d8\n';
    const r = compileMml(src, {});
    const notes = (r.layout?.tracks?.A?.events ?? []).filter((e) => e.type === 'note');
    check('明示指定c8(C96)は96/8=12クロックのまま', notes[0]?.clocks === 12, `clocks=${notes[0]?.clocks}`);
    check('明示指定d8(C192)は192/8=24クロック(それぞれのCの時点で確定・相互に影響しない)',
      notes[1]?.clocks === 24, `clocks=${notes[1]?.clocks}`);
  }

  // 4. [陽性対照] resolveDefaultLengthClocksを使わず、旧実装のように'l'確定時の
  //    クロック値を固定で持ち回る形へ製品コードを一時的に壊すと、上の1が
  //    実際に落ちることを確認する(子プロセスでモジュールを読み直させる)。
  {
    const parserPath = new URL('../compiler/pmd_mml_parser.mjs', import.meta.url);
    const orig = fs.readFileSync(parserPath, 'utf8');
    const NEEDLE = "const lenN = parseInt(m[0], 10);\n      // その時点のCに対する妥当性(約数かどうか)はここで検証しておく。実際に使われる\n      // クロック値は、後で音符/休符を読む時点のC(その時点でさらに変わっている\n      // 可能性がある)から都度再計算する(resolveDefaultLengthClocks参照)。\n      numericLengthToClocks(lenN, line, globalState.measLen);\n      let dots = 0;\n      while (body[i] === '.') { dots++; i++; }\n      // 'o'/'<'/'>'と同じ理由でactive時のみ適用する(2026-08-19、実データでの直接確認は\n      // 無いが、Skip Control 1の対象外部分が状態を変更しないという同一原則から適用)。\n      if (active) state.defaultLengthSpec = { n: lenN, dots };\n      continue;\n    }\n    if (c === 'L') { i++; events.push({ type: 'globalLoop', line }); continue; }";
    if (!orig.includes(NEEDLE)) {
      throw new Error('陽性対照用のパッチ対象コードが見つかりません(製品コードが変更された可能性)');
    }
    // 旧実装を再現: 'l'確定時に一度だけクロック値へ解決し、以後Cが変わっても
    // 再計算しない固定値として持ち回る(バグを再現するパッチ)。
    const brokenSnippet = "const lenN = parseInt(m[0], 10);\n      let __fixedClocks = numericLengthToClocks(lenN, line, globalState.measLen);\n      let dots = 0;\n      while (body[i] === '.') { dots++; i++; }\n      if (dots > 0) __fixedClocks = applyDots(__fixedClocks, dots, line);\n      if (active) state.defaultLengthSpec = { n: lenN, dots, __FIXED_CLOCKS_POSITIVE_CONTROL__: __fixedClocks };\n      continue;\n    }\n    if (c === 'L') { i++; events.push({ type: 'globalLoop', line }); continue; }";
    let broken = orig.replace(NEEDLE, brokenSnippet);
    // resolveDefaultLengthClocksを、固定値があればそれを使う(=Cの変化を無視する)よう壊す。
    const RESOLVE_NEEDLE = 'function resolveDefaultLengthClocks(spec, globalState, line) {\n  let clocks = numericLengthToClocks(spec.n, line, globalState.measLen);\n  if (spec.dots > 0) clocks = applyDots(clocks, spec.dots, line);\n  return clocks;\n}';
    if (!broken.includes(RESOLVE_NEEDLE)) {
      throw new Error('陽性対照用のパッチ対象コード(resolveDefaultLengthClocks)が見つかりません(製品コードが変更された可能性)');
    }
    broken = broken.replace(RESOLVE_NEEDLE, 'function resolveDefaultLengthClocks(spec, globalState, line) {\n  if (spec.__FIXED_CLOCKS_POSITIVE_CONTROL__ != null) return spec.__FIXED_CLOCKS_POSITIVE_CONTROL__;\n  let clocks = numericLengthToClocks(spec.n, line, globalState.measLen);\n  if (spec.dots > 0) clocks = applyDots(clocks, spec.dots, line);\n  return clocks;\n}');
    fs.writeFileSync(parserPath, broken, 'utf8');
    try {
      const compilerUrl = new URL('../compiler/pmd_mml_compiler.mjs', import.meta.url).href;
      const script = `
        import('${compilerUrl}').then(({ compileMml }) => {
          const r = compileMml('A C72 o4 l4 c\\nA C132 d\\nA C204 e\\n');
          const notes = (r.layout?.tracks?.A?.events ?? []).filter((e) => e.type === 'note');
          process.stdout.write(JSON.stringify({ clocks: notes.map((n) => n.clocks) }));
        }).catch((e) => { process.stdout.write(JSON.stringify({ threw: String(e && e.message) })); });
      `;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
      const parsed = JSON.parse(out);
      const stillBuggy = parsed.threw || (Array.isArray(parsed.clocks) && parsed.clocks[1] === 18 && parsed.clocks[2] === 18);
      check('[陽性対照] Cの再計算を無効化すると2音目・3音目が18クロックのまま(バグ再現)に戻る(検出器が機能している証拠)',
        !!stillBuggy, out);
    } finally {
      fs.writeFileSync(parserPath, orig, 'utf8');
    }
  }

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main();
