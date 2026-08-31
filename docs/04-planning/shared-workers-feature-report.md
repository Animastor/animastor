# Shared Workers Feature — Technical Report

> 2026-08-31 · Research-only: no code modified.

---

## 1. Current Architecture

### Key discovery — a three-mode worker model already exists

The worker system is **not** "Private-only". The `workers` table and entire stack already implement three modes (`backend/src/storage/postgres/repositories/worker-repo.js:39`):

| Mode | Workspace | Who manages | Serves |
|---|---|---|---|
| `private` (default) | owned by 1 workspace | its user | only that workspace |
| `share` | owned by 1 workspace | its user | community/system pool (volunteered) |
| `system` | **NULL (workspace-less)** | **admin only** | global pool (all users) |

`mode='system'` **already has exactly the requested Shared-Workers semantics**: centrally managed (`workers_scope_check` forces NULL workspace), no individual owner, usable by everyone via the system pool, and impossible for a normal user to modify (all system mutations are `requireAdmin`). The `share` mode is *not* a match (still user-owned/user-modifiable).

### Backend flow

- **Identity/credential**: `POST /api/v1/workers` creates a worker; one-time token `wrk.<id>.<secret>`; only the SHA-256 hash is stored (`worker-routes.cjs:143`).
- **Workspace isolation**: `userWorkspaceGuard` (`worker-routes.cjs:51`) resolves `workspace_id` only from the session; all list/detail/rotate/revoke/purge SQL is `WHERE workspace_id = $2` — **structurally unable to match workspace-less `system` rows** (NULL never equals a UUID). This is the critical existing security property.
- **Auth boundary**: `requireWorkerAuth` middleware + `worker-auth.js` — Bearer token, fail-closed, PG-authoritative, Redis mirror for the hub hot path.
- **System (shared) worker admin**: `admin-routes.cjs:186-261` — `/api/v1/admin/workers/system` (create/list), `.../:id/rotate`, `.../:id` revoke; `requireAdmin` on all.
- **Visibility/counts**: `worker-health.js` classifies heartbeats by hub-authored `mode`+`workspace_id` (fail-closed). `/api/v1/worker/counts` (`generation-routes.cjs:565`) reports **system+share as the global pool** (`audio/image/video`) and the caller's own `private_*` separately. So shared workers **already appear in every user's counts**.
- **Generation-time selection**: `gpu-dispatcher.js:128` stamps `workspace_id` on a job only when the book's workspace has an active `private` worker of that type; otherwise the job flows to the **system pool**. The gpu-hub pops by mode: `private` → its workspace queue only; `share`/`system` → system pool only (`gpu-hub.js:750`), with poison-write cross-checks.
- **Setup Center**: `worker-setup-routes.cjs` (profiles/methods/artifacts/instructions/status) — used for onboarding *private* workers only.

### Frontend (Web — Preact)

- **Settings UI**: `PrivateWorkersSection.tsx` (`/settings/private-workers`) — lists caller's workers via `GET /workers`; Setup Center wizard (create) + rotate/revoke/purge/details.
- **Data/state**: `features/workers/privateWorkers.ts` — `PrivateWorker` model with `mode: 'private' | 'share'` (`privateWorkers.ts:14`) — **`system` is not in the TS type**.
- **API**: `getJson/postJson/deleteJson('/workers...')` directly in the section; `api/models.ts` has `WorkerCounts` incl. `private_*`.
- **Generation UI exposure**: `GeneratePage.tsx:197` computes section totals as `c[type] + c[private_${type}]` — the global fields already include shared workers.

### Frontend (Android — Kotlin)

- **Not a separate implementation** — consumes the identical backend contract: `BackendApi.kt:653-678` (`listWorkers`, `createWorker`, `rotateWorker`, `revokeWorker`, `purgeWorker`), `PrivateWorkersFragment.kt` mirrors `PrivateWorkersSection.tsx`, `WorkerCounts.kt` mirrors the counts contract, `GenerateFragment` mirrors `sectionState`.
- **Parity**: current parity is clean (all clients are thin over the same endpoints — see `ANDROID_WEB_PARITY.md` §5).

---

## 2. Recommended Architecture

**Reuse the existing `workers` model and treat Shared Workers as `mode='system'`** (optionally exposing the label "Shared" instead of "System" in the UI). Do **not** add a new mode or a parallel worker subsystem.

- Storage, token auth, heartbeat, health classification, gpu-hub queue/pop, and dispatch all already support `system` — zero changes there.
- The only missing capability: a **user-facing read-only list** of shared workers (currently only admins can see system rows).

---

## 3. Files/Modules Involved

| Layer | Files |
|---|---|
| Backend routes | `backend/src/routes/worker-routes.cjs` (add read-only shared endpoints), `admin-routes.cjs` (unchanged) |
| Backend repo | `worker-repo.js` (add `listActiveSystemWorkers`), `worker-health.js` (unchanged) |
| Backend dispatch | `gpu-dispatcher.js`, `gpu-hub/gpu-hub.js` (unchanged) |
| Web | `features/workers/privateWorkers.ts`, `PrivateWorkersSection.tsx` (or new `SharedWorkersSection.tsx`), `pages/SettingsPage.tsx`, `pages/GeneratePage.tsx`, `api/models.ts`, `app/i18n.ts` |
| Android | `repository/PrivateWorkerModels.kt`, `repository/WorkerCounts.kt`, `repository/BackendApi.kt`, `ui/PrivateWorkersFragment.kt` or new `SharedWorkersFragment.kt`, `ui/SettingsFragment.kt`, `ui/GenerateFragment.kt`, `res/values*/strings.xml` |

