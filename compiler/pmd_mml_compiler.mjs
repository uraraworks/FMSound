// PMD MML コンパイラ(v1・第2/3段階): 中間表現(pmd_mml_parser.mjs)から `.M` バイト列を生成する。
// フォーマットの根拠は docs/pmd-compiler-spec.md、コマンドバイトは同spec 1.3/1.4節
// (出典 upstream/98fmplayer/fmdriver/fmdriver_pmd.c の行番号は同spec参照)。
//
// パーサ(字句解析・構文検査)とコードジェネレータ(バイト列生成)を分離してある
// (指示: 「パーサと出力生成は分けておく」)。ヘッダ・音色テーブルの組み立ては
// gen_pmd_min.mjs (第1段階の成果、実機再生で確認済み。旧tools/から移設)の関数を再利用する。
//
// ループのバイナリ表現(0xf9 '[' / 0xf8 ']n' / 0xf7 ':')は fmdriver_pmd.c:2433-2502 を
// 実装から逆算して導出した(コメント参照)。要点:
//   '[' (0xf9): 2byte引数 = (対応する ']' の 'n' バイトのアドレス)。
//               実行時に +1 されて ']' の「カウンタバイト」を指し、0でリセットする。
//   ']n' (0xf8): [0xf8][n(1byte)][counter(1byte,初期値0,自己書き換え)][ptr(2byte)]。
//                ptr は「対応する '[' のアドレス+1」(= '[' の2byte引数フィールドの先頭)。
//                実行時に ptr+2 した位置(='['の直後=ループ本体先頭)へジャンプする。
//   ':' (0xf7): 2byte引数 = 対応する ']' の 'n' バイトのアドレス(='['の引数と同じ値)。
//               最終回(counter==n-1)のみ ptr+4(=']'コマンド全体の直後)へ脱出する。

import { buildToneEntry, noteByte, REST_NIBBLE } from './gen_pmd_min.mjs';
import { parseMml, PART_LETTERS } from './pmd_mml_parser.mjs';
import { encodeCp932 } from './cp932.mjs';

const HEADER_LEN = 0x1a; // 11ポインタ(22) + r_offset(2) + tone_ptr(2)。doc 1.1/1.2節。
const EMPTY_TRACK_OFF = HEADER_LEN;

// メモ/タイトルテーブル(#Title/#Composer/#Arranger/#Memo)。
// 出典: upstream/98fmplayer/fmdriver/fmdriver_pmd.c の pmd_get_memo()(5962-5993)・
// pmd_get_comment()(6008-6014、`pmd_get_memo(pmd, line+1)`)・
// fmdsp-pacc.c由来のcomment.js(pmdweb/build-web/fmdsp/comment.js、get_comment(work,0)=
// タイトル/1=作曲者/2=編曲者/n+1=メモ)を突き合わせて確定した。詳細は
// docs/pmd-compiler-spec.md 追記分を参照。
//
// レイアウト(tone_ptrの直前、`toneptr-4`から): [memoTableOff(2byte LE)][flaglow=0x40][flaghigh]
// flaglow==0x40 は pmd_get_memo() のindexシフトを起こさない値として選んだ
// (fmdriver_pmd.c:5975-5980: 0x42/0x48以上で index++ される。0x40はそのどちらの閾値
// 未満なので素通しになる。flaghighは flaglow==0x40 の分岐では読まれないため任意値)。
// memoTableOff が指す先はポインタ(2byte LE)の配列、0x0000で終端。
// index0=予約(PPCファイル名スロット、pmd_get_memo(pmd,0)用。今回はPCM機能を
// 使わないので常に空文字列を置くだけの位置合わせ)、index1=タイトル、index2=作曲者、
// index3=編曲者、index4以降=#Memoの各行(この順でpmd_get_comment(work,0..2,n+1)と一致)。
function buildMemoBlock(header, startOff) {
  const slots = ['', header.title ?? '', header.composer ?? '', header.arranger ?? '', ...header.memo];
  const slotLines = [null, header.titleLine, header.composerLine, header.arrangerLine, ...header.memoLines];

  const encoded = slots.map((s, idx) => {
    const { bytes, unmappable } = encodeCp932(s);
    if (!bytes) {
      const where = slotLines[idx] != null ? `${slotLines[idx]}行目付近の` : '';
      throw new Error(`${where}ヘッダ文字列にCP932へ変換できない文字が含まれています: ${unmappable.join(' ')}`);
    }
    return bytes;
  });

  const tableOff = startOff;
  const tableBytes = (slots.length + 1) * 2; // 各エントリ2byte + 終端0x0000
  const stringsOff = tableOff + tableBytes;

  let cursor = stringsOff;
  const stringOffsets = encoded.map((bytes) => {
    const off = cursor;
    cursor += bytes.length + 1; // + null終端
    return off;
  });

  const flagsOff = cursor;
  const totalLen = flagsOff + 4;

  const out = new Uint8Array(totalLen - startOff);
  function w16(off, val) {
    out[off - startOff] = val & 0xff;
    out[off - startOff + 1] = (val >> 8) & 0xff;
  }
  encoded.forEach((_, idx) => w16(tableOff + idx * 2, stringOffsets[idx]));
  w16(tableOff + slots.length * 2, 0); // 終端
  encoded.forEach((bytes, idx) => {
    out.set(bytes, stringOffsets[idx] - startOff);
    out[stringOffsets[idx] - startOff + bytes.length] = 0; // null終端
  });
  w16(flagsOff, tableOff); // toneptr-4 位置(memoptr)
  out[flagsOff - startOff + 2] = 0x40; // flaglow
  out[flagsOff - startOff + 3] = 0x00; // flaghigh(未使用)

  return { bytes: out, endOff: totalLen };
}

