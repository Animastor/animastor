# Repository Split — Next Blockers (после `b7e2f7cd`)

> **АКТУАЛЬНОЕ СОСТОЯНИЕ → `repository-split-final-gate.md`.** Авторитетный
> GO/NO-GO по финальному pre-split gate'у, frozen source и whitelist'ам — там
> (source SHA **`64127b9e1dea2ac528a572b51b90a542b70c5ebb`**, `master` ==
> source, **P2 закрыт**). В этом файле **обновлены** текущие утверждения:
> source SHA/`SRC`, whitelist-числа (**1635/1635**, backend **1045**, gpu-hub
> **45**), счётчики command sheet, статусы **P2/P6**, reference'ы на HEAD
> (§7.5 и «этот коммит» → фактические doc-коммиты). Формулировки со словами
> «на `b7e2f7cd`»/«на `e1c63073`»/«на `e6763c67`»/«на `7df461fa`» —
> **исторические факты** аудитов на тех SHA и не переписываются; **текущий tip
> ветки — только документационные коммиты после `64127b9e…` и source'ом
> (`git filter-repo`) не является**.

Продолжение цепочки: `repository-split-pre-split-fixes.md` (`bd66bae6`, верификация
№2 — `834987a7`) → `B7 closed` (`4d53be37`, `35ba2b82`) → B9/P4/P6/B5 finalize
(`e1c63073`) → документационная финализация (`4f947c56`) → **FINAL PRE-SPLIT
GATE** (`3505286b`, факт-аудит на `b7e2f7cd`, §FPSG ниже) → **FINAL PRE-SPLIT
TECHNICAL CLOSURE** (`e6763c67`, X-1/X-2, lock-зависимости, финальный grep,
сверка whitelist) → **FINAL SPLIT HANDOFF** (первоначальная запись — на `7df461fa`;
дальше **только** документационные коммиты этого gate'а **после** frozen source
`64127b9e…`, §FINAL SPLIT HANDOFF ниже).

> **FINAL PRE-SPLIT GATE** выполнен на HEAD `b7e2f7cd73e0320b90f298226a4510bb1ae74e43`
> (ветка `c21.4-physically-extract-analysis-from-backend`). Результаты
> перепроверки фактов — §FPSG; сводный блок — в конце документа.
> **FINAL PRE-SPLIT TECHNICAL CLOSURE** (закрывающий аудит X-1, X-2, package-lock
> зависимостей, финального grep и сверки whitelist §8) — на HEAD **`e6763c67`**,
> read-only. **FINAL SPLIT HANDOFF** — frozen source, owner decisions, точная
> карта извлечения, command sheet, lock-процедура, X-1…X-4, whitelist и финальный
> grep — **первоначально** на HEAD **`7df461fa`**, далее актуализирован только
> документационными коммитами **после** frozen source **`64127b9e…`** (§1);
> **`7df461fa` — не frozen source** и не текущий tip. Физический split **не выполнялся**.

**Разделение коммитов (важно для чтения документа):**

- **`e1c63073`** — commit, на котором выполнялись все tests/mechanical
  verification (B9/P4/P6/B5, locks, npm ci, test suites, Docker build,
  tamper test). Результаты этих проверок — факты на `e1c63073`.
- **`4f947c56`** — documentation-only commit: оформляет и уточняет результаты
  этих проверок (переписанная матрица B9, уточнённые формулировки P4/P6/B5,
  разделение фактов по коммитам). **Тесты НЕ перезапускались на `4f947c56`** —
  этот commit не меняет код, тесты, lock-файлы или Dockerfile.
- **`3505286b`** — FINAL PRE-SPLIT GATE (§FPSG) и закрывающий технический аудит
  (§FINAL PRE-SPLIT TECHNICAL CLOSURE). Только этот документ; все проверки —
  read-only (grep, python-разбор, `npm ci --dry-run`). **Ни один новый
  blocker не обнаружен**: X-1, X-2, package-lock зависимости, финальный grep и
  сверка whitelist классифицированы как **EXPECTED PRE-SPLIT** либо
  **POST-SPLIT**.

Физический split **не выполнялся** (ограничения соблюдены: без filter-repo,
force-push, новых GitHub-репо, npm publish, изменений существующих GPU
Hub-репозиториев). B7 считается **ЗАКРЫТЫМ**.

Статусы: **DONE** — закрыто · **READY** — код/план готовы, исполнение по
триггеру · **POST-SPLIT** — возможно только после физического разделения ·
**BLOCKED** — ждёт внешнего действия · **OWNER DECISION** — требуется решение
владельца.

## 0. Сводная таблица

| Blocker | Status | Что осталось | Как закрывается |
|---|---|---|---|
| B1 backend deps/mounts | **DONE** (`bd66bae6`) | — | — |
| B2 backend lock npm | **DONE** (`834987a7`, re-verified `e1c63073`) | — | — |
| B3 web lock npm | **DONE** (`834987a7`, re-verified `e1c63073`) | — | — |
| B4 exports | **DONE** (инвариант, G2) | — | — |
| B5 artifact scheme | **READY** (механика DONE, re-verified на `b7e2f7cd` включая tamper; **G5 постсплит-путь прогнан на `64127b9e`**) | POST-SPLIT: реальные Release-assets (4 zip ещё не существуют) и digest-pin базовых образов. **Сделано pre-split:** dual-stage Dockerfile + `scripts/fetch-pinned-assets.sh` (stager fetch по tag/pin), `sha256_asset` в `artifacts.lock.json`, per-run cache-bust `RUN_ID` | §B5; mechanical (`e1c63073`, `--check` перезапущен на `b7e2f7cd`): lock `--check` in sync ✓, Docker gate 4/4, check-artifacts 6/6, tamper exit 1 ✓; **G5 на `64127b9e`:** 4/4 assets materialised + sha256 verified, tampered asset rejected, lock/tree mismatch rejected, `check-artifacts.sh` 6/6 в standalone-образе |
| B6 sync-protocol npm | **DONE** (`bd66bae6`, `--check` перезапущен на `b7e2f7cd` → exit 0) | — | — |
| B7 tests disposition | **DONE** (`35ba2b82`; `test:arch` перезапущен на `b7e2f7cd`) | — | standalone-safety применена; монорепо **979/2** (IB-G15, T9 — pre-existing), постсплит-симуляция 923/24/2 (только pre-existing) |
| B8 web canonical build | **DONE** (`cced5dd3`, re-verified on `e1c63073`; агрегатор `frontends/app/scripts/build-packages.cjs` присутствует на `b7e2f7cd`) | — | `build:packages` 13/13 в обоих мирах |
| B9 CI | **READY (FINAL matrix DONE, `4f947c56` — doc finalization; verification — `e1c63073`; `.github/` отсутствует — re-verified на `b7e2f7cd`)** | создание workflows в новых репо (9 unique workflow files / 12 workflow entries по матрице §B9.2); hub-CI — **R-3 = A принято**: авторится в **существующем** `Animastor/animastor-gpu-hub` | POST-SPLIT по матрице §B9.2; в монорепо не создаётся (P5) |
| B10 hook монорепо | **DONE (monorepo hook не изменён; содержимое сверено на `b7e2f7cd`)** | — | split-bare получают собственные hooks на этапе P1 |
| B11 deploy cutover | POST-SPLIT | — | после filter-repo |
| B12 root package.json | **DONE** (`bd66bae6`; `package.json` в корне отсутствует — re-verified на `b7e2f7cd`) | — | — |
| P1 4 GitHub-репо + 4 bare | **CLOSED (2026-10-04)**: GitHub-репо **созданы владельцем** (4 × HTTP **200**, `size=0`, 0 refs, `default_branch=main`, 2026-10-03); **4 bare созданы 2026-10-04** — 0 refs/0 objects, `HEAD=refs/heads/main`, hook **0755/91 байт byte-identical**, remote `github` настроен | `/home/animastor/repos/` = `animastor.git`, `animastor-gpu-hub.git` **+ 4 новых bare** | ~~руками владельца~~ **выполнено**; **push не выполнялся**; см. §FPSG.3 |
| P2 FF master | **DONE — выполнен в FINAL GATE** (`04da33ea` → **`64127b9e`**, обычная экспедиция, 0 behind / 0 ahead; `master` = `origin/master` = frozen source) | — | `git merge --ff-only 64127b9e…` уже выполнен и запушен; исходная точка split = `64127b9e…` — `repository-split-final-gate.md` §0 |
| P3 npm token | **BLOCKED (OWNER)** | E401 перепроверен на `b7e2f7cd`; `npm view` работает | новый грант; нужен для B5-Release/NPM publish (post-split) |
| P4 workflow.json | **NOT YET EXECUTED** (re-verified **2026-10-04**: каталог существует; `frontends/android/docker-compose.yml:41` mount остался; у живого контейнера `animastor-backend` — stale bind-mount) | удалить пустой каталог; android-compose-mount stale | команда в §P4; НЕ выполнялась |
| P5 CI-инфраструктура | POST-SPLIT | — | репо должны существовать; **расхождение с prep-plan §11.4 — §FPSG.4 п.2, §FPSG.8 п.6** |
| P6 диск | **CLOSED / PASS (2026-10-04)** — **6 839 934 976 B (≈6.4 GiB) ≥ 5G**; историческое pre-cleanup: 2.9G (FAIL, 2026-10-03) | — | §P6; **очистка НЕ выполнялась и НЕ требуется**; ранее предложенные команды (`pip cache purge` и т.п.) — отозваны, выполняются только по отдельному распоряжению владельца |
| R-3 GPU Hub | **CLOSED — A (SELECTED), B = REJECTED** (`repository-split-r3-decision.md`; GitHub `Animastor/animastor-gpu-hub` = `7c7778c`, 43 коммита — не перезаписываются) | **A**: сохранить существующее репо; `filter-repo` gpu-hub не выполняется; новый репо не создаётся; force-push/overwrite/delete запрещены; standalone history канонична | §4.1.5 и §5.5 → **REJECTED / DO NOT EXECUTE**; hub CI авторится в существующем репо |
| R-5 parity | DONE (правило зафиксировано) | — | — |
| R-6 `test:connector-core` | **DONE** (переведён на `npm test --prefix node_modules/…`) | — | — |
| R-7 отставание master | **DONE — закрыто**: `master` выровнен (**P2**) до source **`64127b9e`** (0 behind / 0 ahead); исторический факт «150 до `b7e2f7cd`» сохранён ниже | — | — |
| X-1/X-2/X-3/X-4 | **POST-SPLIT (не pre-split blocker)** | действия в момент split/cutover — по строкам в §FINAL PRE-SPLIT TECHNICAL CLOSURE | там же |
| package-lock зависимости | **EXPECTED PRE-SPLIT** (117 записей / 6 локов) | порядок `backend/npm ci` → package `npm ci` (2 лока); регенерация после split | §FPSG.7, §FINAL PRE-SPLIT TECHNICAL CLOSURE |
| финальный grep (production) | **0 BLOCKER** | — | §FINAL PRE-SPLIT TECHNICAL CLOSURE |
| whitelist §8 vs `git ls-files` | **DONE — 1635/1635 покрыто** (пересчёт на `64127b9e`; старое число 1626 — до doc-коммитов) | исключить 2 no-op `--path` | §FPSG.5; полный протокол — `repository-split-final-gate.md` §2 |

---

## B5 — Release artifacts (final consistency + tamper verification)

### Что проверено (факт на `e1c63073`)

1. **4 группы, exact values** — `artifacts.lock.json` сверен с деревьями
   (double-entry независимый пересчёт в b5-тесте + `--check` + gate):

   | Group | source_repository | release_tag | asset_filename | version | files | sha256_tree |
   |---|---|---|---|---|---|---|
   | `worker-bundle` | animastor-worker | `worker-bundle-v2.1.1` | `animastor-worker-bundle-2.1.1.zip` | 2.1.1 | 7 | `713ac0118672a1c27fdf004b6db7dd09eefb0a1493fc96163f0e1dc611403d44` |
   | `hub-workflows` | animastor-backend | `hub-artifacts-v1` | `hub-workflows-v1.zip` | v1 | 9 | `0d51107d58f9774fb761fca7319bdeb637b02a18c0f8f92dfec713c97beca738` |
   | `installer-src` | animastor-backend | `hub-artifacts-v1` | `installer-src-v1.zip` | 0.1.0 | 32 | `6230aba4c8efc7256dfb55ec50300624ea02f6380198b8e37e5d62b4b3ac83ac` |
   | `install-manifests` | animastor-backend | `hub-artifacts-v1` | `install-manifests-v1.zip` | v1 | 3 | `46f3c26a4fd73ae0b70c7f4eb46bff74efb3ef1ba60d2becbe3a7d0393f1f3e3` |

2. **Dockerfile gate ordering** (re-verified by line numbers):
   - строка 6: `FROM alpine:3.19 AS stager`
   - строки 12–19: COPY 4 групп в `/staging/artifacts/…`
   - строка 28: `COPY …/artifacts.lock.json /staging/artifacts.lock.json`
   - строка 29: `COPY …/scripts/verify-staged-artifacts.sh /staging/…`
   - **строка 30: `RUN sh /staging/verify-staged-artifacts.sh …` ← SHA256 gate**
   - строка 33: `FROM node:20-slim` (runtime stage)
   - **строка 44: `COPY --from=stager /staging/artifacts/ /app/artifacts/`**
   - строки 47–53: bake-in RUN (4 dirs + worker package.json)
   - строка 56: `COPY scripts/check-artifacts.sh /app/scripts/…`

   Gate на **14 строк / полную stage-границу раньше** bake-in COPY.
   Invariant: любое изменение байта в любой из 4 групп меняет `sha256_tree`
   → gate валит сборку до `COPY --from=stager`.

3. **Digest formula** (shared, три реализации идентичны): `sha256` over sorted
   `"<sha256(file)>  <relpath>\n"` — C-locale path-sort, LF; writer
   (`tools/update-artifacts-lock.cjs`), gate (`scripts/verify-staged-artifacts.sh`,
   POSIX sh, busybox, без node/jq), b5-тест (independent double-entry).

4. **Verification order** (полная цепочка, все ступени зелёные здесь):
   1. `update-artifacts-lock.cjs --check` — lock freshness vs source trees;
   2. staging gate в docker build (stager, **pre-COPY**) — 4/4 groups match;
   3. bake-in RUN — 4 dirs + worker-bundle/package.json present;
   4. `check-artifacts.sh` post-build — **ALL CHECKS PASSED 6/6**
      (dirs, version, min_version compat, per-workflow SHA256, no monorepo
      leaks, installer entry points);
   5. **tamper test (executed here)**: clean staged tree → gate **exit 0**;
      one-byte append to `workflows/img-qwen-image.json` → gate **exit 1**
      («artifact 'hub-workflows' digest mismatch: staged=653af721… locked=0d51107d…»).
      Tamper resistance подтверждена эмпирически.

5. **Legacy `old_*.json`** (`old_img-qwen-image.json`, `old_video-ltx.json`):
   - входят в digest группы (`files: 9`);
   - **НЕ** входят в manifest baselines (`baseline_sha256` — только 7 активных:
     2 audio + 1 image + 4 video; re-verified grep по install-manifests);
   - исключены workflow loader'ом (manifest notes:
     `image/qwen-image.json` — «Legacy old_img-qwen-image.json is excluded by
     the workflow loader»; `video/ltx-2.3.json` — «Legacy old_video-ltx.json
     is excluded by the workflow loader»);
   - **Не считать активными artifact workflows; не удалять** — drift detection
     по группе остаётся активным (любое изменение байта в `old_*` меняет
     групповой digest и валит gate).

### Документационные дрейфы (зафиксированы; старые доки не переписывались)

| Doc | Дрейф | Канон |
|---|---|---|
| prep-plan §2.2 «workflows — 8 файлов» | фактически **9** (7 active + 2 legacy) | lock `files: 9`; drift задокументирован §B5 (этот документ) |
| prep-plan §2.2 «worker-bundle — 6 файлов» | фактически **7** в staging (6 manifest + package.json) | lock `files: 7`; drift задокументирован |
| prep-plan §2.1/§2.5, pre-split-fixes §8.1, final-readiness §B5: pin = `{…, sha256}` (asset) | реализовано `{…, files, sha256_tree}` — tree digest, **не** asset sha256 | next-blockers §B5 честно фиксирует gap; asset-sha256 — POST-SPLIT |
| final-readiness §B5 «SHA256-проверка ДО COPY не реализована» | **stale** — gate реализован (Dockerfile:28–30) | этот документ |
| pre-split-fixes FINAL STATUS «BLOCKED — до B5» | **stale** — B5 механика DONE; осталось POST-SPLIT | этот документ |
| execution-readiness §9 step 2: «stager на release-артефактах» — pre-split HARD | **противоречие** — next-blockers классифицирует как POST-SPLIT | этот документ (текущее состояние: stager COPY из монорепо) |

**Инвариант «незаметно другой артефакт невозможен»**: pre-split лок
фиксирует контрактом текущее состояние и делает дрейф **обнаружимым**
(gate + tamper-доказательство здесь); криптографический якорь против подмены
появится с SHA256 Release-asset'ов (POST-SPLIT, после P3).

**Осталось (POST-SPLIT)**: упаковка 4 asset-zip, публикация Release
(`worker-bundle-v2.1.1` в worker-репо; `hub-artifacts-v1` в backend-репо —
**3 asset**), добавление `sha256` (asset-архива) в lock, перевод stager с
монорепо-COPY на fetch pinned assets, digest-pin базовых образов
(`alpine:3.19`, `node:20-slim` → `@sha256:…`), G4/G5 в CI.

---

## B8 — canonical Web build

**Проблема**: `build:packages` был shell-однострочником с жёстким
`../../packages/animastor-web-*` — после выделения animastor-web путь исчезает.

**Реализовано**: `frontends/app/scripts/build-packages.cjs` — канонический
агрегатор с двухветочным resolve на каждый из 13 пакетов (fail-fast, без
symlink/file:, G1-инвариант не тронут):

1. sibling-checkout `../../packages/animastor-web-*` (монорепо, авторинг из src/) → `npm run build`;
2. npm-копия `node_modules/@animastor/<pkg>` (post-split; опубликованные tarball'ы
   несут dist/ — пересборка пропускается с пометкой `skip`).

**Верификация (после чистого `rm -rf node_modules && npm ci`)**: monorepo-ветка —
13/13 built; симуляция post-split — 13/13 через npm-копии; полная цепочка
`npm ci` → `build:packages` → `typecheck` → `vitest 201/201` → `vite build` —
зелёная (re-verified здесь).

---

## B7 — architecture/integration tests: ЗАКРЫТО (в `35ba2b82`)

Статус: DONE. Standalone-safety применена ко всем 46 architecture + 9
integration файлам. Монорепо 979/2 (IB-G15, T9 — pre-existing), постсплит-
симуляция 923/24/2 (только pre-existing), `Exception during run` = 0.

Детальная карта dispositions, R-2 classification (239 passing / 4 pending
post-split vs 243/0 monorepo) — в истории документа (`35ba2b82`); здесь
зафиксирован только факт закрытия и re-verification mechanical-чеков.

---

## B9 — CI preparation (G1–G7 → FINAL post-split matrix)

**Не создаётся в монорепо** (P5: `.github/` отсутствует — re-verified:
`find … -type d -name .github` = empty). Матрица ниже — **конкретный
workflow-план**: filename, repository, trigger, steps, tokens, checks.
Каждый workflow авторится в **своём** будущем репо при его создании.

### Определения G1–G7 (prep-plan §10)

| Guard | Определение | Владелец после split |
|---|---|---|
| **G1** | `grep '"file:' package.json` = 0 (backend, web) | backend, web |
| **G2** | exports/deep-subpath scan: `require('@animastor/…/sub')` по src ⊆ `exports` каждого пакета | backend (15 pkgs), web (13 pkgs) |
| **G3** | protocol drift: `node tools/sync-protocol.cjs --check` (exit 1 on drift) | worker (+ backend facade pre-split) |
| **G4** | hub standalone docker build без монорепо-контекста | gpu-hub |
| **G5** | artifact integrity: staging-gate + `check-artifacts.sh` в собранном образе + сверка sha256 Release/pin | gpu-hub |
| **G6** | boundary tests (перенесённый набор) в каждом репо | все 5 |
| **G7** | parity-doc sync: snapshot commit+sha256 от репо-владельца; GitHub — зеркало | android→web, worker→backend, hub→backend |

