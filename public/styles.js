// Claude's characters. Every one is driven by the same real inputs:
//   think   0..1  a reply is being prepared (waiting; not a picture of reasoning)
//   listen  0..1  the user's live mic level while the backend is listening; listenState 0..1 while listening
//   speak   0..1  level of Claude's audio that is actually playing
//   mouth   {open 0..1, round 0..1} from ElevenLabs character timing of the audio being played
//   mood    {name, age} when a delivery cue such as [laughs] or [sighs] is actually played
//   gap     0..1  briefly >0 after an interruption
// Keys and backgrounds match SCENE_STYLES in src/director.mjs, so generated scenes share each world.

import { express } from './expression.js';
import { clawd3d } from './char-clawd.js';
import { pixelClawd } from './char-pixel.js';
import { cafeCharacter, background as cafeWorld } from './char-cafe.js';
import { sunCharacter, world as sunWorld } from './char-sun.js';
import { bloomCharacter, bloomWorld } from './char-bloom.js';

const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const mix = (a, b, t) => a + (b - a) * t;
const moodIs = (a, name, span = 1.8) => a.mood && a.mood.name.includes(name) && a.mood.age < span ? 1 - a.mood.age / span : 0;
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function rgb(hex) { const h = hex.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); }
function shade(hex, k, lift = 0) { return `rgb(${rgb(hex).map(v => Math.round(clamp(v * k + lift * 255, 0, 255))).join(',')})`; }
function moods(a) {
  return { laugh: moodIs(a, 'laugh'), sigh: moodIs(a, 'sigh', 2.6), curious: Math.max(moodIs(a, 'curious', 3), moodIs(a, 'wonder', 3), moodIs(a, 'think', 2.5)),
    excited: Math.max(moodIs(a, 'excit', 2.5), moodIs(a, 'cheer', 2.5)), whisper: a.mood?.name.includes('whisper') && a.mood.age < 4 ? 1 : 0 };
}
const blinkAt = (t, period = 3.9) => { const p = (t % period) / period; return p > 0.962 ? 0.1 : 1; };

