# Audio Orchestration — архитектурные Fixes против «сработало — и ладно»

> **Дата:** 2026-07-20
> **Контекст:** серия сегодняшних коммитов (`281d192`, `ebbcb4f`, `4a17f55`,
> `ecde189`, `1ce49ee`, `02e99a5`) латала аудио-оркестрацию точечно — таймаутами,
> skip-fail, хардкодами и защитными guard'ами. Ниже фиксируется, какой дизайн
> должен быть в ядре, чтобы эти патчи ушли как симптомы, а не как_LONG-TERM решения.
>
> **Стиль:** каждый раздел описывает (а) текущий_st костыль, (б) почему он
> существует, (в) как должно быть архитектурно, (г) шаги миграции.

---

## 1. Таймауты не должны подбираться вручную

### Текущий костыль (`281d192`)
```js
// runtime-config.js
AUDIO_CHUNK_STALL_MS: 900000, // 15 мин
LEASE_TTL_S.AUDIO:    20 * 60, // 20 мин
// gpu-hub GPU_TIMEOUT: 10 мин (env)
```
Коммит-сообщение буквально фиксирует invariant «GPU_TIMEOUT < STALL < LEASE_TTL»
подбором констант. Любое изменение `GPU_TIMEOUT` в env молча ломает оркестрацию.

### Почему существует
Watchdog `checkStalledAudioScenes` не знает, мёртв ли воркер или просто долго
генерирует. Поэтому выбирается «безопасная» верхняя граница, которая всегда
больше таймаута GPU.

### Как должно быть
**Источником истины должен быть callback от воркера/хаба, а не таймер.**

- `gpu-hub` уже умеет в `GPU_TIMEOUT` — он НЕ репортит «success», а кидает
  явную ошибку `worker_dead` / `job_timeout`.
- Эта ошибка должна прийти в backend как асинхронное событие (через callback
  endpoint или Redis pub/sub `animastor:gpu:events`), а НЕ молчаливо
  дожидаться истечения `AUDIO_CHUNK_STALL_MS`.
- Watchdog `checkStalledAudioScenes` остаётся **только как failsafe** для
  случая «воркер умер и hub об этом не сообщил» (например, потеря сети между
  hub и backend). Его таймаут должен быть **мультипликативно больше** любого
  разумного сценария, а не выверен в硕士学位 миллисекундах:

```js
// Архитектурный инвариант:
//   STALL_FAILSAFE_MS = max_gpu_timeout_ms * 3
// Задан формулой от GPU_TIMEOUT, а не независимой константой.
const GPU_TIMEOUT_MS = Number(process.env.GPU_TIMEOUT_MS ?? 600_000);
const STALL_FAILSAFE_MS = GPU_TIMEOUT_MS * 3;  // 30 мин при 10-минутном GPU

// LEASE_TTL только страхует от потерянных callbacks:
const LEASE_TTL_S = { AUDIO: Math.ceil(STALL_FAILSAFE_MS / 1000) + 60 };
```

- Если hub присылает явный `job_timeout` — `failWaitingScene` вызывается сразу,
  без ожидания watchdog'а.
- В конфиге остаётся ОДНА входная константа (`GPU_TIMEOUT_MS`), остальные
  вычисляются. Никаких «STALL = 15, LEASE = 20, GPU = 10» — формула вместо
  магических чисел.

### Миграция
1. Ввести `GPU_TIMEOUT_MS` как single source of truth, вычислить `STALL` и
   `LEASE_TTL` от него.
2. Добавить в `task-handler.cjs` обработку `gpu_hub_error` события → прямой
   вызов `failWaitingScene(reason='gpu_timeout')`.
3. Тест `runtime-timeouts.test.js` переписать на проверку формулы, а не
   хардкод-значений.

---

## 2. 0-байтные чанки — retry, а не skip

### Текущий костыль (`ebbcb4f`)
```js
const MIN_CHUNK_BYTES = 100;
if (size < MIN_CHUNK_BYTES) {
    fs.unlinkSync(chunkPath);            // молча удалить
    await redis.del(`...:${chunkId}:audio`); // очистить dedup
}
// далее в merge эти индексы просто отсутствуют
```
TTS вернул 0 байт → файл удаляется → чанк считается «missing» → ждём
re-dispatch. Симптом (пустой выход TTS) маскируется вместо того, чтобы стать
диагностикой.

### Почему существует
GPU hub иногда возвращает 200 OK с пустым телом (edge-case таймаута модели).
Логика merge не должна падать на пустых данных — поэтому их «вырезают».

### Как должно быть
**Пустой результат TTS — это recoverable error с явным retry-контрактом, а не
just-skip-it.**

