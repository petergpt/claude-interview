// The emotion engine shared by every character. It turns real application events into a small set of
// facial and body parameters, animated with damped springs so motion has weight, overshoot and settle.
//
// Inputs (all from real events): think, listen/listenState (the user's live mic while the backend listens),
// speak (level of Claude's audio actually playing), mouth (phoneme shape from ElevenLabs timing of played
// audio), mood (a delivery cue or ?/! that was actually played), nod (the user's speech arriving), gap (interrupted).
// Nothing here represents private reasoning; "thinking" means waiting for a reply.

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

class Spring {
  constructor(x = 0, k = 120, d = 16) { this.x = x; this.v = 0; this.k = k; this.d = d; }
  to(target, dt, k = this.k, d = this.d) {
    const steps = Math.max(1, Math.ceil(dt / 0.008)), h = dt / steps;
    for (let i = 0; i < steps; i++) { this.v += ((target - this.x) * k - this.v * d) * h; this.x += this.v * h; }
    return this.x;
  }
  kick(v) { this.v += v; }
}

// Delivery cues and punctuation → expression targets. Keys are matched loosely against the cue text.
const MOODS = [
  [/laugh|chuckl|giggl|haha/, 2.0, { smile: 1, squint: 1, blush: 0.6, brows: 0.25, laugh: 1 }],
  [/sigh|tired|weary|exhal/, 2.6, { smile: -0.35, eyeOpen: 0.5, lean: 0.12, nod: 0.18, energy: -0.5, worry: 0.25 }],
  [/curious|wonder|hmm|ponder|thought|intrigu/, 3.0, { tilt: 0.22, browR: 0.9, browL: 0.25, gazeX: 0.35, gazeY: -0.35, smile: 0.12 }],
  [/excit|cheer|delight|enthus|thrill/, 2.6, { smile: 0.95, eyeOpen: 1.25, brows: 0.6, energy: 0.8, hop: 1, blush: 0.3 }],
  [/whisper|soft|quiet|hush/, 4.0, { lean: 0.35, whisper: 1, eyeOpen: 0.85, smile: 0.2 }],
  [/happy|warm|smil|fond|kind|glad|pleased/, 3.0, { smile: 0.85, squint: 0.35, blush: 0.4 }],
  [/sad|sorry|sympath|gentle|wistful|melanch/, 3.2, { worry: 0.9, smile: -0.35, eyeOpen: 0.75, nod: 0.1, tilt: -0.08 }],
  [/surpris|gasp|wow|astonish|amazed|shock/, 1.8, { eyeOpen: 1.45, brows: 1, round: 1, surprise: 1, smile: 0 }],
  [/serious|firm|stern|flat/, 3.0, { brows: -0.35, smile: 0, eyeOpen: 0.95 }],
  [/mischiev|playful|teas|wink|sly|sarcas/, 2.6, { smile: 0.7, wink: 1, tilt: 0.12, brows: 0.3 }],
  [/nervous|awkward|hesitant|uncertain/, 2.6, { worry: 0.5, smile: 0.1, gazeX: 0.4, sweat: 1 }],
  [/^question$/, 1.5, { tilt: 0.17, brows: 0.65, question: 1 }],
  [/^exclaim$/, 1.2, { eyeOpen: 1.2, brows: 0.5, hop: 0.5, energy: 0.4 }],
];
export function moodTargets(mood) {
  if (!mood) return { w: 0, m: {} };
  for (const [re, span, m] of MOODS) if (re.test(mood.name)) {
    const age = mood.age, w = clamp(age / 0.18) * clamp(1 - (age - span * 0.6) / (span * 0.4));
    return { w, m, span };
  }
  return { w: 0, m: {} };
}

