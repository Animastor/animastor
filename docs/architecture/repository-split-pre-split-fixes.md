# Repository Split — Pre-Split Fixes (B1–B12 decoupling executed)

Дата: 2026-10-01
HEAD на начало: `7ff1e381` (final technical readiness)
База (контракты, НЕ менялись): `repository-split-preparation-plan.md`
(rev 3.2), `repository-split-execution-readiness.md` (`7848b49d`),
`repository-split-final-readiness.md` (`7ff1e381`).

Объём этапа: устранение реальных расхождений из final-readiness
(R-1, R-2, R-4, R-6, частично R-5) и исполнение разрешённых частей
B1/B2/B3/B6/B8/B12 + подготовка B7. Физический split НЕ выполнялся:
без `git filter-repo`, без новых bare/GitHub-репозиториев, без force-push,
без `push --mirror` в существующий GPU Hub, без npm publish, без releases,
без CI, без изменения существующего `animastor-gpu-hub`.

---

## 1. Что было исправлено

| # | Изменение | Файлы |
|---|---|---|
| 1 | **B1+R-1**: в backend объявлены ОБА скрытых runtime-dep: `@animastor/contracts ^0.1.1` и `animastor-comfyui-workflow-connector ^0.1.0` | `backend/package.json` |
| 2 | **B2**: все 11 `file:` → npm caret (точные registry-версии §6); `npm install` прошёл, все 13 `@animastor/*` + connector — реальные копии из registry (не симлинки) | `backend/package.json`, `backend/package-lock.json` |
| 3 | **B2**: удалены все 5 runtime `:ro` mounts пакетов И мёртвый mount `./workflow.json` из сервиса backend | `docker-compose.yml` |
| 4 | **B2/R-6**: `test:connector-core` переведён на установленный пакет: `npm test --prefix node_modules/animastor-comfyui-workflow-connector` (ссылка на `../packages/...` устранена) | `backend/package.json` |
| 5 | **B2**: созданы 3 недостающих lock-файла (`--package-lock-only`): `animastor-ai-agent`, `animastor-comfyui-workflow-connector`, `animastor-orchestration` | 3 × `package-lock.json` (новые) |
| 6 | **phase9c C7** (§9 prep plan: «mount-assert — RETIRE после B1»): assert монтирования заменён на инверсный гвард «5 монорепо-mount'ов не возвращаются» | `backend/tests/architecture/phase9c-contracts.test.js` |
| 7 | **dual-instance фикс**: facade (npm-копия) и канон (monorepo-исходник) перестали быть одним модулем после B1 → runtime-identity проверки resolve через npm (`require.resolve('@animastor/contracts')` c `paths: backend`); байт-идентичность npm-копии исходнику подтверждена `diff` | `phase9c-contracts.test.js`, `gpu-hub-contract.test.js` |
| 8 | **B7/R-2 (9 интеграционных)**: все 9 root-тестов с source-level require hub переведены на npm devDependency `@animastor/gpu-hub@^0.1.1` (`buildHubApp`/`bootstrap` из файлов модуля, не из package root — `main` = server.js); `orchestration-stabilization` читает hub-исходник через `require.resolve` | 9 файлов `backend/tests/*.test.js` |
| 9 | **B7/R-4 (4 architecture)**: `gpu-hub-contract`, `phase10a`, `phase10d`, `phase2-hub-worker-boundary` — чтение hub-исходников переключено с `packages/animastor-gpu-hub` на npm-каталог пакета (pack-surface/Dockerfile-ассерты валидны: tarball содержит те же файлы); lockfile/contracts-link ассерты phase10d retargeted на monorepo-исходник (в npm tarball lock не пакуется); version-pin `0.1.0` → равенство с канонической версией contracts | 4 файла `backend/tests/architecture/` |
| 10 | **phase10j TF-ассерт**: «backend не объявляет gpu-hub dep» → теперь требует `@animastor/gpu-hub` в devDependencies и его ОТСУТСТВИЕ в production dependencies | `phase10j-gpu-hub-transitional-fixture.test.js` |
| 11 | **B6**: `sync-protocol.cjs` — npm-resolve канона (`require.resolve('@animastor/contracts')` от `__dirname` + подъём до package root; deep-resolve заблокирован `exports` пакета by design); monorepo-relative кандидаты удалены (после split они гарантированно мертвы); `--check` сохранён; сгенерированная копия НЕ изменилась (sha256 копии `913e9a07…`, канон `b005fafc…` — без изменений) | `packages/animastor-worker/tools/sync-protocol.cjs` |
| 12 | **B6**: создан dev-harness манифест worker: `@animastor/contracts ^0.1.1` в devDependencies (bundle остаётся zero-dep: `worker/package.json` не менялся; `@animastor/worker-dev` — private, не публикуется, попадает в whitelist §8.4 как root-манифест будущего worker-репо) | `packages/animastor-worker/package.json` (новый), `package-lock.json` (новый) |
| 13 | **B3**: все 13 web `file:` → `^0.1.0`; `npm install` прошёл; npm-копии содержат src | `frontends/app/package.json`, `package-lock.json` |
| 14 | **B8**: канонический root build-скрипт web-репо: `npm run build:packages` (последовательный `npm --prefix <pkg> run build` по всем `packages/animastor-web-*`, fail-fast) + существующие `npm run typecheck && npm run build` (vite). Полная цепочка: `build:packages` → `typecheck` → `build` | `frontends/app/package.json` |
| 15 | **B12**: root `package.json` удалён (untracked, в историю не входил) после подтверждения: оба скрытых dep объявлены явно, backend резолвит их из `backend/node_modules`, ни один script/CI/Docker/compose на него не ссылался | корень репо |

