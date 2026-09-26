import { historyForConversation } from './core.mjs';
import { selectedAgents, nextSpeaker, addressedSpeaker, agentById } from '../public/participants.js';

// Bounded context for one-off helpers such as voice selection, not the participants' native sessions.
// Retain the opening human request as an anchor, then spend the rest on the most recent turns.
export function conversationContext(turns, { expectedTurnId, maxChars = 120000 } = {}) {
  const history = historyForConversation(turns, { expectedTurnId });
  const anchor = history.findIndex(t => ['user', 'peter'].includes(t.speaker));
  const size = t => JSON.stringify(t).length + 1;
  const reserveAnchor = anchor >= 0 && size(history[anchor]) < maxChars / 4;
  let remaining = maxChars - (reserveAnchor ? size(history[anchor]) : 0), start = history.length;
  while (start > 0) {
    const cost = reserveAnchor && start - 1 === anchor ? 0 : size(history[start - 1]);
    if (cost > remaining && start < history.length) break;
    remaining -= cost; start--;
  }
  const conversation = history.slice(start);
  if (reserveAnchor && anchor < start) conversation.unshift(history[anchor]);
  const omitted = history.length - conversation.length;
  return { conversation, ...(omitted ? { context_note: `${omitted} earlier turns are outside the current context window. ${reserveAnchor ? 'The opening request and recent conversation are retained.' : 'The recent conversation is retained.'} Do not invent details from omitted turns.` } : {}) };
}

// One conversational floor. The listener can respond, or let the conversation rest.
export function firstSpeaker(text, enabled, previous = 'codex', claudeEnabled = true) {
  const roster = Array.isArray(enabled) ? enabled : selectedAgents({ claude_enabled: claudeEnabled, codex_enabled: enabled });
  return addressedSpeaker(text, roster) || nextSpeaker(roster, previous);
}

export function roomNote(speaker, followup = false, settings = { claude_enabled: true, codex_enabled: true }, preparing = false, previousSpeaker) {
  const roster = selectedAgents(settings);
  const participants = ['the human', ...roster.map(agent => `${agent.name} (labelled ${agent.id} in the transcript)`)].join(', ');
  const peer = agentById(previousSpeaker)?.name || 'the previous participant';
  return `This is a live call with ${participants}. You are ${agentById(speaker)?.name || speaker}. The call context lists the current participants; older transcript entries may include someone who has left. Conversation entries identify the speaker and what was heard.
${followup && roster.length > 1 ? `The floor is open after ${peer}'s turn. Return exactly [[pass]] if you choose not to speak.` : 'The floor is open to you.'}${preparing ? '\nThe latest reply may still be playing. Your output is held until playback finishes and is discarded if that reply is interrupted.' : ''}`;
}

// Hold only a possible pass marker, not an entire spoken reply. This also handles split stream chunks.
export class OptionalSpeech {
  constructor(write) { this.write = write; this.pending = ''; this.speaking = false; }
  add(text) {
    if (this.speaking) { this.write(text); return; }
    this.pending += text;
    const value = this.pending.trimStart().toLowerCase();
    if (!value || '[[pass]]'.startsWith(value) || /^\[\[pass\]\]\s*$/.test(value)) return;
    this.speaking = true; this.write(this.pending); this.pending = '';
  }
  finish() {
    if (!this.speaking && (!this.pending.trim() || /^\[\[pass\]\]$/i.test(this.pending.trim()))) return false;
    if (!this.speaking) this.write(this.pending);
    return true;
  }
}
