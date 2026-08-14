# 04. Таблицы соответствия Android → Web

Источники правды: `frontend/app/src/main/java/com/example/animastor/ui/`,
`res/layout/`, `res/menu/bottom_nav.xml`, `res/values/colors.xml`,
`themes.xml`, `strings.xml`, `repository/BackendApi.kt`.

---

## 1. Android Screen → Mobile Web Page

| # | Android (Fragment / layout) | Web Page (route) | Bottom nav? | Назначение |
|---|---|---|---|---|
| 1 | `FileFragment` / `fragment_file.xml` | `/file` | ✅ старт | Открытие/импорт книги (`.vbook`, txt), список, экспорт, скачивание |
| 2 | `GenerateFragment` / `fragment_generate.xml` | `/generate` | ✅ #2 | Запуск генерации, прогресс (SSE), статусы по scope, индикатор на tab-иконке |
| 3 | `PlayFragment` / `fragment_play.xml` | `/play` | ✅ #3 | Мультиплеер: очередь сцен, IU-cycling с субтитрами, слои audio/image/video/subtitles, fullscreen, seek — **высокий риск** (см. 06) |
| 4 | `EditFragment` / `fragment_edit.xml` | `/edit` | ✅ #4 | Таймлайн сцен/юнитов, waveform, редактирование таймингов, layer-config |
| 5 | `NavigateFragment` / `fragment_navigate.xml` | `/navigate` | ✅ #5 | Карта глав→сцен→юнитов, переход → `Play.seekToPosition` |
| 6 | `SettingsFragment` / `fragment_settings.xml` | `/settings` | secondary | Тема (dark/light/auto), язык (ru/en/auto), книга: экспорт/скачивание/удаление |
| 7 | `AiAssistantFragment` / `fragment_ai_assistant.xml` | `/ai` | secondary | Чат с AI: сессии (`/ai/sessions`), история, режимы (`AssistantMode`), отправка (`/ai/chat`) |
| 8 | `LibraryFragment` / `fragment_library.xml` | `/library` | secondary | WebView со справкой/релиз-ноутсами (`ChatHistoryManager`-стиль) |
| 9 | `WorkflowManagerFragment` / `fragment_workflow_manager.xml` | `/workflows` | secondary | Список воркфлоу, сводка, статусы (`/workflows`, `/workflows/summary`) |
| 10 | `WorkflowDetailsFragment` / `fragment_workflow_details.xml` | `/workflows/:name` | secondary | Детали воркфлоу: hash, узлы, параметры |
| 11 | `WorkflowTypeListFragment` / `fragment_workflow_type_list.xml` | `/workflows/type/:type` | secondary | Список узлов воркфлоу по типу (audio/image/…) |
| 12 | `DeveloperViewFragment` / `fragment_developer_view.xml` | `/dev` | secondary | Dev-вид: коннектор, параметры, биндинги, совместимость |
| 13 | `VBookSettingsFragment` / `fragment_vbook_settings.xml` | `/settings/vbook` | secondary | Настройки генерации VBook (chunk size «scenes per pass») |
| 14 | `WorkerSettingsFragment` / `fragment_worker_settings.xml` | `/settings/worker` | secondary | Таймауты/численность воркеров по типу |
| — | `LibraryFragment` (диалог) / `dialog_library.xml` | модал в `/library` | — | Диалог библиотеки |
| — | `dialog_delete_vbook.xml` / `dialog_edit_parameter.xml` / `dialog_generate_scope.xml` | модальные страницы/overlays | — | Диалоги подтверждения/редактирования/scoped-генерации |
| — | `item_chat_message.xml` / `item_chat_typing.xml` / `item_mode_chip.xml` / `item_worker_progress.xml` / `item_workflow_entry.xml` | списковые item-компоненты | — | Items RecyclerView’ов |

## 2. Android Component → Web Component

### 2.1. Navigation / shell

| Android | Web |
|---|---|
| `MainActivity` + `BottomNavigationView` (`bottom_nav.xml`) | `AppShell` + `TabBar` (5 вкладок, hide/show по stores, индикатор статуса генерации) |
| `FragmentTransaction.hide/show` по тегам | сохранение состояния страницы (storы на уровне shell, не размонтировать DOM) |
| `supportFragmentManager.beginTransaction().add(...).addToBackStack(null)` | secondary-маршруты с back stack |
| `toolbar` + `settingsButton` + `toolbarAiButton` | общий `Toolbar` (+ кнопки `Settings`/`AI`) |
| Холодный старт: `MainActivity.onCreate` → `GenerateViewModel.restoreBookSession()` — SharedPreferences `bookId`/`buildId`, валидация `GET /book/{id}/status` + fallback `GET /api/v1/books`, прогрев плеера | Старт: `main.tsx` → `generateStore.restoreBookSession()` — localStorage `animastor:currentBook`, та же валидация + fallback (без авто-навигации) |
| `switchToPlayTab/GenerateTab/NavigateTab/AiTab` | программная навигация `router.push('/play'\|...)` |

