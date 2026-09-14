# Web Generator — Extraction Audit (Re-verification)

**Status:** Step-2 physical package extraction EXECUTED (this document updated after the change)  
**Date:** 2026-09-14  
**Branch:** `c21.4-physically-extract-analysis-from-backend`  
**Baseline commit:** `066ddaae` ("arch(orchestration): physically extract orchestration package")  
**Step-1 change:** in-repo `generation-progress` domain module extracted (see §9) — **no package created**  
**Step-2 change:** physical package `@animastor/web-generator` created at `packages/animastor-web-generator/` (see §11); old in-repo contour deleted  
**Target package:** `@animastor/web-generator`  
**Target location:** `packages/animastor-web-generator/` (CREATED — physical extraction completed)  
**Re-verification of:** `web-next-extraction-reconnaissance.md` (§3.1, verdict "NOT READY")  
**Context:** Verdict re-checked at current HEAD after the workers (`b096d2a6`) and local-ai (`71065221`) extractions.

---

## 1. Executive Summary

The Generator contour is **NOT READY** for full physical package extraction at current HEAD. The verdict from the previous reconnaissance is **unchanged**, but the risk surface has shifted: the generateStore⇄playbackStore cycle is dissolved, the store has no router or `@animastor/*` dependencies, and API access is a pure transport layer. What remains is the **identity blocker**: `generateStore` is the host-owned source of truth for session identity (`bookId`/`buildId`), written and read by 10+ host files, 3 extracted packages (via adapters), auth stash/restore, and the fileStore session seam.

A **domain-first slice** (analysis/progress pure logic) was READY WITH CONDITIONS at baseline — **Step 1 is now EXECUTED** (§9): the slice physically exists as the in-repo module `state/generationProgress/` with parameterized state, independent unit tests, and a contour guard. **Step 2 is now EXECUTED** (§11): the slice has been physically extracted into `@animastor/web-generator` at `packages/animastor-web-generator/`, the old in-repo contour deleted, and the host wired to consume the package root. The generation-progress domain is now **PHYSICALLY EXTRACTED / READY**.

**Key findings:**
- **2,553 LOC** core contour (4 files), ~30 signals in one store
- **10 direct production consumers** + fileStore via injected seams
- **No `@animastor/*` imports** — pure host modules today
- **No web-facing generation contracts** in `@animastor/contracts` — wire types would need vendoring (precedent: `animastor-web-player/src/models.ts`)
- Cycle generateStore⇄playbackStore **already dissolved** (guard-pinned in `player-contour.guard.test.ts`)

---

## 2. File Inventory

### 2.1 Core contour (production — post Step-1 split, see §9)

| File | LOC | Role |
|---|---|---|
| `state/generateStore.ts` | 858 | Generation orchestration host: identity, phase, VBook flow, SSE transport, actions — progress logic delegated to `generationProgress/` |
| `state/generationProgress/` (6 files) | 875 | generation-progress domain slice: analysis state machine, progress rows, SSE routing, timer math — explicit state objects, no host reach |
| `pages/GeneratePage.tsx` | 703 | The Generate screen: worker cards, scope dialog, polls, timer |
| `pages/AnalysisProgressPanel.tsx` | 187 | Per-task parallel-analysis rows (consumed only by GeneratePage) |
| **TOTAL** | **2,623** | |

### 2.2 Core contour (tests — post Step-1 split)

| File | LOC | Coverage |
|---|---|---|
| `state/generationProgress/analysis.test.ts` | 239 | `applyAnalysisEvent` purity, `analysisOverallPercent`, reset semantics, heartbeat — standalone (no store import) |
| `state/generationProgress/progressRows.test.ts` | 363 | `computeProgressRows`: floor monotonicity, stale-done gate, sibling keys, 10s window, new-gen gate, finalize, VBook rows, reset |
| `state/generationProgress/sseRouting.test.ts` | 125 | SSE routing: analysis/heartbeat/import_complete/generation_complete/malformed |
| `state/generationProgress/timer.test.ts` | 61 | timer start/stop/freeze/restart + formatter |
| `state/generationProgress/vbookProgress.test.ts` | 108 | SSE event mapping + agent-status merge + factories |
| `state/generateStore.analysis.test.ts` | 139 | Host integration: layer-config roundtrip, SSE seam end-to-end, reset wrapper |
| **TOTAL** | **1,035** | |

### 2.3 Combined total

**3,658 LOC** (2,623 production + 1,035 tests, post Step-1 split — was 2,553 at baseline; the growth is the new standalone domain unit tests)

### 2.4 Shared infrastructure the contour depends on (NOT part of the contour — candidate ports)

| File | LOC | What generateStore/GeneratePage use from it |
|---|---|---|
| `api/client.ts` | 250 | `getJson`, `postJson`, `postJsonLong`, `putJson`, `sse` (pure transport; centralized fetch; no window/document reach) |
| `api/models.ts` | 835 | Generation wire types at lines 501–731: `WorkerCounts`, `ProgressPanelResponse`, `AgentStatusResponse`, `LayerConfigResponse`, `BookStatus`, `RegenerateRequest/Response`, `DiffSummary`, `ProgressEvent`, plus `sceneRefs()`/`SceneRef` (460–479), `AssetsStateResponse` |
| `state/positionStore.ts` | 27 | `navigateTo`, `position` (post-generation anchoring) |
| `state/resourceInvalidations.ts` | 69 | `bookResource`, `onResourceInvalidated` (external invalidation reload in GeneratePage) |
| `state/resilientReloader.ts` | 212 | `resilientReload`, `sharedRecovery` (book load backoff 1s→2s→5s→10s) |
| `app/i18n.ts` | 1,780 | `t`, `tf`, `vbookStageLabel` (store uses only `vbookStageLabel`) |
| `app/router.ts` | 20 | `navigate` (GeneratePage only — to `/navigate`, `/settings/vbook`, `/settings/worker`) |
| `app/routeState.ts` | 15 | `workerType` signal write before navigating to `/settings/worker` |
| `app/desktop.ts` | 26 | `useDesktopShell` (shell fork at 1180px) |
| `app/icons.tsx` | 365 | 10 named icons for GeneratePage |
| `lib/ui.tsx` | 125 | `toast`, `Modal`, `Switch`, `ProgressBar`, `ErrorText` |

---

## 3. Dependency Matrix

### 3.1 Generator → host

