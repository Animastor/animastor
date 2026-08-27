# Private GPU Worker Installer — Frontend Integration Proposal

> **Status:** Phase 3 (Backend Setup Contract) **implemented**; Web/Android UI — не изменялись
> **Date:** 2026-08-27
> **Scope:** Web frontend (priority 1), Android frontend (priority 2), общий backend contract.
> **API reference (Phase 3):** `docs/04-planning/private-worker-setup-contract-api.md`
> **Companion docs:**
> - `docs/04-planning/private-worker-installer-architecture.md` — installer architecture (Phase 1/1.5)
> - `docs/04-planning/private-worker-installer-phase15.md` — existing ComfyUI, workflows, runtime modes
> - `docs/04-planning/private-worker-installer-e2e-acceptance.md` — Phase 2 acceptance status
> - `docs/architecture/EXPERIMENTAL_BETA_WORKER_SETUP.md` — текущая (устаревающая) инструкция
> - `docs/architecture/LINUX_INSTALLER_RECONNAISSANCE.md` — reconnaissance одноимённого installer'а
>
> Разделы §1–§15 — исходный proposal. Итоговый backend contract, реализованный
> в Phase 3, зафиксирован в §16 и в отдельном API-документе. UI-задачи
> (Web/Android) идут отдельными фазами поверх реализованного контракта.

---

## 0. Executive summary

Сегодня оба фронта (Web и Android) показывают пользователю **старую модель**:
«скачай один файл `worker.cjs` → вставь Worker Key → запусти `node worker.cjs`».
Эта модель больше не соответствует реальности:

- worker состоит из **6 файлов** (`worker.cjs`, `worker-cleanup.cjs`,
  `worker-cleanup-journal.cjs`, `package.json`, `package-lock.json`, `.env.example`);
  `worker.cjs` делает `require('./worker-cleanup.cjs')` и
  `require('./worker-cleanup-journal.cjs')` — установка одного файла **сломана**;
- в репозитории существует новый **Installer** (`backend/src/installer/`,
  CLI `animastor-installer`, фазы 1–2.1), который автоматизирует весь путь:
  profile → ComfyUI → dependencies → models → workflows → worker → key → verification;
  но он **не имеет HTTP-поверхности** и фронтам неизвестен;
- hub отдаёт только `worker.cjs` (`GET /gpu/worker-source`) — остальных файлов
  bundle'а и baseline workflows через API не получить.

Предложение: ввести единый для Web и Android **Setup Contract** — набор
backend endpoints, отдающих UI-safe метаданные (profiles, installation methods,
installer/uninstaller artifacts, instructions, worker status), и перестроить
экран Private Workers вокруг двух сценариев (**Managed GPU Server** и
**Existing Local ComfyUI**). Frontend объясняет «что делать», Installer делает
«как». Frontend не хардкодит ни версии installer'а, ни команды, ни списки файлов —
всё приходит из backend metadata. Ключевая новая абстракция —
**Installation Method / Platform** (§15), чтобы Linux-инсталлер не стал
единственным предполагаемым путём, а Windows/Docker добавлялись без переписывания UI.

---

## 1. Current Web flow

**Route:** `/settings/private-workers` → `frontends/app/src/main.tsx:47` →
`pages/SettingsPage.tsx:33` → `features/workers/PrivateWorkersSection.tsx:23`.
Стек: Preact + preact-router + @preact/signals (не React), Vite.

**UX сегодня:**
- Список workers: имя, статус-пилл (ONLINE/OFFLINE/REVOKED), тип
  (audio/image/video), «Last seen: …», кнопки Rotate/Revoke.
- OFFLINE-строки: раскрывающийся `<details>` «Worker still OFFLINE?» с 4 подсказками.
- **Add Worker** (модал): имя + `<select>` типа (audio/image/video, default audio).
  Понятия «профиль установки» нет — только worker_type.
- После create/rotate — модал **CredentialDisclosure**
  (`PrivateWorkersSection.tsx:228`): warning, токен в `<code>` (показывается
  один раз), кнопка Copy, **5 шагов инструкции**, prerequisites (3 пункта),
  копируемый env-блок (4 переменные) и «Done».

**Данные и API** (`features/workers/privateWorkers.ts`, `PrivateWorkersSection.tsx`):

| Endpoint | Метод | Где | Использование |
|---|---|---|---|
| `/api/v1/workers` | GET | `PrivateWorkersSection.tsx:40` | список (name, status, worker_type, last_seen) |
| `/api/v1/workers` | POST `{name, worker_type}` | `:55` | `worker` + одноразовый `token` |
| `/api/v1/workers/:id/rotate` | POST | `:73` | новый одноразовый `token` |
| `/api/v1/workers/:id` | DELETE | `:90` | revoke |

Косвенно: `GET /api/v1/worker/counts` (GeneratePage, poll 5 с; SettingsPage
WorkerSection) — агрегированные счётчики, включая `private_*`.

**Инструкция генерируется клиентом** — `buildSetupContract`
(`privateWorkers.ts:105-132`): `HUB_URL=${origin}/gpu`,
`downloadCommand: curl -o worker.cjs ${HUB_URL}/worker-source`,
`runCommand: node worker.cjs`, env-блок `HUB_URL / ANIMASTOR_WORKER_TOKEN /
WORKER_TYPE / WORKER_ID`. Тексты шагов — в `i18n.ts` (RU: 124–178, EN: 646–700).

**Worker Key:** вводится пользователем вручную на GPU-машине (в UI поля ввода
нет); показывается один раз; хранится только в transient state модала,
обнуляется по Done/close; в localStorage/URL не попадает.

**Статус:** только ONLINE/OFFLINE/REVOKED + last_seen. Загрузка данных —
однократная при mount; **polling'а на экране нет** (статус сам не обновляется).

**Профили/скачивание:** выбора install-профиля нет; скачивание — только
copy-paste `curl`-команда (кликабельной кнопки нет; ключ i18n
`worker_download_label` определён, но не используется).

---

## 2. Current Android flow

**Путь:** Settings → «Private Workers» (`fragment_settings.xml:181-206`) →
`PrivateWorkersFragment.kt` (506 строк). Стек: классические Views + Fragments
(не Compose), Retrofit + Gson (`network/RetrofitClient.kt`, все endpoint'ы в
`repository/BackendApi.kt`), base URL из `BuildConfig.BASE_URL`
(default `https://app.animastor.in/`), cookie-auth (`PersistentCookieJar`).

**UX — зеркало Web** (осознанный parity, комментарии «web parity: i18n worker_*»):
тот же список, Add-диалог (имя + Spinner типа), тот же one-time disclosure
диалог (warning → токен + Copy → 5 шагов → prerequisites → env-блок + Copy →
Done; `PrivateWorkersFragment.kt:334-455`). Отличия минимальны:
- troubleshooting-блок всегда развёрнут inline (без title);
- у диалога нет заголовка (`worker_created_title` определён, но не используется);
- ошибка копирования молча игнорируется (`worker_copy_failed` не используется);
- модель `PrivateWorker` без `capabilities`; `GET /workers/:id` не вызывается
  (модель `PrivateWorkerDetailResponse` существует, но unused).