Минимум до физического split: G1–G5 (G6 — сразу после переноса тестов, до
пушей в новые bare). G7 — шаг 5 (с hook'ами).

### B9.2 — Workflow matrix (filename × steps × tokens)

Всего **9 unique workflow files / 12 workflow entries** в 5 будущих репо
(backend 2, web 2, worker 3, gpu-hub 3, android 2 — суммарно 12 entry;
уникальных имён файлов 9, т.к. `ci.yml` и `parity.yml` повторяются между
репо). Файлы **не создаются** в монорепо — только в новых репо при P1.

#### animastor-backend (2 workflows)

| Поле | `ci.yml` | `release.yml` |
|---|---|---|
| **Repository** | animastor-backend | animastor-backend |
| **Trigger** | `push`/`pull_request` → `main` | `push` tags `hub-artifacts-v*`; `workflow_dispatch` |
| **npm install** | `cd backend && npm ci` | (не нужен — zip + publish) |
| **Typecheck** | — (нет tsc в backend; pretest syntax-smoke) | — |
| **Tests** | `npm run test:arch` + `npm test` (mocha; pretest syntax-smoke) | — |
| **Build** | Docker build `context: ./backend` | zip 3 assets: `hub-workflows-v1.zip`, `installer-src-v1.zip`, `install-manifests-v1.zip` |
| **Registry-only deps check** | G1: `grep -rn '"file:' backend/package.json` → empty; lock: `"link":true`/`"file:`/`resolved:../packages` = 0/0/0 | — |
| **G2** | exports/deep-subpath scan: `require('@animastor/…/sub')` по src ⊆ exports, 15 pkgs (scan авторится в workflow — D11) | — |
| **Токены** | — | `GITHUB_TOKEN` (Release publish); `NPM_TOKEN` (npm publish 15 pkgs — после P3) |
| **Pre-release checks** | G1, G2, G6 (979/2 — 2 = IB-G15/T9 pre-existing), docker build, syntax smoke | Все checks из ci.yml + sha256(asset) записаны в Release body |
| **Artifact SHA256** | — (consumer hub assets, не publisher собственных) | 3 assets: sha256(zip) в Release body |
| **Docker checks** | Build `context: ./backend`, healthcheck compose parity | — |
| **Split-only checks** | — | npm publish (P3); Release publish (P1) |

#### animastor-web (2 workflows)

| Поле | `ci.yml` | `release.yml` |
|---|---|---|
| **Repository** | animastor-web | animastor-web |
| **Trigger** | `push`/`pull_request` → `main` | `push` tags `web-v*`; `workflow_dispatch` |
| **npm install** | `cd frontends/app && npm ci` (`.npmrc` `legacy-peer-deps=true` обязателен) | — |
| **Typecheck** | `npm run typecheck` (`tsc --noEmit`) | — |
| **Tests** | `npm run build:packages` → `npm test` (vitest) | — |
| **Build** | `npm run build` (vite) | — |
| **Registry-only deps check** | G1: `"file:"` grep → empty; lock 0/0/0; 13× `@animastor/web-*` из registry | — |
| **G2** | exports scan 13× `@animastor/web-*` (src ⊆ exports) | — |
| **Токены** | — | `NPM_TOKEN` (npm publish 13 pkgs — после P3) |
| **Pre-release checks** | G1, G2, G6: 13 pkgs built / 201 vitest / vite build / typecheck | ci.yml checks + npm publish |
| **Artifact SHA256** | — (parity snapshot — web output, verified by consumers) | — |
| **Docker checks** | — (web static build) | — |
| **Split-only checks** | — | npm publish (P3) |

#### animastor-worker (3 workflows)

| Поле | `ci.yml` | `release.yml` | `parity.yml` |
|---|---|---|---|
| **Repository** | animastor-worker | animastor-worker | animastor-worker |
| **Trigger** | `push`/`pull_request` → `main` | `push` tags `worker-bundle-v*`; `workflow_dispatch` | `schedule` (daily); `push` на changes `docs/architecture/JOB_PROTOCOL_V2.md`-паттерну в backend (cross-repo); `workflow_dispatch` |
| **npm install** | `cd packages/animastor-worker && npm ci` (dev-harness; contracts из npm) | — | — |
| **Typecheck** | — (JS-only; sync-protocol = де-факто type/contract check) | — | — |
| **Tests** | `node tools/sync-protocol.cjs --check` (G3) + `node tests/run-all.cjs` (6 suites: env, cleanup, cleanup-journal, job-protocol, package, standalone) | — | — |
| **Build** | — | zip `animastor-worker-bundle-2.1.1.zip` из `worker/` (6 manifest files + package.json); sha256 в body Release | — |
| **Registry-only deps check** | lock: 0/0/0; dev-harness deps = `@animastor/contracts ^0.1.1` only; bundle zero-runtime-dep | — | — |
| **Токены** | — | `GITHUB_TOKEN` (Release zip + sha256) | `GITHUB_TOKEN` (PR creation) |
| **Pre-release checks** | G3 exit 0; run-all **45/0** (mechanical verified) | ci.yml checks + zip + sha256 | snapshot commit+sha256 == backend canonical |
| **Artifact SHA256** | — | **Own asset**: sha256(zip) в Release body; позже пинится в hub artifacts.lock.json | — |
| **Docker checks** | — | — | — |
| **Split-only checks** | — | Release publish (P1; zip не pre-exists) | G7 fetch: `JOB_PROTOCOL_V2.md` **из backend** (canonical owner — D4) |

#### animastor-gpu-hub (3 workflows; **R-3 = A — в СУЩЕСТВУЮЩЕМ репо**)

| Поле | `ci.yml` | `ghcr-release.yml` | `parity.yml` |
|---|---|---|---|
| **Repository** | animastor-gpu-hub | animastor-gpu-hub | animastor-gpu-hub |
| **Trigger** | `push`/`pull_request` → `main` | `push` tags `hub-v*`; `workflow_dispatch` | `schedule` (daily); `workflow_dispatch` |
| **npm install** | `cd packages/animastor-gpu-hub && npm ci` (contracts из npm) | — | — |
| **Typecheck** | — (JS-only) | — | — |
| **Tests** | `node tests/run-all.cjs` (22 checks: package smoke, dependency isolation, canonical contracts, protocol parity, frozen 13-route surface, Redis ownership, artifact bake-in/Dockerfile) | — | — |
| **Build** | **G4**: standalone docker build **без монорепо-контекста** — **DONE pre-split** (`scripts/split-guards/run-all.sh` → `tools/g4-standalone-build.sh` + `tools/standalone-fixture.cjs`, **PASSED на `64127b9e`**); dual-stage Dockerfile подтягивает пиновые assets (`scripts/fetch-pinned-assets.sh`) — реальные Release zips появятся POST-SPLIT | GHCR publish image с **digest-pin** | — |
| **Registry-only deps check** | lock 0/0/0; deps frozen: `@animastor/contracts ^0.1.0`, cors, express ^4.19.2, ioredis (devDeps forbidden — run-all:147) | — | — |
| **G5 / B5 checks** | (1) `node tools/update-artifacts-lock.cjs --check` (**после re-point writer на Release zips** — до тех пор monorepo-layout only, D6); (2) staging gate `verify-staged-artifacts.sh` в build (**SHA256 ДО `COPY --from=stager`**); (3) post-build `check-artifacts.sh` 6/6 в собранном образе; (4) **все 3 слоя прогнаны pre-split в `g5-artifact-integrity.sh`** (включая materialise 4/4 + `sha256_asset` verified + tamper-отказ) | — | — |
| **Токены** | — | `GHCR_TOKEN` (packages:write) или `GITHUB_TOKEN` к ghcr.io; artifact tokens только на build-time fetch | `GITHUB_TOKEN` (PR creation) |
| **Pre-release checks** | G4, G5 (3 layers), npm test 22 checks | ci.yml checks + image digest записан | snapshot == backend canonical |
| **Artifact SHA256** | **3 layers**: (1) staging-gate `sha256_tree` vs lock **до** `COPY --from=stager`; (2) post-build `check-artifacts.sh` [3/6] min_version + [4/6] per-workflow SHA256; (3) **sha256 Release-asset vs lock** (`sha256_asset`) — механика **DONE pre-split** (fixture), **реальный** pin — POST-SPLIT (первый релиз, `sha256_asset` в lock = `null`) | image digest-pin (GHCR) | — |
| **Docker checks** | Standalone build (G4) + staging gate + bake-in RUN + check-artifacts | GHCR push + digest verification | — |
| **Split-only checks** | G4 **уже выполнен pre-split** (fixture-контекст); `--check` — monorepo-layout (D6: writer walkRoot), эквивалент после split — слой 1b (pin vs materialised assets); GHCR digest-pin (**R-3 = A: publish идёт из существующего репо `Animastor/animastor-gpu-hub`, ничего не перезаписывается**) | GHCR publish (из существующего hub-repo) | G7 fetch: `JOB_PROTOCOL_V2.md` из **backend** |

#### animastor-android (2 workflows)

| Поле | `ci.yml` | `parity.yml` |
|---|---|---|
| **Repository** | animastor-android | animastor-android |
| **Trigger** | `push`/`pull_request` → `main` | `schedule` (daily); `workflow_dispatch` |
| **npm install** | — (gradle-only; Maven deps) | — |
| **Typecheck** | — (Kotlin; gradle compile = typecheck) | — |
| **Tests** | gradle unit tests: `junit:junit:4.13.2`, PlayerGateTest.kt (pure JVM) — **G6-analog, D5 пин** | — |
| **Build** | `./gradlew assembleDebug` (build-apk.sh / apk-build.sh) | — |
| **Registry-only deps check** | — (no package.json; gradle/Maven) | — |
| **Токены** | None для checks (опц. signing keystore; `GITHUB_TOKEN` если APK → GitHub Release) | `GITHUB_TOKEN` (PR creation) |
| **Pre-release checks** | G6-analog (gradle tests) + assembleDebug | snapshot commit+sha256 == web canonical |
| **Artifact SHA256** | — (release: APK asset sha256 если публикуется) | G7: parity file sha256 vs canonical web |
| **Docker checks** | — | — |
| **Split-only checks** | — | G7 fetch: `ANDROID_WEB_PARITY.md` **из web** (canonical owner; R-5: из VPS bare, GitHub зеркало) |

### B9.3 — G1–G7 × repository ownership map

| Guard | backend | web | worker | gpu-hub | android |
|---|---|---|---|---|---|
| G1 file:-guard | **ci.yml** | **ci.yml** | — | — | — |
| G2 exports scan | **ci.yml** (15 pkgs) | **ci.yml** (13 pkgs) | — | — | — |
| G3 protocol drift | — (facade pre-split) | — | **ci.yml** | — | — |
| G4 standalone build | — | — | — | **ci.yml** (POST-SPLIT) | — |
| G5 artifact integrity | — | — | — | **ci.yml** (3 layers) | — |
| G6 boundary tests | **ci.yml** (arch+unit) | **ci.yml** (vitest 201) | **ci.yml** (run-all 45) | **ci.yml** (run-all 22) | **ci.yml** (gradle tests) |
| G7 parity snapshot | **canonical owner** (JOB_PROTOCOL_V2.md) | **canonical owner** (ANDROID_WEB_PARITY.md) | **parity.yml** (snapshot from backend) | **parity.yml** (snapshot from backend) | **parity.yml** (snapshot from web) |

### B9.4 — Что НЕВОЖМОЖНО до physical split

| # | Check | Причина |
|---|---|---|
| 1 | Любое `.github/workflows` execution в новых репо (4; GPU Hub CI уже есть в существующем репо, R-3 = A) | `.github/` отсутствует в монорепо (P5 confirmed) |
| 2 | G4 standalone hub docker build | ~~невозможно pre-split~~ → **ВЫПОЛНЕНО pre-split** (`g4-standalone-build.sh`, PASSED на `64127b9e`): dual-stage Dockerfile + `standalone-fixture.cjs` дают standalone-контекст; в hub-repo CI — после P1 (**R-3 = A закрыт**) |
| 3 | G5 Release-asset digest check | **механика DONE pre-split** (fixture materialise 4/4 + tamper-отказ в `g5-artifact-integrity.sh`); реальные 4 Release zips не существуют (`sha256_asset` = `null`), P1 repos absent, P3 E401 — pin появится на первом релизе POST-SPLIT |
| 4 | G7 parity-snapshot jobs | Требуют bare + hooks + canonical repos (step 5) |
| 5 | npm publish CI (backend 15, web 13) | P3 E401 token; publish из split-repo |
| 6 | Worker Release job (zip + sha256) | P1 repos absent; zip создаётся при Release |
| 7 | GHCR digest-pin publish hub image | **R-3 = A**: publish выполняется **существующим** `ghcr-release.yml` в `Animastor/animastor-gpu-hub`; перезапись репозитория/истории запрещена навсегда |
| 8 | `update-artifacts-lock.cjs --check` в hub repo post-split | Writer walkRoot monorepo-relative; re-point — POST-SPLIT (pre-split эквивалент уже есть: слой 1b в G5 — pin vs materialised assets) |
| 9 | Full G6 в filtered repos | B7 standalone-safe готово; filtered clones — только после filter-repo |
| 10 | `b5-artifact-contract` suite post-split в backend repo | Self-skips (npm tarball lacks B5 triple) — hub-CI post-split (D9) |

### B9-corrections (исправления относительно предыдущих ревизий матрицы)

| # | Было (ошибка/пробел) | Стало |
|---|---|---|
| **D3** | backend row: нет Release job, нет `GITHUB_TOKEN` | backend `release.yml`: 3× hub-artifacts assets + `GITHUB_TOKEN` |
| **D4** | worker G7 = «snapshot из web» | worker/hub G7 source = **backend** (`JOB_PROTOCOL_V2.md`); только `ANDROID_WEB_PARITY.md` — web-owned |
| **D5** | android G6 ambiguous / отсутствовал | android `ci.yml`: gradle unit tests (junit, PlayerGateTest.kt) — явно пинится |
| **D6** | `--check` listed в hub CI как есть | `--check` monorepo-layout only до re-point writer на Release zips; в hub CI — после re-point (POST-SPLIT remainder; подтверждено на `64127b9e`: G5 печатает «lock --check needs monorepo source trees» и использует слой 1b) |
| **D7** | (уточнение) | lock реализует `sha256_tree` (tree digest, заполнен) **и** `sha256_asset` (поле в schema; `null` до первого релиза, fixture заполняет локально) — оба задокументированы §B5 |
| **D8** | (уже отмечено) | base images `alpine:3.19`/`node:20-slim` не digest-pinned — POST-SPLIT |
| **D9** | (уже отмечено) | npm tarball `@animastor/gpu-hub` не содержит B5-тройку → `b5-artifact-contract` = hub-CI post-split, не backend CI |
| **D10** | (уже отмечено) | **R-3 = A принято** → hub CI авторится **в существующем** `animastor-gpu-hub` GitHub (43 коммита, свой `ci.yml` + `ghcr-release.yml`); workflows сверяются с матрицей B9, репозиторий не пересоздаётся |
| **D11** | (усилено) | G2 не имеет standalone test file — CI scan шаг **авторится в workflow** с нуля; G1 — pure CI grep |

---

## P4 — остаточный `workflow.json`

**Факт на `e1c63073`** (re-verified): `/home/animastor/animastor/workflow.json`
— **пустой каталог** (не файл), `root:root drwxr-xr-x`, создан 2026-08-24;
в git **не отслеживается** (`git ls-files` = 0); `.gitignore` строка 43:
`workflow.json/`; compose-mount `./workflow.json:/workflow.json:ro` удалён из
**основного** `docker-compose.yml` в `bd66bae6` (C7-гвард запрещает возврат).

**Runtime**: backend/src, packages/, frontends/ — **никто не читает**
`/workflow.json` как runtime-файл; `installer-phase15.test.js` использует
строку `'somewhere/else/odd-workflow.json'` только как test-data path —
не runtime mount. Runtime-файл отсутствует — удалять сейчас нечего и незачто.

**Stale mount (зафиксирован ранее)**: `frontends/android/docker-compose.yml:41`
содержит `./workflow.json:/workflow.json:ro`. Docker compose резолвит
относительные пути от каталога compose-файла → это
`frontends/android/workflow.json` (**не** root). Каталога
`frontends/android/workflow.json` не существует. Mount стейл (остаток
старого layout). Основной `docker-compose.yml` mount уже удалён.
**Не исправлено здесь** (ограничение: обновляется только next-blockers);
зафиксировано для владельца: удалить строку из android-compose при следующем
android-touchpoint.

**Безопасная команда удаления** (выполняется владельцем при желании;
`rmdir` отказывается удалять непустой каталог — риск нулевой, sudo нужен
из-за root-владения):

```bash
sudo rmdir /home/animastor/animastor/workflow.json
```

Дополнительно (owner, android touchpoint): удалить строку
`./workflow.json:/workflow.json:ro` из
`frontends/android/docker-compose.yml:41`.

**Перепроверка read-only 2026-10-04 (статус не изменился):**

| Что | Факт |
|---|---|
| `/home/animastor/animastor/workflow.json` | **существует** — пустой каталог `root:root drwxr-xr-x`, mtime 2026-08-24 12:52:14Z, `git ls-files` = 0 → **шаг `rmdir` НЕ выполнялся** |
| `frontends/android/docker-compose.yml:41` | строка `- ./workflow.json:/workflow.json:ro` **осталась** → **stale android-compose-mount НЕ снят** |
| `frontends/android/workflow.json` | **не существует** (точка резолва относительного пути) → mount стейл по-прежнему |
| корневой `docker-compose.yml` | `workflow.json` **не упоминается** (удалено в `bd66bae6`, C7-гвард) |
| живой контейнер `animastor-backend` (старт 2026-09-04) | **несёт stale bind-mount** `/home/animastor/animastor/workflow.json -> /workflow.json` (унаследован от старой конфигурации; в compose-файле строки уже нет) |
| итог | **P4 = NOT YET EXECUTED** (гигиена); **не блокирует** `filter-repo` — оба пути untracked, в whitelist §8.1 входят как no-op и **исключаются** из команды §4.1.1 |

---

## P6 — диск перед filter-repo (аудит на `e1c63073`)

> **P6 = CLOSED / PASS (2026-10-04).** `df -B1 /` → **avail `6 839 934 976 B`
> (≈6.4 GiB; `df -h /` → 6.4G)** ≥ порога `5 368 709 120` (≥5G) → **1.27×** порога,
> **6.4×** измеренного минимума 1 GiB. **Очистка не выполнялась и не требуется**;
> раздел «Minimal cleanup plan» ниже **остаётся исторической записью** и
> выполняется только по отдельному распоряжению владельца. Авторитетный статус —
> `repository-split-final-gate.md` §1/§4.
> Ниже — **исторический аудит на `e1c63073`** (pre-cleanup), сохранён для audit trail.

**Факт (исторический, `e1c63073`)**: `/` = `/dev/sda2` 99G, занято 92G, **свободно 2.8G** (98%).
Потребность последовательного filter-repo **4 репозиториев** (R-3 = A: GPU Hub
не фильтруется; оценка делалась для 5 репо и потому **консервативна**):
mirror-клон монорепо ~73M (.git) × 4–5 + рабочая копия переписи ~2× пик
истории → **≈3.0–4.5G суммарно**. **2.8G — НЕ достаточно** с нормальным запасом
(нет headroom под OS/npm/Docker churn). Минимум: **≥5G** (рекомендуется
≥8G).

| Компонент | Размер | Классификация |
|---|---|---|
| `.git` (monorepo) | **73M** (packs 56M, 8 pack files) | — |
| npm cache `~/.npm` | **792M** (_cacache 692M, _npx 100M) | cache — deletable |
| Docker images | **13GB** (6 active: ollama 9.19G, backend 2.6G, postgres 642M, hub 312M, redis 170M, nginx 93M — все в употреблении) | runtime — НЕ трогать |
| Docker volumes | 1.727GB total; reclaimable **235MB** | 3 linked (ollama-data 1.36G, pg, redis) — НЕ трогать; dangling — см. cleanup |
| Build cache | **0B** | пусто |
| `~/.cache/pip` | **4.4G** | cache — deletable |
| `/tmp/opencode` | **2.8G** (ttsvenv 1.9G, sims, hometest) | tmp — deletable |
| `/tmp/installer-cli-cpu-install-*` | **~12K each** (71 dirs; очищены между сессиями — было 2.3G) | tmp — уже negligible |
| `~/.gradle/caches` | **1.1G** | cache — deletable (перескачается) |
| `/var/log/journal` | **3.7G** on disk | system log — vacuum |
| `backups/` (home + repo) | **4.0G** | **USER DATA — не трогать** |
| `~/.local/share/opencode/opencode.db` | **8.8G** | **ACTIVE RUNTIME — не трогать** |

### Minimal cleanup plan (команды предложены, НЕ выполнялись)

| # | Команда (предложение) | Est. freed | Risk |
|---|---|---|---|
| 1 | `pip cache purge` | **~4.4G** | None — pure cache |
| 2 | `npm cache clean --force` | **~692M** | None — cache |
| 3 | `rm -rf /tmp/opencode` | **~2.8G** | Low — tmp scaffolding |
| 4 | `rm -rf /tmp/installer-cli-cpu-install-*` | **~1M** (уже очищены) | Low |
| 5 | `rm -rf /tmp/pip-unpack-* /tmp/npm-inst /tmp/gh_2.62.0_linux_amd64` | **~330M** | Low — tmp leftovers |
| 6 | `journalctl --vacuum-size=200M` (root) | **~3.5G** | Low — system logs |
| 7 | `rm -rf ~/.gradle/caches` | **~1.1G** | Low — перескачается |
| 8 | `docker volume rm $(docker volume ls -q --filter dangling=true)` | **~235M** | **Medium** — содержит `animastor_migration_*`, `animastor_sqlite-data`; inspect first |
| 9 | `sudo apt-get clean` | **~136M** | None |
| 10 | `rm -rf ~/.local/share/opencode/log` | **~52M** | Low — logs only |

**Минимальный путь (оценка для 5 репо; при R-3 = A их 4 — потребность не больше)**: шаг 1 (pip cache) → free ≈7.2G —
**достаточно**. Шаги 1+2+3 → ≈13.3G — здоровый headroom.

**Не трогать**: `backups/` (4.0G, user data), `opencode.db` (8.8G runtime),
Docker images (6 active — удаление = слом стека), linked volumes
(ollama-data/pg/redis — live data).

---

## R-3 — GPU Hub (**DECIDED = A**; репозитории не тронуты)

Сравнение VPS bare `/home/animastor/repos/animastor-gpu-hub.git` (43 коммита,
root-layout, свой post-receive mirror, GitHub `Animastor/animastor-gpu-hub`
HEAD `7c7778c`) ↔ монорепо `packages/animastor-gpu-hub`:

| Файл | Bare | Монорепо | Различие |
|---|---|---|---|
| `gpu-hub.js` | есть deprecated `GET /worker-source`; каталоги артефактов напрямую `/app/*` | `/worker-source` удалён; `resolveArtifactDir` (baked-in → mount fallback, 10T.1) | ~45 строк только в bare, ~40 только в монорепо |
| `package.json` | 0.1.0 | 0.1.1 (опубликован в npm) | version + repository.url |
| `Dockerfile` | свой (standalone) | multi-stage stager с монорепо-COPY + **B5 gate** | разные стратегии доставки артефактов |
| `server.js`, `tarball.js`, `bootstrap.js`, `.dockerignore` | — | — | **байт-идентичны** |
| есть только в bare | `.github/workflows/{ci,ghcr-release}.yml`, `tests/run-all.cjs`, `DEPLOYMENT.md`, `EXTRACTION.md`, `package-lock.json`, `.gitignore` | — | bare уже имеет CI — плюс для варианта A |
| есть только в монорепо | — | `artifacts.lock.json`, `scripts/verify-staged-artifacts.sh`, `tools/update-artifacts-lock.cjs` (B5) | подлежат переносу при выборе A |

**Если выбираем A (сохранение существующего repo + адаптация), список переноса**:
(1) блок `resolveArtifactDir` из монорепо `gpu-hub.js`; (2) решение по
deprecated `/worker-source` (в монорепо удалён); (3) version 0.1.0 → 0.1.1
(+ npm publish после P3, т.к. 0.1.1 уже занят в registry); (4) B5-тройка
(лок, gate, writer) + ассерты `phase10t-1`/B5-теста; (5) merge Dockerfile:
standalone-контекст + stager по Release-assets (B5 end-state); (6) sync
`tests/run-all.cjs` с монорепо-версией; (7) сверка `.github/workflows` с
матрицей B9 (§B9.2 gpu-hub workflows). **Если B** — backup + freeze hook +
filter-repo экспорт истории (NO-GO до решения; force-push исключён).

Решение не принято — обе опции документированы, ничего не перезаписано.
**R-3 = A закрыт** → hub CI matrix (D10) разблокирована: hub workflows авторятся **в существующем** репо (`repository-split-r3-decision.md`).

---

## Mechanical checks (executed on `e1c63073`; documented in `4f947c56`)

**Все проверки ниже выполнялись на рабочем дереве commit'а `e1c63073`.**
Commit `4f947c56` — documentation-only: результаты перенесены в этот документ
без повторного запуска тестов.

| Проверка | Результат |
|---|---|
| backend lock: `"link": true` / `"file:` / `resolved: ../packages` | **0 / 0 / 0** ✓ |
| web lock: `"link": true` / `"file:` / `resolved: ../packages` | **0 / 0 / 0** ✓ |
| `"file:"` / `"link"` в backend/web package.json | **0** ✓ |
| backend `npm ci` | exit 0 ✓ |
| web `npm ci` | exit 0 ✓ |
| backend `test:arch` | **979 passing / 2 failing** (stable ×2 consecutive runs; один transient 978/3 в первой прогонке — flake, восстановился) ✓ |
| backend `npm test` | **979 passing / 2 failing** (IB-G15, T9 — pre-existing; не новые ошибки) ✓ |
| web `build:packages` | 13/13 pkgs built ✓ |
| web `typecheck` | exit 0 ✓ |
| web `test` (vitest) | **201/201 passed** (15 files) ✓ |
| web `build` (vite) | exit 0 ✓ |
| worker `sync-protocol.cjs --check` | exit 0 — «in sync with @animastor/contracts» ✓ |
| worker `tests/run-all.cjs` | **45 pass / 0 fail** ✓ |
| B5 `update-artifacts-lock.cjs --check` | «in sync with source trees» ✓ |
| Docker Hub build (staging gate) | exit 0; **«artifact integrity gate: 4/4 groups match artifacts.lock.json (staging, pre-COPY)»** ✓ |
| Docker Hub build (bake-in) | «artifact bake-in verified: 4 groups present» ✓ |
| Docker `check-artifacts.sh` (post-build, в собранном образе) | **ALL CHECKS PASSED** — 6/6 ✓ |
| **B5 tamper test (executed on `e1c63073`)** | clean tree → gate **exit 0**; byte-append to `img-qwen-image.json` → gate **exit 1** («digest mismatch: staged=653af721… locked=0d51107d…») ✓ |
| `.github/` в монорепо | отсутствует (P5 confirmed) ✓ |
| workflow.json | пустой каталог, не tracked, runtime не использует ✓ |
| Dockerfile gate lines | gate RUN = line 30; `COPY --from=stager` = line 44 — **SHA256 проверяется ДО COPY** ✓ |
| Legacy `old_*.json` baselines | только 7 активных workflow в `baseline_sha256`; `old_*` исключены loader'ом ✓ |

**IB-G15 / T9** — pre-existing (в объём новых ошибок не входят):
- IB-G15: `installer-package-boundary.test.js:243` — `pkg.private === true`
  vs published `@animastor/installer@0.1.0` (нет `private` поля).
- T9: `phase5-runtime-result.test.js:401` — ENOENT
  `backend/src/runtime/index.js` (файл удалён из истории).

**Примечание о flake**: первая прогонка `test:arch` в этой сессии дала
978/3 (11s), две последующие — стабильные 979/2 (3–5s). Третий тест не
идентифицирован как новый блокер — вероятен timing/ordering flake в
transient состоянии. Baseline остаётся 979/2; при следующем прогоне
владельца рекомендуется одиночный re-run при расхождении.

---

## §FPSG — FINAL PRE-SPLIT GATE (аудит на `b7e2f7cd`)

Статусы: **DONE** · **READY** · **POST-SPLIT** · **BLOCKED** · **OWNER DECISION**
(см. §0). Ограничения соблюдены: физический split, `git filter-repo`,
force-push, создание GitHub-репо, изменение существующего GPU Hub, его hook,
npm publish, production-изменения, изменения B7-тестов, возврат `file:`/symlink
deps, массовое переписывание документации — **не выполнялись**.

### FPSG.1 — фактическое состояние git

| Проверка | Факт на `b7e2f7cd` |
|---|---|
| Текущий branch | `c21.4-physically-extract-analysis-from-backend` (= `origin/…`, bare `refs/heads/c21.4-…` = `b7e2f7cd`) |
| HEAD | `b7e2f7cd73e0320b90f298226a4510bb1ae74e43` |
| Working tree | **clean**; untracked (`--untracked-files=all`) = 0; stash = 0; worktree = 1 |
| `master` | `8118f766d315c16cf3812eacf534d30e6a50ab0e` (= bare `refs/heads/master`) |
| Divergence | **150 ahead / 0 behind**; merge-base = `master` → **FF возможен** |
| Незакоммиченных/untracked, угрожающих filter-repo | **нет**: untracked только ignored-каталоги (`.env`, `node_modules/`, `backups/`, `data/`, `workflow.json/`, `local.properties`, `frontends/*`-build) — filter-repo работает по коммитам, они не попадут |
| Tracked-секреты / node_modules / dist | 0 / 0 / 0 (`git ls-files`); tracked-файлов всего 1626, `docs/` — 288 |
| `workflow.json` | **каталог**, не файл: `root:root drwxr-xr-x`, пустой, **не tracked**, `.gitignore:43` = `workflow.json/`; runtime не читает; стейл-mount только в `frontends/android/docker-compose.yml:41` |
| Теги | 0 (`git tag` = 0) → коллизии тегов §7/§8 readiness неактуальны |
| Remotes | только `origin` = `/home/animastor/repos/animastor.git`; bare-remote `github` живёт в самом bare |

### FPSG.2 — статусы B1–B12 и P1–P6 (перепроверены по факту)

| ID | Статус | Факт перепроверки на `b7e2f7cd` |
|---|---|---|
| **B1** | **DONE** | `backend/package.json` dependencies содержат `@animastor/contracts ^0.1.1` и `animastor-comfyui-workflow-connector ^0.1.0`; в `docker-compose.yml` **нет** mount'ов на `./packages/*` (остались только `./data`, `./backend/*`, `./proxy`, `./frontends/*`, `./docs`) |
| **B2** | **DONE** | backend lock: `"link": true` / `"file:` / `resolved: ../packages` = **0 / 0 / 0**; `"file:`/`"link"` в backend `package.json` = 0; `test:connector-core` переведён на `node_modules` (R-6). **Наблюдение**: `packages/animastor-ai-analysis/package-lock.json` отсутствует и никогда не был tracked (final-readiness §B2 «ровно у 3» — неточность; сейчас 14/15) |
| **B3** | **DONE** | web lock: **0 / 0 / 0**; `"file:` в `frontends/app/package.json` = 0 |
| **B4** | **DONE** | инвариант exports держится (G2 — POST-SPLIT CI-scan, D11); пакетных правок не требуется |
| **B5** | **READY** | `update-artifacts-lock.cjs --check` → «in sync with source trees» (перезапущен здесь); 4 группы сверены с lock (exact values §B5); Dockerfile: `RUN verify-staged` = строка **30** < `COPY --from=stager` = строка **44**; tamper-test executed (`e1c63073`) |
| **B6** | **DONE** | `sync-protocol.cjs --check` → exit 0 «in sync with @animastor/contracts» (перезапущен здесь) |
| **B7** | **DONE** | `npm run test:arch` → **979 passing / 2 failing** (IB-G15, T9 — ровно baseline); `Exception during run` = 0 |
| **B8** | **DONE** | `frontends/app/scripts/build-packages.cjs` присутствует (двухветочный resolve, fail-fast) |
| **B9** | **READY** | матрица §B9.2 финальна; `find … -type d -name .github` (без node_modules) = **пусто** |
| **B10** | **DONE** | `/home/animastor/repos/animastor.git/hooks/post-receive` = `cd "$GIT_DIR"; git push --mirror github` — **не изменён** |
| **B11** | **POST-SPLIT** | — |
| **B12** | **DONE** | корневой `package.json` **отсутствует**; читателей корневого `package.json` в коде нет |
| **P1** | **CLOSED (2026-10-04)** — *статус на `b7e2f7cd` был BLOCKED (4 × 404), на утренней ревизии — PARTIAL* | bare: `animastor.git` + `animastor-gpu-hub.git` + **4 новых bare** (`animastor-{backend,web,android,worker}.git`, 0 refs/0 objects, `HEAD=refs/heads/main`, hook 0755/91 байт, remote `github`); GitHub: `Animastor/animastor-gpu-hub` = **HTTP 200** (`7c7778c`, 43 коммита = bare), `animastor-backend/web/android/worker` = **HTTP 200, `size=0`, 0 refs** (созданы 2026-10-03). **Push не выполнялся** |
| **P2** | **BLOCKED (OWNER)** — *исторический статус; **закрыт**: см. §0* | `master` `8118f766`, −**150**; FF-merge безопасен (merge-base = master) |
| **P3** | **BLOCKED (OWNER)** | `npm whoami` → **E401**; `npm view @animastor/contracts\|gpu-hub` → 0.1.1 ✓ (registry/install работает) |
| **P4** | **NOT YET EXECUTED** (re-verified 2026-10-04) | пустой untracked каталог **существует** + стейл android-mount **остался**; safe-команда §P4 |
| **P5** | **POST-SPLIT** | `.github/` отсутствует; workflows создаются в новых репо (см. расхождение §FPSG.4/6) |
| **P6** | **CLOSED / PASS (2026-10-04)** — *на `b7e2f7cd` был BLOCKED* | `/` = 99G, занято 88G, **свободно 6.4G (94%)** — `df -B1 /` → `6 839 934 976 B` ≥ 5G; исторически: 3.1G (97%) и 2.9G (98%, FAIL, FINAL GATE `64127b9e`) |
| **R-3** | **CLOSED — A (SELECTED)**, B = **REJECTED** | bare 43 коммита ↔ GitHub `7c7778c` — **каноничная standalone history, не перезаписывается**; `filter-repo` gpu-hub не выполняется; §R-3 + `repository-split-r3-decision.md` |
| **R-5** | **DONE** | — |

### FPSG.3 — внешние блокеры (подтверждены)

**P1 — 5 будущих/существующих репозиториев**

| Repo | VPS bare | GitHub (API, `b7e2f7cd`) | GitHub (API + `ls-remote`, **2026-10-04**) | Действие |
|---|---|---|---|---|
| animastor-backend | **создан 2026-10-04** (`animastor-backend.git`, 0 refs/0 objects, `HEAD=refs/heads/main`, hook 0755/91 байт, remote `github`) | **404** (на `b7e2f7cd`) | **200**, `size=0`, **0 refs**, `default_branch=main`, public, created 2026-10-03T23:53:38Z | **ГОТОВО** — bare + hook + remote **выполнены**, push **не выполнялся** |
| animastor-web | **создан 2026-10-04** (то же) | **404** | **200**, `size=0`, **0 refs**, `default_branch=main`, 2026-10-03T23:54:32Z | **ГОТОВО** |
| animastor-android | **создан 2026-10-04** (то же) | **404** | **200**, `size=0`, **0 refs**, `default_branch=main`, 2026-10-03T23:55:05Z | **ГОТОВО** |
| animastor-worker | **создан 2026-10-04** (то же) | **404** | **200**, `size=0`, **0 refs**, `default_branch=main`, 2026-10-03T23:55:36Z | **ГОТОВО** |
| animastor-gpu-hub | `/home/animastor/repos/animastor-gpu-hub.git` (43 коммита) | **200**, HEAD `7c7778c` | **200**, HEAD `7c7778c`, 0 releases, 0 tags, workflows `ci.yml`+`ghcr-release.yml` | **не создавать, не удалять, не force-push — запрещено всегда** (R-3 = A; `repository-split-r3-decision.md` §3.1) |

Оговорка: 404 по GitHub API без токена неотличим от приватного репо; при
наличии токена владельцу стоит подтвердить отсутствие (creds-проверка).
**Статус 404 устарел**: перепроверка 2026-10-04 read-only (`API GET` + `git
ls-remote` ssh rc=0 без credentials) показала **200 / пустые репозитории** —
GitHub-часть P1 выполнена владельцем; **локальная (bare/hook/remote) —
выполнена 2026-10-04** (4 bare созданы, hook byte-identical, remote настроен;
**push не выполнялся — обе стороны остаются пустыми**).

**P2 — master freeze / исходная точка split — ВЫПОЛНЕНО**

- **`master` = `64127b9e1dea2ac528a572b51b90a542b70c5ebb`** (= `origin/master` =
  frozen source; **0 behind / 0 ahead**). Выполнено в FINAL GATE:
  `git checkout master && git merge --ff-only 64127b9e… && git push origin master`
  (было `04da33ea`, отставание **2** коммита — оба guard-фикса).
- **SHA, который является исходной точкой split:**
  **`64127b9e1dea2ac528a572b51b90a542b70c5ebb`**
- До FF запускать filter-repo нельзя (NO-GO №1 final-readiness §7) — **снято**.

**P3 — npm credentials (только готовность публикации, publish НЕ выполнялся)**

- `npm whoami` → **E401 Unauthorized** (токен в `~/.npmrc` присутствует, 1 `_authToken` — недействителен).
- `npm view` / установка публичных пакетов работают → install-путь разблокирован.
- Publish-путь закрыт → блокирует Release/npm-publish CI (B5-assets, backend 15 pkgs, web 13 pkgs), но **не блокирует сам filter-repo** (POST-SPLIT requirement).
- Здесь ничего не публиковалось.

**P6 — диск (повторно показано; ничего не удалялось)**

| Параметр | Значение |
|---|---|
| **Свободно (актуально, 2026-10-04)** | **`6 839 934 976 B` ≈ 6.4 GiB (`df -h /` → 6.4G, 94%) → P6 = CLOSED / PASS**; авторитетно `repository-split-final-gate.md` §1/§4 |
| Свободно (исторически) | 2.9G (99G total / 92G used / **98%**, `df -h /` на `64127b9e`) · preflight 2026-10-03: 2 958 962 688 B — **FAIL** (значение оставлено только для audit trail) |
| Требование для последовательного filter-repo (4 репо при R-3 = A; оценка сделана для 5 — консервативна) | **≥5G**, рекомендуется ≥8G (mirror `.git` 73M × 4–5 + рабочие деревья переписи ≈ 2× пик истории ≈ 3.0–4.5G суммарно + headroom) |
| Заявлено в §P6 (исторически) | 2.8G → 3.1G → 2.9G — **дефицит был; с 2026-10-04 закрыт без очистки (6.4G ≥ 5G)** |
| Минимальная очистка (**не требуется: P6 закрыт**) | историческая запись: `pip cache purge` ≈ 4.4G → ≈7.5G; шаги 1+2+3 §P6 → ≈13.6G. **Не выполнять без отдельного распоряжения владельца** |
| НЕ трогать | `backups/` (4.0G), `~/.local/share/opencode/opencode.db` (8.8G), 6 активных Docker-образов (13G), linked volumes (ollama/pg/redis) |

Команды очистки предложены (§P6), **не выполнялись** — и **стали не нужны**:
P6 закрыт 2026-10-04 без какой-либо очистки.

**R-3 — GPU Hub (DECIDED: A = SELECTED, B = REJECTED)**

- Вариант **A — ВЫБРАН**: сохранить существующий `Animastor/animastor-gpu-hub` (43 коммита, свой `ci.yml`+`ghcr-release.yml`); `filter-repo` gpu-hub не выполняется, новый репо не создаётся, его standalone history канонична. Норматив — `repository-split-r3-decision.md`.
- Вариант **B — REJECTED / NOT SELECTED**: замена историей monorepo (§8.5) **не выполняется**; force-push/mirror-перезапись **запрещены бессрочно**. Секция сохранена только как историческая запись.
- **Никаких изменений в существующем GPU Hub (репо, bare, hook, GitHub) не вносилось — и не будет вноситься** (R-3 = A).

### FPSG.4 — split-последовательность: сверка и расхождения

Сверенная очередь (заданная ↔ prep-plan §11 ↔ readiness §9):

| # | Шаг | Соответствие | Комментарий |
|---|---|---|---|
| 1 | FF master | ✓ (prep-plan §11.0, readiness §9.0) | — |
| 2 | B1–B4 / B6 / B8 / B12 | ✓ (readiness §9.1) | B1–B4/B6/B8/B12 DONE |
| 3 | B5 | ✓ (§9.2) | механика DONE, остаток POST-SPLIT |
| 4 | B7 | ✓ (§9.3) | DONE |
| 5 | B9 | ✓ (§9.4) | READY; **см. расхождение 1** |
| 6 | P6 | ⚠ §9.4 ставит P6 параллельно B9 | допустимо в любом месте до filter-repo — регламентировать |
| 7 | P1 / R-3 | ✅ **снято (R-3 = A)** | решение принято; шаг 5 из очереди исключён, hub workflows авторятся в существующем репо |
| 8 | P4 | ⚠ §9.0 ставит удаление `workflow.json` на шаг 0 | каталог untracked, `--path` no-op → влияет только на гигиену; выполнить **до** filter-repo |
| 9–13 | filter-repo backend → web → android → worker | ✓ (очередь совпадает) | **слот gpu-hub удалён — R-3 = A** |
| 14 | freeze / cutover | ✓ (§9.7–9.8) | — |

**Найденные противоречия / пропущенные шаги**

1. **R-3 vs B9 (порядок).** ~~Матрица §B9.2 говорит… иначе 3 hub-workflow
   нельзя авторить.~~ → **РАЗРЕШЕНО: R-3 = A принято**
   (`repository-split-r3-decision.md`): шаг 5 из очереди исключён,
   hub-workflows авторятся **в существующем** `Animastor/animastor-gpu-hub`
   (не в новом репо), порядок P1/R-3 больше не конфликтует с B9.
2. **P5 — расхождение между документами.** prep-plan §11.4 и readiness §9.4
   требуют «workflows **в монорепо-путях**, чтобы переехали без переписывания»
   (то есть `.github/` в монорепо до split), а этот документ (§B9) требует
   `.github/` в монорепо **не создавать**. Факт: `.github/` отсутствует.
   → нужно подтверждение владельца: G1–G5 гоняются вручную до split,
   workflows авторятся в новых репо при P1 (текущая интерпретация).
3. **Пропущен шаг удаления `tmp/parser-audit-backup`** (prep-plan §11.0,
   «по подтверждению»). Факт: ветка `db5ff61f` существует локально **и в bare**
   (`refs/heads/tmp/parser-audit-backup`), является предком HEAD → удаление
   безопасно, но требует подтверждения владельца.
4. **P3 отсутствует в заданной последовательности.** Не блокирует filter-repo,
   но обязателен до первого publish (Release-asset'ы B5 и npm-publish CI) —
   добавить как пост-сплит-шаг после cutover.
5. **P6/P4 — позиция в очереди** отличается от readiness §9; не ломает
   инвариант «filter-repo только после шагов 0–5», но её следует явно
   зафиксировать (см. таблицу).
6. **Очередь filter-repo и пути** (§8.1–8.5) сверены с реальной структурой —
   расхождений нет; `--path`-правила **не переименовывают пути** (нет
   `--path-rename`) → после split сохраняется layout `backend/`, `frontends/…`,
   `packages/…` относительно корня нового репо. Это снимает класс «относительные
   пути сломаются» (см. §FPSG.7), но **не** снимает X-1/X-2 (§FPSG.7).

### FPSG.5 — EXACT execution checklist (после снятия OWNER DECISION)

> Выполняется оператором. `git filter-repo` / force-push / создание репо /
> npm publish — **только** в соответствующих шагах ниже.

**Этап 0 — владельцу, до всего**

```sh
git status                                    # должен быть clean
# P2 ВЫПОЛНЕН: master == origin/master == 64127b9e1dea2ac528a572b51b90a542b70c5ebb
git rev-parse master                          # обязан вернуть frozen source (§FINAL SPLIT HANDOFF п.1)
git checkout c21.4-physically-extract-analysis-from-backend
git branch -D tmp/parser-audit-backup && git push origin --delete tmp/parser-audit-backup   # по подтверждению
sudo rmdir /home/animastor/animastor/workflow.json    # P4 (rmdir откажется удалять непустой)
pip cache purge                               # P6: +≈4.4G → ≈7.5G свободно
df -h /                                       # должно быть ≥5G
```

**Этап 1 — P1 (инфраструктура, до первого push)**

- Создать 4 пустых GitHub-repo: `Animastor/animastor-{backend,web,android,worker}`,
  default branch `master`, **без README**. `animastor-gpu-hub` **не трогать**.
- Создать 4 bare на VPS `/home/animastor/repos/animastor-<name>.git`.
  **СТАТУС: ВЫПОЛНЕНО 2026-10-04** (0 refs/0 objects, `HEAD=refs/heads/main`).
- Положить в каждый bare свой `post-receive` (`git push --mirror github`),
  guard по basename; **монорепо-hook не менять**; hooks — **до** первого push.
  **СТАТУС: ВЫПОЛНЕНО 2026-10-04** — 4 × **0755 / 91 байт / byte-identical**
  шаблону (sha256 `6a63cb14…`) + `remote.github.url` настроен; **push не
  выполнялся**.
- ~~Разрешить R-3 (A или B)~~ → **выполнено: R-3 = A** (`repository-split-r3-decision.md`); hub-workflows авторятся в существующем репо (§B9.2).

**Этап 2 — filter-repo (по одному репо; общий каркас)**

```sh
git clone --mirror /home/animastor/repos/animastor.git /tmp/split/<name>.git
git clone /tmp/split/<name>.git /tmp/split/<name>   # рабочая копия для фильтрации
cd /tmp/split/<name>
git filter-repo --path <§8.N prep-plan без --path workflow.json / --path local.properties>
# при коллизиях тегов: --tag-rename (тегов сейчас 0 — не требуется)
# постсплит-верификация → push в bare → hook зеркалит в GitHub
```

| Repo | Исходный каталог (whitelist) | `git filter-repo` path rules (§8) | Должны исчезнуть | package.json deps, которые остаются | Remotes |
|---|---|---|---|---|---|
| **animastor-backend** | monorepo → только §8.1 | `--path backend`, `--path packages/animastor-{ai-agent,ai-analysis,ai-connector,assistant,auth,comfyui-workflow-connector,contracts,editor,generation,installer,orchestration,parser,player,url-safety,vbook-runtime}`, `--path docs`, `--path docker`, `--path proxy`, `--path scripts`, `--path docker-compose.yml`, `--path MiM.vbook`, `--path {backend,front-backend,src}-…rebuild.sh`, root-файлы, `.env.example`, `.dockerignore`, `.gitignore` (**без** `--path workflow.json`) | `frontends/**` (app, website, android), `packages/animastor-worker`, `packages/animastor-gpu-hub`, `packages/animastor-web-*` (13), `tools/**` (2 тестера), `apk-build.sh`, `build-apk.sh`, `app-web-rebuild.sh`, `gpu-hub-rebuild.sh`, `ANDROID_WEB_PARITY.md`, корневой `package.json` (его уже нет), `workflow.json`, `local.properties` | **13 `@animastor/*`** (ai-agent, ai-analysis, assistant, auth, contracts, editor, generation, installer, orchestration, parser, player, url-safety, vbook-runtime) + **`animastor-comfyui-workflow-connector`** (runtime), dev: `@animastor/gpu-hub`, chai, mocha, nyc, proxyquire; **никаких `file:`/`link`** | `origin` = VPS bare `…/animastor-backend.git`; `github` = `Animastor/animastor-backend` (hook) |
| **animastor-web** | §8.2 | `--path frontends/app`, `--path frontends/website`, 13 × `--path packages/animastor-web-*`, `--path tools/desktop-web-tester`, `--path tools/mobile-web-tester`, `--path app-web-rebuild.sh`, `--path ANDROID_WEB_PARITY.md` (canonical), 4 × docs-subset, `--path LICENSE` | `backend/**`, `docker/**`, `proxy/**`, `scripts/**`, `packages/animastor-{ai-*,assistant,auth,contracts,editor,generation,installer,orchestration,parser,player,url-safety,vbook-runtime,worker,gpu-hub}`, `frontends/android`, `docs/**` вне whitelist, root-rebuild-скрипты | **13 `@animastor/web-*`** + `preact`, `@preact/signals`, `preact-router`; dev: vite, vitest, typescript, `@preact/preset-vite`, testing-library, happy-dom; `.npmrc` `legacy-peer-deps=true` обязателен | `origin` = `…/animastor-web.git`; `github` = `Animastor/animastor-web` |
| **animastor-android** | §8.3 | `--path frontends/android`, `--path apk-build.sh`, `--path build-apk.sh`, `--path ANDROID_WEB_PARITY.md`, `--path LICENSE` (**без** `--path local.properties`) | всё остальное; `local.properties` (untracked/VPS-local) не переносится | package.json отсутствует — только Gradle/Maven (`junit:junit:4.13.2`); npm-резолв не применяется | `origin` = `…/animastor-android.git`; `github` = `Animastor/animastor-android` |
| **animastor-worker** | §8.4 | `--path packages/animastor-worker`, `--path docker/worker`, `--path docs/architecture/JOB_PROTOCOL_V2.md` + 15 × worker-доков, `--path LICENSE` (19 путей) | `backend/**`, `frontends/**`, `packages/` кроме worker, `docker/` кроме `docker/worker`, `scripts/**`, `proxy/**`, `docs/` вне whitelist | `dependencies`: **нет** (zero-runtime-dep bundle); `devDependencies`: **`@animastor/contracts ^0.1.1`**; `packages/animastor-worker/image/worker/package{,-lock}.json` — фикстура образа | `origin` = `…/animastor-worker.git`; `github` = `Animastor/animastor-worker` |
| **animastor-gpu-hub** | §8.5 — **REJECTED при R-3 = A — НЕ ИСПОЛНЯТЬ** | `--path packages/animastor-gpu-hub`, `--path scripts/check-artifacts.sh`, `--path gpu-hub-rebuild.sh` (**исключить при R-3 = B — X-1, §FINAL SPLIT HANDOFF п.7.1**), `--path docker/compose/overlay-gpu-hub-standalone.yml`, `--path docs/architecture/{GPU_HUB_CONTRACT, JOB_PROTOCOL_V2, PHASE_10*}`, `--path LICENSE` | всё остальное; **не входят** `docker-compose.yml`, `docker/compose/overlay-gpu-hub-local.yml`, `docker/e2e` | `@animastor/contracts ^0.1.0`, `cors ^2.8.5`, `express ^4.19.2`, `ioredis ^5.10.0`; devDeps запрещены (run-all) | `origin` = `…/animastor-gpu-hub.git` **существующий bare, не создаётся новый**; `github` = `Animastor/animastor-gpu-hub` — **существующий remote не трогать** (R-3 = A) |

**Проверки после каждого split** (readiness §6):

1. `git log --follow` по «нельзя потерять»-файлам (§8.6) — коммиты до извлечения на месте.
2. `git log --oneline | wc -l` ≠ 0; `git status` чист; `git fsck` без ошибок.
3. Отсутствие чужих доменов: `git -c core.quotepath=false ls-files | grep -E "^(frontends|backend|packages/animastor-(web|worker|gpu-hub))"` — пусто вне целевых путей.
4. Smoke-матрица §FPSG.6.
5. `git -C bare rev-parse HEAD` = push-нутому; в stderr hook'а «Mirroring to GitHub».
6. `git ls-remote` GitHub = tips bare; default branch `master`; секреты не утекли (§7 readiness).

**Команды, которые НЕЛЬЗЯ выполнять до freeze монорепо / до своих шагов**

| Запрещено | До какого момента |
|---|---|
| `git filter-repo` | до закрытия шагов 1–7 (FF, B*, P6, P1/R-3, P4) |
| `git push --force` / `push --mirror` в **существующий** `Animastor/animastor-gpu-hub` или его bare | **бессрочно, без оговорок** (R-3 = A — `repository-split-r3-decision.md` §3.1) |
| `gh repo create` / создание `animastor-gpu-hub` | бессрочно (репо существует) |
| `npm publish` | до восстановления NPM_TOKEN (P3) и до первого release-шага split-repo |
| Изменение `/home/animastor/repos/animastor.git/hooks/post-receive` | бессрочно |
| Прямой push временного клона в GitHub (минуя VPS bare) | бессрочно (§7.3 prep-plan) |
| Изменение B7-тестов, возврат `file:`/symlink deps | бессрочно |
| `git checkout master` + удаление рабочей ветки до FF | до P2 |
| Production cutover (`docker compose …` на новые выкачки) | до step 14 (B11) |

### FPSG.6 — post-split smoke matrix (минимальный обязательный набор)

Baseline — результаты `e1c63073`/`b7e2f7cd` (новые тяжёлые проверки здесь не
запускались; перечислены как обязательные **после** split).

| Repo | # | Проверка | Baseline (монорепо) |
|---|---|---|---|
| **backend** | 1 | `cd backend && npm ci` | exit 0 |
| | 2 | `npm run test:arch` | **979 passing / 2 failing** (IB-G15, T9 pre-existing) |
| | 3 | `npm test` | **979 / 2** (pretest = `../scripts/syntax-smoke.sh`, exit 0) |
| | 4 | package exports: G1 (`grep '"file:' backend/package.json` → empty) + lock 0/0/0 + G2 exports-scan по 15 pkgs | 0/0/0 ✓ |
| **web** | 1 | `cd frontends/app && npm ci` | exit 0 |
| | 2 | `npm run build:packages` | **13/13 built** |
| | 3 | `npm run typecheck` | exit 0 |
| | 4 | `npm test` (vitest) | **201/201** (15 files) |
| | 5 | `npm run build` (vite) | exit 0 |
| **worker** | 1 | `cd packages/animastor-worker && npm ci` (или zero-dep путь bundle'а) | exit 0 |
| | 2 | `node tools/sync-protocol.cjs --check` (G3) | exit 0 |
| | 3 | `node tests/run-all.cjs` (6 suites) | **45 pass / 0 fail** |
| **android** | 1 | Gradle sync/build: `./gradlew assembleDebug` (или `build-apk.sh` / `apk-build.sh`) | — |
| | 2 | registry-only resolution: **нет** package.json/npm в `frontends/android` → проверка N/A; Maven/pin `junit:junit:4.13.2` | подтверждено (0 npm-ссылок) |
| **gpu-hub** | 1 | Docker build (G4, standalone контекст) | build exit 0 |
| | 2 | `cd packages/animastor-gpu-hub && node tools/update-artifacts-lock.cjs --check` | «in sync with source trees» — **monorepo-layout only (D6)**; в hub-repo — только после re-point writer'а на Release zips (POST-SPLIT) |
| | 3 | staging SHA256 gate (pre-COPY) | **4/4 groups match** |
| | 4 | bake-in RUN | «4 groups present» |
| | 5 | post-build `check-artifacts.sh` | **ALL CHECKS PASSED 6/6** |
| | 6 | `cd packages/animastor-gpu-hub && node tests/run-all.cjs` | 22 checks |
| **все** | — | `git fsck`, `git status` clean, отсутствие чужих доменов | §FPSG.5 |

> **Порядок для package-level `npm ci`** (не входит в матрицу, но обязательно,
> если оператор ставит зависимости внутри `packages/*`): сначала
> `cd backend && npm ci`, затем `cd packages/<pkg> && npm ci` — **2 из 6**
> локов содержат 12 symlink'ей в `../../backend/node_modules/*`
> (`animastor-comfyui-workflow-connector`, `animastor-orchestration`; §FPSG.7).

### FPSG.7 — скрытые monorepo-зависимости (grep-аудит, классификация)

**Ключевой вывод:** `git filter-repo --path …` **без `--path-rename`** сохраняет
layout (`backend/`, `frontends/…`, `packages/…` остаются в корне нового репо) —
поэтому подавляющее большинство относительных ссылок продолжает работать.
Ниже — все найденные совпадения и их класс.

| Где | Что | Класс |
|---|---|---|
| `backend/package.json:13,14` | `pretest`/`test:syntax` → `bash ../scripts/syntax-smoke.sh` | **EXPECTED PRE-SPLIT** — `scripts/` входит в §8.1; сам скрипт защищён `if [ -d … ]` (нет dir → пропуск) → `npm test` post-split валиден |
| `backend/src/runtime/job-schema.js:13,17`, `backend/src/contracts/runtime-result.js:5`, `backend/src/services/assistant-ports.cjs:6`, `packages/animastor-parser/src/lazy-book/parser.js:88`, `packages/animastor-worker/worker/job-protocol-v2.cjs:6`, `packages/animastor-worker/tools/sync-protocol.cjs:12–101` | упоминания `../packages/…`, `packages/*/src` | **DOC** (комментарии/заголовки); в `job-schema.js` комментарий «NO npm dependency yet» устарел относительно B1 — дрейф, не дефект |
| `backend/tests/*` (12 файлов: `ai-connector-{acceptance,discovery,inference,provider,streaming}`, `ai-model-propagation`, `ai-shared-{inference,stream}`, `execute-lifecycle`, `generation-test-bindings`, `gpu-hub-artifacts`, `vbook-test-bindings`) | `require('../../packages/…')` | **TEST / EXPECTED PRE-SPLIT** — после split `backend/tests` → `tests`, а `packages/` остаётся в корне → путь сохраняется |
| `backend/tests/architecture/*` (34 файла по паттерну `packages/*/src`, вкл. `helpers.js`) | `REPO_ROOT = resolve(__dirname,'..','..','..')` + `PKG_SRC()`/`npmPkgDir()` | **TEST** — B7-гарды (monorepo-checkout → npm-копия), работают в обоих мирах |
| `frontends/app/scripts/build-packages.cjs` | двухветочный resolve `../../packages/animastor-web-*` → npm-копия | **EXPECTED PRE-SPLIT** (B8-дизайн) |
| `frontends/app/src/architecture/*.guard.test.ts` (7 файлов) | `PKG_ROOT = …/../../../../packages/animastor-web-*` (node:fs read) | **TEST** — layout сохраняется |
| `packages/*/package-lock.json` — **117 monorepo-relative записей в 6 локах** (из **33** локов; `backend/` и `frontends/app/` = 0): `comfyui-workflow-connector` 4 (**все → `../../backend/node_modules/*`**: `chai` 6.2.2, `mocha` 11.7.6 + `debug`/`ms`), `orchestration` 108 (**8 → `../../backend/node_modules/*`**: `chai`, `mocha`+`debug`+`ms`, `music-metadata`+`content-type`+`debug`+`ms`; **100 → sibling** `../animastor-{comfyui-workflow-connector,contracts,generation}`), `generation` 2 (sibling), `vbook-runtime` 1 (sibling `../animastor-parser`), `web-generator-sse` 1 + `file:../animastor-web-generator`, `web-generator-vbook` 1 + `file:` | линкованные зависимости в lock | **EXPECTED PRE-SPLIT** — проверено `npm ci --dry-run` (exit 0) в sse/generation/comfyui; все 117 целей существуют после split, т.к. layout сохраняется. **Ограничение**: 12 записей `→ ../../backend/node_modules/*` требуют, чтобы `backend/npm ci` был выполнен **раньше**, чем `npm ci` внутри `packages/animastor-{comfyui-workflow-connector,orchestration}`; G1 этот уровень не покрывает (guards только для backend/web-локов). Регенерация (`npm install --package-lock-only`) **после** split — не выполнять сейчас |
| `packages/animastor-installer/src/installer/setup-contract.js:74,75` | candidates `…/packages/animastor-worker/worker/package.json` | **EXPECTED PRE-SPLIT** — приоритет baked-in `/app/artifacts/…`, все чтения в `try/catch` → не фатально |
| `docker/compose/overlay-gpu-hub-local.yml:21,25,28,29` | mounts `./packages/animastor-{worker,installer}/…` | **TEST/dev + POST-SPLIT (X-1)** — уходит только в backend-repo |
| **X-1 (новое)** `gpu-hub-rebuild.sh` | `-f docker-compose.yml` + `-f docker/compose/overlay-gpu-hub-local.yml`, но сам скрипт по §8.5 уходит **только в gpu-hub-repo**, а оба compose-файла — **только в backend-repo** | **POST-SPLIT** — в gpu-hub-repo скрипт станет неработоспособным. **Не исправлено** (относится к split execution): либо внести оба файла в §8.5, либо переписать скрипт на standalone-build (G4) при split hub |
| **X-2 (новое)** `docker-compose.yml:112-114` | `build: {context: ., dockerfile: packages/animastor-gpu-hub/Dockerfile}` | **POST-SPLIT** — в backend-repo `packages/animastor-gpu-hub` исчезает → `docker compose build gpu-hub` падает; рабочий путь — `overlay-gpu-hub-standalone.yml` + `GPU_HUB_IMAGE=<digest>` (`build: !reset null`). Относится к B11/cutover; в риск-таблице final-readiness §8 упомянуты только nginx-mount'ы |
| `scripts/animastor-runtime-audit.sh:415,540,543`, `docker/e2e/dispatch-task.cjs:11` | hardcoded `/home/animastor/animastor/…` | **EXPECTED PRE-SPLIT** — VPS/deploy-инструменты; работают пока жив freeze-чекаут монорепо; уходят в backend-repo (§8.1 `scripts`, `docker`) |
| `docker/worker/Dockerfile:32,38` | `HOME=/home/animastor` | **не монорепо-путь** (домашний каталог в контейнере) — не классифицируется |
| `packages/animastor-installer/src/installer/cli.js:1000` | `require('../../package.json')` | **EXPECTED** — собственный `package.json` пакета, не корневой |
| Корневой `package.json` | **отсутствует**; читателей корневого `package.json` в tracked-коде — 0 | **DONE (B12)** |
| `node_modules/@animastor/contracts → ../../packages/animastor-contracts` (симлинк) | untracked, в git не попадает | **EXPECTED PRE-SPLIT** — runtime-резолв теперь идёт из `backend/node_modules` (B1) |
| `"file:"` / `"link"` в tracked `package.json` | **0** (в `backend/package.json`, `frontends/app/package.json` и всех `packages/*/package.json`) | **DONE (G1)** |
| `"file:"` в tracked `package-lock.json` | **только 2** (`web-generator-sse`, `web-generator-vbook` — `file:../animastor-web-generator`) | **EXPECTED PRE-SPLIT** (см. строку про 14 записей) |
| Docs (`docs/architecture/*.md`) | исторические `file:../packages/…`-примеры | **DOC** — не переписывались (массовое переписывание запрещено) |

**Ничего из этого автоматически не исправлялось** — всё, что относится к split
execution (X-1, X-2, регенерация package-lock), остаётся решением владельца.

### FPSG.8 — что должен решить/сделать владелец ДО запуска split

1. **P2 — ЗАКРЫТ**: `master` выровнен до frozen source `64127b9e…` + push
   (перепроверка: `git rev-parse master` == source).
2. ~~**P1**: создать 4 GitHub-repo + 4 bare + hooks~~ → **ВЫПОЛНЕНО**
   (GitHub — владельцем 2026-10-03: 4 × 200 пустых; **bare + hooks + remote
   `github` — 2026-10-04**: 4 bare пустые, `HEAD=refs/heads/main`, hook
   0755/91 байт byte-identical, **push не выполнялся**);
   **`animastor-gpu-hub` не создавать/не удалять/не force-push**.
3. ~~**R-3**: письменно выбрать A или B~~ → **ВЫПОЛНЕНО: R-3 = A (SELECTED),
   B = REJECTED** — `repository-split-r3-decision.md`. Существующий GPU Hub
   **не меняется**; `filter-repo` gpu-hub не выполняется; hub CI (B9.2)
   авторится в существующем репо.
4. ~~**P6 (НЕ ЗАКРЫТ — FAIL)**~~ → **ЗАКРЫТ 2026-10-04: `df -B1 /` = `6 839 934 976 B`
   (≈6.4 GiB) ≥ 5G** — **очистка не выполнялась и не требуется**
   (`pip cache purge` / `/tmp` **не нужны**; делать только по отдельному
   распоряжению владельца). Перед запуском — одна контрольная `df -B1 /`
   (значение колеблется, авторитет — команда).
5. **P4**: `sudo rmdir /home/animastor/animastor/workflow.json`; удалить строку
   `./workflow.json:/workflow.json:ro` из `frontends/android/docker-compose.yml:41`
   (android-touchpoint).
6. **P5-подтверждение**: подтвердить интерпретацию «`.github/` в монорепо не
   создаётся; G1–G5 гоняются вручную; workflows авторятся в новых репо»
   (расхождение с prep-plan §11.4 / readiness §9.4).
7. **`tmp/parser-audit-backup`**: подтвердить удаление локальной ветки и ветки в bare.
8. **P3**: выпустить новый NPM_TOKEN — до первого publish (не блокирует split).
9. **X-1 / X-2**: решить при split hub/backend, какой из вариантов по §FPSG.7
   применить (не блокирует backend/web/android/worker).
10. **(опц.)** регенерировать 6 package-lock с monorepo-линками после split.

---

## FINAL PRE-SPLIT TECHNICAL CLOSURE

Аудит на коммит-основании **`e6763c67`** (read-only: чтение, grep, python-разбор
`§8`-whitelist'ов, `npm ci --dry-run`; ничего не фильтровалось, не клонировалось,
не регенерировалось).

| Item | Status | Finding | Action during split |
|---|---|---|---|
| **X-1** `gpu-hub-rebuild.sh` | **НЕ ПРИМЕНИМО при R-3 = A** (§8.5 не исполняется) — не blocker | Скрипт по §8.5 попадает **только** в gpu-hub-repo, а оба `-f`-файла (`docker-compose.yml`, `docker/compose/overlay-gpu-hub-local.yml`) — **только** в backend-repo (§8.1 `--path docker`). В gpu-hub-repo скрипт — осиротевший. Вне `docs/` на него не ссылается **ни один** tracked-файл (все 27 вхождений — `docs/architecture/*.md`; в `repository-split-execution-readiness.md:120` он помечен `KEEP — единственный rebuild-скрипт hub`) | R-3=**A**: ничего не делать (скрипта в существующем репо нет; рабочий путь — его standalone Dockerfile + `ghcr-release.yml`). R-3=**B**: исключить `--path gpu-hub-rebuild.sh` из §8.5 **либо** принять как мёртвый код (§FPSG.7 предлагает альтернативу «внести оба compose-файла в §8.5» — **отвергнуть**: `docker-compose.yml` тянет backend/nginx-сервисы и mounts, которых в hub-repo нет). Рабочий путь run/build после split уже существует: standalone overlay + GHCR digest |
| **X-2** `docker-compose.yml` → `packages/animastor-gpu-hub/Dockerfile` | **POST-SPLIT (B11/G4)** — не blocker | Единственная production-строка с этим путём: `docker-compose.yml:112-114` (`context: .` + `dockerfile: packages/animastor-gpu-hub/Dockerfile`). Другие вхождения: комментарий `gpu-hub-rebuild.sh:2`, `scripts/syntax-smoke.sh:57,102` (под `if [ -d ]`), `packages/animastor-gpu-hub/package.json` `repository.directory` (метаданные), 8 backend-тестов (вкл. `phase10j` RETIRE-гард / `phase10t-1` MOVE-гард) | R-3=**A** и **B** одинаково для backend-repo: после split `docker compose build gpu-hub` падает → рабочий путь **`GPU_HUB_IMAGE=<digest>` + `docker/compose/overlay-gpu-hub-standalone.yml`** (файл есть в обоих репо; `build: !reset null`; пин-пример уже в `.env.example:53`). Source-level rebuild возможен только в frozen monorepo (`overlay-gpu-hub-local.yml`) либо в hub-repo после B5 re-point (G4). **Production compose до split не трогать** — иначе ломается текущий monorepo |
| **X-2a** ещё аналогичных ссылок на `packages/animastor-gpu-hub` | **DONE** | Полный grep по tracked-файлам вне `docs/` = **16**; единственный production-путь — `docker-compose.yml:114`; `packages/animastor-gpu-hub/Dockerfile:28,29,37,40,41` копирует **себя** (работать будет только из корня монорепо → G4/B5); 8 backend-тестов (гарды/EXPECTED), `gpu-hub-rebuild.sh:2`, `scripts/syntax-smoke.sh:57,102`, `installer/worker-bundle-source.js:18`, `gpu-hub/package.json`, `tools/update-artifacts-lock.cjs:8,36`, `scripts/verify-staged-artifacts.sh:11`, `phase2-hub-worker-boundary.test.js:27` — все комментарии | — |
| **X-2b** runtime `gpu-hub.js` | **DONE** | Читает артефакты строго `config → baked-in (__dirname/artifacts) → mount-fallback (/app/…)` (`resolveArtifactDir` `gpu-hub.js:1305-1317`, вызовы 1313–1317); **никакого** hardcoded monorepo-пути в runtime. Строки `packages/animastor-worker/…` — комментарии и **имена tar-entry** (`animastor-installer/…`), не FS-пути | — |
| **Lock: `animastor-comfyui-workflow-connector`** | **EXPECTED PRE-SPLIT → POST-SPLIT regen** | **4** REL-записи, **все** → `../../backend/node_modules/*`: `chai` (range `^6.2.2` → 6.2.2), `mocha` (`^11.7.5` → 11.7.6) + их `debug`/`ms`. Источник: npm hoisting при установке из монорепо. Эти каталоги существуют после split **только в backend-repo** | Порядок: `cd backend && npm ci` → затем `cd packages/animastor-comfyui-workflow-connector && npm ci`. Регенерация (`npm install --package-lock-only`) — **после** split, опционально. **Не blocker** |
| **Lock: `animastor-orchestration`** | **EXPECTED PRE-SPLIT → POST-SPLIT regen** | **108** REL-записей: **8 → `../../backend/node_modules/*`** (`chai`, `mocha`+`debug`+`ms`, `music-metadata`+`content-type`+`debug`+`ms`), **100 → sibling** `../animastor-{comfyui-workflow-connector,contracts,generation}` (все в backend-repo) | Порядок: `backend/npm ci` первым. Регенерация после split. **Не blocker** |
| **Lock: `animastor-generation`** | **EXPECTED PRE-SPLIT** | 2 REL sibling: `../animastor-contracts`, `../animastor-comfyui-workflow-connector` — оба в backend-repo; **нет** ссылок на `backend/node_modules` | Порядок не нужен. Регенерация опциональна. **Не blocker** |
| **Lock: `animastor-vbook-runtime`** | **EXPECTED PRE-SPLIT** | 1 REL sibling: `../animastor-parser` — в backend-repo | Порядок не нужен. **Не blocker** |
| **Lock: `animastor-web-generator-sse` / `-vbook`** | **EXPECTED PRE-SPLIT → POST-SPLIT regen** | root-блок lock'а = `"@animastor/web-generator": "file:../animastor-web-generator"`, а `package.json` = `^0.1.0`; sibling существует в web-repo. **`npm ci --dry-run` = exit 0** (npm 10.9.8) → не ошибка | Порядок не нужен. Регенерация после split — чтобы убрать единственные оставшиеся **`file:`** из tracked-локов (G1 их не проверяет — G1 смотрит только `package.json`). **Не blocker** |
| **Lock — итог** | **0 blocker'ов** | **117** REL-записей в **6** локах (из **33**; `backend/` и `frontends/app/` = **0**): **12 → `../../backend/node_modules/*`**, **105 → sibling-пакеты** (все существуют после split, т.к. filter-repo без `--path-rename` сохраняет layout). Ни один из 6 локов не входит в G1/G2 и не запускается smoke-матрицей §FPSG.6 | Порядок `backend/npm ci` → package `npm ci` (2 лока), регенерация 6 локов — **post-split action**, не условие split |
| **Final grep — PRODUCTION** | **0 BLOCKER** | `backend/src/**` не содержит ни одного физического обращения к `frontends/`, `packages/animastor-worker`, `packages/animastor-gpu-hub`, `packages/animastor-web-*` (grep = 0). Все `../packages`/`packages/*/src` в `backend/src` и `packages/*/src` — **комментарии** (`runtime-result.js:5`, `job-schema.js:13,17`, `assistant-ports.cjs:6`, `parser.js:88`, `sync-protocol.cjs`, `job-protocol-v2.cjs`) | — |
| **Final grep — реальный код с относительными путями** | **EXPECTED PRE-SPLIT** | `scripts/generate-parser-golden-fixtures.js` → `../backend/src/…` + `../packages/animastor-vbook-runtime/…` (оба в backend-repo ✓); `frontends/app/scripts/build-packages.cjs` (B8 двухветочный ✓); `packages/animastor-installer/src/installer/setup-contract.js:74,75` (try/catch fallback ✓) | — |
| **Final grep — `file:` / `link`** | **DONE (G1)** | в tracked `package.json` = **0**; в tracked `package-lock.json` = только 2 `file:` (web-generator-sse/vbook) + 14 `link` — см. выше | регенерация после split |
| **Final grep — hardcoded monorepo paths** | **EXPECTED PRE-SPLIT** | `scripts/animastor-runtime-audit.sh` (415, 540, 543–544), `docker/e2e/dispatch-task.cjs:11`, `docker/e2e/install-driver.cjs:16` — VPS/deploy-утилиты, уходят в backend-repo и работают, пока жив freeze-чекаут. `docker/worker/Dockerfile:32,38` — `HOME=/home/animastor` (не монорепо-путь). Дополнительно (не split-зависимое): `scripts/enable-admin-https.sh:14` = `/home/sureg/…` — **pre-existing staleness**, падает с понятной ошибкой | — |
| **Final grep — root `package.json`** | **DONE (B12)** | отсутствует; читателей корневого `package.json` в tracked-коде = 0 | — |
| **Final grep — cross-domain в runtime** | **0 BLOCKER** | web-prod → backend/worker/hub = только комментарии/i18n-строки; android → `frontends/app` = только комментарии parity; worker → backend = только комментарий в тесте; hub-runtime → см. X-2b | — |
| **X-3 (новое)** `repository.url` у 29 пакетов + 1 вложенный манифест = **30** | **POST-SPLIT (метаданные)** | все `packages/*/package.json` → `git+https://github.com/Animastor/animastor.git` + `directory: packages/…` — после split укажет в замороженный монорепо | обновить `repository.url`/`directory` **перед первым npm publish** из нового репо (рядом с P3) |
| **X-4 (новое)** `phase10t-1-artifact-bakein.test.js` | **POST-SPLIT (адаптация при B7-MOVE)** | гард `HUB_CHECKOUT_PRESENT` сделает suite пустым в backend-repo ✓; но при переносе в hub-repo (disposition MOVE) гард становится no-op, а suite читает `docker-compose.yml:72`, `packages/animastor-installer/src/installer/{install-manifest,setup-contract}.js:110,120`, `docker/compose/overlay-gpu-hub-local.yml:173` — **в hub-repo этих файлов нет → ENOENT** | при переносе suite в hub-repo оставить только AB1/AB3/AB5/AB7 (Dockerfile, `gpu-hub.js`, `check-artifacts.sh`) и AB8 перевести на standalone-overlay; AB2/AB4 считать backend-repo-спецификой. **Не изменять сейчас** (запрет на правку B7) |
| **Whitelist verification §8** | **DONE — 100%** | автоматический сверочный прогон §8.1–8.5 против `git ls-files` (**1635 tracked** на `64127b9e`; было 1626 до doc-коммитов): **непокрытых файлов = 0**, т.е. ни один tracked-файл не теряется. `--path`-записей без tracked-файла ровно **2** — `workflow.json` и `local.properties` (оба untracked, уже задокументированы как no-op/исключаемые). Сумма по репо с перекрытием: backend **1045**, web 349, android 217, worker 58, gpu-hub **45** = **1714** (= 1635 + 79 задекларированных дублей) | исключить эти 2 `--path` из выполняемых команд (§FPSG.5) |
| **Whitelist — дубли (осознанные)** | **DONE** | `backend+web`: 31 doc; `backend+gpu-hub`: 23 (docs + `overlay-gpu-hub-standalone.yml`); `backend+worker`: 18 (`docker/worker/*` + docs); `web+android`: 1 (`ANDROID_WEB_PARITY.md`); `backend+worker+gpu-hub`: 1 (`JOB_PROTOCOL_V2.md`); все 5: `LICENSE` | — |
| **Whitelist — лишние пути** | **0 найдено** | ни один `--path` не захватывает чужой домен (все top-level набора backend: `backend`, `packages`, `docs`, `docker`, `scripts`, `proxy`, root-файлы; web: `packages`, `frontends`, `tools`, `docs`; android: `frontends`, root-скрипты; worker: `packages`, `docs`, `docker`; gpu-hub: `docs`, `packages`, `docker`, `scripts`, `gpu-hub-rebuild.sh`) | — |
| **Межрепозиторные зависимости после split** | **DONE (задокументированы)** | hub→worker/bck (Release-assets, B5); hub/worker→backend (npm `@animastor/contracts`, G7 `JOB_PROTOCOL_V2.md`); android→web (G7 parity); backend→web/hub (compose-mount'ы **B11**); package-локи → `backend/node_modules` (2 лока / 12 записей) | — |

**Настоящий blocker из этого раздела: отсутствует.** Всё перечисленное —
либо **EXPECTED PRE-SPLIT** (работает, т.к. filter-repo сохраняет layout),
либо **POST-SPLIT** (действие в момент split/cutover). Единственные реальные
блокеры остаётся внешними и не изменяются этим аудитом: **P1, P2, P3, P6**
(**R-3 снят** — A = SELECTED, B = REJECTED, `repository-split-r3-decision.md`)
(см. §FPSG.3 / сводный блок в конце документа).

---

## Самопроверка документа

- **Коммитная атрибуция**: tests/mechanical verification — на `e1c63073`;
  `4f947c56` — documentation-only finalization (тесты не перезапускались).
  Закрывающий технический аудит (§FINAL PRE-SPLIT TECHNICAL CLOSURE) — на
  `e6763c67`, read-only, ничего не создано/удалено/отфильтровано.
  FINAL SPLIT HANDOFF (§FINAL SPLIT HANDOFF) — исходная запись на `7df461fa`,
  далее только документационные коммиты этого gate'а (read-only); авторитетный
  source — `64127b9e…`, а не текущий tip.
- B9 FINAL matrix: **9 unique workflow files / 12 workflow entries** across
  5 future repositories (backend 2 + web 2 + worker 3 + gpu-hub 3 + android 2
  = 12 entries; уникальных имён — 9: `ci.yml` ×5, `release.yml` ×3,
  `parity.yml` ×3, `ghcr-release.yml` ×1 — каждый с trigger, npm install,
  typecheck, tests, build, tokens, pre-release, SHA256, docker, split-only
  columns). D3–D11 corrections сохранены.
- P4: re-verified (на `e1c63073`) — пустой каталог, не tracked, runtime не
  использует; safe rmdir задокументирован; stale android-compose-mount
  зафиксирован.
- P6: обновлён факт (2.8G — insufficient для 5 repos; installer-cli tmp
  очищены между сессиями); minimal cleanup (pip cache → 7.2G) документирован;
  команды не выполнялись. **Re-verified на `b7e2f7cd`: 3.1G свободно, pip
  cache 4.4G не очищался → ≥5G по-прежнему не достигнуто.**
  **Актуально (2026-10-04): P6 = CLOSED / PASS — 6 839 934 976 B ≈6.4 GiB ≥ 5G,
  без очистки; всё выше — исторический audit trail (§0, §FPSG.2).**
- B5: 4 группы exact values (полные sha256_tree) сверены; gate ordering
  (line 30 < line 44) подтверждён по номерам строк; tamper test executed
  (clean pass / tamper fail); legacy `old_*` — в digest, не в baselines,
  loader-excluded, не удалять; документационные дрейфы старых доков
  зафиксированы (не переписывались).
- Mechanical (на `e1c63073`): все проверки зелёные; IB-G15/T9 — pre-existing;
  один transient flake зафиксирован честно.
- Ограничения соблюдены: physical split не выполнялся; filter-repo нет;
  новых GitHub repos нет; force-push нет; существующий GPU Hub repo не
  изменён; npm publish нет; production architecture changes нет;
  file:/symlink deps не возвращены; B7-тесты не изменены.
- `4f947c56` (documentation-only): изменён только этот документ — production
  code, tests, package.json, package-lock, Dockerfile, artifacts.lock, B5
  scripts, B7 tests, CI files, `.github`, GPU Hub, physical split,
  filter-repo, GitHub repositories, hooks, npm publish — **не тронуты**.
- **FINAL PRE-SPLIT GATE commit** (`3505286b`, первый после `b7e2f7cd`): изменён
  только `docs/architecture/repository-split-next-blockers.md`; все проверки
  §FPSG — read-only (`git status/log/ls-files`, grep, `npm ci --dry-run`,
  `test:arch`, `sync-protocol --check`, `update-artifacts-lock --check`,
  `npm whoami`/`npm view`, `df`, GitHub API GET) — ничего не создано,
  не удалено, не опубликовано, не перезаписано.
- **FINAL SPLIT HANDOFF commit** (исходно `7df461fa`; далее — только
  документационные коммиты этого gate'а): изменён только
  `docs/architecture/repository-split-next-blockers.md` (позднее к списку
  добавились `repository-split-final-gate.md` и
  `repository-split-execution-pack.md` — итог: только `docs/architecture/*.md`);
  проверки —
  read-only git-графика/grep/python-разбор whitelist'ов и локов. Во время
  этой итерации **не выполнялось**: `git filter-repo`, clone'ы, `npm install`
  / `npm ci`, создание репозиториев, force-push, правка hook'ов, npm publish.

---

## FINAL PRE-SPLIT GATE

- **Technical blockers:** B1 · B2 · B3 · B4 · B6 · B7 · B8 · B10 · B12 =
  **DONE**; B5 · B9 = **READY** (B5-остаток — POST-SPLIT Release-assets);
  B11 = **POST-SPLIT**; P4 = **READY**; P5 = **POST-SPLIT**
  (расхождение с prep-plan §11.4 требует подтверждения).
- **Закрывающий технический аудит (§FINAL PRE-SPLIT TECHNICAL CLOSURE, на
  `3505286b`): новых blocker'ов 0.** X-1 = **не применимо (R-3 = A)**, X-2 = POST-SPLIT (B11-G4);
  package-lock = EXPECTED PRE-SPLIT (117 записей в 6 локах, 12 →
  `backend/node_modules`, порядок `backend/npm ci` первым); финальный grep по
  production = 0; whitelist §8 = **1635/1635** покрыто (пересчёт на `64127b9e`;
  на `3505286b` было 1626/1626), 2 no-op `--path` исключаются;
  X-3 (`repository.url`) и X-4 (`phase10t-1` при B7-MOVE) = POST-SPLIT.
- **Owner decisions:** **P2 — ЗАКРЫТ** (`master` = source `64127b9e…`, FF уже
  выполнен и запушен) · **P1** (создать 4 репо backend/web/android/worker;
  gpu-hub существует — не трогать; **R-3 = A**: `filter-repo` gpu-hub не
  выполняется, новый репо не создаётся, force-push/overwrite/delete запрещены,
  standalone history канонична) · **`NEWBRANCH = main` — ПОДТВЕРЖДЁН
  (GO-05, 2026-10-04)** · **P5-интерпретация** · **удаление
  `tmp/parser-audit-backup`**.
- **External blockers:** ~~**P1**~~ **СНЯТ / CLOSED (2026-10-04)** —
  GitHub-repo 4 × 200 пустых **+ 4 bare + hooks + remote `github`** (push не
  выполнялся, все стороны пусты) · **P3** (npm E401 — publish
  только; install работает) · ~~**P6**~~ **СНЯТ (6.4G ≥ 5G, 2026-10-04)** ·
  **R-3 — СНЯТ (A = SELECTED, B = REJECTED)**. **P2 снят.**
  **GO-05 — ЗАКРЫТ (2026-10-04)**: `NEWBRANCH = main` подтверждён владельцем
  письменно и зафиксирован в docs (owner-confirmation — pre-split-go-blockers
  §7.1); **стадия B ВЫПОЛНЕНА** (GO-08 backup + GO-14 BEFORE-snapshot).
- **Physical split:** **NOT EXECUTED** (нет filter-repo, force-push, новых
  GitHub-репо, изменений существующего GPU Hub/его hook, npm publish,
  изменений B7/production; изменены только документы `docs/architecture/*.md`).
- **Ready to execute after:** ~~1) FF `master`~~ **(выполнено)**;
  ~~1) ≥5G диска (P6)~~ **(выполнено без очистки: 6.4G ≥ 5G, 2026-10-04)**;
  ~~2) 4 bare + hook + remote `github`~~ **(выполнено 2026-10-04: 4 bare пустые,
  hook 0755/91 байт byte-identical, remote настроен; push не выполнялся)**;
  ~~3) подтверждение `$NEWBRANCH = main` владельцем (GO-05)~~ **(закрыто
  2026-10-04)**; ~~backup + BEFORE-snapshot (стадия B, GO-08/GO-14)~~
  **(выполнено 2026-10-04)**;
  4) подтверждение P5-интерпретации и решение по `tmp/parser-audit-backup`;
  5) P4-гигиена (`rmdir workflow.json`, android-mount) — **гигиена, не
  блокирует**; 6) P3 — до первого publish. Тогда шаги §FPSG.5:
  filter-repo backend → web → android → worker (**gpu-hub исключён, R-3 = A**) →
  smoke §FPSG.6 → freeze → cutover (B11).

