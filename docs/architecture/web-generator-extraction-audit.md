# Web Generator — Extraction Audit (Re-verification)

**Status:** Step-13 re-audit complete: NO NEXT PHYSICAL EXTRACTION YET (§22); Step-12 identity PHYSICALLY EXTRACTED — `@animastor/web-book-session` created at `packages/animastor-web-book-session/`, verdict PHYSICALLY EXTRACTED / READY (§21); Step-11 identity module preparation EXECUTED (§20); Step-10 identity/session re-audit verdict PREPARATION REQUIRED (§19); Step-9 VBook agent lifecycle extraction COMPLETED — `@animastor/web-generator-vbook` PHYSICALLY EXTRACTED / READY (see §18)  
**Date:** 2026-09-14  
**Branch:** `c21.4-physically-extract-analysis-from-backend`  
**Baseline commit:** `d3403ca1` ("docs(web): align SSE reconnect lifecycle comments" — Step 7 complete; Step-8 re-audit base)  
**Step-9 baseline commit:** `8fa60273` ("docs(web): align extraction audit header" — Step 8 audit complete)  
**Original re-verification baseline:** `066ddaae` ("arch(orchestration): physically extract orchestration package")  
**Step-1 change:** in-repo `generation-progress` domain module extracted (see §9) — **no package created**  
**Step-2 change:** physical package `@animastor/web-generator` created at `packages/animastor-web-generator/` (see §11); old in-repo contour deleted  
**Step-5 change:** physical package `@animastor/web-generator-config` created (see §14)  
**Step-7 change:** physical package `@animastor/web-generator-sse` created (see §16)  
**Step-9 change:** physical package `@animastor/web-generator-vbook` created at `packages/animastor-web-generator-vbook/` (see §18); VBook orchestration deleted from generateStore  
**Step-10 change:** identity/session boundary re-audited post-Step-9 (§19) — verdict PREPARATION REQUIRED; recommended prep step: in-repo identity module split before any `web-book-session` package cut  
**Step-11 change:** prep step P1 EXECUTED (§20) — identity contour physically moved to in-repo `state/bookSession.ts`; generateStore re-exports 1:1; package cut is now mechanical  
**Step-12 change:** physical package `@animastor/web-book-session` created at `packages/animastor-web-book-session/` (see §21); the in-repo `state/bookSession.ts` contour deleted; identity verdict PHYSICALLY EXTRACTED / READY  
**Step-13 change:** post-identity re-audit of the remaining host contour (§22) — no new extraction boundary found; overall verdict remains NOT READY; GenerationPorts verdict KEEP; next candidate: NONE ("NO NEXT PHYSICAL EXTRACTION YET")  
**Target package:** `@animastor/web-generator`  
**Target location:** `packages/animastor-web-generator/` (CREATED — physical extraction completed)  
**Re-verification of:** `web-next-extraction-reconnaissance.md` (§3.1, verdict "NOT READY")  
**Context:** Verdict re-checked at current HEAD through Step 10 (§19) — after the generation-progress (Step 2), layer-config (Step 5), SSE orchestration (Step 7), and VBook agent lifecycle (Step 9) extractions.

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

**Status:** AUDIT ONLY — no code changes, no extraction. **Step 9 (VBook extraction per §17.3) is now EXECUTED — see §18.**  
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

---

## 18. Step 9 — VBook Agent Lifecycle Extraction (DONE)

**Status:** PHYSICALLY EXTRACTED / READY  
**Date:** 2026-09-14  
**Branch:** `c21.4-physically-extract-analysis-from-backend`  
**Baseline commit:** `8fa60273` (Step 8 audit complete — VBook slice identified as READY)  
**Purpose:** Physically extract the VBook agent lifecycle (`checkVBookAgentStatus` + `startVBookGeneration` + `pollVBookProgress` + `updateVBookProgress`, ~166 LOC of generateStore) into `@animastor/web-generator-vbook`, per the §17.3 boundary.

### 18.1 Package: `@animastor/web-generator-vbook`

**Location:** `packages/animastor-web-generator-vbook/`

```
packages/animastor-web-generator-vbook/
├── package.json        # @animastor/web-generator-vbook 0.1.0 (dep: @animastor/web-generator file:)
├── tsconfig.json       # pure TS (no JSX)
├── tsup.config.ts      # ESM + dts
├── vitest.config.ts    # happy-dom
├── LICENSE             # MIT
├── src/
│   ├── index.ts        # lifecycle + ports + explicit VBookPollState (no README yet — mirrors sse package shape)
│   └── models.ts       # vendored wire types (AgentStatusWire, BookStatusWire)
└── test/
    ├── vbook.test.ts   # 24 unit tests (mocked ports, zero host imports)
    └── guard.test.ts   # 16 architecture guard assertions
```

**What was extracted (REAL orchestration logic, not a wrapper):**

