# PHASE 9B — Worker Dependency Isolation Audit

**Status:** выполнена. Один реальный production-блокер изоляции устранён
(мёртвая npm-зависимость), остальное — зафиксировано и задокументировано.
Physical extraction НЕ выполнялся (это Phase 9C+). Job Protocol v2,
endpoints, auth, Redis, timeout-семантика, payload format — без изменений.
**Date:** 2026-09-06
**Baseline commit:** `e04d8acf` (Phase 9A: Job Protocol v2 contract freeze)
**Inputs:** Phase 9 readiness audit (`PHASE_9_WORKER_EXTRACTION_READINESS_AUDIT.md`),
прямая инспекция `worker/worker/*.cjs`, `worker/*.sh`, `docker-compose.yml`,
`docker/worker/`, `gpu-hub/gpu-hub.js`, install-manifests, тестовые прогоны.

---

## Executive summary

Повторная полная инвентаризация зависимостей Worker подтвердила вывод Phase 9:
`worker/worker/` — **самый изолированный runtime в репо** (0 inbound code
requires, 0 outbound repo-edges, только node builtins). Найдена и устранена
**ровно одна реальная dependency-проблема**: мёртвая декларация `node-fetch`
в `worker/worker/package.json` (worker использует global fetch Node 20+;
файл никогда не требовался). После её удаления **канонический bundle —
zero-runtime-dependency** и доказанно запускается в чистой директории без
Animastor-репозитория (standalone smoke-пройден).

**Вердикт: PHASE 9B: PASS WITH PREPARATION** — кодовая изоляция готова,
остались deployment-coupling (volume mounts, manifest `source.repository`)
и контрактная подготовка (Job Protocol v2 → npm-пакет) — это предмет Phase 9C.

**WORKER STANDALONE: READY** — bundle запускается в чистой директории
(fail-closed на отсутствии токена — ожидаемое production-поведение);
standalone deployment-путь (hub API delivery) уже реализован, но repo-mount
канал пока остаётся каноничным для dev-развёртывания.

| Параметр | До 9B | После 9B |
|---|---|---|
| Runtime npm deps канонического bundle | 1 (мёртвый `node-fetch`) | **0** |
| Inbound code requires в `worker/worker/` | 0 | 0 |
| Outbound repo-edges (backend/gpu-hub/frontends) | 0 | 0 |
| Standalone запуск без репозитория | да (но с лишним `npm install`) | да, `npm install` — no-op (0 пакетов) |
| Deployment coupling | volume mounts + manifest source | без изменений (осознанно, Phase 9C) |

---

## 1. Baseline

- **Commit:** `e04d8acf` `docs: freeze Job Protocol v2 contract (Phase 9A) + fix stale F5 assertion`
- **Рабочее дерево:** чистое на старте; все изменения 9B сделаны поверх.
- **Baseline тесты (до изменений 9B):**
  - Worker unit (`worker-cleanup`, `worker-cleanup-journal`, `worker-bundle-env`): **32 pass / 0 fail**
  - Architecture suite (`test:arch`): **229 pass / 1 fail** (pre-existing **F6**
    `phase2-lac-transport-contract` — LAC-сторона, к Worker не относится; задокументирован Phase 8B/8D/9)
  - Full backend (`mocha --exit "tests/*.test.js"`): **2568 pass / 2 fail**
    (pre-existing F1/F2 LLM Sharing — состояние dev-БД/устаревший ассерт, Phase 8E таблица)
  - Syntax smoke (`scripts/syntax-smoke.sh`): **All production JS/CJS files pass**

## 2. Dependency inventory и классификация (A/B/C/D/E)

Классификация: **A** — self-contained; **B** — внешняя, можно оставить;
**C** — monorepo-зависимость, нужно изолировать; **D** — deployment/runtime
coupling; **E** — неизвестная/опасная.

### 2.1 Code requires (production, `worker/worker/*.cjs`)

