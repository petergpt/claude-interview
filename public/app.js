// Speaking to AIs \u2014 browser room. The backend owns credentials, recognition, turn detection and
// Claude/voice generation. This page captures, plays, reports playback evidence and records.
import { AGENTS, agentById, selectedAgents } from './participants.js';
import { defaultMix } from './audio-mix.js';
import { mountParticipantControls } from './participant-ui.js';
import { Stage } from './stage.js';
import { Broadcast } from './broadcast.js';
import { STYLES, LEGACY_STYLES } from './styles.js';
import { feelingSpoken, feelingHeard } from './emotion.js';
import { Mic, PcmUploader, Player, voiceStrip } from './audio.js';
import { recordTrack, recordPcm, backups, recover, removeRecording, backupBlob } from './recording.js';

const $ = s => document.querySelector(s);
mountParticipantControls();
let audioMix = defaultMix();
const reportedModels = {};
const video = $('#camera');
const stage = new Stage($('#stage'), video);
// Claude notices the cursor outside a turn (its eyes follow it), and a click on Claude is a friendly poke.
{
  const el = $('#stage'), at = e => { const r = el.getBoundingClientRect(); return [(e.clientX - r.left) * el.width / r.width, (e.clientY - r.top) * el.height / r.height]; };
  el.addEventListener('pointermove', e => { const [x, y] = at(e); stage.pointer = { x, y, at: performance.now() }; });
  el.addEventListener('pointerleave', () => { stage.pointer = null; });
  el.addEventListener('click', e => { const [x, y] = at(e); if (stage.hitClaude(x, y)) stage.poke(); else if (stage.hitCodex(x, y)) stage.pokeCodex(); });
}
const uuid = () => crypto.randomUUID();
const display = speech => speech.replace(/\[[^\]\n]{0,80}\]/g, '').replace(/\[[^\]]*$/, '').replace(/\s+/g, ' ').trim();
const fmtBytes = n => n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`;
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

let codexBackdropFrame = null, oldCodexBackdropFrame = null;
let conversationContinues = false;
let phase = 'lobby';          // lobby | starting | live | ending | ended
let status = null, session = null, es = null, ctx = null, stream = null, mic = null, uploader = null, player = null;
let recorders = [], recProgress = {}, t0 = 0, muted = false, connectionLost = false, lastPartialAt = -1e9;
let sceneFrame = null, oldSceneFrame = null;   // sandboxed iframes: the newest bespoke scene, and the one still on screen
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
function setPhase(p) { phase = p; document.body.dataset.phase = p; for (const el of document.querySelectorAll('.precall')) el.disabled = p !== 'lobby'; updateParticipantControls(); }

async function loadStatus() {
  const box = $('#lobby-status');
  const problem = html => { box.hidden = false; box.className = 'status bad'; box.innerHTML = html; openPanel('settings'); };
  try {
    status = await request('/api/status');
    fillChoices(status);
    applyAudioMix(status.audio_mix || defaultMix());
    if (status.active_session) {
      problem('Another call is still open. <button type="button" class="small" id="btn-end-other">End it</button>'); chip('conn', 'Busy', 'warn');
      $('#btn-end-other').onclick = async () => { try { await request(`/api/sessions/${status.active_session}/end`, {}); await loadStatus(); } catch (error) { toast(error.message, true); } };
    }
    else updateReadiness();
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
  const audio = micId === 'none' ? false : { ...(micId ? { deviceId: { exact: micId } } : {}), channelCount: 1, echoCancellation: processing, noiseSuppression: processing, autoGainControl: false };
  const videoWanted = camId === 'none' ? false : { ...(camId ? { deviceId: { exact: camId } } : {}), ...RES[cameraRes].constraints, frameRate: { ideal: 30, max: 30 }, resizeMode: 'crop-and-scale' };
  try { stream = !audio && !videoWanted ? new MediaStream() : await navigator.mediaDevices.getUserMedia({ audio, video: videoWanted }); }
  catch (error) {
    if (!videoWanted) throw error;
    stream = audio ? await navigator.mediaDevices.getUserMedia({ audio }) : new MediaStream();   // the camera is optional; carry on with the microphone
    toast(`Camera unavailable (${error.message}) \u2014 continuing with microphone only.`, true);
  }
  const cam = stream.getVideoTracks()[0];
  video.srcObject = cam ? new MediaStream([cam]) : null; stage.cameraOn = Boolean(cam);
  if (cam) await video.play().catch(() => {});
  ctx ||= new AudioContext({ latencyHint: 'interactive' }); ctx.resume().catch(() => {});   // runs fully once Start is clicked
  mic?.stop(); mic = stream.getAudioTracks().length ? new Mic(ctx, stream, { gainDb: audioMix.user }) : null; stage.levels.user = () => mic?.level() || 0;
  broadcast.sourcesChanged();
  await refreshDevices(stream.getAudioTracks()[0]?.getSettings().deviceId ?? 'none', cam?.getSettings().deviceId ?? 'none');
  store.set('claude-interview.devices', { mic: $('#sel-mic').value, camera: $('#sel-cam').value, headphones });
}
// Device menus live in two places (next to Start, and in Settings); both show the same choice.
async function refreshDevices(micId = $('#sel-mic').value, camId = $('#sel-cam').value) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter(d => d.kind === 'audioinput' && d.deviceId), cams = devices.filter(d => d.kind === 'videoinput' && d.deviceId);
  for (const sel of [$('#sel-mic'), $('#quick-mic')]) fill(sel, mics, micId, 'No microphone · type instead');
  for (const sel of [$('#sel-cam'), $('#quick-cam')]) fill(sel, cams, camId, 'No camera');
}
navigator.mediaDevices.addEventListener?.('devicechange', () => { if (phase === 'lobby') refreshDevices().catch(() => {}); });
function fill(select, devices, selected, allowNone) {
  select.replaceChildren(...devices.map((d, i) => new Option((d.label || `Device ${i + 1}`).replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, ''), d.deviceId)));
  if (!devices.length) select.append(new Option(allowNone?.startsWith('No microphone') ? 'Default microphone' : 'Default camera', ''));
  if (allowNone) select.append(new Option(allowNone, 'none'));
  select.value = selected || select.options[0]?.value || '';
}
async function enableDevices() {
  try { await openDevices(); $('#btn-devices').hidden = true; meterLoop(); return true; }
  catch (error) { await refreshDevices().catch(() => {}); $('#btn-devices').hidden = false; openPanel('settings'); toast(`Camera/microphone unavailable: ${error.message}`, true); return false; }
}
$('#btn-devices').onclick = enableDevices;
async function changeDevices() {
  if (stream?.getTracks().some(t => t.readyState === 'live')) return openDevices();
  store.set('claude-interview.devices', { mic: $('#sel-mic').value, camera: $('#sel-cam').value, headphones: $('#chk-headphones').checked });
  await refreshDevices();
}
for (const id of ['#sel-mic', '#sel-cam', '#chk-headphones']) $(id).onchange = () => changeDevices().catch(e => toast(e.message, true));
for (const [quick, main] of [['#quick-mic', '#sel-mic'], ['#quick-cam', '#sel-cam']]) $(quick).onchange = () => { $(main).value = $(quick).value; changeDevices().catch(e => toast(e.message, true)); };
function meterLoop() { $('#mic-meter').style.width = `${Math.min(100, (mic?.level() || 0) * 900)}%`; if (phase !== 'ended') requestAnimationFrame(meterLoop); }

// Model, thinking level and voice. Models are listed by name; Opus 5.5 is the default.
const MODELS = [['claude-opus-5-5', 'Opus 5.5'], ['claude-fable-5-1', 'Fable 5.1'], ['claude-sonnet-5', 'Sonnet 5'], ['claude-haiku-4-5-20251001', 'Haiku 4.5']];
const modelName = id => MODELS.find(([m]) => id?.startsWith(m))?.[1] || status?.codex?.models?.find(model => model.id === id)?.name || id || '';
const effortName = e => ({ '': 'Default', xhigh: 'X-High' })[e] ?? e[0].toUpperCase() + e.slice(1);
let effort = '';
function fillChoices(status) {
  const prefs = agentChoices.claude;
  $('#sel-model').replaceChildren(...MODELS.map(([id, name]) => new Option(name, id)));
  $('#sel-model').value = MODELS.some(([id]) => id === prefs.model) ? prefs.model : MODELS[0][0];
  const efforts = ['', ...(status.claude_efforts || [])];
  $('#sel-effort').replaceChildren(...efforts.map(e => new Option(effortName(e), e)));
  setEffort(prefs.effort || '');
  fillCodex(status);
  // Claude's three recommended voices first; the account's cloned voices and paid professional voices are left out.
  const usable = (status.voices || []).filter(v => v.category !== 'professional' && v.category !== 'cloned');
  const rec = (status.recommended_voices || []).map(id => usable.find(v => v.voice_id === id)).filter(Boolean);
  const label = v => v.name.replace(' - ', ' \u2014 ');
  const top = document.createElement('optgroup'); top.label = 'Recommended';
  top.append(...rec.map(v => new Option(label(v), v.voice_id)));
  const rest = document.createElement('optgroup'); rest.label = 'Other voices';
  rest.append(...usable.filter(v => !rec.includes(v)).sort((a, b) => a.name.localeCompare(b.name)).map(v => new Option(label(v), v.voice_id)));
  $('#sel-voice').replaceChildren(top, rest);
  const last = agentChoices.claude.voice;
  if (usable.some(v => v.voice_id === last)) $('#sel-voice').value = last;
  Object.assign(agentChoices.claude, { model: $('#sel-model').value, effort, voice: $('#sel-voice').value });
  showWho();
}
// Codex owns its subscription login in the backend; the room only sees readiness and choices.
let choicesBusy = false;
const savedAgents = store.get('claude-interview.agents') || {};
const agentChoices = Object.fromEntries(AGENTS.map(agent => [agent.id, { enabled: false, ...savedAgents[agent.id] }]));
Object.assign(agentChoices.claude, { enabled: store.get('claude-interview.claude-enabled') !== false, ...(store.get('claude-interview.model') || {}), voice: store.get('claude-interview.voice-pick'), ...savedAgents.claude });
Object.assign(agentChoices.codex, { model: 'gpt-6-astra', effort: 'low', ...(store.get('claude-interview.codex') || {}), ...savedAgents.codex });
const participantPayload = () => Object.fromEntries(AGENTS.flatMap(agent => Object.entries(agent.fields).map(([key, field]) => [field, agentChoices[agent.id][key]])));
function fillCodex(status) {
  const models = status.codex?.models || [{ id: 'gpt-6-astra', name: 'GPT-6 Astra', efforts: ['low'] }];
  const labels = m => m.name.replace(/^GPT-6[- ]/i, '').replace(/-/g, ' ');
  $('#sel-codex-model').replaceChildren(...models.map(m => new Option(labels(m), m.id)));
  if (!models.some(m => m.id === agentChoices.codex.model)) $('#sel-codex-model').append(new Option(`${agentChoices.codex.model} (unavailable)`, agentChoices.codex.model));
  $('#sel-codex-model').value = agentChoices.codex.model;
  fillCodexEfforts();
  const voices = (status.voices || []).filter(v => !['professional', 'cloned'].includes(v.category));
  $('#sel-codex-voice').replaceChildren(...voices.map(v => new Option(v.name.replace(' - ', ' — '), v.voice_id)));
  agentChoices.codex.voice ||= status.recommended_voices?.[1] || voices[1]?.voice_id || voices[0]?.voice_id;
  if (!voices.some(v => v.voice_id === agentChoices.codex.voice) && agentChoices.codex.voice) $('#sel-codex-voice').append(new Option('Previous voice (unavailable)', agentChoices.codex.voice));
  $('#sel-codex-voice').value = agentChoices.codex.voice || '';
  const ready = status.codex?.ready;
  $('#codex-status').className = `connection-note ${ready ? 'ready' : 'bad'}`;
  $('#codex-status').textContent = ready ? '● ChatGPT subscription connected' : status.codex?.error || 'Run codex login, then reload to connect your subscription.';
  showParticipants();
}
function fillCodexEfforts() {
  const efforts = status?.codex?.models?.find(m => m.id === agentChoices.codex.model)?.efforts || ['low'];
  $('#sel-codex-effort').replaceChildren(...efforts.map(e => new Option(effortName(e), e)));
  if (!efforts.includes(agentChoices.codex.effort)) agentChoices.codex.effort = 'low';
  $('#sel-codex-effort').value = agentChoices.codex.effort;
}
function updateReadiness() {
  if (phase !== 'lobby' || !status) return;
  const box = $('#lobby-status'), count = selectedAgents(participantPayload()).length;
  let problem = '';
  if (!count) problem = 'Choose a participant to start the conversation.';
  else if (agentChoices.claude.enabled && !status.claude?.ready) problem = status.claude?.mode === 'api' ? 'Claude needs ANTHROPIC_API_KEY in the backend environment.' : 'Claude isn’t connected. Run ./interview login, or choose another participant.';
  else if (agentChoices.codex.enabled && !status.codex?.ready) problem = 'Astra isn’t connected. Run codex login, or choose another participant.';
  else if (!status.elevenlabs_key_set) problem = 'Set up the voice service with ./interview key set, then reload.';
  else if (!status.voices?.length) problem = 'The voice catalogue is unavailable. Reload to try again.';
  if (!status.active_session) {
    box.textContent = problem; box.hidden = !problem; box.className = 'status';
    chip('conn', !count ? 'Choose participants' : problem ? 'Setup needed' : 'Ready', problem ? 'warn' : 'ok');
  }
  $('#btn-start').disabled = Boolean(problem || status.active_session);
  stage.claude = status.claude?.ready ? 'ready' : 'offline';
  stage.codex = status.codex?.ready ? 'ready' : 'offline';
}
function updateParticipantControls() {
  const busy = choicesBusy || ['starting', 'ending'].includes(phase);
  for (const id of ['#btn-participants', '#btn-choose-participants', ...AGENTS.flatMap(a => [a.controls.model, a.controls.effort, a.controls.voice].map(id => '#' + id))]) $(id).disabled = busy;
  const count = selectedAgents(participantPayload()).length;
  for (const [speaker, selected] of AGENTS.map(a => [a.id, Boolean(participantPayload()[a.fields.enabled])])) {
    $('#participant-' + speaker).disabled = busy || (!selected && !status?.[speaker]?.ready) || (phase === 'live' && selected && count === 1);
  }
}
function showParticipants() {
  stage.agentIds = selectedAgents(participantPayload()).map(a => a.id);
  if (!agentChoices.claude.enabled) { dropSceneFrame(); stage.sceneClear(); dropBackdropFrame(); }
  if (!agentChoices.codex.enabled) dropCodexBackdropFrame();
  stage.codexModel = (status?.codex?.models?.find(m => m.id === agentChoices.codex.model)?.name || agentChoices.codex.model).replace(/^GPT-6[- ]/i, '');
  stage.codexEffort = effortName(agentChoices.codex.effort);
  const count = selectedAgents(participantPayload()).length;
  $('#participant-count').textContent = count;
  $('#participant-count').title = `${count} agent${count === 1 ? '' : 's'} selected`;
  for (const [speaker, selected] of AGENTS.map(a => [a.id, Boolean(participantPayload()[a.fields.enabled])])) {
    $('#participant-' + speaker).checked = selected;
    $('#participant-' + speaker + '-status').textContent = !status ? 'Checking…' : status[speaker]?.ready ? 'Available' : 'Not connected';
    const badge = $('#' + speaker + '-membership'); badge.textContent = selected ? 'Selected' : 'Not selected'; badge.dataset.selected = selected;
    $('#sel-opener option[value=' + speaker + ']').disabled = !selected;
  }
  const connection = $('#claude-status'); connection.className = `connection-note ${status?.claude?.ready ? 'ready' : 'bad'}`;
  connection.textContent = status?.claude?.ready ? `● ${status.claude.mode === 'api' ? 'Claude API' : 'Claude subscription'} connected` : 'Run ./interview login, then reload to connect Claude.';
  const opener = $('#sel-opener');
  if (opener.selectedOptions[0]?.disabled) opener.value = selectedAgents(participantPayload())[0]?.id || 'user';
  $('#stage').setAttribute('aria-label', `Conversation stage: you, ${selectedAgents(participantPayload()).map(a => a.name).join(', ')}`);
  updateParticipantControls(); updateReadiness();
  showWho();
  for (const a of AGENTS) $(`[data-level=${a.id}]`).hidden = !participantPayload()[a.fields.enabled];
}
function openParticipants(open = true, restoreFocus = false) {
  $('#participants-picker').hidden = !open;
  $('#btn-participants').setAttribute('aria-expanded', String(open));
  if (open) $('#participants-picker').querySelector('input:not(:disabled)')?.focus();
  else if (restoreFocus) $('#btn-participants').focus();
}
async function changeAgent(id, patch) {
  if (choicesBusy || ['starting', 'ending'].includes(phase)) return;
  const agent = agentById(id), previous = { ...agentChoices[id] }, next = { ...previous, ...patch };
  if (phase === 'live' && !next.enabled && !AGENTS.some(a => a.id !== id && agentChoices[a.id].enabled)) { showParticipants(); return; }
  choicesBusy = true; updateParticipantControls();
  try {
    if (next.enabled && !previous.enabled && !status?.[agent.provider]?.ready) throw new Error(`${agent.name} is not connected.`);
    if (phase === 'live') await api('config', Object.fromEntries(Object.entries(patch).map(([key, value]) => [agent.fields[key], value])));
    agentChoices[id] = next;
    store.set('claude-interview.agents', agentChoices);
    if (phase === 'live' && next.enabled !== previous.enabled) addNote(`${agent.name} ${next.enabled ? 'joined' : 'left'} the conversation`);
  } catch (error) { agentChoices[id] = previous; toast(error.message, true); }
  finally { choicesBusy = false; fillCodex(status); showParticipants(); }
}
function changeCodex(patch) {
  const next = { ...agentChoices.codex, ...patch };
  if (patch.model) delete reportedModels.codex;
  const efforts = status?.codex?.models?.find(m => m.id === next.model)?.efforts || ['low'];
  if (!efforts.includes(next.effort)) next.effort = efforts.includes('low') ? 'low' : efforts[0];
  return changeAgent('codex', next);
}
for (const agent of AGENTS) $(`#participant-${agent.id}`).onchange = e => changeAgent(agent.id, { enabled: e.target.checked });
$('#btn-participants').onclick = () => openParticipants($('#participants-picker').hidden);
$('#btn-participants-close').onclick = () => openParticipants(false, true);
$('#btn-choose-participants').onclick = () => { openPanel(null); openParticipants(); };
$('#btn-participants-settings').onclick = () => { openParticipants(false); openPanel('settings'); settingsTab('agents'); $('#tab-agents').focus(); };
document.addEventListener('pointerdown', e => { if (!e.target.closest('.participants-control')) openParticipants(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#participants-picker').hidden) { e.stopImmediatePropagation(); openParticipants(false, true); } });
$('#sel-codex-model').onchange = () => changeCodex({ model: $('#sel-codex-model').value });
$('#sel-codex-effort').onchange = () => changeCodex({ effort: $('#sel-codex-effort').value });
$('#sel-codex-voice').onchange = () => changeCodex({ voice: $('#sel-codex-voice').value });

// Look (art style) and visuals: both remembered, both changeable during a call.
const VISUALS = [['off', 'Off'], ['useful', 'When useful'], ['always', 'Every reply']];
let visuals = store.get('claude-interview.visuals') || 'useful';
function segment(el, items, current, pick) {
  el.replaceChildren(...items.map(([value, label]) => { const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'radio'); b.textContent = label; b.dataset.value = value; b.onclick = () => pick(value); return b; }));
  for (const b of el.children) b.setAttribute('aria-checked', String(b.dataset.value === current));
}
function setStyle(key, push = true) {
  key = LEGACY_STYLES[key] || key; stage.style = STYLES[key] ? key : 'cafe'; store.set('claude-interview.style', stage.style);
  segment($('#seg-style'), Object.entries(STYLES).map(([k, v]) => [k, v.name]), stage.style, setStyle);
  if (push && phase === 'live') api('config', { style: stage.style }).catch(error => toast(error.message, true));
}
function setVisuals(mode, push = true) {
  visuals = mode; store.set('claude-interview.visuals', mode);
  segment($('#seg-visuals'), VISUALS, mode, setVisuals);
  if (mode === 'off') { dropSceneFrame(); stage.sceneClear(); dropCodexBackdropFrame(); }
  if (push && phase === 'live') api('config', { visuals: mode }).catch(error => toast(error.message, true));
}
setStyle(store.get('claude-interview.style') || 'cafe', false); setVisuals(visuals, false);   // Café is the default look

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
setBackground(store.get('claude-interview.bg') || 'off');   // camera first; effects are optional
function setResolution(res) {
  if (phase !== 'lobby' && phase !== undefined && res !== cameraRes) { toast('Change camera resolution between calls.'); return; }
  const changed = res !== cameraRes; cameraRes = res; store.set('claude-interview.camres', res);
  segment($('#seg-res'), [['1080p', '1080p'], ['4k', '4K']], res, setResolution);
  for (const b of $('#seg-res').children) b.disabled = phase !== 'lobby';
  if (changed && stream) openDevices().then(() => { const s = stream.getVideoTracks()[0]?.getSettings(); if (s) toast(`Camera: ${s.width}\u00d7${s.height}`); }).catch(e => toast(e.message, true));
}
setResolution(cameraRes);

function setEffort(e) { effort = e; $('#sel-effort').value = e; }
$('#sel-effort').onchange = () => { setEffort($('#sel-effort').value); saveChoice(); };
// Model and thinking are remembered, and during a call they apply from the next reply.
async function saveChoice() {
  delete reportedModels.claude;
  await changeAgent('claude', { model: $('#sel-model').value, effort });
  $('#sel-model').value = agentChoices.claude.model; setEffort(agentChoices.claude.effort); showWho();
}
$('#sel-model').onchange = saveChoice;
$('#sel-voice').addEventListener('change', async () => {
  await changeAgent('claude', { voice: $('#sel-voice').value });
  $('#sel-voice').value = agentChoices.claude.voice; showWho();
});
$('#inp-topic').addEventListener('change', async () => {
  if (phase !== 'live') return;
  try { await api('config', { topic: $('#inp-topic').value.trim() }); toast('Topic updated'); } catch (error) { toast(error.message, true); }
});

// Voice samples are ElevenLabs' stock previews, relayed by the backend. They are not v3 conversational output.
const sample = new Audio(); sample.preload = 'none';
sample.onended = sample.onpause = () => $('#btn-sample').classList.remove('playing');
async function playSample() {
  codexSample.pause(); sample.src = `/api/voices/${$('#sel-voice').value}/preview`;
  try { $('#btn-sample').classList.add('playing'); await sample.play(); } catch { $('#btn-sample').classList.remove('playing'); toast('No sample available for this voice.', true); }
}
$('#btn-sample').onclick = () => sample.paused ? playSample() : sample.pause();
$('#sel-voice').addEventListener('change', () => { if (!sample.paused) { sample.pause(); playSample(); } });
const codexSample = new Audio();
codexSample.onended = codexSample.onpause = () => $('#btn-codex-sample').classList.remove('playing');
$('#btn-codex-sample').onclick = async () => {
  if (!codexSample.paused) return codexSample.pause();
  sample.pause(); codexSample.src = `/api/voices/${$('#sel-codex-voice').value}/preview`;
  try { $('#btn-codex-sample').classList.add('playing'); await codexSample.play(); } catch { $('#btn-codex-sample').classList.remove('playing'); toast('No sample available for this voice.', true); }
};

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

// Share just the call canvas, or the raw unmirrored camera; never the browser/desktop.
const VISION = [['off', 'Off'], ['still', 'Still'], ['few', 'Few'], ['more', 'More'], ['live', 'Live']];
const VISION_HINT = { off: 'No images are shared.', still: 'One current still per reply. A good default for conversation.',
  few: 'A few stills across your turn, so gestures have context.', more: 'Up to 8 stills, including reactions during replies.',
  live: 'Up to 40 stills per reply. More detail, with longer waits; this is still not continuous vision.' };
let vision = VISION.some(([v]) => v === store.get('claude-interview.vision-level')) ? store.get('claude-interview.vision-level') : store.get('claude-interview.vision') === false ? 'off' : 'still';
let visionSource = store.get('claude-interview.vision-source') === 'camera' ? 'camera' : 'room';
$('#sel-vision-source').value = visionSource;
$('#sel-vision-source').onchange = async () => {
  visionSource = $('#sel-vision-source').value; store.set('claude-interview.vision-source', visionSource);
  if (phase === 'live') try { await api('config', {vision_source: visionSource}); await sendVisionFrame(); } catch(error) { toast(error.message, true); }
};
function setVision(level, push = true) {
  vision = level; store.set('claude-interview.vision-level', level);
  segment($('#seg-vision'), VISION, level, setVision); $('#vision-hint').textContent = VISION_HINT[level];
  $('#sel-vision-source').disabled = level === 'off';
  if (push && phase === 'live') api('config', { vision_level: level }).catch(error => toast(error.message, true));
}
setVision(vision, false);
const visionGrab = document.createElement('canvas'); let visionSending;
function sendVisionFrame() {
  if (visionSending) return visionSending;
  if (phase !== 'live' || !session || vision === 'off') return Promise.resolve();
  const room = visionSource === 'room', source = visionSource, id = session.id;
  if (!room && (!stage.cameraOn || video.readyState < 2 || !video.videoWidth)) return Promise.resolve();
  const input = room ? $('#stage') : video;
  visionGrab.width = room ? (vision === 'live' ? 960 : 1280) : (vision === 'live' ? 512 : 768);
  visionGrab.height = Math.round(visionGrab.width * (room ? 1080 / 1920 : video.videoHeight / video.videoWidth));
  visionGrab.getContext('2d').drawImage(input, 0, 0, visionGrab.width, visionGrab.height);
  visionSending = new Promise(resolve => visionGrab.toBlob(resolve, 'image/jpeg', .78))
    .then(blob => blob && phase === 'live' && session?.id === id && vision !== 'off' && visionSource === source
      ? request(`/api/sessions/${id}/frame?source=${source}`, blob, 5000) : null)
    .catch(() => {}).finally(() => { visionSending = null; });
  return visionSending;
}
setInterval(sendVisionFrame, 1000);

// ---------- side panels ----------
function settingsTab(name) {
  if (!['agents', 'room', 'streaming'].includes(name)) name = 'agents';
  for (const tab of document.querySelectorAll('[data-tab]')) { const on = tab.dataset.tab === name; tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1; }
  for (const page of document.querySelectorAll('.settings-page')) page.hidden = page.id !== `settings-${name}`;
  store.set('claude-interview.settings-tab', name);
}
for (const tab of document.querySelectorAll('[data-tab]')) {
  tab.onclick = () => settingsTab(tab.dataset.tab);
  tab.onkeydown = e => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return; e.preventDefault(); const tabs = [...document.querySelectorAll('[data-tab]')], i = tabs.indexOf(tab), next = e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (i + (e.key === 'ArrowRight' ? 1 : 2)) % 3; settingsTab(tabs[next].dataset.tab); tabs[next].focus(); };
}
settingsTab(store.get('claude-interview.settings-tab') || 'agents');
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

// Every participant has a separate editable prompt. Unsaved edits survive opening settings.
const promptSaved = new Map();
async function loadPrompt() {
  await Promise.all(AGENTS.map(async agent => {
    const save = $(`#prompt-${agent.id}-save`), input = $(`#prompt-${agent.id}-text`);
    if (!save.disabled) return;
    try { const { text } = await request(`/api/agents/${agent.id}/prompt`); promptSaved.set(agent.id, text); input.value = text; }
    catch (error) { toast(error.message, true); }
  }));
}
for (const agent of AGENTS) {
  const input = $(`#prompt-${agent.id}-text`), save = $(`#prompt-${agent.id}-save`);
  input.oninput = () => { save.disabled = input.value === promptSaved.get(agent.id); };
  const persist = async data => {
    try { const { text } = await request(`/api/agents/${agent.id}/prompt`, data); promptSaved.set(agent.id, text); input.value = text; save.disabled = true; toast(`${agent.name} prompt saved${phase === 'live' ? ' · next reply' : ''}`); }
    catch (error) { toast(error.message, true); }
  };
  save.onclick = () => persist({ text: input.value });
  $(`#prompt-${agent.id}-reset`).onclick = () => { if (confirm(`Reset ${agent.name}’s prompt?`)) void persist({ reset: true }); };
}
function applyAudioMix(mix) {
  audioMix = { ...audioMix, ...mix };
  mic?.setGainDb(audioMix.user);
  for (const agent of AGENTS) player?.setGainDb(agent.id, audioMix[agent.id]);
  for (const [id, db] of Object.entries(audioMix)) {
    $(`#level-${id}`).value = db; $(`#level-${id}-value`).value = `${db > 0 ? '+' : ''}${db} dB`;
  }
}
let mixWrites = Promise.resolve();
for (const id of Object.keys(audioMix)) {
  $(`#level-${id}`).oninput = e => applyAudioMix({ [id]: Number(e.target.value) });
  $(`#level-${id}`).onchange = () => {
    const patch = { [id]: audioMix[id] };
    mixWrites = mixWrites.then(() => request('/api/audio-mix', patch)).catch(error => toast(`Audio level was not saved: ${error.message}`, true));
  };
}

// ---------- starting a call ----------
$('#btn-start').onclick = async () => {
  if (phase !== 'lobby' || $('#btn-start').disabled || choicesBusy) return;
  openParticipants(false);
  setPhase('starting'); $('#btn-start').disabled = true; $('#btn-start').textContent = 'Connecting\u2026';
  closeSummary(); $('#transcript').replaceChildren(); $('#chip-rec').hidden = true; dropSceneFrame(); stage.sceneClear(); dropBackdropFrame(); dropCodexBackdropFrame();
  try {
    if (!stream && !(await enableDevices())) throw new Error('Select your devices or choose no microphone to type.');
    await ctx.resume();
    player = new Player(ctx, { onComplete: playbackComplete, levels: audioMix });
    for (const { id: speaker } of AGENTS) stage.levels[speaker] = () => player?.turn?.speaker === speaker ? player.level() : 0;
    broadcast.sourcesChanged();
    const model = $('#sel-model').value;
    store.set('claude-interview.model', { model, effort }); store.set('claude-interview.voice-pick', $('#sel-voice').value);
    session = await request('/api/sessions', { ...participantPayload(), user_name: $('#inp-name').value.trim(), vision_level: vision, vision_source: visionSource, topic: $('#inp-topic').value.trim(), voice_id: $('#sel-voice').value, tts_model: 'eleven_v3_conversational', claude_model: model, claude_effort: effort, visuals, style: stage.style, backdrops: store.get('claude-interview.bg') === 'match' });
    for (const id of Object.keys(reportedModels)) delete reportedModels[id]; showWho();
    t0 = performance.now();
    await connectEvents();
    if (mic) await api('listen', { silence: Number($('#sel-silence').value) });
    chip('stt', mic ? 'Listening' : 'Type to talk', 'ok');
    uploader = new PcmUploader(bytes => api('input-audio', bytes, 15000), error => fatal(`Microphone audio stopped reaching the backend: ${error.message}`));
    if (mic) await mic.start(bytes => uploader.push(bytes));
    await startRecorders();
    enterLive();
    if (!mic) toggleDrawer(true);
    await sendVisionFrame();
    if ($('#sel-opener').value !== 'user') await api('turn', { speaker: $('#sel-opener').value, introduction: true, request_id: uuid(), reply_id: uuid(), client_ms: clientMs() });
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
  const mixed = []; recorders.cameraAudio = mixed; recorders.ownedTracks = [];
  const cam = stream.getVideoTracks()[0];
  if (cam && $('#chk-rec-camera').checked) {
    const audio = stream.getAudioTracks()[0]?.clone(); if (audio) mixed.push(audio);
    recorders.push(await recordTrack({ ...common, kind: 'user-camera', stream: new MediaStream([cam, ...(audio ? [audio] : [])]), videoBitsPerSecond: RES[cameraRes].bitrate }));
  }
  if ($('#chk-rec-stage').checked) {
    const dest = ctx.createMediaStreamDestination(), mix = voiceStrip(ctx);
    mic?.mixGain.connect(mix.input); player.out.connect(mix.input); mix.output.connect(dest); recorders.mixStrip = mix;
    const frame = $('#stage').captureStream(30);
    recorders.ownedTracks.push(...frame.getTracks(), ...dest.stream.getTracks()); recorders.mixDestination = dest;
    recorders.push(await recordTrack({ ...common, kind: 'stage', stream: new MediaStream([...frame.getVideoTracks(), ...dest.stream.getAudioTracks()]) }));
  }
  // Lossless stems on one clock, after each participant's mix trim and peak protection.
  for (const [kind, source] of [['user-voice', mic?.mixGain], ...AGENTS.map(a => [`${a.id}-voice`, player.voice(a.id)])].filter(([, source]) => source)) {
    try { recorders.push(await recordPcm({ ...common, kind, ctx, source })); } catch (error) { toast(`${kind} stem not recording: ${error.message}`, true); }
  }
}

function enterLive() {
  setPhase('live'); $('#chip-rec').hidden = false; $('#btn-mute').disabled = !mic;
  addEventListener('beforeunload', guard);
}
const guard = e => { if (phase === 'live' || phase === 'ending') { e.preventDefault(); e.returnValue = ''; } };

// ---------- the event contract ----------
function handle(e) {
  switch (e.type) {
    case 'stt-connected': chip('stt', 'Listening', 'ok'); break;
    case 'partial-transcript': lastPartialAt = performance.now(); stage.caption('user', e.text); stage.backchannel();
      if (/\b(ha(ha)+|lol)\b|\(laugh/i.test(e.text) && (!stage.mood || performance.now() - stage.mood.at > 2500)) stage.setMood('laughs softly'); break;   // laughing along
    case 'user-turn': { stage.caption('user', e.turn.text); addLine('user', e.turn.text);
      const feel = feelingHeard(e.turn.text); if (feel) { stage.setMood(feel); stage.setMood(feel, 'codex'); } break; }
    case 'conversation-state':
      conversationContinues = e.continuing === true;
      $('#btn-interrupt').disabled = !conversationContinues && (!current || current.stopped || current.completed || current.error);
      break;
    case 'turn-start': {
      // A new reply supersedes any earlier one that is still sounding.
      const old = current;
      if (old && !old.stopped && !old.completed) void stopCurrent('superseded').then(() => api('interrupt', { turn_id: old.id, reason: 'superseded' })).catch(() => {});
      current = { id: e.turn_id, speaker: e.speaker || 'claude', speech: '', chars: [], stopped: false, completed: false, error: false, reported: 0 };
      current.el = addLine(current.speaker, ''); player.begin(e.turn_id, current.speaker);
      $('#btn-interrupt').disabled = false; break;
    }
    case 'model': reportedModels[e.speaker || 'claude'] = e.model; showWho(); break;
    case 'voice':
      { const agent = agentById(e.speaker || 'claude'); if (agent) $(`#${agent.controls.voice}`).value = e.voice.voice_id; showWho(); }
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
    case 'turn-skipped': if (current?.id === e.turn_id) { current.completed = true; current.el.remove(); player.stop(); $('#btn-interrupt').disabled = true; } break;
    case 'config-changed':
      for (const a of AGENTS) for (const [key, field] of Object.entries(a.fields)) if (e[field] !== undefined) agentChoices[a.id][key] = e[field];
      showParticipants(); break;
    case 'turn-done': if (current?.id === e.turn_id) { current.done = true; player.finish(e.turn_id); } break;
    case 'interrupted':
      if (current && !current.stopped && !current.completed && (!e.turn_id || e.turn_id === current.id)) void stopCurrent(e.reason || 'interrupted');
      break;
    case 'scene-base': if (agentChoices.claude.enabled && visuals !== 'off') stage.sceneBase(e); break;
    case 'scene-none': stage.sceneClear(); dropSceneFrame(); break;
    case 'scene-ready': if (agentChoices.claude.enabled && visuals !== 'off') openSceneFrame(e.scene_id, e.url); break;
    case 'scene-error': if (e.sketch) stage.sceneStandIn(e.scene_id); else stage.sceneDone(e.scene_id); console.warn('Scene not drawn:', e.message); break;
    case 'backdrop-ready':
      if (e.speaker === 'codex') { if (phase === 'live' && agentChoices.codex.enabled && visuals !== 'off') openCodexBackdropFrame(e.backdrop_id, e.url); }
      else if (agentChoices.claude.enabled) openBackdropFrame(e.backdrop_id, e.url);
      break;
    case 'backdrop-error': console.warn('Backdrop not drawn:', e.message); break;
    case 'audio-mix-changed': applyAudioMix(e.mix); break;
    case 'mic-muted': case 'mic-unmuted': setMuted(e.type === 'mic-muted'); break;
    case 'error':
      toast(e.message, true);
      if (current && (!e.turn_id || e.turn_id === current.id) && !current.stopped) { void stopCurrent('error'); current.error = true; meta(current, 'error \u2014 reply incomplete'); }
      break;
    case 'session-ended': if (phase === 'live') { toast(e.reason === 'user-ended' ? 'Call ended' : `Call ended (${e.reason})`); void teardown(e.reason, true); } break;
  }
}

function showWho() {
  $('#participant-summary').replaceChildren(...selectedAgents(participantPayload()).map(agent => {
    const model = reportedModels[agent.id] || agentChoices[agent.id].model || '';
    const thinking = $(`#${agent.controls.effort}`).value;
    const voice = $(`#${agent.controls.voice}`).selectedOptions[0]?.textContent.split(' — ')[0] || '';
    const badge = document.createElement('div'); badge.className = `participant-summary-item ${agent.id}`;
    const name = document.createElement('strong'); name.textContent = agent.name;
    const detail = document.createElement('span'); detail.textContent = [modelName(model), `Thinking ${effortName(thinking).toLowerCase()}`, voice].filter(Boolean).join(' · ');
    badge.append(name, detail); return badge;
  }));
}

// ---------- bespoke scenes ----------
// Each generated scene runs in a sandboxed iframe (opaque origin, no network) and streams ImageBitmaps back,
// which the stage composites into the recorded frame.
function openSceneFrame(id, url) {
  const f = document.createElement('iframe');
  f.className = 'scene-frame'; f.setAttribute('sandbox', 'allow-scripts'); f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1;
  f.src = url; f.dataset.scene = id;
  document.body.append(f);
  // the picture on screen keeps animating until the new one has drawn its first frame (or turns out broken)
  oldSceneFrame?.remove(); oldSceneFrame = sceneFrame; sceneFrame = f;
}
function dropSceneFrame() { sceneFrame?.remove(); oldSceneFrame?.remove(); sceneFrame = oldSceneFrame = null; }
// The user's backdrop runs in its own sandboxed frame, independent of the scene on Claude's side.
let backdropFrame = null;
function openBackdropFrame(id, url) {
  const f = document.createElement('iframe');
  f.className = 'scene-frame'; f.setAttribute('sandbox', 'allow-scripts'); f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1; f.src = url; f.dataset.backdrop = id;
  document.body.append(f); const old = backdropFrame; backdropFrame = f; setTimeout(() => old?.remove(), 1500);
}
function dropBackdropFrame() { backdropFrame?.remove(); backdropFrame = null; stage.backdropClear(); }
function openCodexBackdropFrame(id, url) {
  const f = document.createElement('iframe');
  f.className = 'scene-frame'; f.setAttribute('sandbox', 'allow-scripts'); f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1;
  f.src = url; f.dataset.backdrop = id; document.body.append(f);
  oldCodexBackdropFrame?.remove(); oldCodexBackdropFrame = codexBackdropFrame; codexBackdropFrame = f;
}
function dropCodexBackdropFrame() {
  codexBackdropFrame?.remove(); oldCodexBackdropFrame?.remove(); codexBackdropFrame = oldCodexBackdropFrame = null; stage.codexBackdropClear();
}
addEventListener('message', e => {
  const astra = [codexBackdropFrame, oldCodexBackdropFrame].find(f => f && e.source === f.contentWindow);
  if (astra) {
    if (e.data?.type === 'scene-frame' && e.data.bitmap instanceof ImageBitmap) {
      stage.codexBackdropBitmap(astra.dataset.backdrop, e.data.bitmap);
      if (astra === codexBackdropFrame) { oldCodexBackdropFrame?.remove(); oldCodexBackdropFrame = null; }
    } else if (e.data?.type === 'scene-broken') {
      console.warn('Astra setting could not draw. Keeping the previous setting.'); astra.remove();
      if (astra === codexBackdropFrame) { codexBackdropFrame = oldCodexBackdropFrame; oldCodexBackdropFrame = null; }
      if (!codexBackdropFrame) stage.codexBackdropClear();
    }
    return;
  }
  if (backdropFrame && e.source === backdropFrame.contentWindow) { if (e.data?.type === 'scene-frame' && e.data.bitmap instanceof ImageBitmap) stage.backdropBitmap(backdropFrame.dataset.backdrop, e.data.bitmap); return; }
  const from = [sceneFrame, oldSceneFrame].find(f => f && e.source === f.contentWindow); if (!from) return;
  const id = from.dataset.scene;
  if (e.data?.type === 'scene-frame' && e.data.bitmap instanceof ImageBitmap) {
    stage.sceneBitmap(id, e.data.bitmap);
    if (from === sceneFrame && stage.scene?.id === id && oldSceneFrame) { oldSceneFrame.remove(); oldSceneFrame = null; }
  }
  else if (e.data?.type === 'scene-error') console.warn('Scene script error:', e.data.message);
  else if (e.data?.type === 'scene-broken' && from === sceneFrame) {
    // a picture that keeps failing is dropped; the previous one (if any) carries on
    console.warn('Scene dropped: its code kept failing.'); stage.sceneDone(id); sceneFrame.remove(); sceneFrame = oldSceneFrame; oldSceneFrame = null;
  }
});
function toggleVisual() { stage.sceneHidden = !stage.sceneHidden; $('#btn-visual').setAttribute('aria-pressed', String(!stage.sceneHidden)); }

// Mouth shapes from the character being played; a delivery cue changes mood when it is actually heard.
const MOUTH = ch => /[aæ]/.test(ch) ? [0.85, 0] : /[ei]/.test(ch) ? [0.55, 0] : /[ouwy]/.test(ch) ? [0.6, 0.9] : /[mbp]/.test(ch) ? [0, 0.2] : /[fv]/.test(ch) ? [0.15, 0] : /[a-z]/.test(ch) ? [0.3, 0.1] : [0.05, 0];
function animateSpeech(at) {
  let raw = '', last = ' ';
  for (const c of current.chars) { if (c.t > at) break; raw += c.ch; }
  const tags = [...raw.matchAll(/\[([^\]]{1,40})\]/g)];
  if (tags.length > (current.moods || 0)) { current.moods = tags.length; stage.setMood(tags.at(-1)[1].toLowerCase(), current.speaker); }
  const spoken = raw.replace(/\[[^\]]*\]?/g, ''); last = spoken.at(-1)?.toLowerCase() || ' ';
  // As each sentence starts to play, its words set the mood (unless the sentence carries its own delivery cue).
  const bounds = [...raw.matchAll(/(?:^|[.!?\u2026]\s+)(?=\S)/g)];
  if (bounds.length > (current.sentences || 0)) {
    current.sentences = bounds.length;
    const from = bounds.at(-1).index + bounds.at(-1)[0].length, all = current.chars.map(c => c.ch).join('');
    const sentence = all.slice(from).split(/(?<=[.!?\u2026])\s/)[0];
    const feel = /\[[^\]]+\]/.test(sentence) ? null : feelingSpoken(sentence);
    if (feel && (!stage.getMood(current.speaker) || performance.now() - stage.getMood(current.speaker).at > 1200)) stage.setMood(feel, current.speaker);
  }
  // a question or exclamation mark that has actually been played shapes the face (unless a cue is active)
  const marks = (spoken.match(/[?!]/g) || []).length;
  if (marks > (current.marks || 0)) { current.marks = marks; if (!stage.getMood(current.speaker) || performance.now() - stage.getMood(current.speaker).at > 1500) stage.setMood(last === '?' ? 'question' : 'exclaim', current.speaker); }
  const [open, round] = MOUTH(last); stage.setMouth(current.speaker, { open, round });
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
  if (c.chars.length || result?.started || reason !== 'superseded') stage.interrupted(c.speaker);
  meta(c, result?.started ? `interrupted \u2014 heard about ${result.played.toFixed(1)} s` : 'interrupted before speaking');
  $('#btn-interrupt').disabled = true;
  if (result) await report('audio-playback', c.id, result.played, { estimated: true, reason });
  return result;
}
function playbackComplete(id, seconds) {
  if (current?.id !== id) return;
  current.completed = true; $('#btn-interrupt').disabled = !conversationContinues;
  void report('playback-complete', id, seconds, { estimated: false });
}
setInterval(() => {
  // Periodic progress while speaking, so an abrupt end still leaves evidence of what played.
  if (phase !== 'live' || !current || current.stopped || current.completed || !player.started) return;
  const played = player.played(); if (played - current.reported < 0.25) return;
  current.reported = played; void report('audio-playback', current.id, played, { estimated: true, progress: true });
}, 2000);