function sizeOfEvent(ev) {
  switch (ev.type) {
    case 'note': case 'rest': return 2;
    case 'tie': return 1;
    case 'tone': return 2;
    case 'volAbs': return 2;
    case 'tempoAbs': return ev.isTimerB ? 2 : 3;
    case 'tempoRel': return 3;
    case 'loopOpen': return 3;
    case 'loopClose': return 5;
    case 'loopExit': return 3;
    case 'globalLoop': return 1;
    case 'measLen': return 2; // 0xdf + 1byte(v2 3.8節)
    case 'detuneAbs': case 'detuneRel': return 3; // 0xfa/0xd5 + 2byte符号付き(v2 3.9節)
    case 'pan': return 2; // 0xec + 1byte(v2 3.2節)
    case 'lfoSwitch': return 2; // 0xf1 + 1byte(v2 3.7節)
    case 'lfoBody': return 5; // 0xf2 + 4byte固定(v2 3.6節)
    case 'volInc': case 'volDec': return 2; // 0xe3/0xe2 + 1byte(v2 3.1節)
    case 'gateRandRange': return 2; // 0xb1 + 1byte(v2 3.3節)
    case 'gateMin': return 2; // 0xb3 + 1byte(v2 3.3節)
    case 'portamento': return 4; // 0xda + note1(1byte) + note2(1byte) + clocks(1byte)(v2 3.5節、今回実測で解決)
    case 'transposeAbs': return 2; // 0xf5 + 1byte符号付き(PMDMML.MAN §4-14、今回実測で解決)
    case 'transposeRel': return 2; // 0xe7 + 1byte符号付き(PMDMML.MAN §4-14、今回実測で解決)
    default: throw new Error(`未知のイベント種別: ${ev.type}`);
  }
}

function signedByte(v) {
  if (v < -128 || v > 127) throw new Error(`符号付き1byteに収まりません: ${v}`);
  return v & 0xff;
}

