import { voiceStrip } from './audio.js';
export class Broadcast {
  constructor({ canvas, getAudio, ensureDevices, request, notify }) {
    Object.assign(this, { canvas, getAudio, ensureDevices, request, notify });
    this.active = false; this.pending = 0; this.token = 0;
    // Optional and advanced, so it lives collapsed near the end of Settings, styled like the other sections.
    const section = document.createElement('details'); section.id = 'broadcast-settings'; section.className = 'more'; section.open = true;
    section.innerHTML = `<summary>Stream to X</summary>
      <p class="fine">1080p · 30 fps · all voices. Only the call frame is sent.</p>
      <label>X RTMPS server<input id="stream-url" type="url" autocomplete="off" spellcheck="false" placeholder="RTMPS server from X Live Studio"></label>
      <p id="stream-key-state" class="fine">The stream key stays in the backend: run <code>./interview stream-key set</code>.</p>
      <div class="checks"><label class="check inline"><input id="stream-quiet" type="checkbox" checked> Reduce microphone noise during silence</label></div>
      <button id="stream-calibrate" class="secondary" type="button">Calibrate quiet room (3 seconds)</button>
      <p id="stream-level" class="fine">Microphone meter appears while sending.</p>
      <div class="row two"><button id="stream-test" class="secondary" type="button">Test locally</button><button id="stream-start" class="secondary" type="button">Send to X</button><button id="stream-stop" class="secondary" type="button" disabled>Stop</button></div>
      <p id="stream-status" class="fine" role="status">Not sending</p>`;
    document.querySelector('#broadcast-mount').append(section);
    this.el = id => document.getElementById(id);
    // The server address is not secret, so it is remembered here; the key never reaches the page.
    try { this.el('stream-url').value = localStorage.getItem('claude-interview.stream-url') || ''; } catch {}
    this.el('stream-url').onchange = () => { try { localStorage.setItem('claude-interview.stream-url', this.el('stream-url').value.trim()); } catch {} };
    this.request('/api/broadcast/status').then(s => { if (s.key_set) this.el('stream-key-state').textContent = 'Stream key is set in the backend.'; }).catch(() => {});
    this.el('stream-test').onclick = () => this.start('test');
    this.el('stream-start').onclick = () => this.start('x');
    this.el('stream-stop').onclick = () => this.stop();
    this.el('stream-quiet').onchange = () => this.expander?.port.postMessage(this.el('stream-quiet').checked);
    this.el('stream-calibrate').onclick = async () => {
      try {
      if (!(await this.ensureDevices())) return;
      await this.getAudio().stream.getAudioTracks()[0]?.applyConstraints({ autoGainControl: false });
      await this.getAudio().ctx.resume(); await this.setupAudio(); this.sourcesChanged();
      this.quietSamples = []; this.el('stream-calibrate').disabled = true;
      this.setStatus('Stay quiet for 3 seconds…');
      setTimeout(() => {
        const samples = this.quietSamples; this.quietSamples = null;
        if (samples.length && Math.max(...samples) > -100) {
          samples.sort((a,b) => a-b); this.threshold = Math.max(-60, Math.min(-30, samples[Math.floor(samples.length * .8)] + 9));
          this.expander.port.postMessage({ threshold: this.threshold });
          localStorage.setItem('claude-interview.stream-threshold', String(this.threshold));
          this.setStatus(`Quiet room calibrated · threshold ${Math.round(this.threshold)} dBFS`);
        } else this.setStatus('No microphone signal detected. Check the microphone before calibrating.');
        this.el('stream-calibrate').disabled = false;
      }, 3000);
      } catch (e) { this.setStatus(e.message); this.notify(e.message, true); }
    };
    const chip = document.createElement('span'); chip.className = 'chip'; chip.id = 'stream-chip'; chip.hidden = true;
    document.querySelector('.chips').prepend(chip); this.chip = chip;
    this.guard = e => { e.preventDefault(); e.returnValue = ''; };
  }
  async setupAudio() {
    const { ctx } = this.getAudio();
    if (this.ctx === ctx) return;
    this.ctx = ctx; await ctx.audioWorklet.addModule('/stream-audio-worklet.js');
    this.highpass = ctx.createBiquadFilter(); this.highpass.type = 'highpass'; this.highpass.frequency.value = 75; this.highpass.Q.value = 0.7;
    this.expander = new AudioWorkletNode(ctx, 'stream-expander', { channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] });
    this.highpass.connect(this.expander);
    this.expander.port.onmessage = e => { this.quietSamples?.push(e.data.db); this.el('stream-level').textContent = `Mic ${Math.round(e.data.db)} dBFS · quiet reduction ${Math.round(-e.data.reduction)} dB`; };
    this.expander.port.postMessage(this.el('stream-quiet').checked);
    this.threshold = Number(localStorage.getItem('claude-interview.stream-threshold')) || -48;
    this.expander.port.postMessage({ threshold: this.threshold });
    this.micGain = ctx.createGain(); this.micGain.gain.value = 0.85;
    this.expander.connect(this.micGain);
    this.voiceGain = ctx.createGain(); this.voiceGain.gain.value = 0.85;
    this.mixStrip = voiceStrip(ctx);
    this.micGain.connect(this.mixStrip.input); this.voiceGain.connect(this.mixStrip.input);
    this.dest = ctx.createMediaStreamDestination(); this.mixStrip.output.connect(this.dest);
  }
  sourcesChanged() {
    if (!this.highpass) return;
    const { mic, player } = this.getAudio();
    if (this.micSource !== mic?.mixGain) {
      try { this.micSource?.disconnect(this.highpass); } catch {}
      this.micSource = mic?.mixGain; this.micSource?.connect(this.highpass);
    }
    if (this.voiceSource !== player?.out) {
      try { this.voiceSource?.disconnect(this.voiceGain); } catch {}
      this.voiceSource = player?.out; this.voiceSource?.connect(this.voiceGain);
    }
  }
  setStatus(text) { this.el('stream-status').textContent = text; }
  async start(mode) {
    if (this.active || this.starting) return;
    this.starting = true;
    try {
      this.setStatus('Preparing audio…');
      if (!(await this.ensureDevices())) throw new Error('Camera and microphone are unavailable.');
      const audioContext = this.getAudio().ctx;
      await audioContext.resume();
      await this.setupAudio(); this.sourcesChanged();
      const { stream } = this.getAudio();
      // Do not let automatic gain raise room hiss during pauses.
      await stream.getAudioTracks()[0]?.applyConstraints({ autoGainControl: false }).catch(() => {});
      const mime = ['video/webm;codecs=h264,opus', 'video/webm;codecs=vp8,opus'].find(x => MediaRecorder.isTypeSupported(x));
      if (!mime) throw new Error('This browser cannot encode the stream.');
      this.setStatus('Starting encoder…');
      const result = await this.request('/api/broadcast/start', { mode, url: this.el('stream-url').value.trim() });
      this.id = result.id; this.mode = mode; this.active = true; this.seq = 0; this.pending = 0; this.queue = Promise.resolve();
      const token = ++this.token;
      this.capture = this.canvas.captureStream(30);
      this.recorder = new MediaRecorder(new MediaStream([...this.capture.getVideoTracks(), ...this.dest.stream.getAudioTracks()]), { mimeType: mime, videoBitsPerSecond: 12_000_000, audioBitsPerSecond: 192000 });
      this.recorder.ondataavailable = e => {
        if (!e.data.size || this.failed) return;
        if (++this.pending > 32) { this.fail(new Error('Encoder fell behind; stopped to avoid delayed audio.')); return; }
        const seq = this.seq++;
        this.queue = this.queue.then(() => this.request(`/api/broadcast/chunk?id=${this.id}&seq=${seq}`, e.data, 15000))
          .catch(error => this.fail(error)).finally(() => this.pending--);
      };
      this.recorder.onerror = e => this.fail(e.error || new Error('Browser encoder failed.'));
      this.failed = false; this.recorder.start(250);
      this.el('stream-test').disabled = this.el('stream-start').disabled = true; this.el('stream-stop').disabled = false;
      this.chip.hidden = false; this.chip.textContent = mode === 'test' ? 'Local stream test' : 'Sending to X';
      this.setStatus(mode === 'test' ? 'Recording a 12-second local check…' : 'Connecting to X…');
      addEventListener('beforeunload', this.guard);
      this.poll = setInterval(async () => { try {
        const s = await this.request('/api/broadcast/status'); if (token !== this.token || !this.active) return;
        if (s.state === 'error') return this.fail(new Error(s.error));
        if (s.state === 'sending') this.setStatus(`${mode === 'test' ? 'Local check' : 'Sending to X'} · 1080p · ${s.frames} frames · ${Math.round(s.fps)} fps`);
      } catch (e) { if (this.active) this.fail(e); } }, 2000);
      if (mode === 'test') this.testTimer = setTimeout(() => this.stop(), 12000);
      this.wakeLock = await navigator.wakeLock?.request('screen').catch(() => null);
    } catch (e) { this.setStatus(e.message); this.notify(e.message, true); if (this.active) await this.stop(); }
    finally { this.starting = false; }
  }
  fail(error) {
    if (this.failed) return; this.failed = true;
    this.failure = error.message; this.notify(`Stream stopped: ${error.message}`, true);
    // Let the failing upload chain settle before draining it in stop().
    setTimeout(() => this.stop(), 0);
  }
  async stop() {
    if (!this.active || this.stopping) return;
    this.stopping = true; clearInterval(this.poll); clearTimeout(this.testTimer);
    try {
      if (this.recorder?.state !== 'inactive') await new Promise(resolve => { this.recorder.addEventListener('stop', resolve, { once: true }); this.recorder.stop(); });
      await this.queue;
      const result = await this.request('/api/broadcast/stop', {});
      this.setStatus(this.failed ? this.failure : result.error || (this.mode === 'test' ? `Local check saved · ${result.frames} frames` : 'Not sending'));
    } catch (e) { this.setStatus(e.message); }
    finally {
      this.active = false; this.stopping = false; this.token++; this.capture?.getTracks().forEach(t => t.stop());
      this.el('stream-test').disabled = this.el('stream-start').disabled = false; this.el('stream-stop').disabled = true;
      this.chip.hidden = true; removeEventListener('beforeunload', this.guard); this.wakeLock?.release();
    }
  }
}
