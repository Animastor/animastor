# Repository Split — Next Blockers (после `35ba2b82`)

Продолжение цепочки: `repository-split-pre-split-fixes.md` (`bd66bae6`, верификация
№2 — `834987a7`) → `B7 closed` (`4d53be37`, `35ba2b82`) → этот документ.
Физический split **не выполнялся** (ограничения соблюдены: без filter-repo,
force-push, новых GitHub-репо, npm publish, изменений существующих GPU
Hub-репозиториев). B7 считается **ЗАКРЫТЫМ**. Все проверки ниже выполнены на
`35ba2b82` — mechanical-чеклист в §Mechanical.

Статусы: **DONE** — закрыто · **READY** — код/план готовы, исполнение по
триггеру · **POST-SPLIT** — возможно только после физического разделения ·
**BLOCKED** — ждёт внешнего действия · **OWNER DECISION** — требуется решение
владельца.

## 0. Сводная таблица

| Blocker | Status | Что осталось | Как закрывается |
|---|---|---|---|
| B1 backend deps/mounts | **DONE** (`bd66bae6`) | — | — |
| B2 backend lock npm | **DONE** (`834987a7`, re-verified `35ba2b82`) | — | — |
| B3 web lock npm | **DONE** (`834987a7`, re-verified `35ba2b82`) | — | — |
| B4 exports | **DONE** (инвариант, G2) | — | — |
| B5 artifact scheme | **READY (механика DONE, re-verified здесь)** | POST-SPLIT: Release-assets (4 zip), sha256(asset) в lock, stager fetch, digest-pin базовых образов | §B5; mechanical: lock `--check` in sync, Docker build + gate + check-artifacts 6/6 green |
| B6 sync-protocol npm | **DONE** (`bd66bae6`, re-verified `35ba2b82`) | — | — |
| B7 tests disposition | **DONE** (`35ba2b82`) | — | standalone-safety применена; монорепо 979/2, постсплит-симуляция 923/24/2 (только pre-existing) |
| B8 web canonical build | **DONE** (`cced5dd3`, re-verified здесь) | — | `build:packages` 13/13 в обоих мирах |
| B9 CI | **READY (matrix finalize DONE здесь)** | создание workflows в новых репо; R-3-решение для hub CI | POST-SPLIT по финализированной матрице §B9; в монорепо не создаётся (P5) |
| B10 hook монорепо | N/A | — | — |
| B11 deploy cutover | POST-SPLIT | — | после filter-repo |
| B12 root package.json | **DONE** (`bd66bae6`) | — | — |
| P1 4 GitHub-репо | **BLOCKED (OWNER)** | создание backend/web/android/worker на GitHub | руками владельца |
| P2 FF master | **BLOCKED (OWNER)** | 141+ коммит отставание | `git checkout master && git merge --ff-only c21.4-…` владельцем |
| P3 npm token | **BLOCKED (OWNER)** | E401; publish недоступен | новый грант; нужен для B5-Release/NPM publish (post-split) |
| P4 workflow.json | **READY** (пустой каталог, не в git; re-verified) | удалить пустой каталог; android-compose-mount stale | команда в §P4; НЕ выполнялась |
| P5 CI-инфраструктура | POST-SPLIT | — | репо должны существовать |
| P6 диск | **ACTION REQUIRED (2.9G; нужно ≥5G)** | minimal cleanup перед filter-repo | §P6; pip cache purge ≈4.4G достаточно; команды предложены, не выполнялись |
| R-3 GPU Hub | **OWNER DECISION** (verification обновлена) | выбор A (адаптация) / B (замена историей) | сравнение и список переноса — §R-3; gate для hub CI matrix |
| R-5 parity | DONE (правило зафиксировано) | — | — |

---

## B5 — Release artifacts (consistency re-verification)

### Что проверено (факт на `35ba2b82`)

1. **4 группы, exact values** — `artifacts.lock.json` сверен с деревьями
   (double-entry независимый пересчёт в b5-тесте + `--check`):

   | Group | source_repository | release_tag | asset_filename | version | files | sha256_tree |
   |---|---|---|---|---|---|---|
   | `worker-bundle` | animastor-worker | `worker-bundle-v2.1.1` | `animastor-worker-bundle-2.1.1.zip` | 2.1.1 | 7 | `713ac011…03d44` |
   | `hub-workflows` | animastor-backend | `hub-artifacts-v1` | `hub-workflows-v1.zip` | v1 | 9 | `0d51107d…eca738` |
   | `installer-src` | animastor-backend | `hub-artifacts-v1` | `installer-src-v1.zip` | 0.1.0 | 32 | `6230aba4…c83ac` |
   | `install-manifests` | animastor-backend | `hub-artifacts-v1` | `install-manifests-v1.zip` | v1 | 3 | `46f3c26a…f3e3` |