function emitEvent(ev, out, offset) {
  function w16(off, val) {
    out[off] = val & 0xff;
    out[off + 1] = (val >> 8) & 0xff;
  }
  switch (ev.type) {
    case 'note':
      out[offset] = noteByte(ev.octave, ev.noteIndex);
      out[offset + 1] = ev.clocks & 0xff;
      return;
    case 'rest':
      out[offset] = noteByte(ev.octave, REST_NIBBLE);
      out[offset + 1] = ev.clocks & 0xff;
      return;
    case 'tie':
      out[offset] = 0xfb;
      return;
    case 'tone':
      out[offset] = 0xff;
      out[offset + 1] = ev.tonenum & 0xff;
      return;
    case 'volAbs':
      // 音量絶対値セット(0xfd, doc 1.4節)。v/Vともパーサ側で最終的な生バイト値まで
      // 解決済み(pmd_mml_parser.mjs)なので、ここでは単純に書き出すだけでよい。
      out[offset] = 0xfd;
      out[offset + 1] = ev.value & 0xff;
      return;
    case 'tempoAbs':
      out[offset] = 0xfc;
      if (ev.isTimerB) {
        out[offset + 1] = ev.val & 0xff;
      } else {
        out[offset + 1] = 0xff;
        out[offset + 2] = ev.val & 0xff;
      }
      return;
    case 'tempoRel':
      out[offset] = 0xfc;
      out[offset + 1] = ev.isTimerB ? 0xfe : 0xfb;
      out[offset + 2] = signedByte(ev.delta);
      return;
    case 'loopOpen': {
      out[offset] = 0xf9;
      const ptr = ev.closeRef._addr + 1;
      w16(offset + 1, ptr);
      return;
    }
    case 'loopClose': {
      out[offset] = 0xf8;
      out[offset + 1] = ev.count & 0xff;
      out[offset + 2] = 0; // カウンタ初期値(実行時に自己書き換えされる)
      const ptr = ev.openRef._addr + 1;
      w16(offset + 3, ptr);
      return;
    }
    case 'loopExit': {
      out[offset] = 0xf7;
      const closeEv = ev.openRef.closeRef;
      const ptr = closeEv._addr + 1;
      w16(offset + 1, ptr);
      return;
    }
    case 'globalLoop':
      out[offset] = 0xf6;
      return;
    case 'measLen': // 全音符長設定(v2 3.8節)
      out[offset] = 0xdf;
      out[offset + 1] = ev.value & 0xff;
      return;
    case 'detuneAbs': // デチューン絶対値(v2 3.9節)
      out[offset] = 0xfa;
      w16(offset + 1, ev.value);
      return;
    case 'detuneRel': // デチューン相対値(v2 3.9節)
      out[offset] = 0xd5;
      w16(offset + 1, ev.value);
      return;
    case 'pan': // パン設定1(v2 3.2節)
      out[offset] = 0xec;
      out[offset + 1] = ev.value & 0xff;
      return;
    case 'lfoSwitch': // ソフトウエアLFOスイッチ(v2 3.7節)
      out[offset] = 0xf1;
      out[offset + 1] = ev.value & 0xff;
      return;
    case 'lfoBody': // ソフトウエアLFO本体(v2 3.6節)。常に4byte固定。
      out[offset] = 0xf2;
      out[offset + 1] = ev.delay & 0xff;
      out[offset + 2] = ev.speed & 0xff;
      out[offset + 3] = signedByte(ev.depthA);
      out[offset + 4] = ev.depthB & 0xff;
      return;
    case 'volInc': // 音量相対変化・加算(v2 3.1節)
      out[offset] = 0xe3;
      out[offset + 1] = ev.value & 0xff;
      return;
    case 'volDec': // 音量相対変化・減算(v2 3.1節)
      out[offset] = 0xe2;
      out[offset + 1] = ev.value & 0xff;
      return;
    case 'gateRandRange': // qの数値2(v2 3.3節)
      out[offset] = 0xb1;
      out[offset + 1] = ev.value & 0xff;
      return;
    case 'gateMin': // qの数値3(v2 3.3節)
      out[offset] = 0xb3;
      out[offset + 1] = ev.value & 0xff;
      return;
    case 'portamento': // ポルタメント(v2 3.5節。0xda + note1 + note2 + clocks)
      out[offset] = 0xda;
      out[offset + 1] = noteByte(ev.note1.octave, ev.note1.noteIndex);
      out[offset + 2] = noteByte(ev.note2.octave, ev.note2.noteIndex);
      out[offset + 3] = ev.clocks & 0xff;
      return;
    case 'transposeAbs': // 転調・絶対値(PMDMML.MAN §4-14。0xf5 + 1byte符号付き)
      out[offset] = 0xf5;
      out[offset + 1] = signedByte(ev.value);
      return;
    case 'transposeRel': // 転調・相対値(PMDMML.MAN §4-14。0xe7 + 1byte符号付き)
      out[offset] = 0xe7;
      out[offset + 1] = signedByte(ev.value);
      return;
    default:
      throw new Error(`未知のイベント種別: ${ev.type}`);
  }
}

// events に相対アドレス(_addr)を付与する。トラック終端(0x80)のアドレスも返す。
function layoutTrack(events, startAddr) {
  let addr = startAddr;
  for (const ev of events) {
    ev._addr = addr;
    addr += sizeOfEvent(ev);
  }
  const termAddr = addr;
  addr += 1; // 0x80 終端
  return { endAddr: addr, termAddr };
}

