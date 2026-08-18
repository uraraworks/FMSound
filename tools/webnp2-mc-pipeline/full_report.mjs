// MML -> 自作コンパイラの.M と、参照.M(WebNP2+MC.EXEパイプラインで生成したもの等)を
// 突き合わせてパート単位の一致状況を報告する汎用ツール。
// 使い方: node full_report.mjs <mmlPath> <refMPath> [ffPath]
import fs from 'node:fs';
import { compareFiles } from '../compare_pmd_m.mjs';
import { compileMml } from '../../compiler/pmd_mml_compiler.mjs';
import { decodeMmlBytes } from '../../net/charset.js';

const [,, mmlPath, refPath, ffPath] = process.argv;
if (!mmlPath || !refPath) {
  console.error('使い方: node full_report.mjs <mmlPath> <refMPath> [ffPath]');
  process.exit(1);
}
const { text: src } = decodeMmlBytes(fs.readFileSync(mmlPath));
const ffFile = ffPath ? fs.readFileSync(ffPath) : undefined;
const res = compileMml(src, ffFile ? { ffFile } : {});
if (res.errors.length) { console.log('ERRORS', res.errors); process.exit(1); }
const own = Buffer.from(res.file);
const ref = fs.readFileSync(refPath);
console.log('own len', own.length, 'ref len', ref.length, 'diff', own.length - ref.length);
let firstDiff = -1;
for (let i = 0; i < Math.max(own.length, ref.length); i++) { if (own[i] !== ref[i]) { firstDiff = i; break; } }
console.log('absolute firstDiff (incl. opmFlag byte0):', firstDiff);
const cmp = compareFiles(own, ref);
console.log('matchedParts', cmp.summary.matchedParts, '/', cmp.summary.totalParts, 'byteMatchRate', cmp.summary.totalByteMatchRate);
for (const [name, p] of Object.entries(cmp.parts)) {
  if (p.note) { console.log(name, p.note); continue; }
  console.log(name, `own=${p.ownLength} ref=${p.refLength} matched=${p.matchedLen} identical=${p.identical}`);
}
