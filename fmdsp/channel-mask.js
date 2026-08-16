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

// 「曲が使っていないパート」判定(下のusedChannelsFromPmdMmlParts参照)のため、
// PMD MMLパーサのパート文字順をそのまま借りる(重複定義しない。パーサ側が
// A-Iの順=FM1-6,SSG1-3の順であることの唯一の情報源)。
import { PART_LETTERS } from '../compiler/pmd_mml_parser.mjs';

export const FM_CHANNELS = ['FM1', 'FM2', 'FM3', 'FM4', 'FM5', 'FM6'];
export const SSG_CHANNELS = ['SSG1', 'SSG2', 'SSG3'];
export const ADPCM_CHANNEL = 'ADPCM';
export const RHYTHM_CHANNEL = 'RHYTHM';

// トラック行(0-9)の並び順。fmdsp/trackrow.js の TRACK_DISP_TABLE_OPNA
// (= track_type_table を FM1-6,SSG1-3,ADPCM の順に辿ったもの)と一致させる。
// 本Web版のFMDSPはこの10行のみを表示し、リズム専用の行を持たない
// (html/mucom-adapter.js CH_TO_SLOTのコメント参照: MUCOM側リズムパート(G)は
// 対応する表示行が無いため写像先を持たない)。そのためトラック行クリックで
// ミュートできるのはこの10チャンネルのみ。
// 2026-08-16追記: RHYTHM_CHANNELはトラック行こそ持たないが、下のレベルメーター
// クリック(LEVEL_COLUMN_CHANNELS)経由ではUIから到達できるようになった。
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

// --- レベルメーター(右ペイン、fmdsp/rightpane.js drawLevelMeters)のクリック対応 ---
// 2026-08-16追加: リズムパートはトラック行を持たない(上のTRACK_ROW_CHANNELSの
// コメント参照)ため、クリックでミュートする手段が無かった。上流はレベルメーター
// index9(RHYTHM列)にリズムのマスク状態を反映している
// (upstream/98fmplayer/fmdsp/fmdsp-pacc.c:1717 `levels[c].masked = c == 9 ?
// fp->masked_rhythm : fp->masked[levels[c].t]`、:1988 masked_rhythm算出)ので、
// 同じ列をクリック対象にする。
//
// レベルメーター列(FMDSP_LEVEL_COUNT=19)のうち0-10列の対応(出典:
// fmdsp-pacc.c:1670-1696、fmdsp/rightpane.js drawLevelLabels()の列見出しと一致):
//   0-5=FM1-6, 6-8=SSG1-3, 9=RHYTHM, 10=ADPCM, 11-18=PPZ8 1-8
// PPZ8(11-18)はbuildMucomChannelMask/buildPmdChannelMaskがそもそもマスク値の
// 組み立てに対応していない(TRACK_ROW_CHANNELSにも含まれない)ため、クリック対象に
// 含めない(未対応チャンネルをクリックできる見た目にすると、押しても効かない
// UIになってしまう)。
export const LEVEL_COLUMN_CHANNELS = [
  ...FM_CHANNELS, ...SSG_CHANNELS, RHYTHM_CHANNEL, ADPCM_CHANNEL,
];

// レベルメーター列index(0-18) -> 論理チャンネル名。11以上(PPZ8)はundefined。
export function channelForLevelColumn(columnIndex) {
  return LEVEL_COLUMN_CHANNELS[columnIndex];
}

// mutedChannels(Set<string>、論理チャンネル名の集合)を、トラック行クリック用の
// Set<number>(行index)へ変換する。トラック行描画(fmdsp/trackrow.js
// drawTrackRows)とレベルメーター描画(fmdsp/rightpane.js drawLevelMeters)の
// 両方が同じmutedChannelsを唯一の状態(single source of truth)として参照できる
// ようにするための変換関数(html/pmd-app.js・html/mucom-app.js共通)。
export function mutedRowsFromChannels(mutedChannels) {
  const rows = new Set();
  TRACK_ROW_CHANNELS.forEach((ch, row) => { if (mutedChannels.has(ch)) rows.add(row); });
  return rows;
}

// mutedChannelsを、レベルメーター描画用のSet<number>(列index)へ変換する。
export function mutedColumnsFromChannels(mutedChannels) {
  const columns = new Set();
  LEVEL_COLUMN_CHANNELS.forEach((ch, col) => { if (mutedChannels.has(ch)) columns.add(col); });
  return columns;
}

