// FileStore — host-owned File contour state
// (docs/architecture/file-module-extraction-audit.md, blocker B1 split).
//
// Owns the File-screen slice previously embedded in generateStore:
// import/export bookkeeping, the unified import flow
// (importBookFromFile / openBookById / closeBook / createBlankBook) and the
// cold-start session restore (restoreBookSession). This is still host app
// code — the physical `@animastor/file` package is NOT cut here.
//
// Dependency direction (frozen by architecture guards):
//
//   FilePage → FilePorts → fileAdapters → fileStore
//                                            ↓
//                              shared/session infrastructure (via seams)
//
// NOT a second source of truth — shared state deliberately stays in
// generateStore and is reached ONLY through the injected `session` seam:
//  - `bookId`/`buildId` — the session identity is read by Generate/Play/Edit/
//    AiAssistant/Settings/AppShell/navigatorAdapters (7 consumers); a copy here
//    would fork identity. Written only via `session.loadBook`.
//  - `phase` — written by BOTH the File flows (LOADING_BOOK / IMPORTING_TXT /
//    SCENE_READY / IDLE) and the generation slice (GENERATING / SCENE_READY on
//    build finish), and read by AppShell as the desktop bounce mirror
//    (audit B6). One shared signal, two writers — the File-owned values are
//    written through this seam, the signal object stays host-owned.
//  - `errorMessage` — cancelGeneration() (generation slice) clears it for both
//    surfaces; keeping the signal in the host avoids a behavior change.
//  - `dirtySummary` / `blankBookJustCreated` — consumed by EditPage / AppShell.
//  - The persisted localStorage session (`animastor:currentBook` + per-user
//    stash) stays with `loadBook` in generateStore (authStore stash contract,
//    guarded by state/__tests__/auth-book-session.test.ts).
//
// generateStore ↔ playbackStore cycle: this split REMOVES the File leg of it.
// The old generateStore.closeBook() imported playbackStore.closeBook solely to
// release the player when a book closes; that call now arrives through the
// injected `player` seam, so generateStore no longer imports playbackStore at
// all (playbackStore still imports generateStore's onPlaybackPrepared — one
// directed edge remains, which is not a cycle). The guard test freezes this.
//
// Generation-slice internals that File flows must touch are injected too
// (module-scope `vbookPollToken` / `importCompleteReceived`, the SSE stream +
// wall-clock timer teardown) — see GenerationResetSeam; the composition root
// (fileAdapters.ts) binds them to generateStore's exports.
import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import { getJson, postJson, postMultipart } from '../api/client';
import type {
  AssetsStateResponse, BookData, BookStatus, ImportResponse, RecentBooksResponse,
} from '../api/models';
import { sceneRefs } from '../api/models';
import type { SceneRef } from '../api/models';
import { navigateTo, clearPosition } from './positionStore';

/** File-local structural mirror of the shared phase union (host adapter
 *  bridges it to generateStore's `phase` signal — NOT a separate value). */
export type FilePhase =
  | 'IDLE' | 'LOADING_BOOK' | 'GENERATING' | 'DOWNLOADING'
  | 'SCENE_READY' | 'PLAYING' | 'PAUSED' | 'IMPORTING_TXT';

/** One-shot navigation request emitted by the import/deep-link flow
 *  (GenerateViewModel.NavigationEvent equivalent). Consumed by FilePage,
 *  which resets it — so a new import never double-navigates. */
export type FileNavigationEvent = 'play' | 'generate' | null;

// ── File-owned signals (moved verbatim from generateStore's stage-3 slice) ──
export const importMessages = signal<string[]>([]);
export const isExporting = signal(false);
export const exportProgress = signal(0);
export const navigationEvent = signal<FileNavigationEvent>(null);

export function setExporting(v: boolean): void {
  isExporting.value = v;
  if (!v) exportProgress.value = 0;
}
export function setExportProgress(v: number): void {
  exportProgress.value = v;
}

// ── Host-injected seams (composition root wires the real implementations) ──

/**
 * Generation-slice reset surface (host: generateStore). File flows must reset
 * generation UI state exactly as they did while embedded in generateStore —
 * but through this seam, not by importing the generation slice.
 */
