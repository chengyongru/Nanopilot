# TypeScript Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor the Nanobot Chrome extension from plain JavaScript to TypeScript with Vite build, Vitest unit tests at 90%+ coverage, while keeping "Load unpacked" working for non-technical users.

**Architecture:** Source code moves to `src/`, Vite builds to `dist/` (committed to git). Three separate Vite entry points: service-worker, sidepanel, quickchat. Shared `lib/` code imported as ES modules. Chrome APIs typed with `@types/chrome`. Tests mock `chrome.*` APIs.

**Tech Stack:** TypeScript, Vite, Vitest, @types/chrome, jsdom

---

### Task 1: Project scaffolding — package.json, tsconfig, vite.config

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Modify: `.gitignore`

**Step 1: Initialize package.json**

```bash
npm init -y
```

Then replace `package.json` contents with:

```json
{
  "name": "nanobot-extension",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev": "vite build --watch",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vite": "^6.2.0",
    "@crxjs/vite-plugin": "^2.0.0-beta.25",
    "vitest": "^3.0.0",
    "@vitest/coverage-v8": "^3.0.0",
    "jsdom": "^26.0.0",
    "@types/chrome": "^0.0.304",
    "fake-indexeddb": "^6.0.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": false,
    "sourceMap": false,
    "types": ["chrome"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 3: Create vite.config.ts**

```typescript
import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, cpSync, existsSync } from 'fs';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        'service-worker': resolve(__dirname, 'src/background/service-worker.ts'),
        'sidepanel/app': resolve(__dirname, 'src/sidepanel/app.ts'),
        'quickchat/quickchat': resolve(__dirname, 'src/quickchat/quickchat.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
  },
});

// Custom plugin to copy manifest and static assets
function copyExtensionFiles() {
  return {
    name: 'copy-extension-files',
    closeBundle() {
      // Copy manifest.json
      copyFileSync('manifest.json', 'dist/manifest.json');

      // Copy icons
      if (!existsSync('dist/icons')) mkdirSync('dist/icons', { recursive: true });
      cpSync('icons', 'dist/icons', { recursive: true });

      // Copy sidepanel HTML + CSS
      if (!existsSync('dist/sidepanel')) mkdirSync('dist/sidepanel', { recursive: true });
      cpSync('src/sidepanel/index.html', 'dist/sidepanel/index.html');
      cpSync('src/sidepanel/style.css', 'dist/sidepanel/style.css');

      // Copy quickchat CSS
      if (!existsSync('dist/quickchat')) mkdirSync('dist/quickchat', { recursive: true });
      cpSync('src/quickchat/style.css', 'dist/quickchat/style.css');
    },
  };
}
```

> **Important:** The vite.config.ts plugin code above is a sketch. The actual implementation should:
> - Use `copyFileSync` / `cpSync` from `node:fs`
> - The sidepanel HTML references scripts — it needs to be updated to point to the bundled output path

**Step 4: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts'],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
```

**Step 5: Update .gitignore**

Add `node_modules/` and `.vitest/`. Ensure `dist/` is NOT ignored (it must be committed for end users).

```
node_modules/
.vitest/
*.tsbuildinfo
```

**Step 6: Install dependencies**

```bash
npm install
```

**Step 7: Verify setup**

```bash
npx tsc --version
npx vite --version
npx vitest --version
```

Expected: All three commands print version numbers.

**Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts vitest.config.ts .gitignore
git commit -m "chore: scaffold TypeScript + Vite + Vitest project"
```

---

### Task 2: Move source files to src/ and convert lib/storage.ts

**Files:**
- Create: `src/lib/storage.ts`
- Create: `src/lib/types.ts`

**Step 1: Create shared types**

Create `src/lib/types.ts`:

```typescript
/** Settings stored in chrome.storage.local. */
export interface Settings {
  host: string;
  port: number;
  path: string;
  tokenIssuePath: string;
  tokenIssueSecret: string;
  clientId: string;
}

/** A single message in a chat session. */
export interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  done?: boolean;
}

/** A chat session with its message history. */
export interface Session {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

/** Relay message types for background ↔ content script communication. */
export type RelayMessageType =
  | { type: 'NB_FETCH'; url: string; headers?: Record<string, string> }
  | { type: 'NB_WS_CONNECT'; url: string }
  | { type: 'NB_WS_SEND'; text: string }
  | { type: 'NB_WS_CLOSE' }
  | { type: 'NB_WS_OPEN' }
  | { type: 'NB_WS_MESSAGE'; data: string }
  | { type: 'NB_WS_CLOSE'; code: number; reason: string }
  | { type: 'NB_WS_ERROR' }
  | { type: 'NB_QUICKCHAT_TOGGLE' };

/** Fetch relay response. */
export interface FetchRelayResponse {
  ok: boolean;
  status: number;
  body: string;
}

/** WebSocket relay connect response. */
export interface WsRelayResponse {
  ok: boolean;
  error?: string;
}

/** Events emitted by NanobotWsClient. */
export type WsClientEvent = 'ready' | 'delta' | 'stream_end' | 'message' | 'close' | 'error' | 'unknown';

/** Server frame data. */
export interface ServerFrame {
  event: string;
  chat_id?: string;
  text?: string;
  [key: string]: unknown;
}
```

**Step 2: Write tests for storage.ts**

Create `src/lib/__tests__/storage.test.ts`:

```typescript
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
      expect(settings.path).toBe(DEFAULT_SETTINGS.path); // default preserved
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
```

**Step 3: Run tests to verify they fail**

```bash
npx vitest run src/lib/__tests__/storage.test.ts
```

Expected: FAIL — module `../storage` not found.

**Step 4: Create src/lib/storage.ts**

```typescript
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
```

**Step 5: Run tests to verify they pass**

```bash
npx vitest run src/lib/__tests__/storage.test.ts
```

Expected: All tests PASS.

**Step 6: Commit**

```bash
git add src/lib/types.ts src/lib/storage.ts src/lib/__tests__/storage.test.ts
git commit -m "refactor: convert lib/storage to TypeScript with types"
```

---

### Task 3: Convert lib/session.ts with tests

**Files:**
- Create: `src/lib/session.ts`
- Create: `src/lib/__tests__/session.test.ts`

**Step 1: Write tests for SessionManager**

Create `src/lib/__tests__/session.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock chrome.storage.local
const storage: Record<string, unknown> = {};
let persistCallback: (() => void) | null = null;

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
        if (persistCallback) persistCallback();
      }),
    },
  },
});

