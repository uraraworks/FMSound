#include <emscripten.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "common/fmplayer_file.h"
#include "fft/fft.h"
#include "fmdriver/fmdriver.h"
#include "fmdriver/fmdriver_pmd.h"  // pmd_ppc_load(): 検証専用ADPCMロードで使用
#include "fmdriver/ppz8.h"
#include "fmdsp/fmdsp-pacc.h"  // FMDSP_LEVEL_COUNT のみ利用(実装は使わない)
#include "leveldata/leveldata.h"
#include "libopna/opna.h"
#include "libopna/opnaadpcm.h"
#include "libopna/opnatimer.h"
#include "rhythm_rom.h"

enum {
  SAMPLE_RATE = 55467,
  CHANNEL_COUNT = 2,
  FRAMES_PER_BLOCK = 2048,
  TRACK_COUNT = FMDRIVER_TRACK_NUM,
  FIELD_COUNT = 26,
  SNAPSHOT_RING_SIZE = 2048,
  PPZ8_MIX_VOLUME = 0xa000,
  LEVEL_COUNT = FMDSP_LEVEL_COUNT,  // 19 (fmdsp-pacc.h)
  FFT_BIN_COUNT = FFTDISPLEN,       // 70 (fft/fft.h)
  // FFT_BIN_COUNT の後ろに続く flat_level_status 配列を4byte境界に
  // 揃えるための明示パディング(70 -> 72)。暗黙のコンパイラpaddingに
  // 頼らず _Static_assert で検査できるようにする。
  FFT_BIN_COUNT_PADDED = 72,
  LEVEL_FIELD_COUNT = 5,  // level, pan, prog, key, playing
};

#define INVALID_WRITE_INDEX UINT32_MAX

struct flat_track_status {
  int32_t playing, info, ticks, ticks_left, key, actual_key;
  int32_t tonenum, volume, gate, detune;
  int32_t status[9];
  int32_t fmslotmask[4];
  int32_t ppz8_ch, ssg_tone, ssg_noise;
};

// FMDSP 右半分レベルメーター用の1チャンネル分。
// 出典: upstream/98fmplayer/fmdsp/fmdsp-pacc.c:1660-1733 の levels[] 構築ロジック。
struct flat_level_status {
  int32_t level;    // leveldata_read() の値(0が無音、大きいほど大)
  int32_t pan;       // 定位。fmdsp-pacc.cのtable[]をそのまま使用(意味は未確認、出典どおりの値のみ保証)
  int32_t prog;      // track_status[].tonenum
  int32_t key;        // track_status[].key
  int32_t playing;    // track_status[].playing (PDZF/PPZ8のinfoでは強制0。出典どおり)
};

// frame に続くカウンタ群。fmdriver_work(upstream/98fmplayer/fmdriver/fmdriver.h)
// 由来で、いずれも「取れる」ことを確認済み(docs/right-pane-data.md §7参照)。
// mucomweb/src/MucomWeb.cpp の StatusSnapshot(frame+passTick/intCount/maxCount)
// と同じ「frameに続くヘッダ」の作法を踏襲する。PMD側はMUCOMのpassTick相当
// (経過時間の元データ)が不要: frame自体が既にopna.generated_frames(55467Hz
// 換算のサンプル数)であり、fmdsp-pacc.cのpassed time計算(update_default(),
// :1502)が使う値と同一。よってヘッダはtimerb系4項目のみで足りる。
// - work->timerb_cnt: CLOCK COUNT表示・回転円(drawCircle)の元データ
// - work->timerb: TIMER B CYCLE表示の元データ(0-255、uint8_tを素直にint32へ拡張)
// - work->loop_cnt: LOOP COUNT表示の元データ(0-255)
// - work->timerb_cnt_loop / work->loop_timerb_cnt: ループ進捗バー(drawLoopBar)の分子/分母
// - work->playing: 課題B(ループしない曲の再生終了検出)用。upstream/98fmplayer/
//   fmdriver/fmdriver_pmd.c:5692 (pmd_update_note_meas) で
//   「ループ点が無い(pmd->loop.looped===false)まま曲末尾に到達した」ときだけ
//   falseになる(ループする曲はloop.loopedがtrueのままなので、ここは常にtrueで
//   落ちてこない=誤発火しない)。JS側(pmd-app.js)はこれがtrue->falseへ変わった
//   瞬間を「曲が終わった」の唯一のトリガーとして使う。
struct status_snapshot {
  uint32_t frame;
  uint32_t timerb_cnt;
  uint32_t timerb;
  uint32_t loop_cnt;
  uint32_t timerb_cnt_loop;
  uint32_t loop_timerb_cnt;
  uint32_t driver_playing;
  struct flat_track_status tracks[TRACK_COUNT];
  uint8_t fft[FFT_BIN_COUNT_PADDED];  // [0..FFT_BIN_COUNT) が有効値(0-31)。末尾2byteは常に0の明示パディング
  struct flat_level_status levels[LEVEL_COUNT];
};

