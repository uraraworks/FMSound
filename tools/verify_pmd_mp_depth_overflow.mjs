#!/usr/bin/env node
// 回帰テスト: `MP`/`MPA`/`MPB`(上昇/下降専用LFO指定、PMDMML.MAN §9-6)の
// 数値1(depth)が、マニュアル記載の範囲(-128〜127)を超えるケース(バッチ4)。
//
// 経緯: 第三者実データ(MULE_op_loop.MML、リポジトリには非同梱)に`MP-230`が
// 6箇所あり、以前の実装は「§9-6の-128〜127」をそのまま入力値の妥当性検査に
// 使っていたためエラーになっていた。提供元は当該MML 8本すべてを
// PMD公式コンパイラ`MC.EXE` ver4.8lで実際にコンパイル確認済みと明記しており、
// 少なくとも実機コンパイラは`-230`を拒否しない。
//
// 一次資料での確認:
//   - PMDMML.MAN §9-6(wikiwiki.jp thtools「PMD version4.8 コマンドマニュアル_3」
//     実測): 「[数値1] -128〜+127」「実際にはMA(またはMB) 数値2,数値3,数値1,255
//     とするのと同じ」。
//   - upstream/98fmplayer/fmdriver/fmdriver_pmd.c の pmd_lfo_tick_waveform
//     (約515行目、`int16_t deptha = u8s8(part->lfo.step);`)を見ると、`.M`側の
//     depthは常に1byte(u8s8変換)としてしか読まれておらず、16bit格納の余地は
//     無い(「depthは実は16bitではないか」という作業仮説は上記により棄却した)。
// 以上から、MC.EXEは数値1の範囲チェックをせず、Cのsigned charへの代入と同じ
// 2の補数切り捨てで1byteへ書き出していると考えるのが両資料と矛盾しない
// 唯一の説明であり、compiler/pmd_mml_parser.mjsもこれに合わせて「mod 256で
// -128〜127へ正規化してから受理する」実装にした(拒否ではなく切り捨て)。
//
// 【実測済み】2026-08-19、WebNP2+FreeDOS上の実機MC.EXE ver4.8sをPMP.MMLで実測し、
// 「mod 256切り捨て」という出力バイトの式そのものを直接確認した(バッチ5)。
// `MP-230`と`MP26`をコンパイルした参照.Mはバイト完全一致(どちらもdepthA=0x1a=26)で、
// 上の推論(2の補数切り捨て)が実機の挙動そのものであると裏付けられた
// (tools/pmd-reference/pmdmpover.mml・pmdmpover.M、FINDINGS.md項目5参照)。
//
// 実行: node tools/verify_pmd_mp_depth_overflow.mjs

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
  // 1. 実データ由来の値: MP-230はエラーにならず、depthAは-230 mod 256 = 26(0x1a)。
  {
    const actual = compileTrackABytes('MP-230');
    const expected = [0xf2, 0, 1, 0x1a, 0xff, 0xf1, 1];
    check('MP-230(実データMULE_op_loop.MML由来)はエラーにならず、depthAが26(0x1a)へ切り捨てられる',
      arraysEqual(actual, expected), `actual=${hex(actual)}`);

    const wrong = [0xf2, 0, 1, 0x1a, 0xff, 0xf1, 2];
    check('[陽性対照] MP-230の出力は*スイッチ値が1違う誤り期待値とは一致しない',
      !arraysEqual(actual, wrong), `actual=${hex(actual)} wrong=${hex(wrong)}`);
  }

  // 2. 正方向の範囲外(200)も同様に切り捨てられる(200 mod 256 = 200 -> signed -56、
  //    生バイトは0xc8で200のそれと同じ)。
  {
    const actual = compileTrackABytes('MP200');
    const expected = [0xf2, 0, 1, 0xc8, 0xff, 0xf1, 1];
    check('MP200(範囲外の正方向)もエラーにならずbyte=0xc8へ切り捨てられる',
      arraysEqual(actual, expected), `actual=${hex(actual)}`);
  }

  // 3. 既存の範囲内ケース(MP-77・MPB39、tools/pmd-reference/pmdmp.M実測)が
  //    引き続き変わらないことの回帰確認(既存テストと同じ期待値)。
  {
    const actual = compileTrackABytes('MP-77');
    const expected = [0xf2, 0, 1, 0xb3, 0xff, 0xf1, 1];
    check('MP-77(範囲内、既存の参照.M実測値)は変わらない', arraysEqual(actual, expected), `actual=${hex(actual)}`);

    const actualB = compileTrackABytes('MPB39');
    const expectedB = [0xbf, 0, 1, 39, 0xff, 0xbe, 1];
    check('MPB39(範囲内、既存の参照.M実測値)は変わらない', arraysEqual(actualB, expectedB), `actual=${hex(actualB)}`);
  }

  // 4. [陽性対照] 「範囲外は拒否する」という旧実装へ製品コードを戻すと、
  //    上の1が実際にエラーで落ちることを確認する(子プロセスでモジュールを
  //    読み直させる。同一プロセス内のdynamic importはESMキャッシュにより
  //    無効化できない)。
  {
    const parserPath = new URL('../compiler/pmd_mml_parser.mjs', import.meta.url);
    const orig = fs.readFileSync(parserPath, 'utf8');
    const NEEDLE = 'let depthA = ((depthARaw % 256) + 256) % 256;\n        if (depthA > 127) depthA -= 256;';
    if (!orig.includes(NEEDLE)) {
      throw new Error('陽性対照用のパッチ対象コードが見つかりません(製品コードが変更された可能性)');
    }
    const broken = orig.replace(NEEDLE,
      'let depthA = depthARaw;\n        if (depthA < -128 || depthA > 127) throw new ParseError(line, `FORCED_REJECT: ${depthA}`);');
    fs.writeFileSync(parserPath, broken, 'utf8');
    try {
      const compilerUrl = new URL('../compiler/pmd_mml_compiler.mjs', import.meta.url).href;
      const script = `
        import('${compilerUrl}').then(({ compileMml }) => {
          const r = compileMml('A MP-230\\n');
          process.stdout.write(JSON.stringify({ errors: r.errors }));
        }).catch((e) => { process.stdout.write(JSON.stringify({ threw: String(e && e.message) })); });
      `;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
      const parsed = JSON.parse(out);
      const failed = parsed.threw || (parsed.errors && parsed.errors.length > 0);
      check('[陽性対照] 範囲チェックを旧実装(拒否)へ戻すとMP-230のコンパイルが失敗する', !!failed, out);
    } finally {
      fs.writeFileSync(parserPath, orig, 'utf8');
    }
  }

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main();