## 2. Какие проверки реально выполнены

| Проверка | Результат |
|---|---|
| `npm install` backend (registry, без mounts) | ✓ added packages; `require.resolve` contracts/connector → `backend/node_modules/...` |
| `npm run test:arch` backend (62 файла architecture) | **972 passing / 2 failing**; базлайн до правок (git stash): **970 passing / 4 failing** → +2 починенных, −2 pre-existing (см. §4) |
| `npm test` backend (полный suite) | 972 passing / 2 failing (те же 2 pre-existing) |
| 9 интеграционных hub-тестов по отдельности | все зелёные: gpu-hub-artifacts 29, fail-closed-worker-auth 18, worker-setup-api 40, worker-share-grants 27, private-worker-phase2 41, private-worker-visibility 23, worker-share-policy 45, orchestration-stabilization 11, gpu-hub-bootstrap 9 |
| `npm install` + `npm run build` web app | ✓; `npm test` (vitest) — **201/201**; `npm run build` (vite) — ✓; `npm run typecheck` — ✓ |
| `npm run build:packages` (13 web-пакетов tsup) | ✓ (exit 0); точечный smoke `npm ci && npm run build` на web-file/web-navigator/web-settings — ✓ dist/ |
| `node tools/sync-protocol.cjs --check` (B6) | ✓ exit 0, «in sync», sha256 канона `b005fafc…` не изменился |
| `node tests/run-all.cjs` worker | 45 pass / 0 fail |
| `node tests/run-all.cjs` gpu-hub (monorepo + после `npm ci` в пакете) | 22 passed / 0 failed |
| `npm test` contracts | 37/37; `npm test` comfyui-connector — 34 passing |
| installer setup-contract suite (через backend mocha) | 68 passing |
| `docker compose config -q` | ✓ (compose валиден без 5 mounts) |
| grep `"file:` по всем package.json | **0** (G1-инвариант) |
| grep `packages/animastor` в backend runtime | только комментарии (адресация — npm-спецификаторы); в compose — только hub build context (pre-split, легитимно до B5/B11) |
| grep root `package.json` ссылок (scripts/CI/Docker/compose) | пусто (подтверждение B12) |
| `diff` npm-копий (contracts, gpu-hub) vs monorepo | byte-identical по всем сверенным файлам |
| Байт-идентичность `job-protocol-v2.cjs` | sha256 копии и канона без изменений после правок |

