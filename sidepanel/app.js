/**
 * Side Panel — main application logic.
 */

(async function () {
  /* -- State ----------------------------------------------------------- */

  const sessions = new SessionManager();
  /** @type {NanobotWsClient|null} */
  let ws = null;
  let isStreaming = false;

  /* -- DOM refs -------------------------------------------------------- */

  const $ = (sel) => document.querySelector(sel);
  const sessionListEl = $('#session-list');
  const emptyStateEl = $('#empty-state');
  const messagesEl = $('#messages');
  const inputBarEl = $('#input-bar');
  const connStatusEl = $('#conn-status');
  const msgInput = $('#msg-input');
  const btnSend = $('#btn-send');
  const btnNew = $('#btn-new');
  const btnSettings = $('#btn-settings');
  const settingsOverlay = $('#settings-overlay');
  const settingsForm = $('#settings-form');
  const btnCancel = $('#btn-settings-cancel');

  /* -- Init ------------------------------------------------------------ */

  await sessions.load();
  renderSessionList();
  if (sessions.activeId) {
    switchSession(sessions.activeId);
  }

  /* -- Session list ---------------------------------------------------- */

  function renderSessionList() {
    sessionListEl.innerHTML = '';
    const list = sessions.list();
    if (!list.length) {
      sessionListEl.innerHTML = '<div style="padding:12px;color:var(--text-3);font-size:12px;text-align:center">No sessions</div>';
      return;
    }
    list.forEach((s) => {
      const el = document.createElement('div');
      el.className = 'session-item' + (s.id === sessions.activeId ? ' active' : '');
      el.innerHTML = `
        <span class="session-title">${esc(s.title)}</span>
        <button class="session-delete" title="Delete" data-id="${s.id}">&times;</button>
      `;
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('session-delete')) return;
        switchSession(s.id);
      });
      el.querySelector('.session-delete').addEventListener('click', (e) => {
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
    emptyStateEl.classList.add('hidden');
    messagesEl.classList.remove('hidden');
    inputBarEl.classList.remove('hidden');
  }

  function showEmpty() {
    emptyStateEl.classList.remove('hidden');
    messagesEl.classList.add('hidden');
    inputBarEl.classList.add('hidden');
  }

  async function createNewSession() {
    await disconnectWs();
    const id = sessions.create();
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
      setConnStatus('disconnected');
    }
  }

  /* -- Messages -------------------------------------------------------- */

  function renderMessages() {
    const session = sessions.getActive();
    if (!session) { messagesEl.innerHTML = ''; return; }
    messagesEl.innerHTML = '';
    session.messages.forEach((m) => {
      appendMessageDOM(m.role, m.content, m.done !== false);
    });
    scrollToBottom();
  }

  /**
   * Append a message DOM node. Returns the body element for streaming updates.
   */
  function appendMessageDOM(role, content, finalized) {
    const msgEl = document.createElement('div');
    msgEl.className = `msg ${role}`;
    if (role === 'assistant' && !finalized) msgEl.classList.add('streaming');

    const roleLabel = role === 'user' ? 'You' : 'Nanobot';
    const bodyEl = document.createElement('div');
    bodyEl.className = 'msg-body';
    bodyEl.textContent = content;

    msgEl.innerHTML = `<span class="msg-role ${role}">${roleLabel}</span>`;
    msgEl.appendChild(bodyEl);
    messagesEl.appendChild(msgEl);
    scrollToBottom();
    return bodyEl;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
  }

  /* -- WebSocket ------------------------------------------------------- */

  function setConnStatus(state, detail) {
    connStatusEl.className = state;
    const labels = { connected: 'Connected', connecting: 'Connecting...', disconnected: 'Disconnected', error: 'Error' };
    let text = labels[state] || state;
    if (detail) text += ' \u2014 ' + detail;
    connStatusEl.innerHTML = `<span class="dot"></span><span>${esc(text)}</span>`;
  }

  async function connectWs() {
    const session = sessions.getActive();
    if (!session) return;

    const settings = await loadSettings();
    ws = new NanobotWsClient(settings);
    setConnStatus('connecting');

    ws.on('ready', (data) => {
      setConnStatus('connected', data.chat_id ? `chat ${data.chat_id.slice(0, 8)}` : '');
    });

    ws.on('message', (data) => {
      const text = data.text || '';
      sessions.addMessage(session.id, 'assistant', text);
      sessions.markLastAssistantDone(session.id);
      appendMessageDOM('assistant', text, true);
      isStreaming = false;
      updateSendBtn();
    });

    ws.on('delta', (data) => {
      const text = data.text || '';
      if (!isStreaming) {
        isStreaming = true;
        updateSendBtn();
        appendMessageDOM('assistant', text, false);
      } else {
        // Fast path: update textContent of last assistant pre
        const last = messagesEl.querySelector('.msg.assistant:last-child .msg-body');
        if (last) last.textContent += text;
        scrollToBottom();
      }
      sessions.appendToLastAssistant(session.id, text);
    });

    ws.on('stream_end', () => {
      sessions.markLastAssistantDone(session.id);
      const last = messagesEl.querySelector('.msg.assistant:last-child');
      if (last) last.classList.remove('streaming');
      isStreaming = false;
      updateSendBtn();
    });

    ws.on('close', () => {
      setConnStatus('disconnected');
      isStreaming = false;
      updateSendBtn();
    });

    ws.on('error', () => {
      setConnStatus('error', 'Connection failed');
    });

    try {
      await ws.connect();
    } catch (e) {
      setConnStatus('error', e.message);
    }
  }

  async function disconnectWs() {
    if (ws) {
      ws.disconnect();
      ws = null;
    }
    isStreaming = false;
  }

  /* -- Send ------------------------------------------------------------ */

  function sendMessage() {
    const text = msgInput.value.trim();
    if (!text || !ws?.connected || isStreaming) return;

    const session = sessions.getActive();
    if (!session) return;

    sessions.addMessage(session.id, 'user', text);
    appendMessageDOM('user', text, true);
    msgInput.value = '';
    msgInput.style.height = 'auto';

    ws.send(text);
  }

  function updateSendBtn() {
    btnSend.disabled = isStreaming;
  }

  /* -- Settings -------------------------------------------------------- */

  async function openSettings() {
    const s = await loadSettings();
    $('#s-host').value = s.host;
    $('#s-port').value = s.port;
    $('#s-path').value = s.path;
    $('#s-issue-path').value = s.tokenIssuePath;
    $('#s-secret').value = s.tokenIssueSecret;
    $('#s-client-id').value = s.clientId;
    settingsOverlay.classList.remove('hidden');
  }

  function closeSettings() {
    settingsOverlay.classList.add('hidden');
  }

  async function saveSettingsFromForm() {
    const s = {
      host: $('#s-host').value.trim() || DEFAULT_SETTINGS.host,
      port: parseInt($('#s-port').value, 10) || DEFAULT_SETTINGS.port,
      path: $('#s-path').value.trim() || DEFAULT_SETTINGS.path,
      tokenIssuePath: $('#s-issue-path').value.trim() || DEFAULT_SETTINGS.tokenIssuePath,
      tokenIssueSecret: $('#s-secret').value,
      clientId: $('#s-client-id').value.trim() || DEFAULT_SETTINGS.clientId,
    };
    await saveSettings(s);
    closeSettings();
    // Reconnect with new settings
    if (sessions.activeId) {
      await connectWs();
    }
  }

  /* -- Event bindings -------------------------------------------------- */

  btnNew.addEventListener('click', createNewSession);
  btnSettings.addEventListener('click', openSettings);
  btnCancel.addEventListener('click', closeSettings);
  settingsOverlay.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) closeSettings();
  });
  settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    saveSettingsFromForm();
  });

  btnSend.addEventListener('click', sendMessage);

  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  msgInput.addEventListener('input', () => {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
  });

  // Toggle password visibility for secret field
  const secretInput = $('#s-secret');
  const toggleBtn = $('#btn-toggle-secret');
  toggleBtn.addEventListener('click', () => {
    const showing = secretInput.type === 'text';
    secretInput.type = showing ? 'password' : 'text';
    toggleBtn.querySelector('.eye-open').style.display = showing ? '' : 'none';
    toggleBtn.querySelector('.eye-closed').style.display = showing ? 'none' : '';
    toggleBtn.title = showing ? 'Show password' : 'Hide password';
  });

  /* -- Helpers --------------------------------------------------------- */

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }
})();
