# POST-SPLIT AUDIT — все 4 репозитория (read-only)

> **ТОЛЬКО АУДИТ. Изменений не вносилось:** без commit, без push/force-push,
> без смены refs/GitHub, без изменения GPU Hub. Дата: 2026-10-04.
> Проверялись **фактические** GitHub HEAD и рабочие bare (локальные bare +
> GitHub API/`ls-remote`). Данный файл **не коммитится**.
>
> **Зафиксированные split-SHA (проверка J):** backend `f83f929c…`, web
> `4c3ea0fb…`, android `efa4b293…`, worker `73671b6b…`, GPU Hub `7c7778c6…`,
> monorepo `master = 64127b9e…` — **не изменены**.

## 0. Сводка

| Repo | HEAD | files | top-level | fsck | tree | default branch |
|---|---|---|---|---|---|---|
| animastor-backend | `f83f929c732d8fc490bd150e72294d6b3c6e2f92` | 1045 | `ARCHITECTURE.md backend backend-rebuild.sh CONTRIBUTING.md docker docker-compose.yml .dockerignore docs .env.example front-backend-rebuild.sh .gitignore LICENSE MEMORY.md MiM.vbook packages proxy README.md scripts SECURITY.md src-backup.sh THIRD_PARTY_NOTICES.md` | clean | clean | `main` |
| animastor-web | `4c3ea0fb2a1adb552ba1c9acd98abc41befdab3b` | 349 | `ANDROID_WEB_PARITY.md app-web-rebuild.sh docs frontends LICENSE packages tools` | clean | clean | `main` |
| animastor-android | `efa4b2937bc1954900c0e5aa9501667f42d6a70d` | 217 | `ANDROID_WEB_PARITY.md apk-build.sh build-apk.sh frontends LICENSE` | clean | clean | `main` |
| animastor-worker | `73671b6b4e2986bd33c88c0ef165cb39a67e875d` | 58 | `docker docs LICENSE packages` | clean | clean | `main` |
| animastor-gpu-hub | `7c7778c6f313dad19eb403d8509cd297226ec7ea` | — | (не трогался) | — | — | `master` |

**Итог:** **P0 = 0 · P1 = 4 · P2 = 21 · P3 = 5.** Монорепо-артефакты (`workflow.json`,
`local.properties`, `frontends/app` в backend, чужие компоненты) — **не просочились
ни в один repo**. Лицензия MIT одинакова во всех 4. Нет блокеров корректности (P0).

## A. Общая структура

- **Лишних monorepo-директорий нет:** backend не содержит `frontends/`, `tools/`,
  `packages/animastor-{worker,gpu-hub,web-*}`; web — не содержит
  `backend/ docker/ proxy/ scripts/ frontends/android/`; android — только
  `frontends/android`; worker — только worker-подмножество. `workflow.json` —
  **0** во всех 4. `local.properties` — **0**.
- **README (root):** есть только у **backend**. У **web / android / worker
  корневого README НЕТ** → GitHub landing показывает «пустой» первый экран.
- **LICENSE:** есть во всех 4.
- **.gitignore (root):** есть только у **backend**. web / android / worker —
  **отсутствует** (документированный gap §5.2–§5.4; артефакты сборки станут
  untracked).
- **package.json / lock:** backend 16/16, web 14/14, worker 3/3, android — 0
  (Gradle). Корневого `package.json` нет ни в одном repo (по дизайну).
- **docs/:** backend `docs/` (126 файлов в `docs/architecture/`), web
  `docs/{05-frontend,08-mobile-web-migration,09-desktop-migration,architecture}`,
  worker `docs/architecture/` (16), android — **нет `docs/`** (по whitelist).

## B. README audit

