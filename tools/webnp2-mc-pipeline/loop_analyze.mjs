// MML -> 自作コンパイラの.M と参照.Mの双方について、各パート内のループ終端(0xf8)
// マーカーの位置・繰り返し回数・カウンタを列挙して比較する汎用ツール。
// 使い方: node loop_analyze.mjs <mmlPath> <refMPath> [ffPath]
import fs from 'node:fs';
import { readHeader, computePartRegions, PART_NAMES } from '../compare_pmd_m.mjs';
import { compileMml } from '../../compiler/pmd_mml_compiler.mjs';
import { decodeMmlBytes } from '../../net/charset.js';

const mmlPath = process.argv[2];
const refPath = process.argv[3];
const ffPath = process.argv[4];
if (!mmlPath || !refPath) {
  console.error('使い方: node loop_analyze.mjs <mmlPath> <refMPath> [ffPath]');
  process.exit(1);
}

const mmlBuf = fs.readFileSync(mmlPath);
const { text: src } = decodeMmlBytes(mmlBuf);
let ffFile;
if (ffPath) ffFile = fs.readFileSync(ffPath);
const res = compileMml(src, ffFile ? { ffFile } : {});
if (res.errors && res.errors.length) {
  console.log('COMPILE ERRORS:', res.errors.slice(0,10));
  process.exit(1);
}
const own = Buffer.from(res.file);
const ref = fs.readFileSync(refPath);

function findLoopCloses(bytes, label) {
  const header = readHeader(bytes);
  const regions = computePartRegions(header, bytes.length);
  const results = [];
  for (const name of PART_NAMES) {
    const r = regions[name];
    if (!r) continue;
    // absolute offset = rel + 1
    const start = r.start + 1;
    const end = r.end + 1;
    for (let i = start; i < end - 4 && i < bytes.length - 4; i++) {
      if (bytes[i] === 0xf8) {
        results.push({ part: name, addr: i, count: bytes[i+1], counter: bytes[i+2] });
      }
    }
  }
  return results;
}

console.log('=== OWN ===');
console.log(JSON.stringify(findLoopCloses(own, 'own'), null, 0));
console.log('=== REF ===');
console.log(JSON.stringify(findLoopCloses(ref, 'ref'), null, 0));
