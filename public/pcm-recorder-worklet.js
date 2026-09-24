// Lossless capture: converts whatever feeds it to 16-bit mono PCM at the context's sample rate (48 kHz on
// macOS) and posts half-second blocks. Used for user-voice.wav and claude-voice.wav (edit-ready stems).
class PcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super(); this.size = Math.round(sampleRate / 2); this.buf = new Int16Array(this.size); this.at = 0;
    this.stopped = false;
    this.port.onmessage = e => { if (e.data === 'flush' || e.data === 'stop') { this.post(); this.port.postMessage({ flushed: true }); if (e.data === 'stop') this.stopped = true; } };
  }
  post() {
    if (!this.at) return;
    const out = this.buf.slice(0, this.at); this.port.postMessage(out.buffer, [out.buffer]); this.at = 0;
  }
  process(inputs) {
    if (this.stopped) return false;                        // lets Chrome release the node; nothing more is captured
    const ch = inputs[0], n = ch?.[0]?.length || 128;
    for (let i = 0; i < n; i++) {
      let v = 0; if (ch && ch.length) { for (const c of ch) v += c[i]; v /= ch.length; }   // silence if nothing is connected
      v = Math.max(-1, Math.min(1, v)); this.buf[this.at++] = v < 0 ? v * 32768 : v * 32767;
      if (this.at === this.size) this.post();
    }
    return true;
  }
}
registerProcessor('pcm-recorder', PcmRecorder);
