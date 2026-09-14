# Web Generator — Extraction Audit (Re-verification)

**Status:** Step-8 orchestration re-audit COMPLETED (audit-only; VBook agent slice identified as the next physical extraction — READY, see §17)  
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

A **domain-first slice** (analysis/progress pure logic) was READY WITH CONDITIONS at baseline — **Step 1 is now EXECUTED** (§9): the slice physically exists as the in-repo module `state/generationProgress/` with parameterized state, independent unit tests, and a contour guard. **Step 2 is now EXECUTED** (§11): the slice has been physically extracted into `@animastor/web-generator` at `packages/animastor-web-generator/`, the old in-repo contour deleted, and the host wired to consume the package root. The generation-progress domain is now **PHYSICALLY EXTRACTED / READY**. **Step 4 is now COMPLETED** (§13): GenerationPorts boundary interfaces are designed — 8 small, focused port interfaces define the exact capabilities a future orchestration package would consume. Dependency direction verified clean. Best next extraction slice identified: `loadLayerConfig / persistLayerConfig`.

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

---

## 13. Step 4 — GenerationPorts Boundary Design

**Status:** DESIGN ONLY — no production extraction performed.  
**Date:** 2026-09-14  
**Branch:** `c21.4-physically-extract-analysis-from-backend`  
**Baseline commit:** `175c38b5` (Step 3 complete — identity/orchestration audit)  
**Purpose:** Define the GenerationPorts interfaces that a future orchestration package would consume, verify dependency direction, and identify the safest next extraction slice.

**Step 4 is design-only; no production extraction performed.**

---

### 13.1 Capability ownership audit

Every capability in `generateStore.ts` is classified by current owner, future owner, and whether a port is needed.

#### 13.1.1 Identity / session

| Capability | Current owner | Future owner | Port needed? | Why |
|---|---|---|---|---|
| `getBookId()` | generateStore (signal read) | host (signal owner) | **Read-only port** | Orchestration needs bookId for API paths and playbackPrepared; must not hold the signal |
| `getBuildId()` | generateStore (signal read) | host (signal owner) | **Read-only port** | Same as bookId — orchestration reads at call time |
| `loadBook()` | generateStore | host (permanent) | **No** | Identity mutator; host-owned, never called by orchestration |
| `persistBookSession()` / `clearBookSession()` | generateStore | host (permanent) | **No** | localStorage persistence — host-only |
| `stashBookSessionForUser()` / `restoreStashedBookSessionForUser()` | generateStore | host (permanent) | **No** | auth→identity hard edge; stays host-side |

#### 13.1.2 Generation state

| Capability | Current owner | Future owner | Port needed? | Why |
|---|---|---|---|---|
| `phase` (read) | generateStore | host (signal owner) | **No read port** | Orchestration does NOT read phase — UI reads it |
| `phase` (write) | generateStore + fileStore (dual) | host (permanent) | **Callback port** | Orchestration sets phase on generation start/finish |
| `errorMessage` (write) | generateStore | host | **Callback port** | Orchestration sets error on failure |
| `generationStatus` (write) | generateStore | host | **Callback port** | Orchestration sets RUNNING/IDLE/SUCCESS/ERROR |
| `isRegenerating` (write) | generateStore | host | **Callback port** | Orchestration sets true/false |
| `buildId` (write) | generateStore (startGeneration) | host | **Callback port** | Orchestration receives new buildId from API |
| `dirtySummary` (write) | generateStore (startGeneration) | host | **Callback port** | Orchestration receives from API response |
| `vbookProgress` (write) | generateStore | host | **No** | Written by @animastor/web-generator adapter already |

#### 13.1.3 Transport

| Capability | Current owner | Future owner | Port needed? | Why |
|---|---|---|---|---|
| `getJson` / `postJson` / `postJsonLong` / `putJson` | api/client (host) | host (permanent) | **Transport port** | Orchestration makes API calls; host provides fetch implementation |
| `sse()` | api/client (host) | host (permanent) | **SSE port** | Host owns AbortController, reconnect loop, epoch guard |
| `AbortController` | generateStore (module-scope) | host | **Inside SSE port** | Host manages stream lifecycle |

#### 13.1.4 Navigation

| Capability | Current owner | Future owner | Port needed? | Why |
|---|---|---|---|---|
| `navigateTo()` | positionStore (host) | host (permanent) | **Navigation port** | Orchestration anchors position after generation |
| `position` (read) | positionStore (host) | host | **No** | The "if no position, anchor at first scene" logic stays host-side in applyGenerationResults |

#### 13.1.5 Playback

| Capability | Current owner | Future owner | Port needed? | Why |
|---|---|---|---|---|
| `onPlaybackPrepared` / `emitPlaybackPrepared` | generateStore | host (permanent) | **Playback port (emit only)** | Orchestration emits event; Player subscribes via PlayerPorts.generation |

#### 13.1.6 Layer config

| Capability | Current owner | Future owner | Port needed? | Why |
|---|---|---|---|---|
| `loadLayerConfig()` | generateStore | orchestration | **Config port (callbacks)** | Orchestration fetches + writes through host callbacks |
| `persistLayerConfig()` | generateStore | orchestration | **Config port (callbacks)** | Same — writes through host callbacks |
| `audioEnabled` / `imageEnabled` / `videoEnabled` / `vbookEnabled` (write) | generateStore | host (signal owner) | **Callback port** | Orchestration writes through port |
| `analysisMode` / `analysisParallelism` (write) | generateStore | host | **Callback port** | Orchestration writes through port |

#### 13.1.7 Progress / session management

