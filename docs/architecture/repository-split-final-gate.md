# Repository Split — FINAL GATE (GO/NO-GO)

> **FINAL STATUS: BLOCKED — PHYSICAL SPLIT NOT AUTHORIZED**
> **PHYSICAL SPLIT: NOT EXECUTED**
> **git filter-repo: NOT EXECUTED**
> **force-push: NOT EXECUTED · новых GitHub-репозиториев: NOT CREATED ·
> `Animastor/animastor-gpu-hub` / bare `animastor-gpu-hub.git`: NOT MODIFIED ·
> hooks: NOT MODIFIED · npm publish: NOT EXECUTED**

Единственный авторитетный статус-документ финального pre-split gate'а.
Исторические аудиты на более ранних SHA остаются в
`repository-split-next-blockers.md` (§FPSG, §FINAL SPLIT HANDOFF) как журнал;
при расхождении чисел и SHA действует **этот** документ.

---

## 0. Frozen source (точка отсчёта)

| Поле | Значение |
|---|---|
| **Source SHA (единственный)** | **`64127b9e1dea2ac528a572b51b90a542b70c5ebb`** |
| Branch | `c21.4-physically-extract-analysis-from-backend` (= `origin/…`) |
| **Tip ветки (HEAD)** | **`e768a7ccaa5a994a0698a4e5864f7271de536aff`** — документационный tip **до** doc-коммита этого обновления = frozen source **+ 5 doc-коммитов** (`5c34de54`, `2c6fdec6`, `c8341258`, `e64b6afc`, `e768a7cc`); GitHub compare `64127b9e…e768a7cc` = ровно эти **5** документационных коммитов; **источник истины по числу** — `git rev-list --count 64127b9e…HEAD`; каждый doc-коммит сдвигает tip на +1 и меняет только те же 2 файла |
| **tip ≠ source** | tip — **только** документационный HEAD ветки; **`git filter-repo` выполняется исключительно от `64127b9e…`** (§0, §1, handoff §1/§10) |
| DAG | `master` — прямой предок source (**YES**); source — прямой предок tip (**YES**); после source **5** коммитов — все документационные, затронуты **только** `docs/architecture/{repository-split-final-gate,repository-split-next-blockers}.md`; merge = **0**, tags = **0** |
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
| C | Command-sheet audit (§4.1.0–4.1.6) | **PASS после 2 исправлений**: пути = §8 (кроме 3 задокументированных no-op/X-1 исключений), `--path-rename` отсутствует, все URL = `github.com/Animastor`, `SRC` объявлен, gpu-hub-шаг гейтится на R-3=B; **устаревшие счётчики 1040→1045 и 41→44 исправлены** | read-only аудит (см. §3) | нет |
| P1 | 5 GitHub-репозиториев (backend/web/android/worker + gpu-hub) | **BLOCKED (OWNER)** | bare: только `animastor.git` + `animastor-gpu-hub.git`; GitHub API (read-only): `animastor-backend` / `animastor-web` / `animastor-android` / `animastor-worker` = **HTTP 404**; `Animastor/animastor-gpu-hub` = **HTTP 200** (private=false, size=105, default_branch=master, created 2026-09-06T16:19:30Z, pushed 2026-09-06T18:07:10Z, HEAD `7c7778c`, 43 коммита, forks=0, `/contents` непустой); **самостоятельно не создаются** | **ДА** (owner) |
| P2 | FF `master` → source | **PASS (CLOSED)** | `git merge --ff-only 64127b9e…` + `git push origin master` → `04da33ea..64127b9e`, без force | нет |
| P3 | npm-грант (`npm whoami`) | **FAIL — E401** (перепроверено 2026-10-03) | `npm whoami` → `E401 401 Unauthorized`; `npm view` работает; **не чинить в рамках gate** | только **post-split publish** (не блокирует filter-repo) |
| P6 | Диск ≥ 5G свободно | **FAIL — 2.8G** | `df -B1 /` (preflight, 2026-10-03): total 105 496 965 120, used 98 020 900 864, **avail 2 958 962 688 B ≈ 2.96 GB / 2.76 GiB** (`df -h` 2.8G), 98%; `/dev/sda2` ext4, **одна** точка монтирования `/`; ничего не удалялось (за сессию preflight: +2 guard-образа Docker от прогона G4/G5, disk −~30 МБ) | **ДА** |
| R-3 | GPU Hub: A (адаптация) / B (замена историей) | **OWNER DECISION** | существующий `Animastor/animastor-gpu-hub` = `7c7778c` (bare идентичен), read-only, **не изменён и не заменён**; **оба варианта документированы**: A/B — `repository-split-pre-split-fixes.md` §5 (+ 7-пунктовый список переноса в `repository-split-next-blockers.md` §R-3), B-процедура = backup → заморозка hook → filter-repo §8.5 → force-push → верификация; командный лист §4.1.5 и карта §5.5 **гейтятся на R-3=B** (в этом gate исправлена неточная ссылка «процедура §8.5 prep-plan» → §5 «Вариант B» pre-split-fixes) | **ДА** (owner) |
| P4 | `workflow.json` / stale android-mount гигиена | **READY (не выполнялась)** | пустой каталог, не tracked | нет |
| P5 | `.github/` отсутствует в монорепо | **CONFIRMED** | `test -d .github` → отсутствует | нет |
| FS | **PHYSICAL SPLIT** | **NOT EXECUTED** | разделение не выполнялось; новые bare/GitHub-репо не создавались | — |
| FR | **`git filter-repo`** | **NOT EXECUTED** | не запускался; история не переписывалась; force-push не выполнялся | — |
| GH | Hooks / существующий GPU Hub | **NOT MODIFIED** (перепроверено 2026-10-03) | `hooks/post-receive` монорепо не тронут (mtime 2026-08-22 07:29:58Z); bare `animastor-gpu-hub.git` HEAD = `7c7778c`; GitHub `Animastor/animastor-gpu-hub` = 200, pushed 2026-09-06T18:07:10Z | — |
| B5 | GPU Hub artifact flow (post-split путь) | **READY — механика DONE и верифицирована** | dual-stage Dockerfile (stager + `fetch-pinned-assets.sh`, пин по tag/digest), `artifacts.lock.json` (`sha256_tree` + `sha256_asset`), G5 реально прогоняет post-split слой (materialise 4 zip → sha256 → tamper-отказ), per-run cache-bust `RUN_ID` | нет |

