# Repository Split Execution Readiness

Дата: 2026-10-01
HEAD: `709f112e` (rev 3.2 preparation plan)
Статус: разведка исполнимости §7–§11 preparation plan. Физический split,
`git filter-repo`, новые репозитории и изменения GitHub/VPS НЕ выполнялись.

База: `docs/architecture/repository-split-preparation-plan.md` (rev 3.2),
`repository-split-reconnaissance-audit.md`, Phase 10R/10S (artifact
decoupling), Phase 9C/9D (contracts/worker).

---

## Executive result

**READY с 6 условиями (Pre-conditions, P1–P6)** — все они административные/
инфраструктурные, ни одно не требует изменения кода или архитектуры. Блокеров,
требующих переделки плана, не обнаружено. Детали — §9 (Blockers & pre-conditions).
Итоговый вердикт — в конце документа.

---

## 1. Подтверждённые факты окружения (проверено на VPS)

| Факт | Значение | Влияние на split |
|---|---|---|
| `git-filter-repo` | v2.47.0, `/home/animastor/.local/bin/` (pip) | доступен ✓ |
| git / python | 2.34.1 / 3.10.12 | достаточно ✓ |
| История | 1632 коммита; bare и working copy идентичны | фильтрация по полному клону ✓ |
| Bare ↔ mirror | post-receive `git push --mirror github`; SSH-ключ `github_ed25519` | схема §7.2 воспроизводима для новых bare ✓ |
| Размер | pack 55.7 MiB; диск 3.5 GB свободно | 5 клонов + рабочих деревьев достаточно, но впритык — P6 |
| node_modules в git | 0 tracked файлов; dist/ не tracked | клон чист, фильтрации мешает только размер рабочего дерева |
| Симлинки | только 3 в `node_modules` (untracked) + untracked внутри пакетов | в историю не попадают; физически не переносятся ✓ |
| Секреты | `.env`, `proxy/conf/.htpasswd` — untracked/ignored; `LETS_ENCRYPT_DIR` — вне репо | в split-историю не попадут ✓ |
| npm | registry npmjs; в `~/.npmrc` есть authToken, но **недействителен** (E401) | см. P3 |
| GitHub org | Animastor существует; репозитории не созданы | P1 |
| Untracked root | `package.json` (реальный файл), `workflow.json` (пустой каталог!), `local.properties` | см. P4, §3.1 |
| CI в монорепо | отсутствует (`.github/` нет) | CI создаётся с нуля в split-репо — P5 |
| Ветка | work идёт в `c21.4-…` (709f112e), `master` отстаёт (8118f766) | см. P2 |

## 2. Path matrix: SOURCE PATH → TARGET REPO → ACTION

ACTION-словарь: **KEEP** — переносится историей (filter-repo white-list);
**MOVE** — подмножество KEEP, уходит из backend в другой репо (владелец меняется);
**COPY** — создаётся заново у другого владельца по snapshot-механизму §5
(история не переносится); **ARCHIVE** — копия-заморозка, владелец не редактирует;
**RETIRE** — удаляется в момент split; **GENERATED** — восстанавливается
инструментом/npm, не переносится историей.

### 2.1 animastor-backend (37 путей, KEEP)

| Source path | ACTION | Примечание |
|---|---|---|
| `backend/` | KEEP | приложение + `backend/ai/workflows/` (hub-workflows артефакт) |
| `packages/animastor-{ai-agent, ai-analysis, ai-connector, assistant, auth, comfyui-workflow-connector, contracts, editor, generation, installer, orchestration, parser, player, url-safety, vbook-runtime}` (15) | KEEP | все опубликованы; contracts = канон протокола |
| `docker/` | KEEP+ARCHIVE | compose-overlays целиком; `docker/worker/` — ARCHIVE (владелец worker), `overlay-gpu-hub-standalone.yml` — ARCHIVE (владелец hub) |
| `docker-compose.yml` | KEEP | infra, монтирует пути web/hub после split (B11) |
| `proxy/` | KEEP | nginx; `proxy/conf/.htpasswd` не tracked — пересоздать на VPS (P-деплой) |
| `scripts/` | KEEP | общий; `check-artifacts.sh` дублируется в hub (см. 2.5) |
| `docs/` | KEEP+ARCHIVE | целиком, 284 файла; parity-копия — заморозка |
| `workflow.json` | KEEP (путь) | **untracked** — см. P4 |
| `MiM.vbook` | KEEP | VBook-фикстура |
| `backend-rebuild.sh`, `front-backend-rebuild.sh`, `src-backup.sh` | KEEP | деплой backend |
| root `README.md`, `ARCHITECTURE.md`, `MEMORY.md`, `CONTRIBUTING.md`, `SECURITY.md`, `THIRD_PARTY_NOTICES.md`, `LICENSE`, `.env.example`, `.dockerignore`, `.gitignore` | KEEP | — |