## 2.1 Верификация лок-файлов — вторая итерация (текущая)

Первая итерация (§2) выполнялась на унаследованных `node_modules` (частично — ещё workspace-симлинки). Эта итерация: полная регенерация обоих локов и чистый `npm ci`-сценарий с нуля.

### Backend

| Шаг | Результат |
|---|---|
| `rm -rf node_modules package-lock.json && npm install` | лок регенерирован; guard-greps: **0** `"link": true`, **0** `"resolved": "../packages…"`, **0** `"file:`; все 13 `@animastor/*` + comfyui-connector из registry (включая вложенные `vbook-runtime@0.1.0` у ai-analysis/editor/player; верхнеуровневый `vbook-runtime@0.2.0`) |
| `rm -rf node_modules && npm ci` | ✓ чистая установка; `require.resolve` всех 8 runtime-dep ✓; `node_modules/@animastor/contracts` — реальный каталог registry-версии 0.1.1 |
| `npm run test:arch` после регена | было **965/9** → после фикса фикстур **972/2** (обе — pre-existing: IB-G15, T9) |
| `npm test` (полный suite) | 972 passing / 2 failing |

### Регрессия dual-instance в тестах (найдена и закрыта)

После подмены симлинков registry-копиями архитектурные тесты, требующие монорепо-исходники напрямую (`packages/animastor-generation/src`, `packages/animastor-orchestration/src`, `packages/animastor-vbook-runtime/src`), стали читать **второй экземпляр** портов: mocharc-фикстуры wire'или npm-копию, тесты — монорепо-копию → registry монорепо-копии оставался пуст (self-bootstrap молча падал в try/catch), `bindHostModules`/`configureBooksRoot` не применялись. Раньше это была одна физика через workspaces-симлинк (realpath-схлопывание).

Фикс — фикстуры дополнительно wire'ят монорепо-копии (hoisting `HOST_MODULE_BINDINGS`, try-блоки становятся no-op после физического split):

- `backend/tests/generation-test-bindings.cjs` — `setGenerationConfig` + `bindHostModules` для `packages/animastor-generation|orchestration`;
- `backend/tests/vbook-test-bindings.cjs` — `configureBooksRoot` + `setStructureDetector` для `packages/animastor-vbook-runtime|parser`.

Продакшн (`backend.cjs`) не менялся: runtime живёт на npm-копиях. Все fail-fast тесты портов делают явный `_reset*` перед проверкой — pre-wiring безопасен (проверено прогоном).

### Web

| Шаг | Результат |
|---|---|
| Root cause рассинхрона `npm ci` | npm 10.9.8 arborist падает с `TypeError: … 'edgesOut'` на plain `npm install` (peer-резолюция vitest@4 ↔ vite@5), а `npm ci` без флага требует peer-поддерево (`esbuild@0.28.2` nested vite@8), которого в legacy-локе нет |
| Фикс | `frontends/app/.npmrc` (repo-local) с `legacy-peer-deps=true` — install и ci на одном пути резолюции |
| Регенерация | `rm -rf node_modules package-lock.json && npm install`; guard-greps: **0** link/local-resolved/`file:`; 13 web-* из registry |
| Чистая цепочка | `rm -rf node_modules && npm ci` ✓ → `build:packages` (13 пакетов) ✓ → `typecheck` ✓ → vitest **201/201** ✓ → `vite build` ✓ |

### Worker

`node tools/sync-protocol.cjs --check` после чистого `npm ci` backend — ✓ exit 0 (npm-resolve канона работает с registry-деревом).

## 3. Таблица B1–B12 после изменений

