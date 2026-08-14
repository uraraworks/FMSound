#include <emscripten/bind.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <memory>
#include <string>
#include <type_traits>
#include "mucom_module.h"
#include "mucomvm.h" // GetVM()経由でOPNAキーオン状態(GetChStatus)を読むため。upstream patch(mucomweb/patches/0001-cmucom-expose-vm.patch)前提
#include "StreamingPlayer.h"

// FMDSP右半分のスペクトラムアナライザ(70ビン)。98fmplayer由来のfft.c/.hは
// C(extern "C" 無し)で書かれているため、素直にincludeすると関数宣言が
// C++の名前修飾を受け、C(mucomweb/CMakeLists.txtでfft.cとしてビルド)側の
// 実体とリンクできなくなる。pmdweb側はfft.hをCから使うのでこの問題が
// 起きない(PmdCore.c参照)。ここでは明示的にextern "C"で包む。
extern "C" {
#include "fft/fft.h"
}

static const int ChannelCount = 2;
static const int FramesPerBlock = 2048;
static const int FramesPerSnapshot = 256;
static const uint32_t SnapshotRingSize = 2048;
static const uint32_t InvalidSnapshotWriteIndex = std::numeric_limits<uint32_t>::max();

struct TrackStatus
{
	int32_t length;
	int32_t vnum;
	int32_t volume;
	int32_t quantize;
	int32_t detune;
	int32_t fnum1;
	int32_t fnum2;
	int32_t code;
	int32_t flag;
	int32_t pan;
	int32_t keyon;
	int32_t alg;
	int32_t chnum;
	int32_t vnum_org;
	int32_t vol_org;
};

// frame に続くグローバルカウンタ群。CMucom::GetStatus()由来(cmucom.h:45-56)。
// 単位は実測で確認したもののみ採用する(docs/mucom-pchdata-mapping.md参照):
//   passTick = GetStatus(MUCOM_STATUS_PASSTICK) そのもの。実体はvm->time_master
//     (osdep.h `TICK_SHIFT=10`により1ms=1024単位の固定小数)。CMucom::RenderAudio()
//     が描画したオーディオ時間をそのままUpdateTime()へ渡して進めているため、
//     「オーディオレンダリング済み時間(ms)×1024」に一致することを実測済み。
//     JS側で /1024.0 すればmsになる。
//   intCount = GetStatus(MUCOM_STATUS_INTCOUNT)。演奏開始からのINT3(音楽用割り込み)
//     回数の生カウント(曲末尾でループしても0に戻らず増え続ける)。
//   maxCount = GetStatus(MUCOM_STATUS_MAXCOUNT)。曲の総tick数(コンパイル時に
//     全チャンネルの最大tickカウントとして確定する定数、cmucom.cpp:1303)。
//     GetStatus(MUCOM_STATUS_COUNT)が「intCount % maxCount」を返す実装
//     (cmucom.cpp:534-538)であることから、floor(intCount / maxCount)が
//     ループ回数に相当する(JS側でmaxCount>0のときのみ計算する)。
// mucomvm::GetChStatus(ch)由来のOPNAキーオン状態(0/1)。ch の意味はPCHDATAの
// MMLパートch(A-K=0-10)とは別物で、mucomvm.h の OPNACH_FM=0/OPNACH_PSG=6/
// OPNACH_RHYTHM=9/OPNACH_ADPCM=10 というOPNAハードウェアch番号。
// mucomvm.cpp:FMOutData()の実装では reg 0x28 KeyOnで `ch = data & 7`
// (YM2203/OPNA標準: port0=ch0-2, port1(bit2)=ch4-6)をそのままchstat[]の
// indexに使っており、単純に0-5連番ではない。ADPCM検出はreg 0x28ではなく
// FMOutData()のRhythm分岐とFMOutData2()の別経路(chstat[OPNACH_ADPCM])で
// 行われており、他のchと混線しない。全16chをそのまま持ち出し、
// 実測でMMLパート(A-K)との対応をdocs/mucom-pchdata-mapping.mdに記録した上で
// JS側(adapter.js)がその対応表に従って参照する。
static const int OpnaChannelCount = 16; // mucomvm.h の OPNACH_MAX

