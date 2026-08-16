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
//   (f) ファイル名復元: "VOICE.1"(空白トリム後ドット連結)・"sq1_103"(名前の続きとして
//       ドット無し連結)が正しい形で出る
//   (g) net/archive.js への配線: zipを1つ渡すとd88の入れ子展開が効いて46曲並ぶこと、
//       d88のマジック(構造)判定が効くこと、zip/lzhをd88と誤判定しないこと
//   (h) 曲の選り分け: システムディスクのドライバ/DOSファイル(VOICE.n、muc88等)が
//       曲一覧に入らないこと。陽性対照として、実際にVOICE.nのバイナリを故意に
//       decodeBasicMmlText相当のゆるい判定に通すとMMLと誤判定されていた実測の
//       回帰(修正前バグの再現)も残す
//
// 実行: MCM_SAMPLE_ZIP=/path/to/mcm.zip node tools/verify_d88.mjs

import { readFileSync } from 'node:fs';

import { extractArchive, isArchive, sniffArchiveExtension } from '../net/archive.js';
import { extractZip } from '../net/zip.js';
import { findSongCandidates } from '../net/song-select.js';
import {
  readTrackOffsets,
  readD88Directory,
  readD88Fat,
  followFatChain,
  readD88MmlText,
  looksLikeD88,
  looksLikeMucomMmlText,
} from '../net/d88.js';

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
// (a)〜(f)はd88ファイル単体の中身を直接扱う検証なので、展開は1段だけ(zip直下のd88を
// エントリとしてそのまま持つ)のextractZip()を使う。入れ子展開込みのextractArchive()の
// 結果は(g)以降の「archive.jsへの配線」自体を検証するために別途使う(下記nestedEntries)。
const zipEntries = await extractZip(zipBytes);
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
// ドットの正規化は不要(readD88Directory()が名前フィールドの空白有無を見て
// 正しくドット有り/無しを復元するようになったため。tools/verify_d88.mjsの
// 「ファイル名復元」検査参照)。
/** @param {string} name */
function normalizeName(name) {
  return name.toLowerCase().replace(/l/g, '1');
}

const mmlDisks = zipEntries
  .filter((e) => /\/MML_.*\.d88$/i.test(e.name))
  .map((e) => ({ name: e.name, diskLabel: e.name.match(/MML_(.+)\.d88$/i)[1] }));

check('MML_*.d88が見つかる', mmlDisks.length > 0, `${mmlDisks.length}枚`);

// --- ファイル名復元: 固定長フィールドの空白トリム/ドット連結規則 ---------------------
// VOICE.1 … 名前フィールドに空白の余りがあるので拡張子は本来の拡張子(ドットで連結)。
// sq1_103 … 名前フィールド6バイトを空白無しで使い切っているので拡張子は名前の続き
//           (実データにドットは無い。ドット無しで連結)。
{
  const sysEntry = zipEntries.find((e) => /MUCOM88_V1\.5_ACTRAISER\.d88$/i.test(e.name));
  check('ファイル名復元: システムディスクが見つかる(ACTRAISER)', Boolean(sysEntry));
  if (sysEntry) {
    const names = readD88Directory(sysEntry.data, readTrackOffsets(sysEntry.data)).map((e) => e.fileName);
    check('ファイル名復元: "VOICE.1" が正しい形で出る(空白トリム後ドット連結)', names.includes('VOICE.1'), JSON.stringify(names.filter((n) => n.toLowerCase().startsWith('voice'))));
  }
  const etrianEntry = zipEntries.find((e) => /MML_Etrian_Odyssey\.d88$/i.test(e.name));
  check('ファイル名復元: Etrian Odysseyディスクが見つかる', Boolean(etrianEntry));
  if (etrianEntry) {
    const names = readD88Directory(etrianEntry.data, readTrackOffsets(etrianEntry.data)).map((e) => e.fileName);
    check('ファイル名復元: "sq1_103" が正しい形で出る(ドット無しで名前の続きとして連結)', names.includes('sq1_103'), JSON.stringify(names));
  }
}

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

// --- (g) net/archive.js への配線: isArchive/sniffArchiveExtension/extractArchive ----

check('isArchive: .d88 を書庫として認識する', isArchive('foo.d88') && isArchive('FOO.D88'));

