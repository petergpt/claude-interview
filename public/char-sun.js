// Sun: a paper-collage character. Every piece is cut paper with a torn white edge and fibre texture, and
// casts a soft shadow onto the layer beneath, over a navy collage world with drifting paper planes.
import { express } from './expression.js';

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const TAU = Math.PI * 2;
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const cache = new Map();
function once(key, make) { if (!cache.has(key)) { if (cache.size > 10) cache.clear(); cache.set(key, make()); } return cache.get(key); }

const fibres = (tone) => once(`fib${tone}`, () => {
  const c = document.createElement('canvas'); c.width = c.height = 180; const g = c.getContext('2d'), r = rng(tone === 'light' ? 3 : 9);
  g.lineCap = 'round';
  for (let i = 0; i < 220; i++) { const x = r() * 180, y = r() * 180, l = 4 + r() * 14, a = r() * TAU; g.strokeStyle = tone === 'light' ? `rgba(255,245,230,${0.08 + r() * 0.16})` : `rgba(90,40,20,${0.05 + r() * 0.12})`; g.lineWidth = 0.5 + r(); g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + (r() - 0.5) * 4, y + Math.sin(a) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke(); }
  return c;
});
// A cut-paper piece: soft shadow + torn white edge + coloured paper + fibres + light falloff.
function paper(ctx, pts, { color, edge = 7, shadow = 1, seed = 1, k = 1, shade = true, cx = 0, cy = 0, r = 100 }) {
  const rnd = rng(seed), border = pts.map(([x, y], i) => { const nx = x - cx, ny = y - cy, d = Math.hypot(nx, ny) || 1, e = (edge + rnd() * edge * 0.7) * k; return [x + nx / d * e, y + ny / d * e]; });
  const path = p => { const P = new Path2D(); p.forEach(([x, y], i) => i ? P.lineTo(x, y) : P.moveTo(x, y)); P.closePath(); return P; };
  const outer = path(border), inner = path(pts);
  ctx.save(); ctx.shadowColor = `rgba(8,10,40,${0.45 * shadow})`; ctx.shadowBlur = 16 * k; ctx.shadowOffsetX = 5 * k; ctx.shadowOffsetY = 9 * k; ctx.fillStyle = '#fbf7ee'; ctx.fill(outer); ctx.restore();
  ctx.fillStyle = color; ctx.fill(inner);
  ctx.save(); ctx.clip(inner);
  if (shade) { const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.05, cx, cy, r * 1.25); g.addColorStop(0, 'rgba(255,240,220,0.3)'); g.addColorStop(1, 'rgba(80,30,10,0.22)'); ctx.fillStyle = g; ctx.fill(inner); }
  ctx.fillStyle = ctx.createPattern(fibres('light'), 'repeat'); ctx.fill(inner); ctx.fillStyle = ctx.createPattern(fibres('dark'), 'repeat'); ctx.fill(inner);
  ctx.restore();
}
export function world(w, h) {
  return once(`world${w}x${h}`, () => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'), r = rng(17);
    const bg = g.createLinearGradient(0, 0, 0, h); bg.addColorStop(0, '#343b80'); bg.addColorStop(1, '#262c62'); g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.fillStyle = g.createPattern(fibres('light'), 'repeat'); g.fillRect(0, 0, w, h);
    const strip = (y0, col, tilt) => {
      const top = []; for (let x = -20; x <= w + 20; x += 7) top.push([x, y0 + tilt * x + Math.sin(x * 0.012) * 14 + (r() - 0.5) * 8]);
      const P = new Path2D(); top.forEach(([x, y], i) => i ? P.lineTo(x, y) : P.moveTo(x, y)); P.lineTo(w + 20, h + 20); P.lineTo(-20, h + 20); P.closePath();
      const E = new Path2D(); top.forEach(([x, y], i) => i ? E.lineTo(x, y - 4 - r() * 4) : E.moveTo(x, y - 5)); E.lineTo(w + 20, h + 20); E.lineTo(-20, h + 20); E.closePath();
      g.save(); g.shadowColor = 'rgba(5,6,30,0.55)'; g.shadowBlur = 18; g.shadowOffsetY = -6; g.fillStyle = 'rgba(250,247,240,0.9)'; g.fill(E); g.restore();
      g.fillStyle = col; g.fill(P); g.fillStyle = g.createPattern(fibres('light'), 'repeat'); g.fill(P);
    };
    strip(h * 0.7, '#3d4590', -0.05); strip(h * 0.86, '#1f2452', 0.03);
    return c;
  });
}
const bits = Array.from({ length: 18 }, (_, i) => { const r = rng(i * 13 + 5); return { x: r(), y: r() * 0.9, a: r() * 6, s: 0.7 + r() * 0.7, v: 0.3 + r() * 0.7, kind: ['stick', 'stick', 'star', 'cross', 'dot'][i % 5] }; });

