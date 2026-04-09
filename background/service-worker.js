/**
 * Background service worker.
 * - Opens side panel on extension icon click
 * - Handles Ctrl+K quick-chat command
 */

// Click extension icon → open side panel
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Ctrl+K → toggle quick chat overlay
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
