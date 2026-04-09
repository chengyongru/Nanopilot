import type { Settings, WsClientEvent, ServerFrame } from './types';

type Listener = (data: unknown) => void;

/** Chrome runtime message listener function type. */
type ChromeMessageListener = (
  msg: { type: string; [key: string]: unknown },
  sender: unknown,
  sendResponse: unknown,
) => void;

export class NanobotWsClient {
  private settings: Settings;
  private ws: WebSocket | null = null;
  private chatId: string | null = null;
  private _listeners: Map<string, Listener[]> = new Map();
  private _relayed = false;
  private _relayConnected = false;
  private _relayListener: ChromeMessageListener | null = null;
  private _relayAbort = false;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  on(event: WsClientEvent, fn: Listener): this {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event)!.push(fn);
    return this;
  }

  off(event: WsClientEvent, fn: Listener): this {
    const list = this._listeners.get(event);
    if (list) this._listeners.set(event, list.filter((f) => f !== fn));
    return this;
  }

  private _emit(event: WsClientEvent, data: unknown): void {
    (this._listeners.get(event) || []).forEach((fn) => {
      try {
        fn(data);
      } catch (e) {
        console.error('[ws-client] listener error', e);
      }
    });
  }

  private _isContentScript(): boolean {
    try {
      return !!(
        chrome.runtime?.id &&
        !location.href.startsWith('chrome-extension://')
      );
    } catch {
      return false;
    }
  }

  private async _issueToken(): Promise<string> {
    const { host, port, tokenIssuePath, tokenIssueSecret } = this.settings;
    const url = `http://${host}:${port}${tokenIssuePath}`;
    const headers: Record<string, string> = {};
    if (tokenIssueSecret) {
      headers['Authorization'] = `Bearer ${tokenIssueSecret}`;
    }

    if (this._isContentScript()) {
      const result = await chrome.runtime.sendMessage({
        type: 'NB_FETCH',
        url,
        headers,
      });
      if (!result || !result.ok) {
        throw new Error(
          `Token issue failed: HTTP ${result?.status ?? 'no response'}`,
        );
      }
      return (JSON.parse(result.body as string) as { token: string }).token;
    }

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      throw new Error(`Token issue failed: HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as { token: string };
    return data.token;
  }

  async connect(): Promise<void> {
    if (this.ws) this.disconnect();

    const token = await this._issueToken();
    const { host, port, path, clientId } = this.settings;
    const url = `ws://${host}:${port}${path}?client_id=${encodeURIComponent(clientId)}&token=${encodeURIComponent(token)}`;

    if (this._isContentScript()) {
      return this._connectRelay(url);
    }
    return this._connectDirect(url);
  }

  private _connectDirect(url: string): Promise<void> {
    this._relayed = false;
    let errored = false;
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url);
      const onOpen = () => {
        this.ws!.removeEventListener('open', onOpen);
        this.ws!.removeEventListener('error', onError);
        resolve();
      };
      const onError = () => {
        this.ws!.removeEventListener('open', onOpen);
        this.ws!.removeEventListener('error', onError);
        errored = true;
        reject(new Error('WebSocket connection failed'));
      };
      this.ws.addEventListener('open', onOpen);
      this.ws.addEventListener('error', onError);
      this.ws.addEventListener('message', (e) => this._handleFrame(e.data as string));
      this.ws.addEventListener('close', (e) => {
        if (!errored) {
          this._emit('close', { code: e.code, reason: e.reason });
        }
        this.ws = null;
      });
      this.ws.addEventListener('error', () => {
        this._emit('error', {});
      });
    });
  }

  private async _connectRelay(url: string): Promise<void> {
    this._relayed = true;
    this._relayConnected = false;
    this._relayAbort = false;

    this._relayListener = (msg) => {
      if (msg.type === 'NB_WS_MESSAGE') this._handleFrame(msg.data as string);
      else if (msg.type === 'NB_WS_OPEN') {
        this._relayConnected = true;
      } else if (msg.type === 'NB_WS_CLOSE') {
        this._relayConnected = false;
        this._emit('close', { code: msg.code, reason: msg.reason });
      } else if (msg.type === 'NB_WS_ERROR') {
        this._emit('error', {});
      }
    };
    chrome.runtime.onMessage.addListener(this._relayListener);

    const result = await chrome.runtime.sendMessage({ type: 'NB_WS_CONNECT', url });
    if (!result?.ok) {
      this._removeRelayListener();
      throw new Error('WebSocket relay failed');
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => {
            this._relayAbort = true;
            this._removeRelayListener();
            reject(new Error('WebSocket relay timeout'));
          },
          10000,
        );
        const check = () => {
          if (this._relayAbort) return;
          if (this._relayConnected) {
            clearTimeout(timeout);
            resolve();
          } else {
            setTimeout(check, 50);
          }
        };
        check();
      });
    } catch {
      // On timeout or abort, clean up the relay connection
      this._removeRelayListener();
      throw new Error('WebSocket relay timeout');
    }
  }

  private _removeRelayListener(): void {
    if (this._relayListener) {
      chrome.runtime.onMessage.removeListener(this._relayListener);
      this._relayListener = null;
    }
  }

  private _handleFrame(raw: string): void {
    try {
      const data = JSON.parse(raw) as ServerFrame;
      const event = data.event;
      if (event === 'ready') {
        this.chatId = data.chat_id ?? null;
        this._emit('ready', data);
      } else if (event === 'delta') {
        this._emit('delta', data);
      } else if (event === 'stream_end') {
        this._emit('stream_end', data);
      } else if (event === 'message') {
        this._emit('message', data);
      } else {
        this._emit('unknown', data);
      }
    } catch {
      // Non-JSON frame, ignore
    }
  }

  send(text: string): void {
    if (this._relayed) {
      chrome.runtime.sendMessage({ type: 'NB_WS_SEND', text });
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(text);
    }
  }

  sendJSON(obj: unknown): void {
    this.send(JSON.stringify(obj));
  }

  disconnect(): void {
    this._relayAbort = true;
    if (this._relayed) {
      chrome.runtime.sendMessage({ type: 'NB_WS_CLOSE' });
      this._relayConnected = false;
      this._removeRelayListener();
      this._relayed = false;
    } else if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.chatId = null;
  }

  get connected(): boolean {
    if (this._relayed) return this._relayConnected;
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
