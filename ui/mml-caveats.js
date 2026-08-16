// MUCOM88 MML が「読み込めるが本来どおりには鳴らない」ケースを利用者に伝えるための
// 検出層。課題D(公開前の仕上げ): #voice/#pcm で指定される外部ファイル(このプレイヤーは
// 同梱以外のファイルを一切読み込まない)と、リズム(G)パートの使用を検出する。
//
// リズム(G)パートは以前は無音だった(docs/right-pane-data.md「OPNA::Init()の
// rhythmpath未指定」参照)が、mucomweb/patches/0003-mucomvm-rhythm-path.patchで
// 修正済み。ただし実際に鳴るのはYM2608実チップのPCMではなく代替サンプル
// (html/rhythm/2608_*.WAV、NOTICE.md参照。作者本人が「本物のYM2608のリズム音とは
// 根本的に波形が異なる」と明言している独自制作品)。
//
// 【2026-08-16、利用者判断: リズムの画面表示だけ取りやめた】
// detectMmlCaveats()自体は#voice/#pcmと同じ扱いでusesRhythmを検出し続けているが、
// formatMmlCaveatMessage()は#voice/#pcmの一文だけを返しリズムの一文を含めない。
// 「消し忘れ」ではなく意図的な差(理由は下記)。誤解防止のためここに明記する:
//   - #voice/#pcm: 今も実害がある(音色が既定のものになりADPCMは無音のまま鳴る、
//     曲が本来と違って聞こえる)ため、画面表示を維持する。
//   - リズム: 重みが変わった。以前は「(パッチ前は)鳴らない」だったので告知が
//     要ったが、今は「鳴るが波形が違う」。エミュレータの音が実機と完全一致しない
//     のと同程度の差であり、リズム曲を開いている間ずっと画面に出し続けるほどでは
//     ない、という利用者判断による。制約自体は消えていないため、README.ja.md/
//     README.md の「できないこと」相当の節と NOTICE.md には引き続き明記してある
//     (NOTICE.mdは出所表記のため今回変更していない)。
// usesRhythmの検出自体を残しているのは、将来また画面表示や別用途(統計等)で
// 使う可能性を潰さないため。他に参照が無くなった場合は削除して構わない。
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

import { t } from './i18n.js';

// ヘッダタグ行(例 "#voice voice.dat" "#pcm mucompcm.bin")。upstream/MucomWeb/mucom88/
// package/readme.txt の記載順("#mucom88/#voice/#pcm/#composer/...")どおり、
// '#'の直後にタグ名、空白を挟んでファイル名が続く形式。
const HEADER_REF_RE = /^\s*#\s*(voice|pcm)\b\s*(.*)$/i;

// Kパート(ADPCM)の標準音色バンク名。48edad2でこのファイルをMEMFSへ同梱するように
// なったため、`#pcm mucompcm.bin` は(#voiceと違って)実際に解決できる。
// 出典: upstream/MucomWeb/mucom88/src/module/mucom_module.cpp の
// `#define MUCOM_DEFAULT_PCMFILE "mucompcm.bin"`(wasm側 CompileMML() が曲コンパイル
// 成功のたびにこの固定パスをLoadPCM()で読みに行く。html/mucom-app.js loadPcmBank()参照。
// なお同名マクロはupstream/mucom88/src/cmucom.hにも存在するが、実際にビルドへ乗るのは
// MucomWeb側のこのファイルなので、こちらを出典として引く)。
const STANDARD_PCM_BANK_NAME = 'mucompcm.bin';

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
      const tag = headerMatch[1].toLowerCase();
      const file = headerMatch[2].trim();
      // #pcmは標準バンク名(mucompcm.bin、大文字小文字は無視)を指していれば同梱済みで
      // 解決できるため「読み込めない」扱いにしない。#voiceは今回対象外(利用者指示)。
      const resolved = tag === 'pcm' && file.toLowerCase() === STANDARD_PCM_BANK_NAME.toLowerCase();
      if (file.length > 0 && !resolved) missingRefs.push({ tag, file });
      continue;
    }
    if (RHYTHM_LINE_RE.test(line)) usesRhythm = true;
  }
  return { missingRefs, usesRhythm };
}

/**
 * detectMmlCaveats() の結果を利用者向けの1行メッセージに整形する。
 * 何も検出しなければ null を返す(呼び出し側はnullなら表示領域を隠す)。
 *
 * 【2026-08-16】caveats.usesRhythm はここでは意図的に文言化しない(ファイル冒頭の
 * コメント参照)。#voice/#pcmは今も実害があるため引き続き表示するが、リズムは
 * 「鳴らない」から「鳴るが波形が違う」へ実害が下がったため画面表示は取りやめた
 * (制約自体はREADME/NOTICE.mdに残してある)。
 * @param {{ missingRefs: { tag: string, file: string }[], usesRhythm: boolean }} caveats
 * @returns {string | null}
 */
export function formatMmlCaveatMessage(caveats) {
  const parts = [];
  if (caveats.missingRefs.length > 0) {
    const files = [...new Set(caveats.missingRefs.map((r) => r.file))].join(', ');
    parts.push(t('mml.caveatMissingRefs', { files }));
  }
  return parts.length > 0 ? parts.join(' ') : null;
}
