import http from 'node:http';
import { createBroadcast } from './broadcast.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { authStatus, runClaude, EFFORTS } from './claude.mjs';
import { SceneStream, normalizeBackdrop, freshBase, checkSceneCode, sceneFrameHTML, SCENE_FRAME_CSP, VISUAL_MODES, SCENE_STYLES, SCENE_SIZE, BACKDROP_SIZE } from './director.mjs';
import { voiceCatalogue, elevenRequest, DialogueVoice, RealtimeScribe } from './eleven.mjs';
import { readKey, saveKey } from './credentials.mjs';
import { DEFAULT_PORT, UUID, SAMPLE_RATE, SpeechChunks, cleanSpeech, wavHeader, historyForClaude, allowRequest } from './core.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.tflite': 'application/octet-stream', '.css': 'text/css', '.json': 'application/json', '.md': 'text/plain; charset=utf-8', '.wav': 'audio/wav', '.webm': 'video/webm', '.mp4': 'video/mp4', '.jsonl': 'application/x-ndjson' };
const voiceSchema = { type: 'object', additionalProperties: false, required: ['voice_id', 'rationale', 'opening'], properties: { voice_id: { type: 'string' }, rationale: { type: 'string' }, opening: { type: 'string' } } };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
// A display name for the person: one short line, no control characters or brackets (it is quoted into Claude's prompt).
const cleanName = name => String(name || '').replace(/[\u0000-\u001f\u007f<>\[\]{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
// Added to Claude's system prompt per reply, so it always knows whether it can see the other person on this turn.
// How much of the camera Claude sees per reply. few = the start, middle and end of the person's turn; more and live cover
// everything since Claude's previous reply began (so reactions while Claude was talking are included), sampled or every second.
export const VISION_LEVELS = { off: 0, still: 1, few: 3, more: 8, live: 40 };
const visionScope = {
  still: 'each of their turns comes with one still from their camera, taken as they stopped talking',
  few: 'each of their turns comes with up to three stills taken while they spoke (oldest first; the last is from when they stopped talking)',
  more: 'each of their turns comes with a handful of stills spread across everything since your last reply began, including how they reacted while you were talking (oldest first, each labelled with its timing; the last is from when they stopped talking)',
  live: 'each of their turns comes with a still for about every second since your last reply began, including how they reacted while you were talking — close to watching live (oldest first, each labelled with its timing; the last is from when they stopped talking)',
};
// Added to Claude's system prompt per reply, so it always knows whether and how much it can see on this turn.
const visionNote = level => `\n\nYou can see the person you're talking with through their camera: ${visionScope[level]}. You see nothing else between turns, and earlier stills aren't shown again. React to what you see the way someone on a video call would — something they hold up or point at, their expression, a gesture, what's around them — when it matters to the conversation. Don't describe the stills, don't comment on their appearance unprompted, and if something is unclear, say so rather than guess.\n`;
const VISION_OFF = `\n\nYou can't see the person you're talking with on this turn (their camera isn't being shared with you).\n`;
// Prepend a WAV header to a finished raw PCM file (streamed, so long recordings never sit in memory).
function pcmToWav(pcmPath, rate) {
  const file = pcmPath.replace(/\.pcm$/, '.wav'), bytes = fs.statSync(pcmPath).size - (fs.statSync(pcmPath).size % 2);
  const out = fs.openSync(file, 'wx', 0o600), inp = fs.openSync(pcmPath, 'r'), buf = Buffer.alloc(1 << 20);
  try {
    fs.writeSync(out, wavHeader(bytes, rate));
    let pos = 0; while (pos < bytes) { const n = fs.readSync(inp, buf, 0, Math.min(buf.length, bytes - pos), pos); if (!n) break; fs.writeSync(out, buf, 0, n); pos += n; }
  } finally { fs.closeSync(inp); fs.closeSync(out); }
  fs.unlinkSync(pcmPath);
  return { file, bytes: bytes + 44 };
}
async function body(req, limit = 1_000_000) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw fail('Request too large.', 413); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function json(req) { try { return JSON.parse((await body(req)).toString()); } catch (e) { if (e.status) throw e; throw fail('Invalid JSON.'); } }

export function createStudio({ root = ROOT, auth = authStatus, claude = runClaude, Voice = DialogueVoice, Scribe = RealtimeScribe, getVoices = voiceCatalogue, requestEleven = elevenRequest, initialKey = process.env.ELEVENLABS_API_KEY || '', storeKey = saveKey, loadKey = readKey, loadStreamKey } = {}) {
  const broadcast = createBroadcast(root, loadStreamKey ? { loadStreamKey } : {});
  let key = initialKey;
  let voices = [], activeId = null;
  const sessions = new Map(), access = randomBytes(32).toString('hex');
  // Prompts are read on every reply so edits to prompts/conversation.md (from the page or an editor) apply from the next reply.
  const promptFile = name => path.join(root, 'prompts', `${name}.md`);
  const readPrompt = name => fs.readFileSync(promptFile(name), 'utf8');
  // prompts/conversation.md is the local, editable copy (not tracked in git); a fresh checkout starts from the default.
  if (!fs.existsSync(promptFile('conversation'))) fs.copyFileSync(promptFile('conversation.default'), promptFile('conversation'));
  // The person's name is optional and never written into the prompt files; it is added per call when set.
  const withName = (text, s) => s.settings.user_name ? `${text.trimEnd()}\n\nThe person you're talking with is called ${s.settings.user_name}.\n` : text;
  readPrompt('conversation'); readPrompt('voice-choice'); readPrompt('scene'); readPrompt('backdrop');
  const recordings = path.join(root, 'recordings');
  fs.mkdirSync(recordings, { recursive: true, mode: 0o700 });
  const publicSession = s => ({ id: s.id, created_at: s.createdAt, ended_at: s.endedAt || null, settings: s.settings,
    voice: s.voice, actual_model: s.actualModel, turns: s.turns, scenes: s.scenes, backdrops: s.backdrops, media: s.media, recording_directory: s.dir, status: s.status });
  const snapshot = s => { const tmp = path.join(s.dir, 'session.json.tmp'); fs.writeFileSync(tmp, JSON.stringify(publicSession(s), null, 2)); fs.renameSync(tmp, path.join(s.dir, 'session.json')); };
  function event(s, type, data = {}, send = true) {
    const item = { seq: ++s.seq, type, at_ms: Date.now() - s.epoch, ...data };
    fs.appendFileSync(path.join(s.dir, 'events.jsonl'), JSON.stringify(item) + '\n');
    if (send) for (const res of s.clients) res.write(`data: ${JSON.stringify(item)}\n\n`);
    return item;
  }
  function sendAudio(s, op, bytes) {
    if (op.controller.signal.aborted) return;
    if (bytes.length % 2) throw new Error('ElevenLabs returned an incomplete PCM sample.');
    if (op.fd === undefined) {
      op.turn.audio_file = `claude-${op.id}.wav`;
      op.fd = fs.openSync(path.join(s.dir, op.turn.audio_file), 'w', 0o600);
      fs.writeSync(op.fd, wavHeader(0)); op.bytes = 0;
    }
    const offset = op.bytes / (SAMPLE_RATE * 2); op.lastOffset = offset;
    fs.writeSync(op.fd, bytes, 0, bytes.length, 44 + op.bytes); op.bytes += bytes.length;
    fs.writeSync(op.fd, wavHeader(op.bytes), 0, 44, 0);
    op.turn.audio_seconds = op.bytes / (SAMPLE_RATE * 2);
    const item = event(s, 'audio-produced', { turn_id: op.id, offset_seconds: offset, duration_seconds: bytes.length / (SAMPLE_RATE * 2) }, false);
    for (const res of s.clients) res.write(`data: ${JSON.stringify({ ...item, type: 'audio', audio: bytes.toString('base64'), sample_rate: SAMPLE_RATE })}\n\n`);
  }
  function cancel(s, reason = 'interrupted', turnId) {
    const op = s.op;
    if (op && (!turnId || op.id === turnId)) { s.op = null; op.controller.abort(); }
    const turn = s.turns.find(t => t.id === (turnId || op?.id || s.outputTurn));
    if (turn && !turn.playback_complete && turn.status !== 'error') turn.status = 'interrupted';
    event(s, 'interrupted', { turn_id: turn?.id || null, reason }); snapshot(s);
  }
  function endSession(s, reason) {
    if (s.status !== 'active') return;
    clearTimeout(s.commitTimer); s.scribe?.close(); s.scribe = null; s.sceneOp?.abort(); s.backdropOp?.abort(); s.frames = [];
    if (s.micFd !== undefined) { fs.closeSync(s.micFd); s.micFd = undefined; s.media['user-microphone.wav'].complete = true; }
    cancel(s, reason); s.status = 'ended'; s.endedAt = new Date().toISOString();
    event(s, 'session-ended', { reason }); snapshot(s);
    if (activeId === s.id) activeId = null;
  }
  // Professional library voices need a paid plan on many accounts (payment_required), so Claude chooses among the others.
  const choosableVoices = () => voices.filter(v => v.category !== 'professional');
  // Camera frames: the page sends one small JPEG a second; the last 60 s stay in memory. When Claude replies, frames chosen by
  // the vision level go with it (see VISION_LEVELS), and exactly those are saved beside the recording.
  function framesForReply(s, turn, userTurn) {
    const level = s.settings.vision_level;
    if (!VISION_LEVELS[level] || !s.frames?.length) return [];
    const now = Date.now() - s.epoch, latest = s.frames.at(-1);
    if (now - latest.at_ms > 10_000) return [];                                 // the camera stopped sending: nothing current to show
    const turnStart = userTurn?.speech_started_ms ?? (userTurn ? userTurn.at_ms - 6000 : now);
    const lastReply = s.turns.filter(t => t.speaker === 'claude' && t !== turn).at(-1);
    const from = level === 'more' || level === 'live' ? Math.min(turnStart, lastReply?.at_ms ?? turnStart) : turnStart;
    const inTurn = s.frames.filter(f => f.at_ms >= from - 500), n = VISION_LEVELS[level];
    const spread = k => inTurn.length <= k ? inTurn : Array.from({ length: k }, (_, i) => inTurn[Math.round(i * (inTurn.length - 1) / (k - 1))]);
    const pick = !inTurn.length || level === 'still' ? [latest]
      : level === 'few' ? (inTurn.length >= 3 && inTurn.at(-1).at_ms - inTurn[0].at_ms > 2500 ? [inTurn[0], inTurn[Math.floor(inTurn.length / 2)], inTurn.at(-1)]
        : inTurn.length >= 2 && inTurn.at(-1).at_ms - inTurn[0].at_ms > 1200 ? [inTurn[0], inTurn.at(-1)] : [latest])
      : spread(n);
    const dir = path.join(s.dir, 'vision'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    turn.seen = pick.map((f, i) => { const file = `vision/${turn.id}-${i + 1}.jpg`; fs.writeFileSync(path.join(s.dir, file), f.bytes, { mode: 0o600 }); return { file, at_ms: f.at_ms }; });
    event(s, 'vision-sent', { turn_id: turn.id, frames: turn.seen });
    const end = pick.at(-1).at_ms;
    return pick.map((f, i) => ({ data: f.bytes.toString('base64'),
      label: pick.length === 1 ? (userTurn ? 'Their camera as they finished speaking:' : 'Their camera right now:')
        : i === pick.length - 1 ? `Frame ${i + 1} of ${pick.length} from their camera, as they finished speaking:` : `Frame ${i + 1} of ${pick.length} from their camera, ${((end - f.at_ms) / 1000).toFixed(1)} s before they finished:` }));
  }
  // Claude's picks from the catalogue descriptions (not auditioned): Chris, Jessica, Will. The first is the default voice.
  const RECOMMENDED_VOICES = ['iP95p4xoKVk53GoZ742B', 'cgSgspJ2msm6clMCkdW9', 'bIHbv24MWmeRgasZH58o'];
  async function respond(s, { id, introduction = false }) {
    const turn = { id, speaker: 'claude', text: '', speech: '', at_ms: Date.now() - s.epoch, status: 'thinking', played_seconds: 0 };
    const op = { id, turn, controller: new AbortController(), fd: undefined };
    s.turns.push(turn); s.op = op; s.outputTurn = id;
    event(s, 'turn-start', { turn_id: id }); snapshot(s);
    const chunks = new SpeechChunks(); let voice;
    const createVoice = () => {
      if (!voice) {
        voice = new Voice({ key, voiceId: s.voice.voice_id, model: s.settings.tts_model, signal: op.controller.signal,
          onAudio: bytes => sendAudio(s, op, bytes),
          // Sent live so clients can caption what has actually been played; times are relative to offset_seconds.
          onAlignment: alignment => { if (!op.controller.signal.aborted) event(s, 'alignment', { turn_id: id, offset_seconds: op.lastOffset ?? 0, alignment }); } });
        voice.done.catch(error => { if (!op.controller.signal.aborted) { op.voiceError = error; op.controller.abort(); } });
      }
      return voice;
    };
    const onText = text => {
      if (op.controller.signal.aborted) return;
      turn.speech += text; turn.text = cleanSpeech(turn.speech);
      if (turn.speech.length > 5000) { op.controller.abort(); throw new Error('Reply exceeded the speech limit. Saved for review.'); }
      event(s, 'text', { turn_id: id, delta: text });
      for (const part of chunks.add(text)) createVoice().write(part);
    };
    const onModel = model => { s.actualModel = model; event(s, 'model', { model }); };
    const userTurn = introduction ? null : [...s.turns].reverse().find(t => t.speaker === 'user');
    try {
      const images = framesForReply(s, turn, userTurn), vision = images.length ? visionNote(s.settings.vision_level) : VISION_OFF;
      if (!s.voice) {
        const result = await claude({ system: withName(readPrompt('voice-choice'), s) + vision, images, schema: voiceSchema, model: s.settings.claude_model, effort: s.settings.claude_effort,
          prompt: JSON.stringify({ topic: s.settings.topic, selected_voice: s.settings.voice_id, voices: choosableVoices(), conversation: historyForClaude(s.turns.filter(t => t !== turn)) }), signal: op.controller.signal, onModel });
        if (op.controller.signal.aborted) return;
        const choice = result.structured;
        const chosen = voices.find(v => v.voice_id === choice?.voice_id);
        if (!chosen || !choice.opening?.trim()) throw new Error('Claude did not select a valid available voice. Nothing was substituted.');
        s.voice = { ...chosen, rationale: choice.rationale };
        event(s, 'voice', { voice: s.voice });
        onText(choice.opening);
      } else {
        const prompt = JSON.stringify({ topic: s.settings.topic, conversation: historyForClaude(s.turns.filter(t => t !== turn)), instruction: introduction && !s.turns.some(t => t.speaker === 'user') ? 'Open the conversation now with a short, natural greeting, using spoken text with your own sparse delivery cues.' : 'Respond now, using spoken text with your own sparse delivery cues.' });
        if (prompt.length > 160000) throw new Error('This call has reached its conversation context limit. End and review this session before starting another.');
        await claude({ system: withName(readPrompt('conversation'), s) + vision, images, model: s.actualModel || s.settings.claude_model, effort: s.settings.claude_effort, prompt, signal: op.controller.signal, onText, onModel });
      }
      if (op.controller.signal.aborted) { if (op.voiceError) throw op.voiceError; return; }
      for (const part of chunks.add('', true)) createVoice().write(part);
      if (!voice) throw new Error('No speech was produced.');
      await voice.end();
      if (op.controller.signal.aborted) { if (op.voiceError) throw op.voiceError; return; }
      turn.status = 'generated';
      event(s, 'turn-done', { turn_id: id, text: turn.text, generated_audio_seconds: turn.audio_seconds || 0 });
    } catch (error) {
      if (op.voiceError) error = op.voiceError;
      if (error.name !== 'AbortError') {
        turn.status = 'error'; op.controller.abort();
        event(s, 'error', { turn_id: id, message: error.message });
      } else if (turn.status === 'thinking') turn.status = 'interrupted';
    } finally {
      if (op.fd !== undefined) fs.closeSync(op.fd);
      if (s.op === op) s.op = null;
      snapshot(s);
    }
  }

  // Pictures of what's being discussed, drawn in two passes that never delay or change speech: a quick sketch by a fast
  // model (which also decides whether a new picture is wanted at all), then the finished picture by a stronger model,
  // given the sketch to develop, so the screen shows the same picture coming to life. The first pass can start while
  // the person is still talking (from the live transcript), so the sketch is usually ready as Claude begins to answer.
  const SCENE_MODEL = process.env.INTERVIEW_SCENE_MODEL || 'claude-opus-5-5';
  const SKETCH_MODEL = process.env.INTERVIEW_SKETCH_MODEL || 'claude-sonnet-5';
  // One picture is painted at a time. A new turn never cancels a picture in progress (that wasted most of them);
  // it queues one follow-up, which sees the latest conversation and may keep what is on screen.
  async function directScene(s, { early = false } = {}) {
    if (s.settings.visuals === 'off' || s.status !== 'active') return;
    if (s.sceneOp) { if (!early) s.sceneAgain = true; return; }
    const controller = new AbortController(); s.sceneOp = controller; s.sceneAgain = false;
    const id = `scene-${String(s.scenes.filter(x => !x.sketch).length + (s.sceneAttempts = (s.sceneAttempts || 0) + 1)).padStart(3, '0')}`, sketchId = `${id}-sketch`;
    const style = SCENE_STYLES[s.settings.style] || SCENE_STYLES.cafe, dir = path.join(s.dir, 'scenes');
    // what Claude's director sees; while the person is mid-turn, their words so far are the last, unfinished turn
    const input = stage => {
      const shown = s.scenes.at(-1), live = [...(s.pendingText || []), s.partialText || ''].join(' ').trim();
      const conversation = historyForClaude(s.turns).slice(-12).map(t => ({ speaker: t.speaker, text: t.text }));
      if (s.speechStart != null && live) conversation.push({ speaker: 'user', text: live, still_speaking: true });
      return { mode: s.settings.visuals, stage, style, canvas: SCENE_SIZE, topic: s.settings.topic,
        on_screen_now: shown ? { title: shown.title, subject: shown.subject, shot: shown.shot, seconds_on_screen: Math.round((Date.now() - s.epoch - shown.at_ms) / 1000) } : null,
        recent_scenes_do_not_repeat: s.scenes.slice(-10).map(x => ({ title: x.title, subject: x.subject, shot: x.shot })), recent_library_bases: s.baseHistory.slice(-4), conversation };
    };
    const save = (file, header, code, model) => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(dir, file), `// ${header.title} — ${model} (low effort), style ${style.name}\n${code}\n`, { mode: 0o600 }); };
    if (early) s.earlySpeech = s.speechStart;                                     // this stretch of speech now has its picture decision
    event(s, 'scene-start', { scene_id: id, early });
    let stage = 'sketch';
    try {
      // pass 1: the sketch, and the decision (new picture, keep the current one, or none)
      const sketch = new SceneStream(); let announced = false;
      const announce = h => {
        if (announced || !h) return; announced = true;
        if (h.visual) { h.base = freshBase(h.base, s.baseHistory.slice(-4), s.baseHistory.length); s.baseHistory.push(h.base); }
        event(s, h.visual ? 'scene-base' : h.keep ? 'scene-keep' : 'scene-none', { scene_id: h.visual ? sketchId : id, ...(h.visual ? h : {}) });
      };
      await claude({ system: readPrompt('scene'), model: SKETCH_MODEL, effort: 'low', prompt: JSON.stringify(input('sketch')), signal: controller.signal, onText: d => announce(sketch.add(d)) });
      if (controller.signal.aborted) return;
      announce(sketch.header || { visual: false });
      if (!sketch.header?.visual) return;
      const header = sketch.header; let sketchCode = null;
      try {
        sketchCode = checkSceneCode(sketch.code()); save(`${sketchId}.js`, header, sketchCode, SKETCH_MODEL);
        s.scenes.push({ id: sketchId, ...header, sketch: true, style: s.settings.style, file: `scenes/${sketchId}.js`, at_ms: Date.now() - s.epoch });
        event(s, 'scene-ready', { scene_id: sketchId, url: `/scene-frame/${s.id}/${sketchId}` }); snapshot(s);
      } catch (error) { event(s, 'scene-error', { scene_id: sketchId, sketch: true, message: String(error.message).slice(0, 300) }); }
      // pass 2: the finished picture, developed from the sketch. If the person is still mid-turn, wait (up to 10 s) for the
      // turn to finish, so the finished picture is painted with their whole thought and the start of Claude's answer in view.
      for (const end = Date.now() + 10_000; s.speechStart != null && Date.now() < end && !controller.signal.aborted && s.status === 'active';) await new Promise(r => setTimeout(r, 150));
      if (controller.signal.aborted) return;
      stage = 'final';
      event(s, 'scene-base', { scene_id: id, ...header, refine: Boolean(sketchCode) });
      const final = new SceneStream();
      await claude({ system: readPrompt('scene'), model: SCENE_MODEL, effort: 'low', prompt: JSON.stringify({ ...input('final'), sketch: { header, code: sketchCode } }), signal: controller.signal, onText: d => final.add(d) });
      if (controller.signal.aborted) return;
      const code = checkSceneCode(final.code()); save(`${id}.js`, header, code, SCENE_MODEL);
      const record = { id, ...header, style: s.settings.style, file: `scenes/${id}.js`, sketch_file: sketchCode ? `scenes/${sketchId}.js` : null, at_ms: Date.now() - s.epoch };
      const at = s.scenes.findIndex(x => x.id === sketchId); if (at >= 0) s.scenes[at] = { ...record, at_ms: s.scenes[at].at_ms }; else s.scenes.push(record);
      event(s, 'scene-ready', { scene_id: id, url: `/scene-frame/${s.id}/${id}` }); snapshot(s);
    } catch (error) {
      if (error.name !== 'AbortError' && s.status === 'active') event(s, 'scene-error', { scene_id: stage === 'final' ? id : sketchId, sketch: stage !== 'final', message: String(error.message).slice(0, 300) });
    } finally {
      if (s.sceneOp === controller) s.sceneOp = null;
      if (s.sceneAgain && !controller.signal.aborted && s.status === 'active') void directScene(s);
    }
  }

  // A third, independent call paints the user's ambient backdrop. It keeps the current one unless the conversation moves on.
  async function directBackdrop(s) {
    if (!s.settings.backdrops || s.status !== 'active' || s.backdropOp) return;
    const controller = new AbortController(); s.backdropOp = controller;
    const id = `backdrop-${String((s.backdropAttempts = (s.backdropAttempts || 0) + 1)).padStart(3, '0')}`;
    const style = SCENE_STYLES[s.settings.style] || SCENE_STYLES.clawd, stream = new SceneStream(normalizeBackdrop);
    try {
      const prompt = JSON.stringify({ style, topic: s.settings.topic, current_backdrop: s.backdrops.at(-1)?.title || null, previous_backdrops: s.backdrops.slice(-6).map(b => b.title),
        conversation: historyForClaude(s.turns).slice(-8).map(t => ({ speaker: t.speaker, text: t.text })) });
      await claude({ system: readPrompt('backdrop'), model: SCENE_MODEL, effort: 'low', prompt, signal: controller.signal, onText: d => stream.add(d) });
      if (controller.signal.aborted || !stream.header?.backdrop) return;
      const code = checkSceneCode(stream.code());
      const dir = path.join(s.dir, 'backdrops'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, `${id}.js`), `// ${stream.header.title} — backdrop by ${SCENE_MODEL} (low effort), style ${style.name}\n${code}\n`, { mode: 0o600 });
      s.backdrops.push({ id, title: stream.header.title, style: s.settings.style, file: `backdrops/${id}.js`, at_ms: Date.now() - s.epoch });
      event(s, 'backdrop-ready', { backdrop_id: id, url: `/scene-frame/${s.id}/${id}` }); snapshot(s);
    } catch (error) {
      if (error.name !== 'AbortError' && s.status === 'active') event(s, 'backdrop-error', { backdrop_id: id, message: String(error.message).slice(0, 300) });
    } finally { if (s.backdropOp === controller) s.backdropOp = null; }
  }

  function spokenInput(s, data) {
    if (s.status !== 'active' || s.muted) return;
    const kind = data.message_type, text = String(data.text || '').trim();
    if (kind === 'partial_transcript' && text) {
      if (s.lastCommit?.text === text && Date.now() - s.lastCommit.at < 700) return;
      s.speechStart ??= Date.now() - s.epoch;                                   // when this turn's speech began (for camera frames)
      s.partialText = text;
      event(s, 'partial-transcript', { text }); clearTimeout(s.commitTimer);
      // start the picture while the person is still talking, once the subject is likely clear (about 3 s and 8 words in)
      const said = [...(s.pendingText || []), text].join(' ');
      if (s.earlySpeech !== s.speechStart && Date.now() - s.epoch - s.speechStart > 3000 && said.split(/\s+/).length >= 8) void directScene(s, { early: true });
      const output = s.turns.find(t => t.id === s.outputTurn);
      if (output && !['delivered', 'interrupted', 'error'].includes(output.status)) cancel(s, 'speech', output.id);
    }
    if (!['committed_transcript', 'committed_transcript_with_timestamps'].includes(kind) || !text) return;
    if (kind.endsWith('_with_timestamps')) event(s, 'transcript-alignment', { text, words: data.words || [] }, false);
    if (s.lastCommit?.text === text && s.lastCommit.kind !== kind && Date.now() - s.lastCommit.at < 1000) {
      if (s.pendingText?.length && data.words?.length) s.pendingWords.push(...data.words);
      return;
    }
    s.lastCommit = { text, kind, at: Date.now() };
    (s.pendingText ||= []).push(text); (s.pendingWords ||= []).push(...(data.words || []));
    cancel(s, 'speech', s.outputTurn);
    clearTimeout(s.commitTimer);
    s.commitTimer = setTimeout(() => {
      if (s.status !== 'active' || s.muted) return;
      const turn = { id: randomUUID(), speaker: 'user', text: s.pendingText.join(' '), words: s.pendingWords, at_ms: Date.now() - s.epoch, speech_started_ms: s.speechStart ?? null, status: 'transcribed' };
      const decided = s.earlySpeech != null && s.earlySpeech === s.speechStart;   // a picture was already started from this speech
      s.speechStart = null; s.partialText = '';
      s.pendingText = []; s.pendingWords = []; s.turns.push(turn); event(s, 'user-turn', { turn });
      void respond(s, { id: randomUUID() }).catch(error => event(s, 'error', { message: error.message }));
      if (!decided) void directScene(s);
      void directBackdrop(s);
    }, 400);
  }

  const server = http.createServer(async (req, res) => {
    const port = server.address().port;
    const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      if (!allowRequest(req, port)) return reply(403, { error: 'This studio is only accessible from its own local page.' });
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'no-store');
      const authorized = req.headers.cookie?.split(';').some(x => x.trim() === `ci_access=${access}`);
      if (url.pathname === '/' && req.method === 'GET') res.setHeader('Set-Cookie', `ci_access=${access}; HttpOnly; SameSite=Strict; Path=/`);
      else if (url.pathname.startsWith('/api/') && !authorized) return reply(403, { error: 'Open the studio page first.' });
      if (url.pathname === '/api/broadcast/status' && req.method === 'GET') return reply(200, { ...broadcast.status(), key_set: await broadcast.keySet() });
      if (url.pathname === '/api/broadcast/start' && req.method === 'POST') return reply(200, await broadcast.start(await json(req)));
      if (url.pathname === '/api/broadcast/stop' && req.method === 'POST') return reply(200, await broadcast.stop());
      if (url.pathname === '/api/broadcast/chunk' && req.method === 'POST') return reply(200,
        await broadcast.chunk(url.searchParams.get('id'), Number(url.searchParams.get('seq')), await body(req, 16_000_000)));
      if (url.pathname === '/api/health') return reply(200, { ok: true, name: 'Claude Interview' });
      if (url.pathname === '/api/status' && req.method === 'GET') {
        const status = await auth(); const stat = fs.statfsSync(root);
        return reply(200, { claude: status, elevenlabs_key_set: Boolean(key), voice_count: voices.length,
          voices, active_session: activeId, free_gb: Math.round(stat.bavail * stat.bsize / 1e9),
          default_tts_model: 'eleven_v3_conversational', recommended_voices: RECOMMENDED_VOICES, scene_styles: SCENE_STYLES, visual_modes: VISUAL_MODES, claude_model_aliases: ['fable', 'opus', 'sonnet', 'haiku'], claude_efforts: EFFORTS });
      }
      if (url.pathname === '/api/settings' && req.method === 'POST') {
        if (activeId) throw fail('End the current call before changing credentials.', 409);
        const data = await json(req);
        const candidate = typeof data.api_key === 'string' && data.api_key.trim() ? data.api_key.trim() : key || await loadKey();
        if (candidate.length > 512) throw fail('Invalid API key.');
        const list = await getVoices(candidate);
        if (!list.length) throw fail('No voices were returned by this account.');
        if (data.api_key?.trim()) await storeKey(candidate);
        key = candidate; voices = list;
        return reply(200, { ok: true, voices });
      }
      // Browser backups of camera/full-frame recordings that never finished uploading (a reload, crash or restart
      // mid-call). The complete backup is written beside the originals as <name>.recovered.<ext>; nothing is overwritten.
      const recover = url.pathname.match(/^\/api\/recordings\/([0-9a-f-]{36})\/recover$/);
      if (recover && req.method === 'POST') {
        const name = url.searchParams.get('name') || '', m = name.match(/^(user-camera|stage|user-voice|claude-voice)\.(webm|mp4|pcm)$/);
        if (!UUID.test(recover[1]) || !m) throw fail('Invalid recording.');
        const dir = path.join(recordings, recover[1]), sessionFile = path.join(dir, 'session.json');
        if (!fs.existsSync(sessionFile)) throw fail('That session folder no longer exists; keep the browser backup.', 404);
        if (sessions.get(recover[1])?.status === 'active') throw fail('That call is still in progress.', 409);
        const pcm = m[2] === 'pcm', rate = Number(url.searchParams.get('rate'));
        if (pcm && (!Number.isInteger(rate) || rate < 8000 || rate > 192000)) throw fail('Invalid sample rate.');
        const target = path.join(dir, `${m[1]}.recovered.${pcm ? 'wav' : m[2]}`);
        if (fs.existsSync(target)) return reply(200, { ok: true, already: true, bytes: fs.statSync(target).size, file: path.basename(target) });
        const tmp = `${target}.part`, hash = createHash('sha256'), out = fs.createWriteStream(tmp, { mode: 0o600 });
        let bytes = 0;
        try {
          for await (const chunk of req) { bytes += chunk.length; if (bytes > 8e9) throw fail('Recording too large.', 413); hash.update(chunk); if (!out.write(chunk)) await new Promise(r => out.once('drain', r)); }
          await new Promise((resolve, reject) => { out.end(); out.once('finish', resolve); out.once('error', reject); });
        } catch (error) { out.destroy(); fs.rmSync(tmp, { force: true }); throw error; }
        const expected = Number(url.searchParams.get('bytes'));
        if (!bytes || (Number.isFinite(expected) && expected > 0 && expected !== bytes)) { fs.rmSync(tmp, { force: true }); throw fail('Recovered size did not match the browser backup; it was kept.'); }
        if (pcm) { const raw = `${tmp}.pcm`; fs.renameSync(tmp, raw); pcmToWav(raw, rate); fs.renameSync(raw.replace(/\.pcm$/, '.wav'), target); bytes += 44; }
        else fs.renameSync(tmp, target);
        const info = { bytes, complete: url.searchParams.get('contiguous') === '1', recovered_from_browser_backup: true, sha256: hash.digest('hex'), mime_type: req.headers['content-type'] };
        const live = sessions.get(recover[1]);
        if (live) { live.media[path.basename(target)] = info; event(live, 'media-recovered', { name: path.basename(target), ...info }, false); snapshot(live); }
        else {
          const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8')); saved.media = { ...saved.media, [path.basename(target)]: info };
          fs.writeFileSync(`${sessionFile}.tmp`, JSON.stringify(saved, null, 2)); fs.renameSync(`${sessionFile}.tmp`, sessionFile);
          fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ type: 'media-recovered', at: new Date().toISOString(), name: path.basename(target), ...info }) + '\n');
        }
        return reply(200, { ok: true, bytes, file: path.basename(target) });
      }
      if (url.pathname === '/api/prompt') {
        const defaults = fs.existsSync(promptFile('conversation.default')) ? readPrompt('conversation.default') : null;
        if (req.method === 'GET') { const text = readPrompt('conversation'); return reply(200, { text, default_text: defaults, is_default: text === defaults }); }
        if (req.method === 'POST') {
          const data = await json(req);
          const text = data.reset ? defaults : String(data.text ?? '');
          if (!text?.trim() || text.length > 20000) throw fail('The prompt must be between 1 and 20,000 characters.');
          const tmp = promptFile('conversation') + '.tmp'; fs.writeFileSync(tmp, text); fs.renameSync(tmp, promptFile('conversation'));
          const s = activeId && sessions.get(activeId);
          if (s) event(s, 'prompt-changed', { text }, false);
          return reply(200, { text, default_text: defaults, is_default: text === defaults });
        }
      }
      if (url.pathname === '/api/shutdown' && req.method === 'POST') {
        reply(200, { ok: true });
        setImmediate(() => { for (const s of sessions.values()) { endSession(s, 'server-stopped'); for (const client of s.clients) client.end(); } server.close(); });
        return;
      }
      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        if (activeId) throw fail('A call is already open. End it before starting another.', 409);
        { const status = await auth(); if (!status.ready) throw fail(status.mode === 'api' ? 'INTERVIEW_CLAUDE_AUTH=api is set but ANTHROPIC_API_KEY is missing from the backend environment.' : 'Sign in to Claude Code with your Claude subscription first. Run ./interview login.', 409); }
        if (!key) throw fail('Run ./interview key set first.', 409);
        if (!voices.length) voices = await getVoices(key);
        const data = await json(req), id = randomUUID();
        data.tts_model ||= 'eleven_v3_conversational'; data.voice_id ||= RECOMMENDED_VOICES.find(id => voices.some(v => v.voice_id === id)) || 'auto';
        if (!['eleven_v3_conversational', 'eleven_v3'].includes(data.tts_model)) throw fail('Select an Eleven v3 voice model.');
        if (data.claude_effort && !EFFORTS.includes(data.claude_effort)) throw fail(`Effort must be one of ${EFFORTS.join(', ')}.`);
        if (data.claude_model && !/^[\w.\-\[\]]{1,100}$/.test(data.claude_model)) throw fail('Invalid Claude model name.');
        if (data.voice_id !== 'auto' && !voices.some(v => v.voice_id === data.voice_id)) throw fail('Select an available voice or let Claude choose.');
        const stat = fs.statfsSync(root); if (stat.bavail * stat.bsize < 500_000_000) throw fail('Less than 500 MB free. Free some space before recording.', 507);
        const s = { id, epoch: Date.now(), createdAt: new Date().toISOString(), status: 'active', dir: path.join(recordings, id),
          settings: { user_name: cleanName(data.user_name ?? process.env.INTERVIEW_USER_NAME), vision_level: VISION_LEVELS[data.vision_level] !== undefined ? data.vision_level : data.vision === false ? 'off' : 'few', topic: String(data.topic || '').slice(0,4000), voice_id: data.voice_id, claude_model: String(data.claude_model || '').slice(0,100), claude_effort: data.claude_effort || '', tts_model: data.tts_model,
            visuals: VISUAL_MODES.includes(data.visuals) ? data.visuals : 'off', style: SCENE_STYLES[data.style] ? data.style : 'cafe', backdrops: data.backdrops === true },
          scenes: [], backdrops: [], baseHistory: [], turns: [], media: {}, clients: new Set(), requests: new Set(), seq: 0, op: null, voice: null };
        if (s.settings.voice_id !== 'auto') { const v = voices.find(v => v.voice_id === s.settings.voice_id); s.voice = { ...v, rationale: 'Selected before the call.' }; }
        fs.mkdirSync(s.dir, { mode: 0o700 }); sessions.set(id, s); activeId = id;
        fs.writeFileSync(path.join(s.dir, 'system-prompt.md'), readPrompt('conversation'), { mode: 0o600 });
        event(s, 'session-created', { settings: s.settings }); snapshot(s);
        return reply(201, publicSession(s));
      }
      const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/);
      if (match) {
        const [, id, action = ''] = match;
        if (!UUID.test(id)) throw fail('Invalid session ID.');
        const s = sessions.get(id);
        if (!s) throw fail('Session is not active in this server. Raw files remain in recordings/.', 404);
        if (!action && req.method === 'GET') return reply(200, publicSession(s));
        if (action === 'events' && req.method === 'GET') {
          const controls = url.searchParams.get('controller') === '1';
          if (controls && s.controllerConnected) throw fail('Another client controls this call.', 409);
          if (controls) s.controllerConnected = true;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'Cache-Control': 'no-cache' });
          s.clients.add(res); res.write('data: {"type":"connected"}\n\n');
          const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
          req.on('close', () => { clearInterval(heartbeat); s.clients.delete(res); if (controls) { s.controllerConnected = false; endSession(s, 'controller-disconnected'); } });
          return;
        }
        if (action === 'input-audio' && req.method === 'POST') {
          if (s.status !== 'active' || !s.scribe) throw fail('Start listening before sending PCM audio.', 409);
          let bytes = await body(req, 320000);
          if (!bytes.length || bytes.length % 2) throw fail('Audio must be mono signed 16-bit little-endian PCM at 16 kHz.');
          if (s.muted) bytes = Buffer.alloc(bytes.length);
          if (s.micFd === undefined) {
            s.micFd = fs.openSync(path.join(s.dir, 'user-microphone.wav'), 'wx', 0o600);
            fs.writeSync(s.micFd, wavHeader(0, 16000)); s.micBytes = 0;
            s.media['user-microphone.wav'] = { bytes: 44, complete: false, mime_type: 'audio/wav', sample_rate: 16000 };
          }
          fs.writeSync(s.micFd, bytes, 0, bytes.length, 44 + s.micBytes); s.micBytes += bytes.length;
          fs.writeSync(s.micFd, wavHeader(s.micBytes, 16000), 0, 44, 0);
          s.media['user-microphone.wav'].bytes = 44 + s.micBytes;
          s.scribe.write(bytes); return reply(200, { ok: true });
        }
        if (action === 'frame' && req.method === 'POST') {
          const bytes = await body(req, 1_500_000);
          if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw fail('Frames must be JPEG images.');
          if (s.status !== 'active' || !VISION_LEVELS[s.settings.vision_level]) return reply(200, { ok: true, used: false });
          const at = Date.now() - s.epoch; (s.frames ||= []).push({ at_ms: at, bytes });
          while (s.frames.length && at - s.frames[0].at_ms > 60_000) s.frames.shift();
          return reply(200, { ok: true, used: true });
        }
        if (action === 'download' && req.method === 'GET') {
          res.setHeader('Content-Disposition', `attachment; filename="interview-${id}.json"`);
          return reply(200, publicSession(s));
        }
        if (action === 'media' && req.method === 'POST') {
          const name = url.searchParams.get('name'), seq = Number(url.searchParams.get('seq'));
          if (!/^((user-camera|user-microphone|stage)\.(webm|mp4)|(user-voice|claude-voice)\.pcm)$/.test(name || '') || !Number.isInteger(seq) || seq < 0) throw fail('Invalid recording chunk.');
          const chunk = await body(req, 32_000_000); const hash = createHash('sha256').update(chunk).digest('hex');
          const media = s.media[name] ||= { chunks: 0, bytes: 0, complete: false, mime_type: req.headers['content-type'] };
          if (seq === media.chunks - 1 && hash === media.last_hash) return reply(200, { ok: true, duplicate: true });
          if (seq !== media.chunks || media.complete) throw fail('Recording chunks arrived out of order. Your browser still holds the backup.', 409);
          const filePath = path.join(s.dir, name);
          const fd = fs.openSync(filePath, fs.existsSync(filePath) ? 'r+' : 'wx', 0o600);
          try {
            let written = 0;
            while (written < chunk.length) written += fs.writeSync(fd, chunk, written, chunk.length - written, media.bytes + written);
            fs.ftruncateSync(fd, media.bytes + chunk.length);
          } finally { fs.closeSync(fd); }
          media.chunks++; media.bytes += chunk.length; media.last_hash = hash;
          snapshot(s); return reply(200, { ok: true, bytes: media.bytes });
        }
        if (req.method !== 'POST') throw fail('Unknown endpoint.', 404);
        const data = await json(req);
        if (action === 'event') {
          if (!['audio-playback', 'playback-complete', 'marker', 'media-start', 'media-complete', 'media-error', 'stt-connected', 'stt-error', 'transcript-alignment', 'mic-muted', 'mic-unmuted'].includes(data.type)) throw fail('Unsupported event.');
          if (['media-start', 'media-complete'].includes(data.type) && !/^((user-camera|user-microphone|stage)\.(webm|mp4|mov|wav)|(user-voice|claude-voice)\.pcm)$/.test(data.name || '')) throw fail('Invalid recording name.');
          const turn = s.turns.find(t => t.id === data.turn_id);
          if (turn && ['audio-playback', 'playback-complete'].includes(data.type)) {
            turn.played_seconds = Math.max(turn.played_seconds || 0, Math.min(Number(data.played_seconds) || 0, turn.audio_seconds || 0));
            if (data.type === 'playback-complete' && turn.status === 'generated') { turn.playback_complete = true; turn.status = 'delivered'; }
          }
          if (data.type === 'media-complete' && s.media[data.name]) { s.media[data.name].complete = true; if (Number.isSafeInteger(data.bytes)) s.media[data.name].bytes = data.bytes; }
          // Lossless voice stems arrive as raw 16-bit mono PCM; once complete they become standard WAV files.
          if (data.type === 'media-complete' && /\.pcm$/.test(data.name) && s.media[data.name]) {
            const rate = Number(data.sample_rate); if (!Number.isInteger(rate) || rate < 8000 || rate > 192000) throw fail('Invalid sample rate.');
            const wav = pcmToWav(path.join(s.dir, data.name), rate);
            const { chunks, started_client_ms } = s.media[data.name]; delete s.media[data.name];
            s.media[path.basename(wav.file)] = { bytes: wav.bytes, complete: true, mime_type: 'audio/wav', sample_rate: rate, chunks, started_client_ms };
          }
          if (data.type === 'media-start') s.media[data.name] ||= { chunks: 0, bytes: 0, complete: false, mime_type: data.mime_type, started_client_ms: data.client_ms };
          event(s, data.type, { ...data, type: data.type, at_ms: Date.now() - s.epoch }, false); snapshot(s);
          return reply(200, { ok: true });
        }
        if (action === 'end') { endSession(s, 'user-ended'); return reply(200, publicSession(s)); }
        if (action === 'interrupt') { cancel(s, data.reason || 'user-interrupted', data.turn_id); return reply(200, { ok: true }); }
        if (s.status !== 'active') throw fail('This call has ended.', 409);
        if (action === 'listen') {
          if (s.scribe) throw fail('Speech recognition is already connected.', 409);
          const silence = Number(data.silence ?? 1.5);
          if (silence < 0.3 || silence > 3 || !Number.isFinite(silence)) throw fail('Silence must be between 0.3 and 3 seconds.');
          const scribe = new Scribe({ key, silence, request: requestEleven,
            onMessage: msg => spokenInput(s, msg),
            onError: error => { event(s, 'error', { message: error.message }); endSession(s, 'transcription-failed'); } });
          s.scribe = scribe;
          try { await scribe.ready; } catch (e) { scribe.close(); s.scribe = null; throw e; }
          if (s.status !== 'active') throw fail('Session ended while transcription connected.', 409);
          event(s, 'stt-connected'); return reply(200, { ok: true, audio_format: 'pcm_s16le_16000_mono' });
        }
        if (action === 'config') {
          // Model, thinking level, voice and topic can change mid-call; they apply from the next reply.
          if (data.claude_effort !== undefined && data.claude_effort !== '' && !EFFORTS.includes(data.claude_effort)) throw fail(`Effort must be one of ${EFFORTS.join(', ')}.`);
          if (data.claude_model !== undefined && data.claude_model !== '' && !/^[\w.\-\[\]]{1,100}$/.test(data.claude_model)) throw fail('Invalid Claude model name.');
          if (data.claude_model !== undefined && data.claude_model !== s.settings.claude_model) { s.settings.claude_model = data.claude_model; s.actualModel = null; }
          if (data.claude_effort !== undefined) s.settings.claude_effort = data.claude_effort;
          if (data.voice_id !== undefined) {
            const v = voices.find(v => v.voice_id === data.voice_id); if (!v) throw fail('Select an available voice.');
            s.settings.voice_id = v.voice_id; s.voice = { ...v, rationale: 'Selected during the call.' };
          }
          if (data.topic !== undefined) s.settings.topic = String(data.topic).slice(0, 4000);
          if (data.user_name !== undefined) s.settings.user_name = cleanName(data.user_name);
          if (data.vision_level !== undefined && VISION_LEVELS[data.vision_level] === undefined) throw fail(`Vision must be one of ${Object.keys(VISION_LEVELS).join(', ')}.`);
          const level = data.vision_level ?? (data.vision === false ? 'off' : data.vision === true && s.settings.vision_level === 'off' ? 'few' : undefined);
          if (level !== undefined) { s.settings.vision_level = level; if (level === 'off') s.frames = []; }
          if (data.visuals !== undefined) { if (!VISUAL_MODES.includes(data.visuals)) throw fail('Unknown visuals mode.'); s.settings.visuals = data.visuals; if (data.visuals === 'off') s.sceneOp?.abort(); }
          if (data.style !== undefined) { if (!SCENE_STYLES[data.style]) throw fail('Unknown style.'); s.settings.style = data.style; }
          if (data.backdrops !== undefined) { s.settings.backdrops = data.backdrops === true; if (s.settings.backdrops && !s.backdrops.length) void directBackdrop(s); if (!s.settings.backdrops) s.backdropOp?.abort(); }
          event(s, 'config-changed', { claude_model: s.settings.claude_model, claude_effort: s.settings.claude_effort, voice_id: s.settings.voice_id, topic: s.settings.topic, visuals: s.settings.visuals, style: s.settings.style }); snapshot(s);
          return reply(200, { settings: s.settings });
        }
        if (action === 'mute') {
          s.muted = data.muted !== false; clearTimeout(s.commitTimer); s.pendingText = []; s.pendingWords = [];
          event(s, s.muted ? 'mic-muted' : 'mic-unmuted'); return reply(200, { muted: s.muted });
        }
        if (action === 'turn') {
          if (!UUID.test(data.reply_id || '') || !UUID.test(data.request_id || '')) throw fail('Invalid turn identifier.');
          if (s.requests.has(data.request_id)) return reply(200, { duplicate: true });
          if (s.op) cancel(s, 'new-turn');
          if (!data.introduction) {
            const text = String(data.text || '').trim(); if (!text || text.length > 16000) throw fail('Empty or oversized spoken turn.');
            const userTurn = { id: data.request_id, speaker: 'user', text, at_ms: Date.now() - s.epoch,
              client_ms: data.client_ms, words: Array.isArray(data.words) ? data.words : [], status: 'transcribed' };
            s.turns.push(userTurn); event(s, 'user-turn', { turn: userTurn });
          }
          s.requests.add(data.request_id);
          if (!data.introduction) void directScene(s);
          void directBackdrop(s);
          void respond(s, { id: data.reply_id, introduction: data.introduction === true }).catch(() => {
            s.op?.controller.abort(); s.op = null;
            for (const client of s.clients) client.write('data: {"type":"error","message":"The recording could not be written. End this call and recover browser recordings."}\n\n');
          });
          return reply(202, { turn_id: data.reply_id });
        }
        throw fail('Unknown action.', 404);
      }
      const preview = url.pathname.match(/^\/api\/voices\/([A-Za-z0-9]{1,64})\/preview$/);
      if (preview && req.method === 'GET') {
        // ElevenLabs' free stock preview clip, fetched and cached here so the page only ever loads local audio.
        const voice = voices.find(v => v.voice_id === preview[1]);
        if (!voice?.preview_url) throw fail('No preview for this voice.', 404);
        const source = new URL(voice.preview_url);
        if (source.protocol !== 'https:' || !/(^|\.)(googleapis\.com|elevenlabs\.io)$/.test(source.hostname)) throw fail('Unexpected preview location.', 502);
        const dir = path.join(root, '.runtime', 'voice-previews'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const file = path.join(dir, `${voice.voice_id}.mp3`);
        if (!fs.existsSync(file)) {
          const r = await fetch(source, { signal: AbortSignal.timeout(15000) });
          if (!r.ok) throw fail('Could not fetch the voice preview.', 502);
          fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()), { mode: 0o600 });
        }
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=86400' });
        return fs.createReadStream(file).pipe(res);
      }
      const sceneFrame = url.pathname.match(/^\/scene-frame\/([0-9a-f-]{36})\/((?:scene|backdrop)-\d{3}(?:-sketch)?)$/);
      if (sceneFrame && req.method === 'GET') {
        const s = sessions.get(sceneFrame[1]), want = sceneFrame[2], all = [...(s?.scenes || []), ...(s?.backdrops || [])];
        // a sketch stays reachable after its finished picture replaces it in the record
        const scene = all.find(x => x.id === want) || all.find(x => x.sketch_file && `${x.id}-sketch` === want);
        if (!scene) throw fail('Scene not found.', 404);
        const code = fs.readFileSync(path.join(s.dir, scene.id === want ? scene.file : scene.sketch_file), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': SCENE_FRAME_CSP });
        return res.end(sceneFrameHTML({ code, style: SCENE_STYLES[scene.style] || SCENE_STYLES.cafe, ...(scene.id.startsWith('scene-') ? SCENE_SIZE : BACKDROP_SIZE) }));
      }
      if (req.method !== 'GET') throw fail('Not found.', 404);
      const file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      // Vendored MediaPipe files (local person segmentation for the user's background) live in public/vendor.
      if (!/^[a-zA-Z0-9_-]+\.(html|css|js)$/.test(file) && !/^vendor\/[a-zA-Z0-9_]+\.(mjs|js|wasm|tflite)$/.test(file)) throw fail('Not found.', 404);
      const location = path.join(root, 'public', file);
      if (!fs.existsSync(location)) throw fail('Not found.', 404);
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      res.setHeader('Content-Type', TYPES[path.extname(file)]); fs.createReadStream(location).pipe(res);
    } catch (error) {
      if (!res.headersSent) reply(error.status || 500, { error: error.message });
      else res.end();
    }
  });
  server.on('close', () => { void broadcast.stop(); for (const s of sessions.values()) { endSession(s, 'server-stopped'); for (const c of s.clients) c.end(); } });
  return { server, shutdown: () => { for (const s of sessions.values()) { endSession(s, 'server-stopped'); for (const c of s.clients) c.end(); } server.close(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const studio = createStudio({ initialKey: await readKey() });
  const port = Number(process.env.INTERVIEW_PORT || DEFAULT_PORT);
  studio.server.listen(port, '127.0.0.1', () => console.log(`Claude Interview backend: http://127.0.0.1:${studio.server.address().port}\nRecordings: ${path.join(ROOT, 'recordings')}\nStart a hands-free conversation with ./interview talk`));
  studio.server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is occupied. Set INTERVIEW_PORT to another port.` : error.message); process.exitCode = 1; });
  process.on('SIGINT', () => studio.shutdown()); process.on('SIGTERM', () => studio.shutdown());
}
