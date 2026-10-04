# Repository Split Execution Readiness

Дата: 2026-10-01
HEAD: `709f112e` (rev 3.2 preparation plan)
Статус: разведка исполнимости §7–§11 preparation plan. Физический split,
`git filter-repo`, новые репозитории и изменения GitHub/VPS НЕ выполнялись.

> **Обновление (2026-10-04): R-3 = A (SELECTED), B = REJECTED**
> (`repository-split-r3-decision.md`). Создаются **4** новых репозитория
> (backend/web/android/worker); `animastor-gpu-hub` существует и не трогается.
> Упоминания «5 репозиториев» ниже — исторический статус на 2026-10-01.

База: `docs/architecture/repository-split-preparation-plan.md` (rev 3.2),
`repository-split-reconnaissance-audit.md`, Phase 10R/10S (artifact
decoupling), Phase 9C/9D (contracts/worker).

---

## Executive result

**PHYSICAL SPLIT: BLOCKED** — до выполнения hard prerequisites (§8, §9).
Блокеров, требующих переделки preparation plan, не обнаружено; план исполним
как есть. P1–P6 неоднородны (§8):

- **HARD PRECONDITIONS** — обязательны ДО физического filter-repo split:
  P2 (FF master), P4 (untracked-решения), P5 (CI, G1–G5), P6 (диск), P1
  (bare/GitHub/hooks — к шагу 5, до первого push), а также этапы B1–B4, B6,
  B8, B12 → B5 → B7 → B9 (§9, шаги 1–4).
- **POST-SPLIT REQUIREMENTS** — сам filter-repo не блокируют: P3 (npm-токен,
  publish-CI).

Единственный статус документа — **BLOCKED**; READY фиксируется только после
закрытия всех hard prerequisites. Детали: §8 (классификация), §9 (порядок),
Вердикт (в конце).

---

## 1. Подтверждённые факты окружения (проверено на VPS)

| Факт | Значение | Влияние на split |
|---|---|---|
| `git-filter-repo` | v2.47.0, `/home/animastor/.local/bin/` (pip) | доступен ✓ |
| git / python | 2.34.1 / 3.10.12 | достаточно ✓ |
| История | 1632 коммита; bare и working copy идентичны | фильтрация по полному клону ✓ |
| Bare ↔ mirror | post-receive `git push --mirror github`; SSH-ключ `github_ed25519` | схема §7.2 воспроизводима для новых bare ✓ |
| Размер | pack 55.7 MiB; диск **исторически** 3.5 GB свободно (**2026-10-04: 6.4G ≥ 5G → P6 CLOSED/PASS**) | 4–5 клонов + рабочих деревьев достаточно (запас после 2026-10-04 нормальный) |
| node_modules в git | 0 tracked файлов; dist/ не tracked | клон чист, фильтрации мешает только размер рабочего дерева |
| Симлинки | только 3 в `node_modules` (untracked) + untracked внутри пакетов | в историю не попадают; физически не переносятся ✓ |
| Секреты | `.env`, `proxy/conf/.htpasswd` — untracked/ignored; `LETS_ENCRYPT_DIR` — вне репо | в split-историю не попадут ✓ |
| npm | registry npmjs; в `~/.npmrc` есть authToken, но **недействителен** (E401) | см. P3 |
| GitHub org | Animastor существует; репозитории не созданы | P1 |
| Untracked root | `package.json` (реальный файл), `workflow.json` (пустой каталог, root-owned), `local.properties` — ни один не имеет истории (`git log --all` пуст) | решения зафиксированы (P4): `workflow.json` — RETIRE, `local.properties` — VPS-local |
| CI в монорепо | отсутствует (`.github/` нет) | CI создаётся с нуля в split-репо — P5 |
| Ветка | work идёт в `c21.4-…` (709f112e), `master` отстаёт (8118f766) | см. P2 |

## 2. Path matrix: SOURCE PATH → TARGET REPO → ACTION

ACTION-словарь: **KEEP** — переносится историей (filter-repo white-list);
**MOVE** — подмножество KEEP, уходит из backend в другой репо (владелец меняется);
**COPY** — создаётся заново у другого владельца по snapshot-механизму §5
(история не переносится); **ARCHIVE** — копия-заморозка, владелец не редактирует;
**RETIRE** — удаляется в момент split; **GENERATED** — восстанавливается
инструментом/npm, не переносится историей.

### 2.1 animastor-backend (KEEP; единственное исключение — `workflow.json`, RETIRE)

