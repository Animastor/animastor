# Repository Split Preparation Plan

Дата: 2026-10-01
Ветка: `c21.4-physically-extract-analysis-from-backend`
Статус: проектирование, физического разделения нет (read-only аудит; проверочные
команды — только `npm install --dry-run` в `/tmp`).
Опирается на: `docs/architecture/repository-split-reconnaissance-audit.md`.

Целевые репозитории: `animastor-backend`, `animastor-web`,
`animastor-android`, `animastor-worker`, `animastor-gpu-hub`.

---

## 1. Dependency map (фактическое состояние)

### 1.1 Граф зависимостей

```
                    @animastor/contracts (npm 0.1.1, канон Job Protocol v2)
                    ▲            ▲              ▲
      generation ───┘   gpu-hub ─┘  orchestration ┘
            ▲                 ▲
            │ file:           │ (npm ^0.1.0 + BAKE-IN artifacts)
  backend ──┴── 11 пакетов file:  │
            ▲                     │
            │ /gpu HTTP           │ 4 группы артефактов (bake-in)
        web-app ── 13 web-* file: │
            ▲                     │
   worker ──┴── Job Protocol v2 ──┘
   (сгенерированная копия job-protocol-v2.cjs, zero-dep bundle)
```

### 1.2 backend → packages (12)

`backend/package.json`: 11 × `file:../packages/…` (ai-agent, ai-analysis,
assistant, editor, generation, installer, orchestration, parser, player,
url-safety, vbook-runtime) + `@animastor/auth: ^0.1.0` (npm).

**`@animastor/contracts` в backend/package.json ОТСУТСТВУЕТ намеренно**
(`backend/src/runtime/job-schema.js`, Phase 9C, blocker B3): резолвится через
корневой симлинк `node_modules/@animastor/contracts → ../../packages/animastor-contracts`
+ read-only mount в compose (`./packages/animastor-contracts:/app/node_modules/@animastor/contracts:ro`).

**Критическая деталь сборки backend** (`backend/Dockerfile`): build context —
`./backend` (без packages!). `npm install` при отсутствии `file:`-целей
**не падает** (проверено экспериментально: npm молча пропускает отсутствующие
`file:`-зависимости). Пакеты подкладываются в контейнер read-only mounts из
compose: contracts, comfyui-workflow-connector, vbook-runtime, player, installer.
Итого текущая схема: *silent skip при build + runtime-патч node_modules через
bind mounts*.

Глубокие субпатч-импорты через имена пакетов (легитимные, но требующие
`exports`/`files` у опубликованных пакетов):
- `@animastor/parser/source-coverage` (3 вызова)
- `@animastor/vbook-runtime/lazy-book/*`, `/books-root`, `/snake-guard`, … (~12)
- `@animastor/ai-analysis/tasks/structure-detector-deterministic`

Скрытых импортов исходников по относительным путям (`../../packages/…`) в
`backend/src` и `frontends/app/src` **не обнаружено**.

### 1.3 web → packages (13)

`frontends/app/package.json`: 13 × `file:../../packages/animastor-web-*`.
Все web-пакеты: `main/module = dist/index.js`, `types = dist/index.d.ts`,
`files = [dist, README, LICENSE]` — публикация идёт из собранного `dist/`.
Импорты приложения — только по именам пакетов, без субпатчей и относительных
эскейпов.

### 1.4 GPU Hub — потребляемые файлы (детально, Phase 10T.1)

Build context = **корень монорепо**. Источники:

