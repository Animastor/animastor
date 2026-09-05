# PHASE 8D — Post-Extraction Audit Report (commit `0a5f6b78`)

Дата: 2026-09-05
Проверяемый коммит: `0a5f6b78` («extract: move LAC to standalone ai-connector package boundary (Phase 8C)»)
Цель: Phase 8D Post-Extraction Audit — доказать, что после физического extraction `ai-connector/` стал самостоятельной архитектурной boundary и что legacy-путь `local-ai-connector/` больше не используется как runtime/package path.
Принцип: audit + guard-hardening, НИЧЕГО не рефакторилось; никаких unrelated fixes.

---

## 1. Команды тестового контура

| Команда | Область |
|---|---|
| `npm install` / `npm test` (из `ai-connector/`) | пакетные тесты LAC (`node test/run-all.cjs`) |
| `npm pack --dry-run` (из `ai-connector/`) | содержимое npm-пакета, без публикации |
| `npx mocha --exit tests/architecture/lac-contract-sync.test.js` (из `backend/`) | cross-side contract test |
| `npm run test:arch` (из `backend/`) | architecture Phase 1–8 + новый Phase 8D guard |
| Полный backend | `mocha --exit $(find tests -name '*.test.js')` — та же инвокация, что в Phase 8B baseline |
| Полный grep по репозиторию | `local-ai-connector` (все файлы, включая скрытые; бинарные отдельно) |

## 2. Результаты прогонов

| Набор | Результат |
|---|---|
| LAC package tests (`npm test`) | 69 pass / 0 fail |
| Cross-side contract test (`lac-contract-sync.test.js`) | 22 pass / 0 fail |
| Architecture (`test:arch`) | 228 pass / 2 fail (Phase 8C baseline 226/2 + 2 новых теста legacy-path guard; те же 2 pre-existing F5/F6) |
| npm install (`ai-connector/`) | PASS — 0 vulnerabilities |
| npm pack --dry-run | PASS — 11 файлов, см. §6 |
| Полный backend | 2791–2792 pass / 6–7 fail (суммарно 2798 тестов = Phase 8B baseline; разброс ±1 — флаки D3) |

## 3. Классификация упоминаний `local-ai-connector` (50 всего)

Метод: полный `grep -rn` по репозиторию (без `.git`, без `node_modules`) + отдельные прогоны по backend/frontend/android/scripts/CI/configs/package metadata. Отдельный grep на require/import/path-использование (`require(...)local-ai-connector`, `from '...local-ai-connector'`, `'local-ai-connector/'`) — **0 совпадений**.

| Категория | Кол-во | Где |
|---|---|---|
| Stale runtime/package reference (BLOCKER) | **0** | — |
| Intentional historical/documentation reference | 26 | `docs/04-planning/local-ai-connector-v1.md` (4), llm-sharing phase1/2/3 (3), `docs/architecture/*` reconnaissance/design/8B-verification (15), runtime-audits (2), `docs/DOCUMENTATION_STATUS.md` (2) |
| Compatibility/reference marker (объяснимо) | 23 | backend src/tests: DB-маркер `api_key_enc='local-ai-connector-binding'` (schema.js, workspace-ai-provider.js, tests) + doc-комментарии `local-ai-connector-v1.md §…` в 8 backend test-файлах, routes/repo/schema-комментариях, 1 frontend-комментарий (`LocalAISection.tsx`), 1 SQL-комментарий schema.js |
| False positive | 1 | бинарный `backups/animastor-src-2026-09-04_06-27-48-Local-LLM.zip` (untracked, не часть репо) |

Вывод: **ни один production import/require/path dependency не использует `local-ai-connector/`**. Blind replacement не выполнялся.

## 4. Изоляция пакета `ai-connector/`

- Полный скан require/import в `index.cjs` + `lib/**`: только относительные модули пакета, node builtins (`crypto`) и `ws`. Ни одного импорта другого домена Animastor, PG, Redis, filesystem за пределами пакета. Итог: **BLOCKER'ов нет**.
- Тесты пакета (`test/*.cjs`) используют только собственный boundary: `./harness.cjs`, `../lib/*`, node builtins. Автономны (см. 8B §3).
- Подтверждено существующими guards: `dependency-guardrails.test.js` R3/R7 (LAC — только ws+builtins, без pg/postgres), `phase7-extraction-readiness.test.js` (SPEC-пути только внутри `ai-connector/`), `phase2-lac-transport-contract.test.js` (ws единственная внешняя зависимость).

## 5. Production coupling backend → ai-connector (проверка снаружи)

- Backend production импортирует ТОЛЬКО собственные сервисы `backend/src/services/ai-connector/*` (registry, transport, discovery, shared-pool), routes `ai-connector-routes.cjs` и репозиторий `ai-connector-repo` — **не** внутренности пакета (`ai-connector/lib/*`, `ai-connector/index.cjs`).
- `backend/src/services/ai-connector/transport.js` — единственный мост к протоколу; требует только `crypto` и `./registry` (сканировано).
- Импорты `../../ai-connector/lib/*` есть в 8 backend **тестовых** файлах (acceptance/discovery/inference/ws/shared-stream/shared-inference) — тестовый контур, ожидаемо, не production coupling.
- gpu-hub, worker, frontends: 0 импортов пакета.
- Случайного расширения coupling после extraction не обнаружено (сравнение с 8B-состоянием — новых граней нет).

## 6. npm package boundary (`npm pack --dry-run`)

