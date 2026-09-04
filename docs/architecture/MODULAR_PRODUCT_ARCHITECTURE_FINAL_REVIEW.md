# Animastor — Final Architecture Review

**Status:** Final Architectural Report (audit only, no code changed)
**Date:** 2026-09-04
**Inputs:**
- First architectural reconnaissance — commit `baa85ad4` (`MODULAR_PRODUCT_ARCHITECTURE_RECONNAISSANCE.md`)
- Independent adversarial audit — commit `313c95e1` (`MODULAR_PRODUCT_ARCHITECTURE_RECONNAISSANCE_V2.md`)
**Baseline:** HEAD `313c95e1` (code identical to the V2 baseline; every disputed claim of both audits was re-verified against source)
**Method:** Neither audit was accepted on authority. All disputed claims were falsified/confirmed directly against HEAD: chat-transport surface in `ai-routes.cjs`, DELETE-book purge list in `core-routes.cjs`, cycle edges in `runtime/*` (top-level and lazy), SQL-outside-storage via `require postgres/database` scan, Redis keyspace ownership backend/hub, docker-compose mounts, queue-clear duplication, `loadDraftBook` consumer count, `storage/index.js` exports, `job-schema` protocol copies.

---

## 0. Final verdict

**Инфраструктура почти модульна, ядро — нет.**

Worker и Local AI Connector — готовые к выделению продукты. GPU Hub **выглядит** самостоятельным, но не является: общий Redis — двусторонний канал записи (4 семьи ключей: worker-auth, heartbeat, workers-registry, policy-queues), плюс volume-маунты артефактов backend/worker (`docker-compose.yml:126-128`). Ядро генерации держит структурный цикл (≥5 файлов) и растущий прямой SQL (22 файла вне storage на HEAD, против 11 по аудиту 1 и 16 по аудиту 2). Book Model расщеплён: контент каноничен в JSON-бандле, identity/ownership — только в PG.

Ошибки первого аудита подтвердились; все corrections / missing / risk-changes второго аудита **подтверждены кодом**.

---

## 1. Что подтвердилось из обоих аудитов

- Метрики инвентаризации (wc -l совпадают), DI-bag `backend.cjs:200-210` (~30 ключей `routeDeps`).
- Два расходящихся загрузчика: `loadBook` (`book/index.js:543`, по `chapters_order`) vs `loadDraftBook` (`lazy-book/draft.js:87`, главы по алфавиту, sourceText/mentions).
- Цикл orchestration↔runtime — существует (детали см. §3: оценка аудита 1 была неполной).
- Frontend-шов: `fetch()` вне `api/client.ts` — 0 вызовов; `generateStore ⇄ playbackStore` развязан через `wirePlaybackCoordination`.
- `job-schema.js` — контракт трёх сервисов: `protocol_version=2`, SYNC-копии (`job-schema.js` ↔ `gpu-hub.js:33` ↔ `worker.cjs:49`).
- `sendUnified` (`gpu-dispatcher.js:209`) — единственный `POST /task`; worker самодостаточен (один `POST /worker/verify`, `worker.cjs:117-120,729`).
- VBook = zip бандла, manifest vbook_version 3.1, `buildBookFromBundle` (`book/index.js:252-279`) требует канонические id `ch-/sc-/iu-`; frontend не читает .vbook.
- Local AI Connector: единственная зависимость `ws`; EPUB/PDF/DOCX отсутствуют.
- `workflows/video/video-workflows.js` тянет book-домен + image-хелперы + SQL `image_units`.
- Сырые ComfyUI-знания: `audio/generation.js:19-20,492` (имена workflow, raw node-id).
- Redis-mirror `animastor:worker-auth`: backend пишет (`worker-auth.js:29`), hub читает (`gpu-hub.js:41`).
- Queue-clear скопирован в 4 места — все через один HTTP API hub: `dispatch-engine.js:1321` (dispatch-scoped), `generation-routes.cjs:311`, `core-routes.cjs:854`, `cache-routes.cjs:117` (book-scoped).
- `worker-routes.cjs:414` — `hdel animastor:gpu-hub:workers` из backend.
- `auth-service.js:356` → book-repo (workspace-проверки).
- EditPage → playbackStore напрямую; PlayPage/NavigatePage → generateStore (`NavigatePage.tsx:9`, `PlayPage.tsx:21`).

## 2. Что было ошибочно (аудит 1; проверено на HEAD)

