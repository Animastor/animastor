# 04. Android → Web Mapping Tables

Sources of truth: `frontend/app/src/main/java/com/example/animastor/ui/`,
`res/layout/`, `res/menu/bottom_nav.xml`, `res/values/colors.xml`,
`themes.xml`, `strings.xml`, `repository/BackendApi.kt`.

---

## 1. Android Screen → Mobile Web Page

| # | Android (Fragment / layout) | Web Page (route) | Bottom nav? | Purpose |
|---|---|---|---|---|
| 1 | `FileFragment` / `fragment_file.xml` | `/file` | ✅ home | Book open/import (`.vbook`, txt), list, export, download |
| 2 | `GenerateFragment` / `fragment_generate.xml` | `/generate` | ✅ #2 | Start generation, progress (SSE), scope statuses, tab icon indicator |
| 3 | `PlayFragment` / `fragment_play.xml` | `/play` | ✅ #3 | Multiplex player: scene queue, IU-cycling with subtitles, audio/image/video/subtitle layers, fullscreen, seek — **high risk** (see 06) |
| 4 | `EditFragment` / `fragment_edit.xml` | `/edit` | ✅ #4 | Scene/unit timeline, waveform, timing editing, layer config |
| 5 | `NavigateFragment` / `fragment_navigate.xml` | `/navigate` | ✅ #5 | Chapter→scene→unit map, navigate → `Play.seekToPosition` |
| 6 | `SettingsFragment` / `fragment_settings.xml` | `/settings` | secondary | Theme (dark/light/auto), language (ru/en/auto), book: export/download/delete |
| 7 | `AiAssistantFragment` / `fragment_ai_assistant.xml` | `/ai` | secondary | AI chat: sessions (`/ai/sessions`), history, modes (`AssistantMode`), send (`/ai/chat`) |
| 8 | `LibraryFragment` / `fragment_library.xml` | `/library` | secondary | WebView with help/release-notes (`ChatHistoryManager` style) |
| 9 | `WorkflowManagerFragment` / `fragment_workflow_manager.xml` | `/workflows` | secondary | Workflow list, summary, statuses (`/workflows`, `/workflows/summary`) |
| 10 | `WorkflowDetailsFragment` / `fragment_workflow_details.xml` | `/workflows/:name` | secondary | Workflow details: hash, nodes, parameters |
| 11 | `WorkflowTypeListFragment` / `fragment_workflow_type_list.xml` | `/workflows/type/:type` | secondary | Workflow node list by type (audio/image/…) |
| 12 | `DeveloperViewFragment` / `fragment_developer_view.xml` | `/dev` | secondary | Dev view: connector, parameters, bindings, compatibility |
| 13 | `VBookSettingsFragment` / `fragment_vbook_settings.xml` | `/settings/vbook` | secondary | VBook generation settings (chunk size "scenes per pass") |
| 14 | `WorkerSettingsFragment` / `fragment_worker_settings.xml` | `/settings/worker` | secondary | Worker timeouts/counts by type |
| — | `LibraryFragment` (dialog) / `dialog_library.xml` | modal in `/library` | — | Library dialog |
| — | `dialog_delete_vbook.xml` / `dialog_edit_parameter.xml` / `dialog_generate_scope.xml` | modal pages/overlays | — | Confirmation/editing/scoped-generation dialogs |
| — | `item_chat_message.xml` / `item_chat_typing.xml` / `item_mode_chip.xml` / `item_worker_progress.xml` / `item_workflow_entry.xml` | list item components | — | RecyclerView items |

## 2. Android Component → Web Component

### 2.1. Navigation / shell

