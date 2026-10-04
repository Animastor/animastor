# Repository Split — FINAL GATE (GO/NO-GO)

> **FINAL STATUS: BLOCKED — PHYSICAL SPLIT NOT AUTHORIZED**
> **PHYSICAL SPLIT: NOT EXECUTED**
> **git filter-repo: NOT EXECUTED**
> **force-push: NOT EXECUTED · GitHub-репозитории этим gate'ом: NOT CREATED ·
> `Animastor/animastor-gpu-hub` / bare `animastor-gpu-hub.git`: NOT MODIFIED ·
> hooks: NOT MODIFIED · npm publish: NOT EXECUTED**
> **R-3 = A (SELECTED) · R-3 = B: REJECTED (не исполняется)**
> **P6 = CLOSED / PASS · P1 = PARTIAL (созданы владельцем 2026-10-03)**

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
| P1 | 4 новых GitHub-репозитория (backend/web/android/worker); `animastor-gpu-hub` уже существует | **PARTIAL — GitHub DONE, локальная часть BLOCKED (OWNER)** | **Перепроверка read-only 2026-10-04**: GitHub API `animastor-backend` / `-web` / `-android` / `-worker` = **HTTP 200**, `private=false`, **`size=0`**, **0 refs** (`git ls-remote` ssh rc=0, пусто) — созданы владельцем **2026-10-03T23:53–23:55Z**, `default_branch=main`; `Animastor/animastor` = 200 (`master`); `Animastor/animastor-gpu-hub` = **HTTP 200** (private=false, size=105, default_branch=master, created 2026-09-06T16:19:30Z, pushed 2026-09-06T18:07:10Z, HEAD `7c7778c`, 43 коммита, forks=0, `/contents` непустой). **Остаётся локальная часть:** `/home/animastor/repos/` содержит только `animastor.git` и `animastor-gpu-hub.git` → **4 bare отсутствуют**, `hooks/post-receive` и remote `github` **не созданы** (GO-02/GO-03/GO-04 = BLOCKED). **GPU Hub отдельно не создавать** | **ДА** (owner: bare + hook + remote `github`) |
| P2 | FF `master` → source | **PASS (CLOSED)** | `git merge --ff-only 64127b9e…` + `git push origin master` → `04da33ea..64127b9e`, без force | нет |
| P3 | npm-грант (`npm whoami`) | **FAIL — E401** (перепроверено 2026-10-03) | `npm whoami` → `E401 401 Unauthorized`; `npm view` работает; **не чинить в рамках gate** | только **post-split publish** (не блокирует filter-repo) |
| P6 | Диск ≥ 5G свободно | **PASS — CLOSED (2026-10-04)** | `df -B1 /` (перепроверка 2026-10-04, одна команда): total 105 496 965 120, used 94 139 928 576, **avail 6 839 934 976 B ≈ 6.4 GiB (`df -h /` → 6.4G; владелец фиксировал 6.5G; значение колеблется — авторитетна команда)** ≥ `5 368 709 120` (≥5G) → **порог выполнен**, запас **1.27×** порога и **6.4×** измеренного минимума 1 GiB. **Очистка НЕ выполнялась и НЕ требуется.** Историческое значение pre-cleanup: **2 958 962 688 B (≈2.96 GB), FAIL, 2026-10-03** — сохранено только для audit trail | **нет** |
| R-3 | GPU Hub: A (адаптация) / B (замена историей) | **DECIDED — A (SELECTED); B = REJECTED** | **решение зафиксировано**: `repository-split-r3-decision.md`. Существующий `Animastor/animastor-gpu-hub` = `7c7778c` (bare и GitHub идентичны, 43 коммита) — **сохраняется без изменений**, его standalone history **канонична**; `filter-repo` для GPU Hub **не выполняется**, новый hub-репо **не создаётся**, force-push/overwrite/delete **запрещены**. Вариант B (backup → заморозка hook → filter-repo §8.5 → force-push) — **REJECTED / NOT SELECTED**, все его ветки в документах помечены N/A/REJECTED; командный лист §4.1.5 и карта §5.5 **неисполняемы** | **закрыто** (A) |
| P4 | `workflow.json` / stale android-mount гигиена | **NOT YET EXECUTED (перепроверено 2026-10-04)** | `/home/animastor/animastor/workflow.json` — **по-прежнему существует** (пустой каталог `root:root`, 2026-08-24, untracked, `.gitignore:43`); `frontends/android/docker-compose.yml:41` — строка `./workflow.json:/workflow.json:ro` **осталась**; корневой `docker-compose.yml` mount **удалён** (`bd66bae6`), **но** живой контейнер `animastor-backend` (старт 2026-09-04) всё ещё несёт этот bind-mount (stale mount контейнера) | **нет** (гигиена; владельцу) |
| P5 | `.github/` отсутствует в монорепо | **CONFIRMED (перепроверено 2026-10-04)** | `test -d .github` → отсутствует; `git ls-tree -r --name-only 64127b9e \| grep '^.github/'` → **0**; GitHub API `Animastor/animastor/contents/.github/workflows` → **404**; у существующего GPU Hub свои workflows в **его** репо (`ci.yml`, `ghcr-release.yml`) — это не монорепо | нет (интерпретация — owner, §FPSG.8 п.6) |
| FS | **PHYSICAL SPLIT** | **NOT EXECUTED** | разделение не выполнялось; новые bare/GitHub-репо не создавались | — |
| FR | **`git filter-repo`** | **NOT EXECUTED** | не запускался; история не переписывалась; force-push не выполнялся | — |
| GH | Hooks / существующий GPU Hub | **NOT MODIFIED** (перепроверено 2026-10-03) | `hooks/post-receive` монорепо не тронут (mtime 2026-08-22 07:29:58Z); bare `animastor-gpu-hub.git` HEAD = `7c7778c`; GitHub `Animastor/animastor-gpu-hub` = 200, pushed 2026-09-06T18:07:10Z | — |
| B5 | GPU Hub artifact flow (post-split путь) | **READY — механика DONE и верифицирована** | dual-stage Dockerfile (stager + `fetch-pinned-assets.sh`, пин по tag/digest), `artifacts.lock.json` (`sha256_tree` + `sha256_asset`), G5 реально прогоняет post-split слой (materialise 4 zip → sha256 → tamper-отказ), per-run cache-bust `RUN_ID` | нет |

