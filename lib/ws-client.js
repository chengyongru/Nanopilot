/**
 * WebSocket client with automatic token issuance for Nanobot.
 *
 * In extension pages: direct WebSocket + fetch.
 * In content scripts (HTTPS pages): both are relayed through the background
 * service worker to bypass page CSP and mixed-content restrictions.
 *
 * Events: 'ready', 'delta', 'stream_end', 'message', 'close', 'error'
 */

class NanobotWsClient {
  /**
   * @param {{ host: string, port: number, path: string,
   *            tokenIssuePath: string, tokenIssueSecret: string,
   *            clientId: string }} settings
   */
  constructor(settings) {
    this.settings = settings;
    /** @type {WebSocket|null} */
    this.ws = null;
    this.chatId = null;
    this._listeners = new Map();
    /** True when using background relay (content script on HTTPS). */
    this._relayed = false;
    this._relayConnected = false;
  }

  /* -- EventEmitter --------------------------------------------------- */

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(fn);
    return this;
  }

  off(event, fn) {
    const list = this._listeners.get(event);
    if (list) this._listeners.set(event, list.filter(f => f !== fn));
    return this;
  }

  _emit(event, data) {
    (this._listeners.get(event) || []).forEach(fn => {
      try { fn(data); } catch (e) { console.error('[ws-client] listener error', e); }
    });
  }

  /* -- Context detection ----------------------------------------------- */

  /** True when running as a content script inside a web page. */
  _isContentScript() {
    try {
      return !!(chrome.runtime?.id && !location.href.startsWith('chrome-extension://'));
    } catch {
      return false;
    }
  }

  /* -- Token issuance ------------------------------------------------- */

  async _issueToken() {
    const { host, port, tokenIssuePath, tokenIssueSecret } = this.settings;
    const url = `http://${host}:${port}${tokenIssuePath}`;
    const headers = {};
    if (tokenIssueSecret) {
      headers['Authorization'] = `Bearer ${tokenIssueSecret}`;
    }

    // Content scripts: route through background to bypass page CSP
    if (this._isContentScript()) {
      const result = await chrome.runtime.sendMessage({
        type: 'NB_FETCH', url, headers,
      });
      if (!result || !result.ok) {
        throw new Error(`Token issue failed: HTTP ${result?.status ?? 'no response'}`);
      }
      return JSON.parse(result.body).token;
    }

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      throw new Error(`Token issue failed: HTTP ${resp.status}`);
    }
    const data = await resp.json();
    return data.token;
  }

  /* -- Connection ----------------------------------------------------- */

  async connect() {
    if (this.ws) this.disconnect();

    const token = await this._issueToken();
    const { host, port, path, clientId } = this.settings;
    const url = `ws://${host}:${port}${path}?client_id=${encodeURIComponent(clientId)}&token=${encodeURIComponent(token)}`;

    if (this._isContentScript()) {
      return this._connectRelay(url);
    }
    return this._connectDirect(url);
  }

  /** Direct WebSocket — used in extension pages (side panel). */
  _connectDirect(url) {
    this._relayed = false;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      const onOpen = () => {
        this.ws.removeEventListener('open', onOpen);
        this.ws.removeEventListener('error', onError);
        resolve();
      };

      const onError = () => {
        this.ws.removeEventListener('open', onOpen);
        this.ws.removeEventListener('error', onError);
        reject(new Error('WebSocket connection failed'));
      };

      this.ws.addEventListener('open', onOpen);
      this.ws.addEventListener('error', onError);

      this.ws.addEventListener('message', (e) => this._handleFrame(e.data));
      this.ws.addEventListener('close', (e) => {
        this._emit('close', { code: e.code, reason: e.reason });
        this.ws = null;
      });
      this.ws.addEventListener('error', () => this._emit('error', {}));
    });
  }

  /** Relayed WebSocket — used in content scripts to bypass mixed-content. */
  async _connectRelay(url) {
    this._relayed = true;
    this._relayConnected = false;

    // Listen for relayed events from background
    this._relayListener = (msg) => {
      if (msg.type === 'NB_WS_MESSAGE') this._handleFrame(msg.data);
      else if (msg.type === 'NB_WS_OPEN') {
        this._relayConnected = true;
      }
      else if (msg.type === 'NB_WS_CLOSE') {
        this._relayConnected = false;
        this._emit('close', { code: msg.code, reason: msg.reason });
      }
      else if (msg.type === 'NB_WS_ERROR') {
        this._emit('error', {});
      }
    };
    chrome.runtime.onMessage.addListener(this._relayListener);

    // Tell background to open the WebSocket
    const result = await chrome.runtime.sendMessage({ type: 'NB_WS_CONNECT', url });
    if (!result?.ok) {
      throw new Error('WebSocket relay failed');
    }

    // Wait for open event from background
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket relay timeout')), 10000);
      const check = () => {
        if (this._relayConnected) { clearTimeout(timeout); resolve(); }
        else setTimeout(check, 50);
      };
      check();
    });
  }

  /** Parse a server frame and emit the corresponding event. */
  _handleFrame(raw) {
    try {
      const data = JSON.parse(raw);
      const event = data.event;
      if (event === 'ready') {
        this.chatId = data.chat_id;
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

  /* -- Sending -------------------------------------------------------- */

  send(text) {
    if (this._relayed) {
      chrome.runtime.sendMessage({ type: 'NB_WS_SEND', text });
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(text);
    }
  }

  sendJSON(obj) {
    this.send(JSON.stringify(obj));
  }

  /* -- Teardown ------------------------------------------------------- */

  disconnect() {
    if (this._relayed) {
      chrome.runtime.sendMessage({ type: 'NB_WS_CLOSE' });
      this._relayConnected = false;
      if (this._relayListener) {
        chrome.runtime.onMessage.removeListener(this._relayListener);
        this._relayListener = null;
      }
      this._relayed = false;
    } else if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.chatId = null;
  }

  get connected() {
    if (this._relayed) return this._relayConnected;
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