| Утверждение аудита 1 | Факт (HEAD) |
|---|---|
| «Дубль fetch к LLM в `routes/ai-routes.cjs:432-444`» | **Ложь.** Chat-роут — самостоятельный транспорт: SSE (`:1033`), tools (`:569-570`), AbortController, connector-транспорт (`:501-534`), shared-pool (`runSharedInference`, `:530`). `callAI` — `stream:false` без этих возможностей. «Склейка» сломала бы стриминг и Local AI. Correction V2 подтверждена полностью |
| DELETE book чистит 15 таблиц | **24 таблицы** (`core-routes.cjs:808-837`) + require `runtime/scene-window` (`:798`) + `redis.del` runtime-счётчиков (`:800-802`) + hub clear (`:854`) |
| Цикл «замаскирован lazy-require» | **Структурный**: top-level рёбра `scene-window.js:22` → orchestrator, `dispatch-engine.js:9` → event-journal, `runtime-persistence.js:12` → event-journal; +7 lazy-require в `reconciliation-engine.js` (:1084, :1207, :1233, :1254, :1279, :1317, :2115) и `runtime-scheduler.js:271` |
| Прямой SQL вне storage — 11 файлов | **16 на дату V2, 22 сейчас** (`require postgres/database` вне storage) — coupling растёт |
| «PG — производная» | Верно **только для контента**. `books.workspace_id` (`book-repo.getWorkspaceId:86`), `book_source` — только PG; VBook-бандл не содержит ownership и не переносим между инсталляциями |
| `storage/index.js` — «3-слойный фасад» | Инверсия storage→services: экспортирует `bookSync/bookEventLog/bookSource/layerConfig/genScope` (`storage/index.js:21-28`) |
| Pipeline-steps пишет книгу напрямую | Неточна: fs-записи в `lazy-book/create.js`; agent-pipeline пишет через book-domain API (`bootstrap.js:227` → `lazyBook.createFromAnalysis`) |
| Пропущено аудитом 1 | `drainPolicyLane` (`worker-routes.cjs:146-168`): backend делает RPOPLPUSH между очередями hub (`animastor:queue:{type}:policy:{id}` → `animastor:queue:{type}`) и **мутирует содержимое задач** (вычищает `policy_id`); heartbeat-ключи пишет backend (`runtime/worker-health.js`), читает hub (`gpu-hub.js:462,712,1021,1126,1244`); mount-куплинг hub (`docker-compose.yml:126-128`: `./worker/worker`, `./backend/ai/workflows`); пути `/api/v1/...` захардкожены вне client.ts в 5 местах |

**По аудиту 2:** материальных ошибок не найдено. Единственный устаревший пункт — счётчик SQL-файлов (16 → 22): дрейф в сторону ухудшения, что подтверждает его тезис о росте coupling.

## 3. Критичные проблемы (реально критичны)

1. **Book purge в route-слое** — 24 таблицы + runtime Redis + scene-window + hub clear из DELETE-роута (`core-routes.cjs:738-858`); book-домен — единственный писатель во все чужие домены.
2. **Общий Redis backend↔gpu-hub — двусторонний канал записи**, а не «зеркало»: worker-auth (backend пишет / hub читает), heartbeat (backend пишет / hub читает), workers-registry (hub пишет / backend hdel), policy-queues (backend мутирует элементы). Главный блокер выделения hub.
3. **Цикл orchestration↔runtime структурный**, ≥5 файлов, top-level рёбра; + прямой SQL в runtime-scheduler/iu-processor/reconciliation.
4. **Прямой SQL вне storage — 22 файла и растёт**; границы не enforcing'ся ничем.
5. **Chat-транспорт** (продуктовая фича: SSE + tools + connector + shared-pool) живёт внутри роут-файла без зафиксированного контракта.
6. **Identity/ownership PG-only** при JSON-контенте — Book Model непереносим без design-решения.

Второстепенные (не блокируют): 4 копии queue-clear (все через один API hub — безопасно свернуть в helper), god-services (layer-config ×12, workspace-ai-provider ×7, task-handler ×7), дублирование Android-контракта (~2337 строк — осознанная паритетность, риск синхронизации), 5 захардкоженных media-путей в pages, размер EditPage (2895).

---

## 4. Final module map