// Mock crypto.randomUUID
let uuidCounter = 0;
vi.stubGlobal('crypto', {
  randomUUID: () => `uuid-${++uuidCounter}`,
});

import { SessionManager } from '../session';

describe('SessionManager', () => {
  let sm: SessionManager;

  beforeEach(() => {
    Object.keys(storage).forEach((k) => delete storage[k]);
    uuidCounter = 0;
    vi.clearAllMocks();
    sm = new SessionManager();
  });

  describe('load', () => {
    it('should load sessions from storage', async () => {
      storage['nb_sessions'] = { 'id-1': { id: 'id-1', title: 'Test', messages: [], createdAt: 100, updatedAt: 200 } };
      storage['nb_active_session'] = 'id-1';
      await sm.load();
      expect(sm.sessions['id-1']).toBeDefined();
      expect(sm.activeId).toBe('id-1');
    });

    it('should handle empty storage', async () => {
      await sm.load();
      expect(sm.sessions).toEqual({});
      expect(sm.activeId).toBeNull();
    });
  });

  describe('create', () => {
    it('should create a new session with defaults', () => {
      const id = sm.create('My Chat');
      expect(id).toBe('uuid-1');
      expect(sm.sessions[id].title).toBe('My Chat');
      expect(sm.sessions[id].messages).toEqual([]);
      expect(sm.activeId).toBe(id);
    });

    it('should default title to "New Chat" when none provided', () => {
      const id = sm.create();
      expect(sm.sessions[id].title).toBe('New Chat');
    });

    it('should persist after create', () => {
      sm.create('Test');
      expect(chrome.storage.local.set).toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('should return session by id', () => {
      const id = sm.create('Test');
      expect(sm.get(id)?.title).toBe('Test');
    });

    it('should return null for unknown id', () => {
      expect(sm.get('nonexistent')).toBeNull();
    });
  });

  describe('getActive', () => {
    it('should return the active session', () => {
      const id = sm.create('Active');
      expect(sm.getActive()?.id).toBe(id);
    });

    it('should return null when no active session', () => {
      expect(sm.getActive()).toBeNull();
    });
  });

  describe('setActive', () => {
    it('should set active session by id', () => {
      const id1 = sm.create('First');
      const id2 = sm.create('Second');
      sm.setActive(id1);
      expect(sm.activeId).toBe(id1);
    });

    it('should not change activeId for non-existent session', () => {
      const id = sm.create('First');
      sm.setActive('nonexistent');
      expect(sm.activeId).toBe(id);
    });

    it('should persist after setActive', () => {
      const id = sm.create('Test');
      sm.setActive(id);
      expect(chrome.storage.local.set).toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('should return sessions sorted by updatedAt descending', () => {
      const id1 = sm.create('Old');
      const id2 = sm.create('New');
      // id2 is created after id1, so its updatedAt is higher
      const list = sm.list();
      expect(list[0].id).toBe(id2);
      expect(list[1].id).toBe(id1);
    });

    it('should return empty array when no sessions', () => {
      expect(sm.list()).toEqual([]);
    });
  });

  describe('addMessage', () => {
    it('should add a message to a session', () => {
      const id = sm.create('Test');
      sm.addMessage(id, 'user', 'Hello');
      expect(sm.sessions[id].messages).toHaveLength(1);
      expect(sm.sessions[id].messages[0].role).toBe('user');
      expect(sm.sessions[id].messages[0].content).toBe('Hello');
    });

    it('should update updatedAt on addMessage', () => {
      const id = sm.create('Test');
      const originalUpdatedAt = sm.sessions[id].updatedAt;
      sm.addMessage(id, 'user', 'Hello');
      expect(sm.sessions[id].updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt);
    });

    it('should do nothing for non-existent session', () => {
      sm.addMessage('nonexistent', 'user', 'Hello');
      expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    it('should persist after addMessage', () => {
      const id = sm.create('Test');
      sm.addMessage(id, 'user', 'Hello');
      expect(chrome.storage.local.set).toHaveBeenCalled();
    });
  });

  describe('appendToLastAssistant', () => {
    it('should append text to last assistant message if not done', () => {
      const id = sm.create('Test');
      sm.addMessage(id, 'assistant', 'Hello');
      sm.appendToLastAssistant(id, ' World');
      expect(sm.sessions[id].messages[0].content).toBe('Hello World');
    });

    it('should create new assistant message if last is user or done', () => {
      const id = sm.create('Test');
      sm.addMessage(id, 'user', 'Hi');
      sm.appendToLastAssistant(id, 'Response');
      expect(sm.sessions[id].messages).toHaveLength(2);
      expect(sm.sessions[id].messages[1].role).toBe('assistant');
      expect(sm.sessions[id].messages[1].content).toBe('Response');
      expect(sm.sessions[id].messages[1].done).toBe(false);
    });

    it('should create new message if no messages exist', () => {
      const id = sm.create('Test');
      sm.appendToLastAssistant(id, 'First');
      expect(sm.sessions[id].messages).toHaveLength(1);
      expect(sm.sessions[id].messages[0].role).toBe('assistant');
    });

    it('should do nothing for non-existent session', () => {
      sm.appendToLastAssistant('nonexistent', 'text');
      expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });
  });

  describe('markLastAssistantDone', () => {
    it('should mark last assistant message as done', () => {
      const id = sm.create('Test');
      sm.addMessage(id, 'assistant', 'Hello');
      sm.markLastAssistantDone(id);
      expect(sm.sessions[id].messages[0].done).toBe(true);
    });

    it('should do nothing if last message is user', () => {
      const id = sm.create('Test');
      sm.addMessage(id, 'user', 'Hi');
      sm.markLastAssistantDone(id);
      expect(sm.sessions[id].messages[0].done).toBeUndefined();
    });

    it('should do nothing for non-existent session', () => {
      sm.markLastAssistantDone('nonexistent');
    });
  });

  describe('delete', () => {
    it('should delete a session', () => {
      const id = sm.create('Test');
      sm.delete(id);
      expect(sm.sessions[id]).toBeUndefined();
    });

    it('should set activeId to another session if active was deleted', () => {
      const id1 = sm.create('First');
      const id2 = sm.create('Second');
      sm.setActive(id1);
      sm.delete(id1);
      expect(sm.activeId).toBe(id2);
    });

    it('should set activeId to null if last session deleted', () => {
      const id = sm.create('Only');
      sm.delete(id);
      expect(sm.activeId).toBeNull();
    });
  });

  describe('rename', () => {
    it('should rename a session', () => {
      const id = sm.create('Old');
      sm.rename(id, 'New');
      expect(sm.sessions[id].title).toBe('New');
    });

    it('should update updatedAt on rename', () => {
      const id = sm.create('Old');
      const originalUpdatedAt = sm.sessions[id].updatedAt;
      sm.rename(id, 'New');
      expect(sm.sessions[id].updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt);
    });

    it('should do nothing for non-existent session', () => {
      sm.rename('nonexistent', 'Name');
    });
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/lib/__tests__/session.test.ts
```

Expected: FAIL — module not found.

**Step 3: Create src/lib/session.ts**

```typescript
import type { Session, Message } from './types';

export class SessionManager {
  sessions: Record<string, Session> = {};
  activeId: string | null = null;

  async load(): Promise<void> {
    const data = await chrome.storage.local.get(['nb_sessions', 'nb_active_session']);
    this.sessions = (data.nb_sessions as Record<string, Session>) || {};
    this.activeId = (data.nb_active_session as string) || null;
  }

  _persist(): void {
    chrome.storage.local.set({
      nb_sessions: this.sessions,
      nb_active_session: this.activeId,
    });
  }

  create(title?: string): string {
    const id = crypto.randomUUID();
    this.sessions[id] = {
      id,
      title: title || 'New Chat',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.activeId = id;
    this._persist();
    return id;
  }

  get(id: string): Session | null {
    return this.sessions[id] || null;
  }

  getActive(): Session | null {
    return this.sessions[this.activeId ?? ''] || null;
  }

  setActive(id: string): void {
    if (this.sessions[id]) {
      this.activeId = id;
      this._persist();
    }
  }

  list(): Session[] {
    return Object.values(this.sessions).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  addMessage(sessionId: string, role: Message['role'], content: string): void {
    const s = this.sessions[sessionId];
    if (!s) return;
    s.messages.push({ role, content, timestamp: Date.now() });
    s.updatedAt = Date.now();
    this._persist();
  }

  appendToLastAssistant(sessionId: string, text: string): void {
    const s = this.sessions[sessionId];
    if (!s) return;
    const last = s.messages[s.messages.length - 1];
    if (last && last.role === 'assistant' && !last.done) {
      last.content += text;
    } else {
      s.messages.push({ role: 'assistant', content: text, timestamp: Date.now(), done: false });
    }
    s.updatedAt = Date.now();
    this._persist();
  }

  markLastAssistantDone(sessionId: string): void {
    const s = this.sessions[sessionId];
    if (!s) return;
    const last = s.messages[s.messages.length - 1];
    if (last && last.role === 'assistant') {
      last.done = true;
      this._persist();
    }
  }

  delete(id: string): void {
    delete this.sessions[id];
    if (this.activeId === id) {
      const keys = Object.keys(this.sessions);
      this.activeId = keys.length ? keys[keys.length - 1] : null;
    }
    this._persist();
  }

  rename(id: string, title: string): void {
    const s = this.sessions[id];
    if (s) {
      s.title = title;
      s.updatedAt = Date.now();
      this._persist();
    }
  }
}
```

**Step 4: Run tests**

```bash
npx vitest run src/lib/__tests__/session.test.ts
```

Expected: All tests PASS.

**Step 5: Commit**

```bash
git add src/lib/session.ts src/lib/__tests__/session.test.ts
git commit -m "refactor: convert lib/session to TypeScript with tests"
```

---

### Task 4: Convert lib/ws-client.ts with tests

**Files:**
- Create: `src/lib/ws-client.ts`
- Create: `src/lib/__tests__/ws-client.test.ts`

This is the most complex module. It has direct WebSocket and relay modes. Key areas to test:
- EventEmitter (on/off/_emit)
- `_isContentScript()` detection
- `_issueToken()` with direct fetch
- `_issueToken()` with relayed fetch
- `connect()` → `_connectDirect()`
- `connect()` → `_connectRelay()`
- `_handleFrame()` parsing
- `send()` / `sendJSON()`
- `disconnect()`
- `connected` getter

**Step 1: Write tests**

Create `src/lib/__tests__/ws-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NanobotWsClient } from '../ws-client';
import type { Settings } from '../types';

const mockSettings: Settings = {
  host: '127.0.0.1',
  port: 8765,
  path: '/ws',
  tokenIssuePath: '/auth/token',
  tokenIssueSecret: 'my-secret',
  clientId: 'browser-extension',
};

// --- Mock helpers ---

function mockDirectMode() {
  vi.stubGlobal('location', { href: 'chrome-extension://abc123/sidepanel/index.html' });
}

function mockContentScriptMode() {
  vi.stubGlobal('location', { href: 'https://example.com/page' });
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'ext-id',
      sendMessage: vi.fn(),
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
  });
}

function mockFetchSuccess(body: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  }));
}

describe('NanobotWsClient', () => {
  let client: NanobotWsClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    client = new NanobotWsClient(mockSettings);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('EventEmitter', () => {
    it('should register and call listeners via on()', () => {
      const fn = vi.fn();
      client.on('ready', fn);
      client._emit('ready', { chat_id: 'abc' });
      expect(fn).toHaveBeenCalledWith({ chat_id: 'abc' });
    });

    it('should support multiple listeners for same event', () => {
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      client.on('delta', fn1);
      client.on('delta', fn2);
      client._emit('delta', { text: 'hi' });
      expect(fn1).toHaveBeenCalled();
      expect(fn2).toHaveBeenCalled();
    });

    it('should remove listeners via off()', () => {
      const fn = vi.fn();
      client.on('ready', fn);
      client.off('ready', fn);
      client._emit('ready', {});
      expect(fn).not.toHaveBeenCalled();
    });

    it('should not crash if listener throws', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      client.on('error', () => { throw new Error('boom'); });
      expect(() => client._emit('error', {})).not.toThrow();
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('should return this from on() for chaining', () => {
      const result = client.on('ready', () => {});
      expect(result).toBe(client);
    });

    it('should return this from off() for chaining', () => {
      const fn = () => {};
      client.on('ready', fn);
      expect(client.off('ready', fn)).toBe(client);
    });
  });

  describe('_isContentScript', () => {
    it('should return false in extension page', () => {
      mockDirectMode();
      expect(client._isContentScript()).toBe(false);
    });

    it('should return true in content script', () => {
      mockContentScriptMode();
      expect(client._isContentScript()).toBe(true);
    });

    it('should return false when chrome.runtime is undefined', () => {
      vi.stubGlobal('chrome', {});
      expect(client._isContentScript()).toBe(false);
    });
  });

  describe('_issueToken', () => {
    it('should fetch token directly in extension page', async () => {
      mockDirectMode();
      mockFetchSuccess({ token: 'test-token-123' });

      const token = await client._issueToken();
      expect(token).toBe('test-token-123');
      expect(fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:8765/auth/token',
        expect.objectContaining({ headers: { Authorization: 'Bearer my-secret' } })
      );
    });

    it('should not send Authorization header when secret is empty', async () => {
      mockDirectMode();
      client.settings = { ...mockSettings, tokenIssueSecret: '' };
      mockFetchSuccess({ token: 'test-token' });

      await client._issueToken();
      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ headers: {} })
      );
    });

    it('should relay fetch in content script mode', async () => {
      mockContentScriptMode();
      (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        status: 200,
        body: JSON.stringify({ token: 'relay-token' }),
      });

      const token = await client._issueToken();
      expect(token).toBe('relay-token');
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: 'NB_FETCH',
        url: 'http://127.0.0.1:8765/auth/token',
        headers: { Authorization: 'Bearer my-secret' },
      });
    });

    it('should throw on failed direct fetch', async () => {
      mockDirectMode();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
      }));

      await expect(client._issueToken()).rejects.toThrow('Token issue failed: HTTP 403');
    });

    it('should throw on failed relayed fetch', async () => {
      mockContentScriptMode();
      (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 403,
        body: '',
      });

      await expect(client._issueToken()).rejects.toThrow('Token issue failed: HTTP 403');
    });
  });

  describe('_handleFrame', () => {
    it('should emit "ready" event with chat_id', () => {
      const fn = vi.fn();
      client.on('ready', fn);
      client._handleFrame(JSON.stringify({ event: 'ready', chat_id: 'abc123' }));
      expect(fn).toHaveBeenCalledWith({ event: 'ready', chat_id: 'abc123' });
      expect(client.chatId).toBe('abc123');
    });

    it('should emit "delta" event', () => {
      const fn = vi.fn();
      client.on('delta', fn);
      client._handleFrame(JSON.stringify({ event: 'delta', text: 'Hello' }));
      expect(fn).toHaveBeenCalledWith({ event: 'delta', text: 'Hello' });
    });

    it('should emit "stream_end" event', () => {
      const fn = vi.fn();
      client.on('stream_end', fn);
      client._handleFrame(JSON.stringify({ event: 'stream_end' }));
      expect(fn).toHaveBeenCalled();
    });

    it('should emit "message" event', () => {
      const fn = vi.fn();
      client.on('message', fn);
      client._handleFrame(JSON.stringify({ event: 'message', text: 'Full response' }));
      expect(fn).toHaveBeenCalledWith({ event: 'message', text: 'Full response' });
    });

    it('should emit "unknown" event for unrecognized event type', () => {
      const fn = vi.fn();
      client.on('unknown', fn);
      client._handleFrame(JSON.stringify({ event: 'custom_event', data: 42 }));
      expect(fn).toHaveBeenCalled();
    });

    it('should silently ignore non-JSON frames', () => {
      const fn = vi.fn();
      client.on('ready', fn);
      expect(() => client._handleFrame('not-json')).not.toThrow();
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('send / sendJSON', () => {
    it('sendJSON should call send with JSON string', () => {
      const sendSpy = vi.spyOn(client, 'send');
      client.sendJSON({ text: 'hello' });
      expect(sendSpy).toHaveBeenCalledWith('{"text":"hello"}');
    });
  });

  describe('connected getter', () => {
    it('should return false when no connection', () => {
      expect(client.connected).toBe(false);
    });

    it('should return true in relay mode when connected', () => {
      client._relayed = true;
      client._relayConnected = true;
      expect(client.connected).toBe(true);
    });

    it('should return true in direct mode when ws is open', () => {
      const mockWs = { readyState: WebSocket.OPEN } as WebSocket;
      client.ws = mockWs;
      client._relayed = false;
      expect(client.connected).toBe(true);
    });

    it('should return false when ws is connecting', () => {
      const mockWs = { readyState: WebSocket.CONNECTING } as WebSocket;
      client.ws = mockWs;
      client._relayed = false;
      expect(client.connected).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('should close ws and clear state in direct mode', () => {
      const mockWs = { close: vi.fn() } as unknown as WebSocket;
      client.ws = mockWs;
      client.chatId = 'abc';
      client.disconnect();
      expect(mockWs.close).toHaveBeenCalled();
      expect(client.ws).toBeNull();
      expect(client.chatId).toBeNull();
    });

    it('should send close message and remove listener in relay mode', () => {
      mockContentScriptMode();
      const removeListenerSpy = vi.fn();
      client._relayed = true;
      client._relayConnected = true;
      client._relayListener = vi.fn();
      (chrome.runtime.onMessage as unknown as { removeListener: ReturnType<typeof vi.fn> })
        .removeListener = removeListenerSpy;

      client.disconnect();
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'NB_WS_CLOSE' });
      expect(removeListenerSpy).toHaveBeenCalled();
      expect(client._relayConnected).toBe(false);
      expect(client.chatId).toBeNull();
    });
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/lib/__tests__/ws-client.test.ts
```

Expected: FAIL.

**Step 3: Create src/lib/ws-client.ts**

```typescript
import type { Settings, WsClientEvent, ServerFrame } from './types';

type Listener = (data: Record<string, unknown>) => void;

export class NanobotWsClient {
  settings: Settings;
  ws: WebSocket | null = null;
  chatId: string | null = null;
  private _listeners = new Map<string, Listener[]>();
  _relayed = false;
  _relayConnected = false;
  _relayListener: ((msg: Record<string, unknown>) => void) | null = null;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  /* -- EventEmitter --------------------------------------------------- */

  on(event: WsClientEvent | string, fn: Listener): this {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event)!.push(fn);
    return this;
  }

  off(event: WsClientEvent | string, fn: Listener): this {
    const list = this._listeners.get(event);
    if (list) this._listeners.set(event, list.filter(f => f !== fn));
    return this;
  }

  _emit(event: string, data: Record<string, unknown>): void {
    (this._listeners.get(event) || []).forEach(fn => {
      try { fn(data); } catch (e) { console.error('[ws-client] listener error', e); }
    });
  }

  /* -- Context detection ----------------------------------------------- */

  _isContentScript(): boolean {
    try {
      return !!(chrome.runtime?.id && !location.href.startsWith('chrome-extension://'));
    } catch {
      return false;
    }
  }

  /* -- Token issuance ------------------------------------------------- */

  async _issueToken(): Promise<string> {
    const { host, port, tokenIssuePath, tokenIssueSecret } = this.settings;
    const url = `http://${host}:${port}${tokenIssuePath}`;
    const headers: Record<string, string> = {};
    if (tokenIssueSecret) {
      headers['Authorization'] = `Bearer ${tokenIssueSecret}`;
    }

    if (this._isContentScript()) {
      const result = await chrome.runtime.sendMessage({
        type: 'NB_FETCH', url, headers,
      }) as { ok: boolean; status: number; body: string } | undefined;
      if (!result || !result.ok) {
        throw new Error(`Token issue failed: HTTP ${result?.status ?? 'no response'}`);
      }
      return JSON.parse(result.body).token;
    }

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      throw new Error(`Token issue failed: HTTP ${resp.status}`);
    }
    const data = await resp.json() as { token: string };
    return data.token;
  }

  /* -- Connection ----------------------------------------------------- */

  async connect(): Promise<void> {
    if (this.ws) this.disconnect();

    const token = await this._issueToken();
    const { host, port, path, clientId } = this.settings;
    const url = `ws://${host}:${port}${path}?client_id=${encodeURIComponent(clientId)}&token=${encodeURIComponent(token)}`;

    if (this._isContentScript()) {
      return this._connectRelay(url);
    }
    return this._connectDirect(url);
  }

  _connectDirect(url: string): Promise<void> {
    this._relayed = false;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      const onOpen = () => {
        this.ws!.removeEventListener('open', onOpen);
        this.ws!.removeEventListener('error', onError);
        resolve();
      };

      const onError = () => {
        this.ws!.removeEventListener('open', onOpen);
        this.ws!.removeEventListener('error', onError);
        reject(new Error('WebSocket connection failed'));
      };

      this.ws.addEventListener('open', onOpen);
      this.ws.addEventListener('error', onError);

      this.ws.addEventListener('message', (e) => this._handleFrame(e.data as string));
      this.ws.addEventListener('close', (e) => {
        this._emit('close', { code: e.code, reason: e.reason });
        this.ws = null;
      });
      this.ws.addEventListener('error', () => this._emit('error', {}));
    });
  }

  async _connectRelay(url: string): Promise<void> {
    this._relayed = true;
    this._relayConnected = false;

    this._relayListener = (msg: Record<string, unknown>) => {
      if (msg.type === 'NB_WS_MESSAGE') this._handleFrame(msg.data as string);
      else if (msg.type === 'NB_WS_OPEN') {
        this._relayConnected = true;
      }
      else if (msg.type === 'NB_WS_CLOSE') {
        this._relayConnected = false;
        this._emit('close', { code: msg.code, reason: msg.reason });
      }
      else if (msg.type === 'NB_WS_ERROR') {
        this._emit('error', {});
      }
    };
    chrome.runtime.onMessage.addListener(this._relayListener as (msg: unknown) => void);

    const result = await chrome.runtime.sendMessage({ type: 'NB_WS_CONNECT', url }) as { ok: boolean } | undefined;
    if (!result?.ok) {
      throw new Error('WebSocket relay failed');
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket relay timeout')), 10000);
      const check = () => {
        if (this._relayConnected) { clearTimeout(timeout); resolve(); }
        else setTimeout(check, 50);
      };
      check();
    });
  }

  _handleFrame(raw: string): void {
    try {
      const data = JSON.parse(raw) as ServerFrame;
      const event = data.event;
      if (event === 'ready') {
        this.chatId = data.chat_id ?? null;
        this._emit('ready', data as unknown as Record<string, unknown>);
      } else if (event === 'delta') {
        this._emit('delta', data as unknown as Record<string, unknown>);
      } else if (event === 'stream_end') {
        this._emit('stream_end', data as unknown as Record<string, unknown>);
      } else if (event === 'message') {
        this._emit('message', data as unknown as Record<string, unknown>);
      } else {
        this._emit('unknown', data as unknown as Record<string, unknown>);
      }
    } catch {
      // Non-JSON frame, ignore
    }
  }

  /* -- Sending -------------------------------------------------------- */

  send(text: string): void {
    if (this._relayed) {
      chrome.runtime.sendMessage({ type: 'NB_WS_SEND', text });
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(text);
    }
  }

  sendJSON(obj: Record<string, unknown>): void {
    this.send(JSON.stringify(obj));
  }

  /* -- Teardown ------------------------------------------------------- */

  disconnect(): void {
    if (this._relayed) {
      chrome.runtime.sendMessage({ type: 'NB_WS_CLOSE' });
      this._relayConnected = false;
      if (this._relayListener) {
        chrome.runtime.onMessage.removeListener(this._relayListener as (msg: unknown) => void);
        this._relayListener = null;
      }
      this._relayed = false;
    } else if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.chatId = null;
  }

  get connected(): boolean {
    if (this._relayed) return this._relayConnected;
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
```

**Step 4: Run tests**

```bash
npx vitest run src/lib/__tests__/ws-client.test.ts
```

Expected: All tests PASS.

**Step 5: Commit**

```bash
git add src/lib/ws-client.ts src/lib/__tests__/ws-client.test.ts
git commit -m "refactor: convert lib/ws-client to TypeScript with tests"
```

---

### Task 5: Convert background/service-worker.ts with tests

**Files:**
- Create: `src/background/service-worker.ts`
- Create: `src/background/__tests__/service-worker.test.ts`

The service worker has three concerns:
1. `chrome.action.onClicked` → open side panel
2. `chrome.commands.onCommand` → toggle quick chat (inject or toggle)
3. Message relay for `NB_FETCH`, `NB_WS_CONNECT`, `NB_WS_SEND`, `NB_WS_CLOSE`

To make it testable, extract the relay logic into a testable class/function, and keep the top-level `chrome.*.addListener` calls as thin wiring.

**Step 1: Write tests**

Create `src/background/__tests__/service-worker.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock chrome APIs
const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

function createMockChrome() {
  return {
    action: {
      onClicked: {
        addListener: vi.fn((fn: (...args: unknown[]) => void) => { listeners['action'] = [fn]; }),
      },
    },
    commands: {
      onCommand: {
        addListener: vi.fn((fn: (...args: unknown[]) => void) => { listeners['command'] = [fn]; }),
      },
    },
    tabs: {
      query: vi.fn(),
      sendMessage: vi.fn(),
    },
    scripting: {
      insertCSS: vi.fn(),
      executeScript: vi.fn(),
    },
    runtime: {
      onMessage: {
        addListener: vi.fn((fn: (...args: unknown[]) => void) => { listeners['message'] = listeners['message'] || []; listeners['message'].push(fn); }),
      },
      sendMessage: vi.fn(),
    },
    sidePanel: {
      open: vi.fn(),
    },
  };
}

const mockChrome = createMockChrome();
vi.stubGlobal('chrome', mockChrome);

describe('service-worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(listeners).forEach((k) => delete listeners[k]);
    // Reset WebSocket relay state
    vi.resetModules();
  });

  it('should register action click listener', async () => {
    await import('../service-worker');
    expect(mockChrome.action.onClicked.addListener).toHaveBeenCalled();
  });

  it('should register command listener', async () => {
    await import('../service-worker');
    expect(mockChrome.commands.onCommand.addListener).toHaveBeenCalled();
  });

  it('should register message listener', async () => {
    await import('../service-worker');
    expect(mockChrome.runtime.onMessage.addListener).toHaveBeenCalled();
  });

  describe('action click → open side panel', () => {
    it('should open side panel when icon clicked', async () => {
      await import('../service-worker');
      const handler = listeners['action']![0];
      handler({ id: 42 });
      expect(mockChrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 42 });
    });
  });

  describe('quick-chat command', () => {
    it('should ignore non-quick-chat commands', async () => {
      await import('../service-worker');
      const handler = listeners['command']![0];
      await handler('other-command');
      expect(mockChrome.tabs.query).not.toHaveBeenCalled();
    });

    it('should skip chrome:// and edge:// pages', async () => {
      await import('../service-worker');
      mockChrome.tabs.query.mockResolvedValue([{ id: 1, url: 'chrome://extensions' }]);
      const handler = listeners['command']![0];
      await handler('quick-chat');
      expect(mockChrome.tabs.sendMessage).not.toHaveBeenCalled();
      expect(mockChrome.scripting.executeScript).not.toHaveBeenCalled();
    });

    it('should toggle overlay if already injected', async () => {
      await import('../service-worker');
      mockChrome.tabs.query.mockResolvedValue([{ id: 1, url: 'https://example.com' }]);
      mockChrome.tabs.sendMessage.mockResolvedValue(undefined);
      const handler = listeners['command']![0];
      await handler('quick-chat');
      expect(mockChrome.tabs.sendMessage).toHaveBeenCalledWith(1, { type: 'NB_QUICKCHAT_TOGGLE' });
    });

    it('should inject scripts if overlay not yet injected', async () => {
      await import('../service-worker');
      mockChrome.tabs.query.mockResolvedValue([{ id: 1, url: 'https://example.com' }]);
      mockChrome.tabs.sendMessage.mockRejectedValue(new Error('not injected'));
      const handler = listeners['command']![0];
      await handler('quick-chat');
      expect(mockChrome.scripting.insertCSS).toHaveBeenCalled();
      expect(mockChrome.scripting.executeScript).toHaveBeenCalledWith({
        target: { tabId: 1 },
        files: expect.arrayContaining([
          expect.stringContaining('storage'),
          expect.stringContaining('session'),
          expect.stringContaining('ws-client'),
          expect.stringContaining('quickchat'),
        ]),
      });
    });
  });

  describe('message relay', () => {
    let messageHandler: (...args: unknown[]) => unknown;

    beforeEach(async () => {
      await import('../service-worker');
      messageHandler = listeners['message']![listeners['message']!.length - 1];
    });

    it('should relay NB_FETCH and return response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '{"token":"abc"}',
      }));

      const sendResponse = vi.fn();
      const returned = messageHandler(
        { type: 'NB_FETCH', url: 'http://localhost:8765/auth/token', headers: {} },
        {},
        sendResponse,
      );

      expect(returned).toBe(true); // async
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({
        ok: true,
        status: 200,
        body: '{"token":"abc"}',
      }));
    });

    it('should handle NB_FETCH errors', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

      const sendResponse = vi.fn();
      messageHandler({ type: 'NB_FETCH', url: 'http://bad', headers: {} }, {}, sendResponse);

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({
        ok: false,
        status: 0,
        body: 'network error',
      }));
    });

    it('should handle NB_WS_CONNECT', () => {
      vi.stubGlobal('WebSocket', vi.fn().mockImplementation(() => ({
        addEventListener: vi.fn(),
        close: vi.fn(),
      })));

      const sendResponse = vi.fn();
      const returned = messageHandler(
        { type: 'NB_WS_CONNECT', url: 'ws://localhost/ws' },
        { tab: { id: 1 } },
        sendResponse,
      );

      expect(returned).toBe(false);
      expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    });

    it('should handle NB_WS_SEND on open connection', () => {
      const mockSend = vi.fn();
      vi.stubGlobal('WebSocket', vi.fn().mockImplementation(() => ({
        addEventListener: vi.fn(),
        close: vi.fn(),
        readyState: WebSocket.OPEN,
        send: mockSend,
      })));

      // First connect
      const sendResponse = vi.fn();
      messageHandler(
        { type: 'NB_WS_CONNECT', url: 'ws://localhost/ws' },
        { tab: { id: 1 } },
        sendResponse,
      );

      // Then send
      messageHandler({ type: 'NB_WS_SEND', text: 'hello' }, {}, () => {});
      // Note: the relayWs variable is module-scoped, so this test may need adjustment
      // depending on how the module manages state
    });

    it('should handle NB_WS_CLOSE', () => {
      const sendResponse = vi.fn();
      const returned = messageHandler({ type: 'NB_WS_CLOSE' }, {}, sendResponse);
      expect(returned).toBe(false);
    });

    it('should ignore unknown message types', () => {
      const sendResponse = vi.fn();
      const returned = messageHandler({ type: 'UNKNOWN' }, {}, sendResponse);
      expect(returned).toBeUndefined();
      expect(sendResponse).not.toHaveBeenCalled();
    });
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/background/__tests__/service-worker.test.ts
```

Expected: FAIL.

**Step 3: Create src/background/service-worker.ts**

```typescript
// Click extension icon → open side panel
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Ctrl+Shift+K → toggle quick chat overlay
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'quick-chat') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'NB_QUICKCHAT_TOGGLE' });
  } catch {
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

/* -- Message relay ---------------------------------------------------- */

let relayWs: WebSocket | null = null;
let relayTabId: number | null = null;

function _relayToTab(type: string, data: Record<string, unknown>): void {
  if (relayTabId) {
    chrome.tabs.sendMessage(relayTabId, { type, ...data }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'NB_FETCH') {
    fetch(msg.url as string, { headers: (msg.headers || {}) as Record<string, string> })
      .then((resp) => resp.text().then((body) => sendResponse({
        ok: resp.ok,
        status: resp.status,
        body,
      })))
      .catch((err: Error) => sendResponse({ ok: false, status: 0, body: err.message }));
    return true;
  }

  if (msg.type === 'NB_WS_CONNECT') {
    if (relayWs) relayWs.close();

    relayTabId = (sender.tab as { id?: number })?.id ?? null;

    try {
      relayWs = new WebSocket(msg.url as string);

      relayWs.addEventListener('open', () => {
        _relayToTab('NB_WS_OPEN', {});
      });

      relayWs.addEventListener('message', (e) => {
        _relayToTab('NB_WS_MESSAGE', { data: e.data });
      });

      relayWs.addEventListener('close', (e) => {
        _relayToTab('NB_WS_CLOSE', { code: e.code, reason: e.reason });
        relayWs = null;
        relayTabId = null;
      });

      relayWs.addEventListener('error', () => {
        _relayToTab('NB_WS_ERROR', {});
      });

      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: (err as Error).message });
    }
    return false;
  }

  if (msg.type === 'NB_WS_SEND') {
    if (relayWs && relayWs.readyState === WebSocket.OPEN) {
      relayWs.send(msg.text as string);
    }
    return false;
  }

  if (msg.type === 'NB_WS_CLOSE') {
    if (relayWs) relayWs.close();
    relayWs = null;
    relayTabId = null;
    return false;
  }
});
```

**Step 4: Run tests and iterate until all pass**

```bash
npx vitest run src/background/__tests__/service-worker.test.ts
```

**Step 5: Commit**

```bash
git add src/background/service-worker.ts src/background/__tests__/service-worker.test.ts
git commit -m "refactor: convert background service-worker to TypeScript with tests"
```

---

### Task 6: Convert sidepanel/app.ts with tests

**Files:**
- Create: `src/sidepanel/app.ts`
- Create: `src/sidepanel/index.html` (copy + update script src)
- Create: `src/sidepanel/style.css` (copy from original)
- Create: `src/sidepanel/__tests__/app.test.ts`

The sidepanel is heavily DOM-dependent. For testability:
- Extract pure logic functions (session switching, message rendering helpers, settings form logic) into testable functions
- Mock DOM elements for integration tests
- Focus tests on the logic, not DOM manipulation details

**Step 1: Write tests for extractable logic**

Create `src/sidepanel/__tests__/app.test.ts`:

```typescript
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
  runtime: {
    id: 'ext-id',
  },
});