- name: `animastor-ai-connector` ✓, version: `0.1.0` (без bump) ✓
- CLI: `bin.animastor-ai-connector = index.cjs` сохранён ✓
- Tarball (11 файлов): `LICENSE`, `README.md`, `SPEC.md`, `index.cjs`, `lib/chat.cjs`, `lib/config.cjs`, `lib/connector.cjs`, `lib/log.cjs`, `lib/runtime-adapters/index.cjs`, `lib/runtime-adapters/openai-compatible.cjs`, `package.json`
- Отсутствуют: тесты, backend-файлы, docs/dev-артефакты, secrets ✓; `LICENSE`/`SPEC`/`README` присутствуют ✓
- Dependencies: только `ws` (^8.21.3) ✓; `files` allowlist корректен ✓
- Публикации не было ✓

## 7. Protocol regression

`lac-contract-sync.test.js` — 22/22, не ослаблялся (не менялся вообще). `protocol_version`, token grammar (`llmc.*` / `llmcreg.*`), limits, error allowlist, runtime types, frame surface, heartbeat semantics, streaming limits — unchanged. Протокол: **UNCHANGED**.

## 8. Классификация падений полного backend-прогона (6–7, суммарно 2798 тестов)

Все падения — пред-существующие: **воспроизведены на самом коммите `0a5f6b78` в throwaway worktree** (88 pass / 4 fail на тех же 4 sharing-файлах в изоляции). 0 новых регрессий от extraction.

| # | Тест | Причина | Категория |
|---|---|---|---|
| F1 | `ai-endpoint-sharing` — «no policy row is enabled unless…» | В общей dev-БД остался enabled share-policy вне тестовых воркспейсов | **Окружение (состояние БД)** (P8B F1) |
| F2 | `ai-shared-inference` — «16b. shared snapshot is safe for health checks» | Устаревший ассерт до liveness-ветки `checkAIHealth` | **Устаревший ассерт** (P8B F2) |
| F3 | `ai-shared-stream` — «CON1. limit=1: second concurrent request is rejected» | Флаки тайминга конкурентности | **Флаки** (P8B F3) |
| F4 | `worker-share-policy` — «D3: counted in owner private AND global pool» | Тест ~4.7s при дефолтном mocha-таймауте 2s; проходит/падает от прогона к прогону | **Нет переопределения таймаута** (P8B F4) |
| F5 | `phase2-job-protocol-v2` — «job_id type family is anchored…» | `$`-якорь ассерта устарел | **Устаревший ассерт** (P8B F5) |
| F6 | `phase2-lac-transport-contract` — «LAC registry is the authoritative WS liveness» | Фраза «is a stale trace» переписана в `shared-pool.js` | **Устаревший ассерт** (P8B F6) |

Новые regression не маскировались: каждый failure перепроверен изоляцией + baseline-worktree.

## 9. Новый architecture guard (Phase 8D)

Файл: `backend/tests/architecture/lac-legacy-path-guard.test.js` (единственное изменение кода в Phase 8D).

- **Правило:** production/runtime code не может ссылаться на legacy-путь `local-ai-connector` (require/import specifier, path fragment, quoted path segment).
- **Deterministic:** чистый статический скан, без network/DB/runtime.
- **Non-vacuous:** negative control материализует реальное нарушение (`require('../../local-ai-connector/lib/connector.cjs')`) в `backend/src/`, доказывает, что скан его ловит, и удаляет файл в `finally` (проверено: 2/2 pass, residue нет).
- **Минимальный / без списков файлов:** сканирует 7 структурных корней (`backend/src`, `gpu-hub`, `worker/worker`, `ai-connector`, `frontends/app/src`, `frontends/android/app/src`, `scripts`) с фильтром по существованию — устойчив к дальнейшему развитию репо.
- **Точность:** standalone-token regex (`(?<![\w-])local-ai-connector(?![-\w])`) — compatibility-маркеры `local-ai-connector-binding` и doc-имена `local-ai-connector-v1.md` остаются разрешёнными (подтверждено: production-скан зелёный при живом маркере в `workspace-ai-provider.js`).
- Существующие guards не переписывались; дубля правила ранее не было (проверено grep'ом по `backend/tests`).

## 10. Не менялось (запрещённые действия)

Протокол, CLI, API, package name/version, UI, npm publish, GitHub release, старые backend failures — не тронуто. `git diff` после тестов — пуст; рабочее дерево содержит только новый guard-файл и этот отчёт.

## 11. Критерий READY

| Условие | Статус |
|---|---|
| Старый runtime path полностью исключён | PASS (0 stale) |
| Все references классифицированы | PASS (50/50) |
| `ai-connector/` изолирован | PASS (§4–5) |
| Package автономен | PASS (§4, §6) |
| npm dry-run | PASS |
| 69/69 package tests | PASS |
| 22/22 contract tests | PASS |
| Architecture без новых failures | PASS (228/2, оба старые) |
| Backend без новых regressions | PASS (все 6–7 pre-existing) |
| Protocol unchanged | PASS |
| Guard non-vacuous | PASS (negative control) |
| Working tree clean после verification | PASS |

---

**PHASE 8D: READY.** Коммит `0a5f6b78` чист: legacy-путь не используется ни одним runtime/package reference (0 stale из 50), пакет изолирован и автономен, протокол и guards не тронуты, регрессий нет.

**NEXT STEP:** Phase 8E — следующий этап modular product roadmap (см. `docs/architecture/MODULAR_PRODUCT_ARCHITECTURE.md`), candidate: продолжение разборки monorepo boundary по приоритетам reconnaissance.
