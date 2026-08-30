# Android → Mobile Web Migration — Task List

Plan source: [`08-mobile-web-migration/05-SCREEN-IMPLEMENTATION-ORDER.md`](08-mobile-web-migration/05-SCREEN-IMPLEMENTATION-ORDER.md)
Project rule: [`08-mobile-web-migration/README.md`](08-mobile-web-migration/README.md)

Statuses: `[ ]` pending · `[~]` in_progress · `[x]` done

## Stage 0 — Skeleton (before screens)

- [x] **`frontends/mobile` skeleton**: Preact + Vite + TS (stack locked). Router (`preact-router`), `TabBar` (5 tabs), `Toolbar` (Settings/AI), tab state preservation; design tokens `tokens.css`/`theme-dark.css`/`theme-light.css` from `colors.xml`/`themes.xml` + `auto` by hour (pre-paint script in `index.html`); i18n ru/en/auto from `strings.xml`; `api/client.ts` (fetch base `/api/v1/`, SSE, `retryWithBackoff`, streaming-Blob); `cache/mediaCache.ts` (Cache API + `clearCache(buildId?)`); `state/*` (`positionStore`, `generateStore`, `playbackStore`); SVG icons from `res/drawable/ic_*.xml`. ✅ `tsc --noEmit` + `vite build` + dev-server smoke — OK.

## Stage 1 — Simplest static/dialog screens

- [x] **Settings** (`/settings`) — theme dark/light/auto + language ru/en/auto (segmented control, `localStorage` = `SharedPreferences`), via `applyTheme`/`applyLanguage`. VBook/Worker sections — stubs in same file.
- [x] **VBookSettings** (`/settings/vbook`) — chunk size (scenes per pass), layer-config `GET/PUT`
- [x] **WorkerSettings** (`/settings/worker`) — `/worker/counts`, profiles (`/connectors/profiles`), timeouts (layer-config), workflow (`/connectors/grouped`)
- [x] **Library** (`/library`) — iframe help/release-notes (`animastor.in`)

## Stage 2 — Network lists/details (without player and generation)

- [x] **WorkflowManager** (`/workflows`) — audio/image/video cards + active counters from `/connectors/grouped` (F12), Reload → `/connectors/reload`
- [x] **WorkflowDetails** (`/workflows/:name`) — header card + 4 tabs (Inputs/Outputs/Parameters/Compatibility), edit mode (`?edit` → `routeState.detailsEditMode`), parameter editing (`PUT /connectors/{name}/parameters`) and bindings/guide nodes (`PUT .../bindings`), dev chip `</>`
- [x] **WorkflowTypeList** (`/workflows/type/:type`) — type connector list, enable toggle (`PUT .../status`), Details button, Add Workflow (JSON file → `POST /connectors`)
- [x] **DeveloperView** (`/dev`) — Raw JSON tab (`/connectors/{name}/raw`) / Bindings (from ConnectorDetail), navigate by dev chip with `routeState.devConnector`
- [x] **AiAssistant** (`/ai`) — chat: sessions (`/ai/sessions*`), 6 modes (AssistantMode), typing indicator, position-bar, markdown bubbles, copy, voice input (Web Speech API)

### Stage 2 completion (2026-08-02) ✅