// --- 「曲が使っていないパート」の判定(2026-08-17追加) ---
// 利用者指示: ミュート(利用者が消した)と未使用(曲がそもそも鳴らさない)を
// 見た目で区別できるようにする。区別するには「このチャンネルを曲が使っているか」
// を判定する必要があるが、判定できないエンジン/経路では絶対に推測しない
// (usedChannels自体をnullのまま返し、呼び出し側はnullを「全チャンネル使用扱い
// (=未使用暗色化をしない)」として扱う。下のunusedRowsFromChannels/
// unusedColumnsFromChannels参照)。

// MUCOM88: MMLコンパイル時のログ([ Total count ]行、cmucom.cpp:1759-1769の
// PRINTF("%c:%d ", 'A'+i, tcount[i]))から、各チャンネル(A-K)のtick数を読み取る。
// tick数が1以上のチャンネルを「曲が使っている」とみなす(tools/measure_mucom_adpcm_corpus.mjs
// がKパート単体の有無判定に使っているのと同じ基準を全チャンネルへ広げたもの)。
// MUCOM88はこのアプリでは常にMMLをコンパイルしてから再生する(あらかじめコンパイル
// 済みの.mubを直接読み込む経路が無い)ため、コンパイルが成功する限りこの判定は
// 常に使える。
//
// MUCOM88のチャンネル文字(A-K) -> 論理チャンネル名の対応。
// 出典: html/mucom-adapter.js CH_TO_SLOT のコメント(upstream/MucomWeb/mucom88/src/cmucom.h
// MUCOM_CH_FM1=0 / MUCOM_CH_PSG=3 / MUCOM_CH_RHYTHM=6 / MUCOM_CH_FM2=7 / MUCOM_CH_ADPCM=10)。
// ch0-2=A-C=FM1-3, ch3-5=D-F=SSG1-3, ch6=G=RHYTHM, ch7-9=H-J=FM4-6, ch10=K=ADPCM。
const MUCOM_CH_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];
const MUCOM_CH_TO_CHANNEL = [
  FM_CHANNELS[0], FM_CHANNELS[1], FM_CHANNELS[2],
  SSG_CHANNELS[0], SSG_CHANNELS[1], SSG_CHANNELS[2],
  RHYTHM_CHANNEL,
  FM_CHANNELS[3], FM_CHANNELS[4], FM_CHANNELS[5],
  ADPCM_CHANNEL,
];

// MUCOM88のコンパイルログ全文(Module.getCompileMessagePointer/Lengthをデコードした
// もの)から使用チャンネル集合を組み立てる。"[ Total count ]"行が見つからない
// (コンパイル失敗、ログ形式が想定外)場合はnullを返す(でっち上げない)。
export function usedChannelsFromMucomCompileLog(log) {
  if (typeof log !== 'string') return null;
  const m = /\[ Total count \][^\n]*\n([^\n]*)/.exec(log);
  if (!m) return null;
  const used = new Set();
  const re = /([A-K]):(\d+)/g;
  let match;
  let any = false;
  while ((match = re.exec(m[1])) !== null) {
    any = true;
    const idx = MUCOM_CH_LETTERS.indexOf(match[1]);
    if (idx >= 0 && parseInt(match[2], 10) > 0) used.add(MUCOM_CH_TO_CHANNEL[idx]);
  }
  return any ? used : null;
}

// PMD: MMLをこのアプリのv1コンパイラ(compiler/pmd_mml_compiler.mjs)で読み込んだ
// 場合のみ判定できる。同コンパイラのPART_LETTERS(A-I)はFM1-6/SSG1-3の9パートのみを
// 表し、配列indexの並びはFM_CHANNELS+SSG_CHANNELSの並びと一致する(pmd_mml_parser.mjs
// 冒頭コメント「A-F=FM1-6, G-I=SSG1-3」参照)。
// 重要: 同コンパイラはRHYTHM/ADPCMを構造的に一切出力しない
// (compiler/pmd_mml_compiler.mjs `// ADPCM/RHYTHM: v1未対応、空トラック`
// のとおり、該当ヘッダを常にEMPTY_TRACK_OFFで埋める)。そのためRHYTHM/ADPCMは
// 「判定できない」のではなく「このアプリでMML入力した曲では絶対に鳴らない」と
// 確定できる事実であり、usedPartLettersに含まれることは無い(=常に未使用表示になる)。
//
// usedPartLetters: parseMml()が返すtracksのkeys、またはcompileMml()が返す
// layout.tracksのObject.keys()(どちらもPART_LETTERSの部分集合の配列)。
export function usedChannelsFromPmdMmlParts(usedPartLetters) {
  const used = new Set();
  usedPartLetters.forEach((letter) => {
    const idx = PMD_MML_PART_LETTERS.indexOf(letter);
    if (idx >= 0) used.add(PMD_MML_PART_ORDER[idx]);
  });
  return used;
}