2. **Dockerfile gate ordering**: `RUN sh verify-staged-artifacts.sh` — строка 30
   (stager stage); `COPY --from=stager` — строка 44 (runtime stage). Gate на 14
   строк / полную stage-границу **раньше** bake-in. Invariant: любое изменение
   байта в любой из 4 групп меняет `sha256_tree` → gate валит сборку до COPY.
3. **Digest formula** (shared, три реализации идентичны): `sha256` over sorted
   `"<sha256(file)>  <relpath>\n"` — C-locale path-sort, LF; writer
   (`tools/update-artifacts-lock.cjs`), gate (`scripts/verify-staged-artifacts.sh`,
   POSIX sh, busybox, без node/jq), b5-тест (independent double-entry).
4. **Verification order** (полная цепочка): `update-artifacts-lock.cjs --check`
   (lock freshness) → staging gate в docker build (stager, pre-COPY) → bake-in
   RUN (4 dirs + worker package.json) → `check-artifacts.sh` post-build
   (6/6: dirs, version, min_version compat, per-workflow SHA256, no monorepo
   leaks, installer entry points). Mechanical: все 4 ступени зелёные.
5. **Legacy `old_*.json`** (`old_img-qwen-image.json`, `old_video-ltx.json`):
   входят в digest группы (`files: 9`), **НЕ** входят в manifest baselines
   (`baseline_sha256` покрывает только 7 активных), исключены workflow
   loader'ом (manifest notes: image/qwen-image.json:21, video/ltx-2.3.json:29).
   **Не считать активными artifact workflows; не удалять** — drift detection
   по группе остаётся активным.

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
фиксирует контрактом текущее состояние и делает дрейф **обнаружимым**;
криптографический якорь против подмены появится с SHA256 Release-asset'ов
(POST-SPLIT, после P3).

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

## B9 — CI preparation (G1–G7 → финализированная post-split matrix)

**Не создаётся в монорепо** (P5: `.github/` отсутствует — re-verified:
`find … -type d -name .github` = empty). Матрица ниже — готовая к копированию
в каждое репо при создании. Исправления относительно предыдущей ревизии
B9 зафиксированы в §B9-corrections.

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

### Post-split CI matrix

