// Claude Interview \u2014 browser room. The backend owns credentials, recognition, turn detection and
// Claude/voice generation. This page captures, plays, reports playback evidence and records.
import { Stage } from './stage.js';
import { Broadcast } from './broadcast.js';
import { STYLES, LEGACY_STYLES } from './styles.js';
import { Mic, PcmUploader, Player } from './audio.js';
import { recordTrack, recordPcm, backups, recover, removeRecording, backupBlob } from './recording.js';

const $ = s => document.querySelector(s);
const video = $('#camera');
const stage = new Stage($('#stage'), video);
const uuid = () => crypto.randomUUID();
const display = speech => speech.replace(/\[[^\]\n]{0,80}\]/g, '').replace(/\[[^\]]*$/, '').replace(/\s+/g, ' ').trim();
const fmtBytes = n => n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`;
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

let phase = 'lobby';          // lobby | starting | live | ending | ended
let status = null, session = null, es = null, ctx = null, stream = null, mic = null, uploader = null, player = null;
let recorders = [], recProgress = {}, t0 = 0, muted = false, connectionLost = false, lastPartialAt = -1e9;
let sceneFrame = null;         // sandboxed iframe drawing the current bespoke scene
let current = null;           // Claude's current reply: {id, speech, chars, stopped, completed, error, el}
const clientMs = () => Math.round(performance.now() - t0);

// ---------- HTTP ----------
async function request(path, data, timeout = 30000) {
  const raw = data instanceof Blob || data instanceof Uint8Array;
  const init = data === undefined ? {} : { method: 'POST', body: raw ? data : JSON.stringify(data),
    headers: { 'Content-Type': raw ? (data.type || 'application/octet-stream') : 'application/json' } };
  const response = await fetch(path, { ...init, signal: AbortSignal.timeout(timeout) });
  let body = {}; try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}
const api = (action, data, timeout) => request(`/api/sessions/${session.id}/${action}`, data, timeout);
const broadcast = new Broadcast({ canvas: $('#stage'), getAudio: () => ({ ctx, stream, mic, player }),
  ensureDevices: async () => stream?.getAudioTracks().some(t => t.readyState === 'live') ? true : enableDevices(), request, notify: toast });

function toast(message, bad = false, ms = 3200) {
  const el = document.createElement('div'); el.className = `toast${bad ? ' bad' : ''}`; el.textContent = message;
  $('#toasts').append(el); setTimeout(() => el.remove(), bad ? Math.max(ms, 7000) : ms);
}
function chip(id, text, dot) {
  const el = $(`#chip-${id}`); el.hidden = false; $(`#${id}-text`).textContent = text;
  const d = el.querySelector('.dot'); d.className = `dot ${dot || ''}`;
}

// ---------- setup (everything lives in the Settings panel; the room opens ready to start) ----------
function setPhase(p) { phase = p; document.body.dataset.phase = p; for (const el of document.querySelectorAll('.precall')) el.disabled = p !== 'lobby'; }

async function loadStatus() {
  const box = $('#lobby-status');
  const problem = html => { box.hidden = false; box.className = 'status bad'; box.innerHTML = html; openPanel('settings'); };
  try {
    status = await request('/api/status');
    const ready = status.claude?.ready && status.elevenlabs_key_set;
    if (status.active_session) {
      problem('Another call is still open. <button type="button" class="small" id="btn-end-other">End it</button>'); chip('conn', 'Busy', 'warn');
      $('#btn-end-other').onclick = async () => { try { await request(`/api/sessions/${status.active_session}/end`, {}); await loadStatus(); } catch (error) { toast(error.message, true); } };
    }
    else if (!status.claude?.ready) { problem(status.claude?.mode === 'api' ? 'API-key mode needs <code>ANTHROPIC_API_KEY</code> in the backend environment. Restart the backend after setting it.' : 'Claude Code isn\u2019t signed in. Run <code>./interview login</code>, then reload.'); chip('conn', 'Setup needed', 'warn'); }
    else if (!status.elevenlabs_key_set) { problem('The voice service isn\u2019t configured. Run <code>./interview key set</code>, then reload.'); chip('conn', 'Setup needed', 'warn'); }
    else { box.hidden = true; chip('conn', 'Ready', 'ok'); }
    fillChoices(status);
    stage.claude = ready && !status.active_session ? 'ready' : 'offline';
    $('#btn-start').disabled = !ready || Boolean(status.active_session);
  } catch (error) {
    problem(`Can\u2019t reach the backend (${error.message}). Run <code>./interview up</code>, then reload.`);
    chip('conn', 'Offline', 'bad'); $('#btn-start').disabled = true;
  }
}

