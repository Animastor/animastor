# Phase 1 — Guardrails & Contracts

**Status:** active (architecture freeze)
**Date:** 2026-09-04
**Parent plan:** `MODULAR_PRODUCT_ARCHITECTURE_FINAL_REVIEW.md` §6
**Rule of the phase:** zero runtime behavior change. No refactor, no migration, no file moves, no protocol changes. Guardrails only.

---

## 1. Зачем

Финальный аудит показал, что coupling **растёт**: прямой SQL вне storage вырос с 11 файлов (аудит 1) до 16 (аудит 2) и до 22 строк-файлов на момент финального ревью; orchestration↔runtime цикл структурный (≥5 файлов, top-level рёбра); Redis — двусторонний канал записи между backend и gpu-hub (4 семьи ключей). Phase 1 **замораживает** текущую архитектуру: существующие нарушения зафиксированы как baseline-долг, новые — блокируются тестами.

Запускать не забыть: `npm test` в `backend/` гоняет mocha по `tests/**/*.test.js` — architecture tests входят в общий прогон автоматически (плюс отдельный `npm run test:arch`, см. §9).

---

## 2. Границы сейчас

| Граница | Состояние | Где enforcement |
|---|---|---|
| SQL вне storage | 17 файлов с прямым `require(.../postgres/database)` вне `backend/src/storage` (baseline; аудит считал «22» по более широкому определанию — см. §3) | `tests/architecture/sql-boundary.test.js` |
| Redis keyspace ownership | 60+ семей, 4 проблемных cross-owner группы | `tests/architecture/redis-registry.js` + `redis-ownership.test.js` |
| GPU Hub API contract | 6 маршрутов + job envelope v2 | `tests/architecture/gpu-hub-contract.test.js` |
| Job Protocol v2 | 3 SYNC-копии (backend / gpu-hub / worker) | `tests/architecture/gpu-hub-contract.test.js` |
| Chat transport contract | SSE+tools+connector+pool в `ai-routes.cjs`; `callAI` — отдельный non-streaming транспорт | `tests/architecture/chat-transport.test.js` |
| Worker isolation | self-contained bundle, HTTP-only | `tests/architecture/dependency-guardrails.test.js` |
| orchestration↔runtime cycle | заморожен ровно на текущем наборе рёбер | `tests/architecture/dependency-guardrails.test.js` |
| Frontend fetch | 0 вызовов вне `api/client.ts` | `tests/architecture/dependency-guardrails.test.js` |

---

## 3. SQL boundary (задача 1)

**Правило:** новые модули НЕ могут делать `require('.../storage/postgres/database')` вне `backend/src/storage/**`. Новый SQL — только через repository в `storage/postgres/repositories`.

**Про «22 файла» из аудита:** точный пересчёт по паттерну `require(.../postgres/database)` вне storage на текущем HEAD даёт **17 файлов** (22 в финальном ревью — счёт более широкого скана на момент ревью; актуальный whitelist зафиксирован тестом и не может расти). Разделение baseline:

- **Допустимые по духу (gateway-подобные сервисы, будут легализованы repo-слоем в Phase 3):** `services/system-ai.js`, `services/workspace-ai-provider.js`, `services/agent-session.js`, `services/agent/ai-caller.js` — read-конфигурации AI-провайдеров.
- **Архитектурные нарушения (долг Phase 3):** runtime-семья (`runtime/runtime-scheduler.js`, `runtime/scene-window.js`, `image/iu-processor.js`, `orchestration/orchestrator.js`, `orchestration/scene-restoration.js`, `services/book-sync.js`, `services/placeholder-audio.js`, `services/agent/bootstrap.js`), routes (`routes/ai-endpoint-routes.cjs`, `routes/book/generation-routes.cjs`), middleware (`middleware/ai-book-guard.js`), workflows (`workflows/video/video-workflows.js`).

Whitelist = ровно эти 17 путей, явно перечислен в `tests/architecture/sql-boundary.test.js` (`DIRECT_SQL_WHITELIST`). Тест:
- запрещает **новые** файлы вне whitelist;
- требует **удалять** из whitelist файлы, которые перестали нарушать (baseline может только сжиматься);
- проверяет, что все записи whitelist реально существуют.

Расширение whitelist = осознанное решение с ADR, не случайность.

---

## 4. Redis ownership (задача 2)

Реестр: `backend/tests/architecture/redis-registry.js`. Для каждой семьи: `owner` (автор) / `readers` / `writers` / `crossModule` (записывает ли кто-то чужое) / `note`. Компоненты: `backend`, `gpu-hub`, `worker`, `ai-connector`.

Ключевые семьи из аудита:

| Семья | Owner | Readers | Writers | Coupling |
|---|---|---|---|---|
| `animastor:worker-auth` | **backend** (`services/worker-auth.js`) | gpu-hub | backend | нет (hub только читает) — но ключ SYNC-скопирован в `gpu-hub.js:41` |
| `animastor:worker:heartbeat:*` | **gpu-hub** (beacon/claim/result) | backend | gpu-hub + **backend-долг** (`worker-routes.cjs` del при purge; `worker-health.reportHeartbeat` legacy) | да |
| `animastor:gpu-hub:workers` | **gpu-hub** | backend | gpu-hub + **backend-долг** (`worker-routes.cjs:414` hdel) | да |
| `animastor:queue:*:policy:*` | **gpu-hub** | gpu-hub | gpu-hub + **backend-долг** (`worker-routes.cjs` `drainPolicyLane` RPOPLPUSH + мутация тел задач) | да |
| `animastor:queue:*` (system/ws lanes) | **gpu-hub** | gpu-hub | gpu-hub (+ тот же drain-долг) | да (долг) |
| `animastor:job:*` (enqueue dedup) | **gpu-hub** | backend, gpu-hub | gpu-hub + **backend delib. del** перед re-dispatch (iu-processor, audio/video-orchestrator, scene-restoration, entity-cleanup, generation/debug routes) | да (осознанный контракт) |
| `animastor:result:*` / `animastor:error:*` | **gpu-hub** | backend | gpu-hub | нет (hub→backend handoff) |
| `animastor:runtime:*` / `animastor:dispatch-*` / chunk/snapshot/locks/... | **backend** | backend | backend | нет (backend-internal) |

**Guardrail (`redis-ownership.test.js`):**
1. каждый `animastor:*` литерал в `backend/src` и `gpu-hub` обязан принадлежать зарегистрированной семье (иначе тест краснеет — новые семьи нельзя добавлять мимо реестра);
2. cross-owner writes заморожены `CROSS_OWNER_WRITE_BASELINE` — новое `backend`-писание в gpu-hub-семью падает;
3. `animastor:worker-auth` пишет только `services/worker-auth.js`;
4. worker bundle не касается Redis вовсе.

Ничего из долга Phase 1 **не исправляет** — фиксирует.

---

## 5. GPU Hub contract (задача 3)

Протокол **не изменён**. Зафиксировано тестом `gpu-hub-contract.test.js`:

- **Маршруты:** `POST /beacon`, `POST /task`, `GET /task/next`, `POST /task/result`, `POST /task/error`, `DELETE /queue/clear` (+ delivery-поверхность `/worker-bundle*`, `/workflow/:id`, `/installer*`, `/health` — не контрактная, но пинированная).
- **Transport-level поля envelope** (`/task`): `protocol_version`, `dispatch_id`, `job_id`, `job_type`, `params`, `assets`, `timeout_ms`, `policy_id`/`workspace_id` (routing, backend-authored, shape-validated).
- **Business-level поля** (сегодня обязательные — `incomplete_dispatch_identity` проверка): `build_id`, `book_id`, `chapter_id`, `scene_id`, `stage`. ⚠ Это и есть текущее coupling-ядро: hub обязан знать book-identity. Phase 5 (не Phase 1) переведёт их в `payload.meta`.
- **Auth/worker identity:** ТОЛЬКО из Bearer-креды (`wrk.<id>.<secret>`, sha256(secret) → lookup в `animastor:worker-auth` mirror → identity JSON); `worker`/`type` query-параметры никогда не идентичность. Реестр после активации: `animastor:gpu-hub:workers` (hub-only).
- **GPU Hub получает через Redis (не через HTTP):** worker-auth mirror (backend пишет, hub читает), heartbeat keys (hub пишет, backend читает), собственные очереди/running/processing/dedup/result/error.

---

## 6. Job Protocol (задача 4)

`protocol_version=2` не меняется. SYNC-копии:
- канон: `backend/src/runtime/job-schema.js` (`PROTOCOL_VERSION=2`, полный `parseJobId`);
- `gpu-hub/gpu-hub.js` (`PROTOCOL_VERSION=2`, упрощённая копия парса, якоря `SYNC:` на строках 32/758/1094);
- `worker/worker/worker.cjs` (`PROTOCOL_VERSION=2`, split `/:(iu_image|image|audio|video)$/`).

Тест `gpu-hub-contract.test.js` пинирует: версию во всех трёх копиях, JOB_TYPES, форму парса каждой из 4 job-конфигураций, 409-отказ на mismatch (hub) и reject (worker), использование `dispatch_id` (добавлен в v2), якорные SYNC-комментарии. Существующий `tests/job-schema.test.js` продолжает гонять парсер — дублирования рантайм-логики не добавлено, только статический pin.

---

## 7. Chat Transport (задача 5)

