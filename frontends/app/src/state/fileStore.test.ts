// @vitest-environment happy-dom
// FileStore tests (audit B1 split) — the host-owned owner of the File contour
// state. Verifies: initial state, import (vbook/TXT/failure), open, create
// blank, close, export state/progress, error/import messages, the one-shot
// navigation handshake, session-identity preservation (File writes THE shared
// generateStore signals — no fork) and the seams' interaction (shared session
// persistence, playbackPrepared emission, generation-session reset).
//
// Mocking strategy: only the network transport is mocked. generateStore /
// positionStore / i18n are REAL — the identity assertions below would be
// meaningless against a mocked shared store.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as generateStore from './generateStore';
import * as fileStore from './fileStore';
import { position } from './positionStore';
import type * as client from '../api/client';

const BOOK_KEY = 'animastor:currentBook';

const postMultipart = vi.fn<typeof client.postMultipart>();
const postJson = vi.fn<typeof client.postJson>();
const getJson = vi.fn<typeof client.getJson>();

vi.mock('../api/client', () => ({
  getJson: (...a: unknown[]) => getJson(...(a as Parameters<typeof client.getJson>)),
  postJson: (...a: unknown[]) => postJson(...(a as Parameters<typeof client.postJson>)),
  postJsonLong: vi.fn(),
  postMultipart: (...a: unknown[]) => postMultipart(...(a as Parameters<typeof client.postMultipart>)),
  putJson: vi.fn(),
  deleteJson: vi.fn(),
  sse: vi.fn(),
  getBlob: vi.fn(),
}));

// ── Seams spy set — real generateStore reset functions + spy ports ──
const playbackPreparedEmit = vi.fn<(prep: { bookId: string; buildId: string }) => void>();
const playerCloseBook = vi.fn();

function wireRealSeams(): void {
  fileStore.wireFileStore({
    generationReset: {
      resetProgressState: generateStore.resetProgressState,
      clearVBookProgress: generateStore.clearVBookProgress,
      setRegenerating: generateStore.setRegenerating,
      bumpVBookPollToken: generateStore.bumpVBookPollToken,
      markImportIncomplete: generateStore.markImportIncomplete,
      stopGenerationSession: generateStore.stopGenerationSession,
    },
    playbackPrepared: { emit: playbackPreparedEmit },
    player: { closeBook: playerCloseBook },
    session: {
      bookId: generateStore.bookId,
      buildId: generateStore.buildId,
      phase: generateStore.phase,
      errorMessage: generateStore.errorMessage,
      dirtySummary: generateStore.dirtySummary,
      blankBookJustCreated: generateStore.blankBookJustCreated,
      loadBook: generateStore.loadBook,
    },
  });
}

