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
import { drawTrackRows } from './fmdsp/trackrow.js';
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
import { setupPopover } from './ui/shell.js';
import { resolveSongFromUrl, pickSongCandidate } from './net-load.js';
import { decodeMmlBytes, decodeMmlBytesAs } from './net/charset.js';

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

export async function init(ctx) {
  const {
    canvas, consoleCard, toolbar,
    btnPlayPause, btnStop, btnOpenFile, btnDownload, settingsPopoverEl, btnFullscreen,
    fileInput, sampleLinksEl, enginePaneEl, footerCreditsEl, rescale,
  } = ctx;

  // --- footer credits ---
  footerCreditsEl.innerHTML =
    '<a href="https://github.com/onitama/mucom88" target="_blank" rel="noopener">OPEN MUCOM88</a> ' +
    '<a href="https://github.com/onitama/mucom88/blob/master/package/license.txt" target="_blank" rel="noopener">(LICENSE)</a> | ' +
    '<a href="https://github.com/aosoft/MucomWeb" target="_blank" rel="noopener">MUCOM88 on Web</a> ' +
    '<a href="https://github.com/aosoft/MucomWeb/blob/master/LICENSE" target="_blank" rel="noopener">(LICENSE)</a> / ' +
    '<a href="https://creativecommons.org/licenses/by-nc-sa/4.0/deed.ja" target="_blank" rel="noopener">CC BY-NC-SA 4.0</a>';

  fileInput.accept = '.muc';

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
      <summary>デバッグ用テーブル(生のPCHDATA、切り分け用に残す)</summary>
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
    Sample MML:
    <a href="javascript:void(0);" id="dlSampleFurEliseMucom">sample_fur_elise_mucom.muc(エリーゼのために・冒頭)</a>
    <a href="javascript:void(0);" id="dlSamplJa" class="debug-only">samplja.muc</a>
  `;

  // --- モード(player/editor)。localStorageに保存し、次回も同じモードで開く ---
  const UI_MODE_KEY = 'fmsound-mucom-ui-mode';
  const editorPane = enginePaneEl;

  const btnEditorMode = iconButton(ICONS.edit, 'エディタモードへ切替');
  toolbar.insertBefore(btnEditorMode, btnFullscreen);

  // 課題B: 「Clear MML」(英語のまま・エディタ欄の下に浮いたボタン)を廃止し、
  // ツールバーの「曲を開く」「ダウンロード」と同じ並びのアイコンボタンへ移す。
  const btnNewMml = iconButton(ICONS.newFile, '新規作成');
  toolbar.insertBefore(btnNewMml, btnDownload);

  function applyUiMode(mode) {
    editorPane.classList.toggle('hidden', mode !== 'editor');
    btnEditorMode.classList.toggle('active', mode === 'editor');
    btnEditorMode.title = mode === 'editor' ? 'プレイヤーモードへ切替' : 'エディタモードへ切替';
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
  if (draft && draft.text.length > 0) {
    mmlTextarea.value = draft.text;
    mmlEditorApi.render();
    const savedLabel = formatSavedAt(draft.savedAt);
    mmlRestoreNoteEl.textContent = savedLabel
      ? `前回の続きを復元しました(${savedLabel}保存)`
      : '前回の続きを復元しました';
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
      resultEl.title = `クリックでMML ${line}行目へ移動`;
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
    const message = 'MMLが空です。何か入力してから再生してください。';
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
  moduleReady = true;
  updateTransportButtonUI();

  let pausedFrameDrawn = false;
  let stoppedFrameDrawn = false;
  // 課題B: 「曲が終わったこと」の検出を1箇所にまとめる(updateChannelStatus()内)。
  //
  // 実測で判明した制約: MUCOM88(このport)には PMD の fmdriver_work.playing に相当する
  // 単一の「再生中/終了」フラグが無い。GetStatus(MUCOM_STATUS_PLAYING)はcmucom.cppの
  // playflag(Play()でtrue、Stop()を呼んだ時だけfalse)をそのまま返すだけで、
  // ループしない曲が末尾に到達しても自動ではfalseにならない(実測:非ループ曲を
  // 400tick以上再生してもGetStatus(PLAYING)は常に1のまま。intCountも上限なく
  // 増え続ける)。よってこのAPIは終了検出に使えない。
  //
  // 代わりに docs/mucom-pchdata-mapping.md §3 で確認済みの PCHDATA.flag bit0
  // (LOOPEND FLAG)を使う。ただしbit0単体は「ループ点(またはパート末尾)に
  // 到達したか」を示すだけで、Lコマンドで曲がループする場合も*最初の1周目*で
  // 同じように1が立ち、その後も1のまま推移する(実測: tools/verify_mucom_song_end.mjs
  // 参照。Lありの曲でbit0がstep19で1になった後もcodeが変化し続け、ループが
  // 継続していることを確認した)。bit0だけを終了判定に使うと、ループする曲の
  // 最初の1周目で誤発火してしまう。
  //
  // そこで「flag bit0が立っている」*かつ*「そのパートのcode(音程コード)が
  // 一定ポーリング回数(STABLE_POLLS)変化していない」の両方が揃ったときだけ
  // 「そのパートは終了した」とみなす(ループする曲はbit0が立った後もcodeが
  // 変化し続けるため、この条件を満たさない)。実際に曲で使われた(過去に
  // code!==0になったことがある)パート全てがこの条件を満たしたとき、
  // 曲全体が終了したと判定する。
  const MUCOM_END_STABLE_POLLS = 3; // 「フレーム基準の隙間はポーリング2回ぶん」より1回分余裕を持たせる
  const mucomEndState = {
    usedParts: new Set(),
    lastCode: new Array(MUCOM_CH_COUNT).fill(null),
    stableCount: new Array(MUCOM_CH_COUNT).fill(0),
  };
  function resetMucomEndState() {
    mucomEndState.usedParts.clear();
    mucomEndState.lastCode.fill(null);
    mucomEndState.stableCount.fill(0);
  }
  // 曲全体が終了したかどうかを1回分のスナップショットから判定し、内部状態を更新する。
  function checkMucomSongEnded(latest) {
    let anyUsed = false;
    let allEnded = true;
    for (let ch = 0; ch < MUCOM_CH_COUNT; ch++) {
      const base = snapshotHeaderWordCount + ch * PCH_FIELD_COUNT;
      const code = latest[base + 7] & 0xff;   // PCH.CODE
      const flag = latest[base + 8] & 0xff;   // PCH.FLAG
      if (code !== 0) mucomEndState.usedParts.add(ch);
      if (!mucomEndState.usedParts.has(ch)) continue;
      anyUsed = true;
      if (code === mucomEndState.lastCode[ch]) {
        mucomEndState.stableCount[ch]++;
      } else {
        mucomEndState.stableCount[ch] = 0;
      }
      mucomEndState.lastCode[ch] = code;
      const loopEnd = (flag & 1) !== 0;
      const partEnded = loopEnd && mucomEndState.stableCount[ch] >= MUCOM_END_STABLE_POLLS;
      if (!partEnded) allEnded = false;
    }
    return anyUsed && allEnded;
  }

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
    const baseLabel = mmlDirty
      ? '未コンパイルの変更があります(クリックでコンパイル&再生)'
      : (playing ? '一時停止' : (paused ? '再開' : 'コンパイル&再生'));
    const label = `${baseLabel} (${SHORTCUT_PLAY_HINT})`;
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
    resetMucomEndState();
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

  const palette = PALETTES[0];

  rightpane.drawStaticDecorations(vram, FMSOUND_VERSION_FIELDS);
  const staticVramSnapshot = vram.pixels.slice();

  const fftPeakState = rightpane.createPeakState(rightpane.FFTDISPLEN);
  const levelPeakState = rightpane.createPeakState(rightpane.FMDSP_LEVEL_COUNT);
  let rightPaneFrameCounter = 0;

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
  function asciiOnlyCp932Bytes(text) {
    if (!text) return null;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 0x20 || code > 0x7e) return null;
    }
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
  }

  const HEADER_KEYWORDS = ['title', 'composer', 'comment'];
  function isAsciiSpaceByte(c) {
    return c === 0x20 || c === 0x09;
  }
  function matchesAsciiKeywordBytes(bytes, i, end, keyword) {
    if (i + keyword.length > end) return false;
    for (let k = 0; k < keyword.length; k++) {
      let c = bytes[i + k];
      if (c >= 0x41 && c <= 0x5a) c += 0x20;
      if (c !== keyword.charCodeAt(k)) return false;
    }
    return true;
  }
  function parseHeaderLineBytes(bytes, start, end, header) {
    let i = start;
    while (i < end && isAsciiSpaceByte(bytes[i])) i++;
    if (i >= end || bytes[i] !== 0x23 /* '#' */) return;
    i++;
    while (i < end && isAsciiSpaceByte(bytes[i])) i++;
    for (const keyword of HEADER_KEYWORDS) {
      if (!matchesAsciiKeywordBytes(bytes, i, end, keyword)) continue;
      const afterKeyword = i + keyword.length;
      if (afterKeyword < end && !isAsciiSpaceByte(bytes[afterKeyword])) continue;
      let valueStart = afterKeyword;
      while (valueStart < end && isAsciiSpaceByte(bytes[valueStart])) valueStart++;
      let valueEnd = end;
      while (valueEnd > valueStart && isAsciiSpaceByte(bytes[valueEnd - 1])) valueEnd--;
      if (header[keyword] === null) header[keyword] = bytes.slice(valueStart, valueEnd);
      return;
    }
  }
  function extractMmlHeaderBytes(bytes) {
    const header = { title: null, composer: null, comment: null };
    let lineStart = 0;
    for (let i = 0; i <= bytes.length; i++) {
      if (i === bytes.length || bytes[i] === 0x0a) {
        let lineEnd = i;
        if (lineEnd > lineStart && bytes[lineEnd - 1] === 0x0d) lineEnd--;
        parseHeaderLineBytes(bytes, lineStart, lineEnd, header);
        lineStart = i + 1;
      }
    }
    return header;
  }

  let lastLoadedRawBytes = null;
  let lastLoadedText = null;
  // 課題(net配線): 直近に読み込んだMMLの文字コード判定結果('utf-8'|'shift_jis'|null)。
  // 手動切替ボタン(encodingBadgeEl)の表示・再デコードに使う。
  let lastLoadedEncoding = null;

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

  function setNetStatus(message, isError) {
    netStatusEl.textContent = message;
    netStatusEl.classList.toggle('net-status-error', Boolean(isError));
    netStatusEl.classList.toggle('hidden', !message);
  }

  function updateEncodingBadge() {
    if (!lastLoadedRawBytes) {
      encodingBadgeEl.classList.add('hidden');
      return;
    }
    encodingBadgeEl.classList.remove('hidden');
    const label = lastLoadedEncoding === 'utf-8' ? 'UTF-8' : 'CP932(Shift_JIS)';
    encodingBadgeEl.textContent = `文字コード判定: ${label}(自動判定。クリックで切り替え)`;
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
    if (lastLoadedRawBytes && mmlText === lastLoadedText) {
      const header = extractMmlHeaderBytes(lastLoadedRawBytes);
      commentBytesCache = [header.title, header.composer, header.comment];
      return;
    }
    const header = extractMmlHeader(mmlText);
    commentBytesCache = [
      asciiOnlyCp932Bytes(header.title),
      asciiOnlyCp932Bytes(header.composer),
      asciiOnlyCp932Bytes(header.comment),
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
      drawTrackRows(vram, fmdspFont, entryTracks);
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
        if (!stoppedFrameDrawn) {
          stoppedFrameDrawn = true;
          if (fmdspFont) {
            rightPaneFrameCounter = (rightPaneFrameCounter + 1) & 0xffffffff;
            rightpane.drawCircle(vram, { playing: false, paused: false, timerbCnt: 0, frameCnt: rightPaneFrameCounter });
            rightpane.drawTransportIcons(vram, { playing: false, stopped: true, paused: false });
            canvasCtx.putImageData(vram.toImageData(palette), 0, 0);
          }
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

        // 課題B: 曲が終わったこと(頭出し停止)の検出。latest(遅延の無い最新値)で
        // 判定する。実際に再生中(hasPlayback&&!paused)のときだけ発火させる。
        {
          const ended = checkMucomSongEnded(latest);
          const activelyPlaying = Boolean(playback) && !Boolean(audioState?.paused);
          if (ended && activelyPlaying) {
            stopPlayback();
          }
        }

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
    resetMucomEndState();
    setCommentFromMml(mml);
    const audioStateBefore = globalThis.mucomAudioState;
    const generationBefore = audioStateBefore ? audioStateBefore.generation : null;
    Module.compileMML(mml, selectedRate());
    const msgPtr = Module.getCompileMessagePointer();
    const msgLen = Module.getCompileMessageLength();
    const msgBytes = Module.HEAPU8.subarray(msgPtr, msgPtr + msgLen);
    renderCompileResult(cp932MessageDecoder.decode(msgBytes));
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
      const ok = window.confirm(
        '編集中のMMLを消して新規作成します。この操作の直後であればCmd/Ctrl+Zで元に戻せます。よろしいですか?'
      );
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
    lastLoadedText = null;
    // 課題A: 編集内容を消した(新規作成した)ときも前回のエラー表示を残さない。
    clearCompileStatus();
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
    lastLoadedText = text;
    lastLoadedEncoding = encoding;
    mmlTextarea.value = text;
    mmlEditorApi.render();
    updateEncodingBadge();
  }

  function downloadMML(url) {
    // 課題A: 復元した下書き/編集中の内容をサンプルで黙って上書きしない。
    // 何か入っている状態でのクリックだけ確認する(空なら聞くまでもない)。
    if (mmlTextarea.value.trim().length > 0) {
      const ok = window.confirm(
        '編集中のMMLをサンプルで置き換えます。元の内容はこの操作の直後であればCmd/Ctrl+Zで戻せます。よろしいですか?'
      );
      if (!ok) return Promise.resolve();
    }
    return fetch(url)
      .then(response => response.arrayBuffer())
      .then(buffer => {
        applyMmlBytes(buffer);
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
  function openMmlFile(file) {
    if (!file) return;
    file.arrayBuffer().then((buffer) => {
      applyMmlBytes(buffer);
      compileAndPlay();
    });
  }

  btnOpenFile.addEventListener('click', () => {
    fileInput.value = '';
    fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    openMmlFile(fileInput.files && fileInput.files[0]);
  });

  for (const evt of ['dragenter', 'dragover']) {
    consoleCard.addEventListener(evt, (e) => {
      e.preventDefault();
      consoleCard.classList.add('dropzone-active');
    });
  }
  for (const evt of ['dragleave', 'dragend']) {
    consoleCard.addEventListener(evt, () => {
      consoleCard.classList.remove('dropzone-active');
    });
  }
  consoleCard.addEventListener('drop', (e) => {
    e.preventDefault();
    consoleCard.classList.remove('dropzone-active');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    openMmlFile(file);
  });

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

  // --- URL指定での曲読み込み(?mml=<URL>)。net/(取得・書庫展開)を実際にUIへ配線する
  // 箇所(2026-08-15)。読み込むだけで自動再生はしない: AudioContextはユーザー操作を
  // 要求するため、ここで鳴らそうとしても実際には鳴らないのに「リングは進んでいるが
  // 無音」という紛らわしい状態になる。applyMmlBytes()はcompileAndPlay()を呼ばないので、
  // 読み込み後にmmlDirty/hasCompiledの状態から自然に「未コンパイル」扱いになり、
  // 利用者が再生ボタンを押すとneedsCompileNow()経由でコンパイル&再生される。
  async function loadSongFromUrlParam(url) {
    setNetStatus(`読み込み中: ${url}`, false);
    let resolved;
    try {
      resolved = await resolveSongFromUrl(url, (loaded, total) => {
        setNetStatus(total ? `読み込み中: ${loaded}/${total} bytes` : `読み込み中: ${loaded} bytes`, false);
      });
    } catch (err) {
      setNetStatus(err && err.message ? err.message : `取得に失敗しました(${url})`, true);
      return;
    }

    if (resolved.kind === 'archive') {
      const mucomCandidates = resolved.candidates.filter((c) => c.driver === 'mucom');
      if (mucomCandidates.length === 0) {
        const otherCount = resolved.candidates.length;
        setNetStatus(
          otherCount > 0
            ? `この書庫にMUCOM88(.muc)の曲は見つかりませんでした(他ドライバの曲が${otherCount}件見つかりました。?driver=pmd で開き直してください)`
            : 'この書庫の中に再生可能な曲が見つかりませんでした',
          true,
        );
        return;
      }
      let chosen = mucomCandidates[0];
      if (mucomCandidates.length > 1) {
        chosen = await pickSongCandidate(mucomCandidates);
        if (!chosen) {
          setNetStatus('曲の選択をキャンセルしました', false);
          return;
        }
      }
      applyMmlBytes(chosen.entry.data);
      setNetStatus(`読み込みました: ${chosen.displayName}(再生ボタンを押してください)`, false);
      return;
    }

    applyMmlBytes(resolved.bytes);
    setNetStatus(`読み込みました: ${resolved.name}(再生ボタンを押してください)`, false);
  }

  if (ctx.songUrl) {
    loadSongFromUrlParam(ctx.songUrl);
  }
}
