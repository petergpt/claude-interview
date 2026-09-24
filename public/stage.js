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

export const W = 1920, H = 1080;
const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';
const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif';
const C = {
  room: '#171513', tile: '#211e1b', paper: '#efe9dd', ink: '#bf5b3a', graphite: '#3a342f',
  caption: '#ece5d8', captionClaude: '#f1e2d3', muted: '#e5484d', label: 'rgba(20,18,16,.62)',
};
const M = 56, GAP = 32, TILE_W = (W - 2 * M - GAP) / 2;

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
    this.levels = { user: () => 0, claude: () => 0 };
    this.captions = { user: { text: '', at: 0 }, claude: { text: '', at: 0 } };
    this.interruptedAt = -1e9;
    // Smoothed drawing state.
    this.s = { think: 0, listen: 0, listenState: 0, speak: 0, alive: 0, captions: 1, userRing: 0, rot: 0, scene: 0, bespoke: 0, mouth: { open: 0, round: 0 } };
    this.style = 'clawd'; this.mood = null; this.mouthTarget = { open: 0, round: 0 };
    // Scene layer: a library scene appears first, then the bespoke bitmap stream crossfades over it.
    this.scene = null; this.sceneHidden = false;
    this.background = 'off';                 // The user's background: off | blur | match (the conversation's world)
    const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
    this.person = mk(TILE_W, 968); this.soft = mk(Math.round(TILE_W / 5), Math.round(968 / 5));
    this.grains = [0, 1, 2].map(() => { const c = mk(256, 256), g = c.getContext('2d'), img = g.createImageData(256, 256); for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; } g.putImageData(img, 0, 0); return c; });
    this.vignette = (() => { const c = mk(W, H), g = c.getContext('2d'), r = g.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, W * 0.62); r.addColorStop(0, 'rgba(0,0,0,0)'); r.addColorStop(1, 'rgba(0,0,0,0.32)'); g.fillStyle = r; g.fillRect(0, 0, W, H); return c; })();
    this.layer = document.createElement('canvas'); this.layer.width = TILE_W; this.layer.height = 968;
    this.last = performance.now();
    this.grain = this.makeGrain();
  }
  interrupted() { this.interruptedAt = performance.now(); }
  setMood(name) { this.mood = { name, at: performance.now() }; }
  backchannel() { this.nodAt = performance.now() / 1000; }
  sceneBase(h) { this.scene?.bitmap?.close(); this.scene = { id: h.scene_id, base: h, t0: performance.now(), bitmap: null, sketching: true, leaving: false }; this.s.bespoke = 0; }
  sceneBitmap(id, bitmap) { if (this.scene?.id !== id) { bitmap.close(); return; } this.scene.bitmap?.close(); this.scene.bitmap = bitmap; this.scene.sketching = false; }
  sceneDone(id) { if (this.scene?.id === id) this.scene.sketching = false; }
  sceneClear() { if (this.scene) this.scene.leaving = true; }
  backdropBitmap(id, bitmap) { if (this.backdrop?.id !== id) { this.backdrop?.bitmap?.close(); this.backdrop = { id, bitmap: null, at: performance.now() }; } this.backdrop.bitmap?.close(); this.backdrop.bitmap = bitmap; }
  backdropClear() { this.backdrop?.bitmap?.close(); this.backdrop = null; }
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
    const cLevel = clamp(this.levels.claude() * 6);
    const st = this.claude;
    s.think = approach(s.think, st === 'thinking' ? 1 : 0, st === 'thinking' ? 1.6 : 4, dt);
    s.listen = approach(s.listen, st === 'listening' ? pLevel : 0, 10, dt);
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

    const tileH = 852 + (968 - 852) * (1 - ease(s.captions));
    ctx.fillStyle = C.room; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 14; ctx.fillStyle = C.room;
    for (const tx of [M, M + TILE_W + GAP]) { roundRect(ctx, tx, M, TILE_W, tileH, 28); ctx.fill(); } ctx.restore();
    this.drawUser(M, M, TILE_W, tileH, pLevel);
    this.drawClaude(M + TILE_W + GAP, M, TILE_W, tileH, t, now);
    if (s.captions > 0.01) this.drawCaptions(M + tileH + 26, now);
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
      ctx.fillText('P', cx, cy + 4);
    }
    ctx.restore();
    // Active-speaker edge: driven by the backend's live transcription of the user, not by raw loudness.
    if (s.userRing > 0.01) {
      ctx.save(); roundRect(ctx, x + 2, y + 2, w - 4, h - 4, 27);
      ctx.strokeStyle = `rgba(236,229,216,${0.75 * s.userRing})`; ctx.lineWidth = 4; ctx.stroke(); ctx.restore();
    }
    this.nameplate(x + 22, y + h - 22, this.userName || 'You', this.userMuted ? 'muted' : '', true);
  }

  nameplate(x, bottom, name, note, dark) {
    const { ctx } = this;
    ctx.save(); ctx.font = `500 24px ${SANS}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const nw = ctx.measureText(name).width;
    ctx.font = `600 16px ${SANS}`; const tw = note ? ctx.measureText(note.toUpperCase()).width + 26 : 0;
    const w = 28 + nw + tw, h = 44, y = bottom - h;
    if (dark) { roundRect(ctx, x, y, w, h, 22); ctx.fillStyle = C.label; ctx.fill(); }
    ctx.font = `500 24px ${SANS}`; ctx.fillStyle = dark ? C.caption : C.graphite; ctx.fillText(name, x + 14, y + h / 2 + 1);
    if (note) {
      ctx.font = `600 16px ${SANS}`; ctx.fillStyle = C.muted;
      ctx.letterSpacing = '1.5px'; ctx.fillText(note.toUpperCase(), x + 14 + nw + 14, y + h / 2 + 1);
    }
    ctx.restore();
  }

  drawClaude(x, y, w, h, t, now) {
    const { ctx, s } = this, st = STYLES[this.style] || STYLES.clawd, sc = this.scene, mix = ease(clamp(s.scene));
    ctx.save(); roundRect(ctx, x, y, w, h, 28); ctx.clip();
    ctx.fillStyle = st.paper; ctx.fillRect(x, y, w, h);
    if (st.grain) { this.pattern ||= ctx.createPattern(this.grain, 'repeat'); ctx.fillStyle = this.pattern; ctx.fillRect(x, y, w, h); }
    const since = now - this.interruptedAt;
    const a = { t, think: ease(clamp(s.think)), listen: s.listen, listenState: s.listenState, speak: s.speak, alive: s.alive, rot: s.rot,
      gap: since < 900 ? 0.09 * (1 - since / 900) ** 2 : 0, mouth: s.mouth, dt: this.dt, nod: this.nodAt, mood: this.mood && { name: this.mood.name, age: (now - this.mood.at) / 1000 } };
    const cam = { cx: x + 128, cy: y + h - 128, r: 96 };            // Claude's cameo while a scene is up
    if (sc && mix > 0.001) {
      ctx.save();
      if (mix < 0.999) {
        // the scene spreads out from Claude like ink bleeding into paper
        const R = mix * Math.hypot(w, h) * 1.08, P = new Path2D();
        for (let i = 0; i <= 64; i++) { const an = i / 64 * Math.PI * 2, wob = 1 + 0.07 * Math.sin(an * 5 + t * 2) + 0.05 * Math.sin(an * 11 - t * 3); P.lineTo(cam.cx + Math.cos(an) * R * wob, cam.cy + Math.sin(an) * R * wob); }
        ctx.clip(P);
      }
      const L = this.layer, lx = L.getContext('2d'), box = { x: 0, y: 0, w, h };
      lx.clearRect(0, 0, L.width, L.height);
      if (s.bespoke < 0.999) drawBaseScene(lx, sc.base, box, (now - sc.t0) / 1000, st, s.speak);
      ctx.globalAlpha = 1 - ease(s.bespoke); ctx.drawImage(L, 0, 0, w, h, x, y, w, h);
      if (sc.bitmap) {
        const k = Math.max(w / sc.bitmap.width, h / sc.bitmap.height), bw = sc.bitmap.width * k, bh = sc.bitmap.height * k;
        ctx.globalAlpha = ease(s.bespoke); ctx.drawImage(sc.bitmap, x + (w - bw) / 2, y + (h - bh) / 2, bw, bh);
      }
      ctx.restore();
    }
    // switching looks crossfades over 0.7 s instead of cutting
    if (this.style !== this.shownStyle) { this.prevStyle = this.shownStyle; this.shownStyle = this.style; this.styleAt = now; }
    const sw = this.prevStyle ? clamp((now - this.styleAt) / 700) : 1; if (sw >= 1) this.prevStyle = null;
    if (mix < 0.999) {
      if (this.prevStyle) drawAvatar(ctx, this.prevStyle, { x, y, w, h }, { ...a, alive: a.alive * (1 - mix) * (1 - ease(sw)) });
      drawAvatar(ctx, this.style, { x, y, w, h }, { ...a, alive: a.alive * (1 - mix) * (this.prevStyle ? ease(sw) : 1) });
    }
    if (mix > 0.001) {
      // Claude stays present in a round cameo, with a soft shadow and a thin ring in its own colour
      ctx.save(); ctx.globalAlpha = mix;
      ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 8;
      ctx.fillStyle = st.paper; ctx.beginPath(); ctx.arc(cam.cx, cam.cy, cam.r * (0.85 + 0.15 * mix), 0, Math.PI * 2); ctx.fill();
      ctx.shadowColor = 'transparent'; ctx.clip();
      drawAvatar(ctx, this.style, { x: cam.cx - cam.r * 1.25, y: cam.cy - cam.r * 1.05, w: cam.r * 2.5, h: cam.r * 2.1 }, { ...a, mini: true, alive: a.alive * mix });
      ctx.restore();
      ctx.save(); ctx.globalAlpha = mix * 0.8; ctx.strokeStyle = st.ink; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(cam.cx, cam.cy, cam.r * (0.85 + 0.15 * mix), 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }
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
      const lines = wrap(ctx, c.text, TILE_W - 40).slice(-2);
      lines.forEach((line, i) => ctx.fillText(line, x + 20, top + i * 44));
      ctx.restore();
    };
    draw('user', M, `31px ${SANS}`, C.caption);
    draw('claude', M + TILE_W + GAP, `33px ${SERIF}`, C.captionClaude);
  }
}