// Backups left by a call that ended abruptly are uploaded into their own session folder as
// <name>.recovered.<ext>; the browser copy is cleared only once the backend confirms every byte.
let autoRecovered = false;
async function autoRecover(items) {
  let done = 0, kept = 0;
  for (const item of items) {
    const sessionId = item.recording.slice(0, 36);
    if (sessionId === session?.id) continue;                                  // never touch the call in progress
    try {
      const { blob, contiguous } = await backupBlob(item);
      const rate = /rate=(\d+)/.exec(item.mime || '')?.[1] || '';
      const r = await request(`/api/recordings/${sessionId}/recover?name=${encodeURIComponent(item.name)}&bytes=${blob.size}&contiguous=${contiguous ? 1 : 0}&rate=${rate}`, blob, 600000);
      if (r.bytes === blob.size || (rate && r.bytes === blob.size + 44)) { await removeRecording(item.recording); done++; } else kept++;
    } catch { kept++; }
  }
  if (done) toast(`Recovered ${done} unsaved recording${done > 1 ? 's' : ''} into ${done > 1 ? 'their' : 'its'} session folder.`);
  if (kept) toast(`${kept} recording${kept > 1 ? 's' : ''} couldn\u2019t be recovered automatically \u2014 they\u2019re kept in Settings.`, true);
  showBackups();
}
async function showBackups() {
  let items = []; try { items = await backups(); } catch {}
  $('#recovery').hidden = !items.length; const list = $('#recovery-list'); list.replaceChildren();
  for (const item of items) {
    const li = document.createElement('li'), name = document.createElement('span'), actions = document.createElement('span');
    name.textContent = `${item.recording.slice(0, 8)}\u2026 ${item.name} · ${fmtBytes(item.bytes)}`;
    const get = document.createElement('button'); get.type = 'button'; get.textContent = 'Recover'; get.onclick = () => recover(item);
    const drop = document.createElement('button'); drop.type = 'button'; drop.textContent = 'Discard';
    drop.onclick = async () => { if (confirm(`Permanently discard the browser backup of ${item.name}? Recover it first if you might need it.`)) { await removeRecording(item.recording); showBackups(); } };
    actions.append(get, ' ', drop); li.append(name, actions); list.append(li);
  }
  if (items.length && phase === 'lobby' && !autoRecovered) { autoRecovered = true; autoRecover(items); }
}

// Camera resolution: 1080p (light), or 4K for the raw camera recording. The composed frame stays 1080p either way.
const RES = { '1080p': { constraints: { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 } }, bitrate: 8_000_000 },
  '4k': { constraints: { width: { ideal: 3840, max: 3840 }, height: { ideal: 2160, max: 2160 } }, bitrate: 40_000_000 } };
let cameraRes = RES[store.get('claude-interview.camres')] ? store.get('claude-interview.camres') : '1080p';
async function openDevices() {
  const headphones = $('#chk-headphones').checked, micId = $('#sel-mic').value, camId = $('#sel-cam').value;
  stream?.getTracks().forEach(t => t.stop());
  const processing = !headphones;
  const audio = { ...(micId ? { deviceId: { exact: micId } } : {}), channelCount: 1, echoCancellation: processing, noiseSuppression: processing, autoGainControl: false };
  const videoWanted = camId === 'none' ? false : { ...(camId ? { deviceId: { exact: camId } } : {}), ...RES[cameraRes].constraints, frameRate: { ideal: 30, max: 30 }, resizeMode: 'crop-and-scale' };
  try { stream = await navigator.mediaDevices.getUserMedia({ audio, video: videoWanted }); }
  catch (error) {
    if (!videoWanted) throw error;
    stream = await navigator.mediaDevices.getUserMedia({ audio });   // the camera is optional; carry on with the microphone
    toast(`Camera unavailable (${error.message}) \u2014 continuing with microphone only.`, true);
  }
  const cam = stream.getVideoTracks()[0];
  video.srcObject = cam ? new MediaStream([cam]) : null; stage.cameraOn = Boolean(cam);
  if (cam) await video.play().catch(() => {});
  ctx ||= new AudioContext({ latencyHint: 'interactive' }); ctx.resume().catch(() => {});   // runs fully once Start is clicked
  mic?.stop(); mic = new Mic(ctx, stream); stage.levels.user = () => mic.level();
  broadcast.sourcesChanged();
  await refreshDevices(stream.getAudioTracks()[0]?.getSettings().deviceId, cam?.getSettings().deviceId ?? 'none');
  store.set('claude-interview.devices', { mic: $('#sel-mic').value, camera: $('#sel-cam').value, headphones });
}
// Device menus live in two places (next to Start, and in Settings); both show the same choice.
async function refreshDevices(micId = $('#sel-mic').value, camId = $('#sel-cam').value) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter(d => d.kind === 'audioinput' && d.deviceId), cams = devices.filter(d => d.kind === 'videoinput' && d.deviceId);
  for (const sel of [$('#sel-mic'), $('#quick-mic')]) fill(sel, mics, micId);
  for (const sel of [$('#sel-cam'), $('#quick-cam')]) fill(sel, cams, camId, true);
}
navigator.mediaDevices.addEventListener?.('devicechange', () => { if (phase === 'lobby') refreshDevices().catch(() => {}); });
function fill(select, devices, selected, allowNone) {
  select.replaceChildren(...devices.map((d, i) => new Option((d.label || `Device ${i + 1}`).replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, ''), d.deviceId)));
  if (allowNone) select.append(new Option('No camera', 'none'));
  select.value = selected || select.options[0]?.value || '';
}
async function enableDevices() {
  try { await openDevices(); $('#btn-devices').hidden = true; meterLoop(); return true; }
  catch (error) { $('#btn-devices').hidden = false; openPanel('settings'); toast(`Camera/microphone unavailable: ${error.message}`, true); return false; }
}
$('#btn-devices').onclick = enableDevices;
for (const id of ['#sel-mic', '#sel-cam', '#chk-headphones']) $(id).onchange = () => openDevices().catch(e => toast(e.message, true));
for (const [quick, main] of [['#quick-mic', '#sel-mic'], ['#quick-cam', '#sel-cam']]) $(quick).onchange = () => { $(main).value = $(quick).value; openDevices().catch(e => toast(e.message, true)); };
function meterLoop() { $('#mic-meter').style.width = `${Math.min(100, (mic?.level() || 0) * 900)}%`; if (phase !== 'ended') requestAnimationFrame(meterLoop); }

