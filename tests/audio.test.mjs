import test from 'node:test';
import assert from 'node:assert/strict';
import {Mic,Player,PcmUploader} from '../public/audio.js';

const node = () => ({ connect(target) { this.target = target; return target; }, disconnect() { this.disconnected = true; }, gain: { value: 1, setTargetAtTime(v) { this.value = v; } } });
function context() {
  return {currentTime:0,outputLatency:0,destination:{},
    createGain:node, createWaveShaper:node,
    createDynamicsCompressor:()=>({ ...node(), ...Object.fromEntries(['threshold','knee','ratio','attack','release'].map(p => [p, { value: 0 }])) }),
    createAnalyser:()=>({connect(){},getFloatTimeDomainData(){}}),
    createBuffer:(_,n,rate)=>({duration:n/rate,getChannelData:()=>new Float32Array(n)}),
    createBufferSource:()=>({...node(),start(at){this.startTime=at;},stop(){}})};
}
const chunk=Buffer.alloc(4800).toString('base64'); // 100 ms at 24 kHz.

test('speech chunk arriving 5 ms before the previous one ends stays contiguous',()=>{
  const ctx=context(),p=new Player(ctx,{onComplete(){}});p.begin('reply');p.push('reply',chunk);
  const expected=p.turn.nextTime;ctx.currentTime=expected-.005;p.push('reply',chunk);
  assert.equal(p.turn.buffers[1].start,expected,'A chunk that arrived before its deadline must not introduce silence');
});
test('a genuinely late speech chunk is scheduled in the future',()=>{
  const ctx=context(),p=new Player(ctx,{onComplete(){}});p.begin('reply');p.push('reply',chunk);
  ctx.currentTime=p.turn.nextTime+.025;p.push('reply',chunk);
  assert.ok(p.turn.buffers[1].start>ctx.currentTime);
});
test('queued PCM samples stay in order and completion waits for playback',()=>{
  let completions=0;const ctx=context(),p=new Player(ctx,{onComplete(){completions++;}});
  p.begin('reply');for(let i=0;i<6;i++)p.push('reply',chunk);p.finish('reply');
  assert.equal(completions,0);
  for(let i=1;i<6;i++)assert.equal(p.turn.buffers[i].start,p.turn.buffers[i-1].start+.1);
  for(const b of p.turn.buffers)b.src.onended();assert.equal(completions,1);
  assert.equal(p.push('old-reply',chunk),false);
});
test('one playback queue routes each agent into its own recording stem and interrupts the previous source',()=>{
  const ctx=context();let connected,stops=0;
  ctx.createBufferSource=()=>({connect(target){connected=target;},start(){},stop(){stops++;}});
  const p=new Player(ctx,{onComplete(){throw new Error('Interrupted audio must not complete');}});
  p.begin('claude','claude');p.push('claude',chunk);assert.equal(connected,p.strips.claude.input);
  p.begin('codex','codex');assert.equal(stops,1);p.push('codex',chunk);assert.equal(connected,p.strips.codex.input);
  assert.equal(p.push('claude',chunk),false);p.stop();assert.equal(stops,2);
});

test('ending capture drains already captured microphone chunks in order',async()=>{
  const sent=[];let release;
  const uploader=new PcmUploader(async bytes=>{if(!sent.length)await new Promise(r=>release=r);sent.push(bytes);},error=>{throw error;});
  uploader.push(Buffer.from([1]));uploader.push(Buffer.from([2]));await Promise.resolve();
  const close=uploader.close();uploader.push(Buffer.from([3]));release();await close;
  assert.deepEqual(sent.map(b=>b[0]),[1,2]);assert.equal(uploader.pending,0);assert.equal(uploader.sent,2);
});

test('stopping the microphone releases capture nodes while stems can finish flushing',()=>{
  const ctx=context();let disconnected=0;
  const node=()=>({connect(){},disconnect(){disconnected++;}});
  ctx.createMediaStreamSource=node;ctx.createAnalyser=node;
  const mic=new Mic(ctx,{});mic.node={...node(),port:{onmessage(){}}};mic.silent=node();
  mic.stop();
  assert.equal(mic.stopped,true);assert.equal(mic.node.port.onmessage,null);assert.equal(disconnected,4);
});

test('disposing playback stops pending audio and releases every output node',()=>{
  const ctx=context();let stopped=0,disconnected=0;
  ctx.createGain=()=>({...node(),disconnect(){disconnected++;}});
  ctx.createAnalyser=()=>({connect(){},disconnect(){disconnected++;}});
  ctx.createBufferSource=()=>({connect(){},start(){},stop(){stopped++;}});
  const p=new Player(ctx,{onComplete(){throw new Error('Disposed audio must not finish');}});
  p.begin('pending');p.push('pending',chunk);p.dispose();
  assert.equal(stopped,1);assert.equal(disconnected,3);assert.equal(p.strips.claude.output.disconnected,true);assert.equal(p.active,false);
});


test('mix gain changes never unmute the mic, and do not amplify recognition input',()=>{
  const ctx=context();ctx.createMediaStreamSource=node;const mic=new Mic(ctx,{}, {gainDb:13});
  assert.ok(Math.abs(mic.strip.input.gain.value-4.4668)<.001);
  mic.setMuted(true);mic.setGainDb(6);assert.equal(mic.mixGain.gain.value,0);
  mic.setMuted(false);assert.equal(mic.mixGain.gain.value,1);
  assert.ok(Math.abs(mic.strip.input.gain.value-1.995)<.001);
  assert.equal(mic.strip.output.curve[4096],Math.fround(.97));
});
test('a third participant gets its own output and trim without falling back to Claude',()=>{
  const p=new Player(context(),{onComplete(){},levels:{third:-3}});
  p.begin('three','third');p.push('three',chunk);
  assert.equal(p.turn.buffers[0].src.target,p.strips.third.input);
  assert.ok(Math.abs(p.strips.third.input.gain.value-.708)<.001);
  assert.equal(p.voices.claude,undefined);
  p.setGainDb('third',-6);assert.ok(Math.abs(p.strips.third.input.gain.value-.501)<.001);
});
