import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CodexProbeProtocol, probeArguments, proveCodex, runProbeProcess } from '../src/integrations/codex/probe.ts';
import type { Session } from '../src/integrations/openai/oauth.ts';

function started() {
  const messages: any[] = []; let text = '';
  const protocol = new CodexProbeProtocol('test-model', 'isolated-workspace', m => messages.push(m), d => text += d);
  protocol.start();
  protocol.receive({ id: 1, result: { userAgent: 'test' } });
  protocol.receive({ id: 2, result: { thread: { id: 'thread-test' } } });
  return { protocol, messages, text: () => text };
}

test('Codex handshake binds the JARVIS client and read-only text-only turn', () => {
  const { messages } = started();
  assert.equal(messages[0].params.clientInfo.name, 'JARVIS');
  assert.equal(messages[1].method, 'initialized');
  assert.equal(messages[2].params.sandbox, 'read-only');
  assert.equal(messages[2].params.approvalPolicy, 'never');
  assert.equal(messages[3].params.threadId, 'thread-test');
});

test('Codex succeeds only for matching completed turn with streamed text', () => {
  const { protocol, text } = started();
  protocol.receive({ id: 3, result: { turn: { id: 'turn-test' } } });
  protocol.receive({ method: 'item/agentMessage/delta', params: { threadId: 'thread-test', delta: 'ready' } });
  assert.equal(protocol.receive({ method: 'turn/completed', params: { threadId: 'other', turn: { id: 'turn-test', status: 'completed' } } }), false);
  assert.equal(protocol.receive({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status: 'completed' } } }), true);
  assert.equal(text(), 'ready');
});

test('completion arriving before turn acknowledgment is retained', () => {
  const { protocol } = started();
  protocol.receive({ method: 'item/agentMessage/delta', params: { threadId: 'thread-test', delta: 'ready' } });
  protocol.receive({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status: 'completed' } } });
  assert.equal(protocol.finished, false);
  assert.equal(protocol.receive({ id: 3, result: { turn: { id: 'turn-test' } } }), true);
});

test('empty, failed and interrupted Codex turns do not pass', () => {
  for (const status of ['completed', 'failed', 'interrupted']) {
    const { protocol } = started();
    protocol.receive({ id: 3, result: { turn: { id: 'turn-test' } } });
    assert.throws(() => protocol.receive({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status } } }), { code: 'CODEX_TURN_FAILED' });
  }
});

test('server action requests and non-text items fail closed', () => {
  const { protocol, messages } = started();
  assert.throws(() => protocol.receive({ id: 90, method: 'item/commandExecution/requestApproval', params: {} }), { code: 'CODEX_ACTION_BLOCKED' });
  assert.equal(messages.at(-1).error.code, -32601);
  assert.throws(() => started().protocol.receive({ method: 'item/started', params: { threadId: 'thread-test', item: { type: 'commandExecution' } } }), { code: 'CODEX_ACTION_BLOCKED' });
});

test('normal user-message and plan items are allowed but cannot pass the probe', () => {
  const { protocol } = started();
  protocol.receive({ id: 3, result: { turn: { id: 'turn-test' } } });
  for (const type of ['userMessage', 'plan', 'reasoning', 'agentMessage']) {
    assert.equal(protocol.receive({ method: 'item/started', params: { threadId: 'thread-test', item: { type } } }), false);
  }
  assert.equal(protocol.textReceived, false);
  protocol.receive({ method: 'item/agentMessage/delta', params: { threadId: 'thread-test', delta: 'ready' } });
  assert.equal(protocol.receive({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status: 'completed' } } }), true);
});

test('tool and unknown item types remain blocked without leaking item content', () => {
  for (const type of ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall',
    'collabToolCall', 'webSearch', 'imageView', 'contextCompaction', 'newUnknownTool', 'secret-value-do-not-print']) {
    assert.throws(() => started().protocol.receive({ method: 'item/started', params: {
      threadId: 'thread-test', item: { type, content: 'secret-content-do-not-print' },
    } }), error => {
      assert.equal((error as any).code, 'CODEX_ACTION_BLOCKED');
      assert.ok(!(error as Error).message.includes('secret-'));
      return true;
    });
  }
});

test('Codex arguments select plan OAuth and disable commands, apps, hooks, agents and search', () => {
  const args = probeArguments();
  assert.ok(args.includes('model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"'));
  for (const setting of ['features.shell_tool=false', 'features.apps=false', 'features.hooks=false', 'agents.enabled=false', 'web_search="disabled"']) assert.ok(args.includes(setting));
  assert.ok(!args.some(value => value.includes('api_key=')));
});

test('Codex cost checks run before installation checks or process launch', async () => {
  const session = { scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'], expiresAt: Date.now() + 10000 } as Session;
  await assert.rejects(proveCodex('not-a-project', session, 'test-model', false, () => {}), { code: 'COST_UNVERIFIED' });
  await assert.rejects(proveCodex('not-a-project', { ...session, expiresAt: 0 }, 'test-model', true, () => {}), { code: 'AUTH_REQUIRED' });
});

test('supervised stdio probe completes and shuts down its process', async () => {
  const stub = `
    const readline = require('node:readline');
    const lines = readline.createInterface({ input: process.stdin });
    const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
    lines.on('line', line => {
      const m = JSON.parse(line);
      if (m.id === 1) send({id:1,result:{userAgent:'test'}});
      if (m.id === 2) send({id:2,result:{thread:{id:'t'}}});
      if (m.id === 3) {
        send({method:'item/started',params:{threadId:'t',item:{type:'userMessage',content:[{type:'text',text:'test prompt'}]}}});
        send({id:3,result:{turn:{id:'u'}}});
        send({method:'item/agentMessage/delta',params:{threadId:'t',delta:'test output'}});
        send({method:'turn/completed',params:{threadId:'t',turn:{id:'u',status:'completed'}}});
      }
    });
  `;
  const child = spawn(process.execPath, ['-e', stub], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  await runProbeProcess(child, 'test-model', 'test-workspace', delta => output += delta);
  assert.equal(output, 'test output');
  assert.equal(child.exitCode, 0);
});

test('supervised early process exit fails instead of passing', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  await assert.rejects(runProbeProcess(child, 'test-model', 'test-workspace', () => {}), { code: 'CODEX_DISCONNECTED' });
});

test('cancelled probe terminates its helper', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runProbeProcess(child, 'test-model', 'test-workspace', () => {}, controller.signal), { code: 'CANCELLED' });
  assert.ok(child.killed || child.exitCode !== null);
});
