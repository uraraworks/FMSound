#!/usr/bin/env node
// PMD MML → `.M` コンパイラの差分オラクル(step 0)。
//
// 目的: 自作コンパイラ(compiler/pmd_mml_compiler.mjs)が吐いた`.M`と、本家PMD98で
// コンパイルされた`.M`(以下「参照ファイル」)を突き合わせ、どこがどう違うかを
// 人間が追える形で出力する。MML構文の実装(compiler/配下の変更)は対象外で、
// 今後の実装作業に使う「現在地の測定器」がこのツールの役割。
//
// フォーマットの根拠はdocs/pmd-compiler-spec.md 1章(必ず先に読むこと)。
//
// 使い方:
//   node tools/compare_pmd_m.mjs --mml <MMLファイルのパス> --ref <参照.Mファイルのパス>
//
// 第三者データを扱う際の注意(重要):
//   - 参照`.M`ファイルは第三者の著作物(実在する楽曲データ)であることが多い。
//     このツール自体はリポジトリに含めてよいが、**参照ファイル自体・MMLファイル自体は
//     リポジトリにコピーしない・コミットしないこと**。パスは常に引数(--mml/--ref)か
//     環境変数で渡し、手元の任意の場所(Downloads配下等)を指すこと。
//   - 「証拠(このツールの出力ログ)」「派生物(比較結果の数値・エラー集計)」
//     「私物(参照ファイルそのもの)」を分けて扱う。報告に含めてよいのは前者2つのみ。
//     (考え方はdocs併記の「エージェント作業の成果物パス設計」の整理に合わせている)
//
// 制約: このツールはバイト列の機械的な比較のみ行う。MML側の「どの行が原因か」を
// 特定するのは今回のスコープ外(将来オフセット→行番号の対応表を足せるよう、
// パート/イベント単位で追える構造にはしてある)。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileMml } from '../compiler/pmd_mml_compiler.mjs';
import { decodeMmlBytes } from '../net/charset.js';

const __filename = fileURLToPath(import.meta.url);

// ヘッダの構造(doc 1.1/1.2節)。相対オフセット(data[1]を起点とする値)。
export const HEADER_LEN = 0x1a;
export const PART_NAMES = ['FM1', 'FM2', 'FM3', 'FM4', 'FM5', 'FM6', 'SSG1', 'SSG2', 'SSG3', 'ADPCM', 'RHYTHM'];

function read16le(bytes, off) {
  if (off + 1 >= bytes.length) return null;
  return bytes[off] | (bytes[off + 1] << 8);
}

// `.M`ファイルの生バイト列(data[0]込み)からヘッダを読む。
// 戻り値の各オフセットはすべて「相対オフセット」(data[1]を起点、doc 1.1節の用語)。
export function readHeader(fileBytes) {
  const opmFlag = fileBytes[0];
  const rel = fileBytes.subarray(1);
  const partPointers = {};
  for (let i = 0; i < PART_NAMES.length; i++) {
    partPointers[PART_NAMES[i]] = read16le(rel, i * 2);
  }
  const rOffset = read16le(rel, 0x16);
  const tonePtr = read16le(rel, 0x18);
  // doc 1.1節: data[0](=rel[0]、FM1ポインタの下位バイト)が0x18と一致する場合は
  // 旧フォーマット(tone_ptrフィールド無し)の疑いがある、という判定ロジック。
  // v1コンパイラの出力ではこの判定に引っかからない前提だが、参照ファイル側で
  // 引っかかった場合は「旧フォーマットかもしれない」という注記だけ出す(未解明のまま扱う、spec同様)。
  const toneIncludedHeuristic = rel.length > 0 ? rel[0] !== 0x18 : null;
  return {
    opmFlag, relLength: rel.length, partPointers, rOffset, tonePtr, toneIncludedHeuristic,
  };
}

