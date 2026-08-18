#!/usr/bin/env node
// PMDMML.MAN ground truth の実測に基づく回帰検証(バッチ1: 行頭・音色定義の解釈)。
// 対象: 装飾コメント行の許容(§1-1-1)/パート指定直後の数字の無視(§1-1-2)/
//       音色定義DTの符号付き表記(§3-1 + YM2612/2608 DT1レジスタのsign-magnitude表現)/
//       Kパートでのテンポコマンド(fmdriver_pmd.c pmd_cmd_table_rhythmの実測)。
//
// 実行: node tools/verify_pmd_mml_lines_and_tone_ground_truth.mjs

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

console.log('--- 1. 装飾コメント行(PMDMML.MAN §1-1-1 Incorrect Example 1)はエラーにならない ---');
{
  const src = '++++++++++++++++++++++++++++++\n++ [  M A I N  T H E M E  ] ++\n---\nA o4 c4\n';
  const { errors } = compileMml(src);
  check('記号のみの装飾行はエラーにならない', errors.length === 0, JSON.stringify(errors));
}
{
  // 陽性対照: 崩れた「文字始まり」の行は引き続きエラーになる(診断価値を残す設計の確認)。
  // (letters始まりの行は"パート指定または未対応パートのどちらか"のエラーになるが、
  // いずれにせよ装飾行のように無条件でスキップされてはいけない)。
  const src = 'A o4 c4\nZZZ this is not decorative but broken\n';
  const { errors } = compileMml(src);
  check('[陽性対照] レター始まりの崩れた行はエラーのまま(装飾行の緩和が過剰適用されていない)',
    errors.length > 0, JSON.stringify(errors));
}

console.log('\n--- 2. パート指定直後の数字は無視される(PMDMML.MAN §1-1-2「"1" is ignored.」) ---');
{
  const a = compileMml('A0 o4 c4\n');
  const b = compileMml('A o4 c4\n');
  check('"A0 ..." は "A ..." と同じ結果になる(数字が無視される)',
    a.errors.length === 0 && b.errors.length === 0 && arraysEqual(a.file, b.file),
    `a.errors=${JSON.stringify(a.errors)} b.errors=${JSON.stringify(b.errors)}`);
}
{
  const a = compileMml('AB3 T157 o5 c4\n');
  check('複数パート+数字("AB3 ...")もエラーにならない', a.errors.length === 0, JSON.stringify(a.errors));
}

