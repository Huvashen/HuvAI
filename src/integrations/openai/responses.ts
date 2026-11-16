import { requirePlanOnly, providerFailure } from '../../security/cost-guard.ts';
import { JarvisError } from '../../shared/errors.ts';
import { RESOURCE, request } from './http.ts';
import type { Session } from './oauth.ts';

export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      // Normalize only complete lines so CRLF split over chunks is safe.
      let newline: number;
      while ((newline = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const match = buffer.slice(newline).match(/^\r?\n\r?\n/)![0];
        const frame = buffer.slice(0, newline);
        buffer = buffer.slice(newline + match.length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (data) yield data;
      }
      if (buffer.length > 2_000_000) throw new JarvisError('INVALID_STREAM', 'Provider event exceeded the size limit.');
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function consumeResponse(body: ReadableStream<Uint8Array>, delta: (text: string) => void) {
  let completed = false;
  let textReceived = false;
  for await (const data of sseData(body)) {
    if (data === '[DONE]') break;
    let event;
    try { event = JSON.parse(data); }
    catch { throw new JarvisError('INVALID_STREAM', 'Provider returned an invalid stream event.'); }
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      if (event.delta.length) textReceived = true;
      delta(event.delta);
    }
    if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) {
      const code = event.response?.error?.code ?? event.error?.code ?? event.code;
      throw providerFailure(event.type === 'response.incomplete' ? 502 : 400, code);
    }
    if (event.type === 'response.completed') {
      if (event.response?.status && event.response.status !== 'completed') {
        throw new JarvisError('INCOMPLETE_RESPONSE', 'The provider did not finish the response.');
      }
      completed = true;
    }
  }
  if (!completed || !textReceived) throw new JarvisError('INCOMPLETE_RESPONSE', 'No completed text response was received.');
}

export async function proveInference(session: Session, creditsDisabledConfirmed: boolean,
  delta: (text: string) => void, signal?: AbortSignal): Promise<string> {
  requirePlanOnly(session.scopes, creditsDisabledConfirmed);
  if (session.expiresAt <= Date.now()) throw new JarvisError('AUTH_REQUIRED', 'Session expired. Sign in again.');
  // This Phase 0 probe deliberately requires a fresh sign-in rather than implementing refresh before the gate.
  const headers = { Authorization: `Bearer ${session.accessToken}` };
  const catalog = await (await request(`${RESOURCE}/models`, { headers, signal })).json();
  const model = catalog.models?.find((item: { visibility: string; slug: string }) =>
    item.visibility === 'list' && typeof item.slug === 'string')?.slug;
  if (!model) throw new JarvisError('NO_MODELS', 'No visible model was returned for this account.');
  const response = await request(`${RESOURCE}/responses`, { method: 'POST',
    signal: AbortSignal.any([AbortSignal.timeout(90_000), ...(signal ? [signal] : [])]),
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: [{ role: 'user', content: 'Say exactly: JARVIS feasibility check passed.' }],
      store: false, stream: true }),
  }, 90_000);
  if (!response.body) throw new JarvisError('INVALID_STREAM', 'The response has no event stream.');
  await consumeResponse(response.body, delta);
  return model;
}
