import { JarvisError } from '../shared/errors.ts';
import type { DesktopRequest } from '../shared/desktop-contracts.ts';

export function validateDesktopRequest(value: unknown): DesktopRequest {
  const invalid = () => { throw new JarvisError('INVALID_REQUEST', 'The desktop request was rejected.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const input = value as Record<string, unknown>;
  const simple = ['snapshot', 'login', 'cancel', 'newConversation', 'openUsage', 'clearHistory'];
  if (typeof input.action === 'string' && simple.includes(input.action) && Object.keys(input).length === 1) return input as DesktopRequest;
  if (input.action === 'send' && Object.keys(input).length === 2 && typeof input.text === 'string'
    && input.text.trim().length > 0 && input.text.length <= 16000) return { action: 'send', text: input.text.trim() };
  if (input.action === 'selectConversation' && Object.keys(input).length === 2 && typeof input.id === 'string'
    && /^[a-f0-9-]{36}$/i.test(input.id)) return { action: 'selectConversation', id: input.id };
  if (input.action === 'settings' && Object.keys(input).length === 2 && input.settings && typeof input.settings === 'object') {
    const settings = input.settings as Record<string, unknown>;
    if (Object.keys(settings).length === 3 && typeof settings.model === 'string'
      && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,100}$/.test(settings.model)
      && typeof settings.planOnlyConfirmed === 'boolean' && typeof settings.startAtLogin === 'boolean') {
      return { action: 'settings', settings: { model: settings.model,
        planOnlyConfirmed: settings.planOnlyConfirmed, startAtLogin: settings.startAtLogin } };
    }
  }
  return invalid();
}