### backend/README.md
| LINK | STATUS | CORRECT TARGET |
|---|---|---|
| `frontends/app/public/logo.png` (line 2) | **BROKEN** — файла нет в backend-репо (и нет ни одной картинки) | `https://raw.githubusercontent.com/Animastor/animastor-web/main/frontends/app/public/logo.png` (или добавить свой logo) |
| `https://github.com/Animastor/animastor.git` (line 95) | **STALE** — старый monorepo URL | `https://github.com/Animastor/animastor-backend.git` |
| `cd animastor` (line 96) | **STALE** | `cd animastor-backend` |
| `[build-apk.sh](build-apk.sh)` (line 119) | **BROKEN** — файла нет в backend (он в android) | `https://github.com/Animastor/animastor-android/blob/main/build-apk.sh` (либо удалить раздел) |
| Project Structure (lines 145–158) | **STALE** — описывает монорепо (`frontends/`, `gpu-hub/`, `worker/`, `proxy/`, `scripts/`) | описать фактическую структуру backend-репо |
| Architecture at a Glance (72–80) | **STALE** — `frontends/app`, `frontends/android`, `gpu-hub`, `worker`, `proxy` вынесены в отдельные repo | пометить как внешние repo (`Animastor/animastor-*`) |
| `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `THIRD_PARTY_NOTICES.md`, `docs/**` links | OK | — |
| badges (LICENSE, docker, platform) | OK | — |

### web / android / worker
- **Root README отсутствует** → нечего рендерить на GitHub landing.
- Внутренние README (web/packages/*, worker/packages/animastor-worker, docs/*)
  существуют; ссылок-картинок в md нет.

## C. LOGO / IMAGES / BADGES

- **backend:** изображений **нет вообще** (0 png/svg/jpg), а README ссылается на
  `frontends/app/public/logo.png` → **битая картинка на GitHub landing**
  (известная проблема). Причина: **relative path остался от монорепо; файл
  отсутствует в backend-репо** (сам файл `logo.png` живёт только в
  `animastor-web/frontends/app/public/`).
- **web:** `frontends/app/public/{logo.png, favicon-16/32.png, apple-touch-icon.png,
  theater_curtains.png}`, `frontends/website/{logo.png, favicon…}` — присутствуют;
  в markdown не используются.
- **android:** `theater_curtains.png`, `mipmap-*/ic_launcher*.png` — присутствуют.
- **worker:** изображений нет.
- Бейджи: только в backend README (shields.io, внешние) — работают.

## D. LICENSE audit

- Во всех 4 repo — **`LICENSE` = идентичный текст MIT**, sha256
  `00e2346da29cb6fa751fced20436298774f4668cf3f5a16750af6c4f8ad19cc1`, `MIT License` /
  `Copyright (c) 2026 Animastor`.
- GitHub API `license.spdx_id` = **MIT** у всех 4 (+ gpu-hub).
- `package.json license`: все **MIT**, кроме:
  - `worker/packages/animastor-worker/image/worker/package.json` → **`ISC`** — P3 (вероятно, сторонний Docker-манифест; зафиксировать).
  - без поля `license`: `backend/backend/package.json`, `web/frontends/app/package.json` — P3.
- README license-ссылка: только backend (`LICENSE`, MIT) — OK.

## E. PACKAGE METADATA

- **`repository.url` указывает на старый monorepo** `git+https://github.com/Animastor/animastor.git`
  (+ `repository.directory: packages/…`):
  - **backend — 15** package.json;
  - **web — 13** package.json;
  - **worker — 1** (`packages/animastor-worker/worker/package.json`);
  - **android — 0** (нет package.json).
  Это документированный **X-3** (`repository-split-next-blockers.md` §839) —
  **post-split метаданные, до первого `npm publish`**. P2.
- `name`/`version`/`description`/`bugs`/`homepage` — не проверялись построчно
  (вне объёма безопасной проверки); `license` см. §D.

## F. DOCUMENTATION / ARCHITECTURE

- **backend `docs/architecture/` (126 файлов):** бо́льшая часть — **историческая
  audit/extraction документация** (PHASE_*, repository-split-*, *-extraction-*):
  **НЕ переписывать**. `78` файлов содержат упоминания monorepo-layout
  (`frontends/*`, `gpu-hub/`, `packages/animastor-gpu-hub`, `tools/desktop-web-tester`)
  — для **исторических** документов это норма.
- **worker `docs/architecture/` (16):** `JOB_PROTOCOL_V2.md`, `LINUX_INSTALLER_RECONNAISSANCE.md`
  — **актуальны**; `PHASE_9*`, `EXPERIMENTAL_BETA_*`, `WORKER_PACKAGE_RELOCATION_*` —
  **исторические**, не трогать.
- **web `docs/`:** `architecture/web-*` — исторические audit'ы (pre-split names);
  `05-frontend/08/09` — пользовательские доки.
- **android:** документов нет.
- Явно устаревших «живых» (не-historical) структурных доков, кроме README §B,
  не обнаружено.

## G. CROSS-REPOSITORY LINKS

| Из | Ссылка | Статус | Correct target |
|---|---|---|---|
| backend README | `Animastor/animastor.git` | STALE | `Animastor/animastor-backend` |
| backend packages (15) | `github.com/Animastor/animastor.git` | STALE | соответственный `Animastor/animastor-backend` (+ `directory` без `packages/…`) |
| backend README (structure) | `frontends/*`, `gpu-hub/`, `worker/`, `proxy/` | STALE (внешние repo) | `Animastor/animastor-{web,android,gpu-hub,worker}` |
| web packages (13) | `github.com/Animastor/animastor.git` | STALE | `Animastor/animastor-web` |
| web site `frontends/website/index.html` ×2 | `https://github.com/Animastor/animastor` | STALE | `https://github.com/Animastor/animastor-web` |
| worker package (1) | `github.com/Animastor/animastor.git` | STALE | `Animastor/animastor-worker` |
| android | — | OK (ссылок нет) | — |
| gpu-hub | `Animastor/animastor-gpu-hub` (в backend docs) | OK | — |

## H. GITHUB PRESENTATION

| Repo | README рендер | logo/images | Описание repo | Итог |
|---|---|---|---|---|
| backend | есть, но **битый logo** (relative `frontends/…`) | бито | **нет** | P1 (logo) |
| web | **нет root README** | нет в README | **нет** | P1 (README) |
| android | **нет root README** | нет | **нет** | P1 (README) |
| worker | **нет root README** | нет | **нет** | P1 (README) |
| gpu-hub | не трогаем | — | **нет** | — |

