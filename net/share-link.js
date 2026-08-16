// 曲(MMLテキスト)をURLのフラグメント(`#`以降)に載せて共有するためのエンコード/デコード。
//
// 解く問題: 曲を作っても、Xなどで共有するにはどこかへアップロードする必要がある。
// アカウントを持たない人には手段がない。→ 曲そのものをURLのフラグメントに載せる。
// フラグメントはサーバーへ送信されないため、GitHub Pagesのような静的ホスティングの
// ままで完結する(利用者判断、確定済みの設計)。
//
// 対象は「エディタのMMLテキスト1本」だけ(d88やディスクイメージは対象外。
// 第三者の作品の再配布経路になるため、利用者判断で明確に除外している)。
//
// 形式: `#s1=<gzipしたMMLのUTF-8バイト列をbase64urlにしたもの>`
//   - `s1`の`1`は形式のバージョン。**必須**。告知に使ったリンクは後から差し替えられないため、
//     将来圧縮方式や前処理を変えたときに古いリンクが黙って壊れないようにする
//     (未知のバージョンは`decodeShareFragment()`がエラーとして扱う)。
//   - base64url: `+`→`-`、`/`→`_`、末尾の`=`パディングは落とす。
//   - 圧縮: `CompressionStream('gzip')` / `DecompressionStream('gzip')`(Node 25で確認済み。
//     ブラウザ・Node両方に存在する標準API、追加npm依存なし)。
//
// 実測(利用者=親セッションが本番のXへ実投稿して確認した事実。手元では確かめようがない):
//   - URLは実際の長さに関わらず一律23文字としてカウントされる
//   - `#`以降のフラグメントはt.coを往復しても保存される(3,528字で往復確認済み)
//   - 全長4,000字は通る。4,090字は通らない(リンク扱いされず生の文字列として数えられる)
//     → 上限は4,000字とする(SHARE_LINK_URL_LIMIT)
//   - 実曲46本(MUCOM88サンプル集)の最大はgzip+base64で全長3,528字。全曲収まる
//
// net/層の作法(net/archive-util.js netError()参照)に合わせ、この層は日本語/英語の
// 文言を持たない。エラーはerr.code(+params)だけを持ち、表示文言はui/i18n.jsの
// `net.error.share.*` キーから引く(呼び出し側はui/net-error.js describeNetError()経由)。

import { netError } from './archive-util.js';

/** 現行の形式バージョン。フラグメントの `#<version>=<payload>` の version 部分。 */
export const SHARE_LINK_VERSION = 's1';

/**
 * 共有リンクの全長の上限(文字数)。本番のXへの実投稿で4,000字は通り、4,090字は
 * リンク扱いされず生の文字列として数えられて通らないことを実測済み(ファイル冒頭参照)。
 * 実測結果と実測結果の間(4,000〜4,090)のどこかに境界があるはずだが、確認できたのは
 * この2点だけなので、安全側に倒して確認済みの通過点である4,000をそのまま上限に採用する。
 */
export const SHARE_LINK_URL_LIMIT = 4000;

/**
 * 展開後(gzip解凍後)サイズの上限(バイト)。フラグメントは第三者が作ったリンクから
 * 来うるため、悪意ある圧縮データ(展開すると巨大になるもの、いわゆるzip爆弾の類)で
 * タブが固まらないよう上限を設け、超えたら展開を打ち切ってエラーにする。
 * 根拠: 実物のMML(46曲収録のMUCOM88サンプル集)は圧縮前でも数KB〜数十KB程度で、
 * 圧縮後の全長上限(4,000字 ≒ base64urlで3,000バイト強)から見ても圧縮前は
 * 数十KBが上限になる計算。1MBはその100倍以上の余裕を持たせつつ、10MB・100MB級の
 * 展開爆弾は確実に止められる値として選んだ(エディタに入るのはテキストだけで
 * 実行はされないため、防ぐべきは「巨大な文字列でタブを固める」ことだけ)。
 */
export const MAX_DECOMPRESSED_BYTES = 1024 * 1024;

