// URLから曲データ(書庫または単体ファイル)を取得する共通ロジック。
// PC98/WebNP2/src/api/disk-fetch.ts の移植。ビルドツール(Vite)を前提にしないため、
// import.meta.env は使わず、下の NET_PROXY_BASE 定数を直接書き換える方式にした。
// ロジック自体は無改変(t()による多言語化のみ、プレーンな日本語文言に置き換えている)。

// 中継サービスのベースURL。既定は空文字列(=中継しない。直接fetchのみ)。
// 中継を有効化したい場合は、ここに中継サーバーのベースURL(例: 'https://example.com/proxy')を
// 直接書き換える。FMSound はビルドツールを持たない静的アプリのため、環境変数からの注入はしない。
export const NET_PROXY_BASE = '';

// OneDriveの共有リンクは実測で中継しても取得できないことが判明しているため、中継を試さず
// 即座に案内を出すためのホスト一覧。
const ONEDRIVE_HOSTS = ['1drv.ms', 'onedrive.live.com', 'sharepoint.com'];
// 中継を使えば取得できる(=中継未設定時のみ「直接取得できません」と案内する)配信元のホスト一覧。
const PROXY_CAPABLE_HOSTS = ['drive.google.com', 'docs.google.com', 'www.dropbox.com', 'dropbox.com'];

/** URLのホスト名を取り出す。パース不可なら空文字を返す(呼び出し側は「一致なし」として扱う)。 @param {string} url */
function urlHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** @param {string} hostname @param {string[]} list */
function hostMatches(hostname, list) {
  return list.some((h) => hostname === h || hostname.endsWith(`.${h}`));
}

const HTML_TEXT_PATTERNS = ['<!do', '<htm', '<?xm'];

/**
 * バイト列がディスクイメージ/書庫ではなくHTML/XMLページに見えるかどうかを判定する。
 *
 * Google Driveの共有ページURL(`https://drive.google.com/file/d/<ID>/view?usp=sharing`)へ
 * ブラウザから直接fetchすると、GoogleはOriginをechoした `access-control-allow-origin` を
 * 付けて200でHTML閲覧ページを返す(2026-08-13 curl実測、content-type: text/html。WebNP2の
 * disk-fetch.tsで発見・移植)。fetch自体は成功(response.ok)してしまうため、
 * Content-TypeとバイトのHTML/XML先頭シグネチャの両方で保険をかける。
 * @param {Uint8Array} bytes @param {string | null} [contentType]
 */
export function looksLikeHtml(bytes, contentType) {
  if (contentType && contentType.toLowerCase().startsWith('text/html')) return true;
  if (bytes.length < 4) return false;
  const head = new TextDecoder('ascii', { fatal: false })
    .decode(bytes.subarray(0, 5))
    .toLowerCase();
  return HTML_TEXT_PATTERNS.some((pattern) => head.startsWith(pattern));
}

/** 中継サーバのエラーJSON(`{"error":"host_not_allowed"}` 等)をHTTPステータスとあわせて利用者向け理由文言に変換する。 @param {number} status @param {string | undefined} code */
function describeProxyError(status, code) {
  switch (code) {
    case 'bad_url':
      return '不正なURLです';
    case 'origin_not_allowed':
      return 'この配信元からの取得は許可されていません';
    case 'host_not_allowed':
      return 'このホストからの取得は許可されていません';
    case 'too_large':
      return 'ファイルサイズが大きすぎます';
    case 'rate_limited':
      return 'リクエストが多すぎます。しばらく待って再試行してください';
    case 'upstream_failed':
      return '配信元からの取得に失敗しました';
    case 'redirect_not_allowed':
      return 'リダイレクト先への取得は許可されていません';
    default:
      return `中継サーバーがエラーを返しました(status=${status})`;
  }
}

/** fetch結果(成功時のResponse)をストリームで読み進め、進捗コールバックを呼びながらバイト列に組み立てる。 @param {Response} response @param {(loaded: number, total: number | null) => void} onProgress */
async function readResponseWithProgress(response, onProgress) {
  const totalHeader = response.headers.get('content-length');
  const total = totalHeader ? Number(totalHeader) : null;

  if (!response.body) {
    const buf = await response.arrayBuffer();
    onProgress(buf.byteLength, total);
    return new Uint8Array(buf);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded, total);
    }
  }
  const result = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** 中継サービス経由でURLを取得し、成功したバイト列を返す。取得できない場合はエラーをthrowする。 @param {string} url @param {(loaded: number, total: number | null) => void} progress @param {Error} fallbackError */
