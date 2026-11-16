import { JarvisError } from '../shared/errors.ts';

export const PLAN_SCOPES = ['resource.invoke', 'chatgpt.tokens.use.direct'] as const;

export function requirePlanOnly(scopes: string[], creditsDisabledConfirmed: boolean): void {
  if (!PLAN_SCOPES.every(scope => scopes.includes(scope))) {
    throw new JarvisError('PLAN_PERMISSION_MISSING', 'Sign in and grant ChatGPT plan usage before inference.');
  }
  if (!creditsDisabledConfirmed) {
    throw new JarvisError('COST_UNVERIFIED',
      'Disable credit spending for JARVIS in ChatGPT usage settings before confirming plan-only inference.');
  }
}

export function providerFailure(status: number, code?: string): JarvisError {
  if (code === 'subscription_sharing_usage_limit_exceeded' || status === 429) {
    return new JarvisError('USAGE_LIMIT', 'Plan or application usage limit reached. Check ChatGPT usage settings.');
  }
  if (code === 'subscription_sharing_user_not_eligible') {
    return new JarvisError('NOT_ELIGIBLE', 'This account or workspace cannot use the plan route.');
  }
  if (code === 'subscription_sharing_usage_unavailable') {
    return new JarvisError('USAGE_UNAVAILABLE', 'The provider cannot verify plan allowance. Try again later.');
  }
  if (status === 402) return new JarvisError('PAYMENT_REQUIRED', 'Paid usage is blocked.');
  if (status === 401) return new JarvisError('AUTH_REQUIRED', 'Sign-in permission was rejected or expired.');
  if (status === 403) return new JarvisError('PERMISSION_DENIED', 'The provider rejected this account, region, or scope.');
  return new JarvisError('PROVIDER_FAILURE', `Provider request failed (HTTP ${status}). No billing fallback is configured.`);
}
