// Bloom: a flat cartoon character with clean vector geometry — flower head with a white face (^ ^ eyes, a
// little "w" mouth), lavender turtleneck, jeans, orange hands and a curly tail. Limbs are outlined tubes posed
// with two-bone IK, so hands and feet move to targets and elbows/knees follow naturally.
import { express } from './expression.js';

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const mix = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;
const C = { petal: '#dc7656', skin: '#dc7656', sweater: '#c9a6d8', sweaterDark: '#b48fc6', jeans: '#94c5d9', shoe: '#5b2e22', face: '#ffffff', ink: '#141414', blush: '#f4a3a8', tongue: '#e8727f' };
const LINE = 10;

let bg = null;
function background(w, h) {
  if (bg && bg.width === w && bg.height === h) return bg;
  bg = document.createElement('canvas'); bg.width = w; bg.height = h; const g = bg.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, '#f1e6b1'); grad.addColorStop(0.62, '#fbf8ee'); grad.addColorStop(1, '#ffffff');
  g.fillStyle = grad; g.fillRect(0, 0, w, h); return bg;
}
export { background as bloomWorld };

// two-bone IK: elbow/knee position for a limb from `s` reaching toward `t`
function ik(s, t, l1, l2, bend) {
  let dx = t[0] - s[0], dy = t[1] - s[1], d = Math.hypot(dx, dy);
  const max = l1 + l2 - 0.5; if (d > max) { dx *= max / d; dy *= max / d; d = max; }
  const a = Math.atan2(dy, dx), cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1), e = a + bend * Math.acos(cosA);
  return { elbow: [s[0] + Math.cos(e) * l1, s[1] + Math.sin(e) * l1], hand: [s[0] + dx, s[1] + dy] };
}
// an outlined tube along a polyline (sleeves, legs, tail): ink first, colour on top
function tube(ctx, pts, width, color, curve = false) {
  const path = new Path2D(); path.moveTo(...pts[0]);
  if (curve && pts.length === 3) path.quadraticCurveTo(...pts[1], ...pts[2]);
  else if (curve && pts.length === 4) path.bezierCurveTo(...pts[1], ...pts[2], ...pts[3]);
  else for (const p of pts.slice(1)) path.lineTo(...p);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = C.ink; ctx.lineWidth = width + LINE * 2; ctx.stroke(path);
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke(path);
}
function hand(ctx, [x, y], dir, open) {
  // a mitten with a thumb, pointing along `dir`
  ctx.save(); ctx.translate(x, y); ctx.rotate(dir);
  const body = new Path2D(); body.ellipse(14, 0, 30, 24, 0, 0, TAU);
  const thumb = new Path2D(); thumb.ellipse(4, -22 - open * 6, 10, 15, -0.5 - open * 0.4, 0, TAU);
  for (const p of [thumb, body]) { ctx.fillStyle = C.skin; ctx.strokeStyle = C.ink; ctx.lineWidth = LINE; ctx.fill(p); ctx.stroke(p); }
  ctx.fillStyle = C.skin; ctx.beginPath(); ctx.ellipse(8, -10, 10, 8, 0, 0, TAU); ctx.fill();   // blend the thumb joint
  ctx.restore();
}