// Model, thinking level and voice. Models are listed by name; Opus 5.5 is the default.
const MODELS = [['claude-opus-5-5', 'Opus 5.5'], ['claude-fable-5-1', 'Fable 5.1'], ['claude-sonnet-5', 'Sonnet 5'], ['claude-haiku-4-5-20251001', 'Haiku 4.5']];
const modelName = id => MODELS.find(([m]) => id?.startsWith(m))?.[1] || id || '';
const effortName = e => ({ '': 'Default', xhigh: 'X-High' })[e] ?? e[0].toUpperCase() + e.slice(1);
let effort = '';
function fillChoices(status) {
  const prefs = store.get('claude-interview.model') || {};
  $('#sel-model').replaceChildren(...MODELS.map(([id, name]) => new Option(name, id)));
  $('#sel-model').value = MODELS.some(([id]) => id === prefs.model) ? prefs.model : MODELS[0][0];
  const efforts = ['', ...(status.claude_efforts || [])];
  $('#seg-effort').replaceChildren(...efforts.map(e => { const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'radio'); b.textContent = effortName(e); b.dataset.value = e; b.onclick = () => { setEffort(e); saveChoice(); }; return b; }));
  setEffort(prefs.effort || '');
  // Claude's three recommended voices first; the account's cloned voices and paid professional voices are left out.
  const usable = (status.voices || []).filter(v => v.category !== 'professional' && v.category !== 'cloned');
  const rec = (status.recommended_voices || []).map(id => usable.find(v => v.voice_id === id)).filter(Boolean);
  const label = v => v.name.replace(' - ', ' \u2014 ');
  const top = document.createElement('optgroup'); top.label = 'Recommended';
  top.append(...rec.map(v => new Option(label(v), v.voice_id)));
  const rest = document.createElement('optgroup'); rest.label = 'Other voices';
  rest.append(...usable.filter(v => !rec.includes(v)).sort((a, b) => a.name.localeCompare(b.name)).map(v => new Option(label(v), v.voice_id)));
  $('#sel-voice').replaceChildren(top, rest);
  const last = store.get('claude-interview.voice-pick');
  if (usable.some(v => v.voice_id === last)) $('#sel-voice').value = last;
}
// Look (art style) and visuals: both remembered, both changeable during a call.
const VISUALS = [['off', 'Off'], ['useful', 'When useful'], ['always', 'Every reply']];
let visuals = store.get('claude-interview.visuals') || 'useful';
function segment(el, items, current, pick) {
  el.replaceChildren(...items.map(([value, label]) => { const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'radio'); b.textContent = label; b.dataset.value = value; b.onclick = () => pick(value); return b; }));
  for (const b of el.children) b.setAttribute('aria-checked', String(b.dataset.value === current));
}
function setStyle(key, push = true) {
  key = LEGACY_STYLES[key] || key; stage.style = STYLES[key] ? key : 'clawd'; store.set('claude-interview.style', stage.style);
  segment($('#seg-style'), Object.entries(STYLES).map(([k, v]) => [k, v.name]), stage.style, setStyle);
  if (push && phase === 'live') api('config', { style: stage.style }).catch(error => toast(error.message, true));
}
function setVisuals(mode, push = true) {
  visuals = mode; store.set('claude-interview.visuals', mode);
  segment($('#seg-visuals'), VISUALS, mode, setVisuals);
  if (mode === 'off') { dropSceneFrame(); stage.sceneClear(); }
  if (push && phase === 'live') api('config', { visuals: mode }).catch(error => toast(error.message, true));
}
setStyle(store.get('claude-interview.style') || 'clawd', false); setVisuals(visuals, false);

// The user's background: the real camera, a soft blur, or the world of the conversation (the scene on screen,
// or Claude's current look). Segmentation runs locally; the raw camera recording is unchanged.
const BACKGROUNDS = [['off', 'Camera'], ['blur', 'Blur'], ['match', 'Conversation']];
async function setBackground(mode) {
  store.set('claude-interview.bg', mode);
  if (phase === 'live') api('config', { backdrops: mode === 'match' }).catch(() => {});
  segment($('#seg-bg'), BACKGROUNDS, mode, setBackground);
  if (mode === 'off') { stage.background = 'off'; return; }
  try { await (await import('./segment.js')).loadSegmenter(); stage.background = mode; }
  catch (error) { stage.background = 'off'; segment($('#seg-bg'), BACKGROUNDS, 'off', setBackground); toast(`Background replacement unavailable: ${error.message}`, true); }
}
setBackground(store.get('claude-interview.bg') || 'match');   // on by default: the user stands in the conversation's own backdrop
function setResolution(res) {
  if (phase !== 'lobby' && phase !== undefined && res !== cameraRes) { toast('Change camera resolution between calls.'); return; }
  const changed = res !== cameraRes; cameraRes = res; store.set('claude-interview.camres', res);
  segment($('#seg-res'), [['1080p', '1080p'], ['4k', '4K']], res, setResolution);
  for (const b of $('#seg-res').children) b.disabled = phase !== 'lobby';
  if (changed && stream) openDevices().then(() => { const s = stream.getVideoTracks()[0]?.getSettings(); if (s) toast(`Camera: ${s.width}\u00d7${s.height}`); }).catch(e => toast(e.message, true));
}
setResolution(cameraRes);

