// PMD86 の `.P86` PCM を YM2608 ADPCM(`.PPC`相当)へ変換する純関数モジュール。
// DOM非依存(net/pmd-pcm.js の作法に合わせる)。結線(html/pmd-app.js等からの
// 呼び出し)は次段階の担当で、このファイルはまだどこからも呼ばれない。
//
// --- 変換方式(1:1・リサンプルなし)の根拠(実測、2026-08-19確定) ---
// 参照実装 pmdmini(.P86 ネイティブ対応)を別プロセスのオラクルとして、同一の
// .M ファイルの ADPCM パート出力波形をピッチ比較した(tools/experiment_p86_to_ppc.mjs
// / tools/experiment_p86_pitch_check.mjs)。高信頼5件の周波数比(実測/期待)は
// 1.032 / 1.051 / 1.070 / 0.928 / 1.110(平均1.038、変動係数5.9%)で、1.00 を挟んで
// ばらついており系統的なずれは検出されなかった(ばらつきの主因は実楽器サンプルの
// 非周期性で、ピッチ検出器自体は正弦波で誤差0.05%と別途検証済み)。したがって
// サンプルレート変換(リサンプル)は行わず、P86の8bitサンプル列をそのまま1:1で
// ADPCM-Bへエンコードする。途中で出た補正係数0.8763は自己参照の物差しによる
// 誤りであり採用していない。
//
// --- .PPC形式・アドレス単位の根拠 ---
// upstream/98fmplayer/fmdriver/fmdriver_pmd.c の pmd_ppc_load()(6072行付近)を
// 唯一の正典として確定した(upstream/pmdmini は GPL のため参照禁止、読んでいない)。
// ヘッダは30B固定文字列 "ADPCM DATA for  PMD ver.4.4-  " + 予約2B + 256エントリ
// ×(start u16 LE, stop u16 LE)(offset32から、合計1056B)。データ本体は1056B目から
// 順にopnaレジスタ0x108へ書き込まれる「連続バイトストリーム」であり、途中でシーク
// する仕組みは無い(=エントリ間の隙間はストリーム中に実際にゼロバイトを挿入して
// 作る必要がある)。
// アドレス単位は「1レジスタ=32バイト」(PMDドライバが ADPCM 初期化時・ノートオン時に
// 常に control2 レジスタへ C2_8BIT ビット(0x02)を立てるため、libopna/opnaadpcm.c の
// addr_conv() は reg<<6 の8bitモード相当になり、バイトアドレス=(reg<<6)>>1=reg*32)。
// これは前の作業者が4バイトと誤読して測定を1回無駄にした箇所であり、
// tools/experiment_p86_to_ppc.mjs で実機再現の上訂正・確認済み。
// pmd_ppc_load() は実データを書き込む前に ADPCM RAM の先頭 0x4c0(1216)バイトぶん
// ゼロを書き込む(reg0x108への空書き込みループ)。ここは全曲共通の予約領域であり、
// 実データはこの直後(=レジスタ換算で 1216/32=38 レジスタ目)から配置する。

const P86_MAGIC = 'PCM86 DATA\n\0';
const P86_HEADER_LEN = 16; // magic(12B) + version(1B) + 全体長3B(LE)
const P86_ENTRY_SIZE = 6; // 開始オフセット3B(LE) + 長さ3B(LE)
const P86_ENTRY_COUNT = 256;

const PPC_MAGIC = 'ADPCM DATA for  PMD ver.4.4-  ';
const PPC_TABLE_OFFSET = 32; // ヘッダ30B + 予約2B
const PPC_HEADER_SIZE = 30 + 2 + 4 * 256; // 1056(0x420)。pmd_ppc_load() PPC_HEADER_SIZEと同値
const BYTES_PER_REG = 32; // 1レジスタ=32バイト(上記コメント参照)
const PADDING_BYTES = 0x4c0; // pmd_ppc_load()が実データ前にゼロ埋めする先頭予約領域
const PADDING_REGS = PADDING_BYTES / BYTES_PER_REG; // 38。1216は32の倍数なので割り切れる
const ADPCM_RAM_BYTES = 256 * 1024; // YM2608 ADPCM RAMの物理容量(256KB)
const MAX_REG_VALUE = 0xffff; // start/stopはu16フィールド

const ADPCM_STEP_TABLE = [57, 57, 57, 57, 77, 102, 128, 153];

function readU24LE(bytes, off) {
  return bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16);
}

/**
 * `.P86` バイト列を検証してパースする。ヘッダ不一致・データ不足など
 * 「これは.P86ではない/壊れている」場合は例外を投げず null を返す
 * (呼び出し側が判定できるようにするため)。
 *
 * @param {Uint8Array} bytes
 * @returns {{version: number, totalLen: number,
 *   entries: {start: number, length: number}[]} | null}
 */
