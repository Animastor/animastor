# JOB PROTOCOL V2 — Contract Freeze (Phase 9A)

**Status:** CURRENT / FROZEN
**protocol_version = 2** (int, не менять в рамках Phase 9)
**Date:** 2026-09-06
**Baseline:** HEAD `019bd843` (Phase 9 readiness audit)
**Parent plan:** `PHASE_9_WORKER_EXTRACTION_READINESS_AUDIT.md` §7 (Phase 9A)
**Правило фазы:** только фиксация существующего фактического поведения. Ни
одного изменения production-кода, endpoints, auth, Redis, timeout-значений или
payload-формата.

Маркеры, используемые в документе:

- **[NORMATIVE — FROZEN]** — часть контракта, зафиксированная этим документом
  как есть (существующее поведение, объявленное контрактом без изменений).
- **[CURRENT BEHAVIOR]** — поведение, которое существует фактически в коде,
  но не было явно спроектировано как гарантия. Зафиксировано как есть;
  ослабить или усилить без процедуры versioning policy (§5) нельзя.
- **[IMPLEMENTATION DETAIL]** — внутренности, НЕ являющиеся частью wire-контракта.
- **[KNOWN LIMITATION]** — известное ограничение / асимметрия; фиксируется,
  не исправляется в Phase 9A.

---

## 1. Область действия

Протокол описывает передачу генерационных задач по цепочке:

```
backend (orchestrator/dispatcher)
    │  POST {HUB_URL}/task                       (api-key)
    ▼
GPU Hub (очереди, claim/lease/timeout sweep, auth mirror)
    │  GET /task/next                            (Bearer worker credential)
    ▼
Worker (ComfyUI execution)
    │  POST /task/result  |  POST /task/error    (Bearer worker credential)
    ▼
GPU Hub
    │  POST {BACKEND_URL}/gpu/task/result|error  (api-key)
    ▼
backend (generation-routes)
```

Область: **backend → GPU Hub → Worker → (result/error) → Hub → backend**.
Beacon-канал (`POST /beacon`, worker → hub) входит в протокол. Redis-контракт
hub ↔ backend (key families, `drainPolicyLane`, registry `hdel`) в этот
контракт НЕ входит — это отдельный (hub-extraction) scope.

## 2. Source of truth (canonical implementation)

**`contracts/src/job-protocol-v2.js` (npm-пакет `@animastor/contracts`) —
canonical implementation Job Protocol v2** (Phase 9C; до этого de-facto
canonical был `backend/src/runtime/job-schema.js`):

- `PROTOCOL_VERSION = 2`;
- `JOB_TYPES = ['audio', 'image', 'iu_image', 'video']`;
- `SYSTEM_JOB_TYPES = ['audio', 'image', 'video']` (transport-типы
  scan-очередей hub);
- `STAGE_BY_KIND`;
- `buildJobId / splitJobId / parseJobId / getStageForJobId` — canonical
  job_id grammar;
- envelope-константы и advisory-хелперы (`TASK_ENVELOPE_REQUIRED_FIELDS`,
  `RESULT_ENVELOPE_REQUIRED_FIELDS`, `ERROR_ENVELOPE_REQUIRED_FIELDS`,
  `ERROR_TOKENS`, `validateTaskEnvelopeIdentity`,
  `validateResultEnvelopeIdentity`).

**`backend/src/runtime/job-schema.js`** — compatibility facade,
re-exporting contracts (все backend-импорты сохранены; Phase 9C).

GPU Hub и Worker пока содержат **собственные inline-копии** (миграция на
require контракта заблокирована — см.
`PHASE_9C_CONTRACTS_EXTRACTION_AUDIT.md`; план замены — Phase 9D):

| Копия | Что дублирует | SYNC-якорь |
|---|---|---|
| `gpu-hub/gpu-hub.js:33` (+ повтор `:758`) | `PROTOCOL_VERSION = 2` | `// SYNC: backend/src/runtime/job-schema.js (PROTOCOL_VERSION)` — путь ведёт на backend-facade, реальный источник — contracts |
| `gpu-hub/gpu-hub.js:53` | `SYSTEM_JOB_TYPES = ['audio','image','video']` (без `iu_image` — transport-типы scan-очередей) | — |
| `worker/worker/worker.cjs:49` | `PROTOCOL_VERSION = 2` | комментарии/тесты |
| `worker/worker/worker.cjs:611,625` | inline job_id suffix-split `/(:(iu_image|image|audio|video)$)/` (подмножество grammar — именование input-файлов) | — |

Паритет копий с canonical-пакетом закреплён архитектурными тестами
(`phase2-job-protocol-v2.test.js`, `gpu-hub-contract.test.js`,
`phase9c-contracts.test.js` — cross-side contract test). До замены копий на
require контракта (Phase 9D) пакет `@animastor/contracts` — единственный
authoritative reference для имплементации протокола.

## 3. Normative contract

### 3.1 protocol_version

- Значение: `2`, integer literal, присутствует во всех трёх компонентах
  (canonical `contracts/src/job-protocol-v2.js`, `gpu-hub.js:33`,
  `worker.cjs:49`). **[NORMATIVE — FROZEN]**
- Передаётся в: task payload (backend→hub→worker), beacon (worker→hub),
  result/error (worker→hub), hub→backend callbacks (hub добавляет своё
  значение `PROTOCOL_VERSION`).
- Все три компонента отклоняют несовпадающую версию (см. §3.15).
- Mixed-version rollout не поддерживается: изменение версии требует
  остановки выдачи задач старым worker'ам до bump
  (комментарий в canonical `contracts/src/job-protocol-v2.js`).
  **[NORMATIVE — FROZEN]**

### 3.2 Job envelope (backend → hub → worker)

POST /task body (автор всех полей — backend):

