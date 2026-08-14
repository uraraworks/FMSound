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

// レベルメーター(19ch)。docs/right-pane-data.md §4/§6bと同じ形式(PMD側
// struct flat_level_status と同じ5フィールド)。出典は
// upstream/98fmplayer/fmdsp/fmdsp-pacc.c:1660-1733 の levels[] 構築ロジック
// (pmdweb/src/PmdCore.c build_levels() が既にこれをPMD側で移植済み)。
// MUCOM側はfmgenにチャンネル単位のレベル追従が無いため、fmgenのミックス経路
// (Mix6/MixSubS/MixSubSL, ADPCMBMix, PSG::Mix, OPNA::RhythmMix)に
// mucomweb/patches/0002-fmgen-leveldata.patchでピーク追従を追加した。
static const int LevelCount = 19;
static const int LevelFieldCount = 5;

struct LevelStatus
{
	int32_t level;   // leveldata相当(ピーク保持、読み出しでクリア)の値。0が無音
	int32_t pan;     // 定位。PMD側と同じ table[]={5,4,0,2} 変換 + 非playing時は5固定
	int32_t prog;    // 対応track(下記LevelToTrack参照)のvnum
	int32_t key;     // 対応trackのcode(+0x10、休符時下位4bitを0xFへ。adapter.jsのkey計算と同じ)
	int32_t playing; // 対応trackが今この瞬間鳴っているか
};

struct StatusSnapshot
{
	uint32_t frame;
	int32_t passTick;
	int32_t intCount;
	int32_t maxCount;
	int32_t chstat[OpnaChannelCount];
	TrackStatus tracks[MUCOM_MAXCH];
	uint8_t fft[FftBinCountPadded]; // [0..FftBinCount)が有効値(0-31)。末尾2byteは常に0の明示パディング
	LevelStatus levels[LevelCount];
};

static const int StatusSnapshotHeaderWordCount = 4 + OpnaChannelCount; // frame, passTick, intCount, maxCount, chstat[16]