### 2.2 animastor-web (31 путь, KEEP)

| Source path | ACTION | Примечание |
|---|---|---|
| `frontends/app/`, `frontends/website/` | KEEP | сайт — 9 файлов, downloads/ включены |
| `packages/animastor-web-*` (13) | KEEP | все опубликованы; dist/ GENERATED (npm publish из собранного dist) |
| `tools/desktop-web-tester/`, `tools/mobile-web-tester/` | KEEP | gradle-харнессы web |
| `app-web-rebuild.sh` | KEEP | — |
| root `ANDROID_WEB_PARITY.md` | KEEP (canonical) | владелец — web (§5) |
| `docs/05-frontend`, `docs/08-mobile-web-migration`, `docs/09-desktop-migration`, 7 × `docs/architecture/web-*.md` | COPY | история переносится filter-repo; владельцем становится web; в backend остаётся ARCHIVE-копия |
| `docs/architecture/ANDROID_WEB_PARITY.md` (старый снимок) | COPY(ARCHIVE) | исторический снимок, не редактируется |
| `LICENSE` | KEEP | — |

### 2.3 animastor-android (6 путей, KEEP)

| Source path | ACTION | Примечание |
|---|---|---|
| `frontends/android/` | KEEP | 213 файлов; `build/` не tracked; `gradle.properties` tracked; root `local.properties` untracked — см. P4 |
| `apk-build.sh`, `build-apk.sh` | KEEP | — |
| root `ANDROID_WEB_PARITY.md` | COPY | snapshot-механизм §5: CI android получает файл из web-репо, проверяет commit+sha256; история parity НЕ переносится |
| `LICENSE` | KEEP | — |

### 2.4 animastor-worker (19 путей, KEEP)

| Source path | ACTION | Примечание |
|---|---|---|
| `packages/animastor-worker/` | KEEP | вкл. `worker/` (bundle 2.1.1, `job-protocol-v2.cjs` GENERATED-копия — переносится историей, но регенерируется), `tests/`, `tools/sync-protocol.cjs`, `new/` (историческая площадка, KEEP-как-архив), `image/worker/` (lock-файлы для докер-образа) |
| `docker/worker/` | KEEP | Dockerfile + entrypoint; entrypoint скачивает installer **из hub** по HTTP — прямой зависимости от backend-файлов нет |
| 16 × `docs/architecture/*.md` (PHASE_9*, WORKER_*, EXPERIMENTAL_BETA_PRIVATE_*, LINUX_INSTALLER_*) | COPY | владелец — worker; в backend остаётся ARCHIVE |
| `docs/architecture/JOB_PROTOCOL_V2.md` | COPY(snapshot) | канон — backend; worker получает snapshot по §5-механизму |
| `LICENSE` | KEEP | — |

### 2.5 animastor-gpu-hub (27 путей, KEEP)

| Source path | ACTION | Примечание |
|---|---|---|
| `packages/animastor-gpu-hub/` | KEEP | код + Dockerfile + `.dockerignore` + tests/run-all (17 route/surface-гвардов) |
| `scripts/check-artifacts.sh` | MOVE | физически уходит в hub; в backend-scripts остаётся только если compose/e2e его вызывают — перед split проверить (`grep -rn check-artifacts scripts/ docker/`) |
| `gpu-hub-rebuild.sh` | KEEP | единственный rebuild-скрипт hub |
| `docker/compose/overlay-gpu-hub-standalone.yml` | MOVE | local-overlay остаётся в backend (infra) |
| 19 × `docs/architecture/PHASE_10*GPU_HUB*` + `GPU_HUB_CONTRACT.md` | COPY | владелец — hub; в backend ARCHIVE |
| `docs/architecture/JOB_PROTOCOL_V2.md` | COPY(snapshot) | канон — backend |
| `LICENSE` | KEEP | — |

### 2.6 RETIRE (в момент split, не переносятся)