export function bloomCharacter(ctx, st, box, a) {
  const E = express(a.mini ? 'bloom-mini' : 'bloom', a), t = a.t;
  if (!a.mini) ctx.drawImage(background(Math.round(box.w), Math.round(box.h)), box.x, box.y);
  // 1000-unit drawing space; the full figure spans y ≈ 30–940
  const k = a.mini ? Math.min(box.w, box.h) / 620 : Math.min(box.w / 1000, box.h / 1000) * 0.98;
  const ox = box.x + box.w / 2 - 500 * k, oy = a.mini ? box.y + box.h / 2 - 300 * k : box.y + box.h - 955 * k;
  ctx.save(); ctx.globalAlpha = a.alive; ctx.translate(ox, oy); ctx.scale(k, k);

  // ---- whole-body motion ----
  const hop = Math.max(0, E.bounce) * 90, shift = Math.sin(t * 0.9) * 6 * (1 - E.speaking * 0.5);
  const sway = E.turn * 16 - E.lean * 14 + shift, breath = E.breath * 3;
  const speakBob = E.speaking * Math.abs(Math.sin(t * 5.5)) * 6;
  const waving = clamp(E.energy * 1.4 - 0.2) * (1 - E.laugh);           // excitement: a wave
  const thinking = E.thinking;                                           // waiting: chin on hand
  const cheer = clamp(E.laugh * 1.2);                                    // laughing: arms up

  if (!a.mini) {
    ctx.save(); ctx.translate(0, -hop);
    const hipY = 690 - breath * 0.3, hipL = [470 + sway * 0.5, hipY], hipR = [545 + sway * 0.5, hipY];
    // tail, behind the body, swishing (faster when happy)
    const swish = Math.sin(t * (1.6 + E.energy * 3 + cheer * 4)) * (0.5 + E.energy + cheer);
    tube(ctx, [[hipL[0] + 10, hipY - 25], [hipL[0] - 70, hipY + 10 + swish * 10], [hipL[0] - 150 + swish * 25, hipY + 40], [hipL[0] - 170 + swish * 40, hipY + 120]], 24, C.skin, true);
    // legs: feet planted, a small step while energetic; knees bend a touch when crouching into a hop
    const stepL = E.energy > 0.3 || E.speaking > 0.5 ? Math.max(0, Math.sin(t * 7)) * 12 * (E.energy + E.speaking * 0.4) : 0;
    const stepR = E.energy > 0.3 || E.speaking > 0.5 ? Math.max(0, -Math.sin(t * 7)) * 12 * (E.energy + E.speaking * 0.4) : 0;
    const footL = [455, 905 + hop - stepL], footR = [655, 900 + hop - stepR];
    for (const [hip, foot, bend, toe] of [[hipL, footL, 1, -1], [hipR, footR, -1, 1]]) {
      const { elbow: knee, hand: ankle } = ik(hip, foot, 120, 118, bend * 0.2);
      tube(ctx, [hip, knee, ankle], 58, C.jeans);
      // shoe
      ctx.save(); ctx.translate(ankle[0], ankle[1] + 14); const shoe = new Path2D(); shoe.ellipse(toe * 16, 0, 46, 20, toe * 0.08, 0, TAU);
      ctx.fillStyle = C.shoe; ctx.strokeStyle = C.ink; ctx.lineWidth = LINE; ctx.fill(shoe); ctx.stroke(shoe); ctx.restore();
    }
    // torso: turtleneck sweater with a soft side shade
    const top = 485 - breath, P = new Path2D();
    P.moveTo(452 + sway, top); P.lineTo(548 + sway, top);
    P.bezierCurveTo(600 + sway, top + 8, 612 + sway * 0.7, top + 40, 610 + sway * 0.6, top + 90);
    P.lineTo(592 + sway * 0.5, hipY); P.lineTo(438 + sway * 0.5, hipY); P.lineTo(410 + sway * 0.6, top + 90);
    P.bezierCurveTo(408 + sway * 0.7, top + 40, 420 + sway, top + 8, 452 + sway, top); P.closePath();
    ctx.fillStyle = C.sweater; ctx.fill(P);
    ctx.save(); ctx.clip(P); ctx.fillStyle = C.sweaterDark; ctx.globalAlpha *= 0.45; ctx.fillRect(560 + sway * 0.6, top, 60, hipY - top); ctx.restore();
    ctx.strokeStyle = C.ink; ctx.lineWidth = LINE; ctx.lineJoin = 'round'; ctx.stroke(P);
    ctx.beginPath(); ctx.moveTo(446 + sway * 0.5, hipY - 26); ctx.lineTo(586 + sway * 0.5, hipY - 26); ctx.lineWidth = 6; ctx.stroke();   // hem
    ctx.restore();
  }

  // ---- arms (sleeves under the head; hands drawn last so they can come in front of the petals) ----
  const hands = [];
  if (!a.mini) {
    ctx.save(); ctx.translate(0, -hop);
    const shL = [440 + sway, 520 - breath], shR = [578 + sway, 520 - breath];
    const gL = clamp(E.armL - 0.15), gR = clamp(E.armR - 0.1);
    let tL = [335 + sway * 0.3, 640];                                                         // rest: hanging, pointing down
    tL = [mix(tL[0], 300 + 20 * Math.sin(t * 2.3), gL), mix(tL[1], 560 - 40 * Math.sin(t * 3.1), gL)];   // speaking gesture
    tL = [mix(tL[0], 330, cheer), mix(tL[1], 360, cheer)];                                    // laughing: arm up
    let tR = [652 + sway * 0.3, 640];
    tR = [mix(tR[0], 690 + 15 * Math.sin(t * 2.7 + 1), gR), mix(tR[1], 575 - 35 * Math.sin(t * 2.9 + 1), gR)];
    tR = [mix(tR[0], 545 + sway, thinking), mix(tR[1], 470, thinking)];                        // chin on hand
    tR = [mix(tR[0], 700 + Math.sin(t * 9) * 25, waving), mix(tR[1], 350, waving)];             // wave
    tR = [mix(tR[0], 670, cheer), mix(tR[1], 360, cheer)];
    for (const [sh, tg, bend] of [[shL, tL, -1], [shR, tR, thinking > 0.5 ? -1 : 1]]) {
      const { elbow, hand: hd } = ik(sh, tg, 100, 92, bend * 0.9);
      tube(ctx, [sh, elbow, hd], 44, C.sweater);
      hands.push({ at: hd, dir: Math.atan2(hd[1] - elbow[1], hd[0] - elbow[0]) });
    }
    ctx.restore();
  }

  // ---- the flower head ----
  const hx = 497 + sway * 1.2, hy = 300 + E.nod * 34 + speakBob - hop;
  ctx.save(); ctx.translate(hx, hy); ctx.rotate(E.tilt * 1.1 + Math.sin(t * 0.8) * 0.025 + (thinking * 0.08)); ctx.scale(1 - E.squash * 0.2, 1 + E.squash * 0.3);
  const LENS = [248, 226, 256, 232, 244, 224, 254, 228, 248, 234, 252, 230];
  for (let i = 0; i < 12; i++) {
    const base = i / 12 * TAU - Math.PI / 2 + 0.13;
    const an = base + 0.035 * Math.sin(t * 1.3 + i * 1.7) + E.speaking * 0.04 * Math.sin(t * 8 - i) + cheer * 0.07 * Math.sin(t * 14 + i) - E.listening * 0.05 * Math.cos(base);
    const L = LENS[i] * (1 + E.speaking * 0.05 * Math.sin(t * 6.5 - i * 0.8) + E.energy * 0.04 - (E.smile < 0 ? 0.04 : 0));
    const tw = 41, r0 = 60;
    ctx.save(); ctx.rotate(an);
    const p = new Path2D();                                              // a clean rounded petal, slightly narrower at the base
    p.moveTo(r0, -24); p.bezierCurveTo(r0 + 50, -28, L - tw - 40, -tw, L - tw, -tw);
    p.arc(L - tw, 0, tw, -Math.PI / 2, Math.PI / 2);
    p.bezierCurveTo(L - tw - 40, tw, r0 + 50, 28, r0, 24); p.closePath();
    ctx.fillStyle = C.petal; ctx.strokeStyle = C.ink; ctx.lineWidth = LINE; ctx.lineJoin = 'round'; ctx.fill(p); ctx.stroke(p);
    ctx.restore();
  }
  ctx.fillStyle = C.face; ctx.beginPath(); ctx.arc(0, 0, 100, 0, TAU); ctx.fill();
  if (E.blush > 0.08) for (const s of [-1, 1]) { ctx.save(); ctx.globalAlpha *= clamp(E.blush) * 0.85; ctx.fillStyle = C.blush; ctx.beginPath(); ctx.ellipse(s * 60, 24, 17, 10, 0, 0, TAU); ctx.fill(); ctx.restore(); }
  // eyes: the signature ∩ ∩ when content; round, blinking eyes when attentive
  const attentive = E.listening > 0.5 || E.surprise > 0.3 || E.question > 0.3 || E.worry > 0.3;
  const gx = E.gazeX * 8, gy = E.gazeY * 6;
  ctx.strokeStyle = C.ink; ctx.fillStyle = C.ink; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const s of [-1, 1]) {
    const ex = s * 42 + gx * 0.3, ey = -26;
    if (!attentive || cheer > 0.3 || thinking > 0.5) {
      const hgt = 30 + cheer * 6 - thinking * 8; ctx.lineWidth = 9;
      ctx.beginPath(); ctx.moveTo(ex - 13, ey + 14); ctx.bezierCurveTo(ex - 13, ey + 14 - hgt, ex + 13, ey + 14 - hgt, ex + 13, ey + 14); ctx.stroke();
    } else {
      const o = E.eyeOpen * (E.wink && s === 1 ? 0 : E.blink), h = 14 * clamp(o, 0.08, 1.4) * (1 + E.surprise * 0.3);
      if (o < 0.25) { ctx.lineWidth = 8; ctx.beginPath(); ctx.moveTo(ex - 11, ey + 3); ctx.lineTo(ex + 11, ey + 3); ctx.stroke(); }
      else { ctx.beginPath(); ctx.ellipse(ex + gx, ey + gy, 9, h, 0, 0, TAU); ctx.fill(); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(ex + gx + 3, ey + gy - h * 0.45, 3, 0, TAU); ctx.fill(); ctx.fillStyle = C.ink; }
      if (E.worry > 0.3) { ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(ex - s * 14, ey - 30 - E.worry * 6); ctx.lineTo(ex + s * 12, ey - 24); ctx.stroke(); }
    }
  }
  // mouth: the "w", opening with the audio being played
  const open = E.mouthOpen, my = 28; ctx.lineWidth = 9;
  if (E.smile < -0.2 && open < 0.1) { ctx.beginPath(); ctx.moveTo(-20, my + 12); ctx.quadraticCurveTo(0, my - 6, 20, my + 12); ctx.stroke(); }
  else if (open < 0.08) { ctx.beginPath(); ctx.moveTo(-30, my - 6); ctx.bezierCurveTo(-30, my + 18, -3, my + 18, 0, my + 3); ctx.bezierCurveTo(3, my + 18, 30, my + 18, 30, my - 6); ctx.stroke(); }
  else {
    const w = 30 - E.mouthRound * 8, h = 10 + open * 38, p = new Path2D();
    p.moveTo(-w, my - 6); p.bezierCurveTo(-w, my + 10, -3, my + 10, 0, my + 2); p.bezierCurveTo(3, my + 10, w, my + 10, w, my - 6);
    p.bezierCurveTo(w, my + h, -w, my + h, -w, my - 6); p.closePath();
    ctx.fill(p); ctx.save(); ctx.clip(p); ctx.fillStyle = C.tongue; ctx.beginPath(); ctx.ellipse(0, my + h * 0.82, w * 0.55, h * 0.36, 0, 0, TAU); ctx.fill(); ctx.restore();
    ctx.stroke(p);
  }
  ctx.restore();

  // hands last, so a hand can rest on the chin or wave in front of the petals
  ctx.save(); ctx.translate(0, -hop);
  hands.forEach((h, i) => hand(ctx, h.at, h.dir, i === 1 ? waving : cheer));
  ctx.restore();
  ctx.restore();
}
