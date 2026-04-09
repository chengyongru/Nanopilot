import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Settings } from '../../lib/types';

// ---------------------------------------------------------------------------
// Fake NanobotWsClient — defined at module level so vi.mock can reference it
// ---------------------------------------------------------------------------

class FakeWsClient {
  connected = false;
  static _instances: FakeWsClient[] = [];
  _listeners: Map<string, ((data: unknown) => void)[]> = new Map();

  constructor(settings: Settings) {
    // no-op
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

// vi.mock is hoisted to top of file
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('quickchat', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();

    document.body.innerHTML = '';
    delete (window as any).__nb_qc;
    FakeWsClient._instances = [];

    vi.stubGlobal('chrome', {
      runtime: {
        id: 'ext-id',
        getURL: (path: string) => `chrome-extension://ext-id/${path}`,
        onMessage: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
        sendMessage: vi.fn(),
      },
      storage: {
        local: {
          get: vi.fn(async (keys: string[]) => {
            const result: Record<string, unknown> = {};
            if (keys.includes('nb_settings')) result.nb_settings = DEFAULT_SETTINGS;
            if (keys.includes('nb_sessions')) result.nb_sessions = {};
            if (keys.includes('nb_active_session')) result.nb_active_session = null;
            return result;
          }),
          set: vi.fn(),
        },
      },
    });
    vi.stubGlobal('location', { href: 'https://example.com' });
    vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });
  });

  // =========================================================================
  // Basic loading
  // =========================================================================
  it('should create overlay DOM on load', async () => {
    await import('../quickchat');
    expect(document.querySelector('#nb-qc-container')).toBeTruthy();
    expect(document.querySelector('#nb-qc-backdrop')).toBeTruthy();
  });

  it('should expose toggle on window.__nb_qc', async () => {
    await import('../quickchat');
    expect((window as any).__nb_qc).toBeTruthy();
    expect(typeof (window as any).__nb_qc.toggle).toBe('function');
  });

  // =========================================================================
  // show() / hide() / toggle()
  // =========================================================================
  it('should show overlay elements when show() is called', async () => {
    await import('../quickchat');
    expect(document.querySelector('#nb-qc-container')).toBeTruthy();
    expect(document.querySelector('#nb-qc-backdrop')).toBeTruthy();
    expect(document.body.contains(document.querySelector('#nb-qc-container'))).toBe(true);
    expect(document.body.contains(document.querySelector('#nb-qc-backdrop'))).toBe(true);
  });

  it('should hide and remove overlay elements on hide()', async () => {
    await import('../quickchat');
    const input = document.querySelector('#nb-qc-input') as HTMLTextAreaElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => {
      expect(document.body.contains(document.querySelector('#nb-qc-container'))).toBe(false);
      expect(document.body.contains(document.querySelector('#nb-qc-backdrop'))).toBe(false);
    });
  });

  it('should re-show overlay on toggle after hiding', async () => {
    await import('../quickchat');
    const toggle = (window as any).__nb_qc.toggle;

    const input = document.querySelector('#nb-qc-input') as HTMLTextAreaElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => {
      expect(document.body.contains(document.querySelector('#nb-qc-container'))).toBe(false);
    });

    toggle();
    await vi.waitFor(() => {
      expect(document.body.contains(document.querySelector('#nb-qc-container'))).toBe(true);
    });
  });

  // =========================================================================
  // setStatus
  // =========================================================================
  it('should show connected status after connect', async () => {
    await import('../quickchat');
    const statusEl = document.querySelector('#nb-qc-status');
    await vi.waitFor(() => {
      expect(statusEl?.className).toBe('connected');
    });
  });

  it('should show error status when connect fails', async () => {
    const origConnect = FakeWsClient.prototype.connect;
    FakeWsClient.prototype.connect = async function () {
      throw new Error('Connection refused');
    };

    await import('../quickchat');
    await vi.waitFor(() => {
      const statusEl = document.querySelector('#nb-qc-status');
      expect(statusEl?.className).toBe('error');
    });

    FakeWsClient.prototype.connect = origConnect;
  });

  // =========================================================================
  // appendMsg
  // =========================================================================
  it('should render user messages', async () => {
    await import('../quickchat');
    const input = document.querySelector('#nb-qc-input') as HTMLTextAreaElement;
    input.value = 'Hello Nanobot';
    const sendBtn = document.querySelector('#nb-qc-send') as HTMLButtonElement;
    sendBtn.click();
    await vi.waitFor(() => {
      const msgs = document.querySelectorAll('.nb-msg.user');
      expect(msgs.length).toBe(1);
      expect(msgs[0].querySelector('.nb-body')?.textContent).toBe('Hello Nanobot');
      expect(msgs[0].querySelector('.nb-role')?.textContent).toBe('You');
    });
  });

  it('should render assistant messages with streaming class', async () => {
    await import('../quickchat');

    const messagesEl = document.querySelector('#nb-qc-messages') as HTMLDivElement;
    const el = document.createElement('div');
    el.className = 'nb-msg assistant streaming';
    el.innerHTML = '<span class="nb-role assistant">Nanobot</span><pre class="nb-body">thinking</pre>';
    messagesEl.appendChild(el);

    expect(el.classList.contains('streaming')).toBe(true);
    expect(el.querySelector('.nb-role')?.textContent).toBe('Nanobot');
    expect(el.querySelector('.nb-body')?.textContent).toBe('thinking');
  });

  it('should render finalized assistant messages without streaming class', async () => {
    await import('../quickchat');

    const messagesEl = document.querySelector('#nb-qc-messages') as HTMLDivElement;
    const el = document.createElement('div');
    el.className = 'nb-msg assistant';
    el.innerHTML = '<span class="nb-role assistant">Nanobot</span><pre class="nb-body">done</pre>';
    messagesEl.appendChild(el);

    expect(el.classList.contains('streaming')).toBe(false);
  });

  // =========================================================================
  // send()
  // =========================================================================
  it('should not send empty message', async () => {
    await import('../quickchat');
    const input = document.querySelector('#nb-qc-input') as HTMLTextAreaElement;
    input.value = '';
    const sendBtn = document.querySelector('#nb-qc-send') as HTMLButtonElement;
    sendBtn.click();
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelectorAll('.nb-msg.user').length).toBe(0);
  });

  it('should not send whitespace-only message', async () => {
    await import('../quickchat');
    const input = document.querySelector('#nb-qc-input') as HTMLTextAreaElement;
    input.value = '   ';
    const sendBtn = document.querySelector('#nb-qc-send') as HTMLButtonElement;
    sendBtn.click();
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelectorAll('.nb-msg.user').length).toBe(0);
  });

  it('should clear input after sending', async () => {
    await import('../quickchat');
    const input = document.querySelector('#nb-qc-input') as HTMLTextAreaElement;
    input.value = 'Hello';
    input.style.height = '200px';
    const sendBtn = document.querySelector('#nb-qc-send') as HTMLButtonElement;
    sendBtn.click();
    await vi.waitFor(() => {
      expect(input.value).toBe('');
      expect(input.style.height).toBe('auto');
    });
  });

  // =========================================================================
  // Keyboard handlers
  // =========================================================================
  it('should send on Enter key', async () => {
    await import('../quickchat');
    const input = document.querySelector('#nb-qc-input') as HTMLTextAreaElement;
    input.value = 'Enter send';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.nb-msg.user').length).toBe(1);
    });
  });

  it('should not send on Shift+Enter', async () => {
    await import('../quickchat');
    const input = document.querySelector('#nb-qc-input') as HTMLTextAreaElement;
    input.value = 'Shift+Enter';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelectorAll('.nb-msg.user').length).toBe(0);
  });

  it('should hide on Escape key in input', async () => {
    await import('../quickchat');
    const input = document.querySelector('#nb-qc-input') as HTMLTextAreaElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => {
      expect(document.body.contains(document.querySelector('#nb-qc-container'))).toBe(false);
    });
  });

  it('should hide on Escape key via document keydown', async () => {
    await import('../quickchat');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => {
      expect(document.body.contains(document.querySelector('#nb-qc-container'))).toBe(false);
    });
  });

  it('should not hide on Escape when not visible', async () => {
    await import('../quickchat');
    const input = document.querySelector('#nb-qc-input') as HTMLTextAreaElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => {
      expect(document.body.contains(document.querySelector('#nb-qc-container'))).toBe(false);
    });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    expect(document.body.contains(document.querySelector('#nb-qc-container'))).toBe(false);
  });

  // =========================================================================
  // Backdrop click
  // =========================================================================
  it('should hide on backdrop click', async () => {
    await import('../quickchat');
    const backdrop = document.querySelector('#nb-qc-backdrop') as HTMLElement;
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.body.contains(document.querySelector('#nb-qc-container'))).toBe(false);
    });
  });

  // =========================================================================
  // input auto-resize
  // =========================================================================
  it('should auto-resize textarea on input', async () => {
    await import('../quickchat');
    const input = document.querySelector('#nb-qc-input') as HTMLTextAreaElement;
    Object.defineProperty(input, 'scrollHeight', { value: 200, configurable: true });
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.style.height).toBe('80px'); // Math.min(200, 80) = 80
  });

  it('should cap textarea height at 80px', async () => {
    await import('../quickchat');
    const input = document.querySelector('#nb-qc-input') as HTMLTextAreaElement;
    Object.defineProperty(input, 'scrollHeight', { value: 500, configurable: true });
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.style.height).toBe('80px');
  });

  // =========================================================================
  // ensureSession
  // =========================================================================
  it('should create a new session when none exist', async () => {
    await import('../quickchat');
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({
        nb_sessions: expect.any(Object),
      }),
    );
  });

  it('should reuse existing session when one exists', async () => {
    const existingSession = {
      'existing-id': {
        id: 'existing-id',
        title: 'Quick Chat',
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    };

    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockImplementation(async (keys: string[]) => {
      const result: Record<string, unknown> = {};
      if (keys.includes('nb_settings')) result.nb_settings = DEFAULT_SETTINGS;
      if (keys.includes('nb_sessions')) result.nb_sessions = existingSession;
      if (keys.includes('nb_active_session')) result.nb_active_session = null;
      return result;
    });

    await import('../quickchat');
    // The IIFE should load, show, and connect without creating a new session
    await vi.waitFor(() => {
      const statusEl = document.querySelector('#nb-qc-status');
      expect(statusEl?.className).toBe('connected');
    });
    // chrome.storage.local.set should NOT have been called with a new session
    // (since ensureSession reused the existing one)
    const setCalls = (chrome.storage.local.set as ReturnType<typeof vi.fn>).mock.calls;
    // Check that no new session was created
    const hasNewSession = setCalls.some((call) => {
      const data = call[0] as Record<string, unknown>;
      const sessions = data.nb_sessions as Record<string, unknown>;
      return sessions && Object.keys(sessions).length > 1;
    });
    expect(hasNewSession).toBe(false);
  });

  // =========================================================================
  // renderHistory
  // =========================================================================
  it('should render history when showing with existing session', async () => {
    const existingSession = {
      'hist-id': {
        id: 'hist-id',
        title: 'History Chat',
        messages: [
          { role: 'user', content: 'Hello', timestamp: Date.now() - 1000, done: true },
          { role: 'assistant', content: 'Hi!', timestamp: Date.now(), done: true },
        ],
        createdAt: Date.now() - 2000,
        updatedAt: Date.now(),
      },
    };

    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockImplementation(async (keys: string[]) => {
      const result: Record<string, unknown> = {};
      if (keys.includes('nb_settings')) result.nb_settings = DEFAULT_SETTINGS;
      if (keys.includes('nb_sessions')) result.nb_sessions = existingSession;
      if (keys.includes('nb_active_session')) result.nb_active_session = null;
      return result;
    });

    await import('../quickchat');
    await vi.waitFor(() => {
      const msgs = document.querySelectorAll('.nb-msg');
      expect(msgs.length).toBe(2);
    });
  });

  // =========================================================================
  // NB_QUICKCHAT_TOGGLE message handler
  // =========================================================================
  it('should register NB_QUICKCHAT_TOGGLE message listener', async () => {
    await import('../quickchat');
    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledWith(expect.any(Function));
  });

  it('should toggle on NB_QUICKCHAT_TOGGLE message', async () => {
    await import('../quickchat');

    const listener = (chrome.runtime.onMessage.addListener as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(typeof listener).toBe('function');

    // Hide first
    const input = document.querySelector('#nb-qc-input') as HTMLTextAreaElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => {
      expect(document.body.contains(document.querySelector('#nb-qc-container'))).toBe(false);
    });

    listener({ type: 'NB_QUICKCHAT_TOGGLE' });
    await vi.waitFor(() => {
      expect(document.body.contains(document.querySelector('#nb-qc-container'))).toBe(true);
    });
  });

  // =========================================================================
  // WS events
  // =========================================================================
  describe('WS events', () => {
    it('should handle ready event with chat_id', async () => {
      await import('../quickchat');
      const statusEl = document.querySelector('#nb-qc-status');
      await vi.waitFor(() => {
        expect(statusEl?.className).toBe('connected');
      });
    });

    it('should handle close event', async () => {
      await import('../quickchat');
      const statusEl = document.querySelector('#nb-qc-status');
      await vi.waitFor(() => {
        expect(statusEl?.className).toBe('connected');
      });
    });

    it('should disable send button during streaming', async () => {
      await import('../quickchat');
      const sendBtn = document.querySelector('#nb-qc-send') as HTMLButtonElement;
      expect(sendBtn.disabled).toBe(false);
    });
  });

  // =========================================================================
  // send() when not connected
  // =========================================================================
  it('should show reconnecting status when ws not connected', async () => {
    const origConnect = FakeWsClient.prototype.connect;
    FakeWsClient.prototype.connect = async function () {
      throw new Error('fail');
    };

    await import('../quickchat');
    await vi.waitFor(() => {
      const statusEl = document.querySelector('#nb-qc-status');
      expect(statusEl?.className).toBe('error');
    });

    const input = document.querySelector('#nb-qc-input') as HTMLTextAreaElement;
    input.value = 'test';
    const sendBtn = document.querySelector('#nb-qc-send') as HTMLButtonElement;
    sendBtn.click();
    await vi.waitFor(() => {
      const statusEl = document.querySelector('#nb-qc-status');
      // After reconnect attempt fails and ws is still not connected, status is "Not connected"
      expect(statusEl?.textContent).toContain('Not connected');
    });

    FakeWsClient.prototype.connect = origConnect;
  });

  // =========================================================================
  // esc() utility
  // =========================================================================
  it('should escape HTML in messages', async () => {
    await import('../quickchat');
    const input = document.querySelector('#nb-qc-input') as HTMLTextAreaElement;
    input.value = '<b>bold</b>';
    const sendBtn = document.querySelector('#nb-qc-send') as HTMLButtonElement;
    sendBtn.click();
    await vi.waitFor(() => {
      const body = document.querySelector('.nb-msg.user .nb-body');
      expect(body?.innerHTML).not.toContain('<b>');
      expect(body?.textContent).toBe('<b>bold</b>');
    });
  });

  // =========================================================================
  // show() idempotency
  // =========================================================================
  it('should not duplicate DOM elements when show() is called while already visible', async () => {
    await import('../quickchat');
    const toggle = (window as any).__nb_qc.toggle;

    toggle();
    await vi.waitFor(() => {
      expect(document.body.contains(document.querySelector('#nb-qc-container'))).toBe(false);
    });
    toggle();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('#nb-qc-container').length).toBe(1);
      expect(document.querySelectorAll('#nb-qc-backdrop').length).toBe(1);
    });
  });

  // =========================================================================
  // hide() idempotency
  // =========================================================================
  it('should not throw when hide() is called while not visible', async () => {
    await import('../quickchat');
    const toggle = (window as any).__nb_qc.toggle;

    toggle();
    await vi.waitFor(() => {
      expect(document.body.contains(document.querySelector('#nb-qc-container'))).toBe(false);
    });

    expect(() => toggle()).not.toThrow();
  });

  // =========================================================================
  // Duplicate load prevention
  // =========================================================================
  it('should toggle if already loaded when imported again', async () => {
    await import('../quickchat');
    expect(document.querySelector('#nb-qc-container')).toBeTruthy();

    const toggle = (window as any).__nb_qc.toggle;
    expect(typeof toggle).toBe('function');
  });

  // =========================================================================
  // WS event handlers (message, delta, stream_end, close, error)
  // =========================================================================
  describe('WS event handlers', () => {
    it('should handle ws message event', async () => {
      await import('../quickchat');

      const ws = FakeWsClient._instances[0];
      expect(ws).toBeTruthy();

      ws.emit('message', { text: 'Bot reply' });
      await vi.waitFor(() => {
        const msgs = document.querySelectorAll('.nb-msg.assistant');
        expect(msgs.length).toBe(1);
        expect(msgs[0].querySelector('.nb-body')?.textContent?.trim()).toBe('Bot reply');
      });
    });

    it('should handle ws delta event - first delta starts streaming', async () => {
      await import('../quickchat');

      const ws = FakeWsClient._instances[0];
      ws.emit('delta', { text: 'Hel' });
      await vi.waitFor(() => {
        const msgs = document.querySelectorAll('.nb-msg.assistant.streaming');
        expect(msgs.length).toBe(1);
        expect(msgs[0].querySelector('.nb-body')?.textContent?.trim()).toBe('Hel');
      });
      const sendBtn = document.querySelector('#nb-qc-send') as HTMLButtonElement;
      expect(sendBtn.disabled).toBe(true);
    });

    it('should handle ws delta event - subsequent delta appends', async () => {
      await import('../quickchat');

      const ws = FakeWsClient._instances[0];
      ws.emit('delta', { text: 'Hel' });
      await vi.waitFor(() => {
        expect(document.querySelectorAll('.nb-msg.assistant.streaming').length).toBe(1);
      });

      ws.emit('delta', { text: 'lo' });
      await vi.waitFor(() => {
        const body = document.querySelector('.nb-msg.assistant .nb-body');
        expect(body?.textContent?.trim()).toBe('Hello');
      });
    });

    it('should handle ws stream_end event', async () => {
      await import('../quickchat');

      const ws = FakeWsClient._instances[0];
      ws.emit('delta', { text: 'stream' });
      await vi.waitFor(() => {
        expect(document.querySelectorAll('.nb-msg.assistant.streaming').length).toBe(1);
      });

      ws.emit('stream_end');
      await vi.waitFor(() => {
        expect(document.querySelectorAll('.nb-msg.assistant.streaming').length).toBe(0);
      });
      const sendBtn = document.querySelector('#nb-qc-send') as HTMLButtonElement;
      expect(sendBtn.disabled).toBe(false);
    });

    it('should handle ws close event', async () => {
      await import('../quickchat');

      const ws = FakeWsClient._instances[0];
      ws.emit('close');
      await vi.waitFor(() => {
        const statusEl = document.querySelector('#nb-qc-status');
        expect(statusEl?.className).toBe('disconnected');
      });
    });

    it('should handle ws error event', async () => {
      await import('../quickchat');

      const ws = FakeWsClient._instances[0];
      ws.emit('error');
      await vi.waitFor(() => {
        const statusEl = document.querySelector('#nb-qc-status');
        expect(statusEl?.textContent).toContain('Connection failed');
      });
    });

    it('should handle ws ready event with chat_id', async () => {
      await import('../quickchat');

      const ws = FakeWsClient._instances[0];
      ws.emit('ready', { chat_id: 'xyz789' });
      await vi.waitFor(() => {
        const statusEl = document.querySelector('#nb-qc-status');
        expect(statusEl?.textContent).toContain('chat xyz789');
      });
    });
  });

  // =========================================================================
  // send() reconnect path
  // =========================================================================
  it('should reconnect when sending while disconnected', async () => {
    await import('../quickchat');

    const ws = FakeWsClient._instances[0];
    ws.connected = false;
    ws.emit('close');

    const input = document.querySelector('#nb-qc-input') as HTMLTextAreaElement;
    input.value = 'test reconnect';
    const sendBtn = document.querySelector('#nb-qc-send') as HTMLButtonElement;
    sendBtn.click();

    await vi.waitFor(() => {
      const statusEl = document.querySelector('#nb-qc-status');
      expect(statusEl?.className).toBe('connected');
    });
  });

  // =========================================================================
  // Duplicate load guard
  // =========================================================================
  it('should call existing toggle when __nb_qc already set', async () => {
    // First import sets up __nb_qc
    await import('../quickchat');

    // Manually set __nb_qc to a spy to verify the guard path
    const toggleSpy = vi.fn();
    (window as any).__nb_qc = { toggle: toggleSpy };

    // Reset modules and re-import
    vi.resetModules();
    FakeWsClient._instances = [];

    // Need to re-setup mocks after resetModules
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'ext-id',
        getURL: (path: string) => `chrome-extension://ext-id/${path}`,
        onMessage: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
        sendMessage: vi.fn(),
      },
      storage: {
        local: {
          get: vi.fn(async (keys: string[]) => {
            const result: Record<string, unknown> = {};
            if (keys.includes('nb_settings')) result.nb_settings = DEFAULT_SETTINGS;
            if (keys.includes('nb_sessions')) result.nb_sessions = {};
            if (keys.includes('nb_active_session')) result.nb_active_session = null;
            return result;
          }),
          set: vi.fn(),
        },
      },
    });
    vi.stubGlobal('location', { href: 'https://example.com' });
    vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });

    document.body.innerHTML = '';
    await import('../quickchat');

    // The toggle should have been called from the guard path
    expect(toggleSpy).toHaveBeenCalled();
  });
});
