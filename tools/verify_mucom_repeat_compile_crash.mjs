#!/usr/bin/env node
// 【調査専用・未修正】実機報告「新規作成/ライブラリ読込/共有リンク貼付を繰り返すと
// wasmがmemory access out of boundsで落ちる」の再現ハーネス(2026-08-17調査)。
//
// 【結論(このラウンドで判明したこと)】
//   - 再現できた。3種類の異なるMML(新規作成雛形/エリーゼのために(Für Elise)サンプル/
//     Kパート(ADPCM)ありの短い曲)を順番に繰り返しcompileMMLすると、**必ず440回目の
//     呼び出し**(=SOURCES.length=3で回しているので147巡目)でクラッシュする。
//     実機の落ちる箇所(mucom88.wasm:0x4c39 / 0x1c02e / 0x1ab6a)とオフセットが完全一致。
//   - Module.HEAPU8.lengthは最後まで19660800のまま変化しない。つまりヒープ枯渇/
//     ALLOW_MEMORY_GROWTHでの単純な伸長不足ではない(-sALLOW_MEMORY_GROWTH=1は
//     効いているが、伸びる前に別の原因で壊れている)。
//   - 単一のMMLだけを600回繰り返しても再現しない(3種それぞれ単独でOK)。
//     2種の組み合わせ(TEMPLATE+FUR_ELISE / TEMPLATE+SHARE_LIKE / FUR_ELISE+SHARE_LIKE)を
//     1000回繰り返しても再現しない。**3種類を交互に**回して初めて起きる
//     (2026-08-17時点で原因の特定はできていない。「何が3種類目を跨ぐと壊れるか」は未解明)。
//   - 今日(2026-08-17)のミュート機能追加(cf957da)より前のコミット(3eb5adb、
//     ミュート機能追加の親)でビルドしたwasmでも**同じ440回目に同じ場所で**再現した。
//     したがって今日の変更(チャンネルマスク関連)が原因ではない。前から存在するバグ。
//   - -sSAFE_HEAP=1 -sASSERTIONS=2 -sSTACK_SIZE=2097152 を付けたデバッグビルドで
//     同じ手順を回すと、同じ440回目に次のスタックで即死する(シンボル付き):
//       CMucom::GetTextLine → CMucom::strpick_spc (segfault)
//       ← CMucom::GetInfoBufferByName ← CMucom::LoadFMVoiceFromTAG ← CMucom::Play
//     CMucom::GetTextLine()(upstream/MucomWeb/mucom88/src/cmucom.cpp、実測1747行版の
//     993-1032行目)は `linebuf[mptr++] = *p++;` を、行の終端(LF/CR/0)に当たるまで
//     **範囲チェック無し**で書き込み続ける。linebufはCMucomのメンバ配列
//     `unsigned char linebuf[MUCOM_LINE_MAXSTR]`(cmucom.h、MUCOM_LINE_MAXSTR=512)で、
//     526バイト目以降を読む前にLF/CR/0に当たらなければ単純にオーバーフローする。
//     ただし「なぜ3種類を跨ぐと当たらない状態(壊れた/未終端のタグデータ)を踏むのか」
//     は未解明。upstream/MucomWeb/mucom88配下は本プロジェクトのパッチ対象外の
//     ベンダコード(mucomweb/patches/参照)で、ここへの推測での修正は「直したふり」に
//     なりかねないため、このラウンドでは修正を見送る。
//
// 【次に調べるべきこと】
//   - CMucom::Play() -> LoadTagFromMusic() が読むタグデータ(MUBGetTagData経由、
//     .mubファイルのhed.tagdata/tagsize)が、3種類のMMLを跨いだときに本当に
//     ヌル終端されているか(CMemBufの再利用/使い回しでサイズや終端が壊れていないか)を
//     実測する。CMemBufの実装(mucom88/src/module?)を読み、Put/PutStr/GetBuffer/GetSize
//     のバッファ管理(realloc/容量) にオフバイワン等の欠陥が無いか確認する。
//   - 3種の組み合わせのうち何が「3つ目」の役割を果たしているかを、SOURCES配列の
//     内容やMML長・#タグ有無を1つずつ変えて特定する(このファイルのSOURCES/PAIR相当を
//     調整して二分探索する)。
//   - 特定できたら、upstream差分を作るのではなく、本プロジェクト側
//     (mucomweb/src/MucomWeb.cpp)で該当状態を作らないようにする回避を先に検討する
//     (upstreamへの直接パッチは最終手段、mucomweb/patches/の既存パッチと同じ形式で)。
//
// 実行: node tools/verify_mucom_repeat_compile_crash.mjs [N]
// (mucomweb/build-web/mucom88.js が事前にビルド済みであること。README.md参照)
// Nを省略すると500回(=440回目のクラッシュを確実に踏む回数)。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createMucomWeb from '../mucomweb/build-web/mucom88.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SAMPLE_RATE = 55467;