**Контракт инструкции** — `BetaSettingsHelpers.kt:127-162`: тот же
`curl -o worker.cjs $hubUrl/worker-source`, `node worker.cjs`, тот же env-блок.
Тесты-фиксаторы: `BetaSettingsHelpersTest.kt:154-176`
(хардкодят `https://app.animastor.in/gpu/worker-source`).

**Тексты:** `res/values/strings.xml:526-578` (EN) и `values-ru/strings.xml:503-555`
(RU) — ключи и формулировки идентичны Web.

**Worker Key / статус / polling:** идентичны Web (показ один раз, не
персистируется, статус ONLINE/OFFLINE/REVOKED + last_seen, загрузки раз при
открытии экрана достаточно; polling только `worker/counts` в Generate/WorkerSettings).

**Вывод:** Android flow отличается от Web только презентацией. Оба фронта
реализуют одну и ту же старую модель; новый installer не знает ни один из них.

---

## 3. Current backend API

### 3.1 Private Worker management — `backend/src/routes/worker-routes.cjs`

Auth: сессия пользователя + `userWorkspaceGuard` (гости — 403, workspace
всегда резолвится сервером).

| Endpoint | Назначение | Ответ |
|---|---|---|
| `POST /api/v1/workers` | создать worker (`name`, `worker_type: audio\|image\|video`, `mode: private\|share`) | `201 { worker: PublicWorker, token }` — **token одноразово** |
| `GET /api/v1/workers` | список workers workspace'а | `{ workers: PublicWorker[] }` |
| `GET /api/v1/workers/:id` | детали одного | `{ worker: PublicWorker }` (фронтами не используется) |
| `POST /api/v1/workers/:id/rotate` | ротация credential | `{ worker, token }` — старый token умирает сразу |
| `DELETE /api/v1/workers/:id` | revoke (soft delete) | `{ revoked: true }` |
| `POST /api/v1/worker/verify` | **worker-side**: проверка credential при старте (Bearer `wrk.…`), трогает `last_seen` | `{ verified, worker_id, name, worker_type, mode, workspace_id }` |

`PublicWorker`: `{ worker_id, workspace_id, name, worker_type, capabilities,
mode, status: ONLINE|OFFLINE|REVOKED (derived), token_prefix, last_seen,
revoked_at, created_at }`. Сырой PG-столбец `status` и `token_hash` наружу не
отдаются. Admin-вариант для SYSTEM-workers: `admin-routes.cjs:186-261`.

### 3.2 Статус/счётчики — `generation-routes.cjs`

- `GET /api/v1/worker/status` — публичный, только liveness system/share-пула
  (private не светятся), `heartbeat_ttl_sec: 30`.
- `GET /api/v1/worker/counts` — сессионный, включает `private_*`-поля для
  собственных workers вызывающего.

### 3.3 GPU Hub — `gpu-hub/gpu-hub.js` (прокси `/gpu`, порт 5000)

Worker-facing auth: Bearer `wrk.…` против Redis-mirror `animastor:worker-auth`
(fail-closed). Backend-facing: `x-api-key`.

| Endpoint | Auth | Назначение |
|---|---|---|
| `POST /gpu/beacon` | worker | heartbeat/регистрация: `{gpu, vram, version, image_tag, protocol_version=2}`; пишет heartbeat key (TTL 30 с) и GPU registry | 
| `POST /gpu/task` | api-key | постановка задачи backend'ом |
| `GET /gpu/task/next` | worker | mode-scoped pop (private → очередь своего workspace) |
| `POST /gpu/task/result`, `/gpu/task/error` | worker, только claimer | результаты/ошибки → callback в backend |
| `GET /gpu/worker-source` | публичный | **только `worker.cjs`** (ro-mount `worker/worker/worker.cjs`, `docker-compose.yml:110-112`) |
| `GET /gpu/health` | публичный | глубины очередей, running, gpus |

### 3.4 Worker Key lifecycle (фактический)

- Формат `wrk.<worker_id_b64url>.<secret_b64url>` (32 байта random).
- PG хранит только `SHA-256(secret)` (`workers.token_hash`, UNIQUE) + маску
  `token_prefix`; plaintext возвращается **один раз** в create/rotate ответе.
- Redis mirror (`animastor:worker-auth`) — горячий путь для hub'а; sync при
  старте + каждые 5 мин (`services/worker-auth.js`).
- Валидация: backend `requireWorkerAuth` (timing-safe, fail-closed); hub —
  mirror + worker_id cross-check. Worker без валидного токена не стартует
  (`worker.cjs:697-709`, fail-closed).

### 3.5 Installer (новый) — `backend/src/installer/`

CLI-only (`bin: animastor-installer`, `backend/package.json:6-8`). Команды:
`detect`, `plan --profile P`, `install --profile P [--yes] [--dry-run]
[--mode managed|existing|shared] [--root] [--worker-dir] [--hub-url]]`,
`verify`, `resume`. Модули: `install-manifest.js` (загрузка/валидация
манифестов), `compatibility-resolver.js` (required ∪ installed →
missing/incompatible/unused/unknown; modes managed/existing/isolated/shared),
`install-plan.js` (12 шагов: detect-gpu → detect-comfyui → detect-runtime →
select-profiles → resolve-dependencies → comfyui-update → custom-nodes →
models → workflows → worker-setup → worker-key → verify), `download-planner.js`,
`safety-rules.js` (NEVER_AUTOMATIC-операции, redaction), `verification-report.js`
(PASS/WARN/FAIL), `workflow-artifacts.js` (editable-baseline, никогда не
перезаписывает пользовательские копии), `engine/*` (исполнение: idempotent,
resumable, dry-run, секреты только через secretProvider).

**Манифесты:** `backend/ai/install-manifests/{audio/qwen-tts, image/qwen-image,
video/ltx-2.3}.json` — все `status: "draft"`, ревизия `2026.08.26-r2`.
Содержат: runtime requirements (comfyui/python/torch/nodejs/nvidia_driver),
dependencies (custom_node/model/model_repo/python_package c basis-таксономией),
workflows (policy `editable-baseline`, `baseline_sha256`), `worker_bundle`
(6 файлов, env required/secrets), verification, disk_budget
(image ≈21.2 GiB, audio ≈8.4 GiB, video ≈29.8 GiB).
**VRAM-минимумы неизвестны** (`gpu_min_vram_gb: null` во всех трёх);
источники моделей большей частью не исследованы (`repository: null` →
installer честно репортит BLOCKED, а не выдумывает URL).

**HTTP-поверхности у installer'а нет**: ни profiles, ни manifests, ни
install-plan, ни instructions через API не отдаются. Манифесты ссылаются на
`GET {HUB_URL}/workflow/<id>` — **этого endpoint'а в hub'е не существует**.

### 3.6 Worker bundle (фактический состав установки)

