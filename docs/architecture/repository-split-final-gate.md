# Repository Split — FINAL GATE (GO/NO-GO)

> **FINAL STATUS: PARTIALLY EXECUTED — BACKEND SPLIT / PUBLISHED (2026-10-04)**
> **BACKEND: PHYSICAL SPLIT EXECUTED · git filter-repo EXECUTED (backend, 35 `--path`) ·
> первый push `HEAD:refs/heads/main` ВЫПОЛНЕН БЕЗ force ·
> `Animastor/animastor-backend` `main` = bare `refs/heads/main` = `f83f929c732d8fc490bd150e72294d6b3c6e2f92`**
> **web / android / worker: PHYSICAL SPLIT NOT EXECUTED ·
> git filter-repo для web/android/worker/gpu-hub: NOT EXECUTED**
> **force-push: NOT EXECUTED ни для одного репозитория**
> `master` монорепо / `Animastor/animastor-gpu-hub` / bare `animastor-gpu-hub.git` /
> hooks / backup / BEFORE-snapshot / `tmp/parser-audit-backup`: **NOT MODIFIED** ·
> npm publish: NOT EXECUTED
> **R-3 = A (SELECTED) · R-3 = B: REJECTED (не исполняется)**
> **P6 = CLOSED / PASS · P1 = CLOSED (GitHub-repo 2026-10-03 · 4 bare + hook + remote 2026-10-04)**
> **GO-05 = CLOSED (`NEWBRANCH=main`, owner-confirmation 2026-10-04) ·
> стадия B = ВЫПОЛНЕНА (GO-08 backup + GO-14 BEFORE-snapshot, 2026-10-04)**
> **GO-01…GO-15 = PASS/READY/CLOSED/N/A при перепроверке перед стадией C ·
> авторизация стадии C для backend выдана владельцем (2026-10-04)**
> **Стадия C (backend) = ВЫПОЛНЕНА: журнал, точные SHA, BEFORE/AFTER, parity —
> `repository-split-execution-pack.md` §11**

Единственный авторитетный статус-документ финального pre-split gate'а.
Исторические аудиты на более ранних SHA остаются в
`repository-split-next-blockers.md` (§FPSG, §FINAL SPLIT HANDOFF) как журнал;
при расхождении чисел и SHA действует **этот** документ.
**Единственное исключение: статус R-3 определяется
`repository-split-r3-decision.md` (A = SELECTED, B = REJECTED).**

---

## 0. Frozen source (точка отсчёта)

| Поле | Значение |
|---|---|
| **Source SHA (единственный)** | **`64127b9e1dea2ac528a572b51b90a542b70c5ebb`** |
| Branch | `c21.4-physically-extract-analysis-from-backend` (= `origin/…`) |
| **Tip ветки (HEAD)** | документационный tip = **frozen source + N doc-коммитов**, где **N = `git rev-list --count 64127b9e…HEAD`**. Константы нет: каждая документационная ревизия увеличивает N и меняет набор `docs/architecture/*.md`. На момент предыдущей ревизии (EXECUTION PACK + GO-BLOCKERS) **N = 8**, затронуто **4** файла (`execution-pack`, `final-gate`, `next-blockers`, `pre-split-go-blockers`). Ранее записанные значения (tip `e768a7cc`, «+ 5», «+ 7», «только те же 2/3 файла») — **исторические**; источник истины — команда, не список SHA |
| **tip ≠ source** | tip — **только** документационный HEAD ветки; **`git filter-repo` выполняется исключительно от `64127b9e…`** (§0, §1, handoff §1/§10) |
| DAG | `master` — прямой предок source (**YES**); source — прямой предок tip (**YES**); коммиты после source — **все документационные, меняют только `docs/architecture/*.md`** (набор — по `git diff --name-only 64127b9e..HEAD`); merge = **0**, tags = **0** |
| **`master`** | **`64127b9e…` == source == `origin/master`** → **P2 CLOSED** (FF `04da33ea → 64127b9e`, обычная экспедиция, без force; `master` — прямой предок source, 0 behind / 0 ahead) |
| Working tree | чистый (`git status --porcelain` = 0 строк) на момент gate |
| Merge-коммитов в истории | **0** (`git rev-list --merges --count` = 0), коммитов всего **1653 на source** |
| origin | `/home/animastor/repos/animastor.git` (bare; `post-receive` от 2026-08-22, не изменялся) → зеркало `github.com:Animastor/animastor.git` |
| Что менялось в этом gate | **только** `docs/architecture/*.md` (см. §6) — production-код, тесты, Dockerfile, compose, `artifacts.lock.json`, B7-тесты, hook'и, `.github` — **не тронуты** |

Правило (унаследовано от `b7e2f7cd`): source SHA фиксируется **до**
документационных коммитов этого gate'а; все doc-коммиты после `64127b9e…`
меняют только `docs/architecture/*.md`, в репозитории backend-извлечения не
попадают (handoff остаётся в архиве-монорепо) и на извлечение не влияют.

---

## 1. GATE table (GO/NO-GO)