| Репо | Workflows (jobs) | npm registry-only deps | Токены | Checks ДО release | SHA256 verification | Impossible pre-split |
|---|---|---|---|---|---|---|
| **animastor-backend** | G1: `grep -rn '"file:' backend/package.json frontends/app/package.json` → empty. G2: exports/deep-subpath scan (src ⊆ exports, 15 pkgs). G6: `cd backend && npm ci && npm test` (= mocha tests/**, pretest syntax-smoke) + `npm run test:arch`. Docker build (context `./backend`). **Release job**: zip 3× hub-artifacts assets + sha256 → tag `hub-artifacts-v1` (**B9-correction D3: добавлено**). npm publish 15 pkgs — после P3. | 14× `@animastor/*` (ai-agent, ai-analysis, assistant, auth, contracts, editor, generation, installer, orchestration, parser, player, url-safety, vbook-runtime, comfyui-workflow-connector) + adm-zip/cors/express/express-rate-limit/helmet/ioredis/multer/music-metadata/pg/prom-client/sharp/ws; devDeps: gpu-hub, chai/mocha/nyc/proxyquire. Zero file:, zero link: (verified). | `NPM_TOKEN` (publish, POST-SPLIT P3); **`GITHUB_TOKEN` (Release job — B9-correction D3)** | G1, G2, G6 (979/2 baseline — 2 = pre-existing IB-G15/T9), docker build, syntax smoke | Consumer hub SHA256s (не publisher собственных); 3 Release assets несут sha256(asset) | workflow files (P1), Release publish (P1), npm publish (P3) |
| **animastor-web** | G1: `"file:"` grep on `frontends/app/package.json`. G2: exports scan 13× `@animastor/web-*`. G6: `npm ci` → `build:packages` → `typecheck` → `test` (vitest) → `build` (vite). npm publish 13 pkgs — после P3. `.npmrc` (`legacy-peer-deps=true`) обязателен. | 13× `@animastor/web-*` + preact/@preact/signals/preact-router; devDeps: vite, vitest, typescript, @preact/preset-vite, @testing-library/*. Zero file:, zero link:. | `NPM_TOKEN` (publish, POST-SPLIT P3) | G1, G2, G6 (13 pkgs / 201 vitest / vite build) | — (parity — web output, verified by consumers) | workflow files (P1), npm publish (P3) |
| **animastor-worker** | G3: `node tools/sync-protocol.cjs --check` (npm `check:protocol`). Bundle tests: `node tests/run-all.cjs` (6 suites: env, cleanup, cleanup-journal, job-protocol, package, standalone). Release job: zip `animastor-worker-bundle-2.1.1.zip` + sha256 в body Release, tag `worker-bundle-v2.1.1`. G7-parity snapshot: `JOB_PROTOCOL_V2.md` **из backend** (**B9-correction D4: не из web**). | Dev-harness: `@animastor/contracts ^0.1.1` only (`@animastor/worker-dev@2.1.1`, private). Bundle `animastor-worker@2.1.1`: zero-runtime-dep, files = 6 (worker.cjs, worker-env.cjs, worker-cleanup.cjs, worker-cleanup-journal.cjs, job-protocol-v2.cjs, .env.example). | `GITHUB_TOKEN` (Release zip + sha256). NPM_TOKEN не нужен (bundle не npm-published). | G3 exit 0, G6 run-all (mechanical: 45/0), G7 snapshot | **Own asset**: sha256(zip) в Release body; позже пинится в hub artifacts.lock.json | Release job (P1; zip не pre-exists — создаётся при Release), G7 fetch (bare + hooks, step 5) |
| **animastor-gpu-hub** | G4: standalone docker build без монорепо-контекста (**после stager re-point на Release assets** — POST-SPLIT). G5: staging-gate `verify-staged-artifacts.sh` в build + `check-artifacts.sh` в собранном образе + сверка sha256 Release-assets. `node tools/update-artifacts-lock.cjs --check` (**после re-point writer на Release zips** — до тех пор monorepo-layout only, **B9-correction D6**). Package tests: `node tests/run-all.cjs` (22 checks). GHCR publish digest-pin. G7-parity snapshot: `JOB_PROTOCOL_V2.md` из **backend**. | `@animastor/contracts ^0.1.0`, cors, express ^4.19.2, ioredis (frozen; devDeps forbidden — run-all line 147). B5-тройка (lock, gate, writer) живёт в **repo**, не в npm tarball (`files` omits them). | `GHCR_TOKEN` (packages:write); artifact tokens только на build-time fetch. NPM_TOKEN не нужен для CI checks. | G4, G5 (staging-gate + post-build 6/6 + lock `--check` после re-point), npm test 22 checks, GHCR digest-pin | **3 layers**: (1) staging-gate sha256_tree vs lock **до** `COPY --from=stager`; (2) post-build `check-artifacts.sh` [3/6] min_version + [4/6] per-workflow SHA256; (3) **POST-SPLIT**: sha256 Release-asset vs lock (криптографический якорь) | G4 (Dockerfile paths monorepo-relative), G5 Release-asset digest (assets unpublished), GHCR digest-pin (R-3 NO-GO до решения), `--check` post-split (writer walkRoot monorepo-relative — re-point POST-SPLIT) |
| **animastor-android** | G7-parity snapshot: fetch `ANDROID_WEB_PARITY.md` **из web** (canonical owner; R-5: из VPS bare, GitHub зеркало). Verify commit + sha256; auto-PR on change; android не редактирует контент кроме header `snapshot of web@<commit>`. G6-analog: gradle unit tests (`junit:junit:4.13.2`, PlayerGateTest.kt) — **B9-correction D5: пин явно**. APK build: `./gradlew assembleDebug` (build-apk.sh / apk-build.sh). | **None** — no package.json under frontends/android/; gradle-only (Maven deps). | None для checks (опц. signing keystore; GITHUB_TOKEN если APK → GitHub Release) | G7 snapshot (commit+sha256 vs web), gradle assembleDebug + JVM unit tests | G7 parity file sha256 vs canonical web; (release) APK asset sha256 | G7 fetch (bare + hooks, step 5) |

### B9-corrections (исправления относительно предыдущей ревизии матрицы)

| # | Было (ошибка/пробел) | Стало |
|---|---|---|
| **D3** | backend row: нет Release job, нет `GITHUB_TOKEN`; secrets = только `NPM_TOKEN` | backend публикует 3× hub-artifacts assets (tag `hub-artifacts-v1`); нужен `GITHUB_TOKEN` для Release |
| **D4** | worker G7 = «snapshot из web» | worker/hub G7 source = **backend** (`JOB_PROTOCOL_V2.md` canonical owner); только `ANDROID_WEB_PARITY.md` — web-owned |
| **D5** | android G6 ambiguous / отсутствовал | android G6 = gradle unit tests (junit, PlayerGateTest.kt) — явно пинится |
| **D6** | `--check` listed в hub CI как есть | `--check` monorepo-layout only до re-point writer на Release zips; в hub CI — после re-point (POST-SPLIT remainder) |
| **D7** | (не ошибка, уточнение) | lock реализует `sha256_tree` (tree digest); asset `sha256` — POST-SPLIT поле; оба значения документированы §B5 |
| **D8** | (уже отмечено) | base images `alpine:3.19`/`node:20-slim` не digest-pinned — POST-SPLIT |
| **D9** | (уже отмечено) | npm tarball `@animastor/gpu-hub` не содержит B5-тройку → `b5-artifact-contract` = hub-CI post-split, не backend CI |
| **D10** | (уже отмечено) | R-3 OWNER DECISION gate'ит hub CI matrix: существующий `animastor-gpu-hub` GitHub (43 коммита, свой ci.yml + ghcr-release.yml) — сверка workflows с матрицей B9 при выборе A |
| **D11** | (усилено) | G2 не имеет standalone test file в монорепо — CI scan шаг **авторится в workflow** с нуля (эквивалентные инварианты живут в per-package boundary suites); G1 — pure CI grep |

---

## P4 — остаточный `workflow.json`

**Факт на `35ba2b82`** (re-verified): `/home/animastor/animastor/workflow.json`
— **пустой каталог** (не файл), `root:root drwxr-xr-x`, создан 2026-08-24;
в git **не отслеживается** (`git ls-files` = 0); `.gitignore` строка 43:
`workflow.json/`; compose-mount `./workflow.json:/workflow.json:ro` удалён из
**основного** `docker-compose.yml` в `bd66bae6` (C7-гвард запрещает возврат).

**Runtime**: backend/src, packages/, frontends/ — **никто не читает**
`/workflow.json` как runtime-файл; `installer-phase15.test.js` использует
строку `'somewhere/else/odd-workflow.json'` только как test-data path —
не runtime mount. Runtime-файл отсутствует — удалять сейчас нечего и незачто.

**Stale mount (новая находка)**: `frontends/android/docker-compose.yml:41`
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

---

## P6 — диск перед filter-repo (аудит на `35ba2b82`)

**Факт**: `/` = `/dev/sda2` 99G, занято 92G, **свободно 2.9G** (97%).
Потребность последовательного filter-repo 5 репозиториев: mirror-клон
монорепо ~73M (.git) × 5 + рабочая копия переписи ~2× пик истории →
**≈3.0–4.5G суммарно**. **2.9G — НЕ достаточно** с нормальным запасом
(нет headroom под OS/npm/Docker churn). Минимум: **≥5G** (рекомендуется
≥8G).

| Компонент | Размер | Классификация |
|---|---|---|
| `.git` (monorepo) | **73M** (packs 56M, 8 pack files) | — |
| npm cache `~/.npm` | **792M** (_cacache 692M, _npx 100M) | cache — deletable |
| Docker images | **13GB** (6 active, все в употреблении) | runtime — НЕ трогать |
| Docker volumes | 1.727GB total; reclaimable **235MB** | 3 linked (ollama-data 1.36G, pg, redis) — НЕ трогать; dangling — см. cleanup |
| Build cache | **0B** | пусто |
| `~/.cache/pip` | **4.4G** | cache — deletable |
| `/tmp/opencode` | **2.8G** (ttsvenv 1.9G, sims, hometest) | tmp — deletable |
| `/tmp/installer-cli-cpu-install-*` | **2.3G** (71 dirs) | tmp — deletable |
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
| 4 | `rm -rf /tmp/installer-cli-cpu-install-*` | **~2.3G** | Low — install leftovers |
| 5 | `rm -rf /tmp/pip-unpack-* /tmp/npm-inst /tmp/gh_2.62.0_linux_amd64` | **~330M** | Low — tmp leftovers |
| 6 | `journalctl --vacuum-size=200M` (root) | **~3.5G** | Low — system logs |
| 7 | `rm -rf ~/.gradle/caches` | **~1.1G** | Low — перескачается |
| 8 | `docker volume rm $(docker volume ls -q --filter dangling=true)` | **~235M** | **Medium** — содержит `animastor_migration_*`, `animastor_sqlite-data`; inspect first |
| 9 | `sudo apt-get clean` | **~136M** | None |
| 10 | `rm -rf ~/.local/share/opencode/log` | **~52M** | Low — logs only |

**Минимальный путь для 5 репозиториев**: шаг 1 (pip cache) → free ≈7.3G —
**достаточно**. Шаги 1+2+3 → ≈13.4G — здоровый headroom.

**Не трогать**: `backups/` (4.0G, user data, новейший backup 1 день),
`opencode.db` (8.8G runtime), Docker images (6 active — 100% «reclaimable»
только потому что в употреблении; удаление = слом стека), linked volumes
(ollama-data/pg/redis — live data).

---

## R-3 — GPU Hub (verification only; репозитории не тронуты)

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
матрицей B9. **Если B** — backup + freeze hook + filter-repo экспорт истории
(NO-GO до решения; force-push исключён).

Решение не принято — обе опции документированы, ничего не перезаписано.
**R-3 gate'ит hub CI matrix** (D10): до выбора A/B hub workflows не авторятся.

---

## Mechanical checks (выполнены на `35ba2b82`)

| Проверка | Результат |
|---|---|
| backend lock: `"link": true` / `"file:` / `resolved: ../packages` | **0 / 0 / 0** ✓ |
| web lock: `"link": true` / `"file:` / `resolved: ../packages` | **0 / 0 / 0** ✓ |
| `"file:"` / `"link"` в backend/web package.json | **0** ✓ |
| backend `npm ci` | exit 0, 399 packages ✓ |
| web `npm ci` | exit 0, 227 packages ✓ |
| backend `test:arch` / `npm test` | **979 passing / 2 failing** (IB-G15, T9 — pre-existing; не новые ошибки) ✓ |
| web `build:packages` | 13/13 pkgs built ✓ |
| web `typecheck` | exit 0 ✓ |
| web `test` (vitest) | **201/201 passed** (15 files) ✓ |
| web `build` (vite) | exit 0, built in 1.81s ✓ |
| worker `sync-protocol.cjs --check` | exit 0 — «in sync with @animastor/contracts» ✓ |
| worker `tests/run-all.cjs` | **45 pass / 0 fail** ✓ |
| B5 `update-artifacts-lock.cjs --check` | «in sync with source trees» ✓ |
| Docker Hub build (staging gate + bake-in) | exit 0; gate RUN passed; «artifact bake-in verified: 4 groups present» ✓ |
| Docker `check-artifacts.sh` (post-build, в собранном образе) | **ALL CHECKS PASSED** — 6/6 ✓ |
| `.github/` в монорепо | отсутствует (P5 confirmed) ✓ |
| workflow.json | пустой каталог, не tracked, runtime не использует ✓ |

**IB-G15 / T9** — pre-existing (в объём новых ошибок не входят):
- IB-G15: `installer-package-boundary.test.js:243` — `pkg.private === true`
  vs published `@animastor/installer@0.1.0` (нет `private` поля).
- T9: `phase5-runtime-result.test.js:401` — ENOENT
  `backend/src/runtime/index.js` (файл удалён из истории).

---

## Самопроверка документа

- B9 matrix финализирована: D3 (backend Release + GITHUB_TOKEN), D4
  (worker/hub G7 → backend), D5 (android G6 = gradle tests), D6
  (`--check` — после re-point) — исправления зафиксированы в §B9-corrections.
- P4: re-verified — пустой каталог, не tracked, runtime не использует;
  stale android-compose-mount зафиксирован для owner.
- P6: обновлён факт (2.9G — insufficient для 5 repos); minimal cleanup
  (pip cache → 7.3G) документирован; команды не выполнялись.
- B5: 4 группы exact values сверены; gate ordering (line 30 < line 44)
  подтверждён; legacy `old_*` — в digest, не в baselines, не удалять;
  документационные дрейфы старых доков зафиксированы (не переписывались).
- Mechanical: все проверки зелёные; IB-G15/T9 — pre-existing, не новые.
- Ограничения соблюдены: physical split не выполнялся; filter-repo нет;
  новых GitHub repos нет; force-push нет; существующий GPU Hub repo не
  изменён; npm publish нет; production architecture changes нет;
  file:/symlink deps не возвращены; B7-тесты не изменены.
- Единственный изменённый файл: этот документ.
