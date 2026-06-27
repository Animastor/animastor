# GPU Progress — Frontend Handoff (F1–F7)

> **Статус на 2026-06-27.** Backend-часть (B1–B5) уже сделана и закоммичена
> (`feat(progress): deterministic GPU progress + SSE push channel (backend)`,
> ветка `feat/orchestrator-facade`, 400 тестов зелёные). Этот документ —
> пошаговая инструкция для следующей модели/сессии, чтобы доделать фронтенд.
> Контекст создателя мог закончиться по токенам — здесь всё, что нужно знать.

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

## F7. Поля ошибок в модели ответа

Файл `repository/LayerConfig.kt`, в `data class AssetsStateResponse` добавить
перед `cover_needs_generation`:

```kotlin
    val audio_error: Int = 0,
    val image_error: Int = 0,
    val video_error: Int = 0,
```

Gson сам смапит по имени; дефолт 0 — безопасен для старого бэка.

## F3. Монотонность прогресса (никаких откатов)

Проблема: `ready` из бэка теперь монотонный, но при смене источника
(SSE-инкремент vs поллинг-сверка) и при пересборке списка воркеров значение
может на кадр уменьшиться. Гарантия на фронте:

- Завести `MutableMap<String, Int>` (`workerReadyFloor`) — пол по типу воркера.
- В `showGpuProgress`/будущем VM перед использованием `ready` делать:
  `val r = max(ready, workerReadyFloor[type] ?: 0); workerReadyFloor[type] = r`.
- **Сбрасывать `workerReadyFloor.clear()`** в том же месте, где сейчас
  сбрасывается `workerCompletedAt` при детекте новой генерации
  (`MainActivity.kt:555-563`).

## F4. Stuck-детект (ложный авто-complete)

Файл `MainActivity.kt:579-604`. Сейчас `progressTotal` считается по ОДНОМУ слою
и НЕ учитывает `scope_iu_ready` → image-прогресс «не виден» детектору.

Заменить расчёт `progressTotal` на СУММУ всех релевантных по профилю слоёв,
включая IU:

```kotlin
val progressTotal =
    assets.scope_audio_ready_real +
    (if (assets.scope_iu_total > 0) assets.scope_iu_ready else assets.scope_image_ready) +
    assets.scope_video_ready +
    assets.cover_iu_ready
```

- Вынести `120_000` в именованную константу (напр. `STUCK_TIMEOUT_MS`).
- `getWorkerCounts()` при ошибке сейчас даёт `backendActive=true` навсегда → не
  завершится. Разделить: ошибка сети ≠ «бэк активен». См. F6 — не двигать окно
  stuck при сетевых ошибках вообще.

## F5. Завершение слоя по флагам, не по эвристике (ложный Done)

Файл `MainActivity.kt`, функция `add()` (685-702) и `_workerPermanentlyDone`.

Сейчас `done = ready >= total && ready > 0` — эвристика, ловит гонки. Заменить
на явные флаги из ответа, передаваемые в `add()`:

- audio → `assets.scope_all_audio_ready`
- image → `assets.scope_all_image_ready` (для IU-режима опираться на
  `scope_iu_ready >= scope_iu_total`, т.к. all_image_ready считается по чанкам)
- video → `assets.scope_all_video_ready`
- cover → `cover_iu_ready >= cover_iu_total && cover_iu_total > 0`

Воркер уходит в `_workerPermanentlyDone` ТОЛЬКО когда соответствующий флаг
`true` (а не когда `ready>=total` мигнул). Единицы `total` НЕ сравнивать между
слоями: image меряется в IU (`scope_iu_total`), audio/video — в чанках
(`scope_total`).

## F6. Устойчивость поллера

Файл `MainActivity.kt:567-620`.

- В `catch (e: Exception)` НЕ трогать `lastReadyChangeAt`/`lastReadyCount` (уже
  так), но также: не позволять stuck-детекту срабатывать, если последний
  `getAssetsState` упал. Завести флаг `lastPollFailed` и пропускать stuck-ветку,
  если он `true`.
- Backoff: при серии ошибок увеличивать `delay` (1.5с → 3с → 6с, cap 6с),
  сбрасывать на успехе.
- `showGpuProgress` каждые 1.5с делает `findViewById`/`inflate` в цикле —
  закэшировать ссылки на вью строк (массив holder'ов), переиспользовать.
- Весь IO уже в suspend на корутине; убедиться, что обновления UI идут на main
  (lifecycleScope по умолчанию main — ок).

## F1. SSE-клиент

1. `build.gradle.kts` deps:
   ```kotlin
   implementation("com.squareup.okhttp3:okhttp-sse:4.12.0")
   ```
2. Новый `network/ProgressStream.kt`:
   - Использовать `RetrofitClient.httpClient` и `RetrofitClient.baseUrl`.
   - `EventSources.createFactory(client).newEventSource(request, listener)`.
   - URL: `${baseUrl.trimEnd('/')}/api/v1/book/$bookId/progress-stream`.
   - В `EventSourceListener.onEvent` парсить JSON (Gson) в data class
     `ProgressEvent(type, layer, chapterId, sceneId, ready)` и эмитить в
     `MutableSharedFlow<ProgressEvent>(extraBufferCapacity=64)`.
   - Реконнект: в `onFailure` — backoff и пересоздание EventSource, пока активна
     генерация. Закрытие: `eventSource.cancel()` при остановке.
3. Подписку открывать при старте генерации (где ставится `activeGeneration`),
   закрывать в `onGenerationComplete`/при уходе с экрана.

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
- [ ] #1 SSE: бэк готов, фронт-клиент (F1) — TODO
- [ ] #8 ошибки: бэк-поля готовы, фронт-отображение (F7) — TODO
- [ ] #3 stuck-детект (F4)
- [ ] #4 единицы total (F5)
- [ ] #5 ложный Done (F5)
- [ ] #6 устойчивость поллера (F6)