const COVER_BOOK = {
  manifest: { book_id: 'b1', build_id: 'bd1' },
  scene_list: [
    { chapter_id: 'ch1', scene_id: 'sc-cover', type: 'cover' },
    { chapter_id: 'ch1', scene_id: 'sc-1', type: 'dialogue' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  // fire-and-forget snapshot call does `.catch` — the mock must be a promise
  postJson.mockResolvedValue({} as never);
  localStorage.clear();
  generateStore.loadBook('', '');
  generateStore.phase.value = 'IDLE';
  generateStore.errorMessage.value = null;
  generateStore.dirtySummary.value = { changed: [] } as never;
  generateStore.blankBookJustCreated.value = false;
  generateStore.isRegenerating.value = true; // flows must reset it
  position.value = { chapterId: 'old', sceneId: 'old', unitId: null, chunkId: null, unitIndex: 3 };
  fileStore.importMessages.value = ['stale'];
  fileStore.navigationEvent.value = 'play';
  fileStore.isExporting.value = true;
  fileStore.exportProgress.value = 9;
  wireRealSeams();
});

// ═══════════════ Initial state ═══════════════

describe('FileStore initial state', () => {
  it('export state starts idle and reset-to-idle zeroes progress', () => {
    fileStore.isExporting.value = false;
    fileStore.exportProgress.value = 9;
    fileStore.setExporting(true);
    expect(fileStore.isExporting.value).toBe(true);
    expect(fileStore.exportProgress.value).toBe(9); // progress survives while exporting
    fileStore.setExporting(false);
    expect(fileStore.isExporting.value).toBe(false);
    expect(fileStore.exportProgress.value).toBe(0); // Android setExporting(false) parity
  });

  it('setExportProgress mirrors the export download progress', () => {
    fileStore.setExportProgress(0.42);
    expect(fileStore.exportProgress.value).toBe(0.42);
  });

  it('owns NO identity signals — bookId/buildId/phase/errorMessage are generateStore-only (no fork)', () => {
    const exportKeys = Object.keys(fileStore);
    expect(exportKeys).not.toContain('bookId');
    expect(exportKeys).not.toContain('buildId');
    expect(exportKeys).not.toContain('phase');
    expect(exportKeys).not.toContain('errorMessage');
  });

  it('throws a composition error when used unwired', async () => {
    const { wireFileStore } = await import('./fileStore');
    // direct seam-less call must fail loudly, not silently no-op
    wireFileStore(null as never);
    await expect(fileStore.importBookFromFile(new File(['x'], 'a.vbook'))).rejects.toThrow(/wireFileStore/);
    wireRealSeams();
  });
});

// ═══════════════ Import file ═══════════════

describe('importBookFromFile', () => {
  it('vbook path: loads identity through the SHARED signals, anchors position, emits playbackPrepared, navigates to play', async () => {
    postMultipart.mockResolvedValue({ book_id: 'b1', build_id: 'bd1', format: 'vbook' });
    getJson.mockImplementation((path) =>
      path === '/book/b1' ? Promise.resolve(COVER_BOOK) : Promise.reject(new Error('404 ' + path))
    );

    await fileStore.importBookFromFile(new File(['x'], 'book.vbook'));

    expect(postMultipart).toHaveBeenCalledWith('/book/import', expect.any(File), 'file', 'book.vbook');
    // identity: the SHARED generateStore signals — not a fork
    expect(generateStore.bookId.value).toBe('b1');
    expect(generateStore.buildId.value).toBe('bd1');
    expect(generateStore.phase.value).toBe('SCENE_READY');
    expect(fileStore.navigationEvent.value).toBe('play');
    expect(generateStore.errorMessage.value).toBeNull();
    // position anchored at the cover
    expect(position.value).toMatchObject({ chapterId: 'ch1', sceneId: 'sc-cover', unitIndex: 0 });
    // player warmed through the seam
    expect(playbackPreparedEmit).toHaveBeenCalledWith({ bookId: 'b1', buildId: 'bd1', scenes: expect.any(Array) });
    // snapshot is a non-fatal convenience
    expect(postJson).toHaveBeenCalledWith('/book/b1/snapshot');
    // session persisted through generateStore.loadBook (single write path)
    expect(JSON.parse(localStorage.getItem(BOOK_KEY)!)).toEqual({ id: 'b1', build: 'bd1' });
    // flow-start resets
    expect(generateStore.isRegenerating.value).toBe(false);
    expect(generateStore.dirtySummary.value).toBeNull();
  });

  it('TXT path: import messages + play when assets exist', async () => {
    postMultipart.mockResolvedValue({ book_id: 'b2', build_id: '', format: 'txt' });
    getJson.mockImplementation((path) => {
      if (path === '/book/b2') return Promise.resolve(COVER_BOOK);
      if (path === '/book/b2/assets-state') return Promise.resolve({ has_assets: true });
      return Promise.reject(new Error('404 ' + path));
    });

    await fileStore.importBookFromFile(new File(['x'], 'story.txt'));

    expect(fileStore.importMessages.value).toEqual([
      '✓ File selected', '✓ TXT read', '✓ Encoding detected', '✓ VBook structure created',
    ]);
    expect(generateStore.phase.value).toBe('SCENE_READY');
    expect(fileStore.navigationEvent.value).toBe('play');
  });

  it('TXT path without assets/scenes: phase IDLE + navigate to generate', async () => {
    postMultipart.mockResolvedValue({ book_id: 'b3', build_id: '', format: 'txt' });
    getJson.mockImplementation((path) => {
      if (path === '/book/b3') return Promise.resolve({ manifest: {}, scene_list: [] });
      if (path === '/book/b3/assets-state') return Promise.resolve({ has_assets: false });
      return Promise.reject(new Error('404 ' + path));
    });

    await fileStore.importBookFromFile(new File(['x'], 'story.txt'));

    expect(generateStore.bookId.value).toBe('b3');
    expect(generateStore.phase.value).toBe('IDLE');
    expect(fileStore.navigationEvent.value).toBe('generate');
  });

  it('failure: phase IDLE + shared errorMessage set, identity untouched', async () => {
    postMultipart.mockRejectedValue(new Error('boom'));

    await fileStore.importBookFromFile(new File(['x'], 'broken.vbook'));

    expect(generateStore.phase.value).toBe('IDLE');
    expect(generateStore.errorMessage.value).toBe('boom');
    expect(generateStore.bookId.value).toBe('');
    expect(fileStore.navigationEvent.value).toBeNull();
  });
});

// ═══════════════ Open book ═══════════════

describe('openBookById', () => {
  it('loads by id through the shared identity + emits playbackPrepared', async () => {
    getJson.mockImplementation((path) => {
      if (path === '/book/link-9') return Promise.resolve({ manifest: { book_id: 'b9', build_id: 'bd9' }, scene_list: [{ chapter_id: 'c', scene_id: 's', type: 'cover' }] });
      if (path === '/book/b9/assets-state') return Promise.resolve({ has_assets: true });
      return Promise.reject(new Error('404 ' + path));
    });

    await fileStore.openBookById('link-9');

    expect(generateStore.bookId.value).toBe('b9');
    expect(generateStore.buildId.value).toBe('bd9');
    expect(generateStore.phase.value).toBe('SCENE_READY');
    expect(fileStore.navigationEvent.value).toBe('play');
    expect(playbackPreparedEmit).toHaveBeenCalledWith({ bookId: 'b9', buildId: 'bd9', scenes: expect.any(Array) });
    expect(JSON.parse(localStorage.getItem(BOOK_KEY)!)).toEqual({ id: 'b9', build: 'bd9' });
  });

  it('tolerates copy-pasted download URLs (…/book/<id>/download → last segment)', async () => {
    getJson.mockImplementation((path) =>
      path === '/book/x9' ? Promise.resolve({ manifest: {}, scene_list: [] }) : Promise.reject(new Error('404'))
    );

    await fileStore.openBookById('/api/v1/book/x9/');

    expect(generateStore.bookId.value).toBe('x9');
    expect(fileStore.navigationEvent.value).toBe('generate'); // no scenes, no assets
  });

  it('failure: errorMessage + phase IDLE (Book not found)', async () => {
    getJson.mockRejectedValue(new Error(''));

    await fileStore.openBookById('ghost');

    expect(generateStore.phase.value).toBe('IDLE');
    expect(generateStore.errorMessage.value).toBe('Book not found');
    expect(generateStore.bookId.value).toBe('');
  });
});

// ═══════════════ Create blank book ═══════════════

describe('createBlankBook', () => {
  it('creates via POST /book/blank, sets SCENE_READY + the shared AI-bubble flag', async () => {
    postJson.mockResolvedValue({ book_id: 'new-1' });
    getJson.mockResolvedValue(COVER_BOOK);

    const id = await fileStore.createBlankBook();

    expect(id).toBe('new-1');
    expect(postJson).toHaveBeenCalledWith('/book/blank', { title: 'Новая книга' });
    expect(generateStore.bookId.value).toBe('new-1');
    expect(generateStore.phase.value).toBe('SCENE_READY');
    expect(generateStore.blankBookJustCreated.value).toBe(true);
    expect(fileStore.navigationEvent.value).toBeNull(); // editor navigation is the page's job
  });

  it('failure: returns null + shared errorMessage', async () => {
    postJson.mockRejectedValue(new Error('no server'));

    const id = await fileStore.createBlankBook();

    expect(id).toBeNull();
    expect(generateStore.phase.value).toBe('IDLE');
    expect(generateStore.errorMessage.value).toBe('no server');
  });
});

// ═══════════════ Close ═══════════════

describe('closeBook', () => {
  it('clears identity + File screen state through the SHARED signals, tears down generation and releases the player', () => {
    generateStore.loadBook('b1', 'bd1');
    generateStore.dirtySummary.value = { changed: [] } as never;
    generateStore.phase.value = 'SCENE_READY';

    fileStore.closeBook();

    expect(generateStore.bookId.value).toBe('');
    expect(generateStore.buildId.value).toBe('');
    expect(generateStore.phase.value).toBe('IDLE');
    expect(generateStore.errorMessage.value).toBeNull();
    expect(fileStore.importMessages.value).toEqual([]);
    expect(fileStore.navigationEvent.value).toBeNull();
    expect(generateStore.dirtySummary.value).toBeNull();
    // shared position cleared
    expect(position.value).toEqual({ chapterId: null, sceneId: null, unitId: null, chunkId: null, unitIndex: 0 });
    // persisted session cleared
    expect(localStorage.getItem(BOOK_KEY)).toBeNull();
    // player released through the injected port (former cycle leg)
    expect(playerCloseBook).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════ Session restore ═══════════════

describe('restoreBookSession', () => {
  it('restores the persisted session, validates it, loads identity + warms the player (no navigation event)', async () => {
    localStorage.setItem(BOOK_KEY, JSON.stringify({ id: 'kept', build: 'bd-kept' }));
    getJson.mockImplementation((path) => {
      if (path === '/book/kept/status') return Promise.resolve({ ready: true });
      if (path === '/book/kept') return Promise.resolve({ manifest: { book_id: 'kept', build_id: 'bd-kept' }, scene_list: [{ chapter_id: 'c', scene_id: 's', type: 'cover' }] });
      return Promise.reject(new Error('404 ' + path));
    });

    const restored = await fileStore.restoreBookSession();

    expect(restored).toBe(true);
    expect(generateStore.bookId.value).toBe('kept');
    expect(generateStore.buildId.value).toBe('bd-kept');
    expect(generateStore.phase.value).toBe('SCENE_READY');
    expect(playbackPreparedEmit).toHaveBeenCalledWith({ bookId: 'kept', buildId: 'bd-kept', scenes: expect.any(Array) });
    // boot restore never navigates: the pre-existing event value is untouched
    expect(fileStore.navigationEvent.value).toBe('play');
  });

  it('falls back to the most recent server book when nothing is persisted', async () => {
    getJson.mockImplementation((path) => {
      if (path === '/books') return Promise.resolve({ books: [{ book_id: 'recent-1', build_id: 'rb' }] });
      if (path === '/book/recent-1') return Promise.resolve({ manifest: {}, scene_list: [] });
      return Promise.reject(new Error('404 ' + path));
    });

    const restored = await fileStore.restoreBookSession();

    expect(restored).toBe(true);
    expect(generateStore.bookId.value).toBe('recent-1');
    expect(generateStore.phase.value).toBe('IDLE');
  });

  it('returns false when the server knows nothing (offline)', async () => {
    getJson.mockRejectedValue(new Error('offline'));

    const restored = await fileStore.restoreBookSession();

    expect(restored).toBe(false);
    expect(generateStore.bookId.value).toBe('');
  });

  it('is a no-op when a book is already open (import/deep-link raced ahead)', async () => {
    generateStore.loadBook('live', '');

    const restored = await fileStore.restoreBookSession();

    expect(restored).toBe(false);
    expect(getJson).not.toHaveBeenCalled();
  });

  it('drops the stale session when the book vanished between validation and load', async () => {
    localStorage.setItem(BOOK_KEY, JSON.stringify({ id: 'vanished', build: '' }));
    getJson.mockImplementation((path) => {
      if (path === '/book/vanished/status') return Promise.resolve({ ready: true });
      if (path === '/book/vanished') return Promise.reject(new Error('gone'));
      return Promise.reject(new Error('404 ' + path));
    });

    const restored = await fileStore.restoreBookSession();

    expect(restored).toBe(false);
    expect(generateStore.bookId.value).toBe('');
    expect(localStorage.getItem(BOOK_KEY)).toBeNull();
  });
});

// ═══════════════ Identity / shared-state interaction ═══════════════

describe('shared session identity (no fork, cross-store interaction)', () => {
  it('File flows write THE generateStore signals — authStore stash sees the same session', async () => {
    postMultipart.mockResolvedValue({ book_id: 'b1', build_id: 'bd1', format: 'vbook' });
    getJson.mockResolvedValue(COVER_BOOK);
    await fileStore.importBookFromFile(new File(['x'], 'book.vbook'));

    // The rest of the application (authStore stash) observes the SAME session:
    generateStore.stashBookSessionForUser('user-42');
    expect(JSON.parse(localStorage.getItem(`${BOOK_KEY}:user:user-42`)!)).toEqual({ id: 'b1', build: 'bd1' });
    expect(generateStore.bookId.value).toBe('');
    // login-restore re-attaches the same book through the same identity
    generateStore.restoreStashedBookSessionForUser('user-42');
    expect(JSON.parse(localStorage.getItem(BOOK_KEY)!)).toEqual({ id: 'b1', build: 'bd1' });
  });

  it('generation reset seam is invoked on every open flow (isRegenerating cleared)', async () => {
    const resetProgressState = vi.fn(generateStore.resetProgressState);
    const clearVBookProgress = vi.fn(generateStore.clearVBookProgress);
    fileStore.wireFileStore({
      generationReset: {
        resetProgressState, clearVBookProgress,
        setRegenerating: generateStore.setRegenerating,
        bumpVBookPollToken: generateStore.bumpVBookPollToken,
        markImportIncomplete: generateStore.markImportIncomplete,
        stopGenerationSession: generateStore.stopGenerationSession,
      },
      playbackPrepared: { emit: playbackPreparedEmit },
      player: { closeBook: playerCloseBook },
      session: {
        bookId: generateStore.bookId,
        buildId: generateStore.buildId,
        phase: generateStore.phase,
        errorMessage: generateStore.errorMessage,
        dirtySummary: generateStore.dirtySummary,
        blankBookJustCreated: generateStore.blankBookJustCreated,
        loadBook: generateStore.loadBook,
      },
    });
    postMultipart.mockResolvedValue({ book_id: 'b1', build_id: '', format: 'vbook' });
    getJson.mockResolvedValue(COVER_BOOK);

    await fileStore.importBookFromFile(new File(['x'], 'book.vbook'));

    expect(resetProgressState).toHaveBeenCalled();
    expect(clearVBookProgress).toHaveBeenCalled();
    expect(generateStore.isRegenerating.value).toBe(false);
    wireRealSeams();
  });
});
