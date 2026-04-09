import { SessionManager } from '../lib/session';
import { NanobotWsClient } from '../lib/ws-client';
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from '../lib/storage';
import { renderMarkdown, initCopyButtons } from '../lib/markdown';
import type { Settings } from '../lib/types';

(async function () {
  const sessions = new SessionManager();
  let ws: NanobotWsClient | null = null;
  let isStreaming = false;

  const $ = (sel: string): Element | null => document.querySelector(sel);
  const $input = (sel: string): HTMLInputElement | HTMLTextAreaElement | null =>
    document.querySelector(sel);

  const sessionListEl = $('#session-list')!;
  const emptyStateEl = $('#empty-state')!;
  const messagesEl = $('#messages')!;
  const inputBarEl = $('#input-bar')!;
  const connStatusEl = $('#conn-status')!;
  const msgInput = $('#msg-input') as HTMLTextAreaElement;
  const btnSend = $('#btn-send') as HTMLButtonElement;
  const btnNew = $('#btn-new') as HTMLButtonElement;
  const btnSettings = $('#btn-settings') as HTMLButtonElement;
  const settingsOverlay = $('#settings-overlay')!;
  const settingsForm = $('#settings-form') as HTMLFormElement;
  const btnCancel = $('#btn-settings-cancel') as HTMLButtonElement;

  await sessions.load();
  renderSessionList();
  if (sessions.activeId) {
    switchSession(sessions.activeId);
  }

  function renderSessionList(): void {
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
      el.addEventListener('click', (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains('session-delete')) return;
        switchSession(s.id);
      });
      el.querySelector('.session-delete')!.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        deleteSession(s.id);
      });
      sessionListEl.appendChild(el);
    });
  }

  async function switchSession(id: string): Promise<void> {
    await disconnectWs();
    sessions.setActive(id);
    renderSessionList();
    showChat();
    renderMessages();
    await connectWs();
  }

  function showChat(): void {
    emptyStateEl.classList.add('hidden');
    messagesEl.classList.remove('hidden');
    inputBarEl.classList.remove('hidden');
  }

  function showEmpty(): void {
    emptyStateEl.classList.remove('hidden');
    messagesEl.classList.add('hidden');
    inputBarEl.classList.add('hidden');
  }

  async function createNewSession(): Promise<void> {
    await disconnectWs();
    sessions.create();
    renderSessionList();
    showChat();
    renderMessages();
    await connectWs();
    msgInput.focus();
  }

  async function deleteSession(id: string): Promise<void> {
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

  function renderMessages(): void {
    const session = sessions.getActive();
    if (!session) { messagesEl.innerHTML = ''; return; }
    messagesEl.innerHTML = '';
    session.messages.forEach((m) => {
      appendMessageDOM(m.role, m.content, m.done !== false);
    });
    scrollToBottom();
  }

  // rAF-based streaming accumulator
  let streamAccumulator = '';
  let streamRAF = 0;

  function appendMessageDOM(role: 'user' | 'assistant', content: string, finalized: boolean): HTMLDivElement {
    const msgEl = document.createElement('div');
    msgEl.className = `msg ${role}`;
    if (role === 'assistant' && !finalized) msgEl.classList.add('streaming');

    const roleLabel = role === 'user' ? 'You' : 'Nanobot';
    const bodyEl = document.createElement('div');
    bodyEl.className = 'msg-body';

    if (role === 'assistant') {
      bodyEl.innerHTML = renderMarkdown(content);
      initCopyButtons(bodyEl);
    } else {
      bodyEl.textContent = content;
    }

    msgEl.innerHTML = `<span class="msg-role ${role}">${roleLabel}</span>`;
    msgEl.appendChild(bodyEl);
    messagesEl.appendChild(msgEl);
    scrollToBottom();
    return bodyEl;
  }

  function scrollToBottom(): void {
    requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
  }

  function setConnStatus(state: string, detail?: string): void {
    connStatusEl.className = state;
    const labels: Record<string, string> = { connected: 'Connected', connecting: 'Connecting...', disconnected: 'Disconnected', error: 'Error' };
    let text = labels[state] || state;
    if (detail) text += ' \u2014 ' + detail;
    connStatusEl.innerHTML = `<span class="dot"></span><span>${esc(text)}</span>`;
  }

  async function connectWs(): Promise<void> {
    const session = sessions.getActive();
    if (!session) return;

    const settings = await loadSettings();
    ws = new NanobotWsClient(settings);
    setConnStatus('connecting');

    ws.on('ready', (data: unknown) => {
      const d = data as { chat_id?: string };
      setConnStatus('connected', d.chat_id ? `chat ${d.chat_id.slice(0, 8)}` : '');
    });

    ws.on('message', (data: unknown) => {
      const d = data as { text?: string };
      const text = d.text || '';
      sessions.addMessage(session.id, 'assistant', text);
      sessions.markLastAssistantDone(session.id);
      appendMessageDOM('assistant', text, true);
      isStreaming = false;
      updateSendBtn();
    });

    ws.on('delta', (data: unknown) => {
      const d = data as { text?: string };
      const text = d.text || '';
      if (!isStreaming) {
        isStreaming = true;
        updateSendBtn();
        streamAccumulator = text;
        appendMessageDOM('assistant', streamAccumulator, false);
      } else {
        streamAccumulator += text;
        if (streamRAF) cancelAnimationFrame(streamRAF);
        streamRAF = requestAnimationFrame(() => {
          const last = messagesEl.querySelector('.msg.assistant:last-child .msg-body');
          if (last) {
            last.innerHTML = renderMarkdown(streamAccumulator);
          }
          scrollToBottom();
          streamRAF = 0;
        });
      }
      sessions.appendToLastAssistant(session.id, text);
    });

    ws.on('stream_end', () => {
      sessions.markLastAssistantDone(session.id);
      if (streamRAF) {
        cancelAnimationFrame(streamRAF);
        streamRAF = 0;
      }
      const lastBody = messagesEl.querySelector('.msg.assistant:last-child .msg-body');
      if (lastBody) {
        lastBody.innerHTML = renderMarkdown(streamAccumulator);
        initCopyButtons(lastBody);
      }
      const lastMsg = messagesEl.querySelector('.msg.assistant:last-child');
      if (lastMsg) lastMsg.classList.remove('streaming');
      streamAccumulator = '';
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
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setConnStatus('error', msg);
    }
  }

  async function disconnectWs(): Promise<void> {
    if (ws) {
      ws.disconnect();
      ws = null;
    }
    isStreaming = false;
  }

  async function sendMessage(): Promise<void> {
    const text = msgInput.value.trim();
    if (!text || isStreaming) return;

    if (!ws?.connected) {
      setConnStatus('connecting');
      try {
        await connectWs();
      } catch {
        setConnStatus('error', 'Connection failed');
        return;
      }
      await new Promise<void>((r) => setTimeout(r, 300));
    }

    if (!ws?.connected) {
      setConnStatus('error', 'Not connected');
      return;
    }

    const session = sessions.getActive();
    if (!session) return;

    sessions.addMessage(session.id, 'user', text);
    appendMessageDOM('user', text, true);
    msgInput.value = '';
    msgInput.style.height = 'auto';

    ws.send(text);
  }

  function updateSendBtn(): void {
    btnSend.disabled = isStreaming;
  }

  async function openSettings(): Promise<void> {
    const s = await loadSettings();
    const hostEl = $input('#s-host');
    const portEl = $input('#s-port');
    const pathEl = $input('#s-path');
    const issuePathEl = $input('#s-issue-path');
    const secretEl = $input('#s-secret');
    const clientIdEl = $input('#s-client-id');

    if (hostEl) hostEl.value = s.host;
    if (portEl) portEl.value = String(s.port);
    if (pathEl) pathEl.value = s.path;
    if (issuePathEl) issuePathEl.value = s.tokenIssuePath;
    if (secretEl) secretEl.value = s.tokenIssueSecret;
    if (clientIdEl) clientIdEl.value = s.clientId;

    settingsOverlay.classList.remove('hidden');
  }

  function closeSettings(): void {
    settingsOverlay.classList.add('hidden');
  }

  async function saveSettingsFromForm(): Promise<void> {
    const hostEl = $input('#s-host');
    const portEl = $input('#s-port');
    const pathEl = $input('#s-path');
    const issuePathEl = $input('#s-issue-path');
    const secretEl = $input('#s-secret');
    const clientIdEl = $input('#s-client-id');

    const s: Settings = {
      host: (hostEl?.value.trim()) || DEFAULT_SETTINGS.host,
      port: parseInt(portEl?.value ?? '', 10) || DEFAULT_SETTINGS.port,
      path: (pathEl?.value.trim()) || DEFAULT_SETTINGS.path,
      tokenIssuePath: (issuePathEl?.value.trim()) || DEFAULT_SETTINGS.tokenIssuePath,
      tokenIssueSecret: secretEl?.value ?? '',
      clientId: (clientIdEl?.value.trim()) || DEFAULT_SETTINGS.clientId,
    };
    await saveSettings(s);
    closeSettings();
    if (sessions.activeId) {
      await connectWs();
    }
  }

  btnNew.addEventListener('click', createNewSession);
  btnSettings.addEventListener('click', openSettings);
  btnCancel.addEventListener('click', closeSettings);
  settingsOverlay.addEventListener('click', (e: MouseEvent) => {
    if (e.target === settingsOverlay) closeSettings();
  });
  settingsForm.addEventListener('submit', (e: Event) => {
    e.preventDefault();
    saveSettingsFromForm();
  });

  btnSend.addEventListener('click', sendMessage);

  msgInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  msgInput.addEventListener('input', () => {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
  });

  const secretInput = $input('#s-secret') as HTMLInputElement;
  const toggleBtn = $('#btn-toggle-secret')!;
  toggleBtn.addEventListener('click', () => {
    const showing = secretInput.type === 'text';
    secretInput.type = showing ? 'password' : 'text';
    const eyeOpen = toggleBtn.querySelector('.eye-open');
    const eyeClosed = toggleBtn.querySelector('.eye-closed');
    if (eyeOpen) eyeOpen.style.display = showing ? '' : 'none';
    if (eyeClosed) eyeClosed.style.display = showing ? 'none' : '';
    toggleBtn.title = showing ? 'Show password' : 'Hide password';
  });

  function esc(str: string): string {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }
})();