---

## FINAL SPLIT HANDOFF

Последний технический пакет перед физическим `filter-repo`. Основание — HEAD
ветки `c21.4-physically-extract-analysis-from-backend` (**frozen source
`64127b9e…`**, §1; первоначальная запись — на `7df461fa`), рабочее дерево
чистое, **1635 tracked-файлов** (было 1626). Все проверки ниже —
**read-only** (git-графика, grep, python-разбор §8, `npm view`, `npm whoami`,
`df`, GitHub API). Ничего не фильтровалось, не клонировалось, не публиковалось.

### 1. Frozen source SHA

**Один точный SHA для физического `git filter-repo`:**

> **`64127b9e1dea2ac528a572b51b90a542b70c5ebb`**
>
> (см. также `repository-split-final-gate.md` §0 — авторитетный статус)

| Поле | Значение (факт) |
|---|---|
| **Source для `git filter-repo` (единственный)** | **`64127b9e1dea2ac528a572b51b90a542b70c5ebb`** |
| **Почему именно он** | это последний коммит, на котором **все** механические проверки выполнены заново **и подтверждены**: G1–G5 **ALL GREEN** (`scripts/split-guards/run-all.sh`), B7 `test:arch` = **979/2** (IB-G15, T9 — pre-existing), hub `npm test` = **22/0**, whitelist §8 = **1635/1635, 0 uncovered**, command sheet сверен со §8, B5/G5 постсплит-путь прогнан (4/4 assets + tamper-отказ + `check-artifacts.sh` 6/6 в standalone-образе), `npm whoami`/`df`/GitHub-API — факты этого же состояния |
| Текущий HEAD ветки | `64127b9e…` **+ документационные коммиты этого gate'а** (на момент записи: **7** — `5c34de54`, `2c6fdec6`, `c8341258`, `e64b6afc`, `e768a7cc`, `8e925c5c` + doc-коммит EXECUTION PACK; каждый следующий doc-коммит даёт +1; **источник истины — команда, не список SHA**: `git rev-list --count 64127b9e…HEAD`) — **только документационный HEAD, НЕ source** (см. правило ниже) |
| `master` / bare `master` / `origin/master` | **все три = `64127b9e…`** (P2 выполнен: `04da33ea` → `64127b9e`, push без force) |
| **Relation с `master`** | `master` **==** frozen source → **разрыв 0**; **FF выполнен** |
| **Требование P2** | **ВЫПОЛНЕНО** — `master` и есть frozen source; NO-GO №1 снят |
| Цепочка `b7e2f7cd` → source | `b7e2f7cd` → `3505286b` → `e6763c67` → `7df461fa` → `f675f7eb` → `c69f5fd5` → `925d309d` → `6798d786` → `04da33ea` → `63c75362` → **`64127b9e`**; **merge-коммитов 0** |
| Delta `b7e2f7cd..source` | **13 файлов** (+3675/−56): guard-скрипты `scripts/split-guards/*` (4), gpu-hub standalone/g5/stager (`Dockerfile`, `artifacts.lock.json`, `scripts/fetch-pinned-assets.sh`, `tools/{g4-standalone-build,g5-artifact-integrity,standalone-fixture,update-artifacts-lock}.*`), `packages/animastor-ai-analysis/package-lock.json`, этот handoff-документ |
| Теги | **0** → `--tag-rename` не нужен |
| Всего коммитов от HEAD (на source) | 1653 (первый — `380a7773`, «Recovery01: June 9 working state + dedup») |
| bare ↔ GitHub | `master` = `64127b9e…` в обоих (зеркало сходится; `post-receive` не изменялся) |

