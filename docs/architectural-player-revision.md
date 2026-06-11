# Архитектурная ревизия плеера

## Что сделано

### Контекст
Плеер исторически проектировался для режима потоковой генерации (генерация и воспроизведение одновременно). Сейчас система работает по другой модели: генерация создаёт файлы проекта, плеер воспроизводит то, что уже есть. Ревизия удалила все зависимости плеера от генерации.

### 1. Упрощение PlayerPhase
**Файл:** `GenerateViewModel.kt`

Удалены фазы, относящиеся к генерации:
- ~~`LOADING_BOOK`~~ — книга грузится синхронно, фаза не нужна
- ~~`GENERATING`~~ — плеер не следит за генерацией
- ~~`DOWNLOADING`~~ — медиа загружаются по факту, без ожидания

Оставлены:
- `IDLE` — нет книги
- `SCENE_READY` — книга загружена, сцены есть
- `PLAYING` — активное воспроизведение
- `PAUSED` — на паузе
- `IMPORTING_TXT` — импорт TXT (единственная асинхронная операция)

### 2. Удалены polling-функции (все ожидания генерации)
**Файл:** `GenerateViewModel.kt`

Удалены функции, которые опрашивали backend о готовности генерации:
- ~~`pollWithBackoff()`~~ — ядро polling'a с экспоненциальной задержкой
- ~~`waitChunkReady()`~~ — ожидание готовности чанка
- ~~`waitWindowReady()`~~ — ожидание готовности окна сцен
- ~~`waitForWorkers()`~~ — ожидание появления GPU-воркеров
- ~~`resumeAfterWorkers()`~~ — перезапуск после появления воркеров
- ~~`waitStoryboardReady()`~~ — ожидание storyboard
- ~~`waitFirstAudio()`~~ — ожидание первого аудио
- ~~`waitPreview()`~~ — ожидание preview-изображения
- ~~`waitForNextWindow()`~~ — ожидание следующего окна генерации
- ~~`startCoverRefresh()`~~ — polling обложки
- ~~`waitGeneratedCover()`~~ — ожидание генерации обложки
- ~~`startVideoCheck()`~~ — polling готовности видео

Добавлена простая замена:
- `tryGetChunk()` — однократный запрос статуса чанка без ожидания

### 3. Упрощена загрузка медиа
**Файл:** `GenerateViewModel.kt`, `PlayFragment.kt`

- `fetchSceneData()` — больше не ждёт готовности чанка. Пытается загрузить аудио; если недоступно → `ByteArray(0)` (тишина). Видео и изображения — опционально.
- `playNext()` — при пустой очереди сразу переходит в `SCENE_READY`, без ожидания следующего окна.
- Активность генерации (`_activeGeneration`) сохранена для панели прогресса в toolbar, но не влияет на плеер.

### 4. Обработка пустого аудио (silent placeholder)
**Файл:** `PlayFragment.kt`

- `createPlayer()` теперь возвращает `MediaPlayer?` (nullable). Для пустого файла возвращает `null` без создания MediaPlayer.
- `preloadNext()` — при пустом аудио не создаёт MediaPlayer.
- В нормальной работе backend всегда создаёт placeholder MP3, поэтому `ByteArray(0)` — safety net для edge cases.

### 5. Обновлены зависимости
- **`MainActivity.kt`** — удалены проверки фаз GENERATING/LOADING_BOOK/DOWNLOADING в панели воркеров
- **`PlayFragment.kt`** — удалены все reference к удалённым фазам, упрощён `when` в `observeState()`
- **`FileFragment.kt`** — удалены проверки фаз генерации, упрощён показ прогресса

### 6. Бэкенд: создание chunks + placeholder audio при window generation
**Файл:** `backend/src/backend.cjs`

Добавлено создание Redis chunks и placeholder audio в двух местах:
- `runBackgroundWindowGeneration()` (фоновый путь через `trigger-next-window`)
- `/bootstrap-next-window` endpoint (чат-путь)

### 7. Удаление legacy проверок

**Файл:** `backend/src/runtime/scene-window.js`
- `sceneHasValidContent()` — больше не считает placeholder аудио "невалидным"

## Что НЕ сделано (из-за окончания сессии)

1. **build не проходит** — осталась ошибка `Unresolved reference: getCurrentChunkId` в PlayFragment.kt. Функция существует в VM, но компилятор Kotlin может не находить её из-за других ошибок.
2. **Dead code в generateFromFile** — переменные `workersRunning` и `isCached` вычисляются, но не используются.
3. **Silent audio → IU cycling** — при отсутствии MediaPlayer IU cycling зависает. Требуется таймерная синхронизация.

## Файлы изменённые в сессии

| Файл | Изменение |
|---|---|
| `backend/src/backend.cjs` | Добавлены chunks + placeholder audio при bootstrapNextWindow |
| `backend/src/book/lazy-book.js` | Structural scenes только для первого окна |
| `backend/src/services/agent-service.js` | Логирование контекста окон |
| `frontend/.../GenerateViewModel.kt` | Упрощение PlayerPhase, удаление polling |
| `frontend/.../PlayFragment.kt` | Nullable MediaPlayer, убраны фазы генерации |
| `frontend/.../MainActivity.kt` | Убраны проверки фаз генерации |
| `frontend/.../FileFragment.kt` | Убраны проверки фаз генерации |
| `frontend/.../BookModels.kt` | agent_progress_msg |
| `frontend/.../Repository.kt` | resumeBootstrap |
| `frontend/.../BackendApi.kt` | resumeBootstrap endpoint |
| `frontend/.../ChunkResponse.kt` | — |