| Capability | Current owner | Future owner | Port needed? | Why |
|---|---|---|---|---|
| `resetProgressState()` | generateStore | host | **Progress port** | Orchestration calls on cancel/close |
| `clearVBookProgress()` | generateStore | host | **Progress port** | Same |
| `bumpVBookPollToken()` | generateStore | host | **Progress port** | Same |
| `markImportIncomplete()` | generateStore | host | **Progress port** | Same |
| `stopGenerationSession()` | generateStore | host | **Progress port** | Same |

#### 13.1.8 Timer

| Capability | Current owner | Future owner | Port needed? | Why |
|---|---|---|---|---|
| `generationTimer` state object | generateStore (owns instance) | host (permanent) | **No** | Already delegated to @animastor/web-generator via explicit state |
| `startTimer()` / `stopTimer()` | generateStore (thin wrappers) | orchestration | **No** | Trivial wrappers; orchestration can call start/stopGenerationTimer directly |
| `formatTimerText()` / `liveElapsedSeconds()` | @animastor/web-generator | @animastor/web-generator | **No** | Domain functions, already extracted |

---

### 13.2 Proposed port interfaces

Eight small, focused interfaces — one per capability group. Defined in `frontends/app/src/app/generationPorts.ts`:

```typescript
// Read-only identity (orchestration reads, never writes)
interface GenerationIdentityPort {
  getBookId(): string;
  getBuildId(): string;
}

// JSON HTTP transport (orchestration calls, host provides fetch)
interface GenerationTransportPort {
  getJson<T>(path: string): Promise<T>;
  postJson<T>(path: string, body?: unknown): Promise<T>;
  postJsonLong<T>(path: string, body?: unknown): Promise<T>;
  putJson<T>(path: string, body: unknown): Promise<T>;
}

// SSE stream (host owns AbortController + reconnect)
interface GenerationSsePort {
  startStream(bookId: string): AsyncIterable<string>;
  stopStream(): void;
}

// Navigation (write direction only)
interface GenerationNavigationPort {
  navigateTo(p: { chapterId: string | null; sceneId: string | null; ... }): void;
}

// Playback event (fire-and-forget emit)
interface GenerationPlaybackPort {
  emitPlaybackPrepared(prep: { bookId: string; buildId: string; scenes: unknown[]; ... }): void;
}

// State callbacks (orchestration writes through host-owned signals)
interface GenerationStatePort {
  setPhase(phase: string): void;
  setErrorMessage(msg: string | null): void;
  setGenerationStatus(status: 'IDLE' | 'RUNNING' | 'ERROR' | 'SUCCESS'): void;
  setIsRegenerating(v: boolean): void;
  setBuildId(buildId: string): void;
  setDirtySummary(summary: unknown): void;
}

// Layer config callbacks (orchestration writes through host callbacks)
interface GenerationConfigPort {
  setAudioEnabled(v: boolean): void;
  setImageEnabled(v: boolean): void;
  setVideoEnabled(v: boolean): void;
  setVBookEnabled(v: boolean): void;
  setAnalysisMode(mode: 'sequential' | 'parallel'): void;
  setAnalysisParallelism(n: number): void;
  setLayerConfigLoaded(v: boolean): void;
  setAnalysisConfigLoaded(v: boolean): void;
}

// Progress / session management callbacks
interface GenerationProgressPort {
  resetProgressState(): void;
  clearVBookProgress(): void;
  bumpVBookPollToken(): void;
  markImportIncomplete(): void;
  stopGenerationSession(): void;
}

// Composite (optional — orchestration can use individual or bundle)
interface GenerationPorts {
  identity: GenerationIdentityPort;
  transport: GenerationTransportPort;
  sse: GenerationSsePort;
  navigation: GenerationNavigationPort;
  playback: GenerationPlaybackPort;
  state: GenerationStatePort;
  config: GenerationConfigPort;
  progress: GenerationProgressPort;
}
```

**Design principles:**
- All interfaces are plain TypeScript types — no `@preact/signals`, no DOM, no framework
- Orchestration reads identity through getters (not signal references)
- Orchestration writes state through callbacks (not direct signal mutation)
- The host decides how callbacks map to signals — orchestration is unaware
- No composite `getGenerateStore()` or `getState()` — each capability is individually typed

---

### 13.3 Dependency direction

```
host (generateStore) ──implements──▶ GenerationPorts
future orchestration ──depends on──▶ GenerationPorts
                                    ──depends on──▶ @animastor/web-generator
```

**Verified absent:**
- `orchestration → generateStore` — orchestration never imports the host store
- `generateStore → orchestration` — host provides the implementation, does not depend on the port contract
- `orchestration → authStore` — no auth dependency
- `orchestration → fileStore` — no file dependency
- `orchestration → positionStore` — navigation through port, not direct import
- `orchestration → playerAdapters` / `navigatorAdapters` — playback through port
- `orchestration → api/client` — transport through port
- `orchestration → @preact/signals` — all interfaces are plain TS

---

### 13.4 `applyGenerationResults` boundary

**Current implementation** (generateStore.ts:742–769):
1. Stop timer (if not regenerating)
2. Fetch `GET /book/:id` → `BookData`
3. Extract `sceneRefs(bookData)`
4. If no position → anchor at first cover scene via `navigateTo()`
5. Emit `playbackPrepared` with softRefresh=true

**Responsibility split:**

| Responsibility | Owner | Port |
|---|---|---|
| Fetch book data + extract scenes | orchestration | transport port |
| Stop timer | orchestration | (calls domain timer directly) |
| Check position + anchor if empty | **host** (stays in `applyGenerationResults`) | navigation port (called by host) |
| Emit playbackPrepared | orchestration | playback port |

