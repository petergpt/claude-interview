// Browser audio: microphone PCM to the backend, and participant replies through Web Audio.
import { dbGain } from './audio-mix.js';
// Levels exposed here drive the stage visuals; they never decide turns.

function rms(analyser, buffer) {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0; for (const v of buffer) sum += v * v;
  return Math.sqrt(sum / buffer.length);
}

// Per-participant trim, gentle peak compression, then a ceiling for brief transients.
// Recognition and the raw camera track bypass this playback/recording mix.
export function voiceStrip(ctx, gainDb = 0) {
  const input = ctx.createGain(), compressor = ctx.createDynamicsCompressor(), output = ctx.createWaveShaper();
  input.gain.value = dbGain(gainDb);
  compressor.threshold.value = -3; compressor.knee.value = 3; compressor.ratio.value = 12;
  compressor.attack.value = 0.003; compressor.release.value = 0.16;
  output.curve = Float32Array.from({ length: 4097 }, (_, i) => Math.max(-0.97, Math.min(0.97, i / 2048 - 1)));
  input.connect(compressor); compressor.connect(output);
  return { input, output, setGainDb(db) { input.gain.setTargetAtTime(dbGain(db), ctx.currentTime, 0.02); },
    dispose() { input.disconnect(); compressor.disconnect(); output.disconnect(); } };
}

export class Mic {
  constructor(ctx, stream, { gainDb = 0 } = {}) {
    this.ctx = ctx; this.stream = stream; this.stopped = false;
    this.source = ctx.createMediaStreamSource(stream);
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 1024; this.buf = new Float32Array(1024);
    this.source.connect(this.analyser);
    // Stage mix: follows mute so the composite recording matches what the backend records.
    this.strip = voiceStrip(ctx, gainDb);
    this.mixGain = ctx.createGain(); this.source.connect(this.strip.input); this.strip.output.connect(this.mixGain);
  }
  // onChunk receives sequential 6,400-byte PCM chunks; the caller uploads them in order.
  async start(onChunk) {
    await this.ctx.audioWorklet.addModule('/mic-worklet.js');
    this.node = new AudioWorkletNode(this.ctx, 'interview-mic', { numberOfOutputs: 1 });
    this.silent = this.ctx.createGain(); this.silent.gain.value = 0;
    this.source.connect(this.node); this.node.connect(this.silent).connect(this.ctx.destination);
    this.node.port.onmessage = e => { if (!this.stopped) onChunk(new Uint8Array(e.data)); };
  }
  level() { return rms(this.analyser, this.buf); }
  setGainDb(db) { this.strip.setGainDb(db); }
  setMuted(muted) { this.mixGain.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.02); }
  stop() {
    this.stopped = true; this.strip.dispose();
    if (this.node) this.node.port.onmessage = null;
    for (const node of [this.source, this.node, this.silent, this.analyser]) { try { node?.disconnect(); } catch {} }
  }
}

// Sends PCM chunks strictly in order. A failed chunk stops the uploader rather than reordering audio.
export class PcmUploader {
  constructor(post, onError) { this.post = post; this.onError = onError; this.chain = Promise.resolve(); this.failed = false; this.pending = 0; this.sent = 0; }
  push(bytes) {
    if (this.failed || this.closed) return;
    this.pending++;
    this.chain = this.chain.then(async () => {
      try { if (!this.failed) { await this.post(bytes); this.sent += bytes.length; } }
      catch (error) { this.failed = true; this.onError(error); }
      finally { this.pending--; }
    });
  }
  async close() { this.closed = true; await this.chain; }
}