| Поле | Статус | Валидация hub | Потребление worker |
|---|---|---|---|
| `protocol_version` | обязателен | `!== 2` → 409 `protocol_version_mismatch` (`:759`) | `!== 2` или нет → reject задачи (`worker.cjs:580-591`) |
| `dispatch_id` | обязателен | отсутствует → 400 `incomplete_dispatch_identity` (`:766`) | обязателен (`worker.cjs:580`) |
| `build_id` | обязателен | отсутствует → 400 `incomplete_dispatch_identity` | используется в result/error |
| `book_id` | обязателен | отсутствует → 400 `incomplete_dispatch_identity` | **игнорируется** |
| `chapter_id` | обязателен | отсутствует → 400 `incomplete_dispatch_identity` | **игнорируется** |
| `scene_id` | обязателен | отсутствует → 400 `incomplete_dispatch_identity` | **игнорируется** |
| `stage` | обязателен | отсутствует → 400 `incomplete_dispatch_identity` | **игнорируется** |
| `job_id` | обязателен (backend-сторона) | hub НЕ валидирует наличие **[CURRENT BEHAVIOR]** | обязателен — именование input-файлов |
| `job_type` | обязателен (backend-сторона) | hub НЕ валидирует; по умолчанию `"image"` при отсутствии **[CURRENT BEHAVIOR]** (`:738`) | **игнорируется** (worker использует свой `WORKER_TYPE`) |
| `params` | обязателен (backend-сторона) | hub НЕ валидирует **[CURRENT BEHAVIOR]** | обязателен — ComfyUI workflow JSON |
| `assets` | optional | pass-through | optional: `{image: base64}` или `{images: {[unitId]: base64}}` |
| `workspace_id` | optional | shape-UUID (`:772`), null = system pool | **игнорируется** |
| `policy_id` | optional | shape-UUID (`:781`), XOR с `workspace_id` → иначе 400 `invalid_policy_routing` | **игнорируется** |
| `timeout_ms` | optional | clamp-семантика, см. §3.17 | см. §3.17 |

- Hub-валидация обязательности: `dispatch_id, build_id, book_id, chapter_id,
  scene_id, stage, protocol_version` — это и есть формальный required-набор
  со стороны hub (`gpu-hub.js:766`). Полноту envelope (job_id, job_type,
  params) фактически гарантирует backend-dispatcher (`sendUnified`,
  `gpu-dispatcher.js:135-149`), а не hub. **[CURRENT BEHAVIOR]**
- В очередь (`lpush`) и в `/task/next` ответ идёт реконструированный объект
  только из известных полей (`gpu-hub.js:810-847`): `job_id, params,
  job_type, assets, build_id, protocol_version, book_id, chapter_id,
  scene_id, stage, dispatch_id, workspace_id, policy_id, timeout_ms`.
  Unknown-поля envelope до worker НЕ доходят через очередь. **[CURRENT BEHAVIOR]**

### 3.3 job_id grammar

Формат: **`${assetId}:${type}`** — canonical
`contracts/src/job-protocol-v2.js` (`@animastor/contracts`; backend
потребляет через facade `backend/src/runtime/job-schema.js`):

```
audio-чанк:     {bookId}_{chapterId}_{sceneId}_{NNNN}:audio    (NNNN = pad(4), /^\d{4}$/)
IU-изображение: {bookId}_{chapterId}_{sceneId}_{iuId}:iu_image
scene image:    {bookId}_{chapterId}_{sceneId}:image           (legacy; assetId с '_iu'
                                                                = IU-изображение старого формата)
видео:          {bookId}_{chapterId}_{sceneId}[_gN]:video      (_gN = группа, /^_g\d+$/)
```

- `bookId` может содержать `_`; `chapterId`, `sceneId`, `chunkIndex`, `iuId`
  — не могут, поэтому разбор всегда идёт **с конца**
  (`splitJobId`: `lastIndexOf(':')` + членство в `JOB_TYPES`;
  `parseJobId` — поп-парсинг частей).
- Канонические операции: `buildJobId(assetId, type)` (валидует type ∈
  JOB_TYPES), `splitJobId` (suffix-only), `parseJobId` (полный разбор →
  `{kind, type, assetId, bookId, chapterId, sceneId, chunkIndex|iuId|groupSuffix}`,
  null для нераспознаваемых id), `getStageForJobId`.
- Worker не парсит полный grammar — только suffix-split regex-литералом
  `/:(iu_image|image|audio|video)$/` (`worker.cjs:611,625`) для именования
  input-файлов. Hub job_id не парсит вовсе (поля book/chapter/scene/stage
  приходят в envelope из §3.2). **[CURRENT BEHAVIOR]**
- Все job types, включая `iu_image`, закреплены в canonical `JOB_TYPES`
  (`contracts/src/job-protocol-v2.js`) и в архитектурных тестах.

### 3.4 job_id vs job_type vs stage (тройная идентичность)

Три разных «типа» в одном протоколе — самая частая точка путаницы:

| Идентичность | Домен | Где живёт | Пример для IU-изображения |
|---|---|---|---|
| `job_id` suffix (asset type) | `audio, image, iu_image, video` | суффикс job_id; canonical `JOB_TYPES` | `...:iu_image` |
| `job_type` (transport type) | `audio, image, video` | envelope; hub-очередь `queue:{job_type}...`; `SYSTEM_JOB_TYPES` (`gpu-hub.js:53`); dispatcher `validTypes` (`gpu-dispatcher.js:139`) | `image` |
| `stage` | `audio, image, video` | envelope; result-key; canonical `STAGE_BY_KIND` (`contracts/src/job-protocol-v2.js`) | `image` |

- `iu_image` — **asset-type в job_id**, но транспортно ходит как
  `job_type = 'image'`, `stage = 'image'`
  (`iu-processor.js:279-286` → `sendUnified` с `'image'`). **[CURRENT BEHAVIOR]**
