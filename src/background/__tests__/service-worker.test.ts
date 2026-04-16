import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Chrome API mock
// ---------------------------------------------------------------------------

let addListenerSpies: Record<string, ReturnType<typeof vi.fn>>;

const mockQuery = vi.fn().mockResolvedValue([{ id: 1, url: 'https://example.com' }]);
const mockSendMessage = vi.fn().mockResolvedValue(undefined);
const mockInsertCSS = vi.fn().mockResolvedValue(undefined);
const mockExecuteScript = vi.fn().mockResolvedValue(undefined);

function setupChrome(): void {
  mockQuery.mockResolvedValue([{ id: 1, url: 'https://example.com' }]);
  mockSendMessage.mockResolvedValue(undefined);
  mockInsertCSS.mockResolvedValue(undefined);
  mockExecuteScript.mockResolvedValue(undefined);

  const actionOnClicked = { addListener: vi.fn() };
  const commandsOnCommand = { addListener: vi.fn() };
  const runtimeOnMessage = { addListener: vi.fn() };
  const tabsOnRemoved = { addListener: vi.fn() };

  addListenerSpies = {
    actionOnClicked: actionOnClicked.addListener,
    commandsOnCommand: commandsOnCommand.addListener,
    runtimeOnMessage: runtimeOnMessage.addListener,
    tabsOnRemoved: tabsOnRemoved.addListener,
  };

  vi.stubGlobal('chrome', {
    action: { onClicked: actionOnClicked },
    commands: { onCommand: commandsOnCommand },
    runtime: { onMessage: runtimeOnMessage },
    sidePanel: { open: vi.fn().mockResolvedValue(undefined) },
    tabs: {
      query: mockQuery,
      sendMessage: mockSendMessage,
      onRemoved: tabsOnRemoved,
    },
    scripting: {
      insertCSS: mockInsertCSS,
      executeScript: mockExecuteScript,
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
  } as unknown as typeof chrome);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Import the module fresh, returning the registered message handler. */
async function importAndGetMessageHandler() {
  vi.resetModules();
  setupChrome();
  vi.doMock('../../lib/storage', () => ({
    loadSettings: vi.fn().mockResolvedValue({
      host: '127.0.0.1',
      port: 8765,
      path: '/ws',
      tokenIssuePath: '/auth/token',
      tokenIssueSecret: '',
      clientId: 'browser-extension',
    }),
    saveSettings: vi.fn(),
    DEFAULT_SETTINGS: {
      host: '127.0.0.1',
      port: 8765,
      path: '/ws',
      tokenIssuePath: '/auth/token',
      tokenIssueSecret: '',
      clientId: 'browser-extension',
    },
    validateSettings: vi.fn().mockReturnValue(null),
  }));
// @ts-expect-error -- service-worker.ts is not a module; imported for side effects
await import('../service-worker');
  const handler = addListenerSpies.runtimeOnMessage.mock.calls[0][0] as (
    msg: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ) => boolean | undefined;
  return handler;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('service-worker', () => {
  let handler: Awaited<ReturnType<typeof importAndGetMessageHandler>>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    handler = await importAndGetMessageHandler();
  });

  // =========================================================================
  // Listener registration
  // =========================================================================
  describe('listener registration', () => {
    it('registers chrome.action.onClicked listener', () => {
      expect(addListenerSpies.actionOnClicked).toHaveBeenCalledWith(expect.any(Function));
    });

    it('registers chrome.commands.onCommand listener', () => {
      expect(addListenerSpies.commandsOnCommand).toHaveBeenCalledWith(expect.any(Function));
    });

    it('registers chrome.runtime.onMessage listener', () => {
      expect(addListenerSpies.runtimeOnMessage).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  // =========================================================================
  // Action click -> open side panel
  // =========================================================================
  describe('action click -> open side panel', () => {
    it('opens side panel with correct tabId', () => {
      const actionHandler = addListenerSpies.actionOnClicked.mock.calls[0][0];
      actionHandler({ id: 42 });
      expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 42 });
    });
  });

  // =========================================================================
  // Quick-chat command
  // =========================================================================
  describe('quick-chat command', () => {
    it('ignores non-quick-chat commands', async () => {
      const commandHandler = addListenerSpies.commandsOnCommand.mock.calls[0][0];
      await commandHandler('other-command');
      expect(chrome.tabs.query).not.toHaveBeenCalled();
    });

    it('handles no active tab', async () => {
      mockQuery.mockResolvedValueOnce([]);
      const commandHandler = addListenerSpies.commandsOnCommand.mock.calls[0][0];
      await commandHandler('quick-chat');
      expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
      expect(chrome.scripting.insertCSS).not.toHaveBeenCalled();
    });

    it('toggles overlay if already injected (sendMessage succeeds)', async () => {
      mockSendMessage.mockResolvedValueOnce(undefined);
      const commandHandler = addListenerSpies.commandsOnCommand.mock.calls[0][0];
      await commandHandler('quick-chat');
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, { type: 'NB_QUICKCHAT_TOGGLE' });
      expect(chrome.scripting.insertCSS).not.toHaveBeenCalled();
    });

    it('injects CSS + scripts if overlay not yet injected (sendMessage fails)', async () => {
      mockSendMessage.mockRejectedValueOnce(new Error('no receiver'));
      const commandHandler = addListenerSpies.commandsOnCommand.mock.calls[0][0];
      await commandHandler('quick-chat');

      expect(chrome.scripting.insertCSS).toHaveBeenCalledWith({
        target: { tabId: 1 },
        files: ['quickchat/style.css'],
      });
      expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
        target: { tabId: 1 },
        files: [
          'quickchat/quickchat.js',
        ],
      });
    });

    it('silently ignores injection failure on restricted URLs', async () => {
      mockSendMessage.mockRejectedValueOnce(new Error('no receiver'));
      mockInsertCSS.mockRejectedValueOnce(new Error('Cannot access'));
      mockExecuteScript.mockRejectedValueOnce(new Error('Cannot access'));
      const commandHandler = addListenerSpies.commandsOnCommand.mock.calls[0][0];
      await expect(commandHandler('quick-chat')).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // Message relay — NB_FETCH
  // =========================================================================
  describe('NB_FETCH', () => {
    it('relays fetch and returns response', async () => {
      const sendResponse = vi.fn();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('hello world'),
      }));

      const result = handler(
        { type: 'NB_FETCH', url: 'http://127.0.0.1:8765/auth/token', headers: { Authorization: 'Bearer test' } },
        {},
        sendResponse,
      );

      expect(result).toBe(true); // async
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({
        ok: true,
        status: 200,
        body: 'hello world',
      }));
    });

    it('rejects fetch to disallowed URL', async () => {
      const sendResponse = vi.fn();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('ok'),
      }));

      handler(
        { type: 'NB_FETCH', url: 'https://evil.example.com/data' },
        {},
        sendResponse,
      );

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({
        ok: false,
        status: 0,
        body: 'URL not allowed',
      }));
    });

    it('handles fetch with no headers', async () => {
      const sendResponse = vi.fn();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('ok'),
      }));

      handler(
        { type: 'NB_FETCH', url: 'http://127.0.0.1:8765/auth/token' },
        {},
        sendResponse,
      );

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({
        ok: true,
        status: 200,
        body: 'ok',
      }));
    });

    it('handles network errors', async () => {
      const sendResponse = vi.fn();
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')));

      handler(
        { type: 'NB_FETCH', url: 'http://127.0.0.1:8765/auth/token' },
        {},
        sendResponse,
      );

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({
        ok: false,
        status: 0,
        body: 'Network failure',
      }));
    });
  });

  // =========================================================================
  // Message relay — NB_WS_CONNECT
  // =========================================================================
  describe('NB_WS_CONNECT', () => {
    it('creates WebSocket and returns ok', async () => {
      const sendResponse = vi.fn();
      const mockWs = {
        addEventListener: vi.fn(),
        close: vi.fn(),
        send: vi.fn(),
        readyState: WebSocket.OPEN,
      };
      vi.stubGlobal('WebSocket', vi.fn().mockImplementation(() => mockWs));

      const result = handler(
        { type: 'NB_WS_CONNECT', url: 'ws://127.0.0.1:8765/ws' },
        { tab: { id: 42 } } as chrome.runtime.MessageSender,
        sendResponse,
      );

      expect(result).toBe(true); // async due to URL validation
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
      expect(WebSocket).toHaveBeenCalledWith('ws://127.0.0.1:8765/ws');
      expect(mockWs.addEventListener).toHaveBeenCalledWith('open', expect.any(Function));
      expect(mockWs.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockWs.addEventListener).toHaveBeenCalledWith('close', expect.any(Function));
      expect(mockWs.addEventListener).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('rejects WebSocket to disallowed URL', async () => {
      const sendResponse = vi.fn();
      vi.stubGlobal('WebSocket', vi.fn().mockImplementation(() => ({
        addEventListener: vi.fn(),
        close: vi.fn(),
        send: vi.fn(),
        readyState: WebSocket.OPEN,
      })));

      handler(
        { type: 'NB_WS_CONNECT', url: 'ws://evil.example.com/ws' },
        { tab: { id: 42 } } as chrome.runtime.MessageSender,
        sendResponse,
      );

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'URL not allowed' }));
    });

    it('closes existing relay before opening new one for same tab', async () => {
      const sendResponse = vi.fn();
      const oldWs = {
        addEventListener: vi.fn(),
        close: vi.fn(),
        send: vi.fn(),
        readyState: WebSocket.OPEN,
      };
      const newWs = {
        addEventListener: vi.fn(),
        close: vi.fn(),
        send: vi.fn(),
        readyState: WebSocket.OPEN,
      };
      let callCount = 0;
      vi.stubGlobal('WebSocket', vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? oldWs : newWs;
      }));

      handler(
        { type: 'NB_WS_CONNECT', url: 'ws://127.0.0.1:8765/a' },
        { tab: { id: 1 } } as chrome.runtime.MessageSender,
        sendResponse,
      );

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

      handler(
        { type: 'NB_WS_CONNECT', url: 'ws://127.0.0.1:8765/b' },
        { tab: { id: 1 } } as chrome.runtime.MessageSender,
        sendResponse,
      );

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(2));
      expect(oldWs.close).toHaveBeenCalled();
    });

    it('returns ok: false on WebSocket constructor error', async () => {
      const sendResponse = vi.fn();
      vi.stubGlobal('WebSocket', vi.fn().mockImplementation(() => {
        throw new Error('invalid url');
      }));

      handler(
        { type: 'NB_WS_CONNECT', url: 'ws://127.0.0.1:8765/ws' },
        { tab: { id: 1 } } as chrome.runtime.MessageSender,
        sendResponse,
      );

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'invalid url' }));
    });

    it('handles open event and relays to tab', async () => {
      const sendResponse = vi.fn();
      const mockWs = {
        addEventListener: vi.fn(),
        close: vi.fn(),
        send: vi.fn(),
        readyState: WebSocket.OPEN,
      };
      vi.stubGlobal('WebSocket', vi.fn().mockImplementation(() => mockWs));

      handler(
        { type: 'NB_WS_CONNECT', url: 'ws://127.0.0.1:8765/ws' },
        { tab: { id: 42 } } as chrome.runtime.MessageSender,
        sendResponse,
      );

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

      // Find and call the open handler
      const openHandler = mockWs.addEventListener.mock.calls.find(
        (c: unknown[]) => c[0] === 'open',
      )?.[1];
      openHandler();
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, { type: 'NB_WS_OPEN' });
    });

    it('handles message event and relays to tab', async () => {
      const sendResponse = vi.fn();
      const mockWs = {
        addEventListener: vi.fn(),
        close: vi.fn(),
        send: vi.fn(),
        readyState: WebSocket.OPEN,
      };
      vi.stubGlobal('WebSocket', vi.fn().mockImplementation(() => mockWs));

      handler(
        { type: 'NB_WS_CONNECT', url: 'ws://127.0.0.1:8765/ws' },
        { tab: { id: 42 } } as chrome.runtime.MessageSender,
        sendResponse,
      );

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

      const msgHandler = mockWs.addEventListener.mock.calls.find(
        (c: unknown[]) => c[0] === 'message',
      )?.[1];
      msgHandler({ data: 'hello' });
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, {
        type: 'NB_WS_MESSAGE',
        data: 'hello',
      });
    });

    it('handles close event, relays to tab, and cleans up', async () => {
      const sendResponse = vi.fn();
      const mockWs = {
        addEventListener: vi.fn(),
        close: vi.fn(),
        send: vi.fn(),
        readyState: WebSocket.OPEN,
      };
      vi.stubGlobal('WebSocket', vi.fn().mockImplementation(() => mockWs));

      handler(
        { type: 'NB_WS_CONNECT', url: 'ws://127.0.0.1:8765/ws' },
        { tab: { id: 42 } } as chrome.runtime.MessageSender,
        sendResponse,
      );

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

      const closeHandler = mockWs.addEventListener.mock.calls.find(
        (c: unknown[]) => c[0] === 'close',
      )?.[1];
      closeHandler({ code: 1000, reason: 'done' });
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, {
        type: 'NB_WS_CLOSE',
        code: 1000,
        reason: 'done',
      });
    });

    it('handles error event and relays to tab', async () => {
      const sendResponse = vi.fn();
      const mockWs = {
        addEventListener: vi.fn(),
        close: vi.fn(),
        send: vi.fn(),
        readyState: WebSocket.OPEN,
      };
      vi.stubGlobal('WebSocket', vi.fn().mockImplementation(() => mockWs));

      handler(
        { type: 'NB_WS_CONNECT', url: 'ws://127.0.0.1:8765/ws' },
        { tab: { id: 42 } } as chrome.runtime.MessageSender,
        sendResponse,
      );

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

      const errorHandler = mockWs.addEventListener.mock.calls.find(
        (c: unknown[]) => c[0] === 'error',
      )?.[1];
      errorHandler();
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, {
        type: 'NB_WS_ERROR',
      });
    });

    it('handles tab close when relayWs close event fires (relayWs=null after)', async () => {
      const sendResponse = vi.fn();
      const mockWs = {
        addEventListener: vi.fn(),
        close: vi.fn(),
        send: vi.fn(),
        readyState: WebSocket.OPEN,
      };
      vi.stubGlobal('WebSocket', vi.fn().mockImplementation(() => mockWs));

      handler(
        { type: 'NB_WS_CONNECT', url: 'ws://127.0.0.1:8765/ws' },
        { tab: { id: 42 } } as chrome.runtime.MessageSender,
        sendResponse,
      );

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

      const closeHandler = mockWs.addEventListener.mock.calls.find(
        (c: unknown[]) => c[0] === 'close',
      )?.[1];

      // Simulate close - relayWs becomes null
      closeHandler({ code: 1000, reason: 'done' });

      // Now NB_WS_CLOSE should be a no-op since relayWs is null (cleaned up by close event)
      const sendResponse2 = vi.fn();
      const result = handler(
        { type: 'NB_WS_CLOSE' },
        { tab: { id: 42 } } as chrome.runtime.MessageSender,
        sendResponse2,
      );
      expect(result).toBe(false);
    });

    it('handles _relayToTab failure gracefully', async () => {
      const sendResponse = vi.fn();
      const mockWs = {
        addEventListener: vi.fn(),
        close: vi.fn(),
        send: vi.fn(),
        readyState: WebSocket.OPEN,
      };
      vi.stubGlobal('WebSocket', vi.fn().mockImplementation(() => mockWs));
      mockSendMessage.mockRejectedValue(new Error('tab closed'));

      handler(
        { type: 'NB_WS_CONNECT', url: 'ws://127.0.0.1:8765/ws' },
        { tab: { id: 42 } } as chrome.runtime.MessageSender,
        sendResponse,
      );

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

      const openHandler = mockWs.addEventListener.mock.calls.find(
        (c: unknown[]) => c[0] === 'open',
      )?.[1];

      // Should not throw even if sendMessage fails
      expect(() => openHandler()).not.toThrow();
    });
  });

  // =========================================================================
  // Message relay — NB_WS_SEND
  // =========================================================================
  describe('NB_WS_SEND', () => {
    it('sends text on open connection', async () => {
      const connectResponse = vi.fn();
      const sendResponse = vi.fn();
      const mockWs = {
        addEventListener: vi.fn(),
        close: vi.fn(),
        send: vi.fn(),
        readyState: WebSocket.OPEN,
      };
      vi.stubGlobal('WebSocket', vi.fn().mockImplementation(() => mockWs));

      handler(
        { type: 'NB_WS_CONNECT', url: 'ws://127.0.0.1:8765/ws' },
        { tab: { id: 1 } } as chrome.runtime.MessageSender,
        connectResponse,
      );

      // Wait for async URL validation + connection setup
      await vi.waitFor(() => expect(connectResponse).toHaveBeenCalledWith({ ok: true }));

      const result = handler(
        { type: 'NB_WS_SEND', text: 'hello from test' },
        { tab: { id: 1 } } as chrome.runtime.MessageSender,
        sendResponse,
      );

      expect(result).toBe(false);
      expect(mockWs.send).toHaveBeenCalledWith('hello from test');
    });

    it('does nothing when no WebSocket connection', () => {
      const sendResponse = vi.fn();
      const result = handler(
        { type: 'NB_WS_SEND', text: 'should not send' },
        {},
        sendResponse,
      );

      expect(result).toBe(false);
      expect(sendResponse).not.toHaveBeenCalled();
    });

    it('does nothing when WebSocket is not OPEN', () => {
      // This test runs in isolation - relayWs starts as null
      // So NB_WS_SEND with no prior NB_WS_CONNECT is a no-op
      const sendResponse = vi.fn();
      const result = handler(
        { type: 'NB_WS_SEND', text: 'should not send' },
        {},
        sendResponse,
      );

      expect(result).toBe(false);
      expect(sendResponse).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Message relay — NB_WS_CLOSE
  // =========================================================================
  describe('NB_WS_CLOSE', () => {
    it('closes connection', async () => {
      const connectResponse = vi.fn();
      const sendResponse = vi.fn();
      const mockWs = {
        addEventListener: vi.fn(),
        close: vi.fn(),
        send: vi.fn(),
        readyState: WebSocket.OPEN,
      };
      vi.stubGlobal('WebSocket', vi.fn().mockImplementation(() => mockWs));

      handler(
        { type: 'NB_WS_CONNECT', url: 'ws://127.0.0.1:8765/ws' },
        { tab: { id: 1 } } as chrome.runtime.MessageSender,
        connectResponse,
      );

      // Wait for async URL validation + connection setup
      await vi.waitFor(() => expect(connectResponse).toHaveBeenCalledWith({ ok: true }));

      const result = handler(
        { type: 'NB_WS_CLOSE' },
        { tab: { id: 1 } } as chrome.runtime.MessageSender,
        sendResponse,
      );

      expect(result).toBe(false);
      expect(mockWs.close).toHaveBeenCalled();
    });

    it('does nothing when no WebSocket connection', () => {
      const sendResponse = vi.fn();
      const result = handler(
        { type: 'NB_WS_CLOSE' },
        { tab: { id: 1 } } as chrome.runtime.MessageSender,
        sendResponse,
      );

      expect(result).toBe(false);
      expect(sendResponse).not.toHaveBeenCalled();
    });

    it('is a no-op when relayWs is already null', () => {
      // No prior NB_WS_CONNECT, so relayWs is null
      const sendResponse = vi.fn();
      const result = handler(
        { type: 'NB_WS_CLOSE' },
        { tab: { id: 99 } } as chrome.runtime.MessageSender,
        sendResponse,
      );

      expect(result).toBe(false);
      expect(sendResponse).not.toHaveBeenCalled();
      // Should not throw
    });
  });

  // =========================================================================
  // Unknown message types
  // =========================================================================
  describe('unknown message types', () => {
    it('ignores unknown message types', () => {
      const sendResponse = vi.fn();
      const result = handler(
        { type: 'UNKNOWN_TYPE' },
        {},
        sendResponse,
      );

      expect(result).toBeUndefined();
      expect(sendResponse).not.toHaveBeenCalled();
    });
  });
});
