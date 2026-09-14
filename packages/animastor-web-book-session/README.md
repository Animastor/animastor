# @animastor/web-book-session

Book session identity contour for the Animastor web frontend — the single
owner of the open-book identity and its persistence.

## Owns

- `bookId` / `buildId` signals — one source of truth, no fork
- `loadBook(id, build)` — the only sanctioned identity mutator
  (persist on non-empty id, clear on empty — `animastor:currentBook`)
- `stashBookSessionForUser(uid)` / `restoreStashedBookSessionForUser(uid)`
  — per-user stash pair (`animastor:currentBook:user:<uid>`) used by
  authStore on logout/login
- `setGenerationBuildId(build)` — the controlled adapter through which the
  generation flow updates `buildId` (one signal, two legal writers:
  `loadBook` + this adapter)
- `readPersistedBookSession()` — read-only view of the persisted session
  (used by fileStore's `restoreBookSession`; the write path stays here)

## Does NOT own

- `phase` / `errorMessage` — shared session status (dual-writer contract);
  host-owned in generateStore
- `restoreBookSession()` — File-flow orchestration; stays in fileStore
- auth login/logout lifecycle — stays in authStore (this package never
  imports authStore; the direction is `authStore → this package`)
- generation orchestration, playback, navigation — host side

## Dependency rules (guard-pinned)

- Runtime dependency: `@preact/signals` ONLY.
- No imports of host stores, `api/client`, `app/*`, `pages/*`, or any other
  `@animastor/*` package.
- No module-global mutable state beyond the two exported signals.

Consumers reach the identity through the host's `generateStore`
compatibility re-exports — the consumer import surface is unchanged.
