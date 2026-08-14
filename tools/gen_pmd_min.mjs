// PMD `.M` 最小バイナリを直接組み立てる(MMLパーサ不要、v1第1段階用)。
//
// フォーマットの根拠は docs/pmd-compiler-spec.md 1.1〜1.3, 1.6 節を参照。
// 出典はすべて upstream/98fmplayer/fmdriver/fmdriver_pmd.c の行番号で明記する。
//
// 生成するファイルの構造(相対オフセットは opm_flag バイトを除いた基準。
// fmdriver_pmd.c:5935 `pmd->data = data + 1` の通り):
//
//   file[0]                 : opm_flag (0 or 1。fmdriver_pmd.c:239-240)
//   rel 0x00-0x01           : FM1 パートポインタ
//   rel 0x02-0x15           : FM2-6/SSG1-3/ADPCM/RHYTHM の9パートポインタ(全て空トラックへ)
//   rel 0x16-0x17           : r_offset (未使用、空トラックを指すだけ)
//   rel 0x18-0x19           : tone_ptr (fmdriver_pmd.c:242-248)
//   rel 0x1a                : 空トラック(即終端 0x80)
//   rel 0x1b-               : FM1トラック本体 (0xff tonenum, note, len, 0x80)
//   rel (tone_ptr起点)       : 音色テーブル1エントリ(26byte, fmdriver_pmd.c:999-1013)

export const NOTE_NAMES = ['c', 'c+', 'd', 'd+', 'e', 'f', 'f+', 'g', 'g+', 'a', 'a+', 'b'];
export const REST_NIBBLE = 0x0f;

// 音符バイトを組み立てる。doc 1.3節: 上位4bit=オクターブ, 下位4bit=音階(0x0-0xb)/休符(0xf)
export function noteByte(octave, noteIndex) {
  return ((octave & 0xf) << 4) | (noteIndex & 0xf);
}

// 音色テーブルの26byteエントリを組み立てる。
// 出典(すべて fmdriver_pmd.c、body先頭からの相対offset):
//   0x00-0x03 MUL/DT1 (reg 0x30系, :1116)  -- 1oct: DT1=bit6-4(3bit,0-7), MUL=bit3-0(4bit,0-15)
//   0x04-0x07 TL      (reg 0x40系, :1121→実際の反映は1580行のvol計算経由) -- TL=bit6-0(7bit,0-127)
//   0x08-0x0b KS/AR   (reg 0x50系, :1126)  -- KS=bit7-6(2bit,0-3), AR=bit4-0(5bit,0-31)
//   0x0c-0x0f AM/D1R  (reg 0x60系, :1130)  -- AM=bit7(1bit), D1R=bit4-0(5bit,0-31)
//   0x10-0x13 D2R(SR) (reg 0x70系, :1127)  -- SR=bit4-0(5bit,0-31)
//   0x14-0x17 SL/RR   (reg 0x80系, :1131)  -- SL=bit7-4(4bit,0-15), RR=bit3-0(4bit,0-15)
//   0x18      FB/ALG  (reg 0xB0系, :1101)  -- FB=bit5-3(3bit,0-7), ALG=bit2-0(3bit,0-7)
//
// このビット幅・位置は fmdriver_pmd.c が生バイトをそのまま OPNA レジスタへ書いている
// (変換を一切していない)ことから、YM2608/OPNA データシートのレジスタ仕様そのものである。
// PMDMML.MAN §3-1 の `@` 定義パラメータ範囲(WebFetchで実測): AR 0-31, DR(D1R) 0-31,
// SR(D2R) 0-31, RR 0-15, SL 0-15, TL 0-127, KS 0-3, ML 0-15 は全てこのビット幅と一致した。
// DT(-3~+3)は3bitフィールドと符号表現の対応まで未確認のため今回は DT=0 のみ使用する。
// AMS(doc記載は0-3)は reg 0x60 の bit7 が1bitの AM ON/OFF フラグである実装と一致せず
// 未解明(docs/pmd-compiler-spec.md に記載)。
export function buildToneEntry({
  tonenum = 1,
  mul = [1, 1, 1, 1],
  dt1 = [0, 0, 0, 0],
  tl = [0, 0, 0, 0],
  ks = [0, 0, 0, 0],
  ar = [31, 31, 31, 31],
  am = [0, 0, 0, 0],
  d1r = [0, 0, 0, 0],
  d2r = [0, 0, 0, 0],
  sl = [0, 0, 0, 0],
  rr = [7, 7, 7, 7],
  fb = 0,
  alg = 7,
} = {}) {
  const bytes = new Uint8Array(26);
  bytes[0] = tonenum & 0xff;
  for (let s = 0; s < 4; s++) {
    bytes[1 + 0x00 + s] = ((dt1[s] & 0x7) << 4) | (mul[s] & 0xf);
    bytes[1 + 0x04 + s] = tl[s] & 0x7f;
    bytes[1 + 0x08 + s] = ((ks[s] & 0x3) << 6) | (ar[s] & 0x1f);
    bytes[1 + 0x0c + s] = ((am[s] & 0x1) << 7) | (d1r[s] & 0x1f);
    bytes[1 + 0x10 + s] = d2r[s] & 0x1f;
    bytes[1 + 0x14 + s] = ((sl[s] & 0xf) << 4) | (rr[s] & 0xf);
  }
  bytes[1 + 0x18] = ((fb & 0x7) << 3) | (alg & 0x7);
  return bytes;
}

