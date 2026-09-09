# Navigator Module Extraction Audit — Navigator contour → `@animastor/navigator`

**Status:** Phase 0 reconnaissance COMPLETE (extraction NOT performed — this document records the audit only).
**Date:** 2026-09-09
**Baseline:** HEAD `8987fb84` ("arch(generation): add module extraction reconnaissance"). All measurements taken against this tree; production runtime untouched.
**Scope:** frontend web app (`frontends/app/src`) only. Android parity is contractual (`NavigateFragment.kt` / `BackendApi.kt`), not code-shared. Backend is a contract only (its contours are already packages: `@animastor/editor`, `@animastor/player`).
**Related:** `file-module-extraction-audit.md` (sister audit), `editor-module-extraction-audit.md` (frontend-stays-app-code precedent), `PLAYER_ROUTE_SPLIT_CHECKLIST.md`, `MODULAR_PRODUCT_ARCHITECTURE.md`.
**Guards added:** `frontends/app/src/architecture/file-navigator-contour.guard.test.ts` (11 assertions, shared with the File audit) — freezes entry points, the allowed-import boundary of both pages, the reverse-dependency boundary, and the state-module cycle set.

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
1. **Behavioral fork on `isDesktop`** (`NavigatePage.tsx:85`, `308`, `336`, `349`): mobile unit-tap = select + `navigate('/play')` (Android `switchToPlayTab()`); desktop = select-only, playback requires dbl-click or the active-row ⏯ button. A consumer embedding `@animastor/navigator` outside the desktop query would silently change semantics — the fork must be an explicit prop/port.
2. **`data-nav-active` DOM contract**: scroll-into-view effect queries `[data-nav-active="true"]` — an internal selector contract between `renderItem` and the scroll effect (stays internal, but e2e/UI tests would couple to it).
3. **Preview URL grammar** in `UnitThumb` (`/preview/{book}/{ch}/{sc}/{iu}?build_id=`) — duplicated knowledge of the Player media path shape (same grammar in EditPage:2760, PlayPage) — must go through `mediaUrl` port, never a local base.
4. **Reload triggers triad** (`bookId` change, `onPlaybackPrepared`, EXTERNAL invalidation) — an implicit freshness contract with the shell: the tree is expected to be current without manual reload on desktop where the panel stays mounted.
5. **`unitIndex` offset semantics** (`api/models.ts:489`, "unitOffset+1 when the scene exists") — positional math shared with AiAssistant; if the package vendored it, the two would drift.

## Phase 3 — Contract

Proposed public API of `@animastor/navigator`:

```ts
export function NavigatorPage(props: { ports: NavigatorPorts; embedded?: boolean }): JSX.Element;

export interface NavigatorPorts {
  bookSource: { bookId: Signal<string>; buildId: Signal<string>; onPlaybackPrepared(fn): () => void };
  position: { position: Signal<ActivePosition>; navigateTo(p: Partial<ActivePosition>): void };
  seek: { seekToPosition(ch: string, sc: string, unitIndex: number, unitId: string | null): Promise<void> };
  invalidations: { onResourceInvalidated(fn): () => void; bookResource(id: string): string };
  reload: { resilientReload<T>(opts): Promise<{ kind: 'success'; value: T } | { kind: 'failed' }>; sharedRecovery(): unknown };
  http: { getJson<T>(path: string): Promise<T>; mediaUrl(path: string): string };
  navigation: { navigate(route: string, opts?: { replace?: boolean }): void };
  shellMode: { isDesktop(): boolean };            // replaces useDesktopShell fork
  i18n: { t(key: string): string };
  icons?: { ImageOff: JSX.Element; Play: JSX.Element };  // UI-kit adapter
}
```

