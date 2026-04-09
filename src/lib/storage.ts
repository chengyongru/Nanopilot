import type { Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  host: '127.0.0.1',
  port: 8765,
  path: '/ws',
  tokenIssuePath: '/auth/token',
  tokenIssueSecret: '',
  clientId: 'browser-extension',
};

export async function loadSettings(): Promise<Settings> {
  const data = await chrome.storage.local.get(['nb_settings']);
  return { ...DEFAULT_SETTINGS, ...(data.nb_settings as Partial<Settings> || {}) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ nb_settings: settings });
}
