# Animastor — Modular Architecture Reconnaissance

**Status:** Reconnaissance Report (audit only, no code changed)
**Date:** 2026-09-03
**Input:** `docs/architecture/MODULAR_PRODUCT_ARCHITECTURE.md`
**Scope:** Сопоставление фактического кода с целевой модульной архитектурой. Оценка рисков выделения модулей, точки безопасного разреза (seams), план миграции.

---

## 0. Executive Summary

**Verdict: частично готов.**

Инфраструктурный контур (GPU Hub, Worker, Local AI Connector) уже де-факто модульный и местами готов к выделению «как есть». Книжная модель — плоский JSON-бандл на диске, а не ORM, что является отличным фундаментом для canonical Book Model. Но ядро генерации (orchestration ↔ runtime, ~15k строк) переплетено циклическими импортами и общим Redis-пространством, а VBook — пока не модуль, а файловая конвенция. Фронтенд привязан к backend-схеме, но имеет один чистый API-seam (`frontends/app/src/api/client.ts`).

**Главный парадокс:** самые «продуктовые» по MD-документу модули (VBook, Player, Editor) наименее готовы, а самые «инфраструктурные» (Worker, Local AI) — уже почти независимые продукты.

---

## 1. Фактические границы модулей

| Модуль | Где живёт сейчас | Состояние |
|---|---|---|
| **Core** | `backend/src/backend.cjs` (604 строки, composition root + DI-bag на 30+ ключей), `config/runtime-config.js` (глобальный синглтон), `storage/` (`schema.js` 1642 строки, 39 таблиц, 15 репозиториев), `state/scene-state.js`, `middleware/` | Формального core нет; core = composition root + storage + state + config |
| **Book Domain** | `backend/src/book/index.js` (848) — load/save JSON-бандла из `/data/books/<id>/`; `book/bundle-validator.cjs` (284) — контракт данных; `book/lazy-book/` (11 файлов ~2000 строк) | **Canonical Book Model существует** — plain JS-объект из JSON-файлов, PG — производная. Но два расходящихся загрузчика: `book/index.js loadBook` (по `chapters_order`) vs `lazy-book/draft.js loadDraftBook` (все файлы по алфавиту) |
| **Parser/Import** | `book/lazy-book/parser.js`, `parse.js`, `create.js`; `services/structure-detector.js` (1231), `txt-importer.js` (298), `encoding-detect.js`, `language-detector.js`; `services/agent/*` (pipeline-steps 1594 + pipeline-runner 1370) | Только TXT и .vbook. **EPUB/PDF/DOCX отсутствуют** (нет ни кода, ни зависимостей в `backend/package.json`) |
| **VBook** | Формат = zip каталога книги: `book/index.js` (`addDirToZip`/`extractBookBundle`/`buildBookFromBundle`), маршруты `routes/book/export-routes.cjs:54` (`/download`), `import-routes.cjs:412` (`/load-vbook`). Спецификация неявно закодирована в `bundle-validator.cjs` | Не модуль: нет сериализатора как API, нет версий/миграций, frontend не умеет читать .vbook |
| **Player** | `frontends/app/src/pages/PlayPage.tsx` (307, тонкая вьюха) + `state/playbackStore.ts` (2117, движок, 7-состоянийный FSM, документирован как 1:1 порт Android `PlaybackViewModel.kt` 1086 строк) | Полностью server-driven: REST `/book/{id}`, `/scene/.../status\|audio\|storyboard\|video`, `/iu-image`; video стримится, audio/картинки — Cache API (`cache/mediaCache.ts`). VBook не знает |
| **Editor** | `frontends/app/src/pages/EditPage.tsx` (2895!) + `lib/entityEditor.tsx` (424); backend: `routes/book/core-routes.cjs` + `entity-crud-routes.cjs` (727) | Backend — единственный источник истины, каждое сохранение = write + re-GET. Поля захардкожены (`audio.speaker`, `video_tokens`...). Вызывает `playbackStore` напрямую |
| **Generation** | `backend/src/orchestration/` (scene-orchestrator, orchestrator-фасад, scene-callbacks, event-journal), `runtime/` (18 файлов, 10 408 строк: dispatch-engine 1706, reconciliation-engine 2326, scheduler 662), `audio/`, `image/`, `video/`, `workflows/` | Самое тяжёлое ядро системы (см. §7) |
| **Provider Gateway** | LLM: `services/ai-service.js` (`callAI`), `services/workspace-ai-provider.js` (резолюция per-workspace, AES-ключи), `services/system-ai.js`, `services/ai-connector/transport.js` (чистый интерфейс к локальным LLM). ComfyUI: `workflows/workflow-loader.js` + `connector-loader.js` + `backend/ai/connectors/*.json` (декларативные биндинги) | Единого гейтвея нет — знания о провайдерах размазаны по трём швам, но иерархия есть |
| **GPU Hub** | `gpu-hub/gpu-hub.js` (2029, express+ioredis), `server.js`, `bootstrap.js`, `tarball.js` | Самоописание в коде: *«dumb transport: ownership is DATA»* (gpu-hub.js:21). Без БД — Redis-очереди `animastor:queue:{type}[:ws:{ws}|:policy:{id}]`. Бизнес-логики нет |
| **Worker** | `worker/worker/worker.cjs` (744, самодостаточный бандл: node-fetch, свой журнал крашей, cleanup), ComfyUI как локальный рантайм | О бизнес-понятиях не знает: читает только `task.params` (готовый ComfyUI-граф). Один вызов backend `POST /worker/verify` при старте |
| **Projects** | Модуля нет. Рудименты: PG `books`+`workspaces`+`book_source`, `routes/book/recent-books-routes.cjs` | — |
| **Navigator** | `frontends/app/src/pages/NavigatePage.tsx` (407) — дерево по одному `GET /book/{id}` + `positionStore` | Тонкая, чистая |
| **Cache** | Frontend: `cache/mediaCache.ts` (Cache API). Backend: Redis (`helpers/redis-helpers.cjs`, `state/scene-state.js`), PG `cache_entries`/`output_manifests` (почти мёртвые — только purge-SQL) | Redis-keyspace — неявная общая «БД» backend↔gpu-hub |
| **Local AI** | `local-ai-connector/` (index.cjs + lib/, WS-протокол v1, только исходящий коннект) + `backend/src/routes/ai-connector-routes.cjs` (889) + `services/ai-connector/*` + PG `ai_connectors` | **Полностью автономный продукт уже сейчас** (одна зависимость `ws`) |

