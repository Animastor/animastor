# Video Orchestration — чанки не теряются, склейка только для плеера

> **Дата:** 2026-08-11
> **Статус:** внедрено (вариант B по ТЗ «video chunks по аналогии с audio chunks,
> но без обязательной склейки в pipeline»); подтверждено live-тестом 11.08
> (см. §8) — 5/5 групп доехали, склейка и READY сработали.
> **Ключевые файлы:** `backend/src/services/video-orchestrator.js` (новый),
> `backend/src/video/video-merge.js`, `backend/src/video/video-service.js`,
> `backend/src/orchestration/scene-orchestrator.js`,
> `backend/src/services/task-handler.cjs`,
> `backend/src/routes/generation-routes.cjs`,
> `backend/src/orchestration/orchestrator.js`,
> `backend/src/runtime/reconciliation-engine.js`,
> `gpu-hub/gpu-hub.js`, `worker/worker/worker.cjs`,
> `backend/src/config/runtime-config.js`.

---

## 1. Проблема, которую это решает

### Инцидент 2026-08-11 (книга `import_1786345731767_1786345734345`)

Сцена `sc-45d38693` разбита на 5 групп (`_g1`..`_g5`). Все 5 сгенерированы
ComfyUI и доехали до gpu-hub → backend (10:37–10:49). Но на диск попал только
первый чанк, остальные 4 потерялись.

**Цепочка потери (подтверждено по логам):**

```
ComfyUI → gpu-hub → backend (все 5 чанков доехали)
  → первый результат: completeStage('video') → finalizeDispatch → metadata+lease удалены
  → g2..g5: verifyDispatchIdentity → no_active_dispatch → ОТКЛОНЕНЫ, файлы не записаны
```

Причина — приём видео-результатов был «первый забрал всё»:

- `completeStage('video')` вызывался на **первый пришедший** результат.
- `finalizeDispatch` удалял metadata/lease — диспатч «завершён».
- Остальные группы приходили со своим (уже неактуальным) `dispatch_id` →
  `verifyDispatchIdentity` → `no_active_dispatch` → результат молча отбрасывался.

### Корневой дефект архитектуры

- Сцены стали длинными (28.07, коммит `24c2a3e`: `SCENE_TARGET_SEC 20→60`,
  сцены до 120 сек), разбиение на ~20-сек группы (`_g1.._gN`) — норма.
- Но оркестрация под много-групповой приём результатов так и не была написана:
  `video-merge.js` (`mergeSceneVideoGroups` — ffmpeg-склейка) лежал мёртвым кодом,
  а приём результатов работал как для ОДНОЙ группы.
- До 27.07 сцены были короткими (1 группа = 1 job), поэтому дефект не проявлялся.

---

## 2. Архитектура: `video-orchestrator.js` (зеркало audio-orchestrator)

### State machine

```
GENERATING ──→ WAITING_CHUNKS ──→ MERGING ──→ DONE
      │              │               │
      └──→ FAILED ←──┴───────────────┘
```

- **Key:** `animastor:video-orch:{bookId}:{chapterId}:{sceneId}`
- **Хранит:** `phase`, `groups` (per-group: `{ unit_ids, status, job_id }`),
  `groups_received`, `build_id`, `dispatch_id`, `started_at`, `last_group_at`.
- **Переходы** (валидируются, невалидный переход → throw):
  - `GENERATING → WAITING_CHUNKS` — после отправки job'ов
  - `WAITING_CHUNKS → MERGING` — пришла последняя группа → запуск склейки
  - `MERGING → DONE` — склейка успешна → `completeStage('video')`
  - `GENERATING/WAITING_CHUNKS/MERGING → FAILED` — ошибка/застой/отмена
  - `FAILED → GENERATING/WAITING_CHUNKS` — re-dispatch

### Чем отличается от аудио

| Аспект | Audio | Video |
|--------|-------|-------|
| Чанки | mp3-файлы, склейка обязательна в pipeline | mp4-файлы `_gN.mp4`, склейка **только для плеера** |
| После прихода всех чанков | merge → DONE | merge → DONE (но групповые файлы **сохраняются**) |
| Зависимость от других стадий | нет | ждёт только `image=ready` **своей** сцены (reference-изображения) |
| Dirty-регенерация | перегенерируются все чанки сцены | только группы с грязными юнитами |

### Файлы

