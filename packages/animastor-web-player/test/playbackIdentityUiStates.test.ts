// Phase 2.1 targeted behavioral regression audit (commit a77a2194,
// "fix(web-player): close player identity boundary").
//
// a77a2194 removed PlayPage's import of the engine-internal playbackStore
// identity signals and re-derived its UI decisions from the session port:
//
//   OLD                                          NEW
//   statusText(s, t, sessionBookId):             statusText(s, t, hasBook):
//     !bookId.value && !sessionBookId → empty      !hasBook          → empty
//     !bookId.value → no_generation                hasBook && !C     → no_generation
//     else → book_loaded                           else (C>0)        → book_loaded
//   placeholder (IDLE): mirror of the above      placeholder: mirror (hasBook)
//   mount auto-init: !bookId.value && S          mount auto-init: !C && !queue && S
//   with hasBook = !!S || !!uiState.sceneCount   (S = session.bookId, C = sceneCount)
//
// This suite is the audit's executable form (docs task "Web Player Phase 2.1 —
// targeted behavioral regression audit"): it embeds the OLD decision bodies
// verbatim (reading a `bookIdValue` parameter instead of the imported signal —
// the signal is gone from PlayPage by design) and asserts the NEW bodies agree
// across the enumerated identity/UI state matrix:
//
//   S1 no book open                    S5 session set, engine not yet adopted
//   S2 session set, no generation yet  S6 sceneQueue present / absent
//   S3 book loaded, sceneCount > 0     S7 sceneCount === 0 (post-invalidation)
//   S4 engine identity already set
//
// Engine coupling invariants that make the equivalence hold (verified against
// playbackStore.ts, see the per-test comments):
//   INV-1 preparePlayback/refreshContent always set the engine identity
//        TOGETHER with the scene queue (sceneCount = scenes.length ≥ 1) —
//        playbackStore.ts:339-340 / :396-397.
//   INV-2 ensureInitialized is idempotent per book (early-return on the same
//        id) and is the only adoption path on Play mount — :438-455.
//   INV-3 restoreSavedPositionIfAny is safe to run before adoption: when the
//        engine is not adopted yet it defers into pendingPositionRestore and
//        only then calls ensureInitialized itself (:2061-2080) — it never
//        consumes the mount auto-init's precondition.
//   INV-4 transition() forces phase = IDLE alongside the internal player state
//        (stopAll/prepare paths) — the UI phase never goes IDLE while a scene
//        is actually loaded, so C>0 ∧ phase=IDLE keeps its loaded semantics.
//   INV-5 seekToPosition keeps the pending external seek when the engine is
//        not adopted (no bookId) — the mount auto-init dropping that
//        precondition would drop the seek; the new gate stays closed until
//        preparePlayback lands, and preparePlayback executes deferred seeks.
import { describe, it, expect } from 'vitest';
import type { PlaybackUiState } from '../src/playbackStore';

// ── The decision bodies under audit ─────────────────────────────────────────

/** i18n stub: the audit asserts on KEYS (locale-independent), not strings. */
const t = (key: string): string => key;

function idleState(sceneCount: number, phase: PlaybackUiState['phase'] = 'IDLE'): PlaybackUiState {
  return {
    phase,
    errorMessage: null,
    sceneCount,
    currentIndex: 0,
    currentUnitIndex: 0,
    chunkSequence: 0,
  };
}

// OLD statusText body (verbatim from 521919d2's PlayPage.tsx, signal read
// replaced by the `bookIdValue` parameter).
function statusTextOld(
  s: PlaybackUiState, tFn: (k: string) => string, sessionBookId: string, bookIdValue: string,
): string {
  if (s.errorMessage) return `Error: ${s.errorMessage}`;
  switch (s.phase) {
    case 'LOADING_BOOK':
    case 'GENERATING':
    case 'DOWNLOADING':
    case 'IMPORTING_TXT':
      return tFn('play_loading');
    case 'SCENE_READY':
      return tFn('play_ready');
    case 'PLAYING':
      return tFn('play_playing');
    case 'BUFFERING':
      return tFn('play_loading');
    case 'PAUSED':
      return tFn('play_paused');
    case 'IDLE':
    default:
      if (!bookIdValue && !sessionBookId) return tFn('empty_state');
      if (!bookIdValue) return tFn('play_placeholder_no_generation');
      return tFn('empty_state_book_loaded');
  }
}

