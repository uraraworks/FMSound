// MUCOM88 PCHDATA (mucomweb/src/MucomWeb.cpp TrackStatus, 11ch x 15フィールド) を
// 共有描画層 fmdsp/ が要求する flat_track_status(26フィールド、
// fmdsp/trackrow.js の FIELD 定数を参照)へ変換するアダプタ。
//
// 対応関係の出典は docs/mucom-pchdata-mapping.md を参照。未解明の項目は
// 「最低限それらしく見える」近似値で埋めており、各所にその旨をコメントで残す。
// PMD側(pmdweb)と違い、MUCOM側にはFMDSP用の専用wasm exportが無いため、
// このファイルはMUCOM自身のスナップショットリング(MucomWeb.cppの
// StatusSnapshot)を読み、JS側だけでflat_track_status相当を組み立てる。

// --- MUCOM PCHDATA (TrackStatus) のフィールド順。MucomWeb.cpp の
//     `snapshot.tracks[ch] = { data.length, data.vnum, data.volume,
//     data.quantize, data.detune, data.fnum1, data.fnum2, data.code,
//     data.flag, data.pan, data.keyon, data.alg, data.chnum,
//     data.vnum_org, data.vol_org };` の並びそのまま。 ---
const PCH = {
  LENGTH: 0, VNUM: 1, VOLUME: 2, QUANTIZE: 3, DETUNE: 4,
  FNUM1: 5, FNUM2: 6, CODE: 7, FLAG: 8, PAN: 9,
  KEYON: 10, ALG: 11, CHNUM: 12, VNUM_ORG: 13, VOL_ORG: 14,
};
export const PCH_FIELD_COUNT = 15;
export const MUCOM_CH_COUNT = 11;

// flat_track_status (26フィールド)。fmdsp/trackrow.js の FIELD 定数
// (PmdCore.c flatten() のフィールド順)と一致させること。
const FIELD_COUNT = 26;
const F = {
  PLAYING: 0, INFO: 1, TICKS: 2, TICKS_LEFT: 3, KEY: 4, ACTUAL_KEY: 5,
  TONENUM: 6, VOLUME: 7, GATE: 8, DETUNE: 9,
  STATUS: 10, // 9要素 (10..18)
  FMSLOTMASK: 19, // 4要素 (19..22)
  PPZ8_CH: 23, SSG_TONE: 24, SSG_NOISE: 25,
};
export { FIELD_COUNT };

// MUCOM ch -> FMDSPスロット番号。docs/mucom-pchdata-mapping.md §1(実測)。
// upstream/MucomWeb/mucom88/src/cmucom.h の MUCOM_CH_FM1=0 / MUCOM_CH_PSG=3 /
// MUCOM_CH_RHYTHM=6 / MUCOM_CH_FM2=7 / MUCOM_CH_ADPCM=10 と一致する。
// ch6(リズム)はFMDSP左10行パート(TRACK_DISP_TABLE_OPNA)に対応する表示行が
// 無いため、意図的に写像先を持たない。
export const CH_TO_SLOT = {
  0: 0, 1: 1, 2: 2,     // FM1-3
  7: 6, 8: 7, 9: 8,     // FM4-6
  3: 9, 4: 10, 5: 11,   // SSG1-3
  10: 12,               // ADPCM
};

// OPNAのpanレジスタ(L/R選択2bit)相当値(0-3) -> FMDSP PANPOTスプライト番号(0-5)。
// pmdweb/src/PmdCore.c build_levels() の `static const int table[4] = {5,4,0,2};`
// と同じ変換式を流用している。根拠: MUCOM側 cmucom.cpp の FM/ADPCM分岐は
// `chwork & 0xc0` / `chwork & 3` というレジスタ生ビットをそのまま result->pan に
// 入れており(cmucom.cpp:2346-2360)、OPNA/OPN系チップの標準的なL/R選択2bitと
// 同じ配置だと考えられる。ただし本アダプタでMUCOM側のpan値を音として
// 実測検証したわけではなく、「同じチップ由来のレジスタ形式のはず」という
// 推測に基づく近似(未解明)。SSG/リズムは常に固定値3(cmucom.cpp:2338,2342)を
// 返す実装になっており、これは他パートのbit配置とは意味が異なる「決め打ち値」
// だが、table[3]=2(=中央/両chへ出力)という解釈は「SSG/リズムはパンを持たず
// 両ch鳴る」という実際の挙動と矛盾しないため、そのままtable経由で使う。
const PAN_TABLE = [5, 4, 0, 2];