// frame を含む、frameに続くヘッダのワード数。JS側がハードコードせずに済むよう
// pmdweb_get_snapshot_header_word_count() で export する
// (mucomweb の getSnapshotHeaderWordCount() と同じ命名)。
enum { SNAPSHOT_HEADER_WORD_COUNT = 7 };  // frame, timerb_cnt, timerb, loop_cnt, timerb_cnt_loop, loop_timerb_cnt, driver_playing

_Static_assert(TRACK_COUNT == 21, "98fmplayer track count changed");
_Static_assert(LEVEL_COUNT == 19, "FMDSP_LEVEL_COUNT changed");
_Static_assert(FFT_BIN_COUNT == 70, "FFTDISPLEN changed");
_Static_assert(sizeof(struct flat_track_status) == FIELD_COUNT * sizeof(int32_t),
               "field layout changed");
_Static_assert(sizeof(struct flat_level_status) == LEVEL_FIELD_COUNT * sizeof(int32_t),
               "level field layout changed");
_Static_assert(sizeof(struct status_snapshot) ==
               SNAPSHOT_HEADER_WORD_COUNT * sizeof(uint32_t) +
               TRACK_COUNT * sizeof(struct flat_track_status) +
               FFT_BIN_COUNT_PADDED +
               LEVEL_COUNT * sizeof(struct flat_level_status),
               "entry layout changed");

static struct {
  struct opna opna;
  struct opna_timer timer;
  struct fmdriver_work work;
  struct ppz8 ppz8;
  uint8_t adpcm_ram[OPNA_ADPCM_RAM_SIZE];
  struct fmplayer_file *file;
  bool active;
  uint32_t generation;
} g_player;

static int16_t g_audio_buffer[FRAMES_PER_BLOCK * CHANNEL_COUNT];
static struct status_snapshot g_snapshot_ring[SNAPSHOT_RING_SIZE];
static uint32_t g_snapshot_write_index = INVALID_WRITE_INDEX;

// --- FFTスペクトラム(70ビン) ---
// fmplayer_fft_input_data は 8192 点分の PCM リングと作業バッファを含む
// (fft/fft.h)。8192点FFTは重いため、毎スナップショットではなく約60Hzで
// しか fft_calc() を呼ばない(元のGTK版がfmdsp_pacc_render()内で表示
// フレームごとに1回呼んでいたのに合わせた頻度。SAMPLE_RATE/60 ≒ 924
// フレームごと)。fft_write() 自体は全ブロックで呼び、リングを途切れ
// なく供給する。
static struct fmplayer_fft_input_data g_fft_input;
static struct fmplayer_fft_disp_data g_fft_disp;  // 最後に計算した70ビン(0-31)のキャッシュ
static uint64_t g_fft_last_calc_frame;
static bool g_fft_table_ready;
enum { FFT_CALC_INTERVAL_FRAMES = SAMPLE_RATE / 60 };

static void fft_feed(const int16_t *buf, unsigned frames) {
  fft_write(&g_fft_input.fdata, buf, frames);
  uint64_t now = g_player.opna.generated_frames;
  if (now - g_fft_last_calc_frame >= FFT_CALC_INTERVAL_FRAMES) {
    fft_calc(&g_fft_disp, &g_fft_input);
    g_fft_last_calc_frame = now;
  }
}

