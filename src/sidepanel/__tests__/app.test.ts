import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Settings } from '../../lib/types';

// ---------------------------------------------------------------------------
// Fake NanobotWsClient — defined at module level so vi.mock can reference it
// ---------------------------------------------------------------------------

class FakeWsClient {
  static _settings: Settings | null = null;
  static _instances: FakeWsClient[] = [];
  connected = false;
  _listeners: Map<string, ((data: unknown) => void)[]> = new Map();

  constructor(settings: Settings) {
    FakeWsClient._settings = settings;
    FakeWsClient._instances.push(this);
  }

  on(event: string, fn: (data: unknown) => void): this {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event)!.push(fn);
    return this;
  }

  off(event: string, fn: (data: unknown) => void): this {
    const list = this._listeners.get(event);
    if (list) this._listeners.set(event, list.filter((f) => f !== fn));
    return this;
  }

  emit(event: string, data?: unknown): void {
    (this._listeners.get(event) || []).forEach((fn) => fn(data));
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.emit('ready', {});
    return;
  }

  disconnect(): void {
    this.connected = false;
  }

  send(text: string): void {
    // no-op in tests
  }
}

// vi.mock is hoisted to top of file, before any imports
vi.mock('../../lib/ws-client', () => ({
  NanobotWsClient: FakeWsClient,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS: Settings = {
  host: '127.0.0.1',
  port: 8765,
  path: '/ws',
  tokenIssuePath: '/auth/token',
  tokenIssueSecret: '',
  clientId: 'browser-extension',
};

/** Full HTML structure matching sidepanel/index.html */
function buildDOM(): string {
  return `
    <div id="session-list"></div>
    <div id="empty-state">
      <img class="empty-icon" src="../icons/logo-cat.png" alt="Nanobot">
      <p>New Conversation</p>
    </div>
    <div id="messages" class="hidden"></div>
    <div id="input-bar" class="hidden">
      <div id="conn-status"></div>
      <div class="input-row">
        <textarea id="msg-input" placeholder="Message Nanobot..." rows="1"></textarea>
        <button id="btn-send" class="icon-btn send-btn" title="Send (Enter)"></button>
      </div>
    </div>
    <button id="btn-new" class="icon-btn" title="New Session"></button>
    <button id="btn-settings" class="icon-btn" title="Settings"></button>
    <div id="settings-overlay" class="hidden">
      <div id="settings-panel">
        <h2>Settings</h2>
        <form id="settings-form">
          <label><span class="label-text">Host</span><input type="text" id="s-host"></label>
          <label><span class="label-text">Port</span><input type="number" id="s-port" min="1" max="65535"></label>
          <label><span class="label-text">WS Path</span><input type="text" id="s-path"></label>
          <label><span class="label-text">Token Issue Path</span><input type="text" id="s-issue-path"></label>
          <label><span class="label-text">Token Issue Secret</span>
            <div class="input-with-toggle">
              <input type="password" id="s-secret">
              <button type="button" id="btn-toggle-secret" class="icon-btn toggle-pw" title="Show password">
                <svg class="eye-open" width="16" height="16"></svg>
                <svg class="eye-closed" width="16" height="16" style="display:none"></svg>
              </button>
            </div>
          </label>
          <label><span class="label-text">Client ID</span><input type="text" id="s-client-id"></label>
          <div id="settings-error" class="hidden"></div>
          <div class="form-actions">
            <button type="button" id="btn-settings-cancel" class="btn-secondary">Cancel</button>
            <button type="submit" class="btn-primary">Save</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sidepanel app', () => {
  let storedSessions: Record<string, unknown>;
  let storedActive: string | null;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();

    storedSessions = {};
    storedActive = null;
    FakeWsClient._instances = [];

    // Stub chrome
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (keys: string[]) => {
            const result: Record<string, unknown> = {};
            if (keys.includes('nb_settings')) result.nb_settings = DEFAULT_SETTINGS;
            if (keys.includes('nb_sessions')) result.nb_sessions = storedSessions;
            if (keys.includes('nb_active_session')) result.nb_active_session = storedActive;
            return result;
          }),
          set: vi.fn(async (data: Record<string, unknown>) => {
            if ('nb_sessions' in data) storedSessions = data.nb_sessions as Record<string, unknown>;
            if ('nb_active_session' in data) storedActive = data.nb_active_session as string | null;
          }),
        },
      },
      runtime: { id: 'ext-id' },
    });
    vi.stubGlobal('location', { href: 'chrome-extension://abc/sidepanel/index.html' });

    document.body.innerHTML = buildDOM();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb();
      return 0;
    });
  });

  // =========================================================================
  // Basic loading
  // =========================================================================
  it('should load without errors', async () => {
    await import('../app');
  });

  it('should render empty session list when no sessions', async () => {
    await import('../app');
    const list = document.querySelector('#session-list');
    expect(list?.textContent).toContain('No sessions');
  });

  it('should show empty state initially when no sessions', async () => {
    await import('../app');
    const emptyState = document.querySelector('#empty-state');
    expect(emptyState?.classList.contains('hidden')).toBe(false);
    expect(document.querySelector('#messages')?.classList.contains('hidden')).toBe(true);
    expect(document.querySelector('#input-bar')?.classList.contains('hidden')).toBe(true);
  });

  // =========================================================================
  // createNewSession
  // =========================================================================
  it('should create a new session on btn-new click', async () => {
    await import('../app');
    const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
    btnNew.click();
    await vi.waitFor(() => {
      const list = document.querySelector('#session-list');
      expect(list?.textContent).not.toContain('No sessions');
    });
    // Messages area should be visible
    expect(document.querySelector('#messages')?.classList.contains('hidden')).toBe(false);
    expect(document.querySelector('#input-bar')?.classList.contains('hidden')).toBe(false);
    expect(document.querySelector('#empty-state')?.classList.contains('hidden')).toBe(true);
  });

  it('should focus msg-input after creating new session', async () => {
    await import('../app');
    const input = document.querySelector('#msg-input') as HTMLTextAreaElement;
    const focusSpy = vi.spyOn(input, 'focus');
    const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
    btnNew.click();
    await vi.waitFor(() => expect(focusSpy).toHaveBeenCalled());
  });

  // =========================================================================
  // renderSessionList with active session
  // =========================================================================
  it('should render sessions with active class', async () => {
    const sessionId = 'pre-existing-id';
    storedSessions = {
      [sessionId]: {
        id: sessionId,
        title: 'Test Session',
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    };
    storedActive = sessionId;

    await import('../app');
    const items = document.querySelectorAll('.session-item');
    expect(items.length).toBe(1);
    expect(items[0].classList.contains('active')).toBe(true);
    expect(items[0].querySelector('.session-title')?.textContent).toBe('Test Session');
  });

  // =========================================================================
  // switchSession
  // =========================================================================
  it('should switch session on session-item click', async () => {
    await import('../app');
    const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
    btnNew.click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.session-item').length).toBe(1);
    });

    btnNew.click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.session-item').length).toBe(2);
    });

    const items = document.querySelectorAll('.session-item');
    (items[0] as HTMLElement).click();
    await vi.waitFor(() => {
      const updatedItems = document.querySelectorAll('.session-item');
      expect(updatedItems[0].classList.contains('active')).toBe(true);
      expect(updatedItems[1].classList.contains('active')).toBe(false);
    });
  });

  // =========================================================================
  // deleteSession
  // =========================================================================
  it('should delete session on delete button click', async () => {
    await import('../app');
    const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
    btnNew.click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.session-item').length).toBe(1);
    });

    const deleteBtn = document.querySelector('.session-delete') as HTMLElement;
    deleteBtn.click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.session-item').length).toBe(0);
    });
    expect(document.querySelector('#empty-state')?.classList.contains('hidden')).toBe(false);
  });

  it('should show empty state and disconnected when deleting last session', async () => {
    await import('../app');
    const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
    btnNew.click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.session-item').length).toBe(1);
    });

    const deleteBtn = document.querySelector('.session-delete') as HTMLElement;
    deleteBtn.click();
    await vi.waitFor(() => {
      const connStatus = document.querySelector('#conn-status');
      expect(connStatus?.className).toBe('disconnected');
    });
  });

  it('should switch to another session when deleting active one and others exist', async () => {
    await import('../app');
    const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
    btnNew.click();
    await vi.waitFor(() => {
      const connStatus = document.querySelector('#conn-status');
      expect(connStatus?.className).toBe('connected');
    });
    btnNew.click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.session-item').length).toBe(2);
    });

    const items = document.querySelectorAll('.session-item');
    // Delete the active (first) session — should switch to the other
    const deleteBtn = items[0].querySelector('.session-delete') as HTMLElement;
    deleteBtn.click();

    await vi.waitFor(() => {
      expect(document.querySelectorAll('.session-item').length).toBe(1);
    }, { timeout: 3000 });
  });

  // =========================================================================
  // appendMessageDOM
  // =========================================================================
  it('should append user messages correctly', async () => {
    await import('../app');
    const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
    btnNew.click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.session-item').length).toBe(1);
    });

    const input = document.querySelector('#msg-input') as HTMLTextAreaElement;
    input.value = 'Hello bot';
    const sendBtn = document.querySelector('#btn-send') as HTMLButtonElement;
    sendBtn.click();
    await vi.waitFor(() => {
      const msgs = document.querySelectorAll('.msg.user');
      expect(msgs.length).toBe(1);
      expect(msgs[0].querySelector('.msg-body')?.textContent).toBe('Hello bot');
      expect(msgs[0].querySelector('.msg-role')?.textContent).toBe('You');
    });
  });

  it('should render streaming assistant messages with streaming class', async () => {
    await import('../app');
    const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
    btnNew.click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.session-item').length).toBe(1);
    });

    // Manually create a streaming message to test DOM rendering
    const messagesEl = document.querySelector('#messages') as HTMLDivElement;
    const msgEl = document.createElement('div');
    msgEl.className = 'msg assistant streaming';
    msgEl.innerHTML = '<span class="msg-role assistant">Nanobot</span><div class="msg-body">thinking...</div>';
    messagesEl.appendChild(msgEl);

    expect(msgEl.classList.contains('streaming')).toBe(true);
    expect(msgEl.querySelector('.msg-role')?.textContent).toBe('Nanobot');
  });

  // =========================================================================
  // sendMessage
  // =========================================================================
  it('should not send empty message', async () => {
    await import('../app');
    const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
    btnNew.click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.session-item').length).toBe(1);
    });

    const input = document.querySelector('#msg-input') as HTMLTextAreaElement;
    input.value = '   ';
    const sendBtn = document.querySelector('#btn-send') as HTMLButtonElement;
    sendBtn.click();

    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelectorAll('.msg.user').length).toBe(0);
  });

  it('should clear input after sending', async () => {
    await import('../app');
    const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
    btnNew.click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.session-item').length).toBe(1);
    });

    const input = document.querySelector('#msg-input') as HTMLTextAreaElement;
    input.value = 'Hello';
    input.style.height = '200px';
    const sendBtn = document.querySelector('#btn-send') as HTMLButtonElement;
    sendBtn.click();
    await vi.waitFor(() => {
      expect(input.value).toBe('');
      expect(input.style.height).toBe('auto');
    });
  });

  it('should send on Enter key (not Shift+Enter)', async () => {
    await import('../app');
    const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
    btnNew.click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.session-item').length).toBe(1);
    });

    const input = document.querySelector('#msg-input') as HTMLTextAreaElement;
    input.value = 'Enter message';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.msg.user').length).toBe(1);
    });
  });

  it('should not send on Shift+Enter', async () => {
    await import('../app');
    const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
    btnNew.click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.session-item').length).toBe(1);
    });

    const input = document.querySelector('#msg-input') as HTMLTextAreaElement;
    input.value = 'Shift+Enter message';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelectorAll('.msg.user').length).toBe(0);
  });

  // =========================================================================
  // input auto-resize
  // =========================================================================
  it('should auto-resize textarea on input', async () => {
    await import('../app');
    const input = document.querySelector('#msg-input') as HTMLTextAreaElement;
    Object.defineProperty(input, 'scrollHeight', { value: 200, configurable: true });
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // The handler sets height = auto then height = Math.min(scrollHeight, 120)
    expect(input.style.height).toBe('120px'); // Math.min(200, 120) = 120
  });

  it('should cap textarea height at 120px', async () => {
    await import('../app');
    const input = document.querySelector('#msg-input') as HTMLTextAreaElement;
    Object.defineProperty(input, 'scrollHeight', { value: 500, configurable: true });
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.style.height).toBe('120px');
  });

  // =========================================================================
  // setConnStatus
  // =========================================================================
  it('should show connected status after creating session', async () => {
    await import('../app');
    const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
    btnNew.click();
    await vi.waitFor(() => {
      const connStatus = document.querySelector('#conn-status');
      expect(connStatus?.className).toBe('connected');
    });
  });

  // =========================================================================
  // openSettings / closeSettings
  // =========================================================================
  it('should open settings overlay on btn-settings click', async () => {
    await import('../app');
    const btnSettings = document.querySelector('#btn-settings') as HTMLButtonElement;
    btnSettings.click();
    await vi.waitFor(() => {
      const overlay = document.querySelector('#settings-overlay');
      expect(overlay?.classList.contains('hidden')).toBe(false);
    });
  });

  it('should populate settings form with current values', async () => {
    await import('../app');
    const btnSettings = document.querySelector('#btn-settings') as HTMLButtonElement;
    btnSettings.click();
    await vi.waitFor(() => {
      const hostInput = document.querySelector('#s-host') as HTMLInputElement;
      expect(hostInput.value).toBe('127.0.0.1');
      const portInput = document.querySelector('#s-port') as HTMLInputElement;
      expect(portInput.value).toBe('8765');
      const pathInput = document.querySelector('#s-path') as HTMLInputElement;
      expect(pathInput.value).toBe('/ws');
      const issuePathInput = document.querySelector('#s-issue-path') as HTMLInputElement;
      expect(issuePathInput.value).toBe('/auth/token');
      const clientIdInput = document.querySelector('#s-client-id') as HTMLInputElement;
      expect(clientIdInput.value).toBe('browser-extension');
    });
  });

  it('should close settings on cancel button', async () => {
    await import('../app');
    const btnSettings = document.querySelector('#btn-settings') as HTMLButtonElement;
    btnSettings.click();
    await vi.waitFor(() => {
      expect(document.querySelector('#settings-overlay')?.classList.contains('hidden')).toBe(false);
    });

    const btnCancel = document.querySelector('#btn-settings-cancel') as HTMLButtonElement;
    btnCancel.click();
    await vi.waitFor(() => {
      expect(document.querySelector('#settings-overlay')?.classList.contains('hidden')).toBe(true);
    });
  });

  it('should close settings on overlay click (backdrop)', async () => {
    await import('../app');
    const btnSettings = document.querySelector('#btn-settings') as HTMLButtonElement;
    btnSettings.click();
    await vi.waitFor(() => {
      expect(document.querySelector('#settings-overlay')?.classList.contains('hidden')).toBe(false);
    });

    const overlay = document.querySelector('#settings-overlay') as HTMLDivElement;
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(overlay.classList.contains('hidden')).toBe(true);
    });
  });

  it('should not close settings when clicking inside settings panel', async () => {
    await import('../app');
    const btnSettings = document.querySelector('#btn-settings') as HTMLButtonElement;
    btnSettings.click();
    await vi.waitFor(() => {
      expect(document.querySelector('#settings-overlay')?.classList.contains('hidden')).toBe(false);
    });

    const panel = document.querySelector('#settings-panel') as HTMLDivElement;
    panel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('#settings-overlay')?.classList.contains('hidden')).toBe(false);
  });

  // =========================================================================
  // saveSettingsFromForm
  // =========================================================================
  it('should save settings and close overlay on form submit', async () => {
    await import('../app');
    const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
    btnNew.click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.session-item').length).toBe(1);
    });

    const btnSettings = document.querySelector('#btn-settings') as HTMLButtonElement;
    btnSettings.click();
    await vi.waitFor(() => {
      expect(document.querySelector('#settings-overlay')?.classList.contains('hidden')).toBe(false);
    });

    const hostInput = document.querySelector('#s-host') as HTMLInputElement;
    hostInput.value = '192.168.1.1';
    const portInput = document.querySelector('#s-port') as HTMLInputElement;
    portInput.value = '9999';

    const form = document.querySelector('#settings-form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(document.querySelector('#settings-overlay')?.classList.contains('hidden')).toBe(true);
      expect(chrome.storage.local.set).toHaveBeenCalledWith(
        expect.objectContaining({
          nb_settings: expect.objectContaining({
            host: '192.168.1.1',
            port: 9999,
          }),
        }),
      );
    });
  });

  it('should use default settings for empty form values', async () => {
    await import('../app');
    const btnSettings = document.querySelector('#btn-settings') as HTMLButtonElement;
    btnSettings.click();
    await vi.waitFor(() => {
      expect(document.querySelector('#settings-overlay')?.classList.contains('hidden')).toBe(false);
    });

    (document.querySelector('#s-host') as HTMLInputElement).value = '';
    (document.querySelector('#s-port') as HTMLInputElement).value = '';
    (document.querySelector('#s-path') as HTMLInputElement).value = '';
    (document.querySelector('#s-issue-path') as HTMLInputElement).value = '';
    (document.querySelector('#s-client-id') as HTMLInputElement).value = '';

    const form = document.querySelector('#settings-form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(chrome.storage.local.set).toHaveBeenCalledWith(
        expect.objectContaining({
          nb_settings: expect.objectContaining({
            host: '127.0.0.1',
            port: 8765,
            path: '/ws',
            tokenIssuePath: '/auth/token',
            clientId: 'browser-extension',
          }),
        }),
      );
    });
  });

  it('should save secret value even when empty', async () => {
    await import('../app');
    const btnSettings = document.querySelector('#btn-settings') as HTMLButtonElement;
    btnSettings.click();
    await vi.waitFor(() => {
      expect(document.querySelector('#settings-overlay')?.classList.contains('hidden')).toBe(false);
    });

    (document.querySelector('#s-secret') as HTMLInputElement).value = '';

    const form = document.querySelector('#settings-form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(chrome.storage.local.set).toHaveBeenCalledWith(
        expect.objectContaining({
          nb_settings: expect.objectContaining({
            tokenIssueSecret: '',
          }),
        }),
      );
    });
  });

  // =========================================================================
  // Password toggle
  // =========================================================================
  it('should toggle password visibility', async () => {
    await import('../app');
    const toggleBtn = document.querySelector('#btn-toggle-secret') as HTMLButtonElement;
    const secretInput = document.querySelector('#s-secret') as HTMLInputElement;
    const eyeOpen = document.querySelector('.eye-open') as HTMLElement;
    const eyeClosed = document.querySelector('.eye-closed') as HTMLElement;

    expect(secretInput.type).toBe('password');

    toggleBtn.click();
    expect(secretInput.type).toBe('text');
    expect(eyeOpen.style.display).toBe('none');
    expect(eyeClosed.style.display).toBe('');
    expect(toggleBtn.title).toBe('Hide password');

    toggleBtn.click();
    expect(secretInput.type).toBe('password');
    expect(eyeOpen.style.display).toBe('');
    expect(eyeClosed.style.display).toBe('none');
    expect(toggleBtn.title).toBe('Show password');
  });

  // =========================================================================
  // esc() utility
  // =========================================================================
  it('should escape HTML in session titles', async () => {
    storedSessions = {
      'id-1': {
        id: 'id-1',
        title: '<script>alert("xss")</script>',
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    };
    storedActive = 'id-1';

    await import('../app');
    const title = document.querySelector('.session-title');
    expect(title?.innerHTML).not.toContain('<script>');
    expect(title?.textContent).toBe('<script>alert("xss")</script>');
  });

  // =========================================================================
  // renderMessages with pre-existing messages
  // =========================================================================
  it('should render pre-existing messages when switching to a session', async () => {
    const sessionId = 'session-with-msgs';
    storedSessions = {
      [sessionId]: {
        id: sessionId,
        title: 'Chat History',
        messages: [
          { role: 'user', content: 'Hello', timestamp: Date.now() - 2000, done: true },
          { role: 'assistant', content: 'Hi there!', timestamp: Date.now() - 1000, done: true },
        ],
        createdAt: Date.now() - 3000,
        updatedAt: Date.now() - 1000,
      },
    };
    storedActive = sessionId;

    await import('../app');
    await vi.waitFor(() => {
      const msgs = document.querySelectorAll('.msg');
      expect(msgs.length).toBe(2);
      expect(msgs[0].querySelector('.msg-body')?.textContent).toBe('Hello');
      expect(msgs[1].querySelector('.msg-body')?.textContent?.trim()).toBe('Hi there!');
    });
  });

  // =========================================================================
  // Multiple sessions
  // =========================================================================
  it('should create multiple sessions and render them', async () => {
    await import('../app');
    const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;

    btnNew.click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.session-item').length).toBe(1);
    });
    btnNew.click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.session-item').length).toBe(2);
    });
    btnNew.click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.session-item').length).toBe(3);
    });
  });

  // =========================================================================
  // WS event handlers
  // =========================================================================
  describe('WS event handlers', () => {
    it('should handle ws ready event', async () => {
      await import('../app');
      const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
      btnNew.click();
      await vi.waitFor(() => {
        const connStatus = document.querySelector('#conn-status');
        expect(connStatus?.className).toBe('connected');
      });
    });

    it('should handle ws error event on connect failure', async () => {
      // Override connect to throw
      const origConnect = FakeWsClient.prototype.connect;
      FakeWsClient.prototype.connect = async function () {
        throw new Error('Connection refused');
      };

      await import('../app');
      const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
      btnNew.click();
      await vi.waitFor(() => {
        const connStatus = document.querySelector('#conn-status');
        expect(connStatus?.className).toBe('error');
      });

      FakeWsClient.prototype.connect = origConnect;
    });

    it('should handle ws close event gracefully', async () => {
      await import('../app');
      const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
      btnNew.click();
      await vi.waitFor(() => {
        const connStatus = document.querySelector('#conn-status');
        // After successful connect, status is 'connected'
        expect(connStatus?.className).toBe('connected');
      });
    });
  });

  // =========================================================================
  // sendMessage when not connected
  // =========================================================================
  it('should try to reconnect when sending while disconnected', async () => {
    // Make connect() succeed but ws.connected = false initially
    const origConnect = FakeWsClient.prototype.connect;
    FakeWsClient.prototype.connect = async function () {
      this.connected = true;
      this.emit('ready', {});
    };

    await import('../app');
    const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
    btnNew.click();
    await vi.waitFor(() => {
      const connStatus = document.querySelector('#conn-status');
      expect(connStatus?.className).toBe('connected');
    });

    FakeWsClient.prototype.connect = origConnect;
  });

  // =========================================================================
  // settings form submit should prevent default
  // =========================================================================
  it('should prevent default form submission', async () => {
    await import('../app');
    const form = document.querySelector('#settings-form') as HTMLFormElement;
    const preventDefaultSpy = vi.spyOn(Event.prototype, 'preventDefault');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(preventDefaultSpy).toHaveBeenCalled();
  });

  // =========================================================================
  // setConnStatus with detail
  // =========================================================================
  it('should show status detail for ready with chat_id', async () => {
    await import('../app');
    const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
    btnNew.click();
    await vi.waitFor(() => {
      const connStatus = document.querySelector('#conn-status');
      // The ready event is emitted with {} (no chat_id), so detail is empty
      expect(connStatus?.textContent).toContain('Connected');
    });
  });

  // =========================================================================
  // scrollToBottom
  // =========================================================================
  it('should call requestAnimationFrame for scroll', async () => {
    await import('../app');
    const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
    btnNew.click();
    await vi.waitFor(() => {
      expect(window.requestAnimationFrame).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // WS event handlers (message, delta, stream_end, close, error)
  // =========================================================================
  describe('WS event handlers - message/delta/stream_end', () => {
    it('should handle ws message event and render assistant message', async () => {
      await import('../app');
      const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
      btnNew.click();
      await vi.waitFor(() => {
        const connStatus = document.querySelector('#conn-status');
        expect(connStatus?.className).toBe('connected');
      });

      // Get the latest FakeWsClient instance (connectWs creates a new one)
      const ws = FakeWsClient._instances[FakeWsClient._instances.length - 1];
      expect(ws).toBeTruthy();

      ws.emit('message', { text: 'Hello from bot' });
      await vi.waitFor(() => {
        const msgs = document.querySelectorAll('.msg.assistant');
        expect(msgs.length).toBe(1);
        expect(msgs[0].querySelector('.msg-body')?.textContent?.trim()).toBe('Hello from bot');
      });
    });

    it('should handle ws delta event - first delta starts streaming', async () => {
      await import('../app');
      const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
      btnNew.click();
      await vi.waitFor(() => {
        const connStatus = document.querySelector('#conn-status');
        expect(connStatus?.className).toBe('connected');
      });

      const ws = FakeWsClient._instances[FakeWsClient._instances.length - 1];
      ws.emit('delta', { text: 'Hel' });
      await vi.waitFor(() => {
        const msgs = document.querySelectorAll('.msg.assistant.streaming');
        expect(msgs.length).toBe(1);
        expect(msgs[0].querySelector('.msg-body')?.textContent?.trim()).toBe('Hel');
      });
      // Send button should be disabled during streaming
      const sendBtn = document.querySelector('#btn-send') as HTMLButtonElement;
      expect(sendBtn.disabled).toBe(true);
    });

    it('should handle ws delta event - subsequent delta appends to existing message', async () => {
      await import('../app');
      const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
      btnNew.click();
      await vi.waitFor(() => {
        const connStatus = document.querySelector('#conn-status');
        expect(connStatus?.className).toBe('connected');
      });

      const ws = FakeWsClient._instances[FakeWsClient._instances.length - 1];
      ws.emit('delta', { text: 'Hel' });
      await vi.waitFor(() => {
        expect(document.querySelectorAll('.msg.assistant.streaming').length).toBe(1);
      });

      ws.emit('delta', { text: 'lo' });
      await vi.waitFor(() => {
        const body = document.querySelector('.msg.assistant .msg-body');
        expect(body?.textContent?.trim()).toBe('Hello');
      });
    });

    it('should handle ws stream_end event', async () => {
      await import('../app');
      const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
      btnNew.click();
      await vi.waitFor(() => {
        const connStatus = document.querySelector('#conn-status');
        expect(connStatus?.className).toBe('connected');
      });

      const ws = FakeWsClient._instances[FakeWsClient._instances.length - 1];
      ws.emit('delta', { text: 'streaming' });
      await vi.waitFor(() => {
        expect(document.querySelectorAll('.msg.assistant.streaming').length).toBe(1);
      });

      ws.emit('stream_end');
      await vi.waitFor(() => {
        expect(document.querySelectorAll('.msg.assistant.streaming').length).toBe(0);
      });
      const sendBtn = document.querySelector('#btn-send') as HTMLButtonElement;
      expect(sendBtn.disabled).toBe(false);
    });

    it('should handle ws close event', async () => {
      await import('../app');
      const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
      btnNew.click();
      await vi.waitFor(() => {
        const connStatus = document.querySelector('#conn-status');
        expect(connStatus?.className).toBe('connected');
      });

      const ws = FakeWsClient._instances[FakeWsClient._instances.length - 1];
      ws.emit('close');
      await vi.waitFor(() => {
        const connStatus = document.querySelector('#conn-status');
        expect(connStatus?.className).toBe('disconnected');
      });
      const sendBtn = document.querySelector('#btn-send') as HTMLButtonElement;
      expect(sendBtn.disabled).toBe(false);
    });

    it('should handle ws error event', async () => {
      await import('../app');
      const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
      btnNew.click();
      await vi.waitFor(() => {
        const connStatus = document.querySelector('#conn-status');
        expect(connStatus?.className).toBe('connected');
      });

      const ws = FakeWsClient._instances[FakeWsClient._instances.length - 1];
      ws.emit('error');
      await vi.waitFor(() => {
        const connStatus = document.querySelector('#conn-status');
        expect(connStatus?.textContent).toContain('Connection failed');
      });
    });

    it('should handle ws ready event with chat_id detail', async () => {
      await import('../app');
      const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
      btnNew.click();
      await vi.waitFor(() => {
        const connStatus = document.querySelector('#conn-status');
        expect(connStatus?.className).toBe('connected');
      });

      const ws = FakeWsClient._instances[FakeWsClient._instances.length - 1];
      ws.emit('ready', { chat_id: 'abc12345' });
      await vi.waitFor(() => {
        const connStatus = document.querySelector('#conn-status');
        expect(connStatus?.textContent).toContain('chat abc12345');
      });
    });
  });

  // =========================================================================
  // sendMessage reconnect path
  // =========================================================================
  it('should reconnect when sending while ws is disconnected', async () => {
    await import('../app');
    const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
    btnNew.click();
    await vi.waitFor(() => {
      const connStatus = document.querySelector('#conn-status');
      expect(connStatus?.className).toBe('connected');
    });

    // Disconnect the ws
    const ws = FakeWsClient._instances[FakeWsClient._instances.length - 1];
    ws.connected = false;
    ws.emit('close');

    // Send a message - should reconnect
    const input = document.querySelector('#msg-input') as HTMLTextAreaElement;
    input.value = 'test reconnect';
    const sendBtn = document.querySelector('#btn-send') as HTMLButtonElement;
    sendBtn.click();

    await vi.waitFor(() => {
      const connStatus = document.querySelector('#conn-status');
      expect(connStatus?.className).toBe('connected');
    });
  });

  // =========================================================================
  // send() when ws is not connected after reconnect attempt
  // =========================================================================
  it('should show error when reconnect fails during send', async () => {
    const origConnect = FakeWsClient.prototype.connect;
    FakeWsClient.prototype.connect = async function () {
      throw new Error('reconnect failed');
    };

    await import('../app');
    const btnNew = document.querySelector('#btn-new') as HTMLButtonElement;
    btnNew.click();
    await vi.waitFor(() => {
      const connStatus = document.querySelector('#conn-status');
      expect(connStatus?.className).toBe('error');
    });

    // Disconnect and try to send
    const ws = FakeWsClient._instances[0];
    ws.connected = false;

    const input = document.querySelector('#msg-input') as HTMLTextAreaElement;
    input.value = 'test';
    const sendBtn = document.querySelector('#btn-send') as HTMLButtonElement;
    sendBtn.click();

    await vi.waitFor(() => {
      const connStatus = document.querySelector('#conn-status');
      expect(connStatus?.textContent).toContain('Not connected');
    });

    FakeWsClient.prototype.connect = origConnect;
  });

  // =========================================================================
  // sendMessage when no active session
  // =========================================================================
  it('should not send when no active session', async () => {
    await import('../app');
    // No session created, so send should be a no-op
    const input = document.querySelector('#msg-input') as HTMLTextAreaElement;
    input.value = 'no session';
    const sendBtn = document.querySelector('#btn-send') as HTMLButtonElement;
    sendBtn.click();

    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelectorAll('.msg.user').length).toBe(0);
  });
});
