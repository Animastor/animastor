# Navigator Module Extraction Audit — Navigator contour → `@animastor/web-navigator`

> **Package scope (fixed, `41016f23`+):** `@animastor/web-navigator` is a **specialized Preact/Web UI module** for the browser frontend (`frontends/app`). It is **not** a platform-independent or domain module: rendering is Preact JSX/DOM, the desktop/mobile fork is web-shell-specific (`matchMedia` port), and thumbnails/scroll behavior are web-specific. The Android/native Navigator (`NavigateFragment`) is a separate implementation — this package does not target it directly. Domain logic stays host-owned behind `NavigatorPorts`; a cross-platform `navigator-core` split, if ever needed, is a separate future task (NOT part of this package).

**Status:** Phase 0 reconnaissance COMPLETE + **Phase 1 boundary preparation COMPLETE** (ports in-app, extraction still NOT performed — `NavigatePage.tsx` has NOT moved, no package exists).
**Date:** 2026-09-09
**Baseline:** HEAD `8987fb84` ("arch(generation): add module extraction reconnaissance"). All measurements taken against this tree; production runtime untouched.
**Phase 1 prep (this change):** the Navigator surface now consumes only the injected `NavigatorPorts` contract; host stores are wired host-side in `app/navigatorAdapters.ts`. Contour guards extended (14 assertions) + 27 characterization tests added.
**Scope:** frontend web app (`frontends/app/src`) only. Android parity is contractual (`NavigateFragment.kt` / `BackendApi.kt`), not code-shared. Backend is a contract only (its contours are already packages: `@animastor/editor`, `@animastor/player`).
**Related:** `file-module-extraction-audit.md` (sister audit), `editor-module-extraction-audit.md` (frontend-stays-app-code precedent), `PLAYER_ROUTE_SPLIT_CHECKLIST.md`, `MODULAR_PRODUCT_ARCHITECTURE.md`.
**Guards:** `frontends/app/src/architecture/file-navigator-contour.guard.test.ts` (14 assertions, shared with the File audit) — freezes entry points, the allowed-import boundary of both pages, the reverse-dependency boundary, the state-module cycle set, the Navigator ports-only boundary (no direct store/infra imports from the page), the self-containment of `modules/navigator/ports.ts`, and the adapter composition seam.

---

## Executive summary

"Navigator" is **a stateless view/controller over the app's shared navigation infrastructure — NOT an independent stateful feature module**. The answer to the key question ("is Navigator a standalone feature or part of the shell/navigation infrastructure?") is: **it is part of the shell navigation infrastructure** — it owns zero stores, zero services, zero persistence. One page file (`pages/NavigatePage.tsx`, 407 LOC incl. pure label/structure helpers + `UnitThumb`), all durable state lives in host infrastructure (`positionStore` — the SharedPositionManager, `generateStore`, `playbackStore`, `resourceInvalidations`). On desktop it IS shell chrome: an always-mounted right panel of `AppShell` (`desktop-panel--navigator`), exactly like the File panel.

| Question | Answer (measured) |
|---|---|
| Own state store / service / cache | **NONE** — all state is component-local `useState` (`bookData`, `expandedScenes`, `chapterExpanded`, `items`, `posLabel`) rebuilt from global signals on every change |
| Reverse dependencies (who imports it) | **Exactly 2**: `main.tsx` (route `/navigate`) + `AppShell.tsx` (desktop panel) |
| Cycles through the page | **ZERO** — page is a leaf; the pre-existing `generateStore ⇄ playbackStore` cycle is 2 hops upstream and does not involve the page |
| Cross-module coupling | **YES, heavy as a consumer**: Player (`seekToPosition` — a direct import of the 2117-LOC playback store), Generation (`bookId`/`buildId`, `onPlaybackPrepared`), invalidation pipeline (EXTERNAL events produced by Edit/AiAssistant), shell (`useDesktopShell`, route `/play`) |
| Dedicated tests | **NONE** |
| Hidden dependencies | **YES** — desktop/mobile behavioral fork (`isDesktop` changes unit-tap semantics: select-only vs `switchToPlayTab()`); double-click contract on desktop; `data-nav-active` scroll contract; preview URL grammar (`/preview/{book}/{ch}/{sc}/{iu}?build_id=`) |

