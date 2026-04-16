/**
 * Background service worker.
 * - Opens side panel on extension icon click
 * - Handles Ctrl+Shift+K quick-chat command
 * - Relays HTTP fetch and WebSocket from content scripts (bypasses CSP & mixed-content)
 */

import { loadSettings } from '../lib/storage';

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------

chrome.action.onClicked.addListener((tab: chrome.tabs.Tab) => {
  chrome.sidePanel.open({ tabId: tab.id! });
});

// ---------------------------------------------------------------------------
// Quick-chat command
// ---------------------------------------------------------------------------

chrome.commands.onCommand.addListener(async (command: string) => {
  if (command !== 'quick-chat') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  try {
    // If overlay already injected, toggle it
    await chrome.tabs.sendMessage(tab.id, { type: 'NB_QUICKCHAT_TOGGLE' });
  } catch {
    // Not injected yet — inject CSS then scripts.
    // Errors on restricted URLs (chrome://, edge://, etc.) are silently ignored.
    try {
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['quickchat/style.css'],
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [
          'quickchat/quickchat.js',
        ],
      });
    } catch {
      // Restricted URL — cannot inject content scripts here
    }
  }
});

// ---------------------------------------------------------------------------
// Message relay — supports multiple concurrent WebSocket connections
// ---------------------------------------------------------------------------

/** Active WebSocket relay connections, keyed by tab ID. */
const relayConnections = new Map<number, WebSocket>();

function _relayToTab(tabId: number, type: string, data?: Record<string, unknown>): void {
  chrome.tabs.sendMessage(tabId, { type, ...data }).catch(() => {});
}

function _cleanupRelay(tabId: number): void {
  relayConnections.delete(tabId);
}

/** Validate that a URL matches the configured backend origin. */
async function _isAllowedUrl(url: string): Promise<boolean> {
  try {
    const settings = await loadSettings();
    const candidate = new URL(url);
    const expectedPort = String(settings.port);
    // Allow both http/ws and https/wss schemes
    const allowedSchemes = ['http:', 'https:', 'ws:', 'wss:'];
    if (!allowedSchemes.includes(candidate.protocol)) return false;
    return candidate.hostname === settings.host && candidate.port === expectedPort;
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener(
  (
    msg: { type: string; url?: string; headers?: Record<string, string>; text?: string },
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean | undefined => {
    const senderTabId = sender.tab?.id;

    /* --- HTTP fetch relay (for token issuance) --- */
    if (msg.type === 'NB_FETCH') {
      if (!msg.url) {
        sendResponse({ ok: false, status: 0, body: 'Missing URL' });
        return false;
      }
      _isAllowedUrl(msg.url).then((allowed) => {
        if (!allowed) {
          sendResponse({ ok: false, status: 0, body: 'URL not allowed' });
          return;
        }
        const { Authorization } = msg.headers || {};
        const headers: Record<string, string> = {};
        if (Authorization) headers['Authorization'] = Authorization;
        fetch(msg.url!, { headers })
          .then((resp) =>
            resp.text().then((body) =>
              sendResponse({
                ok: resp.ok,
                status: resp.status,
                body,
              }),
            ),
          )
          .catch((err: Error) =>
            sendResponse({ ok: false, status: 0, body: err.message }),
          );
      });
      return true; // async sendResponse
    }

    /* --- WebSocket relay --- */
    if (msg.type === 'NB_WS_CONNECT') {
      if (senderTabId == null) {
        sendResponse({ ok: false, error: 'No sender tab' });
        return false;
      }
      if (!msg.url) {
        sendResponse({ ok: false, error: 'Missing URL' });
        return false;
      }

      _isAllowedUrl(msg.url).then((allowed) => {
        if (!allowed) {
          sendResponse({ ok: false, error: 'URL not allowed' });
          return;
        }

        // Close any existing relay connection for this tab
        const existing = relayConnections.get(senderTabId!);
        if (existing) existing.close();

        try {
          const ws = new WebSocket(msg.url!);

          ws.addEventListener('open', () => {
            _relayToTab(senderTabId!, 'NB_WS_OPEN');
          });

          ws.addEventListener('message', (e: MessageEvent) => {
            _relayToTab(senderTabId!, 'NB_WS_MESSAGE', { data: e.data });
          });

          ws.addEventListener('close', (e: CloseEvent) => {
            _relayToTab(senderTabId!, 'NB_WS_CLOSE', { code: e.code, reason: e.reason });
            _cleanupRelay(senderTabId!);
          });

          ws.addEventListener('error', () => {
            _relayToTab(senderTabId!, 'NB_WS_ERROR');
          });

          relayConnections.set(senderTabId!, ws);
          sendResponse({ ok: true });
        } catch (err: unknown) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
      });
      return true; // async sendResponse for URL validation
    }

    if (msg.type === 'NB_WS_SEND') {
      if (senderTabId == null) return false;
      const ws = relayConnections.get(senderTabId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(msg.text!);
      }
      return false;
    }

    if (msg.type === 'NB_WS_CLOSE') {
      if (senderTabId == null) return false;
      const ws = relayConnections.get(senderTabId);
      if (ws) ws.close();
      _cleanupRelay(senderTabId);
      return false;
    }

    // Unknown message type — do nothing
    return undefined;
  },
);

// ---------------------------------------------------------------------------
// Cleanup relay connections when tabs are closed
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId: number) => {
  const ws = relayConnections.get(tabId);
  if (ws) {
    ws.close();
    _cleanupRelay(tabId);
  }
});
