// Clawd in 8-bit: a pixel scene (night sky, parallax hills) with an expressive sprite — pupils and
// highlights, brows, blush, a set of mouth shapes, emote icons and landing dust — plus CRT glow and scanlines.
import { express } from './expression.js';

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const C = { body: '#d97757', hi: '#ec9a78', lo: '#b25a3e', dark: '#171320', white: '#fff6e8', pink: '#f28b9b', tongue: '#e8617a',
  sky: ['#0b0a1a', '#120f27', '#1a1534', '#241c42'], hillFar: '#2b2250', hillNear: '#1d1838', ground: '#17132a', grass: '#2f2a58', star: '#f3e6c0', moon: '#f6e7b8', heart: '#ff5d7a', spark: '#ffd66b', sweat: '#8fd3ff' };
const ICONS = {
  heart: ['.XX.XX.', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...'],
  spark: ['...X...', '...X...', '.X.X.X.', 'XXXXXXX', '.X.X.X.', '...X...', '...X...'],
  question: ['.XXX.', 'X...X', '....X', '..XX.', '..X..', '.....', '..X..'],
  bang: ['X', 'X', 'X', 'X', '.', 'X'],
  sweat: ['.X.', 'XXX', 'XXX', '.X.'],
  note: ['..XX', '..X.', '..X.', 'XXX.', 'XX..'],
};
const state = new Map();

export function pixelClawd(ctx, st, box, a) {
  const E = express(a.mini ? 'pixel-mini' : 'pixel', a), t = a.t, key = a.mini ? 'mini' : 'full';
  const scale = a.mini ? Math.max(3, Math.floor(box.w / 34)) : Math.max(6, Math.floor(box.w / 64));
  const W = Math.ceil(box.w / scale), H = Math.ceil(box.h / scale);
  let S = state.get(key);
  if (!S || S.W !== W || S.H !== H) { const c = document.createElement('canvas'); c.width = W; c.height = H; S = { c, g: c.getContext('2d'), W, H, puffs: [], wasAir: false, emote: null }; state.set(key, S); }
  const g = S.g; g.clearRect(0, 0, W, H);
  const px = (x, y, col, w = 1, h = 1) => { g.fillStyle = col; g.fillRect(Math.round(x), Math.round(y), w, h); };
  const groundY = a.mini ? H - 3 : H - 12;

  // ---- the world (full view only) ----
  if (!a.mini) {
    const bands = C.sky.length;
    for (let y = 0; y < groundY; y++) {                      // dithered night-sky gradient
      const f = y / groundY * (bands - 1), i = Math.floor(f), frac = f - i;
      for (let x = 0; x < W; x++) px(x, y, ((x + y) % 2 === 0 && frac > 0.5) || ((x % 2 === 0 && y % 2 === 0) && frac > 0.25) ? C.sky[Math.min(bands - 1, i + 1)] : C.sky[i]);
    }
    for (let i = 0; i < 40; i++) { const r = Math.sin(i * 91.7) * 43758.5; const sx = Math.floor((r - Math.floor(r)) * W), sy = Math.floor(((r * 7.1) % 1 + 1) % 1 * groundY * 0.7); if (Math.sin(t * (1 + i % 3) + i) > -0.3) px(sx, sy, C.star); }
    const mx = W - 14, my = 9; for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) if (x * x + y * y <= 17 && !((x + 2) ** 2 + (y - 1) ** 2 <= 5)) px(mx + x, my + y, C.moon);
    const hill = (col, amp, freq, speed, base) => { for (let x = 0; x < W; x++) { const h = Math.round(base + Math.sin((x + t * speed) * freq) * amp + Math.sin((x + t * speed) * freq * 2.7) * amp * 0.4); px(x, groundY - h, col, 1, h); } };
    hill(C.hillFar, 3, 0.09, 1.5, 9); hill(C.hillNear, 2, 0.15, 4, 4);
    px(0, groundY, C.ground, W, H - groundY);
    for (let x = 0; x < W; x += 3) if (Math.sin(x * 7.3) > 0.2) px(x, groundY, C.grass, 1, 1);
  }

  // ---- the sprite ----
  const bw = 22, bodyH = 12 + clamp(Math.round(E.squash * 10), -2, 2);
  const cx = Math.round(W / 2 + E.turn * 5 + E.lean * -3), air = Math.max(0, Math.round(E.bounce * 9));
  const bx = cx - bw / 2, legH = 4, by = groundY - legH - bodyH - air + (E.breath > 0.6 ? -1 : 0);
  // landing dust
  if (S.wasAir && air === 0) for (let i = 0; i < 6; i++) S.puffs.push({ x: cx + (i < 3 ? -12 : 12), y: groundY - 1, vx: (i < 3 ? -1 : 1) * (0.5 + Math.random()), born: t });
  S.wasAir = air > 1;
  S.puffs = S.puffs.filter(p => t - p.born < 0.5);
  for (const p of S.puffs) { const age = t - p.born; px(p.x + p.vx * age * 16, p.y - age * 6, `rgba(200,190,220,${1 - age * 2})`, 2, 1); }
  // shadow
  px(cx - 10 + air, groundY, 'rgba(0,0,0,0.35)', 20 - air * 2, 1);
  // legs (walk while energetic or speaking)
  const walking = E.speaking > 0.3 || E.energy > 0.4;
  [3, 7, 13, 17].forEach((lx, i) => { const lift = walking && ((Math.floor(t * 8) + i) % 2) ? 1 : 0; px(bx + lx, by + bodyH, C.body, 2, legH - lift + (air ? 0 : 0)); px(bx + lx, by + bodyH + legH - lift - 1, C.lo, 2, 1); });
  // arms
  const armY = (v) => Math.round(clamp(v, -0.3, 1.4) * 4);
  px(bx - 3, by + 4 - armY(E.armL), C.body, 3, 4); px(bx - 3, by + 7 - armY(E.armL), C.lo, 3, 1);
  px(bx + bw, by + 4 - armY(E.armR), C.body, 3, 4); px(bx + bw, by + 7 - armY(E.armR), C.lo, 3, 1);
  // body with a top highlight and bottom shade
  px(bx, by, C.body, bw, bodyH); px(bx, by, C.hi, bw, 1); px(bx, by + bodyH - 1, C.lo, bw, 1);
  // ---- face ----
  const gx = Math.round(E.gazeX * 1.4), gy = Math.round(E.gazeY * 1.2), ey = by + 3;
  [[bx + 5, -1], [bx + 14, 1]].forEach(([ex, side]) => {
    const open = E.eyeOpen * (E.wink && side === 1 ? 0 : E.blink);
    if (E.laugh > 0.3 || E.squint > 0.6) { px(ex, ey + 2, C.dark); px(ex + 1, ey + 1, C.dark); px(ex + 2, ey + 2, C.dark); }
    else if (open < 0.3) px(ex, ey + 2, C.dark, 3, 1);
    else if (open < 0.7 || E.squint > 0.3) { px(ex, ey + 1, C.dark, 3, 2); }
    else if (E.surprise > 0.4 || open > 1.25) { px(ex - 1, ey - 1, C.dark, 4, 5); px(ex - 1 + gx + 1, ey + gy, C.white, 1, 1); }
    else { px(ex, ey, C.dark, 3, 4); px(ex + clamp(gx + 1, 0, 2), ey + clamp(gy + 1, 0, 1), C.white); }
    // brows when feeling something
    const lift = side === -1 ? E.browL : E.browR;
    if (Math.abs(lift) > 0.25 || E.worry > 0.25) {
      const byy = ey - 2 - (lift > 0.5 ? 1 : 0), inner = side === -1 ? ex + 2 : ex;
      px(ex, byy, C.dark, 3, 1);
      if (E.worry > 0.25) px(inner, byy - 1, C.dark); else if (lift < -0.2) px(inner, byy + 1, C.dark);
    }
  });
  if (E.blush > 0.25) { px(bx + 2, by + 7, C.pink, 2, 1); px(bx + bw - 4, by + 7, C.pink, 2, 1); }
  // mouth
  const mx = bx + 11, my = by + 8, open = E.mouthOpen;
  if (open > 0.55 && E.mouthRound > 0.5) { px(mx - 1, my - 1, C.dark, 3, 3); px(mx, my, C.tongue); }
  else if (open > 0.55 || E.laugh > 0.3) { px(mx - 2, my - 1, C.dark, 5, 3); px(mx - 1, my + 1, C.tongue, 3, 1); }
  else if (open > 0.2) px(mx - 1, my - 1 + (open < 0.35 ? 1 : 0), C.dark, 3, open < 0.35 ? 1 : 2);
  else if (E.smile > 0.25) { px(mx - 1, my, C.dark, 3, 1); px(mx - 2, my - 1, C.dark); px(mx + 2, my - 1, C.dark); }
  else if (E.smile < -0.15) { px(mx - 1, my - 1, C.dark, 3, 1); px(mx - 2, my, C.dark); px(mx + 2, my, C.dark); }
  else px(mx - 1, my, C.dark, 3, 1);
  // sweat
  if (E.sweat > 0.2) drawIcon(g, ICONS.sweat, bx + bw - 2, by - 1, C.sweat);
  // ---- emotes above the head ----
  const want = E.laugh > 0.3 || (a.mood?.name.match(/happy|warm|fond|kind/) && a.mood.age < 2.5) ? 'heart' : E.energy > 0.55 ? 'spark' : E.question > 0.3 || (E.browR > 0.6 && E.thinking < 0.5) ? 'question' : E.surprise > 0.4 ? 'bang' : E.thinking > 0.5 ? 'dots' : E.whisper > 0.3 ? 'note' : null;
  if (want !== S.emote?.kind) S.emote = want ? { kind: want, born: t } : null;
  if (S.emote && !a.mini) {
    const age = t - S.emote.born, rise = Math.min(3, Math.floor(age * 10)), ix = cx + 8, iy = by - 9 - rise;
    if (S.emote.kind === 'dots') for (let i = 0; i < 3; i++) { if (Math.floor(t * 3) % 4 > i) px(cx - 4 + i * 3, by - 5, C.white, 2, 2); }
    else drawIcon(g, ICONS[S.emote.kind], ix, iy, { heart: C.heart, spark: C.spark, question: C.white, bang: C.spark, note: C.star }[S.emote.kind]);
  }

  // ---- present: sharp pixels, phosphor glow, scanlines, vignette ----
  const dw = W * scale, dh = H * scale, dx = box.x + (box.w - dw) / 2, dy = box.y + (box.h - dh) / 2;
  ctx.save(); ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
  ctx.imageSmoothingEnabled = false; ctx.globalAlpha = a.alive; ctx.drawImage(S.c, dx, dy, dw, dh);
  ctx.globalCompositeOperation = 'lighter'; ctx.imageSmoothingEnabled = true; ctx.filter = `blur(${scale * 0.9}px)`; ctx.globalAlpha = a.alive * 0.32; ctx.drawImage(S.c, dx, dy, dw, dh);
  ctx.filter = 'none'; ctx.globalCompositeOperation = 'source-over';
  if (!a.mini) {
    ctx.globalAlpha = 1; ctx.fillStyle = 'rgba(0,0,0,0.22)'; for (let y = dy; y < dy + dh; y += scale / 2) ctx.fillRect(dx, Math.round(y), dw, 1);
    const v = ctx.createRadialGradient(box.x + box.w / 2, box.y + box.h / 2, box.w * 0.35, box.x + box.w / 2, box.y + box.h / 2, box.w * 0.75);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.45)'); ctx.fillStyle = v; ctx.fillRect(box.x, box.y, box.w, box.h);
  }
  ctx.restore();
}
function drawIcon(g, rows, x, y, col) { g.fillStyle = col; rows.forEach((r, j) => [...r].forEach((ch, i) => { if (ch === 'X') g.fillRect(Math.round(x + i), Math.round(y + j), 1, 1); })); }