| # | CHECK | STATUS | EVIDENCE | BLOCKER? |
|---|---|---|---|---|
| G1 | Registry-only deps (`grep '"file:'` = 0) | **PASS** | `scripts/split-guards/g1-registry-only.sh` → `G1: PASSED` (сессионный лог `/tmp/opencode/gate-g1g5.log`) | нет |
| G2 | Deep subpath ↔ `exports` scan (15 + 13 pkgs) | **PASS** | `scripts/split-guards/g2-exports-scan.cjs` → `G2: PASSED` | нет |
| G3 | Protocol parity (`sync-protocol --check`) | **PASS** | `scripts/split-guards/g3-protocol-parity.sh` → `G3: PASSED` (exit 0) | нет |
| G4 | GPU Hub **standalone** docker build без монорепо-контекста | **PASS** | `packages/animastor-gpu-hub/tools/g4-standalone-build.sh` → `G4: PASSED` (fixture-контекст `tools/standalone-fixture.cjs`, post-split self-run слой) | нет |
| G5 | Artifact integrity (staging-gate + `check-artifacts.sh` в образе + sha256 Release/pin + tamper) | **PASS** | `tools/g5-artifact-integrity.sh` → `G5: PASSED`; ok: 4/4 release assets materialised, `sha256_asset` verified; ok: tampered asset rejected; ok: lock/tree mismatch rejected; ok: `check-artifacts.sh` 6/6 inside standalone image | нет |
| H | GPU Hub `npm test` | **PASS 22/0** | `packages/animastor-gpu-hub` → `node tests/run-all.cjs` | нет |
| T | Backend `npm run test:arch` | **979 passing / 2 failing** — IB-G15 (`installer-package-boundary.test.js:243`), T9 (`phase5-runtime-result.test.js:401` ENOENT) | pre-existing, воспроизводится на `b7e2f7cd` и до; этим gate тронуты только `packages/animastor-gpu-hub/tools/*` | **нет** (PRE-EXISTING) |
| W | Whitelist §8 (prep-plan) vs `git ls-files` | **PASS — 1635 tracked / 1635 covered / 0 uncovered** | read-only аудит (см. §2); per-repo 1045/349/217/58/45 | нет |
| C | Command-sheet audit (§4.1.0–4.1.6) | **PASS после двух docs-only ревизий**: пути = §8 (кроме 3 задокументированных no-op/X-1 исключений), `--path-rename` отсутствует, все URL = `github.com/Animastor`, `SRC` объявлен, gpu-hub-шаг условие R-3=B **постоянно ложно** (R-3=A → шаг исключён); **устаревшие счётчики 1040→1045 и 41→44 исправлены**; вторая ревизия закрыла **I-1 reflog-блокер, I-2 молчаливые контроли, I-3 идемпотентность, I-6 версию, I-7 backup** и добавила per-repo leak/`--follow`/commit-count чеки (см. §3, `repository-split-execution-pack.md` §4) | read-only аудит (см. §3) | нет |
| P1 | 4 новых GitHub-репозитория (backend/web/android/worker) + 4 VPS bare + hooks + remote; `animastor-gpu-hub` уже существует | **CLOSED (2026-10-04)** | **Перепроверка read-only 2026-10-04**: GitHub API `animastor-backend` / `-web` / `-android` / `-worker` = **HTTP 200**, `private=false`, **`size=0`**, **0 refs** (`git ls-remote` ssh rc=0, пусто) — созданы владельцем **2026-10-03T23:53–23:55Z**, `default_branch=main`; `Animastor/animastor` = 200 (`master`); `Animastor/animastor-gpu-hub` = **HTTP 200** (private=false, size=105, default_branch=master, created 2026-09-06T16:19:30Z, pushed 2026-09-06T18:07:10Z, HEAD `7c7778c`, 43 коммита, forks=0, `/contents` непустой). **Остаётся локальная часть:** `/home/animastor/repos/` содержит только `animastor.git` и `animastor-gpu-hub.git` → **4 bare отсутствуют**, `hooks/post-receive` и remote `github` **не созданы** (на момент этой строки — GO-02/GO-03/GO-04 = BLOCKED; **снято ниже**, ревизия «Подготовка bare»). **GPU Hub отдельно не создавать** | ~~ДА~~ **закрыто** — 4 bare + hooks + remote `github` созданы 2026-10-04 |
| P2 | FF `master` → source | **PASS (CLOSED)** | `git merge --ff-only 64127b9e…` + `git push origin master` → `04da33ea..64127b9e`, без force | нет |
| P3 | npm-грант (`npm whoami`) | **FAIL — E401** (перепроверено 2026-10-03) | `npm whoami` → `E401 401 Unauthorized`; `npm view` работает; **не чинить в рамках gate** | только **post-split publish** (не блокирует filter-repo) |
| P6 | Диск ≥ 5G свободно | **PASS — CLOSED (2026-10-04)** | `df -B1 /` (перепроверка 2026-10-04, одна команда): total 105 496 965 120, used 94 139 928 576, **avail 6 839 934 976 B ≈ 6.4 GiB (`df -h /` → 6.4G; владелец фиксировал 6.5G; значение колеблется — авторитетна команда)** ≥ `5 368 709 120` (≥5G) → **порог выполнен**, запас **1.27×** порога и **6.4×** измеренного минимума 1 GiB. **Очистка НЕ выполнялась и НЕ требуется.** Историческое значение pre-cleanup: **2 958 962 688 B (≈2.96 GB), FAIL, 2026-10-03** — сохранено только для audit trail | **нет** |
| R-3 | GPU Hub: A (адаптация) / B (замена историей) | **DECIDED — A (SELECTED); B = REJECTED** | **решение зафиксировано**: `repository-split-r3-decision.md`. Существующий `Animastor/animastor-gpu-hub` = `7c7778c` (bare и GitHub идентичны, 43 коммита) — **сохраняется без изменений**, его standalone history **канонична**; `filter-repo` для GPU Hub **не выполняется**, новый hub-репо **не создаётся**, force-push/overwrite/delete **запрещены**. Вариант B (backup → заморозка hook → filter-repo §8.5 → force-push) — **REJECTED / NOT SELECTED**, все его ветки в документах помечены N/A/REJECTED; командный лист §4.1.5 и карта §5.5 **неисполняемы** | **закрыто** (A) |
| P4 | `workflow.json` / stale android-mount гигиена | **NOT YET EXECUTED (перепроверено 2026-10-04)** | `/home/animastor/animastor/workflow.json` — **по-прежнему существует** (пустой каталог `root:root`, 2026-08-24, untracked, `.gitignore:43`); `frontends/android/docker-compose.yml:41` — строка `./workflow.json:/workflow.json:ro` **осталась**; корневой `docker-compose.yml` mount **удалён** (`bd66bae6`), **но** живой контейнер `animastor-backend` (старт 2026-09-04) всё ещё несёт этот bind-mount (stale mount контейнера) | **нет** (гигиена; владельцу) |
| P5 | `.github/` отсутствует в монорепо | **CONFIRMED (перепроверено 2026-10-04)** | `test -d .github` → отсутствует; `git ls-tree -r --name-only 64127b9e \| grep '^.github/'` → **0**; GitHub API `Animastor/animastor/contents/.github/workflows` → **404**; у существующего GPU Hub свои workflows в **его** репо (`ci.yml`, `ghcr-release.yml`) — это не монорепо | нет (интерпретация — owner, §FPSG.8 п.6) |
| FS | **PHYSICAL SPLIT** | **PARTIAL — BACKEND EXECUTED (2026-10-04)**; web/android/worker **NOT EXECUTED** | backend извлечён и опубликован: bare `animastor-backend.git` + GitHub `Animastor/animastor-backend` = **`f83f929c…`**; **3 оставшихся bare = 0 refs / 0 objects, GitHub 0 refs** (не тронуты); новый GPU Hub **не создавался** | шаги 2–4 требуют отдельной авторизации |
| FR | **`git filter-repo`** | **EXECUTED для backend (35 `--path`)**; NOT EXECUTED для web/android/worker/gpu-hub | backend: RC=0, **без `--path-rename` / без `--force` / без `--path workflow.json`**, история сохранена (**1267** коммитов от frozen source `64127b9e…`); **force-push не выполнялся ни для одного репозитория** | — |
| GH | Hooks / существующий GPU Hub | **NOT MODIFIED** (перепроверено 2026-10-03) | `hooks/post-receive` монорепо не тронут (mtime 2026-08-22 07:29:58Z); bare `animastor-gpu-hub.git` HEAD = `7c7778c`; GitHub `Animastor/animastor-gpu-hub` = 200, pushed 2026-09-06T18:07:10Z | — |
| B5 | GPU Hub artifact flow (post-split путь) | **READY — механика DONE и верифицирована** | dual-stage Dockerfile (stager + `fetch-pinned-assets.sh`, пин по tag/digest), `artifacts.lock.json` (`sha256_tree` + `sha256_asset`), G5 реально прогоняет post-split слой (materialise 4 zip → sha256 → tamper-отказ), per-run cache-bust `RUN_ID` | нет |