| ID | Статус | Комментарий |
|---|---|---|
| B1 | **DONE** | оба скрытых dep объявлены; mount'ы сняты; container-резолв — из npm внутри образа |
| B2 | **DONE** | 11 `file:` → npm; 5 mounts удалены; 3 lock-файла созданы; `test:connector-core` post-split-совместим; backend собирается/тестируется без monorepo |
| B3 | **DONE** | 13 `file:` → npm; лок регенерирован (0 link/local/file), `npm ci` ✓; `.npmrc` `legacy-peer-deps=true` (баг arborist npm 10.9.8 + peer vitest@4↔vite@5); цепочка ci → build:packages → typecheck → test (201/201) → build зелёная |
| B4 | **DONE (инвариант подтверждён)** | изменений пакетов не требовалось: реальные deep-import'ы покрыты `exports`; negative-control require'ы по-прежнему бросают (проверено test:arch) |
| B5 | **OPEN (код не менялся — по ТЗ)** | Dockerfile/stager/check-artifacts не тронуты; реализация — следующий этап |
| B6 | **DONE** | npm-resolve канона; `--check` зелёный; копия байт-неизменна; dev-harness манифест с contracts devDep |
| B7 | **DONE (объём R-2/R-4 закрыт)** | 9 интеграционных + 4 architecture → npm-путь; остальные dispositions (SPLIT/MOVE/RETIRE по §9) — при физическом split |
| B8 | **DONE** | канонический `build:packages` + typecheck + vite build в `frontends/app` |
| B9 | **OPEN (CI запрещён ТЗ)** | workflows не создавались; G-гварды проверены локально |
| B10 | **N/A** | hook монорепо не менялся |
| B11 | **N/A** | deploy cutover — только после filter-repo |
| B12 | **DONE** | root `package.json` удалён; backend не зависит от root node_modules (require.resolve → backend/node_modules) |

## 4. Что осталось BLOCKED

| Блокер | Причина |
|---|---|
| **2 pre-existing падения** `test:arch` (НЕ внесены этим этапом, подтверждены stash-базлайном) | (1) `installer-package-boundary.test.js:241` — требует `"private": true` в `packages/animastor-installer/package.json`, а пакет опубликован на npm (0.1.0) и private-поля не имеет; (2) `phase5-runtime-result.test.js:401` — читает `backend/src/runtime/index.js`, файл удалён из истории ранее (последний раз менялся в b71b9674). Оба требуют отдельного решения владельца (правка пакета/теста вне объёма этого этапа) |
| P2: FF master | `master` = `8118f766`, отстаёт на 141+ (после новых коммитов больше) |
| P1: 4 GitHub-репо (`backend`, `web`, `android`, `worker`) не созданы | создание запрещено ТЗ |
| P5: CI отсутствует | создание запрещено ТЗ; G1–G5 подтверждены локально |
| P6: диск 3.5 GB (историческое) | **CLOSED / PASS (2026-10-04)** — `df -B1 /` = `6 839 934 976 B` (≈6.4 GiB) ≥ 5G; очистка не выполнялась и не требуется; значение «3.5 GB» ниже — исторический статус этого этапа |
| P3: npm-токен E401 | POST-SPLIT requirement, без изменений |
| R-3: GPU Hub decision | **ЗАКРЫТ — вариант A = SELECTED, B = REJECTED** (`repository-split-r3-decision.md`); §5 ниже — актуальный статус |
| R-5: расхождение readiness §2.3 ↔ prep plan §8.3 (parity) | зафиксировано в final-readiness; документы по ТЗ не менялись; правило исполнения — §6 |
| R-7: числа readiness (136→141+) | обновляется фактом FF master |

## 5. GPU HUB — **DECIDED: вариант A = SELECTED, вариант B = REJECTED**

Read-only анализ (изменений не вносилось, ничего не перезаписано):

**Факт 1 — что существует.** VPS bare `/home/animastor/repos/animastor-gpu-hub.git`:
43 коммита (2026-06-11 … 2026-09-06), линейная история, root-layout,
свой `post-receive` = `git push --mirror github` (guard по basename отсутствует),
GitHub-зеркало `Animastor/animastor-gpu-hub` живое (HEAD = `7c7778c`,
«GHCR release workflow lowercase fix»). В bare есть remote `github`;
`refs/remotes/github/master` (`b95870f`) отстаёт от `master` bare (`7c7778c`)
на 1 коммит — mirror последнего push не прошёл/не выполнялся.