| Зависимость | Где | Класс | Комментарий |
|---|---|---|---|
| `child_process` (execSync — nvidia-smi) | `worker.cjs:6,175` | A | node builtin, опрос GPU |
| `os` (hostname) | `worker.cjs:7` | A | node builtin |
| `fs`, `fs.promises` | `worker.cjs:8-9` + cleanup/journal/env | A | node builtin |
| `path` | везде | A | node builtin |
| `./worker-cleanup.cjs` | `worker.cjs:11` | A | собственный файл bundle |
| `./worker-cleanup-journal.cjs` | `worker.cjs:12` | A | собственный файл bundle |
| `./worker-env.cjs` | `worker.cjs:13` | A | собственный .env loader |
| `./package.json` (version) | `worker.cjs:45` | A | собственный файл bundle |
| global `fetch` (Node 20+) | `worker.cjs:82` и все HTTP | A | без node-fetch после 9B |
| backend production modules | — | **A: отсутствуют** | guarded R1 + P7-T2 |
| gpu-hub production modules | — | **A: отсутствуют** | guarded R1 |
| frontend code | — | **A: отсутствуют** | — |
| тесты / monorepo helpers | — | **A: отсутствуют** | 0 hidden runtime deps |

**Вывод: production import boundary чист.** Каждый require — node builtin
или собственный файл бандла. Зафиксировано guard'ами
`dependency-guardrails.test.js` (R1: builtin allowlist + ban Redis + ban
backend-domain слов) и `phase7-extraction-readiness.test.js` (P7-T2: no
inbound requires). Изменение кода 9B не потребовало — **изолировать было
нечего**.

### 2.2 npm dependencies

| Пакет | Было | Стало | Класс | Действие 9B |
|---|---|---|---|---|
| `node-fetch@^3.3.2` | объявлен в `package.json` | **удалён** | C → устранён | **единственное кодовое изменение 9B** (см. §7) |

`node-fetch` был **мёртвой** зависимостью: ни один файл бандла его не
require'ит (проверено grep'ом по `worker/worker/*.cjs`; worker использует
global fetch, доступный с Node 18+/20+; комментарий в шапке `worker.cjs:4`
это явно фиксирует). Это единственный item, который Phase 9 audit пометила
к удалению («Мертвые зависимости | 1 … перед publish обязательно»).

### 2.3 Внешние сервисы / network endpoints

| Endpoint | Класс | Комментарий |
|---|---|---|
| `HUB_URL` (default `https://animastor.in/gpu`) — beacon/task/result/error | B | это и есть публичный контракт (Job Protocol v2); default prod URL параметризуем env |
| `ANIMASTOR_API_URL` (derived `<HUB_URL без /gpu>/api/v1`) — verify credential | B | то же |
| `http://127.0.0.1:COMFY_PORT` + `NOTEBOOK_PATH` — ComfyUI | B | предмет существования worker; локальный loopback |
| PostgreSQL | A: отсутствует | guarded |
| Redis | A: отсутствует | guarded (`dependency-guardrails` "no Redis") |

### 2.4 Shell / process execution

| Что | Где | Класс |
|---|---|---|
| `nvidia-smi` (execSync, fail-soft → unknown) | `worker.cjs:175` | B — system dep GPU-хоста, предмет runtime |
| `worker/start-worker.sh` — node install (Node 18), pkill worker, npm init | `worker/*.sh` | D — deployment adapter, не production-код worker |

Отдельно: `start-worker.sh` ставил `node-fetch@3` (строки 181-182) — та же
мёртвая зависимость в deployment-скрипте; удалено в 9B (см. §7).
`worker/new/start-worker.sh` — legacy-зеркало, сознательно НЕ тронуто.

### 2.5 Python / ComfyUI dependencies

Worker сам не ставит и не запускает Python/ComfyUI — только ждёт
`/system_stats` (`waitForComfyUI`) и ходит в `/prompt`, `/history`, `/view`.
Bootstrap ComfyUI — ответственность `worker/bootstrap-*.sh` /
`docker/worker/entrypoint.sh` / installer (D, deployment layer). ComfyUI
assumptions worker'а: HTTP API на `127.0.0.1:COMFY_PORT`, output-файлы на
диске в `COMFY_OUTPUT_DIR` (включая video subfolder), input-файлы в
`COMFY_INPUT_DIR`. Все параметризуемы env. Класс: B/D.

### 2.6 Docker / runtime assumptions

