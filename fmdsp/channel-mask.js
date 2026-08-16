// トラック行クリックミュート機能の、行 -> チャンネル -> ビットマスク変換を担う
// 純粋関数群(DOM/canvas/wasmに一切依存しない。tools/verify_channel_mask.mjs参照)。
//
// MUCOM88(fmgen)とPMD(98fmplayer)は下位9bit(FM1-6, SSG1-3)は同じビット位置だが、
// ADPCMとリズムのビット位置が入れ替わっている。呼び出し側がこの違いに気づかず
// 共通のマスク値をそのまま両エンジンへ渡すと、FM/SSGは正しく消えるので
// 「動いているように見える」が、ADPCMを消したつもりがリズムを消える(逆もまた
// 然り)という壊れ方をする。そのためマスク値は必ずエンジンごとに
// buildMucomChannelMask()/buildPmdChannelMask()で個別に組み立てること。
//
// 出典:
//   MUCOM88: upstream/MucomWeb/mucom88/src/fmgen/opna.cpp:494-500
//     (OPNABase::SetChannelMask。ch[i].Mute()がbit0-5=FM1-6、
//      psg.SetChannelMask(mask>>6)がbit6-8=SSG1-3、
//      adpcmmask_=mask&(1<<9)=bit9、rhythmmask_=(mask>>10)&0x3f=bit10-15の6bit)
//   PMD: upstream/98fmplayer/libopna/opna.c:59-66 (opna_set_mask)、
//     upstream/98fmplayer/libopna/opna.h:14-30 (LIBOPNA_CHAN_* enum。
//     FM1-6=bit0-5、SSG1-3=bit6-8、DRUM_BD..RIM=bit9-14の6bit、
//     ADPCM=bit15=0x8000)
// 両者とも極性は同じ: ビットを立てる = そのチャンネルが鳴らなくなる。

export const FM_CHANNELS = ['FM1', 'FM2', 'FM3', 'FM4', 'FM5', 'FM6'];
export const SSG_CHANNELS = ['SSG1', 'SSG2', 'SSG3'];
export const ADPCM_CHANNEL = 'ADPCM';
export const RHYTHM_CHANNEL = 'RHYTHM';

// トラック行(0-9)の並び順。fmdsp/trackrow.js の TRACK_DISP_TABLE_OPNA
// (= track_type_table を FM1-6,SSG1-3,ADPCM の順に辿ったもの)と一致させる。
// 本Web版のFMDSPはこの10行のみを表示し、リズム専用の行を持たない
// (html/mucom-adapter.js CH_TO_SLOTのコメント参照: MUCOM側リズムパート(G)は
// 対応する表示行が無いため写像先を持たない)。そのためクリックでミュートできる
// のはこの10チャンネルのみ。RHYTHM_CHANNELはUIからは到達しないが、ビット組み立て
// 関数自体はテスト可能性のため受け付ける。
export const TRACK_ROW_CHANNELS = [...FM_CHANNELS, ...SSG_CHANNELS, ADPCM_CHANNEL];

function fmSsgBits(mutedSet) {
  let mask = 0;
  FM_CHANNELS.forEach((ch, i) => { if (mutedSet.has(ch)) mask |= (1 << i); });
  SSG_CHANNELS.forEach((ch, i) => { if (mutedSet.has(ch)) mask |= (1 << (6 + i)); });
  return mask;
}

// mutedSet: Set<string>(FM_CHANNELS/SSG_CHANNELS/ADPCM_CHANNEL/RHYTHM_CHANNELの
// いずれかの文字列を含む集合)。
export function buildMucomChannelMask(mutedSet) {
  let mask = fmSsgBits(mutedSet);
  if (mutedSet.has(ADPCM_CHANNEL)) mask |= (1 << 9);
  if (mutedSet.has(RHYTHM_CHANNEL)) mask |= (0x3f << 10); // bit10-15、6音まとめて1chとして扱う
  return mask >>> 0;
}

export function buildPmdChannelMask(mutedSet) {
  let mask = fmSsgBits(mutedSet);
  if (mutedSet.has(RHYTHM_CHANNEL)) mask |= (0x3f << 9); // bit9-14
  if (mutedSet.has(ADPCM_CHANNEL)) mask |= (1 << 15);
  return mask >>> 0;
}

// トラック行index(0-9) -> 論理チャンネル名。範囲外はundefined。
export function channelForRow(rowIndex) {
  return TRACK_ROW_CHANNELS[rowIndex];
}
