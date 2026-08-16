#!/usr/bin/env node
// net/d88.js (d88ディスクイメージ -> N88-BASICファイルシステム -> MMLテキスト) の検証。
//
// テストデータ(サンプルMML集のzip)は著作物(CC BY-NC-ND 4.0、古代祐三氏著作)であり
// リポジトリには絶対にコミットしない。zipの場所は環境変数 MCM_SAMPLE_ZIP で受け取り、
// 未設定ならそのテストは明示的にスキップする(黙って0件PASSにはしない)。
//
// 検証項目:
//   (a) 各 MML_*.d88 から取り出せた曲数・曲名が、zip同梱の LIST_*.txt と一致する(合計46曲)
//       (LIST_Etrian_Odyssey.txt は原資料自体に既知の表記ゆれがある: 5曲中4曲が
//       ディスク上の実ファイル名 "sq1_*"(数字の1)に対し "sql_*"(アルファベットのl)と
//       誤記されている。これは元資料側のタイプミスであり抽出側の不具合ではないため、
//       名前比較では l/1 を同一視して正規化する。適用したことはログに明記する)
//   (b) bare12(MML_BARE_KNUCKLE2内)が途中で切れずに最後まで読めている
//       (過去のPythonツールはBASICプログラムの「次行リンク==0」判定をせずREMマーカーを
//       闇雲に走査していたため、FATの有効セクタ数で丸められたクラスタ末尾のスラック領域
//       (前のファイルの残骸)まで行として拾ってしまい、13行目の音色名の途中で出力が
//       壊れて終わっていた。net/d88.jsのdecodeBasicMmlText()はリンク==0を見て正しく
//       10行で打ち切ることを、行数と最終行の内容で具体的に確認する)
//   (c) 取り出したテキストがMMLとして読める形になっている(先頭のREM行を除く各行が
//       パート文字A〜Kで始まる)
//   (d) システムディスク(MUCOM88_V*.d88)からもVOICE.n等のファイル一覧が取れる
//   (e) 陽性対照: トラックオフセット表を潰す/FATを0埋めする、をそれぞれ与えて
//       検証(readD88Directory/readD88FileBytes)が異常を検出できることを確認する
//       (常にPASSする検査になっていないことの証明。これは必須項目)
//
// 実行: MCM_SAMPLE_ZIP=/path/to/mcm.zip node tools/verify_d88.mjs

import { readFileSync } from 'node:fs';

import { extractArchive } from '../net/archive.js';
import { readTrackOffsets, readD88Directory, readD88Fat, followFatChain, readD88MmlText } from '../net/d88.js';

let failed = 0;
let passed = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passed++;
  else failed++;
  console.log(`[${mark}] ${label}${detail !== undefined ? ' - ' + detail : ''}`);
}

const zipPath = process.env.MCM_SAMPLE_ZIP;
if (!zipPath) {
  console.log('[SKIP] MCM_SAMPLE_ZIP が未設定のため、実データを使う検証を全てスキップします。');
  console.log('       (著作物のためリポジトリに同梱していない。手元のzipパスを環境変数で渡すこと)');
  console.log('---');
  console.log('0 件 PASS / 0 件 FAIL / 全項目スキップ');
  process.exit(0);
}

const zipBytes = new Uint8Array(readFileSync(zipPath));
const zipEntries = await extractArchive(/\.zip$/i.test(zipPath) ? zipPath : `${zipPath}.zip`, zipBytes);
console.log(`zipエントリ数: ${zipEntries.length}`);

/** @param {string} suffix */
function findEntry(suffix) {
  return zipEntries.find((e) => e.name.toLowerCase().endsWith(suffix.toLowerCase()));
}

// --- (a) 各MML_*.d88の曲数・曲名がLIST_*.txtと一致するか ---------------------------

/** LIST_*.txt本文から「番号. タイトル ... 末尾トークン=ファイル名」を1行1曲として抽出する。 @param {string} text */
function parseListNames(text) {
  const names = [];
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!line || !/^\d+\./.test(line)) continue;
    const tokens = line.split(/\s+/).filter(Boolean);
    if (tokens.length < 2) continue;
    names.push(tokens[tokens.length - 1]);
  }
  return names;
}

// LIST_Etrian_Odyssey.txt側の既知の表記ゆれ(l/1混同)を吸収するための正規化。
// ディスク上の実ファイル名側・LIST側の双方に対して対称に適用するので、
// どちらか一方だけを都合よく書き換えて一致させているわけではない。
// N88-BASICディレクトリのファイル名は「名前6バイト+拡張子3バイト」の固定長フィールドで、
// 実際のバイト列には区切り文字(.)は存在しない(readD88Directory()が表示用に補っているだけ)。
// 6文字を超える曲名(例: "sq1_103")は名前フィールドに収まらず拡張子フィールドへあふれるため、
// 本来ドットの無い名前でも "sq1_10.3" のように見えてしまう。これは抽出結果の誤りではなく
// 固定長フィールドの表示上の曖昧さなので、比較時はドットも取り除いて正規化する。
/** @param {string} name */
function normalizeName(name) {
  return name.toLowerCase().replace(/l/g, '1').replace(/\./g, '');
}