vi.stubGlobal('location', { href: 'chrome-extension://abc/sidepanel/index.html' });

describe('sidepanel app', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.keys(storage).forEach((k) => delete storage[k]);
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
    // The app.ts is an IIFE that runs on import
    // This test verifies it doesn't throw
    await import('../app');
  });

  it('should render empty session list when no sessions', async () => {
    await import('../app');
    const list = document.querySelector('#session-list');
    expect(list?.textContent).toContain('No sessions');
  });
});
```

> **Note:** The sidepanel is primarily UI wiring. The core logic (SessionManager, WsClient, storage) is already tested. Sidepanel tests focus on verifying the module loads and the IIFE doesn't crash. For deeper UI testing, consider adding integration tests with a real DOM later.

**Step 2: Create src/sidepanel/app.ts**

Convert `sidepanel/app.js` to TypeScript:
- Add type annotations for DOM elements
- Import from `../lib/storage`, `../lib/session`, `../lib/ws-client`
- The IIFE structure stays the same
- Add types for the `$` helper, event handlers, etc.

The conversion is straightforward — mostly adding type annotations. The logic is identical.

**Step 3: Copy and update HTML**

Copy `sidepanel/index.html` to `src/sidepanel/index.html`. Update script references:

```html
<script src="app.js"></script>
```

The HTML stays mostly the same. After Vite build, the `app.js` reference in the HTML will need to be updated. This is handled in Task 7 (Vite config finalization).

**Step 4: Copy CSS**

Copy `sidepanel/style.css` to `src/sidepanel/style.css` unchanged.

**Step 5: Run tests**

```bash
npx vitest run src/sidepanel/__tests__/app.test.ts
```

**Step 6: Commit**

```bash
git add src/sidepanel/
git commit -m "refactor: convert sidepanel to TypeScript with tests"
```

---

### Task 7: Convert quickchat/quickchat.ts

**Files:**
- Create: `src/quickchat/quickchat.ts`
- Create: `src/quickchat/style.css` (copy)
- Create: `src/quickchat/__tests__/quickchat.test.ts`

Similar to sidepanel — this is an IIFE with DOM manipulation. Core logic is in lib/.

**Step 1: Create tests**

Create `src/quickchat/__tests__/quickchat.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubGlobal('chrome', {
  runtime: { id: 'ext-id' },
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
    document.body.innerHTML = '';
    delete (window as unknown as Record<string, unknown>).__nb_qc;
  });

  it('should create overlay DOM on load', async () => {
    await import('../quickchat');
    expect(document.querySelector('#nb-qc-container')).toBeTruthy();
    expect(document.querySelector('#nb-qc-backdrop')).toBeTruthy();
  });

  it('should expose toggle on window.__nb_qc', async () => {
    await import('../quickchat');
    expect((window as unknown as Record<string, unknown>).__nb_qc).toBeTruthy();
  });
});
```

**Step 2: Create src/quickchat/quickchat.ts**

Convert `quickchat/quickchat.js` to TypeScript with type annotations. Import from `../lib/`.

**Step 3: Copy CSS**

Copy `quickchat/style.css` to `src/quickchat/style.css` unchanged.

**Step 4: Run tests**

```bash
npx vitest run src/quickchat/__tests__/quickchat.test.ts
```

**Step 5: Commit**

```bash
git add src/quickchat/
git commit -m "refactor: convert quickchat to TypeScript with tests"
```

---

### Task 8: Finalize Vite config and verify build

**Files:**
- Modify: `vite.config.ts`
- Modify: `manifest.json`
- Delete: original JS files (background/, lib/, sidepanel/app.js, quickchat/quickchat.js)

**Step 1: Finalize vite.config.ts**

The Vite config needs to:
1. Build three entry points (service-worker, sidepanel/app, quickchat/quickchat)
2. Copy `manifest.json`, `icons/`, HTML files, and CSS files to `dist/`
3. The sidepanel HTML needs to reference the bundled `app.js`

Since Chrome extensions don't use ES modules for content scripts and service workers in all cases, the simplest approach is to configure Vite to output IIFE format for service-worker and quickchat (which run as content scripts), and ES module for the sidepanel.

Actually, for maximum simplicity and to avoid module loading issues in Chrome extensions, use a **multi-build approach** or configure rollup output format per entry.

**Recommended approach:** Use `vite.config.ts` with rollup `output` configured for `iife` format, with inline code. No chunks. Each entry is self-contained.

```typescript
import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'fs';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        'background/service-worker': resolve(__dirname, 'src/background/service-worker.ts'),
        'sidepanel/app': resolve(__dirname, 'src/sidepanel/app.ts'),
        'quickchat/quickchat': resolve(__dirname, 'src/quickchat/quickchat.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        // No code splitting — each entry is self-contained
        inlineDynamicImports: true,
      },
    },
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    target: 'chrome120',
  },
});

