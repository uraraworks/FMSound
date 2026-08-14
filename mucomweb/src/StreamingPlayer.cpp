#include "StreamingPlayer.h"

#include <emscripten.h>

namespace
{
constexpr int FramesPerChunk = 2048;

EM_JS(void, AudioWorkletPlay, (int sampleRate, uint32_t generation), {
	const state = globalThis.mucomAudioState ||= {
		context: null,
		node: null,
		workletReady: null,
		generation: 0,
		playback: null,
		stats: { requestedFrames: 0, renderedFrames: 0, queuedFrames: 0, underflowFrames: 0 }
	};
	state.generation = generation;
	state.playback = null;
	state.stats = { requestedFrames: 0, renderedFrames: 0, queuedFrames: 0, underflowFrames: 0 };

	(async () => {
		if (state.node) {
			state.node.port.postMessage({ type: 'stop' });
			state.node.disconnect();
			state.node = null;
		}
		if (state.context && state.context.sampleRate !== sampleRate) {
			await state.context.close();
			state.context = null;
			state.workletReady = null;
		}
		if (!state.context) {
			const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
			state.context = new AudioContextClass({ sampleRate });
			state.workletReady = state.context.audioWorklet.addModule('./mucom-worklet.js');
		}
		await state.workletReady;
		if (state.generation !== generation) return;

		const actualRate = state.context.sampleRate;
		const targetChunks = Math.max(1, Math.round(actualRate * 0.075 / 2048));
		const targetFrames = targetChunks * 2048;
		const lowWaterFrames = Math.min(2048, Math.max(128, Math.round(actualRate * 0.04 / 128) * 128));
		const node = new AudioWorkletNode(state.context, 'mucom-stream-processor', {
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
				state.playback = {
					playFrame: message.playFrame,
					contextTime: message.contextTime
				};
			}
		};
		node.port.postMessage({ type: 'start', generation, targetFrames, lowWaterFrames });
		node.connect(state.context.destination);
		await state.context.resume();
	})().catch((error) => console.error('AudioWorklet initialization failed:', error));
});

EM_JS(void, AudioWorkletStop, (uint32_t generation), {
	const state = globalThis.mucomAudioState;
	if (!state) return;
	state.generation = generation;
	state.playback = null;
	if (state.node) {
		state.node.port.postMessage({ type: 'stop' });
		state.node.disconnect();
		state.node = null;
	}
});

EM_JS(void, AudioWorkletSubmit,
	(const int32_t *samples, int frames, uint32_t generation, uint32_t requestId, int finalForRequest), {
	const state = globalThis.mucomAudioState;
	if (!state || !state.node || state.generation !== generation) return;
	const sampleCount = frames * 2;
	const chunk = new Int32Array(sampleCount);
	chunk.set(HEAP32.subarray(samples >> 2, (samples >> 2) + sampleCount));
	state.stats.renderedFrames += frames;
	state.node.port.postMessage({
		type: 'chunk', generation, frames, requestId,
		finalForRequest: !!finalForRequest, samples: chunk.buffer
	}, [chunk.buffer]);
});
}

StreamingPlayer::StreamingPlayer(FnStreamingPlayerCallback callback) :
	_sampleRate(0),
	_isPlaying(false),
	_generation(0),
	_callback(callback)
{
}

StreamingPlayer::~StreamingPlayer()
{
	Stop();
}

void StreamingPlayer::Play(int sampleRate)
{
	Stop();
	_sampleRate = sampleRate;
	_isPlaying = true;
	AudioWorkletPlay(_sampleRate, _generation);
}

void StreamingPlayer::Stop()
{
	++_generation;
	_isPlaying = false;
	AudioWorkletStop(_generation);
}

void StreamingPlayer::Process(int requestedFrames, uint32_t generation, uint32_t requestId)
{
	if (!_isPlaying || generation != _generation || requestedFrames <= 0) return;
	_callback(requestedFrames, requestId);
}

void StreamingPlayer::Submit(const int32_t *samples, int frames, uint32_t requestId, bool finalForRequest)
{
	if (!_isPlaying || frames != FramesPerChunk) return;
	AudioWorkletSubmit(samples, frames, _generation, requestId, finalForRequest ? 1 : 0);
}
