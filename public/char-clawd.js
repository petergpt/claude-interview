// Clawd in papercraft: a real-time 3D render of chamfered folded-paper boxes, lit by a key, fill and rim
// light, with paper grain, crease highlights and contact shadows. Driven by the shared emotion engine.
import { express } from './expression.js';

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const rx = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c]; };
const ry = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]; };
const rz = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]]; };
const add = (p, q) => [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
const norm = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const KEY = norm([-0.5, 0.75, 0.6]), FILL = norm([0.8, 0.1, 0.5]), RIM = norm([0.3, 0.4, -0.9]);

// A box with chamfered edges: 6 faces, 12 edge strips and 8 corner triangles, like folded card.
function chamferBox(h, c) {
  const faces = [], H = h, I = h.map(v => v - c);
  for (let a = 0; a < 3; a++) for (const s of [-1, 1]) {
    const b = (a + 1) % 3, d = (a + 2) % 3, pts = [];
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const p = [0, 0, 0]; p[a] = s * H[a]; p[b] = u * I[b]; p[d] = v * I[d]; pts.push(p); }
    const n = [0, 0, 0]; n[a] = s; faces.push({ pts, n, main: true, axis: a, sign: s });
  }
  for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) for (const sa of [-1, 1]) for (const sb of [-1, 1]) {
    const d = 3 - a - b, pts = [];
    for (const [onA, sd] of [[true, -1], [true, 1], [false, 1], [false, -1]]) { const p = [0, 0, 0]; p[a] = sa * (onA ? H[a] : I[a]); p[b] = sb * (onA ? I[b] : H[b]); p[d] = sd * I[d]; pts.push(p); }
    const n = [0, 0, 0]; n[a] = sa; n[b] = sb; faces.push({ pts, n: norm(n), edge: true });
  }
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1])
    faces.push({ pts: [[sx * H[0], sy * I[1], sz * I[2]], [sx * I[0], sy * H[1], sz * I[2]], [sx * I[0], sy * I[1], sz * H[2]]], n: norm([sx, sy, sz]), edge: true });
  return faces;
}
const MESH = {
  body: chamferBox([1.05, 0.74, 0.74], 0.07),
  arm: chamferBox([0.17, 0.2, 0.21], 0.045),
  leg: chamferBox([0.16, 0.2, 0.17], 0.04),
};
let grain;
function paperGrain() {
  if (grain) return grain;
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'), img = g.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) { const v = 128 + (Math.random() - 0.5) * 90; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 26; }
  g.putImageData(img, 0, 0);
  for (let i = 0; i < 40; i++) { g.strokeStyle = `rgba(255,255,255,${Math.random() * 0.12})`; g.beginPath(); const x = Math.random() * 128, y = Math.random() * 128; g.moveTo(x, y); g.lineTo(x + Math.random() * 20 - 10, y + Math.random() * 20 - 10); g.stroke(); }
  return grain = c;
}
function rgbOf(hex) { const h = hex.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); }

