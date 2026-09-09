# File Module Extraction Audit — File contour → `@animastor/file`

**Status:** Phase 0 reconnaissance COMPLETE + **Phase 1-prep boundary COMPLETE** + **B1 state split COMPLETE (extraction NOT performed — no package exists yet)**.
**Date:** 2026-09-09
**Baseline:** HEAD `8987fb84` ("arch(generation): add module extraction reconnaissance"). All measurements taken against this tree; production runtime untouched.
**Scope:** frontend web app (`frontends/app/src`) only. Android parity is contractual (same API surface in `BackendApi.kt` / `FileFragment.kt`), not code-shared — same verdict as the Editor/Player audits. The backend is a contract, not a dependency to move (its contours are already packages: `@animastor/editor`, `@animastor/player`).
**Related:** `editor-module-extraction-audit.md` (frontend stays app code verdict), `PHASE_NEXT_MODULE_EXTRACTION_RECONNAISSANCE.md`, `MODULAR_PRODUCT_ARCHITECTURE.md`, `generation-module-extraction-reconnaissance.md` (the store this contour shares).
**Guards added:** `frontends/app/src/architecture/file-navigator-contour.guard.test.ts` (11 assertions, shared with the Navigator audit) — freezes entry points, the allowed-import boundary of both pages, the reverse-dependency boundary, the `animastor:open-file` hidden contract, and the `generateStore ⇄ playbackStore` cycle as the only permitted state-module cycle.

---

## Executive summary

"File" in the web app is **a real feature contour (import / open / create / close / export a book) whose UI is a 282-LOC leaf page but whose entire domain state lives inside the shared `generateStore` (1504 LOC)** — the app's central session/generation hub. There is exactly ONE File-owned source file (`pages/FilePage.tsx`) and one embedded state slice inside `state/generateStore.ts` (~260 LOC: phase/import/export/navigation-event signals + `importBookFromFile` / `openBookById` / `closeBook` / `createBlankBook` / `restoreBookSession` + session persistence).

| Question | Answer (measured) |
|---|---|
| Is File an independent feature contour? | **YES** — import/open/create/export/book-session is a coherent domain; entry `/` + `/file` (+ deep link `?book=`), desktop left panel |
| Is the contour physically isolated? | **NO** — the state slice is embedded in `generateStore.ts` between the Generate-screen and Playback-prepared sections |
| FilePage imports playbackStore/player directly | **NO** — page touches only `generateStore` + `api/client.getBlob` (clean page-level leaf) |
| Transitive reach of the File slice | **HIGH** — the slice functions mutate generation internals (`resetProgressState`, `clearVBookProgress`, `vbookPollToken`, `isRegenerating`, `dirtySummary`, `blankBookJustCreated`), position (`navigateTo`/`clearPosition`), and call `playbackStore.closeBook` through the documented `generateStore ⇄ playbackStore` runtime cycle |
| Backend surface | 11 endpoints across **three** backend packages: host (`import`, `export` family, `status`, `books`, `snapshot`) + `@animastor/editor` (`GET /book/:id`, `POST /book/blank`) + `@animastor/player` (`assets-state`) |
| Dedicated tests | **NONE** for the page; `state/__tests__/auth-book-session.test.ts` covers the session-stash slice (File-adjacent); `generateStore.analysis.test.ts` covers the analysis slice only |
| Hidden dependencies | **YES** — `window` CustomEvent `animastor:open-file` (AppShell → FilePage); AppShell reads `phase`/`bookId` as the desktop bounce mirror of File flows; `navigationEvent` one-shot contract |

**Verdict: READY WITH CONDITIONS (MEDIUM 3/5)** — the page is trivially movable; the work (and risk) is carving the state slice out of `generateStore` without disturbing the generation slice that shares it.

---

## Phase 0 — Current contour

What "File" is, measured at HEAD:

```
main.tsx ──routes──▶ <FilePage path="/" /> + <FilePage path="/file" />   (router.ts: START_ROUTE = '/file')
AppShell.tsx (desktop) ──▶ <FilePage /> always-mounted left panel
                            (desktop-panel--file, collapse prefs in localStorage)
                            └─ dispatches CustomEvent('animastor:open-file') ◀── hidden contract
FilePage.tsx (282 LOC) ── deep link ?book=/?open= → openBookById()
                        ── import picker/drag-drop   → importBookFromFile()
                        ── Create New Book           → closeBook() + createBlankBook() → navigate('/edit')
                        ── Library card              → navigate('/library')
                        ── Download section          → getBlob(/book/:id/{download,storyboard,audio,export})
                        ── consumes navigationEvent  → navigate('/play'|'/generate')
```

