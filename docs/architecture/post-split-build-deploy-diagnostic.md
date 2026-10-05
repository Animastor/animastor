# Post-Split Build / Deploy Diagnostic (read-only)

> **Тип документа:** диагностический снимок, **read-only**. Ни один файл исходников,
> манифестов, lock-файлов или конфигов **не изменялся**. Все артефакты прогонов
> лежат вне репозиториев (`/tmp/diag/*.log`, `/tmp/diag/*.cjs`) и намеренно
> **не архивируются** в git.
>
> **Дата прогона:** 2026-10-05.
> **Ветка монорепо:** `c21.4-physically-extract-analysis-from-backend`.
> **Окружение:** `node v22.22.3`, `npm 10.9.8`, JDK 17 (OpenJDK 17.0.20.1),
> Gradle 8.12 (внешний, `/home/animastor/animastor/frontends/android/gradle-8.12/bin/gradle`),
> Linux, `/` 3.8G avail.
>
> **Предшественники по теме:** `repository-split-final-verification.md`,
> `repository-split-final-gate.md`, `repository-split-next-blockers.md`,
> `repository-split-post-split-audit.md`.

---

## 1. Scope и проверенные ревизии

Проверялись **standalone-репозитории** (не монорепо), клонированные в `/tmp/verify/*`,
плюс frozen-монорепо для контроля «до/после split».

| Репозиторий | Путь клона | HEAD `main` | Совпадает с `github/main` | Рабочее дерево |
|---|---|---|---|---|
| `animastor-backend` | `/tmp/verify/backend` | `98c4fbd6823c40420154c69e3fc2e02f273fe3de` | да | clean |
| `animastor-web` | `/tmp/verify/web` | `c7fe52ac3559456ebb1cc519c30151281941acbc` | да | clean |
| `animastor-worker` | `/tmp/verify/worker` | `618f87a67744802b7e7a0b33a0934ce48d414640` | да | clean |
| `animastor-android` | `/tmp/verify/android` | `254e2f084342fd69214b4a3a45dfb7b27df84e2f` | да | clean |

`git status --porcelain` = 0 строк во всех клонах и в рабочем дереве монорепо.
Клоны `/tmp/final/*` — read-only копии HEAD для сверки содержимого.

---

## 2. Сводная таблица

| Component | Build | Tests | Deploy | Errors | Warnings | Status |
|---|---|---|---|---|---|---|
| Backend | PASS (`npm ci` rc=0, 399 pkgs; Dockerfile `node:20-bookworm`) | **FAIL** rc=2 — 923 passing / 24 pending / 2 failing | **FAIL** — runtime `TypeError` на `book-routes.cjs:41`; `p-limit` не объявлен → `MODULE_NOT_FOUND` в prod-образе | 1 runtime (PRE-EXISTING), 1 prod-dep (PRE-EXISTING) | 8 npm deprecations | **FAIL** |
| gRPC / Protocol | N/A — gRPC в проекте отсутствует (0 совпадений по `*.proto`), фактический контракт — Job Protocol v2 | `npm run check:protocol` rc=0 | — | 0 | 0 | **PASS** |
| Worker | PASS (`npm ci` rc=0; `node --check` OK по `worker.cjs` и `job-protocol-v2.cjs`) | **PASS** 45/45, 0 fail (2 skip — parity/manifest, ожидаемо для standalone) | PASS (entrypoint без токена корректно отказывает) | 0 | 0 | **PASS** |
| Web | PASS (`build:packages` rc=0 — 13 пакетов; `vite build` rc=0, 404.92 kB / gzip 118.03, built in 1.62s) | **PASS** 201/201 в 15 файлах; `tsc --noEmit` rc=0 | **UNVERIFIED** — нет `vercel` CLI, `~/.vercel`, `vercel.json` | 0 | 0 (`npm ci` — 0 warnings) | **PASS WITH WARNINGS** |
| Android | PASS **только внешним Gradle 8.12**: `clean :app:assembleDebug --warning-mode all` rc=0, BUILD SUCCESSFUL in 1m48s, 0 warnings; APK 12 677 548 B. **`./gradlew` в клоне — exit 127** | тестов в standalone-репо нет | FAIL — `./gradlew` нерабочий; release невозможен (нет `release-key.jks`) | 1 (NEW, standalone-экспозиция) | 0 | **FAIL** |
| Vercel | — | — | **UNVERIFIED** — доступа нет | — | — | **UNVERIFIED** |
| npm packages (`@animastor/*`) | 27 scoped + 1 unscoped опубликованы; все 28 установленных пакетов проходят health-check `main`/`types`/`exports` | — | registry tarballs во всех 4 репо, ноль `file:`/`link:`/`workspace:` | 0 | version skew `vbook-runtime` 0.1.0/0.2.0; у `contracts@0.1.1` нет `types` | **PASS WITH WARNINGS** |

