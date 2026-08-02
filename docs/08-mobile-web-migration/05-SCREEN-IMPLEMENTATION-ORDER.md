# 05. План переноса экранов (простые → сложные)

Порядок реализации выбран **от самых простых к самым сложным**, чтобы накопить
каркас, design tokens, i18n, HTTP-клиент и кэш-слой на тривиальных экранах до
самого рискованного — плеера. Каждая итерация заканчивается критериями приёмки
из [`02-DESIGN-PRESERVATION-PRINCIPLES.md`](02-DESIGN-PRESERVATION-PRINCIPLES.md) §3.

> Перед реализацией **любого** экрана должен быть готов каркас из этапа 0.

---

## Этап 0 — Каркас (до экранов)

- Shell: роутер + `TabBar` (5 вкладок) + `Toolbar` (Settings/AI) + сохранение
  состояния вкладок (storы на уровне shell).
- Design tokens: `theme-dark.css`/`theme-light.css` из `colors.xml`/`themes.xml`;
  `auto`-режим по часу (как в Android `applyTheme()`).
- i18n: словари ru/en из `strings.xml`; `auto` по `navigator.language`.
- `api/client.ts`: fetch-обёртка base `/api/v1/`, SSE-клиент, `retryWithBackoff`,
  streaming-Blob.
- `cache/mediaCache.ts`: Cache API/IndexedDB, `clearCache(buildId?)`.
- `state/*`: `positionStore` (SharedPositionManager), заглушки `generateStore` /
  `playbackStore`.
- SVG-иконки из `res/drawable/ic_*.xml`.
- `index.html`: meta viewport, тема, загрузчик.

Приёмка: открытие `m.animastor.in` показывает пустой shell с тёмной темой,
рабочий tab-bar (пустые страницы), переключение вкладок сохраняет их состояние,
`Settings`/`AI` кнопки открывают secondary-маршруты (заглушки).

---

## Этап 1 — Простейшие статичные/диалоговые экраны

| Шаг | Экран | Почему простой | Ключевые API/модели |
|---|---|---|---|
| 1.1 | **Settings** (`/settings`) | статичная форма, tiny API | тема + язык (localStorage, как `PREFS_*`), `getBook/updateBook/deleteBook/exportBook/downloadBook/clearBookCache/cancelGeneration` |
| 1.2 | **VBookSettings** (`/settings/vbook`) | форма 1-2 поля | `chunk size (scenes per pass)` из `GenerateViewModel` |
| 1.3 | **WorkerSettings** (`/settings/worker`) | форма по типам воркеров | `/worker/counts` |
| 1.4 | **Library** (`/library`) | WebView контента | iframe справки/релиз-ноутсов |

Приёмка: визуально и текстово совпадает с `fragment_*.xml`; тема/язык реально
переключают shell; сохранение настроек в localStorage (= `SharedPreferences`).

### Завершение этапа 1 (2026-08-02) ✅

- 1.1 Settings — готово на этапе 0 (тема/язык), добавлены nav-строки VBook/Worker.
- 1.2 VBookSettings (`/settings/vbook`) — `select` 1..5, «Default» → 3, Apply →
  `PUT /book/{id}/layer-config {chunk_size}`, `GET` при открытии. Без открытой
  книги — уведомление + Apply disabled (в Android — тихий no-op).
- 1.3 WorkerSettings (`/settings/worker`) — один маршрут на 3 типа воркера
  (segmented control audio/image/video вместо 3 отдельных фрагментов Android):
  карточка «Воркеры» (`/worker/counts`), профиль (`/connectors/profiles`),
  таймаут (`layer-config` GET/PUT, диапазоны как в Android), workflow
  (`/connectors/grouped` → активные коннекторы), кнопка «Manage» →
  `/workflows/type/:type`. Apply сохраняет только таймаут (как в Android).
- 1.4 Library (`/library`) — `iframe` → `https://animastor.in` + ссылка «Открыть
  в браузере»; вход из File-вкладки (аналог `libraryCard`).