**Правило source (единственное, что исполняется):** `filter-repo` запускается
**только** от **`64127b9e…`** — и для **четырёх** репо (backend/web/android/
worker; **gpu-hub не фильтруется — R-3 = A**, `repository-split-r3-decision.md`).
Основание: источник не должен зависеть от коммитов, добавленных
**после** заморозки, иначе каждый документационный коммит меняет SHA, который
оператор вставляет в командную строку. Коммиты после `64127b9e…` меняют
**только** `docs/architecture/*.md` (этот handoff, `repository-split-final-gate.md`,
`repository-split-execution-pack.md`);
извлечение всех путей §8 **побайтово идентично** (по ним же — счётчики
`1045 / 349 / 217 / 58 / 45` в command sheet, верны именно на source).
Следствие: эти документы в новые репо **не попадают** (остаются в архиве-
монорепо), но оператору они и нужны из архива — это не потеря.
Выбор SHA подтверждается владельцем — п.10.

### 2. Technical status

| Группа | Статус |
|---|---|
| B1–B4, B6–B8, B10, B12 | **DONE** |
| B5 (artifact scheme), B9 (CI matrix) | **READY** — POST-SPLIT остаток (Release-assets / workflows в новых репо) |
| B11 (deploy cutover) | **POST-SPLIT** |
| B7 (disposition тестов) | **DONE** (`35ba2b82`); изменения B7 запрещены |
| whitelist §8 vs `git ls-files` | **DONE — 1635/1635 покрыто**, 0 потерь; 2 no-op `--path`. **При R-3 = A исполняются §8.1–§8.4: 1669 instance'ов = 1615 unique; 20 файлов (`packages/animastor-gpu-hub/*` + `gpu-hub-rebuild.sh`) остаются только в замороженном монорепо** (§7.1) |
| package-lock | **EXPECTED PRE-SPLIT** — 117 относ. записей в 6 локах, 0 в `backend/` и `frontends/app/` |
| финальный grep (production) | **0 BLOCKER** |
| registry/install path | **OPEN** — 29/30 пакетов опубликованы (`npm view` = read OK); `@animastor/worker-dev` в registry отсутствует (его никто не импортирует) |
| publish path | **CLOSED** — `npm whoami` = E401 (перепроверено 2026-10-04) |
| **P6 (диск)** | **CLOSED / PASS (2026-10-04)** — `df -B1 /` = `6 839 934 976 B` (≈6.4 GiB) ≥ 5G; очистка не выполнялась и не требуется |
| **P1 (GitHub / bare)** | **CLOSED (2026-10-04)** — GitHub: 4 × 200, `size=0`, 0 refs; VPS: **4 bare + hook + remote `github` созданы** (0 refs/0 objects, `HEAD=refs/heads/main`, hook 0755/91 байт byte-identical); **push не выполнялся** |
| **P4 / P5 / `tmp/parser-audit-backup`** | **NOT YET EXECUTED** (гигиена/подтверждения: каталог `workflow.json` есть, android-mount остался, ветка `db5ff61f` есть) |
| Physical split | **NOT EXECUTED** |