| Module | Current state | Real boundary | Main coupling | Risk | Extraction readiness | Recommended next step |
|---|---|---|---|---|---|---|
| **Core** | composition root + DI-bag 30 ключей; storage экспортирует services (инверсия) | DI-bag как явный контракт | всё через `routeDeps` | 🟠 | низкая | lint-правила; убрать services из `storage/index` |
| **Book Model** | JSON-бандл каноничен (контент); identity в PG; 2 загрузчика | `loadBook`/`saveBookBundle`/validator | purge 24 таблиц; book-sync→8 таблиц; PG identity | 🟠 | средняя | единый `loadBook(id,{mode})`; purge→entity-cleanup |
| **Parser** | TXT + agent-LLM pipeline; пишет через book-domain API | `import(source)→DraftBook` | PG `agent_sessions`, Redis-триггеры | 🟡 | средняя | отделить deterministic parse от AI-pipeline |
| **VBook** | zip-бандл, спека неявна в validator+builder; версий/миграций нет; ридера нет | `parse/serialize` + JSON Schema | `config.BOOKS_DIR`, id-генераторы, ownership в PG | 🟡 | формат — быстро | JSON Schema v3.1; фиксировать отсутствие ownership-полей |
| **Player** | тонкая вьюха + playbackStore 2117 (1:1 Android) | `BookRuntime` DTO | 6 REST-эндпоинтов, build_id, generateStore | 🟡 | средняя | DTO поверх `api/models.ts` |
| **Editor** | EditPage 2895, server round-trip, захардкоженная схема | `BookModelEdit` commands | REST PATCH-ы, playbackStore, PG-поля | 🟠 | слабая | клиентская модель-обёртка (после Book Model) |
| **Generation** | orchestration↔runtime цикл ≥5 файлов; reconciliation 2326; SQL в runtime | фасад orchestrator + event-journal | цикл, callback-роуты, SQL, scheduler→scenes | 🔴 | слабая до разрыва цикла | заморозка рёбер правилами; top-level рёбра первыми |
| **Provider Gateway** | 3 транспорта: callAI (агенты), chat (SSE/tools/connector/pool), ComfyUI | facade с 3 явными под-интерфейсами | node-id в `audio/generation.js`, video-workflows→book+SQL, срастание workspace-ai-provider с LAC | 🟡 | средняя | зафиксировать chat-контракт как интерфейс; НЕ склеивать транспорты |
| **GPU Hub** | «dumb transport», без БД — но 4 семьи shared-keys + обязательные бизнес-поля envelope (`gpu-hub.js:766`) + маунты | HTTP API `/task,/task/next,/task/result,/beacon,/queue/clear` | Redis-канал, backend-мутации очередей/реестра, volume-mounts | 🔴 | **пока нет** (выглядит модулем) | контракт: `payload.meta`, hub-owned auth/heartbeat, артефакты через API |
| **Worker** | самодостаточный бандл, не знает бизнес-понятий | job envelope v2 | токен `wrk.*`, 1 verify | 🟢 | готов | версионный контракт protocol_version |
| **Local AI Connector** | автономный CLI, WS v1, одна зависимость `ws` | WS-протокол `/api/v1/ai-connector/ws` | растущее срастание с workspace-ai-provider (shared-pool) | 🟢 | готов сейчас | shared-pool держать за интерфейсом |
| **Navigator** | 407 строк, дерево, positionStore | — | generateStore (bookId/buildId) | 🟢 | готов | — |
| **Cache** | Redis-ключи размазаны; PG cache_entries полумёртвые | реестр владельцев в `config.REDIS` | все домены | 🟡 | низкая ценность | реестр владельцев (4 семьи + runtime + queues) |

---

## 5. Final migration roadmap (7 фаз)

### Phase 1 — Guardrails & Contracts (см. §6)
Цель: остановить рост coupling без изменения поведения. Зависимости: нет.

### Phase 2 — Book Model
- Единая точка `loadBook(bookId, {mode:'draft'|'canonical'})` — **не** удаление draft-семантики: 18+ потребителей реально используют её (import-routes ×5, status-routes, parse-routes ×2, agent/bootstrap, txt-importer ×2, recent-books, fallback-цепочки `ai-routes.cjs:423,968` — легализовать как явный режим).
- Purge из DELETE-роута → `entity-cleanup.cjs` (приёмник существует, уже переиспользует `bookSync.purgeRemovedSceneRows`).
- Тесты: parity-loaders (chapters_order vs alphabetical); purge-инвариант «после DELETE — 0 строк во всех 24 таблицах + чистые Redis runtime-ключи + пустые очереди hub».
- Зависит от: Phase 1.

### Phase 3 — Database boundary
- Консолидация SQL: purge → entity-cleanup; runtime SQL (`runtime-scheduler.js:217`, `iu-processor.js:132-154`, reconciliation) → repositories; video-workflows → repo.
- Тесты: те же результаты через repo-слой; whitelist-lint краснеет на новые файлы.
- Зависит от: Phase 2.

### Phase 4 — Provider Gateway
- Facade с 3 под-интерфейсами: `generateText` (callAI-семантика) / `chat` (SSE+tools+connector+pool) / `generateMedia` (ComfyUI).
- Убрать raw node-id (`audio/generation.js:492`) и book-import из video-workflows.
- Тесты: SSE/tools/connector/shared-pool E2E без изменения поведения.
- Зависит от: Phase 1 (не P2/P3 — может идти параллельно).

### Phase 5 — GPU Hub контракт
- Envelope `payload.meta` вместо обязательных `book_id/chapter_id/scene_id`.
- Heartbeat / registry / queue-drain — только через hub API (убрать `drainPolicyLane`-мутации и `hdel` из backend).
- Артефакты (worker-bundle, workflows) — версионированные через API вместо volume-mounts.
- Тесты: worker auth + beacon liveness + policy-lane drain против hub в изоляции.
- Зависит от: Phase 1.