// --- レベルメーター(19ch) ---
// 出典: upstream/98fmplayer/fmdsp/fmdsp-pacc.c:1660-1733 の levels[] 構築を
// そのまま踏襲する。並び順は FM1-6, SSG1-3, リズム(6音の最大値),
// ADPCM, PPZ8 1-8 の19ch。
static void build_levels(struct flat_level_status *out) {
  struct {
    unsigned level;
    int t;  // FMDRIVER_TRACK_* (track_status索引)
    int pan;
  } levels[LEVEL_COUNT] = {0};

  for (int c = 0; c < 6; c++) {
    levels[c].level = leveldata_read(&g_player.opna.fm.channel[c].leveldata);
    static const int table[4] = {5, 4, 0, 2};
    levels[c].pan = table[g_player.opna.fm.lselect[c] * 2 + g_player.opna.fm.rselect[c]];
  }
  levels[0].t = FMDRIVER_TRACK_FM_1;
  levels[1].t = FMDRIVER_TRACK_FM_2;
  levels[2].t = FMDRIVER_TRACK_FM_3;
  levels[3].t = FMDRIVER_TRACK_FM_4;
  levels[4].t = FMDRIVER_TRACK_FM_5;
  levels[5].t = FMDRIVER_TRACK_FM_6;

  for (int c = 0; c < 3; c++) {
    levels[6 + c].level = leveldata_read(&g_player.opna.resampler.leveldata[c]);
    levels[6 + c].t = FMDRIVER_TRACK_SSG_1 + c;
    levels[6 + c].pan = 2;
  }
  {
    // リズム(index 9): 6音の最大値をレベルとして採用。
    // t は明示的に設定しない(=0=FMDRIVER_TRACK_FM_1のまま)。これは
    // 出典 fmdsp-pacc.c も同様で、リズムパートには専用の track_status
    // が無いため、prog/key/playing は FM1 のものがそのまま流用される
    // (バグではなく上流の実装を忠実に再現した結果。値の意味としては
    // リズムのprog/key/playingは信頼できないので注意)。
    unsigned dl = 0;
    for (int d = 0; d < 6; d++) {
      unsigned l = leveldata_read(&g_player.opna.drum.drums[d].leveldata);
      if (l > dl) dl = l;
    }
    levels[9].level = dl;
    levels[9].pan = 2;
  }
  levels[10].level = leveldata_read(&g_player.opna.adpcm.leveldata);
  levels[10].t = FMDRIVER_TRACK_ADPCM;
  {
    static const int table[4] = {5, 4, 0, 2};
    int ind = 0;
    if (g_player.opna.adpcm.control2 & 0x80) ind |= 2;
    if (g_player.opna.adpcm.control2 & 0x40) ind |= 1;
    levels[10].pan = table[ind];
  }
  for (int p = 0; p < 8; p++) {
    levels[11 + p].pan = 5;
    levels[11 + p].t = FMDRIVER_TRACK_PPZ8_1 + p;
  }
  if (g_player.work.ppz8) {
    for (int p = 0; p < 8; p++) {
      levels[11 + p].level = leveldata_read(&g_player.work.ppz8->channel[p].leveldata);
      static const int table[10] = {5, 0, 1, 1, 1, 2, 3, 3, 3, 4};
      levels[11 + p].pan = table[g_player.work.ppz8->channel[p].pan];
    }
  }

  for (int c = 0; c < LEVEL_COUNT; c++) {
    bool playing = g_player.work.track_status[levels[c].t].playing;
    if (g_player.work.track_status[levels[c].t].info == FMDRIVER_TRACK_INFO_PDZF ||
        g_player.work.track_status[levels[c].t].info == FMDRIVER_TRACK_INFO_PPZ8) {
      playing = false;
    }
    if (!playing) levels[c].pan = 5;
    out[c].level = (int32_t)levels[c].level;
    out[c].pan = (int32_t)levels[c].pan;
    out[c].prog = (int32_t)g_player.work.track_status[levels[c].t].tonenum;
    out[c].key = (int32_t)g_player.work.track_status[levels[c].t].key;
    out[c].playing = playing ? 1 : 0;
  }
}