function copyExtensionFiles() {
  return {
    name: 'copy-extension-files',
    closeBundle() {
      copyFileSync('manifest.json', 'dist/manifest.json');

      // Copy icons
      mkdirSync('dist/icons', { recursive: true });
      cpSync('icons', 'dist/icons', { recursive: true });

      // Copy sidepanel HTML
      mkdirSync('dist/sidepanel', { recursive: true });
      cpSync('src/sidepanel/index.html', 'dist/sidepanel/index.html');
      cpSync('src/sidepanel/style.css', 'dist/sidepanel/style.css');

      // Copy quickchat CSS
      mkdirSync('dist/quickchat', { recursive: true });
      cpSync('src/quickchat/style.css', 'dist/quickchat/style.css');
    },
  };
}
```

**Step 2: Build and verify**

```bash
npm run build
```

Expected: `dist/` directory created with:
- `dist/manifest.json`
- `dist/icons/`
- `dist/background/service-worker.js`
- `dist/sidepanel/app.js`
- `dist/sidepanel/index.html`
- `dist/sidepanel/style.css`
- `dist/quickchat/quickchat.js`
- `dist/quickchat/style.css`

**Step 3: Verify the dist works**

Load `dist/` folder in Chrome → extension loads without errors.

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: finalize Vite build config and dist output"
```