**Сводка blocker'ов:** G1–G5 = PASS · whitelist = PASS · command-sheet = PASS ·
тесты = PASS (2 known pre-existing) · **P6 = CLOSED / PASS (6.4G ≥ 5G,
2026-10-04; старое 2.9G — историческое)** · **P1 = CLOSED (2026-10-04)** —
GitHub 4 × 200 пустых **+ 4 VPS bare, hook'и 0755/91 байт byte-identical,
remote `github`** → **стадия C (backend): первый push ВЫПОЛНЕН без force
(2026-10-04), web/android/worker push не выполнялся** ·
**R-3 = CLOSED (A; B REJECTED)** · P3 = post-split only ·
P4/P5-гигиена = **NOT YET EXECUTED** ·
**стадия C backend = SPLIT / PUBLISHED (`f83f929c…`).**

G1–G5 прогнаны дважды: на **source `64127b9e…`** и повторно на **tip'е ветки**
(после doc-коммитов) — оба раза `split guards: ALL GREEN (G1 G2 G3 G4 G5)`
(`scripts/split-guards/run-all.sh`, сессионные логи
`/tmp/opencode/gate-g1g5.log` и `/tmp/opencode/gate-g1g5-final.log`).

---

## 2. Whitelist audit (§8 vs tracked-файлы)

Read-only разбор: каждый tracked-файл должен покрываться ≥1 whitelist'ом §8.
Аудит выполняется **по frozen source** (`git ls-tree -r --name-only $SRC`), т.е.
ровно по тому набору, который увидит `filter-repo`, а не по tip'у ветки.

