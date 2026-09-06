# PHASE 9 — Worker Extraction Readiness Audit

**Status:** audit only. Никаких production changes, рефакторинга, перемещений,
npm-пакетов. Только разведка, измерение связности и документированный вывод.
**Date:** 2026-09-06
**Baseline:** HEAD `9530d7f6` (Phase 8F завершена: LAC extraction + npm-пакет
готов, публикация заблокирована отсутствием npm auth).
**Inputs:** Phase 7/8 audit-документы, 16 architecture guard suites в
`backend/tests/architecture/`, прямая инспекция `worker/worker/`, `gpu-hub/`,
`backend/src/runtime/`, `backend/src/installer/`, `docker-compose.yml`,
install-manifests, тестовые прогоны.

---

## Executive summary

Worker (`worker/worker/`) структурно **самый изолированный runtime в репо**:
0 inbound requires (P7-T2), 0 outbound repo-edges (R1), только node builtins,
никаких Redis/PG/FS вне своих временных файлов. Однако extraction-as-product
блокируется не кодом, а **контрактом**: Job Protocol v2 (grammar + envelope +
endpoints + timeout-семантика) синхронизируется вручную в 3 местах и нигде не
опубликован как единая версия-несущая спецификация.

**Вердикт: READY AFTER PREPARATION.** Главный blocker — не само дублирование
(3 копии фактически согласованы и pinned тестами), а **отсутствие
опубликованного контракта + артефактный канал доставки (volume mounts),
который hardcoded в docker-compose и install-manifests**.

| Параметр | Оценка |
|---|---|
| Кодовая изоляция | 🟢 готова (0 inbound / 0 outbound) |
| Контрактная изоляция | 🟡 Job Protocol v2 — 3 SYNC копии, unpublished grammar |
| Артефактный канал | 🟡 volume mounts + manifest `source.repository` |
| Мертвые зависимости | 1 (`node-fetch` в package.json не используется) |
| Тестовый контур | 🟢 ~460 тестов покрывают worker surface, все зелёные |

---

## 1. Worker boundary (измерено на HEAD `9530d7f6`)

### 1.1 Production entrypoints

| Entrypoint | Файл | Потребитель |
|---|---|---|
| `node worker.cjs` | `worker/worker/worker.cjs:741` (`main()`) | запуск вручную / `start-worker.sh:243` (`setsid node worker.cjs`) |
| `start-worker.sh` | `worker/start-worker.sh` (243+ строк: node install, ComfyUI check, env, daemon) | оператор GPU-инстанса (E2E Networks, RunPod, локально) |
| `bootstrap-light.sh` / `bootstrap-video.sh` / `fix-nodes-*.sh` / `mc.sh` | `worker/*.sh` | первоначальный setup GPU-инстанса |
| Installer `--start-worker` | `backend/src/installer/cli.js:548` → `engine/worker.js:324` (`spawnDaemon('node', ['worker.cjs'])`) | canonical путь установки Private Worker |
| Hub bundle delivery | `docker-compose.yml:123,126` (mounts `./worker/worker/worker.cjs` и `./worker/worker` в hub) | hub публикует `GET /worker-source` (deprecated) и `GET /worker-bundle` |
| Docker bundle image | `worker/image/worker/` + `worker/Dockerfile` (если есть) — см. `worker/new/` (отражённые скрипты) | контейнерный worker |

### 1.2 Inbound dependencies (кто зависит от worker)