| Dependency | Nature | Port/Adapter candidate |
|---|---|---|
| `@preact/signals` (signal) | external lib | direct dep of a future package (like web-player) |
| `api/client` (`getJson/postJson/postJsonLong/putJson/sse`) | domain (transport) | **http port** (precedent: `PlayerHttpPort`, `WorkerPorts.api`) |
| `api/models` (generation wire types) | domain (wire contract) | **vendor into package models.ts** (precedent: web-player/models.ts) |
| `positionStore` (`navigateTo`, `position`) | host state | **position port** (precedent: `PlayerPositionPort` write direction) |
| `app/i18n` (`vbookStageLabel`) | UI localization | **i18n port** (typed key union, precedent: `PlayerI18nPort`) |
| `router` (`navigate`) | host navigation | **navigation port** (precedent: `FilePorts.navigation`) |
| `routeState` (`workerType` write) | host route coupling | navigation port payload or routeState adapter |
| `desktop` (`useDesktopShell`) | host shell | **shellMode port** (precedent: `PlayerShellModePort`) |
| `icons` (10 icons) | UI | **icons port** (precedent: `PlayerIconsPort`) |
| `lib/ui` (`toast`, etc.) | UI | **ui port** (precedent: `WorkerPorts.ui`) |
| `resourceInvalidations` (`bookResource`, `onResourceInvalidated`) | host event bus | **invalidations port** (precedent: `PlayerInvalidationsPort`) |
| `resilientReloader` | transport resilience | http port (fold `retryWithBackoff` semantics) |
| `document`/`window` (GeneratePage dialog only) | host DOM | stays in page component / ui port |

### 3.2 Host → Generator (reverse — the blocker cluster)

| Consumer | Symbols consumed | Why it can't move yet |
|---|---|---|
| `app/AppShell.tsx` | `generationStatus`, `bookId`, `phase`, `blankBookJustCreated` | nav pulse class, desktop `/file`+`/navigate` bounce-to-`/play`/`/generate` decision |
| `app/fileAdapters.ts` | `bookId`, `buildId`, `phase`, `errorMessage`, `dirtySummary`, `blankBookJustCreated`, `loadBook`, `emitPlaybackPrepared`, `resetProgressState`, `clearVBookProgress`, `setRegenerating`, `bumpVBookPollToken`, `markImportIncomplete`, `stopGenerationSession` | the FilePorts composition seam — session identity **by reference** |
| `app/playerAdapters.ts` | `bookId`, `buildId`, `onPlaybackPrepared` | `PlayerPorts.session` + `PlayerPorts.generation` |
| `app/navigatorAdapters.ts` | `bookId`, `buildId`, `onPlaybackPrepared` | `NavigatorPorts.bookSource` |
| `pages/EditPage.tsx` | `bookId`, `buildId`, `dirtySummary`, `onPlaybackPrepared` | dirty indicator + generation-completion soft refresh |
| `pages/SettingsPage.tsx` | `bookId`, `resetProgressState` | clear-cache flow |
| `pages/AiAssistantPage.tsx` | `bookId` | book-scoped AI context |
| `main.tsx` | `bookId` | login-triggered `restoreBookSession()` re-entry |
| `state/authStore.ts` | `stashBookSessionForUser`, `restoreStashedBookSessionForUser` | logout/login book-session isolation (**hard auth→identity edge**) |
| `state/fileStore.ts` | no direct import — via injected `SessionSeam`/`GenerationResetSeam`/`PlaybackPreparedSeam`/`PlayerSeam` | `phase`/`errorMessage` dual-writer contract (audit B6) |

Test consumers: `state/__tests__/auth-book-session.test.ts`, `state/fileStore.test.ts`, `app/fileAdapters.test.ts`, both relevant architecture guards.

### 3.3 Generator → existing packages

**None.** Zero `@animastor/*` imports in the contour (grep-verified). The dependency direction is inverted: three extracted packages (web-player, web-editor, web-navigator) consume generator identity/events **through their host adapters**.

### 3.4 Possible cycles

- Historical cycle generateStore⇄playbackStore: **dissolved** — no playbackStore import; guard-pinned (`player-contour.guard.test.ts` forbids `state/generateStore.ts → state/playbackStore.ts` edge). Player release now flows through the fileStore `player` seam.
- Remaining potential cycle if extracted naively: `web-generator ⇄ web-player` via `onPlaybackPrepared` (Generator is the **producer**, Player is the consumer). Extraction must keep the event behind a port (Player already consumes it via `PlayerPorts.generation` — the surviving seam is compatible).

### 3.5 Domain dependency vs Ports/Adapters

| Edge | Classification |
|---|---|
| http transport (client.ts) + wire models | **Ports** (transport seam, like every extracted package) |
| i18n/icons/ui/shellMode/navigation | **Ports** (pure presentation host services) |
| `positionStore.navigateTo` | **Port** (write direction; position is host state) |
| invalidations subscription | **Port** (listen direction) |
| `bookId`/`buildId`/`loadBook`/stash/restore | **NOT portable** — host identity ownership (must stay host-side) |
| `phase`/`errorMessage` | **NOT portable as-is** — dual-writer with fileStore; single source of truth must not fork |
| `onPlaybackPrepared` emission | **Port-able** (emit direction), but consumers (Player/Navigator/Edit) must keep subscribing via adapters — dependency inversion is the risk |
| auth stash/restore | **NOT portable** — authStore→generateStore hard edge; extraction would invert it |

---

## 4. Deep-dive: Can the contour be split?

### 4.1 Pure generation domain logic — YES (DONE, §9)

Extracted into `state/generationProgress/` (Step 1 executed):
- `applyAnalysisEvent` (+ `analysisOverallPercent`, reset via `createInitialAnalysisProgress`) — unit-tested standalone
- `computeProgressRows` + SSE event routing (`routeProgressEvent`)
- Timer math (`GenerationTimerState`, `start/stopGenerationTimer`, `elapsedSeconds`, `formatTimerText`)

~~**Condition:**~~ The module-level Maps (`taskReadyFloor`, `taskCompletedAt`, `taskFrozenElapsed`) and latch gates (`generationCompleted`, `newGenerationPending`, `importCompleteReceived`) are **parameterized into `ProgressTrackingState`** (plus `GenerationTimerState` for the wall-clock lets) — the condition is satisfied.

### 4.2 Domain/service layer first, store host-owned — YES (recommended path)

Split `generateStore.ts`:
- **Host keeps:** identity signals (`bookId`, `buildId`), `loadBook`, persistence + per-user stash/restore, `phase`/`errorMessage` (SessionSeam contract), `onPlaybackPrepared` bus
- **Package gets:** VBook flow (startVBookGeneration, polling, agent-status), progress panel (rows/timers), SSE stream machinery, analysis progress state, layer-config/assets-state fetching, regenerate/cancel actions — all parameterized by a `GenerationSession` handle + ports

Precedent: the fileStore B1 split (seams `GenerationResetSeam`/`PlaybackPreparedSeam`/`PlayerSeam`/`SessionSeam` wired in `app/fileAdapters.ts`).

### 4.3 Split Generator into 2+ package contours — YES, naturally