### 3. Owner decisions

| Decision | Что именно нужно решить | Почему это нужно | Что произойдёт после решения |
|---|---|---|---|
| **P1** | ~~Создать GitHub-repo `animastor-{backend,web,android,worker}` + 4 bare + hooks~~ → **ВЫПОЛНЕНО**: GitHub — владельцем (2026-10-03, 4 × 200, `size=0`, 0 refs, `default_branch=main`); **bare + hooks + remote `github` — 2026-10-04** (4 bare пустые, `HEAD=refs/heads/main`, hook 0755/91 байт byte-identical, remote настроен). **GPU Hub отдельно НЕ создавать и НЕ заменять** (существующий `Animastor/animastor-gpu-hub` = HTTP 200, `7c7778c`, 43 коммита) | **Статус 404 устарел**; **статус «bare отсутствуют» устарел с 2026-10-04**. Без hook'ов `git push` после filter-repo физически невозможен — hook обязан существовать **до** первого push (§7.2 prep-plan); **наличие подтверждено, push не выполнялся** | Шаг 6 очереди §FPSG.5 **готов технически** (куда push-ить backend/web/android/worker — есть); hub остаётся нетронутым |
| **R-3** | **DECIDED — A (SELECTED)**: сохранить существующий `Animastor/animastor-gpu-hub` (свой Dockerfile, `ci.yml`, `ghcr-release.yml`, история в `master` — **канонична**). **B — REJECTED / NOT SELECTED** (замена историей монорепо, §8.5 — **не выполняется**) | Определяло: запускается ли §8.5; какие CI-workflows авторить (B9-hub); куда идёт B5; судьбу `gpu-hub-rebuild.sh` (X-1) — **решено: A** | **A (действует)**: `filter-repo` gpu-hub **не выполняется**, шаг 5 из очереди исключён, существующие репо/bare/hook/GitHub не трогаются, новых репо не создаётся; force-push/overwrite/delete — **запрещены бессрочно**. Вариант B — **REJECTED** |
| **P2** | **Exact source SHA** = `64127b9e…` (п.1) — **и `master` уже выровнен до него (CLOSED)** | Фильтрация от не-FF'нутого/не того tip даст репо с историей, не совпадающей с `master` и с результатом последующих проверок. NO-GO №1 final-readiness §7 — **снят** | `master` == source == `origin/master` (перепроверка: `git rev-parse master`); все 4 новых репо и архив-монорепо указывают на одну и ту же точку |
| **P3** | npm credentials: **`npm whoami` → E401**, токен в `~/.npmrc` недействителен (1 `_authToken`); `npm view`/install работают | Без валидного токена закрыты **publish** и **Release**-путь B5 (4 zip + digest в `artifacts.lock.json`), а также публикация 15 backend + 13 web пакетов | Разблокируется первый publish из новых репо; **сам filter-repo НЕ блокируется** — позиционируется как POST-SPLIT requirement (до первого publish, не до split) |
| **P6** | Минимальный свободный диск: **≥5G** (рекомендуется ≥8G) | **CLOSED / PASS (2026-10-04)**: `df -B1 /` → **6 839 934 976 B (≈6.4 GiB) ≥ 5G** → 1.27× порога, 6.4× измеренного минимума 1 GiB (пик ≈431 MB). Исторически (audit trail): 2.9G / 2.8G — **FAIL** | **Решение не требуется, очистка не требуется**; ранее предложенные `pip cache purge` ≈4.4G и `/tmp`-шаги **отозваны** (выполнять только по отдельному распоряжению владельца). Перед запуском — контрольная `df -B1 /` |
| **P5** | Интерпретация: workflows создаются **в новых репо**, а не в монорепо (расхождение с prep-plan §11.4) | `.github/` отсутствует в монорепо; CI в монорепо бессмыслен | Подтверждение снимает §FPSG.4 п.2 / §FPSG.8 п.6 |
| **P4** | Гигиена: `rmdir /home/animastor/animastor/workflow.json` (пустой untracked-каталог) + снять stale android-compose-mount. **НЕ удалять** `workflow.json` как git-объект — его в дереве нет (no-op `--path`) | ~~Каталог в корне мешает чистому `git status` в новых репо~~ → **неточность, исправлено (2026-10-04)**: пустой untracked-каталог **не виден** `git status` (проверено: `--porcelain` = 0 строк) и **не попадает** в клон `$SPLIT` (клонирует только tracked-дерево) — реальный вред ограничивается рабочим деревом монорепо и **stale bind-mount** у живого контейнера; в whitelist §8.1 каталог входит как no-op | Освобождает precondition §4 перед шагом 1; `--path workflow.json` исключается из команды backend (§4.1.1) |
| **`tmp/parser-audit-backup`** | Подтвердить удаление ветки **`db5ff61f`** (`refs/heads/tmp/parser-audit-backup`, есть и в bare). **Сам подтверждение — решение владельца; до него ветку НЕ удалять** | Ветка пережила split-подготовку; её наличие в новом bare дало бы лишнюю ref | После подтверждения — `git branch -D tmp/parser-audit-backup` в монорепо и в backup-клоне; на извлечение не влияет |

### 4. Exact split order

**Предусловия** (все закрываются **до** шага 1; полный список — п.10):

- **P2 — ВЫПОЛНЕН** (`master` == `origin/master` == `64127b9e…`; перед запуском
  только перепроверить `git rev-parse master`)
  (+ P4-гигиена: `rmdir workflow.json`, снять stale android-compose-mount, `tmp/parser-audit-backup` — по подтверждению);
- **P6 — ВЫПОЛНЕНО** (2026-10-04): ≥5G свободно (**6.4G**), очистка **не
  требовалась**; перед запуском — контрольная `df -B1 /`;
- **P1 — ВЫПОЛНЕНО (2026-10-04)** — GitHub-репо (4 × 200, пустые) **+ 4 bare +
  `post-receive` hook'и (0755/91 байт byte-identical) + remote `github`**
  (см. §4.1.0, GO-01…GO-04 = CLOSED/READY; **push не выполнялся**);
- **R-3** — **зафиксирован A (SELECTED), B = REJECTED**; hub-CI авторится в существующем репо, шаг 5 исключён из очереди.

**Очередь — ровно такая** (§FPSG.5; **слот `gpu-hub` удалён — R-3 = A**):

1. `animastor-backend`
2. `animastor-web`
3. `animastor-android`
4. `animastor-worker`
5. **Smoke checks** каждого репо (§8 / §6)
6. **Freeze** монорепо (архив) + **cutover** B11 (compose/nginx на новые bare)

~~5. `animastor-gpu-hub`~~ — **исключён из очереди**: `filter-repo` для GPU Hub
**не выполняется**, существующее репо `Animastor/animastor-gpu-hub`
**не перезаписывается**, новый репозиторий **не создаётся**
(`repository-split-r3-decision.md`).

Шаги 1–4 независимы и идемпотентны: каждый выполняется в **отдельном**
свежем клоне, `--path-rename` не используется → корневой layout не меняется.
P3 (npm) — **не** часть split-очереди: он нужен только до первого publish.

**Запрещено на любом шаге:** `--path-rename`, force-push, изменение hook'а
монорепо, создание/удаление/замена существующего GPU Hub, npm publish,
изменение production-кода, изменение B7-тестов, регенерация текущих lock'ов.

### 4.1 Exact command sheet (copy/paste)