**0 production code requires** — enforced P7-T2
(`phase7-extraction-readiness.test.js:81`, "no repo file requires into
worker/worker/"). Non-code inbound:

- **docker-compose volume mounts** (`docker-compose.yml:123-126`): hub
  монтирует `worker/worker/worker.cjs` и `worker/worker/` read-only —
  **канал доставки артефакта**, не кодовая зависимость, но extraction обязан
  его разорвать (иначе перемещение каталога ломает deployment).
- **install-manifests** (`backend/ai/install-manifests/{image,audio,video}/*.json`,
  ключ `worker_bundle.files` + `source.options.path: "worker/worker/"`):
  installer копирует файлы bundle из repo checkout
  (`backend/src/installer/engine/worker.js:52` — `repoRoot/worker/worker`).
- **Тесты backend** (не production): `worker-cleanup.test.js`,
  `worker-cleanup-journal.test.js`, `worker-bundle-env.test.js`,
  `installer-*.test.js` (require/читают `worker/worker/*.cjs` напрямую);
  architecture tests читают исходник `worker.cjs` как текст.

### 1.3 Outbound dependencies (worker → мир)

Измерено всеми require в `worker/worker/*.cjs` (16 require-вызовов):

| Зависимость | Тип | Файл:строка | Изолируемость |
|---|---|---|---|
| `child_process`, `os`, `fs`, `fs/promises`, `path` | node builtins | `worker.cjs:6-10` | 🟢 нетривиальных |
| `./worker-cleanup.cjs`, `./worker-cleanup-journal.cjs`, `./worker-env.cjs`, `./package.json` | собственные файлы bundle | `worker.cjs:11-13,45` | 🟢 |
| global `fetch` (Node 20+) | runtime API | `worker.cjs:82` | 🟢 |
| **PostgreSQL** | — | **нет** | 🟢 |
| **Redis** | — | **нет** (guarded R1: `dependency-guardrails.test.js:68` "no Redis") | 🟢 |
| **Docker/runtime** | ComfyUI как локальный процесс | `worker.cjs:88-90` `http://127.0.0.1:${COMFY_PORT}` | 🟢 это и есть предмет worker; не backend |
| **Filesystem** | `COMFY_INPUT_DIR`, `COMFY_OUTPUT_DIR`, `WORKER_JOURNAL_DIR` | `worker.cjs:61-62`, `worker-cleanup-journal.cjs:32` | 🟢 только собственные временные артефакты + journal; полная уборка (worker-cleanup) |
| **Network endpoints** | `HUB_URL` (default `https://animastor.in/gpu`), `ANIMASTOR_API_URL` (derived `/api/v1`) | `worker.cjs:23,37-38,120,222,254,521,540` | 🟡 default prod URL зашит; параметризуем через env (уже есть) |
| **Shared config** | — | **нет**. Свой `.env` loader (`worker-env.cjs`), никакой backend config | 🟢 |

### 1.4 Environment variables (полный контракт)

Обязательные: `ANIMASTOR_WORKER_TOKEN` (fail-closed gate, `worker.cjs:711`),
`HUB_URL`, `WORKER_TYPE` (`image|audio|video`), `WORKER_ID`.
Опциональные: `ANIMASTOR_API_URL`, `COMFY_PORT`, `COMFY_INPUT_DIR`,
`NOTEBOOK_PATH`, `WORKER_VERSION`, `WORKER_IMAGE_TAG`, `RESULT_TIMEOUT_MS`,
`VIDEO_RESULT_TIMEOUT_MS`, `TASK_SLEEP_MS`, `BEACON_INTERVAL_MS`,
`WORKER_JOURNAL_DIR`. Все задокументированы в `worker/worker/.env.example` и
`install-manifests` `worker_bundle.env`. **Никаких backend-only env vars** —
контракт замкнут.

### 1.5 Констатация

Worker **уже является standalone-бандлом**: он не знает про backend, Redis,
PG, book-domain. Единственные точки контакта — HTTP к hub (Job Protocol v2)
и HTTP к локальному ComfyUI. Это подтверждает guards R1
(`dependency-guardrails.test.js:46-92`), P7-T2, Phase 2 hub/worker boundary
(`phase2-hub-worker-boundary.test.js:77-92`).

---

## 2. Consumer map (production consumers Worker)

### 2.1 Кто запускает Worker

1. **Оператор GPU-инстанса** через `worker/start-worker.sh` (в root
   инсталляции; re-exec под владельцем, fail-closed token gate).
2. **Animastor installer** (`backend/src/installer/cli.js --start-worker` →
   `engine/worker.js:300-330` `startWorker`): spawn detached daemon
   `node worker.cjs`, liveness через `pgrep -f worker.cjs`, restart при
   изменении `.env`.
3. **Docker-образ** (`worker/image/worker/`, bootstrap-скрипты) — контейнерный
   путь для operator-run пулов.

### 2.2 Кто отправляет jobs

- **Backend orchestrator** (`backend/src/runtime/gpu-dispatcher.js`
  `sendUnified` → `POST {HUB_URL}/task`), routing: book → workspace →
  private worker lane | users-policy lane | system pool. Worker **не выбирает
  источник** — hub вытаскивает из очереди по credential-identity
  (`gpu-hub.js:862-1040`).

### 2.3 Кто получает результаты

- **Backend** `POST /gpu/task/result` / `POST /gpu/task/error`
  (`backend/src/routes/generation-routes.cjs:1340,1437`) — hub форвардит
  (5 retries, fallback Redis `animastor:error:*`). Backend dedup:
  `animastor:result-processed:{dispatch_id}:{job_id}:{build_id}`
  (`generation-routes.cjs:1410`).

### 2.4 Кто знает внутренности Worker

Никакой backend/hub production-код не требует `worker/worker/*`. Знание
внутренностей ограничено:

| Consumer | Что знает | Тип |
|---|---|---|
| `backend/src/installer/engine/worker.js` | file list bundle, `node --check` worker.cjs, spawn, .env semantics | **deployment-internals** (файлы, не логика) |
| `backend/src/installer/platform/{linux,windows}.js` | `pgrep -f worker.cjs` liveness marker | deployment-internals |
| `docker-compose.yml` | пути файлов bundle для mount | deployment-internals |
| install-manifests (3 шт.) | `worker_bundle.files[]`, min_version 2.0.0, env template | **версионный контракт** |
| `gpu-hub.js:32,758,1094` | `PROTOCOL_VERSION = 2`, SYNC-якоря на backend job-schema | контракт (см. §3) |
| backend tests (~10 файлов) | require `worker/worker/*.cjs` напрямую для unit-тестов cleanup/journal/env | тестовый контур |

### 2.5 Прямые импорты внутренних файлов Worker

**Production: 0** (P7-T2 guard). Тесты backend: 5 файлов require напрямую
(`worker-cleanup.test.js`, `worker-cleanup-journal.test.js`,
`worker-bundle-env.test.js`, `installer-cpu.test.js`,
`installer-setup-contract.test.js`) — это **unit-тесты пакета, живущие в
backend-дереве**: при extraction они должны переехать вместе с пакетом.

### 2.6 Скрытые зависимости через shared helpers

**Не обнаружено.** Единственный "shared helper" паттерн — SYNC-копии
job-schema (§3), но это копии в source, не runtime require. Worker не
использует `backend/src/helpers/*`, никаких shim/утилит. `.env`-loading
дублирует backend-паттерн, но реализован независимо (`worker-env.cjs`,
50 строк, zero-deps).

### 2.7 Frontend consumers

Frontends знают worker только через backend API (worker registry visibility,
setup contract `GET /api/v1/private-worker/setup/*`); прямых обращений к
hub/worker из `frontends/` — 0.

---

## 3. Job Protocol v2 — полный разбор

### 3.1 Три места дублирования (подтверждено)

| # | Место | Что содержит | Владелец |
|---|---|---|---|
| 1 | `backend/src/runtime/job-schema.js` | **canonical**: `PROTOCOL_VERSION=2` (:25), `JOB_TYPES=['audio','image','iu_image','video']` (:27), `buildJobId/splitJobId/parseJobId` (:38-120), `STAGE_BY_KIND` (:28-33) | backend (orchestration contract) |
| 2 | `gpu-hub/gpu-hub.js` | `PROTOCOL_VERSION = 2` (:33, SYNC-якорь :32, повтор :758), `SYSTEM_JOB_TYPES=['audio','image','video']` (:53), **косвенный** job_id grammar в комментариях :1090-1096 (result-key builder берёт поля из running-record, не парсит job_id сам) | hub (transport validation) |
| 3 | `worker/worker/worker.cjs` | `PROTOCOL_VERSION = 2` (:49), **inline job_id split** `/(iu_image|image|audio|video)$/` (:611,:625) для именования input-файлов assets | worker (consumer) |

Плюс **косвенные дублирования** grammar:
- `gpu-dispatcher.js:139` `validTypes = ['audio','image','video']` (без
  `iu_image` — job_type transport vs asset-type различие);
- `gpu-hub.js:53` `SYSTEM_JOB_TYPES` (без `iu_image`);
- architecture tests закрепляют токены
  (`phase2-job-protocol-v2.test.js:76` worker regex, `:74` hub regex).

### 3.2 Одинаковы ли копии фактически?

**Да, фактически согласованы и pinned:**

- `PROTOCOL_VERSION = 2` — все 3 копии идентичны; guarded **двумя** тестами
  (`gpu-hub-contract.test.js:55-63` и `phase2-job-protocol-v2.test.js:33-41`),
  каждый проверяет все 3 файла литерально `[2]`.
- job_id grammar — backend canonical parse; worker использует только
  split-suffix (подмножество); hub не парсит job_id вовсе (поля
  `book_id/chapter_id/scene_id/stage` приходят из envelope). Расхождений
  формата нет: тест `phase2-job-protocol-v2.test.js:60-77` пинит токены
  типов во всех 3 копиях.
- **Единственный известный расхождение-кандидат**: `phase2-job-protocol-v2.test.js:76`
  ожидает regex `/:(iu_image|image|audio|video)$/` в worker — worker
  содержит его (worker.cjs:611), тест падает по другой причине (см. §3.7).

Вывод: **дублирование — не семантическое, а организационное**: три копии
согласованы today, но ни одна не является "published contract"; sync
обеспечивается только ручной дисциплиной + комментариями `SYNC:` + 4 тестами
(риск: изменения проходят, если все 3 теста не прогоняются).

### 3.3 Владение и расхождения

- **Владелец de-facto**: `backend/src/runtime/job-schema.js` — hub и worker
  называют его каноном в SYNC-комментариях (`gpu-hub.js:32`, `worker.cjs`
  через тесты).
- **Расхождения по полям** (не конфликты, но асимметрия знания):
  - `iu_image` знают backend job-schema + worker; hub job_type валидация не
    требует полный список (job_type произволен в :754, только
    `SYSTEM_JOB_TYPES` для scan-очередей).
  - `timeout_ms`: backend автор (layer-config / `DEFAULT_TYPE_TIMEOUT_MS`
    dispatcher:125-129), hub `Math.max(timeout_ms, GPU_TIMEOUT_MS)` (:843-845),
  worker — consumer + собственный fallback
  (`VIDEO_RESULT_TIMEOUT_MS=2h` worker.cjs:57). **Три уровня таймаута одного
  поля** — контракт по письму отсутствует.
  - `stage` vs `job_type`: envelope несёт `stage` (audio/image/video —
    STAGE_BY_KIND), `job_type` (audio/image/video), а `job_id` суффикс может
    быть `iu_image`. Тройная идентичность — для outsider это самая confusing
    часть контракта.

### 3.4 Что является публичным контрактом

**Job envelope (backend → hub → worker):**

| Поле | Обязательное | Автор | Потребители |
|---|---|---|---|
| `job_id` (`${assetId}:${type}`) | да | backend | hub (dedup/result-key), worker (asset-файлы) |
| `job_type` (audio/image/video) | да | backend | hub (queue routing), worker (type-check) |
| `params` (ComfyUI workflow JSON) | да | backend (workflows) | worker → ComfyUI |
| `assets` (`image` base64 / `images` map) | опц. | backend | worker (input files) |
| `build_id` | да | backend | hub, backend result path |
| `dispatch_id` | да | backend (dispatch-engine) | все — claim/dedup/staleness |
| `protocol_version` (=2) | да | везде | все — mismatch = 409/reject |
| `book_id`, `chapter_id`, `scene_id`, `stage` | да (hub :766) | backend (parseJobId) | hub (result-key, running record) |
| `workspace_id` / `policy_id` | опц. (backend-authored routing) | backend | hub (queue lane) |
| `timeout_ms` | опц. | backend (layer-config) | hub (timeout sweep), worker (waitResult) |

**Result/error envelope (worker → hub → backend):** `job_id`, `build_id`,
`dispatch_id`, `protocol_version`, `result_base64` | `reason` (worker.cjs:519-556),
+ hub-added `worker_id`, `workspace_id` (audit-only, backend re-verifies).

**Beacon envelope (worker → hub):** `id`, `type`, `gpu`, `vram`, `version`,
`image_tag`, `protocol_version` (worker.cjs:225-233). Hub identity из токена,
body-поля — labels only.

**Endpoints (pinned `HUB_ROUTES`):** `POST /beacon`, `POST /task`,
`GET /task/next?worker=&type=`, `POST /task/result`, `POST /task/error` —
pinned в `gpu-hub-contract.test.js:35-42` + worker-side pins :91-99.

**Auth:** Bearer `wrk.<worker_id_b64>.<secret>` — только header
(`extractBearerToken` hub:87); fail-closed (401 без/с invalid; worker
refuses to start без token — worker.cjs:711-719).

### 3.5 Что является внутренними деталями

- Внутренности worker: cleanup-journal lifecycle (CREATED→GENERATED→
  DELIVERED→CLEANED), ComfyUI polling/fs-scan детали (`waitResult`),
  MIME_MAP, OOM-safe local read vs HTTP download fallback, empty-queue
  backoff — **никто вне worker их не знает**.
- Внутренности hub: Redis key layout (`animastor:queue:*`, `processing`,
  `running`, `job:*` dedup, `worker:heartbeat:*`, `gpu-hub:workers`,
  `worker-auth`, `dead-letter`, `result:*`, `error:*`), orphan sweep,
  poison-check, lane priority.
- Worker job_id split (:611,:625) — **пограничный случай**: технически это
  знание contract grammar (worker называет input-файлы по asset-частям
  job_id). Это contract-знание, а не внутренность, но живёт как inline copy.

### 3.6 Protocol surface — детальные пункты

| Аспект | Состояние |
|---|---|
| **Job envelope** | см. §3.4 — стабилен, hub :735-847 |
| **Job id** | `${assetId}:${type}`; 4 типа; parse-from-end; pinned unit-тестами (`phase2-job-protocol-v2.test.js:94-128`, `job-schema.test.js`) |
| **Worker id** | `WORKER_ID` env — **label only**; identity = credential (hub:87-92, worker.cjs:722 "identity comes from the credential"). `client_id` для ComfyUI = WORKER_ID (worker.cjs:322) |
| **Status/result/error** | Result = HTTP 200 + `animastor:result:*` Redis (1h TTL); error = `/task/error` → backend `failStage` + fallback key `animastor:error:*`; timeout = hub sweep → `worker_timeout` → backend re-dispatch via lease |
| **Retry/timeout** | Retry — backend-owned (dispatch-lease); worker retry только HTTP-calls; timeout: per-job `timeout_ms` (3 уровня, §3.3) |
| **Cancellation** | **Явного cancellation канала нет** — через lease expiry/re-dispatch. Worker не получает stop-сигнала; отмена задачи = timeout на стороне hub |
| **Serialization** | JSON поверх HTTP; результат = base64 data-URI в `result_base64` (O(hundreds MB) для видео! hub express.json limit 500mb) |
| **Versioning** | `protocol_version` int=2; hub 409 + worker reject при mismatch; mixed-version rollout запрещён (job-schema.js:22-24 comment). Изменение = смена везде + тесты |
| **Unknown fields** | Никто не валидирует строгую схему; hub destructures нужные поля, worker аналогично; unknown поля **проходят насквозь** (backend `...taskSpec` spread dispatcher:177) |
| **Size limits** | express.json 500mb (hub:266); worker warn >50MB (worker.cjs:489); result TTL 1h Redis; dedup key TTL 1h. Не задокументировано как контракт |
| **protocol_version в sendResult/sendTaskError/sendBeacon** | worker посылает всегда (worker.cjs:528,547,232); hub проверяет на /task/result :1057, /task/error :1205, beacon :679; **backend проверяет** на /gpu/task/result :1351, /gpu/task/error :1445 |

### 3.7 Известная проблема тестового пиннинга

При прогоне на HEAD `9530d7f6`: architecture suite 228 pass / 2 fail — оба
**pre-existing** (задокументированы Phase 8B/8D как F5/F6):

- **F5** `phase2-job-protocol-v2.test.js:76` «job_id type family anchored
  same in backend, hub, worker» — падает из-за `$`-якоря regex-ассерта
  (`/:(iu_image|image|audio|video)$/`): mocha-строка не совпадает с worker
  source (worker содержит regex в split-аргументе, матч должен идти по
  исходнику, но `$` в `to.match` интерпретируется иначе). Ассерт
  устарел формально, **не** указывает на реальное расхождение копий
  (grammar синхронна — проверено вручную). Нужен маленький фикс ассерта в
  подготовительной фазе (это тест, не production).
- **F6** `phase2-lac-transport-contract` — LAC-сторона, к Worker не относится.

Остальные worker-пиннинги (`gpu-hub-contract.test.js:91-99` — worker
потребляет те же endpoints; `:155-160` — mismatch rejection) проходят.

---

## 4. Extraction seam (гипотетическая граница)

```
backend/orchestrator (gpu-dispatcher, layer-config timeouts, routing)
        │  POST {HUB_URL}/task  (Job Protocol v2 envelope, api-key)
        ▼
GPU Hub (Redis queues, claim/lease/timeout, auth mirror)
        │  GET /task/next  (Bearer wrk.…; task JSON)
        ▼
Worker  (ComfyUI execution, artifacts, cleanup journal)
        │  POST /task/result | /task/error (Bearer, protocol_version=2)
        ▼
GPU Hub → backend /gpu/task/result|error
```

**Можно ли провести границу `backend → Job Protocol → standalone Worker`
без изменения поведения?**

**Да, с оговоркой:** граница уже существует физически (worker сегодня общается
с backend только через hub HTTP). Что требуется для **продуктовой** границы:

1. **Job Protocol v2 должен стать published contract** (единственный
   versioned-документ/schema) — иначе standalone worker не имеет
   authoritative reference для имплементации.
2. **Артефактный канал доставки worker-bundle должен уйти от repo volume
   mounts** к hub API (`/worker-bundle` уже существует и работает!) —
   но `docker-compose.yml:123-126` и `install-manifests source.repository`
   всё ещё pointing в repo-путь. Это **deployment-связь**, а не код.
3. Worker **не имеет прямой связи с backend internals** — seam уже чистый.

Проверка "без изменения поведения": worker.cjs единственный вход —
`HUB_URL`/`ANIMASTOR_API_URL`; он не требует ничего из backend. Его можно
переместить в отдельный git-репо/npm-пакет как есть; все тесты
(за исключением backend-деревянных unit-тестов его файлов, §2.5) продолжат
проверять контракт через source-инспекцию, если путь к worker source
останется достижим для architecture-тестов.

---

## 5. Risk classification (A/B/C/D)

### A — можно изолировать практически без риска

| Зависимость | Файл/модуль | Причина |
|---|---|---|
| 0 inbound code requires | весь repo | уже enforced P7-T2 |
| node builtins + собственные файлы | `worker/worker/*.cjs` | полная самодостаточность |
| ComfyUI HTTP (localhost) | `worker.cjs:88-90` | это ядро продукта worker, не backend-связь |
| `.env` self-contained loading | `worker-env.cjs` | zero-deps, тесты есть |
| Cleanup journal (fs, atomic) | `worker-cleanup-journal.cjs` | worker-local persistent, не зависит от Redis/PG; unit-тесты есть |
| Fail-closed auth startup gate | `worker.cjs:711-749` | только env; тесты есть (`fail-closed-worker-auth.test.js`) |

### B — маленький подготовительный рефакторинг

| Зависимость | Файл/модуль | Что нужно |
|---|---|---|
| Мертвая зависимость `node-fetch` | `worker/worker/package.json:14` | worker использует global fetch (Node 20+); удалить dep (+ lock). Чисто косметика, но перед publish обязательно |
| SYNC-копия job_id split | `worker.cjs:611,625` | inline-grammar; при contract-package она заменяется на require published contract (см. §6) |
| Backend unit-тесты файлов worker | `backend/tests/worker-cleanup*.test.js`, `worker-bundle-env.test.js` | переехать в пакет при extraction; до тех пор — жить в backend (guard через architecture tests читает исходники, не требует) |
| Deployment-пути installer | `backend/src/installer/engine/worker.js:52` (`repoRoot/worker/worker`), `install-manifests` `source.repository` | manifest уже описывает fallback-order (repo → bundle → hub); extraction = обновить manifest `source` на hub-only + путь к checkout |
| Устаревший ассерт F5 | `backend/tests/architecture/phase2-job-protocol-v2.test.js:76` | починить `$`-якорь regex (тест-only), чтобы пиннинг копий был зелёным |

### C — требует изменения контракта

| Зависимость | Файл/модуль | Что менять |
|---|---|---|
| 3 SYNC-копии PROTOCOL_VERSION/grammar | `job-schema.js:25` ↔ `gpu-hub.js:33,758` ↔ `worker.cjs:49` | замена копий на единый published contract (schema/generated/constants). Изменение — организационное, protocol_version остаётся 2 (не breaking), но это формально изменение "контрактной поверхности" (новый package) |
| Volume mounts артефактов | `docker-compose.yml:123-126` | переход на hub-API delivery (endpoints готовы: `/worker-bundle`, `/worker-bundle/sha256`); docker-compose меняется, install-manifests `source` тоже |
| Timeout `timeout_ms` (3 уровня) | dispatcher:125-157, hub:843-845, worker.cjs:51-57 | контрактное поле без спецификации: документировать в published contract, включая invariant `per-job >= GPU_TIMEOUT_MS < STALL_FAILSAFE_MS` (runtime-config.js:143-160) |
| Тройная идентичность job (job_id suffix / job_type / stage) | job-schema, dispatcher, hub | при published contract зафиксировать нормативно (iu_image — asset-type в job_id, но transport job_type=image со stage=image) |

### D — опасно/неясно, не трогать сейчас

| Зависимость | Файл/модуль | Причина |
|---|---|---|
| Hub↔backend Redis contract (17 key families, cross-owner writes) | `gpu-hub.js` + `worker-routes.cjs:146-165,414,629` (`drainPolicyLane` RPOPLPUSH+task mutation, `hdel` registry) | это блокер **hub** extraction, не worker; Phase 8 reconnaissance уже пометила как 🔴; worker extraction не зависит от него (worker говорит HTTP, не Redis) |
| Envelope book-identity (обязательные `book_id/.../stage`) | `gpu-hub.js:766` | часть hub-side контракта; worker их игнорирует (worker.cjs destructures только job_id/build_id/dispatch_id/params/assets/timeout_ms). Трогать = менять контракт backend↔hub — вне scope worker extraction |
| Express 500mb limit для base64 результатов | `gpu-hub.js:266`, worker base64 protocol limitation (worker.cjs:460-465 комментарий) | реальное архитектурное ограничение (OOM-risk protocol); изменение = protocol v3. Не сейчас |
| Cancellation отсутствует | dispatch-lease only | любое изменение = контракт v3; работа над backend scheduler, не worker |

---

## 6. Protocol ownership — выбор варианта

**Вариант A: Job Protocol остаётся в backend, Worker — consumer.**
✗ Не решает проблему: hub + worker всё равно несут копии; published contract
не появляется; standalone worker всё ещё имплементирует по SYNC-комментариям.
Подходит только как interim.

**Вариант B: protocol contract → отдельный shared package
(`packages/contracts` / `@animastor/contracts`).**
✓ Соответствует уже принятому плану
`MODULAR_PRODUCT_ARCHITECTURE.md` §30 Phase 10 ("Contracts package... The
three SYNC copies of the Job Protocol become generated/pinned from one
source"). Позволяет worker-пакету зависеть от контракта (не от backend),
hub — тоже. Backend сохраняет runtime/validation логику, но constants +
schema + grammar приходят из пакета.

**Вариант C: protocol — часть standalone Worker package.**
✗ Худший: контракт трёхсторонний (backend — hub — worker); его "владение"
одной стороной создаёт inverted dependency (backend/hub зависели бы от
worker-пакета или продолжали копировать).

**Вариант D (гибрид, рекомендация):** B, с сохранением
`backend/src/runtime/job-schema.js` как **facade/re-export** из
`@animastor/contracts` в течение transition (бэкward-compat для 12
backend-consumers, найденных в §2 grep). Protocol version остаётся 2.

**Оценка для будущего standalone Worker:** только B (или D) позволяет
выпустить worker как независимый продукт: worker-package → depends on
`@animastor/contracts` (крошечный, zero-deps) + hub URL. Ни backend internals,
ни Redis, ни PG не нужны. Путь MODULAR_PRODUCT_ARCHITECTURE §30 Phase 12
("Publish animastor-worker with C4/C5 as their published contracts")
прямо предполагает это.

---

## 7. Extraction plan (минимальный безопасный порядок)

Порядок фаз задачи в целом корректен, но **Phase 9A/B swap не нужен**, а вот
**9B и 9C можно поменять местами с 9D-приоритетом**. Ниже — исправленный
минимальный порядок:

### Phase 9A — contract freeze (doc-only, безопасный первый шаг)
1. Опубликовать Job Protocol v2 как документ: envelope (§3.4), job_id
   grammar, endpoints, auth, timeout-семантика (3 уровня + invariant),
   size limits, versioning/mismatch semantics, известные ограничения
   (base64, отсутствие cancellation).
2. Зафиксировать, что protocol_version остаётся 2.
3. Починить устаревший ассерт F5 (тест-only) — чтобы пиннинг всех трёх копий
   был зелёным до любых движений.
4. **Никаких изменений production кода.**

### Phase 9B — dependency isolation (малый подготовительный рефакторинг)
1. Удалить мертвую `node-fetch` dep из `worker/worker/package.json`
   (npm-гигиена перед публикацией; поведение не меняется — Node 20+).
2. Обновить install-manifests `worker_bundle.source` на hub-first порядок
   (repo fallback остаётся до 9D).
3. Спланировать переезд backend unit-тестов worker-файлов в пакет (не
   делать до 9D).

### Phase 9C — protocol deduplication (через contracts package)
1. Создать `packages/contracts` (`@animastor/contracts`): constants
   (PROTOCOL_VERSION, JOB_TYPES, SYSTEM_JOB_TYPES), job_id grammar
   (build/split/parse — копия текущей job-schema), JSON Schema envelope.
2. `backend/src/runtime/job-schema.js` → re-export из contracts (12
   consumers не меняются).
3. `gpu-hub.js` и `worker.cjs` → берут constants/parse из contracts
   (SYNC-комментарии удаляются; guards обновляются с "3 копии" на
   "1 источник + facade").
4. protocol_version остаётся 2; все существующие контракт-тесты не меняют
   expectations, только пути.

### Phase 9D — physical extraction
1. Переместить `worker/worker/` → standalone пакет `animastor-worker`
   (npm-ready: LICENSE, README, CHANGELOG, `files` allowlist — как сделано
   для ai-connector в Phase 8C).
2. Перевести unit-тесты (worker-cleanup/journal/env) в пакет.
3. Обновить `docker-compose.yml` (mounts на hub-API артефакты или на новый
   путь), install-manifests `source.repository` → hub-only.
4. Backend architecture-тесты обновляют пути чтения исходника worker
   (`gpu-hub-contract.test.js:25`, `phase2-*:27`, `phase7:26`).

### Phase 9E — standalone package verification
1. `npm test` пакета (unit + contract fixtures) зелёные.
2. `npm pack --dry-run` — состав файла корректен (7 файлов bundle).
3. Backend cross-side contract tests (обновлённые пути) зелёные.
4. Полный backend прогон — 0 новых regressions (базовая линия
   Phase 8D: 6-7 pre-existing failures F1-F6).
5. `npm publish` — как и LAC, блокируется npm auth (Phase 8F), но
   не блокирует готовность.

**Почему порядок корректен:** contract freeze первым — иначе dedup (9C)
фиксирует неявное; isolation перед physical move — иначе npm-гигиена
уезжает в чужой пакет; dedup до extraction — иначе extracted worker тянет
SYNC-долг в новое место; verification последним. Зависимости 9C→9D
обязательны: extraction без dedup окончательно разбрасывает протокол на
3 репо.

---

## 8. Guardrails (существующие + необходимые; НЕ писать сейчас)

### Существующие guards, покрывающие worker boundary

| Guard | Что пиннит |
|---|---|
| `dependency-guardrails.test.js` R1 (worker isolation) | builtins-only, no backend/hub/book/generation/PG refs, no Redis |
| `phase2-hub-worker-boundary.test.js` | route surface, worker consumes same endpoints, hub has no code-deps on backend/worker, worker self-contained |
| `phase2-job-protocol-v2.test.js` | PROTOCOL_VERSION=2 в 3 копиях, dispatch_id в envelope, grammar parse, mismatch rejection |
| `gpu-hub-contract.test.js` | hub routes, protocol 3 копии, SYNC-якоря, envelope identity fields, worker-side endpoint pins, auth-only-from-credential |
| `phase7-extraction-readiness.test.js` P7-T2 | 0 inbound requires в worker/worker/ |
| `lac-legacy-path-guard.test.js` | worker/worker — один из 7 production roots сканера |
| Unit: `worker-cleanup*.test.js`, `worker-bundle-env.test.js`, `job-schema.test.js` | поведение journal/env/grammar |
| Integration: `fail-closed-worker-auth.test.js`, `private-worker-*.test.js`, `gpu-hub-*.test.js` (~460 тестов) | auth, registry, setup contract, artifacts |

### Новые guardrails, которые понадобятся (proposal only)

1. **Contract-source guard (9C+):** `PROTOCOL_VERSION`/`JOB_TYPES`
   объявлены только в `@animastor/contracts`; hub/worker/backend
   (re-exports не считаются) не содержат собственных литералов.
2. **Worker package isolation (9D+):** аналог P7-T1 (LAC): пакет не требует
   ничего вне себя + node-fetch/детих deps отсутствуют; `npm pack` состав
   пиннится (как lac package allowlist).
3. **Protocol version handshake (9E+):** при future protocol bump —
   тест всех трёх consumers на согласованную версию (сейчас уже частично
   покрыто `phase2-job-protocol-v2.test.js:33`).
4. **Manifest-path guard:** install-manifests `worker_bundle.source`
   никогда не указывает в legacy `worker/worker/` после 9D (аналог
   lac-legacy-path-guard).

---

## 9. Tests

### Существующие worker tests (все зелёные, проверено на HEAD)

| Набор | Результат прогона | Что покрывает |
|---|---|---|
| `job-schema.test.js` | pass | canonical job_id grammar (unit) |
| `worker-cleanup.test.js` + `worker-cleanup-journal.test.js` | pass (в составе 76) | cleanup + journal lifecycle + crash recovery |
| `worker-bundle-env.test.js` | pass | .env loader, precedence |
| `fail-closed-worker-auth.test.js` + `private-worker-auth/visibility/phase2/phase3` + `worker-share-policy/grants` | 113 pass | auth/token/registry/sharing |
| `worker-setup-api.test.js` + `gpu-hub-bootstrap/cleanup/artifacts/worker-source` | 147 pass | setup contract, bundle artifacts, sha256 |
| `installer-setup-contract.test.js` + `installer-uninstall.test.js` | 68+ pass | install/uninstall worker через installer |
| Architecture suite | 228 pass / 2 fail (оба pre-existing F5/F6, Phase 8B/8D) | всё из §8 |

### Contract tests / integration tests

- **Contract (cross-side, source-inspection):** `phase2-job-protocol-v2`,
  `gpu-hub-contract`, `phase2-hub-worker-boundary` — читают исходники всех
  трёх сторон и пиннят согласованность. Это и есть главный механизм
  "нет дрифта" сегодня.
- **Integration (HTTP-level):** `gpu-hub-artifacts.test.js` поднимает
  реальный hub app (`buildHubApp`) и гоняет GET /worker-bundle против
  реального каталога worker; `fail-closed-worker-auth` гоняет полную
  auth-flow. **End-to-end "backend→hub→worker" HTTP-loop теста нет**
  (worker сам не поднимается в тестах — только его unit-функции).

### Какие тесты понадобятся для standalone package

1. Unit-тесты пакета: cleanup, journal, env — переносятся как есть.
2. **Package-internal contract fixtures**: golden JSON задач (envelope)
   всех 4 типов + result/error/beacon payloads — для проверки, что пакет
   согласован с published schema (9C).
3. **Simulated hub harness** (fixture-based, без запуска hub): проверка
   worker-side HTTP-клиента (endpoints, auth header, protocol_version
   reject) — сегодня покрыто только source-инспекцией.
4. `npm pack --dry-run` состав (как у LAC).

### Какие backend tests остаются cross-side contract tests

- `phase2-job-protocol-v2.test.js` (обновить пути после 9C/9D),
- `gpu-hub-contract.test.js` worker-side pins,
- `phase2-hub-worker-boundary.test.js`,
- `phase7-extraction-readiness.test.js` P7-T2 (inbound),
- integration `gpu-hub-artifacts.test.js` (пакет как внешний артефакт).
Backend unit-тесты файлов worker уходят в пакет.

---

## 10. Финальный verdict

## WORKER EXTRACTION: **READY AFTER PREPARATION**

### Главный blocker

**Отсутствие опубликованного Job Protocol v2 контракта** (3 SYNC-копии +
unpublished grammar + недокументированные timeout/size семантики). Само по
себе дублирование не расошлось и pinned тестами, но extraction-as-product
требует single-source-of-truth контракт; без него standalone worker
имплементирует протокол по комментариям SYNC.

**Второй blocker (deployment, не код):** артефактный канал worker-bundle
привязан к repo volume mounts + install-manifests `source.repository` —
физическое перемещение каталога ломает delivery без обновления manifest +
docker-compose.

### Самый безопасный первый шаг

**Phase 9A contract freeze (doc-only):** опубликовать Job Protocol v2 как
версионный документ (envelope, grammar, endpoints, auth, timeout,
size/versioning semantics) + починить устаревший ассерт F5 (тест-only).
Нулевой production risk, ничего не перемещается, весь дальнейший порядок
опирается на зафиксированный контракт.

### Что нельзя трогать

1. `protocol_version = 2` — не повышать (breaking для всех живых workers).
2. Hub↔backend Redis contract (17 key families, `drainPolicyLane`,
   registry `hdel`) — это hub-extraction scope (🔴 Phase 8), не worker.
3. Обязательные book-identity поля envelope (hub :766) — часть
   backend↔hub контракта; worker их не использует, но убирать нельзя.
4. Base64 result protocol / 500mb limits — protocol v3 материал.
5. `dispatch_id` claim/staleness семантику (PW-4 fail-closed auth model) —
   безопасность; extraction не должен её ослаблять.

### Ориентировочный порядок extraction

9A (contract freeze, doc) → 9B (dependency isolation: node-fetch,
manifests, тест-план) → 9C (protocol deduplication через
`@animastor/contracts`) → 9D (physical extraction в npm-пакет
`animastor-worker`) → 9E (package verification + publish). Детали в §7.

### Можно ли выпустить Worker как отдельный npm/package/product?

**Да.** Структурно он готов сегодня (0 кодовых зависимостей от backend,
builtins-only, собственный package.json, bundle уже доставляется как
артефакт через hub). После Phase 9A-9E worker становится
`animastor-worker@2.x` — независимым compute-agent для private GPU /
community pool / будущих marketplace (прямо соответствует
MODULAR_PRODUCT_ARCHITECTURE §11 "independently deployable compute agents"
и §30 Phase 12). Ограничения продукта: worker имеет смысл только против
Animastor GPU Hub (protocol owner) — это продукт-компаньон, а не
универсальная библиотека.

### Насколько extraction опаснее/безопаснее LAC?

**Немного опаснее, но всё ещё LOW-MEDIUM:**

| Ось | LAC (Phase 8, исполнено) | Worker (Phase 9) |
|---|---|---|
| Кодовая изоляция | 0/0 | 0/0 — **паритет** |
| Протокол | LAC v1 pinned, но单一 backend-side | Job Protocol v2 — **трёхсторонний**, 3 SYNC копии |
| Артефактный канал | npm-ready package | bundle через volume mounts + hub API — **двойной канал, требующий миграции** |
| Деплой-инстансы | нет runtime-инстансов | живые GPU-инстансы + installer + Docker — **нельзя сломать delivery** |
| Тестовое покрытие | 69 package + 22 contract | ~460 тестов, но часть — исходник-инспекция по путям (меняются при перемещении) |
| Безопасность | token auth, out-of-process | fail-closed PW-4 — должно сохраниться byte-for-byte |

LAC был pure packaging act; Worker — packaging + contract publication +
delivery-channel migration. Все три компонента имеют готовые endpoint'ы
и тесты, поэтому риск остаётся управляемым при порядке §7.

---

## Приложение: проверочные команды (выполнены, ничего не изменено)

- Architecture suite: `npx mocha --exit tests/architecture/*.test.js`
  → 228 pass / 2 fail (pre-existing F5/F6, см. Phase 8D §8)
- Worker unit/contract: `job-schema`, `worker-cleanup*`,
  `worker-bundle-env`, `gpu-hub-artifacts`, `gpu-hub-worker-source`
  → 76 pass
- Auth/registry/visibility: `fail-closed-worker-auth`,
  `private-worker-auth`, `private-worker-visibility`, `worker-share-policy`
  → 113 pass
- Setup/bootstrap: `private-worker-phase2/3`, `worker-setup-api`,
  `worker-share-grants`, `gpu-hub-bootstrap`, `gpu-hub-cleanup` → 147 pass
- Installer worker-path: `installer-setup-contract`, `installer-uninstall`
  (+ `installer-cpu` worker-кейсы: 19/20a-d, 45 pass) → pass
- Рабочее дерево после аудита: только этот документ.
