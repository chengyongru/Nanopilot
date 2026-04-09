/**
 * Background service worker.
 * - Opens side panel on extension icon click
 * - Handles Ctrl+Shift+K quick-chat command
 * - Relays HTTP fetch and WebSocket from content scripts (bypasses CSP & mixed-content)
 */

// Click extension icon → open side panel
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Ctrl+Shift+K → toggle quick chat overlay
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'quick-chat') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  // Skip chrome:// and edge:// pages
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) return;

  try {
    // If overlay already injected, toggle it
    await chrome.tabs.sendMessage(tab.id, { type: 'NB_QUICKCHAT_TOGGLE' });
  } catch {
    // Not injected yet — inject CSS then scripts
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ['quickchat/style.css'],
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [
        'lib/storage.js',
        'lib/session.js',
        'lib/ws-client.js',
        'quickchat/quickchat.js',
      ],
    });
  }
});

/* -- Message relay ---------------------------------------------------- */

/** Active WebSocket relay connection (one at a time). */
let relayWs = null;
let relayTabId = null;

function _relayToTab(type, data) {
  if (relayTabId) {
    chrome.tabs.sendMessage(relayTabId, { type, ...data }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  /* --- HTTP fetch relay (for token issuance) --- */
  if (msg.type === 'NB_FETCH') {
    fetch(msg.url, { headers: msg.headers || {} })
      .then((resp) => resp.text().then((body) => sendResponse({
        ok: resp.ok,
        status: resp.status,
        body,
      })))
      .catch((err) => sendResponse({ ok: false, status: 0, body: err.message }));
    return true; // async sendResponse
  }

  /* --- WebSocket relay --- */
  if (msg.type === 'NB_WS_CONNECT') {
    // Close any existing relay connection
    if (relayWs) relayWs.close();

    relayTabId = sender.tab?.id ?? null;

    try {
      relayWs = new WebSocket(msg.url);

      relayWs.addEventListener('open', () => {
        _relayToTab('NB_WS_OPEN');
      });

      relayWs.addEventListener('message', (e) => {
        _relayToTab('NB_WS_MESSAGE', { data: e.data });
      });

      relayWs.addEventListener('close', (e) => {
        _relayToTab('NB_WS_CLOSE', { code: e.code, reason: e.reason });
        relayWs = null;
        relayTabId = null;
      });

      relayWs.addEventListener('error', () => {
        _relayToTab('NB_WS_ERROR');
      });

      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return false;
  }

  if (msg.type === 'NB_WS_SEND') {
    if (relayWs && relayWs.readyState === WebSocket.OPEN) {
      relayWs.send(msg.text);
    }
    return false;
  }

  if (msg.type === 'NB_WS_CLOSE') {
    if (relayWs) relayWs.close();
    relayWs = null;
    relayTabId = null;
    return false;
  }
});
