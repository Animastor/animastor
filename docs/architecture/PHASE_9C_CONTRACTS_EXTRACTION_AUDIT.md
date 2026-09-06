# PHASE 9C — Job Protocol v2 Contracts Package — Extraction Audit

**Status:** COMPLETE (PASS WITH PREPARATION)
**Date:** 2026-09-06
**Baseline:** HEAD `5aef28e2` (Phase 9B: worker dependency isolation)
**Parent plan:** `PHASE_9_WORKER_EXTRACTION_READINESS_AUDIT.md` §7 (Phase 9C),
`JOB_PROTOCOL_V2.md` §8 (migration notes)
**Правило фазы:** организационное извлечение контракта, без изменения
семантики Job Protocol v2. `protocol_version`, endpoints, auth, Redis,
timeout, retry, cancel, payload format — не менялись (см. §«Намеренно не
менялось»).

---

## 1. Что сделано

Создан самостоятельный контрактный пакет **`contracts/`**
(`@animastor/contracts`) — единый источник истины Job Protocol v2 для
backend, GPU Hub и Worker перед физическим извлечением Worker (Phase 9D).

Путь `contracts/` выбран на верхнем уровне репозитория (а не
`packages/contracts`, как preliminarily писало §8): репозиторий уже следует
конвенции «один package = одна директория верхнего уровня» (`backend/`,
`gpu-hub/`, `worker/`, `ai-connector/`). §8 `JOB_PROTOCOL_V2.md` обновлён.

### 1.1 Состав пакета

```
contracts/
├── package.json          # @animastor/contracts, 0 runtime deps, MIT, main src/index.js
├── package-lock.json     # lockfileVersion 3, без зависимостей
├── README.md             # scope, consumers table, contributor rules
├── LICENSE               # MIT (как у ai-connector)
├── src/
│   ├── job-protocol-v2.js   # canonical implementation (перенесена дословно
│   │                        #   из backend/src/runtime/job-schema.js)
│   └── index.js             # flat + namespaced re-export
└── tests/
    ├── harness.cjs          # zero-dep micro-runner (как ai-connector)
    ├── run-all.cjs          # npm test
    └── job-protocol-v2.test.cjs  # 37 тестов (см. §5)
```

### 1.2 Что именно вынесено (и откуда)

| Вынесено | Источник | Примечание |
|---|---|---|
| `PROTOCOL_VERSION = 2` | `job-schema.js:25` | дословно; frozen |
| `JOB_TYPES = ['audio','image','iu_image','video']` | `job-schema.js:27` | дословно |
| `STAGE_BY_KIND` | `job-schema.js:28-33` | дословно |
| `CHUNK_INDEX_RE`, `GROUP_SUFFIX_RE`, grammar-функции `buildJobId / splitJobId / parseJobId / getStageForJobId` | `job-schema.js:35-126` | тела функций не менялись (в `splitJobId` `JOB_TYPES.includes` → `Set.has` — эквивалентная семантика, см. §4) |
| `SYSTEM_JOB_TYPES = ['audio','image','video']` | hub-константа (`gpu-hub.js:53`), экспортирована как протокольная | additive; hub пока не потребляет (blocker B1) |
| `JOB_ID_SPLIT_RE = /:(iu_image\|image\|audio\|video)$/` | worker-литерал (`worker.cjs:611,625`), экспортирован как протокольный | additive; worker пока не потребляет (blocker B2) |
| `TASK_ENVELOPE_REQUIRED_FIELDS`, `TASK_ENVELOPE_FIELDS` | документированная таблица §3.2 `JOB_PROTOCOL_V2.md` (= hub-проверка `gpu-hub.js:766` + rebuild-набор `:810-847`) | additive, advisory-константы |
| `RESULT/ERROR/BEACON_ENVELOPE_REQUIRED_FIELDS` | §3.10–3.12 (= hub-проверки `gpu-hub.js:1057, :1205, :679`) | additive, advisory |
| `ERROR_TOKENS` | §3.13 (canonical wire error tokens) | additive |
| `validateTaskEnvelopeIdentity`, `validateResultEnvelopeIdentity` | advisory-хелперы, зеркалящие существующие hub-гарантии | additive; в production **никем не вызываются** (см. §4) |

