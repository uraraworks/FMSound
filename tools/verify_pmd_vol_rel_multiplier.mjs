#!/usr/bin/env node
// 回帰テスト: '(' ')'(音量相対変化、基本形。数値のみ・%無し)の倍率がパート種別ごとに
// 異なる件(compiler/pmd_mml_parser.mjs readVolRelArgのmultiplier)。
//
// 実測:
//   - FM: ×4(既存確認分)。
//   - SSG(partKind==='ssg'): ×1(2026-08-19実測、DS4_MAIA.mmlのG/H/Iパート、
//     `(3`→参照.Mは`e2 03`(=3そのまま)、旧実装は`e2 0c`(=3×4=12)で食い違っていた)。
//   - PPZ8拡張(partKind==='ppz'): ×16(2026-08-19実測、MSO_FM_FS_PPZ.MMLのPPZ8拡張
//     パート、`(2`→参照.Mは`e2 20`(=2×16=32)、旧実装は`e2 08`(=2×4=8))。
//   - ADPCM(partKind==='adpcm'): ×16(2026-08-19実測、MSO_ET_Virtual_Intensity_88.MML
//     line165のJパート(ADPCM)、`(2`→参照.Mは`e2 20`(=2×16=32)、旧実装は`e2 08`
//     (=2×4=8)。以前「未実測のため暫定でFMと同じ×4」としていた分岐を実測で確定)。
//
// 実行: node tools/verify_pmd_vol_rel_multiplier.mjs

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

// letter(パート文字)のトラック本体バイト列(終端0x80を含まない)を返す。
function compileTrackBytes(letter, body, opts = {}) {
  const source = `${letter} ${body}\n`;
  const { file, errors, layout } = compileMml(source, opts);
  if (errors.length > 0) {
    throw new Error(`コンパイル失敗: ${JSON.stringify(errors)}`);
  }
  const { startAddr, termAddr } = layout.tracks[letter];
  return file.subarray(1 + startAddr, 1 + termAddr);
}

function main() {
  // FM(A): (5 → 0xe2, 5*4=20
  {
    const bytes = compileTrackBytes('A', '(5');
    check('FM: (5 は ×4 で 0xe2,20', bytes[0] === 0xe2 && bytes[1] === 20, `bytes=${[...bytes]}`);
  }

  // SSG(G): (3 → 0xe2, 3*1=3(無変換)
  {
    const bytes = compileTrackBytes('G', '(3');
    check('SSG: (3 は ×1(無変換)で 0xe2,3', bytes[0] === 0xe2 && bytes[1] === 3, `bytes=${[...bytes]}`);
  }

  // PPZ8拡張(小文字a、#PPZExtend宣言が必要): (2 → 0xe2, 2*16=32
  {
    const source = '#PPZExtend a\na (2\n';
    const { file, errors, layout } = compileMml(source);
    if (errors.length > 0) throw new Error(`コンパイル失敗: ${JSON.stringify(errors)}`);
    const { startAddr, termAddr } = layout.tracks.a;
    const bytes = file.subarray(1 + startAddr, 1 + termAddr);
    check('PPZ8拡張: (2 は ×16 で 0xe2,32(0x20)', bytes[0] === 0xe2 && bytes[1] === 32, `bytes=${[...bytes]}`);
  }

  // ADPCM(J): (2 → 0xe2, 2*16=32(2026-08-19実測で×4から×16へ訂正)
  {
    const bytes = compileTrackBytes('J', '(2');
    check('ADPCM: (2 は ×16 で 0xe2,32(0x20)', bytes[0] === 0xe2 && bytes[1] === 32, `bytes=${[...bytes]}`);
  }

  // [陽性対照] ADPCMをFMと同じ×4に戻すと、上のADPCMケース(期待値32)が
  // ズレて検出できることを確認する(子プロセスで新しいモジュールグラフとして読み直す)。
  {
    const parserPath = new URL('../compiler/pmd_mml_parser.mjs', import.meta.url).pathname;
    const orig = fs.readFileSync(parserPath, 'utf8');
    const NEEDLE = "const multiplier = partKind === 'ssg' ? 1 : (partKind === 'ppz' || partKind === 'adpcm') ? 16 : 4;";
    if (!orig.includes(NEEDLE)) {
      check('[陽性対照・前提] 対象コードが見つかる', false, 'NEEDLEが一致しない(実装が変わった?)');
    } else {
      const broken = orig.replace(NEEDLE, "const multiplier = partKind === 'ssg' ? 1 : partKind === 'ppz' ? 16 : 4;");
      fs.writeFileSync(parserPath, broken, 'utf8');
      try {
        const compilerUrl = new URL('../compiler/pmd_mml_compiler.mjs', import.meta.url).href;
        const script = `
          import('${compilerUrl}').then(({ compileMml }) => {
            const r = compileMml('J (2\\n');
            const { startAddr, termAddr } = r.layout.tracks.J;
            const bytes = r.file.subarray(1 + startAddr, 1 + termAddr);
            process.stdout.write(JSON.stringify({ bytes: [...bytes] }));
          }).catch((e) => { process.stdout.write(JSON.stringify({ threw: String(e && e.message) })); });
        `;
        const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
        const parsed = JSON.parse(out);
        const b = parsed.bytes || [];
        check('[陽性対照] ADPCMを×4に戻すとJの(2が0xe2,8(期待値32でない)になり検出される',
          b[0] === 0xe2 && b[1] === 8 && b[1] !== 32, out);
      } finally {
        fs.writeFileSync(parserPath, orig, 'utf8');
      }
    }
  }

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main();
