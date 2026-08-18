#!/usr/bin/env node
// 回帰テスト: `#FM3Extend`(FM音源3チャネル目のパート拡張、PMDMML.MAN §2-20)。
//
// 出典: WebFetch(raw.githubusercontent.com/d2lmirrors/pmd/master/mc/PMDMML.MAN)で
// 取得した生バイト列をCP932デコード+NEL(0x85)を改行として展開した全文から §2-20 を確認:
//   [書式] #FM3Extend	パート記号１[パート記号２[パート記号３]]]
//   [記号] LMNOPQSTUVWXYZabcdefghijklmnopqrstuvwxyz のうちのいずれか
//   [説明] FM音源3のパートを、指定したパート記号で拡張します。最大３ｃｈ分設定可能です。
// これは#PPZExtend(§2-25)と全く同じ記号表・構文(区切り文字なし、宣言順で並べる)。
// upstream/98fmplayer/fmdriver/fmdriver_pmd.c 側の裏取り:
//   - fmdriver_pmd.h: enum PMD_PART_* は ...RHYTHM(10), FM_3B(11), FM_3C(12), FM_3D(13),
//     PPZ_1(14)... の順(§1-1-3表2「任意1/2/3 FM音源3」に対応する3スロット)。
//   - pmd_cmdc6_fm3ex_init(:3554)が0xc6コマンドとして3スロット×2byteポインタ
//     (0なら該当スロットskip)を読み、PMD_PART_FM_3B+iへ書き込む
//     (0xb4/pmd_cmdb4_ppz8_init、#PPZExtend実装で使ったのと同じ「拡張コマンドで
//     複数トラックへのポインタ表を渡す」パターン)。
//   - pmd_cmdc7/c8_fm3ex_det(_add)は`pmd->proc_ch != 3`ならno-opにフォールバックする
//     ガードを持ち、0xc6はFM3(Cパート)の処理文脈でのみ意味を持つコマンド。
//
// 実装範囲(2026-08-19、バッチ3b): 構文の受理(ヘッダ検証・宣言順letters確定・
// 本文でのパート文字としての受理・kind='fm'によるFM系ルール適用)まで。
// .M側のバイト出力(0xc6コマンドの配置場所)はMC.EXE実測ができておらず
// (#PPZExtendの0xb4はtools/pmd-reference/pmdppzord.mml等のMC.EXE ver4.8s実測で
// 「ADPCMトラック先頭」という配置を確定させたが、この作業ではその実測パイプラインを
// 使う余地が無かった)、推測実装を避けるため compiler/pmd_mml_compiler.mjs は
// 専用のエラーメッセージで.M生成を止める(「もっともらしい値は正しい番地の証明には
// ならない」という既存の教訓。PPZ8の0xb4配置も当初「ファイル末尾」という推測が
// 実測で覆った実績がある)。
//
// 実行: node tools/verify_pmd_fm3extend_part.mjs

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

const TONE_BLOCK = '@1 0 0\n 31 0 0 0 0 0 0 1 0 0\n 31 0 0 0 0 0 0 1 0 0\n 31 0 0 0 0 0 0 1 0 0\n 31 0 0 0 0 0 0 1 0 0\n';

