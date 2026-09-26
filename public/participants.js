// Shared roster metadata. Provider adapters and avatar renderers are separate
// capabilities; attendance, controls, prompts and turn order use this list.
export const AGENTS = [
  { id: 'claude', defaultEnabled: true, name: 'Claude', provider: 'claude', aliases: ['claude', 'fable'], symbol: '✳', symbolClass: 'claude-symbol',
    prompt: 'conversation', defaultPrompt: 'conversation.default', promptArchive: 'system-prompt.md',
    fields: { enabled: 'claude_enabled', model: 'claude_model', effort: 'claude_effort', voice: 'voice_id' },
    controls: { model: 'sel-model', effort: 'sel-effort', voice: 'sel-voice', sample: 'btn-sample' } },
  { id: 'codex', name: 'Astra', provider: 'codex', aliases: ['codex', 'astra', 'astro'], symbol: '', symbolClass: 'codex-brand',
    prompt: 'codex', defaultPrompt: 'codex.default', promptArchive: 'codex-prompt.md',
    fields: { enabled: 'codex_enabled', model: 'codex_model', effort: 'codex_effort', voice: 'codex_voice_id' },
    controls: { model: 'sel-codex-model', effort: 'sel-codex-effort', voice: 'sel-codex-voice', sample: 'btn-codex-sample' } },
];
export const agentById = id => AGENTS.find(agent => agent.id === id);
export const selectedAgents = (settings, agents = AGENTS) => agents.filter(agent => settings[agent.fields.enabled]);
export const participantChoice = (agent, settings) => Object.fromEntries(Object.entries(agent.fields).map(([key, field]) => [key, settings[field]]));
export function nextSpeaker(roster, previous, excluded = []) {
  if (!roster.length) return null;
  const index = roster.findIndex(agent => agent.id === previous);
  for (let step = 1; step <= roster.length; step++) {
    const candidate = roster[(index + step) % roster.length];
    if (!excluded.includes(candidate.id)) return candidate.id;
  }
  return null;
}
export function addressedSpeaker(text, roster) {
  const aliases = roster.flatMap(agent => agent.aliases || [agent.name]).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (!aliases) return null;
  const direct = [...String(text).matchAll(new RegExp(`(?:^|[.!?;,]\\s*|\\b(?:and|but|so|hey)\\s+)(${aliases})\\s*(?:[,?!:]|\\b(?:can|could|would|do|what|how|why|are|tell|your)\\b)`, 'gi'))].at(-1)?.[1];
  const name = (direct || String(text).match(new RegExp(`\\b(${aliases})\\b`, 'i'))?.[1])?.toLowerCase();
  return roster.find(agent => (agent.aliases || [agent.name]).some(alias => alias.toLowerCase() === name))?.id || null;
}
