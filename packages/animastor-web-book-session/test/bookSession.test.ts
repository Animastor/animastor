// BookSession identity package unit tests (Step 12 physical extraction —
// web-generator-extraction-audit.md §21; tests moved from the Step-11
// in-repo contour, state/__tests__/bookSession.test.ts).
//
// Prove behavior equivalence with the original generateStore identity block
// (pre Step-11): loadBook persist/clear semantics, buildId controlled write,
// the read-only persisted-session view, and the auth stash/restore pair —
// against real localStorage (happy-dom). Zero host imports: the package is
// dependency-clean.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  bookId, buildId, loadBook, setGenerationBuildId,
  readPersistedBookSession, stashBookSessionForUser, restoreStashedBookSessionForUser,
  BOOK_STORE_KEY,
} from '../src';

const stashKey = (uid: string) => `${BOOK_STORE_KEY}:user:${uid}`;

beforeEach(() => {
  localStorage.clear();
  loadBook('', '');
});

describe('initial identity', () => {
  it('starts empty with no persisted session', () => {
    // beforeEach already reset via loadBook('',''); assert the factory state
    // of a fresh module instance is the same shape (signals are `signal('')`).
    expect(BOOK_STORE_KEY).toBe('animastor:currentBook');
    expect(readPersistedBookSession()).toBeNull();
  });
});

describe('loadBook — the single sanctioned identity mutator', () => {
  it('sets bookId + buildId and persists the session', () => {
    loadBook('b1', 'bd1');

    expect(bookId.value).toBe('b1');
    expect(buildId.value).toBe('bd1');
    expect(JSON.parse(localStorage.getItem(BOOK_STORE_KEY)!)).toEqual({ id: 'b1', build: 'bd1' });
  });

  it('defaults build to empty string and persists it', () => {
    loadBook('b2');

    expect(bookId.value).toBe('b2');
    expect(buildId.value).toBe('');
    expect(JSON.parse(localStorage.getItem(BOOK_STORE_KEY)!)).toEqual({ id: 'b2', build: '' });
  });

  it("loadBook('', '') clears the signals AND the persisted session", () => {
    loadBook('b1', 'bd1');
    expect(localStorage.getItem(BOOK_STORE_KEY)).not.toBeNull();

    loadBook('', '');

    expect(bookId.value).toBe('');
    expect(buildId.value).toBe('');
    expect(localStorage.getItem(BOOK_STORE_KEY)).toBeNull();
  });

  it('overwrites a previous session (reload/reopen parity)', () => {
    loadBook('old', 'old-build');
    loadBook('new', 'new-build');

    expect(bookId.value).toBe('new');
    expect(JSON.parse(localStorage.getItem(BOOK_STORE_KEY)!)).toEqual({ id: 'new', build: 'new-build' });
  });
});

describe('setGenerationBuildId — the controlled generation-side writer', () => {
  it('updates buildId without touching bookId or the persisted book id', () => {
    loadBook('b1', 'bd1');

    setGenerationBuildId('bd-new');

    expect(buildId.value).toBe('bd-new');
    expect(bookId.value).toBe('b1');
    // The persisted blob keeps the OLD build: the generation write path does
    // not re-persist (identical to the pre-extraction `buildId.value = res.build_id`).
    expect(JSON.parse(localStorage.getItem(BOOK_STORE_KEY)!)).toEqual({ id: 'b1', build: 'bd1' });
  });

  it('is the only write path besides loadBook — one signal, no fork', () => {
    loadBook('b1', '');
    setGenerationBuildId('from-generation');

    expect(buildId.value).toBe('from-generation');
    // a subsequent loadBook still owns the full identity tuple
    loadBook('b2', 'bd2');
    expect(buildId.value).toBe('bd2');
  });
});

