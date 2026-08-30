# 05. Screen Migration Plan (Simple → Complex)

Implementation order chosen **from simplest to most complex** to accumulate
skeleton, design tokens, i18n, HTTP client and cache layer on trivial screens
before the most risky one — the player. Each iteration ends with acceptance
criteria from [`02-DESIGN-PRESERVATION-PRINCIPLES.md`](02-DESIGN-PRESERVATION-PRINCIPLES.md) §3.

> Before implementing **any** screen, the stage 0 skeleton must be ready.

---

## Stage 0 — Skeleton (before screens)

- Shell: router + `TabBar` (5 tabs) + `Toolbar` (Settings/AI) + tab state
  preservation (stores at shell level).
- Design tokens: `theme-dark.css`/`theme-light.css` from `colors.xml`/`themes.xml`;
  `auto` mode by hour (like Android `applyTheme()`).
- i18n: ru/en dictionaries from `strings.xml`; `auto` by `navigator.language`.
- `api/client.ts`: fetch wrapper base `/api/v1/`, SSE client, `retryWithBackoff`,
  streaming Blob.
- `cache/mediaCache.ts`: Cache API/IndexedDB, `clearCache(buildId?)`.
- `state/*`: `positionStore` (SharedPositionManager), stubs for `generateStore` /
  `playbackStore`.
- SVG icons from `res/drawable/ic_*.xml`.
- `index.html`: meta viewport, theme, loader.

Acceptance: opening `m.animastor.in` shows empty shell with dark theme,
working tab-bar (empty pages), tab switching preserves state,
`Settings`/`AI` buttons open secondary routes (stubs).

---

## Stage 1 — Simplest static/dialog screens

| Step | Screen | Why simple | Key API/models |
|---|---|---|---|
| 1.1 | **Settings** (`/settings`) | static form, tiny API | theme + language (localStorage, like `PREFS_*`), `getBook/updateBook/deleteBook/exportBook/downloadBook/clearBookCache/cancelGeneration` |
| 1.2 | **VBookSettings** (`/settings/vbook`) | 1-2 field form | `chunk size (scenes per pass)` from `GenerateViewModel` |
| 1.3 | **WorkerSettings** (`/settings/worker`) | form by worker types | `/worker/counts` |
| 1.4 | **Library** (`/library`) | WebView content | iframe help/release-notes |

Acceptance: visually and textually matches `fragment_*.xml`; theme/language actually
switch shell; settings saved to localStorage (= `SharedPreferences`).

### Stage 1 completion (2026-08-02) ✅

- 1.1 Settings — done at stage 0 (theme/language), added VBook/Worker nav strings.
- 1.2 VBookSettings (`/settings/vbook`) — `select` 1..5, "Default" → 3, Apply →
  `PUT /book/{id}/layer-config {chunk_size}`, `GET` on open. No open
  book → notice + Apply disabled (Android does silent no-op).
- 1.3 WorkerSettings (`/settings/worker`) — single route for 3 worker types
  (segmented control audio/image/video instead of 3 separate Android fragments):
  "Workers" card (`/worker/counts`), profile (`/connectors/profiles`),
  timeout (`layer-config` GET/PUT, ranges as Android), workflow
  (`/connectors/grouped` → active connectors), "Manage" button →
  `/workflows/type/:type`. Apply saves only timeout (like Android).
- 1.4 Library (`/library`) — `iframe` → `https://animastor.in` + "Open in
  browser" link; entry from File tab (analogous to `libraryCard`).

