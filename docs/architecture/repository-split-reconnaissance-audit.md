# Repository Split Reconnaissance Audit

Дата: 2026-10-01
Ветка: `c21.4-physically-extract-analysis-from-backend` (2070031d)
Статус: разведка, ничего не изменено (все операции read-only)

## Цель

Подготовка локального VPS-репозитория Animastor к разделению на пять
независимых GitHub/Git-репозиториев. GitHub является зеркалом локального Git
на VPS; источник истины — VPS. Предварительная целевая схема (не утверждена
окончательно):

1. `animastor-backend`
2. `animastor-web`
3. `animastor-android`
4. `animastor-worker`
5. `animastor-gpu-hub`

---

## Этап 1. Git-разведка

### Remotes и зеркалирование

| Remote | URL | Роль |
|---|---|---|
| `origin` | `/home/animastor/repos/animastor.git` | локальный bare-репозиторий на VPS — источник истины |
| `github` | `git@github.com:Animastor/animastor.git` | зеркало на GitHub |

Схема зеркалирования: `post-receive` hook в bare-репозитории выполняет
`git push --mirror github`. GitHub-репозиторий полностью повторяет VPS.

Проверка связности GitHub из этой сессии: SSH-доступ с текущего окружения
не работает (`ls-remote github` — отказ), что не влияет на локальный аудит.

### Ветки

| Ветка | Tip | Отношение к master |
|---|---|---|
| `master` | `8118f766` | базовая |
| `c21.4-physically-extract-analysis-from-backend` | `2070031d` | +133 коммита, master — строгий предок (fast-forward возможен) |
| `tmp/parser-audit-backup` | `db5ff61f` | +23 коммита, но полностью содержится в c21.4 |

Локальные ветки, bare-репо и `github`-зеркало синхронны (tips совпадают).
Расхождений (divergence) между ветками нет; merge-коммитов в истории нет —
история линейная.

### Незакоммиченные изменения

Нет. Единственное — untracked корневой `package.json`
(зависимость `animastor-ai-connector`), созданный вне git.

### Уникальные коммиты

- **c21.4** (133 коммита поверх master): 652 файла,
  +104 711 / −9 121. Состав по типам: 49 arch, 23 docs, 17 refactor,
  13 fix, 10 chore, 10 audit, 5 test, 2 feat, 1 npm, 1 cleanup —
  extraction-пакеты, аудиты, подготовка npm-публикации.
- **tmp/parser-audit-backup**: уникальных коммитов **нет**
  (полностью поглощён веткой c21.4).

---

## Этап 2. Оценка объединения веток

- **c21.4 → master**: безопасно. `git merge --ff-only` — конфликтов
  не будет (линейная история, master не двигался).
- **tmp/parser-audit-backup**: информации не добавляет; после отдельного
  подтверждения может быть удалена (не удалялась).
- Слепой merge не требуется: единственная содержательная ветка — c21.4.

Требуют решения:
1. Момент переключения активной разработки на `master`
   (сейчас работа идёт в c21.4).
2. Удаление `tmp/parser-audit-backup` (безвредно, но не выполнялось).
3. Судьба untracked корневого `package.json` (закоммитить / игнорировать).

---

## Этап 3. Карта границ будущих репозиториев

### animastor-backend

- `backend/` — приложение (`animastor-backend`), 421 файл в git
  (включая `backend/ai/` — workflows, connectors, profiles и т.д.).
- npm-пакеты: `@animastor/ai-agent`, `@animastor/ai-analysis`,
  `@animastor/assistant`, `@animastor/auth`, `@animastor/contracts`,
  `@animastor/editor`, `@animastor/generation`, `@animastor/installer`,
  `@animastor/orchestration`, `@animastor/parser`, `@animastor/player`,
  `@animastor/url-safety`, `@animastor/vbook-runtime`,
  `animastor-ai-connector`, `animastor-comfyui-workflow-connector`.

### animastor-web

