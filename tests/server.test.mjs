import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import vm from 'node:vm';
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
  fs.cpSync(path.join(ROOT,'prompts'),path.join(root,'prompts'),{recursive:true});fs.rmSync(path.join(root,'prompts','conversation.md'),{force:true});fs.rmSync(path.join(root,'prompts','codex.md'),{force:true});fs.cpSync(path.join(ROOT,'public'),path.join(root,'public'),{recursive:true});
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
  let seen,input;const{api,root}=await fixture(t,subscribed,{claude:async({schema,system,prompt,onText,onModel})=>{onModel?.('m');if(schema)return{structured:{voice_id:'voice-1',rationale:'',opening:'Hi.'}};seen=system;input=JSON.parse(prompt);onText('Ok.');return{text:'Ok.'};}});
  fs.writeFileSync(path.join(root,'prompts','conversation.default.md'),'Default prompt.');
  await api('/api/settings',{api_key:'test-secret'});
  assert.equal((await api('/api/prompt',{text:''})).status,400);
  assert.equal((await api('/api/prompt',{text:'Edited prompt.'})).data.is_default,false);
  const{data:s}=await api('/api/sessions',{voice_id:'voice-1'});const base=`/api/sessions/${s.id}`;
  assert.equal(fs.readFileSync(path.join(root,'recordings',s.id,'system-prompt.md'),'utf8'),'Edited prompt.');
  await api(base+'/turn',{text:'Hello',request_id:randomUUID(),reply_id:randomUUID()});await new Promise(r=>setTimeout(r,30));
  assert.ok(seen.startsWith('Edited prompt.\n\n'),'the edited prompt is used, followed only by the per-turn vision note');assert.match(input.vision,/see the person you're talking with/);
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
  assert.match(frame,/W:\{get:\(\)=>888/);assert.match(frame,/H:\{get:\(\)=>560/);
  const events=fs.readFileSync(path.join(session.recording_directory,'events.jsonl'),'utf8');assert.match(events,/"scene-keep"/);
  await api(route+'/end',{});
});
test('vision: camera stills from the turn go to Claude, are saved beside the recording, and can be switched off',async t=>{
  const calls=[];const{api}=await fixture(t,subscribed,{claude:async({system,images,prompt,schema,onText,onModel})=>{
    if(system.includes('moving picture')||system.includes('ambient backdrop'))return{text:''};
    calls.push({system,images,prompt:JSON.parse(prompt)});onModel?.('m');onText('Nice mug.');return{text:'Nice mug.'};}});
  await api('/api/settings',{api_key:'test-secret'});
  const{data:s}=await api('/api/sessions',{voice_id:'voice-1'});const route=`/api/sessions/${s.id}`;assert.equal(s.settings.vision_level,'few');
  const jpeg=n=>Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),Buffer.from('frame-'+n)]);
  assert.equal((await api(route+'/frame',Buffer.from('not a jpeg'))).status,400);
  await api(route+'/frame',jpeg(1));await new Promise(r=>setTimeout(r,1300));await api(route+'/frame',jpeg(2));
  await api(route+'/turn',{text:'Look at this mug.',request_id:randomUUID(),reply_id:randomUUID()});
  let session;for(let i=0;i<50;i++){session=(await api(route)).data;if(session.turns.some(x=>x.speaker==='claude'&&x.status==='generated'))break;await new Promise(r=>setTimeout(r,10));}
  const reply=calls.at(-1);assert.equal(reply.images.length,2,'start and end of the turn');
  assert.match(reply.images[0].label,/Frame 1 of 2 .* s before they finished/);assert.match(reply.images[1].label,/as they finished speaking/);
  assert.equal(Buffer.from(reply.images[1].data,'base64').toString().slice(4),'frame-2');assert.match(reply.prompt.vision,/You can see the person you're talking with/);
  const seen=session.turns.find(x=>x.speaker==='claude').seen;assert.equal(seen.length,2);
  assert.equal(fs.readFileSync(path.join(session.recording_directory,seen[1].file)).subarray(4).toString(),'frame-2');
  await api(route+'/config',{vision:false});await api(route+'/frame',jpeg(3));
  await api(route+'/turn',{text:'And now?',request_id:randomUUID(),reply_id:randomUUID()});
  for(let i=0;i<50&&calls.length<2;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(calls.at(-1).images.length,0);assert.match(calls.at(-1).prompt.vision,/can't see the person you're talking with/);
  await api(route+'/end',{});
});
test('vision levels: live sends every still since the last reply, still sends one, and unknown levels are refused',async t=>{
  const calls=[];const{api}=await fixture(t,subscribed,{claude:async({system,images,prompt,onText,onModel})=>{
    if(system.includes('moving picture')||system.includes('ambient backdrop'))return{text:''};
    calls.push({system,images,prompt:JSON.parse(prompt)});onModel?.('m');onText('Ok.');return{text:'Ok.'};}});
  await api('/api/settings',{api_key:'test-secret'});
  const{data:s}=await api('/api/sessions',{voice_id:'voice-1',vision_level:'live'});const route=`/api/sessions/${s.id}`;assert.equal(s.settings.vision_level,'live');
  const jpeg=n=>Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),Buffer.from('f'+n)]);
  const turn=async text=>{const before=calls.length;await api(route+'/turn',{text,request_id:randomUUID(),reply_id:randomUUID()});for(let i=0;i<80&&calls.length===before;i++)await new Promise(r=>setTimeout(r,10));await new Promise(r=>setTimeout(r,20));return calls.at(-1);};
  for(let i=1;i<=5;i++)await api(route+'/frame',jpeg(i));
  const live=await turn('What am I doing?');assert.equal(live.images.length,5,'every still in the window');assert.match(live.prompt.vision,/close to watching live/);
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
  await until(api,route,s=>s.scenes.some(scene=>!scene.sketch));
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

