# ANDROID ↔ WEB PARITY AUDIT

> **Date:** 2026-08-24 · **Commits audited:** web `f81a807` .. `25796bb` / android `20e6df4`

---

## Legend

| Tag | Meaning |
|---|---|
| **PARITY** | Already identical — same contract, same API, same behavior |
| **ANDROID GAP** | Android was behind; fixed in this work |
| **ANDROID-ONLY** | Acceptable native deviation; documented and intentional |
| **BACKEND-ONLY** | Contract lives entirely server-side; clients are thin |

---

## 1. Authentication / Identity

| Area | Status | Detail |
|---|---|---|
| Login endpoint | **PARITY** | `POST /api/v1/auth/login` — both clients, cookie-based session |
| Register endpoint | **PARITY** | `POST /api/v1/auth/register` — backend reads guest cookie to convert workspace in-place |
| Logout endpoint | **PARITY** | `POST /api/v1/auth/logout` — idempotent; both clients clear cookies + state |
| Identity resolution | **PARITY** | `GET /auth/me` — both clients mirror; server is source of truth via HttpOnly cookies |
| Guest → authenticated | **PARITY** | Backend converts guest workspace in-place on register (reads guest cookie). Android sends cookies via `PersistentCookieJar` — no client gap |
| Authenticated → guest | **ANDROID GAP → FIXED** | See §A below |
| Token storage | **ANDROID-ONLY** | Web: browser HttpOnly cookies (no JS access). Android: `PersistentCookieJar` in SharedPreferences `animastor_settings:animastor_cookies`. Same contract — both are cookie-driven, neither stores tokens in JS/memory |

### §A: Authenticated → guest transition (logout book isolation)

**Problem:** On logout, Android kept `bookId`/`buildId` in SharedPreferences. In pre-auth mode `checkBookAccess` allows all books, so the previous user's book persisted in the guest context — a cross-user leak.

**Web fix (f81a807):** `stashBookSessionForUser(userId)` moves live session → per-user stash key `animastor:currentBook:user:<userId>`, then clears the live key + signals.

**Android fix:** `BookSessionStore` (new, pure, testable) mirrors the web contract:
- `stashForUser(userId)`: moves live `bookId`/`buildId` → `currentBook:user:<userId>` stash, clears live.
- `restoreStashedForUser(userId)`: re-attaches stash to live if live is empty (never clobbers).
- `GenerateViewModel.stashBookSessionForUser()` + `restoreStashedBookSessionForUser()` delegate to the store and reset in-memory state.
- `MainActivity.handleAuthTransition(before)` detects logout vs login and calls the appropriate method.

**Files changed:**
- `repository/BookSessionStore.kt` — new
- `ui/GenerateViewModel.kt` — stash/restore integration, init from store
- `ui/MainActivity.kt` — transition handler

---

## 2. Book Ownership / Workspace

| Area | Status | Detail |
|---|---|---|
| Workspace ownership guard | **BACKEND-ONLY** | `requireBookAccess` → `checkBookAccess` — server-side, cookie-driven. Clients are thin |
| Anonymous can't see owned books | **BACKEND-ONLY** | `GET /api/v1/books` filters: anonymous sees only unowned; user/guest sees workspace-scoped |
| Cross-workspace guard | **BACKEND-ONLY** | `importBookAllowed` blocks bundle re-import of a foreign workspace's book |
| Guest can't open user's book | **PARITY** | Backend returns 403; both clients display error. Book session isolation (§A) prevents the stale session from reaching the server in the first place |

---

## 3. TXT Import

| Area | Status | Detail |
|---|---|---|
| Import endpoint | **PARITY** | `POST /api/v1/book/import` — multipart, field `file` |
| Original filename preserved | **PARITY** | Android: `FileFragment` → `getFileName(uri)` → temp file in cacheDir with original name → `Repository.importBook()` uses `file.name`. Backend: `m.import_meta.original_filename = req.file.originalname`. Web: `postMultipart('/book/import', file, 'file', file.name)` |
| Hash-based dedup | **BACKEND-ONLY** | SHA-256 of decoded UTF-8 text, registered in `book_source` PG table + disk fallback scan |
| identity + TXT → owned book | **BACKEND-ONLY** | `resolveOwnedTxtDedup(req, ...)` scoped to caller's workspace. Unowned candidates from other workspaces are never returned |
| Same TXT, different users → different books | **BACKEND-ONLY** | Dedup is workspace-scoped; candidates from other workspaces are skipped |
| Guest repeat import → same guest book | **BACKEND-ONLY** | Guest's workspace owns the book; dedup returns it |
| Opens returned `book_id` | **PARITY** | Android: `GenerateViewModel.kt:747-749` — `persistBookId(importRes.book_id)`. Web: `loadBook(bId, ...)`. Neither creates a different book |

