#!/usr/bin/env node
// PMD MML v2構文(docs/pmd-compiler-spec-v2.md)のうち、今回(step2)実装した基本形の検証。
//
// 対象: `@n`複数回定義(後勝ち) / `C`(全音符長,0xdf) / `D`・`DD`(デチューン絶対値/相対値,
// 0xfa/0xd5) / `p`(パン,0xec) / `*`(LFOスイッチ,0xf1) / `M`(LFO本体,0xf2) /
// `q`の数値2・3(0xb1/0xb3) / `(`・`)`(音量相対変化の基本形,0xe2/0xe3)。
//
// 検査方針: 自前の小さなMMLをcompileMml()でコンパイルし、対象パートのトラック領域の
// 生バイト列が「仕様書(pmd-compiler-spec-v2.md 3章)に書かれた期待値」と一致することを
// 直接比較する(実装から逆算した期待値ではなく、コマンドバイト・引数バイト数を仕様書の
// 記述から手で書き下したもの)。
//
// 陽性対照: 各コマンドについて「出力バイトを1つ間違えた」に相当する誤った期待値を用意し、
// その誤り期待値とは一致しない(=検査が症状で落ちる)ことを確認する項目を含める。
//
// 実行: node tools/verify_pmd_mml_v2_commands.mjs

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

// MML本文(パートAのみ、"A "の後に続ける文字列)をコンパイルし、パートAのトラック
// バイト列(終端0x80を含まない、開始〜終端の直前まで)を返す。音色定義は不要
// (対象コマンド群はいずれも音色番号に依存しない)。
function compileTrackABytes(body) {
  const source = `A ${body}\n`;
  const { file, errors, layout } = compileMml(source);
  if (errors.length > 0) {
    throw new Error(`コンパイル失敗: ${JSON.stringify(errors)}`);
  }
  const { startAddr, termAddr } = layout.tracks.A;
  return file.subarray(1 + startAddr, 1 + termAddr); // file[0]=opm_flagなので+1
}

// --- 1. C(全音符長, 0xdf) ---
{
  const actual = compileTrackABytes('C106');
  const expected = [0xdf, 106];
  check("C106 の出力が仕様どおり(0xdf, 106)", arraysEqual(actual, expected), `actual=${hex(actual)}`);

  const wrongExpected = [0xdf, 107]; // 1byte違う期待値(陽性対照)
  check('[陽性対照] C106の出力は1byte違う誤り期待値とは一致しない', !arraysEqual(actual, wrongExpected), `actual=${hex(actual)} wrong=${hex(wrongExpected)}`);

  check('Cの値域チェック: 256は範囲外(1-255)でエラーになる', (() => {
    const { errors } = compileMml('A C256\n');
    return errors.length > 0;
  })());
  check('Cの値域チェック: 0は範囲外(1-255)でエラーになる', (() => {
    const { errors } = compileMml('A C0\n');
    return errors.length > 0;
  })());
}

// --- 2. D / DD(デチューン絶対値/相対値, 0xfa/0xd5) ---
{
  const actualAbs = compileTrackABytes('D5');
  const expectedAbs = [0xfa, 5, 0]; // 2byte LE符号付き
  check('D5(デチューン絶対値)の出力が仕様どおり(0xfa, 05 00)', arraysEqual(actualAbs, expectedAbs), `actual=${hex(actualAbs)}`);

  const actualNeg = compileTrackABytes('D-3');
  const expectedNeg = [0xfa, 0xfd, 0xff]; // -3 の2byte LE(0xfffd)
  check('D-3(負のデチューン絶対値)の出力が仕様どおり(0xfa, fd ff)', arraysEqual(actualNeg, expectedNeg), `actual=${hex(actualNeg)}`);

  const actualRel = compileTrackABytes('DD-3');
  const expectedRel = [0xd5, 0xfd, 0xff];
  check('DD-3(デチューン相対値)の出力が仕様どおり(0xd5, fd ff)', arraysEqual(actualRel, expectedRel), `actual=${hex(actualRel)}`);

  const wrongExpected = [0xfa, 5, 1]; // 上位byteを1byte違えた誤り期待値(陽性対照)
  check('[陽性対照] D5の出力は上位byteが違う誤り期待値とは一致しない', !arraysEqual(actualAbs, wrongExpected), `actual=${hex(actualAbs)} wrong=${hex(wrongExpected)}`);

  check('デチューンの値域チェック: 32768は範囲外(-32768〜32767)でエラーになる', (() => {
    const { errors } = compileMml('A D32768\n');
    return errors.length > 0;
  })());
}