1. **`generation-progress` (analysis/progress domain):** `applyAnalysisEvent`, `analysisOverallPercent`, `computeProgressRows`, SSE routing, wire models (`ProgressEvent`, `ProgressPanelResponse`, `AgentStatusResponse`, `AnalysisTaskRow`) — **~875 LOC impl + 866 LOC standalone tests, zero identity/auth/playback-write. Step 1 EXECUTED (§9): READY for a mechanical package cut (§10).**
2. **`generation-orchestration` (VBook/bootstrap flow):** start/bootstrap/cancel/poll actions — depends on identity port + http port. Requires the 4.2 split first.
3. **UI (`GeneratePage` + `AnalysisProgressPanel`):** separable from orchestration (imports only signals + ports), but low value until the store split lands.

### 4.4 State/identity duties that MUST stay host-owned

- `bookId`/`buildId` signals + `loadBook` + localStorage persistence (`animastor:currentBook`)
- Per-user stash/restore (`animastor:currentBook:user:<uid>`) + the authStore edge
- `phase`/`errorMessage` (fileStore dual-writer contract, audit B6)
- `onPlaybackPrepared` bus (Player/Navigator/Edit subscribe host-side via adapters)
- `dirtySummary`/`blankBookJustCreated` (file/editor coordination)

### 4.5 UI separate from generation orchestration — YES (mechanically)

`GeneratePage.tsx` imports only signals, ports-able host services (i18n/router/desktop/icons/ui), and analysis panel. It has 4 poll/timer effects (5s worker counts, 1.5s progress panel, 500ms timer tick, 2.5s restore delay) which belong to orchestration — these should move behind a `GenerationController` port if UI is extracted. Desktop/mobile fork stays via shellMode port (web-player precedent).

### 4.6 Event-bus dependencies the package actually needs

Only **one**: `onPlaybackPrepared` (emit direction). Player's subscription already arrives via `PlayerPorts.generation` — no direct coupling. `resourceInvalidations` subscription (listen) for external AI-patch reload in GeneratePage. Both fit a `GeneratorEvents` port group.

---

## 5. Comparison with extracted packages

| Dimension | web-player (extracted) | web-workers (extracted) | web-local-ai (extracted) | **Generator** |
|---|---|---|---|---|
| LOC | ~2,000+ | 3,739 | — | 2,553 |
| Own store ownership | no (host playbackStore dissolved into pkg) | yes (self-contained) | yes | **host identity blocker** |
| Session identity (`bookId`/`buildId`) | consumes via ports (by reference) | none | none | **OWNS it** |
| Auth edge | via ports | AuthPort | via ports | **authStore→generateStore hard edge** |
| Consumers | 6 pinned | 1 (SettingsPage) | 2 | **10 direct + seams + 3 packages** |
| Wire contracts vendored | yes (models.ts) | yes | yes | **none exist yet — must vendor** |
| Event bus | consumes `onPlaybackPrepared` | none | none | **produces it** |
| Cycles | resolved (B1 split) | none | none | resolved with player; **new inversion risk if naive** |

**Status NOT READY is confirmed at current HEAD.** The extractions since the last recon (workers, local-ai, editor, ai-chat/settings, orchestration) did not touch the identity/auth/phase cluster — those blockers are structural.

---

## 6. Verdict

**NOT READY** (for full physical extraction of `@animastor/web-generator` as a single unit).  
**READY WITH CONDITIONS** for a domain-first slice (§4.3.1).

### Blockers (exact)

1. **Identity ownership:** `bookId`/`buildId`/`loadBook`/persistence/stash-restore consumed by 10 host files + 3 package adapters; moving them inverts package→host dependency direction.
2. **Auth edge:** `authStore.ts` imports `stashBookSessionForUser`/`restoreStashedBookSessionForUser` — package cannot own logout/login session isolation.
3. **Dual-writer phase/errorMessage:** fileStore SessionSeam + generateStore both write; source of truth must not fork across package boundary.
4. **Event producer inversion:** `onPlaybackPrepared` consumed by Player/Navigator/Edit via adapters — moving the producer inverts the direction unless the bus stays host-side.
5. **No web generation contracts:** wire types live only in host `api/models.ts`; nothing in `@animastor/contracts`.
6. ~~**Module-level state:**~~ **RESOLVED for the progress slice** (§9): timers/Maps/latches now live in explicit state objects (`ProgressTrackingState`/`GenerationTimerState`) owned by the host; still applies to any other slice until split.

### Minimal preparation sequence

1. **Step 1 (safe first contour):** extract generation-progress domain (analysis events, progress rows, SSE routing, timer math) with parameterized state + vendored wire models → package or in-repo module + unit tests moved with it.
2. **Step 2:** split generateStore — identity half stays host (§4.4), orchestration half becomes `GenerationService` parameterized by `GenerationSession` + `GeneratorPorts`.
3. **Step 3:** define `GeneratorPorts` (http+sse, navigateTo, emitPlaybackPrepared, i18n stage labels, invalidations) following `PlayerPorts`/`FilePorts` shape; single `app/generatorAdapters.ts` seam.
4. **Step 4:** add `generator-contour.guard.test.ts` (pinned consumers, entry-only imports, no reverse state deps — same mechanics as the 3 existing guards).
5. **Step 5:** only then, physical extraction of the orchestration+UI package; identity remains host-owned permanently (or until a `@animastor/session` design exists).

---

## 7. Comparison: Generator vs Workflows vs Admin (current HEAD)

| Candidate | LOC | Store | Host coupling | Coupling risk | Status |
|---|---|---|---|---|---|
| **Generator** | 2,553 | 1 store, ~30 signals | identity + auth + phase dual-write + event producer | **high** (structural) | **NOT READY** (domain slice: READY WITH CONDITIONS) |
| **Workflows** | ~900 (4 pages: 76+156+508+156) | **no store** (useState/useRef only) | `routeState` signals (`detailsEditMode`, `devConnector`), `titleStore`, api, ui, i18n, router | low | **READY WITH CONDITIONS** |
| **Admin** | 490 (365 page + 125 pure systemAi) | **no store** (authMe subscription) | `authStore` only (needs AuthPort — precedent: web-workers) | low | **READY WITH CONDITIONS** |

Notes:
- **Workflows:** zero generateStore usage, zero bookId/buildId, zero playback coupling; backend-only connector APIs. The two routeState signals are the only cross-page state — manageable via a small ports/navigation contract. Largest LOC win at lowest risk.
- **Admin:** smallest; `features/admin/systemAi.ts` is a pure module (no imports); AdminPage needs an AuthPort (already proven in web-workers). No i18n usage (hardcoded English — internal admin).
- **Generator:** biggest and most valuable long-term, but blocked on identity design.

