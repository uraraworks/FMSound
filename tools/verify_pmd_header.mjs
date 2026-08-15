#!/usr/bin/env node
// PMD `.M` コンパイラのヘッダ命令(#Title/#Composer/#Arranger/#Memo)対応を検証する。
// pmd_mml_compiler.mjs が組み立てたメモテーブルを、実際に pmdweb(98fmplayer wasm、
// fmdriver_pmd.c由来のpmd_get_memo/pmd_get_comment そのもの)へ読み込ませ、
// work->get_comment() 経由の値(=fmdsp comment欄が表示する値そのもの)が
// 期待通りかを確認する。日本語(CP932)が化けていないことも数値比較で確認する。
//
// 実行: node tools/verify_pmd_header.mjs

import createPmdWeb from '../pmdweb/build-web/pmdweb.js';
import { compileMml } from '../compiler/pmd_mml_compiler.mjs';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

function readComment(Module, line) {
  const len = Module.getCommentLength(line);
  if (len === 0) return null;
  const ptr = Module.getCommentPointer();
  const bytes = Module.HEAPU8.slice(ptr, ptr + len);
  return { bytes, text: new TextDecoder('shift_jis').decode(bytes) };
}

async function main() {
  console.log('=== PMD ヘッダ命令(#Title/#Composer/#Arranger/#Memo)検証 ===\n');

  const src = [
    'A o4 l4 cdefg',
    '#Title エリーゼのために(WoO 59)',
    '#Composer ベートーヴェン',
    '#Memo パブリックドメイン作品/MMLアレンジは本プロジェクトの著作物',
  ].join('\n');

  const { file, errors } = compileMml(src);
  if (errors.length > 0) {
    console.error('compile failed:', errors);
    process.exit(1);
  }
  console.log(`生成した .M: ${file.length} bytes\n`);

  const Module = await createPmdWeb();
  Module.FS.writeFile('/header_test.m', file);
  const error = Module.playMusic('/header_test.m');
  if (error !== '') throw new Error(`playMusic failed: ${error}`);

  check('comment_mode_pmd が true(PMDメモモード)', Module.getCommentModePmd() === 1);

  const title = readComment(Module, 0);
  const composer = readComment(Module, 1);
  const arranger = readComment(Module, 2);
  const memo = readComment(Module, 3); // get_comment(3) -> pmd_get_memo(4) -> #Memo 1行目

  check('タイトルが取得できた', title !== null);
  check('タイトルの内容が一致', title?.text === 'エリーゼのために(WoO 59)', title?.text);
  check('作曲者が取得できた', composer !== null);
  check('作曲者の内容が一致', composer?.text === 'ベートーヴェン', composer?.text);
  check('編曲者は未指定なので取得できない(空文字は非表示扱い)', arranger === null);
  check('メモ1行目が取得できた', memo !== null);
  check(
    'メモの内容が一致',
    memo?.text === 'パブリックドメイン作品/MMLアレンジは本プロジェクトの著作物',
    memo?.text,
  );

  // 日本語が化けていないことをバイト値でも確認する(目視だけに頼らない)。
  // 「ベ」= CP932で 0x83 0x78(compiler/cp932.mjsのTextDecoder実測値。手で転記していない)。
  if (composer) {
    check(
      '作曲者の先頭2byteがCP932の「ベ」(0x83 0x78)と一致',
      composer.bytes[0] === 0x83 && composer.bytes[1] === 0x78,
      Buffer.from(composer.bytes.slice(0, 2)).toString('hex'),
    );
  }

  // ヘッダ命令を使わないMML(既存互換)は comment が一切出ないことを確認
  // (後方互換: メモテーブルを挟まない出力バイト列で壊れていないか)。
  const srcNoHeader = 'A o4 l4 cdefg';
  const { file: fileNoHeader, errors: errorsNoHeader } = compileMml(srcNoHeader);
  if (errorsNoHeader.length > 0) throw new Error('compile (no header) failed');
  const Module2 = await createPmdWeb();
  Module2.FS.writeFile('/no_header.m', fileNoHeader);
  const error2 = Module2.playMusic('/no_header.m');
  if (error2 !== '') throw new Error(`playMusic failed: ${error2}`);
  check('ヘッダ無しMMLはタイトルが取得できない(後方互換)', readComment(Module2, 0) === null);

  // CP932へ変換できない文字(例: 一部の絵文字)を含むタイトルはコンパイルエラーになる
  const srcBad = 'A o4 l4 cdefg\n#Title 🎵絶対に変換できない\n';
  const { errors: badErrors } = compileMml(srcBad);
  check('CP932非対応文字を含むタイトルはコンパイルエラーになる', badErrors.length > 0, JSON.stringify(badErrors));

  console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
