# Android ↔ Web Frontend Parity Map

> Status: audited 2026-08-21 against `master` (`d302c45`).
> Web frontend (`frontends/app`) is the primary implementation.

## 1. Divergence point

Last commit that touched **both** frontends (Android approximately at parity):

```
630d5cc  2026-08-20  feat(guest): Android auth parity + provisioning hardening + guest MVP tests
```

That commit brought Android to parity with the Authentication MVP
(`fedf3d6`: /auth/register|login|logout|me, HttpOnly session cookie, guest
workspaces) — Android got `AuthStore`, `AuthDialog`, `PersistentCookieJar`.

### Web-only commits AFTER the divergence point

| Commit | Date | Subject | Class |
|--------|------|---------|-------|
| `1da0e1f` | 08-20 | workspace-scoped AI providers (`/api/v1/settings/ai/*` + `/settings/ai` UI) | **A** — missing Android functionality |
| `c15ec1e` | 08-21 | private worker management (`GET /workers/:id`, derived ONLINE/OFFLINE/REVOKED, `/settings/private-workers` UI) | **A** |
| `c012690` | 08-21 | frontend `provider_type` selector (openrouter / openai-compatible / custom) + status pill | **A** |
| `695cdb9` | 08-21 | private worker onboarding (5-step setup contract, `GET /gpu/worker-source`, OFFLINE troubleshooting) | **A** |
| `61e1d76` | 08-21 | system AI kill switch + admin foundation (`/api/v1/admin/*`, `AdminPage` on **admin.animastor.in**) | **C** — intentional platform-specific |

Why `61e1d76` is class C: the Admin surface is deliberately a separate host
(`admin.animastor.in`) guarded twice — nginx Basic Auth AND backend
`requireAdmin` (role=admin / allowlist). The Android app points at
`app.animastor.in` and serves end users, not operators; admin control is not
part of the Experimental Beta user loop (§4 of
`docs/04-planning/EXPERIMENTAL_BETA_VERSION.md`). No Android action required.

No class B (outdated Android) or D (obsolete web) items were found: everything
before `630d5cc` was built as explicit web↔Android parity work (see commit
messages "web parity", "both frontends").

## 2. Shared backend contract check (Phase 3)

The divergence is **purely frontend**: all post-divergence backend endpoints
exist, are workspace-scoped via the session cookie, and need no changes:

- `GET|PUT|DELETE /api/v1/settings/ai/provider`, `POST /api/v1/settings/ai/test`
  (`backend/src/routes/settings-ai-routes.cjs`) — identity = user OR guest,
  workspace id always server-resolved from `req.workspace`.
- `POST|GET /api/v1/workers`, `GET /api/v1/workers/:id`,
  `POST /api/v1/workers/:id/rotate`, `DELETE /api/v1/workers/:id`
  (`backend/src/routes/worker-routes.cjs`) — **registered users only** (guests
  get 401/403 by design), one-time token disclosure on create/rotate.
- AI resolution (`resolveAIForWorkspace`) happens server-side in chat/parser/
  generation — clients send no provider info, so Android chat/import/generation
  automatically benefit once a workspace provider is configured.

Android already sends the session/guest cookies on every request
(`PersistentCookieJar` + Retrofit), so **no backend or contract fix is
required** — Checkpoint B of the parity task is skipped as "not required".

## 3. Parity matrix

Legend — Diff: A missing on Android · B outdated on Android · C intentional
platform difference · — at parity. Priority: P0 Experimental Beta loop ·
P1 important user functionality · P2 secondary UX · P3 cosmetic.