### Recommendation

**Physically extract `@animastor/web-workflows` next** (biggest safe LOC win, standard Ports/Adapters, no identity coupling). **Admin** as the fast follow (AuthPort precedent exists). **Generator:** start Step 1 now (domain-first slice — analysis/progress logic), full extraction deferred until the identity split (§6, Step 2–3) lands.

---

## 8. Guard pattern reference (for the future extraction)

Follow `frontends/app/src/architecture/*.guard.test.ts` mechanics: raw-source scan via `import.meta.glob(..., { query: '?raw', eager: true })`, `importSpecifiers()` regex extraction; checks: physical structure (old paths gone), entry-only consumption (deep-specifier ban), pinned consumer allowlist, single adapters file building Ports, reverse-dep bans (no state/ module imports the package; no state cycles), identity ownership (no host file binds bookId/buildId from package entry; fileStore must not re-declare identity signals), pinned route mounts in main.tsx, test-mock discipline (entry, not deep paths). A first contour-specific guard already exists: `frontends/app/src/architecture/generation-progress-contour.guard.test.ts` (see §9.4).

---

## 9. Step 1 EXECUTED — generation-progress domain split (in-repo)

**Status:** landed on `c21.4-physically-extract-analysis-from-backend`; no package created; Generator UI behavior unchanged (host public API of `generateStore` preserved 1:1, incl. re-exports of the moved types/fns).

### 9.1 What moved (module: `frontends/app/src/state/generationProgress/`)

| File | LOC (impl/tests) | Contents |
|---|---|---|
| `analysis.ts` | 209 / 239 | `AnalysisStatus`/`AnalysisTaskId`/`AnalysisTaskRow`/`AnalysisProgress` types, `createInitialAnalysisProgress` (reset semantics), `applyAnalysisEvent(prev, ev, now?)` (pure; clock injectable), `analysisOverallPercent`, `applyAnalysisHeartbeat` (the SSE `analysis_parallel` branch, pure), `isAnalysisTaskId`, `transition` |
| `vbookProgress.ts` | 112 / 108 | `VBookStage`/`VBookProgress` types, `createIdleVBookProgress`/`createAnalyzingVBookProgress` factories, `vbookProgressFromEvent` (pure SSE `vbook` mapping), `applyAgentStatus(prev, status)` (near-pure `/agent-status` merge, port of `updateVBookProgress`) |
| `progressRows.ts` | 374 / 363 | `TaskRow`/`TaskLabels`/`ProgressPanelState` types, **`ProgressTrackingState`** (explicit object holding the previously module-scope Maps `taskReadyFloor`/`taskCompletedAt`/`taskFrozenElapsed` + latches `generationCompleted`/`newGenerationPending`/`importCompleteReceived`), `createProgressTrackingState`, `resetProgressTracking`, `hasAnyProgress`, `rowTaskKey`, `computeProgressRows(ctx, panel, vbookProg, labels)` |
| `timer.ts` | 51 / 61 | `GenerationTimerState` (explicit object replacing module-scope `timerStartedAt`/`finalElapsedSeconds`), `create/start/stopGenerationTimer`, `elapsedSeconds`, `formatTimerText` |
| `sseRouting.ts` | 60 / 125 | `routeProgressEvent(sink, tracking, data)` — JSON parse + dispatch of `analysis` / `vbook` (+heartbeat) / `generation_complete` (no-op) / `import_complete` (latch). Host signals are written through an explicit `ProgressEventSink` |
| `index.ts` | 69 / — | entry re-exports; documents the boundary rules |

### 9.2 Host side (unchanged ownership, `state/generateStore.ts` 1,323 → 858 LOC)

- `generateStore` now owns exactly: identity (`bookId`/`buildId`, `loadBook`, persistence + per-user stash/restore), `phase`/`errorMessage` (SessionSeam contract, audit B6), `onPlaybackPrepared`/`emitPlaybackPrepared`, nav-icon status machinery, layer-config/assets signals, transport (`api/client`), VBook orchestration actions (`startGeneration`, `startVBookGeneration`, `pollVBookProgress`, `cancel*`, `checkAndRestore*`, `applyGenerationResults`), SSE transport loop (`startProgressStream`/`runProgressStream` — stream machinery, NOT routing).
- It creates the two explicit state objects — `progressTracking: ProgressTrackingState`, `generationTimer: GenerationTimerState` — and passes them into every domain call; the previously hidden module-scope Maps/latches/`let`s are gone from both sides.
- `computeProgressRows` is a thin host wrapper: binds `progressTracking`+`generationTimer`, reads `vbookProgress.value.stage` / `generationStatus.value === 'RUNNING'` at call time, injects `vbookStageLabel` (i18n port-shaped) and the two side-effect ports `onGenerationFinalized` (stop stream + clear COMPLETED stage + SUCCESS + `isRegenerating=false` + `applyGenerationResults`) and `onRunningIdle` (clear RUNNING pulse). The finalize interleaving (domain clears `taskCompletedAt`, host callback does the rest) is synchronous and re-entrancy-free — externally observable write order identical.
- `handleProgressEvent` delegates to `routeProgressEvent` via a module-level `ProgressEventSink` adapter; `importCompleteReceived` now lives on `progressTracking` (read by `pollVBookProgress`, reset by `markImportIncomplete`/`startVBookGeneration`).
- Timer helpers re-exported for pages: `liveElapsedSeconds`, `formatTimerText` (GeneratePage's local duplicates deleted; AnalysisProgressPanel's `formatTimer` duplicate deleted — it imports the store re-export).
- Public surface of `generateStore` preserved: all previously exported symbols still resolve (types via `export type {…}`, `applyAnalysisEvent` re-export, `analysisOverallPercent` wrapper). Consumers (AppShell, fileAdapters, playerAdapters, navigatorAdapters, Edit/Settings/AiAssistant/Generate pages, main.tsx, authStore, fileStore seams, tests) untouched.

### 9.3 Dependencies of the new domain module (guard-pinned)

Allowed imports: domain siblings (`./analysis` etc.) + `../../api/models` **type-only** (wire types — vendored at package-cut time, web-player `models.ts` precedent). Forbidden and verified absent: `api/client`, `app/*` (router/i18n/desktop/icons), host state stores (`positionStore`/`authStore`/`fileStore`/`playbackStore`/`generateStore`), `pages/`, `@animastor/*`, `@preact/signals`. The authStore → generateStore identity edge is unchanged (documented, one-directional). No new cycles: `generateStore → generationProgress` is the only edge and one-directional (state-graph guard re-verified).

### 9.4 Tests

