# Repository Split Preparation Plan

Дата: 2026-10-01 (ревизия 3 — точечная коррекция ревизии 2)
Ветка: `c21.4-physically-extract-analysis-from-backend`
Статус: проектирование; физического разделения нет (read-only аудит; проверочные
команды — `npm install` в `/tmp`, чтение файлов). Опирается на
`docs/architecture/repository-split-reconnaissance-audit.md`.

Целевые репозитории (ровно пять): `animastor-backend`, `animastor-web`,
`animastor-android`, `animastor-worker`, `animastor-gpu-hub`.

Согласующие документы: `PHASE_10R_GPU_HUB_ARTIFACT_DECOUPLING_PLAN.md`
(bake-in выбран вместо npm/CDN), `PHASE_10S_GPU_HUB_ARTIFACT_COMPATIBILITY_GUARDRAILS.md`
(матрица совместимости, SHA256-базлайны, `min_version`).

---

## 1. Dependency map (фактическое состояние)

### 1.1 Граф зависимостей

```
                 @animastor/contracts (npm 0.1.1 — канон Job Protocol v2)
                 ▲              ▲                ▲
       generation┘    gpu-hub ──┘   orchestration┘
             ▲                  ▲
             │ file:            │ npm ^0.1.0 (runtime) + 4 группы артефактов (bake-in)
   backend ──┴─ 11 × file:       │
             ▲                   │
             │ /gpu HTTP         │
   web-app ──┴─ 13 × file:        │
             ▲                   │
   worker ──┴─ job-protocol-v2.cjs (сгенерированная копия, zero-dep) ──┘
```

Числа (проверены): `packages/` содержит **30** директорий =
15 backend-пакетов + 13 web-пакетов + `animastor-worker` + `animastor-gpu-hub`.
29 пакетов имеют корневой `package.json` и все опубликованы на npm;
`packages/animastor-worker/` корневого `package.json` не имеет — canonical
версия bundle лежит в `worker/worker/package.json` (2.1.1, не публикуется).
`file:`-зависимостей ровно **24**: 11 в `backend/package.json` + 13 в
`frontends/app/package.json`. Ещё 2 скрытые связи: `@animastor/contracts`
в backend (симлинк + mount, вне package.json — блокер B1) и untracked
корневой `package.json` (B12).

### 1.2 backend → packages

`backend/package.json`: 11 × `file:../packages/…` (ai-agent, ai-analysis,
assistant, editor, generation, installer, orchestration, parser, player,
url-safety, vbook-runtime) + `@animastor/auth: ^0.1.0` (npm).

**`@animastor/contracts` в backend/package.json ОТСУТСТВУЕТ намеренно**
(`backend/src/runtime/job-schema.js`, Phase 9C): резолвится через корневой
симлинк `node_modules/@animastor/contracts → ../../packages/animastor-contracts`
и read-only mount (`./packages/animastor-contracts:/app/node_modules/@animastor/contracts:ro`).

**Сборка backend**: build context = `./backend` (packages не входят).
`npm install` при отсутствии `file:`-целей **не падает** (проверено: npm
молча пропускает отсутствующие `file:`-зависимости) — пакеты подкладываются
в контейнер 5 read-only mounts (contracts, comfyui-workflow-connector,
vbook-runtime, player, installer). Итог: *silent skip при build +
runtime-патч node_modules через mounts*.

Глубокие субпатч-импорты (все — по именам пакетов):

| Импорт | Кол-во | `exports` в пакете |
|---|---|---|
| `@animastor/parser/source-coverage` | 3 | ✅ `./source-coverage` объявлен |
| `@animastor/vbook-runtime/lazy-book/*`, `/books-root`, `/snake-guard`, `/scene-title-utils`, … | ~12 | ✅ 18 экспортов, включая `./lazy-book/*` и `./schemas/*` |
| `@animastor/ai-analysis/tasks/structure-detector-deterministic` | 1 | ✅ `./tasks/*` объявлены |

Вывод ревизии 2: **все используемые субпатчи уже покрыты `exports`** —
добавлять нечего; нужен только CI-гвард (см. §9, G2). Скрытых импортов
исходников по относительным путям (`../../packages/…`) в `backend/src` и
`frontends/app/src` **не обнаружено**.

### 1.3 web → packages

`frontends/app/package.json`: 13 × `file:../../packages/animastor-web-*`.
Все web-пакеты: `main/module = dist/index.js`, `types = dist/index.d.ts`,
`files = [dist, README, LICENSE]` — публикация из собранного `dist/`.
Импорты приложения — только по именам пакетов.

### 1.4 GPU Hub — потребляемые файлы (Phase 10T.1, проверено по Dockerfile)

Build context = корень монорепо. Hub-код (`gpu-hub.js`, `server.js`,
`tarball.js`, `bootstrap.js`) самодостаточен: runtime-зависимости — только
npm (`express`, `cors`, `ioredis`, `@animastor/contracts ^0.1.0` —
`PROTOCOL_VERSION`). Несамодостаточна сборка образа: 4 группы
runtime-**данных** приезжают из будущих репозиториев worker и backend.
Полная таблица источников — в §2 (artifact contract).

### 1.5 Worker ↔ Contracts

- Канон: `packages/animastor-contracts/src/job-protocol-v2.js`
  (`PROTOCOL_VERSION`, `JOB_ID_SPLIT_RE`, парсинг job_id).
- Копия: `packages/animastor-worker/worker/job-protocol-v2.cjs` — header
  (sha256 канона + версия contracts) + байт-в-байт тело. Worker не может
  require contracts в рантайме (zero-dep bundle, GPU-машины без registry).
- Генератор `tools/sync-protocol.cjs` ищет канон по monorepo-глубинам;
  в standalone checkout генерация невозможна → блокер B6.
- Worker bundle имеет собственный semver 2.1.1; манифесты требуют
  `worker_bundle.min_version = 2.0.0` (проверяется `check-artifacts.sh`).