- Hub scan-очереди знают только `SYSTEM_JOB_TYPES = ['audio','image','video']`
  — `iu_image` в очередь как отдельный type не попадает никогда.

### 3.5 build_id

- Автор: backend. Dispatcher проставляет дефолт `build_id || "default"`
  (`gpu-dispatcher.js:183`). **[CURRENT BEHAVIOR]**
- Обязателен на hub (400 при отсутствии), входит в result/error envelope и
  во все dedup-ключи backend'а:
  `animastor:result-processed:{dispatch_id}:{job_id}:{build_id}`,
  `animastor:error-processed:{dispatch_id}:{job_id}:{build_id}`.
- Hub кладёт в очередь `build_id || null`; null фактически не возникает при
  штатном backend-пути. **[CURRENT BEHAVIOR]**

### 3.6 dispatch_id

- Автор: backend (dispatch-engine). Обязателен на **всех** уровнях:
  backend `sendUnified` бросает ошибку без него (`gpu-dispatcher.js:143-145`),
  hub 400, worker reject задачи без него (`worker.cjs:580`).
- Семантика: claim/staleness/dedup.
  - Hub хранит dispatch_id в running-record; result/error с чужим dispatch_id
    → 409 `stale_or_unknown_dispatch` (`gpu-hub.js:1074-1077, 1216-1219`).
  - Backend re-verifies dispatch identity на callback'ах
    (`verifyDispatchIdentity`, `generation-routes.cjs:1375+`); неуспех →
    `{ok:true, rejected:true, reason}`. Исключение (CURRENT BEHAVIOR):
    `stale_dispatch` для stage audio/video **принимается**, пока сцена в
    `WAITING_CHUNKS/MERGING` (`generation-routes.cjs:1391-1399`).
  - Hub освобождает queue-dedup ключ при error/timeout, чтобы re-dispatch
    backend'а не отбивался как duplicate (`gpu-hub.js:1237, 530`).

### 3.7 book_id / chapter_id / scene_id

- Автор: backend (производные от `parseJobId`). Обязательны со стороны hub
  (§3.2). Используются hub'ом для result-key
  (`animastor:result:{build_id}:{book_id}:{chapter_id}:{scene_id}:{stage}`,
  `gpu-hub.js:1107`) и running-record.
- Worker их **игнорирует** — worker-side envelope knowledge ограничено
  `job_id, build_id, dispatch_id, params, assets, timeout_ms,
  protocol_version`. **[CURRENT BEHAVIOR]**

### 3.8 workspace_id / policy_id

- **Backend-authored ONLY** (PW-2 / SH-2):
  - `workspace_id` = book → workspace (private lane), `null` = system pool
    (`gpu-dispatcher.js:159-189`);
  - `policy_id` = users-policy lane stamp; клиентское значение всегда
    стрипается dispatcher'ом (`policy_id: undefined`, `:181`).
- Hub: shape-валидация UUID (`WORKSPACE_ID_RE`, `gpu-hub.js:185, 772, 781`),
  взаимное исключение (400 `invalid_policy_routing`).
- Routing: `queue:{type}:ws:{workspace_id}` / `queue:{type}:policy:{id}` /
  `queue:{type}` (system pool) — lane priority при pop. **[IMPLEMENTATION DETAIL]**
- В hub→backend callbacks передаются как **audit-only** (`worker_id`,
  `workspace_id`); backend никогда им не доверяет — re-verifies
  job→book→workspace сам (`generation-routes.cjs:1365+`).

### 3.9 params / assets

- `params` — ComfyUI workflow JSON (объект graph с node-идентификаторами).
  Автор — backend (workflow-loader). Hub pass-through без валидации.
  Worker передаёт как есть в ComfyUI (`runWorkflow`, `worker.cjs:320`).
- `assets` — optional:
  - `assets.image`: строка base64 (или data-URI; worker стрипает префикс
    до `,` — `saveBase64ImageSafe`, `worker.cjs:277-279`) — единственное
    reference-изображение;
  - `assets.images`: map `{[unitId]: base64}` — multi-image (IU-наборы).
- Именование input-файлов worker'а: из `job_id` (§3.3) + `unitId`:
  `{jobBase}.png` / `{scenePrefix}_{unitId}.png`. **[CURRENT BEHAVIOR]**

### 3.10 Result envelope (worker → hub → backend)

worker → `POST /task/result`:

| Поле | Статус |
|---|---|
| `job_id` | обязателен (400 `invalid`) |
| `build_id` | обязателен |
| `dispatch_id` | обязателен |
| `protocol_version` | `!== 2` → 400 `invalid` |
| `result_base64` | обязателен; data-URI `data:<mime>;base64,<...>` |
| `worker_version`, `worker_image_tag` | extra-поля worker'а; hub игнорирует **[CURRENT BEHAVIOR]** |

Hub: проверяет running-record (409 `stale_or_unknown_dispatch`) и
claimer-identity (403 `not_task_claimer`); пишет Redis
`animastor:result:{build_id}:{book_id}:{chapter_id}:{scene_id}:{stage}`,
EX 3600 (1h); удаляет running/processing записи; форвардит в backend
`POST /gpu/task/result` с `worker_id`, `workspace_id` (audit-only).

Backend callback (`generation-routes.cjs:1340`): валидация набора
`job_id, result_base64, build_id, dispatch_id, protocol_version` (400),
`parseJobId` (400 `invalid job_id`), workspace re-verify (403),
dispatch identity (rejected/stale-accept, §3.6), dedup
`animastor:result-processed:...` EX 3600, затем `handleTaskResult`.

HTTP 200 от hub на `/task/result` = результат уже durable в hub Redis
(ключ записан до ответа). **[NORMATIVE — FROZEN]**

### 3.11 Error envelope (worker → hub → backend)

worker → `POST /task/error`:

| Поле | Статус |
|---|---|
| `job_id` | обязателен (400 `invalid`) |
| `build_id` | обязателен (worker шлёт `task.build_id || null`) |
| `dispatch_id` | обязателен |
| `protocol_version` | `!== 2` → 400 `invalid` |
| `reason` | строка; worker truncate до 500 символов, default `"worker_error"` (`worker.cjs:549`) |
| `worker_version`, `worker_image_tag` | extra-поля; hub игнорирует **[CURRENT BEHAVIOR]** |

Hub: те же claim/staleness проверки (409/403); освобождает queue-dedup;
форвардит в backend `POST /gpu/task/error` → `orchestrator.failStage`.
Backend dedup `animastor:error-processed:...` EX 60 (короткий).

### 3.12 Beacon envelope (worker → hub)

`POST /beacon` body:

| Поле | Статус |
|---|---|
| `id` | label only — identity из credential **[NORMATIVE — FROZEN]** |
| `type` | label only — тип из registry-credential |
| `gpu` | имя GPU (информационное) |
| `vram` | VRAM (информационное) |
| `version` | worker bundle version (`WORKER_VERSION`) |
| `image_tag` | docker image tag или null |
| `protocol_version` | `!== 2` → 409 `protocol_version_mismatch` |

Эффект: обновление GPU-registry (TTL 15 мин) + heartbeat-ключ
`animastor:worker:heartbeat:{type}:{worker_id}` EX 30. Интервал beacon —
`BEACON_INTERVAL_MS` (default 10000) — **[IMPLEMENTATION DETAIL]**.

### 3.13 HTTP endpoints

Пять endpoints контракта (pinned `gpu-hub-contract.test.js:35-42`):

| Endpoint | Caller → Hub | Auth | Назначение |
|---|---|---|---|
| `POST /beacon` | worker → hub | Bearer worker credential | liveness + registry + heartbeat |
| `POST /task` | backend → hub | `x-api-key` | постановка задачи в очередь |
| `GET /task/next?worker=&type=` | worker → hub | Bearer worker credential | pop задачи (claim) |
| `POST /task/result` | worker → hub | Bearer worker credential | успешный результат |
| `POST /task/error` | worker → hub | Bearer worker credential | ошибка задачи |

Продолжение цепочки (hub → backend, входят в protocol surface):

- `POST {BACKEND_URL}/gpu/task/result` — `x-api-key` +
  `requireHubCallbackAuth` (`generation-routes.cjs:50, 1340`);
- `POST {BACKEND_URL}/gpu/task/error` — аналогично (`:1437`).

Коды ответов (current, frozen):

- `/task`: 200 `{ok:true}` | `{ok:true,duplicate:true}`; 400
  `incomplete_dispatch_identity` / `invalid_workspace_id` /
  `invalid_policy_id` / `invalid_policy_routing`; 401 unauthorized; 409
  `protocol_version_mismatch`; 503 `hub_api_key_not_configured`.
- `/task/next`: 200 `{task}` | `{task:null}`; 400 `worker required`; 401;
  404 `not registered`; 409 `worker_type_mismatch` /
  `worker_protocol_mismatch`.
- `/task/result`, `/task/error`: 200 `{ok:true}`; 400 `invalid`; 403
  `not_task_claimer`; 409 `stale_or_unknown_dispatch`.
- `/beacon`: 200 `{ok:true}`; 400 `worker_identity_required`; 401; 409
  `protocol_version_mismatch`.
- backend `/gpu/task/result`: 200 `{ok:true}` | `{ok:true,rejected:true,reason}`
  | `{ok:true,deduped:true}`; 400 validation; 403 workspace; 500 internal.
- backend `/gpu/task/error`: 200 `{ok:true}` | `{ok:true,ignored:true}` |
  `{ok:true,rejected:true,reason}` | `{ok:true,deduped:true}`; 400/403.

### 3.14 Authentication

- **Worker → hub:** `Authorization: Bearer wrk.<worker_id_b64>.<secret>`
  (b64url-части; `wrk.<worker_id_b64url>.<secret_b64url>`, hub
  `parseWorkerToken` проверяет UUID worker_id и SHA-256 секрет против Redis
  auth-mirror — `gpu-hub.js:59-100`). **Header-only**: токен никогда не
  принимается в query/body (`extractBearerToken`, `:87`). Fail-closed: 401
  при отсутствии/невалидности. Worker без `ANIMASTOR_WORKER_TOKEN`
  **отказывается стартовать** (`worker.cjs:709-720`); 401/403 от hub/backend
  → terminal `process.exit(1)` (`authFailed`, `:103-108`).
- **Backend → hub:** `x-api-key` header (`GPU_HUB_API_KEY`); unset ключ →
  503 fail-closed, явный dev-only opt-out `GPU_HUB_ALLOW_OPEN=1`
  (`gpu-hub.js:272-286`). Тоже header-only.
- **Hub → backend:** `x-api-key` (`backendHeaders`, `:289-293`) + backend
  `requireHubCallbackAuth`.
- Identity **всегда** из credential (PW-4): `worker`/`type` query-параметры
  и body-поля — labels only, валидируются против registry/mirror, никогда не
  являются источником идентичности. **[NORMATIVE — FROZEN, security invariant]**

### 3.15 Protocol mismatch behavior