// --- 3. p(パン, 0xec) ---
{
  const actual = compileTrackABytes('p2');
  const expected = [0xec, 2];
  check('p2(パン)の出力が仕様どおり(0xec, 02)', arraysEqual(actual, expected), `actual=${hex(actual)}`);

  check('パンの値域チェック: 4は範囲外(0-3)でエラーになる', (() => {
    const { errors } = compileMml('A p4\n');
    return errors.length > 0;
  })());
}

// --- 4. *(LFOスイッチ, 0xf1) ---
{
  const actual = compileTrackABytes('*5');
  const expected = [0xf1, 5];
  check('*5(LFOスイッチ)の出力が仕様どおり(0xf1, 05)', arraysEqual(actual, expected), `actual=${hex(actual)}`);

  check('LFOスイッチの値域チェック: 8は範囲外(0-7)でエラーになる', (() => {
    const { errors } = compileMml('A *8\n');
    return errors.length > 0;
  })());
}

// --- 5. M(LFO本体, 0xf2、4byte固定) ---
{
  const actual = compileTrackABytes('M10,20,-3,40');
  const expected = [0xf2, 10, 20, 0xfd, 40]; // depthA=-3 -> 0xfd
  check('M10,20,-3,40(LFO本体)の出力が仕様どおり(0xf2固定4byte)', arraysEqual(actual, expected), `actual=${hex(actual)}`);

  const wrongExpected = [0xf2, 10, 20, 0xfd, 41]; // depthBを1違えた誤り期待値(陽性対照)
  check('[陽性対照] Mの出力はdepthBが1違う誤り期待値とは一致しない', !arraysEqual(actual, wrongExpected), `actual=${hex(actual)} wrong=${hex(wrongExpected)}`);

  check('Mの省略形(delayのみ)は未対応でエラーになる(範囲外機能)', (() => {
    const { errors } = compileMml('A M10\n');
    return errors.length > 0;
  })());

  // MP/MPA/MPB(上昇/下降専用LFO指定、PMDMML.MAN §9-6)。当初「M書式バリエーション」
  // の一種と見えたが、実データ(第三者MML、リポジトリには非同梱)の実測調査で
  // 「通常のM 4値形/delay省略形は実データ上0件、エラーの実体は全てMP系だった」と
  // 判明。参照.M実測(tools/pmd-reference/pmdmp.mml、MC.EXE ver4.8s)で
  // 0xf2/0xbf(delay=数値2省略時0,speed=数値3省略時1,depthA=数値1,depthB=255固定) +
  // 0xf1/0xbe(LFOスイッチ、固定値1)の2コマンド構成と確定。
  const actualMP = compileTrackABytes('MP-77');
  const expectedMP = [0xf2, 0, 1, 0xb3, 0xff, 0xf1, 1]; // depthA=-77 -> 0xb3
  check('MP-77(上昇/下降LFO・数値1のみ)の出力が仕様どおり', arraysEqual(actualMP, expectedMP), `actual=${hex(actualMP)}`);

  const wrongMP = [0xf2, 0, 1, 0xb3, 0xff, 0xf1, 2]; // *スイッチの値を1違えた誤り期待値
  check('[陽性対照] MP-77の出力は*スイッチ値が1違う誤り期待値とは一致しない', !arraysEqual(actualMP, wrongMP), `actual=${hex(actualMP)} wrong=${hex(wrongMP)}`);

  const actualMPB = compileTrackABytes('MPB39');
  const expectedMPB = [0xbf, 0, 1, 39, 0xff, 0xbe, 1]; // LFO2は0xbf/0xbe
  check('MPB39(LFO2側)の出力が仕様どおり(0xbf/0xbe)', arraysEqual(actualMPB, expectedMPB), `actual=${hex(actualMPB)}`);
}

