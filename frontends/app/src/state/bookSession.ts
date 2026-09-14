// BookSession — the shared book-identity contour (Step 11 identity module
// preparation, web-generator-extraction-audit.md §19.8 prep step P1 / §20).
//
// This module is the SINGLE OWNER of the book session identity:
//   - `bookId` / `buildId` signals (one source of truth — no fork)
//   - `loadBook(id, build)` — the only sanctioned identity mutator
//   - the persisted localStorage session (write path + key constants)
//   - the per-user stash/restore pair used by authStore on logout/login
//
// It is deliberately dependency-free: imports ONLY @preact/signals. No
// authStore, no generateStore, no fileStore, no api/client, no app/* — the
// module must be liftable 1:1 into packages/animastor-web-book-session/
// without re-architecture (§19.8: "the package cut becomes mechanical").
//
// What stays OUTSIDE this boundary (Step 10 §19 verdicts):
//   - `phase` / `errorMessage` — shared cross-slice session-status concern,
//     dual-writer (fileStore SessionSeam + generation slice); stays in
//     generateStore (audit B6).
//   - `restoreBookSession()` — File-flow orchestration (server validation +
//     fallback + player warming); stays in fileStore, which reads the
//     persisted session through `readPersistedBookSession()` (read-only —
//     this module keeps the only write path).
//   - `applyGenerationResults()` — generation finalization; host-side.
//   - auth login/logout lifecycle decisions — authStore's; it may call
//     stashBookSessionForUser / restoreStashedBookSessionForUser, but this
//     module never imports authStore (no reverse dependency).
//
// buildId hybrid ownership (Step 10 §19.4): the signal + its persistence
// blob are identity-owned, but `startGeneration` assigns a fresh build id
// from the regenerate response. That second legitimate writer goes through
// the controlled `setGenerationBuildId()` adapter — there is still exactly
// ONE `buildId` signal and exactly TWO legal writers (loadBook + the
// adapter), never a second source of truth.
import { signal } from '@preact/signals';

// ── Storage keys (the ONLY definition site of the session key contract) ──
// The open book survives a page reload / app restart: loadBook() writes it,
// closeBook() clears it, and restoreBookSession() (called from main.tsx on
// boot) re-validates it against the server and falls back to the most recent
// server book (GET /api/v1/books). Mirrors SharedPreferences bookId/buildId
// on Android (GenerateViewModel.persistBookId). fileStore reads the live key
// through readPersistedBookSession(); the per-user stash keys are owned here.
export const BOOK_STORE_KEY = 'animastor:currentBook';

function userStashKey(userId: string): string {
  return `${BOOK_STORE_KEY}:user:${userId}`;
}

// ── Identity signals ──
export const bookId = signal('');
export const buildId = signal('');

export interface PersistedBookSession {
  id: string;
  build: string;
}

// ── Persisted book session (localStorage) ──
function persistBookSession(id: string, build: string): void {
  try {
    localStorage.setItem(BOOK_STORE_KEY, JSON.stringify({ id, build }));
  } catch { /* storage unavailable */ }
}
function clearBookSession(): void {
  try { localStorage.removeItem(BOOK_STORE_KEY); } catch { /* ignore */ }
}

/** Read-only view of the persisted session for fileStore.restoreBookSession.
 *  Returns null when the key is absent or corrupt. This module keeps the
 *  ONLY write path (loadBook / stash) — restore decisions stay file-side. */
export function readPersistedBookSession(): PersistedBookSession | null {
  try {
    const raw = localStorage.getItem(BOOK_STORE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { id?: string; build?: string };
    if (p.id) return { id: p.id, build: p.build ?? '' };
  } catch { /* ignore */ }
  return null;
}

// ── Per-user session stash (logout/login isolation) ──
// The live session belongs to whoever is currently viewing. Logging out must
// never leak the previous authenticated user's open book into the anonymous /
// guest context, so the session is stashed under a user-scoped key and the
// live key is cleared. The stash lets the SAME user get their book back on
// next login (book ownership in the DB is untouched).
// authStore remains the OWNER of the login/logout lifecycle: it decides WHEN
// these are called; this module only performs the session persistence
// operation itself — and never imports authStore.

/** Logout: stash the current book session for `userId` and clear the live
 *  session + open-book signals. No-op stash when nothing is open. */
export function stashBookSessionForUser(userId: string | null | undefined): void {
  const raw = (() => { try { return localStorage.getItem(BOOK_STORE_KEY); } catch { return null; } })();
  if (userId) {
    try {
      if (raw) localStorage.setItem(userStashKey(userId), raw);
      else localStorage.removeItem(userStashKey(userId));
    } catch { /* storage unavailable */ }
  }
  loadBook('', '');
}

/** Login: re-attach the book session this user had open before their last
 *  logout, unless a live session already exists (never clobber a newer one). */
export function restoreStashedBookSessionForUser(userId: string | null | undefined): void {
  if (!userId) return;
  try {
    if (localStorage.getItem(BOOK_STORE_KEY)) return;
    const raw = localStorage.getItem(userStashKey(userId));
    if (raw) localStorage.setItem(BOOK_STORE_KEY, raw);
  } catch { /* storage unavailable */ }
}

// ── Identity mutator (the single sanctioned write path) ──
export function loadBook(id: string, build: string = ''): void {
  bookId.value = id;
  buildId.value = build;
  if (id) persistBookSession(id, build);
  else clearBookSession();
}

// ── Controlled generation-side buildId writer ──
// startGeneration() receives a fresh build id from the regenerate response.
// The signal lives here (identity), the generation flow writes through this
// adapter — the second and only other legitimate buildId writer.
export function setGenerationBuildId(build: string): void {
  buildId.value = build;
}
