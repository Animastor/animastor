# Технический аудит кодовой базы

## 1. Неиспользуемый код (удалено)

### Frontend (Kotlin)

| Файл | Что удалено | Причина |
|---|---|---|
| `GenerateViewModel.kt` | `workersRunning`, `isCached` переменные в `generateFromFile()` | Остались после удаления `waitForWorkers()` — вычисляются, но не используются |
| `GenerateViewModel.kt` | `_videosReady` / `videosReady` StateFlow, `startVideoCheck()`, `videoCheckJob` | Удалены в architectural-player-revision — polling видео готовности |
| `GenerateViewModel.kt` | `pollWithBackoff()`, `waitChunkReady()`, `waitWindowReady()`, `waitForWorkers()`, `resumeAfterWorkers()`, `waitStoryboardReady()`, `waitFirstAudio()`, `waitPreview()`, `waitForNextWindow()`, `startCoverRefresh()`, `waitGeneratedCover()` | 13 polling-функций — архитектурный остаток потоковой генерации |
| `PlayerPhase` enum | `LOADING_BOOK`, `GENERATING`, `DOWNLOADING` | Плеер больше не отслеживает стадии генерации |

### Backend (JavaScript)

| Файл | Что удалено | Причина |
|---|---|---|
| `runtime/scene-window.js` | `sceneHasValidContent()` — проверка что placeholder != valid | Устарело — placeholder теперь считается валидным для preview |

## 2. Неиспользуемые переменные и константы

### Найдено и удалено

| Файл | Переменная | Статус |
|---|---|---|
| `GenerateViewModel.kt` | `POLL_TIMEOUT_MS = 300_000L` | Удалён |
| `GenerateViewModel.kt` | `IMAGE_POLL_TIMEOUT_MS = 1_800_000L` | Удалён |
| `GenerateViewModel.kt` | `POLL_INTERVAL_MS = 300L` | Удалён |
| `GenerateViewModel.kt` | `INITIAL_WAIT_COUNT = 3` | Удалён |
| `GenerateViewModel.kt` | `WINDOW_RETRY_COUNT = 60` | Удалён |
| `GenerateViewModel.kt` | `MAX_BACKOFF_MS = 5_000L` | Удалён |
| `GenerateViewModel.kt` | `coverRefreshJob` | Удалён |
| `GenerateViewModel.kt` | `workersRunning` (локальная в generateFromFile) | **Удалено** |
| `GenerateViewModel.kt` | `isCached` (локальная в generateFromFile) | **Удалено** |

### Оставлено (ещё используется, но подозрительно)

| Файл | Переменная | Примечание |
|---|---|---|
| `GenerateViewModel.kt` | `_backgroundGenStatus`, `_backgroundGenProgress` | Используется toolbar для отображения прогресса window gen |
| `GenerateViewModel.kt` | `_lastTriggeredScene` | Используется для dedup trigger-next-window |
| `GenerateViewModel.kt` | `_windowStartCreatedScenes` | Используется для расчёта прогресса window gen |
| `GenerateViewModel.kt` | `IuStatus` enum (READY, NOT_GENERATED, FAILED) | Используется в fetchIuSequence |
| `GenerateViewModel.kt` | `missingIuPosition` в UiState | Используется для показа оверлея "сцена не найдена" |

## 3. Архитектурные остатки

### Удалено

1. **Фазы потокового плеера**: `GENERATING`, `DOWNLOADING`, `LOADING_BOOK` — плеер не знает о генерации
2. **Polling-механизмы**: 13 функций, опрашивавших Redis/backend о готовности
3. **Проверка placeholder воркером**: `sceneHasValidContent()` в scene-window.js считала placeholder невалидным
4. **Ожидание воркеров**: `waitForWorkers()` — плеер ждал GPU-воркеров перед Start

### Оставлено (но требуется рефакторинг)

1. **`chunkQueue` в GenerateViewModel** — очередь chunk ID'шников, 1:1 с индексами сцен. Можно заменить прямым чтением book.json
2. **`chunkPositions`** — маппинг chunkID → (chapterId, sceneId). Дублирует данные book.json
3. **`fetchIuSequence()`** — загружает IU изображения по одному. Требует 1 HTTP-запрос на IU
4. **`startGeneration()`** — всё ещё использует `_uiState.update { copy(phase = ...) }` хотя фаза больше не влияет на плеер
5. **`UiState.mode`** — поле `"full" | "storyboard" | "audio_only"` — наследие от воркер-пайплайна

## 4. Большие файлы (требуют разделения)

### Frontend

| Файл | Строк | Проблема |
|---|---|---|
| `GenerateViewModel.kt` | **1687** | Содержит: импорт TXT, плеер, загрузку книги, генерацию, экспорт, layer config, preloader — **7+ ответственностей** |
| `EditFragment.kt` | 1168 | Редактор + навигация по IU + diff |
| `PlayFragment.kt` | 1156 | Плеер + IU cycling + video overlay — можно вынести MediaPlayer в отдельный класс |
| `AiAssistantFragment.kt` | 761 | Чат + TXT import UI |
| `Repository.kt` | 629 | Все HTTP-вызовы — можно разделить на domain-репозитории |
| `MainActivity.kt` | 574 | Toolbar + worker panel + генерация |