// --- 6. qの数値2/3(0xb1/0xb3) ---
{
  // 数値1(q1)を一度も明示していない場合、参照.M実測(tools/pmd-reference/pmdgate.mml、
  // MC.EXE ver4.8s実測)で判明: MC.EXEはbaseline=1を仮定してその都度暗黙の`fe 01`
  // (gateAbs=1)を先行出力し、0xb1は数値1明示時と同じ式|1-数値2|(符号もnum2<1で
  // bit7=1、それ以外0)で計算する。旧来の「数値2をそのままbit7=1固定」という
  // 手書きの推測値は誤りだった(compiler/pmd_mml_parser.mjsの'q'ハンドラ参照)。
  const actualBoth = compileTrackABytes('q-10,5');
  const expectedBoth = [0xfe, 1, 0xb1, 9, 0xb3, 5]; // |1-10|=9、num2>1でbit7=0
  check('q-10,5(数値2+数値3)の出力が仕様どおり(fe 01, 0xb1 09, 0xb3 05)', arraysEqual(actualBoth, expectedBoth), `actual=${hex(actualBoth)}`);

  const actualNum2Only = compileTrackABytes('q-20');
  const expectedNum2Only = [0xfe, 1, 0xb1, 19]; // |1-20|=19
  check('q-20(数値2のみ)の出力が仕様どおり(fe 01, 0xb1)', arraysEqual(actualNum2Only, expectedNum2Only), `actual=${hex(actualNum2Only)}`);

  const actualNum3Only = compileTrackABytes('q,7');
  const expectedNum3Only = [0xb3, 7];
  check('q,7(数値3のみ)の出力が仕様どおり(0xb3)', arraysEqual(actualNum3Only, expectedNum3Only), `actual=${hex(actualNum3Only)}`);

  // qの数値1(固定カット量、0xfe)。当初は「.M側のバイト表現が未解明」として
  // 非対応・エラー継続としていたが、参照.M実測(tools/pmd-reference/pmdq1b.mml、
  // MC.EXE ver4.8s実測)で0xfe(pmd_cmdfe_gate_abs)に1byteそのまま書くだけと
  // 判明したため実装した(docs/pmd-compiler-spec-v2.md 3.3節・5章更新)。
  const actualNum1Only = compileTrackABytes('q10');
  const expectedNum1Only = [0xfe, 10];
  check('q10(数値1のみ)の出力が仕様どおり(0xfe)', arraysEqual(actualNum1Only, expectedNum1Only), `actual=${hex(actualNum1Only)}`);

  const wrongNum1 = [0xfe, 11];
  check('[陽性対照] q10の出力は数値1が1違う誤り期待値とは一致しない', !arraysEqual(actualNum1Only, wrongNum1), `actual=${hex(actualNum1Only)} wrong=${hex(wrongNum1)}`);

  // 数値1明示時、数値2(0xb1)は「数値2そのもの」ではなく「|数値1-数値2|」の差分
  // (符号がbit7)。tools/pmd-reference/pmdq1b.mml(q50-30,15 / q30-90,2)で実測確認。
  const actualNum1Num2 = compileTrackABytes('q50-30,15');
  const expectedNum1Num2 = [0xfe, 50, 0xb1, 0x80 | 20, 0xb3, 15]; // |50-30|=20, 減算方向
  check('q50-30,15(数値1+数値2+数値3)の出力が仕様どおり(数値2は差分)', arraysEqual(actualNum1Num2, expectedNum1Num2), `actual=${hex(actualNum1Num2)}`);

  const actualNum1Num2Flip = compileTrackABytes('q30-90,2');
  const expectedNum1Num2Flip = [0xfe, 30, 0xb1, 60, 0xb3, 2]; // |30-90|=60, 加算方向(bit7=0)
  check('q30-90,2(数値2>数値1で符号反転)の出力が仕様どおり', arraysEqual(actualNum1Num2Flip, expectedNum1Num2Flip), `actual=${hex(actualNum1Num2Flip)}`);

  check('qの数値1が範囲外(256)はエラーになる', (() => {
    const { errors } = compileMml('A q256\n');
    return errors.length > 0;
  })());
}

