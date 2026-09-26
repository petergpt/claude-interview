#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {connect} from '../src/client.mjs';
import {readKey,readSecret,saveSecret,KEYCHAIN_SERVICE,SECRETS} from '../src/credentials.mjs';
import {authStatus} from '../src/claude.mjs';
import {talk,listDevices} from '../src/native.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [command='help',...args]=process.argv.slice(2),positionals=[],options={};
for(let i=0;i<args.length;i++){if(args[i].startsWith('--')){const key=args[i].slice(2);options[key]=args[i+1]&&!args[i+1].startsWith('--')?args[++i]:true;}else positionals.push(args[i]);}
const print=x=>console.log(JSON.stringify(x,null,2));
const spawnWait=(cmd,args)=>new Promise(resolve=>{const p=spawn(cmd,args,{cwd:root,stdio:'inherit'});p.on('close',code=>resolve(code||0));p.on('error',()=>resolve(1));});
async function ensureBackend(){try{return await connect();}catch{}
  const runtime=path.join(root,'.runtime');fs.mkdirSync(runtime,{recursive:true,mode:0o700});const fd=fs.openSync(path.join(runtime,'server.log'),'a',0o600);
  const child=spawn(process.execPath,[...(fs.existsSync(path.join(root,'.env'))?['--env-file=.env']:[]),path.join(root,'src/server.mjs')],{cwd:root,detached:true,stdio:['ignore',fd,fd],env:process.env});child.unref();fs.closeSync(fd);
  for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,250));try{return await connect();}catch{}}
  throw new Error('The backend did not start. Check .runtime/server.log.');
}
async function hiddenKey(label='ElevenLabs key'){
  if(!process.stdin.isTTY){let key='';for await(const bytes of process.stdin){key+=bytes;if(key.length>600)throw new Error('Key input too long.');}return key.trim();}
  process.stdout.write(`${label} (hidden): `);process.stdin.setRawMode(true);process.stdin.resume();
  return new Promise((resolve,reject)=>{let key='';const read=bytes=>{for(const c of bytes.toString()){
    if(c==='\r'||c==='\n'||c==='\u0003'){process.stdin.off('data',read);process.stdin.setRawMode(false);process.stdin.pause();console.log();return c==='\u0003'?reject(new Error('Cancelled.')):resolve(key.trim());}
    if(c==='\u007f')key=key.slice(0,-1);else if(c>=' '&&key.length<512)key+=c;
  }};process.stdin.on('data',read);});
}
try{
  if(command==='help')console.log(`Speaking to AIs — local conversation backend\n\n./interview up                         Start backend in background\n./interview serve                      Run backend in this terminal\n./interview status                     Check subscription, key, active session\n./interview login                      Claude Code subscription sign-in\n./interview key set                    ElevenLabs key: hidden prompt, saved to macOS Keychain\n./interview stream-key set             X stream key (optional): hidden prompt, saved to Keychain\n./interview devices                    List camera and microphone indices\n./interview talk [--mic default]        Hands-free conversation + playback\n  [--camera 0] [--topic '...'] [--model alias] [--effort low] [--silence 1.5]\n  [--codex] [--codex-model gpt-6-astra] [--codex-effort low] [--codex-voice ID]\n  [--voice ID|auto] [--tts eleven_v3_conversational] [--no-intro] [--muted] [--name 'Your name']\n./interview start [--topic '...'] [--name '...']  Create session for a custom client\n./interview say 'your words'           Submit a typed turn to active session\n./interview codex on|off              Join or leave the active call\n./interview mix [user|claude|codex dB] Adjust browser playback, recording and stream balance\n./interview interrupt | mute | unmute | mark | stop\n./interview events                     Stream JSON events (audio omitted)\n./interview session [UUID]             Inspect current/saved session\n./interview sessions                   List saved recordings\n./interview review UUID                Ask Claude for editorial annotations\n./interview down                       Stop backend and active call\n\nCredentials and ElevenLabs connections stay in the backend. Elsewhere than macOS, put keys in .env.\nAPI-key billing instead of a subscription: INTERVIEW_CLAUDE_AUTH=api and ANTHROPIC_API_KEY in .env.\nCamera is optional. Use headphones. Ctrl-C ends and saves a talk session.`);
  else if(command==='serve')process.exitCode=await spawnWait(process.execPath,['--env-file-if-exists=.env','src/server.mjs']);
  else if(command==='login')process.exitCode=await spawnWait(process.execPath,['scripts/login.mjs']);
  else if(command==='review')process.exitCode=await spawnWait(process.execPath,['scripts/review.mjs',positionals[0]||'']);
  else if(command==='devices')process.exitCode=await listDevices();
  else if(command==='key'){
    if(positionals[0]!=='set')throw new Error('Usage: ./interview key set (or pipe key on stdin; never pass it as an argument)');
    const key=await hiddenKey();const client=await ensureBackend();await client.request('/api/settings',{api_key:key});console.log(`Key verified and stored in macOS Keychain (${KEYCHAIN_SERVICE}).`);
  }
  else if(command==='stream-key'){
    if(positionals[0]!=='set')throw new Error('Usage: ./interview stream-key set (or pipe it on stdin; never pass it as an argument)');
    await saveSecret('xstream',await hiddenKey('X stream key'));console.log(`Stream key stored in macOS Keychain (${SECRETS.xstream.service}). The page never receives it.`);
  }
  else if(command==='sessions'){
    const directory=path.join(root,'recordings');const result=[];for(const entry of fs.readdirSync(directory,{withFileTypes:true})){if(!entry.isDirectory())continue;try{const s=JSON.parse(fs.readFileSync(path.join(directory,entry.name,'session.json')));result.push({id:s.id,created_at:s.created_at,status:s.status,model:s.actual_model,voice:s.voice?.name,turns:s.turns.length});}catch{}}print(result);
  }
  else if(command==='session'&&positionals[0])print(JSON.parse(fs.readFileSync(path.join(root,'recordings',checkedId(positionals[0]),'session.json'),'utf8')));
  else if(command==='status'){
    const auth=await authStatus();let server;try{server=await(await connect()).request('/api/status');}catch{}
    print({claude:auth.mode==='api'?{mode:'api',apiKeySet:auth.apiKeySet,ready:auth.ready}:{mode:'subscription',ready:auth.ready,subscriptionType:auth.subscriptionType,email:auth.email},elevenlabs:{keyStored:Boolean(await readKey()),store:process.env.ELEVENLABS_API_KEY?'environment':process.platform==='darwin'?'macOS Keychain':'not set',connected:server?.elevenlabs_key_set||false,voices:server?.voice_count||0},codex:server?.codex||{ready:false},backend:server?'running':'stopped',xStreamKeySet:Boolean(await readSecret('xstream').catch(()=>'')),activeSession:server?.active_session||null});
  }
  else{
    const valid=['up','down','talk','start','say','interrupt','mute','unmute','mark','stop','events','session','codex','mix'];if(!valid.includes(command))throw new Error(`Unknown command ${command}. Run ./interview help.`);
    const client=command==='down'?await connect():await ensureBackend();
    if(command==='up'){try{await client.request('/api/settings',{});console.log(`Backend ready: ${client.base}`);}catch(error){console.log(`Backend running at ${client.base}, but the voice service is not configured yet: ${error.message}`);}}
    else if(command==='mix'){const [speaker,level]=positionals;print(await client.request('/api/audio-mix',speaker?{[speaker]:Number(level)}:undefined));}
    else if(command==='down'){await client.request('/api/shutdown',{});console.log('Backend stopped.');}
    else if(command==='talk')await talk(client,options);
    else if(command==='start')print(await client.request('/api/sessions',{codex_enabled:options.codex===true||options.codex==='on',codex_model:options['codex-model']||undefined,codex_effort:options['codex-effort']||undefined,codex_voice_id:options['codex-voice']||undefined,user_name:typeof options.name==='string'?options.name:undefined,voice_id:options.voice||'auto',tts_model:options.tts||'eleven_v3_conversational',topic:options.topic||'',claude_model:options.model||'',claude_effort:options.effort||''}));
    else{
      const {active_session:id}=await client.request('/api/status');if(!id)throw new Error('No active session. Run ./interview talk or ./interview start.');
      const api=(name,data)=>client.request(`/api/sessions/${id}/${name}`,data);
      if(command==='session')print(await client.request(`/api/sessions/${id}`));
      else if(command==='say'){const text=positionals.join(' ');if(!text)throw new Error('Provide the words to send.');print(await api('turn',{text,request_id:randomUUID(),reply_id:randomUUID()}));}
      else if(command==='codex'){if(!['on','off'].includes(positionals[0]))throw new Error('Usage: ./interview codex on|off');print(await api('config',{codex_enabled:positionals[0]==='on',codex_model:options['codex-model'],codex_effort:options['codex-effort'],codex_voice_id:options['codex-voice']}));}
      else if(command==='events')await client.events(id,e=>{if(e.type!=='audio')console.log(JSON.stringify(e));});
      else if(command==='mark')print(await api('event',{type:'marker',label:positionals.join(' ')||'Keep this moment'}));
      else if(['mute','unmute'].includes(command))print(await api('mute',{muted:command==='mute'}));
      else print(await api(command==='stop'?'end':command,{}));
    }
  }
}catch(error){console.error(error.message);process.exitCode=1;}
function checkedId(id){if(!/^[0-9a-f-]{36}$/i.test(id))throw new Error('Invalid session ID.');return id;}
