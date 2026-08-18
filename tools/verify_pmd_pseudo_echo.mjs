#!/usr/bin/env node
// 回帰テスト(バッチ5): W(擬似エコー、PMDMML.MAN §12-2)のコンパイル時展開。
//
// 2026-08-19、WebNP2+FreeDOS上の実機MC.EXE ver4.8sをPW.MML/PW2.MML/PW3.MMLで実測し、
// 「後続の音符すべてに作用し続ける、コンパイル時にnoteイベント列へ展開される
// コンパイラ機能」だと確定した(tools/pmd-reference/pmdwecho*.mml・FINDINGS.md項目6
// 参照。参照.Mとのバイト完全一致は tools/verify_pmd_reference_corpus.mjs 側で検証済み)。
// 仕様:
//   - `W<seg>,<d>` は以降のプレーンな音符トークン(c/d/e/f/g/a/b)を seg ティックずつに
//     分割し(最後の断片は端数、合計は元の音長)、切れ目ごとに0xdd(d<0)/0xde(d>0)+1byte
//     を挟む。引数はk番目(1始まり、音符ごとにリセット)の切れ目で min(|d|*k,15)*4。
//   - d=0 は分割だけ行いコマンドを出さない(解除ではない)。
//
// このファイルはevent列(type/clocks/value)を直接検査する。実機参照.Mとのバイト単位の
// 一致はtools/verify_pmd_reference_corpus.mjs(pmdwecho/pmdwecho2/pmdwecho3)側の担当。
//
// 実行: node tools/verify_pmd_pseudo_echo.mjs

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

function compileTrackA(mmlBody) {
  const r = compileMml(`A ${mmlBody}\n`, {});
  if (r.errors.length > 0) throw new Error(`compile failed: ${JSON.stringify(r.errors)}`);
  return r.layout.tracks.A.events.map((e) => {
    if (e.type === 'note') return ['note', e.clocks];
    if (e.type === 'pseudoEcho') return ['echo', e.sign, e.value];
    return [e.type];
  });
}