```
{build_id}/{book}/{ch}/{scene}_g1.mp4   ← группа 1 (первая ТОЖЕ с суффиксом!)
{build_id}/{book}/{ch}/{scene}_g2.mp4   ← группа 2
...
{build_id}/{book}/{ch}/{scene}.mp4      ← РЕЗУЛЬТАТ СКЛЕЙКИ (только для плеера)
```

**Решение по именованию:** первая группа получила суффикс `_g1` (было `g1`).
`scene.mp4` теперь резервируется под результат склейки — это позволяет
`mergeSceneVideoGroups` корректно пересклеивать без дублей и делает
`resolveSceneVideoFile` детерминированным (склеенный файл, иначе первый групповой).

Blast radius проверен: `parseJobId` (job-schema), `resolveAssetPath` (cleanup-service)
и `worker.cjs` (пишет base64, имя файла формирует backend) уже понимают `_gN`;
gpu-hub прозрачен для job_id.

---

## 3. Поток (call flow)

### 3.1 Dispatch (`executeVideoDispatch` в scene-orchestrator.js)

```
Scheduler tick → dispatchStage('video')
  → acquireLease + quota
  → executeVideoDispatch():
     1. Читает ПРЕДЫДУЩЕЕ состояние video-orch (для dirty-регенерации)
     2. videoOrch.initState(groups)      — состава групп, unit_ids
     3. Цикл по группам:
        - грязные юниты из PG (getDirtyUnitIds) → группа грязная
        - состав группы изменился → грязная
        - иначе cache-hit → markGroupDone без отправки
     4. Отправка только грязных групп → gpu-hub (job_id = {scene}_gN:video)
     5. videoOrch.setWaitingChunks()
     6. Все группы в кэше → fast-track: completeGroup → склейка без job'ов
  → return { dispatched, jobs, reason }
```

### 3.2 Приём результата (`completeGroup`)

```
POST /gpu/task/result → handleTaskResult (stale-accept для video)
  → parseJobId → kind='scene_video', groupSuffix='_g2'
  → videoOrch.completeGroup({ job_id, build_id, dispatchId, result_base64 })
     1. Валидация: состояние существует, группа в списке
     2. Запись файла {scene}_g2.mp4 на диск (+ проверка размера)
     3. markGroupDone → groups_received++
     4. Не все группы → остаёмся в WAITING_CHUNKS
     5. Все группы → WAITING_CHUNKS → MERGING:
        mergeSceneVideoGroups (NX-лок; проигравший гонку получает null → ждёт)
        → MERGING → DONE → orchestrator.completeStage('video')
        → finalizeDispatch(success) → asset.video = READY
```

### 3.3 Stale-accept (ключевой фикс)

Как у аудио: поздняя группа со **старым** `dispatch_id` принимается, пока сцена
в `WAITING_CHUNKS/MERGING`. `completeGroup` использует `dispatch_id` из ТЕКУЩЕЙ
metadata — поэтому `verifyDispatchIdentity` в `completeStage` не ломается.

Реализовано в двух местах:
- `routes/generation-routes.cjs` — `/gpu/task/result`
- `services/task-handler.cjs` — `scene_video` ветка

---

## 4. Dirty-регенерация (точечная)

Маппинг `unit_ids → группа` хранится в state (`groups[].unit_ids`).

```
Unit 1 + Unit 2 + Unit 3 → Video Chunk 5   (groups[5].unit_ids = [u1, u2, u3])

Изменение Unit 2:
  → PG: getDirtyUnitIds(scene) = [u2]
  → executeVideoDispatch: группа 5 содержит u2 → грязная
  → перегенерируется ТОЛЬКО группа 5 (тот же механизм формирования промпта
    + injection reference-изображений юнитов группы)
  → cache-hit группы помечаются done без отправки job'ов
  → полный кэш → fast-track merge (сцена пересобирается без единого job'а)
```

Границы групп пересчитываются по длительности (duration-aware chunking) —
группа с **изменившимся составом** тоже считается грязной.

---

## 5. Recovery и инварианты

### Watchdog (`checkStalledVideoScenes`, reconcileCycle)

- Порт застоя — **динамический**: реальный `video_timeout_minutes` книги из
  layer-config (fallback `VIDEO_CHUNK_STALL_MS`), порог = timeout + запас.
  Не фиксированные 60 мин — иначе watchdog мог зафейлить живую генерацию
  раньше per-job timeout.
- Застой → `failWaitingScene` → чистит hub-dedup недостающих групп →
  `FAILED → PENDING` → re-dispatch.