// extractArchive(zipPath, zipBytes) は入れ子展開込み(zip -> d88 -> 曲)の結果を返す。
// (a)〜(f)で使ったzipEntries(extractZipのみ、d88は未展開)とは別に、ここでは
// archive.js自体の配線(isArchive/sniffArchiveExtension/extractArchiveの入れ子展開)を
// 検証するため、extractArchive()経由の結果をnestedEntriesとして取得する。
const nestedEntries = await extractArchive(/\.zip$/i.test(zipPath) ? zipPath : `${zipPath}.zip`, zipBytes);
console.log(`入れ子展開後のエントリ数: ${nestedEntries.length}`);

{
  const nestedNames = nestedEntries.filter((e) => /\.d88\//i.test(e.name));
  check(
    '入れ子展開: エントリ名がd88のパスを含む形になっている(例 MML_BOSCONIAN.d88/xxxx)',
    nestedNames.length > 0,
    nestedNames[0] && nestedNames[0].name,
  );
  // 入れ子展開後の一覧には、もはや展開前のd88そのもの(拡張子.d88のエントリ)は残らない
  // (2段までの入れ子上限内で全て展開し尽くされているはず)。
  const rawD88Left = nestedEntries.filter((e) => /\.d88$/i.test(e.name));
  check('入れ子展開: 展開済みのd88自体は一覧に残らない(2段の入れ子で辿りきれている)', rawD88Left.length === 0, JSON.stringify(rawD88Left.map((e) => e.name)));

  // zipを1つ渡したら46曲(MMLディスク側の曲)が並ぶこと。システムディスク同梱のsampl1〜3も
  // 内容的に正しいMMLなので曲として並ぶ(46 + システムディスク3枚分のsampl1〜3=9 で55件)。
  const nestedSongs = findSongCandidates(nestedEntries);
  const mmlDiskSongs = nestedSongs.filter((s) => /\/MML_.*\.d88\//i.test(s.entry.name));
  check('zipから46曲(MML_*.d88由来)が並ぶ', mmlDiskSongs.length === 46, `実測=${mmlDiskSongs.length}`);
}

{
  // d88のマジック(構造)判定: zip全体の生バイト列そのものから直接d88を切り出して確認する。
  const rawEntries = await extractZip(zipBytes);
  const bosconianD88 = rawEntries.find((e) => /MML_BOSCONIAN\.d88$/i.test(e.name));
  check('マジック判定: サンプルd88が見つかる(BOSCONIAN)', Boolean(bosconianD88));
  if (bosconianD88) {
    check('マジック判定: 生のd88バイト列を.d88と判定する', sniffArchiveExtension(bosconianD88.data) === '.d88');
    check('マジック判定(直接): looksLikeD88()が生のd88バイト列に対しtrueを返す', looksLikeD88(bosconianD88.data));

    // 陽性対照: ディスクサイズフィールド(0x1C)を書き換えると、実ファイル長と食い違うので
    // d88と判定されなくなることを確認する(常にtrueを返すだけの判定になっていないことの証明)。
    const corrupted = bosconianD88.data.slice();
    corrupted[0x1c] ^= 0xff;
    check(
      '陽性対照: ディスクサイズフィールドを壊すとd88と判定されなくなる',
      sniffArchiveExtension(corrupted) === null && !looksLikeD88(corrupted),
    );
  }

  // ZIP/LZH自体をd88と誤判定しないこと。
  check('マジック判定: zip全体のバイト列は.zipと判定される(d88と誤判定しない)', sniffArchiveExtension(zipBytes) === '.zip');
  const listEntry = rawEntries.find((e) => /LIST_BOSCONIAN\.txt$/i.test(e.name));
  check(
    'マジック判定: LIST_*.txt(アーカイブでも d88 でもない生テキスト)は何にも判定されない',
    Boolean(listEntry) && sniffArchiveExtension(listEntry.data) === null,
  );
}

// --- (h) 曲の選り分け: システムディスクのドライバ/DOSファイルが曲一覧に入らない ------

{
  const KNOWN_NON_SONG_NAMES = [
    'DATA', 'dbyte', 'errmsg', 'expand', 'gef1', 'kbd', 'mlf88', 'msub', 'muc88',
    'music', 'music2', 'pcmldr', 'setup', 'smon', 'ssgdat', 'swfile', 'time', 'voice.dat',
  ];

  const songs = findSongCandidates(nestedEntries);
  check('曲の選り分け: findSongCandidatesが何らかの曲を返す', songs.length > 0, `${songs.length}件`);

  const songBaseNames = songs.map((s) => s.entry.name.split('/').pop());
  const leakedDriverFiles = songBaseNames.filter((n) =>
    KNOWN_NON_SONG_NAMES.some((bad) => n.toLowerCase() === `${bad.toLowerCase()}.muc` || n.toLowerCase() === bad.toLowerCase()),
  );
  const leakedVoiceFiles = songBaseNames.filter((n) => /^voice\.?\s*\d+/i.test(n));
  check(
    '曲の選り分け: ドライバ/DOSファイル(DATA・dbyte・muc88等)が曲一覧に入っていない',
    leakedDriverFiles.length === 0,
    JSON.stringify(leakedDriverFiles),
  );
  check(
    '曲の選り分け: VOICE.n(音色バンク)が曲一覧に入っていない',
    leakedVoiceFiles.length === 0,
    JSON.stringify(leakedVoiceFiles),
  );

  // 判定から漏れたファイルも捨てずに取得できる状態か(nestedEntries自体には残っているはず)。
  const sysDisk = nestedEntries.find((e) => /MUCOM88_V1\.5_ACTRAISER\.d88\/VOICE\.1$/i.test(e.name));
  check('曲の選り分け: 曲でないVOICE.1も生バイト列としてはentriesに残っている(捨てていない)', Boolean(sysDisk) && sysDisk.data.length > 0);

  // 陽性対照: VOICE.nのバイナリ本体を、修正前と同じ「REM行以外もそのまま読み進める」
  // ゆるいデコード(decodeBasicMmlTextの挙動)に通すと、実データで実際にMMLと誤判定されて
  // いたことを再現する。これはtryDecodeTokenizedBasicMmlText()で弾かれているはずで、
  // ここではその弾かれ方が「常にfalseを返すだけの検査」になっていないこと
  // (=本物のMML(bare12)には正しくtrueを返すこと)もあわせて確認する。
  // VOICE.21(実測でゆるいデコードだと偶然MMLらしく見えてしまっていたファイル)を対象にする。
  const actraiserSys = nestedEntries.find((e) => /MUCOM88_V1\.5_ACTRAISER\.d88\/VOICE\.21$/i.test(e.name));
  check('陽性対照(h): システムディスクにVOICE.21の生データが見つかる(検査対象がある)', Boolean(actraiserSys));
  if (actraiserSys) {
    // 修正前と同じ「REM行以外も無条件でテキスト化してしまう」ゆるいデコードを直接再現する。
    function lenientDecodeForRegressionCheck(bytes) {
      const lines = [];
      let pos = 0;
      while (pos + 4 <= bytes.length) {
        const link = bytes[pos] | (bytes[pos + 1] << 8);
        if (link === 0) break;
        const bodyStart = pos + 4;
        let zero = -1;
        for (let i = bodyStart; i < bytes.length; i++) {
          if (bytes[i] === 0) { zero = i; break; }
        }
        if (zero === -1) break;
        const body = bytes.subarray(bodyStart, zero);
        lines.push(Buffer.from(body).toString('latin1')); // マーカー有無を見ずそのまま採用
        pos = zero + 1;
      }
      return lines.join('\n');
    }
    const lenientText = lenientDecodeForRegressionCheck(actraiserSys.data);
    const lenientLooksLikeMml = looksLikeMucomMmlText(lenientText);
    check(
      '陽性対照(h): ゆるいデコード(修正前相当)ではVOICE.1のバイナリがMMLと誤判定されていた(回帰の再現)',
      lenientLooksLikeMml,
    );
  }
  const bareKnuckle2 = nestedEntries.find((e) => /MML_BARE_KNUCKLE2\.d88\/bare12\.muc$/i.test(e.name));
  check(
    '陽性対照(h)再確認: 本物のMML(bare12)は曲一覧に正しく入っている(検査が常にfalseを返すだけになっていない証拠)',
    Boolean(bareKnuckle2),
  );
}

console.log('---');
console.log(`${passed} 件 PASS / ${failed} 件 FAIL`);
if (failed > 0) {
  process.exit(1);
}