State slice owned by File but hosted in `state/generateStore.ts`:

| Slice | generateStore.ts lines | Role |
|---|---|---|
| `phase`, `importMessages`, `errorMessage`, `isExporting`, `exportProgress`, `navigationEvent`, `setExporting`, `setExportProgress` | ~188–214 | "FILE SCREEN STATE (stage 3)" section — explicitly File-labeled by the store's own comments |
| `persistBookSession`, `clearBookSession`, `userStashKey`, `stashBookSessionForUser`, `restoreStashedBookSessionForUser`, `loadBook` | ~123–180 | localStorage book session (also stashed per-user by `authStore`) |
| `importBookFromFile` | 1300–1341 | POST /book/import → loadBook → playbackPrepared → navigationEvent |
| `restoreBookSession` | 1362–1416 | cold-start / login restore (called from `main.tsx` + `Root` auth effect) |
| `openBookById` | 1418–1448 | deep-link open |
| `closeBook` | 1451–1466 | resets BOTH view models (calls `playbackStore.closeBook` — the documented runtime cycle) |
| `createBlankBook` | 1477–1504 | POST /book/blank (Editor backend contour) → navigate to /edit; sets `blankBookJustCreated` (read by AppShell AI bubble) |

Reverse consumers of the slice (stay in host):
- `main.tsx` — boot-time `restoreBookSession()`, auth-transition restore
- `authStore.ts` — `stashBookSessionForUser` / `restoreStashedBookSessionForUser` (logout/login isolation)
- `AppShell.tsx` — reads `phase` (bounce mirror for panel routes) and `bookId`; `blankBookJustCreated` AI-bubble flag
- `GeneratePage.tsx` — shares `phase`/`errorMessage` rendering patterns and `resetProgressState` interplay (generation slice, not File)

## Phase 1 — Dependency map

Direct imports of `pages/FilePage.tsx`:

| Dependency | Direction | Type | Can move? | Host port needed? |
|---|---|---|---|---|
| `preact`, `preact/hooks` | page → lib | external | NO (peer) | NO |
| `app/i18n` (`t`, `tf`) | page → host | shared util (1780 LOC, 21 consumers) | NO | YES — `I18nPort` (`t`/`tf`) |
| `app/router` (`navigate`) | page → host | shell navigation | NO | YES — `NavigationPort` |
| `state/generateStore` (13 named exports) | page ↔ host | **own slice inside shared store** | SLICE moves | YES — slice moves in; `bookId`/`buildId` signals stay shared → `BookSessionPort` |
| `api/client` (`getBlob`) | page → host | shared infra (10 consumers) | NO | YES — `HttpPort` (getBlob + postMultipart/getJson/postJson used by slice) |
| `lib/ui` (`toast`) | page → host | shared UI (12 consumers) | NO | YES — `ToastPort` |
| `app/icons` (7 icons) | page → host | shared UI (9 consumers) | NO | YES — UI-kit adapter |

Transitive imports of the File slice (inside `generateStore.ts`) — the hidden coupling:

| Dependency | Direction | Type | Can move? | Host port needed? |
|---|---|---|---|---|
| `api/client` (`getJson`, `postJson`, `postMultipart`, `postJsonLong`, `putJson`, `sse`) | slice → host | shared infra | NO | YES — same `HttpPort` |
| `api/models` (`sceneRefs`, `BookData`, `ImportResponse`, `BookStatus`, `RecentBooksResponse`, `AssetsStateResponse`, …) | slice → host | shared types + pure helpers | NO | YES — models adapter (types) |
| `state/positionStore` (`navigateTo`, `clearPosition`) | slice → host | shared nav state (Edit/Play/Generate) | NO | YES — `PositionPort` |
| `state/playbackStore` (`closeBook`) | slice → host | **runtime cycle** (documented, pre-existing) | NO | YES — `PlayerPort.closeBook` |
| `state/generateStore` generation internals (`resetProgressState`, `clearVBookProgress`, `vbookPollToken`, `isRegenerating`, `importCompleteReceived`, `dirtySummary`, `emitPlaybackPrepared`, `blankBookJustCreated`, `startTimer`/`stopTimer`/`stopProgressStream` via closeBook) | slice → host | generation slice (stays host) | NO | YES — `GenerationResetPort` + `PlaybackPreparedPort` |
| `app/i18n` (`vbookStageLabel`) | slice → host | shared util | NO | YES — `I18nPort` |