// FFTスペクトラム(70ビン)。出典・値域・間引き方針はpmdweb/src/PmdCore.cと同じ
// (docs/right-pane-data.md参照)。FFT_BIN_COUNT_PADDEDは70->72の明示パディングで、
// 後続のtracks[]相当がここでは既に前(ヘッダ+chstat+tracks)にあるため、fft[]は
// 末尾に置く。4byte境界に揃える必要はTrackStatusとの間だけなので変わらない。
static const int FftBinCount = FFTDISPLEN;        // 70 (fft/fft.h)
static const int FftBinCountPadded = 72;          // 明示パディング(_Static_assert代わりのstatic_assertで検査)

struct StatusSnapshot
{
	uint32_t frame;
	int32_t passTick;
	int32_t intCount;
	int32_t maxCount;
	int32_t chstat[OpnaChannelCount];
	TrackStatus tracks[MUCOM_MAXCH];
	uint8_t fft[FftBinCountPadded]; // [0..FftBinCount)が有効値(0-31)。末尾2byteは常に0の明示パディング
};

static const int StatusSnapshotHeaderWordCount = 4 + OpnaChannelCount; // frame, passTick, intCount, maxCount, chstat[16]

static_assert(std::is_standard_layout<TrackStatus>::value, "TrackStatus must stay flat");
static_assert(sizeof(TrackStatus) == 15 * sizeof(int32_t), "TrackStatus layout changed");
static_assert(std::is_standard_layout<StatusSnapshot>::value, "StatusSnapshot must stay flat (offsetof requires this)");
static_assert(FftBinCount == 70, "FFTDISPLEN changed");
static_assert(sizeof(StatusSnapshot) ==
	(StatusSnapshotHeaderWordCount + MUCOM_MAXCH * 15) * sizeof(int32_t) + FftBinCountPadded,
	"StatusSnapshot layout changed");

std::unique_ptr<StreamingPlayer> g_player;
std::unique_ptr<CMucom> g_mucom;
// 曲の総tick数(MUCOM_STATUS_MAXCOUNT)。実測で判明した制約:再生に使う g_mucom は
// LoadMusic()+Play() だけを呼び、Compile()を呼ばないため、g_mucom->GetStatus
// (MUCOM_STATUS_MAXCOUNT) は常に0を返す(maxcountはCMucom::Compile()内でのみ
// 更新されるメンバ、cmucom.cpp:1283,1303)。コンパイル専用インスタンス
// mucomCompiler が確定させた値をCompileMML()内でここへ退避し、以後の
// PushSnapshot()で使い回す。
std::array<int32_t, FramesPerBlock * ChannelCount> g_audioBuffer;
std::array<StatusSnapshot, SnapshotRingSize> g_snapshotRing{};
uint32_t g_snapshotWriteIndex = InvalidSnapshotWriteIndex;
uint32_t g_renderFrame = 0;
int32_t g_maxCount = 0;
int g_sampleRate = 0;

// --- FFTスペクトラム(70ビン) ---
// pmdweb/src/PmdCore.cのfft_feed()と同じ方針: fft_write()(PCMリングへの
// 書き込み)は毎スナップショット(FramesPerSnapshot=256フレームごと)呼び、
// fft_calc()(8192点FFT本体)だけ約60Hzに間引く。PMDと違いMUCOM側は
// サンプルレートがUIで可変(12kHz-55kHz)なので、間引き間隔はSAMPLE_RATE定数
// ではなくg_sampleRateから都度計算する。
struct fmplayer_fft_input_data g_fftInput;
struct fmplayer_fft_disp_data g_fftDisp;
uint32_t g_fftLastCalcFrame = 0;
bool g_fftTableReady = false;

