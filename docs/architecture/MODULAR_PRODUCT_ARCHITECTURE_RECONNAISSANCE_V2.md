# Animastor — Modular Architecture Independent Review (V2)

**Status:** Independent Second Audit (review only, no code changed)
**Date:** 2026-09-04
**Input:** `docs/architecture/MODULAR_PRODUCT_ARCHITECTURE_RECONNAISSANCE.md` (commit `baa85ad4`)
**Baseline:** HEAD `537fb76a` (findings Cross-checked against the audit commit `baa85ad4` where drift mattered)
**Method:** Every material claim of the first audit was re-verified against source (line counts, import graphs via grep across 5 directions, SQL-outside-storage scan with two patterns, Redis-keyspace ownership matrix backend/gpu-hub/worker, docker-compose mount graph, Android contract sizes). The goal was falsification, not confirmation.

---

## 0. Verdict

Первый аудит в целом качественный и подтверждается примерно на 70%: инвентаризация модулей, метрики, базовые циклы и швы описаны верно. Однако:

- одна из его «Топ-5 безопасных изменений» основана на неверном прочтении кода и опасна при исполнении;
- масштаб DB-coupling book-домена и Redis-связок backend↔gpu-hub **недооценён**;
- цикл orchestration↔runtime **шире и структурнее**, чем заявлено;
- тезис «PG — производная» верен только для контента книги, но не для identity/ownership.

---

## 1. Confirmed — что подтвердилось

Метрики (проверено `wc -l`):

| Объект | Заявлено | Факт (HEAD) | Статус |
|---|---|---|---|
| `book/index.js` | 848 | 848 | ✅ |
| `book/bundle-validator.cjs` | 284 | 284 | ✅ |
| `book/lazy-book/` | 11 файлов ~2000 | 11 файлов, 2022 | ✅ |
| `gpu-hub/gpu-hub.js` | 2029 | 2029 | ✅ |
| `worker/worker/worker.cjs` | 744 | 744 | ✅ |
| `runtime/` | 18 файлов 10 408 | 18 / 10 408 | ✅ |
| `playbackStore.ts` | 2117 | 2117 | ✅ |
| `EditPage.tsx` | 2895 | 2895 | ✅ |
| `PlaybackViewModel.kt` | 1086 | 1086 | ✅ |
| `structure-detector.js` | 1231 | 1231 | ✅ |
| `pipeline-steps.js` / `pipeline-runner.js` | 1594 / 1370 | 1594 / 1370 | ✅ |
| `entity-crud-routes.cjs` | 727 | 727 | ✅ |
| Тестов backend | 130 | 136 | ✅ (дрейф) |

Подтверждённые структурные утверждения:

- DI-bag `backend.cjs:200-210` (~30 ключей `routeDeps`) — да.
- Цикл orchestration↔runtime существует: `orchestrator.js:38,47,74` ↔ `dispatch-engine.js:461,826,886`.
- Два расходящихся загрузчика: `loadBook` (`book/index.js:543`, по `chapters_order`) vs `loadDraftBook` (`lazy-book/draft.js:87`, главы по алфавиту `:142`).
- Worker самодостаточен: один `POST /worker/verify` при старте (`worker.cjs:117-120`, вызов `:729`); `protocol_version=2` — синхронизируемые копии с пометкой «SYNC:» (`gpu-hub.js:33`, `worker.cjs:49`).
- `sendUnified` — единственный `POST /task` (`gpu-dispatcher.js:209`); `book_id/chapter_id/scene_id` в hub — pass-through (`gpu-hub.js:737-766`); hub без БД, «dumb transport» (`gpu-hub.js:21`).
- `workflows/video/video-workflows.js:9,12` тянет book-домен + image-хелперы, прямой SQL к `image_units` (`:41-45`).
- Сырые ComfyUI-знания: `audio/generation.js:19-20` (имена workflow), `:492` (raw node-id `wfAudio["108"]`).
- `auth-service.js:356` → book-repo.
- Redis-mirror `animastor:worker-auth`: backend пишет (`worker-auth.js:29`), hub читает (`gpu-hub.js:41`).
- Queue-clear скопирован в 4 места (`dispatch-engine.js:1321` — dispatch_id-scoped; `book/generation-routes.cjs:311`, `core-routes.cjs:854`, `cache-routes.cjs:117` — book_id-scoped).
- `worker-routes.cjs:414` пишет Redis hub'а (`hdel animastor:gpu-hub:workers`).
- EPUB/PDF/DOCX отсутствуют (нет кода и зависимостей в `backend/package.json`).
- local-ai-connector — единственная зависимость `ws` (package.json).
- Цикл `generateStore ⇄ playbackStore` (развязка через `wirePlaybackCoordination`, `main.tsx:19,25`; `generateStore.ts:23` ↔ `playbackStore.ts:29`).
- EditPage → playbackStore напрямую (`EditPage.tsx:43` — `seekToPosition` и др.).
- `fetch()` вне `api/client.ts` — 0 вызовов (проверено по всему `frontends/app/src`).
- VBook: zip+manifest v3.1, `buildBookFromBundle` (`book/index.js:252-279`), `/download`, `/load-vbook`, `MiM.vbook` в корне; спека неявна; frontend не читает .vbook.