`worker/worker/`: `worker.cjs` (v2.0.0, Node 20+), `worker-cleanup.cjs`,
`worker-cleanup-journal.cjs`, `package.json`/`package-lock.json` (dep:
node-fetch@3), `.env.example` (required: `HUB_URL`, `ANIMASTOR_WORKER_TOKEN`,
`WORKER_TYPE`, `WORKER_ID`). Операционные скрипты: `worker/start-worker.sh`
(ставит Node 18 при <18 — конфликт с Node 20+ требованием worker.cjs),
`worker/start-video.sh` (полный provisioning ComfyUI v0.27.0 + torch cu124),
`worker/bootstrap-*.sh`, `worker/fix-nodes-*.sh`.

### 3.7 Workflows (delivery)

Production: workflow JSON **не живёт на GPU-машине** — backend подставляет
шаблон per-task и доставляет через hub в `task.params`
(`runtime/gpu-dispatcher.js`). Baseline-копии на машине — артефакт installer'а
для локального редактирования/offline (Phase 1.5), источник: repo checkout
(`backend/ai/workflows/*.json`) или (будущий) hub endpoint.

---

## 4. Устаревшие места (old instruction inventory)

Старая модель «Worker → один файл → Worker Key» присутствует в следующих местах:

| # | Где | Что именно | Действие |
|---|---|---|---|
| 1 | `frontends/app/src/app/i18n.ts:662-668` (EN), `:134-148` (RU) | `worker_setup_step_1`: «Download worker.cjs (one self-contained file; only Node.js 20+ is required)»; `worker_source_label`: «The worker file is served by the GPU Hub: GET {0} (worker.cjs … worker/worker/worker.cjs)»; prerequisites Node 20+/ComfyUI/models | **Заменить** динамической инструкцией из backend (§6.5). Не переписывать текст вручную — убрать источник правды из frontend'а |
| 2 | `frontends/app/src/features/workers/privateWorkers.ts:105-132` | `buildSetupContract`: `curl -o worker.cjs …/worker-source`, `node worker.cjs`, env-блок | **Заменить** на потребление setup-contract API; оставить env-блок (имена переменных не меняются) |
| 3 | `frontends/app/src/features/workers/privateWorkers.test.ts:85-132` | Тесты-фиксаторы старой команды | Переписать под новый контракт |
| 4 | `frontends/android/.../res/values/strings.xml:542-548,553-555` и `values-ru/strings.xml:519-536` | Те же 5 шагов и prerequisites | **Заменить** (зеркально Web) |
| 5 | `frontends/android/.../ui/BetaSettingsHelpers.kt:127-162` | `buildSetupContract` (идентичен web) | **Заменить** |
| 6 | `frontends/android/.../test/.../BetaSettingsHelpersTest.kt:154-176` | Фиксаторы `curl … app.animastor.in/gpu/worker-source` | Переписать |
| 7 | `docs/architecture/EXPERIMENTAL_BETA_WORKER_SETUP.md` §2 | «The worker is a **single self-contained file**: worker.cjs» — уже неверно (worker требует cleanup/journal-файлы + npm dep) | **Переписать** под новую модель после готовности новой UX; до этого — пометить «outdated, см. новый setup» |
| 8 | `gpu-hub/gpu-hub.js:1047-1060` + `docker-compose.yml:110-112` | `GET /gpu/worker-source` отдаёт только `worker.cjs` | **Расширить** до полного bundle'а (§7) — иначе ручная установка по-прежнему сломана |
| 9 | `frontends/app/dist/assets/index-BpTKW-lQ.js` | Старый прод-бандл со старыми строками | Пересоберётся при реализации (не отдельное действие) |

Что **не** удаляем и что заменяем динамической информацией:
- env-имена (`HUB_URL`, `ANIMASTOR_WORKER_TOKEN`, `WORKER_TYPE`, `WORKER_ID`) —
  стабильный worker protocol; остаются, но показываются из backend-контракта.
- Worker Key warning/one-time-disclosure — остаётся (модель корректна).
- Troubleshooting-подсказки — остаются, но дополняются installer-диагностикой.
- Всё, что описывает «какие файлы куда положить» — **удаляется** из фронтов и
  становится ответственностью installer'а.

Дублирование: инструкция существует в **4 независимых копиях** (Web i18n RU/EN,
Web code constants, Android strings RU/EN, Android helpers) + doc. Целевая
модель — один источник (backend setup contract), фронты только рендерят.

---

## 5. Proposed UX

### 5.1 Принципы

1. **Frontend объясняет «что делать», Installer/backend делают «как».**
   Пользователь не проходит технические шаги вручную там, где installer
   способен сделать их сам.
2. Экран остаётся одним: **Settings → Private Workers** (Web route и Android
   фрагмент не меняются), но внутренний flow перестраивается.
3. UI рендерится из backend metadata (§6): нет per-OS захардкоженных страниц,
   нет хардкода версий/файлов/команд.

### 5.2 Целевой экран (оба фронта)

```
Settings → Private Workers
├── My workers (существующий список: status pill, type/profile, last seen)
│     row actions: Details | Rotate key | Revoke
│     + Management block (§15.7): Repair/Reinstall | Uninstall
└── [Add Worker] → Setup Wizard
      Step 1  Choose profile(s):  Image / Video / Audio   (multi-select; ≥1)
      Step 2  Installation method:
                • Managed GPU server  (E2E / RunPod / Vast / Docker / VM)
                • Existing local ComfyUI
      Step 3  Platform: Linux (installer available) / Windows (coming soon) / Docker
      Step 4  Install: одна команда/ссылка на installer (из backend metadata)
      Step 5  Worker Key: create worker → показать key один раз →
              «installer спросит его на GPU-машине» (или copy)
      Step 6  Verification: статус Installing → Connecting → Online;
              инструкция «вернитесь сюда — статус обновится сам»
```

### 5.3 Scenario A — Managed GPU Server

Пользователь: чистый инстанс E2E Networks / RunPod / Vast / Docker / VM.
- Выбирает профиль(и) → метод «Managed» → платформу.
- Frontend показывает **актуальную** команду запуска installer'а (из
  `GET …/setup/installer`, §6.4): например,
  `curl -fsSL https://<origin>/gpu/installer | bash -s -- --profile image/qwen-image`
  или ссылку на download + контрольную сумму. Никаких «скачай файл X и
  положи в каталог Y».
- Installer на машине сам: GPU detect → ComfyUI → torch/deps → nodes → models →
  workflows → worker bundle → интерактивно спрашивает Worker Key → verify.
- Frontend показывает disk budget (из манифеста: image ≈21 GiB, video ≈30 GiB)
  и известные требования; VRAM-минимум — когда появится в манифестах (сейчас
  unknown, §14 Q2).

### 5.4 Scenario B — Existing Local ComfyUI

Баннер в wizard'е: **«Уже установлен ComfyUI? Используйте Existing ComfyUI mode.»**
- Команда та же, с `--mode existing` (installer сам определяет ComfyUI, Python,
  Torch, CUDA, GPU, custom nodes, models, workflows и предлагает только
  недостающее; никогда не удаляет/понижает/заменяет автоматически —
  `safety-rules.js`).
