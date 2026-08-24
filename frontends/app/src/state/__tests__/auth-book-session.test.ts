import { describe, it, expect, vi, beforeEach } from 'vitest';

const BOOK_KEY = 'animastor:currentBook';
const stashKey = (uid: string) => `${BOOK_KEY}:user:${uid}`;

// ── Minimal localStorage shim ──
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

const ls = new MemStorage();
vi.stubGlobal('localStorage', ls);

// Mock the API client so authStore / generateStore never hit the network.
vi.mock('../../api/client', () => ({
  getJson: vi.fn(),
  postJson: vi.fn(),
  postJsonLong: vi.fn(),
  postMultipart: vi.fn(),
  putJson: vi.fn(),
  deleteJson: vi.fn(),
  sse: vi.fn(),
}));

// Mock playback / position side-effect imports used by generateStore module init.
vi.mock('../playbackStore', () => ({
  closeBook: vi.fn(),
  wirePlaybackCoordination: vi.fn(),
  wirePlaybackLifecycle: vi.fn(),
}));
vi.mock('../positionStore', () => ({
  navigateTo: vi.fn(),
  clearPosition: vi.fn(),
  position: { value: {} },
}));
vi.mock('../../app/i18n', () => ({
  vbookStageLabel: vi.fn(),
}));

beforeEach(() => {
  ls.clear();
});

// ── Tests ──
describe('book session stash / restore', () => {
  it('stashBookSessionForUser moves live session to per-user key and clears signals', async () => {
    const { stashBookSessionForUser, loadBook } = await import('../generateStore');

    loadBook('book-abc', 'build-1');
    expect(ls.getItem(BOOK_KEY)).toContain('book-abc');

    stashBookSessionForUser('user-42');

    expect(ls.getItem(BOOK_KEY)).toBeNull();
    expect(JSON.parse(ls.getItem(stashKey('user-42'))!)).toEqual({ id: 'book-abc', build: 'build-1' });
  });

  it('restoreStashedBookSessionForUser re-attaches session when live key is empty', async () => {
    const { restoreStashedBookSessionForUser } = await import('../generateStore');

    ls.setItem(stashKey('u1'), JSON.stringify({ id: 'x9', build: 'b2' }));
    restoreStashedBookSessionForUser('u1');
    expect(ls.getItem(BOOK_KEY)).toContain('x9');
  });

  it('restoreStashedBookSessionForUser does NOT clobber an existing live session', async () => {
    const { restoreStashedBookSessionForUser, loadBook } = await import('../generateStore');

    loadBook('live-book', '');
    ls.setItem(stashKey('u1'), JSON.stringify({ id: 'stashed-book', build: '' }));

    restoreStashedBookSessionForUser('u1');
    expect(ls.getItem(BOOK_KEY)).toContain('live-book');
  });

  it('restoreStashedBookSessionForUser is a no-op for null/undefined userId', async () => {
    const { restoreStashedBookSessionForUser } = await import('../generateStore');

    restoreStashedBookSessionForUser(null as any);
    restoreStashedBookSessionForUser(undefined);
    expect(ls.getItem(BOOK_KEY)).toBeNull();
  });

  it('stashBookSessionForUser with no open book removes any previous stash', async () => {
    const { stashBookSessionForUser } = await import('../generateStore');

    stashBookSessionForUser('u1');
    expect(ls.getItem(stashKey('u1'))).toBeNull();
  });
});

describe('logout() book session isolation', () => {
  it('logout stashes session and clears live key', async () => {
    const { loadBook } = await import('../generateStore');
    const { authMe, logout } = await import('../authStore');
    const { postJson } = await import('../../api/client');

    (postJson as ReturnType<typeof vi.fn>).mockResolvedValue({});
    authMe.value = {
      authenticated: true,
      user: { id: 'sureg', username: 'sureg' },
      workspace: { id: 'ws1', name: 'ws', type: 'personal' },
    };

    loadBook('import_1786345731767_1786345734345', 'bld');
    await logout();

    expect(ls.getItem(BOOK_KEY)).toBeNull();
    const stashed = JSON.parse(ls.getItem(stashKey('sureg'))!);
    expect(stashed.id).toBe('import_1786345731767_1786345734345');
    expect(authMe.value.authenticated).toBe(false);
  });
});

describe('login() book session restore', () => {
  it('login restores previously stashed book', async () => {
    const { authMe, login } = await import('../authStore');
    const { postJson } = await import('../../api/client');

    ls.setItem(stashKey('sureg'), JSON.stringify({ id: 'book-1', build: '' }));
    (postJson as ReturnType<typeof vi.fn>).mockResolvedValue({
      authenticated: true,
      user: { id: 'sureg', username: 'sureg' },
      workspace: { id: 'ws1', name: 'ws', type: 'personal' },
    });

    await login('sureg', 'pass');
    expect(ls.getItem(BOOK_KEY)).toContain('book-1');
    expect(authMe.value.user?.id).toBe('sureg');
  });

  it('login does not restore another user\'s stashed book', async () => {
    const { login } = await import('../authStore');
    const { postJson } = await import('../../api/client');

    ls.setItem(stashKey('other-user'), JSON.stringify({ id: 'their-book', build: '' }));
    (postJson as ReturnType<typeof vi.fn>).mockResolvedValue({
      authenticated: true,
      user: { id: 'sureg', username: 'sureg' },
      workspace: { id: 'ws1', name: 'ws', type: 'personal' },
    });

    await login('sureg', 'pass');
    expect(ls.getItem(BOOK_KEY)).toBeNull();
  });
});

describe('browser refresh after logout — session does not leak', () => {
  it('anonymous context does not see stashed authenticated book', async () => {
    const { loadBook, restoreBookSession } = await import('../generateStore');
    const { authMe, logout } = await import('../authStore');
    const { postJson, getJson } = await import('../../api/client');

    authMe.value = {
      authenticated: true,
      user: { id: 'sureg', username: 'sureg' },
      workspace: { id: 'ws1', name: 'ws', type: 'personal' },
    };
    (postJson as ReturnType<typeof vi.fn>).mockResolvedValue({});
    loadBook('import_1786345731767_1786345734345', '');

    await logout();

    (getJson as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('not found'));

    const restored = await restoreBookSession();
    expect(restored).toBe(false);
    expect(ls.getItem(BOOK_KEY)).toBeNull();
  });
});