### 1.6 Android

`frontends/android/` самодостаточен (gradle). Кодовых связей с web нет —
только parity-документация (§5) и комментарии «Web parity: frontends/app …»
в ресурсах.

---

## 2. GPU Hub artifact contract

Целевое состояние (после B5): образ `animastor-gpu-hub` собирается из своего
репозитория; 4 группы артефактов поступают по контракту ниже. Механизм
доставки **контрактом не фиксируется**: сегодня stager-стейдж делает `COPY`
из корня монорепо; после split — что угодно из: BuildKit additional build
contexts, `RUN curl` pinned release URL, CI-side staging. Меняется только
стейдж, контракт стабилен.

### 2.1 Формула контракта

```
artifact = name + version + source repository + source release/tag
         + release asset filename + sha256(asset) + consumer
```

Каждый артефакт идентифицируется: именем, версией, репозиторием-источником,
релизом/тегом, **конкретным именем asset внутри релиза**, sha256
именно этого asset и потребителем. Git tag технически передвигаем, поэтому
**воспроизводимость обеспечивается не «неизменяемостью» тега, а SHA256
asset — криптографическим якорем содержимого**: даже если tag или release
metadata изменятся, содержимое артефакта однозначно зафиксировано его
sha256 в pin-файле (tag указывает, где искать; sha256 — что именно должно
быть найдено; расхождение = fail build, §2.3). Pin не допускает неявного
выбора: один Release может содержать несколько asset — ссылка всегда по
точному имени файла asset.

### 2.2 Матрица артефактов

| name | Публикует (source repository) | Содержимое | Версия | Release tag | Release asset (точное имя файла) | sha256 хранится в | consumer |
|---|---|---|---|---|---|---|---|
| `worker-bundle` | **animastor-worker** | 6 файлов из `worker/` (по `files` из `worker/worker/package.json`): `worker.cjs`, `worker-env.cjs`, `worker-cleanup.cjs`, `worker-cleanup-journal.cjs`, `job-protocol-v2.cjs`, `.env.example` | semver из `worker/worker/package.json` — сейчас **2.1.1** | `worker-bundle-v2.1.1` | `animastor-worker-bundle-2.1.1.zip` | (1) body Release, (2) pin-файл hub (§2.5) | gpu-hub: bake → `/app/artifacts/worker-bundle/`; раздача воркерам; fingerprint-cache |
| `hub-workflows` | **animastor-backend** | `backend/ai/workflows/*.json` (8 файлов) | release-версия — сейчас **v1** | `hub-artifacts-v1` | `hub-workflows-v1.zip` | (1) body Release, (2) pin-файл hub | gpu-hub: bake → `/app/artifacts/workflows/` |
| `installer-src` | **animastor-backend** (пакет `@animastor/installer` живёт в backend-репо) | `packages/animastor-installer/src/installer/` + `package.json` (npm 0.1.0) | npm-версия `@animastor/installer` (**0.1.0**) + release **v1** | `hub-artifacts-v1` | `installer-src-v1.zip` | те же | gpu-hub: bake → `/app/artifacts/installer-src/`; воркер скачивает через hub |
| `install-manifests` | **animastor-backend** | `packages/animastor-installer/ai/install-manifests/{audio,image,video}/*.json` | release **v1** | `hub-artifacts-v1` | `install-manifests-v1.zip` | те же | gpu-hub: bake → `/app/artifacts/install-manifests/` |

Итого: **worker публикует 1 артефакт, backend — 3** (одним release-набором).
Правило имён: asset filename = `<artifact>-<release-version>.zip`; backend-тег
`hub-artifacts-v1` содержит три asset с суффиксом `v1`; npm-версия installer
(0.1.0) фиксируется в pin-файле и внутри архива (`package.json`). Pin всегда
ссылается на конкретный asset по точному имени — неявного выбора файла из
Release не существует.
Installer артефакты никуда не переезжают: пакет принадлежит backend-репо,
hub лишь потребляет его содержимое как данные.

### 2.3 Checksum / integrity — инвариант и три уровня

**Архитектурное правило (checksum invariant):** независимо от механизма
доставки (BuildKit additional build contexts, CI-side staging, `RUN fetch`
и т.п.) sha256 артефакта сверяется с pin-файлом/Release **на этапе staging,
до попадания артефакта в финальный образ** (до `COPY --from=stager`).
Checksum mismatch = fail build. `check-artifacts.sh` после сборки остаётся
дополнительной проверкой, но **не заменяет** staging-проверку целостности.

1. **Артефакт-архив**: sha256 конкретного asset (§2.2) фиксирован в body
   GitHub Release и в pin-файле hub; сверка обязательна на staging (см. выше).
2. **Внутренние базлайны (уже существуют)**: манифесты хранят
   `baseline_sha256` каждого workflow и `worker_bundle.min_version` —
   `check-artifacts.sh` проверяет [3/6] version compat и [4/6] SHA256 workflow.
3. **Bake-in верификация (уже существует)**: Dockerfile RUN-проверка 4 групп +
   `check-artifacts.sh` [1/6], [2/6], [5/6], [6/6] (структура, версия bundle,
   отсутствие monorepo-путей, entry points installer).

Новые проверки не проектируются — существующие переезжают в hub-репо как есть.

### 2.4 Как GPU Hub получает артефакт

Stager-стейдж материализует 4 дерева (механизм — build inputs/`RUN fetch`,
см. выше), **проверяет sha256 каждого asset против pin-файла на staging-шаге**
и только затем отдаёт результат: `COPY --from=stager` → `/app/artifacts/` →
RUN-верификация в той же сборке. Runtime-резолв (`/app/artifacts/...`) не
меняется; fallback-пути в монорепо отсутствуют.

### 2.5 Что pin'ится для воспроизводимой сборки