- TTS-провайдер возвращает explicit error вместо пустого буфера. Если провайдер
  этого не делает — `task-handler.cjs` валидирует результат и публикует
  failure-событие с `reason='tts_empty_output'`, НЕ записывая 0-байтный файл.
- Оркестратор держит **per-chunk retry budget** (см. §4): например,
  `max_attempts=2` per chunk. Пустой выход → retry. После исчерпания budget →
  chunk помечается `permanently_failed`, вся сцена идёт в `FAILED` с понятной
  причиной (а не молчаливым absent в merge).
- `MIN_CHUNK_BYTES` остаётся только как **defense-in-depth** для случая, когда
  файл всё-таки был записан (crash между записью и валидацией). Nobody relies
  on это для нормального flow.

### Миграция
1. В `task-handler.cjs` добавить валидацию: `if (result.length < MIN) emit('chunk_failed', { chunkId, reason: 'empty' })`.
2. В `audio-orchestrator.js` ввести `retry_count` per chunk в state:
   ```js
   chunks: { 1: { attempts: 2, status: 'ok' }, 2: { attempts: 3, status: 'failed' } }
   ```
3. `completeChunk` не проверяет байты для normal path, только для recovery path.

---

## 3. Stale re-dispatch — явные lease, а не phase guards

### Текущий костыль (`4a17f55`)
```js
// executeAudioDispatch начало:
if (phase === WAITING_CHUNKS || phase === MERGING) {
    return { completed: true }; // guard от повторного диспатча
}
```
Guard добавлен, потому что scheduler мог передиспатчить сцену, у которой чанки
уже в полёте. Это фикс симптома (scheduler не знает, что сцена занята), а не
причины.

### Почему существует
Между `executeAudioDispatch` и `setWaitingChunks` есть окно, в котором state
сцены = `GENERATING`, но dispach уже отправлен. Scheduler на следующем tick'е
видит «не DONE, не FAILED» → передиспатчит. Новый dispatchId делают все
старые результаты `stale_dispatch`.

### Как должно быть
**Dispatch — это lease, а не фаза.** Lease — это эксклюзивное право на
продолжение работы, с TTL и явным owner'ом.

- При входе в `executeAudioDispatch` оркестратор берёт
  `dispatch-lease:{sceneId}` с TTL = `STALL_FAILSAFE_MS` и owner =
  `dispatchId`. Если lease занят — выходим с `completed: true` БЕЗусловно.
- `setWaitingChunks`, `completeChunk` и т.д. принимают `dispatchId` и
  проверяют, что он совпадает с владельцем lease. Mismatch → silent drop
  (входящий результат не наш).
- Watchdog при stall': не «сбрасывает фазу», а **отзывает lease** (TTL истёк
  → автоматически свободно) и потом переводит state в PENDING для scheduler'а.
- Phase guards (`WAITING_CHUNKS && return`) удаляются — они избыточны при
  наличии lease.

```js
// Псевдокод:
async function executeAudioDispatch(redis, scene, dispatchId) {
    const lease = await acquireLease(redis, scene, dispatchId, TTL_MS);
    if (!lease.acquired) {
        log(`scene already under dispatch (owner=${lease.owner}) — skip`);
        return { completed: true };
    }
    // фаза — ONLY between lease acquire и release;
    // если сюда дойдёт второй вызов с тем же dispatchId — lease уже наш,
    // но это бессмысленно (idempotent by design).
    ...
}
```

### Миграция
1. Ввести `acquireDispatchLease` / `releaseDispatchLease` в Redis (SETNX +
   TTL). Это уже частично есть (`DISPATCH_LEASE_PREFIX`), но используется только
   для quotas — расширить до эксклюзивного владения сценой.
2. Все приемники chunk-result'ов (`completeChunk`, `task-handler`)在校学生
   validate `dispatchId === lease.owner`, иначе drop.
3. Удалить phase-guard в начале `executeAudioDispatch`.
4. Сигнализация: если `completeChunk` получает mismatch, метрика
   `audio.stale_result_dropped{reason=dispatch_id_mismatch}`.

---

## 4. «9+9 дубликаты» — cache-hit по чанкам, а не bulk-delete

### Текущий костыль (`ecde189`)
Коммит удалил `bulk-delete` чанков при `existingCount !== expectedCount`.
Раньше `generateSceneAudio` сносил все чанки и re-dispatchил всё. Это был
 ziebart'ный способ «начать заново», уничтожающий частичный прогресс.

### Почему существует
Размер ожидаемого комплекта чанков != размер дискового кеша — нет доверия к
кешу. «Безопасное» решение — пересчитать всё.

### Как должно быть
**Chunk — атомарная idempotent единица с persistent identity и own cache.**