Разделение **зафиксировано как контракт** (первый аудит предлагал объединить — финальное ревью отклонило, Phase 1 закрепляет):

- **`callAI`** (`services/agent/ai-caller.js` → `services/ai-service.js`): non-streaming JSON для agent-пайплайнов; retry, provider-context через AsyncLocalStorage; `stream:false`.
- **Chat transport** (`routes/ai-routes.cjs`): SSE (`text/event-stream`), tools (`getToolsForMode`, `tool_choice`, `extractToolCallsFromContent`), AbortController (timeout + shared disconnect-abort), connector-транспорт (`ai.transport === 'connector'` → `sharedPool.runSharedInference`), shared-pool slots.

Тест `chat-transport.test.js` гарантирует: chat-роут **сохраняет** streaming/tools/abort/connector/pool; `callAI` **не обрастает** ими (запрет SSE/`writeEvent`/tools в ai-caller); chat-роут не требует `agent/ai-caller`.

---

## 8. Dependency guardrails (задача 6)

`tests/architecture/dependency-guardrails.test.js`:

1. **Book Domain** — `backend/src/book/**` импортирует только внутрь себя + явный `BOOK_ALLOWLIST` (runtime-config, language/structure-detector, 3 utils). Новое ребро наружу — красный тест.
2. **GPU Hub** — только node builtins + `express/cors/ioredis/zlib` + свои файлы; никаких require в `backend/`, `worker/`, `frontends/`. Coupling с backend — только HTTP (`BACKEND_URL`) и shared Redis.
3. **Worker** — self-contained: builtins + `./package.json` + свои `.cjs`; ноль ссылок на book/generation/PG; Redis отсутствует.
4. **Local AI Connector** — только `ws` + builtins + свои файлы.
5. **SQL вне storage** — whitelist (§3); worker/hub/LAC вообще не импортируют `pg`/postgres.
6. **Redis cross-owner writes** — baseline-frozen (§4).
7. **orchestration ↔ runtime cycle** — заморожен ровно на 8 рёбрах `runtime → orchestration` (event-journal ×3 top-level — единственный безусловно разрешённый модуль; orchestrator/orchestration-Index ×5 — pinned, новые рёбра запрещены). Существующие циклы **не удаляются** в Phase 1.
8. **Frontend `fetch(`** — только в `api/client.ts`.

---

## 9. Как запускать

```bash
# полный backend suite (arch tests входят в tests/**/*.test.js)
cd backend && npm test

# только архитектурные тесты (~0.2s)
cd backend && npx mocha --exit tests/architecture/*.test.js

# то же, как npm-скрипт
cd backend && npm run test:arch
```

CI: arch tests — обычные mocha-тесты, никакого отдельного tooling не требуется. Добавлен только `test:arch` convenience-скрипт в `backend/package.json`.

---

## 10. Что разрешено / что запрещено

**Разрешено в рамках Phase 1 guardrails:**
- добавлять/обновлять правила тестов при появлении нового осознанного исключения (ADR + обновление baseline в тесте);
- новые Redis-семьи — только через запись в `redis-registry.js` с owner/readers/writers;
- новые hub-маршруты — только с обновлением `HUB_ROUTES` pin в `gpu-hub-contract.test.js`.

**Запрещено (упадёт CI):**
- новый `require(.../postgres/database)` вне storage вне whitelist;
- расширение whitelist без ADR;
- новый cross-owner Redis write вне `CROSS_OWNER_WRITE_BASELINE`;
- новые рёбра `runtime → orchestration`;
- новый import из `backend/src/book` вне allowlist; новые workflow→book imports;
- любые пакеты/файлы в worker/hub/LAC вне их frozen-наборов;
- `protocol_version ≠ 2`; изменение набора обязательных полей envelope;
- SSE/tools/pool в `callAI`; исчезновение SSE/tools/abort/connector/pool из chat-роута;
- `fetch(` в frontend вне `api/client.ts`.

**Не изменилось в Phase 1:** рантайм-поведение, DB schema, Redis-протокол, GPU Hub API, VBook format, расположение файлов, Generation, циклы, транспорты callAI/chat.

---

## 11. Открытые пункты (осознанно НЕ сделано)

- Не свернуты 4 копии queue-clear и не исправлен ни один cross-owner Redis write — Phase 5.
- Runtime SQL не перенесён в repositories — Phase 3.
- Цикл orchestration↔runtime не разорван — Phase 6.
- `payload.meta` для business-полей envelope не введён — Phase 5.
- Счёт «22 SQL-файла» из финального ревью зафиксирован как 17 по строгому паттерну `postgres/database` (актуальный HEAD); при желании расширить определение до 22 — это отдельное решение, зафиксировано здесь.
