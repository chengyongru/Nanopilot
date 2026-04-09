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
  async function saveSettings(settings) {
    await chrome.storage.local.set({ nb_settings: settings });
  }
  (async function() {
    const sessions = new SessionManager();
    let ws = null;
    let isStreaming = false;
    const $ = (sel) => document.querySelector(sel);
    const $input = (sel) => document.querySelector(sel);
    const sessionListEl = $("#session-list");
    const emptyStateEl = $("#empty-state");
    const messagesEl = $("#messages");
    const inputBarEl = $("#input-bar");
    const connStatusEl = $("#conn-status");
    const msgInput = $("#msg-input");
    const btnSend = $("#btn-send");
    const btnNew = $("#btn-new");
    const btnSettings = $("#btn-settings");
    const settingsOverlay = $("#settings-overlay");
    const settingsForm = $("#settings-form");
    const btnCancel = $("#btn-settings-cancel");
    await sessions.load();
    renderSessionList();
    if (sessions.activeId) {
      switchSession(sessions.activeId);
    }
    function renderSessionList() {
      sessionListEl.innerHTML = "";
      const list = sessions.list();
      if (!list.length) {
        sessionListEl.innerHTML = '<div style="padding:12px;color:var(--text-3);font-size:12px;text-align:center">No sessions</div>';
        return;
      }
      list.forEach((s) => {
        const el = document.createElement("div");
        el.className = "session-item" + (s.id === sessions.activeId ? " active" : "");
        el.innerHTML = `
        <span class="session-title">${esc(s.title)}</span>
        <button class="session-delete" title="Delete" data-id="${s.id}">&times;</button>
      `;
        el.addEventListener("click", (e) => {
          const target = e.target;
          if (target.classList.contains("session-delete")) return;
          switchSession(s.id);
        });
        el.querySelector(".session-delete").addEventListener("click", (e) => {
          e.stopPropagation();
          deleteSession(s.id);
        });
        sessionListEl.appendChild(el);
      });
    }
    async function switchSession(id) {
      await disconnectWs();
      sessions.setActive(id);
      renderSessionList();
      showChat();
      renderMessages();
      await connectWs();
    }
    function showChat() {
      emptyStateEl.classList.add("hidden");
      messagesEl.classList.remove("hidden");
      inputBarEl.classList.remove("hidden");
    }
    function showEmpty() {
      emptyStateEl.classList.remove("hidden");
      messagesEl.classList.add("hidden");
      inputBarEl.classList.add("hidden");
    }
    async function createNewSession() {
      await disconnectWs();
      sessions.create();
      renderSessionList();
      showChat();
      renderMessages();
      await connectWs();
      msgInput.focus();
    }
    async function deleteSession(id) {
      await disconnectWs();
      sessions.delete(id);
      renderSessionList();
      if (sessions.activeId) {
        switchSession(sessions.activeId);
      } else {
        showEmpty();
        setConnStatus("disconnected");
      }
    }
    function renderMessages() {
      const session = sessions.getActive();
      if (!session) {
        messagesEl.innerHTML = "";
        return;
      }
      messagesEl.innerHTML = "";
      session.messages.forEach((m) => {
        appendMessageDOM(m.role, m.content, m.done !== false);
      });
      scrollToBottom();
    }
    function appendMessageDOM(role, content, finalized) {
      const msgEl = document.createElement("div");
      msgEl.className = `msg ${role}`;
      if (role === "assistant" && !finalized) msgEl.classList.add("streaming");
      const roleLabel = role === "user" ? "You" : "Nanobot";
      const bodyEl = document.createElement("div");
      bodyEl.className = "msg-body";
      bodyEl.textContent = content;
      msgEl.innerHTML = `<span class="msg-role ${role}">${roleLabel}</span>`;
      msgEl.appendChild(bodyEl);
      messagesEl.appendChild(msgEl);
      scrollToBottom();
      return bodyEl;
    }
    function scrollToBottom() {
      requestAnimationFrame(() => {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      });
    }
    function setConnStatus(state, detail) {
      connStatusEl.className = state;
      const labels = { connected: "Connected", connecting: "Connecting...", disconnected: "Disconnected", error: "Error" };
      let text = labels[state] || state;
      if (detail) text += " — " + detail;
      connStatusEl.innerHTML = `<span class="dot"></span><span>${esc(text)}</span>`;
    }
    async function connectWs() {
      const session = sessions.getActive();
      if (!session) return;
      const settings = await loadSettings();
      ws = new NanobotWsClient(settings);
      setConnStatus("connecting");
      ws.on("ready", (data) => {
        const d = data;
        setConnStatus("connected", d.chat_id ? `chat ${d.chat_id.slice(0, 8)}` : "");
      });
      ws.on("message", (data) => {
        const d = data;
        const text = d.text || "";
        sessions.addMessage(session.id, "assistant", text);
        sessions.markLastAssistantDone(session.id);
        appendMessageDOM("assistant", text, true);
        isStreaming = false;
        updateSendBtn();
      });
      ws.on("delta", (data) => {
        const d = data;
        const text = d.text || "";
        if (!isStreaming) {
          isStreaming = true;
          updateSendBtn();
          appendMessageDOM("assistant", text, false);
        } else {
          const last = messagesEl.querySelector(".msg.assistant:last-child .msg-body");
          if (last) last.textContent += text;
          scrollToBottom();
        }
        sessions.appendToLastAssistant(session.id, text);
      });
      ws.on("stream_end", () => {
        sessions.markLastAssistantDone(session.id);
        const last = messagesEl.querySelector(".msg.assistant:last-child");
        if (last) last.classList.remove("streaming");
        isStreaming = false;
        updateSendBtn();
      });
      ws.on("close", () => {
        setConnStatus("disconnected");
        isStreaming = false;
        updateSendBtn();
      });
      ws.on("error", () => {
        setConnStatus("error", "Connection failed");
      });
      try {
        await ws.connect();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setConnStatus("error", msg);
      }
    }
    async function disconnectWs() {
      if (ws) {
        ws.disconnect();
        ws = null;
      }
      isStreaming = false;
    }
    async function sendMessage() {
      const text = msgInput.value.trim();
      if (!text || isStreaming) return;
      if (!ws?.connected) {
        setConnStatus("connecting");
        try {
          await connectWs();
        } catch {
          setConnStatus("error", "Connection failed");
          return;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      if (!ws?.connected) {
        setConnStatus("error", "Not connected");
        return;
      }
      const session = sessions.getActive();
      if (!session) return;
      sessions.addMessage(session.id, "user", text);
      appendMessageDOM("user", text, true);
      msgInput.value = "";
      msgInput.style.height = "auto";
      ws.send(text);
    }
    function updateSendBtn() {
      btnSend.disabled = isStreaming;
    }
    async function openSettings() {
      const s = await loadSettings();
      const hostEl = $input("#s-host");
      const portEl = $input("#s-port");
      const pathEl = $input("#s-path");
      const issuePathEl = $input("#s-issue-path");
      const secretEl = $input("#s-secret");
      const clientIdEl = $input("#s-client-id");
      if (hostEl) hostEl.value = s.host;
      if (portEl) portEl.value = String(s.port);
      if (pathEl) pathEl.value = s.path;
      if (issuePathEl) issuePathEl.value = s.tokenIssuePath;
      if (secretEl) secretEl.value = s.tokenIssueSecret;
      if (clientIdEl) clientIdEl.value = s.clientId;
      settingsOverlay.classList.remove("hidden");
    }
    function closeSettings() {
      settingsOverlay.classList.add("hidden");
    }
    async function saveSettingsFromForm() {
      const hostEl = $input("#s-host");
      const portEl = $input("#s-port");
      const pathEl = $input("#s-path");
      const issuePathEl = $input("#s-issue-path");
      const secretEl = $input("#s-secret");
      const clientIdEl = $input("#s-client-id");
      const s = {
        host: hostEl?.value.trim() || DEFAULT_SETTINGS.host,
        port: parseInt(portEl?.value ?? "", 10) || DEFAULT_SETTINGS.port,
        path: pathEl?.value.trim() || DEFAULT_SETTINGS.path,
        tokenIssuePath: issuePathEl?.value.trim() || DEFAULT_SETTINGS.tokenIssuePath,
        tokenIssueSecret: secretEl?.value ?? "",
        clientId: clientIdEl?.value.trim() || DEFAULT_SETTINGS.clientId
      };
      await saveSettings(s);
      closeSettings();
      if (sessions.activeId) {
        await connectWs();
      }
    }
    btnNew.addEventListener("click", createNewSession);
    btnSettings.addEventListener("click", openSettings);
    btnCancel.addEventListener("click", closeSettings);
    settingsOverlay.addEventListener("click", (e) => {
      if (e.target === settingsOverlay) closeSettings();
    });
    settingsForm.addEventListener("submit", (e) => {
      e.preventDefault();
      saveSettingsFromForm();
    });
    btnSend.addEventListener("click", sendMessage);
    msgInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    msgInput.addEventListener("input", () => {
      msgInput.style.height = "auto";
      msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + "px";
    });
    const secretInput = $input("#s-secret");
    const toggleBtn = $("#btn-toggle-secret");
    toggleBtn.addEventListener("click", () => {
      const showing = secretInput.type === "text";
      secretInput.type = showing ? "password" : "text";
      const eyeOpen = toggleBtn.querySelector(".eye-open");
      const eyeClosed = toggleBtn.querySelector(".eye-closed");
      if (eyeOpen) eyeOpen.style.display = showing ? "" : "none";
      if (eyeClosed) eyeClosed.style.display = showing ? "none" : "";
      toggleBtn.title = showing ? "Show password" : "Hide password";
    });
    function esc(str) {
      const d = document.createElement("div");
      d.textContent = str;
      return d.innerHTML;
    }
  })();
})();