// MML全文 → `.M` バイト列。
// tones: { [tonenum]: buildToneEntry()のoptions(tonenumを除く) } 。
//   MML本文中の音色定義ブロック(@ 音色番号 ALG FB ...、pmd_mml_parser.mjsが解析)と
//   マージされる(同じ番号があればこの引数のほうが優先。第1段階からの後方互換用の経路)。
//   `@n` が参照する音色番号は、本文中の定義かこの引数のどちらかに存在すればよい。
//   どちらにも何も無ければ後方互換のため既定音色(@1, 全パラメータ既定値)を1つ用意する。
// 戻り値: { file, errors, layout } (errorsが空でない場合 file は null)。
// layout には検証スクリプトが使う各トラックの先頭アドレス・終端アドレス・
// イベント列(アドレス付き)・使用した音色テーブル(tones)を含む。
export function compileMml(source, { tones, opmFlag = 0 } = {}) {
  const { tracks, tones: parsedTones, header, errors: parseErrors } = parseMml(source);
  if (parseErrors.length > 0) return { file: null, errors: parseErrors, layout: null };

  const toneTable = {};
  for (const [tn, opts] of parsedTones) toneTable[tn] = opts;
  if (tones) Object.assign(toneTable, tones); // 明示指定があれば本文中の定義より優先(後方互換)
  if (Object.keys(toneTable).length === 0) toneTable[1] = {}; // 何も定義が無ければ既定音色1個(第1段階からの後方互換)

  const errors = [];
  // MML中で使われている音色番号がすべて toneTable に存在するか検査
  for (const [part, events] of tracks) {
    for (const ev of events) {
      if (ev.type === 'tone' && !(ev.tonenum in toneTable)) {
        errors.push({ line: ev.line, message: `パート${part}: 音色番号 @${ev.tonenum} が定義されていません(本文中の音色定義、またはtonesオプションのどちらにも無い)` });
      }
    }
  }
  if (errors.length > 0) return { file: null, errors, layout: null };

  // トラックのレイアウト: ヘッダ直後に空トラック(0x80)、続けて使用中の A-I トラックを順に並べる。
  let cursor = EMPTY_TRACK_OFF + 1;
  const trackLayout = {}; // partLetter -> {startAddr, termAddr, events}
  for (const letter of PART_LETTERS) {
    const events = tracks.get(letter);
    if (!events || events.length === 0) continue;
    const startAddr = cursor;
    const { endAddr, termAddr } = layoutTrack(events, startAddr);
    trackLayout[letter] = { startAddr, termAddr, events };
    cursor = endAddr;
  }

  // ヘッダ命令(#Title/#Composer/#Arranger/#Memo)が1つでもあれば、tone_ptr直前に
  // メモテーブルを差し込む(buildMemoBlock、doc参照)。無ければ従来通り何も挟まない
  // (後方互換: ヘッダ命令を使わないMMLの出力バイト列は変化しない)。
  const hasHeader = header.title != null || header.composer != null
    || header.arranger != null || header.memo.length > 0;
  let memoBlock = null;
  if (hasHeader) {
    try {
      memoBlock = buildMemoBlock(header, cursor);
    } catch (e) {
      return { file: null, errors: [{ line: header.titleLine ?? 1, message: e.message }], layout: null };
    }
    cursor = memoBlock.endOff;
  }

  const toneNums = Object.keys(toneTable).map(Number).sort((a, b) => a - b);
  const toneOff = cursor;
  const toneEntries = toneNums.map((tn) => buildToneEntry({ ...toneTable[tn], tonenum: tn }));
  const relLen = toneOff + toneEntries.length * 26;

  const rel = new Uint8Array(relLen);
  function w16(off, val) {
    rel[off] = val & 0xff;
    rel[off + 1] = (val >> 8) & 0xff;
  }
  if (memoBlock) rel.set(memoBlock.bytes, memoBlock.endOff - memoBlock.bytes.length);

  // ヘッダ: 11パート分(FM1-6, SSG1-3, ADPCM, RHYTHM。doc 1.2節の順)。
  // PART_LETTERS(pmd_mml_parser.mjs)の配列indexが、そのままこのヘッダindexと一致するよう設計してある
  // (A-F=idx0-5=FM1-6, G-I=idx6-8=SSG1-3, J=idx9=ADPCM。v2 step3でJを追加)。
  for (let idx = 0; idx < PART_LETTERS.length; idx++) {
    const letter = PART_LETTERS[idx];
    const layout = trackLayout[letter];
    w16(idx * 2, layout ? layout.startAddr : EMPTY_TRACK_OFF);
  }
  for (let idx = PART_LETTERS.length; idx < 11; idx++) w16(idx * 2, EMPTY_TRACK_OFF); // RHYTHM: K/Rは未解明のため未対応、空トラック
  w16(0x16, EMPTY_TRACK_OFF); // r_offset(未使用)
  w16(0x18, toneOff); // tone_ptr

  rel[EMPTY_TRACK_OFF] = 0x80;

  for (const letter of Object.keys(trackLayout)) {
    const { events, termAddr } = trackLayout[letter];
    for (const ev of events) emitEvent(ev, rel, ev._addr);
    rel[termAddr] = 0x80;
  }

  toneEntries.forEach((entry, idx) => rel.set(entry, toneOff + idx * 26));

  const file = new Uint8Array(1 + relLen);
  file[0] = opmFlag & 0xff;
  file.set(rel, 1);

  return { file, errors: [], layout: { tracks: trackLayout, toneOff, toneNums } };
}