| Группа артефактов | Источник в монорепо | Назначение | Тип |
|---|---|---|---|
| `worker-bundle/` | `packages/animastor-worker/worker/` | раздача воркерам (`GET /worker-bundle`) | runtime-данные, baked при build |
| `workflows/` | `backend/ai/workflows/` (8 файлов) | ComfyUI workflow для install manifests; SHA256 сверяется с `baseline_sha256` манифестов | runtime-данные |
| `installer-src/` | `packages/animastor-installer/src/installer/` + `package.json` | universal installer, скачивается воркером (`cli.js`, `index.js` — проверяются `check-artifacts.sh`) | runtime-данные |
| `install-manifests/` | `packages/animastor-installer/ai/install-manifests/` (audio/image/video) | манифесты установки, `worker_bundle.min_version` | runtime-данные |
| hub-код | `packages/animastor-gpu-hub/{gpu-hub,server,tarball,bootstrap}.js` + package.json | само приложение | runtime-код |
| integrity-скрипт | `scripts/check-artifacts.sh` | `/app/scripts/check-artifacts.sh` | build-time COPY, runtime-утилита |
| npm-зависимости | express, cors, ioredis, **@animastor/contracts ^0.1.0** (`PROTOCOL_VERSION`) | — | runtime-код |

Вывод: hub-код самодостаточен (runtime-зависимости — только npm); **несамодостаточна
сборка образа** — 4 группы runtime-данных приезжают из трёх будущих репозиториев
(worker, backend, installer-пакет внутри backend).

### 1.5 Worker ↔ Contracts (детально, Phase 9D)

- Канон: `packages/animastor-contracts/src/job-protocol-v2.js`.
- Сгенерированная копия: `packages/animastor-worker/worker/job-protocol-v2.cjs`
  — header (sha256 канона + версия contracts) + байт-в-байт тело. Worker
  **не может** `require('@animastor/contracts')` в рантайме (zero-dep bundle,
  GPU-машины без npm registry).
- Генератор `tools/sync-protocol.cjs` находит канон по **monorepo-относительным
  путям** (2 глубины); в standalone checkout канон недоступен → генерация
  невозможна (только `--check` падает корректно).
- Тесты `tests/job-protocol.test.cjs` тоже ссылаются на путь contracts (test-only).
- Guard со стороны backend: `backend/tests/architecture/phase9d-worker-package.test.js`.
- Версии: worker bundle — собственный semver `2.1.1` (worker/package.json —
  canonical bundle version), протокол — `PROTOCOL_VERSION` из contracts (0.1.1).

### 1.6 Android

`frontends/android/` самодостаточен (gradle); связей по коду с web нет —
только документированный parity (`ANDROID_WEB_PARITY.md`, комментарии
«Web parity: frontends/app …» в ресурсах). `tools/*-web-tester` — два
отдельных gradle-проекта для web-тестирования.

---

## 2. GPU Hub extraction plan

Цель: собирать `animastor-gpu-hub` из своего репозитория без checkout монорепо.

Hub-код уже изолирован (тесты `tests/run-all.cjs` запрещают monorepo-импорты и
защищают 13-route surface). Проблема только в 4 группах артефактов.

### Варианты поставки артефактов

| Вариант | Суть | Плюсы | Минусы |
|---|---|---|---|
| **A. Registry-артефакты (GH Releases / GHCR)** | worker, backend, installer публикуют zip/tarball артефакты с version+sha256; hub Dockerfile скачивает по pinned-версии в stager-стейдж | чистая граница репозиториев; воспроизводимость (digest-pin как уже требует standalone overlay); `check-artifacts.sh` уже проверяет sha256-базлайны | нужен publish-механизм и CI; первый fetch — сеть |
| **B. npm-пакеты-артефакты** | артефакты как npm tarballs (`@animastor/worker-bundle`, `@animastor/installer-artifacts`) | уже есть npm infra; semver | артефакты — данные, не код; семантика npm избыточна; workflows — данные backend, публиковать их как npm странно |
| **C. Docker multi-stage с Build Contexts / extra build inputs** | сборка hub из нескольких git-источников (buildkit additional contexts) | без промежуточных артефактов | жёсткая связность сборок трёх репо; нет pinning digest; невоспроизводимо; воспроизводит проблему монорепо в новом виде |
| **D. Оставить как есть (fat checkout)** | hub-репо содержит скрипт, делающий sparse-checkout трёх репо перед build | минимум изменений | псевдоразделение; хрупко |

**Рекомендация: A (release-артефакты) с элементами B.**
- Worker bundle: уже имеет canonical version (2.1.1) и `files`-манифест —
  публиковать как attachment GitHub Release тега worker-репо + sha256.
