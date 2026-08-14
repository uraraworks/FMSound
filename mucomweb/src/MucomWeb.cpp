#include <emscripten/bind.h>

#include <array>
#include <cstdint>
#include <limits>
#include <memory>
#include <string>
#include <type_traits>
#include "mucom_module.h"
#include "mucomvm.h" // GetVM()経由でOPNAキーオン状態(GetChStatus)を読むため。upstream patch(mucomweb/patches/0001-cmucom-expose-vm.patch)前提
#include "StreamingPlayer.h"

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

struct StatusSnapshot
{
	uint32_t frame;
	int32_t passTick;
	int32_t intCount;
	int32_t maxCount;
	int32_t chstat[OpnaChannelCount];
	TrackStatus tracks[MUCOM_MAXCH];
};

static const int StatusSnapshotHeaderWordCount = 4 + OpnaChannelCount; // frame, passTick, intCount, maxCount, chstat[16]

static_assert(std::is_standard_layout<TrackStatus>::value, "TrackStatus must stay flat");
static_assert(sizeof(TrackStatus) == 15 * sizeof(int32_t), "TrackStatus layout changed");
static_assert(sizeof(StatusSnapshot) ==
	(StatusSnapshotHeaderWordCount + MUCOM_MAXCH * 15) * sizeof(int32_t),
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
			PushSnapshot();
		}
		g_player->Submit(g_audioBuffer.data(), FramesPerBlock, requestId, block + 1 == blockCount);
	}
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
}
