import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock chrome.storage.local
const storage: Record<string, unknown> = {};
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async (keys: string[]) => {
        const result: Record<string, unknown> = {};
        for (const key of keys) {
          if (key in storage) result[key] = storage[key];
        }
        return result;
      }),
      set: vi.fn(async (data: Record<string, unknown>) => {
        Object.assign(storage, data);
      }),
    },
  },
});

import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../storage';

describe('storage', () => {
  beforeEach(() => {
    Object.keys(storage).forEach((k) => delete storage[k]);
    vi.clearAllMocks();
  });

  describe('DEFAULT_SETTINGS', () => {
    it('should have expected default values', () => {
      expect(DEFAULT_SETTINGS.host).toBe('127.0.0.1');
      expect(DEFAULT_SETTINGS.port).toBe(8765);
      expect(DEFAULT_SETTINGS.path).toBe('/ws');
      expect(DEFAULT_SETTINGS.tokenIssuePath).toBe('/auth/token');
      expect(DEFAULT_SETTINGS.tokenIssueSecret).toBe('');
      expect(DEFAULT_SETTINGS.clientId).toBe('browser-extension');
    });
  });

  describe('loadSettings', () => {
    it('should return defaults when nothing is stored', async () => {
      const settings = await loadSettings();
      expect(settings).toEqual(DEFAULT_SETTINGS);
    });

    it('should merge stored settings over defaults', async () => {
      storage['nb_settings'] = { host: '192.168.1.1', port: 3000 };
      const settings = await loadSettings();
      expect(settings.host).toBe('192.168.1.1');
      expect(settings.port).toBe(3000);
      expect(settings.path).toBe(DEFAULT_SETTINGS.path);
    });

    it('should call chrome.storage.local.get with correct key', async () => {
      await loadSettings();
      expect(chrome.storage.local.get).toHaveBeenCalledWith(['nb_settings']);
    });
  });

  describe('saveSettings', () => {
    it('should persist settings to storage', async () => {
      const custom = { ...DEFAULT_SETTINGS, host: 'example.com' };
      await saveSettings(custom);
      expect(chrome.storage.local.set).toHaveBeenCalledWith({ nb_settings: custom });
    });
  });
});
