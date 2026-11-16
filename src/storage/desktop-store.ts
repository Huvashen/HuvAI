import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Activity, ChatMessage, Conversation, DesktopSettings } from '../shared/desktop-contracts.ts';

export class DesktopStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY,title TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY,conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY,code TEXT NOT NULL,message TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS message_conversation ON messages(conversationId,createdAt);`);
    this.db.prepare("UPDATE messages SET status='interrupted' WHERE status='streaming'").run();
  }
  settings(): DesktopSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='desktop'").get() as { value: string } | undefined;
    return row ? JSON.parse(row.value) : { model: 'gpt-6.1-sol', planOnlyConfirmed: false, startAtLogin: false };
  }
  saveSettings(settings: DesktopSettings) {
    this.db.prepare("INSERT INTO settings(key,value) VALUES('desktop',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify(settings));
  }
  conversations(): Conversation[] {
    return this.db.prepare('SELECT * FROM conversations ORDER BY createdAt DESC,rowid DESC LIMIT 100').all() as unknown as Conversation[];
  }
  createConversation(title = 'New conversation'): Conversation {
    const conversation = { id: randomUUID(), title: title.slice(0, 70), createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO conversations VALUES(?,?,?)').run(conversation.id, conversation.title, conversation.createdAt);
    return conversation;
  }
  messages(id: string): ChatMessage[] {
    return this.db.prepare('SELECT * FROM messages WHERE conversationId=? ORDER BY createdAt,rowid').all(id) as unknown as ChatMessage[];
  }
  append(id: string, role: ChatMessage['role'], content: string, status: ChatMessage['status']): ChatMessage {
    const message: ChatMessage = { id: randomUUID(), conversationId: id, role, content, status, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(message.id, id, role, content, status, message.createdAt);
    if (role === 'user') this.db.prepare("UPDATE conversations SET title=? WHERE id=? AND title='New conversation'").run(content.slice(0, 70), id);
    return message;
  }
  finish(id: string, content: string, status: ChatMessage['status']) {
    this.db.prepare('UPDATE messages SET content=?,status=? WHERE id=?').run(content, status, id);
  }
  audit(code: string, message: string) {
    this.db.prepare('INSERT INTO activity(code,message,createdAt) VALUES(?,?,?)').run(code, message, new Date().toISOString());
  }
  activity(): Activity[] { return this.db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT 100').all() as unknown as Activity[]; }
  clearHistory() { this.db.exec('DELETE FROM conversations;'); }
  close() { this.db.close(); }
}