**Verdict: READY WITH CONDITIONS (LOW 2/5)** — the cheapest extraction in the queue (1 movable file, no state to fork), but the module must be honest about what it is: a *navigation surface component* over host ports, not a domain module.

---

## Phase 0 — Current contour

```
main.tsx ──route──▶ <NavigatePage path="/navigate" />
AppShell.tsx (desktop) ──▶ <NavigatePage /> always-mounted right panel
                            (desktop-panel--navigator, collapse prefs in localStorage)
NavigatePage.tsx (407 LOC)
  ├─ loadBook: getJson<BookData>(/book/:id) via resilientReload (loadingRef guard)
  ├─ reload triggers: bookId change · onPlaybackPrepared (generation done)
  │                   · onResourceInvalidated EXTERNAL (AI patch / other device)
  ├─ buildStructure: chapters → scenes → units (NavItem tree, pure)
  ├─ position bar: label from position signal + BookData
  ├─ auto-expand current scene; scroll to [data-nav-active]
  └─ interactions:
      chapter tap  → local expand/collapse (override map)
      scene tap    → local expand/collapse
      unit tap     → positionStore.navigateTo + playbackStore.seekToPosition
                     (+ navigate('/play') on mobile; desktop: explicit ⏯ button / dbl-click)
```

Own code: `chapterLabel` / `sceneLabel` / `unitLabel` (pure), `buildStructure` (pure), `UnitThumb` (self-contained), `NavItem` type — all page-local, no exports consumed elsewhere.

## Phase 1 — Dependency map

Direct imports of `pages/NavigatePage.tsx` (all measured):

| Dependency | Direction | Type | Can move? | Host port needed? |
|---|---|---|---|---|
| `preact`, `preact/hooks` | page → lib | external | NO (peer) | NO |
| `api/client` (`getJson`, `mediaUrl`) | page → host | shared infra (10 consumers) | NO | YES — `HttpPort` |
| `api/models` (`BookChapter`, `BookData`, `BookScene`, `BookUnit` types + `unitIndex`) | page → host | shared types + pure helper (`unitIndex` also used by AiAssistantPage) | types could duplicate — should NOT | YES — models adapter (types only) |
| `app/i18n` (`t`) | page → host | shared util (21 consumers) | NO | YES — `I18nPort` |
| `app/router` (`navigate`) | page → host | shell navigation (route table is shell-owned) | NO | YES — `NavigationPort` |
| `app/desktop` (`useDesktopShell`) | page → host | shell query (`min-width: 1180px`), exists precisely so pages don't import AppShell (cycle doc in `desktop.ts:1-6`) | NO | YES — `ShellModePort` |
| `state/generateStore` (`bookId`, `buildId`, `onPlaybackPrepared`) | page → host | Generation store (shared with 8 modules) | NO | YES — `BookSourcePort` |
| `state/positionStore` (`navigateTo`, `position`, `ActivePosition`) | page → host | **the** shared navigation state (SharedPositionManager; also Edit/Play/Generate/AiAssistant) | NO (27 LOC, shared by 5 modules) | YES — `PositionPort` |
| `state/resourceInvalidations` (`bookResource`, `onResourceInvalidated`) | page → host | invalidation bus (producers: EditPage `emitLocal`, AiAssistantPage `emitExternal`) | NO | YES — `InvalidationPort` |
| `state/resilientReloader` (`resilientReload`, `sharedRecovery`) | page → host | reload/retry layer over the bus (also Generate/AiAssistant) | NO | YES — `ReloadPort` |
| `state/playbackStore` (`seekToPosition`) | page → host | **Player store** (2117 LOC) — the single heaviest coupling; also Edit/Play | NO | YES — `SeekPort` (Player seam) |
| `app/icons` (`IconImageOff`, `IconPlay`) | page → host | shared UI (9 consumers) | NO | YES — UI-kit adapter |

Transitive closure (via the stores above, for completeness):