| Source path | Причина |
|---|---|
| `backend/tests/architecture/phase10j-gpu-hub-transitional-fixture.test.js` | transitional-гвард compose-путей; снимается при split (§9 preparation plan, №27) |
| mount-assert в `phase9c-contracts.test.js` (стр. 321) | после B1 mount удаляется |
| bundle/hub-asserts в `phase2-job-protocol-v2.test.js` | дублируются в worker/hub-тестах |
| worker-fallback в `backend/tests/architecture/helpers.js` (WORKER_PKG_DIR) | после split пути не существуют |
| корневой untracked `package.json` | B12: зависимости покрываются backend; в split-историю не попадает (untracked) |

## 3. Dependency matrix после split

### 3.1 Незаметные по директории пути, попадающие в репо по зависимостям

| Target repo | Путь (по зависимости) | Почему |
|---|---|---|
| backend | `packages/animastor-contracts/` | канон Job Protocol; job-schema facade требует его (B1) |
| backend | `packages/animastor-installer/ai/install-manifests/` | связаны SHA256-базлайнами с `backend/ai/workflows/` (§8.6 prep-plan) |
| backend | `scripts/check-artifacts.sh` | до MOVE — общий; после split копия живёт в hub |
| worker | `tools/sync-protocol.cjs` + parity-гварды | регенерация `job-protocol-v2.cjs`; npm-резолв contracts (B6) |
| worker | `image/worker/{package.json,package-lock.json}` | version-фикстура docker-образа worker |
| hub | `scripts/check-artifacts.sh` | COPY в образ (`/app/scripts/`) |
| hub | npm `@animastor/contracts` | `PROTOCOL_VERSION` (runtime) |
| web | `ANDROID_WEB_PARITY.md` (root) | canonical parity |
| android | `ANDROID_WEB_PARITY.md` (root) | snapshot из web |
| backend | `workflow.json` (untracked!) | монтируется в backend-контейнер; после split его некому «перенести» — P4 |

### 3.2 Исчезающие `file:`-зависимости и замены

| Было (24) | Станет |
|---|---|
| backend × 11 `file:../packages/…` | `^0.1.x` npm-версии тех же пакетов (все опубликованы; локальные версии = npm) |
| web × 13 `file:../../packages/…` | `^0.1.0` npm |
| скрытая: backend ↔ contracts (симлинк + mount) | `"@animastor/contracts": "^0.1.1"` в dependencies (B1) + удаление 5 mounts |
| untracked root `package.json` (`animastor-ai-connector`) | RETIRE — не переносится |

Гвард G1 (grep `"file:` = 0) в backend/web CI. Скрытых относительных импортов
между доменами нет (проверено); deep-subpath импорты покрыты `exports`.

### 3.3 Где после split нужны npm/published-пакеты

| Потребитель | Пакеты | Механизм |
|---|---|---|
| backend app | 12 `@animastor/*` + 2 connector'а | npm (B1/B2) |
| web app | 13 `@animastor/web-*` | npm (B3) |
| hub | `@animastor/contracts` (runtime), express/cors/ioredis | npm |
| worker (dev-only) | `@animastor/contracts` devDep | npm, для sync-protocol (B6) |
| интеграционные тесты backend | `@animastor/gpu-hub` | npm вместо source-level require (§9 prep-plan) |

Generated-артефакты, получаемые НЕ из Git-истории:

| Артефакт | Источник после split |
|---|---|
| `packages/animastor-web-*/dist/` | build в web-репо (publish из dist) |
| `job-protocol-v2.cjs` | регенерация `sync-protocol.cjs` из npm contracts (история переносится, но canonical — генерация) |
| `worker-bundle` zip | GitHub Release animastor-worker (`animastor-worker-bundle-<ver>.zip` + sha256) |
| `hub-workflows`/`installer-src`/`install-manifests` zips | GitHub Release animastor-backend (`hub-artifacts-v1`: 3 asset по точным именам + sha256) |
| gpu-hub образ | GHCR digest-pin |
| `workflow.json`, `local.properties`, `.htpasswd`, `.env` | VPS-локальные файлы/секреты, не из истории |

## 4. Cross-repo зависимости после split (полный список)

1. hub → worker: release-артефакт `worker-bundle` (pin по asset+sha256).
2. hub → backend: release-артефакты `hub-workflows`/`installer-src`/`install-manifests`.
3. hub → backend (npm): `@animastor/contracts` (`PROTOCOL_VERSION`).
4. worker → backend (npm, dev): `@animastor/contracts` для sync-protocol.
5. backend app → npm: 14 пакетов backend-домена (публикуются из backend-репо).
6. web app → npm: 13 пакетов web-домена.
7. backend интеграционные тесты → npm `@animastor/gpu-hub` или HTTP (контрактный уровень).
8. android → web: parity snapshot (CI, commit+sha256).
9. worker/hub → backend: `JOB_PROTOCOL_V2.md` snapshot (G7).
10. android → web: `ANDROID_WEB_PARITY.md` snapshot (G7).
11. backend compose → пути выкачек web/hub/worker на VPS (деплой-слой, B11).
12. GPU Hub build → GHCR/npm (distr), не Git.