| Точка | Поведение при `protocol_version !== 2` |
|---|---|
| hub `POST /task` | 409 `protocol_version_mismatch` `{expected, received}` (`:759`) |
| hub `POST /beacon` | 409 `protocol_version_mismatch` (`:679`) |
| hub `GET /task/next` | 409 `worker_protocol_mismatch` (registry-версия worker'а, `:889`) |
| hub `POST /task/result`, `/task/error` | 400 `invalid` (трактуется как битый payload, `:1057, :1205`) |
| backend `/gpu/task/result`, `/gpu/task/error` | 400 validation error (`generation-routes.cjs:1346, :1445`) |
| worker (полученная задача) | reject: лог `Rejecting incompatible task`, отправка `sendTaskError` c reason `incompatible_task_protocol:<v>` (если идентификаторы есть), задача пропускается (`worker.cjs:580-591`) |

Смешанные версии одновременно не поддерживаются ни в одном направлении
(см. §3.1, §5).

### 3.16 Retry semantics

- **Worker HTTP-вызовы** — single-shot на вызов (AbortController 30s
  default, `fetchTimeout` `worker.cjs:77`); auth-отказ терминален (§3.14).
  Ошибка `sendResult`/`sendTaskError` НЕ ретраится внутри job — job
  завершается ошибкой (`worker.cjs:661-667`). Poll-цикл `/task/next`:
  backoff `TASK_SLEEP_MS` (2s) с удвоением до 15s на пустой очереди/ошибке,
  сброс при получении задачи. **[CURRENT BEHAVIOR / IMPLEMENTATION DETAIL]**
- **Hub → backend result** (`gpu-hub.js:1153-1180`) и **error**
  (`notifyBackendError`, `:395-437`): 5 попыток с паузой 500ms. При
  недоставке результата Redis-ключ `animastor:result:*` (1h) остаётся — его
  подберёт recovery (`reconciliation-engine` scan `animastor:result:*`,
  `animastor:error:*`); при недоставке ошибки — fallback-ключ
  `animastor:error:{job_id}` EX 3600.
- **Job-level retry** — backend-owned: dispatch-lease/scheduler re-dispatch.
  Hub при timeout/error освобождает queue-dedup ключ, backend при
  форсированном re-dispatch пречищает `result-processed` dedup (например
  `iu-processor.js:271, 303`). Hub-level orphan sweep возвращает в очередь
  записи processing без running-record (cap requeues → dead-letter
  `orphan_requeue_limit` + `notifyBackendError('orphaned_task')`).
  **[IMPLEMENTATION DETAIL]**
- **Stale dispatch acceptance** — backend принимает поздние результаты
  audio/video со старым dispatch_id, пока сцена в
  `WAITING_CHUNKS/MERGING` (§3.6). **[CURRENT BEHAVIOR]**

### 3.17 Timeout semantics (`timeout_ms`)

Три уровня одного поля. Значения НЕ меняются Phase 9A.

**Кто устанавливает:**

- **backend (автор):** `sendUnified` —
  `timeout_ms = taskSpec.timeout_ms ?? DEFAULT_TYPE_TIMEOUT_MS[job_type]`
  (`gpu-dispatcher.js:152-157`); дефолты: audio 30 мин, image 30 мин,
  video 60 мин (`:125-129`). Единственный штатный explicit-источник сейчас —
  video-dispatch: layer-config `video_timeout_minutes` →
  `jobSpec.timeout_ms` (`scene-orchestrator.js:334-341, 457-458`).
  **[CURRENT BEHAVIOR]**
- **hub (clamp):** в очередь пишется
  `timeout_ms > 0 ? Math.max(Number(timeout_ms), GPU_TIMEOUT_MS) : null`
  (`gpu-hub.js:843-845`). Floor = `GPU_TIMEOUT_MS` (default 600000 = 10 мин;
  env `GPU_TIMEOUT_MS`/`GPU_TIMEOUT`). Per-job timeout **никогда** не бывает
  ниже floor. **[NORMATIVE — FROZEN]**
- **worker (consumer):** `waitResult(prompt_id, workflow, task.timeout_ms)` —
  `effectiveTimeoutMs = task.timeout_ms || (isVideo ? VIDEO_RESULT_TIMEOUT_MS
  : RESULT_TIMEOUT_MS)` (`worker.cjs:355-359`); дефолты RESULT_TIMEOUT_MS
  600000 (10 мин), VIDEO_RESULT_TIMEOUT_MS 7200000 (2 ч), env-overridable
  (`:51-57`). **[NORMATIVE — FROZEN]**

**Что делает backend:** per-job `timeout_ms` — это бюджет генерации;
backend-side watches: `STALL_FAILSAFE_MS = GPU_TIMEOUT_MS * 3`,
`LEASE_TTL_S.AUDIO = ceil(STALL_FAILSAFE_MS/1000) + 60` (runtime-config.js),
инвариант `GPU_TIMEOUT_MS < STALL_FAILSAFE_MS < LEASE_TTL_S.AUDIO * 1000`.
Реального потолка длительности видео — dispatch-lease backend'а.
**[IMPLEMENTATION DETAIL]**

**Что делает hub:** timeout sweep (Level 1 per-job): job в running-record,
для которого `now - started_at > (data.timeout_ms || GPU_TIMEOUT_MS)` —
удаляется из running/processing, освобождается queue-dedup, backend
уведомляется reason `worker_timeout` (`gpu-hub.js:509-535`). Level 2
per-GPU: worker с `last_seen > GPU_TIMEOUT_MS` считается протухшим; его
незавершённые jobs получают тот же `worker_timeout` flow (`:536-568`).

**Что делает worker:** polling ComfyUI до `effectiveTimeoutMs`; по
истечении — ошибка job → `sendTaskError` → hub → backend
`failStage`. **[CURRENT BEHAVIOR]**

**Fallback/defaults сводка:**

| Уровень | Fallback | Значение |
|---|---|---|
| dispatcher | `DEFAULT_TYPE_TIMEOUT_MS[job_type]` | audio/image 30 мин, video 60 мин |
| hub queue | `timeout_ms > 0 ? max(timeout, GPU_TIMEOUT_MS) : null` | floor 600000 (10 мин) |
| hub sweep | `data.timeout_ms || GPU_TIMEOUT_MS` | 600000 |
| worker | `task.timeout_ms || (video ? 7200000 : 600000)` | 600000 / 7200000 |

**Где ограничения:** env — `GPU_TIMEOUT_MS`/`GPU_TIMEOUT` (backend
`runtime-config.js:145` и hub `:199, :1988`), `RESULT_TIMEOUT_MS`,
`VIDEO_RESULT_TIMEOUT_MS` (worker `:51, :57`).

**Known contract detail (НЕ исправляется в 9A):**

- Worker video-fallback (2 ч) **больше** backend-дефолта video (60 мин) и
  hub-сгула per-job: hub sweep может убить job как `worker_timeout`, пока
  worker ещё поллит ComfyUI. Фактический потолок видео — lease backend'а.
  **[KNOWN LIMITATION]**
- `RESULT_TIMEOUT_MS` worker'а (600000) совпадает с `GPU_TIMEOUT_MS` по
  значению, но это coincidence, а не общий constant. **[KNOWN LIMITATION]**
- Три уровня таймаута одного поля — задокументированная, но не единая
  семантика; future contract cleanup (v3 material, §5).

### 3.18 Cancellation semantics

**Явного cancellation-канала в v2 НЕТ.** **[NORMATIVE — FROZEN]**

- Worker не получает stop-сигнала; протокольного сообщения «отмени задачу»
  не существует.
- Отмена = одна из: backend lease expiry + re-dispatch (backend-owned),
  hub timeout sweep (`worker_timeout`, §3.17), либо поздний результат
  отбрасывается backend'ом по dispatch identity (`rejected:true`, §3.6) —
  в т.ч. stale-accept окно для audio/video.
- Backend-внутренние abort-механики (in-flight markers, drain lanes) — не
  часть wire-протокола. **[IMPLEMENTATION DETAIL]**
- Любой настоящий cancel-channel = protocol v3 (§5).

### 3.19 Serialization

- Транспорт: JSON поверх HTTP на всех hop'ах. **[NORMATIVE — FROZEN]**
- Бинарные данные: base64 внутри JSON. `assets.image`/`assets.images` —
  base64 (worker терпит data-URI префикс); `result_base64` — data-URI
  `data:<mime>;base64,<...>` (worker MIME_MAP по расширению файла,
  `worker.cjs:466-471`). **[CURRENT BEHAVIOR]**
- Worker добавляет data-URI префикс сам; hub и backend не парсят mime —
  строка проходит насквозь до `taskHandler.handleTaskResult`.
  **[CURRENT BEHAVIOR]**

### 3.20 Unknown fields behavior

Никто не валидирует строгую схему. **[CURRENT BEHAVIOR, не гарантия]**

- hub `/task` принимает неизвестные поля, но в очередь пишутся только
  известные (rebuild) — до worker они не доходят (`:810-847`).
- hub result/error — деструктурирует известные поля; extra-поля worker'а
  (`worker_version`, `worker_image_tag`) игнорируются.
- backend dispatcher — `...taskSpec` spread: неизвестные поля
  внутреннего spec проходят в POST /task body (`gpu-dispatcher.js:178`).
- worker — деструктурирует только нужное; unknown-поля задачи игнорирует.
- Правило для имплементаторов: **unknown fields должны игнорироваться**;
  полагаться на передачу unknown-полей через очередь нельзя.

### 3.21 Size / payload limits (current)

| Ограничение | Значение | Где |
|---|---|---|
| hub JSON body limit | `500mb` (`express.json`, `gpu-hub.js:266`) | POST /task, /task/result |
| backend JSON body limit | `50mb` (`express.json`, `backend/src/backend.cjs:91`) | hub→backend result/error forwards |
| worker warning для больших output | > 50 MB — warn «base64 will use significant memory» (`worker.cjs:489-491`) | downloadResult |
| `reason` field | truncate до 500 символов (`worker.cjs:549`) | /task/error |
| Redis result TTL | 3600 (1 ч) (`gpu-hub.js:1110-1112`) | `animastor:result:*` |
| Redis error-fallback TTL | 3600 (1 ч) (`gpu-hub.js:426-436`) | `animastor:error:*` |
| hub queue job-dedup TTL | 3600 (1 ч) (`gpu-hub.js:803-810`) | `animastor:job:{dispatch_id}:{job_id}` |
| backend result-processed dedup TTL | 3600 (1 ч) (`generation-routes.cjs:1410`) | `animastor:result-processed:*` |
| backend error-processed dedup TTL | 60 с (`generation-routes.cjs:1488`) | `animastor:error-processed:*` |
| heartbeat TTL | 30 с (`gpu-hub.js:725`) | `animastor:worker:heartbeat:*` |
| GPU registry TTL | 900 (15 мин) (`gpu-hub.js:324`) | registry hash |
| dead-letter TTL | 7 дней (`gpu-hub.js:378`) | `animastor:dead-letter` |

Ни один из лимитов Phase 9A не меняется и не ужесточается.

**Base64 result limitation.** Результат гоняется как base64 внутри JSON:
+~33% к размеру, полная буферизация в памяти на worker, hub и backend.
Совместно с 500mb hub-лимитом и 50mb backend-лимитом это создаёт реальный
OOM/размерный потолок для видео (комментарий протокольного ограничения в
`worker.cjs:459-465`). Замена транспорта — protocol v3 material (§5).
**[KNOWN LIMITATION]**

**Асимметрия лимитов:** hub принимает до 500mb, backend callback — только
50mb: результат >~50MB физически не дойдёт до backend (express 413),
несмотря на приём hub'ом. Worker warn на 50MB — согласован с backend
лимитом. Не фиксируется в 9A. **[KNOWN LIMITATION]**

## 4. Versioning policy

`protocol_version` остаётся **2** на весь Phase 9. Значение меняет только
protocol v3 (§5, координированная замена всех трёх сторон + install-manifests
min_version + тесты).

**Классификация изменений на основе текущего поведения:**

Допустимо внутри v2 (additive, wire-compatible):

- документация, комментарии, переименование внутренних файлов/путей без
  изменения wire-байтов (включая Phase 9C: замена SYNC-копий на contracts
  package — организационное изменение, не протокольное);
- новые **optional** поля, которые старые потребители игнорируют (см. §3.20 —
  поведение «игнорировать unknown» фактическое; зависимость от него — на
  свой риск);
- новые read-only диагностические endpoints/поля ответов, не меняющие
  семантику существующих пяти;
- bugfix'ы, не меняющие wire-формат, коды ответов и grammar.

Требует координированного изменения всех трёх копий (formально v2, фактически
breaking-in-practice — как v3 по дисциплине):

- добавление нового job type: расширяет `JOB_TYPES`, `SYSTEM_JOB_TYPES`,
  dispatcher `validTypes` и worker split-regex; старые field worker'ы
  обработают суффикс некорректно → mixed-version запрещён (§3.1);
- изменение любых дефолтов/пола `timeout_ms` (значения frozen в 9A);
- изменение TTL-значений §3.21 в меньшую сторону.

Breaking (требует protocol v3):

- изменение/удаление/переименование любого required-поля envelope,
  result, error, beacon;
- изменение job_id grammar (`${assetId}:${type}`, suffix-домен, parse-from-end);
- изменение путей/методов/семантики пяти endpoints или auth-схемы;
- изменение кодов ответов/error-токенов существующих условий
  (`protocol_version_mismatch`, `stale_or_unknown_dispatch`,
  `not_task_claimer`, `incomplete_dispatch_identity`, …);
- замена base64 result-транспорта (streaming/binary/ссылки);
- появление явного cancellation-канала;
- снятие любого security invariant §6;
- изменение `protocol_version` (выпуск v3 = bump значения во всех трёх
  компонентах одновременно, после остановки выдачи задач старым worker'ам).

**Version mismatch:** см. §3.15 — reject на каждом hop'е; единого
handshake нет (worker подтверждает версию beacon'ом и каждым вызовом;
registry-проверка на `/task/next`).

## 5. Security invariants (нельзя ослаблять)

1. **Identity только из credential** (PW-4): Bearer-токен, header-only;
   query/body-поля — labels only. Никогда не ослаблять.
2. **Fail-closed worker startup:** без `ANIMASTOR_WORKER_TOKEN` worker не
   стартует; missing credential никогда не молча превращает GPU в
   system/share (`worker.cjs:709-720`).
3. **Fail-closed hub API-key:** unset `GPU_HUB_API_KEY` → 503; только
   явный dev-only `GPU_HUB_ALLOW_OPEN=1` открывает.
4. **Claimer-only result/error:** submitter обязан быть claimer'ом
   (worker + lane match running-record), иначе 403 `not_task_claimer`.
5. **Backend-authored routing:** `workspace_id`/`policy_id` ставит только
   backend; клиентские значения стрипаются; hub только shape-валидация;
   XOR workspace/policy.
6. **Audit-only forwarding:** `worker_id`/`workspace_id` в hub→backend
   callbacks — audit-only; backend re-verifies job→book→workspace (PW-2).
7. **dispatch_id fail-closed:** staleness/identity verification
   (`verifyDispatchIdentity`) — не ослаблять; stale-accept окно
   (audio/video, WAITING_CHUNKS/MERGING) — единственное исключение,
   зафиксировано как CURRENT BEHAVIOR (§3.6).
8. **Terminal auth failures:** 401/403 → worker exit; бесконечный ретрай
   невалидного credential запрещён (`worker.cjs:100-108`).
9. **Poison-write cross-check** на pop + dead-letter — не ослаблять.
10. **Token mirror:** хранится только SHA-256 секрета; формат токена
    `wrk.<worker_id_b64url>.<secret_b64url>` — не менять без v3.

## 6. Implementation details (non-normative)

Не являются wire-контрактом; меняются свободно внутри компонентов:

- Redis key layout hub'а (`animastor:queue:*`, `animastor:processing`,
  `animastor:running`, `job:*` dedup, `worker:heartbeat:*`, registry,
  `worker-auth` mirror, `dead-letter`, `result:*`, `error:*`).
- Hub sweeps: интервалы, orphan requeue caps, poison-check детали.
- Worker internals: cleanup-journal lifecycle (CREATED→GENERATED→DELIVERED→
  CLEANED), ComfyUI polling/fs-scan (`waitResult`), MIME_MAP, OOM-safe local
  read vs HTTP download fallback, empty-queue backoff значения.
- Backend internals: dispatch-lease, scheduler, layer-config, workflow-loader,
  taskHandler.
- Lane priority / SH-1 sharing механика (kill-switch, policy mirrors).
- Env-переменные worker'а (`TASK_SLEEP_MS`, `BEACON_INTERVAL_MS`,
  `WORKER_JOURNAL_DIR`, …) — задокументированы в `worker/worker/.env.example`.