- **pin-файл hub-репо** (новый, напр. `artifacts.lock.json`): name →
  `{ source_repository, release_tag, asset_filename, version, sha256 }` для
  всех 4 артефактов (поля — по формуле §2.1; sha256 — конкретного asset).
  Обновляется осознанным коммитом при апгрейде артефактов.
- Базовые образы — по digest (`alpine:3.19`, `node:20-slim` → `@sha256:…`),
  как уже требует standalone-overlay для `GPU_HUB_IMAGE` (прод-образ
  `ghcr.io/animastor/animastor-gpu-hub@sha256:eb9a98…` — pin by digest).
- npm-зависимости — через `package-lock.json` (уже есть).

Плюсы/минусы альтернатив (выбор зафиксирован в 10R и подтверждён): bake-in из
release-артефактов — выбран; npm-пакеты для данных — отвергнуто (данные ≠ код);
CDN/объектное хранилище — отвергнуто (новая инфраструктура); runtime-mounts из
чужих репо — отвергнуто (это и есть текущая связанность, цель — устранить).

---

## 3. Worker ↔ Contracts plan

Worker получает из contracts один модуль (`job-protocol-v2.js`); исходники
нужны только для генерации, не рантайма.

1. Канон остаётся в `@animastor/contracts` (npm, backend-репо).
2. `animastor-worker` добавляет **devDependency** `@animastor/contracts`.
3. `sync-protocol.cjs`: резолв канона через
   `require.resolve('@animastor/contracts/…')` (npm) с сохранением текущих
   monorepo-глубин как fallback на переходный период. Сгенерированный файл
   и parity-гварды не меняются.
4. CI worker: `sync:protocol --check` на каждый PR.

**Версионирование**: wire-версия — `PROTOCOL_VERSION` из contracts (frozen,
меняется только через фриз-документ). Связка фиксируется в заголовке
сгенерированной копии (уже реализовано: `contracts version + sha256`) и в
release notes worker: «bundle 2.x.y ⇐ contracts 0.1.z (sha256 …)».
Backend/hub берут протокол из npm; несовпадение `PROTOCOL_VERSION` отвергается
всеми тремя сторонами (реализовано, тесты — см. §8, phase2).

---

## 4. Backend / Web npm migration plan

Все 24 пакета, потребляемые по `file:`, опубликованы на npm; локальные версии
равны опубликованным (дрейфа нет). Миграция — смена specifier'ов.

### 4.1 backend (11 file: + 1 скрытый)

| Пакет | Сейчас | Цель |
|---|---|---|
| ai-agent, ai-analysis, assistant, editor, generation, installer, orchestration, parser, player, url-safety, vbook-runtime | `file:../packages/…` | `^<local version>` |
| **contracts** | вне package.json (симлинк+mount) | `"^0.1.1"` — **обязательный шаг (B1)** |

Последствия: регенерация `backend/package-lock.json`; удаление 5 read-only
mounts из compose (после B1/B2); Dockerfile не меняется. Замечание ревизии 2:
у трёх пакетов (`ai-agent`, `ai-analysis`, `orchestration`) нет
`package-lock.json` — при миграции создать.

### 4.2 web (13 file:)

Все 13 → `^0.1.0`. Требование: зафиксировать процесс «build dist пакетов →
vite build» (сейчас порядок нигде явно не закреплён — блокер B8).

### 4.3 Общие риски

npm молча пропускает отсутствующие `file:`-цели (проверено) — после split
забытый `file:` не уронит `npm install`, а уронит рантайм → CI-гвард G1 (§9).
Локальная разработка поверх npm-версий — через локальные override, не в git.

---

## 5. Android / Web parity — целевая схема

Факты: в репо **два** parity-файла. Корневой `ANDROID_WEB_PARITY.md`
(32.5 KB, checkpoint-аудиты до 2026-09-02) — актуальный; 
`docs/architecture/ANDROID_WEB_PARITY.md` (9.8 KB, аудит 2026-08-21) —
устаревший снимок. `docs/08-mobile-web-migration/` (9 файлов) описывает
mobile-web миграцию web-приложения.

**Целевая схема:**

- **Canonical source**: `ANDROID_WEB_PARITY.md` в корне **animastor-web**
  (та же директория, что и сегодня). Владелец — animastor-web: web — primary
  implementation (это зафиксировано в заголовке документа), parity-изменения
  инициируются изменениями web-функциональности.
- **animastor-android** получает актуальность через **snapshot, синхронизируемый
  CI**: владельцем canonical-файла является **animastor-web**; android-CI
  забирает его из репозитория `animastor-web` по явному межрепозитному
  механизму (fetch из VPS bare web или его полного клона; GitHub читается
  только как mirror того же содержимого, §6 — не «источник») и проверяет
  **commit + sha256 файла**. При изменении — автоматический PR, обновляющий
  `ANDROID_WEB_PARITY.md` в android-репо (путь сохраняется). До появления CI —
  ручной шаг в android-чеклисте релиза. Android **не редактирует** содержимое
  кроме служебного колонтитула «snapshot of web@<commit>».
- `docs/architecture/ANDROID_WEB_PARITY.md` (старый снимок) уходит в
  **animastor-web** как исторический архив; редактированию не подлежит.
- `docs/08-mobile-web-migration/` — **целиком animastor-web** (документирует
  миграцию web-UI; тестовые харнессы `tools/*-web-tester` тоже web-репо).
  Android не получает эту директорию — его вход — только parity-файл.
- После split: ссылки между репо — по имени репозитория (`animastor-web`;
  `Animastor/animastor-web` — лишь адрес его зеркала), никаких относительных
  путей.

---

## 6. VPS vs GitHub vs Releases — три уровня

Зафиксировать три различных понятия:

```
1) VPS bare repositories        = SOURCE OF TRUTH исходного кода
   /home/animastor/repos/{animastor,animastor-backend,animastor-web,
   animastor-android,animastor-worker,animastor-gpu-hub}.git
   Любая разработка — push сюда. filter-repo/split работает ТОЛЬКО здесь.

2) GitHub repositories          = MIRRORS (Animastor org)
   Только чтение для людей; создаются пустыми, наполняются hook'ом.
   Никакой код не рождается в GitHub.

3) GitHub Releases / GHCR / npm = DISTRIBUTION MECHANISM
   Потребители артефактов (Docker builds, воркеры, пользователи APK).
   Не источник исходников: split/зеркалирование никогда не читает отсюда.
```

Что может публиковаться в Releases/GHCR **без путаницы с source-of-truth**
(всё — производные от зеркалируемых исходников):

| Публикация | Репозиторий-источник | Формат |
|---|---|---|
| worker-bundle | animastor-worker | GitHub Release zip + sha256 |
| hub-workflows + installer-src + install-manifests | animastor-backend | GitHub Release (единый набор) + sha256 |
| gpu-hub образ | animastor-gpu-hub | GHCR, pin by digest |
| APK | animastor-android | GitHub Release |
| npm-тарболы 29 пакетов | backend/web | npm registry |
| web-статика | animastor-web | (опц.) Release / деплой на VPS |

Правило: распределительные артефакты содержат только собранные/копируемые
файлы из white-list своего репо (§8); «обратной» сборки исходников из них нет.

---

## 7. GitHub mirror architecture (VPS → 5 зеркал)

VPS остаётся source of truth (§6).

### 7.1 Целевая схема

```
VPS: /home/animastor/repos/
  animastor.git          → зеркало Animastor/animastor (после split — freeze/архив)
  animastor-backend.git  → post-receive → git@github.com:Animastor/animastor-backend.git
  animastor-web.git      → post-receive → git@github.com:Animastor/animastor-web.git
  animastor-android.git  → post-receive → git@github.com:Animastor/animastor-android.git
  animastor-worker.git   → post-receive → git@github.com:Animastor/animastor-worker.git
  animastor-gpu-hub.git  → post-receive → git@github.com:Animastor/animastor-gpu-hub.git
```

### 7.2 Hooks — почему ничего не уничтожится

`git push --mirror` затирает в destination всё, чего нет в source. Правила:

1. **Один hook — один remote.** Каждый split-bare имеет свой `post-receive`,
   пушащий строго в свой GitHub-репозиторий; ремоты не разделяются.
2. В split-bare лежат только его ветки/теги ⇒ mirror в собственное зеркало безопасен.
3. Монорепо-hook (`--mirror` → `Animastor/animastor`) не меняется, но монорепо
   после split замирает; его зеркало — архив. Пересечения ремотов нет.
4. Guard от human error: hook пушит только при совпадении basename bare.

```sh
#!/bin/sh
cd "$GIT_DIR" || exit 1
echo "Mirroring to GitHub..."
git push --mirror git@github.com:Animastor/animastor-backend.git
```

### 7.3 Первичная публикация (каждого репо одинаково)

1. `git clone /home/animastor/repos/animastor.git /tmp/split-<name>` —
   полный клон старого монорепо используется **только как исходная история**.
2. В клоне: `git filter-repo <white-list из §8>` (переписывается клон, не source).
3. Результат пушится **только в новый VPS bare split-репозиторий**:
   `git remote add origin /home/animastor/repos/animastor-<name>.git`;
   `git push --all && git push --tags`. Прямой push из временного клона в
   GitHub **запрещён**.
4. GitHub получает изменения **исключительно через post-receive mirror-hook**
   соответствующего bare (§7.2); hook создаётся **до** первого push.
5. В GitHub Org `Animastor` репо создаются заранее пустыми (без README/auto-commit),
   default branch `master`.

### 7.4 Поддержка

Разработка: dev → push в VPS bare → hook → зеркало. Монорепо — архив.
Клонирование разработчиками — с VPS bare.

---

## 8. filter-repo path map (полные white-lists)

Принцип: белые списки `--path` (git filter-repo матчит префиксы директорий).
Дублирование истории допускается и объявлено: **backend получает `docs/`
целиком как архив/портал**; подмножества docs, принадлежащие другим репо,
редактируются только у владельца (§5), копия в backend замораживается.
Все пути — реальные tracked-пути (проверено `git ls-files`).

### 8.1 animastor-backend

```sh
git filter-repo \
  --path backend \
  --path packages/animastor-ai-agent \
  --path packages/animastor-ai-analysis \
  --path packages/animastor-ai-connector \
  --path packages/animastor-assistant \
  --path packages/animastor-auth \
  --path packages/animastor-comfyui-workflow-connector \
  --path packages/animastor-contracts \
  --path packages/animastor-editor \
  --path packages/animastor-generation \
  --path packages/animastor-installer \
  --path packages/animastor-orchestration \
  --path packages/animastor-parser \
  --path packages/animastor-player \
  --path packages/animastor-url-safety \
  --path packages/animastor-vbook-runtime \
  --path docs \
  --path docker \
  --path proxy \
  --path scripts \
  --path docker-compose.yml \
  --path workflow.json \
  --path MiM.vbook \
  --path backend-rebuild.sh \
  --path front-backend-rebuild.sh \
  --path src-backup.sh \
  --path README.md \
  --path ARCHITECTURE.md \
  --path MEMORY.md \
  --path CONTRIBUTING.md \
  --path SECURITY.md \
  --path THIRD_PARTY_NOTICES.md \
  --path LICENSE \
  --path .env.example \
  --path .dockerignore \
  --path .gitignore
```

Notes: `docs/` входит **целиком как исторический архив** — включая
`docs/architecture/ANDROID_WEB_PARITY.md`, который физически попадает в
backend из-за `--path docs`. Это историческая копия: она **не редактируется**
после split (canonical — web, snapshot — android, §5). White-list по этой
причине не меняется. `MiM.vbook` — сэмпл VBook-фикстура (упоминается только
в docs). `docker/` включает `docker/worker/` и `overlay-gpu-hub-standalone.yml`
как архив (владельцы — §8.4/8.5).