Backend HTTP surface consumed (contract only — backend untouched by extraction):

| Endpoint | Backend owner (package) | Used by |
|---|---|---|
| `POST /book/import` (multipart) | host (`routes/book/import-routes.cjs:209`) | `importBookFromFile` |
| `GET /book/:id` | `@animastor/editor` (`editor-routes.cjs:73`) | import/open/create/restore flows, AppShell bounce |
| `GET /book/:id/status` | host (`status-routes.cjs:31`) | `restoreBookSession` |
| `GET /books` | host (`recent-books-routes.cjs:207`) | `restoreBookSession` fallback |
| `GET /book/:id/assets-state` | `@animastor/player` (`playback-queue.cjs:94`) | `importBookFromFile`/`openBookById` (TXT path) |
| `POST /book/:id/snapshot` | host (`parse-routes.cjs:113`) | `importBookFromFile` (vbook path) |
| `POST /book/blank` | `@animastor/editor` (`entity-crud-routes.cjs:671`) | `createBlankBook` |
| `GET /book/:id/download` | host (`export-routes.cjs:54`) | `doExport('book')` |
| `GET /book/:id/storyboard` | host (`export-routes.cjs:73`) | `doExport('storyboard')` |
| `GET /book/:id/audio` | host (`export-routes.cjs:100`) | `doExport('audio')` |
| `GET /book/:id/export` | host (`export-routes.cjs:120`) | `doExport('video')` |

## Phase 2 — Boundary analysis

**Internal dependencies (move into `@animastor/file`):**
- `pages/FilePage.tsx` (282 LOC: page + `DownloadCard` + `triggerDownload`)
- File state slice from `generateStore.ts` (~260 LOC: signals + import/open/close/create/restore/session functions)

**Host dependencies (stay, become ports):** `api/client`, `api/models`, `app/i18n`, `app/router`, `state/positionStore`, `state/playbackStore` (closeBook), `state/generateStore` generation internals, `lib/ui`, `app/icons`, `app/desktop` (shell embedding), `authStore` (session stash callers).

**Shared dependencies:** `generateStore.bookId`/`buildId` signals — the session identity is read by Generate/Play/Edit/AiAssistant/Settings/AppShell; it MUST stay the single source of truth in the host (a package-private copy would fork session state). Same for `phase`: File flows write it (`LOADING_BOOK`, `IMPORTING_TXT`, `SCENE_READY`, `IDLE`), the generation slice writes it (`GENERATING`, `DOWNLOADING`), AppShell reads it as the desktop bounce mirror — the signal is shared state, not File property.

**Cross-module dependencies:**
- File → Editor: `POST /book/blank` (Editor backend contour) + `navigate('/edit')` after creation (route-level).
- File → Player: `emitPlaybackPrepared` (warms the player after import/open) + `closePlayerBook()` via the cycle; `assets-state` (Player backend contour).
- File → Generation: import/open/create reset the generation slice (`resetProgressState`, `clearVBookProgress`, `isRegenerating`, timer/stream stops through `closeBook`).
- File → AiAssistant (indirect): `blankBookJustCreated` drives the shell AI bubble.

**Cycles:**
- `generateStore ⇄ playbackStore` — pre-existing, documented runtime-only cycle (`generateStore.ts:23`, test comment `playbackStore.test.ts:30` "Cut the runtime-only circular import"). The File slice sits ON this cycle (`closeBook` → `closePlayerBook`). No page-level cycles: FilePage imports nothing that imports FilePage.
- No cycle FilePage → AppShell (the panel mounts the page, the page never imports AppShell — hidden decoupling via `animastor:open-file` window event instead, which is itself a hidden global dependency, see below).