function setEffort(e) { effort = e; for (const b of $('#seg-effort').children) b.setAttribute('aria-checked', String(b.dataset.value === e)); }
// Model and thinking are remembered, and during a call they apply from the next reply.
async function saveChoice() {
  const model = $('#sel-model').value;
  store.set('claude-interview.model', { model, effort });
  if (phase !== 'live') return;
  try { await api('config', { claude_model: model, claude_effort: effort }); who.model = model; who.effort = effort; showWho(); toast(`${modelName(model)}, thinking ${effortName(effort).toLowerCase()}, from the next reply`); }
  catch (error) { toast(error.message, true); }
}
$('#sel-model').onchange = saveChoice;
$('#sel-voice').addEventListener('change', async () => {
  store.set('claude-interview.voice-pick', $('#sel-voice').value);
  if (phase !== 'live') return;
  try { await api('config', { voice_id: $('#sel-voice').value }); who.voice = $('#sel-voice').selectedOptions[0]?.textContent.split(' \u2014 ')[0] || ''; showWho(); toast(`${who.voice} from the next reply`); }
  catch (error) { toast(error.message, true); }
});
$('#inp-topic').addEventListener('change', async () => {
  if (phase !== 'live') return;
  try { await api('config', { topic: $('#inp-topic').value.trim() }); toast('Topic updated'); } catch (error) { toast(error.message, true); }
});

// Voice samples are ElevenLabs' stock previews, relayed by the backend. They are not v3 conversational output.
const sample = new Audio(); sample.preload = 'none';
sample.onended = sample.onpause = () => $('#btn-sample').classList.remove('playing');
async function playSample() {
  sample.src = `/api/voices/${$('#sel-voice').value}/preview`;
  try { $('#btn-sample').classList.add('playing'); await sample.play(); } catch { $('#btn-sample').classList.remove('playing'); toast('No sample available for this voice.', true); }
}
$('#btn-sample').onclick = () => sample.paused ? playSample() : sample.pause();
$('#sel-voice').addEventListener('change', () => { if (!sample.paused) { sample.pause(); playSample(); } });

function setMirror(value) {
  stage.mirror = value; $('#chk-mirror').checked = value; $('#btn-mirror').setAttribute('aria-pressed', String(value)); store.set('claude-interview.mirror', value);
}
$('#chk-mirror').onchange = () => setMirror($('#chk-mirror').checked);
setMirror(store.get('claude-interview.mirror') === true);

// The person's display name: on the nameplate and transcript, and given to Claude (optional; blank shows "You").
function userName() { return $('#inp-name').value.trim() || 'You'; }
$('#inp-name').value = store.get('claude-interview.name') || ''; stage.userName = userName();
$('#inp-name').oninput = () => { stage.userName = userName(); store.set('claude-interview.name', $('#inp-name').value.trim()); };
$('#inp-name').onchange = () => { if (phase === 'live') api('config', { user_name: $('#inp-name').value.trim() }).catch(error => toast(error.message, true)); };

// ---------- side panels ----------
function openPanel(name) {
  for (const id of ['settings', 'drawer']) $(`#${id}`).hidden = id !== name;
  document.body.classList.toggle('panel-open', Boolean(name));
  $('#btn-settings').setAttribute('aria-pressed', String(name === 'settings')); $('#btn-transcript').setAttribute('aria-pressed', String(name === 'drawer'));
  if (name === 'drawer') scrollTranscript();
  if (name === 'settings') loadPrompt();
  store.set('claude-interview.panel', name === 'settings');
}
const togglePanel = name => openPanel($(`#${name}`).hidden ? name : null);
$('#btn-settings').onclick = () => togglePanel('settings'); $('#btn-settings-close').onclick = () => openPanel(null);

// ---------- Claude's prompt, editable in the Settings panel ----------
let promptSaved = '';
async function loadPrompt() {
  if ($('#prompt-save').disabled === false) return;            // keep unsaved edits
  try { promptSaved = (await request('/api/prompt')).text; $('#prompt-text').value = promptSaved; } catch {}
}
$('#prompt-text').oninput = () => { $('#prompt-save').disabled = $('#prompt-text').value === promptSaved; };
$('#prompt-save').onclick = async () => {
  try { promptSaved = (await request('/api/prompt', { text: $('#prompt-text').value })).text; $('#prompt-save').disabled = true; toast(phase === 'live' ? 'Prompt saved \u2014 applies from the next reply' : 'Prompt saved'); }
  catch (error) { toast(error.message, true); }
};
$('#prompt-reset').onclick = async () => {
  if (!confirm('Replace the prompt with the default?')) return;
  try { promptSaved = (await request('/api/prompt', { reset: true })).text; $('#prompt-text').value = promptSaved; $('#prompt-save').disabled = true; toast('Prompt reset'); } catch (error) { toast(error.message, true); }
};

// ---------- starting a call ----------
$('#btn-start').onclick = async () => {
  if (phase !== 'lobby') return;
  setPhase('starting'); $('#btn-start').disabled = true; $('#btn-start').textContent = 'Connecting\u2026';
  closeSummary(); $('#transcript').replaceChildren(); $('#chip-rec').hidden = true; dropSceneFrame(); stage.sceneClear(); dropBackdropFrame();
  try {
    if (!stream && !(await enableDevices())) throw new Error('Camera and microphone are needed.');
    await ctx.resume();
    player = new Player(ctx, { onComplete: playbackComplete }); stage.levels.claude = () => player.level();
    broadcast.sourcesChanged();
    const model = $('#sel-model').value;
    store.set('claude-interview.model', { model, effort }); store.set('claude-interview.voice-pick', $('#sel-voice').value);
    session = await request('/api/sessions', { user_name: $('#inp-name').value.trim(), topic: $('#inp-topic').value.trim(), voice_id: $('#sel-voice').value, tts_model: 'eleven_v3_conversational', claude_model: model, claude_effort: effort, visuals, style: stage.style, backdrops: store.get('claude-interview.bg') !== 'off' && store.get('claude-interview.bg') !== 'blur' });
    who.model = model; who.effort = effort; who.voice = $('#sel-voice').selectedOptions[0]?.textContent.split(' \u2014 ')[0] || ''; showWho();
    t0 = performance.now();
    await connectEvents();
    await api('listen', { silence: Number($('#sel-silence').value) });
    chip('stt', 'Listening', 'ok');
    uploader = new PcmUploader(bytes => api('input-audio', bytes, 15000), error => fatal(`Microphone audio stopped reaching the backend: ${error.message}`));
    await mic.start(bytes => uploader.push(bytes));
    await startRecorders();
    enterLive();
    if ($('#sel-opener').value === 'claude') await api('turn', { introduction: true, request_id: uuid(), reply_id: uuid(), client_ms: clientMs() });
  } catch (error) {
    toast(`Couldn\u2019t start: ${error.message}`, true);
    if (session) await teardown('start-failed'); else { setPhase('lobby'); $('#btn-start').disabled = false; $('#btn-start').textContent = 'Start'; }
  }
};

