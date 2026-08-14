// PMDエンジン固有のアプリロジック。app.js(共通シェル)から動的importされ、
// init(ctx) が呼ばれる。
//
// 旧 pmdweb/html/index.html(素のプレイヤー、独自のtable/controlsマークアップ)を
// mucomweb/html/index.html(完成済みUI)と同じ構成
// (.console-card+.console-footer/再生一時停止トグル/停止/曲を開く/設定/フルスクリーン/
// ?debug=1限定のデバッグ表示)へ展開したもの。
//
// エディタモード(MMLを書いて・鳴らして・直す)は html/mucom-app.js と同じ作り
// (行番号ガター+構文色つけ+透明textarea/背面pre重ね合わせ+dirty追跡)を踏襲する。
// MUCOM88との違いは「コンパイラがwasm側(Module.compileMML)ではなくJS側」という点だけ:
// PMDの`.M`コンパイラは compiler/pmd_mml_compiler.mjs(旧tools/、ブラウザ実行できるよう
// 移設した。詳細はcompiler/内のコメントとREADME参照)にあり、ここでMMLテキストから
// `.M`バイト列を作ってから Module.FS.writeFile()+Module.playMusic() でwasm側へ渡す。
// エラーは{line, message}の構造化配列で返ってくる(compiler/pmd_mml_parser.mjs)ので、
// MUCOM側のようなテキスト正規表現での行番号抽出は不要。
//
// 「曲を開く」(.m/.M バイナリファイルを開く/ドラッグ&ドロップ)は元々コンパイラを
// 経由しない機能なので、エディタモードの有無に関わらず従来通りバイナリを直接
// Module.FS.writeFile()+Module.playMusic()する(このパスは変更していない)。
//
// 一時停止はMUCOM側と同じ方式: wasm側にpause APIが無いため、
// AudioContext.suspend()/resume() だけで音声レンダリングを止める/再開する
// (曲の再生位置・スナップショットリングは一切捨てない)。globalThis.pmdAudioState
// (pmdweb/src/PmdCore.c の workletReady 実装が作る)は mucomAudioState と
// 同じ形(context/playback/stats/generation)を持つため、この手法がそのまま使える。