## 2. Corrections — где первый аудит ошибся

1. **«Дубль fetch к LLM в `routes/ai-routes.cjs:432-444`» — неверно.**
   Это не дубль `services/ai-service.js`. Чат-роут — самостоятельный транспорт: SSE-стриминг (`:1153`), tools, AbortController, connector-транспорт (`:501`), shared-pool (`runSharedInference`, `:530`). `callAI` — не-streaming JSON без этих возможностей. «Топ-5 безопасное изменение №2» первого аудита при исполнении сломало бы стриминг и локальный AI. Risk: Low → **Medium**.
2. **Purge book-домена занижен.**
   DELETE book (`core-routes.cjs:816-846`) чистит **24 таблицы**, не 15 (pgTables: image_units, scenes, asset_states, asset_dependencies, generation_tasks, reconciliation_events, output_manifests, cache_entries, book_source, agent_sessions, book_generation_sessions, generation_cancellations, ai_chat_sessions, book_events, scene_assets, character_resolution_runs, character_window_candidates, sentence_resolutions, character_mentions, character_aliases, storyboard_elements, audio_layers, book_snapshots, books). Cache-routes — **19**, не 20. `book-sync.js:293-317` — 7+scenes=8 (подтверждено).
3. **Цикл не «замаскирован lazy-require» полностью.**
   Top-level рёбра: `dispatch-engine.js:9` → `orchestration/event-journal`; `runtime-persistence.js:12` → event-journal; **`scene-window.js:22` → `orchestration/orchestrator` (top-level!)**. Плюс **7** lazy-require orchestrator'а в `reconciliation-engine.js` (:1084, :1207, :1233, :1254, :1279, :1317, :2115) и `runtime-scheduler.js:271`. Цикл структурный, участников ≥5 файлов, а не 2.
4. **«Прямой SQL вне storage — 11 файлов» — вдвое занижено.**
   С паттерном `query(` — **16 файлов**, включая `runtime/runtime-scheduler.js:217` (читает scenes/scene_assets) и `image/iu-processor.js:132-154` (scene_assets, image_units). Следствие: тезис «book-домен — единственный писатель/читатель чужих таблиц» неточен — Generation runtime тоже ходит мимо репозиториев. (На дату аудита 11 вызовов в ai-routes соответствовали действительности; сейчас их 16 — дрейф подтверждён `git show baa85ad4`.)
5. **«PG — производная» — верно только для контента.**
   Identity/ownership книги — PG-первичны: `books`, `book_source`, workspace-связь существуют только в PG (`book-repo.getWorkspaceId`); VBook-бандл не содержит workspace_id. Canonical Book Model не самодостаточен и не переносим между инсталляциями.
6. **Числовые ошибки:** schema.js — **41 таблица** на дату аудита (43 на HEAD), не 39; `BackendApi.kt` — 823 строки, не 783; сумма Android-контракта ~2337 строк, не ~2800; `ai-connector-routes.cjs` — 919 (сейчас), не 889.
7. **«Запись книги напрямую из pipeline-steps» — неточна.**
   fs-записи сосредоточены в `lazy-book/create.js`; agent-pipeline пишет через book-domain API (`bootstrap.js:227` → `lazyBook.createFromAnalysis`). Граница Parser лучше, чем описано — это хорошая новость для его выделения.

## 3. Missing — что первый аудит пропустил