console.log('\n--- 3. 音色定義DTの符号付き表記(-3〜3)がPMDMML.MAN §3-1の範囲で受理される ---');
function toneBytesFor(dtLine1) {
  const src = `@1 4 5\n${dtLine1}\n31 0 0 0 0 0 0 1 0 0\n31 0 0 0 0 0 0 1 0 0\n31 0 0 0 0 0 0 1 0 0\nA @1 o4 c4\n`;
  return compileMml(src);
}
{
  // DT=-1,-2,-3 は raw 5,6,7 (sign-magnitude、bit2=符号・下位2bit=絶対値)へ変換される。
  const cases = [[-1, 5], [-2, 6], [-3, 7], [0, 0], [3, 3], [7, 7]];
  for (const [dt, expectedRaw] of cases) {
    const { errors, layout } = toneBytesFor(`31 0 0 0 0 0 0 1 ${dt} 0`);
    const ok = errors.length === 0;
    check(`DT=${dt} はエラーにならない`, ok, JSON.stringify(errors));
    if (ok) {
      // buildToneEntry: bytes[0]=tonenum、bytes[1+0x00+s]がDT1<<4|MULのバイト
      // (gen_pmd_min.mjsのコメント参照)。op1(MML1行目)はs=0に対応する
      // (parseToneDefBlockのorderedOps=[op1,op3,op2,op4]、s=0がop1)。
      const toneOff = layout.toneOff;
      const { file } = toneBytesFor(`31 0 0 0 0 0 0 1 ${dt} 0`);
      const byteDtMul = file[1 + toneOff + 1 + 0x00 + 0];
      const rawDt = (byteDtMul >> 4) & 0x7;
      check(`DT=${dt} の生バイトが期待通り(raw=${expectedRaw})`, rawDt === expectedRaw, `actual raw=${rawDt}`);
    }
  }
}
{
  // 2026-08-19、WebNP2+FreeDOS上の実機MC.EXE ver4.8sをPDT.MML/PDT2.MMLで実測し、
  // マニュアル仕様の範囲(-3〜3 または 0〜7)を超える-4以下も拒否されず、
  // 生値 = 4 | (|n| & 3) になると確定した(バッチ5、tools/pmd-reference/追加分・
  // FINDINGS.md参照)。よって以前の「範囲外として拒否」は誤りだったため、
  // 受理してrawDt=4になることを検査する形に更新する。
  const { errors, layout } = toneBytesFor('31 0 0 0 0 0 0 1 -4 0');
  check('DT=-4(実機実測で受理と判明)はエラーにならない', errors.length === 0, JSON.stringify(errors));
  if (errors.length === 0) {
    const toneOff = layout.toneOff;
    const { file } = toneBytesFor('31 0 0 0 0 0 0 1 -4 0');
    const byteDtMul = file[1 + toneOff + 1 + 0x00 + 0];
    const rawDt = (byteDtMul >> 4) & 0x7;
    check('DT=-4の生バイトが実測どおり(raw=4)', rawDt === 4, `actual raw=${rawDt}`);
  }
}
{
  // [陽性対照] -4→4への変換式そのものが効いていることを、変換式を壊すと検出できる
  // ことで確認する(4|(|n|&3)ではなく従来の4+|n|に戻すと-4は範囲外エラーへ戻るはず)。
  const parserPath = new URL('../compiler/pmd_mml_parser.mjs', import.meta.url);
  const orig = fs.readFileSync(parserPath, 'utf8');
  const NEEDLE = 'const dt = dtRaw < 0 ? (4 | ((-dtRaw) & 3)) : dtRaw;';
  if (!orig.includes(NEEDLE)) {
    throw new Error('陽性対照用のパッチ対象コードが見つかりません(製品コードが変更された可能性)');
  }
  const broken = orig.replace(NEEDLE, 'if (dtRaw < -3) throw new ParseError(line, "FORCED_REJECT_DT: " + dtRaw); const dt = dtRaw < 0 ? 4 + (-dtRaw) : dtRaw;');
  if (broken === orig) throw new Error('陽性対照用のパッチが効いていません');
  fs.writeFileSync(parserPath, broken, 'utf8');
  try {
    const compilerUrl = new URL('../compiler/pmd_mml_compiler.mjs', import.meta.url).href;
    const script = `
      import('${compilerUrl}').then(({ compileMml }) => {
        const r = compileMml('@1 4 5\\n31 0 0 0 0 0 0 1 -4 0\\n31 0 0 0 0 0 0 1 0 0\\n31 0 0 0 0 0 0 1 0 0\\nA @1 o4 c4\\n', {});
        process.stdout.write(JSON.stringify({ errors: r.errors }));
      }).catch((e) => { process.stdout.write(JSON.stringify({ threw: String(e && e.message) })); });
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    const brokenDetected = parsed.threw || (parsed.errors && parsed.errors.some((e) => /FORCED_REJECT_DT/.test(e.message)));
    check('[陽性対照] DT=-4受理の分岐を壊すと検出できる(検出器が機能している証拠)', !!brokenDetected, out);
  } finally {
    fs.writeFileSync(parserPath, orig, 'utf8');
  }
}
{
  // 陽性対照: DT=8(0-7の範囲外)も引き続き拒否される。
  const { errors } = toneBytesFor('31 0 0 0 0 0 0 1 8 0');
  check('[陽性対照] DT=8(範囲外)は引き続きエラーになる', errors.length === 1 && /DTが範囲外/.test(errors[0].message), JSON.stringify(errors));
}
{
  // DT=-5〜-7も-4と同じ式で受理される。2026-08-19、PDT2.MMLのMC.EXE実測
  // (tools/pmd-reference/pmddt2.mml・pmddt2.M)で確定: -5→5, -6→6, -7→7。
  const cases = [[-5, 5], [-6, 6], [-7, 7]];
  for (const [dt, expectedRaw] of cases) {
    const { errors, layout, file } = toneBytesFor(`31 0 0 0 0 0 0 1 ${dt} 0`);
    check(`DT=${dt}(実機実測で受理と判明)はエラーにならない`, errors.length === 0, JSON.stringify(errors));
    if (errors.length === 0) {
      const toneOff = layout.toneOff;
      const byteDtMul = file[1 + toneOff + 1 + 0x00 + 0];
      const rawDt = (byteDtMul >> 4) & 0x7;
      check(`DT=${dt} の生バイトが実測どおり(raw=${expectedRaw})`, rawDt === expectedRaw, `actual raw=${rawDt}`);
    }
  }
}

console.log('\n--- 3b. 音色定義SLが範囲外(16以上)でも4bitマスクで受理される(PMDMML.MAN §3-1) ---');
function slByteFor(slLine1) {
  const src = `@1 4 5\n31 0 0 0 0 0 0 1 0 0\n${slLine1}\n31 0 0 0 0 0 0 1 0 0\n31 0 0 0 0 0 0 1 0 0\nA @1 o4 c4\n`;
  return compileMml(src);
}
{
  // 2026-08-19、WebNP2+FreeDOS上の実機MC.EXE ver4.8sをPSL.MML/PSL2.MMLで実測し確定
  // (バッチ5、tools/pmd-reference/pmdsl.mml・pmdsl2.mml参照): 15への飽和ではなく
  // value & 15(4bitマスク)。17→1, 16→0, 31→15, 18→2, 2→2, 1→1, 15→15, 0→0。
  const cases = [[17, 1], [16, 0], [31, 15], [18, 2], [2, 2], [1, 1], [15, 15], [0, 0]];
  for (const [sl, expectedRaw] of cases) {
    const { errors, layout, file } = slByteFor(`31 0 0 0 ${sl} 0 0 1 0 0`);
    check(`SL=${sl}(§3-1の範囲0-15を超えていても)はエラーにならない`, errors.length === 0, JSON.stringify(errors));
    if (errors.length === 0) {
      // op2(MML2行目)はs=2に対応する(orderedOps=[op1,op3,op2,op4]、s=2がop2)。
      // buildToneEntry: bytes[1+0x14+s]がSL<<4|RRのバイト。
      const toneOff = layout.toneOff;
      const byteSlRr = file[1 + toneOff + 1 + 0x14 + 2];
      const rawSl = (byteSlRr >> 4) & 0xf;
      check(`SL=${sl} の生バイトが実測どおり(4bitマスク、raw=${expectedRaw})`, rawSl === expectedRaw, `actual raw=${rawSl}`);
    }
  }
}
{
  // [陽性対照] SLのマスク処理そのものが効いていることを、マスクを外すと検出できる
  // ことで確認する(& 15を削って旧実装の範囲チェックへ戻すとSL=17は拒否されるはず)。
  const parserPath = new URL('../compiler/pmd_mml_parser.mjs', import.meta.url);
  const orig = fs.readFileSync(parserPath, 'utf8');
  const NEEDLE = 'const sl = slRaw & 15;';
  if (!orig.includes(NEEDLE)) {
    throw new Error('陽性対照用のパッチ対象コードが見つかりません(製品コードが変更された可能性)');
  }
  const broken = orig.replace(NEEDLE, 'if (slRaw < 0 || slRaw > 15) throw new ParseError(line, "FORCED_REJECT_SL: " + slRaw); const sl = slRaw;');
  if (broken === orig) throw new Error('陽性対照用のパッチが効いていません');
  fs.writeFileSync(parserPath, broken, 'utf8');
  try {
    const compilerUrl = new URL('../compiler/pmd_mml_compiler.mjs', import.meta.url).href;
    const script = `
      import('${compilerUrl}').then(({ compileMml }) => {
        const r = compileMml('@1 4 5\\n31 0 0 0 0 0 0 1 0 0\\n31 0 0 0 17 0 0 1 0 0\\n31 0 0 0 0 0 0 1 0 0\\n31 0 0 0 0 0 0 1 0 0\\nA @1 o4 c4\\n', {});
        process.stdout.write(JSON.stringify({ errors: r.errors }));
      }).catch((e) => { process.stdout.write(JSON.stringify({ threw: String(e && e.message) })); });
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    const brokenDetected = parsed.threw || (parsed.errors && parsed.errors.some((e) => /FORCED_REJECT_SL/.test(e.message)));
    check('[陽性対照] SLの4bitマスクを削ると検出できる(検出器が機能している証拠)', !!brokenDetected, out);
  } finally {
    fs.writeFileSync(parserPath, orig, 'utf8');
  }
}

