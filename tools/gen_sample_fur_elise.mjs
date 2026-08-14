#!/usr/bin/env node
// tools/sample_fur_elise.mml をコンパイルして html/sample_fur_elise.M を生成する。
// html/ は tools/build_dist.sh が dist/ へ丸ごとコピーするディレクトリなので、
// ここに置けば同梱サンプルとして配布物にも自動で乗る。
//
// html/sample_fur_elise.mml (MMLソーステキスト)も同時にコピーする: PMDエディタモード
// (html/pmd-app.js)がサンプルをMML文字列として読み込んで編集できるようにするため。
// コンパイル直後の同じソースから両方を生成するので、コンパイル済み.Mと
// エディタに読み込ませるソースが食い違う(feedback_stale_artifact_from_verification_step.md
// のような「検証で作られた配布物が古いまま残る」)事故を構造的に防ぐ。
//
// 実行: node tools/gen_sample_fur_elise.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileMml } from '../compiler/pmd_mml_compiler.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mmlPath = path.join(__dirname, 'sample_fur_elise.mml');
const outPath = path.join(__dirname, '..', 'html', 'sample_fur_elise.M');
const mmlOutPath = path.join(__dirname, '..', 'html', 'sample_fur_elise.mml');

const source = fs.readFileSync(mmlPath, 'utf8');
const { file, errors } = compileMml(source);
if (errors.length > 0) {
  console.error('compile failed:');
  for (const e of errors) console.error(`  line ${e.line}: ${e.message}`);
  process.exit(1);
}
fs.writeFileSync(outPath, file);
fs.writeFileSync(mmlOutPath, source);
console.log(`[gen_sample_fur_elise.mjs] wrote ${outPath} (${file.length} bytes)`);
console.log(`[gen_sample_fur_elise.mjs] wrote ${mmlOutPath} (${source.length} bytes)`);

// 課題D: MUCOM88版(tools/sample_fur_elise_mucom.mml)は、MUCOM88エンジン自身が
// 生MMLテキストをそのままコンパイルできる(html/mucom-app.js compileAndPlay()の
// Module.compileMML())ため、PMD版と違って事前コンパイル(.M生成)が不要。
// テキストをそのままhtml/へコピーするだけでよい(拡張子は他のMUCOMサンプルと
// 揃えて.mucにする。html/mucom-app.js fileInput.accept='.muc'と同じ)。
const mucomMmlPath = path.join(__dirname, 'sample_fur_elise_mucom.mml');
const mucomOutPath = path.join(__dirname, '..', 'html', 'sample_fur_elise_mucom.muc');
const mucomSource = fs.readFileSync(mucomMmlPath, 'utf8');
fs.writeFileSync(mucomOutPath, mucomSource);
console.log(`[gen_sample_fur_elise.mjs] wrote ${mucomOutPath} (${mucomSource.length} bytes)`);