// PMDの「曲を開く」(.M/.mバイナリを直接再生。MMLソースを経由しない)経路は、
// fmdriver_track_status(upstream/98fmplayer/fmdriver/fmdriver.h)に「このトラックに
// データがあるか」を表すフィールドが無く(playingは「今現在鳴っているか」の
// 瞬間値でしかない)、既存のwasm exportからも曲全体を通した使用状況を読み取る
// 手段が無い。全曲を最後まで走らせて監視すれば分かるかもしれないが、それは
// 「読み込んだ瞬間に表示する」という本機能の要件に合わないため実装しない。
// 呼び出し側はこの経路ではusedChannelsをnull(判定不能)のままにすること。
export const PMD_MML_PART_LETTERS = PART_LETTERS;
export const PMD_MML_PART_ORDER = [...FM_CHANNELS, ...SSG_CHANNELS];

// usedChannels(Set<string>|null)を、トラック行描画用のSet<number>(未使用の行index)
// へ変換する。usedChannelsがnull(判定不能)のときは何も暗くしない(空集合を返す)。
export function unusedRowsFromChannels(usedChannels) {
  const rows = new Set();
  if (!usedChannels) return rows;
  TRACK_ROW_CHANNELS.forEach((ch, row) => { if (!usedChannels.has(ch)) rows.add(row); });
  return rows;
}

// レベルメーター列11-18(PPZ8 1-8)。上のLEVEL_COLUMN_CHANNELSのコメントの
// とおりPPZ8はマスク対応チャンネルの一覧に含まれないため、専用の定数として
// 列数だけここに置く(FMDSP_LEVEL_COUNT=19はfmdsp/rightpane.jsの定義が
// 唯一の情報源なので、ここでは重複定義せず単純に11からの残り8列とする)。
const PPZ8_LEVEL_COLUMN_START = 11;
const PPZ8_LEVEL_COLUMN_COUNT = 8;

// usedChannelsを、レベルメーター描画用のSet<number>(未使用の列index)へ変換する。
//
// PPZ8列(11-18)の扱い(2026-08-17追加。利用者指摘: 「レベルメーターの右側が
// 鍵盤の数より多いが、右側は使われることがあるのか」):
// PPZ8(PMDのPCM 8ch)は、このWeb版では構造的に絶対に鳴らない。
//   - MUCOM88には元々PPZ8の概念自体が存在しない(fmgenにPPZ8相当の実装が無い)。
//   - PMD側はppz8_init()やミキサー配線こそ存在するが、本Web版はPPZ8の
//     サンプルバンク(.PPC/.PVI)をUIから一切読み込まない
//     (pmdweb/src/PmdCore.c:503 コメント参照)。バンクが無ければ鳴らしようが
//     ない。
// これはusedChannelsFromMucomCompileLog/usedChannelsFromPmdMmlPartsのような
// 「曲ごとに変わる使用状況」の判定とは性質が違う(常に不使用と確定できる、
// エンジン側の構造の話)。そのためusedChannels(曲固有・null=判定不能もあり得る)
// の中身に関わらず、PPZ8列は常にunused扱いにする(=呼び出し元がnullを渡しても
// この8列だけは暗く表示される。他の0-10列はnull時に何も暗くしない従来どおりの
// 挙動を維持する)。
// 将来PPZ8バンクの読み込みに対応したら、この一律unused判定をやめて曲ごとの
// 使用状況判定に差し替える必要がある。
export function unusedColumnsFromChannels(usedChannels) {
  const columns = new Set();
  for (let i = 0; i < PPZ8_LEVEL_COLUMN_COUNT; i += 1) columns.add(PPZ8_LEVEL_COLUMN_START + i);
  if (!usedChannels) return columns;
  LEVEL_COLUMN_CHANNELS.forEach((ch, col) => { if (!usedChannels.has(ch)) columns.add(col); });
  return columns;
}