// 単音だけを鳴らすFM1パートの最小 `.M` を1本組み立てる。
// tone: buildToneEntry() の戻り値(26byte)。
// note/length: FM1トラックに置く音符1個ぶん(休符やタイは含まない)。
export function buildMinimalPmdFile({
  opmFlag = 0,
  tonenum = 1,
  tone,
  octave = 4,
  noteIndex = 0, // 'c'
  length = 24, // 96分音符基準でのクロック値(1.3節)。24=4分音符
} = {}) {
  if (tone.length !== 26) throw new Error('tone entry must be 26 bytes');

  const HEADER_LEN = 0x1a; // 11ポインタ(22) + r_offset(2) + tone_ptr(2)
  const EMPTY_TRACK_OFF = HEADER_LEN; // 0x1a: 空トラック(0x80一発)
  const FM1_TRACK_OFF = EMPTY_TRACK_OFF + 1; // 0x1b
  const fm1Track = Uint8Array.from([0xff, tonenum & 0xff, noteByte(octave, noteIndex), length & 0xff, 0x80]);
  const TONE_OFF = FM1_TRACK_OFF + fm1Track.length;

  const relLen = TONE_OFF + tone.length;
  const rel = new Uint8Array(relLen);

  function w16(off, val) {
    rel[off] = val & 0xff;
    rel[off + 1] = (val >> 8) & 0xff;
  }

  // 11パート分のポインタ(FM1-6, SSG1-3, ADPCM, RHYTHM。doc 1.2節の順)。
  w16(0x00, FM1_TRACK_OFF); // FM1のみ実データ
  for (let i = 1; i < 11; i++) w16(i * 2, EMPTY_TRACK_OFF); // 残り10パートは空トラック
  w16(0x16, EMPTY_TRACK_OFF); // r_offset(未使用)
  w16(0x18, TONE_OFF); // tone_ptr

  rel[EMPTY_TRACK_OFF] = 0x80; // 即終端
  rel.set(fm1Track, FM1_TRACK_OFF);
  rel.set(tone, TONE_OFF);

  const file = new Uint8Array(1 + relLen);
  file[0] = opmFlag & 0xff;
  file.set(rel, 1);
  return file;
}

export function buildSingleFmNoteFile(opts = {}) {
  const { tonenum = 1, toneOverrides = {}, ...rest } = opts;
  const tone = buildToneEntry({ tonenum, ...toneOverrides });
  return buildMinimalPmdFile({ tonenum, tone, ...rest });
}
