import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createAttempt, authorizationUrl, validateCallback } from '../src/integrations/openai/oauth.ts';
import { validateIdentity } from '../src/integrations/openai/identity.ts';
import { trustedAuthUrl } from '../src/integrations/openai/http.ts';
import { requirePlanOnly, providerFailure } from '../src/security/cost-guard.ts';
import { safeFailure } from '../src/shared/errors.ts';

test('fresh attempts use independent state, nonce and PKCE values', () => {
  const a = createAttempt(); const b = createAttempt();
  for (const key of ['state', 'nonce', 'verifier'] as const) assert.notEqual(a[key], b[key]);
  const url = new URL(authorizationUrl('urn:uuid:host', 'http://127.0.0.1:1234/auth/callback', a));
  assert.equal(url.origin, 'https://auth.openai.com');
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(a.verifier).digest('base64url'));
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('agent_name_hint'), 'JARVIS');
  assert.ok(!url.href.includes(a.verifier));
});

test('returning registration reuses client ID and omits agent name', () => {
  const url = new URL(authorizationUrl('host', 'http://127.0.0.1:12/auth/callback', createAttempt(),
    { clientId: 'issued', identity: { subject: 's' } }));
  assert.equal(url.searchParams.get('client_id'), 'issued');
  assert.equal(url.searchParams.has('agent_name_hint'), false);
});

test('callbacks reject wrong state, denied consent, duplicates, missing and changed clients', () => {
  const attempt = createAttempt();
  const base = `http://127.0.0.1/auth/callback?state=${attempt.state}`;
  const callback = (query: string) => validateCallback(new URL(base + query), attempt);
  assert.throws(() => validateCallback(new URL(base.replace(attempt.state, 'wrong')), attempt), /match/);
  assert.throws(() => callback('&error=access_denied'), /declined/);
  assert.throws(() => callback('&code=c&client_id=dynamic_agent_client'), /registration/);
  assert.throws(() => callback('&code=c'), /registration/);
  assert.throws(() => callback('&code=c&code=d&client_id=issued'), /Duplicate/);
  const previous = { clientId: 'issued', identity: { subject: 's' } };
  assert.throws(() => validateCallback(new URL(base + '&code=c&client_id=other'), attempt, previous));
  assert.deepEqual(validateCallback(new URL(base + '&code=c'), attempt, previous), { code: 'c', clientId: 'issued' });
  assert.deepEqual(callback('&code=c&client_id=issued'), { code: 'c', clientId: 'issued' });
});

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key' };
const baseClaims = { iss: 'https://auth.openai.com', sub: 'subject', aud: 'issued', exp: 2000, nonce: 'nonce' };
function jwt(changes = {}, headerChanges = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key', ...headerChanges })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ ...baseClaims, ...changes })).toString('base64url');
  return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
}

test('identity signature and verified account binding are enforced', () => {
  assert.equal(validateIdentity(jwt(), [key], 'issued', 'nonce', 'subject', 1000).subject, 'subject');
  for (const changes of [{ iss: 'https://attacker.test' }, { aud: 'other' }, { exp: 999 },
    { nonce: 'wrong' }, { sub: '' }, { nbf: 1001 }, { aud: ['issued', 'other'] }, { azp: 'other' }]) {
    assert.throws(() => validateIdentity(jwt(changes), [key], 'issued', 'nonce', undefined, 1000));
  }
  assert.throws(() => validateIdentity(jwt(), [key], 'issued', 'nonce', 'different', 1000));
  assert.throws(() => validateIdentity(jwt({}, { alg: 'none' }), [key], 'issued', 'nonce', undefined, 1000));
  assert.throws(() => validateIdentity(jwt(), [], 'issued', 'nonce', undefined, 1000));
  const forged = jwt().split('.'); forged[1] = Buffer.from('{}').toString('base64url');
  assert.throws(() => validateIdentity(forged.join('.'), [key], 'issued', 'nonce', undefined, 1000));
});

test('untrusted discovery endpoints are rejected', () => {
  for (const url of ['http://auth.openai.com/keys', 'https://attacker.test/keys',
    'https://user:password@auth.openai.com/keys', 'https://auth.openai.com/keys#fragment']) {
    assert.throws(() => trustedAuthUrl(url));
  }
  assert.equal(trustedAuthUrl('https://auth.openai.com/keys'), 'https://auth.openai.com/keys');
});

test('cost policy requires both plan scopes and explicit credit-disable confirmation', () => {
  const scopes = ['resource.invoke', 'chatgpt.tokens.use.direct'];
  assert.throws(() => requirePlanOnly([], true), /grant/);
  assert.throws(() => requirePlanOnly(scopes.slice(1), true), /grant/);
  assert.throws(() => requirePlanOnly(scopes, false), /credit/);
  assert.doesNotThrow(() => requirePlanOnly(scopes, true));
});

test('provider failures distinguish quota, payment, eligibility and unknown errors', () => {
  assert.equal(providerFailure(429).code, 'USAGE_LIMIT');
  assert.equal(providerFailure(402).code, 'PAYMENT_REQUIRED');
  assert.equal(providerFailure(403, 'subscription_sharing_user_not_eligible').code, 'NOT_ELIGIBLE');
  assert.equal(providerFailure(503, 'subscription_sharing_usage_unavailable').code, 'USAGE_UNAVAILABLE');
  assert.equal(providerFailure(401).code, 'AUTH_REQUIRED');
  assert.ok(!safeFailure(new Error('secret-token')).includes('secret-token'));
});