- All 5 screens implemented; `tsc --noEmit` + `vite build` — OK; code review passed.
- Deviations and decisions — [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §11.

---

## Stage 3 — File (import/export)

- [x] **File** (`/file`) — `.vbook`/txt import (`POST /book/import` multipart), book list, export/download, deep link `?book=`

### Stage 3 completion (2026-08-02) ✅

- Import: Import/Create/Library cards 1:1 with `fragment_file.xml`; `<input type=file>`
  (`accept=".vbook,.epub,text/plain,.txt"`) + drag-drop → `POST /book/import`
  multipart; import status like Android (status text from `importProgressMessages.take(4)`,
  phases `file_status_*`); on completion — `navigationEvent` → `/play` or `/generate`
  (logic `importBookFromFile`: vbook → Play when scenes, txt → Play when `has_assets`).
- Download: `GET /book/{id}/download` (.vbook — only bookId), `/storyboard`,
  `/audio`, `/export` (need bookId+buildId+phase SCENE_READY/PLAYING);
  progress from Content-Length (`getBlob` onProgress), statuses `export_*`/`export_saved`.
- Deep link `?book=<id>` (and `?open=<id>`) — load book from server (`GET /book/{id}`),
  parameter removed after processing; details — [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §12.
- Deviations and decisions — [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §12.

## Stage 4 — Generate (progress and coordination)

- [x] **Generate** (`/generate`) — SSE progress, status by scope (`/progress-panel`), mode/topic/worker chips, tab icon status indicator (running/error/success + auto-reset), emits `playbackPrepared` → `playbackStore.preparePlayback()`

### Stage 4 completion (2026-08-02) ✅

- 4 worker sections (VBook/Audio/Image/Video) 1:1 with `fragment_generate.xml`:
  header row (accent bar, icon, `Worker counts` counter, settings gear,
  toggle chip On/Off), progress rows `item_worker_progress`,
  Generate/Stop buttons. `updateHeaderPanelStyle`/`updateToggleText` ported.
- Worker counts poll 5s (`/worker/counts`) → `updateSectionHeader`: error icon
  (generating, needed, but 0 workers), active (pulse `gen-pulse` 1.6s),
  normal, off (strikethrough).
- Progress panel poll 1.5s (`/progress-panel`) → `computeProgressRows` 1:1:
  new-gen gate (anti-stale-flash 100%), monotonic floor, 10s done-window,
  all-cancelled hide, finalization (SUCCESS + `playbackPrepared` soft
  refresh). VBook row from SSE + `/agent-status` poll (2s, 5min timeout).
- Timer 500ms (freeze done-rows / live count active), like
  `refreshTimerDisplay`.
- Generation start: Generate All → scope dialog → VBook; Audio/Image/Video →
  scope dialog (`DialogGenerateScope`, position-dependent options disabled without
  position) → `POST /regenerate {worker_types, scope, chapter_id, scene_id}`;
  VBook → `bootstrap`/`bootstrap-next-window` + poll `/agent-status`.
  Stop All → `/cancel-generation`; Stop section → `/cancel-worker {type}`;
  Stop row → popup "Cancel" (`worker_stop_menu_cancel`) →
  `/cancel-worker {type, task_id}`.
- SSE `/progress-stream` (ProgressEvent: vbook/import_complete/generation_complete)
  with reconnect exponent 1s→2s→4s→8s→15s and epoch-guard;
  `import_complete` ends VBook poller earlier.
- `checkAndRestoreGenerationState` (2.5s after mount) — restore
  active generation after backend restart (R11).
- Tab icon indicator: RUNNING/ERROR/SUCCESS → color+pulse (`tabbar__pulse*`),
  SUCCESS auto-reset 22s (like `updateNavIconStatus`), reset when entering
  Generate without active work.
- `playbackPrepared` → `playbackStore.wirePlaybackCoordination()`
  (`setupPlaybackCoordination`): `preparePlayback`/`refreshContent(softRefresh)`.
- Deviations and decisions — [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §13.

## Stage 5 — Navigate (bookmark map → seek)

- [x] **Navigate** (`/navigate`) — tree chapters→scenes→units → `positionStore.navigateTo()` + `router.push('/play')` + `playbackStore.seekToPosition()` (refresh book JSON when missing → `missingIuPosition` overlay)

### Stage 5 completion (2026-08-02) ✅

- Tree 1:1 with `fragment_navigate.xml` + `BookStructureAdapter`: position-bar
  (label-only, `updatePositionBar` 1:1: special chapters Cover/Prologue,
  `display_number` prefix, "Chapter N — Title"), loading indicator,
  empty-state, chapter→scene→unit list.
- Labels: chapters — accent/bold/15sp (indent 8), scenes — `… — type (style)` /
  `… (type)` on surfaceVariant (indent 24), units — `[type] Unit N — text`
  13sp + active (accent bold + secondaryContainer).
- Auto-expand current scene by position (`expandedScenes` follows
  `positionStore`, `lastPositionKey`), expand chapters by rule
  "current chapter or ≤3 chapters".
- Unit preview thumbnails: `<img loading=lazy>` → `GET /preview/{…}?build_id=`
  (equivalent to `getIuPreview`), fallback `ic_image_off` on error.
- Unit click: `positionStore.navigateTo` + `playbackStore.seekToPosition`
  (1:1 with `PlaybackViewModel.seekToPosition`: refresh book JSON when scene not in
  queue → `missingIuPosition`) + navigate to `/play` (`switchToPlayTab`).
- `PlayPage` shows `missingIuPosition` overlay ("Not generated", like
  `showMissingChunkOverlay`) — player skeleton at stage 7.
- Tree reload on `playbackPrepared` (generation completed).
- Deviations and decisions — [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §14.

## Stage 6 — Edit (timeline + waveform)

- [x] **Edit** (`/edit`) — scene/unit timeline, waveform (`getSceneWaveform` → Canvas), IU preview, `GET/PUT /scene/.../timings`, `GET/PUT /book/{id}/layer-config`, navigate to Play with seek

### Stage 6 completion (2026-08-02) ✅

- Layout 1:1 with `fragment_edit.xml`: position-bar (label + unitCount, tap →
  `/navigate`), unit carousel prev/current/next (preview `GET /preview` +
  aspect-ratio card heights as Android, "Not generated" overlay),
  audio timeline panel (Play/Stop + waveform + Reset), 7 scrollable
  property tabs with arrows (default — Unit, like Android), content area,
  Save button (48dp, radius 18dp), dirty indicator, error text, empty-state.
- Waveform: `lib/waveform.tsx` — Canvas port of `WaveformView.kt` (R10): bars by
  peaks, selection + draggable handles (touchSlop 24, clamp −50ms/
  +50ms), playhead with triangle, time labels `M:SS.d`, "No waveform data".
- Timings: parallel load `GET /waveform` + `GET /timings` (like
  `loadTimelineData`), `computeInitialTimings` (clamp to audio duration),
  drag-preview locally (N2) → `PUT /scene/.../timings` on release,
  server response overwrites boundaries; Reset restores original
  timings and saves.
- Playback: `<audio>` (src `/scene/.../audio?build_id=`) + rAF cursor by
  `currentTime` (playhead via signal — no page re-render), stop on
  `end_ms`/duration, play↔stop icon.
- Carousel navigation: `navigateUnit(±1)` 1:1 (scene/chapter transitions)
  → `positionStore.navigateTo` + `playbackStore.seekToPosition` (navigate to Play
  with seek, as plan requires).
- Field saving: by tabs (Scene/Audio/Unit/Locations/Global), passport
  overrides via separate PATCH without `unit_id`; after save — re-fetch
  `GET /book/{id}` (thin-client).
- Dirty indicator: `dirtySummary` from `/regenerate` response (`res.summary`,
  server diff) + "Save *" on local edits.
- Deviations and decisions — [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §15.

## Stage 7 — Play (multiplex player) — highest risk

- [x] **Play** (`/play`) — UI skeleton (`fragment_play.xml` 1:1); `playbackStore` (`PlaybackUiState`, `sceneQueue`, preloadCache, layer toggles, `needsContentRefresh`); engine: 2×`<audio>` (gapless −200ms) + `<video>` overlay + IU-cycling (RAF by `currentTime`) + silent IU mode + seek by `unitIndex` (sum `durationMs`) + `preloadAhead(3)` retry/backoff + `fetchSceneData` (status→audio→video→IU) + soft-refresh; seek/navigation (`seekToPosition`/`executePendingSeek`/`missingIuPosition`); lifecycle (Page Visibility, sessionStorage savedPosition). `DONT_DO.md` anti-patterns must not be reproduced.

### Stage 7 completion (2026-08-02) ✅

- `playbackStore` — full port of `PlaybackViewModel` + engine `PlayFragment`:
  scene queue (sceneRefs → `ch:sc`), `currentIndex`/`currentUnitIndex`,
  `preparePlayback` (clearCache on buildId change, DONT_DO #5) and
  `refreshContent` (soft refresh: needsContentRefresh, PLAYING→SCENE_READY +
  stopAll, PAUSED stays), `playSceneQueue`/`resumeFromCurrentScene`/
  `resumePlayback`/`pausePlayback`, `handlePlaybackError`/`handleNullPlayer`,
  `executePendingSeek` (DOWNLOADING→playNext), `ensureInitialized` +
  `loadCoverIntoState` (5× retry 1s→5s like loadCoverBitmap).
- Engine (modular elements, survive tab switching): 2 `<audio>` in
  hidden host-div (first → `preloadNext` → chain) + `<video>`, adopted from
  PlayPage. Gapless transition −200ms via RAF (`sceneTransitionPending`,
  `switchToNextPlayer`), fallback — native `ended` (`onTrackEnd`).
- `fetchSceneData`: `/scene/.../status` → audio/video/storyboard → each IU
  (`/iu-image`), parallel; retryWithBackoff(3, 1s→2→5s) in playNext;
  Blob cache Cache API (`mediaCache`, key `${buildId}_${sceneKey}` +
  `kind`, IU — `ch:sc:unit`), clearCache on buildId change and in refreshContent.
- IU-cycling: RAF by `audio.currentTime` + bisect sum of `duration_ms` (R3 A),
  silent mode for scenes without audio (Cover) — timer `duration_ms`; `showIu`
  shows placeholder for `NOT_GENERATED` without index skip (DONT_DO #3),
  audio never waits for image (DONT_DO #1).
- PlayPage — `fragment_play.xml` 1:1: media viewport (curtains/cover/result/
  video/scrim/placeholder/`iuMissing`/subtitle), 4 layer chips (audio → volume,
  image → visibility, video → overlay, subtitles), big-play-button (56dp/18dp,
  PLAY↔PAUSE), progress (indeterminate), status (11sp), fullscreen button
  (44dp, anchorFullscreenToImage: letterbox translate + lift above subtitles),
  Fullscreen API on media container.
- Lifecycle (R8): pause on `document.hidden` (`onPause`), save position
  in sessionStorage on `pagehide`, restore (`needsRotationResume` +
  `pendingSeekPositionMs`) on `pageshow`/mount (reload) — `wirePlaybackLifecycle`.
- Seek from Navigate/Edit: `seekToPosition` → `pendingExternalSeek` → on mount
  PlayPage `checkPendingExternalSeek` (pendingLoad → player prepared at
  position and paused, like `executePendingSeek` in Android);
  `missingIuPosition` → "Not generated" overlay 1:1.
- Deviations and decisions — [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §16.
- `tsc --noEmit` + `vite build` — OK; code review passed.

## Final

- [ ] Remove Basic Auth from `m.animastor.in` (`proxy/conf/default.conf`) before public launch

---

## Progress

Update statuses in brackets as work proceeds; on stage completion — brief note in
[`08-mobile-web-migration/05-SCREEN-IMPLEMENTATION-ORDER.md`](08-mobile-web-migration/05-SCREEN-IMPLEMENTATION-ORDER.md)
and deviation documentation in
[`08-mobile-web-migration/06-RISKS-AND-ALTERNATIVES.md`](08-mobile-web-migration/06-RISKS-AND-ALTERNATIVES.md).