// パート(+r_offset+tone_ptr)の並び順を先頭アドレス順に並べ、各パートの
// おおよそのバイト範囲[start, end)を返す。
//
// 既知の制約(独自に決めた簡略化。将来の拡張ポイント):
// 「次に大きいポインタ値まで」を範囲とみなす近似で、正確なトラック終端(0x80終端
// バイトの実際の位置)を辿ってはいない。そのため、メモ/タイトルテーブルのような
// ヘッダポインタに現れない領域は直前のパートの範囲に混入する。今回は「土台」の
// スコープ(MML構文の実装より前段)としてこれで十分と判断した。
//
// もう1つの簡略化: 複数パートが同じポインタ値を共有している場合(典型例は
// 「未使用パートは全部おなじ空トラック(0x80一発)を指す」)、それらは実データを
// 持たない共有プレースホルダとみなし、範囲を持たない(=無し)扱いにする。
// これが無いと、空トラックのポインタを起点に「次のポインタまで」を範囲だと
// 誤認し、隣の実データを丸ごと自分の範囲に取り込んでしまう
// (このバグはtools/verify_pmd_compiler_oracle.mjsの(a)(c)検査で実際に検出できた)。
export function computePartRegions(header, fileByteLength) {
  const relLength = fileByteLength - 1; // data[0]を除いた長さ
  const boundaries = [];
  const pointerCounts = new Map();
  for (const name of PART_NAMES) {
    const ptr = header.partPointers[name];
    if (ptr != null) {
      boundaries.push(ptr);
      pointerCounts.set(ptr, (pointerCounts.get(ptr) ?? 0) + 1);
    }
  }
  if (header.tonePtr != null) boundaries.push(header.tonePtr);
  const sortedUnique = [...new Set(boundaries)].sort((a, b) => a - b);

  function endFor(start) {
    for (const b of sortedUnique) {
      if (b > start) return b;
    }
    return relLength;
  }

  const regions = {};
  for (const name of PART_NAMES) {
    const start = header.partPointers[name];
    if (start == null) { regions[name] = null; continue; }
    if ((pointerCounts.get(start) ?? 0) > 1) { regions[name] = null; continue; } // 共有プレースホルダ
    regions[name] = { start, end: endFor(start) };
  }
  return regions;
}

// 2つのバイト列(部分ビュー)を先頭から比較する。
// 一致は「先頭からの連続一致(prefix match)」のみを見る単純な指標
// (独自に決めた簡略化: 挿入/削除によるズレを再アラインする本格的なdiffは今回やらない。
// 「土台」のスコープでは、最初にズレた地点が分かれば十分と判断した)。
export function compareByteRanges(ownBytes, refBytes) {
  const minLen = Math.min(ownBytes.length, refBytes.length);
  let matchedLen = 0;
  while (matchedLen < minLen && ownBytes[matchedLen] === refBytes[matchedLen]) matchedLen++;
  const identical = matchedLen === ownBytes.length && matchedLen === refBytes.length;
  let firstMismatchOffset = null;
  let contextOwn = null;
  let contextRef = null;
  if (!identical) {
    firstMismatchOffset = matchedLen;
    contextOwn = hexContext(ownBytes, matchedLen);
    contextRef = hexContext(refBytes, matchedLen);
  }
  return {
    ownLength: ownBytes.length,
    refLength: refBytes.length,
    matchedLen,
    identical,
    firstMismatchOffset,
    contextOwn,
    contextRef,
  };
}

function toHex(b) { return b.toString(16).padStart(2, '0'); }

// mismatchOffset前後8バイトを16進文字列にする(範囲外は静かに切り詰める)。
function hexContext(bytes, mismatchOffset, radius = 8) {
  const start = Math.max(0, mismatchOffset - radius);
  const end = Math.min(bytes.length, mismatchOffset + radius);
  const before = [];
  const after = [];
  for (let i = start; i < mismatchOffset; i++) before.push(toHex(bytes[i]));
  for (let i = mismatchOffset; i < end; i++) after.push(toHex(bytes[i]));
  return { before: before.join(' '), at: after[0] ?? '(範囲外)', after: after.slice(1).join(' ') };
}