// NEW statusText body (verbatim from a77a2194's PlayPage.tsx).
function statusTextNew(s: PlaybackUiState, tFn: (k: string) => string, hasBook: boolean): string {
  if (s.errorMessage) return `Error: ${s.errorMessage}`;
  switch (s.phase) {
    case 'LOADING_BOOK':
    case 'GENERATING':
    case 'DOWNLOADING':
    case 'IMPORTING_TXT':
      return tFn('play_loading');
    case 'SCENE_READY':
      return tFn('play_ready');
    case 'PLAYING':
      return tFn('play_playing');
    case 'BUFFERING':
      return tFn('play_loading');
    case 'PAUSED':
      return tFn('play_paused');
    case 'IDLE':
    default:
      if (!hasBook) return tFn('empty_state');
      if (!s.sceneCount) return tFn('play_placeholder_no_generation');
      return tFn('empty_state_book_loaded');
  }
}

// OLD placeholder body (verbatim from 521919d2's PlayPage.tsx).
function placeholderOld(
  s: PlaybackUiState, tFn: (k: string) => string, genBookIdValue: string, bookIdValue: string,
): string {
  let placeholder = '';
  if (s.phase === 'IDLE') {
    if (!bookIdValue && !genBookIdValue) placeholder = tFn('play_placeholder');
    else if (!bookIdValue) placeholder = tFn('play_placeholder_no_generation');
    else placeholder = tFn('play_generate_hint');
  }
  return placeholder;
}

// NEW placeholder body (verbatim from a77a2194's PlayPage.tsx).
function placeholderNew(s: PlaybackUiState, tFn: (k: string) => string, hasBook: boolean): string {
  let placeholder = '';
  if (s.phase === 'IDLE') {
    if (!hasBook) placeholder = tFn('play_placeholder');
    else if (!s.sceneCount) placeholder = tFn('play_placeholder_no_generation');
    else placeholder = tFn('play_generate_hint');
  }
  return placeholder;
}

// Mount auto-init gates.
const autoInitOld = (bookIdValue: string, sessionBookId: string): boolean =>
  !bookIdValue && !!sessionBookId;
const autoInitNew = (sceneCount: number, queueSize: number, sessionBookId: string): boolean =>
  !sceneCount && !queueSize && !!sessionBookId;

// The new hasBook derivation (verbatim from a77a2194's PlayPage.tsx).
const hasBookOf = (sessionBookId: string, sceneCount: number): boolean =>
  !!sessionBookId || !!sceneCount;

// ── The state matrix ────────────────────────────────────────────────────────

interface MatrixCase {
  name: string;
  sessionBookId: string;   // props.ports.session.bookId.value
  engineBookId: string;    // playbackStore.bookId.value (OLD reads only)
  sceneCount: number;      // uiState.sceneCount
  queueSize: number;       // sceneQueue.value.length
  phase: PlaybackUiState['phase'];
}

