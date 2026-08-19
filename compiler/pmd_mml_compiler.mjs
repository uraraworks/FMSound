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

import { buildToneEntry, noteByte, REST_NIBBLE, parseFfFile } from './gen_pmd_min.mjs';
import { parseMml, PART_LETTERS } from './pmd_mml_parser.mjs';
import { encodeCp932 } from './cp932.mjs';

const HEADER_LEN = 0x1a; // 11ポインタ(22) + r_offset(2) + tone_ptr(2)。doc 1.1/1.2節。

// SSG 'P'(トーン/ノイズ出力選択、PMDMML.MAN §6-5)のMML数値(1-3) → 0xed引数byte変換表。
// 2026-08-19、MC.EXE実測(PPTBL.MML、tools/pmd-reference/README.md参照)で確定。
const SSG_TONE_NOISE_VALUE = { 1: 0x07, 2: 0x38, 3: 0x3f };

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
    // 2026-08-18: 数値/%が完全に無指定(isDefault)の場合、参照.M実測(mso_JSM.MML)で
    // MC.EXEが0引数の専用コマンド(0xf4/0xf3、1byte)を出力すると判明した。明示指定時は
    // 従来通り0xe3/0xe2(2byte、値=数値×4または%指定値そのまま)。
    case 'volInc': case 'volDec': return ev.isDefault ? 1 : 2;
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
    // PPZ8初期化(#PPZExtend、v2 2.2節)。0xb4 + 16byte固定引数(PPZ_1〜_8のデータ先頭
    // ポインタ、2byte LE×8。0なら該当chは未使用)。fmdriver_pmd.c:4253-4260実測どおり。
    case 'ppz8Init': return 17;
    // FM3拡張初期化(#FM3Extend、PMDMML.MAN §2-20)。0xc6 + 6byte固定引数(拡張パート
    // 1〜3のトラック先頭ポインタ、2byte LE×3。宣言数が3未満なら残りは0)。
    // 2026-08-19、MC.EXE ver4.8s実測(PFM3B〜PFM3E.MML、パートA(FM1)トラックの先頭に
    // 前置される配置を確定。tools/pmd-reference/README.md参照)。
    case 'fm3Init': return 7;
    case 'detuneExtend': return 2; // DX + 1byte(0xcc、PMDMML.MAN §7-3。実測はpmd_mml_compiler.mjs先頭のコメント参照)
    case 'lfoSpeedExtend': return 2; // MXA=0xca / MXB=0xbb + 1byte(値0-1、PMDMML.MAN §9-5)
    case 'envSpeedExtend': return 2; // EX=0xc9 + 1byte(値0-1、PMDMML.MAN §8-2)
    // バッチ3a追加分。opcodeはupstream/98fmplayer/fmdriver/fmdriver_pmd.cの
    // pmd_cmd_table_fm/ssg配列(0xff起点で逆順に並ぶ関数テーブル)の実インデックスから
    // 特定した(pmd_mml_parser.mjs該当コマンドのコメント参照)。
    case 'fmSlotMask': return 2; // s: 0xcf + 1byte(PMDMML.MAN §6-2)
    case 'ssgToneNoise': return 2; // P: 0xed + 1byte(PMDMML.MAN §6-5)
    case 'ssgEnvOld': return 5; // E書式1: 0xf0 + AL/DD/SR/RR(各1byte、PMDMML.MAN §8-1)
    case 'ssgEnvNew': return 6; // E書式2: 0xcd + AR/DR/SR/(RR|SL詰め)/AL(各1byte、§8-1)
    // バッチ5(2026-08-19、MC.EXE ver4.8s実測)追加分。
    case 'ssgNoiseFreq': return 2; // w: 0xee + 1byte(fmdriver_pmd.c:2686実測、PWL.MML実測)
    case 'pseudoEcho': return 2; // W展開時の分割コマンド: 0xdd(d<0)/0xde(d>0) + 1byte(PW/PW2/PW3.MML実測)

    default: throw new Error(`未知のイベント種別: ${ev.type}`);
  }
}

function signedByte(v) {
  if (v < -128 || v > 127) throw new Error(`符号付き1byteに収まりません: ${v}`);
  return v & 0xff;
}