- У всех 4: `description = null`, `homepage = null` в GitHub API → P3.
- web/android/worker API `size=0` (лаг GitHub; `contents/` показывает файлы) — не дефект.

## I. TECHNICAL SANITY

- `git fsck` во всех 4 — **clean**; `git status --porcelain` — **0 строк** (clean).
- Проверки существования относительных ссылок backend README — 2 MISS (см. §B).
- **NOT RUN (не запускалось):** `npm ci` / `npm test` / сборки / `typecheck` /
  G1–G5 guards / smoke (§4.1.x «Smoke checks») — вне объёма/стоимости этой
  read-only проверки. GPU-generation jobs не запускались. **PASS не присваивается.**

## K. Таблица находок

| REPO | AREA | STATUS | FINDING | FILE | REQUIRED ACTION |
|---|---|---|---|---|---|
| backend | logo/images | P1 | Битая картинка: relative `frontends/app/public/logo.png`, файла в repo нет | `README.md:2` | absolute URL на web-репо или свой logo |
| web | README | P1 | Нет корневого README → пустой GitHub landing | `README.md` (missing) | добавить README |
| android | README | P1 | Нет корневого README | `README.md` (missing) | добавить README |
| worker | README | P1 | Нет корневого README | `README.md` (missing) | добавить README |
| backend | README/links | P2 | Clone URL = monorepo | `README.md:95` | `animastor-backend` + `cd animastor-backend` |
| backend | README/links | P2 | `build-apk.sh` отсутствует в repo | `README.md:119` | ссылка на android-репо / убрать |
| backend | README/structure | P2 | Project Structure и Architecture-таблица описывают монорепо | `README.md:70-80,142-158` | обновить под backend |
| backend | package metadata | P2 | `repository.url` = monorepo | 15 × `packages/*/package.json` | обновить (X-3, до publish) |
| backend | README(pkg) | P2 | Clone URL = monorepo | `packages/animastor-comfyui-workflow-connector/README.md:288` | обновить |
| web | cross-repo links | P2 | Ссылки на `Animastor/animastor` | `frontends/website/index.html:139,172` | на `animastor-web` |
| web | package metadata | P2 | `repository.url` = monorepo | 13 × `packages/animastor-web-*/package.json` | обновить (X-3) |
| worker | package metadata | P2 | `repository.url` = monorepo | `packages/animastor-worker/worker/package.json:25` | обновить (X-3) |
| backend | .gitignore | P2 | Нет корневого `.gitignore` в web/android/worker | (missing) | добавить (§5.2–5.4) |
| backend | docs | P2/hist | 78 `docs/architecture/*` содержат monorepo-layout | `docs/architecture/**` | **не менять** (исторические) |
| worker | LICENSE | P3 | `image/worker/package.json` license = `ISC` | `.../image/worker/package.json` | подтвердить/зафиксировать |
| backend | metadata | P3 | Нет `license` в `backend/package.json` | `backend/package.json` | добавить `MIT` |
| web | metadata | P3 | Нет `license` в `frontends/app/package.json` | `frontends/app/package.json` | добавить `MIT` |
| all | GitHub presentation | P3 | `description`/`homepage` пусты | GitHub settings | заполнить |

### Приоритеты
- **P0 (блокирует корректность): 0**
- **P1 (обязательно исправить): 4** — битый logo backend; отсутствие root README ×3.
- **P2 (документация/UX): 21** — 29 `repository.url` (+2 README clone-URL) на
  старый monorepo; stale структура/ссылки в backend README; 2 ссылки на сайте web;
  отсутствие root `.gitignore` ×3 (по repo: backend 1 P2, web 2 P2+site, worker 1 P2).
- **P3 (косметика): 5** — ISC-манифест, отсутствие `license` ×2, пустые
  `description`/`homepage`.

## Файлы к исправлению по repo (без изменений в рамках этого задания)

- **backend:** `README.md`; `packages/animastor-comfyui-workflow-connector/README.md`;
  `packages/*/package.json` (15: ai-agent, ai-analysis, ai-connector, assistant, auth,
  comfyui-workflow-connector, contracts, editor, generation, installer, orchestration,
  parser, player, url-safety, vbook-runtime); `backend/package.json` (license);
  добавить root `.gitignore` (если требуется).
- **web:** `README.md` (создать); `frontends/website/index.html`;
  `packages/animastor-web-*/package.json` (13); `frontends/app/package.json` (license);
  root `.gitignore`.
- **android:** `README.md` (создать); root `.gitignore` (опционально).
- **worker:** `README.md` (создать);
  `packages/animastor-worker/worker/package.json`; `.../image/worker/package.json`
  (license); root `.gitignore`.

> **GPU Hub (`Animastor/animastor-gpu-hub`, `7c7778c6…`): НЕ изменялся** — только
> проверено состояние (§0, §D, §H).