EM_JS(void, audio_worklet_play, (int sample_rate, uint32_t generation), {
  const state = globalThis.pmdAudioState ||= {
    context: null, node: null, workletReady: null, generation: 0, playback: null,
    stats: { requestedFrames: 0, renderedFrames: 0, queuedFrames: 0, underflowFrames: 0 }
  };
  state.generation = generation;
  state.playback = null;
  state.stats = { requestedFrames: 0, renderedFrames: 0, queuedFrames: 0, underflowFrames: 0 };
  (async () => {
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) return;
    if (state.node) {
      state.node.port.postMessage({ type: 'stop' });
      state.node.disconnect();
      state.node = null;
    }
    if (state.context && state.context.sampleRate !== sample_rate) {
      await state.context.close();
      state.context = null;
      state.workletReady = null;
    }
    if (!state.context) {
      state.context = new AudioContextClass({ sampleRate: sample_rate });
      state.workletReady = state.context.audioWorklet.addModule('./pmd-worklet.js');
    }
    await state.workletReady;
    if (state.generation !== generation) return;
    const actualRate = state.context.sampleRate;
    const targetChunks = Math.max(1, Math.round(actualRate * 0.075 / 2048));
    const targetFrames = targetChunks * 2048;
    const lowWaterFrames = Math.min(2048,
      Math.max(128, Math.round(actualRate * 0.04 / 128) * 128));
    const node = new AudioWorkletNode(state.context, 'pmd-stream-processor', {
      outputChannelCount: [2]
    });
    state.node = node;
    node.port.onmessage = (event) => {
      const message = event.data;
      if (state.generation !== generation || state.node !== node) return;
      if (message.type === 'need') {
        state.stats.requestedFrames += message.frames;
        Module.audioWorkletRequest(message.frames, generation, message.requestId);
      } else if (message.type === 'stats') {
        state.stats.queuedFrames = message.queuedFrames;
        state.stats.underflowFrames = message.underflowFrames;
      } else if (message.type === 'playback') {
        state.playback = { playFrame: message.playFrame, contextTime: message.contextTime };
      }
    };
    node.port.postMessage({ type: 'start', generation, targetFrames, lowWaterFrames });
    node.connect(state.context.destination);
    await state.context.resume();
  })().catch((error) => console.error('AudioWorklet initialization failed:', error));
});

EM_JS(void, audio_worklet_stop, (uint32_t generation), {
  const state = globalThis.pmdAudioState;
  if (!state) return;
  state.generation = generation;
  state.playback = null;
  if (state.node) {
    state.node.port.postMessage({ type: 'stop' });
    state.node.disconnect();
    state.node = null;
  }
});

EM_JS(void, audio_worklet_submit,
      (const int16_t *samples, int frames, uint32_t generation, uint32_t request_id,
       int final_for_request), {
  const state = globalThis.pmdAudioState;
  if (!state || !state.node || state.generation !== generation) return;
  const sampleCount = frames * 2;
  const chunk = new Int16Array(sampleCount);
  chunk.set(HEAP16.subarray(samples >> 1, (samples >> 1) + sampleCount));
  state.stats.renderedFrames += frames;
  state.node.port.postMessage({
    type: 'chunk', generation, frames, requestId: request_id,
    finalForRequest: !!final_for_request, samples: chunk.buffer
  }, [chunk.buffer]);
});

static struct flat_track_status flatten(const struct fmdriver_track_status *source) {
  struct flat_track_status target = {0};
  target.playing = source->playing;
  target.info = source->info;
  target.ticks = source->ticks;
  target.ticks_left = source->ticks_left;
  target.key = source->key;
  target.actual_key = source->actual_key;
  target.tonenum = source->tonenum;
  target.volume = source->volume;
  target.gate = source->gate;
  target.detune = source->detune;
  for (int i = 0; i < 9; ++i) target.status[i] = (uint8_t)source->status[i];
  for (int i = 0; i < 4; ++i) target.fmslotmask[i] = source->fmslotmask[i];
  target.ppz8_ch = source->ppz8_ch;
  target.ssg_tone = source->ssg_tone;
  target.ssg_noise = source->ssg_noise;
  return target;
}