**Verdict:** The "if no position, anchor at first scene" logic (lines 759–764) is a host-side concern because it reads `position.value.chapterId` — a host-owned signal. The cleanest split: orchestration handles generation completion + scene extraction + playbackPrepared emission; the host wraps it with position anchoring. The orchestration package does NOT need to read `position`.

**Minimal port:** `GenerationPlaybackPort.emitPlaybackPrepared` covers the orchestration's output. Position anchoring stays host-side.

---

### 13.5 SSE boundary

**Current SSE architecture:**

| Component | Owner | Responsibility |
|---|---|---|
| `startProgressStream(bId)` / `stopProgressStream()` | generateStore (module-scope) | AbortController lifecycle, epoch guard |
| `runProgressStream(bId, epoch, controller)` | generateStore | Reconnection loop with exponential backoff |
| `handleProgressEvent(data)` | generateStore → @animastor/web-generator | JSON parse + dispatch via `routeProgressEvent` |
| ProgressEventSink | generateStore (module-level adapter) | Binds domain router to host signals |

**Proposed split:**

| Responsibility | Owner | Port |
|---|---|---|
| SSE lifecycle (start/stop/reconnect/epoch) | **host** | SSE port (startStream / stopStream) |
| Progress event routing | orchestration | (uses `routeProgressEvent` from @animastor/web-generator) |
| Signal binding (ProgressEventSink) | **host** | (implemented in the adapter) |

**Orchestration SSE port** exposes only:
- `startStream(bookId)` → `AsyncIterable<string>` (yields raw SSE data)
- `stopStream()` → void

The host manages AbortController, reconnect, epoch guard, and yielding. Orchestration iterates the async iterable and routes events through `routeProgressEvent` (already in @animastor/web-generator).

---

### 13.6 Candidate extraction slices

| Slice | LOC est. | Verdict | Why |
|---|---|---|---|
| `loadLayerConfig` / `persistLayerConfig` | ~80 | **READY WITH ADAPTER** | Reads bookId (port), writes 8 signals through callbacks, calls transport port. Cleanest boundary: no SSE, no playback, no navigation. |
| SSE orchestration | ~60 | **READY WITH ADAPTER** | Transport port + ProgressEventSink already exist. Needs SSE port design (§13.5). |
| Generation lifecycle (start/cancel/restore) | ~300 | **NOT READY** | Writes to 6+ state callbacks, reads identity, calls transport + SSE. Requires all ports to be implemented simultaneously — high blast radius. |
| VBook lifecycle (start/poll/cancel) | ~200 | **NOT READY** | Same as generation lifecycle + long polling + token-based cancellation. |
| `applyGenerationResults` | ~30 | **NOT READY** | Bridges generation → navigation → playback. Position anchoring is host-side; playback emission is orchestration. Split requires both ports. |
| Cancel lifecycle | ~50 | **READY WITH ADAPTER** | Simpler than full lifecycle: writes to 5 state callbacks, calls transport + SSE stop. But depends on progress ports being defined. |

---

### 13.7 Recommended next extraction slice

**`loadLayerConfig` / `persistLayerConfig`** — the safest, smallest extraction candidate.

**Why it is safest:**
1. **Self-contained**: 2 async functions + 8 signal writes, no SSE, no playback, no navigation
2. **Clear port boundary**: reads bookId through identity port, writes through config port callbacks, calls transport port
3. **No event bus dependency**: does not emit playbackPrepared
4. **No dual-writer conflict**: fileStore never writes to layer config signals
5. **Testable in isolation**: mock the 3 ports (identity, transport, config), verify the functions
6. **Low blast radius**: 80 LOC, affects only GeneratePage layer-config toggle chips

**Remaining blockers for this slice:**
- The 8 config signal writes must go through `GenerationConfigPort` callbacks
- `loadLayerConfig` must read `bookId` through `GenerationIdentityPort.getBookId()`
- Both functions must call transport through `GenerationTransportPort`
- The host adapter (`app/generationAdapters.ts`) must wire the ports

---

### 13.8 Architecture guard

Added `architecture/generation-ports.guard.test.ts` (9 assertions):
1. `generationPorts.ts` exists
2. No forbidden imports (signals, stores, packages, api/client)
3. No `@preact/signals` usage (strips comment lines)
4. No `api/client` imports
5. No `state/*` store imports
6. No page/component imports
7. `generateStore` does NOT import `generationPorts.ts` (host provides, not depends)
8. All exports are interfaces (no runtime values)
9. No function implementations (only method signatures)

---

### 13.9 Verdict

**GenerationPorts design: READY**

Eight small, focused port interfaces are proposed. Dependency direction is clean (host → ports, orchestration → ports). No cycles. No dependency inversion.

**Current ownership blockers (unchanged from §12.7):**
1. `bookId`/`buildId` read by 10+ host files — identity stays host-side permanently
2. `authStore → generateStore` hard edge — auth stash/restore stays host-side
3. `phase`/`errorMessage` dual-writer — stays in one place (host)
4. `onPlaybackPrepared` producer — bus stays host-side

**Best next extraction slice: `loadLayerConfig` / `persistLayerConfig`**

**applyGenerationResults: SPLIT** — generation completion (fetch + scene extract + playback emit) goes orchestration; position anchoring stays host-side.

