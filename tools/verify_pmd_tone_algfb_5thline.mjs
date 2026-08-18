#!/usr/bin/env node
// PMD MML 音色定義: ALG/FBを5行目に書く形式(オペレータ4行の直後に「ALG,FB」の
// 2数値だけの行を置く)の検証。
//
// 背景: 実データ(第三者作品、本ファイルへの転記はしない)の音色定義で、
//   @ 音色番号 ALG FB
//    (オペレータ4行)
//    ALG,FB   <- ここ(5行目)
// という形式が実在した。PMDMML.MAN §3-1にはこの5行目は記載が無い([書式1]/[書式2]/
// [書式3]いずれもヘッダ1行+オペレータ行のみ)。自作コンパイラは元々この5行目を
// 想定しておらず、「行はパート指定(A-I)または音色定義(@)で始まる必要があります」の
// 誤エラーになっていた。
//
// 実機検証(2026-08-18、WebNP2+FreeDOS上の実機 MC.EXE ver4.8sに`/V`オプション付きで
// 自作の3ケースを食わせて実測):
//   - ヘッダ@1 5 3 + 5行目"2,1"        → 出力のALG/FBは 5,3 (ヘッダ通り)
//   - ヘッダ@1 2 1 + 5行目"5,3"        → 出力のALG/FBは 2,1 (ヘッダ通り)
//   - ヘッダ@1 5 3 + 5行目なし(対照)   → 出力のALG/FBは 5,3
// 3ケースとも「5行目の値は完全に無視され、常にヘッダ行のALG/FBが使われる」ことを
// 確認した。ヘッダのALG/FBを省略して5行目だけに書く形も試したが、オペレータ行の
// 数値がバイト単位でずれた壊れたエントリになった(PMDMML.MANの「数値の省略は
// 出来ません」という記載と整合。5行目単独形式は無効ということ)。
//
// 実装方針: 5行目を構文としては許容(黙って落とすエラーにはしない)しつつ、値は
// 使わず読み飛ばす(ヘッダの値を採用する)。tools/pmd-reference/pmdalg5.mml/.M が
// この回帰用corpusケース(node tools/verify_pmd_reference_corpus.mjs 経由)。
//
// このファイルの役割: tools/compare_pmd_m.mjs のパート単位比較(11トラック領域のみ)
// は音色テーブル領域を見ないため、ALG/FBの取り違えがあっても検出できない
// (実測して確認: gen_pmd_min.mjsのALG/FBビット順を意図的に入れ替えても
// verify_pmd_reference_corpus.mjsの`パート一致`は変化しなかった)。そのためここで
// 音色テーブル領域を含めた「.M全体のバイト完全一致」を直接検査し、かつ
// [陽性対照]としてALG/FBバイトを意図的に入れ替えた比較が実際に不一致として
// 検出されることも確認する。
//
// 実行: node tools/verify_pmd_tone_algfb_5thline.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileMml } from '../compiler/pmd_mml_compiler.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.join(__dirname, 'pmd-reference');

let passCount = 0;
let failCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

const mmlText = fs.readFileSync(path.join(CORPUS_DIR, 'pmdalg5.mml'), 'latin1');
const refBytes = new Uint8Array(fs.readFileSync(path.join(CORPUS_DIR, 'pmdalg5.M')));

const { file, errors } = compileMml(mmlText, {});
check('pmdalg5: コンパイルがエラー無しで成功する', errors.length === 0, JSON.stringify(errors));

if (errors.length === 0) {
  const ownBytes = new Uint8Array(file);
  const identical = ownBytes.length === refBytes.length
    && ownBytes.every((b, i) => b === refBytes[i]);
  check(
    'pmdalg5: 参照.M(実機MC.EXE ver4.8s `/V`生成)と.M全体がバイト完全一致する(音色テーブル領域含む)',
    identical,
    `own=${ownBytes.length}bytes ref=${refBytes.length}bytes`,
  );

  // 音色エントリ(tonenum=1)を全走査で探す(op1の1byte目=dt1<<4|mul=0x35で目印にする。
  // pmdalg5.mmlのop1行 "31 10 5 1 3 20 1 5 3 0" は dt1=3,mul=5 →0x35)。
  let toneOff = -1;
  for (let i = 0; i + 26 <= ownBytes.length; i++) {
    if (ownBytes[i] === 1 && ownBytes[i + 1] === 0x35) { toneOff = i; break; }
  }
  check('pmdalg5: 音色エントリ(tonenum=1)が出力中に見つかる', toneOff >= 0, `toneOff=${toneOff}`);

  if (toneOff >= 0) {
    const algFbByte = ownBytes[toneOff + 25];
    const alg = algFbByte & 0x7;
    const fb = (algFbByte >> 3) & 0x7;
    // pmdalg5.mml: ヘッダ「@1 5 3」・5行目「2,1」。ヘッダが勝つのが正しい実装。
    check('pmdalg5: ALG/FBはヘッダ行の値(5,3)になる(5行目の値2,1は無視される)', alg === 5 && fb === 3, `alg=${alg} fb=${fb}`);

    // [陽性対照] このバイトを意図的にALGとFBを入れ替えた値へ壊し、全体一致検査が
    // 実際に不一致として検出されることを確認する(検査ロジック自体の健全性の確認)。
    const brokenBytes = ownBytes.slice();
    brokenBytes[toneOff + 25] = ((alg & 0x7) << 3) | (fb & 0x7); // ALG/FBのビット位置を入れ替えた壊れた値
    const brokenIdentical = brokenBytes.length === refBytes.length
      && brokenBytes.every((b, i) => b === refBytes[i]);
    check(
      '[陽性対照] ALG/FBのビット位置を入れ替えた壊れたバイトにすると、全体一致検査が不一致を検出する',
      !brokenIdentical,
    );
    // 壊す前(現状の実装出力)は同じ検査で「一致」と判定されることも合わせて確認する
    // (検査ロジックが常にFAILを返すような壊れた検出器ではないことの前提確認)。
    check(
      '[陽性対照・前提確認] 壊す前は同じ検査で一致と判定される(検出器自体が健全)',
      ownBytes.length === refBytes.length && ownBytes.every((b, i) => b === refBytes[i]),
    );
  }
}

// --- 5行目が無い従来形式(後方互換)が壊れていないことの確認 ---
// tools/pmd-reference/pmdtone.mml は5行目の無い従来形式で、既にvery_pmd_reference_corpus
// のbaseline対象。ここでは compileMml が引き続きエラー無しで成功することだけ再確認する
// (5行目対応の追加実装が既存の4行のみのケースを壊していないことの直接的なガード)。
{
  const legacyText = fs.readFileSync(path.join(CORPUS_DIR, 'pmdtone.mml'), 'latin1');
  const legacyRef = new Uint8Array(fs.readFileSync(path.join(CORPUS_DIR, 'pmdtone.M')));
  const { file: legacyFile, errors: legacyErrors } = compileMml(legacyText, {});
  check('pmdtone(5行目なしの従来形式): コンパイルがエラー無しで成功する', legacyErrors.length === 0);
  if (legacyErrors.length === 0) {
    const legacyOwn = new Uint8Array(legacyFile);
    const legacyIdentical = legacyOwn.length === legacyRef.length
      && legacyOwn.every((b, i) => b === legacyRef[i]);
    check('pmdtone(5行目なしの従来形式): 参照.Mとバイト完全一致(退行なし)', legacyIdentical);
  }
}

console.log(`\n${passCount} 件 PASS / ${failCount} 件 FAIL`);
process.exit(failCount > 0 ? 1 : 0);
