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

import { DEFAULT_SETTINGS, loadSettings, saveSettings, validateSettings } from '../storage';

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

  describe('validateSettings', () => {
    it('should return null for valid settings', () => {
      expect(validateSettings(DEFAULT_SETTINGS)).toBeNull();
    });

    it('should return error for empty host', () => {
      expect(validateSettings({ host: '' })).toBe('Host must not be empty');
    });

    it('should return error for whitespace-only host', () => {
      expect(validateSettings({ host: '   ' })).toBe('Host must not be empty');
    });

    it('should return error for port out of range', () => {
      expect(validateSettings({ port: 0 })).toContain('between 1 and 65535');
      expect(validateSettings({ port: 99999 })).toContain('between 1 and 65535');
      expect(validateSettings({ port: -1 })).toContain('between 1 and 65535');
    });

    it('should return error for non-numeric port string', () => {
      expect(validateSettings({ port: 'abc' as unknown as number })).toContain('between 1 and 65535');
    });

    it('should return null for valid port values', () => {
      expect(validateSettings({ port: 1 })).toBeNull();
      expect(validateSettings({ port: 65535 })).toBeNull();
      expect(validateSettings({ port: 8080 })).toBeNull();
    });

    it('should return error for path not starting with /', () => {
      expect(validateSettings({ path: 'ws' })).toBe('WS Path must start with /');
    });

    it('should return null for empty path (uses default)', () => {
      expect(validateSettings({ path: '' })).toBeNull();
    });

    it('should return error for tokenIssuePath not starting with /', () => {
      expect(validateSettings({ tokenIssuePath: 'auth/token' })).toBe('Token Issue Path must start with /');
    });

    it('should return null for empty tokenIssuePath (uses default)', () => {
      expect(validateSettings({ tokenIssuePath: '' })).toBeNull();
    });
  });
});