| Source path | ACTION | Примечание |
|---|---|---|
| `backend/` | KEEP | приложение + `backend/ai/workflows/` (hub-workflows артефакт) |
| `packages/animastor-{ai-agent, ai-analysis, ai-connector, assistant, auth, comfyui-workflow-connector, contracts, editor, generation, installer, orchestration, parser, player, url-safety, vbook-runtime}` (15) | KEEP | все опубликованы; contracts = канон протокола |
| `docker/` | KEEP+ARCHIVE | compose-overlays целиком; `docker/worker/` — ARCHIVE (владелец worker), `overlay-gpu-hub-standalone.yml` — ARCHIVE (владелец hub) |
| `docker-compose.yml` | KEEP | infra, монтирует пути web/hub после split (B11) |
| `proxy/` | KEEP | nginx; `proxy/conf/.htpasswd` не tracked — пересоздать на VPS (P-деплой) |
| `scripts/` | KEEP | общий; `check-artifacts.sh` дублируется в hub (см. 2.5) |
| `docs/` | KEEP+ARCHIVE | целиком, 284 файла; parity-копия — заморозка |
| `workflow.json` | RETIRE | untracked (истории нет, `git log --all` пуст); runtime-код backend его не читает (0 ссылок в `backend/`); compose-mount `./workflow.json:/workflow.json:ro` — мёртвый, снимается при cutover (B11); в выполняемый whitelist не входит — см. P4, §2.6 |
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

### 2.3 animastor-android (KEEP; исключение — root `local.properties`, VPS-local, не переносится)

| Source path | ACTION | Примечание |
|---|---|---|
| `frontends/android/` | KEEP | 213 файлов; `build/` не tracked; `gradle.properties` tracked |
| `apk-build.sh`, `build-apk.sh` | KEEP | — |
| root `ANDROID_WEB_PARITY.md` | COPY | snapshot-механизм §5: CI android получает файл из web-репо, проверяет commit+sha256; история parity НЕ переносится |
| `LICENSE` | KEEP | — |

Override к prep plan §8.3 (prep plan НЕ меняется): строка
`--path local.properties` **исключается** из выполняемой команды.
`local.properties` — untracked VPS-local (истории нет): в историю Android не
переносится, на VPS пересоздаётся локально. Выполняемый whitelist = §8.3
минус эта строка.

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
| root `workflow.json` | RETIRE: untracked пустой каталог-заглушка (root-owned); runtime-код backend его не читает (0 ссылок в `backend/`); compose-mount — мёртвый, снимается при cutover (B11); строка `--path workflow.json` (§8.1 prep-plan) — no-op, из команды исключается |
| root `local.properties` | VPS-local/untracked: в историю Android не переносится; строка `--path local.properties` (§8.3 prep-plan) — no-op, из команды исключается (см. §2.3) |

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
| backend | `workflow.json` (untracked) | RETIRE (§2.6): runtime не читает (0 ссылок в `backend/`), compose-mount мёртв; mount снимается при cutover (B11), каталог-заглушка удаляется на VPS до split; в историю не попадает |

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
| `local.properties`, `.htpasswd`, `.env` | VPS-локальные файлы/секреты, не из истории (`workflow.json` — RETIRE, §2.6) |

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
| animastor-backend | origin=VPS bare | `--mirror` → `Animastor/animastor-backend` | NPM_TOKEN (publish; P3 — POST-SPLIT REQUIREMENT), SSH/HTTPS-RO для hub-артефактного релиза | G1, G2 (15 pkgs), G6, G7-канон (JOB_PROTOCOL_V2, parity) |
| animastor-web | origin=VPS bare | `--mirror` → `Animastor/animastor-web` | NPM_TOKEN | G1, G2 (13 pkgs), G6, G7-канон (parity) |
| animastor-android | origin=VPS bare | `--mirror` → `Animastor/animastor-android` | (опц.) signing keystore | G6, G7-snapshot |
| animastor-worker | origin=VPS bare | `--mirror` → `Animastor/animastor-worker` | GITHUB_TOKEN (Release zip + sha256) | G3 (protocol drift), G6, G7-snapshot |
| animastor-gpu-hub | **⛔ REJECTED при R-3 = A — НЕ ИСПОЛНЯТЬ** (`--mirror` в `Animastor/animastor-gpu-hub` **запрещён бессрочно**) | — | — | — |

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

## 8. Blockers P1–P6 — HARD PRECONDITIONS vs POST-SPLIT REQUIREMENTS

