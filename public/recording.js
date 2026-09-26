// MediaRecorder capture with an IndexedDB backup of every chunk. Backups are removed only after the
// backend has received every chunk in order and `media-complete` was accepted.
let dbPromise;
function database() {
  return dbPromise ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('claude-interview-recordings', 1);
    request.onupgradeneeded = () => { const store = request.result.createObjectStore('chunks', { keyPath: 'id' }); store.createIndex('recording', 'recording'); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function storeChunk(record) {
  const db = await database();
  return new Promise((resolve, reject) => { const tx = db.transaction('chunks', 'readwrite'); tx.objectStore('chunks').put(record); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
}
async function chunksFor(recording) {
  const db = await database();
  return new Promise((resolve, reject) => { const r = db.transaction('chunks').objectStore('chunks').index('recording').getAll(recording); r.onsuccess = () => resolve(r.result.sort((a, b) => a.seq - b.seq)); r.onerror = () => reject(r.error); });
}
export async function removeRecording(recording) {
  const items = await chunksFor(recording), db = await database();
  return new Promise((resolve, reject) => { const tx = db.transaction('chunks', 'readwrite'); for (const item of items) tx.objectStore('chunks').delete(item.id); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
}
export async function backups() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const found = new Map(); const r = db.transaction('chunks').objectStore('chunks').openCursor();
    r.onsuccess = () => { const c = r.result; if (!c) return resolve([...found.values()]); const v = c.value; const f = found.get(v.recording) || { recording: v.recording, name: v.name, mime: v.mime, chunks: 0, bytes: 0 }; f.chunks++; f.bytes += v.blob.size; found.set(v.recording, f); c.continue(); };
    r.onerror = () => reject(r.error);
  });
}
// The whole backup as one file, and whether every chunk from the first one is present.
export async function backupBlob(item) {
  const chunks = await chunksFor(item.recording);
  return { blob: new Blob(chunks.map(x => x.blob), { type: item.mime }), contiguous: chunks.every((c, i) => c.seq === i) };
}
export async function recover(item) {
  const chunks = await chunksFor(item.recording); const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(chunks.map(x => x.blob), { type: item.mime })); a.download = `recovered-${item.recording}`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
export async function recordTrack({ sessionId, kind, stream, api, clientMs, onError, onProgress = () => {}, videoBitsPerSecond = 8_000_000 }) {
  await database();
  const video = stream.getVideoTracks().length > 0;
  // H.264 first: Chrome encodes it in hardware on macOS; VP8 is software-only and costly with two recordings at once.
  const mime = (video ? ['video/webm;codecs=h264,opus', 'video/webm;codecs=avc1,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'] : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']).find(m => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error('This browser cannot record this media format. Use current Chrome.');
  const name = `${kind}.${mime.includes('mp4') ? 'mp4' : 'webm'}`, recording = `${sessionId}-${name}`;
  const recorder = new MediaRecorder(stream, { mimeType: mime, ...(video ? { videoBitsPerSecond } : {}), audioBitsPerSecond: 192000 });
  let seq = 0, queue = Promise.resolve(), firstError = null, backupError = null, uploaded = 0, pending = 0;
  await api('event', { type: 'media-start', name, mime_type: mime, client_ms: clientMs() });
  recorder.ondataavailable = e => {
    if (!e.data.size) return;
    const chunkSeq = seq++; pending++; onProgress({ name, uploaded, pending, failed: Boolean(firstError) });
    queue = queue.then(async () => {
      try { await storeChunk({ id: `${recording}-${chunkSeq}`, recording, name, mime, seq: chunkSeq, blob: e.data }); }
      catch (error) { if (!backupError) { backupError = error; onError(new Error(`${name}: browser backup storage failed. Uploading to the local server will continue.`)); } }
      if (firstError) return;
      let error;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await api(`media?name=${name}&seq=${chunkSeq}`, e.data); uploaded += e.data.size; return; } catch (e) { error = e; }
      }
      throw error;
    }).catch(error => { if (!firstError) { firstError = error; onError(new Error(`${name}: ${error.message}. ${backupError ? 'Some chunks may be missing from the browser backup.' : 'Browser backup retained; use Recover on the start screen.'}`)); } })
      .finally(() => { pending--; onProgress({ name, uploaded, pending, failed: Boolean(firstError) }); });
  };
  recorder.onerror = e => { firstError ||= e.error || new Error('Media recorder failed.'); onError(firstError); };
  recorder.start(2000);
  return {
    name, recorder,
    async stop() {
      if (recorder.state !== 'inactive') await new Promise(resolve => { recorder.addEventListener('stop', resolve, { once: true }); recorder.stop(); });
      await queue;
      if (firstError) throw firstError;
      await api('event', { type: 'media-complete', name, bytes: uploaded, client_ms: clientMs() });
      await removeRecording(recording);
      return { name, bytes: uploaded };
    }
  };
}

// Lossless voice stem: 16-bit mono PCM at the AudioContext rate, uploaded in order with the same IndexedDB
// backup as the video recordings. The backend turns the finished .pcm into a .wav.
let pcmModule;
export async function recordPcm({ sessionId, kind, ctx, source, api, clientMs, onError, onProgress = () => {} }) {
  await database();
  pcmModule ||= ctx.audioWorklet.addModule('/pcm-recorder-worklet.js'); await pcmModule;
  const name = `${kind}.pcm`, recording = `${sessionId}-${name}`, rate = ctx.sampleRate, mime = `audio/pcm;rate=${rate}`;
  const node = new AudioWorkletNode(ctx, 'pcm-recorder', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
  const sink = ctx.createGain(); sink.gain.value = 0; source.connect(node); node.connect(sink).connect(ctx.destination);
  let seq = 0, queue = Promise.resolve(), firstError = null, uploaded = 0, pending = 0, flushed, stopped = false;
  await api('event', { type: 'media-start', name, mime_type: mime, sample_rate: rate, client_ms: clientMs(), audio_clock: ctx.currentTime });
  node.port.onmessage = e => {
    if (e.data?.flushed) { flushed?.(); return; }
    if (stopped) return;
    const blob = new Blob([e.data], { type: 'application/octet-stream' }), chunkSeq = seq++; pending++;
    queue = queue.then(async () => {
      try { await storeChunk({ id: `${recording}-${chunkSeq}`, recording, name, mime, seq: chunkSeq, blob }); } catch {}
      if (firstError) return;
      let error; for (let attempt = 0; attempt < 3; attempt++) { try { await api(`media?name=${name}&seq=${chunkSeq}`, blob); uploaded += blob.size; return; } catch (e) { error = e; } }
      throw error;
    }).catch(error => { if (!firstError) { firstError = error; onError(new Error(`${name}: ${error.message}. Browser backup retained.`)); } })
      .finally(() => { pending--; onProgress({ name, uploaded, pending, failed: Boolean(firstError) }); });
  };
  return {
    name,
    async stop() {
      await new Promise(resolve => { flushed = resolve; node.port.postMessage('stop'); setTimeout(resolve, 500); });
      stopped = true; node.port.onmessage = null;
      try { source.disconnect(node); } catch {} node.disconnect(); sink.disconnect();
      await queue;
      if (firstError) throw firstError;
      await api('event', { type: 'media-complete', name, bytes: uploaded, sample_rate: rate, client_ms: clientMs() });
      await removeRecording(recording);
      return { name, bytes: uploaded };
    }
  };
}