function connectEvents() {
  return new Promise((resolve, reject) => {
    es = new EventSource(`/api/sessions/${session.id}/events?controller=1`);
    const timer = setTimeout(() => reject(new Error('The event stream did not connect.')), 10000);
    es.onmessage = m => { let e; try { e = JSON.parse(m.data); } catch { return; } if (e.type === 'connected') { clearTimeout(timer); chip('conn', 'Connected', 'ok'); resolve(); } handle(e); };
    // The backend ends a call when its controller disconnects, so never auto-reconnect into it.
    es.onerror = () => { es.close(); clearTimeout(timer); reject(new Error('The event stream closed.'));
      if (phase === 'live') { connectionLost = true; chip('conn', 'Disconnected', 'bad'); fatal('Lost connection to the backend', true); } };
  });
}

async function startRecorders() {
  const onError = error => { toast(error.message, true); chip('rec', 'Recording problem', 'bad'); };
  const onProgress = p => { recProgress[p.name] = p; };
  const common = { sessionId: session.id, api, clientMs, onError, onProgress };
  const mixed = [];
  const cam = stream.getVideoTracks()[0];
  if (cam && $('#chk-rec-camera').checked) {
    const audio = stream.getAudioTracks()[0].clone(); mixed.push(audio);
    recorders.push(await recordTrack({ ...common, kind: 'user-camera', stream: new MediaStream([cam, audio]), videoBitsPerSecond: RES[cameraRes].bitrate }));
  }
  if ($('#chk-rec-stage').checked) {
    const dest = ctx.createMediaStreamDestination(); mic.mixGain.connect(dest); player.out.connect(dest);
    const frame = $('#stage').captureStream(30);
    recorders.push(await recordTrack({ ...common, kind: 'stage', stream: new MediaStream([...frame.getVideoTracks(), ...dest.stream.getAudioTracks()]) }));
  }
  // Edit-ready lossless stems on one clock: the user's mic (silent while muted) and exactly what Claude played.
  for (const [kind, source] of [['user-voice', mic.mixGain], ['claude-voice', player.out]]) {
    try { recorders.push(await recordPcm({ ...common, kind, ctx, source })); } catch (error) { toast(`${kind} stem not recording: ${error.message}`, true); }
  }
  recorders.cameraAudio = mixed;
}

function enterLive() {
  setPhase('live'); $('#chip-rec').hidden = false;
  addEventListener('beforeunload', guard);
  tick();
}
const guard = e => { if (phase === 'live' || phase === 'ending') { e.preventDefault(); e.returnValue = ''; } };

// ---------- the event contract ----------
function handle(e) {
  switch (e.type) {
    case 'stt-connected': chip('stt', 'Listening', 'ok'); break;
    case 'partial-transcript': lastPartialAt = performance.now(); stage.caption('user', e.text); stage.backchannel(); break;
    case 'user-turn': stage.caption('user', e.turn.text); addLine('user', e.turn.text); break;
    case 'turn-start': {
      // A new reply supersedes any earlier one that is still sounding.
      // (A typed turn does not cancel a reply that finished generating but is still playing, so mark it here.)
      const old = current;
      if (old && !old.stopped && !old.completed) void stopCurrent('superseded').then(() => api('interrupt', { turn_id: old.id, reason: 'superseded' })).catch(() => {});
      current = { id: e.turn_id, speech: '', chars: [], stopped: false, completed: false, error: false, reported: 0 };
      current.el = addLine('claude', ''); player.begin(e.turn_id);
      $('#btn-interrupt').disabled = false; break;
    }
    case 'model': who.model = e.model; showWho(); break;
    case 'voice':
      who.voice = e.voice.name.split(' - ')[0]; $('#chip-voice').title = e.voice.rationale || ''; showWho();
      store.set('claude-interview.voice', { voice_id: e.voice.voice_id, name: e.voice.name });
      break;
    case 'text':
      if (current?.id === e.turn_id && !current.stopped) { current.speech += e.delta; current.el.text.textContent = display(current.speech); scrollTranscript(); }
      break;
    case 'audio':
      // Stale or interrupted replies are dropped; only the live reply is scheduled.
      if (current?.id === e.turn_id && !current.stopped) player.push(e.turn_id, e.audio);
      break;
    case 'alignment':
      if (current?.id === e.turn_id && !current.stopped && e.alignment?.chars) {
        const a = e.alignment;
        a.chars.forEach((ch, i) => current.chars.push({ t: e.offset_seconds + (a.char_start_times_ms?.[i] || 0) / 1000, ch }));
      }
      break;
    case 'turn-done': if (current?.id === e.turn_id) { current.done = true; player.finish(e.turn_id); } break;
    case 'interrupted':
      if (current && !current.stopped && !current.completed && (!e.turn_id || e.turn_id === current.id)) void stopCurrent(e.reason || 'interrupted');
      break;
    case 'scene-base': if (visuals !== 'off') stage.sceneBase(e); break;
    case 'scene-none': stage.sceneClear(); dropSceneFrame(); break;
    case 'scene-ready': if (visuals !== 'off') openSceneFrame(e.scene_id, e.url); break;
    case 'scene-error': stage.sceneDone(e.scene_id); console.warn('Scene not drawn:', e.message); break;
    case 'backdrop-ready': openBackdropFrame(e.backdrop_id, e.url); break;
    case 'backdrop-error': console.warn('Backdrop not drawn:', e.message); break;
    case 'mic-muted': case 'mic-unmuted': setMuted(e.type === 'mic-muted'); break;
    case 'error':
      toast(e.message, true);
      if (current && (!e.turn_id || e.turn_id === current.id) && !current.stopped) { void stopCurrent('error'); current.error = true; meta(current, 'error \u2014 reply incomplete'); }
      break;
    case 'session-ended': if (phase === 'live') { toast(e.reason === 'user-ended' ? 'Call ended' : `Call ended (${e.reason})`); void teardown(e.reason, true); } break;
  }
}

