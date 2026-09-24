// Gentle downward expansion: quiet room noise fades by up to 24 dB; speech
// opens in 4 ms, holds for 200 ms, and releases over 180 ms (no hard cuts).
class StreamExpander extends AudioWorkletProcessor {
  constructor() { super(); this.energy = 0; this.gain = 1; this.hold = 0; this.open = true; this.frames = 0;
    this.threshold = -48;
    this.port.onmessage = e => { if (typeof e.data === 'boolean') this.enabled = e.data;
      else if (Number.isFinite(e.data?.threshold)) this.threshold = Math.max(-65, Math.min(-25, e.data.threshold)); }; this.enabled = true; }
  process(inputs, outputs) {
    const input = inputs[0][0], output = outputs[0][0];
    if (!input) { output.fill(0); return true; }
    const smooth = Math.exp(-1 / (sampleRate * 0.008));
    for (let i = 0; i < output.length; i++) {
      const x = input[i]; this.energy = smooth * this.energy + (1 - smooth) * x * x;
      const db = 10 * Math.log10(this.energy + 1e-12);
      if (db > this.threshold) { this.open = true; this.hold = sampleRate * 0.2; }
      else if (this.hold > 0) this.hold--;
      else if (db < this.threshold - 6) this.open = false;
      const target = !this.enabled || this.open ? 1 : Math.pow(10, Math.max(-24, (db - this.threshold) * 2.5) / 20);
      const rate = 1 - Math.exp(-1 / (sampleRate * (target > this.gain ? 0.004 : 0.18)));
      this.gain += (target - this.gain) * rate; output[i] = x * this.gain;
    }
    if ((this.frames += output.length) >= sampleRate / 4) { this.frames = 0; this.port.postMessage({ db: 10 * Math.log10(this.energy + 1e-12), reduction: 20 * Math.log10(this.gain + 1e-12) }); }
    return true;
  }
}
registerProcessor('stream-expander', StreamExpander);
