// MUCOM88エンジン固有のアプリロジック。app.js(共通シェル)から動的importされ、
// init(ctx) が呼ばれる。ctx には共通DOM要素(ツールバー基本ボタン・キャンバス・
// 設定ポップオーバーの入力欄・ファイル入力・各種プレースホルダ)が入っている。
//
// 中身は旧 mucomweb/html/index.html の <script type="module"> をほぼそのまま移設した
// もの(既存の全機能を壊さないことが要件のため、ロジックには手を入れず「グローバルな
// DOM構築」だった部分だけ ctx 経由に置き換えている)。設計理由のコメントは元のまま
// 残してある。

import createMucomWeb from './mucom88.js';
import { Vram, PC98_W, PC98_H } from './fmdsp/vram.js';
import { FmdspFont, SmallFont } from './fmdsp/font.js';
import { drawTrackRows, createIdleEntryTracks, TRACK_H, TRACK_DISP_TABLE_OPNA } from './fmdsp/trackrow.js';
import { buildMucomChannelMask, channelForRow } from './fmdsp/channel-mask.js';
import { canvasPointFromClientClick, trackRowIndexAt } from './fmdsp/track-click.js';
import { PALETTES } from './fmdsp/palette.js';
import { FONT_SMALL } from './fmdsp/font_small.js';
import { drawComment } from './fmdsp/comment.js';
import * as rightpane from './fmdsp/rightpane.js';
import { MucomFmdspAdapter, CH_TO_SLOT, CH_TO_CHSTAT, MUCOM_CH_COUNT, PCH_FIELD_COUNT } from './mucom-adapter.js';
import { ICONS, iconButton, svgIcon } from './ui/icons.js';
import { setupMmlEditor, extractErrorLine } from './mml-editor.js';
import { MUCOM_TOKEN_RULES, MUCOM_MACRO_HEADER_RE, MUCOM_PART_LETTER_RE } from './mml-tokens.js';
import { FMSOUND_VERSION_FIELDS } from './ui/version.js';
import { loadMmlDraft, setupMmlAutosave, formatSavedAt } from './ui/mml-draft.js';
import { setMmlStatus, clearMmlStatus } from './ui/mml-status.js';
import { setupTransportShortcuts, SHORTCUT_PLAY_HINT } from './ui/shortcuts.js';
import { createDownloadMenu } from './ui/download-menu.js';
import { createOpenMenu } from './ui/open-menu.js';
import { setupPopover } from './ui/shell.js';
import { t } from './ui/i18n.js';
import { describeNetError } from './ui/net-error.js';
import {
  resolveSongFromUrl, resolveSongFromFile, pickSongCandidate, FILEBAR_RESTORED_DRAFT_NAME,
  persistSongToLibrary, importArchiveSongsToLibrary, getLibraryDb, urlBaseName,
  closeActiveSongPicker, reflectLoadedUrlInAddressBar, clearLoadedUrlFromAddressBar,
  ARCHIVE_EXTENSIONS,
} from './net-load.js';
import { createLibraryPanel } from './ui/library-panel.js';
import { decodeMmlBytes, decodeMmlBytesAs } from './net/charset.js';
import { detectMmlCaveats, formatMmlCaveatMessage } from './ui/mml-caveats.js';
import { encodeCp932 } from './ui/cp932-encode.js';
import { resolveMucomVoiceNameRefs } from './ui/mucom-voice-resolve.js';
import { findPairedVoiceBank } from './net/voice-bank.js';
import { MUCOM_DEFAULT_VOICE_NAMES } from './ui/mucom-voice-table.js';

// 課題B: 「Clear MML」(空にするだけ・英語のまま)を「新規作成」に置き換える雛形。
//
// 【不具合修正・2026-08-15】以前の雛形は `@`(音色指定)が無く、コンパイルは成功し
// FMDSPの鍵盤も動くのに実際には無音だった(利用者報告)。原因はMUCOM88がFMチャンネルの
// 発音に音色バンクの選択(`@`)を要求する作りで、未指定だと有効な音色が載らずノートは
// 処理されるが音が出ないため(鍵盤の動き=ドライバがノートを処理している証拠であって、
// 音が出ている証拠ではない。表示と音は別物)。
// `@`の有無だけを変えてrenderFramesForTest()のPCM絶対値和(absSum)を実測して確認した
// (tools/verify_mucom_new_template.mjs参照): `@`無し=absSum 0(無音)、
// `@78`あり=absSum 630905732(非0)。`voice.dat`(#voice)を読み込んでいなくても
// エンジン内蔵の音色バンクだけで鳴る番号(78)を実測で選定した(upstream同梱の
// sampl1.muc が使う番号の一つ。#78のコンパイルログにも"Used FM voice"が出る)。
//
// 【不具合修正・2026-08-15 その2】雛形が「PMD雛形の半分くらいの速さ」に聞こえる
// (利用者報告)。原因はコメントの誤り: 旧コメントは「Cはテンポ(4分音符基準のBPM
// そのまま)」としていたが、Cはテンポではない。
//   出典: Open MUCOM88 Wiki「MMLリファレンス」
//     (https://github.com/onitama/mucom88/wiki/MMLリファレンス、2026-08-15 WebFetchで確認)。
//     - C: 「全音符あたりのクロック(分解能)指定」。デフォルトC128。*テンポではない*。
//     - t(小文字): 「FM音源チップのタイマーBの数値を直接指定するテンポ指定」
//       (TimerB生値。Cの解像度に依存して実時間が変わる)。
//     - T(大文字): 「テンポ指定(1分間に演奏する四分音符の数で指定)」= BPM相当。
//       Cの値によらず4分音符の実時間が60/T秒になる(解像度非依存)。
//   つまり旧コメントの説明は実際にはCではなくTのものだった。旧雛形はCしか
//   指定しておらず、テンポコマンド(T/t)を一切書いていなかったため、テンポは
//   ドライバの既定値のまま再生されていた(これがPMD雛形より遅く聞こえた実体)。
//   tools/verify_mucom_tempo_absolute.mjs で実測検証済み:
//     T60/T120/T200指定時の4分音符の実測実時間が60/T秒(Wiki仕様どおり)に一致。
//     Cを変えてもTが同じなら実時間は変わらない(解像度非依存の確認)。
//     同じtでCを変えると実時間がCに比例して変わる(tは解像度依存の確認)。
//   PMD雛形(html/pmd-app.js PMD_NEW_MML_TEMPLATE)は t60(2分音符=60、PMDMML.MAN
//   §11-1準拠)=4分音符0.5秒。ここではT120(60/120=0.5秒)を指定し、基準は違うが
//   実時間で一致させている。
const MUCOM_NEW_MML_TEMPLATE = `; 新規作成ひな形(MUCOM88): そのまま再生すると音が鳴ります。
; T はテンポ(1分間に演奏する4分音符の数=BPM相当。T120なら4分音符0.5秒)。
; C(未指定=既定128)は全音符あたりのクロック(分解能)で、テンポではない。
; @ は音色バンク選択(必須。無いと発音処理はされるが無音になる。実測で確認済み)。
; ここでは voice.dat 無しでも鳴る内蔵音色(78番)を指定している。
A @78 T120 o5 l4 v10 cdefgab>c<
`;

// リズム(G)パート用のPCMサンプル6本(html/rhythm/2608_*.WAV)をMEMFSへ書き込む。
//
// upstream側(mucomweb/patches/0003-mucomvm-rhythm-path.patch)がOPNA::Init()に
// rhythmpath="/rhythm/"を渡すよう固定しているため、ここではその固定パスへ
// Module.FS.writeFile()で置くだけでよい(fopen("/rhythm/2608_BD.WAV",...)がそのまま
// 見つける)。emscriptenの既定ビルド(MEMFSが"/"へ自動マウントされる。素の
// FILESYSTEM=0指定はmucomweb/CMakeLists.txtに無い)で動くことをtools/verify_mucom_rhythm.mjs
// で実測確認済み(docs/rhythm-feasibility.md 1.5節の「未検証」を解消)。
//
// ファイル名は大文字固定("2608_BD.WAV"等)。opna.cpp LoadRhythmSample()はこの表記を
// そのまま文字列連結して開こうとするため、MEMFS(大文字小文字を区別する)側も
// 同じ大文字表記で置く必要がある(小文字で置くと無言で見つからず、従来どおり
// 無音のまま気づけない)。
//
// 波形データの出典・権利はNOTICE.md参照(YM2608実チップROM由来ではなく、
// 作者が独自制作した代替音色。フリー再配布条件で入手)。
//
// fetchに失敗しても(オフライン/ホスティング事情等)エンジン自体は今までどおり
// 動く(リズムだけ無音に戻るだけ)ため、例外を投げずコンソールに警告するだけに
// とどめる。
const RHYTHM_SAMPLE_NAMES = ['BD', 'SD', 'TOP', 'HH', 'TOM', 'RIM'];

// Kパート(ADPCM)用の標準PCMバンク(html/mucompcm.bin)をMEMFSへ書き込む。
//
// wasm側(mucomweb/src/MucomWeb.cpp CompileMML())が曲コンパイル成功のたびに
// g_mucom->LoadPCM("/mucompcm.bin") を呼んでこの固定パスを読みに行くため、
// ここではその場所へ事前に置いておくだけでよい(loadRhythmSamples()と同じ作法)。
//
// バンク実体の出典・ライセンス(MUCOM88パッケージ同梱、CC BY-NC-SA 4.0)は
// NOTICE.md参照。
//
// fetchに失敗しても(オフライン/ホスティング事情等)例外は投げず、コンソールに
// 警告するだけにとどめる(Kパートだけ従来どおり無音に戻る。他のパートは影響なし)。
async function loadPcmBank(Module) {
  try {
    const response = await fetch('./mucompcm.bin');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    Module.FS.writeFile('/mucompcm.bin', new Uint8Array(buffer));
  } catch (e) {
    console.warn('[mucom-app] failed to load the standard PCM bank (mucompcm.bin). The K part (ADPCM) will remain silent.', e);
  }
}