- Каждый chunk имеет стабильный id `{sceneId, chunkIndex}` и content hash
  (от исходного текста). Cache key = `{chunkId, contentHash}`.
- `sendPerSegmentAudio` уже делает per-chunk cache-hit (commit это и отметил).
  Это и есть правильное поведение — все вызовы диспатча idempotent per-chunk.
- `generateSceneAudio` НЕ должен знать про кеш чанков ВООБЩЕ. Его
  ответственность — «дай мне expected chunks», а наличие/отсутствие каждого
  разрешается ниже.
- «Expected count mismatch» означает, что проектная сегментация изменилась
  (например, текст сцены отредактирован). В этом случае **кеш конкретных
  чанков инвалидируется по content hash**, а не сносом всего. Чанки, чей
  content hash совпал — остаются; новые/изменённые — переотправляются.

```js
//orrect flow:
async function dispatchSceneChunks(scene, expectedChunks) {
    for (const chunk of expectedChunks) {
        const hash = contentHash(chunk.text);
        const cached = await cache.get(chunk.id, hash);
        if (cached) {
            markChunkReady(chunk.id, cached);
        } else {
            await cache.invalidate(chunk.id); // только этот
            await sendToGpu(chunk);
        }
    }
}
```

- Хардкод «9+9» в сообщении коммита — это просто симптом; архитектурно
  числа нигде не должны фигурировать.

### Миграция
1. Ввести `chunk.content_hash` в `chunk-metadata` (Redis) при сегментации.
2. `findExistingSceneChunks` возвращает `[{ index, hash }]`, а не `[index]`.
3. `sendPerSegmentAudio` сверяет hash; mismatch = invalidate + redispatch
   ОДНОГО чанка.

---

## 5. Batch dispatch — явный plan, а не «сначала narration, потом dialogue»

### Текущий коммит (`1ce49ee`)
```js
// send Chung сначала куски narration, потом dialogue
```
Сообщения wenig informative. Изменение семантики диспетчера под конкретный
edge-case (вероятно — приоритизация или порядок низкого latency для
нарратива).

### Почему существует
Dialogue chunks, видимо, дороже/дольше, или их хочется отложить, чтобы narration
был готов раньше. Но это **политика приоритизации**, закопанная в dispatch order.

### Как должно быть
- Dispatch должен принимать **plan** (`ordered list of chunk specs`), а не
  свободный список. Plan формируется в одном месте (segmentation layer), где
 .liveётся знание о типах чанков.
- Тип чанка (`narration`/`dialogue`) — атрибут plan'а, неcargo dispatch'а.
- Приоритизация (если нужна) — отдельная стратегия:
  ```js
  const ORDERING = { LOW_LATENCY_PREVIEW: 'narration-first', UNIFORM: 'round-robin' };
  dispatchSceneChunks(scene, { ordering: ORDERING.LOW_LATENCY_PREVIEW });
  ```
- Сейчас это закопано в `1ce49ee` без тестов и без упоминания в docs —
  любое следующее изменение семантики снова пойдёт через «исправить и забыть».

### Миграция
1. Вынести тип-параметр в сигнатуру `generateSceneAudio(scene, { ordering })`.
2. Документировать в `ORCHESTRATION.md` текущую политику и rationale.
3. Тест на порядок (reconstruct plan from dispatch journal).

---

## 6. Filesystem order — deterministic naming, не sort как patch

### Текущий коммит (`02e99a5`)
```js
// chunks.js
chunks.sort((a, b) => a - b);
```
Комментарий буквально говорит: «CRITICAL: sort numerically — filesystem order
... is NOT deterministic». Это правильно, но это — hậu factum патч, выявивший
что **имена файлов не были детерминированным источником порядка**.

### Почему существует
`readdirSync` на EXT4 возвращает hash-table order. Если потребитель
не сортирует — он получает мусор. До этого merge кормил ffmpeg concat
чанками в произвольном порядке — диалоги терялись, никто не понимал почему.

### Как должно быть
- **Chunk id encoding должен быть самодокументируемым и sort-stable**: то, что
  `pad(4)` (`0001`, `0002`)sortable as string equals numeric sort — это
  важно и должно быть invariant'ом, а не случайностью.
- Все consumers chunk files **должны работать с ordered index list**, а не с
  raw `readdirSync`. Например:
  ```js
  function listSceneChunksOrdered(sceneId, expectedCount) {
      // Не readdir — explicitly enumerate expected indices.
      return Array.from({ length: expectedCount }, (_, i) => i + 1)
          .filter(i => fs.existsSync(path(i)));
  }
  ```
  Это устраняет саму возможность «readdir вернул в любом порядке».
- `findExistingSceneChunks` переименовать в `getExistingChunkIndices` и
  сделать enumeration-based, не readdir-based.
