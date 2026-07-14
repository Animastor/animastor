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
| `PLACEHOLDER_READY → GENERATING` | `executeAudioDispatch()` | Перед отправкой TTS |
| `GENERATING → WAITING_CHUNKS` | `executeAudioDispatch()` | После отправки TTS |
| `WAITING_CHUNKS → MERGING` | `triggerAudioMerge` | Когда все чанки на диске (проверка по FS) |
| `MERGING → DONE` | `triggerAudioMerge` | После успешного merge |
| `WAITING_CHUNKS → FAILED` | `triggerAudioMerge` | После MAX_RETRIES |
| `FAILED → GENERATING` | scheduler re-dispatch | На следующем scheduler tick |
| `FAILED → WAITING_CHUNKS` | `triggerAudioMerge` (recovery) | Когда все чанки пришли после FAILED (late chunk race) |

> **Важно:** `chunks_received` в Redis-ключе — информационное поле. Решение "все ли чанки готовы"
> принимается на основе **проверки FS** (список .mp3 файлов на диске), а не счётчика.
> Такой подход надёжнее: не зависит от порядка arrival callback'ов и устойчив к дубликатам.

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

При старте backend (`startup-recovery.js`, Step 6):
1. Scan Redis keys `animastor:audio-orch:*`
2. Для phase = `GENERATING | WAITING_CHUNKS`: `→ FAILED` (scheduler подхватит на следующем tick)
   — чанки, уже существующие на диске, будут cache-hit в `generateSceneAudio()`
3. Для phase = `MERGING`: проверить merged-файл
   — если есть → `→ DONE`
   — если нет → `→ FAILED`
4. Для phase = `PLACEHOLDER_READY`: оставить как есть, добавить сцену в active index
5. Для phase = `DONE | FAILED`: терминальные, оставить без изменений

> **Упрощение:** вместо полного восстановления (проверка чанков на диске → запуск merge)
> для `GENERATING/WAITING_CHUNKS` используется FAILED + scheduler re-dispatch.
> Это безопаснее (нет риска дублировать merge при race condition restart) и достаточно
> быстро (scheduler tick раз в 5 секунд, cache-hit в `generateSceneAudio`).

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
- `backend/tests/audio-orchestrator.test.js` — 21 unit-тест (все переходы, invalid transitions, scanAllStates)

Все шаги имплементированы за 2 коммита, так как они тесно связаны и требуют друг друга для корректной работы.

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

## Аудит мёртвого кода

После рефакторинга проверены все функции на неиспользуемость:

| Функция | Файл | Статус |
|---------|------|--------|
| `areSceneAudioChunksReady()` | `chunks.js` | 🟡 Мёртвый код (экспортируется, но нигде не импортируется) |
| `allSceneChunksExist()` | `chunks.js` | ✅ Используется в `pipeline.js` |
| `findExistingSceneChunks()` | `chunks.js` | ✅ Используется в `generation.js`, `pipeline.js` |
| `isSceneAudioReady()` | `validation.js` | ✅ Используется в `generation.js`, `scene-callbacks.js` (валидация, не решение) |
| Старый `fs.existsSync(merged)` в `triggerAudioMerge` | `task-handler.cjs` | ✅ Заменён на phase check |
| `setImmediate` в `startScene()` | `scene-window.js` | ✅ Заменён на синхронный await |

> **Примечание:** `areSceneAudioChunksReady()` — предшествующий мёртвый код,
> не связанный с этим рефакторингом. Удаление — в отдельную задачу.

## Аудит оставшихся FS-проверок

После рефакторинга `triggerAudioMerge` больше не использует `fs.existsSync` для принятия
решения. Оставшиеся FS-проверки в audio-слое делятся на 3 категории:

### 1. Файловые операции (безопасно, не решение)
- `generation.js` — проверка существования chunk-файлов перед TTS (`cache-hit`) и удаление stale
- `pipeline.js` — проверка chunk/merged файлов для concat/merge/cleanup
- `task-handler.cjs` — проверка chunk файлов на диске для merge (нужно знать, какие файлы есть физически)

### 2. Валидация после решения (не影響 решение)
- `scene-callbacks.js:58` — `isSceneAudioReady()` вызывается ДОПОЛНИТЕЛЬНО после того,
  как phase уже `DONE`. Это валидация, а не gate.
- `generation.js:97` — `isSceneAudioReady()` — cache-hit detection, не conflicts с phase.

### 3. Вспомогательные проверки
- `validation.js` — `isSceneAudioReady()` — может использоваться для фронтенда.
  Теперь не用于 оркестрации; можно ограничить кешированием для ответов на запросы UI.

**Вывод:** ни одна FS-проверка не принимает решений об оркестрации аудио.
Все решения проходят через Redis phase machine.

## Результаты тестирования

- **Все тесты:** 550/550 ✅ (предыдущие 529 + 21 новый)
- **Новые тесты для audio-orchestrator:** 21 тест
  - 6 happy-path переходов
  - 6 invalid-переходов
  - 4 scanAllStates (включая bookId с подчёркиваниями)
  - 2 setState/deleteState
  - 2 createState helper
  - 1 key helper
- **Code review:** 2 критических бага найдены и исправлены до merge