| Dependency | Reached through | Type | Can move? | Host port needed? |
|---|---|---|---|---|
| `api/client` (`API_BASE`, `retryWithBackoff`, `ApiError`) | playbackStore, resilientReloader | shared infra | NO | covered by ports |
| `api/models` (`sceneRefs`, `SceneRef`, …) | generateStore, playbackStore | shared types | NO | covered |
| `cache/mediaCache` | playbackStore | Player-internal Cache API | NO | NO (not touched by Navigator) |
| `state/playbackGate` | playbackStore | Player-internal math | NO | NO |
| `app/i18n` (`vbookStageLabel`) | generateStore | shared util | NO | NO (not used by page) |

Backend HTTP surface consumed (contract only):

| Endpoint | Backend owner (package) | Used by |
|---|---|---|
| `GET /book/:bookId` | `@animastor/editor` (`editor-routes.cjs:73`) | `loadBook` |
| `GET /preview/:bookId/:chapterId/:sceneId/:iuId` (+ `build_id`) | `@animastor/player` (`iu-media.cjs:281`, via `mediaUrl`) | `UnitThumb` |

## Phase 2 — Boundary analysis

**Internal dependencies (move):** `pages/NavigatePage.tsx` only — 1 file, 407 LOC, zero other artifacts.

**Host dependencies (stay, become ports):** the 11 host modules in the Phase 1 table. None are Navigator-owned: `positionStore` is the app-wide SharedPositionManager (5 consumers); `playbackStore` is the Player engine; `generateStore` is the session/generation hub; `resourceInvalidations`/`resilientReloader` are shared data-layer pipelines; `app/desktop` exists specifically to avoid AppShell cycles.

**Shared dependencies:** `position` signal (read + written by Edit/Play/Generate), `bookId`/`buildId` (session identity), the invalidation bus (Navigator is a pure consumer; producers are Editor's `emitLocal` and AiAssistant's `emitExternal` — Navigator extraction must not perturb producer timing).

**Cross-module dependencies:**
- Navigator → **Player**: `seekToPosition` (external seek; Player docs call Navigate/Edit the legal external-seek sources) + `navigate('/play')` route knowledge + `onPlaybackPrepared` (structure reload on generation completion — event originates in the Generation slice, forwarded by `wirePlaybackCoordination`).
- Navigator → **Editor**: reads the canonical book JSON that Editor serves (`GET /book/:id`) and reacts to Editor's `emitLocal` invalidations.
- Navigator → **Generation**: `bookId`/`buildId` session identity; `onPlaybackPrepared`.
- Navigator ↔ **Shell**: mobile tab + desktop persistent panel; `useDesktopShell` behavioral fork; `START_ROUTE`/`TAB_ROUTES` list `/navigate`.

**Cycles:** none through the page (verified: only `main.tsx` and `AppShell.tsx` import it; neither is imported back). Upstream store cycle `generateStore ⇄ playbackStore` is pre-existing and untouched by this contour. The `desktop.ts` comment (lines 1–6) documents the AppShell-cycle avoidance pattern Navigator already follows.

**Hidden dependencies:**
1. **Behavioral fork on `isDesktop`** (`NavigatePage.tsx:85`, `308`, `336`, `349`): mobile unit-tap = select + `navigate('/play')` (Android `switchToPlayTab()`); desktop = select-only, playback requires dbl-click or the active-row ⏯ button. A consumer embedding `@animastor/web-navigator` outside the desktop query would silently change semantics — the fork must be an explicit prop/port.
2. **`data-nav-active` DOM contract**: scroll-into-view effect queries `[data-nav-active="true"]` — an internal selector contract between `renderItem` and the scroll effect (stays internal, but e2e/UI tests would couple to it).
3. **Preview URL grammar** in `UnitThumb` (`/preview/{book}/{ch}/{sc}/{iu}?build_id=`) — duplicated knowledge of the Player media path shape (same grammar in EditPage:2760, PlayPage) — must go through `mediaUrl` port, never a local base.
4. **Reload triggers triad** (`bookId` change, `onPlaybackPrepared`, EXTERNAL invalidation) — an implicit freshness contract with the shell: the tree is expected to be current without manual reload on desktop where the panel stays mounted.
5. **`unitIndex` offset semantics** (`api/models.ts:489`, "unitOffset+1 when the scene exists") — positional math shared with AiAssistant; if the package vendored it, the two would drift.

## Phase 3 — Contract (FINAL, implemented in-app)