- `.sort()` остаётся как cheap defense-in-depth, но ответственности не несёт.

### Миграция
1. Переписать `chunks.js::findExistingSceneChunks` на enumeration (expected_count подаётся из orchestrator state, не из fs).
2. Audit всех потребителей `findExistingSceneChunks` — должны ли они знать
   count? Если да — передавать `expectedCount`, чтобы не было Wild fs scans.
3. Тест: создать чанки 1, 9, 10 → merge должен дать порядок [1, 9, 10],
   не [1, 10, 9].

---

## 7. Общие принципы, которых пока не хватает

| Принцип | Текущее состояние | Должно быть |
|---|---|---|
| **Single source of truth для таймаутов** | 3 независимые константы | формула от `GPU_TIMEOUT_MS` |
| **Idempotent dispatch** | sheriff phase guards | lease per dispatchId + validate на каждом шаге |
| **Chunk as cache atom** | bulk-delete при mismatch | per-chunk content hash cache |
| **Recoverable vs permanent failure** | всё разбирается по факту | retry budget per chunk, explicit after-budget failure |
| **Dispatch plan** | спрятан в коде | явный ordered plan + policy |
| **Deterministic data ops** | sort как patch | explicit enumeration, не readdir-семантика |
| **Failure signalling** | `[DEBUG]` логи | structured events в journal + метрики |

---

## 8. Приоритеты миграции

1. **P0 (data loss risk):** §6 — enumeration вместо readdir. Дешёвый фикс,
   устраняет целый класс багов.
2. **P0 (silent corruption):** §2 — empty TTS как retry-able failure, не skip.
   Сейчас empty chunks просто исчезают.
3. **P1 (reliability):** §4 — per-chunk content hash cache. Устраняет duplicate
   dispatch как класс.
4. **P1 (operations):** §3 — lease вместо phase guards. Это базовый пункт для
   всей остальной оркестрации.
5. **P2 (cleanup):** §1 — таймауты через формулу. Сегодня работает, но
   нагадит при первом изменении GPU_TIMEOUT.
6. **P2 (documentation):** §5 — вынести batch dispatch в явный plan + doc.

---

## 9. Антипаттерны, которых избегать при реализации

- **«Залатать и забыть»**: каждый из перечисленных разделов сегодня —
  patch на симптом. Не повторять такое при миграции: если вводишь retry —
  вводи retry budget и metric, не «один раз пробуем ещё».
- **State machine с implicit transitions**: `GENERATING → WAITING_CHUNKS`
  делается из трёх мест (`executeAudioDispatch`, `completeChunk` race-condition
  branch, `failWaitingScene` recovery). Каждая implicit-транзакция = будущий
  баг. Transitions должны быть одним owner per phase.
- **DEBUG-логи вместо structured events**: `[DEBUG]` строки сегодня
  единственный способ понять, что произошло. Это debugging tool, не
  observability. Events (`chunk_received`, `merge_started`, `lease_acquired`)
  должны пойти в journal.
- **«Heat» invariant'ов в комментариях**: комментарии вида «инвариант: GPU <
  STALL < LEASE» — это OK как документация, но должен быть ещё и runtime
  assertion (по образцу `tests/runtime-timeouts.test.js`, расширить на все
  инварианты).

---

## TL;DR для авторов следующих патчей

> Если вы сейчас пишете ещё один фикс по аудио-оркестрации — сначала проверьте,
> не относится ли он к одному из семи пунктов выше. В 90% случаев «новый баг»
> — это тот же симптом в другой обёртке, и чинить его надо на уровне
> архитектуры, а не ещё одним `if (phase === ...)` в начале функции.

---

## Статус реализации на 2026-07-21

| § | Пункт | Статус | Примечание |
|---|-------|--------|------------|
| 1 | Таймауты через формулу | ✅ Внедрено | `GPU_TIMEOUT_MS` → STALL *3 → LEASE +60s |
| 2 | 0-байтные чанки как retry | ❌ Пропущен | Текущий watchdog работает; explicit retry — переусложнение |
| 3 | Lease вместо phase guards | ✅ Внедрено | Guard удалён; A2 гарантирует LEASE > STALL |
| 4 | Per-chunk content hash | ❌ Пропущен | «9+9» уже пофикшено; файловый кеш работает |
| 5 | Явный dispatch plan | ❌ Пропущен | Нет второй альтернативы — overengineering |
| 6 | Deterministic enumeration | ✅ Внедрено | `expectedCount` → enumeration; readdir fallback |
| 7 | Общие принципы | 🟡 Частично | SSOT (таймауты) + lease (диспатч) — сделано. Остальное — отложено |

**Детали:** см. `docs/02-orchestration/AUDIO_ORCH_ARCHITECTURAL_TODO.md`