| ID | Что | Тип | Снятие | Класс |
|---|---|---|---|---|
| P1 | **CLOSED (2026-10-04)**: 4 пустых GitHub-репо созданы владельцем (200 / `size=0` / 0 refs, `default_branch=main`, 2026-10-03) **+ 4 VPS bare + hooks + remote `github` созданы 2026-10-04** (0 refs/0 objects, `HEAD=refs/heads/main`, hook 0755/91 байт byte-identical); **push не выполнялся**; GPU Hub не трогали — R-3 = A | организационное | ~~создать~~ **выполнено**; **gpu-hub — ничего не создавать** | **HARD — ВЫПОЛНЕНО** — bare/GitHub/hooks существуют до первого push (§9, шаг 5) |
| P2 | работа в `c21.4-…`, `master` отстаёт на 136 коммитов | git-гигиена | FF `master` до c21.4 (§7.1 prep-plan — fast-forward по построению) | **HARD** — filter-repo запускается только на финальной линейной истории |
| P3 | npm-токен недействителен (E401) — publish недоступен, npm install публичных пакетов работает | секреты | выпустить/обновить NPM_TOKEN; до этого publish-ветка CI не пройдёт | **POST-SPLIT** — сам filter-repo не блокирует; обязателен для publish-CI после split |
| P4 | untracked root `package.json` / `workflow.json` / `local.properties` | данные | решение зафиксировано (этот документ): `workflow.json` — **RETIRE** (§2.1, §2.6: runtime не читает, mount мёртв, из whitelist исключён); `local.properties` — **VPS-local**, из whitelist §8.3 исключён (§2.3); root `package.json` — RETIRE (B12). До split: физически удалить каталог-заглушку `workflow.json` | **HARD** — определяет выполняемые whitelist'ы |
| P5 | CI отсутствует во всех будущих репо (`.github/` нет) | процесс | создать workflows до split (§11 prep-plan шаг 4); минимум G1–G5 (§10 prep-plan) | **HARD** — §10 prep-plan: G1–G5 до физического split |
| P6 | диск исторически 3.5 GB свободно (97% занято); **актуально 2026-10-04: 6 839 934 976 B ≈6.4 GiB ≥ 5G** | ресурсы | ~~освободить ≥3 GB~~ — **не требуется** (порог ≥5G выполнен без очистки) | **CLOSED / PASS** — не блокирует |

Блокеров, требующих изменения архитектуры/кода/плана: **нет**. B1–B12 —
обязательные этапы исполнения ДО filter-repo (§9, шаги 1–4), а не опция:
запуск filter-repo при невыполненных B-этапах или открытых HARD-пунктах
P1/P2/P4/P5/P6 запрещён. Единственный POST-SPLIT пункт — P3.

## 9. Exact recommended execution order (согласован с prep plan §11)

Единственный допустимый порядок. `filter-repo` — только шаг 6; запуск при
невыполненных шагах 0–5 или открытых HARD-пунктах P1/P2/P4/P5/P6 запрещён.

0. **FF master** (P2): `master` fast-forward до `c21.4-…` (§7.1 prep-plan);
   удалить `tmp/parser-audit-backup` (по подтверждению); физически удалить
   каталог-заглушку `workflow.json` (решение RETIRE, P4).
1. **Размонорепизация** (B1–B4, B6, B8, B12): contracts в `dependencies`,
   11 backend + 13 web `file:` → npm, удаление 5 mounts, sync-protocol на
   npm-резолв, web dist build pipeline, удаление root `package.json`;
   гварды G1/G2/G3. Каждый шаг — отдельный коммит с тестами.
2. **Артефактная схема hub** (B5): Release-артефакты (`worker-bundle-v2.1.1`;
   `hub-artifacts-v1` — 3 asset), pin-файл `artifacts.lock.json`, stager на
   release-артефактах, G4+G5.
3. **Перенос тестов** (B7) по §9 prep-plan (39 KEEP + 4 SPLIT + 2 MOVE +
   1 RETIRE, +7 интеграционных); G6.
4. **CI** (B9, P5): workflows в монорепо-путях так, чтобы переехали без
   переписывания; минимум G1–G5 зелёные (§10 prep-plan). Также P6:
   освободить ≥3 GB диска.
5. **Инфраструктура публикации** (P1): 5 bare на VPS + 5 пустых GitHub-репо;
   post-receive hooks (§7.2 prep-plan) — до первого push; guard по basename;
   G7.
6. **Физический filter-repo split** — только здесь. Очередь: backend → web →
   android → worker → gpu-hub; для каждого:
   a. полный клон монорепо во временный каталог;
   b. `git filter-repo --path <§8.n prep-plan>` с override'ами этого
      документа: §8.1 без `--path workflow.json` (untracked, RETIRE),
      §8.3 без `--path local.properties` (VPS-local);
      (+ `--tag-rename` при коллизиях тегов);
   c. post-split verification (§6);
   d. push в VPS bare; hook зеркалирует в GitHub;
   e. GitHub mirror verification (§7).
