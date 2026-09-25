import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { subscriptionEnvironment, isSubscription, claudeAuthMode } from './core.mjs';
const exec = promisify(execFile);
export const claudeBin = process.env.CLAUDE_BIN || 'claude';

// ready: whether a call can start with the configured mode. Subscription mode also reports subscriptionVerified.
export async function authStatus() {
  if (claudeAuthMode() === 'api') {
    const set = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
    return { mode: 'api', apiKeySet: set, ready: set, subscriptionVerified: false };
  }
  const status = await subscriptionStatus();
  return { mode: 'subscription', ...status, ready: status.subscriptionVerified };
}
async function subscriptionStatus() {
  try {
    const { stdout } = await exec(claudeBin, ['--setting-sources', '', 'auth', 'status'], {
      env: subscriptionEnvironment(), timeout: 20000, maxBuffer: 65536
    });
    const status = JSON.parse(stdout);
    return { ...status, subscriptionVerified: isSubscription(status) };
  } catch (error) {
    // An unauthenticated CLI can return valid status JSON with a nonzero exit.
    try { const status = JSON.parse(error.stdout); return { ...status, subscriptionVerified: isSubscription(status) }; }
    catch { return { loggedIn: false, subscriptionVerified: false, error: 'Claude Code login status is unavailable. Run npm run doctor.' }; }
  }
}

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export function claudeArgs({ system, model = '', effort = '', schema, images = false } = {}) {
  const args = ['--safe-mode', '--setting-sources', '', '-p', '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--no-session-persistence', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--system-prompt', system];
  if (model.trim()) args.push('--model', model.trim());
  if (EFFORTS.includes(effort)) args.push('--effort', effort);
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  // Images can only be attached through streaming input: one JSON user message on stdin with image blocks.
  if (images) args.push('--input-format', 'stream-json');
  return args;
}

export async function runClaude({ prompt, system, model, effort, schema, images, signal, onText = () => {}, onModel = () => {}, spawnProcess = spawn }) {
  if (signal?.aborted) throw new DOMException('Interrupted', 'AbortError');
  const status = await authStatus();
  if (!status.ready) throw new Error(status.mode === 'api' ? 'INTERVIEW_CLAUDE_AUTH=api is set but ANTHROPIC_API_KEY is missing.' : 'Claude subscription login required. Run ./interview login, then retry. There is no silent API fallback; see README for API-key mode.');
  return runVerifiedClaude({ prompt, system, model, effort, schema, images, signal, onText, onModel, spawnProcess });
}

// Split from the authentication gate so the stream protocol can be tested offline.
// images: optional [{ data: <base64 JPEG>, label }] shown to Claude before the prompt text, in order.
export function runVerifiedClaude({ prompt, system, model, effort, schema, images, signal, onText = () => {}, onModel = () => {}, spawnProcess = spawn }) {
  const withImages = Array.isArray(images) && images.length > 0;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Interrupted', 'AbortError'));
    const child = spawnProcess(claudeBin, claudeArgs({ system, model, effort, schema, images: withImages }), {
      env: subscriptionEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], shell: false
    });
    let lineBuffer = '', text = '', result, finished = false, stderr = '';
    const finish = (error) => {
      if (finished) return;
      finished = true; clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve({ text, structured: result?.structured_output, modelUsage: result?.modelUsage });
    };
    const stop = () => {
      child.kill('SIGTERM');
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000); timer.unref();
    };
    const abort = () => { finish(new DOMException('Interrupted', 'AbortError')); stop(); };
    const timeout = setTimeout(() => { finish(new Error('Claude took more than 180 seconds. The saved call is intact; try a shorter turn.')); stop(); }, 180000);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    const consume = line => {
      if (!line.trim() || finished) return;
      let event; try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'system' && event.subtype === 'init') onModel(event.model);
      // Private reasoning, tool content, and system messages are never spoken or logged.
      if (event.type === 'stream_event' && !event.parent_tool_use_id && event.event?.delta?.type === 'text_delta' && !schema) {
        const delta = event.event.delta.text; text += delta; onText(delta);
      }
      if (event.type === 'result') {
        result = event;
        if (event.is_error) { stop(); finish(new Error(String(event.result || event.errors?.join(' ') || 'Claude request failed.').slice(0,800))); return; }
        if (!schema && !text && typeof event.result === 'string') { text = event.result; onText(text); }
      }
    };
    child.stdout.on('data', chunk => {
      lineBuffer += chunk;
      if (lineBuffer.length > 2_000_000) { stop(); finish(new Error('Claude stream exceeded the expected message size.')); return; }
      try { let at; while ((at = lineBuffer.indexOf('\n')) >= 0) { consume(lineBuffer.slice(0, at)); lineBuffer = lineBuffer.slice(at + 1); } }
      catch (error) { finish(error); stop(); }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.stdin.on('error', () => {});
    child.on('error', () => finish(new Error('Could not start Claude Code. Check CLAUDE_BIN and npm run doctor.')));
    child.on('close', code => {
      try { consume(lineBuffer); } catch (error) { finish(error); return; }
      if (finished) return;
      if (code !== 0) finish(new Error(`Claude Code exited with code ${code}. Run npm run doctor. ${/unknown option/.test(stderr) ? 'Your installed CLI does not support a required option.' : ''}`));
      else if (!result || (schema ? !result.structured_output : !text.trim())) finish(new Error('Claude returned no completed response. Nothing was substituted.'));
      else finish();
    });
    if (!withImages) child.stdin.end(prompt);
    else child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: [
      ...images.flatMap(i => [...(i.label ? [{ type: 'text', text: i.label }] : []), { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: i.data } }]),
      { type: 'text', text: prompt }] } }) + '\n');
  });
}