export function clawd3d(ctx, st, box, a) {
  const E = express(a.mini ? 'clawd-mini' : 'clawd', a), t = a.t;
  const cx = box.x + box.w * 0.5, cy = box.y + box.h * (a.mini ? 0.56 : 0.54), f = Math.min(box.w, box.h * 1.05) * 1.32;
  if (!a.mini) {
    const g = ctx.createRadialGradient(cx - box.w * 0.1, cy - box.h * 0.25, 20, cx, cy, box.w * 0.85);
    g.addColorStop(0, 'rgba(255,250,242,0.75)'); g.addColorStop(0.6, 'rgba(255,250,242,0)'); g.addColorStop(1, 'rgba(120,80,50,0.12)');
    ctx.fillStyle = g; ctx.fillRect(box.x, box.y, box.w, box.h);
  }
  // ---- pose ----
  const lift = Math.max(0, E.bounce) * 0.55 + E.breath * 0.012;
  const sq = E.squash + (E.bounce < 0 ? E.bounce * 0.3 : 0), sy = 1 + sq, sxz = 1 - sq * 0.5;
  const yaw = E.turn, pitch = E.nod + E.lean * 0.6, roll = E.tilt;
  const armL = E.armL, armR = E.armR, energy = clamp(E.energy);
  const parts = [
    { mesh: MESH.body, c: [0, 0.34, 0], id: 'body' },
    { mesh: MESH.arm, c: [-1.2, 0.3, 0.05], id: 'armL' },
    { mesh: MESH.arm, c: [1.2, 0.3, 0.05], id: 'armR' },
    ...[-0.72, -0.25, 0.25, 0.72].map((x, i) => ({ mesh: MESH.leg, c: [x, -0.6, 0.34], id: `leg${i}`, i })),
  ];
  const legLift = i => (energy * 0.12 + E.speaking * 0.04) * Math.max(0, Math.sin(t * 9 + i * 1.7)) + lift * (i % 2 ? 0.15 : 0.25);
  const local = (part, p) => {
    if (part.id === 'body') return [p[0] * sxz, (p[1] + 0.74) * sy - 0.74 + 0.34, p[2] * sxz];
    let q = add(p, part.c);
    if (part.id === 'armL') { q = add(q, [1.03, -0.3 * sy, 0]); q = rz(q, -armL); q = rx(q, -0.2 * armL * Math.sin(t * 2)); q = add(q, [-1.03 * sxz, 0.3 * sy, 0]); }
    if (part.id === 'armR') { q = add(q, [-1.03, -0.3 * sy, 0]); q = rz(q, armR); q = rx(q, 0.2 * armR * Math.sin(t * 2.3)); q = add(q, [1.03 * sxz, 0.3 * sy, 0]); }
    if (part.id.startsWith('leg')) q = add(q, [0, legLift(part.i) - lift, 0]);
    return q;
  };
  const toCam = p => {
    p = rz(p, roll); p = rx(p, pitch); p = ry(p, yaw);
    p = add(p, [0, lift - 0.12, 0]);
    p = rx(p, 0.3);
    return [p[0], p[1], 7.4 - p[2]];
  };
  const nCam = (part, n) => {
    if (part.id === 'armL') n = rz(n, -armL); if (part.id === 'armR') n = rz(n, armR);
    n = rz(n, roll); n = rx(n, pitch); n = ry(n, yaw); n = rx(n, 0.3); return [n[0], n[1], -n[2]];
  };
  const proj = p => [cx + f * p[0] / p[2], cy - f * p[1] / p[2]];

  // ---- shadows on the floor: a broad soft one and small contact shadows under the feet ----
  const ground = (x, z) => { let p = ry([x, -0.8, z], yaw); p = add(p, [0, -0.12, 0]); p = rx(p, 0.3); return proj([p[0], p[1], 7.4 - p[2]]); };
  const g0 = ground(0, 0.05), air = clamp(lift * 3);
  ctx.save(); ctx.translate(g0[0], g0[1]); ctx.scale(1, 0.26);
  const R = f * 0.3 * (1 - air * 0.25), sg = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
  sg.addColorStop(0, `rgba(90,50,28,${0.34 * a.alive * (1 - air * 0.5)})`); sg.addColorStop(1, 'rgba(90,50,28,0)');
  ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  for (const x of [-0.72, -0.25, 0.25, 0.72]) {
    const s = ground(x, 0.34);
    ctx.fillStyle = `rgba(60,32,18,${0.24 * a.alive * (1 - air)})`; ctx.beginPath(); ctx.ellipse(s[0], s[1], f * 0.03, f * 0.009, 0, 0, Math.PI * 2); ctx.fill();
  }

  // ---- faces, lit and depth-sorted ----
  const base = rgbOf(st.clay), floorBounce = [255, 236, 214], quads = [];
  for (const part of parts) for (const face of part.mesh) {
    const pts = face.pts.map(p => toCam(local(part, p)));
    const n = nCam(part, face.n), c = pts.reduce((m, p) => [m[0] + p[0] / pts.length, m[1] + p[1] / pts.length, m[2] + p[2] / pts.length], [0, 0, 0]);
    if (dot(n, c) >= 0) continue;
    const view = [n[0], n[1], -n[2]];
    const key = Math.max(0, dot(view, KEY)), fill = Math.max(0, dot(view, FILL)), rim = Math.pow(Math.max(0, dot(view, RIM)), 2), up = Math.max(0, -view[1]);
    const col = base.map((v, i) => clamp(v * (0.5 + 0.55 * key + 0.16 * fill) + rim * 40 + up * (floorBounce[i] - v) * 0.12 + (face.edge ? 10 : 0), 0, 255) | 0);
    quads.push({ pts, z: c[2], col, edge: face.edge, front: part.id === 'body' && face.main && face.axis === 2 && face.sign === 1, part });
  }
  quads.sort((p, q) => q.z - p.z);
  ctx.save(); ctx.globalAlpha = a.alive; ctx.lineJoin = 'round';
  const pattern = ctx.createPattern(paperGrain(), 'repeat');
  for (const q of quads) {
    const s = q.pts.map(proj);
    ctx.beginPath(); s.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath();
    ctx.fillStyle = `rgb(${q.col.join(',')})`; ctx.fill();
    if (!q.edge && !a.mini) { ctx.fillStyle = pattern; ctx.fill(); }
    ctx.strokeStyle = `rgba(${q.col.map(v => Math.min(255, v + (q.edge ? 30 : 12))).join(',')},0.9)`; ctx.lineWidth = Math.max(0.6, f * 0.0016); ctx.stroke();
    if (q.front) drawFace(ctx, st, E, p => proj(toCam(local(q.part, p))), a);
  }
  ctx.restore();
}

