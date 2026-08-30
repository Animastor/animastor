# GPU Hub Cleanup: Animastor

> GPU Hub stale task cleanup mechanisms during regeneration and generation cancellation.
> Last updated: July 2026

---

## 1. Why Cleanup Is Needed

При регенерации (POST /regenerate) или отмене (POST /cancel-generation) необходимо
остановить старые задачи в GPU Hub, иначе:

| Проблема | Без очистки | С очисткой |
|----------|-------------|------------|
| **Dedup блокирует новые задачи** | GPU hub отвечает `duplicate job_id` | Dedup-ключи удалены, новые задачи проходят |
| **Stale задачи в очереди** | Воркер выполняет старые TTS/image задачи, файлы идут в `data/default/` вместо `data/output/build_xxx/` | Очередь очищена от задач этой книги/сцены |
| **Running задачи не требуются** | GPU hub requeue-ит их после таймаута, они выполняются | Running-задачи удалены |
| **Result dedup блокирует новые результаты** | Backend отклоняет результат как `already processed` | Result-processed маркеры удалены |
| **Cache recovery возвращает stale файлы** | Audio-recovery восстанавливает старые версии | Cache очищен |

---

## 2. Function `clearGpuHubQueues(redis, bookId, sceneFilter?)`

**Файл:** `backend/src/routes/book/generation-routes.cjs`

**Сигнатура:**
```javascript
async function clearGpuHubQueues(redis, bookId, sceneFilter = null)
```

**Параметры:**
- `redis` — ioredis client
- `bookId` — ID книги (например, `import_1783656905372_1783656918982`)
- `sceneFilter` — опциональный массив `{ chapter_id, scene_id }[]`. Если передан — очищаются только задачи для указанных сцен. Если `null` — очищаются все задачи для `bookId`.

### 2.1 Step 1: Dedup Keys `animastor:job:*`

```javascript
// SCAN по pattern animastor:job:{bookId}_*
// post-filter: suffix.startsWith(bookPrefix)
// Удаление: redis.del(keys)
```

**Зачем:** GPU hub использует `SET NX EX 3600` для дедупликации job_id.
Пока ключ `animastor:job:{job_id}` существует, hub отвечает `duplicate`.
Без удаления — новые задачи не будут приняты.

**Post-filter:** Redis glob pattern `_` — wildcard на один символ. Поэтому
SCAN может зацепить книги с пересекающимися префиксами (например,
`import_123` может совпасть с `import_1234`). Post-filter проверяет точное
вхождение `bookId_` через JavaScript.

### 2.2 Step 2: Result-processed Dedup `animastor:result-processed:*`

```javascript
// SCAN по pattern animastor:result-processed:{bookId}_*
// Извлекаем job_id из ключа (split(':')[0])
// post-filter: jobIdMatch(jobId)
// Удаление: redis.del(keys)
```

**Зачем:** GPU hub ретраит отправку результата до 5 раз. Backend защищается
`SET NX` ключом `animastor:result-processed:{job_id}:{build_id}`. Без удаления —
первый пришедший результат будет принят, остальные 4 отклонены.

Но при регенерации старый результат — это stale-данные. Новый результат будет
отклонён, если dedup-ключ не очищен.

### 2.3 Step 3: GPU Hub Queues `animastor:queue:audio|image|video`

```javascript
// Для каждого типа (audio, image, video):
//   1. LRANGE entire queue
//   2. Фильтр: оставить только те задачи, где job_id НЕ начинается с bookPrefix/scenePrefix
//   3. DEL ключ очереди
//   4. RPUSH отфильтрованные обратно
```

**Зачем:** Это основной источник проблемы stale-файлов. Если в очереди висит
старая TTS-задача с `build_id: "default"`, воркер её выполнит и сохранит
результат в неправильную директорию.

**Race condition:** Между LRANGE и DEL+RPUSH есть микро-окно, когда GPU hub
может запушить новую задачу. В таких случаях задача теряется. Для regenerate
это приемлемо — regenerate ожидает, что все задачи будут отправлены заново.

### 2.4 Step 4: Running Tasks `animastor:running`

```javascript
// HSCAN animastor:running
// Фильтр: каждый field (job_id) проверяется через jobIdMatch
// HDEL отфильтрованных
```

**Зачем:** GPU hub хранит текущие выполняемые задачи в хэше `animastor:running`.
Если задача зависла и воркер не ответил, hub requeue-ет её после таймаута.
Удаление из running prevents requeue.

### 2.5 Step 5: Result Cache `animastor:result:*`

```javascript
// SCAN по pattern animastor:result:*:{bookId}_*
// Post-filter: suffix.includes(':bookPrefix')
// Удаление: redis.del(keys)
```

**Зачем:** GPU hub кэширует результаты задач. Audio-recovery и другие механизмы
могут восстановить файлы из этого кэша. При регенерации stale-кэш не нужен.

---

## 3. Function `removeScenesFromActiveIndex(redis, bookId, scenes)`

**Файл:** `backend/src/runtime/runtime-scheduler.js`

**Сигнатура:**
```javascript
async function removeScenesFromActiveIndex(redis, bookId, scenes)
```

