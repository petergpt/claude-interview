import test from 'node:test';
import assert from 'node:assert/strict';
import {Player} from '../public/audio.js';

function context() {
  return {currentTime:0,outputLatency:0,destination:{},
    createGain:()=>({connect(){}}),
    createAnalyser:()=>({connect(){},getFloatTimeDomainData(){}}),
    createBuffer:(_,n,rate)=>({duration:n/rate,getChannelData:()=>new Float32Array(n)}),
    createBufferSource:()=>({connect(){},start(at){this.startTime=at;},stop(){}})};
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