**Hidden dependencies:**
1. `window` CustomEvent `animastor:open-file` — dispatched by `AppShell.tsx:254` (DesktopStartState), listened by `FilePage.tsx:42-43`. Undeclared shell↔page contract; must be frozen as a documented port (or replaced by a prop callback) at extraction.
2. `navigationEvent` one-shot handshake: slice writes `'play'|'generate'|null`, page consumes-and-resets with its own `hasNavigated` ref guard. Consumer is only FilePage, but the reset protocol is implicit.
3. Deep-link param strip: page mutates `history.replaceState` itself (`?book=`/`?open=`) — URL contract lives in the page, not the router.
4. `localStorage` keys `animastor:currentBook` (+ `:user:<id>` stash) — written by the slice, read by `authStore` via the exported stash functions; key strings are a storage contract.
5. AppShell desktop bounce reads `phase` as a mirror of File-flow outcomes (`AppShell.tsx:101-118`) — File extraction must not change when `phase` settles.

## Phase 3 — Contract

Proposed public API of `@animastor/file`:

```ts
export function FilePage(props?: { embedded?: boolean }): JSX.Element;

// State surface (slice moves in; shared signals are received, not copied)
export const phase: Signal<PlayerPhase>;              // File-owned phases
export const importMessages: Signal<string[]>;
export const errorMessage: Signal<string | null>;
export const isExporting: Signal<boolean>;
export const exportProgress: Signal<number>;
export const navigationEvent: Signal<'play' | 'generate' | null>;

export function importBookFromFile(file: File): Promise<void>;
export function openBookById(param: string): Promise<void>;
export function createBlankBook(): Promise<string | null>;
export function closeBook(): void;
export function restoreBookSession(): Promise<boolean>;
export function stashBookSessionForUser(userId: string | null | undefined): void;
export function restoreStashedBookSessionForUser(userId: string | null | undefined): void;

export interface FilePorts {
  bookSession: { bookId: Signal<string>; buildId: Signal<string>; loadBook(id: string, build: string): void };
  generationReset: { resetProgressState(): void; clearVBookProgress(): void; setRegenerating(v: boolean): void; setDirtySummary(s: unknown): void };
  playbackPrepared: { emit(prep: PlaybackPrepared): void };
  player: { closeBook(): void };
  position: { navigateTo(p: Partial<ActivePosition>): void; clear(): void };
  navigation: { navigate(route: string, opts?: { replace?: boolean }): void };
  http: { getBlob; getJson; postJson; postMultipart };
  i18n: { t(key: string, ...args: unknown[]): string; tf(key: string, ...args: unknown[]): string };
  toast(msg: string, ms?: number): void;
}
```

Ports and their purpose:
- `BookSessionPort` — host owns the canonical `bookId`/`buildId` signals (shared with 6+ modules); the module writes through `loadBook` only.
- `GenerationResetPort` — import/open/create must reset generation UI state without importing the generation slice.
- `PlaybackPreparedPort` — import/open emit the player-warming event (Player package seam).
- `PlayerPort.closeBook` — replaces the `generateStore ⇄ playbackStore` import direction with an injected call.
- `PositionPort` — anchor shared position after import/open/create (positionStore stays host: shared with Edit/Play/Generate).
- `NavigationPort` — `/play` | `/generate` | `/edit` | `/library` routing stays host (route table is shell-owned).
- `HttpPort` / `I18nPort` / `ToastPort` / UI-kit adapter — shared infrastructure seams (same pattern as `editor-ports.cjs` on the backend).

## Phase 4 — Test ownership

| Test | After extraction |
|---|---|
| `state/__tests__/auth-book-session.test.ts` | **Moves to the package** (tests `stashBookSessionForUser`/`restoreStashedBookSessionForUser` — File session slice) |
| `generateStore.analysis.test.ts` | Stays host (generation slice) |
| `playback*.test.ts` (8 files) | Stay host (Player store) |
| New: FilePage import/export/restore unit tests | Belong to the package (do not exist today — gap, see Phase 5) |
| New: contour guards (`architecture/file-navigator-contour.guard.test.ts`) | Stay in the host app (freeze boundary before packages exist) |

## Phase 5 — Extraction blockers

