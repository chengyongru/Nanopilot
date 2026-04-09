/**
 * Background service worker.
 * - Opens side panel on extension icon click
 * - Handles Ctrl+Shift+K quick-chat command
 * - Relays HTTP fetch and WebSocket from content scripts (bypasses CSP & mixed-content)
 */

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
// Message relay
// ---------------------------------------------------------------------------

/** Active WebSocket relay connection (one at a time). */
let relayWs: WebSocket | null = null;
let relayTabId: number | null = null;

function _relayToTab(type: string, data?: Record<string, unknown>): void {
  if (relayTabId !== null) {
    chrome.tabs.sendMessage(relayTabId, { type, ...data }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener(
  (
    msg: { type: string; url?: string; headers?: Record<string, string>; text?: string },
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean | undefined => {
    /* --- HTTP fetch relay (for token issuance) --- */
    if (msg.type === 'NB_FETCH') {
      fetch(msg.url!, { headers: msg.headers || {} })
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
      return true; // async sendResponse
    }

    /* --- WebSocket relay --- */
    if (msg.type === 'NB_WS_CONNECT') {
      // Close any existing relay connection
      if (relayWs) relayWs.close();

      relayTabId = sender.tab?.id ?? null;

      try {
        relayWs = new WebSocket(msg.url!);

        relayWs.addEventListener('open', () => {
          _relayToTab('NB_WS_OPEN');
        });

        relayWs.addEventListener('message', (e: MessageEvent) => {
          _relayToTab('NB_WS_MESSAGE', { data: e.data });
        });

        relayWs.addEventListener('close', (e: CloseEvent) => {
          _relayToTab('NB_WS_CLOSE', { code: e.code, reason: e.reason });
          relayWs = null;
          relayTabId = null;
        });

        relayWs.addEventListener('error', () => {
          _relayToTab('NB_WS_ERROR');
        });

        sendResponse({ ok: true });
      } catch (err: unknown) {
        sendResponse({ ok: false, error: (err as Error).message });
      }
      return false;
    }

    if (msg.type === 'NB_WS_SEND') {
      if (relayWs && relayWs.readyState === WebSocket.OPEN) {
        relayWs.send(msg.text!);
      }
      return false;
    }

    if (msg.type === 'NB_WS_CLOSE') {
      if (relayWs) relayWs.close();
      relayWs = null;
      relayTabId = null;
      return false;
    }

    // Unknown message type — do nothing
    return undefined;
  },
);