function main() {
  // 1. #FM3Extendで宣言していないパート記号は、従来通り「未対応のパート指定」で
  //    エラーになる(実データ実測前の既存挙動が壊れていないことの確認)。
  {
    const mml = `${TONE_BLOCK}\nC @1 o4 c4\nx @1 o4 c4\n`;
    const r = compileMml(mml, {});
    check('#FM3Extend未宣言の"x"は未対応のパート指定エラーになる',
      r.errors.length === 1 && /未対応のパート指定/.test(r.errors[0].message), JSON.stringify(r.errors));
    check('未対応パート指定のメッセージが#FM3Extendにも言及する(誘導)',
      /#FM3Extend/.test(r.errors[0].message), r.errors[0]?.message);
  }

  // 2. #FM3Extend xy を宣言すると、x/yは「構文としては解釈できる」ところまで進み、
  //    以前のような「未対応のヘッダ」「未対応のパート指定」ではなく、.M出力未確定の
  //    専用エラー1件だけになる(実データMSO_FM_FS_PPZ.MMLの実測ケースそのもの)。
  {
    const mml = `#FM3Extend\txy\n${TONE_BLOCK}\nC @1 o4 c4\nx @1 o4 d4\ny @1 o4 e4\n`;
    const r = compileMml(mml, {});
    check('#FM3Extend xy 宣言後はエラーが1件だけ(.M出力未確定の専用エラー)',
      r.errors.length === 1, JSON.stringify(r.errors));
    check('そのエラーは「未対応のヘッダ」でも「未対応のパート指定」でもない(構文としては解釈済み)',
      r.errors.length === 1 && !/未対応のヘッダ|未対応のパート指定/.test(r.errors[0].message),
      r.errors[0]?.message);
    check('そのエラーはx,yへ言及する',
      r.errors.length === 1 && /x,y/.test(r.errors[0].message), r.errors[0]?.message);
  }

  // 3. FM3Extendパートはkind='fm'で扱われる: 2026-08-19のMC.EXE実測(バッチ5)で
  //    'E'(ソフトウエアエンベロープ)はFM系パートでも受理されると判明したため、
  //    通常のFM系パートと同様にxパートでもEが構文としては受理され、残るエラーは
  //    #FM3Extend自体の.M出力未確定エラー(0xc6配置未実測、このファイル冒頭の説明・
  //    このテストの2番と同じ)だけになる=FM系ルールの適用(partKindによる拒否をせず
  //    Eを通す)が一貫していることの裏付け。
  {
    const mml = `#FM3Extend\tx\n${TONE_BLOCK}\nC @1 o4 c4\nx @1 o4 E1,-3,2,0 c4\n`;
    const r = compileMml(mml, {});
    check("FM3Extendパート'x'でEを使ってもpartKindでは拒否されず、残エラーは.M出力未確定エラーのみ",
      r.errors.length === 1 && /出力位置/.test(r.errors[0].message) && !/partKind/.test(r.errors[0].message),
      JSON.stringify(r.errors));
  }

  // 4. ヘッダの書式検証。
  {
    const r1 = compileMml(`#FM3Extend\twxyz\n${TONE_BLOCK}\nC @1 o4 c4\n`, {});
    check('4文字は最大3パートの制限でエラーになる',
      r1.errors.length === 1 && /最大3パート/.test(r1.errors[0].message), JSON.stringify(r1.errors));

    const r2 = compileMml(`#FM3Extend\txx\n${TONE_BLOCK}\nC @1 o4 c4\n`, {});
    check('同じ記号の重複はエラーになる',
      r2.errors.length === 1 && /重複/.test(r2.errors[0].message), JSON.stringify(r2.errors));

    const r3 = compileMml(`#FM3Extend\tk\n${TONE_BLOCK}\nC @1 o4 c4\n`, {});
    check('小文字kは(Kパート混在処理との衝突回避のため)使えない記号としてエラーになる',
      r3.errors.length === 1 && /使えない記号/.test(r3.errors[0].message), JSON.stringify(r3.errors));

    const r4 = compileMml(`#PPZExtend\ta\n#FM3Extend\ta\n${TONE_BLOCK}\nC @1 o4 c4\n`, {});
    check('#PPZExtendと#FM3Extendで同じ記号を宣言するとエラーになる',
      r4.errors.some((e) => /#PPZExtend でも宣言されています/.test(e.message)), JSON.stringify(r4.errors));
  }

  // 5. 既存の#PPZExtendは今回の変更で壊れていない(回帰確認)。
  {
    const mml = `#PPZExtend\tab\n${TONE_BLOCK}\nC @1 o4 c4\na @1 o4 d4\n`;
    const r = compileMml(mml, {});
    check('#PPZExtendは従来通り.M生成まで成功する(今回の変更で壊れていない)',
      r.errors.length === 0 && r.file != null, JSON.stringify(r.errors));
  }

  // 6. [陽性対照] fm3ExtendSetによる受理(partLetters.push分岐)を無効化すると、
  //    上の2のケース(#FM3Extend宣言済みのx/yが構文として通ること)が実際に崩れ、
  //    再び「未対応のパート指定」エラーに戻ることを確認する(子プロセスで新しい
  //    モジュールグラフとして読み直す。同一プロセス内でのdynamic importはNodeの
  //    ESMキャッシュにより無効化できない。tools/verify_pmd_part_restriction_pipe.mjs
  //    と同じ手法)。
  {
    const parserPath = new URL('../compiler/pmd_mml_parser.mjs', import.meta.url);
    const orig = fs.readFileSync(parserPath, 'utf8');
    const NEEDLE = "if (ppzExtendSet.has(ch) || fm3ExtendSet.has(ch)) {";
    const count = orig.split(NEEDLE).length - 1;
    if (count !== 1) {
      throw new Error(`陽性対照用のパッチ対象コードが見つかりません(想定1箇所、実際${count}箇所)`);
    }
    const broken = orig.replace(NEEDLE, 'if (ppzExtendSet.has(ch)) {');
    if (broken === orig) {
      throw new Error('陽性対照用のパッチが効いていません(製品コードが変更された可能性)');
    }
    fs.writeFileSync(parserPath, broken, 'utf8');
    try {
      const compilerUrl = new URL('../compiler/pmd_mml_compiler.mjs', import.meta.url).href;
      const mml = `#FM3Extend\txy\n${TONE_BLOCK}\nC @1 o4 c4\nx @1 o4 d4\ny @1 o4 e4\n`;
      const script = `
        import('${compilerUrl}').then(({ compileMml }) => {
          const r = compileMml(${JSON.stringify(mml)}, {});
          process.stdout.write(JSON.stringify({ errors: r.errors }));
        }).catch((e) => { process.stdout.write(JSON.stringify({ threw: String(e && e.message) })); });
      `;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
      const parsed = JSON.parse(out);
      const hasUnsupportedPart = Array.isArray(parsed.errors)
        && parsed.errors.some((e) => /未対応のパート指定/.test(e.message));
      check('[陽性対照] fm3ExtendSet受理を無効化すると、宣言済みのx/yが再び「未対応のパート指定」エラーになる(検出器が機能している証拠)',
        hasUnsupportedPart, out);
    } finally {
      fs.writeFileSync(parserPath, orig, 'utf8');
    }
  }

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main();
