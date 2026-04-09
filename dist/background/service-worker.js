(function() {
  "use strict";
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
  let relayWs = null;
  let relayTabId = null;
  function _relayToTab(type, data) {
    if (relayTabId !== null) {
      chrome.tabs.sendMessage(relayTabId, { type, ...data }).catch(() => {
      });
    }
  }
  chrome.runtime.onMessage.addListener(
    (msg, sender, sendResponse) => {
      if (msg.type === "NB_FETCH") {
        fetch(msg.url, { headers: msg.headers || {} }).then(
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
        return true;
      }
      if (msg.type === "NB_WS_CONNECT") {
        if (relayWs) relayWs.close();
        relayTabId = sender.tab?.id ?? null;
        try {
          relayWs = new WebSocket(msg.url);
          relayWs.addEventListener("open", () => {
            _relayToTab("NB_WS_OPEN");
          });
          relayWs.addEventListener("message", (e) => {
            _relayToTab("NB_WS_MESSAGE", { data: e.data });
          });
          relayWs.addEventListener("close", (e) => {
            _relayToTab("NB_WS_CLOSE", { code: e.code, reason: e.reason });
            relayWs = null;
            relayTabId = null;
          });
          relayWs.addEventListener("error", () => {
            _relayToTab("NB_WS_ERROR");
          });
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        return false;
      }
      if (msg.type === "NB_WS_SEND") {
        if (relayWs && relayWs.readyState === WebSocket.OPEN) {
          relayWs.send(msg.text);
        }
        return false;
      }
      if (msg.type === "NB_WS_CLOSE") {
        if (relayWs) relayWs.close();
        relayWs = null;
        relayTabId = null;
        return false;
      }
      return void 0;
    }
  );
})();