// --- 7. ( ) 音量相対変化の基本形(0xe2/0xe3) ---
{
  // 2026-08-18: 実データ参照.M実測(mso_JSM.MML)で、`)`/`(`を数値/%を一切付けずに
  // 書いた場合、MC.EXEは0xe3/0xe2(1byte引数)ではなく0引数の専用コマンド0xf4/0xf3
  // (fmdriver_pmd.c:2526-2572)を出力すると判明した(own: e2 04 e2 04 / ref: f3 f3、
  // どちらも「無指定=値4相当」だがバイト表現が違う)。数値または%を明示した場合は
  // 従来通り0xe3/0xe2(下のexpectedIncPercent等、影響無し)。
  const actualIncDefault = compileTrackABytes(')');
  const expectedIncDefault = [0xf4]; // 数値省略時は0引数の専用コマンド
  check(')(数値省略,加算)の出力が仕様どおり(0xf4)', arraysEqual(actualIncDefault, expectedIncDefault), `actual=${hex(actualIncDefault)}`);

  const actualIncPercent = compileTrackABytes(')%10');
  const expectedIncPercent = [0xe3, 10]; // %付きは指定値そのまま
  check(')%10(%指定,加算)の出力が仕様どおり(0xe3, 0a)', arraysEqual(actualIncPercent, expectedIncPercent), `actual=${hex(actualIncPercent)}`);

  const actualDec = compileTrackABytes('(5');
  const expectedDec = [0xe2, 20]; // 5*4=20
  check('(5(数値5,減算)の出力が仕様どおり(0xe2, 14)', arraysEqual(actualDec, expectedDec), `actual=${hex(actualDec)}`);

  const actualDecPercent = compileTrackABytes('(%200');
  const expectedDecPercent = [0xe2, 200];
  check('(%200(%指定,減算)の出力が仕様どおり(0xe2, c8)', arraysEqual(actualDecPercent, expectedDecPercent), `actual=${hex(actualDecPercent)}`);

  const wrongExpected = [0xe3, 5]; // 1byte違う誤り期待値(陽性対照)
  check('[陽性対照] )の出力は1byte違う誤り期待値とは一致しない', !arraysEqual(actualIncDefault, wrongExpected), `actual=${hex(actualIncDefault)} wrong=${hex(wrongExpected)}`);

  check("'^'(アクセント)は未解明のため今回も未対応(エラー継続)", (() => {
    const { errors } = compileMml('A )^\n');
    return errors.length > 0;
  })());
}

// --- 8. @n 複数回定義(後勝ち、v2 3.11節。実データとの突き合わせで実測・確定) ---
{
  const source = [
    '@1 7 0',
    '5 0 0 0 0 0 0 1 0 0',
    '5 0 0 0 0 0 0 1 0 0',
    '5 0 0 0 0 0 0 1 0 0',
    '5 0 0 0 0 0 0 1 0 0',
    '@1 7 0',
    '9 0 0 0 0 0 0 1 0 0',
    '9 0 0 0 0 0 0 1 0 0',
    '9 0 0 0 0 0 0 1 0 0',
    '9 0 0 0 0 0 0 1 0 0',
    'A @1c',
  ].join('\n');
  const { file, errors, layout } = compileMml(source);
  if (errors.length > 0) throw new Error(`@n複数回定義テストのコンパイルに失敗: ${JSON.stringify(errors)}`);
  const toneOff = layout.toneOff;
  // buildToneEntry()のレイアウト(gen_pmd_min.mjs): byte[1+0x08+s] の下位5bitがAR(オペレータs)。
  const arOp0 = file[1 + toneOff + 1 + 0x08] & 0x1f;
  check('@1の複数回定義は「後勝ち」(2回目のAR=9)が採用される', arOp0 === 9, `AR(op0)=${arOp0}(期待=9)`);
  check('@1の複数回定義でエラーにはならない(許容される)', errors.length === 0);

  check('[陽性対照] @1の複数回定義が「先勝ち」(1回目のAR=5)相当の誤り期待値とは一致しない', arOp0 !== 5, `AR(op0)=${arOp0}`);
}

