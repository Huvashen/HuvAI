import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proveInference } from '../src/integrations/openai/responses.ts';
import { discover } from '../src/integrations/openai/http.ts';
import type { Session } from '../src/integrations/openai/oauth.ts';

function session(): Session {
  return { clientId: 'test-client', identity: { subject: 'test-subject' }, accessToken: 'fake-oauth-token',
    idToken: 'fake-id-token', scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'], expiresAt: Date.now() + 60000 };
}
const complete = 'data: {"type":"response.output_text.delta","delta":"ready"}\n\n'
  + 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';

test('probe uses its OAuth token and only the permitted request shape', async (context) => {
  const calls: { url: string; init: RequestInit }[] = [];
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return url.endsWith('/models')
      ? Response.json({ models: [{ visibility: 'list', slug: 'test-model' }] })
      : new Response(complete, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  let output = '';
  assert.equal(await proveInference(session(), true, delta => output += delta), 'test-model');
  assert.equal(output, 'ready');
  assert.deepEqual(calls.map(call => call.url), ['https://api.openai.com/v1/models', 'https://api.openai.com/v1/responses']);
  assert.equal((calls[1].init.headers as Record<string, string>).Authorization, 'Bearer fake-oauth-token');
  assert.equal(calls[1].init.redirect, 'error');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { model: 'test-model',
    input: [{ role: 'user', content: 'Say exactly: JARVIS feasibility check passed.' }], store: false, stream: true });
});

test('unconfirmed spending and missing scopes cause zero network requests', async (context) => {
  const mocked = context.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not reach network'); });
  await assert.rejects(proveInference(session(), false, () => {}), { code: 'COST_UNVERIFIED' });
  await assert.rejects(proveInference({ ...session(), scopes: [] }, true, () => {}), { code: 'PLAN_PERMISSION_MISSING' });
  assert.equal(mocked.mock.callCount(), 0);
});

test('an empty model catalog prevents inference', async (context) => {
  const mocked = context.mock.method(globalThis, 'fetch', async () => Response.json({ models: [] }));
  await assert.rejects(proveInference(session(), true, () => {}), { code: 'NO_MODELS' });
  assert.equal(mocked.mock.callCount(), 1);
});

test('payment-required response stops without retry or fallback', async (context) => {
  const mocked = context.mock.method(globalThis, 'fetch', async (url: string) => url.endsWith('/models')
    ? Response.json({ models: [{ visibility: 'list', slug: 'test-model' }] })
    : Response.json({ error: { code: 'payment_required' } }, { status: 402 }));
  await assert.rejects(proveInference(session(), true, () => {}), { code: 'PAYMENT_REQUIRED' });
  assert.equal(mocked.mock.callCount(), 2);
});

test('discovery rejects foreign issuers and key hosts before requesting keys', async (context) => {
  const mocked = context.mock.method(globalThis, 'fetch', async () => Response.json({
    issuer: 'https://attacker.invalid', jwks_uri: 'https://attacker.invalid/keys',
  }));
  await assert.rejects(discover(), { code: 'INVALID_DISCOVERY' });
  assert.equal(mocked.mock.callCount(), 1);
});