// 2026-08-18: 隣接する休符イベントの結合。参照.M実測(mso_JSM.MML、FM1パート)で、
// MML本文中に連続して書かれた複数の`r`トークン(例: `r6r22`相当)が、参照.Mでは
// 1個の休符コマンド(0x0f + 合計clock)にまとまって出力されていることを確認した
// (own: 0x0f,0x06,0x0f,0x16(=6+22=28) / ref: 0x0f,0x1c(=28)の1個のみ。他の値でも
// 差分が常に「own側だけ休符が2個に分かれ、clocksの合計がrefの1個と一致する」形で
// 再現した)。休符は音高が無く、結合しても実際の発音(keyon)には影響しないため、
// MC.EXEはコンパイル時にこの結合を行っていると判断できる(ノート同士は結合しない。
// ノートは同じ音高が連続しても毎回keyonが要るため)。ループ境界(0xf7/0xf8/0xf9)や
// 休符以外のイベントを挟んだ場合は結合しない(隣接判定がそこで途切れるため自然に
// 保護される)。合計clocksが1byteの上限(255)を超える場合は結合せず元のまま残す
// (readLengthSpec()側で単独の休符は既に1-255の範囲検査済みのため、この関数が
// 生成する合成後の休符もこの範囲を超えないことを保証する)。
// 2026-08-18: 同音程タイ(`&`)の圧縮。PMDMML.MAN §4-10・§4-9注意1(WebFetch/iconv変換
// した原文)によれば、`&`(タイ)は「直前の音符をkeyoffしない」articulationだが、
// `c2&c2`のように**同じ音程**の音符同士をタイで繋いだ場合、コンパイラは2つの音符を
// 1個の音符(`c1`)へ「圧縮」する(§4-9注意1に`c2&c2 =4`が「直前の音符がc1と圧縮
// されるため」エラーになる、という記述がある。つまり圧縮は`l=`より前の時点で
// 既に起きている)。実データ参照.M実測(mso_JSM.MML FM1パート)でも、own側だけ
// 0x40(note),0x0c(len12),0xfb(タイ),0x40(note),0x8e(len142)の4byteに対し、
// 参照.M側は0x40(note),0x9a(len154=12+142)の1個の音符にまとまっていることを確認した。
// 一方、異なる音程同士のタイ(ポルタメント等)はfmdriver_pmd.c由来の0xfbコマンド
// (docs/pmd-compiler-spec.md 165行目、「直前ノートのkeyoffを抑止」)がそのまま必要
// なため、同音程の場合のみ圧縮し、異音程の場合は従来通りtie(0xfb)+次ノートを出力する。
// 2026-08-19追記: 同音程タイが3個以上連なる長い連結(合計clocksが255を超える)の場合の
// 再分割規則。実データ実測(MSO_ET_Virtual_Intensity_88.MML パートE(FM5)の
// `c1&c1&c2.`、合計clocks=96+96+72=264)で判明: 旧実装は「隣接ペアを255以下なら
// その場で1個に圧縮する」貪欲法だったため、まず96+96=192を1個にまとめ、残り72を
// 別ノードのまま出力していた(own: 192,tie,72)。しかし参照.Mは255,tie,9(own: c0 40 /
// 参照: ff 40 09、いずれも合計264)だった。つまりMC.EXEは元のノート境界を無視して
// **連結全体の合計clocksをいったんプールし、255ずつ貪欲に再分割する**
// (255を1byteの上限いっぱいまず取り、余りを最後に残す)。パートF(FM6)・パートH(SSG2)
// でも同型の差分(288=255+33)を確認済み。
function mergeSamePitchTies(events) {
  const merged = [];
  let i = 0;
  while (i < events.length) {
    const ev = events[i];
    if (ev.type === 'note') {
      // 同音程タイで連結している限り先読みし、連結全体の合計clocksを求める。
      let j = i;
      let total = ev.clocks;
      while (j + 2 < events.length && events[j + 1].type === 'tie' && events[j + 2].type === 'note'
          && events[j + 2].octave === ev.octave && events[j + 2].noteIndex === ev.noteIndex) {
        total += events[j + 2].clocks;
        j += 2;
      }
      if (j === i) {
        merged.push({ ...ev });
        i++;
        continue;
      }
      // 255ずつ貪欲に再分割(255,255,...,余り)、間はtieで接続。
      let remaining = total;
      while (remaining > 0) {
        const chunk = Math.min(remaining, 255);
        merged.push({ type: 'note', line: ev.line, octave: ev.octave, noteIndex: ev.noteIndex, clocks: chunk });
        remaining -= chunk;
        if (remaining > 0) merged.push({ type: 'tie', line: ev.line });
      }
      i = j + 1;
      continue;
    }
    merged.push(ev.type === 'note' ? { ...ev } : ev);
    i++;
  }
  return merged;
}