// =====================================================================================
// Ink: a thread of ink on paper
// =====================================================================================
function thread(ctx, st, box, a) {
  const k = box.h / 852, cx = box.x + box.w / 2, cy = box.y + box.h / 2 - 16 * k, x0 = box.x + box.w * 0.1, x1 = box.x + box.w * 0.9;
  const { laugh, sigh, whisper } = moods(a), think = a.think;
  for (let s = 5; s >= 0; s--) {
    const phi = s * 1.73, main = s === 0;
    ctx.beginPath(); let pen = false;
    for (let i = 0; i <= 150; i++) {
      const u = i / 150, taper = Math.sin(Math.PI * u) ** 0.9;
      if (a.gap && Math.abs(u - 0.5) < a.gap) { pen = false; continue; }
      const spread = (s - 2.5) * 5.5 * k * Math.sqrt(taper) * (1 + laugh * 2);
      const idle = 4 * k * a.alive * Math.sin(u * Math.PI * 3 + a.t * 0.6 + phi) * taper;
      const listen = a.listen * 70 * k * Math.exp(-2.4 * u) * Math.sin(2 * Math.PI * 2.6 * u - a.t * 5 + phi * 0.6);
      const speak = (whisper ? 0.5 : 1) * a.speak * 95 * k * taper * (0.7 * Math.sin(2 * Math.PI * 1.8 * u + a.t * 6.5 + phi * 0.8) + 0.3 * Math.sin(2 * Math.PI * 4.1 * u + a.t * 9.1 + phi));
      const bounce = laugh * 26 * k * taper * Math.sin(a.t * 18 + u * 9 + phi);
      let px = x0 + u * (x1 - x0), py = cy + spread + idle + listen + speak + bounce + sigh * 40 * k * taper;
      if (think > 0.001) {
        const th = -Math.PI / 2 + 2 * Math.PI * 0.93 * u + a.rot + s * 0.05, r = (150 + s * 6 + 16 * Math.sin(3 * th + a.t * 0.8 + phi) + 6 * Math.sin(a.t * 1.1)) * k;
        px += (cx + r * Math.cos(th) - px) * think; py += (cy + r * Math.sin(th) - py) * think;
      }
      if (!pen) { ctx.moveTo(px, py); pen = true; } else ctx.lineTo(px, py);
    }
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = (main ? 3.2 : 1.4 + (s % 2) * 0.4) * Math.max(k, 0.45);
    ctx.strokeStyle = main || s % 2 ? st.ink : st.second; ctx.globalAlpha = a.alive * (main ? 0.95 : s % 2 ? 0.5 : 0.32) * (1 - sigh * 0.3);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// =====================================================================================
// Flock: ~2,600 glowing particles that hold Clawd's shape. Its face is made of gaps in the swarm:
// eyes that blink and squint, and a mouth that smiles and opens with the audio being played.
// =====================================================================================
const flocks = new Map();
function flockTargets(n) {
  const c = document.createElement('canvas'), s = 200; c.width = c.height = s; const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(40, 50, 120, 86); g.fillRect(18, 80, 22, 26); g.fillRect(160, 80, 22, 26);
  for (const x of [48, 76, 106, 134]) g.fillRect(x, 136, 18, 26);
  const d = g.getImageData(0, 0, s, s).data, pts = [], r = rng(5);
  while (pts.length < n) { const x = Math.floor(r() * s), y = Math.floor(r() * s); if (d[(y * s + x) * 4 + 3] > 0) pts.push([(x + r() - s / 2) / s, (y + r() - s / 2) / s]); }
  return pts;
}
function flock(ctx, st, box, a) {
  const E = express(a.mini ? 'flock-mini' : 'flock', a);
  const key = a.mini ? 'mini' : 'full', n = a.mini ? 800 : 2600;
  let F = flocks.get(key);
  if (!F) { const tg = flockTargets(n), r = rng(9); F = { tg, x: new Float32Array(n), y: new Float32Array(n), vx: new Float32Array(n), vy: new Float32Array(n), ph: Float32Array.from({ length: n }, () => r() * 6.28), last: a.t }; for (let i = 0; i < n; i++) { F.x[i] = tg[i][0] + (r() - 0.5) * 0.25; F.y[i] = tg[i][1] + (r() - 0.5) * 0.25; } flocks.set(key, F); }
  const t = a.t, dt = Math.min(0.05, Math.max(0.001, t - F.last)); F.last = t;
  const S = Math.min(box.w, box.h) * 0.9, cx = box.x + box.w / 2 + E.turn * 30, cy = box.y + box.h * 0.5 - Math.max(0, E.bounce) * 80 + E.nod * 30;
  const k = 10 * (1 - E.thinking * 0.6) * (1 - E.laugh * 0.4), damp = Math.exp(-dt * 4.4);
  const cosT = Math.cos(E.tilt), sinT = Math.sin(E.tilt), sx = 1 - E.squash * 0.4, sy = 1 + E.squash * 0.6;
  // face holes (in shape coordinates)
  const eyeY = -0.095 + E.gazeY * 0.01, eyeH = Math.max(0.008, 0.068 * E.eyeOpen * E.blink * (1 - E.squint * 0.7)), happy = E.laugh > 0.3 || E.squint > 0.6;
  const mouthW = 0.095 + E.laugh * 0.03 - E.mouthRound * 0.03, mouthY = 0.045, mouthT = 0.018 + E.mouthOpen * 0.085, smile = E.smile * 0.045;
  const hole = (x, y) => {
    for (const side of [-1, 1]) {
      const ex = side * 0.135 + E.gazeX * 0.012, h = E.wink && side === 1 ? 0.006 : eyeH, ey = happy ? eyeY + 0.012 - 0.02 * (1 - ((x - ex) / 0.05) ** 2) : eyeY;
      const dx = (x - ex) / 0.058, dy = (y - ey) / (happy ? 0.014 : h);
      if (dx * dx + dy * dy < 1) return [0, (dy > 0 ? 1 : -1) * (happy ? 0.012 : h) * Math.sqrt(1 - Math.min(1, dx * dx)) - (y - ey)];
    }
    const u = x / mouthW; if (Math.abs(u) < 1) { const mid = mouthY - smile * (1 - u * u) + mouthT * 0.5, half = mouthT * 0.5 * Math.sqrt(1 - u * u * 0.6) + 0.004; if (Math.abs(y - mid) < half) return [0, (y > mid ? 1 : -1) * half - (y - mid)]; }
    return null;
  };
  ctx.save(); ctx.globalAlpha = a.alive;
  if (!a.mini) { const bg = ctx.createRadialGradient(cx, cy, 10, cx, cy, box.w * 0.75); bg.addColorStop(0, 'rgba(90,50,30,0.35)'); bg.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = bg; ctx.fillRect(box.x, box.y, box.w, box.h); }
  ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
  const cols = ['rgba(236,135,92,0.95)', 'rgba(255,180,128,0.9)', 'rgba(255,240,215,0.8)'];
  for (let c = 0; c < 3; c++) {
    ctx.strokeStyle = cols[c]; ctx.lineWidth = a.mini ? 1.8 : 3; ctx.beginPath();
    for (let i = c; i < n; i += 3) {
      let [tx, ty] = F.tg[i];
      const h = hole(tx, ty); if (h) { tx += h[0]; ty += h[1]; }
      tx *= sx * (1 + E.energy * 0.04); ty *= sy;
      let rx = tx * cosT - ty * sinT, ry = tx * sinT + ty * cosT;
      if (E.thinking > 0.01) { const an = F.ph[i] + a.rot * 1.6 + t * 0.4, rad = 0.26 + 0.05 * Math.sin(F.ph[i] * 3 + t); rx += (Math.cos(an) * rad - rx) * E.thinking; ry += (Math.sin(an) * rad * 0.8 - ry) * E.thinking; }
      let fx = (rx - F.x[i]) * k, fy = (ry - F.y[i]) * k;
      fx += Math.sin(F.y[i] * 9 + t * 1.3 + F.ph[i]) * 0.3 * (0.3 + E.thinking * 1.4); fy += Math.cos(F.x[i] * 8 - t * 1.1) * 0.3 * (0.3 + E.thinking * 1.4);
      fx += a.listen * a.listenState * 2.6 * Math.exp(-(F.x[i] + 0.5) * 3) * Math.sin(t * 6 + F.y[i] * 14);
      if (E.laugh > 0.3 && (Math.floor(t * 6) + i) % 89 === 0) { F.vx[i] += F.x[i] * 2.5; F.vy[i] += F.y[i] * 2.5; }
      F.vx[i] = (F.vx[i] + fx * dt) * damp; F.vy[i] = (F.vy[i] + fy * dt) * damp;
      F.x[i] += F.vx[i] * dt; F.y[i] += F.vy[i] * dt;
      const x = cx + F.x[i] * S, y = cy + F.y[i] * S, tail = 0.05 + Math.min(0.12, Math.hypot(F.vx[i], F.vy[i]) * 0.25);
      ctx.moveTo(x, y); ctx.lineTo(x - F.vx[i] * S * tail * 0.5 - 0.5, y - F.vy[i] * S * tail * 0.5);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// =====================================================================================
// Riso: three-ink halftone print, slightly misregistered, on grainy paper
// =====================================================================================
function halftone(ctx, st, box, a) {
  const E = express(a.mini ? 'riso-mini' : 'riso', a), t = a.t, boil = Math.floor(t * 8);
  const k = Math.min(box.w / 888, box.h / 852) * (a.mini ? 1.3 : 1), cx = box.x + box.w / 2 + E.turn * 30 * k, cy = box.y + box.h / 2 - 20 * k - Math.max(0, E.bounce) * 80 * k + E.nod * 30 * k;
  const R = 235 * k * (1 + E.energy * 0.05), step = Math.max(4, 10 * k), tilt = E.tilt * 1.4;
  const sq = E.squash; const r0 = rng(boil * 7 + 3), jx = (r0() - 0.5) * 2.4 * k, jy = (r0() - 0.5) * 2.4 * k;
  const layer = (color, off, angle, fn) => {
    ctx.fillStyle = color; ctx.beginPath();
    const ca = Math.cos(angle), sa = Math.sin(angle);
    for (let gy = -R; gy <= R; gy += step) for (let gx = -R; gx <= R; gx += step) {
      const x = gx * ca - gy * sa, y = gx * sa + gy * ca, d = Math.hypot(x, y); if (d > R) continue;
      const r = fn(x, y, d); if (r < 0.35) continue;
      const X = cx + (x * (1 - sq * 0.3)) + off[0], Y = cy + y * (1 + sq * 0.4) + off[1];
      ctx.moveTo(X + r, Y); ctx.arc(X, Y, r, 0, Math.PI * 2);
    }
    ctx.fill();
  };
  ctx.save(); ctx.globalAlpha = a.alive; ctx.globalCompositeOperation = 'multiply';
  layer('#f6c945', [jx * 0.5, jy * 0.5], 0.0, (x, y, d) => step * 0.5 * clamp(0.9 - d / R * 0.8 + 0.2 * Math.sin(d / (30 * k) - t * 2) * E.speaking));
  layer(st.second, [0, 0], 0.26 + tilt + a.rot * E.thinking * 0.5, (x, y, d) => {
    const light = clamp(0.95 - ((x + R * 0.35) ** 2 + (y + R * 0.4) ** 2) / (R * R * 2.2)) * (1 - (E.smile < 0 ? -E.smile * 0.5 : 0));
    const wave = E.speaking * 0.3 * Math.sin(d / (16 * k) - t * 6), lean = a.listen * E.listening * 0.6 * clamp(-x / R);
    return step * 0.52 * clamp(1 - light + wave + lean);
  });
  layer(st.ink, [3 * k + jx, 2 * k + jy], 0.78 + tilt, (x, y) => {
    // rotate back into face space
    const fx = x * Math.cos(-tilt) - y * Math.sin(-tilt), fy = x * Math.sin(-tilt) + y * Math.cos(-tilt);
    for (const side of [-1, 1]) {
      const ex = side * 70 * k + E.gazeX * 10 * k, ey = -50 * k + E.gazeY * 8 * k, open = E.eyeOpen * (E.wink && side === 1 ? 0 : E.blink);
      if (E.laugh > 0.3 || E.squint > 0.6) { const u = (fx - ex) / (18 * k); if (Math.abs(u) < 1 && Math.abs(fy - (ey + 6 * k - (1 - u * u) * 12 * k)) < 5 * k) return step * 0.58; }
      else { const h = Math.max(3, 21 * open * (1 - E.squint * 0.4)) * k; if (((fx - ex) / (15 * k)) ** 2 + ((fy - ey) / h) ** 2 < 1) return step * 0.58; }
      const lift = (side === -1 ? E.browL : E.browR) * 12 * k, inner = E.worry * 12 * k, u = (fx - ex) / (22 * k);
      if (Math.abs(u) < 1 && Math.abs(fy - (ey - 36 * k - lift - inner * (side === -1 ? (u + 1) / 2 : (1 - u) / 2))) < 4 * k && (Math.abs(lift) > 3 * k || inner > 3 * k)) return step * 0.5;
      if (((fx - side * 120 * k) / (34 * k)) ** 2 + ((fy - 30 * k) / (20 * k)) ** 2 < 1) return step * (0.3 + E.blush * 0.25);
    }
    const mw = (70 - 25 * E.mouthRound + E.laugh * 20) * k, u = fx / mw;
    if (Math.abs(u) < 1) { const top = 70 * k - E.smile * 22 * k * (1 - u * u), h = (7 + 55 * E.mouthOpen) * k * Math.sqrt(1 - u * u); if (fy > top - 3 * k && fy < top + h) return step * 0.58; }
    if (E.thinking > 0.05 && Math.abs(fy + 150 * k) < 10 * k && [-36, 0, 36].some((dx, i) => Math.abs(fx - dx * k) < 10 * k && Math.sin(t * 3 - i) > 0)) return step * 0.58;
    return 0;
  });
  ctx.restore();
}

export const STYLES = {
  clawd: { name: 'Clawd', paper: '#f3eadf', clay: '#dc7d58', eye: '#211b17', ink: '#dc7d58', second: '#3a342f', text: '#3a342f', grain: true, avatar: clawd3d },
  bloom: { name: 'Bloom', paper: '#fbf8ee', clay: '#dc7656', eye: '#111111', ink: '#dc7656', second: '#caa8d8', text: '#111111', grain: false, avatar: bloomCharacter },
  pixel: { name: '8-bit', paper: '#0b0a1a', clay: '#d97757', eye: '#171320', ink: '#d97757', second: '#f3d27a', text: '#efe6cc', grain: false, avatar: pixelClawd },
  cafe: { name: 'Café', paper: '#e9d8bc', clay: '#e3875a', eye: '#221812', ink: '#e3875a', second: '#a33d33', text: '#2a2320', grain: false, avatar: cafeCharacter },
  sun: { name: 'Sun', paper: '#2e3470', clay: '#e5895d', eye: '#18110e', ink: '#e5895d', second: '#f3d27a', text: '#f4efe2', grain: false, avatar: sunCharacter },
  flock: { name: 'Flock', paper: '#121316', clay: '#df7f59', eye: '#121316', ink: '#df7f59', second: '#f3e6d0', text: '#f3e6d0', grain: false, avatar: flock },
  riso: { name: 'Riso', paper: '#f3eee4', ink: '#ff4f7a', second: '#1f3fb3', text: '#1d2a55', grain: true, avatar: halftone },
  ink: { name: 'Ink', paper: '#efe9dd', ink: '#bf5b3a', second: '#3a342f', text: '#3a342f', grain: true, avatar: thread },
};
export const LEGACY_STYLES = { face: 'clawd', nocturne: 'sun' };

// The world behind each look, used as the user's backdrop in "match" mode when no scene is on screen.
const backdrops = new Map();
export function worldBackdrop(key, w, h) {
  if (key === 'cafe') return cafeWorld(w, h);
  if (key === 'sun') return sunWorld(w, h);
  if (key === 'bloom') return bloomWorld(w, h);
  const id = `${key}${w}x${h}`; if (backdrops.has(id)) return backdrops.get(id);
  if (backdrops.size > 8) backdrops.clear();
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'), st = STYLES[key] || STYLES.clawd, r = rng(3);
  if (key === 'pixel') {
    const sky = g.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, '#0b0a1a'); sky.addColorStop(0.7, '#241c42'); sky.addColorStop(1, '#17132a'); g.fillStyle = sky; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 90; i++) { g.fillStyle = `rgba(243,230,192,${0.3 + r() * 0.6})`; const s = r() < 0.2 ? 4 : 2; g.fillRect(Math.floor(r() * w / 4) * 4, Math.floor(r() * h * 0.6 / 4) * 4, s, s); }
    g.fillStyle = '#2b2250'; for (let x = 0; x < w; x += 8) { const hh = h * 0.18 + Math.sin(x * 0.01) * 30; g.fillRect(x, h - hh, 8, hh); }
  } else if (key === 'flock') {
    g.fillStyle = st.paper; g.fillRect(0, 0, w, h);
    const glow = g.createRadialGradient(w * 0.5, h * 0.45, 10, w * 0.5, h * 0.45, w * 0.8); glow.addColorStop(0, 'rgba(160,80,45,0.55)'); glow.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = glow; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 700; i++) { g.fillStyle = `rgba(255,${180 + r() * 60},${130 + r() * 60},${r() * 0.5})`; g.fillRect(r() * w, r() * h, 2, 2); }
  } else {
    const base = g.createRadialGradient(w * 0.4, h * 0.3, 10, w * 0.5, h * 0.5, w * 0.9); base.addColorStop(0, '#fffaf2'); base.addColorStop(1, st.paper); g.fillStyle = base; g.fillRect(0, 0, w, h);
    if (key === 'clawd') { const floor = g.createLinearGradient(0, h * 0.6, 0, h); floor.addColorStop(0, 'rgba(210,170,130,0)'); floor.addColorStop(1, 'rgba(210,170,130,0.45)'); g.fillStyle = floor; g.fillRect(0, 0, w, h); }
    if (key === 'riso') for (let y = 0; y < h; y += 14) for (let x = (y / 14) % 2 * 7; x < w; x += 14) { g.fillStyle = 'rgba(31,63,179,0.08)'; g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill(); }
  }
  backdrops.set(id, c); return c;
}

// Characters are drawn opaque; any fade (crossfades, dimmed states) is applied to the finished layer,
// so overlapping parts never turn see-through.
const layers = new Map();
export function drawAvatar(ctx, key, box, a) {
  const st = STYLES[key] || STYLES.clawd;
  if (a.alive > 0.995) return st.avatar(ctx, st, box, a);
  if (a.alive < 0.005) return;
  const id = a.mini ? 'mini' : 'full', w = Math.ceil(box.w), h = Math.ceil(box.h);
  let L = layers.get(id); if (!L || L.width !== w || L.height !== h) { L = document.createElement('canvas'); L.width = w; L.height = h; layers.set(id, L); }
  const g = L.getContext('2d'); g.clearRect(0, 0, w, h);
  st.avatar(g, st, { x: 0, y: 0, w: box.w, h: box.h }, { ...a, alive: 1 });
  ctx.save(); ctx.globalAlpha = a.alive; ctx.drawImage(L, box.x, box.y); ctx.restore();
}