## 7. Known limitations (сводка)

1. Base64 result transport — OOM/размерный потолок (§3.21).
2. Асимметрия hub 500mb ↔ backend 50mb (§3.21).
3. Три уровня `timeout_ms` без единой семантики; video 2h worker-fallback
   против 60 мин backend-дефолта (§3.17).
4. Отсутствие cancellation-канала (§3.18).
5. Нет строгой schema-валидации; unknown-fields поведение — фактическое,
   не гарантированное (§3.20).
6. Hub не валидирует `job_id`/`job_type`/`params` — полноту гарантирует
   только backend-dispatcher (§3.2).
7. Mixed-version rollout не поддерживается; нет handshake, кроме per-call
   проверки версии (§3.15, §4).
8. Triple identity job (`job_id` suffix / `job_type` / `stage`) — источник
   путаницы для имплементаторов (§3.4).
9. End-to-end backend→hub→worker HTTP-loop теста нет (worker в тестах не
   поднимается) — контракта держатся на source-inspection pins
   (Phase 9 audit §9).

## 8. Migration / extraction notes

- Этот документ — published contract, который требует extraction-as-product
  (Phase 9 audit §4.1: «Job Protocol v2 должен стать published contract»).
- **Phase 9C (выполнена)** создала `contracts/` (`@animastor/contracts`,
  НЕ опубликован в registry): constants (`PROTOCOL_VERSION`, `JOB_TYPES`,
  `SYSTEM_JOB_TYPES`), job_id grammar (build/split/parse), stage mapping,
  envelope-константы + advisory-хелперы, error-токены; собственные
  package-тесты (`contracts/tests/`); architecture guards
  (`phase9c-contracts.test.js`, включая cross-side contract test).
  `backend/src/runtime/job-schema.js` стал compatibility facade/re-export
  (12 backend consumers не меняются). SYNC-копии hub/worker
  **временно сохранены** (миграция заблокирована docker build-context /
  zero-dep bundle freeze — см. `PHASE_9C_CONTRACTS_EXTRACTION_AUDIT.md`).
  `protocol_version` остаётся 2.
