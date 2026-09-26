import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ParticipantMemory } from '../src/participant-memory.mjs';

function memory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'participant-memory-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new ParticipantMemory(dir);
}
const input = (turns, expected) => m => {
  const { snapshot, input } = m.context(turns, expected);
  return { snapshot, options: { prompt: JSON.stringify(input) } };
};

test('participants keep separate native IDs and send only new room events on continuation', async t => {
  const claude = memory(t), astra = memory(t), ids = [randomUUID(), randomUUID()], calls = [];
  const turns = [{ id: 'human-1', speaker: 'user', text: 'The lighthouse is teal.' }];
  for (const [i, m] of [claude, astra].entries()) {
    await m.run({ turnId: `reply-${i}`, input: input(turns), invoke: async o => { calls.push(o); o.onSession(ids[i]); } });
  }
  turns.push({ id: 'human-2', speaker: 'user', text: 'What colour did I say?' });
  await claude.run({ turnId: 'reply-2', input: input(turns), invoke: async o => { calls.push(o); o.onSession(ids[0]); } });
  assert.notEqual(claude.session.id, astra.session.id);
  assert.equal(calls[2].session.id, ids[0]);
  const resumed = JSON.parse(calls[2].prompt);
  assert.equal(resumed.context_mode, 'updates');
  assert.deepEqual(resumed.conversation.map(t => t.turn_id), ['human-2']);
  assert.ok(!calls[2].prompt.includes('teal'), 'the old fact must come from native history');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(claude.session.cwd, 'session.json')))), ['session_id']);
});

test('interruption corrects anticipated peer words and marks an unspoken private draft', async t => {
  const m = memory(t), id = randomUUID();
  const peer = { id: 'peer', speaker: 'claude', text: 'Use blue. The hidden ending.', status: 'generated' };
  const turns = [peer];
  await m.run({ turnId: 'draft', input: input(turns, peer.id), invoke: async o => { o.onSession(id); } });
  peer.status = 'interrupted'; peer.heard_text = 'Use blue.'; peer.played_seconds = 1;
  turns.push({ id: 'human', speaker: 'user', text: 'Actually use green.' });
  let next;
  await m.run({ turnId: 'answer', input: input(turns), invoke: async o => { next = JSON.parse(o.prompt); o.onSession(id); } });
  assert.equal(next.conversation[0].text, 'Use blue.');
  assert.match(next.conversation[0].delivery_note, /Interrupted/);
  assert.ok(!JSON.stringify(next).includes('hidden ending'));
  assert.equal(next.previous_reply.turn_id, 'draft');
  assert.match(next.previous_reply.delivery_note, /never spoken/);
  assert.equal(m.session.id, id, 'interruption must not erase its own native context');
});

test('the next request waits for cancellation to settle and retries unconfirmed input', async t => {
  const m = memory(t), id = randomUUID(), abort = new AbortController();
  const turns = [{ id: 'human', speaker: 'user', text: 'Remember the harbour.' }];
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  const first = m.run({ turnId: 'a', signal: abort.signal, input: input(turns), invoke: o => {
    o.onSession(id); started(); return new Promise((resolve, reject) => { finish = () => reject(new DOMException('Interrupted', 'AbortError')); });
  } });
  await ready; abort.abort();
  let next;
  const second = m.run({ turnId: 'b', input: input(turns), invoke: async o => { next = JSON.parse(o.prompt); o.onSession(id); } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(next, undefined);
  const failed = assert.rejects(first, { name: 'AbortError' }); finish(); await failed; await second;
  assert.equal(next.conversation[0].text, 'Remember the harbour.');
});

test('own delivery receipts correct private full answers; unchanged history is not resent or capped', async t => {
  const m = memory(t), id = randomUUID();
  const turns = [{ id: 'start', speaker: 'user', text: 'Opening anchor.' },
    ...Array.from({ length: 300 }, (_, i) => ({ id: `u-${i}`, speaker: 'user', text: 'Long discussion. '.repeat(30) }))];
  let first;
  await m.run({ turnId: 'own', input: input(turns), invoke: async o => { first = o.prompt; o.onSession(id); } });
  assert.ok(first.length > 120000); assert.equal(JSON.parse(first).conversation.length, 301);
  turns.push({ id: 'own', speaker: 'claude', status: 'interrupted', text: 'A full private answer.', heard_text: 'A full', played_seconds: .4 });
  const update = m.context(turns).input;
  assert.equal(update.conversation.length, 1); assert.equal(update.conversation[0].text, 'A full');
  assert.equal(update.previous_reply, undefined, 'a real turn uses its delivery receipt');
});

test('native resume failures never silently start a replacement conversation', async t => {
  const m = memory(t), id = randomUUID();
  await m.run({ turnId: 'a', input: input([]), invoke: async o => o.onSession(id) });
  await assert.rejects(m.run({ turnId: 'b', input: input([]), invoke: async () => { throw new Error('Resume failed'); } }), /Resume failed/);
  assert.equal(m.session.id, id);
  await assert.rejects(m.run({ turnId: 'c', input: input([]), invoke: async o => o.onSession(randomUUID()) }), /did not resume/);
  assert.equal(m.session.id, id);
});

test('prompt edits and resets append guidance without changing the original reasoning prefix', async t => {
  const m = memory(t), id = randomUUID(), calls = [];
  for (const system of ['Original voice.', 'More playful.', 'More playful.', 'Original voice.']) {
    await m.run({ turnId: randomUUID(), input: () => ({ snapshot: new Map(), options: { system, prompt: '{"conversation":[]}' } }),
      invoke: async o => { calls.push({ system: o.system, input: JSON.parse(o.prompt) }); o.onSession(id); } });
  }
  assert.deepEqual(calls.map(c => c.system), Array(4).fill('Original voice.'));
  assert.deepEqual(calls.map(c => c.input.instruction_update), [undefined, 'More playful.', undefined, 'Original voice.']);
});