const codexReady = { ready: true, subscriptionVerified: true, mode: 'subscription' };
const roomMocks = { codexAuth: async () => codexReady, getCodexModels: async () => [{ id: 'gpt-6-astra', efforts: ['low', 'high'] }, { id: 'gpt-6-luna', efforts: ['low'] }],
  getVoices: async () => [{ voice_id: 'voice-1', name: 'Claude Voice' }, { voice_id: 'voice-2', name: 'Codex Voice' }],
  followupDelay: 25, codex: async ({ onText, onModel }) => { onModel('gpt-6-astra'); onText('A distinct thought from Codex.'); } };
async function room(t, extra = {}) {
  const f = await fixture(t, subscribed, { ...roomMocks, ...extra }); await f.api('/api/settings', { api_key: 'test-secret' });
  const { data: s } = await f.api('/api/sessions', { voice_id: 'voice-1', codex_enabled: true, codex_voice_id: 'voice-2' });
  assert.ok(s.id); const base = `/api/sessions/${s.id}`;
  return { ...f, origin: f.base, base, id: s.id, turn: text => f.api(base + '/turn', { text, request_id: randomUUID(), reply_id: randomUUID() }) };
}
async function until(api, base, predicate) { for (let i = 0; i < 100; i++) { const s = (await api(base)).data; if (predicate(s)) return s; await new Promise(r => setTimeout(r, 5)); } throw new Error('Expected session state did not arrive.'); }
test('Codex preflight is optional and exact model/effort choices are validated', async t => {
  const { api } = await fixture(t, subscribed, { ...roomMocks, codexAuth: async () => ({ ready: false }) }); await api('/api/settings', { api_key: 'test-secret' });
  assert.equal((await api('/api/sessions', { codex_enabled: true })).status, 409);
  assert.equal((await api('/api/sessions', { codex_model: 'different' })).status, 400);
  assert.equal((await api('/api/sessions', { codex_model: 'gpt-6-luna', codex_effort: 'high' })).status, 400);
  const { data: s, status } = await api('/api/sessions', { voice_id: 'voice-1' }); assert.equal(status, 201); assert.equal(s.settings.codex_enabled, false);
  assert.equal((await api(`/api/sessions/${s.id}/config`, { codex_enabled: true, topic: 'Must not apply' })).status, 409);
  assert.equal((await api(`/api/sessions/${s.id}`)).data.settings.topic, '');
});
test('agents prepare while listening, take successive turns after playback, and stop naturally on a pass', async t => {
  const inputs = [], voices = []; let claudeCalls = 0;
  class RoomVoice extends TestVoice { constructor(o) { super(o); voices.push(o.voiceId); } }
  const { api, base, turn, root, id } = await room(t, { Voice: RoomVoice,
    claude: async o => { claudeCalls++; o.onText(claudeCalls === 3 ? '[[pass]]' : `Claude point ${claudeCalls}.`); },
    codex: async o => { inputs.push(JSON.parse(o.prompt)); assert.equal(o.model, 'gpt-6-astra'); assert.equal(o.effort, 'low'); o.onText(`Astra reply ${inputs.length}.`); } });
  await turn('Claude, talk it through together.');
  let s = await until(api, base, s => s.turns.some(t => t.status === 'generated'));
  assert.equal(inputs.length, 1, 'the listener can prepare before playback finishes');
  assert.deepEqual(voices, ['voice-1'], 'a prepared reply never opens a second speech stream');
  assert.equal(s.turns.length, 2, 'unheard preparation is not conversation history');
  assert.equal(inputs[0].conversation.at(-1).speaker, 'claude');
  assert.equal(inputs[0].conversation.at(-1).delivery_note, 'Still playing; this reply must finish before you speak.');
  const first = s.turns.at(-1);
  for (let i = 0; i < 2; i++) await api(base + '/event', { type: 'playback-complete', turn_id: first.id, played_seconds: first.audio_seconds });
  s = await until(api, base, s => s.turns.at(-1)?.speaker === 'codex' && s.turns.at(-1).status === 'generated');
  assert.equal(inputs.length, 1, 'handoff reuses the prepared response without a second model call');
  const second = s.turns.at(-1); assert.ok(second.audio_file.startsWith('codex-'));
  assert.ok(fs.existsSync(path.join(root, 'recordings', id, second.audio_file)));
  for (const speaker of ['claude', 'codex']) {
    const heard = s.turns.at(-1);
    await api(base + '/event', { type: 'playback-complete', turn_id: heard.id, played_seconds: heard.audio_seconds });
    s = await until(api, base, s => s.turns.at(-1)?.speaker === speaker && s.turns.at(-1).status === 'generated');
  }
  assert.deepEqual(voices, ['voice-1', 'voice-2', 'voice-1', 'voice-2']);
  assert.equal(inputs[1].conversation.at(-1).text, 'Claude point 2.', 'the next reply follows the latest peer point');
  assert.equal(inputs[1].conversation.find(t => t.speaker === 'claude' && t.text === first.text).delivery_note, 'Heard in full.');
  const last = s.turns.at(-1);
  await api(base + '/event', { type: 'playback-complete', turn_id: last.id, played_seconds: last.audio_seconds });
  s = await until(api, base, s => s.turns.at(-1)?.status === 'skipped');
  assert.equal(s.turns.at(-1).audio_file, undefined); assert.equal(s.turns.length, 6);
  await new Promise(r => setTimeout(r, 60)); assert.equal((await api(base)).data.turns.length, 6, 'a pass leaves the floor open');
});
test('an optional participant can stay quiet without producing captions or audio', async t => {
  const { api, base, turn } = await room(t, { codex: async ({ onText }) => { onText('[['); onText('pass]]'); } });
  await turn('Claude, hello.'); let s = await until(api, base, s => s.turns.at(-1)?.status === 'generated');
  await api(base + '/event', { type: 'playback-complete', turn_id: s.turns.at(-1).id, played_seconds: .1 });
  s = await until(api, base, s => s.turns.at(-1)?.status === 'skipped'); assert.equal(s.turns.at(-1).speech, ''); assert.equal(s.turns.at(-1).audio_file, undefined);
  const quiet = s.turns.at(-1).id;
  await turn('Claude, one more question.');
  s = await until(api, base, s => s.turns.at(-1)?.status === 'generated');
  assert.equal(s.turns.find(t => t.id === quiet).status, 'skipped', 'a new human turn must not turn a silent pass into an interrupted reply');
});
test('human speech cancels the pending handoff even after the first agent was heard', async t => {
  let calls = 0; const { api, base, turn } = await room(t, { Scribe: TestScribe, followupDelay: 80, codex: async ({ onText }) => { calls++; onText('Should not happen.'); } });
  await api(base + '/listen', {}); await turn('Claude, hello.'); const s = await until(api, base, s => s.turns.at(-1)?.status === 'generated');
  await api(base + '/event', { type: 'playback-complete', turn_id: s.turns.at(-1).id, played_seconds: .1 });
  TestScribe.current.options.onMessage({ message_type: 'partial_transcript', text: 'Let me jump in' });
  await new Promise(r => setTimeout(r, 140)); assert.equal(calls, 1, 'the one prepared response was discarded');
  assert.equal((await api(base)).data.turns.some(t => t.speaker === 'codex'), false, 'nothing from the cancelled preparation reaches the room');
});
test('removing Codex cancels its in-flight reply, late output is discarded, and rejoining sees the shared history', async t => {
  let pending, aborted = false, calls = 0;
  const { api, base, turn } = await room(t, { codex: o => { calls++; if (calls > 1) { assert.ok(JSON.parse(o.prompt).conversation.some(t => t.text === 'Claude, while Codex is away.')); o.onText('I caught up.'); return; }
    return new Promise((resolve, reject) => { pending = () => o.onText('Late output.'); o.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Stopped', 'AbortError')); }); }); } });
  await turn('Codex, hello.'); await until(api, base, s => s.turns.at(-1)?.speaker === 'codex');
  assert.equal((await api(base + '/config', { codex_enabled: false })).status, 200); assert.equal(aborted, true); pending();
  await turn('Claude, while Codex is away.'); await until(api, base, s => s.turns.at(-1)?.status === 'generated');
  await api(base + '/config', { codex_enabled: true }); await turn('Codex, welcome back.');
  const s = await until(api, base, s => s.turns.at(-1)?.text === 'I caught up.');
  assert.ok(!s.turns.some(t => t.text.includes('Late output')));
});
test('a delayed interrupt for the old speaker cannot cancel the new speaker', async t => {
  const { api, base, turn } = await room(t); await turn('Claude, first.'); const s = await until(api, base, s => s.turns.at(-1)?.status === 'generated'), old = s.turns.at(-1).id;
  await turn('Codex, second.'); await api(base + '/interrupt', { turn_id: old });
  const next = await until(api, base, s => s.turns.at(-1)?.status === 'generated'); assert.equal(next.turns.at(-1).speaker, 'codex');
  await api(base + '/event', { type: 'playback-complete', turn_id: next.turns.at(-1).id, played_seconds: .1 });
  await until(api, base, s => s.turns.at(-1)?.speaker === 'claude' && s.turns.at(-1)?.followup);
});
test('Codex continuous stem uploads, finalizes and recovers as its own WAV', async t => {
  const { api, base, id, root } = await room(t);
  await api(base + '/media?name=codex-voice.pcm&seq=0', Buffer.from([1, 0, 3, 0]));
  assert.equal((await api(base + '/event', { type: 'media-complete', name: 'codex-voice.pcm', sample_rate: 48000 })).status, 200);
  assert.equal(fs.readFileSync(path.join(root, 'recordings', id, 'codex-voice.wav')).readUInt32LE(40), 4);
  await api(base + '/end', {});
  assert.equal((await api(`/api/recordings/${id}/recover?name=codex-voice.pcm&rate=48000`, Buffer.from([2, 0]))).data.file, 'codex-voice.recovered.wav');
});

test('shared call vision reaches both agents with source labels, and source changes discard previous images', async t => {
  const calls=[];
  const provider = speaker => async o => { calls.push({speaker,system:o.system,images:o.images,prompt:JSON.parse(o.prompt)});o.onText('A useful thought.'); };
  const {api,base,turn} = await room(t,{claude:provider('claude'),codex:provider('codex')});
  assert.equal((await api(base+'/config',{vision_source:'desktop'})).status,400);
  await api(base+'/config',{vision_source:'room',vision_level:'still',user_name:'Robin'});
  const image=Buffer.from([0xff,0xd8,0xff,0xe0,20,30]);
  assert.equal((await api(base+'/frame',image)).data.used,false,'late camera upload cannot become a room frame');
  assert.equal((await api(base+'/frame?source=room',image)).data.used,true);
  await turn('Claude, what is in our call?');
  let s=await until(api,base,s=>s.turns.at(-1)?.status==='generated');
  await api(base+'/event',{type:'playback-complete',turn_id:s.turns.at(-1).id,played_seconds:s.turns.at(-1).audio_seconds});
  s=await until(api,base,s=>s.turns.at(-1)?.speaker==='codex'&&s.turns.at(-1).status==='generated');
  assert.deepEqual(calls.map(c=>c.speaker),['claude','codex','claude'], 'Claude prepares the next response after Astra');
  for(const c of calls){assert.match(c.prompt.vision,/animated illustrations/);assert.match(c.images[0].label,/Call view 1 of 1/);assert.deepEqual(Buffer.from(c.images[0].data,'base64'),image);assert.equal(c.prompt.call.participants[0].name,'Robin');assert.equal(c.prompt.call.participants[2].name,'Astra');assert.equal(c.prompt.call.participants[2].model,'gpt-6-astra');}
  assert.equal(s.turns.at(-1).seen[0].source,'room');
  await api(base+'/config',{vision_source:'camera'});
  await turn('Astra, can you see anything now?');
  await until(api,base,s=>s.turns.at(-1)?.status==='generated');
  assert.equal(calls.at(-1).images.length,0,'changing source clears previous call images');
  assert.match(calls.at(-1).prompt.vision,/No images are available/);
  await api(base+'/frame',image);await api(base+'/config',{vision_level:'off'});
  assert.equal((await api(base+'/frame',image)).data.used,false);
  await turn('Astra, and now?');await until(api,base,s=>s.turns.at(-1)?.status==='generated');
  assert.equal(calls.at(-1).images.length,0);
});

test('a fresh server loads saved-account voices before the first call and retries catalogue failures', async t => {
  let requests=0;
  const {api}=await fixture(t,subscribed,{...roomMocks,initialKey:'test-secret',getVoices:async()=>{requests++;if(requests===1)throw new Error('Service temporarily unavailable');return[{voice_id:'jessica',name:'Jessica'}];}});
  const first=(await api('/api/status')).data;assert.equal(first.voice_count,0);assert.match(first.voice_error,/ElevenLabs/);assert.equal(first.elevenlabs_key_set,true);
  const second=(await api('/api/status')).data;assert.equal(second.voices[0].name,'Jessica');assert.equal(second.voice_count,1);assert.equal(second.voice_error,undefined);
  await api('/api/status');assert.equal(requests,2,'a loaded catalogue is reused');
});

test('Astra paints a separate sandboxed setting without delaying speech or replacing the camera backdrop', async t => {
  let finishPainting, paintCalls = 0, seen;
  const { api, origin, base, turn, root, id, cookie } = await room(t, { codex: async o => {
    if (o.system.includes('painting the place')) { paintCalls++; seen=o; await new Promise(resolve => finishPainting=resolve); o.onText('{"backdrop":true,"title":"Moonlit paper garden"}\n---\nfunction draw(ctx,t){ctx.fillStyle="#91b1ee";ctx.fillRect(0,0,W,H);}'); }
    else o.onText('[curious] The garden could have a tiny moon.');
  }});
  await api(base+'/config',{visuals:'useful'});
  await turn('Astra, imagine a moonlit garden.');
  let s=await until(api,base,s=>s.turns.at(-1)?.status==='generated');
  assert.equal(s.turns.at(-1).speaker,'codex'); assert.equal(s.codex_backdrops.length,0,'speech completed while painting is pending');
  assert.equal(seen.model,'gpt-6-astra'); assert.equal(seen.effort,'low');
  finishPainting(); s=await until(api,base,s=>s.codex_backdrops.length===1);
  assert.equal(s.backdrops.length,0,'the human camera backdrop is independent');
  assert.equal(s.codex_backdrops[0].style,'codex');
  assert.match(fs.readFileSync(path.join(root,'recordings',id,s.codex_backdrops[0].file),'utf8'),/function draw/);
  const frame=await fetch(origin+`/scene-frame/${id}/${s.codex_backdrops[0].id}`,{headers:{Cookie:cookie}});
  assert.equal(frame.status,200);assert.match(frame.headers.get('content-security-policy'),/connect-src 'none'/);
  const html=await frame.text();assert.match(html,/Astra blue storybook/);assert.match(html,/W:\{get:\(\)=>700/);assert.match(html,/H:\{get:\(\)=>1030/);
  await turn('Astra, and one little bench.'); await until(api,base,s=>s.turns.at(-1)?.status==='generated');
  assert.equal(paintCalls,1,'short consecutive turns keep a settled backdrop');
  assert.ok(s.turns.every(t=>!t.text.includes('function draw')),'code never enters speech history');
});

test('Astra background output arriving after she leaves, visuals turn off, or the call ends is discarded', async t => {
  for (const stop of ['leave','off','end']) {
    let release, signal;
    const f=await room(t,{codex:async o=>{
      if(o.system.includes('painting the place')){signal=o.signal;await new Promise(resolve=>release=resolve);o.onText('{"backdrop":true,"title":"Late scenery"}\n---\nfunction draw(ctx){ctx.fillRect(0,0,W,H);}');}
      else o.onText('Hello.');
    }});
    await f.api(f.base+'/config',{visuals:'useful'});await f.turn('Astra, hello.');await until(f.api,f.base,s=>s.turns.at(-1)?.status==='generated');
    await f.api(f.base+(stop==='end'?'/end':'/config'),stop==='leave'?{codex_enabled:false}:stop==='off'?{visuals:'off'}:{});
    assert.equal(signal.aborted,true,stop);release();
    await new Promise(r=>setTimeout(r,10));assert.equal((await f.api(f.base)).data.codex_backdrops.length,0,stop);
  }
});

test('an invalid Astra background fails quietly while the spoken reply succeeds', async t => {
  const {api,base,turn,root,id}=await room(t,{codex:async o=>o.onText(o.system.includes('painting the place')?'{"backdrop":true,"title":"Broken"}\n---\nfunction draw( {':'Still here, and happy to talk.')});
  await api(base+'/config',{visuals:'useful'});await turn('Astra, hello.');
  const s=await until(api,base,s=>s.turns.at(-1)?.status==='generated');assert.equal(s.codex_backdrops.length,0);
  const events=fs.readFileSync(path.join(root,'recordings',id,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some(e=>e.type==='backdrop-error'&&e.speaker==='codex'));assert.ok(!events.some(e=>e.type==='error'));
});

// This is the failure observed in a real generated sketch: assigning W/H used to kill setup().
test('scene host preserves its size and lets setup continue when generated code assigns dimensions', async () => {
  const {sceneFrameHTML,SCENE_STYLES}=await import('../src/director.mjs');
  const html=sceneFrameHTML({width:700,height:1030,style:SCENE_STYLES.cafe,code:'function setup(){W=888;H=560;globalThis.ready=true;} function draw(){}'});
  class Gradient {addColorStop(){}}
  class Context {createLinearGradient(){}createRadialGradient(){}arc(){}ellipse(){}}
  const scope=vm.createContext({CanvasGradient:Gradient,CanvasRenderingContext2D:Context,OffscreenCanvasRenderingContext2D:Context});
  const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
  vm.runInContext(scripts[0],scope);vm.runInContext(scripts[1],scope);vm.runInContext('setup();',scope);
  assert.equal(scope.W,700);assert.equal(scope.H,1030);assert.equal(scope.ready,true);
});

test('Astra alone needs no Claude login, sees the two-person room, and never calls a Claude painter or peer', async t => {
  const calls = []; let claudeCalls = 0, authCalls = 0;
  const { api } = await fixture(t, { ready: false }, { ...roomMocks, auth: async () => { authCalls++; return { ready: false }; },
    claude: async () => { claudeCalls++; throw new Error('Claude was not selected'); },
    codex: async o => { calls.push(o); o.onText(o.system.includes('painting the place') ? '{"backdrop":false}' : 'Just the two of us.'); } });
  await api('/api/settings', { api_key: 'test-secret' });
  const created = await api('/api/sessions', { claude_enabled: false, codex_enabled: true, visuals: 'useful', backdrops: true, vision_source: 'room', vision_level: 'still' });
  assert.equal(created.status, 201); assert.equal(authCalls, 0);
  const base = `/api/sessions/${created.data.id}`, jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 4, 8]);
  await api(base + '/frame?source=room', jpeg);
  assert.equal((await api(base + '/turn', { text: 'Claude, hello?', speaker: 'claude', request_id: randomUUID(), reply_id: randomUUID() })).status, 400);
  await api(base + '/turn', { text: 'Claude used to be here. Who is here now?', request_id: randomUUID(), reply_id: randomUUID() });
  let s = await until(api, base, s => s.turns.at(-1)?.status === 'generated');
  const voice = calls.find(o => !o.system.includes('painting the place'));
  assert.deepEqual(JSON.parse(voice.prompt).call.participants.map(p => p.speaker), ['user', 'codex']);
  assert.match(JSON.parse(voice.prompt).vision, /human on the left, Astra on the right/); assert.doesNotMatch(JSON.parse(voice.prompt).vision, /Claude in the middle/);
  assert.doesNotMatch(JSON.parse(voice.prompt).room, /\bClaude\b/); assert.deepEqual(Buffer.from(voice.images[0].data, 'base64'), jpeg);
  await api(base + '/event', { type: 'playback-complete', turn_id: s.turns.at(-1).id, played_seconds: s.turns.at(-1).audio_seconds });
  await new Promise(r => setTimeout(r, 70));
  s = (await api(base)).data; assert.equal(s.turns.length, 2); assert.equal(claudeCalls, 0); assert.equal(authCalls, 0);
  assert.ok(calls.some(o => o.system.includes('painting the place')), 'Astra can still paint her own room');
  assert.equal((await api(base + '/config', { claude_enabled: true, topic: 'Must not apply' })).status, 409);
  assert.equal((await api(base)).data.settings.topic, '');
});

test('participant selection rejects an empty live room atomically and validates booleans', async t => {
  const { api, base } = await room(t);
  assert.equal((await api(base + '/config', { claude_enabled: false, codex_enabled: false, topic: 'Must not apply' })).status, 400);
  for (const data of [{ claude_enabled: 'false' }, { codex_enabled: 0 }]) assert.equal((await api(base + '/config', data)).status, 400);
  const s = (await api(base)).data; assert.equal(s.settings.claude_enabled, true); assert.equal(s.settings.codex_enabled, true); assert.equal(s.settings.topic, '');
  await api(base + '/end', {});
  assert.equal((await api('/api/sessions', { claude_enabled: false, codex_enabled: false })).status, 400);
});

test('removing Claude interrupts speech, cancels painters, clears old room frames, and retains shared history', async t => {
  let releaseVoice, releaseScene, releaseBackdrop, voiceSignal, sceneSignal, backdropSignal; const codexCalls = [];
  const { api, base, turn } = await room(t, {
    claude: async o => {
      if (o.system.includes('moving picture')) { sceneSignal = o.signal; await new Promise(r => releaseScene = r); o.onText('{"visual":true,"title":"Late art","base":"city"}\n---\nfunction draw(ctx){ctx.fillRect(0,0,W,H);}'); }
      else if (o.system.includes('ambient backdrop')) { backdropSignal = o.signal; await new Promise(r => releaseBackdrop = r); o.onText('{"backdrop":true,"title":"Late room"}\n---\nfunction draw(ctx){ctx.fillRect(0,0,W,H);}'); }
      else { voiceSignal = o.signal; o.onText('A little thought.'); await new Promise(r => releaseVoice = r); o.onText(' Must never be heard.'); }
    }, codex: async o => { if (o.system.includes('painting the place')) o.onText('{"backdrop":false}'); else { codexCalls.push(o); o.onText('I heard the earlier thought.'); } }
  });
  await api(base + '/config', { visuals: 'useful', backdrops: true, vision_source: 'room' });
  await api(base + '/frame?source=room', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 4, 8]));
  await turn('Claude, imagine a little garden.'); await until(api, base, () => voiceSignal && sceneSignal && backdropSignal);
  assert.equal((await api(base + '/config', { claude_enabled: false })).status, 200);
  for (const signal of [voiceSignal, sceneSignal, backdropSignal]) assert.equal(signal.aborted, true);
  releaseVoice(); releaseScene(); releaseBackdrop();
  await turn('Who is here now?'); const s = await until(api, base, s => s.turns.at(-1)?.speaker === 'codex' && s.turns.at(-1).status === 'generated');
  assert.equal(s.scenes.length, 0); assert.equal(s.backdrops.length, 0);
  assert.ok(!s.turns.some(t => t.text.includes('Must never be heard')));
  assert.equal(codexCalls[0].images.length, 0, 'the old three-person frame is discarded');
  const context = JSON.parse(codexCalls[0].prompt);
  assert.deepEqual(context.call.participants.map(p => p.speaker), ['user', 'codex']);
  assert.ok(context.conversation.some(t => t.speaker === 'claude'), 'past conversation stays available');
});

test('changing participants after playback cancels a queued contribution from either agent', async t => {
  for (const first of ['claude', 'codex']) {
    const f = await room(t, { followupDelay: 60 });
    await f.turn(`${first}, one thought?`); const s = await until(f.api, f.base, s => s.turns.at(-1)?.status === 'generated'), turn = s.turns.at(-1);
    await f.api(f.base + '/event', { type: 'playback-complete', turn_id: turn.id, played_seconds: turn.audio_seconds });
    await f.api(f.base + '/config', { [first === 'claude' ? 'codex_enabled' : 'claude_enabled']: false });
    await new Promise(r => setTimeout(r, 90));
    assert.equal((await f.api(f.base)).data.turns.length, 2);
  }
});

test('a still-generating prepared reply streams speech after handoff without waiting for the full answer', async t => {
  let finish, push, signal;
  const { api, base, turn } = await room(t, { codex: async o => { signal = o.signal; push = o.onText; await new Promise(r => finish = r); } });
  await turn('Claude, start.'); let s = await until(api, base, s => s.turns.at(-1)?.status === 'generated');
  const first = s.turns.at(-1); assert.ok(signal); assert.equal(s.turns.length, 2);
  await api(base + '/event', { type: 'playback-complete', turn_id: first.id, played_seconds: first.audio_seconds });
  await until(api, base, s => s.turns.at(-1)?.speaker === 'codex');
  push('[curious] I think the more interesting question is whether we can make the experiments cheaper. ');
  s = await until(api, base, s => s.turns.at(-1)?.audio_seconds > 0);
  assert.equal(s.turns.at(-1).status, 'thinking', 'audio is available before generation has completed');
  finish(); await until(api, base, s => s.turns.at(-1)?.status === 'generated');
});

test('human interruption, participant removal, and call end abort preparation and discard its late text', async t => {
  for (const reason of ['interrupt', 'leave', 'end']) {
    let push, release, signal;
    const f = await room(t, { codex: async o => { signal = o.signal; push = o.onText; await new Promise(r => release = r); } });
    await f.turn('Claude, one thing.'); const s = await until(f.api, f.base, s => s.turns.at(-1)?.status === 'generated');
    assert.ok(signal);
    await f.api(f.base + (reason === 'leave' ? '/config' : '/' + reason), reason === 'leave' ? { codex_enabled: false } : {});
    assert.equal(signal.aborted, true, reason); push('This cancelled thought must not escape.'); release();
    await f.api(f.base + '/event', { type: 'playback-complete', turn_id: s.turns.at(-1).id, played_seconds: s.turns.at(-1).audio_seconds });
    await new Promise(r => setTimeout(r, 50));
    const after = (await f.api(f.base)).data; assert.equal(after.turns.length, 2); assert.ok(after.turns.every(t => !t.text.includes('cancelled thought')));
  }
});

test('model and visual changes replace a prepared reply before it can enter the conversation', async t => {
  const drafts = [];
  const f = await room(t, { codex: async o => { drafts.push(o); if (drafts.length === 1) await new Promise(resolve => { o.signal.addEventListener('abort', resolve, { once: true }); }); o.onText(o.model === 'gpt-6-luna' ? 'The updated reply.' : 'An outdated reply.'); } });
  await f.api(f.base + '/config', { vision_source: 'room', vision_level: 'still' });
  await f.api(f.base + '/frame?source=room', Buffer.from([0xff,0xd8,0xff,0xe0,4,8]));
  await f.turn('Claude, begin.'); let s = await until(f.api, f.base, s => s.turns.at(-1)?.status === 'generated');
  assert.equal(drafts[0].images.length, 1);
  await f.api(f.base + '/config', { codex_model: 'gpt-6-luna', vision_level: 'off' });
  assert.equal(drafts[0].signal.aborted, true); assert.equal(drafts[1].images.length, 0);
  const first = s.turns.at(-1); await f.api(f.base + '/event', { type: 'playback-complete', turn_id: first.id, played_seconds: first.audio_seconds });
  s = await until(f.api, f.base, s => s.turns.at(-1)?.speaker === 'codex' && s.turns.at(-1)?.status === 'generated');
  assert.equal(s.turns.at(-1).text, 'The updated reply.');
});

test('a failed preparation cannot leak partial text or affect the current speaker', async t => {
  const f = await room(t, { codex: async o => { o.onText('An incomplete thought.'); throw new Error('Mock provider failed'); } });
  await f.turn('Claude, go.'); let s = await until(f.api, f.base, s => s.turns.at(-1)?.status === 'generated');
  assert.equal(s.turns.length, 2); const first = s.turns.at(-1);
  await f.api(f.base + '/event', { type: 'playback-complete', turn_id: first.id, played_seconds: first.audio_seconds });
  s = await until(f.api, f.base, s => s.turns.at(-1)?.status === 'error');
  assert.equal(s.turns[1].status, 'delivered'); assert.equal(s.turns.at(-1).audio_file, undefined); assert.equal(s.turns.at(-1).text, '');
});

test('either listener starts preparing before the first speaker finishes synthesis, with only one voice stream', async t => {
  for (const first of ['claude','codex']) {
    let release, voiceCount=0; const requests=[];
    class SlowVoice extends TestVoice {
      constructor(o){super(o);this.index=++voiceCount;}
      end(){if(this.index===1)return new Promise(resolve=>release=()=>{this.resolve();resolve();});return super.end();}
    }
    const reply=speaker=>async o=>{requests.push(speaker);o.onText(`${speaker} has a complete thought.`);};
    const f=await room(t,{Voice:SlowVoice,claude:reply('claude'),codex:reply('codex')});
    await f.turn(`${first}, begin.`);
    let s=await until(f.api,f.base,()=>release&&requests.length===2);
    assert.equal(s.turns.at(-1).status,'thinking');assert.equal(s.turns.length,2);assert.equal(voiceCount,1);
    assert.deepEqual(requests,[first,first==='claude'?'codex':'claude']);
    release();s=await until(f.api,f.base,s=>s.turns.at(-1).status==='generated');
    await f.api(f.base+'/event',{type:'playback-complete',turn_id:s.turns.at(-1).id,played_seconds:s.turns.at(-1).audio_seconds});
    s=await until(f.api,f.base,s=>s.turns.length===3&&s.turns.at(-1).status==='generated');
    assert.equal(voiceCount,2);assert.equal(s.turns.at(-1).speaker,first==='claude'?'codex':'claude');
    await f.api(f.base+'/end',{});
  }
});

test('an interruption shares the aligned spoken prefix with the peer, never the unheard ending',async t=>{
  const inputs=[];const prefix='Start with the blue notebook.';
  class AlignedVoice extends TestVoice {
    constructor(o){super(o);this.onAlignment=o.onAlignment;}
    write(text){this.onAudio(Buffer.alloc(text.length*4800));this.onAlignment({chars:[...text],char_start_times_ms:[...text].map((_,i)=>i*100),char_durations_ms:[...text].map(()=>100)});}
  }
  const f=await room(t,{Voice:AlignedVoice,claude:async o=>o.onText(prefix+' The unheard code is 9274.'),codex:async o=>{inputs.push(JSON.parse(o.prompt));o.onText('A blue notebook makes sense.');}});
  await f.turn('Claude, propose a plan.');let s=await until(f.api,f.base,s=>s.turns.at(-1).status==='generated');const first=s.turns.at(-1);
  await f.api(f.base+'/event',{type:'audio-playback',turn_id:first.id,played_seconds:prefix.length/10,reason:'user-interrupted'});
  await f.api(f.base+'/interrupt',{});await f.turn('Astra, what did Claude say before I interrupted?');
  s=await until(f.api,f.base,s=>s.turns.at(-1).speaker==='codex'&&s.turns.at(-1).status==='generated');
  assert.ok(inputs[0].conversation.some(t=>t.text.includes('9274')),'preparation may anticipate a complete reply');
  const heard=inputs.at(-1).conversation.find(t=>t.speaker==='claude');
  assert.equal(heard.text,prefix);assert.ok(!JSON.stringify(inputs.at(-1)).includes('9274'));
  assert.ok(s.turns.find(t=>t.id===first.id).text.includes('9274'),'the saved generated output remains intact');
});

test('a typed turn replaces pending recognition even across a mute transition',async t=>{
  const f=await room(t,{Scribe:TestScribe});await f.api(f.base+'/listen',{});const recognize=TestScribe.current.options.onMessage;
  recognize({message_type:'partial_transcript',text:'An abandoned spoken thought'});
  await f.api(f.base+'/mute',{muted:true});await f.api(f.base+'/mute',{muted:false});
  recognize({message_type:'committed_transcript',text:'A stale commit'});
  await f.turn('Claude, use this typed thought instead.');
  let s=await until(f.api,f.base,s=>s.turns.at(-1).status==='generated');
  await new Promise(r=>setTimeout(r,450));s=(await f.api(f.base)).data;
  assert.deepEqual(s.turns.filter(t=>t.speaker==='user').map(t=>t.text),['Claude, use this typed thought instead.']);
  await f.api(f.base+'/event',{type:'playback-complete',turn_id:s.turns.at(-1).id,played_seconds:s.turns.at(-1).audio_seconds});
  await until(f.api,f.base,s=>s.turns.at(-1).speaker==='codex'&&s.turns.at(-1).status==='generated');
});

test('a committed human turn starts promptly and late word timestamps attach without causing a second reply',async t=>{
  const f=await room(t,{Scribe:TestScribe});await f.api(f.base+'/listen',{});const recognize=TestScribe.current.options.onMessage;
  const at=performance.now();recognize({message_type:'committed_transcript',text:'Claude, one thought.'});
  let s=await until(f.api,f.base,s=>s.turns.some(t=>t.speaker==='user'));
  assert.ok(performance.now()-at<350,'do not add another 400 ms after provider VAD');
  recognize({message_type:'committed_transcript_with_timestamps',text:'Claude, one thought.',words:[{text:'thought',start:.1,end:.2}]});
  s=(await f.api(f.base)).data;
  assert.equal(s.turns.filter(t=>t.speaker==='user').length,1);assert.equal(s.turns[0].words[0].text,'thought');
});

test('reported model labels and late cancelled callbacks cannot replace the selected conversation models',async t=>{
  const calls=[];let release;
  const f=await room(t,{claude:async o=>{calls.push(o.model);if(calls.length===1){await new Promise(r=>release=r);o.onModel('late-unselected-model');}o.onText('A selected-model reply.');}});
  await f.api(f.base+'/config',{claude_model:'claude-opus-5-5',claude_effort:'low'});
  await f.turn('Claude, first thought.');await until(f.api,f.base,()=>release);
  await f.api(f.base+'/interrupt',{});release();await new Promise(r=>setTimeout(r,10));
  assert.notEqual((await f.api(f.base)).data.actual_model,'late-unselected-model');
  await f.turn('Claude, next thought.');const s=await until(f.api,f.base,s=>s.turns.at(-1).status==='generated');
  assert.deepEqual(calls,['claude-opus-5-5','claude-opus-5-5']);assert.equal(s.settings.codex_model,'gpt-6-astra');
});

test('the room resumes separate native sessions across turns and rejoining, with fresh vision and stable instructions', async t => {
  const ids = { claude: randomUUID(), codex: randomUUID() }, calls = [];
  const provider = speaker => async o => {
    calls.push({ speaker, id: o.session.id, system: o.system, input: JSON.parse(o.prompt) });
    o.onSession(ids[speaker]); o.onText('A short thought.');
  };
  const { api, base, turn, root, id } = await room(t, { claude: provider('claude'), codex: provider('codex') });
  await turn('Claude, remember the violet lantern.');
  await until(api, base, s => s.turns.at(-1)?.status === 'generated' && calls.some(c => c.speaker === 'codex'));
  const originalSystem = calls.find(c => c.speaker === 'claude').system;
  await api(base + '/config', { codex_enabled: false, vision_level: 'off' });
  await api('/api/prompt', { text: 'A warmer conversation voice.' });
  await turn('Claude, what do you remember?');
  await until(api, base, s => s.turns.at(-1)?.status === 'generated');
  const claude = calls.filter(c => c.speaker === 'claude').at(-1);
  assert.equal(claude.id, ids.claude); assert.equal(claude.system, originalSystem);
  assert.equal(claude.input.context_mode, 'updates'); assert.match(claude.input.instruction_update, /warmer conversation voice/);
  assert.match(claude.input.vision, /No images are available/);
  assert.ok(!JSON.stringify(claude.input.conversation).includes('violet lantern'), 'the opening fact now lives in its native session');
  await api(base + '/config', { codex_enabled: true });
  await turn('Astra, catch up with us.');
  await until(api, base, s => s.turns.at(-1)?.speaker === 'codex' && s.turns.at(-1)?.status === 'generated');
  const astra = calls.filter(c => c.speaker === 'codex').at(-1);
  assert.equal(astra.id, ids.codex); assert.equal(astra.input.context_mode, 'updates');
  assert.ok(astra.input.conversation.some(c => c.text === 'Claude, what do you remember?'));
  const visible = JSON.stringify((await api(base)).data);
  for (const [speaker, nativeId] of Object.entries(ids)) {
    assert.ok(!visible.includes(nativeId));
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'recordings', id, 'agent-sessions', speaker, 'session.json'))).session_id, nativeId);
  }
  await api(base + '/end', {});
  const newCall = await api('/api/sessions', { voice_id: 'voice-1', codex_enabled: false });
  await api(`/api/sessions/${newCall.data.id}/turn`, { text: 'A new call.', request_id: randomUUID(), reply_id: randomUUID() });
  await until(api, `/api/sessions/${newCall.data.id}`, s => s.turns.at(-1)?.status === 'generated');
  assert.equal(calls.at(-1).id, null, 'new calls do not inherit an old call’s private session');
  assert.equal(calls.at(-1).input.context_mode, 'initial');
});