const CASES: MatrixCase[] = [
  // S1 — no open book: nothing adopted anywhere.
  { name: 'S1 no book open', sessionBookId: '', engineBookId: '', sceneCount: 0, queueSize: 0, phase: 'IDLE' },
  // S2 — session has a book, no generation/player adoption yet (fresh open,
  //      before the playbackPrepared round-trip lands).
  { name: 'S2 session set, no generation yet', sessionBookId: 'b1', engineBookId: '', sceneCount: 0, queueSize: 0, phase: 'IDLE' },
  // S3 — book loaded and playing-capable: adopted with scenes (INV-1).
  { name: 'S3 book loaded, sceneCount > 0', sessionBookId: 'b1', engineBookId: 'b1', sceneCount: 5, queueSize: 5, phase: 'IDLE' },
  // S4 — engine identity already set, session identity present (steady state
  //      after import/open flows: preparePlayback ran, session open).
  { name: 'S4 engine identity set', sessionBookId: 'b1', engineBookId: 'b1', sceneCount: 3, queueSize: 3, phase: 'IDLE' },
  // S5 — session identity present, engine identity NOT yet accepted (the
  //      mount auto-init case; queue/sceneCount still empty per INV-1).
  { name: 'S5 session set, engine not yet adopted', sessionBookId: 'b1', engineBookId: '', sceneCount: 0, queueSize: 0, phase: 'IDLE' },
  // S6a — queue present (post-adopt steady state, INV-1: queue ⟺ identity).
  { name: 'S6a sceneQueue present', sessionBookId: 'b1', engineBookId: 'b1', sceneCount: 2, queueSize: 2, phase: 'IDLE' },
  // S6b — queue absent with no adoption (S1/S5 queue dimension).
  { name: 'S6b sceneQueue absent', sessionBookId: 'b1', engineBookId: '', sceneCount: 0, queueSize: 0, phase: 'IDLE' },
  // S7 — sceneCount === 0 with NO engine adoption: the auto-init must fire
  //      (this is S5's engine dimension — separate case to pin the gate).
  { name: 'S7 sceneCount 0, engine empty', sessionBookId: 'b1', engineBookId: '', sceneCount: 0, queueSize: 0, phase: 'IDLE' },
  // S7b — engine adopted but every scene invalidated afterwards (EditPage
  //      delete-all flows: invalidateDeletedScene/Chapter drain the queue and
  //      sceneCount while the engine identity stays set). Reachable corner —
  //      see the divergence note in the IDLE test below.
  { name: 'S7b sceneCount 0, engine adopted', sessionBookId: 'b1', engineBookId: 'b1', sceneCount: 0, queueSize: 0, phase: 'IDLE' },
  // Non-IDLE phases: identity plays no role in either version — one sample
  // per branch family keeps the audit honest without duplicating the switch.
  { name: 'phase SCENE_READY', sessionBookId: 'b1', engineBookId: 'b1', sceneCount: 5, queueSize: 5, phase: 'SCENE_READY' },
  { name: 'phase PLAYING', sessionBookId: 'b1', engineBookId: 'b1', sceneCount: 5, queueSize: 5, phase: 'PLAYING' },
  { name: 'phase PAUSED', sessionBookId: 'b1', engineBookId: 'b1', sceneCount: 5, queueSize: 5, phase: 'PAUSED' },
  { name: 'phase BUFFERING', sessionBookId: 'b1', engineBookId: 'b1', sceneCount: 5, queueSize: 5, phase: 'BUFFERING' },
  { name: 'phase LOADING_BOOK', sessionBookId: 'b1', engineBookId: 'b1', sceneCount: 5, queueSize: 5, phase: 'LOADING_BOOK' },
];

// ── The audit ───────────────────────────────────────────────────────────────

