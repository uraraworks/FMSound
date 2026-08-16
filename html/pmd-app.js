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
import { drawTrackRows, createIdleEntryTracks, TRACK_H, TRACK_DISP_TABLE_OPNA } from './fmdsp/trackrow.js';
import {
  buildPmdChannelMask, mutedRowsFromChannels, mutedColumnsFromChannels,
  channelForRow, channelForLevelColumn, LEVEL_COLUMN_CHANNELS,
} from './fmdsp/channel-mask.js';
import { canvasPointFromClientClick, trackRowIndexAt, levelColumnIndexAt } from './fmdsp/track-click.js';
import { trackRowHoverRect, levelColumnHoverRect, drawHoverOutline, COLOR_HOVER } from './fmdsp/hover.js';
import { PALETTES } from './fmdsp/palette.js';
import { FONT_SMALL } from './fmdsp/font_small.js';
import { drawComment, commentScroll } from './fmdsp/comment.js';
import * as rightpane from './fmdsp/rightpane.js';
import { ICONS, iconButton, svgIcon } from './ui/icons.js';
import { setupMmlEditor } from './mml-editor.js';
import { PMD_TOKEN_RULES, PMD_MACRO_HEADER_RE, PMD_PART_LETTER_RE } from './mml-tokens.js';
import { compileMml } from './compiler/pmd_mml_compiler.mjs';
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

