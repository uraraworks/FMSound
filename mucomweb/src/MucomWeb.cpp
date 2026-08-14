#include <emscripten/bind.h>

#include <array>
#include <cstdint>
#include <limits>
#include <memory>
#include <string>
#include <type_traits>
#include "mucom_module.h"
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

struct StatusSnapshot
{
	uint32_t frame;
	TrackStatus tracks[MUCOM_MAXCH];
};

static_assert(std::is_standard_layout<TrackStatus>::value, "TrackStatus must stay flat");
static_assert(sizeof(TrackStatus) == 15 * sizeof(int32_t), "TrackStatus layout changed");
static_assert(sizeof(StatusSnapshot) == (1 + MUCOM_MAXCH * 15) * sizeof(int32_t),
	"StatusSnapshot layout changed");

std::unique_ptr<StreamingPlayer> g_player;
std::unique_ptr<CMucom> g_mucom;
std::array<int32_t, FramesPerBlock * ChannelCount> g_audioBuffer;
std::array<StatusSnapshot, SnapshotRingSize> g_snapshotRing{};
uint32_t g_snapshotWriteIndex = InvalidSnapshotWriteIndex;
uint32_t g_renderFrame = 0;

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

	CMucom mucomCompiler;
	mucomCompiler.Init();
	mucomCompiler.Reset(2);
	if (mucomCompiler.Compile(const_cast<char *>(mml.c_str()), mubPath) >= 0)
	{
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
}