export function parseP86(bytes) {
  if (!bytes || bytes.length < P86_HEADER_LEN) return null;
  for (let i = 0; i < P86_MAGIC.length; i++) {
    if (bytes[i] !== P86_MAGIC.charCodeAt(i)) return null;
  }
  const version = bytes[12];
  const totalLen = readU24LE(bytes, 13);
  const entries = [];
  for (let i = 0; i < P86_ENTRY_COUNT; i++) {
    const off = P86_HEADER_LEN + i * P86_ENTRY_SIZE;
    if (off + P86_ENTRY_SIZE > bytes.length) return null; // テーブルが途中で切れている
    entries.push({ start: readU24LE(bytes, off), length: readU24LE(bytes, off + 3) });
  }
  return { version, totalLen, entries };
}

/**
 * 目標値列(Int16Array相当、-32768..32767)を YM2608 ADPCM-B(4bit差分符号化)へ
 * 貪欲選択でエンコードする。upstream/98fmplayer/libopna/opnaadpcm.c の
 * adpcm_calc()(デコード式)を読んで逆方向にしたもの(GPL版であるpmdminiの
 * p86drv.cppは参照していない)。
 *
 * @param {Int16Array | number[]} targets
 * @returns {Uint8Array} nibble2個/バイトに詰めたADPCMデータ(先頭が上位nibble)
 */
export function encodeAdpcmB(targets) {
  let acc = 0;
  let adpcmd = 127; // opna_adpcm_reset()の初期値
  const nibbles = new Uint8Array(targets.length);
  for (let n = 0; n < targets.length; n++) {
    const target = targets[n];
    let bestCode = 0;
    let bestErr = Infinity;
    let bestAcc = acc;
    let bestD = adpcmd;
    for (let code = 0; code < 16; code++) {
      let accD = ((code & 7) << 1) | 1;
      if (code & 8) accD = -accD;
      let newAcc = acc + Math.trunc((accD * adpcmd) / 8);
      if (newAcc < -32768) newAcc = -32768;
      if (newAcc > 32767) newAcc = 32767;
      const err = Math.abs(newAcc - target);
      if (err < bestErr) {
        bestErr = err;
        bestCode = code;
        bestAcc = newAcc;
        let newD = Math.trunc((adpcmd * ADPCM_STEP_TABLE[code & 7]) / 64);
        if (newD < 127) newD = 127;
        if (newD > 24576) newD = 24576;
        bestD = newD;
      }
    }
    nibbles[n] = bestCode;
    acc = bestAcc;
    adpcmd = bestD;
  }
  // pack: adpcm_calc()は ramptr偶数(先頭)でdata>>=4(上位nibble)、奇数でdata&=0x0f
  // (下位nibble)を使う。ramptrはstartから0基点で増える。
  const bytes = new Uint8Array(Math.ceil(nibbles.length / 2));
  for (let i = 0; i < nibbles.length; i++) {
    const byteIdx = i >> 1;
    if ((i & 1) === 0) bytes[byteIdx] |= (nibbles[i] & 0xf) << 4;
    else bytes[byteIdx] |= nibbles[i] & 0xf;
  }
  return bytes;
}

// P86の符号付き8bitサンプル1個をADPCM-Bのターゲット(16bit)域へ引き伸ばす。
// リサンプルはしない(1:1変換。上記コメントの実測根拠を参照)。
function p86SampleToTarget(signed8) {
  const v = signed8 * 256;
  if (v < -32768) return -32768;
  if (v > 32767) return 32767;
  return v;
}

/**
 * `.P86` の生バイト列を YM2608 ADPCM(擬似`.PPC`)のバイト列へ変換する。
 *
 * 失敗は例外ではなく `{ ok: false, error, message, ... }` で返す。
 * - error: 'invalid_p86'  … .P86として解釈できない(ヘッダ不一致/範囲不正)
 * - error: 'capacity'     … ADPCM RAM(256KB)に収まらない。requiredBytes/maxBytesを添える
 *
 * @param {Uint8Array} bytes .P86ファイルの生バイト列
 * @returns {{ok: true, bytes: Uint8Array, usedEntryCount: number, requiredBytes: number}
 *   | {ok: false, error: 'invalid_p86' | 'capacity', message: string,
 *      requiredBytes?: number, maxBytes?: number}}
 */