Dependency direction (enforced by guards):

```
main.tsx / AppShell.tsx (host composition)
        │ ports={navigatorPorts}
        ▼
app/navigatorAdapters.ts  ──implements──▶  NavigatorPorts (modules/navigator/ports.ts)
        │ imports host infra                                        ▲
        ▼                                                           │ consumes ONLY this
state/playbackStore · state/generateStore · state/positionStore ────┘ (via ports, never directly)
state/resourceInvalidations · state/resilientReloader
api/client · app/i18n · app/icons · app/router · app/desktop
```

The Navigator surface (`pages/NavigatePage.tsx`) imports **only**: `preact`, `preact/hooks`, `../api/models` (types + the pure `unitIndex` helper — shared types must not drift, audit hidden-dep #5), and `../modules/navigator/ports`. Everything else reaches it through the injected ports. `modules/navigator/ports.ts` is self-contained (imports only Preact types) — it becomes the package's public contract verbatim; the port payload types are Navigator-local structural types so the host adapter fails to compile if a host store type drifts.

Implemented contract (`modules/navigator/ports.ts`):

```ts
export interface NavigatorPorts {
  seek: { seekToPosition(chapterId, sceneId, unitIndex, unitId): Promise<void> };       // SeekPort (N1)
  bookSource: { bookId: Signal<string>; buildId: Signal<string>; onPlaybackPrepared(fn): () => void }; // BookSourcePort (N2)
  position: { position: Signal<ActivePosition>; navigateTo(p: Partial<ActivePosition>): void };        // PositionPort (N3)
  invalidations: { onResourceInvalidated(fn): () => void; bookResource(bookId): string };              // InvalidationPort
  reload: { resilientReload<T>(opts): Promise<ReloadResult<T>>; sharedRecovery(): NetworkRecoverySignal }; // ReloadPort
  shellMode: { isDesktop(): boolean };     // ShellModePort (N5)
  navigation: { navigateToPlay(): void };  // NavigationPort — /play literal stays host
  http: { getJson<T>(path): Promise<T>; mediaUrl(path): string };  // HttpPort — media base stays host
  i18n: { t(key: NavigatorI18nKey): string };                       // I18nPort
  icons: { Play(props): JSX.Element; ImageOff(props): JSX.Element }; // UI-kit adapter
}
```

Design decisions frozen by the implementation:

- **SeekPort** is a 1:1 passthrough of `playbackStore.seekToPosition` — identical async/error semantics, no Player state copy, no store import from the boundary.
- **BookSourcePort** keeps `bookId`/`buildId` as the host's signals (no source-of-truth fork); `onPlaybackPrepared` narrows the payload to `{ bookId, buildId }` — the only fields the Navigator reads.
- **PositionPort** passes the host signal object itself (identity preserved → identical reactivity); no `positionStore` duplication.
- **Invalidation/Reload** stay separate minimal contracts (`InvalidationPort`, `ReloadPort`); `resourceInvalidations`/`resilientReloader` are not moved and producers (Edit/AI) are untouched.
- **ShellModePort.isDesktop()** is a plain function in the contract; the host adapter backs it with a signal fed by the same `min-width: 1180px` matchMedia query as `useDesktopShell`, so a port-rendered Navigator stays live-reactive to the shell breakpoint (behavior parity; desktop select-only vs mobile select + `/play` fork unchanged).
- **NavigationPort.navigateToPlay()** has no route parameter — the `/play` literal lives only in `app/navigatorAdapters.ts`; no route table moves into the Navigator.
- **HttpPort/I18nPort/icons** are injected; `api/client`, `app/i18n`, `app/icons` are not copied and not imported by the boundary. `mediaUrl` keeps the preview URL grammar host-owned.

**Internal Navigator (future package contents):** `pages/NavigatePage.tsx` — the component, `buildStructure`, `chapterLabel`/`sceneLabel`/`unitLabel` (now exported pure functions taking the injected `t`), `NavItem`, `UnitThumb` (takes `mediaUrl` + the fallback icon as props).

**Host-owned (stays in app):** all stores, `api/client`, `app/i18n`, `app/icons`, `app/router`, `app/desktop`, `app/navigatorAdapters.ts` (the single composition seam), and the composition points `main.tsx` / `AppShell.tsx` (`<NavigatePage path="/navigate" ports={navigatorPorts} />` / `<NavigatePage ports={navigatorPorts} />`).

**Forbidden for the Navigator boundary** (guard-enforced): direct imports of `playbackStore`, `generateStore`, `positionStore`, `resourceInvalidations`, `resilientReloader`, `AppShell`, the host adapters file itself, `api/client`, `app/i18n`, `app/icons`, `app/router`, `app/desktop`.

## Phase 3.5 — Phase 1 prep performed (this change)

| Artifact | What |
|---|---|
| `src/modules/navigator/ports.ts` | the `NavigatorPorts` contract above — zero host imports, future public API |
| `src/app/navigatorAdapters.ts` | host-owned adapters: seek → `playbackStore`, bookSource → `generateStore` signals + `onPlaybackPrepared`, position → `positionStore`, invalidations/reload, shellMode → matchMedia-backed signal (same query as `useDesktopShell`), navigation → `navigate('/play')`, http → `api/client`, i18n, icons |
| `src/pages/NavigatePage.tsx` | refactored 1:1 to consume the injected ports; same file, same DOM, same interactions; pure helpers exported for tests |
| `src/main.tsx` / `src/app/AppShell.tsx` | composition: pass `ports={navigatorPorts}` |
| Contour guards | 14 assertions: original 11 kept (updated for the composed entry points + ports-only NAV allowed set), +3 new: boundary imports no store/infra module; `ports.ts` self-contained; adapter wires every host module |
| `src/modules/navigator/navigator.test.tsx` | 27 characterization tests (below) |
| `frontends/app/package.json` | devDeps `happy-dom`, `@testing-library/preact`, `@testing-library/dom` (test environment only) |

Not done (hard limits respected): no `packages/animastor-web-navigator`, `NavigatePage.tsx` not moved, backend/API untouched, no user-visible behavior change, no unrelated refactors, no shared-store changes.

## Phase 4 — Test ownership

| Test | Status |
|---|---|
| `src/modules/navigator/navigator.test.tsx` (27, ADDED in Phase 1 prep) | Characterization through fake ports, no host store imported: `buildStructure` (labels, "Chapter N — Title" digit rule, override map both directions, ≤3-chapter default, scene style/type grammar, active unit, `iu0000` fallback id, empty book); special chapter labels (cover/prologue/capitalized fallback); current-position auto-expand on mount + follow-position re-expand; position bar labels (positioned/fallback/empty); **desktop/mobile unit-tap fork** (mobile: `navigateTo` + seek + `/play`; desktop: select-only, dbl-click and ⏯ button → seek + `/play`, no ⏯ on mobile); seek args parity (`('ch-1','sc-1a',0,'iu-1')`) + seek skipped when the scene is not real; reload-trigger triad (playbackPrepared same-book re-fetch / foreign book ignored; EXTERNAL invalidation for `book:<id>` re-fetches, LOCAL and foreign resources ignored); preview thumbnail grammar via `HttpPort.mediaUrl`; `/book/:id` path via `HttpPort.getJson`; no-book empty state |
| Contour guards (`architecture/file-navigator-contour.guard.test.ts`) | 14 assertions in the host app — freeze the 1-file contour, the ports-only boundary, the adapter seam, entry points, reverse deps, and the state-module cycle set |
| `resilientReloader.test.ts` | Stays host (shared pipeline, not Navigator-owned) |
| `resourceInvalidations.test.ts` | Stays host (shared bus) |
| `playback*.test.ts` | Stay host (Player store — includes `seekToPosition` coverage) |

Blocker N4 (no dedicated tests) is RESOLVED as of Phase 1 prep.

## Phase 5 — Extraction blockers

1. **N1 — `seekToPosition` direct import (PRIMARY).** ~~Requires the `SeekPort` seam.~~ **RESOLVED (Phase 1 prep):** the page consumes `SeekPort`; `playbackStore` is wired only in `app/navigatorAdapters.ts`; guard-enforced.
2. **N2 — `generateStore` session signals + `onPlaybackPrepared`.** ~~`BookSourcePort` required.~~ **RESOLVED (Phase 1 prep):** `BookSourcePort` implemented; `generateStore` unreachable from the boundary (guard).
3. **N3 — shared `positionStore`.** **RESOLVED (Phase 1 prep):** `PositionPort` passes the host signal through; no fork; guard-enforced.
4. **N4 — no dedicated tests.** **RESOLVED (Phase 1 prep):** 27 characterization tests in `src/modules/navigator/navigator.test.tsx`.
5. **N5 — shell embedding + behavioral fork.** **RESOLVED (Phase 1 prep):** `ShellModePort.isDesktop()` injected; host adapter keeps the same 1180px query live-reactive via a signal; fork behavior pinned by tests (desktop select-only + dbl-click/⏯; mobile select + `/play`).
6. **N6 — freshness contract.** **CHARACTERIZED (Phase 1 prep):** the reload-trigger triad (bookId change / `onPlaybackPrepared` same-book / EXTERNAL `book:<id>` invalidation, LOCAL ignored) is pinned by tests through fake ports. The remaining risk (exact timing on the always-mounted desktop panel) is covered because the port fakes preserve the triad semantics 1:1.

No backend blockers: both consumed endpoints already live in extracted backend packages — HTTP is the contract.

## Phase 6 — Extraction plan (steps 1–2 DONE in this phase)

1. ~~**Characterization tests first**~~ — **DONE**: 27 tests, fake ports, vitest + happy-dom + `@testing-library/preact` (devDeps only).
2. ~~**Introduce `NavigatorPorts` in-app (no package yet)**~~ — **DONE**: `NavigatePage` receives `ports` via props; `main.tsx`/`AppShell.tsx` wire `navigatorPorts` from `app/navigatorAdapters.ts`; no behavior change; guards updated (11 kept + 3 new) and green.
3. **Move the file** to `src/modules/navigator/` (still in-app) with its tests; verify desktop panel + mobile tab behavior unchanged. Guards: `NAV_PAGE` path + reverse-dep filter update.
4. **Cut `packages/animastor-web-navigator`** — physical move, `@animastor/web-navigator@0.1.0`, host keeps the ports wiring (`ports.ts` → package `index.ts`); peer-dependency on `preact`/`@preact/signals` per the repo's npm checklist pattern. Decision deferred to that step: shared `api/models` types + `unitIndex` (currently imported by the page as types + pure helper — must not drift, see hidden dep #5).
5. **Verify** — vitest + `tsc --noEmit` + smoke: mobile unit-tap → Play switch; desktop select/⏯/dbl-click; AI-patch invalidation refreshes tree; generation completion refreshes tree; no-book empty state.

## Final verdict

**READY WITH CONDITIONS**

| Metric | Value |
|---|---|
| Complexity | **LOW (2/5)** — 1 movable file, zero owned state, zero cycles, 2 consumers |
| Potentially movable files | **1** (`NavigatePage.tsx`, 407 LOC) |
| Host dependencies | **11 direct host modules → now all behind 10 ports** (Phase 1 prep) |
| Ports | **10 implemented** (`seek`, `bookSource`, `position`, `invalidations`, `reload`, `shellMode`, `navigation`, `http`, `i18n`, `icons`) — contract in `modules/navigator/ports.ts`, adapters in `app/navigatorAdapters.ts` |
| Cross-module coupling | **YES** — as a consumer of Player (seek), Generation (session/completion), Editor (canonical JSON + invalidations), Shell (panel + routes) — all mediated by ports |
| Key-question answer | **Navigator is part of the shell navigation infrastructure** (a stateless navigation *surface* over the shared `positionStore`), not an independent domain module. Extraction is viable only as a **Preact/Web UI component package** over ports — the package is deliberately NOT platform-independent (no `navigator-core` split; Android/native UI out of scope) |
| Boundary status | **Ports-in-app COMPLETE**: the boundary imports no store/infra module (guard-enforced); remaining work is the physical move (Phase 6 steps 3–4) |
| Main risks | ~~(1) direct Player-store import~~ resolved; (2) desktop/mobile fork explicit + tested; (3) freshness triad characterized; (4) ~~no tests~~ 27 added |
| Recommended extraction order | **Before File** — cheapest contour in the queue; validates the ports pattern the File slice split will need |
