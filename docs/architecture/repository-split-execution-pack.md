# Repository Split — EXECUTION PACK (per-repo spec · идемпотентность · rollback · GO-чеклист)

> **BACKEND: SPLIT / PUBLISHED (2026-10-04, стадия C, шаг 1/4)** —
> `git filter-repo` **ВЫПОЛНЕН** для `animastor-backend`, первый push
> **БЕЗ force** выполнен, `Animastor/animastor-backend` = `main` =
> bare `refs/heads/main` = **`f83f929c732d8fc490bd150e72294d6b3c6e2f92`**.
> Полный журнал стадии C — **§11**.
> **web / android / worker: PHYSICAL SPLIT NOT EXECUTED** (3 оставшихся bare
> по-прежнему 0 refs / 0 objects, GitHub 0 refs — выполняются отдельно).
> **git filter-repo для web/android/worker/gpu-hub: NOT EXECUTED.**
> **force-push: NOT EXECUTED ни для одного репозитория.**
> `master` монорепо, `Animastor/animastor-gpu-hub` / bare
> `animastor-gpu-hub.git`, hooks, backup, BEFORE-snapshot,
> `tmp/parser-audit-backup`: **NOT MODIFIED** (§11, BEFORE == AFTER).
> **npm publish: NOT EXECUTED**
> **R-3 = A (SELECTED) · R-3 = B: REJECTED (не исполняется)**
> **P6 = CLOSED / PASS (6.4G ≥ 5G, 2026-10-04) · P1 = CLOSED (4 пустых GitHub-репо
> 2026-10-03 + 4 VPS bare/hooks/remote 2026-10-04)**
> **GO-05 = CLOSED (`NEWBRANCH=main`, owner-confirmation) · стадия B =
> ВЫПОЛНЕНА (GO-08 backup + GO-14 BEFORE-snapshot, 2026-10-04)**
> **GO-01…GO-15 = PASS/READY/CLOSED/N/A при перепроверке перед стадией C
> (2026-10-04) · авторизация стадии C для backend выдана владельцем**

> **Статус этого документа: read-only deliverable + статус стадий B и C
> (backend).** Разделы §1–§10 остались read-only: команды ниже
> **исполнялись в read-only режиме** (`ls-tree`, `rev-list`, `log`,
> `count-objects`, `du`, `df`, `show-ref`) против frozen source и существующих
> bare-репозиториев. **Исполнены** (2026-10-04, стадия C, backend): §4.1.0
> (общий блок, только проверки) + **§4.1.1** — свежий клон `$SPLIT/backend`,
> `git filter-repo` (35 `--path`), AFTER-проверки, первый `push HEAD:refs/heads/main`
> **без `--force`**, post-receive hook + GitHub/bare parity. Подготовительные
> ревизии создавали 4 пустых bare + hook + remote (P1, 2026-10-04) и
> **артефакты стадии B** — `backups/animastor-pre-split-64127b9e.git` и
> `backups/before-split-64127b9e-refs/` (2026-10-04). **Не изменялись:**
> production-код монорепо, `master`, GPU Hub, hook'и, backup, snapshot,
> `tmp/parser-audit-backup`; **не выполнялись:** §4.1.2–§4.1.4 (web/android/worker),
> §4.1.5 (gpu-hub — REJECTED), `--path-rename`, `--force`, npm publish.

Авторитетный GO/NO-GO — `repository-split-final-gate.md`.
Исполняемый командный лист — `repository-split-next-blockers.md` §4.1.0–§4.1.6.
PRE-SPLIT блокеры P1 / P6, план создания репозиториев и единый GO-чеклист —
`repository-split-pre-split-go-blockers.md`.
Решение по GPU Hub: **R-3 = A (SELECTED), B = REJECTED** —
`repository-split-r3-decision.md`.
Этот документ **не заменяет** их: он добавляет то, чего в них не было —
per-repo спеки с проверяемыми grep/`--follow`-командами, аудит идемпотентности
и безопасности командного листа с фактическими FAIL'ами и их фиксами,
процедуру backup/rollback и единый GO-чеклист.

---

## 1. Frozen source (неизменяемая точка)

| Поле | Значение |
|---|---|
| **Source для `git filter-repo` (единственный)** | **`64127b9e1dea2ac528a572b51b90a542b70c5ebb`** |
| Branch | `c21.4-physically-extract-analysis-from-backend` |
| `master` / bare `master` | == frozen source (**P2 CLOSED**) |
| Commits на source | **1653** (merge **0**, tags **0**), первый — «Recovery01: June 9 working state + dedup» |
| Tracked files на source | **1635** |
| Правило | `filter-repo` выполняется **только** от `$SRC`; tip ветки — только документационный HEAD. Проверка: `git rev-parse refs/heads/master` == `$SRC` |

Перед запуском **каждого** репо `$SRC` перепроверяется в `$BARE` (§4.1.0).

---

## 2. Стадии исполнения (жёсткое разделение)

Все дальнейшие действия разделены на четыре стадии. **Смешение запрещено** —
читаете таблицу сверху вниз, останавливаетесь на первом FAIL'е.

| Стадия | Что делает | Пишет куда-либо? | Блокеры, которые должны быть сняты ДО неё |
|---|---|---|---|
| **A — read-only preflight** | `df`, `git rev-parse`, `git ls-remote`, `git for-each-ref`, GitHub API, `npm whoami`, whitelist/счётчики | **нет** | ничего (можно выполнять всегда) |
| **B — backup** | `git clone --mirror` монорепо в `backups/` | **только** в новый backup-каталог; `$BARE` **не пишется**; **GPU Hub не затрагивается** (R-3=A — см. `repository-split-r3-decision.md`) | **ВЫПОЛНЕНА (2026-10-04)**: `$BK = backups/animastor-pre-split-64127b9e.git` (`--mirror --no-local`, 22 431 724 B, restore-дрилл OK) + BEFORE-snapshot `backups/before-split-64127b9e-refs/`; A зелёный, P6-бюджет учтён |
| **C — destructive / rewrite** | `git filter-repo` в **свежем клоне**, `git push` в **новый** bare | клон `$SPLIT/{backend,web,android,worker}`, новые bare. **Никаких push в существующий GPU Hub bare или GitHub** | **все** пункты GO-чеклиста §6: P1, P6, **R-3 = A зафиксирован**, B-бэкап подтверждён, `$SRC` сверён |
| **D — cleanup / пост-контроль** | `git fsck`, leak-чеки, `--follow`, smoke-matrix, freeze монорепо, cutover B11 | пост-контроль + compose/nginx | C по каждому репо успешен |

**Что НЕ входит ни в одну стадию (запрещено на любом шаге):** `--path-rename`,
`--force` для `git filter-repo`, force-push в монорепо или в `master`,
изменение hook'ов, `npm publish`, изменение production-кода и B7-тестов,
регенерация текущих monorepo lock'ов, **любые действия с GPU Hub
(R-3 = A: не выполняются вовсе — см. `repository-split-r3-decision.md` §1.1,
§3.1)**, автоматическая очистка диска (`pip cache purge` — только по
распоряжению владельца).

**Порядок репо (R-3 = A, не менять):** 1 backend → 2 web → 3 android →
4 worker → 5 smoke → 6 freeze + cutover.
**Шаг `gpu-hub` исключён из очереди** — `filter-repo` для GPU Hub не
выполняется, существующий `Animastor/animastor-gpu-hub` не перезаписывается.

---

## 3. Per-repo execution spec (проверяемые ожидания)

### 3.1 Сводная таблица (посчитано read-only на `$SRC`)

| Repo | `--path` §8 → исполняется | Ожидалось файлов | Ожидалось коммитов после `filter-repo` | `package.json` | lock'ов (→ регенерация) | Первый коммит (исторический корень) |
|---|---|---|---|---|---|---|
| `animastor-backend` | 36 → **35** (нет `workflow.json`) | **1045** | **1267** | 16 | 16 (4 → регенерация) | `Recovery01: June 9 working state + dedup` |
| `animastor-web` | 31 → **31** | **349** | **275** | 14 | 14 (2 → регенерация) | `docs: reorganize into topical structure — integrate docs-claude, archive completed TODOs, add README index` |
| `animastor-android` | 6 → **5** (нет `local.properties`) | **217** | **107** | 0 | 0 | `Recovery01: June 9 working state + dedup` |
| `animastor-worker` | 19 → **19** | **58** | **24** | 3 | 3 (0 → регенерация) | `docs(beta): private worker / gpu hub architectural reconnaissance` |
| `animastor-gpu-hub` (**R-3 = B — REJECTED, не исполняется**) | 27 → **26** (нет `gpu-hub-rebuild.sh`) | 44 | 37 | 1 | 1 (0 → регенерация) | `docs: add MIT license + professional README + open-source files` |
| **Итого** | 119 → **116**; **при R-3 = A (SELECTED): 90** | **при A: 1669 instance'ов = 1615 unique** (1045+349+217+58); из 1635 tracked **20 не копируются никуда** — 19 файлов `packages/animastor-gpu-hub/` + `gpu-hub-rebuild.sh` (они только в замороженном монорепо; сам компонент — в существующем standalone-репо). строка «1714» — **историческая** (считает 5 репо с gpu-hub = 45) | — | **33** (16+14+0+3) | **33** (при A — без gpu-hub) | — |

- **Формула ожидания коммитов** (та же, что даёт post-filter-история):
  `git rev-list --count $SRC -- <те же --path, что в §4.1.x>`.
  Счётчик считает **по prefix'ам `--path`**, а не по списку сегодняшних файлов:
  коммиты, удалявшие файлы под этим prefix'ом (их в `$SRC` уже нет), после
  `filter-repo` **сохраняются**. Проверено: backend по prefix'ам = 1267, по
  списку живых файлов = 1149 — **брать 1267**. Для gpu-hub разница =
  `gpu-hub-rebuild.sh`: с ним 38, без него **37** — **число актуально только
  для отклонённого варианта B; при R-3 = A `filter-repo` gpu-hub не выполняется**.
- **Исторические числа** в §FPSG / §FINAL PRE-SPLIT TECHNICAL CLOSURE на прошлых
  SHA (`b7e2f7cd`, `e6763c67` и др.) **не править** — это журнал.

### 3.2 `animastor-backend` — §4.1.1

| Поле | Ожидание |
|---|---|
| Корневой layout | `.dockerignore` `.env.example` `.gitignore` `ARCHITECTURE.md` `CONTRIBUTING.md` `LICENSE` `MEMORY.md` `MiM.vbook` `README.md` `SECURITY.md` `THIRD_PARTY_NOTICES.md` `backend/` `backend-rebuild.sh` `docker/` `docker-compose.yml` `docs/` `front-backend-rebuild.sh` `packages/` (15) `proxy/` `scripts/` `src-backup.sh` |
| package identity | корневого `package.json` **нет** → корневой манифест = `backend/package.json` (`name: animastor-backend`) |
| lock'и | **16** (16 манифестов), регенерация **4**: `packages/animastor-{orchestration(108), comfyui-workflow-connector(4), generation(2), vbook-runtime(1)}` = 117 относ. записей; `backend/package-lock.json` и остальные 11 — **0** записей, не трогать |
| **Запрещённые пути** | `frontends/**`, `tools/**`, `workflow.json`, `local.properties`, `package.json` в корне, `packages/animastor-{worker,gpu-hub,web-*}`, `gpu-hub-rebuild.sh`, `app-web-rebuild.sh`, `apk-build.sh`, `build-apk.sh`, `ANDROID_WEB_PARITY.md` |