1. **`drainPolicyLane` (`worker-routes.cjs:146-168`)** — backend делает RPOPLPUSH между очередями gpu-hub (`animastor:queue:{type}:policy:{id}` → `animastor:queue:{type}`), парсит JSON-задачи и вычищает поле `policy_id`. Backend мутирует содержимое очередей hub'а — глубже, чем hdel `:414`; в аудите отсутствует.
2. **Трёхсторонний shared-key heartbeat:** backend пишет `animastor:worker:heartbeat:{type}:{id}` (`worker-health.js:73`), hub читает для liveness (`gpu-hub.js:462,712,1021,1126,1244`). Реестр Redis-владельцев (Phase 1 первого аудита) без этого ключа неполон.
3. **DELETE book лезет в runtime-состояние:** `core-routes.cjs:797-800` — require `runtime/scene-window` + `redis.del('animastor:runtime:active-audio|image|video')` (сброс backpressure-счётчиков из route-слоя; то же в `backend.cjs:474-476`).
4. **`storage/index.js` — не чистый 3-слойный фасад:** экспортирует services (`bookSync`, `bookEventLog`, `bookSource`, `layerConfig`, `genScope`, `:21-27`) — инверсия storage→services. Шов «storage/index.js» из §6 первого аудита слабее заявленного.
5. **Ребро orchestration→services отсутствует в dep-map:** `orchestrator.js:287-290` → `services/audio-orchestrator` / `video-orchestrator`; плюс треугольник services(`task-handler.cjs:30` → dispatch-engine) → runtime → orchestration.
6. **Frontend-шов протекает:** Navigator зависит от generateStore (`NavigatePage.tsx:9` — bookId/buildId/onPlaybackPrepared), PlayPage тоже (`PlayPage.tsx:21`); пути `/api/v1/...` захардкожены вне client.ts в 5 местах (`EditPage.tsx:822,2248,2760`, `NavigatePage.tsx:405`, `AiAssistantPage.tsx:334`). «Единственный шов» верен для `fetch()`, но знание путей распределено.
7. **Fallback-цепочки третьего паттерна чтения книги:** `ai-routes.cjs:423,968` — `book.loadBook(bookId) || lazyBook.loadDraftBook(bookId)`.
8. **Mount-куплинг gpu-hub:** docker-compose монтирует `./worker/worker` и `./backend/ai/workflows` в контейнер hub'а (раздача `/gpu/worker-bundle`, `/gpu/workflow/:id`) — блокер Phase 7, в risk-таблице 🟢 не отражён.
9. **Новые швы после аудита** (HEAD ушёл на ~14.7k строк): ai-sharing Phase 1–3 (`services/ai-connector/shared-pool.js`, `routes/ai-endpoint-routes.cjs`), срастание `workspace-ai-provider` с LAC-liveness (`537fb76a`) — provider resolution всё теснее связывается с Local AI Connector; roadmap это не учитывает.

## 4. Risk changes — где уровень риска нужно изменить

| Зона | Первый аудит | Независимая оценка | Обоснование |
|---|---|---|---|
| GPU Hub | 🟢 «почти готов» | **🟡** | mount-зависимости от backend/worker; обязательные бизнес-поля envelope (`gpu-hub.js:766`); 3 семьи shared-keys (worker-auth, heartbeat, workers); backend-мутация очередей |
| «Дедуп LLM fetch» (Топ-5 №2) | Low | **Medium** | см. Correction 1 — сломал бы SSE/connector-путь |
| Generation (разрыв цикла) | 🟠 | **🟠+** | цикл шире (≥5 файлов, есть top-level рёбра); прямой SQL в scheduler/iu-processor |
| Book purge | «топ-опасная зона №2» | **опаснее** | 24 таблицы, а не 15–20; плюс сброс runtime-счётчиков из route |
| Book Model «PG — производная» | 🟡 | **🟡+** | ownership/identity только в PG — extraction требует design-решения |
| Worker | 🟢 | 🟢 | подтверждено |
| Local AI Connector | 🟢 | 🟢 | подтверждено; следить за срастанием с workspace-ai-provider |

## 5. Roadmap changes — что изменить в порядке миграции

