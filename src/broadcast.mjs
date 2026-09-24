import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg } from './native.mjs';
import { readSecret } from './credentials.mjs';

// The existing server supplies localhost, same-origin and session-cookie checks.
// The stream key comes from the backend (X_STREAM_KEY or macOS Keychain via ./interview stream-key set); the page never
// sees it. ffmpeg needs the full RTMPS destination as an argument, so while a stream runs the key is visible in the
// local process list (ps) to other accounts on this computer. It is never logged or returned.
export function createBroadcast(root, { loadStreamKey = () => readSecret('xstream') } = {}) {
  let run = null;
  const status = () => run ? ({ id: run.id, state: run.state, mode: run.mode, frames: run.frames,
    fps: run.fps, bytes: run.bytes, seconds: run.seconds, error: run.error, file: run.file }) : { state: 'idle' };
  async function stop() {
    const r = run; if (!r || r.closed) return status();
    r.stopping = true; clearInterval(r.watchdog); r.proc.stdin.end();
    const kill = setTimeout(() => r.proc.kill('SIGKILL'), 5000);
    await r.done; clearTimeout(kill); return status();
  }
  async function start(data) {
    if (run && !run.closed) throw new Error('A stream is already running. Stop it first.');
    const mode = data.mode === 'test' ? 'test' : 'x';
    let destination, key = '';
    if (mode === 'x') {
      let url; try { url = new URL(data.url || process.env.X_STREAM_URL || ''); } catch { throw new Error('Enter the RTMPS server address supplied by X.'); }
      if (url.protocol !== 'rtmps:' || !/(^|\.)(pscp\.tv|x\.com|twitter\.com)$/.test(url.hostname) || url.username || url.password || url.search || url.hash)
        throw new Error('Use the RTMPS server address supplied by X.');
      key = await loadStreamKey();
      if (!/^[A-Za-z0-9_?=&.-]{8,512}$/.test(key)) throw new Error('No X stream key is set. Run ./interview stream-key set (or set X_STREAM_KEY).');
      destination = url.href.replace(/\/$/, '') + '/' + key;
    }
    const id = randomUUID(), dir = path.join(root, '.runtime', 'stream-checks');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = mode === 'test' ? path.join(dir, `${id}.mp4`) : null;
    const args = ['-hide_banner', '-loglevel', 'warning', '-nostats', '-progress', 'pipe:3',
      '-probesize', '1000000', '-analyzeduration', '1000000', '-i', 'pipe:0',
      '-map', '0:v:0', '-map', '0:a:0', '-vf', 'fps=30,format=yuv420p',
      // Hardware H.264 on macOS; a fast software encoder elsewhere.
      ...(process.platform === 'darwin' ? ['-c:v', 'h264_videotoolbox', '-realtime', '1'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency']), '-profile:v', 'high',
      '-b:v', '9000k', '-maxrate', '10000k', '-bufsize', '18000k', '-g', '90',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-af', 'aresample=async=1:first_pts=0,alimiter=limit=0.89:level=0',
      ...(file ? ['-movflags', '+faststart', '-f', 'mp4', file] : ['-flvflags', 'no_duration_filesize', '-f', 'flv', destination])];
    const proc = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe', 'pipe'] });
    const r = run = { id, proc, mode, file, state: 'connecting', seq: 0, frames: 0, fps: 0, seconds: 0, bytes: 0,
      lastChunk: Date.now(), closed: false, stopping: false, error: null, logs: '' };
    r.done = new Promise(resolve => {
      proc.on('error', () => { r.error = 'Could not start the local encoder.'; });
      proc.on('close', code => { clearInterval(r.watchdog); r.closed = true;
        r.state = r.stopping && code === 0 && !r.error ? 'stopped' : 'error';
        if (r.state === 'error') r.error ||= `Encoder stopped (${code ?? 'unavailable'}). ${r.logs.slice(-500)}`;
        resolve();
      });
    });
    proc.stdin.on('error', () => {});
    proc.stderr.on('data', b => {
      let s = b.toString().replace(/rtmps?:\/\/\S+/g, '[X destination]');
      if (key) s = s.split(key).join('[redacted]');
      r.logs = (r.logs + s).slice(-2000);
    });
    let progress = '';
    proc.stdio[3].on('data', b => {
      progress += b.toString(); const lines = progress.split('\n'); progress = lines.pop();
      for (const line of lines) { const [key, value] = line.split('=');
        if (key === 'frame') { r.frames = Number(value); if (r.frames > 0 && !r.stopping) r.state = 'sending'; }
        if (key === 'fps') r.fps = Number(value);
        if (key === 'out_time_us') r.seconds = Number(value) / 1e6;
      }
    });
    r.watchdog = setInterval(() => { if (Date.now() - r.lastChunk > 15000) { r.error = 'Interview tab stopped supplying frames.'; void stop(); } }, 2000);
    return status();
  }
  async function chunk(id, seq, bytes) {
    const r = run;
    if (!r || r.id !== id || r.closed || r.stopping) throw new Error('The encoder is not accepting media.');
    if (seq !== r.seq) throw new Error('Media arrived out of order. Restart the stream.');
    r.seq++; r.lastChunk = Date.now(); r.bytes += bytes.length;
    await new Promise((resolve, reject) => r.proc.stdin.write(bytes, error => error ? reject(new Error('Encoder connection closed.')) : resolve()));
    return { accepted: seq };
  }
  const keySet = async () => Boolean(await loadStreamKey().catch(() => ''));
  return { start, chunk, stop, status, keySet };
}
