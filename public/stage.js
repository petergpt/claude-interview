// The recorded frame: a 1920×1080 canvas holding both sides of the conversation.
// What is drawn here is exactly what `stage.webm` records.
//
// Claude's side is a thread of ink on paper. It is driven only by real application events:
//  - listening: ripples travel in from the user's side, scaled by their live microphone level;
//  - thinking:  while a reply is being prepared the thread gathers into a slow open loop.
//               It represents waiting, not a picture of reasoning;
//  - speaking:  ripples travel out toward the user, scaled by the level of audio actually playing;
//  - interrupted: the thread is briefly cut and closes again.

import { STYLES, drawAvatar, worldBackdrop } from './styles.js';
import * as seg from './segment.js';
import { drawBaseScene } from './scenes.js';
import { AGENTS, agentById } from './participants.js';
import { drawCodex } from './char-codex.js';

export const W = 1920, H = 1080;
const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';
const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif';
const C = {
  room: '#171513', tile: '#211e1b', paper: '#efe9dd', ink: '#bf5b3a', graphite: '#3a342f',
  caption: '#ece5d8', captionClaude: '#f1e2d3', muted: '#e5484d', label: 'rgba(20,18,16,.62)',
};
const TOP = 120, M = 56, GAP = 32, TILE_W = (W - 2 * M - GAP) / 2;

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const approach = (v, target, rate, dt) => v + (target - v) * (1 - Math.exp(-rate * dt));
const ease = x => x * x * (3 - 2 * x);

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function wrap(ctx, text, width) {
  const lines = []; let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > width && line) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export class Stage {
  constructor(canvas, video) {
    this.canvas = canvas; this.video = video;
    this.ctx = canvas.getContext('2d', { alpha: false });
    canvas.width = W; canvas.height = H;
    // Live inputs, written by the app from real events.
    this.claude = 'offline';          // offline | ready | listening | waiting | thinking | speaking | ended | error
    this.userSpeaking = false; this.userMuted = false; this.cameraOn = false; this.mirror = false; this.showCaptions = true;
    this.levels = Object.fromEntries(['user', ...AGENTS.map(a => a.id)].map(id => [id, () => 0]));
    this.agentIds = ['claude']; this.codex = 'ready'; this.codexMood = null; this.codexMouth = { open: 0, round: 0 };
    this.cs = { think: 0, listen: 0, listenState: 0, speak: 0, alive: 1, mouth: { open: 0, round: 0 } };
    this.captions = Object.fromEntries(['user', ...AGENTS.map(a => a.id)].map(id => [id, { text: '', at: 0 }]));
    this.interruptedAt = -1e9;
    // Smoothed drawing state.
    this.s = { think: 0, listen: 0, listenState: 0, speak: 0, alive: 0, captions: 1, userRing: 0, rot: 0, scene: 0, bespoke: 0, mouth: { open: 0, round: 0 } };
    this.style = 'cafe'; this.mood = null; this.mouthTarget = { open: 0, round: 0 };
    // Scene layer: a new picture (a quick sketch, then its finished version) waits as `pending` until its first frame has
    // drawn; only then does it switch the screen on or crossfade over what is showing. A library scene stands in only
    // when a sketch fails and nothing is on screen.
    this.scene = null; this.pending = null; this.fade = null; this.sceneHidden = false;
    this.background = 'off';                 // The user's background: off | blur | match (the conversation's world)
    const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
    this.person = mk(TILE_W, 968); this.soft = mk(Math.round(TILE_W / 5), Math.round(968 / 5));
    this.grains = [0, 1, 2].map(() => { const c = mk(256, 256), g = c.getContext('2d'), img = g.createImageData(256, 256); for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; } g.putImageData(img, 0, 0); return c; });
    this.vignette = (() => { const c = mk(W, H), g = c.getContext('2d'), r = g.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, W * 0.62); r.addColorStop(0, 'rgba(0,0,0,0)'); r.addColorStop(1, 'rgba(0,0,0,0.32)'); g.fillStyle = r; g.fillRect(0, 0, W, H); return c; })();
    this.layer = document.createElement('canvas'); this.layer.width = TILE_W; this.layer.height = 968;
    this.last = performance.now();
    this.grain = this.makeGrain();
  }
  interrupted(speaker = 'claude') { this[speaker === 'codex' ? 'codexInterruptedAt' : 'interruptedAt'] = performance.now(); }
  setMood(name, speaker = 'claude') { this[speaker === 'codex' ? 'codexMood' : 'mood'] = { name, at: performance.now() }; }
  getMood(speaker) { return speaker === 'codex' ? this.codexMood : this.mood; }
  setMouth(speaker, mouth) { this[speaker === 'codex' ? 'codexMouth' : 'mouthTarget'] = mouth; }
  pokeCodex() { this.setMood(['giggle', 'wave', 'curious', 'delight'][Math.floor(Math.random() * 4)], 'codex'); }
  get claudeEnabled() { return this.agentIds.includes('claude'); }
  get codexEnabled() { return this.agentIds.includes('codex'); }
  participants() { return ['user', ...this.agentIds]; }
  tileWidth() { const count = this.participants().length; return (W - 2 * M - GAP * (count - 1)) / count; }
  tileX(speaker) { return M + this.participants().indexOf(speaker) * (this.tileWidth() + GAP); }
  // A click on Claude: a giggle or a start; poked too often in a short while, it gets fed up.
  poke() {
    const now = performance.now(); this.pokes = (this.pokes || []).filter(p => now - p < 6000); this.pokes.push(now);
    this.setMood(this.pokes.length >= 4 ? 'fed up' : ['giggle', 'surprised', 'giggle', 'delight'][Math.floor(Math.random() * 4)]);
  }
  // Is a canvas point inside Claude's tile? (for pokes)
  hitClaude(px, py) { const w = this.tileWidth(), x = M + w + GAP; return this.claudeEnabled && px >= x && px <= x + w && py >= TOP && py <= M + 968; }
  hitCodex(px, py) { const x = this.tileX('codex'); return this.codexEnabled && px >= x && px <= W - M && py >= TOP && py <= M + 968; }
  backchannel() { this.nodAt = performance.now() / 1000; }
  sceneBase(h) { this.pending = h; }                                          // shown once its first frame has drawn
  sceneStandIn(id) {
    if (this.pending?.scene_id !== id) return;
    if (!this.scene || this.scene.leaving) { this.scene?.bitmap?.close(); this.scene = { id, base: this.pending, t0: performance.now(), bitmap: null, sketching: true, leaving: false }; this.s.bespoke = 0; this.glanceAt = performance.now() + 500; }
    this.pending = null;
  }
  sceneBitmap(id, bitmap) {
    if (this.pending?.scene_id === id) {
      this.fade?.bitmap?.close(); this.fade = { bitmap: this.scene?.bitmap || null, base: this.scene?.bitmap ? null : this.scene?.base, t0: this.scene?.t0, at: performance.now() };
      if (!this.pending.refine) this.glanceAt = performance.now();                 // a new picture draws a glance; its finished version doesn't
      this.scene = { id, base: this.pending, t0: performance.now(), bitmap, sketching: false, leaving: false }; this.pending = null; this.s.bespoke = 1; return;
    }
    if (this.scene?.id !== id) { bitmap.close(); return; }
    this.scene.bitmap?.close(); this.scene.bitmap = bitmap; this.scene.sketching = false;
  }
  sceneDone(id) { if (this.scene?.id === id) this.scene.sketching = false; if (this.pending?.scene_id === id) this.pending = null; }
  sceneClear() { if (this.scene) this.scene.leaving = true; this.pending = null; }
  backdropBitmap(id, bitmap) { if (this.backdrop?.id !== id) { this.backdrop?.bitmap?.close(); this.backdrop = { id, bitmap: null, at: performance.now() }; } this.backdrop.bitmap?.close(); this.backdrop.bitmap = bitmap; }
  backdropClear() { this.backdrop?.bitmap?.close(); this.backdrop = null; }
  codexBackdropBitmap(id, bitmap) {
    if (this.codexBackdrop?.id !== id) { this.codexBackdropFade?.bitmap?.close(); this.codexBackdropFade = this.codexBackdrop; this.codexBackdrop = { id, bitmap: null, at: performance.now() }; }
    this.codexBackdrop.bitmap?.close(); this.codexBackdrop.bitmap = bitmap;
  }
  codexBackdropClear() { this.codexBackdrop?.bitmap?.close(); this.codexBackdropFade?.bitmap?.close(); this.codexBackdrop = this.codexBackdropFade = null; }
  caption(who, text) { this.captions[who] = { text, at: performance.now() }; }

  makeGrain() {
    const g = document.createElement('canvas'); g.width = 512; g.height = 512;
    const x = g.getContext('2d'), img = x.createImageData(512, 512);
    for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = Math.random() < 0.5 ? 10 : 0; }
    x.putImageData(img, 0, 0); return g;
  }

  frame(now = performance.now()) {
    const dt = Math.min(0.1, (now - this.last) / 1000); this.last = now; this.dt = dt;
    const { ctx, s } = this, t = now / 1000;
    const pLevel = this.userMuted ? 0 : clamp(this.levels.user() * 9);
    const cLevel = clamp(this.levels.claude() * 6), xLevel = clamp(this.levels.codex() * 6);
    const cs = this.cs, xs = this.codex;
    cs.think = approach(cs.think, xs === 'thinking' ? 1 : 0, xs === 'thinking' ? 2 : 5, dt);
    cs.listenState = approach(cs.listenState, xs === 'listening' ? 1 : 0, 3, dt);
    cs.listen = approach(cs.listen, xs === 'listening' ? Math.max(pLevel, cLevel) : 0, 10, dt);
    cs.speak = approach(cs.speak, xs === 'speaking' ? xLevel : 0, 14, dt);
    cs.alive = approach(cs.alive, ['offline', 'ended', 'error'].includes(xs) ? .35 : 1, 2, dt);
    cs.mouth.open = approach(cs.mouth.open, xs === 'speaking' ? this.codexMouth.open : 0, 22, dt);
    cs.mouth.round = approach(cs.mouth.round, this.codexMouth.round, 16, dt);
    const st = this.claude;
    s.think = approach(s.think, st === 'thinking' ? 1 : 0, st === 'thinking' ? 1.6 : 4, dt);
    s.listen = approach(s.listen, st === 'listening' ? Math.max(pLevel, xLevel) : 0, 10, dt);
    s.speak = approach(s.speak, st === 'speaking' ? cLevel : 0, 14, dt);
    s.alive = approach(s.alive, ['offline', 'ended', 'error'].includes(st) ? 0.35 : 1, 2, dt);
    s.captions = approach(s.captions, this.showCaptions ? 1 : 0, 6, dt);
    s.userRing = approach(s.userRing, this.userSpeaking && !this.userMuted ? 1 : 0, 8, dt);
    s.rot += dt * (0.3 + 0.25 * s.think);
    s.listenState = approach(s.listenState, st === 'listening' ? 1 : 0, 3, dt);
    s.mouth.open = approach(s.mouth.open, st === 'speaking' ? this.mouthTarget.open : 0, 22, dt);
    s.mouth.round = approach(s.mouth.round, this.mouthTarget.round, 16, dt);
    const sc = this.scene;
    s.scene = approach(s.scene, sc && !sc.leaving && !this.sceneHidden ? 1 : 0, 2.5, dt);
    s.bespoke = approach(s.bespoke, sc?.bitmap ? 1 : 0, 1.5, dt);
    if (sc?.leaving && s.scene < 0.01) { sc.bitmap?.close(); this.scene = null; }

    const tileH = 788 + (904 - 788) * (1 - ease(s.captions));
    ctx.fillStyle = C.room; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 14; ctx.fillStyle = C.room;
    const tw = this.tileWidth(), positions = Array.from({ length: this.participants().length }, (_, i) => M + i * (tw + GAP));
    for (const tx of positions) { roundRect(ctx, tx, TOP, tw, tileH, 28); ctx.fill(); } ctx.restore();
    this.drawUser(M, TOP, tw, tileH, pLevel);
    const renderers = { claude: this.drawClaude, codex: this.drawCodex };
    for (const id of this.agentIds) {
      renderers[id]?.call(this, this.tileX(id), TOP, tw, tileH, t, now);
      this.agentPlate(this.tileX(id), TOP, tw, tileH, agentById(id)?.name || id, this[id], id === 'claude' ? '#e8ab87' : '#91b1ff');
    }
    if (s.captions > 0.01) this.drawCaptions(TOP + tileH + 26, now);
    // a filmic finish over the whole recorded frame: fine moving grain and a soft vignette
    ctx.save(); ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = 0.07;
    ctx.fillStyle = ctx.createPattern(this.grains[Math.floor(now / 42) % 3], 'repeat'); ctx.fillRect(0, 0, W, H); ctx.restore();
    ctx.drawImage(this.vignette, 0, 0);
  }

  drawUser(x, y, w, h, level) {
    const { ctx, video, s } = this;
    ctx.save(); roundRect(ctx, x, y, w, h, 28); ctx.clip();
    ctx.fillStyle = C.tile; ctx.fillRect(x, y, w, h);
    if (this.cameraOn && video.readyState >= 2 && video.videoWidth) {
      const scale = Math.max(w / video.videoWidth, h / video.videoHeight);
      const dw = video.videoWidth * scale, dh = video.videoHeight * scale;
      const vx = (w - dw) / 2, vy = (h - dh) / 2;
      if (this.background !== 'off') seg.segmentFrame(video);
      if (this.background !== 'off' && seg.ready) {
        // backdrop: a soft, out-of-focus version of either the camera itself (blur) or the conversation's world (match)
        const S = this.soft, sg = S.getContext('2d'), k = S.width / w;
        sg.save(); sg.clearRect(0, 0, S.width, S.height);
        if (this.background === 'blur') { if (this.mirror) { sg.translate(S.width, 0); sg.scale(-1, 1); } sg.drawImage(video, vx * k, vy * k, dw * k, dh * k); }
        else { const src = this.backdropSource(w, h); if (src.under && src.fade < 1) sg.drawImage(src.under, 0, 0, S.width, S.height); sg.globalAlpha = src.fade ?? 1; sg.drawImage(src.img, src.sx, src.sy, src.sw, src.sh, 0, 0, S.width, S.height); sg.globalAlpha = 1; }
        sg.restore();
        ctx.imageSmoothingQuality = 'high'; ctx.drawImage(S, 0, 0, S.width, S.width * h / w, x, y, w, h);
        const dim = ctx.createLinearGradient(0, y, 0, y + h); dim.addColorStop(0, 'rgba(0,0,0,0.05)'); dim.addColorStop(1, 'rgba(0,0,0,0.3)'); ctx.fillStyle = dim; ctx.fillRect(x, y, w, h);
        // The user, cut out with the segmentation mask
        const P = this.person, pg = P.getContext('2d');
        pg.save(); pg.clearRect(0, 0, P.width, P.height);
        if (this.mirror) { pg.translate(w, 0); pg.scale(-1, 1); }
        pg.drawImage(video, vx, vy, dw, dh);
        pg.globalCompositeOperation = 'destination-in'; pg.imageSmoothingQuality = 'high'; pg.drawImage(seg.mask, vx, vy, dw, dh);
        pg.restore();
        ctx.drawImage(P, 0, 0, w, h, x, y, w, h);
      } else {
        if (this.mirror) { ctx.translate(2 * x + w, 0); ctx.scale(-1, 1); }
        ctx.drawImage(video, x + vx, y + vy, dw, dh);
      }
    } else {
      const cx = x + w / 2, cy = y + h / 2 - 20, r = 92;
      ctx.strokeStyle = `rgba(236,229,216,${0.12 + 0.5 * level})`; ctx.lineWidth = 2 + 6 * level;
      ctx.beginPath(); ctx.arc(cx, cy, r + 10 + 18 * level, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#2d2925'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.caption; ctx.font = `64px ${SERIF}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText((this.userName || 'You')[0].toUpperCase(), cx, cy + 4);
    }
    ctx.restore();
    // Active-speaker edge: driven by the backend's live transcription of the user, not by raw loudness.
    if (s.userRing > 0.01) {
      ctx.save(); roundRect(ctx, x + 2, y + 2, w - 4, h - 4, 27);
      ctx.strokeStyle = `rgba(236,229,216,${0.75 * s.userRing})`; ctx.lineWidth = 4; ctx.stroke(); ctx.restore();
    }
    this.nameplate(x, y - 18, this.userName || 'You', this.userMuted ? 'muted' : '', true);
  }

  nameplate(x, bottom, name, note, dark) {
    const { ctx } = this;
    ctx.save(); ctx.font = `600 40px ${SANS}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const limit = this.tileWidth() - (note ? 160 : 84);
    if (ctx.measureText(name).width > limit) { while (name.length && ctx.measureText(name + '…').width > limit) name = name.slice(0, -1); name += '…'; }
    const nw = ctx.measureText(name).width;
    ctx.font = `600 20px ${SANS}`; const tw = note ? ctx.measureText(note.toUpperCase()).width + 30 : 0;
    const w = 40 + nw + tw, h = 62, y = bottom - h;
    // Names live above the artwork, on the quiet frame margin.
    ctx.font = `600 40px ${SANS}`; ctx.fillStyle = dark ? C.caption : C.graphite; ctx.fillText(name, x + 4, y + h / 2 + 1);
    if (note) {
      ctx.font = `600 20px ${SANS}`; ctx.fillStyle = C.muted;
      ctx.letterSpacing = '1px'; ctx.fillText(note.toUpperCase(), x + 4 + nw + 18, y + h / 2 + 1);
    }
    ctx.restore();
  }

  // Claude's tile, laid out like a talk-show set. Claude is the host and stays large. When a picture is up, Claude
  // eases to the left and the picture plays on a screen mounted on the wall behind (for looks with their own set,
  // such as Café) or on a screen in front (for the rest). Claude glances at the screen when a new picture appears.
  drawClaude(x, y, w, h, t, now) {
    const { ctx, s } = this, st = STYLES[this.style] || STYLES.clawd, mix = ease(clamp(s.scene));
    ctx.save(); roundRect(ctx, x, y, w, h, 28); ctx.clip();
    ctx.fillStyle = st.paper; ctx.fillRect(x, y, w, h);
    if (st.grain) { this.pattern ||= ctx.createPattern(this.grain, 'repeat'); ctx.fillStyle = this.pattern; ctx.fillRect(x, y, w, h); }
    const since = now - this.interruptedAt, sinceGlance = now - (this.glanceAt ?? -1e9), glance = sinceGlance >= 0 && sinceGlance < 1700 && mix > 0.5;
    const a = { t, think: ease(clamp(s.think)), listen: s.listen, listenState: s.listenState, speak: s.speak, alive: s.alive, rot: s.rot,
      gap: since < 900 ? 0.09 * (1 - since / 900) ** 2 : 0, mouth: s.mouth, dt: this.dt, nod: this.nodAt, mood: this.mood && { name: this.mood.name, age: (now - this.mood.at) / 1000 },
      // a glance up at the screen when a new picture appears; outside a turn, the eyes follow the cursor
      pointer: glance ? { x: 0.95, y: -0.55 } : this.pointer && now - this.pointer.at < 2500 && !['listening', 'thinking', 'speaking'].includes(this.claude)
        ? { x: (this.pointer.x - (x + w / 2)) / (w * 0.7), y: (this.pointer.y - (y + h * 0.36)) / (h * 0.7) } : null };
    // switching looks crossfades over 0.7 s instead of cutting
    if (this.style !== this.shownStyle) { this.prevStyle = this.shownStyle; this.shownStyle = this.style; this.styleAt = now; }
    const sw = this.prevStyle ? clamp((now - this.styleAt) / 700) : 1; if (sw >= 1) this.prevStyle = null;
    if (mix < 0.001) {
      if (this.prevStyle) drawAvatar(ctx, this.prevStyle, { x, y, w, h }, { ...a, alive: a.alive * (1 - ease(sw)) });
      drawAvatar(ctx, this.style, { x, y, w, h }, { ...a, alive: a.alive * (this.prevStyle ? ease(sw) : 1) });
    } else {
      const S = 1 - 0.12 * mix, host = { x: x + w / 2 - (w * S) / 2 - 0.2 * w * mix, y: y + h - h * S, w: w * S, h: h * S };
      const mw = w * 0.5, mh = mw * 560 / 888, screen = { x: x + w - mw - w * 0.03, y: y + h * 0.035, w: mw, h: mh };
      if (st.set) { st.set(ctx, { x, y, w, h }, t); this.drawScreen(screen, mix, t, now, st); drawAvatar(ctx, this.style, host, { ...a, noSet: true }); }
      else { ctx.drawImage(worldBackdrop(this.style, Math.round(w), Math.round(h)), x, y, w, h); drawAvatar(ctx, this.style, host, a); this.drawScreen(screen, mix, t, now, st); }
    }
    ctx.restore();
  }

  drawCodex(x, y, w, h, t, now) {
    const { ctx, cs } = this, since = now - (this.codexInterruptedAt ?? -1e9);
    ctx.save(); roundRect(ctx, x, y, w, h, 28); ctx.clip();
    const backdropMix = this.codexBackdrop ? ease(clamp((now - this.codexBackdrop.at) / 1600)) : 0;
    if (backdropMix >= 1 && this.codexBackdropFade) { this.codexBackdropFade.bitmap?.close(); this.codexBackdropFade = null; }
    drawCodex(ctx, { x, y, w, h }, { t, dt: this.dt, ...cs, rot: t * .3,
      backdrop: this.sceneHidden ? null : this.codexBackdrop?.bitmap, backdropMix, previousBackdrop: this.sceneHidden ? null : this.codexBackdropFade?.bitmap,
      gap: since < 900 ? .09 * (1 - since / 900) ** 2 : 0,
      nod: this.nodAt, mood: this.codexMood && { name: this.codexMood.name, age: (now - this.codexMood.at) / 1000 },
      pointer: this.pointer && now - this.pointer.at < 2500 && !['thinking', 'speaking'].includes(this.codex)
        ? { x: (this.pointer.x - x - w / 2) / w, y: (this.pointer.y - y - h * .4) / h } : null });
    ctx.restore();
  }
  agentPlate(x, y, w, h, name, state, color) {
    const { ctx } = this, speaking = state === 'speaking';
    if (speaking) { ctx.save(); roundRect(ctx, x + 2, y + 2, w - 4, h - 4, 27); ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.stroke(); ctx.restore(); }
    ctx.save(); ctx.font = `600 40px ${SANS}`;
    const note = state === 'thinking' ? 'Thinking' : state === 'speaking' ? 'Speaking' : state === 'listening' ? 'Listening' : state === 'offline' ? 'Offline' : state === 'error' ? 'Disconnected' : state === 'ended' ? 'Call ended' : 'Ready';
    const nw = ctx.measureText(name).width; ctx.font = `22px ${SANS}`;
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x + 8, y - 49, 6, 0, Math.PI * 2); ctx.fill();
    ctx.font = `600 40px ${SANS}`; ctx.fillStyle = '#fff9f0'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillText(name, x + 29, y - 49);
    ctx.font = `22px ${SANS}`; ctx.fillStyle = '#e6e9edb0'; ctx.textAlign = 'right'; ctx.fillText(note, x + w - 4, y - 49);
    ctx.restore();
  }

  // The set's screen: a dark bezel with a soft shadow and glass glare. It switches on like a TV (a bright line opening
  // out from the middle) and shows the current picture, crossfading from the previous one.
  drawScreen(r, mix, t, now, st) {
    const { ctx, s } = this, sc = this.scene, on = clamp(mix * 1.5), B = 9;
    ctx.save(); ctx.globalAlpha = clamp(mix * 2);
    ctx.shadowColor = 'rgba(20,10,5,0.45)'; ctx.shadowBlur = 30; ctx.shadowOffsetY = 12;
    roundRect(ctx, r.x - B, r.y - B, r.w + 2 * B, r.h + 2 * B, 14); ctx.fillStyle = '#1d1916'; ctx.fill(); ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(255,236,210,0.16)'; ctx.lineWidth = 1.5; ctx.stroke();
    roundRect(ctx, r.x, r.y, r.w, r.h, 6); ctx.fillStyle = '#0d0b0a'; ctx.fill(); ctx.clip();
    const open = ease(on), ch = r.h * open, cy = r.y + r.h / 2;
    ctx.beginPath(); ctx.rect(r.x, cy - ch / 2, r.w, Math.max(2, ch)); ctx.clip();
    const cover = bmp => { const k = Math.max(r.w / bmp.width, r.h / bmp.height), bw = bmp.width * k, bh = bmp.height * k; ctx.drawImage(bmp, r.x + (r.w - bw) / 2, r.y + (r.h - bh) / 2, bw, bh); };
    const library = (base, t0) => { const L = this.layer, lx = L.getContext('2d'); lx.clearRect(0, 0, L.width, L.height); drawBaseScene(lx, base, { x: 0, y: 0, w: r.w, h: r.h }, (now - t0) / 1000, st, s.speak); ctx.drawImage(L, 0, 0, r.w, r.h, r.x, r.y, r.w, r.h); };
    const f = this.fade, fk = f ? clamp((now - f.at) / 1200) : 1;
    if (f && fk < 1) { if (f.bitmap) cover(f.bitmap); else if (f.base) library(f.base, f.t0); }
    else if (f) { f.bitmap?.close(); this.fade = null; }
    const base = f ? ease(fk) : 1;
    if (sc) {
      if (s.bespoke < 0.999) { ctx.globalAlpha = base * (1 - ease(s.bespoke)); library(sc.base, sc.t0); }
      if (sc.bitmap) { ctx.globalAlpha = base * ease(s.bespoke); cover(sc.bitmap); }
    }
    ctx.globalAlpha = 1;
    if (on < 1) { ctx.fillStyle = `rgba(255,248,235,${0.9 * (1 - on)})`; ctx.fillRect(r.x, cy - Math.max(1.5, ch / 2), r.w, Math.max(3, ch)); }   // the switch-on line
    const glare = ctx.createLinearGradient(r.x, r.y, r.x + r.w * 0.6, r.y + r.h); glare.addColorStop(0, 'rgba(255,255,255,0.10)'); glare.addColorStop(0.45, 'rgba(255,255,255,0)'); glare.addColorStop(1, 'rgba(255,255,255,0.03)');
    ctx.fillStyle = glare; ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  // What stands behind the user in "match" mode: their own generated backdrop (separate from Claude's scene),
  // or, until the first one arrives, the world of Claude's current look.
  backdropSource(w, h) {
    const world = worldBackdrop(this.style, Math.round(w), Math.round(h)), b = this.backdrop;
    if (!b?.bitmap) return { img: world, sx: 0, sy: 0, sw: world.width, sh: world.height };
    return { img: b.bitmap, sx: 0, sy: 0, sw: b.bitmap.width, sh: b.bitmap.height, under: world, fade: clamp((performance.now() - b.at) / 1800) };
  }

  drawCaptions(top, now) {
    const { ctx, s } = this;
    const draw = (who, x, font, color) => {
      const c = this.captions[who]; if (!c.text) return;
      const age = now - c.at, alpha = s.captions * clamp(1 - (age - 4500) / 900);
      if (alpha <= 0) return;
      ctx.save(); ctx.globalAlpha = alpha; ctx.font = font; ctx.fillStyle = color; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      const lines = wrap(ctx, c.text, this.tileWidth() - 40).slice(-2);
      lines.forEach((line, i) => ctx.fillText(line, x + 20, top + i * 44));
      ctx.restore();
    };
    draw('user', M, `31px ${SANS}`, C.caption);
    for (const id of this.agentIds) draw(id, this.tileX(id), `${this.agentIds.length > 1 ? 28 : 33}px ${SANS}`, id === 'claude' ? C.captionClaude : '#d5dcff');
  }
}
