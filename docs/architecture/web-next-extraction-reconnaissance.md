# Web Frontend — Next Extraction Candidates Reconnaissance

**Status:** READ-ONLY reconnaissance (audit only). No production code changed, no files moved, no packages created.  
**Date:** 2026-09-13  
**Branch:** `c21.4-physically-extract-analysis-from-backend`  
**Baseline commit:** `ebbc22f26cc6b37de9465a4be707f407f87a1fd4` ("test(web): harden editor package boundary")  
**Method:** static import-graph tracing over `frontends/app/src/**`, LOC measurement, port surface analysis, cross-checked against existing extraction patterns (`@animastor/web-player`, `@animastor/web-ai-chat`, `@animastor/web-settings`, `@animastor/web-editor`, `@animastor/web-file`, `@animastor/web-navigator`).

---

## 1. Executive Summary

After physically extracting 6 web packages (player, ai-chat, settings, editor, file, navigator), the remaining web frontend contains **17,534 LOC in 40 source files** (excluding tests and CSS). The **Generator** (`generateStore.ts` + `GeneratePage.tsx` + `AnalysisProgressPanel.tsx`) is the largest remaining domain but is the **least extractable** because `generateStore.ts` owns session identity (`bookId`/`buildId`) that ALL other modules consume. The **next safest extraction candidate** is `features/workers/` (Private Worker Management) — a 3,739-LOC self-contained vertical slice with 4 existing test files, zero `bookId`/`buildId` dependency, and a single consumer (`SettingsPage.tsx`).

**Key findings:**

1. **Generator is NOT READY** for extraction — `generateStore` is the host-owned source of truth for session identity. Extracting it would invert the dependency direction (package → host) or require splitting the store into identity-owned (host) and generation-action (package) halves, which is high-risk surgery with no precedent in this codebase.
2. **`features/workers/`** (Private Worker Management) is the clear winner: 3,739 LOC, 4 test files, single consumer, no bookId/buildId, clean internal DAG, 6 well-defined host ports.
3. **`features/localAi/`** (778 LOC) is a distant second — good size but needs tests and has heavier API surface.
4. **Workflow pages** (896 LOC) are moderate candidates but share mutable `routeState.ts` signals, creating extraction coupling.
5. **`features/auth/`** and **`features/admin/`** are too deeply coupled to `authStore` (which itself depends on `generateStore`) — extracting them requires untangling the auth→identity chain first.

---

## 2. Current Web Frontend Map (Post-Extraction)

### 2.1 Directory inventory

| Directory | Files | LOC | Role |
|---|---|---|---|
| `main.tsx` | 1 | 92 | Entry point — Preact bootstrap, route registration |
| `api/` | 2 | 1,085 | HTTP client + TypeScript models (1:1 with backend DTOs) |
| `app/` | 11 | 2,986 | Shell, routing, i18n, adapters, icons, theme, desktop |
| `features/` | 9 | 3,704 | Auth, workers, localAi, admin |
| `lib/` | 4 | 895 | UI primitives, entity editor, waveform, idgen |
| `pages/` | 11 | 6,700 | All page components |
| `state/` | 6 | 2,072 | Reactive stores (Preact signals) |
| **TOTAL** | **44** | **17,534** | |

### 2.2 Extracted packages (reference)

| Package | LOC (src) | Tier | Ports count | Pattern |
|---|---|---|---|---|
| `@animastor/web-player` | ~1,800 | A (UI+Ports) | 8 | `wirePlaybackCoordination(ports)` + props |
| `@animastor/web-file` | ~460 | A | 9 | `{ ports }` prop |
| `@animastor/web-navigator` | ~650 | A | 10 | `{ ports }` prop |
| `@animastor/web-editor` | ~950 | A | 3 | `{ ports }` prop |
| `@animastor/web-ai-chat` | ~66 | B (pure) | 0 | Direct import |
| `@animastor/web-settings` | ~537 | B (pure) | 0 | Direct import |