---

## 3. NEW ERRORS (экспозиция standalone-репозиториев)

### N-1. Android: `./gradlew` нерабочий в клоне

- **Где:** репозиторий `animastor-android`, `frontends/android/gradlew`
- **Команда:** `cd /tmp/verify/android/frontends/android && ./gradlew …`
- **Результат:** `exit 127` —
  `./gradlew: line 2: ./gradle-8.12/bin/gradle: No such file or directory`
- **Причина:** `gradlew` — стаб из двух строк (`./gradle-8.12/bin/gradle "$@"`).
  Ни `gradle-8.12/`, ни `gradle-wrapper.jar`, ни `gradle-wrapper.properties`
  **не отслеживаются git** ни в android-репо, ни в монорепо — стаб добавлен
  коммитом `9d6de986`. В монорепо каталог `gradle-8.12/` присутствует локально
  как неотслеживаемый, поэтому дефект замаскирован; в свежем клоне репозитория
  он проявляется.
- **Обход для проверки:** внешний Gradle 8.12 (см. §2, Android Build) — сборка
  проходит, т.е. блокер только в способе входа, не в коде приложения.

### N-2. Backend: `docker-compose.yml` ссылается на отсутствующий build-контекст

- **Где:** `animastor-backend`, `docker-compose.yml:114`
- **Блок:** сервис `gpu-hub` → `build: { context: ., dockerfile: packages/animastor-gpu-hub/Dockerfile }`
- **Причина:** build-контекст рассчитан был на монорепо. В standalone
  backend-репозитории `packages/` присутствует, но содержит только 15
  vendored-исходников (`animastor-ai-agent`, `ai-analysis`, `ai-connector`,
  `assistant`, `auth`, `comfyui-workflow-connector`, `contracts`, `editor`,
  `generation`, `installer`, `orchestration`, `parser`, `player`, `url-safety`,
  `vbook-runtime`). Отсутствуют как раз те два пути, которые нужны Dockerfile'у:
  `packages/animastor-gpu-hub/Dockerfile` и `packages/animastor-worker/worker/`
  (canonical worker bundle source, по комментарию в compose). Оба пакета
  опубликованы в npm (`@animastor/gpu-hub`, `@animastor/worker-dev` — второй
  `private: true`), но Dockerfile собирает **из исходников**, а не из registry.
- **Документированная митигация (присутствует в репо):**
  `docker/compose/overlay-gpu-hub-standalone.yml` — задаёт
  `image: ${GPU_HUB_IMAGE:?…}` (pinned digest) и `build: !reset null`.
  Использование: `docker compose -f docker-compose.yml -f docker/compose/overlay-gpu-hub-standalone.yml up`.
  Требует `POSTGRES_PASSWORD` в `.env` (проверка `docker compose config`).
- **Статус:** не дефект кода, а неполная документация standalone-пути в основном
  compose-файле. Комментарий над сервисом (`docker-compose.yml:105-110`) митигацию
  упоминает, но дефолтный `build:` остаётся ломаным.

---

## 4. NEW WARNINGS