| Function (package export) | Origin (generateStore) | Decision logic that traveled |
|---|---|---|
| `checkAgentStatus(ports)` | `checkVBookAgentStatus` (lines 455–484) | one `/agent-status` poll; active-with-message merge vs inactive-finalize classification (ANALYZING/CREATING_SCENES→COMPLETED with real window counters); transport-error tolerance |
| `updateVBookProgress(state, status)` | `updateVBookProgress` (450–452) | agent→progress merge (delegates the pure mapping to web-generator's `applyAgentStatus`, writes via callback) |
| `startVBookGeneration(ports, config?)` | `startVBookGeneration` (593–645) | bootstrap-vs-bootstrap-next-window decision (`/book/:id/status` → `ready !== true`); long-timeout POST kick; session arming order (RUNNING, isRegenerating, newGenerationPending, ANALYZING, timer, stream, import-latch reset); abort reconciliation (active/paused agent → keep polling; genuinely dead → teardown); stale-token abort |
| `pollVBookProgress(ports, bookId, token, config?)` | `pollVBookProgress` (647–726) | 2s loop; import-handshake finalization; `paused` window finalization with real counter; inactive×2 finalization; transient-error continuation; 60min safety cap + agent re-probe (still-active → leave alive); SUCCESS + conditional timer stop + `onGenerationFinalized` handoff; stale-token exit at every checkpoint |

**Port surface (slice-local — no changes to `generationPorts.ts`):**

- `VBookIdentityPort.getBookId()` — the only identity access
- `VBookTransportPort` — `getJson` (agent-status/book status) + `postJsonLong` (blocking bootstrap routes); NO direct api/client
- `VBookPollState` / `VBookPollContract` — explicit poll state (replaces module-global `vbookPollToken`); host-owned, passed by reference/callback
- `VBookHostState` — get/set VBookProgress, setGenerationStatus, get/set isRegenerating, setNewGenerationPending, get/set importCompleteReceived
- `VBookLifecycleCallbacks` — `startTimer`, `stopTimer`, `startStream(bookId)` (host's `startProgressStream` — SSE NOT re-implemented), `onVBookCleared`, **`onGenerationFinalized()`** (host binds to `applyGenerationResults`)
- `VBookPollConfig` — injectable tuning (poll/error intervals, maxInactive, maxPollMs)

### 18.2 Host boundary after extraction

**Host-owned (unchanged, `state/generateStore.ts` 852 → 740 LOC):**
- `vbookProgress` signal (+ `clearVBookProgress` seam)
- Poll-token authority: explicit `vbookPollState = createVBookPollState()`; `bumpVBookPollToken`/`stopGenerationSession`/`cancelGeneration`/`cancelTask` write it
- Timer ownership (`generationTimer` instance; `startTimer`/`stopTimer` wrappers)
- SSE AbortController/epoch lifecycle (`startProgressStream`/`stopProgressStream` + `@animastor/web-generator-sse`)
- **`applyGenerationResults()` — stays host-side entirely** (fetch/extract final book state, position/anchor check, `navigateTo`, `emitPlaybackPrepared`); the package calls it only via the injected `onGenerationFinalized`
- All fileAdapters seams, identity/auth/phase cluster (unchanged blockers §6)
- `computeProgressRows` wrapper (unchanged)

**Host wiring:** `vbookAgentPorts: VBookAgentPorts` — a pure composition object (identity getter, `{getJson, postJsonLong}`, poll contract over `vbookPollState`, signal-bound state callbacks, lifecycle hooks). `checkVBookAgentStatus`/`startVBookGeneration` remain exported from generateStore as one-line delegations — GeneratePage and every other consumer are untouched.

### 18.3 Dependency direction (verified)

```
frontends/app (generateStore)
  → @animastor/web-generator-vbook → @animastor/web-generator
  → @animastor/web-generator-sse   → @animastor/web-generator
  → @animastor/web-generator-config
```

- Package imports ONLY `@animastor/web-generator` (applyAgentStatus, createAnalyzingVBookProgress, types) — mirrors the sse→generator shape
- Forbidden and verified absent: generateStore, api/client, authStore, fileStore, playbackStore, positionStore, app/*, pages/*, `@preact/signals`, other `@animastor/*`
- No module-global mutable state in the package (`let`-scan guard); the poll token is explicit
- No SSE implementation inside the package (guard: no AsyncIterable/reconnect/backoff) — stream initiation is the injected `startStream` callback
- Production consumer count: exactly 1 (generateStore; via root entry only — no deep imports)
- No reverse dependency (web-generator does not import web-generator-vbook)
- GeneratePage public surface unchanged (still imports from generateStore)

### 18.4 Tests and guards

| Suite | Tests | Status |
|---|---|---|
| `packages/…-vbook/test/vbook.test.ts` (unit: agent status success/error, progress update, generation request/bootstrap choice, polling success/continuation/error, stale poll/session cancellation, successful finalization, onGenerationFinalized callback, teardown reconciliation) | 24 | PASS |
| `packages/…-vbook/test/guard.test.ts` (forbidden imports, dependency direction, no signals, no module-global mutable state, explicit polling state, no SSE dup, transport-only-via-port) | 16 | PASS |
| `frontends/app/src/architecture/vbook-contour.guard.test.ts` (NEW: root-only consumption, single production consumer, test-mock discipline, host ownership tokens, applyGenerationResults host-side, no duplicate implementation tokens, explicit poll state, no reverse deps, GeneratePage surface) | 13 | PASS |
| `frontends/app/` (all suites incl. generateStore.analysis, fileStore, auth-book-session, existing guards) | 137 | PASS |
| web-generator / web-generator-sse / web-generator-config packages | 69 + 16 + 22 | PASS |

Typecheck: clean (package + frontend). Build: vite green (405 KB JS bundle). No new dependency cycles (grep-verified both directions).

### 18.5 Deviations / notes

- `generateStore.analysis.test.ts` mock of `../api/client` gained `postJsonLong` (the host ports composition now references it at module scope) — mock-surface addition only, no behavior change.
- Host `stopGenerationSession`/`bumpVBookPollToken`/`cancelTask`/`cancelGeneration` now bump `vbookPollState.token` (explicit object) instead of the old module-let — identical semantics for the poller (token compare), and fileAdapters seams are untouched.
- Package `pollVBookProgress` accepts `VBookPollConfig` (injectable intervals) — production call sites use the defaults (2s/3s/×2/60min), preserving existing behavior exactly.
- The four lifecycle functions ARE all extracted — no wrapper-only outcome; the blocker clause (§17 instruction 16) was not triggered.

### 18.6 Verdict

**VBook agent lifecycle: PHYSICALLY EXTRACTED / READY.** The real orchestration decisions live in `@animastor/web-generator-vbook`; generateStore keeps only capability composition + host-owned state application.

**Remaining generateStore slices (re-confirmed from §17.4):**
- `startGeneration` — NOT READY alone (thin adapter; 20 LOC pre-call state + POST + result mapping; writes the dual-writer `phase`/`dirtySummary` cluster)
- `checkAndRestoreGenerationState` — NOT READY (host re-composition of already-extracted parts + 2 GETs)
- `cancelGeneration`/`cancelTask` — NOT READY (§15: 11/13 host mutations)
- Nav-icon SUCCESS pulse — NOT READY/low value (UI-coupled)
- Identity/auth/phase cluster — NOT READY (permanent until a session design exists, §6)

**Overall `@animastor/web-generator` full extraction: NOT READY** — the remaining contour is host-owned state application (identity, phase/errorMessage dual-writer, session teardown, restore re-arming) with no further decision-rich, single-consumer slice. The next blocker for any further extraction is the **identity/session split** (§6, Steps 2–3 of the minimal preparation sequence) — everything short of it is now extracted.

---

*Step-9 VBook agent lifecycle extraction completed on this branch; package created, host wired, old implementation deleted, all tests/guards/typecheck/build green.*

---

## 19. Step 10 — Identity / Session Boundary Re-Audit (post VBook extraction)

**Status:** AUDIT ONLY — no code changes, no extraction.  
**Date:** 2026-09-14  
**Branch:** `c21.4-physically-extract-analysis-from-backend`  
**Baseline commit:** `913e0d0d` ("refactor(web): extract VBook agent lifecycle" — Step 9 complete)  
**Purpose:** Re-verify the last remaining `web-generator` blocker (identity/session ownership) against actual HEAD code after Step 9 physically removed the VBook lifecycle from generateStore. All prior claims (§3.2, §12.2, §17.4) re-derived from current source, not carried over.

**What changed after Step 9 (verified):**
1. generateStore is now 740 LOC of pure host composition — every decision-rich orchestration slice (progress, layer-config, SSE reconnect, VBook agent flow) is in a package. Identity/session + phase/errorMessage + seams is what REMAINS.
2. The `onGenerationFinalized` seam (§18) confirmed the §17.3 prediction: `applyGenerationResults` is now invoked from exactly one package seam plus the cancel path — its boundary did NOT get cleaner (see §19.7); still host-side.
3. Identity blocker blast radius UNCHANGED by Step 9: same 10 direct production consumers, same auth edge, same dual-writer. No consumer of identity moved or disappeared.
4. NEW datum: three extracted packages now reach identity only through injected `getBookId()`-shaped ports (`web-generator-config` IdentityPort, `web-generator-vbook` VBookIdentityPort). The package-side precedent for an identity read-port is proven in production — this materially lowers the risk of prep step P1 (§19.8).

### 19.1 Identity inventory (readers / writers / callers / dependencies)

| Capability | Defined | Writers | Readers / callers (production) | Store/module deps | API calls | Lifecycle assumptions | Portable via port? | Multiple writers? | Hidden coupling |
|---|---|---|---|---|---|---|---|---|---|
| `bookId` signal | generateStore:64 | `loadBook` only (single write path) | GeneratePage, EditPage, AiAssistantPage, SettingsPage, AppShell, main.tsx, playerAdapters, navigatorAdapters, fileAdapters (SessionSeam ×2), authStore (indirect via stash), generateStore internals | `@preact/signals`; persistence side-effect via loadBook | none directly | empty string = no book; set before any generation/open flow | Read-port yes (proven pattern); signal itself host-owned | No (1 writer fn; stash calls loadBook('', '')) | none found — reads are point-in-time |
| `buildId` signal | generateStore:65 | `loadBook` AND `startGeneration` (res.build_id) — **2 distinct writers** | EditPage, playerAdapters, navigatorAdapters, fileAdapters (SessionSeam), AppShell (via fileAdapters), generateStore internals | `@preact/signals` | written from `/book/:id/regenerate` response | empty = no build yet; NOT persisted-check key; stale after reload until next generation | Partially — see §19.4 | **Yes (2 writers)** | generation-owned: only startGeneration assigns a NEW build id |
| `loadBook(id, build)` | generateStore:207 | — | fileAdapters (wires SessionSeam), fileStore flows ×7 call sites (import/open/close/create/restore), stashBookSessionForUser | writes bookId+buildId, persists or clears localStorage | none | the ONLY sanctioned identity mutator; '' clears | No — mutator must stay with the signals | n/a | persisted-session write path is inseparable from it |
| `persistBookSession` / `clearBookSession` | generateStore:164–171 | loadBook (indirect) | — | `localStorage['animastor:currentBook']` | none | survives reload; try/catch tolerated | Yes (storage port) but see §19.3 | No | key literal duplicated in fileStore.ts:361 (READ-ONLY, sync comment) |
| `restoreBookSession` | fileStore.ts:227 | calls `session.loadBook` ×4 | main.tsx:37 (boot) + main.tsx:81 (post-login effect) | fileStore seams; reads localStorage key directly (declared read-only) | `GET /book/:id/status`, `GET /books`, `GET /book/:id` | boot-time, races deep-link/import (double-checks `session.bookId.value`) | No — File-flow logic + transport + navigation | No | localStorage read duplicated with a sync contract, not a fork |
| `stashBookSessionForUser` | generateStore:185 | authStore.logout (sole caller) | authStore:76 | localStorage live key + `:user:<uid>` stash key; calls loadBook('','') | none | logout must not leak session into guest context | Technically yes (pure storage fn) but see §19.3 | No | the auth→identity hard edge (§3.2 blocker 2) |
| `restoreStashedBookSessionForUser` | generateStore:198 | authStore.login (sole caller) | authStore:37 | localStorage live key + stash key | none | never clobbers a live session | Same as above | No | same auth edge |
| localStorage ownership | generateStore (write path) + fileStore (read-only restore read) + authStore (zero direct access) | loadBook, stash, restore-stash | restoreBookSession (fileStore) | `animastor:currentBook`, `animastor:currentBook:user:<uid>` | none | key contract documented + test-pinned | See §19.3 | **Yes (3 modules touch the key)** | the ONLY cross-module shared-mutable-state outside signals |
| book/session validation | fileStore.restoreBookSession | — | main.tsx | transport + identity seam | status/books/book GETs | server is validation truth; localStorage is only a hint | No — belongs with restore flow | No | — |

**Identity inventory verdict:** single-writer identity core (`bookId`/`loadBook`/persistence) is port-shaped and prep-able; the un-portable remainder is the auth stash pair (host lifecycle) and restoreBookSession (File-flow logic already in the right owner).

### 19.2 phase / errorMessage inventory

| Aspect | `phase` | `errorMessage` |
|---|---|---|
| Defined | generateStore:272 (`signal<PlayerPhase>`) | generateStore:274 |
| Writers | fileStore via SessionSeam ×10 sites (LOADING_BOOK/IMPORTING_TXT/SCENE_READY/IDLE) + generateStore ×3 sites (SCENE_READY startGeneration:602, IDLE cancelGeneration:673, GENERATING checkAndRestore:721) | fileStore ×4 sites (set on import/open/create failure, clear on begin/close) + generateStore ×1 site (cancelGeneration:674) |
| Readers | AppShell:14 (desktop bounce mirror — `playerPhase.value === 'SCENE_READY'` fallback), GeneratePage:10 (render mirror) | fileStore error paths only; no page reads it directly |
| Classification | **NOT identity.** It is a shared cross-slice session-status concern: its value union spans the File lifecycle (LOADING_BOOK, IMPORTING_TXT) and the generation lifecycle (GENERATING). Neither slice owns the union. | Same — an error channel shared by both slices |
| Dual-writer blocker? | Yes, still (audit B6 unchanged) — 2 writers across 2 modules, 14 write sites total | Yes, still — 2 writers, 5 write sites |
| Separable from identity? | **Yes — conceptually independent.** No identity function reads or writes phase; the coupling is purely co-location in generateStore since the B1 split. | Same |
| Minimal seam for future extraction | A `SessionStatusPort` (setPhase/setErrorMessage callbacks) wired to host signals — fileStore already models this shape as the `phase`/`errorMessage` fields of SessionSeam; generation slice would adopt the same pattern. No generationPorts change needed (constraint respected). | Same seam |
| Verdict | Separate shared session-state concern — a candidate `@animastor/web-session-status` slice ONLY AFTER identity lands; extracting it first just moves the co-location problem | Same |

**phase/errorMessage verdict:** they are NOT part of the identity/session boundary; they are an independent dual-writer blocker. They do not block the identity prep step (P1) and should not be bundled into an identity package (that would grow the blast radius for no ownership gain).

### 19.3 localStorage — can persistence be physically extracted?

| Operation | Current location | Owner candidate |
|---|---|---|
| current book key (`animastor:currentBook`) | generateStore:157 (constant) + fileStore.ts:361 (duplicate, read-only, sync-comment contract) | identity module |
| user stash key (`animastor:currentBook:user:<uid>`) | generateStore:182 | identity module |
| save (`persistBookSession`) | generateStore:164 | identity module |
| clear (`clearBookSession`) | generateStore:169 | identity module |
| restore (cold-start, server-validated) | fileStore.restoreBookSession:227 | **stays with File flows** — it is transport + navigation + playback-warming logic, not persistence |
| login/logout isolation (stash/restore-stash) | generateStore:185/198, called by authStore | **stays host-side** — auth lifecycle ownership (§19.5) |

**Assessment:** A storage-port extraction of just save/clear/keys WITHOUT the auth lifecycle yields a package of ~25 LOC with 2 call sites (loadBook + stash pair) that immediately need the auth edge injected back in as a port. That is a wrapper, not a boundary — **NOT READY** as a standalone cut. localStorage extraction is only meaningful as part of a full identity/session module (candidate A) where persistence, signals, loadBook, and the stash contract travel together.

### 19.4 buildId — identity or generation-owned?

Traced at HEAD:

| Question | Answer |
|---|---|
| Where created | `loadBook(bId, build)` param — set by fileStore flows from `bookData.manifest.build_id` / import response; AND `startGeneration` (generateStore:601) assigning `res.build_id` from the regenerate response |
| Where modified | Only those 2 writers (verified by grep: `buildId.value =` has exactly 2 sites) |
| Where read | EditPage (5 sites — reload/dirty flows), playerAdapters + navigatorAdapters (ports), fileAdapters SessionSeam, applyGenerationResults (playbackPrepared payload), restoreBookSession |
| Persistence owner | **None of its own.** Persisted only as part of the `{id, build}` JSON blob written by loadBook — buildId has no independent persistence lifecycle |
| Used outside generation | Yes — Edit/player/navigator consume it for cache keys and content-addressed reloads |
| Needed by a future identity package? | **Only partially.** Its READ side belongs with book identity (consumers treat `bookId+buildId` as one session tuple — SessionSeam already models them together). Its WRITE side (regenerate response assignment) is generation-owned |

**Verdict: buildId is a hybrid.** NOT auto-mergeable with bookId: it has a second writer inside generation (startGeneration) and no independent persistence. The correct treatment: identity package owns the signal + read port + persistence blob; generation keeps writing through a `setBuildId` callback (already shaped as `GenerationStatePort.setBuildId` in generationPorts.ts §13.2). This keeps both writers intact with no source-of-truth fork.

### 19.5 GenerationPorts coverage check (§13.2 vs current needs)

| Identity/session capability | Covered by existing ports? | Gap |
|---|---|---|
| bookId read | Yes — `GenerationIdentityPort.getBookId()` (proven by 2 packages in production) | — |
| buildId read | Yes — `getBuildId()` | — |
| buildId write (startGeneration) | Yes — `GenerationStatePort.setBuildId` | — |
| loadBook (identity mutation) | **No — and should NOT be added.** Mutation stays host-owned (§13.1.1); a port would invite packages to fork identity | intentional |
| persist/clear session | No | storage port only needed INSIDE the identity module (§19.3) — not in generationPorts |
| stash/restore-stash | No | auth-owned; belongs to a session contract, not GenerationPorts |
| restoreBookSession | No | File-flow-owned; already behind SessionSeam |
| phase/errorMessage write | Yes — `GenerationStatePort.setPhase/setErrorMessage` | — |

**Verdict: no new generationPorts.ts interfaces are required** for the identity boundary. The existing 8 ports are correctly scoped. Adding loadBook/stash ports would turn GenerationPorts into the giant ambient interface the Step-4 design explicitly forbids. If identity is extracted, it gets its OWN contract file (e.g. `BookSessionPorts` inside the new module) — consistent with how web-generator-vbook defined slice-local `VBookAgentPorts` rather than extending generationPorts.

### 19.6 Candidate extraction boundaries

| Variant | What leaves | What stays host | Ports needed | Consumers to migrate | Production consumer count | Reverse-dep risk | Verdict |
|---|---|---|---|---|---|---|---|
| **A. `@animastor/web-book-session`** (identity signals + loadBook + persistence + stash pair + buildId signal) | ~70 LOC of generateStore identity block | restoreBookSession (fileStore), authStore, phase/errorMessage, all seams | BookSessionPorts (storage + auth hooks) — separate contract | ALL 10 direct consumers switch to package entry or adapters; authStore switches to adapter | 10 direct + 3 package adapters + authStore | LOW if host adapters re-export the same signals (by-reference identity preserved); HIGH if consumers bind values directly | REAL improvement — but only after P1 prep; direct cut today is a host-wide refactor |
| **B. `@animastor/web-book-identity`** (bookId/buildId signals + loadBook only; persistence and stash stay host) | ~15 LOC | persistence, stash, auth edge | none beyond read ports | same 10 consumers | 10 + adapters | same as A but splits the identity module's cohesion in half — persistence and loadBook are inseparable (loadBook IS the persistence write path) | REJECTED: thin wrapper by construction; splits what must travel together |
| **C. `@animastor/web-session`** (persistence + stash + keys only; signals stay host) | ~25 LOC | signals, loadBook | storage port + auth port | loadBook + authStore | 2 call sites | none (host keeps everything meaningful) | REJECTED: wrapper with auth edge injected back in (§19.3); zero ownership gain |
| **D. phase/error shared session seam package** | phase/errorMessage signals | writers (fileStore + generateStore) | SessionStatusPort | AppShell, GeneratePage, fileAdapters | 2 readers, 14+5 write sites | Would fork the B6 single-source-of-truth unless both writers adopt the port simultaneously | REJECTED for now: real concern but independent of identity; smaller value than A; revisit after A |
| **E. Combination A+D** | identity + phase/error | auth, file flows | BookSessionPorts + SessionStatusPort | everything above | max blast radius | forks two contracts at once | REJECTED as one step: two independent boundaries in a single cut; violates the one-slice-per-step discipline that made Steps 5/7/9 landable |

### 19.7 applyGenerationResults — re-confirmed post Step 9

Re-verified at HEAD (generateStore:621–647):

| Part | Still host-bound? |
|---|---|
| `isRegenerating` read + stopTimer | host state |
| `GET /book/:id` + `sceneRefs` | transport — same shape as web-generator-config fns |
| zero-scenes guard | pure decision |
| position anchor (`position.value.chapterId` + `navigateTo`) | **host-only** — positionStore signal read |
| `emitPlaybackPrepared` | **host-only** — bus ownership (§6 blocker 4) |

**Status: NOT READY — unchanged by Step 9.** The `onGenerationFinalized` seam did NOT clean up its boundary: it changed WHO calls applyGenerationResults (the vbook package decides WHEN), not WHAT the function depends on (position signal + playback bus are still host legs). Callers today: computeProgressRows finalize callback, vbookAgentPorts lifecycle, cancelGeneration:676. A marginally cleaner seam now exists in theory — an `onGenerationFinalized`-style callback for the cancel path too — but that reshuffles callers without removing either host leg; extraction would still yield a thin fetch/sceneRefs adapter (§17.2 verdict re-confirmed). NOT extracting.

### 19.8 Verdict: **B — PREPARATION REQUIRED**

The identity/session slice (variant A) is real and correctly shaped, but a physical package cut today would touch all 10 direct consumers in one commit — a host-wide refactor, not a mechanical extraction. One minimal preparation step closes the gap:

**Preparation step P1 — in-repo identity module split (no package, no behavior change):**
1. Move the identity block out of generateStore into `state/bookSession.ts` (new in-repo module): `bookId`, `buildId`, `loadBook`, `persistBookSession`, `clearBookSession`, `userStashKey`, `stashBookSessionForUser`, `restoreStashedBookSessionForUser`, both localStorage key constants.
2. generateStore imports and re-exports them 1:1 — ALL 10 direct consumers, authStore, fileAdapters seams, and every guard token (`export const bookId` etc. — generation-progress-contour.guard pins those tokens in generateStore) remain untouched.
3. fileStore's read-only `BOOK_STORE_KEY` duplicate is re-pointed at the new module's exported constant (sync contract becomes a compile-time fact).
4. Add a contour guard: bookSession module imports nothing from generateStore (kills any future cycle), only generateStore + fileAdapters import it, localStorage access for book keys exists ONLY there.
5. Guard note: authStore still imports the stash pair via its generateStore import (re-export preserves the edge) — the auth→identity edge stays host-internal, one-directional, test-pinned.

**Why this unlocks variant A:** after P1 the identity slice physically exists as a dependency-clean, zero-host-reach module with exactly one consumer surface (generateStore re-export + fileAdapters wiring). The package cut becomes mechanical: move `state/bookSession.ts` → `packages/animastor-web-book-session/`, keep the re-exports. Measured against the audit's own bar (like §10's five checks): zero host reach in the moved code, no hidden state (signals are explicit), tests travel (`auth-book-session.test.ts` already tests the stash contract in isolation), no host-only dependencies (localStorage + signals only), port contracts already proven by two packages in production.

**After P1, variant A extraction spec:**
- package name: `@animastor/web-book-session` at `packages/animastor-web-book-session/`
- production entry points: `bookId`, `buildId`, `loadBook`, `stashBookSessionForUser`, `restoreStashedBookSessionForUser` (+ key constants for the host adapter)
- ports: `BookSessionStoragePort` (getItem/setItem/removeItem — injectable for tests), `BookSessionAuthHooks` (none needed inside the package — stash fns are called BY auth, not the reverse)
- host responsibilities: re-export from generateStore (consumer surface unchanged), fileAdapters SessionSeam wiring, authStore call sites (unchanged), restoreBookSession (stays in fileStore)
- dependency direction: `frontends/app → @animastor/web-book-session` only; the package imports `@preact/signals` + storage port; NO host imports
- expected consumers: generateStore (re-export), fileAdapters (SessionSeam), authStore (via generateStore re-export), test files (2)
- architecture guard: package guard (no host imports, no api/client, no app/*) + host contour guard update (identity tokens now re-exported, localStorage book-key access only in the package)

### 19.9 Blockers (current, exact)

1. **10 direct production consumers** of bookId/buildId read the signals directly (5 pages, 3 adapters, AppShell, main.tsx) — a package cut today is a host-wide refactor (resolved by P1 re-export strategy).
2. **authStore → generateStore hard edge** (stash pair import, authStore:6) — cannot move to a package without inverting auth→identity (resolved by P1: edge stays host-internal via re-export).
3. **phase/errorMessage dual-writer** (B6) — NOT an identity concern (§19.2) but still blocks the FULL web-generator verdict; must stay single-source-of-truth host-side.
4. **localStorage key contract spread across 3 modules** (generateStore write, fileStore read-only restore read, authStore indirect) — P1 step 3 collapses the constant to one definition.
5. **buildId dual-writer** (loadBook + startGeneration) — resolved by design in §19.4: signal travels, generation write goes through the existing setBuildId callback shape.
6. **restoreBookSession lives in fileStore with its own transport + navigation calls** — correctly owned; identity package must NOT absorb it (it would recreate a fileStore→identity-package reverse edge).

### 19.10 Dependency graph (identity cluster, at HEAD)

```
                    ┌──────────────────────────────────────────────┐
                    │                generateStore                  │
                    │  bookId/buildId/phase/errorMessage signals    │
                    │  loadBook + persistence + stash/restore       │
                    │  onPlaybackPrepared bus, seams, orchestration │
                    └──────┬───────────────────────────┬───────────┘
                           │ implements                │ re-export surface
              ┌────────────▼───────────┐   ┌───────────▼────────────────────┐
              │ fileAdapters (host)    │   │ 10 direct consumers:           │
              │  SessionSeam wiring    │   │  AppShell, main.tsx,           │
              │  fileStore seams       │   │  GeneratePage, EditPage,       │
              └────────────┬───────────┘   │  AiAssistantPage, SettingsPage,│
                           │ by reference  │  playerAdapters,               │
              ┌────────────▼───────────┐   │  navigatorAdapters             │
              │ fileStore              │   └────────────────────────────────┘
              │  restoreBookSession    │
              │  (reads localStorage   │
              │   key READ-ONLY)       │
              └────────────────────────┘
state/authStore ──stash/restore-stash──▶ generateStore   (hard edge, one-directional)
packages (config, vbook) ──getBookId() port──▶ host      (proven read-port pattern)
```

No cycles involving identity. The only inbound state-module edge is authStore (documented, guarded).

### 19.11 Overall status update

| Contour | Verdict |
|---|---|
| generation-progress (`@animastor/web-generator`) | PHYSICALLY EXTRACTED / READY (§11) |
| layer-config (`@animastor/web-generator-config`) | PHYSICALLY EXTRACTED / READY (§14) |
| SSE orchestration (`@animastor/web-generator-sse`) | PHYSICALLY EXTRACTED / READY (§16) |
| VBook agent lifecycle (`@animastor/web-generator-vbook`) | PHYSICALLY EXTRACTED / READY (§18) |
| **identity/session (`@animastor/web-book-session`)** | **PREPARATION REQUIRED (§19.8) — P1 in-repo split, then mechanical cut** |
| phase/error shared session seam | NOT READY (independent dual-writer concern; §19.2/§19.6-D) |
| cancel/teardown, startGeneration, checkAndRestore, nav-pulse, applyGenerationResults | NOT READY (unchanged; §15, §17.4, §19.7) |
| **web-generator full extraction** | **NOT READY** — blocked on the P1 → A sequence and the phase/error dual-writer; after P1+A the remaining host core is phase/errorMessage + seams + cancel/restore composition |

### 19.12 Recommended next step

**Step 11: execute preparation step P1** — in-repo `state/bookSession.ts` identity module split per §19.8, with the contour guard. No package, no behavior change, all 10 consumers untouched via re-exports. Then Step 12: mechanical `@animastor/web-book-session` package cut per the §19.8 spec.

---

*Step-10 identity/session boundary re-audit completed on this branch; audit-only — no production code, no packages, no behavior modified. Only this document changed.*

---

## 20. Step 11 — Identity Module Preparation (P1 EXECUTED)

**Status:** EXECUTED — in-repo identity contour created; `@animastor/web-book-session` now **READY FOR PHYSICAL EXTRACTION**. No NPM package created.  
**Date:** 2026-09-14  
**Branch:** `c21.4-physically-extract-analysis-from-backend`  
**Baseline commit:** `d34d750c` (Step 10 audit complete — verdict PREPARATION REQUIRED)  
**Purpose:** Execute the §19.8 preparation step P1 — physically move the identity core out of generateStore into a dependency-clean in-repo module so the future package cut is a file move, not an architectural redesign.

### 20.1 What was physically moved

New module: `frontends/app/src/state/bookSession.ts` — owns the ENTIRE identity contour:

| Export | Origin | Notes |
|---|---|---|
| `bookId` signal | generateStore (was line 64) | verbatim, same initial value `''` |
| `buildId` signal | generateStore (was line 65) | verbatim — ONE signal, no fork |
| `loadBook(id, build)` | generateStore (was line 207) | verbatim semantics: set signals; persist when id non-empty; clear otherwise; try/catch storage tolerance |
| `persistBookSession` / `clearBookSession` | generateStore (private) | localStorage write path — moved with loadBook (they are its only callers) |
| `userStashKey` | generateStore (private) | `` `${BOOK_STORE_KEY}:user:${uid}` `` — verbatim |
| `stashBookSessionForUser` / `restoreStashedBookSessionForUser` | generateStore (was 185/198) | verbatim bodies — the auth stash contract |
| `BOOK_STORE_KEY = 'animastor:currentBook'` | generateStore (private) + fileStore duplicate | now ONE definition; fileStore's read-only duplicate deleted |
| `readPersistedBookSession()` | NEW (replaces fileStore's inline localStorage read) | read-only view returning `PersistedBookSession \| null` (null on absent/corrupt/id-less) — identical tolerance semantics, zero write capability |
| `setGenerationBuildId(build)` | NEW controlled adapter | the second legal buildId writer (startGeneration) — replaces the direct `buildId.value = res.build_id` write |
| `PersistedBookSession` type | NEW minimal identity type | `{ id: string; build: string }` |

Module imports: `@preact/signals` ONLY. No authStore, generateStore, fileStore, api/client, app/*, pages/*, no other `@animastor/*`.

### 20.2 What stayed host-owned

| Concern | Owner | Why (per §19) |
|---|---|---|
| `phase` / `errorMessage` | generateStore (+ fileStore writes via SessionSeam) | B6 dual-writer shared session status — NOT identity (§19.2) |
| `restoreBookSession()` | fileStore | File-flow orchestration: server validation, `/books` fallback, player warming, deep-link race handling |
| `applyGenerationResults()` | generateStore | navigation/playback bridge (§19.7 re-confirmed) |
| login/logout lifecycle decisions | authStore | decides WHEN stash/restore run; identity module only performs the session persistence operation |
| dirtySummary, blankBookJustCreated, onPlaybackPrepared, generationStatus, all seams | generateStore | unchanged host surfaces |
| All orchestration (start/cancel/restore-arming/VBook/SSE/layer-config) | generateStore + the 4 packages | untouched |

### 20.3 Ownership boundaries fixed by this step

**bookId:** exactly one signal, one module, one mutator (`loadBook`). generateStore re-exports 1:1; no production file declares `const bookId = signal` outside bookSession.ts (guard-pinned).

**buildId (hybrid, per §19.4):** the signal + persistence blob are identity-owned; `startGeneration` writes the fresh `res.build_id` through the controlled `setGenerationBuildId` adapter. Still ONE signal and exactly TWO legal writers (loadBook + the adapter). The adapter intentionally does NOT re-persist — byte-for-byte parity with the pre-split direct signal write. `GenerationStatePort.setBuildId` is untouched (generationPorts.ts was NOT modified).

**auth:** authStore's import of the stash pair is UNCHANGED (`from './generateStore'`) — it consumes through the re-export, so the auth→identity edge remains one-directional and host-internal. authStore owns zero identity state and touches no session key literal. `bookSession.ts` cannot import authStore (module imports only signals — guard-pinned).

**localStorage:** the key contract has ONE definition site. generateStore lost its inline copy; fileStore's read-only duplicate was replaced by `readPersistedBookSession()` (its restore decision logic untouched). The stash-key derivation exists only in bookSession.ts.

**phase/errorMessage:** untouched and explicitly OUTSIDE the boundary (guard-pinned: no phase/errorMessage tokens in bookSession.ts).

### 20.4 Consumers — zero source changes

The re-export strategy means NO consumer file was edited: GeneratePage, EditPage, AiAssistantPage, SettingsPage, AppShell, main.tsx, playerAdapters, navigatorAdapters, fileAdapters, authStore, fileStore, and all test files import exactly the same symbols from `./generateStore` / `../state/generateStore` as before and receive THE SAME signal objects (identity by reference preserved — SessionSeam wiring identical). Only generateStore (re-exports + adapter call), fileStore (read API), the guards, and the tests changed.

### 20.5 Architecture guard (new)

`architecture/book-session-contour.guard.test.ts` — 12 assertions across 6 groups:
1. bookSession.ts owns all identity definitions (`export const bookId = signal`, loadBook, stash pair, adapter, key constant)
2. generateStore re-exports but does NOT re-declare signals/loadBook/persistence helpers
3. no production file declares a second identity signal or the `animastor:currentBook` literal
4. generateStore writes buildId ONLY via `setGenerationBuildId` (no direct `buildId.value =`)
5. identity module imports ONLY `@preact/signals` (package-cut ready; no authStore/generateStore/api/app/pages/`@animastor/*`)
6. fileStore: `readPersistedBookSession` used, `restoreBookSession` still there, no inline key, no write to the live key; stash-key derivation unique to bookSession
7. phase/errorMessage absent from the identity module; still owned by generateStore
8. authStore: consumes the pair, owns login/logout, owns no identity state, no localStorage writes, no key constants
9. no reverse deps: bookSession ↛ authStore, generateStore ↛ authStore
10. only generateStore + fileStore import bookSession among state modules (identity reaches host modules via re-exports only)
11. no module-global `let`/`var` mutable state in bookSession.ts (explicit signal ownership only)

Updated: `generation-progress-contour.guard.test.ts` — identity token pins now verify the re-export surface (`bookId, buildId, loadBook,` / `stashBookSessionForUser, restoreStashedBookSessionForUser,` / `} from './bookSession'`) instead of inline definitions; phase/errorMessage/onPlaybackPrepared/emitPlaybackPrepared pins unchanged.

### 20.6 Regression tests (new)

`state/__tests__/bookSession.test.ts` (happy-dom + real localStorage, zero store imports) — 17 tests proving pre/post-split equivalence:
- loadBook: persist with build, default-build persist, clear on empty id (signals + storage), overwrite semantics
- setGenerationBuildId: updates signal only (bookId + persisted blob untouched — pre-split parity), single-signal/no-fork
- readPersistedBookSession: present / absent / corrupt JSON / id-less blob / strictly read-only
- stash: moves live→per-user key + clears signals, removes stale stash, no-op for null userId (still clears live)
- restore-stash: re-attach when live empty (signals untouched — pre-split parity), never clobbers a live session, no-op for null

Existing suites (auth-book-session, fileStore, fileAdapters) run UNMODIFIED and cover the consumer-side parity: fileStore flows write THE shared signals, stash observes the same session, restoreBookSession parity.

### 20.7 Verification results

| Check | Result |
|---|---|
| `bookSession.test.ts` | 17/17 PASS |
| `book-session-contour.guard.test.ts` | 12/12 PASS |
| `frontends/app` full suite (incl. auth-book-session, fileStore, fileAdapters, all 7 guards) | PASS |
| `npm run typecheck` (frontend) | CLEAN |
| `npm run build` (vite) | GREEN |
| Diff vs parent `d34d750c` | audit doc + bookSession.ts + 3 test/guard files + generateStore.ts + fileStore.ts only |

### 20.8 Verdict: **READY FOR PHYSICAL EXTRACTION**

The §19.8 success criterion is met: creating `packages/animastor-web-book-session/` is now a MECHANICAL move of an existing isolated contour, not new architectural design:

| §10-style check | Status |
|---|---|
| Zero host reach in the moved code | YES — imports are `@preact/signals` only (guard-pinned) |
| No hidden state | YES — the only mutable bindings are the two exported signals; persistence is behind explicit functions |
| Tests travel | YES — `bookSession.test.ts` (17 tests) imports only the module; moves verbatim |
| No host-only dependencies | YES — localStorage + signals only; `@preact/signals` is already a direct package dep elsewhere (web-player precedent) |
| Port contracts proven | YES — no ports needed inside the package (storage is direct, same as today's host code); consumers keep the generateStore re-export surface |
| Reverse dependency | NONE — nothing in the module reaches host code; the guard freezes the import list |
| Giant host contract | NONE — the host consumes the module's own exports; no new SessionPorts abstraction was created |

Extraction shape (unchanged from §19.8 spec, now mechanical): move `state/bookSession.ts` → `packages/animastor-web-book-session/src/`, point the two import sites (generateStore, fileStore) at the package root, add the package guard. All consumer imports stay untouched (they resolve through generateStore's re-export).

Remaining blockers for FULL `@animastor/web-generator` extraction (unchanged by this step): phase/errorMessage dual-writer (B6) + the cancel/restore/applyGenerationResults host composition (§19.9 items 3/6, §15, §17.4).

---

*Step-11 identity module preparation completed on this branch; in-repo contour created, host re-wired via re-exports, behavior preserved, all tests/guards/typecheck/build green. No NPM package created.*

---

## 21. Step 12 — Physical Extraction of `@animastor/web-book-session` (DONE)

**Status:** PHYSICALLY EXTRACTED / READY — the package is the single physical owner of the book session identity; no NPM publication performed (workspace `file:` dependency, same as the other extracted packages).  
**Date:** 2026-09-14  
**Branch:** `c21.4-physically-extract-analysis-from-backend`  
**Baseline commit:** `25bd1b95` (Step 11 complete — in-repo identity contour READY)  
**Purpose:** Execute the §20.8 mechanical cut — move the existing isolated identity contour into a workspace package without re-architecture.

### 21.1 Package: `@animastor/web-book-session`

**Location:** `packages/animastor-web-book-session/`

```
packages/animastor-web-book-session/
├── package.json        # @animastor/web-book-session 0.1.0 (dep: @preact/signals ^1.3.0)
├── tsconfig.json       # pure TS (no JSX), mirrors web-generator-vbook
├── tsup.config.ts      # ESM + dts
├── vitest.config.ts    # happy-dom
├── LICENSE             # MIT
├── README.md           # owns / does-NOT-own / dependency rules
├── src/
│   └── index.ts        # the identity contour, moved VERBATIM from state/bookSession.ts
└── test/
    ├── bookSession.test.ts  # 25 unit tests (real localStorage, zero host imports)
    └── guard.test.ts        # 3 architecture guard assertions
```

**What physically lives in the package (single owner):**

| Export | Role |
|---|---|
| `bookId` / `buildId` signals | the ONE source of truth for book identity |
| `loadBook(id, build)` | the only sanctioned identity mutator (persist on non-empty id, clear on empty) |
| `persistBookSession` / `clearBookSession` (private) | the localStorage write path |
| `BOOK_STORE_KEY` | the key contract (`animastor:currentBook`) — ONE definition site |
| `userStashKey` (private) + `stashBookSessionForUser` / `restoreStashedBookSessionForUser` | per-user stash pair (`animastor:currentBook:user:<uid>`) |
| `readPersistedBookSession()` | read-only persisted-session view (fileStore's restore consumes this) |
| `setGenerationBuildId(build)` | the controlled second buildId writer |
| `PersistedBookSession` type | minimal identity type |

**Dependency direction (verified):**

```
frontends/app (generateStore, fileStore) → @animastor/web-book-session → @preact/signals
authStore → generateStore (re-export) → @animastor/web-book-session   (unchanged direction)
```

Package external imports: exactly `['@preact/signals']` (guard-pinned both inside the package and from the host guard). No host modules, no api/client, no app/*, no pages/*, no other `@animastor/*`.

### 21.2 Host boundary after extraction

**Host-owned (unchanged):** `phase`/`errorMessage` (B6 dual-writer contract, in generateStore), `restoreBookSession()` (fileStore — server validation + `/books` fallback + player warming + race handling), `applyGenerationResults()` (generateStore), auth login/logout lifecycle decisions (authStore), all generation orchestration, playback, navigation, all other seams.

**generateStore:** compatibility re-exports ONLY (`bookId`, `buildId`, `loadBook`, `stashBookSessionForUser`, `restoreStashedBookSessionForUser`, `setGenerationBuildId`, `readPersistedBookSession`, `PersistedBookSession`) + the `setGenerationBuildId(res.build_id)` adapter call in startGeneration. No signal declaration, no persistence body, no stash body, no key constant (guard-pinned).

**fileStore:** consumes `readPersistedBookSession()` from the package root; the inline localStorage read AND the read-only key duplicate are gone; `restoreBookSession` untouched.

**Consumers:** ZERO source changes — all 10 direct consumers + authStore + 2 test files still import from `./generateStore` and receive THE SAME signal objects by reference. GenerationPorts untouched.

### 21.3 Boundaries preserved (no new owners)

- **buildId hybrid:** package owns the signal; `loadBook` (identity/file flows) + `setGenerationBuildId` (generation flow) remain the only two legal writers; no direct `buildId.value =` in generateStore; the adapter does not re-persist (pre-extraction parity); `GenerationStatePort.setBuildId` untouched.
- **auth:** `authStore → generateStore (re-export) → package`; authStore keeps login/logout decisions and owns zero identity state; the package cannot import authStore (its import list is pinned to `@preact/signals` only).
- **File:** `restoreBookSession()` stays in fileStore; it reads identity ONLY through the package's public API — no second storage implementation.
- **phase/errorMessage:** NOT extracted, no SessionStatusPort created; still host-owned dual-writer signals (guard-pinned absent from the package).
- **No new module-global mutable state:** the package's only mutable bindings are the two exported signals.

### 21.4 Guards

| Guard | Assertions |
|---|---|
| `packages/animastor-web-book-session/test/guard.test.ts` (NEW) | external imports exactly `[@preact/signals]`; no host modules / api/client / other `@animastor/*`; each identity definition exists exactly ONCE; no phase/errorMessage; no restoreBookSession export; no module-global `let`/`var` |
| `frontends/app/src/architecture/book-session-package-contour.guard.test.ts` (NEW) | all 15 rules: single owner; generateStore re-exports but declares no identity signals / no persistence / no stash bodies / no key; no direct buildId write; setter-only generation writes; fileStore storage-implementation-free with restoreBookSession in place; package imports only `@preact/signals` (real fs scan of the shipped package source — no reverse dependency); auth boundary unchanged; no duplicate production identity implementation anywhere in src/; no state module consumes the package except generateStore + fileStore; no host test imports the package directly |
| `generation-progress-contour.guard.test.ts` (UPDATED) | identity token pins now verify the re-export surface from `@animastor/web-book-session` |
| `book-session-contour.guard.test.ts` (Step-11 in-repo guard) | DELETED — superseded by the package guard |

### 21.5 Tests and verification

| Check | Result |
|---|---|
| Package unit tests (`test/bookSession.test.ts`) — initial empty identity, loadBook persist/clear/overwrite, setGenerationBuildId (no re-persist parity), readPersistedBookSession (present/absent/corrupt/id-less/read-only), stash (move+clear, stale removal, null userId), restore-stash (re-attach, no clobber, null), storage-failure graceful paths (setItem/removeItem/getItem throwing) | 25/25 PASS |
| Package guard | 3/3 PASS (28 tests total in package) |
| Frontend suite (incl. auth-book-session, fileStore, fileAdapters, all 8 guards) | 159/159 PASS |
| Frontend typecheck | CLEAN |
| Frontend vite build | GREEN (405 KB JS) |
| Workspace/lockfile consistency | `frontends/app/package.json` + `package-lock.json` updated (`file:../../packages/animastor-web-book-session` dependency + link entry); package lockfile committed |
| Production import graph | generateStore + fileStore import the package root only; zero deep imports; old `state/bookSession.ts` deleted |
| Duplicate-identity scan | exactly one physical implementation (the package); one key literal; one loadBook |

Regression coverage preserved unmodified: auth logout→stash+clear, login→restore, fileStore restore flows, generation build_id update (via fileStore.test + auth-book-session.test against the re-export surface), page reload/session persistence.

### 21.6 Verdict

**Identity/session: PHYSICALLY EXTRACTED / READY.**

`@animastor/web-book-session` is the single physical owner of `bookId`/`buildId`/`loadBook`/session persistence/stash — confirmed by guards on BOTH sides of the boundary (package internals + host consumption graph) and by tests proving behavior equivalence. The §20.8 criterion held: this step was a file move + import rewiring, not new architecture.

**Overall `@animastor/web-generator` full extraction: NOT READY** (unchanged) — the remaining host core is the phase/errorMessage dual-writer cluster (B6), cancel/teardown, checkAndRestoreGenerationState, and applyGenerationResults composition (§19.9, §15, §17.4). The next candidate boundary, if pursued, is the phase/error shared session-status seam (§19.6-D) — now that identity is out, it is the last cross-slice shared state in generateStore.

---

*Step-12 physical extraction of the book session identity completed on this branch; package created, host wired, old in-repo contour deleted, all tests/guards/typecheck/build green.*

---

## 22. Step 13 — Final Re-Audit of the Remaining "web-generator" Extraction Boundary (post identity extraction)

**Status:** AUDIT ONLY — no production code changes, no packages created, no files moved, no API changed.  
**Date:** 2026-09-14  
**Branch:** `c21.4-physically-extract-analysis-from-backend`  
**HEAD:** `9c5b36fa11a281186836b6204f170ae45186f55d` ("refactor(web): physically extract book session" — Step 12 complete)  
**Parent:** `e35348c566e54c8bccb953ba2c2728738bb63742` ("docs(architecture): audit remaining backend extraction candidates")  
**Commits ahead:** 1 (the exact `parent → HEAD` diff was audited, NOT a wide historical baseline)  
**Changed files (parent → HEAD):** 18 — the Step-12 extraction commit: `docs/architecture/web-generator-extraction-audit.md`, `frontends/app/package.json` + `package-lock.json`, `book-session-package-contour.guard.test.ts` (new; old `book-session-contour.guard.test.ts` deleted), `generation-progress-contour.guard.test.ts` (updated identity pins), `frontends/app/src/state/generateStore.ts` (−28 lines of identity body → re-exports), `frontends/app/src/state/fileStore.ts` (`readPersistedBookSession` consumption), and the new `packages/animastor-web-book-session/` tree (src/index.ts, test/guard.test.ts, test/bookSession.test.ts, tsconfig, tsup, vitest configs, package.json + lockfile, LICENSE, README).

### 22.1 generateStore.ts — new object of analysis (694 LOC at `9c5b36fa`)

`generateStore` is now a pure **host composition/facade**: 100% of decision-rich orchestration slices live in packages. Remaining blocks:

| Lines | Block | Category | Ownership after Step 12 |
|---|---|---|---|
| 22–59 | Imports + types (`GenerationStatus`, `PlaybackPrepared`, `SceneRef` re-export) | host composition | generateStore |
| 61–66 | Identity re-exports (`bookId`, `buildId`, `loadBook`, stash pair, `setGenerationBuildId`, `readPersistedBookSession`) | **Identity** | **`@animastor/web-book-session`** (1:1 re-export; generateStore declares nothing) |
| 67–79 | `blankBookJustCreated` + playback event bus (`onPlaybackPrepared`/`emitPlaybackPrepared`) | host composition (event bus) | generateStore |
| 82–155 | Nav-icon SUCCESS pulse machinery (`generationStatus` + pulse/hold/watchdog timers) | UI status | generateStore |
| 157–167 | `dirtySummary` | host shared state | generateStore |
| 170–246 | File-slice seams (`stopGenerationSession`, `setRegenerating`, `bumpVBookPollToken`, `markImportIncomplete`) + `vbookPollState` | host composition (seams) | generateStore |
| 249–262 | `phase`/`errorMessage` (B6 shared session status) | cross-slice shared status | generateStore (fileStore writes via SessionSeam) |
| 265–345 | Generate-screen signals (`vbookProgress`, `isRegenerating`, analysis progress, layer-config signals, `loadLayerConfig`/`persistLayerConfig`/`refreshAssetsState` wrappers) | host composition | generateStore (domain in `@animastor/web-generator-config`) |
| 347–412 | Timer + progress-tracking state objects, `computeProgressRows` wrapper | host composition | generateStore (domain in `@animastor/web-generator`) |
| 414–474 | VBook agent composition (`vbookAgentPorts` + 2 delegation fns, `clearVBookProgress`) | host composition | generateStore (decisions in `@animastor/web-generator-vbook`) |
| 476–528 | SSE stream host wiring (`startProgressStream`/`stopProgressStream`, epoch + AbortController, `progressEventSink`) | transport composition | generateStore (reconnect/routing in `@animastor/web-generator-sse`) |
| 530–551 | `startGeneration` | generation orchestration (host) | generateStore |
| 553–607 | `applyGenerationResults` | generation orchestration (host) | generateStore |
| 609–644 | `cancelGeneration` | cancel/teardown (host) | generateStore |
| 646–658 | `cancelTask` | cancel/teardown (host) | generateStore |
| 660–683 | `checkAndRestoreGenerationState` | restore re-arming (host) | generateStore |

#### A. Identity — re-verified

Zero identity ownership remains in `generateStore.ts` (grep-verified at HEAD):

| Token | Physical location | Host sites |
|---|---|---|
| `export const bookId = signal` / `export const buildId = signal` | `packages/animastor-web-book-session/src/index.ts:51–52` ONLY | 0 in `frontends/app/src` (playbackStore's own `bookId`/`buildId` are the player package's internal projection, not session identity — distinct, pre-existing, package-guarded) |
| `export function loadBook` | book-session package:117 ONLY | 0 in host src |
| `bookId.value =` / `buildId.value =` (session identity) | book-session package:118–119, 129 ONLY | 0 in host src |
| `BOOK_STORE_KEY` / `animastor:currentBook` literal | book-session package ONLY | 0 in host production src (only test-file keys) |
| localStorage session write path (`persistBookSession`/`clearBookSession`/stash keys) | book-session package ONLY | 0 in host src |
| `stashBookSessionForUser` / `restoreStashedBookSessionForUser` | book-session package ONLY | consumed via re-export |
| `setGenerationBuildId` (controlled 2nd writer) | book-session package:128 ONLY | called from `startGeneration` |

**Ownership: `@animastor/web-book-session`.** No duplicate identity implementation, no fork, one signal graph. Identity boundary: **CLOSED — PHYSICALLY EXTRACTED / READY** (§21 verdict re-confirmed at HEAD).

#### B. Generation orchestration — remaining flows

| Flow | Domain decision content | Host composition content | State writes | Transport | Navigation/playback | Ports available | Physically extractable without a giant interface? |
|---|---|---|---|---|---|---|---|
| `startGeneration` (530–551) | minimal: request mapping (`rebuild_all: true`) + build_id capture + dirty count mapping | RUNNING arming, `newGenerationPending`, timer/stream start, `phase`/`dirtySummary` writes, assets refresh | `generationStatus`, `isRegenerating`, `progressTracking`, `phase`, `dirtySummary` | 1 POST `/regenerate` | none | GenerationStatePort/IdentityPort/TransportPort exist in generationPorts.ts (design-only) | **NO** — writes the B6 dual-writer `phase` + file-owned `dirtySummary`; body is ~20 LOC mostly host arming → extraction = thin adapter |
| `checkAndRestoreGenerationState` (660–683) | restore-if-active-workers decision (2 signals merged) | full session re-arm (timer/SSE/status/tracking/`phase`) | 5 host writes | 2 GET (progress-panel, worker counts) | none | transport+state callbacks | **NO** — it is host re-composition of already-extracted parts; extraction = artificial wrapper |
| `cancelGeneration` (609–644) | backend cancel call only | 11/13 ops are host state teardown incl. B6 `phase`/`errorMessage` writes + `applyGenerationResults` bridge | 9 host writes | 1 POST `/cancel-generation` | via `applyGenerationResults` | progress port exists (design-only) | **NO** — see §22.2 |
| `cancelTask` (646–658) | none (pass-through payload) | vbook branch token bump + `clearVBookProgress` | 2 host writes | 1 POST `/cancel-worker` | none | poll contract exists (in use) | **NO** — thin transport adapter |
| `stopGenerationSession` (201–208) | none | teardown composition over host-owned resources | token/SSE/timer/status/progress | none | none | n/a (host seam consumed by fileStore) | **NO** — pure host seam |
| `applyGenerationResults` (553–607) | anchor-position decision + zero-scenes guard | fetch+sceneRefs binding, playback emit | none direct | 1 GET `/book/:id` | `navigateTo` + `emitPlaybackPrepared` | navigation/playback ports designed only | **NO** — see §22.4 |

**Verdict: no remaining flow satisfies the "no giant interface" test.** Each flow is either (a) dominated by host state writes to dual-writer/file-owned signals, or (b) a thin transport adapter. Extracting any of them today creates an artificial wrapper around host state — the exact outcome the audit constraint forbids.

### 22.2 Cancel / session teardown — re-audit (Step-6 blockers re-checked)

Current inventory of the nine teardown-relevant lifetimes:

| Concern | Physical owner | Explicit state? |
|---|---|---|
| SSE lifetime (AbortController + epoch) | generateStore (`startProgressStream`/`stopProgressStream`) | NO — two module-scope bindings (`sseController`, `sseEpoch`) |
| VBook poll lifetime | generateStore (`vbookPollState = createVBookPollState()`) | YES — explicit object |
| Generation timer | generateStore (`generationTimer`) | YES — explicit object |
| Progress tracking state | generateStore (`progressTracking`) | YES — explicit object |
| Generation status (`generationStatus` + nav pulse timers) | generateStore | NO — signal + two module-scope timer handles |
| Regeneration state (`isRegenerating`) | generateStore | signal only |
| Cancellation request (`cancelGeneration`/`cancelTask`) | generateStore | — |
| Teardown (`stopGenerationSession`) | generateStore | — |
| Stale session protection (epoch + token compares) | generateStore + packages (compare) | mixed |

**Step-6 blocker status (§15.2, re-derived at HEAD):**

1. ~~"SSE controller/epoch are module-scope"~~ — **STILL OPEN** (`sseController`/`sseEpoch` remain bare module-scope `let`s).
2. ~~"poll token is a module-let"~~ — **RESOLVED at Step 9** (`vbookPollState` explicit object).
3. "5 mutable state objects must be passed as parameters" — **DOWNGRADED**: 3 of 5 are now explicit objects (`vbookPollState`, `progressTracking`, `generationTimer`); 2 remain module-scope (SSE pair + nav-pulse timer handles).
4. "applyGenerationResults bridge in cancel path" — **STILL OPEN** (§22.4: still host-side, still bridges navigation+playback).
5. "phase/errorMessage dual-writer writes in cancel path" — **STILL OPEN** (B6 unchanged).

**Verdict: PREPARATION REQUIRED.** A self-contained physical boundary does NOT yet exist: cancel/teardown writes the B6 dual-writer signals and bridges into `applyGenerationResults` (host legs), and the SSE resource pair is still module-scope. It is no longer NOT READY (Step 9 removed the token blocker and explicit state objects now cover 3 of 5 concerns), but extracting now would produce a package calling back into host state for the majority of its operations. Required prep (in order): (a) `SseStreamState { controller, epoch }` explicit object; (b) resolve the B6 phase/errorMessage ownership; (c) split cancel into "request" (transport) vs "teardown" (host state) with `applyGenerationResults` invoked by the caller, not inside the extracted slice.

### 22.3 `phase` / `errorMessage` — ownership audit

Production writers/readers (grep-verified at HEAD; tests excluded):

| File | Writes | Reads |
|---|---|---|
| `state/generateStore.ts` | `phase`: SCENE_READY (startGeneration), IDLE (cancelGeneration), GENERATING (checkAndRestore); `errorMessage`: null (cancelGeneration) | — |
| `state/fileStore.ts` (via SessionSeam) | `phase`: LOADING_BOOK / IMPORTING_TXT / SCENE_READY / IDLE; `errorMessage`: set on 3 failure paths, null on 3 flows | — |
| `app/fileAdapters.ts` | none (passes the signal objects into the SessionSeam by reference) | wires |
| `app/AppShell.tsx` | none | `phase` (desktop bounce mirror) |
| `pages/GeneratePage.tsx` | none | `phase` (currentPhase) |
| `state/__tests__`, `fileStore.test.ts`, `fileAdapters.test.ts` | tests only | tests only |

**Classification:** `phase`/`errorMessage` are NOT generation state, NOT session status, NOT file-flow status — they are a **cross-slice UI status** shared by two writers (generation slice + file slice) and two readers (AppShell bounce, GeneratePage). The two writer sets are interleaved in time (file flows settle `phase` before/after generation flows write it); a split into per-slice signals would fork the source of truth or require a merge layer with priority semantics — new behavior, not extraction.

**Verdict: HOST-OWNED (stay in generateStore).** There is no natural standalone boundary after the identity extraction: a "session status" package would own two signals written by two host modules — an artificial wrapper. The §19.6-D "phase/error seam" idea is explicitly **rejected** as a next step. No SessionStatusPort created (per constraint). `phase`/`errorMessage` remain the last genuinely cross-slice shared state and are a permanent host concern unless/until a full session-status design exists.

### 22.4 `applyGenerationResults` — re-decomposition (553–607, 55 LOC)

| # | Block | LOC | Production consumers | Dependencies | Ownership | Extraction readiness |
|---|---|---|---|---|---|---|
| 1 | Pure/data extraction: guard (`isRegenerating` read → `stopTimer`) + `GET /book/:id` + `sceneRefs(bookData)` + zero-scenes guard | ~14 | computeProgressRows finalize, vbookAgentPorts.onGenerationFinalized, cancelGeneration | api/client getJson, api/models sceneRefs, bookId, generationTimer | transport+pure — same shape as `@animastor/web-generator-config` fns | Extractable, but ~10 LOC of fetch+map — a thin adapter on its own |
| 2 | Generation result application | ~2 (implicit: none — results are the fetched book itself) | — | — | host | n/a — the "application" IS blocks 3+5 |
| 3 | Navigation: position anchor (read `position.value.chapterId`, `navigateTo` first cover scene) | ~10 | via callers | positionStore (read+write) | **host only** — reads host-owned position signal | NOT portable without position port + read access |
| 4 | Playback: `emitPlaybackPrepared({ softRefresh: true })` | ~5 | via callers | playback bus (host) | **host only** — host-owned bus (§6 blocker 4) | NOT portable |
| 5 | File adapters | 0 | — | — | — | none present |
| 6 | Host state mutation: `stopTimer` leg + error catch | ~4 | via callers | generationTimer | host | thin |

**Did a small domain core appear?** No. Blocks 3+4+6 (host legs) still outweigh block 1 (extractable core ~10–14 LOC). The function remains a **host composition point by design**: the package side decides WHEN (via `onGenerationFinalized`, §18), the host decides WHAT (navigation + playback). §17.2/§19.7 verdict **re-confirmed: NOT READY as a standalone extraction** — no change post identity extraction; identity was not a dependency of any block. It is correctly host-side behind the `onGenerationFinalized` seam.

### 22.5 GenerationPorts re-evaluation (`frontends/app/src/app/generationPorts.ts`, 147 LOC, unchanged)

Port-by-port reality check against current production wiring:

| Port | Designed | Actual production use today | Status |
|---|---|---|---|
| `GenerationIdentityPort` | getBookId/getBuildId getters | superseded — identity is now a package with real signals; consumers read `bookId.value` directly via re-exports; extracted packages use their own slice-local identity ports (`VBookIdentityPort` etc.) | **OBSOLETE for new extractions** (harmless as design record) |
| `GenerationTransportPort` | getJson/postJson/postJsonLong/putJson | partially realized — slice-local transport ports shipped in vbook/config packages | **SIMPLIFY LATER** |
| `GenerationSsePort` | startStream/stopStream AsyncIterable | partially realized — `SseStreamPort` shipped in web-generator-sse with a different (callback) shape | **SIMPLIFY LATER** |
| `GenerationNavigationPort` / `GenerationPlaybackPort` | navigateTo / emitPlaybackPrepared | unused in production; host binds these directly in `applyGenerationResults`/`vbookAgentPorts` | design-only, will be needed if a finalize slice is ever extracted |
| `GenerationStatePort` | setPhase/setErrorMessage/setGenerationStatus/... | partially realized via slice-local state callbacks (`VBookHostState`) | **SIMPLIFY LATER** |
| `GenerationConfigPort` | 8 setters | fully superseded — layer-config extraction shipped its own port shape | **OBSOLETE for new extractions** |
| `GenerationProgressPort` | reset/clear/bump/mark/stop | fully realized as the fileStore `GenerationResetSeam` + host exports | realized in host seams, not here |

**Is GenerationPorts becoming a giant ambient interface?** No — 147 LOC, 8 small interfaces, zero production imports, frozen by `generation-ports.guard.test.ts` (9/9 PASS). It is a design record, not an ambient dependency. Its slice-local realizations (ProgressRowContext, VBookAgentPorts, SseStreamPort, config ports) proved the port mechanics; the composite bundle is now largely covered by shipped reality.

**Verdict: KEEP** (as design documentation; do NOT delete — guards pin it and §13 design intent is referenced by shipped package ports). Sub-verdicts: `GenerationIdentityPort`/`GenerationConfigPort` = OBSOLETE as future guidance; transport/SSE/state = SIMPLIFY LATER (prefer the shipped slice-local port shapes as templates); navigation/playback = KEEP for a potential future finalize-slice. **SPLIT LATER not required** — the file already IS the split, and no orchestration package imports it.

### 22.6 Dependency / consumer graph (current HEAD)

```
generateStore (host facade, 694 LOC)
 ├─ identity  → @animastor/web-book-session   (re-exports; +fileStore consumes readPersistedBookSession)
 ├─ progress  → @animastor/web-generator      (computeProgressRows, analysis, timer domain)
 ├─ config    → @animastor/web-generator-config (layer-config + assets domain)
 ├─ SSE       → @animastor/web-generator-sse  (runSseStream; host keeps AbortController/epoch)
 ├─ VBook     → @animastor/web-generator-vbook (vbookAgentPorts; decisions in package)
 └─ remaining host orchestration: startGeneration, checkAndRestoreGenerationState,
    cancelGeneration, cancelTask, stopGenerationSession, applyGenerationResults,
    nav-icon pulse, playback bus, B6 phase/errorMessage, file-slice seams
```

Package-internal edges (acyclic): `web-generator-vbook → web-generator`; `web-generator-sse → web-generator`; config/book-session depend on nothing but `@preact/signals`.

- **Reverse dependencies:** none — no package imports generateStore or any host module (grep-verified; web-player/web-navigator reference generateStore only in comments; they receive identity/`onPlaybackPrepared` through host adapters).
- **Cycles:** none. The former generateStore⇄playbackStore cycle stays dissolved (playbackStore now lives in web-player; fileStore's `player` seam carries the release call). generateStore does not import playbackStore.
- **Deep imports:** zero — all host consumption is through package roots (guard-pinned).
- **Duplicated implementations:** zero identity duplicates (§22.1-A); `animastor:currentBook` literal exists only in the package + test files.
- **Host-only responsibilities:** identity re-export surface, B6 phase/errorMessage, playback bus, nav-icon pulse, cancel/teardown, `applyGenerationResults` composition, `checkAndRestoreGenerationState` re-arming, file-slice seams.
- **Remaining package candidates:** none that pass the no-artificial-wrapper test (§22.1-B).

### 22.7 Production consumer audit

All 10 direct production consumers of `generateStore`, re-derived at HEAD:

| Consumer | Consumes | Why it still depends on the host store | Future package-API migration | Extraction risk if generateStore were extracted whole NOW |
|---|---|---|---|---|
| `pages/GeneratePage.tsx` | ~20 symbols: signals + all actions + timer helpers | The Generate screen IS the generation slice's UI | could move with a UI extraction; not valuable alone | premature — would drag the B6 cluster into a package |
| `app/AppShell.tsx` | `bookId`, `generationStatus`, `phase`, `blankBookJustCreated` | cross-slice shell mirrors (nav pulse + bounce) | could consume a status package — none exists | would force a SessionStatus design prematurely |
| `app/fileAdapters.ts` | 14 symbols incl. identity by reference | the SessionSeam/GenerationResetSeam composition root | partially replaceable by book-session package imports today | premature — seams are the deliberate B1/B6 boundary |
| `app/playerAdapters.ts` / `app/navigatorAdapters.ts` | `bookId`, `buildId`, `onPlaybackPrepared` | PlayerPorts/NavigatorPorts wiring | identity via package + bus via port — feasible later | would invert the producer bus |
| `pages/EditPage.tsx` | `bookId`, `buildId`, `dirtySummary`, `onPlaybackPrepared` | dirty indicator + soft-refresh subscription | identity via package feasible; bus stays host | would drag the bus into the package |
| `pages/SettingsPage.tsx` | `bookId`, `resetProgressState` | clear-cache flow resets generation tracking | needs the progress seam to exist as package API | thin, but depends on host state object |
| `pages/AiAssistantPage.tsx` | `bookId` | book-scoped AI context | identity via package — feasible NOW | low risk but zero value alone |
| `state/authStore.ts` | stash pair (via re-export) | login/logout session isolation | could import the book-session package directly | would invert auth→identity only if the bus moved too |
| `main.tsx` | `bookId` | login re-entry guard | identity via package — feasible NOW | low risk |
| `state/fileStore.ts` | no direct import — injected seams only | deliberate B1/B6 seam boundary | n/a (already port-shaped) | n/a |

**Risk assessment:** extracting the REMAINING generateStore whole today would force every consumer through a giant ambient interface covering identity re-exports + B6 signals + bus + seams — precisely the artificial-wrapper outcome. The consumers that could already migrate to `@animastor/web-book-session` directly (AiAssistantPage, main.tsx, authStore) are micro-migrations with no architectural gain while generateStore remains their composition point.

### 22.8 Architecture guards — currency check

| Guard | Reflects current architecture? | Updated in this commit? |
|---|---|---|
| `generation-progress-contour.guard.test.ts` | YES — re-pinned to the `@animastor/web-book-session` re-export surface (Step 12) | NO (current) |
| `book-session-package-contour.guard.test.ts` | YES — 15 rules over the physical package + host consumption graph (Step 12) | NO (current) |
| `generation-ports.guard.test.ts` | YES — still pins the design-only status correctly (no production imports of the ports file) | NO (current) |
| `vbook-contour.guard.test.ts` | YES — pins `applyGenerationResults` host-side, root-only consumption, explicit poll state | NO (current) |
| `file-navigator-contour.guard.test.ts` | YES — file/navigator boundaries unchanged by identity extraction | NO (current) |
| `player-contour.guard.test.ts` | YES — player boundary unchanged | NO (current) |
| `local-ai-contour.guard.test.ts` | YES — unrelated contour, unchanged | NO (current) |

All 8 host architecture guards pass (within the 159/159 frontend run). No guard rewrite required: the guards reflect the post-Step-12 architecture accurately.

### 22.9 Verification (exact, at `9c5b36fa`)

| Check | Result |
|---|---|
| `git rev-parse HEAD` / `HEAD~1` | `9c5b36fa…` / `e35348c5…`; diff audited is exactly `e35348c5 → 9c5b36fa` (18 files) |
| Identity ownership grep (signals/loadBook/key/buildId writes) | 0 host production sites; 1 physical owner (package) |
| localStorage session grep | package only + test keys; theme/AppShell use unrelated keys |
| `applyGenerationResults` consumers grep | 1 definition (host), 3 host call sites, 1 package seam, guards pin host-side |
| phase/errorMessage writers/readers grep | generateStore (4 phase writes, 1 errorMessage write) + fileStore via seam (14 writes); readers AppShell/GeneratePage |
| Production import graph | 10 direct consumers + fileStore seams; zero package→host edges; zero deep imports; zero cycles |
| Existing architecture tests | 8/8 guard files PASS |
| Frontend tests | **159/159 PASS** (13 files) |
| Package tests (`@animastor/web-book-session`) | **28/28 PASS** (25 unit + guard) |
| Frontend typecheck (`tsc --noEmit`) | CLEAN |
| Frontend build (`vite build`) | GREEN (405 KB JS) |
| GitHub Combined Status | statuses: [] — no independent CI confirmation available at this HEAD |
| Production code changes in this Step-13 commit | NONE (audit doc only) |

### 22.10 Verdicts summary

| Question | Verdict |
|---|---|
| Identity ownership | **PHYSICALLY EXTRACTED / READY** — `@animastor/web-book-session` is the single owner; generateStore is a re-export surface |
| Cancel / session teardown | **PREPARATION REQUIRED** — SSE resource pair still module-scope; B6 writes + applyGenerationResults bridge inside cancel; 3 of 5 Step-6 state blockers resolved |
| `phase`/`errorMessage` | **HOST-OWNED (stay)** — cross-slice UI status, dual-writer; no natural package boundary; SessionStatusPort rejected |
| `applyGenerationResults` | **NOT READY standalone** — host legs (navigation anchor + playback emit + timer) still dominate; extractable core ~10–14 LOC thin adapter; correctly host-side behind `onGenerationFinalized` |
| GenerationPorts | **KEEP** — design record, guard-pinned, not ambient; identity/config ports obsolete as guidance, transport/SSE/state = simplify later |
| Remaining orchestration flows | **NOT extractable individually** — each is host-state-dominated or a thin adapter |
| **Next extraction candidate** | **NO NEXT PHYSICAL EXTRACTION YET** |
| Overall `@animastor/web-generator` | **NOT READY** — identity extraction did NOT unlock the remaining contour; what remains is host composition + the B6 dual-writer cluster + cancel/restore composition with no decision-rich, single-consumer slice left |

### 22.11 Blockers for full `web-generator` extraction (current, exact)

1. **phase/errorMessage dual-writer (B6)** — cross-slice UI status written by generation + file slices, read by AppShell/GeneratePage; splitting or packaging forks the source of truth (§22.3).
2. **Host composition core** — `startGeneration`/`checkAndRestoreGenerationState`/`cancelGeneration`/`cancelTask`/`stopGenerationSession` are host-state-dominated sequences (§22.1-B); extraction yields wrappers, not packages.
3. **applyGenerationResults host legs** — position anchor + playback emit are host-only concerns; the extractable core is too thin to justify a package (§22.4).
4. **SSE resource pair** — `sseController`/`sseEpoch` remain module-scope; a `SseStreamState` object is the mechanical prerequisite for any future teardown slice (§22.2).
5. **Producer bus inversion risk** — `onPlaybackPrepared` is consumed by Player/Navigator/Edit through host adapters; moving the producer inverts the dependency direction (§6 blocker 4, unchanged).

### 22.12 Recommended next step

None — **"NO NEXT PHYSICAL EXTRACTION YET."** Every decision-rich slice (progress domain, layer-config, SSE reconnect, VBook agent lifecycle, identity/session) is now physically extracted and guard-pinned. The remaining contour is host composition whose extraction would create artificial wrappers around host state. If a future step wants mechanical progress, the only honest prerequisite work is: (1) an explicit `SseStreamState` object (prep, not extraction), and (2) a cross-slice session-status design that resolves B6 without forking `phase`/`errorMessage`. Until one of those lands, the "web-generator" extraction program is **complete for now**: 5 packages extracted (web-generator, web-generator-config, web-generator-sse, web-generator-vbook, web-book-session), all boundaries guard-pinned, overall verdict NOT READY (and stable).

---

*Step-13 final re-audit completed on this branch; audit-only — no production code, no packages, no file moves, no API changes, no guard rewrites. Only this document changed.*

---

## 23. Step 14 — Prepare the Cancel / Session-Teardown Boundary (PREP EXECUTED)

**Status:** PREP EXECUTED — SseStreamState explicit object created; cancelGeneration split into request vs local teardown; behavior preserved. **NOT a physical extraction** — no package created, no public API changed.  
**Date:** 2026-09-14  
**Branch:** `c21.4-physically-extract-analysis-from-backend`  
**HEAD (baseline):** `acf7bf301ba477a733ad51857e785ec4dd929eb8` ("audit(web): re-audit remaining generator extraction boundary" — Step 13 complete)  
**Parent:** `9c5b36fa11a281186836b6204f170ae45186f55d` (Step 12 — physical extraction of `@animastor/web-book-session`)  
**diff parent..HEAD (audited baseline):** exactly 1 file — `docs/architecture/web-generator-extraction-audit.md` (+243/−1). The Step-13 audit commit contained no production changes.  
**generateStore.ts at baseline:** 694 LOC; ownership: identity = `@animastor/web-book-session` (re-exports), decisions = the 4 generator packages, host = composition/seams/B6/cancel/restore/applyGenerationResults; consumers = 10 direct production files + fileStore via seams (§22.6/§22.7, unchanged at baseline).

### 23.1 SSE state — blocker 1 resolved (explicit single-owner object)

The last module-scope mutable pair in the teardown contour is gone:

```ts
// frontends/app/src/state/generateStore.ts (host-owned)
interface SseStreamState {
  controller: AbortController | null;
  epoch: number;
}
function createSseStreamState(): SseStreamState { return { controller: null, epoch: 0 }; }
const sseStream = createSseStreamState();
```

| Requirement | Status |
|---|---|
| One explicit owner | `generateStore` owns the single `sseStream` object; no other module references it (guard-pinned) |
| No new global mutable state | the former `let sseController` / `let sseEpoch` pair is deleted — the object replaces it 1:1 (two bindings → one explicit state object, same as `vbookPollState`/`progressTracking`/`generationTimer`) |
| `startProgressStream` / `stopProgressStream` through the state | both operate exclusively on `sseStream.controller` / `sseStream.epoch` |
| Reconnect/epoch semantics preserved | monotonic epoch counter, bumped on every start (`++`) and stop (`++`), compared by `@animastor/web-generator-sse` via the injected `getEpoch` closure — byte-identical observable behavior |
| External API unchanged | `startProgressStream(bId)` / `stopProgressStream()` signatures and call sites untouched (7 internal call sites + vbookAgentPorts `startStream` binding) |
| Package API untouched | `@animastor/web-generator-sse` (`runSseStream`, `SseStreamPort`) NOT modified |

### 23.2 Cancel split — request vs session teardown (real host refactoring, no extraction)

`cancelGeneration` was a hidden owner of three concerns. It is now an explicit composition of two named legs + the finalization bridge:

| Leg | Function | Responsibility | Transport | Host-state writes |
|---|---|---|---|---|
| **Cancel request** | `requestCancelGeneration(bId)` (private) | backend cancellation ONLY | 1 POST `/book/:id/cancel-generation` (error-tolerant, warn logged) | NONE |
| **Local session teardown** | `teardownGenerationSessionLocal()` (private) | local resets ONLY | NONE | `generationStatus→IDLE`, `newGenerationPending=false`, `stopTimer`, `stopProgressStream`, `resetProgressState`, `vbookPollState.token++`, `resetAnalysisProgress`, `isRegenerating=false`, `phase=IDLE`, `errorMessage=null` |
| **Composition** | `cancelGeneration()` (public, unchanged signature) | `teardown → request → if (hasAnyProgress()) applyGenerationResults()` | — | — |

- **`applyGenerationResults` is no longer a hidden part of the cancel flow's state-mutation body** — it is an explicit finalization leg in the composition, clearly separated from the request contour. A future extracted cancel/request package would own ONLY `requestCancelGeneration`; the host keeps both other legs.
- **Composition order preserved** (teardown → request → conditional finalization). One deliberate micro-reorder: `isRegenerating`/`phase`/`errorMessage` settle BEFORE the HTTP call instead of after it (previously between the request and the finalization). Both writes are unconditional, read no request result, and no observer can run between the two await points (single-threaded host) — externally observable behavior is identical.
- `cancelTask` was already request-shaped (vbook branch token bump + POST) — left as-is, pinned by guard to never absorb session teardown.
- No artificial package created; both legs remain host-internal (guards pin that nothing else calls them).

### 23.3 `phase` / `errorMessage` — ownership audit (no change made)

Re-derived at this HEAD (production only; grep-verified):

| Writer | Values written | Lifecycle role |
|---|---|---|
| generateStore (generation slice) | `SCENE_READY` (startGeneration), `GENERATING` (checkAndRestore), `IDLE` + `errorMessage=null` (cancel/teardown leg) | generation lifecycle decisions |
| fileStore (via SessionSeam, wired in fileAdapters) | `LOADING_BOOK`, `IMPORTING_TXT`, `SCENE_READY`, `IDLE` + 3 error paths | file-flow lifecycle decisions |

| Reader | Use |
|---|---|
| AppShell | desktop bounce mirror |
| GeneratePage | `currentPhase` |
| (fileAdapters passes the signal objects by reference — wiring, not reading) |

**Why the dual-writer exists:** the signals model ONE cross-slice session-status surface that two independently-owned flows (File flows, generation flows) settle in time-interleaved order; whoever finishes last defines the observable status. Neither slice's lifecycle can be derived from the other's.

**Can an owner be assigned now?** NO. Both writers define the lifecycle (neither is derivable), both readers consume the merged result, and the merge order is behavioral. Assigning ownership to either slice forks the source of truth or changes bounce/restore semantics. **Consumers blocking the change:** AppShell (bounce mirror reads the merged signal), fileAdapters SessionSeam (by-reference identity wiring), GeneratePage, and fileStore's four flows.

**Blocker documented (B6, unchanged):** `phase`/`errorMessage` remain HOST-OWNED dual-writer cross-slice UI status; not moved, no SessionStatusPort created. Any ownership change requires a session-status design that defines merge/priority semantics first (§22.3).

### 23.4 Cancel teardown inventory (post Step 14)

| Concern | Owner | State representation | Starts | Stops | Resets | Extraction-safe? |
|---|---|---|---|---|---|---|
| SSE lifetime | generateStore | **`SseStreamState` explicit object** (NEW) | `startProgressStream` (startGeneration, checkAndRestore, vbookAgentPorts.startStream) | `stopProgressStream` (teardown leg, computeProgressRows finalize, start-restart) | epoch bump on start/stop | **YES — explicit object, single owner, port-shaped** (a future package can receive it by reference) |
| VBook poll lifetime | generateStore | `VBookPollState` explicit object | `startVBookGeneration` (package loop reads token) | token bump: teardown leg, `cancelTask`, `bumpVBookPollToken`, package `bumpPollToken` | n/a (token is monotonic) | YES (already extraction-safe since Step 9) |
| Generation timer | generateStore | `GenerationTimerState` explicit object | `startTimer` (startGeneration, checkAndRestore, vbook lifecycle) | `stopTimer` (teardown leg, applyGenerationResults, package finalize) | freeze via stop | YES (extraction-safe) |
| Progress tracking | generateStore | `ProgressTrackingState` explicit object | arming flows | — | `resetProgressState` (teardown leg, checkAndRestore, SettingsPage via seam) | YES (extraction-safe) |
| Generation status / nav pulse | generateStore | signal + 2 module-scope timer handles (`navStatusTimer`, `navWatchdog`) | `setGenerationStatus` | self-clearing pulse + watchdog | reset to IDLE on teardown | NO — presentation-coupled (browser timer parity, §17.4); low value |
| Regeneration state | generateStore | `isRegenerating` signal | startGeneration, checkAndRestore | teardown leg, finalize paths | file flows via `setRegenerating` seam | NO — shared with finalize/file seams; host composition |
| Cancellation request | **cancel-request leg** (future package candidate) | none (stateless transport call) | `cancelGeneration` composition | — | — | **YES — stateless, transport-only, 1 endpoint** |
| Teardown | generateStore (composition) | the named `teardownGenerationSessionLocal` sequence | `cancelGeneration` | — | — | PARTIAL — sequence is named and transport-free, but writes the B6 signals |
| Stale-session protection | generateStore + packages | epoch compare (SSE) + token compare (VBook) | — | — | — | YES — both compares live in packages; authority is explicit host state |

**Result:** 5 of 9 concerns are now explicit-object extraction-safe (SSE state joins poll/timer/tracking + the stateless request leg). The remainder (nav pulse, regeneration, teardown composition) is host composition entangled with the B6 signals.

### 23.5 Guards (updated; no new files)

`generation-progress-contour.guard.test.ts` — +9 assertions in 2 new groups:
- **SSE state ownership:** explicit `SseStreamState` interface + `createSseStreamState()` singleton; start/stop operate on it; the old `^let sseController` / `^let sseEpoch` bindings are GONE from every host source file; no other module touches `sseStream`; exactly one definition site.
- **Cancel boundary:** `requestCancelGeneration` is transport-only (no signal writes, no teardown calls in its body); `teardownGenerationSessionLocal` is state-only (no transport calls; owns the documented 10-token reset sequence — behavior parity pinned); `cancelGeneration` composes `teardown → request → conditional applyGenerationResults` with no direct `postJson`; `cancelTask` never absorbs teardown; the private legs are unreachable from other modules.

`vbook-contour.guard.test.ts` — SSE host-ownership pin updated from the deleted `sseController` token to the explicit `SseStreamState`/`createSseStreamState()` tokens.

All other guards unchanged and passing (package boundaries, identity ownership, no reverse deps — covered by the existing book-session/vbook/file-navigator/player guard suites).

### 23.6 Untouched (per constraint)

`@animastor/web-book-session`, `@animastor/web-generator-vbook`, `@animastor/web-generator-sse` (API and source), `@animastor/web-generator-config`, `@animastor/web-generator`, `generationPorts.ts` (zero changes), transport endpoints, identity ownership, navigation/playback semantics, generation behavior.

### 23.7 Verification

| Check | Result |
|---|---|
| Architecture guards (generation-progress 19, vbook 13 — incl. all new assertions) | PASS |
| Frontend suite | **168/168 PASS** (13 files; +9 tests) |
| Frontend typecheck (`tsc --noEmit`) | CLEAN |
| Frontend build (`vite build`) | GREEN (405 KB JS) |
| GitHub Combined Status | statuses: [] — no independent CI confirmation |
| Production behavior | unchanged (composition reorder documented in §23.2; no signature/endpoint changes) |

### 23.8 Verdict

**PREPARATION REQUIRED → the preparation is now DONE for the request leg; remaining blockers are conceptual, not mechanical.**

- **Cancel/request leg: READY FOR PHYSICAL EXTRACTION** — `requestCancelGeneration` is stateless, transport-only, single-endpoint, with `teardownGenerationSessionLocal` and `applyGenerationResults` clearly NOT part of its contour (guard-pinned). A future step could cut it mechanically — but per the standing rule it is NOT extracted in this commit, and as a ~5-LOC stateless POST it is of marginal standalone value (the honest boundary record matters more than the LOC).
- **Session teardown: PREPARATION REQUIRED (B6-bound)** — the sequence is named, transport-free, and guard-pinned, but it writes the dual-writer `phase`/`errorMessage`; it cannot move until B6 has an ownership/merge design (§23.3).
- **phase/errorMessage: NOT READY (unchanged blocker)** — §23.3.
- **Overall `@animastor/web-generator`: NOT READY** — unchanged; the remaining host core (B6 signals, nav pulse, regeneration, `applyGenerationResults` host legs, teardown composition) is host composition. No new extraction boundary beyond the marginal cancel/request leg was unlocked.

**Next candidate: NO NEXT PHYSICAL EXTRACTION YET** (the only extraction-safe piece is the stateless request leg of marginal value; the meaningful prerequisite remains the B6 session-status design).

---

*Step-14 boundary preparation completed on this branch; SseStreamState created, cancel split into request/teardown legs, guards strengthened, behavior preserved. No package created, no API changed, no behavior modified.*

---

## 24. Step 14A — Preserve Cancel Observable Ordering (review fix)

**Status:** FIX EXECUTED — the Step-14 cancel split is retained; the observable ordering of host-state writes is restored to the pre-Step-14 `cancelGeneration` contract. No package, API, endpoint, or architecture change.  
**Date:** 2026-09-14  
**Branch:** `c21.4-physically-extract-analysis-from-backend`  
**Baseline HEAD:** `0effeb0d8fff226b65c5e8aacaf8cc6fc890460f` (Step 14 prep commit)  
**Parent:** `acf7bf301ba477a733ad51857e785ec4dd929eb8` (Step 13 audit)

### 24.1 The observable-order finding

Re-deriving the OLD `cancelGeneration` at the parent (`acf7bf30`) showed its writes ran in two phases separated by `await postJson(...)`:

| Phase | Old writes (in order) |
|---|---|
| pre-await (before the request) | `setGenerationStatus('IDLE')`, `newGenerationPending=false`, `stopTimer`, `stopProgressStream`, `resetProgressState`, `vbookPollState.token++`, `resetAnalysisProgress` |
| `await postJson('/cancel-generation')` | — request in flight — |
| post-await (after the request resolves) | `isRegenerating=false`, `phase='IDLE'`, `errorMessage=null` |
| finalization | `if (hasAnyProgress()) applyGenerationResults()` |

The Step-14 refactor moved the post-await writes INTO `teardownGenerationSessionLocal()` — i.e. BEFORE the await. That was a real behavioral risk, not a cosmetic reorder: **`await` yields to the event loop**, so any consumer running while the request is in flight (a signal effect, the 1.5s progress-panel poll tick, an SSE event handler) could observe `phase='IDLE'`/`errorMessage=null`/`isRegenerating=false` before the backend confirmed cancellation — something the old code never allowed (e.g. AppShell's bounce mirror or GeneratePage could react one tick early). The "single-threaded host" argument does not cover this: single-threaded ≠ no interleaving across `await`.

### 24.2 What was changed

The three post-await writes got their own leg; the two-leg separation survives:

```
cancelGeneration (composition, signature unchanged)
  1. teardownGenerationSessionLocal()   — pre-await legs (sync; status/tracking/analysis/timer/stream/token)
  2. await requestCancelGeneration(bId) — backend request (transport-only, unchanged)
  3. settleGenerationSessionAfterCancel() — post-await legs (isRegenerating=false, phase='IDLE', errorMessage=null)
  4. if (hasAnyProgress()) await applyGenerationResults() — host finalization (unchanged)
```

The observable order is now byte-compatible with the parent implementation: pre-await teardown → request in flight (state frozen at pre-cancel values for `phase`/`errorMessage`/`isRegenerating`) → post-await settle → conditional finalization. The request leg remains stateless/transport-only (Step-14 contour intact); the settle leg is host composition, as it always was.

### 24.3 Why `await` is the boundary for observable state

Between `teardownGenerationSessionLocal()` and `requestCancelGeneration`'s resolution, `cancelGeneration` is suspended and the event loop runs freely: pending signal effects, poll timers, and SSE callbacks execute during that window. Any state written before the await is therefore observable by those consumers while the request is still unresolved. Writes performed after the await are observable only after the backend call settled (or failed). The pre-await/post-await split of the OLD code is thus part of its observable contract, and the composition must reproduce it — which step 3 above now does.

### 24.4 Regression tests (in `state/generateStore.analysis.test.ts`)

1. **"does NOT settle phase/errorMessage/isRegenerating before the cancel request resolves"** — the mocked `postJson` snapshots the full state at request start and the test snapshots it again while the request is deliberately left unresolved. Pins: teardown legs ran BEFORE the request (`generationStatus` already `IDLE`), and `isRegenerating`/`phase`/`errorMessage` still hold their PRE-cancel values both at request start and while in flight; after resolving, the end state equals the old `cancelGeneration`'s. A future refactor that hoists the settle writes above the await fails here.
2. **"settles to the old end state even when the cancel request FAILS"** — rejected `postJson` still produces `isRegenerating=false`/`phase='IDLE'`/`errorMessage=null` and the warn log, matching the old error-tolerant path.

### 24.5 Guard updates (no new files)

`generation-progress-contour.guard.test.ts` — Step-14 group extended: the teardown leg must NOT contain the three settle writes (with an explicit "Step 14A ordering contract" failure message); a new `settleGenerationSessionAfterCancel` leg is pinned to own EXACTLY those three writes and nothing else; the composition assertion now requires teardown → await request → settle → finalization order (index-compared in source); the private-leg reachability ban includes the settle leg.

### 24.6 Step-14 validity

The Step-14 architecture preparation remains valid unchanged: `SseStreamState` untouched; `requestCancelGeneration` still transport-only; `teardownGenerationSessionLocal` still transport-free; `applyGenerationResults` still not owned by the cancel contour; no packages touched (`web-book-session`, `web-generator`, `web-generator-vbook`, `web-generator-sse`, `web-generator-config`); GenerationPorts, endpoints, navigation/playback, identity — unchanged. Only the intra-host write ordering was corrected back to the original contract.

### 24.7 Verification

| Check | Result |
|---|---|
| Architecture guards (generation-progress, vbook — incl. new ordering pins) | PASS |
| `generateStore.analysis.test.ts` (incl. 2 new ordering regression tests) | 7/7 PASS |
| Full frontend suite | PASS (15 test files, +2 tests) |
| Frontend typecheck (`tsc --noEmit`) | CLEAN |
| Frontend build (`vite build`) | GREEN |

---

*Step-14A cancel observable-ordering fix completed; the Step-14 request/teardown separation retained, post-await settle order restored, regression-tested and guard-pinned.*

---

## 25. Step 15 — B6 Session-Status Boundary Audit ("phase" / "errorMessage")

**Status:** AUDIT ONLY — no production code changed, no packages created, no ownership moved. Only this document + audit-oriented guard pins.  
**Date:** 2026-09-14  
**Branch:** `c21.4-physically-extract-analysis-from-backend`  
**HEAD (baseline):** `325cb794ff689848ff4c31969f5bd81345ef1a29` ("fix(web): preserve generation cancel state ordering" — Step 14A complete)  
**Parent:** `0effeb0d8fff226b65c5e8aacaf8cc6fc890460f` (Step 14 prep)  
**diff parent..HEAD (audited baseline):** exactly 4 files — generateStore.ts (settle-leg split), generateStore.analysis.test.ts (ordering regression tests), generation-progress-contour.guard.test.ts (ordering pins), audit doc. The Step-14A commit contained no other changes.

### 25.1 Writer / reader inventory (complete, production, grep-verified at `325cb794`)

**Owner of the signal objects:** `generateStore.ts` (lines 227–232: `export const phase = signal<PlayerPhase>('IDLE')`, `export const errorMessage = signal<string | null>(null)`). Type is a structural mirror in fileStore (`FilePhase`) — a TYPE alias only, not a second value.

**Writers — `phase` (14 production assignment sites total — counting method: every raw `.value =` assignment statement on `phase`/`session.phase` in production sources (tests excluded), verified by grep at `259380bb`; no other write style (destructuring/aliasing) exists; READERS ARE NOT COUNTED):**

| # | File | Function | Value | Lifecycle event | Pre/post-await | Concurrent mutators |
|---|---|---|---|---|---|---|
| 1 | fileStore | `beginBookTransition` (171) | `LOADING_BOOK` | any File open flow starts (import/open/blank) | sync (pre-await) | any in-flight generation poll effects |
| 2 | fileStore | `importBookFromFile` (193) | `SCENE_READY` or `IDLE` | vbook import done (scenes fetched) | post-await (after POST + GET) | generation poll if a generation was running |
| 3 | fileStore | `importBookFromFile` (198) | `IMPORTING_TXT` | TXT path, pre-assets-check | post-await | — |
| 5 | fileStore | `importBookFromFile` (201) | `SCENE_READY`/`IDLE` | TXT path done (assets fetched) | post-await | — |
| 5 | fileStore | `importBookFromFile` (205) | `IDLE` | import failure catch | post-await (failure) | — |
| 6 | fileStore | `restoreBookSession` (273) | `SCENE_READY`/`IDLE` | cold-start restore load done | post-await (2 GETs) | deep-link/import race guarded by bookId re-checks |
| 7 | fileStore | `openBookById` (299) | `SCENE_READY`/`IDLE` | open-by-id done (assets fetched) | post-await | — |
| 8 | fileStore | `openBookById` (302) | `IDLE` | open failure catch | post-await (failure) | — |
| 9 | fileStore | `closeBook` (317) | `IDLE` | book closed (Create-New card / Settings delete) | sync (post `stopGenerationSession`) | — |
| 10 | fileStore | `createBlankBook` (347) | `SCENE_READY` | blank book created + loaded | post-await | — |
| 11 | fileStore | `createBlankBook` (351) | `IDLE` | blank creation failure | post-await (failure) | — |
| 12 | generateStore | `startGeneration` (572) | `SCENE_READY` | `/regenerate` accepted (build_id captured) | post-await | poll effects see SCENE_READY while RUNNING |
| 13 | generateStore | `settleGenerationSessionAfterCancel` (669) | `IDLE` | cancel request RESOLVED (Step 14A contract) | **post-await (pinned)** | none (Step 14A regression tests) |
| 14 | generateStore | `checkAndRestoreGenerationState` (730) | `GENERATING` | restore found active workers | post-await (2 GETs) | — |

**Writers — `errorMessage` (6 production assignment sites — same counting method; the previous version of this table incorrectly folded them into the phase rows as "#2/#6/#9/#10/#12", mixing signals — corrected to a separate table):**

| # | File | Function | Value | Lifecycle event | Pre/post-await |
|---|---|---|---|---|---|
| 1 | fileStore | `beginBookTransition` (172) | `null` | any File open flow starts | sync (pre-await) |
| 2 | fileStore | `importBookFromFile` (206) | error message | import failure catch | post-await (failure) |
| 3 | fileStore | `openBookById` (303) | error message | open failure catch | post-await (failure) |
| 4 | fileStore | `closeBook` (318) | `null` | book closed | sync |
| 5 | fileStore | `createBlankBook` (352) | error message | blank creation failure | post-await (failure) |
| 6 | generateStore | `settleGenerationSessionAfterCancel` (670) | `null` | cancel request RESOLVED | post-await (pinned) |

**No generation-failure path writes a message** — generation errors surface via `generationStatus='ERROR'` + GeneratePage's own fetch error handling; only File-flow failures use `errorMessage` today. Totals: **14 phase assignment sites (11 fileStore + 3 generateStore) + 6 errorMessage assignment sites (5 fileStore + 1 generateStore) = 20 sites across exactly 2 files.**

**Readers (production):**

| Reader | File | What it does | Order-dependent? |
|---|---|---|---|
| AppShell `playerPhase` | AppShell.tsx:117 | deep-link `/file`+`/navigate` bounce fallback: `SCENE_READY → '/play'` else `'/generate'` — reads whatever the LAST settling flow wrote; the primary path uses a fresh `GET /book`, phase is only the documented FALLBACK ("which import/restore already settled") | YES — explicitly consumes last-writer-wins semantics |
| GeneratePage `currentPhase` | GeneratePage.tsx:59,186,207,283–287 | `isGenerating = GENERATING ‖ LOADING_BOOK ‖ isRegenerating` — gates active-worker detection, summary text, poll gap coverage; reads BOTH slices' values (a file import's `LOADING_BOOK` suppresses generation UI identically to its own `GENERATING`) | YES — depends on file-flow values; writers' order matters during interleavings |
| FilePage (web-file package) `phaseNow` | packages/animastor-web-file/src/FilePage.tsx:75–95 | status line: error > export > importing > loading; `sceneReady` gate for export/media; **reads `GENERATING` as "loading"** — i.e. the generation slice's value is part of the File screen's contract | YES |
| fileAdapters | fileAdapters.ts:32,55,75 | passes signal objects by reference into SessionSeam/FilePorts (wiring, no reads) | n/a |
| `settled at parent acf7bf30` consumer check | — | playbackStore (web-player) does NOT read the shared `phase` — it has its own internal `uiState.phase` projection (verified: package comment-only references to generateStore) | — |

**Set/reset helpers:** only the seam-level ones (`setRegenerating`, `stopGenerationSession`, `markImportIncomplete`) — none write `phase`/`errorMessage` directly except through the flows above. No setter exists for phase/errorMessage (deliberately — §19.2/§20.5 guard forbids one in the identity module).

### 25.2 Reconstructed state machine (event → prev → writer → new → observable consequence)

| Event | Prev phase | Writer | New phase | Consumers | Observable consequence |
|---|---|---|---|---|---|
| loadBook via import (vbook, scenes>0) | any | fileStore #1,#2 | LOADING_BOOK → SCENE_READY | FilePage status, GeneratePage isGenerating (loading) | UI shows loading then ready; bounce fallback would pick `/play` |
| loadBook via import (vbook, scenes=0) | any | fileStore #1,#2 | LOADING_BOOK → IDLE | same | ready → `/generate` navigation decision |
| import TXT | any | fileStore #1,#3,#4 | LOADING_BOOK → IMPORTING_TXT → SCENE_READY/IDLE | FilePage (importing→loading stages), GeneratePage | two-stage loading visible on File screen |
| import failure | any | fileStore #5 | → IDLE + errorMessage | FilePage error line (error > all) | error shown on File screen until next flow clears it |
| restore session (cold start) | IDLE | fileStore #6 | → SCENE_READY/IDLE | AppShell fallback, GeneratePage | user "has" a book without explicit action |
| open by id / deep link | any | fileStore #7/#8 | → SCENE_READY/IDLE (+error) | same as import | — |
| blank book create | any | fileStore #10/#11 | → SCENE_READY (+AI bubble flag) | GeneratePage, AppShell | Edit-ready state |
| generation start | any (typically SCENE_READY) | generateStore #12 | → SCENE_READY (unchanged value; status→RUNNING separately) | GeneratePage (isRegenerating drives UI) | phase is NOT the generation-progress signal — status is |
| generation progress (SSE/poll) | — | **no phase writer** | — | GeneratePage via vbookProgress/rows | progress lives OUTSIDE phase — only restore writes GENERATING |
| restore finds active workers | any | generateStore #14 | → GENERATING | GeneratePage isGenerating, FilePage loading | re-arm after backend restart |
| generation success | GENERATING/IDLE | computeProgressRows finalize (no phase write — SUCCESS is `generationStatus`) | unchanged | GeneratePage SUCCESS pulse | phase and status diverge by design |
| generation cancel (Step 14A) | any | generateStore #13 | → IDLE + errorMessage=null, POST-await split | GeneratePage stops, FilePage loading ends | **settle only AFTER request resolves** (regression-pinned) |
| close/reset | any | fileStore #9 (+ teardown leg) | → IDLE + errorMessage=null | all readers | full reset, generation status→IDLE via `stopGenerationSession` |

**Interleavings file ↔ generation (the cases that matter):**

1. **Import while a generation runs** (user opens another book mid-generation): fileStore #1 writes `LOADING_BOOK` immediately (sync), THEN `beginBookTransition` bumps the poll token + `stopGenerationSession` is NOT called here — but `resetProgressState`/`clearVBookProgress`/`bumpVBookPollToken` kill the poll loop; the old generation's SSE events stop being routed (epoch bump only on explicit stream stop — but token kill stops the poller; SSE events keep routing until `stopProgressStream`… mitigated because `import_complete`/`generation_complete` latches were reset and `importMessages` cleared). The `LOADING_BOOK` write is intentionally IMMEDIATE so a bounce/GUI never shows the old book as ready. Then #3 settles SCENE_READY for the NEW book. A late in-flight generation write (#13/#15) after that would clobber the new book's phase — but no such writer exists post-transition: `startGeneration` requires a user action, `checkAndRestore` early-returns while `isRegenerating` … which was just set `false` by the seam. **This is the sharpest edge**: a `checkAndRestoreGenerationState` tick (2.5s-delayed, mounted GeneratePage) racing an import could see `isRegenerating=false` and re-arm `GENERATING` for the NEW book if the backend still reports active workers for it — last-writer-wins absorbs this (the value converges to whatever the backend actually reports for the CURRENT bookId).
2. **Cancel while an import runs**: cancel settles `IDLE` post-await (14A); if the import settled `SCENE_READY` first, cancel's `IDLE` wins last → FilePage shows idle/error-free for a book that IS ready. Reverse order: import settles after cancel → SCENE_READY wins. **Both orders are observable and accepted today** — the UI converges because FilePage/GeneratePage re-derive from bookId+fetches on the next tick.
3. **Restore racing import** (documented in fileStore): guarded by explicit `session.bookId.value` re-checks, not by phase.

**Conclusion:** the "last writer defines the observable session status" rule is NOT an accident — AppShell's documented fallback comment ("which import/restore already settled"), FilePage reading `GENERATING` as loading, and GeneratePage reading `LOADING_BOOK` as generating all DEPEND on it. Convergence after races comes from re-derivation (bookId + fresh fetches), not from a priority scheme. **It is part of the public behavior → documented as the B6 contract, and pinned by the new guard assertions (§25.6).** Ownership cannot be changed safely without changing that contract.

### 25.3 Ownership variants

| Criterion | A. fileStore owns | B. generateStore owns (status quo) | C. separate SessionStatus boundary |
|---|---|---|---|
| Writers that move | fileStore writes natively; generateStore's 3 sites need an injected seam (fileStore → generateStore port) | none move | ALL 20 assignment sites (14 phase + 6 errorMessage) move behind ports on BOTH sides |
| Readers that change | AppShell/GeneratePage/FilePage must consume fileStore (or a new export) — FilePage is in the web-file package whose ports.ts already carries `phase`/`errorMessage` by reference (would keep working) | unchanged | all readers re-point to the module/package |
| Seams/ports needed | a GenerationStatusSeam (generateStore writing fileStore-owned signals) — inverts today's SessionSeam direction; authStore untouched | none | a full write-port API (setPhase/setError/stepTransitions) + a read API — the "SessionStatusPort" the Step-13 audit already rejected |
| Observable ordering | **changes**: cancel (#14, generateStore) and checkAndRestore (#15) would cross a seam — still same-tick, but the writer set splits across modules; interleaving semantics preserved only if seam calls are synchronous (they would be) | unchanged | unchanged IF all writes go through sync ports; but any package-ization adds await/delivery decisions |
| Cycles | fileStore→(new port)←generateStore is fine, but fileStore already consumes generateStore via injected seams (no import) — A adds a SECOND cross-direction seam pair (generateStore writing fileStore state) = bidirectional seam coupling | none | module must be imported by both stores + wired in fileAdapters; no cycle if dependency-neutral |
| Compatibility with packages | web-file's ports.session already exposes phase/errorMessage — A actually FITS the web-file port shape; web-book-session unaffected (identity ≠ status, §19.2); web-generator unaffected | fits (status quo) | a new package beside web-book-session; duplicates its "host-owned signals consumed via ports" pattern but for TWO writer modules |
| API/ports to introduce | GenerationStatusSeam (~3 methods) | none | SessionStatusPorts: write (6+ transition methods or raw set), read hooks, possibly transition validation — a real API surface for 2 signals |
| Verdict | **WORSE than B**: solves nothing (the dual-writer remains, just seam-routed), adds an inverted seam, and mis-locates ownership — File flows are not "the session"; they are one of TWO flows that settle status | **keep** | **NOT justified today**: the boundary owns 2 signals + 20 assignment sites (14 phase + 6 errorMessage) spread across two flows with interleaved, order-dependent semantics (§25.2) — packaging it now creates a state-pass-through, not a domain |

**C deep-dive — would `@animastor/web-session-status` be a natural boundary?**
- What it would own: the 2 signals + a transition table. What transitions does it OWN? None of its own — every transition is initiated by a flow (file or generation); the module would hold no decision logic, only storage + (maybe) validation. That is the definition of an ambient state object.
- Ports needed: read (AppShell/GeneratePage/FilePage) + write (both stores) — i.e. every consumer gets a port to what is currently a direct signal read. Blast radius: 4+ files, 3 packages' worth of port surfaces.
- Domain-neutral? Only by being EMPTY of logic — a neutral container. To have logic it would need to know about generation (GENERATING/restore semantics) AND file flows (LOADING_BOOK/IMPORTING_TXT) — at which point it imports both domains' concepts and becomes a coupling hub.
- Giant-ambient-object risk: **high** — exactly the "artificial wrapper around host state" the extraction rules forbid.
- **No natural physical boundary exists today.** A session-status boundary becomes natural only if (a) transitions gain real decision logic (e.g. priority/merge rules replacing last-writer-wins), or (b) a third writer flow appears. Neither holds at this HEAD.

### 25.4 errorMessage — part of session status or flow-local error?

Facts: `errorMessage` is written ONLY on file-flow failures (3 sites) and cleared on file-flow starts/close + cancel settle. Generation failures do NOT write it (they use `generationStatus='ERROR'` + local page state). Reader: FilePage (error line) only — AppShell and GeneratePage do NOT read it.

So: `phase` = genuinely shared cross-slice session status (6 values spanning both flows, 2 readers across packages). `errorMessage` = **effectively file-flow-local error display state that happens to live beside `phase`**, plus one clearing write from the cancel settle (Step 14A order-preserved).

**Could they be split (phase=session status; errorMessage=file-flow local)?** Yes, mechanically: move `errorMessage` into fileStore's File-owned signals (it already owns `importMessages`), update FilePage's `ports.session` read (web-file ports.ts change — package boundary edit, NOT production behavior), keep the cancel-settle `errorMessage=null` as a fileStore seam call or drop it (it only clears file-flow errors, and `closeBook`/`beginBookTransition` already clear them on every transition). Consequences: SessionSeam shrinks by one signal; the B6 surface shrinks to `phase` alone; web-file package ports + tests change; behavior identical (the clear-on-cancel write is redundant with the next begin-transition). **Assessment: a real, small, honest simplification — but it touches the web-file package's public port and 3 test files, and it changes nothing about the remaining B6 dual-writer on `phase`. Not executed in this audit-only step; recorded as the first candidate IF a future step is authorized to touch web-file's port surface.** Until then, both signals stay co-located as ONE boundary (guard-pinned adjacency, §25.6).

### 25.5 Race / interleaving semantics — the contract

- `await` boundaries: all 15 writes are synchronous signal writes; their POSITION relative to their flow's awaits is the observable contract (Step 14A pinned the cancel one; fileStore's writes are position-pinned by fileStore.test.ts expectations).
- Signal effects/timers/SSE callbacks: can run between any two awaits — they observe whatever the last writer wrote (verified: GeneratePage reads `phase.value` in render; AppShell reads it in an effect fallback; FilePage in render). No debounce, no merge layer exists.
- The rule "**last writer defines observable session status; races converge via re-derivation (bookId + fresh fetches), not via priority**" is therefore part of public behavior. → **Documented as the B6 contract.** Ownership change requires replacing last-writer-wins with an explicit merge/priority design FIRST — that design does not exist.
- Proof that ownership cannot be changed safely today: variants A and C both preserve last-writer-wins only by keeping all writes synchronous through seams — they relocate the same signals without improving any property the contract lacks, while adding indirection.

### 25.6 Guards (audit-oriented additions only)

`session-status-contour.guard.test.ts` (restructured in Step 15A, §26 — the 3 assertions originally landed in the generation-progress guard were relocated to this dedicated boundary guard): the phase/errorMessage declarations stay adjacent in generateStore (one boundary); fileStore writes exclusively via `session.phase.value`/`session.errorMessage.value` (never its own declaration); **no production module outside {generateStore, fileStore} writes phase/errorMessage** (undocumented third writer fails with a message pointing at §25). No Step 14/14A guard content rewritten; identity owner (web-book-session), package boundaries, reverse-dependency bans all unchanged and re-verified passing.

### 25.7 Verification

| Check | Result |
|---|---|
| Architecture guards (9 guard files incl. the new session-status-contour guard) | PASS |
| Full frontend suite | **175/175 PASS** (14 files; +3 audit assertions in the new guard) |
| Frontend typecheck (`tsc --noEmit`) | CLEAN |
| Frontend build (`vite build`) | GREEN (405 KB JS) |
| Production code changes in this Step-15 commit | **NONE** — tests/guards + audit doc only |
| GitHub Combined Status | statuses: [] — no independent CI confirmation |

### 25.8 Verdicts

| Question | Verdict |
|---|---|
| Is there a natural `web-session-status` package boundary? | **NO** — the boundary would own zero decision logic and two signals written by two flows with order-dependent interleavings; it would be an ambient state pass-through (§25.3-C) |
| Best owner among A/B/C | **B — generateStore keeps ownership** (status quo): the generation slice already hosts the shared-state cluster (status, isRegenerating), fileStore already reaches it through the SessionSeam by reference, and A/C add seams without changing any property |
| Can ownership change safely today? | **NO** — last-writer-wins is public behavior (AppShell fallback, FilePage GENERATING-as-loading, GeneratePage LOADING_BOOK-as-generating); replacing it requires a merge/priority design that does not exist |
| errorMessage split candidate | **REAL but NOT EXECUTED** — errorMessage is de-facto file-flow-local; a split touches the web-file package port surface and shrinks B6 to `phase` alone; recorded as the first candidate for a future authorized step (§25.4) |
| **B6 session-status boundary** | **NOT READY** for extraction; ownership stays host-side in generateStore |
| **Next physical extraction candidate** | **NO NEXT PHYSICAL EXTRACTION YET** — consistent with Steps 13/14; the only recorded future candidates are (1) the errorMessage split (needs web-file port touch) and (2) a session-status merge design if last-writer-wins is ever deemed insufficient |

### 25.9 Blockers (B6, now precise)

1. **Last-writer-wins is load-bearing public behavior** — three readers across two packages depend on it; no merge/priority design exists to replace it (§25.5).
2. **errorMessage is mis-scoped but co-located** — splitting it requires touching the `@animastor/web-file` package's public ports surface (§25.4).
3. **20 assignment sites across two flows** — any boundary must either port all of them or inherit them; both outcomes are wrappers today (§25.3).
4. Unchanged from Step 13: producer-bus inversion risk and nav-pulse/regeneration host coupling remain outside this boundary.

---

*Step-15 B6 session-status boundary audit completed on this branch; audit-only — no production behavior changed, no packages created, ownership unchanged; last-writer-wins documented as the B6 contract and guard-pinned.*

---

## 26. Step 15A — Session-Status Audit Inventory Correction

**Status:** DOC/GUARD CORRECTION — no production code changed, no behavior change, no verdict change.  
**Date:** 2026-09-14  
**Branch:** `c21.4-physically-extract-analysis-from-backend`  
**HEAD (baseline):** `259380bbab08b793214ea5224f5e598326a252b1` ("audit(web): analyze session status boundary" — Step 15 complete)  
**Parent:** `325cb794ff689848ff4c31969f5bd81345ef1a29` (Step 14A)  
**diff parent..HEAD (audited baseline):** 2 files — audit doc (Step 15) + generation-progress-contour.guard.test.ts (Step-15 audit pins). No production changes in the baseline commit.

### 26.1 The inconsistency found

Step 15 carried three mutually contradictory counts: the §25.1 header said "`phase` (18 production write sites total)", the §25.1 table listed 15 rows, and the summary/commit narrative said "15 phase write sites / 6 errorMessage write sites". Root cause: the first Step-15 grep conflated signals — errorMessage rows (#1/#6/#9/#10 in fileStore and the cancel settle in generateStore) were folded into the phase table, inflating the count, and the header was never updated to match the table.

### 26.2 Fresh inventory + counting method

Method (fixed, mechanical): count every raw `.value =` **assignment statement** on `phase`/`session.phase` and `errorMessage`/`session.errorMessage` in production sources (`frontends/app/src`, tests excluded). Readers are NOT counted. No other write style exists in the codebase (no destructured/aliased signal writes — grep-verified); helper functions/seams write only through these literal assignment statements, so assignment sites are the atomic unit. Two rows in different functions of one lifecycle operation count as two sites.

**Result: `phase` = 14 assignment sites (fileStore 11: lines 171, 193, 198, 201, 205, 273, 299, 302, 317, 347, 351; generateStore 3: lines 572, 669, 730). `errorMessage` = 6 assignment sites (fileStore 5: lines 172, 206, 303, 318, 352; generateStore 1: line 670). Total 20, across exactly 2 files.**

Completeness re-check: all fileStore flows covered (beginBookTransition/import/open/restore/close/createBlank), all generateStore writes covered (startGeneration/cancel settle/checkAndRestore), no writer exists in callbacks/effects/timers outside these functions (generation success deliberately writes NO phase — SUCCESS lives on `generationStatus`; regeneration writes no phase). The state-machine table (§25.2) row references were renumbered to match.

### 26.3 Guard decision

The 3 Step-15 assertions were topically mis-placed in `generation-progress-contour.guard.test.ts` (they pin the session-status boundary, not the generation-progress package contour). Relocated verbatim to a dedicated **`session-status-contour.guard.test.ts`** (3 assertions, 1 group). The generation-progress guard keeps a one-line pointer comment; Step 14/14A guard content untouched. Verified: no duplication, no structure cost — the relocation makes the guard file match its boundary one-to-one.

### 26.4 Explicit record

- Exact `phase` writers: **14 assignment sites** (11 fileStore + 3 generateStore).
- Exact `errorMessage` writers: **6 assignment sites** (5 fileStore + 1 generateStore).
- Counting method: raw `.value =` assignment statements in production sources; readers excluded; no other write style exists.
- Readers (3: AppShell, GeneratePage, web-file FilePage + wiring-only fileAdapters) are listed separately in §25.1 and are NOT included in the writer counts.
- **Production behavior: 100% unchanged** — no production file touched in this step.

### 26.5 Verdict

Unchanged by the correction (fresh inventory found no real contradiction beyond the counting errors): B6 session-status boundary **NOT READY** for physical extraction; ownership stays host-side; **NO NEXT PHYSICAL EXTRACTION YET** (§25.8 stands, with §25.1/§25.3/§25.9 numbers corrected to 14/6/20).

---

*Step-15A inventory correction completed; documentation counts reconciled to the mechanical count, session-status pins relocated to their own boundary guard; production code unchanged.*