**Сводка blocker'ов:** G1–G5 = PASS · whitelist = PASS · command-sheet = PASS ·
тесты = PASS (2 known pre-existing) · **P6 = FAIL (2.8G < 5G)** ·
**P1 = BLOCKED** · **R-3 = UNDECIDED** · P3 = post-split only.

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

- **Tip ветки (после doc-коммитов этого gate'а): 1636 / 1636 / 0** — сюда
  добавился только этот документ; для `filter-repo` релевантна строка **1635**.

- **Дубли (намеренные, задекларированы §8):** 75 файлов в >1 репо, сумма с
  пересечением **1714** (= 1635 + 79 instance'ов): backend+web 31,
  backend+gpu-hub 23, backend+worker 18, android+web 1, backend+worker+gpu-hub 1,
  все 5 репо 1 (`LICENSE`).
- `LICENSE` → все 5; `JOB_PROTOCOL_V2.md` → backend+worker+gpu-hub;
  `PHASE_10*` → backend+gpu-hub; `ANDROID_WEB_PARITY.md` → web+android.
- Устаревшие числа в старых доках: **1626 → 1635**, backend **1040 → 1045**,
  gpu-hub §8 **41 → 45** (в командном листе — **44**, минус `gpu-hub-rebuild.sh`
  при R-3=B) — исправлено в этом же gate.

---

## 3. Command-sheet audit (§4.1.0–4.1.6, `repository-split-next-blockers.md`)

| Проверка | Результат |
|---|---|
| Пути `--path …` командного листа ↔ §8 | совпадают, кроме 3 задокументированных исключений: `workflow.json` (no-op), `local.properties` (no-op), `gpu-hub-rebuild.sh` (X-1 — исключается **при R-3=B**) — все три упоминаются **только** в строках-комментариях `# НЕТ …`, исполняемых путей не содержат |
| `--path-rename` | **отсутствует** |
| URL push | **только** `github.com/Animastor/…` |
| `SRC=` | объявлен и обязан равняться frozen source (§0) |
| gpu-hub-шаг | гейтится на **R-3 = B** |
| Счётчики `test "$(git ls-files \| wc -l)" -eq …` | backend **1040 → 1045**, gpu-hub **41 → 44** (исправлены; §8.5 = 45 файлов, минус `gpu-hub-rebuild.sh` при R-3=B — X-1); web 349, android 217, worker 58 — уже верны. Сверены **на `$SRC`** (`git ls-tree -r --name-only $SRC` под путями §8), а не на tip'а ветки |

---

## 4. External prerequisites (не закрываются этим gate'ом)

| ID | Что нужно | Статус | Кто |
|---|---|---|---|
| **P1** | создать `animastor-backend`, `animastor-web`, `animastor-android`, `animastor-worker` (GitHub 200 + пустой bare + hook) | **ABSENT** (4 × HTTP 404, API перепроверен read-only) | owner; **GPU Hub отдельно не создавать** (уже существует, 200) |
| **R-3** | зафиксировать **A** или **B** по `Animastor/animastor-gpu-hub` | **UNDECIDED** (repo read-only, `7c7778c`; оба варианта поддержаны документацией — см. §1 R-3) | owner; до решения не авторить hub-CI и не запускать §8.5 |
| **P6** | ≥5G свободно для клонов/фильтрации | **2 958 962 688 B (≈2.96 GB) — FAIL** (preflight 2026-10-03); ничего не очищалось. Кандидаты очистки **только по распоряжению владельца**: `pip cache purge` ≈4.4G → ≈7.2G, `npm cache clean --force` ≈0.8G, `/tmp`-мусор установщиков ≈1.4G. Старые доки (readiness §9, pre-split-fixes §7/§8) упоминают **≥3 GB** — устаревший, менее консервативный порог; актуальный **≥5G** (§P6, этот документ) | host; очистка — owner |
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

# BLOCKED — PHYSICAL SPLIT NOT AUTHORIZED

Закрыто этим gate'ом: **G1–G5 ALL GREEN** (дважды: source + tip), whitelist
**0 uncovered**, command-sheet **консистентен** (перепроверен read-only на
`$SRC`), **P2 (master FF) выполнен**, GPU Hub artifact flow **верифицирован
end-to-end (G5, включая tamper-отказ)**, тесты **без новых регрессий**
(2 pre-existing: IB-G15, T9).

Актуальные факты (перепроверка read-only на tip `e768a7cc…`, до doc-коммита
этого обновления):

| Поле | Значение |
|---|---|
| **HEAD (tip, документационный)** | `e768a7ccaa5a994a0698a4e5864f7271de536aff` = source + **5 doc-коммитов** — **не** frozen source |
| **Frozen source** | `64127b9e1dea2ac528a572b51b90a542b70c5ebb` |
| **master** | `64127b9e…` == source == `origin/master` (не перемещался в этом gate) |
| **P6** | **FAIL** — 2 958 962 688 B (≈2.96 GB / 2.76 GiB) < 5G; очистка не выполнялась |
| **P1** | **OPEN** — 4 × HTTP 404; `animastor-gpu-hub` = 200 (не трогали) |
| **P3** | **E401** (только post-split publish) |
| **R-3** | **OWNER DECISION** (A и B поддержаны документацией) |
| Git | merge 0, tags 0, working tree чист; изменённые после source файлы — только `docs/architecture/{repository-split-final-gate,repository-split-next-blockers}.md` |
| GPU Hub safety | bare `7c7778c` + GitHub 200 + hook монорепо 2026-08-22 — **не изменены** |
| **Read-only preflight (2026-10-03)** | G1–G5 **ALL GREEN** (`scripts/split-guards/run-all.sh`, лог `/tmp/opencode/preflight-g1g5.log`) · whitelist §8 = **1635 / 1635 / 0 uncovered** на `$SRC` · command-sheet audit **PASS** на `$SRC` · gpu-hub `npm test` = **22/0** · `backend` `test:arch` = **979 passing / 2 failing** (IB-G15 `installer-package-boundary.test.js:243`, T9 `phase5-runtime-result.test.js:401` — **pre-existing, воспроизводятся**) · GitHub **4 × 404 + gpu-hub 200** · `npm whoami` **E401** · `.github/` отсутствует · `workflow.json` существует (untracked) · `git filter-repo` **не запускался** (нет выходных каталогов split), force-push не выполнялся |

Остаются **реальные pre-split блокеры**:

1. **P6 — 2.8G < 5G** (технический блокер, фильтрация 5 репо не влезает);
2. **P1 — 4 целевых репозитория отсутствуют** (owner);
3. **R-3 — не выбран вариант A/B** (owner).

P3 (npm E401) — **post-split publish** blocker, filter-repo не блокирует.
Очистка диска (`pip cache purge` и т.п.) — **только по распоряжению владельца**.

**PHYSICAL SPLIT: NOT EXECUTED.**
**git filter-repo: NOT EXECUTED.**
**FORCE-PUSH: NOT EXECUTED · новых GitHub-репозиториев: NOT CREATED ·
`Animastor/animastor-gpu-hub` / hooks: NOT MODIFIED · npm publish: NOT EXECUTED**
