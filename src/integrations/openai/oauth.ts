import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { JarvisError } from '../../shared/errors.ts';
import { AUTH_ORIGIN, RESOURCE, discover, request } from './http.ts';
import { validateIdentity, type Identity } from './identity.ts';

const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export interface Registration { clientId: string; identity: Identity }
export interface Session extends Registration {
  accessToken: string;
  refreshToken?: string;
  idToken: string;
  scopes: string[];
  expiresAt: number;
}
export interface Attempt { state: string; nonce: string; verifier: string }

export function createAttempt(): Attempt {
  return { state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'),
    verifier: randomBytes(48).toString('base64url') };
}

export function authorizationUrl(hostId: string, redirectUri: string, attempt: Attempt,
  previous?: Registration): string {
  const url = new URL(`${AUTH_ORIGIN}/api/accounts/authorize`);
  url.search = new URLSearchParams({ client_id: previous?.clientId ?? 'dynamic_agent_client',
    ext_agent_host_id: hostId, response_type: 'code', redirect_uri: redirectUri,
    scope: SCOPES, resource: RESOURCE, state: attempt.state, nonce: attempt.nonce,
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
    ...(!previous ? { agent_name_hint: 'JARVIS' } : {}) }).toString();
  return url.href;
}

export function validateCallback(url: URL, attempt: Attempt, previous?: Registration) {
  for (const key of ['state', 'code', 'client_id', 'error']) {
    if (url.searchParams.getAll(key).length > 1) throw new JarvisError('INVALID_CALLBACK', 'Duplicate OAuth callback parameter.');
  }
  const state = Buffer.from(url.searchParams.get('state') ?? '');
  const expected = Buffer.from(attempt.state);
  if (state.length !== expected.length || !timingSafeEqual(state, expected)) {
    throw new JarvisError('INVALID_STATE', 'OAuth callback did not match the pending sign-in.');
  }
  if (url.searchParams.has('error')) throw new JarvisError('CONSENT_DECLINED', 'Sign-in or consent was declined.');
  const clientId = url.searchParams.get('client_id') ?? previous?.clientId;
  const code = url.searchParams.get('code');
  if (!code || !clientId || clientId === 'dynamic_agent_client' ||
    (previous && previous.clientId !== clientId)) {
    throw new JarvisError('INVALID_CALLBACK', 'Missing code or mismatched issued client registration.');
  }
  return { code, clientId };
}

export async function signIn(hostId: string, openBrowser: (url: string) => Promise<void>,
  previous?: Registration, signal?: AbortSignal): Promise<Session> {
  // Reachability and trusted discovery are verified before creating a loopback listener.
  const discovery = await discover();
  const attempt = createAttempt();
  let redirectUri = '';
  let pending = false;
  let resolveCallback!: (value: { code: string; clientId: string }) => void;
  let rejectCallback!: (reason: unknown) => void;
  const callback = new Promise<{ code: string; clientId: string }>((resolve, reject) => {
    resolveCallback = resolve; rejectCallback = reject;
  });
  // Avoid an unhandled rejection if browser launch fails before we await callback.
  void callback.catch(() => {});
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url?.split('?')[0] !== '/auth/callback') {
      res.writeHead(404).end(); return;
    }
    if (pending) { res.writeHead(409).end(); return; }
    try {
      const result = validateCallback(new URL(req.url, redirectUri), attempt, previous);
      pending = true;
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'" }).end('Sign-in received. Return to JARVIS for verification.');
      resolveCallback(result);
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('Sign-in callback rejected.');
      // Ignore unrelated requests with invalid state; a valid denial ends this attempt.
      if (error instanceof JarvisError && error.code === 'CONSENT_DECLINED') rejectCallback(error);
    }
  });
  const abort = () => rejectCallback(new JarvisError('CANCELLED', 'Sign-in cancelled.'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (signal?.aborted) throw new JarvisError('CANCELLED', 'Sign-in cancelled.');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error();
    redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    timer = setTimeout(() => rejectCallback(new JarvisError('SIGN_IN_TIMEOUT', 'Sign-in timed out. Run it again.')), 180_000);
    signal?.addEventListener('abort', abort, { once: true });
    await openBrowser(authorizationUrl(hostId, redirectUri, attempt, previous));
    const { code, clientId } = await callback;
    const token = await (await request(`${AUTH_ORIGIN}/api/accounts/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
        code, code_verifier: attempt.verifier, redirect_uri: redirectUri, resource: RESOURCE }),
    })).json();
    const jwks = await (await request(discovery.jwks_uri)).json();
    const identity = validateIdentity(token.id_token, jwks.keys, clientId, attempt.nonce, previous?.identity.subject);
    if (token.token_type?.toLowerCase() !== 'bearer' || typeof token.access_token !== 'string'
      || !token.access_token || typeof token.scope !== 'string'
      || typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0
      || (token.refresh_token !== undefined && typeof token.refresh_token !== 'string')) {
      throw new JarvisError('INVALID_TOKEN_RESPONSE', 'The provider returned an incomplete credential set.');
    }
    return { clientId, identity, accessToken: token.access_token, idToken: token.id_token,
      refreshToken: token.refresh_token, scopes: token.scope.split(/\s+/),
      expiresAt: Date.now() + token.expires_in * 1000 };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    server.closeAllConnections(); server.close();
  }
}
