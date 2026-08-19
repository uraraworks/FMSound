#!/usr/bin/env node
// 回帰テスト: r_offset固定領域(8byte、K/R未使用時)。
//
// 2026-08-19実測(1回目)で判明: 先頭2byte(A)は固定値`0x60`(96)ではなく、「全パート
// (FM1-6/SSG1-3/ADPCM、および#PPZExtendで宣言されたPPZ8パート)のうち最も総クロック数
// (曲の長さ)が長いパートの総クロック数」。参照.M実測(tools/pmd-reference/README.md
// 「r_offset固定領域(8byte、K/R未使用時)の先頭byteの正体を特定・修正」節)で
// corpus全43ケース中40ケース(K/R使用の3ケースを除く全て)で確認済み。
//
// ループ(`[`...`]n`、`:`で脱出区間を分ける)の数え方は tools/pmd-reference/pmdloopx.mml
// (単純ループ・2重ネスト両方)の実測で確定: `:`が無ければ本体をn回展開。`:`が
// あれば「最終回だけ`:`〜`]`の区間を再生せず抜ける」ため before×n + after×(n-1)。
//
// 2026-08-19実測(2回目、PFA〜PFF.MML、docs/pmd-compiler-real-data-diff-2026-08-19.md
// 「追加実測(同日、5周目)」節参照)で、この8byte領域の構造が
// `[A:LE16] 00 00 [B:LE16] 00 00`だと判明した。
//   B = 「そのパートの総クロック数 − `L`(globalLoop)の線形位置」の全パート最大値。
//       `L`が無いパートは寄与しない。どのパートにも`L`が無ければB=0。
// 旧実装は[4]=0x00固定・[5]=[1](Aの上位byteの複製)という未確定の暫定実装だったが、
// 実際はBの下位/上位byteであり、既存corpus(POPFUL/INTOPAL/MULE/MSOFMFS)ではA・Bの
// 上位byteがたまたま一致していたため無症状のまま残っていた。
//
// 実行: node tools/verify_pmd_rhythm_fixed_area_ticks.mjs

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

// K/R未使用時のr_offset固定領域(8byte)を取り出す。
function fixedArea(mml, opts = {}) {
  const r = compileMml(mml, { tones: { 1: {} }, ...opts });
  if (r.errors && r.errors.length > 0) {
    throw new Error(`compile failed for "${mml}": ${JSON.stringify(r.errors)}`);
  }
  const file = r.file;
  const rel = file.subarray(1); // file[0]=opmFlag
  const rOffset = rel[0x16] | (rel[0x17] << 8);
  const a = rel[rOffset] | (rel[rOffset + 1] << 8);
  const b = rel[rOffset + 4] | (rel[rOffset + 5] << 8);
  return { a, b, byte: rel[rOffset], rOffset, file };
}