| Assumption | Где | Класс |
|---|---|---|
| Docker COPY только `entrypoint.sh` | `docker/worker/Dockerfile:28` | A — образ stateless, worker ставится installer'ом на volume; коплинга с monorepo paths нет |
| Hub монтирует `./worker/worker/worker.cjs` → `/app/worker-source/` | `docker-compose.yml:123` | **D** — артефактный канал (deprecated `/worker-source`) |
| Hub монтирует `./worker/worker/` → `/app/worker-bundle:ro` | `docker-compose.yml:126` | **D** — артефактный канал (`/worker-bundle` tar.gz) |
| Manifests `source.options.path: "worker/worker/"` (repo checkout как первый источник bundle) | `backend/ai/install-manifests/{image,audio,video}/*.json` | **D** — installer берёт bundle из repo checkout; fallback hub tarball уже есть |
| `/home/jovyan/ComfyUI/input` default | `worker.cjs:61` | D/B — legacy notebook default, параметризуем `COMFY_INPUT_DIR`; менять значение запрещено ТЗ |
| `/worker-bundle` в контейнере hub | `gpu-hub.js:1321` (`WORKER_BUNDLE_DIR`) | D — env-overridable |

**Осознанное решение:** D-класс не менялся в 9B. Volume mounts — это канал
доставки артефакта, а не кодовая зависимость; их разрыв (hub API delivery
вместо repo-mount) = изменение deployment architecture, что ТЗ явно
разрешает не делать («не менять deployment architecture без необходимости»).
Формально блокеры для extraction зафиксированы в §5.

## 3. Production import boundary — вердикт

| Проверка | Результат |
|---|---|
| Worker не импортирует backend production modules | ✅ (0 requires; guard R1, P7-T2) |
| Worker не импортирует GPU Hub production modules | ✅ |
| Worker не импортирует frontend code | ✅ |
| Worker не импортирует тесты | ✅ |
| Worker не имеет скрытых monorepo-only runtime helpers | ✅ (единственный кандидат — `node-fetch` из npm, не из monorepo; удалён) |

Обратное направление (кто требует worker) проверено: production-кода,
require'ящего `worker/worker/*`, нет — только backend **тесты**
(`worker-cleanup*.test.js`, `worker-bundle-env.test.js`, architecture tests
читают исходники как текст) и installer (файловая копия bundle, D-класс).
Это задокументированное состояние Phase 9 («переехать в пакет при
extraction; до тех пор жить в backend — guard читает исходники, не требует»).

**Изменений кода изоляции не потребовалось — граница уже чиста.**

## 4. Worker-owned configuration inventory

Полный env-контракт worker'а (значения НЕ менялись). Источник истины:
`worker/worker/.env.example`, install-manifests `worker_bundle.env`,
`worker.cjs:23-62`, `worker-cleanup-journal.cjs:32`.

| Имя | Источник | Default в коде | Обяз. | Формат | Runtime | В standalone package | Публичный API? |
|---|---|---|---|---|---|---|---|
| `ANIMASTOR_WORKER_TOKEN` | env / .env | null → **fail-closed exit(1)** | **да** | `wrk.<id_b64url>.<secret_b64url>` | да (auth) | да | **да** (credential) |
| `HUB_URL` | env / .env / start-worker.sh | `https://animastor.in/gpu` | да (по факту) | URL | да | да | **да** |
| `WORKER_TYPE` | env / .env | `image` | да | `image\|audio\|video` | да (lane) | да | **да** |
| `WORKER_ID` | env / .env | `gpu-<hostname>` | да | свободный label | да (label/query) | да | **да** |
| `ANIMASTOR_API_URL` | env / .env | derived из HUB_URL | нет | URL | да (verify) | да | **да** |
| `COMFY_PORT` | env / .env | `8188` | нет | порт | да | да | да (deployment-specific) |
| `COMFY_INPUT_DIR` | env / .env | `/home/jovyan/ComfyUI/input` | нет | path | да | да | да (deployment-specific) |
| `NOTEBOOK_PATH` | env / .env | `""` | нет | path prefix | да | да | нет |
| `WORKER_VERSION` | env | из `./package.json` | нет | semver | да (beacon/result) | да | да (telemetry) |
| `WORKER_IMAGE_TAG` | env | null | нет | строка | да (beacon/result) | да | нет |
| `RESULT_TIMEOUT_MS` | env | `600000` | нет | ms | да | да | нет (tuning) |
| `VIDEO_RESULT_TIMEOUT_MS` | env | `7200000` | нет | ms | да | да | нет (tuning) |
| `TASK_SLEEP_MS` | env | `2000` | нет | ms | да | да | нет (tuning) |
| `BEACON_INTERVAL_MS` | env | `10000` | нет | ms | да | да | нет (tuning) |
| `WORKER_JOURNAL_DIR` | env | `./cleanup-journal` (рядом с worker) | нет | path | да | да | нет (internal) |
| `HF_TOKEN` / `HUGGINGFACE_HUB_TOKEN` | env | — | нет | token | **нет** (installer-only, в .env.example для удобства) | нет | нет |