- **W-1. Version skew `vbook-runtime`.** Backend ставит `@animastor/vbook-runtime@0.2.0`
  в корень `node_modules`, но опубликованные `ai-analysis`, `editor`, `player` тянут
  вложенные копии `0.1.0` (3 дубликата в `node_modules/*/node_modules/`). Риск
  дублирования экземпляров. На практике `npm ls` чист, backend стартует — но
  инвариант «единственный экземпляр runtime» не зафиксирован.
- **W-2. `@animastor/contracts@0.1.1` без `types`.** Манифест:
  `main: src/index.js`, `exports: { ".": "./src/index.js" }` — поле `types` отсутствует.
  Не блокер (все потребители — JS), но сломает typed-потребителей.
- **W-3. Backend `npm ci` — 8 deprecations.** `inflight@1.0.6`, `rimraf@3.0.2`,
  `glob@7.2.3` (×3), `glob@10.5.0`, `prom-client@15.1.3`, `uuid@8.3.2`. Не блокеры.
- **W-4. README-бейдж web «Vite-8» неверен.** Фактически vite 5.4.21
  (`vite@^5.4.0` в `package.json`); расхождение вводит в заблуждение при подборе плагинов.
- **W-5. Stale-комментарии после split.**
  - `backend/src/runtime/job-schema.js:13,17` — упоминает `file:../packages/animastor-contracts`
    и ручной symlink; фактически пакет ставится из registry.
  - `packages/animastor-ai-connector/README.md:209` — ссылка на старый
    `github.com/Animastor/animastor` (известный остаток **V-1 / P2**).
- **W-6. Мёртвый legacy-манифест worker.** `image/worker/package.json`:
  `name: "worker"`, `version 0.1.0`, `license "ISC"`, `main: worker.js` (файла нет),
  lock с `version: "1.0.0"` ≠ 0.1.0. Канонический пакет —
  `packages/animastor-worker` (`@animastor/worker-dev@2.1.1`, `private: true`).
  Ни кем не используется.
- **W-7. Bloat prod-зависимости.** Тесты backend глубоко импортируют
  `@animastor/gpu-hub/gpu-hub.js` и `@animastor/gpu-hub/bootstrap.js`
  (deep subpath — работает, пакет опубликован), но `src/` этого пакета не требует.
