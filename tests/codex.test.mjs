import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { codexEnvironment, codexArgs, runVerifiedCodex } from '../src/codex.mjs';
import { firstSpeaker, OptionalSpeech } from '../src/conversation.mjs';

function processFixture(run) {
  let child, args;
  const spawnProcess = (_, argv, options) => {
    args = argv; child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.exitCode = null;
    child.kill = signal => { child.killed = signal; child.exitCode = 143; queueMicrotask(() => child.emit('close', 143)); };
    child.stdin.on('finish', () => queueMicrotask(() => run(child)));
    return child;
  };
  return { spawnProcess, get child() { return child; }, get args() { return args; } };
}
const emit = (child, event) => child.stdout.write(JSON.stringify(event) + '\n');
test('Codex inherits subscription login without passing API keys or changing parent environment', () => {
  const source = { HOME: '/original', CODEX_HOME: '/auth-home', OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', ELEVENLABS_API_KEY: 'secret', CODEX_THREAD_ID: 'parent', PATH: '/bin' };
  const env = codexEnvironment(source);
  assert.deepEqual(env, { HOME: '/original', CODEX_HOME: '/auth-home', PATH: '/bin' }); assert.equal(source.OPENAI_API_KEY, 'secret');
  const args = codexArgs({ system: 'Only speak.', cwd: '/empty' });
  for (const x of ['--ephemeral', '--ignore-user-config', 'read-only', 'forced_login_method="chatgpt"', 'model_provider="openai"', 'web_search="disabled"', 'mcp_servers={}', 'gpt-6-astra', 'model_reasoning_effort="low"', 'skip_host_skill_discovery']) assert.ok(args.includes(x), x);
});
test('Codex speaks only completed agent messages, deduplicates final text, cleans its temporary room', async () => {
  const spoken = []; let cwd;
  const mock = processFixture(child => {
    cwd = mock.args[mock.args.indexOf('-C') + 1]; assert.ok(fs.existsSync(cwd));
    emit(child, { type: 'item.completed', item: { id: 'reason', type: 'reasoning', text: 'Do not speak this.' } });
    emit(child, { type: 'item.completed', item: { id: 'aside', type: 'agent_message', phase: 'commentary', text: 'Do not speak commentary.' } });
    for (let i = 0; i < 2; i++) emit(child, { type: 'item.completed', item: { id: 'final', type: 'agent_message', text: 'Hello, Claude.' } });
    emit(child, { type: 'turn.completed' }); child.exitCode = 0; child.emit('close', 0);
  });
  const out = await runVerifiedCodex({ prompt: 'Hello', system: 'Only speak.', spawnProcess: mock.spawnProcess, onText: text => spoken.push(text) });
  assert.equal(out.text, 'Hello, Claude.'); assert.deepEqual(spoken, ['Hello, Claude.']); assert.equal(fs.existsSync(cwd), false);
});
test('interrupting Codex stops the child and drops late text', async () => {
  const controller = new AbortController(), spoken = [];
  const mock = processFixture(child => { controller.abort(); emit(child, { type: 'item.completed', item: { id: 'late', type: 'agent_message', text: 'Late' } }); });
  await assert.rejects(runVerifiedCodex({ prompt: 'Hi', signal: controller.signal, spawnProcess: mock.spawnProcess, onText: text => spoken.push(text) }), { name: 'AbortError' });
  assert.equal(mock.child.killed, 'SIGTERM'); assert.deepEqual(spoken, []);
});
test('Codex resumes the exact private thread with the selected model and labelled images', async () => {
  const session = { id: '11111111-1111-4111-8111-111111111111', cwd: '/call/astra' }; let seen;
  const mock = processFixture(child => {
    emit(child, { type: 'thread.started', thread_id: session.id });
    emit(child, { type: 'item.completed', item: { id: 'thought', type: 'reasoning', text: 'Private reasoning' } });
    emit(child, { type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'I remember.' } });
    emit(child, { type: 'turn.completed' }); child.exitCode = 0; child.emit('close', 0);
  });
  const out = await runVerifiedCodex({ prompt: 'Next update', model: 'gpt-6-astra', effort: 'low', session, onSession: id => { seen = id; },
    images: [{ data: Buffer.from('frame').toString('base64'), label: 'Current call view' }], spawnProcess: mock.spawnProcess });
  assert.equal(mock.args[mock.args.indexOf('resume') + 1], session.id); assert.ok(!mock.args.includes('--ephemeral'));
  assert.equal(mock.args[mock.args.indexOf('-C') + 1], session.cwd); assert.ok(mock.args.indexOf('--image') > mock.args.indexOf('resume'));
  assert.equal(mock.args[mock.args.indexOf('-m') + 1], 'gpt-6-astra'); assert.equal(seen, session.id); assert.equal(out.text, 'I remember.');
});
test('persistent Codex cancellation waits for native history to close and ignores late output', async () => {
  const controller = new AbortController(), spoken = []; let killed = false, settled = false;
  const mock = processFixture(() => {});
  const promise = runVerifiedCodex({ prompt: 'hi', session: { cwd: '/call/astra' }, signal: controller.signal, spawnProcess: mock.spawnProcess, onText: text => spoken.push(text) });
  mock.child.kill = () => { killed = true; };
  const rejection = assert.rejects(promise, { name: 'AbortError' }).then(() => { settled = true; });
  controller.abort(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(killed, true); assert.equal(settled, false);
  emit(mock.child, { type: 'item.completed', item: { id: 'late', type: 'agent_message', text: 'Late output' } });
  mock.child.exitCode = 143; mock.child.emit('close', 143); await rejection; assert.deepEqual(spoken, []);
});
test('Codex rejects failed, unfinished, and tool-using replies without substituting models', async () => {
  for (const event of [{ type: 'turn.failed', error: { message: 'model unavailable' } }, { type: 'item.started', item: { type: 'command_execution' } }, { type: 'turn.started' }]) {
    const mock = processFixture(child => { emit(child, event); child.exitCode = 0; child.emit('close', 0); });
    await assert.rejects(runVerifiedCodex({ prompt: 'Hi', model: 'gpt-6-astra', spawnProcess: mock.spawnProcess }));
    assert.equal(mock.args[mock.args.indexOf('-m') + 1], 'gpt-6-astra');
  }
});
test('named participants get the floor; unnamed turns alternate only in a three-person call', () => {
  assert.equal(firstSpeaker('Astro, what do you think about that?', true), 'codex');
  assert.equal(firstSpeaker('Astra, why?', true), 'codex'); assert.equal(firstSpeaker('Claude, your thoughts?', true, 'claude'), 'claude');
  assert.equal(firstSpeaker('And then?', true, 'claude'), 'codex'); assert.equal(firstSpeaker('And then?', true, 'codex'), 'claude');
  assert.equal(firstSpeaker('Codex?', false), 'claude');
  assert.equal(firstSpeaker('Claude, are you here?', true, 'codex', false), 'codex');
  assert.equal(firstSpeaker('Claude made a good point. Astra, do you agree?', true), 'codex');
  assert.equal(firstSpeaker('Astra mentioned this, but Claude, what would you try?', true), 'claude');
});

test('Codex preserves image order, bytes and labels, then removes temporary frames', async () => {
  const frames = [Buffer.from([0xff,0xd8,1]), Buffer.from([0xff,0xd8,2])]; let paths;
  const mock = processFixture(child => {
    paths = mock.args.flatMap((arg,i) => arg === '--image' ? [mock.args[i+1]] : []);
    assert.equal(paths.length, 2); paths.forEach((p,i) => assert.deepEqual(fs.readFileSync(p),frames[i]));
    const input = child.stdin.read().toString();
    assert.ok(input.indexOf('Image 1: Call view 12 seconds ago') < input.indexOf('Image 2: Call view now'));
    assert.ok(input.endsWith('What changed?'));
    emit(child,{type:'item.completed',item:{id:'reply',type:'agent_message',text:'The camera turned off.'}});
    emit(child,{type:'turn.completed'});child.exitCode=0;child.emit('close',0);
  });
  await runVerifiedCodex({prompt:'What changed?',images:frames.map((b,i)=>({data:b.toString('base64'),label:i?'Call view now':'Call view 12 seconds ago'})),spawnProcess:mock.spawnProcess});
  for(const p of paths)assert.equal(fs.existsSync(p),false);
});


test('optional speech holds only a split pass marker and otherwise streams immediately', () => {
  const heard = [], speech = new OptionalSpeech(text => heard.push(text));
  speech.add('[cu'); assert.deepEqual(heard, ['[cu'], 'a real delivery tag starts streaming without waiting for the reply');
  speech.add('rious] But what about compute?'); assert.equal(speech.finish(), true);
  assert.equal(heard.join(''), '[curious] But what about compute?');
  for (const chunks of [['  [[', 'Pa', 'ss]]', '  '], ['', ' ']]) {
    const output = [], gate = new OptionalSpeech(text => output.push(text));
    for (const chunk of chunks) gate.add(chunk);
    assert.equal(gate.finish(), false); assert.deepEqual(output, []);
  }
  const words = [], ordinary = new OptionalSpeech(text => words.push(text));
  ordinary.add('Pass the question back to me.'); assert.equal(ordinary.finish(), true); assert.equal(words.length, 1);
});
