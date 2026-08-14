#!/usr/bin/env node
// tools/sample_fur_elise.mml をコンパイルして html/sample_fur_elise.M を生成する。
// html/ は tools/build_dist.sh が dist/ へ丸ごとコピーするディレクトリなので、
// ここに置けば同梱サンプルとして配布物にも自動で乗る。
//
// 実行: node tools/gen_sample_fur_elise.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileMml } from './pmd_mml_compiler.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mmlPath = path.join(__dirname, 'sample_fur_elise.mml');
const outPath = path.join(__dirname, '..', 'html', 'sample_fur_elise.M');

const source = fs.readFileSync(mmlPath, 'utf8');
const { file, errors } = compileMml(source);
if (errors.length > 0) {
  console.error('compile failed:');
  for (const e of errors) console.error(`  line ${e.line}: ${e.message}`);
  process.exit(1);
}
fs.writeFileSync(outPath, file);
console.log(`[gen_sample_fur_elise.mjs] wrote ${outPath} (${file.length} bytes)`);