const who = { model: '', voice: '', effort: '' };
function showWho() { const el = $('#chip-voice'); el.textContent = [modelName(who.model), who.effort && `thinking ${effortName(who.effort).toLowerCase()}`, who.voice].filter(Boolean).join(' \u00b7 '); el.hidden = !el.textContent; }

// ---------- bespoke scenes ----------
// Each generated scene runs in a sandboxed iframe (opaque origin, no network) and streams ImageBitmaps back,
// which the stage composites into the recorded frame.
function openSceneFrame(id, url) {
  const f = document.createElement('iframe');
  f.className = 'scene-frame'; f.setAttribute('sandbox', 'allow-scripts'); f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1;
  f.src = url; f.dataset.scene = id;
  document.body.append(f);
  const old = sceneFrame; sceneFrame = f;
  setTimeout(() => old?.remove(), 1500);
}
function dropSceneFrame() { sceneFrame?.remove(); sceneFrame = null; }
// The user's backdrop runs in its own sandboxed frame, independent of the scene on Claude's side.
let backdropFrame = null;
function openBackdropFrame(id, url) {
  const f = document.createElement('iframe');
  f.className = 'scene-frame'; f.setAttribute('sandbox', 'allow-scripts'); f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1; f.src = url; f.dataset.backdrop = id;
  document.body.append(f); const old = backdropFrame; backdropFrame = f; setTimeout(() => old?.remove(), 1500);
}
function dropBackdropFrame() { backdropFrame?.remove(); backdropFrame = null; stage.backdropClear(); }
addEventListener('message', e => {
  if (backdropFrame && e.source === backdropFrame.contentWindow) { if (e.data?.type === 'scene-frame' && e.data.bitmap instanceof ImageBitmap) stage.backdropBitmap(backdropFrame.dataset.backdrop, e.data.bitmap); return; }
  if (!sceneFrame || e.source !== sceneFrame.contentWindow) return;
  const id = sceneFrame.dataset.scene;
  if (e.data?.type === 'scene-frame' && e.data.bitmap instanceof ImageBitmap) stage.sceneBitmap(id, e.data.bitmap);
  else if (e.data?.type === 'scene-error') console.warn('Scene script error:', e.data.message);
});
function toggleVisual() { stage.sceneHidden = !stage.sceneHidden; $('#btn-visual').setAttribute('aria-pressed', String(!stage.sceneHidden)); }

// Mouth shapes from the character being played; a delivery cue changes mood when it is actually heard.
const MOUTH = ch => /[aæ]/.test(ch) ? [0.85, 0] : /[ei]/.test(ch) ? [0.55, 0] : /[ouwy]/.test(ch) ? [0.6, 0.9] : /[mbp]/.test(ch) ? [0, 0.2] : /[fv]/.test(ch) ? [0.15, 0] : /[a-z]/.test(ch) ? [0.3, 0.1] : [0.05, 0];
function animateSpeech(at) {
  let raw = '', last = ' ';
  for (const c of current.chars) { if (c.t > at) break; raw += c.ch; }
  const tags = [...raw.matchAll(/\[([^\]]{1,40})\]/g)];
  if (tags.length > (current.moods || 0)) { current.moods = tags.length; stage.setMood(tags.at(-1)[1].toLowerCase()); }
  const spoken = raw.replace(/\[[^\]]*\]?/g, ''); last = spoken.at(-1)?.toLowerCase() || ' ';
  // a question or exclamation mark that has actually been played shapes the face (unless a cue is active)
  const marks = (spoken.match(/[?!]/g) || []).length;
  if (marks > (current.marks || 0)) { current.marks = marks; if (!stage.mood || performance.now() - stage.mood.at > 1500) stage.setMood(last === '?' ? 'question' : 'exclaim'); }
  const [open, round] = MOUTH(last); stage.mouthTarget = { open, round };
}

// ---------- playback evidence ----------
async function report(type, id, played, extra = {}) {
  try { await api('event', { type, turn_id: id, played_seconds: Math.round(played * 1000) / 1000, source: 'web-audio-clock', output_latency_seconds: ctx.outputLatency || 0, client_ms: clientMs(), ...extra }); }
  catch (error) { if (phase === 'live') toast(`Couldn\u2019t record playback: ${error.message}`, true); }
}
// Stops the live reply locally and records how much of it actually played. Returns after reporting.
async function stopCurrent(reason) {
  const c = current; if (!c || c.stopped || c.completed) return null;
  c.stopped = true; const result = player.stop();
  if (c.chars.length || result?.started || reason !== 'superseded') stage.interrupted();
  meta(c, result?.started ? `interrupted \u2014 heard about ${result.played.toFixed(1)} s` : 'interrupted before speaking');
  $('#btn-interrupt').disabled = true;
  if (result) await report('audio-playback', c.id, result.played, { estimated: true, reason });
  return result;
}
function playbackComplete(id, seconds) {
  if (current?.id !== id) return;
  current.completed = true; $('#btn-interrupt').disabled = true;
  void report('playback-complete', id, seconds, { estimated: false });
}
setInterval(() => {
  // Periodic progress while speaking, so an abrupt end still leaves evidence of what played.
  if (phase !== 'live' || !current || current.stopped || current.completed || !player.started) return;
  const played = player.played(); if (played - current.reported < 0.25) return;
  current.reported = played; void report('audio-playback', current.id, played, { estimated: true, progress: true });
}, 2000);