// ---------- per-frame state (drives the stage from real events) ----------
function updateCallState(now) {
  if (phase !== 'live' && phase !== 'ending') return;
  stage.userSpeaking = now - lastPartialAt < 1100;
  for (const speaker of ['claude', 'codex']) {
    if (connectionLost) stage[speaker] = 'error';
    else if (current?.speaker === speaker && !current.stopped && !current.completed && !current.error) stage[speaker] = player.started ? 'speaking' : 'thinking';
    else stage[speaker] = muted && !player?.audible ? 'waiting' : 'listening';
  }
  if (current && player.started && !current.stopped) {
    const at = player.position();
    const heard = current.chars.length ? current.chars.filter(c => c.t <= at).map(c => c.ch).join('') : display(current.speech);
    if (current.chars.length) animateSpeech(at); else stage.setMouth(current.speaker, { open: Math.min(1, player.level() * 8), round: 0.2 });
    const text = display(heard); if (text !== current.caption) { current.caption = text; stage.caption(current.speaker, text); }
  }
  const secs = (now - t0) / 1000, failed = Object.values(recProgress).some(p => p.failed);

  if (!failed && phase === 'live') chip('rec', fmtTime(secs), 'rec');
}
function renderFrame(now) {
  updateCallState(now);
  stage.frame(now);
  // drive the bespoke scene one frame per display frame (see sceneFrameHTML in src/director.mjs)
  const env = { type: 'env', env: { level: player ? Math.min(1, player.level() * 6) : 0, speaking: stage.claude === 'speaking' || stage.codex === 'speaking' } };
  sceneFrame?.contentWindow?.postMessage(env, '*'); oldSceneFrame?.contentWindow?.postMessage(env, '*'); backdropFrame?.contentWindow?.postMessage(env, '*');
  const astraEnv = { type: 'env', env: { level: stage.cs.speak, speaking: stage.codex === 'speaking' } };
  codexBackdropFrame?.contentWindow?.postMessage(astraEnv, '*'); oldCodexBackdropFrame?.contentWindow?.postMessage(astraEnv, '*');
}
let lastDraw = 0;
function drawLoop(now) { if (!document.hidden && now - lastDraw >= 1000 / 30 - 1) { lastDraw = now; renderFrame(now); } requestAnimationFrame(drawLoop); }
// Keep the composed feed advancing while the operator checks X in another tab.
setInterval(() => { if (document.hidden && (broadcast.active || phase === 'live' && recorders.length)) renderFrame(performance.now()); }, 1000 / 30);
requestAnimationFrame(drawLoop);


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
  if (phase !== 'live') return;
  conversationContinues = false;
  await stopCurrent('user-interrupted');
  // A deliberate stop applies to the whole exchange, including a prepared reply between speakers.
  try { await api('interrupt', { reason: 'user-interrupted' }); } catch (error) { toast(error.message, true); }
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
  try {
    // Cut in immediately, and report the exact played prefix before assembling the next context.
    // The one-second snapshot stream already supplies vision; a fresh frame must not hold up speech.
    void sendVisionFrame(); await interrupt();
    await api('turn', { text, request_id: uuid(), reply_id: uuid(), client_ms: clientMs() });
  } catch (error) { toast(error.message, true); }
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
  const w = document.createElement('span'); w.className = 'who'; w.textContent = agentById(who)?.name || userName();
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
  mic?.stop();
  await Promise.all([stopCurrent('call-ended'), uploader?.close().catch(() => {})]);
  if (!serverEnded) { try { await api('end', {}); } catch (error) { toast(`End: ${error.message}`, true); } }
  stage.claude = stage.codex = connectionLost ? 'error' : 'ended';
  const saved = [], problems = [];
  for (const r of recorders) { try { saved.push(await r.stop()); } catch (error) { problems.push(`${r.name}: ${error.message}`); } }
  // Finish the recorded frame before retiring every generated scene and its drawing timer.
  dropSceneFrame(); dropBackdropFrame(); dropCodexBackdropFrame();
  for (const track of [...(recorders.cameraAudio || []), ...(recorders.ownedTracks || [])]) track.stop();
  if (recorders.mixStrip) {
    try { mic?.mixGain.disconnect(recorders.mixStrip.input); player?.out.disconnect(recorders.mixStrip.input); } catch {}
    recorders.mixStrip.dispose();
  }
  player?.dispose();
  es?.close(); removeEventListener('beforeunload', guard);
  stream?.getTracks().forEach(t => t.stop()); stage.cameraOn = false;
  $('#chip-stt').hidden = true;
  chip('rec', problems.length ? 'Needs recovery' : 'Saved', problems.length ? 'bad' : 'ok');
  await showSummary(problems);
  readyForNextCall();
}

