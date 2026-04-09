/**
 * Multi-session manager backed by chrome.storage.local.
 */

class SessionManager {
  constructor() {
    /** @type {Object<string, Session>} */
    this.sessions = {};
    this.activeId = null;
  }

  async load() {
    const data = await chrome.storage.local.get(['nb_sessions', 'nb_active_session']);
    this.sessions = data.nb_sessions || {};
    this.activeId = data.nb_active_session || null;
  }

  _persist() {
    chrome.storage.local.set({
      nb_sessions: this.sessions,
      nb_active_session: this.activeId,
    });
  }

  create(title) {
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

  get(id) {
    return this.sessions[id] || null;
  }

  getActive() {
    return this.sessions[this.activeId] || null;
  }

  setActive(id) {
    if (this.sessions[id]) {
      this.activeId = id;
      this._persist();
    }
  }

  list() {
    return Object.values(this.sessions).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  addMessage(sessionId, role, content) {
    const s = this.sessions[sessionId];
    if (!s) return;
    s.messages.push({ role, content, timestamp: Date.now() });
    s.updatedAt = Date.now();
    this._persist();
  }

  /**
   * Replace content of the last assistant message (used during streaming).
   * If there is no assistant message yet, append one.
   */
  appendToLastAssistant(sessionId, text) {
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

  markLastAssistantDone(sessionId) {
    const s = this.sessions[sessionId];
    if (!s) return;
    const last = s.messages[s.messages.length - 1];
    if (last && last.role === 'assistant') {
      last.done = true;
      this._persist();
    }
  }

  delete(id) {
    delete this.sessions[id];
    if (this.activeId === id) {
      const keys = Object.keys(this.sessions);
      this.activeId = keys.length ? keys[keys.length - 1] : null;
    }
    this._persist();
  }

  rename(id, title) {
    const s = this.sessions[id];
    if (s) {
      s.title = title;
      s.updatedAt = Date.now();
      this._persist();
    }
  }
}