Свойств: (1) контракт **полностью замкнут** — нет ни одной backend-only
переменной; (2) `.env` loader собственный (`worker-env.cjs`), real env
всегда выигрывает; (3) все обязательные — часть публичного API (Job
Protocol v2 / credential model); (4) перенос в standalone package возможен
целиком, т.к. источник — только env/файл рядом с worker. **Значения не
менялись.**

## 5. Filesystem / path coupling

| Path | Где | Тип | Вердикт |
|---|---|---|---|
| `COMFY_INPUT_DIR` / `COMFY_OUTPUT_DIR` (= input/../output) | `worker.cjs:61-62` | runtime path, env | package/runtime path — уже параметризован; менять default нельзя (production behavior) |
| `WORKER_JOURNAL_DIR` default = рядом с worker.cjs | `worker-cleanup-journal.cjs:32` | runtime path | package-relative — корректно и для standalone |
| `./cleanup-journal`, `./.env` рядом с worker | bundle dir | runtime | package-relative — ок |
| `/home/jovyan/...` default | `worker.cjs:61`, `worker/fix-nodes-*.sh` | legacy notebook assumption | deployment default; параметризуем; НЕ менялся |
| Hub mounts `./worker/worker` → `/app/worker-bundle` | `docker-compose.yml:126` | **monorepo assumption** | blocker #1 для extraction (см. ниже) |
| Hub mounts `./worker/worker/worker.cjs` → `/app/worker-source` | `docker-compose.yml:123` | **monorepo assumption** | blocker #2 |
| Manifests `worker_bundle.files` + `source.options.path: "worker/worker/"` | install-manifests ×3 | **monorepo assumption** | blocker #3 (installer repo-checkout источник) |
| Installer `repoRoot/worker/worker` hard path | `backend/src/installer/engine/worker.js:52` | **monorepo assumption** | тот же blocker #3 (fallback-иерархия repo → hub tarball → /worker-source уже реализована) |
| `/tmp`-подобные temp dirs | нет своих; только job-артефакты в Comfy dirs | — | A |

**Итог:** внутренних runtime-path assumptions, мешающих standalone-коду,
нет. Все монорепо-paths — **deployment-каналы** (D), зафиксированы как
blockers Phase 9C, но в 9B не менялись (менять = менять deployment без
производственной необходимости; ТЗ это разрешает опустить).

## 6. npm / standalone readiness

**Будущий минимальный runtime dependency set:**

- **Node:** ≥ 20 (global fetch + AbortController; сейчас bundle-smoke гонялся
  на Node 22). Известное расхождение задокументировано Phase 9 (open
  question 11: start-worker.sh ставит Node 18) — deployment-уровень, не код.
- **npm dependencies:** **0** (после удаления `node-fetch`).
- **native/system:** NVIDIA driver + `nvidia-smi` в PATH (fail-soft),
  доступ по HTTP к ComfyUI на loopback. Больше ничего.
- **ComfyUI assumptions:** HTTP API (system_stats/prompt/history/view) +
  input/output directories на диске, video output в `output/video/*.mp4`.

**Проверка запуска в чистой директории без Animastor-репозитория — ВЫПОЛНЕНА
(standalone smoke, `/tmp/opencode/worker-standalone`):**

1. Скопированы ровно 7 файлов канонического bundle: `worker.cjs`,
   `worker-env.cjs`, `worker-cleanup.cjs`, `worker-cleanup-journal.cjs`,
   `package.json`, `package-lock.json`, `.env.example`.
2. `node worker.cjs` → корректный **fail-closed** startup gate (нет токена →
   exit 1 с инструкцией) — ожидаемое production-поведение, код полностью
   загрузился, ни одного missing-module.
3. `npm install --omit=dev` → «up to date», **0 пакетов** в `node_modules`.
4. `require('./package.json').version` → `2.0.0`, `typeof fetch === 'function'`.

**Blocker'ов для запуска кода нет.** Остающиеся (deployment/contract, не
запуск-критичные) — перенесены в §10 recommendation для Phase 9C.

## 7. Изменения Phase 9B (minimal safe changes)

Ровно одно реальное production-устранение, связанный guard и их документация:

