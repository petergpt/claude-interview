import test from 'node:test';
import assert from 'node:assert/strict';
import { DialogueVoice } from '../src/eleven.mjs';
class FakeSocket extends EventTarget {
  static latest;
  constructor(url){super();this.url=String(url);this.sent=[];this.readyState=0;FakeSocket.latest=this;}
  open(){this.readyState=1;this.dispatchEvent(new Event('open'));}
  send(text){this.sent.push(JSON.parse(text));}
  close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
  message(data){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}));}
}
test('v3 uses dialogue endpoint, registers before queued text, and requests PCM',async()=>{
  let bytes=0;const voice=new DialogueVoice({key:'test-key',voiceId:'v1',WebSocketClass:FakeSocket,onAudio:b=>bytes+=b.length});
  voice.write('[curious] Hello there.');const done=voice.end();const ws=FakeSocket.latest;ws.open();
  assert.match(ws.url,/text-to-dialogue/);assert.match(ws.url,/pcm_24000/);assert.ok(!ws.url.includes('test-key'));
  assert.deepEqual(ws.sent[0],{voices:['v1'],xi_api_key:'test-key'});assert.equal(ws.sent[1].inputs[0].text,'[curious] Hello there.');assert.deepEqual(ws.sent[2],{close_socket:true});
  ws.message({audio:Buffer.alloc(4).toString('base64')});ws.message({is_final:true});await done;assert.equal(bytes,4);
});
test('interruption rejects generation and ignores late audio',async()=>{
  const controller=new AbortController();let bytes=0;const voice=new DialogueVoice({key:'key',voiceId:'v1',signal:controller.signal,WebSocketClass:FakeSocket,onAudio:b=>bytes+=b.length});const ws=FakeSocket.latest;ws.open();controller.abort();ws.message({audio:'AAAA'});await assert.rejects(voice.done,/Interrupted/);assert.equal(bytes,0);
});
test('a dropped socket is not treated as completed audio',async()=>{
  const voice=new DialogueVoice({key:'key',voiceId:'v1',WebSocketClass:FakeSocket,onAudio:()=>{}});FakeSocket.latest.open();FakeSocket.latest.close();await assert.rejects(voice.done,/before confirming/);
});

import {RealtimeScribe} from '../src/eleven.mjs';
test('Scribe owns its token, sends PCM and forwards transcript events',async()=>{
  const received=[];const recognizer=new RealtimeScribe({key:'secret',WebSocketClass:FakeSocket,request:async()=>({token:'ephemeral'}),onMessage:e=>received.push(e)});
  await Promise.resolve();const ws=FakeSocket.latest;ws.open();ws.message({message_type:'session_started'});await recognizer.ready;
  recognizer.write(Buffer.from([1,0]));assert.equal(ws.sent[0].message_type,'input_audio_chunk');assert.equal(ws.sent[0].sample_rate,16000);
  ws.message({message_type:'committed_transcript',text:'Hello'});assert.equal(received[0].text,'Hello');recognizer.close();
});
test('closing Scribe while connecting settles its readiness promise',async()=>{
  const recognizer=new RealtimeScribe({key:'secret',WebSocketClass:FakeSocket,request:async()=>({token:'ephemeral'})});await Promise.resolve();recognizer.close();await assert.rejects(recognizer.ready,/closed/);
});