### Startup recovery (`recoverVideoOrchStates`)

- После рестарта доигрывает состояния в `GENERATING/WAITING_CHUNKS/MERGING`.

### Инварианты (`checkVideoOrchInvariants`)

```
video-orch.phase == DONE  ⇔  asset.video == READY   [always true]
video-orch.phase == FAILED ⇒  asset.video ∈ {FAILED, PENDING}
video-orch.phase ∈ {GENERATING, WAITING_CHUNKS, MERGING}
                         ⇒  asset.video == GENERATING
```

### Delete-on-reject (`recoverResultKeys`)

Терминально отклонённые результаты (`no_active_dispatch`, `stale_dispatch` и др.)
**удаляются из Redis** вместо бесконечного ретрая каждые 60 с.

### Merge-lock guard

Два одновременно пришедших результата не валят сцену в FAILED: `mergeSceneVideoGroups`
защищён NX-локом, проигравший получает `null` → остаётся в `WAITING_CHUNKS` и ждёт
победителя. Настоящий сбой склейки — это throw (→ FAILED), не `null`.

---

## 6. Роуты отдачи видео (`resolveSceneVideoFile`)

```
Плеер запрашивает видео сцены:
  → существует {scene}.mp4 (склейка)?  → отдать его
  → иначе первый групповой файл _g1    → сцена в процессе генерации
```

Android (`/api/v1/scene/{book}/{ch}/{scene}/video`) и чанк-эндпоинт
(`/api/v1/chunk/{id}/video`) используют один хелпер.

---

## 7. Таймауты долгой видео-генерации

### Проблема

Видео-генерация архитектурно долгая: LTX 2.3 — уже ~190 с сейчас, 5–10 мин в
норме, 20–30+ мин на слабом пользовательском GPU. Три звена имели короткие
фиксированные потолки:

| Звено | Было | Проблема |
|-------|------|----------|
| gpu-hub | `timeout_ms` не читался из body → per-job timeout = `GPU_TIMEOUT_MS` (10 мин) | видео >10 мин убивалось как `worker_timeout` |
| worker | `RESULT_TIMEOUT_MS = 600000` (10 мин), `task.timeout_ms` игнорировался | воркер убивал нормальную долгую генерацию |
| watchdog | фиксированный порог 60 мин | мог сработать раньше реального per-job timeout (до 180 мин) |

### Исправлено

```
backend (layer-config: video_timeout_minutes, дефолт 60, диапазон 10–180)
  → gpu-hub: POST /task body.timeout_ms → queue task.timeout_ms + running.timeout_ms
     per-job timeout = timeout_ms || GPU_TIMEOUT_MS
     защита: per-job timeout ≥ GPU_TIMEOUT_MS
  → worker: waitResult(prompt_id, workflow, task.timeout_ms)
     приоритет: task.timeout_ms
     видео-fallback: VIDEO_RESULT_TIMEOUT_MS (дефолт 2 часа, env)
     остальные: RESULT_TIMEOUT_MS (без изменений)
  → watchdog: порог = layer-config video_timeout_minutes + запас
```

**Принцип:** отличие «генерация долго выполняется» от «зависла / worker умер»
определяется ТОЛЬКО per-job таймаутом из layer-config (пользовательская
настройка), а не произвольным коротким дефолтом.

### Параллельность image/video (проверено, правок не потребовалось)

- Image и video — независимые стадии (`shouldScheduleAssets`): глобального
  «wait until all images» НЕТ.
- Видео сцены ждёт только `image=ready` **своей** сцены (reference-изображения
  для injection в workflow).
- «Scene 1 / Chunk 1 ждёт картинки» не блокирует «Scene 2 / Chunk 3 → video»
  или «Scene 3 → image».

---

## 8. Live-тест 2026-08-11: что нашлось и исправлено

Полный E2E-прогон сцены `sc-45d38693` (5 групп, по 1 юниту) подтвердил работу
всей цепочки и вскрыл 3 проблемы:

### 8.1 Цепочка отработала полностью

```
VIDEO_DISPATCH groups=['_g1'..'_g5'] (timeout=60 min from layer-config)
📥 Task _g1.._g5:video timeout_ms:3600000   → все 5 в очереди hub'а
🚀 _g1.._g5 → gpu-n-94d62b6a (video)        → воркер
📤 Result _g1.._g5 (2.95–9.59MB)            → ВСЕ 5 дошли, каждые ~3 мин
[VIDEO-ORCH] 5/5 groups received
[VIDEO-MERGE] mergeSceneVideoGroups suffixes=[_g1.._g5]
[VIDEO-ORCH] DONE (5 groups merged → scene.mp4)
[ORCH] [PG-VIDEO-READY] status=ready        → asset.video = READY
```