// --- 9. `!` MML変数(v2 3.4節。今回マニュアル実測(PMDMML.MAN §3-2/§16-1)で解決) ---
{
  // 基本形: 定義したMML文字列がそのまま展開される。`.M`側は展開後のバイト列と同一になる。
  const source = ['!A cde', 'A l8 !A fga'].join('\n');
  const { file, errors, layout } = compileMml(source);
  if (errors.length > 0) throw new Error(`!基本形テストのコンパイルに失敗: ${JSON.stringify(errors)}`);
  const { startAddr, termAddr } = layout.tracks.A;
  const actual = file.subarray(1 + startAddr, 1 + termAddr);
  const { file: expFile, layout: expLayout } = compileMml('A l8 cdefga\n');
  const exp = expFile.subarray(1 + expLayout.tracks.A.startAddr, 1 + expLayout.tracks.A.termAddr);
  check('!A(=cde)の展開が"cde"直書きと同一バイト列になる(PMDMML.MAN §3-2 例1)', arraysEqual(actual, exp), `actual=${hex(actual)} exp=${hex(exp)}`);

  const wrongExp = compileMml('A l8 cdefgb\n'); // 末尾を b に変えた誤り期待値(陽性対照)
  const wrongBytes = wrongExp.file.subarray(1 + wrongExp.layout.tracks.A.startAddr, 1 + wrongExp.layout.tracks.A.termAddr);
  check('[陽性対照] !Aの展開は1音違う誤り期待値とは一致しない', !arraysEqual(actual, wrongBytes), `actual=${hex(actual)} wrong=${hex(wrongBytes)}`);

  // 長さ違いの2変数(!b/!bc)で長い方が優先されることを確認(PMDMML.MAN §16-1 例1)。
  const nestSource = ['!b @0', '!bc @1', '!s @2', '@0 0 0', '0 0 0 0 0 0 1 0 0 0', '0 0 0 0 0 0 1 0 0 0', '0 0 0 0 0 0 1 0 0 0', '0 0 0 0 0 0 1 0 0 0',
    '@1 0 0', '0 0 0 0 0 0 1 0 0 0', '0 0 0 0 0 0 1 0 0 0', '0 0 0 0 0 0 1 0 0 0', '0 0 0 0 0 0 1 0 0 0',
    '@2 0 0', '0 0 0 0 0 0 1 0 0 0', '0 0 0 0 0 0 1 0 0 0', '0 0 0 0 0 0 1 0 0 0', '0 0 0 0 0 0 1 0 0 0',
    'A !bcc !sg !bc'].join('\n');
  const nestResult = compileMml(nestSource);
  if (nestResult.errors.length > 0) throw new Error(`!最長一致テストのコンパイルに失敗: ${JSON.stringify(nestResult.errors)}`);
  const nestBytes = nestResult.file.subarray(1 + nestResult.layout.tracks.A.startAddr, 1 + nestResult.layout.tracks.A.termAddr);
  // 期待: "!bcc !sg !bc" -> "@1 c @2g @1" (最長一致で!bcが優先される、!b cc ではない)。
  // 直接バイト列を組み立てて比較する(0xff+tonenum、note=noteByte(oct4既定,idx)+clocks24既定長)。
  // nibbleは既定オクターブ(o4相当)より1小さい3(PMDMML.MAN §4-4、
  // docs/pmd-compiler-spec-v2.md 6章、参照.M実測で確定)。
  const nestExpBytes = [0xff, 1, 0x30, 24, 0xff, 2, 0x37, 24, 0xff, 1];
  check('!bcc!sg!bc が最長一致で"!bc c !s g !bc"(@1 c @2g @1相当)に展開される(PMDMML.MAN §16-1 例1)', arraysEqual(nestBytes, nestExpBytes), `actual=${hex(nestBytes)} exp=${hex(nestExpBytes)}`);

  check('!の再帰定義(!A→!B→!A)はParseErrorになる(暴走を避ける安全側の実装)', (() => {
    const { errors: e } = compileMml(['!A cde!B', '!B cde!A', 'A !A'].join('\n'));
    return e.length > 0;
  })());
}

// --- 10. `M` delay単独省略形(v2 3.6節「未解明」→今回PMDMML.MAN §9-1実測で解決) ---
{
  const actual = compileTrackABytes('M10,20,30,40 M5');
  // 1回目: 0xf2 10 20 30 40(4byte固定)。2回目(delay単独=5)は、参照.M実測
  // (tools/pmd-reference/pmdlfo.mml、MC.EXE ver4.8s実測、`M5`が`c2 05`の2byteで
  // 出ることを確認)により、4byte全部の再送出ではなく短縮コマンド0xc2(LFO1、
  // `pmd_cmdc2_lfo_delay`、upstream/98fmplayer/fmdriver/fmdriver_pmd.c:3652)+
  // delay 1byteのみが出力される。旧来の「4byte全部を再送出する」という
  // 手書きの推測値は誤りだった(compiler/pmd_mml_parser.mjs/pmd_mml_compiler.mjsの
  // lfoBody実装参照)。
  const expected = [0xf2, 10, 20, 30, 40, 0xc2, 5];
  check('M10,20,30,40 の後の M5(delay単独)は短縮コマンド0xc2でdelayのみ出力される(参照.M実測)', arraysEqual(actual, expected), `actual=${hex(actual)}`);

  const wrongExpected = [0xf2, 10, 20, 30, 40, 0xc2, 6]; // delayを1違えた誤り期待値(陽性対照)
  check('[陽性対照] M5(delay単独)の出力は1byte違う誤り期待値とは一致しない', !arraysEqual(actual, wrongExpected), `actual=${hex(actual)} wrong=${hex(wrongExpected)}`);

  check('直前のMが無い状態でのdelay単独指定はエラーになる(保持すべき値が無いため)', (() => {
    const { errors } = compileMml('A M5\n');
    return errors.length > 0;
  })());
}