import createPmdWeb from './pmdweb.js';
import { Vram, PC98_W, PC98_H } from './fmdsp/vram.js';
import { FmdspFont, SmallFont } from './fmdsp/font.js';
import { drawTrackRows } from './fmdsp/trackrow.js';
import { PALETTES } from './fmdsp/palette.js';
import { FONT_SMALL } from './fmdsp/font_small.js';
import { drawComment, commentScroll } from './fmdsp/comment.js';
import * as rightpane from './fmdsp/rightpane.js';
import { ICONS, iconButton, svgIcon } from './ui/icons.js';
import { setupMmlEditor } from './mml-editor.js';
import { PMD_TOKEN_RULES, PMD_MACRO_HEADER_RE, PMD_PART_LETTER_RE } from './mml-tokens.js';
import { compileMml } from './compiler/pmd_mml_compiler.mjs';
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
    '<a href="https://github.com/myon98/98fmplayer" target="_blank" rel="noopener">98fmplayer</a> ' +
    '<a href="https://github.com/myon98/98fmplayer/blob/master/LICENSE" target="_blank" rel="noopener">(BSD 2-Clause)</a>';

  fileInput.accept = '.m,.M';

  // --- 曲を開く導線。東方Projectアレンジ曲(PC-98_Hartmann_s_Youkai_GIrl.M、
  // 権利不明のため同梱をやめた)の代わりに自作サンプル(エリーゼのために冒頭、
  // ベートーヴェンWoO 59はパブリックドメイン。MMLアレンジは本プロジェクトの著作物。
  // 詳細はNOTICE.md参照)を同梱する。プレイヤーモードではコンパイル済みの.Mを直接
  // 再生し、エディタモードではMMLソース(sample_fur_elise.mml、
  // tools/gen_sample_fur_elise.mjsが同じソースから.Mと.mmlの両方を生成しているので
  // 内容は常に一致する)をエディタへ読み込んでからコンパイル&再生する。
  sampleLinksEl.innerHTML =
    '<a href="javascript:void(0);" id="dlSampleFurElise">sample_fur_elise.M(エリーゼのために・冒頭)</a>' +
    '　「曲を開く」から手元の.M/.mファイルを選ぶこともできます。';
  document.getElementById('dlSampleFurElise').addEventListener('click', async () => {
    if (uiMode === 'editor') {
      // 課題A: 復元した下書き/編集中の内容をサンプルで黙って上書きしない。
      // 何か入っている状態でのクリックだけ確認する(空なら聞くまでもない)。
      if (mmlTextarea.value.trim().length > 0) {
        const ok = window.confirm(
          '編集中のMMLをサンプルで置き換えます。元の内容はこの操作の直後であればCmd/Ctrl+Zで戻せます。よろしいですか?'
        );
        if (!ok) return;
      }
      const response = await fetch('./sample_fur_elise.mml');
      const text = await response.text();
      mmlTextarea.value = text;
      mmlEditorApi.render();
      mmlDirty = false;
      compileAndPlay();
      return;
    }
    const response = await fetch('./sample_fur_elise.M');
    const buffer = await response.arrayBuffer();
    await playBytes(new Uint8Array(buffer), 'sample_fur_elise.M');
  });

  // --- エンジン固有領域: コメント欄操作(常時表示) + MMLエディタ(モード切替で表示)。
  enginePaneEl.classList.remove('hidden');
  enginePaneEl.innerHTML = `
    <div class="editor-pane hidden" id="mmlEditorPane">
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
    </div>
    <details class="debug-table debug-only" id="debugTable">
      <summary>デバッグ用テーブル(生のトラック状態、切り分け用に残す)</summary>
      <table id="channelStatus">
        <thead>
          <tr><th>track</th><th>play</th><th>tone</th><th>vol</th><th>ticks</th><th>left</th><th>key</th><th>actual</th><th>gate</th><th>status</th></tr>
        </thead>
        <tbody></tbody>
      </table>
    </details>
    <div id="snapshotDebug" class="debug-only">snapshot ring: inactive</div>
    <div id="audioDebug" class="debug-only">AudioWorklet: inactive</div>
  `;

  // --- モード(player/editor)。localStorageに保存し、次回も同じモードで開く(MUCOM88と同じ作法) ---
  const UI_MODE_KEY = 'fmsound-pmd-ui-mode';
  const mmlEditorPane = document.getElementById('mmlEditorPane');

  const btnEditorMode = iconButton(ICONS.edit, 'エディタモードへ切替');
  toolbar.insertBefore(btnEditorMode, btnFullscreen);

  let uiMode = 'player';

  function applyUiMode(mode) {
    uiMode = mode;
    mmlEditorPane.classList.toggle('hidden', mode !== 'editor');
    btnEditorMode.classList.toggle('active', mode === 'editor');
    btnEditorMode.title = mode === 'editor' ? 'プレイヤーモードへ切替' : 'エディタモードへ切替';
    btnEditorMode.setAttribute('aria-label', btnEditorMode.title);
    rescale();
    updateTransportButtonUI();
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

  btnEditorMode.addEventListener('click', () => {
    setUiMode(uiMode === 'editor' ? 'player' : 'editor');
  });

  // --- MMLエディタ(行番号ガター+構文色つけ+現在行ハイライト)。トークン定義だけ
  // PMD用(mml-tokens.js PMD_TOKEN_RULES)に差し替える。mml-editor.js自体はエンジンに
  // 依存しない共通実装(MUCOM88と共用)。
  const mmlTextarea = document.getElementById('mml');
  const mmlEditorApi = setupMmlEditor({
    textarea: mmlTextarea,
    gutterInner: document.getElementById('mmlGutterInner'),
    highlightCode: document.getElementById('mmlHighlightCode'),
    highlightPre: document.getElementById('mmlHighlight'),
    currentLineEl: document.getElementById('mmlCurrentLine'),
    rules: {
      tokenRules: PMD_TOKEN_RULES,
      macroHeaderRe: PMD_MACRO_HEADER_RE,
      partLetterRe: PMD_PART_LETTER_RE,
    },
  });

  // --- 課題A: 編集内容の自動保存/復元。ドライバごとに別キー(PMDとMUCOM88はMML文法が
  // 違うため混在させない)。復元とサンプル読み込みの優先順位: サンプルはユーザーの
  // 明示クリックでのみ読み込まれ、かつテキストに何か入っている状態でクリックした
  // ときは確認を挟む(下のdlSampleFurElise参照)ので、復元した下書きが黙って
  // 上書きされることはない。
  const MML_DRAFT_KEY = 'fmsound-pmd-mml-draft';
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
  // 保存頻度: 打鍵のたびに同期書き込みすると長いMMLで主スレッドを塞ぐため、
  // 最後の入力から少し経ってから1回だけ書く(間引く)。タブを閉じる/裏に回す
  // 直前だけは間引かず即書く(ui/mml-draft.js参照)。
  setupMmlAutosave({ storageKey: MML_DRAFT_KEY, textarea: mmlTextarea });

  let mmlDirty = false;
  // 「一度でも今のMML内容をコンパイル成功させたか」。UI(青いドット/ボタンラベル)の
  // 「コンパイル&再生」が必要かどうかの判定に使う。
  //
  // 実測で判明した不具合(利用者報告「再生ボタン右上に青い●が出たままになる」の根):
  // 以前はこの判定に globalThis.pmdAudioState?.playback (hasPlayback、AudioWorkletの
  // 'playback' postMessageで非同期に立つ) を使っていた。しかしコンパイル成功→
  // Module.playMusic()が返った直後の時点では、AudioWorkletの初回メッセージがまだ
  // 届いておらず hasPlayback は依然falseのまま。そのためcompileAndPlay()内で
  // updateTransportButtonUI()を呼んでも「まだコンパイルが必要」と誤判定され、
  // 次のrAF(updateChannelStatus、無条件に毎フレームupdateTransportButtonUI()を呼ぶ)が
  // 回ってhasPlaybackが追いつくまでの間、青いドットが消えないまま残る
  // (rAFが遅延・停止する環境やタブがバックグラウンドの場合は体感できるほど残る)。
  // 「コンパイルの成否」と「実際に音が出始めたか」は別の事象なので、前者だけを見る
  // 専用フラグに切り替えて解消する(hasPlaybackはbtnStopの活性判定にだけ残す)。
  let hasCompiled = false;
  function markMmlDirty() {
    if (mmlDirty) return;
    mmlDirty = true;
    updateTransportButtonUI();
  }
  mmlTextarea.addEventListener('input', markMmlDirty);

  const resultEl = document.getElementById('result');
  // MUCOM側(mml-editor.js extractErrorLine())と違い、PMDコンパイラのエラーは
  // 最初から{line, message}の構造化配列で返ってくる(compiler/pmd_mml_parser.mjs)ため、
  // テキストから行番号を正規表現で抜き出す必要が無い。複数エラーをそれぞれ
  // クリック可能な行として並べる。
  function renderCompileErrors(errors) {
    resultEl.replaceChildren();
    if (errors.length === 0) {
      resultEl.textContent = 'コンパイル成功';
      return;
    }
    for (const e of errors) {
      const div = document.createElement('div');
      div.textContent = e.line != null ? `line ${e.line}: ${e.message}` : e.message;
      // 課題D: エラーはすべて赤系(--danger)にする(行番号が無い「再生エラー: ...」も
      // 含む。以前は line != null のときだけ .mml-error-line を付けていたため
      // 再生エラーだけ色が付かない抜けがあった)。正常時の「コンパイル成功」は
      // このループを通らない(上のearly returnで別処理)ので赤くならない。
      div.classList.add('mml-compile-error-text');
      if (e.line != null) {
        div.classList.add('mml-error-line');
        div.title = `クリックでMML ${e.line}行目へ移動`;
        div.addEventListener('click', () => mmlEditorApi.jumpToLine(e.line));
      }
      resultEl.appendChild(div);
    }
  }

  document.getElementById('btnClearMML').addEventListener('click', function() {
    const ta = mmlTextarea;
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
  });

  rescale();
  requestAnimationFrame(rescale);

  // moduleReadyはupdateTransportButtonUI()(applyUiMode()経由で即座に呼ばれる)が
  // 参照するため、letのTemporal Dead Zoneを踏まないよう先に宣言しておく
  // (実測で「Cannot access 'moduleReady' before initialization」を確認して気づいた)。
  let moduleReady = false;

  applyUiMode(currentUiMode());

  const Module = await createPmdWeb();
  moduleReady = true;

  const vram = new Vram(PC98_W, PC98_H);
  const canvasCtx = canvas.getContext('2d');
  const palette = PALETTES[0];

  // バージョン文字列: FMPLAYER_VERSION_0/1/2相当の値はwasm側に対応exportが無く、
  // でっち上げないため固定のプレースホルダ('-','-','-')にする(旧pmdweb/html/index.html
  // と同じ方針)。
  rightpane.drawStaticDecorations(vram, ['-', '-', '-']);
  const staticVramSnapshot = vram.pixels.slice();

  const fftPeakState = rightpane.createPeakState(rightpane.FFTDISPLEN);
  const levelPeakState = rightpane.createPeakState(rightpane.FMDSP_LEVEL_COUNT);
  let rightPaneFrameCounter = 0;

  let fmdspFont = null;
  FmdspFont.load('./fmdsp/shinonome.rom').then((font) => { fmdspFont = font; })
    .catch((error) => console.error('failed to load shinonome.rom:', error));
  const commentSmallFont = new SmallFont(FONT_SMALL);

  let commentOffset = 0;
  function commentBytesFor(line) {
    const length = Module.getCommentLength(line);
    if (!length) return null;
    const pointer = Module.getCommentPointer();
    return Module.HEAPU8.slice(pointer, pointer + length);
  }
  // 課題B: 以前は編集エリアとサンプルリンクの間に置いていた「↑コメント」「↓コメント」
  // ボタンを廃止し、キャンバス内の三角マーク(fmdsp/comment.js drawTri()、
  // upstream/98fmplayer/fmdsp/fmdsp-pacc.c draw_tri()の移植)をクリックしたら
  // スクロールする形にする(機能自体はFMDSPの正当な要素なので削除しない。
  // 置き場所だけを本家の見た目・操作に近づける)。
  //
  // draw()内で毎フレーム drawComment() に onTri を渡し、実際に三角が描かれた
  // (row, x, y)を lastTriangles に記録しておく。「三角が無いときは反応しない」を
  // 満たすため、当たり判定はこの「実際に描かれた三角」の集合に対してのみ行う
  // (commentModePmdでない=MUCOM側や、内容が無い行は三角自体が描かれないので
  // 自然に無反応になる)。
  let lastTriangles = [];
  // 三角そのものは3x3px(640x400内部座標)しかなく実用上クリックできないため、
  // 周囲に余白を持たせて当たり判定にする。行の高さ(COMMENT_H=19px)より小さくして
  // 隣の行と重ならないようにする。
  const TRI_HIT_PAD_X = 20;
  const TRI_HIT_PAD_Y = 8;
  canvas.addEventListener('click', (event) => {
    if (lastTriangles.length === 0) return; // 三角が1つも描かれていない=反応しない
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    // 表示上のクリック座標(CSS px、rescale()でcanvas.style.width/heightが可変)を
    // キャンバスの内部解像度(640x400、PC98_W/PC98_H)へ変換する。ここを素通しすると
    // 縮小・拡大時にクリック位置がずれて三角に当たらなくなる(実測で確認)。
    const x = (event.clientX - rect.left) * (PC98_W / rect.width);
    const y = (event.clientY - rect.top) * (PC98_H / rect.height);
    for (const tri of lastTriangles) {
      // 中段(row===1、COMPOSER/ARRANGERの2本)は↑/↓のどちらとも決め難いため無反応にする。
      if (tri.row === 1) continue;
      if (Math.abs(x - tri.x) > TRI_HIT_PAD_X || Math.abs(y - tri.y) > TRI_HIT_PAD_Y) continue;
      const modePmd = Module.getCommentModePmd() !== 0;
      const down = tri.row === 2; // 上段(row0)=↑(前へ)、下段(row2)=↓(次へ)
      commentOffset = commentScroll(commentOffset, down, modePmd, commentBytesFor);
      return;
    }
  });

  const ringSize = 2048;
  const invalidIndex = 0xffffffff;
  const trackCount = Module.getTrackCount();
  const fieldCount = Module.getFieldCount();
  // frameに続くヘッダ(timerb_cnt/timerb/loop_cnt/timerb_cnt_loop/loop_timerb_cnt)。
  // mucomweb/html/mucom-app.js の SNAPSHOT_HEADER と同じ作法(PmdCore.c参照)。
  const snapshotHeaderWordCount = Module.getSnapshotHeaderWordCount();
  const SNAPSHOT_HEADER = {
    FRAME: 0,
    TIMERB_CNT: 1,
    TIMERB: 2,
    LOOP_CNT: 3,
    TIMERB_CNT_LOOP: 4,
    LOOP_TIMERB_CNT: 5,
  };
  const tbody = document.querySelector('#channelStatus tbody');
  const calibrationInput = document.getElementById('calibrationMs');
  const synchronizedCheckbox = document.getElementById('useSynchronizedStatus');
  for (let track = 0; track < trackCount; ++track) {
    const row = tbody.insertRow();
    row.insertCell().textContent = track;
    for (let column = 0; column < 9; ++column) row.insertCell().textContent = '0';
  }

  function entryAt(pointerWords, entryWords, logicalIndex) {
    const start = pointerWords + (logicalIndex & (ringSize - 1)) * entryWords;
    return Module.HEAP32.subarray(start, start + entryWords);
  }

  function findSnapshot(pointerWords, entryWords, writeIndex, targetFrame) {
    const available = Math.min(writeIndex, ringSize);
    const oldest = writeIndex - available;
    const newest = writeIndex - 1;
    const first = entryAt(pointerWords, entryWords, oldest);
    const last = entryAt(pointerWords, entryWords, newest);
    if (targetFrame <= (first[0] >>> 0)) return first;
    if (targetFrame >= (last[0] >>> 0)) return last;
    let low = oldest;
    let high = newest;
    while (low <= high) {
      const middle = low + Math.floor((high - low) / 2);
      const entry = entryAt(pointerWords, entryWords, middle);
      if ((entry[0] >>> 0) <= targetFrame) low = middle + 1;
      else high = middle - 1;
    }
    return entryAt(pointerWords, entryWords, high);
  }

  function readRightPaneData(entry) {
    const entryBase = entry.byteOffset;
    const fftBase = entryBase + Module.getSnapshotFftOffset();
    const fftCount = Module.getFftBinCount();
    const fft = Module.HEAPU8.subarray(fftBase, fftBase + fftCount);

    const levelCount = Module.getLevelCount();
    const levelFieldCount = Module.getLevelFieldCount();
    const levelBase = (entryBase + Module.getSnapshotLevelOffset()) / 4;
    const levels = [];
    for (let c = 0; c < levelCount; ++c) {
      const o = levelBase + c * levelFieldCount;
      levels.push({
        level: Module.HEAP32[o + 0],
        pan: Module.HEAP32[o + 1],
        prog: Module.HEAP32[o + 2],
        key: Module.HEAP32[o + 3],
        playing: Module.HEAP32[o + 4] !== 0,
      });
    }
    return { fft, levels };
  }

  function draw(entry) {
    const timerbCnt = entry[SNAPSHOT_HEADER.TIMERB_CNT] >>> 0;
    const timerb = entry[SNAPSHOT_HEADER.TIMERB] >>> 0;
    const loopCnt = entry[SNAPSHOT_HEADER.LOOP_CNT] >>> 0;
    const timerbCntLoop = entry[SNAPSHOT_HEADER.TIMERB_CNT_LOOP] >>> 0;
    const loopTimerbCnt = entry[SNAPSHOT_HEADER.LOOP_TIMERB_CNT] >>> 0;
    const entryTracks = [];
    for (let track = 0; track < trackCount; ++track) {
      const data = entry.subarray(
        snapshotHeaderWordCount + track * fieldCount,
        snapshotHeaderWordCount + (track + 1) * fieldCount);
      entryTracks.push(data);
      const cells = tbody.rows[track].cells;
      cells[1].textContent = data[0];
      cells[2].textContent = data[6];
      cells[3].textContent = data[7];
      cells[4].textContent = data[2];
      cells[5].textContent = data[3];
      cells[6].textContent = data[4];
      cells[7].textContent = data[5];
      cells[8].textContent = data[8];
      cells[9].textContent = String.fromCharCode(...data.subarray(10, 18));
    }
    if (fmdspFont) {
      vram.pixels.set(staticVramSnapshot);
      drawTrackRows(vram, fmdspFont, entryTracks);
      const modePmd = Module.getCommentModePmd() !== 0;
      const triangles = [];
      drawComment(vram, commentSmallFont, fmdspFont, commentBytesFor, modePmd, commentOffset, 1,
        (row, x, y) => triangles.push({ row, x, y }));
      lastTriangles = triangles;

      const audioState = globalThis.pmdAudioState;
      const hasPlayback = Boolean(audioState?.playback);
      const paused = Boolean(audioState?.paused);
      const rightPanePlaying = hasPlayback && !paused;
      rightPaneFrameCounter = (rightPaneFrameCounter + 1) & 0xffffffff;
      // PASSED TIME(=entry.frame。opna.generated_framesそのものであり、
      // fmdsp-pacc.cのpassed time計算(:1502)と同一の値)/CLOCK COUNT/
      // TIMER B CYCLE/LOOP COUNT/ループバーは fmdriver_work(fmdriver.h)由来で
      // 取得できる(docs/right-pane-data.md §7)。CPU/FPSに対応するwasm exportは
      // 存在しないため、でっち上げず0のまま渡す(旧pmdweb/html/index.htmlと同じ方針)。
      rightpane.drawDynamic(vram, {
        generatedFrames: BigInt(entry[SNAPSHOT_HEADER.FRAME] >>> 0),
        timerbCnt,
        timerb,
        loopCnt,
        cpuUsage: 0,
        fps: 0,
        timerbCntLoop,
        loopTimerbCnt,
        playing: rightPanePlaying,
        stopped: !hasPlayback,
        paused,
        frameCnt: rightPaneFrameCounter,
      });

      const { fft, levels } = readRightPaneData(entry);
      rightpane.drawSpectrumBars(vram, fft, fftPeakState);
      rightpane.drawLevelMeters(vram, levels, levelPeakState);

      canvasCtx.putImageData(vram.toImageData(palette), 0, 0);
    }
  }

  // --- トランスポート(再生/一時停止/停止)。
  // プレイヤーモード: MUCOM側と違いMMLコンパイルが無いぶん単純。「曲を開く」で
  // 読み込み即再生、btnPlayPauseは既にロード済みの曲の一時停止/再開専用。
  // エディタモード: MUCOM88と同じ。編集中(dirty)または未再生ならbtnPlayPauseは
  // 「コンパイル&再生」として働き、コンパイル成功後は一時停止/再開ボタンに戻る。
  let pausedFrameDrawn = false;
  let stoppedFrameDrawn = false;

  function updateTransportButtonUI() {
    const audioState = globalThis.pmdAudioState;
    const hasPlayback = Boolean(audioState?.playback);
    const paused = Boolean(audioState?.paused);
    const playing = hasPlayback && !paused;
    const needsCompile = uiMode === 'editor' && (mmlDirty || !hasCompiled);

    if (needsCompile) {
      btnPlayPause.disabled = !moduleReady;
      btnStop.disabled = !moduleReady || !hasPlayback;
      btnPlayPause.replaceChildren(svgIcon(ICONS.play.path ?? ICONS.play, ICONS.play.extra ?? ''));
      // ドットの意味を利用者に伝える(利用者報告「青い●は何?」への対応。
      // 見た目(サイズ・色)は変えず、title/aria-labelだけで説明する)。
      const title = mmlDirty ? '未コンパイルの変更があります(クリックでコンパイル&再生)' : 'コンパイル&再生';
      btnPlayPause.title = title;
      btnPlayPause.setAttribute('aria-label', title);
      btnPlayPause.classList.remove('active');
      btnPlayPause.classList.add('dirty');
      return;
    }

    btnPlayPause.disabled = !moduleReady || !hasPlayback;
    btnStop.disabled = !moduleReady || !hasPlayback;

    const icon = playing ? ICONS.pause : ICONS.play;
    const label = playing ? '一時停止' : (paused ? '再開' : '再生(曲を開いてください)');
    btnPlayPause.replaceChildren(svgIcon(icon.path ?? icon, icon.extra ?? ''));
    btnPlayPause.title = label;
    btnPlayPause.setAttribute('aria-label', label);
    btnPlayPause.classList.toggle('active', paused);
    btnPlayPause.classList.remove('dirty');
  }

  function setAudioPaused(paused) {
    const audioState = globalThis.pmdAudioState;
    if (!audioState) return;
    audioState.paused = paused;
    pausedFrameDrawn = false;
    updateTransportButtonUI();
  }

  function compileAndPlay() {
    if (!moduleReady) return;
    const source = mmlTextarea.value;
    const { file, errors } = compileMml(source);
    if (errors.length > 0) {
      renderCompileErrors(errors);
      updateTransportButtonUI();
      return;
    }
    Module.FS.writeFile('/edited.M', file);
    const error = Module.playMusic('/edited.M');
    if (error) {
      renderCompileErrors([{ line: null, message: `再生エラー: ${error}` }]);
      updateTransportButtonUI();
      return;
    }
    renderCompileErrors([]);
    mmlDirty = false;
    hasCompiled = true;
    commentOffset = 0;
    setAudioPaused(false);
  }

  btnPlayPause.addEventListener('click', () => {
    if (btnPlayPause.disabled) return;
    if (uiMode === 'editor' && (mmlDirty || !hasCompiled)) {
      compileAndPlay();
      return;
    }
    const audioState = globalThis.pmdAudioState;
    if (!audioState || !audioState.context) return;
    if (audioState.paused) {
      audioState.context.resume();
      setAudioPaused(false);
    } else {
      audioState.context.suspend();
      setAudioPaused(true);
    }
  });

  btnStop.addEventListener('click', () => {
    Module.stopMusic();
    const audioState = globalThis.pmdAudioState;
    if (audioState?.context?.state === 'suspended') {
      audioState.context.resume();
    }
    setAudioPaused(false);
  });

  updateTransportButtonUI();

  const debug = document.getElementById('snapshotDebug');

  function updateChannelStatus() {
    updateTransportButtonUI();

    if (Boolean(globalThis.pmdAudioState?.paused)) {
      if (pausedFrameDrawn) {
        requestAnimationFrame(updateChannelStatus);
        return;
      }
      pausedFrameDrawn = true;
    }

    const writeIndex = Module.getSnapshotWriteIndex() >>> 0;
    if (writeIndex === invalidIndex || writeIndex === 0) {
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
      const latest = entryAt(pointerWords, entryWords, writeIndex - 1);
      const renderFrame = latest[0] >>> 0;
      const state = globalThis.pmdAudioState;
      let selected = latest;
      let syncText = 'sync: waiting for playFrame';
      if (state?.playback && state.context) {
        const context = state.context;
        const sampleRate = context.sampleRate;
        const outputLatency = Number.isFinite(context.outputLatency) && context.outputLatency > 0
          ? context.outputLatency
          : (Number.isFinite(context.baseLatency) && context.baseLatency > 0 ? context.baseLatency : 0);
        const calibrationMs = Math.max(-200, Math.min(200, Number.parseFloat(calibrationInput.value) || 0));
        const estimatedPlayFrame = state.playback.playFrame +
          (context.currentTime - state.playback.contextTime) * sampleRate;
        const audibleFrame = Math.max(0, estimatedPlayFrame -
          (outputLatency + calibrationMs / 1000) * sampleRate);
        if (synchronizedCheckbox.checked) selected = findSnapshot(pointerWords, entryWords, writeIndex, audibleFrame);
        syncText = `sync: audibleFrame=${Math.round(audibleFrame)} renderFrame=${renderFrame} ` +
          `difference=${((renderFrame - audibleFrame) / sampleRate * 1000).toFixed(1)}ms ` +
          `latency=${(outputLatency * 1000).toFixed(1)}ms calibration=${calibrationMs.toFixed(1)}ms`;
      }
      draw(selected);
      debug.textContent = `${syncText}\n` +
        `snapshot: selectedFrame=${selected[0] >>> 0} writeIndex=${writeIndex}\n` +
        `counters: timerbCnt=${selected[SNAPSHOT_HEADER.TIMERB_CNT] >>> 0} ` +
        `timerb=${selected[SNAPSHOT_HEADER.TIMERB] >>> 0} ` +
        `loopCnt=${selected[SNAPSHOT_HEADER.LOOP_CNT] >>> 0} ` +
        `timerbCntLoop=${selected[SNAPSHOT_HEADER.TIMERB_CNT_LOOP] >>> 0} ` +
        `loopTimerbCnt=${selected[SNAPSHOT_HEADER.LOOP_TIMERB_CNT] >>> 0} ` +
        `audioContextTime=${(state?.context?.currentTime ?? 0).toFixed(3)}s`;
    }

    const state = globalThis.pmdAudioState;
    if (state) {
      const stats = state.stats;
      document.getElementById('audioDebug').textContent =
        `AudioWorklet: requested=${stats.requestedFrames} rendered=${stats.renderedFrames} ` +
        `queued=${stats.queuedFrames} underflow=${stats.underflowFrames}`;
    }
    requestAnimationFrame(updateChannelStatus);
  }
  requestAnimationFrame(updateChannelStatus);

  async function playBytes(bytes, name) {
    Module.FS.writeFile('/' + name, bytes);
    const error = Module.playMusic('/' + name);
    if (error) alert(error);
    commentOffset = 0;
    setAudioPaused(false);
  }

  btnOpenFile.addEventListener('click', () => {
    fileInput.value = '';
    fileInput.click();
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (file) await playBytes(new Uint8Array(await file.arrayBuffer()), file.name);
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
  consoleCard.addEventListener('drop', async (e) => {
    e.preventDefault();
    consoleCard.classList.remove('dropzone-active');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) await playBytes(new Uint8Array(await file.arrayBuffer()), file.name);
  });
}