---

## 4. Current Book Session

| Area | Status | Detail |
|---|---|---|
| Live session key | **PARITY** | Web: `animastor:currentBook` → `{id, build}`. Android: `bookId`/`buildId` in SharedPreferences `"animastor"` — same contract, different serialization |
| Stash key format | **PARITY** | Web: `animastor:currentBook:user:<userId>`. Android: `currentBook:user:<userId>` + `:build` suffix — equivalent scoped-by-user contract |
| On logout | **ANDROID GAP → FIXED** | Web (f81a807): stash + clear. Android (fixed): `BookSessionStore.stashForUser(userId)` + `clearLive()` |
| On login | **ANDROID GAP → FIXED** | Web (2d34c94): `restoreStashedBookSessionForUser(userId)`. Android (fixed): `BookSessionStore.restoreStashedForUser(userId)` + in-memory sync |
| On logout: book not deleted | **PARITY** | Both: stash moves the session pointer; DB ownership untouched |
| On login: same user gets book back | **PARITY** | Both: stash re-attached; `restoreBookSession()` validates and warms the player |
| restoreBookSession on boot | **PARITY** | Both: read persisted session → validate `GET /book/{id}/status` → fallback `GET /books` → warm player |
| restoreBookSession validates | **ANDROID-ONLY** | Android optimistically retains on IOException (offline resilience). Web: any failure → null → fallback. Acceptable Android-only deviation; cross-user risk eliminated by stash-on-logout |
| Per-user stash in tests | **ANDROID GAP → FIXED** | New `BookSessionStoreTest.kt` (14 tests) mirrors web `auth-book-session.test.ts` (9 tests) plus ownership scenarios |

---

## 5. API Endpoint Comparison

| Web endpoint | Android endpoint | Same request | Same response handling |
|---|---|---|---|
| `GET /api/v1/auth/me` | `GET /api/v1/auth/me` | ✓ | ✓ — `AuthStore.state` mirrors `authMe` signal |
| `POST /api/v1/auth/login` | `POST /api/v1/auth/login` | ✓ body: `{username, password}` | ✓ — session cookie set by server |
| `POST /api/v1/auth/register` | `POST /api/v1/auth/register` | ✓ body: `{username, password, email?}` | ✓ |
| `POST /api/v1/auth/logout` | `POST /api/v1/auth/logout` | ✓ | ✓ — both clear cookies + state |
| `POST /api/v1/book/import` | `POST /api/v1/book/import` | ✓ multipart `file` | ✓ — opens returned `book_id` |
| `GET /api/v1/books` | `GET /api/v1/books` | ✓ | ✓ — fallback in `restoreBookSession` |
| `GET /api/v1/book/{id}/status` | `GET /api/v1/book/{id}/status` | ✓ | ✓ — validation gate |
| `GET /api/v1/book/{id}` | `GET /api/v1/book/{id}` | ✓ | ✓ — warm player |
| `POST /api/v1/book/{id}/bootstrap` | `POST /api/v1/book/{id}/bootstrap` | ✓ | ✓ |
| `POST /api/v1/book/{id}/bootstrap-next-window` | `POST /api/v1/book/{id}/bootstrap-next-window` | ✓ | ✓ |
| `GET /api/v1/book/{id}/agent-status` | `GET /api/v1/book/{id}/agent-status` | ✓ | ✓ |
| `POST /api/v1/book/{id}/regenerate` | `POST /api/v1/book/{id}/regenerate` | ✓ | ✓ |
| `PUT /api/v1/book/{id}/layer-config` | `PUT /api/v1/book/{id}/layer-config` | ✓ | ✓ |
| `GET /api/v1/worker/counts` | `GET /api/v1/worker/counts` | ✓ | ✓ |
| SSE `progress-stream` | SSE `progress-stream` | ✓ | ✓ — OkHttp SSE vs fetch SSE |

---

## 6. Persistent State Comparison