- Moved/extended: `generationProgress/analysis.test.ts` (verbatim migration of the pure suites + new injected-clock + heartbeat cases), `timer.test.ts`, `vbookProgress.test.ts`, `sseRouting.test.ts`, `progressRows.test.ts` (**new**: monotonic floor, stale-done gate incl. tolerance, sibling-row keys, 10s done-window, new-gen gate, all-cancelled guard, RUNNING-pulse self-heal, VBook row states, reset/hasAnyProgress semantics) — all run with **zero** `generateStore` imports (guard-enforced).
- Kept host-side: `generateStore.analysis.test.ts` now covers only the host integration (layer-config roundtrip, SSE seam end-to-end via the domain router, reset wrapper).
- New architecture guard: `architecture/generation-progress-contour.guard.test.ts` (16 assertions: boundary, type-only models, no signals, no module-global state, explicit-state parameterization, host ownership tokens, consumer allowlist, domain-test independence, no premature package).
- Result at time of landing: **typecheck clean, 190/190 tests green, vite build green.**

### 9.5 Deviations / notes

- Two pure functions gained an injectable clock (`applyAnalysisEvent(prev, ev, now = Date.now())`, timer start/stop) — default parameter preserves every production call site; no behavior change.
- One port bug was caught by the new unit tests during the move (agent-status stage id is `create_visual_prompts`, not the SSE's `creating_visuals`) and fixed in the port — final code is a 1:1 port verified by line-diff against HEAD.
- `resetProgressTracking` intentionally does NOT clear `importCompleteReceived` (host `markImportIncomplete` owns it) — matches the previous module-scope behavior exactly.

---

## 10. Re-audit verdict: readiness of `generation-progress` for physical extraction

**COMPLETED (Step 2 executed, see §11).** The mechanical cut has been performed:

1. **Zero host reach** — the package imports nothing at runtime; wire types are vendored locally (`src/models.ts`).
2. **No hidden state** — all mutable state arrives as explicit objects the host owns.
3. **Tests travel** — 5 domain test files (896 LOC) live in `packages/animastor-web-generator/test/` and run standalone.
4. **Wire types vendored** — `ProgressEvent`, `ProgressPanelResponse`, `ProgressTask` in `src/models.ts` (web-player precedent).
5. **Host-owned permanently** — identity, phase, auth, transport, VBook orchestration, i18n port, signal binding.
6. **Port contracts** — `ProgressRowContext` + `ProgressEventSink` shapes serve as the port contracts; no renaming needed.

The overall `@animastor/web-generator` verdict stays **NOT READY** (identity/auth/phase blockers per §6 — Steps 3-5 unchanged). The generation-progress slice is **PHYSICALLY EXTRACTED / READY** (§11).

---

## 11. Step 2 EXECUTED — physical package extraction of generation-progress

**Status:** landed on `c21.4-physically-extract-analysis-from-backend`; package `@animastor/web-generator` created at `packages/animastor-web-generator/`. The in-repo `state/generationProgress/` directory is physically deleted; the host now consumes the package through its root entry point.

### 11.1 Package location and structure

```
packages/animastor-web-generator/
├── package.json          # @animastor/web-generator 0.1.0
├── tsconfig.json         # pure TS (no JSX)
├── tsup.config.ts        # ESM + dts, no JSX
├── vitest.config.ts      # happy-dom, no JSX
├── LICENSE               # MIT
├── README.md
├── src/
│   ├── index.ts          # public API entry point
│   ├── models.ts         # vendored wire types (ProgressEvent, ProgressPanelResponse, ProgressTask)
│   ├── analysis.ts       # applyAnalysisEvent, analysisOverallPercent, heartbeat, reset
│   ├── vbookProgress.ts  # vbookProgressFromEvent, applyAgentStatus, factories
│   ├── progressRows.ts   # computeProgressRows, ProgressTrackingState, ProgressRowContext
│   ├── timer.ts          # GenerationTimerState, start/stop/elapsed/formatTimerText
│   └── sseRouting.ts     # routeProgressEvent, ProgressEventSink
└── test/
    ├── analysis.test.ts      # 239 LOC
    ├── vbookProgress.test.ts  # 108 LOC
    ├── progressRows.test.ts   # 363 LOC
    ├── timer.test.ts          # 61 LOC
    └── sseRouting.test.ts     # 125 LOC
```

### 11.2 What was vendored (wire types)

The `ProgressEvent`, `ProgressPanelResponse`, and `ProgressTask` interfaces from `api/models.ts` were vendored into `src/models.ts` as structural (NOT nominal) types. This follows the `@animastor/web-player` `models.ts` precedent. The `AgentStatusLike` interface (already narrowed in the domain module) required no additional vendoring — it is defined directly in `vbookProgress.ts` as a structural subset of `AgentStatusResponse`.

**Decision:** Vendored locally into the package. No `@animastor/contracts` additions were needed. No new cross-package contracts created.

### 11.3 Host boundary after extraction

**Host-owned (unchanged):**
- `bookId` / `buildId` signals + `loadBook` + localStorage persistence
- Per-user stash/restore (`authStore` edge)
- `phase` / `errorMessage` (fileStore dual-writer contract, audit B6)
- `onPlaybackPrepared` bus
- SSE/HTTP transport (`api/client`)
- VBook orchestration actions
- `vbookStageLabel` i18n injection (via `ProgressRowContext.vbookStageLabel` port)
- `progressTracking` / `generationTimer` state objects (host-owned, passed explicitly)

**Package-owned:**
- Analysis state machine (`applyAnalysisEvent`, `analysisOverallPercent`, `applyAnalysisHeartbeat`)
- Progress panel rows (`computeProgressRows`, `ProgressTrackingState`)
- SSE event routing (`routeProgressEvent`)
- Generation timer math (`GenerationTimerState`, `start/stop/elapsed/formatTimerText`)
- VBook progress mapping (`vbookProgressFromEvent`, `applyAgentStatus`)

### 11.4 Dependency direction (verified)

```
host (generateStore) → @animastor/web-generator (package root)
```

One-directional. No reverse dependencies. No deep imports. Architecture guard verified.

### 11.5 Tests after extraction

- **Package unit tests:** 5 test files, 69 tests — all pass from `packages/animastor-web-generator/`
- **Frontend tests:** 10 test files, 115 tests — all pass from `frontends/app/`
- **Combined:** 184 tests passing (69 package + 115 frontend)
- **Package typecheck:** clean (`tsc --noEmit`)
- **Frontend typecheck:** clean (`tsc --noEmit`)
- **Vite build:** success (403 KB JS bundle)
- **Architecture guard:** updated to verify physical package boundary (old contour removed, root-only consumption, no reverse deps)

### 11.6 Architecture guard updates

The `generation-progress-contour.guard.test.ts` was rewritten from in-repo domain verification to physical package boundary verification. It now checks:
1. Old `state/generationProgress/` directory is gone
2. `generateStore` imports from `@animastor/web-generator` (package root)
3. No deep imports (`@animastor/web-generator/src/...`) from any host file
4. Only `generateStore` consumes the package (pages via store surface)
5. Host ownership preserved (identity, auth, state objects)
6. No reverse dependencies from host stores to the package
7. No new dependency cycles

### 11.7 Verdict

**generation-progress: PHYSICALLY EXTRACTED / READY**

The generation-progress domain slice is now a standalone NPM package (`@animastor/web-generator`) with zero host dependencies. The package can be built, tested, and published independently.

**@animastor/web-generator (full): NOT READY**

The overall web-generator extraction remains blocked on:
1. **Identity ownership** (§6 blocker 1): `bookId`/`buildId`/`loadBook` consumed by 10+ host files
2. **Auth edge** (§6 blocker 2): `authStore` → `generateStore` hard edge
3. **Dual-writer phase/errorMessage** (§6 blocker 3): fileStore SessionSeam contract
4. **Event producer inversion** (§6 blocker 4): `onPlaybackPrepared` bus
5. **No web generation contracts in @animastor/contracts** (§6 blocker 5): wire types vendored locally

The next blocker for full "web-generator" extraction is the **identity split** (audit §6, Steps 2-3): split `generateStore` so identity stays host-side and orchestration moves to a `GenerationService` parameterized by `GenerationSession` + `GeneratorPorts`.

---

*Step-1 change (in-repo domain split) executed and documented; Step-2 change (physical package extraction) executed and documented on this branch. Package: packages/animastor-web-generator/ (@animastor/web-generator). Old in-repo contour deleted.*

---

## 12. Step 3 — Identity / Orchestration Audit

**Status:** AUDIT ONLY — no code changes.  
**Date:** 2026-09-14  
**Branch:** `c21.4-physically-extract-analysis-from-backend`  
**Baseline commit:** `1fad085e` (Step 2 complete — generation-progress extracted)  
**Purpose:** Determine which parts of `generateStore.ts` can be safely extracted as the next architectural layer, separately analyzing identity and orchestration concerns.

---

### 12.1 generateStore.ts functional decomposition (858 LOC)

| Lines | Block | Category | What it does | Who owns the data |
|---|---|---|---|---|
| 23–45 | Imports | — | host + package imports | — |
| 47–59 | Types + PlaybackPrepared | UI/Event | `GenerationStatus`, `PlaybackPrepared` interface, `SceneRef` re-export | generateStore |
| 61–67 | Identity signals | **Identity** | `bookId`, `buildId`, `blankBookJustCreated` signals | generateStore |
| 69–80 | Playback event bus | **Event** | `onPlaybackPrepared` / `emitPlaybackPrepared` | generateStore |
| 82–143 | Nav-icon status | UI | `generationStatus` signal + SUCCESS pulse timer (module-scope `setTimeout`/`setInterval`) | generateStore |
| 145–202 | Persisted session | **Identity** | `persistBookSession`, `clearBookSession`, `stashBookSessionForUser`, `restoreStashedBookSessionForUser`, `loadBook` | generateStore |
| 204–208 | Edit dirty indicator | **Identity** | `dirtySummary` signal | generateStore |
| 210–242 | File slice seams | **Seam** | `stopGenerationSession`, `setRegenerating`, `bumpVBookPollToken`, `markImportIncomplete` | generateStore |
| 254–259 | Phase / error | **Identity** | `phase`, `errorMessage` signals (dual-written by fileStore + generateStore) | generateStore (fileStore writes through SessionSeam) |
| 261–306 | Generate screen signals | **UI/Store** | `vbookProgress`, `isRegenerating`, `vbookAnalysisProgress`, analysis re-exports | generateStore |
| 307–370 | Layer config | **Orchestration** | `loadLayerConfig`, `persistLayerConfig`, `refreshAssetsState` + signals | generateStore |
| 383–450 | Timer + Progress panel | **Orchestration** | `generationTimer`, `progressTracking` state objects, `computeProgressRows` wrapper | generateStore (wraps @animastor/web-generator) |
| 452–498 | VBook progress | **Orchestration** | `updateVBookProgress`, `checkVBookAgentStatus`, `clearVBookProgress` | generateStore |
| 500–552 | SSE progress stream | **Transport** | `startProgressStream`, `stopProgressStream`, `runProgressStream`, `handleProgressEvent` | generateStore |
| 554–847 | Generation actions | **Orchestration** | `startGeneration`, `startVBookGeneration`, `pollVBookProgress`, `applyGenerationResults`, `cancelGeneration`, `cancelTask`, `checkAndRestoreGenerationState` | generateStore |

---

### 12.2 Identity boundary analysis

#### 12.2.1 Identity inventory

| Signal/function | Defined at | Written by | Read by (production) | Category |
|---|---|---|---|---|
| `bookId` | generateStore:61 | `loadBook` | GeneratePage, EditPage, AiAssistantPage, SettingsPage, AppShell, main.tsx, playerAdapters, navigatorAdapters, fileAdapters (via SessionSeam), generateStore internal | Session identity |
| `buildId` | generateStore:62 | `loadBook`, `startGeneration` | EditPage, AppShell (via fileAdapters), playerAdapters, navigatorAdapters, fileAdapters (via SessionSeam), generateStore internal | Session identity |
| `loadBook(id, build)` | generateStore:197 | — | fileAdapters (via SessionSeam), stashBookSessionForUser (internal) | Identity mutator |
| `stashBookSessionForUser` | generateStore:175 | — | authStore.logout() | Auth→identity edge |
| `restoreStashedBookSessionForUser` | generateStore:188 | — | authStore.login() | Auth→identity edge |
| `phase` | generateStore:258 | fileStore (via SessionSeam), generateStore | AppShell, generateStore internal | Dual-writer |
| `errorMessage` | generateStore:259 | fileStore (via SessionSeam), generateStore | generateStore internal | Dual-writer |
| `dirtySummary` | generateStore:207 | fileStore (via SessionSeam) | EditPage | File-owned |
| `blankBookJustCreated` | generateStore:67 | fileStore (via `createBlankBook`) | AppShell | File-owned |
| `onPlaybackPrepared` | generateStore:72 | — | playerAdapters, navigatorAdapters, EditPage, GeneratePage | Event bus |
| `emitPlaybackPrepared` | generateStore:78 | generateStore (applyGenerationResults) | — | Event bus producer |
| `generationStatus` | generateStore:63 | generateStore | AppShell, generateStore internal | UI status |

#### 12.2.2 Identity verdict: NOT READY

**Reasons:**

1. **bookId/buildId are read by 10+ host files** (5 pages, 4 adapters, 1 main, 1 state store) — all as direct signal reads. Moving them to a separate package means every consumer must go through an adapter or port. The blast radius is the entire host app.

2. **Auth stash/restore is a hard edge**: `authStore.ts` directly imports `stashBookSessionForUser`/`restoreStashedBookSessionForUser` from `generateStore`. This is the pre-existing audit §3.2 blocker 2. Extracting identity would require authStore to go through a port — but authStore is the auth module, and adding an auth port would invert the dependency direction (auth would depend on the identity package).

3. **phase/errorMessage are dual-writer signals**: both `fileStore` (via `SessionSeam`) and `generateStore` write to them. The signals must remain in one place (the host) as the single source of truth. Splitting them across packages would fork the source of truth.

4. **Persistence is tightly coupled**: `persistBookSession`/`clearBookSession` use `localStorage` directly, and `stashBookSessionForUser`/`restoreStashedBookSessionForUser` use `localStorage` with user-scoped keys. This is web-platform-specific persistence that belongs in the host.

5. **No suitable existing package**: there is no `@animastor/session` or `@animastor/identity` package. Creating one would be a new package, not a mechanical extraction — violating the audit constraint.

#### 12.2.3 What could theoretically move to a session package (but NOT recommended now)

| What | Portability | Problem |
|---|---|---|
| `bookId`/`buildId` signals | Technically moveable | 10+ direct consumers; every one needs an adapter |
| `loadBook` | Technically moveable | Would become a port function; callers are fileAdapters + stash |
| `persistBookSession`/`clearBookSession` | Moveable | localStorage — web-specific, but portable as a storage port |
| `stashBookSessionForUser`/`restoreStashedBookSessionForUser` | Moveable | authStore would need a port to call them |
| `phase`/`errorMessage` | NOT moveable | Dual-writer; must stay host-side as single source of truth |
| `dirtySummary`/`blankBookJustCreated` | NOT moveable | Written by fileStore through seams; belong to File contour |

---

### 12.3 Orchestration boundary analysis

#### 12.3.1 Orchestration inventory

| Function | Reads | Writes | Calls | Dependencies |
|---|---|---|---|---|
| `startGeneration(req)` | `bookId` | `generationStatus`, `isRegenerating`, `progressTracking.newGenerationPending`, `buildId`, `phase`, `dirtySummary` | `postJson`, `refreshAssetsState`, `startProgressStream`, `startTimer` | api/client, timer, SSE, position |
| `startVBookGeneration()` | `bookId` | `generationStatus`, `isRegenerating`, `progressTracking.*`, `vbookProgress` | `getJson`, `postJsonLong`, `pollVBookProgress`, `startProgressStream`, `startTimer` | api/client, timer, SSE |
| `pollVBookProgress(bId, token)` | `bookId`, `vbookProgress`, `isRegenerating`, `progressTracking.importCompleteReceived`, `generationTimer` | `vbookProgress`, `generationStatus`, `isRegenerating` | `getJson`, `applyGenerationResults` | api/client, timer |
| `applyGenerationResults()` | `isRegenerating`, `bookId`, `buildId`, `position` | `generationStatus` (via `stopTimer`) | `getJson`, `sceneRefs`, `navigateTo`, `emitPlaybackPrepared` | api/client, position, player event |
| `cancelGeneration()` | `bookId`, `isRegenerating`, `hasAnyProgress()` | `generationStatus`, `progressTracking`, `isRegenerating`, `phase`, `errorMessage` | `postJson`, `stopTimer`, `stopProgressStream`, `resetProgressState`, `applyGenerationResults` | api/client, timer, SSE |
| `cancelTask(type, taskId)` | `bookId` | — | `postJson`, `clearVBookProgress` | api/client |
| `checkAndRestoreGenerationState()` | `bookId`, `isRegenerating`, `generationTimer` | `isRegenerating`, `generationStatus`, `phase` | `getJson`, `startTimer`, `startProgressStream`, `resetProgressState` | api/client, timer, SSE |
| `loadLayerConfig()` | `bookId` | `audioEnabled`, `imageEnabled`, `videoEnabled`, `vbookEnabled`, `analysisMode`, `analysisParallelism` | `getJson` | api/client |
| `checkVBookAgentStatus()` | `bookId`, `vbookProgress` | `vbookProgress` | `getJson` | api/client |

#### 12.3.2 Orchestration verdict: NOT READY

**Reasons:**

1. **Every orchestration function reads `bookId`**: the identity signal is the first thing each function checks. Without an identity port, orchestration cannot be separated from identity.

2. **Orchestration writes to host-owned signals**: `startGeneration` writes to `generationStatus`, `isRegenerating`, `phase`, `buildId`, `dirtySummary`. These signals are read by AppShell, EditPage, GeneratePage, and fileAdapters. Moving orchestration to a package would require all signal writes to go through ports — a significant adapter surface.

3. **applyGenerationResults has deep host coupling**: it calls `navigateTo` (positionStore), `emitPlaybackPrepared` (event bus), `sceneRefs` (api/models), and reads `position.value.chapterId`. This function bridges generation completion to navigation and playback — it crosses multiple host boundaries.

4. **SSE stream management is host-specific**: `startProgressStream`/`stopProgressStream` use `AbortController`, `setTimeout`, and the `sse` transport from api/client. The reconnection loop with exponential backoff is transport-specific logic that could theoretically be a port, but the SSE adapter is tightly coupled to the store's signals.

5. **Timer state is already delegated**: `generationTimer` lives in generateStore and is passed to @animastor/web-generator. The timer is a thin wrapper — not worth extracting separately.

#### 12.3.3 What could theoretically move to a generation-orchestration package (but NOT recommended now)

| What | Portability | Problem |
|---|---|---|
| `startGeneration` | Technically moveable via ports | Needs bookId, writes to 6+ signals, calls api/client |
| `startVBookGeneration` / `pollVBookProgress` | Technically moveable via ports | Long async chain with token-based cancellation, writes to 4+ signals |
| `cancelGeneration` / `cancelTask` | Technically moveable | Writes to 5+ signals, calls api/client |
| `loadLayerConfig` / `persistLayerConfig` | Most portable | Reads bookId, writes to 6 signals, calls api/client — cleanest candidate |
| `checkAndRestoreGenerationState` | Technically moveable | Reads bookId, writes to 3 signals, calls api/client |
| SSE stream management | Partially moveable | Needs AbortController port, writes to signals via ProgressEventSink |
| `applyGenerationResults` | NOT moveable without major refactoring | Bridges generation → navigation → playback (3 host boundaries) |

---

### 12.4 Dependency graph

#### 12.4.1 generateStore → ... (outgoing)

```
generateStore
├── @preact/signals          (signal)
├── @animastor/web-generator (domain functions + types)
├── api/client               (getJson, postJson, postJsonLong, putJson, sse)
├── api/models               (types + sceneRefs value)
├── state/positionStore      (navigateTo, position)
├── app/i18n                 (vbookStageLabel)
```

#### 12.4.2 ... → generateStore (incoming — production only)

```
state/authStore              → stashBookSessionForUser, restoreStashedBookSessionForUser
app/fileAdapters.ts          → bookId, buildId, phase, errorMessage, dirtySummary,
                                blankBookJustCreated, loadBook, emitPlaybackPrepared,
                                resetProgressState, clearVBookProgress, setRegenerating,
                                bumpVBookPollToken, markImportIncomplete, stopGenerationSession
app/playerAdapters.ts        → bookId, buildId, onPlaybackPrepared
app/navigatorAdapters.ts     → bookId, buildId, onPlaybackPrepared
app/AppShell.tsx              → generationStatus, bookId, phase, blankBookJustCreated
main.tsx                     → bookId
pages/GeneratePage.tsx       → bookId, phase, vbookProgress, isRegenerating,
                                audioEnabled, imageEnabled, videoEnabled, vbookEnabled,
                                setAudioEnabled, setImageEnabled, setVideoEnabled, setVBookEnabled,
                                startGeneration, startVBookGeneration, cancelGeneration, cancelTask,
                                checkAndRestoreGenerationState, checkVBookAgentStatus,
                                computeProgressRows, resetGenerationStatus, onPlaybackPrepared,
                                liveElapsedSeconds, formatTimerText
pages/EditPage.tsx           → bookId, buildId, dirtySummary, onPlaybackPrepared
pages/AiAssistantPage.tsx    → bookId
pages/SettingsPage.tsx       → bookId, resetProgressState
```

#### 12.4.3 Cycles

- **generateStore ⇄ playbackStore**: DISSOLVED (guard-pinned). `playbackStore` imports `onPlaybackPrepared` from generateStore — one directed edge. `generateStore` does NOT import playbackStore.
- **generateStore ⇄ fileStore**: DISSOLVED via seams. fileStore receives identity + generation reset through injected `SessionSeam` / `GenerationResetSeam`. No direct imports.
- **generateStore ⇄ authStore**: ONE DIRECTIONAL. `authStore` imports `stashBookSessionForUser`/`restoreStashedBookSessionForUser` from generateStore. `generateStore` does NOT import authStore. This is the pre-existing documented edge (§3.2 blocker 2).
- **No other cycles** exist in the state/ module graph.

---

### 12.5 Existing ports/adapters patterns

The codebase already uses a ports/adapters pattern for other extracted packages:

| Package | Adapter file | Pattern |
|---|---|---|
| `@animastor/web-player` | `app/playerAdapters.ts` | `PlayerPorts` contract — session, generation, position, invalidations, http, shellMode, i18n, icons |
| `@animastor/web-file` | `app/fileAdapters.ts` | `FilePorts` contract — session, actions, http, i18n, toast, navigation, openRequests, deepLink, icons |
| `@animastor/web-navigator` | `app/navigatorAdapters.ts` | `NavigatorPorts` contract — bookSource, position, http |
| `@animastor/web-editor` | `app/fileAdapters.ts` (shared) | Uses FilePorts from web-file |
| `@animastor/web-settings` | `app/workerAdapters.ts` | `WorkerPorts` contract — api, ui, icons |
| `@animastor/web-local-ai` | `app/localAiAdapters.ts` | `LocalAiPorts` contract — api, i18n, ui, settings |

**Common pattern:** Each package defines its own `*Ports` interface. A single adapter file in `app/` wires host infrastructure to the ports. The package never imports host modules directly.

---

### 12.6 Candidate boundaries assessment

| Boundary | Verdict | Reason |
|---|---|---|
| **Identity (bookId/buildId/loadBook/session)** | **NOT READY** | 10+ direct signal consumers across pages/adapters; auth hard edge; phase/errorMessage dual-writer; no suitable existing package; localStorage persistence is web-specific |
| **Auth stash/restore** | **NOT READY** | Only 2 functions, called only by authStore — but extracting them alone creates an identity package dependency for authStore, inverting the auth→identity direction |
| **Orchestration (startGeneration/VBook/cancel)** | **NOT READY** | Every function reads bookId (identity dependency); writes to 6+ host signals; applyGenerationResults bridges 3 host boundaries; SSE stream is host-specific |
| **Layer config (load/persist/refresh)** | **READY WITH ADAPTER** (cleanest candidate) | Reads bookId, writes to 6 signals, calls api/client. Could become a `GenerationConfigPorts` contract. But the signals it writes to are also read by other code — extraction requires the signals to move too or remain host-owned |
| **SSE stream** | **NOT READY** | Transport-specific (AbortController, setTimeout), writes to signals via ProgressEventSink — already delegated to @animastor/web-generator for routing |
| **Timer** | **READY** (already delegated) | `generationTimer` is already a state object owned by generateStore, passed to @animastor/web-generator. The wrapper functions are trivial. |

---

### 12.7 Recommended next extraction step

**No extraction is recommended at this time.** The identity and orchestration blockers are structural:

1. The identity signals (`bookId`/`buildId`) are the most widely consumed exports of generateStore (10+ direct production consumers). Extracting them would require a ports/adapter layer for every consumer — a host-wide refactoring, not a mechanical cut.

2. The orchestration functions are deeply coupled to identity (they all read `bookId` first) and to host signals (they write to `generationStatus`, `isRegenerating`, `phase`, `vbookProgress`, etc.). Extracting them as a package would require injecting all these signals through ports — a significant adapter surface with no existing precedent in the codebase for this scale.

3. The auth→identity edge (`authStore → stashBookSessionForUser`) is a hard coupling that cannot be removed without an auth port — which would invert the dependency direction.

4. The `phase`/`errorMessage` dual-writer contract (fileStore + generateStore both write) means these signals must remain in one place as the single source of truth.

**If extraction is pursued in the future, the recommended sequence is:**

1. **First:** Define `GenerationPorts` (identity read port + transport port + event port) — a new interfaces file, not a package.
2. **Second:** Split generateStore so orchestration reads identity through the port, not direct signal access.
3. **Third:** Only then can orchestration be extracted as a package — with identity staying host-side permanently.

---

### 12.8 Verdict

**Identity boundary: NOT READY**  
**Orchestration boundary: NOT READY**  

The overall `@animastor/web-generator` extraction remains **NOT READY** for the full contour. The generation-progress slice is **PHYSICALLY EXTRACTED / READY** (§11). The identity and orchestration blockers are structural and cannot be resolved through mechanical extraction — they require an architectural design decision about where session identity lives in the host-package boundary.

---

*Step-3 identity/orchestration audit completed on this branch; no code changes, no packages created, no behavior modified.*
