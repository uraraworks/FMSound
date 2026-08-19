#!/usr/bin/env node
// 回帰テスト(バッチ3a-1): 実データ第三者MML8本のうち未対応だった単発コマンド群。
//
// 対象・出典(すべてWebFetchでPMDMML.MAN原文を取得し確認済み):
//   E(無印)  SSG/PCMソフトウエアエンベロープ指定       PMDMML.MAN §8-1
//            書式1(4引数 AL,DD,SR,RR)  -> `.M`側 0xf0 + 4byte
//              (fmdriver_pmd.c:2650 pmd_cmdf0_env_old実測)
//            書式2(5-6引数 AR,DR,SR,RR,SL,AL) -> `.M`側 0xcd + 5byte
//              (fmdriver_pmd.c:3410 pmd_cmdcd_env_new実測、SL/RRの詰め方もそこから確定)
//            [音源]マニュアルはSSG/PCM(AD,86,PPZ)専用と明記するが、2026-08-19の
//            MC.EXE ver4.8s実測(PEFM.MML)でFMパートでも受理され同一の0xf0+4byte
//            を出すと確認できたため、FMパートでも受理する(バッチ5)。
//   s        FM音源使用スロット位置指定                 PMDMML.MAN §6-2
//            `.M`側 0xcf + 1byte(fmdriver_pmd.c:3313 pmd_cmdcf_slotmask実測)。FM専用。
//   P(大文字) SSG/OPM トーン・ノイズ出力選択             PMDMML.MAN §6-5
//            `.M`側 0xed + 1byte(fmdriver_pmd.c:2696 pmd_cmded_ssgmix実測)。
//            本実装ではSSGパート向けのみ対応(OPMのHパート用法は非対応のまま)。
//   /        コンパイル打ち切り                         PMDMML.MAN §16-4
//            「そのパートのCompileを、そこで打ち切ります」。出力バイトは無く、
//            以降その行の残り・後続行の同じパート文字を一切コンパイルしない。
//
// 実データ実例(バッチ3aのスコープ):
//   E1,-3,2,0 / E2,-4,70,0 / E3,-2,1,0 (いずれも書式1、DS4_MAIA.mml・
//   MSO_ET_Virtual_Intensity_88.MML・MULE_op_loop.MML)
//   s3 / s12 (MSO_FM_FS_PPZ.MML)
//   ABDEFJK /(MULE_op_loop.MML、K混在)
//   P1 / P2(MULE_op_loop.MML、マクロ!x/!y展開内。SSGパートI向け)
//
// このバッチのスコープ外(意図的に対応しない): #FM3Extend・拡張パート(x/y)はバッチ3bの
// スコープ。W(擬似エコー)・DT/SLの資料範囲外値・FMパートへのE・小文字w(ノイズ周波数)は
// 2026-08-19のMC.EXE実測(バッチ5、tools/pmd-reference/追加分・FINDINGS.md参照)で対応済み。
//
// 実行: node tools/verify_pmd_ssg_misc_commands.mjs

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

function compileOk(mml) {
  const r = compileMml(mml, { tones: { 1: {} } });
  if (r.errors && r.errors.length > 0) {
    throw new Error(`compile failed for "${mml}": ${JSON.stringify(r.errors)}`);
  }
  return r;
}

function findEvent(r, part, type) {
  return r.layout.tracks[part].events.find((e) => e.type === type);
}

