# PHASE 9D — Worker Physical Extraction Audit

**Status:** executed (physical extraction complete). Runtime behavior,
Job Protocol v2 wire semantics, endpoints, auth, Redis keys/TTL,
timeout/retry/cancel semantics and payload format: **unchanged**.
**Date:** 2026-09-06
**Baseline:** HEAD `8350d997` (Phase 9C — `@animastor/contracts` extracted).
**Related:** PHASE_9_WORKER_EXTRACTION_READINESS_AUDIT.md (plan),
PHASE_9B (dependency isolation), PHASE_9C (contracts), JOB_PROTOCOL_V2.md
(normative, FROZEN).

---

## Executive summary

Phase 9D made the Worker a **self-contained standalone package/artifact**
that can be copied to a clean machine with Node ≥ 18 and started without
the monorepo. The runtime bundle stays at `worker/worker/` — the physical
location every deployment channel already consumes — while the package
boundary became explicit: canonical `package.json` (v2.1.0, private),
package-owned zero-dep tests, packaging allowlist, generated Job Protocol
copy, and architecture guards.

Blocker B2 (worker consumes canonical Job Protocol v2) is resolved with
**option B** (explicitly generated build-time copy with parity/hash/version
guards). Option A (real npm dependency on `@animastor/contracts`) was
rejected because the bundle is delivered to GPU machines without an npm
registry (Phase 9B zero-runtime-dep freeze + hub tar/installer file-list
delivery); a runtime `require` of an unpublished package would break every
install channel.

| Критерий | До 9D | После 9D |
|---|---|---|
| Package boundary | неявный (просто каталог с package.json) | явный: manifest v2.1.0 + private + files + engines + README |
| Job Protocol v2 в worker | inline-литералы в worker.cjs (2-я реализация de-facto) | generated copy из canonical + parity/hash guards |
| Unit-тесты пакета | в backend-дереве (mocha/chai) | в пакете (`worker/tests/`, zero-dep harness) |
| Standalone запуск | не проверялся | доказан smoke (npm pack → чистая директория → boot) |
| Architecture guards | R1 (outbound), P7-T2 (inbound) | + phase9d: containment, surface freeze, parity, negative control |

**Вердикт: EXTRACTION COMPLETE — standalone artifact доказан.**

---

## 1. Extraction map (старая структура)

### 1.1 Production runtime (фактический артефакт) — `worker/worker/`

| Файл | Роль |
|---|---|
| `worker.cjs` | runtime entrypoint (`main()`), только node builtins |
| `worker-cleanup.cjs` | per-job artifact cleanup (unlink-only логика) |
| `worker-cleanup-journal.cjs` | crash-safe journal (CREATED→GENERATED→DELIVERED→CLEANED) |
| `worker-env.cjs` | zero-dep `.env` loader (real env always wins) |
| `package.json` | **canonical bundle version** (hub читает version, worker.cjs — beacon) |
| `package-lock.json` | пустой lock (zero deps) |
| `.env.example` | env-контракт (обязательные/опциональные ключи) |

### 1.2 Dev-only / ops (не входит в артефакт)

| Путь | Роль |
|---|---|
| `worker/start-worker.sh` | операторский старт в repo-checkout layout (daemon + env + ComfyUI detect) |
| `worker/bootstrap-*.sh`, `fix-nodes-*.sh`, `start-video.sh`, `mc.sh` | первоначальная setup GPU-инстанса |
| `worker/new/*` | mirrored scripts + заметки (SYSTEM.md/MEMORY.md — ссылки как evidence в manifests) |
| `worker/image/worker/` | legacy stub package.json (name "worker", 0.1.0, main worker.js — divergent, мёртвый; задокументирован как legacy, не тронут) |
| `worker/Dockerfile`* | не существует; docker-путь — `docker/worker/Dockerfile` (installer-контейнер) |

### 1.3 Пути, которые использует runtime

