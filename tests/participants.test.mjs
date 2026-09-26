import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS, nextSpeaker, addressedSpeaker, selectedAgents } from '../public/participants.js';

test('turn order and direct addressing work with three or more participants, including passes', () => {
  const extra = { id: 'third', name: 'Third', aliases: ['third'], fields: { enabled: 'third_enabled' } };
  const roster = selectedAgents({ claude_enabled: true, codex_enabled: true, third_enabled: true }, [...AGENTS, extra]);
  assert.equal(nextSpeaker(roster, 'claude'), 'codex');
  assert.equal(nextSpeaker(roster, 'codex'), 'third');
  assert.equal(nextSpeaker(roster, 'third'), 'claude');
  assert.equal(nextSpeaker(roster, 'codex', ['claude', 'codex']), 'third');
  assert.equal(nextSpeaker(roster, 'third', ['claude', 'codex', 'third']), null);
  assert.equal(addressedSpeaker('Astra made a point. Third, what do you think?', roster), 'third');
  assert.equal(addressedSpeaker('Third, hello', roster.slice(0, 2)), null);
});