**SSE boundary: SPLIT** — lifecycle (start/stop/reconnect) stays host; event routing goes orchestration (via @animastor/web-generator's `routeProgressEvent`).

**Cycles:** none

**Tests:** 9/9 guard tests pass; 10/10 existing generation-progress guard tests pass

---

*Step-4 GenerationPorts boundary design completed on this branch; no production extraction performed. The ports file and guard are design artifacts — no runtime behavior changed.*

---

## 14. Step 5 — Layer Config Extraction

**Status:** PHYSICALLY EXTRACTED / READY  
**Date:** 2026-09-14  
**Branch:** `c21.4-physically-extract-analysis-from-backend`  
**Baseline commit:** `10ba46b7` (Step 4 complete — GenerationPorts boundary design)  
**Purpose:** Extract `loadLayerConfig` / `persistLayerConfig` / `refreshAssetsState` as the first physical extraction through GenerationPorts.

---

### 14.1 Safety audit summary

**Source code:** `state/generateStore.ts` lines 307–381 (75 LOC)

**Extracted functions:**
- `loadLayerConfig()` — fetches `GET /book/:id/layer-config`, returns parsed config
- `persistLayerConfig()` — sends `PUT /book/:id/layer-config` with current toggle values
- `getAssetsState()` — fetches `GET /book/:id/assets-state`, returns `{ has_assets }`

**Dependencies:**
- Reads `bookId.value` → ported via `IdentityPort.getBookId()`
- Calls `getJson` / `putJson` → ported via `TransportPort`
- No `@preact/signals` in extracted code (host wraps results in signals)
- No `generateStore`, `api/client`, pages, or other stores in extracted code

**Production consumers (unchanged):**
- `GeneratePage.tsx` — reads 4 toggle signals + calls 4 setter functions
- `AnalysisProgressPanel.tsx` — reads `analysisMode` signal
- `generateStore.analysis.test.ts` — test file (imports `loadLayerConfig`, `analysisMode`, `analysisParallelism`)

**What stays host-side:**
- All 9 signals (`vbookEnabled`, `audioEnabled`, `imageEnabled`, `videoEnabled`, `layerConfigLoaded`, `hasAssets`, `analysisMode`, `analysisParallelism`, `analysisConfigLoaded`)
- 4 setter functions (`setVBookEnabled`, `setAudioEnabled`, `setImageEnabled`, `setVideoEnabled`) — each writes a signal + calls `persistLayerConfig`
- `loadLayerConfig()` wrapper — calls package function, applies results to signals
- `refreshAssetsState()` wrapper — calls package function, writes `hasAssets` signal

---

### 14.2 Package: `@animastor/web-generator-config`

**Location:** `packages/animastor-web-generator-config/`

```
packages/animastor-web-generator-config/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── LICENSE
├── src/
│   ├── index.ts          # Public API: 3 pure functions + 2 port interfaces
│   └── models.ts         # Vendored wire types (LayerConfig, AssetsState)
└── test/
    ├── config.test.ts    # 10 unit tests (mock ports, no host imports)
    └── guard.test.ts     # 12 architecture guard assertions
```

**Public API:**
```typescript
// Port interfaces
interface IdentityPort { getBookId(): string }
interface TransportPort { getJson<T>(path): Promise<T>; putJson<T>(path, body): Promise<T> }

// Pure functions
loadLayerConfig(identity, transport): Promise<LayerConfig | null>
persistLayerConfig(transport, bookId, config): Promise<void>
getAssetsState(identity, transport): Promise<AssetsState | null>
```

**Dependency direction:**
```
host (generateStore) ──depends on──▶ @animastor/web-generator-config
```

One-directional. No reverse dependencies. No deep imports.

---

### 14.3 Host wiring

`generateStore.ts` imports 3 functions from the package:
- `loadLayerConfigDomain` (aliased)
- `persistLayerConfigDomain` (aliased)
- `getAssetsState`

The host provides port implementations inline:
```typescript
const cfg = await loadLayerConfigDomain(
  { getBookId: () => bookId.value },
  { getJson, putJson },
);
```

Setter functions remain host-side — they write signals + call `persistLayerConfig()` which delegates to the package.

The `frontends/app/package.json` dependency: `"@animastor/web-generator-config": "file:../../packages/animastor-web-generator-config"`

---

### 14.4 Architecture guard

`packages/animastor-web-generator-config/test/guard.test.ts` (12 assertions):
1. No forbidden imports in any source file (signals, stores, api/client, pages, @animastor/* packages)
2. No `@preact/signals` usage (comment-stripped check)
3. No `api/client` imports
4. No `state/*` store imports
5. No page/UI imports
6. Exports are interfaces and async functions only

---

### 14.5 Test results

| Suite | Tests | Status |
|---|---|---|
| `packages/animastor-web-generator-config/test/config.test.ts` | 10 | PASS |
| `packages/animastor-web-generator-config/test/guard.test.ts` | 12 | PASS |
| `frontends/app/` (all) | 124 | PASS |
| `frontends/app/` typecheck | — | CLEAN |
| `packages/animastor-web-generator-config/` typecheck | — | CLEAN |

---

### 14.6 Verdict

**layer-config = PHYSICALLY EXTRACTED / READY**

The layer-config logic (load/persist/assets-state) is now a standalone NPM package with zero host dependencies. The host wires it through IdentityPort + TransportPort. All tests pass. Typecheck clean.

**web-generator = NOT READY** (overall verdict unchanged — identity/auth/phase blockers per §6 remain)

---

### 14.7 Next safe extraction slice

With layer-config extracted, the next candidates were evaluated:
- **cancel lifecycle** — **NOT READY** (see §15)
- **SSE orchestration** — the most promising remaining candidate

---

*Step-5 layer-config extraction completed on this branch; package created, host wired, all tests pass.*

---

## 15. Step 6 — Generation Cancel / Session Teardown Audit

**Status:** NOT READY — audit-only, no extraction  
**Date:** 2026-09-14  
**Branch:** `c21.4-physically-extract-analysis-from-backend`  
**Baseline commit:** `1809f554` (Step 5 complete — layer-config extracted)  
**Purpose:** Evaluate whether cancel/teardown lifecycle can be extracted through GenerationPorts.

---

### 15.1 Cancel/teardown inventory

| Function | LOC | Exported | External consumers |
|---|---|---|---|
| `cancelGeneration()` | 28 | yes | GeneratePage |
| `cancelTask(type, taskId?)` | 16 | yes | GeneratePage |
| `stopGenerationSession()` | 7 | yes | fileAdapters (via GenerationResetSeam) |
| `stopProgressStream()` | 4 | yes (but no external imports) | internal only |
| `stopTimer()` | 3 | no | internal only |
| `bumpVBookPollToken()` | 1 | yes | fileAdapters (via GenerationResetSeam) |
| `resetProgressState()` | 2 | yes | fileAdapters, SettingsPage |
| `setRegenerating(v)` | 1 | yes | fileAdapters (via GenerationResetSeam) |
| `markImportIncomplete()` | 1 | yes | fileAdapters (via GenerationResetSeam) |

---

### 15.2 Module-scope state dependencies

Every stop/bump/reset function mutates module-scope state owned by generateStore:

| State | Type | Mutated by | Why it blocks extraction |
|---|---|---|---|
| `sseController` | `AbortController \| null` | `stopProgressStream`, `startProgressStream` | Host resource — package can't own |
| `sseEpoch` | `number` | `stopProgressStream`, `startProgressStream` | Monotonic guard — host-owned |
| `vbookPollToken` | `number` | `cancelGeneration`, `cancelTask`, `stopGenerationSession`, `bumpVBookPollToken` | Cancellation token — host-owned |
| `progressTracking` | `ProgressTrackingState` | `resetProgressState`, `markImportIncomplete` | Host-owned state object |
| `generationTimer` | `GenerationTimerState` | `stopTimer` | Host-owned state object |

Extracting would require passing **5 mutable state objects** as port parameters. The package would become a thin orchestrator calling back into host-owned state — adding indirection without simplifying.

---

### 15.3 Cancel sequence analysis

**`cancelGeneration()` — 13 distinct operations:**
1. Read `bookId.value` (identity)
2. `setGenerationStatus('IDLE')` (host signal write)
3. `progressTracking.newGenerationPending = false` (host state mutation)
4. `stopTimer()` → `stopGenerationTimer(generationTimer)` (host state mutation)
5. `stopProgressStream()` → `sseEpoch++`, `sseController.abort()` (host resource)
6. `resetProgressState()` → `resetProgressTracking(progressTracking)` (host state mutation)
7. `vbookPollToken++` (host module-scope mutation)
8. `resetAnalysisProgress()` → `vbookAnalysisProgress.value = createInitialAnalysisProgress()` (host signal write)
9. `postJson(...)` (transport)
10. `isRegenerating.value = false` (host signal write)
11. `phase.value = 'IDLE'` (host signal write — dual-writer with fileStore)
12. `errorMessage.value = null` (host signal write — dual-writer with fileStore)
13. `if (hasAnyProgress()) await applyGenerationResults()` (bridges to navigation + playback)

Of 13 operations, **11 are direct host state mutations or resource management**. Only 1 is transport (the API call). The remaining 1 is the `applyGenerationResults` bridge which crosses into navigation + playback.

---

### 15.4 `applyGenerationResults` in cancel path

`cancelGeneration` calls `applyGenerationResults()` at the end (line 792–794) when there's any in-flight progress. This function:
- Fetches `GET /book/:id` → BookData
- Extracts sceneRefs
- Checks position and anchors if empty
- Emits `playbackPrepared`

This bridges generation → navigation → playback — the same boundary identified in Step 4 §13.4. It cannot be extracted without the navigation + playback ports AND the position-anchoring logic.

---

### 15.5 `cancelTask` analysis

`cancelTask` is simpler (16 LOC):
- Reads `bookId.value`
- If `type === 'vbook'`: clears VBook progress, bumps poll token
- Calls `postJson(...)` to cancel the worker

But it still mutates host state (`clearVBookProgress`, `vbookPollToken++`). The vbook branch adds conditional logic tied to host-owned signals.

---

### 15.6 Extraction verdict: why NOT READY

| Blocker | Severity | Explanation |
|---|---|---|
| **Module-scope state** | **critical** | 5 host-owned mutable state objects must be passed as parameters — the package becomes a thin wrapper calling back into host state |
| **applyGenerationResults bridge** | **critical** | cancelGeneration ends by bridging to navigation + playback — can't extract without extracting those boundaries too |
| **phase/errorMessage dual-writer** | **moderate** | cancelGeneration writes `phase = 'IDLE'` and `errorMessage = null` — these signals are shared with fileStore |
| **11/13 operations are host mutations** | **structural** | The function is本质上 a host-side state teardown sequence with 1 API call — not logic that benefits from extraction |
| **No new capability unlocked** | **design** | Unlike layer-config (which isolates a read/write API concern), cancel is pure state cleanup — extraction adds indirection without simplifying |

---

### 15.7 What would make cancel extraction READY

1. **Move SSE resources to an explicit state object** (like `ProgressTrackingState`): `SseStreamState { controller, epoch }` owned by host, passed to package
2. **Move poll token to an explicit state object**: `PollState { token }` owned by host
3. **Remove applyGenerationResults from cancel path**: host calls it after package returns
4. **Split cancel into "request" (API) and "teardown" (state)**: package handles the API call, host handles the state resets

Steps 1–2 are mechanical but change the host's internal structure. Step 3 changes behavior (the applyGenerationResults call would move to the caller). Step 4 is the cleanest path but requires rethinking the cancel flow.

---

### 15.8 Recommendation

**Skip cancel extraction.** The cost (5 state objects + host refactoring) outweighs the benefit (removing ~50 LOC of straightforward sequential calls from generateStore).

**Next best candidate: SSE orchestration** — the stream lifecycle (start/stop/reconnect) has a cleaner boundary: host owns the `AbortController` + reconnect loop, package routes events through `@animastor/web-generator`. The SSE port is already designed in Step 4 §13.5. This would extract ~60 LOC with a cleaner port boundary.

---

### 15.9 Verdict

**generation-cancel/session-teardown = NOT READY** (5 blockers, all structural)

**web-generator = NOT READY** (identity/auth/phase blockers unchanged; cancel adds 5 new module-scope state blockers)

---

*Step-6 cancel/teardown audit completed on this branch; no extraction, no code changes, no behavior modified.*

---

## 16. Step-7 — SSE Orchestration Extraction (DONE)

**Packages created:**
- `packages/animastor-web-generator-sse/` — `runSseStream` + `handleProgressEvent` + types

**Boundary:**
- Package imports ONLY `@animastor/web-generator` (for `routeProgressEvent`, `ProgressEventSink`, `ProgressTrackingState`)
- Host owns: `AbortController`, `sseEpoch`, `sseController`, `progressEventSink`, `progressTracking`
- Package owns: reconnect loop, epoch checking, event routing via domain

**Host wiring:**
- `generateStore.ts` creates a `SseStreamPort` adapter wrapping `sse()` from `api/client`
- `startProgressStream` delegates to `runSseStream(port, getEpoch, sink, tracking, bookId)`
- `stopProgressStream` bumps epoch + aborts controller (same as before)
- Dead `handleProgressEvent` wrapper + unused `routeProgressEvent` import removed

**Test results:**
- Package: 17 tests (11 SSE + 6 guard) — all pass
- Frontend: 124 tests — all pass
- Typecheck: clean

**What was extracted:** ~60 LOC of reconnect loop, epoch-guarded iteration, and backoff logic
**What remains in host:** AbortController lifecycle, epoch counter, signal bridge, `progressEventSink` adapter

*Step-7 SSE orchestration extraction completed; package created, host wired, all tests pass.*

---

## 17. Step 8 — Remaining Orchestration Re-Audit (post SSE/cancel/layer-config)

**Status:** AUDIT ONLY — no code changes, no extraction.  
**Date:** 2026-09-14  
**Branch:** `c21.4-physically-extract-analysis-from-backend`  
**Baseline commit:** `d3403ca1` (Step 7 complete — SSE orchestration extracted + reconnect lifecycle fixed)  
**Purpose:** Inventory the remaining orchestration in `generateStore.ts` (852 LOC at this HEAD) and determine the next physically extractable production slice. Prior sections §12–§16 verdicts re-verified against actual HEAD code where stale.

---

### 17.1 generateStore.ts remaining inventory (852 LOC, at `d3403ca1`)

| Lines | Block | Status | Notes |
|---|---|---|---|
| 23–59 | Imports + types | host | re-exports from packages |
| 61–207 | Identity (signals, playback bus, nav-icon status, persistence, stash/restore, dirtySummary) | host (permanent) | §12.2 blockers unchanged: auth edge, 10+ consumers, localStorage |
| 209–306 | File-slice seams + phase/errorMessage + generate-screen signals + analysis re-exports | host (permanent) | §12.2: dual-writer + fileStore SessionSeam contract |
| 312–377 | Layer config | **EXTRACTED (§14)** | thin host wrappers over `@animastor/web-generator-config` |
| 379–412 | Timer + progress-tracking state objects | host (thin) | state objects owned host-side, passed into package fns — correct shape already |
| 414–452 | `computeProgressRows` host wrapper | host (thin) | binds tracking/timer/signals + finalize callbacks — port-shaped already (`ProgressRowContext`) |
| 454–494 | VBook progress: `updateVBookProgress`, `checkVBookAgentStatus`, `clearVBookProgress` | **CANDIDATE** | see §17.3 |
| 496–552 | SSE stream host wiring | **EXTRACTED (§16)** | `runSseStream` in `@animastor/web-generator-sse`; host keeps AbortController/epoch/sink |
| 554–607 | `startGeneration` | host for now | see §17.4 |
| 590–726 | `vbookPollToken` + `startVBookGeneration` + `pollVBookProgress` | **CANDIDATE** | see §17.3 |
| 728–763 | `applyGenerationResults` | host (thin adapter) | see §17.2 |
| 765–811 | `cancelGeneration` / `cancelTask` | host (permanent) | §15 verdict NOT READY re-confirmed: 11/13 ops are host state teardown |
| 813–841 | `checkAndRestoreGenerationState` | host for now | see §17.4 |

### 17.2 `applyGenerationResults` — re-verified at HEAD (lines 728–763)

Decomposition as requested:

| Part | LOC | Owner if extracted | Verdict |
|---|---|---|---|
| Guard + timer stop (`isRegenerating` read, `stopTimer`) | 2 | host callback | host state read |
| Fetch `GET /book/:id` + `sceneRefs(bookData)` | ~6 | transport port | already the shape of `@animastor/web-generator-config` fns (IdentityPort+TransportPort) |
| Zero-scenes guard + warn | 4 | orchestration | pure decision |
| Position anchoring (`position.value.chapterId` read, `navigateTo`) | 7 | **host only** | reads host-owned signal; §13.4 pin confirmed |
| `emitPlaybackPrepared` | 1 | host only | host-owned bus (§6 blocker 4) |
| Error catch + warn | 3 | orchestration | transport error |

**Verdict: NOT READY as a standalone extraction.** The extractable core is a ~10-LOC fetch+map adapter indistinguishable in shape from what `@animastor/web-generator-config` already does (bookId-scoped GET through IdentityPort+TransportPort). Physically extracting it now would create a package that is a thin adapter/wrapper around one `getJson` + `sceneRefs` call, with the two host-bound legs (position anchor + playback emit) remaining host-side. The function becomes extractable **as part of the VBook/generation-finalization slice** (§17.3), where its caller (`pollVBookProgress`) moves with it and the host wraps the result. This matches the user-issued constraint: do not extract if the outcome is only a wrapper.

### 17.3 VBook agent lifecycle — READY FOR PHYSICAL EXTRACTION (the recommended next slice)

**Scope (generateStore.ts lines 454–494 + 590–726, ~166 LOC):**

| Function | Lines | What it does | Host state read | Host state write | Transport | Navigation/playback | Store fns called | Module mutable state | Production consumers |
|---|---|---|---|---|---|---|---|---|---|
| `checkVBookAgentStatus` | 455–484 | One `/agent-status` poll + agent→progress merge + ANALYZING/CREATING_SCENES→COMPLETED finalization | `bookId`, `vbookProgress` | `vbookProgress` | `getJson` | — | `updateVBookProgress` (→ `applyAgentStatus`, already in pkg) | none | GeneratePage (1.5s poll effect, line 165) |
| `updateVBookProgress` | 450–452 | 1-line adapter to package `applyAgentStatus` | `vbookProgress` | `vbookProgress` | — | — | pkg fn | none | internal |
| `startVBookGeneration` | 593–645 | Bootstrap decision (`/book/:id/status` → bootstrap vs bootstrap-next-window), long-timeout POST, poll kick, abort reconciliation with `/agent-status` | `bookId` | `generationStatus`, `isRegenerating`, `progressTracking.newGenerationPending`, `progressTracking.importCompleteReceived`, `vbookProgress` | `getJson`, `postJsonLong` | — | `startTimer`, `startProgressStream`, `pollVBookProgress`, `clearVBookProgress`, `stopTimer`, `setGenerationStatus` | `vbookPollToken` (bump + compare) | GeneratePage (VBook Generate button, line 229) |
| `pollVBookProgress` | 647–726 | 2s poll loop: inactive×2 finalization, `paused` finalization with real window counter, 60min safety cap + agent re-probe, final SUCCESS + `applyGenerationResults` handoff | `vbookProgress`, `isRegenerating`, `progressTracking.importCompleteReceived`, `bookId` (param), token (param) | `vbookProgress`, `generationStatus` | `getJson` | via `applyGenerationResults` (stays host-side, see below) | `updateVBookProgress`, `setGenerationStatus`, `stopTimer`, `applyGenerationResults` | `vbookPollToken` (compare) | internal (via start) |

**Why this is the right next slice (and why the old §13.6 "VBook lifecycle: NOT READY" verdict is now stale):**

1. **Single production consumer.** Only `GeneratePage` calls `startVBookGeneration`/`checkVBookAgentStatus` — no adapter files, no fileStore seams, no other pages. (fileAdapters touches only `bumpVBookPollToken`/`stopGenerationSession`, which stay host-side as the token/cancel authority.)
2. **The SSE-coupling objection dissolved at Step 7.** §13.6 rejected VBook partly because "SSE stream is host-specific". The stream is now a package (`@animastor/web-generator-sse`) consumed through `SseStreamPort`; the extracted VBook slice receives a `startStream`-shaped callback (or the host starts the stream itself before invoking the slice — recommended).
3. **Every write has a port precedent.** `generationStatus`/`isRegenerating`/`vbookProgress` map to `GenerationStatePort`-style callbacks (§13.2); `bookId` read maps to `GenerationIdentityPort.getBookId()` — the exact pattern `@animastor/web-generator-config` already uses in production.
4. **The token cancellation design is parameterizable.** `vbookPollToken` module-let becomes a host-owned `VBookPollState { token }` object passed by reference (or a `getPollToken/bumpPollToken` pair) — same mechanics as `ProgressTrackingState`/`GenerationTimerState` in Step 1. fileAdapters' `bumpVBookPollToken` keeps its host surface, writing the same object.
5. **`applyGenerationResults` stays host-side and moves to a callback.** The slice calls an injected `onGenerationFinalized` callback (host = current `applyGenerationResults` body: fetch+sceneRefs+anchor+emit). The slice decides WHEN, the host decides WHAT happens on navigation/playback. No `positionStore`/`emitPlaybackPrepared` knowledge enters the package. This resolves §13.4's split cleanly at the VBook boundary.
6. **No reverse dependency.** The slice needs no other store function except through ports: `startTimer` → call domain `startGenerationTimer(timerState)` directly (timer state object is already passed by reference); `startProgressStream` → either a `startStream()` callback or host pre-start (recommended — host keeps AbortController/epoch entirely).
7. **Real decision logic travels.** Unlike cancel (§15: 11/13 host mutations), the VBook slice carries genuine orchestration decisions: bootstrap-vs-next-window choice, abort-vs-keep-alive reconciliation, paused/inactive×2/safety-cap terminal-state classification. This is logic worth unit-testing outside the host — not LOC-shaving.

**Port surface (no new ports needed in `generationPorts.ts` — they already exist or are slice-local):**

- `GenerationIdentityPort.getBookId()` — already designed (§13.2)
- `GenerationTransportPort` (`getJson`, `postJsonLong`) — already designed (§13.2)
- `GenerationStatePort`-shaped callbacks: `setVBookProgress`, `setGenerationStatus`, `setIsRegenerating`, `setNewGenerationPending`, `markImportIncomplete` — slice-local callback bundle (same shape as `ProgressRowContext` in `@animastor/web-generator`, precedent)
- `VBookPollState` — explicit state object (host-owned, passed by reference)
- `onGenerationFinalized` — callback; host binds to `applyGenerationResults`
- `startStream` — callback; host binds to `startProgressStream` (recommended) — or omit and require host to start before invoking

**Naming suggestion:** `@animastor/web-generator-vbook` at `packages/animastor-web-generator-vbook/`, importing only `@animastor/web-generator` (for `applyAgentStatus`, `createAnalyzingVBookProgress`, factories/types) — mirroring the `web-generator-sse → web-generator` dependency shape.

**Host keeps:** `vbookProgress` signal + `clearVBookProgress`, token authority (`bumpVBookPollToken`/`stopGenerationSession` write `VBookPollState`), timer state object ownership, SSE start/stop, `applyGenerationResults`, all seams/fileAdapters surface.

**Recommended next step (Step 9):** physically extract the VBook agent slice with the boundary above; add `vbook-contour` guard (only generateStore consumes the package; no host reach; `VBookPollState` explicit-state rule; GeneratePage surface unchanged — it keeps importing from `generateStore` re-exports).

### 17.4 Remaining slices — verdicts (not the next step)

| Slice | Verdict | Why |
|---|---|---|
| `startGeneration` (554–607) | NOT READY yet | Writes `phase`/`dirtySummary` (dual-writer/B6 cluster), calls `refreshAssetsState` (layer-config contour), but mostly: it is 20 LOC of pre-call state + one POST + result mapping. Extracting it alone = thin adapter. Becomes worthwhile only after VBook slice proves the `GenerationStatePort` mechanics, and should be extracted together with the request/result decision mapping (see below). |
| `checkAndRestoreGenerationState` (813–841) | NOT READY | Reads `/progress-panel` + `/worker/counts` and re-arms the full session (timer/SSE/status/tracking). It is a host re-composition of already-extracted parts + 2 GETs. The two GETs are trivial adapters; the rest is host state arming. |
| Nav-icon SUCCESS pulse machinery (87–148) | NOT READY (and low value) | Self-contained UI timer logic, zero transport, reads/writes only `generationStatus`. Physically extractable in principle but it is presentation-coupled (browser setTimeout/watchdog semantics pinned to Android animator parity). Extraction adds a package for 60 LOC of UI pulse — not architecturally valuable. |
| Identity/persistence/stash (§12.2) | NOT READY (unchanged) | auth edge + 10+ consumers + dual-writer — permanent host ownership. |
| Cancel/teardown (§15) | NOT READY (unchanged) | 11/13 host mutations; re-confirmed at HEAD. |
| `applyGenerationResults` standalone (§17.2) | NOT READY standalone | thin-adapter outcome; travels with the VBook slice's finalization callback instead. |

### 17.5 Re-verification of §12.3.2 "orchestration NOT READY" claim

§12.3.2 said orchestration is NOT READY because "every function reads bookId / writes 6+ signals / applyGenerationResults bridges 3 boundaries". At this HEAD that blanket claim holds only for the FULL orchestration contour. The Step 5/7 extractions proved it slice-by-slice false: layer-config (transport-only), SSE (lifecycle-only) are out; VBook (§17.3) is the next slice where the identity/state reads are all port-representable and the navigation/playback bridge is isolated to one host-side callback. The audit's model — host provides capabilities through ports, package returns domain decisions — is now concretely satisfiable for VBook.

### 17.6 Guard/verification status at this HEAD

- `generation-ports.guard.test.ts` + `generation-progress-contour.guard.test.ts` — 19/19 pass (verified during this audit)
- `web-generator-sse` package — 17 tests pass (Step 7 record)
- Consumers re-verified by grep: VBook slice surface = GeneratePage only; `bumpVBookPollToken` = fileAdapters only; no test files touch VBook fns (no test-mock surface to migrate)

### 17.7 Verdict

**VBook agent lifecycle (`checkVBookAgentStatus` + `startVBookGeneration` + `pollVBookProgress` + `updateVBookProgress`): READY FOR PHYSICAL EXTRACTION** — single consumer, port-complete, decision-rich, no reverse deps, `applyGenerationResults` stays host-side behind an `onGenerationFinalized` callback.

**`applyGenerationResults` standalone: NOT READY** — extraction yields only a thin fetch/sceneRefs adapter; its host legs (position anchor, playback emit) are the majority of its logic.

**`startGeneration` / `checkAndRestoreGenerationState` / cancel / identity / nav-pulse: NOT READY** (thin adapters or host state re-composition; unchanged from §12/§15).

**Overall `@animastor/web-generator` full extraction: NOT READY** (identity/auth/phase blockers permanent until a session design exists — §6).

**Recommended next step (Step 9):** extract `@animastor/web-generator-vbook` per §17.3 boundary.

---

*Step-8 audit completed on this branch; no code changes, no packages created, no behavior modified. Only this document updated.*