- **input:** `COMFY_INPUT_DIR` (default `/home/jovyan/ComfyUI/input`)
- **output:** `COMFY_OUTPUT_DIR` = `resolve(COMFY_INPUT_DIR, "../output")`
- **temp/journal:** `WORKER_JOURNAL_DIR` (default — рядом с worker.cjs)
- **ComfyUI:** `http://127.0.0.1:${COMFY_PORT}${NOTEBOOK_PATH}`
- **models:** не знает (домен ComfyUI/installer)
- **scripts:** нет (полностью self-contained)
- **configuration:** `./.env` рядом с worker.cjs (`worker-env.cjs`) + реальные env (приоритет у env)
- **env vars:** `HUB_URL`, `ANIMASTOR_WORKER_TOKEN` (fail-closed), `WORKER_TYPE`, `WORKER_ID`,
  опциональные: `ANIMASTOR_API_URL`, `COMFY_PORT`, `COMFY_INPUT_DIR`, `NOTEBOOK_PATH`,
  `WORKER_VERSION`, `WORKER_IMAGE_TAG`, `RESULT_TIMEOUT_MS`, `VIDEO_RESULT_TIMEOUT_MS`,
  `TASK_SLEEP_MS`, `BEACON_INTERVAL_MS`, `WORKER_JOURNAL_DIR`
- **required Node:** ≥ 18 (global fetch; engines `>=18`; Docker image `node:22`,
  start-worker.sh floor = 18). Шапка worker.cjs согласована: «Node 18+ with
  global fetch is assumed». Унификация на 20+ — подготовка к 9E (E2), не 9D.

### 1.4 Deployment-каналы, привязанные к пути `worker/worker/`

1. `docker-compose.yml` gpu-hub mounts: `./worker/worker/worker.cjs:/app/worker-source/worker.cjs:ro`
   (deprecated single-file) и `./worker/worker:/app/worker-bundle:ro` (canonical tar).
2. install-manifests ×3 (`image/qwen-image`, `audio/qwen-tts`, `video/ltx-2.3`):
   `worker_bundle.source.options → repository: "worker/worker/"`, files list.
3. installer engine fallback: `repoRoot/worker/worker`
   (`backend/src/installer/engine/worker.js`).
4. hub `WORKER_BUNDLE_DIR=/app/worker-bundle` — walkDir берёт ВСЁ (кроме `.env*`).

**Решение по физическому пути:** каталог НЕ перемещён. Все четыре канала
(и ~20 тестовых пинов) уже указывают на `worker/worker/`; перемещение дало
бы нулевую runtime-выгоду и сломало бы deployment (нарушение ограничения
«не удалять старый deployment-путь»). Физическое извлечение реализовано
через package contour, а не через переименование каталога.

---

## 2. Новая структура

```
worker/                          ← package boundary (ops + dev + docs)
├── README.md                    ← NEW: standalone install/run/packaging doc
├── tools/
│   └── sync-protocol.cjs        ← NEW: generator canonical → bundle copy (B2)
├── tests/                       ← NEW: package-owned zero-dep test contour
│   ├── harness.cjs              ← micro-runner (contracts harness pattern)
│   ├── run-all.cjs
│   ├── worker-env.test.cjs      ← порт backend/tests/worker-bundle-env.test.js (unit-часть)
│   ├── worker-cleanup.test.cjs  ← порт backend/tests/worker-cleanup.test.js (11 it)
│   ├── worker-cleanup-journal.test.cjs ← порт (15 it)
│   ├── job-protocol.test.cjs    ← NEW: parity + frozen wire values + split usage
│   ├── package.test.cjs         ← NEW: contour freeze, manifests, env contract
│   └── standalone.test.cjs      ← NEW: boot smoke из чистой копии (fail-closed + Protocol: 2)
├── worker/                      ← runtime bundle (см. §1.1) — canonical артефакт
│   ├── worker.cjs               ← потребляет ./job-protocol-v2.cjs (больше не inline)
│   ├── job-protocol-v2.cjs      ← NEW: GENERATED from @animastor/contracts
│   └── package.json             ← v2.0.0 → 2.1.0, private, files, engines, scripts
├── start-worker.sh …            ← без изменений (ops)
└── new/, image/                 ← без изменений (legacy, задокументированы)
```