const mmlDisks = zipEntries
  .filter((e) => /\/MML_.*\.d88$/i.test(e.name))
  .map((e) => ({ name: e.name, diskLabel: e.name.match(/MML_(.+)\.d88$/i)[1] }));

check('MML_*.d88が見つかる', mmlDisks.length > 0, `${mmlDisks.length}枚`);

let totalSongs = 0;
let totalListSongs = 0;
const bareKnuckle2Text = new Map(); // 後で(b)のbare12検証に使う

for (const disk of mmlDisks) {
  const entry = zipEntries.find((e) => e.name === disk.name);
  const bytes = entry.data;
  const trackOffsets = readTrackOffsets(bytes);
  const dirEntries = readD88Directory(bytes, trackOffsets);
  const diskNames = dirEntries.map((e) => e.fileName);

  const listEntry = findEntry(`LIST_${disk.diskLabel}.txt`);
  check(`${disk.diskLabel}: LIST_${disk.diskLabel}.txt が同梱されている`, Boolean(listEntry));
  if (!listEntry) continue;

  const { decodeMmlBytesAs } = await import('../net/charset.js');
  const listText = decodeMmlBytesAs(listEntry.data, 'shift_jis');
  const listNames = parseListNames(listText);

  totalSongs += diskNames.length;
  totalListSongs += listNames.length;

  check(
    `${disk.diskLabel}: 曲数が一致 (ディスク${diskNames.length} / LIST${listNames.length})`,
    diskNames.length === listNames.length,
  );

  const diskSet = new Set(diskNames.map(normalizeName));
  const listSet = new Set(listNames.map(normalizeName));
  const missing = listNames.filter((n) => !diskSet.has(normalizeName(n)));
  const extra = diskNames.filter((n) => !listSet.has(normalizeName(n)));
  check(
    `${disk.diskLabel}: 曲名が一致(l/1の表記ゆれは正規化して比較)`,
    missing.length === 0 && extra.length === 0,
    missing.length || extra.length ? `missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}` : undefined,
  );

  if (disk.diskLabel === 'BARE_KNUCKLE2') {
    for (const e of dirEntries) {
      bareKnuckle2Text.set(e.fileName, readD88MmlText(bytes, e.fileName));
    }
  }
}

check(`合計曲数が46と一致 (ディスク側)`, totalSongs === 46, `実測=${totalSongs}`);
check(`合計曲数が46と一致 (LIST側)`, totalListSongs === 46, `実測=${totalListSongs}`);

// --- (b) bare12が途中で切れていないか -----------------------------------------------

{
  const text = bareKnuckle2Text.get('bare12');
  check('bare12: MMLテキストが取得できる', Boolean(text));
  if (text) {
    const lines = text.split('\n');
    check('bare12: 行数が10行(REMコメント1行+パート9行)', lines.length === 10, `実測=${lines.length}行`);
    check('bare12: デコード結果に置換文字(\\uFFFD)を含まない(文字境界で正しく打ち切れている証拠)', !text.includes('�'));
    const lastLine = lines[lines.length - 1];
    check(
      'bare12: 最終行(Fパート)が閉じたループ末尾"Lr"で終わっている(途中で切れていない)',
      lastLine.trim().endsWith('Lr'),
      `実測末尾="${lastLine.slice(-20)}"`,
    );
    check('bare12: 最終行がFパートで始まる', /^F\s/.test(lastLine));
  }
}

// --- (c) MMLとして読める形になっているか(先頭行以外はA〜Kで始まる) ------------------

{
  // 曲によっては音色マクロ定義(#・$の数値テーブル行)等も含まれ、全行がパート文字始まりとは
  // 限らないため、「各曲ごとに1行以上はA〜Kのパート行が現れる」ことを確認する
  // (仕様書の「行頭パート文字A〜Kが現れる等」の記述どおり)。
  let allSongsHavePart = true;
  let checkedSongs = 0;
  for (const [fileName, text] of bareKnuckle2Text) {
    const lines = text.split('\n').slice(1); // 先頭行はタイトルREMコメントなので除外
    checkedSongs++;
    const hasPartLine = lines.some((line) => /^[A-K]\s/.test(line));
    if (!hasPartLine) {
      allSongsHavePart = false;
      console.log(`  (詳細) ${fileName}: パート文字(A〜K)で始まる行が1つも無い`);
    }
  }
  check('MML本文: 各曲でパート文字A〜Kで始まる行が現れる', allSongsHavePart, `検査曲数=${checkedSongs}`);
}

