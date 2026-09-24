const BASE = 'https://api.elevenlabs.io';
export async function elevenRequest(key, path, options = {}) {
  if (!key) throw new Error('Configure the backend with ./interview key set.');
  const response = await fetch(BASE + path, {
    ...options, headers: { 'xi-api-key': key, ...options.headers },
    signal: options.signal || AbortSignal.timeout(20000)
  });
  if (!response.ok) {
    let detail; try { detail = await response.json(); } catch {}
    const status = detail?.detail?.status || '';
    throw new Error(`ElevenLabs returned ${response.status}${status ? ` (${status})` : ''}. Check key permissions, model access, and credits in ElevenLabs.`);
  }
  return response.json();
}

export async function voiceCatalogue(key) {
  const data = await elevenRequest(key, '/v2/voices?page_size=100');
  return (data.voices || []).map(v => ({ voice_id: v.voice_id, name: v.name,
    category: v.category, description: v.description || '', labels: v.labels || {}, preview_url: v.preview_url || '' }));
}

export class DialogueVoice {
  constructor({ key, voiceId, model = 'eleven_v3_conversational', signal, onAudio, onAlignment = () => {}, WebSocketClass = WebSocket }) {
    this.queue = []; this.finished = false; this.ending = false; this.signal = signal;
    this.onAudio = onAudio; this.onAlignment = onAlignment;
    this.done = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.done.catch(() => {});
    const url = new URL('wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input');
    url.search = new URLSearchParams({ model_id: model, output_format: 'pcm_24000', sync_alignment: 'true' });
    this.ws = new WebSocketClass(url);
    this.timer = setTimeout(() => this.fail(new Error('ElevenLabs did not finish speech within 120 seconds.')), 120000);
    this.keepAlive = setInterval(() => { if (this.ws.readyState === 1 && !this.ending) this.ws.send(JSON.stringify({ keep_alive: true })); }, 10000);
    this.abort = () => this.fail(new DOMException('Interrupted', 'AbortError'));
    signal?.addEventListener('abort', this.abort, { once: true });
    this.ws.addEventListener('open', () => {
      if (this.finished) { this.ws.close(); return; }
      this.ws.send(JSON.stringify({ voices: [voiceId], xi_api_key: key }));
      for (const msg of this.queue) this.ws.send(JSON.stringify(msg));
      this.queue = [];
    });
    this.ws.addEventListener('message', event => {
      if (this.finished) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.error || msg.message_type === 'error') throw new Error(`ElevenLabs speech error: ${String(msg.error || msg.message || 'generation failed').slice(0,500)}`);
        if (msg.audio) onAudio(Buffer.from(msg.audio, 'base64'));
        if (msg.alignment) onAlignment(msg.alignment);
        if (msg.is_final) this.complete();
      } catch (error) { this.fail(error); }
    });
    this.ws.addEventListener('error', () => this.fail(new Error('ElevenLabs speech connection failed. Check your API key, voice, model access, and network.')));
    this.ws.addEventListener('close', () => { if (!this.finished) this.fail(new Error('ElevenLabs disconnected before confirming complete audio.')); });
    this.voiceId = voiceId;
    if (signal?.aborted) this.abort();
  }
  send(msg) { if (this.finished) return; if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg)); else this.queue.push(msg); }
  write(text) { this.send({ inputs: [{ text, voice_id: this.voiceId, new_turn: false }] }); }
  end() { this.ending = true; this.send({ close_socket: true }); return this.done; }
  cleanup() { clearTimeout(this.timer); clearInterval(this.keepAlive); this.signal?.removeEventListener('abort', this.abort); try { this.ws.close(); } catch {} }
  complete() { if (this.finished) return; this.finished = true; this.cleanup(); this.resolve(); }
  fail(error) { if (this.finished) return; this.finished = true; this.cleanup(); this.reject(error); }
}

// Transcription credentials remain in this backend, never in the client.
export class RealtimeScribe {
  constructor({key,silence=1.5,onMessage=()=>{},onError=()=>{},request=elevenRequest,WebSocketClass=WebSocket}){
    this.closed=false;this.onMessage=onMessage;this.onError=onError;
    this.ready=this.connect({key,silence,request,WebSocketClass});this.ready.catch(()=>{});
  }
  async connect({key,silence,request,WebSocketClass}){
    const {token}=await request(key,'/v1/single-use-token/realtime_scribe',{method:'POST'});
    if(this.closed)throw new Error('Transcription was cancelled.');
    const params=new URLSearchParams({token,model_id:'scribe_v2_realtime',audio_format:'pcm_16000',commit_strategy:'vad',include_timestamps:'true',vad_silence_threshold_secs:String(silence),language_code:'en'});
    this.ws=new WebSocketClass(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params}`);
    await new Promise((resolve,reject)=>{
      let started=false;
      this.rejectReady=reject;
      const fail=error=>{clearTimeout(this.timer);if(this.closed)return;this.close();reject(error);if(started)this.onError(error);};
      this.timer=setTimeout(()=>fail(new Error('Speech recognition connection timed out.')),15000);
      this.ws.addEventListener('message',event=>{
        try{
          const data=JSON.parse(event.data);
          if(data.message_type==='session_started'){started=true;clearTimeout(this.timer);resolve();}
          else if(/quota|insufficient|payment/i.test(data.message_type||'')||/quota|insufficient/i.test(data.error||''))fail(new Error('ElevenLabs credits are used up (speech recognition quota exceeded). Top up the ElevenLabs account, then start a new call.'));
          else if(data.message_type?.includes('error')||data.message_type==='rate_limited')fail(new Error(`Speech recognition: ${String(data.error||data.message||data.message_type).slice(0,500)}`));
          else this.onMessage(data);
        }catch{fail(new Error('Speech recognition returned an invalid message.'));}
      });
      this.ws.addEventListener('error',()=>fail(new Error('Speech recognition connection failed.')));
      this.ws.addEventListener('close',e=>fail(new Error(/insufficient|quota/i.test(e?.reason||'')?'ElevenLabs credits are used up (speech recognition quota exceeded). Top up the ElevenLabs account, then start a new call.':'Speech recognition disconnected.')));
    });
  }
  write(bytes){if(this.closed||this.ws?.readyState!==1)throw new Error('Speech recognition is not connected.');if(this.ws.bufferedAmount>1_000_000)throw new Error('Speech recognition cannot keep up with microphone audio.');this.ws.send(JSON.stringify({message_type:'input_audio_chunk',audio_base_64:bytes.toString('base64'),sample_rate:16000}));}
  close(){this.closed=true;clearTimeout(this.timer);this.rejectReady?.(new Error('Transcription closed.'));this.ws?.close();}
}