// 2026-08-19追記: mergeSamePitchTiesと同じ理由(実データMSO_ET_Virtual_Intensity_88.MML
// パートF(FM6)「FH l16 @183o5*1 r1 r1 r1 >g1<」、連続する休符r1×3=96+96+96=288)で、
// 隣接休符の結合も「貪欲ペア結合」ではなく「連結全体の合計をプールし255ずつ貪欲に
// 再分割する」規則に統一する(own旧実装: 192,96の2個 / 参照.M: 255,33の2個。
// パートH(SSG2)でも同型を確認済み)。
function mergeAdjacentRests(events) {
  const merged = [];
  let i = 0;
  while (i < events.length) {
    const ev = events[i];
    if (ev.type === 'rest') {
      let j = i;
      let total = ev.clocks;
      while (j + 1 < events.length && events[j + 1].type === 'rest') {
        total += events[j + 1].clocks;
        j++;
      }
      let remaining = total;
      while (remaining > 0) {
        const chunk = Math.min(remaining, 255);
        merged.push({ type: 'rest', line: ev.line, octave: ev.octave, clocks: chunk });
        remaining -= chunk;
      }
      i = j + 1;
      continue;
    }
    merged.push(ev);
    i++;
  }
  return merged;
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
      // 2026-08-18: 参照.M実測(mso_JSM.MML、休符が0x0f=オクターブ0固定で出ていた。
      // 旧実装はev.octave(現在のオクターブ状態)をそのまま上位nibbleに使っていたが、
      // 休符には音高が無いのでMC.EXEは常にオクターブnibble=0で出力する)。
      out[offset] = noteByte(0, REST_NIBBLE);
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
      // カウンタ初期値: 2026-08-18、実データ3曲(JSM/YD、リポジトリ非同梱)の全ループ
      // 73件(JSM 54件+YD 19件、`node`で機械抽出・全数照合済み)を実測し、以下の規則を
      // 確定した:
      //   このループ(`[`...`]n`)の中に脱出マーカ`:`が1つでもあれば counter初期値=n-1、
      //   無ければ counter初期値=n。
      // ネストの深さ・パート種別(FM/SSG/ADPCM/RHYTHM)・countの値によらず一貫しており、
      // 73件全て(ネスト有り含む)がこの規則だけで説明できた(片方に合わせて他方が壊れる
      // ケースは無し)。以前「pmdnestではn、実データではn-1」に見えていた食い違いは、
      // pmdnestのループが`:`を含まない(n)ケースしか無かったための見かけ上の矛盾で、
      // 規則自体に矛盾は無かった。
      out[offset + 2] = (ev.openRef && ev.openRef.hasExit ? ev.count - 1 : ev.count) & 0xff;
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
      // isDefault(数値/%無指定、常に値4相当)の場合は0引数の専用コマンド0xf4
      // (fmdriver_pmd.c:2526-2572、pmd_cmdf4_volinc_fm)を出力する(上のsizeOfEvent参照)。
      if (ev.isDefault) { out[offset] = 0xf4; return; }
      out[offset] = 0xe3;
      out[offset + 1] = ev.value & 0xff;
      return;
    case 'volDec': // 音量相対変化・減算(v2 3.1節)
      if (ev.isDefault) { out[offset] = 0xf3; return; }
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
    case 'ppz8Init': // PPZ8初期化(v2 2.2節。0xb4 + PPZ_1〜_8ポインタ16byte、0=未使用)
      out[offset] = 0xb4;
      for (let k = 0; k < 8; k++) w16(offset + 1 + k * 2, ev.ptrs[k] & 0xffff);
      return;
    case 'fm3Init': // FM3拡張初期化(#FM3Extend、PMDMML.MAN §2-20)。0xc6 + 拡張パート1〜3
      // のトラック先頭ポインタ6byte(2byte LE×3、0=未宣言)。2026-08-19 MC.EXE実測で確定。
      out[offset] = 0xc6;
      for (let k = 0; k < 3; k++) w16(offset + 1 + k * 2, (ev.ptrs[k] ?? 0) & 0xffff);
      return;
    case 'detuneExtend': // SSG音源音程補正指定(PMDMML.MAN §7-3。0xcc + 1byte、値0-1)
      out[offset] = 0xcc;
      out[offset + 1] = ev.value & 0xff;
      return;
    case 'lfoSpeedExtend': // ソフトウエアLFO速度設定(PMDMML.MAN §9-5。MXA=0xca/MXB=0xbb + 1byte)
      out[offset] = ev.target === 'B' ? 0xbb : 0xca;
      out[offset + 1] = ev.value & 0xff;
      return;
    case 'envSpeedExtend': // ソフトウエアエンベロープ速度設定(PMDMML.MAN §8-2。0xc9 + 1byte、値0-1)
      out[offset] = 0xc9;
      out[offset + 1] = ev.value & 0xff;
      return;
    case 'fmSlotMask': // FM音源使用スロット位置指定(PMDMML.MAN §6-2。0xcf + 1byte)
      // 2026-08-19実データ実測(MSO_FM_FS_PPZ.MML「C @4 s3」): 引数はMMLの数値(0-15)を
      // そのまま書くのではなく**上位4bitへシフトした値**(digit<<4)を書く
      // (own旧実装0x03、参照0x30)。fmdriver_pmd.c:pmd_cmdcf_slotmaskは読んだbyteの
      // 下位4bitが非0なら`data<<4`をfm_slotoutへ入れる分岐を持つが、.M側は
      // 既にシフト済みの値を格納する(=実行時の下位4bit判定は常に0になり通らない
      // ように見えるが、.Mバイト列の再現が目的なのでMC.EXEの出力どおりに合わせる)。
      out[offset] = 0xcf;
      out[offset + 1] = (ev.value << 4) & 0xff;
      return;
    case 'ssgToneNoise': // SSG/OPM トーン・ノイズ出力選択(PMDMML.MAN §6-5。0xed + 1byte)。
      // 引数は音源ミックスレジスタ(YM2149 0x07相当)へそのまま渡すビットマスクで、
      // MMLの数値(1/2/3)とは非線形の対応。2026-08-19、MC.EXE実測(PPTBL.MML)で確定:
      // P1(トーン)→0x07, P2(ノイズ)→0x38, P3(両方)→0x3f(=0x07|0x38、ビットOR)。
      out[offset] = 0xed;
      out[offset + 1] = SSG_TONE_NOISE_VALUE[ev.value];
      return;
    case 'ssgEnvOld': // SSG/PCMソフトウエアエンベロープ・書式1(PMDMML.MAN §8-1。
      // 0xf0 + AL(1byte)/DD(1byte符号付き)/SR(1byte)/RR(1byte)、
      // fmdriver_pmd.c:2650 pmd_cmdf0_env_old実測どおりの並び)
      out[offset] = 0xf0;
      out[offset + 1] = ev.al & 0xff;
      out[offset + 2] = signedByte(ev.dd);
      out[offset + 3] = ev.sr & 0xff;
      out[offset + 4] = ev.rr & 0xff;
      return;
    case 'ssgEnvNew': // SSG/PCMソフトウエアエンベロープ・書式2(PMDMML.MAN §8-1。
      // 0xcd + AR&0x1f/DR&0x1f/SR&0x1f/((SL^0xf)<<4|RR&0xf)/AL&0xf、
      // fmdriver_pmd.c:3410 pmd_cmdcd_env_new実測どおりの詰め方)
      out[offset] = 0xcd;
      out[offset + 1] = ev.ar & 0x1f;
      out[offset + 2] = ev.dr & 0x1f;
      out[offset + 3] = ev.sr & 0x1f;
      out[offset + 4] = (((ev.sl ^ 0xf) & 0xf) << 4) | (ev.rr & 0xf);
      out[offset + 5] = ev.al & 0xf;
      return;
    case 'ssgNoiseFreq': // SSGノイズ周波数(fmdriver_pmd.c:2686実測。0xee + 1byte)
      out[offset] = 0xee;
      out[offset + 1] = ev.value & 0xff;
      return;
    case 'pseudoEcho': // W(擬似エコー)展開時の分割コマンド(PW/PW2/PW3.MML実測。
      // 0xdd(d<0)/0xde(d>0) + 1byte(min(|d|*k,15)*4))
      out[offset] = ev.sign < 0 ? 0xdd : 0xde;
      out[offset + 1] = ev.value & 0xff;
      return;
    default:
      throw new Error(`未知のイベント種別: ${ev.type}`);
  }
}

// トラック1本分(ループ展開込み)の総クロック数を計算する。
// r_offset固定領域(8byte、K/R未使用時)の先頭byteが「全パート中で最長のパートの
// 総クロック数(下位8bit)」であることが判明した(下のcomputeLongestPartTicksのコメント参照)。
// その"総クロック数"の定義はここで確定した内容:
//   - note/rest/portamento の`clocks`をそのまま加算する。
//   - ループ(`[`...`]n`、`:`で脱出区間を分ける)は、実際に鳴る回数ぶん展開して数える。
//     `:`が無ければ本体(before)をn回。`:`があれば「最終回(n回目)だけ`:`以降(after)を
//     再生せず抜ける」ため、before×n + after×(n-1)になる
//     (fmdriver_pmd.c由来の0xf7 ':' の実行時挙動「最終回のみ':'~']'区間をスキップして
//     ']'の直後へ脱出する」通り。tools/pmd-reference/pmdloopx.mml(4パート、ネスト2重・
//     単純ループ両方を含む)で実測し、この式でのみ全パート一致することを確認済み)。
//   - ネストしたループは、内側の展開後クロック数を外側の1イベント分として加算する。
function trackTotalTicks(events) {
  const stack = [];
  let cur = { before: 0, after: 0, sawExit: false };
  for (const ev of events) {
    if (ev.type === 'loopOpen') {
      stack.push(cur);
      cur = { before: 0, after: 0, sawExit: false };
      continue;
    }
    if (ev.type === 'loopExit') {
      cur.sawExit = true;
      continue;
    }
    if (ev.type === 'loopClose') {
      const n = ev.count;
      const total = cur.sawExit ? (cur.before * n + cur.after * (n - 1)) : (cur.before * n);
      const parent = stack.pop();
      // ネストしたループの展開後クロック数を親へ加算する際も、他の生イベント(note/rest/
      // portamento)と同じく「親がすでに`:`(exit)を通過済みならafter側」というルールに
      // 従う必要がある。従来は無条件にparent.beforeへ加算しており、「外側ループの`:`より
      // 後ろに、さらに別のループ([...]n)が続く」構造(2026-08-19、実データ
      // MSO_OF_Into_the_Palace_N.mmlのFパート等で実測)で総クロック数を過大に計算していた
      // (r_offset固定領域8byteの実測値と食い違うことから発見)。
      if (parent.sawExit) parent.after += total; else parent.before += total;
      cur = parent;
      continue;
    }
    let clocks = 0;
    if (ev.type === 'note' || ev.type === 'rest' || ev.type === 'portamento') clocks = ev.clocks;
    if (cur.sawExit) cur.after += clocks; else cur.before += clocks;
  }
  return cur.before;
}

