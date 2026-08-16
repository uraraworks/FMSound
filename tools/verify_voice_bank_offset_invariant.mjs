#!/usr/bin/env node
// net/voice-bank.js detectBankOffset() / findPairedVoiceBank() が守るべき不変条件を
// 実データで検証する(コーディネーター指摘、2026-08-16、tools/verify_voice_bank_offset_*
// として恒久的なテストに残す)。
//
// 不変条件(必須): 既定バンクと完全一致する voice.dat を持つディスク
// (MUCOM88_V1.7_BOSCONIAN.d88 / MUCOM88_V1.7_BARE_KNUCKLE2.d88、実測でオフセット4基準
// 256スロット全て既定バンクと完全一致することを確認済み)の曲は、`#voice` を使っても
// 使わなくても、レンダリング結果(absSum)が完全に一致しなければならない。
//
// これは「voice.dat本体の開始位置が4byteずれていた」不具合(修正前は
// `entry.data.subarray(0, 8192)` のように先頭0byte目から決め打って読んでいたため、
// 全スロットが4byteずれて読まれ、既定バンクと完全一致するはずのディスクでも
// 別物の音色バンクとして扱われていた)を捕まえられる唯一の不変条件。
// この検証が無いと、次にオフセット検出やバンク切り出しに触ったとき、
// 同種の不具合が再発しても誰も気づけない(実際に一度そうなった)。
//
// 陽性対照(必須): わざとオフセットを0(=修正前の壊れた決め打ち)にしたバンクを
// 渡すと、上の不変条件が成立しなくなる(絶対値和が変わる)ことを確認する。
// これが無いと「常に一致する(=何も測っていない)」検査になっていないかを
// 判定できない(ui/mucom-voice-resolve.jsの検証群と同じ考え方)。
//
// 実データ(サンプルMML集)は著作物のためリポジトリに同梱していない。
// 環境変数 MCM_SAMPLE_ZIP でzipパスを渡す(未設定ならSKIP、tools/verify_mucom_voice_name.mjs
// のF検証と同じ作法)。
//
// 出力の判定にgrep(シェルコマンド)は使わない。コンパイルメッセージはCP932で、
// grepは2バイト文字の1バイトをNEL改行と誤認して行を取りこぼす事故が過去にあるため、
// 常にバイト列(Buffer)としてASCII部分文字列を検査する。
//
// 実行: MCM_SAMPLE_ZIP=/path/to/MCM_sample_20190124.zip node tools/verify_voice_bank_offset_invariant.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SAMPLE_RATE = 55467;

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

/** @param {Uint8Array} bytes @param {string} asciiSubstring バイト列としてのASCII部分一致検査(grep不使用の方針、他のverify_*.mjsと同じ) */
function bytesInclude(bytes, asciiSubstring) {
  const needle = Buffer.from(asciiSubstring, 'ascii');
  return Buffer.from(bytes).includes(needle);
}