export function panToSprite(pan) {
  const index = pan & 3;
  return PAN_TABLE[index];
}

// --- sticky状態(playing/ticksの近似実装に必要) ---
// playing: 「このパートがこの曲で一度でも非0のcode/fnum1を出したか」を
//   曲ごとに1度立てたら降ろさないstickyフラグとして持つ。
//   docs/mucom-pchdata-mapping.md §5の通り、MUCOM側PCHDATAには
//   「今この瞬間鳴っているかどうか」に対応する単一フィールドが見当たらず、
//   private tcount[]も読めないため、この近似で代替する
//   (「未使用パートかどうか」は判定できるが、「一時停止中かどうか」は
//   判定できないという意味で、PMDのnativeなplayingとは性質が異なる)。
// ticks / ticks_left: ticks_left は実測済みの LENGTH COUNTER (`length`、
//   ノート再生中に減っていく値)をそのまま使う。ticks は対応物が無いため、
//   「直前のノート開始(=keyの変化を検出したタイミング)以降に観測した
//   lengthの最大値」で代用する。ゲージバーの見た目(fmdsp/trackrow.jsの
//   `ticks>>2`位置マーカー、`ticksLeft>>2`塗り幅)のためだけの近似。
class ChannelAdapterState {
  constructor() {
    this.playingSticky = false;
    this.lastKey = -1;
    this.ticksMax = 0;
  }
}

export class MucomFmdspAdapter {
  constructor() {
    this.states = Array.from({ length: MUCOM_CH_COUNT }, () => new ChannelAdapterState());
  }

  // 新しい曲をコンパイル/再生し直すたびに呼ぶ(sticky状態をリセットする)。
  reset() {
    this.states = Array.from({ length: MUCOM_CH_COUNT }, () => new ChannelAdapterState());
  }

  // 1ch分のPCHDATA(Int32Array長15、MucomWeb.cpp TrackStatusの並び)を
  // flat_track_status形式のInt32Array(長26)へ変換する。
  convertChannel(ch, pchData) {
    const state = this.states[ch];
    const out = new Int32Array(FIELD_COUNT);

    const code = pchData[PCH.CODE] | 0;
    const fnum1 = pchData[PCH.FNUM1] | 0;
    const fnum2 = pchData[PCH.FNUM2] | 0;
    // 休符判定: docs §2実測。fnum1===0 && fnum2===0 のみを使う
    // (code===0 は o1,c の実音と衝突するため単体では使わない)。
    const isRest = fnum1 === 0 && fnum2 === 0;

    // key: code+0x10 (MUCOM内部オクターブは0始まり、PMDは1始まりのため+1オクターブ
    // ぶん=0x10を足す。docs §2)。休符時は下位4bitをPMD流儀の0xFへ上書きする。
    let key = (code + 0x10) & 0xff;
    if (isRest) key = (key & 0xf0) | 0xf;
    const actualKey = key; // LFO/ベンド後の実効値はMUCOM側に無い(未解明)。keyと同値で代用。

    // playing(sticky): 一度でも非0のcode/fnum1を出したら以後ずっとtrueのまま
    // (「今鳴っているか」ではなく「この曲でそのパートが使われているか」)。
    if (code !== 0 || fnum1 !== 0) state.playingSticky = true;

    // ticks/ticks_left の近似(クラスコメント参照)。
    const length = pchData[PCH.LENGTH] | 0;
    if (key !== state.lastKey) {
      state.ticksMax = length;
      state.lastKey = key;
    } else if (length > state.ticksMax) {
      state.ticksMax = length;
    }

    out[F.PLAYING] = state.playingSticky ? 1 : 0;
    out[F.INFO] = 0; // 対応物なし(暫定0)
    out[F.TICKS] = state.ticksMax;
    out[F.TICKS_LEFT] = length;
    out[F.KEY] = key;
    out[F.ACTUAL_KEY] = actualKey;
    out[F.TONENUM] = pchData[PCH.VNUM] | 0;
    out[F.VOLUME] = pchData[PCH.VOL_ORG] | 0;
    out[F.GATE] = pchData[PCH.QUANTIZE] | 0;
    // detune: 符号付き16bit解釈(docs §4実測)。
    {
      let d = pchData[PCH.DETUNE] | 0;
      if (d > 32767) d -= 65536;
      out[F.DETUNE] = d;
    }
    // status[9]/fmslotmask[4]/ppz8_ch/ssg_tone/ssg_noise: 対応物なし。0で埋める。
    return out;
  }
}
