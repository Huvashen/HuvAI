import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consumeResponse, sseData, proveInference } from '../src/integrations/openai/responses.ts';
import type { Session } from '../src/integrations/openai/oauth.ts';

function stream(text: string, size = 1) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
    controller.close();
  } });
}
const event = (type: string, fields = {}) => `data: ${JSON.stringify({ type, ...fields })}\r\n\r\n`;

test('SSE handles split CRLF, UTF-8, comments and multiline data', async () => {
  const items = [];
  for await (const item of sseData(stream(': ping\r\n\r\ndata: héllo\r\ndata: world\r\n\r\n'))) items.push(item);
  assert.deepEqual(items, ['héllo\nworld']);
});

test('successful text is accepted only after completed event', async () => {
  let text = '';
  await consumeResponse(stream(event('response.output_text.delta', { delta: 'héllo' })
    + event('response.completed', { response: { status: 'completed' } })), delta => text += delta);
  assert.equal(text, 'héllo');
});

test('partial text, incomplete response, malformed events and empty completion fail', async () => {
  for (const input of [event('response.output_text.delta', { delta: 'partial' }),
    event('response.incomplete'), 'data: invalid\n\n', event('response.completed'),
    event('response.output_text.delta', { delta: 'x' }) + event('response.completed', { response: { status: 'failed' } })]) {
    await assert.rejects(consumeResponse(stream(input), () => {}));
  }
});

test('quota errors after a streamed delta do not pass feasibility', async () => {
  const input = event('response.output_text.delta', { delta: 'partial' })
    + event('response.failed', { response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } });
  await assert.rejects(consumeResponse(stream(input), () => {}), { code: 'USAGE_LIMIT' });
});

test('unverified costs or expired tokens stop before any network request', async () => {
  const session = { scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'], expiresAt: Date.now() + 10000 } as Session;
  await assert.rejects(proveInference(session, false, () => {}), { code: 'COST_UNVERIFIED' });
  await assert.rejects(proveInference({ ...session, expiresAt: 0 }, true, () => {}), { code: 'AUTH_REQUIRED' });
});