export function sunCharacter(ctx, st, box, a) {
  const E = express(a.mini ? 'sun-mini' : 'sun', a), t = a.t, frame = Math.floor(t * 10);
  const S = Math.min(box.w, box.h) * (a.mini ? 1.25 : 1), k = S / 852;
  if (!a.mini) {
    ctx.drawImage(world(Math.round(box.w), Math.round(box.h)), box.x, box.y);
    for (const b of bits) {
      const x = box.x + ((b.x + t * 0.006 * b.v) % 1) * box.w, y = box.y + b.y * box.h + Math.sin(t * 0.5 + b.a) * 12, rot = b.a + t * 0.25 * b.v;
      ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.globalAlpha = a.alive;
      ctx.shadowColor = 'rgba(5,6,30,0.5)'; ctx.shadowBlur = 6; ctx.shadowOffsetX = 3; ctx.shadowOffsetY = 4;
      if (b.kind === 'stick') { ctx.fillStyle = '#ead69c'; ctx.fillRect(-11 * b.s, -3.5 * b.s, 22 * b.s, 7 * b.s); }
      else if (b.kind === 'dot') { ctx.fillStyle = '#e9e3d2'; ctx.beginPath(); ctx.arc(0, 0, 4 * b.s, 0, TAU); ctx.fill(); }
      else if (b.kind === 'cross') { ctx.fillStyle = '#e9e3d2'; ctx.fillRect(-9, -1.5, 18, 3); ctx.fillRect(-1.5, -9, 3, 18); }
      else { ctx.fillStyle = '#f3d27a'; ctx.beginPath(); for (let i = 0; i < 10; i++) { const rr = (i % 2 ? 4.5 : 11) * b.s, an = i * Math.PI / 5 - Math.PI / 2; ctx.lineTo(Math.cos(an) * rr, Math.sin(an) * rr); } ctx.fill(); }
      ctx.restore();
    }
    for (let i = 0; i < 2; i++) {                                                // paper planes with shadows
      const p = (t * 0.03 + i * 0.5) % 1, x = box.x + box.w * (1.15 - p * 1.35), y = box.y + box.h * (0.16 + i * 0.6) + Math.sin(p * 8 + i) * 22;
      ctx.save(); ctx.translate(x, y); ctx.rotate(-0.2 + Math.cos(p * 8 + i) * 0.12); ctx.globalAlpha = a.alive; ctx.scale(1.2, 1.2);
      ctx.shadowColor = 'rgba(5,6,30,0.5)'; ctx.shadowBlur = 10; ctx.shadowOffsetX = 6; ctx.shadowOffsetY = 12;
      ctx.fillStyle = '#f7f5ee'; ctx.beginPath(); ctx.moveTo(-30, 0); ctx.lineTo(28, -10); ctx.lineTo(-8, 5); ctx.fill(); ctx.shadowColor = 'transparent';
      ctx.fillStyle = '#cfccc3'; ctx.beginPath(); ctx.moveTo(-8, 5); ctx.lineTo(28, -10); ctx.lineTo(-4, 13); ctx.fill(); ctx.restore();
    }
  }
  // ---- the sun ----
  const cx = box.x + box.w / 2 + E.turn * 40 * k - E.lean * 20 * k, cy = box.y + box.h * (a.mini ? 0.5 : 0.47) - Math.max(0, E.bounce) * 90 * k + E.nod * 40 * k;
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(E.tilt * 1.1); ctx.scale(1 - E.squash * 0.35, 1 + E.squash * 0.55); ctx.globalAlpha = a.alive;
  const R0 = 128 * k, rays = 10, orange = '#e5895d';
  for (let i = 0; i < rays; i++) {
    const base = i / rays * TAU - Math.PI / 2;
    const wob = 0.05 * Math.sin(t * 1.3 + i * 1.9) + E.laugh * 0.1 * Math.sin(t * 17 + i) + E.speaking * 0.05 * Math.sin(t * 8 - i);
    const reach = E.listening * clamp(-Math.cos(base)) * 0.12 * (0.4 + a.listen * 3);
    const len = (272 * (1 + E.speaking * 0.1 * Math.sin(t * 7 - i * 0.8) + E.energy * 0.07 + reach - (E.smile < 0 ? 0.05 : 0))) * k;
    const an = base + wob + a.rot * 0.3 * E.thinking, w0 = 42 * k, pts = [];
    const r = rng(i * 7 + 3);
    for (let s = -1; s <= 1; s += 2) for (let j = 0; j <= 8; j++) { const u = s < 0 ? j / 8 : 1 - j / 8, rad = R0 * 0.75 + u * (len - R0 * 0.75 - w0 * 0.9), w = w0 * (1 - u * 0.12) * (1 + 0.1 * Math.sin(u * 5 + i * 1.3)) + (r() - 0.5) * 2 * k; pts.push([Math.cos(an) * rad - Math.sin(an) * s * w, Math.sin(an) * rad + Math.cos(an) * s * w]); if (s > 0 && j === 8) break; }
    // rounded tip
    const tipR = len - w0 * 0.9, tip = []; for (let j = 0; j <= 8; j++) { const q = -Math.PI / 2 + j / 8 * Math.PI; tip.push([Math.cos(an) * tipR + Math.cos(an + q) * w0 * 0.88, Math.sin(an) * tipR + Math.sin(an + q) * w0 * 0.88]); }
    const half = pts.length / 2, shape = [...pts.slice(0, half), ...tip, ...pts.slice(half)];
    paper(ctx, shape, { color: i % 2 ? orange : '#df8154', edge: 8, seed: frame * 17 + i, k, cx: Math.cos(an) * len * 0.5, cy: Math.sin(an) * len * 0.5, r: len * 0.6 });
    ctx.save(); ctx.strokeStyle = 'rgba(255,215,185,0.35)'; ctx.lineWidth = 2.2 * k; ctx.lineCap = 'round';   // brush strokes along the ray
    for (let s = 0; s < 4; s++) { const off = (s / 3 - 0.5) * w0 * 1.1; ctx.beginPath(); ctx.moveTo(Math.cos(an) * R0 - Math.sin(an) * off, Math.sin(an) * R0 + Math.cos(an) * off); ctx.lineTo(Math.cos(an) * (len - w0 * 1.3) - Math.sin(an) * off * 0.9, Math.sin(an) * (len - w0 * 1.3) + Math.cos(an) * off * 0.9); ctx.stroke(); }
    ctx.restore();
  }
  paper(ctx, Array.from({ length: 40 }, (_, i) => [Math.cos(i / 40 * TAU) * R0, Math.sin(i / 40 * TAU) * R0]), { color: '#ea9163', edge: 8, seed: frame * 31 + 99, k, r: R0 });
  // cheeks: soft pink paper circles
  for (const side of [-1, 1]) {
    const bx = side * 70 * k, by = 34 * k, rr = (24 + E.blush * 6) * k;
    paper(ctx, Array.from({ length: 16 }, (_, i) => [bx + Math.cos(i / 16 * TAU) * rr, by + Math.sin(i / 16 * TAU) * rr * 0.72]), { color: `rgba(240,128,140,${0.75 + E.blush * 0.25})`, edge: 2.5, shadow: 0.35, seed: frame + side * 5, k, cx: bx, cy: by, r: rr, shade: false });
  }
  // eyes: glossy, with lids, ^^ when laughing
  const gx = E.gazeX * 10 * k, gy = E.gazeY * 8 * k, ink = '#18110e';
  for (const side of [-1, 1]) {
    const ex = side * 46 * k, ey = -18 * k, open = E.eyeOpen * (E.wink && side === 1 ? 0 : E.blink);
    ctx.fillStyle = ink; ctx.strokeStyle = ink; ctx.lineCap = 'round';
    if (E.laugh > 0.3 || E.squint > 0.6) { ctx.lineWidth = 9 * k; ctx.beginPath(); ctx.arc(ex, ey + 12 * k, 16 * k, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke(); continue; }
    if (open < 0.2) { ctx.lineWidth = 7 * k; ctx.beginPath(); ctx.arc(ex, ey - 6 * k, 16 * k, Math.PI * 0.2, Math.PI * 0.8); ctx.stroke(); continue; }
    const rx = 16 * k * (1 + E.surprise * 0.2), ry = 21 * k * clamp(open, 0.2, 1.4) * (1 - E.squint * 0.35);
    ctx.beginPath(); ctx.ellipse(ex + gx * 0.3, ey + gy * 0.3, rx, ry, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.ellipse(ex + gx + 5 * k, ey + gy - ry * 0.35, 6 * k, 7 * k, -0.4, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(ex + gx - 5 * k, ey + gy + ry * 0.4, 2.6 * k, 0, TAU); ctx.fill();
    if (E.eyeOpen < 0.85 || E.worry > 0.2) {                          // an orange paper lid for sleepy / sad eyes
      const lid = ry * 2 * clamp(1 - E.eyeOpen + E.worry * 0.3, 0, 0.8), tiltL = E.worry * 0.3 * -side;
      ctx.save(); ctx.translate(ex, ey - ry); ctx.rotate(tiltL); ctx.fillStyle = '#ea9163'; ctx.fillRect(-rx * 1.3, -4 * k, rx * 2.6, lid + 4 * k); ctx.fillStyle = ink; ctx.fillRect(-rx * 1.2, lid - 1.5 * k, rx * 2.4, 4 * k); ctx.restore();
    }
  }
  // brows: small dark paper strips
  for (const side of [-1, 1]) {
    const lift = (side === -1 ? E.browL : E.browR) * 14 * k, inner = E.worry * 12 * k - Math.min(0, side === -1 ? E.browL : E.browR) * 8 * k;
    const x0 = side * 26 * k, x1 = side * 66 * k, y = -58 * k - lift;
    ctx.save(); ctx.shadowColor = 'rgba(80,30,10,0.35)'; ctx.shadowBlur = 3 * k; ctx.shadowOffsetY = 2 * k;
    ctx.strokeStyle = '#3a1d12'; ctx.lineWidth = 7 * k; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(x0, y - inner); ctx.quadraticCurveTo((x0 + x1) / 2, y - 6 * k - inner * 0.4, x1, y + 2 * k); ctx.stroke(); ctx.restore();
  }
  // mouth
  const open = E.mouthOpen, smile = E.smile, mw = (34 - E.mouthRound * 12 + E.laugh * 10) * k, my = 46 * k;
  ctx.fillStyle = ink; ctx.strokeStyle = ink; ctx.lineCap = 'round'; ctx.lineWidth = 8 * k;
  if (open < 0.07) { ctx.beginPath(); ctx.moveTo(-mw, my - smile * 8 * k); ctx.quadraticCurveTo(0, my + smile * 22 * k, mw, my - smile * 8 * k); ctx.stroke(); }
  else {
    const h = (10 + 46 * open) * k, p = new Path2D();
    p.moveTo(-mw, my - smile * 6 * k); p.quadraticCurveTo(0, my + smile * 6 * k, mw, my - smile * 6 * k); p.quadraticCurveTo(0, my + h + smile * 10 * k, -mw, my - smile * 6 * k);
    ctx.fill(p); if (open > 0.3) { ctx.save(); ctx.clip(p); ctx.fillStyle = '#e8727f'; ctx.beginPath(); ctx.ellipse(0, my + h * 0.85, mw * 0.55, h * 0.4, 0, 0, TAU); ctx.fill(); ctx.restore(); }
  }
  if (E.sweat > 0.2) { ctx.fillStyle = 'rgba(170,220,250,0.9)'; ctx.beginPath(); ctx.moveTo(100 * k, -70 * k); ctx.quadraticCurveTo(116 * k, -40 * k, 100 * k, -34 * k); ctx.quadraticCurveTo(84 * k, -40 * k, 100 * k, -70 * k); ctx.fill(); }
  ctx.restore();
}
