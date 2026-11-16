import { DesktopStore } from '../../../../src/storage/desktop-store.ts';
import { WindowsVault } from '../../../../src/storage/windows-vault.ts';
import { signIn, type Session, type Registration } from '../../../../src/integrations/openai/oauth.ts';
import { streamChat } from '../../../../src/integrations/openai/responses.ts';
import { PLAN_SCOPES, requirePlanOnly } from '../../../../src/security/cost-guard.ts';
import { JarvisError, safeFailure } from '../../../../src/shared/errors.ts';
import type { DesktopEvent, DesktopSnapshot, DesktopSettings } from '../../../../src/shared/desktop-contracts.ts';

export class DesktopService {
  private activeId: string | null;
  private controller?: AbortController;
  private pending?: Promise<void>;
  private signedIn = false;
  private planGranted = false;
  private locked = false;
  private errors = new Set<string>();
  readonly store: DesktopStore;
  private vault: WindowsVault;
  private packaged: boolean;
  private emit: (event: DesktopEvent) => void;
  private openBrowser: (url: string) => Promise<void>;
  private toast: (message: string) => void;
  constructor(store: DesktopStore, vault: WindowsVault,
    packaged: boolean, emit: (event: DesktopEvent) => void,
    openBrowser: (url: string) => Promise<void>, toast: (message: string) => void) {
    this.store = store; this.vault = vault;
    this.packaged = packaged; this.emit = emit; this.openBrowser = openBrowser; this.toast = toast;
    this.activeId = store.conversations()[0]?.id ?? null;
  }
  async initialize() { this.updateIdentity(await this.vault.withLock(() => this.vault.load<Session>())); }
  private updateIdentity(session?: Session) {
    this.signedIn = !!session?.accessToken;
    this.planGranted = this.signedIn && PLAN_SCOPES.every(scope => session?.scopes?.includes(scope));
  }
  snapshot(): DesktopSnapshot {
    return { settings: this.store.settings(), conversations: this.locked ? [] : this.store.conversations(),
      messages: this.locked || !this.activeId ? [] : this.store.messages(this.activeId),
      activity: this.locked ? [] : this.store.activity(), activeConversationId: this.locked ? null : this.activeId,
      signedIn: this.signedIn, planGranted: this.planGranted, busy: !!this.pending, locked: this.locked, packaged: this.packaged };
  }
  publish() { this.emit({ type: 'snapshot', value: this.snapshot() }); }
  setLocked(locked: boolean) { this.locked = locked; if (locked) this.cancel(); this.publish(); }
  private idle() {
    if (this.locked) throw new JarvisError('LOCKED', 'Unlock Windows to continue.');
    if (this.pending) throw new JarvisError('BUSY', 'Finish or cancel the current task first.');
  }
  private operation(action: (signal: AbortSignal) => Promise<void>) {
    this.idle();
    const controller = new AbortController(); this.controller = controller;
    const task = Promise.resolve().then(() => action(controller.signal)).finally(() => {
      this.pending = undefined; this.controller = undefined; this.publish();
    });
    this.pending = task; this.publish(); return task;
  }
  cancel() { this.controller?.abort(); }
  async shutdown() { this.cancel(); await this.pending?.catch(() => {}); }
  report(error: unknown) {
    const message = safeFailure(error);
    const code = error instanceof JarvisError ? error.code : 'UNEXPECTED_FAILURE';
    if (code !== 'CANCELLED' && !this.errors.has(code)) {
      this.errors.add(code); this.store.audit(code, message); this.toast(message);
    }
    this.publish(); return message;
  }
  newConversation() { this.idle(); this.activeId = this.store.createConversation().id; this.publish(); }
  selectConversation(id: string) {
    this.idle();
    if (!this.store.conversations().some(item => item.id === id)) throw new JarvisError('NOT_FOUND', 'Conversation not found.');
    this.activeId = id; this.publish();
  }
  clearHistory() { this.idle(); this.store.clearHistory(); this.activeId = null; this.publish(); }
  saveSettings(settings: DesktopSettings) { this.idle(); this.store.saveSettings(settings); this.publish(); }
  login() {
    return this.operation(signal => this.vault.withLock(async () => {
      const previous = await this.vault.load<Registration>();
      const session = await signIn(await this.vault.hostId(), this.openBrowser, previous, signal);
      await this.vault.save(session); this.updateIdentity(session); this.errors.clear();
      this.store.audit('SIGNED_IN', 'ChatGPT sign-in completed.');
    }));
  }
  send(text: string) {
    return this.operation(async signal => {
      const settings = this.store.settings();
      const session = await this.vault.withLock(() => this.vault.load<Session>());
      if (!session?.accessToken) throw new JarvisError('AUTH_REQUIRED', 'Continue with ChatGPT in Settings first.');
      requirePlanOnly(session.scopes, settings.planOnlyConfirmed);
      if (!this.activeId) this.activeId = this.store.createConversation().id;
      const id = this.activeId;
      this.store.append(id, 'user', text, 'complete');
      const context = this.store.messages(id).filter(message => message.status === 'complete').slice(-20)
        .map(({ role, content }) => ({ role, content }));
      while (context.length > 1 && context.reduce((sum, item) => sum + item.content.length, 0) > 60000) context.shift();
      const reply = this.store.append(id, 'assistant', '', 'streaming');
      let output = ''; this.publish();
      try {
        await streamChat(session, settings.model, context, settings.planOnlyConfirmed, delta => {
          output += delta;
          if (!this.locked && !signal.aborted) this.emit({ type: 'delta', id: reply.id, text: delta });
        }, signal);
        this.store.finish(reply.id, output, 'complete'); this.errors.clear();
      } catch (error) {
        this.store.finish(reply.id, output, signal.aborted ? 'interrupted' : 'error');
        if (signal.aborted) throw new JarvisError('CANCELLED', 'Response cancelled.');
        throw error;
      }
    });
  }
}
