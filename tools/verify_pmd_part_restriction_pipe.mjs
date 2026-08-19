#!/usr/bin/env node
// 回帰テスト: `|`によるパート限定(MML Skip Control 1、PMDMML.MAN §16-2)。
//
// WebFetch実測(pigu-a.github.io/pmddocs/pmdmml.htm "16.2. MML Skip Control 1"):
//   Format: `| [part letters]`。Sound Source: All。
//   - `|`単独(パート文字なし)は全パートを対象に戻す(限定解除)。
//   - `|ABC`はA/B/Cのみを対象にする。
//   - `|!ABC`はA/B/C以外を対象にする(`!`で反転)。
// 実データ第三者MML(バッチ2作業)に頻出する`ABI |AB o5 @183|I o4@1|  e32&...`・
// `ADG o4 |G <|`のような、複数パートへ同じ行で別々の内容を割り当てる記法に対応する。
//
// 実行: node tools/verify_pmd_part_restriction_pipe.mjs

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
  return r;
}

function noteIndexes(r, part) {
  return r.layout.tracks[part].events.filter((e) => e.type === 'note').map((e) => e.noteIndex);
}

function main() {
  // 1. `|A ...|B ...|`: 同じ行でAとBに別々の内容を割り当てる
  //    (実データ`ABI |AB o5 @183|I o4@1|...`と同型)。
  {
    const r = compileOk('AB @1 o4 |A c4|B d4|');
    check('|A c4|B d4| でAはc(noteIndex=0)のみを受け取る', JSON.stringify(noteIndexes(r, 'A')) === '[0]',
      JSON.stringify(noteIndexes(r, 'A')));
    check('|A c4|B d4| でBはd(noteIndex=2)のみを受け取る', JSON.stringify(noteIndexes(r, 'B')) === '[2]',
      JSON.stringify(noteIndexes(r, 'B')));
  }

  // 2. `!`による反転(`|!A ...`はA以外が対象)。
  {
    const r = compileOk('ABC @1 o4 |!A c4|');
    check('|!A c4| でAには積まれない', noteIndexes(r, 'A').length === 0, JSON.stringify(noteIndexes(r, 'A')));
    check('|!A c4| でBには積まれる', JSON.stringify(noteIndexes(r, 'B')) === '[0]', JSON.stringify(noteIndexes(r, 'B')));
    check('|!A c4| でCには積まれる', JSON.stringify(noteIndexes(r, 'C')) === '[0]', JSON.stringify(noteIndexes(r, 'C')));
  }

  // 3. パート文字なしの`|`(限定解除)は、単独の飾り(「小節線」的用法)として
  //    無視される: 前後に限定が無ければno-opで、`c4|d4`は`c4d4`と同一の
  //    イベント列になる(実データにあるような、ただの区切りとしての`|`)。
  {
    const withBar = compileOk('A @1 o4 c4|d4');
    const withoutBar = compileOk('A @1 o4 c4d4');
    check('c4|d4 の装飾的な"|"は無視され c4d4 と同一イベント列になる',
      JSON.stringify(withBar.layout.tracks.A.events) === JSON.stringify(withoutBar.layout.tracks.A.events));
  }

  // 4. `|`直後にスペース無しで小文字の音符が続く場合(実データ`...|H f32|<`)、
  //    音符名(小文字)をパート指定として誤って呑み込まないこと。
  //    (`AD`ヘッダで、パート文字'D'と音符名'd'の大小文字衝突を突く回帰。)
  {
    const r = compileOk('AD @1 o4 |A c4|d4');
    // 限定解除直後の'd4'はAD両方に積まれる(パート指定として消費されない)。
    check("|A c4|d4 で限定解除直後の'd4'は音符として両パートに積まれる(パート指定として誤消費されない)",
      JSON.stringify(noteIndexes(r, 'A')) === '[0,2]' && JSON.stringify(noteIndexes(r, 'D')) === '[2]',
      `A=${JSON.stringify(noteIndexes(r, 'A'))} D=${JSON.stringify(noteIndexes(r, 'D'))}`);
  }

  // 5. パート限定は行をまたいで持ち越さない(次の行は既定で全パート対象に戻る)。
  {
    const r = compileOk('AB @1 o4 |A c4|\nAB d4');
    check('限定は行末で終わり、次の行はABとも普通に積まれる',
      JSON.stringify(noteIndexes(r, 'A')) === '[0,2]' && JSON.stringify(noteIndexes(r, 'B')) === '[2]',
      `A=${JSON.stringify(noteIndexes(r, 'A'))} B=${JSON.stringify(noteIndexes(r, 'B'))}`);
  }

  // 6. 対象外の間の`&<音長>`(バッチ2-1のタイ短縮記法)は、直前音符が無くても
  //    構文エラーにならない(その内容はそもそもこのパート向けではないため)。
  {
    const r = compileMml('AB @1 o4 |A c4&2|B d4|', { tones: { 1: {} } });
    check('Bにとって無関係な区間の"&2"はエラーにならない', r.errors.length === 0, JSON.stringify(r.errors));
  }

  // 7. 対象外の間の'o'/'<'/'>'/'l'は、そのパートのオクターブ・デフォルト音長状態を
  //    変更しない(2026-08-19実データ実測、MSO_ET_Virtual_Intensity_88.MML
  //    「ABI |AB o5 @183|I o4@1| e32&...」。Aパート向けに`|AB o5`でo5にした直後、
  //    `|I o4@1|`(I専用のはずのo4)がAの状態まで書き換えてしまい、参照.Mより
  //    1オクターブ低いノートを出力していたバグ)。
  {
    const r = compileOk('ABI @1 o3 |AB o5|I o4|c4');
    check("|AB o5|I o4|c4 でAは対象外区間のI向けo4に汚染されずo5のままc(内部表現oct-1=4)を出す",
      JSON.stringify(r.layout.tracks.A.events.filter((e) => e.type === 'note').map((e) => e.octave)) === '[4]',
      JSON.stringify(r.layout.tracks.A.events.filter((e) => e.type === 'note').map((e) => e.octave)));
    check("同じ理由でIは自分向けのo4どおりc(内部表現oct-1=3)を出す",
      JSON.stringify(r.layout.tracks.I.events.filter((e) => e.type === 'note').map((e) => e.octave)) === '[3]',
      JSON.stringify(r.layout.tracks.I.events.filter((e) => e.type === 'note').map((e) => e.octave)));
  }
  {
    const r = compileOk('AB @1 o4 |A l4|B l8|c');
    check("|A l4|B l8|c でAは対象外のB向けl8に汚染されずl4(clocks=24)のcを出す",
      r.layout.tracks.A.events.find((e) => e.type === 'note')?.clocks === 24,
      JSON.stringify(r.layout.tracks.A.events.find((e) => e.type === 'note')));
  }

  // 8. [陽性対照] 上の7の"active時のみ状態を更新する"実装を無効化すると、
  //    実際にオクターブ漏れが再現することを確認する(子プロセスで検証、理由は6と同じ)。
  {
    const parserPath = new URL('../compiler/pmd_mml_parser.mjs', import.meta.url);
    const orig = fs.readFileSync(parserPath, 'utf8');
    const NEEDLE = 'if (active) state.octave = oct - 1;';
    const count = orig.split(NEEDLE).length - 1;
    if (count !== 1) {
      throw new Error(`陽性対照用のパッチ対象コードが見つかりません(想定1箇所、実際${count}箇所)`);
    }
    const broken = orig.replace(NEEDLE, 'state.octave = oct - 1;');
    fs.writeFileSync(parserPath, broken, 'utf8');
    try {
      const compilerUrl = new URL('../compiler/pmd_mml_compiler.mjs', import.meta.url).href;
      const script = `
        import('${compilerUrl}').then(({ compileMml }) => {
          const r = compileMml('ABI @1 o3 |AB o5|I o4|c4', { tones: { 1: {} } });
          const a = r.layout ? r.layout.tracks.A.events.filter(e => e.type === 'note').map(e => e.octave) : null;
          process.stdout.write(JSON.stringify({ errors: r.errors, a }));
        }).catch((e) => { process.stdout.write(JSON.stringify({ threw: String(e && e.message) })); });
      `;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
      const parsed = JSON.parse(out);
      // 壊した状態では、I向けのo4がAへ漏れてoctave=3(o4相当)になってしまうはず(o5=4ではなく)。
      const leaked = parsed.a && parsed.a[0] === 3; // I向けo4=内部表現3がAへ漏れる
      check('[陽性対照] active判定を無効化するとI向けo4がAへ漏れる(検出器が機能している証拠)', !!leaked, out);
    } finally {
      fs.writeFileSync(parserPath, orig, 'utf8');
    }
  }

  // 9. [陽性対照] パート限定の実装(active判定)を無効化すると、上の1が実際に
  //    崩れることを確認する(子プロセスで新しいモジュールグラフとして読み直す。
  //    同一プロセス内でのdynamic importはNodeのESMキャッシュにより無効化できない)。
  {
    const parserPath = new URL('../compiler/pmd_mml_parser.mjs', import.meta.url);
    const orig = fs.readFileSync(parserPath, 'utf8');
    const NEEDLE = 'let active = true;';
    const count = orig.split(NEEDLE).length - 1;
    if (count !== 1) {
      throw new Error(`陽性対照用のパッチ対象コードが見つかりません(想定1箇所、実際${count}箇所)`);
    }
    // active を常にtrueへ固定する(=パート限定を無かったことにする)。
    const broken = orig.replace(NEEDLE, 'let active = true; const __forceActive = true;')
      .replace(/active = negate \? !included : included;/, 'active = __forceActive || (negate ? !included : included);')
      .replace(/active = true; \/\/ 対象指定なし\(`!`だけの場合も含む\) = 限定解除/, 'active = true;');
    if (broken === orig) {
      throw new Error('陽性対照用のパッチが効いていません(製品コードが変更された可能性)');
    }
    fs.writeFileSync(parserPath, broken, 'utf8');
    try {
      const compilerUrl = new URL('../compiler/pmd_mml_compiler.mjs', import.meta.url).href;
      const script = `
        import('${compilerUrl}').then(({ compileMml }) => {
          const r = compileMml('AB @1 o4 |A c4|B d4|', { tones: { 1: {} } });
          const a = r.layout ? r.layout.tracks.A.events.filter(e => e.type === 'note').map(e => e.noteIndex) : null;
          process.stdout.write(JSON.stringify({ errors: r.errors, a }));
        }).catch((e) => { process.stdout.write(JSON.stringify({ threw: String(e && e.message) })); });
      `;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
      const parsed = JSON.parse(out);
      // 壊した状態では、B向けの内容(noteIndex=2, 'd')までAへ漏れて積まれるはず。
      const leaked = parsed.a && parsed.a.includes(2);
      check('[陽性対照] パート限定を無効化するとBの内容がAへ漏れる(検出器が機能している証拠)', !!leaked, out);
    } finally {
      fs.writeFileSync(parserPath, orig, 'utf8');
    }
  }

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main();
