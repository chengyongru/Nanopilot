(function() {
  "use strict";
  class SessionManager {
    sessions = {};
    activeId = null;
    async load() {
      const data = await chrome.storage.local.get(["nb_sessions", "nb_active_session"]);
      this.sessions = data.nb_sessions || {};
      this.activeId = data.nb_active_session || null;
    }
    _persist() {
      chrome.storage.local.set({
        nb_sessions: this.sessions,
        nb_active_session: this.activeId
      });
    }
    create(title) {
      const id = crypto.randomUUID();
      this.sessions[id] = {
        id,
        title: title || "New Chat",
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      this.activeId = id;
      this._persist();
      return id;
    }
    get(id) {
      return this.sessions[id] || null;
    }
    getActive() {
      return this.sessions[this.activeId ?? ""] || null;
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
    appendToLastAssistant(sessionId, text) {
      const s = this.sessions[sessionId];
      if (!s) return;
      const last = s.messages[s.messages.length - 1];
      if (last && last.role === "assistant" && !last.done) {
        last.content += text;
      } else {
        s.messages.push({ role: "assistant", content: text, timestamp: Date.now(), done: false });
      }
      s.updatedAt = Date.now();
      this._persist();
    }
    markLastAssistantDone(sessionId) {
      const s = this.sessions[sessionId];
      if (!s) return;
      const last = s.messages[s.messages.length - 1];
      if (last && last.role === "assistant") {
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
  const DEFAULT_SETTINGS = {
    host: "127.0.0.1",
    port: 8765,
    path: "/ws",
    tokenIssuePath: "/auth/token",
    tokenIssueSecret: "",
    clientId: "browser-extension"
  };
  async function loadSettings() {
    const data = await chrome.storage.local.get(["nb_settings"]);
    return { ...DEFAULT_SETTINGS, ...data.nb_settings || {} };
  }
  class NanobotWsClient {
    settings;
    ws = null;
    chatId = null;
    _listeners = /* @__PURE__ */ new Map();
    _relayed = false;
    _relayConnected = false;
    _relayListener = null;
    constructor(settings) {
      this.settings = settings;
    }
    on(event, fn) {
      if (!this._listeners.has(event)) this._listeners.set(event, []);
      this._listeners.get(event).push(fn);
      return this;
    }
    off(event, fn) {
      const list = this._listeners.get(event);
      if (list) this._listeners.set(event, list.filter((f) => f !== fn));
      return this;
    }
    _emit(event, data) {
      (this._listeners.get(event) || []).forEach((fn) => {
        try {
          fn(data);
        } catch (e) {
          console.error("[ws-client] listener error", e);
        }
      });
    }
    _isContentScript() {
      try {
        return !!(chrome.runtime?.id && !location.href.startsWith("chrome-extension://"));
      } catch {
        return false;
      }
    }
    async _issueToken() {
      const { host, port, tokenIssuePath, tokenIssueSecret } = this.settings;
      const url = `http://${host}:${port}${tokenIssuePath}`;
      const headers = {};
      if (tokenIssueSecret) {
        headers["Authorization"] = `Bearer ${tokenIssueSecret}`;
      }
      if (this._isContentScript()) {
        const result = await chrome.runtime.sendMessage({
          type: "NB_FETCH",
          url,
          headers
        });
        if (!result || !result.ok) {
          throw new Error(
            `Token issue failed: HTTP ${result?.status ?? "no response"}`
          );
        }
        return JSON.parse(result.body).token;
      }
      const resp = await fetch(url, { headers });
      if (!resp.ok) {
        throw new Error(`Token issue failed: HTTP ${resp.status}`);
      }
      const data = await resp.json();
      return data.token;
    }
    async connect() {
      if (this.ws) this.disconnect();
      const token = await this._issueToken();
      const { host, port, path, clientId } = this.settings;
      const url = `ws://${host}:${port}${path}?client_id=${encodeURIComponent(clientId)}&token=${encodeURIComponent(token)}`;
      if (this._isContentScript()) {
        return this._connectRelay(url);
      }
      return this._connectDirect(url);
    }
    _connectDirect(url) {
      this._relayed = false;
      return new Promise((resolve, reject) => {
        this.ws = new WebSocket(url);
        const onOpen = () => {
          this.ws.removeEventListener("open", onOpen);
          this.ws.removeEventListener("error", onError);
          resolve();
        };
        const onError = () => {
          this.ws.removeEventListener("open", onOpen);
          this.ws.removeEventListener("error", onError);
          reject(new Error("WebSocket connection failed"));
        };
        this.ws.addEventListener("open", onOpen);
        this.ws.addEventListener("error", onError);
        this.ws.addEventListener("message", (e) => this._handleFrame(e.data));
        this.ws.addEventListener("close", (e) => {
          this._emit("close", { code: e.code, reason: e.reason });
          this.ws = null;
        });
        this.ws.addEventListener("error", () => this._emit("error", {}));
      });
    }
    async _connectRelay(url) {
      this._relayed = true;
      this._relayConnected = false;
      this._relayListener = (msg) => {
        if (msg.type === "NB_WS_MESSAGE") this._handleFrame(msg.data);
        else if (msg.type === "NB_WS_OPEN") {
          this._relayConnected = true;
        } else if (msg.type === "NB_WS_CLOSE") {
          this._relayConnected = false;
          this._emit("close", { code: msg.code, reason: msg.reason });
        } else if (msg.type === "NB_WS_ERROR") {
          this._emit("error", {});
        }
      };
      chrome.runtime.onMessage.addListener(this._relayListener);
      const result = await chrome.runtime.sendMessage({ type: "NB_WS_CONNECT", url });
      if (!result?.ok) {
        throw new Error("WebSocket relay failed");
      }
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("WebSocket relay timeout")),
          1e4
        );
        const check = () => {
          if (this._relayConnected) {
            clearTimeout(timeout);
            resolve();
          } else setTimeout(check, 50);
        };
        check();
      });
    }
    _handleFrame(raw) {
      try {
        const data = JSON.parse(raw);
        const event = data.event;
        if (event === "ready") {
          this.chatId = data.chat_id ?? null;
          this._emit("ready", data);
        } else if (event === "delta") {
          this._emit("delta", data);
        } else if (event === "stream_end") {
          this._emit("stream_end", data);
        } else if (event === "message") {
          this._emit("message", data);
        } else {
          this._emit("unknown", data);
        }
      } catch {
      }
    }
    send(text) {
      if (this._relayed) {
        chrome.runtime.sendMessage({ type: "NB_WS_SEND", text });
        return;
      }
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(text);
      }
    }
    sendJSON(obj) {
      this.send(JSON.stringify(obj));
    }
    disconnect() {
      if (this._relayed) {
        chrome.runtime.sendMessage({ type: "NB_WS_CLOSE" });
        this._relayConnected = false;
        if (this._relayListener) {
          chrome.runtime.onMessage.removeListener(this._relayListener);
          this._relayListener = null;
        }
        this._relayed = false;
      } else if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      this.chatId = null;
    }
    get connected() {
      if (this._relayed) return this._relayConnected;
      return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }
  }
  (async function QuickChat() {
    if (window.__nb_qc) {
      window.__nb_qc.toggle();
      return;
    }
    window.__nb_qc = true;
    const sessions = new SessionManager();
    await sessions.load();
    const state = {
      visible: false,
      ws: null,
      isStreaming: false,
      sessionId: null
    };
    function esc(s) {
      const d = document.createElement("div");
      d.textContent = s;
      return d.innerHTML;
    }
    const backdrop = document.createElement("div");
    backdrop.id = "nb-qc-backdrop";
    const container = document.createElement("div");
    container.id = "nb-qc-container";
    container.innerHTML = `
    <div id="nb-qc-header">
      <span class="nb-logo">N</span>
      <span class="nb-title">Ask Nanobot</span>
      <span class="nb-shortcut">Esc to close</span>
    </div>
    <div id="nb-qc-messages"></div>
    <div id="nb-qc-status" class="disconnected"><span class="nb-dot"></span><span>Disconnected</span></div>
    <div id="nb-qc-input-area">
      <textarea id="nb-qc-input" placeholder="Ask anything..." rows="1"></textarea>
      <button id="nb-qc-send" title="Send">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M15.854.146a.5.5 0 0 1 .11.54l-5.819 14.547a.75.75 0 0 1-1.329.124l-3.178-4.995L.643 7.184a.75.75 0 0 1 .124-1.33L15.314.037a.5.5 0 0 1 .54.11ZM6.636 10.07l2.761 4.338L14.13 2.576 6.636 10.07Zm6.787-8.201L1.591 6.602l4.339 2.76 7.494-7.493Z"/>
        </svg>
      </button>
    </div>
  `;
    const messagesEl = container.querySelector("#nb-qc-messages");
    const statusEl = container.querySelector("#nb-qc-status");
    const inputEl = container.querySelector("#nb-qc-input");
    const sendBtn = container.querySelector("#nb-qc-send");
    function ensureSession() {
      const list = sessions.list();
      if (list.length > 0) {
        state.sessionId = list[0].id;
      } else {
        state.sessionId = sessions.create("Quick Chat");
      }
    }
    function renderHistory() {
      const session = sessions.get(state.sessionId);
      if (!session) return;
      session.messages.forEach((m) => {
        appendMsg(m.role, m.content, true);
      });
    }
    function show() {
      if (state.visible) return;
      state.visible = true;
      ensureSession();
      document.body.appendChild(backdrop);
      document.body.appendChild(container);
      messagesEl.innerHTML = "";
      renderHistory();
      inputEl.focus();
      connect();
    }
    function hide() {
      if (!state.visible) return;
      state.visible = false;
      backdrop.remove();
      container.remove();
      disconnect();
    }
    function toggle() {
      state.visible ? hide() : show();
    }
    window.__nb_qc = { toggle };
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === "NB_QUICKCHAT_TOGGLE") toggle();
    });
    function setStatus(cls, text) {
      statusEl.className = cls;
      statusEl.innerHTML = `<span class="nb-dot"></span><span>${esc(text)}</span>`;
    }
    async function connect() {
      const settings = await loadSettings();
      state.ws = new NanobotWsClient(settings);
      setStatus("connecting", "Connecting...");
      state.ws.on("ready", (data) => {
        const frame = data;
        setStatus("connected", frame.chat_id ? `chat ${frame.chat_id.slice(0, 8)}` : "Connected");
      });
      state.ws.on("message", (data) => {
        const frame = data;
        const text = frame.text || "";
        sessions.addMessage(state.sessionId, "assistant", text);
        sessions.markLastAssistantDone(state.sessionId);
        appendMsg("assistant", text, true);
        state.isStreaming = false;
        sendBtn.disabled = false;
      });
      state.ws.on("delta", (data) => {
        const frame = data;
        const text = frame.text || "";
        if (!state.isStreaming) {
          state.isStreaming = true;
          sendBtn.disabled = true;
          appendMsg("assistant", text, false);
        } else {
          const last = messagesEl.querySelector(".nb-msg.assistant:last-child .nb-body");
          if (last) last.textContent += text;
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
        sessions.appendToLastAssistant(state.sessionId, text);
      });
      state.ws.on("stream_end", () => {
        sessions.markLastAssistantDone(state.sessionId);
        const last = messagesEl.querySelector(".nb-msg.assistant:last-child");
        if (last) last.classList.remove("streaming");
        state.isStreaming = false;
        sendBtn.disabled = false;
      });
      state.ws.on("close", () => setStatus("disconnected", "Disconnected"));
      state.ws.on("error", () => setStatus("error", "Connection failed"));
      try {
        await state.ws.connect();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setStatus("error", message);
      }
    }
    function disconnect() {
      if (state.ws) {
        state.ws.disconnect();
        state.ws = null;
      }
      state.isStreaming = false;
    }
    function appendMsg(role, content, finalized) {
      const el = document.createElement("div");
      el.className = `nb-msg ${role}` + (role === "assistant" && !finalized ? " streaming" : "");
      const label = role === "user" ? "You" : "Nanobot";
      el.innerHTML = `
      <span class="nb-role ${role}">${label}</span>
      <pre class="nb-body">${esc(content)}</pre>
    `;
      messagesEl.appendChild(el);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    async function send() {
      const text = inputEl.value.trim();
      if (!text || state.isStreaming) return;
      if (!state.ws?.connected) {
        setStatus("connecting", "Reconnecting...");
        try {
          await connect();
        } catch {
          setStatus("error", "Connection failed");
          return;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      if (!state.ws?.connected) {
        setStatus("error", "Not connected");
        return;
      }
      sessions.addMessage(state.sessionId, "user", text);
      appendMsg("user", text, true);
      inputEl.value = "";
      inputEl.style.height = "auto";
      state.ws.send(text);
    }
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        hide();
      }
    });
    inputEl.addEventListener("input", () => {
      inputEl.style.height = "auto";
      inputEl.style.height = Math.min(inputEl.scrollHeight, 80) + "px";
    });
    sendBtn.addEventListener("click", send);
    backdrop.addEventListener("click", hide);
    const _keyHandler = (e) => {
      if (e.key === "Escape" && state.visible) {
        e.preventDefault();
        e.stopPropagation();
        hide();
      }
    };
    document.addEventListener("keydown", _keyHandler, true);
    show();
  })();
})();