test('mute preserves a final transcript inside the commit debounce and peers continue while muted', async t => {
  const f = await room(t, { Scribe: TestScribe, commitDelay: 120 });
  await f.api(f.base + '/listen', {}); const recognize = TestScribe.current.options.onMessage;
  recognize({ message_type: 'committed_transcript', text: 'Claude, keep that thought.' });
  await f.api(f.base + '/mute', { muted: true });
  let s = await until(f.api, f.base, s => s.turns.at(-1)?.status === 'generated');
  assert.deepEqual(s.turns.filter(t => t.speaker === 'user').map(t => t.text), ['Claude, keep that thought.']);
  const first = s.turns.at(-1);
  await f.api(f.base + '/event', { type: 'playback-complete', turn_id: first.id, played_seconds: first.audio_seconds });
  await until(f.api, f.base, s => s.turns.at(-1)?.speaker === 'codex' && s.turns.at(-1).status === 'generated');
  recognize({ message_type: 'committed_transcript', text: 'New speech while muted must be ignored.' });
  await new Promise(r => setTimeout(r, 150));
  s = (await f.api(f.base)).data; assert.equal(s.turns.filter(t => t.speaker === 'user').length, 1);
});

test('a final recognition result arriving after mute completes the already captured utterance', async t => {
  const f = await room(t, { Scribe: TestScribe }); await f.api(f.base + '/listen', {});
  const recognize = TestScribe.current.options.onMessage;
  recognize({ message_type: 'partial_transcript', text: 'Astra, what' });
  await f.api(f.base + '/mute', { muted: true });
  recognize({ message_type: 'committed_transcript', text: 'Astra, what do you think?' });
  const s = await until(f.api, f.base, s => s.turns.at(-1)?.status === 'generated');
  assert.equal(s.turns.at(-1).speaker, 'codex');
  assert.deepEqual(s.turns.filter(t => t.speaker === 'user').map(t => t.text), ['Astra, what do you think?']);
});

