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

// メモ/タイトルテーブル(#Title/#Composer/#Arranger/#Memo)。
// 出典: upstream/98fmplayer/fmdriver/fmdriver_pmd.c の pmd_get_memo()(5962-5993)・
// pmd_get_comment()(6008-6014、`pmd_get_memo(pmd, line+1)`)・
// fmdsp-pacc.c由来のcomment.js(pmdweb/build-web/fmdsp/comment.js、get_comment(work,0)=
// タイトル/1=作曲者/2=編曲者/n+1=メモ)を突き合わせて確定した。詳細は
// docs/pmd-compiler-spec.md 追記分を参照。
//
// レイアウト(tone_ptrの直前、`toneptr-4`から): [memoTableOff(2byte LE)][flaglow][flaghigh]
// pmd_get_memo() (fmdriver_pmd.c:5962-5993) の index シフト規則:
//   flaglow==0x40                        → indexシフト無し
//   flaglow!=0x40 の場合、flaghigh==0xfe かつ flaglow>=0x41 が必須(でなければ0扱い)。
//   その上で flaglow>=0x42 なら index++、flaglow>=0x48 なら さらに index++(=合計+2)。
// #PCMfile/#PPZfile/#PPSfile(pmd_init 6043-6058で pmd_get_memo(pmd,-2/-1/0)を読む)を
// 有効にするには index=-2 が物理位置0に届く必要があり、+2シフト(flaglow>=0x48)が要る。
// これによりpmd_get_comment(line)側(6008-6014, line+1をpmd_get_memoへ渡す)の物理位置も
// +2ずれるため、テーブルの並びは [PPZ, PPS, PCM(PPC), Title, Composer, Arranger, Memo...]
// にする(旧来のTitle=idx1相当だった並びをそのまま2つ後ろへずらすだけで整合する)。
// flaglow=0x48/flaghigh=0xfeの組はfmdsp側の再実装(pmdweb, PmdCore.c)を通した実測
// (tools/verify_pmd_header.mjsの getPcmName/getCommentLength/getCommentPointer)で
// title/composer/arranger/memo/pcm/ppz/ppsの全スロットが期待通り読み出せることを確認済み。
//
// 2026-08-18: 追加corpusケース(tools/pmd-reference/pmdhdrmt.mml、#PCMfile等を
// 一切使わない#Title/#Composer/#Memoのみのケース)をMC.EXEで実測した結果、
// **PCM系ヘッダの有無に関わらずMC.EXEは常にこの3予約スロット+flaglow=0x48/
// flaghigh=0xfeのレイアウトを出力する**ことが判明した(手計算でpmdhdrmt.Mの
// テーブル/文字列オフセットをすべて突き合わせ、8スロット全ての位置が一致することを確認済み。
// 当初「PCM系ヘッダが無ければ旧来のflaglow=0x40・4スロットのレイアウトを使う」という
// 条件分岐にしていたが、これは誤りだった: 参照.M比較ツール(verify_pmd_reference_corpus.mjs)
// の一致率指標がそもそもヘッダ領域を見ておらず、条件分岐の要不要を判定できていなかった)。
// そのため常時この8スロット(予約3+Title/Composer/Arranger+Memo)構成を使う。
//
// 2026-08-18 追記(配置の訂正): このメモ「本体」(文字列+ポインタテーブル)は
// tone_ptrの**手前**ではなく、tone_ptrが指すトーンテーブルの**直後**に置かれる、
// と参照.M実測(pmdbasic.M/pmdtone.M/pmdhdrmt.M/pmdhdrpc.M、4ケース)で判明した。
// 実際のファイル順序は
//   [トラック][r_offset固定領域(8B)][flags(4B、toneptr-4)]
//   [トーンテーブル(entries + 00 FF終端)][メモ文字列群][メモポインタテーブル]
// で、flagsのmemoTableOffはこの関数が返す末尾のポインタテーブル(tableOff)を指す。
// (flags自体はcompileMml側でtone_ptrの直前に書く。この関数は文字列+テーブルのみ)
function buildMemoTail(header, stringsStartOff) {
  const slots = [
    header.ppzfile ?? '', header.ppsfile ?? '', header.pcmfile ?? '',
    header.title ?? '', header.composer ?? '', header.arranger ?? '',
    ...header.memo,
  ];
  const slotLines = [
    header.ppzfileLine, header.ppsfileLine, header.pcmfileLine,
    header.titleLine, header.composerLine, header.arrangerLine,
    ...header.memoLines,
  ];

  const encoded = slots.map((s, idx) => {
    const { bytes, unmappable } = encodeCp932(s);
    if (!bytes) {
      const where = slotLines[idx] != null ? `${slotLines[idx]}行目付近の` : '';
      throw new Error(`${where}ヘッダ文字列にCP932へ変換できない文字が含まれています: ${unmappable.join(' ')}`);
    }
    return bytes;
  });

  let cursor = stringsStartOff;
  const stringOffsets = encoded.map((bytes) => {
    const off = cursor;
    cursor += bytes.length + 1; // + null終端
    return off;
  });

  const tableOff = cursor;
  const tableBytes = (slots.length + 1) * 2; // 各エントリ2byte + 終端0x0000
  const totalLen = tableOff + tableBytes;

  const out = new Uint8Array(totalLen - stringsStartOff);
  function w16(off, val) {
    out[off - stringsStartOff] = val & 0xff;
    out[off - stringsStartOff + 1] = (val >> 8) & 0xff;
  }
  encoded.forEach((bytes, idx) => {
    out.set(bytes, stringOffsets[idx] - stringsStartOff);
    out[stringOffsets[idx] - stringsStartOff + bytes.length] = 0; // null終端
  });
  encoded.forEach((_, idx) => w16(tableOff + idx * 2, stringOffsets[idx]));
  w16(tableOff + slots.length * 2, 0); // 終端

  return { bytes: out, tableOff, endOff: totalLen };
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
    case 'gateAbs': return 2; // 0xfe + 1byte(qの数値1。今回参照.M実測で確定)
    case 'portamento': return 4; // 0xda + note1(1byte) + note2(1byte) + clocks(1byte)(v2 3.5節、今回実測で解決)
    case 'transposeAbs': return 2; // 0xf5 + 1byte符号付き(PMDMML.MAN §4-14、今回実測で解決)
    case 'transposeRel': return 2; // 0xe7 + 1byte符号付き(PMDMML.MAN §4-14、今回実測で解決)
    // リズム音源直接コマンド(`\`系、PMDMML.MAN §14)・Kパートのパターン選択(v2 1.3節)。
    // バイト割当はpmd_mml_parser.mjsのRHYTHM_BIT等のコメント参照(pmdunimp.M実測+
    // rhbits/rhpan corpus実測の2系統で確定)。
    case 'rhShot': return 2; // 0xeb + 1byte(bit7=dump、下位6bit=対象マスク)
    case 'rhVolAbs': return 2; // 0xe8 + 1byte(0-63)
    case 'rhVolRel': return 2; // 0xe6 + 1byte符号付き
    case 'rhVolIndivAbs': return 2; // 0xea + 1byte(上位3bit=対象1-6/下位5bit=値0-31)
    case 'rhVolIndivRel': return 3; // 0xe5 + 対象1byte + 符号付き差分1byte
    case 'rhPan': return 2; // 0xe9 + 1byte(上位3bit=対象1-6/下位2bit=l=2,m=3,r=1)
    case 'rhSelect': return 1; // cmd(=パターン番号、0-127)のみ。オペコード無し(cmd<0x80が識別子)
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
      // カウンタ初期値: 従来0固定としていたが、今回K/R実装の副産物として
      // tools/pmd-reference/pmdunimp.M(ループ使用corpus唯一の既存ケース)を実測した
      // ところ、コンパイル直後の値は0ではなく数値1(count)と同じ値だった(0xf8 04 04 ...)。
      // 「実行時に自己書き換えされる」こと自体は変わらない(コンパイル時点のスナップショット)が、
      // 初期値はcountそのものだったため合わせる。他corpusにループ使用ケースが無く
      // 退行の懸念は無い(grep確認済み)。
      out[offset + 2] = ev.count & 0xff;
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
    case 'lfoSwitch': // ソフトウエアLFOスイッチ(v2 3.7節)。lfo===2ならLFO2(0xbe)、既定はLFO1(0xf1)。
      out[offset] = ev.lfo === 2 ? 0xbe : 0xf1;
      out[offset + 1] = ev.value & 0xff;
      return;
    case 'lfoBody': // ソフトウエアLFO本体(v2 3.6節)。常に4byte固定。lfo===2ならLFO2(0xbf)、既定はLFO1(0xf2)。
      out[offset] = ev.lfo === 2 ? 0xbf : 0xf2;
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
    case 'gateAbs': // qの数値1(固定カット量。今回参照.M実測で確定)
      out[offset] = 0xfe;
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
    case 'rhShot': // リズム音源ショット/ダンプ制御(PMDMML.MAN §14-1。0xeb)
      out[offset] = 0xeb;
      out[offset + 1] = (ev.dump ? 0x80 : 0) | (ev.bits & 0x3f);
      return;
    case 'rhVolAbs': // リズム音源マスタボリューム絶対値(PMDMML.MAN §14-2。0xe8)
      out[offset] = 0xe8;
      out[offset + 1] = ev.value & 0xff;
      return;
    case 'rhVolRel': // リズム音源マスタボリューム相対値(PMDMML.MAN §14-2。0xe6)
      out[offset] = 0xe6;
      out[offset + 1] = signedByte(ev.delta);
      return;
    case 'rhVolIndivAbs': // リズム音源個別音量絶対値(PMDMML.MAN §14-3。0xea)
      out[offset] = 0xea;
      out[offset + 1] = ((ev.target & 0x7) << 5) | (ev.value & 0x1f);
      return;
    case 'rhVolIndivRel': // リズム音源個別音量相対値(PMDMML.MAN §14-3。0xe5)
      out[offset] = 0xe5;
      out[offset + 1] = ev.target & 0xff;
      out[offset + 2] = signedByte(ev.delta);
      return;
    case 'rhPan': // リズム音源出力位置(PMDMML.MAN §14-4。0xe9)
      out[offset] = 0xe9;
      out[offset + 1] = ((ev.target & 0x7) << 5) | (ev.pos & 0x3);
      return;
    case 'rhSelect': // Kパート: Rパターン選択(v2 1.3節。cmd(<0x80)そのものがパターン番号)
      out[offset] = ev.pattern & 0x7f;
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

// Rパターン本体(v2 1.3節)のレイアウト。通常トラックと同じイベント列だが、
// 終端バイトが0x80ではなく単独の0xffである点だけが違う(pmdunimp.M実測、
// R0/R1/R2いずれも`\`系コマンド列の直後に0xffが1byteだけ置かれ、次のパターンの
// ポインタがその直後を指していた。0xffは通常コマンド表への「エスケープ」経路
// (rcmd&0xc0==0xc0)を通る値で、fmdriver_pmd.c単体からは終端の意味の確証は
// 得られていないが、実測上は常にこの1byteでパターンが閉じている)。
function layoutRhythmPattern(events, startAddr) {
  let addr = startAddr;
  for (const ev of events) {
    ev._addr = addr;
    addr += sizeOfEvent(ev);
  }
  const termAddr = addr;
  addr += 1; // 0xff 終端(通常トラックの0x80とは異なる)
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
  const { tracks, tones: parsedTones, header, rhythmPatterns, errors: parseErrors } = parseMml(source);
  if (parseErrors.length > 0) return { file: null, errors: parseErrors, layout: null };

  const toneTable = {};
  for (const [tn, opts] of parsedTones) toneTable[tn] = opts;
  if (tones) Object.assign(toneTable, tones); // 明示指定があれば本文中の定義より優先(後方互換)
  // hasExplicitTones: 出力(トーンテーブル)を決めるためのフラグ。既定音色を合成する
  // *前*の時点(=利用者が実際に@n定義かtonesオプションを与えたかどうか)で確定させる。
  const hasExplicitTones = Object.keys(toneTable).length > 0;
  // 2026-08-18: 検査(validation)用には引き続き既定音色@1を合成する(第1段階からの
  // 後方互換。tools/verify_pmd_recompile_after_error.mjs のFIXED_MML='A o4 c4 d4 e4 @1'
  // のように、本文中に@n定義ブロックが無いまま`@1`で既定音色を選択するケースが既存の
  // 検証群に存在し、これをエラーにしない設計だったため)。ただし**出力バイト列**では
  // この合成した既定音色を書かない: 参照.M実測(pmdbasic.M/pmdhdrmt.M/pmdhdrpc.M、
  // 3ケース)で、MC.EXEは`@`定義が1つも無い場合に26byteの音色エントリを一切書かず、
  // トーンテーブル終端マーカ(下記TONE_TERMINATOR)だけを置くことを確認した。
  // 出力への反映は`hasExplicitTones`で分岐する(下のtoneEntries参照)。
  if (Object.keys(toneTable).length === 0) toneTable[1] = {};

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

  // トラックのレイアウト: 本家MC.EXE(ver4.8s)の出力を実測して確定した(tools/pmd-reference/、
  // 2026-08-18作業。推測ではなく実バイト列から逆算)。
  //   ヘッダの各スロット(A-J実装パート10個 + K=リズム(常に空、未実装) + r_offset の計12個、
  //   pmd_mml_parser.mjsのPART_LETTERS順)を「ヘッダindex順」にそのまま処理し、
  //   使用中パートは実トラックデータを、未使用スロット(未使用パート・K・r_offset)は
  //   スロットごとに専用の終端バイト(0x80)を1個だけ、その時点のcursorに置く。
  //   これにより「未使用パートが1つの終端アドレスを共有する」自作旧実装と違い、
  //   本家同様に各未使用スロットが個別のアドレスを持つ。
  //   実測の根拠(pmdssg.M: Gだけ使用): ヘッダ = 001a 001b 001c 001d 001e 001f 0020(G) 0030...
  //   → A-F(未使用)の終端バイトがG本体より前、0x1a-0x1fに1byteずつ連続で並ぶ。
  //   これはヘッダindex順(A,B,C,D,E,F,G,...)で処理しないと再現できない配置であり、
  //   「使用パートを先に全部並べてから未使用の終端をまとめて置く」という単純化では出せない。
  const SLOT_LETTERS = [...PART_LETTERS, 'K', null]; // idx0-9=A-J、idx10=K(リズム、常に空)、idx11=r_offset
  let cursor = HEADER_LEN;
  const trackLayout = {}; // partLetter -> {startAddr, termAddr, events}
  const slotAddr = new Array(SLOT_LETTERS.length); // 各スロットがヘッダに書き込むポインタ値
  const emptySlotAddrs = []; // 未使用スロットの終端バイト(0x80)を書き込むアドレス
  let rhythmFixedAddr = null; // r_offset固定領域(8byte、K/R未使用時)の先頭アドレス
  let rhythmIndexInfo = null; // K/R使用時: {tableAddr, patAddrs, patternLayouts, mysteryAddr}
  for (let idx = 0; idx < SLOT_LETTERS.length; idx++) {
    const letter = SLOT_LETTERS[idx];
    // 2026-08-18(K/R実装): Kパートは他パートと同じ「実トラック」として扱う
    // (letter!=='K'の除外を撤廃。中身は tokenizeRhythmKBody が作るrhSelect/loop/
    // \系イベント列で、layoutTrack/emitEventは通常パートと同じ経路をそのまま使える。
    // 終端も他パートと同じ0x80、pmdunimp.M実測で確認済み)。
    const events = letter ? tracks.get(letter) : null;
    if (events && events.length > 0) {
      const startAddr = cursor;
      const { endAddr, termAddr } = layoutTrack(events, startAddr);
      trackLayout[letter] = { startAddr, termAddr, events };
      slotAddr[idx] = startAddr;
      cursor = endAddr;
    } else if (idx === 11) {
      // r_offset(RHYTHMパート\0-\n等のパターン定義ポインタテーブル、
      // fmdriver_pmd.c:5440 `pmd->r_offset + cmd*2`で参照される)。
      //
      // 2026-08-18(K/R実装): 既存corpus(pmdunimp.M、K/R使用)を実バイト単位で
      // 読み直した結果、以前「r_offsetの8byte固定領域」と呼んでいたものは、実は
      // r_offsetそのものではなく「r_offsetの直後、tone_ptrの手前に常にある別の
      // 8byte領域」だと判明した(K/R未使用時はr_offsetの値がこの領域の先頭アドレス
      // と一致するため、これまで両者を区別できていなかった)。
      // pmdunimp.M実測: r_offset(0x3d)から6byte(3パターン×2byte)の索引表→
      // 各パターンの`\`系コマンド列(3byte×3、いずれも末尾は単独の0xff)→
      // その直後(0x4c)から8byteの0x00固定領域→flags(4byte、0x54)。
      // つまり正しい構造は
      //   r_offset → [索引表(2byte×パターン数)][各パターンの本体(終端0xff付き)]
      //   → (常にある8byte領域、K/R使用時は全byte0x00) → flags/toneTable
      // であり、既存の「8byte固定領域(既定値0x60,0,0,...)」は「K/R未使用時、
      // 索引表が0エントリでr_offsetがこの8byte領域と同じ位置になる」特殊ケースに
      // すぎなかった(この8byte領域自体の意味・先頭byteの規則は依然未解明のまま。
      // K/R未使用時は指示書が名指しした3ケースの実測値0x60を既定値として維持し、
      // K/R使用時は0x00(pmdunimp.M実測どおり)を既定値とする)。
      slotAddr[idx] = cursor;
      if (rhythmPatterns.size > 0) {
        const patNums = [...rhythmPatterns.keys()].sort((a, b) => a - b);
        // 索引表は「r_offset + パターン番号*2」で直接参照される(fmdriver_pmd.c:1748)ため、
        // 番号0から連番でないと途中のエントリが未定義になる。この形は今回の実測
        // (pmdunimp.M: R0,R1,R2)でしか確認できていないため、飛び番号は安全側で未対応とする。
        for (let k = 0; k < patNums.length; k++) {
          if (patNums[k] !== k) {
            throw new Error(`Rパターン番号は0から連番である必要があります(未実測の飛び番号には未対応。パターン番号: ${patNums.join(',')})`);
          }
        }
        const tableAddr = cursor;
        cursor += patNums.length * 2; // 索引表(各パターンにつき2byte)
        const patAddrs = [];
        const patternLayouts = [];
        for (const num of patNums) {
          const startAddr = cursor;
          const patEvents = rhythmPatterns.get(num);
          const { endAddr, termAddr } = layoutRhythmPattern(patEvents, startAddr);
          patAddrs.push(startAddr);
          patternLayouts.push({ events: patEvents, termAddr });
          cursor = endAddr;
        }
        const mysteryAddr = cursor;
        cursor += 8; // 常にある8byte領域(K/R使用時は0x00固定、上記コメント参照)
        rhythmIndexInfo = { tableAddr, patAddrs, patternLayouts, mysteryAddr };
      } else {
        rhythmFixedAddr = cursor;
        cursor += 8;
      }
    } else {
      slotAddr[idx] = cursor;
      emptySlotAddrs.push(cursor);
      cursor += 1; // このスロット専用の終端バイト(0x80)
    }
  }

  // ヘッダ命令(#Title/#Composer/#Arranger/#Memo/#PCMfile/#PPZfile/#PPSfile)が
  // 1つでもあれば、flags(4byte)をtone_ptrの直前に置く。無ければ従来通り何も挟まない
  // (後方互換: ヘッダ命令を使わないMMLでは、この2026-08-18のヘッダ機能追加より前と
  // 同じ「トーンテーブルの直前にflagsが無い」構造のまま)。
  const hasHeader = header.title != null || header.composer != null
    || header.arranger != null || header.memo.length > 0
    || header.pcmfile != null || header.ppzfile != null || header.ppsfile != null;

  // hasExplicitTonesがfalseの場合、toneTableには検査用に合成した既定音色(@1)しか
  // 無い。出力(toneEntries)には反映しない(TONE_TERMINATORだけを置く。上のコメント参照)。
  const toneNums = hasExplicitTones ? Object.keys(toneTable).map(Number).sort((a, b) => a - b) : [];
  const toneEntries = toneNums.map((tn) => buildToneEntry({ ...toneTable[tn], tonenum: tn }));

  // 2026-08-18: トーンテーブルは常に2byteの終端マーカ`00 FF`で終わる(参照.M実測、
  // pmdbasic.M(@未使用、entries=0)・pmdtone.M/pmdton2.M(@使用、entries=1)の
  // 双方で確認)。@未使用時はこのマーカだけがトーンテーブルの中身になる。
  const TONE_TERMINATOR = [0x00, 0xff];

  let flagsOff = null;
  if (hasHeader) {
    flagsOff = cursor;
    cursor += 4; // flags(memoTableOff 2byte + flaglow + flaghigh)。値は末尾で書く
  }
  const toneOff = cursor; // tone_ptr
  cursor = toneOff + toneEntries.length * 26 + TONE_TERMINATOR.length;

  // メモ本体(文字列+ポインタテーブル)は、旧実装が置いていた「tone_ptrの直前」ではなく
  // 「トーンテーブルの直後」に置く(buildMemoTailのコメント参照、参照.M実測で訂正済み)。
  let memoTail = null;
  if (hasHeader) {
    try {
      memoTail = buildMemoTail(header, cursor);
    } catch (e) {
      return { file: null, errors: [{ line: header.titleLine ?? 1, message: e.message }], layout: null };
    }
    cursor = memoTail.endOff;
  }

  const relLen = cursor;
  const rel = new Uint8Array(relLen);
  function w16(off, val) {
    rel[off] = val & 0xff;
    rel[off + 1] = (val >> 8) & 0xff;
  }

  // ヘッダ: 11パート分(FM1-6, SSG1-3, ADPCM, RHYTHM。doc 1.2節の順)。
  // PART_LETTERS(pmd_mml_parser.mjs)の配列indexが、そのままこのヘッダindexと一致するよう設計してある
  // (A-F=idx0-5=FM1-6, G-I=idx6-8=SSG1-3, J=idx9=ADPCM。v2 step3でJを追加)。
  // idx10=K(リズム)、idx11(0x16)=r_offset。値はいずれも上のslotAddrで確定済み。
  for (let idx = 0; idx < 11; idx++) w16(idx * 2, slotAddr[idx]);
  w16(0x16, slotAddr[11]); // r_offset
  w16(0x18, toneOff); // tone_ptr

  for (const addr of emptySlotAddrs) rel[addr] = 0x80;

  if (rhythmIndexInfo) {
    // K/R使用時: 索引表(パターン番号順に本体アドレスをLEで書く) + 各パターン本体
    // (`\`系イベント列 + 単独0xff終端) + 常にある8byte領域(0x00固定、上のコメント参照)。
    const { tableAddr, patAddrs, patternLayouts, mysteryAddr } = rhythmIndexInfo;
    patAddrs.forEach((addr, i) => w16(tableAddr + i * 2, addr));
    for (const { events, termAddr } of patternLayouts) {
      for (const ev of events) emitEvent(ev, rel, ev._addr);
      rel[termAddr] = 0xff;
    }
    for (let i = 0; i < 8; i++) rel[mysteryAddr + i] = 0x00;
  } else {
    // r_offset固定領域(8byte、K/R未使用時): 先頭byteは実測どおりの既定値、残り7byteは常に0x00。
    rel[rhythmFixedAddr] = 0x60;
    for (let i = 1; i < 8; i++) rel[rhythmFixedAddr + i] = 0x00;
  }

  for (const letter of Object.keys(trackLayout)) {
    const { events, termAddr } = trackLayout[letter];
    for (const ev of events) emitEvent(ev, rel, ev._addr);
    rel[termAddr] = 0x80;
  }

  toneEntries.forEach((entry, idx) => rel.set(entry, toneOff + idx * 26));
  const toneTermAddr = toneOff + toneEntries.length * 26;
  rel[toneTermAddr] = TONE_TERMINATOR[0];
  rel[toneTermAddr + 1] = TONE_TERMINATOR[1];

  if (memoTail) {
    rel.set(memoTail.bytes, memoTail.endOff - memoTail.bytes.length);
    w16(flagsOff, memoTail.tableOff); // toneptr-4 位置(memoptr)
    rel[flagsOff + 2] = 0x48; // flaglow(常に+2シフト。MC.EXE実測どおり常時この値)
    rel[flagsOff + 3] = 0xfe; // flaghigh(flaglow!=0x40のため常に0xfe必須)
  }

  const file = new Uint8Array(1 + relLen);
  file[0] = opmFlag & 0xff;
  file.set(rel, 1);

  return { file, errors: [], layout: { tracks: trackLayout, toneOff, toneNums } };
}
