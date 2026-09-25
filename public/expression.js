// The emotion engine shared by every character. It turns real application events into a small set of
// facial and body parameters, animated with damped springs so motion has weight, overshoot and settle.
//
// Inputs (all from real events): think, listen/listenState (the other person's live mic while the backend listens),
// speak (level of Claude's audio actually playing), mouth (phoneme shape from ElevenLabs timing of played
// audio), mood (a delivery cue, ?/!, or the feeling of words actually played or heard — see emotion.js),
// nod (their speech arriving), gap (interrupted), pointer (the cursor over the stage outside a call).
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

// Moods → expression targets. Keys are matched loosely against the mood text; the first match wins.
// Extra channels (used by characters that can show them; others ignore them):
//   smirk (−1..1 lopsided mouth), skeptic (one lid lowered), sparkle (starry eyes), gloss (watery eyes),
//   flare/droop/shy (petals or hair spread, sag or curl in), shock (surprise lines), shrug, shake (laughing body),
//   hand: a pose for a free hand — chin, open, cheek, cover, wave; cup: raise (a toast).
const MOODS = [
  [/giggl|poke|tickl/, 1.5, { smile: 1, squint: 1, blush: 0.8, laugh: 0.7, shy: 0.5, hand: 'cover' }],
  [/fed up|enough|stop it/, 2.2, { skeptic: 1, smirk: -0.6, smile: 0, brows: -0.2, browR: 0.8, tilt: -0.12, droop: 0.2 }],
  [/laughs softly|chuckl|snicker/, 1.8, { smile: 1, squint: 0.9, blush: 0.4, brows: 0.2, laugh: 0.55, shake: 0.5 }],
  [/laugh|giggl|haha|cackl/, 2.0, { smile: 1, squint: 1, blush: 0.6, brows: 0.25, laugh: 1, shake: 1, flare: 0.3 }],
  [/wave|hello|greet/, 2.2, { smile: 0.9, brows: 0.45, eyeOpen: 1.1, flare: 0.35, hand: 'wave' }],
  [/embarrass|oops|sheepish|caught|corrected/, 2.8, { blush: 1, shy: 1, smile: 0.35, worry: 0.35, gazeX: 0.45, gazeY: 0.35, hand: 'cheek', sweat: 0.9 }],
  [/amus|smirk|wry|dry/, 3.0, { smile: 0.55, smirk: 1, brows: 0.15, tilt: 0.08, squint: 0.35 }],
  [/sigh|tired|weary|exhal/, 2.6, { smile: -0.35, eyeOpen: 0.5, lean: 0.12, nod: 0.18, energy: -0.5, worry: 0.25, droop: 0.7 }],
  [/skeptic|doubt|unconvinc|push back|hmph/, 3.2, { skeptic: 1, smirk: -0.45, smile: 0.05, tilt: -0.1, browR: 0.9, browL: -0.35, hand: 'chin' }],
  [/uncertain|unsure|shrug/, 2.8, { worry: 0.35, smirk: 0.5, tilt: 0.14, shrug: 1, gazeY: -0.3, gazeX: 0.3, hand: 'open' }],
  [/curious|wonder|hmm|ponder|thought|intrigu/, 3.0, { tilt: 0.22, browR: 0.9, browL: 0.25, gazeX: 0.35, gazeY: -0.35, smile: 0.12, hand: 'chin' }],
  [/delight|love|adore|marvel|beautiful/, 3.0, { smile: 1, eyeOpen: 1.15, sparkle: 1, flare: 0.6, blush: 0.45, brows: 0.45 }],
  [/excit|cheer|enthus|thrill/, 2.6, { smile: 0.95, eyeOpen: 1.25, brows: 0.6, energy: 0.8, hop: 1, blush: 0.3, sparkle: 0.7, flare: 0.8, cup: 1 }],
  [/whisper|soft|quiet|hush/, 4.0, { lean: 0.35, whisper: 1, eyeOpen: 0.85, smile: 0.2, shy: 0.3 }],
  [/agree|nod|exactly/, 2.0, { smile: 0.7, nod: 0.22, beat: 1, brows: 0.3 }],
  [/confident|proud|bold/, 2.6, { smile: 0.45, brows: 0.2, lean: 0.12, flare: 0.3, hand: 'open' }],
  [/happy|warm|smil|fond|kind|glad|pleased/, 3.0, { smile: 0.85, squint: 0.35, blush: 0.4, flare: 0.2 }],
  [/sad|sorry|sympath|gentle|wistful|melanch/, 3.2, { worry: 0.9, smile: -0.35, eyeOpen: 0.8, nod: 0.1, tilt: -0.08, droop: 1, gloss: 1 }],
  [/surpris|gasp|wow|astonish|amazed|shock/, 1.8, { eyeOpen: 1.45, brows: 1, round: 1, surprise: 1, smile: 0, flare: 1, shock: 1 }],
  [/perk|attent/, 1.2, { eyeOpen: 1.15, brows: 0.45, flare: 0.5, smile: 0.5 }],
  [/serious|firm|stern|flat/, 3.0, { brows: -0.35, smile: 0, eyeOpen: 0.95 }],
  [/mischiev|playful|teas|wink|sly|sarcas/, 2.6, { smile: 0.7, wink: 1, tilt: 0.12, brows: 0.3, smirk: 0.6 }],
  [/nervous|awkward|hesitant/, 2.6, { worry: 0.5, smile: 0.1, gazeX: 0.4, sweat: 1, shy: 0.5 }],
  [/^question$/, 1.5, { tilt: 0.17, brows: 0.65, question: 1 }],
  [/^exclaim$/, 1.2, { eyeOpen: 1.2, brows: 0.5, hop: 0.5, energy: 0.4, flare: 0.3 }],
];
export function moodTargets(mood) {
  if (!mood) return { w: 0, m: {} };
  for (const [re, span, m] of MOODS) if (re.test(mood.name)) {
    const age = mood.age, w = clamp(age / 0.18) * clamp(1 - (age - span * 0.6) / (span * 0.4));
    return { w, m, span };
  }
  return { w: 0, m: {} };
}