1. **Удалена мёртвая зависимость `node-fetch@^3.3.2`**
   - `worker/worker/package.json` — убран блок `dependencies`
     (worker использует global fetch Node 20+; зависимость никогда не
     require'илась; помечена к удалению ещё Phase 9 audit, §Action 1).
   - `worker/worker/package-lock.json` — регенерирован
     (`npm install --package-lock-only`): удалены `node-fetch`,
     `data-uri-to-buffer`, `fetch-blob`, `web-streams-polyfill`.
   - `worker/start-worker.sh` — удалён блок `npm list node-fetch@3 ||
     npm install node-fetch@3`, секция NPM SETUP получила комментарий о
     zero-dependency bundle. **Поведение скрипта сохранено:** `npm init`
     fallback остался; удаление install-шага не меняет никакого
     production-пути, т.к. ставился пакет, который не используется.
   - `worker/new/start-worker.sh` — НЕ тронут (legacy-зеркало, вне скоупа).
2. **Добавлен targeted guard** в существующий suite
   `backend/tests/architecture/dependency-guardrails.test.js` (describe
   "architecture: worker isolation"):
   *«canonical worker bundle declares ZERO runtime npm dependencies
   (standalone readiness)»* — фиксирует отсутствие `dependencies` /
   `optionalDependencies` в каноническом `package.json` и наличие
   semver-версии. Это первый post-extraction guard на стабильной границе
   (package.json канонического bundle существует с Phase 3).
3. **Настоящий документ** (`docs/architecture/PHASE_9B_…AUDIT.md`) —
   документирование dependency removal.

Protocol version, endpoints, auth, таймауты, payload — не менялись.
`protocol_version = 2` не менялся.

## 8. Worker public surface (предварительная граница standalone)

```
Animastor backend / GPU Hub
          ↓
     Job Protocol v2                       ← public contract
   (beacon/task/result/error/verify;
    frozen в PHASE_9A: JOB_PROTOCOL_V2.md)
          ↓
    Worker public API                      ← runtime configuration
   (env-контракт §4: credential, HUB_URL,
    WORKER_TYPE/ID, Comfy paths; .env файл)
          ↓
       Worker                              ← internal implementation
   (worker.cjs + cleanup + journal + env;
    zero npm deps; journal формат internal,
    не контракт)
          ↓
       ComfyUI                             ← deployment adapter
   (local HTTP + filesystem contract;
    bootstrap — вне worker)
```

| Слой | Состав | Меняется в 9B? |
|---|---|---|
| public contract | Job Protocol v2 (envelope, grammar, endpoints, timeout semantics) | нет (frozen 9A) |
| runtime configuration | env-контракт §4 + `.env` файл | нет (инвентаризация) |
| internal implementation | `worker/worker/*.cjs`, journal lifecycle, MIME map, polling/backoff | нет |
| deployment adapter | start-worker.sh, bootstrap-*.sh, docker/worker, installer engine, hub mounts | нет (зафиксирован) |

## 9. Guards — текущее состояние и post-extraction план

**Существующие (все зелёные после 9B):**

| Guard | Файл | Что фиксирует |
|---|---|---|
| R1 builtin-allowlist worker | `dependency-guardrails.test.js:47` | только node builtins + собственные файлы |
| R1 ban backend-domains | `:60` | нет слов postgres/book/generation и т.п. |
| R1 no Redis | `:68` | HTTP-only к hub |
| **NEW (9B)** zero runtime deps | `:74` | package.json без dependencies/optionalDependencies |
| P7-T2 no inbound requires | `phase7-extraction-readiness.test.js:82` | никто не require'ит worker/worker/ |
| Job Protocol v2 sync ×3 | `phase2-job-protocol-v2.test.js:33` | `protocol_version = 2` во всех копиях |
| Bundle version single-source | `installer-setup-contract.test.js`, `gpu-hub-artifacts.test.js` | hub берёт версию из канонического package.json |
| Bundle tarball состав ×7 файлов | `gpu-hub-artifacts.test.js:134` | канонический состав артефакта |

**Новые guards, понадобятся ПОСЛЕ extraction (Phase 9C+), в 9B не пишутся
(нет стабильной новой границы):**

1. `@animastor/contracts` существует и worker/hub импортируют Job Protocol
   только оттуда (пока контракт живёт ×3 SYNC-копиями — guard синхронизации
   уже есть, его достаточно);
2. физический `packages/worker/` не require'ит ничего из `backend/src`,
   `gpu-hub/`, `frontends/` (обобщённый вариант текущего R1 на новую
   структуру);
3. npm-publishable пакет не содержит monorepo-only путей
   (`source.options.path`-типа) в манифестах/доках артефакта;
4. hub `/worker-bundle` строится из package-источника, а не из repo-mount
   (появится при переходе канала доставки).

## 10. Найденные blockers (для Phase 9C, не для 9B)

1. **Артефактный канал через repo volume mounts** (`docker-compose.yml:123,126`):
   hub раздаёт bundle из монтированного `./worker/worker/`. Перемещение
   каталога при extraction сломает dev-deployment. Endpoints `/worker-bundle`
   уже готовы — нужно переключить источник на package (это изменение
   deployment, вне скоупа 9B).
2. **Install-manifests `source.options.path: "worker/worker/"`** ×3 +
   installer `engine/worker.js:52` (`repoRoot/worker/worker`): repo-checkout
   как первый источник bundle. Fallback-иерархия (repo → hub tarball →
   `/worker-source`) уже реализована, поэтому это подготовка, а не блокер
   запуска.
3. **Job Protocol v2 как unpublished контракт** (×3 SYNC-копии): предмет
   Phase 9C (`@animastor/contracts`). Кодовая изоляция от этого не зависит.
4. **Node version mismatch** (start-worker.sh ставит Node 18; worker
   требует 20+ для global fetch): deployment-скрипт, задокументировано
   Phase 9 open question 11; на код bundle не влияет.

## 11. Test results (после 9B vs baseline)

| Suite | Baseline (до 9B) | После 9B | Дельта |
|---|---|---|---|
| Worker unit (cleanup/journal/bundle-env) | 32 pass / 0 fail | **32 pass / 0 fail** | без изменений |
| Architecture (`test:arch`) | 229 pass / 1 fail (F6) | **230 pass / 1 fail (F6)** | **+1 pass** (новый zero-deps guard), та же единственная F6 |
| Full backend (`mocha --exit "tests/*.test.js"`) | 2568 pass / 2 fail (F1/F2 LLM Sharing) | **2568 pass / 2 fail (F1/F2 LLM Sharing)** | без изменений, те же pre-existing |
| Syntax smoke (`scripts/syntax-smoke.sh`) | pass | **pass** | без изменений |
| Standalone clean-dir smoke (новый, ручной) | не проводился | **PASS** (fail-closed gate, 0 npm-пакетов) | + |

Все failures — **pre-existing** (F6 LAC; F1/F2 LLM Sharing), известные с
Phase 8B/8D/9, к Worker не относятся, в 9B не исправлялись (по ТЗ).
Новых failures нет.

## 12. Verdicts

> **PHASE 9B: PASS WITH PREPARATION**

Кодовая изоляция Worker готова и доказана; единственная реальная
зависимость (мёртвый `node-fetch`) устранена минимальным изменением;
zero-runtime-deps зафиксировано guard'ом; standalone-запуск в чистой
директории проверен. Остаются задокументированные deployment-подготовки
(volume mounts, manifest source, contracts package) — это Phase 9C, не
блокеры кода.

> **WORKER STANDALONE: READY**

Bundle запускается в чистой директории без Animastor-репозитория с нулевым
runtime dependency set (`node worker.cjs`; npm install — no-op).
Canonical deployment-канал (hub API delivery) работает; repo-mount канал
остаётся только как dev-удобство и зафиксирован как blocker подготовки 9C.

## 13. Exact recommendation for Phase 9C

1. **Создать `@animastor/contracts`** (Job Protocol v2 как
   version-несущая спецификация: schema, envelope, endpoints, timeout
   semantics, error taxonomy) — единственный источник, на который
   ссылаются hub/worker/backend вместо ×3 SYNC-комментариев.
2. **Разорвать repo-mount артефактный канал**: `docker-compose.yml` hub
   берёт worker-bundle из package-директории (или из собранного tarball),
   manifests `source.options.path` → package path; installer fallback уже
   готов.
3. **Только после 1-2: физический extraction** `worker/worker/` →
   standalone package (worker/ → packages/worker/ либо отдельный репо —
   по решению), перенос worker-тестов из backend/tests в пакет,
   актуализация guards (§9 п.1-4).
4. Fix Node 18 → 20 в start-worker.sh при следующем касании
   deployment-скрипта (не блокер).

**Next step:** Phase 9C — `@animastor/contracts` (Job Protocol v2 package).
