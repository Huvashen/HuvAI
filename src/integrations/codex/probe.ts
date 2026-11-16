import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdir, readdir, realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve, relative, isAbsolute } from 'node:path';
import { requirePlanOnly } from '../../security/cost-guard.ts';
import { JarvisError } from '../../shared/errors.ts';
import type { Session } from '../openai/oauth.ts';

export function probeArguments() {
  // A text-only feasibility turn. These settings do not implement the future repository permission broker.
  const settings = [
    'model_provider="openai_chatgpt_plan"',
    'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
    'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
    'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"',
    'model_providers.openai_chatgpt_plan.wire_api="responses"',
    'model_providers.openai_chatgpt_plan.requires_openai_auth=false',
    'model_providers.openai_chatgpt_plan.supports_websockets=false',
    'sandbox_mode="read-only"', 'approval_policy="never"',
    'features.shell_tool=false', 'features.apps=false', 'features.hooks=false',
    'features.code_mode.enabled=false', 'agents.enabled=false',
    'web_search="disabled"', 'skills.bundled.enabled=false',
    'analytics.enabled=false', 'feedback.enabled=false',
    'check_for_update_on_startup=false',
  ];
  return ['app-server', '--listen', 'stdio://', ...settings.flatMap(setting => ['-c', setting])];
}

// Pure protocol state allows testing without a provider, credentials, or installed Codex.
export class CodexProbeProtocol {
  threadId?: string;
  turnId?: string;
  textReceived = false;
  finished = false;
  pendingCompletion?: { threadId: string; turn: { id: string; status: string } };
  model: string;
  cwd: string;
  send: (message: unknown) => void;
  delta: (text: string) => void;

  constructor(model: string, cwd: string, send: (message: unknown) => void, delta: (text: string) => void) {
    this.model = model; this.cwd = cwd; this.send = send; this.delta = delta;
  }

  start() {
    this.send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'JARVIS', title: 'JARVIS', version: '0.1.0' } } });
  }

  receive(message: any) {
    if (!message || typeof message !== 'object') throw new JarvisError('CODEX_PROTOCOL', 'Invalid app-server message.');
    if (message.method && message.id !== undefined) {
      // Never authorize commands, patches, permissions, external tools or interactions during this probe.
      this.send({ id: message.id, error: { code: -32601, message: 'Unsupported during the JARVIS feasibility probe.' } });
      throw new JarvisError('CODEX_ACTION_BLOCKED', 'App-server requested an action outside this text-only probe.');
    }
    if (message.error) throw new JarvisError('CODEX_RPC_FAILED', 'App-server rejected a probe request. No paid fallback was attempted.');
    if (message.id === 1) {
      if (!message.result) throw new JarvisError('CODEX_PROTOCOL', 'App-server initialization failed.');
      this.send({ method: 'initialized', params: {} });
      this.send({ id: 2, method: 'thread/start', params: { model: this.model,
        cwd: this.cwd, sandbox: 'read-only', approvalPolicy: 'never' } });
    } else if (message.id === 2) {
      if (typeof message.result?.thread?.id !== 'string') throw new JarvisError('CODEX_PROTOCOL', 'No thread was returned.');
      this.threadId = message.result.thread.id;
      this.send({ id: 3, method: 'turn/start', params: { threadId: this.threadId,
        input: [{ type: 'text', text: 'Without using any tools, say exactly: JARVIS Codex feasibility check passed.' }] } });
    } else if (message.id === 3) {
      if (typeof message.result?.turn?.id !== 'string') throw new JarvisError('CODEX_PROTOCOL', 'No turn was returned.');
      this.turnId = message.result.turn.id;
      if (this.pendingCompletion) this.complete(this.pendingCompletion);
    } else if (message.params?.threadId === this.threadId && this.threadId) {
      if (message.method === 'item/started') {
        const type = message.params.item?.type;
        // userMessage is the app-server's normal representation of our own submitted prompt.
        // Plan items are also text; neither event authorizes a tool or counts as an answer.
        if (!['userMessage', 'agentMessage', 'reasoning', 'plan'].includes(type)) {
          const label = typeof type === 'string' && /^[a-zA-Z]{1,64}$/.test(type) ? type : 'unknown';
          throw new JarvisError('CODEX_ACTION_BLOCKED', `App-server item ${label} is outside this text-only probe; the probe stopped.`);
        }
      }
      if (message.method === 'item/agentMessage/delta' && typeof message.params.delta === 'string') {
        if (message.params.delta.length) this.textReceived = true;
        this.delta(message.params.delta);
      }
      if (message.method === 'turn/completed') {
        if (this.turnId) this.complete(message.params);
        else this.pendingCompletion = message.params;
      }
    }
    return this.finished;
  }

  private complete(params: { threadId: string; turn: { id: string; status: string } }) {
    if (params.threadId !== this.threadId || params.turn?.id !== this.turnId) return;
    if (params.turn.status !== 'completed' || !this.textReceived) {
      throw new JarvisError('CODEX_TURN_FAILED', 'Codex did not complete a text response. Check plan usage, connectivity and provider configuration.');
    }
    this.finished = true;
  }
}