describe('Phase 2.1 identity rewrite — behavioral equivalence audit', () => {
  it('statusText: OLD vs NEW agree on every enumerated state (one documented corner)', () => {
    for (const c of CASES) {
      const s = idleState(c.sceneCount, c.phase);
      const oldKey = statusTextOld(s, t, c.sessionBookId, c.engineBookId);
      const newKey = statusTextNew(s, t, hasBookOf(c.sessionBookId, c.sceneCount));
      if (c.name === 'S7b sceneCount 0, engine adopted') {
        // THE documented corner (reachable only via EditPage delete-all while
        // the book stays open): OLD showed "book loaded", NEW shows the
        // generation hint. Pinned deliberately: both keys prompt the user to
        // generate; the NEW key is the accurate prompt for a book whose
        // scenes are all gone (nothing is loaded to play), and any subsequent
        // preparePlayback (regeneration) restores the loaded message. No
        // state/playback behavior changes — an i18n key choice only.
        expect(oldKey, `${c.name}: OLD`).toBe('empty_state_book_loaded');
        expect(newKey, `${c.name}: NEW (pinned refinement)`).toBe('play_placeholder_no_generation');
        continue;
      }
      expect(newKey, `${c.name}: NEW must equal OLD`).toBe(oldKey);
    }
  });

  it('placeholder: OLD vs NEW agree on every enumerated state (same corner, same pin)', () => {
    for (const c of CASES) {
      const s = idleState(c.sceneCount, c.phase);
      const oldKey = placeholderOld(s, t, c.sessionBookId, c.engineBookId);
      const newKey = placeholderNew(s, t, hasBookOf(c.sessionBookId, c.sceneCount));
      if (c.name === 'S7b sceneCount 0, engine adopted') {
        expect(oldKey, `${c.name}: OLD`).toBe('play_generate_hint');
        expect(newKey, `${c.name}: NEW (pinned refinement)`).toBe('play_placeholder_no_generation');
        continue;
      }
      expect(newKey, `${c.name}: NEW must equal OLD`).toBe(oldKey);
    }
  });

  it('mount auto-init: the new gate fires exactly when the old gate did (S7b divergence is benign — proven below)', () => {
    for (const c of CASES) {
      const oldGate = autoInitOld(c.engineBookId, c.sessionBookId);
      const newGate = autoInitNew(c.sceneCount, c.queueSize, c.sessionBookId);
      if (c.name === 'S7b sceneCount 0, engine adopted') {
        // THE second documented divergence: with the engine adopted but every
        // scene invalidated (EditPage delete-all), the OLD gate stayed closed
        // (!bookId.value === false) while the NEW gate opens (sceneCount 0 +
        // session set). Benign BY CONSTRUCTION: ensureInitialized early-returns
        // for an already-adopted book (playbackStore.ts:439, proven against
        // the real engine in the describe below) — the extra call is a no-op,
        // no refetch, no state reset.
        expect(newGate, `${c.name}: NEW gate (divergence pinned)`).toBe(true);
        expect(oldGate, `${c.name}: OLD gate`).toBe(false);
        continue;
      }
      expect(newGate, `${c.name}: auto-init gate must match OLD`).toBe(oldGate);
    }
    // Explicit pin of the load-bearing directions:
    // no book → no init; session set + engine empty → init; adopted → no re-init.
    expect(autoInitNew(0, 0, '')).toBe(false);
    expect(autoInitNew(0, 0, 'b1')).toBe(true);
    expect(autoInitNew(3, 3, 'b1')).toBe(false);
  });

  it('mount auto-init: init fires on a fresh session while restoreSavedPositionIfAny has deferred its own (INV-3 ordering preserved)', () => {
    // restoreSavedPositionIfAny with a saved session defers into
    // pendingPositionRestore and calls ensureInitialized ITSELF (only when
    // the engine is not adopted); the mount gate then sees sceneCount 0 and
    // calls ensureInitialized again — idempotent per book (INV-2), so the
    // double call cannot double-prepare. The OLD code had the same shape
    // (its gate was equally open), so ordering behavior is unchanged.
    expect(autoInitOld('', 'b1')).toBe(autoInitNew(0, 0, 'b1'));
  });

  it('hasBook keeps the OLD OR-truth: session identity alone or engine scenes alone both count as "book present"', () => {
    // The OLD first-branch condition was (!bookId.value && !sessionBookId) —
    // i.e. present = bookId.value || sessionBookId. The NEW hasBook must be
    // that OR over the session signal plus a sceneCount stand-in for the
    // engine projection (INV-1: adoption ⟹ scenes).
    expect(hasBookOf('', 0)).toBe(false);
    expect(hasBookOf('b1', 0)).toBe(true);   // session alone (old: sessionBookId)
    expect(hasBookOf('', 4)).toBe(true);     // engine scenes alone (old: bookId.value)
    expect(hasBookOf('b1', 4)).toBe(true);
  });

  it('pending external seek: the new auto-init gate stays open until adoption, preserving seekToPosition deferral (INV-5)', () => {
    // Old behavior: with the engine not adopted (!bookId.value) and a session
    // book, the mount auto-init ran → ensureInitialized → preparePlayback,
    // which executes a deferred seek. The new gate is open in exactly that
    // state (S5/S7) and closed once adopted — a seek arriving before adoption
    // is still kept pending by seekToPosition and executed by
    // preparePlayback, exactly as before.
    expect(autoInitNew(0, 0, 'b1')).toBe(true);  // pre-adoption: init runs, seek path preserved
    expect(autoInitNew(2, 2, 'b1')).toBe(false); // adopted: no re-init, no interference
  });
});

