(function() {
  "use strict";
  const DEFAULT_SETTINGS = {
    host: "127.0.0.1",
    port: 8765,
    path: "/ws",
    tokenIssuePath: "/auth/token",
    tokenIssueSecret: "",
    clientId: "browser-extension"
  };
  async function loadSettings() {
    const data = await chrome.storage.local.get(["nb_settings"]);
    return { ...DEFAULT_SETTINGS, ...data.nb_settings || {} };
  }
  chrome.action.onClicked.addListener((tab) => {
    chrome.sidePanel.open({ tabId: tab.id });
  });
  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== "quick-chat") return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "NB_QUICKCHAT_TOGGLE" });
    } catch {
      try {
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ["quickchat/style.css"]
        });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: [
            "quickchat/quickchat.js"
          ]
        });
      } catch {
      }
    }
  });
  const relayConnections = /* @__PURE__ */ new Map();
  function _relayToTab(tabId, type, data) {
    chrome.tabs.sendMessage(tabId, { type, ...data }).catch(() => {
    });
  }
  function _cleanupRelay(tabId) {
    relayConnections.delete(tabId);
  }
  async function _isAllowedUrl(url) {
    try {
      const settings = await loadSettings();
      const candidate = new URL(url);
      const expectedPort = String(settings.port);
      const allowedSchemes = ["http:", "https:", "ws:", "wss:"];
      if (!allowedSchemes.includes(candidate.protocol)) return false;
      return candidate.hostname === settings.host && candidate.port === expectedPort;
    } catch {
      return false;
    }
  }
  chrome.runtime.onMessage.addListener(
    (msg, sender, sendResponse) => {
      const senderTabId = sender.tab?.id;
      if (msg.type === "NB_FETCH") {
        if (!msg.url) {
          sendResponse({ ok: false, status: 0, body: "Missing URL" });
          return false;
        }
        _isAllowedUrl(msg.url).then((allowed) => {
          if (!allowed) {
            sendResponse({ ok: false, status: 0, body: "URL not allowed" });
            return;
          }
          const { Authorization } = msg.headers || {};
          const headers = {};
          if (Authorization) headers["Authorization"] = Authorization;
          fetch(msg.url, { headers }).then(
            (resp) => resp.text().then(
              (body) => sendResponse({
                ok: resp.ok,
                status: resp.status,
                body
              })
            )
          ).catch(
            (err) => sendResponse({ ok: false, status: 0, body: err.message })
          );
        });
        return true;
      }
      if (msg.type === "NB_WS_CONNECT") {
        if (senderTabId == null) {
          sendResponse({ ok: false, error: "No sender tab" });
          return false;
        }
        if (!msg.url) {
          sendResponse({ ok: false, error: "Missing URL" });
          return false;
        }
        _isAllowedUrl(msg.url).then((allowed) => {
          if (!allowed) {
            sendResponse({ ok: false, error: "URL not allowed" });
            return;
          }
          const existing = relayConnections.get(senderTabId);
          if (existing) existing.close();
          try {
            const ws = new WebSocket(msg.url);
            ws.addEventListener("open", () => {
              _relayToTab(senderTabId, "NB_WS_OPEN");
            });
            ws.addEventListener("message", (e) => {
              _relayToTab(senderTabId, "NB_WS_MESSAGE", { data: e.data });
            });
            ws.addEventListener("close", (e) => {
              _relayToTab(senderTabId, "NB_WS_CLOSE", { code: e.code, reason: e.reason });
              _cleanupRelay(senderTabId);
            });
            ws.addEventListener("error", () => {
              _relayToTab(senderTabId, "NB_WS_ERROR");
            });
            relayConnections.set(senderTabId, ws);
            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ ok: false, error: err.message });
          }
        });
        return true;
      }
      if (msg.type === "NB_WS_SEND") {
        if (senderTabId == null) return false;
        const ws = relayConnections.get(senderTabId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(msg.text);
        }
        return false;
      }
      if (msg.type === "NB_WS_CLOSE") {
        if (senderTabId == null) return false;
        const ws = relayConnections.get(senderTabId);
        if (ws) ws.close();
        _cleanupRelay(senderTabId);
        return false;
      }
      return void 0;
    }
  );
  chrome.tabs.onRemoved.addListener((tabId) => {
    const ws = relayConnections.get(tabId);
    if (ws) {
      ws.close();
      _cleanupRelay(tabId);
    }
  });
})();