## 5. CI / hooks / secrets matrix

| Repo | Remotes | post-receive | Secrets (GitHub Actions) | G-гварды |
|---|---|---|---|---|
| animastor-backend | origin=VPS bare | `--mirror` → `Animastor/animastor-backend` | NPM_TOKEN (publish, **сначала возобновить — P3**), SSH/HTTPS-RO для hub-артефактного релиза | G1, G2 (15 pkgs), G6, G7-канон (JOB_PROTOCOL_V2, parity) |
| animastor-web | origin=VPS bare | `--mirror` → `Animastor/animastor-web` | NPM_TOKEN | G1, G2 (13 pkgs), G6, G7-канон (parity) |
| animastor-android | origin=VPS bare | `--mirror` → `Animastor/animastor-android` | (опц.) signing keystore | G6, G7-snapshot |
| animastor-worker | origin=VPS bare | `--mirror` → `Animastor/animastor-worker` | GITHUB_TOKEN (Release zip + sha256) | G3 (protocol drift), G6, G7-snapshot |
| animastor-gpu-hub | origin=VPS bare | `--mirror` → `Animastor/animastor-gpu-hub` | GHCR_TOKEN (или GITHUB_TOKEN к ghcr.io), артефактные токены только на build-time fetch | G4 (standalone build), G5 (artifact integrity), G6, G7-snapshot |

Hook-требования (§7.2 prep-plan): один bare = один hook = один mirror-remote;
guard по basename; hooks создаются **до** первого push; монорепо-hook не меняется.

## 6. Post-split verification (сразу после filter-repo каждого репо)

1. `git log --follow` по каждому файлу из §8.6 prep-plan («нельзя потерять») находит коммиты до извлечения пакетов.
2. `git log --oneline | wc -l` ≠ 0 и соответствует ожидаемой доле истории; branches = `master` (+`c21.4-…` до merge).
3. `git status` чист; `git fsck` без ошибок.
4. Отсутствие чужих доменов: `git ls-files | grep -E "^(frontends|backend|packages/animastor-(web|worker|gpu-hub))" ` — пусто вне целевых путей (проверка «случайного переноса»).
5. Пути соседних доменов не ссылаются из целевых файлов (spot-check: `grep -rn "packages/animastor-web-" backend/` — пусто после B2, и т.п.).
6. `npm ci && npm test` (backend/web/hub); `node tests/run-all.cjs` (worker/hub, zero-dep).
7. G1–G3 зелёные (backend/web/worker), G4/G5 — сборка hub-образа из клона с подставленными артефактами.
8. Bare-проверки: `git -C bare rev-parse HEAD` = push-нутому; `post-receive` отработал (в stderr — «Mirroring to GitHub»).

## 7. Post-publish verification (после появления зеркала на GitHub)

1. `git ls-remote` GitHub = tips bare (HEAD, все ветки, теги).
2. GitHub web: default branch = `master`; репо пустое не осталось (не «no commits»).
3. История на GitHub полна (сверка количества коммитов master).
4. Секреты не утекли: `git log -p | grep -E "htpasswd|BEGIN.*PRIVATE|POSTGRES_PASSWORD="` — пусто; `.env*` кроме example отсутствуют.
5. README/org-настройки: topics, права (mirrors — read-only для людей).
6. Release-механика: после первого release worker — asset скачивается, sha256 совпадает; hub-образ собирается по pin-файлу.

## 8. Blockers (текущее состояние)