- Workflows + install-manifests: принадлежат backend (манифесты — installer
  пакету внутри backend) — версия артефакта = backend release tag.
- Hub Dockerfile: stager-стейдж `ADD <artifact-url>` c `ARG` pinned digest;
  проверка — существующий `check-artifacts.sh` без изменений.
- Промежуточно (до появления CI/реестра): `ARG`-пути могут указывать на
  локальные каталоги, монтируемые извне — но целевое состояние только A.

Изменения в коде: только Dockerfile stager-стейдж + переменные сборки.
`check-artifacts.sh` переезжает в hub-репо (он копируется в образ).

---

## 3. Worker ↔ Contracts plan

Worker получает из contracts ровно один модуль: `job-protocol-v2.js`
(`PROTOCOL_VERSION`, `JOB_ID_SPLIT_RE`, парсинг job_id). Исходники contracts
нужны только для генерации, не для рантайма.

### Схема после split

1. Канон остаётся в `@animastor/contracts` (npm, репозиторий backend).
2. `animastor-worker` добавляет **devDependency** `@animastor/contracts`
   (не runtime: bundle zero-dep).
3. `sync-protocol.cjs` меняет резолв канона: сначала
   `require.resolve('@animastor/contracts/package.json')` (npm), затем
   текущие monorepo-глубины как fallback (обратная совместимость на переходный
   период). Сгенерированный файл и parity-гварды не меняются.
4. CI worker-репо: `sync:protocol --check` на каждый PR (drift = fail).

### Версионирование

- `PROTOCOL_VERSION` (wire contract) — единая константа в contracts; frozen
  (JOB_PROTOCOL_V2.md). Меняется только осознанно, через фриз-документ.
- Заголовок сгенерированной копии уже хранит `contracts version + sha256` —
  использовать как базу версионной привязки: в README worker-репо и в
  release notes фиксировать «bundle 2.x.y ⇐ contracts 0.1.z (sha256 …)».
- Hub и backend продолжают брать протокол из npm contracts; несовпадение
  `PROTOCOL_VERSION` отвергается всеми тремя сторонами (уже реализовано).

---

## 4. Backend / Web npm migration plan

Все 24 пакета, потребляемые по `file:`, уже опубликованы на npm, локальные
версии = опубликованным (дрейфа нет). Миграция — смена specifier'ов, а не
создание релизов.

### 4.1 backend (11 file: + 1 скрытый)

| Пакет | Сейчас | Цель после миграции |
|---|---|---|
| ai-agent, ai-analysis, assistant, editor, generation, installer, orchestration, parser, player, url-safety, vbook-runtime | `file:../packages/…` | `^<local version>` |
| **contracts** | нет в package.json (симлинк+mount) | `"@animastor/contracts": "^0.1.1"` — **обязательный шаг**, иначе после split backend теряет протокол |