Главное правило соблюдено: **никакой новой бизнес-логики**. Grammar и
константы перенесены, additive-часть — только данные (константы/токены) и
два чистых advisory-хелпера, повторяющих задокументированное поведение hub.

## 2. Canonical source

- **Canonical:** `contracts/src/job-protocol-v2.js` (`@animastor/contracts`).
- **Нормативная спецификация (без изменений):**
  `docs/architecture/JOB_PROTOCOL_V2.md` — обновлён только в части
  фиксации canonical location (§2 source of truth, §3.1/§3.3/§3.4 line-refs,
  §8 migration notes). Содержание протокола (envelope, grammar, endpoints,
  auth, timeouts, limits, invariants) не менялось.
- **Документация пакета:** `contracts/README.md` (scope + consumer table).

## 3. Consumers: миграция

| Consumer | До 9C | После 9C | Изменение импортов |
|---|---|---|---|
| backend (10 production-файлов через `job-schema`) | собственный модуль | `backend/src/runtime/job-schema.js` — **compatibility facade**, `module.exports = require('@animastor/contracts').jobProtocolV2` | **нет** — все 10+ импорт-сайтов (`gpu-dispatcher`, `task-handler`, `generation-routes`, `audio/generation`, `iu-processor`, `video-service`, `scene-orchestrator`, `reconciliation-engine`, `comfyui-provider`, тесты) не тронуты |
| GPU Hub | inline-копия `PROTOCOL_VERSION = 2` | **без изменений** (blocker B1) | нет |
| Worker | inline-копия `PROTOCOL_VERSION = 2` + split-regex | **без изменений** (blocker B2) | нет |

### 3.1 Как backend разрешает пакет (без npm-registry)

- Локально/CI: `node_modules/@animastor/contracts` → symlink на
  `../../contracts` (создаётся командой из README; в git не входит,
  `node_modules/` заигнорирован). Тесты и локальный запуск работают.
- Контейнер (docker-compose backend): добавлен read-only mount
  `./contracts:/app/node_modules/@animastor/contracts:ro` (однострочное,
  additive изменение `docker-compose.yml`).
- **`backend/package.json` и `backend/Dockerfile` НЕ менялись** — file:-dep
  ломал бы `npm install` внутри docker build (контекст сборки `./backend`
  не содержит `../contracts`). Пакетная зависимость будет оформлена
  npm-механикой в Phase 9D (blocker B3).
- `npm pack --dry-run` проходит; tarball устанавливается локально
  (`npm install <tgz>` → `require('@animastor/contracts')` работает,
  проверено). **В registry не публикуется.**

## 4. Намеренно НЕ менялось

- `protocol_version = 2` — во всех трёх источниках, литералы не тронуты
  (pins: `phase2-job-protocol-v2`, `gpu-hub-contract`, `phase9c-contracts`).
- `gpu-hub/gpu-hub.js` — **ни байта** (включая SYNC-комментарии: якорь
  по-прежнему ведёт на backend-путь; facade продолжает существовать, поэтому
  якорь не лжёт).
- `worker/worker/*.cjs` — **ни байта** (zero-dep bundle freeze Phase 9B).
- Все endpoints, auth, Redis-ключи, TTL, timeout-значения, payload-формат,
  коды ответов — вне scope и не тронуты.
- `backend/package.json`, `backend/Dockerfile`, `gpu-hub/*` Dockerfile,
  install-manifests, `scripts/` (кроме additive-строк syntax-smoke).
- Backend imports (10+ файлов) — не тронуты.
- Аддитивные комментарии/константы в contracts **не используются
  production-кодом** — поэтому «поведение» (behavior) backend/hub/worker на
  wire идентично baseline. Единственное функционально-эквивалентное
  изменение внутри grammar: `splitJobId` использует `Set.has` вместо
  `Array.includes` (идентичная семантика членства, O(1) вместо O(n) —
  непрофилируемо на 4 типах).

## 5. Тесты

### 5.1 Новые

