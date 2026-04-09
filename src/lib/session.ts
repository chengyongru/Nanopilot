import type { Session, Message } from './types';

export class SessionManager {
  private sessions: Record<string, Session> = {};
  private activeId: string | null = null;
  private _persistTimer: ReturnType<typeof setTimeout> | null = null;
  private _persistPending = false;

  async load(): Promise<void> {
    const data = await chrome.storage.local.get(['nb_sessions', 'nb_active_session']);
    this.sessions = (data.nb_sessions as Record<string, Session>) || {};
    this.activeId = (data.nb_active_session as string) || null;
  }

  /** Debounced persist — only writes once per 500ms during rapid calls. */
  _persist(): void {
    if (this._persistPending) return;
    this._persistPending = true;
    this._persistTimer = setTimeout(() => {
      this._persistPending = false;
      this._persistTimer = null;
      chrome.storage.local.set({
        nb_sessions: this.sessions,
        nb_active_session: this.activeId,
      }).catch((err: unknown) => {
        console.error('[session] persist failed:', err);
      });
    }, 500);
  }

  /** Flush any debounced persist immediately. */
  async _flushPersist(): Promise<void> {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
      this._persistPending = false;
    }
    try {
      await chrome.storage.local.set({
        nb_sessions: this.sessions,
        nb_active_session: this.activeId,
      });
    } catch (err: unknown) {
      console.error('[session] persist failed:', err);
    }
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
    if (!text) return;
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
      this._flushPersist();
    }
  }

  delete(id: string): void {
    delete this.sessions[id];
    if (this.activeId === id) {
      const remaining = Object.values(this.sessions).sort((a, b) => b.updatedAt - a.updatedAt);
      this.activeId = remaining.length > 0 ? remaining[0].id : null;
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