7. **Freeze монорепо** (архив); финальная сверка tips bare ↔ GitHub.
8. **Deployment cutover** (B11): compose-пути на выкачки новых bare;
   снятие мёртвого `workflow.json`-mount (contracts-mount снят в B1);
   nginx-портал на выкачки.

P3 (npm-токен) — POST-SPLIT REQUIREMENT: закрыть до первого publish из
отфильтрованных репозиториев; сам filter-repo не блокирует.

## 10. Особые случаи — сверка с планом

- **@animastor/contracts**: канон в backend (KEEP), hub/worker потребляют npm; сгенерированная копия в worker переносится историей и остаётся регенерируемой (GENERATED). Согласовано: §2.2/§8.4 prep-plan ↔ §3 этого документа.
- **Worker bundle**: история переносится в worker-репо; распределение — только через Release (zip + sha256), не Git. `image/worker/` lock-файлы — частью KEEP.
- **GPU Hub artifacts**: 4 группы не переносятся сборкой из монорепо — только pin-файл + Release assets (§2.2 prep-plan); whitelists hub не содержат worker/installer/workflows путей — «случайного переноса» нет.
- **Android/Web parity**: root-файл canonical в web (KEEP у web), android получает COPY через CI; docs-архивные снимки — у web и backend как ARCHIVE. Whitelist'ы согласованы с §5.
- **docs/ archive/portal**: backend KEEP целиком (архив+портал), подмножества COPY у web/worker/hub — двойное владение объявлено (§8 prep-plan), редактирование — только у владельца.
- **Git history preservation**: filter-repo по white-list в клоне; `--follow`-проверки §6; теги — фильтруются вместе; коллизии тегов между репо устраняются `--tag-rename`.
- **Отсутствие случайного переноса**: все 5 white-list'ов — префиксные white-list; проверка №4 §6 детектирует чужие домены.
- **Untracked-пути в whitelist (override; prep plan НЕ меняется)**: `workflow.json` (§8.1) и `local.properties` (§8.3) никогда не были tracked — строки `--path` для них no-op; из выполняемых команд исключаются: `workflow.json` — RETIRE (runtime не читает), `local.properties` — VPS-local. Выполняемые whitelist'ы = §8.n prep-plan минус эти две строки.

---

## 11. Самопроверка (сверка с preparation plan rev 3.2)

- Статус един во всех разделах (Executive result, §8, §9, Вердикт):
  **PHYSICAL SPLIT: BLOCKED**; READY — только после hard prerequisites.
- Порядок исполнения §9 = prep plan §11: 0. FF → 1. B1–B4/B6/B8/B12 →
  2. B5 → 3. B7 → 4. B9 (G1–G5) → 5. bare/GitHub/hooks → 6. filter-repo →
  7. freeze → 8. cutover; filter-repo раньше шагов 0–5 невозможен.
- Path matrix §2 ↔ §8.1–8.5 prep-plan: расхождение только в двух объявленных
  override'ах — `workflow.json` (RETIRE) и `local.properties` (VPS-local);
  оба untracked, истории не имеют; prep plan не меняется.
- RETIRE §2.6 ↔ §3.1/§3.3: `workflow.json`, root `package.json`,
  `local.properties` — в split-историю не попадают.
- Классификация §8: HARD = P1, P2, P4, P5, P6; POST-SPLIT = P3 (единственный).
- CI-матрица §5 ↔ G1–G7 (§10 prep-plan): G1/G2 — backend+web, G3 — worker,
  G4/G5 — hub, G6 — все, G7 — snapshot-репо.
- Верификации §6/§7 ссылаются только на пути из выполняемых whitelist'ов.

---

## Вердикт

Исполнимость §7–§11 preparation plan подтверждена разведкой окружения
(git-filter-repo 2.47.0, hook-механика, размеры, отсутствие tracked-секретов
и node_modules, отсутствие cross-domain симлинков в истории). План не требует
изменений.

**PHYSICAL SPLIT: BLOCKED** до выполнения HARD prerequisites:

- этапы §9 (шаги 1–4): размонорепизация B1–B4, B6, B8, B12 → артефактная
  схема B5 → перенос тестов B7 → CI B9 с G1–G5;
- P2 (FF `master` до c21.4), P4 (untracked-решения: `workflow.json` — RETIRE,
  `local.properties` — VPS-local; зафиксировано этим документом), P5
  (CI-workflows, G1–G5), P6 (диск ≥3 GB);
- P1 (bare + GitHub-репозитории + hooks) — к шагу 5, до первого push.

**POST-SPLIT REQUIREMENT** (сам filter-repo не блокирует): P3 — возобновить
NPM_TOKEN для publish-CI отфильтрованных репозиториев.

После закрытия всех HARD пунктов статус становится READY и выполняется шаг 6
(filter-repo) в порядке §9.