| Repo | §8 paths | tracked files | path-with-no-tracked-file |
|---|---|---|---|
| animastor-backend | 36 | **1045** | 1 (`workflow.json` — no-op, untracked) |
| animastor-web | 31 | **349** | 0 |
| animastor-android | 6 | **217** | 1 (`local.properties` — no-op, untracked) |
| animastor-worker | 19 | **58** | 0 |
| animastor-gpu-hub | 27 | **45** | 0 |
| **Итого** | | **tracked 1635 / covered 1635 / UNCOVERED 0** | |

- **Tip ветки (после doc-коммитов этого gate'а): 1637 / 1637 / 0** — сюда
  добавились только эти документы (`repository-split-final-gate.md` +
  `repository-split-execution-pack.md`; `repository-split-next-blockers.md`
  существовал уже на source); для `filter-repo` релевантна строка **1635**.

- **Дубли (намеренные, задекларированы §8):** 75 файлов в >1 репо, сумма с
  пересечением **1714** (= 1635 + 79 instance'ов): backend+web 31,
  backend+gpu-hub 23, backend+worker 18, android+web 1, backend+worker+gpu-hub 1,
  все 5 репо 1 (`LICENSE`).
- `LICENSE` → все 5; `JOB_PROTOCOL_V2.md` → backend+worker+gpu-hub;
  `PHASE_10*` → backend+gpu-hub; `ANDROID_WEB_PARITY.md` → web+android.
- **При R-3 = A (SELECTED) исполняются только §8.1–§8.4:** сумма
  instance'ов **1669 = 1615 unique** (1045+349+217+58), а **20 файлов** не
  копируются никуда — 19 из `packages/animastor-gpu-hub/` и
  `gpu-hub-rebuild.sh` (остаются только в замороженном монорепо; сам компонент
  живёт в существующем `Animastor/animastor-gpu-hub`). Строка «1635/1635» —
  покрытие **всех 5** whitelist'ов §8, §8.5 при A **не применяется**.
- Устаревшие числа в старых доках: **1626 → 1635**, backend **1040 → 1045**,
  gpu-hub §8 **41 → 45** (в командном листе — **44**, минус `gpu-hub-rebuild.sh`
  при R-3=B) — исправлено в этом же gate; **при R-3=A §8.5 не применяется** —
  `repository-split-r3-decision.md` §3.

---

## 3. Command-sheet audit (§4.1.0–4.1.6, `repository-split-next-blockers.md`)

| Проверка | Результат |
|---|---|
| Пути `--path …` командного листа ↔ §8 | совпадают, кроме 3 задокументированных исключений: `workflow.json` (no-op), `local.properties` (no-op), `gpu-hub-rebuild.sh` (X-1) — все три упоминаются **только** в строках-комментариях `# НЕТ …`, исполняемых путей не содержат |
| `--path-rename` | **отсутствует** |
| URL push | **только** `github.com/Animastor/…` |
| `SRC=` | объявлен и обязан равняться frozen source (§0) |
| gpu-hub-шаг (§4.1.5) | условие `R-3 = B` **постоянно ложно** → шаг **исключён из очереди и неисполняем** (R-3 = A; `repository-split-r3-decision.md` §3) |
| Счётчики `test "$(git ls-files \| wc -l)" -eq …` | backend **1040 → 1045**, gpu-hub **41 → 44** (исправлены; §8.5 = 45 файлов, минус `gpu-hub-rebuild.sh` — X-1; **при R-3=A этот счётчик не применяется**, шаг не исполняется); web 349, android 217, worker 58 — уже верны. Сверены **на `$SRC`** (`git ls-tree -r --name-only $SRC` под путями §8), а не на tip'а ветки |
| **Повторный аудит (docs-only ревизия, `repository-split-execution-pack.md` §4)** | **FAIL до правок → PASS после.** Найдены и исправлены: **I-1 блокер** — `reset --hard` даёт 2 reflog-записи → `sanity_check` abort (добавлен `git reflog expire --expire=now --all` до `filter-repo`); **I-2** — `test … && echo OK` под `set -e` молча пропускается (переведено на `… \|\| { FAIL; exit 1 }`); **I-3** — нет guard'а повторного запуска (добавлен `test ! -e "$SPLIT/<repo>"`); **I-4** — `$SRC` не сверялся с `$BARE` (добавлены `rev-parse`/`merge-base`); **I-6** — `git-filter-repo --version` печатает `a40bce548d2c`, а не `2.47.0` (проверка через метаданные пакета); **I-7** — backup в `/tmp` volatile (добавлен durable `BK` в `backups/`); **I-11** — `symbolic-ref HEAD` перенесён до push; **I-13/I-14/I-15** — добавлены полные per-repo leak-паттерны, `git log --follow` и ожидаемые числа коммитов. Сохранены без изменений: **`--path-rename` отсутствует, `--force` отсутствует, URL только `github.com/Animastor/`, `SRC` = frozen source, gpu-hub-шаг гейтится на R-3=B и это условие постоянно ложно при R-3=A** |
| Стейл-счётчики (предыдущая ревизия) | исправлены: всего `package-lock.json` **33 → 34**; backend-домен **15 → 16** lock'ов (`packages/animastor-ai-analysis/package-lock.json` **существует**, добавлен `6798d786`); «4 из 15» → «4 из 16»; §6 п.4 «27 локов» → **28**; §5.5 `packages/animastor-gpu-hub/` **15 → 19**; §9 «изменён только next-blockers» → 3 документа. **Исторические** числа в §FPSG / §TECHNICAL CLOSURE на прошлых SHA не правились |

---

## 4. External prerequisites (не закрываются этим gate'ом)

Детальная раскладка **P1** (visibility, default branch, `$NEWBRANCH`, порядок
создания, пустота репозиторий, hook, remote `github`), **P6** (измеренные факты
и оценка места под split) и **R-3** (сравнение A/B и решение **A = SELECTED**,
B = REJECTED — `repository-split-r3-decision.md`) + сквозной
чеклист **GO-01…GO-15** — `repository-split-pre-split-go-blockers.md` §2–§6.

| ID | Что нужно | Статус | Кто |
|---|---|---|---|
| **P1** | создать `animastor-backend`, `animastor-web`, `animastor-android`, `animastor-worker` (GitHub 200 + пустой bare + hook **+ remote `github`**) | **CLOSED (2026-10-04)** — **GitHub**: 4 × HTTP 200, `size=0`, **0 refs**, `default_branch=main` (созданы 2026-10-03T23:53–23:55Z). **VPS**: созданы 4 bare `/home/animastor/repos/animastor-{backend,web,android,worker}.git` (0 refs / 0 objects), `HEAD = refs/heads/main`, `hooks/post-receive` **0755 / 91 байт / `cmp` byte-identical** шаблону (sha256 `6a63cb14…`), `remote.github.url` настроен → **I-16 закрыт**, **GO-01…GO-04 = CLOSED/READY**. **Push НЕ выполнялся** — все 4 bare и GitHub пусты; **I-17** (пустота) подтверждён, **I-18** — SSH read rc=0, push-права проверяются при первом push | ~~owner~~ **закрыто**; **GPU Hub отдельно не создавать** (уже существует, 200) |
| **R-3** | ~~зафиксировать **A** или **B**~~ | **CLOSED — A (SELECTED), B = REJECTED** (`repository-split-r3-decision.md`). Разблокирован авторинг hub-CI **в существующем** репо; §8.5 / §4.1.5 / §5.5 — **не исполняются** | — (закрыто) |
| **P6** | ≥5G свободно для клонов/фильтрации | **CLOSED / PASS — `6 839 934 976 B (≈6.4 GiB) ≥ 5 368 709 120 B`** (перепроверка `df -B1 /`, 2026-10-04; `df -h /` → **6.4G**, владелец фиксировал 6.5G) → **1.27×** порога ≥5G, **6.4×** измеренного минимума **1 GiB** (пик ≈431 MB). **Очистка не выполнялась и не требуется.** Историческое pre-cleanup-значение: **2 958 962 688 B (≈2.96 GB), FAIL, preflight 2026-10-03** — оставлено только для audit trail. Ранее предложенные кандидаты очистки (`pip cache purge`, `npm cache clean --force`, `/tmp`) **отзываются как не нужные**; выполнять их — только по отдельному распоряжению владельца. Старые доки (readiness §9, pre-split-fixes §7/§8) упоминают **≥3 GB** — устаревший порог; авторитетный **≥5G** | **нет** |
| **P3** | `npm whoami` ≠ E401 | **E401** (перепроверено 2026-10-03) | owner; нужен **до первого publish** (post-split) |

---

## 5. Post-split smoke matrix

Конкретные команды на каждый репозиторий — `repository-split-next-blockers.md`
§FPSG.6 и §FINAL SPLIT HANDOFF §8 (backend/web/android/worker/gpu-hub, включая
`npm ci` + `test:arch` 979/2, `build:packages` 13/13, worker `run-all` 45,
gpu-hub `run-all` 22 + G4 standalone + `check-artifacts.sh` 6/6).
Этот gate их **не выполнял** — они POST-SPLIT.

---

## 6. Итоговый статус

# PARTIAL GO — BACKEND SPLIT / PUBLISHED (2026-10-04) · web/android/worker: NOT AUTHORIZED YET

**Авторизация стадии C получена владельцем и исполнена ТОЛЬКО для backend**
(«НАЧАТЬ ФИЗИЧЕСКИЙ SPLIT BACKEND»). Журнал, точные SHA, BEFORE/AFTER и
parity — `repository-split-execution-pack.md` **§11**. Категории по этому gate'у:

| Категория | Что в ней сейчас |
|---|---|
| **CLOSED** (закрыто фактически) | **P2** (`master` = `64127b9e` = `origin/master`) · **R-3** (= A, B REJECTED) · **P6** (≥5G: `6 839 934 976 B`, 2026-10-04) · G1–G5 (ALL GREEN) · whitelist 1635/1635 · command-sheet audit · 2 pre-existing теста подтверждены |
| **READY** (готово, подтверждено read-only, исполнения не требует) | **GO-04** (remote `github` настроен) · P5-facts (`.github/` отсутствует, GitHub 404) · GO-07 (R-3 = A) · GO-09 (N/A) · GO-10…GO-13, GO-15 |
| **CLOSED (дополнение, 2026-10-04, эта ревизия)** | **GO-05** — `NEWBRANCH=main`, owner-confirmation зафиксирован письменно + сверка GitHub `default_branch=main` ×4 / `symbolic-ref HEAD=refs/heads/main` ×4 · **стадия B**: **GO-08** — durable backup `backups/animastor-pre-split-64127b9e.git` (22 431 724 B, `$SRC` внутри, restore-дрилл пройден) · **GO-14** — BEFORE-snapshot refs `animastor.git` (6 refs) и `animastor-gpu-hub.git` (2 refs, `master=7c7778c6…`) в `backups/before-split-64127b9e-refs/` |
| **CLOSED** (дополнение) | **P1** целиком — 4 GitHub-repo (200/`size=0`/0 refs) **+ 4 bare + hooks + remote** (2026-10-04); **GO-01, GO-02, GO-03** |
| **CLOSED (дополнение, 2026-10-04, аудит)** | **FINAL PRE-SPLIT AUDIT = PASS** — GO-01…GO-15 перепроверены фактами (не документацией), dry-run execution-plan: §3.1 счётчики **8/8**, корни **4/4**, leak **0×4**, coverage **1615/1635** (20 не покрыто = только gpu-hub), overlaps **52 = намеренные дубли**; командный лист `bash -n` **6/6** + добавлены guard'ы (пустой bare, `origin == $NEW`, `check_bare_snapshot`) → `execution-pack` §9 |
| **CLOSED (дополнение, 2026-10-04, стадия C — BACKEND)** | **GO-01…GO-15 перепроверены перед запуском — все PASS/READY/CLOSED/N/A, 0 FAIL** · `git filter-repo` backend **ВЫПОЛНЕН** (35 `--path`, без `--path-rename`/`--force`/`workflow.json`, RC=0) · AFTER: **1045 файлов / 1267 коммитов / leak 0 / fsck чисто / clean tree / корень `Recovery01` / `--follow` 5/5** · первый push **БЕЗ force** → hook → GitHub · **bare == GitHub == `f83f929c732d8fc490bd150e72294d6b3c6e2f92`**, ровно **2 refs** на GitHub, лишних refs нет · монорепо/GPU Hub/backup/snapshot **BEFORE == AFTER** → **статус backend = SPLIT/PUBLISHED** |
| **BLOCKED** (владелец/внешнее, без этого запрет) | **P3**: npm E401 (только post-split publish) · **авторизация стадии C для web/android/worker** (отдельное решение владельца) |
| **NOT YET EXECUTED** (сознательно не выполнялось) | **физический split web / android / worker** · **`git filter-repo` для web/android/worker/gpu-hub** · **force-push (вообще ни для одного репо)** · push в оставшиеся 3 bare/GitHub · push/mirror в GPU Hub · **P4-гигиена** (`workflow.json`, android-mount) · удаление `tmp/parser-audit-backup` · авторинг workflows в новых репо · `npm publish` |

**Итоговый вердикт: BACKEND = GO/EXECUTED/PUBLISHED; web/android/worker —
gate остаётся NO-GO до отдельной авторизации владельца.**

Закрыто этим gate'ом: **G1–G5 ALL GREEN** (дважды: source + tip), whitelist
**0 uncovered**, command-sheet **консистентен** (перепроверен read-only на
`$SRC`, вторая ревизия — `repository-split-execution-pack.md` §4), **P2 (master
FF) выполнен**, GPU Hub artifact flow **верифицирован end-to-end (G5, включая
tamper-отказ)**, тесты **без новых регрессий** (2 pre-existing: IB-G15, T9).

Актуальные факты (перепроверка read-only; tip — документационный HEAD ветки,
см. §0 — источник истины `git rev-list --count 64127b9e…HEAD`):

| Поле | Значение |
|---|---|
| **HEAD (tip, документационный)** | `64127b9e…` **+ N doc-коммитов** — **`git rev-list --count 64127b9e…HEAD`** (предыдущая ревизия = 10) — **не** frozen source; прошлые значения (tip `e768a7cc`, «5», «7», «8 doc-коммитов») — исторические |
| **Frozen source** | `64127b9e1dea2ac528a572b51b90a542b70c5ebb` |
| **master** | `64127b9e…` == source == `origin/master` (не перемещался в этом gate) |
| **P6** | **CLOSED / PASS** — `6 839 934 976 B (≈6.4 GiB)` ≥ `5 368 709 120 B` (перепроверено `df -B1 /`, 2026-10-04; `df -h /` → 6.4G); **источник истины — команда, не число**; очистка не выполнялась и не требуется; историческое FAIL-значение 2 958 962 688 B (2026-10-03) сохранено для audit trail |
| **P1** | **CLOSED** — GitHub: 4 × HTTP **200**, `size=0`, **0 refs** (созданы владельцем 2026-10-03); VPS: **4 bare созданы 2026-10-04** (0 refs/0 objects, `HEAD=refs/heads/main`), hooks **0755/91 байт byte-identical**, remote `github` настроен; **push не выполнялся до стадии C** → **2026-10-04 стадия C: backend push ВЫПОЛНЕН (без force)**, web/android/worker по-прежнему 0 refs / GitHub 0 refs; `animastor-gpu-hub` = 200 / `7c7778c` (не трогали) |
| **P3** | **E401** (только post-split publish) |
| **R-3** | **CLOSED — A (SELECTED)**; B = **REJECTED** (`repository-split-r3-decision.md`) |
| Git | merge 0, tags 0, working tree чист; изменённые после source файлы — **только `docs/architecture/*.md`** (набор — `git diff --name-only 64127b9e..HEAD`) |
| GPU Hub safety | bare `7c7778c` + GitHub 200 + hook монорепо 2026-08-22 — **не изменены**; **R-3 = A подтверждает: они и не будут меняться** |
| **Read-only preflight (2026-10-03, исторический)** | G1–G5 **ALL GREEN** (`scripts/split-guards/run-all.sh`, лог `/tmp/opencode/preflight-g1g5.log`) · whitelist §8 = **1635 / 1635 / 0 uncovered** на `$SRC` · command-sheet audit **PASS** на `$SRC` · gpu-hub `npm test` = **22/0** · `backend` `test:arch` = **979 passing / 2 failing** (IB-G15 `installer-package-boundary.test.js:243`, T9 `phase5-runtime-result.test.js:401` — **pre-existing, воспроизводятся**) · GitHub **4 × 404 + gpu-hub 200** · `npm whoami` **E401** · `.github/` отсутствует · `workflow.json` существует (untracked) · `git filter-repo` **не запускался** (нет выходных каталогов split), force-push не выполнялся |
| **Read-only перепроверка (2026-10-04, эта ревизия)** | `df -B1 /` → avail **6 839 934 976 B** → **P6 PASS** · GitHub API ×7 → **backend/web/android/worker = 200, `size=0`, 0 refs** (`git ls-remote` ssh rc=0), `animastor` = 200, `animastor-gpu-hub` = 200 (releases 0, tags 0) · `/home/animastor/repos/` → **на момент этой перепроверки 4 bare отсутствовали** (созданы ниже, та же ревизия) · `workflow.json` **существует** (пустой каталог) · `frontends/android/docker-compose.yml:41` mount **остался** · контейнер `animastor-backend` несёт stale bind-mount `workflow.json` · ветка `tmp/parser-audit-backup` (`db5ff61f`) **существует** локально и в bare · `master` = `64127b9e` = `origin/master`, HEAD впереди на 10 doc-коммитов · `.github/` отсутствует (tree + GitHub 404) · `npm whoami` → **E401** · `/tmp/split` отсутствует · **ничего не создавалось/не удалялось/не перезаписывалось** |
| **Подготовка bare (2026-10-04, эта ревизия)** | Созданы **4 bare** `animastor-{backend,web,android,worker}.git` — `refs=0`, `objects=0`, `HEAD=refs/heads/main`; в каждом `hooks/post-receive` **0755 / 91 байт / `cmp` байт-в-байт идентичен шаблону монорепо** (sha256 `6a63cb14…`); `remote.github.url = git@github.com:Animastor/<name>.git`. **Push НЕ выполнялся**: 4 bare пусты, GitHub по-прежнему `size=0` / 0 refs. **BEFORE/AFTER старых bare:** `refs`, `HEAD`, `config`, `count-objects`, hook (+mode/size) — **14/14 файлов IDENTICAL**; `animastor.master = 64127b9e…`, `animastor-gpu-hub.master = 7c7778c…` → **GO-02 = GO-03 = GO-04 = CLOSED/READY** |
| **FINAL PRE-SPLIT AUDIT (2026-10-04)** | Read-only аудит после `40f09946` (`execution-pack` §9): **GO-01…GO-15 = PASS/READY/CLOSED/N/A** (4 GitHub 200/`size=0`/0 refs · 4 bare 0/0/`main` · hooks `6a63cb14…` ×6 · remote `github` ×4 · `NEWBRANCH=main` ×19 · `df` **6 737 682 432 B** (1.25×) · backup `$SRC`/fsck/0 inode'ов/`archive` 29 716 480 B · snapshot `MANIFEST` 11/11 · GPU Hub `7c7778c6…` bare+GitHub · `filter-repo` **2.47.0** · `/tmp/split` отсутствует · ancestry YES · whitelist **1635** · SSH `ls-remote` `64127b9e`). **Execution-plan dry-run:** счётчики §3.1 **8/8 OK**, корни коммитов **4/4 OK**, leak dry-run **0/0/0/0**, coverage **1615/1635** (20 = только gpu-hub), **52** пересечения = **намеренные дубли** (LICENSE ×4, `ANDROID_WEB_PARITY.md`, `docker/worker/*`, общие доки), `packages/` **30/30** с одним владельцем, `bash -n` листа **6/6 rc=0**. **Внесены guard'ы:** пустой bare (I-17), `origin == $NEW` (защита от push не в тот remote), `check_bare_snapshot` вместо жёсткого равенства (иначе ложный FAIL GO-14 после каждого docs-коммита), уточнены формулировки «refs == `$BARE`» (docs-ветка = снимок момента). **FINDING-1 (не блокер):** на GitHub GPU Hub есть stray-ref `refs/remotes/github/master = b95870f7…` (предок master; R-3 = A → не трогаем). **Стадия C этим аудитом НЕ авторизована** |
| **GO-05 (2026-10-04, эта ревизия)** | **`NEWBRANCH=main`** — owner-confirmation владельца зафиксирован письменно в задаче этого этапа и записан в `repository-split-pre-split-go-blockers.md` §6/§7.1; сверка read-only: GitHub API `default_branch=main` ×4 (`animastor-backend/-web/-android/-worker`), `git symbolic-ref HEAD = refs/heads/main` ×4, `$NEWBRANCH` — единственная переменная (`next-blockers` §4.1.0) → **GO-05 = CLOSED** |
| **Стадия B (2026-10-04, эта ревизия)** | **GO-08**: `git clone --mirror --no-local` → `/home/animastor/backups/animastor-pre-split-64127b9e.git` (**22 431 724 B**, независимая копия — 0 общих inode'ов; `rev-parse $SRC` = `64127b9e`, `master=$SRC`, 1653 коммита / 1635 файлов, `fsck` чисто, refs **6/6 на момент создания** — `master`/`tmp/parser-audit-backup` == `$BARE` и по сей день, docs-ветка в backup = снимок момента создания; **restore-дрилл**: fetch в чистый bare + checkout worktree → `master=64127b9e`, status 0). **GO-14**: BEFORE-snapshot `/home/animastor/backups/before-split-64127b9e-refs/` — `animastor.git` (6 refs, `master=64127b9e`) и `animastor-gpu-hub.git` (2 refs, **`master=HEAD=7c7778c6f313dad19eb403d8509cd297226ec7ea`**), +HEAD/config/count-objects/hook sha256, `MANIFEST.sha256` = 11/11 OK, режим только-чтение; сверка на стадии C — `check_bare_snapshot` (`next-blockers` §4.1.0: неизменяемые refs дословно + docs-ветка только fast-forward). **Писали только в новые каталоги `backups/`**: `$BARE`, GPU Hub, hook'и, 4 новых bare/GitHub — **не изменялись**; `filter-repo` / push / force-push / новый GPU Hub — **НЕ ВЫПОЛНЯЛИСЬ** |

Остаются **реальные pre-split блокеры**:

1. ~~**P6 — 2.8G < 5G**~~ → **ЗАКРЫТ (PASS)**: `df -B1 /` = **6 839 934 976 B**
   (≈6.4 GiB) ≥ 5G, перепроверено 2026-10-04; очистка не выполнялась;
2. ~~**P1 — PARTIAL (owner)**~~ → **ЗАКРЫТ (2026-10-04)**: 4 GitHub-репо пустые
   (4 × 200, `size=0`, 0 refs) **+ 4 bare + hooks (0755/91 байт byte-identical)
   + remote `github`** (GO-01…GO-04 = CLOSED/READY, I-16 закрыт);
   **push не выполнялся до стадии C** → **2026-10-04: первый push backend
   ВЫПОЛНЕН без force** (bare + GitHub = `f83f929c…`), web/android/worker
   push не выполнялся;
3. ~~**GO-05** — подтверждение владельцем `$NEWBRANCH = main`~~ → **ЗАКРЫТ
   (2026-10-04)**: `NEWBRANCH=main` подтверждён владельцем письменно (задача
   этого этапа) и зафиксирован в docs; сверка: GitHub `default_branch=main` ×4
   + `symbolic-ref HEAD = refs/heads/main` ×4;
4. **P4-гигиена — NOT YET EXECUTED**: каталог `workflow.json` существует,
   строка mount в `frontends/android/docker-compose.yml:41` не удалена
   (гигиена, не блокирует `filter-repo`);
5. **P5** — фактически подтверждено (`.github/` отсутствует, GitHub 404), но
   **письменного подтверждения владельца нет** (§FPSG.8 п.6);
6. **`tmp/parser-audit-backup`** — ветка `db5ff61f` **не удалена**; удаление —
   решение владельца (до него НЕ удалять).
7. ~~**стадия B — GO-08 / GO-14**~~ → **ВЫПОЛНЕНА (2026-10-04)**: durable
   backup `$BK` + BEFORE-snapshot refs обоих существующих bare; писали **только**
   в новые каталоги `backups/`;
8. **стадия C для BACKEND → ВЫПОЛНЕНА (2026-10-04)**: авторизация владельца
   получена, `filter-repo` + первый push **без force** + hook + GitHub/bare
   parity подтверждены (`f83f929c…`); **авторизация для web/android/worker
   этим gate'ом НЕ выдаётся** — это отдельные решения владельца.

**R-3 снят** (A = SELECTED, B = REJECTED — `repository-split-r3-decision.md`):
авторинг hub-CI разблокирован (в существующем репо), шаг 5 из очереди
исключён, `filter-repo` gpu-hub не выполняется.

P3 (npm E401) — **post-split publish** blocker, filter-repo не блокирует.
**Очистка диска не требуется**: P6 закрыт без неё (6.4G ≥ 5G); любые команды
очистки (`pip cache purge`, `/tmp`) — только по отдельному распоряжению
владельца, автоматически не выполняются.

**PHYSICAL SPLIT (backend): EXECUTED · git filter-repo (backend): EXECUTED ·
первый push БЕЗ force: EXECUTED · `Animastor/animastor-backend` = `f83f929c…`.**
**PHYSICAL SPLIT (web / android / worker): NOT EXECUTED.**
**git filter-repo (web / android / worker / gpu-hub): NOT EXECUTED.**
**FORCE-PUSH: NOT EXECUTED ни для одного репозитория ·
`Animastor/animastor-gpu-hub` / hooks / `master` / backup / snapshot /
`tmp/parser-audit-backup`: NOT MODIFIED · npm publish: NOT EXECUTED.**
