# Repository Split — Next Blockers (после `834987a7`)

Продолжение цепочки: `repository-split-pre-split-fixes.md` (`bd66bae6`, верификация
№2 — `834987a7`) → этот документ. Физический split **не выполнялся** (ограничения
соблюдены: без filter-repo, force-push, новых GitHub-репо, npm publish, изменений
существующих GPU Hub-репозиториев).

Статусы: **DONE** — закрыто в этом коммите · **READY** — код/план готовы, исполнение
по триггеру · **POST-SPLIT** — возможно только после физического разделения ·
**BLOCKED** — ждёт внешнего действия · **OWNER DECISION** — требуется решение
владельца.

## 0. Сводная таблица

| Blocker | Status | Что осталось | Как закрывается |
|---|---|---|---|
| B1 backend deps/mounts | **DONE** (`bd66bae6`) | — | — |
| B2 backend lock npm | **DONE** (`834987a7`) | — | — |
| B3 web lock npm | **DONE** (`834987a7`) | — | — |
| B4 exports | **DONE** (инвариант, G2) | — | — |
| B5 artifact scheme | **READY (механика DONE здесь)** | Release-assets (4 zip), SHA256(asset) в lock, stager fetch из Releases | POST-SPLIT: после создания hub/worker/backend репо — Release-публикация; §B5 ниже |
| B6 sync-protocol npm | **DONE** (`bd66bae6`) | — | — |
| B7 tests disposition | **DONE** (здесь) | — | standalone-safety применена ко всем 46 architecture + 9 integration; монорепо 979/2, постсплит-симуляция 923/24/2 (только pre-existing); карта и проверки — §B7 |
| B8 web canonical build | **DONE** (здесь) | — | `frontends/app/scripts/build-packages.cjs` работает в обоих мирах; §B8 |
| B9 CI | **READY (чек-лист DONE здесь)** | создание workflows в новых репо | POST-SPLIT по чек-листу §B9; в монорепо не создаётся (P5) |
| B10 hook монорепо | N/A | — | — |
| B11 deploy cutover | POST-SPLIT | — | после filter-repo |
| B12 root package.json | **DONE** (`bd66bae6`) | — | — |
| P1 4 GitHub-репо | **BLOCKED (OWNER)** | создание backend/web/android/worker на GitHub | руками владельца |
| P2 FF master | **BLOCKED (OWNER)** | 141+ коммит отставание | `git checkout master && git merge --ff-only c21.4-…` владельцем |
| P3 npm token | **BLOCKED (OWNER)** | E401; publish недоступен | новый грант; нужен для B5-Release/NPM publish (post-split) |
| P4 workflow.json | **READY** (каталог пуст, не в git) | удалить пустой каталог | команда в §P4; НЕ выполнялась (по ограничению) |
| P5 CI-инфраструктура | POST-SPLIT | — | репо должны существовать |
| P6 диск | **ADEQUATE** (3.1G; нужно <2G) | headroom под filter-repo | освободители в §P6 (предложено, не выполнялись) |
| R-3 GPU Hub | **OWNER DECISION** (верификация обновлена) | выбор A (адаптация) / B (замена историей) | сравнение и список переноса — §R-3 |
| R-5 parity | DONE (правило зафиксировано) | — | — |

---

## B5 — Release artifacts (аудит + механика)

### Что проверено (факт на `834987a7`)

1. **Состав групп соответствует §2.2 prep plan**: 4 группы, publisher'ы — worker (1)
   и backend (3). Stager копирует ровно их (`packages/animastor-gpu-hub/Dockerfile`),
   полная docker-сборка зелёная (stager + runtime + bake-in verification).
