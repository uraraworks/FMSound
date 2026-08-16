#!/usr/bin/env node
// 実機報告(2026-08-17)の検証: 「ライブラリから読み込み→再生→停止→新規作成→再生」で
// wasmが`memory access out of bounds`で落ちる(mucomweb/src/MucomWeb.cpp
// SetChannelMask()内)。
//
// 【重要・正直な記録】この検証スクリプトは、実機報告の呼び出し順序
// (compileMML → 実際の再生を模したrenderFramesForTest → stopMusic →
// [新規作成はwasm呼び出しを伴わない] → setChannelMask → 2回目のcompileMML、
// これを最大15サイクル繰り返す)をNode(V8)+headless wasmで可能な限り忠実に
// 再現しようと試みたが、**再現できなかった**(クラッシュが一度も起きなかった)。
// html/mucom-app.js側で確認できた「applyChannelMask()がModule.compileMML()の
// 直前=前回のインスタンスに対して呼ばれていた」という呼び出し順序の問題自体は
// 事実であり(MucomWeb.cpp CompileMML()はg_mucomをnullptrへ戻してから
// make_unique<CMucom>()で作り直す設計のため、意味的に見ても「今から作る新しい
// インスタンス」へマスクを適用するのが正しい)、これを修正する動機として十分と
// 判断して直したが、**この検証だけでは「実機で報告された具体的なクラッシュを
// 再現して直した」とは言えない**。Node/V8とSafari/WebKit等の実機のwasm実装の
// 違い(境界チェックの実装差、メモリ増加のタイミング等)、あるいはNode環境では
// 到達できない実際のAudioWorklet駆動(このスクリプトはrenderFramesForTest()による
// 疑似再生に留まる)に起因する差異の可能性がある。
//
// このスクリプトが実際に確認するのは:
//   1. (試みた再現。上記の理由で「再現できなかった」ことをそのまま記録する)
//   2. 修正後の順序(マスク適用をcompileMML成功後に移す)で、この呼び出し
//      パターンを繰り返してもクラッシュしないこと(回帰防止)。
//   3. 「新しいインスタンスへ確実にマスクが効いていること」(順序を変えても
//      ミュート機能自体が壊れていないことの実測。absSumで確認)。
//   4. C++側に追加したg_mucomReady旗により、修正前と同じ順序(コンパイル前に
//      マスクを呼ぶ)で呼んでも例外にならないこと(この旗自体の動作確認。
//      ただしNode環境では元の順序でもそもそも再現できなかった、という
//      上記の限界はそのまま)。
//
// 実行: node tools/verify_mucom_channel_mask_order.mjs
// (mucomweb/build-web/mucom88.js が事前にビルド済みであること)

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createMucomWeb from '../mucomweb/build-web/mucom88.js';
import { buildMucomChannelMask, ADPCM_CHANNEL, FM_CHANNELS } from '../fmdsp/channel-mask.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PCM_BANK_PATH = path.join(REPO_ROOT, 'html/mucompcm.bin');
const SAMPLE_RATE = 55467;
const MML = 'A @78 T120 o4 v100 l4 cdefgab>c<\nK T120 o1 v50 @1c8@1c8@1c8@1c8\n';

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passed++; else failed++;
  console.log(`[${mark}] ${label}${detail !== undefined ? ' - ' + detail : ''}`);
}

async function loadModule() {
  const Module = await createMucomWeb();
  const bankBytes = readFileSync(PCM_BANK_PATH);
  Module.FS.writeFile('/mucompcm.bin', new Uint8Array(bankBytes));
  return Module;
}

/**
 * 実機報告の呼び出し順序を1サイクルぶん再現する。
 * maskBeforeCompile: true なら「修正前」の順序(マスク→コンパイル)、
 * false なら「修正後」の順序(コンパイル→マスク)。
 */