Отклонения и решения — [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §5, §9.

---

## Этап 2 — Сетевые списки/детали (без плеера и генерации)

| Шаг | Экран | Сложность | API/модели |
|---|---|---|---|
| 2.1 | **WorkflowManager** (`/workflows`) | список + сводка | `/workflows`, `/workflows/summary` (`WorkflowSummaryResponse`) |
| 2.2 | **WorkflowDetails** (`/workflows/:name`) | детали + hash + узлы | `/workflows/{name}`, `/workflows/{name}/hash` (`WorkflowDetail`, `WorkflowHashResponse`) |
| 2.3 | **WorkflowTypeList** (`/workflows/type/:type`) | узлы по типу | `WorkflowTypeListFragment` (sharedViewModel) |
| 2.4 | **DeveloperView** (`/dev`) | коннектор: параметры/биндинги/совместимость | `/connectors*` (`ConnectorDetail`, `CompatibilityStatus`, `putConnectorParameter/Binding/Status`, `validateConnector`, `reloadConnectors`, `getConnectorEntities`) |
| 2.5 | **AiAssistant** (`/ai`) | чат с сессиями/историей; режимы; typing | `/ai/chat`, `/ai/sessions*`, `/ai/sessions/{id}/messages` (`ChatAdapter`, `ChatHistoryManager`, `AssistantMode`) |

Приёмка: рекурсия навигации `WorkflowManager→Details→TypeList→DeveloperView`
работает; чат отправляет/принимает сообщения, показывает typing, переключает
режимы, список сессий создаётся/редактируется/удаляется.

### Завершение этапа 2 (2026-08-02) ✅

- 2.1 WorkflowManager (`/workflows`) — 3 карточки audio/image/video из
  `/connectors/grouped` (F12: активные счётчики серверные), subtitle = первый
  коннектор, кнопка Reload → `POST /connectors/reload`. `/workflows/summary`
  НЕ используется (Android-фрагмент тоже не использует — менеджер построен на
  grouped-коннекторах, см. §11).
- 2.2 WorkflowDetails (`/workflows/:name`) — header-карточка (connector/type/
  status/hash/version/nodes), 4 таба (Inputs/Outputs/Parameters/Compatibility),
  edit-режим (`routeState.detailsEditMode`, как fragment-аргумент editMode),
  правка параметров через диалог (`PUT /connectors/{name}/parameters`),
  в edit-режиме — смарт-пикер нод для биндингов/гайд-нод
  (`PUT /connectors/{name}/bindings`), dev-чип `</>` → `/dev`.
- 2.3 WorkflowTypeList (`/workflows/type/:type`) — список коннекторов типа из
  `/connectors/grouped`, enable/disable switch (`PUT .../status`), статус-бейджи,
  Details → `/workflows/:name` (disabled → edit-режим), Add Workflow — чтение
  JSON-файла и `POST /connectors` (имя из `name` или guess из имени файла).
- 2.4 DeveloperView (`/dev`) — табы Raw JSON (`/connectors/{name}/raw`,
  pretty-print) / Bindings (плоская таблица inputs/outputs/parameters с
  multi-binding-разворотом), переход по dev-чипу с `routeState.devConnector`.
- 2.5 AiAssistant (`/ai`) — чат 1:1: сессии (`/ai/sessions?book_id=`, restore,
  create, delete), 6 mode-чипов (AssistantMode), typing-индикатор, position-bar
  (из `positionStore` + book), markdown-бабблы (порт `applyMarkdownTo`),
  копирование, download-ссылка при `book_id` в ответе, discard ответа при
  смене сессии, голосовой ввод через Web Speech API (fallback — тост).

Отклонения и решения — [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §11.

---

## Этап 3 — File (импорт/экспорт)

| Шаг | Содержание | Почему сейчас |
|---|---|---|
| 3.1 | **File** (`/file`) | Импорт `.vbook`/txt через `<input type=file>` + drag-drop (`POST /book/import` multipart); список книг; экспорт/скачивание (`GET /book/{id}/export\|download`); глубокая ссылка `?book=`. Триггерит `generateStore.loadBook()` и переход на `Generate`/`Play`. | Нужен входной поток книги для всех остальных экранов. |

Приёмка: импорт книги → `Generate` видит книгу; экспорт/скчивание работают;
повторный выбор уже открытой книги не ломает состояние (как `pendingExportBookId`).

### Завершение этапа 3 (2026-08-02) ✅

- 3.1 File (`/file`) — 3 карточки 1:1 с `fragment_file.xml`: Import from Device
  (`<input type=file>` + drag-drop → `POST /book/import`, статус импорта из
  `importProgressMessages.take(4)` / фаз `file_status_*`), Create New Book
  (`closeBook()` + → `/ai` в create-режиме), Library (→ `/library`).
- Скачивание: 4 карточки (book/storyboard/audio/video) с теми же правилами
  enabled, что в Android (`!exporting && bookId` для .vbook;
  `!exporting && bookId && buildId && SCENE_READY/PLAYING` для остальных);
  загрузка через fetch-Blob → `<a download>` (эквивалент CreateDocument),
  прогресс по Content-Length, статусы `export_preparing*` → `export_progress` →
  `export_saved` (3s) → очистка.
- Импорт (vbook/txt) завершается `navigationEvent` → `/play`|`/generate` по
  сценам и `has_assets` (логика `importBookFromFile` 1:1), `generateStore.loadBook()`
  выставлен — `Generate`/`Play` увидят книгу (сами экраны — этапы 4/7).
- Deep link `?book=<id>`/`?open=<id>` — книга грузится с сервера по id
  (`GET /book/{id}`), параметр снимается после обработки. Отклонения —
  [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §12.

---

## Этап 4 — Generate (прогресс и координация)

| Шаг | Содержание | Риски |
|---|---|---|
| 4.1 | **Generate** (`/generate`) — запуск генерации, SSE-прогресс, статус по scope (`/progress-panel?scope=…&chapter_id=…&scene_id=…`), чипы режимов/тем/воркеров, индикатор статуса на tab-иконке (`running`/`error`/`success`, авто-сброс по таймеру как в `MainActivity.updateNavIconStatus`). Emits `playbackPrepared` → `playbackStore.preparePlayback()` (воспроизвести `setupPlaybackCoordination`). | SSE-монотонность/lost reconnect (см. `docs/05-frontend/PROGRESS_HANDOFF.md`). Скоординировать с плеером **до** этапа 5. |

Приёмка: запуск генерации, прогресс корректен при reconnect, после завершения
`Play` автоматически готов играть (через `playbackPrepared`), статус-иконка
корректно пульсирует и авто-сбрасывается.

### Завершение этапа 4 (2026-08-02) ✅

- 4.1 Generate (`/generate`) — 1:1 с `fragment_generate.xml`:
  position-bar (→ `/navigate`), Global-секция (Generate All / Stop All),
  4 секции воркеров (VBook/Audio/Image/Video) с header-строкой
  (акцент-бар/икона/счётчик/gear → настройки/toggle-чип), прогресс-рядами и
  кнопками Generate/Stop. Toggle-чипы персистятся в `PUT /layer-config`.
- Прогресс: `computeProgressRows` (порт из `GenerateViewModel`): new-gen gate,
  monotonic floor, 10s done-window, all-cancelled, финализация SUCCESS;
  VBook-ряд из `/agent-status` poll (2s) + SSE `import_complete`.
- Движки: worker counts poll 5s; progress-panel poll 1.5s; timer 500ms;
  `checkAndRestoreGenerationState` 2.5s после mount (R11).
- Действия: `POST /regenerate` (scope+worker_types), `bootstrap`/
  `bootstrap-next-window` (VBook), `/cancel-generation`, `/cancel-worker
  {type|task_id}`. Scope-диалог 1:1 (`DialogGenerateScope`), позиционные
  опции disabled без `positionStore`.
- Координация: `playbackStore.wirePlaybackCoordination()` =
  `setupPlaybackCoordination` (preparePlayback / refreshContent по softRefresh);
  `applyGenerationResults` эмитит soft-refresh после завершения.
- Tab-иконка: RUNNING/ERROR/SUCCESS пульс (`tabbar__pulse*`) + авто-сброс 22s.
  Отклонения — [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §13.

---

## Этап 5 — Navigate (карта-закладки → seek)

| Шаг | Содержание |
|---|---|
| 5.1 | **Navigate** (`/navigate`) — дерево глав→сцен→юнитов (`getBook`, `sceneRefs()`, `getTextIndex`, `getChaptersSummary`); выбор узла → `positionStore.navigateTo(...)` + `router.push('/play')` + `playbackStore.seekToPosition(...)` (1:1 с `seekToPosition`: refresh book JSON при отсутствии сцены, `missingIuPosition` overlay). |

Приёмка: переход из Navigate в Play делает seek в нужный юнит; при отсутствии
сцены показывается overlay «не сгенерировано» (как `showMissingChunkOverlay`).

### Завершение этапа 5 (2026-08-02) ✅

- 5.1 Navigate (`/navigate`) — 1:1 с `fragment_navigate.xml` +
  `BookStructureAdapter` (главы/сцены/юниты): position-bar (`updatePositionBar`
  с Cover/Prologue и `display_number`), loading, empty-state, лейблы глав/сцен/
  юнитов (включая `— type (style)` для сцен и `[type]` для юнитов),
  авто-раскрытие текущей сцены, preview-миниатюры через `GET /preview`
  (`getIuPreview`-эквивалент, fallback `ic_image_off`).
- Клик по юниту → `positionStore.navigateTo` + `playbackStore.seekToPosition`
  (полная логика: сцена в очереди → pendingExternalSeek; сцены нет → refresh
  book JSON → `missingIuPosition`) → `router.push('/play')`.
- `PlayPage` показывает оверлей `missingIuPosition` («Не сгенерировано», как
  `showMissingChunkOverlay`) — полноценный плеер остаётся этапу 7.
- Перезагрузка дерева по `playbackPrepared` (генерация завершена).
- Отклонения — [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §14.

---

## Этап 6 — Edit (таймлайн + waveform)

| Шаг | Содержание | Риски |
|---|---|---|
| 6.1 | **Edit** (`/edit`) — список сцен/юнитов, waveform (`getSceneWaveform` → `WaveformView`-рендер на Canvas), предпросмотр IU-изображений, редактирование/сохранение таймингов (`GET/PUT /scene/.../timings`), `layer-config` (`GET/PUT /book/{id}/layer-config`). Переход в `Play` c seek по выбранному юниту. | waveform на canvas; сохранение таймингов с валидацией; синхронизация с `playbackStore` (те же `seekToPosition`/`positionStore`). Средне-высокий риск — см. 06. |

Приёмка: waveform рисуется идентично; правка таймингов сохраняется и влияет на
разбиение IU-cycling в Play; layer-config персистится.

---

## Этап 7 — Play (мультиплеер) — финальный, высший риск

| Шаг | Содержание | Зависимости |
|---|---|---|
| 7.1 | Подэкра: `playbackStore` (`PlaybackUiState`, `sceneQueue`, `currentIndex`, `currentUnitIndex`, preloadCache, `pendingSceneAudio/Video/IuSequence`, layer toggles, `needsContentRefresh`/`needsRotationResume` аналоги), `positionStore`. | Все предыдущие экраны. |
| 7.2 | UI каркас Play (`fragment_play.xml` 1:1): media viewport, layer bar (4 чипа), big-play-button, progress, status, fullscreen, curtains/cover/result/overlay/subtitle. | Design tokens готовы. |
| 7.3 | Движок воспроизведения: 2 аудио-источника (current+next, gapless-приближение), 1 video overlay, IU-cycling по `currentTime` (RAF), silent IU-режим (Cover), seek по `unitIndex` (сумма `durationMs`), `preloadAhead(3)` с retry/backoff, `fetchSceneData` (status→audio→video→IU), soft-refresh (`refreshContent`) + `needsContentRefresh`. | Реализация/выбор альтернатив — 06 §Player. |
| 7.4 | Seek/навигация: `seekToPosition` (refresh book JSON при отсутствии, `missingIuPosition`), `executePendingSeek` (через `positionStore.navigateTo`), восстановление позиции (`savedPlaybackPositionMs` аналог через `Page Visibility`). | `positionStore` готов. |
| 7.5 | Lifecycle/видимость: пауза при скрытии вкладки/минимизации (`Page Visibility`), восстановление при возврате, корректный release ресурсов. | Каркас shell. |

Приёмка: воспроизводится очередь сцен с gapless-переходом; IU-картинки и
субтитры синхронизированы с аудио; видеослой показывается по `status.video_ready`;
seek из Navigate/Edit работает; soft-refresh после регенерации работает; пауза/
возобновление/полный экран работают; `DONT_DO.md`-антипаттерны не воспроизведены.

---

## Резюме порядка

```
0 каркас →
1 Settings/Lib/VBook/Worker (тривиально) →
2 Workflows/Dev/Ai (списки/детали/чат) →
3 File (импорт) →
4 Generate (SSE + координация) →
5 Navigate (карта→seek) →
6 Edit (waveform + timings) →
7 Play (мультиплеер, высший риск)
```

Каждый этап сопровождается записью в этот же раздел: статус, фактческие
отклонения (ссылки на `06-RISKS-AND-ALTERNATIVES.md`), визуальные/UX-расхождения.