static void invalidate_snapshot_ring(void) { g_snapshot_write_index = INVALID_WRITE_INDEX; }

static void activate_snapshot_ring(void) {
  memset(g_snapshot_ring, 0, sizeof(g_snapshot_ring));
  g_snapshot_write_index = 0;
}

static void push_snapshot(void) {
  if (g_snapshot_write_index == INVALID_WRITE_INDEX) return;
  uint32_t frame = (uint32_t)g_player.opna.generated_frames;
  bool same_frame = g_snapshot_write_index > 0 &&
      g_snapshot_ring[(g_snapshot_write_index - 1) & (SNAPSHOT_RING_SIZE - 1)].frame == frame;
  uint32_t logical_index = same_frame ? g_snapshot_write_index - 1 : g_snapshot_write_index;
  struct status_snapshot *snapshot =
      &g_snapshot_ring[logical_index & (SNAPSHOT_RING_SIZE - 1)];
  snapshot->frame = frame;
  snapshot->timerb_cnt = g_player.work.timerb_cnt;
  snapshot->timerb = g_player.work.timerb;
  snapshot->loop_cnt = g_player.work.loop_cnt;
  snapshot->timerb_cnt_loop = g_player.work.timerb_cnt_loop;
  snapshot->loop_timerb_cnt = g_player.work.loop_timerb_cnt;
  snapshot->driver_playing = g_player.work.playing ? 1 : 0;
  for (int track = 0; track < TRACK_COUNT; ++track) {
    snapshot->tracks[track] = flatten(&g_player.work.track_status[track]);
  }
  memcpy(snapshot->fft, g_fft_disp.buf, FFT_BIN_COUNT);
  memset(snapshot->fft + FFT_BIN_COUNT, 0, FFT_BIN_COUNT_PADDED - FFT_BIN_COUNT);
  build_levels(snapshot->levels);
  if (!same_frame) ++g_snapshot_write_index;
}

static void opna_write_register(struct fmdriver_work *work, unsigned address, unsigned data) {
  opna_timer_writereg(work->opna, address, data);
}

static unsigned opna_read_register(struct fmdriver_work *work, unsigned address) {
  struct opna_timer *timer = work->opna;
  return opna_readreg(timer->opna, address);
}

static uint8_t opna_status(struct fmdriver_work *work, bool a1) {
  uint8_t status = opna_timer_status(work->opna);
  return a1 ? status : status & 0x83;
}

static void driver_interrupt(void *unused) {
  (void)unused;
  if (!g_player.active || !g_player.work.driver_opna_interrupt) return;
  g_player.work.driver_opna_interrupt(&g_player.work);
  push_snapshot();
}

static void mix_ppz8(void *user, int16_t *buffer, unsigned frames) {
  ppz8_mix(user, buffer, frames);
}