**Факт 2 — соответствие нынешнему `packages/animastor-gpu-hub`.** Код:
`server.js`, `tarball.js`, `bootstrap.js` — **байт-идентичны**;
`gpu-hub.js` — **отличается**: в bare остался deprecated-роут `GET /worker-source`
(Experimental Beta, «single-file install broken», канон — `GET /worker-bundle`),
в monorepo-версии роут удалён; `package.json`: bare = `0.1.0`, repository url
на `animastor-gpu-hub.git`, нет `publishConfig`; monorepo = `0.1.1`,
url на monorepo + `directory`, `publishConfig.access: public` — это
опубликованная на npm версия. Dockerfile: bare = простой root-layout
(`FROM node:20; COPY . .`), monorepo = multi-stage stager с bake-in 4 групп
артефактов + build-time проверка. Тесты: bare `tests/run-all.cjs` — 260 строк
(более старая редакция), monorepo — 305 строк (расширенная).

**Факт 3 — это более новая самостоятельная реализация?** Нет. Истории bare и
monorepo **не пересекаются** (commit-объекты bare отсутствуют в ODB monorepo —
bare вёл самостоятельную жизнь с июня 2026). Bare — слепок ранней фазы Phase
10D-эпохи + косметика CI (последний коммит 2026-09-06 — только workflow-файл).
Развитие кода с июня шло в monorepo: версия 0.1.0→0.1.1, удаление
`/worker-source`, stager-Dockerfile, расширенные тесты, публикация на npm.

**Факт 4 — можно ли использовать существующий репозиторий как целевой?**
Частично да — и это предпочтительный вариант по простой причине: npm-пакет
`@animastor/gpu-hub@0.1.1` и consumers уже существуют, а bare-layout и GitHub-имя
совпадают с целевыми. Но для этого требуется **адаптация split-плана** (вариант A ниже).

**Факт 5 — что потеряется при замене его историей monorepo (§8.5).**
При `push --mirror`/filter-repo-push в тот же bare: (а) 43 коммита самостоятельной
истории будут затёрты (необратимо на GitHub после mirror; на VPS — только через
дополнительный archive-клон); (б) старые SHA из bare (`7c7778c`, `b95870f`,
GHCR workflow-фиксации) перестанут резолвиться — все ссылки (если есть) в
 issue/CI/деплой-скриптах сломаются; (в) ненулевой риск: активный post-receive
mirror при ошибке очередности шагов может вытолкнуть частичную/старую историю
в GitHub до завершения проверок.

### Вариант A — сохранить существующий GPU Hub — **✅ ВЫБРАН (SELECTED)**

1. Заархивировать состояние monorepo-пакета: тег/ветка в монорепо до filter-repo
   (`pre-split/packages-animastor-gpu-hub`).