- `frontends/app/` — web-приложение (Vite, `animastor-app`).
- `frontends/website/` — статический сайт (без package.json).
- npm-пакеты: `@animastor/web-ai-chat`, `@animastor/web-book-session`,
  `@animastor/web-editor`, `@animastor/web-file`,
  `@animastor/web-generator`, `@animastor/web-generator-config`,
  `@animastor/web-generator-sse`, `@animastor/web-generator-vbook`,
  `@animastor/web-local-ai`, `@animastor/web-navigator`,
  `@animastor/web-player`, `@animastor/web-settings`,
  `@animastor/web-workers`.

### animastor-android

- `frontends/android/` — 213 файлов в git.

### animastor-worker

- `packages/animastor-worker/` — bundle `worker/` (единственный
  поставляемый артефакт: `worker.cjs`, `worker-env.cjs`,
  `worker-cleanup*.cjs`, `job-protocol-v2.cjs`), `tests/`, `tools/`
  (в т.ч. `sync-protocol.cjs`), bootstrap-скрипты. Не имеет
  `package.json` на уровне корня пакета — bundle-version в
  `worker/package.json` (2.1.0), zero npm-зависимостей.
- `docker/worker/` — Dockerfile + entrypoint.

### animastor-gpu-hub

- `packages/animastor-gpu-hub/` — `server.js`, `gpu-hub.js`,
  `tarball.js`, `bootstrap.js`, `Dockerfile`, `tests/`,
  пакет `@animastor/gpu-hub`.

### Общие файлы (shared)

- `docker-compose.yml`, `docker/compose/` (в т.ч.
  `overlay-gpu-hub-local.yml`, `overlay-gpu-hub-standalone.yml`),
  `docker/e2e/`.
- `proxy/` — nginx-прокси.
- `scripts/` (7 файлов, в т.ч. `check-artifacts.sh` — нужен GPU Hub).
- `tools/desktop-web-tester`, `tools/mobile-web-tester`.
- `docs/` — 282 файла; `ARCHITECTURE.md`, `MEMORY.md`,
  `ANDROID_WEB_PARITY.md`, `CONTRIBUTING.md`, `SECURITY.md`,
  `THIRD_PARTY_NOTICES.md`.
- Корневые build-скрипты: `apk-build.sh`, `build-apk.sh`,
  `app-web-rebuild.sh`, `backend-rebuild.sh`, `front-backend-rebuild.sh`,
  `gpu-hub-rebuild.sh`, `src-backup.sh`.
- CI/CD: `.github/` отсутствует — pipelines нет.

---

## Этап 4. Аудит npm-пакетов

29 пакетов в `packages/`; все, кроме `animastor-backend` (это приложение,
не пакет), **уже опубликованы на npm** в актуальных версиях.

| Пакет | Версия | Опубликован |
|---|---|---|
| `@animastor/ai-agent` | 0.1.0 | да |
| `@animastor/ai-analysis` | 0.1.0 | да |
| `animastor-ai-connector` | 0.1.0 | да |
| `@animastor/assistant` | 0.1.0 | да |
| `@animastor/auth` | 0.1.0 | да |
| `animastor-comfyui-workflow-connector` | 0.1.0 | да |
| `@animastor/contracts` | 0.1.1 | да |
| `@animastor/editor` | 0.1.1 | да |
| `@animastor/generation` | 0.1.1 | да |
| `@animastor/gpu-hub` | 0.1.1 | да |
| `@animastor/installer` | 0.1.0 | да |
| `@animastor/orchestration` | 0.1.1 | да |
| `@animastor/parser` | 0.1.1 | да |
| `@animastor/player` | 0.1.0 | да |
| `@animastor/url-safety` | 0.1.0 | да |
| `@animastor/vbook-runtime` | 0.2.0 | да |
| `@animastor/web-ai-chat` | 0.1.0 | да |
| `@animastor/web-book-session` | 0.1.0 | да |
| `@animastor/web-editor` | 0.1.0 | да |
| `@animastor/web-file` | 0.1.0 | да |
| `@animastor/web-generator` | 0.1.0 | да |
| `@animastor/web-generator-config` | 0.1.0 | да |
| `@animastor/web-generator-sse` | 0.1.0 | да |
| `@animastor/web-generator-vbook` | 0.1.0 | да |
| `@animastor/web-local-ai` | 0.1.0 | да |
| `@animastor/web-navigator` | 0.1.0 | да |
| `@animastor/web-player` | 0.1.0 | да |
| `@animastor/web-settings` | 0.1.0 | да |
| `@animastor/web-workers` | 0.1.0 | да |
| `animastor-backend` | — | не публикуется (приложение) |