| Feature | Web status | Android status | Diff | Required action | Priority |
|---|---|---|---|---|---|
| Authentication (register/login/logout, /auth/me) | ✓ `authStore.ts` + `UserMenu` | ✓ `AuthStore.kt` + `AuthDialog.kt` (630d5cc) | — | none | — |
| Guest identity + provisioning | ✓ | ✓ (630d5cc) | — | none | — |
| Workspace display | UserMenu dropdown: username + Personal workspace | AuthDialog panel: same content | C | none (dropdown vs dialog = platform convention) | — |
| Workspace selection/switching | not implemented (server-resolved, single personal workspace) | same | — | none (future stage on both) | — |
| Settings — general (theme/language/server/cache/delete vbook) | ✓ GeneralSection | ✓ SettingsFragment | — | none | — |
| Settings — VBook (scenes per pass) | ✓ /settings/vbook | ✓ VBookSettingsFragment | — | none | — |
| Settings — generation (profiles/timeout/workflow/worker counts) | ✓ /settings/worker | ✓ WorkerSettingsFragment | — | none | — |
| **User AI provider config** (endpoint/key/model, save/test/delete) | ✓ /settings/ai (AIProviderSection) | ✗ absent | **A** | add Retrofit endpoints + AI-provider settings screen | **P0** |
| **provider_type selector** (openrouter/openai-compatible/custom) + status/last-tested pill | ✓ (c012690) | ✗ absent | **A** | part of the AI-provider screen | **P0** |
| **Private worker management** (list/add/rotate/revoke, status ONLINE/OFFLINE/REVOKED, one-time credential disclosure) | ✓ /settings/private-workers | ✗ absent | **A** | add Retrofit endpoints + private-workers screen | **P0** |
| **Worker onboarding** (5-step setup contract, env block, download/run commands, OFFLINE troubleshooting) | ✓ (695cdb9) | ✗ absent | **A** | part of the private-workers screen (disclosure dialog) | **P0** |
| System/fallback AI settings + kill switch (admin) | ✓ AdminPage on admin.animastor.in | ✗ absent | **C** | none — separate admin host (Basic Auth + requireAdmin), not a user-app feature | — |
| Chat (AI assistant) | ✓ AiAssistantPage | ✓ AiAssistantFragment | — | none — provider resolution is server-side | — |
| Book / TXT import | ✓ FilePage | ✓ FileFragment | — | none | — |
| Agent book parsing (bootstrap/lazy-parse/agent-status) | ✓ | ✓ | — | none | — |
| Generation (progress, scope, cancel) | ✓ GeneratePage | ✓ GenerateFragment | — | none | — |
| Workers availability counts | ✓ | ✓ | — | none | — |
| Profiles (connector profiles) | ✓ | ✓ | — | none | — |
| Editor (chapters/scenes/units, characters/locations/voices) | ✓ EditPage | ✓ EditFragment | — | none | — |
| Imagination units | ✓ | ✓ | — | none | — |
| Player (reveal gate, unit seek, state machine) | ✓ PlayPage | ✓ PlayFragment + PlayerGate | — | none | — |
| Generator navigation/status on mode bar | ✓ | ✓ | — | none | — |
| Library | ✓ public /library page | ✓ LibraryFragment | C | none | — |
| Workflows manager | ✓ | ✓ | — | none | — |
| Developer view | ✓ /dev | ✓ DeveloperViewFragment | — | none | — |
| API contracts (/api/v1, cookie auth) | ✓ | ✓ same endpoints via Retrofit | — | none | — |

## 4. Implementation plan

### P0 — Experimental Beta parity (this change)

The Beta loop (§4): register → workspace → **configure personal AI provider**
→ **connect private worker** → import TXT → AI parses → generate → play.
Android is missing exactly the two bolded steps' management UIs.

1. `BackendApi.kt` — add endpoints (same contracts as web `client.ts` calls):
   - `GET/PUT/DELETE /api/v1/settings/ai/provider`, `POST /api/v1/settings/ai/test`
   - `GET/POST /api/v1/workers`, `POST /api/v1/workers/{id}/rotate`,
     `DELETE /api/v1/workers/{id}`
2. Models: `AiProviderModels.kt`, `PrivateWorkerModels.kt` (mirror web
   `aiProviders.ts` / `privateWorkers.ts` shapes; never carry plaintext keys
   back from the server — meta only).
3. `AiProviderSettingsFragment` — provider_type spinner (OpenRouter autofill),
   endpoint, one-time API key entry (cleared after save, never persisted),
   model, Save / Test connection / Delete, status + last-tested pill.
4. `PrivateWorkersFragment` — list (name, status, type, last seen), Add dialog
   (name + type), Rotate/Revoke confirmations, one-time credential disclosure
   dialog with the 5-step setup contract + copyable env block, OFFLINE
   troubleshooting hints. Token lives only in dialog memory, cleared on close.
5. `SettingsFragment` — two new nav rows (web parity: `worker_mgmt_title`,
   `ai_provider_title`) in the existing nav-row card.
6. Strings (en + ru) mirroring web i18n keys.
7. Pure-helper JUnit tests (validation, token shape) — same convention as
   `PlayerGateTest.kt` / web `privateWorkers.test.ts`.

**Status: implemented** (Checkpoint C). Files: `AiProviderModels.kt`,
`PrivateWorkerModels.kt`, `BackendApi.kt` (+8 endpoints),
`BetaSettingsHelpers.kt` (pure, JVM-tested — `BetaSettingsHelpersTest.kt`,
15 tests), `AiProviderSettingsFragment` + `fragment_ai_provider_settings.xml`,
`PrivateWorkersFragment` + `fragment_private_workers.xml` +
`item_private_worker.xml`, `SettingsFragment` nav rows, en+ru strings.
Verified: `assembleDebug` green; live contract smoke test against the running
stack (register → GET/PUT/DELETE settings/ai/provider → POST settings/ai/test
→ workers create/rotate/revoke) — all response shapes match the Kotlin models.

Security invariants to keep (identical to web):
- API key / worker token are ONE-TIME entries; never written to
  SharedPreferences, files, logs or URLs; cleared from view state after use.
- Worker management requires a registered user; guests get 401 — the Android
  screen surfaces the localized error, no guest workaround.

### P1 — important missing user functionality

None identified. All user-facing capabilities before the divergence point are
at parity; everything after it is covered by P0 (plus the intentional admin
exception).

### P2 — secondary UX parity

- Worker detail refresh-on-resume (web re-reads list after test/rotate;
  Android does the same in P0; pull-to-refresh would be an extra).
- Admin surface — only ever if operators start using Android (class C today).

### P3 — cosmetic

None worth tracking while P0 is open (per task rules).
