#!/usr/bin/env node
// net/archive.js (ZIP/LZH展開) の検証スクリプト。
//
// 検証項目:
//   (a) ZIP: 実際に `zip` コマンドで作った書庫(store方式・deflate方式の両方)を
//       extractArchive() で展開し、元ファイルとバイト一致することを確認する。
//       日本語ファイル名(macOSのzipコマンドはUTF-8フラグ付きで格納する)も確認する。
//   (b) LZH: macOSに書庫作成コマンドが無い(brewのlhasaは展開専用)ため、
//       tools/lzh-encoder.mjs という自作の最小LZHエンコーダ(-lh0-/レベル1ヘッダ)で
//       実物の .lzh バイト列を組み立て、それを extractArchive() で展開して
//       元ファイルとバイト一致することを確認する。日本語ファイル名(SJIS)も含める。
//       (このエンコーダはnet/lzh.jsの復号ロジックとは独立に、LHA level-1ヘッダの
//       固定長フィールド仕様どおりに手で組み立てている。)
//   (c) findSongCandidates(): 展開結果から .muc を主ファイルとして検出し、
//       同ディレクトリのvoice.dat/mucompcm.binがrelatedに含まれることを確認する。
//   (d) 故障注入(陽性対照): LZHエントリの圧縮データを1バイト破壊すると
//       CRC16不一致で例外が飛ぶことを確認してから、正常なバイト列に戻して(a)(b)(c)が
//       PASSすることを確認する(CRC検証が実際に効いていることの証明)。
//
// 実行: node tools/verify_net_archive.mjs

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { extractArchive } from '../net/archive.js';
import { findSongCandidates } from '../net/song-select.js';
import { buildLzhLevel1 } from './lzh-encoder.mjs';

let failed = 0;
function check(label, cond) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failed++;
  console.log(`[${mark}] ${label}`);
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// --- テスト用ソースファイルを用意 ------------------------------------------------

const workDir = mkdtempSync(path.join(tmpdir(), 'fmsound-net-archive-'));
const srcDir = path.join(workDir, 'src');
execFileSync('mkdir', ['-p', srcDir]);

const files = {
  'song.muc': '#voice voice.dat\n#pcm mucompcm.bin\nA r4 cdefgab\n',
  'voice.dat': 'DUMMY VOICE DATA'.repeat(4),
  'mucompcm.bin': 'DUMMY PCM DATA\x00\x01\x02\x03'.repeat(4),
  // テ=0x83,0x65 ス=0x83,0x58 ト=0x83,0x67 曲=0x8b,0xc8 (SJIS実測値)
  'テスト曲.muc': '#voice voice.dat\nA r4 cdefgab ; 日本語ファイル名テスト\n',
};

for (const [name, content] of Object.entries(files)) {
  writeFileSync(path.join(srcDir, name), content, 'utf8');
}

console.log(`作業ディレクトリ: ${workDir}`);

// --- (a) ZIP: 実物の zip コマンドで作成 -------------------------------------------

const zipStorePath = path.join(workDir, 'test-store.zip');
const zipDeflatePath = path.join(workDir, 'test-deflate.zip');

execFileSync('zip', ['-0', '-j', zipStorePath, ...Object.keys(files).map((n) => path.join(srcDir, n))]);
execFileSync('zip', ['-9', '-j', zipDeflatePath, ...Object.keys(files).map((n) => path.join(srcDir, n))]);

/**
 * macOSに標準で入っているInfo-ZIP(Apple版)は、日本語ファイル名を「UTF-8バイト列を
 * そのまま格納するがgeneral purposeフラグのbit11(UTF-8であることを示すフラグ)は
 * 立てない」という組み合わせで書き出す(本スクリプトの開発中に実機で確認)。
 * net/zip.js(WebNP2からの移植)はbit11を見てUTF-8かSJISかを切り替える設計のため、
 * このmacOS zipの出力をそのまま渡すと「フラグ無し=SJISとして解釈」してしまい文字化けする。
 * これは移植元のWebNP2 zip.ts側から引き継いだ仕様上の限界であり、本タスクでは直さない
 * (見つけた事実として報告する)。UTF-8パス側の復号ロジック自体が正しいことは検証したいので、
 * ここではLocal/Central両方のヘッダのbit11を後から立てる(=多くの他ツールが実際に
 * 出力する、仕様に忠実なUTF-8フラグ付きZIPを模擬する)。
 * @param {Uint8Array} bytes
 */
function forceZipUtf8Flag(bytes) {
  const out = bytes.slice();
  for (let i = 0; i + 4 <= out.length; i++) {
    const sig = out[i] | (out[i + 1] << 8) | (out[i + 2] << 16) | (out[i + 3] << 24);
    if (sig === 0x04034b50) {
      out[i + 7] |= 0x08; // Local File Header: gpFlag(u16)は offset+6、bit11=0x0800の上位バイトは+7
    } else if (sig === 0x02014b50) {
      out[i + 9] |= 0x08; // Central Directory File Header: gpFlag(u16)は offset+8、上位バイトは+9
    }
  }
  return out;
}

