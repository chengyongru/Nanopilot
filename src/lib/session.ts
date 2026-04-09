import type { Session, Message } from './types';

export class SessionManager {
  private sessions: Record<string, Session> = {};
  private activeId: string | null = null;

  async load(): Promise<void> {
    const data = await chrome.storage.local.get(['nb_sessions', 'nb_active_session']);
    this.sessions = (data.nb_sessions as Record<string, Session>) || {};
    this.activeId = (data.nb_active_session as string) || null;
  }

  private _persist(): void {
    chrome.storage.local.set({
      nb_sessions: this.sessions,
      nb_active_session: this.activeId,
    });
  }

  create(title?: string): string {
    const id = crypto.randomUUID();
    this.sessions[id] = {
      id,
      title: title || 'New Chat',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.activeId = id;
    this._persist();
    return id;
  }

  get(id: string): Session | null {
    return this.sessions[id] || null;
  }

  getActive(): Session | null {
    return this.sessions[this.activeId ?? ''] || null;
  }

  setActive(id: string): void {
    if (this.sessions[id]) {
      this.activeId = id;
      this._persist();
    }
  }

  list(): Session[] {
    return Object.values(this.sessions).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  addMessage(sessionId: string, role: Message['role'], content: string): void {
    const s = this.sessions[sessionId];
    if (!s) return;
    s.messages.push({ role, content, timestamp: Date.now() });
    s.updatedAt = Date.now();
    this._persist();
  }

  appendToLastAssistant(sessionId: string, text: string): void {
    const s = this.sessions[sessionId];
    if (!s) return;
    const last = s.messages[s.messages.length - 1];
    if (last && last.role === 'assistant' && !last.done) {
      last.content += text;
    } else {
      s.messages.push({ role: 'assistant', content: text, timestamp: Date.now(), done: false });
    }
    s.updatedAt = Date.now();
    this._persist();
  }

  markLastAssistantDone(sessionId: string): void {
    const s = this.sessions[sessionId];
    if (!s) return;
    const last = s.messages[s.messages.length - 1];
    if (last && last.role === 'assistant') {
      last.done = true;
      this._persist();
    }
  }

  delete(id: string): void {
    delete this.sessions[id];
    if (this.activeId === id) {
      const keys = Object.keys(this.sessions);
      this.activeId = keys.length ? keys[keys.length - 1] : null;
    }
    this._persist();
  }

  rename(id: string, title: string): void {
    const s = this.sessions[id];
    if (s) {
      s.title = title;
      s.updatedAt = Date.now();
      this._persist();
    }
  }
}