// 全パート(FM1-6/SSG1-3/ADPCM、および#PPZExtendで宣言されたPPZ8パート)のうち、
// 最も総クロック数が長いパートの値を返す(K/Rパート自体はここでは見ない。
// K/R使用時はr_offset固定領域が別構造(索引表)になり、この値の出番が無いため)。
//
// 2026-08-19実測(tools/pmd-reference/README.md「既知の差分」参照): 新規9ケース
// (pmddt/pmdsl/pmdsl2/pmdefm/pmdnoise/pmdwecho/pmdwecho2/pmdwecho3/pmdmpover)は
// いずれもファイル長・他バイトが完全一致し、r_offset固定領域の先頭byteだけが
// 自作(固定値0x60=96)と参照で食い違っていた(参照は0x18=24または0x30=48)。
// 各ケースの「最長パートの総クロック数」を数えたところ参照値と一致し
// (l4の1音=24、o4l2/l4cd/l4c+l4d=48等)、既存corpus(pmdtone等)が偶然96クロックに
// そろっていたため無症状だっただけと判明した。全corpus(43ケース、pmd-reference/*.mml)
// を突き合わせ、K/R使用の3ケース(pmdrhbit/pmdrhpan/pmdunimp、r_offsetが別構造になる
// ため対象外)を除く全40ケースでこの定義が成立することを確認済み
// (pmdwhole.mmlは対象外の既存differenceがあるため元々100%不一致で対照外)。
function computeLongestPartTicks(tracks, header) {
  const letters = [
    ...PART_LETTERS,
    ...(header.ppzExtend ? header.ppzExtend.split('') : []),
    ...(header.fm3Extend ? header.fm3Extend.split('') : []),
  ];
  let max = 0;
  for (const letter of letters) {
    const raw = tracks.get(letter);
    if (!raw || raw.length === 0) continue;
    const ticks = trackTotalTicks(raw);
    if (ticks > max) max = ticks;
  }
  return max;
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
//
// 2026-08-19追記(PRRDEF/PRR96/PRR192/PRRL8/PRRL8B.MML実測): 当初「0xffの直後に
// 総クロック数1byteが続く」と誤読しかけたが、実際はその1byteは各パターン自身の
// 終端ではなく、**全パターン共通の「常にある8byte領域」(下のmysteryAddr)の先頭byte**
// だった(pmdunimp.Mでは全パターンがクロック0のため0x00に見え、この領域の意味に
// 気づけていなかった)。パターン自体の終端は引き続き0xff単独1byteのまま。
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
// ffFile: `#FFFile`で読み込む外部音色ファイルの生バイト列(8192byte固定、Uint8Array/Buffer)。
//   2026-08-18、実機MC.EXE(/VWオプション)で自作音色を実測して確定したフォーマット
//   (parseFfFile()のコメント参照)でデコードし、**MML本文(またはtonesオプション)に
//   定義が無い音色番号のみ**を補う(優先順位はMC.DOC「FM音源の音色データの扱いについて」・
//   PMDMML.MAN §2-4の記述通り「本文優先、FFFileは本文で未定義の番号のみ使われる」で、
//   自作MML+実機再コンパイルの突き合わせでも実測確認済み)。本文で定義済みの番号は
//   ffFileに同じ番号があっても無視する(本文が勝つ)。
//   ffFileが渡されない場合、本文にもtonesオプションにも無い@nは従来通りエラーにする
//   (2026-08-18に直した「音色未使用時に既定音色を勝手に合成していた」不具合の再発防止。
//   ffFileが無い状態で黙って既定音色を補うことはしない)。
// 戻り値: { file, errors, layout } (errorsが空でない場合 file は null)。
// layout には検証スクリプトが使う各トラックの先頭アドレス・終端アドレス・
// イベント列(アドレス付き)・使用した音色テーブル(tones)を含む。
export function compileMml(source, { tones, ffFile, opmFlag = 0 } = {}) {
  const { tracks, tones: parsedTones, header, rhythmPatterns, errors: parseErrors } = parseMml(source);
  if (parseErrors.length > 0) return { file: null, errors: parseErrors, layout: null };

  // #FM3Extend(FM3ch拡張パート、PMDMML.MAN §2-20)。.M側の出力(upstream/98fmplayer/
  // fmdriver/fmdriver_pmd.c:3554 pmd_cmdc6_fm3ex_initが読む、3スロット×2byteポインタの
  // 0xc6コマンド)の配置は、2026-08-19 WebNP2+MC.EXE ver4.8s実測(PFM3A〜PFM3E.MML、
  // tools/pmd-reference/README.md参照)で確定した:
  //   - 0xc6 + 3スロット分のポインタ(拡張パートの実体位置、宣言数が3未満なら残り0)を
  //     **パートA(FM1)のトラック先頭に前置**する(下のidx===0の特別処理)。
  //   - 拡張パート自身のトラック本体は、#PPZExtendのPPZ8パートと同じ位置
  //     (RHYTHMスロット(idx===10)の直後・r_offsetの手前)に置く。宣言だけして
  //     本文で使わない場合も、他パートと同様に空トラック(0x80のみ)を実体として置く
  //     (下のidx===10の特別処理。#PPZExtendと同時に使われる場合、実データ
  //     MSO_FM_FS_PPZ.MMLの参照.M実測でFM3Extendパート群→PPZ8パート群の順に
  //     並ぶことを確認済みのため、既存のppzExtend配置ブロックより前に置く)。
  const toneTable = {};
  for (const [tn, opts] of parsedTones) toneTable[tn] = opts;
  if (tones) Object.assign(toneTable, tones); // 明示指定があれば本文中の定義より優先(後方互換)

  // FMパート(A-F=FM1-6)だけがFM音色テーブルを参照する。PMDMML.MAN §6-1-2/§6-1-3/
  // §6-1-5実測(2026-08-18、実データJSM(mso_JSM.MML)をJSM/SS_TENGの参照.Mと突き合わせ):
  // G-I(SSG1-3)の`@n`は内蔵SSGソフトウエアエンベロープ(0-9)、J(ADPCM)の`@n`は
  // PCM音色番号を選ぶだけで、いずれもFM音色テーブルの26byteエントリとは無関係。
  // 混同すると出力トーンテーブルに不要なエントリが混入する(実測: mso_JSM.MMLで
  // 自作が23件・参照.Mが9件、差14件×26byte=364byteがトーンテーブル領域の
  // サイズ差そのものと一致)。
  const FM_PART_LETTERS = new Set(PART_LETTERS.slice(0, 6));
  const fmUsedToneNums = new Set();
  for (const [part, events] of tracks) {
    if (!FM_PART_LETTERS.has(part)) continue;
    for (const ev of events) {
      if (ev.type === 'tone') fmUsedToneNums.add(ev.tonenum);
    }
  }

  // ffFile: 本文(+tonesオプション)で未定義の番号だけを埋める(本文が勝つ。上のコメント参照)。
  // 実際にFMパートの@nイベントで参照されている番号だけを補う(未参照の番号まで256件丸ごと
  // toneTableへ入れると、使っていない音色まで出力トーンテーブルに現れてしまうため。
  // SSG/ADPCMパートの@n参照はFM音色テーブルと無関係なので補わない、上のコメント参照)。
  if (ffFile) {
    const ffTones = parseFfFile(ffFile);
    for (const tn of fmUsedToneNums) {
      if (!(tn in toneTable) && tn in ffTones) toneTable[tn] = ffTones[tn];
    }
  }

  // hasExplicitTones: 出力(トーンテーブル)を決めるためのフラグ。既定音色を合成する
  // *前*の時点(=利用者が実際に@n定義かtonesオプション/ffFileで解決した音色を
  // 持っているかどうか)で確定させる。
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
  // FMパートで使われている音色番号がすべて toneTable に存在するか検査。
  // SSG(G-I)/ADPCM(J)の`@n`はFM音色テーブルと無関係(上のfmUsedToneNums算出時の
  // コメント参照)なので、この検査の対象外(この検査が無いだけで、trackのバイト列
  // 生成側は@nイベントの値をtoneTableの有無に関係なくそのまま書き出す。詳細は
  // 下のcodeGenSize/encodeEvent相当の'tone'ケース参照。値の範囲検査(SSGは0-9等)は
  // 未実装、範囲外の値もそのまま出力する)。
  for (const [part, events] of tracks) {
    if (!FM_PART_LETTERS.has(part)) continue;
    for (const ev of events) {
      if (ev.type === 'tone' && !(ev.tonenum in toneTable)) {
        errors.push({ line: ev.line, message: `パート${part}: 音色番号 @${ev.tonenum} が定義されていません(本文中の音色定義、tonesオプション、ffFileオプションのいずれにも無い)` });
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
  // #PPZExtend(v2 2.1/2.2節)。宣言済みなら、ADPCM(J、idx9)の先頭に0xb4(PPZ8初期化、
  // 16byte引数=PPZ_1〜_8のデータ先頭ポインタ)を埋め込む。実測(下記idx===10直後の
  // ブロックのコメント参照)により、実機はPPZ8のトラック本体を「RHYTHMスロット(idx10)の
  // 直後・r_offset(idx11)の手前」に置く。しかしJのバイト内容(0xb4の16byte引数)は
  // そのPPZ8トラック群のアドレスに依存するため、idx9の時点ではJの**サイズ**
  // (0xb4+16byteは常に固定17byteなので、アドレスの値が未確定でもサイズは確定できる)
  // だけ先に確保し、ptrsは後段(idx10直後)で確定してから同じイベントオブジェクトへ
  // 書き戻す(sizeOfEventはptrsの値を見ないため、後から書き換えてもレイアウト全体の
  // アドレスには影響しない)。
  const ppzExtendLetters = header.ppzExtendLetters ?? [];
  // #FM3Extend(PMDMML.MAN §2-20)の宣言済み拡張パート文字(最大3文字、宣言順)。
  const fm3ExtendLetters = header.fm3ExtendLetters ?? [];
  // #Detune Extend(PMDMML.MAN §2-16)の対象パート。SSG(G,H,I)のみ(A-F/Jには効かない。
  // 実測: pmdhdrxt.M参照。下のSLOT_LETTERSループ内コメント参照)。PPZExtend/FM3Extendの
  // 拡張パートでの挙動は未実測(実データALPHA/SSTENG/MSOFMFSのいずれも#Detune Extendを
  // 宣言していても拡張パートの先頭にdetuneExtendコマンドは現れなかったので、対象外のまま
  // で問題ない)。
  const DETUNE_EXTEND_LETTERS = new Set(['G', 'H', 'I']);
  // #LFOSpeed Extend(PMDMML.MAN §2-17)の対象パート。FM/SSG/ADPCM(A〜J)全部
  // (実測: PMDLFOXT.MML、A〜J全10パートが未使用でも各+4byte増加を確認)。
  // 2026-08-19: PPZExtend(a-h)・FM3Extend(x,y,z等)の拡張パートにも同様に適用される
  // (実データALPHA/SSTENG/MSOFMFS実測: 各PPZ8拡張パート・FM3拡張パートの先頭に
  // `ca 01 bb 01`(target A/Bのlfo_speed_extend)が漏れなく出ており、既存実装は
  // これを一切出力していなかった。ALPHA/SSTENGの「拡張パート1本あたり6byte不足」の
  // 正体はこの欠落+PPZ拡張のみ追加で出るenvSpeedExtend(下記)だった)。
  const LFO_SPEED_EXTEND_LETTERS = new Set([...PART_LETTERS, ...ppzExtendLetters, ...fm3ExtendLetters]);
  // #EnvelopeSpeed Extend(PMDMML.MAN §2-18)の対象パート。SSG/PCM(G〜J)のみ
  // (実測: PMDENVXT.MML、G〜Jのみ未使用でも各+2byte増加、A〜Fは無変化を確認)。
  // 2026-08-19: PPZExtend(a-h、J=ADPCMと同じPCM系)にも適用される(実データ実測、
  // 上のLFO_SPEED_EXTEND_LETTERSのコメント参照)。FM3Extend(x,y,z等)はFM系(A-F)と
  // 同様に対象外(実データMSOFMFS実測: FM3拡張パートの先頭は`ca 01 bb 01`のみで
  // envSpeedExtend(`c9 01`)は出ない)。
  const ENV_SPEED_EXTEND_LETTERS = new Set(['G', 'H', 'I', 'J', ...ppzExtendLetters]);
  // 3つのExtendヘッダを同時に使うパート(実データSS_TENGで実際に発生する: G〜Iは
  // Detune+LFOSpeed+EnvelopeSpeed、JはLFOSpeed+EnvelopeSpeed+PPZExtendが重なる)での
  // 並び順を実機参照.Mで確定した(COMBOG.MML/COMBOJ.MML実測、
  // docs/pmd-compiler-spec-v2.md参照): DX(detune) → EX(envSpeed) → MXA,MXB(lfoSpeed)
  // の順で頭に並ぶ。PPZExtend(0xb4のppz8Init)がある場合はさらにその前(先頭)に来る。
  function buildExtendPrefixEvents(letter) {
    const prefix = [];
    if (DETUNE_EXTEND_LETTERS.has(letter) && header.detuneExtend === 'Extend') {
      prefix.push({ type: 'detuneExtend', line: header.detuneExtendLine ?? 1, value: 1 });
    }
    if (ENV_SPEED_EXTEND_LETTERS.has(letter) && header.envSpeedExtend === 'Extend') {
      prefix.push({ type: 'envSpeedExtend', line: header.envSpeedExtendLine ?? 1, value: 1 });
    }
    if (LFO_SPEED_EXTEND_LETTERS.has(letter) && header.lfoSpeedExtend === 'Extend') {
      prefix.push({ type: 'lfoSpeedExtend', line: header.lfoSpeedExtendLine ?? 1, target: 'A', value: 1 });
      prefix.push({ type: 'lfoSpeedExtend', line: header.lfoSpeedExtendLine ?? 1, target: 'B', value: 1 });
    }
    return prefix;
  }
  let ppz8InitEvent = null; // idx===9で確保、idx===10直後で.ptrsを確定させる
  let fm3InitEvent = null; // idx===0で確保、idx===10直後で.ptrsを確定させる
  let cursor = HEADER_LEN;
  const trackLayout = {}; // partLetter -> {startAddr, termAddr, events}
  const slotAddr = new Array(SLOT_LETTERS.length); // 各スロットがヘッダに書き込むポインタ値
  const emptySlotAddrs = []; // 未使用スロットの終端バイト(0x80)を書き込むアドレス
  let rhythmFixedAddr = null; // r_offset固定領域(8byte、K/R未使用時)の先頭アドレス
  let rhythmIndexInfo = null; // K/R使用時: {tableAddr, patAddrs, patternLayouts, mysteryAddr}
  for (let idx = 0; idx < SLOT_LETTERS.length; idx++) {
    const letter = SLOT_LETTERS[idx];
    if (idx === 0 && fm3ExtendLetters.length > 0) {
      // パートA(FM1): 0xc6(FM3拡張初期化)をパート先頭に置き、Aが実際に使われていれば
      // その直後にA自身のトラック本体を続ける(2026-08-19実測、PFM3E.MML「A有り」ケースで
      // A自身のイベント(cd)がc6ブロックの直後に現れることを確認済み)。ポインタ(ptrs)は
      // idx===9のppz8Initと同様、拡張パート本体のアドレスが確定するidx===10直後で書き戻す。
      fm3InitEvent = { type: 'fm3Init', line: header.fm3ExtendLine ?? 1, ptrs: [0, 0, 0] };
      const aRaw = tracks.get('A');
      const aEvents = aRaw ? mergeAdjacentRests(mergeSamePitchTies(aRaw)) : [];
      // #LFOSpeed Extendとの同時使用順は未実測だが、#PPZExtend+J(0xb4が最初、Extendは後)の
      // 既存規則に倣い、0xc6を最初に置く(このコメント冒頭の設計上の余地の範囲内)。
      const combinedEvents = [fm3InitEvent, ...buildExtendPrefixEvents('A'), ...aEvents];
      const startAddr = cursor;
      const { endAddr, termAddr } = layoutTrack(combinedEvents, startAddr);
      trackLayout.A = { startAddr, termAddr, events: combinedEvents };
      slotAddr[idx] = startAddr;
      cursor = endAddr;
      continue;
    }
    if (idx === 9 && ppzExtendLetters.length > 0) {
      // ADPCM(J): 0xb4(PPZ8初期化)をパート先頭に置き、Jが実際に使われていればその
      // トラック本体を続ける(fmdriver_pmd.c:4249、ADPCMパートの拡張コマンドとしてのみ
      // 機能する。「どこに置くか」はコンパイラの自由、docs/pmd-compiler-spec-v2.md 2.2節)。
      ppz8InitEvent = { type: 'ppz8Init', line: header.ppzExtendLine ?? 1, ptrs: new Array(8).fill(0) };
      const jRaw = tracks.get('J');
      const jEvents = jRaw ? mergeAdjacentRests(mergeSamePitchTies(jRaw)) : [];
      // #LFOSpeed/#EnvelopeSpeed Extend と #PPZExtend が同時に使われる場合の並び順
      // (実測: COMBOJ.MML、docs/pmd-compiler-spec-v2.md参照): ppz8Init(0xb4)が最初、
      // その後にEX/MXA/MXBが続く(Detuneは対象外レターのためJには付かない)。
      const combinedEvents = [ppz8InitEvent, ...buildExtendPrefixEvents('J'), ...jEvents];
      const startAddr = cursor;
      const { endAddr, termAddr } = layoutTrack(combinedEvents, startAddr);
      trackLayout.J = { startAddr, termAddr, events: combinedEvents };
      slotAddr[idx] = startAddr;
      cursor = endAddr;
      continue;
    }
    // 2026-08-18(K/R実装): Kパートは他パートと同じ「実トラック」として扱う
    // (letter!=='K'の除外を撤廃。中身は tokenizeRhythmKBody が作るrhSelect/loop/
    // \系イベント列で、layoutTrack/emitEventは通常パートと同じ経路をそのまま使える。
    // 終端も他パートと同じ0x80、pmdunimp.M実測で確認済み)。
    const rawEvents = letter ? tracks.get(letter) : null;
    let events = rawEvents ? mergeAdjacentRests(mergeSamePitchTies(rawEvents)) : null;
    // #Detune/#LFOSpeed/#EnvelopeSpeed Extend(PMDMML.MAN §2-16/§2-17/§2-18)。対象
    // パートの頭全てに等価コマンド(DX1/EX1/MXA1 MXB1)を指定したのと同じ効果
    // (マニュアル記載通り)。パートが未使用でも、その事実自体は変わらず「頭に置く」
    // ため、prefixイベントだけの新規トラックとして生成する(実測: pmdhdrxt.M/
    // PMDLFOXT.MML/PMDENVXT.MML、いずれも未使用パートでも増分することを確認済み)。
    // 3つ同時に有効な場合の並び順はDX→EX→MXA,MXBで固定(COMBOG.MML実測)。
    const extendPrefix = letter ? buildExtendPrefixEvents(letter) : [];
    if (extendPrefix.length > 0) {
      events = events ? [...extendPrefix, ...events] : extendPrefix;
    }
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

    // PPZ8拡張パート(#PPZExtend、v2 2.1/2.2節)のトラック本体は、RHYTHMスロット
    // (idx===10、Kパート)の直後・r_offset(idx===11)の手前に置く。
    // 2026-08-18、自作corpus(tools/pmd-reference/pmdppzord.mml「#PPZExtend cba」・
    // pmdppzsub.mml「#PPZExtend edc」・pmdppznote.mml、いずれもMC.EXE /V ver4.8s実測)で、
    // 実機の出力ヘッダがちょうどこの位置([ADPCM(0xb4付き)]→[RHYTHM]→[PPZ8トラック群]
    // →[r_offset])になっていることを確認して、当初「末尾にまとめて追加」としていた
    // 配置を訂正した(末尾配置だと自作出力のADPCM/RHYTHM/r_offsetの各ポインタが
    // 参照.Mと2byteどころか大きくずれ、pmdunimp.M等の既存K/R使用ケースとも整合しない
    // ことが実測で判明したため)。
    //   - パート記号とPPZ_1〜_8の対応=「#PPZExtendでの宣言順」であることは、同じ実測で
    //     確定した: pmdppzord.mml「#PPZExtend cba」の3トラック(c/b/a、vol=v10/v11/v12で
    //     互いに非対称)が、0xb4引数の1番目/2番目/3番目のポインタ先にそれぞれ
    //     ちょうどこの順で現れた(宣言順1番目のcがPPZ_1)。pmdppzsub.mml「#PPZExtend edc」
    //     (e/d/c、vol=v9/v13/v7)でも同様にe→PPZ_1,d→PPZ_2,c→PPZ_3の順で確認し、
    //     「宣言順」説と「記号自体の固定値」説を切り分けた(後者なら両ファイルで
    //     結果が食い違うはずだが、両方とも宣言順どおりだった。docs/pmd-compiler-spec-v2.md
    //     2.1節参照)。実データSS_TENGの「#PPZExtend abcdef」(a,bのみ使用、a→PPZ_1,
    //     b→PPZ_2)もこの規則と矛盾しない。
    //   - 0xb4の配置場所(ADPCM先頭)は、fmdriver_pmd.c:4249 pmd_cmdb4_ppz8_initが
    //     ADPCMパートの拡張コマンドとしてのみ機能すること(tools/verify_pmd_ppz8_used_columns.mjs
    //     のコメント参照)から導いた。ADPCM(J)が実際に使われている場合は、その
    //     トラック本体の直前に0xb4を1回だけ挟む(この組み合わせ自体は未実測だが、
    //     spec 2.2節の「どこに置くかはコンパイラの自由」という設計上の余地の範囲内)。
    //   - 宣言されたが本文で一度も使われない文字は、他の未使用パートと同様に1byteの
    //     終端(0x80)だけを指すプレースホルダとして扱う(ptrはnonzero、実データSS_TENGの
    //     未使用c-fパートも同様にnonzeroポインタを持つことを確認済み)。
    //   - 8個を超えるスロット(宣言数より後ろ)は0のまま=未使用スキップ(fmdriver_pmd.c:4256
    //     `if(!ptr) continue`)。
    if (idx === 10 && fm3ExtendLetters.length > 0) {
      // FM3拡張パート(#FM3Extend)のトラック本体。#PPZExtendと同じ位置(RHYTHMスロット
      // 直後・r_offsetの手前)に、宣言順で並べる。実データMSO_FM_FS_PPZ.MMLの参照.M実測
      // (#PPZExtend abcdefgh + #FM3Extend xy、両方を同時宣言)で、FM3Extendパート(x,y)が
      // PPZ8パート(a-h)より**前**に置かれることを確認したため、ppzExtendの配置ブロックより
      // 前に置く。宣言だけで本文未使用の文字も、他の未使用パートと同様に1byteの終端(0x80)
      // だけを指すプレースホルダとして扱う(2026-08-19実測、PFM3D.MML「decl only」ケース)。
      const fm3Addrs = [0, 0, 0];
      for (let k = 0; k < fm3ExtendLetters.length && k < 3; k++) {
        const fm3Letter = fm3ExtendLetters[k];
        const rawEvents = tracks.get(fm3Letter);
        const bodyEvents = rawEvents ? mergeAdjacentRests(mergeSamePitchTies(rawEvents)) : [];
        // FM3拡張パートもLFOSpeed Extend(#LFOSpeed Extend、FM系パートA-Fと同じ扱い)の
        // 対象(2026-08-19実測、上のLFO_SPEED_EXTEND_LETTERSのコメント参照)。宣言だけで
        // 本文未使用でも、他のExtend同様プレフィクスだけのトラックとして出力する
        // (実データMSOFMFS実測、未使用のFM3拡張パートでも`ca 01 bb 01 80`が出ることを確認)。
        const events = [...buildExtendPrefixEvents(fm3Letter), ...bodyEvents];
        if (events.length > 0) {
          const startAddr = cursor;
          const { endAddr, termAddr } = layoutTrack(events, startAddr);
          trackLayout[fm3Letter] = { startAddr, termAddr, events };
          fm3Addrs[k] = startAddr;
          cursor = endAddr;
        } else {
          fm3Addrs[k] = cursor;
          emptySlotAddrs.push(cursor);
          cursor += 1;
        }
      }
      if (fm3InitEvent) fm3InitEvent.ptrs = fm3Addrs;
    }
    if (idx === 10 && ppzExtendLetters.length > 0) {
      const ppzAddrs = new Array(8).fill(0);
      for (let k = 0; k < ppzExtendLetters.length; k++) {
        const ppzLetter = ppzExtendLetters[k];
        const rawEvents = tracks.get(ppzLetter);
        const bodyEvents = rawEvents ? mergeAdjacentRests(mergeSamePitchTies(rawEvents)) : [];
        // PPZ8拡張パートもADPCM(J)と同じPCM系としてLFOSpeed Extend・EnvelopeSpeed Extendの
        // 対象(2026-08-19実測、上のLFO_SPEED_EXTEND_LETTERS/ENV_SPEED_EXTEND_LETTERSの
        // コメント参照)。宣言だけで本文未使用でも、他のExtend同様プレフィクスだけの
        // トラックとして出力する(実データALPHA/SSTENG/MSOFMFS実測、未使用のPPZ拡張パートでも
        // `c9 01 ca 01 bb 01 80`が出ることを確認)。
        const events = [...buildExtendPrefixEvents(ppzLetter), ...bodyEvents];
        if (events.length > 0) {
          const startAddr = cursor;
          const { endAddr, termAddr } = layoutTrack(events, startAddr);
          trackLayout[ppzLetter] = { startAddr, termAddr, events };
          ppzAddrs[k] = startAddr;
          cursor = endAddr;
        } else {
          ppzAddrs[k] = cursor;
          emptySlotAddrs.push(cursor);
          cursor += 1;
        }
      }
      if (ppz8InitEvent) ppz8InitEvent.ptrs = ppzAddrs;
    }
  }

  // ヘッダ命令(#Title/#Composer/#Arranger/#Memo/#PCMfile/#PPZfile/#PPSfile)が
  // 1つでもあれば、flags(4byte)をtone_ptrの直前に置く。無ければ従来通り何も挟まない
  // (後方互換: ヘッダ命令を使わないMMLでは、この2026-08-18のヘッダ機能追加より前と
  // 同じ「トーンテーブルの直前にflagsが無い」構造のまま)。
  // 2026-08-18: #PPZExtendも他のヘッダ命令と同じくflags/メモテーブル出力の
  // トリガーになることを自作corpus実測(pmdppzord.mml等、#PPZExtend以外のヘッダ命令を
  // 一切含まない最小ファイル)で確認した。実測前はTitle等の文字列系ヘッダのみを
  // 見ていたため、#PPZExtend単体のファイルでtone_ptrが4byteずれていた。
  // 2026-08-19: #FM3Extendも#PPZExtendと同様にヘッダ命令の一種として扱う(FM3Extend単体で
  // 他のヘッダ命令が無いケースは未実測だが、#PPZExtendで確立済みの規則「ヘッダ命令が
  // 1つでもあればflags/メモテーブルを出力する」と対称に扱うのが妥当と判断した)。
  const hasHeader = header.title != null || header.composer != null
    || header.arranger != null || header.memo.length > 0
    || header.pcmfile != null || header.ppzfile != null || header.ppsfile != null
    || header.ppzExtend != null || header.fm3Extend != null;

  // 出力トーンテーブルに載せるのは「FMパートの@nで実際に参照されている番号」のみ
  // (fmUsedToneNums、上のコメント参照)。toneTableには検証用にSSG/ADPCM由来の
  // 番号や既定音色@1(hasExplicitTonesがfalseの場合)が混じっていることがあるが、
  // それらはfmUsedToneNumsに含まれないため自然に除外される
  // (MC.DOC「/Vはその曲で使用されているFM音色データを添付する」を実測で確認、
  // mso_JSM.MML: 自作23件→9件、参照.Mの9件と一致)。
  const toneNums = [...fmUsedToneNums].filter((tn) => tn in toneTable).sort((a, b) => a - b);
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
    // (`\`系イベント列 + 単独0xff終端) + 常にある8byte領域。
    // 2026-08-19実測(PRRDEF/PRR96/PRR192/PRRL8/PRRL8B.MML): この8byte領域の
    // 先頭byteは「常に0x00固定」ではなく、K/R未使用時のr_offset固定領域と同じ発想で
    // **Rパターンのうち最も総クロック数が長いものの下位8bit**が入る(pmdunimp.Mが
    // 全パターン0クロックだったため気づけていなかっただけ)。残り7byteは4ケースとも
    // 0x00で不変。
    const { tableAddr, patAddrs, patternLayouts, mysteryAddr } = rhythmIndexInfo;
    patAddrs.forEach((addr, i) => w16(tableAddr + i * 2, addr));
    let longestPatternTicks = 0;
    for (const { events, termAddr } of patternLayouts) {
      for (const ev of events) emitEvent(ev, rel, ev._addr);
      rel[termAddr] = 0xff;
      const ticks = trackTotalTicks(events);
      if (ticks > longestPatternTicks) longestPatternTicks = ticks;
    }
    rel[mysteryAddr] = longestPatternTicks & 0xff;
    for (let i = 1; i < 8; i++) rel[mysteryAddr + i] = 0x00;
  } else {
    // r_offset固定領域(8byte、K/R未使用時)。従来「先頭byteだけが総クロック数の下位8bit、
    // 残り7byteは常に0x00」としていたが、実データ(POPFUL/INTOPAL/MULE/MSOFMFS、
    // いずれもK/R未使用)を突き合わせたところ、総クロック数が256を超えるケース
    // (実データはほぼ全て該当。既存corpusが256未満に収まっていたため気づけなかった)では
    // 上位バイトも書かれており、単純な「下位8bitのみ」では説明できないと判明した
    // (2026-08-19)。実測できた構造は次の通り(offsetはこの8byte領域内の相対位置):
    //   [0]=総クロック数の下位byte、[1]=上位byte、[2..4]=0x00固定、
    //   [5]=[1]と同じ値(上位byteの複製)、[6..7]=0x00固定。
    // 4本(POPFUL/INTOPAL/MULE/MSOFMFS)全てで一致を確認済み。ただしALPHA(#PPZExtend
    // 6パート使用)だけは[5]が複製にならず0x00だった。ALPHAは既知の別バグ
    // (#PPZExtend拡張パート1本あたり6byte不足、docs/pmd-compiler-real-data-diff-*.md参照)
    // により拡張パート領域の長さ自体がずれているため、この[5]の複製規則との関係は
    // 未確定(そちらのバグを解消してから再検証が必要)。[1..4]の「総クロック数」の
    // 定義自体はcomputeLongestPartTicksのコメント参照。
    const longest = computeLongestPartTicks(tracks, header) & 0xffff;
    const lo = longest & 0xff;
    const hi = (longest >> 8) & 0xff;
    rel[rhythmFixedAddr] = lo;
    rel[rhythmFixedAddr + 1] = hi;
    rel[rhythmFixedAddr + 2] = 0x00;
    rel[rhythmFixedAddr + 3] = 0x00;
    rel[rhythmFixedAddr + 4] = 0x00;
    rel[rhythmFixedAddr + 5] = hi;
    rel[rhythmFixedAddr + 6] = 0x00;
    rel[rhythmFixedAddr + 7] = 0x00;
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
