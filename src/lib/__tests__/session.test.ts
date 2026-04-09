import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock chrome.storage.local with an in-memory store
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

// Mock crypto.randomUUID with a deterministic counter
let uuidCounter = 0;
vi.stubGlobal('crypto', {
  randomUUID: vi.fn(() => {
    uuidCounter++;
    return `id-${uuidCounter}`;
  }),
});

import { SessionManager } from '../session';
import type { Session } from '../types';

describe('SessionManager', () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager();
    Object.keys(storage).forEach((k) => delete storage[k]);
    uuidCounter = 0;
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('load()', () => {
    it('should load sessions and activeId from storage', async () => {
      const sessions: Record<string, Session> = {
        'abc': {
          id: 'abc',
          title: 'Test',
          messages: [],
          createdAt: 1000,
          updatedAt: 2000,
        },
      };
      storage['nb_sessions'] = sessions;
      storage['nb_active_session'] = 'abc';

      await sm.load();

      expect(sm.get('abc')).toEqual(sessions['abc']);
      expect(sm.getActive()?.id).toBe('abc');
    });

    it('should handle empty storage gracefully', async () => {
      await sm.load();

      expect(sm.list()).toEqual([]);
      expect(sm.getActive()).toBeNull();
    });

    it('should handle missing nb_sessions but present nb_active_session', async () => {
      storage['nb_active_session'] = 'nonexistent';

      await sm.load();

      expect(sm.list()).toEqual([]);
      expect(sm.getActive()).toBeNull();
    });
  });

  describe('create()', () => {
    it('should create a session with a title', () => {
      const id = sm.create('My Chat');

      expect(id).toBe('id-1');
      const session = sm.get(id)!;
      expect(session.title).toBe('My Chat');
      expect(session.messages).toEqual([]);
      expect(session.id).toBe(id);
      expect(typeof session.createdAt).toBe('number');
      expect(typeof session.updatedAt).toBe('number');
    });

    it('should use "New Chat" as default title when none provided', () => {
      const id = sm.create();

      expect(sm.get(id)!.title).toBe('New Chat');
    });

    it('should use "New Chat" as default title when empty string provided', () => {
      const id = sm.create('');

      expect(sm.get(id)!.title).toBe('New Chat');
    });

    it('should set the new session as active', () => {
      const id = sm.create('Test');

      expect(sm.getActive()?.id).toBe(id);
    });

    it('should persist sessions and activeId to storage', async () => {
      sm.create('Test');

      // Advance timers to flush debounced persist
      await vi.advanceTimersByTimeAsync(600);

      expect(chrome.storage.local.set).toHaveBeenCalledWith(
        expect.objectContaining({
          nb_sessions: expect.any(Object),
          nb_active_session: 'id-1',
        }),
      );
    });
  });

  describe('get()', () => {
    it('should return the session for a known id', () => {
      const id = sm.create('Test');

      const session = sm.get(id);
      expect(session).not.toBeNull();
      expect(session!.id).toBe(id);
    });

    it('should return null for an unknown id', () => {
      expect(sm.get('nonexistent')).toBeNull();
    });
  });

  describe('getActive()', () => {
    it('should return the active session', () => {
      const id = sm.create('Test');

      expect(sm.getActive()?.id).toBe(id);
    });

    it('should return null when no session is active', () => {
      expect(sm.getActive()).toBeNull();
    });
  });

  describe('setActive()', () => {
    it('should set the active session by id', () => {
      const id1 = sm.create('First');
      const id2 = sm.create('Second');

      sm.setActive(id1);

      expect(sm.getActive()?.id).toBe(id1);
    });

    it('should ignore setting a non-existent session as active', () => {
      const id = sm.create('Test');
      sm.setActive(id);

      sm.setActive('nonexistent');

      expect(sm.getActive()?.id).toBe(id);
    });

    it('should persist when setting active', async () => {
      const id1 = sm.create('First');
      const id2 = sm.create('Second');
      vi.clearAllMocks();

      sm.setActive(id1);
      await vi.advanceTimersByTimeAsync(600);

      expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
    });
  });

  describe('list()', () => {
    it('should return sessions sorted by updatedAt descending', () => {
      const id1 = sm.create('First');
      // Advance time by manipulating the session directly
      const id2 = sm.create('Second');

      // Manually set updatedAt to control order
      sm.get(id1)!.updatedAt = 100;
      sm.get(id2)!.updatedAt = 200;

      const list = sm.list();
      expect(list[0].id).toBe(id2);
      expect(list[1].id).toBe(id1);
    });

    it('should return an empty array when no sessions exist', () => {
      expect(sm.list()).toEqual([]);
    });
  });

  describe('addMessage()', () => {
    it('should add a message to a session', () => {
      const id = sm.create('Test');
      sm.addMessage(id, 'user', 'Hello');

      const session = sm.get(id)!;
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0].role).toBe('user');
      expect(session.messages[0].content).toBe('Hello');
      expect(typeof session.messages[0].timestamp).toBe('number');
    });

    it('should update the session updatedAt timestamp', () => {
      const id = sm.create('Test');
      const originalUpdatedAt = sm.get(id)!.updatedAt;

      // Ensure time has advanced
      vi.spyOn(Date, 'now').mockReturnValue(originalUpdatedAt + 1000);
      sm.addMessage(id, 'user', 'Hello');

      expect(sm.get(id)!.updatedAt).toBeGreaterThan(originalUpdatedAt);
      vi.restoreAllMocks();
    });

    it('should ignore a non-existent session', () => {
      sm.addMessage('nonexistent', 'user', 'Hello');

      expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    it('should persist after adding a message', async () => {
      const id = sm.create('Test');
      vi.clearAllMocks();

      sm.addMessage(id, 'assistant', 'Hi there');
      await vi.advanceTimersByTimeAsync(600);

      expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
    });
  });

  describe('appendToLastAssistant()', () => {
    it('should append text to an unfinished assistant message', () => {
      const id = sm.create('Test');
      sm.addMessage(id, 'assistant', 'Hello');

      sm.appendToLastAssistant(id, ' World');

      const session = sm.get(id)!;
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0].content).toBe('Hello World');
    });

    it('should create a new assistant message when last message is from user', () => {
      const id = sm.create('Test');
      sm.addMessage(id, 'user', 'Hi');

      sm.appendToLastAssistant(id, 'Response');

      const session = sm.get(id)!;
      expect(session.messages).toHaveLength(2);
      expect(session.messages[1].role).toBe('assistant');
      expect(session.messages[1].content).toBe('Response');
      expect(session.messages[1].done).toBe(false);
    });

    it('should create a new assistant message when last assistant message is done', () => {
      const id = sm.create('Test');
      sm.addMessage(id, 'assistant', 'First');
      sm.markLastAssistantDone(id);

      sm.appendToLastAssistant(id, 'Second');

      const session = sm.get(id)!;
      expect(session.messages).toHaveLength(2);
      expect(session.messages[1].content).toBe('Second');
      expect(session.messages[1].done).toBe(false);
    });

    it('should create a new assistant message when session has no messages', () => {
      const id = sm.create('Test');

      sm.appendToLastAssistant(id, 'New');

      const session = sm.get(id)!;
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0].role).toBe('assistant');
      expect(session.messages[0].content).toBe('New');
      expect(session.messages[0].done).toBe(false);
    });

    it('should ignore a non-existent session', () => {
      sm.appendToLastAssistant('nonexistent', 'text');

      expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    it('should update the session updatedAt timestamp', () => {
      const id = sm.create('Test');
      const originalUpdatedAt = sm.get(id)!.updatedAt;

      vi.spyOn(Date, 'now').mockReturnValue(originalUpdatedAt + 1000);
      sm.appendToLastAssistant(id, 'text');

      expect(sm.get(id)!.updatedAt).toBeGreaterThan(originalUpdatedAt);
      vi.restoreAllMocks();
    });
  });

  describe('markLastAssistantDone()', () => {
    it('should mark the last assistant message as done', async () => {
      const id = sm.create('Test');
      sm.appendToLastAssistant(id, 'Streaming');

      sm.markLastAssistantDone(id);
      // _flushPersist is async and calls set immediately
      await vi.runAllTimersAsync();

      const session = sm.get(id)!;
      expect(session.messages[0].done).toBe(true);
    });

    it('should do nothing when last message is from user', async () => {
      const id = sm.create('Test');
      sm.addMessage(id, 'user', 'Hello');
      vi.clearAllMocks();

      sm.markLastAssistantDone(id);

      // Should not persist since nothing changed
      expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    it('should do nothing when session has no messages', async () => {
      const id = sm.create('Test');
      vi.clearAllMocks();

      sm.markLastAssistantDone(id);

      expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    it('should ignore a non-existent session', () => {
      sm.markLastAssistantDone('nonexistent');

      expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });
  });

  describe('delete()', () => {
    it('should delete a session', () => {
      const id = sm.create('Test');

      sm.delete(id);

      expect(sm.get(id)).toBeNull();
    });

    it('should handle deleting the active session by switching to another', () => {
      const id1 = sm.create('First');
      const id2 = sm.create('Second');

      sm.delete(id2);

      expect(sm.getActive()?.id).toBe(id1);
    });

    it('should select the most recently updated session after deleting the active one', () => {
      const id1 = sm.create('First');
      const id2 = sm.create('Second');
      const id3 = sm.create('Third');

      // Make id1 the most recently updated
      sm.get(id1)!.updatedAt = 9999;
      sm.get(id2)!.updatedAt = 100;
      sm.get(id3)!.updatedAt = 200;

      // Delete the active session (id3 since it was created last)
      sm.delete(id3);

      // Should select id1 (most recently updated remaining)
      expect(sm.getActive()?.id).toBe(id1);
    });

    it('should set activeId to null when deleting the last session', () => {
      const id = sm.create('Only');

      sm.delete(id);

      expect(sm.getActive()).toBeNull();
      expect(sm.list()).toEqual([]);
    });

    it('should persist after deletion', async () => {
      const id = sm.create('Test');
      vi.clearAllMocks();

      sm.delete(id);
      await vi.advanceTimersByTimeAsync(600);

      expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
    });
  });

  describe('rename()', () => {
    it('should rename a session', () => {
      const id = sm.create('Old Title');

      sm.rename(id, 'New Title');

      expect(sm.get(id)!.title).toBe('New Title');
    });

    it('should update the updatedAt timestamp on rename', () => {
      const id = sm.create('Test');
      const originalUpdatedAt = sm.get(id)!.updatedAt;

      vi.spyOn(Date, 'now').mockReturnValue(originalUpdatedAt + 1000);
      sm.rename(id, 'Renamed');

      expect(sm.get(id)!.updatedAt).toBeGreaterThan(originalUpdatedAt);
      vi.restoreAllMocks();
    });

    it('should ignore a non-existent session', () => {
      sm.rename('nonexistent', 'Title');

      expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    it('should persist after renaming', async () => {
      const id = sm.create('Test');
      vi.clearAllMocks();

      sm.rename(id, 'Renamed');
      await vi.advanceTimersByTimeAsync(600);

      expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
    });
  });

  describe('debounced _persist()', () => {
    it('should batch multiple rapid calls into a single write', async () => {
      const id = sm.create('Test');

      // Before debounce fires — only the create() persist may or may not have fired
      // depending on timer state. Clear and check fresh.
      vi.clearAllMocks();

      sm.addMessage(id, 'user', 'a');
      sm.addMessage(id, 'user', 'b');
      sm.addMessage(id, 'user', 'c');

      // Before debounce fires — none of the addMessage persists should have fired
      expect(chrome.storage.local.set).toHaveBeenCalledTimes(0);

      // After debounce fires — all 3 addMessage calls batched into 1 write
      await vi.advanceTimersByTimeAsync(600);
      expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
    });
  });
});
