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

// PCHDATAのMMLパートch(A-K=0-10) -> mucomvm::GetChStatus(ch)のOPNAハードウェアch
// index(0-15)。実測(2026-08-14, node直実行でchstatをリング経由で観測):
//   A(ch0,FM1)->chstat0 / B(ch1,FM2)->chstat1 / C(ch2,FM3)->chstat2
//   H(ch7,FM4)->chstat4 / I(ch8,FM5)->chstat5 / J(ch9,FM6)->chstat6
//   K(ch10,ADPCM)->chstat10(実曲sampl1.mucで実測、ADPCM再生区間だけ1になり
//     停止区間で0に戻ることを複数ステップで確認済み)
// D/E/F(SSG1-3, ch3-5)とG(リズム, ch6)は、単発ノートを鳴らしても対応する
// chstat[]がまったく変化しないことを実測で確認した(mucomvm.cpp のFMOutData()
// 実装を読むと、chstat[]はreg 0x28(FM KeyOn, data&7)とFMOutData2の
// ADPCM分岐でしか更新されておらず、SSG/リズムのKeyOnは別レジスタ経路で
// chstat[]を一切触らない。よってSSG/リズムはchstatによる実時間playing判定が
// 構造的に不可能で、引き続きsticky近似を使う)。
export const CH_TO_CHSTAT = {
  0: 0, 1: 1, 2: 2,
  7: 4, 8: 5, 9: 6,
  10: 10,
};

// OPNAのpanレジスタ(L/R選択2bit)相当値(0-3) -> FMDSP PANPOTスプライト番号(0-5)。
// 2026-08-14に実測で確定(docs/mucom-pchdata-mapping.md §14参照。旧コメントの
// 「PMD側テーブルの流用・未検証」は誤りではなかったが、以下により裏付けが取れた)。
//
// FM(A,B,C,H,I,J): PCHDATA.pan は OPNAレジスタ 0xB4-0xB6(FM1-3)/0x1B4-0x1B6(FM4-6)の
// bit6,7をそのまま反映していることを mucomvm::GetRegisterMap() 直読みで実測確認済み
// (`K@1p<n>o4c1`ならぬ`A@1p0..3o4c1`/`H@1p0..3o4c1`をコンパイルし、regmap[0xB4]/
// [0x1B4]の上位2bitとPCHDATA.panが p0-p3 全4値で完全一致することを確認)。
// さらに `upstream/98fmplayer/libopna/opnafm.c`(PMD側が使う独立実装)の
// `fm->lselect[c]=val&0x80; fm->rselect[c]=val&0x40;`(reg 0xB4のcase 0x4)と
// `upstream/98fmplayer/fmdsp/fmdsp-pacc.c`の
// `table[4]={5,4,0,2}; pan=table[lselect*2+rselect]` が、MUCOM側の生値(0-3、
// bit7<<1|bit6の並び)と完全に同じビット合成式であることをソースレベルで確認した。
// 独立な2実装(fmgenのOPNABase::Mix6、opnafm.cのミキシング)が同じ変換をしている
// ため、推測ではなく「同一チップの同一レジスタを2つの実装が同じ規約で読んでいる」
// という一致であり、tableをそのまま流用してよい。
//   pan=0(p0,L無効R無効)->無音 / pan=1(p1,Rのみ)->右 / pan=2(p2,Lのみ)->左 /
//   pan=3(p3,両方)->中央。テストMML: `A @1p0o4c1` 〜 `A @1p3o4c1`(part A/H で実施)。
//
// ADPCM(K): 実曲(sampl1.muc)再生中、regmap[0x101](ADPCM-B Control2、fmgen
// opna.cpp:SetADPCMBReg case 0x01)の上位2bitとPCHDATA.panがどちらも終始3(中央)で
// 一致することを確認した。ただしp0-p3を明示指定してのK単独テスト
// (`K @1p<n> r1`のような無音ノート)では実際にKeyOnが発生せずレジスタ書き込み
// 自体が起きなかったため、pan=0/1/2でのレジスタ一致は確認できていない
// (**ADPCMの0/1/2は未解明**。3(中央)のみ実測で裏付け済み)。fmgen opna.cpp:976-977の
// `maskl=control2&0x80; maskr=control2&0x40;` はFMと同じbit配置のため同じ式を
// 流用する方針だが、これは未検証部分にはソースの構造的類推が根拠であることを明記する。
//
// SSG(D,E,F)/リズム(G): cmucom.cpp が `pan=3` を無条件に返す(レジスタを読んですら
// いない、cmucom.cpp:1621,1625)ハードコードのため「未検証の近似」ではなく、
// ソースの断定的な代入としてそのまま確定値として扱ってよい。table[3]=2
// (=両ch出力)という解釈もこの「SSG/リズムは常に両ch」という実装と整合する。
const PAN_TABLE = [5, 4, 0, 2];

export function panToSprite(pan) {
  const index = pan & 3;
  return PAN_TABLE[index];
}

// --- sticky状態(SSG/リズムのplaying近似・ticksの近似実装に必要) ---
// playing: FM(A,B,C,H,I,J)とADPCM(K)は upstream patch で追加した
//   mucomvm::GetChStatus() 実測値(CH_TO_CHSTAT)を「今この瞬間鳴っているか」
//   としてそのまま使う(sticky不要、real-time)。SSG(D,E,F)とリズム(G)は
//   対応するchstat[]が存在しない(CH_TO_CHSTATのコメント参照)ため、従来通り
//   「このパートがこの曲で一度でも非0のcode/fnum1を出したか」を曲ごとに
//   1度立てたら降ろさないstickyフラグで代替する(「未使用パートかどうか」は
//   判定できるが「一時停止中かどうか」は判定できない、という制約付きの近似。
//   未解明として残る)。
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
  // chstatValue: CH_TO_CHSTAT[ch]が定義されているchについてのみ、
  // mucomvm::GetChStatus()の実測値(0/1)を渡す。undefinedならsticky近似を使う
  // (SSG/リズム。CH_TO_CHSTATのコメント参照)。
  convertChannel(ch, pchData, chstatValue) {
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

    // playing: chstatValueが渡された(FM/ADPCM)場合はmucomvm::GetChStatus()の
    // 実測値をそのまま「今この瞬間鳴っているか」として使う(sticky近似ではない、
    // CH_TO_CHSTATのコメント参照)。SSG/リズム(chstatValue===undefined)は
    // 対応するchstat[]が存在しないため、従来通り「一度でも非0のcode/fnum1を
    // 出したか」のsticky近似のまま(未解明として残る制約)。
    if (code !== 0 || fnum1 !== 0) state.playingSticky = true;
    const playing = chstatValue !== undefined ? (chstatValue !== 0) : state.playingSticky;

    // ticks/ticks_left の近似(クラスコメント参照)。
    const length = pchData[PCH.LENGTH] | 0;
    if (key !== state.lastKey) {
      state.ticksMax = length;
      state.lastKey = key;
    } else if (length > state.ticksMax) {
      state.ticksMax = length;
    }

    out[F.PLAYING] = playing ? 1 : 0;
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
