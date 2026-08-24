# Аудит: recovery/cleanup временных файлов ComfyUI через orchestration state

> Разведка перед реализацией recovery cleanup после падения/restart worker.
> Исследование существующей оркестрации job lifecycle и того, как безопасно
> выполнять cleanup незавершённых задач (delivered=true, cleaned=false).
>
> **Read-only**: ничего не исправлялось. Основан на чтении исходного кода.
> Дата: 2026-08-24. Ветка: `master` (`b860162`).
> Связанный документ: `COMFYUI_TEMP_FILES_CLEANUP_AUDIT.md` (первый аудит),
> реализация точечного cleanup — коммит `b860162`.
>
> ## Статус реализации
>
> Рекомендация из этого аудита **внедрена** в коммите **`e874761`**:
> - `worker/worker/worker-cleanup-journal.cjs` — worker-local persistent journal
>   (одна запись на job, только конкретные absolute paths, атомарные записи
>   tmp→fsync→rename). API: `createJob` / `addInputFile` / `setOutputAndGenerated`
>   / `setDelivered` / `removeJob` / `recoverCleanupJournal`.
> - `worker.cjs`: journal создаётся ДО первого input-файла; каждый input-путь
>   фиксируется; output+`generated` — после `waitResult`; `delivered` — только
>   после HTTP 200 от hub `/task/result`; journal удаляется только при полном
>   успехе cleanup (частичный cleanup держит запись для следующего recovery).
> - Startup: `recoverCleanupJournal()` вызывается после `waitForComfyUI()`,
>   до `workerLoop()`. delivered → input+output; created/generated → только
>   input (output без proof DELIVERED не трогается).
> - Backend orchestration / Redis / PG не менялись. Idempotent: ENOENT = success.
> - Тесты: `backend/tests/worker-cleanup-journal.test.js` (16 сценариев) + базовые
>   cleanup-тесты `worker-cleanup.test.js`.

---

## 1. Где сейчас хранится состояние job

| Слой | Что хранит | Долговечность |
|---|---|---|
| **Worker** (`worker.cjs`) | Ничего. Полностью stateless, HTTP-only к hub, без Redis/DB/файлов (кроме самих temp-файлов) | — |
| **Hub** (Redis, `gpu-hub.js`) | `animastor:queue:{type}[:ws:{ws}]`, `animastor:processing`, `animastor:running` (claim), `animastor:result:{build}:{book}:{chapter}:{scene}:{stage}` (base64, `EX 3600`), dedup `animastor:job:{dispatch}:{job}` | Redis имеет persisted volume `redis-data:/data` (docker-compose) — переживает restart, но TTL действуют |
| **Backend** (Redis) | `animastor:asset-state:{book}:{ch}:{scene}` (per-asset: new/dirty/pending/generating/ready/failed/placeholder), `animastor:audio-orch:*`, `animastor:video-orch:*` (phase-машины), dedup `animastor:result-processed:{dispatch}:{job}:{build}` (`EX 3600`), event-journal | Redis persisted |
| **Backend** (PostgreSQL) | `scene_assets` (status='ready', artifact path, build_id), `image_units`, `scenes` (content_version), workers | Долговечно, source of truth |

## 2. Существующие статусы/флаги

- **Per-asset** (`scene-state.js:19-27`): `NEW → DIRTY → PENDING → GENERATING → READY / FAILED / PLACEHOLDER`.
- **audio-orch PHASES**: `PLACEHOLDER_READY → GENERATING → WAITING_CHUNKS → MERGING → DONE` (+ FAILED).
- **video-orch PHASES**: `GENERATING → WAITING_CHUNKS → MERGING → DONE` (+ FAILED).
- **Hub claim**: job в `animastor:running` (с полями job_id, dispatch_id, assets, build_id, started_at). Нет полей delivered/cleaned.
- **Hub result key** `animastor:result:*` — единственный «delivered-аналог», но по `scene:stage`, не по job.

**Флагов `delivered`/`cleaned`/`acknowledged` на уровне worker/job НЕТ нигде.**

## 3. Lifecycle image/audio/video job (end-to-end)

```
backend dispatch-engine → gpu-dispatcher.sendUnified → hub /task (enqueue)
  → worker GET /task/next (rpoplpush → processing → running)
  → worker сохраняет reference images в ComfyUI input  (image/video; audio — нет)
  → worker POST /prompt → prompt_id
  → ComfyUI генерирует → output/ (или output/audio, output/video)
  → worker waitResult() → находит meta {filename, subfolder}
  → worker downloadResult() → читает файл локально → base64
  → worker POST /task/result (hub)
      hub: пишет animastor:result:*  (→ ПЕРВЫЙ "durable" снапшот результата)
      hub: удаляет из running/processing
      hub: forwards в backend /gpu/task/result (best-effort, 5 retry)
        backend: verifyDispatchIdentity → dedup → handleTaskResult
                 → пишет файл в /data/output/{build}/... → completeStage → asset READY + PG ready
  → worker получает HTTP 200 от hub → (b860162) finally удаляет input+output
```