// ---------- per-frame state (drives the stage from real events) ----------
function tick() {
  if (phase !== 'live' && phase !== 'ending') return;
  const now = performance.now();
  stage.userSpeaking = now - lastPartialAt < 1100;
  if (connectionLost) stage.claude = 'error';
  else if (current && !current.stopped && !current.completed && !current.error) stage.claude = player.started ? 'speaking' : 'thinking';
  else stage.claude = muted ? 'waiting' : 'listening';
  if (current && player.started && !current.stopped) {
    const at = player.position();
    const heard = current.chars.length ? current.chars.filter(c => c.t <= at).map(c => c.ch).join('') : display(current.speech);
    if (current.chars.length) animateSpeech(at); else stage.mouthTarget = { open: Math.min(1, player.level() * 8), round: 0.2 };
    const text = display(heard); if (text !== current.caption) { current.caption = text; stage.caption('claude', text); }
  }
  const secs = (now - t0) / 1000, failed = Object.values(recProgress).some(p => p.failed);

  if (!failed) chip('rec', fmtTime(secs), 'rec');
  requestAnimationFrame(tick);
}
function renderFrame(now) {
  stage.frame(now);
  // drive the bespoke scene one frame per display frame (see sceneFrameHTML in src/director.mjs)
  const env = { type: 'env', env: { level: player ? Math.min(1, player.level() * 6) : 0, speaking: stage.claude === 'speaking' } };
  sceneFrame?.contentWindow?.postMessage(env, '*'); backdropFrame?.contentWindow?.postMessage(env, '*');
}
let lastDraw = 0;
function drawLoop(now) { if (!document.hidden && now - lastDraw >= 1000 / 30 - 1) { lastDraw = now; renderFrame(now); } requestAnimationFrame(drawLoop); }
// Keep the composed feed advancing while the operator checks X in another tab.
setInterval(() => { if (document.hidden && broadcast.active) renderFrame(performance.now()); }, 1000 / 30);
requestAnimationFrame(drawLoop);
document.addEventListener('visibilitychange', () => { if (document.hidden && phase === 'live' && recorders.length) toast('Tab hidden: frame recording paused', true); });

// ---------- controls ----------
function setMuted(value) {
  muted = value; stage.userMuted = value; mic?.setMuted(value);
  for (const t of recorders.cameraAudio || []) t.enabled = !value;
  $('#btn-mute').setAttribute('aria-pressed', String(value)); $('#btn-mute span').textContent = value ? 'Unmute' : 'Mute';
  chip('stt', value ? 'Mic muted' : 'Listening', value ? 'warn' : 'ok');
}
async function toggleMute() {
  if (phase !== 'live') return; const next = !muted; setMuted(next);
  try { await api('mute', { muted: next }); } catch (error) { setMuted(!next); toast(error.message, true); }
}
async function interrupt() {
  if (phase !== 'live' || !current || current.stopped || current.completed) return;
  const id = current.id; await stopCurrent('user-interrupted');       // report playback first, then interrupt
  try { await api('interrupt', { turn_id: id, reason: 'user-interrupted' }); } catch (error) { toast(error.message, true); }
}
async function mark() {
  if (phase !== 'live') return; const at = (performance.now() - t0) / 1000;
  try { await api('event', { type: 'marker', label: 'Keep this moment', client_ms: clientMs() }); addMarker(at); toast('Marked'); }
  catch (error) { toast(error.message, true); }
}
function toggleDrawer(force) { const open = force ?? $('#drawer').hidden; if (open) openPanel('drawer'); else if (!$('#drawer').hidden) openPanel(null); }
function toggleCaptions() { stage.showCaptions = !stage.showCaptions; $('#btn-captions').setAttribute('aria-pressed', String(stage.showCaptions)); store.set('claude-interview.captions', stage.showCaptions); }
function toggleClean(force) { document.body.classList.toggle('clean', force); }

$('#btn-mirror').onclick = () => setMirror(!stage.mirror);
$('#btn-visual').onclick = toggleVisual;
$('#btn-mute').onclick = toggleMute; $('#btn-interrupt').onclick = interrupt; $('#btn-mark').onclick = mark;
$('#btn-transcript').onclick = () => toggleDrawer(); $('#btn-drawer-close').onclick = () => toggleDrawer(false);
$('#btn-captions').onclick = toggleCaptions; $('#btn-clean').onclick = () => toggleClean(true);
$('#btn-end').onclick = () => { if (phase === 'live') void teardown('user-ended'); };
$('#typed').onsubmit = async e => {
  e.preventDefault(); const text = $('#inp-typed').value.trim(); if (!text || phase !== 'live') return;
  $('#inp-typed').value = '';
  try { await api('turn', { text, request_id: uuid(), reply_id: uuid(), client_ms: clientMs() }); } catch (error) { toast(error.message, true); }
};
addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, textarea, select')) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') { toggleClean(false); openPanel(null); return; }
  if (k === 's') { togglePanel('settings'); e.preventDefault(); return; }
  if (phase !== 'live') return;
  if (k === 'm') toggleMute(); else if (k === 'i') interrupt(); else if (k === 'k') mark();
  else if (k === 'v') setMirror(!stage.mirror);
  else if (k === 'x') toggleVisual();
  else if (k === 't') toggleDrawer(); else if (k === 'c') toggleCaptions(); else if (k === 'f') toggleClean();
  else return;
  e.preventDefault();
});
if (store.get('claude-interview.captions') === false) toggleCaptions();