async function fetchViaProxy(url, progress, fallbackError) {
  const proxyUrl = `${NET_PROXY_BASE}/fetch?url=${encodeURIComponent(url)}`;
  let proxyResponse;
  try {
    proxyResponse = await fetch(proxyUrl);
  } catch {
    throw fallbackError;
  }
  if (!proxyResponse.ok) {
    let code;
    try {
      const body = await proxyResponse.clone().json();
      code = body.error;
    } catch {
      // 中継側がJSONを返さなかった場合はステータスのみで案内する。
    }
    throw new Error(`中継サーバー経由での取得に失敗しました(${url}): ${describeProxyError(proxyResponse.status, code)}`);
  }
  const bytes = await readResponseWithProgress(proxyResponse, progress);
  if (looksLikeHtml(bytes, proxyResponse.headers.get('content-type'))) {
    throw new Error(`取得結果がHTMLページでした(${url})。共有リンクの権限設定を確認してください`);
  }
  return bytes;
}

/**
 * 進捗コールバック付きでURLから曲データ(書庫または単体ファイル)のバイト列を取得する。
 *
 * 通常はまず指定URLへ直接fetchする(GitHub raw / jsDelivr のようにCORS対応済みのURLに無駄な
 * 中継を挟まないため)。直接取得に失敗した場合のみ、中継サービス(NET_PROXY_BASE)経由での
 * 再取得を試みる。ただしOneDriveの共有リンクは実測で中継しても取得できないため中継を試さず
 * 即座に専用の案内を出し、中継が未設定の場合はGoogle Drive/Dropboxのみ
 * 「直接取得できません」と案内する(それ以外は従来どおりCORS未対応の可能性を伝える)。
 *
 * Google Drive/Dropbox(PROXY_CAPABLE_HOSTS)の共有ページURLは、直接fetchしても
 * 中身ではなくHTML閲覧ページが200で返ってくることが実測で判明している。そのため
 * 中継が設定されている場合、これらのホストは直接fetchを試さず最初から中継を使う。
 * それでも(直接fetch成功時・中継利用時のいずれでも)取得結果がHTML/XMLに見える場合は
 * looksLikeHtml で検出し、曲データではないと案内する。
 *
 * @param {string} url
 * @param {(loaded: number, total: number | null) => void} [onProgress]
 * @returns {Promise<Uint8Array>}
 */
export async function fetchSongBytes(url, onProgress) {
  const progress = onProgress ?? (() => {});
  const hostname = urlHostname(url);
  if (hostMatches(hostname, ONEDRIVE_HOSTS)) {
    throw new Error(`OneDriveの共有リンクは直接取得できません(${url})。ダウンロードして手動で読み込んでください`);
  }

  const skipDirect = Boolean(NET_PROXY_BASE) && hostMatches(hostname, PROXY_CAPABLE_HOSTS);

  let directError;
  let directWasHtml = false;
  if (!skipDirect) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`取得に失敗しました(${url}): HTTP ${response.status}`);
      }
      const bytes = await readResponseWithProgress(response, progress);
      if (!looksLikeHtml(bytes, response.headers.get('content-type'))) {
        return bytes;
      }
      directWasHtml = true;
    } catch (err) {
      directError = err instanceof Error && err.message ? err : new Error(`ネットワークエラーで取得できませんでした(${url})`);
    }
  }

  if (!NET_PROXY_BASE) {
    if (directWasHtml) throw new Error(`取得結果がHTMLページでした(${url})。共有リンクの権限設定を確認してください`);
    if (directError) {
      if (hostMatches(hostname, PROXY_CAPABLE_HOSTS)) {
        throw new Error(`このホストは直接取得できません(${url})。中継サーバーの設定が必要です`);
      }
      throw directError;
    }
    // skipDirect かつ中継未設定はここには来ない(PROXY_CAPABLE_HOSTS判定にNET_PROXY_BASEを含むため)。
    throw new Error(`このホストは直接取得できません(${url})。中継サーバーの設定が必要です`);
  }

  const fallbackError = directError ?? new Error(`ネットワークエラーで取得できませんでした(${url})`);
  return await fetchViaProxy(url, progress, fallbackError);
}