async function loadRhythmSamples(Module) {
  try {
    Module.FS.mkdir('/rhythm');
  } catch (e) {
    // 既に存在する場合(このinit()が二度呼ばれることは無いはずだが念のため)は無視。
  }
  await Promise.all(RHYTHM_SAMPLE_NAMES.map(async (name) => {
    const fileName = `2608_${name}.WAV`;
    try {
      const response = await fetch(`./rhythm/${fileName}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      Module.FS.writeFile(`/rhythm/${fileName}`, new Uint8Array(buffer));
    } catch (e) {
      console.warn(`[mucom-app] failed to load the rhythm sample ${fileName}. The rhythm part will remain silent.`, e);
    }
  }));
}

export async function init(ctx) {
  const {
    canvas, consoleCard, toolbar,
    btnPlayPause, btnStop, btnOpenFile, btnDownload, settingsPopoverEl, btnFullscreen,
    fileInput, sampleLinksEl, enginePaneEl, footerCreditsEl, rescale,
  } = ctx;

  // --- footer credits ---
  // 課題C: 上流の出典表示(ライセンス上の要求のため削除しない)に加えて、
  // FMSound自身のリポジトリへの導線を末尾に足す。
  footerCreditsEl.innerHTML =
    '<a href="https://github.com/onitama/mucom88" target="_blank" rel="noopener">OPEN MUCOM88</a> ' +
    '<a href="https://github.com/onitama/mucom88/blob/master/package/license.txt" target="_blank" rel="noopener">(LICENSE)</a> | ' +
    '<a href="https://github.com/aosoft/MucomWeb" target="_blank" rel="noopener">MUCOM88 on Web</a> ' +
    '<a href="https://github.com/aosoft/MucomWeb/blob/master/LICENSE" target="_blank" rel="noopener">(LICENSE)</a> / ' +
    '<a href="https://creativecommons.org/licenses/by-nc-sa/4.0/deed.ja" target="_blank" rel="noopener">CC BY-NC-SA 4.0</a> | ' +
    '<a href="https://github.com/uraraworks/FMSound" target="_blank" rel="noopener">FMSound on GitHub</a>';

  // 課題: ファイルから開く/D&Dの書庫対応(2026-08-16)。書庫拡張子の一覧は
  // net/archive.js ARCHIVE_EXTENSIONS(唯一の情報源)を参照する。isArchive()の
  // 判定規則と食い違わないよう、ここでは拡張子を書き並べない。
  fileInput.accept = ['.muc', ...ARCHIVE_EXTENSIONS].join(',');

  // --- エンジン固有領域(MMLエディタ+結果表示+デバッグテーブル)を組み立てる ---
  // 「透明textarea+背面pre」方式の重ね合わせエディタ。行番号ガター・色付きpre・
  // 本物のtextareaの3つを同じ枠(overflow:hidden)の中に収め、textareaのscrollを
  // 正として他の2つを追従させる(mml-editor.js参照)。
  enginePaneEl.innerHTML = `
    <div class="mml-restore-note hidden" id="mmlRestoreNote"></div>
    <div class="mml-status" id="mmlStatus"></div>
    <div class="mml-editor" id="mmlEditor">
      <div class="mml-gutter" id="mmlGutter" aria-hidden="true"><div class="mml-gutter-inner" id="mmlGutterInner"></div></div>
      <div class="mml-code-wrap" id="mmlCodeWrap">
        <div class="mml-current-line" id="mmlCurrentLine"></div>
        <pre class="mml-highlight" id="mmlHighlight" aria-hidden="true"><code id="mmlHighlightCode"></code></pre>
        <textarea id="mml" wrap="off" spellcheck="false"></textarea>
      </div>
    </div>
    <div id="result"></div>
    <details class="debug-table debug-only" id="debugTable">
      <summary>${t('debug.pchTableHeading')}</summary>
      <table id="channelStatus">
        <thead>
          <tr><th>ch</th><th>vnum</th><th>volume</th><th>quantize</th><th>length</th><th>fnum</th><th>flag</th></tr>
        </thead>
        <tbody></tbody>
      </table>
    </details>
    <div id="snapshotDebug" class="debug-only">snapshot ring: inactive</div>
    <div id="audioDebug" class="debug-only">AudioWorklet: inactive</div>
  `;

  // --- サンプルMMLリンク ---
  // 課題D(方針転換): 同梱するのは自作曲のみにする(PMD版と同じ曲=エリーゼのために)。
  // 古代祐三氏のsampl1/sampl2/sampl3.muc(GitHubから取得するものも含む)は同梱をやめた。
  // samplja.muc(日本語コメント表示の確認用テストファイル)は削除せず残すが、
  // 利用者向けサンプルではないため?debug=1のときだけ表示する(class="debug-only")。
  sampleLinksEl.innerHTML = `
    ${t('sample.mmlLabel')}
    <a href="javascript:void(0);" id="dlSampleFurEliseMucom">sample_fur_elise_mucom.muc(${t('sample.furEliseLabel')})</a>
    <a href="javascript:void(0);" id="dlSamplJa" class="debug-only">samplja.muc</a>
  `;

  // --- モード(player/editor)。localStorageに保存し、次回も同じモードで開く ---
  const UI_MODE_KEY = 'fmsound-mucom-ui-mode';
  const editorPane = enginePaneEl;

  const btnEditorMode = iconButton(ICONS.edit, t('toolbar.editorMode'));
  toolbar.insertBefore(btnEditorMode, btnFullscreen);

  // 課題B: 「Clear MML」(英語のまま・エディタ欄の下に浮いたボタン)を廃止し、
  // ツールバーの「曲を開く」「ダウンロード」と同じ並びのアイコンボタンへ移す。
  const btnNewMml = iconButton(ICONS.newFile, t('toolbar.newFile'));
  toolbar.insertBefore(btnNewMml, btnDownload);

  // 曲ライブラリ(取り込み済みの曲一覧。IndexedDB、net/library.js)。
  const btnLibrary = iconButton(ICONS.library, t('toolbar.library'));
  toolbar.insertBefore(btnLibrary, btnDownload);
  const libraryPanel = createLibraryPanel({
    driver: 'mucom',
    getDb: getLibraryDb,
    onSelect: (song) => {
      // 修正1: ライブラリから選んだ曲もURL由来ではないので、残っている
      // `?mml=` はここで取り除く(new-load.js clearLoadedUrlFromAddressBar()参照)。
      clearLoadedUrlFromAddressBar();
      // #voice対応: ライブラリに保存された外部音色バンク(net/library.js voiceBank、
      // 対になるシステムディスクが見つかった曲だけ非null)をそのまま引き継ぐ。
      // 引き継がないと「初回は鳴っていたのに、ライブラリから開き直すと既定バンクの
      // 音に変わる」という退行になる。
      applyMmlBytes(song.bytes, { name: song.fileName, voiceBank: song.voiceBank ?? null, voiceBankSource: song.voiceBankSource ?? null });
      compileAndPlay();
    },
  });
  // 「曲を開く」メニュー(ui/open-menu.js)のポップオーバー制御。btnLibrary側の
  // クリックハンドラから閉じられるよう、生成(このファイル下部、URL読み込み配線の
  // 近く)より前に変数を用意しておく(呼ばれるのはinit()完了後のクリック時なので、
  // クロージャが参照する時点で代入済みになっていれば順序は問題ない)。
  let openMenuPopover = null;
  // 書庫選択モーダル(net-load.js pickSongCandidate())は全画面オーバーレイの
  // モーダルで、開いている間は他の操作ができない「今の手順」を表す。ライブラリは
  // 「これまでに取り込んだ全部」を見る別の面なので、ライブラリを開く方が後から
  // 割り込んだ操作として書庫選択モーダルを閉じる(利用者判断、案A)。「曲を開く」
  // メニューも同じ考え方で閉じる(利用者指示: 重なり対策をURL読み込み機能にも揃える)。
  btnLibrary.addEventListener('click', () => {
    closeActiveSongPicker();
    if (openMenuPopover) openMenuPopover.close();
    libraryPanel.render();
  });
  const libraryPopover = setupPopover(btnLibrary, libraryPanel.popoverEl);

  function applyUiMode(mode) {
    editorPane.classList.toggle('hidden', mode !== 'editor');
    btnEditorMode.classList.toggle('active', mode === 'editor');
    btnEditorMode.title = mode === 'editor' ? t('toolbar.playerMode') : t('toolbar.editorMode');
    btnEditorMode.setAttribute('aria-label', btnEditorMode.title);
    rescale();
  }

  function currentUiMode() {
    try {
      const saved = localStorage.getItem(UI_MODE_KEY);
      return saved === 'editor' ? 'editor' : 'player';
    } catch {
      return 'player';
    }
  }

  function setUiMode(mode) {
    try { localStorage.setItem(UI_MODE_KEY, mode); } catch { /* ignore (private mode等) */ }
    applyUiMode(mode);
  }

  let moduleReady = false;
  // 症状③⑥の対策(下のupdateTransportButtonUI()参照)で使うアイコン差し替え済み判定。
  // moduleReadyと同じ理由(Temporal Dead Zone、実測で「Cannot access 'moduleReady'
  // before initialization」を確認済み)でここに先出しする。
  let lastPlayIconKey = null;
  btnPlayPause.disabled = true;
  btnStop.disabled = true;

  applyUiMode(currentUiMode());

  // --- MMLエディタ(行番号ガター+構文色つけ+現在行ハイライト) ---
  const mmlTextarea = document.getElementById('mml');
  const mmlEditorApi = setupMmlEditor({
    textarea: mmlTextarea,
    gutterInner: document.getElementById('mmlGutterInner'),
    highlightCode: document.getElementById('mmlHighlightCode'),
    highlightPre: document.getElementById('mmlHighlight'),
    currentLineEl: document.getElementById('mmlCurrentLine'),
    rules: {
      tokenRules: MUCOM_TOKEN_RULES,
      macroHeaderRe: MUCOM_MACRO_HEADER_RE,
      partLetterRe: MUCOM_PART_LETTER_RE,
    },
  });

  // --- 課題A: 編集内容の自動保存/復元(PMD側と同じ作法、ui/mml-draft.js参照)。
  // ドライバごとに別キー(PMDとMUCOM88はMML文法が違うため混在させない)。
  const MML_DRAFT_KEY = 'fmsound-mucom-mml-draft';
  const mmlRestoreNoteEl = document.getElementById('mmlRestoreNote');
  const mmlStatusEl = document.getElementById('mmlStatus');
  const draft = loadMmlDraft(MML_DRAFT_KEY);
  const hasDraft = Boolean(draft && draft.text.length > 0);
  if (hasDraft) {
    mmlTextarea.value = draft.text;
    mmlEditorApi.render();
    const savedLabel = formatSavedAt(draft.savedAt);
    mmlRestoreNoteEl.textContent = savedLabel
      ? t('restore.noteWithTime', { time: savedLabel })
      : t('restore.note');
    mmlRestoreNoteEl.classList.remove('hidden');
    mmlTextarea.addEventListener('input', () => mmlRestoreNoteEl.classList.add('hidden'), { once: true });
  }
  setupMmlAutosave({ storageKey: MML_DRAFT_KEY, textarea: mmlTextarea });

  let mmlDirty = false;
  // PMD側(html/pmd-app.js)と同じ理由で用意する「一度でも今の内容をコンパイル成功
  // させたか」フラグ。MUCOM側は元々ボタンの青いドット表示自体は mmlDirty だけを見て
  // いた(hasPlaybackには依存していなかった)ためドットが残る不具合そのものは無かったが、
  // クリックハンドラの「再コンパイルすべきか」判定は hasPlayback(AudioWorkletの
  // 非同期'playback'通知)を見ていた。コンパイル成功直後、その通知がまだ届いていない
  // 一瞬の間に再クリックすると不要な再コンパイルが起きてしまう(実害は薄いが、
  // 課題A/追加報告と同じ「コンパイル成否をhasPlaybackで代用する」パターンなので、
  // 再発防止のためPMD側と揃えて専用フラグに切り替える)。
  let hasCompiled = false;
  function markMmlDirty() {
    if (mmlDirty) return;
    mmlDirty = true;
    updateTransportButtonUI();
  }
  mmlTextarea.addEventListener('input', markMmlDirty);

  // 症状④: エラー時の1行要約を取り出す。以前は単純に「先頭行」を使っていたが、
  // MUCOM88コンパイラの出力は先頭が"#OpenMucom88 Ver..."のバナーであることが多く、
  // それを要約として出すと(a)意味のある内容になっておらず、かつ(b)下の#result側の
  // 詳細ログの先頭行と文字通り同じ文言が上下に二重表示される、という2つの問題があった。
  // "-> ..."(cmucom.cppが出す日本語の一言説明)があればそれを、無ければ"#error"行を、
  // どちらも無ければ先頭行を使う(実測: upstream/mucom88/src/cmucom.cppのエラー出力
  // 末尾に"-> 文法に誤りがあります"のような行が付く)。
  function summarizeMucomError(text) {
    const lines = text.split(/\r\n|\r|\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    const arrowLine = [...lines].reverse().find((l) => l.startsWith('->'));
    if (arrowLine) return arrowLine.replace(/^->\s*/, '');
    const errorLine = lines.find((l) => /^#error\b/i.test(l));
    if (errorLine) return errorLine;
    return lines[0] ?? text;
  }

  const resultEl = document.getElementById('result');
  function renderCompileResult(text) {
    resultEl.textContent = text;
    // 課題D: エラー(#error N in line M./#Device error/#Memory write error等、
    // upstream/mucom88/src/cmucom.cpp のメッセージはすべて"error"を含む)は赤系(--danger)。
    // 正常時の"#OpenMucom88 Ver..."はこの文字列を含まないため赤くならない(実測確認済み)。
    const isError = /error/i.test(text);
    resultEl.classList.toggle('mml-compile-error', isError);
    const line = extractErrorLine(text);
    if (line != null) {
      resultEl.classList.add('result-has-error-line');
      resultEl.title = t('mml.jumpToLine', { line });
      resultEl.onclick = () => mmlEditorApi.jumpToLine(line);
    } else {
      resultEl.classList.remove('result-has-error-line');
      resultEl.removeAttribute('title');
      resultEl.onclick = null;
    }
    // 課題B: エディタのすぐ上の状態表示(詳細ログはこのまま下の#resultに残す)。
    const summary = isError ? summarizeMucomError(text) : '';
    setMmlStatus(mmlStatusEl, isError
      ? { ok: false, line, message: summary, onJump: (l) => mmlEditorApi.jumpToLine(l) }
      : { ok: true });
  }

  // 課題A: 前回のコンパイル結果(上の1行要約+下の詳細ログ)を消す。追記ではなく
  // 置き換えにするため、renderCompileResult()は元々毎回全置換だが、実機報告の
  // 「エラーが消えずに積み上がる」不具合の実体は「新規作成MML/清書欄を空にした後、
  // 一度もrenderCompileResult()が呼ばれないまま古い表示が残ること」だった
  // (Clear MMLが#result/#mmlStatusに一切触れていなかった)。新しいコンパイルの
  // 開始時・編集内容を消した(新規作成)とき・曲を読み込んだときの3箇所で呼ぶ。
  function clearCompileStatus() {
    resultEl.textContent = '';
    resultEl.classList.remove('mml-compile-error', 'result-has-error-line');
    resultEl.removeAttribute('title');
    resultEl.onclick = null;
    clearMmlStatus(mmlStatusEl);
  }

  // 課題A: 編集欄が空のまま再生されたとき、古いエラー表示を残さず案内を出す。
  function showEmptyMmlNotice() {
    const message = t('mml.emptyNotice');
    resultEl.textContent = message;
    resultEl.classList.remove('mml-compile-error', 'result-has-error-line');
    resultEl.removeAttribute('title');
    resultEl.onclick = null;
    setMmlStatus(mmlStatusEl, { ok: false, message });
  }

  btnEditorMode.addEventListener('click', () => {
    const prevMode = currentUiMode();
    const next = prevMode === 'editor' ? 'player' : 'editor';
    // 課題E: 「編集OFF→ON」の遷移のときだけ、再生中の曲を頭出しで止める
    // (一時停止ではない)。編集ONで再生ボタンを押すのは普通に鳴らす通常操作なので
    // ここでは止めない。編集から戻るときも何もしない。
    if (next === 'editor' && prevMode !== 'editor' && moduleReady) {
      stopPlayback();
    }
    setUiMode(next);
  });

  rescale();
  requestAnimationFrame(rescale);

  const Module = await createMucomWeb();
  await loadRhythmSamples(Module);
  await loadPcmBank(Module);
  moduleReady = true;
  updateTransportButtonUI();

  let pausedFrameDrawn = false;
  let stoppedFrameDrawn = false;
  // アイドル画面(停止中)で直近に描いた曲名。undefinedは「まだ一度も描いていない」。
  let idleDrawnSongName;
  // 課題B(2026-08-14): 「曲が終わったこと」を自動検出して頭出し停止する機能を
  // 実装したが、2026-08-15の実機報告(同梱サンプルのループ曲が約6.5秒で止まる)を
  // 受けて再測定した結果、**MUCOM88では信頼できる終了検出手段が無いと判明したため
  // 撤去した**(以下は撤去の根拠。docs/transport-button-state.md 症状⑧にも記録)。
  //
  // 実測で判明した制約: MUCOM88(このport)には PMD の fmdriver_work.playing に相当する
  // 単一の「再生中/終了」フラグが無い。GetStatus(MUCOM_STATUS_PLAYING)はcmucom.cppの
  // playflag(Play()でtrue、Stop()を呼んだ時だけfalse)をそのまま返すだけで、
  // ループしない曲が末尾に到達しても自動ではfalseにならない(実測:非ループ曲を
  // 400tick以上再生してもGetStatus(PLAYING)は常に1のまま)。よってこのAPIは
  // 終了検出に使えない。
  //
  // 代わりに docs/mucom-pchdata-mapping.md §3 の PCHDATA.flag bit0(LOOPEND FLAG)と
  // codeの安定性を組み合わせる方式を試したが、**実際の同梱サンプル(2パートの
  // 生メロディ、tools/sample_fur_elise_mucom.mml)で実測したところ、bit0は
  // 「authored MMLデータの末尾に到達した」時点で一度立つと、ループが続いていても
  // 二度と下がらないことが分かった**(scratchpadでの実測: ループ曲でbit0がt=6.8s
  // 付近で1になった後、10秒以上再生を続けてもbit0は1のまま。codeはその後も
  // ノート毎に変化するが、休符や同音連打で3ポーリング以上codeが変化しない瞬間が
  // 頻繁にあり、そのたびに「終了」条件(bit0=1 かつ code安定)を満たして誤発火した)。
  // 以前の検証(tools/verify_song_end_detection.mjs)が誤検出を再現できなかったのは、
  // 単純な単音階の合成MML(cdefgab>c<の繰り返し、休符・和音・複数パート無し)を
  // 使っていたためで、実物の楽曲を使っていなかった。
  //
  // 結論: bit0は「ループ点(=authoredデータの末尾)」と「曲の終了」を区別する
  // 情報を持っておらず(ループする曲でも最初の1周目終わりに立ったきり戻らない)、
  // 手元のPCHDATAから信頼できる終了検出は組み立てられない。「ループする曲が
  // 途中で止まる」方が「ループしない曲が終了後に鳴り続ける」より明確に害が大きい
  // ため、MUCOM88側の自動停止機能は撤去し、利用者が手動でStopを押す従来の
  // 挙動に戻す(PMD側はfmdriver_work.playingという専用フラグがあり、この問題は
  // 起きないため撤去していない)。

  // 症状③⑥の根本原因(PMD側と共通): 以前はここで毎フレーム無条件に
  // btnPlayPause.replaceChildren(...)していたため、ボタンの中身(アイコンのsvg)が
  // 実際のクリック操作のmousedown〜mouseup間に差し替わることがあり、ブラウザが
  // clickイベントを発火できないことがあった(html/pmd-app.js updateTransportButtonUI()
  // のコメント参照)。アイコン種別が変わるときだけ差し替える
  // (lastPlayIconKey自体はTDZを避けるため上のmoduleReady宣言のそばへ移した)。

  // 症状⑥: 「コンパイル成功→Stop→もう一度Play」が無反応になる不具合の対処。
  // 以前はmmlDirty/hasCompiledだけを見ており、「編集はしていないが完全に停止済み
  // (hasPlayback===false)」を考慮していなかった。一時停止(hasPlaybackはtrueのまま)
  // とは別物で、単純なcontext.resume()では鳴らせない。PMD側(html/pmd-app.js
  // needsCompileNow())と同じ考え方で、この状態も「コンパイル&再生」扱いにする。
  function needsCompileNow() {
    const hasPlayback = Boolean(globalThis.mucomAudioState?.playback);
    return mmlDirty || !hasCompiled || !hasPlayback;
  }

  function updateTransportButtonUI() {
    const audioState = globalThis.mucomAudioState;
    const hasPlayback = Boolean(audioState?.playback);
    const paused = Boolean(audioState?.paused);
    const playing = hasPlayback && !paused;
    // 症状②: MMLが空のときは「未コンパイルの変更があります」の青いドットを出さない。
    const hasMmlContent = mmlTextarea.value.trim().length > 0;
    const showDirty = mmlDirty && hasMmlContent;

    btnPlayPause.disabled = !moduleReady;
    btnStop.disabled = !moduleReady || !hasPlayback;

    const iconKey = !mmlDirty && playing ? 'pause' : 'play';
    // ドットの意味を利用者に伝える(PMD側と同じ対応。見た目は変えずtitle/aria-labelだけ)。
    const label = mmlDirty
      ? t('transport.dirtyHintParen', { hint: SHORTCUT_PLAY_HINT })
      : (playing ? t('transport.pause', { hint: SHORTCUT_PLAY_HINT })
        : (paused ? t('transport.resume', { hint: SHORTCUT_PLAY_HINT }) : t('transport.compileAndPlay', { hint: SHORTCUT_PLAY_HINT })));
    if (iconKey !== lastPlayIconKey) {
      const icon = iconKey === 'pause' ? ICONS.pause : ICONS.play;
      btnPlayPause.replaceChildren(svgIcon(icon.path ?? icon, icon.extra ?? ''));
      lastPlayIconKey = iconKey;
    }
    btnPlayPause.title = label;
    btnPlayPause.setAttribute('aria-label', label);
    btnPlayPause.classList.toggle('active', !mmlDirty && paused);
    btnPlayPause.classList.toggle('dirty', showDirty);
  }

  function stopPlayback() {
    Module.stopMusic();
    const audioState = globalThis.mucomAudioState;
    if (audioState?.context?.state === 'suspended') {
      audioState.context.resume();
    }
    setAudioPaused(false);
  }

  function setAudioPaused(paused) {
    const audioState = globalThis.mucomAudioState;
    if (!audioState) return;
    audioState.paused = paused;
    pausedFrameDrawn = false;
    updateTransportButtonUI();
  }

  btnPlayPause.addEventListener('click', () => {
    if (btnPlayPause.disabled) return;
    const audioState = globalThis.mucomAudioState;
    const hasPlayback = Boolean(audioState?.playback);
    if (needsCompileNow()) {
      if (hasPlayback) {
        stopPlayback();
      }
      compileAndPlay();
      return;
    }
    if (!audioState.context) return;
    if (audioState.paused) {
      audioState.context.resume();
      setAudioPaused(false);
    } else {
      audioState.context.suspend();
      setAudioPaused(true);
    }
  });
  updateTransportButtonUI();

  const channelTableBody = document.querySelector('#channelStatus tbody');
  const snapshotRingSize = 2048;
  const invalidWriteIndex = 0xffffffff;
  const snapshotHeaderWordCount = Module.getSnapshotHeaderWordCount();
  const SNAPSHOT_HEADER = { FRAME: 0, PASS_TICK: 1, INT_COUNT: 2, MAX_COUNT: 3 };
  const CHSTAT_OFFSET = 4;
  const calibrationInput = document.getElementById('calibrationMs');
  const synchronizedCheckbox = document.getElementById('useSynchronizedStatus');
  for (let ch = 0; ch < MUCOM_CH_COUNT; ch++) {
    const row = channelTableBody.insertRow();
    row.insertCell().innerText = ch;
    for (let column = 0; column < 6; column++) {
      row.insertCell().innerText = '0';
    }
  }

  // --- FMDSP描画準備 ---
  const vram = new Vram(PC98_W, PC98_H);
  const canvasCtx = canvas.getContext('2d');

  // トラック行クリックミュート機能(利用者指示: クリックでミュート、もう一度で解除。
  // ソロ機能は無し)。mutedRows: ミュート中の行index(0-9、fmdsp/trackrow.jsの
  // TRACK_DISP_TABLE_OPNA順=FM1-6,SSG1-3,ADPCM)。
  // マスク値の組み立ては fmdsp/channel-mask.js の buildMucomChannelMask() に
  // 一元化してある(MUCOM88とPMDでビット割り当てが違うので、ここで共通マスクを
  // 作って両方へ渡すような真似は絶対にしない)。
  const mutedRows = new Set();
  function applyChannelMask() {
    if (typeof Module.setChannelMask === 'function') {
      const mutedChannels = new Set([...mutedRows].map((row) => channelForRow(row)));
      Module.setChannelMask(buildMucomChannelMask(mutedChannels));
    }
  }
  canvas.addEventListener('click', (event) => {
    const rect = canvas.getBoundingClientRect();
    const point = canvasPointFromClientClick(event.clientX, event.clientY, rect, PC98_W, PC98_H);
    if (!point) return;
    const row = trackRowIndexAt(point.x, point.y, {
      trackH: TRACK_H, rowCount: TRACK_DISP_TABLE_OPNA.length, panelWidth: PC98_W / 2,
    });
    if (row < 0) return;
    if (mutedRows.has(row)) mutedRows.delete(row); else mutedRows.add(row);
    applyChannelMask();
  });

  const palette = PALETTES[0];

  rightpane.drawStaticDecorations(vram, FMSOUND_VERSION_FIELDS, 'MUCOM88');
  const staticVramSnapshot = vram.pixels.slice();

  const fftPeakState = rightpane.createPeakState(rightpane.FFTDISPLEN);
  const levelPeakState = rightpane.createPeakState(rightpane.FMDSP_LEVEL_COUNT);
  let rightPaneFrameCounter = 0;
  // 曲が読み込まれていない/停止中でもパート行の枠を描くためのプレースホルダ
  // (trackrow.js createIdleEntryTracks() 参照)。
  const idleEntryTracks = createIdleEntryTracks();

  let fmdspFont = null;
  FmdspFont.load('./fmdsp/shinonome.rom').then((font) => { fmdspFont = font; })
    .catch((error) => console.error('failed to load shinonome.rom:', error));
  const commentSmallFont = new SmallFont(FONT_SMALL);

  const adapter = new MucomFmdspAdapter();

  function extractMmlHeader(mmlText) {
    const lines = mmlText.split(/\r\n|\r|\n/);
    const header = { title: null, composer: null, comment: null };
    for (const line of lines) {
      const m = line.match(/^\s*#\s*(title|composer|comment)\s+(.*)$/i);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const text = m[2].trim();
      if (header[key] === null) header[key] = text;
    }
    return header;
  }
  // 【不具合修正・2026-08-15】以前はここに「読み込み時の生バイト列をCP932決め打ちで
  // そのままスライスする」経路(旧extractMmlHeaderBytes/asciiOnlyCp932Bytes)があったが、
  // 同梱サンプルsamplja.mucがCP932保存だったため偶然動いていただけで、UTF-8保存の
  // MML(tools/sample_fur_elise_mucom.mml等)を読み込むと生バイトは実際はUTF-8なのに
  // CP932として描画され、コメント欄が文字化けしていた(asciiOnlyCp932Bytes側も非ASCII
  // は問答無用でnull=非表示だったため、直接入力した日本語ヘッダも出せていなかった)。
  // どちらも実測(ブラウザでコメント欄をキャンバスから読み出して確認)で発覚。
  //
  // 生の文字コードに依存せず、常に「デコード済みJS文字列(mmlText。decodeMmlBytes/
  // decodeMmlBytesAsで既にUTF-8/CP932どちらからでも正しく復元済み、または利用者が
  // 直接入力した文字列)」からヘッダを抜き出し(extractMmlHeader、既存)、表示直前に
  // CP932へ変換する(encodeCp932、PMD側のcompiler/cp932.mjsと同じ手法。ui/cp932-encode.js
  // は既存でPMD版が使用)方式に統一する。変換できない文字が含まれる場合はその項目だけ
  // 非表示にする(コンパイル自体は止めない。曲名表示の欠落であって再生の欠落ではないため)。
  function cp932BytesForComment(text) {
    if (!text) return null;
    const { bytes } = encodeCp932(text);
    return bytes; // 変換不能文字が1つでもあれば null(=非表示)
  }

  // FMDSP画面の「MUSIC FILE」バーに出す曲名。applyMmlBytes()(課題D注記のとおり
  // 読み込んだMMLがある限り常にここを通る唯一の窓口)で確定させる。
  //
  // 課題B追補(2026-08-15、利用者報告「同梱サンプルの経路でバーが空になった」):
  // 実際の原因は下書き復元(上のhasDraft分岐)がapplyMmlBytes()を経由せず
  // currentSongNameに一切触れていなかったこと。下書き復元は自動保存
  // (setupMmlAutosave、タブを閉じる/裏に回すだけでも保存される)により通常
  // 利用でもごく普通に起きる経路なので、「読み込み元がファイルではない」ことが
  // 分かるFILEBAR_RESTORED_DRAFT_NAMEをここで設定しておく(空のまま=壊れて
  // 見える、を避ける。fmdsp/rightpane.js drawFileBar()参照)。
  let currentSongName = hasDraft ? FILEBAR_RESTORED_DRAFT_NAME : null;
  let lastLoadedRawBytes = null;
  // 課題(net配線): 直近に読み込んだMMLの文字コード判定結果('utf-8'|'shift_jis'|null)。
  // 手動切替ボタン(encodingBadgeEl)の表示・再デコードに使う。
  let lastLoadedEncoding = null;
  // #voice(外部音色バンク)対応: 現在の曲に対になるシステムディスクのvoice.datが
  // 見つかっている場合、そのバイト列(8192byte)とディスク名をここに持つ。
  // applyMmlBytes()が唯一の書き込み窓口(opts.voiceBank省略時は必ずnullへ戻す設計に
  // することで、曲を切り替えるたびに前の曲のバンクが漏れ残らないようにしている。
  // 例外はbtnNewMml(新規作成)ハンドラで、applyMmlBytes()を経由しないため個別にnullへ
  // 戻している)。実際に#voiceタグとしてコンパイルへ渡す箇所はcompileAndPlay()。
  let currentVoiceBank = null;
  let currentVoiceBankSource = null;

  // --- URL指定読み込み時の状態表示(常時表示。enginePaneEl内はplayerモードで丸ごと
  // 隠れるため、その外側に置く)。 ---
  const netStatusEl = document.createElement('div');
  netStatusEl.className = 'net-status hidden';
  sampleLinksEl.insertAdjacentElement('afterend', netStatusEl);

  // --- 文字コード判定結果の表示+手動切替(課題: MMLはCP932とは限らない)。
  // 判定に失敗しても(=期待と違う結果でも)利用者が明示的に切り替えられるようにする。 ---
  const encodingBadgeEl = document.createElement('button');
  encodingBadgeEl.type = 'button';
  encodingBadgeEl.className = 'net-encoding-badge hidden';
  netStatusEl.insertAdjacentElement('afterend', encodingBadgeEl);

  // 課題D: #voice/#pcm(同梱以外は読み込めない)・リズム(G)パート使用の告知。
  // 控えめだが気づける表示にする(ui/mml-caveats.js参照。検出のみ、読み込み機能は作らない)。
  const mmlCaveatEl = document.createElement('div');
  mmlCaveatEl.className = 'mml-caveat-note hidden';
  encodingBadgeEl.insertAdjacentElement('afterend', mmlCaveatEl);

  function setNetStatus(message, isError) {
    netStatusEl.textContent = message;
    netStatusEl.classList.toggle('net-status-error', Boolean(isError));
    netStatusEl.classList.toggle('hidden', !message);
  }

  function updateMmlCaveat(mmlText) {
    const message = formatMmlCaveatMessage(detectMmlCaveats(mmlText));
    mmlCaveatEl.textContent = message ?? '';
    mmlCaveatEl.classList.toggle('hidden', !message);
  }

  function updateEncodingBadge() {
    if (!lastLoadedRawBytes) {
      encodingBadgeEl.classList.add('hidden');
      return;
    }
    encodingBadgeEl.classList.remove('hidden');
    const label = lastLoadedEncoding === 'utf-8' ? 'UTF-8' : 'CP932(Shift_JIS)';
    encodingBadgeEl.textContent = t('mucom.encodingBadge', { label });
  }

  encodingBadgeEl.addEventListener('click', () => {
    if (!lastLoadedRawBytes) return;
    const next = lastLoadedEncoding === 'utf-8' ? 'shift_jis' : 'utf-8';
    applyMmlBytes(lastLoadedRawBytes, { forceEncoding: next });
    // 表示内容が変わったので、コンパイル済み状態を無効化して再コンパイルを促す。
    markMmlDirty();
  });

  let commentBytesCache = [null, null, null];
  function setCommentFromMml(mmlText) {
    const header = extractMmlHeader(mmlText);
    commentBytesCache = [
      cp932BytesForComment(header.title),
      cp932BytesForComment(header.composer),
      cp932BytesForComment(header.comment),
    ];
  }
  function commentBytesFor(line) {
    return commentBytesCache[line] ?? null;
  }

  function snapshotAt(pointerWords, entryWords, logicalIndex) {
    const slot = logicalIndex & (snapshotRingSize - 1);
    const start = pointerWords + slot * entryWords;
    return Module.HEAP32.subarray(start, start + entryWords);
  }

  function findSnapshot(pointerWords, entryWords, writeIndex, targetFrame) {
    const available = Math.min(writeIndex, snapshotRingSize);
    const oldest = writeIndex - available;
    const newest = writeIndex - 1;
    const oldestEntry = snapshotAt(pointerWords, entryWords, oldest);
    const newestEntry = snapshotAt(pointerWords, entryWords, newest);

    if (targetFrame <= (oldestEntry[0] >>> 0)) return oldestEntry;
    if (targetFrame >= (newestEntry[0] >>> 0)) return newestEntry;

    let low = oldest;
    let high = newest;
    while (low <= high) {
      const middle = low + Math.floor((high - low) / 2);
      const entry = snapshotAt(pointerWords, entryWords, middle);
      if ((entry[0] >>> 0) <= targetFrame) {
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return snapshotAt(pointerWords, entryWords, high);
  }

  function displaySnapshot(entry) {
    for (let ch = 0; ch < MUCOM_CH_COUNT; ch++) {
      const track = entry.subarray(
        snapshotHeaderWordCount + ch * PCH_FIELD_COUNT,
        snapshotHeaderWordCount + (ch + 1) * PCH_FIELD_COUNT);
      const cells = channelTableBody.rows[ch].cells;
      cells[1].innerText = track[1];
      cells[2].innerText = track[2];
      cells[3].innerText = track[3];
      cells[4].innerText = track[0];
      cells[5].innerText = `${track[5]}/${track[6]}`;
      cells[6].innerText = track[8];
    }
  }

  function readLevels(entry) {
    const levelBase = (entry.byteOffset + Module.getSnapshotLevelOffset()) / 4;
    const fieldCount = Module.getLevelFieldCount();
    const levels = new Array(Module.getLevelCount());
    for (let c = 0; c < levels.length; c++) {
      const o = levelBase + c * fieldCount;
      levels[c] = {
        level: Module.HEAP32[o + 0],
        pan: Module.HEAP32[o + 1],
        prog: Module.HEAP32[o + 2],
        key: Module.HEAP32[o + 3],
        playing: Module.HEAP32[o + 4] !== 0,
      };
    }
    return levels;
  }

  function passTickToGeneratedFrames55467(passTick) {
    const ms = Math.max(0, passTick) / 1024;
    const frames = Math.round((ms * 55467) / 1000);
    return BigInt(frames);
  }

  function draw(entry) {
    const passTick = entry[SNAPSHOT_HEADER.PASS_TICK] | 0;
    const intCount = (entry[SNAPSHOT_HEADER.INT_COUNT] | 0) >>> 0;
    const maxCount = entry[SNAPSHOT_HEADER.MAX_COUNT] | 0;
    const entryTracks = [];
    for (const [chStr, slot] of Object.entries(CH_TO_SLOT)) {
      const ch = Number(chStr);
      const pchData = entry.subarray(
        snapshotHeaderWordCount + ch * PCH_FIELD_COUNT,
        snapshotHeaderWordCount + (ch + 1) * PCH_FIELD_COUNT);
      const chstatIdx = CH_TO_CHSTAT[ch];
      const chstatValue = chstatIdx !== undefined ? entry[CHSTAT_OFFSET + chstatIdx] : undefined;
      entryTracks[slot] = adapter.convertChannel(ch, pchData, chstatValue);
    }

    if (fmdspFont) {
      vram.pixels.set(staticVramSnapshot);
      drawTrackRows(vram, fmdspFont, entryTracks, mutedRows);
      drawComment(vram, commentSmallFont, fmdspFont, commentBytesFor, false, 0);

      const audioState = globalThis.mucomAudioState;
      const rightPaneHasPlayback = Boolean(audioState?.playback);
      const rightPanePaused = Boolean(audioState?.paused);
      const rightPanePlaying = rightPaneHasPlayback && !rightPanePaused;
      rightPaneFrameCounter = (rightPaneFrameCounter + 1) & 0xffffffff;
      rightpane.drawDynamic(vram, {
        generatedFrames: passTickToGeneratedFrames55467(passTick),
        timerbCnt: intCount,
        timerb: 0,
        loopCnt: maxCount > 0 ? Math.floor(intCount / maxCount) : 0,
        cpuUsage: 0,
        fps: 0,
        timerbCntLoop: 0,
        loopTimerbCnt: 0,
        playing: rightPanePlaying,
        stopped: !rightPaneHasPlayback,
        paused: rightPanePaused,
        frameCnt: rightPaneFrameCounter,
      });

      const fftBase = entry.byteOffset + Module.getSnapshotFftOffset();
      const fft = Module.HEAPU8.subarray(fftBase, fftBase + Module.getFftBinCount());
      const levels = readLevels(entry);
      rightpane.drawSpectrumBars(vram, fft, fftPeakState);
      rightpane.drawLevelMeters(vram, levels, levelPeakState);
      rightpane.drawFileBar(vram, currentSongName);

      canvasCtx.putImageData(vram.toImageData(palette), 0, 0);
    }
  }

  const debug = document.getElementById('snapshotDebug');

  function updateChannelStatus() {
    updateTransportButtonUI();

    if (Boolean(globalThis.mucomAudioState?.paused)) {
      if (pausedFrameDrawn) {
        requestAnimationFrame(updateChannelStatus);
        return;
      }
      pausedFrameDrawn = true;
    }

    if (typeof Module.getSnapshotWriteIndex === 'function' && Module.HEAP32) {
      const writeIndex = Module.getSnapshotWriteIndex() >>> 0;
      if (writeIndex === invalidWriteIndex || writeIndex === 0) {
        debug.innerText = 'snapshot ring: inactive/empty';
        // 2026-08-15: PMD側と同じ実機報告(左半分のパート行が真っ黒)への対処。
        // フォント未ロードの間は再試行し、実際に描けたときだけフラグを立てる
        // (詳細はhtml/pmd-app.jsの同名分岐のコメント参照)。
        // idleDrawnSongNameは「?mml=読み込み(非同期fetch)がこの一回描画より後に
        // 完了し、曲名だけ古いまま固定されてしまう」抜けを防ぐため、曲名が変わったら
        // stoppedFrameDrawnの状態に関わらず描き直す(html/pmd-app.jsと同じ対処)。
        if (fmdspFont && (!stoppedFrameDrawn || idleDrawnSongName !== currentSongName)) {
          stoppedFrameDrawn = true;
          idleDrawnSongName = currentSongName;
          vram.pixels.set(staticVramSnapshot);
          drawTrackRows(vram, fmdspFont, idleEntryTracks, mutedRows);
          drawComment(vram, commentSmallFont, fmdspFont, commentBytesFor, false, 0);
          rightPaneFrameCounter = (rightPaneFrameCounter + 1) & 0xffffffff;
          rightpane.drawCircle(vram, { playing: false, paused: false, timerbCnt: 0, frameCnt: rightPaneFrameCounter });
          rightpane.drawTransportIcons(vram, { playing: false, stopped: true, paused: false });
          rightpane.drawFileBar(vram, currentSongName);
          canvasCtx.putImageData(vram.toImageData(palette), 0, 0);
        }
      } else {
        stoppedFrameDrawn = false;
        const pointerWords = Module.getSnapshotRingPointer() / 4;
        const entryWords = Module.getSnapshotEntryByteSize() / 4;
        const latest = snapshotAt(pointerWords, entryWords, writeIndex - 1);
        const renderFrame = latest[0] >>> 0;
        const audioState = globalThis.mucomAudioState;
        const playback = audioState && audioState.playback;
        let selected = latest;
        let syncText = 'sync: waiting for playFrame';

        if (playback && audioState.context) {
          const context = audioState.context;
          const sampleRate = context.sampleRate;
          const outputLatency = Number.isFinite(context.outputLatency) && context.outputLatency > 0
            ? context.outputLatency
            : (Number.isFinite(context.baseLatency) && context.baseLatency > 0
              ? context.baseLatency : 0);
          const calibrationMs = Math.max(-200, Math.min(200,
            Number.parseFloat(calibrationInput.value) || 0));
          const estimatedPlayFrame = playback.playFrame +
            (context.currentTime - playback.contextTime) * sampleRate;
          const audibleFrame = Math.max(0, estimatedPlayFrame -
            (outputLatency + calibrationMs / 1000) * sampleRate);
          if (synchronizedCheckbox.checked) {
            selected = findSnapshot(pointerWords, entryWords, writeIndex, audibleFrame);
          }
          const differenceMs = (renderFrame - audibleFrame) / sampleRate * 1000;
          syncText = `sync: audibleFrame=${Math.round(audibleFrame)} renderFrame=${renderFrame} ` +
            `difference=${differenceMs.toFixed(1)}ms latency=${(outputLatency * 1000).toFixed(1)}ms ` +
            `calibration=${calibrationMs.toFixed(1)}ms`;
        }

        displaySnapshot(selected);
        draw(selected);

        // 課題B→撤去(2026-08-15): MUCOM88の自動終了検出(頭出し停止)は信頼できる
        // 判定手段が無いと判明したため撤去した。詳細は上のmoduleReady初期化直後の
        // コメント、docs/transport-button-state.md 症状⑧を参照。

        const t = selected.subarray(snapshotHeaderWordCount, snapshotHeaderWordCount + 15);
        const dbgPassTick = selected[SNAPSHOT_HEADER.PASS_TICK] | 0;
        const dbgIntCount = (selected[SNAPSHOT_HEADER.INT_COUNT] | 0) >>> 0;
        const dbgMaxCount = selected[SNAPSHOT_HEADER.MAX_COUNT] | 0;
        debug.innerText = `${syncText}\n` +
          `snapshot: selectedFrame=${selected[0] >>> 0} writeIndex=${writeIndex}\n` +
          `track0 length=${t[0]} vnum=${t[1]} volume=${t[2]} quantize=${t[3]} ` +
          `detune=${t[4]} fnum=${t[5]}/${t[6]} flag=${t[8]}\n` +
          `counters: passTick=${dbgPassTick} (${(dbgPassTick / 1024).toFixed(1)}ms) ` +
          `intCount=${dbgIntCount} maxCount=${dbgMaxCount} ` +
          `loopCnt=${dbgMaxCount > 0 ? Math.floor(dbgIntCount / dbgMaxCount) : 0} ` +
          `audioContextTime=${(audioState?.context?.currentTime ?? 0).toFixed(3)}s`;
      }
    }

    const audioState = globalThis.mucomAudioState;
    if (audioState) {
      const stats = audioState.stats;
      document.getElementById('audioDebug').innerText =
        `AudioWorklet: requested=${stats.requestedFrames} rendered=${stats.renderedFrames} ` +
        `queued=${stats.queuedFrames} underflow=${stats.underflowFrames}`;
    }
    requestAnimationFrame(updateChannelStatus);
  }
  requestAnimationFrame(updateChannelStatus);

  function selectedRate() {
    const select = document.getElementById('srateSelect');
    const rate = parseInt(select.value, 10);
    return Number.isFinite(rate) ? rate : 44100;
  }

  const cp932MessageDecoder = new TextDecoder('shift_jis');

  // 課題D: ダウンロード用に「直近で実際にコンパイルできたバイト列(.mub)」を
  // 保持する。CompileMML()はコンパイル結果を仮想FS上の固定パス"/mucom.mub"へ
  // 書く(mucomweb/src/MucomWeb.cpp のmubPath)。PMD側と違いJS側でバイト列を
  // 作っていない(コンパイラがwasm内)ため、Module.FS.readFile()で読み戻す。
  const MUB_PATH = '/mucom.mub';
  let lastCompiledBytes = null;

  // #voice(外部音色バンク)対応: 対になるシステムディスクのvoice.datが見つかっている
  // 曲(currentVoiceBank、applyMmlBytes()参照)をコンパイルするとき、この固定パスへ
  // MEMFS書き込みして`#voice <path>`をコンパイル専用テキストの先頭に足す
  // (rhythmパートのWAV書き込み、html/mucom-app.js冒頭のMEMFS書き込み箇所と同じ
  // 「html/mucom-app.jsがコンパイル前にMEMFSへ書く」作法)。
  const VOICE_BANK_MEMFS_PATH = '/voicebank_ext.dat';
  // MMLが既に`#voice`ヘッダを持っている場合はそちらを尊重し、上書きしない
  // (利用者指示)。net-load.js mmlHeaderField()と同じ「行頭の#<field>」規則。
  const EXPLICIT_VOICE_TAG_RE = /^[ \t]*#voice\b/im;

  function compileAndPlay() {
    if (!moduleReady) return;
    const mml = document.getElementById('mml').value;
    // 課題A: 編集欄が空のまま再生された場合、古いエラー表示を残さず案内を出して終える。
    if (mml.trim().length === 0) {
      showEmptyMmlNotice();
      return;
    }
    // 課題A: 新しいコンパイルを開始するタイミングで前回の表示を消す(この直後
    // renderCompileResult()が今回の結果で上書きするが、「開始時に消す」という
    // 要求どおりの箇所として明示的に置く)。
    clearCompileStatus();
    adapter.reset();
    // 曲を読み込み直すたびにミュートを全解除する(利用者指示: 意図しない無音を
    // 次の曲へ持ち越さない)。
    mutedRows.clear();
    applyChannelMask();
    setCommentFromMml(mml);
    const audioStateBefore = globalThis.mucomAudioState;
    const generationBefore = audioStateBefore ? audioStateBefore.generation : null;
    // #voice注入の可否を先に決める(元のmml、名前解決前のテキストで判定する。
    // `@"名前"`置換は`#voice`行に触れないため、先に判定しても後に判定しても結果は
    // 同じだが、名前解決に使う表を選ぶ材料として先に必要になる)。
    // currentVoiceBankがあり、かつMML側が既に`#voice`を持っていない場合だけ外部
    // バンクを使う(利用者指示: 既に`#voice`がある場合はそちらを尊重して上書きしない)。
    const voiceBankApplied = Boolean(currentVoiceBank) && !EXPLICIT_VOICE_TAG_RE.test(mml);
    // 課題(音色名解決): `@"名前"` はMUCOM88のZ80コンパイラが非ASCII名で必ず落ちる
    // (ui/mucom-voice-resolve.js冒頭コメント参照)。コンパイルに渡すテキストだけを
    // `@番号` へ事前置換し、利用者が編集しているMML本文(mml変数・textarea)自体は
    // 一切書き換えない(表示は常に原文のまま)。
    // 【最重要・外部音色バンク対応】名前解決の表も外部バンク側へ切り替える: 外部
    // バンクを使う曲(voiceBankApplied)では、そのバンクのバイト列自身から作った
    // 名前表で解決しないと、既定バンクの表のまま`@番号`へ置換した結果が外部バンク
    // 側では別の音色を指してしまう(ui/mucom-voice-resolve.js冒頭コメント参照)。
    const { text: mmlNameResolved, unresolvedNames } =
      resolveMucomVoiceNameRefs(mml, voiceBankApplied ? currentVoiceBank : undefined);
    // #voice注入: コンパイル専用テキストの先頭へ`#voice <MEMFSパス>`を足す。
    // 利用者が編集しているMML本文(mml変数・textarea)には一切触れない
    // (音色名解決と同じ方針)。
    let mmlForCompile = mmlNameResolved;
    if (voiceBankApplied) {
      Module.FS.writeFile(VOICE_BANK_MEMFS_PATH, currentVoiceBank);
      mmlForCompile = `#voice ${VOICE_BANK_MEMFS_PATH}\n${mmlNameResolved}`;
    }
    Module.compileMML(mmlForCompile, selectedRate());
    const msgPtr = Module.getCompileMessagePointer();
    const msgLen = Module.getCompileMessageLength();
    const msgBytes = Module.HEAPU8.subarray(msgPtr, msgPtr + msgLen);
    let compileMessage = cp932MessageDecoder.decode(msgBytes);
    if (unresolvedNames.length > 0) {
      compileMessage += t('mucom.unresolvedVoiceNames', { names: unresolvedNames.join(', ') });
    }
    if (voiceBankApplied) {
      compileMessage += t('mucom.voiceBankInUse', { source: currentVoiceBankSource ?? t('mucom.externalBankFallback') });
    }
    renderCompileResult(compileMessage);
    const audioStateAfter = globalThis.mucomAudioState;
    const compiledOk = Boolean(audioStateAfter) && audioStateAfter.generation !== generationBefore;
    if (compiledOk) {
      mmlDirty = false;
      hasCompiled = true;
      try {
        lastCompiledBytes = Module.FS.readFile(MUB_PATH);
      } catch {
        lastCompiledBytes = null; // 実測上起きない想定だが、読めなければダウンロード側を無効のままにする
      }
    }
    setAudioPaused(false);
  }

  btnStop.addEventListener('click', function() {
    stopPlayback();
  });

  // 課題B: 「Clear MML」を「新規作成」に置き換える。空にするのではなく、押した直後に
  // そのまま再生すれば音が鳴る最小の雛形(MUCOM_NEW_MML_TEMPLATE)を入れる。
  // 既存の確認(内容があるときだけ)とCmd/Ctrl+Zでの取り消しの挙動はそのまま引き継ぐ。
  btnNewMml.addEventListener('click', function() {
    const ta = document.getElementById('mml');
    if (ta.value.length > 0) {
      const ok = window.confirm(t('confirm.newFile'));
      if (!ok) return;
    }
    ta.focus();
    ta.select();
    const undoable = typeof document.execCommand === 'function' &&
      document.execCommand('insertText', false, MUCOM_NEW_MML_TEMPLATE);
    if (!undoable) {
      ta.value = MUCOM_NEW_MML_TEMPLATE;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    mmlEditorApi.render();
    lastLoadedRawBytes = null;
    // #voice対応: このハンドラはapplyMmlBytes()を経由しないため、外部音色バンクの
    // 状態もここで個別にリセットする(でないと直前の曲のバンクが新規作成の雛形に
    // 残ってしまう)。
    currentVoiceBank = null;
    currentVoiceBankSource = null;
    // 課題A: 編集内容を消した(新規作成した)ときも前回のエラー表示を残さない。
    clearCompileStatus();
    // 課題D: 新規作成の雛形には#voice/#pcm/リズムが無いため、告知も消す。
    updateMmlCaveat('');
    // 【不具合修正・2026-08-16】新規作成しても`?mml=<URL>`がアドレスバーに残ったままだと、
    // リロード時に「編集欄は新規の雛形なのに消したはずの書庫を読みに行ってしまう」
    // (net-load.js clearLoadedUrlFromAddressBar()冒頭コメント参照。利用者報告)。
    clearLoadedUrlFromAddressBar();
  });

  // 課題(net配線): 文字コードは決め打ちしない(以前はshift_jis固定だった)。
  // UTF-8として妥当なバイト列かを検査し、駄目ならCP932とみなす(net/charset.js参照。
  // 検証材料でUTF-8保存のMUCOM88 MMLが実在することを確認済み)。
  // opts.forceEncoding を渡すと判定結果を無視して指定のエンコーディングで強制デコードする
  // (encodingBadgeEl のクリックによる手動切替用)。
  function applyMmlBytes(bytesOrBuffer, opts = {}) {
    const rawBytes = bytesOrBuffer instanceof Uint8Array ? bytesOrBuffer : new Uint8Array(bytesOrBuffer);
    const forced = opts.forceEncoding ?? null;
    const { text, encoding } = forced
      ? { text: decodeMmlBytesAs(rawBytes, forced), encoding: forced }
      : decodeMmlBytes(rawBytes);
    lastLoadedRawBytes = rawBytes;
    lastLoadedEncoding = encoding;
    mmlTextarea.value = text;
    mmlEditorApi.render();
    updateEncodingBadge();
    // 課題D: 読み込んだMMLがある限り常にここを通る(曲を開く/D&D/サンプル/URL/
    // 書庫読み込みのすべてがapplyMmlBytes()を経由するため、ここ1箇所で足りる)。
    updateMmlCaveat(text);
    // FMDSP画面のファイル名(FILEBAR)もこの唯一の窓口で確定させる。呼び出し側が
    // 渡すopts.nameは常に「ファイル名」であること(html/net-load.js resolveSongFromUrl()
    // のfileNameフィールド、File.name、書庫エントリ名等)。
    //
    // 課題B(2026-08-15): 以前はopts.name省略時にMML本文の#titleヘッダへフォールバック
    // していたが、FILEBARは半角専用フォントで描くため全角の曲名を渡すと文字が
    // 途中で欠けて中途半端に見える不具合になっていた。本家どおり「ファイル名」専用に
    // 統一したため、ここでタイトルを拾うのはもう適切ではない。opts.name省略時
    // (文字コード切替による再デコード等、新しいファイルの読み込みを伴わない呼び出し)は
    // currentSongNameに触れず、既存のファイル名表示をそのまま保つ。
    if (opts.name !== undefined) {
      currentSongName = opts.name;
    }
    // #voice(外部音色バンク)対応: opts.voiceBankが渡されなければ必ずnullに戻す
    // (unconditionalな代入。曲を切り替えるたびに前の曲のバンクが残らないようにする
    // ための唯一の窓口。対になるシステムディスクを持つ書庫由来の曲だけが
    // opts.voiceBankを渡してくる。単体ファイル/D&D/曲ライブラリ選択(バンク無し)/
    // サンプル読み込みはすべてここでnullへ戻る)。
    currentVoiceBank = opts.voiceBank ?? null;
    currentVoiceBankSource = opts.voiceBankSource ?? null;
  }

  function downloadMML(url) {
    // 課題A: 復元した下書き/編集中の内容をサンプルで黙って上書きしない。
    // 何か入っている状態でのクリックだけ確認する(空なら聞くまでもない)。
    if (mmlTextarea.value.trim().length > 0) {
      const ok = window.confirm(t('confirm.sampleReplace'));
      if (!ok) return Promise.resolve();
    }
    return fetch(url)
      .then(response => response.arrayBuffer())
      .then(buffer => {
        applyMmlBytes(buffer, { name: url.split('/').pop() });
        compileAndPlay();
      });
  }

  document.getElementById('dlSampleFurEliseMucom').addEventListener('click', function() {
    downloadMML('./sample_fur_elise_mucom.muc');
  });

  document.getElementById('dlSamplJa').addEventListener('click', function() {
    downloadMML('./samplja.muc');
  });

  // --- 曲を開く(ローカルの.mucファイル選択 / ドラッグ&ドロップ) ---
  //
  // 【拡張・2026-08-16】ローカルファイルが書庫(zip/lzh/d88)だった場合の対応を追加。
  // 以前はここで書庫判定を一切せず、書庫のバイト列をそのままapplyMmlBytes()(MML
  // テキストとしてデコードする経路)へ渡していたため無言で壊れていた(利用者報告)。
  // URL経路(下のloadSongFromUrl())が既に持っている書庫展開・曲選択・ライブラリ
  // 一括取り込みの仕組みへ合流させる(html/net-load.js resolveSongFromFile()が
  // resolveSongFromUrl()と同じnet/archive.js・net/song-select.jsを経由するため、
  // 判定・展開ロジックはここで新しく書き起こさない)。
  async function openMmlFile(file) {
    if (!file) return;
    let resolved;
    try {
      resolved = await resolveSongFromFile(file);
    } catch (err) {
      setNetStatus(describeNetError(err), true);
      return;
    }
    // 修正1: 「ファイルから開く」/ドラッグ&ドロップもURL由来ではないので、
    // 残っている`?mml=`はここで取り除く。
    clearLoadedUrlFromAddressBar();

    if (resolved.kind === 'archive') {
      const mucomCandidates = resolved.candidates.filter((c) => c.driver === 'mucom');
      if (mucomCandidates.length === 0) {
        const otherCount = resolved.candidates.length;
        setNetStatus(
          otherCount > 0
            ? t('net.noMucomCandidatesOther', { otherCount })
            : t('net.noPlayableSongs'),
          true,
        );
        return;
      }
      // 自動取り込み: URL経路(loadSongFromUrl())と同じく、書庫を開いた時点(=候補一覧が
      // 出た時点、どれを再生するか選ぶ前)で書庫内の全曲をライブラリへ一括取り込みする。
      // 出所はURLではなくローカルファイルなので kind: 'local' を渡す(net/library.js
      // importArchiveSongs()参照。computeSongId()もkind==='local'+entryPathありを
      // 書庫由来として扱うよう対応済み)。
      const importResult = await importArchiveSongsToLibrary({
        driver: 'mucom', kind: 'local', url: null, entries: resolved.entries, archiveLabel: resolved.archiveLabel,
        candidates: mucomCandidates, defaultVoiceNames: MUCOM_DEFAULT_VOICE_NAMES,
      });
      if (importResult.added > 0) {
        setNetStatus(t('net.addedToLibrary', { count: importResult.total }), false);
      } else if (importResult.total > 0) {
        setNetStatus(t('net.alreadyInLibrary', { count: importResult.total }), false);
      }

      let chosen = mucomCandidates[0];
      if (mucomCandidates.length > 1) {
        libraryPopover.close();
        chosen = await pickSongCandidate(mucomCandidates, { entries: resolved.entries, archiveLabel: resolved.archiveLabel });
        if (!chosen) {
          setNetStatus(t('net.selectionCancelled'), false);
          return;
        }
      }
      // #voice対応: URL経路と同じく、対になるシステムディスクのvoice.datが同じ書庫内に
      // 見つかればコンパイル時に使う(net/voice-bank.js参照)。
      const voicePair = findPairedVoiceBank(resolved.entries, chosen.entry.name, MUCOM_DEFAULT_VOICE_NAMES);
      applyMmlBytes(chosen.entry.data, {
        name: chosen.displayName,
        voiceBank: voicePair ? voicePair.bytes : null,
        voiceBankSource: voicePair ? voicePair.sysDiskName : null,
      });
      compileAndPlay();
      setNetStatus(
        voicePair
          ? t('net.loadedReadyWithVoiceBank', { name: chosen.displayName, source: voicePair.sysDiskName })
          : t('net.loadedReady', { name: chosen.displayName }),
        false,
      );
      return;
    }

    applyMmlBytes(resolved.bytes, { name: resolved.fileName });
    compileAndPlay();
    // 自動取り込み(利用者指示): 「曲を開く」/ドラッグ&ドロップで読み込んだ曲は
    // そのまま曲ライブラリへ残す。ローカルファイルにはURLが無いため、出所は
    // ファイル名だけで識別する(net/library.js computeSongId()参照)。
    persistSongToLibrary({
      driver: 'mucom',
      bytes: resolved.bytes,
      fileName: resolved.fileName,
      origin: { kind: 'local', url: null, archiveName: null, groupPath: null, entryPath: null },
    });
  }

  // 「曲を開く」のメニュー化(ファイルから開く/URLから開く)。「ファイルから開く」は
  // 従来どおりfileInputを開くだけ(利用者指示: 既存の挙動を変えないこと)。
  // 「URLから開く」はloadSongFromUrl()(下部、従来の?mml=読み込みと共通)へそのまま合流させる。
  const openMenu = createOpenMenu({
    onFileOpen: () => {
      fileInput.value = '';
      fileInput.click();
    },
    onUrlSubmit: (url) => {
      loadSongFromUrl(url);
    },
  });
  openMenuPopover = setupPopover(btnOpenFile, openMenu.popoverEl);
  btnOpenFile.addEventListener('click', () => {
    // setupPopover()自身のクリックハンドラ(上のsetupPopover()呼び出し内で登録済み、
    // このリスナーより先に実行される)が開閉をトグルした「後」にここへ来る。
    // 開いた直後だけ、メニュー表示へリセットし、他のポップオーバー/モーダルを閉じる
    // (利用者指示: 重なり対策。曲ライブラリ・書庫選択モーダル側と同じ「後から開く方を
    // 優先する」考え方)。
    if (!openMenu.popoverEl.classList.contains('hidden')) {
      openMenu.resetToMenu();
      libraryPopover.close();
      closeActiveSongPicker();
    }
  });
  openMenu.setCloseHandler(openMenuPopover.close);
  fileInput.addEventListener('change', () => {
    openMmlFile(fileInput.files && fileInput.files[0]);
  });

  // 課題B: ドロップの受付はapp.js側(ページ全体、setupPageDropZone)に一本化した。
  // ここでは「ドロップされたファイルをどう解釈するか」だけを登録する(1件目のみ
  // 使う。複数件落とされた場合は黙って捨てず、netStatusで案内する)。
  ctx.handleDroppedFiles = (files) => {
    if (files.length > 1) {
      setNetStatus(t('net.dropMultiple', { count: files.length, name: files[0].name }), false);
    }
    openMmlFile(files[0]);
  };

  // --- 課題D: ダウンロード(MMLソース/コンパイル済み.mub/asmのdb配列)。
  const downloadMenu = createDownloadMenu({
    driverKey: 'mucom',
    mmlFilename: 'mucom-mml.mml',
    compiledFilename: 'mucom-song.mub',
    compiledLabel: '.mub',
    asmFilename: 'mucom-song-db.asm',
    asmLabel: 'mucom_song_data',
    getMmlText: () => mmlTextarea.value,
    getCompiledBytes: () => lastCompiledBytes,
  });
  btnDownload.addEventListener('click', () => downloadMenu.render());
  setupPopover(btnDownload, downloadMenu.popoverEl);

  // --- 課題C: キーボードショートカット(⌘/Ctrl+Enterでコンパイル&再生、Escで停止)。
  setupTransportShortcuts({
    btnPlayPause,
    btnStop,
    popovers: [settingsPopoverEl, downloadMenu.popoverEl],
  });

  // --- URL指定での曲読み込み(?mml=<URL> / ツールバー「曲を開く」→「URLから開く」の
  // 両方から呼ばれる共通関数。net/(取得・書庫展開)を実際にUIへ配線する箇所
  // (2026-08-15新設、2026-08-16に「URLから開く」メニューからも合流させた)。
  // 読み込むだけで自動再生はしない: AudioContextはユーザー操作を
  // 要求するため、ここで鳴らそうとしても実際には鳴らないのに「リングは進んでいるが
  // 無音」という紛らわしい状態になる。applyMmlBytes()はcompileAndPlay()を呼ばないので、
  // 読み込み後にmmlDirty/hasCompiledの状態から自然に「未コンパイル」扱いになり、
  // 利用者が再生ボタンを押すとneedsCompileNow()経由でコンパイル&再生される。
  async function loadSongFromUrl(url) {
    setNetStatus(t('net.loading', { url }), false);
    let resolved;
    try {
      resolved = await resolveSongFromUrl(url, (loaded, total) => {
        setNetStatus(total ? t('net.loadingProgress', { loaded, total }) : t('net.loadingProgressNoTotal', { loaded }), false);
      });
    } catch (err) {
      setNetStatus(describeNetError(err), true);
      return;
    }

    if (resolved.kind === 'archive') {
      const mucomCandidates = resolved.candidates.filter((c) => c.driver === 'mucom');
      if (mucomCandidates.length === 0) {
        const otherCount = resolved.candidates.length;
        setNetStatus(
          otherCount > 0
            ? t('net.noMucomCandidatesOther', { otherCount })
            : t('net.noPlayableSongs'),
          true,
        );
        return;
      }
      // 自動取り込み(利用者指示、2026-08-16): 「実際に再生した曲だけ」では2度目以降に
      // アルバムを開いても1曲しか出ない不備があったため、書庫を開いた時点(=候補一覧が
      // 出た時点、どれを再生するか選ぶ前)でこの書庫内の全曲をライブラリへ一括取り込みする。
      // 55曲程度でもUIを固めないよう1トランザクションで書く(net/library.js saveSongs())。
      // 重複判定は既存のまま(computeSongId()+内容ハッシュ)なので、同じ書庫を2回開いても
      // 増えない。取り込み件数はネット状態表示(下のpickSongCandidate()モーダルの裏に
      // 見えたままになる)で利用者に伝える。
      const importResult = await importArchiveSongsToLibrary({
        driver: 'mucom', url, entries: resolved.entries, archiveLabel: resolved.archiveLabel, candidates: mucomCandidates,
        defaultVoiceNames: MUCOM_DEFAULT_VOICE_NAMES,
      });
      if (importResult.added > 0) {
        setNetStatus(t('net.addedToLibrary', { count: importResult.total }), false);
      } else if (importResult.total > 0) {
        setNetStatus(t('net.alreadyInLibrary', { count: importResult.total }), false);
      }

      let chosen = mucomCandidates[0];
      if (mucomCandidates.length > 1) {
        // 逆方向: 書庫選択モーダルを開く時点でライブラリが開いていたら閉じる。
        // 全画面オーバーレイ(z-index高)が上に乗るだけだとライブラリの半透明の
        // 背景越しに透けて重なって見える不具合そのものなので、同じ「後から
        // 開く方を優先する」考え方をここでも揃える。
        libraryPopover.close();
        // 修正3: 選択画面にも曲ライブラリと同じ曲名/アルバム名を出す(net-load.js
        // describeSongCandidate()参照)。entries/archiveLabelを渡さないとファイル名の
        // ままになる。
        chosen = await pickSongCandidate(mucomCandidates, { entries: resolved.entries, archiveLabel: resolved.archiveLabel });
        if (!chosen) {
          setNetStatus(t('net.selectionCancelled'), false);
          return;
        }
      }
      // #voice対応: 選んだ曲のディスク(MML_<X>.d88由来)に対になるシステムディスク
      // (MUCOM88_V<バージョン>_<X>.d88)のvoice.datが同じ書庫内に見つかれば、それを
      // コンパイル時に使う(net/voice-bank.js参照)。見つからない場合(ALGARNA/
      // SLAP_FIGHT_MDのように対になるシステムディスクが無い、または単体ファイル/
      // zip直下の.muc等d88経由でない曲)はnullのまま=従来どおり既定バンクで鳴る。
      const voicePair = findPairedVoiceBank(resolved.entries, chosen.entry.name, MUCOM_DEFAULT_VOICE_NAMES);
      applyMmlBytes(chosen.entry.data, {
        name: chosen.displayName,
        voiceBank: voicePair ? voicePair.bytes : null,
        voiceBankSource: voicePair ? voicePair.sysDiskName : null,
      });
      setNetStatus(
        voicePair
          ? t('net.loadedReadyWithVoiceBank', { name: chosen.displayName, source: voicePair.sysDiskName })
          : t('net.loadedReady', { name: chosen.displayName }),
        false,
      );
      reflectLoadedUrlInAddressBar(url);
      return;
    }

    // 課題B: FILEBAR(FMDSP)にはファイル名専用のresolved.fileNameを渡す。
    // ツールバーの「読み込みました」表示は従来どおり曲名(タイトル)を優先する
    // resolved.nameのまま(役割が違ってよい、利用者判断)。
    applyMmlBytes(resolved.bytes, { name: resolved.fileName });
    setNetStatus(t('net.loadedReady', { name: resolved.name }), false);
    reflectLoadedUrlInAddressBar(url);
    // 自動取り込み: 単体ファイルURLも同様にライブラリへ残す(書庫ではないためアルバム
    // 情報は持たない=「個別ファイル」グループに入る。net/library.js groupSongsIntoAlbums()参照)。
    persistSongToLibrary({
      driver: 'mucom',
      bytes: resolved.bytes,
      fileName: resolved.fileName ?? urlBaseName(url),
      origin: { kind: 'url', url, archiveName: null, groupPath: null, entryPath: null },
    });
  }

  // 課題E: ?mml=の指定も下書きも無い初見時は、同梱サンプル(エリーゼのために)を
  // 読み込んだ状態にしておく(自動再生はしない。applyMmlBytes()はテキストを
  // textareaへ入れるだけでcompileAndPlay()を呼ばないため、そのまま流用できる)。
  // 下書きがあるときは絶対に上書きしない(hasDraftで分岐)。
  async function loadDefaultSample() {
    const response = await fetch('./sample_fur_elise_mucom.muc');
    const buffer = await response.arrayBuffer();
    applyMmlBytes(buffer, { name: 'sample_fur_elise_mucom.muc' });
  }

  if (ctx.songUrl) {
    loadSongFromUrl(ctx.songUrl);
  } else if (!hasDraft) {
    loadDefaultSample();
  }
}