> **СТАТУС ИСПОЛНЕНИЯ (2026-10-04):** **§4.1.0 + §4.1.1 (backend) —
> ВЫПОЛНЕНО** владельцем-авторизованной стадией C: свежий клон →
> `reset --hard $SRC` → `update-ref` → `reflog expire` → `filter-repo` (35
> `--path`, **без `--path-rename`, без `--force`, без `--path workflow.json``,
> RC=0) → AFTER-проверки **1045 файлов / 1267 коммитов / leak 0 / fsck чисто /
> clean tree / корень `Recovery01` / `--follow` 5/5** → guard'ы пустого bare и
> `origin == $NEW` → **первый push `HEAD:refs/heads/main` без `--force`** →
> post-receive hook → GitHub = bare = **`f83f929c732d8fc490bd150e72294d6b3c6e2f92`**
> (ровно 2 refs, лишних нет). Журнал — `repository-split-execution-pack.md` **§11**.
> **§4.1.2 (web) — ВЫПОЛНЕНО (2026-10-04)** стадией C: свежий клон →
> `reset --hard $SRC` → `update-ref` → `reflog expire` → `filter-repo` (31
> `--path`, **без `--path-rename`, без `--force`**, RC=0) → AFTER-проверки
> **349 файлов / 275 коммитов / leak 0 / docs-subset CLEAN / fsck чисто /
> clean tree / tracked-set == whitelist / корень `docs: reorganize…`** →
> guard'ы пустого bare и `origin == $NEW` → **push `HEAD:refs/heads/main`
> без `--force`** → hook → GitHub = bare = **`4c3ea0fb2a1adb552ba1c9acd98abc41befdab3b`**
> (ровно `refs/heads/main` + github-дубль). Журнал —
> `repository-split-execution-pack.md` **§12**.
> **§4.1.3 (android) — ВЫПОЛНЕНО (2026-10-04)** стадией C: свежий клон →
> `reset --hard $SRC` → `update-ref` → `reflog expire` → `filter-repo` (5
> `--path`, **без `--path-rename`, без `--force`**, RC=0) → AFTER-проверки
> **217 файлов / 107 коммитов / leak 0 / fsck чисто / clean tree /
> tracked-set == whitelist / корень `Recovery01`** → guard'ы пустого bare и
> `origin == $NEW` → **push `HEAD:refs/heads/main` без `--force`** → hook →
> GitHub = bare = **`efa4b2937bc1954900c0e5aa9501667f42d6a70d`** (ровно
> `refs/heads/main` + github-дубль). Журнал —
> `repository-split-execution-pack.md` **§13**.
> **§4.1.4 (worker) — НЕ ВЫПОЛНЯЛОСЬ** (отдельная авторизация владельца);
> **§4.1.5 (gpu-hub) — REJECTED, НЕ ИСПОЛНЯЕТСЯ**.

Все пути и SHA сверены с реальным деревом VPS; счётчики `git ls-files | wc -l`
пересчитаны **на frozen source `64127b9e…`** (см. `repository-split-final-gate.md`
§3). Лист приведён
готовым к исполнению **после** owner approval. Ничего из этого здесь не запускалось.

> **Состав листа при R-3 = A:** исполняются **§4.1.0, §4.1.1 (backend),
> §4.1.2 (web), §4.1.3 (android), §4.1.4 (worker), §4.1.6 (прочее)**.
> **§4.1.5 (`animastor-gpu-hub`) — REJECTED / NOT SELECTED — НЕ ИСПОЛНЯТЬ**
> (`repository-split-r3-decision.md`): `filter-repo` для GPU Hub не
> выполняется, существующий репозиторий не перезаписывается.

#### 4.1.0 Общий блок (один раз)

> **Ревизия (docs-only, см. `repository-split-execution-pack.md` §4):**
> (1) добавлена `git reflog expire --expire=now --all` — **без неё `filter-repo`
> abort'ится на sanity-check «expected at most one entry in the reflog»**;
> (2) все контроли переведены с `test … && echo OK` на `… || { FAIL; exit 1 }`
> — отдельный `test` в `&&`-списке **исключён** из `set -e` и молча
> пропускается; (3) добавлены guard'ы повторного запуска и durable-бэкап;
> (4) проверка версии через метаданные пакета.
> **(5) 2026-10-04: стадия B ВЫПОЛНЕНА** — `$BK` создан (`--no-local`,
> независимая копия), BEFORE-snapshot снят на диск; блок №0 переписан из
> «создать» в «**проверить**» (идемпотентен, повторный запуск не перезаписывает
> backup) и дополнительно сверяет GPU Hub (R-3 = A: только чтение).

```sh
set -euo pipefail
SRC=64127b9e1dea2ac528a572b51b90a542b70c5ebb
BARE=/home/animastor/repos/animastor.git
SPLIT=/tmp/split
BRANCH=c21.4-physically-extract-analysis-from-backend
NEWBRANCH=main            # имя корневой ветки НОВЫХ репо — решение владельца (п.10 №12);
                          # **GO-05 = CLOSED (2026-10-04): NEWBRANCH=main подтверждён
                          # владельцем письменно** + сверён с GitHub default_branch=main (×4)
                          # и symbolic-ref HEAD=refs/heads/main (×4).
                          # §FPSG.5 Этап 1 говорит `master`, триггеры §B9.2 — `main`:
                          # имя ветки правится ТОЛЬКО здесь (I-12).

# версия: `git filter-repo --version` печатает хеш сборки (`a40bce548d2c`), а НЕ номер
# версии — 2.47.0 читается только из метаданных пакета
python3 -c "import importlib.metadata as m; v=m.version('git-filter-repo'); assert v=='2.47.0', v"
test -x /home/animastor/.local/bin/git-filter-repo

# 0) backup + контроль неизменности источника — ВЫПОЛНЕНО 2026-10-04 (GO-08 + GO-14).
#    $BK и BEFORE-snapshot уже созданы подготовительной ревизией: блок стал
#    ИДЕМПОТЕНТНЫМ — при повторном запуске backup только ПРОВЕРЯЕТСЯ (не создаётся,
#    не перезаписывается), BEFORE берётся из snapshot-файла и сверяется с живыми refs.
mkdir -p "$SPLIT"
BK=/home/animastor/backups/animastor-pre-split-64127b9e.git   # durable; /tmp НЕ годится для backup:
                                                              # volatile и тот же FS `/`, что P6-очистка (I-7)
SNAP=/home/animastor/backups/before-split-64127b9e-refs       # BEFORE-snapshot refs (GO-14), режим только чтение
GPUHUB=/home/animastor/repos/animastor-gpu-hub.git            # R-3 = A: только сверка, НИКОГДА не пишется
test -d "$BK" || { echo "FAIL: backup отсутствует — GO-08 не выполнен"; exit 1; }
test -f "$SNAP/animastor.git.refs.txt" || { echo "FAIL: BEFORE-snapshot отсутствует — GO-14 не выполнен"; exit 1; }
test "$(git -C "$BK" rev-parse "$SRC^{commit}")" = "$SRC" || { echo "FAIL: backup не содержит $SRC"; exit 1; }
git -C "$BK" fsck --no-progress || { echo "FAIL: backup не проходит fsck"; exit 1; }
test "$(git -C "$BARE" rev-parse "$SRC^{commit}")" = "$SRC" || { echo "FAIL: $SRC не найден в bare"; exit 1; }
git -C "$BARE" merge-base --is-ancestor "$SRC" "$BRANCH" || { echo "FAIL: $SRC не предок $BRANCH"; exit 1; }
test "$BRANCH" != master || { echo "FAIL: BRANCH не должен быть master"; exit 1; }
BEFORE=$(git -C "$BARE" for-each-ref --format='%(objectname) %(refname)' | sort)
# GO-14: сверка живых refs с BEFORE-snapshot. ДОСЛОВНО сравниваются только
# неизменяемые refs (master, tmp/parser-audit-backup и их refs/remotes/github/*)
# и общее число refs; docs-ветка c21.4-physically-extract-analysis-from-backend
# законно продвигается КАЖДЫМ docs-only коммитом (в т.ч. коммитом, записавшим эту
# строку) — для неё требуется только fast-forward от snapshot-тапа. Жёсткое
# равенство «все 6 refs дословно» давало бы ложный FAIL после любого doc-коммита.
# GPU Hub (R-3 = A, 2 refs, неизменяем) сверяется дословно — без исключений.
check_bare_snapshot() {
  local snapf="$SNAP/animastor.git.refs.txt" r snap_sha n_snap n_live
  test -f "$snapf" || { echo "FAIL: $snapf отсутствует (GO-14)"; return 1; }
  for r in refs/heads/master refs/remotes/github/master \
           refs/heads/tmp/parser-audit-backup refs/remotes/github/tmp/parser-audit-backup; do
    snap_sha=$(awk -v r="$r" '$2==r{print $1}' "$snapf")
    test -n "$snap_sha" || { echo "FAIL: $r нет в BEFORE-snapshot (GO-14)"; return 1; }
    test "$(git -C "$BARE" rev-parse "$r")" = "$snap_sha" || { echo "FAIL: $r изменился (GO-14)"; return 1; }
  done
  n_snap=$(awk 'END{print NR}' "$snapf")
  n_live=$(git -C "$BARE" for-each-ref | awk 'END{print NR}')
  test "$n_snap" = "$n_live" || { echo "FAIL: refs монорепо $n_live != snapshot $n_snap (GO-14)"; return 1; }
  for r in "refs/heads/$BRANCH" "refs/remotes/github/$BRANCH"; do
    snap_sha=$(awk -v r="$r" '$2==r{print $1}' "$snapf")
    test -n "$snap_sha" || { echo "FAIL: $r нет в BEFORE-snapshot (GO-14)"; return 1; }
    git -C "$BARE" merge-base --is-ancestor "$snap_sha" "$(git -C "$BARE" rev-parse "$r")" \
      || { echo "FAIL: $r не fast-forward от BEFORE-snapshot (GO-14)"; return 1; }
  done
}
check_bare_snapshot || { echo "FAIL: монорепо не соответствует BEFORE-snapshot (GO-14)"; exit 1; }
echo "OK: monorepo == BEFORE-snapshot (неизменяемые refs дословно, docs-ветка fast-forward)"
test "$(git -C "$GPUHUB" for-each-ref --format='%(objectname) %(refname)' | sort)" = "$(cat "$SNAP/animastor-gpu-hub.git.refs.txt")" || { echo "FAIL: refs GPU Hub != BEFORE-snapshot (R-3 = A, GO-14)"; exit 1; }
test "$(git -C "$GPUHUB" rev-parse refs/heads/master)" = "7c7778c6f313dad19eb403d8509cd297226ec7ea" || { echo "FAIL: GPU Hub master изменился"; exit 1; }
# исходная команда создания (ВЫПОЛНЕНА 2026-10-04; при повторном запуске НЕ запускать — guard выше):
# git clone --mirror --no-local "$BARE" "$BK"   # отдельная mirror-копия (НЕ hardlink: обычный
#                                               # локальный clone хардлинкует pack'и), ≈22M; оригинал не пишется
echo "OK: backup $BK + BEFORE-snapshot $SNAP (GO-08/GO-14)"

# 1) P2-проверка (после FF master)
test "$(git -C "$BARE" rev-parse refs/heads/master)" = "$SRC" || { echo "FAIL: master != frozen source"; exit 1; }
echo "OK: master == source"
```

> **Верификация — только через `|| { echo "FAIL: …"; exit 1; }` + отдельный
> `echo OK`.** Одна строка `test … && echo OK` под `set -e` **не останавливает
> выполнение**: отдельная команда в `&&`-списке исключается из `set -e`,
> поэтому падающий `test` ничего не печатает и shell идёт дальше.
> Доказано: `bash -c 'set -e; test 1 -eq 2 && echo YES; echo end'` → печатает
> `end`, exit **0** (I-2, execution-pack §4).

После каждого репо — контроль того, что источник не тронут:

```sh
AFTER=$(git -C "$BARE" for-each-ref --format='%(objectname) %(refname)' | sort)
test "$BEFORE" = "$AFTER" || { echo "FAIL: refs монорепо изменились"; exit 1; }
echo "OK: monorepo untouched"
# та же сверка по durable-snapshot'у (переживает перезапуск сессии) + GPU Hub (R-3 = A):
check_bare_snapshot || { echo "FAIL: монорепо != BEFORE-snapshot (GO-14)"; exit 1; }
diff "$SNAP/animastor-gpu-hub.git.refs.txt" <(git -C "$GPUHUB" for-each-ref --format='%(objectname) %(refname)' | sort) \
  || { echo "FAIL: refs GPU Hub изменились"; exit 1; }
echo "OK: monorepo (GO-14) + GPU Hub == BEFORE-snapshot"
```

> **Почему три строки `reset` + `update-ref` + `reflog expire` (сверено с
> исходником `git-filter-repo` 2.47.0, `RepoFilter.sanity_check`):**
> sanity-check требует (а) рабочее дерево чистое, (б) для каждой `refs/heads/X`
> существовать `refs/remotes/origin/X` с тем же SHA, (в) ровно один remote
> `origin`, (г) 1 pack / 0 loose-объектов, **(д) не больше одной записи в reflog
> для HEAD и для каждой ветки**.
> `git reset --hard $SRC` выполняет (а) и двигает только `refs/heads`, но
> пишет **вторую** запись в `.git/logs/HEAD` и `.git/logs/refs/heads/$BRANCH`
> (первая — от `clone`) → **без `reflog expire` `filter-repo` прервётся именно
> на (д)**: `Aborting: expected at most one entry in the reflog … use --force`,
> а `--force` запрещён (проверено на эталонном репо: 2 entries → abort;
> после `git reflog expire --expire=now --all` → 0 entries → проходит).
> Вторая строка выравнивает remote-tracking ref (`update-ref` reflog не пишет),
> третья обнуляет reflog'и. **Альтернатива:** `git clone -c
> core.logAllRefUpdates=false …` — `.git/logs` не создаётся вовсе (тоже
> проверено), но постоянная правка config нового репо нежелательна.
> После успешного `filter-repo` remote `origin` удаляется сам (cleanup).
> Если sanity-check всё же откажет — **не использовать `--force`**: удалить
> клон, устранить причину, повторить с чистого `clone`.

#### 4.1.1 `animastor-backend` — шаг 1/7

> **СТАТУС (2026-10-04): ВЫПОЛНЕНО.** Блок исполнен дословно (включая все
> guard'ы и строгие контроли). Результат: `filter-repo` RC=0 → **1045 файлов /
> 1267 коммитов / leak 0 / fsck чисто / clean tree / корень `Recovery01` /
> `--follow` 5/5** → первый push **без `--force`** → hook → bare == GitHub ==
> **`f83f929c732d8fc490bd150e72294d6b3c6e2f92`**. Журнал —
> `repository-split-execution-pack.md` **§11**.

```sh
cd "$SPLIT"
test ! -e "$SPLIT/backend" || { echo "REFUSE: $SPLIT/backend существует — нужен свежий клон (повторный запуск в тот же каталог запрещён)"; exit 1; }
git clone --no-local --single-branch --branch "$BRANCH" "$BARE" backend
cd backend
git reset --hard "$SRC"
git update-ref "refs/remotes/origin/$BRANCH" "$SRC"
git reflog expire --expire=now --all   # ОБЯЗАТЕЛЬНО до filter-repo — см. §4.1.0 (I-1)
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
# НЕТ --path workflow.json (§8.1, 36-я запись): no-op + RETIRE/P4 — подтверждено проверкой whitelist

# backup/verification (строгие контроли — §4.1.0)
git fsck --no-progress || { echo "FAIL: fsck"; exit 1; }
test "$(git ls-files | wc -l)" -eq 1045 || { echo "FAIL: ожидалось 1045 файлов"; exit 1; }
echo "OK: 1045"
test -z "$(git ls-files | grep -E '^(ANDROID_WEB_PARITY\.md$|apk-build\.sh$|app-web-rebuild\.sh$|build-apk\.sh$|frontends/|gpu-hub-rebuild\.sh$|tools/|workflow\.json$|local\.properties$|package\.json$|packages/animastor-(worker|gpu-hub|web-))' || :)" || { echo "FAIL: чужие пути в backend-repo"; exit 1; }
echo "OK: no leak"
test -z "$(git status --porcelain)" || { echo "FAIL: рабочее дерево грязное"; exit 1; }
echo "OK: clean"
test "$(git log --reverse --format=%s | sed -n 1p)" = "Recovery01: June 9 working state + dedup" || { echo "FAIL: исторический корень не Recovery01"; exit 1; }
echo "OK: history root"
test "$(git rev-list --count HEAD)" -eq 1267 || { echo "FAIL: ожидалось 1267 коммитов (счёт по prefix'ам §4.1.1, execution-pack §3.1)"; exit 1; }
echo "OK: 1267 commits"
# history «нельзя потерять» (§8.6)
git log --follow --format='%h %ad %s' --date=short -- packages/animastor-contracts/src/job-protocol-v2.js | sed -n 1p
git log --follow --format='%h %ad %s' --date=short -- backend/ai/workflows | sed -n 1p
git log --follow --format='%h %ad %s' --date=short -- packages/animastor-installer/ai/install-manifests | sed -n 1p
git log --follow --format='%h %ad %s' --date=short -- scripts/check-artifacts.sh | sed -n 1p
git log --follow --format='%h %ad %s' --date=short -- docs/architecture/GPU_HUB_CONTRACT.md | sed -n 1p

# первый push (bare создаётся в P1 владельцем)
NEW=/home/animastor/repos/animastor-backend.git
test -d "$NEW" || git init --bare "$NEW"
test -z "$(git -C "$NEW" for-each-ref)" || { echo "FAIL: $NEW не пуст (I-17) — первый push требует пустого bare"; exit 1; }
git remote add origin "$NEW"
test "$(git remote get-url origin)" = "$NEW" || { echo "FAIL: origin = $(git remote get-url origin), ожидался $NEW — push НЕ в тот remote"; exit 1; }
git -C "$NEW" symbolic-ref HEAD "refs/heads/$NEWBRANCH"
git push -u origin "HEAD:refs/heads/$NEWBRANCH"
git ls-remote https://github.com/Animastor/animastor-backend.git "refs/heads/$NEWBRANCH"
# post-receive hook (P1) зеркалит в GitHub: git push --mirror github
```

Smoke checks — §8, `animastor-backend` (в т.ч. `cd backend && npm ci`, `npm run test:arch` → **979/2**, `npm test`, G1/G2, `bash ../scripts/syntax-smoke.sh`).

#### 4.1.2 `animastor-web` — шаг 2/7

> **СТАТУС (2026-10-04): ВЫПОЛНЕНО.** Блок исполнен дословно. `filter-repo` RC=0
> → **349 файлов / 275 коммитов / leak 0 / docs-subset CLEAN / fsck чисто /
> clean tree / tracked-set == whitelist / корень `docs: reorganize into topical
> structure…`** → первый push **без `--force`** → hook → bare == GitHub ==
> **`4c3ea0fb2a1adb552ba1c9acd98abc41befdab3b`**. Журнал —
> `repository-split-execution-pack.md` **§12**.

```sh
cd "$SPLIT"
test ! -e "$SPLIT/web" || { echo "REFUSE: $SPLIT/web существует — нужен свежий клон"; exit 1; }
git clone --no-local --single-branch --branch "$BRANCH" "$BARE" web
cd web
git reset --hard "$SRC"
git update-ref "refs/remotes/origin/$BRANCH" "$SRC"
git reflog expire --expire=now --all   # ОБЯЗАТЕЛЬНО до filter-repo — см. §4.1.0 (I-1)
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

# backup/verification (строгие контроли — §4.1.0; полные паттерны — execution-pack §3.3)
git fsck --no-progress || { echo "FAIL: fsck"; exit 1; }
test "$(git ls-files | wc -l)" -eq 349 || { echo "FAIL: ожидалось 349 файлов"; exit 1; }
echo "OK: 349"
test -z "$(git ls-files | grep -E '^(backend/|docker/|proxy/|scripts/|frontends/android/|gpu-hub-rebuild\.sh$|apk-build\.sh$|build-apk\.sh$|backend-rebuild\.sh$|front-backend-rebuild\.sh$|src-backup\.sh$|MiM\.vbook$|docker-compose\.yml$|\.dockerignore$|\.env\.example$|\.gitignore$|ARCHITECTURE\.md$|CONTRIBUTING\.md$|MEMORY\.md$|README\.md$|SECURITY\.md$|THIRD_PARTY_NOTICES\.md$|workflow\.json$|local\.properties$|package\.json$|packages/animastor-(ai-|assistant|auth|comfyui|contracts|editor|generation|gpu-hub|installer|orchestration|parser|player|url-safety|vbook|worker))' || :)" || { echo "FAIL: чужие пути в web-repo"; exit 1; }
echo "OK: no leak"
test -z "$(git ls-files | grep '^docs/' | grep -vE '^docs/(05-frontend/|08-mobile-web-migration/|09-desktop-migration/|architecture/(ANDROID_WEB_PARITY|web-[a-z0-9-]+)\.md$)' || :)" || { echo "FAIL: лишние файлы docs/ в web-repo"; exit 1; }
echo "OK: docs subset"
test "$(git rev-list --count HEAD)" -eq 275 || { echo "FAIL: ожидалось 275 коммитов (execution-pack §3.1)"; exit 1; }
echo "OK: 275 commits"
if test ! -e .gitignore; then echo "WARN: корневого .gitignore нет — создать (§5.2)"; fi

NEW=/home/animastor/repos/animastor-web.git
test -d "$NEW" || git init --bare "$NEW"
test -z "$(git -C "$NEW" for-each-ref)" || { echo "FAIL: $NEW не пуст (I-17) — первый push требует пустого bare"; exit 1; }
git remote add origin "$NEW"
test "$(git remote get-url origin)" = "$NEW" || { echo "FAIL: origin = $(git remote get-url origin), ожидался $NEW — push НЕ в тот remote"; exit 1; }
git -C "$NEW" symbolic-ref HEAD "refs/heads/$NEWBRANCH"
git push -u origin "HEAD:refs/heads/$NEWBRANCH"
git ls-remote https://github.com/Animastor/animastor-web.git "refs/heads/$NEWBRANCH"
```

Smoke checks — §8, `animastor-web` (`cd frontends/app && npm ci`, `npm run build:packages` → **13/13**, `npm test`, G1, `npm run typecheck`).

#### 4.1.3 `animastor-android` — шаг 3/7

> **СТАТУС (2026-10-04): ВЫПОЛНЕНО.** Блок исполнен дословно. `filter-repo`
> RC=0 → **217 файлов / 107 коммитов / leak 0 / fsck чисто / clean tree /
> tracked-set == whitelist / корень `Recovery01: June 9 working state + dedup`**
> → первый push **без `--force`** → hook → bare == GitHub ==
> **`efa4b2937bc1954900c0e5aa9501667f42d6a70d`**. Журнал —
> `repository-split-execution-pack.md` **§13**.

```sh
cd "$SPLIT"
test ! -e "$SPLIT/android" || { echo "REFUSE: $SPLIT/android существует — нужен свежий клон"; exit 1; }
git clone --no-local --single-branch --branch "$BRANCH" "$BARE" android
cd android
git reset --hard "$SRC"
git update-ref "refs/remotes/origin/$BRANCH" "$SRC"
git reflog expire --expire=now --all   # ОБЯЗАТЕЛЬНО до filter-repo — см. §4.1.0 (I-1)
git filter-repo \
  --path frontends/android \
  --path apk-build.sh \
  --path build-apk.sh \
  --path ANDROID_WEB_PARITY.md \
  --path LICENSE
# НЕТ --path local.properties (§8.3, 6-я запись): no-op + VPS-local/untracked

git fsck --no-progress || { echo "FAIL: fsck"; exit 1; }
test "$(git ls-files | wc -l)" -eq 217 || { echo "FAIL: ожидалось 217 файлов"; exit 1; }
echo "OK: 217"
test -z "$(git ls-files | grep -Ev '^(frontends/android/|apk-build\.sh$|build-apk\.sh$|ANDROID_WEB_PARITY\.md$|LICENSE$)' || :)" || { echo "FAIL: чужие пути в android-repo"; exit 1; }
echo "OK: no leak"
test "$(git rev-list --count HEAD)" -eq 107 || { echo "FAIL: ожидалось 107 коммитов (execution-pack §3.1)"; exit 1; }
echo "OK: 107 commits"
if test ! -e .gitignore; then echo "WARN: корневого .gitignore нет — создать (§5.3)"; fi

NEW=/home/animastor/repos/animastor-android.git
test -d "$NEW" || git init --bare "$NEW"
test -z "$(git -C "$NEW" for-each-ref)" || { echo "FAIL: $NEW не пуст (I-17) — первый push требует пустого bare"; exit 1; }
git remote add origin "$NEW"
test "$(git remote get-url origin)" = "$NEW" || { echo "FAIL: origin = $(git remote get-url origin), ожидался $NEW — push НЕ в тот remote"; exit 1; }
git -C "$NEW" symbolic-ref HEAD "refs/heads/$NEWBRANCH"
git push -u origin "HEAD:refs/heads/$NEWBRANCH"
git ls-remote https://github.com/Animastor/animastor-android.git "refs/heads/$NEWBRANCH"
```

Smoke checks — §8, `animastor-android`: npm **не выполняется** (0 package.json); при наличии JDK+SDK — `./gradlew --offline tasks` (опционально).

#### 4.1.4 `animastor-worker` — шаг 4/7

> **СТАТУС (2026-10-04): НЕ ВЫПОЛНЯЛОСЬ.** Bare `animastor-worker.git` = 0 refs /
> 0 objects, GitHub = 0 refs. Шаг выполняется отдельной авторизацией владельца.

```sh
cd "$SPLIT"
test ! -e "$SPLIT/worker" || { echo "REFUSE: $SPLIT/worker существует — нужен свежий клон"; exit 1; }
git clone --no-local --single-branch --branch "$BRANCH" "$BARE" worker
cd worker
git reset --hard "$SRC"
git update-ref "refs/remotes/origin/$BRANCH" "$SRC"
git reflog expire --expire=now --all   # ОБЯЗАТЕЛЬНО до filter-repo — см. §4.1.0 (I-1)
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

git fsck --no-progress || { echo "FAIL: fsck"; exit 1; }
test "$(git ls-files | wc -l)" -eq 58 || { echo "FAIL: ожидалось 58 файлов"; exit 1; }
echo "OK: 58"
test -z "$(git ls-files | grep -Ev '^(packages/animastor-worker/|docker/worker/|docs/architecture/(JOB_PROTOCOL_V2|PHASE_9|WORKER_PACKAGE_RELOCATION|EXPERIMENTAL_BETA_|LINUX_INSTALLER_RECONNAISSANCE)|LICENSE$)' || :)" || { echo "FAIL: чужие пути в worker-repo"; exit 1; }
echo "OK: no leak"
test "$(git rev-list --count HEAD)" -eq 24 || { echo "FAIL: ожидалось 24 коммита (execution-pack §3.1)"; exit 1; }
echo "OK: 24 commits"
if test ! -e .gitignore; then echo "WARN: корневого .gitignore нет — создать (§5.4)"; fi

NEW=/home/animastor/repos/animastor-worker.git
test -d "$NEW" || git init --bare "$NEW"
test -z "$(git -C "$NEW" for-each-ref)" || { echo "FAIL: $NEW не пуст (I-17) — первый push требует пустого bare"; exit 1; }
git remote add origin "$NEW"
test "$(git remote get-url origin)" = "$NEW" || { echo "FAIL: origin = $(git remote get-url origin), ожидался $NEW — push НЕ в тот remote"; exit 1; }
git -C "$NEW" symbolic-ref HEAD "refs/heads/$NEWBRANCH"
git push -u origin "HEAD:refs/heads/$NEWBRANCH"
git ls-remote https://github.com/Animastor/animastor-worker.git "refs/heads/$NEWBRANCH"
```

Smoke checks — §8, `animastor-worker` (`cd packages/animastor-worker && npm ci && npm test`,
`node tools/sync-protocol.cjs --check`); MOVE-тест `phase9d` требует адаптации — §7.4.

#### 4.1.5 `animastor-gpu-hub` — **⛔ REJECTED / NOT SELECTED при R-3 = A — НЕ ИСПОЛНЯТЬ**

> **ЭТОТ БЛОК НЕ ИСПОЛНЯЕТСЯ.** R-3 = **A (SELECTED)** —
> `repository-split-r3-decision.md`. Шаг 5 **исключён из очереди**
> (§FINAL SPLIT HANDOFF §4): `git filter-repo` для GPU Hub **не выполняется**,
> новый bare/репозиторий **не создаётся**, push/force-push/mirror в
> **существующий** `Animastor/animastor-gpu-hub` **запрещены бессрочно**.
> Ниже — только историческая запись отклонённого варианта B.
> Запуск этого блока = **критическое нарушение** (перезапись живого репо).

```sh
# ⛔ REFUSE — §4.1.5 REJECTED при R-3 = A. Существующий
# `Animastor/animastor-gpu-hub` (bare = GitHub = 7c7778c) не перезаписывается.
# Норматив: repository-split-r3-decision.md §1.1 / §3.1.
echo "REFUSE: §4.1.5 REJECTED (R-3 = A) — filter-repo gpu-hub НЕ ВЫПОЛНЯЕТСЯ" >&2
exit 1
# --- ниже только историческая запись варианта B; выполнение запрещено ---
cd "$SPLIT"
test ! -e "$SPLIT/gpu-hub" || { echo "REFUSE: $SPLIT/gpu-hub существует — нужен свежий клон"; exit 1; }
git clone --no-local --single-branch --branch "$BRANCH" "$BARE" gpu-hub
cd gpu-hub
git reset --hard "$SRC"
git update-ref "refs/remotes/origin/$BRANCH" "$SRC"
git reflog expire --expire=now --all   # ОБЯЗАТЕЛЬНО до filter-repo — см. §4.1.0 (I-1)
git filter-repo \
  --path packages/animastor-gpu-hub \
  --path scripts/check-artifacts.sh \
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
# НЕТ --path gpu-hub-rebuild.sh (§8.5, 3-я запись) при R-3=B — X-1, §7.1

git fsck --no-progress || { echo "FAIL: fsck"; exit 1; }
test "$(git ls-files | wc -l)" -eq 44 || { echo "FAIL: ожидалось 44 файла (§8.5 = 45, минус gpu-hub-rebuild.sh — X-1 при R-3=B)"; exit 1; }
echo "OK: 44"
test -z "$(git ls-files | grep -Ev '^(packages/animastor-gpu-hub/|scripts/check-artifacts\.sh$|docker/compose/overlay-gpu-hub-standalone\.yml$|docs/architecture/(GPU_HUB_CONTRACT|JOB_PROTOCOL_V2|PHASE_10[A-Z]?_)|LICENSE$)' || :)" || { echo "FAIL: чужие пути в gpu-hub-repo"; exit 1; }
echo "OK: no leak"
test "$(git rev-list --count HEAD)" -eq 37 || { echo "FAIL: ожидалось 37 коммитов (без gpu-hub-rebuild.sh; execution-pack §3.1)"; exit 1; }
echo "OK: 37 commits"
if test ! -e .gitignore; then echo "WARN: корневого .gitignore нет — создать (§5.5)"; fi
```

**Push/замена существующего `Animastor/animastor-gpu-hub` в этот лист НЕ входит**
(это force-push в действующий репозиторий `7c7778c`). Замена истории выполняется
только по процедуре **`repository-split-pre-split-fixes.md` §5 «Вариант B»**
(mirror-backup в `backups/animastor-gpu-hub-pre-split.git` → заморозка
`hooks/post-receive` → filter-repo по whitelist **§8.5 prep-plan** → `--force`-push
в bare → верификация §6/§7 readiness → возврат hook → mirror в GitHub) после
письменного подтверждения backup/freeze владельцем (п.10 №4). §8.5 prep-plan —
это только whitelist путей, а не сама процедура замены.

#### 4.1.6 Прочее

- **Backup/verification** — общий блок §4.1.0 (до и после каждого репо).
- **Первый push** — см. каждый блок: `git remote add origin <новый bare>` →
  `git -C "$NEW" symbolic-ref HEAD "refs/heads/$NEWBRANCH"` (**до** push, чтобы
  HEAD нового bare никогда не висел) → `git push -u origin
  HEAD:refs/heads/$NEWBRANCH` → `ls-remote` на GitHub.
- **Smoke checks** — §8; регенерация lock'ов — §6 (до тестов, после `filter-repo`).
- **Имя корневой ветки** (`$NEWBRANCH=main`) и **URL-префикс** GitHub-организации
  сверяются владельцем; если hook'и P1 требуют иного имени ветки — правится только
  `$NEWBRANCH`. Запись «`master`» в §FPSG.5 (Этап 1) — историческая; исполняемое
  имя берётся **только** из `$NEWBRANCH` (I-12).
- Если sanity-check `git-filter-repo` всё же откажется — **не использовать
  `--force`**; `rm -rf` клона и повторить с чистого `clone` (§4.1.0). Наиболее
  вероятная причина — пропущенный `git reflog expire` (I-1).
- **Per-repo спеки** (ожидаемый layout, package-идентичность, запрещённые пути,
  полные leak-паттерны, `git log --follow`, ожидаемое число коммитов) —
  `repository-split-execution-pack.md` §3.
- **Идемпотентность / безопасность / rollback / GO-чеклист** — там же §4, §5, §6.
  Запускать лист без пункта **G-E/G-F** (P1/P6) нельзя;
  **G-G (R-3) — READY: A = SELECTED**.

Запрещено: `--path-rename`, force-push, изменение monorepo hook'а, создание
репо GPU Hub, любые действия в существующем `animastor-gpu-hub`.

### 5. Extraction map

Все whitelist'ы — §8.1–8.5 prep-plan: **119** `--path` записей суммарно
(36+31+6+19+27); **исполняется 116** (−2 no-op: `workflow.json`, `local.properties`;
−1: `gpu-hub-rebuild.sh`), **при R-3 = A шаг 5 исключён → 90** (окончательно).
Layout сохраняется (нет `--path-rename`) → `backend/`, `frontends/`, `packages/`
остаются в корне нового репо.

**Состав каждого репо (одна строка):**

| Repo | Что входит | package.json | lock'и |
|---|---|---|---|
| `animastor-backend` | **backend + 15 backend-пакетов** (+ `docs/`, `docker/`, `proxy/`, `scripts/`, compose, root-доки) | 16 | **16** (4 → регенерация, §6) |
| `animastor-web` | **frontends/app + frontends/website + 13 web-пакетов** (+ `tools/*-tester`, 4 подмножества docs) | 14 | 14 (2 → регенерация) |
| `animastor-android` | **Android tree / build-ассеты** (`frontends/android`, `apk-build.sh`, `build-apk.sh`) — **без npm** | 0 | 0 |
| `animastor-worker` | **worker bundle + protocol/docs** (`packages/animastor-worker`, `docker/worker`, 16 protocol/audit-доков) | 3 | 3 (0 → регенерация) |
| `animastor-gpu-hub` | **REJECTED при R-3 = A — не исполняется** (`packages/animastor-gpu-hub`, standalone-overlay, 22 docs) | 1 | 1 (0 → регенерация) |

#### 5.1 `animastor-backend`

| Поле | Значение |
|---|---|
| source commit | `64127b9e…` |
| whitelist | §8.1 — **36 записей → исполняется 35** (без `--path workflow.json`): `backend`, 15 × `packages/animastor-{ai-agent,ai-analysis,ai-connector,assistant,auth,comfyui-workflow-connector,contracts,editor,generation,installer,orchestration,parser,player,url-safety,vbook-runtime}`, `docs`, `docker`, `proxy`, `scripts`, `docker-compose.yml`, `MiM.vbook`, `{backend,front-backend,src}-…rebuild.sh`, `README/ARCHITECTURE/MEMORY/CONTRIBUTING/SECURITY/THIRD_PARTY_NOTICES/LICENSE`, `.env.example`, `.dockerignore`, `.gitignore` |
| исчезают каталоги/пути | `frontends/**` (app, website, android), `tools/**`, `packages/animastor-worker`, `packages/animastor-gpu-hub`, `packages/animastor-web-*` (13), `gpu-hub-rebuild.sh`, `app-web-rebuild.sh`, `apk-build.sh`, `build-apk.sh`, `ANDROID_WEB_PARITY.md`, `workflow.json`, `local.properties` |
| package.json | **16**: `backend/` + 15 пакетов (gpu-hub/web/worker — нет) |
| root package.json **репо** | **отсутствует** (в whitelist нет корневого `package.json`) → корневой манифест = **`backend/package.json`** (`name: animastor-backend`, workspaces нет) |
| lockfiles → регенерация | **4 из 16** (в backend-repo **16** lock'ов на 16 манифестов, в т.ч. `packages/animastor-ai-analysis/package-lock.json` — добавлен `6798d786`, содержит **0** относ. записей): `packages/animastor-{comfyui-workflow-connector(4), generation(2), orchestration(108), vbook-runtime(1)}` — 115/117 относ. записей; `backend/package-lock.json` и остальные 11 локов — **0** относ. записей → не трогать |
| runtime npm deps (остаются) | внутренние: `@animastor/{ai-agent,ai-analysis,assistant,auth,contracts,editor,generation,installer,orchestration,parser,player,url-safety,vbook-runtime}` + `animastor-comfyui-workflow-connector`; внешние: `adm-zip`, `cors`, `express`, `express-rate-limit`, `helmet`, `iconv-lite`, `ioredis`, `multer`, `music-metadata`, `pg`, `prom-client`, `sharp`, `tinyld`, `ws` |
| devDependencies (остаются) | `@animastor/gpu-hub`, `chai`, `mocha`, `nyc`, `proxyquire` (все опубликованы/registry-доступны) |
| root layout (21) | `.dockerignore` `.env.example` `.gitignore` `ARCHITECTURE.md` `CONTRIBUTING.md` `LICENSE` `MEMORY.md` `MiM.vbook` `README.md` `SECURITY.md` `THIRD_PARTY_NOTICES.md` `backend/` `backend-rebuild.sh` `docker/` `docker-compose.yml` `docs/` `front-backend-rebuild.sh` `packages/` (15) `proxy/` `scripts/` `src-backup.sh` |
| сразу после extraction | `git fsck`; `git status` чист; `git ls-files \| grep -E '^(frontends\|tools)' ` пусто; `cd backend && npm ci`; `npm run test:arch` → **979/2** (IB-G15, T9); `npm test`; G1/G2; `bash ../scripts/syntax-smoke.sh` |

#### 5.2 `animastor-web`

| Поле | Значение |
|---|---|
| source commit | `64127b9e…` |
| whitelist | §8.2 — 31 `--path`: `frontends/app`, `frontends/website`, 13 × `packages/animastor-web-*`, `tools/desktop-web-tester`, `tools/mobile-web-tester`, `app-web-rebuild.sh`, `ANDROID_WEB_PARITY.md`, `docs/05-frontend`, `docs/08-mobile-web-migration`, `docs/09-desktop-migration`, 7 × `docs/architecture/web-*`, `LICENSE` |
| исчезают | `backend/`, `docker/`, `proxy/`, `scripts/`, `docs/` (кроме 4 подмножеств), все root-`*.md`, 15 backend-пакетов, `packages/animastor-{worker,gpu-hub}`, `apk/build-apk.sh`, `gpu-hub-rebuild.sh` |
| package.json | **14**: `frontends/app` + 13 web-пакетов (`frontends/website/package.json` отсутствует и в монорепо) |
| root package.json **репо** | **отсутствует** → корневой манифест = **`frontends/app/package.json`** (аффилированный `package.json` в корне не создаётся) |
| lockfiles → регенерация | **2 из 14**: `packages/animastor-web-generator-{sse(1), vbook(1)}` (оба → `../animastor-web-generator`); `frontends/app/package-lock.json` и остальные 11 — **0** относ. записей → не трогать |
| runtime npm deps | `@animastor/web-{ai-chat,book-session,editor,file,generator,generator-config,generator-sse,generator-vbook,local-ai,navigator,player,settings,workers}` (13), `@preact/signals`, `preact`, `preact-router` |
| devDependencies | `@preact/preset-vite`, `@preact/signals`, `@preact/signals-core`, `@testing-library/dom`, `@testing-library/preact`, `happy-dom`, `preact`, `tsup`, `typescript`, `vite`, `vitest` |
| root layout (7) | `ANDROID_WEB_PARITY.md` `LICENSE` `app-web-rebuild.sh` `docs/` `frontends/{app,website}` `packages/` (13) `tools/{desktop-web-tester,mobile-web-tester}` |
| ⚠ gap | **корневого `.gitignore` нет** (в whitelist только `--path LICENSE`); есть только `frontends/app/.gitignore` → `packages/animastor-web-*/node_modules` будут видны в `git status` → **создать корневой `.gitignore` сразу после extraction** |
| сразу после extraction | `git fsck`; `git status` чист; отсутствие `backend/`, `packages/animastor-{worker,gpu-hub}`; `cd frontends/app && npm ci`; `npm run build:packages` → **13/13**; `npm test`; G1; `npm run typecheck` |

#### 5.3 `animastor-android`

| Поле | Значение |
|---|---|
| source commit | `64127b9e…` |
| whitelist | §8.3 — **6 записей → исполняется 5** (без `--path local.properties`): `frontends/android`, `apk-build.sh`, `build-apk.sh`, `ANDROID_WEB_PARITY.md`, `LICENSE` |
| исчезают | вообще всё, кроме 5 позиций выше: `backend/`, `docs/`, `docker/`, `proxy/`, `scripts/`, `tools/`, **всё `packages/`** (backend/web/worker/hub), все npm-манифесты |
| package.json | **0** — npm-резолв не применяется; только Gradle (`junit:junit:4.13.2`) |
| root package.json **репо** | **отсутствует** (и не требуется); root-артефакты = Gradle/wrapper-файлы `frontends/android/` |
| lockfiles → регенерация | **0** — `package-lock.json` в whitelist отсутствует |
| runtime npm deps | **нет** |
| devDependencies | **нет** |
| root layout (5) | `ANDROID_WEB_PARITY.md` `LICENSE` `apk-build.sh` `build-apk.sh` `frontends/android/` (213) |
| ⚠ gap | **корневого `.gitignore` нет**, а монорепо-корень как раз игнорировал `local.properties`, `gradle-*/`, `*.apk`, `*.aab`, `.gradle/` → после split они станут untracked → **создать корневой `.gitignore` сразу после extraction** (это же закрывает §P4 stale-mount) |
| сразу после extraction | `git fsck`; `git status` чист; `git ls-files \| grep -E '^(packages\|backend\|frontends/(app\|website))'` пусто; npm-проверки **не выполняются**; при наличии JDK+SDK — `./gradlew --offline tasks` (опционально, не блокирует) |

#### 5.4 `animastor-worker`

| Поле | Значение |
|---|---|
| source commit | `64127b9e…` |
| whitelist | §8.4 — 19 `--path`: `packages/animastor-worker`, `docker/worker`, `docs/architecture/{JOB_PROTOCOL_V2, PHASE_9*, WORKER_PACKAGE_RELOCATION_*, EXPERIMENTAL_BETA_*, LINUX_INSTALLER_RECONNAISSANCE}.md`, `LICENSE` |
| исчезают | `backend/`, `frontends/`, `proxy/`, `scripts/`, `docs/` (кроме 16), `docker/` (кроме `docker/worker`), `docker-compose.yml`, все root-`*.md`, все пакеты кроме `animastor-worker`, `tools/` |
| package.json | **3**: `packages/animastor-worker/package.json` (`@animastor/worker-dev`), `packages/animastor-worker/worker/package.json` (canonical bundle version `2.1.1`), `packages/animastor-worker/image/worker/package.json` |
| root package.json **репо** | **отсутствует** → корневой манифест = **`packages/animastor-worker/package.json`** (2 вложенных lock'а — без относ. записей) |
| lockfiles → регенерация | **0 из 3** — ни один lock не содержит `../`-записей |
| runtime npm deps | **нет внешних** (zero-dep bundle; только node builtins) |
| devDependencies | `@animastor/contracts` (registry, 0.1.1) — нужен `sync:protocol`/паритет-гвардам |
| root layout (4) | `LICENSE` `docker/worker/` (3) `docs/architecture/` (16) `packages/animastor-worker/` (38) |
| сразу после extraction | `git fsck`; `git status` чист; отсутствие `backend/`, `frontends/`, `packages/animastor-{contracts,gpu-hub}`; `cd packages/animastor-worker && npm ci && npm test` → `node tests/run-all.cjs`; `node tools/sync-protocol.cjs --check`; **⚠ MOVE-тест `phase9d-worker-package` (§9 №34) требует адаптации — см. §7.4** |

#### 5.5 `animastor-gpu-hub` — **⛔ REJECTED / NOT SELECTED при R-3 = A — НЕ ИСПОЛНЯТЬ**

> Описание ниже — **только историческая запись** отклонённого варианта B.
> При R-3 = A: существующее репо `Animastor/animastor-gpu-hub` остаётся
> каноническим, `filter-repo` не выполняется, новых репо не создаётся.
> Норматив — `repository-split-r3-decision.md` §1.1.

| Поле | Значение |
|---|---|
| source commit | `64127b9e…` |
| whitelist | §8.5 — **27 записей → при R-3=B исполняется 26** (без `--path gpu-hub-rebuild.sh`): `packages/animastor-gpu-hub`, `scripts/check-artifacts.sh`, `docker/compose/overlay-gpu-hub-standalone.yml`, 22 × `docs/architecture/{GPU_HUB_CONTRACT, JOB_PROTOCOL_V2, PHASE_10*}`, `LICENSE` |
| исчезают | `backend/`, `frontends/`, `proxy/`, `scripts/` (кроме `scripts/check-artifacts.sh`), **`docker-compose.yml`**, `docker/compose/overlay-gpu-hub-local.yml`, `docker/e2e/`, все пакеты кроме `animastor-gpu-hub`, `tools/` |
| package.json | **1**: `packages/animastor-gpu-hub/package.json` (`@animastor/gpu-hub` 0.1.1, devDeps отсутствуют) |
| runtime npm deps | `@animastor/contracts`, `cors`, `express`, `ioredis` |
| devDependencies | **нет** (run-all — zero-dep) |
| root layout (5) | `LICENSE` `docker/compose/overlay-gpu-hub-standalone.yml` `docs/architecture/` (22) `packages/animastor-gpu-hub/` (19) `scripts/check-artifacts.sh` |
| ⚠ gap | корневого `.gitignore` и `README.md` нет → создать сразу; `packages/animastor-gpu-hub/.dockerignore` остаётся |
| сразу после extraction | `git fsck`; `git status` чист; отсутствие `docker-compose.yml`, `docker/compose/overlay-gpu-hub-local.yml`, `backend/`; `cd packages/animastor-gpu-hub && npm ci && npm test` → `node tests/run-all.cjs` (22); `node tools/update-artifacts-lock.cjs --check` (см. D6 ниже); Docker G4-сборка standalone-контекстом; **X-4-адаптация тестов — §7.4** |

**D6-ограничение:** `tools/update-artifacts-lock.cjs` резолвит
`REPO_ROOT = HUB_DIR/../../..` и ищет `REPO_ROOT/packages/animastor-{worker,installer,…}` —
в hub-repo их нет. `--check` валиден **только** пока writer смотрит на
монорепо-layout; после перепривязки на Release-zips (B5) — регенерация lock.

#### 5.6 Whitelist verification (§8 prep-plan vs `git ls-files`)

Сверка повторена на frozen source `64127b9e…` (**1635 tracked-файлов**,
рабочее дерево чистое; ранее — 1626 на `7df461fa`);
скрипт — покрытие «`--path` = файл сам или под каталогом», read-only.

| Проверка | Результат |
|---|---|
| tracked files (`git ls-files`) | **1635** |
| всего `--path` (§8.1–8.5) | **119** = 36 + 31 + 6 + 19 + 27 |
| **покрыто** | **1635 / 1635 = 100 %** |
| **непокрытые** | **0** |
| per-repo (с учётом дублей) | backend **1045**, web **349**, android **217**, worker **58**, gpu-hub **45** → сумма **1714** |
| **намеренные дубли** | **79 вхождений** сверх 1635 → это **75 уникальных файлов**, попавших в >1 репо |
| — backend+web | **31** (общие `LICENSE`, `ANDROID_WEB_PARITY.md`, `docs/architecture/…`, `packages/animastor-editor` т.п.) |
| — backend+gpu-hub | **23** (общие `docs/architecture/PHASE_10*`, `JOB_PROTOCOL_V2.md`, `LICENSE`, …) |
| — backend+worker | **18** (общие `docs/architecture/…`, `docker/worker`, `LICENSE`, …) |
| — web+android | **1** (`ANDROID_WEB_PARITY.md`) |
| — все 5 (backend+web+android+worker+gpu-hub) | **1** (`LICENSE`) |
| — backend+worker+gpu-hub | **1** (`docs/architecture/JOB_PROTOCOL_V2.md`) |
| **no-op `--path`** | **2**: `workflow.json` (§8.1), `local.properties` (§8.3) — в дереве **нет** ни одного tracked-файла под этими путями → исключение из whitelist **не меняет извлечение** |
| исключение при R-3=B | `gpu-hub-rebuild.sh` (§8.5) — файл **трекается**, поэтому исключение **реально** уменьшает hub-repo на 1 файл (X-1, §7.1) |

**Если сверка покажет расхождение — только задокументировать его здесь,
код и whitelist'ы в prep-plan не править.** На текущий момент расхождений: **0**.

### 6. Post-split lockfile procedure

Порядок фиксируется жёстко; **каждый репо обрабатывается независимо**:

1. **`git filter-repo`** (очередь §4, whitelist §8 + override'ы).
2. **Новый repo root** — подтвердить `git status` чист и root- layout из п.5.
3. **`npm ci` / `npm install` там, где применимо** — строго в таком порядке:
   1. `cd backend && npm ci` (**первым** — 12 записей в 2 локах линкуют
      `../../backend/node_modules/*`);
   2. затем `cd packages/<pkg> && npm ci` для `animastor-comfyui-workflow-connector`
      и `animastor-orchestration` (те, кому нужен п.1);
   3. остальные пакетные локи — без порядка;
   4. web: `cd frontends/app && npm ci`;
   5. worker: `cd packages/animastor-worker && npm ci`;
   6. ~~hub~~ — **не выполняется при R-3 = A** (пакет остаётся в замороженном
      монорепо; сам hub живёт в существующем standalone-репо).
   Android — **не применяется**.
4. **Regeneration package-lock** — ровно **6 локов** (те, что содержат
   monorepo-relative `../`-записи; **117** записей суммарно). Остальные
   **28** локов (в т.ч. `backend/package-lock.json` и
   `frontends/app/package-lock.json` — **0** относ. записей) **не трогать**:
   регенерация была бы чистой косметикой.

   | lock | относ. записей | цель ссылок | комментарий |
   |---|---|---|---|
   | `packages/animastor-orchestration/package-lock.json` | 108 | 8 → `../../backend/node_modules/*`, 100 → `../animastor-*` | **обязательно** (и для порядка п.3.1, и для `"../../backend/node_modules"` = 0 в п.5) |
   | `packages/animastor-comfyui-workflow-connector/package-lock.json` | 4 | 4 → `../../backend/node_modules/*` | **обязательно** |
   | `packages/animastor-generation/package-lock.json` | 2 | 2 → `../animastor-{comfyui-workflow-connector,contracts}` (`"link": true`) | **обязательно** (иначе `"link": true` ≠ 0 в п.5) |
   | `packages/animastor-vbook-runtime/package-lock.json` | 1 | 1 → `../animastor-parser` (`"link": true`) | **обязательно** |
   | `packages/animastor-web-generator-sse/package-lock.json` | 1 | 1 → `file:../animastor-web-generator` | **обязательно** (иначе `"file:"` ≠ 0 в п.5) |
   | `packages/animastor-web-generator-vbook/package-lock.json` | 1 | 1 → `file:../animastor-web-generator` | **обязательно** |

   Регенерация: `rm package-lock.json && npm install --package-lock-only`
   **после** появления `backend/node_modules` (п.3.1) — иначе 12 записей
   `../../backend/node_modules` перезапишутся тем же относительным путём.
5. **Проверка отсутствия** в tracked-манифестах/локах нового репо:
   - `"file:"` → **0**
   - `'"link": true'` → **0**
   - `"../packages"` → **0**
   - `"../../packages"` → **0**
   - `"../../backend/node_modules"` → **0**
   (G1/G2/G3 зелёные + целевой grep по `package*.json`)
6. **Затем тесты** (п.8).

**Не регенерировать текущие monorepo lock-файлы ради косметики** — они валидны
на frozen source (проверено `npm ci --dry-run` exit 0).

### 7. X-1 / X-2 / X-3 / X-4 disposition

#### 7.1 X-1 — `gpu-hub-rebuild.sh`

**Утверждение документации (проверено однозначно):** после split скрипт **не
может** зависеть от backend-only compose-файлов.

- Факт: `-f docker-compose.yml` + `-f docker/compose/overlay-gpu-hub-local.yml`
  (оба → **только backend-repo**), сам скрипт → **только gpu-hub-repo** (§8.5).
  Вне `docs/` ссылок на него **0** (все 27 вхождений — `docs/architecture/*.md`).
- **R-3 = A**: §8.5 не исполняется → скрипт остаётся только в frozen-монорепо
  и продолжает работать как раньше. Действий **0**.
- **R-3 = B (REJECTED, не применяется)**: ~~исключить `--path gpu-hub-rebuild.sh`~~ из §8.5 (это второй
  override, наравне с `workflow.json`/`local.properties`) → в hub-repo скрипт
  не попадает вовсе. **Не** переносить в hub `docker-compose.yml` (тащит
  backend/nginx-сервисы и mounts, которых там нет).
- Рабочий путь run/build в обоих вариантах: **`GPU_HUB_IMAGE=<digest>` +
  `docker/compose/overlay-gpu-hub-standalone.yml`** (пример пина —
  `.env.example:53`), source-level rebuild — только в frozen-монорепо либо в
  hub-repo после B5 re-point (G4).

#### 7.2 X-2 — backend `docker-compose.yml` и `packages/animastor-gpu-hub/Dockerfile`

**Утверждение документации (проверено однозначно):** backend `docker-compose.yml`
после split **не должен** пытаться build `packages/animastor-gpu-hub/Dockerfile`.

- Единственная production-строка: `docker-compose.yml:112-114`
  (`context: .` + `dockerfile: packages/animastor-gpu-hub/Dockerfile`).
  Остальные 15 вхождений `packages/animastor-gpu-hub` — комментарии, 8
  backend-тестов (гарды), self-COPY в Dockerfile, метаданные.
- **R-3 = A** и **R-3 = B** для backend-repo одинаковы: после split
  `docker compose build gpu-hub` **падает** → единственный санкционированный
  путь — **`GPU_HUB_IMAGE=<digest>` + `overlay-gpu-hub-standalone.yml`**
  (`build: !reset null`, файл присутствует в обоих репо через §8.1 `--path docker`
  и §8.5). **`docker-compose.yml` до split не изменяется** (иначе ломается
  текущий монорепо) — корректировка входит в **B11 cutover**.
- **A**: source-level rebuild возможен только в frozen-монорепо
  (`overlay-gpu-hub-local.yml`). **B**: ещё и в hub-repo после B5 re-point (G4).

#### 7.3 X-3 — npm metadata (29 пакетов + 1 вложенный манифест)

| Поле | Факт | Post-split действие |
|---|---|---|
| `repository.url` | **29** `packages/*/package.json` = **15** backend-домена (`ai-agent, ai-analysis, ai-connector, assistant, auth, comfyui-workflow-connector, contracts, editor, generation, installer, orchestration, parser, player, url-safety, vbook-runtime`) + **13** web + **1** gpu-hub; плюс **1 вложенный** `packages/animastor-worker/worker/package.json` (`animastor-worker`) = **30** строк. Без `repository` целиком: `backend/package.json`, `frontends/app/package.json`, `packages/animastor-worker/package.json` (`@animastor/worker-dev`), `packages/animastor-worker/image/worker/package.json` | URL → домен нового репо: **15 шт.** → `git+https://github.com/Animastor/animastor-backend.git`; **13 шт.** → `git+https://github.com/Animastor/animastor-web.git`; **1 шт.** (gpu-hub) → `…/animastor-gpu-hub.git` **только при R-3=B — REJECTED, не применяется**; при **R-3 = A — без изменений** (`git+https://github.com/Animastor/animastor.git`, npm publish не выполняется — P3/E401); вложенный worker-манифест → `…/animastor-worker.git` |
| `repository.directory` | присутствует у тех же **30** (`packages/<dir>`); у 4 манифестов без `repository` поля нет | **исчезает** для всех: в новом репо пакет **не** лежит в `packages/` верхнего уровня монорепо → поле удаляется целиком (не заменяется) |
| **Когда именно** | — | **Строго после filter-repo и строго ПЕРЕД первым `npm publish`** (рядом с P3). До split **не менять**: в монорепо текущие значения верны. Дополнительно — `README.md:95` и `packages/animastor-comfyui-workflow-connector/README.md:288` содержат `git clone https://github.com/Animastor/animastor.git` → обновить в том же патче (не является publish-блокером) |
| Publish-граница | 29/30 опубликованы; `@animastor/worker-dev` — не публикуется | registry read OK, publish закрыт (P3/E401) |

#### 7.4 X-4 — `phase10t-1-artifact-bakein.test.js` (disposition **MOVE**, §9 №28)

| Поле | План |
|---|---|
| source location | `backend/tests/architecture/phase10t-1-artifact-bakein.test.js` (196 строк) |
| target repo | **`animastor-gpu-hub`** — **REJECTED при R-3 = A: не создаётся и не переизвлекается** |
| target path | **`tests/architecture/phase10t-1-artifact-bakein.test.js`** (корень hub-repo) — тогда существующий `REPO_ROOT = resolve(__dirname,'..','..','..')` остаётся верным. В `packages/animastor-gpu-hub/tests/…` он даст `<root>/packages` и сломается |
| guard после переезда | `HUB_CHECKOUT_PRESENT` (`existsSync(packages/animastor-gpu-hub/Dockerfile)`) становится no-op = `true` |
| **перестают существовать** | `docker-compose.yml` (AB2), `packages/animastor-installer/**` (AB4, AB5), `docker/compose/overlay-gpu-hub-local.yml` (AB8) |
| **остаются валидными** | `packages/animastor-gpu-hub/{Dockerfile,gpu-hub.js}` (AB1, AB3, AB6), `scripts/check-artifacts.sh` (AB7 — есть в §8.5) |
| **какие проверки должны остаться** | **AB1** (Dockerfile: stager, 4 группы, build-time verify, нет `COPY . .`), **AB3** (порядок `resolveArtifactDir`: config → baked-in → mount), **AB6** (нет `/worker-source`), **AB7** (script exists + executable + 4 группы + `baseline_sha256`/`min_version`) — **плюс новая AB8′** на `overlay-gpu-hub-standalone.yml`: `build: !reset null`, `image: ${GPU_HUB_IMAGE:?…}`, «no bind mounts / baked at /app/artifacts/» |
| **какие проверки уходят из hub** | **AB2** (сборка из корня compose) — backend-специфика, остаётся в backend-repo (skip-гардом); **AB4/AB5** (installer `MANIFEST_ROOT`, `getWorkerBundleVersion`) — installer живёт в backend-repo, **остаются там и продолжают выполняться** (гарда у них нет); **AB8** (local-dev overlay + монорепо-mount'ы `./packages/animastor-{worker,installer}`, `./backend/ai/workflows`) — **выбрасывается**: standalone-overlay монтирования не имеет вовсе («No bind mounts needed») |
| fixtures/artifacts | **не требуются** — все assert'ы читают исходный текст; ни один zips/artifacts на этапе теста не открывается |
| что остаётся в backend-repo | тот же файл, в котором AB1/AB2/AB3/AB6/AB7/AB8 skip-ятся гардом, а **AB4/AB5 гоняются** и остаются зелёными (installer в backend-repo) |
| ⚠ поправка к §FINAL PRE-SPLIT TECHNICAL CLOSURE | там было сказано «гард сделает suite пустым в backend-repo» — **неточно**: без гардAB4/AB5. Верно: 6 из 8 блоков skip, 2 продолжают работать |
| **изменять сейчас** | **НЕТ** (запрет на правку B7). Фиксируется только план |

**Второй MOVE (§9 №34) — `phase9d-worker-package.test.js` → `animastor-worker`:** у
него та же проблема и она **хуже заявленного в комментарии** («travels
unchanged»): `CONTRACTS_IMPL_PATH = PKG_SRC('animastor-contracts', …)` резолвит
через `<REPO_ROOT>/backend` (в worker-repo нет ни `backend/`, ни
`<root>/node_modules`) → `null`; `MANIFEST_ROOT = <root>/packages/animastor-installer/ai/install-manifests`
и `docker/compose/overlay-gpu-hub-local.yml` (D6, D7) в worker-repo отсутствуют →
`ENOENT`. **Post-split действие:** при переезде D4 перевести на
`node_modules/@animastor/contracts` (pkg ships `src/`, версия 0.1.1 совпадает),
D6/D7 оставить в backend-repo, в worker-repo оставить D1/D2/D3/D5/D8.

#### 7.5 Final grep audit (read-only; исходный прогон — HEAD `7df461fa`, пере-сверено на frozen source `64127b9e…`)

> **`7df461fa` — исторический HEAD исходного прогона; это НЕ frozen source и НЕ
> текущий tip ветки.** Единственный source для `git filter-repo` — **`64127b9e…`**
> (§1; правило source). Текущее состояние документации — документационные
> коммиты после source (см. §0 final-gate).
>
> **Пере-сверка read-only на `64127b9e…` (та же матрица паттернов, tracked
> файлы):** non-doc выборка **+6 / −0** — добавились
> `scripts/split-guards/{g1-registry-only,g3-protocol-parity,run-all}.sh` и
> `packages/animastor-gpu-hub/tools/{g4-standalone-build,g5-artifact-integrity,standalone-fixture}.*`
> (guard/инструментальная обвязка split: комментарии и негативные проверки вида
> «нет `packages/animastor-worker`» — не production-обращения); doc выборка
> **+1 / −0** — `repository-split-final-gate.md` (DOC). Новых классов и
> новых blocker'ов нет: **0 technical blockers** сохраняется.

Шаблоны: `file:` · `"link": true` · `../packages/` · `../../packages/` ·
`../../backend/node_modules` · `packages/*/src` · hardcoded monorepo-paths ·
`repository.url` · `repository.directory` · `packages/animastor-gpu-hub` ·
`packages/animastor-worker` · `packages/animastor-contracts/src` ·
`../../../backend/src`. Выборки — **без учёта самого этого файла** (он матчит
часть паттернов своим текстом); `skip` = бинарные расширения. Числа в таблице
ниже — факт исходного прогона на `7df461fa`; расхождения с `64127b9e…` — только
+6 non-doc guard/инструментов и +1 doc (см. пере-сверку выше).

| Паттерн | Найдено (files / lines, excl. self) | Классификация |
|---|---|---|
| `"file:"` в tracked `package*.json` | `package.json` — **0**; `package-lock.json` — **2** (`web-generator-sse`, `web-generator-vbook`, оба `file:../animastor-web-generator`) | **PRE-SPLIT** (валидно, `npm ci --dry-run` = 0) → **POST-SPLIT ACTION** (регенерация, §6 п.4) |
| `"file:"` вне npm | **15** файлов / 19 lines = 2 лока выше + Kotlin-тест `BetaSettingsHelpersTest.kt:38` (`file:///etc/passwd`) + **12 docs** | **TEST / DOC / false positive** |
| `"link": true` | **6** локов / **14** записей (+1 doc-файл, 15 lines всего) | **PRE-SPLIT** → **POST-SPLIT ACTION** (регенерация ровно этих 6, §6 п.4) |
| `"../packages/"` | **31** файл / 60 lines: **17** non-doc (`backend/src/runtime/job-schema.js`, 13 backend-tests, `frontends/app/scripts/build-packages.cjs`, `frontends/app/src/architecture/*.guard.test.ts`, `packages/animastor-editor/test/*`, `scripts/generate-parser-golden-fixtures.js`) + 14 docs | **PRE-SPLIT** (layout сохраняется → `<repo>/packages/...` резолвится и после split) · **TEST** · **DOC** |
| `"../../packages/"` | **22** файла / 39 lines (подмножество предыдущего) | **PRE-SPLIT** / **TEST** / **DOC** — то же |
| `"../../backend/node_modules"` | **2** файла / 17 lines — `packages/animastor-comfyui-workflow-connector/package-lock.json` (**4** записи) и `packages/animastor-orchestration/package-lock.json` (**8** записей); `package.json` — **0** | **PRE-SPLIT** (12 записей; путь **сохраняется** после split, т.к. layout не переименовывается) → **POST-SPLIT ACTION**: жёсткий порядок `cd backend && npm ci` **первым** (§6 п.3.1) + регенерация обоих локов (§6 п.4) |
| `../../../backend/src` | **5** файлов / 15 lines — только `packages/animastor-editor/test/*.js` | **PRE-SPLIT** (`animastor-editor` → backend-repo; от `<repo>/packages/animastor-editor/test` вверх 3 = корень репо → `backend/src/…` существует) |
| `packages/*/src` | **81** файл / 302 lines: 4 в `backend/src` (комментарии), ~50 `backend/tests/**` (гарды), `overlay-gpu-hub-local.yml:25`, 6 installer/worker/hub-исходников, 30+ docs | **DOC** (комментарии) · **TEST** (B7-гарды) · **PRE-SPLIT** (`overlay…local`, `installer/setup-contract.js:70`, `gpu-hub/Dockerfile` self-COPY, `sync-protocol.cjs` header) |
| hardcoded monorepo paths (`/home/animastor/animastor`) | **8** файлов / 14 lines: **2** non-doc — `scripts/animastor-runtime-audit.sh:415,540,543,544`, `docker/e2e/dispatch-task.cjs:11` — + 6 docs | **PRE-SPLIT** (VPS/e2e-утилиты в backend-repo, работают пока жив freeze-чекаут) → **POST-SPLIT ACTION** (кандидат: сделать путь переменным). Смежное (не monorepo): `docker/e2e/install-driver.cjs:16` = `/home/animastor/data`, `/home/sureg/…` — pre-existing |
| `repository.url` = monorepo | **39** файлов / 42 lines: **30** npm-манифестов (29 + worker-вложенный) + `README.md` + 5 package-README + `scripts/setup-contract.js` (non-doc, 33) + 6 docs | **POST-SPLIT ACTION** (§7.3, до publish) · **DOC** |
| `"directory": "packages/…"` | ровно **30** файлов / 30 lines = те же 30 npm-манифестов (в `ai/install-manifests/*.json` **нет** этого паттерна — там поле манифеста `directory` иной формы) | **POST-SPLIT ACTION** (§7.3) |
| `packages/animastor-gpu-hub` | **25** файлов / 59 lines: **16** non-doc (**1 production** — `docker-compose.yml:114`, 8 backend-тестов, `gpu-hub-rebuild.sh:2`, Dockerfile self-COPY ×5, 3 hub-исходника (комментарии), `installer/worker-bundle-source.js:18`, `syntax-smoke.sh:57,102`) + 9 docs | **POST-SPLIT ACTION** = **X-2** (compose, §7.2) и **X-1** (rebuild, §7.1) · **TEST** · **DOC** |
| `packages/animastor-worker` | **50** файлов / 168 lines: **35** non-doc — `.env.example:74` (коммент.), `docker-compose.yml:107` (коммент.), `overlay-…local:20,21` (mount), installer-манифесты/исходники (`worker-bundle-source.js`, `setup-contract.js`, `engine/worker.js`, install-manifests `source.path`), `gpu-hub.js` (комментарии + tar-entry `animastor-installer/packages/animastor-worker/worker/*`), 12 backend-тестов, `runtime-audit.sh`, `syntax-smoke.sh` + 15 docs | **POST-SPLIT ACTION** = **B11** (compose/overlay mounts — backend-only) · **PRE-SPLIT** (installer/hub-артефактные пути = контракт tar-entry, не FS-путь) · **TEST** · **DOC** |
| `packages/animastor-contracts/src` | **8** файлов / 11 lines: **5** non-doc (`backend/src/contracts/runtime-result.js:5`, `backend/src/runtime/job-schema.js:5` — коммент., `phase9c-contracts.test.js:177`, `sync-protocol.cjs:12,37,86`, `job-protocol-v2.cjs:6` — generated-header) + 3 docs | **DOC** · **TEST** · **PRE-SPLIT** (generated-заголовок содержит provenance-путь — намеренно) |
| **BLOCKER** | — | **не найдено ни одного** |

**0 technical blockers.** Все 14 классов отнесены к `PRE-SPLIT` / `TEST` /
`DOC` / `POST-SPLIT ACTION`; ни один не требует правки кода **до** split.

### 8. Immediate post-split smoke checks

Выполняются **сразу** после `filter-repo` каждого репо (§6 prep-plan + §FPSG.6):

| Repo | Проверки сразу |
|---|---|
| все | `git fsck` · `git status` чист · `git log --oneline \| wc -l` ≠ 0 · `git log --follow` по §8.6 (6 путей «нельзя потерять») · отсутствие чужих доменов: `git ls-files \| grep -E '^(frontends\|backend\|packages/animastor-(web\|worker\|gpu-hub))'` — пусто вне целевых · `git rev-parse HEAD` == push-нутому, hook в stderr = «Mirroring to GitHub» |
| **backend** | `cd backend && npm ci` · `npm run test:arch` → **979/2** (IB-G15, T9 — pre-existing) · `npm test` · `npm run test:connector-core` · G1/G2/G3 · `node ../scripts/syntax-smoke.sh` |
| **web** | `cd frontends/app && npm ci` · `npm run build:packages` → **13/13** · `npm test` · typecheck · G1/G2 |
| **android** | `git status` чист после создания корневого `.gitignore` · отсутствие `packages/` и `backend/` · (опц.) `./gradlew --offline tasks` — npm не применяется |
| **worker** | `cd packages/animastor-worker && npm ci` · `npm test` (`node tests/run-all.cjs`) · `node tools/sync-protocol.cjs --check` · zero-dep: `node worker.cjs` стартует без install |
| **gpu-hub** (R-3=B) | `cd packages/animastor-gpu-hub && npm ci` · `npm test` (`node tests/run-all.cjs`, 22) · `node tools/update-artifacts-lock.cjs --check` (D6 caveat) · G4: `docker build` standalone-контекстом · post-build `scripts/check-artifacts.sh` → «ALL CHECKS PASSED 6/6» · **X-4-адаптация** §7.4 |

### 9. PHYSICAL SPLIT: NOT EXECUTED

**PHYSICAL SPLIT: NOT EXECUTED.** В ходе подготовки этого handoff не выполнено
и не изменено:

- `git filter-repo` (и любая перепись истории) · физическое разделение ·
  `--path-rename` · **force-push**;
- создание GitHub-репозиториев / bare-репозиториев **этим handoff'ом** —
  **2026-10-04: владельцем созданы 4 пустых GitHub-репо** (200 / `size=0` / 0 refs,
  `default_branch=main`), **bare по-прежнему отсутствуют**; GPU Hub не создаётся;
- удаление, замена или модификация **существующего** GPU Hub repo
  (`Animastor/animastor-gpu-hub`, `7c7778c`) — **§8.5 не применяется (R-3 = A)**;
- изменение **каких-либо** hook'ов (монорепо-`post-receive` и будущих split-хуков);
- `npm publish` / обновление npm-токена (P3 остаётся внешним блокером);
- изменения production-кода, Dockerfile, compose, `artifacts.lock.json`;
- изменения **B7-тестов** (`backend/tests/**`);
- регенерация текущих monorepo lock-файлов (без крайней необходимости);
- удаление `tmp/parser-audit-backup` · удаление/очистка `workflow.json` ·
  автоматическая очистка диска (`pip cache purge` — только по распоряжению
  владельца);
- возврат `file:`/symlink-зависимостей · удаление файлов «для чистоты».

Изменены **только** `docs/architecture/*.md` — этот handoff,
`repository-split-final-gate.md`, `repository-split-execution-pack.md`,
**одним** docs-only commit'ом.

### 10. Что владелец обязан подтвердить перед запуском

Чек-лист, **все пункты — до первого `git filter-repo`** (порядок соответствует §4):

1. **Source SHA** — зафиксирован и подтверждается владельцем:
   **`64127b9e1dea2ac528a572b51b90a542b70c5ebb`** (§1). Альтернатива
   «tip ветки» **отклонена как правило** (SHA должен быть неизменным между
   итерациями документации); все doc-коммиты после `64127b9e…` меняют только
   `docs/architecture/*.md` и на извлечение путей §8 не влияют.
2. **P2 — ВЫПОЛНЕН**: `master` = `origin/master` = frozen source `64127b9e…`
   (перепроверка: `git rev-parse master`). NO-GO №1 снят; без повторной
   проверки перед запуском — не продолжать.
3. **P1 — ЗАКРЫТ (2026-10-04)**: GitHub-репозитории `animastor-backend`,
   `animastor-web`, `animastor-android`, `animastor-worker` **созданы владельцем**
   (4 × HTTP **200**, `size=0`, **0 refs**, `default_branch=main`, 2026-10-03);
   **4 пустых bare, `post-receive`-hook'и (0755/91 байт byte-identical) и remote
   `github` созданы 2026-10-04** → **I-16 закрыт, GO-02/GO-03 = CLOSED,
   GO-04 = READY**; **push не выполнялся** (bare и GitHub пусты) → перед первым
   push повторить I-17-проверку пустоты.
   **GPU Hub отдельно не создавать и не заменять.**
4. **R-3 — ВЫПОЛНЕНО: A = SELECTED, B = REJECTED**
   (`repository-split-r3-decision.md`). Существующий `animastor-gpu-hub`
   (bare + GitHub, `7c7778c`) **сохраняется без изменений**: его standalone
   history канонична, `filter-repo` для GPU Hub не выполняется, новый
   репозиторий не создаётся, force-push/overwrite/delete запрещены.
   backup/freeze GPU Hub **не нужны** (ничего не пишется).
   **hub-CI авторится в существующем репо; §8.5 / §4.1.5 / §5.5 — REJECTED
   и не запускаются никогда** (без нового письменного решения).
5. **P6 — ЗАКРЫТ (PASS)**: свободно **≥5G** — `df -B1 /` = **`6 839 934 976 B`
   (≈6.4 GiB)** на 2026-10-04; **очистка не выполнялась и не требуется**;
   перед запуском — контрольная команда `df -B1 /` (значение колеблется).
6. **P3 — НЕ ВЫПОЛНЕНО**: `npm whoami` → **E401** (перепроверено 2026-10-04) —
   нужен новый грант **до первого publish** (filter-repo не блокируется).
7. **P4 — НЕ ВЫПОЛНЕНО (перепроверено 2026-10-04)**: каталог
   `workflow.json` **существует**, строка `frontends/android/docker-compose.yml:41`
   **не удалена** (stale android-compose-mount остался) — гигиена, не блокирует
   `filter-repo`; выполнить до шага 1 (§FPSG.8 п.5).
8. **P5 — фактически подтверждено, письменно НЕТ**: `.github/` отсутствует в
   дереве `$SRC` (0 файлов) и на GitHub (`Animastor/animastor/contents/.github/workflows`
   → 404), workflows существующего GPU Hub лежат **в его собственном репо** —
   подтвердить интерпретацию владельцу (§FPSG.8 п.6).
9. **`tmp/parser-audit-backup` — НЕ УДАЛЕНА (перепроверено 2026-10-04)**:
   `refs/heads/tmp/parser-audit-backup` = `db5ff61f` существует **локально и в
   bare** (а также `refs/remotes/github/tmp/parser-audit-backup`); удаление —
   решение владельца, **до него ветку НЕ удалять** (§FPSG.8 п.7).
10. **Post-split адаптации приняты** — §7.4 (X-4 `phase10t-1` → hub-repo;
    MOVE `phase9d` → worker-repo), корневые `.gitignore` для **web / android /
    worker / gpu-hub** (§5.2, §5.3, §5.5), §6-порядок регенерации локов.
11. **X-1 / X-2 / X-3 disposition приняты** — §7.1, §7.2, §7.3
    (в т.ч. ~~исключение `--path gpu-hub-rebuild.sh`~~ — §8.5 не применяется,
    R-3 = A, и обновление
    `repository.url`/`directory` перед publish).
12. **`NEWBRANCH = main` — ПОДТВЕРЖДЁН владельцем (GO-05 = CLOSED, 2026-10-04)**:
    письменное owner-confirmation зафиксировано в
    `repository-split-pre-split-go-blockers.md` §6/§7.1; сверено read-only:
    GitHub API `default_branch = main` ×4, `git -C <new> symbolic-ref HEAD` =
    `refs/heads/main` ×4, переменная `NEWBRANCH` объявлена **только** в §4.1.0
    (I-12). **Имя ветки правится только там** — любое иное значение требует
    нового письменного подтверждения владельца.
13. **Стадия B ВЫПОЛНЕНА (2026-10-04) — GO-08 + GO-14**: durable backup
    `$BK = backups/animastor-pre-split-64127b9e.git` (22 431 724 B, содержит
    `$SRC`, restore-дрилл пройден) и BEFORE-snapshot
    `backups/before-split-64127b9e-refs/` (`animastor.git` — 6 refs,
    `animastor-gpu-hub.git` — 2 refs, `master = 7c7778c6…`). **Повторно не
    создавать и не перезаписывать** — §4.1.0 только проверяет их.
