#!/usr/bin/env node
// 回帰テスト(バッチ3a-2): ポルタメント`{ }`内のオクターブ記号(o/</>)の出現位置。
//
// PMDMML.MAN §4-3「{ }の中には、c d e f g a b o > < コマンドのみ指定して下さい」
// (WebFetchで原文確認)は許可文字を列挙するのみで、順序は一切規定していない。
// 旧実装は「音程1の前にo/</>*・その後に音程2の前にo/</>*」という固定順
// (o/</>* note o/</>* note '}')しか受理できず、実データ(DS4_MAIA.mml:176
// `d8&{d<a>}16`)にある「音程2の**後**・'}'の**前**」のオクターブシフトを
// 「'{' に対応する '}' がありません」という誤エラーにしていた。
//
// 実データ実測メモ: 当初の作業指示には「'{'が行をまたぐケースがある」という
// 記載があったが、実際にDS4_MAIA.mml:176を`sed`で確認すると`{d<a>}16`は
// 単一行に収まっており(`cut -c1-72`で確認、108文字の行)、行またぎは発生していない。
// これは事前の自動抽出スクリプトが表示を70文字で打ち切っていたための誤認だった
// (このテストは実データの実際の内容に基づき、単一行内での順序一般化のみを検証する)。
//
// このテストは「o/</>と音程(c/d/e/f/g/a/b)が任意の順序で混在してよく、音程が
// ちょうど2個含まれる」という一般化された読みを、実データに現れる4パターン
// (`{g<g>}` `{d<d>}` `{ef}8&f` `{a-<a->}16` `{d<a>}16`)で確認する。
//
// 実行: node tools/verify_pmd_brace_portamento_octave_order.mjs

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

function main() {
  // 1. 実データDS4_MAIA.mml:176相当: 音程2の後・'}'の前にオクターブシフトが来る形。
  //    `{d<a>}16` = 音程1=d(o4のまま)、音程2=a(o3、<で1つ下げた状態)、
  //    その後 '>' で o4 に戻ってから '}'。戻った後に続く音符(c)がo4であることまで確認する。
  {
    const r = compileOk('A @1 o4 {d<a>}16 c4');
    const portamento = r.layout.tracks.A.events.find((e) => e.type === 'portamento');
    check("'{d<a>}16': 音程1=d(o4)・音程2=a(o3)として解釈される",
      !!portamento && portamento.note1.octave === 3 && portamento.note1.noteIndex === 2
        && portamento.note2.octave === 2 && portamento.note2.noteIndex === 9,
      JSON.stringify(portamento));
    const note = r.layout.tracks.A.events.find((e) => e.type === 'note');
    check("'{d<a>}16' の後の '>' でオクターブがo4に戻り、続く音符cはo4のまま",
      !!note && note.octave === 3 && note.noteIndex === 0, JSON.stringify(note));
  }

  // 2. `{g<g>}`(DS4_MAIA.mml:149相当): 音程1=g(現在オクターブ)、'<'、音程2=g(1つ下)、
  //    '>'で戻る。同じ音程文字を1オクターブ違いでつなぐポルタメント。
  {
    const r = compileOk('A @1 o4 {g<g>}8');
    const p = r.layout.tracks.A.events.find((e) => e.type === 'portamento');
    check("'{g<g>}8': 音程1=g(o4)・音程2=g(o3)",
      !!p && p.note1.octave === 3 && p.note1.noteIndex === 7 && p.note2.octave === 2 && p.note2.noteIndex === 7,
      JSON.stringify(p));
  }

  // 3. `{ef}8&f`(直後に音長・タイが続く形。既存対応の再確認、退行していないこと)。
  {
    const r = compileOk('A @1 o4 {ef}8&f4');
    const p = r.layout.tracks.A.events.find((e) => e.type === 'portamento');
    check("'{ef}8&f4': 音程1=e・音程2=fのポルタメントに続けてタイ+音符fが読める",
      !!p && p.note1.noteIndex === 4 && p.note2.noteIndex === 5, JSON.stringify(p));
  }

  // 4. `{a-<a->}16`(MSO_ET_Virtual_Intensity_88.MML:195相当): 変化記号付きの音程が
  //    オクターブシフトを挟んで2つ。
  {
    const r = compileOk('A @1 o4 {a-<a->}16');
    const p = r.layout.tracks.A.events.find((e) => e.type === 'portamento');
    // a- は noteIndex 9-1=8。
    check("'{a-<a->}16': 音程1=a-(o4)・音程2=a-(o3)",
      !!p && p.note1.octave === 3 && p.note1.noteIndex === 8 && p.note2.octave === 2 && p.note2.noteIndex === 8,
      JSON.stringify(p));
  }

  // 5. 音程が2個ちょうどでない場合(1個・3個)はエラーになる(黙って受理しない)。
  {
    const r1 = compileMml('A @1 o4 {c}4', { tones: { 1: {} } });
    check("'{c}4'(音程1個)はエラーになる", r1.errors.length > 0, JSON.stringify(r1.errors));
    const r2 = compileMml('A @1 o4 {cde}4', { tones: { 1: {} } });
    check("'{cde}4'(音程3個)はエラーになる", r2.errors.length > 0, JSON.stringify(r2.errors));
  }

  // 6. [陽性対照] readBraceNotesの「ちょうど2個」検査を無効化すると、5番(1個エラー)が
  //    実際に落ちる(検出器が機能している証拠)。
  {
    const parserPath = new URL('../compiler/pmd_mml_parser.mjs', import.meta.url);
    const orig = fs.readFileSync(parserPath, 'utf8');
    const NEEDLE = 'if (notes.length !== 2) {';
    if (!orig.includes(NEEDLE)) {
      throw new Error('陽性対照用のパッチ対象コードが見つかりません(製品コードが変更された可能性)');
    }
    const broken = orig.replace(NEEDLE, 'if (false && notes.length !== 2) {');
    if (broken === orig) throw new Error('陽性対照用のパッチが効いていません');
    fs.writeFileSync(parserPath, broken, 'utf8');
    try {
      const compilerUrl = new URL('../compiler/pmd_mml_compiler.mjs', import.meta.url).href;
      const script = `
        import('${compilerUrl}').then(({ compileMml }) => {
          const r = compileMml('A @1 o4 {c}4', { tones: { 1: {} } });
          process.stdout.write(JSON.stringify({ errors: r.errors }));
        }).catch((e) => { process.stdout.write(JSON.stringify({ threw: String(e && e.message) })); });
      `;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
      const parsed = JSON.parse(out);
      // 音程1個の検査を無効化すると、note2が未定義のまま portamento イベントが
      // 積まれる(noteIndex等がundefinedになる)か、少なくとももうエラーにはならない。
      const stillErrors = parsed.errors && parsed.errors.length > 0;
      check('[陽性対照] 「音程ちょうど2個」検査を無効化すると {c}4 がエラーにならなくなる(検出器が機能している証拠)', !stillErrors, out);
    } finally {
      fs.writeFileSync(parserPath, orig, 'utf8');
    }
  }

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main();
