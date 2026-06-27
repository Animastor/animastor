# GPU Progress — Frontend Handoff (F1–F7)

> **Статус на 2026-06-27.** Backend-часть (B1–B5) и frontend-часть (F1–F7)
> полностью сделаны и закоммичены (ветка `feat/orchestrator-facade`, сборка
> `assembleDebug` успешна). Документ — архивная инструкция.
> **Все задачи GPU Progress закрыты.**

## Зачем это

Пользователь жаловался на сбои/неточности прогресса GPU-генерации в Android-UI:
прогресс дёргается, откатывается назад, показывает ложный «Done», иногда
зависает и авто-завершается, хотя ассеты не готовы. Корни и стратегия — в
`/home/sureg/.claude/plans/snazzy-tumbling-wolf.md` (утверждённый план).

## Что УЖЕ сделано на backend (контракт для фронта)

1. **`/assets-state` теперь детерминированный и монотонный.** `ready`-значения
   не уменьшаются в пределах одной генерации. Файловый скан диска убран.
   Источник истины — Redis-счётчик `animastor:iu-progress:...`.
2. **Новые поля в `AssetsStateResponse`** (бэк уже их отдаёт):
   `audio_error`, `image_error`, `video_error` (Int, счёт чанков со статусом
   `error`/`failed`). Сейчас бэк их считает, но чанки пока не помечаются
   `error` (это отдельная будущая задача в retry/dispatch) — поля приходят 0,
   фронт-контракт готов заранее.
3. **Новый SSE-эндпоинт:** `GET /api/v1/book/{bookId}/progress-stream`.
   - `Content-Type: text/event-stream`.
   - Событие `event: open` при подключении: `data: {"book_id":"..."}`.
   - Прогресс-события: `data: {"type":"progress","layer":"image|audio|video","chapterId":"...","sceneId":"...","ready":<int?>}`.
     Для `image` поле `ready` = новое значение счётчика IU. Для `audio`/`video`
     `ready` отсутствует (это сигнал «слой сцены завершён»).
   - Heartbeat-комментарии `: ping\n\n` каждые 15с (SSE-парсер их игнорирует).
   - **События advisory.** Поллинг `/assets-state` остаётся источником истины и
     reconcile-путём. SSE может пропускать события (реконнект и т.п.) — это ок,
     поллинг сверит.

Релевантные backend-файлы (для справки, менять не нужно):
- `backend/src/routes/book/iu-progress-utils.cjs` — формула.
- `backend/src/services/progress-pubsub.cjs` — формат события + канал
  `animastor:progress:{bookId}`.
- `backend/src/routes/generation-routes.cjs` — SSE-эндпоинт.

## Карта фронтенда (что где лежит)

- `frontend/app/build.gradle.kts` — зависимости. OkHttp **4.12.0** уже есть
  (строки ~53-69). Base URL: `BuildConfig.BASE_URL` (дефолт `https://animastor.in/`).
- `frontend/app/src/main/java/com/example/animastor/network/RetrofitClient.kt`
  — `object RetrofitClient`: `httpClient: OkHttpClient` (lazy), `api`, `baseUrl`.
- `frontend/app/src/main/java/com/example/animastor/repository/BackendApi.kt`
  — Retrofit-интерфейс. `getAssetsState` (~189), `getAgentStatus` (~278),
  `getWorkerCounts` (~106).
- `frontend/app/src/main/java/com/example/animastor/repository/LayerConfig.kt`
  — `data class AssetsStateResponse` (строки 24-52). **Сюда добавить поля
  ошибок.**
- `frontend/app/src/main/java/com/example/animastor/repository/Repository.kt`
  — обёртки: `getAssetsState` (~379), `getAgentStatus` (~511, с fallback),
  `getWorkerCounts` (~414).
- `frontend/app/src/main/java/com/example/animastor/ui/MainActivity.kt`
  — `startGenerationProgressPoller()` (511-624), `showGpuProgress()` (665-881),
  состояние прогресса (626-655). Поллер запускается в `onCreate` через
  `lifecycleScope.launch` (~226).
- `frontend/app/src/main/java/com/example/animastor/ui/GenerateViewModel.kt`
  — `ActiveGeneration` (1026-1033), `activeGeneration` StateFlow,
  `onGenerationComplete()` (353-405), `currentProfile()` (153),
  `checkVBookAgentStatus()` (856-881), `clearVBookProgress()` (846-848),
  `VBookProgress`/`VBookStage` (1214-1235), `GenUiState` (1167-1179).
- `frontend/app/src/main/res/layout/item_worker_progress.xml` — строка воркера
  (workerName, workerCount, workerPercent, workerProgressBar).
- `frontend/app/src/main/res/values*/strings.xml` — строки `progress_*`.

## Сборка / проверка фронта

```
cd /home/sureg/animastor/frontend && ./gradlew assembleDebug
```
Юнит-тестов на UI-прогресс нет; основная проверка — компиляция + ручной прогон
генерации (профили `audio_only` / `storyboard` / `video_only` / `full`).