test('each participant prompt can be edited and reset independently, with the legacy Claude endpoint retained', async t => {
  const { api, root } = await fixture(t);
  const claude = (await api('/api/agents/claude/prompt')).data;
  const astra = (await api('/api/agents/codex/prompt')).data;
  assert.equal((await api('/api/agents/codex/prompt', { text: 'Astra test instruction.' })).data.text, 'Astra test instruction.');
  assert.equal((await api('/api/prompt')).data.text, claude.text);
  assert.equal((await api('/api/agents/codex/prompt', { reset: true })).data.text, astra.default_text);
  assert.equal((await api('/api/agents/missing/prompt', { text: 'bad' })).status, 404);
  assert.equal(fs.readFileSync(path.join(root, 'prompts/codex.md'), 'utf8'), astra.default_text);
});

test('audio trims persist locally, validate atomically, and appear in the call record', async t => {
  const f = await room(t);
  assert.equal((await f.api('/api/audio-mix', { user: 13, codex: -3 })).status, 200);
  assert.deepEqual((await f.api('/api/audio-mix')).data, { user: 13, claude: 0, codex: -3 });
  assert.equal((await f.api('/api/audio-mix', { user: 6, claude: 90 })).status, 400);
  assert.equal((await f.api('/api/audio-mix', { unexpected: 1 })).status, 400);
  assert.equal((await f.api('/api/audio-mix', { user: '13' })).status, 400);
  assert.equal((await f.api(f.base)).data.audio_mix.user, 13);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, '.runtime/audio-mix.json'))), { user: 13, claude: 0, codex: -3 });
});