async function main() {
  const zipPath = process.env.MCM_SAMPLE_ZIP;
  if (!zipPath) {
    console.log('[SKIP] MCM_SAMPLE_ZIP が未設定のため、実データを使うこの検証は全てスキップします。');
    console.log('       (サンプルMML集は著作物のためリポジトリに同梱していない。手元のzipパスを環境変数で渡すこと)');
    console.log('\n0 PASS, 0 FAIL (SKIPPED)');
    process.exit(0);
  }

  const { extractArchive } = await import(path.join(REPO_ROOT, 'net/archive.js'));
  const { findSongCandidates } = await import(path.join(REPO_ROOT, 'net/song-select.js'));
  const { findPairedVoiceBank, VOICE_BANK_SIZE } = await import(path.join(REPO_ROOT, 'net/voice-bank.js'));
  const { resolveMucomVoiceNameRefs } = await import(path.join(REPO_ROOT, 'ui/mucom-voice-resolve.js'));
  const { decodeMmlBytes } = await import(path.join(REPO_ROOT, 'net/charset.js'));
  const { MUCOM_DEFAULT_VOICE_NAMES } = await import(path.join(REPO_ROOT, 'ui/mucom-voice-table.js'));
  const createMucomWeb = (await import(path.join(REPO_ROOT, 'mucomweb/build-web/mucom88.js'))).default;

  const EXPLICIT_VOICE_TAG_RE = /^[ \t]*#voice\b/im;
  const VOICE_BANK_MEMFS_PATH = '/voicebank_ext.dat';

  async function compileWithTimeout(Module, source, label, timeoutMs = 15000) {
    return await Promise.race([
      (async () => {
        Module.compileMML(source, SAMPLE_RATE);
        const msgPtr = Module.getCompileMessagePointer();
        const msgLen = Module.getCompileMessageLength();
        return Module.HEAPU8.slice(msgPtr, msgPtr + msgLen);
      })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT(${label})`)), timeoutMs)),
    ]);
  }

  function absSumOf(Module) {
    let absSum = 0;
    for (let i = 0; i < 50; i++) absSum += Module.renderFramesForTest(2048);
    return absSum;
  }

  /**
   * html/mucom-app.js compileAndPlay() と同じ手順を移植する。
   * bankBytesOverride が渡された場合は、findPairedVoiceBank() が返す(正しくオフセット
   * 補正済みの)バイト列の代わりにそれを使う(陽性対照で「わざと壊れたオフセットの
   * バンク」を注入するため)。
   * @returns {{ ok: boolean, absSum: number|null, msgBytes: Uint8Array }}
   */
  async function compileWithBank(Module, mmlText, bankBytesOrNull) {
    const voiceBankApplied = Boolean(bankBytesOrNull) && !EXPLICIT_VOICE_TAG_RE.test(mmlText);
    const { text: mmlNameResolved } = resolveMucomVoiceNameRefs(mmlText, voiceBankApplied ? bankBytesOrNull : undefined);
    let mmlForCompile = mmlNameResolved;
    if (voiceBankApplied) {
      Module.FS.writeFile(VOICE_BANK_MEMFS_PATH, bankBytesOrNull);
      mmlForCompile = `#voice ${VOICE_BANK_MEMFS_PATH}\n${mmlNameResolved}`;
    }
    const msgBytes = await compileWithTimeout(Module, mmlForCompile, 'compile');
    const ok = !bytesInclude(msgBytes, '#error') && !bytesInclude(msgBytes, 'not found');
    return { ok, absSum: ok ? absSumOf(Module) : null, msgBytes };
  }

  const zipBytes = new Uint8Array(readFileSync(zipPath));
  const entries = await extractArchive(/\.zip$/i.test(zipPath) ? path.basename(zipPath) : `${path.basename(zipPath)}.zip`, zipBytes);
  const candidates = findSongCandidates(entries).filter((c) => c.driver === 'mucom' && /\/MML_.*\.d88\//i.test(c.entry.name));
  check('実データからMUCOM88候補46曲を検出', candidates.length === 46, `実際=${candidates.length}`);

  // --- 本題: 既定バンクと完全一致するディスク(V1.7 BOSCONIAN / V1.7 BARE_KNUCKLE2)の
  //     曲は #voice あり/なしでabsSumが完全一致しなければならない ---
  const IDENTICAL_TO_DEFAULT_DISKS = ['MUCOM88_V1.7_BOSCONIAN.d88', 'MUCOM88_V1.7_BARE_KNUCKLE2.d88'];
  const identicalDiskCandidates = candidates.filter((c) => {
    const pair = findPairedVoiceBank(entries, c.entry.name, MUCOM_DEFAULT_VOICE_NAMES);
    return pair && IDENTICAL_TO_DEFAULT_DISKS.includes(pair.sysDiskName);
  });
  check('既定バンクと完全一致するディスク(V1.7 2枚)の曲が実データから見つかる', identicalDiskCandidates.length > 0,
    `件数=${identicalDiskCandidates.length}`);

  let identicalMatchedCount = 0;
  let identicalCompileFailCount = 0;
  const identicalResults = [];
  for (const c of identicalDiskCandidates) {
    const { text: mmlText } = decodeMmlBytes(c.entry.data);
    const pair = findPairedVoiceBank(entries, c.entry.name, MUCOM_DEFAULT_VOICE_NAMES);
    // beforeとafterは別々のフレッシュなModuleインスタンスで計測する(同一インスタンスの
    // 使い回しは内部状態がわずかにドリフトし、"完全一致"の判定を汚染するため。
    // tools/experiment_voice_bank.mjs以来の作法)。
    const withoutVoice = await compileWithBank(await createMucomWeb(), mmlText, null);
    const withVoice = await compileWithBank(await createMucomWeb(), mmlText, pair.bytes);
    if (!withoutVoice.ok || !withVoice.ok) {
      identicalCompileFailCount++;
      continue;
    }
    const matched = withoutVoice.absSum === withVoice.absSum;
    if (matched) identicalMatchedCount++;
    identicalResults.push({ name: c.entry.name, disk: pair.sysDiskName, without: withoutVoice.absSum, with: withVoice.absSum, matched });
  }
  console.log('\n--- 既定バンクと完全一致するディスクの曲: #voiceなし/ありのabsSum実測 ---');
  for (const r of identicalResults) {
    console.log(`  ${r.name}(${r.disk}): なし=${r.without} あり=${r.with} ${r.matched ? '(一致)' : '(不一致!)'}`);
  }
  check('コンパイル失敗が無い(既定バンク完全一致ディスクの曲)', identicalCompileFailCount === 0,
    `失敗=${identicalCompileFailCount}/${identicalDiskCandidates.length}`);
  check('【本題】既定バンクと完全一致するディスクの曲は #voice あり/なしでabsSumが完全一致する',
    identicalDiskCandidates.length > 0 && identicalMatchedCount === identicalDiskCandidates.length - identicalCompileFailCount,
    `一致=${identicalMatchedCount}/${identicalDiskCandidates.length - identicalCompileFailCount}`);

  // --- 陽性対照(必須): わざとオフセット0(=修正前の壊れた決め打ち)のバンクを使うと、
  //     上の不変条件が成立しなくなる(=このテストが「常に一致する」だけの無意味な
  //     検査になっていないことの証拠) ---
  let controlDetectedCount = 0;
  const controlResults = [];
  // 代表数曲を選ぶ(全件はやらない。時間短縮、原理の確認が目的)。`@"名前"`参照を
  // 含む曲(bare03等)は壊れたバンクだとコンパイル自体が失敗し、含まない曲
  // (bos011等、`@数値`のみ)は壊れたバンクでもコンパイルは通ってabsSumが変わる、
  // という2つの壊れ方の両方をこの陽性対照で見ておく(片方だけだと「たまたま
  // コンパイル失敗という形でしか検出できない検査」になっていないか確認できないため)。
  const controlTargetNames = ['bare03.muc', 'bos011.muc'];
  const controlCandidates = controlTargetNames
    .map((n) => identicalDiskCandidates.find((c) => c.entry.name.endsWith(n)))
    .filter(Boolean);
  for (const c of controlCandidates) {
    const { text: mmlText } = decodeMmlBytes(c.entry.data);
    const pair = findPairedVoiceBank(entries, c.entry.name, MUCOM_DEFAULT_VOICE_NAMES);
    // findPairedVoiceBank()を経由せず、同じsystem disk voice.datエントリの生バイト列
    // (pair.entry.data)から、修正前の不具合と同じ「オフセット0決め打ち」で256スロットを
    // 切り出す(=わざと壊す)。
    const brokenBank = pair.entry.data.subarray(0, VOICE_BANK_SIZE);
    const withoutVoice = await compileWithBank(await createMucomWeb(), mmlText, null);
    // baseline(バンク無し)は必ず成功するはず(本題の検査で同じ曲が既に成功している)。
    // ここが失敗するのはこの陽性対照コード自体の不具合であり、警告で済ませず気付けるようにする。
    if (!withoutVoice.ok) {
      controlResults.push({ name: c.entry.name, without: null, broken: null, detected: false, note: 'baseline compile failed(想定外)' });
      continue;
    }
    const withBrokenVoice = await compileWithBank(await createMucomWeb(), mmlText, brokenBank);
    // 「オフセット0の壊れたバンクを使うと結果が既定と一致しなくなる」ことを検出できていれば
    // 陽性対照は成立する。壊れたバンクの参照する名前が壊れたテーブルでは解決できず
    // コンパイル自体が失敗する場合も、「一致しない」ことの検出として数える(実測: bare03等では
    // このパターンで#error/FM Voice not foundになった。absSumが出るケースと出ないケースの
    // 両方をこの1つの判定でまとめて扱う)。
    const detected = !withBrokenVoice.ok || withoutVoice.absSum !== withBrokenVoice.absSum;
    if (detected) controlDetectedCount++;
    controlResults.push({
      name: c.entry.name,
      without: withoutVoice.absSum,
      broken: withBrokenVoice.ok ? withBrokenVoice.absSum : '(コンパイル失敗)',
      detected,
    });
  }
  console.log('\n--- 陽性対照: わざとオフセット0(修正前の不具合)で切り出したバンクを使った場合 ---');
  for (const r of controlResults) {
    console.log(`  ${r.name}: なし=${r.without} 壊れたオフセットで#voiceあり=${r.broken} ` +
      `${r.detected ? '(不一致を検出=このテストは機能している)' : '(差が出ない!)'}${r.note ? ' ' + r.note : ''}`);
  }
  check('陽性対照: オフセット0(修正前の不具合)を再現すると、既定バンク完全一致ディスクでも結果が一致しなくなる' +
    '(絶対値和が変わる、またはコンパイル自体が失敗する。=この検査が不具合を検出できることの証拠。「常に一致」ではない)',
    controlResults.length > 0 && controlDetectedCount === controlResults.length,
    `検出=${controlDetectedCount}/${controlResults.length}`);

  // --- 差があるべきディスク(V1.5_THE_SCHEME、既定バンクと140スロット差)でも1件見ておく。
  //     「変わったから正しい」とはしない(checkにはせず、参考情報として出すだけ)。 ---
  const schemeSong = candidates.find((c) => {
    const pair = findPairedVoiceBank(entries, c.entry.name, MUCOM_DEFAULT_VOICE_NAMES);
    return pair && pair.sysDiskName === 'MUCOM88_V1.5_THE_SCHEME.d88';
  });
  if (schemeSong) {
    const { text: mmlText } = decodeMmlBytes(schemeSong.entry.data);
    const pair = findPairedVoiceBank(entries, schemeSong.entry.name, MUCOM_DEFAULT_VOICE_NAMES);
    const withoutVoice = await compileWithBank(await createMucomWeb(), mmlText, null);
    const withVoice = await compileWithBank(await createMucomWeb(), mmlText, pair.bytes);
    console.log(`\n--- 参考(補助、正しさの判定基準にはしない): 差があるべきディスク(${pair.sysDiskName}) ---`);
    console.log(`  ${schemeSong.entry.name}: なし=${withoutVoice.absSum} あり=${withVoice.absSum} ` +
      `(${withoutVoice.ok && withVoice.ok && withoutVoice.absSum !== withVoice.absSum ? '変化した' : '変化なし/コンパイル失敗'})`);
  } else {
    console.log('\n--- 参考: V1.5_THE_SCHEMEの曲が実データから見つからなかった ---');
  }

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