### 2.3 Remaining state stores

| Store | LOC | Signals owned | Consumed by |
|---|---|---|---|
| `generateStore.ts` | 1,323 | `bookId`, `buildId`, `phase`, `errorMessage`, `generationStatus`, `vbookProgress`, `isRegenerating`, `vbookAnalysisProgress`, `dirtySummary`, layer toggles, timer state | 10+ modules (universal) |
| `fileStore.ts` | 363 | `importMessages`, `isExporting`, `navigationEvent` | fileAdapters, AppShell |
| `authStore.ts` | 78 | `authMe`, `authLoading`, `authError` | UserMenu, AdminPage, PrivateWorkersSection |
| `positionStore.ts` | 27 | `position` | Navigator, Player, Generate, Edit, AiAssistant |
| `resourceInvalidations.ts` | 69 | (event bus, no signals) | Navigator, Generate, Edit |
| `resilientReloader.ts` | 212 | (stateless utility) | Navigator, Generate, File |

---

## 3. Generator Deep Analysis

### 3.1 File inventory

| File | LOC | Role |
|---|---|---|
| `state/generateStore.ts` | 1,323 | Central session/generation state — the "GenerateViewModel" |
| `pages/GeneratePage.tsx` | 720 | Generate screen — worker sections, progress panel, scope dialog |
| `pages/AnalysisProgressPanel.tsx` | 192 | Parallel AI analysis per-task rows (Milestone #2) |
| `state/generateStore.analysis.test.ts` | 318 | Pure state machine tests for analysis |
| **TOTAL** | **2,553** | |

### 3.2 What generateStore owns (identity/state)

**Session Identity (the blocker):**
- `bookId` signal — the open book's ID. Consumed by: `fileAdapters`, `playerAdapters`, `navigatorAdapters`, `AppShell`, `EditPage`, `GeneratePage`, `AiAssistantPage`, `SettingsPage`, `main.tsx`, `authStore`
- `buildId` signal — the current build ID. Consumed by: same as `bookId`
- `loadBook(id, build)` — the primary write path for session identity
- `stashBookSessionForUser(userId)` / `restoreStashedBookSessionForUser(userId)` — logout/login session isolation
- `persistBookSession()` / `clearBookSession()` — localStorage persistence

**Shared Status (written by both File and Generation slices):**
- `phase` signal (`PlayerPhase`) — written by fileStore (LOADING_BOOK/IMPORTING_TXT/SCENE_READY/IDLE) and generateStore (GENERATING/SCENE_READY/IDLE)
- `errorMessage` signal — written by both slices

**Generation-Only State:**
- `generationStatus` (IDLE/RUNNING/ERROR/SUCCESS) — nav-icon pulse
- `vbookProgress` (VBookStage) — VBook agent progress
- `isRegenerating` — whether generation is in progress
- `vbookAnalysisProgress` — parallel AI analysis per-task rows
- Layer config toggles (`vbookEnabled`, `audioEnabled`, `imageEnabled`, `videoEnabled`)
- `analysisMode`, `analysisParallelism` — analysis orchestrator config
- `dirtySummary` — edit dirty indicator
- Timer state (`timerStartedAt`, `finalElapsedSeconds`)
- Worker progress tracking (`taskReadyFloor`, `taskCompletedAt`, `taskFrozenElapsed`)

**Events:**
- `onPlaybackPrepared` / `emitPlaybackPrepared` — generation-completion event bus

**Generation Actions:**
- `startGeneration(req)` — POST `/book/:id/regenerate`
- `startVBookGeneration()` — bootstrap + poll VBook agent
- `cancelGeneration()` — POST `/book/:id/cancel-generation`
- `cancelTask(type, taskId?)` — POST `/book/:id/cancel-worker`
- `checkAndRestoreGenerationState()` — restore UI from server
- `checkVBookAgentStatus()` — poll VBook agent
- `computeProgressRows(panel, vbookProg, labels)` — core progress panel logic
- `applyGenerationResults()` — fetch book JSON, emit playbackPrepared
- `loadLayerConfig()` / `persistLayerConfig()` — layer config GET/PUT
- `refreshAssetsState()` — assets state GET

**SSE:**
- `startProgressStream(bId)` / `stopProgressStream()` — SSE progress channel
- `handleProgressEvent(data)` — SSE event dispatcher

**File Slice Seams (wired by fileAdapters):**
- `stopGenerationSession()` — full generation teardown
- `setRegenerating(v)` — mirror isRegenerating
- `bumpVBookPollToken()` — invalidate VBook poll
- `markImportIncomplete()` — reset SSE import latch

### 3.3 Host imports of generateStore

| Consumer | Imports from generateStore |
|---|---|
| `app/fileAdapters.ts` | `bookId`, `buildId`, `phase`, `errorMessage`, `dirtySummary`, `blankBookJustCreated`, `loadBook`, `emitPlaybackPrepared`, `resetProgressState`, `clearVBookProgress`, `setRegenerating`, `bumpVBookPollToken`, `markImportIncomplete`, `stopGenerationSession` |
| `app/playerAdapters.ts` | `bookId`, `buildId`, `onPlaybackPrepared` |
| `app/navigatorAdapters.ts` | `bookId`, `buildId`, `onPlaybackPrepared` |
| `app/AppShell.tsx` | `generationStatus`, `GenerationStatus`, `bookId`, `phase`, `blankBookJustCreated` |
| `pages/GeneratePage.tsx` | `bookId`, `phase`, `vbookProgress`, `isRegenerating`, layer toggles, `startGeneration`, `startVBookGeneration`, `cancelGeneration`, `cancelTask`, `checkAndRestoreGenerationState`, `checkVBookAgentStatus`, `computeProgressRows`, `resetGenerationStatus`, `onPlaybackPrepared`, `getTimerStartedAt`, `getFinalElapsedSeconds` |
| `pages/AnalysisProgressPanel.tsx` | `vbookAnalysisProgress`, `analysisMode`, `analysisOverallPercent`, `AnalysisTaskRow`, `AnalysisStatus` |
| `pages/EditPage.tsx` | `bookId`, `buildId`, `dirtySummary`, `onPlaybackPrepared` |
| `pages/SettingsPage.tsx` | `bookId`, `resetProgressState` |
| `pages/AiAssistantPage.tsx` | `bookId` |
| `main.tsx` | `bookId` |
| `state/authStore.ts` | `stashBookSessionForUser`, `restoreStashedBookSessionForUser` |

### 3.4 Why Generator cannot be extracted now

1. **Identity ownership:** `bookId`/`buildId` are the single source of truth for the entire application. Every package, adapter, and page reads them. Extracting them into a package would mean the host imports identity from the package — inverting `host → package` to `host ↔ package` (bidirectional).

2. **Shared status signals:** `phase`/`errorMessage` are written by both File and Generation slices. They must stay in a single store as the single source of truth.

3. **Event bus coupling:** `onPlaybackPrepared` is consumed by Player, Navigator, and Editor packages. Moving it to a Generation package would force those packages to depend on Generation — wrong direction.

4. **Auth integration:** `stashBookSessionForUser`/`restoreStashedBookSessionForUser` are called by `authStore` on login/logout. Moving them to a Generation package would force auth to depend on Generation.

5. **No clean seam exists:** Unlike Player (which has `PlayerPorts` with 8 sub-ports), the Generator has no Ports interface. The store is a 1,323-line monolith with tangled identity/generation/event concerns.

### 3.5 What could theoretically be extracted from Generator

**Pure domain functions (testable, zero host deps):**
- `applyAnalysisEvent(prev, ev)` — pure state machine (already tested)
- `analysisOverallPercent(p)` — pure aggregation
- `computeProgressRows(panel, vbookProg, labels)` — pure-ish (mutates module-level tracking maps, but the maps are internal)
- `formatTimerText(s)` — pure utility (duplicated in GeneratePage and AnalysisProgressPanel)
- `scopedTaskLabel(row)` — pure utility
- `buildLabels()` — pure i18n mapping

**Problem:** These functions are tightly coupled to module-level mutable state (`taskReadyFloor`, `taskCompletedAt`, `taskFrozenElapsed`, `generationCompleted`, `newGenerationPending`, `importCompleteReceived`). Extracting them would require either:
- Passing all mutable state as parameters (breaking the current API surface)
- Extracting them as a pure-function package alongside the store (but the store stays host-owned)

**Conclusion:** The pure helpers are too intertwined with module-level state to extract cleanly without a Ports/Adapters seam. The cost of creating that seam exceeds the value of extracting ~200 LOC of pure functions.

---

## 4. Extraction Candidates — Ranked

### 4.1 Candidate ranking

| Rank | Candidate | LOC | Safety | Tests | Host Deps | Identity Ownership | Verdict |
|---|---|---|---|---|---|---|---|
| **1** | **`features/workers/`** | 3,739 | 8/10 | 4 files (1,110 LOC) | 6 (api, i18n, ui, auth, icons, signals) | None (no bookId/buildId) | **BEST CANDIDATE** |
| 2 | `features/localAi/` | 778 | 6/10 | 0 | 4 (api, i18n, ui, @web-settings) | None | Good size, needs tests |
| 3 | Workflow pages (4 files) | 896 | 5/10 | 0 | 7 (api, models, i18n, router, routeState, titleStore, ui) | Shared routeState signals | Coupling risk |
| 4 | `pages/AdminPage.tsx` + `systemAi.ts` | 490 | 5/10 | 0 | 4 (api, auth, ui, systemAi) | None | Needs authStore Port |
| 5 | `features/auth/UserMenu.tsx` | 173 | 4/10 | 0 | 3 (i18n, authStore signals) | None | Deep authStore coupling |
| 6 | `pages/LibraryPage.tsx` | 24 | 2/10 | 0 | 1 (i18n) | None | Too trivial |

### 4.2 Candidate #1: `features/workers/` (Private Worker Management)

#### File inventory

| File | LOC | Role |
|---|---|---|
| `privateWorkers.ts` | 150 | Pure helpers, types, validation, status keys |
| `workerSetup.ts` | 543 | Setup Contract client, wizard state machine, pure helpers |
| `sharing.ts` | 280 | Sharing V2 API + pure helpers (mode, expiry, diff) |
| `shareNotifications.ts` | 108 | Notification adapter, badge counters, session-only state |
| `PrivateWorkersSection.tsx` | 990 | Main section component + sub-modals |
| `WorkerSharingUI.tsx` | 557 | SharingModal, SharedWithMeView, CommunityView |
| `privateWorkers.test.ts` | 144 | Unit tests |
| `workerSetup.test.ts` | 554 | Unit tests |
| `sharing.test.ts` | 288 | Unit tests |
| `shareNotifications.test.ts` | 124 | Unit tests |
| **TOTAL** | **3,739** | |

#### Production consumers

Only `SettingsPage.tsx` imports `PrivateWorkersSection`. No other file references `features/workers/`.

#### Host imports

| File | Host Imports |
|---|---|
| `privateWorkers.ts` | **None** |
| `workerSetup.ts` | `api/client` (`getJson`, `postJson`) |
| `sharing.ts` | `@preact/signals`, `api/client` (`getJson`, `postJson`, `deleteJson`, `deleteJsonBody`, `ApiError`) |
| `shareNotifications.ts` | `@preact/signals` |
| `PrivateWorkersSection.tsx` | `preact/hooks`, `api/client`, `app/i18n`, `app/icons`, `state/authStore`, `lib/ui` |
| `WorkerSharingUI.tsx` | `preact/hooks`, `app/i18n`, `api/client`, `lib/ui` |

#### Package imports

None. Zero dependency on other `@animastor/web-*` packages.

#### State/identity ownership

- `shareFeatureEnabled` signal in `sharing.ts` — global kill-switch (feature-scoped, not session-scoped)
- `sharedWithMeCount` / `sharedUnreadCount` signals in `shareNotifications.ts` — badge counts
- **Does NOT own** `bookId`, `buildId`, or any session identity

#### API/backend dependencies

- 16 distinct endpoints under `/api/v1/workers/*`, `/api/v1/private-worker/setup/*`, `/api/v1/users/lookup`, `/api/v1/config`

#### Cyclic dependency risks

**None.** Internal dependency graph is a strict DAG:
```
privateWorkers.ts (leaf)
  └─ workerSetup.ts (imports api/client only)
  └─ sharing.ts (imports privateWorkers types + api/client + signals)
       └─ shareNotifications.ts (imports sharing type + signals)
  └─ WorkerSharingUI.tsx (imports privateWorkers + sharing)
  └─ PrivateWorkersSection.tsx (imports everything above)
```

#### Tests

4 test files (1,110 LOC total) covering:
- `privateWorkers.test.ts` — create-input validation, credential contract, status derivation, last-seen formatting
- `workerSetup.test.ts` — Setup Contract client, wizard state machine, Worker Key security invariants
- `sharing.test.ts` — pure helpers (mode derivation, expiry, validation, error mapping, diffing) and API layer
- `shareNotifications.test.ts` — notice subscription/emission, badge counters, initial-sync rule

#### Ports/Adapters

**No Ports/Adapters yet.** Required ports after extraction:

```typescript
interface WorkerPorts {
  api: WorkerApiPort;         // getJson, postJson, deleteJson, deleteJsonBody, ApiError
  i18n: WorkerI18nPort;       // typed t() + tf() functions
  ui: WorkerUiPort;           // Modal, toast components
  auth: WorkerAuthPort;       // isAuthenticated: () => boolean
  icons: WorkerIconsPort;     // IconAdd, IconReset components
}
```

#### Dependency direction after extraction

```
HOST (SettingsPage.tsx)
  └── imports PrivateWorkersSection from '@animastor/web-workers'

@animastor/web-workers (package)
  └── imports nothing from host (all deps arrive via WorkerPorts)
```

Direction: **host → package** (correct).

#### Safety assessment

**Rating: 8/10 — MODERATE-HIGH**

Pros:
- Largest remaining candidate (3,739 LOC) — biggest host reduction
- 4 existing test files — extraction safety net pre-built
- Single consumer — trivial import update
- No `bookId`/`buildId` — zero session identity risk
- Clean internal DAG — no cycles
- Already uses barrel-like internal imports
- Self-contained vertical slice (Private Worker Management)

Cons:
- 6 host dependencies need Ports (but all are well-understood from existing extraction patterns)
- `PrivateWorkersSection.tsx` reads `authMe.value.authenticated` — needs a single boolean Port
- `WorkerSharingUI.tsx` calls `getJson` directly — needs an API Port
- Tests import `ApiError` from `api/client` — test scaffolding needs minor adjustment

---

## 5. Generator — Proposed Target Architecture

### 5.1 When Generator extraction becomes possible

Generator extraction requires one of:
1. **Identity extraction** — `bookId`/`buildId` move to a shared `@animastor/session` package that both host and Generator consume. This is a fundamental architectural change.
2. **Identity stays host, Generator becomes a "shell" package** — the package exports only the UI components (GeneratePage, WorkerSection, WorkerRow, ScopeDialog, DoneRow) and pure helpers (computeProgressRows, formatTimerText, etc.), with all state arriving via Ports.

Option 2 is safer and follows the existing pattern. Here is the proposed architecture:

### 5.2 Proposed package: `@animastor/web-generate-ui`

**Scope:** Generation-related UI components and pure helpers. NOT the store.

```
host:
  "GeneratePage / host orchestration"
  → adapters / ports
  → "@animastor/web-generate-ui"

package:
  Pure generation-related UI functionality
```

#### Package contents (proposed)

| File | LOC | What moves |
|---|---|---|
| `src/index.ts` | ~30 | Public entry |
| `src/ports.ts` | ~120 | `GeneratePorts` interface |
| `src/WorkerSection.tsx` | ~70 | Worker section card component |
| `src/WorkerRow.tsx` | ~60 | Worker progress row component |
| `src/DoneRow.tsx` | ~12 | Done row component |
| `src/ScopeDialog.tsx` | ~60 | Scope selection dialog |
| `src/AnalysisProgressPanel.tsx` | ~192 | Parallel analysis progress panel |
| `src/progressRows.ts` | ~220 | Pure `computeProgressRows` + helpers (extracted from generateStore) |
| `src/timerUtils.ts` | ~20 | `formatTimerText`, `liveElapsedSeconds` |
| `src/models.ts` | ~80 | Vendored `TaskRow`, `TaskLabels`, `ProgressPanelState`, `VBookProgress`, `AnalysisProgress`, `AnalysisTaskRow` types |
| **TOTAL** | **~864** | |

#### Ports interface (proposed)

```typescript
interface GeneratePorts {
  session: GenerateSessionPort;       // bookId, buildId signals (read-only)
  generation: GenerateGenerationPort; // phase, isRegenerating, vbookProgress, layer toggles
  actions: GenerateActionsPort;       // startGeneration, cancelGeneration, cancelTask, etc.
  timer: GenerateTimerPort;           // getTimerStartedAt, getFinalElapsedSeconds
  i18n: GenerateI18nPort;            // typed t() + tf()
  icons: GenerateIconsPort;          // Play, Stop, Settings, Library, Volume*, Image*, Video*
  navigation: GenerateNavigationPort; // navigate (router)
  shellMode: GenerateShellModePort;  // isDesktop()
}
```

#### What stays host-owned

- `generateStore.ts` (1,323 LOC) — the entire store stays host
- `bookId`/`buildId` signals — host-owned identity
- `phase`/`errorMessage` signals — host-owned shared status
- All generation actions (`startGeneration`, `cancelGeneration`, etc.)
- SSE progress stream
- Layer config persistence
- Event bus (`onPlaybackPrepared`/`emitPlaybackPrepared`)
- Auth integration (`stashBookSessionForUser`/`restoreStashedBookSessionForUser`)
- File slice seams

### 5.3 Why this is NOT recommended right now

1. **Size mismatch:** The package would be ~864 LOC (UI components) while the host store stays at 1,323 LOC. The extraction ratio is poor — significant Port engineering overhead for modest host reduction.
2. **Progress tracking state coupling:** `computeProgressRows` mutates module-level maps (`taskReadyFloor`, `taskCompletedAt`, `taskFrozenElapsed`). Moving it to a package requires either passing all mutable state as parameters (breaking the current API) or duplicating the state management inside the package.
3. **No precedent:** No existing package has extracted only UI components while leaving the store behind. All 6 existing packages extract the full vertical slice (store + UI + ports).
4. **The pure helpers are few:** Only ~200 LOC of truly pure functions (`formatTimerText`, `scopedTaskLabel`, `buildLabels`). The rest is tightly coupled to module-level mutable state.

---

## 6. Other Candidate Details

### 6.1 `features/localAi/` (Local AI Connector)

**Files:** `LocalAISection.tsx` (778 LOC)  
**Consumer:** `SettingsPage.tsx`  
**Host deps:** `api/client`, `app/i18n`, `lib/ui`, `@animastor/web-settings`  
**State:** All component-local (`useState`). No global signals.  
**Tests:** None.  
**Port surface:** API client, i18n, UI primitives (Modal, toast)  
**Safety: 6/10** — good size, no identity ownership, but needs tests and has heavy inline API surface (16 endpoints). Already depends on `@animastor/web-settings` (clean — package-to-package dependency).

### 6.2 Workflow Pages

**Files:** `WorkflowsPage.tsx` (76), `WorkflowTypeListPage.tsx` (156), `WorkflowDetailsPage.tsx` (508), `DeveloperViewPage.tsx` (156) = 896 LOC  
**Consumer:** `main.tsx`  
**Host deps:** `api/client`, `api/models`, `app/i18n`, `app/router`, `app/routeState`, `app/titleStore`, `lib/ui`  
**State:** `routeState.ts` signals (`detailsEditMode`, `devConnector`) shared between pages.  
**Tests:** None.  
**Safety: 5/10** — shared mutable `routeState` creates coupling. 7 host dependencies (highest Port count).

### 6.3 AdminPage + systemAi

**Files:** `AdminPage.tsx` (365), `systemAi.ts` (125) = 490 LOC  
**Consumer:** `main.tsx`  
**Host deps:** `api/client`, `state/authStore`, `lib/ui`, `features/admin/systemAi`  
**State:** Reads `authMe` from `authStore`.  
**Tests:** None.  
**Safety: 5/10** — `authStore` depends on `generateStore` (stash/restore), creating an indirect dependency chain.

### 6.4 UserMenu (Auth)

**Files:** `UserMenu.tsx` (173 LOC)  
**Consumer:** `AppShell.tsx`  
**Host deps:** `app/i18n`, `state/authStore` (6 symbols)  
**Tests:** None.  
**Safety: 4/10** — deeply coupled to `authStore` (3 signals + 4 functions). `authStore` depends on `generateStore`.

---

## 7. Dependency Direction Analysis

### 7.1 Current dependency directions (correct)

```
host (main.tsx, AppShell, pages, adapters)
  ├──→ @animastor/web-player (package)
  ├──→ @animastor/web-file (package)
  ├──→ @animastor/web-navigator (package)
  ├──→ @animastor/web-editor (package)
  ├──→ @animastor/web-ai-chat (package)
  └──→ @animastor/web-settings (package)

packages: zero imports from host, zero imports from each other
```

### 7.2 Post-extraction directions (target)

```
host
  ├──→ @animastor/web-player
  ├──→ @animastor/web-file
  ├──→ @animastor/web-navigator
  ├──→ @animastor/web-editor
  ├──→ @animastor/web-ai-chat
  ├──→ @animastor/web-settings
  └──→ @animastor/web-workers (NEW)

@animastor/web-workers
  └──→ nothing from host (all via WorkerPorts)
```

### 7.3 Forbidden directions

- `package → host` — never allowed
- `package → package` — not allowed today (no package imports another)
- `generateStore → any package` — never (store stays host)
- `any package → generateStore` — never (packages receive identity via Ports, not direct import)

---

## 8. Identity/State Boundary

### 8.1 Session identity ownership

| Signal | Owner | Consumers | Extraction status |
|---|---|---|---|
| `bookId` | `generateStore` (host) | 10+ modules | **Cannot move** — universal |
| `buildId` | `generateStore` (host) | 10+ modules | **Cannot move** — universal |
| `phase` | `generateStore` (host, written by both slices) | 6+ modules | **Cannot move** — shared |
| `errorMessage` | `generateStore` (host, written by both slices) | 3+ modules | **Cannot move** — shared |
| `position` | `positionStore` (host) | 4+ modules | **Cannot move** — shared |
| `authMe` | `authStore` (host) | 3 modules | **Cannot move** — depends on generateStore |

### 8.2 Feature-scoped state (can move with extraction)

| Signal | Owner | Package target |
|---|---|---|
| `shareFeatureEnabled` | `features/workers/sharing.ts` | `@animastor/web-workers` |
| `sharedWithMeCount` | `features/workers/shareNotifications.ts` | `@animastor/web-workers` |
| `sharedUnreadCount` | `features/workers/shareNotifications.ts` | `@animastor/web-workers` |

---

## 9. Risks

### 9.1 Risks of extracting `features/workers/`

| Risk | Severity | Mitigation |
|---|---|---|
| `authMe` coupling in `PrivateWorkersSection.tsx` | Low | Port: `isAuthenticated: () => boolean` — single boolean check |
| `ApiError` in tests | Low | Vendor `ApiError` type or pass via Port in tests |
| `@preact/signals` in `sharing.ts` / `shareNotifications.ts` | Low | Peer dependency (same as all Tier A packages) |
| Kill-switch signal (`shareFeatureEnabled`) stays in package | Low | Feature-scoped, not session-scoped — safe to own |

### 9.2 Risks of extracting Generator (if attempted)

| Risk | Severity | Mitigation |
|---|---|---|
| Identity inversion (package → host) | **Critical** | Would require `@animastor/session` package — major refactor |
| Phase/errorMessage shared state | **High** | Would need a shared state bus — no precedent |
| `onPlaybackPrepared` event bus | **High** | Would force Player/Navigator to depend on Generator |
| Auth stash/restore | **High** | Would force auth to depend on Generator |
| `computeProgressRows` mutable state | Medium | Would need parameterization or state duplication |
| Progress tracking maps | Medium | Module-level state can't be cleanly extracted |

### 9.3 General extraction risks

| Risk | Severity | Mitigation |
|---|---|---|
| Import path breakage | Low | TypeScript compiler catches all; guard tests verify |
| CSS class coupling | Low | CSS stays in host `base.css`; packages use class names only |
| i18n key drift | Low | Typed key unions in each package; compile-time check |
| Test scaffolding | Low | Mock `api/client` in tests (existing pattern) |

---

## 10. Recommendation

### 10.1 Next extraction: `@animastor/web-workers`

**Why this is the clear winner:**

1. **3,739 LOC** — the largest remaining candidate, biggest host reduction
2. **4 comprehensive test files** — extraction safety net is pre-built
3. **Single consumer** (`SettingsPage.tsx`) — trivial import update
4. **Zero `bookId`/`buildId`** — no session identity risk
5. **Clean internal DAG** — no cyclic dependencies
6. **Well-defined Port surface** — 6 host deps map to clean Ports
7. **Self-contained vertical slice** — Private Worker Management is a complete feature
8. **No dependency on Generator** — completely decoupled from the generation domain

### 10.2 Implementation path

1. Create `packages/animastor-web-workers/` with standard package structure
2. Define `WorkerPorts` interface (api, i18n, ui, auth, icons)
3. Move all 6 source files to the package
4. Move all 4 test files to the package
5. Create `app/workerAdapters.ts` in host to wire Ports
6. Update `SettingsPage.tsx` import to `@animastor/web-workers`
7. Add architecture guard test to verify boundary

### 10.3 Generator timeline

Generator extraction should be deferred until:
1. A `@animastor/session` package is designed and extracted (identity ownership)
2. OR the Generator is split into a "pure UI" package + host-owned store (Option 2 above)
3. OR the Generator grows large enough to justify the Port engineering overhead

**Estimated effort:** 1-2 days for workers extraction; 1-2 weeks for Generator extraction (including session identity design).

---

## 11. VERDICT

**Generator:** `NOT READY` — identity/state ownership prevents safe extraction. The store is the host's source of truth for session identity. Extracting it would invert dependency directions or require a fundamental `@animastor/session` package design.

**Next extraction candidate:** `@animastor/web-workers` (Private Worker Management) — `READY FOR EXTRACTION` with standard Ports/Adapters pattern.

**Overall web frontend extraction status:** 6 of ~10 potential packages extracted. The remaining 4 candidates (workers, localAi, workflows, admin) are moderate-risk extractions. Generator is the only high-risk candidate due to identity ownership.

---

## 12. Commit

```
arch(web): audit next extraction candidates
```

Production code: **UNCHANGED**. This is a reconnaissance-only document.