static void initialize_synth(void) {
  opna_reset(&g_player.opna);
  /* リズムROM(rhythm_rom.c, 2026-08-18): 実機ROMは未使用。
   * html/rhythm/2608_*.WAV(自作波形、出自はNOTICE.md参照)を
   * tools/gen_rhythm_rom.py がopnadrum.cのADPCM-A復号アルゴリズムの
   * 逆写像でエンコードしたもの。opna_reset() は内部で opna_drum_reset()
   * を呼び drums[].data を null に戻すため、set_rom は必ず reset の後に
   * 呼ぶこと(順序を逆にすると無音のまま build/testを通過する)。
   * MUCOM側はこのROMを共有せずWAVを直接読む別実装。 */
  opna_drum_set_rom(&g_player.opna.drum, (void *)rhythm_rom);
  opna_adpcm_set_ram_256k(&g_player.opna.adpcm, g_player.adpcm_ram);
  opna_timer_reset(&g_player.timer, &g_player.opna);
  ppz8_init(&g_player.ppz8, SAMPLE_RATE, PPZ8_MIX_VOLUME);
  memset(&g_player.work, 0, sizeof(g_player.work));
  if (!g_fft_table_ready) {
    fft_init_table();
    g_fft_table_ready = true;
  }
  memset(&g_fft_input, 0, sizeof(g_fft_input));
  memset(&g_fft_disp, 0, sizeof(g_fft_disp));
  g_fft_last_calc_frame = 0;
  g_player.work.opna_writereg = opna_write_register;
  g_player.work.opna_readreg = opna_read_register;
  g_player.work.opna_status = opna_status;
  g_player.work.opna = &g_player.timer;
  g_player.work.ppz8 = &g_player.ppz8;
  g_player.work.ppz8_functbl = &ppz8_functbl;
  opna_timer_set_int_callback(&g_player.timer, driver_interrupt, 0);
  opna_timer_set_mix_callback(&g_player.timer, mix_ppz8, &g_player.ppz8);
}

void pmdweb_stop_music(void) {
  ++g_player.generation;
  g_player.active = false;
  audio_worklet_stop(g_player.generation);
  if (g_player.work.driver_deinit) g_player.work.driver_deinit(&g_player.work);
  memset(&g_player.work, 0, sizeof(g_player.work));
  fmplayer_file_free(g_player.file);
  g_player.file = 0;
  invalidate_snapshot_ring();
}

const char *pmdweb_play_music(const char *path) {
  enum fmplayer_file_error error = FMPLAYER_FILE_ERR_OK;
  pmdweb_stop_music();
  g_player.file = fmplayer_file_alloc(path, &error);
  if (!g_player.file) return fmplayer_file_strerror(error);
  if (g_player.file->type != FMPLAYER_FILE_TYPE_PMD) {
    fmplayer_file_free(g_player.file);
    g_player.file = 0;
    return "The file is not PMD data";
  }
  initialize_synth();
  fmplayer_file_load(&g_player.work, g_player.file, 1);
  g_player.active = true;
  activate_snapshot_ring();
  audio_worklet_play(SAMPLE_RATE, g_player.generation);
  return "";
}

static void render_frames(int frames, uint32_t request_id, bool submit, bool final_for_request) {
  while (frames > 0 && g_player.active) {
    int count = frames > FRAMES_PER_BLOCK ? FRAMES_PER_BLOCK : frames;
    memset(g_audio_buffer, 0, count * CHANNEL_COUNT * sizeof(*g_audio_buffer));
    opna_timer_mix(&g_player.timer, g_audio_buffer, count);
    fft_feed(g_audio_buffer, count);
    if (submit) {
      audio_worklet_submit(g_audio_buffer, count, g_player.generation, request_id,
                           final_for_request && count == frames);
    }
    frames -= count;
  }
}

void pmdweb_audio_worklet_request(int requested_frames, uint32_t generation,
                                  uint32_t request_id) {
  if (!g_player.active || generation != g_player.generation || requested_frames <= 0) return;
  int block_count = (requested_frames + FRAMES_PER_BLOCK - 1) / FRAMES_PER_BLOCK;
  for (int block = 0; block < block_count; ++block) {
    render_frames(FRAMES_PER_BLOCK, request_id, true, block + 1 == block_count);
  }
}

double pmdweb_render_frames_for_test(int frames) {
  double absolute_sum = 0;
  if (!g_player.active || frames <= 0) return 0;
  while (frames > 0) {
    int count = frames > FRAMES_PER_BLOCK ? FRAMES_PER_BLOCK : frames;
    memset(g_audio_buffer, 0, count * CHANNEL_COUNT * sizeof(*g_audio_buffer));
    opna_timer_mix(&g_player.timer, g_audio_buffer, count);
    fft_feed(g_audio_buffer, count);
    for (int i = 0; i < count * CHANNEL_COUNT; ++i) {
      int sample = g_audio_buffer[i];
      absolute_sum += sample < 0 ? -sample : sample;
    }
    frames -= count;
  }
  return absolute_sum;
}