## 4. Ключевое: моменты GENERATED / DELIVERED

- **GENERATED**: когда `waitResult` нашёл output-файл в ComfyUI (файл существует на диске worker). Официального маркера нет — сигнал только файловый/локальный.
- **DELIVERED (worker-перспектива)**: когда `POST /task/result` вернул HTTP 200.
  **ВАЖНО**: hub пишет `animastor:result:*` в Redis **ДО** ответа 200 (`gpu-hub.js:888-894` → `:961`). То есть момент 200 = результат **уже durable в hub Redis** (полный base64, TTL 1ч) — даже если forward в backend потом упадёт (hub вернёт 200 и при таком сценарии, полагаясь на `recoverResultKeys`).
- **DELIVERED (backend-перспектива)**: `animastor:result-processed:{dispatch}:{job}:{build}` (dedup, EX 3600) + файл на диске + `scene_assets.status='ready'`.
- **Подтверждение доставки существует**: worker не имеет доступа к этим ключам (нет Redis). Worker видит только HTTP 200 от hub.

**Вывод по п.5**: достоверно сказать «постоянный результат сохранён, ComfyUI output можно удалять» можно, когда hub вернул 200 `/task/result` — т.к. в этот момент hub уже держит полный base64 в `animastor:result:*`. Это и есть граница безопасности.

## 6. Существующие recovery/reconciliation

- `reconcileCycle()` (`reconciliation-engine.js:1256`): **единый цикл** с распределённым `animastor:cleanup-lock`. Фазы: A=recoverResultKeys (сканирует `animastor:result:*` → повторно вызывает `handleTaskResult`), B1/B2=watchdog застрявших audio/video, C=startup-фазы (audio/video orch recovery, version staleness, worklist rebuild), D=полная сверка сцен + auto-fix. Вызывается при старте и периодически (60s).
- Это **backend-сторонний** механизм. Он покрывает «результат доставлен в hub Redis, но backend не получил» — НЕ покрывает «worker не удалил ComfyUI temp-файлы».
- **Расширять его под cleanup на стороне worker нельзя напрямую** — reconcile живёт в backend-процессе, а ComfyUI файлы — на хосте worker. Локальный файл worker недоступен backend'у.

## 7. Redis vs DB

- Состояние cleanup должно быть видно **worker-процессу** (кто выполняет удаление). Worker не имеет ни Redis, ни PG.
- Hub Redis переживает restart (persisted volume), но: (а) worker в него не ходит; (б) result-ключи TTL 1ч.
- DB (`scene_assets`) — сцена-уровень, не job-уровень, и тоже недоступна worker.
- **Вывод**: новое «orchestration state» для cleanup должно жить **на диске worker** (persistent per `SYSTEM.md` §1: весь `~/` переживает перезагрузки инстанса). Это единственное хранилище, доступное процессу, который удаляет файлы.

## 8. Идемпотентность

Уже обеспечена реализацией b860162: `safeUnlink` трактует `ENOENT` как успех. Повторный cleanup = no-op. Журнал (ниже) должен быть идемпотентным: повторная запись `cleaned` или удаление записи безвредны.

## 9. Race conditions

- **Один процесс на хост**: при restart старый процесс мёртв → конкуренции нет. Если supervisor поднял новый worker, пока старый жив (кратко) — защита: recovery-прогон обрабатывает только записи с `phase=delivered` (которые ставит ТОЛЬКО тот процесс, который получил 200 от hub) + age-guard (не трогать записи младше N секунд).
- **Два worker на одной машине** (image+video) делят один ComfyUI: имена файлов уникальны по job_id (`baseId`/`scenePrefix`), пересечений нет.
- **Повторный dispatch той же job** (hub requeue): input-файлы пересоздаются из `task.assets` (они хранятся в claim) — удаление старых input безопасно.

## 10. Video

- Одна сцена = N reference images в input (по одному на IU) + 1 output mp4.
- Все N input-путей записываются в `createdInputFiles[]` (уже так в b860162).
- Output = ровно тот mp4, который выбрал `waitResult` (history / fallback / fs-scan) — meta уже несёт точный `{filename, subfolder}`.
- Журнал должен хранить **список всех input-путей + один output-путь**.

---

# Предлагаемая модель lifecycle

```
CREATED   → worker записал input-файлы в ComfyUI input (и записал журнал)
GENERATED → waitResult нашёл output в ComfyUI output
DELIVERED → sendResult вернул 200 (hub durable записал animastor:result:*)
CLEANED   → temp-файлы удалены, журнал финализирован
```

Модель **не вводит новых backend-статусов** — она worker-локальная и надстраивается над уже существующим сигналом доставки (HTTP 200 от hub = durable результат в hub Redis).