| Suite | Результат |
|---|---|
| `contracts` package tests (`npm test` в `contracts/`) | **37 pass / 0 fail** — перенесены все ожидания `backend/tests/job-schema.test.js` (векторы, strictness) + `PROTOCOL_VERSION=2`, `JOB_TYPES`/`SYSTEM_JOB_TYPES`/`STAGE_BY_KIND` pins, boundary cases (`0000`/`9999`/`00000` chunk, `_g0`/`_g123`/`_gg` group, `_iu` substring-семантика legacy-маркера, пустые/non-string входы, roundtrip), envelope/error-контракты, unknown-fields behavior (§3.20: игнорируются), export-surface freeze (ровно 19 ключей) |
| `backend/tests/architecture/phase9c-contracts.test.js` | **17 pass / 0 fail** — architecture guards C1–C7 + cross-side contract test (см. §6) |

### 5.2 Обновлённые пины (только test-only правки, semantics сохранены)

| Тест | Что изменено |
|---|---|
| `gpu-hub-contract.test.js` | literal-pin `PROTOCOL_VERSION` теперь читает canonical contracts (+ фасад проверен на отсутствие собственного литерала); SYNC-якорь теста проверяет ссылку фасада на `@animastor/contracts`; новый runtime-identity тест (facade === contracts function objects) |
| `phase2-job-protocol-v2.test.js` | то же переанкерение literal-pin на contracts; canonical-parse describe требует contracts напрямую (runtime-identity закреплён в phase9c) |

Ни одно ожидание не ослаблено: все векторы, значения и strict-сравнения
сохранены; добавлены только новые проверки.

### 5.3 Прогон против baseline Phase 9B

| Прогон | Baseline (HEAD `5aef28e2`) | После Phase 9C | Дельта |
|---|---|---|---|
| Architecture suite (`tests/architecture/*.test.js`) | 230 pass / 1 fail (F6) | **248 pass / 1 fail (F6)** | +18 (17 новых phase9c + 1 новый gpu-hub-contract), F6 pre-existing |
| Полный backend suite (`tests/**/*.test.js`) | 2797 pass / 3 fail (F1, F2, F6) | **2816 pass / 3 fail (F1, F2, F6)** | +19 passing; идентичный набор pre-existing failures |
| F1/F2/F6 проверка на чистом HEAD (targeted) | 85 pass / 3 fail | — | подтверждено: failures не вызваны Phase 9C |
| Contracts package tests | — (не существовало) | **37 pass / 0 fail** | новый контур |
| ai-connector package tests | 69 pass / 0 fail | **69 pass / 0 fail** | без изменений |
| Syntax smoke (`scripts/syntax-smoke.sh`, + contracts area) | OK | **OK** (contracts добавлен в default-scan) | additive |
| `npm pack --dry-run` (contracts) | — | **OK** — 5 файлов, 5.6 kB | — |
| Локальная установка tarball + require | — | **OK** (20 exports, `PROTOCOL_VERSION=2`) | — |

F1 (`ai-endpoint-sharing`), F2 (`ai-shared-inference`), F6
(`phase2-lac-transport-contract`) — pre-existing (Phase 8B/8D), вне scope,
не исправлялись (как и предписано планом фазы).

## 6. Защита от регрессии (architecture guards, `phase9c-contracts.test.js`)