Последствия: `backend/package-lock.json` — полная регенерация; compose —
удалить 5 read-only mounts пакетов (contracts, comfyui-connector,
vbook-runtime, player, installer); Dockerfile не меняется (npm install
начнёт реально ставить пакеты); deep-subpath импорты проверить против
`exports`/`files` каждого опубликованного пакета (parser/source-coverage,
vbook-runtime/lazy-book/*, ai-analysis/tasks/*) — при отсутствии субпатча в
`exports` дополнить и выпустить patch-версию.

Порядок внутри монорепо (до split, безопасно): переключить specifier'ы →
локально проверить `npm ci` + тесты → compose-мmounts становятся избыточными,
но не вредными → удалить mounts отдельным шагом.

### 4.2 web (13 file:)

Все 13 web-* → `^0.1.0`. Требования: у каждого пакета `dist/` актуален на
момент публикации (publish из собранного dist); в web-репо появится скрипт
сборки пакетов перед `vite build` (сейчас сборку dist обеспечивает процесс
извлечения пакетов; в монорепо порядок «package build → app build» нигде
явно не зафиксирован — **проверить перед миграцией**, чей скрипт собирает dist).

### 4.3 Общие риски миграции

- npm **молча пропускает** отсутствующие `file:`-цели (проверено) — после
  split забытый `file:`-specifier не уронит `npm install`, а уронит рантайм.
  Контрмера: CI-check `grep -r '"file:' package.json` = 0 в каждом репо.
- Локальная разработка поверх npm-версий медленнее: при необходимости —
  `npm link`/`file:` только через локальный override-файл, не в git.

---

## 5. Shared infrastructure ownership

| Элемент | Владелец после split | Обоснование |
|---|---|---|
| `docker-compose.yml` | **infra-слой внутри `animastor-backend`** (временно shared по факту) | описывает всю систему: postgres, redis, backend, gpu-hub, nginx; mounts из 5 будущих репо |
| `docker/compose/overlay-gpu-hub-*.yml` | `animastor-gpu-hub` (standalone — точно; local — infra) | hub-специфичные overlays |
| `docker/e2e/` (dispatch-task, install-driver) | infra (backend) | сквозные e2e backend↔hub↔worker |
| `docker/worker/` (Dockerfile, entrypoint) | `animastor-worker` | платформенный образ воркера |
| `proxy/` (nginx conf, compose) | infra (backend) | маршрутизация animastor.in: /api → backend, /gpu → hub, раздача frontends+docs |
| `scripts/check-artifacts.sh` | `animastor-gpu-hub` | копируется в hub-образ |
| `scripts/generate-parser-golden-fixtures.js` | `animastor-backend` | parser-пакет |
| `scripts/` прочее (o3-scc-audit, syntax-smoke, runtime-audit, translate_docs) | infra (backend) | кроссовые аудиты |
| `tools/desktop-web-tester`, `tools/mobile-web-tester` | `animastor-web` | web-тестовые Android-харнессы |
| root: `backend-rebuild.sh`, `front-backend-rebuild.sh`, `src-backup.sh` | infra (backend) | деплой backend |
| root: `app-web-rebuild.sh` | `animastor-web` | деплой web |
| root: `gpu-hub-rebuild.sh` | `animastor-gpu-hub` | деплой hub |
| root: `apk-build.sh`, `build-apk.sh`, `local.properties` | `animastor-android` | сборка APK |
| root: `workflow.json` | `animastor-backend` | монтируется в backend |
| `docs/` (282 файла) | **`animastor-backend`** (это основной продукт-репо), nginx-portal остаётся монтируемым оттуда | альтернатива — отдельный docs-репозиторий: оправдан только если docs начнут мешать code-review-шуму; пока не создавать (см. §8) |
| `docs/architecture/JOB_PROTOCOL_V2.md`, `GPU_HUB_CONTRACT.md` | backend (норматив), копии-ссылки в worker/hub README | контракты читают все стороны |
| `.github/` | отсутствует | CI появится уже в split-репо |
| `.env.example`, `.dockerignore`, `.gitignore` (root) | infra (backend) + копии по репо | — |

Шестой репозиторий (`animastor-infra`) **осознанно не создаём**: объём infra
мал (~30 файлов), а compose по сути «сборочный чертёж продукта», живущий рядом
с backend. Триггер для пересмотра: если compose-файлы начнут часто меняться
без изменений backend.

---

## 6. GitHub mirror architecture (VPS → 5 зеркал)

VPS остаётся source of truth.

### 6.1 Целевая схема

```
VPS:
  /home/animastor/repos/
    animastor.git            (существующий монорепо-bare → зеркало Animastor/animastor, архив)
    animastor-backend.git    ─ post-receive → git@github.com:Animastor/animastor-backend.git
    animastor-web.git        ─ post-receive → git@github.com:Animastor/animastor-web.git
    animastor-android.git    ─ post-receive → git@github.com:Animastor/animastor-android.git
    animastor-worker.git     ─ post-receive → git@github.com:Animastor/animastor-worker.git
    animastor-gpu-hub.git    ─ post-receive → git@github.com:Animastor/animastor-gpu-hub.git
```

### 6.2 Hooks — почему ничего не уничтожится

Опасность `git push --mirror` в том, что mirror затирает в destination всё,
чего нет в source. Уничтожение чужого содержимого возможно только если один
bare пушит в чужой mirror. Правила:

1. **Один hook — один remote.** Каждому bare-репо — свой `post-receive`,
   пушащий строго в свой GitHub-репозиторий. Репозитории не разделяют remotes.
2. В каждом split-bare лежат только его собственные ветки/теги ⇒ `push --mirror`
   в собственное зеркало безопасен.
3. У монорепо-hook (`git push --mirror github` → `Animastor/animastor`) после
   split ничего не меняется, но монорепо **замирает** (freeze) — его зеркало
   становится архивом. Пока в монорепо ведётся работа — split-пуши не идут в
   `Animastor/animastor` (нет пересечения ремотов).
4. Защита от human error: в каждом split-hook добавить guard — push только
   если `$GL_REPO`/basename bare совпадает с ожидаемым (или просто не
   использовать один hook-файл на несколько баров).

Пример hook (одинаковой формы в каждом split-bare, различается URL):

```sh
#!/bin/sh
cd "$GIT_DIR" || exit 1
echo "Mirroring to GitHub..."
git push --mirror git@github.com:Animastor/animastor-backend.git
```

### 6.3 Первичная публикация каждого split-репозитория

1. `git clone /home/animastor/repos/animastor.git /tmp/split-backend`
   (полный клон — источник истории).
2. В клоне: `git filter-repo <path-фильтр из §7>` — переписывается **клон**,
   не основной репозиторий.
3. `git remote add origin /home/animastor/repos/animastor-backend.git`
   → `git push --all` + `git push --tags`.
4. В bare создать `post-receive` (§6.2) → первый же push (или ручной
   `git push --mirror`) публикует зеркало в GitHub.
5. GitHub Org `Animastor`: создать пустые репо заранее (без README, без
   auto-commit), выставить default branch `master`.

Порядок для всех пяти одинаков. Удалённые ветки (после merge c21.4 и удаления
tmp-ветки останется `master`) фильтруются вместе с историей автоматически.

### 6.4 Поддержка

- Работа: dev → push в VPS split-bare (origin) → hook зеркалирует в GitHub.
- Монорепо после freeze: только чтение/архив; mirror продолжает существовать.
- Новый clone для разработчика: с VPS bare (истина), GitHub — зеркальная копия.

---

## 7. filter-repo path map

Точная таблица `repo → paths → dependencies → required history`.
Формат путей — для `git filter-repo --path … --path …` (инвертированные
списки не использовать: белые списки безопаснее).

| Repo | Paths (белый список) | Dependencies | Required history |
|---|---|---|---|
| **animastor-backend** | `backend/`, `workflow.json`, `packages/animastor-ai-agent/`, `ai-analysis`, `assistant`, `auth`, `contracts`, `editor`, `generation`, `installer`, `orchestration`, `parser`, `player`, `url-safety`, `vbook-runtime`, `ai-connector`, `comfyui-workflow-connector` (все `packages/animastor-<name>/` кроме `web-*`, `worker`, `gpu-hub`), `backend-rebuild.sh`, `front-backend-rebuild.sh`, `src-backup.sh`, `docs/` (см. §5), `ARCHITECTURE.md`, `MEMORY.md`, `CONTRIBUTING.md`, `SECURITY.md`, `THIRD_PARTY_NOTICES.md`, `LICENSE` | npm: 12 @animastor/* + external (express, pg, ioredis, sharp…); HTTP: gpu-hub (HUB_URL) | вся история перечисленных путей; критично: `packages/animastor-contracts/` (канон протокола), `backend/ai/workflows/` (baseline_sha256 для манифестов), `backend/src/runtime/job-schema.js` |
| **animastor-web** | `frontends/app/`, `frontends/website/`, `packages/animastor-web-*` (13), `tools/desktop-web-tester/`, `tools/mobile-web-tester/`, `app-web-rebuild.sh`, `ANDROID_WEB_PARITY.md`, `docs/05-frontend/`, `docs/08-mobile-web-migration/`, `docs/09-desktop-migration/` | npm: 13 @animastor/web-*; HTTP: backend /api | история web-пакетов (extraction-коммиты) + app |
| **animastor-android** | `frontends/android/`, `apk-build.sh`, `build-apk.sh`, `local.properties`, `ANDROID_WEB_PARITY.md` (копия или symlink-аналог), `docs/08-mobile-web-migration/` (parity-контекст) | HTTP: backend API; parity: web | история `frontends/android/` полностью (вкл. gradle-8.12) |
| **animastor-worker** | `packages/animastor-worker/`, `docker/worker/`, `gpu-hub-rebuild.sh` ❌ (это hub) — не включать; `docs/architecture/PHASE_9*_WORKER*.md`, `PHASE_10*_WORKER*`, `WORKER_PACKAGE_RELOCATION_*` | npm (dev): @animastor/contracts; runtime: hub artifacts (bundle получает hub по HTTP) | история bundle (`worker/*.cjs`), tests, tools/sync-protocol.cjs; job-protocol-v2.cjs — generated, но история полезна для archaeology |
| **animastor-gpu-hub** | `packages/animastor-gpu-hub/`, `scripts/check-artifacts.sh`, `gpu-hub-rebuild.sh`, `docker/compose/overlay-gpu-hub-standalone.yml` (local-остается в infra), `docs/architecture/GPU_HUB_CONTRACT.md`, `PHASE_10*GPU_HUB*` | npm: @animastor/contracts, express, cors, ioredis; build-time: release-артефакты worker/backend/installer (§2) | история hub-пакета + check-artifacts.sh |
| *(infra — внутри backend)* | `docker-compose.yml`, `docker/compose/overlay-gpu-hub-local.yml`, `docker/e2e/`, `proxy/`, `scripts/` (общие), `.env.example`, `.dockerignore` | — | история деплоя терять нельзя (эволюция compose-схемы) |

Нельзя потерять при фильтрации (проверенный список «живых» перекрёстных файлов):

1. `packages/animastor-contracts/src/job-protocol-v2.js` — канон; без него
   worker не сможет регенерировать копию (satisfies §3).
2. `backend/ai/workflows/*.json` + `packages/animastor-installer/ai/install-manifests/*` —
   связаны SHA256-базлайнами (проверка `check-artifacts.sh` упадёт при рассинхроне).
3. `packages/animastor-worker/tools/sync-protocol.cjs` и его parity-гварды.
4. `scripts/check-artifacts.sh` — часть образа hub.
5. `docs/architecture/JOB_PROTOCOL_V2.md`, `GPU_HUB_CONTRACT.md` — нормативные.
6. `backend/tests/architecture/phase9d/10t…` — 46 из 62 файлов architecture-тестов
   backend читают пути `packages/…` (включая worker/gpu-hub!) — **при split эти
   тесты физически не смогут работать внутри backend-репо**: перенести
   package-boundary тесты в соответствующие репо, в backend оставить
   backend-only; отразить в плане переноса тестов.

Cross-check: после фильтрации в каждом репо должен проходить `git log --follow`
по каждому файлу из списка «нельзя потерять».

---

## 8. Финальная схема split

| Repo | Содержимое | npm packages | Build | Runtime deps | External deps | Release mechanism |
|---|---|---|---|---|---|---|
| **animastor-backend** | backend/, 15 backend-packages, workflow.json, deploy-скрипты, docs/, infra (compose, proxy, e2e) | @animastor/{ai-agent, ai-analysis, assistant, auth, contracts, editor, generation, installer, orchestration, parser, player, url-safety, vbook-runtime}, animastor-{ai-connector, comfyui-workflow-connector}; приложение не публикуется | Docker (context ./backend), npm ci по версиям | postgres, redis, gpu-hub API, npm | — | npm publish (пакеты) + Docker image |
| **animastor-web** | frontends/app, website, 13 web-пакетов, web-testers, parity-doc | @animastor/web-* (13) | пакетный build → dist → vite build | backend /api, npm | — | npm publish + статика (nginx) |
| **animastor-android** | frontends/android | нет | gradle/ APK | backend API | — | GitHub Release (APK) |
| **animastor-worker** | packages/animastor-worker (bundle+tests+tools), docker/worker | нет (zero-dep bundle; contracts — devDep) | не требуется (bundle as-is); protocol sync — dev-time | hub (артефакты, задания), ComfyUI, npm (dev only) | node ≥18 | GitHub Release: worker-bundle vX.Y.Z + sha256 → потребляется hub-билдом |
| **animastor-gpu-hub** | packages/animastor-gpu-hub, check-artifacts.sh, hub-оверлеи | @animastor/gpu-hub | Docker multi-stage; stager качает pinned release-артефакты (worker-bundle, workflows+manifests, installer) | redis, npm | GHCR | npm publish + GHCR image (digest-pin, уже нормализовано standalone-оверлеем) |

### Блокеры до физического split

1. **B1. backend: contracts вне package.json** (симлинк+mount) → добавить
   `"@animastor/contracts"` в dependencies, убрать mount.
2. **B2. backend: 11 file:-зависимостей + mount-патч node_modules** → миграция
   на npm-версии (§4.1), удаление 5 mounts, регенерация lock.
3. **B3. web: 13 file:-зависимостей** → npm-версии; зафиксировать процесс
   «сборка dist пакетов → vite build».
4. **B4. Deep-subpath импорты** (parser/source-coverage, vbook-runtime/lazy-book/*,
   ai-analysis/tasks/*) → проверить/дополнить `exports`+`files` опубликованных
   пакетов, выпустить patch.
5. **B5. GPU Hub bake-in из трёх репо** → внедрить release-артефакты (§2),
   переключить stager, проверить standalone-сборку без монорепо.
6. **B6. sync-protocol.cjs monorepo-резолв** → npm-резолв канона (§3), CI drift-check.
7. **B7. 46/62 backend architecture-тестов читают `packages/…`, включая
   worker/gpu-hub пути** → раскидать тесты по репо-владельцам до split,
   иначе split сломает половину guard-сьюта.
8. **B8. web dist build orchestration не зафиксирована** → определить скрипт
   сборки пакетов в web-репо.
9. **B9. Отсутствие CI** → до split минимум: test+publish workflow для
   backend- и web-пакетов, artifact release для worker/hub.
10. **B10. post-receive монорепо `--mirror`** → новые bare должны создаваться
    сразу со своими hooks; монорепо freeze до первого split-push (§6).
11. **B11. nginx-portal раздаёт `./docs` и `./frontends` из монорепо-путей** →
    после split деплой должен монтировать пути из соответствующих bare/выкачек.
12. **B12. Untracked root package.json** (animastor-ai-connector deps) —
    решить: либо включить в backend-репо, либо удалить; после split у корня
    монорепо смысла нет.

### Пошаговый порядок будущего split

0. FF `master` до c21.4; удалить `tmp/parser-audit-backup` (по подтверждению).
1. **Размонорепизация зависимостей** (B1–B4, B6, B8, B12): внутри монорепо
   перевести backend/web на npm-версии; Contracts → backend deps; exports-патчи;
   sync-protocol npm-резолв. Каждый шаг — отдельный коммит с прогоном тестов.
2. **Артефактная схема hub** (B5): release worker-bundle; hub stager на pinned
   артефактах; сквозная проверка `check-artifacts.sh`.
3. **Перенос тестов** (B7): architecture-тесты — по владельцам путей.
4. **CI** (B9): workflows test/publish в монорепо-пути (временно), чтобы после
   split они переехали в свои репо без переписывания.
5. Создать 5 bare на VPS + 5 GitHub-репо (пустых); hooks по §6.2 — **до** пушей.
6. По очереди (backend → web → android → worker → gpu-hub): filter-repo клон
   (§7) → push в bare → зеркалирование в GitHub → smoke: `npm ci && npm test`.
7. Freeze монорепо; финальная сверка tips; монорепо-зеркало → архив.
8. Декомпозиция compose на split-реальность (B11): пути монтирования, CI деплой.

---

## Методика проверки

- Все выводы основаны на чтении фактических файлов (Dockerfile ×3, compose ×3,
  package.json ×30, hooks, sync-protocol, check-artifacts) и на эксперименте
  с npm (молчаливый пропуск file:-целей) в `/tmp`.
- Кодовые изменения в этой задаче не производились.
