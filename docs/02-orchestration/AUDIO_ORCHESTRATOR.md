# Audio Orchestrator

> Единая state machine для управления жизненным циклом аудио сцены.
> Устраняет race condition между `setImmediate`, `triggerAudioMerge` и `generateSceneAudio`.

## Проблема

Сейчас аудио-пайплайн управляется тремя независимыми источниками истины,
которые не синхронизированы:

| Слой | Кто пишет | Кто читает |
|------|-----------|------------|
| **PostgreSQL** (`scene_assets.status`) | `ensurePlaceholderAudio()`, `replacePlaceholderWithRealAudio()` | `generateSceneAudio()` |
| **Redis** (`animastor:chunk:*`) | `generateSceneAudio()`, `handleTaskResult()` | `triggerAudioMerge()` |
| **Filesystem** (`.mp3` файлы) | TTS callback, merge pipeline | `triggerAudioMerge()`, `isSceneAudioReady()` |

Каждый компонент принимает решение на основе **только своего слоя**:

- `triggerAudioMerge` видит `fs.existsSync(merged.mp3) → true` → думает «merge готов» — но **не знает,
  что это placeholder**
- `generateSceneAudio` удаляет placeholder из FS — но **не сообщает об этом `triggerAudioMerge`**
- `startScene` запускает `setImmediate(ensurePlaceholderAudio)` — но **не проверяет, не началась ли уже
  генерация**

### Реальные баги из-за этого

1. **Placeholder re-created после удаления:** `generateSceneAudio` удаляет placeholder → `setImmediate`
   callback создаёт новый → `triggerAudioMerge` видит файл → exit early. Итог: 2-секундная тишина
   вместо аудио.
2. **`completeStage` при неудачном merge:** merge вернул null (lock held, chunks not ready), но
   `completeStage` вызывается в любом случае → сцена помечена как «аудио готово».
3. **Невозможно отличить placeholder от real audio на FS:** оба — `.mp3` файлы. Только PG знает
   разницу, но `triggerAudioMerge` в PG не ходит.

## Решение: Audio Orchestrator

Вводится **Redis-ключ `animastor:audio-orch`** — единственный арбитр состояния аудио-генерации сцены.

### Ключ

```
animastor:audio-orch:{bookId}:{chapterId}:{sceneId}
```

Значение — JSON:

```json
{
  "phase": "placeholder_ready",
  "expected_count": 9,
  "chunks_received": 0,
  "started_at": 1743921000,
  "build_id": "build_abc123"
}
```

### Phase machine

```
  ┌──────────────────────────────────────────────────┐
  │                                                  │
  ▼                                                  │
NEW ──→ PLACEHOLDER_READY ──→ GENERATING             │
                                │                    │
                                ▼                    │
                          WAITING_CHUNKS             │
                                │                    │
                          ┌─────┴─────┐              │
                          ▼           ▼              │
                     MERGING     FAILED ─────────────┘
                          │
                          ▼
                        DONE
                          │
                          ▼
                     (terminal)
```

| Phase | Описание |
|-------|----------|
| `NEW` | Сцена создана, аудио нет |
| `PLACEHOLDER_READY` | Placeholder создан (FS + PG), сцена готова к диспатчу |
| `GENERATING` | TTS отправлен, чанки в процессе |
| `WAITING_CHUNKS` | Чанки прибывают, `triggerAudioMerge` ждёт все |
| `MERGING` | Все чанки есть, merge в процессе |
| `DONE` | Merge завершён, PG status = `ready` |
| `FAILED` | Все retry исчерпаны, сцена нуждается в передиспатче |

### Владелец каждого перехода

| Transition | Кто меняет | Когда |
|------------|-----------|-------|
| `NEW → PLACEHOLDER_READY` | `startScene()` | После создания placeholder + chunk metadata |
| `PLACEHOLDER_READY → GENERATING` | `dispatchStage('audio')` | Перед отправкой TTS |
| `GENERATING → WAITING_CHUNKS` | `dispatchStage('audio')` | После отправки TTS |
| `WAITING_CHUNKS → MERGING` | `triggerAudioMerge` | Когда `chunks_received === expected_count` |
| `MERGING → DONE` | `triggerAudioMerge` | После успешного merge |
| `WAITING_CHUNKS → FAILED` | `triggerAudioMerge` | После MAX_RETRIES |
| `FAILED → GENERATING` | `dispatchStage('audio')` | На следующем scheduler tick |

### Изменения в компонентах

#### `startScene()` (scene-window.js)

**Было:**
```js
setImmediate(async () => {
    await ensurePlaceholderAudio(buildId, bookId, chapterId, sceneId);
});
```

**Стало:**
```js
// Placeholder создаётся синхронно (await), ДО того как сцена попадает в scheduler.
// Задержка ~2s (ffmpeg silence generation) — не критична.
const ph = await ensurePlaceholderAudio(buildId, bookId, chapterId, sceneId);
if (ph.created || ph.reason === 'already_exists') {
    await redis.set(`animastor:audio-orch:${bookId}:${chapterId}:${sceneId}`,
        JSON.stringify({ phase: 'PLACEHOLDER_READY', expected_count: segments.length,
                         chunks_received: 0, build_id: buildId }));
}
```

