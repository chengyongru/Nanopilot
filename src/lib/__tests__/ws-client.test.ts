import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Minimal chrome mock for extension-page (direct) mode. */
function stubChromeExtension() {
  vi.stubGlobal('location', { href: 'chrome-extension://abc123/popup.html' });
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'abc123',
      sendMessage: vi.fn(),
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
  });
}

/** Minimal chrome mock for content-script (relay) mode. */
function stubContentScript() {
  vi.stubGlobal('location', { href: 'https://example.com/page.html' });
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'abc123',
      sendMessage: vi.fn(),
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
  });
}

/** Remove chrome / location globals. */
function stubNoChrome() {
  vi.stubGlobal('location', { href: 'chrome-extension://abc123/popup.html' });
  // @ts-expect-error intentionally undefined
  vi.stubGlobal('chrome', undefined);
}

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { NanobotWsClient } from '../ws-client';
import type { Settings, WsClientEvent, ServerFrame } from '../types';

// ---------------------------------------------------------------------------
// Shared test settings
// ---------------------------------------------------------------------------

const settings: Settings = {
  host: '127.0.0.1',
  port: 8765,
  path: '/ws',
  tokenIssuePath: '/auth/token',
  tokenIssueSecret: '',
  clientId: 'test-client',
};

const settingsWithSecret: Settings = {
  ...settings,
  tokenIssueSecret: 'super-secret',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NanobotWsClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // EventEmitter
  // =========================================================================
  describe('EventEmitter', () => {
    it('on() registers a listener and _emit() fires it', () => {
      const client = new NanobotWsClient(settings);
      const fn = vi.fn();
      client.on('ready', fn);
      // access private via cast for testing
      (client as unknown as { _emit: (e: WsClientEvent, d: unknown) => void })._emit('ready', { chat_id: 'c1' });
      expect(fn).toHaveBeenCalledWith({ chat_id: 'c1' });
    });

    it('supports multiple listeners on the same event', () => {
      const client = new NanobotWsClient(settings);
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      client.on('delta', fn1);
      client.on('delta', fn2);
      (client as unknown as { _emit: (e: WsClientEvent, d: unknown) => void })._emit('delta', { text: 'hi' });
      expect(fn1).toHaveBeenCalledWith({ text: 'hi' });
      expect(fn2).toHaveBeenCalledWith({ text: 'hi' });
    });

    it('off() removes a specific listener', () => {
      const client = new NanobotWsClient(settings);
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      client.on('delta', fn1).on('delta', fn2);
      client.off('delta', fn1);
      (client as unknown as { _emit: (e: WsClientEvent, d: unknown) => void })._emit('delta', {});
      expect(fn1).not.toHaveBeenCalled();
      expect(fn2).toHaveBeenCalledWith({});
    });

    it('listener throwing does not crash other listeners', () => {
      const client = new NanobotWsClient(settings);
      const bad = vi.fn(() => {
        throw new Error('boom');
      });
      const good = vi.fn();
      client.on('delta', bad);
      client.on('delta', good);
      // Suppress console.error from the catch
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      (client as unknown as { _emit: (e: WsClientEvent, d: unknown) => void })._emit('delta', {});
      expect(spy).toHaveBeenCalledWith(
        '[ws-client] listener error',
        expect.any(Error),
      );
      expect(good).toHaveBeenCalledWith({});
      spy.mockRestore();
    });

    it('on() and off() return this for chaining', () => {
      const client = new NanobotWsClient(settings);
      const fn = vi.fn();
      const result = client.on('ready', fn);
      expect(result).toBe(client);
      const result2 = client.off('ready', fn);
      expect(result2).toBe(client);
    });

    it('off() on unknown event does not throw', () => {
      const client = new NanobotWsClient(settings);
      const fn = vi.fn();
      expect(() => client.off('ready' as WsClientEvent, fn)).not.toThrow();
    });
  });

  // =========================================================================
  // _isContentScript
  // =========================================================================
  describe('_isContentScript', () => {
    it('returns false in extension page (chrome-extension:// URL)', () => {
      stubChromeExtension();
      const client = new NanobotWsClient(settings);
      expect(
        (client as unknown as { _isContentScript: () => boolean })._isContentScript(),
      ).toBe(false);
    });

    it('returns true in content script (https:// URL with chrome.runtime.id)', () => {
      stubContentScript();
      const client = new NanobotWsClient(settings);
      expect(
        (client as unknown as { _isContentScript: () => boolean })._isContentScript(),
      ).toBe(true);
    });

    it('returns false when chrome.runtime is undefined', () => {
      stubNoChrome();
      const client = new NanobotWsClient(settings);
      expect(
        (client as unknown as { _isContentScript: () => boolean })._isContentScript(),
      ).toBe(false);
    });
  });

  // =========================================================================
  // _issueToken
  // =========================================================================
  describe('_issueToken', () => {
    it('direct fetch success returns token', async () => {
      stubChromeExtension();
      const client = new NanobotWsClient(settings);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ token: 'tok-123' }),
      }));
      const token = await (client as unknown as { _issueToken: () => Promise<string> })._issueToken();
      expect(token).toBe('tok-123');
      expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:8765/auth/token', {
        headers: {},
      });
    });

    it('does not send Authorization header when secret is empty', async () => {
      stubChromeExtension();
      const client = new NanobotWsClient(settings);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ token: 'tok' }),
      }));
      await (client as unknown as { _issueToken: () => Promise<string> })._issueToken();
      expect(fetch).toHaveBeenCalledWith(expect.any(String), {
        headers: {},
      });
    });

    it('sends Authorization header when secret is provided', async () => {
      stubChromeExtension();
      const client = new NanobotWsClient(settingsWithSecret);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ token: 'tok' }),
      }));
      await (client as unknown as { _issueToken: () => Promise<string> })._issueToken();
      expect(fetch).toHaveBeenCalledWith(expect.any(String), {
        headers: { Authorization: 'Bearer super-secret' },
      });
    });

    it('relayed fetch success returns token', async () => {
      stubContentScript();
      const client = new NanobotWsClient(settings);
      (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        body: JSON.stringify({ token: 'relay-tok' }),
      });
      const token = await (client as unknown as { _issueToken: () => Promise<string> })._issueToken();
      expect(token).toBe('relay-tok');
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: 'NB_FETCH',
        url: 'http://127.0.0.1:8765/auth/token',
        headers: {},
      });
    });

    it('throws on failed direct fetch', async () => {
      stubChromeExtension();
      const client = new NanobotWsClient(settings);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
      }));
      await expect(
        (client as unknown as { _issueToken: () => Promise<string> })._issueToken(),
      ).rejects.toThrow('Token issue failed: HTTP 403');
    });

    it('throws on failed relayed fetch (no result)', async () => {
      stubContentScript();
      const client = new NanobotWsClient(settings);
      (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      await expect(
        (client as unknown as { _issueToken: () => Promise<string> })._issueToken(),
      ).rejects.toThrow('Token issue failed: HTTP no response');
    });

    it('throws on failed relayed fetch (ok=false)', async () => {
      stubContentScript();
      const client = new NanobotWsClient(settings);
      (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 500,
      });
      await expect(
        (client as unknown as { _issueToken: () => Promise<string> })._issueToken(),
      ).rejects.toThrow('Token issue failed: HTTP 500');
    });
  });

  // =========================================================================
  // _handleFrame
  // =========================================================================
  describe('_handleFrame', () => {
    let client: NanobotWsClient;
    let listeners: Record<WsClientEvent, vi.fn>;

    beforeEach(() => {
      client = new NanobotWsClient(settings);
      listeners = {
        ready: vi.fn(),
        delta: vi.fn(),
        stream_end: vi.fn(),
        message: vi.fn(),
        close: vi.fn(),
        error: vi.fn(),
        unknown: vi.fn(),
      };
      for (const [event, fn] of Object.entries(listeners)) {
        client.on(event as WsClientEvent, fn);
      }
    });

    it('emits "ready" and sets chatId', () => {
      const frame: ServerFrame = { event: 'ready', chat_id: 'chat-42' };
      (client as unknown as { _handleFrame: (raw: string) => void })._handleFrame(JSON.stringify(frame));
      expect(listeners.ready).toHaveBeenCalledWith(frame);
      expect(
        (client as unknown as { chatId: string | null }).chatId,
      ).toBe('chat-42');
    });

    it('emits "delta"', () => {
      const frame: ServerFrame = { event: 'delta', text: 'hello' };
      (client as unknown as { _handleFrame: (raw: string) => void })._handleFrame(JSON.stringify(frame));
      expect(listeners.delta).toHaveBeenCalledWith(frame);
      expect(listeners.stream_end).not.toHaveBeenCalled();
    });

    it('emits "stream_end"', () => {
      const frame: ServerFrame = { event: 'stream_end' };
      (client as unknown as { _handleFrame: (raw: string) => void })._handleFrame(JSON.stringify(frame));
      expect(listeners.stream_end).toHaveBeenCalledWith(frame);
    });

    it('emits "message"', () => {
      const frame: ServerFrame = { event: 'message', text: 'full msg' };
      (client as unknown as { _handleFrame: (raw: string) => void })._handleFrame(JSON.stringify(frame));
      expect(listeners.message).toHaveBeenCalledWith(frame);
    });

    it('emits "unknown" for unrecognized event', () => {
      const frame = { event: 'custom_event', data: 1 };
      (client as unknown as { _handleFrame: (raw: string) => void })._handleFrame(JSON.stringify(frame));
      expect(listeners.unknown).toHaveBeenCalledWith(frame);
      expect(listeners.delta).not.toHaveBeenCalled();
    });

    it('silently ignores non-JSON frames', () => {
      (client as unknown as { _handleFrame: (raw: string) => void })._handleFrame('not json at all');
      for (const fn of Object.values(listeners)) {
        expect(fn).not.toHaveBeenCalled();
      }
    });
  });

  // =========================================================================
  // send / sendJSON
  // =========================================================================
  describe('send / sendJSON', () => {
    it('sendJSON calls send with JSON string', () => {
      stubChromeExtension();
      const client = new NanobotWsClient(settings);
      const sendSpy = vi.spyOn(client, 'send');
      const obj = { action: 'chat', text: 'hi' };
      client.sendJSON(obj);
      expect(sendSpy).toHaveBeenCalledWith(JSON.stringify(obj));
    });

    it('send() in relay mode calls chrome.runtime.sendMessage', () => {
      stubContentScript();
      const client = new NanobotWsClient(settings);
      // Force relay mode
      (client as unknown as { _relayed: boolean })._relayed = true;
      client.send('hello');
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: 'NB_WS_SEND',
        text: 'hello',
      });
    });

    it('send() in direct mode calls ws.send() when OPEN', () => {
      stubChromeExtension();
      const client = new NanobotWsClient(settings);
      const mockWs = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
      (client as unknown as { ws: WebSocket | null }).ws = mockWs;
      client.send('hello');
      expect(mockWs.send).toHaveBeenCalledWith('hello');
    });

    it('send() in direct mode does nothing when ws not OPEN', () => {
      stubChromeExtension();
      const client = new NanobotWsClient(settings);
      const mockWs = { readyState: WebSocket.CONNECTING, send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
      (client as unknown as { ws: WebSocket | null }).ws = mockWs;
      client.send('hello');
      expect(mockWs.send).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // connected getter
  // =========================================================================
  describe('connected getter', () => {
    it('returns false when no connection', () => {
      stubChromeExtension();
      const client = new NanobotWsClient(settings);
      expect(client.connected).toBe(false);
    });

    it('returns true in relay mode when connected', () => {
      stubContentScript();
      const client = new NanobotWsClient(settings);
      (client as unknown as { _relayed: boolean })._relayed = true;
      (client as unknown as { _relayConnected: boolean })._relayConnected = true;
      expect(client.connected).toBe(true);
    });

    it('returns false in relay mode when not connected', () => {
      stubContentScript();
      const client = new NanobotWsClient(settings);
      (client as unknown as { _relayed: boolean })._relayed = true;
      (client as unknown as { _relayConnected: boolean })._relayConnected = false;
      expect(client.connected).toBe(false);
    });

    it('returns true in direct mode when ws OPEN', () => {
      stubChromeExtension();
      const client = new NanobotWsClient(settings);
      const mockWs = { readyState: WebSocket.OPEN } as unknown as WebSocket;
      (client as unknown as { ws: WebSocket | null }).ws = mockWs;
      expect(client.connected).toBe(true);
    });

    it('returns false in direct mode when ws CONNECTING', () => {
      stubChromeExtension();
      const client = new NanobotWsClient(settings);
      const mockWs = { readyState: WebSocket.CONNECTING } as unknown as WebSocket;
      (client as unknown as { ws: WebSocket | null }).ws = mockWs;
      expect(client.connected).toBe(false);
    });
  });

  // =========================================================================
  // disconnect
  // =========================================================================
  describe('disconnect', () => {
    it('closes ws and clears state in direct mode', () => {
      stubChromeExtension();
      const client = new NanobotWsClient(settings);
      const mockWs = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
        close: vi.fn(),
      } as unknown as WebSocket;
      (client as unknown as { ws: WebSocket | null }).ws = mockWs;
      (client as unknown as { chatId: string | null }).chatId = 'c1';

      client.disconnect();
      expect(mockWs.close).toHaveBeenCalled();
      expect((client as unknown as { ws: WebSocket | null }).ws).toBeNull();
      expect((client as unknown as { chatId: string | null }).chatId).toBeNull();
    });

    it('sends close message and removes listener in relay mode', () => {
      stubContentScript();
      const client = new NanobotWsClient(settings);
      (client as unknown as { _relayed: boolean })._relayed = true;
      (client as unknown as { _relayConnected: boolean })._relayConnected = true;
      (client as unknown as { chatId: string | null }).chatId = 'c1';
      const relayListener = vi.fn();
      (client as unknown as { _relayListener: unknown })._relayListener = relayListener;

      client.disconnect();
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: 'NB_WS_CLOSE',
      });
      expect(chrome.runtime.onMessage.removeListener).toHaveBeenCalledWith(relayListener);
      expect((client as unknown as { _relayListener: unknown })._relayListener).toBeNull();
      expect((client as unknown as { _relayConnected: boolean })._relayConnected).toBe(false);
      expect((client as unknown as { _relayed: boolean })._relayed).toBe(false);
      expect((client as unknown as { chatId: string | null }).chatId).toBeNull();
    });

    it('does nothing in direct mode when ws is null', () => {
      stubChromeExtension();
      const client = new NanobotWsClient(settings);
      expect(() => client.disconnect()).not.toThrow();
    });
  });

  // =========================================================================
  // _connectRelay timeout
  // =========================================================================
  describe('_connectRelay', () => {
    it('throws on relay timeout', async () => {
      stubContentScript();
      const client = new NanobotWsClient(settings);

      (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

      // Mock _issueToken to return a token directly
      const issueTokenSpy = vi.spyOn(
        client as unknown as { _issueToken: () => Promise<string> },
        '_issueToken',
      ).mockResolvedValue('tok');

      // Capture the rejection in a variable; attach .catch immediately
      let capturedError: Error | undefined;
      const rawPromise = (client as unknown as { _connectRelay: (url: string) => Promise<void> })
        ._connectRelay('ws://127.0.0.1:8765/ws?token=tok')
        .catch((err) => { capturedError = err; });

      // Advance time past the 10s timeout
      await vi.advanceTimersByTimeAsync(10500);

      // Wait for the promise to settle
      await rawPromise;

      expect(capturedError).toBeInstanceOf(Error);
      expect(capturedError!.message).toBe('WebSocket relay timeout');

      issueTokenSpy.mockRestore();
    });
  });

  // =========================================================================
  // connect (integration)
  // =========================================================================
  describe('connect', () => {
    it('disconnects existing ws before reconnecting', async () => {
      stubChromeExtension();
      const client = new NanobotWsClient(settings);
      const mockWs = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
        close: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as WebSocket;
      (client as unknown as { ws: WebSocket | null }).ws = mockWs;

      // Mock _issueToken and _connectDirect
      const issueSpy = vi.spyOn(
        client as unknown as { _issueToken: () => Promise<string> },
        '_issueToken',
      ).mockResolvedValue('tok');
      const directSpy = vi.spyOn(
        client as unknown as { _connectDirect: (url: string) => Promise<void> },
        '_connectDirect',
      ).mockResolvedValue();

      await client.connect();

      expect(mockWs.close).toHaveBeenCalled();
      expect(issueSpy).toHaveBeenCalled();
      expect(directSpy).toHaveBeenCalled();

      issueSpy.mockRestore();
      directSpy.mockRestore();
    });
  });
});