```sh
# leak (получено должно быть 0)
test "$(git ls-files | grep -cE '^(ANDROID_WEB_PARITY\.md$|apk-build\.sh$|app-web-rebuild\.sh$|build-apk\.sh$|frontends/|gpu-hub-rebuild\.sh$|tools/|workflow\.json$|local\.properties$|package\.json$|packages/animastor-(worker|gpu-hub|web-))' || :)" -eq 0 || { echo "FAIL: чужие пути в backend-repo"; exit 1; }
echo "OK: backend no leak"
# history «нельзя потерять» (§8.6)
git log --follow --format='%h %ad %s' --date=short -- packages/animastor-contracts/src/job-protocol-v2.js
git log --follow --format='%h %ad %s' --date=short -- backend/ai/workflows
git log --follow --format='%h %ad %s' --date=short -- packages/animastor-installer/ai/install-manifests
git log --follow --format='%h %ad %s' --date=short -- scripts/check-artifacts.sh
git log --follow --format='%h %ad %s' --date=short -- docs/architecture/GPU_HUB_CONTRACT.md
```
Все 5 путей существуют и логируются — проверено на `$SRC`.

### 3.3 `animastor-web` — §4.1.2

| Поле | Ожидание |
|---|---|
| Корневой layout (7) | `ANDROID_WEB_PARITY.md` `LICENSE` `app-web-rebuild.sh` `docs/` `frontends/{app,website}` `packages/` (13) `tools/{desktop-web-tester,mobile-web-tester}` |
| package identity | корневого `package.json` **нет** → корневой манифест = `frontends/app/package.json` |
| lock'и | **14**, регенерация **2**: `packages/animastor-web-generator-{sse(1), vbook(1)}` |
| ⚠ gap | **корневого `.gitignore` нет** → `node_modules` станут untracked → создать сразу после extraction (§5.2) |
| **Запрещённые пути** | `backend/`, `docker/`, `proxy/`, `scripts/`, `frontends/android/`, все root-`*.md`, `docker-compose.yml`, `.dockerignore`, `.env.example`, `.gitignore`, `packages/animastor-{ai-…,assistant,auth,comfyui,contracts,editor,generation,gpu-hub,installer,orchestration,parser,player,url-safety,vbook,worker}` |

```sh
# leak (получено должно быть 0)
test "$(git ls-files | grep -cE '^(backend/|docker/|proxy/|scripts/|frontends/android/|gpu-hub-rebuild\.sh$|apk-build\.sh$|build-apk\.sh$|backend-rebuild\.sh$|front-backend-rebuild\.sh$|src-backup\.sh$|MiM\.vbook$|docker-compose\.yml$|\.dockerignore$|\.env\.example$|\.gitignore$|ARCHITECTURE\.md$|CONTRIBUTING\.md$|MEMORY\.md$|README\.md$|SECURITY\.md$|THIRD_PARTY_NOTICES\.md$|workflow\.json$|local\.properties$|package\.json$|packages/animastor-(ai-|assistant|auth|comfyui|contracts|editor|generation|gpu-hub|installer|orchestration|parser|player|url-safety|vbook|worker))' || :)" -eq 0 || { echo "FAIL: чужие пути в web-repo"; exit 1; }
echo "OK: web no leak"
# подмножества docs: должен напечатать только CLEAN
test -z "$(git ls-files | grep '^docs/' | grep -vE '^docs/(05-frontend/|08-mobile-web-migration/|09-desktop-migration/|architecture/(ANDROID_WEB_PARITY|web-[a-z0-9-]+)\.md$)' || :)" || { echo "FAIL: лишние файлы docs/ в web-repo"; exit 1; }
echo "OK: web docs subset"
# history
git log --follow --format='%h %ad %s' --date=short -- ANDROID_WEB_PARITY.md
git log --follow --format='%h %ad %s' --date=short -- frontends/app
```
⚠ В отличие от остальных, паттерн web **не должен** содержать `tools/`:
monorepo-`tools/` целиком whitelisted (`desktop-web-tester`, `mobile-web-tester`).

### 3.4 `animastor-android` — §4.1.3

| Поле | Ожидание |
|---|---|
| Корневой layout (5) | `ANDROID_WEB_PARITY.md` `LICENSE` `apk-build.sh` `build-apk.sh` `frontends/android/` (213) |
| package identity | `package.json` **0**; npm не применяется (только Gradle `junit:junit:4.13.2`) |
| lock'и | **0** |
| ⚠ gap | корневого `.gitignore` нет → `local.properties`, `gradle-*/`, `*.apk`, `.gradle/` станут untracked → создать сразу (§5.3) |
| **Запрещённые пути** | вообще всё, кроме 5 позиций выше: `backend/`, `docs/`, `docker/`, `proxy/`, `scripts/`, `tools/`, **всё `packages/`** |

```sh
# whitelist-форма: все 217 файлов обязаны попадать в разрешённое множество
test "$(git ls-files | wc -l)" -eq 217 || { echo "FAIL: 217 файлов"; exit 1; }
test -z "$(git ls-files | grep -Ev '^(frontends/android/|apk-build\.sh$|build-apk\.sh$|ANDROID_WEB_PARITY\.md$|LICENSE$)' || :)" || { echo "FAIL: чужие пути в android-repo"; exit 1; }
echo "OK: android no leak"
git log --follow --format='%h %ad %s' --date=short -- ANDROID_WEB_PARITY.md
git log --follow --format='%h %ad %s' --date=short -- frontends/android
```

### 3.5 `animastor-worker` — §4.1.4

| Поле | Ожидание |
|---|---|
| Корневой layout (4) | `LICENSE` `docker/worker/` (3) `docs/architecture/` (16) `packages/animastor-worker/` (38) |
| package identity | корневого `package.json` **нет** → `packages/animastor-worker/package.json` (`@animastor/worker-dev`); вложенные: `worker/package.json` (canonical `2.1.1`), `image/worker/package.json` |
| lock'и | **3**, регенерация **0** (ни один не содержит `../`-записей) |
| **Запрещённые пути** | `backend/`, `frontends/`, `proxy/`, `scripts/`, `docker/` (кроме `docker/worker`), `docker-compose.yml`, все root-`*.md`, все пакеты кроме `animastor-worker`, `tools/` |

```sh
test "$(git ls-files | wc -l)" -eq 58 || { echo "FAIL: 58 файлов"; exit 1; }
test -z "$(git ls-files | grep -Ev '^(packages/animastor-worker/|docker/worker/|docs/architecture/(JOB_PROTOCOL_V2|PHASE_9|WORKER_PACKAGE_RELOCATION|EXPERIMENTAL_BETA_|LINUX_INSTALLER_RECONNAISSANCE)|LICENSE$)' || :)" || { echo "FAIL: чужие пути в worker-repo"; exit 1; }
echo "OK: worker no leak"
git log --follow --format='%h %ad %s' --date=short -- packages/animastor-worker/tools/sync-protocol.cjs
git log --follow --format='%h %ad %s' --date=short -- packages/animastor-worker/worker/job-protocol-v2.cjs
git log --follow --format='%h %ad %s' --date=short -- docker/worker
git log --follow --format='%h %ad %s' --date=short -- docs/architecture/JOB_PROTOCOL_V2.md
```

### 3.6 `animastor-gpu-hub` — **R-3 = B → REJECTED / NOT SELECTED (не исполнять)**

> **⛔ ЭТА СЕКЦИЯ НЕИСПОЛНЯЕМА при R-3 = A (SELECTED).**
> `filter-repo` для GPU Hub **не выполняется**, существующий
> `Animastor/animastor-gpu-hub` (bare `7c7778c`) **не перезаписывается**,
> новый hub-репозиторий **не создаётся**. Секция сохранена **только как
> историческая запись** отклонённого варианта B.
> Нормативный документ — `repository-split-r3-decision.md`.

| Поле | Ожидание |
|---|---|
| Корневой layout (5) | `LICENSE` `docker/compose/overlay-gpu-hub-standalone.yml` `docs/architecture/` (22) `packages/animastor-gpu-hub/` (**19**) `scripts/check-artifacts.sh` = **44**; + исключённый `gpu-hub-rebuild.sh` = 45 в §8.5 |
| package identity | `packages/animastor-gpu-hub/package.json` (`@animastor/gpu-hub` 0.1.1, devDeps нет) |
| lock'и | **1**, регенерация **0** |
| **Запрещённые пути** | `backend/`, `frontends/`, `docker-compose.yml`, `docker/compose/overlay-gpu-hub-local.yml`, `docker/e2e/`, `tools/`, `gpu-hub-rebuild.sh` (X-1), все пакеты кроме `animastor-gpu-hub` |

```sh
# ⛔ REFUSE — §3.6 REJECTED при R-3 = A. Существующий GPU Hub не перезаписывается.
echo "REFUSE: §3.6 REJECTED (R-3 = A) — filter-repo gpu-hub НЕ ВЫПОЛНЯЕТСЯ" >&2
exit 1
# --- ниже только историческая запись варианта B; выполнение запрещено ---
test "$(git ls-files | wc -l)" -eq 44 || { echo "FAIL: 44 файла"; exit 1; }
test -z "$(git ls-files | grep -Ev '^(packages/animastor-gpu-hub/|scripts/check-artifacts\.sh$|docker/compose/overlay-gpu-hub-standalone\.yml$|docs/architecture/(GPU_HUB_CONTRACT|JOB_PROTOCOL_V2|PHASE_10[A-Z]?_)|LICENSE$)' || :)" || { echo "FAIL: чужие пути в gpu-hub-repo"; exit 1; }
echo "OK: gpu-hub no leak"
git log --follow --format='%h %ad %s' --date=short -- scripts/check-artifacts.sh
git log --follow --format='%h %ad %s' --date=short -- docs/architecture/GPU_HUB_CONTRACT.md
git log --follow --format='%h %ad %s' --date=short -- packages/animastor-gpu-hub
```
Глоб `PHASE_10[A-Z]?_` покрывает и `PHASE_10_GPU_HUB_…`, и `PHASE_10A…V_…`
(в т.ч. `PHASE_10O_GPU_HUB_REAL_STAGING_E2E_AUDIT`). Проверено: паттерн
защищает **все 44** файла, не попавшего в разрешённое множество — **0**.

---