**Сводка blocker'ов:** G1–G5 = PASS · whitelist = PASS · command-sheet = PASS ·
тесты = PASS (2 known pre-existing) · **P6 = CLOSED / PASS (6.4G ≥ 5G,
2026-10-04; старое 2.9G — историческое)** · **P1 = PARTIAL** (GitHub-repo 4 × 200
пустых, но **bare + hook + remote `github` отсутствуют**) ·
**R-3 = CLOSED (A; B REJECTED)** · P3 = post-split only ·
P4/P5-гигиена = **NOT YET EXECUTED**.

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
| **P1** | создать `animastor-backend`, `animastor-web`, `animastor-android`, `animastor-worker` (GitHub 200 + пустой bare + hook **+ remote `github`**) | **PARTIAL — GitHub DONE (4 × HTTP 200, `size=0`, 0 refs, созданы 2026-10-03, `default_branch=main`), локальная часть ABSENT**: `/home/animastor/repos/` = только `animastor.git` + `animastor-gpu-hub.git` → **4 bare не созданы**, hook и remote `github` отсутствуют. План — pre-split-go-blockers §2; блокеры **I-16** (нет remote `github` → hook падает), **I-17** (непустой repo → нужен запрещённый force-push; сейчас репо пустые — условие выполнено), **I-18** (SSH read-права подтверждены 2026-10-04: `git ls-remote git@github.com:Animastor/<name>.git` rc=0, push-права — при первом push) | owner; **GPU Hub отдельно не создавать** (уже существует, 200) |
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

# NO-GO — PHYSICAL SPLIT NOT AUTHORIZED (статусы разделены ниже)

**GO НЕ установлен автоматически.** Категории по этому gate'у:

| Категория | Что в ней сейчас |
|---|---|
| **CLOSED** (закрыто фактически) | **P2** (`master` = `64127b9e` = `origin/master`) · **R-3** (= A, B REJECTED) · **P6** (≥5G: `6 839 934 976 B`, 2026-10-04) · G1–G5 (ALL GREEN) · whitelist 1635/1635 · command-sheet audit · 2 pre-existing теста подтверждены |
| **READY** (готово, подтверждено read-only, исполнения не требует) | P1-GitHub (4 × 200, `size=0`, 0 refs) · P5-facts (`.github/` отсутствует, GitHub 404) · `NEWBRANCH=main` (значение есть) · GO-07 (R-3 = A) · GO-09 (N/A) · GO-10…GO-13, GO-15 |
| **BLOCKED** (владелец/внешнее, без этого запрет) | **P1-local**: 4 bare + hook + remote `github` (GO-02…GO-04) · **GO-05**: подтверждение `$NEWBRANCH` владельцем · **P3**: npm E401 (только post-split publish) |
| **NOT YET EXECUTED** (сознательно не выполнялось) | **физический split** · **`git filter-repo`** · **force-push** · push/mirror в GPU Hub · создание bare/hooks · **P4-гигиена** (`workflow.json`, android-mount) · удаление `tmp/parser-audit-backup` · авторинг workflows в новых репо · `npm publish` |

