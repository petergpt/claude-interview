// Café: the flower-headed character as a coloured-pencil portrait in warm window light. Smooth pencil
// outlines that "boil" gently like hand animation, directional shading, hatching and paper grain.
import { express } from './expression.js';

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const TAU = Math.PI * 2;
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const cache = new Map();
function once(key, make) { if (!cache.has(key)) { if (cache.size > 12) cache.clear(); cache.set(key, make()); } return cache.get(key); }

// ---- textures ----
const hatchTex = () => once('hatch', () => {
  const c = document.createElement('canvas'); c.width = c.height = 140; const g = c.getContext('2d'), r = rng(4);
  g.lineCap = 'round';
  for (let i = 0; i < 260; i++) { const x = r() * 160 - 10, y = r() * 160 - 10, l = 6 + r() * 16; g.strokeStyle = `rgba(35,20,12,${0.15 + r() * 0.35})`; g.lineWidth = 0.6 + r() * 0.7; g.beginPath(); g.moveTo(x, y); g.lineTo(x + l * 0.8, y - l * 0.6 + (r() - 0.5) * 2); g.stroke(); }
  return c;
});
const grainTex = () => once('grain', () => {
  const c = document.createElement('canvas'); c.width = c.height = 160; const g = c.getContext('2d'), img = g.createImageData(160, 160);
  for (let i = 0; i < img.data.length; i += 4) { const v = 120 + Math.random() * 135; img.data[i] = v; img.data[i + 1] = v * 0.96; img.data[i + 2] = v * 0.9; img.data[i + 3] = Math.random() < 0.35 ? 22 : 0; }
  g.putImageData(img, 0, 0); return c;
});
export function background(w, h) {
  return once(`bg${w}x${h}`, () => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'), r = rng(12);
    const base = g.createLinearGradient(0, 0, w, 0); base.addColorStop(0, '#5f5043'); base.addColorStop(0.35, '#b99f7d'); base.addColorStop(0.7, '#eed6aa'); base.addColorStop(1, '#f6e4bd');
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    g.filter = 'blur(10px)';
    g.fillStyle = 'rgba(70,55,40,0.8)'; g.fillRect(-20, -20, w * 0.18, h + 40);                              // dark wood on the left
    g.fillStyle = 'rgba(245,232,205,0.9)'; g.fillRect(w * 0.44, -20, w * 0.6, h * 0.62);                   // bright window
    g.fillStyle = 'rgba(140,110,70,0.7)'; for (const x of [0.44, 0.62, 0.8, 0.98]) g.fillRect(w * x, -20, 10, h * 0.64); g.fillRect(w * 0.44, h * 0.3, w * 0.6, 8);
    for (let i = 0; i < 14; i++) { g.fillStyle = `rgba(${110 + r() * 40},${130 + r() * 30},${80 + r() * 20},0.55)`; g.beginPath(); g.ellipse(w * (0.5 + r() * 0.5), h * r() * 0.45, 30 + r() * 50, 20 + r() * 40, 0, 0, TAU); g.fill(); }   // trees outside
    for (let i = 0; i < 16; i++) { g.fillStyle = `rgba(${70 + r() * 30},${100 + r() * 30},${55 + r() * 20},0.85)`; g.beginPath(); g.ellipse(w * r() * 0.2, h * (0.55 + r() * 0.45), 22 + r() * 24, 14 + r() * 16, r() * 3, 0, TAU); g.fill(); }  // ivy
    g.filter = 'none';
    g.globalAlpha = 0.35; g.fillStyle = g.createPattern(hatchTex(), 'repeat'); g.fillRect(0, 0, w, h); g.globalAlpha = 1;
    g.fillStyle = g.createPattern(grainTex(), 'repeat'); g.fillRect(0, 0, w, h);
    return c;
  });
}
// ---- pencil drawing helpers ----
function smooth(pts, closed = true) {
  const p = new Path2D(), n = pts.length; p.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    p.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
  }
  if (closed) p.closePath(); return p;
}
// outlines are drawn precisely (no frame-to-frame jitter); the pencil feel comes from texture and a soft second stroke
function boil(pts) { return pts; }
function draw(ctx, pts, o) {
  const path = smooth(pts, o.closed !== false);
  if (o.fill) {
    ctx.fillStyle = o.fill; ctx.fill(path);
    ctx.save(); ctx.clip(path);
    if (o.shade) { const [x0, y0, x1, y1] = o.shade; const g = ctx.createLinearGradient(x0, y0, x1, y1); g.addColorStop(0, 'rgba(255,245,225,0.28)'); g.addColorStop(0.55, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(60,25,15,${o.dark ?? 0.32})`); ctx.fillStyle = g; ctx.fill(path); }
    ctx.globalAlpha *= o.hatch ?? 0.35; ctx.fillStyle = ctx.createPattern(hatchTex(), 'repeat'); ctx.fill(path);
    ctx.restore();
  }
  if (o.line !== false) {
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = o.line || '#2b1f19'; ctx.lineWidth = o.w || 3; ctx.stroke(path);
    ctx.save(); ctx.globalAlpha *= 0.3; ctx.lineWidth = (o.w || 3) * 0.45; ctx.translate(0.9, 0.7); ctx.stroke(path); ctx.restore();
  }
  return path;
}
const ellipse = (cx, cy, rx, ry, n = 20, rot = 0) => Array.from({ length: n }, (_, i) => { const a = i / n * TAU, x = Math.cos(a) * rx, y = Math.sin(a) * ry; return [cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]; });

const bokeh = Array.from({ length: 14 }, (_, i) => { const r = rng(i * 7 + 1); return { x: 0.45 + r() * 0.55, y: r() * 0.6, s: 14 + r() * 40, v: 0.2 + r() * 0.5, p: r() * 6 }; });

// ---- the body: a slim sweater, thin tapered sleeves with ribbed cuffs, and small drawn hands ----
const SKIN = '#e5a882', NECK = '#cc8a63', SLEEVE = '#ab92cf', CUFF = '#9279b8', INK = '#2b1f19';
// Arm joints ease between hand-drawn poses on critically damped springs, so arms travel with weight instead of jumping.
const joints = {};
function follow(name, tx, ty, dt, k = 90, d = 19) {
  const s = joints[name] ||= { x: tx, y: ty, vx: 0, vy: 0 };
  const n = Math.max(1, Math.ceil(dt / 0.008)), h = dt / n;
  for (let i = 0; i < n; i++) { s.vx += ((tx - s.x) * k - s.vx * d) * h; s.vy += ((ty - s.y) * k - s.vy * d) * h; s.x += s.vx * h; s.y += s.vy * h; }
  return [s.x, s.y];
}
const lerp2 = (p, q, u) => [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u];
// Outline points of a tapered capsule from p0 (radius r0) to p1 (radius r1), for the smooth pencil outline.
function capsule(p0, p1, r0, r1) {
  const a = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]), nx = -Math.sin(a), ny = Math.cos(a), pts = [];
  for (let i = 0; i <= 3; i++) { const u = i / 3, r = r0 + (r1 - r0) * u; pts.push([p0[0] + (p1[0] - p0[0]) * u + nx * r, p0[1] + (p1[1] - p0[1]) * u + ny * r]); }
  for (let i = 1; i < 6; i++) { const b = a + Math.PI / 2 - i * Math.PI / 6; pts.push([p1[0] + Math.cos(b) * r1, p1[1] + Math.sin(b) * r1]); }
  for (let i = 3; i >= 0; i--) { const u = i / 3, r = r0 + (r1 - r0) * u; pts.push([p0[0] + (p1[0] - p0[0]) * u - nx * r, p0[1] + (p1[1] - p0[1]) * u - ny * r]); }
  for (let i = 1; i < 6; i++) { const b = a - Math.PI / 2 - i * Math.PI / 6; pts.push([p0[0] + Math.cos(b) * r0, p0[1] + Math.sin(b) * r0]); }
  return pts;
}
// A sweater sleeve: upper arm, then the forearm drawn over it (so a bend reads as an elbow), and a ribbed cuff.
function sleeve(ctx, S, El, W, k, shade, pencil) {
  const o = { fill: SLEEVE, shade, w: pencil, hatch: 0.28, dark: 0.26 };
  draw(ctx, capsule(S, El, 30 * k, 26 * k), o);
  draw(ctx, capsule(El, W, 26 * k, 22 * k), o);
  const a = Math.atan2(W[1] - El[1], W[0] - El[0]), c0 = [W[0] - Math.cos(a) * 18 * k, W[1] - Math.sin(a) * 18 * k];
  draw(ctx, capsule(c0, W, 24.5 * k, 24.5 * k), { fill: CUFF, shade, w: pencil * 0.9, hatch: 0.2, dark: 0.22 });
  ctx.strokeStyle = 'rgba(43,31,25,0.32)'; ctx.lineWidth = 1.3 * k; ctx.lineCap = 'round';
  for (const j of [-1, 0, 1]) { const ox = -Math.sin(a) * j * 11 * k, oy = Math.cos(a) * j * 11 * k; ctx.beginPath(); ctx.moveTo(c0[0] + ox, c0[1] + oy); ctx.lineTo(W[0] + ox - Math.cos(a) * 4 * k, W[1] + oy - Math.sin(a) * 4 * k); ctx.stroke(); }
}
// A small drawn hand at (x, y) in pixels. dir: where the fingers point. pose: 'relaxed' (fingers together), 'open'
// (spread), or 'fist'. side: which side of the hand the thumb is on, relative to dir.
function hand(ctx, x, y, dir, pose, side, k, shade, pencil) {
  const at = (d, r) => [x + Math.cos(dir + d) * r * k, y + Math.sin(dir + d) * r * k];
  const o = { fill: SKIN, shade, w: pencil * 0.82, hatch: 0.14, dark: 0.2 };
  draw(ctx, capsule(at(side * 1.25, 11), at(side * 0.85, pose === 'fist' ? 17 : 25), 6.4 * k, 5.4 * k), o);                    // thumb
  if (pose === 'open') for (const f of [-0.44, -0.15, 0.15, 0.44]) draw(ctx, capsule(at(f * 0.55, 9), at(f, 29 - Math.abs(f) * 9), 4.7 * k, 4.2 * k), o);
  else if (pose === 'relaxed') draw(ctx, capsule(at(0, 7), at(0, 23), 12 * k, 9.5 * k), o);                                   // fingers together
  draw(ctx, ellipse(x, y, (pose === 'fist' ? 17 : 15.5) * k, 14.5 * k, 16, dir), o);                                               // palm
  ctx.strokeStyle = 'rgba(43,31,25,0.5)'; ctx.lineWidth = 1.4 * k; ctx.lineCap = 'round';
  if (pose === 'relaxed') for (const f of [-0.3, 0.3]) { const p0 = at(f * 0.9, 18), p1 = at(f * 0.5, 30); ctx.beginPath(); ctx.moveTo(...p0); ctx.lineTo(...p1); ctx.stroke(); }
  if (pose === 'fist') for (const f of [-0.5, 0, 0.5]) { const c = at(f * 0.75, 12); ctx.beginPath(); ctx.arc(c[0], c[1], 4.5 * k, dir - 1.2, dir + 1.2); ctx.stroke(); }
}
function star(ctx, x, y, r, rot) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) { const an = rot + i * Math.PI / 4, rr = i % 2 ? r * 0.28 : r; ctx.lineTo(x + Math.cos(an) * rr, y + Math.sin(an) * rr); }
  ctx.closePath(); ctx.fill();
}

// The café itself (window light, wood, ivy, drifting bokeh), drawn separately so a screen can hang on its wall behind the character.
export function cafeSet(ctx, box, t) {
  ctx.drawImage(background(Math.round(box.w), Math.round(box.h)), box.x, box.y);
  ctx.save(); ctx.globalCompositeOperation = 'lighter';                          // drifting warm bokeh in the window light
  for (const b of bokeh) { const x = box.x + b.x * box.w + Math.sin(t * 0.15 * b.v + b.p) * 20, y = box.y + b.y * box.h + Math.cos(t * 0.12 + b.p) * 10; const g = ctx.createRadialGradient(x, y, 0, x, y, b.s); g.addColorStop(0, `rgba(255,220,160,${0.1 + 0.06 * Math.sin(t * 0.5 + b.p)})`); g.addColorStop(1, 'rgba(255,220,160,0)'); ctx.fillStyle = g; ctx.fillRect(x - b.s, y - b.s, b.s * 2, b.s * 2); }
  ctx.restore();
}

export function cafeCharacter(ctx, st, box, a) {
  const E = express(a.mini ? 'cafe-mini' : 'cafe', a), t = a.t, frame = Math.floor(t * 8), dt = Math.min(0.05, a.dt || 1 / 30);
  const k = Math.min(box.w / 888, box.h / 852) * (a.mini ? 1.2 : 1);
  if (!a.mini && !a.noSet) cafeSet(ctx, box, t);
  ctx.save(); ctx.globalAlpha = a.alive;
  const X = x => box.x + box.w / 2 + x * k, Y = y => box.y + (a.mini ? box.h * 0.78 : box.h * 0.5) + y * k;
  const shake = E.shake * 3 * Math.sin(t * 38);                                   // laughing shakes the whole body a little
  // touching the face (chin, mouth, cheek), the head dips down onto the hand and leans toward it, as people do
  const touch = !a.mini && ['chin', 'cover', 'cheek'].includes(E.hand) ? E.handW : 0;
  const hx = E.turn * 40 - E.lean * 20 + shake - touch * 14, hy = (a.mini ? -210 : -95) - Math.max(0, E.bounce) * 60 + E.nod * 50 + E.breath * 2 + touch * 42;
  const lightFromRight = [X(260), Y(-300), X(-260), Y(300)];
  let afterHead = null;
  if (!a.mini) {
    // ---- a head-and-shoulders portrait: a slim sweater, neck, wrapped scarf, an arm holding the cup and a free arm ----
    const br = E.breath * 3 + E.shrug * 12, lean = E.lean * 20 + E.turn * 12 + shake, pencil = 3.2 * k;
    const P = q => [X(q[0]), Y(q[1])];
    // torso: rounded shoulders, narrower than the head, running off the bottom of the frame; shoulders rise in a shrug
    draw(ctx, [[X(-62 + lean), Y(196 - br)], [X(-124 + lean), Y(210 - br)], [X(-172 + lean), Y(238 - br)], [X(-186 + lean * 0.6), Y(284)], [X(-176), Y(356)], [X(-168), Y(420)], [X(-170), Y(470)],
      [X(170), Y(470)], [X(168), Y(420)], [X(176), Y(356)], [X(186 + lean * 0.6), Y(284)], [X(172 + lean), Y(238 - br)], [X(124 + lean), Y(210 - br)], [X(62 + lean), Y(196 - br)]], { fill: '#b39ad3', shade: lightFromRight, w: pencil });
    ctx.strokeStyle = 'rgba(70,45,90,0.22)'; ctx.lineWidth = 1.6 * k; ctx.lineCap = 'round';        // knit ribbing and two soft folds
    for (let x = -120; x <= 120; x += 40) { ctx.beginPath(); ctx.moveTo(X(x + lean * 0.3), Y(300)); ctx.quadraticCurveTo(X(x * 1.03 + lean * 0.15), Y(385), X(x * 1.06), Y(470)); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(70,45,90,0.35)'; ctx.lineWidth = 2 * k;
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(X(s * 134 + lean), Y(270)); ctx.quadraticCurveTo(X(s * 118 + lean * 0.5), Y(304), X(s * 124), Y(342)); ctx.stroke(); }
    // neck: slim, mostly hidden by the lower petals and the scarf
    draw(ctx, capsule(P([hx * 0.6, hy + 92]), P([lean * 0.8, 200 - br]), 22 * k, 23 * k), { fill: NECK, shade: lightFromRight, w: pencil, hatch: 0.25 });
    // scarf: a wrapped band, a knot, and two tails with fringe that swing a little
    draw(ctx, [[X(-76 + lean), Y(180 - br)], [X(-30 + lean), Y(168 - br)], [X(30 + lean), Y(168 - br)], [X(76 + lean), Y(180 - br)], [X(72 + lean), Y(214 - br)], [X(26 + lean), Y(228 - br)], [X(-26 + lean), Y(228 - br)], [X(-72 + lean), Y(214 - br)]],
      { fill: '#a33d33', shade: lightFromRight, w: pencil, hatch: 0.5 });
    const sw = Math.sin(t * 1.3) * 4 + E.energy * 7 * Math.sin(t * 5);
    for (const [x0, len, wd, off] of [[-34, 150, 17, 0], [-4, 116, 15, 10]]) {
      const x1 = x0 + sw + off * 0.4 - 6;
      draw(ctx, [[X(x0 - wd + lean), Y(222 - br)], [X(x0 + wd + lean), Y(222 - br)], [X(x1 + wd + 1), Y(222 + len)], [X(x1 - wd - 1), Y(222 + len)]], { fill: '#983830', shade: lightFromRight, w: pencil, hatch: 0.5 });
      ctx.strokeStyle = INK; ctx.lineWidth = 1.6 * k;
      for (let i = 0; i < 5; i++) { const x = X(x1 - wd + 3 + i * (2 * wd - 6) / 4); ctx.beginPath(); ctx.moveTo(x, Y(222 + len)); ctx.lineTo(x + Math.sin(t * 3 + i) * 2 * k, Y(240 + len)); ctx.stroke(); }
      ctx.strokeStyle = 'rgba(255,190,170,0.35)'; ctx.lineWidth = 4 * k;
      for (const u of [0.35, 0.65]) { ctx.beginPath(); ctx.moveTo(X(x0 - wd + 3 + (x1 - x0 - lean) * u + lean), Y(222 + len * u)); ctx.lineTo(X(x0 + wd - 3 + (x1 - x0 - lean) * u + lean), Y(222 + len * u)); ctx.stroke(); }
    }
    draw(ctx, ellipse(X(-22 + lean), Y(222 - br), 21 * k, 17 * k, 14, -0.2), { fill: '#a33d33', shade: lightFromRight, w: pencil, hatch: 0.5 });   // knot
    const SL = [-156 + lean, 252 - br], SR = [156 + lean, 252 - br];
    // the cup arm: holds the mug at the chest, gestures with it while talking, sips while waiting, raises it in a toast
    const sip = E.sip, cheer = E.cup * (1 - sip), talk = clamp(E.armR - 0.2) * (1 - sip) * (1 - E.cup);
    let cup = [92 + 8 * Math.sin(t * 0.7) + talk * 10 * Math.sin(t * 2.6), 305 - talk * 14 * Math.abs(Math.sin(t * 3))];
    let elR = [206 + lean * 0.5, 452];
    cup = lerp2(lerp2(cup, [38 + hx * 0.25, 22], sip), [188, 72 + 8 * Math.sin(t * 6)], cheer); cup = [cup[0] + 18 * E.shrug, cup[1] - 18 * E.shrug];
    elR = lerp2(lerp2(elR, [112 + hx * 0.1, 186], sip), [282, 212], cheer);
    // the free arm: hangs at the side, and comes up to the chin, mouth or cheek, opens to explain, shrugs, or waves
    const beat = Math.sin(t * 3.3 + Math.sin(t * 1.1) * 2) * E.speaking, wag = Math.sin(t * 9);
    const FREE = {
      rest: { e: [-204 + lean * 0.5, 448], h: [-196, 614], pose: 'relaxed' },
      open: { e: [-236, 440], h: [-126 + beat * 10, 336 - beat * 12], pose: 'open', twist: 0.2 },
      shrug: { e: [-250, 424], h: [-278, 292], pose: 'open', twist: -0.35 },
      wave: { e: [-318, 222], h: [-278 + wag * 18, 52], pose: 'open', twist: wag * 0.3 },
      chin: { e: [-104 + hx * 0.3, 232], h: [hx - 34, hy + 104], pose: 'fist', twist: 0.15 },
      cover: { e: [-96 + hx * 0.3, 228], h: [hx - 12, hy + 96], pose: 'relaxed', twist: -0.05 },
      cheek: { e: [-150 + hx * 0.3, 214], h: [hx - 82, hy + 80], pose: 'relaxed', twist: 0.25 },
    };
    let pose = FREE[E.hand] || FREE.rest;
    if (E.hand === 'open' && E.shrug > 0.05) pose = { ...pose, e: lerp2(pose.e, FREE.shrug.e, E.shrug), h: lerp2(pose.h, FREE.shrug.h, E.shrug), twist: pose.twist + (FREE.shrug.twist - pose.twist) * E.shrug };
    const w = E.handW, eT = lerp2(FREE.rest.e, pose.e, w), hT = lerp2(FREE.rest.h, pose.h, w);
    const elL = follow('elbowL', eT[0], eT[1], dt), hL = follow('handL', hT[0], hT[1], dt);
    const shapeL = w > 0.5 ? pose.pose : 'relaxed', twistL = (pose.twist || 0) * w;
    // arms and the cup are drawn after the head (they are in front of the body)
    afterHead = () => {
    // free arm
    const dirL = Math.atan2(hL[1] - elL[1], hL[0] - elL[0]) + twistL, wristL = [hL[0] - Math.cos(dirL) * 22, hL[1] - Math.sin(dirL) * 22];
    sleeve(ctx, P(SL), P(elL), P(wristL), k, lightFromRight, pencil);
    hand(ctx, X(hL[0]), Y(hL[1]), dirL, shapeL, 1, k * 1.6, lightFromRight, pencil);
    // cup arm: sleeve, palm behind the mug, the mug, then fingers wrapped around its front and the thumb along the rim
    const wristR = [cup[0] + 56, cup[1] + 12];
    sleeve(ctx, P(SR), P(elR), P(wristR), k, lightFromRight, pencil);
    const o = { fill: SKIN, shade: lightFromRight, w: pencil * 0.82, hatch: 0.14, dark: 0.2 };
    draw(ctx, ellipse(X(cup[0] + 40), Y(cup[1] + 2), 21 * k, 23 * k, 14, 0.2), o);
    draw(ctx, [[X(cup[0] - 38), Y(cup[1] - 36)], [X(cup[0] + 38), Y(cup[1] - 36)], [X(cup[0] + 32), Y(cup[1] + 30)], [X(cup[0] - 32), Y(cup[1] + 30)]], { fill: '#fbf6ee', shade: lightFromRight, w: pencil, dark: 0.18, hatch: 0.12 });
    draw(ctx, ellipse(X(cup[0]), Y(cup[1] - 36), 38 * k, 10 * k, 16), { fill: '#5a3a26', w: 2.4 * k, hatch: 0.2 });
    draw(ctx, ellipse(X(cup[0] - 46), Y(cup[1] - 4), 13 * k, 17 * k, 12), { line: INK, w: pencil });
    for (const [dy, len] of [[-17, 26], [0, 29], [17, 25]]) draw(ctx, capsule([X(cup[0] + 42), Y(cup[1] + dy)], [X(cup[0] + 42 - len), Y(cup[1] + dy + 2)], 8.2 * k, 7.2 * k), o);
    draw(ctx, capsule([X(cup[0] + 40), Y(cup[1] - 26)], [X(cup[0] + 22), Y(cup[1] - 46)], 7.6 * k, 6.4 * k), o);
    // steam: curls up, flattens while sipping, and is blown sideways
    ctx.strokeStyle = 'rgba(110,100,95,0.32)'; ctx.lineWidth = 2.4 * k; ctx.lineCap = 'round';
    for (let s = 0; s < 3; s++) { ctx.beginPath(); for (let i = 0; i <= 24; i++) { const u = i / 24; ctx.lineTo(X(cup[0] - 14 + s * 14 + Math.sin(u * 6 + t * 2.2 + s * 2) * 12 * u + E.blowing * u * 90), Y(cup[1] - 46 - u * 110 * (1 - sip * 0.6) * (1 - E.blowing * 0.5))); } ctx.globalAlpha = a.alive * (0.5 - s * 0.1) * (1 - sip * 0.5 + E.blowing * 0.4); ctx.stroke(); }
    ctx.globalAlpha = a.alive;
    };
  }
  // ---- the flower head ----
  ctx.save(); ctx.translate(X(hx), Y(hy)); ctx.rotate(E.tilt * 1.2); if (!a.mini) ctx.scale(1.22, 1.22); ctx.scale(1 - E.squash * 0.3, 1 + E.squash * 0.5);
  // petals are the character's hair and body language: they flare in surprise and delight, sag when sad, curl in when shy
  const petal = (i, n, len, width, base, col, seed, back) => {
    let an = i / n * TAU + (back ? Math.PI / n : 0) + 0.05 * Math.sin(t * 1.2 + i * 2.1) + E.speaking * 0.05 * Math.sin(t * 10 - i) + E.laugh * 0.08 * Math.sin(t * 16 + i) - E.listening * 0.1 * Math.cos(i / n * TAU) * 0.3;
    an += E.droop * 0.3 * Math.sin(Math.PI / 2 - an) + clamp(E.flare) * 0.05 * Math.sin(t * 18 + i * 1.7);
    const L = len * (1 + E.speaking * 0.08 * Math.sin(t * 7 - i * 0.9) + E.energy * 0.06 - (E.smile < 0 ? 0.05 : 0) + E.flare * 0.13 - E.droop * 0.1 - E.shy * 0.14) * k,
      Wd = width * (1 + E.flare * 0.08) * k, B = base * k, curl = Math.sin(t * 0.9 + i) * 0.08 + E.tilt * 0.3 + E.shy * 0.45;
    const pts = [];
    for (let s = -1; s <= 1; s += 2) for (let j = 0; j <= 6; j++) { const u = s < 0 ? j / 6 : 1 - j / 6, r = B + u * (L - B), w = Wd * Math.sin(Math.PI * (0.18 + u * 0.82)) ** 0.9 * (1 - u * 0.25); const off = s * w + curl * u * u * L * 0.25; pts.push([Math.cos(an) * r - Math.sin(an) * off, Math.sin(an) * r + Math.cos(an) * off]); }
    draw(ctx, boil(pts, 1.1 * k, seed), { fill: col, shade: [Math.cos(an) * L, Math.sin(an) * L, 0, 0], dark: 0.28, w: 3 * k, hatch: 0.3 });
    ctx.strokeStyle = 'rgba(120,50,25,0.3)'; ctx.lineWidth = 1.4 * k; ctx.beginPath(); ctx.moveTo(Math.cos(an) * B * 1.1, Math.sin(an) * B * 1.1); ctx.lineTo(Math.cos(an) * L * 0.8, Math.sin(an) * L * 0.8); ctx.stroke();
  };
  for (let i = 0; i < 12; i++) petal(i, 12, 238, 40, 80, '#c9683f', frame * 50 + i, true);
  for (let i = 0; i < 12; i++) petal(i, 12, 222, 44, 80, '#e3875a', frame * 50 + 20 + i, false);
  // surprise lines: three quick strokes either side, like a start in a storybook
  if (E.shock > 0.05) {
    ctx.save(); ctx.globalAlpha *= clamp(E.shock); ctx.strokeStyle = '#2b1f19'; ctx.lineWidth = 3 * k; ctx.lineCap = 'round';
    for (const side of [-1, 1]) for (const an of [-0.55, -0.3, -0.05]) { const a0 = side < 0 ? Math.PI - an : an, r0 = 262 * k, r1 = (292 + 12 * Math.sin(t * 20)) * k;
      ctx.beginPath(); ctx.moveTo(Math.cos(a0 - 0.6) * r0, Math.sin(a0 - 0.6) * r0); ctx.lineTo(Math.cos(a0 - 0.6) * r1, Math.sin(a0 - 0.6) * r1); ctx.stroke(); }
    ctx.restore();
  }
  // sparkles around the head when delighted
  if (E.sparkle > 0.05) {
    ctx.save(); ctx.fillStyle = '#fff3c4'; ctx.strokeStyle = '#2b1f19';
    for (const [sx, sy, ph] of [[-190, -170, 0], [205, -120, 1.7], [170, 175, 3.1], [-215, 90, 4.4]]) {
      const tw = 0.5 + 0.5 * Math.sin(t * 5 + ph); ctx.globalAlpha *= 1; ctx.save(); ctx.globalAlpha = a.alive * clamp(E.sparkle) * (0.4 + 0.6 * tw);
      star(ctx, sx * k, sy * k, (10 + 8 * tw) * k, t * 0.8 + ph); ctx.lineWidth = 1.4 * k; ctx.stroke(); ctx.restore();
    }
    ctx.restore();
  }
  const R = 102 * k;
  draw(ctx, boil(ellipse(0, 0, R, R, 26), 1.2 * k, frame * 9 + 99), { fill: '#f7ecd8', shade: [R, -R, -R, R], dark: 0.18, w: 3.2 * k, hatch: 0.18 });
  // cheeks, with pencil hatching when really blushing
  for (const side of [-1, 1]) {
    const g = ctx.createRadialGradient(side * 58 * k, 28 * k, 0, side * 58 * k, 28 * k, 30 * k); g.addColorStop(0, `rgba(235,120,110,${0.28 + E.blush * 0.35})`); g.addColorStop(1, 'rgba(235,120,110,0)'); ctx.fillStyle = g; ctx.fillRect(side * 58 * k - 30 * k, -2 * k, 60 * k, 60 * k);
    if (E.blush > 0.5) { ctx.save(); ctx.globalAlpha *= clamp((E.blush - 0.5) * 2); ctx.strokeStyle = '#c0504a'; ctx.lineWidth = 2 * k; ctx.lineCap = 'round';
      for (let j = -1; j <= 1; j++) { ctx.beginPath(); ctx.moveTo(side * 58 * k + j * 10 * k - 4 * k, 22 * k); ctx.lineTo(side * 58 * k + j * 10 * k + 4 * k, 32 * k); ctx.stroke(); } ctx.restore(); }
  }
  // eyes: open and bright; closed and content while sipping or humming; ^^ when laughing; starry, glossy or sceptical
  const gx = E.gazeX * 9 * k, gy = E.gazeY * 7 * k, ink = '#221812', closed = Math.max(E.sip * (1 - E.blowing), E.content);
  ctx.strokeStyle = ink; ctx.fillStyle = ink; ctx.lineCap = 'round';
  for (const side of [-1, 1]) {
    const ex = side * 38 * k, ey = -14 * k, open = E.eyeOpen * (E.wink && side === 1 ? 0 : E.blink) * (1 - closed * 0.95);
    ctx.lineWidth = 3.6 * k;
    if (E.laugh > 0.3 || E.squint > 0.6) { ctx.beginPath(); ctx.arc(ex, ey + 8 * k, 13 * k, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke(); }
    else if (open < 0.3) { ctx.beginPath(); ctx.arc(ex, ey - 8 * k, 14 * k, Math.PI * 0.2, Math.PI * 0.8); ctx.stroke(); for (const l of [-1, 0, 1]) { ctx.lineWidth = 1.6 * k; ctx.beginPath(); ctx.moveTo(ex + l * 9 * k, ey + 5 * k); ctx.lineTo(ex + l * 11 * k, ey + 9 * k); ctx.stroke(); } }
    else {
      const h = 15 * k * clamp(open, 0.3, 1.4) * (1 - E.squint * 0.4), wide = 1 - clamp(E.surprise) * 0.15;
      ctx.beginPath(); ctx.ellipse(ex + gx, ey + gy, 10.5 * k * wide, h, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#fffaf0';
      if (E.sparkle > 0.3) star(ctx, ex + gx + 2.5 * k, ey + gy - h * 0.3, (5 + 3 * E.sparkle) * k, t * 1.5);
      else { const g = 1 + E.gloss * 0.6; ctx.beginPath(); ctx.arc(ex + gx + 3.5 * k, ey + gy - h * 0.4, 3.6 * k * g, 0, TAU); ctx.fill(); }
      ctx.beginPath(); ctx.arc(ex + gx - 3 * k, ey + gy + h * 0.35, 1.6 * k * (1 + E.gloss), 0, TAU); ctx.fill(); ctx.fillStyle = ink;
      // watery lower rim when moved
      if (E.gloss > 0.1) { ctx.save(); ctx.globalAlpha *= clamp(E.gloss); ctx.strokeStyle = 'rgba(120,170,210,0.9)'; ctx.lineWidth = 2.4 * k; ctx.beginPath(); ctx.arc(ex + gx, ey + gy + 2 * k, 12 * k, Math.PI * 0.2, Math.PI * 0.8); ctx.stroke(); ctx.restore(); }
      // eyelid: heavy when tired, and one lowered lid for a sceptical look
      const lid = Math.max(0, 0.8 - E.eyeOpen) * 1.6 + (side === 1 ? E.skeptic * 0.5 : 0);
      if (lid > 0.08) { const c = clamp(lid, 0, 0.85), top = ey + gy - h - 2 * k, cover = (2 * h + 2 * k) * c * 0.6;
        ctx.fillStyle = '#f7ecd8'; ctx.fillRect(ex + gx - 13 * k, top, 26 * k, cover); ctx.fillStyle = ink;
        ctx.lineWidth = 2.6 * k; ctx.beginPath(); ctx.moveTo(ex + gx - 12 * k, top + cover); ctx.lineTo(ex + gx + 12 * k, top + cover - side * E.skeptic * 3 * k); ctx.stroke(); }
    }
    // brows: lifted, worried (inner ends up), or one raised in doubt
    const lift = (side === -1 ? E.browL : E.browR) * 10 * k, inner = E.worry * 9 * k, doubt = E.skeptic * (side === 1 ? 6 : -4) * k;
    ctx.lineWidth = 2.8 * k; ctx.beginPath(); ctx.moveTo(ex - side * 13 * k, ey - 30 * k - lift - inner - doubt * 0.5); ctx.quadraticCurveTo(ex, ey - 36 * k - lift - inner * 0.4 - doubt, ex + side * 14 * k, ey - 29 * k - lift + (E.worry ? 2 * k : 0)); ctx.stroke();
  }
  // a sweat drop when flustered
  if (E.sweat > 0.05) {
    const sy = (-40 + ((t * 18) % 26)) * k, sx = 86 * k;
    ctx.save(); ctx.globalAlpha *= clamp(E.sweat); ctx.fillStyle = '#bfe0f2'; ctx.strokeStyle = '#2b1f19'; ctx.lineWidth = 2 * k;
    ctx.beginPath(); ctx.moveTo(sx, sy - 12 * k); ctx.quadraticCurveTo(sx + 8 * k, sy + 2 * k, sx, sy + 7 * k); ctx.quadraticCurveTo(sx - 8 * k, sy + 2 * k, sx, sy - 12 * k); ctx.fill(); ctx.stroke(); ctx.restore();
  }
  // mouth: lopsided in a smirk or doubt, wobbly when worried, an "o" in surprise or when blowing, teeth in a big laugh
  const open = E.mouthOpen, smile = E.smile, sm = E.smirk * 7 * k, mw = (26 - E.mouthRound * 9 + E.laugh * 8) * k, my = 38 * k;
  ctx.lineWidth = 3.4 * k; ctx.strokeStyle = ink;
  if (open < 0.07) {
    if (E.worry > 0.45 && smile < 0.15) { ctx.beginPath(); for (let i = 0; i <= 16; i++) { const u = i / 16; ctx.lineTo(-mw + u * 2 * mw, my + 2 * k + Math.sin(u * TAU * 2) * 2.2 * k - smile * 6 * k); } ctx.stroke(); }
    else { ctx.beginPath(); ctx.moveTo(-mw, my - smile * 6 * k + sm * 0.8); ctx.quadraticCurveTo(sm * 0.8, my + smile * 16 * k, mw, my - smile * 6 * k - sm * 1.2); ctx.stroke(); }
  } else if (E.mouthRound > 0.55 && open < 0.6) {
    const rh = (8 + 22 * open) * k; ctx.fillStyle = '#3a1a14'; ctx.beginPath(); ctx.ellipse(0, my + rh * 0.35, mw * 0.55, rh * 0.6, 0, 0, TAU); ctx.fill(); ctx.stroke();
  } else {
    const h = (8 + 34 * open) * k, p = new Path2D();
    p.moveTo(-mw, my - smile * 5 * k + sm * 0.6); p.quadraticCurveTo(0, my + smile * 6 * k, mw, my - smile * 5 * k - sm); p.quadraticCurveTo(0, my + h + smile * 8 * k, -mw, my - smile * 5 * k + sm * 0.6);
    ctx.fillStyle = '#3a1a14'; ctx.fill(p); ctx.stroke(p);
    ctx.save(); ctx.clip(p);
    if (open > 0.45 && (E.laugh > 0.3 || smile > 0.8)) { ctx.fillStyle = '#fffaf0'; ctx.fillRect(-mw, my - 12 * k, mw * 2, 12 * k + smile * 6 * k + h * 0.14); }
    if (open > 0.3) { ctx.fillStyle = '#d9707a'; ctx.beginPath(); ctx.ellipse(0, my + h * 0.85, mw * 0.55, h * 0.35, 0, 0, TAU); ctx.fill(); }
    ctx.restore(); ctx.stroke(p);
  }
  ctx.restore();
  afterHead?.();
  ctx.restore();
}
const mix = (a, b, t) => a + (b - a) * t;