2. В существующий bare добавить temporary-remote на monorepo-клон с фильтрованной
   `packages/animastor-gpu-hub`+`scripts/check-artifacts.sh`+`gpu-hub-rebuild.sh`+docs
   историей и **merge --allow-unrelated-histories** (или: импортировать только
   недостающие изменения файлов одним commit'ом поверх `7c7778c`).
3. Перенести root-layout → bare уже root-layout: новый Dockerfile собирается из
   артефактного контракта §2 (B5) — stager-Dockerfile монорепо в bare не переносится.
4. Бэкпорт: расширенный `tests/run-all.cjs` (305 строк), удаление `/worker-source`
   уже в monorepo-версии файлов.
5. Синхронизировать `refs/remotes/github/master` (mirror-push вручную после проверки).
6. filter-repo для gpu-hub из monorepo НЕ выполняется; §8.5 в части gpu-hub не применяется.

Плюсы: ничего не затирается; npm/GHCR-преемственность; hooks не пересоздаются.
Минусы: разрыв линейности «monorepo-история → репо» (история кода monorepo
останется только в архиве монорепо + §8.5-фильтрате, если его сделать отдельно);
нужен аккуратный merge/бэкпорт.

### Вариант B — заменить историей monorepo — **⛔ REJECTED / NOT SELECTED (НЕ ИСПОЛНЯТЬ)**

> **Отказ от исполнения.** Ни одна из команд ниже (mirror-backup с целью
> последующей перезаписи, заморозка `hooks/post-receive`, `filter-repo` §8.5,
> `push --force` / `push --mirror` в существующий bare/GitHub) **не должна
> выполняться**. R-3 = **A**; норматив — `repository-split-r3-decision.md`
> §1.1, §3.1. Текст ниже сохранён только как историческая запись.

1. `git clone --mirror` существующего bare в `/home/animastor/backups/animastor-gpu-hub-pre-split.git`
   (+ не забыть GitHub уже содержит то же).
2. Заморозить mirror-hook bare (переименовать `hooks/post-receive` до завершения
   всех шагов) — исключить случайный mirror-push.
3. filter-repo клон монорепо по §8.5 → push в bare (`--force`, заменяя `master`).
4. Полная верификация §6/§7 readiness → только потом вернуть hook → mirror в GitHub.
5. Результат: 43 коммита старой истории живут только в backup-клоне и GitHub-архиве.

Плюсы: точное соответствие §8.5, единая линейная история, полный `git log --follow`
по коду hub из monorepo. Минусы: старая история де-факто выводится из оборота;
SHA-ссылки ломаются.

**Решение принято: R-3 = A (SELECTED), B = REJECTED** —
`repository-split-r3-decision.md`.

- **A действует:** существующий `Animastor/animastor-gpu-hub` сохраняется
  без изменений; `filter-repo` для GPU Hub **не выполняется**; новый
  репозиторий **не создаётся**; force-push/overwrite/delete **запрещены
  бессрочно**; его standalone history (bare = GitHub = `7c7778c`, 43 коммита)
  **канонична**.
- **B помечен REJECTED / NOT SELECTED** и сохранён **только как историческая
  запись**. Всё, что в нём исполнимо (`filter-repo` §8.5, заморозка
  `hooks/post-receive`, `push --force` / `--mirror` в существующий bare),
  **запрещено**.
- Очередь filter-repo: **backend → web → android → worker** (шаг gpu-hub
  исключён из очереди навсегда, пока не появится новое письменное решение).

## 6. Единое правило ANDROID_WEB_PARITY (исполнение R-5)

Сверка трёх источников: prep plan §5 (ownership/механизм), §8.2/§8.3 (whitelists),
readiness §2.3/§5. Найденное расхождение: §8.3 переносит историю parity в android
(`--path ANDROID_WEB_PARITY.md`), readiness §2.3 говорит «история parity НЕ
переносится». Правило для исполнения (не требует менять документы):

1. **История**: whitelist §8.3 выполняется как написан — история parity-файла
   попадает в android (безвредно;§8.2 canonical — у web; обе копии editable
   только у владельца).
2. **Владение**: canonical = `ANDROID_WEB_PARITY.md` в корне **animastor-web**
   (§5 prep plan). Android содержимое не редактирует (кроме служебного
   колонтитула «snapshot of web@<commit>»).
3. **Актуализация**: android получает snapshot из репозитория animastor-web
   (fetch из VPS bare web — source of truth; GitHub — только mirror, §6) по
   **commit + sha256** файла; CI-авто-PR после появления CI (P5), до CI — ручной
   шаг android-релиз-чеклиста.
4. `docs/architecture/ANDROID_WEB_PARITY.md` (снимок 2026-08-21) — замороженный
   архив у web (и историческая копия у backend через `--path docs`).

## 7. Оставшиеся NO-GO conditions (актуальный список)

1. **filter-repo до FF `master`** (P2).
2. **filter-repo при невыполненном B5** — hub-Dockerfile монорепо не собирается
   из hub-репо; stager на Release-артефактах обязателен **до** filter-repo hub.
   **При R-3 = A `filter-repo` hub не выполняется → условие неприменимо;
   B5 остаётся пост-сплит требованием к самому hub-образу.**
3. **filter-repo при < ~3 GB свободно** (P6).
4. **filter-repo при G1–G5 не зелёных / без CI-workflows** (P5, B9) — для G4/G5.
5. **`filter-repo` gpu-hub — запрещён вовсе при R-3 = A** (§5, B = REJECTED);
   решение принято — `repository-split-r3-decision.md` §3.1.
6. **Прямой push из временного клона в GitHub** — запрещён §7.3 prep plan.
7. **npm publish при недействительном токене** (P3, E401).
8. **Изменение monorepo `post-receive` hook** (§7.2).
9. **Создание `Animastor/animastor-gpu-hub` заново** — репо существует.
10. **`push --mirror` / force в существующий gpu-hub bare или GitHub** —
    **запрещено бессрочно, без оговорок про backup/заморозку hook**: вариант B
    REJECTED, вариант A действует (`repository-split-r3-decision.md` §3.1).
11. **Удаление `backend/tests/architecture` dispositions без переноса** при filter-repo (§9 prep plan + закрытые R-2/R-4 — перенесённые части уже на npm-пути).

## 8. Точный порядок следующих действий перед первым filter-repo

1. **B5**: Release-артефакты (`worker-bundle-v2.1.1` от worker; тег `hub-artifacts-v1` — `hub-workflows-v1.zip`, `installer-src-v1.zip`, `install-manifests-v1.zip` от backend, каждый + sha256 в Release notes); pin-файл `packages/animastor-gpu-hub/artifacts.lock.json` ({source_repository, release_tag, asset_filename, version, sha256} × 4 группы); stager: скачивание assets + проверка sha256 ДО `COPY --from=stager`; локальная проверка G4 (standalone build hub из клона) и G5 (`check-artifacts.sh`).
2. **B9/P5**: workflows G1–G5 в монорепо-путях (owners: backend/web/worker/hub/android), зелёный прогон.
3. **P6**: освободить ≥3 GB.
4. **P2**: FF `master` до рабочей ветки (включая этот коммит) + push.
5. **P4-гигиена**: физически удалить пустой каталог `workflow.json` на VPS (untracked).
6. **R-3 — ВЫПОЛНЕНО**: вариант **A = SELECTED**, B = REJECTED
   (`repository-split-r3-decision.md`).
7. **P1 — ВЫПОЛНЕНО (2026-10-04)**: 4 пустых GitHub-репо (владелец, 2026-10-03)
   **+ 4 bare (`backend`, `web`, `android`, `worker`) + hooks + remote `github`**
   (0 refs/0 objects, `HEAD=refs/heads/main`, hook 0755/91 байт byte-identical);
   **push не выполнялся**; **для gpu-hub — ничего не создано**
   (репозиторий существует, R-3 = A).
8. **filter-repo** (очередь: **backend → web → android → worker**; **gpu-hub
   исключён — R-3 = A**) c override'ами readiness §9-6b (`workflow.json`,
   `local.properties` исключены) и parity-правилом §6; после каждого —
   §6/§7 readiness verification.
9. **Freeze монорепо → deployment cutover (B11)**.

---

## Самопроверка отчёта

- Физический split, filter-repo, новые bare/GitHub, force-push, mirror в gpu-hub,
  npm publish, releases, CI — не выполнялись.
- Контрактные документы (prep plan, execution readiness, final readiness) не менялись.
- Ни одного `file:` в tracked package.json; 5 mounts + workflow.json-mount удалены;
  root `package.json` удалён; worker bundle zero-dep не нарушен.
- Изменённые тесты покрывают только: npm-переход (B1/B2/B7/R-2/R-4), phase9c C7-инверсию
  (санкционировано §9 prep plan), phase10j TF-ассерт (следствие B7), dual-instance и
  version-pin фиксы. Новых требований не вводилось.

**FINAL STATUS: BLOCKED** — до B5, B9/P5, P2, P6, решения R-3 и создания
4 bare/GitHub-репо; исполнение самого decoupling-этапа (B1/B2/B3/B4/B6/B8/B12)
завершено и верифицировано.
