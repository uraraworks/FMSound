class MucomStreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.chunkOffset = 0;
    this.queuedFrames = 0;
    this.targetFrames = 4096;
    this.lowWaterFrames = 2048;
    this.generation = 0;
    this.requestId = 0;
    this.requestOutstanding = false;
    this.running = false;
    this.playFrame = 0;
    this.underflowFrames = 0;
    this.quantumCount = 0;

    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'start') {
        this.chunks.length = 0;
        this.chunkOffset = 0;
        this.queuedFrames = 0;
        this.targetFrames = message.targetFrames;
        this.lowWaterFrames = message.lowWaterFrames;
        this.generation = message.generation;
        this.requestOutstanding = false;
        this.running = true;
        this.playFrame = 0;
        this.underflowFrames = 0;
        this.quantumCount = 0;
        this.requestMore();
      } else if (message.type === 'stop') {
        this.running = false;
        this.chunks.length = 0;
        this.chunkOffset = 0;
        this.queuedFrames = 0;
        this.requestOutstanding = false;
      } else if (message.type === 'chunk' && message.generation === this.generation) {
        this.chunks.push(new Int32Array(message.samples));
        this.queuedFrames += message.frames;
        if (message.finalForRequest) {
          this.requestOutstanding = false;
          this.requestMore();
        }
      }
    };
  }

  requestMore() {
    if (!this.running || this.requestOutstanding || this.queuedFrames >= this.lowWaterFrames) return;
    const deficit = Math.max(2048, this.targetFrames - this.queuedFrames);
    const frames = Math.max(2048, Math.floor(deficit / 2048) * 2048);
    this.requestOutstanding = true;
    this.requestId += 1;
    this.port.postMessage({ type: 'need', frames, requestId: this.requestId });
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1];
    if (!this.running) return true;

    let outputOffset = 0;
    while (outputOffset < left.length && this.chunks.length > 0) {
      const chunk = this.chunks[0];
      const available = chunk.length / 2 - this.chunkOffset;
      const count = Math.min(left.length - outputOffset, available);
      for (let i = 0; i < count; i++) {
        const source = (this.chunkOffset + i) * 2;
        left[outputOffset + i] = Math.max(-1, Math.min(1, chunk[source] / 32768));
        right[outputOffset + i] = Math.max(-1, Math.min(1, chunk[source + 1] / 32768));
      }
      outputOffset += count;
      this.chunkOffset += count;
      this.queuedFrames -= count;
      if (this.chunkOffset === chunk.length / 2) {
        this.chunks.shift();
        this.chunkOffset = 0;
      }
    }

    if (outputOffset < left.length) this.underflowFrames += left.length - outputOffset;
    // Underflow silence is not part of the rendered music timeline.
    this.playFrame += outputOffset;
    this.requestMore();

    this.quantumCount += 1;
    if (this.quantumCount % 10 === 0) {
      this.port.postMessage({
        type: 'playback',
        playFrame: this.playFrame,
        // currentTime points at the start of this render quantum.
        contextTime: currentTime + left.length / sampleRate
      });
    }
    if ((this.quantumCount & 15) === 0) {
      this.port.postMessage({
        type: 'stats',
        queuedFrames: this.queuedFrames,
        underflowFrames: this.underflowFrames
      });
    }
    return true;
  }
}

registerProcessor('mucom-stream-processor', MucomStreamProcessor);
