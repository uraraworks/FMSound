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
import { setMmlStatus } from './ui/mml-status.js';
import { setupTransportShortcuts, SHORTCUT_PLAY_HINT } from './ui/shortcuts.js';
import { createDownloadMenu } from './ui/download-menu.js';
import { setupPopover } from './ui/shell.js';

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
    <div class="editor-actions">
      <button id="btnClearMML" type="button">Clear MML</button>
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
  sampleLinksEl.innerHTML = `
    Sample MML:
    <a href="javascript:void(0);" id="dlSampl1">sampl1.muc</a>
    <a href="javascript:void(0);" id="dlSampl2">sampl2.muc</a>
    <a href="javascript:void(0);" id="dlSampl3">sampl3.muc</a>
    <a href="javascript:void(0);" id="dlSamplJa">samplja.muc</a>
    <span style="opacity:.7">(Copyright(C) by Yuzo Koshiro)</span>
  `;

  // --- モード(player/editor)。localStorageに保存し、次回も同じモードで開く ---
  const UI_MODE_KEY = 'fmsound-mucom-ui-mode';
  const editorPane = enginePaneEl;

  const btnEditorMode = iconButton(ICONS.edit, 'エディタモードへ切替');
  toolbar.insertBefore(btnEditorMode, btnFullscreen);

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
    // MUCOMの出力は"line N"を含まないメッセージ(#Device error等)もあるため、
    // その場合はline番号なしでメッセージ全文(先頭行)だけを状態表示に出す。
    const firstLine = text.split(/\r\n|\r|\n/, 1)[0] ?? text;
    setMmlStatus(mmlStatusEl, isError
      ? { ok: false, line, message: firstLine, onJump: (l) => mmlEditorApi.jumpToLine(l) }
      : { ok: true });
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

  function updateTransportButtonUI() {
    const audioState = globalThis.mucomAudioState;
    const hasPlayback = Boolean(audioState?.playback);
    const paused = Boolean(audioState?.paused);
    const playing = hasPlayback && !paused;

    btnPlayPause.disabled = !moduleReady;
    btnStop.disabled = !moduleReady || !hasPlayback;

    const icon = !mmlDirty && playing ? ICONS.pause : ICONS.play;
    // ドットの意味を利用者に伝える(PMD側と同じ対応。見た目は変えずtitle/aria-labelだけ)。
    const label = mmlDirty
      ? '未コンパイルの変更があります(クリックでコンパイル&再生)'
      : (playing ? '一時停止' : (paused ? '再開' : 'コンパイル&再生'));
    btnPlayPause.replaceChildren(svgIcon(icon.path ?? icon, icon.extra ?? ''));
    btnPlayPause.title = label;
    btnPlayPause.setAttribute('aria-label', label);
    btnPlayPause.classList.toggle('active', !mmlDirty && paused);
    btnPlayPause.classList.toggle('dirty', mmlDirty);
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
    if (!hasCompiled || mmlDirty) {
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

  function compileAndPlay() {
    if (!moduleReady) return;
    const mml = document.getElementById('mml').value;
    adapter.reset();
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
    }
    setAudioPaused(false);
  }

  btnStop.addEventListener('click', function() {
    stopPlayback();
  });

  document.getElementById('btnClearMML').addEventListener('click', function() {
    const ta = document.getElementById('mml');
    if (ta.value.length > 0) {
      const ok = window.confirm(
        '編集中のMMLを消去します。この操作の直後であればCmd/Ctrl+Zで元に戻せます。よろしいですか?'
      );
      if (!ok) return;
    }
    ta.focus();
    ta.select();
    const undoable = typeof document.execCommand === 'function' &&
      document.execCommand('insertText', false, '');
    if (!undoable) {
      ta.value = '';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    lastLoadedRawBytes = null;
    lastLoadedText = null;
  });

  const sjisDecoder = new TextDecoder('shift_jis');

  function applyMmlBytes(buffer) {
    const rawBytes = new Uint8Array(buffer);
    const text = sjisDecoder.decode(buffer);
    lastLoadedRawBytes = rawBytes;
    lastLoadedText = text;
    mmlTextarea.value = text;
    mmlEditorApi.render();
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

  document.getElementById('dlSampl1').addEventListener('click', function() {
    downloadMML('./sampl1.muc');
  });

  document.getElementById('dlSampl2').addEventListener('click', function() {
    downloadMML('https://raw.githubusercontent.com/onitama/mucom88/master/package/sampl2.muc');
  });

  document.getElementById('dlSampl3').addEventListener('click', function() {
    downloadMML('https://raw.githubusercontent.com/onitama/mucom88/master/package/sampl3.muc');
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
}