---

### Task 9: Run full test suite and coverage report

**Step 1: Run tests with coverage**

```bash
npm run test:coverage
```

**Step 2: Verify 90%+ coverage**

If coverage is below 90%, identify uncovered lines and add tests.

**Step 3: Commit**

```bash
git add -A
git commit -m "test: achieve 90%+ coverage threshold"
```

---

### Task 10: Clean up original JS files

**Files:**
- Delete: `background/service-worker.js`
- Delete: `lib/storage.js`
- Delete: `lib/session.js`
- Delete: `lib/ws-client.js`
- Delete: `sidepanel/app.js`
- Delete: `quickchat/quickchat.js`
- Delete: `sidepanel/index.html` (moved to `src/`)
- Delete: `sidepanel/style.css` (moved to `src/`)
- Delete: `quickchat/style.css` (moved to `src/`)

**Step 1: Delete original files**

```bash
rm background/service-worker.js
rm lib/storage.js lib/session.js lib/ws-client.js
rm sidepanel/app.js sidepanel/index.html sidepanel/style.css
rm quickchat/quickchat.js quickchat/style.css
rmdir background lib sidepanel quickchat 2>/dev/null; true
```

**Step 2: Rebuild**

```bash
npm run build
```

**Step 3: Run tests**

```bash
npm test
```

Expected: All tests pass.

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove original JavaScript source files"
```

---

### Task 11: Update documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/setup.md`

Update README and setup docs to reflect:
- New project structure
- `npm install` + `npm run build` for developers
- `dist/` folder for end users (Load unpacked)
- `npm test` for running tests

**Step 1: Update README.md**

**Step 2: Update docs/setup.md**

**Step 3: Commit**

```bash
git add README.md docs/setup.md
git commit -m "docs: update for TypeScript project structure"
```
