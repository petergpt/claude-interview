import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
export const CODEX_MODEL = 'gpt-6-astra';
export const CODEX_EFFORT = 'low';
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const codexBin = process.env.CODEX_BIN || 'codex';

// Let the installed CLI own its ChatGPT login. No token extraction, copied auth home, or API fallback.
export function codexEnvironment(source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^(OPENAI_|ANTHROPIC_|ELEVENLABS_|X_STREAM_)/.test(key) ||
      ['CODEX_API_KEY', 'CODEX_THREAD_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CLAUDECODE'].includes(key)) delete env[key];
  }
  return env;
}

export async function codexStatus() {
  try {
    const { stdout, stderr } = await exec(codexBin, ['login', 'status'], { env: codexEnvironment(), timeout: 15000, maxBuffer: 65536 });
    const ready = /Logged in using ChatGPT/i.test(stdout + stderr);
    return { ready, subscriptionVerified: ready, mode: 'subscription', ...(!ready ? { error: 'Sign in to Codex with ChatGPT using codex login.' } : {}) };
  } catch { return { ready: false, subscriptionVerified: false, mode: 'subscription', error: 'Codex is unavailable. Install the Codex CLI and sign in with ChatGPT.' }; }
}

let catalogue;
export async function codexModels() {
  if (catalogue) return catalogue;
  try {
    const { stdout } = await exec(codexBin, ['debug', 'models', '--bundled'], { env: codexEnvironment(), timeout: 15000, maxBuffer: 8_000_000 });
    const data = JSON.parse(stdout);
    catalogue = (data.models || data).filter(m => m.slug?.startsWith('gpt-') && m.visibility !== 'hide')
      .map(m => ({ id: m.slug, name: m.display_name || m.slug, efforts: (m.supported_reasoning_levels || []).map(x => x.effort) }));
    return catalogue;
  } catch { return [{ id: CODEX_MODEL, name: 'GPT-6 Astra', efforts: CODEX_EFFORTS }]; }
}

export function codexArgs({ model = CODEX_MODEL, effort = CODEX_EFFORT, system = '', cwd, images = [], session }) {
  const args = ['exec', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '--color', 'never',
    '-m', model, '-c', `model_reasoning_effort=${JSON.stringify(effort)}`, '-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"',
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0', '-c', 'mcp_servers={}',
    '-c', `developer_instructions=${JSON.stringify(system)}`];
  if (!session) args.push('--ephemeral');
  // This participant talks. It has no reason to browse, run a shell, load personal skills, or call another agent.
  for (const feature of ['shell_tool', 'apps', 'plugins', 'browser_use', 'computer_use', 'image_generation', 'multi_agent', 'multi_agent_v2', 'memories', 'chronicle', 'skill_search', 'hooks', 'goals']) args.push('--disable', feature);
  args.push('--enable', 'skip_host_skill_discovery');
  if (cwd) args.push('-C', cwd);
  if (session?.id) args.push('resume', session.id);
  for (const file of images) args.push('--image', file);
  return [...args, '-'];
}

export async function runCodex(options) {
  if (options.signal?.aborted) throw new DOMException('Interrupted', 'AbortError');
  if (!(await codexStatus()).ready) throw new Error('Codex needs a ChatGPT subscription login. Run codex login, then rejoin.');
  return runVerifiedCodex(options);
}

export async function runVerifiedCodex({ prompt, system, model = CODEX_MODEL, effort = CODEX_EFFORT, images = [], signal,
  onText = () => {}, onModel = () => {}, session, onSession = () => {}, spawnProcess = spawn, timeoutMs = 180000 }) {
  if (signal?.aborted) throw new DOMException('Interrupted', 'AbortError');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-codex-'));
  try {
    const files = images.map((image, i) => { const file = path.join(dir, `frame-${i}.jpg`); fs.writeFileSync(file, Buffer.from(image.data, 'base64'), { mode: 0o600 }); return file; });
    return await new Promise((resolve, reject) => {
      const child = spawnProcess(codexBin, codexArgs({ model, effort, system, cwd: session?.cwd || dir, images: files, session }), { env: codexEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      let buffer = '', text = '', complete = false, finished = false, stopping;
      const seen = new Set();
      const stop = () => { child.kill('SIGTERM'); const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000); timer.unref(); };
      const finish = error => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve({ text, model }); };
      const fail = error => { stopping ||= error; if (!session) finish(error); stop(); };
      const abort = () => fail(new DOMException('Interrupted', 'AbortError'));
      const timer = setTimeout(() => fail(new Error('Codex took too long. The call and recordings are intact.')), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      const consume = line => {
        if (!line.trim() || finished) return;
        let event; try { event = JSON.parse(line); } catch { return; }
        if (session && event.type === 'thread.started') onSession(event.thread_id);
        if (stopping) return;
        if (event.type === 'turn.failed' || event.type === 'error') throw new Error(`Codex: ${String(event.error?.message || event.message || 'request failed').slice(0, 500)}`);
        if (event.type === 'turn.completed') complete = true;
        const item = event.item;
        if (event.type === 'item.completed' && item?.type === 'agent_message' && !seen.has(item.id) && item.phase !== 'commentary') {
          seen.add(item.id); const delta = item.text || ''; text += delta;
          if (text.length > 8000) throw new Error('Codex reply exceeded the conversation limit.');
          onModel(model); onText(delta);
        }
        if (/^item\./.test(event.type) && ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(item?.type)) throw new Error('Codex attempted a tool action; this participant only speaks.');
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { buffer += chunk; try {
        if (buffer.length > 2_000_000) throw new Error('Codex response exceeded the message limit.');
        let at; while ((at = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, at)); buffer = buffer.slice(at + 1); }
      } catch (error) { fail(error); } });
      child.stderr.on('data', () => {}); // Never expose CLI diagnostics or unrelated account data in the room.
      child.stdin.on('error', () => {});
      child.on('error', () => finish(new Error('Could not start Codex. Check CODEX_BIN and codex login status.')));
      child.on('close', code => { try { consume(buffer); } catch (error) { return finish(error); }
        if (!finished) finish(stopping || (code !== 0 ? new Error(`Codex exited with code ${code}. Check your subscription and selected model.`) : !complete || !text.trim() ? new Error('Codex returned no completed reply.') : null)); });
      // CLI images are attached before the text. Preserve their source and chronological labels.
      const imageContext = images.length ? `Attached images, in order:\n${images.map((image, i) => `Image ${i + 1}: ${image.label || 'Shared call still.'}`).join('\n')}\n\n` : '';
      child.stdin.end(imageContext + prompt);
      if (signal?.aborted) abort();
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