static_assert(std::is_standard_layout<TrackStatus>::value, "TrackStatus must stay flat");
static_assert(sizeof(TrackStatus) == 15 * sizeof(int32_t), "TrackStatus layout changed");
static_assert(std::is_standard_layout<LevelStatus>::value, "LevelStatus must stay flat");
static_assert(sizeof(LevelStatus) == LevelFieldCount * sizeof(int32_t), "LevelStatus layout changed");
static_assert(std::is_standard_layout<StatusSnapshot>::value, "StatusSnapshot must stay flat (offsetof requires this)");
static_assert(FftBinCount == 70, "FFTDISPLEN changed");
static_assert(LevelCount == 19, "LevelCount changed");
static_assert(sizeof(StatusSnapshot) ==
	(StatusSnapshotHeaderWordCount + MUCOM_MAXCH * 15) * sizeof(int32_t) + FftBinCountPadded
	+ LevelCount * sizeof(LevelStatus),
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

// レベルメーター index(0-18) -> tracks[](MML part A-K, 0-10)の対応表。
// MUCOMコンパイラのパート固定割り当て(A,B,C=FM1-3 / D,E,F=SSG1-3 / G=リズム /
// H,I,J=FM4-6 / K=ADPCM。upstream/MucomWeb/mucom88/src/cmucom.h の
// MUCOM_CH_FM1=0/MUCOM_CH_PSG=3/MUCOM_CH_RHYTHM=6/MUCOM_CH_ADPCM=10と一致)を
// 反映したもの。単発パートMMLで実測して検証済み(docs/right-pane-data.md §6b)。
// index 11-18(PPZ8)はMUCOMに存在しないので対応trackなし(-1)。
static const int LevelToTrack[LevelCount] = {
	0, 1, 2, 7, 8, 9,  // 0-5: FM1-6   -> A,B,C,H,I,J
	3, 4, 5,           // 6-8: SSG1-3  -> D,E,F
	6,                 // 9:   リズム  -> G
	                   //      (PMD側は levels[9].t を明示せず暗黙にFM1流用する
	                   //      上流の癖があるが、MUCOMには実在するリズム専用
	                   //      パートGがあるため、そちらを使う方が正確と判断。
	                   //      PMD側の癖はそのまま再現しない。詳細はdocs参照)
	10,                // 10:  ADPCM   -> K
	-1, -1, -1, -1, -1, -1, -1, -1, // 11-18: PPZ8(存在しない)
};

// pan生値(0-3, bit7<<1|bit6) -> FMDSP PANPOTスプライト番号(0-5)。
// PMD側(pmdweb/src/PmdCore.c build_levels())・adapter.jsのPAN_TABLEと同じ表。
static const int PanTable[4] = {5, 4, 0, 2};

// FMDSP右半分レベルメーター(19ch)を構築する。
// 出典・各経路の分離可否はmucomweb/patches/0002-fmgen-leveldata.patchの
// コメントおよびdocs/right-pane-data.md参照。
void BuildLevels(StatusSnapshot &snapshot, mucomvm *vm)
{
	FM::OPNA *opna = vm != nullptr ? vm->GetOpna() : nullptr;
	if (opna == nullptr)
	{
		memset(snapshot.levels, 0, sizeof(snapshot.levels));
		return;
	}

	const uint8_t *regmap = vm->GetRegisterMap();

	unsigned rawLevel[LevelCount] = {0};
	// FM 1-6 (index 0-5)
	for (int c = 0; c < 6; ++c) rawLevel[c] = opna->GetFmLevel(c);
	// SSG 1-3 (index 6-8)
	for (int c = 0; c < 3; ++c) rawLevel[6 + c] = opna->GetSsgLevel(c);
	// リズム(index 9): 6音の最大値(PMD側と同じ方針)
	{
		unsigned maxLevel = 0;
		for (int d = 0; d < 6; ++d)
		{
			unsigned l = opna->GetRhythmLevel(d);
			if (l > maxLevel) maxLevel = l;
		}
		rawLevel[9] = maxLevel;
	}
	// ADPCM(index 10)
	rawLevel[10] = opna->GetAdpcmLevel();
	// index 11-18(PPZ8)は0のまま(MUCOMに存在しない)

	for (int c = 0; c < LevelCount; ++c)
	{
		LevelStatus &out = snapshot.levels[c];
		int track = LevelToTrack[c];
		if (track < 0)
		{
			out = {0, 0, 0, 0, 0};
			continue;
		}

		out.level = static_cast<int32_t>(rawLevel[c]);

		// playing: FM(0-5)とADPCM(10)はmucomvm::GetChStatus()実測値(register由来、
		// リアルタイム。CH_TO_CHSTATと同じ考え方)を使う。OPNAハードウェアchの
		// 並びはFM1-3=chstat[0-2]/FM4-6=chstat[4-6](3は未使用、YM2608の実チャンネル
		// 番号付けそのまま)。SSG(6-8)とリズム(9)には対応するchstat[]が存在しない
		// (adapter.jsのCH_TO_CHSTATコメント参照)ため、代わりに今回追加した
		// 実測レベル(rawLevel>0)を「今鳴っているか」の判定に使う。これは
		// sticky近似より正確(レベル自体が実際の音声出力そのものであるため)。
		bool playing;
		if (c < 6)
		{
			int chstatIndex = c < 3 ? c : c + 1;
			playing = snapshot.chstat[chstatIndex] != 0;
		}
		else if (c == 10)
		{
			playing = snapshot.chstat[10] != 0; // OPNACH_ADPCM
		}
		else
		{
			playing = rawLevel[c] != 0; // SSG(6-8) / リズム(9)
		}

		// pan: FMとADPCMはOPNAレジスタから直接読む(adapter.jsのPAN_TABLE算出と
		// 同じ式)。SSG/リズムはcmucom.cppがpan=3を無条件に返す実装(adapter.js
		// コメント参照)に合わせ、rawpan=3固定(PanTable[3]=2)とする。
		// ただしリズムは本来6音それぞれ個別のpanレジスタを持つため、この
		// index9の値は「6音まとめての代表値」に過ぎない近似であることに注意
		// (未解明として残す。個別に取りたければ6音分に分解する必要がある)。
		int rawPan;
		if (c < 3) rawPan = (regmap[0xB4 + c] >> 6) & 3;
		else if (c < 6) rawPan = (regmap[0x1B4 + (c - 3)] >> 6) & 3;
		else if (c == 10) rawPan = (regmap[0x101] >> 6) & 3; // ADPCM-B Control2
		else rawPan = 3; // SSG(6-8) / リズム(9)
		int pan = PanTable[rawPan & 3];
		// PMD側 build_levels() と同じ仕様: 鳴っていないchはpan=5(無表示)固定。
		if (!playing) pan = 5;
		out.pan = pan;

		out.prog = snapshot.tracks[track].vnum;
		{
			int32_t code = snapshot.tracks[track].code;
			int32_t fnum1 = snapshot.tracks[track].fnum1;
			int32_t fnum2 = snapshot.tracks[track].fnum2;
			bool isRest = fnum1 == 0 && fnum2 == 0;
			int32_t key = (code + 0x10) & 0xff;
			if (isRest) key = (key & 0xf0) | 0xf;
			out.key = key;
		}
		out.playing = playing ? 1 : 0;
	}
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
	BuildLevels(snapshot, vm);
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

// FMDSP右半分(FFTスペクトラム/レベルメーター)。pmdweb側のexportと命名を揃える
// (docs/right-pane-data.md参照)。
uint32_t GetSnapshotFftOffset()
{
	return static_cast<uint32_t>(offsetof(StatusSnapshot, fft));
}

int GetFftBinCount()
{
	return FftBinCount;
}

uint32_t GetSnapshotLevelOffset()
{
	return static_cast<uint32_t>(offsetof(StatusSnapshot, levels));
}

int GetLevelCount()
{
	return LevelCount;
}

int GetLevelFieldCount()
{
	return LevelFieldCount;
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
	// FMDSP右半分(FFT/レベルメーター)。docs/right-pane-data.md参照。
	emscripten::function("getSnapshotFftOffset", &GetSnapshotFftOffset);
	emscripten::function("getFftBinCount", &GetFftBinCount);
	emscripten::function("getSnapshotLevelOffset", &GetSnapshotLevelOffset);
	emscripten::function("getLevelCount", &GetLevelCount);
	emscripten::function("getLevelFieldCount", &GetLevelFieldCount);
	// テスト専用(tools/verify_right_pane_data.mjs)。pmdweb同様、Node環境からは
	// AudioWorklet経由のProcessAudioRequest()に到達できないための直接レンダリング口。
	emscripten::function("renderFramesForTest", &RenderFramesForTest);
	emscripten::function("getSampleRate", &GetSampleRate);
}