async function verifyArchiveBytes(label, archiveBytes, archiveFileName) {
  const entries = await extractArchive(archiveFileName, archiveBytes);
  check(`${label}: エントリ数が一致 (${entries.length}/${Object.keys(files).length})`, entries.length === Object.keys(files).length);
  for (const [name, content] of Object.entries(files)) {
    const entry = entries.find((e) => e.name === name || e.name.endsWith('/' + name));
    const found = Boolean(entry);
    check(`${label}: エントリ "${name}" が見つかる`, found);
    if (entry) {
      const expected = Buffer.from(content, 'utf8');
      const ok = bytesEqual(entry.data, new Uint8Array(expected));
      check(`${label}: "${name}" がバイト一致`, ok);
    }
  }
  return entries;
}

const zipStoreBytes = forceZipUtf8Flag(new Uint8Array(readFileSync(zipStorePath)));
const zipDeflateBytes = forceZipUtf8Flag(new Uint8Array(readFileSync(zipDeflatePath)));

await verifyArchiveBytes('ZIP(store)', zipStoreBytes, 'test-store.zip');
const zipDeflateEntries = await verifyArchiveBytes('ZIP(deflate)', zipDeflateBytes, 'test-deflate.zip');

// --- (c) findSongCandidates(): ZIP側で確認 -----------------------------------------

{
  const candidates = findSongCandidates(zipDeflateEntries);
  check('findSongCandidates: song.mucが候補に入る', candidates.some((c) => c.displayName === 'song.muc'));
  const songCandidate = candidates.find((c) => c.displayName === 'song.muc');
  if (songCandidate) {
    check('findSongCandidates: driver=mucom', songCandidate.driver === 'mucom');
    const relatedNames = songCandidate.related.map((e) => e.name).sort();
    check(
      'findSongCandidates: relatedにvoice.dat/mucompcm.binを含む',
      relatedNames.includes('voice.dat') && relatedNames.includes('mucompcm.bin'),
    );
  }
  const jaCandidate = candidates.find((c) => c.displayName === 'テスト曲.muc');
  check('findSongCandidates: 日本語ファイル名の曲も候補に入る', Boolean(jaCandidate));
}

// --- (b) LZH: 自作エンコーダで作成 --------------------------------------------------

const lzhEntries = Object.entries(files).map(([name, content]) => ({
  name,
  data: new Uint8Array(Buffer.from(content, 'utf8')),
}));
const lzhBytes = buildLzhLevel1(lzhEntries);
writeFileSync(path.join(workDir, 'test.lzh'), Buffer.from(lzhBytes));

const lzhExtracted = await verifyArchiveBytes('LZH', lzhBytes, 'test.lzh');

{
  const candidates = findSongCandidates(lzhExtracted);
  const songCandidate = candidates.find((c) => c.displayName === 'song.muc');
  check('findSongCandidates(LZH): song.mucのrelatedにvoice.dat/mucompcm.binを含む',
    Boolean(songCandidate) &&
    songCandidate.related.map((e) => e.name).includes('voice.dat') &&
    songCandidate.related.map((e) => e.name).includes('mucompcm.bin'));
}

// --- (d) 故障注入(陽性対照): LZHの圧縮データを1バイト破壊してCRC検証が効くか確認 ------

{
  const corrupted = lzhBytes.slice();
  // song.muc は -lh0-(無圧縮)なので、データ部の先頭バイトを直接壊せばCRC16が変わる。
  // ヘッダを解析して該当エントリのデータ開始位置を突き止める代わりに、
  // 最初のエントリ(song.muc)のデータは既知の構造上ヘッダ直後にあるため、
  // ここでは「全エントリを総当たりで1バイト壊してどれか1つでも例外になるか」を見る
  // のではなく、確実に検出できるよう構築直後のバイト列中でファイル内容の一部
  // ("DUMMY"の先頭'D')を書き換える。
  const marker = Buffer.from('DUMMY VOICE DATA', 'utf8');
  const idx = Buffer.from(corrupted).indexOf(marker);
  check('故障注入: 破壊対象のマーカーバイト列が見つかる', idx >= 0);
  if (idx >= 0) {
    corrupted[idx] = corrupted[idx] ^ 0xff; // 1バイト反転
    let threw = false;
    try {
      await extractArchive('corrupted.lzh', corrupted);
    } catch (err) {
      // net/層はコードだけを持つ設計(net/archive-util.js netError()参照)なので、
      // メッセージ文字列ではなくerr.codeで判定する。
      threw = err && err.code === 'lzh.crcMismatch';
    }
    check('故障注入: 1バイト破壊するとCRC16不一致で例外が飛ぶ(検査が機能している証拠)', threw);
  }
}

// 正常なバイト列でもう一度確認(壊れていない状態でPASSすることの再確認)。
await verifyArchiveBytes('LZH(再確認)', lzhBytes, 'test.lzh');

rmSync(workDir, { recursive: true, force: true });

console.log('---');
if (failed > 0) {
  console.error(`${failed} 件 FAIL`);
  process.exit(1);
} else {
  console.log('全項目 PASS');
}
