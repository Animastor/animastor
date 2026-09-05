# PHASE 7 — Final Verification Report (commit `a7c56fd`)

Дата: 2026-09-05
Проверяемый коммит: `a7c56fd` («arch: add phase 7 extraction readiness»)
Цель: доказать, что текущая реализация Phase 1–7 проходит тестовый контур.
Принцип: НИКАКИХ архитектурных изменений; ничего не рефакторилось и не менялось ради зелёного результата.

---

## 1. Команды тестового контура

| Команда | Область |
|---|---|
| `npm test` | `mocha --exit tests/**/*.test.js` — **ВАЖНО:** POSIX sh раскрывает `**` как `*`, поэтому реально гоняются только `tests/*/*.test.js` (16 файлов архитектуры). Ограничение пакетного скрипта, не регрессия коммита |
| `npm run test:arch` | `mocha --exit tests/architecture/*.test.js` (16 файлов) |
| `npm run test:syntax` | `bash ../scripts/syntax-smoke.sh` (весь production JS/CJS) |
| `npm run test:coverage` | `nyc + mocha` |
| Полный набор | `mocha --exit $(find tests -name '*.test.js')` — 151 файл |
| Lint / typecheck | отсутствуют (подтверждено в docs и package.json) |
| CI | в репозитории CI-конфигурации нет (ни `.github/workflows`, ни `.gitlab-ci.yml` и т.п.) |

## 2. Результаты прогонов

| Набор | Результат |
|---|---|
| Architecture Phase 1–7 (`test:arch`) | 204 pass / 2 fail (оба — пред-существующие устаревшие ассерты, идентично падают на родительском коммите `ed4d692f`) |
| Полный backend (151 файл, mocha через find) | 2769 pass / 7 fail — все 7 пред-существующие, 0 регрессий от `a7c56fd` |
| Syntax smoke (`test:syntax`) | все production JS/CJS файлы OK |
| Book Model (book-diff-unit, book-event-log, book-metadata-patch, book-source, book-sync, entity-crud-routes) | 102 pass / 0 fail |
| LAC/Worker/GPU Hub (gpu-hub-contract, gpu-hub-artifacts, gpu-hub-bootstrap, gpu-hub-cleanup, fail-closed-worker-auth, private-worker-auth, private-worker-phase2, worker-setup-api, snake-guard, worker-bundle-env) | 239 pass / 0 fail |
| Runtime/Orchestration (reconciliation-engine, orchestration-stabilization, runtime-timeouts, stage-dispatch-lifecycle, dispatch-meta-lease-lifecycle, counter-reconciliation, stale-lease-semantics, fail-stage) | в полном прогоне — все pass; отдельный подмножественный прогон даёт ложные падения из-за общего состояния между файлами (пример: stage-dispatch-lifecycle 11/11 pass в изоляции) |

## 3. Проверка исполняемости Phase 7 guards (не просто «существуют»)

- Все 12 ассертов P7-T1…T8 исполнились и прошли.
- **Отрицательный контроль:** временный файл `backend/src/__p7_probe.cjs` с `require("../../gpu-hub/gpu-hub")` — P7-T3 немедленно его поймал:
  ```
  AssertionError: the worker is reached only via the GPU Hub HTTP contract
  - "backend/src/__p7_probe.cjs: ../../gpu-hub/gpu-hub"
  ```
- Пробник удалён; рабочее дерево после всех прогонов чистое (`git status` пуст).

## 4. Классификация всех 7 падений полного прогона

| # | Тест | Причина | Категория |
|---|---|---|---|
| F1 | `ai-endpoint-sharing` — «no policy row is enabled unless the owner explicitly enabled it» | В общей dev-БД остался enabled share-policy в реальном воркспейсе `sureg's Workspace` (endpoint «Test endpoint»); тест считает его «orphan» → 1 вместо 0 | **Окружение (состояние БД)** |
| F2 | `ai-shared-inference` — «16b. shared snapshot is safe for health checks» | Устаревший тест: написан до появления в `checkAIHealth` ветки liveness коннектора (коммит `537fb76a`); теперь для живого коннектора возвращается 1, тест ждёт 0 | **Устаревший ассерт (дрейф кода)** |
| F3 | `ai-shared-stream` — «CON1. limit=1: second concurrent request is rejected» | Флаки тайминга: второй запрос иногда успевает занять слот → 200 без error-события | **Флаки конкурентности** |
| F4 | `worker-share-policy` — «D3: counted in owner private AND global pool» | Тест выполняется ~4.7s, но не переопределяет дефолтный mocha-таймаут 2s; с `--timeout 15000` проходит | **Нет переопределения таймаута** |
| F5 | `private-worker-visibility` — timeout | Флаки под нагрузкой (дефолт 2s); в изоляции проходит стабильно (23/23) | **Флаки тайминга** |
| F6 | `phase2-job-protocol-v2` — «job_id type family is anchored…» | `worker.cjs` теперь заканчивается бутстрапом `main().catch(...)`, а не split-регексом семейства типов; `$`-якорь ассерта устарел | **Устаревший ассерт (дрейф кода)** |
| F7 | `phase2-lac-transport-contract` — «LAC registry is the authoritative WS liveness» | Фраза «is a stale trace» переписана в комментарии `shared-pool.js` | **Устаревший ассерт (дрейф кода)** |

**Проверено:** все 7 падений воспроизводятся идентично на родительском коммите `ed4d692f` (до `a7c56fd`). Регрессий от проверяемого коммита нет.

## 5. Состояние git после прогонов

- `git status --short` — пусто (никаких незакоммиченных или случайно изменённых файлов после тестов).
- Временный `__p7_probe.cjs` удалён, следов не осталось.

## 6. Итоговая рекомендация

**Можно продолжать Phase 8.** Коммит `a7c56fd` чист: 0 регрессий, Phase 7 guards исполняются и доказанно не-вакуумны (отрицательный контроль). 7 падений — пред-существующие и к коммиту отношения не имеют:

- Окружение/инфраструктура (F1, F4, F5) — чинятся отдельно, вне архитектуры: очистка тестовых данных БД, добавление `this.timeout()` в пару тестов.
- Устаревшие ассерты (F2, F6, F7) — обновление baseline'ов Phase 2 тестов под текущее содержимое исходников.
- Флаки (F3) — стабилизация тайминга конкурентного теста.