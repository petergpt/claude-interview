export const SAMPLE_RATE = 24000;
// An uncommon port, so the studio rarely collides with other local servers (override with INTERVIEW_PORT).
export const DEFAULT_PORT = 4747;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// How Claude Code is authenticated: 'subscription' (default; the user's own Claude Code login) or 'api'
// (INTERVIEW_CLAUDE_AUTH=api with ANTHROPIC_API_KEY in the backend environment, billed to that API key).
export const claudeAuthMode = (source = process.env) => source.INTERVIEW_CLAUDE_AUTH === 'api' ? 'api' : 'subscription';

export function subscriptionEnvironment(source = process.env) {
  const env = { ...source }, mode = claudeAuthMode(source);
  for (const key of Object.keys(env)) {
    if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_USE_') ||
        key.startsWith('ELEVENLABS_') || key.startsWith('X_STREAM_') || key === 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY' ||
        key === 'CLAUDECODE' || key === 'CLAUDE_CONFIG_DIR' || key === 'INTERVIEW_CLAUDE_AUTH') delete env[key];
  }
  // API mode passes only the API key through; gateway and base-URL overrides are still removed.
  if (mode === 'api' && source.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = source.ANTHROPIC_API_KEY;
  // An explicitly supplied Claude subscription token remains inside Claude Code.
  // The harness never extracts, exchanges, or forwards Claude OAuth credentials.
  return env;
}

export function isSubscription(status) {
  return status?.loggedIn === true && status.apiProvider === 'firstParty' &&
    ['claude.ai', 'oauth', 'oauth_token'].includes(status.authMethod);
}

export function cleanSpeech(text) {
  return text.replace(/\[[^\]\n]{1,80}\]/g, '').replace(/\[[^\]]*$/, '').replace(/\s+/g, ' ').trim();
}

export class SpeechChunks {
  buffer = '';
  started = false;
  add(text, final = false) {
    this.buffer += text;
    const chunks = [];
    while (this.buffer.length) {
      let cut = -1;
      let inTag = false;
      for (let i = 0; i < this.buffer.length; i++) {
        const c = this.buffer[i];
        if (c === '[') inTag = true;
        if (c === ']') inTag = false;
        if (!inTag && i >= (this.started ? 70 : 24) && /[.!?…]/.test(c) && /\s/.test(this.buffer[i + 1] || '')) { cut = i + 1; break; }
        if (!inTag && i >= 260 && /\s/.test(c)) { cut = i + 1; break; }
      }
      if (cut < 0 && final) {
        if (inTag) throw new Error('Claude returned an unfinished audio tag. Reply saved for review.');
        cut = this.buffer.length;
      }
      if (cut < 0) break;
      const part = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut);
      if (part.trim()) { chunks.push(part); this.started = true; }
    }
    return chunks;
  }
}

export function wavHeader(bytes, rate = SAMPLE_RATE) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + bytes, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(bytes, 40);
  return h;
}

export function allowRequest(req, port) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!hosts.has(req.headers.host)) return false;
  if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}

// The archive keeps complete generated replies. Shared conversational context contains only
// delivered speech, except the one reply a listener is preparing to answer after playback.
export function historyForConversation(turns, { expectedTurnId } = {}) {
  return turns.filter(t => t.status !== 'skipped').map(t => {
    if (!['claude', 'codex'].includes(t.speaker)) return { speaker: t.speaker, text: t.text };
    const delivered = t.playback_complete || t.status === 'delivered';
    const expected = t.id === expectedTurnId && !['interrupted', 'error'].includes(t.status);
    const text = delivered || expected ? t.text : t.heard_text || '';
    return { speaker: t.speaker, text,
      visual_context: { frames: t.seen?.length || 0, ...(t.seen?.length ? { source: t.seen[0].source || 'camera', captured_at_ms: t.seen.map(f => f.at_ms) } : {}) },
      ...(!delivered && !expected ? { played_audio_seconds: t.played_seconds || 0 } : {}),
      delivery_note: delivered ? 'Heard in full.' : expected ? 'Still playing; this reply must finish before you speak.'
        : text ? 'Interrupted. Only these words were heard; the unsaid ending is omitted.'
        : t.played_seconds > 0 ? 'Interrupted. Some audio played, but its exact words are unavailable. Do not infer the ending.'
        : 'Not heard. No spoken content to respond to.' };
  });
}

// ElevenLabs alignment plus the playback clock gives a conservative, whole-word prefix.
export function heardSpeech(alignment, seconds) {
  let raw = '', i = 0;
  for (; i < alignment.length && alignment[i].end <= seconds; i++) raw += alignment[i].ch;
  if (/\p{L}|\p{N}/u.test(alignment[i]?.ch || '') && /[\p{L}\p{N}]$/u.test(raw)) raw = raw.replace(/\S+$/, '');
  return cleanSpeech(raw);
}
