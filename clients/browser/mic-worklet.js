// Decimates the microphone to 16 kHz mono signed 16-bit PCM and posts 200 ms (6,400 byte) chunks.
// It does no voice-activity or turn detection: the backend owns recognition and turn-taking.
class InterviewMic extends AudioWorkletProcessor {
  constructor() { super(); this.size = 3200; this.samples = new Int16Array(this.size); this.at = 0; this.phase = 0; this.sum = 0; this.count = 0; }
  process(inputs) {
    const mono = inputs[0]?.[0]; if (!mono) return true;
    for (const sample of mono) {
      this.sum += sample; this.count++; this.phase += 16000;
      if (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        const value = Math.max(-1, Math.min(1, this.sum / this.count)); this.sum = 0; this.count = 0;
        this.samples[this.at++] = value < 0 ? value * 32768 : value * 32767;
        if (this.at === this.size) { this.port.postMessage(this.samples.buffer, [this.samples.buffer]); this.samples = new Int16Array(this.size); this.at = 0; }
      }
    }
    return true;
  }
}
registerProcessor('interview-mic', InterviewMic);