Вчерашний инцидент «пришёл только первый чанк» больше не воспроизводится:
все 5 групп сохранены отдельными файлами `_gN.mp4`, склейка в `scene.mp4`
(23MB) произошла только после прихода ВСЕХ групп, плеер отдаёт полное видео.

### 8.2 Проблемы, найденные при тесте (и их фиксы)

1. **Stale `image=generating` блокировал видео (не код, а данные).** После
   рестарта gpu-hub image-воркер получил `💀 GPU timeout` и умер; `iu-in-flight`
   ключи протухли по TTL, но asset-state `image=generating` остался →
   `imageEnabled=true` (in-flight) → видео не диспатчилось (ждёт `image=ready`
   своей сцены — локальная зависимость работает как задумано). Разблокировано
   вручную: `HSET image=ready` (картинки уже были на диске и зарегистрированы).
2. **Fast-track merge падал с `orchestrator is not defined`** (наш баг): в
   `executeVideoDispatch` переменная `orchestrator` не была импортирована
   (только деструктуризация `{ completeStage, ... }`), а `completeGroup`
   требует `deps.orchestrator`. Фикс: `const orchestrator = require('./orchestrator')`.
3. **VERSION-GATE: legacy-книги без строки `scenes` в PG не получали READY**
   (пред-существующий): `completeStage` fail-closed — `SELECT content_version`
   → 0 строк → `shouldWriteReady=false` → DIRTY → бесконечный цикл
   `dirty → fast-track → DONE → dirty`. А строка `scene_assets` video создаётся
   только `markReady`, который вызывается ПОСЛЕ gate — замкнутый круг.
   Фикс: при 0 строк в `scenes` gate считается пройденным (сцена без
   version-схемы не может устареть); fail-closed для реальных схем сохранён.

### 8.3 Операционные заметки для тестов

- Перед тестом пересобрать **gpu-hub** (`docker compose up -d --build gpu-hub`)
  — иначе старый hub (без live-mount) не пробросит `timeout_ms` и убьёт
  долгие видео на 10-мин GPU_TIMEOUT.
- Воркеры на GPU-инстансе должны иметь актуальный `worker.cjs` (из пуша).
- Для обхода мёртвого image-воркера при тесте картинка юнита была подменена
  копией соседней (данные, не код) — при следующей нормальной генерации
  сгенерируется настоящая.

---

## 9. Деплой-чеклист

1. **Слить очереди gpu-hub перед выкатом** — старые job'ы вида `{scene}:video`
   (без `_g1`) пишут в `scene.mp4`, что теперь конфликтует с путём склейки.
2. Потерянные `g2..g5` книги `import_1786345731767_1786345734345` НЕ восстановить
   (TTL истёк) — только перегенерация сцены `sc-45d38693`; с новым кодом она
   пройдёт корректно.
3. `VIDEO_CHUNK_STALL_MS` добавлен в runtime-config (fallback для watchdog,
   основной порог берётся из layer-config).
4. На GPU-воркерах: пересобрать/обновить `worker.cjs` (поддержка `task.timeout_ms`
   и `VIDEO_RESULT_TIMEOUT_MS`).

---

## 10. Тесты

- `backend/tests/video-orchestrator.test.js` (новый, 18 тестов): переходы state
  machine, completeGroup по одной группе, merge-failure, lock-гонка, stale-dispatch,
  failWaitingScene, helpers, инварианты.
- `backend/tests/orchestration-stabilization.test.js`: протокол v2, гонка executor,
  «долгая видео-генерация не убивается» (gpu-hub пробрасывает `timeout_ms`, worker
  уважает `task.timeout_ms` + видео-fallback ≥ 1 часа).
- `backend/tests/reconciliation-engine.test.js`: `checkStalledVideoScenes` учитывает
  layer-config.
- `backend/tests/happy-path.test.js`: +2 теста VERSION-GATE (legacy-книга без
  строки `scenes` → READY; stale-версии при существующей схеме → DIRTY).
- Весь mocha-сьют: **1067 passing** (было 1015).

<!-- === Footer === -->
---
*Документ видео-оркестрации. 2026-08-11.*
