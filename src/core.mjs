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
  return text.replace(/\[[^\]\n]{1,80}\]/g, '').replace(/\s+/g, ' ').trim();
}

export class SpeechChunks {
  buffer = '';
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
        if (!inTag && i >= 70 && /[.!?…]/.test(c) && /\s/.test(this.buffer[i + 1] || '')) { cut = i + 1; break; }
        if (!inTag && i >= 260 && /\s/.test(c)) { cut = i + 1; break; }
      }
      if (cut < 0 && final) {
        if (inTag) throw new Error('Claude returned an unfinished audio tag. Reply saved for review.');
        cut = this.buffer.length;
      }
      if (cut < 0) break;
      const part = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut);
      if (part.trim()) chunks.push(part);
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

export function historyForClaude(turns) {
  return turns.map(t => ({
    speaker: t.speaker, text: t.text, id: t.id, status: t.status,
    ...(t.speaker === 'claude' ? {
      generated_audio_seconds: t.audio_seconds || 0,
      played_audio_seconds: t.played_seconds || 0,
      delivery_note: t.status === 'interrupted'
        ? 'They cut in, so they may not have heard the end of this.'
        : t.playback_complete ? 'Heard in full.' : 'May not have been heard in full.'
    } : {})
  }));
}