### Phase 6 — Разрыв цикла orchestration↔runtime
- Сначала top-level рёбра (`scene-window.js:22`, `dispatch-engine.js:9`, `runtime-persistence.js:12` — сузить до event-journal), затем 7 lazy-require в reconciliation через события/saga.
- Тесты: full generation pipeline regression + reconciliation воссоздание сцен.
- Зависит от: Phase 3 (SQL из runtime уже вынесен).

### Phase 7 — Frontend & VBook Runtime
- `BookRuntime` DTO; клиентская модель-обёртка Editor; локальный ридер .vbook.
- Тесты: offline-плейлист из .vbook == server-driven.
- Зависит от: Phase 2, Phase 1 (schema).

*(опционально Phase 8 — репо-выделение gpu-hub/worker/local-ai; зависит от Phase 5.)*

---

## 6. Phase 1 — точный план (без изменения рантайм-поведения)

1. **Dependency-cruiser/madge в CI** с правилами-заморозками (новые нарушения блокируются, существующие — baseline-список):
   - запрет top-level `runtime/* → orchestration/*` кроме event-journal;
   - запрет `require postgres/database` вне whitelist (22 файла = стартовый baseline);
   - запрет `workflows/* → book/*`;
   - запрет `fetch(` вне `api/client.ts` в frontends.
2. **Redis keyspace owner-registry** (документ в `config.REDIS` + проверяемый тестом список):
   - `animastor:worker-auth` — backend пишет / hub читает;
   - `animastor:worker:heartbeat:*` — backend пишет / hub читает;
   - `animastor:gpu-hub:workers` — hub пишет / backend hdel (пометить как debt);
   - `animastor:queue:*` policy-lanes — backend мутирует RPOPLPUSH (пометить как debt);
   - `animastor:runtime:*`.
3. **VBook JSON Schema v3.1** из `bundle-validator.cjs` (+ тест соответствия validator↔schema), явно фиксирующая отсутствие ownership-полей в бандле.
4. **Chat-transport contract** — документ-интерфейс SSE+tools+connector+shared-pool (`ai-routes.cjs:501-1153`) как единственный специфицированный вход.
5. *(опционально, микро)* Свернуть 4 копии queue-clear в один hub-client helper — все зовут один и тот же HTTP API hub, риск нулевой.

**Инварианты Phase 1:** ноль изменений рантайм-поведения; все тесты зелёные; CI падает на новые циклические рёбра / SQL-файлы / импорты.

---

## 7. Top 5 вещей, которые сейчас НЕЛЬЗЯ трогать

1. **`reconciliation-engine.js` (2326) и все 10 точек цикла** — до Phase 3/6 и расширения тестового покрытия; правка = регрессии всего пайплайна.
2. **`playbackStore.ts` ⇄ `PlaybackViewModel.kt`** — паритет 1:1 платформ; любое одностороннее изменение рассинхронизирует web/android.
3. **Redis shared-keys семейства** (`worker-auth`, `heartbeat:*`, `gpu-hub:workers`, policy-queues) — переименование/перемещение мгновенно ломает аутентификацию и liveness воркеров; только после hub API (Phase 5).
4. **`loadDraftBook` и fallback-цепочки** — draft-семантика реально используется 18+ потребителями; «унификация» без mode-параметра сломает import/agent/AI-контекст.
5. **Job envelope v2 / `protocol_version` SYNC-копии** (job-schema ↔ gpu-hub ↔ worker) — контракт трёх сервисов, синхронизируемый вручную; миграция только как v3 с трёхсторонним планом.

---

## Методика и проверяемость

Все выводы проверяемы на HEAD `313c95e1` по указанным файлам/строкам: `backend/src/routes/ai-routes.cjs` (chat-транспорт :423,501-534,561-584,1033), `backend/src/routes/book/core-routes.cjs` (:798-855 purge), `backend/src/routes/worker-routes.cjs` (:146-168 drainPolicyLane, :414 hdel), `backend/src/runtime/{scene-window:22, dispatch-engine:9,461,826,886, runtime-persistence:12, reconciliation-engine, runtime-scheduler:217,271, worker-health}.js`, `backend/src/storage/index.js` (:21-28), `backend/src/storage/postgres/repositories/book-repo.js` (:86 getWorkspaceId), `gpu-hub/gpu-hub.js` (:41,299,462,712,766,1021,1126,1244), `docker-compose.yml` (:126-128), `frontends/app/src/pages/*.tsx` (generateStore-импорты, захардкоженные пути), `worker/worker/worker.cjs`.

Код не изменялся. Коммит содержит только этот документ.