- **W-8. Не опубликованы:** `@animastor/ai-connector` (E404),
  `@animastor/comfyui-workflow-connector` (E404 — одноимённый **unscoped**
  `animastor-comfyui-workflow-connector@0.1.0` опубликован и используется backend'ом),
  `@animastor/worker` (E404), `@animastor/worker-dev` (E404, `private: true`).
  Ни один из них не потребляется standalone-репозиториями — не блокер.

---

## 5. PRE-EXISTING (не вызвано split'ом, не чинить в этом проходе)

### P-1. Backend runtime blocker — editor-шим

- **Где:** `backend/src/routes/book-routes.cjs:41`
  → `require('./editor/index.cjs')(app, redis, deps)`
- **Ошибка:** `TypeError: require(...) is not a function`
- **Причина:** `src/routes/editor/index.cjs` — шим
  `module.exports = require('@animastor/editor')`, а пакет экспортирует
  **объект** `{ createEditorModel, createEditorRoutes, createEntityCrudRoutes, createEditorPorts }`,
  а не функцию.
- **Воспроизводится идентично в frozen-монорепо** (`/home/animastor/animastor/backend`)
  → **PRE-EXISTING**, не следствие физического split'а.
- **Диагностический обход:** с preload-скриптом (`/tmp/diag/editor-shim-hack.cjs`,
  в репозиторий не попадал) backend поднимается — PG инициализирован,
  `Backend server running on port 3000`, runtime loop started.

### P-2. Backend prod blocker — `p-limit` не объявлен

- **Где:** `backend/src/services/agent/parallel-analysis-orchestrator.js:35` → `require('p-limit')`
- **Причина:** `p-limit` отсутствует и в `dependencies`, и в `devDependencies`
  (`git log -S 'p-limit' -- backend/package.json` пуст — и в standalone, и в монорепо,
  т.е. **никогда не был объявлен**). В lock `node_modules/p-limit@3.1.0` помечен
  `"dev": true` (транзитив от mocha/nyc); `npm ls p-limit --omit=dev` → `(empty)`.
- **Последствие:** локально `require` проходит на dev-транзите; в прод-образе
  (`backend/Dockerfile`: `npm install --omit=dev --ignore-scripts`) → `MODULE_NOT_FOUND`.

### P-3. Backend test failures (2 шт.)

`npm test` → `exit 2`, `923 passing / 24 pending / 2 failing`:

1. `IB-G15: package.json pins (main, bin, private)`
2. `T9: no dynamic/template/concat require or import() can reach orchestration from runtime/**`

Оба — известные pre-existing (см. `repository-split-final-verification.md`).
Syntax smoke из `pretest` проходит.

### P-4. Android: release-сборка невозможна

`release-key.jks` отсутствует и в клоне, и в монорепо. `app/build.gradle.kts`:
compileSdk/targetSdk 35, minSdk 24, versionCode 1 / versionName 0.1.0,
namespace `com.example.animastor`, `BASE_URL` default `https://app.animastor.in/`,
`isMinifyEnabled = false`.

---

## 6. BLOCKERS (итог)

1. **[PRE-EXISTING]** Backend runtime: `require('./editor/index.cjs')` возвращает объект,
   а не функцию → `TypeError` (`src/routes/book-routes.cjs:41`). Воспроизводится и в монорепо.
2. **[PRE-EXISTING]** Backend prod: `p-limit` не объявлен → `MODULE_NOT_FOUND`
   при `npm install --omit=dev` (актуально для Dockerfile/прод-образа).
3. **[NEW]** Android: `./gradlew` → `exit 127` в свежем клоне (нет `gradle-8.12/`, нет gradle-wrapper).
4. **[NEW]** Backend compose: `dockerfile: packages/animastor-gpu-hub/Dockerfile`
   отсутствует в standalone-репо (нужен overlay + `GPU_HUB_IMAGE`).
5. **[UNVERIFIED]** Vercel: нет CLI/токена/`vercel.json` — реальный deploy не проверен.
6. **[UNVERIFIED]** e2e `backend ↔ worker` не запускался (нужен живой GPU Hub / GPU / ComfyUI).

---

## 7. Проверенное зелёное (для опоры при следующем проходе)

- **Backend install:** `rm -rf node_modules && npm ci` → `exit 0`, 399 пакетов.
  Все 14 `@animastor/*` + `animastor-comfyui-workflow-connector` резолвятся из
  `https://registry.npmjs.org/…tarball`; **ноль** `file:`/`link:`/`workspace:`
  во всех 4 репо (проверено grep'ом по каждому `package.json`).
  `npm ls --depth=0` чист (нет invalid/missing/extraneous).
- **TypeScript в backend отсутствует by design** (`tsconfig.json` нет).
- **Deep imports покрыты exports-картой** `@animastor/vbook-runtime@0.2.0` (20 subpaths).
- **Job Protocol v2:** `npm run check:protocol` → `exit 0`,
  «worker bundle copy is in sync with @animastor/contracts».
  Bundled `worker/job-protocol-v2.cjs` (GENERATED, sha256 `b005fafc…`, snapshot 0.1.1)
  совпадает с установленным `contracts@0.1.1` (`PROTOCOL_VERSION = 2`).
  Backend тоже на `contracts@0.1.1`.
- **Worker:** `npm ci` → `exit 0` (1 пакет из registry); `npm test` → 45/45.
  Entrypoint без креденшела корректно завершается с
  «Worker authentication failed — check ANIMASTOR_WORKER_TOKEN» — скрытой
  зависимости от монорепо нет. `docker/worker/Dockerfile` самодостаточен
  (`node:22-bookworm-slim`, `WORKDIR /home/animastor`, копирует свой `entrypoint.sh`).
- **Web:** `.npmrc` с `legacy-peer-deps=true` **обязателен** (vite@^5.4.0 vs
  vitest@^4.1.10, peer `vite ^6||^7||^8`; в комментарии — падение arborist `edgesOut`).
  `npm ci` → 227 пакетов, **0 warnings**. Все 13 `@animastor/web-*` из registry tarballs,
  `npm ls` чист. `build:packages` использует npm-путь (не sibling), tsup 8.5.1,
  dist + DTS собраны. Deep imports `@animastor/*/sub` в `src` — 0.
  Preact не дублируется (единственная копия 10.29.8; 6 web-пакетов объявляют
  peer `preact >=10.5.0`; `vite.config.ts` содержит `resolve.dedupe` для preact).
- **Android:** сборка внешним Gradle 8.12 — `BUILD SUCCESSFUL`, 0 warnings/deprecations.
  `local.properties` (gitignored) → `sdk.dir=/home/animastor/Android/Sdk`.
- **npm health:** скрипт проверил `main`/`types`/`exports` всех 28 установленных
  пакетов — все `ok` (все указанные файлы существуют).

---

## 8. Побочные эффекты прогона (для чистоты состояния)

- `node src/backend.cjs` подключился к **живому** Postgres (`PG_HOST` default `localhost`,
  контейнер `animastor-pg` на `localhost:5432`, healthy) и выполнил
  идемпотентные startup-миграции — все сообщения «already initialized»,
  изменений данных **не было**.
- Redis-подключения падали с `ECONNREFUSED 64.190.63.222:6379`: хост `redis`
  резолвится через внешний DNS (webhostbox), локального docker DNS в этой сети нет.
  Это ограничение окружения, а не дефект конфигурации репозитория.
- Ничего в `node_modules/`, `build/`, `dist/`, `.gradle/` не отслеживается git
  и не попало в коммиты.

---

## 9. Команды для перепроверки

```bash
# §1 revisions
for r in backend web worker android; do
  git -C /tmp/verify/$r rev-parse HEAD
  git -C /tmp/verify/$r status --porcelain | wc -l
done

# §2 backend
cd /tmp/verify/backend/backend
rm -rf node_modules && npm ci                                   # rc=0
npm ls --depth=0                                                # чист
npm test                                                        # rc=2 (P-3)
node src/backend.cjs                                            # rc=1 (P-1)

# §2 gRPC/protocol + worker
cd /tmp/verify/worker/packages/animastor-worker
npm ci && npm test && npm run check:protocol                    # rc=0 / 45 pass / rc=0
node --check worker/worker.cjs && node --check worker/job-protocol-v2.cjs

# §2 web
cd /tmp/verify/web/frontends/app
npm ci                                                          # rc=0, 0 warnings
npm run build:packages && npm run typecheck && npm test && npm run build

# §2 android (внешний Gradle 8.12)
cd /tmp/verify/android/frontends/android
./gradlew --version                                             # exit 127 (N-1)
/home/animastor/animastor/frontends/android/gradle-8.12/bin/gradle \
  -p . clean :app:assembleDebug --warning-mode all               # rc=0 (обход N-1)

# §3 N-2 compose
grep -n -A3 'gpu-hub:' /tmp/verify/backend/docker-compose.yml
ls /tmp/verify/backend/packages/animastor-gpu-hub         # No such file → N-2
ls /tmp/verify/backend/packages/animastor-worker         # No such file → N-2
cat /tmp/verify/backend/docker/compose/overlay-gpu-hub-standalone.yml
```

---

## 10. FINAL

**FINAL: FAIL**

Основание — блокеры §6.1–§6.4 (два из них — pre-existing, два — экспозиция
standalone-репозиториев). Зелёные прогоны (install, web 201/201, worker 45/45,
android assemble, protocol sync, npm health) подтверждают, что **публикация
`@animastor/*` и физический split сами по себе выполнены корректно**; блокеры
лежат в слоях, которые split не покрывал.

Отдельная оговорка: Vercel и e2e `backend ↔ worker` не проверены (нет доступа /
нет живой GPU-инфраструктуры) — их статус не может считаться ни PASS, ни FAIL.