async function showSummary(problems) {
  let s = null; try { s = await api('', undefined); } catch {}
  const needsRecovery = !s || s.status !== 'ended' || problems.length > 0 || Object.values(s.media || {}).some(m => !m.complete);
  $('#summary').classList.toggle('needs-recovery', needsRecovery);
  $('#summary-title').textContent = needsRecovery ? 'Saving needs attention' : 'Recording saved';
  $('#summary-lede').textContent = !s ? 'We couldn’t confirm the save. Check Settings for recovery options.'
    : needsRecovery ? 'Some of your recording couldn’t be saved. Check Settings for recovery options.'
    : 'Your conversation is saved on this Mac.';
  $('#summary-symbol').setAttribute('d', needsRecovery ? 'M12 6v7m0 4v.01' : 'm6 12 4 4 8-8');
  $('#btn-summary-recover').hidden = !needsRecovery;
  chip('rec', needsRecovery ? 'Needs recovery' : 'Saved', needsRecovery ? 'bad' : 'ok');
  $('#summary').hidden = false;
  $('#btn-again').focus();
  showBackups();
}
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
const dismissSummary = () => { closeSummary(); $('#btn-start').focus(); };
$('#btn-again').onclick = dismissSummary; $('#btn-summary-close').onclick = dismissSummary;
$('#btn-summary-recover').onclick = () => { closeSummary(); settingsTab('streaming'); openPanel('settings'); $('#tab-streaming').focus(); };

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
  await refreshDevices(devices?.mic || '', devices?.camera || '');
  // Asking for permission happens on Start or Allow; an already-authorized mic can preview immediately.
  const allowed = await navigator.permissions?.query({ name: 'microphone' }).then(p => p.state === 'granted').catch(() => false);
  if (allowed || devices?.mic === 'none' && devices?.camera === 'none') await enableDevices();
  else $('#btn-devices').hidden = false;
}); showBackups();