Ports and their purpose:
- `PositionPort` — the shared SharedPositionManager stays host (Edit/Play/Generate write it too); Navigator writes through `navigateTo` and reads `position`.
- `SeekPort` — the Player seam. Replaces the direct `playbackStore.seekToPosition` import (the audit's biggest coupling). Keeps the package free of the 2117-LOC store and of the `generateStore ⇄ playbackStore` cycle.
- `BookSourcePort` — session identity (`bookId`/`buildId`) and the generation-completion event, without importing `generateStore`.
- `InvalidationPort` + `ReloadPort` — the shared data-freshness pipelines; the module contributes a consumer, not a producer.
- `HttpPort` — `getJson` for `/book/:id` and `mediaUrl` for the preview grammar (media base stays host-owned).
- `NavigationPort` — `/play` route knowledge stays shell-owned (route table lives in `app/router`).
- `ShellModePort` — makes the desktop/mobile behavioral fork explicit and testable instead of a `matchMedia` side effect.
- `I18nPort` / icons adapter — shared presentation seams.

## Phase 4 — Test ownership

| Test | After extraction |
|---|---|
| Dedicated Navigator tests | **Do not exist today** — gap. `chapterLabel`/`sceneLabel`/`unitLabel`/`buildStructure` are pure functions and are the natural first package-owned unit tests (chapter override map, ≤3-chapter default expansion, position auto-expand, is_special cover/prologue labels) |
| `resilientReloader.test.ts` | Stays host (shared pipeline, not Navigator-owned) |
| `resourceInvalidations.test.ts` | Stays host (shared bus) |
| `playback*.test.ts` | Stay host (Player store — includes `seekToPosition` coverage) |
| Contour guards (`architecture/file-navigator-contour.guard.test.ts`) | Stay in the host app; freeze the 1-file contour + allowed imports until the package exists |

## Phase 5 — Extraction blockers

1. **N1 — `seekToPosition` direct import (PRIMARY).** `NavigatePage.tsx:14` imports the Player store. The package cannot take `playbackStore` (it would drag the whole player engine + media cache + the store cycle in). Requires the `SeekPort` seam. *Why a blocker: without it the package boundary is fictional.*
2. **N2 — `generateStore` session signals + `onPlaybackPrepared`.** Same reasoning; `BookSourcePort` required. *Why a blocker: `generateStore` is the app hub; importing it from a package would invert the dependency direction.*
3. **N3 — shared `positionStore`.** 27 LOC but shared by 5 modules; moving it would fork the SharedPositionManager. Must stay host behind `PositionPort`. *Why a blocker: it is the app's navigation infrastructure — exactly what the key question identified.*
4. **N4 — no dedicated tests.** Pure helpers are currently untested; extraction would move code without a safety net. *Why a blocker: cheap to fix first, expensive to discover later.*
5. **N5 — shell embedding + behavioral fork.** Desktop panel mount (`AppShell.tsx:274`) and the `isDesktop` fork (`NavigatePage.tsx:85,308,336,349`) are shell contracts; `useDesktopShell` must become an injected port or the package makes a global `matchMedia` assumption. *Why a blocker: embedding outside the desktop query would change unit-tap semantics silently.*
6. **N6 — freshness contract.** The reload-trigger triad must keep exact timing (bookId change / playbackPrepared / EXTERNAL invalidation) or the always-mounted desktop panel shows stale structure. *Why a blocker: behavioral, invisible in unit tests without characterization.*

No backend blockers: both consumed endpoints already live in extracted backend packages — HTTP is the contract.

## Phase 6 — Extraction plan (no implementation in this phase)

1. **Characterization tests first** — unit-test the pure helpers (`chapterLabel`/`sceneLabel`/`unitLabel`/`buildStructure` override-map semantics) and one integration test for the reload-trigger triad with fake ports (vitest, node env).
2. **Introduce `NavigatorPorts` in-app (no package yet)** — refactor `NavigatePage` to receive ports via props; default composition (`main.tsx`/`AppShell.tsx`) wires the current host modules. No behavior change; guard test still passes with the same allowed-import list minus store imports for the page.
3. **Move the file** to `src/modules/navigator/` (still in-app) with its new tests; verify desktop panel + mobile tab behavior unchanged.
4. **Cut `packages/animastor-navigator`** — physical move, `@animastor/navigator@0.1.0`, host keeps the ports wiring; peer-dependency on `preact`/`@preact/signals` per the repo's npm checklist pattern.
5. **Verify** — vitest + `tsc --noEmit` + smoke: mobile unit-tap → Play switch; desktop select/⏯/dbl-click; AI-patch invalidation refreshes tree; generation completion refreshes tree; no-book empty state.

## Final verdict

**READY WITH CONDITIONS**

| Metric | Value |
|---|---|
| Complexity | **LOW (2/5)** — 1 movable file, zero owned state, zero cycles, 2 consumers |
| Potentially movable files | **1** (`NavigatePage.tsx`, 407 LOC) |
| Host dependencies | **11** direct host modules |
| Ports | **9** (BookSource, Position, Seek, Invalidation, Reload, Http, Navigation, ShellMode, I18n/UI) |
| Cross-module coupling | **YES** — as a consumer of Player (seek), Generation (session/completion), Editor (canonical JSON + invalidations), Shell (panel + routes) |
| Key-question answer | **Navigator is part of the shell navigation infrastructure** (a stateless navigation *surface* over the shared `positionStore`), not an independent domain module. Extraction is viable only as a UI component package over ports |
| Main risks | (1) direct Player-store import must become a seam; (2) desktop/mobile behavioral fork must be explicit; (3) freshness-contract timing on the always-mounted panel; (4) no existing tests |
| Recommended extraction order | **Before File** — cheapest contour in the queue; validates the ports pattern the File slice split will need |
