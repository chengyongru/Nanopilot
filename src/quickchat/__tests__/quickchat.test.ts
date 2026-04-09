import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubGlobal('chrome', {
  runtime: {
    id: 'ext-id',
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    sendMessage: vi.fn(),
  },
  storage: {
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(),
    },
  },
});

vi.stubGlobal('location', { href: 'https://example.com' });
vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });

describe('quickchat', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    document.body.innerHTML = '';
    delete (window as any).__nb_qc;
  });

  it('should create overlay DOM on load', async () => {
    await import('../quickchat');
    expect(document.querySelector('#nb-qc-container')).toBeTruthy();
    expect(document.querySelector('#nb-qc-backdrop')).toBeTruthy();
  });

  it('should expose toggle on window.__nb_qc', async () => {
    await import('../quickchat');
    expect((window as any).__nb_qc).toBeTruthy();
    expect(typeof (window as any).__nb_qc.toggle).toBe('function');
  });
});