export interface GenerationResetSeam {
  /** Clear in-flight worker progress tracking (generateStore.resetProgressState). */
  resetProgressState(): void;
  /** Clear VBook agent progress rows (generateStore.clearVBookProgress). */
  clearVBookProgress(): void;
  /** Mirror isRegenerating (generateStore.setRegenerating). */
  setRegenerating(v: boolean): void;
  /** Invalidate an in-flight VBook agent poll (module-scope token bump). */
  bumpVBookPollToken(): void;
  /** Mark the SSE import_complete handshake not yet received. */
  markImportIncomplete(): void;
  /** Full generation-session teardown for closeBook: stops the SSE progress
   *  stream + wall-clock timer, bumps the poll token, resets the nav-icon
   *  generation status to IDLE (generateStore.stopGenerationSession). */
  stopGenerationSession(): void;
}

/** Player-warming port (host: generateStore.emitPlaybackPrepared → wired by
 *  playbackStore.wirePlaybackCoordination). */
export interface PlaybackPreparedSeam {
  emit(prep: { bookId: string; buildId: string; scenes: SceneRef[] }): void;
}

/** Player release port (host: playbackStore.closeBook) — the removed
 *  generateStore ⇄ playbackStore cycle leg, now an injected call. */
export interface PlayerSeam {
  closeBook(): void;
}

/**
 * Shared session seam (host: generateStore). The canonical identity signals
 * are RECEIVED, never copied — this store writes them only via loadBook and
 * reads them only to decide flow outcomes (audit Phase 2: no session fork).
 */
export interface SessionSeam {
  readonly bookId: Signal<string>;
  readonly buildId: Signal<string>;
  /** Shared phase signal — File flows write their values through it. */
  readonly phase: Signal<FilePhase>;
  readonly errorMessage: Signal<string | null>;
  /** Edit dirty indicator — cleared on import/open/create/close. */
  readonly dirtySummary: Signal<unknown>;
  /** AI-bubble flag — set by createBlankBook, consumed by AppShell. */
  readonly blankBookJustCreated: Signal<boolean>;
  /** Write the shared session identity + persist it (generateStore.loadBook). */
  loadBook(id: string, build: string): void;
}

/** Composition-time wiring. Called once from fileAdapters.ts (host). */
interface FileStoreSeams {
  generationReset: GenerationResetSeam;
  playbackPrepared: PlaybackPreparedSeam;
  player: PlayerSeam;
  session: SessionSeam;
}
let wired: FileStoreSeams | null = null;
export function wireFileStore(seams: FileStoreSeams): void {
  wired = seams;
}
function seams(): FileStoreSeams {
  if (!wired) throw new Error('fileStore: wireFileStore() was not called — composition root missing');
  return wired;
}

// ═══════════════════════════════════════════════════════════════
//  UNIFIED IMPORT — POST /book/import (server-side format detection)
//  Mirrors GenerateViewModel.importBookFromFile: loads the book, emits
//  playbackPrepared, and requests navigation to Play/Generate depending on
//  format + scene list + asset availability.
// ═══════════════════════════════════════════════════════════════

/** Reset the File-screen + generation mirrors shared by every open flow
 *  (importBookFromFile / openBookById / createBlankBook do this verbatim). */
function beginBookTransition(): void {
  const { generationReset, session } = seams();
  // Reset worker tracking and vbook progress from a previous session, so two
  // progress bars never appear when re-opening a book.
  generationReset.resetProgressState();
  generationReset.clearVBookProgress();
  generationReset.bumpVBookPollToken();
  generationReset.setRegenerating(false);
  generationReset.markImportIncomplete();
  session.dirtySummary.value = null;
  session.phase.value = 'LOADING_BOOK';
  session.errorMessage.value = null;
  importMessages.value = [];
  navigationEvent.value = null;
}