---

## 4. API / Storage Changes

**Storage: none.** The schema (`schema.js:1277`) already has `mode CHECK ('private','share','system')` + `workers_scope_check`.

**API — add read-only, user-facing endpoints** (all other endpoints already exist):

- `GET /api/v1/workers/shared` — list non-revoked `mode='system'` workers (public shape, never secrets). Auth: any authenticated user (guests optional).
- `GET /api/v1/workers/shared/:workerId` — detail of one shared worker (optional).

Admin CRUD stays at `/api/v1/admin/workers/system/*` (unchanged, `requireAdmin`).

---

## 5. Authorization Design (private vs shared)

The existing **workspace-scoped SQL is the enforcement point** and must be preserved untouched:

- `GET /api/v1/workers`, `/workers/:id`, `/rotate`, `/revoke`, `/purge` — all `WHERE workspace_id = $2`. Since `system` rows have `workspace_id = NULL`, a user can **never** list/rotate/revoke/purge a shared worker through these routes (returns 404 indistinct answer).
- New `/workers/shared` routes — **read-only**, and their SQL must be `WHERE mode='system' AND revoked_at IS NULL` (server-side scope, never client-supplied). No `requireWorkerAuth`, no write verbs.
- Admin system endpoints remain the **only** mutators.

---

## 6. Frontend / Android / Web Changes

- **Web**: widen `WorkerMode` to `'private' | 'share' | 'system'` (`privateWorkers.ts:14`); add a read-only "Shared Workers" card/section in `SettingsPage.tsx` rendering `GET /workers/shared` with status/type/last-seen but **no** rotate/revoke/delete buttons; i18n strings. Generation UI (`GeneratePage`) needs **no change** — shared workers are already in the global counts.
- **Android**: widen `PrivateWorker.mode` in `PrivateWorkerModels.kt`; add `listSharedWorkers()` to `BackendApi.kt` + `Repository.kt`; add a read-only shared-workers view (parity with web); `GenerateFragment` unchanged. Mirrors `ANDROID_WEB_PARITY.md` workflow.
- **No parity gap expected** — both clients hit the same new endpoints.

---

## 7. Security Risks

1. **Cross-scope modification** — a user must never mutate a shared worker. Mitigated *structurally* (NULL vs UUID in `workspace_id` SQL); keep it that way and add tests asserting `GET /workers` never returns `mode='system'` and system workers are un-revocable via user routes.
2. **Existence oracle / enumeration** — shared-worker list must not leak admin intent; a public list is by-design (visible to all), but the per-id detail should answer indistinctly (404) when `mode != 'system'` or revoked.
3. **Scope spoofing in the new endpoints** — never accept `mode`/`workspace_id` from the body; the SQL predicate is the only source of scope.
4. **Privilege escalation via creation** — `POST /api/v1/workers` rejects `mode='system'` already (`worker-routes.cjs:158`); keep `createSystemWorker` admin-only.
5. **Hub poison-write / lane confusion** — already mitigated by the hub's mode-scoped pop + poison-write dead-letter (`gpu-hub.js:750`); no changes.
6. **Denial of shared pool** — revoking/purging shared workers is admin-only, so a user can't drain shared capacity.

---

## 8. Minimal Implementation Plan

1. **Backend**: add `listActiveSystemWorkers()` to `worker-repo.js`; add `GET /api/v1/workers/shared` (+ optional `:workerId`) to `worker-routes.cjs`, reusing `publicWorker()`/`liveInfo()` — read-only, authenticated users only.
2. **Tests**: extend `private-worker-visibility.test.js`/`private-worker-auth.test.js` — user sees shared list but cannot rotate/revoke/purge a shared worker (404), and `GET /workers` never includes `mode='system'`.
3. **Web**: widen `WorkerMode`, add read-only Shared Workers section + i18n; run vitest.
4. **Android**: widen model, add `listSharedWorkers`, add read-only view; run `assembleDebug` + unit tests; update `ANDROID_WEB_PARITY.md`.
5. **Verify** `generateStore.ts` / `GeneratePage` / `GenerateFragment` need no change (shared already counted globally).

---

## 9. Open Questions

1. **Labeling/naming**: Should the UI call these "Shared Workers" while the code keeps `mode='system'` (recommended), or introduce an alias mode `'shared'` that maps to `system` behavior? The latter adds migration + constraint churn for no functional gain.
2. **Guests**: Should anonymous/guest users see the shared-worker list, or only registered users? (Recommend: registered only, consistent with `userWorkspaceGuard`.)
3. **What about the existing `share` mode?** It is user-volunteered, not centrally managed. Should it be surfaced alongside Shared Workers in the UI, or left invisible as today? This determines whether the new read-only section is just `system` or `system`+`share`.
4. **Detail endpoint**: is a per-worker shared detail endpoint needed, or is the aggregate count + list sufficient for the generation UI?