#### `generateSceneAudio()` / `dispatchStage('audio')` (generation.js / dispatch-engine.js)

**Стало:**
```js
// В начале:
await redis.set(orchKey, JSON.stringify({ ...state, phase: 'GENERATING' }));

// Удалить placeholder:
const mergedPath = helpers.getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}.mp3`);
if (fs.existsSync(mergedPath)) fs.unlinkSync(mergedPath);

// Отправить TTS, затем:
await redis.set(orchKey, JSON.stringify({ ...state, phase: 'WAITING_CHUNKS' }));
```

#### `triggerAudioMerge()` (task-handler.cjs)

**Было:**
```js
if (fs.existsSync(mergedAudioPath)) {
    log(`Merged audio already exists — skipping retry`);
    return;
}
```

**Стало:**
```js
const raw = await redis.get(`animastor:audio-orch:${book_id}:${chapter_id}:${scene_id}`);
const orch = raw ? JSON.parse(raw) : null;
if (!orch || orch.phase === 'DONE') {
    log(`Audio already done for ${book_id}/${chapter_id}/${scene_id}`);
    return;  // merge уже выполнен, выходим
}
if (orch.phase === 'MERGING') {
    log(`Merge in progress — waiting`);
    return;  // кто-то уже мержит, не мешаем
}
// Для WAITING_CHUNKS: обновить chunks_received, проверить все ли есть.
// Для FAILED: запустить re-dispatch.
```

`triggerAudioMerge` **никогда не смотрит на FS** для принятия решения.
FS используется только для фактического merge (список чанков → concat → ffmpeg).

#### `completeStage` (orchestrator)

**Стало — вызывается ТОЛЬКО после перехода `MERGING → DONE`:**
```js
if (orch.phase === 'DONE') {
    await orchestrator.completeStage(redis, book_id, chapter_id, scene_id, 'audio', build_id);
}
```

### Что делать с `isSceneAudioReady()`?

`isSceneAudioReady()` (validation.js) проверяет FS + размер файла. После внедрения
audio-orch его можно **ограничить локальным кешированием** (только для ответа на
запросы фронтенда, не для принятия решений). Для orchestration-решений — только
Redis key.

### Retry-логика

Текущая retry-логика (MAX_RETRIES=5, re-dispatch) **сохраняется**, но с уточнением:

- После каждого retry проверяется **phase**, а не `fs.existsSync(merged)`.
- Если phase = `WAITING_CHUNKS` и не все чанки → retry.
- Если phase = `FAILED` → re-dispatch.
- Если phase = `DONE` → exit (всё готово).
- Если phase = `MERGING` → подождать (lock).

### Восстановление после перезапуска

При старте backend:
1. Scan Redis keys `animastor:audio-orch:*`
2. Для phase = `GENERATING | WAITING_CHUNKS`: проверить чанки на диске
   — если все есть → перевести в `MERGING` и запустить merge
   — если нет → перевести в `FAILED` (scheduler подхватит)
3. Для phase = `MERGING`: проверить merged-файл
   — если есть → перевести в `DONE`
   — если нет → перевести в `FAILED`
4. Для phase = `PLACEHOLDER_READY`: проверить placeholder
   — если нет → пересоздать
   — если есть → оставить (scheduler подхватит)

Это заменяет текущий `recoverMissingRedisChunks` + `recoverMissingPlaceholders`
для audio-слоя (другие слои image/video не затронуты).

### Миграция — статус выполнения

| Шаг | Описание | Статус | Файлы |
|-----|----------|--------|-------|
| 1 | Создать audio-orchestrator.js | ✅ | `backend/src/services/audio-orchestrator.js` |
| 2 | Убрать `setImmediate` из `startScene()` — синхронный placeholder + PLACEHOLDER_READY | ✅ | `backend/src/runtime/scene-window.js` |
| 3 | Убрать `fs.existsSync(mergedAudioPath)` из `triggerAudioMerge` — решение по phase | ✅ | `backend/src/services/task-handler.cjs` |
| 4 | `completeStage` только после MERGING → DONE | ✅ | `backend/src/services/task-handler.cjs` |
| 5 | Startup recovery — scan audio-orch keys | ✅ | `backend/src/services/startup-recovery.js` |

Также изменены:
- `backend/src/orchestration/scene-orchestrator.js` — `executeAudioDispatch()` устанавливает GENERATING/WAITING_CHUNKS

Все шаги имплементированы в одном коммите, так как они тесно связаны и требуют друг друга для корректной работы.

### Сравнение: было vs стало

| Аспект | Было | Стало |
|--------|------|-------|
| **Source of truth** | FS (file exists?) | Redis (phase) |
| **Placeholder detection** | `asset.status === 'placeholder'` (PG) | `phase === 'PLACEHOLDER_READY'` (Redis) |
| **Race condition** | setImmediate создаёт placeholder после удаления | Невозможно — phase меняется атомарно |
| **completeStage** | Всегда | Только при `phase === 'DONE'` |
| **Retry trigger** | fs.existsSync(merged) 🚫 | orch.phase (WAITING_CHUNKS / FAILED) ✅ |
| **Startup recovery** | FS scan → guess | Redis scan → exact state |
| **PG query per chunk** | Да (наш workaround) | Нет (вся информация в Redis) |
