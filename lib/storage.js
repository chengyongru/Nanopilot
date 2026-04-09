/**
 * Settings storage helpers.
 */

const DEFAULT_SETTINGS = {
  host: '127.0.0.1',
  port: 8765,
  path: '/ws',
  tokenIssuePath: '/auth/token',
  tokenIssueSecret: '',
  clientId: 'browser-extension',
};

async function loadSettings() {
  const data = await chrome.storage.local.get(['nb_settings']);
  return { ...DEFAULT_SETTINGS, ...(data.nb_settings || {}) };
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ nb_settings: settings });
}
