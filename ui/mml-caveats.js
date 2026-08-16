// MUCOM88 MML が「読み込めるが本来どおりには鳴らない」ケースを利用者に伝えるための
// 検出層。課題D(公開前の仕上げ): #voice/#pcm で指定される外部ファイル(このプレイヤーは
// 同梱以外のファイルを一切読み込まない)と、リズム(G)パートの使用を検出する。
//
// リズム(G)パートは以前は無音だった(docs/right-pane-data.md「OPNA::Init()の
// rhythmpath未指定」参照)が、mucomweb/patches/0003-mucomvm-rhythm-path.patchで
// 修正済み。ただし実際に鳴るのはYM2608実チップのPCMではなく代替サンプル
// (html/rhythm/2608_*.WAV、NOTICE.md参照。作者本人が「本物のYM2608のリズム音とは
// 根本的に波形が異なる」と明言している独自制作品)なので、その事実を隠さず利用者に
// 伝えるために検出は引き続き行う(文言だけ「鳴らない」から「代替音で鳴る」へ変更)。
//
// 【スコープ】検出のみ。「読み込む」機能そのものは作らない(要求どおり)。
// MML本文をテキストとして走査するだけで済むため、ここは net/ 層(取得・書庫展開)にも
// wasm側にも依存しない素のテキスト処理のみで完結する。
//
// 【対象はMUCOM88のみ】PMD側のMMLコンパイラ(compiler/pmd_mml_parser.mjs)はv1で
// 外部ファイル参照を持たず(音色は`@`直後の行に埋め込む形式)、リズム(R)パートは
// パーサがPART_LETTERSに含めていないため未対応の部分文字としてコンパイルエラーに
// なる(=そもそも読み込めない状態でここへ来ない)。よってこの検出はMUCOM88の
// MMLテキストにだけ意味がある。

// ヘッダタグ行(例 "#voice voice.dat" "#pcm mucompcm.bin")。upstream/MucomWeb/mucom88/
// package/readme.txt の記載順("#mucom88/#voice/#pcm/#composer/...")どおり、
// '#'の直後にタグ名、空白を挟んでファイル名が続く形式。
const HEADER_REF_RE = /^\s*#\s*(voice|pcm)\b\s*(.*)$/i;

// 行頭のパート文字(html/mml-tokens.js MUCOM_PART_LETTER_RE と同じ判定: 先頭の空白を
// 飛ばした直後の1文字がA~K。Gがリズムパート、docs/mucom-pchdata-mapping.md §1)。
const RHYTHM_LINE_RE = /^[ \t]*[Gg]/;

/**
 * MMLテキストを走査し、「読み込んでも一部が本来どおりに鳴らない」要因を集める。
 * @param {string} mmlText
 * @returns {{ missingRefs: { tag: string, file: string }[], usesRhythm: boolean }}
 */
export function detectMmlCaveats(mmlText) {
  const lines = mmlText.split(/\r\n|\r|\n/);
  const missingRefs = [];
  let usesRhythm = false;
  for (const line of lines) {
    const headerMatch = line.match(HEADER_REF_RE);
    if (headerMatch) {
      const file = headerMatch[2].trim();
      if (file.length > 0) missingRefs.push({ tag: headerMatch[1].toLowerCase(), file });
      continue;
    }
    if (RHYTHM_LINE_RE.test(line)) usesRhythm = true;
  }
  return { missingRefs, usesRhythm };
}

/**
 * detectMmlCaveats() の結果を利用者向けの1行メッセージに整形する。
 * 何も検出しなければ null を返す(呼び出し側はnullなら表示領域を隠す)。
 * @param {{ missingRefs: { tag: string, file: string }[], usesRhythm: boolean }} caveats
 * @returns {string | null}
 */
export function formatMmlCaveatMessage(caveats) {
  const parts = [];
  if (caveats.missingRefs.length > 0) {
    const files = [...new Set(caveats.missingRefs.map((r) => r.file))].join(', ');
    parts.push(`この曲は ${files} を参照していますが読み込めません。音色とドラムが本来と異なります。`);
  }
  if (caveats.usesRhythm) {
    parts.push('リズム音源は代替サンプルで再生されます(本物のYM2608とは波形が異なります)。');
  }
  return parts.length > 0 ? parts.join(' ') : null;
}
