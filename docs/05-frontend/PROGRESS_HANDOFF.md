# GPU Progress — Frontend Handoff (F1–F7)

> **Статус на 2026-06-27.** Backend-часть (B1–B5) и frontend-часть (F1–F7)
> полностью сделаны и закоммичены (ветка `feat/orchestrator-facade`, сборка
> `assembleDebug` успешна). Документ — архивная инструкция.
> **Все задачи GPU Progress закрыты.**
>
> **Источник:** `docs-claude/PROGRESS_FRONTEND_HANDOFF.md`

## Зачем это

Пользователь жаловался на сбои/неточности прогресса GPU-генерации в Android-UI:
прогресс дёргается, откатывается назад, показывает ложный «Done», иногда
зависает и авто-завершается, хотя ассеты не готовы.

## Что УЖЕ сделано на backend (контракт для фронта)

1. **`/assets-state` теперь детерминированный и монотонный.** `ready`-значения
   не уменьшаются в пределах одной генерации. Файловый скан диска убран.
   Источник истины — Redis-счётчик `animastor:iu-progress:...`.
2. **Новые поля в `AssetsStateResponse`** (бэк уже их отдаёт):
   `audio_error`, `image_error`, `video_error` (Int, счёт чанков со статусом
   `error`/`failed`).
3. **Новый SSE-эндпоинт:** `GET /api/v1/book/{bookId}/progress-stream`.
   - `Content-Type: text/event-stream`
   - Событие `event: open` при подключении
   - Прогресс-события `data: {"type":"progress",...}`
   - Heartbeat-комментарии `: ping\n\n` каждые 15с

## Карта фронтенда (что где лежит)

- `frontend/app/build.gradle.kts` — зависимости. OkHttp **4.12.0** уже есть.
- `frontend/.../RetrofitClient.kt` — `object RetrofitClient`
- `frontend/.../BackendApi.kt` — Retrofit-интерфейс
- `frontend/.../LayerConfig.kt` — `data class AssetsStateResponse`
- `frontend/.../Repository.kt` — обёртки
- `frontend/.../MainActivity.kt` — поллер, состояние прогресса
- `frontend/.../GenerateViewModel.kt` — ActiveGeneration, StateFlow
- `frontend/.../item_worker_progress.xml` — строка воркера
- `frontend/.../strings.xml` — строки `progress_*`

## Реализованные шаги

### ✅ F7. Поля ошибок в модели ответа
Добавлены `audio_error: Int = 0`, `image_error: Int = 0`, `video_error: Int = 0`
в `AssetsStateResponse`.

### ✅ F3. Монотонность прогресса (никаких откатов)
Добавлен `workerReadyFloor: MutableMap<String, Int>` в `MainActivity.kt`.

### ✅ F4. Stuck-детект (ложный авто-complete)
`STUCK_TIMEOUT_MS = 120_000L`. Проверка `!lastPollFailed` перед stuck-веткой.

### ✅ F5. Завершение слоя по флагам, не по эвристике
Параметр `doneFlag` в `add()`.

### ✅ F6. Устойчивость поллера
Backoff: 1.5с → 3с → 6с (cap), сброс на успехе.

### ✅ F1. SSE-клиент
Создан `network/ProgressStream.kt`.

### ✅ F2. Вынос логики в ViewModel
Опциональный рефакторинг.

## Финальная проверка

- `./gradlew assembleDebug` — компиляция.
- Ручной прогон `full`-профиля: прогресс растёт плавно, без откатов.
- Обрыв сети во время генерации: UI не авто-завершает по stuck.