## A. Где хранить состояние cleanup
**Worker-local journal** на persistent-диске хоста: каталог/файл рядом с worker.cjs, напр. `~/animastor/cleanup-journal/` с одной записью на job (JSON sidecar-файл). Живёт дольше worker-процесса и переживает restart. Не зависит от Redis/PG.

Запись:
```json
{ "job_id": "...", "dispatch_id": "...", "phase": "delivered",
  "input_files": [".../input/base_iu1.png", "..."],
  "output_file": ".../output/video/LTX-2_00001_.mp4",
  "created_at": 0, "updated_at": 0 }
```

## B. Как связать состояние с путями
Имена уже привязаны к job_id: input = `${baseId}.png` / `${scenePrefix}_{unitId}.png`; output = `COMFY_OUTPUT_DIR + subfolder + filename`. Журнал хранит **абсолютные пути** (те же, что в `createdInputFiles[]` / `outputPath` из b860162). Никаких glob/prefix-удалений.

## C. Когда выставлять delivered
Сразу после того как `sendResult()` вернул успех (HTTP 200), **синхронно записать журнал `phase=delivered` + fsync**. Окно «hub принял → worker записал» = миллисекунды; при падении в этом окне запись остаётся `created`/`generated` → файл НЕ удалится (безопасная утечка, не потеря данных).

## D. Когда выставлять cleaned
После фактического удаления всех input-файлов + output-файла (уже в `finally` из b860162) → пометить `cleaned` (или удалить sidecar). Чистка файлов и запись `cleaned` идемпотентны.

## E. Что делать при worker crash
- **До delivered**: журнал в `created`/`generated`. При recovery input-файлы можно удалить всегда (пересоздаются из task.assets при re-dispatch), output — НЕ трогать (нет подтверждения доставки; это единственная копия).
- **После delivered, до cleaned**: журнал = `delivered` → recovery удаляет input+output и ставит `cleaned`. Это и есть целевой сценарий задачи.

## F. Что делать при worker restart
При старте (после `waitForComfyUI`, до `workerLoop`) прогнать `recoverCleanupJournal()`:
- `cleaned` → удалить запись (no-op).
- `delivered` → удалить файлы, пометить `cleaned`.
- `created`/`generated` → удалить input-файлы; output не трогать (безопасно). Опционально: спросить hub о доставке, чтобы закрыть окно «hub принял, но журнал не успел».

## G. Повторный cleanup
Безопасен: `safeUnlink` ENOENT→ok; `phase=cleaned` → skip. Журнал идемпотентен.

## H. Как избежать удаления файлов активной job
- Recovery обрабатывает только записи журнала (которых нет у активной job — она создаёт запись при старте и держит до очистки).
- Age-guard: не обрабатывать записи младше ~60s (страховка от живого старого процесса).
- `dispatch_id` в записи → recovery не тронет job, если dispatch_id не совпадает с терминальным состоянием.
- Никаких «удалить по prefix/возрасту всё в input/output» — только явные пути из журнала.

## I. Orphan-файлы без orchestration state
Для файлов без записи журнала (старый воркер до внедрения, потеря журнала) — **возрастной sweep по собственному паттерну имён worker'а** (имя содержит `baseId` из job_id) с консервативным порогом (например, >24ч), и только если файл не в активном `animastor:running`/`processing` (проверка через hub). Это отдельная опция; безопаснее начать с журнала, а orphan-sweep включить позже.

---

# Краткая рекомендация

Предлагаю внедрить **worker-local cleanup journal** (создаваемая/обновляемая синхронно с lifecycle, хранится на persistent-диске worker'а, идемпотентная) поверх уже существующего сигнала доставки — **HTTP 200 от hub `/task/result`**, который в этот момент уже гарантированно содержит durable копию результата в hub Redis (`animastor:result:*`). Это:
- не требует правок backend/PG/Redis моделей (никаких новых флагов в существующей оркестрации);
- переживает и worker-restart, и Redis-restart;
- закрывает целевой сценарий (delivered=true, cleaned=false → cleanup при старте) и безопасно деградирует в утечку (не потерю) в обратном окне;
- использует готовые примитивы b860162 (`cleanupJobArtifacts`, `createdInputFiles[]`, `outputPath`, `safeUnlink`), расширяя их журналом и `recoverCleanupJournal()` на старте;
- единственное новое звено, если нужно закрыть окно «hub принял → журнал не успел», — лёгкий hub-эндпоинт `GET /task/status` (опционально).

Почему не Redis/PG для этого состояния: worker — единственный процесс, имеющий доступ к ComfyUI-файлам, а он не имеет доступа к Redis/PG; существующие backend-механизмы (reconcileCycle, audio-recovery) лечат «результат в hub Redis, но не в backend» и не видят файлы на хосте worker. Поэтому состояние cleanup должно принадлежать worker'у и лежать на его диске.
