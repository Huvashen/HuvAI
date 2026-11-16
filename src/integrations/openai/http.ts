import { JarvisError } from '../../shared/errors.ts';
import { providerFailure } from '../../security/cost-guard.ts';

export const AUTH_ORIGIN = 'https://auth.openai.com';
export const API_ORIGIN = 'https://api.openai.com';
export const RESOURCE = `${API_ORIGIN}/v1`;

export function trustedAuthUrl(value: string): string {
  const url = new URL(value);
  if (url.origin !== AUTH_ORIGIN || url.username || url.password || url.hash) {
    throw new JarvisError('INVALID_DISCOVERY', 'Authentication metadata contains an untrusted endpoint.');
  }
  return url.href;
}

export async function request(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(init.signal ? [init.signal] : [])]),
  }).catch(() => { throw new JarvisError('OFFLINE', 'Cannot connect to the required OpenAI endpoint.'); });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw providerFailure(response.status, body?.error?.code);
  }
  return response;
}

export interface Discovery {
  issuer: string;
  jwks_uri: string;
  revocation_endpoint?: string;
}

export async function discover(): Promise<Discovery> {
  const result = await (await request(`${AUTH_ORIGIN}/.well-known/openid-configuration`)).json();
  if (result.issuer !== AUTH_ORIGIN || typeof result.jwks_uri !== 'string') {
    throw new JarvisError('INVALID_DISCOVERY', 'Unexpected OpenID issuer or key endpoint.');
  }
  trustedAuthUrl(result.jwks_uri);
  return result;
}