const engines = new Map();
export function express(key, a) {
  let E = engines.get(key);
  const t = a.t, dt = clamp(a.dt ?? 1 / 60, 0.001, 0.05);
  if (!E) {
    E = { s: {}, nextBlink: t + 2, blinkAt: -9, blinkDouble: false, nextLook: t + 1, look: [0, 0], lastSpeak: 0, lastNod: 0, wink: 0, pendingNod: 0 };
    for (const n of ['smile', 'eyeOpen', 'squint', 'browL', 'browR', 'worry', 'gazeX', 'gazeY', 'tilt', 'nod', 'turn', 'lean', 'bounce', 'squash', 'armL', 'armR', 'mouthOpen', 'mouthRound', 'blush', 'energy', 'surprise'])
      E.s[n] = new Spring(n === 'eyeOpen' ? 1 : n === 'smile' ? 0.35 : 0, 120, 15);
    E.s.mouthOpen.k = 900; E.s.mouthOpen.d = 42; E.s.mouthRound.k = 500; E.s.mouthRound.d = 36;
    E.s.gazeX.k = E.s.gazeY.k = 420; E.s.gazeX.d = E.s.gazeY.d = 34;
    E.s.bounce.k = 260; E.s.bounce.d = 11; E.s.squash.k = 320; E.s.squash.d = 13; E.s.nod.k = 190; E.s.nod.d = 12;
    engines.set(key, E);
  }
  const { w, m } = moodTargets(a.mood), M = n => (m[n] ?? 0) * w, has = n => m[n] !== undefined ? w : 0;
  const listening = a.listenState, thinking = a.think, speaking = clamp(a.speak * 4);
  const idle = clamp(1 - listening - thinking - speaking);

  // ---- saccades: small gaze jumps, biased toward the user (screen left) while they talk, away while waiting
  if (t > E.nextLook) {
    const r = Math.random;
    E.look = listening > 0.5 ? [-0.55 + (r() - 0.5) * 0.25, (r() - 0.5) * 0.2]
      : thinking > 0.5 ? [0.35 + r() * 0.35, -0.45 - r() * 0.25]
      : speaking > 0.3 ? (r() < 0.7 ? [-0.35 + (r() - 0.5) * 0.2, (r() - 0.5) * 0.15] : [(r() - 0.5) * 0.9, (r() - 0.5) * 0.4])
      : [(r() - 0.5) * 0.7, (r() - 0.5) * 0.3];
    E.nextLook = t + (thinking > 0.5 ? 1.2 : 0.6) + r() * 2.2;
    if (r() < 0.25) E.nextBlink = Math.min(E.nextBlink, t + 0.05);          // blinks often accompany gaze shifts
  }
  // ---- blinks: 2–6 s apart, 130 ms, sometimes doubled; slower and heavier while waiting
  if (t > E.nextBlink) { E.blinkAt = t; E.blinkDouble = Math.random() < 0.18; E.nextBlink = t + 2 + Math.random() * 4 * (thinking > 0.5 ? 0.7 : 1); }
  const bt = t - E.blinkAt, bl = d => { const p = (bt - d) / (thinking > 0.5 ? 0.2 : 0.13); return p > 0 && p < 1 ? Math.sin(p * Math.PI) : 0; };
  const blink = 1 - Math.max(bl(0), E.blinkDouble ? bl(0.22) : 0);

  // ---- backchannel: a small nod when the user's words arrive, at most every 1.3 s
  if (a.nod && a.nod !== E.lastNodSeen) { E.lastNodSeen = a.nod; if (t - E.lastNod > 1.3 && listening > 0.5) { E.lastNod = t; E.s.nod.kick(2.4); E.s.smile.kick(0.8); } }
  // ---- emphasis while speaking: a rise in loudness nods the head and lifts the brows
  const rise = a.speak - E.lastSpeak; E.lastSpeak = a.speak;
  if (rise > 0.06 && speaking > 0.3 && Math.random() < 0.5) { E.s.nod.kick(1.6 + rise * 8); E.s.browL.kick(1.2); E.s.browR.kick(1.2); E.s.squash.kick(0.9); }
  // ---- interruption: a small start
  if (a.gap > 0.05) { E.s.surprise.kick(2); E.s.squash.kick(-1.2); }
  // ---- laughs and excitement bounce; hops come from the spring being kicked, so they land and settle
  if (M('laugh') > 0.3 && Math.floor(t * 7) !== E.lastLaughTick) { E.lastLaughTick = Math.floor(t * 7); E.s.bounce.kick(2.2 * M('laugh')); E.s.squash.kick(-1.1); }
  if (M('hop') > 0.5 && t - (E.lastHop || 0) > 0.55) { E.lastHop = t; E.s.bounce.kick(3.4); E.s.squash.kick(-1.6); }
  E.wink = M('wink') > 0.4 ? 1 : 0;

  const S = E.s, out = {};
  out.smile = S.smile.to(0.35 * idle + 0.3 * listening + 0.15 * thinking + 0.4 * speaking + (has('smile') ? (M('smile') - 0.35 * w) : 0) + a.listen * listening * 0.1, dt);
  out.eyeOpen = S.eyeOpen.to((1 + 0.08 * listening - 0.1 * thinking) * (1 - w) + (m.eyeOpen ?? 1) * w, dt);
  out.squint = S.squint.to(M('squint') + 0.12 * speaking, dt);
  out.browL = S.browL.to(0.12 * listening * (1 + a.listen * 3) + 0.3 * thinking + M('brows') + M('browL'), dt);
  out.browR = S.browR.to(0.12 * listening * (1 + a.listen * 3) + 0.1 * thinking + M('brows') + M('browR'), dt);
  out.worry = S.worry.to(M('worry'), dt);
  out.gazeX = S.gazeX.to(E.look[0] * (1 - w * 0.6) + M('gazeX'), dt);
  out.gazeY = S.gazeY.to(E.look[1] * (1 - w * 0.6) + M('gazeY'), dt);
  out.tilt = S.tilt.to(-0.05 * listening + 0.08 * thinking + 0.03 * Math.sin(t * 0.9) + M('tilt'), dt);
  out.nod = S.nod.to(0.06 * listening * a.listen + M('nod') - 0.06 * thinking + (M('whisper') ? 0.05 : 0), dt);
  out.turn = S.turn.to(-0.25 * idle - 0.5 * listening + 0.3 * thinking - 0.28 * speaking + 0.1 * Math.sin(t * 0.37) * idle, dt);
  out.lean = S.lean.to(0.14 * listening + 0.1 * a.listen * listening - 0.06 * thinking + M('lean'), dt);
  out.bounce = S.bounce.to(0, dt);
  out.squash = S.squash.to(0.05 * speaking * Math.sin(t * 14) + 0.02 * Math.sin(t * 1.7), dt);
  out.armL = S.armL.to(0.15 + speaking * (0.35 + 0.45 * Math.sin(t * 3.1 + Math.sin(t * 1.3) * 2)) + M('energy') * 0.8 + M('laugh') * 0.6 + M('surprise') * 0.7, dt);
  out.armR = S.armR.to(0.1 + speaking * (0.3 + 0.4 * Math.sin(t * 2.6 + 1.7 + Math.sin(t * 0.9) * 2)) + M('energy') * 0.8 + M('laugh') * 0.5 + thinking * 0.35, dt);
  const open = clamp(a.mouth.open * (0.35 + a.speak * 1.3)) * (M('whisper') ? 0.5 : 1) + M('laugh') * 0.55 + M('surprise') * 0.45;
  out.mouthOpen = Math.max(0, S.mouthOpen.to(open, dt));
  out.mouthRound = S.mouthRound.to(Math.max(a.mouth.round * (a.speak > 0.02 ? 1 : 0), M('round')), dt);
  out.blush = S.blush.to(M('blush') + 0.1 * listening, dt);
  out.energy = S.energy.to(speaking * 0.5 + M('energy'), dt);
  out.surprise = S.surprise.to(M('surprise'), dt);
  out.blink = blink; out.wink = E.wink; out.laugh = M('laugh'); out.whisper = M('whisper'); out.sweat = M('sweat'); out.question = M('question');
  out.breath = Math.sin(t * 1.6);
  out.listening = listening; out.thinking = thinking; out.speaking = speaking;
  return out;
}