uint32_t pmdweb_get_snapshot_ring_pointer(void) {
  return (uint32_t)(uintptr_t)g_snapshot_ring;
}
uint32_t pmdweb_get_snapshot_entry_byte_size(void) { return sizeof(struct status_snapshot); }
uint32_t pmdweb_get_snapshot_write_index(void) { return g_snapshot_write_index; }
uint32_t pmdweb_get_snapshot_header_word_count(void) { return SNAPSHOT_HEADER_WORD_COUNT; }
int pmdweb_get_track_count(void) { return TRACK_COUNT; }
int pmdweb_get_field_count(void) { return FIELD_COUNT; }
int pmdweb_get_sample_rate(void) { return SAMPLE_RATE; }

// --- FMDSP右半分(FFT/レベルメーター)用のバイトオフセット・個数 ---
// レイアウトの正本は docs/right-pane-data.md 参照。
uint32_t pmdweb_get_snapshot_fft_offset(void) { return (uint32_t)offsetof(struct status_snapshot, fft); }
uint32_t pmdweb_get_snapshot_level_offset(void) { return (uint32_t)offsetof(struct status_snapshot, levels); }
int pmdweb_get_fft_bin_count(void) { return FFT_BIN_COUNT; }
int pmdweb_get_level_count(void) { return LEVEL_COUNT; }
int pmdweb_get_level_field_count(void) { return LEVEL_FIELD_COUNT; }

// --- FMDSPトラック行クリックミュート機能(fmdsp/trackrow.js、fmdsp/channel-mask.js参照) ---
// opna_set_mask()(libopna/opna.h:54, opna.c:63-66)をそのまま叩く。
// ビット割り当てはMUCOM88(fmgen OPNABase::SetChannelMask)と異なる
// (LIBOPNA_CHAN_*, libopna/opna.h:14-30: DRUM_BD..RIMがbit9-14の6bit、
// ADPCMがbit15=0x8000)。fmdsp/channel-mask.jsのbuildPmdChannelMask()が
// このビット割り当てで組み立てる。JS側は絶対にMUCOM用マスク値をここへ渡さないこと。
void pmdweb_set_channel_mask(unsigned mask) {
  opna_set_mask(&g_player.opna, mask);
}

// 検証専用(tools/verify_pmd_channel_mute.mjs)。opna_set_mask()のADPCMビット
// (bit15)が本当にADPCMチャンネルだけを消しているかを実測するには、無音でない
// ADPCM再生が要る。しかし本Web版はPPC/PVIファイルの読み込みをUIから一切
// サポートしていない(ADPCM RAMは常にゼロ初期化のまま)ため、検証スクリプトが
// PPC形式(pmd_ppc_load(), fmdriver/fmdriver_pmd.c:6076、"ADPCM DATA for  PMD
// ver.4.4-  "ヘッダ+256エントリのstart/stopアドレス表+生ADPCMデータ)の
// バイト列をMEMFS経由で読み込み、g_player.workへロードできるようにする。
// 製品UI(html/pmd-app.js)からは呼ばれない。
int pmdweb_test_load_ppc_file(const char *path) {
  if (!g_player.active) return 0;
  FILE *f = fopen(path, "rb");
  if (!f) return 0;
  fseek(f, 0, SEEK_END);
  long size = ftell(f);
  fseek(f, 0, SEEK_SET);
  if (size <= 0) {
    fclose(f);
    return 0;
  }
  uint8_t *buf = (uint8_t *)malloc((size_t)size);
  if (!buf) {
    fclose(f);
    return 0;
  }
  size_t read_bytes = fread(buf, 1, (size_t)size, f);
  fclose(f);
  bool ok = pmd_ppc_load(&g_player.work, buf, read_bytes);
  free(buf);
  return ok ? 1 : 0;
}

