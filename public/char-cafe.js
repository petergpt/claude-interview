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

export function cafeCharacter(ctx, st, box, a) {
  const E = express(a.mini ? 'cafe-mini' : 'cafe', a), t = a.t, frame = Math.floor(t * 8);
  const k = Math.min(box.w / 888, box.h / 852) * (a.mini ? 1.2 : 1);
  if (!a.mini) {
    ctx.drawImage(background(Math.round(box.w), Math.round(box.h)), box.x, box.y);
    ctx.save(); ctx.globalCompositeOperation = 'lighter';                          // drifting warm bokeh in the window light
    for (const b of bokeh) { const x = box.x + b.x * box.w + Math.sin(t * 0.15 * b.v + b.p) * 20, y = box.y + b.y * box.h + Math.cos(t * 0.12 + b.p) * 10; const g = ctx.createRadialGradient(x, y, 0, x, y, b.s); g.addColorStop(0, `rgba(255,220,160,${0.1 + 0.06 * Math.sin(t * 0.5 + b.p)})`); g.addColorStop(1, 'rgba(255,220,160,0)'); ctx.fillStyle = g; ctx.fillRect(x - b.s, y - b.s, b.s * 2, b.s * 2); }
    ctx.restore();
  }
  ctx.save(); ctx.globalAlpha = a.alive;
  const X = x => box.x + box.w / 2 + x * k, Y = y => box.y + (a.mini ? box.h * 0.78 : box.h * 0.5) + y * k;
  const hx = E.turn * 40 - E.lean * 20, hy = (a.mini ? -210 : -95) - Math.max(0, E.bounce) * 60 + E.nod * 50 + E.breath * 2;
  const lightFromRight = [X(260), Y(-300), X(-260), Y(300)];
  let afterHead = null;
  if (!a.mini) {
    // ---- a head-and-shoulders portrait: sweater, neck, wrapped scarf, and an arm holding the cup ----
    const br = E.breath * 3, lean = E.lean * 20 + E.turn * 12, pencil = 3.2 * k;
    const tubeP = (pts, width, color) => {                                // an outlined pencil tube (sleeves, neck)
      const path = new Path2D(); path.moveTo(...pts[0]); for (const q of pts.slice(1)) path.lineTo(...q);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = '#2b1f19'; ctx.lineWidth = width + pencil * 2; ctx.stroke(path);
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke(path);
      ctx.save(); ctx.globalAlpha *= 0.3; ctx.strokeStyle = ctx.createPattern(hatchTex(), 'repeat'); ctx.lineWidth = width * 0.9; ctx.stroke(path); ctx.restore();
    };
    // torso with natural sloping shoulders (runs off the bottom of the frame)
    draw(ctx, [[X(-300), Y(470)], [X(-292), Y(350)], [X(-250 + lean), Y(262 - br)], [X(-150 + lean), Y(215 - br)], [X(-60 + lean), Y(196 - br)],
      [X(60 + lean), Y(196 - br)], [X(150 + lean), Y(215 - br)], [X(250 + lean), Y(262 - br)], [X(292), Y(350)], [X(300), Y(470)]], { fill: '#b39ad3', shade: lightFromRight, w: pencil });
    ctx.strokeStyle = 'rgba(70,45,90,0.35)'; ctx.lineWidth = 2 * k;       // a few soft folds
    for (const [x0, y0, x1, y1] of [[-200, 300, -170, 420], [-120, 330, -110, 430], [190, 300, 165, 420]]) { ctx.beginPath(); ctx.moveTo(X(x0 + lean * 0.5), Y(y0)); ctx.quadraticCurveTo(X((x0 + x1) / 2 + 10), Y((y0 + y1) / 2), X(x1), Y(y1)); ctx.stroke(); }
    // neck
    tubeP([[X(hx * 0.7), Y(hy + 110)], [X(lean * 0.8), Y(200 - br)]], 76 * k, '#b56a45');
    // scarf: a wrapped band around the neck and two short ends with fringe
    draw(ctx, [[X(-98 + lean), Y(178 - br)], [X(-40 + lean), Y(162 - br)], [X(40 + lean), Y(162 - br)], [X(98 + lean), Y(178 - br)], [X(92 + lean), Y(226 - br)], [X(30 + lean), Y(246 - br)], [X(-30 + lean), Y(246 - br)], [X(-92 + lean), Y(226 - br)]],
      { fill: '#a33d33', shade: lightFromRight, w: pencil, hatch: 0.5 });
    const sw = Math.sin(t * 1.3) * 5 + E.energy * 8 * Math.sin(t * 5);
    for (const [x0, len, off] of [[-5, 170, 0], [38, 140, 14]]) {
      draw(ctx, [[X(x0 - 24 + lean), Y(200 - br)], [X(x0 + 24 + lean), Y(200 - br)], [X(x0 + 26 + sw + off * 0.3), Y(200 + len)], [X(x0 - 22 + sw + off * 0.3), Y(200 + len)]], { fill: '#983830', shade: lightFromRight, w: pencil, hatch: 0.5 });
      ctx.strokeStyle = '#2b1f19'; ctx.lineWidth = 1.8 * k;
      for (let i = 0; i < 6; i++) { const x = X(x0 - 20 + i * 8 + sw + off * 0.3); ctx.beginPath(); ctx.moveTo(x, Y(200 + len)); ctx.lineTo(x + Math.sin(t * 3 + i) * 2 * k, Y(222 + len)); ctx.stroke(); }
      ctx.strokeStyle = 'rgba(255,190,170,0.35)'; ctx.lineWidth = 5 * k;
      for (const y of [0.3, 0.6]) { ctx.beginPath(); ctx.moveTo(X(x0 - 20 + lean + sw * y), Y(200 + len * y)); ctx.lineTo(X(x0 + 22 + lean + sw * y), Y(200 + len * y)); ctx.stroke(); }
    }
    // right arm holding the cup at the chest; while waiting, a slow sip
    const sip = E.thinking, gesture = clamp(E.armR - 0.2) * (1 - sip);
    const cup = [mix(mix(150, 175, gesture), 70 + hx * 0.2, sip), mix(mix(345, 315 + 20 * Math.sin(t * 3), gesture), 30, sip)];
    const shoulder = [205 + lean, 250 - br], l1 = 150, l2 = 135;
    let dx = cup[0] + 30 - shoulder[0], dy = cup[1] + 40 - shoulder[1], d = Math.hypot(dx, dy); const m = l1 + l2 - 1; if (d > m) { dx *= m / d; dy *= m / d; d = m; }
    const ang = Math.atan2(dy, dx) - Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
    const elbow = [shoulder[0] + Math.cos(ang) * l1, shoulder[1] + Math.sin(ang) * l1], wrist = [shoulder[0] + dx, shoulder[1] + dy];
    tubeP([[X(shoulder[0]), Y(shoulder[1])], [X(elbow[0]), Y(elbow[1])], [X(wrist[0]), Y(wrist[1])]], 78 * k, '#a88ec8');
    // cup (porcelain, coffee, handle) held by the hand — drawn after the head
    afterHead = () => {
    draw(ctx, [[X(cup[0] - 38), Y(cup[1] - 36)], [X(cup[0] + 38), Y(cup[1] - 36)], [X(cup[0] + 32), Y(cup[1] + 30)], [X(cup[0] - 32), Y(cup[1] + 30)]], { fill: '#fbf6ee', shade: lightFromRight, w: pencil, dark: 0.18, hatch: 0.12 });
    draw(ctx, ellipse(X(cup[0]), Y(cup[1] - 36), 38 * k, 10 * k, 16), { fill: '#5a3a26', w: 2.4 * k, hatch: 0.2 });
    draw(ctx, ellipse(X(cup[0] - 46), Y(cup[1] - 4), 13 * k, 17 * k, 12), { line: '#2b1f19', w: pencil });
    draw(ctx, ellipse(X(wrist[0] - 4), Y(wrist[1] - 18), 34 * k, 28 * k, 16, 0.5), { fill: '#b56a45', shade: lightFromRight, w: pencil });
    ctx.strokeStyle = 'rgba(110,100,95,0.32)'; ctx.lineWidth = 2.4 * k; ctx.lineCap = 'round';
    for (let s = 0; s < 3; s++) { ctx.beginPath(); for (let i = 0; i <= 24; i++) { const u = i / 24; ctx.lineTo(X(cup[0] - 14 + s * 14 + Math.sin(u * 6 + t * 2.2 + s * 2) * 12 * u), Y(cup[1] - 46 - u * 110 * (1 - sip * 0.6))); } ctx.globalAlpha = a.alive * (0.5 - s * 0.1) * (1 - sip * 0.5); ctx.stroke(); }
    ctx.globalAlpha = a.alive;
    };
  }
  // ---- the flower head ----
  ctx.save(); ctx.translate(X(hx), Y(hy)); ctx.rotate(E.tilt * 1.2); if (!a.mini) ctx.scale(1.22, 1.22); ctx.scale(1 - E.squash * 0.3, 1 + E.squash * 0.5);
  const petal = (i, n, len, width, base, col, seed, back) => {
    const an = i / n * TAU + (back ? Math.PI / n : 0) + 0.05 * Math.sin(t * 1.2 + i * 2.1) + E.speaking * 0.05 * Math.sin(t * 10 - i) + E.laugh * 0.08 * Math.sin(t * 16 + i) - E.listening * 0.1 * Math.cos(i / n * TAU) * 0.3;
    const L = len * (1 + E.speaking * 0.08 * Math.sin(t * 7 - i * 0.9) + E.energy * 0.06 - (E.smile < 0 ? 0.05 : 0)) * k, Wd = width * k, B = base * k, curl = Math.sin(t * 0.9 + i) * 0.08 + E.tilt * 0.3;
    const pts = [];
    for (let s = -1; s <= 1; s += 2) for (let j = 0; j <= 6; j++) { const u = s < 0 ? j / 6 : 1 - j / 6, r = B + u * (L - B), w = Wd * Math.sin(Math.PI * (0.18 + u * 0.82)) ** 0.9 * (1 - u * 0.25); const off = s * w + curl * u * u * L * 0.25; pts.push([Math.cos(an) * r - Math.sin(an) * off, Math.sin(an) * r + Math.cos(an) * off]); }
    draw(ctx, boil(pts, 1.1 * k, seed), { fill: col, shade: [Math.cos(an) * L, Math.sin(an) * L, 0, 0], dark: 0.28, w: 3 * k, hatch: 0.3 });
    ctx.strokeStyle = 'rgba(120,50,25,0.3)'; ctx.lineWidth = 1.4 * k; ctx.beginPath(); ctx.moveTo(Math.cos(an) * B * 1.1, Math.sin(an) * B * 1.1); ctx.lineTo(Math.cos(an) * L * 0.8, Math.sin(an) * L * 0.8); ctx.stroke();
  };
  for (let i = 0; i < 12; i++) petal(i, 12, 238, 40, 80, '#c9683f', frame * 50 + i, true);
  for (let i = 0; i < 12; i++) petal(i, 12, 222, 44, 80, '#e3875a', frame * 50 + 20 + i, false);
  const R = 102 * k;
  draw(ctx, boil(ellipse(0, 0, R, R, 26), 1.2 * k, frame * 9 + 99), { fill: '#f7ecd8', shade: [R, -R, -R, R], dark: 0.18, w: 3.2 * k, hatch: 0.18 });
  // cheeks
  for (const side of [-1, 1]) { const g = ctx.createRadialGradient(side * 58 * k, 28 * k, 0, side * 58 * k, 28 * k, 30 * k); g.addColorStop(0, `rgba(235,120,110,${0.28 + E.blush * 0.35})`); g.addColorStop(1, 'rgba(235,120,110,0)'); ctx.fillStyle = g; ctx.fillRect(side * 58 * k - 30 * k, -2 * k, 60 * k, 60 * k); }
  // eyes: open and bright; closed and content while sipping; ^^ when laughing
  const gx = E.gazeX * 9 * k, gy = E.gazeY * 7 * k, ink = '#221812';
  ctx.strokeStyle = ink; ctx.fillStyle = ink; ctx.lineCap = 'round';
  for (const side of [-1, 1]) {
    const ex = side * 38 * k, ey = -14 * k, open = E.eyeOpen * (E.wink && side === 1 ? 0 : E.blink) * (1 - E.thinking * 0.95);
    ctx.lineWidth = 3.6 * k;
    if (E.laugh > 0.3 || E.squint > 0.6) { ctx.beginPath(); ctx.arc(ex, ey + 8 * k, 13 * k, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke(); }
    else if (open < 0.3) { ctx.beginPath(); ctx.arc(ex, ey - 8 * k, 14 * k, Math.PI * 0.2, Math.PI * 0.8); ctx.stroke(); for (const l of [-1, 0, 1]) { ctx.lineWidth = 1.6 * k; ctx.beginPath(); ctx.moveTo(ex + l * 9 * k, ey + 5 * k); ctx.lineTo(ex + l * 11 * k, ey + 9 * k); ctx.stroke(); } }
    else {
      const h = 15 * k * clamp(open, 0.3, 1.4) * (1 - E.squint * 0.4);
      ctx.beginPath(); ctx.ellipse(ex + gx, ey + gy, 10.5 * k, h, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#fffaf0'; ctx.beginPath(); ctx.arc(ex + gx + 3.5 * k, ey + gy - h * 0.4, 3.6 * k, 0, TAU); ctx.fill(); ctx.beginPath(); ctx.arc(ex + gx - 3 * k, ey + gy + h * 0.35, 1.6 * k, 0, TAU); ctx.fill(); ctx.fillStyle = ink;
      if (E.eyeOpen < 0.8) { ctx.fillStyle = '#f7ecd8'; ctx.fillRect(ex - 13 * k, ey - h - 2 * k, 26 * k, h * (1 - E.eyeOpen) * 1.6); ctx.fillStyle = ink; ctx.lineWidth = 2.4 * k; ctx.beginPath(); ctx.moveTo(ex - 12 * k, ey - h + h * (1 - E.eyeOpen) * 1.6); ctx.lineTo(ex + 12 * k, ey - h + h * (1 - E.eyeOpen) * 1.6); ctx.stroke(); }
    }
    // brows
    const lift = (side === -1 ? E.browL : E.browR) * 10 * k, inner = E.worry * 9 * k;
    ctx.lineWidth = 2.8 * k; ctx.beginPath(); ctx.moveTo(ex - side * 13 * k, ey - 30 * k - lift - inner); ctx.quadraticCurveTo(ex, ey - 36 * k - lift - inner * 0.4, ex + side * 14 * k, ey - 29 * k - lift + (E.worry ? 2 * k : 0)); ctx.stroke();
  }
  // mouth
  const open = E.mouthOpen, smile = E.smile, mw = (26 - E.mouthRound * 9 + E.laugh * 8) * k, my = 38 * k;
  ctx.lineWidth = 3.4 * k;
  if (open < 0.07) { ctx.beginPath(); ctx.moveTo(-mw, my - smile * 6 * k); ctx.quadraticCurveTo(0, my + smile * 16 * k, mw, my - smile * 6 * k); ctx.stroke(); }
  else {
    const h = (8 + 34 * open) * k, p = new Path2D();
    p.moveTo(-mw, my - smile * 5 * k); p.quadraticCurveTo(0, my + smile * 6 * k, mw, my - smile * 5 * k); p.quadraticCurveTo(0, my + h + smile * 8 * k, -mw, my - smile * 5 * k);
    ctx.fillStyle = '#3a1a14'; ctx.fill(p); ctx.stroke(p);
    if (open > 0.3) { ctx.save(); ctx.clip(p); ctx.fillStyle = '#d9707a'; ctx.beginPath(); ctx.ellipse(0, my + h * 0.85, mw * 0.55, h * 0.35, 0, 0, TAU); ctx.fill(); ctx.restore(); }
  }
  ctx.restore();
  afterHead?.();
  ctx.restore();
}
const mix = (a, b, t) => a + (b - a) * t;
