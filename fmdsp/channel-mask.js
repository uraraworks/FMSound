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
// PPZ8(11-18)は下のPPZ8_CHANNELS/buildPpz8Mask()参照(2026-08-18対応)。ここには
// 含めない: buildMucomChannelMask/buildPmdChannelMaskが組み立てるのはOPNA用マスク
// (opna_set_mask())で、PPZ8は別ミキサー(ppz8_set_mask())なのでビット体系が違う。
// MUCOM88はPPZ8という概念自体を持たない(fmgenに相当実装が無い)ため、この定数を
// 使うMUCOM側の呼び出し(html/mucom-app.js)はLEVEL_COLUMN_CHANNELSのままでよい。
export const LEVEL_COLUMN_CHANNELS = [
  ...FM_CHANNELS, ...SSG_CHANNELS, RHYTHM_CHANNEL, ADPCM_CHANNEL,
];

// レベルメーター列index -> 論理チャンネル名。channels省略時はLEVEL_COLUMN_CHANNELS
// (0-10列。既存呼び出し=MUCOM側の挙動を変えないための既定値)。PMD側は
// html/pmd-app.jsからPMD_LEVEL_COLUMN_CHANNELS(0-18列)を明示的に渡す。
// 範囲外はundefined。
export function channelForLevelColumn(columnIndex, channels = LEVEL_COLUMN_CHANNELS) {
  return channels[columnIndex];
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
// channels省略時はLEVEL_COLUMN_CHANNELS(MUCOM側の挙動を変えないための既定値)。
// PMD側はhtml/pmd-app.jsからPMD_LEVEL_COLUMN_CHANNELS(0-18列)を明示的に渡す。
export function mutedColumnsFromChannels(mutedChannels, channels = LEVEL_COLUMN_CHANNELS) {
  const columns = new Set();
  channels.forEach((ch, col) => { if (mutedChannels.has(ch)) columns.add(col); });
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

// PMD: MMLをこのアプリのコンパイラ(compiler/pmd_mml_compiler.mjs)で読み込んだ
// 場合のみ判定できる。同コンパイラのPART_LETTERS(A-J)はFM1-6/SSG1-3/ADPCMの10パートを
// 表し、配列indexの並びはFM_CHANNELS+SSG_CHANNELS+[ADPCM_CHANNEL]の並びと一致する
// (pmd_mml_parser.mjs冒頭コメント「A-F=FM1-6, G-I=SSG1-3, J=ADPCM」参照。
// JはADPCMパート実装(docs/pmd-compiler-spec-v2.md 1.2節、v2 step3)で追加された)。
// 重要: 同コンパイラはRHYTHM(K/R)を構造的に一切出力しない(K/Rの14bitマスクの
// `@`対応が未解明のため未実装、compiler/pmd_mml_compiler.mjs
// `// RHYTHM: K/Rは未解明のため未対応、空トラック`のとおり、該当ヘッダを常に
// EMPTY_TRACK_OFFで埋める)。そのためRHYTHMは「判定できない」のではなく
// 「このアプリでMML入力した曲では絶対に鳴らない」と確定できる事実であり、
// usedPartLettersに含まれることは無い(=常に未使用表示になる)。ADPCM(J)は
// 実際に使われていれば使用チャンネルとして検出される。
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
export const PMD_MML_PART_ORDER = [...FM_CHANNELS, ...SSG_CHANNELS, ADPCM_CHANNEL];

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

// レベルメーター列11-18(PPZ8 1-8)個別の論理チャンネル名。
// LEVEL_COLUMN_CHANNELS(0-10列。OPNA用マスクのみ)には含めない(PPZ8はOPNAの
// チャンネルではなく別ミキサーなので、buildMucomChannelMask/buildPmdChannelMask
// が組み立てるマスク値には出てこない。上のLEVEL_COLUMN_CHANNELSコメント参照)。
// unusedColumnsFromChannelsの第2引数(ppz8UsedChannels)、下のbuildPpz8Mask()、
// PMD_LEVEL_COLUMN_CHANNELSで使う。
export const PPZ8_CHANNELS = [
  'PPZ8_1', 'PPZ8_2', 'PPZ8_3', 'PPZ8_4', 'PPZ8_5', 'PPZ8_6', 'PPZ8_7', 'PPZ8_8',
];

// PMD専用: レベルメーター列0-18全部(=LEVEL_COLUMN_CHANNELS + PPZ8_CHANNELS)。
// 2026-08-18、PPZ8がPPZ8バンク読み込みで実際に鳴るようになったことを受けて
// PPZ8列(11-18)もクリックミュート/ホバー枠の対象にした(html/pmd-app.js
// LEVEL_COLUMN_HIT_CONFIG.columnCount、channelForLevelColumn()の第2引数、
// mutedColumnsFromChannels()の第2引数に渡す)。MUCOM88側(html/mucom-app.js)は
// PPZ8という概念自体を持たないため、LEVEL_COLUMN_CHANNELS(0-10列)のまま変えない。
export const PMD_LEVEL_COLUMN_CHANNELS = [...LEVEL_COLUMN_CHANNELS, ...PPZ8_CHANNELS];

// PPZ8用マスク値の組み立て(pmdweb/src/PmdCore.c pmdweb_set_ppz8_mask()へそのまま
// 渡す)。出典: upstream/98fmplayer/fmdriver/ppz8.c ppz8_mix() 200-208行、
// `for (int p = 0; p < 8; p++) { ... if ((1u << p) & (ppz8->mask)) continue; ... }`。
// pはppz8->channel[8]の配列indexそのもので、PPZ8_CHANNELS[p]='PPZ8_'+(p+1)と
// 1:1対応する(pmdweb/src/PmdCore.c build_levels()のlevels[11+p]/
// FMDRIVER_TRACK_PPZ8_1+pも同じp)。buildPmdChannelMask()のADPCM/リズムのような
// シフト・特殊ビット位置は無い、8bitフラットなマスクなのでビット位置=配列index。
// mutedSet: Set<string>(PPZ8_CHANNELSの文字列を含む集合。mutedChannelsをそのまま
// 渡してよい。PPZ8_CHANNELS以外の要素は無視される)。
export function buildPpz8Mask(mutedSet) {
  let mask = 0;
  PPZ8_CHANNELS.forEach((ch, i) => { if (mutedSet.has(ch)) mask |= (1 << i); });
  return mask >>> 0;
}

// usedChannelsを、レベルメーター描画用のSet<number>(未使用の列index)へ変換する。
//
// PPZ8列(11-18)の扱い(2026-08-17に一律unused判定として追加、2026-08-18に
// 曲ごとの判定へ差し替え):
//
// 2026-08-17時点では「本Web版はPPZ8のサンプルバンク(.PPC/.PVI)をUIから一切
// 読み込まない」という前提で、PPZ8列は常にunused固定にしていた。その後
// PPZ8バンク(.PZI/.PVI)を書庫から読み込めるようになり(該当コミット以降)、
// 実データで絶対値和が0から非0(2,525,364,434)へ変わることを確認済みで、
// この前提はもう成立しない。ただしMUCOM88側は今も無関係(fmgenにPPZ8相当の
// 実装が無く、概念自体が存在しない)なので、MUCOM側の呼び出し(第2引数省略)
// は従来どおり一律unusedのままにする。
//
// PMD側の判定材料(第2引数ppz8UsedChannels、Set<string>|null|undefined):
// 当初はPmdCore.c/fmdriver.hにある track_status[...].info と
// FMDRIVER_TRACK_INFO_PPZ8 の比較(PmdCore.c 209-211行、pmdweb/src/PmdCore.c)
// で判定できると想定していたが、実測(tools配下のwasmハーネスでPPZ8バンク無しの
// .M最小バイナリを再生し、ADPCMパートから0xB4=ppz8_init拡張コマンドで
// PPZ1chを起動)したところ:
//   - track_status[FMDRIVER_TRACK_PPZ8_1].info は起動有無に関わらず常に0
//     (FMDRIVER_TRACK_INFO_NORMAL)のまま。上流(upstream/98fmplayer/fmdriver/
//     fmdriver_pmd.c)を読むと、FMDRIVER_TRACK_INFO_PPZ8を実際にセットしている
//     のは fmdriver_fmp.c(このアプリが使わない別系統のドライバ)側のみで、
//     fmdriver_pmd.c の pmd_work_status_update() はPPZ8トラックにも常に
//     FMDRIVER_TRACK_INFO_NORMALを書く(5831行)。よってinfoでは判定不能
//     (推測が誤りだったことが実測で判明)。
//   - 一方 track_status[FMDRIVER_TRACK_PPZ8_1].playing はppz8_init起動前は0、
//     起動後は1に切り替わる(PPZ8バンクが読み込めていなくても切り替わる。
//     playingはPCMが実際に鳴っているかではなく「そのPPZ8チャンネルがpartとして
//     アクティブか」を表す駆動系の状態だから)。この値は既にflatten()経由で
//     JS側へ渡っている(fmdsp/trackrow.js FIELD.PLAYING=0、追加exportは不要)。
// そのため採用した規則: 曲の再生開始からこれまでの間に一度でも
// track_status[PPZ8_x].playing===trueを観測したチャンネルを「曲が使っている」と
// みなす(sticky。一度trueを観測したら曲が変わるまで使用中のまま。html/pmd-app.js
// が毎フレーム蓄積しppz8UsedChannelsとして渡す)。ppz8UsedChannelsがnull/undefined
// (MUCOM側、またはPMD側で意図的に判定不能とした場合)なら安全側で一律unusedへ
// フォールバックする。
export function unusedColumnsFromChannels(usedChannels, ppz8UsedChannels) {
  const columns = new Set();
  if (ppz8UsedChannels) {
    PPZ8_CHANNELS.forEach((ch, i) => { if (!ppz8UsedChannels.has(ch)) columns.add(PPZ8_LEVEL_COLUMN_START + i); });
  } else {
    for (let i = 0; i < PPZ8_LEVEL_COLUMN_COUNT; i += 1) columns.add(PPZ8_LEVEL_COLUMN_START + i);
  }
  if (!usedChannels) return columns;
  LEVEL_COLUMN_CHANNELS.forEach((ch, col) => { if (!usedChannels.has(ch)) columns.add(col); });
  return columns;
}
