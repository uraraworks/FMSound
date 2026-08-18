#!/usr/bin/env node
// 回帰テスト: r_offset固定領域(8byte、K/R未使用時)の先頭byte。
//
// 2026-08-19判明: このbyteは固定値`0x60`(96)ではなく、「全パート(FM1-6/SSG1-3/
// ADPCM、および#PPZExtendで宣言されたPPZ8パート)のうち最も総クロック数(曲の長さ)
// が長いパートの総クロック数」の下位8bit。参照.M実測(tools/pmd-reference/README.md
// 「r_offset固定領域(8byte、K/R未使用時)の先頭byteの正体を特定・修正」節)で
// corpus全43ケース中40ケース(K/R使用の3ケースを除く全て)で確認済み。
// 既存corpusが偶然96クロックにそろっていたため、以前はこの実装ミス(固定値`0x60`)
// が無症状のまま残っていた(pmdtone等)。
//
// ループ(`[`...`]n`、`:`で脱出区間を分ける)の数え方は tools/pmd-reference/pmdloopx.mml
// (単純ループ・2重ネスト両方)の実測で確定: `:`が無ければ本体をn回展開。`:`が
// あれば「最終回だけ`:`〜`]`の区間を再生せず抜ける」ため before×n + after×(n-1)。
//
// 実行: node tools/verify_pmd_rhythm_fixed_area_ticks.mjs

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileMml } from '../compiler/pmd_mml_compiler.mjs';

const __filename = fileURLToPath(import.meta.url);

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

// K/R未使用時のr_offset固定領域の先頭byteを取り出す。
function fixedAreaByte(mml, opts = {}) {
  const r = compileMml(mml, { tones: { 1: {} }, ...opts });
  if (r.errors && r.errors.length > 0) {
    throw new Error(`compile failed for "${mml}": ${JSON.stringify(r.errors)}`);
  }
  const file = r.file;
  const rel = file.subarray(1); // file[0]=opmFlag
  const rOffset = rel[0x16] | (rel[0x17] << 8);
  return { byte: rel[rOffset], rOffset, file };
}

function main() {
  // 1. 単一パート・単音(l4=24クロック、96とは非対称な値にして「たまたま96に
  //    そろっていて検出できない」pitfallを踏まないようにする)。
  {
    const { byte } = fixedAreaByte('A @1 o4 l4 c');
    check('単音l4(24クロック)でfixed byte=24(0x18)', byte === 24, `byte=0x${byte.toString(16)}`);
  }

  // 2. 複数パート、最長パートの値になる(FM1=48クロック、SSG1=24クロック → 48)。
  {
    const { byte } = fixedAreaByte('A @1 o4 l4 cd\nG l4 c');
    check('複数パートで最長(48クロック)側の値になる', byte === 48, `byte=0x${byte.toString(16)}`);
  }

  // 3. #PPZExtendパート(小文字トラック)も比較対象に含まれる。
  {
    const { byte } = fixedAreaByte('#PPZExtend a\nA @1 o4 l4 c\na o4 l1 c');
    // l1(全音符)=96クロック、A(l4=24)より長い。
    check('#PPZExtendパートが最長なら、その値になる', byte === 96, `byte=0x${byte.toString(16)}`);
  }

  // 4. ループ(`:`無し): 本体をn回展開。 o4 l8 [ c d ]5 → (12+12)*5=120クロック。
  {
    const { byte } = fixedAreaByte('A @1 o4 l8 [ c d ]5');
    check('コロン無しループはbefore×nで展開される(120クロック)', byte === 120, `byte=0x${byte.toString(16)}`);
  }

  // 5. ループ(`:`あり): 最終回だけafter区間を再生しない
  //    (before×n + after×(n-1))。o4 l8 [ c d : e ]4 →
  //    before=12+12=24、after=12、n=4 → 24*4+12*3=96+36=132。
  {
    const { byte } = fixedAreaByte('A @1 o4 l8 [ c d : e ]4');
    check('コロン付きループはbefore×n+after×(n-1)で展開される(132クロック)', byte === 132, `byte=0x${byte.toString(16)}`);
  }

  // 6. ネストしたループ: 内側の展開後クロック数を外側の1イベント分として加算。
  //    o4 l8 [ c [ d : e ]3 ]2 →
  //    内側: before=12,after=12,n=3 → 12*3+12*2=36+24=60。
  //    外側: before=(c=12)+(内側=60)=72、コロン無し、n=2 → 72*2=144。
  {
    const { byte } = fixedAreaByte('A @1 o4 l8 [ c [ d : e ]3 ]2');
    check('ネストしたループが正しく展開される(144クロック)', byte === 144, `byte=0x${byte.toString(16)}`);
  }

  // [陽性対照] computeLongestPartTicks()を無効化して固定値0x60に戻すと、
  // 上記の非対称な期待値(24等)とズレて検出できることを確認する。
  {
    const compilerPath = new URL('../compiler/pmd_mml_compiler.mjs', import.meta.url).pathname;
    const orig = fs.readFileSync(compilerPath, 'utf8');
    const NEEDLE = 'rel[rhythmFixedAddr] = computeLongestPartTicks(tracks, header) & 0xff;';
    if (!orig.includes(NEEDLE)) {
      check('[陽性対照・前提] 対象コードが見つかる', false, 'NEEDLEが一致しない(実装が変わった?)');
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
        check('[陽性対照] 固定値0x60に戻すと単音l4(期待値24)のテストが失敗として検出される',
          parsed.byte === 0x60 && parsed.byte !== 24, out);
      } finally {
        fs.writeFileSync(compilerPath, orig, 'utf8');
      }
    }
  }

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main();