// Schedules 24 kHz mono PCM for one reply at a time. Progress comes from the audio clock of buffers
// that were actually scheduled and started — never from how much audio was generated.
export class Player {
  constructor(ctx, { onComplete, levels = {} }) {
    this.ctx = ctx; this.onComplete = onComplete; this.turn = null;
    this.out = ctx.createGain(); this.out.connect(ctx.destination);
    this.voices = {}; this.strips = {}; this.levels = { ...levels };
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 1024; this.buf = new Float32Array(1024);
    this.out.connect(this.analyser);
  }
  voice(speaker) {
    if (!this.strips[speaker]) {
      const strip = voiceStrip(this.ctx, this.levels[speaker] || 0); strip.output.connect(this.out);
      this.strips[speaker] = strip; this.voices[speaker] = strip.output;
    }
    return this.voices[speaker];
  }
  setGainDb(speaker, db) { this.levels[speaker] = db; this.strips[speaker]?.setGainDb(db); }
  begin(id, speaker = 'claude') { this.stop(); this.turn = { id, speaker, buffers: [], nextTime: 0, generationDone: false, completed: false, firstStart: null }; }
  push(id, base64) {
    const t = this.turn; if (!t || t.id !== id || t.stopped || t.completed) return false;
    const raw = atob(base64), n = raw.length >> 1;
    if (!n) return true;
    const buffer = this.ctx.createBuffer(1, n, 24000), data = buffer.getChannelData(0);
    for (let i = 0; i < n; i++) { let v = raw.charCodeAt(2 * i) | (raw.charCodeAt(2 * i + 1) << 8); if (v >= 32768) v -= 65536; data[i] = v / 32768; }
    const now = this.ctx.currentTime;
    // Keep contiguous PCM contiguous right up to its deadline. The old 10 ms
    // safety margin inserted 50–60 ms of silence even when audio arrived on time.
    // Add lead only on the first buffer or after a real underrun.
    const start = t.nextTime > now ? t.nextTime : now + (t.buffers.length ? 0.06 : 0.14);
    const src = this.ctx.createBufferSource(); src.buffer = buffer; this.voice(t.speaker); src.connect(this.strips[t.speaker].input);
    const item = { start, dur: buffer.duration, src, ended: false };
    src.onended = () => { item.ended = true; this.checkComplete(t); };
    src.start(start); t.buffers.push(item); t.nextTime = start + buffer.duration;
    t.firstStart ??= start;
    return true;
  }
  finish(id) { const t = this.turn; if (t && t.id === id) { t.generationDone = true; this.checkComplete(t); } }
  checkComplete(t) {
    if (t !== this.turn || t.stopped || t.completed || !t.generationDone) return;
    if (t.buffers.some(b => !b.ended)) return;
    t.completed = true;
    this.onComplete(t.id, t.buffers.reduce((a, b) => a + b.dur, 0));
  }
  // Seconds of this reply that the audio clock has rendered, less the device's reported output latency.
  played(t = this.turn) {
    if (!t) return 0;
    const now = this.ctx.currentTime - (this.ctx.outputLatency || 0);
    return t.buffers.reduce((a, b) => a + Math.min(Math.max(0, now - b.start), b.dur), 0);
  }
  // Scheduled-audio timeline position for captions (0 before the first buffer starts).
  position() {
    const t = this.turn; if (!t || t.firstStart === null) return 0;
    return this.played(t);
  }
  get active() { return Boolean(this.turn && !this.turn.stopped && !this.turn.completed); }
  get audible() {
    const t = this.turn; if (!this.active) return false;
    const now = this.ctx.currentTime;
    return t.buffers.some(b => now >= b.start && now < b.start + b.dur);
  }
  get started() { return Boolean(this.turn && this.turn.firstStart !== null && this.ctx.currentTime >= this.turn.firstStart); }
  // Stops the current reply now and returns {id, played} for reporting, or null if nothing was pending.
  stop() {
    const t = this.turn; if (!t || t.stopped || t.completed) return null;
    const played = this.played(t); t.stopped = true;
    for (const b of t.buffers) { try { b.src.onended = null; b.src.stop(); } catch {} }
    return { id: t.id, played, started: t.firstStart !== null };
  }
  dispose() {
    this.stop();
    for (const strip of Object.values(this.strips)) strip.dispose();
    for (const node of [this.out, this.analyser]) node.disconnect();
  }
  level() { return rms(this.analyser, this.buf); }
}