export async function importBookFromFile(file: File): Promise<void> {
  const { playbackPrepared, session } = seams();
  beginBookTransition();
  try {
    const res = await postMultipart<ImportResponse>('/book/import', file, 'file', file.name);
    const bId = res.book_id;
    session.loadBook(bId, res.build_id ?? '');
    const bookData = await getJson<BookData>(`/book/${encodeURIComponent(bId)}`).catch(() => null);
    const scenes = bookData ? sceneRefs(bookData) : [];
    const first = scenes.find((s) => s.sceneType === 'cover') ?? scenes[0] ?? null;
    navigateTo({ chapterId: first?.chapterId ?? null, sceneId: first?.sceneId ?? null, unitIndex: 0 });

    if (res.format === 'vbook') {
      // snapshot is a server-side convenience — non-fatal if it fails
      void postJson(`/book/${encodeURIComponent(bId)}/snapshot`).catch(() => {});
      playbackPrepared.emit({ bookId: bId, buildId: session.buildId.value, scenes });
      session.phase.value = scenes.length ? 'SCENE_READY' : 'IDLE';
      navigationEvent.value = scenes.length ? 'play' : 'generate';
    } else {
      // TXT path — technical steps shown on the File screen (take(4))
      importMessages.value = ['✓ File selected', '✓ TXT read', '✓ Encoding detected', '✓ VBook structure created'];
      session.phase.value = 'IMPORTING_TXT';
      playbackPrepared.emit({ bookId: bId, buildId: session.buildId.value, scenes });
      const assets = await getJson<AssetsStateResponse>(`/book/${encodeURIComponent(bId)}/assets-state`).catch(() => null);
      session.phase.value = scenes.length ? 'SCENE_READY' : 'IDLE';
      navigationEvent.value = scenes.length && assets?.has_assets ? 'play' : 'generate';
    }
  } catch (e) {
    session.phase.value = 'IDLE';
    session.errorMessage.value = (e as Error).message || 'Import failed';
  }
}

// ═══════════════════════════════════════════════════════════════
//  DEEP LINK — /file?book=<id> (or ?open=<id>)
//  Web equivalent of the .vbook ACTION_VIEW intent: the linked file is already
//  on the server, so we load it by id (GET /book/{id}) instead of uploading
//  bytes, then follow the same importBookFromFile navigation logic. §12.
// ═══════════════════════════════════════════════════════════════

/**
 * Restore the last-opened book on boot (GenerateViewModel.restoreBookSession).
 * Reads the persisted session from localStorage, validates it against the
 * server, and falls back to the most recent server book (GET /api/v1/books) so
 * a book imported/opened from another client shows up here too. Loads the book
 * data + warms the player via playbackPrepared, without emitting a navigation
 * event (the user stays on the current tab — same as Android).
 *
 * No-op when a book is already open (import or ?book= deep link raced ahead).
 *
 * @returns true if a book was restored.
 */
export async function restoreBookSession(): Promise<boolean> {
  const { playbackPrepared, session } = seams();
  if (session.bookId.value) return false;

  // 1. Persisted session. (Storage contract: generateStore owns the key and
  // the write path via loadBook; this read only decides whether a restore is
  // possible at all — no second write path exists.)
  let id: string | null = null;
  let bld = '';
  try {
    const raw = localStorage.getItem(BOOK_STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { id?: string; build?: string };
      if (p.id) { id = p.id; bld = p.build ?? ''; }
    }
  } catch { /* ignore */ }

  // 2. Validate against the server.
  if (id) {
    const ok = await getJson<BookStatus>(`/book/${encodeURIComponent(id)}/status`)
      .then(() => true)
      .catch(() => false);
    if (!ok) id = null;
  }

  // 3. Fallback: most recent book known to the server.
  if (!id) {
    try {
      const res = await getJson<RecentBooksResponse>('/books');
      const first = res.books?.[0];
      if (first?.book_id) { id = first.book_id; bld = first.build_id ?? ''; }
    } catch { /* offline — nothing to restore */ }
  }
  if (!id) return false;
  // A deep link / import may have opened a book while we were validating.
  if (session.bookId.value) return false;

  session.loadBook(id, bld);
  try {
    const bookData = await getJson<BookData>(`/book/${encodeURIComponent(id)}`);
    const bId = bookData.manifest?.book_id || id;
    // A ?book= deep link / import may have opened another book while we were
    // fetching — never clobber it with the restored session.
    if (session.bookId.value && session.bookId.value !== id) return false;
    session.loadBook(bId, bookData.manifest?.build_id || bld);
    const scenes = sceneRefs(bookData);
    const first = scenes.find((s) => s.sceneType === 'cover') ?? scenes[0] ?? null;
    navigateTo({ chapterId: first?.chapterId ?? null, sceneId: first?.sceneId ?? null, unitIndex: 0 });
    playbackPrepared.emit({ bookId: bId, buildId: session.buildId.value, scenes });
    session.phase.value = scenes.length ? 'SCENE_READY' : 'IDLE';
    return true;
  } catch (e) {
    // Book vanished between validation and load — drop the stale session.
    console.warn('restoreBookSession: load failed, clearing session:', (e as Error).message);
    session.loadBook('', '');
    return false;
  }
}