- **Phase 9D** физически переместит `worker/worker/` в standalone пакет
  `animastor-worker`; на том же этапе — перевод hub/worker копий на require
  `@animastor/contracts` (через bundle-сборку/копирование пакета в их
  build/deploy контур); архитектурные тесты обновят пути source-inspection;
  volume mounts docker-compose и `install-manifests source.repository` —
  на hub-API delivery (`/worker-bundle` уже существует).
- До замены hub/worker копий на contracts (9D) anti-drift: architecture
  tests (`phase2-job-protocol-v2.test.js`, `gpu-hub-contract.test.js`,
  `phase9c-contracts.test.js` cross-side parity, `phase2-hub-worker-boundary.test.js`,
  `dependency-guardrails.test.js`, `phase7-extraction-readiness.test.js`)
  + SYNC-комментарии.
- Изменения этого контракта после freeze: только через versioning policy
  (§4) с обновлением данного документа в том же PR.

---

## Phase 9A Verification

**Date:** 2026-09-06 · **Baseline:** HEAD `019bd843` · **Scope:** contract
freeze (doc-only) + F5 test-only fix. Production behavior unchanged.

### Изменённые файлы

| Файл | Изменение |
|---|---|
| `docs/architecture/JOB_PROTOCOL_V2.md` | **новый** — этот контракт |
| `backend/tests/architecture/phase2-job-protocol-v2.test.js` | только F5-ассерт (строки 60-90): заменён устаревший `expect(worker).to.match(/:(iu_image|image|audio|video)$/)` (end-anchor по всему многострочному source — никогда не совпадал) на pin фактической grammar: точные split-литералы `/:(iu_image|image|audio|video)$/` (2 вхождения, `deep.equal`) + negative control. Production worker regex НЕ менялся. |

