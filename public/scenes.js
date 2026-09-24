// Pre-built scenes, shown within a few seconds of the user's turn while a bespoke scene is being made.
// Each unfolds over ~6 s ("being drawn"), then keeps a slow loop that breathes with Claude's voice.
// p = { palette: [ink, accent, third], words, seed, level, font, text, paper }

const TAU = Math.PI * 2;
const ease = x => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function hash(str) { let h = 2166136261; for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
const cache = new Map();
function memo(key, make) { if (!cache.has(key)) { if (cache.size > 30) cache.clear(); cache.set(key, make()); } return cache.get(key); }

// Scenes carry no text: the picture should read as artwork, not interface.
function words() {}
function unusedWords(ctx, p, box, t, spots) {
  (p.words || []).slice(0, spots.length).forEach((w, i) => {
    const a = ease((t - 1.8 - i * 0.7) / 1.2); if (a <= 0) return;
    const [fx, spotY, align = 'left'] = spots[i];
    const fy = fx < 0.45 && spotY > 0.7 ? 0.66 : spotY;   // keep clear of Claude's corner while a scene is up
    ctx.save(); ctx.globalAlpha = a * 0.85; ctx.fillStyle = p.text; ctx.textAlign = align; ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(box.h * 0.03)}px ${p.font}`; ctx.letterSpacing = '0.12em';
    ctx.fillText(w.toUpperCase(), box.x + fx * box.w, box.y + fy * box.h); ctx.restore();
  });
}

const SCENES = {
  orbit(ctx, box, t, p) {
    const cx = box.x + box.w * 0.5, cy = box.y + box.h * 0.46, R = box.w * 0.36, [c1, c2, c3] = p.palette;
    ctx.lineWidth = 1.4;
    for (let i = 0; i < 5; i++) {
      const u = ease((t - i * 0.6) / 2.2), rx = R * (0.3 + i * 0.17), ry = rx * 0.38, tilt = -0.28 + i * 0.03;
      ctx.strokeStyle = i % 2 ? c2 : c1; ctx.globalAlpha = 0.55;
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, tilt, 0, TAU * u); ctx.stroke();
      if (u >= 1) {
        const a = t * (0.5 / (i + 1)) + i * 1.7, x = cx + Math.cos(a) * rx * Math.cos(tilt) - Math.sin(a) * ry * Math.sin(tilt), y = cy + Math.cos(a) * rx * Math.sin(tilt) + Math.sin(a) * ry * Math.cos(tilt);
        ctx.globalAlpha = 0.95; ctx.fillStyle = [c1, c2, c3][i % 3]; ctx.beginPath(); ctx.arc(x, y, 5 + i * 1.5 + p.level * 4, 0, TAU); ctx.fill();
      }
    }
    ctx.globalAlpha = ease(t / 1.5); ctx.fillStyle = c2; ctx.beginPath(); ctx.arc(cx, cy, R * 0.09 * (1 + p.level * 0.15), 0, TAU); ctx.fill();
    ctx.globalAlpha = 1; words(ctx, p, box, t, [[0.12, 0.16], [0.88, 0.8, 'right'], [0.12, 0.8], [0.88, 0.16, 'right']]);
  },
  city(ctx, box, t, p) {
    const [c1, c2, c3] = p.palette, base = box.y + box.h * 0.74;
    const b = memo(`city${p.seed}`, () => { const r = rng(p.seed); return Array.from({ length: 22 }, (_, i) => ({ x: i / 22 + r() * 0.01, w: 0.03 + r() * 0.03, h: 0.12 + r() ** 1.6 * 0.5, d: r() * 2, lit: r() })); });
    ctx.strokeStyle = c1; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.9; ctx.beginPath(); ctx.moveTo(box.x + box.w * 0.06, base); ctx.lineTo(box.x + box.w * (0.06 + 0.88 * ease(t / 1.5)), base); ctx.stroke();
    for (const o of b) {
      const g = ease((t - 0.8 - o.d) / 2.6), x = box.x + box.w * (0.06 + o.x * 0.88), w = box.w * o.w, h = box.h * o.h * g * (1 + p.level * 0.02);
      ctx.globalAlpha = 0.18; ctx.fillStyle = o.lit > 0.7 ? c2 : c3; ctx.fillRect(x, base - h, w, h);
      ctx.globalAlpha = 0.8; ctx.strokeRect(x, base - h, w, h);
      if (g > 0.9) for (let y = base - h + 10; y < base - 8; y += 14) if (Math.sin(y * 3.1 + o.x * 90 + t * 0.4) > 0.55) { ctx.fillStyle = c2; ctx.fillRect(x + w * 0.35, y, w * 0.3, 4); }
    }
    ctx.globalAlpha = 0.35; ctx.fillStyle = c3;
    for (let i = 0; i < 3; i++) { const x = box.x + box.w * ((t * 0.02 + i * 0.37) % 1), y = box.y + box.h * (0.18 + i * 0.07); ctx.beginPath(); ctx.ellipse(x, y, 34, 5, 0, 0, TAU); ctx.fill(); }
    ctx.globalAlpha = 1; words(ctx, p, box, t, [[0.08, 0.84], [0.92, 0.84, 'right'], [0.08, 0.12], [0.92, 0.12, 'right']]);
  },
  growth(ctx, box, t, p) {
    const [c1, c2, c3] = p.palette, depthMax = 9, grow = ease(t / 6) * depthMax;
    // per-node randomness (stable while the tree grows)
    const nr = (id, k) => { const v = Math.sin(id * 12.9898 + k * 78.233 + p.seed % 1000) * 43758.5453; return v - Math.floor(v); };
    const branch = (x, y, ang, len, d, id = 1) => {
      if (d > grow || len < 3) return;
      const f = Math.min(1, grow - d), sway = Math.sin(t * 0.8 + d) * 0.03 * d + p.level * 0.02;
      const x2 = x + Math.cos(ang + sway) * len * f, y2 = y + Math.sin(ang + sway) * len * f;
      ctx.strokeStyle = d < 4 ? c1 : c3; ctx.lineWidth = Math.max(0.8, 7 - d * 0.75); ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
      if (d >= depthMax - 2 && f >= 1) { ctx.fillStyle = nr(id, 1) > 0.5 ? c2 : c3; ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.arc(x2, y2, 4 + nr(id, 2) * 5, 0, TAU); ctx.fill(); }
      const spread = 0.35 + nr(id, 3) * 0.25;
      branch(x2, y2, ang - spread, len * (0.68 + nr(id, 4) * 0.1), d + 1, id * 2); branch(x2, y2, ang + spread, len * (0.68 + nr(id, 5) * 0.1), d + 1, id * 2 + 1);
    };
    branch(box.x + box.w / 2, box.y + box.h * 0.86, -Math.PI / 2, box.h * 0.2, 0);
    ctx.globalAlpha = 1; words(ctx, p, box, t, [[0.08, 0.12], [0.92, 0.12, 'right'], [0.08, 0.9], [0.92, 0.9, 'right']]);
  },
  waves(ctx, box, t, p) {
    const [c1, c2, c3] = p.palette;
    ctx.globalAlpha = ease(t / 2) * 0.9; ctx.fillStyle = c2; ctx.beginPath(); ctx.arc(box.x + box.w * 0.68, box.y + box.h * 0.36, box.w * 0.08, 0, TAU); ctx.fill();
    for (let i = 0; i < 9; i++) {
      const u = ease((t - i * 0.25) / 2.5); if (u <= 0) continue;
      const y0 = box.y + box.h * (0.5 + i * 0.05);
      ctx.strokeStyle = i % 3 === 0 ? c1 : c3; ctx.lineWidth = 1.6; ctx.globalAlpha = 0.25 + 0.07 * i;
      ctx.beginPath();
      for (let x = 0; x <= box.w * u; x += 8) { const y = y0 + Math.sin(x * 0.012 + t * (0.6 + i * 0.1) + i) * (8 + i * 1.5) * (1 + p.level * 0.8); x ? ctx.lineTo(box.x + x, y) : ctx.moveTo(box.x + x, y); }
      ctx.stroke();
    }
    ctx.globalAlpha = 1; words(ctx, p, box, t, [[0.08, 0.14], [0.08, 0.22], [0.92, 0.92, 'right'], [0.08, 0.92]]);
  },
  network(ctx, box, t, p) {
    const [c1, c2, c3] = p.palette;
    const net = memo(`net${p.seed}`, () => { const r = rng(p.seed); const n = Array.from({ length: 26 }, () => ({ x: 0.1 + r() * 0.8, y: 0.12 + r() * 0.72, s: r() })); const e = []; n.forEach((a, i) => n.forEach((b, j) => { if (j > i && Math.hypot(a.x - b.x, a.y - b.y) < 0.24) e.push([i, j, r()]); })); return { n, e }; });
    const P = q => [box.x + q.x * box.w + Math.sin(t * 0.3 + q.s * 9) * 6, box.y + q.y * box.h + Math.cos(t * 0.27 + q.s * 7) * 6];
    ctx.lineWidth = 1.2;
    net.e.forEach(([i, j, d]) => {
      const u = ease((t - 0.5 - d * 3) / 1.2); if (u <= 0) return;
      const [x1, y1] = P(net.n[i]), [x2, y2] = P(net.n[j]);
      ctx.strokeStyle = c3; ctx.globalAlpha = 0.45; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 + (x2 - x1) * u, y1 + (y2 - y1) * u); ctx.stroke();
      if (u >= 1) { const k = (t * 0.35 + d) % 1; ctx.fillStyle = c2; ctx.globalAlpha = 0.9; ctx.beginPath(); ctx.arc(x1 + (x2 - x1) * k, y1 + (y2 - y1) * k, 2.5 + p.level * 2, 0, TAU); ctx.fill(); }
    });
    net.n.forEach(q => { const [x, y] = P(q); ctx.globalAlpha = ease((t - q.s * 2) / 1); ctx.fillStyle = q.s > 0.8 ? c2 : c1; ctx.beginPath(); ctx.arc(x, y, 4 + q.s * 7, 0, TAU); ctx.fill(); });
    ctx.globalAlpha = 1; words(ctx, p, box, t, [[0.08, 0.06], [0.92, 0.94, 'right'], [0.08, 0.94], [0.92, 0.06, 'right']]);
  },
  timeline(ctx, box, t, p) {
    const [c1, c2, c3] = p.palette, y = box.y + box.h * 0.55, x0 = box.x + box.w * 0.08, x1 = box.x + box.w * 0.92, u = ease(t / 3);
    ctx.strokeStyle = c1; ctx.lineWidth = 2; ctx.globalAlpha = 0.9; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + (x1 - x0) * u, y); ctx.stroke();
    for (let i = 0; i <= 20; i++) { const x = x0 + (x1 - x0) * i / 20; if (x > x0 + (x1 - x0) * u) break; ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.moveTo(x, y - (i % 5 ? 6 : 14)); ctx.lineTo(x, y + (i % 5 ? 6 : 14)); ctx.stroke(); }
    const ws = p.words.length ? p.words : ['', '', ''];
    ws.forEach((w, i) => {
      const a = ease((t - 2 - i * 0.8) / 1); if (a <= 0) return;
      const x = x0 + (x1 - x0) * ((i + 0.5) / ws.length), up = i % 2 ? 1 : -1, h = box.h * 0.16;
      ctx.globalAlpha = a * 0.7; ctx.strokeStyle = c3; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + up * h * a); ctx.stroke();
      ctx.fillStyle = i === ws.length - 1 ? c2 : c1; ctx.globalAlpha = a; ctx.beginPath(); ctx.arc(x, y + up * h * a, 9, 0, TAU); ctx.fill();
      ctx.fillStyle = p.text; ctx.textAlign = 'center'; ctx.font = `${Math.round(box.h * 0.03)}px ${p.font}`; ctx.fillText(w.toUpperCase(), x, y + up * (h + 30) * a);
    });
    const now = x0 + (x1 - x0) * ((t * 0.03) % 1); ctx.globalAlpha = 0.9 * u; ctx.fillStyle = c2; ctx.beginPath(); ctx.arc(now, y, 6 + p.level * 5, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
  },
  field(ctx, box, t, p) {
    const [c1, c2, c3] = p.palette, r = rng(p.seed), n = 170, len = ease(t / 5) * 26;
    ctx.lineWidth = 1.3; ctx.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      let x = box.x + r() * box.w, y = box.y + r() * box.h; const c = r();
      ctx.strokeStyle = c > 0.85 ? c2 : c > 0.4 ? c1 : c3; ctx.globalAlpha = 0.35 + (c > 0.85 ? 0.4 : 0);
      ctx.beginPath(); ctx.moveTo(x, y);
      for (let s = 0; s < len; s++) {
        const a = Math.sin(x * 0.006 + t * 0.15) * 1.6 + Math.cos(y * 0.007 - t * 0.1) * 1.6 + p.level * 0.6;
        x += Math.cos(a) * 5; y += Math.sin(a) * 5; ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1; words(ctx, p, box, t, [[0.08, 0.1], [0.92, 0.9, 'right'], [0.08, 0.9], [0.92, 0.1, 'right']]);
  },
  strata(ctx, box, t, p) {
    const [c1, c2, c3] = p.palette, layers = 8;
    for (let i = 0; i < layers; i++) {
      const u = ease((t - i * 0.35) / 1.6); if (u <= 0) continue;
      const top = box.y + box.h * (0.18 + i * 0.09), next = top + box.h * 0.09;
      ctx.fillStyle = [c1, c3, c2][i % 3]; ctx.globalAlpha = (0.08 + (i % 3) * 0.06) * u;
      ctx.beginPath(); ctx.moveTo(box.x, next);
      for (let x = 0; x <= box.w; x += 12) ctx.lineTo(box.x + x, top + Math.sin(x * 0.01 + i * 2 + t * 0.1) * 10 + Math.sin(x * 0.037 + i) * 4);
      ctx.lineTo(box.x + box.w, next); ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 0.6 * u; ctx.strokeStyle = c1; ctx.lineWidth = 1; ctx.stroke();
      const r = rng(p.seed + i); for (let j = 0; j < 4; j++) { ctx.globalAlpha = 0.5 * u; ctx.fillStyle = c1; ctx.beginPath(); ctx.arc(box.x + r() * box.w, top + 20 + r() * 30, 2 + r() * 4, 0, TAU); ctx.fill(); }
    }
    ctx.globalAlpha = 1; words(ctx, p, box, t, [[0.92, 0.23, 'right'], [0.92, 0.41, 'right'], [0.92, 0.59, 'right'], [0.92, 0.77, 'right']]);
  },
  constellation(ctx, box, t, p) {
    const [c1, c2, c3] = p.palette;
    const s = memo(`con${p.seed}`, () => { const r = rng(p.seed); return { bg: Array.from({ length: 120 }, () => [r(), r(), r()]), fig: Array.from({ length: 9 }, (_, i) => [0.2 + 0.6 * (i / 8) + (r() - 0.5) * 0.1, 0.3 + r() * 0.4]) }; });
    for (const [x, y, z] of s.bg) { ctx.globalAlpha = (0.2 + 0.4 * Math.abs(Math.sin(t * 0.7 + z * 20))) * ease(t / 2); ctx.fillStyle = c3; ctx.fillRect(box.x + x * box.w, box.y + y * box.h, 1.6 + z * 1.5, 1.6 + z * 1.5); }
    const u = ease((t - 1) / 4) * (s.fig.length - 1);
    ctx.strokeStyle = c1; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.7; ctx.beginPath();
    s.fig.forEach(([x, y], i) => { if (i > u + 1) return; const f = Math.min(1, u - i + 1), [px, py] = i ? s.fig[i - 1] : [x, y]; const X = px + (x - px) * f, Y = py + (y - py) * f; i ? ctx.lineTo(box.x + X * box.w, box.y + Y * box.h) : ctx.moveTo(box.x + X * box.w, box.y + Y * box.h); });
    ctx.stroke();
    s.fig.forEach(([x, y], i) => { if (i > u) return; ctx.globalAlpha = 0.9; ctx.fillStyle = i % 3 ? c1 : c2; ctx.beginPath(); ctx.arc(box.x + x * box.w, box.y + y * box.h, 4 + (i % 3 ? 0 : 3) + p.level * 3, 0, TAU); ctx.fill(); });
    ctx.globalAlpha = 1; words(ctx, p, box, t, [[0.08, 0.1], [0.92, 0.9, 'right'], [0.08, 0.9], [0.92, 0.1, 'right']]);
  },
  bloom(ctx, box, t, p) {
    const [c1, c2, c3] = p.palette, cx = box.x + box.w / 2, cy = box.y + box.h * 0.47, open = ease(t / 5), R = box.w * 0.3;
    for (let ring = 0; ring < 3; ring++) {
      const n = 8 + ring * 5;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + t * 0.05 * (ring % 2 ? -1 : 1) + ring * 0.2, len = R * (0.45 + ring * 0.25) * open * (1 + p.level * 0.06);
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(a);
        ctx.fillStyle = [c2, c3, c1][ring]; ctx.globalAlpha = 0.18 + ring * 0.04; ctx.beginPath(); ctx.ellipse(len * 0.5, 0, len * 0.5, len * 0.12, 0, 0, TAU); ctx.fill();
        ctx.strokeStyle = c1; ctx.globalAlpha = 0.45; ctx.lineWidth = 1; ctx.stroke(); ctx.restore();
      }
    }
    ctx.globalAlpha = 0.9; ctx.fillStyle = c2; ctx.beginPath(); ctx.arc(cx, cy, 10 + 6 * open, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1; words(ctx, p, box, t, [[0.08, 0.1], [0.92, 0.9, 'right'], [0.08, 0.9], [0.92, 0.1, 'right']]);
  },
};

const hexA = (hex, a) => { const h = hex.replace('#', '').slice(0, 6), f = h.length === 3 ? [...h].map(x => x + x).join('') : h; return `rgba(${parseInt(f.slice(0, 2), 16)},${parseInt(f.slice(2, 4), 16)},${parseInt(f.slice(4, 6), 16)},${a})`; };
export function drawBaseScene(ctx, header, box, t, style, level) {
  // Drop palette colours that would vanish into the paper.
  const lum = c => { const h = c.replace('#', ''), f = h.length === 3 ? [...h].map(x => x + x) : [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)]; return f.map(x => parseInt(x, 16) / 255).reduce((a, v, i) => a + v * [0.3, 0.59, 0.11][i], 0); };
  const usable = (header.palette || []).filter(c => Math.abs(lum(c) - lum(style.paper)) > 0.25);
  const palette = [...usable, style.second, style.ink, style.second].slice(0, 3);
  const p = { palette, words: header.words || [], seed: hash(header.title || header.base), level, font: style.font, text: style.text };
  ctx.save(); ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
  // atmosphere: the scene's own ground, a motivated light that slowly breathes, and a haze near the horizon
  ctx.fillStyle = style.paper; ctx.fillRect(box.x, box.y, box.w, box.h);
  const lx = box.x + box.w * (0.62 + 0.04 * Math.sin(t * 0.13)), ly = box.y + box.h * 0.3;
  const light = ctx.createRadialGradient(lx, ly, 0, lx, ly, box.w * 0.9); light.addColorStop(0, hexA(palette[1], 0.22 + 0.04 * Math.sin(t * 0.4))); light.addColorStop(1, hexA(palette[1], 0));
  ctx.fillStyle = light; ctx.fillRect(box.x, box.y, box.w, box.h);
  const haze = ctx.createLinearGradient(0, box.y + box.h * 0.55, 0, box.y + box.h); haze.addColorStop(0, hexA(palette[0], 0)); haze.addColorStop(1, hexA(palette[0], 0.1));
  ctx.fillStyle = haze; ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.save(); ctx.translate(box.x + box.w / 2, box.y + box.h / 2); ctx.scale(1 + t * 0.004, 1 + t * 0.004); ctx.translate(-(box.x + box.w / 2), -(box.y + box.h / 2));   // a slow push-in
  (SCENES[header.base] || SCENES.field)(ctx, box, t, p);
  ctx.restore();
  // drifting motes in the light
  for (let i = 0; i < 40; i++) { const r = Math.sin(i * 127.1 + p.seed % 97) * 43758.5, fx = r - Math.floor(r), fy = (r * 3.7) % 1; const x = box.x + ((fx + t * 0.01 * (0.5 + (i % 5) / 5)) % 1) * box.w, y = box.y + ((Math.abs(fy) + Math.sin(t * 0.3 + i) * 0.02) % 1) * box.h; ctx.globalAlpha = 0.25 + 0.25 * Math.sin(t * (0.6 + i % 3) + i); ctx.fillStyle = palette[1]; ctx.beginPath(); ctx.arc(x, y, 1.2 + (i % 3) * 0.6, 0, TAU); ctx.fill(); }
  ctx.globalAlpha = 1;
  ctx.restore(); ctx.globalAlpha = 1;
}