// ヘッダ・全パート・音色テーブル位置を突き合わせ、比較結果一式を返す。
export function compareFiles(ownFile, refFile) {
  const ownHeader = readHeader(ownFile);
  const refHeader = readHeader(refFile);
  const ownRegions = computePartRegions(ownHeader, ownFile.length);
  const refRegions = computePartRegions(refHeader, refFile.length);

  const ownRel = ownFile.subarray(1);
  const refRel = refFile.subarray(1);

  const parts = {};
  let matchedParts = 0;
  let totalParts = 0;
  let matchedBytesSum = 0;
  let totalBytesSum = 0;

  for (const name of PART_NAMES) {
    const or = ownRegions[name];
    const rr = refRegions[name];
    const ownPresent = or != null && or.end > or.start;
    const refPresent = rr != null && rr.end > rr.start;
    if (!ownPresent && !refPresent) {
      parts[name] = { ownPresent, refPresent, note: '両方とも空トラック' };
      continue;
    }
    totalParts++;
    const ownBytes = ownPresent ? ownRel.subarray(or.start, or.end) : new Uint8Array(0);
    const refBytes = refPresent ? refRel.subarray(rr.start, rr.end) : new Uint8Array(0);
    const cmp = compareByteRanges(ownBytes, refBytes);
    if (cmp.identical) matchedParts++;
    matchedBytesSum += cmp.matchedLen;
    totalBytesSum += Math.max(cmp.ownLength, cmp.refLength);
    parts[name] = { ownPresent, refPresent, ...cmp };
  }

  const totalByteMatchRate = totalBytesSum > 0 ? matchedBytesSum / totalBytesSum : null;

  return {
    header: {
      own: ownHeader,
      ref: refHeader,
      opmFlagMatch: ownHeader.opmFlag === refHeader.opmFlag,
      tonePtrMatch: ownHeader.tonePtr === refHeader.tonePtr,
    },
    parts,
    summary: {
      matchedParts,
      totalParts,
      matchedBytesSum,
      totalBytesSum,
      totalByteMatchRate,
    },
  };
}

// --- エラー集計(コンパイル失敗時) ---
//
// 既知のエラーメッセージ(compiler/pmd_mml_parser.mjs)は「未対応の文字です: 'X'」
// 「未対応のパート指定です: 'X'」のように対象が引用符で囲まれる形が多い。これを
// 「機能単位」(= 同じ種類のエラーをXごとにまとめたもの)としてカウントする。
// 未知のパターンのメッセージは、引用符の中身と数字列を汎用的にマスクした
// テンプレートでグルーピングする(1件ずつ違う値だけのメッセージでも「同じ機能」として
// まとまるようにするための保険。新しいエラーメッセージが増えるたびにこの関数を
// 更新しなくても、ある程度は自動でグルーピングできる)。
export function categorizeError(message) {
  let m = message.match(/^未対応の文字です: '(.+?)'/);
  if (m) return `未対応の文字: '${m[1]}'`;
  m = message.match(/^未対応のパート指定です: '(.+?)'/);
  if (m) return `未対応のパート指定: '${m[1]}'`;
  // 汎用フォールバック: 引用符の中身と数字列をマスクしてテンプレート化する。
  const template = message
    .replace(/'[^']*'/g, "'X'")
    .replace(/\d+/g, 'N');
  return template;
}

export function aggregateErrors(errors) {
  const counts = new Map();
  for (const e of errors) {
    const key = categorizeError(e.message);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([feature, count]) => ({ feature, count }))
    .sort((a, b) => b.count - a.count || a.feature.localeCompare(b.feature));
}

// --- CLI ---

function parseArgs(argv) {
  const args = { mml: null, ref: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mml') args.mml = argv[++i];
    else if (argv[i] === '--ref') args.ref = argv[++i];
  }
  return args;
}