export function p86ToPpc(bytes) {
  const parsed = parseP86(bytes);
  if (!parsed) {
    return { ok: false, error: 'invalid_p86', message: '.P86として認識できないデータです(ヘッダ不一致、またはエントリテーブルが途中で切れています)' };
  }
  const { entries } = parsed;

  // 使用中(length>0)のエントリだけをADPCM-Bへエンコードする。
  const packed = new Array(P86_ENTRY_COUNT).fill(null);
  for (let i = 0; i < P86_ENTRY_COUNT; i++) {
    const e = entries[i];
    if (!e || e.length <= 0) continue;
    if (e.start < 0 || e.start + e.length > bytes.length) {
      return {
        ok: false,
        error: 'invalid_p86',
        message: `.P86のエントリ${i}が実際のファイル範囲を超えています(start=${e.start}, length=${e.length}, ファイル長=${bytes.length})`,
      };
    }
    const targets = new Int16Array(e.length);
    for (let j = 0; j < e.length; j++) {
      // bytes[e.start+j] は0..255のuint8。符号付き8bitとして解釈する。
      const raw = bytes[e.start + j];
      const signed8 = raw > 127 ? raw - 256 : raw;
      targets[j] = p86SampleToTarget(signed8);
    }
    packed[i] = encodeAdpcmB(targets);
  }

  // --- レイアウト決定(容量ガードのため、実際のバイト列組み立て前に位置を確定する) ---
  // pmd_ppc_load()はデータを「連続バイトストリーム」としてopnaレジスタへ順次書き込む
  // (シーク不可)。エントリ間に隙間を作るにはストリーム中に実際にゼロバイトを挿む
  // 必要がある。各エントリの終端には安全マージンとして1レジスタぶんのゼロを残す
  // (tools/experiment_p86_to_ppc.mjsで実機再生確認済みの配置と同じ考え方)。
  let cursorReg = PADDING_REGS;
  const placements = new Array(P86_ENTRY_COUNT).fill(null);
  for (let i = 0; i < P86_ENTRY_COUNT; i++) {
    const payload = packed[i];
    if (!payload) continue;
    const regsForPayload = Math.ceil(payload.length / BYTES_PER_REG);
    const startReg = cursorReg;
    const stopReg = startReg + regsForPayload + 1; // +1: 安全マージン(次エントリとの境界)
    placements[i] = { startReg, stopReg, payload };
    cursorReg = stopReg;
  }

  // --- 容量ガード ---
  // 成立すべき不等式(実行時に検査する。「たぶん収まる」で通さない):
  //   (1) requiredBytes = cursorReg * BYTES_PER_REG <= ADPCM_RAM_BYTES (256KB)
  //   (2) cursorReg <= MAX_REG_VALUE (start/stopがu16フィールドのため)
  // どちらかを満たさない場合は黙って切り詰めず、必要量/上限の実数値を添えて失敗を返す。
  const requiredBytes = cursorReg * BYTES_PER_REG;
  if (requiredBytes > ADPCM_RAM_BYTES || cursorReg > MAX_REG_VALUE) {
    return {
      ok: false,
      error: 'capacity',
      message: `変換後のADPCMデータがADPCM RAM(${ADPCM_RAM_BYTES}バイト)に収まりません(必要${requiredBytes}バイト)`,
      requiredBytes,
      maxBytes: ADPCM_RAM_BYTES,
    };
  }

  // --- .PPCバイト列の組み立て ---
  const streamLength = (cursorReg - PADDING_REGS) * BYTES_PER_REG;
  const out = new Uint8Array(PPC_HEADER_SIZE + streamLength);
  for (let i = 0; i < PPC_MAGIC.length; i++) out[i] = PPC_MAGIC.charCodeAt(i);
  // offset 30,31 は予約(未使用)。ゼロのまま。

  let usedEntryCount = 0;
  let streamOff = 0;
  for (let i = 0; i < P86_ENTRY_COUNT; i++) {
    const placement = placements[i];
    const tableOff = PPC_TABLE_OFFSET + 4 * i;
    if (!placement) {
      // 未使用エントリ: start=stop=0(無音扱い)。outはゼロ初期化済みなので何もしない。
      continue;
    }
    usedEntryCount += 1;
    const { startReg, stopReg, payload } = placement;
    out[tableOff] = startReg & 0xff;
    out[tableOff + 1] = (startReg >> 8) & 0xff;
    out[tableOff + 2] = stopReg & 0xff;
    out[tableOff + 3] = (stopReg >> 8) & 0xff;

    out.set(payload, PPC_HEADER_SIZE + streamOff);
    const regsForPayload = stopReg - startReg; // マージン込みのレジスタ数
    streamOff += regsForPayload * BYTES_PER_REG; // 残りはゼロ埋め済み(Uint8Array初期値)
  }

  return { ok: true, bytes: out, usedEntryCount, requiredBytes };
}

export const __internal = {
  P86_MAGIC,
  P86_HEADER_LEN,
  P86_ENTRY_SIZE,
  P86_ENTRY_COUNT,
  PPC_MAGIC,
  PPC_TABLE_OFFSET,
  PPC_HEADER_SIZE,
  BYTES_PER_REG,
  PADDING_BYTES,
  PADDING_REGS,
  ADPCM_RAM_BYTES,
  MAX_REG_VALUE,
};