### 8.2 animastor-web

```sh
git filter-repo \
  --path frontends/app \
  --path frontends/website \
  --path packages/animastor-web-ai-chat \
  --path packages/animastor-web-book-session \
  --path packages/animastor-web-editor \
  --path packages/animastor-web-file \
  --path packages/animastor-web-generator \
  --path packages/animastor-web-generator-config \
  --path packages/animastor-web-generator-sse \
  --path packages/animastor-web-generator-vbook \
  --path packages/animastor-web-local-ai \
  --path packages/animastor-web-navigator \
  --path packages/animastor-web-player \
  --path packages/animastor-web-settings \
  --path packages/animastor-web-workers \
  --path tools/desktop-web-tester \
  --path tools/mobile-web-tester \
  --path app-web-rebuild.sh \
  --path ANDROID_WEB_PARITY.md \
  --path docs/05-frontend \
  --path docs/08-mobile-web-migration \
  --path docs/09-desktop-migration \
  --path docs/architecture/ANDROID_WEB_PARITY.md \
  --path docs/architecture/web-ai-chat-settings-boundary-audit.md \
  --path docs/architecture/web-generator-extraction-audit.md \
  --path docs/architecture/web-local-ai-extraction-audit.md \
  --path docs/architecture/web-next-extraction-reconnaissance.md \
  --path docs/architecture/web-package-extraction-reconnaissance.md \
  --path docs/architecture/web-player-module-extraction-audit.md \
  --path docs/architecture/web-workers-extraction-audit.md \
  --path LICENSE
```

Корневой `ANDROID_WEB_PARITY.md` здесь — canonical (§5).

### 8.3 animastor-android

```sh
git filter-repo \
  --path frontends/android \
  --path apk-build.sh \
  --path build-apk.sh \
  --path local.properties \
  --path ANDROID_WEB_PARITY.md \
  --path LICENSE
```

### 8.4 animastor-worker

```sh
git filter-repo \
  --path packages/animastor-worker \
  --path docker/worker \
  --path docs/architecture/JOB_PROTOCOL_V2.md \
  --path docs/architecture/PHASE_9_WORKER_EXTRACTION_READINESS_AUDIT.md \
  --path docs/architecture/PHASE_9B_WORKER_DEPENDENCY_ISOLATION_AUDIT.md \
  --path docs/architecture/PHASE_9D_WORKER_PHYSICAL_EXTRACTION_AUDIT.md \
  --path docs/architecture/PHASE_9D_INDEPENDENT_VERIFICATION_AUDIT.md \
  --path docs/architecture/PHASE_9E_NPM_PUBLIC_RELEASE_AUDIT.md \
  --path docs/architecture/PHASE_9E_WORKER_RELEASE_READINESS_AUDIT.md \
  --path docs/architecture/WORKER_PACKAGE_RELOCATION_AUDIT.md \
  --path docs/architecture/WORKER_PACKAGE_RELOCATION_CHECKLIST.md \
  --path docs/architecture/EXPERIMENTAL_BETA_PRIVATE_WORKER_AUDIT.md \
  --path docs/architecture/EXPERIMENTAL_BETA_PRIVATE_WORKER_PHASE1_SECURITY_REVIEW.md \
  --path docs/architecture/EXPERIMENTAL_BETA_PRIVATE_WORKER_PHASE2_SECURITY_REVIEW.md \
  --path docs/architecture/EXPERIMENTAL_BETA_PRIVATE_WORKER_PHASE3_SECURITY_REVIEW.md \
  --path docs/architecture/EXPERIMENTAL_BETA_PRIVATE_WORKER_RECONNAISSANCE.md \
  --path docs/architecture/EXPERIMENTAL_BETA_WORKER_SETUP.md \
  --path docs/architecture/LINUX_INSTALLER_RECONNAISSANCE.md \
  --path LICENSE
```

`JOB_PROTOCOL_V2.md` — синхронизируемый снимок: канон принадлежит **backend**,
worker получает его snapshot по §5-механизму (владелец, CI, commit+sha256).

### 8.5 animastor-gpu-hub

> **⛔ R-3 = A (SELECTED) → §8.5 НЕ ИСПОЛНЯЕТСЯ.**
> `git filter-repo` для GPU Hub **не выполняется**, существующий
> `Animastor/animastor-gpu-hub` (bare = GitHub = `7c7778c`, 43 коммита)
> **не перезаписывается и не force-push'ится**, новый репозиторий **не
> создаётся**; его standalone history **канонична**.
> Нижайший блок `--path …` сохранён **только как историческая запись**
> отклонённого варианта B (**REJECTED / NOT SELECTED**).
> Норматив: `repository-split-r3-decision.md`.
> Исполняемый лист §4.1.5 и карта §5.5 в `repository-split-next-blockers.md`
> помечены **REJECTED / DO NOT EXECUTE**.