// 課題B: 「Clear MML」(空にするだけ・英語のまま)を「新規作成」に置き換える雛形。
// 押した直後にそのまま再生すると音が鳴ることを実測確認済み(FM1パートにALG7の
// 最小音色を1個定義し、既定音量で音階を鳴らすだけ)。
// PMDMML.MAN §11-1: `t`(テンポ絶対値)が指定するのは「2分音符=t(1分間)」であり、
// 一般的な「テンポ=4分音符のBPM」の半分の値になる(t60はBPM120相当。html/sample_fur_elise.mml
// のコメント・tools/verify_pmd_tempo_absolute.mjsで確認済み。実際にここで一度つまずいた実績があるため
// 雛形にも明記する)。
const PMD_NEW_MML_TEMPLATE = `; 新規作成ひな形: そのまま再生すると音が鳴ります(PMDMML.MAN §3-1準拠の最小音色1個)。
; t は「2分音符=t」基準(一般的な4分音符BPMの半分の値)。t60はBPM120相当。
@ 1 7 0
31 10 5 8 2 10 1 1 0 0
31 10 5 8 2 10 1 1 0 0
31 10 5 8 2 10 1 1 0 0
31 10 5 8 2 10 1 1 0 0
A t60 @1 v12 o5 l4 cdefgab>c<
`;

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
    '<a href="https://github.com/myon98/98fmplayer" target="_blank" rel="noopener">98fmplayer</a> ' +
    '<a href="https://github.com/myon98/98fmplayer/blob/master/LICENSE" target="_blank" rel="noopener">(BSD 2-Clause)</a> | ' +
    '<a href="https://github.com/uraraworks/FMSound" target="_blank" rel="noopener">FMSound on GitHub</a>';

  // 課題: ファイルから開く/D&Dの書庫対応(2026-08-16)。書庫拡張子の一覧は
  // net/archive.js ARCHIVE_EXTENSIONS(唯一の情報源)を参照する。isArchive()の
  // 判定規則と食い違わないよう、ここでは拡張子を書き並べない。
  fileInput.accept = ['.m', '.M', ...ARCHIVE_EXTENSIONS].join(',');

  // --- 曲を開く導線。東方Projectアレンジ曲(PC-98_Hartmann_s_Youkai_GIrl.M、
  // 権利不明のため同梱をやめた)の代わりに自作サンプル(エリーゼのために冒頭、
  // ベートーヴェンWoO 59はパブリックドメイン。MMLアレンジは本プロジェクトの著作物。
  // 詳細はNOTICE.md参照)を同梱する。プレイヤーモードではコンパイル済みの.Mを直接
  // 再生し、エディタモードではMMLソース(sample_fur_elise.mml、
  // tools/gen_sample_fur_elise.mjsが同じソースから.Mと.mmlの両方を生成しているので
  // 内容は常に一致する)をエディタへ読み込んでからコンパイル&再生する。
  sampleLinksEl.innerHTML =
    `<a href="javascript:void(0);" id="dlSampleFurElise">sample_fur_elise.M(${t('sample.furEliseLabel')})</a>` +
    `　${t('sample.openHintPmd')}`;
  document.getElementById('dlSampleFurElise').addEventListener('click', async () => {
    // 課題A: 復元した下書き/編集中の内容をサンプルで黙って上書きしない。
    // 何か入っている状態でのクリックだけ確認する(空なら聞くまでもない)。
    // プレイヤーモードでも同じ確認をする(下のとおりプレイヤーモードでも編集欄を
    // 静かに更新するため、モードで確認の有無を変えない)。
    if (mmlTextarea.value.trim().length > 0) {
      const ok = window.confirm(t('confirm.sampleReplace'));
      if (!ok) return;
    }
    if (uiMode === 'editor') {
      const response = await fetch('./sample_fur_elise.mml');
      const text = await response.text();
      mmlTextarea.value = text;
      mmlEditorApi.render();
      mmlDirty = false;
      compileAndPlay();
      return;
    }
    // 症状①: プレイヤーモードでサンプルを再生した直後にエディタモードへ切り替えると
    // 編集欄が空に見える不具合の対処。再生はプレイヤーモードのまま(コンパイル済み.Mを
    // 直接再生)で変えないが、後でエディタへ切り替えたときに何も入っていない状態に
    // ならないよう、MMLソースも並行して読み込み、静かに(コンパイルはせず)editor欄へ
    // 反映しておく(mucom-appのapplyMmlBytesがモードに関係なく編集欄を更新するのと
    // 揃える)。
    const [mResponse, mmlResponse] = await Promise.all([
      fetch('./sample_fur_elise.M'),
      fetch('./sample_fur_elise.mml'),
    ]);
    const buffer = await mResponse.arrayBuffer();
    const text = await mmlResponse.text();
    mmlTextarea.value = text;
    mmlEditorApi.render();
    mmlDirty = false;
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
      <div id="result"></div>
    </div>
    <details class="debug-table debug-only" id="debugTable">
      <summary>${t('debug.trackTableHeading')}</summary>
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
    driver: 'pmd',
    getDb: getLibraryDb,
    onSelect: (song) => {
      // 修正1: ライブラリから選んだ曲もURL由来ではないので、残っている
      // `?mml=` はここで取り除く(net-load.js clearLoadedUrlFromAddressBar()参照)。
      clearLoadedUrlFromAddressBar();
      playBytes(song.bytes, song.fileName);
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

  let uiMode = 'player';

  function applyUiMode(mode) {
    uiMode = mode;
    mmlEditorPane.classList.toggle('hidden', mode !== 'editor');
    btnEditorMode.classList.toggle('active', mode === 'editor');
    btnEditorMode.title = mode === 'editor' ? t('toolbar.playerMode') : t('toolbar.editorMode');
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
    const next = uiMode === 'editor' ? 'player' : 'editor';
    // 課題E: 「編集OFF→ON」の遷移のときだけ、再生中の曲を頭出しで止める
    // (一時停止ではない)。編集ONで再生ボタンを押すのは普通に鳴らす通常操作なので
    // ここでは止めない。編集から戻るときも何もしない(moduleReadyが立つ前の
    // クリックではModuleが無いのでstopPlayback()自体を呼ばない)。
    if (next === 'editor' && uiMode !== 'editor' && moduleReady) {
      stopPlayback();
    }
    setUiMode(next);
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
      // 課題C: PMDのコンパイラは詳細出力(バナー等)を持たないため、成功時は
      // 上の状態表示(#mmlStatus、'コンパイル成功')と下の#resultに全く同じ文言が
      // 二重に出ていた。#resultは「詳細ログ専用」にし、詳細が無い(=成功)ときは
      // 何も書かない(CSSの#result:empty{display:none}で領域ごと消える)。
      setMmlStatus(mmlStatusEl, { ok: true });
      return;
    }
    // 課題B: 状態表示には先頭のエラーだけを1行で出す(複数ある場合の残りは
    // 下の#result側で確認する)。
    setMmlStatus(mmlStatusEl, {
      ok: false,
      line: errors[0].line ?? null,
      message: errors[0].message,
      onJump: (line) => mmlEditorApi.jumpToLine(line),
    });
    // 症状④: 先頭のエラーは直上の状態表示(上)にすでに出ているため、#result(下)では
    // 2件目以降だけを並べる(同じ「line N: message」を上下二重に出さない)。
    // エラーが1件だけのときは#resultには何も追加しない(詳細ログ側に足す情報が無い)。
    for (const e of errors.slice(1)) {
      const div = document.createElement('div');
      div.textContent = e.line != null ? `line ${e.line}: ${e.message}` : e.message;
      // 課題D: エラーはすべて赤系(--danger)にする(行番号が無い「再生エラー: ...」も
      // 含む。以前は line != null のときだけ .mml-error-line を付けていたため
      // 再生エラーだけ色が付かない抜けがあった)。正常時の「コンパイル成功」は
      // このループを通らない(上のearly returnで別処理)ので赤くならない。
      div.classList.add('mml-compile-error-text');
      if (e.line != null) {
        div.classList.add('mml-error-line');
        div.title = t('mml.jumpToLine', { line: e.line });
        div.addEventListener('click', () => mmlEditorApi.jumpToLine(e.line));
      }
      resultEl.appendChild(div);
    }
  }

  // 課題A: 前回のコンパイル結果(上の1行要約+下の詳細ログ)を消す。実機報告の
  // 「エラーが消えずに積み上がる」不具合の実体は「新規作成でMMLを空にした後、
  // 一度もrenderCompileErrors()が呼ばれないまま古い表示が残ること」だった
  // (Clear MMLが#result/#mmlStatusに一切触れていなかった)。新しいコンパイルの
  // 開始時・編集内容を消した(新規作成)とき・曲を読み込んだときの3箇所で呼ぶ。
  function clearCompileStatus() {
    resultEl.replaceChildren();
    clearMmlStatus(mmlStatusEl);
  }

  // 課題A: 編集欄が空のまま再生されたとき、古いエラー表示を残さず案内を出す。
  function showEmptyMmlNotice() {
    resultEl.replaceChildren();
    const message = t('mml.emptyNotice');
    resultEl.textContent = message;
    setMmlStatus(mmlStatusEl, { ok: false, message });
  }

  // 課題B: 「Clear MML」を「新規作成」に置き換える。空にするのではなく、押した直後に
  // そのまま再生すれば音が鳴る最小の雛形(PMD_NEW_MML_TEMPLATE)を入れる。
  // 既存の確認(内容があるときだけ)とCmd/Ctrl+Zでの取り消しの挙動はそのまま引き継ぐ。
  btnNewMml.addEventListener('click', function() {
    const ta = mmlTextarea;
    if (ta.value.length > 0) {
      const ok = window.confirm(t('confirm.newFile'));
      if (!ok) return;
    }
    ta.focus();
    ta.select();
    const undoable = typeof document.execCommand === 'function' &&
      document.execCommand('insertText', false, PMD_NEW_MML_TEMPLATE);
    if (!undoable) {
      ta.value = PMD_NEW_MML_TEMPLATE;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    mmlEditorApi.render();
    // 課題A: 編集内容を消した(新規作成した)ときも前回のエラー表示を残さない。
    clearCompileStatus();
    // 【不具合修正・2026-08-16】新規作成しても`?mml=<URL>`がアドレスバーに残ったままだと、
    // リロード時に「編集欄は新規の雛形なのに消したはずの書庫を読みに行ってしまう」
    // (net-load.js clearLoadedUrlFromAddressBar()冒頭コメント参照。利用者報告)。
    clearLoadedUrlFromAddressBar();
  });

  rescale();
  requestAnimationFrame(rescale);

  // moduleReady/lastPlayIconKeyはupdateTransportButtonUI()(applyUiMode()経由で
  // 即座に呼ばれる)が参照するため、letのTemporal Dead Zoneを踏まないよう
  // 先に宣言しておく(実測で「Cannot access 'moduleReady' before initialization」を
  // 確認して気づいた。lastPlayIconKeyも同じ理由で同居させる)。
  let moduleReady = false;
  let lastPlayIconKey = null;
  // URL指定(?mml=)で読み込んだが、まだ再生ボタンを押していない曲。
  // { bytes, name } | null。btnPlayPauseクリックで消費してplayBytes()する
  // (読み込むだけで自動再生はしない。AudioContextはユーザー操作を要求するため)。
  let pendingUrlSong = null;
  // FMDSP画面の「MUSIC FILE」バーに出す曲名(html/net-load.jsの表示名決定規則
  // (Content-Disposition→書庫内ファイル名→MMLの#title→URL末尾)で決まった値を
  // そのまま使う。ツールバー側のnetStatus文言(「読み込みました: ...」)と
  // 同じ文字列にすることで画面とツールバーの表示を一致させる)。
  // pendingUrlSong.name / playBytes()のname引数のどちらかが更新されるたびに
  // ここも一緒に更新する(曲が変わっても古い名前が残らないようにする)。
  //
  // 課題B追補(2026-08-15、利用者報告「同梱サンプルの経路でバーが空になった」):
  // 実際の原因は下書き復元(上のhasDraft分岐)がcurrentSongNameに一切触れて
  // いなかったこと。下書き復元は自動保存(setupMmlAutosave、タブを閉じる/裏に
  // 回すだけでも保存される)により通常利用でもごく普通に起きる経路なので、
  // 「読み込み元がファイルではない」ことが分かるFILEBAR_RESTORED_DRAFT_NAMEを
  // ここで設定しておく(空のまま=壊れて見える、を避ける。fmdsp/rightpane.js
  // drawFileBar()参照)。
  let currentSongName = hasDraft ? FILEBAR_RESTORED_DRAFT_NAME : null;

  // --- URL指定読み込み時の状態表示(常時表示。#result/#mmlStatusはmmlEditorPane配下で
  // プレイヤーモード時に隠れるため、その外側(sampleLinksElの直後)に置く)。 ---
  const netStatusEl = document.createElement('div');
  netStatusEl.className = 'net-status hidden';
  sampleLinksEl.insertAdjacentElement('afterend', netStatusEl);

  function setNetStatus(message, isError) {
    netStatusEl.textContent = message;
    netStatusEl.classList.toggle('net-status-error', Boolean(isError));
    netStatusEl.classList.toggle('hidden', !message);
  }

  applyUiMode(currentUiMode());

  const Module = await createPmdWeb();
  moduleReady = true;

  const vram = new Vram(PC98_W, PC98_H);
  const canvasCtx = canvas.getContext('2d');
  const palette = PALETTES[0];

  // トラック行/レベルメータークリックミュート機能(利用者指示: クリックでミュート、
  // もう一度で解除。ソロ機能は無し)。
  //
  // 2026-08-16: 唯一の状態(single source of truth)を mutedChannels
  // (Set<string>、fmdsp/channel-mask.jsの論理チャンネル名の集合)に一本化した。
  // 以前はミュート中の「行index」をそのまま状態として持っていたが、リズムは
  // 対応する行を持たない(TRACK_ROW_CHANNELSのコメント参照)ため、レベルメーター
  // クリック(リズム列を含む)を追加するにあたり「行index」を状態の単位にしたままでは
  // 表現できなかった。mutedChannelsを唯一の状態にし、描画に必要な
  // Set<number>(行index/列index)はmutedRowsFromChannels()/mutedColumnsFromChannels()
  // で毎フレーム導出する(=トラック行クリックとメータークリックのどちらから
  // ミュートしても同じmutedChannelsを書き換えるので、二重管理にならず表示も自動的に
  // 同期する)。
  // マスク値の組み立ては fmdsp/channel-mask.js の buildPmdChannelMask() に
  // 一元化してある(MUCOM88とPMDでビット割り当てが違うので、ここで共通マスクを
  // 作って両方へ渡すような真似は絶対にしない)。
  const mutedChannels = new Set();
  function toggleMutedChannel(channel) {
    if (!channel) return;
    if (mutedChannels.has(channel)) mutedChannels.delete(channel); else mutedChannels.add(channel);
    applyChannelMask();
  }
  function applyChannelMask() {
    if (typeof Module.setChannelMask === 'function') {
      Module.setChannelMask(buildPmdChannelMask(mutedChannels));
    }
  }

  // バージョン文字列: FMPLAYER_VERSION_0/1/2相当の値はwasm側に対応exportが無く、
  // でっち上げないため固定のプレースホルダ('-','-','-')にする(旧pmdweb/html/index.html
  // と同じ方針)。
  rightpane.drawStaticDecorations(vram, ['-', '-', '-'], 'PMD');
  const staticVramSnapshot = vram.pixels.slice();

  const fftPeakState = rightpane.createPeakState(rightpane.FFTDISPLEN);
  const levelPeakState = rightpane.createPeakState(rightpane.FMDSP_LEVEL_COUNT);
  let rightPaneFrameCounter = 0;
  // FRAMES PER SECOND(右ペイン)。updateChannelStatus()はrAF駆動の描画ループ本体
  // なので、その呼び出し間隔=実測フレームレートをそのままFPS表示に使う
  // (fmdsp/rightpane.js createFpsCounter/tickFpsCounter参照。上流fmdsp_fps_30()も
  // wasm/音源と無関係にホスト側の描画頻度を数えているだけなので意味が一致する)。
  const fpsCounter = rightpane.createFpsCounter();
  let currentFps = 0;
  // 曲が読み込まれていない/停止中でもパート行の枠を描くためのプレースホルダ
  // (trackrow.js createIdleEntryTracks() 参照)。
  const idleEntryTracks = createIdleEntryTracks();

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

  // トラック行/レベルメーター列の当たり判定config。クリックとホバー枠の両方が
  // 必ずこの同じオブジェクトを使うことで、「クリックできる範囲」と「枠が出る範囲」
  // がズレないようにする(利用者指示: 押せそうに見えて何も起きないのが一番悪い)。
  const TRACK_ROW_HIT_CONFIG = {
    trackH: TRACK_H, rowCount: TRACK_DISP_TABLE_OPNA.length, panelWidth: PC98_W / 2,
  };
  const LEVEL_COLUMN_HIT_CONFIG = {
    columnX0: rightpane.LEVEL_X, columnW: rightpane.LEVEL_W,
    topY: rightpane.LEVEL_TRACK_Y, bottomY: rightpane.LEVEL_KEY_Y + 8,
    columnCount: LEVEL_COLUMN_CHANNELS.length,
  };
  // クライアント座標(event.clientX/Y)から、トラック行/レベルメーター列のどちらに
  // 当たったかを返す(三角(コメントスクロール)は含まない。ホバー枠の対象は
  // 利用者指示によりトラック行とレベルメーターの2種類のみ)。当たらなければnull。
  function hitTestTrackOrLevel(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const point = canvasPointFromClientClick(clientX, clientY, rect, PC98_W, PC98_H);
    if (!point) return null;
    const row = trackRowIndexAt(point.x, point.y, TRACK_ROW_HIT_CONFIG);
    if (row >= 0) return { kind: 'row', index: row };
    const col = levelColumnIndexAt(point.x, point.y, LEVEL_COLUMN_HIT_CONFIG);
    if (col >= 0) return { kind: 'col', index: col };
    return null;
  }

  canvas.addEventListener('click', (event) => {
    const rect = canvas.getBoundingClientRect();
    // 表示上のクリック座標(CSS px、rescale()でcanvas.style.width/heightが可変)を
    // キャンバスの内部解像度(640x400、PC98_W/PC98_H)へ変換する。ここを素通しすると
    // 縮小・拡大時にクリック位置がずれる(実測で確認)。
    const point = canvasPointFromClientClick(event.clientX, event.clientY, rect, PC98_W, PC98_H);
    if (!point) return;
    const { x, y } = point;
    for (const tri of lastTriangles) {
      // 中段(row===1、COMPOSER/ARRANGERの2本)は↑/↓のどちらとも決め難いため無反応にする。
      if (tri.row === 1) continue;
      if (Math.abs(x - tri.x) > TRI_HIT_PAD_X || Math.abs(y - tri.y) > TRI_HIT_PAD_Y) continue;
      const modePmd = Module.getCommentModePmd() !== 0;
      const down = tri.row === 2; // 上段(row0)=↑(前へ)、下段(row2)=↓(次へ)
      commentOffset = commentScroll(commentOffset, down, modePmd, commentBytesFor);
      return;
    }
    // 三角に当たらなかった場合、トラック行/レベルメータークリックミュートの判定
    // へフォールバック(2026-08-16追加、fmdsp/channel-mask.js LEVEL_COLUMN_CHANNELS
    // 参照。リズムはトラック行を持たないため、ミュートできるのはレベルメーター
    // 経由のみ)。
    const hit = hitTestTrackOrLevel(event.clientX, event.clientY);
    if (!hit) return;
    if (hit.kind === 'row') toggleMutedChannel(channelForRow(hit.index));
    else toggleMutedChannel(channelForLevelColumn(hit.index));
  });

  // ホバー枠(利用者指示A)。クリック可能な対象(hitTestTrackOrLevelが返す対象と
  // 完全に同じ集合。三角は対象外)にだけ枠を出す。canvas外へ出た/別ウィンドウへ
  // フォーカスが移った場合は必ず消す(mouseleaveだけだと、マウスが動かないまま
  // Alt+Tab等でフォーカスだけ他アプリへ移った場合に消えないため、
  // blur/visibilitychangeも併用する)。
  let hoverTarget = null;
  canvas.addEventListener('mousemove', (event) => {
    hoverTarget = hitTestTrackOrLevel(event.clientX, event.clientY);
  });
  canvas.addEventListener('mouseleave', () => { hoverTarget = null; });
  window.addEventListener('blur', () => { hoverTarget = null; });
  document.addEventListener('visibilitychange', () => { if (document.hidden) hoverTarget = null; });
  function drawHover(vram) {
    if (!hoverTarget) return;
    const rect = hoverTarget.kind === 'row'
      ? trackRowHoverRect(hoverTarget.index, TRACK_ROW_HIT_CONFIG)
      : levelColumnHoverRect(hoverTarget.index, LEVEL_COLUMN_HIT_CONFIG);
    drawHoverOutline(vram, rect, COLOR_HOVER);
  }

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
    // 課題B: fmdriver_work.playing(PmdCore.c push_snapshot()参照)。ループしない曲が
    // 末尾に到達したときだけfalseになる(ループする曲はloop.loopedがtrueのまま保たれる
    // ため常にtrue。upstream/98fmplayer/fmdriver/fmdriver_pmd.c:5692参照)。
    DRIVER_PLAYING: 6,
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
      drawTrackRows(vram, fmdspFont, entryTracks, mutedRowsFromChannels(mutedChannels));
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
      // 取得できる(docs/right-pane-data.md §7)。
      // CPU POWER COUNT: ブラウザにプロセスCPU使用率を取得するAPIが無く恒久的に
      // 取得不能(でっち上げず0のまま渡す。drawCpuFps側が暗色描画に落とす)。
      // FRAMES PER SECOND: 2026-08-16実装。rightpane.tickFpsCounter()が
      // updateChannelStatus()の実行間隔(=rAFの実測頻度)から算出した値。
      rightpane.drawDynamic(vram, {
        generatedFrames: BigInt(entry[SNAPSHOT_HEADER.FRAME] >>> 0),
        timerbCnt,
        timerb,
        loopCnt,
        cpuUsage: 0,
        fps: currentFps,
        timerbCntLoop,
        loopTimerbCnt,
        playing: rightPanePlaying,
        stopped: !hasPlayback,
        paused,
        frameCnt: rightPaneFrameCounter,
      });

      const { fft, levels } = readRightPaneData(entry);
      rightpane.drawSpectrumBars(vram, fft, fftPeakState);
      rightpane.drawLevelMeters(vram, levels, levelPeakState, mutedColumnsFromChannels(mutedChannels));
      rightpane.drawFileBar(vram, currentSongName);
      drawHover(vram);

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
  // アイドル画面(停止中)で直近に描いた曲名。undefinedは「まだ一度も描いていない」。
  let idleDrawnSongName;
  // 2026-08-17: アイドル/一時停止画面は本来「変化が無ければ描き直さない」最適化の
  // ため一度描いたら固定するが、それだとホバー枠(下のhoverTarget)が動かず残って
  // しまう。直近に描いたホバー対象をキーとして持ち、変化したときだけ再描画させる
  // (html/mucom-app.jsの同名対応と同じ考え方)。
  let idleDrawnHoverKey;
  function hoverKeyOf(target) { return target ? `${target.kind}:${target.index}` : ''; }
  // 課題B: 「曲が終わったこと」の検出を1箇所にまとめる(将来の連続再生の土台にもなる
  // ため、updateChannelStatus()内のここだけで判定する)。SNAPSHOT_HEADER.DRIVER_PLAYING
  // がtrue->falseへ変わった瞬間だけ発火させるための直前値。
  let wasDriverPlaying = false;

  // 症状③⑥の根本原因: 以前はここで毎フレーム(rAFループ経由)無条件に
  // btnPlayPause.replaceChildren(...)していたため、ボタンの中身(アイコンのsvg)が
  // 実際のクリック操作のmousedown〜mouseup間に差し替わることがあった。mousedownの
  // 対象要素がmouseup前にDOMから切り離されると、ブラウザはclickイベントを
  // 発火できない(実測: btn.firstElementChildが約16ms間隔で毎回別ノードに
  // 差し替わっていることをisConnectedで確認した)。これが「押しても無反応、だが
  // ⌘/Ctrl+Enter(btnPlayPause.click()を直接呼ぶ経路)なら効く」の正体だった。
  // 対策: アイコンの種別(play/pause)が実際に変わるときだけ差し替える
  // (lastPlayIconKey自体はTDZを避けるため上のmoduleReady宣言のそばへ移した)。

  // 症状⑥: 「編集モードで一度コンパイル成功→Stop→もう一度Play」が押せなくなる
  // (または無反応になる)不具合の対処。以前はmmlDirty/hasCompiledだけを見ており、
  // 「編集していないが完全に停止済み(hasPlayback===false)」という状態を
  // 考慮していなかった。この状態は一時停止(pausedでhasPlaybackはtrueのまま)とは
  // 別物で、Module側は曲を手放しているため単純なcontext.resume()では鳴らせない。
  // ここに来たら「コンパイル&再生」扱いにして、もう一度compileAndPlay()を
  // 呼び直せば復帰する(内容は変わっていないので再コンパイルしても実害は無い)。
  //
  // 2026-08-15 実機報告(リロードで再生ボタンが押せない)の対処: 以前は
  // `uiMode !== 'editor'` の時点で無条件にfalseを返しており、「プレイヤーモードの
  // 隠れたエディタ欄にMMLがある(下書き復元・手入力・貼り付け由来)が、まだ何も
  // 再生していない」状態を考慮していなかった。「曲が読み込まれている」
  // (hasPlayback/pendingUrlSong)と「MMLがある」(mmlTextarea.value)は別概念であり、
  // 前者が無い場合は後者の有無だけでコンパイル要否を決める(モードを問わない)。
  // ただしpendingUrlSong(URL/サンプルから読み込み済みの.M/.mバイナリ)がある場合は
  // そちらの再生を優先する(プレイヤーモードの既存挙動どおり。テキストの再コンパイルで
  // 上書きしない)。詳細はdocs/transport-button-state.md参照。
  function needsCompileNow() {
    const hasPlayback = Boolean(globalThis.pmdAudioState?.playback);
    if (hasPlayback) {
      return uiMode === 'editor' && (mmlDirty || !hasCompiled);
    }
    if (pendingUrlSong && uiMode !== 'editor') return false;
    return mmlTextarea.value.trim().length > 0;
  }

  function updateTransportButtonUI() {
    const audioState = globalThis.pmdAudioState;
    const hasPlayback = Boolean(audioState?.playback);
    const paused = Boolean(audioState?.paused);
    const playing = hasPlayback && !paused;
    const needsCompile = needsCompileNow();
    // 症状②: MMLが空のとき、またはmmlDirty自体がfalseのとき(⑥の「停止直後」等)は
    // 「未コンパイルの変更があります」の青いドットを出さない(実際に変更が無いのに
    // ドットが出るのは不自然)。
    const hasMmlContent = mmlTextarea.value.trim().length > 0;

    let iconKey, title, active, dirty, playDisabled, stopDisabled;
    if (needsCompile) {
      playDisabled = !moduleReady;
      stopDisabled = !moduleReady || !hasPlayback;
      iconKey = 'play';
      // ドットの意味を利用者に伝える(利用者報告「青い●は何?」への対応。
      // 見た目(サイズ・色)は変えず、title/aria-labelだけで説明する)。
      title = mmlDirty
        ? t('transport.dirtyHintSlash', { hint: SHORTCUT_PLAY_HINT })
        : t('transport.compileAndPlay', { hint: SHORTCUT_PLAY_HINT });
      active = false;
      dirty = mmlDirty && hasMmlContent;
    } else if (pendingUrlSong && uiMode !== 'editor') {
      // URL指定(?mml=)で読み込んだが未再生の曲がある状態。読み込むだけでは自動再生
      // しない方針のため、ここではbtnPlayPauseを「読み込んだ曲を再生」ボタンとして
      // 有効化する(押した瞬間に初めてModule.playMusic()が呼ばれる)。
      playDisabled = !moduleReady;
      stopDisabled = !moduleReady || !hasPlayback;
      iconKey = 'play';
      title = t('transport.playPending', { hint: SHORTCUT_PLAY_HINT });
      active = false;
      dirty = false;
    } else {
      playDisabled = !moduleReady || !hasPlayback;
      stopDisabled = !moduleReady || !hasPlayback;
      iconKey = playing ? 'pause' : 'play';
      title = playing
        ? t('transport.pause', { hint: SHORTCUT_PLAY_HINT })
        : (paused ? t('transport.resume', { hint: SHORTCUT_PLAY_HINT }) : t('transport.playIdle', { hint: SHORTCUT_PLAY_HINT }));
      active = paused;
      dirty = false;
    }

    btnPlayPause.disabled = playDisabled;
    btnStop.disabled = stopDisabled;
    if (iconKey !== lastPlayIconKey) {
      const icon = iconKey === 'pause' ? ICONS.pause : ICONS.play;
      btnPlayPause.replaceChildren(svgIcon(icon.path ?? icon, icon.extra ?? ''));
      lastPlayIconKey = iconKey;
    }
    btnPlayPause.title = title;
    btnPlayPause.setAttribute('aria-label', title);
    btnPlayPause.classList.toggle('active', active);
    btnPlayPause.classList.toggle('dirty', dirty);
  }

  function setAudioPaused(paused) {
    const audioState = globalThis.pmdAudioState;
    if (!audioState) return;
    audioState.paused = paused;
    pausedFrameDrawn = false;
    updateTransportButtonUI();
  }

  // 課題D: ダウンロード用に「直近で実際に再生できたコンパイル済みバイト列」を
  // 保持する。エディタでのコンパイル成功時、プレイヤーでの曲読み込み成功時の
  // 両方で更新する(playBytes()参照)。
  let lastCompiledBytes = null;

  function compileAndPlay() {
    if (!moduleReady) return;
    const source = mmlTextarea.value;
    // 課題A: 編集欄が空のまま再生された場合、古いエラー表示を残さず案内を出して終える。
    if (source.trim().length === 0) {
      showEmptyMmlNotice();
      return;
    }
    // 課題A: 新しいコンパイルを開始するタイミングで前回の表示を消す(この直後
    // renderCompileErrors()が今回の結果で上書きするが、「開始時に消す」という
    // 要求どおりの箇所として明示的に置く)。
    clearCompileStatus();
    const { file, errors } = compileMml(source);
    if (errors.length > 0) {
      renderCompileErrors(errors);
      updateTransportButtonUI();
      return;
    }
    Module.FS.writeFile('/edited.M', file);
    const error = Module.playMusic('/edited.M');
    // 曲を読み込み直すたびにミュートを全解除する(利用者指示: 意図しない無音を
    // 次の曲へ持ち越さない)。
    mutedChannels.clear();
    applyChannelMask();
    if (error) {
      renderCompileErrors([{ line: null, message: t('mml.playbackError', { error }) }]);
      updateTransportButtonUI();
      return;
    }
    renderCompileErrors([]);
    lastCompiledBytes = file;
    mmlDirty = false;
    hasCompiled = true;
    commentOffset = 0;
    // 課題B(2026-08-15): エディタで直接再生した場合はファイル名という概念が無い。
    // 以前はMML本文の#titleヘッダを拾って代わりに表示していたが、FILEBARは
    // 半角専用フォントで描くため全角の曲名が途中で欠けて中途半端に見える不具合に
    // なっていた。本家どおり「ファイル名」専用に統一したため、ここでタイトルへ
    // フォールバックするのはもう適切ではない。ファイル名が無い以上、捏造せずnull
    // (何も表示しない)。
    currentSongName = null;
    setAudioPaused(false);
  }

  btnPlayPause.addEventListener('click', () => {
    if (btnPlayPause.disabled) return;
    if (needsCompileNow()) {
      compileAndPlay();
      return;
    }
    if (pendingUrlSong && uiMode !== 'editor') {
      const { bytes, name, fileName } = pendingUrlSong;
      pendingUrlSong = null;
      playBytes(bytes, name, fileName);
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

  // 課題E: 停止処理を名前付き関数に切り出す。btnStopクリックだけでなく、
  // 編集モードOFF→ON遷移(下のbtnEditorModeクリック)でも同じ「頭出し停止」を使う。
  function stopPlayback() {
    Module.stopMusic();
    const audioState = globalThis.pmdAudioState;
    if (audioState?.context?.state === 'suspended') {
      audioState.context.resume();
    }
    setAudioPaused(false);
  }

  btnStop.addEventListener('click', stopPlayback);

  updateTransportButtonUI();

  const debug = document.getElementById('snapshotDebug');

  function updateChannelStatus() {
    // rAFの実測頻度をFPSとして数える。早期return(一時停止中の再描画スキップ)より
    // 前に置くことで、「描画ループ自体が呼ばれる頻度」を測る
    // (実際に毎回canvasへ描くかどうかは別問題として扱う)。
    currentFps = rightpane.tickFpsCounter(fpsCounter, performance.now());
    updateTransportButtonUI();

    if (Boolean(globalThis.pmdAudioState?.paused)) {
      // 2026-08-17: 一時停止中は本来ここで即returnして描き直しを止める最適化だが、
      // それだとホバー枠が一時停止中は動かなくなる。ホバー対象が前回描画時と
      // 変わっていなければ従来どおりスキップする。
      if (pausedFrameDrawn && idleDrawnHoverKey === hoverKeyOf(hoverTarget)) {
        requestAnimationFrame(updateChannelStatus);
        return;
      }
      pausedFrameDrawn = true;
      idleDrawnHoverKey = hoverKeyOf(hoverTarget);
    }

    const writeIndex = Module.getSnapshotWriteIndex() >>> 0;
    if (writeIndex === invalidIndex || writeIndex === 0) {
      debug.innerText = 'snapshot ring: inactive/empty';
      // 2026-08-15: 実機報告「再生前は左半分のパート行が真っ黒」への対処。
      // 以前は fmdspFont 未ロードの間でも stoppedFrameDrawn を true にしてしまい、
      // 初回rAFの時点(shinonome.romのfetchがまだ終わっていない)でこの分岐自体を
      // 二度と通らなくなっていた(=パート行が永遠に描かれない)。フォントが
      // 揃うまでは毎フレーム再試行し、実際に描けたときだけフラグを立てる。
      // idleDrawnSongNameは「?mml=読み込み(非同期fetch)がこの一回描画より後に
      // 完了し、曲名だけ古いまま固定されてしまう」抜けを防ぐため、曲名が変わったら
      // stoppedFrameDrawnの状態に関わらず描き直す。
      if (fmdspFont && (!stoppedFrameDrawn || idleDrawnSongName !== currentSongName || idleDrawnHoverKey !== hoverKeyOf(hoverTarget))) {
        stoppedFrameDrawn = true;
        idleDrawnSongName = currentSongName;
        idleDrawnHoverKey = hoverKeyOf(hoverTarget);
        vram.pixels.set(staticVramSnapshot);
        drawTrackRows(vram, fmdspFont, idleEntryTracks, mutedRowsFromChannels(mutedChannels));
        const modePmd = Module.getCommentModePmd() !== 0;
        const triangles = [];
        drawComment(vram, commentSmallFont, fmdspFont, commentBytesFor, modePmd, commentOffset, 1,
          (row, x, y) => triangles.push({ row, x, y }));
        lastTriangles = triangles;
        rightPaneFrameCounter = (rightPaneFrameCounter + 1) & 0xffffffff;
        rightpane.drawCircle(vram, { playing: false, paused: false, timerbCnt: 0, frameCnt: rightPaneFrameCounter });
        rightpane.drawTransportIcons(vram, { playing: false, stopped: true, paused: false });
        rightpane.drawFileBar(vram, currentSongName);
        drawHover(vram);
        canvasCtx.putImageData(vram.toImageData(palette), 0, 0);
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

      // 課題B: 「曲が終わったこと」の検出(1箇所にまとめる)。latest(最新スナップショット、
      // 同期表示用のselectedより遅延が無い)のDRIVER_PLAYINGがtrue->falseへ変わった
      // 瞬間だけ、実際に再生中(hasPlayback&&!paused)なら停止状態へ遷移する(頭出し)。
      // ループする曲はfmdriver_work.playingがtrueのままなので、ここは発火しない
      // (tools/verify_pmd_new_template.mjs等の検証参照)。
      {
        const driverPlaying = (latest[SNAPSHOT_HEADER.DRIVER_PLAYING] >>> 0) !== 0;
        const s = globalThis.pmdAudioState;
        const activelyPlaying = Boolean(s?.playback) && !Boolean(s?.paused);
        if (wasDriverPlaying && !driverPlaying && activelyPlaying) {
          stopPlayback();
        }
        wasDriverPlaying = driverPlaying;
      }

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

  // fileNameForBar: FILEBAR(FMDSP)専用のファイル名(課題B、2026-08-15)。
  // nameは仮想FS書き込み(Module.FS.writeFile)にも使う都合上、URL読み込み時は
  // 表示名(#titleへのフォールバックを含みうる。html/net-load.jsのname参照)の
  // ままにしておく必要がある一方、FILEBARには#titleへ絶対フォールバックしない
  // ファイル名だけを渡したいため、両者を分離できるよう引数を分けた。省略時は
  // nameをそのまま使う(sample_fur_elise.M・ローカルファイルのFile.name等、
  // 元々ファイル名そのものである呼び出しはこれで正しい)。
  async function playBytes(bytes, name, fileNameForBar = name) {
    // 課題A: 曲を読み込んだときも編集欄に残っていた前回のエラー表示を消す
    // (この経路はMMLコンパイルを経由しない.M/.mバイナリの直接再生なので、
    // compileAndPlay()側のclearCompileStatus()を通らない)。
    clearCompileStatus();
    pendingUrlSong = null; // 直接再生する経路に入った時点で「未再生の読み込み」状態は解消
    currentSongName = fileNameForBar;
    Module.FS.writeFile('/' + name, bytes);
    const error = Module.playMusic('/' + name);
    // 曲を読み込み直すたびにミュートを全解除する(利用者指示: 意図しない無音を
    // 次の曲へ持ち越さない)。
    mutedChannels.clear();
    applyChannelMask();
    if (error) {
      alert(error);
    } else {
      lastCompiledBytes = bytes; // 課題D: 「曲を開く」で読み込んだ.Mもダウンロード対象にする
    }
    commentOffset = 0;
    setAudioPaused(false);
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
  // 自動取り込み(利用者指示): 「曲を開く」/ドラッグ&ドロップで読み込んだ曲は
  // そのまま曲ライブラリへ残す。ローカルファイルにはURLが無いため、出所はファイル名
  // だけで識別する(net/library.js computeSongId()参照)。
  function persistLocalPmdSong(bytes, fileName) {
    persistSongToLibrary({
      driver: 'pmd',
      bytes,
      fileName,
      origin: { kind: 'local', url: null, archiveName: null, groupPath: null, entryPath: null },
    });
  }

  // --- 曲を開く(ローカルの.m/.Mファイル選択 / ドラッグ&ドロップ) ---
  //
  // 【拡張・2026-08-16】ローカルファイルが書庫(zip/lzh/d88)だった場合の対応を追加。
  // 以前はここで書庫判定を一切せず、書庫のバイト列をそのままバイナリ(コンパイル済み
  // .M/.m)として仮想FSへ書き込んでいたため無言で壊れていた(利用者報告)。
  // URL経路(下のloadSongFromUrl())が既に持っている書庫展開・曲選択・ライブラリ
  // 一括取り込みの仕組みへ合流させる(html/net-load.js resolveSongFromFile()が
  // resolveSongFromUrl()と同じnet/archive.js・net/song-select.jsを経由するため、
  // 判定・展開ロジックはここで新しく書き起こさない)。
  async function openPmdFile(file) {
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
      const pmdCandidates = resolved.candidates.filter((c) => c.driver === 'pmd');
      if (pmdCandidates.length === 0) {
        const otherCount = resolved.candidates.length;
        setNetStatus(
          otherCount > 0
            ? t('net.noPmdCandidatesOther', { otherCount })
            : t('net.noPlayableSongs'),
          true,
        );
        return;
      }
      // 自動取り込み: URL経路(loadSongFromUrl())と同じく、書庫を開いた時点で書庫内の
      // 全曲をライブラリへ一括取り込みする。出所はURLではなくローカルファイルなので
      // kind: 'local' を渡す(net/library.js importArchiveSongs()参照)。
      const importResult = await importArchiveSongsToLibrary({
        driver: 'pmd', kind: 'local', url: null, entries: resolved.entries, archiveLabel: resolved.archiveLabel,
        candidates: pmdCandidates,
      });
      if (importResult.added > 0) {
        setNetStatus(t('net.addedToLibrary', { count: importResult.total }), false);
      } else if (importResult.total > 0) {
        setNetStatus(t('net.alreadyInLibrary', { count: importResult.total }), false);
      }

      let chosen = pmdCandidates[0];
      if (pmdCandidates.length > 1) {
        libraryPopover.close();
        chosen = await pickSongCandidate(pmdCandidates, { entries: resolved.entries, archiveLabel: resolved.archiveLabel });
        if (!chosen) {
          setNetStatus(t('net.selectionCancelled'), false);
          return;
        }
      }
      // 「曲を開く」/D&Dはそれ自体が利用者操作(ユーザージェスチャー)なので、URL経路の
      // ようにpendingUrlSongへ保持して再生ボタン待ちにはせず、従来の単体ファイルと
      // 同じくplayBytes()で即座に再生する。
      await playBytes(chosen.entry.data, chosen.displayName);
      setNetStatus(t('net.loadedReady', { name: chosen.displayName }), false);
      return;
    }

    await playBytes(resolved.bytes, resolved.fileName);
    persistLocalPmdSong(resolved.bytes, resolved.fileName);
  }

  fileInput.addEventListener('change', () => {
    openPmdFile(fileInput.files && fileInput.files[0]);
  });

  // 課題B: ドロップの受付はapp.js側(ページ全体、setupPageDropZone)に一本化した。
  // ここでは「ドロップされたファイルをどう解釈するか」だけを登録する(1件目のみ
  // 使う。複数件落とされた場合は黙って捨てず、netStatusで案内する)。
  ctx.handleDroppedFiles = (files) => {
    if (files.length > 1) {
      setNetStatus(t('net.dropMultiple', { count: files.length, name: files[0].name }), false);
    }
    openPmdFile(files[0]);
  };

  // --- 課題D: ダウンロード(MMLソース/コンパイル済み.M/asmのdb配列)。
  const downloadMenu = createDownloadMenu({
    driverKey: 'pmd',
    mmlFilename: 'pmd-mml.mml',
    compiledFilename: 'pmd-song.M',
    compiledLabel: '.M',
    asmFilename: 'pmd-song-db.asm',
    asmLabel: 'pmd_song_data',
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
  // 両方から呼ばれる共通関数)。net/(取得・書庫展開)を実際にUIへ配線する箇所
  // (2026-08-15新設、2026-08-16に「URLから開く」メニューからも合流させた)。
  // PMDは「曲を開く」「ドラッグ&ドロップ」と同じく.M/.mを常に
  // バイナリ(コンパイル済みデータ)として扱う(MMLソースのコンパイルを経由しない)。
  // 読み込むだけで自動再生はしない(AudioContextはユーザー操作を要求するため。
  // 「リングは進むが無音」という紛らわしい状態を避ける)ので、ここでは
  // pendingUrlSong に保持するだけに留め、再生は既存のbtnPlayPauseクリックへ委ねる。
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
      const pmdCandidates = resolved.candidates.filter((c) => c.driver === 'pmd');
      if (pmdCandidates.length === 0) {
        const otherCount = resolved.candidates.length;
        setNetStatus(
          otherCount > 0
            ? t('net.noPmdCandidatesOther', { otherCount })
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
        driver: 'pmd', url, entries: resolved.entries, archiveLabel: resolved.archiveLabel, candidates: pmdCandidates,
      });
      if (importResult.added > 0) {
        setNetStatus(t('net.addedToLibrary', { count: importResult.total }), false);
      } else if (importResult.total > 0) {
        setNetStatus(t('net.alreadyInLibrary', { count: importResult.total }), false);
      }

      let chosen = pmdCandidates[0];
      if (pmdCandidates.length > 1) {
        // 逆方向: 書庫選択モーダルを開く時点でライブラリが開いていたら閉じる。
        // 全画面オーバーレイ(z-index高)が上に乗るだけだとライブラリの半透明の
        // 背景越しに透けて重なって見える不具合そのものなので、同じ「後から
        // 開く方を優先する」考え方をここでも揃える。
        libraryPopover.close();
        // 修正3: 選択画面にも曲ライブラリと同じ曲名/アルバム名を出す(net-load.js
        // describeSongCandidate()参照)。entries/archiveLabelを渡さないとファイル名の
        // ままになる(PMDの書庫はLIST_*.txtを持たないのが普通なので、その場合は
        // ファイル名のままで正常)。
        chosen = await pickSongCandidate(pmdCandidates, { entries: resolved.entries, archiveLabel: resolved.archiveLabel });
        if (!chosen) {
          setNetStatus(t('net.selectionCancelled'), false);
          return;
        }
      }
      // pendingUrlSongは.M/.mバイナリの直接再生(プレイヤーモードの仕組み)を前提にしている。
      // エディタモードのままだと、上のupdateTransportButtonUI()分岐(uiMode!=='editor'限定)が
      // 効かず再生ボタンが有効化されないため、読み込み時にプレイヤーモードへ切り替える
      // (「曲を開く」ボタンでの読み込みと同じ扱いにする)。
      if (uiMode === 'editor') setUiMode('player');
      pendingUrlSong = { bytes: chosen.entry.data, name: chosen.displayName };
      currentSongName = chosen.displayName;
      setNetStatus(t('net.loadedReady', { name: chosen.displayName }), false);
      updateTransportButtonUI();
      reflectLoadedUrlInAddressBar(url);
      return;
    }

    if (uiMode === 'editor') setUiMode('player');
    // 課題B: nameは仮想FS書き込み用にそのまま(#titleへのフォールバックを含みうる
    // 表示名)残し、FILEBARにはfileNameForBar(=fileName、ファイル名専用)を渡す
    // (playBytes()のfileNameForBar引数参照)。ツールバーの「読み込みました」は
    // 従来どおり曲名(タイトル)を優先するresolved.nameのまま(役割が違ってよい)。
    pendingUrlSong = { bytes: resolved.bytes, name: resolved.name, fileName: resolved.fileName };
    currentSongName = resolved.fileName;
    setNetStatus(t('net.loadedReady', { name: resolved.name }), false);
    updateTransportButtonUI();
    reflectLoadedUrlInAddressBar(url);
    // 自動取り込み: 単体ファイルURLも同様にライブラリへ残す(書庫ではないためアルバム
    // 情報は持たない=「個別ファイル」グループに入る。net/library.js groupSongsIntoAlbums()参照)。
    persistSongToLibrary({
      driver: 'pmd',
      bytes: resolved.bytes,
      fileName: resolved.fileName ?? urlBaseName(url),
      origin: { kind: 'url', url, archiveName: null, groupPath: null, entryPath: null },
    });
  }

  // 課題E: ?mml=の指定も下書きも無い初見時は、同梱サンプル(エリーゼのために)を
  // 読み込んだ状態にしておく(自動再生はしない)。AudioContextはユーザー操作を
  // 要求するため、URL指定読み込みと同じ「pendingUrlSong に置くだけ」の仕組みを使う
  // (再生は既存のbtnPlayPauseクリックへ委ねる)。並行してMMLソースも編集欄へ
  // 静かに反映しておく(dlSampleFurElise クリックハンドラのプレイヤーモード分岐と
  // 同じ考え方。エディタへ切り替えても空に見えないようにする)。
  // 下書きがあるときは絶対に上書きしない(hasDraftで分岐)。
  async function loadDefaultSample() {
    const [mResponse, mmlResponse] = await Promise.all([
      fetch('./sample_fur_elise.M'),
      fetch('./sample_fur_elise.mml'),
    ]);
    const buffer = await mResponse.arrayBuffer();
    const text = await mmlResponse.text();
    mmlTextarea.value = text;
    mmlEditorApi.render();
    mmlDirty = false;
    pendingUrlSong = { bytes: new Uint8Array(buffer), name: 'sample_fur_elise.M' };
    currentSongName = 'sample_fur_elise.M';
    updateTransportButtonUI();
  }

  if (ctx.songUrl) {
    loadSongFromUrl(ctx.songUrl);
  } else if (!hasDraft) {
    loadDefaultSample();
  }
}