Разделение внутри boundary: **runtime** = `worker/worker/` (ровно 8 файлов),
**tests** = `worker/tests/` (не попадают в hub tar и npm pack),
**configuration** = `.env.example`, **documentation** = `worker/README.md`,
**packaging** = `package.json` (files allowlist) + `tools/sync-protocol.cjs`.

### 2.1 package.json (canonical version source)

- `version`: **2.0.0 → 2.1.0** — bump обязателен: состав артефакта изменился
  (+ generated copy), версия публикуется hub'ом и является ключом
  compatibility resolver'а installer'а.
- `private: true` — защита от случайного npm publish (ограничение фазы).
- `files` allowlist — ровно runtime-набор (npm pack проверен).
- `engines: node >=18`; scripts: `start`, `test`, `sync:protocol`, `check:protocol`.
- dependencies/optionalDependencies/devDependencies: **отсутствуют** (zero-dep
  freeze сохранён, в т.ч. dev — тесты используют собственный harness).

---

## 3. Contracts integration (blocker B2 — RESOLVED, option B)

**Механизм:**

1. Canonical: `contracts/src/job-protocol-v2.js` (`@animastor/contracts@0.1.0`).
2. Generator: `worker/tools/sync-protocol.cjs` — читает canonical, пишет
   `worker/worker/job-protocol-v2.cjs` = GENERATED-header (sha256 canonical +
   версия contracts) + **verbatim body**.
3. worker.cjs: `const { PROTOCOL_VERSION, JOB_ID_SPLIT_RE } = require("./job-protocol-v2.cjs")`.
   Inline `const PROTOCOL_VERSION = 2` и два inline split-литерала удалены.
4. Guard'ы parity:
   - `worker/tests/job-protocol.test.cjs` — frozen values + byte parity (dev-time);
   - `backend/tests/architecture/phase9d-worker-package.test.js` D4 — byte parity,
     sha256/version stamps, deterministic regeneration, **negative control**
     (tamper → verify() ловит дрейф и по телу, и по runtime-значению);
   - `sync-protocol.cjs --check` — CI-режим (exit 1 при дрейфе);
   - phase9c C3/C6 обновлены: grammar-scan и PROTOCOL_VERSION-literal allowed
     set знают о generated copy; worker.cjs пинится как БЕЗ локальных литералов.

**Почему не вариант A:** бандл доставляется на GPU-машины тремя каналами без
npm registry (hub tar, installer file-list, manual copy). Runtime-зависимость
от неопубликованного пакета потребовала бы либо коммита node_modules, либо
изменения deployment (npm install на целевой машине) — оба варианта нарушают
ограничения фазы. Generated copy — единственный путь, дающий canonical
гарантии без изменения доставки. При появлении опубликованного пакета (9E+)
переход на вариант A — механическая замена require + удаление generated copy.

**Вторая реализация протокола в worker устранена:** worker.cjs больше не
содержит ни одного протокольного литерала; единственный протокольный код в
бандле — generated copy, byte-equal canonical.

---

## 4. Docker / deployment

**Без изменений (намеренно):** docker-compose mounts, `docker/worker/Dockerfile`,
`entrypoint.sh`, hub `WORKER_BUNDLE_DIR`/`WORKER_SOURCE_PATH`, installer engine
file-copy логика, `start-worker.sh`. Новые файлы попадают в tar через walkDir
автоматически; installer копирует манифестный список (обновлён на 8 файлов).

**Как запускается Worker после извлечения** (три эквивалентных способа):

1. **Manual standalone (главный результат 9D):** скопировать `worker/worker/`
   на любую машину с Node ≥ 18 → `cp .env.example .env` → `node worker.cjs`.
   Проверено: npm pack → tar → распаковка → boot; fail-closed exit 1 без
   токена; с токеном — полный startup (`Protocol version: 2`, ожидание ComfyUI).
2. **Hub bundle:** `GET {HUB_URL}/worker-bundle` (sha256 published) → распаковать → как (1).
3. **Installer:** CLI/docker entrypoint (без изменений) — deployит 8 файлов + .env merge.