### 2.2. UI-виджеты

| Android | Web |
|---|---|
| `MaterialButton` (`Widget.Animastor.Button`, cornerRadius 18dp) | `<button class="btn">` (CSS token radius medium) |
| `MaterialButton.Tonal` / `.Mode` / `.Outlined` | модификаторы `.btn--tonal`, `.btn--mode`, `.btn--outlined` |
| `Chip` (`Widget.Animastor.Chip.Layer`) icon-toggle 48dp | `<button class="chip chip--layer">` (icon-only, SVG tint by `currentColor`) |
| `Chip` mode/topic/toggle (state-list bg/icon/stroke) | `.chip--mode`, `.chip--topic`, `.chip--toggle` |
| `MaterialCardView` (`Widget.Animastor.Card`) | `<article class="card">` (radius large/elevation) |
| `TabLayout` (`Widget.Animastor.TabLayout`) | `.tabs` |
| `LinearProgressIndicator` / `CircularProgressIndicator` | `<progress class="bar">` / `.spinner` (CSS) |
| `RecyclerView` + адаптер (`ChatAdapter` и др.) | список (`v-for`/`.map`) с item-компонентами |
| `ConstraintLayout` | CSS Grid/Flexbox + anchor-utility (connector flow) |
| `HorizontalScrollView` (layer bar) | `.scroll-x` (overflow-x: auto, скрытый скроллбар как `scrollbar_*.xml`) |
| `SurfaceView` (video) | `<video>`/`<canvas>` |
| `WaveformView` (custom Canvas) | Canvas-компонент `Waveform` (см. 2.3) |
| `WebView` (Library) | `<iframe>` или inline-рендер |

### 2.3. Player-specific

| Android | Web |
|---|---|
| `MediaPlayer` ×3 (current/next audio + video overlay) | Web Audio API / `<audio>` ×2 (current+next, gapless) + `<video>` overlay |
| `MediaPlayer.setNextMediaPlayer` (gapless) | Web Audio `AudioBufferSourceNode` scheduling / `Media Session` + пинг segment-switch |
| `getCurrentPosition()/duration`, `seekTo(ms)` | `audio.currentTime` / `audio.duration` / `audio.currentTime = ms/1000` |
| `MediaPlayer.setVolume(l,r)` | `GainNode.gain` / `audio.volume` |
| `SurfaceHolder.Callback` (video attach/refit) | `<video>` + `loadedmetadata`/`resize` event |
| `MediaDecoder.decodeBitmap` | `createImageBitmap(blob)` / `<img>.src = URL.createObjectURL(blob)` |
| `SimpleDiskCache` (audio/video/image/preview/iu) | Cache API / IndexedDB с TTL и `clearCache()` |
| `SharedPositionManager` (ActivePosition) | `positionStore` (сигнал для Navigate/Edit→Play) |
| `PlaybackViewModel.uiState` (phase enum) | `playbackStore` (phase enum, кнопка Play/Pause + status) |
| `preloadAhead(includeCurrent=false)` на 3 вперёд | `preloadNextScenes(3)` с retry/backoff |
| IU-cycling (по `currentPosition` → idx, delay 50ms) | RAF-loop / `requestAnimationFrame` по `audio.currentTime` |
| handleSilentChunk (timer-based cycling без MediaPlayer) | таймер-режим на `setInterval`/RAF, когда нет аудио (например Cover) |
| Fullscreen, `anchorFullscreenToImage()`, letterbox | Fullscreen API + computed anchor CSS |
| `onHiddenChanged/onPause/onResume`, `savedPlaybackPositionMs` | `Page Visibility` + `visibilitychange` |
| `.vbook` ACTION_VIEW intent | `<input type=file>` + drag-drop; deep link `?book=…` |

### 2.4. Generation / AI

| Android | Web |
|---|---|
| `GenerateViewModel` (generationStatus, vbookProgress, playbackPrepared) | `generateStore` (status `RUNNING/ERROR/SUCCESS/IDLE`, `VBookStage`, emits `playbackPrepared`) |
| `ChatAdapter` / `item_chat_message` / `item_chat_typing` | `AiChat` + `ChatMessage`/`ChatTyping` items |
| `ChatHistoryManager` (сессии/сообщения) | `aiSessions` feature (`/api/v1/ai/sessions*`) |
| `AssistantMode` (`item_mode_chip`) | mode-chip компонент (см. 2.2) |
| `WorkerCounts` / `item_worker_progress` | `/api/v1/worker/counts` + `.worker-progress` item |