```sh
# ⛔ REFUSE — §8.5 REJECTED при R-3 = A. Существующий GPU Hub не перезаписывается.
echo "REFUSE: §8.5 REJECTED (R-3 = A) — filter-repo gpu-hub НЕ ВЫПОЛНЯЕТСЯ" >&2
exit 1
# --- ниже только историческая запись варианта B; выполнение запрещено ---
git filter-repo \
  --path packages/animastor-gpu-hub \
  --path scripts/check-artifacts.sh \
  --path gpu-hub-rebuild.sh \
  --path docker/compose/overlay-gpu-hub-standalone.yml \
  --path docs/architecture/GPU_HUB_CONTRACT.md \
  --path docs/architecture/JOB_PROTOCOL_V2.md \
  --path docs/architecture/PHASE_10_GPU_HUB_EXTRACTION_READINESS_AUDIT.md \
  --path docs/architecture/PHASE_10A_GPU_HUB_CONTRACT_FREEZE_AUDIT.md \
  --path docs/architecture/PHASE_10B_GPU_HUB_PROTOCOL_MIGRATION_AUDIT.md \
  --path docs/architecture/PHASE_10C_GPU_HUB_EXTRACTION_READINESS_AUDIT.md \
  --path docs/architecture/PHASE_10D_GPU_HUB_PACKAGE_EXTRACTION_AUDIT.md \
  --path docs/architecture/PHASE_10E_GPU_HUB_RELEASE_READINESS_AUDIT.md \
  --path docs/architecture/PHASE_10G_GPU_HUB_REGISTRY_MIGRATION.md \
  --path docs/architecture/PHASE_10H_GPU_HUB_PHYSICAL_EXTRACTION_AUDIT.md \
  --path docs/architecture/PHASE_10I_EXTERNAL_GPU_HUB_INTEGRATION_READINESS_AUDIT.md \
  --path docs/architecture/PHASE_10J_GPU_HUB_CUTOVER_PREPARATION_AUDIT.md \
  --path docs/architecture/PHASE_10K_GPU_HUB_INDEPENDENT_CI_RELEASE_READINESS_AUDIT.md \
  --path docs/architecture/PHASE_10L_GPU_HUB_GHCR_STAGING_AUDIT.md \
  --path docs/architecture/PHASE_10M_GPU_HUB_GHCR_STAGING_VERIFICATION_AUDIT.md \
  --path docs/architecture/PHASE_10N_GPU_HUB_GHCR_RELEASE_AUDIT.md \
  --path docs/architecture/PHASE_10O_GPU_HUB_REAL_STAGING_E2E_AUDIT.md \
  --path docs/architecture/PHASE_10P_GPU_HUB_PRODUCTION_CUTOVER_AUDIT.md \
  --path docs/architecture/PHASE_10Q_GPU_HUB_POST_CUTOVER_INDEPENDENCE_AUDIT.md \
  --path docs/architecture/PHASE_10R_GPU_HUB_ARTIFACT_DECOUPLING_PLAN.md \
  --path docs/architecture/PHASE_10S_GPU_HUB_ARTIFACT_COMPATIBILITY_GUARDRAILS.md \
  --path docs/architecture/PHASE_10V_GPU_HUB_PRODUCTION_CUTOVER.md \
  --path LICENSE
```

(`PHASE_10F_CONTRACTS_RELEASE_READINESS_AUDIT.md` — backend, это contracts.)

### 8.6 Нельзя потерять при фильтрации (обязательные для `git log --follow`)

1. `packages/animastor-contracts/src/job-protocol-v2.js` — канон протокола.
2. `backend/ai/workflows/*.json` + `packages/animastor-installer/ai/install-manifests/**` — SHA256-базлайны связаны.
3. `packages/animastor-worker/tools/sync-protocol.cjs` + parity-гварды.
4. `packages/animastor-worker/worker/job-protocol-v2.cjs` (generated, история для archaeology).
5. `scripts/check-artifacts.sh` — часть образа hub.
6. `docs/architecture/JOB_PROTOCOL_V2.md`, `GPU_HUB_CONTRACT.md` — нормативные.
7. Root `ANDROID_WEB_PARITY.md` — история parity (canonical → web).

Cross-check после каждой фильтрации: `git log --follow` по каждому файлу
списка находит коммиты до извлечения пакетов (2026-07…08).

---

## 9. Architecture tests disposition (46 файлов backend/tests/architecture/)

Метод: для каждого файла проверены ссылки на `packages/…` (46 из 62 файлов
директории). Судьба: **KEEP** (остаётся в backend; все затронутые пакеты в
том же репо), **SPLIT** (делится между репо), **MOVE** (переезжает целиком),
**RETIRE** (transitional-проверка снимается в момент split), **PKG**
(переезжает в тесты соответствующего npm-пакета).