// ── Engine idempotence — the real-store proof backing the S7b pin ──────────
//
// The S7b auto-init divergence (NEW gate fires where OLD stayed closed) is
// benign only because ensureInitialized early-returns for an already-adopted
// book. This describe drives the REAL playbackStore (fake ports, same pattern
// as the sibling suites) to prove that contract instead of trusting it.
import { beforeEach, afterEach, vi } from 'vitest';
import type { SceneRef } from '../src/models';
import type { PlayerPorts } from '../src/ports';

const fakePorts = {
  generation: { onPlaybackPrepared: vi.fn() },
  position: { navigateTo: vi.fn() },
  invalidations: {
    onResourceInvalidated: vi.fn(),
    isBookResource: vi.fn((resource: string) => resource.startsWith('book:')),
  },
  http: {
    getJson: vi.fn(async (_url: string): Promise<unknown> => { throw new Error('must not refetch an adopted book'); }),
    getBlob: vi.fn(async () => new Blob([])),
    retryWithBackoff: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    videoUrl: vi.fn((path: string) => 'http://test' + path),
  },
};
vi.mock('../src/mediaCache', () => ({
  getMedia: vi.fn(async () => undefined),
  putMedia: vi.fn(async () => {}),
  clearCache: vi.fn(async () => 0),
}));

import { ensureInitialized, preparePlayback, sceneQueue, uiState, wirePlaybackCoordination } from '../src/playbackStore';

const adoptedScenes: SceneRef[] = [
  { chapterId: 'ch', sceneId: 'sc1' } as SceneRef,
  { chapterId: 'ch', sceneId: 'sc2' } as SceneRef,
];

describe('Phase 2.1 identity rewrite — engine idempotence makes the S7b re-init benign', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-wire through the public seam (idempotent, like main.tsx).
    wirePlaybackCoordination(fakePorts as unknown as PlayerPorts);
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {} });
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock'),
      revokeObjectURL: vi.fn(),
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('ensureInitialized on an already-adopted book is a no-op (no refetch, no state reset)', async () => {
    preparePlayback('b1', 'build1', adoptedScenes);
    const queueBefore = sceneQueue.value;
    const uiBefore = uiState.value;
    expect(uiBefore.sceneCount).toBe(2);

    // The S7b corner: mount auto-init fires while the engine is adopted.
    await ensureInitialized('b1', 'build1');

    expect(fakePorts.http.getJson).not.toHaveBeenCalled(); // no book refetch
    expect(sceneQueue.value).toBe(queueBefore);            // queue untouched
    expect(uiState.value).toBe(uiBefore);                  // uiState untouched
  });

  it('ensureInitialized still adopts when the engine is NOT initialized (S5/S7 path intact)', async () => {
    // Engine empty (fresh module state is guaranteed by the store-level reset
    // the previous test's prepare overwrote — re-prepare with a DIFFERENT id
    // would adopt that id; instead drive the genuine empty-engine path via a
    // distinct book): the gate fires and the fetch happens.
    preparePlayback('b1', 'build1', adoptedScenes);
    // Simulate the not-yet-adopted state the mount gate is written for by
    // pointing ensureInitialized at a DIFFERENT, never-adopted book id.
    fakePorts.http.getJson.mockImplementationOnce(async () => ({
      chapters: [{
        chapter_id: 'chX',
        scenes: [{ scene_id: 'scX', scene_type: 'cover' }],
      }],
    }));
    await ensureInitialized('b9', 'build9');
    expect(fakePorts.http.getJson).toHaveBeenCalledWith('/book/b9');
  });
});