function formatHeaderTable(header) {
  const lines = [];
  lines.push('パート       自作ポインタ   参照ポインタ   一致');
  for (const name of PART_NAMES) {
    const o = header.own.partPointers[name];
    const r = header.ref.partPointers[name];
    const oHex = o != null ? `0x${o.toString(16).padStart(4, '0')}` : '(なし)';
    const rHex = r != null ? `0x${r.toString(16).padStart(4, '0')}` : '(なし)';
    lines.push(`${name.padEnd(12)} ${oHex.padEnd(14)} ${rHex.padEnd(14)} ${o === r ? '=' : '×'}`);
  }
  lines.push(`tone_ptr     0x${(header.own.tonePtr ?? 0).toString(16).padStart(4, '0')}          0x${(header.ref.tonePtr ?? 0).toString(16).padStart(4, '0')}          ${header.tonePtrMatch ? '=' : '×'}`);
  lines.push(`opm_flag     ${header.own.opmFlag}               ${header.ref.opmFlag}               ${header.opmFlagMatch ? '=' : '×'}`);
  return lines.join('\n');
}

function formatPartDetail(name, p) {
  if (!p.ownPresent && !p.refPresent) return `  ${name}: ${p.note}`;
  const lines = [];
  lines.push(`  ${name}: own=${p.ownLength}byte ref=${p.refLength}byte 一致長=${p.matchedLen}byte ${p.identical ? '(完全一致)' : ''}`);
  if (!p.identical) {
    lines.push(`    最初の不一致オフセット(パート先頭からの相対): ${p.firstMismatchOffset}`);
    lines.push(`    own: ...${p.contextOwn.before} [${p.contextOwn.at}] ${p.contextOwn.after}...`);
    lines.push(`    ref: ...${p.contextRef.before} [${p.contextRef.at}] ${p.contextRef.after}...`);
  }
  return lines.join('\n');
}

export function runCli(argv) {
  const { mml, ref } = parseArgs(argv);
  if (!mml || !ref) {
    console.error('使い方: node tools/compare_pmd_m.mjs --mml <MMLファイルパス> --ref <参照.Mファイルパス>');
    process.exit(1);
  }
  const mmlBytes = new Uint8Array(fs.readFileSync(mml));
  const { text, encoding } = decodeMmlBytes(mmlBytes);
  console.log(`[INFO] MML読み込み: ${path.basename(mml)} (${mmlBytes.length}byte, 判定文字コード=${encoding})`);

  const refBytes = new Uint8Array(fs.readFileSync(ref));
  console.log(`[INFO] 参照.M読み込み: ${path.basename(ref)} (${refBytes.length}byte)`);

  const { file: ownFile, errors } = compileMml(text, {});

  if (errors.length > 0) {
    console.log(`\n[結果] コンパイル失敗: ${errors.length}件のエラー`);
    const agg = aggregateErrors(errors);
    console.log('\n=== エラー集計(機能単位) ===');
    for (const { feature, count } of agg) {
      console.log(`  ${count.toString().padStart(4)}件  ${feature}`);
    }
    return { ok: false, errorCount: errors.length, aggregate: agg };
  }

  console.log('\n[結果] コンパイル成功。参照.Mと比較します。');
  const cmp = compareFiles(ownFile, refBytes);
  console.log('\n=== ヘッダ比較 ===');
  console.log(formatHeaderTable(cmp.header));
  console.log('\n=== パート単位のバイト列比較 ===');
  for (const name of PART_NAMES) {
    console.log(formatPartDetail(name, cmp.parts[name]));
  }
  console.log('\n=== 要約 ===');
  console.log(`一致したパート数: ${cmp.summary.matchedParts} / ${cmp.summary.totalParts}`);
  console.log(`総バイト一致率(prefix一致ベース): ${cmp.summary.totalByteMatchRate != null ? (cmp.summary.totalByteMatchRate * 100).toFixed(2) + '%' : 'n/a'} (${cmp.summary.matchedBytesSum}/${cmp.summary.totalBytesSum}byte)`);
  return { ok: true, compare: cmp };
}

if (process.argv[1] === __filename) {
  runCli(process.argv.slice(2));
}
