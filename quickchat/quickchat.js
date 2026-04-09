/**
 * Quick Chat — content script injected by Ctrl+Shift+K.
 * Creates an overlay on the current page for a single conversation.
 * All DOM is scoped to #nb-qc-* to avoid page conflicts.
 */

(async function QuickChat() {
  // Guard: don't double-inject
  if (window.__nb_qc) { window.__nb_qc.toggle(); return; }
  window.__nb_qc = true;

  /* -- State ----------------------------------------------------------- */

  const sessions = new SessionManager();
  await sessions.load();

  const state = {
    visible: false,
    ws: null,
    isStreaming: false,
    sessionId: null,
  };

  /* -- Helpers --------------------------------------------------------- */

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  /* -- Create DOM ------------------------------------------------------ */

  // Backdrop
  const backdrop = document.createElement('div');
  backdrop.id = 'nb-qc-backdrop';

  // Container
  const container = document.createElement('div');
  container.id = 'nb-qc-container';
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

  const messagesEl = container.querySelector('#nb-qc-messages');
  const statusEl = container.querySelector('#nb-qc-status');
  const inputEl = container.querySelector('#nb-qc-input');
  const sendBtn = container.querySelector('#nb-qc-send');

  /* -- Session --------------------------------------------------------- */

  function ensureSession() {
    // Reuse the most recently updated session
    const list = sessions.list();
    if (list.length > 0) {
      state.sessionId = list[0].id;
    } else {
      state.sessionId = sessions.create('Quick Chat');
    }
  }

  function renderHistory() {
    const session = sessions.get(state.sessionId);
    if (!session) return;
    session.messages.forEach((m) => {
      appendMsg(m.role, m.content, true);
    });
  }

  /* -- Show / Hide ----------------------------------------------------- */

  function show() {
    if (state.visible) return;
    state.visible = true;
    ensureSession();
    document.body.appendChild(backdrop);
    document.body.appendChild(container);
    messagesEl.innerHTML = '';
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

  // Expose toggle for background service worker messages
  window.__nb_qc = { toggle };

  /* -- Listen for toggle from background -------------------------------- */

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'NB_QUICKCHAT_TOGGLE') toggle();
  });

  /* -- Status ---------------------------------------------------------- */

  function setStatus(cls, text) {
    statusEl.className = cls;
    statusEl.innerHTML = `<span class="nb-dot"></span><span>${esc(text)}</span>`;
  }

  /* -- WebSocket ------------------------------------------------------- */

  async function connect() {
    const settings = await loadSettings();
    state.ws = new NanobotWsClient(settings);
    setStatus('connecting', 'Connecting...');

    state.ws.on('ready', (data) => {
      setStatus('connected', data.chat_id ? `chat ${data.chat_id.slice(0, 8)}` : 'Connected');
    });

    state.ws.on('message', (data) => {
      const text = data.text || '';
      sessions.addMessage(state.sessionId, 'assistant', text);
      sessions.markLastAssistantDone(state.sessionId);
      appendMsg('assistant', text, true);
      state.isStreaming = false;
      sendBtn.disabled = false;
    });

    state.ws.on('delta', (data) => {
      const text = data.text || '';
      if (!state.isStreaming) {
        state.isStreaming = true;
        sendBtn.disabled = true;
        appendMsg('assistant', text, false);
      } else {
        const last = messagesEl.querySelector('.nb-msg.assistant:last-child .nb-body');
        if (last) last.textContent += text;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      sessions.appendToLastAssistant(state.sessionId, text);
    });

    state.ws.on('stream_end', () => {
      sessions.markLastAssistantDone(state.sessionId);
      const last = messagesEl.querySelector('.nb-msg.assistant:last-child');
      if (last) last.classList.remove('streaming');
      state.isStreaming = false;
      sendBtn.disabled = false;
    });

    state.ws.on('close', () => setStatus('disconnected', 'Disconnected'));
    state.ws.on('error', () => setStatus('error', 'Connection failed'));

    try {
      await state.ws.connect();
    } catch (e) {
      setStatus('error', e.message);
    }
  }

  function disconnect() {
    if (state.ws) { state.ws.disconnect(); state.ws = null; }
    state.isStreaming = false;
  }

  /* -- Messages -------------------------------------------------------- */

  function appendMsg(role, content, finalized) {
    const el = document.createElement('div');
    el.className = `nb-msg ${role}` + (role === 'assistant' && !finalized ? ' streaming' : '');
    const label = role === 'user' ? 'You' : 'Nanobot';
    el.innerHTML = `
      <span class="nb-role ${role}">${label}</span>
      <pre class="nb-body">${esc(content)}</pre>
    `;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /* -- Send ------------------------------------------------------------ */

  async function send() {
    const text = inputEl.value.trim();
    if (!text || state.isStreaming) return;

    // Auto-reconnect if disconnected
    if (!state.ws?.connected) {
      setStatus('connecting', 'Reconnecting...');
      try {
        await connect();
      } catch {
        setStatus('error', 'Connection failed');
        return;
      }
      // Small delay to let the ready event arrive
      await new Promise((r) => setTimeout(r, 300));
    }

    if (!state.ws?.connected) {
      setStatus('error', 'Not connected');
      return;
    }

    sessions.addMessage(state.sessionId, 'user', text);
    appendMsg('user', text, true);
    inputEl.value = '';
    inputEl.style.height = 'auto';
    state.ws.send(text);
  }

  /* -- Events ---------------------------------------------------------- */

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      hide();
    }
  });

  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 80) + 'px';
  });

  sendBtn.addEventListener('click', send);

  backdrop.addEventListener('click', hide);

  // Global Escape
  const _keyHandler = (e) => {
    if (e.key === 'Escape' && state.visible) {
      e.preventDefault();
      e.stopPropagation();
      hide();
    }
  };
  document.addEventListener('keydown', _keyHandler, true);

  // Auto-show on first inject
  show();
})();