// Face details live on the front panel of the body: eyes with highlights, brows that appear with feeling,
// blush, and a mouth that smiles, frowns, and opens with the audio being played.
function drawFace(ctx, st, E, P, a) {
  const z = 0.745, poly = pts => { ctx.beginPath(); pts.forEach((p, i) => { const [x, y] = P([p[0], p[1], z]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); };
  const rr = (x, y, w, h, r = 0.035) => { const pts = [], k = 5; for (const [cx, cy, a0] of [[x + w - r, y + h - r, 0], [x - w + r, y + h - r, Math.PI / 2], [x - w + r, y - h + r, Math.PI], [x + w - r, y - h + r, Math.PI * 1.5]]) for (let i = 0; i <= k; i++) { const an = a0 + i / k * Math.PI / 2; pts.push([cx + Math.cos(an) * r, cy + Math.sin(an) * r]); } return pts; };
  const gx = E.gazeX * 0.05, gy = -E.gazeY * 0.045, eyeY = 0.2 + E.nod * -0.02;
  // blush
  if (E.blush > 0.05) for (const side of [-1, 1]) { ctx.fillStyle = `rgba(236,110,110,${clamp(E.blush) * 0.45})`; poly(rr(side * 0.62, -0.08, 0.13, 0.055, 0.05)); ctx.fill(); }
  for (const side of [-1, 1]) {
    const ex = side * 0.4 + gx, open = E.eyeOpen * (E.wink && side === 1 ? 0.08 : E.blink), w = 0.125 * (1 + E.surprise * 0.15), h = 0.155 * clamp(open, 0.06, 1.5) * (1 - E.squint * 0.55);
    ctx.fillStyle = st.eye;
    if (E.squint > 0.6 || E.laugh > 0.3) {   // happy ^ eyes
      poly([[ex - w, eyeY - 0.03], [ex, eyeY + 0.1], [ex + w, eyeY - 0.03], [ex + w * 0.66, eyeY - 0.08], [ex, eyeY + 0.02], [ex - w * 0.66, eyeY - 0.08]]); ctx.fill();
    } else {
      const top = eyeY + gy + h, bottom = eyeY + gy - h;
      poly(rr(ex, (top + bottom) / 2, w, (top - bottom) / 2, Math.min(0.04, (top - bottom) / 2))); ctx.fill();
      if (open > 0.4) { ctx.fillStyle = 'rgba(255,255,255,0.85)'; poly(rr(ex - w * 0.4 + gx * 0.4, top - 0.05, 0.03, 0.028, 0.012)); ctx.fill(); }
    }
    // brows appear only when there is something to express
    const lift = side === -1 ? E.browL : E.browR, show = clamp(Math.abs(lift) * 2.2 + E.worry * 2.5);
    if (show > 0.05) {
      // inner end rises with worry and drops when brows are lowered (serious)
      const by = eyeY + 0.25 + Math.max(0, lift) * 0.09, innerUp = E.worry * 0.07 + Math.min(0, lift) * 0.08, xi = ex - side * 0.14, xo = ex + side * 0.14;
      ctx.fillStyle = st.eye; ctx.globalAlpha *= show;
      poly([[xi, by + innerUp], [xo, by], [xo, by - 0.035], [xi, by + innerUp - 0.035]]); ctx.fill();
      ctx.globalAlpha /= show;
    }
  }
  // mouth
  const open = E.mouthOpen, smile = E.smile, round = E.mouthRound, my = -0.22 - E.nod * 0.01;
  ctx.fillStyle = st.eye; ctx.strokeStyle = st.eye; ctx.lineCap = 'round';
  if (open < 0.06) {           // a small smile (or frown) line
    const pts = []; for (let i = 0; i <= 12; i++) { const u = i / 12 * 2 - 1; pts.push([u * 0.16, my - (1 - u * u) * smile * 0.07 + (smile < 0 ? 0 : 0)]); }
    ctx.lineWidth = Math.max(1.5, Math.abs(P([0, 0, z])[0] - P([0.028, 0, z])[0]));
    ctx.beginPath(); pts.forEach((p, i) => { const [x, y] = P([p[0], p[1], z]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
  } else {
    const w = 0.2 - round * 0.08 + smile * 0.04, h = 0.04 + open * 0.2, top = [], bottom = [];
    for (let i = 0; i <= 12; i++) { const u = i / 12 * 2 - 1; top.push([u * w, my + smile * 0.03 * (u * u) - 0.005]); bottom.push([u * w * (1 - round * 0.2), my - h * Math.sqrt(1 - u * u * 0.9) - smile * 0.02]); }
    poly([...top, ...bottom.reverse()]); ctx.fill();
    if (open > 0.35) { ctx.fillStyle = 'rgba(232,120,120,0.95)'; poly(rr(0, my - h * 0.72, w * 0.45, h * 0.2, 0.03)); ctx.fill(); }
  }
  // a bead of sweat when nervous
  if (E.sweat > 0.1) { ctx.fillStyle = `rgba(160,210,240,${E.sweat})`; poly([[0.8, 0.5], [0.76, 0.38], [0.8, 0.34], [0.84, 0.38]]); ctx.fill(); }
}