- **Phase 1:** исключить пункт «дедуп LLM fetch» (`ai-routes.cjs`); вместо него — зафиксировать chat-транспортный контракт (SSE + tools + connector + shared-pool) как интерфейс. В реестр Redis-владельцев добавить: `animastor:worker:heartbeat:*`, `animastor:gpu-hub:workers`, очередь-drain (`worker-routes.cjs:146`).
- **Phase 1 (новый шаг, безопаснее отсутствующих):** ESLint/dependency-cruiser-правило, запрещающее `storage/postgres/database` вне whitelist — останавливает рост числа файлов с прямым SQL (уже 16) до каких-либо переносов purge.
- **Phase 2 (VBook spec):** JSON Schema должна явно зафиксировать отсутствие в бандле ownership-полей; параллельно — выделить Book ownership API (сейчас `book-repo.getWorkspaceId` — единственный источник workspace-связи). Иначе Book Model extraction упрётся в PG-only identity.
- **Phase 4 (единый загрузчик):** это не «склейка», а мини-проект: 6+ потребителей используют draft-семантику (import-routes ×5, status-routes, parse-routes, agent/bootstrap — алфавитный порядок, sourceText, mentions). Нужен `loadBook(bookId, {mode: 'draft'|'canonical'})`, а не удаление загрузчика; плюс легализовать fallback-цепочки (`ai-routes.cjs:423,968`).
- **Phase 5 (разрыв цикла):** скоуп расширить — top-level рёбра `scene-window.js:22`, `dispatch-engine.js:9`, `runtime-persistence.js:12` делают разрыв через события заметно более инвазивным, чем «facade dispatch-engine».
- **Phase 7:** до выделения gpu-hub в отдельный репозиторий — заменить volume-mounts (`./worker/worker`, `./backend/ai/workflows`) на версионированные артефакты, поставляемые через API.

## 6. Top 5 findings

1. **Backend мутирует внутренности gpu-hub.** `drainPolicyLane` (`worker-routes.cjs:146-168`) переписывает элементы очередей hub'а + `hdel` реестра (`:414`) + backend пишет heartbeat-ключи, которые читает hub. Общий Redis — двусторонний канал записи, а не «зеркало». Самая недооценённая связка hub↔backend.
2. **Цикл orchestration↔runtime структурный и шире заявленного:** top-level `scene-window.js:22` → orchestrator; `dispatch-engine.js:9` и `runtime-persistence.js:12` → event-journal; 7 lazy-require в `reconciliation-engine.js`. Разрыв цикла (Phase 5) затронет ≥5 файлов.
3. **Book Domain не отделяем без переноса purge:** DELETE book = 24 таблицы (`core-routes.cjs:816-846`) + сброс runtime Redis-счётчиков (`:798-800`) + require `runtime/scene-window` (`:797`). Готовый кандидат-приёмник — `entity-cleanup.cjs` (уже переиспользует `bookSync.purgeRemovedSceneRows`).
4. **«Дубль LLM fetch» — ложный quick-win первого аудита:** два разных транспорта (`services/ai-service.js callAI` vs чат-роут `ai-routes.cjs:563/:1153` с SSE/tools/connector/shared-pool). «Склейка» сломает стриминг и локальный AI.
5. **Canonical Book Model расщеплён:** контент — JSON-бандл (PG производная), identity/ownership/workspaces — только PG (`book-repo.getWorkspaceId`; `books`/`book_source`). VBook-бандл не переносим между инсталляциями; «PG — производная» первого аудита верна только для контента.

---

## Методика и проверяемость

Все выводы данного документа проверяемы по указанным файлам/строкам на HEAD `537fb76a`; спорные числа первого аудита дополнительно сверены на его коммите через `git show baa85ad4:<path>`.

Ключевые источники: `backend/src/backend.cjs`, `backend/src/storage/postgres/schema.js`, `backend/src/book/*`, `backend/src/orchestration/orchestrator.js`, `backend/src/runtime/{dispatch-engine,reconciliation-engine,runtime-scheduler,scene-window,runtime-persistence,gpu-dispatcher,job-schema}.js`, `backend/src/routes/{worker-routes,ai-routes}.cjs`, `backend/src/routes/book/{core-routes,cache-routes,generation-routes}.cjs`, `backend/src/services/{book-sync,worker-auth,entity-cleanup}.cjs` / `.js`, `backend/src/workflows/video/video-workflows.js`, `gpu-hub/gpu-hub.js`, `worker/worker/worker.cjs`, `docker-compose.yml`, `frontends/app/src/{api/client.ts,state/playbackStore.ts,state/generateStore.ts,pages/{EditPage,PlayPage,NavigatePage}.tsx}`, `frontends/android/app/src/main/java/com/example/animastor/**`.

Код не изменялся. Коммит содержит только этот документ.
