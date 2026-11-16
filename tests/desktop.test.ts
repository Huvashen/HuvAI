import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { DesktopStore } from '../src/storage/desktop-store.ts';
import { DesktopService } from '../apps/desktop/src/main/desktop-service.ts';
import { WindowsVault } from '../src/storage/windows-vault.ts';
import { validateDesktopRequest } from '../src/security/desktop-requests.ts';
import type { Session } from '../src/integrations/openai/oauth.ts';
import type { DesktopEvent } from '../src/shared/desktop-contracts.ts';

test('desktop IPC accepts only known shapes and bounds message size', () => {
  assert.deepEqual(validateDesktopRequest({ action: 'send', text: ' hello ' }), { action: 'send', text: 'hello' });
  for (const value of [null, [], { action: 'exec', command: 'anything' }, { action: 'snapshot', path: '../private' },
    { action: 'send', text: '' }, { action: 'send', text: 'x'.repeat(16001) },
    { action: 'selectConversation', id: '../secrets' }, { action: 'settings', settings: { model: 'x', planOnlyConfirmed: true, startAtLogin: false, apiKey: 'anything' } }]) {
    assert.throws(() => validateDesktopRequest(value), { code: 'INVALID_REQUEST' });
  }
});

test('SQLite history persists, interrupts unfinished output on restart and cascades clear', async () => {
  const fixtureRoot = resolve('.jarvis/test-fixtures'); await mkdir(fixtureRoot, { recursive: true });
  const directory = await mkdtemp(resolve(fixtureRoot, 'desktop-store-'));
  let store: DesktopStore | undefined;
  try {
    store = new DesktopStore(resolve(directory, 'history.sqlite'));
    const conversation = store.createConversation();
    const payload = "'); DROP TABLE conversations; --";
    store.append(conversation.id, 'user', payload, 'complete');
    store.append(conversation.id, 'assistant', 'Partial response', 'streaming');
    store.saveSettings({ model: 'test-model', planOnlyConfirmed: true, startAtLogin: false });
    store.close(); store = new DesktopStore(resolve(directory, 'history.sqlite'));
    assert.equal(store.messages(conversation.id)[0].content, payload);
    assert.equal(store.messages(conversation.id)[1].status, 'interrupted');
    assert.equal(store.settings().model, 'test-model');
    store.clearHistory(); assert.deepEqual(store.conversations(), []); assert.deepEqual(store.messages(conversation.id), []);
  } finally {
    store?.close();
    assert.equal(dirname(resolve(directory)), fixtureRoot); assert.match(basename(directory), /^desktop-store-/);
    await rm(directory, { recursive: true, force: true });
  }
});

class MemoryVault extends WindowsVault {
  session: Session = { clientId: 'test-client', identity: { subject: 'test-subject' }, accessToken: 'never-expose-this-token',
    idToken: 'never-expose-this-id', scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'], expiresAt: Date.now() + 60000 };
  constructor() { super('unused'); }
  override async withLock<T>(action: () => Promise<T>) { return action(); }
  override async load<T>() { return this.session as T; }
}
function fixture() {
  const store = new DesktopStore(':memory:'); const vault = new MemoryVault(); const events: DesktopEvent[] = []; const toasts: string[] = [];
  const service = new DesktopService(store, vault, false, event => events.push(event), async () => {}, message => toasts.push(message));
  return { store, vault, service, events, toasts };
}

test('chat defaults to direct Responses, streams safely and persists final output without exposing credentials', async context => {
  const { store, vault, service, events } = fixture();
  const calls: { url: string; body: any }[] = [];
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response('data: {"type":"response.output_text.delta","delta":"Hello"}\n\n'
      + 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
  });
  try {
    await service.initialize(); service.saveSettings({ model: 'test-model', planOnlyConfirmed: true, startAtLogin: false });
    await service.send('Hello JARVIS');
    assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
    assert.equal(calls[0].body.store, false); assert.equal(calls[0].body.stream, true); assert.equal(calls[0].body.tools, undefined);
    assert.equal(service.snapshot().messages.at(-1)?.content, 'Hello');
    assert.equal(service.snapshot().messages.at(-1)?.status, 'complete');
    assert.ok(events.some(event => event.type === 'delta'));
    assert.ok(!JSON.stringify(events).includes(vault.session.accessToken));
    assert.ok(!JSON.stringify(events).includes(vault.session.idToken));
  } finally { store.close(); }
});

test('unconfirmed costs block all network activity and repeated errors produce one notification', async context => {
  const { store, service, toasts } = fixture();
  const mocked = context.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not call'); });
  try {
    for (let i = 0; i < 2; i++) {
      try { await service.send('Question'); assert.fail('Expected cost rejection'); }
      catch (error) { assert.equal((error as any).code, 'COST_UNVERIFIED'); service.report(error); }
    }
    assert.equal(mocked.mock.callCount(), 0); assert.equal(toasts.length, 1);
    assert.equal(store.conversations().length, 0);
  } finally { store.close(); }
});

test('Windows lock hides all conversation data and rejects new protected tasks', async () => {
  const { store, service } = fixture();
  try {
    service.newConversation(); const id = service.snapshot().activeConversationId!;
    store.append(id, 'user', 'Private conversation', 'complete'); service.setLocked(true);
    assert.deepEqual(service.snapshot().messages, []); assert.deepEqual(service.snapshot().conversations, []);
    assert.throws(() => service.newConversation(), { code: 'LOCKED' });
    service.setLocked(false); assert.equal(service.snapshot().messages[0].content, 'Private conversation');
  } finally { store.close(); }
});
