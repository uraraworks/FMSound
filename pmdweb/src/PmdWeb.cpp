#include <emscripten/bind.h>
#include <cstdint>
#include <string>

extern "C" {
const char *pmdweb_play_music(const char *path);
void pmdweb_stop_music(void);
void pmdweb_audio_worklet_request(int frames, uint32_t generation, uint32_t request_id);
double pmdweb_render_frames_for_test(int frames);
uint32_t pmdweb_get_snapshot_ring_pointer(void);
uint32_t pmdweb_get_snapshot_entry_byte_size(void);
uint32_t pmdweb_get_snapshot_write_index(void);
uint32_t pmdweb_get_snapshot_header_word_count(void);
int pmdweb_get_track_count(void);
int pmdweb_get_field_count(void);
int pmdweb_get_sample_rate(void);
int pmdweb_get_comment_mode_pmd(void);
int pmdweb_get_comment_length(int line);
uint32_t pmdweb_get_comment_pointer(void);
uint32_t pmdweb_get_snapshot_fft_offset(void);
uint32_t pmdweb_get_snapshot_level_offset(void);
int pmdweb_get_fft_bin_count(void);
int pmdweb_get_level_count(void);
int pmdweb_get_level_field_count(void);
void pmdweb_set_channel_mask(unsigned mask);
int pmdweb_test_load_ppc_file(const char *path);
}

namespace {
std::string PlayMusic(const std::string &path) { return pmdweb_play_music(path.c_str()); }
// 検証専用(tools/verify_pmd_channel_mute.mjs)。PmdCore.c のコメント参照。
bool TestLoadPpcFile(const std::string &path) { return pmdweb_test_load_ppc_file(path.c_str()) != 0; }
}

int main() { return 0; }

EMSCRIPTEN_BINDINGS(pmdweb) {
  emscripten::function("playMusic", &PlayMusic);
  emscripten::function("stopMusic", &pmdweb_stop_music);
  emscripten::function("audioWorkletRequest", &pmdweb_audio_worklet_request);
  emscripten::function("renderFramesForTest", &pmdweb_render_frames_for_test);
  emscripten::function("getSnapshotRingPointer", &pmdweb_get_snapshot_ring_pointer);
  emscripten::function("getSnapshotEntryByteSize", &pmdweb_get_snapshot_entry_byte_size);
  emscripten::function("getSnapshotWriteIndex", &pmdweb_get_snapshot_write_index);
  // frameに続くヘッダ(timerb_cnt/timerb/loop_cnt/timerb_cnt_loop/loop_timerb_cnt)
  // のワード数。JS側がハードコードせずに済むよう export する
  // (mucomweb の getSnapshotHeaderWordCount() と同じ命名。docs/right-pane-data.md §7)。
  emscripten::function("getSnapshotHeaderWordCount", &pmdweb_get_snapshot_header_word_count);
  emscripten::function("getTrackCount", &pmdweb_get_track_count);
  emscripten::function("getFieldCount", &pmdweb_get_field_count);
  emscripten::function("getSampleRate", &pmdweb_get_sample_rate);
  // コメント欄(曲名・作曲者・編曲者・メモ)。CP932バイト列をUTF-8として
  // 誤解釈させないため、std::stringではなく「ポインタ+バイト長」で返す
  // (PmdCore.c のコメント参照)。JS側はModule.HEAPU8から直接コピーする。
  emscripten::function("getCommentModePmd", &pmdweb_get_comment_mode_pmd);
  emscripten::function("getCommentLength", &pmdweb_get_comment_length);
  emscripten::function("getCommentPointer", &pmdweb_get_comment_pointer);
  // FMDSP右半分(FFT/レベルメーター)。レイアウトは docs/right-pane-data.md 参照。
  emscripten::function("getSnapshotFftOffset", &pmdweb_get_snapshot_fft_offset);
  emscripten::function("getSnapshotLevelOffset", &pmdweb_get_snapshot_level_offset);
  emscripten::function("getFftBinCount", &pmdweb_get_fft_bin_count);
  emscripten::function("getLevelCount", &pmdweb_get_level_count);
  emscripten::function("getLevelFieldCount", &pmdweb_get_level_field_count);
  // FMDSPトラック行クリックミュート機能(fmdsp/trackrow.js、fmdsp/channel-mask.js参照)。
  emscripten::function("setChannelMask", &pmdweb_set_channel_mask);
  // 検証専用(tools/verify_pmd_channel_mute.mjs)。製品UIからは呼ばれない。
  emscripten::function("testLoadPpcFile", &TestLoadPpcFile);
}