function main() {
  // 1. W6,-5 c (l4=24=6*4): 4分割、切れ目ごとにdd。min(5k,15)*4 for k=1,2,3 = 20,40,60。
  {
    const actual = compileTrackA('o4 l4 W6,-5 c');
    const expected = [
      ['note', 6], ['echo', -1, 20],
      ['note', 6], ['echo', -1, 40],
      ['note', 6], ['echo', -1, 60],
      ['note', 6],
    ];
    check('W6,-5 c(l4=24) が 4分割+3個のddに展開される(PW.MML実測どおり)',
      JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(actual));
  }

  // 2. W12,-5 c (l4=24=12*2): 2分割、切れ目1個。min(5*1,15)*4=20。
  {
    const actual = compileTrackA('o4 l4 W12,-5 c');
    const expected = [['note', 12], ['echo', -1, 20], ['note', 12]];
    check('W12,-5 c(l4=24) が 2分割+1個のddに展開される(PW2.MML実測どおり)',
      JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(actual));
  }

  // 3. W6,-10 c: min(10k,15)*4 for k=1,2,3 = 40,60,60(クランプ)。
  {
    const actual = compileTrackA('o4 l4 W6,-10 c');
    const expected = [
      ['note', 6], ['echo', -1, 40],
      ['note', 6], ['echo', -1, 60],
      ['note', 6], ['echo', -1, 60],
      ['note', 6],
    ];
    check('W6,-10 c が 15クランプされた引数(40,60,60)で展開される(PW2.MML実測どおり)',
      JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(actual));
  }

  // 4. W6,5 c: 正のdは0xde(sign=+1)。引数はW6,-5と同じ計算式(20,40,60)。
  {
    const actual = compileTrackA('o4 l4 W6,5 c');
    const expected = [
      ['note', 6], ['echo', 1, 20],
      ['note', 6], ['echo', 1, 40],
      ['note', 6], ['echo', 1, 60],
      ['note', 6],
    ];
    check('W6,5 c は正のdなのでsign=+1(0xde)で展開される(PW2.MML実測どおり)',
      JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(actual));
  }

  // 5. W6,-5 cd: cとdの両方が展開され、dの側もk=1から数え直す(カウンタは音符ごとにリセット)。
  //    音程dはo4でnoteIndex=2(NOTE_LETTER_TO_BASE_INDEX)。
  {
    const r = compileMml('A o4 l4 W6,-5 cd\n', {});
    const events = r.layout.tracks.A.events;
    const notes = events.filter((e) => e.type === 'note').map((e) => e.noteIndex);
    const echoValuesInOrder = events.filter((e) => e.type === 'pseudoEcho').map((e) => e.value);
    check('W6,-5 cd はcとdの両方の音程が現れる(c=0,d=2)', JSON.stringify(notes) === JSON.stringify([0, 0, 0, 0, 2, 2, 2, 2]), JSON.stringify(notes));
    check('W6,-5 cd のecho引数はd側もk=1から数え直す(20,40,60,20,40,60)',
      JSON.stringify(echoValuesInOrder) === JSON.stringify([20, 40, 60, 20, 40, 60]), JSON.stringify(echoValuesInOrder));
  }

  // 6. W6,-5 c W6,0 d: d=0は分割だけ行いechoコマンドは出ない(解除ではなく分割は継続)。
  {
    const r = compileMml('A o4 l4 W6,-5 c W6,0 d\n', {});
    const events = r.layout.tracks.A.events;
    const notes = events.filter((e) => e.type === 'note');
    const echoes = events.filter((e) => e.type === 'pseudoEcho');
    check('W6,-5 c W6,0 d はcが4分割・dも4分割される(合計8個のnoteイベント)', notes.length === 8, `notes.length=${notes.length}`);
    check('W6,-5 c W6,0 d のechoイベントはcの3個だけ(dの3箇所ではd=0なので出ない)', echoes.length === 3, `echoes.length=${echoes.length}`);
  }

  // 7. [陽性対照] 分割ロジック(seg単位のwhileループ)を無効化する(=常に1回で全長を出す)と、
  //    上の1番(4分割)が実際に検出できなくなることを確認する。
  {
    const parserPath = new URL('../compiler/pmd_mml_parser.mjs', import.meta.url);
    const orig = fs.readFileSync(parserPath, 'utf8');
    const NEEDLE = 'function pushEchoAwareNote(octave, noteIndex, clocks) {\n    const echo = state.echo;\n    if (!echo) { events.push({ type: \'note\', line, octave, noteIndex, clocks }); return; }';
    if (!orig.includes(NEEDLE)) {
      throw new Error('陽性対照用のパッチ対象コードが見つかりません(製品コードが変更された可能性)');
    }
    const broken = orig.replace(NEEDLE,
      'function pushEchoAwareNote(octave, noteIndex, clocks) {\n    const echo = null; // 陽性対照で無効化\n    if (!echo) { events.push({ type: \'note\', line, octave, noteIndex, clocks }); return; }');
    if (broken === orig) throw new Error('陽性対照用のパッチが効いていません');
    fs.writeFileSync(parserPath, broken, 'utf8');
    try {
      const compilerUrl = new URL('../compiler/pmd_mml_compiler.mjs', import.meta.url).href;
      const script = `
        import('${compilerUrl}').then(({ compileMml }) => {
          const r = compileMml('A o4 l4 W6,-5 c\\n', {});
          const notes = r.layout ? r.layout.tracks.A.events.filter(e => e.type === 'note').length : null;
          process.stdout.write(JSON.stringify({ errors: r.errors, notes }));
        }).catch((e) => { process.stdout.write(JSON.stringify({ threw: String(e && e.message) })); });
      `;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
      const parsed = JSON.parse(out);
      const brokenDetected = parsed.threw || parsed.notes !== 4;
      check('[陽性対照] W展開の分割ロジックを無効化すると 4分割にならない(検出器が機能している証拠)', !!brokenDetected, out);
    } finally {
      fs.writeFileSync(parserPath, orig, 'utf8');
    }
  }

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main();
