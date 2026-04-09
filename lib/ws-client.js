/**
 * WebSocket client with automatic token issuance for Nanobot.
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

  /* -- Token issuance ------------------------------------------------- */

  async _issueToken() {
    const { host, port, tokenIssuePath, tokenIssueSecret } = this.settings;
    const url = `http://${host}:${port}${tokenIssuePath}`;
    const headers = {};
    if (tokenIssueSecret) {
      headers['Authorization'] = `Bearer ${tokenIssueSecret}`;
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

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      const onOpen = () => {
        this.ws.removeEventListener('open', onOpen);
        this.ws.removeEventListener('error', onError);
        resolve();
      };

      const onError = (e) => {
        this.ws.removeEventListener('open', onOpen);
        this.ws.removeEventListener('error', onError);
        reject(new Error('WebSocket connection failed'));
      };

      this.ws.addEventListener('open', onOpen);
      this.ws.addEventListener('error', onError);

      this.ws.addEventListener('message', (e) => {
        try {
          const data = JSON.parse(e.data);
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
      });

      this.ws.addEventListener('close', (e) => {
        this._emit('close', { code: e.code, reason: e.reason });
        this.ws = null;
      });

      this.ws.addEventListener('error', () => {
        this._emit('error', {});
      });
    });
  }

  /* -- Sending -------------------------------------------------------- */

  send(text) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(text);
    }
  }

  sendJSON(obj) {
    this.send(JSON.stringify(obj));
  }

  /* -- Teardown ------------------------------------------------------- */

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.chatId = null;
  }

  get connected() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