## 3. Дизайн-токены `cinema_*` → CSS

| Android (colors.xml) | CSS var | Где используется |
|---|---|---|
| `cinema_background` | `--bg` | windowBackground, статус/нав-бар |
| `cinema_surface` | `--surface` | toolbar/layer bar/cards |
| `cinema_surface_variant` | `--surface-2` | surfaceVariant |
| `cinema_surface_dim` | `--surface-dim` | colorSurfaceDim (фон плеера) |
| `cinema_primary` / `cinema_on_primary` | `--primary` / `--on-primary` | button, active tab |
| `cinema_primary_container` | `--primary-container` | primaryContainer |
| `cinema_accent` / `cinema_on_accent` | `--accent` / `--on-accent` | secondary: status indicator, play highlights |
| `cinema_accent_container` / `cinema_accent_dim` | `--accent-container` / `--accent-dim` | light-тема accent |
| `cinema_error` / `cinema_error_container` | `--error` / `--error-container` | error status, слой/чип |
| `cinema_text_primary` / `cinema_text_secondary` | `--text` / `--text-2` | text, outline |
| `cinema_outline` / `cinema_outline_variant` | `--outline` / `--outline-2` | outline, progress track |
| `cinema_scrim` | `--scrim` | `previewOverlay` letterbox |
| `subtitle_background` | `--subtitle-bg` | `subtitleText` |
| `cinema_missing_bg` | `--missing-bg` | `iuMissingOverlay` ("Не сгенерировано") |
| Light-варианты `cinema_light_*` | `--light-*` (в `theme-light.css`) | светлая тема |

Скругления: `--radius-small: .75rem` (12), `--radius-medium: 1.125rem` (18),
`--radius-large: 1.75rem` (28). Chevron-исключения — `.chip--chevron-left/right`.

## 4. Backend API → HTTP-клиент (`/api/v1`)

Категории эндпоинтов из `BackendApi.kt` (переносятся 1:1):

| Группа | Примеры путей | Используется экранами |
|---|---|---|
| Book | `/book/{id}` (GET/PUT/DELETE), `/book/{id}/import`, `/cover`, `/metadata`, `/export`, `/download`, `/storyboard`, `/audio`, `/diff`, `/regenerate`, `/cancel-generation`, `/cancel-worker`, `/snapshot`, `/reorder`, `/cache`, `/status`, `/assets-state`, `/layer-config`, `/bootstrap*`, `/resume-bootstrap`, `/trigger-next-window`, `/progress-panel`, `/generation-state`, `/text-index`, `/preliminary`, `/chapters-summary`, `/lazy-parse*`, `/source`, `/agent-status`; **`/books`** (список последних книг на сервере — восстановление сессии) | File, Generate, Edit, Settings |
| Scene (таймлайн) | `/scene/{book}/{ch}/{sc}/audio\|image\|video\|storyboard\|status\|waveform\|timings` (GET; timings PUT) | Play, Edit |
| Chunk (legacy) | `/chunk/{id}`, `/chunk/{id}/audio\|image\|video\|storyboard` | legacy-пути |
| IU | `/iu-image/{book}/{ch}/{sc}/{iu}`, `/preview/{book}/{ch}/{sc}/{iu}` | Play, Edit |
| AI | `/ai/chat`, `/ai/sessions` (GET/POST), `/ai/sessions/{id}` (PATCH/DELETE), `/ai/sessions/{id}/messages` | AiAssistant |
| Worker | `/worker/counts` | Generate, WorkerSettings |
| Connectors | `/connectors`, `/connectors/{name}` (+ `/compatibility`, `/raw`, `/parameters`, `/status`, `/bindings`), `/connectors/validate\|reload\|entities\|grouped\|profiles` | DeveloperView, Settings |
| Workflows | `/workflows`, `/workflows/{name}` (+`/hash`), `/workflows/summary` | WorkflowManager, WorkflowDetails |

> Полный список методов/моделей — `BackendApi.kt` и `repository/*Models.kt`;
> маппинг каждой модели в TS-тип делается при начале работ экрана-потребителя.

## 5. Строки → i18n

- Источник: `res/values/strings.xml` (en) и `res/values-ru/strings.xml` (ru).
- Ключи (`R.string.*`) → плоский словарь i18n (`{ ru: {...}, en: {...} }`).
- Режим `auto`учитывает `navigator.language`. Пример переноса: ключи
  `play_play`, `play_pause`, `play_loading`, `play_ready`, `play_playing`,
  `play_paused`, `play_placeholder`, `play_generate_hint`, `iu_not_generated`,
  `layer_audio/image/video/subtitles`, `tab_file/generate/play/edit/navigate`,
  `upload_failed`, `empty_state*_`. Полный список снямается из `strings.xml`.