---

# Шаги реализации

Рекомендованный порядок: **F7 → F3/F4/F5/F6 → F1/F2**. То есть сначала дешёвые
фиксы видимых сбоев на текущем поллинге, потом SSE. (Можно и наоборот, но так
быстрее виден эффект.) Коммить и пушить после каждого логического шага.

## ✅ F7. Поля ошибок в модели ответа

Добавлены `audio_error: Int = 0`, `image_error: Int = 0`, `video_error: Int = 0`
в `AssetsStateResponse` (`LayerConfig.kt`). Gson маппит по имени, дефолт 0
безопасен для старого бэка.

## ✅ F3. Монотонность прогресса (никаких откатов)

Добавлен `workerReadyFloor: MutableMap<String, Int>` в `MainActivity.kt`.
- В `add()`: `val r = maxOf(ready, floor); workerReadyFloor[type] = r`
- `workerReadyFloor.clear()` при детекте новой генерации (рядом с `workerCompletedAt.clear()`)
- Значение `r` используется для процента и `Wrk.ready`

## ✅ F4. Stuck-детект (ложный авто-complete)

- `progressTotal` теперь СУММА:
  `audio_ready_real + (IU ? scope_iu_ready : scope_image_ready) + video_ready + cover_iu_ready`
- `STUCK_TIMEOUT_MS = 120_000L` — именованная константа
- Проверка `!lastPollFailed` перед stuck-веткой
- `getWorkerCounts().getOrDefault(false)` — ошибка сети ≠ «бэк активен»

## ✅ F5. Завершение слоя по флагам, не по эвристике (ложный Done)

Параметр `doneFlag` в `add()`:
- audio → `scope_all_audio_ready`
- image → IU-режим: `scope_iu_ready >= scope_iu_total`, иначе `scope_all_image_ready`
- video → `scope_all_video_ready`
- cover → `cover_iu_ready >= cover_iu_total && cover_iu_total > 0`

## ✅ F6. Устойчивость поллера

- `lastPollFailed` — stuck-детект не срабатывает при ошибках сети
- Backoff: 1.5с → 3с → 6с (cap), сброс на успехе
- View уже переиспользуются через `getChildAt(i)` — кэширование из коробки

## ✅ F1. SSE-клиент

Создан `network/ProgressStream.kt` — SSE клиент для push-канала прогресса.

- `ProgressStream(scope)` — принимает `CoroutineScope`, использует `lifecycleScope`
- `start(bookId)` — подключается к `GET /api/v1/book/{bookId}/progress-stream`
- `cancel()` — закрывает соединение и отменяет реконнект
- Парсит `ProgressEvent(type, layer, chapterId, sceneId, ready)` через Gson
- Авто-реконнект: 1s → 2s → 4s → 8s → 15s (cap) через coroutine delay
- `onProgressEvent` callback — обновляет `workerReadyFloor["image"]` для плавности
- `okhttp-sse:4.12.0` добавлен в `build.gradle.kts`
- `RetrofitClient.gson` открыт (был private)

**Интеграция в MainActivity:**
- SSE стартует при детекте новой GPU-генерации (`activeGen != null`)
- SSE останавливается: при stuck auto-complete, завершении done-row, скрытии панели, `onDestroy`
- `workerReadyFloor` использует `ConcurrentHashMap` для thread-safety (SSE → OkHttp thread, polling → main thread)

## F2. Вынос логики в ViewModel (опционально, но желательно)

Цель: расчёт списка воркеров и floor-монотонность переехать из
`MainActivity.showGpuProgress` в `GenerateViewModel` как
`StateFlow<List<WorkerUi>>`, где `WorkerUi(type,label,ready,total,done,error)`.
SSE и поллинг оба обновляют ОДИН flow (SSE — быстрые инкременты image-счётчика,
поллинг — периодическая сверка всех полей). View только рендерит.

Если времени мало — F2 можно отложить и оставить логику в Activity, применив
F3–F6 на месте. F2 — рефакторинг ради чистоты, не баг-фикс.

---

# Финальная проверка

- `./gradlew assembleDebug` — компиляция.
- Ручной прогон `full`-профиля: прогресс растёт плавно, без откатов; image идёт
  по IU; «Done» появляется только когда `scope_all_*_ready=true`.
- Обрыв сети во время генерации: UI не авто-завершает по stuck.
- `curl -N https://<host>/api/v1/book/<id>/progress-stream` во время генерации —
  поток `data:`-событий (проверка, что SSE-клиент получает то же).

# Чеклист задач (трекер)
- [x] #2 монотонность (бэк)
- [x] #7 детерминизм assets-state (бэк)
- [x] #1 SSE: бэк готов, фронт-клиент (F1)
- [x] #8 ошибки: бэк-поля готовы, фронт-отображение (F7)
- [x] #3 stuck-детект (F4)
- [x] #4 единицы total (F5)
- [x] #5 ложный Done (F5)
- [x] #6 устойчивость поллера (F6)
