import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeAuthMode,subscriptionEnvironment,isSubscription,SpeechChunks,wavHeader,historyForConversation,heardSpeech,allowRequest } from '../src/core.mjs';
import { conversationContext } from '../src/conversation.mjs';
import { claudeArgs,runVerifiedClaude } from '../src/claude.mjs';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

test('subscription process strips gateway/API/ElevenLabs credentials without mutating parent',()=>{
  const source={PATH:'/bin',ANTHROPIC_API_KEY:'secret',ANTHROPIC_AUTH_TOKEN:'secret',ANTHROPIC_BASE_URL:'gateway',ANTHROPIC_MODEL:'gateway-model',CLAUDE_CODE_USE_GATEWAY:'1',ELEVENLABS_API_KEY:'secret',CLAUDE_CONFIG_DIR:'/elsewhere',CLAUDE_CODE_OAUTH_TOKEN:'subscription-token'};
  assert.deepEqual(subscriptionEnvironment(source),{PATH:'/bin',CLAUDE_CODE_OAUTH_TOKEN:'subscription-token'});
  assert.equal(source.ANTHROPIC_API_KEY,'secret');
});
test('readiness requires first-party subscription authentication',()=>{
  assert.equal(isSubscription({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}),true);
  for(const status of [{loggedIn:true,authMethod:'third_party',apiProvider:'gateway'},{loggedIn:true,authMethod:'api_key',apiProvider:'firstParty'},{loggedIn:false,authMethod:'claude.ai',apiProvider:'firstParty'}])assert.equal(isSubscription(status),false);
});
test('Claude launch retains subscription support and disables tools and unrelated customizations',()=>{
  const args=claudeArgs({system:'test',model:'explicit-model'});
  assert.ok(!args.includes('--bare'));assert.ok(args.includes('--safe-mode'));
  assert.equal(args[args.indexOf('--tools')+1],'');assert.equal(args[args.indexOf('--model')+1],'explicit-model');
  assert.ok(args.includes('--no-session-persistence'));
  assert.ok(!args.includes('--effort'));
  assert.equal(claudeArgs({system:'t',effort:'low'}).at(claudeArgs({system:'t',effort:'low'}).indexOf('--effort')+1),'low');
  assert.ok(!claudeArgs({system:'t',effort:'--bogus'}).includes('--effort'));
});
test('incremental speech chunks preserve text and complete bracket tags',()=>{
  const text='[curious] '+ 'A phrase with some natural space and a little room for thought. '.repeat(8)+'[laughs] Yes.';
  const chunker=new SpeechChunks(),chunks=[];
  for(let i=0;i<text.length;i+=3)chunks.push(...chunker.add(text.slice(i,i+3)));
  chunks.push(...chunker.add('',true));assert.equal(chunks.join(''),text);
  for(const part of chunks)assert.equal((part.match(/\[/g)||[]).length,(part.match(/\]/g)||[]).length);
  assert.throws(()=>new SpeechChunks().add('[unfinished',true),/unfinished/);
});
test('WAV header describes clean mono 24 kHz PCM',()=>{
  const h=wavHeader(48000);assert.equal(h.readUInt32LE(4),48036);assert.equal(h.readUInt16LE(22),1);assert.equal(h.readUInt32LE(24),24000);assert.equal(h.readUInt32LE(40),48000);
});
test('interrupted context distinguishes generated from heard',()=>{
  const data=historyForConversation([{id:'a',speaker:'claude',text:'An answer',status:'interrupted',audio_seconds:12,played_seconds:3}])[0];
  assert.equal(data.played_audio_seconds,3);assert.equal(data.text,'');assert.match(data.delivery_note,/exact words are unavailable/);
});
test('local server rejects other origins and rebinding hosts',()=>{
  assert.equal(allowRequest({headers:{host:'127.0.0.1:4318',origin:'http://127.0.0.1:4318'}},4318),true);
  assert.equal(allowRequest({headers:{host:'attacker.example:4318'}},4318),false);
  assert.equal(allowRequest({headers:{host:'127.0.0.1:4318',origin:'https://example.com'}},4318),false);
});
function childFor(messages,{hang=false}={}){
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.exitCode=null;
  child.kill=()=>{child.exitCode=143;child.emit('close',143);};
  child.stdin.on('finish',()=>setImmediate(()=>{for(const m of messages){const line=JSON.stringify(m)+'\n';const at=Math.floor(line.length/2);child.stdout.write(line.slice(0,at));child.stdout.write(line.slice(at));}if(!hang){child.exitCode=0;child.emit('close',0);}}));return child;
}
test('Claude stream speaks only text deltas and does not repeat final text',async()=>{
  const messages=[{type:'stream_event',event:{delta:{type:'thinking_delta',thinking:'Private reasoning'}}},{type:'stream_event',event:{delta:{type:'text_delta',text:'[curious] Hello.'}}},{type:'result',result:'[curious] Hello.',is_error:false}];
  let received='';const result=await runVerifiedClaude({prompt:'hi',system:'test',onText:t=>received+=t,spawnProcess:()=>childFor(messages)});
  assert.equal(received,'[curious] Hello.');assert.equal(result.text,received);
});
test('callback failure stops Claude and becomes an ordinary error',async()=>{
  await assert.rejects(runVerifiedClaude({prompt:'hi',system:'test',onText:()=>{throw new Error('output rejected');},spawnProcess:()=>childFor([{type:'stream_event',event:{delta:{type:'text_delta',text:'Hello.'}}}],{hang:true})}),/output rejected|code 143/);
});
test('abort stops a running Claude process',async()=>{
  const controller=new AbortController();const result=runVerifiedClaude({prompt:'hi',system:'test',signal:controller.signal,spawnProcess:()=>childFor([],{hang:true})});
  controller.abort();await assert.rejects(result,/Interrupted|code 143/);
});
test('Claude resumes its own session with a stable system prompt and never speaks thinking or replayed answers', async () => {
  const session = { id: '11111111-1111-4111-8111-111111111111', cwd: '/call/claude' };
  let args, options, seen; const spoken = [];
  await runVerifiedClaude({ prompt: 'Next room update', system: 'Current instructions', session, onSession: id => { seen = id; }, onText: text => spoken.push(text),
    spawnProcess: (_, a, o) => { args = a; options = o; return childFor([
      { type: 'system', subtype: 'init', session_id: session.id, model: 'claude-opus-5-5' },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Private history' }, { type: 'text', text: 'Old answer' }] } },
      { type: 'stream_event', event: { delta: { type: 'thinking_delta', thinking: 'Private current thought' } } },
      { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'New answer.' } } },
      { type: 'result', result: 'New answer.', is_error: false },
    ]); } });
  assert.equal(args[args.indexOf('--resume') + 1], session.id); assert.ok(!args.includes('--no-session-persistence'));
  assert.equal(args[args.indexOf('--system-prompt-snapshot') + 1], 'on'); assert.equal(options.cwd, session.cwd);
  assert.equal(seen, session.id); assert.deepEqual(spoken, ['New answer.']);
});
test('persistent Claude cancellation waits for the child to close before it can be resumed', async () => {
  const controller = new AbortController(), child = childFor([], { hang: true }); let killed = false, settled = false;
  child.kill = () => { killed = true; };
  const result = runVerifiedClaude({ prompt: 'hi', system: 't', session: { cwd: '/room' }, signal: controller.signal, spawnProcess: () => child });
  const rejection = assert.rejects(result, { name: 'AbortError' }).then(() => { settled = true; });
  controller.abort(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(killed, true); assert.equal(settled, false);
  child.exitCode = 143; child.emit('close', 143); await rejection;
});
test('API-key mode passes only ANTHROPIC_API_KEY through; gateway overrides are still removed',()=>{
  const source={PATH:'/bin',INTERVIEW_CLAUDE_AUTH:'api',ANTHROPIC_API_KEY:'sk-ant-test',ANTHROPIC_BASE_URL:'gateway',ANTHROPIC_AUTH_TOKEN:'x',ELEVENLABS_API_KEY:'secret',X_STREAM_KEY:'secret'};
  assert.equal(claudeAuthMode(source),'api');assert.equal(claudeAuthMode({}),'subscription');
  assert.deepEqual(subscriptionEnvironment(source),{PATH:'/bin',ANTHROPIC_API_KEY:'sk-ant-test'});
  assert.deepEqual(subscriptionEnvironment({...source,INTERVIEW_CLAUDE_AUTH:''}),{PATH:'/bin'});
});
test('images switch Claude to streaming input: one JSON user message with labelled image blocks, then the prompt',async()=>{
  let args,stdin='';const result=await runVerifiedClaude({prompt:'{"conversation":[]}',system:'test',images:[{data:'AAAA',label:'Frame 1'}],
    spawnProcess:(bin,a)=>{args=a;const c=childFor([{type:'stream_event',event:{delta:{type:'text_delta',text:'I see it.'}}},{type:'result',result:'I see it.',is_error:false}]);c.stdin.on('data',d=>stdin+=d);return c;}});
  assert.equal(args[args.indexOf('--input-format')+1],'stream-json');
  const msg=JSON.parse(stdin);assert.equal(msg.type,'user');assert.equal(msg.message.role,'user');
  assert.deepEqual(msg.message.content.map(b=>b.type),['text','image','text']);
  assert.equal(msg.message.content[1].source.media_type,'image/jpeg');assert.equal(msg.message.content[2].text,'{"conversation":[]}');
  assert.equal(result.text,'I see it.');
  let plainArgs;await runVerifiedClaude({prompt:'hi',system:'t',spawnProcess:(b,a)=>{plainArgs=a;return childFor([{type:'result',result:'ok',is_error:false}]);}});
  assert.ok(!plainArgs.includes('--input-format'),'calls without images are unchanged');
});

test('shared history distinguishes prior visual observations from replies with no images',()=>{
  const history=historyForConversation([
    {id:'saw',speaker:'codex',text:'The card says 5837.',status:'delivered',seen:[{file:'private-path.jpg',at_ms:1200,source:'camera'}]},
    {id:'blind',speaker:'claude',text:'I have no current image.',status:'delivered'},
  ]);
  assert.deepEqual(history[0].visual_context,{frames:1,source:'camera',captured_at_ms:[1200]});
  assert.deepEqual(history[1].visual_context,{frames:0});
  assert.ok(!JSON.stringify(history).includes('private-path'),'the shared transcript needs provenance, not disk paths');
});

test('both agents share only heard words, while the gated listener can prepare against the full current reply',()=>{
  const turns=[
    {id:'human',speaker:'user',text:'Keep the budget under twenty pounds.'},
    {id:'cut',speaker:'claude',text:'Use a telescope. The secret code is 9274.',heard_text:'Use a telescope.',status:'interrupted',played_seconds:1},
    {id:'failed',speaker:'codex',text:'This never played.',status:'error'},
    {id:'playing',speaker:'codex',text:'We could use binoculars instead.',status:'thinking'},
  ];
  const ordinary=historyForConversation(turns),prepared=historyForConversation(turns,{expectedTurnId:'playing'});
  assert.equal(ordinary[1].text,'Use a telescope.');assert.equal(ordinary[2].text,'');assert.equal(ordinary[3].text,'');
  assert.equal(prepared[3].text,'We could use binoculars instead.');assert.match(prepared[3].delivery_note,/must finish/);
  assert.ok(!JSON.stringify(prepared).includes('9274'));assert.ok(!JSON.stringify(prepared).includes('never played'));
  assert.equal(turns[1].text,'Use a telescope. The secret code is 9274.','the archived output stays intact');
});

test('playback alignment produces whole words and never leaks an unfinished voice cue',()=>{
  const raw='[curious] One small step.';
  const alignment=[...raw].map((ch,i)=>({ch,end:(i+1)/10}));
  assert.equal(heardSpeech(alignment,.4),'');
  assert.equal(heardSpeech(alignment,1.6),'One');
  assert.equal(heardSpeech(alignment,2),'One small');
  assert.equal(heardSpeech(alignment,99),'One small step.');
});

test('long calls retain the opening request and recent turns in a shared bounded window without changing the archive',()=>{
  const turns=[{speaker:'user',text:'Plan a quiet observatory for our village.'},...Array.from({length:1200},(_,i)=>({id:String(i),speaker:i%2?'codex':'claude',text:`Point ${i}: ${'a useful observation '.repeat(20)}`,status:'delivered'}))];
  const before=JSON.stringify(turns),context=conversationContext(turns);
  assert.ok(JSON.stringify(context).length<121000);assert.match(context.context_note,/earlier turns/);
  assert.equal(context.conversation[0].text,turns[0].text);assert.equal(context.conversation.at(-1).text,turns.at(-1).text);
  assert.equal(JSON.stringify(turns),before);assert.deepEqual(conversationContext(turns),context);
});

test('a short opening sentence reaches speech synthesis before the model finishes the next sentence',()=>{
  const chunks=new SpeechChunks();
  assert.deepEqual(chunks.add('I would start with binoculars. Then we can'),['I would start with binoculars.']);
  assert.equal(chunks.add(' decide on a telescope.',true).join(''),' Then we can decide on a telescope.');
});