Принцип сохраняется: один логический application-репозиторий может
содержать несколько независимо публикуемых npm-пакетов. Никаких
переносов пакетов между git-репозиториями на этом этапе не выполняется.

### Зависимости между пакетами

- `@animastor/generation` → `animastor-comfyui-workflow-connector`
  (npm-версия).
- `@animastor/generation`, `@animastor/gpu-hub`,
  `@animastor/orchestration` → `@animastor/contracts` (npm-версия).
- `backend` → 12 пакетов через `file:../packages/...`.
- `frontends/app` → 13 web-пакетов через `file:../../packages/...`.

---

## Этап 5. История и способ разделения

- История линейная (без merge-коммитов) — переписывать основной
  репозиторий не требуется.
- Рекомендуемый механизм: клоны с `git filter-repo` по путям
  (например `backend/ packages/animastor-parser/ ...`) с сохранением
  истории файлов; destructive rewrite основного репо не выполняется.
- Каждому из пяти репозиториев история нужна (единый проект с общими
  корнями); фильтрация по путям даёт её без риска для master.

---

## Этап 6. GitHub

GitHub не изменялся. Рекомендация после завершения разведки и merge:

```
VPS source repository (bare)
        ↓ split (filter-repo, клоны)
5 отдельных репозиториев
        ↓ push
GitHub Organization "Animastor" (5 зеркал)
```

Важно: текущий `post-receive` hook делает `git push --mirror github` —
после появления отдельных репозиториев hook нужно перестроить на
пуш в 5 зеркал (mirror-mode затирает всё, кроме полного отражения).

---

## Cross-repository зависимости (сводка)

1. **Worker ← Contracts**: `job-protocol-v2.cjs` генерируется из
   `@animastor/contracts` (`tools/sync-protocol.cjs`) — жёсткая связь
   worker ↔ backend-репозиторий.
2. **GPU Hub ← Worker + backend + installer**: Dockerfile GPU Hub имеет
   build context = корень монорепо и копирует
   `packages/animastor-worker/worker/`, `backend/ai/workflows/`,
   `packages/animastor-installer/`, `scripts/check-artifacts.sh`.
   Физически невозможно собрать GPU Hub из одного будущего репозитория
   без изменения схемы поставки.
3. **backend ↔ packages** (12 `file:`-зависимостей),
   **web-app ↔ web-packages** (13 `file:`-зависимостей) — после split
   переход на npm-версии.
4. **Android ↔ web**: parity-документ (`ANDROID_WEB_PARITY.md`),
   общий визуальный/функциональный контракт с `frontends/app`.
5. `data/` — 0 файлов в git (не влияет на split).

## Потенциальные проблемы при split

1. Docker-сборки (GPU Hub, compose-сервисы) строятся от корня монорепо —
   после split потребуется multi-repo checkout или артефактный реестр.
2. `file:`-зависимости придётся заменить на npm-версии.
3. Принадлежность shared-файлов (compose, docs, scripts, proxy)
   требует решения по каждому файлу/директории.
4. `docs/` (282 файла) — распределение по репозиториям или выделение
   отдельного docs-репозитория.
5. `post-receive` mirror-hook затрёт независимые репозитории —
   обязательная перестройка зеркалирования до создания новых репо.
6. В репозитории нет CI — первый кандидат на добавление после split
   (lint/test на каждый пакет).

## Рекомендуемые следующие шаги

1. Fast-forward `master` до c21.4 и переключение разработки на master.
2. Подтверждение удаления `tmp/parser-audit-backup` и решение по
   untracked корневому `package.json`.
3. Подготовка (не выполнение) плана `git filter-repo` для пяти
   репозиториев с сохранением истории.
4. Финальная таблица владельцев shared-файлов.
5. Только затем — создание 5 репозиториев в GitHub Org `Animastor`
   и перестройка зеркалирования.