---

## 2. Dependency map

```
Frontend (web/android)
 └──> Backend REST /api/v1   ← единственный seam: api/client.ts (fetch вне api/ — 0 вызовов)

Backend:
 Routes ──> book, orchestration, runtime, services, storage, state
 Book ──> config, utils, services/{language,structure}-detector   (чисто, обратных зависимостей НЕТ)
 Orchestration ──> book, audio, image, video, runtime, state, storage, workflows
 Runtime ──> orchestration (ЦИКЛ), state, storage, book (lazy), config
 Audio/Image/Video ──> runtime/gpu-dispatcher, workflows, state, config
 Workflows ──> book (!), image/{character-utils,assembly-profile,helpers} (!), storage (прямой SQL к image_units !)
 Services ──> storage, state, book, runtime (task-handler → dispatch-engine)
 Auth ──> book-repo (workspace-проверки: auth-service.js:356)
 Всё ──> storage, config, state

 GPU Hub ──> Redis (читает аутентификатор, ЗАПИСЫВАЕМЫЙ backend'ом: worker-auth.js mirror)
 Worker ──> GPU Hub (+1 verify в backend)
 Local AI Connector ──> backend WS (/api/v1/ai-connector/ws)
```

### Problematic

```
1. orchestration/orchestrator.js:38,47,74 ──> runtime/{runtime-scheduler,dispatch-engine}
   runtime/dispatch-engine.js:461,826 ──> orchestration/orchestrator.js        [ЦИКЛ, замаскирован lazy-require]
   image/iu-processor.js:53 ──> runtime/dispatch-engine ──> orchestration ──> image

2. routes/book/core-routes.cjs:806-846 (DELETE book) ──> 15 чужих таблиц напрямую
   routes/book/cache-routes.cjs:60-107 ──> 20 таблиц напрямую
   services/book-sync.js:293-317 ──> purge по 8 таблицам image/audio/generation домена
   [book-домен — единственный писатель в чужие таблицы]

3. routes/worker-routes.cjs:414 ──> пишет Redis-хеш gpu-hub animastor:gpu-hub:workers напрямую
   [shared-Redis как скрытый канал между сервисами]

4. Очистка очереди hub'а скопирована в 4 места:
   runtime/dispatch-engine.js:1304, routes/book/{generation-routes.cjs:309, cache-routes.cjs:109, core-routes.cjs:846}

5. workflows/video/video-workflows.js (provider-слой) ──> book domain + image/helpers + SQL image_units
   [provider-слой знает домен]

6. routes/ai-routes.cjs:432-444 — дубль fetch к LLM в обход services/ai-service.js

7. generateStore.ts ⇄ playbackStore.ts — осознанный цикл (развязан через wirePlaybackCoordination в main.tsx)

8. Android дублирует ~2800 строк контракта:
   BookModels.kt (682) + BackendApi.kt (783) + Repository.kt (832)
```