| ID | Что | Тип | Снятие |
|---|---|---|---|
| P1 | 5 GitHub-репозиториев не созданы | организационное | создать пустые (без README), default `master` |
| P2 | работа в `c21.4-…`, `master` отстаёт на 136 коммитов | git-гигиена | FF `master` до c21.4 (§7.1 prep-plan уже спроектирован как fast-forward); перед split |
| P3 | npm-токен недействителен (E401) — publish недоступен, npm install публичных пакетов работает | секреты | выпустить/обновить NPM_TOKEN; до этого миграция B2/B3 может ссылаться на версии, но publish-ветка CI не пройдёт |
| P4 | untracked-файлы, на которые ссылается план: root `package.json` (RETIRE — ok), `workflow.json` (пустой каталог-заглушка вместо файла!), root `local.properties` | данные | решить до split: `workflow.json` восстановить/удалить из compose-mount и §8.1 whitelist; `local.properties` — оставить VPS-локальным (убрать из whitelist §8.3) |
| P5 | CI отсутствует во всех будущих репо (`.github/` нет) | процесс | создать workflows до split (§11 prep-plan шаг 4), иначе G-гварды негде гонять |
| P6 | диск 3.5 GB свободно (97% занято) | ресурсы | освободить ≥3 GB (5 клонов×~60 MB + working trees + docker-контекст) или чистить параллельно |

Блокеров, требующих изменения архитектуры/кода/плана: **нет**. B1–B12 из
prep-plan остаются в силе как этапы исполнения (не как препятствия для старта
split-механики): P-список выше — минимальный вход в исполнение §7–§11.

## 9. Exact recommended execution order

0. Pre: P1–P6 (репо GitHub, FF master, npm-токен, untracked-решения, CI-workflows, диск).
1. Создать 5 bare на VPS + hooks (до пушей); guard по basename.
2. Для каждого репо (очередь: backend → web → android → worker → gpu-hub):
   a. полный клон монорепо во временный каталог;
   b. `git filter-repo --path <white-list §8.n>` (+ `--tag-rename` при коллизиях тегов);
   c. проверки §6 этого документа;
   d. push в VPS bare; hook зеркалирует в GitHub;
   e. проверки §7 этого документа.
3. Миграция зависимостей в новом backend/web (B1–B3): npm-версии вместо `file:`, удаление mounts, регенерация lock; G1/G2.
4. Worker: contracts devDep + npm-резолв sync-protocol (B6); G3.
5. Hub: pin-файл `artifacts.lock.json`, stager на release-артефактах, G4/G5 (B5).
6. Перенос тестов по §9 prep-plan (B7); G6 во всех репо.
7. Деплой-декомпозиция (B11): compose-пути на выкачки новых bare.
8. Freeze монорепо (архив); финальная сверка tips bare↔GitHub.

## 10. Особые случаи — сверка с планом

- **@animastor/contracts**: канон в backend (KEEP), hub/worker потребляют npm; сгенерированная копия в worker переносится историей и остаётся регенерируемой (GENERATED). Согласовано: §2.2/§8.4 prep-plan ↔ §3 этого документа.
- **Worker bundle**: история переносится в worker-репо; распределение — только через Release (zip + sha256), не Git. `image/worker/` lock-файлы — частью KEEP.
- **GPU Hub artifacts**: 4 группы не переносятся сборкой из монорепо — только pin-файл + Release assets (§2.2 prep-plan); whitelists hub не содержат worker/installer/workflows путей — «случайного переноса» нет.
- **Android/Web parity**: root-файл canonical в web (KEEP у web), android получает COPY через CI; docs-архивные снимки — у web и backend как ARCHIVE. Whitelist'ы согласованы с §5.
- **docs/ archive/portal**: backend KEEP целиком (архив+портал), подмножества COPY у web/worker/hub — двойное владение объявлено (§8 prep-plan), редактирование — только у владельца.
- **Git history preservation**: filter-repo по white-list в клоне; `--follow`-проверки §6; теги — фильтруются вместе; коллизии тегов между репо устраняются `--tag-rename`.
- **Отсутствие случайного переноса**: все 5 white-list'ов — префиксные white-list; проверка №4 §6 детектирует чужие домены.

---

## Вердикт

Исполнимость §7–§11 preparation plan подтверждена разведкой окружения
(git-filter-repo 2.47.0, hook-механика, размеры, отсутствие tracked-секретов
и node_modules, отсутствие cross-domain симлинков в истории).

Обнаружены 6 административных pre-conditions (P1–P6, §8), не требующих
изменения кода или плана: 2 из них (P4 — `workflow.json`/`local.properties`,
P2 — FF master) желательно закрыть до первого filter-repo, остальные — в
процессе исполнения.

**PHYSICAL SPLIT: BLOCKED — P1 (GitHub-репозитории не созданы), P2 (master не fast-forward'нут до c21.4), P3 (npm-токен недействителен), P4 (untracked workflow.json/local.properties не решены), P5 (CI-workflows не созданы), P6 (диск 3.5 GB — впритык для 5 клонов). После закрытия P1–P6 — READY.**