export async function openBookById(param: string): Promise<void> {
  const { playbackPrepared, session } = seams();
  let id = decodeURIComponent(param).trim();
  // tolerate copy-pasted download URLs (…/book/<id>/download → last segment)
  if (id.includes('/')) id = id.split('/').filter(Boolean).pop() ?? id;
  if (!id) return;
  beginBookTransition();
  try {
    const bookData = await getJson<BookData>(`/book/${encodeURIComponent(id)}`);
    const bId = bookData.manifest?.book_id || id;
    session.loadBook(bId, bookData.manifest?.build_id || '');
    const scenes = sceneRefs(bookData);
    const first = scenes.find((s) => s.sceneType === 'cover') ?? scenes[0] ?? null;
    navigateTo({ chapterId: first?.chapterId ?? null, sceneId: first?.sceneId ?? null, unitIndex: 0 });
    playbackPrepared.emit({ bookId: bId, buildId: session.buildId.value, scenes });
    const assets = await getJson<AssetsStateResponse>(`/book/${encodeURIComponent(bId)}/assets-state`).catch(() => null);
    session.phase.value = scenes.length ? 'SCENE_READY' : 'IDLE';
    navigationEvent.value = scenes.length && assets?.has_assets ? 'play' : 'generate';
  } catch (e) {
    session.phase.value = 'IDLE';
    session.errorMessage.value = (e as Error).message || 'Book not found';
  }
}

/** closeBook() — GenerateViewModel.closeBook equivalent (Create New Book card
 *  + SettingsPage delete flow). Resets BOTH view-model payloads: the shared
 *  session identity + File screen state here, the generation session through
 *  the seam, and the player through the injected port (the former
 *  generateStore ⇄ playbackStore cycle leg). */
export function closeBook(): void {
  const { generationReset, player, session } = seams();
  generationReset.stopGenerationSession();
  generationReset.setRegenerating(false);
  session.loadBook('', ''); // also clears the persisted session
  session.phase.value = 'IDLE';
  session.errorMessage.value = null;
  importMessages.value = [];
  navigationEvent.value = null;
  session.dirtySummary.value = null;
  generationReset.clearVBookProgress();
  clearPosition();
  player.closeBook();
}

/**
 * Create New Visual Book → Editor (Create New Book card).
 * POST /book/blank scaffolds the minimal valid structure (zero chapter → one
 * scene → one unit); we load it and anchor the shared position at its first
 * scene so the Edit screen opens ready. The AI assistant stays available but is
 * no longer the mandatory entry point.
 *
 * @returns the new book id, or null on failure.
 */
export async function createBlankBook(): Promise<string | null> {
  const { session } = seams();
  beginBookTransition();
  try {
    const res = await postJson<{ book_id: string }>('/book/blank', { title: 'Новая книга' });
    const bId = res.book_id;
    session.loadBook(bId, '');
    const bookData = await getJson<BookData>(`/book/${encodeURIComponent(bId)}`);
    const scenes = sceneRefs(bookData);
    const first = scenes.find((s) => s.sceneType === 'cover') ?? scenes[0] ?? null;
    navigateTo({ chapterId: first?.chapterId ?? null, sceneId: first?.sceneId ?? null, unitIndex: 0 });
    session.phase.value = 'SCENE_READY';
    session.blankBookJustCreated.value = true;
    return bId;
  } catch (e) {
    session.phase.value = 'IDLE';
    session.errorMessage.value = (e as Error).message || 'Failed to create book';
    return null;
  }
}

/** MUST stay in sync with generateStore's BOOK_STORE_KEY — the localStorage
 *  session contract is host-owned (written via session.loadBook; this constant
 *  is only read by restoreBookSession to decide whether a restore exists). */
const BOOK_STORE_KEY = 'animastor:currentBook';