// Little things a character does on its own between turns: sip, blow on the drink, glance out of the window, hum.
const ACTS = { sip: 4.2, blow: 2.6, window: 3.4, hum: 4.5 };

const engines = new Map();
export function express(key, a) {
  let E = engines.get(key);
  const t = a.t, dt = clamp(a.dt ?? 1 / 60, 0.001, 0.05);
  if (!E) {
    E = { s: {}, nextBlink: t + 2, blinkAt: -9, blinkDouble: false, nextLook: t + 1, look: [0, 0], lastSpeak: 0, lastNod: 0, wink: 0, pendingNod: 0,
      lastVoice: -99, lastActive: t, nextAct: t + 5, act: null, thinkSince: null, inner: null, gapSeen: false };
    for (const n of ['smile', 'eyeOpen', 'squint', 'browL', 'browR', 'worry', 'gazeX', 'gazeY', 'tilt', 'nod', 'turn', 'lean', 'bounce', 'squash', 'armL', 'armR', 'mouthOpen', 'mouthRound', 'blush', 'energy', 'surprise',
      'smirk', 'skeptic', 'sparkle', 'gloss', 'flare', 'droop', 'shy', 'shock', 'shrug', 'sip', 'cup', 'handW', 'content'])
      E.s[n] = new Spring(n === 'eyeOpen' ? 1 : n === 'smile' ? 0.35 : 0, 120, 15);
    E.s.mouthOpen.k = 900; E.s.mouthOpen.d = 42; E.s.mouthRound.k = 500; E.s.mouthRound.d = 36;
    E.s.gazeX.k = E.s.gazeY.k = 420; E.s.gazeX.d = E.s.gazeY.d = 34;
    E.s.bounce.k = 260; E.s.bounce.d = 11; E.s.squash.k = 320; E.s.squash.d = 13; E.s.nod.k = 190; E.s.nod.d = 12;
    E.s.flare.k = 160; E.s.flare.d = 10; E.s.sip.k = 40; E.s.sip.d = 12; E.s.cup.k = 70; E.s.cup.d = 13; E.s.handW.k = 60; E.s.handW.d = 13;
    engines.set(key, E);
  }
  const listening = a.listenState, thinking = a.think, speaking = clamp(a.speak * 4);
  const idle = clamp(1 - listening - thinking - speaking);

  // ---- attention: when the other person starts talking after a pause, the character perks up
  if (a.listen > 0.05) { if (t - E.lastVoice > 2.5 && listening > 0.5) { E.s.flare.kick(3); E.s.eyeOpen.kick(1.2); E.s.browL.kick(1.5); E.s.browR.kick(1.5); E.act = null; } E.lastVoice = t; }
  if (listening > 0.5 && a.listen > 0.05 || speaking > 0.2 || thinking > 0.5) E.lastActive = t;
  // ---- after being interrupted: a small start, then a sheepish look
  if (a.gap > 0.05 && !E.gapSeen) { E.gapSeen = true; E.inner = { name: 'sheepish', at: t + 0.45 }; }
  if (a.gap <= 0.001) E.gapSeen = false;
  // the most recent of the app's mood (cue, punctuation, words) and the engine's own
  const inner = E.inner && t >= E.inner.at ? { name: E.inner.name, age: t - E.inner.at } : null;
  const mood = a.mood && (!inner || a.mood.age < inner.age) ? a.mood : inner;
  const { w, m } = moodTargets(mood), M = n => (typeof m[n] === 'number' ? m[n] : 0) * w, has = n => m[n] !== undefined ? w : 0;

  // ---- thinking has phases: look up and consider (hand to chin), then sip while waiting
  if (thinking > 0.5) E.thinkSince ??= t; else E.thinkSince = null;
  const thinkFor = E.thinkSince === null ? 0 : t - E.thinkSince;
  const pondering = thinking * (thinkFor < 2.2 ? 1 : 0.25 + 0.25 * Math.sin(thinkFor * 0.9));
  const sipCycle = thinking > 0.5 && thinkFor >= 2.2 ? (Math.sin((thinkFor - 2.2) * 0.8 - 1.2) > -0.3 ? 1 : 0) : 0;

  // ---- idle life: between turns (or while the other person is quiet) the character does small things
  const calm = Math.max(idle, listening * (t - E.lastVoice > 3 ? 1 : 0)) * (w < 0.2 ? 1 : 0);
  if (E.act && t - E.act.at > ACTS[E.act.name]) E.act = null;
  if (!E.act && calm > 0.8 && t > E.nextAct) {
    const r = Math.random(), names = listening > 0.5 ? ['sip', 'window', 'blow'] : ['sip', 'window', 'hum', 'blow'];
    E.act = { name: names[Math.floor(r * names.length)], at: t }; E.nextAct = t + ACTS[E.act.name] + 5 + Math.random() * 9;
  }
  if (calm < 0.5) E.act = null;
  const act = E.act?.name, actP = E.act ? clamp((t - E.act.at) / ACTS[E.act.name]) : 0, actW = E.act ? Math.sin(actP * Math.PI) ** 0.5 : 0;

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
  let look = E.look;
  if (act === 'window') look = [0.85, -0.25];
  // outside a call, the eyes follow the cursor over the stage
  if (a.pointer) look = [clamp(a.pointer.x, -1, 1), clamp(a.pointer.y, -1, 1)];
  // ---- blinks: 2–6 s apart, 130 ms, sometimes doubled; slower and heavier while waiting
  if (t > E.nextBlink) { E.blinkAt = t; E.blinkDouble = Math.random() < 0.18; E.nextBlink = t + 2 + Math.random() * 4 * (thinking > 0.5 ? 0.7 : 1); }
  const bt = t - E.blinkAt, bl = d => { const p = (bt - d) / (thinking > 0.5 ? 0.2 : 0.13); return p > 0 && p < 1 ? Math.sin(p * Math.PI) : 0; };
  const blink = 1 - Math.max(bl(0), E.blinkDouble ? bl(0.22) : 0);

  // ---- backchannel: a small nod when the other person's words arrive, at most every 1.3 s
  if (a.nod && a.nod !== E.lastNodSeen) { E.lastNodSeen = a.nod; if (t - E.lastNod > 1.3 && listening > 0.5) { E.lastNod = t; E.s.nod.kick(2.4); E.s.smile.kick(0.8); } }
  // ---- emphasis while speaking: a rise in loudness nods the head and lifts the brows
  const rise = a.speak - E.lastSpeak; E.lastSpeak = a.speak;
  if (rise > 0.06 && speaking > 0.3 && Math.random() < 0.5) { E.s.nod.kick(1.6 + rise * 8); E.s.browL.kick(1.2); E.s.browR.kick(1.2); E.s.squash.kick(0.9); }
  // ---- interruption: a small start
  if (a.gap > 0.05) { E.s.surprise.kick(2); E.s.squash.kick(-1.2); E.s.flare.kick(1.5); }
  // ---- laughs and excitement bounce; hops come from the spring being kicked, so they land and settle
  if (M('laugh') > 0.3 && Math.floor(t * 7) !== E.lastLaughTick) { E.lastLaughTick = Math.floor(t * 7); E.s.bounce.kick(2.2 * M('laugh')); E.s.squash.kick(-1.1); }
  if (M('hop') > 0.5 && t - (E.lastHop || 0) > 0.55) { E.lastHop = t; E.s.bounce.kick(3.4); E.s.squash.kick(-1.6); }
  if (M('beat') > 0.4 && Math.floor(t * 2.5) !== E.lastBeat) { E.lastBeat = Math.floor(t * 2.5); E.s.nod.kick(2.2); }
  if (M('surprise') > 0.5 && !E.shockSeen) { E.shockSeen = true; E.s.flare.kick(4); } if (M('surprise') < 0.1) E.shockSeen = false;
  E.wink = M('wink') > 0.4 ? 1 : 0;

  const S = E.s, out = {};
  const hum = act === 'hum' ? actW : 0;
  out.smile = S.smile.to(0.35 * idle + 0.3 * listening + 0.15 * thinking + 0.4 * speaking + (has('smile') ? (M('smile') - 0.35 * w) : 0) + a.listen * listening * 0.1 + hum * 0.3, dt);
  out.eyeOpen = S.eyeOpen.to((1 + 0.08 * listening - 0.1 * thinking) * (1 - w) + (m.eyeOpen ?? 1) * w, dt);
  out.squint = S.squint.to(M('squint') + 0.12 * speaking, dt);
  out.browL = S.browL.to(0.12 * listening * (1 + a.listen * 3) + 0.3 * thinking + 0.25 * pondering + M('brows') + M('browL'), dt);
  out.browR = S.browR.to(0.12 * listening * (1 + a.listen * 3) + 0.1 * thinking + 0.55 * pondering + M('brows') + M('browR'), dt);
  out.worry = S.worry.to(M('worry'), dt);
  out.gazeX = S.gazeX.to(look[0] * (1 - w * 0.6) + M('gazeX'), dt);
  out.gazeY = S.gazeY.to(look[1] * (1 - w * 0.6) + M('gazeY'), dt);
  out.tilt = S.tilt.to(-0.05 * listening + 0.08 * thinking + 0.06 * pondering + 0.03 * Math.sin(t * 0.9) + hum * 0.08 * Math.sin(t * 2.2) + M('tilt'), dt);
  out.nod = S.nod.to(0.06 * listening * a.listen + M('nod') - 0.06 * thinking + (M('whisper') ? 0.05 : 0), dt);
  out.turn = S.turn.to(-0.25 * idle - 0.5 * listening + 0.3 * thinking - 0.28 * speaking + 0.1 * Math.sin(t * 0.37) * idle + (act === 'window' ? 0.5 * actW : 0) + (a.pointer ? a.pointer.x * 0.35 : 0), dt);
  out.lean = S.lean.to(0.14 * listening + 0.1 * a.listen * listening - 0.06 * thinking + M('lean'), dt);
  out.bounce = S.bounce.to(0, dt);
  out.squash = S.squash.to(0.05 * speaking * Math.sin(t * 14) + 0.02 * Math.sin(t * 1.7) + M('shake') * 0.04 * Math.sin(t * 22), dt);
  out.armL = S.armL.to(0.15 + speaking * (0.35 + 0.45 * Math.sin(t * 3.1 + Math.sin(t * 1.3) * 2)) + M('energy') * 0.8 + M('laugh') * 0.6 + M('surprise') * 0.7, dt);
  out.armR = S.armR.to(0.1 + speaking * (0.3 + 0.4 * Math.sin(t * 2.6 + 1.7 + Math.sin(t * 0.9) * 2)) + M('energy') * 0.8 + M('laugh') * 0.5 + thinking * 0.35, dt);
  const blowing = act === 'blow' ? clamp((actP - 0.35) / 0.1) * clamp((0.85 - actP) / 0.1) : 0;
  const open = clamp(a.mouth.open * (0.35 + a.speak * 1.3)) * (M('whisper') ? 0.5 : 1) + M('laugh') * 0.55 + M('surprise') * 0.45 + blowing * 0.25;
  out.mouthOpen = Math.max(0, S.mouthOpen.to(open, dt));
  out.mouthRound = S.mouthRound.to(Math.max(a.mouth.round * (a.speak > 0.02 ? 1 : 0), M('round'), blowing), dt);
  out.blush = S.blush.to(M('blush') + 0.1 * listening, dt);
  out.energy = S.energy.to(speaking * 0.5 + M('energy'), dt);
  out.surprise = S.surprise.to(M('surprise'), dt);
  // expressive extras
  out.smirk = S.smirk.to(M('smirk') + 0.25 * pondering, dt);
  out.skeptic = S.skeptic.to(M('skeptic'), dt);
  out.sparkle = S.sparkle.to(M('sparkle'), dt);
  out.gloss = S.gloss.to(M('gloss'), dt);
  out.flare = S.flare.to(M('flare') + 0.12 * listening * clamp(a.listen * 6), dt);
  out.droop = S.droop.to(M('droop'), dt);
  out.shy = S.shy.to(M('shy'), dt);
  out.shock = S.shock.to(M('shock'), dt);
  out.shrug = S.shrug.to(M('shrug'), dt);
  out.content = S.content.to(hum, dt);                                        // eyes closed, humming
  out.sip = clamp(S.sip.to(sipCycle + (act === 'sip' ? actW : 0) + (act === 'blow' ? 0.75 * actW : 0), dt));
  out.cup = S.cup.to(M('cup'), dt);                                            // raise the cup
  out.blowing = blowing;
  // free-hand pose: a mood's pose, else chin while pondering, else an open palm on stressed words while speaking
  const pose = typeof m.hand === 'string' && w > 0.15 ? m.hand : pondering > 0.4 ? 'chin' : speaking > 0.3 && E.s.energy.x > 0.25 ? 'open' : null;
  if (pose) E.pose = pose;
  out.hand = E.pose || 'rest'; out.handW = clamp(S.handW.to(pose ? 1 : 0, dt));
  out.blink = blink; out.wink = E.wink; out.laugh = M('laugh'); out.whisper = M('whisper'); out.sweat = M('sweat'); out.question = M('question'); out.shake = M('shake');
  out.breath = Math.sin(t * 1.6);
  out.listening = listening; out.thinking = thinking; out.speaking = speaking; out.act = act || null; out.actP = actP;
  return out;
}
