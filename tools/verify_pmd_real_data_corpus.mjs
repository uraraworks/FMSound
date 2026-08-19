#!/usr/bin/env node
// PMD MMLコンパイラ(compiler/pmd_mml_compiler.mjs)を、実データ8本(第三者の実在楽曲、
// MC.EXE ver4.8s実測の参照.Mと突き合わせる測定スクリプト。
//
// 書式はtools/verify_pmd_compiler_oracle.mjsのPMD_REF_PAIRS・tools/verify_library.mjsの
// MCM_SAMPLE_ZIPと同じ作法: MML本体も参照.Mも第三者著作物(の派生物)なので、
// **どちらもリポジトリに置かない**。パスは環境変数で渡し、未設定ならSKIPする。
//
// 環境変数:
//   PMD_REAL_SAMPLE_DIR  MMLサンプル一式のルート(noPCM/PPC/PPZ8の3サブディレクトリと
//                        PPZ8/V5.FF(#FFFile用の外部音色ファイル)を含むディレクトリ)。
//   PMD_REF_M_DIR        MC.EXE ver4.8s実測の参照.M 8本(<stem>.M)を置いたディレクトリ。
//                        stem一覧は下のCASES参照。
//
// 実行:
//   PMD_REAL_SAMPLE_DIR=/path/to/PMD_MS_sample_3 \
//   PMD_REF_M_DIR=/path/to/refM \
//   node tools/verify_pmd_real_data_corpus.mjs
//
// 出力: stemごとに (コンパイル可否・自作/参照のバイト長・全体一致率・最初の不一致位置)、
// および tools/compare_pmd_m.mjs のパート単位比較(要約行のみ)。
//
// このスクリプトの合否判定: 「8本すべてがエラー無くコンパイルできること」をPASS条件とする
// (バイト完全一致はまだ全て通っていないため、その一致率は情報として出力するのみで
// 合否には使わない。一致すべきものが一致するかを主条件にする、という既存の教訓に沿い、
// 一致率が下がった場合に気づけるよう毎回同じ表を出す)。

import fs from 'node:fs';
import path from 'node:path';
import { compileMml } from '../compiler/pmd_mml_compiler.mjs';
import { decodeMmlBytes } from '../net/charset.js';
import { compareFiles } from './compare_pmd_m.mjs';

// stem → (実データルートからの相対MMLパス)。ROOTは環境変数から与えられる。
const CASES = [
  { stem: 'INTOPAL', mml: 'noPCM/MSO_OF_Into the Palace_N.mml' },
  { stem: 'MULE', mml: 'noPCM/MULE_op_loop.MML' },
  { stem: 'POPFUL', mml: 'noPCM/POPFUL_HOSHI.mml' },
  { stem: 'DS4MAIA', mml: 'PPC/DS4_MAIA.mml' },
  { stem: 'MSOET', mml: 'PPC/MSO_ET_Virtual_Intensity_88.MML' },
  { stem: 'MSOFMFS', mml: 'PPZ8/MSO_FM_FS_PPZ.MML' },
  { stem: 'SSTENG', mml: 'PPZ8/SS_TENG_ppz.mml' },
  { stem: 'ALPHA', mml: 'PPZ8/ALPHA_2022_ppz.MML' },
];
const FF_RELATIVE = 'PPZ8/V5.FF';

let passCount = 0;
let failCount = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${label}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

function wholeFileMatch(ownFile, refBytes) {
  const n = Math.min(ownFile.length, refBytes.length);
  let matched = 0;
  let firstDiff = null;
  for (let i = 0; i < n; i++) {
    if (ownFile[i] === refBytes[i]) matched++;
    else if (firstDiff === null) firstDiff = i;
  }
  const total = Math.max(ownFile.length, refBytes.length);
  if (firstDiff === null && ownFile.length !== refBytes.length) firstDiff = n;
  return { matched, total, rate: total > 0 ? matched / total : 1, firstDiff };
}

function main() {
  const sampleDir = process.env.PMD_REAL_SAMPLE_DIR;
  const refDir = process.env.PMD_REF_M_DIR;
  if (!sampleDir || !refDir) {
    console.log('[SKIP] PMD_REAL_SAMPLE_DIR / PMD_REF_M_DIR が未設定のため、実データでの一致率測定をスキップします。');
    console.log(`\n${passCount} PASS, ${failCount} FAIL (SKIP)`);
    process.exit(0);
  }

  const ffPath = path.join(sampleDir, FF_RELATIVE);
  if (!fs.existsSync(ffPath)) {
    console.error(`[ERROR] #FFFile用の音色ファイルが見つかりません: ${ffPath}`);
    process.exit(1);
  }
  const ff = new Uint8Array(fs.readFileSync(ffPath));

  console.log('stem       compile  ownLen  refLen  一致率     最初の不一致(全体オフセット)');
  const rows = [];
  for (const { stem, mml: relMml } of CASES) {
    const mmlPath = path.join(sampleDir, relMml);
    const refPath = path.join(refDir, `${stem}.M`);
    if (!fs.existsSync(mmlPath)) {
      check(`${stem}: MMLファイルが存在する(${mmlPath})`, false);
      continue;
    }
    if (!fs.existsSync(refPath)) {
      check(`${stem}: 参照.Mファイルが存在する(${refPath})`, false);
      continue;
    }
    const { text } = decodeMmlBytes(new Uint8Array(fs.readFileSync(mmlPath)));
    const refBytes = new Uint8Array(fs.readFileSync(refPath));
    let r;
    try {
      r = compileMml(text, { ffFile: ff });
    } catch (e) {
      check(`${stem}: 例外を投げずにコンパイルできる`, false, String(e && e.message));
      continue;
    }
    const compiled = check(`${stem}: エラー無くコンパイルできる`, r.errors.length === 0,
      r.errors.length > 0 ? JSON.stringify(r.errors.slice(0, 3)) : undefined);
    if (!compiled) continue;

    const own = r.file;
    const wf = wholeFileMatch(own, refBytes);
    const rateStr = `${(wf.rate * 100).toFixed(1)}%`;
    const diffStr = wf.firstDiff === null ? '(完全一致)' : `0x${wf.firstDiff.toString(16)}`;
    console.log(`${stem.padEnd(10)} ${'OK'.padEnd(8)} ${String(own.length).padEnd(7)} ${String(refBytes.length).padEnd(7)} ${rateStr.padEnd(10)} ${diffStr}`);

    // パート単位の要約(task3の分類作業向け。ここでは要約行のみ出す)。
    const cmp = compareFiles(own, refBytes);
    rows.push({
      stem, ownLen: own.length, refLen: refBytes.length, rate: wf.rate, firstDiff: wf.firstDiff,
      matchedParts: cmp.summary.matchedParts, totalParts: cmp.summary.totalParts,
    });
  }

  console.log('\n=== パート単位一致サマリ ===');
  for (const row of rows) {
    console.log(`  ${row.stem}: 一致パート ${row.matchedParts}/${row.totalParts}`);
  }

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main();