| Web localStorage key | Android SharedPreferences | Notes |
|---|---|---|
| `animastor:currentBook` → `{id, build}` | `"animastor"` → `bookId`, `buildId` | Same live session, different serialization |
| `animastor:currentBook:user:<userId>` | `"animastor"` → `currentBook:user:<userId>`, `:build` | Stash: web = JSON blob, Android = two keys. Equivalent isolation |
| (none — auth is HttpOnly cookies) | `"animastor_settings"` → `animastor_cookies` | Both are cookie-driven; Android persists the cookie jar for cold restart |
| `animastor:theme` (if any) | `"animastor_settings"` → `theme` | UI preference, no security implication |
| `animastor:language` (if any) | `"animastor_settings"` → `language` | UI preference |

---

## 7. Intentional Android-Only Differences

| Area | Difference | Justification |
|---|---|---|
| Cookie persistence | `PersistentCookieJar` in SharedPreferences vs browser native | Android has no browser cookie jar; this is the standard native approach |
| File picker | SAF `ActivityResultContracts.OpenDocument` vs `<input type="file">` | Standard Android file access |
| Library view | WebView loading `app.animastor.in/library` | Reuses web library; WebView has a separate CookieManager (separate session). Acceptable native detail — native book list UI would be a separate feature |
| Offline resilience | `restoreBookSession` keeps book on IOException | Android-specific: mobile networks are less reliable. Cross-user risk eliminated by stash-on-logout |
| Playback position | In-memory only (`SharedPositionManager`) | Position is not persisted to SharedPreferences; same as web (in-memory signals). Acceptable for both |
| Process recreation | Book session survives via SharedPreferences + init{} re-read | Equivalent to web localStorage restore on page reload |
| Filename test | `FileFragment.getFileName()` + temp copy uses original name | Verified intact; uses `OpenableColumns.DISPLAY_NAME` — Android-native approach to SAF filename resolution |

---

## 8. Fixed Gaps (ANDROID GAP → FIXED)

| Gap | Root cause | Fix | File(s) |
|---|---|---|---|
| Logout leaks book to guest | `bookId`/`buildId` prefs survive logout; pre-auth `checkBookAccess` allows all | `BookSessionStore.stashForUser()` + `clearLive()` on logout; `handleAuthTransition()` in MainActivity | `BookSessionStore.kt`, `GenerateViewModel.kt`, `MainActivity.kt` |
| Login doesn't restore user's book | No per-user stash mechanism | `BookSessionStore.restoreStashedForUser()` on login | `BookSessionStore.kt`, `GenerateViewModel.kt`, `MainActivity.kt` |
| In-memory session not cleared on logout | ViewModel's `bookId`/`buildId` vars survive logout | `stashBookSessionForUser()` resets in-memory + UI phase | `GenerateViewModel.kt` |
| restoreBookSession stale on login | Reads only in-memory; stash writes prefs | Re-reads from store when in-memory is blank | `GenerateViewModel.kt` |
| No regression tests for session isolation | Missing Android equivalent of `auth-book-session.test.ts` | `BookSessionStoreTest.kt` (14 tests) | `BookSessionStoreTest.kt` |

---

## 9. Backend Notes (not mixed with Android parity)

| Observation | Impact |
|---|---|
| Identity-scoped TXT dedup lives entirely in `resolveOwnedTxtDedup()` | Clients don't need dedup logic — they just open the returned `book_id` |
| `checkBookAccess` pre-auth allows all books | This is by design for backwards compatibility. The book LIST (`GET /books`) filters by workspace; individual book access stays permissive for deep-link/restore compatibility |
| Guest workspace TTL expiration → 410 | Both clients receive the 410 and can display an expiry message. Android's `AuthState.identity == "guest"` + `workspace.status == "expired"` handles this |
| No backend gaps discovered | Backend provides the needed contract for all scenarios |

---

## 10. Tests

| Suite | Count | Status |
|---|---|---|
| `BookSessionStoreTest` (NEW) | 14 | All passing |
| `PlayerGateTest` (existing) | 16 | All passing |
| `BetaSettingsHelpersTest` (existing) | 15 | All passing |
| **Android unit tests total** | **45** | **All passing** |
| Web vitest | 101 (12 files) | All passing |
| Web typecheck (`tsc --noEmit`) | — | Clean |
| Android compileDebug | — | BUILD SUCCESSFUL |
| Android assembleDebug | — | BUILD SUCCESSFUL (`app-debug.apk`) |
