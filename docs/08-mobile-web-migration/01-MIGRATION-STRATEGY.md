# 01. Overall Strategy for Migrating Android UI to Mobile Web

> Goal: create a mobile web version at `https://m.animastor.in/`, visually and
> behaviorally indistinguishable from the Android app, reusing the same
> backend API `/api/v1/...`.

---

## 1. Key facts about the Android app

- Stack: Kotlin + Jetpack (Fragment, ViewBinding, ViewModel, `activityViewModels`),
  Material 3, `ConstraintLayout`, `BottomNavigationView`, `MediaPlayer` (Android),
  Retrofit + OkHttp.
- Navigation: **bottom bar with 5 tabs** (`res/menu/bottom_nav.xml`):
  `File` → `Generate` → `Play` → `Edit` → `Navigate`. Home screen is `File`.
  Navigation implemented manually via `FragmentTransaction` `hide/show` by tags
  (`MainActivity.kt`), **without** Navigation Component / nav graph.
- Additional screens open above bottom-nav tabs as separate fragments with
  `addToBackStack`: `Settings`, `AiAssistant`, `WorkflowManager`,
  `WorkflowDetails`, `WorkflowTypeList`, `DeveloperView`, `VBookSettings`,
  `WorkerSettings`, `Library`. `Generate` has generation status indicator
  (icon pulsation).
- Theme: Material 3 Dark/Light "cinema" (`themes.xml`). Entry point is dark.
  `cinema_*` palette, rounded corners 12/18/28dp, player layer chips.
- Localization: `ru` / `en` / `auto`.
- Coordination: `MainActivity.setupPlaybackCoordination()` listens to
  `GenerateViewModel.playbackPrepared` and calls `PlaybackViewModel.preparePlayback()`
  — single "generation → player" channel.

## 2. Migration strategy

### 2.1. Web frontend platform

The web version will be a **thin client** over the same backend API as Android:
- Same API `/api/v1/...` (Retrofit interface → HTTP client in TS/JS).
- Same data models (`BookData`, `StoryboardResponse`, `SceneStatus`, …).
- Same screen sequence and scenarios.

Framework stack selection will be documented in
[`03-MOBILE-WEB-ARCHITECTURE.md`](03-MOBILE-WEB-ARCHITECTURE.md). Before stack
selection, considerations: SPA navigation "tabs as pages", reactive state
(equivalent to `StateFlow`), hash/path routing, mandatory mobile browser support
(Safari iOS, Chrome Android), offline/weak connection work (preloading).

### 2.2. "One screen — one page" principle

- Each Android `Fragment` → separate **route (page)** in web app:
  `/file`, `/generate`, `/play`, `/edit`, `/navigate` for bottom bar;
  `/settings`, `/ai`, `/library`, `/workflows`, … for secondary.
- Bottom bar = fixed bottom `tab bar` switching routes and
  preserving each tab's state (equivalent to `hide/show` by tags).
- Secondary screens = routes with return (`back` stack), analogous to
  `addToBackStack`.

### 2.3. Migration in three streams

| Stream | What | When |
|---|---|---|
| **A. Skeleton** | shell app: router, tab bar, theme/tokens, i18n, HTTP client, model mapping | before screens |
| **B. Simple screens** | Settings, Library, Workflow*, VBook/Worker settings, AiAssistant, File | first |
| **C. Complex screens** | Generate (SSE progress, chips), Edit (waveform, timeline), Navigate (bookmark map), **Play (multiplex player)** | per schedule in [`05-SCREEN-IMPLEMENTATION-ORDER.md`](05-SCREEN-IMPLEMENTATION-ORDER.md) |

### 2.4. Screen design order for each screen

1. Read `layout/*.xml` of fragment → fix DOM structure and anchoring.
2. Extract design tokens from `themes.xml`/`colors.xml` → CSS design tokens.
3. Migrate strings from `strings.xml` (ru/en) → i18n dictionaries.
4. Migrate logic: `ViewModel.uiState.collect` → store/subscriptions; `observe` →
   reactive subscription equivalents.
5. Migrate `BackendApi` calls → HTTP client methods (same paths/parameters).
6. Document deviations (if any) in
   [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) with justification.

### 2.5. What we migrate one-to-one

- Visual tokens (`cinema_*` colors, rounded corners 12/18/28dp, heights,
  iconography — vector `ic_*.xml` re-encoded to SVG).
- Text scenarios: book import → generation → play → edit → navigate.
- API contracts (endpoints, query parameters, payload models).
- Bottom bar behavior (5 tabs, generation status indicator).
- Localization ru/en + `auto`.

### 2.6. What definitely changes (documented as justified deviation)

- `MediaPlayer` (Android) → `HTMLMediaElement` / Web Audio — see Player section.
- `SurfaceView` for video overlay → `<video>`/`<canvas>`.
- `SimpleDiskCache` disk cache → Cache API / IndexedDB.
- File associations (`.vbook` ACTION_VIEW) → file loading via `<input
  type=file>` / drag-drop.
- `MediaDecoder.decodeBitmap` → native browser decoding (`<img>`, `createImageBitmap`).

Full risk and alternative list in
[`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md).

---

## 3. Source of truth

When this section and Android code diverge, **the source of truth is the code**
(`frontend/app/src/main/`). This section describes the migration, not modifying
Android; all class/method references are for mapping purposes.