function runCycle(Module, maskBeforeCompile) {
  if (maskBeforeCompile) {
    Module.setChannelMask(buildMucomChannelMask(new Set()));
    Module.compileMML(MML, SAMPLE_RATE);
  } else {
    Module.compileMML(MML, SAMPLE_RATE);
    Module.setChannelMask(buildMucomChannelMask(new Set()));
  }
  for (let i = 0; i < 30; i++) Module.renderFramesForTest(2048); // 実際の再生を模す
  Module.stopMusic();
  // 「新規作成」相当(実機報告どおり、wasm呼び出しを一切伴わない)。
}

async function tryRepeatedCycles(Module, maskBeforeCompile, cycles) {
  for (let i = 0; i < cycles; i++) {
    try {
      runCycle(Module, maskBeforeCompile);
    } catch (err) {
      return { crashed: true, atCycle: i, message: err.message };
    }
  }
  return { crashed: false };
}

async function main() {
  console.log('=== tools/verify_mucom_channel_mask_order.mjs: チャンネルマスク適用順序の検証 ===\n');

  // --- 1. 再現の試み(修正前の順序、独立したModuleインスタンスで15サイクル) ---
  {
    const Module = await loadModule();
    const result = await tryRepeatedCycles(Module, /* maskBeforeCompile */ true, 15);
    if (result.crashed) {
      console.log(`[INFO] 1. 修正前の順序(マスク→コンパイル)でクラッシュを再現できた(cycle=${result.atCycle}): ${result.message}`);
    } else {
      console.log('[INFO] 1. 修正前の順序(マスク→コンパイル)を15サイクル試したが、Node/V8では再現できなかった(ファイル冒頭コメント参照。正直な記録として残す)。');
    }
  }

  // --- 2. 修正後の順序(コンパイル→マスク)で同じ呼び出しパターンを繰り返してもクラッシュしないこと(回帰防止) ---
  {
    const Module = await loadModule();
    const result = await tryRepeatedCycles(Module, /* maskBeforeCompile */ false, 15);
    check('2. 修正後の順序(コンパイル→マスク)を15サイクル繰り返してもクラッシュしない(回帰防止)',
      !result.crashed, result.crashed ? `cycle=${result.atCycle}: ${result.message}` : undefined);
  }

  // --- 3. 順序を変えてもミュート機能自体が壊れていないこと(absSum実測) ---
  {
    const Module = await loadModule();
    Module.compileMML(MML, SAMPLE_RATE);
    Module.setChannelMask(buildMucomChannelMask(new Set())); // 修正後の順序: コンパイル→マスク
    let absSumNone = 0;
    for (let i = 0; i < 200; i++) absSumNone += Module.renderFramesForTest(2048);

    const Module2 = await loadModule();
    Module2.compileMML(MML, SAMPLE_RATE);
    Module2.setChannelMask(buildMucomChannelMask(new Set([ADPCM_CHANNEL]))); // Kだけミュート
    let absSumAdpcmMuted = 0;
    for (let i = 0; i < 200; i++) absSumAdpcmMuted += Module2.renderFramesForTest(2048);

    check('3. 順序変更後もミュートが効く(ADPCMミュートでabsSumが明確に減る)',
      absSumAdpcmMuted < absSumNone * 0.9,
      `none=${absSumNone} adpcmMuted=${absSumAdpcmMuted} (ratio=${(absSumAdpcmMuted / absSumNone).toFixed(4)})`);
  }

  // --- 4. g_mucomReady旗そのものの動作確認: 一度もcompileMMLを呼んでいない
  //    フレッシュなModuleに対してsetChannelMask()を呼んでも例外にならないこと
  //    (元々の g_mucom==nullptr チェックと合わせて、二重の保険になっていることの確認)。
  {
    const Module = await loadModule();
    let threw = false;
    try {
      Module.setChannelMask(buildMucomChannelMask(new Set([...FM_CHANNELS])));
    } catch (err) {
      threw = true;
      console.log(`    例外: ${err.message}`);
    }
    check('4. コンパイル前のsetChannelMask()は例外にならない(g_mucomReady旗+既存のnullチェック)', !threw);
  }

  console.log(`\n合計: ${passed} PASS / ${failed} FAIL`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
