// PMDの外部音色ファイル(`#FFFile`、拡張子`.FF`)をどれに絞り込むかの窓口。DOM非依存
// (net/pmd-pcm.js collectPmdPcmFiles()・net/pmd-mml-source.js findMmlSourceEntry()と
// 同じ流儀。html/pmd-app.jsと検証の両方から同じ関数を本番経路として通す)。
//
// compiler/配下のパーサ(pmd_mml_parser.js)が`#FFFile`ヘッダを既に読んでいる
// (header.fffile)が、そちらは「コンパイラが実際に使う生バイト列」を受け取る側
// (compileMmlのffFileオプション)であって、「書庫の中のどの.FFエントリを使うか」を
// 決める責務は持たない(パーサはファイルシステムを知らない)。この判断は
// UI側(html/pmd-app.js、書庫を開いた時点)の仕事なので、ここに置く。
//
// あえてcompiler/への依存を作らず、`#FFFile`ヘッダの正規表現をこのファイル単独で
// 複製している(compiler/pmd_mml_parser.js FFFILE_HEADER_RE と同じパターン)。
// 別のエージェントがcompiler/配下を同時に作業中のため、依存を持つと巻き込まれる。

import { baseNameOf, dirNameOf } from './archive.js';

const FF_EXTENSION_RE = /\.ff$/i;

// compiler/pmd_mml_parser.js FFFILE_HEADER_RE と同じパターン(上のコメント参照)。
const FFFILE_HEADER_RE = /^[ \t]*#FFFile[ \t]+(.*)$/im;

/**
 * MMLソーステキストから`#FFFile`ヘッダの指定ファイル名を取り出す。見つからなければnull。
 * @param {string | null} mmlSource
 * @returns {string | null}
 */
export function extractFfFileHeaderName(mmlSource) {
  if (!mmlSource) return null;
  const m = FFFILE_HEADER_RE.exec(mmlSource);
  if (!m) return null;
  const name = m[1].trim();
  return name.length > 0 ? name : null;
}

/** @param {string} name */
function stripExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

/**
 * 書庫展開エントリ配列から`.FF`拡張子だけを拾う純関数(collectPmdPcmFiles()と対)。
 * @param {{name: string, data: Uint8Array}[]} entries
 * @returns {{name: string, data: Uint8Array}[]}
 */
export function collectFfCandidates(entries) {
  if (!entries) return [];
  return entries.filter((e) => FF_EXTENSION_RE.test(e.name));
}

/**
 * 曲(songEntryName)に対して使う`.FF`を1つ選ぶ唯一の窓口。
 *
 * 選択規則(利用者指示、決め打ちしない部分を明記する):
 *  1. MMLに`#FFFile`ヘッダがあれば、そのbasename(拡張子は`.FF`、大文字小文字無視)と
 *     一致する候補を探す。一致する候補が複数ディレクトリにまたがる場合は、曲と
 *     同じディレクトリのものを優先する(collectPmdPcmFiles()の「同名PCM取り違え」
 *     修正=コミット6de2839と同じ罠・同じ対処。別ディレクトリの同名`.FF`を誤って
 *     拾わないようにする)。同じディレクトリに無ければ、他ディレクトリの一致候補
 *     (出現順最初)を使う(共有音色バンクが別フォルダに置かれる構成もありうるため、
 *     PCMと同様に切り捨てない)。この場合も`matchedHeaderName: true`(名前は一致して
 *     いるため)。
 *  2. `#FFFile`ヘッダが無い、またはヘッダ名と一致する候補が1つも無い場合は、
 *     曲と同じディレクトリの`.FF`を使ってよい(見つかればフォールバック採用、
 *     出現順最初)。ヘッダが無いのに他ディレクトリへまで探しにいく理由が無いため、
 *     このフォールバックは同じディレクトリ限定とする(1.との非対称、意図的)。
 *  3. どちらにも該当が無ければnull(=この曲に使える`.FF`が無い)。
 *
 * 戻り値のmatchedHeaderNameは「曲が指定した名前と同じものを使えたか」を表す。false
 * (フォールバック採用)の場合、曲が指定した名前と違うファイルを黙って使っていることを
 * 呼び出し側が案内できるようにするためのフラグ(describePmdFfStatus()参照)。
 *
 * @param {{name: string, data: Uint8Array}[]} entries 書庫展開エントリ配列全体
 * @param {string} songEntryName 選ばれた曲の書庫内エントリ名(entry.name。basenameでは
 *   なくパスを含む実際の名前を渡すこと)
 * @param {string | null} mmlSource 曲のMMLソーステキスト(`#FFFile`ヘッダ抽出用。
 *   MMLソースを持たない曲(単体`.M`直接再生等)はnullでよい=ヘッダ無し扱いになる)
 * @returns {{ data: Uint8Array, name: string, matchedHeaderName: boolean } | null}
 */
export function selectFfFileForSong(entries, songEntryName, mmlSource) {
  const candidates = collectFfCandidates(entries);
  if (candidates.length === 0) return null;
  const songDir = dirNameOf(songEntryName);

  const headerName = extractFfFileHeaderName(mmlSource);
  if (headerName) {
    const wantBase = stripExt(baseNameOf(headerName)).toLowerCase();
    const matched = candidates.filter((c) => stripExt(baseNameOf(c.name)).toLowerCase() === wantBase);
    if (matched.length > 0) {
      const sameDir = matched.filter((c) => dirNameOf(c.name) === songDir);
      const chosen = (sameDir.length > 0 ? sameDir : matched)[0];
      return { data: chosen.data, name: baseNameOf(chosen.name), matchedHeaderName: true };
    }
  }

  // ヘッダ名との一致が無い場合のフォールバック: 同じディレクトリの.FFのみ(他
  // ディレクトリへは広げない。上のコメント2.参照)。
  const sameDirAny = candidates.filter((c) => dirNameOf(c.name) === songDir);
  if (sameDirAny.length === 0) return null;
  return { data: sameDirAny[0].data, name: baseNameOf(sameDirAny[0].name), matchedHeaderName: false };
}

/**
 * .FF選択結果から利用者向けメッセージを組み立てる純関数(net/pmd-pcm.js
 * describePmdPcmStatus()と同じ設計。文言はui/i18n.jsに置き、ここではキーと引数だけ
 * 決める)。
 *
 * 判定規則:
 *  - MMLが`#FFFile`を使っていない(headerName===null)曲には何も言わない(使っても
 *    いない機能について案内しても意味が無い)。
 *  - `#FFFile`を使っているのに.FFが1つも見つからなかった(ffSelection===null)場合:
 *    「必要だが見つからなかった」を知らせる(見つからないまま黙ってコンパイルが
 *    失敗する=無言で失敗、を避ける)。
 *  - .FFは見つかったが曲が指定した名前とは違う(matchedHeaderName===false)場合:
 *    「代わりに別の.FFを使っている」ことを知らせる(黙って違う音色バンクを
 *    使わない)。
 *  - 名前が一致した(matchedHeaderName===true)場合は何も言わない(期待通りなので
 *    案内不要)。
 * @param {{ headerName: string|null, ffSelection: {name: string, matchedHeaderName: boolean}|null }} args
 * @returns {{key: string, params: object}[]}
 */
export function describePmdFfStatus({ headerName, ffSelection }) {
  if (!headerName) return [];
  if (!ffSelection) {
    return [{ key: 'pmd.ff.missing', params: { file: headerName } }];
  }
  if (!ffSelection.matchedHeaderName) {
    return [{ key: 'pmd.ff.nameMismatch', params: { wanted: headerName, used: ffSelection.name } }];
  }
  return [];
}
