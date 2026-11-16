import { Component, DestroyRef, ElementRef, ViewChild, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { DesktopApi, DesktopEvent, DesktopRequest, DesktopSettings, DesktopSnapshot } from '../../../../src/shared/desktop-contracts.ts';

declare global { interface Window { jarvis: DesktopApi } }

@Component({ selector: 'jarvis-app', standalone: true, imports: [FormsModule], templateUrl: './app.component.html' })
export class AppComponent {
  state = signal<DesktopSnapshot | null>(null);
  tab = signal<'chat' | 'projects' | 'activity' | 'settings'>('chat');
  error = signal('');
  composer = '';
  draft: DesktopSettings = { model: 'gpt-6.1-sol', planOnlyConfirmed: false, startAtLogin: false };
  @ViewChild('messages') messagesElement?: ElementRef<HTMLElement>;
  constructor() {
    const unsubscribe = window.jarvis.subscribe(event => this.receive(event));
    inject(DestroyRef).onDestroy(unsubscribe);
    void this.act({ action: 'snapshot' });
  }
  private receive(event: DesktopEvent) {
    if (event.type === 'snapshot') this.state.set(event.value);
    else this.state.update(state => state ? { ...state, messages: state.messages.map(message =>
      message.id === event.id ? { ...message, content: message.content + event.text } : message) } : state);
    if (this.tab() === 'chat') requestAnimationFrame(() => {
      const element = this.messagesElement?.nativeElement;
      if (element) element.scrollTop = element.scrollHeight;
    });
  }
  setTab(tab: 'chat' | 'projects' | 'activity' | 'settings') {
    if (tab === 'settings' && this.state()) this.draft = { ...this.state()!.settings };
    this.tab.set(tab); this.error.set('');
  }
  async act(request: DesktopRequest) {
    try {
      const reply = await window.jarvis.request(request);
      this.error.set(reply.ok ? '' : reply.message);
    } catch { this.error.set('The desktop connection closed. Reopen JARVIS from the tray.'); }
  }
  async send() {
    if (!this.composer.trim() || this.state()?.busy) return;
    const text = this.composer; this.composer = '';
    await this.act({ action: 'send', text });
  }
  clearHistory() {
    void this.act({ action: 'clearHistory' });
  }
}