**Итоговый вердикт: NO-GO** — физический split **не авторизован**.

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
| **P1** | **PARTIAL** — GitHub: 4 × HTTP **200**, `size=0`, **0 refs** (созданы владельцем 2026-10-03); VPS: **4 bare / hook / remote `github` отсутствуют**; `animastor-gpu-hub` = 200 (не трогали) |
| **P3** | **E401** (только post-split publish) |
| **R-3** | **CLOSED — A (SELECTED)**; B = **REJECTED** (`repository-split-r3-decision.md`) |
| Git | merge 0, tags 0, working tree чист; изменённые после source файлы — **только `docs/architecture/*.md`** (набор — `git diff --name-only 64127b9e..HEAD`) |
| GPU Hub safety | bare `7c7778c` + GitHub 200 + hook монорепо 2026-08-22 — **не изменены**; **R-3 = A подтверждает: они и не будут меняться** |
| **Read-only preflight (2026-10-03, исторический)** | G1–G5 **ALL GREEN** (`scripts/split-guards/run-all.sh`, лог `/tmp/opencode/preflight-g1g5.log`) · whitelist §8 = **1635 / 1635 / 0 uncovered** на `$SRC` · command-sheet audit **PASS** на `$SRC` · gpu-hub `npm test` = **22/0** · `backend` `test:arch` = **979 passing / 2 failing** (IB-G15 `installer-package-boundary.test.js:243`, T9 `phase5-runtime-result.test.js:401` — **pre-existing, воспроизводятся**) · GitHub **4 × 404 + gpu-hub 200** · `npm whoami` **E401** · `.github/` отсутствует · `workflow.json` существует (untracked) · `git filter-repo` **не запускался** (нет выходных каталогов split), force-push не выполнялся |
| **Read-only перепроверка (2026-10-04, эта ревизия)** | `df -B1 /` → avail **6 839 934 976 B** → **P6 PASS** · GitHub API ×7 → **backend/web/android/worker = 200, `size=0`, 0 refs** (`git ls-remote` ssh rc=0), `animastor` = 200, `animastor-gpu-hub` = 200 (releases 0, tags 0) · `/home/animastor/repos/` → **4 bare отсутствуют** · `workflow.json` **существует** (пустой каталог) · `frontends/android/docker-compose.yml:41` mount **остался** · контейнер `animastor-backend` несёт stale bind-mount `workflow.json` · ветка `tmp/parser-audit-backup` (`db5ff61f`) **существует** локально и в bare · `master` = `64127b9e` = `origin/master`, HEAD впереди на 10 doc-коммитов · `.github/` отсутствует (tree + GitHub 404) · `npm whoami` → **E401** · `/tmp/split` отсутствует · **ничего не создавалось/не удалялось/не перезаписывалось** |

Остаются **реальные pre-split блокеры**:

1. ~~**P6 — 2.8G < 5G**~~ → **ЗАКРЫТ (PASS)**: `df -B1 /` = **6 839 934 976 B**
   (≈6.4 GiB) ≥ 5G, перепроверено 2026-10-04; очистка не выполнялась;
2. **P1 — PARTIAL (owner)**: GitHub-репозитории **созданы** (4 × 200, пустые,
   `size=0`, 0 refs), но **не созданы 4 bare, `post-receive`-hook'и и remote
   `github`** (GO-02/GO-03/GO-04 = BLOCKED) — без них первый push невозможен
   (I-16);
3. **GO-05** — подтверждение владельцем `$NEWBRANCH = main` (значение есть,
   подтверждения нет);
4. **P4-гигиена — NOT YET EXECUTED**: каталог `workflow.json` существует,
   строка mount в `frontends/android/docker-compose.yml:41` не удалена
   (гигиена, не блокирует `filter-repo`);
5. **P5** — фактически подтверждено (`.github/` отсутствует, GitHub 404), но
   **письменного подтверждения владельца нет** (§FPSG.8 п.6);
6. **`tmp/parser-audit-backup`** — ветка `db5ff61f` **не удалена**; удаление —
   решение владельца (до него НЕ удалять).

**R-3 снят** (A = SELECTED, B = REJECTED — `repository-split-r3-decision.md`):
авторинг hub-CI разблокирован (в существующем репо), шаг 5 из очереди
исключён, `filter-repo` gpu-hub не выполняется.

P3 (npm E401) — **post-split publish** blocker, filter-repo не блокирует.
**Очистка диска не требуется**: P6 закрыт без неё (6.4G ≥ 5G); любые команды
очистки (`pip cache purge`, `/tmp`) — только по отдельному распоряжению
владельца, автоматически не выполняются.

**PHYSICAL SPLIT: NOT EXECUTED.**
**git filter-repo: NOT EXECUTED.**
**FORCE-PUSH: NOT EXECUTED · новых GitHub-репозиториев: NOT CREATED ·
`Animastor/animastor-gpu-hub` / hooks: NOT MODIFIED · npm publish: NOT EXECUTED**