**Зачем:** Удаляет только указанные сцены из сета `animastor:active-scenes`.
Ранее `clearBookFromActiveIndex()` удаляла **все** сцены книги, что убивало
параллельную генерацию других сцен в той же книге.

**Как работает:**
```javascript
// Для каждой сцены из списка:
//   sceneKey = `${bookId}:${chapter_id}:${scene_id}`
//   SREM animastor:active-scenes sceneKey
```

---

## 4. Function `clearLeasesForScenes(redis, bookId, scenes)`

**Файл:** `backend/src/runtime/dispatch-engine.js`

**Сигнатура:**
```javascript
async function clearLeasesForScenes(redis, bookId, scenes)
```

**Зачем:** Удаляет dispatch-аренду, метаданные и completed-маркеры только для
указанных сцен. Ранее `clearAllLeasesForBook()` удаляла **все** leases для книги,
что убивало параллельную генерацию других сцен.

**Как работает** (batch DELETE, без SCAN — ключи известны заранее):
```javascript
// Для каждой сцены и каждого типа (audio, image, video):
//   animastor:dispatch-lease:{bookId}:{ch}:{sc}:{type}
//   animastor:dispatch-meta:{bookId}:{ch}:{sc}:{type}
//   animastor:dispatch-completed:{bookId}:{ch}:{sc}:{type}
```

---

## 5. Full Regeneration Protocol (with cleanup)

```
POST /api/v1/book/:bookId/regenerate
  │
  ├── 1. Acquire regenerate lock (SET NX EX 300)
  │
  ├── 2. collectAllScenes()
  │
  ├── 3. computeBookDiff() → dirtyScenes
  │
  ├── 4. filterDirtyScenesByScope() → filteredDirty
  │
  ├── 5. removeScenesFromActiveIndex(redis, bookId, filteredDirty)
  │      └── Только dirty-сцены, остальные продолжают генерацию
  │
  ├── 6. clearLeasesForScenes(redis, bookId, filteredDirty)
  │      └── Только dirty-сцены
  │
  ├── 7. clearGpuHubQueues(redis, bookId, filteredDirty)
  │      └── Только задачи dirty-сцен в GPU hub
  │
  ├── 8. markDirtyScenes()
  │      └── Сброс chunk-статусов, per-asset состояний
  │
  ├── 9. restoreChunkStatusForScene()
  │      └── Если файл на диске валиден — skip GPU
  │
  ├── 10. addSceneToActiveIndex()
  │       └── Scheduler подхватит через 5s
  │
  └── 11. Release regenerate lock
```

**Ключевое изменение (июль 2026):**
Шаги 5, 6, 7 работают **только с dirty-сценами**, а не со всей книгой.
Если параллельно генерируются сцены 5 и 10, а пользователь регенерирует
сцену 3 — сцены 5 и 10 продолжают работу без прерывания.

---

## 6. Cancel-generation (book-wide cleanup)

```
POST /api/v1/book/:bookId/cancel-generation
  │
  ├── 1. clearBookFromActiveIndex(redis, bookId)
  │      └── Все сцены → удалены из active index
  │
  ├── 2. clearAllLeasesForBook(redis, bookId)
  │      └── Все leases → удалены
  │
  ├── 3. redis.del('animastor:runtime:active-*')
  │      └── Счётчики quota → сброшены
  │
  └── 4. clearGpuHubQueues(redis, bookId, null)
         └── Все задачи → очищены
```

**Отличие от regenerate:** cancel-generation — полная остановка генерации.
Все сцены книги останавливаются, очередь GPU hub очищается целиком.
sceneFilter не передаётся (null → все задачи для bookId).

---

## 7. Redis Key Space (GPU Hub)

```
# Dedup
animastor:job:{job_id}                      # SET NX EX 3600 — дедупликация задач
animastor:result-processed:{job_id}:{build} # SET NX EX 3600 — дедупликация результатов

# Очереди
animastor:queue:audio                        # List — TTS задачи
animastor:queue:image                        # List — Image generation задачи
animastor:queue:video                        # List — Video generation задачи

# Running
animastor:running                            # Hash — текущие выполняемые задачи

# Результаты
animastor:result:{build_id}:{bookId}:{...}   # String — кэш результатов

# Heartbeat
animastor:worker:heartbeat:{type}:{id}       # String — heartbeat воркеров
```

---

## 8. Files

| Файл | Функция | Роль |
|------|---------|------|
| `backend/src/routes/book/generation-routes.cjs` | `clearGpuHubQueues()` | Очистка GPU hub очередей и dedup-ключей |
| `backend/src/runtime/runtime-scheduler.js` | `removeScenesFromActiveIndex()` | Scene-specific удаление из active index |
| `backend/src/runtime/dispatch-engine.js` | `clearLeasesForScenes()` | Scene-specific удаление dispatch leases |
| `backend/src/runtime/dispatch-engine.js` | `clearAllLeasesForBook()` | Book-wide удаление dispatch leases (cancel) |
| `backend/src/runtime/runtime-scheduler.js` | `clearBookFromActiveIndex()` | Book-wide удаление из active index (cancel) |