- Frontend не просит пользователя вручную копировать технические файлы:
  worker bundle installer кладёт сам (из repo или hub, `engine/worker.js:30-74`).
- Конфликты версий (ComfyUI новее/старее pin'а, несовместимый torch) installer
  решает интерактивными prompts'ами на GPU-машине; frontend лишь объясняет, что
  решения принимаются там, и показывает потом результат verification.

### 5.5 Worker status model (Settings)

Предлагаемые состояния UI и их маппинг на то, что backend умеет уже сегодня:

| UI state | Источник сегодня | Источник в будущем |
|---|---|---|
| **Not configured** | worker не создан | — |
| **Installing** | нет сигнала (см. §14 Q5) | installer check-in endpoint (опционально) |
| **Configured** | создан, `last_seen == null` | + install-state |
| **Connecting** | создан, ещё нет heartbeat | — |
| **Online** | `status == ONLINE` | + детали из heartbeat payload |
| **Offline** | `status == OFFLINE`, `last_seen != null` | — |
| **Error** | нет сигнала | worker error reporting / verification FAIL |
| **Requires attention** | нет сигнала | verification WARN / stale version |
| Revoked | `status == REVOKED` | — |

Online-детали (когда доступны): GPU/VRAM — из beacon payload hub'а
(`gpu, vram, version, image_tag, protocol_version`); сегодня эти поля **не
отдаются** user-API — нужен небольшой extension (§6.3).

Problem UX (offline/error):
```
Worker offline
Last seen: 2 h ago
[View diagnostics]  [Reinstall]  [Copy troubleshooting info]
```
Diagnostics — без secrets (token никогда; только token_prefix).

### 5.6 Error UX (installer errors)

Installer уже генерирует человекочитаемые resolution-отчёты
(`compatibility-resolver.js`, `verification-report.js`). Frontend-принципы:
- показывать структурированную ошибку (Required X / Detected Y) + действия
  ([Update runtime] [Keep current] [Cancel] — решения, которые installer и так
  спрашивает на GPU-машине; frontend не дублирует интерактив, а объясняет, где
  он происходит);
- «Missing model: …» + [Download] — только когда источник подтверждён
  (installer BLOCKED при `repository: null` — frontend показывает «source not
  yet available», а не фейковый download);
- stack traces обычному пользователю не показываются; «Copy troubleshooting
  info» копирует redacted-сводку (по `SECRET_NAMES` из `safety-rules.js`).

---

## 6. Proposed backend contract

Текущего API достаточно для управления workers, но **недостаточно** для setup
flow. Предлагаются минимальные дополнения (все — под той же сессией +
`userWorkspaceGuard`, что и `/api/v1/workers`; guest — 403). Ничего из
перечисленного не реализовывать сейчас.

### 6.1 `GET /api/v1/workers/setup/profiles`

- **Purpose:** UI-safe список install-профилей (не внутренний манифест целиком).
- **Request:** query `?type=image|video|audio` (опц.).
- **Response:**
  ```jsonc
  { "profiles": [{
      "id": "image/qwen-image", "worker_type": "image",
      "display_name": "Qwen Image", "description": "…",
      "status": "draft",                    // draft | stable
      "disk_budget_bytes_approx": 22780911288,
      "gpu_min_vram_gb": null,              // пока unknown — frontend показывает «unknown»
      "workflows": [{ "id": "workflow:img-qwen-image", "display_name": "…" }],
      "modes": ["managed", "existing", "shared"],
      "dependencies_summary": { "models": 4, "custom_nodes": 1, "approx_bytes": … }
  }] }
  ```
- **Auth:** user session. **Sensitive fields:** нет (внутренние source URL'ы
  моделей, checksum'ы, repo paths — НЕ отдавать).
- **Источник:** `install-manifest.loadAllManifests()` + projection.
- **Web:** wizard Step 1. **Android:** то же.

### 6.2 `GET /api/v1/workers/setup/methods`

- **Purpose:** доступные installation methods/platforms (§15) — основа
  platform-agnostic UI.
- **Response:**
  ```jsonc
  { "methods": [
    { "platform": "linux", "arch": "x86_64",
      "installer":  { "available": true,  "version": "1.2.0", "channel": "…" },
      "uninstaller":{ "available": true,  "version": "1.0.1" },
      "supported_profiles": ["image/qwen-image","audio/qwen-tts","video/ltx-2.3"],
      "minimum_requirements": { "node": "20", "os": "Ubuntu 22.04+" } },
    { "platform": "windows", "installer": { "available": false, "status": "planned" }, … },
    { "platform": "docker",  "installer": { "available": false, "status": "planned" }, … }
  ] }
  ```
- **Auth:** user session. **Sensitive:** нет.
- **Web/Android:** wizard Step 2–3, availability-бейджи (§15.8).

### 6.3 `GET /api/v1/workers/:id/status` (расширение существующего `GET /:id`)

- **Purpose:** детали для Online-карточки и diagnostics.
- **Response (добавить к PublicWorker):**
  ```jsonc
  { "worker": { …, "details": {
      "gpu": "NVIDIA L40S", "vram_gb": 46, "worker_version": "2.0.0",
      "protocol_version": 2, "current_job": true|false, "image_tag": "…" } } }
  ```
  (из heartbeat payload hub'а; при отсутствии heartbeat — `details: null`).
- **Sensitive:** никаких токенов; `token_prefix` уже отдаётся.
- **Web:** worker details/diagnostics. **Android:** то же.

### 6.4 `GET /api/v1/workers/setup/installer`

- **Purpose:** installer/uninstaller metadata + download (единая точка
  дистрибуции, §7). Query: `?platform=linux&arch=x86_64&profile=…`.
- **Response:**
  ```jsonc
  { "platform": "linux",
    "installer": { "version": "1.2.0",
      "command": "curl -fsSL https://<origin>/gpu/installer.sh | bash",
      "download_url": "https://<origin>/gpu/installer/animastor-installer-1.2.0.tar.gz",
      "sha256": "…", "release_notes": "…" },
    "uninstaller": { "version": "1.0.1", "download_url": "…", "sha256": "…" },
    "worker_bundle": { "version": "2.0.0",
      "download_url": "https://<origin>/gpu/worker-bundle",   // полный bundle, §7
      "files": ["worker.cjs","worker-cleanup.cjs","worker-cleanup-journal.cjs",
                 "package.json","package-lock.json",".env.example"] } }
  ```
- **Auth:** user session для metadata; сами артефакты могут быть публичными
  (как нынешний `/gpu/worker-source`) — решение в §7.
- **Sensitive:** нет. **Web:** wizard Step 4 + Management block.
  **Android:** copy command / open link.

### 6.5 `GET /api/v1/workers/setup/instructions`

- **Purpose:** серверная сборка инструкции (единый источник правды вместо 4
  копий в фронтах). Query: `?profile=…&platform=…&mode=managed|existing`.
- **Response:** структурированные шаги (title, body, code blocks, links) —
  те же 6 шагов wizard'а, но сгенерированные из manifests + installer metadata.
- **Auth:** user session. **Sensitive:** инструкция не содержит token
  (placeholder `ANIMASTOR_WORKER_TOKEN=<your-worker-key>`).
- **Web/Android:** рендерят шаги; при недоступности endpoint'а — fallback на
  текущий локальный контракт (миграция, §11).

### 6.6 Hub-дополнения (`gpu-hub/gpu-hub.js`)

| Endpoint | Назначение | Статус |
|---|---|---|
| `GET /gpu/worker-bundle` (или расширение `/worker-source`) | полный 6-файловый bundle (tar.gz или per-file) | **нужен** — нынешний single-file сломан |
| `GET /gpu/workflow/:id` | baseline workflow download | **нужен** — манифесты уже ссылаются, endpoint'а нет |
| `GET /gpu/installer.sh`, `GET /gpu/installer/<artifact>` | дистрибуция installer'а | **нужен** (§7) |

### 6.7 Что НЕ меняется

`POST /workers`, `POST /:id/rotate`, `DELETE /:id`, `POST /worker/verify`,
worker protocol (`protocol_version=2`), hub task-контур, dispatch-логика.
Worker Key lifecycle (§9) остаётся как есть — он уже корректен.

---

## 7. Installer distribution model

**Рекомендуемый вариант: versioned backend/hub endpoint (Variant C из текущего
repo) + один self-contained installer package.**

Сравнение:

| Модель | Плюсы | Минусы | Вердикт |
|---|---|---|---|
| GitHub release | готовая инфраструктура, версии | публичный repo = публичные артефакты; frontend должен знать repo; нет per-deployment control | fallback/зеркало |
| Official download endpoint (hub) | единый origin с HUB_URL; уже есть прецедент `/gpu/worker-source` | нужно хранить/монтировать артефакты | **да — для артефактов** |
| Versioned backend endpoint | frontend получает latest compatible version, не хардкодит | — | **да — для metadata** |
| Container command | хорошо для Docker-сценария | узкий сценарий | позже, как отдельный method |
| `curl \| bash` script | одна команда, знакомо GPU-аудитории | нужен careful signing/checksum | **да — как обёртка**, со checksum в UI |

Целевая цепочка (совпадает с требованием «frontend не хардкодит версию»):

```
GET /api/v1/workers/setup/installer   →  latest compatible version
        ↓
download_url / command + sha256       →  frontend показывает/копирует
        ↓
installer package (self-contained)    →  сам содержит/получает:
                                          manifests, worker bundle, workflow baselines
```

**Worker files — рекомендуемый вариант A**: один installer package, который сам
содержит/получает необходимые компоненты. Installer уже умеет это
(`engine/worker.js`: bundle из repo или `GET /gpu/worker-source`;
`engine/workflows.js`: baselines из repo или hub endpoint). Пользователь не
должен разбираться, какой из шести файлов куда положить.
Ручной fallback (пока installer не принят E2E) — `GET /gpu/worker-bundle`
(полный архив), но UI ведёт пользователя прежде всего к installer'у.

**Открыто:** packaging installer'а (сейчас это `backend/src/installer/` в
составе backend-репо — дистрибуция требует либо tarball-сборки, либо
single-file bundle; см. §14 Q1).

---

## 8. Web/Android parity model

```
                Backend
                   │
        Installer/Worker Setup API (§6)
             /           \
          Web           Android
```

- Оба фронта потребляют **одни и те же** endpoints §6: profiles, methods,
  installer metadata, instructions, worker status.
- Различается только презентация: Web — wizard в странице; Android —
  фрагмент-диалог + copy-to-clipboard + external links (Android **не запускает**
  installer локально, §14).
- Паритетные правила (уже соблюдаются, сохранить): одинаковые ключи/тексты
  (i18n.ts ↔ strings.xml), одинаковая валидация (`validateCreateInput` ↔
  `BetaSettingsHelpers`), one-time disclosure, отсутствие персистирования key.
- Контракт-хелперы (`buildSetupContract` в обоих фронтах) заменяются на общий
  API-клиент; parity-тесты (`privateWorkers.test.ts` ↔
  `BetaSettingsHelpersTest.kt`) переписываются на общий fixture ответа §6.
- `ANDROID_WEB_PARITY.md` сегодня не покрывает Private Workers — после
  реализации дополнить разделом.

---

## 9. Worker Key flow

Текущий lifecycle **корректен и сохраняется**:

| Вопрос | Ответ (текущий + предлагаемый) |
|---|---|
| Где создаётся | Backend, `POST /api/v1/workers` (server-generated `wrk.…`) |
| Где хранится | PG: только `SHA-256(secret)`; Redis mirror для hub hot path. Plaintext — нигде после выдачи |
| Когда показывается | Один раз: create/rotate response → Web-модал / Android-диалог |
| Кто передаёт Installer'у | **Пользователь**: installer спрашивает интерактивно (hidden input, `cli.js:123-152`); не через argv/URL |
| Ручной ввод | Да, на GPU-машине (installer prompt). В фронтах поля ввода key нет — и не нужно |
| Как избежать попадания в logs | Installer: `safety-rules.js` SECRET_NAMES + redaction; `.env` chmod 600; merge-семантика (существующий валидный токен не трогается); фронты: transient state only, без localStorage/URL/analytics |
| Как понять, что worker зарегистрирован | Installer: `verifyRegistration` → `POST /api/v1/worker/verify`; UI: статус OFFLINE → ONLINE в течение ~30 с (heartbeat TTL). Wizard Step 6 явно говорит «вернитесь — статус обновится» |

Дополнительно для новой UX:
- Wizard показывает key **рядом с командой installer'а** и объясняет: «installer
  запросит этот ключ на сервере; вставьте его там» (+ кнопка Copy).
- Env-блок с токеном (как сегодня) остаётся доступным для ручного сценария, но
  не является основным путём.
- Rotate: подтверждение → новый key показывается один раз → инструкция
  «перезапустите worker / installer обновит .env при rerun» (merge-семантика
  installer'а не затирает токен автоматически — пользователь обновляет сам).

---

## 10. Workflow flow

Workflow — first-class artifact (Phase 1.5, policy `editable-baseline`).

UI-модель:
```
Profile (wizard Step 1)
   ↓
Available workflows          (из setup/profiles: workflow ids + display names)
   ↓
Download baseline workflow   (GET /gpu/workflow/:id — когда появится;
                              сегодня — только repo checkout, installer делает сам)
```

Сообщения пользователю (ключевые формулировки):
- «Это официальный Animastor baseline workflow. Его можно открыть и изменить
  в ComfyUI.» — baseline является отправной точкой, не тюрьмой.
- «В production workflow доставляется сервером per-task — локальная копия
  нужна только для редактирования/отладки.» (факт: worker получает workflow в
  `task.params`, `gpu-dispatcher.js`).
- Installer никогда не перезаписывает изменённые пользователем копии
  (`workflow-artifacts.js`: fresh copy → отдельный путь
  `*.animastor-baseline.json`).

Frontend не даёт редактировать workflow в Settings — только скачать/открыть
ссылку; редактирование происходит в ComfyUI.

---

## 11. Migration plan (old → new)

```
old:  one worker file + worker key
new:  profile + installer + (ComfyUI/deps/models/workflow) + worker + key + verification
```

Фазы (старую инструкцию НЕ удалять до готовности новой):

1. **Backend groundwork** (отдельная задача):
   - endpoints §6.1–6.5 (read-only, на базе существующих манифестов);
   - hub: `/gpu/worker-bundle` (чинит сломанный single-file download — можно
     сделать первым, независимо от фронтов);
   - packaging installer'а (§7); `GET /gpu/workflow/:id`.
2. **Web** (приоритет 1): wizard в `/settings/private-workers`; список workers
   без изменений; старые i18n-строки помечаются deprecated, но остаются
   fallback'ом при недоступности setup API.
3. **Android** (приоритет 2): тот же wizard на Fragments; parity-тесты.
4. **Docs**: переписать `EXPERIMENTAL_BETA_WORKER_SETUP.md` под новую модель;
   обновить `ANDROID_WEB_PARITY.md`.
5. **Cleanup** (только после принятия новой UX): удалить старые строки
   §4 #1–#6, удалить/заменить §4 #7, сузить `/gpu/worker-source` до
   deprecated-alias'а `/gpu/worker-bundle`.

Гейты: installer E2E на реальном GPU ещё **не принят**
(`private-worker-installer-e2e-acceptance.md`: нет GPU на dev-хосте) — до
принятия UI обязан показывать `status: "draft"` профилей и сохранять ручной
fallback. Манифесты draft → stable только после подтверждённого research
(checksum'ы/URL'ы моделей) и golden run.

---

## 12. Security considerations

| Секрет/канал | Правило |
|---|---|
| **Worker Key** (`wrk.…`) | Показывается один раз (create/rotate). Не в URL, не в query, не в argv installer'а (hidden prompt). PG: только SHA-256. Фронты: transient state, никакого localStorage/sessionStorage/IndexedDB/analytics. Crash reports: redaction по `SECRET_NAMES`. Clipboard: допустим (основной перенос на GPU-машину), но clip-метки нейтральны (`animastor-worker-token`), автоочистка не обязательна — ключ одноразово показан и ротируем |
| **Installer credentials** | Installer аутентифицируется только Worker Key'ом при `verify`; никаких отдельных installer-секретов не вводить. Download артефактов — публичный HTTPS + sha256 в UI (целостность), подпись — будущее улучшение |
| **Hugging Face / ModelScope tokens** | Вводятся **только на GPU-машине** (installer prompt, как `HF_TOKEN`); фронты никогда не запрашивают и не передают их; в download-planner'е токены — только headers (`engine/downloader.js`) |
| **Logs** | Backend: token не логируется (существующее правило). Installer: `registerSecret` + redaction. Фронты: не логировать содержимое token/env-блока (сегодня не логируют — сохранить; при добавлении error-tracking — mask `wrk.*` целиком) |
| **Analytics** | Запрещено отправлять token, env-блок, содержимое `.env` в любую аналитику; события wizard'а — только без параметров-секретов (profile id, platform, mode — можно) |
| **Deep links** | `https://app.animastor.in/settings/private-workers?...` допустимы только с несекретными параметрами (`?profile=image/qwen-image`); token в deep link — запрещён |
| **Setup API** | §6 — только сессия + workspace guard; setup/metadata не содержит секретов; `instructions` содержит token-placeholder, не значение |
| **Worker bundle download** | Публичный (как сегодня `/gpu/worker-source`) — в bundle нет секретов; `.env.example` — только имена переменных |

---

## 13. Файлы, которые потребуется изменить (реализация — отдельная задача)

**Backend (новые endpoints + дистрибуция):**
- `backend/src/routes/worker-routes.cjs` — setup endpoints §6.1–6.5 (или новый `worker-setup-routes.cjs`)
- `backend/src/installer/` — projection манифестов в UI-safe вид; packaging-скрипт (tarball/single-file)
- `gpu-hub/gpu-hub.js` — `/gpu/worker-bundle`, `/gpu/workflow/:id`, `/gpu/installer*`
- `docker-compose.yml` — mounts для bundle/артефактов (сейчас только `worker.cjs:110-112`)
- `backend/src/storage/postgres/repositories/worker-repo.js` — при расширении status-деталей (heartbeat read)

**Web:**
- `frontends/app/src/features/workers/PrivateWorkersSection.tsx` — wizard, management block, status details
- `frontends/app/src/features/workers/privateWorkers.ts` — замена `buildSetupContract` на API-клиент; типы
- `frontends/app/src/features/workers/privateWorkers.test.ts` — новые фикстуры
- `frontends/app/src/app/i18n.ts` — RU/EN блоки worker_* (замена старых шагов)
- `frontends/app/src/api/models.ts`, `src/api/client.ts` — типы/вызовы §6
- новые компоненты wizard'а в `features/workers/` (по реализации)

**Android:**
- `frontends/android/app/src/main/java/com/example/animastor/ui/PrivateWorkersFragment.kt` — wizard/management
- `.../ui/BetaSettingsHelpers.kt` — замена `buildSetupContract`
- `.../ui/BetaSettingsHelpersTest.kt` (test) — новые фикстуры
- `.../repository/BackendApi.kt`, `.../repository/PrivateWorkerModels.kt` — endpoints §6
- `res/values/strings.xml`, `res/values-ru/strings.xml` — worker_* строки
- возможно новый Fragment для wizard'а + layout XML

**Docs:**
- `docs/architecture/EXPERIMENTAL_BETA_WORKER_SETUP.md` — переписать
- `ANDROID_WEB_PARITY.md` — раздел Private Workers setup

---

## 14. Открытые вопросы

1. **Packaging installer'а.** Сегодня это модуль backend-репо
   (`backend/src/installer/`, bin `animastor-installer`). Нужен артефакт для
   GPU-машин: tarball? single-file bundle? npm-пакет? Кто и когда его собирает
   (CI/release)? От этого зависит §6.4 и §7.
2. **VRAM-минимумы неизвестны** (`gpu_min_vram_gb: null` во всех манифестах,
   open question 12 архитектуры). UI пока может показывать только «verified
   reference: L40S 46 GB» — приемлемо ли на старте?
3. **Model sources не исследованы** (большинство записей `repository: null`,
   verification unknown) → installer BLOCKED по моделям. Frontend должен
   честно показывать draft-статус. Когда research завершится?
4. **Node 18 vs 20**: `start-worker.sh` ставит Node 18, `worker.cjs` требует
   20+ (open question 11 архитектуры). Инструкции должны давать одну версию.
5. **Сигнал «Installing».** Сегодня backend не знает, что installer запущен.
   Нужен ли check-in endpoint (`POST /worker/install-state`)? Это изменение
   installer'а (не worker protocol) — отложить или включить в backend-фазу?
6. **Multi-profile.** `worker_type` у worker'а один; wizard допускает выбор
   нескольких профилей. Модель: один worker = один профиль (N workers), или
   multi-profile worker (требует worker protocol изменений — вне scope)?
   Рекомендуется: один worker на профиль; shared-режим — один ComfyUI, несколько
   worker-процессов (open question 4 архитектуры).
7. **`/gpu/worker-source`**: расширить in-place (breaking для старых команд?)
   или добавить `/gpu/worker-bundle` рядом (рекомендуется)?
8. **Windows installer format** (.bat / PowerShell / .exe / packaged) —
   отложен; сейчас только `installer.available=false, status=planned` (§15.4).
9. **Uninstaller** не существует — нужен отдельный дизайн (ownership-модель
   §15.6) до того, как UI пообещает кнопку Uninstall.
10. **E2E acceptance** installer'а заблокирован (нет GPU на dev-хосте) —
    гейт для stable-статуса профилей и для удаления старой инструкции.
11. **ComfyUI pin-конфликт профилей** (v0.27.0 vs форк c4cfee7a) — влияет на
    shared-режим и на то, что wizard покажет при выборе нескольких профилей.
12. **Instructions: серверная сборка vs клиентская.** §6.5 предлагает серверную;
    альтернатива — фронты собирают шаги из §6.1/6.4 (меньше endpoint'ов, но
    больше дублирования). Решение при реализации.

---

## 15. Platform & Installation Lifecycle (дополнение)

### 15.1 Принцип: frontend не привязан к Linux

Новый installer реализован для Linux, но архитектура frontend'а **не** должна
содержать предположение «Private Worker = Linux Installer». Вводится сущность
**Installation Method** (platform + lifecycle artifacts), отдаваемая через
`GET /api/v1/workers/setup/methods` (§6.2):

```jsonc
{ "platform": "linux",   "installer": { "available": true,  "version": "…" },
                          "uninstaller": { "available": true, "version": "…" } }
{ "platform": "windows", "installer": { "available": false, "status": "planned" },
                          "uninstaller": { "available": false, "status": "planned" } }
{ "platform": "docker",  "installer": { "available": false, "status": "planned" },
                          "uninstaller": { "available": false, "status": "planned" } }
```

Точные значения `platform` — `linux | windows | docker` (docker покрывает
container/VM-сценарии managed-серверов; при необходимости позже выделить
`cloud` отдельно).

### 15.2 Installer metadata contract (минимальный безопасный)

Поля (§6.4 — надмножество): `platform, arch, installer{available, version,
download_url|command, sha256, release_notes}, uninstaller{…то же…},
supported_profiles[], minimum_requirements{}`. Полный набор
(signature, отдельные checksum-манифесты, auto-update channel) — не нужен
сейчас; схема расширяема. `sha256` — обязателен с первого релиза;
`signature` — будущее улучшение.

### 15.3 Linux

- **Linux Installer** — существует (Phase 2.1, тесты passing; E2E на железе —
  blocked, §14 Q10). UI: `installer.available=true` только после E2E-принятия;
  до этого — `available=true, status=draft` с предупреждением.
- **Linux Uninstaller** — самостоятельный lifecycle artifact, **не** существует
  сегодня. Не предполагать `reinstall = uninstall + install`: это разные
  операции (reinstall/repair = идемпотентный rerun installer'а — уже
  поддерживается engine'ом через resume/idempotency; uninstall = отдельный
  артефакт со своей логикой и версией).

### 15.4 Windows

Не реализуется сейчас. Архитектурная возможность заложена: frontend получает
`platform=windows, installer.available=false|true` и рендерит соответствующий
блок («coming soon» / команду). Формат (.bat / PowerShell / .exe / packaged)
выбирается позже; рекомендация на сегодня — PowerShell-скрипт как ближайший
аналог linux-обёртки, packaged installer как целевой. В contracts ничего
windows-специфичного не добавлять.

### 15.5 Операции lifecycle в UX

Отдельные операции, не спрятанные в troubleshooting:

```
Private Worker
  Status: Online
  [Worker details]
  Management
  ├── Reinstall / Repair     (rerun installer'а; идемпотентно, resume)
  └── Uninstall Worker       (отдельный uninstaller-артефакт)
```

Расположение: Settings → Private Workers → строка worker'а → Management
(Web: row actions/details; Android: row menu). Install — в wizard'е;
Repair/Uninstall — у существующего worker'а.

### 15.6 Uninstall safety (ownership model)

Uninstaller различает:

| Класс | Примеры | Действие |
|---|---|---|
| **Animastor-managed** | Animastor Worker (bundle), Animastor-generated config (`.env`-ключи installer'а), installer state (`.animastor-installer/`), Animastor-specific services, Animastor-managed deps (если безопасно и установлено installer'ом) | можно удалить |
| **User-owned** | пользовательский ComfyUI, workflows, models, custom nodes, python-окружения | **никогда** автоматически |

UX (обязательное подтверждение):
```
Remove Animastor Worker?
This will not remove your ComfyUI, models, custom nodes or workflows.
[Uninstall]  [Cancel]
```
Особенно для **Existing ComfyUI**: удаляется только Animastor-managed
компоненты; пользовательское окружение не трогается. Для **Managed**
installer владеет большим набором компонентов — uninstall может предложить
удалить и установленные им модели/ноды, но только явным отдельным
подтверждением (по логике `safety-rules.js`: delete_model/delete_custom_node —
NEVER_AUTOMATIC).

### 15.7 Managed vs Existing uninstall

- **Managed:** installer владеет ComfyUI/deps/models → uninstall может удалить
  всё им установленное (по явному выбору), worker bundle и state — всегда.
- **Existing:** пользователь владел ComfyUI до installer'а → uninstall удаляет
  **только** Animastor-managed компоненты (worker bundle, .env-ключи
  Animastor, baseline-копии workflows, созданные installer'ом; модели/ноды —
  только если пользователь явно отметил их как установленные installer'ом).

### 15.8 Frontend UI, управляемый metadata

UI автоматически меняется от `platform × installation status × installer
availability × uninstaller availability × worker status`:

```
Linux     ✓ Installer available   ✓ Uninstaller available
Windows   ! Installer coming soon
Windows   ✓ Installer available   ✓ Uninstaller available   (будущее)
```

Никаких отдельных захардкоженных страниц под ОС: один wizard/management,
данные — из §6.2/§6.4; недоступный артефакт → disabled-блок с пояснением.

### 15.9 Android lifecycle parity

Android имеет ту же lifecycle-модель (Install / Repair / Uninstall / Status /
Diagnostics), но **не запускает installer локально**. Android предоставляет:
download link, инструкцию, copy command, open external link, worker status,
uninstall instructions/action (команда/ссылка на uninstaller-артефакт).
Web и Android используют один backend metadata contract (§6.2, §6.4).

### 15.10 Versioning

Installer и Uninstaller версионируются **независимо**:

```
Linux Installer 1.2.0      Linux Uninstaller 1.0.1
Windows Installer 1.0.0    Windows Uninstaller 1.0.0   (будущее)
```

Frontend получает актуальные версии из backend/release metadata (§6.2/§6.4) и
никогда не хранит их hardcoded. Worker bundle version — отдельно
(`worker_bundle.version`, сегодня v2.0.0; `min_version` в манифестах).

### 15.11 Future-proof model

```
Private Worker
      ↓
Installation Manager        (setup API §6, wizard, management block)
      ↓
Platform                    (linux | windows | docker — из setup/methods)
      ↓
Installation Artifact
      ├── Installer         (versioned, per-platform)
      └── Uninstaller       (versioned, per-platform, independent)
```

— а не `Private Worker → Linux Installer`. Добавление Windows/Docker позже =
новая запись в `setup/methods`, без переписывания Private Worker UI.

---

## 16. Phase 3 Implementation (Backend Setup Contract) — реализовано 2026-08-27

Единый backend contract для Web и Android реализован как дополнительный слой
поверх существующего Worker API (без breaking changes; UI не менялся).
Полные схемы ответов, auth/security, artifact/worker-bundle модели и план
миграции с `/gpu/worker-source` — в
`docs/04-planning/private-worker-setup-contract-api.md`.

### 16.1 Endpoints

| Endpoint | Назначение |
|---|---|
| `GET /api/v1/private-worker/setup/profiles` | UI-safe профили из canonical installer манифестов (`?type=`) |
| `GET /api/v1/private-worker/setup/methods` | platforms × installer/uninstaller/worker_bundle metadata |
| `GET /api/v1/private-worker/setup/artifacts` | артефакты одной platform (`?platform=`, неизвестная → 404) |
| `GET /api/v1/private-worker/setup/workflows` | baseline workflows: sha256, `editable: true`, download_url |
| `GET /api/v1/private-worker/setup/instructions` | динамическая инструкция (`?profile_id=&platform=&mode=`) |
| `GET /api/v1/private-worker/setup/workers/:id` | расширенный UI-safe статус (adapter) + normalized capabilities |
| `POST /api/v1/private-worker/setup/plan` | UI-safe installation plan (preview; никогда не исполняется) |
| `GET /gpu/worker-bundle` (+`/sha256`) | полный worker bundle tar.gz (Worker Key НЕ внутри) |
| `GET /gpu/workflow/:id` | baseline workflow (allowlist из манифестов; `old_*.json` не отдаются) |
| `GET /gpu/installer` (+`/sha256`) | self-contained installer package tar.gz |
| `GET /gpu/worker-source` | **DEPRECATED** — работает, помечен `Deprecation: true` + `Link` |

### 16.2 Ключевые решения реализации

- **Проекции, а не манифесты:** `backend/src/installer/setup-contract.js` —
  единственный выход манифестов наружу; сырые манифесты, source URL'ы моделей,
  provenance, resolver-детали не покидают backend.
- **Честность вместо выдумок:** VRAM unknown → `null`; uninstaller не
  существует → `available:false, status:"planned"` (schema готова к
  `available:true` без изменения фронтов); неисследованные источники моделей
  → plan `BLOCKED` c `MODEL_SOURCE_NOT_PUBLISHED`; Windows/Docker →
  `PLATFORM_NOT_SUPPORTED`.
- **Installer artifact реален:** hub собирает self-contained пакет
  (`src/installer/**` + `ai/install-manifests/**` + generated package.json)
  детерминированным pure-JS ustar-райтером (`gpu-hub/tarball.js`); версия
  `1.0.0`, статус `draft` (E2E на железе не принят), sha256 публикуется и
  резолвится backend'ом server-side.
- **Worker bundle:** tar.gz из 6 файлов; `.env*` (кроме `.env.example`)
  исключены фильтром hub'а; токен — только через существующий one-time
  disclosure + installer hidden prompt. Single-file `/gpu/worker-source`
  помечен deprecated (не удалён).
- **Статус worker'а:** adapter поверх существующей derivation —
  ONLINE/OFFLINE/REVOKED не ломаются; создан и ни разу не виделся →
  `CONNECTING`; `NOT_CONFIGURED/INSTALLING/ERROR` задокументированы как
  состояния фронта/будущих сигналов. `base_status` отдаётся рядом.
- **Sharing:** реальные verdict'ы resolver'а — audio+image ⇒
  `SHARED_COMPATIBLE`, image+video ⇒ `REQUIRES_ISOLATION` (разные ComfyUI
  commit'ы reference-окружений); multi-ComfyUI orchestration не реализуется.
- **Instructions** собираются сервером (решение §14 Q12 — серверная сборка):
  фронтам не хардкодить ни команд, ни версий; токен только placeholder'ом.
- **Security:** все endpoints под сессией зарегистрированного пользователя +
  workspace guard; чужой worker → неразличимый 404; download URL'ы — только
  backend-авторизованные origin-relative константы; тесты на отсутствие
  token/token_hash/секретов во всех ответах.

### 16.3 Покрытие тестами (все passing)

- `backend/tests/worker-setup-api.test.js` — API: auth/isolation, profiles,
  platforms, artifacts+checksum, workflows, instructions, worker status,
  security sweep, plan (image/video/audio, managed/existing/shared/isolated,
  SHARED_COMPATIBLE/REQUIRES_ISOLATION), legacy API intact;
- `backend/tests/installer-setup-contract.test.js` — проекции: hidden
  profiles не отдаются, planned-платформы, editable workflows, token
  placeholder, status adapter, capabilities, plan-семантика, hub outage →
  sha256 null;
- `backend/tests/gpu-hub-artifacts.test.js` — bundle состав/детерминизм/
  `.env`-исключение, workflow allowlist + traversal, installer package,
  sha256 integrity, deprecated worker-source работает.
- Полный backend suite: 1705 тестов passing.

### 16.4 Открытые blockers (унаследованы, не блокируют UI-фазы)

1. Linux uninstaller не существует (нужен отдельный ownership-design, §15.6)
   — в контракте `planned`.
2. Model sources не исследованы (D5) → plan честно BLOCKED по моделям.
3. E2E installer'а на реальном GPU не принят → installer `status: draft`.
4. VRAM-минимумы неизвестны → `gpu.min_vram_gb: null`.
5. `details` (GPU/VRAM online-детали) требуют расширения heartbeat payload
   hub'а — в контракте пока `null`.

---

### Связанные документы

- `docs/04-planning/private-worker-setup-contract-api.md` — **Phase 3 API reference (реализовано)**
- `docs/04-planning/private-worker-installer-architecture.md`
- `docs/04-planning/private-worker-installer-phase15.md`
- `docs/04-planning/private-worker-installer-manifest-resolver.md`
- `docs/04-planning/private-worker-installer-e2e-acceptance.md`
- `docs/architecture/EXPERIMENTAL_BETA_WORKER_SETUP.md` (к переписыванию, §11)
- `docs/architecture/LINUX_INSTALLER_RECONNAISSANCE.md`
- `docs/04-planning/RunPod_Integration_GPU_Hub.md` (managed-сценарии)
- `ANDROID_WEB_PARITY.md`