test('a three-agent room continues past a pass and keeps each native context separate', async t => {
  const { AGENTS } = await import('../public/participants.js');
  const third = { ...AGENTS[1], id: 'third', name: 'Third', aliases: ['third'], defaultEnabled: true, promptArchive: 'third-prompt.md', fields: { ...AGENTS[1].fields, enabled: 'third_enabled' } };
  AGENTS.push(third); t.after(() => AGENTS.splice(AGENTS.indexOf(third), 1));
  const contexts = new Set();
  const f = await room(t, { codex: async o => {
    contexts.add(o.session.cwd);
    o.onText(JSON.parse(o.prompt).room.includes('You are Third.') ? 'A third voice.' : '[[pass]]');
  } });
  await f.turn('Claude, open the conversation.');
  const first = (await until(f.api, f.base, s => s.turns.at(-1)?.status === 'generated')).turns.at(-1);
  await f.api(f.base + '/event', { type: 'playback-complete', turn_id: first.id, played_seconds: first.audio_seconds });
  const s = await until(f.api, f.base, s => s.turns.at(-1)?.speaker === 'third' && s.turns.at(-1).status === 'generated');
  assert.equal(s.turns.find(t => t.speaker === 'codex').status, 'skipped');
  assert.equal(contexts.size, 2); assert.equal(s.participants.length, 3);
  assert.equal((await f.api(f.base + '/media?name=third-voice.pcm&seq=0', Buffer.alloc(4800))).status, 200);
  assert.equal((await f.api(f.base + '/event', { type: 'media-complete', name: 'third-voice.pcm', sample_rate: 48000 })).status, 200);
});