Worker не знает расположения backend/GPU Hub — только `HUB_URL` (env).

---

## 5. Устранение monorepo-зависимостей (guards)

- Runtime: 0 inbound requires (P7-T2 сохранён), 0 outbound repo-edges.
  Все require бандла: node builtins + `./` внутри `worker/worker/`.
- **Новый guard D3** (`phase9d-worker-package.test.js`):
  - все relative require бандла resolve строго внутри `worker/worker/`
    (запрет `../` наружу);
  - запрет монорепо-фрагментов в спецификаторах (`backend/`, `gpu-hub/`,
    `frontends/`, `contracts/`, `ai-connector/`);
  - **negative control**: синтетическое нарушение ловится сканом;
- **D2 bundle surface freeze**: состав `worker/worker/` = ровно 8 runtime
  файлов (walkDir-политика hub'а делает каталог де-факто артефактом —
  состав заморожен против случайных файлов);
- **D1** package manifest pins (private/zero-deps/engines);
- **D6** манифесты ×3 обязаны содержать полный runtime-набор (иначе installer
  копирует неполный бандл — именно тот fail-mode, который D6 закрывает);
- **D7** deployment wiring pinned (compose mounts на `worker/worker/`);
- `worker/tests/` тоже сканируются на zero-deps (harness без npm install).

Оставшаяся dev-time зависимость (допустимая): worker/tests читают
`contracts/` и `backend/ai/install-manifests/` для parity/contour проверок —
это тесты, не runtime; в standalone-чекинутом пакете эти проверки graceful
skip (обозначено в тестах).

---

## 6. Packaging

- `npm pack --dry-run` из `worker/worker/`: ровно 7 файлов (6 runtime +
  package.json), 17.5 kB — files allowlist работает, tests/tools не попадают.
- Реальный `npm pack` → tar → распаковка в чистую директорию → boot:
  fail-closed (exit 1) + полный старт с env-токеном — проверено.
- Hub-канал: тот же состав + auto (walkDir); tests/tools в tar не попадают
  (физически лежат вне bundle dir).
- Registry publish: **не выполнялся** (private: true как защита).

---

## 7. Compatibility / rollback

- Старый deployment-путь `worker/worker/` **сохранён и является
  единственным** — shim не потребовался.
- Прежде установленные workers (v2.0.0 bundle) продолжают работать со своим
  старым worker.cjs: installer никогда не перезаписывает существующие файлы
  (`files_kept`), поэтому mixed-version инсталляции остаются согласованными
  (старый бандл самодостаточен — inline литералы).
- Существующая установка получит новый бандл только через явный reinstall;
  при этом резолвер installer'а корректно покажет недостающий
  `job-protocol-v2.cjs` как план обновления (покрыто installer-тестами).
- Rollback фазы: `git revert` (пути deployment не менялись, миграций нет).
- Version pin 2.0.0 в gpu-hub-artifacts.test.js обновлён на 2.1.0 в составе
  фазы (единый diff).

---

## 8. Tests (результаты прогона)

| Suite | Baseline 9C | После 9D |
|---|---|---|
| Backend full (`mocha tests/**`) | 2816 pass / 3 fail | **2798 pass / 3 fail** |
| — pre-existing fails | SH-AI-1, SH-AI-3, LAC stale-trace | те же (не задеты) |
| — сдвиг чисел | — | −32 (unit-тесты переехали в пакет) +14 (phase9d guards) |
| Worker package (`node tests/run-all.cjs`) | — | **45 pass / 0 fail** (32 порта + 11 новых + 2 boot smoke) |
| Contracts (`npm test`) | 37/0 | **37/0** |
| Syntax smoke | OK | OK |
| installer-cpu (свой runner) | 45/0 | **45/0** |
| gpu-hub-artifacts | pass | **30 pass** (пины: tar list + версия 2.1.0) |
| phase2-job-protocol-v2 / gpu-hub-contract / phase9c / orchestration-stabilization / dependency-guardrails / phase7 / phase2-hub-worker-boundary / lac-legacy-path-guard / install-manifest | pass | **pass** (пины перепинчены на generated copy) |
| Standalone smoke (ручной) | — | npm pack → clean dir → boot: PASS |

