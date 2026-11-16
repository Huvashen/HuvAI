export interface ChatMessage {
  id: string; conversationId: string; role: 'user' | 'assistant'; content: string;
  status: 'complete' | 'streaming' | 'interrupted' | 'error'; createdAt: string;
}
export interface Conversation { id: string; title: string; createdAt: string }
export interface DesktopSettings { model: string; planOnlyConfirmed: boolean; startAtLogin: boolean }
export interface Activity { id: number; code: string; message: string; createdAt: string }
export interface DesktopSnapshot {
  settings: DesktopSettings; conversations: Conversation[]; messages: ChatMessage[];
  activity: Activity[]; activeConversationId: string | null; signedIn: boolean;
  planGranted: boolean; busy: boolean; locked: boolean; packaged: boolean;
}
export type DesktopRequest =
  | { action: 'snapshot' | 'login' | 'cancel' | 'newConversation' | 'openUsage' | 'clearHistory' }
  | { action: 'send'; text: string }
  | { action: 'selectConversation'; id: string }
  | { action: 'settings'; settings: DesktopSettings };
export type DesktopEvent = { type: 'snapshot'; value: DesktopSnapshot }
  | { type: 'delta'; id: string; text: string };
export type DesktopReply = { ok: true } | { ok: false; message: string };
export interface DesktopApi {
  request(value: DesktopRequest): Promise<DesktopReply>;
  subscribe(listener: (event: DesktopEvent) => void): () => void;
}
