// PMDエンジン固有のアプリロジック。app.js(共通シェル)から動的importされ、
// init(ctx) が呼ばれる。
//
// 旧 pmdweb/html/index.html(素のプレイヤー、独自のtable/controlsマークアップ)を
// mucomweb/html/index.html(完成済みUI)と同じ構成
// (.console-card+.console-footer/再生一時停止トグル/停止/曲を開く/設定/フルスクリーン/
// ?debug=1限定のデバッグ表示)へ展開したもの。エディタモードは今回のスコープ外
// (コンパイラと一緒に別タスクで追加する)なので、MUCOM88側にあるエディタモード
// 切替ボタン・MMLテキスト編集UIはここには無い。
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
import { ICONS, svgIcon } from './ui/icons.js';

export async function init(ctx) {
  const {
    canvas, consoleCard,
    btnPlayPause, btnStop, btnOpenFile,
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
  // 詳細はNOTICE.md参照)を同梱する。
  sampleLinksEl.innerHTML =
    '<a href="javascript:void(0);" id="dlSampleFurElise">sample_fur_elise.M(エリーゼのために・冒頭)</a>' +
    '　「曲を開く」から手元の.M/.mファイルを選ぶこともできます。';
  document.getElementById('dlSampleFurElise').addEventListener('click', async () => {
    const response = await fetch('./sample_fur_elise.M');
    const buffer = await response.arrayBuffer();
    await playBytes(new Uint8Array(buffer), 'sample_fur_elise.M');
  });

  // --- コメント欄(曲名・作曲者・編曲者・メモ)のスクロール操作。エディタは無いが
  // これは実際に使うプレイヤー機能のため、editor-pane相当の領域を流用して常時表示する
  // (MUCOM88と違いモード切替に紐付かない、hiddenを外したままにする)。
  enginePaneEl.classList.remove('hidden');
  enginePaneEl.innerHTML = `
    <div class="pmd-comment-controls">
      <button id="commentPrev" type="button">&uarr; コメント</button>
      <button id="commentNext" type="button">&darr; コメント</button>
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

  rescale();
  requestAnimationFrame(rescale);

  const Module = await createPmdWeb();
  let moduleReady = true;

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
  document.getElementById('commentPrev').addEventListener('click', () => {
    const modePmd = Module.getCommentModePmd() !== 0;
    commentOffset = commentScroll(commentOffset, false, modePmd, commentBytesFor);
  });
  document.getElementById('commentNext').addEventListener('click', () => {
    const modePmd = Module.getCommentModePmd() !== 0;
    commentOffset = commentScroll(commentOffset, true, modePmd, commentBytesFor);
  });

  const ringSize = 2048;
  const invalidIndex = 0xffffffff;
  const trackCount = Module.getTrackCount();
  const fieldCount = Module.getFieldCount();
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
    const entryTracks = [];
    for (let track = 0; track < trackCount; ++track) {
      const data = entry.subarray(1 + track * fieldCount, 1 + (track + 1) * fieldCount);
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
      drawComment(vram, commentSmallFont, fmdspFont, commentBytesFor, modePmd, commentOffset);

      const audioState = globalThis.pmdAudioState;
      const hasPlayback = Boolean(audioState?.playback);
      const paused = Boolean(audioState?.paused);
      const rightPanePlaying = hasPlayback && !paused;
      rightPaneFrameCounter = (rightPaneFrameCounter + 1) & 0xffffffff;
      // PASSED TIME/CLOCK COUNT/TIMER B CYCLE/LOOP COUNT/CPU/FPSの元データには
      // 対応するwasm exportが存在しない(pmdweb/src/PmdWeb.cpp参照)。でっち上げず
      // 取れない値は0/falseのまま渡す(旧pmdweb/html/index.htmlと同じ方針)。
      rightpane.drawDynamic(vram, {
        generatedFrames: 0n,
        timerbCnt: 0,
        timerb: 0,
        loopCnt: 0,
        cpuUsage: 0,
        fps: 0,
        timerbCntLoop: 0,
        loopTimerbCnt: 0,
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

  // --- トランスポート(再生/一時停止/停止)。MMLコンパイルが無いぶんMUCOM88より単純:
  // 「曲を開く」で読み込み即再生、btnPlayPauseは既にロード済みの曲の一時停止/再開専用。
  let pausedFrameDrawn = false;
  let stoppedFrameDrawn = false;

  function updateTransportButtonUI() {
    const audioState = globalThis.pmdAudioState;
    const hasPlayback = Boolean(audioState?.playback);
    const paused = Boolean(audioState?.paused);
    const playing = hasPlayback && !paused;

    btnPlayPause.disabled = !moduleReady || !hasPlayback;
    btnStop.disabled = !moduleReady || !hasPlayback;

    const icon = playing ? ICONS.pause : ICONS.play;
    const label = playing ? '一時停止' : (paused ? '再開' : '再生(曲を開いてください)');
    btnPlayPause.replaceChildren(svgIcon(icon.path ?? icon, icon.extra ?? ''));
    btnPlayPause.title = label;
    btnPlayPause.setAttribute('aria-label', label);
    btnPlayPause.classList.toggle('active', paused);
  }

  function setAudioPaused(paused) {
    const audioState = globalThis.pmdAudioState;
    if (!audioState) return;
    audioState.paused = paused;
    pausedFrameDrawn = false;
    updateTransportButtonUI();
  }

  btnPlayPause.addEventListener('click', () => {
    if (btnPlayPause.disabled) return;
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
        `snapshot: selectedFrame=${selected[0] >>> 0} writeIndex=${writeIndex}`;
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