function main() {
  // 1. E書式1(4引数)がSSGパートで受理され、0xf0 + AL/DD(符号付き)/SR/RRの5byteになる。
  {
    // 2026-08-19追記: SSGパートの`@n`はFINDINGS.md 9番の実測により、それ自体が
    // ssgEnvOldイベントへ展開されるようになった(タスク1)。この`@1`はもともと
    // 単なる無害な前置き(F音色テーブル検証用のダミー)だったが、SSGでは今や
    // それ自体がE(無印)より先にssgEnvOldイベントを1個生成してしまい、下の
    // findEvent(最初の一致)がE(無印)ではなく`@1`側を拾ってしまうため取り除く
    // (Eコマンド自体の検証には不要だった)。
    const r = compileOk('G o4 E1,-3,2,0 c4');
    const ev = findEvent(r, 'G', 'ssgEnvOld');
    check('E1,-3,2,0(書式1)がssgEnvOldイベントになる', !!ev && ev.al === 1 && ev.dd === -3 && ev.sr === 2 && ev.rr === 0,
      JSON.stringify(ev));
    const bytes = r.file.slice(ev._addr + 1, ev._addr + 1 + 5);
    check('E1,-3,2,0 のバイト列が 0xf0 01 fd 02 00', bytes.length === 5 && bytes[0] === 0xf0 && bytes[1] === 1 && bytes[2] === 0xfd && bytes[3] === 2 && bytes[4] === 0,
      Array.from(bytes).map((b) => b.toString(16)).join(' '));
  }

  // 2. E書式1・負のDD値が実データそのまま(E2,-4,70,0)通る。
  {
    const r = compileOk('H o4 E2,-4,70,0 c4');
    const ev = findEvent(r, 'H', 'ssgEnvOld');
    check('E2,-4,70,0 が受理される(実データ実例)', !!ev && ev.al === 2 && ev.dd === -4 && ev.sr === 70 && ev.rr === 0, JSON.stringify(ev));
  }

  // 3. E書式2(5引数)がSSGパートで受理され、0xcd + 5byteになる(マニュアル例
  //    「E31,18,4,15,2」、AL省略時0)。
  {
    const r = compileOk('G @1 o4 E31,18,4,15,2 c4');
    const ev = findEvent(r, 'G', 'ssgEnvNew');
    check('E31,18,4,15,2(書式2、AL省略)がssgEnvNewイベントになる',
      !!ev && ev.ar === 31 && ev.dr === 18 && ev.sr === 4 && ev.rr === 15 && ev.sl === 2 && ev.al === 0,
      JSON.stringify(ev));
    const bytes = r.file.slice(ev._addr + 1, ev._addr + 1 + 6);
    // RR=15=0xf, SL=2 -> 上位nibble=(2^0xf)=0xd, 下位nibble=RR&0xf=0xf -> 0xdf
    check('E31,18,4,15,2 のバイト列が 0xcd 1f 12 04 df 00',
      bytes.length === 6 && bytes[0] === 0xcd && bytes[1] === 0x1f && bytes[2] === 0x12 && bytes[3] === 0x04 && bytes[4] === 0xdf && bytes[5] === 0x00,
      Array.from(bytes).map((b) => b.toString(16)).join(' '));
  }

  // 4. E(書式1)はFMパートでも受理される。2026-08-19のMC.EXE ver4.8s実測(PEFM.MML:
  //    「A o4 l4 E1,-3,2,0 c」→パートA先頭が f0 01 fd 02 00)で確認済み。
  {
    const r = compileOk('A @1 o4 E1,-3,2,0 c4');
    const ev = findEvent(r, 'A', 'ssgEnvOld');
    check('EをFMパートで使っても受理されssgEnvOldイベントになる', !!ev && ev.al === 1 && ev.dd === -3 && ev.sr === 2 && ev.rr === 0,
      JSON.stringify(ev));
    const bytes = r.file.slice(ev._addr + 1, ev._addr + 1 + 5);
    check('FMパートのE1,-3,2,0 のバイト列がSSGと同じ 0xf0 01 fd 02 00',
      bytes.length === 5 && bytes[0] === 0xf0 && bytes[1] === 1 && bytes[2] === 0xfd && bytes[3] === 2 && bytes[4] === 0,
      Array.from(bytes).map((b) => b.toString(16)).join(' '));
  }

  // 5. s(FM使用スロット位置)がFMパートで受理され、0xcf + 1byte。
  {
    const r = compileOk('C @1 o4 s3 c4');
    const ev = findEvent(r, 'C', 'fmSlotMask');
    check('s3がfmSlotMaskイベント(value=3)になる', !!ev && ev.value === 3, JSON.stringify(ev));
    const bytes = r.file.slice(ev._addr + 1, ev._addr + 3);
    check('s3 のバイト列が 0xcf 03', bytes.length === 2 && bytes[0] === 0xcf && bytes[1] === 3, Array.from(bytes).map((b) => b.toString(16)).join(' '));
  }

  // 6. sはSSGパートでは未対応(PMDMML.MAN §6-2「[音源]FM」)。
  {
    const r = compileMml('G @1 o4 s3 c4', { tones: { 1: {} } });
    check('sをSSGパートで使うとエラーになる(§6-2、FM専用)', r.errors.length > 0, JSON.stringify(r.errors));
  }

  // 7. P(大文字、SSGトーン/ノイズ選択)がSSGパートで受理され、0xed + 1byte。
  // 2026-08-19、MC.EXE ver4.8s実測(PPTBL.MML、tools/pmd-reference/pmdptbl.mml/.M)で
  // 引数byteの変換表を確定: P1→0x07, P2→0x38, P3→0x3f(0x07|0x38)。値をそのまま
  // (val&0xff)出力する旧仮実装の期待値(0xed 01)はこの実測より前の手書きの推測であり、
  // 実測結果と食い違うため更新する(旧仮実装のコメントにも「1byteをそのまま格納」という
  // 未検証の推測である旨が明記されていた)。
  {
    const r = compileOk('I @1 o4 P1 c4');
    const ev = findEvent(r, 'I', 'ssgToneNoise');
    check('P1がssgToneNoiseイベント(value=1)になる', !!ev && ev.value === 1, JSON.stringify(ev));
    const bytes = r.file.slice(ev._addr + 1, ev._addr + 3);
    check('P1 のバイト列が 0xed 07(MC.EXE実測、PPTBL.MML)', bytes.length === 2 && bytes[0] === 0xed && bytes[1] === 0x07, Array.from(bytes).map((b) => b.toString(16)).join(' '));
  }
  // 7b. P2/P3も同じ変換表に従う(MC.EXE実測)。
  {
    const r = compileOk('I @1 o4 P2 c4 P3 c4');
    const evs = r.layout.tracks.I.events.filter((e) => e.type === 'ssgToneNoise');
    check('P2/P3が両方ssgToneNoiseイベントになる', evs.length === 2 && evs[0].value === 2 && evs[1].value === 3, JSON.stringify(evs));
    const bytes2 = r.file.slice(evs[0]._addr + 1, evs[0]._addr + 3);
    const bytes3 = r.file.slice(evs[1]._addr + 1, evs[1]._addr + 3);
    check('P2 のバイト列が 0xed 38(MC.EXE実測)', bytes2.length === 2 && bytes2[0] === 0xed && bytes2[1] === 0x38, Array.from(bytes2).map((b) => b.toString(16)).join(' '));
    check('P3 のバイト列が 0xed 3f(MC.EXE実測、0x07|0x38)', bytes3.length === 2 && bytes3[0] === 0xed && bytes3[1] === 0x3f, Array.from(bytes3).map((b) => b.toString(16)).join(' '));
  }

  // 8. w(小文字、SSGノイズ周波数)がSSGパートで受理され、0xee + 1byte。
  //     2026-08-19、WebNP2+FreeDOS上の実機MC.EXE ver4.8sをPWL.MMLで実測して確定
  //     (バッチ5): `G o4 l4 w6 c` → パートG先頭が `ee 06`。
  {
    const r = compileOk('G @1 o4 w6 c4');
    const ev = findEvent(r, 'G', 'ssgNoiseFreq');
    check('w6がssgNoiseFreqイベント(value=6)になる', !!ev && ev.value === 6, JSON.stringify(ev));
    const bytes = r.file.slice(ev._addr + 1, ev._addr + 3);
    check('w6 のバイト列が 0xee 06(PWL.MML実測どおり)', bytes.length === 2 && bytes[0] === 0xee && bytes[1] === 6, Array.from(bytes).map((b) => b.toString(16)).join(' '));
  }

  // 9. wはFMパートでは未対応(Pと同様SSG専用として扱う)。
  {
    const r = compileMml('A @1 o4 w6 c4', { tones: { 1: {} } });
    check('wをFMパートで使うとエラーになる(SSG専用)', r.errors.length > 0, JSON.stringify(r.errors));
  }

  // 10. Pの範囲は1-3(§6-5)、P0やP4はエラー。
  {
    const r = compileMml('I @1 o4 P4 c4', { tones: { 1: {} } });
    check('P4(範囲外)はエラーになる(§6-5、範囲1-3)', r.errors.length > 0, JSON.stringify(r.errors));
  }

  // 11. '/'(コンパイル打ち切り)は同じ行の残りを捨てる(§16-4例「A cde /」「A fga」->「A cde」相当)。
  {
    const r = compileOk('A @1 o4 cde / fga');
    const notes = r.layout.tracks.A.events.filter((e) => e.type === 'note').map((e) => e.noteIndex);
    // c=0,d=2,e=4。'/'以降のf,g,aは一切積まれないはず。
    check("'cde / fga' は cde だけがコンパイルされる(fga以降は打ち切り)",
      JSON.stringify(notes) === JSON.stringify([0, 2, 4]), JSON.stringify(notes));
  }

  // 12. '/'は後続行の同じパート文字も打ち切る(§16-4の例そのもの: 2行にまたがるA)。
  {
    const r = compileOk('A @1 o4 cde /\nA fga');
    const notes = r.layout.tracks.A.events.filter((e) => e.type === 'note').map((e) => e.noteIndex);
    check("'/'の後続行(同じパート文字A)も一切コンパイルされない(§16-4の複数行例)",
      JSON.stringify(notes) === JSON.stringify([0, 2, 4]), JSON.stringify(notes));
  }

  // 13. '/'は他パートには影響しない(そのパートだけを打ち切る)。
  {
    const r = compileOk('A @1 o4 cde /\nB @1 o4 fga');
    const notesB = r.layout.tracks.B.events.filter((e) => e.type === 'note').map((e) => e.noteIndex);
    check("'/'は指定したパート(A)だけに効き、Bはそのまま演奏される",
      JSON.stringify(notesB) === JSON.stringify([5, 7, 9]), JSON.stringify(notesB));
  }

  // 14. Kパートでも'/'が効く(実データ MULE_op_loop.MML「ABDEFJK /」相当)。
  {
    const r = compileOk('K \\b /\nK \\s');
    const events = r.layout.tracks.K.events;
    check("Kパートの'/'以降(2行目の\\s)は一切コンパイルされない", events.length === 1 && events[0].type === 'rhShot',
      JSON.stringify(events));
  }

  // 15. [陽性対照] '/'の分岐そのものを無効化すると、上の11番(打ち切り)が実際に落ちることを確認する。
  {
    const parserPath = new URL('../compiler/pmd_mml_parser.mjs', import.meta.url);
    const orig = fs.readFileSync(parserPath, 'utf8');
    const NEEDLE = "    if (c === '/') {\n      // コンパイル打ち切り。PMDMML.MAN §16-4「そのパートのCompileを、そこで打ち切ります」。";
    if (!orig.includes(NEEDLE)) {
      throw new Error('陽性対照用のパッチ対象コードが見つかりません(製品コードが変更された可能性)');
    }
    const broken = orig.replace(NEEDLE, "    if (false) {\n      // (陽性対照で無効化)");
    if (broken === orig) throw new Error('陽性対照用のパッチが効いていません');
    fs.writeFileSync(parserPath, broken, 'utf8');
    try {
      const compilerUrl = new URL('../compiler/pmd_mml_compiler.mjs', import.meta.url).href;
      const script = `
        import('${compilerUrl}').then(({ compileMml }) => {
          const r = compileMml('A @1 o4 cde / fga', { tones: { 1: {} } });
          const notes = r.layout ? r.layout.tracks.A.events.filter(e => e.type === 'note').map(e => e.noteIndex) : null;
          process.stdout.write(JSON.stringify({ errors: r.errors, notes }));
        }).catch((e) => { process.stdout.write(JSON.stringify({ threw: String(e && e.message) })); });
      `;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
      const parsed = JSON.parse(out);
      // 壊した状態では'/'が単に「未対応の文字」エラーになるはず(打ち切りが機能しない)。
      const brokenDetected = parsed.threw || (parsed.errors && parsed.errors.length > 0);
      check("[陽性対照] '/'の分岐を無効化すると 'cde / fga' のコンパイルが失敗する(検出器が機能している証拠)", !!brokenDetected, out);
    } finally {
      fs.writeFileSync(parserPath, orig, 'utf8');
    }
  }

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main();