// --- (d) システムディスクからVOICE.n等のファイル一覧が取れる -------------------------

{
  const sysDisks = zipEntries.filter((e) => /\/MUCOM88_V.*\.d88$/i.test(e.name));
  check('システムディスク(MUCOM88_V*.d88)が見つかる', sysDisks.length > 0, `${sysDisks.length}枚`);
  if (sysDisks.length > 0) {
    const bytes = sysDisks[0].data;
    const trackOffsets = readTrackOffsets(bytes);
    const dirEntries = readD88Directory(bytes, trackOffsets);
    const names = dirEntries.map((e) => e.fileName);
    const hasVoice = names.some((n) => /^VOICE\.?\s*\d+$/i.test(n));
    check(`${sysDisks[0].name.split('/').pop()}: VOICE.n形式のファイルが一覧に含まれる`, hasVoice, JSON.stringify(names));
  }
}

// --- (e) 陽性対照: 故障注入で検証が異常を検出できるか(必須) -------------------------

{
  const disk = mmlDisks.find((d) => d.diskLabel === 'BARE_KNUCKLE2');
  const entry = zipEntries.find((e) => e.name === disk.name);
  const goodBytes = entry.data;

  // (e-1) トラックオフセット表を潰す: ディレクトリのトラック(index37)のオフセットを0にする。
  // 0.20 + 37*4 = 0x9c
  const corruptedOffsetTable = goodBytes.slice();
  const offsetPos = 0x20 + 37 * 4;
  corruptedOffsetTable[offsetPos] = 0;
  corruptedOffsetTable[offsetPos + 1] = 0;
  corruptedOffsetTable[offsetPos + 2] = 0;
  corruptedOffsetTable[offsetPos + 3] = 0;

  const goodTrackOffsets = readTrackOffsets(goodBytes);
  const goodDirCount = readD88Directory(goodBytes, goodTrackOffsets).length;
  const corruptedTrackOffsets = readTrackOffsets(corruptedOffsetTable);
  const corruptedDirCount = readD88Directory(corruptedOffsetTable, corruptedTrackOffsets).length;
  check(
    '陽性対照(e-1): ディレクトリのトラックオフセットを0で潰すと、正常時と異なる結果(空)になる',
    goodDirCount > 0 && corruptedDirCount === 0,
    `正常時=${goodDirCount}件, 破壊後=${corruptedDirCount}件`,
  );

  // (e-2) FATを0埋めする: FATセクタ(ディレクトリと同じトラックのR=14/15/16全て)の
  // データ本体をデータ長ぶん0で潰し、followFatChainがループ検出で例外を投げることを確認する。
  const corruptedFat = goodBytes.slice();
  {
    let pos = goodTrackOffsets[37];
    const sectorCount = corruptedFat[pos + 4] | (corruptedFat[pos + 5] << 8);
    for (let i = 0; i < sectorCount; i++) {
      const r = corruptedFat[pos + 2];
      const dataLength = corruptedFat[pos + 14] | (corruptedFat[pos + 15] << 8);
      const dataStart = pos + 16;
      if (r === 14 || r === 15 || r === 16) {
        corruptedFat.fill(0, dataStart, dataStart + dataLength);
      }
      pos = dataStart + dataLength;
    }
  }

  let fatReadOk = true;
  try {
    readD88Fat(corruptedFat, goodTrackOffsets);
  } catch {
    fatReadOk = false; // R=14/15/16が全て0埋めで一致するので、ここ自体は例外にならない想定
  }
  check('陽性対照(e-2): FATを0埋めしてもR14/15/16の複製一致チェックは通る(全部同じ0埋めのため)', fatReadOk);

  let chainThrew = false;
  let chainErrorMessage = '';
  try {
    const dirEntries = readD88Directory(corruptedFat, goodTrackOffsets);
    const bare12 = dirEntries.find((e) => e.fileName === 'bare12');
    const fat = readD88Fat(corruptedFat, goodTrackOffsets);
    followFatChain(fat, bare12.startCluster);
  } catch (err) {
    chainThrew = true;
    chainErrorMessage = String(err && err.message);
  }
  check(
    '陽性対照(e-2): FATを0埋めした状態でクラスタチェーンを辿るとループ検出で例外が飛ぶ(検査が機能している証拠)',
    chainThrew && /ループ/.test(chainErrorMessage),
    chainErrorMessage,
  );

  // 破壊していない元バイト列でもう一度確認(壊れていない状態で正常にPASSすることの再確認)。
  const reconfirmedText = readD88MmlText(goodBytes, 'bare12');
  check('陽性対照後の再確認: 正常なバイト列ではbare12が引き続き10行で読める', reconfirmedText.split('\n').length === 10);
}

console.log('---');
console.log(`${passed} 件 PASS / ${failed} 件 FAIL`);
if (failed > 0) {
  process.exit(1);
}