Deviations and decisions — [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §5, §9.

---

## Stage 2 — Network lists/details (without player and generation)

| Step | Screen | Complexity | API/models |
|---|---|---|---|
| 2.1 | **WorkflowManager** (`/workflows`) | list + summary | `/workflows`, `/workflows/summary` (`WorkflowSummaryResponse`) |
| 2.2 | **WorkflowDetails** (`/workflows/:name`) | details + hash + nodes | `/workflows/{name}`, `/workflows/{name}/hash` (`WorkflowDetail`, `WorkflowHashResponse`) |
| 2.3 | **WorkflowTypeList** (`/workflows/type/:type`) | nodes by type | `WorkflowTypeListFragment` (sharedViewModel) |
| 2.4 | **DeveloperView** (`/dev`) | connector: parameters/bindings/compatibility | `/connectors*` (`ConnectorDetail`, `CompatibilityStatus`, `putConnectorParameter/Binding/Status`, `validateConnector`, `reloadConnectors`, `getConnectorEntities`) |
| 2.5 | **AiAssistant** (`/ai`) | chat with sessions/history; modes; typing | `/ai/chat`, `/ai/sessions*`, `/ai/sessions/{id}/messages` (`ChatAdapter`, `ChatHistoryManager`, `AssistantMode`) |

Acceptance: navigation recursion `WorkflowManager→Details→TypeList→DeveloperView`
works; chat sends/receives messages, shows typing, switches modes, session list
created/edited/deleted.

### Stage 2 completion (2026-08-02) ✅

- 2.1 WorkflowManager (`/workflows`) — 3 audio/image/video cards from
  `/connectors/grouped` (F12: server active counters), subtitle = first
  connector, Reload button → `POST /connectors/reload`. `/workflows/summary`
  NOT used (Android fragment doesn't use it either — manager built on
  grouped connectors, see §11).
- 2.2 WorkflowDetails (`/workflows/:name`) — header card (connector/type/
  status/hash/version/nodes), 4 tabs (Inputs/Outputs/Parameters/Compatibility),
  edit mode (`routeState.detailsEditMode`, like fragment editMode argument),
  parameter editing via dialog (`PUT /connectors/{name}/parameters`),
  in edit mode — smart node picker for bindings/guide nodes
  (`PUT /connectors/{name}/bindings`), dev chip `</>` → `/dev`.
- 2.3 WorkflowTypeList (`/workflows/type/:type`) — connector list by type from
  `/connectors/grouped`, enable/disable switch (`PUT .../status`), status badges,
  Details → `/workflows/:name` (disabled → edit mode), Add Workflow — read
  JSON file and `POST /connectors` (name from `name` or guess from filename).
- 2.4 DeveloperView (`/dev`) — tabs Raw JSON (`/connectors/{name}/raw`,
  pretty-print) / Bindings (flat table inputs/outputs/parameters with
  multi-binding expansion), navigate by dev chip with `routeState.devConnector`.
- 2.5 AiAssistant (`/ai`) — 1:1 chat: sessions (`/ai/sessions?book_id=`, restore,
  create, delete), 6 mode chips (AssistantMode), typing indicator, position bar
  (from `positionStore` + book), markdown bubbles (port `applyMarkdownTo`),
  copy, download link when `book_id` in response, discard response on
  session switch, voice input via Web Speech API (fallback — toast).

Deviations and decisions — [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §11.

---

## Stage 3 — File (import/export)

| Step | Contents | Why now |
|---|---|---|
| 3.1 | **File** (`/file`) | Import `.vbook`/txt via `<input type=file>` + drag-drop (`POST /book/import` multipart); book list; export/download (`GET /book/{id}/export\|download`); deep link `?book=`. Triggers `generateStore.loadBook()` and navigate to `Generate`/`Play`. | Need book entry flow for all other screens. |

Acceptance: book import → `Generate` sees book; export/download work;
re-selecting already open book doesn't break state (like `pendingExportBookId`).

### Stage 3 completion (2026-08-02) ✅

- 3.1 File (`/file`) — 3 cards 1:1 with `fragment_file.xml`: Import from Device
  (`<input type=file>` + drag-drop → `POST /book/import`, import status from
  `importProgressMessages.take(4)` / phases `file_status_*`), Create New Book
  (`closeBook()` + → `/ai` in create mode), Library (→ `/library`).
- Download: 4 cards (book/storyboard/audio/video) with same enabled rules
  as Android (`!exporting && bookId` for .vbook;
  `!exporting && bookId && buildId && SCENE_READY/PLAYING` for others);
  download via fetch-Blob → `<a download>` (equivalent to CreateDocument),
  progress from Content-Length, statuses `export_preparing*` → `export_progress` →
  `export_saved` (3s) → clear.
- Import (vbook/txt) completes with `navigationEvent` → `/play`|`/generate` by
  scenes and `has_assets` (logic `importBookFromFile` 1:1), `generateStore.loadBook()`
  set — `Generate`/`Play` will see book (screens themselves — stages 4/7).
- Deep link `?book=<id>`/`?open=<id>` — book loaded from server by id
  (`GET /book/{id}`), parameter removed after processing. Deviations —
  [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §12.

---

## Stage 4 — Generate (progress and coordination)

| Step | Contents | Risks |
|---|---|---|
| 4.1 | **Generate** (`/generate`) — start generation, SSE progress, status by scope (`/progress-panel?scope=…&chapter_id=…&scene_id=…`), mode/topic/worker chips, tab icon status indicator (`running`/`error`/`success`, auto-reset timer as in `MainActivity.updateNavIconStatus`). Emits `playbackPrepared` → `playbackStore.preparePlayback()` (reproduce `setupPlaybackCoordination`). | SSE monotonicity/lost reconnect (see `docs/05-frontend/PROGRESS_HANDOFF.md`). Coordinate with player **before** stage 5. |

Acceptance: generation start, progress correct on reconnect, after completion
`Play` automatically ready to play (via `playbackPrepared`), status icon
correctly pulsates and auto-resets.

### Stage 4 completion (2026-08-02) ✅

- 4.1 Generate (`/generate`) — 1:1 with `fragment_generate.xml`:
  position-bar (→ `/navigate`), Global section (Generate All / Stop All),
  4 worker sections (VBook/Audio/Image/Video) with header row
  (accent-bar/icon/counter/gear → settings/toggle-chip), progress rows and
  Generate/Stop buttons. Toggle chips persist in `PUT /layer-config`.
- Progress: `computeProgressRows` (port from `GenerateViewModel`): new-gen gate,
  monotonic floor, 10s done-window, all-cancelled, SUCCESS finalization;
  VBook row from `/agent-status` poll (2s) + SSE `import_complete`.
- Engines: worker counts poll 5s; progress-panel poll 1.5s; timer 500ms;
  `checkAndRestoreGenerationState` 2.5s after mount (R11).
- Actions: `POST /regenerate` (scope+worker_types), `bootstrap`/
  `bootstrap-next-window` (VBook), `/cancel-generation`, `/cancel-worker
  {type|task_id}`. Scope dialog 1:1 (`DialogGenerateScope`), positional
  options disabled without `positionStore`.
- Coordination: `playbackStore.wirePlaybackCoordination()` =
  `setupPlaybackCoordination` (preparePlayback / refreshContent by softRefresh);
  `applyGenerationResults` emits soft-refresh after completion.
- Tab icon: RUNNING/ERROR/SUCCESS pulse (`tabbar__pulse*`) + auto-reset 22s.
  Deviations — [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §13.

---

## Stage 5 — Navigate (bookmark map → seek)

| Step | Contents |
|---|---|
| 5.1 | **Navigate** (`/navigate`) — tree chapters→scenes→units (`getBook`, `sceneRefs()`, `getTextIndex`, `getChaptersSummary`); select node → `positionStore.navigateTo(...)` + `router.push('/play')` + `playbackStore.seekToPosition(...)` (1:1 with `seekToPosition`: refresh book JSON when scene missing, `missingIuPosition` overlay). |

Acceptance: navigate from Navigate to Play seeks to correct unit; when scene
missing, "not generated" overlay shown (like `showMissingChunkOverlay`).

### Stage 5 completion (2026-08-02) ✅

- 5.1 Navigate (`/navigate`) — 1:1 with `fragment_navigate.xml` +
  `BookStructureAdapter` (chapters/scenes/units): position-bar (`updatePositionBar`
  with Cover/Prologue and `display_number`), loading, empty-state, chapter/scene/
  unit labels (including `— type (style)` for scenes and `[type]` for units),
  auto-expand current scene, preview thumbnails via `GET /preview`
  (`getIuPreview` equivalent, fallback `ic_image_off`).
- Unit click → `positionStore.navigateTo` + `playbackStore.seekToPosition`
  (full logic: scene in queue → pendingExternalSeek; scene missing → refresh
  book JSON → `missingIuPosition`) → `router.push('/play')`.
- `PlayPage` shows `missingIuPosition` overlay ("Not generated", like
  `showMissingChunkOverlay`) — full player remains for stage 7.
- Tree reload on `playbackPrepared` (generation completed).
- Deviations — [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §14.

---

## Stage 6 — Edit (timeline + waveform)

| Step | Contents | Risks |
|---|---|---|
| 6.1 | **Edit** (`/edit`) — scene/unit list, waveform (`getSceneWaveform` → `WaveformView` render on Canvas), IU image preview, timing editing/saving (`GET/PUT /scene/.../timings`), `layer-config` (`GET/PUT /book/{id}/layer-config`). Navigate to `Play` with seek by selected unit. | Waveform on canvas; timing save with validation; sync with `playbackStore` (same `seekToPosition`/`positionStore`). Medium-high risk — see 06. |

Acceptance: waveform renders identically; timing edits saved and affect
IU-cycling splitting in Play; layer-config persists.

### Stage 6 completion (2026-08-02) ✅

- 6.1 Edit (`/edit`) — 1:1 with `fragment_edit.xml` + `EditFragment.kt`:
  position-bar (label + unitCount, tap → `/navigate`), unit carousel
  (prev/current/next previews, aspect-ratio card heights, "Not generated"
  overlay), audio timeline (playback `<audio>` + waveform Canvas
  `lib/waveform.tsx` + reset), 7 scrollable property tabs, content area,
  Save + dirty indicator (`dirtySummary` from `/regenerate` summary) + error.
- Timings: `GET/PUT /scene/{b}/{ch}/{sc}/timings` + `GET /waveform`
  (parallel), drag-preview → server cascade on release (N2), Reset →
  original boundaries, `GET /scene/.../audio` for playback. Unit seek →
  `playbackStore.seekToPosition` + `positionStore` (navigate to Play).
- layer-config not used by Edit screen itself: `GET/PUT /book/{id}/layer-config`
  already implemented in VBookSettings (stage 1) and Generate (stage 4); Android
  Edit fragment also doesn't touch layer-config.
- Deviations — [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §15.

---

## Stage 7 — Play (multiplex player) — final, highest risk

| Step | Contents | Dependencies |
|---|---|---|
| 7.1 | Engine: `playbackStore` (`PlaybackUiState`, `sceneQueue`, `currentIndex`, `currentUnitIndex`, preloadCache, `pendingSceneAudio/Video/IuSequence`, layer toggles, `needsContentRefresh`/`needsRotationResume` analogs), `positionStore`. | All previous screens. |
| 7.2 | Play UI skeleton (`fragment_play.xml` 1:1): media viewport, layer bar (4 chips), big-play-button, progress, status, fullscreen, curtains/cover/result/overlay/subtitle. | Design tokens ready. |
| 7.3 | Playback engine: 2 audio sources (current+next, gapless approach), 1 video overlay, IU-cycling by `currentTime` (RAF), silent IU mode (Cover), seek by `unitIndex` (sum of `durationMs`), `preloadAhead(3)` with retry/backoff, `fetchSceneData` (status→audio→video→IU), soft-refresh (`refreshContent`) + `needsContentRefresh`. | Implementation/alternative choice — 06 §Player. |
| 7.4 | Seek/navigation: `seekToPosition` (refresh book JSON when missing, `missingIuPosition`), `executePendingSeek` (via `positionStore.navigateTo`), position restoration (`savedPlaybackPositionMs` analog via `Page Visibility`). | `positionStore` ready. |
| 7.5 | Lifecycle/visibility: pause on tab hide/minimize (`Page Visibility`), restore on return, correct resource release. | Shell skeleton. |

Acceptance: scene queue reproduces with gapless transition; IU images and
subtitles synchronized with audio; video layer shows on `status.video_ready`;
seek from Navigate/Edit works; soft-refresh after regeneration works; pause/
resume/fullscreen work; `DONT_DO.md` anti-patterns not reproduced.

### Stage 7 completion (2026-08-02) ✅

- 7.1 Engine — `playbackStore` (port `PlaybackViewModel` + engine
  `PlayFragment`): `PlaybackUiState` (+chunkSequence), `sceneQueue` (`ch:sc`),
  `currentIndex`/`currentUnitIndex`, preloadCache (`${buildId}_${sceneKey}`),
  layer toggles, `needsContentRefresh`/`needsRotationResume`,
  `savedPlaybackPositionMs`/`pendingSeekPositionMs` (sessionStorage), `coverImage`.
- 7.2 UI `PlayPage` = `fragment_play.xml` 1:1: media viewport (curtains/cover/
  result/video/scrim/placeholder/iuMissing/subtitle/fullscreen), layer bar
  (4 chips 48dp, `.chip--layer`), big-play-button (56dp, radius 18dp,
  PLAY↔PAUSE), progress 4dp, status 11sp. Fullscreen API on media container
  + anchorFullscreenToImage (letterbox + lift above subtitles).
- 7.3 Engine: 2 `<audio>` (first + `preloadNext`, gapless −200ms via
  `sceneTransitionPending`/RAF, fallback `ended`) + `<video>` overlay;
  IU-cycling RAF by `currentTime` (bisect sum of `durationMs`), silent mode
  for Cover (timer); seek by `unitIndex` (`currentTime = seekMs/1000`, R5);
  `preloadAhead(3)` parallel + retryWithBackoff; `fetchSceneData`
  (status→audio→video→IU); soft-refresh + `needsContentRefresh` (R6).
- 7.4 Seek/navigation: `seekToPosition` (refresh book JSON when missing →
  `missingIuPosition`), `executePendingSeek` (pendingLoad → player
  prepared/pause), position restoration (`pagehide` → sessionStorage →
  `pageshow`/mount, `needsRotationResume`).
- 7.5 Lifecycle: pause on `document.hidden` (like `onPause`), save/restore
  position, release resources on closeBook/tab-switch.
- Deviations — [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §16.

---

## Order summary

```
0 skeleton →
1 Settings/Lib/VBook/Worker (trivial) →
2 Workflows/Dev/Ai (lists/details/chat) →
3 File (import) →
4 Generate (SSE + coordination) →
5 Navigate (map→seek) →
6 Edit (waveform + timings) →
7 Play (multiplex player, highest risk)
```

Each stage is documented in this same section: status, actual
deviations (links to `06-RISKS-AND-ALTERNATIVES.md`), visual/UX differences.