### Backend

| Файл | Строк | Проблема |
|---|---|---|
| `backend.cjs` | **~2600+** | Монолит: API endpoints, Redis helpers, chunking, recovery — **явно требует разделения** |
| `api/runtime.js` | 2121 | Runtime API |
| `agent-service.js` | 1344 | AI pipeline: структура, персонажи, сцены, юниты, визуалы |
| `lazy-book.js` | 1315 | Book state machine + lazy parse + create/append scenes |
| `scene-orchestrator.js` | 981 | Orchestration logic |
| `runtime/*.js` | 20+ файлов > 500 | Governance runtime — потенциально избыточен для текущей архитектуры |

## 5. Дублирование логики

| Где | Что дублируется | Предложение |
|---|---|---|
| `GenerateViewModel.kt` и `EditFragment.kt` | `fetchIuSequence` — логика загрузки IU изображений | Вынести в отдельный `IuLoader` сервис |
| `lazy-book.js` | `lazyParseChapter()` и `lazyParseNextWindow()` — почти идентичная логика парсинга глав | Объединить |
| `agent-service.js` и `txt-importer.js` | Оба содержат `bootstrapNextWindow()` — одинаковый вызов | `txt-importer.js` просто делегирует в `agent-service.js` — можно убрать прослойку |
| `backend.cjs` | `saveChunk()` вызывается в 4+ местах с одинаковыми параметрами | Создать `SceneChunkService.createForScene()` |
| `runtime/*.js` | `scene-window.js` и `backend.cjs` — оба работают с BOOK_SCENE_TOTAL/NEXT/WINDOW_START | Централизовать Redis-ключи |

## 6. Логирование

### Избыточное логирование (можно удалить/сократить)

| Файл | Строк логов | Рекомендация |
|---|---|---|
| `GenerateViewModel.kt` | ~80 `Log.i/d/w` вызовов | Сократить до 1-2 key моментов на функцию |
| `PlayFragment.kt` | ~50 `Log` вызовов | Убрать `Log.d` в hot path (startIuCycling) |
| `agent-service.js` | Интенсивное логирование каждого шага | Оставить, полезно для диагностики AI |
| `backend.cjs` | Логирование практически каждого HTTP запроса | Оставить для эксплуатации |

### Критично убрать

- `Log.w(TAG, "no workers detected...")` — удалено вместе с `workersRunning`
- `Log.i(TAG, "first MediaPlayer started...")` и подобные в PlayFragment — полезны

## 7. Технический долг

### Критический

| # | Проблема | Риск | Файл |
|---|---|---|---|
| 1 | **APK не компилируется**: `Unresolved reference: getCurrentChunkId` | Приложение не собирается | `PlayFragment.kt` |
| 2 | **Silent audio → IU cycling зависает** | Без MediaPlayer IU не переключаются | `PlayFragment.kt` — `startIuCycling()` |
| 3 | **GenerateViewModel.kt — 1687 строк, 7+ ответственностей** | Сложность поддержки | GenerateViewModel.kt |

### Средний

| # | Проблема | Файл |
|---|---|---|
| 4 | `generateFromFile()` — устаревший метод для vbook, не используется новым TXT-флоу | GenerateViewModel.kt |
| 5 | `waitForWorkers()` блок удалён, но `generateFromFile()` всё ещё содержит путь с воркер-чеками | GenerateViewModel.kt |
| 6 | `backend.cjs` — 2600+ строк монолит, требует разделения на route-файлы | backend.cjs |
| 7 | `runtime/*.js` — 20+ файлов > 500 строк governance-системы, большая часть не используется | runtime/ |

### Низкий

| # | Проблема | Файл |
|---|---|---|
| 8 | `IuStatus.NOT_GENERATED` — флаг, который никогда не используется для блокировки (только для логирования) | GenerateViewModel.kt |
| 9 | `UiState.missingIuPosition` — наследие, можно заменить null-проверкой currentChunkId | GenerateViewModel.kt |
| 10 | `@Streaming` аннотации в BackendApi.kt — корректны, но избыточны (Retrofit @Streaming по умолчанию) | BackendApi.kt |
| 11 | `agent-service.js` и `txt-importer.js` — дублирование `bootstrapNextWindow` | backend/src/ |

## 8. Итого

### Удалено
- **13** polling-функций из плеера
- **3** фазы из PlayerPhase
- **6** констант таймаутов
- **2** мёртвые переменные (`workersRunning`, `isCached`)
- **1** legacy функция проверки placeholder (`sceneHasValidContent`)
- **~450 строк** кода удалено (по git diff stat)

### Требует дальнейшего рефакторинга
- **GenerateViewModel.kt** — разделить на несколько классов (ScenePlayer, BookImporter, BookGenerator)
- **backend.cjs** — разделить на route-модули
- **PlayFragment.kt** — вынести MediaPlayer в отдельный класс
- **IU cycling с silent audio** — добавить timer-based cycling