void FftFeed(const int32_t *interleaved, int frames)
{
	// MUCOM側の音声バッファはint32_tのステレオ(fmgen FM_SAMPLETYPE=int32、
	// fmgen.h)。値のスケール自体は16bit相当で、再生側(mucom-worklet.js)も
	// sample/32768でPCM出力に変換している(±32768付近をクリップ)。
	// fft_write()(98fmplayer/fft/fft.h)はint16_t*を要求するため、単純な
	// static_castではなく、ミックスにより16bit範囲をわずかに超え得る値を
	// 明示的にクランプしてから渡す(型の食い違いを無言でキャストで潰さない)。
	static int16_t clamped[FramesPerBlock * ChannelCount];
	const int sampleCount = frames * ChannelCount;
	for (int i = 0; i < sampleCount; ++i)
	{
		int32_t v = interleaved[i];
		if (v > 32767) v = 32767;
		else if (v < -32768) v = -32768;
		clamped[i] = static_cast<int16_t>(v);
	}
	fft_write(&g_fftInput.fdata, clamped, static_cast<unsigned>(frames));

	if (!g_fftTableReady || g_sampleRate <= 0) return;
	uint32_t interval = static_cast<uint32_t>(g_sampleRate) / 60;
	if (interval == 0) interval = 1;
	if (g_renderFrame - g_fftLastCalcFrame >= interval)
	{
		fft_calc(&g_fftDisp, &g_fftInput);
		g_fftLastCalcFrame = g_renderFrame;
	}
}

int main()
{
	return 0;
}

void InvalidateSnapshotRing()
{
	g_snapshotWriteIndex = InvalidSnapshotWriteIndex;
	g_renderFrame = 0;
}

void ActivateSnapshotRing()
{
	g_snapshotRing.fill({});
	g_snapshotWriteIndex = 0;
	g_renderFrame = 0;
	// 前回再生分のPCMリング/表示バッファを引きずらない(無音開始時に
	// ほぼ0であることの前提、docs/right-pane-data.md 検証(b)参照)。
	g_fftInput = {};
	g_fftDisp = {};
	g_fftLastCalcFrame = 0;
}

void PushSnapshot()
{
	if (g_snapshotWriteIndex == InvalidSnapshotWriteIndex || g_mucom == nullptr) return;

	StatusSnapshot& snapshot = g_snapshotRing[g_snapshotWriteIndex & (SnapshotRingSize - 1)];
	snapshot.frame = g_renderFrame;
	snapshot.passTick = g_mucom->GetStatus(MUCOM_STATUS_PASSTICK);
	snapshot.intCount = g_mucom->GetStatus(MUCOM_STATUS_INTCOUNT);
	snapshot.maxCount = g_maxCount; // g_mucom->GetStatus(MUCOM_STATUS_MAXCOUNT)は常に0(上のコメント参照)
	mucomvm *vm = g_mucom->GetVM();
	for (int ch = 0; ch < OpnaChannelCount; ++ch)
	{
		snapshot.chstat[ch] = vm != nullptr ? vm->GetChStatus(ch) : 0;
	}
	for (int ch = 0; ch < MUCOM_MAXCH; ++ch)
	{
		PCHDATA data{};
		g_mucom->GetChannelData(ch, &data);
		snapshot.tracks[ch] = {
			data.length, data.vnum, data.volume, data.quantize, data.detune,
			data.fnum1, data.fnum2, data.code, data.flag, data.pan,
			data.keyon, data.alg, data.chnum, data.vnum_org, data.vol_org
		};
	}
	static_assert(sizeof(snapshot.fft) == FftBinCountPadded, "fft field size mismatch");
	memcpy(snapshot.fft, g_fftDisp.buf, FftBinCount);
	memset(snapshot.fft + FftBinCount, 0, FftBinCountPadded - FftBinCount);
	++g_snapshotWriteIndex;
}