console.log('\n--- 4. Kパートでもテンポ(T/t)が使える(fmdriver_pmd.c pmd_cmd_table_rhythmにpmd_cmdfc_tempoが存在) ---');
{
  // 実データの実パターン(「ABCDEFGHIJK !H T175 o5 v14 q0 l8」)通り、K混在行と
  // 通常パート行を分けて書く(Kは音符を理解しないため、同じ行にo/c等を混ぜない)。
  const src = 'AK T175\nA o4 c4\n';
  const { errors, layout, file } = compileMml(src);
  check('K混在行でT(テンポ)がエラーにならない', errors.length === 0, JSON.stringify(errors));
  if (errors.length === 0) {
    const kTrack = layout.tracks.K;
    const kBytes = Array.from(file.subarray(1 + kTrack.startAddr, 1 + kTrack.termAddr));
    // T(大文字)=TimerB絶対値は2byte(0xfc + 値、emitEventのtempoAbs/isTimerB分岐参照)。
    check('Kパートのテンポ出力バイトが0xfc,175(T=TimerB絶対値)', arraysEqual(kBytes, [0xfc, 175]), `actual=${hex(kBytes)}`);
  }
}
{
  // 陽性対照: K単独でテンポ以外の未対応文字(例: 'x')は引き続きエラーになる。
  const { errors } = compileMml('K x\n');
  check("[陽性対照] Kパートでテンポ以外の未対応文字'x'は引き続きエラーになる",
    errors.length === 1 && /Kパートで未対応の文字/.test(errors[0].message), JSON.stringify(errors));
}

console.log(`\n${passCount} PASS, ${failCount} FAIL`);
process.exit(failCount > 0 ? 1 : 0);
