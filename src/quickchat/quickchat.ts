import { SessionManager } from '../lib/session';
import { loadSettings } from '../lib/storage';
import { NanobotWsClient } from '../lib/ws-client';
import { renderMarkdown, initCopyButtons } from '../lib/markdown';
import { esc } from '../lib/utils';

/** Maximum user message length in characters. */
const MAX_MESSAGE_LENGTH = 32000;

interface QuickChatState {
  visible: boolean;
  ws: NanobotWsClient | null;
  isStreaming: boolean;
  sessionId: string | null;
  streamAccumulator: string;
  streamRAF: number;
}

interface QuickChatApi {
  toggle: () => void;
}

declare global {
  interface Window {
    __nb_qc: QuickChatApi | true;
  }
}

/** Unique session title to avoid mixing quick chat with side panel sessions. */
const QUICK_CHAT_SESSION_TITLE = 'Quick Chat';

(async function QuickChat(): Promise<void> {
  if (window.__nb_qc) {
    (window.__nb_qc as QuickChatApi).toggle();
    return;
  }
  window.__nb_qc = true;

  const sessions = new SessionManager();
  await sessions.load();

  const state: QuickChatState = {
    visible: false,
    ws: null,
    isStreaming: false,
    sessionId: null,
    streamAccumulator: '',
    streamRAF: 0,
  };

  const backdrop = document.createElement('div');
  backdrop.id = 'nb-qc-backdrop';

  const container = document.createElement('div');
  container.id = 'nb-qc-container';
  container.innerHTML = `
    <div id="nb-qc-header">
      <img class="nb-logo" src="${chrome.runtime.getURL('icons/logo-cat.png')}" alt="Nanobot">
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

  const messagesEl = container.querySelector('#nb-qc-messages')!;
  const statusEl = container.querySelector('#nb-qc-status')!;
  const inputEl = container.querySelector('#nb-qc-input') as HTMLTextAreaElement;
  const sendBtn = container.querySelector('#nb-qc-send') as HTMLButtonElement;

  function ensureSession(): void {
    // Use a dedicated "Quick Chat" session instead of reusing the most recent side panel session
    const list = sessions.list();
    const existing = list.find((s) => s.title === QUICK_CHAT_SESSION_TITLE);
    if (existing) {
      state.sessionId = existing.id;
    } else {
      state.sessionId = sessions.create(QUICK_CHAT_SESSION_TITLE);
    }
  }

  function renderHistory(): void {
    const session = sessions.get(state.sessionId!);
    if (!session) return;
    session.messages.forEach((m) => {
      appendMsg(m.role, m.content, true);
    });
  }

  function show(): void {
    if (state.visible) return;
    state.visible = true;
    ensureSession();
    document.body.appendChild(backdrop);
    document.body.appendChild(container);
    messagesEl.innerHTML = '';
    renderHistory();
    inputEl.focus();
    connect();
    // Add document-level Escape listener when overlay is shown
    document.addEventListener('keydown', _keyHandlerCapturing, true);
  }

  function hide(): void {
    if (!state.visible) return;
    state.visible = false;
    if (state.streamRAF) {
      cancelAnimationFrame(state.streamRAF);
      state.streamRAF = 0;
    }
    backdrop.remove();
    container.remove();
    disconnect();
    state.streamAccumulator = '';
    // Flush debounced session writes to prevent data loss
    sessions._flushPersist();
    // Remove document-level Escape listener when overlay is hidden
    document.removeEventListener('keydown', _keyHandlerCapturing, true);
  }

  function toggle(): void {
    state.visible ? hide() : show();
  }

  window.__nb_qc = { toggle };

  chrome.runtime.onMessage.addListener((msg: { type: string }) => {
    if (msg.type === 'NB_QUICKCHAT_TOGGLE') toggle();
  });

  function setStatus(cls: string, text: string): void {
    statusEl.className = cls;
    statusEl.innerHTML = `<span class="nb-dot"></span><span>${esc(text)}</span>`;
  }

  async function connect(): Promise<void> {
    const settings = await loadSettings();
    state.ws = new NanobotWsClient(settings);
    setStatus('connecting', 'Connecting...');

    state.ws.on('ready', (data: unknown) => {
      if (!state.visible) return;
      const frame = data as { chat_id?: string };
      setStatus('connected', frame.chat_id ? `chat ${frame.chat_id.slice(0, 8)}` : 'Connected');
    });

    state.ws.on('message', (data: unknown) => {
      if (!state.visible) return;
      const frame = data as { text?: string };
      const text = frame.text || '';
      sessions.addMessage(state.sessionId!, 'assistant', text);
      sessions.markLastAssistantDone(state.sessionId!);
      appendMsg('assistant', text, true);
      state.isStreaming = false;
      sendBtn.disabled = false;
    });

    state.ws.on('delta', (data: unknown) => {
      if (!state.visible) return;
      const frame = data as { text?: string };
      const text = frame.text || '';
      if (!state.isStreaming) {
        state.isStreaming = true;
        sendBtn.disabled = true;
        state.streamAccumulator = text;
        appendMsg('assistant', state.streamAccumulator, false);
      } else {
        state.streamAccumulator += text;
        if (state.streamRAF) cancelAnimationFrame(state.streamRAF);
        state.streamRAF = requestAnimationFrame(() => {
          const last = messagesEl.querySelector('.nb-msg.assistant:last-child .nb-body');
          if (last) {
            last.innerHTML = renderMarkdown(state.streamAccumulator);
          }
          messagesEl.scrollTop = messagesEl.scrollHeight;
          state.streamRAF = 0;
        });
      }
      sessions.appendToLastAssistant(state.sessionId!, text);
    });

    state.ws.on('stream_end', () => {
      if (!state.visible) return;
      sessions.markLastAssistantDone(state.sessionId!);
      if (state.streamRAF) {
        cancelAnimationFrame(state.streamRAF);
        state.streamRAF = 0;
      }
      const lastBody = messagesEl.querySelector('.nb-msg.assistant:last-child .nb-body');
      if (lastBody) {
        lastBody.innerHTML = renderMarkdown(state.streamAccumulator);
        initCopyButtons(lastBody);
      }
      const last = messagesEl.querySelector('.nb-msg.assistant:last-child');
      if (last) last.classList.remove('streaming');
      state.streamAccumulator = '';
      state.isStreaming = false;
      sendBtn.disabled = false;
    });

    state.ws.on('close', () => {
      if (!state.visible) return;
      setStatus('disconnected', 'Disconnected');
    });
    state.ws.on('error', () => {
      if (!state.visible) return;
      setStatus('error', 'Connection failed');
    });

    try {
      await state.ws.connect();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus('error', message);
    }
  }

  function disconnect(): void {
    if (state.ws) {
      state.ws.disconnect();
      state.ws = null;
    }
    state.isStreaming = false;
  }

  function appendMsg(role: 'user' | 'assistant', content: string, finalized: boolean): void {
    const el = document.createElement('div');
    el.className = `nb-msg ${role}` + (role === 'assistant' && !finalized ? ' streaming' : '');
    const label = role === 'user' ? 'You' : 'Nanobot';

    const bodyEl = document.createElement('div');
    bodyEl.className = 'nb-body';
    if (role === 'assistant') {
      bodyEl.innerHTML = renderMarkdown(content);
      initCopyButtons(bodyEl);
    } else {
      bodyEl.textContent = content;
    }

    el.innerHTML = `<span class="nb-role ${role}">${label}</span>`;
    el.appendChild(bodyEl);
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function send(): Promise<void> {
    const text = inputEl.value.trim();
    if (!text || state.isStreaming) return;

    if (text.length > MAX_MESSAGE_LENGTH) {
      setStatus('error', `Message too long (max ${MAX_MESSAGE_LENGTH} chars)`);
      return;
    }

    if (!state.ws?.connected) {
      setStatus('connecting', 'Reconnecting...');
      try {
        await connect();
      } catch {
        setStatus('error', 'Connection failed');
        return;
      }
    }

    if (!state.ws?.connected) {
      setStatus('error', 'Not connected');
      return;
    }

    // Disable send button to prevent duplicate sends
    sendBtn.disabled = true;

    // Guard against disconnect during async reconnect (e.g. user pressed Escape)
    if (!state.ws) {
      sendBtn.disabled = false;
      return;
    }

    sessions.addMessage(state.sessionId!, 'user', text);
    appendMsg('user', text, true);
    inputEl.value = '';
    inputEl.style.height = 'auto';
    state.ws.send(text);
  }

  inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
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

  // Intercept Escape at document level to close overlay from anywhere except host-page inputs.
  // The textarea's own keydown handler calls stopPropagation(), so it handles its own Escape
  // before this document-level handler fires.
  const _keyHandlerCapturing = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && state.visible) {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      // Don't intercept Escape if user is typing in a host page input/select/textarea
      if (target.closest('input, select, textarea, [contenteditable]')) return;
      e.preventDefault();
      e.stopPropagation();
      hide();
    }
  };
  // Listener is added/removed in show()/hide() — not added here at module level

  show();
})();