void ProcessAudioRequest(int requestedFrames, uint32_t requestId)
{
	if (g_mucom == nullptr || g_player == nullptr || !g_player->IsPlaying()) return;
	const int blockCount = (requestedFrames + FramesPerBlock - 1) / FramesPerBlock;
	for (int block = 0; block < blockCount; ++block)
	{
		for (int offset = 0; offset < FramesPerBlock; offset += FramesPerSnapshot)
		{
			g_mucom->RenderAudio(
				g_audioBuffer.data() + offset * ChannelCount, FramesPerSnapshot);
			g_renderFrame += FramesPerSnapshot;
			FftFeed(g_audioBuffer.data() + offset * ChannelCount, FramesPerSnapshot);
			PushSnapshot();
		}
		g_player->Submit(g_audioBuffer.data(), FramesPerBlock, requestId, block + 1 == blockCount);
	}
}

// テスト用: ブラウザのAudioWorklet経路を経由せず直接レンダリングする
// (pmdweb/src/PmdCore.cのpmdweb_render_frames_for_test()と同じ狙い。Node環境には
// AudioContextが無いためStreamingPlayer::Play()のEM_JS初期化が失敗し、
// ProcessAudioRequest()はAudioWorkletからしか呼ばれないため到達できない)。
// 戻り値は生成したPCMの絶対値合計(曲が鳴っている証拠、非0チェック用)。
double RenderFramesForTest(int frames)
{
	if (g_mucom == nullptr || frames <= 0) return 0;
	double absoluteSum = 0;
	while (frames > 0)
	{
		int count = frames > FramesPerSnapshot ? FramesPerSnapshot : frames;
		g_mucom->RenderAudio(g_audioBuffer.data(), count);
		for (int i = 0; i < count * ChannelCount; ++i)
		{
			int32_t v = g_audioBuffer[i];
			absoluteSum += v < 0 ? -v : v;
		}
		g_renderFrame += count;
		FftFeed(g_audioBuffer.data(), count);
		PushSnapshot();
		frames -= count;
	}
	return absoluteSum;
}

int GetSampleRate()
{
	return g_sampleRate;
}

void AudioWorkletRequest(int requestedFrames, uint32_t generation, uint32_t requestId)
{
	if (g_player != nullptr)
	{
		g_player->Process(requestedFrames, generation, requestId);
	}
}

std::string CompileMML(const std::string& mml, int sampleRate)
{
	static const char *mubPath = "/mucom.mub";

	g_maxCount = 0;

	// fft_init_table()はfftfreqtab/窓関数テーブルの初期化で、繰り返し呼んでも
	// 副作用は無いが重い(FFTLEN=8192点分)ため、pmdweb/src/PmdCore.cのinitialize_synth()
	// と同じく一度だけ呼ぶ。
	if (!g_fftTableReady)
	{
		fft_init_table();
		g_fftTableReady = true;
	}

	CMucom mucomCompiler;
	mucomCompiler.Init();
	mucomCompiler.Reset(2);
	if (mucomCompiler.Compile(const_cast<char *>(mml.c_str()), mubPath) >= 0)
	{
		// maxcountはこのコンパイル専用インスタンス側にしか確定しない(上のコメント参照)。
		g_maxCount = mucomCompiler.GetStatus(MUCOM_STATUS_MAXCOUNT);

		if (g_player == nullptr)
		{
			g_player = std::make_unique<StreamingPlayer>(&ProcessAudioRequest);
		}
		g_player->Stop();
		InvalidateSnapshotRing();
		g_mucom = nullptr;
		g_mucom = std::make_unique<CMucom>();
		g_mucom->Init(nullptr, MUCOM_CMPOPT_STEP, sampleRate);
		g_mucom->Reset(0);
		if (g_mucom->LoadMusic(mubPath) >= 0 &&
			g_mucom->Play(0) >= 0)
		{
			g_sampleRate = sampleRate;
			ActivateSnapshotRing();
			g_player->Play(sampleRate);
		}
	}
	return std::string(mucomCompiler.GetMessageBuffer());
}