| Guard | Что запрещает |
|---|---|
| C1 manifest | переименование пакета, появление runtime-зависимостей у contracts |
| C2 isolation | require npm-пакетов из contracts; require'ы из contracts в backend/worker/gpu-hub/LAC |
| C3 pure facade | возврат грамматики/`PROTOCOL_VERSION`-литерала в `job-schema.js` (facade должен остаться re-export'ом) |
| C3 no second schema | грамматика (`parseJobId/buildJobId/splitJobId/getStageForJobId`) определяется ТОЛЬКО в contracts (исключение: файл-делегатор, требующий facade — так уже устроен `comfyui-provider.buildJobId`); независимый `PROTOCOL_VERSION = <n>` литерал в любом production-дереве (allowlist: contracts canonical, frozen hub/worker копии, LAC v1 — отдельный протокол) |
| C4 value pin | незаметное изменение `PROTOCOL_VERSION`, `JOB_TYPES`, `SYSTEM_JOB_TYPES`, `STAGE_BY_KIND` в canonical-пакете |
| C5 dependency direction | потребление contracts из production-кода кроме единственного choke point (backend facade); bans bare `@animastor/contracts` requires в hub/worker/LAC |
| C6 cross-side parity | runtime-identity фасад↔contracts; worker split-regex family ≡ canonical `JOB_TYPES`; hub `SYSTEM_JOB_TYPES` ≡ canonical; frozen parse-векторы идентичны на contracts и facade |
| C7 deployment | срыв compose-mount `./contracts:/app/node_modules/@animastor/contracts:ro` (иначе backend-контейнер теряет разрешение пакета) |

Плюс существующие guard'ы продолжают действовать без изменений: worker
zero-dep freeze и R1/R2/P7-T2/T3 (`dependency-guardrails`,
`phase7-extraction-readiness`).

**Dependency direction итог:** `contracts ← backend (facade)`; hub/worker —
на копиях (HTTP-контракт); `contracts` не зависит ни от кого (0 deps).

## 7. Blockers перед Phase 9D (physical worker extraction)

| # | Blocker | Суть | План |
|---|---|---|---|
| B1 | **GPU Hub не потребляет contracts runtime** | docker build контекст `./gpu-hub` не содержит `../contracts`; `file:../contracts` ломает `npm install` в образе; перевод hub на require = изменение Dockerfile/deployment | Phase 9D: наряду с перемещением worker'а перестроить build-контексты (root context / vendoring / bundle-включение пакета), затем заменить inline-копии hub на require |
| B2 | **Worker не потребляет contracts runtime** | worker — self-contained zero-dep bundle (Phase 9B freeze; guard `dependency-guardrails` R1); пакет не может быть require'нут из поставляемого на GPU-машины бандла без изменения физической структуры поставки | Phase 9D: при формировании standalone-пакета `animastor-worker` включить contracts в бандл (vendored copy с sync-гвардом или inlined build) — и только потом заменить inline-литералы |
| B3 | **npm-зависимость backend не оформлена** | `backend/package.json` намеренно не объявляет `file:../contracts` (ломал бы docker build — см. §3.1); разрешение — symlink + compose-mount | Phase 9D: build-context surgery (root context или COPY-пакета), после чего — обычный `file:`-dep и lockfile |
| B4 | **Standalone image run backend (без compose-маунтов) деградирует** | образ собирается из контекста `./backend` и не содержит contracts; сегодня развертывание идёт через docker-compose (src и так live-маунтится + новый ro-mount), но `docker run` образа без маунтов упадёт на boot при require facade | Фиксится вместе с B3 (пакет окажется в образе); в compose-деплое (единственном документированном) поведения нет |
| B5 | **Advisory-хелперы не вызываются production-кодом** | `validateTaskEnvelopeIdentity/validateResultEnvelopeIdentity` и envelope-константы — контрактная документация-as-данные; hub продолжает собственные проверки | Подключение — решение Phase 9D/v3 (необязательно; hub-валидацию менять сейчас запрещено) |

## 8. Git hygiene

- Файлы изменения (полный `git status`): новый `contracts/` (9 файлов),
  `backend/src/runtime/job-schema.js` (facade), `docker-compose.yml` (+1
  mount), `scripts/syntax-smoke.sh` (+contracts area), 2 test-пина,
  новый `phase9c-contracts.test.js`, `JOB_PROTOCOL_V2.md` (canonical
  location), этот аудит. Unrelated-изменений нет; production-код backend
  (кроме 1-файлового facade) и весь код hub/worker не тронуты.
- Обратимость: `git revert` одного коммита возвращает baseline; symlink
  `node_modules` — вне git.

## 9. Verdict

**Phase 9C: COMPLETE.** Контракт вынесен, canonical закреплён пакетом,
потребители backend переведены через compatibility facade, поведение на wire
не изменилось (подтверждено прогонами), anti-drift guards установлены.
Следующий шаг — Phase 9D: физическое извлечение Worker (+ блокеры B1–B4 из
§7 этого документа).
