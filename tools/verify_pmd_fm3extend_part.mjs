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
// 2026-08-19、バッチ3bでは.M側のバイト出力位置が未実測のため専用エラーで止めていたが、
// 同日2周目にWebNP2+MC.EXE ver4.8s実測(tools/pmd-reference/pmdfm3a〜e.mml、
// README.md参照)で配置を確定させ、実装した:
//   - 0xc6(FM3拡張初期化)+3スロット分のポインタ(宣言数が3未満なら残り0)を、
//     パートA(FM1)のトラック先頭に前置する。パートA自身に中身があれば、その
//     直後にA自身のイベントが続く。
//   - 拡張パート自身のトラック本体は#PPZExtendのPPZ8パートと同じ位置
//     (RHYTHMスロット直後・r_offsetの手前)に置かれる。宣言だけで本文未使用の
//     文字も、他の未使用パートと同様に空トラック(0x80)を実体として持つ。
// このファイルはバイト単位の詳細比較(pmdfm3a〜eとの完全一致)はしない
// (それは tools/verify_pmd_reference_corpus.mjs の役目)。ここでは
// compileMml()のAPIレベルの挙動(エラーの有無・0xc6の位置・ポインタの指す先)を
// 直接検証する。
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

  // 2. #FM3Extend xy を宣言すると、エラー無く.M生成まで成功し、パートA(FM1)の
  //    トラック先頭が0xc6 + x/yトラックの先頭アドレス(2byte LE×2) + 0(未宣言分)に
  //    なる(2026-08-19実測、pmdfm3b.mml「#FM3Extend xy」と同じ構成)。
  {
    const mml = `#FM3Extend\txy\n${TONE_BLOCK}\nC @1 o4 c4\nx @1 o4 d4\ny @1 o4 e4\n`;
    const r = compileMml(mml, {});
    check('#FM3Extend xy 宣言後はエラー無く.M生成まで成功する', r.errors.length === 0 && r.file != null, JSON.stringify(r.errors));
    if (r.file) {
      const a = r.layout.tracks.A;
      const x = r.layout.tracks.x;
      const y = r.layout.tracks.y;
      check('パートAのトラック先頭が0xc6(FM3拡張初期化)', r.file[1 + a.startAddr] === 0xc6, `byte=0x${r.file[1 + a.startAddr]?.toString(16)}`);
      const readPtr = (off) => r.file[1 + off] | (r.file[1 + off + 1] << 8);
      check('0xc6の第1ポインタがxトラックの先頭を指す', readPtr(a.startAddr + 1) === x.startAddr,
        `ptr=0x${readPtr(a.startAddr + 1).toString(16)} x.startAddr=0x${x.startAddr.toString(16)}`);
      check('0xc6の第2ポインタがyトラックの先頭を指す', readPtr(a.startAddr + 3) === y.startAddr,
        `ptr=0x${readPtr(a.startAddr + 3).toString(16)} y.startAddr=0x${y.startAddr.toString(16)}`);
      check('0xc6の第3ポインタは0(3個目は未宣言)', readPtr(a.startAddr + 5) === 0, `ptr=0x${readPtr(a.startAddr + 5).toString(16)}`);
      check('パートA自身は空(直後が終端0x80)', r.file[1 + a.termAddr] === 0x80 && a.termAddr === a.startAddr + 7,
        `termAddr=0x${a.termAddr.toString(16)} startAddr=0x${a.startAddr.toString(16)}`);
    }
  }

  // 3. パートA自身にも音符がある場合、0xc6ブロックの直後にA自身のイベントが続く
  //    (2026-08-19実測、pmdfm3e.mml「A o4 l4 cd」と同じ構成)。
  {
    // pmdfm3e.mml「A o4 l4 cd」と同じ構成: Aの音符には`@1`を明示しない
    // (音色は既定@1が自動的に使われる。C/x/yも同様)。
    const mml = `#FM3Extend\txy\n${TONE_BLOCK}\nA o4 l4 cd\nC o4 l4 e\nx o4 l4 f\ny o4 l4 g\n`;
    const r = compileMml(mml, {});
    check('パートA自身にも音符がある場合もエラー無く.M生成まで成功する', r.errors.length === 0 && r.file != null, JSON.stringify(r.errors));
    if (r.file) {
      const a = r.layout.tracks.A;
      check('0xc6ブロック(7byte)の直後がAの最初の音符(0x30=c)', r.file[1 + a.startAddr + 7] === 0x30,
        `byte=0x${r.file[1 + a.startAddr + 7]?.toString(16)}`);
    }
  }

  // 4. FM3Extendパートはkind='fm'で扱われる: 2026-08-19のMC.EXE実測(バッチ5)で
  //    'E'(ソフトウエアエンベロープ)はFM系パートでも受理されると判明したため、
  //    通常のFM系パートと同様にxパートでもEが構文としては受理され、
  //    partKindによる拒否をせずエラー無く.M生成まで成功する。
  {
    const mml = `#FM3Extend\tx\n${TONE_BLOCK}\nC @1 o4 c4\nx @1 o4 E1,-3,2,0 c4\n`;
    const r = compileMml(mml, {});
    check("FM3Extendパート'x'でEを使ってもpartKindでは拒否されず、エラー無く.M生成まで成功する",
      r.errors.length === 0 && r.file != null, JSON.stringify(r.errors));
  }

  // 5. 宣言だけして使わない拡張パートも、空トラック(0x80)を実体として出力する
  //    (2026-08-19実測、pmdfm3d.mml「#FM3Extend xy宣言のみ、x/y未使用」と同じ構成)。
  {
    const mml = `#FM3Extend\txy\n${TONE_BLOCK}\nC @1 o4 c4\n`;
    const r = compileMml(mml, {});
    check('宣言のみ・未使用でもエラー無く.M生成まで成功する', r.errors.length === 0 && r.file != null, JSON.stringify(r.errors));
    if (r.file) {
      // 未使用の拡張パートはtrackLayoutに登録されない(#PPZExtendの未使用スロットと同じ
      // 扱い。上のidx===10ブロック参照)ので、パートAの0xc6ブロックのポインタから
      // 直接アドレスを読む(テスト2と同じ手法)。
      const a = r.layout.tracks.A;
      const readPtr = (off) => r.file[1 + off] | (r.file[1 + off + 1] << 8);
      const xAddr = readPtr(a.startAddr + 1);
      const yAddr = readPtr(a.startAddr + 3);
      check('未使用xトラックは空(先頭が終端0x80)', r.file[1 + xAddr] === 0x80, `byte=0x${r.file[1 + xAddr]?.toString(16)}`);
      check('未使用yトラックは空(先頭が終端0x80)', r.file[1 + yAddr] === 0x80, `byte=0x${r.file[1 + yAddr]?.toString(16)}`);
      check('未使用x/yトラックは互いに異なるアドレス(共有プレースホルダではない)', xAddr !== yAddr, `x=0x${xAddr.toString(16)} y=0x${yAddr.toString(16)}`);
    }
  }

  // 6. ヘッダの書式検証。
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

  // 7. 既存の#PPZExtendは今回の変更で壊れていない(回帰確認)。
  {
    const mml = `#PPZExtend\tab\n${TONE_BLOCK}\nC @1 o4 c4\na @1 o4 d4\n`;
    const r = compileMml(mml, {});
    check('#PPZExtendは従来通り.M生成まで成功する(今回の変更で壊れていない)',
      r.errors.length === 0 && r.file != null, JSON.stringify(r.errors));
  }

  // 8. [陽性対照] fm3ExtendSetによる受理(partLetters.push分岐)を無効化すると、
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

  // 9. [陽性対照] コンパイラ側の0xc6配置(idx===0の特別処理)を無効化すると、
  //    上の2のケース(パートA先頭が0xc6になること)が実際に崩れることを確認する
  //    (子プロセスで新しいモジュールグラフとして読み直す。理由は8番と同じ)。
  {
    const compilerPath = new URL('../compiler/pmd_mml_compiler.mjs', import.meta.url);
    const orig = fs.readFileSync(compilerPath, 'utf8');
    const NEEDLE = 'if (idx === 0 && fm3ExtendLetters.length > 0) {';
    const count = orig.split(NEEDLE).length - 1;
    if (count !== 1) {
      throw new Error(`陽性対照用のパッチ対象コードが見つかりません(想定1箇所、実際${count}箇所)`);
    }
    const broken = orig.replace(NEEDLE, 'if (false && idx === 0 && fm3ExtendLetters.length > 0) {');
    if (broken === orig) {
      throw new Error('陽性対照用のパッチが効いていません(製品コードが変更された可能性)');
    }
    fs.writeFileSync(compilerPath, broken, 'utf8');
    try {
      const compilerUrl = compilerPath.href;
      const mml = `#FM3Extend\txy\n${TONE_BLOCK}\nC @1 o4 c4\nx @1 o4 d4\ny @1 o4 e4\n`;
      const script = `
        import('${compilerUrl}').then(({ compileMml }) => {
          const r = compileMml(${JSON.stringify(mml)}, {});
          if (!r.file) { process.stdout.write(JSON.stringify({ errors: r.errors })); return; }
          const a = r.layout.tracks.A;
          process.stdout.write(JSON.stringify({ firstByte: r.file[1 + a.startAddr] }));
        }).catch((e) => { process.stdout.write(JSON.stringify({ threw: String(e && e.message) })); });
      `;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
      const parsed = JSON.parse(out);
      check('[陽性対照] idx===0の0xc6配置を無効化すると、パートA先頭が0xc6ではなくなる(検出器が機能している証拠)',
        parsed.firstByte !== 0xc6, out);
    } finally {
      fs.writeFileSync(compilerPath, orig, 'utf8');
    }
  }

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main();