### God-services (fan-out)

`services/layer-config.js` (12 потребителей), `workspace-ai-provider.js` (7), `task-handler.cjs` (7), `generation-progress.js` (6), `profile-override.js` (6). Плюс DI-bag `backend.cjs:176-210`, через который routes достигают чужие домены.

Прямой SQL вне `storage/` — 11 файлов (лидеры: `routes/ai-routes.cjs` — 11 вызовов, `auth/auth-service.js` — 8, `runtime/reconciliation-engine.js` — 5).

---

## 3. Оценка риска и готовность выделения

| Module | Current state | Risk | Coupling | Extraction readiness | First step |
|---|---|---|---|---|---|
| **Local AI Connector** | Автономный CLI, WS-протокол v1 | 🟢 | Только контракт WS | Готов сейчас | Ничего; пометить как separate product |
| **Worker** | Самодостаточный бандл `worker/worker/` (версионируется, раздаётся hub'ом) | 🟢 | Токен `wrk.*` + envelope job-schema v2 | Готов при обобщении envelope-полей | Вынести `protocol_version` контракт в общую спеку |
| **GPU Hub** | Чистый брокер без бизнес-логики | 🟢 | Redis-mirror аутентификации пишет backend; pass-through поля `book_id/chapter_id/scene_id`; монтирует артефакты `backend/ai/*` | Почти готов | Свой Redis-namespace; обобщить поля до `payload.meta` |
| **VBook (формат)** | JSON-бандл + валидатор + zip в book/index.js | 🟢 | `config.BOOKS_DIR`, id-генераторы из `lazy-book/paths.js` | Формат выделяем быстро | Оформить `bundle-validator.cjs` + manifest как формальную спеку v3.1 (JSON Schema) |
| **Navigator** | 407 строк, один GET | 🟢 | `positionStore`/`playbackStore.seekToPosition` | Готова | — |
| **Parser/Import** | TXT-pipeline чистая; agent-LLM-pipeline связана с записью книги и PG `agent_sessions` | 🟡 | lazy-book writing, book-sync, Redis-триггеры | Реалистично после стабилизации Book Model | Отделить «детерминированный parse» от «AI-analysis pipeline» (уже раздельно: `parse.js` vs `services/agent`) |
| **Book Model** | Plain JSON на диске, PG — производная | 🟡 | Два загрузчика; book-sync/book-diff пишут в 8 чужих таблиц | Средняя — модель чиста, но sync-слой нет | Единая точка `loadBook`; вынести purge-логику из book-sync в entity-cleanup/generation-домен |
| **Player** | Тонкая вьюха + монолитный playbackStore (2117) | 🟡 | 6 REST-эндпоинтов, build_id-семантика, generateStore | Средняя: offline-режим потребует VBook Runtime | Определить `BookRuntime` DTO поверх `api/models.ts` типов |
| **Provider Gateway** | LLM-транспорт централизован (+1 дубль); ComfyUI — декларативные коннекторы, но имена workflow и node-id протекают в audio/image/video | 🟡 | `audio/generation.js:492-546` — сырые node-id; `ai-routes.cjs:432` — дубль fetch | Средняя | Один facade `generateImage/generateAudio/generateText` над ai-service + workflows |
| **Cache** | Redis-ключи размазаны (`config.REDIS` + helpers), PG-таблицы полумертвы | 🟡 | Все домены | Низкая ценность отдельного выделения | Реестр ключей уже в `config.REDIS` — задокументировать владельцев |
| **Editor** | 2895-строчная страница, сервер — источник истины | 🟠 | Захардкоженная схема, прямые вызовы playbackStore | Слабая | Ввести клиентский слой BookModel-мутаций поверх API (внутри app/src) |
| **Generation** | orchestration↔runtime цикл, 10k строк runtime, Redis-FSM | 🟠 | Цикл замаскирован lazy-require; callback-роуты | Слабая до разрыва цикла | Разорвать цикл orchestrator↔dispatch-engine через события (уже есть event-journal) |
| **Auth/Core** | Тонкий, но авторизация лезет в book-repo | 🟠 | `auth-service.js:356` → book-repo | Средняя | Интерфейс `bookWorkspaceResolver` вместо прямого repo |

### Четыре вопроса по модулям (кратко)

- **VBook**: владеет форматом/версиями/валидацией; public API — `parse(bundle)→BookModel`, `serialize(BookModel)→.vbook`; скрыть дисковые пути и id-генераторы; мешает: пути в `lazy-book/paths.js`, спека без JSON Schema, `buildBookFromBundle` внутри `book/index.js`.
- **Player**: владеет воспроизведением/предзагрузкой/позицией; интерфейс `BookRuntime` (контент + медиа-резолвер + прогресс); скрыть REST-URLs и build_id-семантику; мешает: стриминг video с backend, дублирование контракта с Android, цикл playbackStore⇄generateStore.
- **Editor**: владеет мутациями модели; интерфейс `BookModelEdit` (commands/diff); скрыть имена PG-полей и PATCH-URLs; мешает: server round-trip дизайн, 2895 строк одним файлом, вызовы playbackStore.
- **Parser**: владеет конвертацией внешний формат → BookModel; интерфейс `import(source)→DraftBook`; скрыть LLM-пайплайн и PG `agent_sessions`; мешает: запись книги напрямую из pipeline-steps.
- **Generation**: владеет оркестрацией стадий; интерфейс `dispatchStage/completeStage/failStage` (фасад уже есть — `orchestration/orchestrator.js`); скрыть runtime/leases/Redis; мешает: цикл с dispatch-engine, reconciliation-engine (2326 строк), callback-роуты.
- **Provider Gateway**: владеет вызовами внешних AI; интерфейс `generateText/Image/Audio` (описан в MD §12); скрыть node-id, workflow-имена, base-URLs; мешает: 4 места queue-clear, дубль в ai-routes, коннекторные знания в audio/image/video.
- **GPU Hub**: владеет очередями/воркерами/health; интерфейс `/task, /task/next, /task/result, /beacon` (уже чистый); скрыть Redis-layout; мешает: mirror-аутентификация из backend, бизнес-поля в envelope.
- **Worker**: владеет исполнением ComfyUI-джобов; интерфейс = job envelope v2; скрыть локальные пути/журнал; мешает почти ничего.
- **Book Model**: владеет структурой книги; интерфейс `loadBook/saveBookBundle/validate`; скрыть два загрузчика и DB-sync; мешает: book-sync, пишущий в чужие таблицы.

---

## 4. VBook / Player / Editor — центральная идея

```
Canonical Book Model  ✅ СУЩЕСТВУЕТ: JSON-бандл /data/books (manifest vbook_version 3.1)
        │                • НЕ привязан к ORM (PG — производная через book-sync) — большой плюс
        │                • привязан к backend: config.BOOKS_DIR, bundle-validator внутри backend
        ├──────► Editor — ❌ работает только через REST PATCH-ы, локальной модели нет
        └──────► Player — ❌ server-driven (6 эндпоинтов), offline только частично (audio/кэш)
                    └──► VBook — 🟡 формат есть (zip бандла), runtime/ридера НЕТ ни на web, ни на Android
```

Основа есть (`api/models.ts` — 832 строки TS-типов, 1:1 с `BookModels.kt`; `bundle-validator.cjs` — серверный контракт), но триада «Model → Editor/Player → VBook» работает только через живой backend. Для реализации идеи из MD §13 недостаёт именно **VBook Runtime**: локального ридера `.vbook`, от которого Player/Editor могли бы питаться без API.

### Детали VBook-формата (проверено на `MiM.vbook` в корне репо)

```
manifest.json  — vbook_version: "3.1", book_id, build_id, mode, render{...}, inputs{...}
book.json      — v3.0, title, author, structure.chapters_order[], defaults, transitions
chapters/ch-*.json, characters.json, locations.json, bible.json, voices.json, behavior.json
```

`buildBookFromBundle` (`book/index.js:252-279`) требует канонические id `ch-`/`sc-`/`iu-` и `structure.chapters_order` — это и есть фактическая спецификация формата.

---

## 5. Generation / Provider / GPU Hub / Worker — цепочка

```
Generation Domain ──> Provider Gateway ──> Compute/GPU Hub ──> Worker
```

**Чисто:**
- Домен генерации не знает воркеров, GPU и очередей — весь submit через `runtime/gpu-dispatcher.js:209` (единственный `POST /task`).
- Job-контракт формализован: `runtime/job-schema.js` (protocol_version = 2, синхронизируемые копии в hub и worker).
- Worker не знает бизнес-понятий вообще: исполняет готовый ComfyUI-граф из `task.params`.
- GPU Hub не содержит бизнес-логики: `book_id/chapter_id/scene_id` — только pass-through поля идентичности (gpu-hub.js:737-752).
- LLM-транспорт централизован: `services/ai-service.js` + резолюция per-workspace в `workspace-ai-provider.js`; local LLM — через чистый интерфейс `services/ai-connector/transport.js`.

**Долг (показатели архитектурного долга):**
1. Цикл orchestration↔runtime (замаскирован lazy-require).
2. Имена workflow и сырые node-id ComfyUI в доменном коде: `audio/generation.js:19-20,492-546`, `image/connector-utils.js:8`.
3. Queue-clear скопирован в 4 места (см. §2.4).
4. `routes/worker-routes.cjs:414` пишет Redis gpu-hub напрямую.
5. `workflows/video/video-workflows.js` (provider-слой) тянет book-домен, image-хелперы и прямой SQL к `image_units` (:41-45).
6. Дубль fetch к LLM: `routes/ai-routes.cjs:432-444`.

---

## 6. Seams — точки безопасного разреза

**Существуют:**
- `frontends/app/src/api/client.ts` — единственный fetch-шов фронтенда;
- `runtime/job-schema.js` — контракт backend↔gpu-hub↔worker;
- `runtime/gpu-dispatcher.js sendUnified` — единый submit-путь;
- `services/ai-connector/transport.js` — «callAI-shaped seam» (transport.js:2-9);
- `workflows/connector-loader.js` — декларативные биндинги provider↔workflow;
- `orchestration/orchestrator.js` — фасад, единственный писатель asset-state;
- `storage/index.js` — 3-слойный фасад (PG/Redis/FS);
- `book/bundle-validator.cjs` — контракт книги перед записью.

**Легко создать:**
- Facade для queue-clear (свернуть 4 копии в dispatch-engine);
- `BookRuntime`-DTO поверх `api/models.ts`;
- Интерфейс `bookWorkspaceResolver` для auth вместо прямого book-repo;
- JSON Schema для manifest/book.json, выведенная из bundle-validator.

---

## 7. Рекомендуемый порядок миграции

```
Phase 0  Аудит без кода: madge/dependency-cruiser на backend/src, базлайн тестов
Phase 1  Склейка дубликатов и фиксация существующих швов
         (4→1 hub-clear, дубль LLM fetch, документация Redis-владельцев)
Phase 2  🟢 VBook-спека (JSON Schema + validator как module),
         Local AI + Worker как «внешние продукты»
Phase 3  🟡 Provider Gateway facade (LLM + ComfyUI под одним интерфейсом)
Phase 4  🟡 Book Model: единый загрузчик, перенос purge-логики из book-домена
Phase 5  🟠 Разрыв цикла orchestration↔runtime, затем Generation как модуль
Phase 6  🟠 Editor: клиентская BookModel-обёртка; Player поверх будущего VBook Runtime
Phase 7  optional: выделение gpu-hub/worker/local-ai в отдельные репозитории
```

Порядок обусловлен зависимостями, а не только сложностью: Player/Editor зависят от Book Model и VBook Runtime, Generation — от Provider Gateway; поэтому швы стабилизируются снизу вверх.

---

## 8. Top 5 наиболее безопасных изменений

1. Свернуть 4 копии hub queue-clear в один фасад `dispatch-engine`.
2. Убрать дубль LLM-fetch в `routes/ai-routes.cjs:432` → `services/ai-service.js`.
3. Оформить VBook-спеку: JSON Schema (manifest/book.json) поверх существующего `bundle-validator.cjs` — без изменения поведения.
4. Ввести dependency-cruiser/madge в CI: запретить новые циклы и импорты `book/*` из `workflows/`.
5. Документировать владельцев Redis-keyspace (backend vs gpu-hub) в `config.REDIS` — задел на выделение hub'а.

## 9. Top 5 самых опасных зон (без подготовки не лезть)

1. `runtime/reconciliation-engine.js` (2326) + цикл orchestration↔runtime — регрессии по всему пайплайну.
2. `services/book-sync.js:293-317` и purge-SQL в `core-routes.cjs`/`cache-routes.cjs` — book-домен пишет в 15–20 чужих таблиц.
3. Общий Redis backend↔gpu-hub (`animastor:worker-auth`, очереди) — изменение сломает аутентификацию воркеров.
4. `playbackStore.ts` (2117) — синхронизирован 1:1 с Android `PlaybackViewModel.kt`; правка рассинхронизирует платформы.
5. `EditPage.tsx` (2895) + захардкоженная схема — любое смещение модели книги ударит по нему первым.

---

## 10. Что НЕ делать сейчас

- Микросервисы/новые контейнеры — MD сам этого не требует, и инфраструктура к этому не готова.
- Большой рефакторинг двух загрузчиков книги за один заход.
- Локальный-first Editor (переписывание round-trip модели) — до появления VBook Runtime.
- Перенос Redis-ключей или смена формата job-envelope v2.
- Единый shared-пакет типов web+android до стабилизации API (сначала зафиксировать контракт как OpenAPI/JSON Schema).
- Любые правки reconciliation-engine без расширения тестового покрытия (130 тест-файлов есть, но цикл покрыт косвенно).

---

## Методика проверки

Все выводы проверяемы по указанным файлам/строкам. Ключевые источники:

- Composition root: `backend/src/backend.cjs`
- Схема БД (39 таблиц): `backend/src/storage/postgres/schema.js`
- Book Model: `backend/src/book/index.js`, `backend/src/book/bundle-validator.cjs`, `backend/src/book/lazy-book/`
- Generation runtime: `backend/src/runtime/` (18 файлов), `backend/src/orchestration/`
- Provider layer: `backend/src/services/ai-service.js`, `workspace-ai-provider.js`, `ai-connector/`, `backend/src/workflows/`, `backend/ai/connectors|workflows/`
- GPU Hub: `gpu-hub/gpu-hub.js` (маршруты :666-1962, таймауты :452-648)
- Worker: `worker/worker/worker.cjs`
- Local AI: `local-ai-connector/lib/*`
- Frontend: `frontends/app/src/api/client.ts`, `api/models.ts`, `state/playbackStore.ts`, `state/generateStore.ts`, `pages/EditPage.tsx`, `pages/PlayPage.tsx`, `pages/NavigatePage.tsx`, `cache/mediaCache.ts`
- Android: `frontends/android/app/src/main/java/com/example/animastor/`
- Развёртывание: `docker-compose.yml`, `proxy/conf/default.conf`
