import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Chrome API mock
// ---------------------------------------------------------------------------

let addListenerSpies: Record<string, ReturnType<typeof vi.fn>>;

function setupChrome(): void {
  const actionOnClicked = { addListener: vi.fn() };
  const commandsOnCommand = { addListener: vi.fn() };
  const runtimeOnMessage = { addListener: vi.fn() };

  addListenerSpies = {
    actionOnClicked: actionOnClicked.addListener,
    commandsOnCommand: commandsOnCommand.addListener,
    runtimeOnMessage: runtimeOnMessage.addListener,
  };

  vi.stubGlobal('chrome', {
    action: { onClicked: actionOnClicked },
    commands: { onCommand: commandsOnCommand },
    runtime: { onMessage: runtimeOnMessage },
    sidePanel: { open: vi.fn().mockResolvedValue(undefined) },
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 1, url: 'https://example.com' }]),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    scripting: {
      insertCSS: vi.fn().mockResolvedValue(undefined),
      executeScript: vi.fn().mockResolvedValue(undefined),
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Import the module fresh, returning the registered message handler. */
async function importAndGetMessageHandler() {
  vi.resetModules();
  setupChrome();
  // Import triggers module-level side effects (addListener calls)
  await import('../service-worker');
  // Extract the message handler from the registered listener
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

    it('skips chrome:// pages', async () => {
      chrome.tabs.query.mockResolvedValueOnce([{ id: 1, url: 'chrome://settings' }]);
      const commandHandler = addListenerSpies.commandsOnCommand.mock.calls[0][0];
      await commandHandler('quick-chat');
      expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
      expect(chrome.scripting.insertCSS).not.toHaveBeenCalled();
    });

    it('skips edge:// pages', async () => {
      chrome.tabs.query.mockResolvedValueOnce([{ id: 1, url: 'edge://settings' }]);
      const commandHandler = addListenerSpies.commandsOnCommand.mock.calls[0][0];
      await commandHandler('quick-chat');
      expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
      expect(chrome.scripting.insertCSS).not.toHaveBeenCalled();
    });

    it('handles tab with no URL', async () => {
      chrome.tabs.query.mockResolvedValueOnce([{ id: 1 }]);
      const commandHandler = addListenerSpies.commandsOnCommand.mock.calls[0][0];
      await commandHandler('quick-chat');
      expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
      expect(chrome.scripting.insertCSS).not.toHaveBeenCalled();
    });

    it('handles no active tab', async () => {
      chrome.tabs.query.mockResolvedValueOnce([]);
      const commandHandler = addListenerSpies.commandsOnCommand.mock.calls[0][0];
      await commandHandler('quick-chat');
      expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
      expect(chrome.scripting.insertCSS).not.toHaveBeenCalled();
    });

    it('toggles overlay if already injected (sendMessage succeeds)', async () => {
      chrome.tabs.sendMessage.mockResolvedValueOnce(undefined);
      const commandHandler = addListenerSpies.commandsOnCommand.mock.calls[0][0];
      await commandHandler('quick-chat');
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, { type: 'NB_QUICKCHAT_TOGGLE' });
      expect(chrome.scripting.insertCSS).not.toHaveBeenCalled();
    });

    it('injects CSS + scripts if overlay not yet injected (sendMessage fails)', async () => {
      chrome.tabs.sendMessage.mockRejectedValueOnce(new Error('no receiver'));
      const commandHandler = addListenerSpies.commandsOnCommand.mock.calls[0][0];
      await commandHandler('quick-chat');

      expect(chrome.scripting.insertCSS).toHaveBeenCalledWith({
        target: { tabId: 1 },
        files: ['quickchat/style.css'],
      });
      expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
        target: { tabId: 1 },
        files: [
          'lib/storage.js',
          'lib/session.js',
          'lib/ws-client.js',
          'quickchat/quickchat.js',
        ],
      });
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
        { type: 'NB_FETCH', url: 'https://api.example.com/data', headers: { 'X-Custom': 'val' } },
        {},
        sendResponse,
      );

      expect(result).toBe(true); // async
      // Wait for the fetch promise chain to resolve
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({
        ok: true,
        status: 200,
        body: 'hello world',
      }));
    });

    it('handles network errors', async () => {
      const sendResponse = vi.fn();
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')));

      handler(
        { type: 'NB_FETCH', url: 'https://api.example.com/fail' },
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
    it('creates WebSocket and returns ok', () => {
      const sendResponse = vi.fn();
      const mockWs = {
        addEventListener: vi.fn(),
        close: vi.fn(),
        send: vi.fn(),
        readyState: WebSocket.OPEN,
      };
      vi.stubGlobal('WebSocket', vi.fn().mockImplementation(() => mockWs));

      const result = handler(
        { type: 'NB_WS_CONNECT', url: 'ws://localhost:8765/ws' },
        { tab: { id: 42 } },
        sendResponse,
      );

      expect(result).toBe(false);
      expect(WebSocket).toHaveBeenCalledWith('ws://localhost:8765/ws');
      expect(sendResponse).toHaveBeenCalledWith({ ok: true });
      expect(mockWs.addEventListener).toHaveBeenCalledWith('open', expect.any(Function));
      expect(mockWs.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockWs.addEventListener).toHaveBeenCalledWith('close', expect.any(Function));
      expect(mockWs.addEventListener).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('closes existing relay before opening new one', () => {
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

      // First connect
      handler(
        { type: 'NB_WS_CONNECT', url: 'ws://localhost/a' },
        { tab: { id: 1 } },
        sendResponse,
      );

      // Second connect should close the first
      handler(
        { type: 'NB_WS_CONNECT', url: 'ws://localhost/b' },
        { tab: { id: 2 } },
        sendResponse,
      );

      expect(oldWs.close).toHaveBeenCalled();
    });

    it('returns ok: false on WebSocket constructor error', () => {
      const sendResponse = vi.fn();
      vi.stubGlobal('WebSocket', vi.fn().mockImplementation(() => {
        throw new Error('invalid url');
      }));

      const result = handler(
        { type: 'NB_WS_CONNECT', url: 'bad-url' },
        { tab: { id: 1 } },
        sendResponse,
      );

      expect(result).toBe(false);
      expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'invalid url' });
    });
  });

  // =========================================================================
  // Message relay — NB_WS_SEND
  // =========================================================================
  describe('NB_WS_SEND', () => {
    it('sends text on open connection', async () => {
      // First establish a connection via NB_WS_CONNECT
      const sendResponse = vi.fn();
      const mockWs = {
        addEventListener: vi.fn(),
        close: vi.fn(),
        send: vi.fn(),
        readyState: WebSocket.OPEN,
      };
      vi.stubGlobal('WebSocket', vi.fn().mockImplementation(() => mockWs));

      handler(
        { type: 'NB_WS_CONNECT', url: 'ws://localhost/ws' },
        { tab: { id: 1 } },
        sendResponse,
      );

      // Now send a message
      const result = handler(
        { type: 'NB_WS_SEND', text: 'hello from test' },
        {},
        sendResponse,
      );

      expect(result).toBe(false);
      expect(mockWs.send).toHaveBeenCalledWith('hello from test');
    });

    it('does nothing when no WebSocket connection', () => {
      const sendResponse = vi.fn();
      // No prior NB_WS_CONNECT, so relayWs is null
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
      const sendResponse = vi.fn();
      const mockWs = {
        addEventListener: vi.fn(),
        close: vi.fn(),
        send: vi.fn(),
        readyState: WebSocket.OPEN,
      };
      vi.stubGlobal('WebSocket', vi.fn().mockImplementation(() => mockWs));

      // Establish connection
      handler(
        { type: 'NB_WS_CONNECT', url: 'ws://localhost/ws' },
        { tab: { id: 1 } },
        sendResponse,
      );

      // Close it
      const result = handler(
        { type: 'NB_WS_CLOSE' },
        {},
        sendResponse,
      );

      expect(result).toBe(false);
      expect(mockWs.close).toHaveBeenCalled();
    });

    it('does nothing when no WebSocket connection', () => {
      const sendResponse = vi.fn();
      const result = handler(
        { type: 'NB_WS_CLOSE' },
        {},
        sendResponse,
      );

      expect(result).toBe(false);
      expect(sendResponse).not.toHaveBeenCalled();
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
