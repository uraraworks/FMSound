// MUCOM88の `@"名前"` 形式の音色参照を `@番号` へ事前解決する。
//
// 背景(実測で確定済み。docs等の裏取り無しに再調査しないこと):
//   MUCOM88のZ80コンパイラは `@"名前"` の名前部分に非ASCIIバイト(半角カナ等)を
//   含むと必ず `FM Voice not found` で落ちる。
//     A @"flute"c   -> 通る(ASCII名)
//     A @"ｿｳﾙﾍﾞ"c    -> 落ちる(半角カナを含む)
//   ネイティブビルドでCP932生バイトを渡しても同じ結果になるため、embind/UTF-8の
//   符号化経路の問題ではなくZ80側の名前照合そのものの問題と判断した。
//   一方 `@n`(数値指定)はn=0..255の全件が実測で通る。
//   よって「`@"名前"` を、その名前が入っているスロット番号の `@番号` へ
//   事前置換する」ことで回避する。データ自体は既定音色バンクに正しく存在している
//   (半角カナ名のスロットも含め、バイト完全一致で実在する)。
//
// データの出所: ui/mucom-voice-table.js (tools/gen_mucom_voice_names.pyが
// upstream/MucomWeb/mucom88/src/bin_voice.h から生成した既定音色バンクの
// 「スロット番号 -> 名前(生6バイト)」表。upstream/はgitignore対象でビルド時にしか
// 存在しないため、このモジュールはそれを実行時に読みに行かず、生成済みの
// ui/mucom-voice-table.js だけに依存する)。
//
// 名前の埋め方(パディング)がスロットにより不統一(末尾を空白0x20で埋めるものが
// 大半だが、NUL 0x00で埋めているものも実在する)なので、名前の同一性判定は
// 「末尾の空白(0x20)とNUL(0x00)を取り除いた残りのバイト列が一致するか」で行う。
// 全6バイトが空白またはNULだけ(=中身が無い)のスロットは名前表に含めない。
//
// 重複名について: 上記の正規化後、実データに6件の重複がある(実測、
// tools/verify_mucom_voice_name.mjs参照): 'efctes'(slot0/192), '??????'(slot75/83),
// '7thv01'(slot122/126), '7thv05'(slot175/205), 'p_brs3'(slot176/194),
// 'sbass3'(slot193/196)。同じ名前でも音色の中身(FM/SSGパラメータ)が同一である
// 保証は無いが、名前だけを頼りに `@"名前"` と書いた利用者にとってどちらが
// 「正解」かを判断する材料が無い。よって単純に「最初に見つかった方
// (スロット番号が小さい方)を採用する」とする(推測で優先順位を作らない)。
//
// 名前の比較はCP932の生バイト列で行う(JSの文字列比較にすると半角カナの扱いで
// 事故る。ui/cp932-encode.jsのencodeCp932()で符号化してから比較する)。

import { MUCOM_DEFAULT_VOICE_NAMES } from './mucom-voice-table.js';
import { encodeCp932 } from './cp932-encode.js';

const NAME_FIELD_LENGTH = 6; // voiceformat.h: name[6]

/** 16進文字列(nameHex)をUint8Arrayへ。 @param {string} hex */
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** 末尾の空白(0x20)とNUL(0x00)を取り除く。 @param {Uint8Array} bytes */
function trimTrailingPad(bytes) {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0x20 || bytes[end - 1] === 0x00)) end--;
  return bytes.subarray(0, end);
}

/** 正規化済みバイト列を、Mapのキーに使える文字列へ(16進表現)。 @param {Uint8Array} bytes */
function toKey(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

let cachedTable = null;

/** 「名前(正規化後の生バイト列を16進化したキー) -> スロット番号」の表を作る(遅延構築・キャッシュ)。 */
function buildTable() {
  if (cachedTable) return cachedTable;
  const map = new Map();
  for (const { slot, nameHex } of MUCOM_DEFAULT_VOICE_NAMES) {
    const trimmed = trimTrailingPad(hexToBytes(nameHex));
    if (trimmed.length === 0) continue; // 中身の無い名前は対象にしない
    const key = toKey(trimmed);
    if (!map.has(key)) map.set(key, slot); // 重複は最初に見つかった方(スロット番号が小さい方)を採る
  }
  cachedTable = map;
  return cachedTable;
}

/**
 * 音色名(JS文字列)を、既定音色バンク中のスロット番号へ解決する。
 * 見つからない場合や、CP932へ変換できない文字を含む場合はnullを返す。
 * @param {string} name
 * @returns {number | null}
 */
export function resolveVoiceNameToSlot(name) {
  const { bytes, unmappable } = encodeCp932(name);
  if (!bytes || unmappable.length > 0) return null;
  if (bytes.length > NAME_FIELD_LENGTH) return null; // 6バイトの名前フィールドに収まらない
  const table = buildTable();
  // 名前フィールド側のキーは正規化(末尾パディング除去)済みなので、MML側にも同じ規則を
  // 適用してから比較する。
  //
  // 【不具合修正・2026-08-16】以前はMML側に trimTrailingPad() を掛けておらず、
  // 表側だけが正規化された非対称な比較になっていた。そのため MML が
  // `@"ｿｳﾙﾍﾞ "` のように末尾へ空白を付けて書いていると解決できなかった
  // (実測: `ｿｳﾙﾍﾞ`→201 に対し `ｿｳﾙﾍﾞ `→null。半角カナ固有ではなく `flute ` でも同じ)。
  // 名前フィールドは6バイトの空白詰め固定長で末尾の空白に意味が無いため、
  // 両側を同じ規則で正規化するのが正しい。実データでは stk023(BARE_KNUCKLE)が
  // これに該当し、唯一解決できない曲として残っていた。
  const key = toKey(trimTrailingPad(bytes));
  return table.has(key) ? table.get(key) : null;
}

// `@"..."` の形にマッチする箇所だけを対象にする正規表現。単純な文字列置換
// (MML本文中の別の同じ綴りの箇所やコメント相当の記述を巻き込む事故)を避けるため、
// この構文に一致した部分だけを置換対象にする。
const VOICE_NAME_REF_RE = /@"([^"]*)"/g;

/**
 * MML本文中の `@"名前"` 参照を、解決できたものだけ `@番号` へ置き換える。
 * 表に無い名前は置換しない(そのまま残す。無理に番号を割り当てて「通ったこと」に
 * しない)。
 * @param {string} mmlText
 * @returns {{ text: string, replacedCount: number, unresolvedNames: string[] }}
 */
export function resolveMucomVoiceNameRefs(mmlText) {
  let replacedCount = 0;
  const unresolvedNames = [];
  const text = mmlText.replace(VOICE_NAME_REF_RE, (whole, name) => {
    const slot = resolveVoiceNameToSlot(name);
    if (slot === null) {
      unresolvedNames.push(name);
      return whole;
    }
    replacedCount++;
    return `@${slot}`;
  });
  return { text, replacedCount, unresolvedNames };
}
