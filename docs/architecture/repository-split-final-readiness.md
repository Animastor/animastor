# Repository Split — Final Technical Readiness (B1–B12)

Дата: 2026-10-01
HEAD: `7848b49d` (execution readiness, unambiguous contract)
База: `repository-split-preparation-plan.md` (rev 3.2, НЕ менялся),
`repository-split-execution-readiness.md` (НЕ менялся).

> **Обновление статуса (документационная ревизия): R-3 решён —
> вариант A = SELECTED, B = REJECTED**
> (`repository-split-r3-decision.md`). Все упоминания «R-3 OPEN /
> решение не принято» ниже — **исторический статус на 2026-10-01**.
> Существующий `Animastor/animastor-gpu-hub` сохраняется без изменений,
> `filter-repo` для GPU Hub не выполняется, новый репозиторий не создаётся,
> force-push/overwrite/delete запрещены, его standalone history канонична.

Метод: только чтение и анализ. `npm view` против registry.npmjs.org,
`git ls-files` против §8.1–8.5, grep по `backend/src`, `backend/tests`,
`packages/*/src`, `tools/`; локальные прогоны (`sync-protocol.cjs --check`).
Ничего не создано, не опубликовано, не удалено; физический split не
выполнялся.

---

## 0. FINAL STATUS

**PHYSICAL SPLIT: BLOCKED.**

Разблокировка по фазам:

- **B1→B2→B3→B4→B6→B8→B12 стартуют сразу после P2** (FF `master`) — все
  данные для них подтверждены (§2), реальных технических препятствий в коде
  не найдено.
- B5, B7, B9 — сразу после размонорепизации.
- Создание bare/GitHub/hooks и filter-repo — после закрытия всех HARD
  пунктов §1 и решения R-3.

## 1. HARD PRECONDITIONS

| ID | Что проверено (факт) | Статус | Блокирует |
|---|---|---|---|
| P1 | bare на VPS: `animastor.git` + **`animastor-gpu-hub.git` уже существуют**; GitHub: **4 репо (`backend`, `web`, `android`, worker) СОЗДАНЫ владельцем 2026-10-03** (200, `size=0`, 0 refs), `animastor-gpu-hub` **существует с историей (43 коммита)**; **4 bare/hook — отсутствуют** | **PARTIAL** | Нужны 4 bare + hooks + remote `github`. Создавать `animastor-gpu-hub` заново НЕЛЬЗЯ — см. R-3 |
| P2 | `master` = `8118f766`, является предком HEAD; FF возможен; отставание выросло до **141** коммита (в readiness — 136 на момент `2078c5d3`) | OPEN | filter-repo (и формально — шаг 1 размонорепизации) |
| P4 | решения зафиксированы (`workflow.json` RETIRE, `local.properties` VPS-local); физически untracked-заглушка `workflow.json` (пустой каталог, root-owned) ещё существует на VPS | OPEN (гигиена) | Ничего технически: оба пути untracked, в историю не попадают; удаление каталога — до filter-repo |
| P5 | `.github/` в монорепо отсутствует (проверено) | OPEN | filter-repo (G1–G5 негде гонять) |
| P6 | диск: исторически **3.5 GB свободно (97% занято)**; **актуально 2026-10-04: `df -B1 /` = `6 839 934 976 B` ≈6.4 GiB ≥ 5G** | **CLOSED / PASS** | **не блокирует**; очистка не выполнялась и не требуется |
| P3 | `npm whoami` → E401: токен по-прежнему недействителен | OPEN | только npm publish после split (POST-SPLIT REQUIREMENT); `npm view`/установка публичных пакетов работает |
| R-3 | ~~решение по существующему `animastor-gpu-hub` не принято~~ **РЕШЕНО: A = SELECTED, B = REJECTED** (`repository-split-r3-decision.md`) | **CLOSED** | **не блокирует**: `filter-repo` gpu-hub **не выполняется**, шаг из очереди исключён (строка ниже — историческая запись на 2026-10-01) |

## 2. Статус B1–B12 (факты, на которых основан статус)

