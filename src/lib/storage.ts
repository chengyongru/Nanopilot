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

/** Validate settings and return an error message, or null if valid. */
export function validateSettings(s: Partial<Settings>): string | null {
  if (s.host !== undefined && (!s.host.trim())) {
    return 'Host must not be empty';
  }
  if (s.port !== undefined) {
    const port = typeof s.port === 'string' ? parseInt(s.port, 10) : s.port;
    if (isNaN(port) || port < 1 || port > 65535) {
      return 'Port must be a number between 1 and 65535';
    }
  }
  if (s.path !== undefined && s.path.trim() && !s.path.trim().startsWith('/')) {
    return 'WS Path must start with /';
  }
  if (s.tokenIssuePath !== undefined && s.tokenIssuePath.trim() && !s.tokenIssuePath.trim().startsWith('/')) {
    return 'Token Issue Path must start with /';
  }
  return null;
}
