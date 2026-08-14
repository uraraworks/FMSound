#ifndef MUCOM88_STREAMINGPLAYER_H
#define MUCOM88_STREAMINGPLAYER_H

#include <cstdint>

typedef void (*FnStreamingPlayerCallback)(int requestedFrames, uint32_t requestId);

class StreamingPlayer
{
private:
	int _sampleRate;
	bool _isPlaying;
	uint32_t _generation;
	FnStreamingPlayerCallback _callback;

public:
	explicit StreamingPlayer(FnStreamingPlayerCallback callback);
	~StreamingPlayer();

	bool IsPlaying() const { return _isPlaying; }

	void Play(int sampleRate);
	void Stop();
	void Process(int requestedFrames, uint32_t generation, uint32_t requestId);
	void Submit(const int32_t *samples, int frames, uint32_t requestId, bool finalForRequest);
};

#endif // MUCOM88_STREAMINGPLAYER_H