/** @param {Uint8Array} bytes @returns {string} */
function base64UrlEncode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** @param {string} str @returns {Uint8Array} */
function base64UrlDecode(str) {
  // base64urlは大文字小文字・'-'/'_' 以外の文字を含まない。混入していたら不正とみなす
  // (atob()自体はスペース等一部の文字を無言で許容するため、事前に検査する)。
  if (!/^[A-Za-z0-9_-]*$/.test(str)) throw netError('share.invalidBase64');
  const normal = str.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normal + '='.repeat((4 - (normal.length % 4)) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw netError('share.invalidBase64');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** @param {Uint8Array} bytes @returns {Promise<Uint8Array>} */
async function gzipCompress(bytes) {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  // awaitしない: write()はストリームがdrainするまで待つことがあるが、close()と
  // 合わせて先に投げておき、読み出し側(Response経由)で完結を待てば十分
  // (net/lzh.js等と違い巨大データではないため、ここでは素直に書いてから閉じる)。
  writer.write(bytes).catch(() => {});
  writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

/**
 * gzip展開する。展開後サイズがMAX_DECOMPRESSED_BYTESを超えたら、全部読み切る前に
 * 打ち切ってエラーにする(悪意ある圧縮データ対策、ファイル冒頭コメント参照)。
 * 不正なgzipデータ(壊れたヘッダ/ストリーム)はDecompressionStreamが例外を投げるので、
 * それをnetError('share.invalidGzip')へ変換する。
 * @param {Uint8Array} bytes @returns {Promise<Uint8Array>}
 */
async function gzipDecompress(bytes) {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  // write()/close()の失敗は、同じ壊れをreader.read()側が検出して例外を投げるため
  // そちらで扱う。ここではPromiseを未処理rejectionにしないためだけにcatchしておく。
  const writeAndClose = (async () => {
    try {
      await writer.write(bytes);
      await writer.close();
    } catch {
      // 意図的に握りつぶす(上記コメント参照)。
    }
  })();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_DECOMPRESSED_BYTES) {
        throw netError('share.decodedTooLarge', { limit: MAX_DECOMPRESSED_BYTES });
      }
      chunks.push(value);
    }
  } catch (err) {
    try { await reader.cancel(); } catch { /* 打ち切り済みなら無視 */ }
    await writeAndClose;
    // すでにこちらで作った(share.*)エラーはそのまま素通しする。それ以外
    // (DecompressionStream/Node zlibが投げる元のエラー。Node実装は`err.code`に
    // 'Z_DATA_ERROR'のような独自コードを持つため、単純な「codeプロパティの有無」
    // では見分けがつかない。netError()由来かどうかを'share.'接頭辞で判定する)
    // はgzipとして不正だったとみなす。
    if (err && typeof err === 'object' && typeof (/** @type {any} */ (err).code) === 'string' && err.code.startsWith('share.')) {
      throw err;
    }
    throw netError('share.invalidGzip');
  }
  await writeAndClose;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * MMLテキスト(UTF-8として扱う)を共有フラグメントの中身(`s1=...`、先頭の`#`は含まない)
 * へエンコードする。UTF-8バイト列 → gzip → base64url の順(ファイル冒頭コメント参照)。
 * @param {string} mmlText
 * @returns {Promise<string>} 例: `s1=H4sIAAAAAAAA...`
 */
export async function encodeShareFragment(mmlText) {
  const bytes = new TextEncoder().encode(mmlText);
  const compressed = await gzipCompress(bytes);
  return `${SHARE_LINK_VERSION}=${base64UrlEncode(compressed)}`;
}

/**
 * 共有リンクの全長(文字数)から、上限(SHARE_LINK_URL_LIMIT)を超えているかどうかと
 * 超過分の文字数を算出する純粋関数。次ラウンドのカウンタ/ゲージ表示が使う
 * (エンコードのやり直しを伴わずに再計算できるよう、長さだけを受け取る形にしてある)。
 * @param {number} length
 * @returns {{ limit: number, length: number, remaining: number, overLimit: boolean, overBy: number }}
 */
export function shareLinkLengthStatus(length) {
  const remaining = SHARE_LINK_URL_LIMIT - length;
  return {
    limit: SHARE_LINK_URL_LIMIT,
    length,
    remaining: Math.max(0, remaining),
    overLimit: length > SHARE_LINK_URL_LIMIT,
    overBy: Math.max(0, -remaining),
  };
}

/**
 * 共有URL本体を組み立てる。`?driver=`を必ず含める(含めないとMUCOM88の曲がPMDで
 * 開かれてしまうため)。MML以外(d88・書庫)は対象外なので、既存のクエリパラメータ
 * (`?mml=`等)は引き継がない(baseHrefのうちoriginとpathnameだけを使う)。
 * @param {{ mmlText: string, driver: 'mucom'|'pmd', baseHref: string }} input
 *   baseHrefは`location.href`相当(呼び出し側から渡す。Node環境等`location`が無い場所
 *   からも呼べるようにするため必須引数にしている)。
 * @returns {Promise<{ url: string, length: number, status: ReturnType<typeof shareLinkLengthStatus> }>}
 */
export async function buildShareUrl({ mmlText, driver, baseHref }) {
  const url = new URL(baseHref);
  url.search = '';
  url.searchParams.set('driver', driver);
  const fragment = await encodeShareFragment(mmlText);
  url.hash = fragment;
  const full = url.toString();
  return { url: full, length: full.length, status: shareLinkLengthStatus(full.length) };
}

/**
 * `location.hash`相当の文字列(先頭の`#`はあってもなくてもよい)から共有フラグメントを
 * 復元し、元のMMLをUTF-8バイト列として返す。
 *
 * 返り値:
 *   - フラグメントが空(共有リンクではない通常のアクセス) -> null
 *   - `#s1=...`(現行バージョン) -> Uint8Array(MMLのUTF-8バイト列)
 *   - それ以外(`#s2=`等の未知バージョン、`=`が無い、base64/gzipとして不正、
 *     展開後サイズが上限超過) -> netError()で例外を投げる(呼び出し側は
 *     ui/net-error.js describeNetError()で利用者向け文言に変換すること。
 *     無言で失敗したり化けたテキストをエディタに入れたりしない、という要件のため)。
 * @param {string} hash
 * @returns {Promise<Uint8Array | null>}
 */
export async function decodeShareFragment(hash) {
  const raw = typeof hash === 'string' && hash.startsWith('#') ? hash.slice(1) : (hash ?? '');
  if (!raw) return null;
  const eq = raw.indexOf('=');
  if (eq < 0) throw netError('share.malformed');
  const version = raw.slice(0, eq);
  const payload = raw.slice(eq + 1);
  if (version !== SHARE_LINK_VERSION) throw netError('share.unknownVersion', { version });
  const compressed = base64UrlDecode(payload);
  return gzipDecompress(compressed);
}