function main() {
  // --- A(先頭2byte)の既存回帰テスト ---

  // 1. 単一パート・単音(l4=24クロック、96とは非対称な値にして「たまたま96に
  //    そろっていて検出できない」pitfallを踏まないようにする)。
  {
    const { byte } = fixedArea('A @1 o4 l4 c');
    check('単音l4(24クロック)でfixed byte=24(0x18)', byte === 24, `byte=0x${byte.toString(16)}`);
  }

  // 2. 複数パート、最長パートの値になる(FM1=48クロック、SSG1=24クロック → 48)。
  {
    const { byte } = fixedArea('A @1 o4 l4 cd\nG l4 c');
    check('複数パートで最長(48クロック)側の値になる', byte === 48, `byte=0x${byte.toString(16)}`);
  }

  // 3. #PPZExtendパート(小文字トラック)も比較対象に含まれる。
  {
    const { byte } = fixedArea('#PPZExtend a\nA @1 o4 l4 c\na o4 l1 c');
    // l1(全音符)=96クロック、A(l4=24)より長い。
    check('#PPZExtendパートが最長なら、その値になる', byte === 96, `byte=0x${byte.toString(16)}`);
  }

  // 4. ループ(`:`無し): 本体をn回展開。 o4 l8 [ c d ]5 → (12+12)*5=120クロック。
  {
    const { byte } = fixedArea('A @1 o4 l8 [ c d ]5');
    check('コロン無しループはbefore×nで展開される(120クロック)', byte === 120, `byte=0x${byte.toString(16)}`);
  }

  // 5. ループ(`:`あり): 最終回だけafter区間を再生しない
  //    (before×n + after×(n-1))。o4 l8 [ c d : e ]4 →
  //    before=12+12=24、after=12、n=4 → 24*4+12*3=96+36=132。
  {
    const { byte } = fixedArea('A @1 o4 l8 [ c d : e ]4');
    check('コロン付きループはbefore×n+after×(n-1)で展開される(132クロック)', byte === 132, `byte=0x${byte.toString(16)}`);
  }

  // 6. ネストしたループ: 内側の展開後クロック数を外側の1イベント分として加算。
  //    o4 l8 [ c [ d : e ]3 ]2 →
  //    内側: before=12,after=12,n=3 → 12*3+12*2=36+24=60。
  //    外側: before=(c=12)+(内側=60)=72、コロン無し、n=2 → 72*2=144。
  {
    const { byte } = fixedArea('A @1 o4 l8 [ c [ d : e ]3 ]2');
    check('ネストしたループが正しく展開される(144クロック)', byte === 144, `byte=0x${byte.toString(16)}`);
  }

  // --- B(後半2byte、offset+4/+5)の回帰テスト ---
  // 2026-08-19実測(PFA〜PFF.MML)の6ケースをそのまま移植(A=FM1、B相当=SSG1で代用。
  // PMDMML.MANの`L`はパート共通のグローバルループ点コマンドで、パート種別に依らない)。

  // 7. どちらのパートにも`L`が無ければB=0(A cdef(96) / SSG cd(48))。
  {
    const { a, b } = fixedArea('A @1 o4 l4 cdef\nG o4 l4 cd');
    check('Lが無ければB=0(A=96)', a === 96 && b === 0, `a=${a} b=${b}`);
  }

  // 8. 同じく`L`無し、Aが8音(192)でも同様にB=0。
  {
    const { a, b } = fixedArea('A @1 o4 l4 cdefgabc\nG o4 l4 cd');
    check('Lが無ければB=0(A=192でも同じ)', a === 192 && b === 0, `a=${a} b=${b}`);
  }

  // 9. Aパート内: cd(48)の後に`L`、続けてef(48)。総クロック96・ループ開始48 → B=96-48=48。
  {
    const { a, b } = fixedArea('A @1 o4 l4 cd L ef\nG o4 l4 c');
    check('パート途中のLでB=総クロック-ループ開始位置(96-48=48)', a === 96 && b === 48, `a=${a} b=${b}`);
  }

  // 10. Aパート先頭に`L`(cdef全体がループ対象) → ループ開始位置0、B=96-0=96。
  {
    const { a, b } = fixedArea('A @1 o4 l4 L cdef\nG o4 l4 c');
    check('先頭のLでB=総クロックそのもの(96-0=96)', a === 96 && b === 96, `a=${a} b=${b}`);
  }

  // 11. Lの無いパート(A、288クロック)はBに寄与しない。Lがあるパート(G、48クロック
  //     全体がループ)がBを決める → B=48。
  {
    const { a, b } = fixedArea('A @1 o4 l4 cdefgabc>cdef\nG o4 l4 L cd');
    check('Lの無いパートはBに寄与しない(A=288はBに影響せずB=48)', a === 288 && b === 48, `a=${a} b=${b}`);
  }

  // 12. 両パートに`L`があれば全パート最大値を採る。A: cd L ef(span48)、
  //     G: L cdefgabc(8音192、span192) → B=max(48,192)=192。AもGの192に更新。
  {
    const { a, b } = fixedArea('A @1 o4 l4 cd L ef\nG o4 l4 L cdefgabc');
    check('両パートにLがあれば最大値を採る(B=192、A=192)', a === 192 && b === 192, `a=${a} b=${b}`);
  }

  // [陽性対照] A(computeLongestPartTicks)を無効化して固定値0x60に戻すと、
  // 上記の非対称な期待値(24等)とズレて検出できることを確認する。
  {
    const compilerPath = new URL('../compiler/pmd_mml_compiler.mjs', import.meta.url).pathname;
    const orig = fs.readFileSync(compilerPath, 'utf8');
    const NEEDLE = 'rel[rhythmFixedAddr] = aVal & 0xff;';
    if (!orig.includes(NEEDLE)) {
      check('[陽性対照・前提] Aの対象コードが見つかる', false, 'NEEDLEが一致しない(実装が変わった?)');
    } else {
      const broken = orig.replace(NEEDLE, 'rel[rhythmFixedAddr] = 0x60;');
      fs.writeFileSync(compilerPath, broken, 'utf8');
      try {
        const compilerUrl = new URL('../compiler/pmd_mml_compiler.mjs', import.meta.url).href;
        const script = `
          import('${compilerUrl}').then(({ compileMml }) => {
            const r = compileMml('A @1 o4 l4 c', { tones: { 1: {} } });
            const file = r.file;
            const rel = file.subarray(1);
            const rOffset = rel[0x16] | (rel[0x17] << 8);
            process.stdout.write(JSON.stringify({ byte: rel[rOffset] }));
          }).catch((e) => { process.stdout.write(JSON.stringify({ threw: String(e && e.message) })); });
        `;
        const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
        const parsed = JSON.parse(out);
        check('[陽性対照] Aを固定値0x60に戻すと単音l4(期待値24)のテストが失敗として検出される',
          parsed.byte === 0x60 && parsed.byte !== 24, out);
      } finally {
        fs.writeFileSync(compilerPath, orig, 'utf8');
      }
    }
  }

  // [陽性対照] B(computeLongestLoopSpan)を無効化して常に0にすると、
  // ケース9〜12(Lありでbが非0)が失敗として検出できることを確認する。
  {
    const compilerPath = new URL('../compiler/pmd_mml_compiler.mjs', import.meta.url).pathname;
    const orig = fs.readFileSync(compilerPath, 'utf8');
    const NEEDLE = 'const bVal = computeLongestLoopSpan(tracks, header) & 0xffff;\n    rel[rhythmFixedAddr] = aVal & 0xff;';
    if (!orig.includes(NEEDLE)) {
      check('[陽性対照・前提] Bの対象コードが見つかる', false, 'NEEDLEが一致しない(実装が変わった?)');
    } else {
      const broken = orig.replace(NEEDLE, 'const bVal = 0;\n    rel[rhythmFixedAddr] = aVal & 0xff;');
      fs.writeFileSync(compilerPath, broken, 'utf8');
      try {
        const compilerUrl = new URL('../compiler/pmd_mml_compiler.mjs', import.meta.url).href;
        const script = `
          import('${compilerUrl}').then(({ compileMml }) => {
            const r = compileMml('A @1 o4 l4 cd L ef\\nG o4 l4 c', { tones: { 1: {} } });
            const rel = r.file.subarray(1);
            const rOffset = rel[0x16] | (rel[0x17] << 8);
            const b = rel[rOffset + 4] | (rel[rOffset + 5] << 8);
            process.stdout.write(JSON.stringify({ b }));
          }).catch((e) => { process.stdout.write(JSON.stringify({ threw: String(e && e.message) })); });
        `;
        const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
        const parsed = JSON.parse(out);
        check('[陽性対照] Bを常に0にするとLありケース(期待値48)が失敗として検出される',
          parsed.b === 0 && parsed.b !== 48, out);
      } finally {
        fs.writeFileSync(compilerPath, orig, 'utf8');
      }
    }
  }

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main();