| Android | Web |
|---|---|
| `MainActivity` + `BottomNavigationView` (`bottom_nav.xml`) | `AppShell` + `TabBar` (5 tabs, hide/show by stores, generation status indicator) |
| `FragmentTransaction.hide/show` by tags | page state preservation (stores at shell level, don't unmount DOM) |
| `supportFragmentManager.beginTransaction().add(...).addToBackStack(null)` | secondary routes with back stack |
| `toolbar` + `settingsButton` + `toolbarAiButton` | shared `Toolbar` (+ `Settings`/`AI` buttons) |
| Cold start: `MainActivity.onCreate` → `GenerateViewModel.restoreBookSession()` — SharedPreferences `bookId`/`buildId`, validate `GET /book/{id}/status` + fallback `GET /api/v1/books`, player warmup | Start: `main.tsx` → `generateStore.restoreBookSession()` — localStorage `animastor:currentBook`, same validation + fallback (no auto-navigation) |
| `switchToPlayTab/GenerateTab/NavigateTab/AiTab` | programmatic `router.push('/play'\|...)` |

### 2.2. UI widgets

| Android | Web |
|---|---|
| `MaterialButton` (`Widget.Animastor.Button`, cornerRadius 18dp) | `<button class="btn">` (CSS token radius medium) |
| `MaterialButton.Tonal` / `.Mode` / `.Outlined` | modifiers `.btn--tonal`, `.btn--mode`, `.btn--outlined` |
| `Chip` (`Widget.Animastor.Chip.Layer`) icon-toggle 48dp | `<button class="chip chip--layer">` (icon-only, SVG tint by `currentColor`) |
| `Chip` mode/topic/toggle (state-list bg/icon/stroke) | `.chip--mode`, `.chip--topic`, `.chip--toggle` |
| `MaterialCardView` (`Widget.Animastor.Card`) | `<article class="card">` (radius large/elevation) |
| `TabLayout` (`Widget.Animastor.TabLayout`) | `.tabs` |
| `LinearProgressIndicator` / `CircularProgressIndicator` | `<progress class="bar">` / `.spinner` (CSS) |
| `RecyclerView` + adapter (`ChatAdapter` etc.) | list (`v-for`/`.map`) with item components |
| `ConstraintLayout` | CSS Grid/Flexbox + anchor-utility (connector flow) |
| `HorizontalScrollView` (layer bar) | `.scroll-x` (overflow-x: auto, hidden scrollbar like `scrollbar_*.xml`) |
| `SurfaceView` (video) | `<video>`/`<canvas>` |
| `WaveformView` (custom Canvas) | Canvas component `Waveform` (see 2.3) |
| `WebView` (Library) | `<iframe>` or inline render |

### 2.3. Player-specific

| Android | Web |
|---|---|
| `MediaPlayer` ×3 (current/next audio + video overlay) | Web Audio API / `<audio>` ×2 (current+next, gapless) + `<video>` overlay |
| `MediaPlayer.setNextMediaPlayer` (gapless) | Web Audio `AudioBufferSourceNode` scheduling / `Media Session` + ping segment-switch |
| `getCurrentPosition()/duration`, `seekTo(ms)` | `audio.currentTime` / `audio.duration` / `audio.currentTime = ms/1000` |
| `MediaPlayer.setVolume(l,r)` | `GainNode.gain` / `audio.volume` |
| `SurfaceHolder.Callback` (video attach/refit) | `<video>` + `loadedmetadata`/`resize` event |
| `MediaDecoder.decodeBitmap` | `createImageBitmap(blob)` / `<img>.src = URL.createObjectURL(blob)` |
| `SimpleDiskCache` (audio/video/image/preview/iu) | Cache API / IndexedDB with TTL and `clearCache()` |
| `SharedPositionManager` (ActivePosition) | `positionStore` (signal for Navigate/Edit→Play) |
| `PlaybackViewModel.uiState` (phase enum) | `playbackStore` (phase enum, Play/Pause button + status) |
| `preloadAhead(includeCurrent=false)` 3 ahead | `preloadNextScenes(3)` with retry/backoff |
| IU-cycling (by `currentPosition` → idx, delay 50ms) | RAF-loop / `requestAnimationFrame` by `audio.currentTime` |
| handleSilentChunk (timer-based cycling without MediaPlayer) | timer mode on `setInterval`/RAF when no audio (e.g., Cover) |
| Fullscreen, `anchorFullscreenToImage()`, letterbox | Fullscreen API + computed anchor CSS |
| `onHiddenChanged/onPause/onResume`, `savedPlaybackPositionMs` | `Page Visibility` + `visibilitychange` |
| `.vbook` ACTION_VIEW intent | `<input type=file>` + drag-drop; deep link `?book=…` |

### 2.4. Generation / AI

| Android | Web |
|---|---|
| `GenerateViewModel` (generationStatus, vbookProgress, playbackPrepared) | `generateStore` (status `RUNNING/ERROR/SUCCESS/IDLE`, `VBookStage`, emits `playbackPrepared`) |
| `ChatAdapter` / `item_chat_message` / `item_chat_typing` | `AiChat` + `ChatMessage`/`ChatTyping` items |
| `ChatHistoryManager` (sessions/messages) | `aiSessions` feature (`/api/v1/ai/sessions*`) |
| `AssistantMode` (`item_mode_chip`) | mode-chip component (see 2.2) |
| `WorkerCounts` / `item_worker_progress` | `/api/v1/worker/counts` + `.worker-progress` item |

## 3. Design tokens `cinema_*` → CSS

| Android (colors.xml) | CSS var | Where used |
|---|---|---|
| `cinema_background` | `--bg` | windowBackground, status/nav bar |
| `cinema_surface` | `--surface` | toolbar/layer bar/cards |
| `cinema_surface_variant` | `--surface-2` | surfaceVariant |
| `cinema_surface_dim` | `--surface-dim` | colorSurfaceDim (player background) |
| `cinema_primary` / `cinema_on_primary` | `--primary` / `--on-primary` | button, active tab |
| `cinema_primary_container` | `--primary-container` | primaryContainer |
| `cinema_accent` / `cinema_on_accent` | `--accent` / `--on-accent` | secondary: status indicator, play highlights |
| `cinema_accent_container` / `cinema_accent_dim` | `--accent-container` / `--accent-dim` | light theme accent |
| `cinema_error` / `cinema_error_container` | `--error` / `--error-container` | error status, layer/chip |
| `cinema_text_primary` / `cinema_text_secondary` | `--text` / `--text-2` | text, outline |
| `cinema_outline` / `cinema_outline_variant` | `--outline` / `--outline-2` | outline, progress track |
| `cinema_scrim` | `--scrim` | `previewOverlay` letterbox |
| `subtitle_background` | `--subtitle-bg` | `subtitleText` |
| `cinema_missing_bg` | `--missing-bg` | `iuMissingOverlay` ("Not generated") |
| Light variants `cinema_light_*` | `--light-*` (in `theme-light.css`) | light theme |

Rounded corners: `--radius-small: .75rem` (12), `--radius-medium: 1.125rem` (18),
`--radius-large: 1.75rem` (28). Chevron exceptions — `.chip--chevron-left/right`.

## 4. Backend API → HTTP client (`/api/v1`)

Endpoint categories from `BackendApi.kt` (migrated 1:1):

| Group | Example paths | Used by screens |
|---|---|---|
| Book | `/book/{id}` (GET/PUT/DELETE), `/book/{id}/import`, `/cover`, `/metadata`, `/export`, `/download`, `/storyboard`, `/audio`, `/diff`, `/regenerate`, `/cancel-generation`, `/cancel-worker`, `/snapshot`, `/reorder`, `/cache`, `/status`, `/assets-state`, `/layer-config`, `/bootstrap*`, `/resume-bootstrap`, `/trigger-next-window`, `/progress-panel`, `/generation-state`, `/text-index`, `/preliminary`, `/chapters-summary`, `/lazy-parse*`, `/source`, `/agent-status`; **`/books`** (recent books list on server — session recovery) | File, Generate, Edit, Settings |
| Scene (timeline) | `/scene/{book}/{ch}/{sc}/audio\|image\|video\|storyboard\|status\|waveform\|timings` (GET; timings PUT) | Play, Edit |
| Chunk (legacy) | `/chunk/{id}`, `/chunk/{id}/audio\|image\|video\|storyboard` | legacy paths |
| IU | `/iu-image/{book}/{ch}/{sc}/{iu}`, `/preview/{book}/{ch}/{sc}/{iu}` | Play, Edit |
| AI | `/ai/chat`, `/ai/sessions` (GET/POST), `/ai/sessions/{id}` (PATCH/DELETE), `/ai/sessions/{id}/messages` | AiAssistant |
| Worker | `/worker/counts` | Generate, WorkerSettings |
| Connectors | `/connectors`, `/connectors/{name}` (+ `/compatibility`, `/raw`, `/parameters`, `/status`, `/bindings`), `/connectors/validate\|reload\|entities\|grouped\|profiles` | DeveloperView, Settings |
| Workflows | `/workflows`, `/workflows/{name}` (+`/hash`), `/workflows/summary` | WorkflowManager, WorkflowDetails |

> Full method/model list — `BackendApi.kt` and `repository/*Models.kt`;
> each model to TS type mapping done when consumer screen work begins.

## 5. Strings → i18n

- Source: `res/values/strings.xml` (en) and `res/values-ru/strings.xml` (ru).
- Keys (`R.string.*`) → flat i18n dictionary (`{ ru: {...}, en: {...} }`).
- `auto` mode uses `navigator.language`. Migration example: keys
  `play_play`, `play_pause`, `play_loading`, `play_ready`, `play_playing`,
  `play_paused`, `play_placeholder`, `play_generate_hint`, `iu_not_generated`,
  `layer_audio/image/video/subtitles`, `tab_file/generate/play/edit/navigate`,
  `upload_failed`, `empty_state*_`. Full list extracted from `strings.xml`.