1. **B1 — File state slice embedded in `generateStore.ts` (PRIMARY).** ~260 LOC of File functions live between generation sections of the 1504-LOC store and mutate generation internals directly (module-scope `vbookPollToken`, `importCompleteReceived`). Extraction requires a physical slice split + port injection; doing it naively forks session state or drags the whole store into the package. *Why a blocker: the package boundary would otherwise be fictional.*
2. **B2 — `generateStore ⇄ playbackStore` runtime cycle crosses the slice.** `closeBook()` calls `closePlayerBook()`. The package cannot import `@preact`-app playbackStore; requires the `PlayerPort` seam. *Why a blocker: ES module cycle across package boundary = load-order fragility.*
3. **B3 — Shell embedding contract.** AppShell mounts `<FilePage />` as an always-mounted desktop panel and triggers it via the `animastor:open-file` window event; the desktop bounce (`AppShell.tsx:101-118`) depends on `phase`/`bookId` settling exactly as the slice does today. *Why a blocker: behavioral contract; must be ported as an explicit prop/ports API without changing timing.*
4. **B4 — Cross-module API surface.** `POST /book/blank` is the Editor backend contour; `assets-state` is the Player contour. Frontend extraction is safe (HTTP is the contract) but the module's *product* boundary already spans two backend packages — documenting this is mandatory before slicing. *Why a blocker: not code-blocking, but blocks a clean "one module = one contour" story.*
5. **B5 — No dedicated File tests.** Only the session-stash test exists; import/export/restore flows are untested. Extraction without characterization tests would be unverified refactoring of a store every other screen depends on. *Why a blocker: risk control for B1/B2.*
6. **B6 — Shared `phase` signal.** Written by both slices, read by shell; splitting ownership needs an explicit contract (who owns which values) to avoid a forked phase.

## Phase 6 — Extraction plan (no implementation in this phase)