// ---------- transcript drawer ----------
function addLine(who, text) {
  const li = document.createElement('li'); li.className = who;
  const w = document.createElement('span'); w.className = 'who'; w.textContent = who === 'claude' ? 'Claude' : userName();
  const t = document.createElement('span'); t.className = 'text'; t.textContent = text;
  li.append(w, t); $('#transcript').append(li); scrollTranscript(); li.text = t; return li;
}
function meta(c, text) { if (!c?.el) return; let m = c.el.querySelector('.meta'); if (!m) { m = document.createElement('span'); m.className = 'meta'; c.el.append(m); } m.textContent = text; }
function addMarker(at) { const li = document.createElement('li'); li.className = 'marker'; li.textContent = `◆ ${fmtTime(at)}`; $('#transcript').append(li); scrollTranscript(); }
function addNote(text) { const li = document.createElement('li'); li.className = 'marker'; li.textContent = text; $('#transcript').append(li); scrollTranscript(); }
function scrollTranscript() { const t = $('#transcript'); t.scrollTop = t.scrollHeight; }

// ---------- ending and saving ----------
function fatal(message) { toast(message, true); if (phase === 'live') void teardown('client-error', connectionLost); }

async function teardown(reason, serverEnded = false) {
  if (phase === 'ending' || phase === 'ended' || !session) return;
  setPhase('ending'); $('#controls').querySelectorAll('button').forEach(b => b.disabled = true);
  chip('rec', 'Saving\u2026', 'warn');
  mic?.stop(); await uploader?.close().catch(() => {});
  await stopCurrent('call-ended');
  if (!serverEnded) { try { await api('end', {}); } catch (error) { toast(`End: ${error.message}`, true); } }
  stage.claude = connectionLost ? 'error' : 'ended';
  const saved = [], problems = [];
  for (const r of recorders) { try { saved.push(await r.stop()); } catch (error) { problems.push(`${r.name}: ${error.message}`); } }
  es?.close(); removeEventListener('beforeunload', guard);
  stream?.getTracks().forEach(t => t.stop()); stage.cameraOn = false;
  $('#chip-stt').hidden = true;
  chip('rec', problems.length ? 'Needs recovery' : 'Saved', problems.length ? 'bad' : 'ok');
  await showSummary(problems);
  readyForNextCall();
}

async function showSummary(problems) {
  let s = null; try { s = await api('', undefined); } catch {}
  $('#summary').hidden = false;
  const claude = (s?.turns || []).filter(t => t.speaker === 'claude');

  $('#summary-lede').textContent = s ? s.recording_directory : 'Backend unreachable. Unsaved recordings can be recovered in Settings.';
  const list = $('#summary-files'); list.replaceChildren();
  const row = (name, detail, ok) => { const li = document.createElement('li'), a = document.createElement('span'), b = document.createElement('span'); a.textContent = name; b.textContent = detail; b.className = ok ? 'ok' : 'bad'; li.append(a, b); list.append(li); };
  for (const [name, m] of Object.entries(s?.media || {})) row(name, m.complete ? 'saved' : 'incomplete', m.complete);
  const replies = claude.filter(t => t.audio_file);
  if (replies.length) row(`claude-*.wav × ${replies.length}`, 'saved', true);
  for (const p of problems) row('browser recording', p, false);
  $('#summary-cmd').textContent = s ? `./interview review ${s.id}` : '';
  showBackups();
}
$('#btn-copy').onclick = async () => { try { await navigator.clipboard.writeText($('#summary-cmd').textContent); toast('Copied'); } catch { toast('Copy failed \u2014 select the text instead.', true); } };
// Back to the ready room with the same settings; the summary card stays until dismissed or the next Start.
function readyForNextCall() {
  session = null; es = null; current = null; uploader = null; recorders = []; recProgress = {};
  connectionLost = false; lastPartialAt = -1e9; setMuted(false); $('#chip-stt').hidden = true;
  for (const b of $('#controls').querySelectorAll('button')) b.disabled = b.id === 'btn-interrupt';
  $('#btn-start').textContent = 'Start'; setPhase('lobby');
  stream = null; enableDevices();
  loadStatus();
}
const closeSummary = () => { $('#summary').hidden = true; };
$('#btn-again').onclick = closeSummary; $('#btn-summary-close').onclick = closeSummary;

// Read-only inspection hook for rehearsals (open the page with #debug). No credentials exist on this page.
if (location.hash === '#debug') window.__interview = { get phase() { return phase; }, get session() { return session; }, get current() { return current; }, get player() { return player; }, stage, openSceneFrame };

setPhase('lobby');
if (store.get('claude-interview.panel') !== false) openPanel('settings');
loadStatus().then(async () => {
  const devices = store.get('claude-interview.devices');
  // Retain the selected input and headphone processing across reloads. With no saved
  // choice the first camera is used, since the room is built around it ("No camera" is remembered).
  $('#chk-headphones').checked = devices?.headphones === true;
  // Before permission is granted the device list is empty, so only preselect when there is a saved choice.
  if (devices) await refreshDevices(devices.mic, devices.camera);
  await enableDevices();
}); showBackups();