## 4. Аудит идемпотентности и безопасности командного листа (§4.1)

Проверялось **read-only + на эталонном репо в `/tmp`** (мусорный репо, не монорепо).
Результаты — до внесения правок в §4.1.

| # | Что проверялось | Результат **до** правок | Фикс |
|---|---|---|---|
| **I-1** | Последовательность `clone` → `reset --hard $SRC` → `update-ref` → `filter-repo` | **FAIL (блокер).** `git reset --hard` создаёт **2-ю** запись в `.git/logs/HEAD` и `.git/logs/refs/heads/<branch>` (1-ю записал clone) → `git_filter_repo.sanity_check` падает: `Aborting: expected at most one entry in the reflog …` и требует запрещённого `--force` | в §4.1.0 добавлена строка `git reflog expire --expire=now --all` **до** `filter-repo` (альтернатива: `git clone -c core.logAllRefUpdates=false …` — `.git/logs` не создаётся вовсе). Проверено: после `reflog expire` все reflog'и = 0 entries, `WOULD ABORT: False` |
| **I-2** | Строгие контроли `test … && echo OK` под `set -e` | **FAIL (скрытый провал).** `test` в `&&`-списке **исключён** из `set -e`: падающий контроль не останавливает и не печатает ничего, следующая строка выполняется. Доказано: `bash -c 'set -e; test 1 -eq 2 && echo YES; echo end'` → печатает `end`, exit **0** | все контроли переведены на `… \|\| { echo "FAIL: …"; exit 1; }` + отдельный `echo OK` |
| **I-3** | Повторный запуск / существующий каталог `$SPLIT/<repo>` | **FAIL.** Без `set -e` на `clone` (каталог занят) `cd` падает молча, и все следующие команды выполняются **не в том каталоге** — в т.ч. `git filter-repo` | добавлен guard `test ! -e "$SPLIT/<repo>" \|\| { echo "REFUSE: …"; exit 1; }` **до** `clone`; backup — `test ! -e "$BK"` |
| **I-4** | `BRANCH` / `$SRC` фиксированы и согласованы | **Частично.** `$SRC` не сверялся с `$BARE`; не было защиты от `BRANCH=master` | добавлены `rev-parse "$SRC^{commit}"`, `merge-base --is-ancestor "$SRC" "$BRANCH"`, `test "$BRANCH" != master` |
| **I-5** | Источник не изменён после каждого репо | **Частично** — `BEFORE`/`AFTER` через `test && echo` (см. I-2) | переведено на `\|\| { FAIL; exit 1; }` |
| **I-6** | Версия `git-filter-repo` | **Неверифицируемо.** `git filter-repo --version` печатает хеш сборки `a40bce548d2c`, **не** `2.47.0` | проверка через метаданные пакета: `python3 -c "… m.version('git-filter-repo')=='2.47.0'"` (факт: pip-версия **2.47.0**) |
| **I-7** | Backup монорепо | **Уязвимо.** `$SPLIT/backup-animastor.git` = `/tmp`, **volatile** и **тот же FS `/`**, что P6-очистка | добавлен durable `BK=/home/animastor/backups/animastor-pre-split-64127b9e.git` (≈38M); `/tmp` остаётся только рабочим каталогом клонов |
| **I-8** | `--force` / `--path-rename` | **PASS** — в листе отсутствуют (подтверждено grep'ом) | без изменений; явно запрещено в §4.1.6 |
| **I-9** | URL push | **PASS** — только `github.com/Animastor/…` | без изменений |
| **I-10** | Пининг `--path` | **PASS** — 116 исполняемых `--path` = §8 минус 3 задокументированных исключения | без изменений |
| **I-11** | Порядок `symbolic-ref HEAD` | **Замечание.** Выполняется **после** push → до этого bare `$NEWBRANCH` вне зависимости от HEAD корректен (hook не читает HEAD), но лучше **до** push | перенесено перед `git push` |
| **I-12** | Разводка `master` vs `main` | **Двусмысленность.** §FPSG.5 Этап 1 → default branch `master`; `$NEWBRANCH=main`; триггеры §B9.2 → `main` | зафиксировано: имя ветки = **только** `$NEWBRANCH`, сверяется владельцем с hook'ами P1 до первого push |
| **I-13** | Per-repo leak-чек | **Неполный.** backend — только `^(frontends\|tools)/`; остальные — по 1 короткому паттерну; web не проверял `docs/`-подмножества | добавлены полные паттерны §3.2–§3.6 (все проверены: 0 leak на симулированных 1045/349/217/58/44) |
| **I-14** | `git log --follow` | **Нет команд.** §8.6 перечисляет файлы, но не команды и не per-repo scoping | добавлены §3.2–§3.6 (все 13 путей существуют и логируются на `$SRC`) |
| **I-15** | Ожидаемое число коммитов | **Не задано** — `git log --oneline \| wc -l ≠ 0` ничего не гарантирует | добавлены точные ожидания (§3.1) |
| **I-16** | **remote `github` в новых bare** | ~~**BLOCKER**~~ → **СНЯТ (2026-10-04).** Первоначально: ни один документ не содержал `git remote add github`, а `post-receive` делает `git push --mirror github` → «no such remote» на первом push. **Исправлено на стадии подготовки bare:** во всех 4 новых bare `remote.github.url = git@github.com:Animastor/<name>.git` настроен **до** push (проверено `git config --get remote.github.url`) | **ГОТОВО:** remote добавлен 2026-10-04; чеклист **GO-04 = READY**; hook byte-identical (GO-03) |
| **I-17** | **Пустота целевых GitHub-репозиториев** | **BLOCKER.** README/LICENSE/`.gitignore` при создании → первый push = non-fast-forward → нужен **запрещённый** force-push | зафиксировано требование «пусто»: `size=0`, `pushed_at=null`, `default_branch=""` (pre-split-go-blockers §2.1, чеклист GO-01) |
| **I-18** | **Push-права SSH-ключа на новые репо** | **BLOCKER.** hook ходит ключом `~/.ssh/github_ed25519` (читает org — проверено, `HEAD=64127b9e`); при создании репо **другим** аккаунтом mirror будет отклонён | закрывается созданием репо **этим же** GitHub-аккаунтом (pre-split-go-blockers §2.1) |

**Итог аудита:** до правок командный лист **не был пригоден к слепому
copy/paste-исполнению** (I-1 — гарантированный abort на первом же репо;
I-2 — контроли молчат при провале). После правок §4.1 каждый блок —
строгий, идемпотентный и самопроверяемый. Дополнительно аудит охватил **P1**:
там же найдены I-16 — I-18 (закрываются **до** первого push, а I-16 — до самого
первого push в новый bare).

---

## 5. Backup и rollback

### 5.1 Что сохраняется ДО первого destructive-действия (стадия B)

| Артефакт | Команда | Где | Что даёт |
|---|---|---|---|
| **Mirror-копия монорепо** | `git clone --mirror --no-local "$BARE" "$BK"` с `$BK=/home/animastor/backups/animastor-pre-split-64127b9e.git` | `/home/animastor/backups/` (durable, тот же FS, но вне `/tmp`) | полный откат: `$BARE` **вообще не пишется** на стадиях C/D для backend/web/android/worker, но backup страхует от случайной записи на стадии D и от сбоя диска — **СОЗДАН 2026-10-04** (**22 431 724 B**, `$SRC` внутри, `fsck` чисто, restore-дрилл пройден; refs **6/6 на момент создания** — `master`, `tmp/parser-audit-backup`, docs-ветка + `refs/remotes/github/*`; **после создания docs-ветка в `$BARE` законно продвигается** каждым docs-only коммитом → фактический контроль = `master`/`tmp/parser-audit-backup` дословно + `$SRC` в backup, см. §9.2; `--no-local`, т.к. обычный локальный clone хардлинкует pack'и и не даёт независимой копии) |
| **`$BARE` нетронут** | `BEFORE=$(git -C "$BARE" for-each-ref … \| sort)` → сверка `AFTER` после каждого репо | монорепо | доказательство неизменности; при расхождении — **стоп** — **СНЯТО НА ДИСК 2026-10-04**: `backups/before-split-64127b9e-refs/animastor.git.refs.txt` (+ HEAD/config/count-objects/hook sha256, `MANIFEST.sha256`) |
| **Реестр refs на момент старта** | `git -C "$BARE" for-each-ref` сохранён в `BEFORE` | переменная сессии | тот же контроль — **дублирован файлом snapshot'а** (работает и после перезапуска сессии) |
| **Snapshot GPU Hub (R-3 = A)** | `git -C /home/animastor/repos/animastor-gpu-hub.git for-each-ref` → `backups/before-split-64127b9e-refs/animastor-gpu-hub.git.refs.txt` | `backups/` (только чтение) | **2 refs, `master = HEAD = 7c7778c6…`** — доказательство, что существующий GPU Hub не менялся; сам GPU Hub **не клонируется и не пишется** |
| **GPU Hub** | — (не выполняется) | — | **NOT APPLICABLE при R-3 = A**: существующий GPU Hub bare/GitHub **никогда не пишется** → mirror-backup и заморозка hook ему не нужны. Строка «R-3=B» удалена как неприменимая (`repository-split-r3-decision.md` §2) |
| **Текущий tip ветки документации** | `git rev-parse HEAD` | в логе старта | восстановить docs-ветку |

Факт: bare монорепо **38M** (`34 143 255 B`), bare GPU Hub **408K** →
mirror-backup монорепо ≈ **38M** (в P6-бюджете учитывается, цифра «73M» в §P6
— это размер `.git` рабочего чекаута, оценка консервативна).

### 5.2 Rollback-процедуры

| Ситуация | Действие |
|---|---|
| **До стадии C** | откат = ничего не делать; `$BARE`, GPU Hub, hook'и не тронуты. Удалить `rm -rf "$SPLIT"` (только рабочие клони) |
| **`filter-repo` abort на репо N** | **не** `--force`; `rm -rf "$SPLIT/<repo>"` → устранить причину (см. §4) → повторить с чистого `clone`. Остальные репо не тронуты — очередь можно продолжить с места остановки |
| **Репо N уже pushнут, но проверки красные** | push идёт в **новый** пустой bare → `rm -rf "$NEW"; mkdir` заново (или `git push --delete` в новом bare) и повторить. Монорепо и GitHub не затронуты, пока hook не отmirror'ил в GitHub |
| **Backend-репо готов, ошибка в web** | независимые репо (§FINAL SPLIT HANDOFF §4: «шаги 1–4 независимы») — backend остаётся, web пересоздаётся |
| ~~**R-3=B: GPU Hub после force-push**~~ | **NOT APPLICABLE при R-3 = A** — force-push в GPU Hub не производится, откат не нужен; строка удалена как неприменимая (`repository-split-r3-decision.md` §1.1 п.4) |
| **Полный откат монорепо** | `git -C "$BK" fetch "$BK" '+refs/*:refs/*'` в `$BARE` — **только если** доказано расхождение `BEFORE`/`AFTER`; сам факт расхождения = критический инцидент |
| **После split (freeze)** | `master` архив-монорепо **не удаляется**; новый bare становятся источником для compose/nginx (B11 cutover) |

**Правило отката:** любая откатная команда, пишущая в `$BARE`, существующий
GPU Hub bare или GitHub, — **staged action**: требует письменного подтверждения
владельца, как и сама стадия C.

---

## 6. GO-чеклист перед первым `git filter-repo`

**Все пункты обязательны. Один FAIL = не запускать.**

| # | Пункт | Как проверить | Ожидание | Статус на момент записи |
|---|---|---|---|---|
| **G-A** | Frozen source зафиксирован | `git rev-parse 64127b9e…^{commit}` в `$BARE` | совпадает с `$SRC` | **READY** |
| **G-B** | `master` == source | `git -C $BARE rev-parse refs/heads/master` | == `$SRC` | **READY** (P2 CLOSED) |
| **G-C** | Рабочее дерево чистое | `git status --porcelain` | 0 строк | **READY** |
| **G-D** | `git-filter-repo` установлен | `python3 -c "import importlib.metadata as m; assert m.version('git-filter-repo')=='2.47.0'"` | без вывода, exit 0 | **READY** (2.47.0) |
| **G-E** | **P1** — 4 целевых репо + bare + hooks | `git ls-remote https://github.com/Animastor/animastor-backend.git` (×4) + наличие `$NEW` + `post-receive` | HTTP 200 (не 404), bare есть, hook есть **до** push | **PASS / CLOSED (2026-10-04)** — GitHub: 4 × 200 / 0 refs; VPS: 4 bare созданы (0 refs/0 objects, `HEAD=refs/heads/main`), `hooks/post-receive` **0755 / 91 байт / byte-identical** шаблону, remote `github` настроен → **I-16 закрыт**; **push не выполнялся** |
| **G-F** | **P6** — диск ≥5G | `df -B1 /` | avail ≥ 5 368 709 120 | **PASS (CLOSED, 2026-10-04)** — **6 839 934 976 B** (≈6.4 GiB) ≥ 5 368 709 120 → **1.27×**; историческое значение pre-cleanup **2 971 721 728 B — FAIL** (2026-10-03, только audit trail); значение колеблется — источник истины **команда**, не число; **очистка не выполнялась и не требуется** |
| **G-G** | **R-3** — вариант зафиксирован | решение владельца | записано явно | **READY = A (SELECTED)** — `repository-split-r3-decision.md`; B → REJECTED |
| **G-H** | Backup монорепо создан | `test -d "$BK" && git -C "$BK" rev-parse "$SRC"` | exit 0 | **PASS / CLOSED (2026-10-04)** — `$BK` создан `--mirror --no-local` (22 431 724 B), `rev-parse $SRC` = `$SRC`, `fsck` чисто, refs **6/6 на момент создания** (`master`/`tmp/parser-audit-backup` == `$BARE` и сейчас; docs-ветка в backup — снимок момента создания), restore-дрилл пройден |
| **G-I** | ~~Backup/freeze GPU Hub~~ | — | — | **NOT APPLICABLE при R-3 = A** — пункт исключён из GO-условий (GPU Hub не пишется) |
| **G-J** | `$NEWBRANCH` сверён с hook'ами P1 | `grep` hook'а | имя совпадает | **PASS (2026-10-04)** — hook `post-receive` **не содержит имён веток** (только `git push --mirror github`) → сверять не с чем; фактическая сверка `$NEWBRANCH=main` = GitHub `default_branch=main` ×4 + `symbolic-ref HEAD=refs/heads/main` ×4 (**GO-05 = CLOSED**, owner-confirmation) |
| **G-K** | `$SPLIT` пуст / целевые каталоги отсутствуют | `test ! -e "$SPLIT/backend"` (и т.д.) | exit 0 | **READY** (`/tmp/split` отсутствует) |
| **G-L** | Whitelist не изменился | `git ls-tree -r --name-only $SRC \| wc -l` | 1635 | **READY** |
| **G-M** | `$BARE` не тронут (`BEFORE` сохранён) | `git -C $BARE for-each-ref \| sort` | сохранено в переменную; **после каждого репо** — сверка `AFTER` | **PASS (2026-10-04)** — сохранено **на диск**: `backups/before-split-64127b9e-refs/animastor.git.refs.txt` (6 refs) и `…/animastor-gpu-hub.git.refs.txt` (2 refs, `master=7c7778c6…`) + HEAD/config/count-objects/hook sha256 + `MANIFEST.sha256` (11/11 OK, только-чтение); **после каждого репо** — `diff` snapshot ↔ живые refs |
| **G-N** | **P1** — remote `github` в каждом bare (**I-16**) | `git -C "$NEW" config --get remote.github.url` | `git@github.com:Animastor/<name>.git` для всех 4 | **PASS / CLOSED (2026-10-04)** — 4/4 настроены до push (push не выполнялся) |
| **G-O** | **P1** — репозитории **пустые** + public (**I-17**, **I-18**) | `curl … /repos/Animastor/<name>`; `git ls-remote` (GitHub и `git -C $NEW ls-remote github`) | **`size=0` и 0 refs**, `private=false`, `default_branch=main` (`pushed_at`/`default_branch=""` — устаревшие критерии, см. go-blockers §2.1) | **PASS / READY (2026-10-04)** — GitHub: 4 × 200, `size=0`, **0 refs**, `private=false`; новые bare: **0 refs / 0 objects**; **push не выполнялся** → **I-17** подтверждён, **I-18** SSH read rc=0 |
| **G-P** | **P1** — hook 91 байт, 0755, до первого push | `test -x "$NEW/hooks/post-receive" && test "$(wc -c < "$NEW/hooks/post-receive")" -eq 91` | совпадает с §2.2 pre-split-go-blockers | **PASS / CLOSED (2026-10-04)** — 4 × `0755 / 91 байт`, `cmp` байт-в-байт с шаблоном (sha256 `6a63cb14…`); **до** первого push |

**Сейчас (перепроверка 2026-10-04):** **G-E / G-H / G-J / G-M / G-N / G-O /
G-P = PASS** (P1 закрыт, P6 = PASS, стадия B выполнена: backup + BEFORE-snapshot),
**G-F = PASS** (6 781 632 512 B ≥ 5G на момент backup), **G-G = READY
(R-3 = A)**, **G-I = NOT APPLICABLE**, **G-A…G-D, G-K…G-L = READY** →
**все пункты чеклиста §6 выполнены, НО GO НЕ установлен автоматически**:
стадия C (первый `git filter-repo`) требует **отдельной авторизации владельца**.
Детальная раскладка P1 / P6 и сквозной чеклист GO-01…GO-15 —
`repository-split-pre-split-go-blockers.md` §2–§7; решение R-3 —
`repository-split-r3-decision.md`.

---

## 7. Найденные дефекты документации и их disposition

Правки внесены **одним docs-only commit'ом** (только `docs/architecture/*.md`).

| # | Где | Дефект | Disposition |
|---|---|---|---|
| **E1** | `repository-split-next-blockers.md` §FINAL SPLIT HANDOFF §1, §5, §5.1, §6, §9 | стейл lock-счётчики: реально **34** `package-lock.json` (не 33); backend-домен **16** lock'ов / 16 манифестов (не 15); `packages/animastor-ai-analysis/package-lock.json` **существует** (добавлен `6798d786`) — строка «отсутствует» неверна; «4 из 15» → «4 из 16»; «остальные 27 локов» (§6 п.4) → **28**; итог «15» → «16»; «Изменён только next-blockers» (§9) уже не верно с `5c34de54` | исправлено; **исторические** числа в §FPSG / §TECHNICAL CLOSURE на прошлых SHA не тронуты |
| **E2** | §5.5 `root layout` | `packages/animastor-gpu-hub/ (15)` → реально **19** файлов (1+1+22+19+1 = 44 ✓, +`gpu-hub-rebuild.sh` = 45 ✓) | исправлено |
| **E3** | §4.1.1–§4.1.5 | контроли advisory-only (`test && echo` не абортит, см. I-2); reflog-блокер I-1; нет guard'ов повторного запуска | исправлено в §4.1 |
| **E4** | §FPSG.5 Этап 1 vs `$NEWBRANCH` | `master` (default branch) против `main` (матрица §B9.2) | зафиксировано: имя ветки = только `$NEWBRANCH`, сверяется с hook'ами (I-12) |
| **E5** | per-repo leak-чек | паттерны неполные; web не проверял `docs/` | добавлены полные паттерны §3.2–§3.6 |
| **E6** | §8.6 | файлы «нельзя потерять» без команд и без per-repo scoping (не все существуют в каждом репо) | добавлен §3.2–§3.6 (13 путей, все логируются) |
| **E7** | §4.1.0 backup | `/tmp/split/backup-animastor.git` — volatile + тот же FS `/`, что P6-очистка | добавлен durable `BK` в `backups/` (I-7) |
| **E8** | §4.1.0–4.1.5 | не задано поведение повторного запуска | добавлены guard'ы (I-3) |
| **E9** | §4.1.0 | `git-filter-repo --version` не даёт `2.47.0` (печатает `a40bce548d2c`) | проверка через метаданные пакета (I-6) |
| **E10** | handoff §3 P1 | «существующий `animastor-gpu-hub` … 43 коммита» — подтверждено: bare `refs/heads/master` = `7c7778c`, `refs/remotes/github/master` = `7c7778c` (синхронизированы; doc-утверждение `b95870f` устарело) | исправлено |
| **E11** | §P6 / чек-лист §10 п.5 | числа 2.8G / 2.9G / 2.96 GB расходятся (и колеблются в течение дня) — **все исторические, до очистки** | авторитетно final-gate §1/§4 + команда `df -B1 /`; с **2026-10-04** P6 = **CLOSED/PASS** (**6 839 934 976 B ≥ 5G**), значения ниже 5G сохранены только как audit trail |
| **E12** | §FPSG.5 Этап 0 | destructive-шаги (`branch -D`, `push --delete`, `rmdir`, `pip cache purge`) смешаны с read-only | явное разделение стадий A/B/C/D (§2) |
| **E13** | §4.1.1–4.1.5 | `symbolic-ref HEAD` после push | перенесено перед push (I-11) |
| **E14** | final-gate §0 / §6, handoff §1 | после source изменены **2** файла; с этим документом — **3** | исправлено (final-gate §0, §6) |
| **E15** | final-gate §0 / §6, handoff §1 | «tip = source + 5 doc-коммитов» и список `5c34de54…e768a7cc` устарел | исправлено: **7**, источник истины — `git rev-list --count 64127b9e…HEAD` |
| **E16** | P1 (§FPSG §3, final-gate §4, handoff §3) | ~~не задано **действие** в новых bare~~ → **исправлено:** `git remote add github` задан в плане и **фактически выполнен 2026-10-04** во всех 4 bare → hook падать не будет | **CLOSED:** I-16 + P1-план (pre-split-go-blockers §2.1/§2.3, G-N, **GO-04 = READY**) |
| **E17** | P1 | не задано требование **пустого** репозитория → риск non-fast-forward и запрещённого force-push | добавлено I-17 + проверки `size=0 / pushed_at=null / default_branch=""` (G-O, GO-01) |
| **E18** | P1 / §4.1.1–§4.1.4 | не указана **visibility** целевых репо, при этом командные проверки идут `git ls-remote https://…` **без** credentials → при private репо дали бы ложный FAIL | зафиксировано **public** (консистентно с `Animastor/animastor` и `animastor-gpu-hub`) + I-18 (G-O, GO-01) |
| **E19** | §6 чеклист | P1 был одной строкой G-E; P6/R-3 — одной; не было пунктов про remote `github`, пустоту репо, hook-размер и фиксацию refs монорепо до/после | добавлены G-N…G-P; сквозной чеклист GO-01…GO-15 — pre-split-go-blockers §6 |
| **E20** | весь split-план (этот документ, final-gate, next-blockers, pre-split-fixes, pre-split-go-blockers, prep-plan §8.5) | R-3 был **UNDECIDED / OWNER DECISION** → в документах параллельно жили **исполняемые** описания варианта B (force-push в существующий GPU Hub, mirror-backup, заморозка hook) | **R-3 = A зафиксирован, B = REJECTED**: все B-ветки помечены N/A/REJECTED, step 5 исключён из очереди, `G-I`/`GO-09` сняты, постоянные запреты — `repository-split-r3-decision.md` §3.1 |

---

## 8. Verification log (read-only — что реально выполнено здесь)

| Проверка | Команда | Результат |
|---|---|---|
| Tracked files на `$SRC` | `git ls-tree -r --name-only $SRC \| wc -l` | **1635** |
| Commits / merges / tags | `git rev-list --count $SRC` / `--merges` / `--tags` | **1653 / 0 / 0** |
| Per-repo file counts | `git ls-tree -r --name-only $SRC -- <§4.1.x paths>` | **1045 / 349 / 217 / 58 / 44** ✓ |
| Per-repo commit counts | `git rev-list --count $SRC -- <§4.1.x paths>` | **1267 / 275 / 107 / 24 / 37** ✓ |
| Первый коммит per-repo | `git log --reverse --format=%s $SRC -- <paths>` | 5 значений §3.1 ✓ |
| Lock'и / манифесты | `git ls-tree … \| grep -c 'package-lock.json$'` | **34 / 34**; backend-домен **16/16**; `ai-analysis/package-lock.json` **существует**, 0 относ. записей |
| Leak-паттерны | `grep -cE/<allowed>` по симулированным 1045/349/217/58/44 | **0 / 0 / 0 / 0 / 0** ✓; web `docs/`-подмножество — **CLEAN** |
| `--follow`-пути | `git log --format=%h -n1 -- <13 путей>` | все существуют ✓ |
| reflog-блокер | эталонный репо: `clone` → `reset --hard` → `git for-each-ref`/reflog | **2 entries → WOULD ABORT**; после `git reflog expire --expire=now --all` → **0 entries, WOULD ABORT: False** |
| альтернатива | `git clone -c core.logAllRefUpdates=false …` → `reset --hard` | `.git/logs` не создаётся; `reflog expire` exit **0** |
| `set -e` + `test &&` | `bash -c 'set -e; test 1 -eq 2 && echo YES; echo end'` | печатает **`end`**, exit **0** → контроли advisory-only |
| Версия filter-repo | `pip`-метаданные / `git-filter-repo --version` | **2.47.0** / `a40bce548d2c` |
| Диск | `df -B1 /` | **2026-10-04: avail 6 839 934 976 B (≈6.4 GiB) → P6 PASS/CLOSED**; историческое (2026-10-03): 2 971 721 728 B → FAIL; значение колеблется, источник истины — команда; **очистка не выполнялась и не требуется** |
| Размеры | `du -sb` | `$BARE` **34 143 255 B**, GPU Hub bare **408K**, `.git` чекаута **74M** |
| Статус GPU Hub | `git show-ref` в `animastor-gpu-hub.git` | `master` = `7c7778c`, `github/master` = `7c7778c` (синхронизированы) |
| Каталоги | `ls -d /tmp/split` | **отсутствует** → ничего не исполнялось |
| Запрещённые операции | grep по §4.1 | `--path-rename` **нет**, `--force` **нет**, URL только `github.com/Animastor/` |

### 8.1 Стадия B и GO-05 (2026-10-04, эта ревизия)

| Проверка | Команда | Результат |
|---|---|---|
| `NEWBRANCH` | `grep -c NEWBRANCH docs/architecture/repository-split-next-blockers.md` + API/`symbolic-ref` | одна переменная `main`; GitHub `default_branch=main` ×4; `symbolic-ref HEAD=refs/heads/main` ×4 → **GO-05 = CLOSED** (owner-confirmation записан в pre-split-go-blockers §7.1) |
| hook не знает веток | `grep -c 'main\|master\|NEWBRANCH' hooks/post-receive` | **0** → G-J сверяется с GitHub/bare, а не с hook'ом |
| backup создан | `git clone --mirror --no-local $BARE $BK` | `$BK = /home/animastor/backups/animastor-pre-split-64127b9e.git`, **22 431 724 B** |
| backup содержимое | `rev-parse $SRC` / `rev-list --count` / `ls-tree \| wc -l` | `64127b9e…` / **1653** / **1635** |
| backup целостность | `git -C $BK fsck --no-progress` | чисто |
| backup ↔ `$BARE` refs | `diff` `for-each-ref` | **IDENTICAL (6/6) на момент создания backup** — аудит 2026-10-04: `master=64127b9e`, `tmp/parser-audit-backup=db5ff61f` по-прежнему **дословно** совпадают, а docs-ветка в `$BARE` (`0194684e` → `40f09946` → …) продвинулась **только** docs-only коммитами → ожидаемо; **не** является invariant'ом (см. §9.2) |
| независимость копии | `ls -i …/*.pack` (inode'ы `$BK` ↔ `$BARE`) | **0 общих inode'ов** (`--no-local`; обычный локальный clone хардлинкует — проверено на тестовом клоне) |
| restore-дрилл №1 | `git init --bare /tmp/… && git fetch $BK '+refs/*:refs/*'` | refs IDENTICAL, `fsck` чисто, `master=64127b9e` |
| restore-дрилл №2 | `git clone --single-branch --branch master $BK /tmp/…/wt` | `HEAD=64127b9e`, `status` 0, **1635** файлов; временные каталоги удалены |
| `$BARE` после backup | `rev-parse master`, `for-each-ref`, `count-objects` | `64127b9e`, 6 refs, `count 1743 / packs 4 / size-pack 22797` — **не изменился** |
| BEFORE-snapshot | `for-each-ref` двух bare → `backups/before-split-64127b9e-refs/` | `animastor.git` 6 refs (`master=64127b9e`), `animastor-gpu-hub.git` 2 refs (**`master=HEAD=7c7778c6f313dad19eb403d8509cd297226ec7ea`**); `MANIFEST.sha256` **11/11 OK**; файлы 0444, каталог 0555 |
| GPU Hub | `rev-parse refs/heads/master` в `animastor-gpu-hub.git` | `7c7778c6…` — **не создавался, не фильтровался, не пушится** |
| 4 новых bare / GitHub | `for-each-ref`, `count-objects`, `ls-remote` | **0 refs / 0 objects** локально; GitHub **0 refs**, `size=0` |
| hooks/remote | `sha256sum` hook'ов, `config --get remote.github.url` | `6a63cb14…` у всех 6 bare (монорепо/GPU Hub — mtime не менялись); remote `github` на месте |

---

## 9. FINAL PRE-SPLIT AUDIT (2026-10-04, read-only, `40f09946`)

> Аудит выполнялся **только** read-only-командами (`rev-parse`, `ls-tree`,
> `rev-list`, `for-each-ref`, `merge-base`, `fsck`, `count-objects`, `df`,
> `ls-remote`, GitHub API GET, `python3 -c`-метаданные, чтение исходника
> `git_filter_repo.py`, `npm view`, `bash -n` по извлечённым блокам листа).
> **`git filter-repo` НЕ запускался** (в т.ч. на эталонном репо), **push/force-push
> НЕ выполнялись**, `master`, GPU Hub, hook'и и 4 новых bare/GitHub **не менялись**;
> backup и BEFORE-snapshot **проверялись, не пересоздавались**.

### 9.1 GO-01…GO-15 — фактическая перепроверка

| GO | Команда (факт) | Результат 2026-10-04 | Статус |
|---|---|---|---|
| **GO-01** | GitHub API GET ×4 + `git ls-remote git@…` ×4 | **4 × HTTP 200**, `size=0`, **0 refs**, `default_branch=main`, `private=false` (`pushed_at` 2026-10-03T23:53–23:55Z) | **PASS** |
| **GO-02** | `for-each-ref` / `count-objects` / `symbolic-ref` ×4 | **0 refs / 0 objects**, `HEAD=refs/heads/main` ×4 | **PASS** |
| **GO-03** | `stat -c %a`, `wc -c`, `sha256sum` hook'ов ×6 | **0755 / 91 байт / `6a63cb14…`** у всех 4 новых bare (и у монорепо + GPU Hub — не менялись) | **PASS** |
| **GO-04** | `config --get remote.github.url` ×4 | `git@github.com:Animastor/<name>.git` ×4 (до push; зеркалирование проверяется при первом push) | **PASS** |
| **GO-05** | `grep -rho 'NEWBRANCH=…' docs/architecture/` + API + `symbolic-ref` | **19** вхождений, значение **единственное — `main`**; `default_branch=main` ×4; `HEAD=refs/heads/main` ×4 | **CLOSED** |
| **GO-06** | `df -B1 /` | **6 737 682 432 B ≥ 5 368 709 120** = **1.25×** (замер на момент backup — `6 839 934 976 B` = 1.27×; значение колеблется, источник истины — команда) | **PASS** |
| **GO-07** | `grep 'R-3 = [AB]'` по `repository-split-r3-decision.md` | **A = SELECTED (3)**, B = REJECTED (2) — решение не менялось | **READY** |
| **GO-08** | `test -d $BK` · `rev-parse $SRC` · `fsck` · `du` · inode'ы · `git archive` | существует, **22 431 724 B**, `$SRC` = `64127b9e`, **fsck чисто**, 1653 коммита / 1635 файлов, **0 общих inode'ов** с `$BARE`, `git archive $SRC` = **29 716 480 B** (restore viable) | **CLOSED** |
| **GO-09** | — | **NOT APPLICABLE** (R-3 = A: GPU Hub не пишется) | **N/A** |
| **GO-10** | `rev-parse` в worktree / `origin/master` / bare | **`64127b9e` = `64127b9e` = `64127b9e`**; frozen SHA существует в `$BARE` (`merge-base --is-ancestor $SRC HEAD` = YES) | **PASS** |
| **GO-11** | `git status --porcelain` | **0 строк** (ветка `c21.4-…`, tip `40f09946`, +13 doc-коммитов после `$SRC`) | **PASS** |
| **GO-12** | `importlib.metadata.version('git-filter-repo')` | **2.47.0**, исполняемый `/home/animastor/.local/bin/git-filter-repo` существует | **PASS** |
| **GO-13** | `test ! -e /tmp/split` | **отсутствует** → ничего не исполнялось | **PASS** |
| **GO-14** | snapshot: `sha256sum -c MANIFEST` + сверка refs/HEAD/config/hooks | **11/11 OK**; 4 неизменяемые refs монорепо == snapshot дословно; GPU Hub 2/2 == snapshot; `HEAD`/`config`/hook sha == live; число refs 6/6; docs-ветка — fast-forward (см. §9.2) | **CLOSED** |
| **GO-15** | `merge-base --is-ancestor $SRC $BRANCH` · `ls-tree -r --name-only $SRC \| wc -l` · `ls-remote` | **YES** · **1635** · monorepo `HEAD = 64127b9e` (SSH read rc=0); whitelist 1635/1635 | **PASS** |

**Итог: GO-01…GO-15 — все PASS / READY / CLOSED / N/A. BLOCKER'ов в GO-чеклисте
нет.** GO устанавливаются владельцем отдельно — стадия C этим аудитом **не**
авторизована.

### 9.2 Backup, BEFORE-snapshot, GPU Hub (проверено, не пересоздавалось)

| Артефакт | Проверка | Результат |
|---|---|---|
| `$BK` (GO-08) | `fsck` / `rev-parse` / `for-each-ref` / inode'ы / `git archive` | **PASS**: fsck чисто, `$SRC` внутри, 6 refs, 0 общих inode'ов, restore viable. **Замечание:** refs backup = снимок **момента создания** (`docs-ветка = 0194684e`), `$BARE` имеет более новый docs-tip → `master` и `tmp/parser-audit-backup` (4 неизменяемые refs) **совпадают дословно**, расходится **только** docs-ветка (docs-only коммиты). Это **не** invariant — формулировки «refs == `$BARE`» в документах заменены на «6/6 на момент создания» |
| `$SNAP` (GO-14) | `sha256sum -c` + `diff` с live | **PASS**: `MANIFEST` 11/11; immutable refs `64127b9e` / `db5ff61f` (+ github-дубли) == live; GPU Hub 2/2 == live; `count-objects`, `config`, `HEAD`, hook sha256 == live. **Переснят после docs-push этого же этапа** (docs-ветка `0194684e → 40f09946`, `pre_refresh:` сохранён в `SNAPSHOT.txt`); **второй пересчёт не требуется** — сверка §4.1.0 переведена на `check_bare_snapshot` (immutable дословно + docs-ветка только fast-forward), иначе каждый docs-коммит давал бы ложный FAIL |
| GPU Hub (R-3 = A) | bare + GitHub read-only | bare `HEAD = refs/heads/master = 7c7778c6…`; GitHub **HTTP 200**, `default_branch=master`, `size=105`, `pushed_at=2026-09-06T18:07:10Z`; `ls-remote` → `HEAD`/`refs/heads/master` = **`7c7778c6…`**. **FINDING-1 (не блокер):** на GitHub есть **третий** ref `refs/remotes/github/master = b95870f7…` (артефакт старого mirror-push; `b95870f7` — предок `master`), а в локальном bare этот remote-tracking ref = `7c7778c6…`. При R-3 = A **ничего не делаем**: GPU Hub не пишется никогда; на split не влияет. Зафиксировано для владельца |

### 9.3 Execution-plan dry-run matrix (BEFORE → filter-repo → AFTER)

Все числа **пересчитаны на `$SRC`** теми же pathspec'ами, что в §4.1.x
(`git ls-tree -r --name-only $SRC -- <paths>` / `git rev-list --count $SRC -- <paths>`).

| Repo | BEFORE (`$SRC`) | filter-repo (§4.1.x) | AFTER — ожидание | Должно **отсутствовать** |
|---|---|---|---|---|
| **1. backend** | 35 `--path` → **1045** файлов · **1267** коммитов · корень `Recovery01: June 9 working state + dedup` | fresh `clone --no-local --single-branch` → `reset --hard $SRC` → `update-ref refs/remotes/origin/$BRANCH` → `reflog expire` → `filter-repo` **без `--path-rename`, без `--force`, без `--path workflow.json`** | `fsck` OK · `ls-files` = **1045** · leak = **0** · porcelain = 0 · корень тот же · `rev-list` = **1267** · 5 `--follow`-путей логируются · push `HEAD:refs/heads/main` → bare → hook → GitHub | `frontends/**`, `tools/**`, `packages/animastor-{worker,gpu-hub,web-*}`, `apk-build.sh`, `build-apk.sh`, `app-web-rebuild.sh`, `gpu-hub-rebuild.sh`, `ANDROID_WEB_PARITY.md`, `workflow.json`, `local.properties`, `package.json` (в `$SRC` их **нет**) |
| **2. web** | 31 `--path` → **349** · **275** · корень `docs: reorganize into topical structure …` | то же, **без** `--path-rename`; отсутствует корневой `.gitignore` → **создать сразу после extraction (§5.2)** | `ls-files` = **349** · leak = **0** · docs-subset CLEAN (**31** файл `docs/`, 0 лишних) · `rev-list` = **275** · 2 `--follow`-пути | `backend/`, `docker/`, `proxy/`, `scripts/`, `frontends/android/`, root-`*.md` кроме `LICENSE`/`ANDROID_WEB_PARITY.md`, `docker-compose.yml`, `.dockerignore`, `.env.example`, `.gitignore`, root-скрипты, `packages/animastor-{ai-…,assistant,auth,comfyui,contracts,editor,generation,gpu-hub,installer,orchestration,parser,player,url-safety,vbook,worker}`, прочий `docs/**` |
| **3. android** | 5 `--path` → **217** · **107** · корень `Recovery01: …` | то же, **без** `--path local.properties`; корневого `.gitignore` нет → **создать (§5.3)** | `ls-files` = **217** · whitelist-чек проходит · `rev-list` = **107** · 1 `--follow`-путь | **всё**, кроме `frontends/android/`, `apk-build.sh`, `build-apk.sh`, `ANDROID_WEB_PARITY.md`, `LICENSE` |
| **4. worker** | 19 `--path` → **58** · **24** · корень `docs(beta): private worker / gpu hub architectural reconnaissance` | то же; `.gitignore` → **создать (§5.4)** | `ls-files` = **58** · leak = **0** · `rev-list` = **24** · 4 `--follow`-пути | `backend/`, `frontends/`, `proxy/`, `scripts/`, `docker/` кроме `docker/worker`, `docker-compose.yml`, root-`*.md`, все пакеты кроме `animastor-worker`, `tools/`, `docs/**` вне whitelist |
| ~~5. gpu-hub~~ | — | **⛔ REJECTED (R-3 = A) — не исполняется** | — | — |

**Refs, которые должны появиться:** у **каждого** нового bare — ровно одна
`refs/heads/main` (`symbolic-ref HEAD` до push); после hook'а — та же одна
`refs/heads/main` в `Animastor/<name>` (mirror). Никаких `refs/heads/master`,
`refs/remotes/*`, `refs/tags/*` — push идёт **одним явным refspec'ом**
`HEAD:refs/heads/main`, mirror в bare содержит только то, что в него запушили.

### 9.4 Coverage / overlaps (намеренные дубли, коллизий нет)

| Проверка | Результат |
|---|---|
| Tracked на `$SRC` | **1635** |
| Union 4 целевых repo | **1615** уникальных; instance'ов **1669** (1045+349+217+58) → **54** дубля |
| Не покрыто ни одним repo | **20** = 19 файлов `packages/animastor-gpu-hub/` + `gpu-hub-rebuild.sh` (X-1) — **ровно** как задокументировано; они остаются **только** в замороженном монорепо (компонент живёт в существующем standalone-репо) |
| Пересечения (52 уникальных файла / 54 дубля) | `backend∩web` = **31** (`docs/05-frontend/*`, `docs/08-mobile-web-migration/*`, `docs/09-desktop-migration/*`, `docs/architecture/web-*`, `docs/architecture/ANDROID_WEB_PARITY.md`) · `backend∩worker` = **19** (`docker/worker/*` + 16 worker-доков) · `web∩android` = **1** (root `ANDROID_WEB_PARITY.md`) · **все 4** = **1** (`LICENSE`) |
| `packages/` — **30** подкаталогов | **каждый ровно у одного владельца**: 15 → backend, 13 → web, 1 → worker, 1 (`animastor-gpu-hub`) → исключён. **Ни один пакет не остался «без владельца» и не претендует на два repo** |
| `docs/` — **288** файлов | все попадают в backend (`--path docs`): 241 только backend, 31 + web, 16 + worker → **0 потерянных доков** |
| Root — **27** entry | покрыты все, кроме `gpu-hub-rebuild.sh` (X-1, по дизайну) |
| Общие файлы, требующие дублирования | `LICENSE` (4×), `ANDROID_WEB_PARITY.md` (root: web+android; `docs/architecture/`: backend+web), `docker/worker/*` (backend+worker) — **filter-repo без `--path-rename` кладёт один и тот же путь в оба repo**, ничего специального делать не нужно |
| **Опасное пересечение** (один путь → разный контент в разных repo) | **не обнаружено** |

### 9.5 Проверка командного листа (dry-run, без исполнения)

| Проверка | Результат |
|---|---|
| `bash -n` по извлечённым блокам §4.1.0 (2), §4.1.1–§4.1.4 (1+1+1+1) | **rc = 0** у всех **6** |
| Число `--path` в листе | **35 / 31 / 5 / 19 = 90** (R-3 = A) + **26** gpu-hub (REJECTED) — совпадает с §8 |
| Счётчики §3.1 на `$SRC` | **1045 / 349 / 217 / 58** и **1267 / 275 / 107 / 24** — **8/8 OK**; корни коммитов **4/4 OK** |
| Leak dry-run по вычисленным AFTER-наборам | **0 / 0 / 0 / 0**; web docs-subset **CLEAN** |
| 13 `--follow`-путей (§3.2–§3.5) | все существуют на `$SRC` и логируются (1–163 коммита на путь) |
| `--path-rename` / `--force` / чужие URL в листе | **отсутствуют** (grep) — запрет §2 соблюдён |
| Исходник `git_filter_repo.py` 2.47.0 | `RepoFilter.sanity_check` (стр. 3394–3515): 1 ровно remote `origin`, ≤1 записи в каждом reflog, packed-репо, для non-bare — `refs/remotes/origin/X` == `refs/heads/X` → **подтверждает** `reset` + `update-ref` + `reflog expire` в листе. `run()` → `_migrate_origin_to_heads()` (стр. 4878) → **`git remote rm origin`** (стр. 4463) → **`git remote add origin $NEW` после filter-repo легален** |
| Cross-repo npm-зависимости | `npm view` → **`@animastor/contracts@0.1.1`** и **`@animastor/gpu-hub@0.1.1` опубликованы** → devDependencies worker/backend резолвятся из registry после split (P3 касается только **publish**) |
| Новые guard'ы (внесены этой ревизией) | **(1)** `test -z "$(git -C $NEW for-each-ref)"` — первый push только в пустой bare (I-17); **(2)** `test "$(git remote get-url origin)" = "$NEW"` — защита от push **не в тот remote** (см. §9.6 D-1); **(3)** `check_bare_snapshot` вместо жёсткого равенства (D-10) |

### 9.6 Опасные моменты (§7) — disposition

| # | Риск | Disposition |
|---|---|---|
| **D-1** | **push не в тот remote.** Clone создаёт `origin` → `$BARE`; `filter-repo` его удаляет, но если блок §4.1.x выполнить **вне** `set -e` и удаление не сработает — `git remote add origin` молча провалится и `git push -u origin` уйдёт **в монорепо** | **ЗАКРЫТ guard'ом**: `test "$(git remote get-url origin)" = "$NEW"` перед push в каждом из 4 блоков + `set -euo pipefail` в §4.1.0 |
| **D-2** | push в непустой bare/GitHub → non-fast-forward → потребовался бы запрещённый force-push | GitHub **0 refs** подтверждено дважды (API + `ls-remote`); добавлен guard пустого bare; hook — обычный mirror (без `--force`) |
| **D-3** | потеря истории | counts/root/`--follow` пересчитаны на `$SRC`; расхождение AFTER-счётчика = **стоп** (лист abort'ит) |
| **D-4** | попадание чужих файлов | leak dry-run **0/0/0/0**; 20 «непокрытых» = только gpu-hub (по дизайну) |
| **D-5** | отсутствие общих файлов в новых репо | `LICENSE` дублируется во все 4; **gap: корневого `.gitignore` нет в web/android/worker** → сразу после extraction создать (§5.2–§5.4) — **write в новом репо, авторизуется владельцем на стадии C** |
| **D-6** | неправильный path-rename | `--path-rename` отсутствует → layout сохраняется, «два репо с разным контентом одного пути» невозможно |
| **D-7** | случайное включение GPU Hub | gpu-hub-шаг §4.1.5 = `exit 1` REFUSE; `packages/animastor-gpu-hub/` не входит ни в один `--path`; FINDING-1 (stray ref на GitHub) — **не блокер** |
| **D-8** | изменение `master` монорепо | ни одна команда листа не пишет в `$BARE`; §4.1.0 до/после каждого репо сверяет `master == $SRC` и refs со snapshot'ом |
| **D-9** | overwrite существующего GitHub-репо | целевые пустые (0 refs) — проверено; GPU Hub не пушится вообще (R-3 = A, запрет бессрочен) |
| **D-10** | **ложный FAIL GO-14**: жёсткое `diff` всех 6 refs со snapshot'ом падает после **каждого** docs-коммита (в т.ч. коммита этого аудита) | **ЗАКРЫТ**: `check_bare_snapshot` — неизменяемые refs дословно + число refs + **fast-forward** docs-ветки; GPU Hub остаётся строгим |
| **D-11** | refs backup отстаёт от `$BARE` по docs-ветке | ожидаемо (backup = снимок момента создания); формулировки в docs уточнены; `$SRC`/`master` в backup неизменны |
| **D-12** | `tmp/parser-audit-backup` попадёт в новые bare | push идёт **одним** refspec'ом `HEAD:refs/heads/main` → ветка не попадает; удаление — решение владельца (п.10 №9) |
| **D-13** | lock'и с `../../backend/...`-записями | 117 REL-записей в 6 локах → регенерация **после** split (§6); не условие split |
| **D-14** | `npm publish`/Release | P3 = E401 → **post-split** blocker, filter-repo не блокирует |

**BLOCKER'ов, требующих решения ДО стадии C (не технические):** авторизация
самой стадии C; **P5** — письменное подтверждение интерпретации workflows;
**P4** — гигиена (`rmdir workflow.json`, android-mount) как precondition §4;
решение по **`tmp/parser-audit-backup`**; (post-split) **P3** npm E401.
**Технических BLOCKER'ов не найдено.**

### 9.7 Очередь и первый шаг — **ВЫПОЛНЕН ДЛЯ BACKEND (2026-10-04)**

**Порядок:** `backend` → `web` → `android` → `worker` → smoke каждого репо →
freeze монорепо + cutover B11. Шаги 1–4 независимы (отдельные свежие клоны),
`gpu-hub` исключён (R-3 = A).

**Шаг 1 (backend) — ВЫПОЛНЕН** по `repository-split-next-blockers.md`
**§4.1.0 → §4.1.1**: clone → `reset --hard 64127b9e` → `update-ref` →
`reflog expire` → `filter-repo` (35 `--path`, RC=0) → fsck/1045/leak/clean/
root/1267 → `--follow` ×5 → guard'ы пустого bare и URL origin →
`push HEAD:refs/heads/main` **без `--force`** → hook mirror → `ls-remote`
GitHub → **bare == GitHub == `f83f929c732d8fc490bd150e72294d6b3c6e2f92`**.
Полный журнал, точные SHA, BEFORE/AFTER и parity — **§11**.

**Шаги 2–4 (web, android, worker) — НЕ ВЫПОЛНЯЛИСЬ**: требуют отдельной
авторизации владельца. **Шаг 5 (gpu-hub) — REJECTED (R-3 = A), не исполняется.**

---

## 10. Что НЕ выполнялось (остаётся NOT EXECUTED)

**PHYSICAL SPLIT для web / android / worker: NOT EXECUTED.**
**git filter-repo для web / android / worker / gpu-hub: NOT EXECUTED.**
**force-push: NOT EXECUTED ни для одного репозитория.**
**`--path-rename`: NOT EXECUTED.**
**`Animastor/animastor-gpu-hub` / bare `animastor-gpu-hub.git`: NOT MODIFIED ·
hooks: NOT MODIFIED · `master` монорепо: NOT MODIFIED · npm publish: NOT EXECUTED ·
backup / BEFORE-snapshot / `tmp/parser-audit-backup`: NOT MODIFIED.**

Этот документ **не выполнял** и **не авторизует**: создание репозиториев (P1;
4 пустых GitHub-репо созданы владельцем 2026-10-03, 4 VPS bare + hook + remote —
подготовительной ревизией 2026-10-04), очистку диска (**не требуется: P6 закрыт
без очистки**), выбор R-3 (решён ранее: A), `--path-rename`, force-push,
изменение `master`, hook'ов, production-кода и B7-тестов, регенерацию текущих
monorepo lock-файлов, удаление `tmp/parser-audit-backup`, `npm publish`,
split web/android/worker (шаги 2–4) и gpu-hub (§4.1.5 = REJECTED).

**Выполнено подготовительными ревизиями (стадия B, 2026-10-04):** запись в
**новые** каталоги `backups/` — mirror-backup монорепо (GO-08) и BEFORE-snapshot
refs `animastor.git` + `animastor-gpu-hub.git` (GO-14), плюс owner-confirmation
`NEWBRANCH=main` (GO-05).

**Выполнено стадией C (2026-10-04):** **только backend** — см. **§11**.

---

## 11. Стадия C — `animastor-backend`: SPLIT / PUBLISHED (2026-10-04)

> Авторизация владельца: «НАЧАТЬ ФИЗИЧЕСКИЙ SPLIT BACKEND». Объём: **шаг 1/4**
> (`backend`). web / android / worker — **не выполнялись**; gpu-hub — §4.1.5
> REJECTED. Выполнены §4.1.0 (общий блок) + §4.1.1 (backend) командного листа
> дословно, включая все guard'ы и строгие `|| { echo "FAIL: …"; exit 1; }`-контроли.

### 11.1 Точные SHA

| Поле | Значение |
|---|---|
| Frozen source (`$SRC`) | **`64127b9e1dea2ac528a572b51b90a542b70c5ebb`** |
| Docs-tip монорепо до split (`BEFORE` docs-ветки) | **`4d07dd4e1214fd4596ea17d7b9b7169baee603a9`** |
| Docs-tip монорепо после этого docs-only коммита | `git rev-list --count 64127b9e…HEAD` (см. final-gate §0) |
| **`master` монорепо — до и после** | **`64127b9e…` (не изменился)** |
| `tmp/parser-audit-backup` — до и после | **`db5ff61f1079360cc848ff2fc131a12783bd97ad` (не удалён, не изменён)** |
| **Извлечённый backend `main` (bare == GitHub)** | **`f83f929c732d8fc490bd150e72294d6b3c6e2f92`** |
| Корневой коммит backend | **`6d12eed36c7221cf6f82bbe1e56892384fd421c3`** — «Recovery01: June 9 working state + dedup» |
| Корневой коммит монорепо (источник корня) | `380a777339a024451090de449cce28caf5d1db29` — тот же subject |
| Выживший rewrite, чье дерево == `$SRC`∩whitelist | `04da33ea0066e8f95b19d86ae28bc9e18c81eab2` → `f83f929c…` |
| GPU Hub (не трогался) | `master` = `HEAD` = **`7c7778c6f313dad19eb403d8509cd297226ec7ea`** |

### 11.2 Preflight GO-01…GO-15 (перед запуском, 2026-10-04)

Перепроверены **фактами**, не документацией — **все PASS / READY / CLOSED / N/A,
ни одного FAIL**:

| GO | Результат |
|---|---|
| GO-01 | GitHub API **4 × HTTP 200**, `size=0`, `private=false`, `default_branch=main`, `git ls-remote` = **0 refs** ×4 |
| GO-02 | 4 bare: **0 refs / 0 loose**, `HEAD=refs/heads/main` ×4 |
| GO-03 | 4 × `post-receive` = **0755 / 91 байт**, sha256 **`6a63cb14a1f76ca1a87de81cc54a1a46361ee11c224741fe3ea234d421a3130c`**, `cmp` с шаблоном монорепо → идентичны |
| GO-04 | `remote.github.url = git@github.com:Animastor/<name>.git` ×4 |
| GO-05 | `NEWBRANCH=main` (единственное присваивание во всех docs) + `default_branch=main` ×4 |
| GO-06 | `df -B1 /` → avail **6 703 718 400 B ≥ 5 368 709 120** (1.25×) |
| GO-07 | R-3 = **A (SELECTED)**, B = REJECTED (заголовок `repository-split-r3-decision.md`) |
| GO-08 | `$BK` существует, `rev-parse $SRC` OK, `fsck` чисто, **22 431 724 B** |
| GO-09 | NOT APPLICABLE (R-3 = A) |
| GO-10 | `master == $SRC == rev-parse($SRC)` = `64127b9e…` |
| GO-11 | `git status --porcelain` монорепо = **0 строк** |
| GO-12 | `importlib.metadata.version('git-filter-repo')` = **2.47.0**, бинарник исполняем |
| GO-13 | `/tmp/split` отсутствует (в т.ч. `backend`, `web`, `android`, `worker`, `gpu-hub`) |
| GO-14 | `MANIFEST.sha256` **11/11 OK**; 4 неизменяемые refs == snapshot дословно; число refs **6/6**; docs-ветка — fast-forward; GPU Hub refs == snapshot дословно |
| GO-15 | `merge-base --is-ancestor $SRC $BRANCH` = **YES**; whitelist = **1635**; `ls-remote Animastor/animastor.git HEAD` = `64127b9e…` |

### 11.3 Выполнение (§4.1.0 + §4.1.1)

1. Общий блок §4.1.0: guard'ы `$BK` / `$SNAP` / `check_bare_snapshot` /
   GPU Hub / `master == $SRC` — **все OK**; `BEFORE` сохранён на диск
   (`/tmp/split/.BEFORE.refs`, 6 refs).
2. **Свежий клон** `git clone --no-local --single-branch --branch $BRANCH
   /home/animastor/repos/animastor.git /tmp/split/backend` →
   `git reset --hard $SRC` → `git update-ref refs/remotes/origin/$BRANCH $SRC`
   → `git reflog expire --expire=now --all` (**reflog = 0 entries**, без неё
   sanity-check потребовал бы запрещённого `--force`).
   HEAD ровно **`64127b9e…`**, рабочее дерево чистое, один remote `origin`.
3. **`git filter-repo`** — ровно **35 `--path`** из §4.1.1, **без `--path-rename`,
   без `--force`, без `--path workflow.json`** → `RC=0`
   («New history written», «Completely finished»).
4. AFTER-проверки — §11.4.

### 11.4 AFTER-проверки backend — все PASS

| Проверка | Ожидание | Факт |
|---|---|---|
| `git fsck --no-progress` | чисто | **PASS** (0 ошибок) |
| `git ls-files \| wc -l` | **1045** | **1045 PASS** |
| leak-паттерн §3.2 (запрещённые пути) | **0** | **0 PASS** |
| `git status --porcelain` | пусто | **0 PASS** (clean) |
| исторический корень | `Recovery01: June 9 working state + dedup` | **PASS** |
| `git rev-list --count HEAD` | **1267** | **1267 PASS** |
| `git log --follow` ×5 (§3.2) | все логируются | **5/5 PASS** (1/2/1/2/3 коммита) |
| tracked set == whitelist §4.1.1 | побайтово | **IDENTICAL** (`diff` пуст при `core.quotepath=false`) |
| отсутствие `frontends/`, `tools/`, `packages/animastor-{worker,gpu-hub,web-*}` | 0 / 0 / 0 / 0 / 0 | **PASS** |
| отсутствие `apk-build.sh`, `build-apk.sh`, `app-web-rebuild.sh`, `gpu-hub-rebuild.sh`, `ANDROID_WEB_PARITY.md`, `workflow.json`, `local.properties`, root `package.json` | 0 ×8 | **PASS** |
| root layout (§3.2, 21 entry) | совпадает | **PASS** (`packages/` = ровно 15 backend-пакетов, `docs/` = **288**) |
| web/android/worker/GPU Hub файлы | отсутствуют | **0 PASS** (см. таблицу выше) |

### 11.5 Lineage от frozen source — ПОДТВЕРЖДЁН

| Проверка | Результат |
|---|---|
| `.git/filter-repo/ref-map` | `64127b9e…` → **`f83f929c…`** (`refs/heads/c21.4-…`) |
| Дерево `HEAD` vs `$SRC` ∩ 35-path whitelist | **`git ls-tree -r` обоих наборов идентичны** |
| Все 1267 «старых» SHA из `commit-map` — предки `$SRC` | **1267/1267 YES, 0 нарушений** |
| Все 1267 «новых» SHA существуют в извлечённом репо | **1267/1267 YES** |
| Корень: `380a7773…` → `6d12eed3…` | **PASS** (subject идентичен) |
| `$SRC` сам в `commit-map` | → `0000…` (**dropped**): `$SRC` менял **только** `packages/animastor-gpu-hub/tools/{g4-standalone-build,g5-artifact-integrity,standalone-fixture}.*` — **вне** backend-whitelist → после фильтрации коммит пустой. `git diff --name-only 04da33ea $SRC -- <35 paths>` = **0 файлов** → вклад `$SRC` в backend-дерево ровно **0**, содержимое = `$SRC`∩whitelist. Это **ожидаемое** поведение `--empty=drop`, а не потеря истории |
| Число dropped (пустых после фильтрации) | **386** из 1653 → **1267 сохранено** = точному `git rev-list --count $SRC -- <35 paths>` |

### 11.6 Bare до push / push / hook

| Проверка | Ожидание | Факт |
|---|---|---|
| `refs` в `$NEW` **до** push | **пусто** (I-17) | **0 refs, 0 objects PASS** |
| `symbolic-ref HEAD $NEW` | `refs/heads/main` **до** push | **PASS** |
| hook | 0755 / 91 байт / byte-identical | **PASS** (`6a63cb14…`) |
| `remote.github.url` | `git@github.com:Animastor/animastor-backend.git` | **PASS** |
| guard `remote get-url origin` == `$NEW` | равенство | **PASS** (push не в тот remote исключён, D-1) |
| push | `git push -u origin HEAD:refs/heads/main`, **без `--force`** | **RC=0**, `* [new branch] HEAD -> main` |
| post-receive | `git push --mirror github` | **`remote: Mirroring to GitHub...` → `* [new branch] main -> main`** |
| bare после push | `refs/heads/main = f83f929c…` + `refs/remotes/github/main = f83f929c…` | **PASS**; `fsck` чисто; `in-pack 13415 / packs 1 / size-pack 8203` |

`refs/remotes/github/main` в bare — **remote-tracking ref**, который создаёт
git после собственного `--mirror`-push hook'а (у `remote.github` есть fetch
refspec `+refs/*:refs/*`); на момент отправки в bare был **только**
`refs/heads/main`, поэтому на GitHub лишних refs нет (§11.7).

### 11.7 GitHub / bare parity — СОВПАДАЮТ

| Проверка | Результат |
|---|---|
| `git ls-remote git@github.com:Animastor/animastor-backend.git` | **ровно 2 записи**: `HEAD` и `refs/heads/main` = **`f83f929c732d8fc490bd150e72294d6b3c6e2f92`** |
| лишние refs на GitHub (`master`, `refs/tags/*`, `refs/remotes/*`, `tmp/parser-audit-backup`) | **0 — отсутствуют** |
| parity bare ↔ GitHub | **`refs/heads/main` идентичны: `f83f929c…` == `f83f929c…` PASS** |
| GitHub API | `full_name=Animastor/animastor-backend`, `default_branch=main`, `private=false`, `fork=false`, **`pushed_at=2026-10-04T08:29:14Z`** (`size=0` — GitHub пересчитывает lazily, авторитет — `ls-remote`) |
| число refs bare | 1 head (`main`) + 1 remote-tracking — как и ожидалось (§9.3) |

### 11.8 Контроль монорепо / GPU Hub / артефактов — НЕ ИЗМЕНЕНЫ

**BEFORE (сессионный, снят до фильтрации) == AFTER (перед push):**

```
4d07dd4e1214fd4596ea17d7b9b7169baee603a9 refs/heads/c21.4-physically-extract-analysis-from-backend
4d07dd4e1214fd4596ea17d7b9b7169baee603a9 refs/remotes/github/c21.4-physically-extract-analysis-from-backend
64127b9e1dea2ac528a572b51b90a542b70c5ebb refs/heads/master
64127b9e1dea2ac528a572b51b90a542b70c5ebb refs/remotes/github/master
db5ff61f1079360cc848ff2fc131a12783bd97ad refs/heads/tmp/parser-audit-backup
db5ff61f1079360cc848ff2fc131a12783bd97ad refs/remotes/github/tmp/parser-audit-backup
```

| Контроль | Результат |
|---|---|
| `BEFORE == AFTER` (6 refs монорепо) | **IDENTICAL PASS** |
| `master == 64127b9e…` | **PASS** (не изменён) |
| `check_bare_snapshot` (GO-14) | **PASS** — immutable дословно, docs-ветка fast-forward |
| `HEAD` / `config --local` / hook sha256 монорепо vs snapshot | **IDENTICAL PASS** |
| `count-objects` монорепо vs snapshot | loose `1751 → 1759` = **+8 от docs-коммита `4d07dd4e` (07:26), запушенного ДО старта сессии при snapshot 04:04** → документационная ветка, тот же легальный fast-forward (D-10); **объекты не добавлялись этим запуском** |
| GPU Hub `for-each-ref` vs snapshot | **IDENTICAL PASS** (2 refs, `master=HEAD=7c7778c6…`) |
| GPU Hub `HEAD` / `config` / `count-objects` / hook sha vs snapshot | **IDENTICAL PASS** → byte-for-byte / ref-for-ref неизменен |
| backup `$BK` | **22 431 724 B, не пересоздавался, `fsck` чисто** |
| `backups/before-split-64127b9e-refs/` | **не изменён**, `MANIFEST.sha256` **11/11 OK**, режим 0444/0555 сохранён |
| `tmp/parser-audit-backup` | **`db5ff61f…` присутствует, не удалён** |
| рабочее дерево монорепо | `git status --porcelain` = **0 строк** (изменены только `docs/architecture/*.md` этим коммитом) |
| 3 оставшихся bare (web/android/worker) | **0 refs / 0 objects** — не тронуты |

### 11.9 Финальная проверка опубликованного backend (clone из GitHub)

Клон `git clone git@github.com:Animastor/animastor-backend.git /tmp/split/backend-github-verify`:

| Проверка | Ожидание | Факт |
|---|---|---|
| `HEAD` / ветка | `f83f929c…` / `main` | **PASS** |
| `git status --porcelain` | 0 строк | **0 PASS** (clean) |
| tracked files | **1045** | **1045 PASS** |
| leak §3.2 | 0 | **0 PASS** |
| commits | **1267** | **1267 PASS** |
| root commit | `6d12eed3…` «Recovery01: June 9 working state + dedup» | **PASS** |
| `git fsck` | чисто | **PASS** |
| чужие компоненты (`frontends/`, `tools/`, `packages/animastor-{worker,gpu-hub,web-*}`) | 0 | **0 PASS** |
| lineage frozen source | — | **§11.5 PASS** |

**СТАТУС BACKEND = SPLIT / PUBLISHED.**

---

Изменены **только** `docs/architecture/*.md` — этим **одним** docs-only commit'ом
(см. final-gate §0/§6 и handoff §1).