void StopMusic()
{
	if (g_player != nullptr)
	{
		g_player->Stop();
	}
	if (g_mucom != nullptr)
	{
		g_mucom->Stop();
	}
	InvalidateSnapshotRing();
}

uint32_t GetSnapshotRingPointer()
{
	return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_snapshotRing.data()));
}

uint32_t GetSnapshotEntryByteSize()
{
	return sizeof(StatusSnapshot);
}

uint32_t GetSnapshotWriteIndex()
{
	return g_snapshotWriteIndex;
}

// StatusSnapshotの先頭(frame, passTick, intCount, maxCount)のワード数。
// JS側はこの値だけ知っていれば、tracks[]の開始位置をハードコードせずに
// 済む(GetSnapshotEntryByteSize()等、既存exportと同じ命名に揃えた)。
uint32_t GetSnapshotHeaderWordCount()
{
	return StatusSnapshotHeaderWordCount;
}

// FMDSP右半分(FFTスペクトラム)。pmdweb側のgetSnapshotFftOffset/getFftBinCountと
// 命名を揃える(docs/right-pane-data.md参照)。MUCOM側にはlevels[]相当の
// leveldataが無いため(fmgenにレベル追従が無い、スコープ外)levelOffset等は無い。
uint32_t GetSnapshotFftOffset()
{
	return static_cast<uint32_t>(offsetof(StatusSnapshot, fft));
}

int GetFftBinCount()
{
	return FftBinCount;
}

emscripten::val GetChannelData()
{
	emscripten::val channels = emscripten::val::array();
	const bool isPlaying = g_mucom != nullptr &&
		g_mucom->GetStatus(MUCOM_STATUS_PLAYING) != 0;

	for (int ch = 0; ch < MUCOM_MAXCH; ch++)
	{
		PCHDATA data{};
		if (isPlaying)
		{
			g_mucom->GetChannelData(ch, &data);
		}

		emscripten::val channel = emscripten::val::object();
		channel.set("length", data.length);
		channel.set("vnum", data.vnum);
		channel.set("volume", data.volume);
		channel.set("quantize", data.quantize);
		channel.set("detune", data.detune);
		channel.set("fnum1", data.fnum1);
		channel.set("fnum2", data.fnum2);
		channel.set("code", data.code);
		channel.set("flag", data.flag);
		channel.set("pan", data.pan);
		channel.set("keyon", data.keyon);
		channel.set("alg", data.alg);
		channel.set("chnum", data.chnum);
		channel.set("vnum_org", data.vnum_org);
		channel.set("vol_org", data.vol_org);
		channels.call<void>("push", channel);
	}

	return channels;
}

EMSCRIPTEN_BINDINGS(mucom88)
{
	emscripten::function("compileMML", &CompileMML);
	emscripten::function("stopMusic", &StopMusic);
	emscripten::function("getChannelData", &GetChannelData);
	emscripten::function("audioWorkletRequest", &AudioWorkletRequest);
	emscripten::function("getSnapshotRingPointer", &GetSnapshotRingPointer);
	emscripten::function("getSnapshotEntryByteSize", &GetSnapshotEntryByteSize);
	emscripten::function("getSnapshotWriteIndex", &GetSnapshotWriteIndex);
	emscripten::function("getSnapshotHeaderWordCount", &GetSnapshotHeaderWordCount);
	// FMDSP右半分(FFT)。docs/right-pane-data.md参照。
	emscripten::function("getSnapshotFftOffset", &GetSnapshotFftOffset);
	emscripten::function("getFftBinCount", &GetFftBinCount);
	// テスト専用(tools/verify_right_pane_data.mjs)。pmdweb同様、Node環境からは
	// AudioWorklet経由のProcessAudioRequest()に到達できないための直接レンダリング口。
	emscripten::function("renderFramesForTest", &RenderFramesForTest);
	emscripten::function("getSampleRate", &GetSampleRate);
}
