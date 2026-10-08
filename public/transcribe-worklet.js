// Collects a WebRTC call's audio as 16-bit PCM for on-device transcription, in ~40 ms chunks.
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.size = Math.round(sampleRate / 25); this.chunk = new Int16Array(this.size); this.length = 0; }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) for (let i = 0; i < channel.length; i++) {
      this.chunk[this.length++] = Math.max(-32768, Math.min(32767, Math.round(channel[i] * 32767)));
      // Posting transfers the buffer, which empties this.chunk; start a new one.
      if (this.length === this.size) { this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]); this.chunk = new Int16Array(this.size); this.length = 0; }
    }
    return true;
  }
}
registerProcessor('dialdev-capture', Capture);