export async function runProbeProcess(child: ChildProcessWithoutNullStreams, model: string, cwd: string,
  delta: (text: string) => void, signal?: AbortSignal) {
  const lines = createInterface({ input: child.stdout });
  child.stderr.resume(); // Raw diagnostics can contain credentials; never relay them.
  let exited = false;
  const closed = new Promise<void>(resolve => child.once('close', () => { exited = true; resolve(); }));
  let cancel!: () => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const protocol = new CodexProbeProtocol(model, cwd,
        message => child.stdin.write(JSON.stringify(message) + '\n'), delta);
      cancel = () => reject(new JarvisError('CANCELLED', 'Codex probe cancelled.'));
      timer = setTimeout(() => reject(new JarvisError('CODEX_TIMEOUT', 'Codex probe timed out.')), 90_000);
      signal?.addEventListener('abort', cancel, { once: true });
      child.once('error', () => reject(new JarvisError('CODEX_START_FAILED', 'Could not launch the local Codex package.')));
      child.stdin.on('error', () => reject(new JarvisError('CODEX_DISCONNECTED', 'The Codex input stream closed.')));
      child.once('close', () => { if (!protocol.finished) reject(new JarvisError('CODEX_DISCONNECTED', 'Codex exited before a completed response.')); });
      lines.on('line', line => {
        try {
          if (line.length > 1_000_000) throw new Error();
          if (protocol.receive(JSON.parse(line))) resolve();
        } catch (error) {
          reject(error instanceof JarvisError ? error : new JarvisError('CODEX_PROTOCOL', 'Invalid app-server output.'));
        }
      });
      if (signal?.aborted) cancel(); else protocol.start();
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    lines.close();
    child.stdin.end();
    const cleanupTimer = setTimeout(() => { if (!exited) child.kill(); }, 2_000);
    await closed;
    clearTimeout(cleanupTimer);
  }
}

export async function proveCodex(projectRoot: string, session: Session, model: string,
  creditsDisabledConfirmed: boolean, delta: (text: string) => void, signal?: AbortSignal) {
  requirePlanOnly(session.scopes, creditsDisabledConfirmed);
  if (session.expiresAt <= Date.now()) throw new JarvisError('AUTH_REQUIRED', 'Session expired. Sign in again.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,100}$/.test(model)) throw new JarvisError('INVALID_MODEL', 'No valid model was supplied.');
  if (process.platform !== 'win32') throw new JarvisError('WINDOWS_REQUIRED', 'This Codex probe targets Windows.');
  const packageRoot = resolve(projectRoot, 'node_modules/@openai/codex');
  await access(packageRoot).catch(() => { throw new JarvisError('CODEX_NOT_INSTALLED',
    'Install the project-local package: npm install --save-dev --save-exact @openai/codex'); });
  // Locate only the installed package's native executable, so shutdown controls the real process,
  // rather than a JS wrapper whose child could survive on Windows.
  const installedRoot = await realpath(resolve(projectRoot, 'node_modules'));
  const roots = [packageRoot, resolve(projectRoot, `node_modules/@openai/codex-win32-${process.arch}`)];
  let binary: string | undefined;
  async function find(directory: string, depth: number): Promise<string | undefined> {
    if (depth > 7) return;
    const canonical = await realpath(directory).catch(() => undefined);
    if (!canonical) return;
    const nested = relative(installedRoot, canonical);
    if (nested.startsWith('..') || isAbsolute(nested)) throw new JarvisError('CODEX_PACKAGE_SCOPE', 'Codex package escapes the project installation.');
    const entries = await readdir(canonical, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name === 'codex.exe') return resolve(canonical, entry.name);
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== 'node_modules') {
        const found = await find(resolve(canonical, entry.name), depth + 1);
        if (found) return found;
      }
    }
  }
  for (const root of roots) { binary = await find(root, 0); if (binary) break; }
  if (!binary) throw new JarvisError('CODEX_NOT_INSTALLED', 'The local Codex native package is missing. Reinstall @openai/codex with optional dependencies enabled.');
  const cwd = resolve(projectRoot, '.jarvis/codex-probe/workspace');
  const isolatedHome = resolve(projectRoot, '.jarvis/codex-probe/home');
  await mkdir(cwd, { recursive: true }); await mkdir(isolatedHome, { recursive: true });
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  // App-server gets JARVIS's token only in its own environment, never another app's session or API key.
  env.ACCESS_TOKEN = session.accessToken;
  env.CODEX_HOME = isolatedHome;
  const child = spawn(binary, probeArguments(), { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  await runProbeProcess(child, model, cwd, delta, signal);
}