| # | Тест | Будущее | Cross-repo зависимость | Действие |
|---|---|---|---|---|
| 1 | ai-agent-contour-extraction-c21 | KEEP backend | нет (ai-agent+ai-analysis → backend) | — |
| 2 | ai-analyzer-boundary | KEEP backend | нет | — |
| 3 | ai-functional-decomposition-c18 | KEEP backend | нет | — |
| 4 | assistant-contour | KEEP backend | нет | — |
| 5 | assistant-package-boundary | KEEP backend | нет | — |
| 6 | auth-package-boundary | KEEP backend | нет | — |
| 7 | character-analyzer-extraction-c20 | KEEP backend | нет | — |
| 8 | comfyui-connector-core-boundary | KEEP backend | нет | — |
| 9 | dependency-guardrails | KEEP backend | нет | — |
| 10 | editor-extraction-readiness | KEEP backend | нет | — |
| 11 | editor-package-boundary | KEEP backend | нет | — |
| 12 | editor-route-split | KEEP backend | нет | — |
| 13 | generation-media-registry | KEEP backend | нет | — |
| 14 | generation-package-boundary | KEEP backend | нет | — |
| 15 | helpers.js | KEEP backend | **да**: WORKER_PKG_DIR fallback на `packages/animastor-worker` | убрать worker-fallback; worker имеет свой harness |
| 16 | installer-package-boundary | KEEP backend | **да**: negative-control на worker-пути (стр. 202) | блок про worker ретирится (после split утверждение тривиально; эквивалент живёт в hub-тестах) |
| 17 | lac-legacy-path-guard | SPLIT | **да**: guard путей worker + ai-connector | worker-часть → worker; ai-connector-часть остаётся |
| 18 | o10-layer-config-port | KEEP backend | нет | — |
| 19 | o2-persistence-port | KEEP backend | нет | — |
| 20 | o3-scene-data-port | KEEP backend | нет | — |
| 21 | o4-placeholder-audio-port | KEEP backend | нет | — |
| 22 | o5-progress-events-port | KEEP backend | нет | — |
| 23 | o7-audio-fsm-port | KEEP backend | нет | — |
| 24 | o8-video-fsm-port | KEEP backend | нет | — |
| 25 | o9-hub-cancel-port | KEEP backend | нет (пути orchestration) | — |
| 26 | parser-core-isolation | KEEP backend | нет | — |
| 27 | phase10j-gpu-hub-transitional-fixture | RETIRE | **да**: dockerfile пути compose | проверить фиксацию в момент split и удалить тест |
| 28 | phase10t-1-artifact-bakein | MOVE gpu-hub | **да**: worker+installer артефакты | переезд в hub; фикстуры — artifact contract (§2) |
| 29 | phase2-job-protocol-v2 | SPLIT | **да**: facade (backend) + bundle (worker) + hub literal | backend: только facade-assert; bundle-assert → worker (уже есть в worker-тестах, тут RETIRE); hub-assert → hub run-all (там есть, тут RETIRE) |
| 30 | phase5-runtime-result | KEEP backend | нет | — |
| 31 | phase6-editor-player | KEEP backend | нет | — |
| 32 | phase7-extraction-readiness | SPLIT | **да**: worker-пути (стр. 88-89) | остальное — KEEP; worker-assert → worker |
| 33 | phase9c-contracts | SPLIT | **да**: contracts (backend), worker-copy, compose-mount | contracts+facade — KEEP; mount-assert (стр. 321) — RETIRE после B1; worker-copy parity остаётся в worker-тестах |
| 34 | phase9d-worker-package | MOVE worker | **да**: целиком про worker package | переезд; в backend не остаётся |
| 35 | physical-move-gate | KEEP backend | нет | — |
| 36 | player-route-split | KEEP backend | нет | — |
| 37 | postgres-host-infrastructure | KEEP backend | нет | — |
| 38 | redis-ownership | KEEP backend | нет | — |
| 39 | runtime-orchestration-recon | KEEP backend | нет | — |
| 40 | s3-provider-seam | KEEP backend | нет | — |
| 41 | s4-shared-infra-moves | KEEP backend | нет | — |
| 42 | s6-generation-host-ports | KEEP backend | нет | — |
| 43 | structure-analyzer-extraction-c19 | KEEP backend | нет | — |
| 44 | url-safety-package-boundary | KEEP backend | нет | — |
| 45 | vbook-bundle-schema | KEEP backend | нет | — |
| 46 | vbook-package-boundary | KEEP backend | нет | — |

Итог: KEEP 39 (включая 15, 16 с правками), SPLIT 4, MOVE 2, RETIRE 1.

**Вне architecture/ (интеграционные, require hub-исходников напрямую —
`require('../../packages/animastor-gpu-hub/gpu-hub')`):**
`worker-share-grants`, `private-worker-phase2`, `worker-setup-api`,
`orchestration-stabilization`, `gpu-hub-bootstrap`, `gpu-hub-cleanup`,
`gpu-hub-artifacts` (7 файлов). Судьба: **cross-repo/integration suite в
backend** — переводятся с source-level на контрактный уровень (npm
`@animastor/gpu-hub` как зависимость для теста ИЛИ HTTP против поднятого
образа); source-level эквиваленты уже покрыты `packages/animastor-gpu-hub/tests/run-all.cjs`.

---

## 10. CI guards — порядок появления