2. **Дрейф факта против плана** (зафиксирован, план не переписывался):
   - plan §2.2: «workflows — 8 файлов» → фактически **9** (`backend/ai/workflows/`):
     7 активных + `old_img-qwen-image.json`, `old_video-ltx.json` (legacy);
     базлайны манифестов (`baseline_sha256`) покрывают 7 активных — `old_*` в
     контракте не участвуют, но попадают в bake и в digest группы;
   - plan §2.2: «worker-bundle — 6 файлов» → в дереве 6 файлов из `files` манифеста
     **+ `package.json`** (версионный якорь, читается hub'ом) = 7 в staging-дереве.
3. **`scripts/check-artifacts.sh`** (root, 5162 байта): [3/6] version-compat
   (`worker_bundle.min_version`) и [4/6] per-workflow SHA256 по базлайнам — существуют
   и покрывают контентный уровень; post-build проверка.
4. **Разрыв, который закрывал B5** (подтверждён final-readiness): SHA256-проверка
   staging-дерева **до `COPY --from=stager` отсутствовала** — сборка могла бы
   «незаметно» забake'ить изменённое содержимое.

### Что реализовано (этот коммит)

| Файл | Роль |
|---|---|
| `packages/animastor-gpu-hub/artifacts.lock.json` | pin-файл §2.5: name → `source_repository`, `release_tag`, `asset_filename`, `version`, `files`, `sha256_tree` |
| `packages/animastor-gpu-hub/tools/update-artifacts-lock.cjs` | writer/verifier лока (`--check`); дайджест = sha256 по сортированным `<sha256(file)>  <relpath>\n` (path-sort, C-locale); installer-src считается в **staged-плоской** раскладке (src/installer/* + package.json) |
| `packages/animastor-gpu-hub/scripts/verify-staged-artifacts.sh` | POSIX-sh (busybox, без node/jq) gate: пересчитывает те же дайджесты по staging-дереву и сверяет с локом |
| `packages/animastor-gpu-hub/Dockerfile` | stager: COPY лока+gate → `RUN sh verify-staged-artifacts.sh …` **до** runtime-стадии и её `COPY --from=stager` |
| `backend/tests/architecture/b5-artifact-contract.test.js` | 7 гвардов: состав лока, поля §2.1, **независимый пересчёт** дайджестов (double-entry, не через writer), pin версии 2.1.1 ↔ worker manifest, gate POSIX, gate в stager до COPY, **казнящий** tamper-тест (чистое дерево проходит, подмена байта валит gate) |

**Инвариант «незаметно другой артефакт невозможен»**: любое изменение байта в
любой из 4 групп меняет `sha256_tree` → gate в stager валит сборку до
`COPY --from=stager`; дрейф источников против закоммиченного лока ловит
`--check` + double-entry тест (обновление лока = осознанный коммит, §2.5).
Честная граница: pre-split лок генерируется из тех же деревьев, которые
проверяет — он фиксирует контрактом текущее состояние и делает дрейф
**обнаружимым**, а не невозможным; криптографический якорь против подмены
появится с SHA256 Release-asset'ов (POST-SPLIT, после P3).

**Единый формат**: все 4 группы описаны одной формулой (§2.1) и одним
механизмом (лок + staging-gate + bake-in RUN + check-artifacts.sh).
`artifacts.lock.json` предусмотрен архитектурным планом (§2.5) — создан.

**Осталось (POST-SPLIT)**: упаковка 4 asset-zip, публикация Release
(`worker-bundle-v2.1.1` в worker-репо; `hub-artifacts-v1` в backend-репо),
добавление `sha256` (asset-архива) в lock, перевод stager с монорепо-COPY на
fetch pinned assets (механизм контрактом не фиксирован — §2.0), digest-pin
базовых образов, G4/G5 в CI.

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
13/13 built; симуляция post-split (временное удаление `packages/`) — 13/13 через
npm-копии; полная цепочка `npm ci` → `build:packages` → `typecheck` → `vitest
201/201` → `vite build` — зелёная. Registry-based `npm ci` не сломан
(`.npmrc` legacy-peer-deps из `834987a7` сохранён).

---

## B7 — architecture/integration tests: ЗАКРЫТО (standalone-safety без физического split)

**Статус**: DONE этим коммитом. Все 46 architecture-файлов и 9 интеграционных
standalone-безопасны: в backend-репо без монорепо-соседей — ни одного
загрузочного краша и ни одного нового падения. Физический перенос файлов по
репозиториям (MOVE/SPLIT/RETIRE) происходит при filter-repo (§9 prep plan);
механика безопасности уже применена.

**Уточнение метода** (важно для последующих блоков): первая эмпирическая проба
временно убирала ВЕСЬ `packages/` — это завысило объём до «61 падающего».
Backend-репо после split СОХРАНЯЕТ свои 15 пакетов (prep plan §11), поэтому
корректная симуляция filter-repo backend — спрятать только `animastor-worker`,
`animastor-gpu-hub` и 13× `animastor-web-*`. Фактический объём B7:

| Метрика | Значение |
|---|---|
| Файлов, читающих `packages/**` (тесты + фикстуры) | 65 |
| Реальных постсплит-падений (корректная симуляция, до B7) | **13 файлов**: `b5-artifact-contract`, `dependency-guardrails`, `installer-package-boundary`, `phase10a`, `phase10d`, `phase10j`, `phase10t-1`, `phase2-job-protocol-v2`, `phase9c`, `phase9d`, `gpu-hub-artifacts`, `gpu-hub-bootstrap`, `worker-setup-api` |
| Монорепо-базлайн | 979 passing / 2 pre-existing failing (IB-G15, T9) |
| Постсплит-симуляция (после B7) | **923 passing / 24 pending / 2 failing** — падают только pre-existing IB-G15/T9; `Exception during run` = 0 |

Pre-existing (в объём B7 не входят, при обеих симуляциях идентичны):
`ai-shared-inference` (изоляционный дефект, в полном прогоне зелёный),
`phase5-runtime-result` (T9, ENOENT `src/runtime/index.js`), IB-G15
(installer `private:true`).

**Что сделано (по dispositions §9 prep plan, 21 файл изменён)**:

| Disposition | Файлы | Действие |
|---|---|---|
| KEEP (retarget, ~45) | большинство §9-KEEP | `helpers.js`: `WORKER_PKG_DIR/BUNDLE_DIR/TESTS_DIR/SYNC_TOOL_PATH` — nullable (legacy `worker/` fallback удалён, §9 #15); добавлены `npmPkgDir()` (resolve entry → walk-up до package.json по имени) и `PKG_SRC()` (монорепо-checkout → npm-копия; unscoped-исключения `ai-connector`, `comfyui-workflow-connector`); читалки переведены, worker/hub-половины — под skip-гардами |
| MOVE (2) | `phase9d`→worker, `phase10t-1`→hub | до переноса — гард на отсутствие чекаута (`describeWorker`, `HUB_CHECKOUT_PRESENT`); после переноса гарды становятся no-op |
| RETIRE (1) | `phase10j` (§9 #27) | гарды на fixture/TF-ассерты; transitional-содержимое больше не требует монорепо |
| SPLIT (4) | `lac-legacy-path-guard`, `phase2-job-protocol-v2`, `phase7`, `phase9c` | hub-половины npm-resolved, worker-половины под гардами; `lac-legacy-path-guard` оказался уже standalone-safe (existsSync-фильтр корней) — без правок |
| R-2 integration (9) | `gpu-hub-artifacts`, `gpu-hub-bootstrap`, `worker-setup-api`, `worker-share-grants`, `private-worker-phase2`, `private-worker-visibility`, `worker-share-policy`, `orchestration-stabilization`, `fail-closed-worker-auth` | worker-зависимые части — skip при отсутствии бандла; hub/contracts-половины ассертятся всегда; post-split → CI hub/worker (G5/G6) |
| Hazard fix | `ai-functional-decomposition-c18` | describe-body чтение файла → describe-гард + it-скпы: без монорепо больше НЕ абортит весь прогон |

**Урок для переносов тестов в worker/web/hub-репо**: Mocha
`describe.skip(name, fn)` ВСЁ РАВНО исполняет `fn` при сборке сюиты —
top-level `require()`/`path.join()` внутри describe-колбэка даёт краш загрузки
(`Exception during run`), а не скип. Гард — до первого обращения (тернарник на
nullable-путь) либо `if (!PRESENT) return;` первой строкой describe-колбэка;
`this.skip()` валиден только внутри `it()`/`before()`.

**Механические проверки** (этот коммит):

- Монорепо: `npm run test:arch` = `npm test` = **979 passing / 2 failing**
  (IB-G15, T9 — pre-existing), pending = 0 (гарды — no-op в монорепо),
  `Exception during run` = 0.
- Постсплит-симуляция (спрятаны worker+gpu-hub+13 web-*, в `packages/` = 15):
  `test:arch` и `npm test` = **923 passing / 24 pending / 2 failing** — падают
  только pre-existing IB-G15/T9; загрузочных крашей нет; 24 pending — ожидаемые
  skip-гарды. Директории восстановлены (`packages/` = 30).
- 9 R-2 интеграционных по отдельности (монорепо): 29+9+40+27+41+23+45+11+18 =
  **243 passing, 0 failing**.
- Мусорных файлов нет (`__guard_negative_control__.cjs` нигде не остался).

**Примечания**:

- npm-тарбол `@animastor/gpu-hub@0.1.1` НЕ содержит `artifacts.lock.json` и
  `scripts/verify-staged-artifacts.sh` (новое в B5, ещё не опубликовано):
  `b5-artifact-contract` гардируется на lock + worker-чекат → post-split это
  hub-CI тест (§8.5). Остальные hub-ассерты (pack surface, Dockerfile,
  version-pin) валидны на npm-копии и работают без гарда.
- GPU Hub (без изменений, только фиксация требования): монорепо
  `packages/animastor-gpu-hub` остаётся каноническим исходником до R-3/B5-end;
  `phase10t-1` + B5 Dockerfile/gate-ассерты переезжают в hub-репо; hub получает
  собственный standalone overlay (уже есть в bare-репо, §R-3).

---

## B9 — CI preparation (G1–G7 → чек-лист post-split)

Не создаётся в монорепо (P5: `.github/` отсутствует — некуда класть).
Готовая матрица для копирования в каждое репо при создании:

| Репо | Workflows (jobs) | Проверяет npm-install (не file:) | Проверяет artifacts SHA256 | Секреты |
|---|---|---|---|---|
| animastor-backend | G1 (`grep '"file:' → 0`), G2 (exports-скан), G6 (arch+unit suite), docker build (context ./backend), npm publish — после P3 | `npm ci && npm test` (lock registry-only) | — (consumer, не publisher) | `NPM_TOKEN` |
| animastor-web | G1, G2 (13 пакетов), G6 (ci → build:packages → typecheck → vitest → vite build), npm publish 13 пакетов — после P3 | `npm ci` registry-only | — | `NPM_TOKEN` |
| animastor-worker | G3 (`sync-protocol.cjs --check`), bundle tests (`tests/run-all.cjs`), Release job: zip `animastor-worker-bundle-<ver>.zip` + sha256 в body Release, G7-parity snapshot (commit+sha256 из web) | `npm ci` dev-harness (contracts из npm) | sha256 своего asset | `GITHUB_TOKEN` (Release) |
| animastor-gpu-hub | G4 (standalone docker build без монорепо-контекста), G5 (`check-artifacts.sh` в собранном образе + staging-gate), `update-artifacts-lock.cjs --check`, GHCR publish digest-pin, G7-parity snapshot | `npm ci` (contracts из npm) | staging-gate до `COPY --from=stager` + G5 post-build + сверка sha256 Release-asset | `GHCR_TOKEN` (packages:write) |
| animastor-android | G7-parity snapshot (по R-5: из VPS bare web), APK build (gradle) | — | — | — |

Дополнения к §10 плана: (1) staging-gate B5 — новый G5-компонент build-time;
(2) `--check` artifacts.lock в CI hub; (3) G7 у worker/hub/android — job'ы
снапшотов, источник — репозиторий-владелец (web/backend), GitHub — зеркало.

---

## P4 — остаточный `workflow.json`

Факт: `/home/animastor/animastor/workflow.json` — **пустой каталог** (не файл),
`root:root drwxr-xr-x`, создан 2026-08-24; в git **не отслеживается**
(`git ls-files` = 0); compose-mount `./workflow.json:/workflow.json:ro` удалён
в `bd66bae6` (C7-гвард запрещает возврат). Runtime-файл отсутствует — удалять
сейчас нечего и незачто.

Безопасная команда (выполняется владельцем при желании; `rmdir` отказывается
удалять непустой каталог — риск нулевой, sudo нужен из-за root-владения):

```bash
sudo rmdir /home/animastor/animastor/workflow.json
```

## P6 — диск перед filter-repo

Факт: `/` = 99G, занято 91G (**3.1G свободно**, 97%). Потребность
последовательного filter-repo 5 репозиториев: mirror-клон монорепо ~73M (.git) +
рабочая копия переписи ~2× пик истории → **< 2G суммарно с запасом**; 3.1G
достаточно для последовательного исполнения. Для комфортного headroom
(рекомендуется до ~6G) — безопасные освободители (НЕ выполнялись):

```bash
npm cache clean --force        # ~792M (~/.npm)
docker image prune -f          # только dangling; 6 активных образов staging НЕ трогать
```

`docker system df`: Images 13GB (6 active — ручное решение владельца по
устаревшим), Build Cache 0B, Volumes reclaimable ~235M (не трогать — данные).

---

## R-3 — GPU Hub (verification only; репозитории не тронуты)

Сравнение VPS bare `/home/animastor/repos/animastor-gpu-hub.git` (43 коммита,
root-layout, свой post-receive mirror, GitHub `Animastor/animastor-gpu-hub`
HEAD `7c7778c`) ↔ монорепо `packages/animastor-gpu-hub`:

| Файл | Bare | Монорепо | Различие |
|---|---|---|---|
| `gpu-hub.js` | есть deprecated `GET /worker-source`; каталоги артефактов напрямую `/app/*` | `/worker-source` удалён; `resolveArtifactDir` (baked-in → mount fallback, 10T.1) | ~45 строк только в bare, ~40 только в монорепо |
| `package.json` | 0.1.0 | 0.1.1 (опубликован в npm) | version + repository.url |
| `Dockerfile` | свой (standalone) | multi-stage stager с монорепо-COPY + **новый B5 gate** | разные стратегии доставки артефактов |
| `server.js`, `tarball.js`, `bootstrap.js`, `.dockerignore` | — | — | **байт-идентичны** |
| есть только в bare | `.github/workflows/{ci,ghcr-release}.yml`, `tests/run-all.cjs`, `DEPLOYMENT.md`, `EXTRACTION.md`, `package-lock.json`, `.gitignore` | — | bare уже имеет CI — плюс для варианта A |
| есть только в монорепо | — | `artifacts.lock.json`, `scripts/verify-staged-artifacts.sh`, `tools/update-artifacts-lock.cjs` (B5, этот коммит) | подлежат переносу при выборе A |

**Если выбираем A (сохранение существующего repo + адаптация), список переноса**:
(1) блок `resolveArtifactDir` из монорепо `gpu-hub.js`; (2) решение по
deprecated `/worker-source` (в монорепо удалён); (3) version 0.1.0 → 0.1.1
(+ npm publish после P3, т.к. 0.1.1 уже занят в registry); (4) B5-тройка
(лок, gate, writer) + ассерты `phase10t-1`/B5-теста; (5) merge Dockerfile:
standalone-контекст + stager по Release-assets (B5 end-state); (6) sync
`tests/run-all.cjs` с монорепо-версией (22 теста); (7) сверка
`.github/workflows` с матрицей B9. **Если B** — backup + freeze hook +
filter-repo экспорт истории (NO-GO до решения; force-push исключён).

Решение не принято — обе опции документированы, ничего не перезаписано.

---

## Механические проверки (выполнены в этом коммите)

| Проверка | Результат |
|---|---|
| backend lock: `"link": true` / `"file:` / `resolved: ../packages` | **0 / 0 / 0** |
| web lock: `"link": true` / `"file:` / `resolved: ../packages` | **0 / 0 / 0** |
| `artifacts.lock.json --check` | in sync |
| Docker build hub (полный, с gate) | ✓ 4/4 integrity + bake-in verified |
| Tamper-тест gate | ✓ exit 1 при подмене байта |
| backend `test:arch` / `npm test` (монорепо) | **979 passing / 2 failing** (обе — pre-existing IB-G15, T9; pending = 0) |
| backend B7 постсплит-симуляция (спрятаны worker+gpu-hub+13 web-*; `packages/` = 15) | `test:arch` = `npm test` = **923 passing / 24 pending / 2 failing** (только pre-existing IB-G15/T9; `Exception during run` = 0); директории восстановлены (`packages/` = 30) |
| 9 R-2 интеграционных по отдельности (монорепо) | **243 passing, 0 failing** |
| web: `npm ci` → `build:packages` → `typecheck` → `test` → `build` | ✓ / 13 pkgs / ✓ / **201/201** / ✓ |
| worker `sync-protocol.cjs --check` | exit 0 |
| Мусорные артефакты тестов | нет (`__guard_negative_control__.cjs` не остался) |

## Самопроверка документа

- B5-инвариант сформулирован честно (pre-split: обнаружение дрейфа, а не
  криптографическая защита) — §B5.
- Уточнение к §9 («KEEP-тесты падают post-split из-за прямых чтений
  `packages/*/src`») закрыто исполнением B7: retarget/skip-гарды применены
  (§B7); сам §9 не переписывался.
- Первая эмпирическая оценка B7 («61 падающий» из пробы с полным снятием
  `packages/`) исправлена корректной симуляцией (только worker+gpu-hub+web-*):
  фактический объём — 13 файлов; исправление задокументировано в §B7.
- GPU Hub: `packages/animastor-gpu-hub` изменён только в объёме B5 (лок, gate,
  Dockerfile-строки) — R-3-связанные изменения (история bare/GitHub, версия,
  роуты) не вносились; пункт 6 ограничений соблюдён в этой трактовке.