Обновлённые пины (перечень): `phase2-job-protocol-v2.test.js` (protocol copy,
split usages), `gpu-hub-contract.test.js` (D-секция), `phase9c-contracts.test.js`
(C3 allowed/generated, C6), `orchestration-stabilization.test.js` (literal → copy),
`gpu-hub-artifacts.test.js` (file list + version), `installer-phase15.test.js` /
`installer-resolver.test.js` / `installer-cpu.test.js` (manifest files list).

F1/F2/F6 старые не трогались; новых падений нет.

---

## 9. Production behavior — изменения по строкам

| Что | До | После | Поведение |
|---|---|---|---|
| `PROTOCOL_VERSION` | inline `= 2` (worker.cjs:49) | из generated copy (=2) | идентично |
| input-file naming | inline `split(/:(iu_image\|image\|audio\|video)$/)` ×2 | `split(JOB_ID_SPLIT_RE)` (= тот же regex) | идентично |
| версия в беаконе | 2.0.0 | 2.1.0 | информационное поле; hub не валидирует версию |
| файлы бандла | 7 | 8 (+job-protocol-v2.cjs) | require worker.cjs; манифесты обновлены |
| всё остальное | — | — | без изменений |

---

## 10. Что осталось от monorepo coupling (осознанно)

1. Deployment-каналы ссылаются на repo-путь `worker/worker/` (compose mounts,
   installer fallback). Это каналы ДОСТАВКИ артефакта, не кодовые зависимости.
2. `worker/tests/` в монорепо проверяют parity/manifests через `../contracts`
   и `../backend` — dev-time only, graceful skip в standalone.
3. `worker/start-worker.sh` предполагает repo-layout (импортирует ComfyUI
   операции) — ops-скрипт, не runtime; standalone-путь — `node worker.cjs`.
4. Hub/шара `worker-source` (deprecated) отдаёт только worker.cjs — новый
   worker.cjs требует generated copy, поэтому single-file install по-прежнему
   не работает (работал и раньше только частично; deprecated путь задокументирован
   в hub'е, canonical — /worker-bundle).
5. `worker/image/worker/package.json` — legacy divergent stub (name "worker",
   main worker.js); не используется, оставлен как есть (unrelated refactor).

---

## 11. Blockers перед Phase 9E (package verification + publish)

| # | Blocker | Суть |
|---|---|---|
| E1 | **npm publish** | `private: true` стоит намеренно; для публикации снять флаг, решить имя/скоуп (`animastor-worker` vs `@animastor/worker`) и npm auth (как Phase 8F). |
| E2 | **Node floor расхождение** | start-worker.sh ставит Node 18, шапка worker.cjs говорит 20+; engines >=18. Унифицировать (20+) на 9E — это изменение ops-скрипта, за рамками 9D. |
| E3 | **Протокольные копии hub/backend** | hub по-прежнему inline `PROTOCOL_VERSION = 2` (B1 из 9C), backend потребляет через фасад. Перевод hub на contracts = отдельная фаза (build-context surgery). |
| E4 | **Version bump policy** | настоящий bump (2.1.0) выполнен в составе фазы; для регулярных релизов нужна автоматизация (npm script/CI) — сейчас sync:protocol ручной. |

---

## 12. Ответ на главный вопрос фазы

**«Можно ли взять Worker из Animastor и передать его как самостоятельный
артефакт на другую машину/сервер, установить необходимые runtime
dependencies и запустить его без исходного monorepo?»**

**ДА.** Единственная runtime-зависимость — Node ≥ 18 (global fetch) и
доступный ComfyUI-эндпоинт на той же машине. Доказано: `npm pack` →
`animastor-worker-2.1.0.tgz` (17.5 kB, 7 файлов) → чистая директория →
`node worker.cjs` — fail-closed без токена, полный старт с токеном
(`Protocol version: 2` из generated canonical copy), ни одного require
наружу бандла. Job Protocol v2 имплантация в бандле byte-parity-guarded
против canonical `@animastor/contracts`.