Больше ничего: `git diff --stat` = 2 файла. Не тронуто: `job-schema.js`,
`gpu-hub.js`, `worker.cjs`, `gpu-dispatcher.js`, `generation-routes.cjs`,
docker-compose, install-manifests, package.json, endpoints, auth, Redis,
timeout-значения, payload-формат.

### Тесты и результаты

| Прогон | Результат | Baseline Phase 9 audit | Дельта |
|---|---|---|---|
| `phase2-job-protocol-v2.test.js` (targeted) | 14 pass / 0 fail | 13 pass / 1 fail (F5) | **F5 устранён** |
| Architecture suite (`tests/architecture/*.test.js`) | **229 pass / 1 fail** (единственный fail = F6 `phase2-lac-transport-contract`) | 228 pass / 2 fail (F5+F6) | F5 исчез; F6 остался единственным |
| Worker unit/contract: `job-schema`, `worker-cleanup`, `worker-cleanup-journal`, `worker-bundle-env`, `gpu-hub-artifacts`, `gpu-hub-worker-source`, `gpu-hub-contract` | 76 pass | 76 pass | без изменений |
| Worker auth/registry/setup/bootstrap: `fail-closed-worker-auth`, `private-worker-auth/visibility/phase2/phase3`, `worker-share-policy`, `worker-share-grants`, `worker-setup-api`, `gpu-hub-bootstrap`, `gpu-hub-cleanup` | 260 pass | 260 pass | без изменений |
| Syntax smoke (`node --check`): изменённый тест, `worker.cjs`, `gpu-hub.js`, `job-schema.js` | OK | — | — |
| Полный backend suite (`tests/**/*.test.js`) | **2797 pass / 3 fail** | pre-existing F1–F6 (Phase 8B/8D) | остались только F1 (`ai-endpoint-sharing`), F2 (`ai-shared-inference`), F6 (LAC) — все pre-existing, вне scope; F3/F4 (флаки) в этом прогоне не воспроизвелись |

### Подтверждения

- ✅ **`protocol_version = 2`** — подтверждено прогоном
  `phase2-job-protocol-v2.test.js` («protocol_version = 2 in all three
  synced copies»): `job-schema.js:25`, `gpu-hub.js:33`, `worker.cjs:49` —
  все литералы `[2]`, ни один не изменён.
- ✅ **Production behavior changes: NONE.** `git diff` не содержит ни одного
  production-файла; единственное изменение кода — тестовый ассерт F5
  (test-only, разрешено Phase 9A). Поведение всех трёх компонентов на wire
  идентично baseline `019bd843`.
- ✅ Job Protocol v2 опубликован как самостоятельная спецификация (этот
  документ): envelope, grammar, endpoints, auth, timeout/size/versioning
  semantics, security invariants — всё из фактического кода, без новых
  правил.
- ✅ Source-of-truth зафиксирован: `backend/src/runtime/job-schema.js` —
  de-facto canonical до `@animastor/contracts` (Phase 9C); hub/worker копии
  — transitional synchronization (§2).

**Verdict Phase 9A: COMPLETE.** Следующий шаг по плану §7 — Phase 9B
(dependency isolation: мёртвый `node-fetch`, install-manifests `source`
порядок, план переезда unit-тестов).