// 検証専用(tools/verify_pmd_rhythm.mjs)。opna_writereg()(libopna/opna.c)を
// フロントエンド(pmd_cmdxx系のドライバコマンド)を経由せず直接叩く。リズム音源
// (opna_drum_writereg, libopna/opnadrum.c)のレジスタ0x10(キーオン/オフ、
// bit0-5=BD/SD/TOP/HH/TOM/RIM, bit7=1でオフ)・0x11(total level)・
// 0x18-0x1d(各音のパン/レベル、bit7=left,bit6=right,bit0-4=level)を
// 直接叩いて6音を個別に鳴らし分けるために使う。製品UIからは呼ばれない。
void pmdweb_test_write_opna_reg(unsigned reg, unsigned val) {
  opna_writereg(&g_player.opna, reg, val);
}

// 検証専用(tools/verify_pmd_rhythm.mjs 陽性対照)。opna_drum_reset()だけを
// 呼び直し、opna_drum_set_rom()を呼ばない状態(=結線前のPmdCore.cが実際に
// 置かれていた状態。drums[].dataがnullのまま)を再現する。initialize_synth()
// が呼ぶopna_reset()の直後の状態そのもの。
void pmdweb_test_reset_drum_no_rom(void) {
  opna_drum_reset(&g_player.opna.drum);
}

// --- コメント欄(曲名・作曲者・編曲者・メモ) ---
// fmdriver.h:94-109 の get_comment()/comment_mode_pmd を export する。
// CP932バイト列をそのまま渡す必要があり(font_putline側でSJIS→JISへ変換する
// ため)、embind の std::string で返すとJS側がUTF-8として誤解釈して壊れる
// (PmdWeb.cpp参照)。そのため「静的バッファへコピー→ポインタとバイト長を
// 別々に返す」形にする。行が存在しない場合は長さ0を返す(get_comment()が
// NULLを返すケース。fmdriver.h:109のコメント通り)。
enum { COMMENT_BUF_SIZE = 1024 };
static uint8_t g_comment_buf[COMMENT_BUF_SIZE];

int pmdweb_get_comment_mode_pmd(void) {
  return g_player.work.comment_mode_pmd ? 1 : 0;
}

// 指定行のCP932バイト列を g_comment_buf にコピーし、バイト長を返す。
// 曲がロードされていない/get_comment未設定/該当行が無い場合は0。
int pmdweb_get_comment_length(int line) {
  if (!g_player.active || !g_player.work.get_comment) return 0;
  const char *str = g_player.work.get_comment(&g_player.work, line);
  if (!str) return 0;
  int len = 0;
  while (str[len] != 0 && len < (COMMENT_BUF_SIZE - 1)) ++len;
  memcpy(g_comment_buf, str, (size_t)len);
  return len;
}

uint32_t pmdweb_get_comment_pointer(void) {
  return (uint32_t)(uintptr_t)g_comment_buf;
}

// --- PCM(.PPC/.PZI/.PVI/.P86/.PPS)状態 ---
// fmdriver.h の pcmtype/pcmname/pcmerror を export する。コメント欄と違い
// 中身は常にASCII(ドライバ名・ファイル名は7bit文字のみ)なので、CP932考慮の
// 「ポインタ+バイト長」方式にする必要はなく、embind の std::string でそのまま
// 返してよい(PmdWeb.cpp側もstd::stringにしている)。
int pmdweb_get_pcm_count(void) {
  return FMDRIVER_PCMCOUNT;
}

// 範囲外・曲未ロード時は空文字を返す(該当スロットなし扱い)。
const char *pmdweb_get_pcm_name(int i) {
  if (!g_player.active || i < 0 || i >= FMDRIVER_PCMCOUNT) return "";
  return g_player.work.pcmname[i];
}

const char *pmdweb_get_pcm_type(int i) {
  if (!g_player.active || i < 0 || i >= FMDRIVER_PCMCOUNT) return "";
  return g_player.work.pcmtype[i];
}

int pmdweb_get_pcm_error(int i) {
  if (!g_player.active || i < 0 || i >= FMDRIVER_PCMCOUNT) return 0;
  return g_player.work.pcmerror[i] ? 1 : 0;
}