// A. 新規作成ひな形相当(html/mucom-app.js MUCOM_NEW_MML_TEMPLATEと同内容)。
const TEMPLATE_MML = `; template
A @78 T120 o5 l4 v10 cdefgab>c<
`;

// B. ライブラリ収録曲相当(同梱サンプル、tools/sample_fur_elise_mucom.mml)。
const FUR_ELISE = readFileSync(path.join(REPO_ROOT, 'tools/sample_fur_elise_mucom.mml'), 'latin1');

// C. 共有リンク由来の曲相当(Kパート(ADPCM)を含む短い曲)。
const SHARE_LIKE = `A @78 T140 o4 l8 v12 cdefgab>c<defg
K T140 o1 v50 @1c8@1c8@1c8@1c8
`;

const SOURCES = [TEMPLATE_MML, FUR_ELISE, SHARE_LIKE];

async function main() {
  const Module = await createMucomWeb();
  const pcmPath = path.join(REPO_ROOT, 'html/mucompcm.bin');
  try {
    const buf = readFileSync(pcmPath);
    Module.FS.writeFile('/mucompcm.bin', new Uint8Array(buf));
  } catch (e) {
    console.log('pcm bank load failed (continuing without it):', e.message);
  }

  const N = Number(process.argv[2] || 500);
  let lastHeapLen = Module.HEAPU8.length;
  console.log(`initial HEAPU8.length=${lastHeapLen}`);

  let crashedAt = -1;
  for (let i = 0; i < N; i++) {
    const mml = SOURCES[i % SOURCES.length];
    try {
      Module.compileMML(mml, SAMPLE_RATE);
      const channels = Module.getChannelData(); // embind経由の変換も踏む(toWireType)
      void channels;
      const heapLen = Module.HEAPU8.length;
      if (heapLen !== lastHeapLen) {
        console.log(`iter ${i}: HEAPU8 grew ${lastHeapLen} -> ${heapLen}`);
        lastHeapLen = heapLen;
      }
    } catch (e) {
      crashedAt = i;
      console.log(`CRASHED at iter ${i} (mml index ${i % SOURCES.length}): ${e.message}`);
      break;
    }
  }

  if (crashedAt >= 0) {
    console.log(`[FAIL] known pre-existing crash reproduced at iteration ${crashedAt} (final heap=${Module.HEAPU8.length})`);
    console.log('This is a documented, NOT-YET-FIXED upstream bug (see file header comment). Exiting non-zero to keep it visible.');
    process.exit(1);
  }
  console.log(`[PASS-ish] completed ${N} iterations without crash. final heap=${Module.HEAPU8.length}`);
  console.log('NOTE: as of 2026-08-17 this is known to crash around iteration 440 with the default 3-source rotation; if it did not reproduce here, environment/build may differ from what was investigated.');
}

main();
