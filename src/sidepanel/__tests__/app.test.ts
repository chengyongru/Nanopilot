import { describe, it, expect, vi, beforeEach } from 'vitest';

// Setup DOM
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(),
    },
  },
  runtime: { id: 'ext-id' },
});
vi.stubGlobal('location', { href: 'chrome-extension://abc/sidepanel/index.html' });

describe('sidepanel app', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(),
        },
      },
      runtime: { id: 'ext-id' },
    });
    vi.stubGlobal('location', { href: 'chrome-extension://abc/sidepanel/index.html' });
    document.body.innerHTML = `
      <div id="session-list"></div>
      <div id="empty-state"></div>
      <div id="messages" class="hidden"></div>
      <div id="input-bar" class="hidden"></div>
      <div id="conn-status"></div>
      <textarea id="msg-input"></textarea>
      <button id="btn-send"></button>
      <button id="btn-new"></button>
      <button id="btn-settings"></button>
      <div id="settings-overlay" class="hidden">
        <div id="settings-panel">
          <form id="settings-form">
            <input type="text" id="s-host">
            <input type="number" id="s-port">
            <input type="text" id="s-path">
            <input type="text" id="s-issue-path">
            <input type="password" id="s-secret">
            <input type="text" id="s-client-id">
          </form>
        </div>
        <button id="btn-settings-cancel"></button>
      </div>
      <button type="button" id="btn-toggle-secret">
        <svg class="eye-open"></svg>
        <svg class="eye-closed" style="display:none"></svg>
      </button>
    `;
  });

  it('should load without errors', async () => {
    await import('../app');
  });

  it('should render empty session list when no sessions', async () => {
    vi.resetModules();
    await import('../app');
    const list = document.querySelector('#session-list');
    expect(list?.textContent).toContain('No sessions');
  });
});