describe('readPersistedBookSession — read-only view for fileStore.restoreBookSession', () => {
  it('returns the persisted session when present', () => {
    localStorage.setItem(BOOK_STORE_KEY, JSON.stringify({ id: 'kept', build: 'bd-kept' }));

    expect(readPersistedBookSession()).toEqual({ id: 'kept', build: 'bd-kept' });
  });

  it('returns null when the key is absent', () => {
    expect(readPersistedBookSession()).toBeNull();
  });

  it('returns null for corrupt JSON (tolerated, same as the pre-extraction try/catch)', () => {
    localStorage.setItem(BOOK_STORE_KEY, '{not json');

    expect(readPersistedBookSession()).toBeNull();
  });

  it('returns null when the persisted blob has no id', () => {
    localStorage.setItem(BOOK_STORE_KEY, JSON.stringify({ build: 'bd1' }));

    expect(readPersistedBookSession()).toBeNull();
  });

  it('is read-only: reading never writes or clears the live key', () => {
    localStorage.setItem(BOOK_STORE_KEY, JSON.stringify({ id: 'x', build: '' }));
    readPersistedBookSession();

    expect(localStorage.getItem(BOOK_STORE_KEY)).toEqual(JSON.stringify({ id: 'x', build: '' }));
  });
});

describe('stashBookSessionForUser — logout isolation', () => {
  it('moves the live session to the per-user key and clears the live session', () => {
    loadBook('book-abc', 'build-1');

    stashBookSessionForUser('user-42');

    expect(localStorage.getItem(BOOK_STORE_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(stashKey('user-42'))!)).toEqual({ id: 'book-abc', build: 'build-1' });
    expect(bookId.value).toBe('');
    expect(buildId.value).toBe('');
  });

  it('removes any previous stash when nothing is open', () => {
    localStorage.setItem(stashKey('u1'), JSON.stringify({ id: 'stale', build: '' }));

    stashBookSessionForUser('u1');

    expect(localStorage.getItem(stashKey('u1'))).toBeNull();
  });

  it('is a no-op stash for null/undefined userId but still clears the live session', () => {
    loadBook('b1', 'bd1');

    stashBookSessionForUser(null);
    stashBookSessionForUser(undefined);

    expect(localStorage.getItem(BOOK_STORE_KEY)).toBeNull();
    expect(bookId.value).toBe('');
  });
});

describe('restoreStashedBookSessionForUser — login re-attach', () => {
  it('re-attaches the stashed session when the live key is empty', () => {
    localStorage.setItem(stashKey('u1'), JSON.stringify({ id: 'x9', build: 'b2' }));

    restoreStashedBookSessionForUser('u1');

    expect(JSON.parse(localStorage.getItem(BOOK_STORE_KEY)!)).toEqual({ id: 'x9', build: 'b2' });
    // note: signals are NOT updated here — matching the pre-extraction
    // behavior; the session is re-attached on the next restoreBookSession()
    // validation (fileStore-owned).
    expect(bookId.value).toBe('');
  });

  it('does NOT clobber an existing live session', () => {
    loadBook('live-book', '');

    localStorage.setItem(stashKey('u1'), JSON.stringify({ id: 'stashed-book', build: '' }));
    restoreStashedBookSessionForUser('u1');

    expect(JSON.parse(localStorage.getItem(BOOK_STORE_KEY)!)).toEqual({ id: 'live-book', build: '' });
  });

  it('is a no-op for null/undefined userId', () => {
    restoreStashedBookSessionForUser(null);
    restoreStashedBookSessionForUser(undefined);

    expect(localStorage.getItem(BOOK_STORE_KEY)).toBeNull();
  });
});

describe('storage failure — graceful behavior (try/catch parity)', () => {
  it('loadBook does not throw when persistence fails; signals still update', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    try {
      expect(() => loadBook('b1', 'bd1')).not.toThrow();
      expect(bookId.value).toBe('b1');
      expect(buildId.value).toBe('bd1');
    } finally {
      setItem.mockRestore();
    }
  });

  it('loadBook clear path does not throw when removeItem fails', () => {
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    try {
      expect(() => loadBook('', '')).not.toThrow();
      expect(bookId.value).toBe('');
    } finally {
      removeItem.mockRestore();
    }
  });

  it('stash tolerates a failing live-key read (treated as no open session)', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    try {
      expect(() => stashBookSessionForUser('u1')).not.toThrow();
      expect(bookId.value).toBe(''); // loadBook('', '') still ran
    } finally {
      getItem.mockRestore();
    }
  });
});
