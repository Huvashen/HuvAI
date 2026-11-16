import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { JarvisError } from '../../shared/errors.ts';
import { AUTH_ORIGIN } from './http.ts';

export interface OpenAIJwk extends JsonWebKey { kid?: string; use?: string; alg?: string }

export interface Identity { subject: string; email?: string }

export function validateIdentity(token: string, keys: OpenAIJwk[], clientId: string,
  nonce: string, previousSubject?: string, now = Date.now() / 1000): Identity {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error();
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const key = keys.find(item => item.kid === header.kid && item.kty === 'RSA'
      && (!item.use || item.use === 'sig') && (!item.alg || item.alg === 'RS256'));
    if (header.alg !== 'RS256' || !key || !verify('RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: 'jwk' }),
      Buffer.from(parts[2], 'base64url'))) throw new Error();
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== AUTH_ORIGIN || !audience.includes(clientId)
      || (audience.length > 1 && claims.azp !== clientId)
      || (claims.azp !== undefined && claims.azp !== clientId)
      || typeof claims.exp !== 'number' || claims.exp <= now
      || (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > now))
      || claims.nonce !== nonce || typeof claims.sub !== 'string' || !claims.sub
      || (previousSubject !== undefined && previousSubject !== claims.sub)) throw new Error();
    return { subject: claims.sub, email: typeof claims.email === 'string' ? claims.email : undefined };
  } catch {
    throw new JarvisError('INVALID_IDENTITY', 'ID token signature, identity, audience, expiry, or nonce was rejected.');
  }
}