1. **Characterization tests first** — lock `importBookFromFile` / `openBookById` / `createBlankBook` / `closeBook` / `restoreBookSession` behavior (navigationEvent sequencing, phase transitions, `loadBook` calls, playbackPrepared emissions) against the current store (vitest, node environment, mocked `api/client` — pattern of `auth-book-session.test.ts`).
2. **Create `state/fileStore.ts` inside the app (no package yet)** — move the File slice verbatim; `generateStore` re-exports for one release (`export { importBookFromFile } from './fileStore'`) so no consumer changes; keep the same module-scope reset contract via injected `generationReset` object.
3. **Break the cycle for the slice** — `fileStore.closeBook` receives `playerPort.closeBook` from the composition root (`main.tsx`), removing the file-slice leg of the `generateStore ⇄ playbackStore` cycle.
4. **Move `pages/FilePage.tsx` next to `fileStore.ts`** (still in-app): page imports only its store + ports; replace the `animastor:open-file` window event with an explicit prop/ports callback (keep the event as a deprecated alias for one release if desired).
5. **Freeze the contour with guards** (this audit's guard test already pins the current boundary; update the allowed-imports list to the new relative layout).
6. **Only then cut `packages/animastor-file`** — physical move, `@animastor/file@0.1.0`, host keeps `FilePorts` wiring in `main.tsx`/`AppShell.tsx`; bump version, publish per the repo's npm checklist (`PHASE_8F_FIRST_NPM_RELEASE.md` pattern).
7. **Verify** — full vitest suite + `tsc --noEmit` + manual smoke: import .vbook, deep link `?book=`, create blank → /edit, four downloads, desktop panel mount + `animastor:open-file` trigger, logout/login stash.

## Final verdict

**READY WITH CONDITIONS**

| Metric | Value |
|---|---|
| Complexity | **MEDIUM (3/5)** — page is trivial; slice split out of the central store is the risk |
| Potentially movable files | **2** (`FilePage.tsx` 282 LOC + `fileStore` slice ~260 LOC) + 1 test file moves |
| Host dependencies | **6** direct host modules (i18n, router, generateStore, api/client, lib/ui, icons) + 2 transitive (positionStore, playbackStore) |
| Ports | **8** (BookSession, GenerationReset, PlaybackPrepared, Player, Position, Navigation, Http, I18n/UI — toast+icons grouped) |
| Cross-module coupling | **YES** — Editor (blank-book + /edit), Player (playbackPrepared, closeBook, assets-state), Generation (reset interplay), AiAssistant (blankBookJustCreated) |
| Main risks | (1) slicing the shared store without forking session/phase state; (2) the pre-existing store cycle; (3) desktop panel embedding contract; (4) no existing File tests to catch regressions |
| Recommended extraction order | **After Navigator** (Navigator is a 1-file move with zero state ownership — cheap warm-up) and after the `fileStore` in-app split lands; package cut last |

---

## Phase 1-prep — Extraction boundary PREPARED (2026-09-09)

**Status:** done, no package cut, no behavior change. Mirrors the Navigator prep (`navigator-module-extraction-audit.md`): the File surface now consumes ONLY the injected `FilePorts` contract; the shared infrastructure is wired in a single host-owned composition root.

### The seam

```
FilePage.tsx (UI, ports={filePorts})
   ↓
modules/file/ports.ts        ← FilePorts contract (imports only Preact types)
   ↓
app/fileAdapters.ts          ← host-owned composition root (ONLY seam)
   ↓
existing Animastor infrastructure (generateStore, api/client, i18n, router, icons, lib/ui)
```

### What was created

| File | Role |
|---|---|
| `frontends/app/src/modules/file/ports.ts` | `FilePorts` contract — File-local structural types; imports only `@preact/signals` + Preact types. Future public surface of `@animastor/file`. |
| `frontends/app/src/app/fileAdapters.ts` | Host composition root: wires generateStore signals/actions, `api/client.getBlob`, `t`/`tf`, `navigate`, `toast`, icons, `OPEN_FILE_EVENT`, deep-link `?book=`/`?open=` grammar into `filePorts`. |
| `frontends/app/src/modules/file/file.test.tsx` | Characterization tests through fake ports (19 tests — see below). |
| `frontends/app/src/app/fileAdapters.test.ts` | Wiring tests: session signals are the generateStore signals **themselves** (no fork); i18n resolves real keys; open-request subscribe/unsubscribe; deep-link read+strip. |

### FilePorts (measured from the audit, NOT a NavigatorPorts copy)

| Port | Seams | Notes |
|---|---|---|
| `session: FileSessionPort` | generateStore signals | `bookId`/`buildId`/`phase`/`errorMessage`/`importMessages`/`isExporting`/`navigationEvent` received as signals — host stays the single source of truth (B6). |
| `actions: FileActionsPort` | generateStore slice | `importBookFromFile`, `openBookById`, `closeBook`, `createBlankBook`, `setExporting`, `setExportProgress` — the B1 slice, injected until the split. |
| `http: FileHttpPort` | api/client | `getBlob` (export/download). |
| `i18n: FileI18nPort` | app/i18n | `t`/`tf` with a frozen `FileI18nKey` set. |
| `toast: FileToastPort` | lib/ui | export-failure toast. |
| `navigation: FileNavigationPort` | app/router | restricted to `/play` \| `/generate` \| `/edit` \| `/library`. |
| `openRequests: FileOpenRequestPort` | window event | hidden dep #1 made explicit (`animastor:open-file` — literal now lives ONLY in the adapter). |
| `deepLink: FileDeepLinkPort` | location | hidden dep #3 made explicit (`?book=`/`?open=` read + strip). |
| `icons: FileIconsPort` | app/icons | the 7 File glyphs. |

Deliberately **absent** (no Navigator mechanical copy): no SeekPort, no PositionPort, no invalidation/reload ports at the page level — the page never reached positionStore/playbackStore/resourceInvalidations/resilientReloader; those are reachable only inside the B1 slice, which stays host until the physical cut.

### Entry points (frozen by guards)

1. `main.tsx` — `<FilePage path="/" ports={filePorts} />` + `<FilePage path="/file" ports={filePorts} />`
2. `app/router.ts` — `START_ROUTE = '/file'`
3. `app/AppShell.tsx` — desktop always-mounted panel `<FilePage ports={filePorts} />` + dispatch via `OPEN_FILE_EVENT`

### Guards (architecture/file-navigator-contour.guard.test.ts — File section, Navigator guards untouched)

- FilePage imports ONLY `preact`, `preact/hooks`, `../modules/file/ports` — anything else is a failure ("File → frontends/app infrastructure = FORBIDDEN").
- `modules/file/**` may not import `api/`, `app/`, `state/`, `lib/`, `features/`, `pages/`, or AppShell.
- `modules/file/ports.ts` imports nothing but Preact types.
- Host → File only from `main.tsx`, `AppShell.tsx`, `fileAdapters.ts` (reverse-dependency allow-list).
- `fileAdapters.ts` must wire all seven infrastructure seams.
- `animastor:open-file` literal: exactly one definition (`fileAdapters.ts`); AppShell dispatches via `OPEN_FILE_EVENT`; FilePage must not contain it.
- Entry points + ports-composed mounts pinned as above.

### Characterization tests (19, all through fake ports — no host store)

Rendering (cards, i18n, empty-session disable rules), status priority (error > export > importing > loading, else hidden; LOADING_BOOK/GENERATING/DOWNLOADING mapping; import-messages last-line rule), download enable rules (book vs media), import picker + drag-drop, Create New Book (close → create → /edit; null id → no nav), Library → /library, one-shot `navigationEvent` handshake (initial consumption, reset, `hasNavigated` guard, re-arm on new import), export flow (path grammar incl. `build_id` encoding, progress, Saved status, failure toast, `isExporting` release, no-book/no-phase guards), open-request port, deep-link once-per-mount.

### Remaining blockers (unchanged from Phase 5)

B1 slice split (`generateStore` → `fileStore`), B2 `generateStore ⇄ playbackStore` cycle (resolved for the slice at extraction via the composition root), B4 cross-module backend surface, B6 shared `phase` contract. B3 (shell embedding) is now **prepared** (explicit ports), B5 (no tests) is **resolved** by the characterization suite. The physical `packages/animastor-file` cut is a separate task.

---

## B1 split — File state isolated from generateStore (2026-09-09)

**Status:** done, no package cut, no behavior change. Commit: `refactor(file): isolate file state from generate store` (branch `c21.4-physically-extract-analysis-from-backend`, baseline `48526385`).

### What became the owner of File state

`frontends/app/src/state/fileStore.ts` (host app code — NOT a package) now owns the whole File contour state + flows that were embedded in `generateStore.ts`:

| Moved into `fileStore.ts` | Former place |
|---|---|
| `importMessages`, `isExporting`, `exportProgress`, `navigationEvent` (signals), `setExporting`, `setExportProgress` | generateStore "FILE SCREEN STATE (stage 3)" section |
| `importBookFromFile`, `openBookById`, `closeBook`, `createBlankBook`, `restoreBookSession` | generateStore unified-import / deep-link / close sections |

The flows are verbatim ports: same endpoints, same phase transitions, same navigation-event sequencing, same error fallbacks. `generateStore` keeps NO re-exports of the moved functions (consumers were updated directly — `main.tsx`, `SettingsPage.tsx`; no shim release cycle needed inside one repo).

### What stayed shared (in generateStore) and why

| Shared state | Why it stays |
|---|---|
| `bookId`, `buildId`, `loadBook` + the localStorage session (`animastor:currentBook`, per-user stash) | Session identity read by Generate/Play/Edit/AiAssistant/Settings/AppShell/navigatorAdapters (7 consumers); the storage/stash contract is exercised by `authStore` and `state/__tests__/auth-book-session.test.ts`. A package-private copy would fork identity. `fileStore` writes it ONLY via the injected `session.loadBook` seam. |
| `phase` | Written by BOTH slices (File flows: LOADING_BOOK/IMPORTING_TXT/SCENE_READY/IDLE; generation slice: GENERATING/SCENE_READY/IDLE) and read by AppShell as the desktop bounce mirror (audit B6). One signal, two writers — fileStore writes through the same signal object. |
| `errorMessage` | `cancelGeneration()` (generation slice) clears it for both surfaces; keeping it host-side avoids a behavior change. |
| `dirtySummary`, `blankBookJustCreated` | Consumed by EditPage / AppShell; cleared/set by File flows through the seam. |
| Generation reset internals (`resetProgressState`, `clearVBookProgress`, `isRegenerating`, `vbookPollToken`, `importCompleteReceived`, timer/stream teardown) | Belong to the generation slice; exposed to fileStore as a narrow documented surface: `setRegenerating`, `bumpVBookPollToken`, `markImportIncomplete`, `stopGenerationSession` (new export). |

### The seams (fileStore ↔ host)

```
fileStore (File-owned state + flows)
   ├── session:          { bookId, buildId, phase, errorMessage, dirtySummary,
   │                       blankBookJustCreated, loadBook }        ← generateStore signals
   ├── generationReset:  { resetProgressState, clearVBookProgress,
   │                       setRegenerating, bumpVBookPollToken,
   │                       markImportIncomplete, stopGenerationSession } ← generateStore
   ├── playbackPrepared: { emit }                                   ← generateStore.emitPlaybackPrepared
   └── player:           { closeBook }                              ← playbackStore.closeBook
```

Wiring happens ONCE in `app/fileAdapters.ts` (`wireFileStore(...)` at module load) — the composition root remains the only place where the File contract meets host infrastructure. Un-wired use fails loudly (`wireFileStore() was not called`), no silent no-ops.

### generateStore ⇄ playbackStore cycle — RESOLVED (not broken, dissolved)

The cycle existed only because `generateStore.closeBook()` (File slice) released the player. The split moved that call with the slice: `fileStore.closeBook` now calls `playbackStore.closeBook` through the injected `player` seam, and **generateStore no longer imports playbackStore at all**. The remaining edge is one-directional (`playbackStore → generateStore.onPlaybackPrepared`), which is not a cycle. No duplicates, no temporary signal copies, no singletons, no Player behavior change. The guard suite was strengthened accordingly: the old "one frozen cycle allowed" rule became **"zero state-module cycles"** plus an explicit assertion that `generateStore.ts` does not import `playbackStore`.

### Guards (strengthened, none weakened)

All Phase 1-prep guards kept. Added in `architecture/file-navigator-contour.guard.test.ts`:

- File UI (`pages/FilePage.tsx` + `modules/file/**`) must not import `generateStore` **or** `fileStore` (both arrive via FilePorts).
- `fileAdapters.ts` must wire `../state/fileStore` + `../state/playbackStore` in addition to the previous seams.
- `fileStore.ts` must NOT re-declare `bookId`/`buildId`/`phase`/`errorMessage` (no fork) and must NOT import `generateStore`/`playbackStore` directly (seam-injected only).
- Zero state-module cycles (see above).

### Tests

- New `state/fileStore.test.ts` (21 tests): initial/export state, unwired-seam failure, import (vbook / TXT with and without assets / failure / transition reset), open (identity, URL tolerance, failure), create blank (success + failure), close (identity + position + session + player release), restore (persisted / server fallback / offline / race guard / stale-session drop), identity no-fork (File flows write THE shared signals; authStore stash round-trip through them), generation-reset seam invocation. Only the HTTP transport is mocked — generateStore/positionStore are real, so the identity assertions are meaningful.
- `app/fileAdapters.test.ts` updated: identity signals must be the generateStore signals themselves; File-owned signals must be the fileStore signals themselves.
- `auth-book-session.test.ts` updated for the `restoreBookSession` move (wires the same seams as the host).

### Manual regression coverage (not executable in this environment — honest gaps)

Import / drag & drop / Open / Create New Book / Export-download / `/file` `/library` `/edit` `/play` routes / desktop File panel / deep links / navigation events are covered by the automated suites (characterization + fileStore + adapters + guards + build). Browser-level smoke (real backend, real media, Safari/Chrome) was NOT run here — listed as the remaining manual verification step before the physical cut.

### Remaining blockers before the physical `@animastor/file` cut

- **B4** — cross-module backend surface (`POST /book/blank` = Editor contour, `assets-state` = Player contour): documentation-only, still open.
- **B6** — shared `phase` contract: PREPARED but structurally unresolved — the signal is still written by both slices; the physical cut needs an explicit who-owns-which-values contract (the seam interface already documents the File-owned values).
- **B2 residue** — resolved for the File slice (cycle dissolved); the audit's original B2 wording about the package boundary is satisfied by the `player` seam.
- Manual browser smoke (above).

B1 itself: **CLOSED** — all File state/actions that can be separated ARE separated; everything left in generateStore is genuinely shared (documented above), and fileStore has zero imports of generateStore/playbackStore.
