# Repository Split — EXECUTION PACK (per-repo spec · идемпотентность · rollback · GO-чеклист)

> **PHYSICAL SPLIT: NOT EXECUTED**
> **git filter-repo: NOT EXECUTED**
> **force-push: NOT EXECUTED · GitHub-репозитории этим документом: NOT CREATED ·
> `Animastor/animastor-gpu-hub` / bare `animastor-gpu-hub.git`: NOT MODIFIED ·
> hooks: NOT MODIFIED · npm publish: NOT EXECUTED**
> **R-3 = A (SELECTED) · R-3 = B: REJECTED (не исполняется)**
> **P6 = CLOSED / PASS (6.4G ≥ 5G, 2026-10-04) · P1 = PARTIAL (4 пустых GitHub-репо
> созданы владельцем 2026-10-03; bare + hook ещё нет)**

> **Статус этого документа: read-only deliverable.** Все команды ниже
> **исполнялись только в read-only режиме** (`ls-tree`, `rev-list`, `log`,
> `count-objects`, `du`, `df`, `show-ref`) против frozen source и существующих
> bare-репозиториев. `git filter-repo` **не запускался**, клонов `$SPLIT` **не
> существует** (`/tmp/split` отсутствует), новые bare **не создавались**.

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
| **B — backup** | `git clone --mirror` монорепо в `backups/` | **только** в новый backup-каталог; `$BARE` **не пишется**; **GPU Hub не затрагивается** (R-3=A — см. `repository-split-r3-decision.md`) | A зелёный; P6-бюджет на backup учтён |
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
| **I-16** | **remote `github` в новых bare** | **BLOCKER.** Ни один документ не содержит `git remote add github` (проверено grep'ом по `docs/`), а `post-receive` делает `git push --mirror github` → падение «no such remote» на первом push, зеркало не появится, `git ls-remote https://…` вернёт пустоту | добавлено в P1-план: `git remote add github git@github.com:Animastor/<name>.git` **до** первого push (pre-split-go-blockers §2.1/§2.3, чеклист GO-04) |
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
| **Mirror-копия монорепо** | `git clone --mirror "$BARE" "$BK"` с `$BK=/home/animastor/backups/animastor-pre-split-64127b9e.git` | `/home/animastor/backups/` (durable, тот же FS, но вне `/tmp`) | полный откат: `$BARE` **вообще не пишется** на стадиях C/D для backend/web/android/worker, но backup страхует от случайной записи на стадии D и от сбоя диска |
| **`$BARE` нетронут** | `BEFORE=$(git -C "$BARE" for-each-ref … \| sort)` → сверка `AFTER` после каждого репо | монорепо | доказательство неизменности; при расхождении — **стоп** |
| **Реестр refs на момент старта** | `git -C "$BARE" for-each-ref` сохранён в `BEFORE` | переменная сессии | тот же контроль |
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
| **G-E** | **P1** — 4 целевых репо + bare + hooks | `git ls-remote https://github.com/Animastor/animastor-backend.git` (×4) + наличие `$NEW` + `post-receive` | HTTP 200 (не 404), bare есть, hook есть **до** push | **PARTIAL (2026-10-04)** — GitHub: 4 × 200 / 0 refs (**READY**); **bare + hooks отсутствуют → BLOCKED (owner, I-16/I-17/I-18)** |
| **G-F** | **P6** — диск ≥5G | `df -B1 /` | avail ≥ 5 368 709 120 | **PASS (CLOSED, 2026-10-04)** — **6 839 934 976 B** (≈6.4 GiB) ≥ 5 368 709 120 → **1.27×**; историческое значение pre-cleanup **2 971 721 728 B — FAIL** (2026-10-03, только audit trail); значение колеблется — источник истины **команда**, не число; **очистка не выполнялась и не требуется** |
| **G-G** | **R-3** — вариант зафиксирован | решение владельца | записано явно | **READY = A (SELECTED)** — `repository-split-r3-decision.md`; B → REJECTED |
| **G-H** | Backup монорепо создан | `test -d "$BK" && git -C "$BK" rev-parse "$SRC"` | exit 0 | не выполнялся (стадия B) |
| **G-I** | ~~Backup/freeze GPU Hub~~ | — | — | **NOT APPLICABLE при R-3 = A** — пункт исключён из GO-условий (GPU Hub не пишется) |
| **G-J** | `$NEWBRANCH` сверён с hook'ами P1 | `grep` hook'а | имя совпадает | не выполнялся (требует G-E) |
| **G-K** | `$SPLIT` пуст / целевые каталоги отсутствуют | `test ! -e "$SPLIT/backend"` (и т.д.) | exit 0 | **READY** (`/tmp/split` отсутствует) |
| **G-L** | Whitelist не изменился | `git ls-tree -r --name-only $SRC \| wc -l` | 1635 | **READY** |
| **G-M** | `$BARE` не тронут (`BEFORE` сохранён) | `git -C $BARE for-each-ref \| sort` | сохранено в переменную; **после каждого репо** — сверка `AFTER` | стадия B |
| **G-N** | **P1** — remote `github` в каждом bare (**I-16**) | `git -C "$NEW" config --get remote.github.url` | `git@github.com:Animastor/<name>.git` для всех 4 | **BLOCKED** (bare не созданы) |
| **G-O** | **P1** — репозитории **пустые** + public (**I-17**, **I-18**) | `curl … /repos/Animastor/<name>`; `git ls-remote` | **`size=0` и 0 refs**, `private=false`, `default_branch=main` (`pushed_at`/`default_branch=""` — устаревшие критерии, см. go-blockers §2.1) | **READY (2026-10-04)** — 4 × 200, `size=0`, **0 refs**, `private=false` |
| **G-P** | **P1** — hook 91 байт, 0755, до первого push | `test -x "$NEW/hooks/post-receive" && test "$(wc -c < "$NEW/hooks/post-receive")" -eq 91` | совпадает с §2.2 pre-split-go-blockers | **BLOCKED** |

**Сейчас: G-E / G-N / G-O / G-P = BLOCKED, G-F = FAIL, G-G = READY (R-3 = A),
G-I = NOT APPLICABLE, G-H / G-J / G-M = не выполнялись → GO-состояние НЕ
достигнуто** (остались P1 и P6). Физический split не выполняется.
Детальная раскладка P1 / P6 и сквозной чеклист GO-01…GO-15 —
`repository-split-pre-split-go-blockers.md` §2–§6; решение R-3 —
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
| **E16** | P1 (§FPSG §3, final-gate §4, handoff §3) | не задано **действие** в новых bare: `post-receive` есть в списке, но `git remote add github` **нигде не упоминается** → hook падает на первом push | добавлено I-16 + P1-план (pre-split-go-blockers §2.1/§2.3, G-N, GO-04) |
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

---

## 9. NOT EXECUTED

**PHYSICAL SPLIT: NOT EXECUTED.**
**git filter-repo: NOT EXECUTED.**
**force-push: NOT EXECUTED · GitHub-репозитории этим документом: NOT CREATED ·
`Animastor/animastor-gpu-hub` / bare `animastor-gpu-hub.git`: NOT MODIFIED ·
hooks: NOT MODIFIED · npm publish: NOT EXECUTED.**

Этот документ **не выполнял** и **не авторизует**: создание репозиториев (P1;
4 пустых GitHub-репо созданы владельцем 2026-10-03 **вне** этого документа —
bare/hook ещё нет), очистку диска (**не требуется: P6 закрыт без очистки**),
выбор R-3 (решён ранее: A), `git filter-repo`, force-push, `--path-rename`,
изменение `master`, hook'ов, production-кода и B7-тестов, регенерацию текущих
monorepo lock-файлов, удаление `tmp/parser-audit-backup`.

Изменены **только** `docs/architecture/*.md` — этим **одним** docs-only commit'ом
(см. final-gate §0/§6 и handoff §1).