| Guard | Что проверяет | Появляется на шаге | Живёт после split в |
|---|---|---|---|
| **G1** `file:`-guard | `grep '"file:' package.json` = 0 (backend, web) | Шаг 1 (B2/B3) — сразу после смены specifier'ов | backend, web |
| **G2** exports/deep-subpath | скан `require('@animastor/…/sub')` по src ⊆ `exports` каждого пакета; **сегодня все покрыты** (§1.2) — гвард фиксирует инвариант | Шаг 1 (B4) | backend (для своих 15) и web (для 13) |
| **G3** protocol drift | `node packages/animastor-worker/tools/sync-protocol.cjs --check` | **уже существует** (тест + скрипт); на шаге 1 (B6) переп point на npm-канон | worker (+ backend-гвард facade до split) |
| **G4** hub standalone build | `docker build` hub-репо без монорепо-контекста; 4 группы артефактов из artifact contract | Шаг 2 (B5) | gpu-hub |
| **G5** artifact integrity | `check-artifacts.sh` в CI после сборки образа; сверка sha256 из Release/pin-файла | Шаг 2 (B5) | gpu-hub |
| **G6** boundary tests | прогон перенесённого набора (§9) в каждом репо | Шаг 3 (B7) | все 5 |
| **G7** parity-doc sync | сверка snapshot-файлов (`ANDROID_WEB_PARITY.md` — канон в **web**; `JOB_PROTOCOL_V2.md` — канон в **backend**) с репозиторием-владельцем по commit + sha256; GitHub — зеркало (§6), не источник | Шаг 5 (вместе с hook'ами) | android, worker, gpu-hub |

Минимум до физического split: G1–G5 (G6 — сразу после переноса тестов,
до пушей в новые bare).

---

## 11. Финальная схема split

| Repo | Содержимое | npm packages | Build | Runtime deps | External | Release |
|---|---|---|---|---|---|---|
| **animastor-backend** | backend/, 15 backend-пакетов, workflow.json, MiM.vbook, deploy-скрипты, docs/ (архив+портал), infra (compose, proxy, docker/e2e) | 15 пакетов (все опубликованы); приложение не публикуется | Docker (context ./backend), npm ci | postgres, redis, hub API | npm | npm publish + Docker image |
| **animastor-web** | frontends/app, frontends/website, 13 web-пакетов, web-testers, parity (canonical) | 13 пакетов | пакет build → dist → vite build | backend /api | npm | npm publish + статика |
| **animastor-android** | frontends/android | нет | gradle APK | backend API | — | GitHub Release APK |
| **animastor-worker** | packages/animastor-worker, docker/worker | нет (zero-dep bundle; contracts devDep) | не требуется; protocol sync dev-time | hub (артефакты, задания), ComfyUI | node ≥18 | Release worker-bundle (2.1.1) + sha256 |
| **animastor-gpu-hub** | packages/animastor-gpu-hub, check-artifacts.sh, standalone overlay | @animastor/gpu-hub | Docker multi-stage; артефакты по §2 | redis | npm, GHCR | npm publish + GHCR digest-pin |

### Блокеры (B1–B12, порядок сохранён)

1. **B1** backend: contracts вне package.json → добавить `^0.1.1`, убрать mount.
2. **B2** backend: 11 `file:` → npm-версии; удалить 5 mounts; регенерация lock;
   создать недостающие 3 lock-файла.
3. **B3** web: 13 `file:` → npm; зафиксировать build-пайплайн dist→vite (B8).
4. **B4** deep-subpath: **уточнено ревизией 2 — все субпатчи уже покрыты
   `exports`**; действие — только CI-гвард G2 (верификация инварианта).
5. **B5** GPU Hub bake-in → artifact contract (§2): pin-файл, Release-артефакты
   worker/backend, G4+G5.
6. **B6** sync-protocol → npm-резолв канона, G3 в CI.
7. **B7** 46 architecture-тестов + 7 интеграционных → разъезд по §9 до split.
8. **B8** web dist build orchestration не зафиксирована → скрипт в web-репо.
9. **B9** CI отсутствует → до split минимум G1–G5.
10. **B10** post-receive монорепо `--mirror` → split-bare создаются со своими
    hooks; монорепо freeze до первого split-push.
11. **B11** nginx-portal монтирует `./docs`, `./frontends` из монорепо →
    после split деплой монтирует из backend/web выкачек.
12. **B12** untracked корневой `package.json` → удалить (после B2 в нём нет
    смысла; зависимости покрываются backend-репо).

### Пошаговый порядок будущего split

0. FF `master` до c21.4; удалить `tmp/parser-audit-backup` (по подтверждению).
1. **Размонорепизация** (B1–B4, B6, B8, B12): npm-версии, contracts в deps,
   G1/G2/G3, sync-protocol npm-резолв. Каждый шаг — отдельный коммит с тестами.
2. **Артефактная схема hub** (B5): release worker-bundle и backend-набора,
   pin-файл, stager на артефактах, G4+G5.
3. **Перенос тестов** (B7) по §9; G6.
4. **CI** (B9): workflows в монорепо-путях так, чтобы переехали без переписывания.
5. Создать **4 bare** + **4 GitHub-репо** (пустых: backend/web/android/worker);
   hooks (§7.2) **до** пушей; G7.
   **Статус 2026-10-04:** GitHub-репо **созданы владельцем** (4 × 200, `size=0`,
   0 refs, `default_branch=main`, 2026-10-03); **4 bare + hooks + remote `github`
   созданы 2026-10-04** (0 refs/0 objects, `HEAD=refs/heads/main`, hook
   **0755/91 байт byte-identical** шаблону) — **push не выполнялся**.
   **GPU Hub — НЕ создаётся** (R-3 = A: `Animastor/animastor-gpu-hub` существует).
6. Очередь: backend → web → android → worker: filter-repo клон (§8)
   → push в bare → зеркало → smoke (`npm ci && npm test`, G1–G6).
   **Шаг gpu-hub исключён из очереди навсегда — R-3 = A
   (`repository-split-r3-decision.md`); §8.5 не исполняется.**
7. Freeze монорепо; сверка tips; зеркало монорепо — архив.
8. Декомпозиция деплоя (B11): пути монтирования, CI deploy.

---

## 12. Self-check (непротиворечивость ревизии 3)

- Пакетов в `packages/`: **30** = 15 backend + 13 web + worker + gpu-hub ✓
- Опубликованных на npm: **29** (worker bundle — не npm-пакет) ✓
- `file:`-зависимостей: **24** (11 backend + 13 web); скрытых: contracts (B1),
  untracked root package.json (B12) ✓
- Названия новых репозиториев (и существующего `animastor-gpu-hub`) — едины во всех разделах ✓
- GPU Hub deps: npm {contracts ^0.1.0, express, cors, ioredis} + 4 артефакта
  (1 от worker, 3 от backend) + check-artifacts.sh ✓
- Worker: bundle 2.1.1, копия job-protocol-v2.cjs из contracts 0.1.1 (sha256
  b005fafc…), min_version манифестов 2.0.0 ✓
- §2 (contract) ↔ §8.4/8.5 (worker/hub артефакты) ↔ §6 (Releases) согласованы ✓
- §9: 46 = 39 KEEP + 4 SPLIT + 2 MOVE + 1 RETIRE; интеграционных 7 ✓
- §10: G1–G7 ↔ шаги 1/2/3/5 плана ✓
- filter-repo: все пути проверены `git ls-files`; parity-файлы: canonical web,
  snapshot android, исторический архив backend (backend-копия не редактируется,
  white-list не менялся) (§5, §8.1) ✓
- §2: pin однозначен (source repository + release tag + asset filename +
  version + sha256 asset); checksum invariant — staging-проверка до
  `COPY --from=stager`, `check-artifacts.sh` — дополнительная проверка (§2.3/§2.4) ✓
- §7.3: клон монорепо = исходная история; результат filter-repo — только в
  VPS bare; GitHub — только через post-receive hook (§7.2) ✓

## Методика проверки

Чтение фактических файлов (Dockerfile ×3, compose ×3, package.json ×30,
exports ×8 выборочно, hooks, sync-protocol, check-artifacts, 53 тестовых
файла через grep), эксперимент с npm в `/tmp`, `git ls-files` для каждого
пути white-list. Кодовые изменения не производились.
