import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createStudio,ROOT } from '../src/server.mjs';
const subscribed={mode:'subscription',loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionVerified:true,ready:true};
class TestVoice{
  constructor({onAudio}){this.onAudio=onAudio;this.done=new Promise(resolve=>this.resolve=resolve);}
  write(){this.onAudio(Buffer.alloc(4800));}
  end(){this.resolve();return this.done;}
}
async function fixture(t,auth=subscribed,extra={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-interview-test-'));
  fs.cpSync(path.join(ROOT,'prompts'),path.join(root,'prompts'),{recursive:true});fs.rmSync(path.join(root,'prompts','conversation.md'),{force:true});fs.cpSync(path.join(ROOT,'public'),path.join(root,'public'),{recursive:true});
  const studio=createStudio({root,auth:async()=>auth,initialKey:'',storeKey:async()=>{},loadStreamKey:async()=>'',getVoices:async()=>[{voice_id:'voice-1',name:'Test Voice'}],Voice:TestVoice,
    claude:async({schema,onText,onModel})=>{onModel?.('test-fixture-model');if(schema)return{structured:{voice_id:'voice-1',rationale:'Fixture only',opening:'[curious] Hello.'}};onText('[curious] A test answer.');return{text:'[curious] A test answer.'};},...extra});
  studio.server.listen(0,'127.0.0.1');await once(studio.server,'listening');
  const base=`http://127.0.0.1:${studio.server.address().port}`;
  const home=await fetch(base);const cookie=home.headers.get('set-cookie').split(';')[0];await home.text();
  const api=async(route,data,options={})=>{const response=await fetch(base+route,{headers:{Cookie:cookie,Origin:base,'Content-Type':Buffer.isBuffer(data)?'video/webm':'application/json',...options.headers},...(data!==undefined?{method:'POST',body:Buffer.isBuffer(data)?data:JSON.stringify(data)}:{}),...options});return{status:response.status,data:await response.json()};};
  t.after(async()=>{studio.shutdown();await once(studio.server,'close');fs.rmSync(root,{recursive:true,force:true});});
  return{api,base,root,cookie};
}
test('preflight refuses a live call without verified subscription',async t=>{
  const{api}=await fixture(t,{mode:'subscription',loggedIn:false,subscriptionVerified:false,ready:false});const r=await api('/api/sessions',{});assert.equal(r.status,409);assert.match(r.data.error,/subscription/);
});
test('credential endpoint never returns the key or writes a project env file',async t=>{
  const{api,root}=await fixture(t);const r=await api('/api/settings',{api_key:'test-secret'});assert.equal(r.status,200);assert.ok(!JSON.stringify(r).includes('test-secret'));assert.ok(!fs.existsSync(path.join(root,'.env')));
});
test('session keeps generated and played speech distinct; upload retries are idempotent',async t=>{
  const{api,root}=await fixture(t);await api('/api/settings',{api_key:'test-secret'});
  const create=await api('/api/sessions',{voice_id:'auto',tts_model:'eleven_v3_conversational'});assert.equal(create.status,201);const id=create.data.id,base=`/api/sessions/${id}`;
  const turnId=randomUUID(),requestId=randomUUID();await api(base+'/turn',{reply_id:turnId,request_id:requestId,introduction:true});
  let session;for(let i=0;i<30;i++){session=(await api(base)).data;if(session.turns[0]?.status==='generated')break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(session.voice.voice_id,'voice-1');assert.equal(session.turns[0].status,'generated');assert.equal(session.turns[0].played_seconds,0);
  const wav=fs.readFileSync(path.join(root,'recordings',id,session.turns[0].audio_file));assert.equal(wav.readUInt32LE(40),4800);
  await api(base+'/event',{type:'audio-playback',turn_id:turnId,played_seconds:.05});await api(base+'/interrupt',{turn_id:turnId});
  session=(await api(base)).data;assert.equal(session.turns[0].status,'interrupted');assert.equal(session.turns[0].played_seconds,.05);
  assert.equal((await api(base+'/media?name=user-camera.webm&seq=0',Buffer.from('chunk-zero'))).status,200);
  const retry=await api(base+'/media?name=user-camera.webm&seq=0',Buffer.from('chunk-zero'));assert.equal(retry.data.duplicate,true);
  assert.equal((await api(base+'/media?name=user-camera.webm&seq=2',Buffer.from('out-of-order'))).status,409);
  assert.equal((await api(base+'/media?name=../escape&seq=0',Buffer.from('bad'))).status,400);
  assert.equal(fs.readFileSync(path.join(root,'recordings',id,'user-camera.webm'),'utf8'),'chunk-zero');
  assert.equal((await api(base+'/end',{})).data.status,'ended');
});
test('session records model and effort choices and rejects invalid effort',async t=>{
  const{api}=await fixture(t);await api('/api/settings',{api_key:'test-secret'});
  assert.equal((await api('/api/sessions',{claude_effort:'extreme'})).status,400);
  const ok=await api('/api/sessions',{claude_model:'sonnet',claude_effort:'low'});assert.equal(ok.status,201);
  assert.equal(ok.data.settings.claude_model,'sonnet');assert.equal(ok.data.settings.claude_effort,'low');
  await api(`/api/sessions/${ok.data.id}/end`,{});
});
test('a preselected voice skips live voice choice; model and effort can change mid-call',async t=>{
  let schemaCalls=0;const{api}=await fixture(t,subscribed,{claude:async({schema,onText,onModel,effort,model})=>{onModel?.(model||'m');if(schema){schemaCalls++;return{structured:{voice_id:'voice-1',rationale:'',opening:'Hi.'}};}onText(`Hello (${effort}).`);return{text:'Hello.'};}});
  await api('/api/settings',{api_key:'test-secret'});
  const{data:s}=await api('/api/sessions',{voice_id:'voice-1',claude_effort:'low'});const base=`/api/sessions/${s.id}`;
  assert.equal(s.voice.voice_id,'voice-1');
  assert.equal((await api(base+'/config',{claude_effort:'huge'})).status,400);
  assert.equal((await api(base+'/config',{claude_model:'sonnet',claude_effort:'high'})).data.settings.claude_effort,'high');
  assert.equal((await api(base+'/config',{voice_id:'missing'})).status,400);
  assert.equal((await api(base+'/config',{voice_id:'voice-1',topic:'New topic'})).data.settings.topic,'New topic');
  await api(base+'/turn',{request_id:randomUUID(),reply_id:randomUUID(),introduction:true});
  let session;for(let i=0;i<30;i++){session=(await api(base)).data;if(session.turns[0]?.status==='generated')break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(schemaCalls,0);assert.equal(session.turns[0].text,'Hello (high).');assert.equal(session.actual_model,'sonnet');
  await api(base+'/end',{});
});
test('conversation prompt is editable, resettable, used on the next reply, and copied into each session',async t=>{
  let seen;const{api,root}=await fixture(t,subscribed,{claude:async({schema,system,onText,onModel})=>{onModel?.('m');if(schema)return{structured:{voice_id:'voice-1',rationale:'',opening:'Hi.'}};seen=system;onText('Ok.');return{text:'Ok.'};}});
  fs.writeFileSync(path.join(root,'prompts','conversation.default.md'),'Default prompt.');
  await api('/api/settings',{api_key:'test-secret'});
  assert.equal((await api('/api/prompt',{text:''})).status,400);
  assert.equal((await api('/api/prompt',{text:'Edited prompt.'})).data.is_default,false);
  const{data:s}=await api('/api/sessions',{voice_id:'voice-1'});const base=`/api/sessions/${s.id}`;
  assert.equal(fs.readFileSync(path.join(root,'recordings',s.id,'system-prompt.md'),'utf8'),'Edited prompt.');
  await api(base+'/turn',{text:'Hello',request_id:randomUUID(),reply_id:randomUUID()});await new Promise(r=>setTimeout(r,30));
  assert.ok(seen.startsWith('Edited prompt.\n\n'),'the edited prompt is used, followed only by the per-turn vision note');assert.match(seen,/see the person you're talking with/);
  assert.equal((await api('/api/prompt',{reset:true})).data.text,'Default prompt.');
  await api(base+'/end',{});
});
test('visuals: a quick sketch by a fast model, then the finished picture developed from it by a stronger model',async t=>{
  const calls=[];const{api,base,root,cookie}=await fixture(t,subscribed,{claude:async({system,schema,onText,onModel,model,effort,prompt})=>{
    if(system.includes('moving picture')){const input=JSON.parse(prompt);calls.push({model,effort,input});
      onText('{"visual": true, "title": "Far future", "subject": "a city under glass", "composition": "dome centre, towers left", "shot": "wide establishing landscape", "base": "city", "words": ["3026"], "palette": ["#112233"]}\n');
      onText(input.stage==='sketch'?'---\nfunction draw(ctx,t,env){ctx.fillRect(0,0,W,H);}\n':'---\nfunction draw(ctx,t,env){ctx.fillStyle="#123";ctx.fillRect(0,0,W,H);ctx.fillRect(1,1,2,2);}\n');return{text:''};}
    onModel?.('m');onText('Ok.');return{text:'Ok.'};}});
  await api('/api/settings',{api_key:'test-secret'});
  const{data:s}=await api('/api/sessions',{voice_id:'voice-1',visuals:'always',style:'riso'});const route=`/api/sessions/${s.id}`;
  await api(route+'/turn',{text:'What will the world look like in a thousand years?',request_id:randomUUID(),reply_id:randomUUID()});
  let session;for(let i=0;i<60;i++){session=(await api(route)).data;if(session.scenes.some(x=>!x.sketch))break;await new Promise(r=>setTimeout(r,10));}
  assert.deepEqual(calls.map(c=>[c.model,c.effort,c.input.stage]),[['claude-sonnet-5','low','sketch'],['claude-opus-5-5','low','final']]);
  assert.match(calls[1].input.sketch.code,/function draw/);assert.equal(calls[1].input.sketch.header.composition,'dome centre, towers left');
  assert.equal(session.scenes.length,1,'the finished picture replaces its sketch in the record');
  const scene=session.scenes[0];assert.equal(scene.id,'scene-001');assert.equal(scene.base,'city');assert.equal(scene.style,'riso');assert.equal(scene.sketch_file,'scenes/scene-001-sketch.js');
  assert.match(fs.readFileSync(path.join(root,'recordings',s.id,scene.file),'utf8'),/fillStyle="#123"/);
  const events=fs.readFileSync(path.join(root,'recordings',s.id,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(e=>/^scene-/.test(e.type)).map(e=>`${e.type}:${e.scene_id}${e.refine?':refine':''}`);
  assert.deepEqual(events,['scene-start:scene-001','scene-base:scene-001-sketch','scene-ready:scene-001-sketch','scene-base:scene-001:refine','scene-ready:scene-001']);
  for(const id of ['scene-001','scene-001-sketch']){const frame=await fetch(`${base}/scene-frame/${s.id}/${id}`,{headers:{Cookie:cookie}});assert.equal(frame.status,200);
    assert.match(frame.headers.get('content-security-policy'),/sandbox allow-scripts/);assert.match(frame.headers.get('content-security-policy'),/connect-src 'none'/);assert.match(await frame.text(),/"background":"#f3eee4"/);}
  assert.equal((await api(route+'/config',{visuals:'sometimes'})).status,400);
  await api(route+'/end',{});
});
test('backdrops: a separate call paints the user\'s backdrop and may keep the current one; library bases do not repeat',async t=>{
  let backdropCalls=0;const{api,base,cookie}=await fixture(t,subscribed,{claude:async({system,onText,onModel})=>{
    if(system.includes('ambient backdrop')){backdropCalls++;onText(backdropCalls===1?'{"backdrop": true, "title": "Quiet harbour at dusk"}\n---\nfunction draw(ctx,t){ctx.fillRect(0,0,W,H);}':'{"backdrop": false}');return{text:''};}
    if(system.includes('moving picture')){onText('{"visual": true, "title": "Again", "base": "city", "words": [], "palette": []}\n---\nfunction draw(ctx){}');return{text:''};}
    onModel?.('m');onText('Ok.');return{text:'Ok.'};}});
  await api('/api/settings',{api_key:'test-secret'});
  const{data:s}=await api('/api/sessions',{voice_id:'voice-1',visuals:'always',backdrops:true});const route=`/api/sessions/${s.id}`;
  for(let i=0;i<2;i++){await api(route+'/turn',{text:`Turn ${i}`,request_id:randomUUID(),reply_id:randomUUID()});await new Promise(r=>setTimeout(r,60));}
  const session=(await api(route)).data;
  assert.equal(session.backdrops.length,1);assert.equal(session.backdrops[0].title,'Quiet harbour at dusk');
  assert.notEqual(session.scenes[0].base,session.scenes[1].base);
  const frame=await fetch(`${base}/scene-frame/${s.id}/${session.backdrops[0].id}`,{headers:{Cookie:cookie}});assert.match(frame.headers.get('content-security-policy'),/sandbox allow-scripts/);
  await api(route+'/end',{});
});
test('browser backups are recovered beside the originals without overwriting them',async t=>{
  const{api,root}=await fixture(t);await api('/api/settings',{api_key:'test-secret'});
  const{data:s}=await api('/api/sessions',{voice_id:'voice-1'});await api(`/api/sessions/${s.id}/end`,{});
  const body=Buffer.from('complete-backup-bytes');
  const r=await api(`/api/recordings/${s.id}/recover?name=user-camera.webm&bytes=${body.length}&contiguous=1`,body);
  assert.equal(r.status,200);assert.equal(r.data.file,'user-camera.recovered.webm');
  assert.equal(fs.readFileSync(path.join(root,'recordings',s.id,'user-camera.recovered.webm'),'utf8'),'complete-backup-bytes');
  assert.equal((await api(`/api/recordings/${s.id}/recover?name=user-camera.webm`,Buffer.from('other'))).data.already,true);
  assert.equal((await api(`/api/recordings/${s.id}/recover?name=stage.webm&bytes=999`,body)).status,400);
  assert.equal((await api(`/api/recordings/${s.id}/recover?name=../x.webm`,body)).status,400);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'recordings',s.id,'session.json'))).media['user-camera.recovered.webm'].recovered_from_browser_backup,true);
});
test('lossless voice stems upload as PCM and become 48 kHz WAV files; stems can be recovered too',async t=>{
  const{api,root}=await fixture(t);await api('/api/settings',{api_key:'test-secret'});
  const{data:s}=await api('/api/sessions',{voice_id:'voice-1'});const base=`/api/sessions/${s.id}`,dir=path.join(root,'recordings',s.id);
  await api(base+'/event',{type:'media-start',name:'user-voice.pcm',mime_type:'audio/pcm;rate=48000',sample_rate:48000});
  await api(base+'/media?name=user-voice.pcm&seq=0',Buffer.from([1,0,2,0]));await api(base+'/media?name=user-voice.pcm&seq=1',Buffer.from([3,0]));
  assert.equal((await api(base+'/event',{type:'media-complete',name:'user-voice.pcm',bytes:6,sample_rate:44})).status,400);
  assert.equal((await api(base+'/event',{type:'media-complete',name:'user-voice.pcm',bytes:6,sample_rate:48000})).status,200);
  const wav=fs.readFileSync(path.join(dir,'user-voice.wav'));assert.equal(wav.readUInt32LE(24),48000);assert.equal(wav.readUInt32LE(40),6);assert.deepEqual([...wav.subarray(44)],[1,0,2,0,3,0]);
  assert.ok(!fs.existsSync(path.join(dir,'user-voice.pcm')));
  const snap=(await api(base)).data;assert.equal(snap.media['user-voice.wav'].complete,true);
  await api(base+'/end',{});
  const r=await api(`/api/recordings/${s.id}/recover?name=claude-voice.pcm&bytes=4&rate=48000`,Buffer.from([9,0,8,0]));
  assert.equal(r.data.file,'claude-voice.recovered.wav');assert.equal(fs.readFileSync(path.join(dir,'claude-voice.recovered.wav')).readUInt32LE(24),48000);
});
test('scene stream parser tolerates fences and rejects code without draw()',async()=>{
  const{SceneStream,checkSceneCode}=await import('../src/director.mjs');
  const st=new SceneStream();st.add('```\n{"visual":true,"title":"x",');assert.equal(st.header,null);st.add('"base":"nope"}');assert.equal(st.header.visual,true);st.add('\n---\n```js\nfunction draw(){}\n```');
  assert.equal(st.header.base,'field');assert.equal(checkSceneCode(st.code()),'function draw(){}');
  assert.throws(()=>checkSceneCode('function setup(){}'));assert.throws(()=>checkSceneCode('function draw( {'));
  const none=new SceneStream();none.add('{"visual": false}');assert.equal(none.header.visual,false);
});
test('wrong origins cannot change credentials',async t=>{
  const{base}=await fixture(t);const response=await fetch(base+'/api/settings',{method:'POST',headers:{Origin:'https://example.com'},body:'{}'});assert.equal(response.status,403);
});
class TestScribe {
  static current;
  constructor(options){this.options=options;this.ready=Promise.resolve();this.audio=[];TestScribe.current=this;}
  write(bytes){this.audio.push(Buffer.from(bytes));}
  close(){this.closed=true;}
}
test('recognition stays in backend, joins timestamp commits once, and saves muted PCM as silence',async t=>{
  const{api,root}=await fixture(t,subscribed,{Scribe:TestScribe});await api('/api/settings',{api_key:'test-secret'});
  const {data:s}=await api('/api/sessions',{});const base=`/api/sessions/${s.id}`;
  assert.equal((await api(base+'/scribe-token',{})).status,404);
  const listen=await api(base+'/listen',{});assert.equal(listen.status,200);assert.ok(!JSON.stringify(listen.data).includes('token'));
  const recognizer=TestScribe.current;
  assert.equal((await api(base+'/input-audio',Buffer.from([1,0,2,0]))).status,200);
  await api(base+'/mute',{muted:true});await api(base+'/input-audio',Buffer.from([3,0,4,0]));
  assert.deepEqual(recognizer.audio[1],Buffer.alloc(4));await api(base+'/mute',{muted:false});
  recognizer.options.onMessage({message_type:'committed_transcript',text:'A spoken fixture.'});
  recognizer.options.onMessage({message_type:'committed_transcript_with_timestamps',text:'A spoken fixture.',words:[{text:'spoken',start:.1,end:.2}]});
  await new Promise(resolve=>setTimeout(resolve,450));
  const current=(await api(base)).data;assert.equal(current.turns.filter(t=>t.speaker==='user').length,1);assert.equal(current.turns[0].words.length,1);
  await api(base+'/end',{});assert.equal(recognizer.closed,true);
  const wav=fs.readFileSync(path.join(root,'recordings',s.id,'user-microphone.wav'));assert.equal(wav.readUInt32LE(24),16000);assert.equal(wav.readUInt32LE(40),8);assert.deepEqual(wav.subarray(48),Buffer.alloc(4));
});
test('interrupt after generation marks the pending playback turn',async t=>{
  const {api}=await fixture(t);await api('/api/settings',{api_key:'test-secret'});const {data:s}=await api('/api/sessions',{});const base=`/api/sessions/${s.id}`;
  await api(base+'/turn',{request_id:randomUUID(),reply_id:randomUUID(),introduction:true});await new Promise(resolve=>setTimeout(resolve,20));
  await api(base+'/interrupt',{});assert.equal((await api(base)).data.turns[0].status,'interrupted');
});
test('key persistence happens only after provider validation',async t=>{
  let stored=0;const {api}=await fixture(t,subscribed,{getVoices:async()=>{throw new Error('Invalid key');},storeKey:async()=>stored++});
  assert.equal((await api('/api/settings',{api_key:'rejected-secret'})).status,500);assert.equal(stored,0);
});
test('observer disconnect preserves call; controller disconnect ends it',async t=>{
  const {api,base,cookie}=await fixture(t);await api('/api/settings',{api_key:'test-secret'});const {data:s}=await api('/api/sessions',{});const route=`/api/sessions/${s.id}`;
  const observer=await fetch(base+route+'/events',{headers:{Cookie:cookie}});await observer.body.cancel();await new Promise(r=>setTimeout(r,20));assert.equal((await api(route)).data.status,'active');
  const controller=await fetch(base+route+'/events?controller=1',{headers:{Cookie:cookie}});await controller.body.cancel();await new Promise(r=>setTimeout(r,20));assert.equal((await api(route)).data.status,'ended');
});
test('visuals: a new turn never cancels a picture in progress; one follow-up runs after it and may keep it',async t=>{
  const prompts=[];let release;const first=new Promise(r=>release=r);
  const{api,base,cookie}=await fixture(t,subscribed,{claude:async({system,onText,onModel,prompt,signal})=>{
    if(system.includes('moving picture')){const input=JSON.parse(prompt);prompts.push(input);
      if(prompts.length===1){onText('{"visual": true, "title": "Eddies in a cup", "subject": "tea swirling into turbulent eddies", "shot": "close-up", "base": "waves"}\n');await first;
        if(signal?.aborted)throw new DOMException('Interrupted','AbortError');onText('---\nfunction draw(ctx,t,env){ctx.fillRect(0,0,W,H);}\n');return{text:''};}
      if(input.stage==='final'){onText(JSON.stringify(input.sketch.header)+'\n---\nfunction draw(ctx,t,env){ctx.fillRect(0,0,W,H);}\n');return{text:''};}
      onText('{"visual": "keep"}');return{text:''};}
    onModel?.('m');onText('Ok.');return{text:'Ok.'};}});
  await api('/api/settings',{api_key:'test-secret'});
  const{data:s}=await api('/api/sessions',{voice_id:'voice-1',visuals:'always'});const route=`/api/sessions/${s.id}`;
  const say=text=>api(route+'/turn',{text,request_id:randomUUID(),reply_id:randomUUID()});
  await say('Tell me about Navier-Stokes.');await new Promise(r=>setTimeout(r,20));
  await say('And turbulence?');await say('Why is it hard?');await new Promise(r=>setTimeout(r,20));
  assert.equal(prompts.length,1,'the in-flight picture is not restarted');
  release();let session;for(let i=0;i<80;i++){session=(await api(route)).data;if(prompts.length===3&&session.scenes.some(x=>!x.sketch))break;await new Promise(r=>setTimeout(r,10));}
  await new Promise(r=>setTimeout(r,30));
  assert.deepEqual(prompts.map(p=>p.stage),['sketch','final','sketch'],'sketch, its finished version, then exactly one queued follow-up');
  assert.equal(session.scenes.length,1);assert.equal(session.scenes[0].subject,'tea swirling into turbulent eddies');assert.equal(session.scenes[0].shot,'close-up');
  assert.equal(prompts[2].on_screen_now.title,'Eddies in a cup');assert.deepEqual(prompts[2].canvas,{width:888,height:560});
  assert.ok(prompts[2].conversation.some(x=>x.text==='Why is it hard?'),'the follow-up sees the latest turn');
  const frame=await (await fetch(`${base}/scene-frame/${s.id}/${session.scenes[0].id}`,{headers:{Cookie:cookie}})).text();
  assert.match(frame,/const W=888,H=560;/);
  const events=fs.readFileSync(path.join(session.recording_directory,'events.jsonl'),'utf8');assert.match(events,/"scene-keep"/);
  await api(route+'/end',{});
});
test('vision: camera stills from the turn go to Claude, are saved beside the recording, and can be switched off',async t=>{
  const calls=[];const{api}=await fixture(t,subscribed,{claude:async({system,images,schema,onText,onModel})=>{
    if(system.includes('moving picture')||system.includes('ambient backdrop'))return{text:''};
    calls.push({system,images});onModel?.('m');onText('Nice mug.');return{text:'Nice mug.'};}});
  await api('/api/settings',{api_key:'test-secret'});
  const{data:s}=await api('/api/sessions',{voice_id:'voice-1'});const route=`/api/sessions/${s.id}`;assert.equal(s.settings.vision_level,'few');
  const jpeg=n=>Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),Buffer.from('frame-'+n)]);
  assert.equal((await api(route+'/frame',Buffer.from('not a jpeg'))).status,400);
  await api(route+'/frame',jpeg(1));await new Promise(r=>setTimeout(r,1300));await api(route+'/frame',jpeg(2));
  await api(route+'/turn',{text:'Look at this mug.',request_id:randomUUID(),reply_id:randomUUID()});
  let session;for(let i=0;i<50;i++){session=(await api(route)).data;if(session.turns.some(x=>x.speaker==='claude'&&x.status==='generated'))break;await new Promise(r=>setTimeout(r,10));}
  const reply=calls.at(-1);assert.equal(reply.images.length,2,'start and end of the turn');
  assert.match(reply.images[0].label,/Frame 1 of 2 .* s before they finished/);assert.match(reply.images[1].label,/as they finished speaking/);
  assert.equal(Buffer.from(reply.images[1].data,'base64').toString().slice(4),'frame-2');assert.match(reply.system,/You can see the person you're talking with/);
  const seen=session.turns.find(x=>x.speaker==='claude').seen;assert.equal(seen.length,2);
  assert.equal(fs.readFileSync(path.join(session.recording_directory,seen[1].file)).subarray(4).toString(),'frame-2');
  await api(route+'/config',{vision:false});await api(route+'/frame',jpeg(3));
  await api(route+'/turn',{text:'And now?',request_id:randomUUID(),reply_id:randomUUID()});
  for(let i=0;i<50&&calls.length<2;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(calls.at(-1).images.length,0);assert.match(calls.at(-1).system,/can't see the person you're talking with/);
  await api(route+'/end',{});
});
test('vision levels: live sends every still since the last reply, still sends one, and unknown levels are refused',async t=>{
  const calls=[];const{api}=await fixture(t,subscribed,{claude:async({system,images,onText,onModel})=>{
    if(system.includes('moving picture')||system.includes('ambient backdrop'))return{text:''};
    calls.push({system,images});onModel?.('m');onText('Ok.');return{text:'Ok.'};}});
  await api('/api/settings',{api_key:'test-secret'});
  const{data:s}=await api('/api/sessions',{voice_id:'voice-1',vision_level:'live'});const route=`/api/sessions/${s.id}`;assert.equal(s.settings.vision_level,'live');
  const jpeg=n=>Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),Buffer.from('f'+n)]);
  const turn=async text=>{const before=calls.length;await api(route+'/turn',{text,request_id:randomUUID(),reply_id:randomUUID()});for(let i=0;i<80&&calls.length===before;i++)await new Promise(r=>setTimeout(r,10));await new Promise(r=>setTimeout(r,20));return calls.at(-1);};
  for(let i=1;i<=5;i++)await api(route+'/frame',jpeg(i));
  const live=await turn('What am I doing?');assert.equal(live.images.length,5,'every still in the window');assert.match(live.system,/close to watching live/);
  assert.equal((await api(route+'/config',{vision_level:'blink'})).status,400);
  await api(route+'/config',{vision_level:'still'});for(let i=6;i<=8;i++)await api(route+'/frame',jpeg(i));
  const still=await turn('And now?');assert.equal(still.images.length,1);assert.equal(Buffer.from(still.images[0].data,'base64').subarray(4).toString(),'f8');
  await api(route+'/end',{});
});
test('visuals: the sketch starts while the person is still talking, and their finished turn does not ask again',async t=>{
  const prompts=[];const{api}=await fixture(t,subscribed,{Scribe:TestScribe,claude:async({system,onText,onModel,prompt})=>{
    if(system.includes('moving picture')){const input=JSON.parse(prompt);prompts.push(input);
      onText('{"visual": true, "title": "Kites over a harbour", "subject": "kites", "shot": "wide", "base": "field"}\n---\nfunction draw(ctx,t,env){ctx.fillRect(0,0,W,H);}\n');return{text:''};}
    if(system.includes('ambient backdrop'))return{text:''};
    onModel?.('m');onText('Ok.');return{text:'Ok.'};}});
  await api('/api/settings',{api_key:'test-secret'});
  const{data:s}=await api('/api/sessions',{voice_id:'voice-1',visuals:'always'});const route=`/api/sessions/${s.id}`;
  await api(route+'/listen',{});const hear=m=>TestScribe.current.options.onMessage(m);
  hear({message_type:'partial_transcript',text:'So I was down at the harbour'});
  assert.equal(prompts.length,0,'too early: not enough said yet');
  await new Promise(r=>setTimeout(r,3100));
  hear({message_type:'partial_transcript',text:'So I was down at the harbour watching people fly enormous kites'});
  for(let i=0;i<50&&prompts.length<1;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(prompts[0].stage,'sketch');const live=prompts[0].conversation.at(-1);
  assert.equal(live.still_speaking,true);assert.match(live.text,/enormous kites/);
  hear({message_type:'committed_transcript',text:'So I was down at the harbour watching people fly enormous kites.'});
  for(let i=0;i<80;i++){if((await api(route)).data.turns.some(x=>x.speaker==='claude'&&x.status==='generated'))break;await new Promise(r=>setTimeout(r,10));}
  await new Promise(r=>setTimeout(r,50));
  assert.deepEqual(prompts.map(p=>p.stage),['sketch','final'],'no second picture decision for the same speech');
  assert.ok(!prompts[1].conversation.some(x=>x.still_speaking),'the finishing pass sees the committed turn');
  await api(route+'/end',{});
});
test('API-key mode without a key refuses a call and says what is missing',async t=>{
  const{api}=await fixture(t,{mode:'api',apiKeySet:false,ready:false});await api('/api/settings',{api_key:'test-secret'});
  const r=await api('/api/sessions',{});assert.equal(r.status,409);assert.match(r.data.error,/ANTHROPIC_API_KEY/);
});
test('the person\'s name is optional, cleaned, and added to Claude\'s prompt only for that call',async t=>{
  const systems=[];
  const{api,root}=await fixture(t,subscribed,{claude:async({system,schema,onText})=>{systems.push(system);if(schema)return{structured:{voice_id:'voice-1',rationale:'x',opening:'Hi.'}};onText('Hello.');return{text:'Hello.'};}});
  await api('/api/settings',{api_key:'test-secret'});
  const{data:s}=await api('/api/sessions',{user_name:'  Ada [whispers]\nLovelace ',voice_id:'voice-1'});
  assert.equal(s.settings.user_name,'Ada whispers Lovelace');
  await api(`/api/sessions/${s.id}/turn`,{text:'Hi there',request_id:randomUUID(),reply_id:randomUUID()});await new Promise(r=>setTimeout(r,30));
  assert.match(systems.at(-1),/The person you're talking with is called Ada whispers Lovelace\.\n/);
  assert.ok(!fs.readFileSync(path.join(root,'prompts','conversation.md'),'utf8').includes('Ada'));
  await api(`/api/sessions/${s.id}/end`,{});
  const{data:unnamed}=await api('/api/sessions',{voice_id:'voice-1'});assert.equal(unnamed.settings.user_name,'');
  await api(`/api/sessions/${unnamed.id}/turn`,{text:'Hi',request_id:randomUUID(),reply_id:randomUUID()});await new Promise(r=>setTimeout(r,30));
  assert.ok(!systems.at(-1).includes('talking with is called'));
});
test('a fresh checkout creates the editable prompt from the default',async t=>{
  const{api,root}=await fixture(t);
  const file=path.join(root,'prompts','conversation.md');assert.ok(fs.existsSync(file));
  assert.equal(fs.readFileSync(file,'utf8'),fs.readFileSync(path.join(root,'prompts','conversation.default.md'),'utf8'));
  assert.equal((await api('/api/prompt')).data.is_default,true);
});
test('streaming never takes a key from the page and refuses to start without a backend key',async t=>{
  const{api}=await fixture(t);
  const status=(await api('/api/broadcast/status')).data;assert.equal(status.key_set,false);assert.ok(!('key' in status));
  const r=await api('/api/broadcast/start',{mode:'x',url:'rtmps://va.pscp.tv:443/x',key:'page-supplied-key-123'});
  assert.equal(r.status,500);assert.match(r.data.error,/stream-key set/);
});
