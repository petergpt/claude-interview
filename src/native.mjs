import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import readline from 'node:readline';
export const ffmpeg = process.env.FFMPEG_BIN || (fs.existsSync('/opt/homebrew/bin/ffmpeg')?'/opt/homebrew/bin/ffmpeg':'ffmpeg');
export const ffplay = process.env.FFPLAY_BIN || (fs.existsSync('/opt/homebrew/bin/ffplay')?'/opt/homebrew/bin/ffplay':'ffplay');
export function listDevices(){return new Promise(resolve=>{let output='';const child=spawn(ffmpeg,['-hide_banner','-f','avfoundation','-list_devices','true','-i',''],{stdio:['ignore','ignore','pipe']});child.stderr.on('data',b=>output+=b);child.on('error',()=>{console.error('FFmpeg is unavailable.');resolve(1);});child.on('close',()=>{const lines=output.split('\n').filter(line=>line.includes('AVFoundation ')||/\]\s+\[\d+\]/.test(line));console.log(lines.map(line=>line.replace(/^\[AVFoundation indev[^\]]*\]\s*/, '')).join('\n'));resolve(lines.length?0:1);});});}
export function startCapture({mic='default',camera,dir,onAudio,onError}){
  const input=camera!==undefined?`${camera}:${mic}`:`none:${mic}`;
  const args=['-hide_banner','-loglevel','warning','-nostdin','-f','avfoundation'];
  if(camera!==undefined)args.push('-framerate','30','-video_size','1920x1080');
  args.push('-i',input,'-map','0:a','-ac','1','-ar','16000','-f','s16le','pipe:1');
  const video=camera!==undefined?path.join(dir,'user-camera.mov'):null;
  if(video)args.push('-map','0:v','-map','0:a','-c:v','h264_videotoolbox','-b:v','8M','-c:a','aac','-movflags','+faststart','-n',video);
  const child=spawn(ffmpeg,args,{stdio:['ignore','pipe','pipe']});let stderr='',ended=false,pending=Buffer.alloc(0),first=false;let readyResolve,readyReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});ready.catch(()=>{});
  const readyTimer=setTimeout(()=>{readyReject(new Error('No microphone audio arrived. Check macOS microphone permission and ./interview devices.'));child.kill('SIGINT');},20000);
  const failure=error=>{readyReject(error);onError(error);};
  child.stderr.on('data',b=>stderr=(stderr+b).slice(-2000));
  const upload=(async()=>{try{for await(const chunk of child.stdout){pending=Buffer.concat([pending,chunk]);while(pending.length>=6400){const bytes=pending.subarray(0,6400);pending=pending.subarray(6400);await onAudio(bytes);if(!first){first=true;clearTimeout(readyTimer);readyResolve();}}}if(pending.length>=2)await onAudio(pending.subarray(0,pending.length-pending.length%2));}catch(e){if(!ended)failure(e);child.kill('SIGINT');}})();
  const closed=new Promise(resolve=>{child.on('error',e=>{clearTimeout(readyTimer);failure(new Error(`Could not start FFmpeg: ${e.code}`));resolve();});child.on('close',code=>{clearTimeout(readyTimer);if(!ended&&code!==0)failure(new Error(`Microphone capture stopped (${code}). ${stderr}`));resolve();});});
  return {ready,video,async stop(){ended=true;clearTimeout(readyTimer);child.kill('SIGINT');const timer=setTimeout(()=>child.kill('SIGKILL'),8000);await closed;clearTimeout(timer);await upload;return video&&fs.existsSync(video)?fs.statSync(video).size:0;}};
}
function playPCM({onComplete,onError}){
  const child=spawn(ffplay,['-hide_banner','-loglevel','error','-nodisp','-autoexit','-f','s16le','-ar','24000','-ch_layout','mono','-i','pipe:0'],{stdio:['pipe','ignore','pipe']});
  let bytes=0,start=0,stopped=false,finished=false,stderr='';
  child.stderr.on('data',b=>stderr=(stderr+b).slice(-700));child.stdin.on('error',()=>{});
  child.on('error',()=>onError(new Error('Could not start ffplay audio output.')));
  child.on('close',code=>{if(stopped)return;finished=true;if(code===0)onComplete(bytes/48000);else onError(new Error(`Audio output failed (${code}): ${stderr}`));});
  return {write(buffer){if(!start)start=performance.now();bytes+=buffer.length;child.stdin.write(buffer);},end(){child.stdin.end();},stop(){stopped=true;child.kill('SIGTERM');return finished?bytes/48000:Math.min(bytes/48000,start?(performance.now()-start)/1000:0);}};
}
export async function talk(client,options={}){
  if(process.platform!=='darwin')throw new Error('Native capture currently uses macOS AVFoundation. The local API accepts PCM from other clients.');
  const s=await client.request('/api/sessions',{codex_enabled:options.codex===true||options.codex==='on',codex_model:options['codex-model']||undefined,codex_effort:options['codex-effort']||undefined,codex_voice_id:options['codex-voice']||undefined,user_name:typeof options.name==='string'?options.name:undefined,voice_id:options.voice||'auto',tts_model:options.tts||'eleven_v3_conversational',topic:options.topic||'',claude_model:options.model||'',claude_effort:options.effort||''});
  const api=(action,data)=>client.request(`/api/sessions/${s.id}/${action}`,data);
  const abort=new AbortController();let capture,player,playerId,closing=false,muted=false,lines,connectedResolve,finishResolve;
  const finished=new Promise(r=>finishResolve=r),connected=new Promise(r=>connectedResolve=r);
  const safe=promise=>promise.catch(e=>console.error(e.message));
  const stopPlayer=async()=>{if(!player)return;const id=playerId,seconds=player.stop();player=null;playerId=null;await safe(api('event',{type:'audio-playback',turn_id:id,played_seconds:seconds,estimated:true,source:'ffplay-wall-clock'}));};
  const close=async()=>{if(closing)return;closing=true;lines?.close();await stopPlayer();
    if(capture){const bytes=await capture.stop();if(capture.video&&bytes)await safe(api('event',{type:'media-complete',name:'user-camera.mov',bytes}));}
    await safe(api('end',{}));abort.abort();process.removeListener('SIGINT',close);process.removeListener('SIGTERM',close);
    console.log(`\nSaved: ${s.recording_directory}`);finishResolve();};
  const onError=e=>{console.error(e.message);void close();};
  const stream=client.events(s.id,async e=>{
    if(e.type==='connected')connectedResolve();
    if(e.type==='model')console.log(`${e.speaker==='codex'?'Codex':'Claude'} model: ${e.model}`);
    if(e.type==='voice')console.log(`Voice chosen by Claude: ${e.voice.name}\n${e.voice.rationale}`);
    if(e.type==='user-turn')console.log(`\n${options.name||'You'}: ${e.turn.text}`);
    if(e.type==='turn-start'){await stopPlayer();playerId=e.turn_id;process.stdout.write(`\n${e.speaker==='codex'?'Codex':'Claude'}: `);}
    if(e.type==='text')process.stdout.write(e.delta);
    if(e.type==='audio'&&e.turn_id===playerId){
      if(!player){const id=playerId;player=playPCM({onComplete:seconds=>{if(playerId===id){player=null;playerId=null;}void safe(api('event',{type:'playback-complete',turn_id:id,played_seconds:seconds,source:'ffplay-exited-successfully'}));},onError});}
      player.write(Buffer.from(e.audio,'base64'));
    }
    if(e.type==='turn-skipped'&&e.turn_id===playerId){playerId=null;process.stdout.write('[listening]\n');}
    if(e.type==='turn-done'&&e.turn_id===playerId){process.stdout.write('\n');player?.end();}
    if(e.type==='interrupted'&&(!e.turn_id||e.turn_id===playerId)){await stopPlayer();console.log('\n[interrupted]');}
    if(e.type==='error')onError(new Error(e.message));
    if(e.type==='session-ended'&&!closing)void close();
  },{controller:true,signal:abort.signal}).catch(e=>{if(e.name!=='AbortError')onError(e);});
  try{
    await Promise.race([connected,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Event stream did not connect.')),10000).unref())]);
    if (options.muted) { muted=true; await api('mute',{muted:true}); }
    await api('listen',{silence:Number(options.silence||1.5)});
    if(closing)return;
    if(options.camera!==undefined)await api('event',{type:'media-start',name:'user-camera.mov',mime_type:'video/quicktime'});
    capture=startCapture({mic:options.mic||'default',camera:options.camera,dir:s.recording_directory,onAudio:b=>api('input-audio',b),onError});
    await capture.ready;if(closing)return;
    process.on('SIGINT',close);process.on('SIGTERM',close);
    console.log(`\nSession: ${s.id}\n${muted?'Microphone starts muted. ':''}Speak naturally with headphones. /stop /interrupt /mute /mark; type any turn and press Enter.\n`);
    lines=readline.createInterface({input:process.stdin,terminal:false});
    lines.on('line',async text=>{try{const t=text.trim();if(t==='/stop')return void close();if(t==='/interrupt')return void await api('interrupt',{turn_id:playerId});if(t==='/mute'){muted=!muted;await api('mute',{muted});console.log(muted?'Microphone muted.':'Listening.');return;}if(t==='/mark')return void await api('event',{type:'marker',label:'Keep this moment'});if(t)await api('turn',{text:t,request_id:randomUUID(),reply_id:randomUUID()});}catch(e){console.error(e.message);}});
    if(!options['no-intro'])await api('turn',{introduction:true,request_id:randomUUID(),reply_id:randomUUID()});
    await finished;
  }catch(e){console.error(e.message);await close();throw e;}finally{if(!closing)await close();await stream;}
}