// --- 11. `{ }` ポルタメント(v2 3.5節「未解明」→今回fmdriver_pmd.c:3083-3121実測で解決) ---
{
  const actual = compileTrackABytes('{cg}4');
  // 0xda + note1(c, oct4=既定) + note2(g, oct4) + clocks(4分音符=C96で24)。
  // nibbleはMMLの既定オクターブ(o4相当)より1小さい3(PMDMML.MAN §4-4、
  // docs/pmd-compiler-spec-v2.md 6章、参照.M実測で確定)。
  const expected = [0xda, (3 << 4) | 0, (3 << 4) | 7, 24];
  check('{cg}4 の出力が仕様どおり(0xda, note(c), note(g), clocks=24)', arraysEqual(actual, expected), `actual=${hex(actual)}`);

  const wrongExpected = [0xda, (3 << 4) | 0, (3 << 4) | 7, 23]; // clocksを1違えた誤り期待値(陽性対照)
  check('[陽性対照] {cg}4の出力は1byte違う誤り期待値とは一致しない', !arraysEqual(actual, wrongExpected), `actual=${hex(actual)} wrong=${hex(wrongExpected)}`);

  // ディレイ付き: {cg}4,8 は "c8&{cg}8" と同等(PMDMML.MAN §4-3 例2)。
  const actualDelay = compileTrackABytes('{cg}4,8');
  const noteC8 = [(3 << 4) | 0, 12]; // note(c) + clocks(8分音符=96/8=12)
  const tie = [0xfb];
  const porta = [0xda, (3 << 4) | 0, (3 << 4) | 7, 24 - 12]; // 残り12clock
  const expectedDelay = [...noteC8, ...tie, ...porta];
  check('{cg}4,8 が "c8&{cg}(残りclock)" に展開される(PMDMML.MAN §4-3 例2)', arraysEqual(actualDelay, expectedDelay), `actual=${hex(actualDelay)} exp=${hex(expectedDelay)}`);

  check("'{}' 内に音長を持つ文字(rやx等)を書くとエラーになる(c/d/e/f/g/a/b/o/</>のみ許可)", (() => {
    const { errors } = compileMml('A {cr}4\n');
    return errors.length > 0;
  })());
}

// --- 12. `_` / `__` 転調(PMDMML.MAN §4-14。今回fmdriver_pmd.c:2516-2523/2864-2871実測で解決) ---
{
  const actualAbs = compileTrackABytes('_5');
  check('_5(転調絶対値)の出力が仕様どおり(0xf5, 05)', arraysEqual(actualAbs, [0xf5, 5]), `actual=${hex(actualAbs)}`);

  const actualAbsNoSign = compileTrackABytes('_0');
  check('_0(符号無し、実データに出現する表記)がエラーにならず0xf5,00になる', arraysEqual(actualAbsNoSign, [0xf5, 0]), `actual=${hex(actualAbsNoSign)}`);

  const actualNeg = compileTrackABytes('_-2');
  check('_-2(転調絶対値・負)の出力が仕様どおり(0xf5, fe)', arraysEqual(actualNeg, [0xf5, 0xfe]), `actual=${hex(actualNeg)}`);

  const actualRel = compileTrackABytes('__3');
  check('__3(転調相対値)の出力が仕様どおり(0xe7, 03)', arraysEqual(actualRel, [0xe7, 3]), `actual=${hex(actualRel)}`);

  const wrongExpected = [0xf5, 6]; // 1byte違う誤り期待値(陽性対照)
  check('[陽性対照] _5の出力は1byte違う誤り期待値とは一致しない', !arraysEqual(actualAbs, wrongExpected), `actual=${hex(actualAbs)} wrong=${hex(wrongExpected)}`);
}

console.log(`\n${passCount} PASS, ${failCount} FAIL`);
if (failCount > 0) process.exitCode = 1;