| ID | Предмет | Проверенный факт | Статус |
|---|---|---|---|
| B1 | contracts в backend deps | `backend/package.json`: contracts НЕ в dependencies; скрытый резолв через mount + root node_modules; `require('@animastor/contracts')` в `src/contracts/runtime-result.js:23`, `src/runtime/job-schema.js:31`; contracts 0.1.1 на npm = локальной | **READY** |
| B1a | второй скрытый dep | `animastor-comfyui-workflow-connector` требуется в 6 файлах runtime (`backend.cjs:714`, `services/workflow-manager.js:14-16`, `profile-override.js:18`, `middleware/auth-context.js` и др.), но отсутствует в `backend/package.json` — резолвится только mount'ом; §4.1 prep plan учитывал «1 скрытый» (contracts) | **READY, scope уточнён** (R-1) |
| B2 | 11 `file:` → npm | подтверждены все 11 (`ai-agent, ai-analysis, assistant, editor, generation, installer, orchestration, parser, player, url-safety, vbook-runtime`); `@animastor/auth` уже `^0.1.0` (npm). Локальные версии = registry по всем 15 backend-пакетам (таблица §6). Lock-файлы отсутствуют ровно у 3: `animastor-ai-agent`, `animastor-comfyui-workflow-connector`, `animastor-orchestration` | **READY** |
| B2a | 5 runtime mounts | `docker-compose.yml`: `packages/animastor-contracts`, `animastor-comfyui-workflow-connector`, `animastor-vbook-runtime`, `animastor-player`, `animastor-installer` — ровно 5, все `:ro`. После B1/B2 backend Dockerfile (`COPY package.json package-lock.json*` + `npm install --omit=dev`) собирается из registry без mounts — сборка без monorepo возможна | **READY** |
| B3 | web 13 `file:` → npm | все 13 подтверждены (`web-ai-chat … web-workers`); все 13 опубликованы, локальные версии = registry = `0.1.0`; `frontends/app/package-lock.json` существует | **READY** |
| B4 | deep-subpath ↔ exports | реальные deep-import'ы: `vbook-runtime` (18 использований, все 8 subpath покрыты `exports`, вкл. `schemas/*`), `parser` (10, все 5 subpath покрыты), `ai-analysis` (5, все 3 tasks-пути покрыты); `@animastor/generation` — `./dirty-grammar` в `exports`, а `./core/artifact-naming`, `./ports/dispatch-transport`, `./src/index.js` встречаются ТОЛЬКО в negative-control тестах (`expect(...).to.throw()`) — инвариант держится. Пакеты без `exports` (`animastor-ai-connector`, `animastor-comfyui-workflow-connector`) требуются только по root (`main`) — покрыто | **READY — только G2, изменений пакетов не требуется** |
| B5 | hub artifacts | 4 группы подтверждены в `packages/animastor-gpu-hub/Dockerfile` (stager: `packages/animastor-worker/worker`, `backend/ai/workflows/`, `packages/animastor-installer/src/installer/` + `package.json`, `packages/animastor-installer/ai/install-manifests/`); `scripts/check-artifacts.sh` — 6 секций, вкл. SHA256-сверку workflow-базлайнов (секция 4). Build-time проверка в Dockerfile сегодня — только наличие директорий; **SHA256-проверка ДО `COPY --from=stager` пока не реализована** — её и добавляет B5. Для `artifacts.lock.json` создаются: 1 файл `packages/animastor-gpu-hub/artifacts.lock.json` (поля: `source_repository`, `release_tag`, `asset_filename`, `version`, `sha256` — §2.2 prep plan) + правка stager-стадии (скачивание assets + `sha256sum -c` до COPY). Worker bundle 2.1.1 = canonical; entrypoint worker берёт installer из hub по HTTP — прямой зависимости от backend-файлов нет | **READY к реализации** (с учётом R-3) |
| B6 | worker protocol | `sync-protocol.cjs --check` → **exit 0**; header копии штампует sha256 канона `b005fafc…` — совпадает с фактическим sha256 `packages/animastor-contracts/src/job-protocol-v2.js`; byte-for-byte парити обеспечивается генератором (body после маркера = канон). Кандидаты-пути канона: 3 уровня (после переезда) и 2 уровня (до) — **после split worker-репо оба мертвы**. Точный будущий резолв: `path.join(path.dirname(require.resolve('@animastor/contracts')), 'job-protocol-v2.js')` — работает, т.к. `exports` contracts содержит `"."` (deep-resolve `@animastor/contracts/src/…` заблокирован бы `exports` — не использовать). Fallback-массив удаляется, когда worker-репо имеет `@animastor/contracts` в devDependencies и `npm ci` выполнен | **READY** |
| B7 | tests | `backend/tests/architecture/` = **62 файла: 60 `*.test.js` + `helpers.js` + 1 прочий**; все 46 позиций §9 prep plan существуют. Spot-checks dispositions подтвердили: `lac-legacy-path-guard` (14 cross-refs, SPLIT) ✓; `phase7` worker-assert (стр. 88-89) ✓; `phase9c` mount-assert (стр. 319-322) ✓; `phase10j` (8 compose-refs, RETIRE) ✓; `phase10t-1` (worker/installer refs, MOVE hub) ✓; `phase9d` (MOVE worker) ✓; `helpers.js` `WORKER_PKG_DIR` fallback ✓. Расхождения по объёму: интеграционных с source-level require hub — **9, а не 7** (R-2); +4 architecture-теста читают hub-исходники вне §9 (R-4) | **READY с 2 уточнениями объёма** |
| B8 | web build pipeline | фактическая цепочка: пакет `npm run build` = **tsup → dist/** (`main: dist/index.js`, `exports: {".", "./package.json"}`), публикация — `prepublishOnly = typecheck && test && build` (пример `web-player`; канонизировать во всех 13); приложение: `npm run build` = **vite build** (dev-зависимости `vite`, `vitest`, `@preact/preset-vite`). Каноническая команда: в каждом пакете `npm ci && npm run build`; в корне web-репо — один скрипт-агрегатор «13 × package build → app vite build» (это и есть создаваемый B8 артефакт) | **READY** |
| B9 | CI | `.github/` отсутствует. Минимальный набор workflow (создаются на этапе B9, не сейчас): backend — G1+G2+G6 (+publish после P3); web — G1+G2+G6 (+publish); worker — G3+G6+Release zip+sha256; gpu-hub — G4+G5 (+GHCR); android — G7-parity snapshot + APK build; G7-снапшот-job'ы также в worker/hub. Owner каждого workflow = будущий репо-владелец (готовые workflow в монорепо-путях, чтобы переехали без переписывания) | **READY к созданию** |
| B10 | monorepo hook | hook `/home/animastor/repos/animastor.git/hooks/post-receive` = `git push --mirror github` — не меняется; split-bare создаются со своими hooks до первых push | **N/A до этапа bare** |
| B11 | deploy cutover | выполняется только после filter-repo (порядок §9 readiness); факты для него: nginx mounts `./frontends/website`, `./frontends/app`, `./docs` в `docker-compose.yml` — после split в backend-репо `frontends/` отсутствует (не в whitelist §8.1) → compose-валиден только после cutover на выкачки | **N/A до split** |
| B12 | root `package.json` | untracked (`git ls-files` = 0); deps: `animastor-ai-connector`, `animastor-comfyui-workflow-connector` — единственная функция: dev-резолв этих имён для backend на VPS; ни один script/CI/Dockerfile/compose не ссылается на корневой `package.json` (grep по `*.sh`, `docker/`, `docker-compose.yml`, rebuild-скриптам — пусто). Удаление безопасно **после** B1/B2 (когда оба имени появятся в `backend/package.json`); до B1 удаление сломает VPS dev-резолв | **READY (после B1/B2)** |

## 3. Обнаруженные расхождения (не скрываются, автоматически не исправляются)

| # | Расхождение | Влияние | Рекомендация |
|---|---|---|---|
| R-1 | §4.1 prep plan: «11 `file:` + **1 скрытый**» (contracts). Факт: скрытых **2** — ещё `animastor-comfyui-workflow-connector` (6 runtime-require'ов, deps нет, только mount) | B1 шире описания: добавить в `backend/package.json` ДВА dep | внести в чек-лист B1 (сам prep plan не менять) |
| R-2 | prep plan §9 перечисляет 7 интеграционных с `require('../../packages/animastor-gpu-hub/gpu-hub')`. Факт: таких файлов **9** (`gpu-hub-cleanup` НЕ референсит hub; дополнительно `fail-closed-worker-auth`, `private-worker-visibility`); итого source-level hub-requires: 9 root + 2 architecture (`phase10j`, `phase10t-1`) | объём B7 чуть больше заявленного; действие то же (npm/HTTP-контракт) | учесть 9 файлов в чек-листе B7 |
| R-3 | **`animastor-gpu-hub` уже существует**: VPS bare `/home/animastor/repos/animastor-gpu-hub.git` (43 коммита, root-layout, свой `post-receive --mirror github`, GitHub-зеркало живое; `refs/remotes/github/master` отстаёт от `master` bare на 1 коммит). Это репо эпохи Phase 10L/10N (свои `ci.yml` + `ghcr-release.yml`, README, Dockerfile root-layout). §8.5 prep plan порождает **вторую, несовместимую** (filter-repo, layout `packages/animastor-gpu-hub/`) историю | filter-repo gpu-hub в тот же bare/GitHub = force-перезапись существующей истории (mirror `--mirror` затирает). Необратимо | явное решение владельца ДО filter-repo gpu-hub: (a) заархивировать/переименовать существующее репо и пушить filter-repo-версию, или (b) признать существующее репо целевым и пересмотреть §8.5 (изменение плана). До решения — NO-GO (§7). **Статус 2026-10-04: решение принято — вариант A, `repository-split-r3-decision.md`; §8.5 не применяется, B-сценарий REJECTED** |
| R-4 | 4 architecture-теста читают hub-исходники, но в §9 prep plan disposition не внесены: `gpu-hub-contract` (читает `gpu-hub.js`), `phase10a-gpu-hub-contract-freeze` (`HUB_DIR`), `phase10d-gpu-hub-package-boundary` (`HUB_DIR`), `phase2-hub-worker-boundary` (читает файлы hub) | после split в backend эти пути отсутствуют → тесты падают, если не обработаны | добавить в объём B7: MOVE в hub-тесты или перевод на npm `@animastor/gpu-hub`/snapshot (решение при исполнении B7) |
| R-5 | readiness §2.3: «история parity НЕ переносится» ↔ prep plan §8.3 включает `--path ANDROID_WEB_PARITY.md` в whitelist android | двусмысленность: переносить ли историю parity в android | рекомендация: выполнять §8.3 как есть (перенос истории безвреден, файл ассимилируется), §5-механизм (CI snapshot по commit+sha256) — правило владения и обновления; формулировку readiness §2.3 уточнить в следующей документной ревизии (сейчас менять запрещено) |
| R-6 | backend script `test:connector-core` (`cd ../packages/animastor-comfyui-workflow-connector`) и root `package.json` умирают при split | первый — битый script в backend-репо; второй — удаляется B12 | `test:connector-core` заменить на `npm test --prefix node_modules/animastor-comfyui-workflow-connector` (или удалить) в рамках B2; root `package.json` — B12 после B1/B2 |
| R-7 | отставание `master` от рабочей ветки: 136 (на `2078c5d3`) → **141** (факт) | число в readiness устарело | не противоречие, обновление факта; P2 закрывается одним FF |

## 4. Финальный список действий перед первым физическим split

1. P2: FF `master` до рабочей ветки (одна команда, §6).
2. B1: `@animastor/contracts` + `animastor-comfyui-workflow-connector` в `backend/package.json` (R-1).
3. B2: 11 `file:` → точные caret-версии (§6); удалить 5 mounts из `docker-compose.yml`; создать 3 недостающих lock-файла; починить/удалить `test:connector-core` (R-6).
4. B3: 13 web `file:` → `^0.1.0`; регенерация `frontends/app/package-lock.json`.
5. B4: только G2-гвард (изменений пакетов не требуется — подтверждено).
6. B6: npm-резолв канона в `sync-protocol.cjs` (формула §2/B6); contracts в devDeps worker.
7. B8: канонический build-скрипт web-репо (13 × tsup → vite build); `prepublishOnly` во всех 13 пакетах.
8. B12: удалить root `package.json` (только после B1/B2).
9. B5: Release-артефакты (worker `worker-bundle-v2.1.1`; backend tag `hub-artifacts-v1`, 3 asset), `artifacts.lock.json`, SHA256-stager, G4/G5.
10. B7: перенос тестов по §9 + уточнения R-2 (9 файлов) и R-4 (4 теста); G6.
11. B9: workflows G1–G7 по owner-матрице; G1–G5 зелёные.
12. P6: освободить ≥3 GB.
13. P1: создать 4 bare + 4 GitHub-репо (`backend`, `web`, `android`, `worker`) + hooks до первых push; для gpu-hub — предварительно решить R-3.
14. P4-гигиена: физически удалить пустой каталог `workflow.json` на VPS (untracked, в историю не попадает).

## 5. Точный порядок выполнения

Совпадает с §9 `repository-split-execution-readiness.md` (сверено с §11
prep plan, изм. только R-2/R-4 в объёме B7):

0. FF master (P2); удалить каталог-заглушку `workflow.json`.
1. Размонорепизация: B1 (+R-1) → B2 (+R-6) → B3 → B4 (G2) → B6 → B8 → B12; G1/G2/G3 после каждого смыслового шага.
2. Артефактная схема hub: B5 (Release assets, pin-файл, SHA256-stager), G4+G5.
3. Перенос тестов: B7 по §9 + R-2 + R-4; G6.
4. CI: B9, минимум G1–G5 зелёные; P6 параллельно.
5. Инфраструктура публикации: 4–5 bare + GitHub + hooks (P1; gpu-hub — после решения R-3); G7.
6. filter-repo (только здесь), очередь: backend → web → android → worker (**gpu-hub исключён — R-3 = A, `repository-split-r3-decision.md`**); whitelist §8.n c override'ами readiness §9-6b (`workflow.json`, `local.properties` исключены); после каждого — post-split verification, push в bare, mirror-verification.
7. Freeze монорепо; сверка tips bare ↔ GitHub.
8. Deployment cutover (B11): снятие mounts, nginx-пути на выкачки.

## 6. Команды первого этапа (кодеру; этап стартует после P2)

```sh
# P2 — FF master (единственное условие старта этапа 1)
git checkout master && git merge --ff-only c21.4-physically-extract-analysis-from-backend
git push origin master && git checkout c21.4-physically-extract-analysis-from-backend

# B1 — скрытые deps в backend/package.json (в "dependencies"):
#   "@animastor/contracts": "^0.1.1",
#   "animastor-comfyui-workflow-connector": "^0.1.0"

# B2 — 11 file: → caret (точные целевые версии; локаль = registry):
#   ai-agent ^0.1.0, ai-analysis ^0.1.0, assistant ^0.1.0, editor ^0.1.1,
#   generation ^0.1.1, installer ^0.1.0, orchestration ^0.1.1, parser ^0.1.1,
#   player ^0.1.0, url-safety ^0.1.0, vbook-runtime ^0.2.0
# правка backend/package.json, затем:
cd backend && rm -rf node_modules && npm install && npm test
# создать 3 недостающих lock-файла:
cd ../packages/animastor-ai-agent && npm install --package-lock-only
cd ../animastor-comfyui-workflow-connector && npm install --package-lock-only
cd ../animastor-orchestration && npm install --package-lock-only

# B2 — compose: удалить 5 строк mounts (contracts, comfyui, vbook-runtime,
# player, installer) из docker-compose.yml; проверить:
docker compose config -q
# G1-гвард (должно быть пусто):
grep -n '"file:' backend/package.json frontends/app/package.json

# B3 — frontends/app/package.json: 13 web-пакетов → "^0.1.0", затем:
cd frontends/app && rm -rf node_modules && npm install && npm run build

# B4 — только гвард (изменений пакетов НЕ делать):
#   negative-control require'ы (@animastor/generation/...) должны бросать;
#   все реальные deep-import'ы покрыты exports (проверено §2/B4)

# B6 — проверка инварианта (уже зелёная):
node packages/animastor-worker/tools/sync-protocol.cjs --check   # exit 0

# B12 — только ПОСЛЕ B1/B2:
rm package.json   # untracked; в Git-историю не входит; удалить физически
```

## 7. NO-GO CONDITIONS (любой пункт запрещает соответствующее действие)

1. **filter-repo до FF `master`** (P2) — фильтрация не той истории.
2. **filter-repo при < ~3 GB свободно** (P6) — падение посреди переписывания.
   **Статус 2026-10-04: P6 = CLOSED / PASS — `df -B1 /` = `6 839 934 976 B` ≈6.4 GiB ≥ 5G,
   очистка не выполнялась и не требуется** (порог ≥5G в final-gate §1/§4).
3. **filter-repo при невыполненных B1–B9** или G1–G5 не зелёных — порядок §9.
4. **filter-repo gpu-hub** — необратимая перезапись живого репо (43 коммита, GHCR-CI)
   filter-repo-историей. **R-3 = A → действие запрещено бессрочно**
   (`repository-split-r3-decision.md` §3.1); пункт остаётся как постоянный запрет.
5. **Прямой push из временного клона в GitHub** — запрещён §7.3 prep plan; только VPS bare + post-receive.
6. **npm publish при недействительном токене** (P3, E401) — publish-шаги до возобновления NPM_TOKEN.
7. **Удаление root `package.json` до B1/B2** — сломает VPS dev-резолв `animastor-comfyui-workflow-connector`/`animastor-ai-connector` для backend.
8. **Изменение monorepo `post-receive` hook** — §7.2; split-bare получают собственные hooks.
9. **Создание `Animastor/animastor-gpu-hub` заново** — репо существует; создавать только 4 отсутствующих.

## 8. FILTER-REPO RISKS

| # | Риск | Митигция |
|---|---|---|
| 1 | nginx mounts `./frontends/website`, `./frontends/app` (и частично `./docs`) в `docker-compose.yml`: в backend-репо `frontends/` отсутствует → compose невалиден между filter-repo backend и B11 | B11 в порядке §9 обязателен до деплоя; до cutover деплой продолжает работать из монорепо-чекayта (freeze, не удаление) |
| 2 | 13 backend-тестов читают `packages/animastor-gpu-hub` / `packages/animastor-worker` — упадут после filter-repo backend, если B7 не завершён | порядок §9 (B7 до filter-repo); spot-checks §2/B7 подтверждают состав |
| 3 | hub Dockerfile монорепо (context `.`) не собирается из hub-репо: пути `packages/animastor-worker/...`, `backend/ai/...` отсутствуют | B5 переписывает stager на Release-артефакты + pin-файл до filter-repo hub; G4 проверяет standalone-сборку |
| 4 | `sync-protocol.cjs`: оба кандидат-пути канона мертвы в worker-репо → `--check` красный | B6 npm-резолв до filter-repo worker; G3 в CI |
| 5 | `workflow.json`, `local.properties` в whitelist §8.1/§8.3 — no-op строки (untracked): filter-repo их молча пропустит | исключены из выполняемых команд override'ом (readiness §9-6b); расхождений не создают |
| 6 | Существующий `animastor-gpu-hub`: mirror hook нового/переиспользуемого bare с `--mirror` затрёт GitHub-историю без предупреждения | NO-GO №4; решение R-3 фиксируется письменно до исполнения |
| 7 | Кириллический filename в `docs/` (git quotepath `\"docs/Animastor_Близкие_горизонты.md\"`) — аудит-команды `git ls-files` могут искажать путь | использовать `git -c core.quotepath=false ls-files` / `-z` при проверках §6 readiness |
| 8 | Коллизии тегов между репо (общая история) | `--tag-rename` при фильтрации (уже в §9 readiness) |

---

## Самопроверка

- Числа: 11+2 скрытых backend deps; 13 web deps; 15 backend-пакетов
  (версии локаль = registry); 5 mounts; 3 недостающих lock-файла; 62 файла
  в `tests/architecture` (46 в §9 + 16 без cross-repo путей); 9+2 hub-source
  тестов; 4 репо отсутствуют, 1 существует; master отстаёт на 141.
- B10/B11 — N/A до соответствующих этапов, не «BLOCKED».
- Ни один раздел не противоречит prep plan rev 3.2 и execution readiness
  `7848b49d`; расхождения R-1–R-7 вынесены явно, prep plan не менялся.

**Вердикт: PHYSICAL SPLIT: BLOCKED** — этап 1 (B1→…→B12) стартует сразу
после P2; filter-repo — после §4/§5 полностью.
