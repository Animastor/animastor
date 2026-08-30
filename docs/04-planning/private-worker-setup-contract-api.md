# Private Worker Setup Contract — API Reference (Phase 3 / 3.1)

> **Status:** Phase 3 implemented; **Phase 3.1** — backend production-ready
> (canonical versions, probe-based availability, integrity/security tests) +
> Web Setup Center integrated. Android UI пока не изменялся.
> **Date:** 2026-08-27
> **Proposal:** `docs/04-planning/private-worker-installer-frontend-integration.md`
> **Код:** `backend/src/routes/worker-setup-routes.cjs`,
> `backend/src/installer/setup-contract.js`, `gpu-hub/gpu-hub.js` (artifacts),
> `gpu-hub/tarball.js`; Web — `frontends/app/src/features/workers/workerSetup.ts`,
> `frontends/app/src/features/workers/PrivateWorkersSection.tsx`
> **Тесты:** `backend/tests/worker-setup-api.test.js`,
> `backend/tests/installer-setup-contract.test.js`,
> `backend/tests/gpu-hub-artifacts.test.js`,
> `frontends/app/src/features/workers/workerSetup.test.ts`

Единый backend Setup Contract для Web и Android:

```
                Backend
                   │
        Private Worker Setup Contract
              ┌────┴────┐
             Web     Android
```

Оба фронта получают одну и ту же семантику: profiles, installation methods,
installer/uninstaller artifacts, worker bundle, workflows, worker status,
instructions, capabilities, installation plan.

---

## 1. Authentication & security model

Все endpoints контракта используют **ту же** сессионную модель, что и
`/api/v1/workers`:

- `authContext` → сессия зарегистрированного пользователя;
- гости → `403 guest_forbidden`; анонимы → `401 auth_required`;
- `workspace_id` всегда резолвится сервером из сессии — никогда из запроса;
- `setup/workers/:id` отвечает одним неразличимым `404` для чужих/неизвестных
  id (нет existence oracle);
- Worker Bearer token (`wrk.…`) **не является** пользовательской сессией —
  setup endpoints по нему отвечают `401`.

Гарантии содержимого:

| Правило | Как обеспечено |
|---|---|
| Нет plaintext token | token существует только в ответе create/rotate; контракт его не читает и не возвращает |
| Нет `token_hash` | проекции worker'а не включают столбец; максимум `token_prefix` (уже публичен в list) |
| Нет внутренних URL моделей / provenance / repo paths | `setup-contract.js` проецирует манифесты в UI-safe DTO; сырой манифест наружу не выходит |
| Нет выдуманных данных | unknown VRAM = `null`; неисследованные источники моделей = явный block; отсутствующий артефакт = `available:false, status:"planned"` |
| Frontend не задаёт download URL | все `download_url` — origin-relative константы, авторизованные backend'ом (`/gpu/…`) |
| `.env` никогда не попадает в bundle | фильтр `isServableBundleFile` в hub (`.env*` кроме `.env.example` исключены) + тест |

Worker Key lifecycle **не изменён**: создаётся backend'ом
(`POST /api/v1/workers`), показывается один раз, хранится только SHA-256,
вводится на GPU-машине через hidden-prompt installer'а. Контракт отвечает на
«что скачать / как установить / какой профиль / как проверить», не на «где
ключ».

---

## 2. Endpoints

Base: `/api/v1/private-worker/setup`

| Method | Path | Назначение |
|---|---|---|
| GET | `/profiles` | install-профили из canonical installer metadata |
| GET | `/methods` | installation methods: platform × installer/uninstaller/worker-bundle |
| GET | `/artifacts` | артефакты одной platform |
| GET | `/workflows` | baseline workflow metadata (editable) |
| GET | `/instructions` | динамическая инструкция (server-assembled) |
| GET | `/workers/:id` | UI-safe статус worker'а (расширенная модель) |
| POST | `/plan` | UI-safe installation plan (preview, никогда не исполняется) |

Публичные артефакты на GPU Hub (без auth — секретов нет; nginx проксирует
`/gpu` → hub):

| Method | Path | Назначение |
|---|---|---|
| GET | `/gpu/worker-bundle` | полный worker bundle (tar.gz) |
| GET | `/gpu/worker-bundle/sha256` | checksum + версия bundle |
| GET | `/gpu/workflow/:id` | baseline workflow JSON (allowlist из манифестов) |
| GET | `/gpu/installer` | **bootstrap-скрипт установщика** (bash): скачивает бандл, проверяет SHA-256, распаковывает во временную папку и запускает настоящий установщик со встроенными `profile`/`mode` (`?profile=…&mode=…`, валидация по allowlist манифестов; без параметров — run-time guard). Требует bash/curl|wget/tar/sha256sum/Node ≥ 20; активно отклоняет credential в env/argv (exit 3) |
| GET | `/gpu/installer/bundle` | self-contained installer package (tar.gz) |
| GET | `/gpu/installer/sha256` | checksum + версия installer'а |
| GET | `/gpu/worker-source` | **DEPRECATED** (только `worker.cjs`); работает, помечен заголовками `Deprecation: true` + `Link: </worker-bundle>` |

---

## 3. Response schemas

### 3.1 `GET /profiles`

Query: `?type=audio|image|video` (опц.; иначе 400 `invalid_type`).

```jsonc
{
  "profiles": [{
    "id": "image/qwen-image",
    "name": "Qwen Image",
    "description": "Qwen Image — private image generation via ComfyUI on your own GPU worker.",
    "worker_type": "image",
    "status": "draft",                       // draft | stable; hidden/internal не отдаются
    "supported_install_modes": ["managed", "existing", "shared", "isolated"],
    "gpu": {
      "min_vram_gb": null,                   // unknown — честно null, не выдумано
      "reference_gpu": "NVIDIA L40S (46068 MiB)"
    },
    "disk_budget_bytes_approx": 22780911288,
    "workflows": ["img-qwen-image"],
    "dependencies_summary": { "custom_nodes": 1, "models": 4, "approx_bytes": 22780911288 }
  }]
}
```

Источник: `install-manifest.loadAllManifests()` + проекция
(`setup-contract.projectProfile`). Манифест с `status: "internal"|"hidden"`
не попадает в контракт.

### 3.2 `GET /methods`

```jsonc
{
  "methods": [
    {
      "platform": "linux",
      "architectures": ["x86_64"],
      "status": "available",                  // hub probe: артефакт реально раздаётся
      "installer": {
        "available": true,                    // Phase 3.1: только по результатам hub-probe
        "status": "draft",                    // E2E на реальном GPU ещё не принят
        "version": "1.0.0",                   // canonical: backend/src/installer/package.json
        "download_url": "/gpu/installer",     // null, если артефакт недоступен
        "sha256": "…64 hex…",                 // из hub-probe; null при недоступном hub
        "signature": null,                    // будущее: signature + signature_algorithm
        "signature_algorithm": null
      },
      "uninstaller": {
        "available": false,                   // uninstaller не существует — честно planned
        "status": "planned",
        "version": null, "download_url": null, "sha256": null,
        "signature": null, "signature_algorithm": null
      },
      "worker_bundle": {
        "available": true,
        "status": "available",
        "version": "2.0.0",                   // canonical: worker/worker/package.json
        "download_url": "/gpu/worker-bundle",
        "sha256": "…64 hex…",
        "files": ["worker.cjs", "worker-cleanup.cjs", "worker-cleanup-journal.cjs",
                   "package.json", "package-lock.json", ".env.example"]
      },
      "supported_profiles": ["audio/qwen-tts", "image/qwen-image", "video/ltx-2.3"],
      "minimum_requirements": { "node": "20", "python": "3.10", "gpu": "NVIDIA GPU …" }
    },
    { "platform": "windows", "status": "planned", "installer": { "available": false, "status": "planned", … }, … },
    { "platform": "docker",  "status": "planned", … }
  ]
}
```

Installer и Uninstaller — **разные** versioned artifacts; контракт не
предполагает `uninstall = install --remove`. Windows/Docker готовы к
`available: true` без изменения frontend API. Metadata не содержит ни
расширений файлов (`.sh/.bat/.exe`), ни shell'ов, ни команд — только
availability.

### 3.3 `GET /artifacts`

Query: `?platform=linux|windows|docker` (default `linux`; неизвестная →
`404 unsupported_platform`).

```jsonc
{
  "platform": "linux",
  "architecture": "x86_64",
  "status": "available",
  "installer":   { …как в methods… },
  "uninstaller": { … },
  "worker_bundle": { … },
  "supported_profiles": ["audio/qwen-tts", "image/qwen-image", "video/ltx-2.3"]
}
```

### 3.4 `GET /workflows`

Query: `?profile_id=<id>` (опц.; неизвестный → `400 invalid_profile`).

```jsonc
{
  "workflows": [{
    "id": "img-qwen-image",
    "name": "Qwen Image",
    "profile_id": "image/qwen-image",
    "baseline_available": true,
    "download_url": "/gpu/workflow/img-qwen-image",
    "sha256": "fb4c25e5…",                   // baseline_sha256 из манифеста
    "editable": true                          // baseline можно скачать и изменить
  }]
}
```

Workflow не immutable: `editable` не может быть `false` (валидация манифеста).
Hub отдаёт только workflow'ы из allowlist'а манифестов — legacy `old_*.json`
не отдаются; path traversal исключён.

### 3.5 `GET /instructions`

Query: `?profile_id=<id>[,<id2>]&platform=linux|windows|docker&mode=managed|existing|shared|isolated`
(defaults: `linux`, `managed`). Ошибки: неизвестный profile → `400
invalid_profile`; неизвестная platform → `404 unsupported_platform`;
неверный mode → `400 invalid_mode`.

 Воркер к этому моменту **уже создан** (визард: profile → mode → platform →
 create worker → install) — шага `create-worker` в инструкции нет и быть не
 может: фронт всегда показывает инструкцию только держателю ключа.

```jsonc
{
  "platform": "linux",
  "mode": "managed",
  "profile_ids": ["image/qwen-image"],
  "worker_key_policy": {
    "disclosed_once": true,
    "disclosed_by": "POST /api/v1/workers (create) or POST /api/v1/workers/:id/rotate",
    "entered_on": "GPU machine — the installer asks interactively (hidden input)",
    "never": ["setup contract responses", "logs", "argv", "URLs", "installer state files"]
  },
  "env": {
    "required": ["HUB_URL", "ANIMASTOR_WORKER_TOKEN", "WORKER_TYPE", "WORKER_ID"],
    "secrets": ["ANIMASTOR_WORKER_TOKEN"],
    "template_block": "HUB_URL=<hub-url>\nANIMASTOR_WORKER_TOKEN=<your-worker-key>\nWORKER_TYPE=<worker-type>\nWORKER_ID=<worker-id>"
  },
  // Метаданные bootstrap-инсталлятора для UI: version — главная строка,
  // sha256 — в свёрнутом блоке (показывается один раз). Для managed/existing
  // download_url — bootstrap-скрипт со встроенными profile/mode (ничего
  // вводить не нужно); для isolated — tar.gz бандл.
  "installer": {
    "version": "1.3.0",
    "sha256": "…",
    "status": "available",
    "download_url": "https://<origin>/gpu/installer?profile=image%2Fqwen-image&mode=managed"
  },
  "steps": [
    // managed/existing (bootstrap flow):
    { "id": "download-bootstrap", "title": "…", "body": "…",
      "code": "curl -fsSL -o animastor-installer.sh https://<origin>/gpu/installer?profile=image%2Fqwen-image&mode=managed" },
    { "id": "run-bootstrap", "title": "…", "body": "…",
      "code": "bash animastor-installer.sh" },
    { "id": "verify", "title": "…", "body": "…" }
    // existing добавляет перед ними prerequisites
    // (ComfyUI / Python / Torch / CUDA / GPU — detection делает installer).
  ],
  // Необязательная терминальная диагностика — НИКОГДА не обязательный шаг:
  // страница сама показывает статус воркера (Online после heartbeat).
  "verify_command": "$HOME/animastor/tools/status.sh"
}
```

- `mode=existing` добавляет шаг `prerequisites` (ComfyUI / Python / Torch /
  CUDA / GPU — detection делает installer, фронтам не хардкодить);
- `mode=shared` передаёт `--mode shared` (CLI поддерживает);
- `mode=isolated` — bootstrap не используется (один запуск не выражает
  независимые окружения): явный tar.gz flow, по одному запуску installer'а
  на профиль в отдельные `--root`; `installer.download_url` указывает на
  `/gpu/installer/bundle`, шаги получают checksum + verify_code;
- деградация: installer недоступен + bundle доступен → шаг
  `installer-unavailable` (или bundle-flow для existing); платформа не
  опубликована → шаг `platform-planned` (без команд);
- токен — только placeholder `<your-worker-key>`; bootstrap-скрипт actively
  отклоняет credential в env/argv (fail closed, exit 3);
- старая инструкция (`curl … worker-source`, `node worker.cjs`) в контракте
  отсутствует — она выводится из использования.

### 3.6 `GET /workers/:id`

```jsonc
{
  "worker": {
    "worker_id": "…uuid…",
    "workspace_id": "…uuid…",
    "name": "alice-image",
    "worker_type": "image",
    "mode": "private",
    "status": "CONNECTING",                  // расширенная модель (adapter)
    "base_status": "OFFLINE",                // существующая derivation — без изменений
    "status_model": ["NOT_CONFIGURED", "INSTALLING", "CONNECTING",
                      "ONLINE", "OFFLINE", "ERROR", "REVOKED"],
    "token_prefix": "wrk.…prefix…",          // максимум маски — как в list
    "last_seen": 1756000000000,
    "revoked_at": null,
    "created_at": 1756000000000,
    "capabilities": {                         // нормализовано; null если данных нет
      "profiles": ["image/qwen-image"],
      "workflows": ["img-qwen-image"],
      "gpu": { "name": "NVIDIA L40S", "vram_gb": 45 }
    },
    "details": null                           // online-детали из heartbeat hub'а — будущее расширение
  }
}
```

Adapter (не ломает ONLINE/OFFLINE/REVOKED):

| base | last_seen | setup status |
|---|---|---|
| REVOKED | — | `REVOKED` |
| ONLINE | — | `ONLINE` |
| OFFLINE | `null` (ни разу не виделся) | `CONNECTING` |
| OFFLINE | число | `OFFLINE` |

`NOT_CONFIGURED` — состояние фронта (worker не создан); `INSTALLING` и
`ERROR` зарезервированы под будущие сигналы (installer check-in / worker
error reporting) — сейчас backend их не получает и не выдумывает.

`capabilities` — нормализованный passthrough реальных данных
(`profiles[]`, `workflows[]`, `gpu{name, vram_gb}`; `vram_mib` →
`vram_gb`); фиктивные поля не добавляются: пусто → `null`.

### 3.7 `POST /plan`

Request:

```jsonc
{
  "profile_ids": ["image/qwen-image"],       // ≥1, все должны существовать
  "mode": "managed",                          // managed | existing | shared | isolated
  "platform": "linux"                         // linux | windows | docker (default linux)
}
```

Response:

```jsonc
{
  "result": "BLOCKED",                        // READY | READY_WITH_WARNINGS | BLOCKED
  "platform": "linux",
  "mode": "managed",
  "profiles": ["image/qwen-image"],
  "actions": [
    { "type": "INSTALL",  "component": "runtime",       "name": "ComfyUI", "profiles": ["image/qwen-image"], "conditional": false },
    { "type": "INSTALL",  "component": "custom-node",   "name": "ComfyUI-GGUF", … },
    { "type": "DOWNLOAD", "component": "model",         "name": "qwen-image-2512-Q4_K_M.gguf", "blocked": true, "size_bytes_approx": 13249974108, … },
    { "type": "DOWNLOAD", "component": "workflow",      "name": "Qwen Image", "editable": true, … },
    { "type": "INSTALL",  "component": "worker-bundle", "name": "Animastor worker (image)", … },
    { "type": "CONFIGURE","component": "worker-env",    "name": "Worker configuration (Worker Key entered on the GPU machine — never via this API)", … },
    { "type": "VERIFY",   "component": "verification",  "name": "Post-install verification (resolver diff + registration check)", … }
  ],
  "warnings": ["profile image/qwen-image is \"draft\" — E2E acceptance …", "…minimum VRAM is unknown…"],
  "blocks": [
    { "code": "MODEL_SOURCE_NOT_PUBLISHED",
      "message": "qwen-image-2512-Q4_K_M.gguf: download source is not researched yet — the installer refuses to guess URLs (manifest status: draft)" }
  ],
  "sharing": null,                            // или { verdict, can_share, message } при >1 профиле
  "disk_budget_bytes_approx": 22780911288
}
```

Семантика:

- plan — **preview** на базе canonical манифестов + resolver против чистой
  среды; HTTP-вызов ничего не устанавливает (backend не remote shell);
- `mode=existing` — все INSTALL/DOWNLOAD действия `conditional: true`
  (installer сам делает detection на машине и ставит только недостающее;
  пользовательские компоненты никогда не заменяются автоматически);
- `mode=shared` (≥2 профилей) — `sharing.verdict`:
  `SHARED_COMPATIBLE` / `SHARED_CONFLICT` / `REQUIRES_ISOLATION` / `UNKNOWN`
  (реальные данные: audio+image ⇒ `SHARED_COMPATIBLE`; image+video ⇒
  `REQUIRES_ISOLATION` — разные ComfyUI commit'ы reference-окружений);
- `mode=isolated` — каждый профиль планируется в своём окружении
  (data model; multi-ComfyUI orchestration не реализуется);
- `platform=windows|docker` ⇒ `BLOCKED` c `PLATFORM_NOT_SUPPORTED`;
- неисследованные источники моделей ⇒ `MODEL_SOURCE_NOT_PUBLISHED`
  (инсталлер тоже репортит BLOCKED — URLs не выдумываются);
- ошибки валидации: `400 invalid_profile` / `400 invalid_mode` /
  `404 unsupported_platform`.

---

## 4. Artifact model

| Artifact | Версия (canonical source) | Источник | Целостность | Подпись |
|---|---|---|---|---|
| Installer | `backend/src/installer/package.json` → `version` (сейчас `1.0.0`) | hub `GET /installer` — tar.gz: `src/installer/**` + `ai/install-manifests/**` + generated root `package.json`/`README.txt` | sha256 (детерминированная сборка: фиксированные mtime/order) | `signature: null` — schema готова |
| Uninstaller | отсутствует ⇒ `version: null` | не существует | — | planned; отдельный артефакт, не `install --remove` |
| Worker bundle | `worker/worker/package.json` → `version` (сейчас `2.0.0`) | hub `GET /worker-bundle` — tar.gz 6 файлов | sha256 | — |
| Baseline workflow | `revision` манифеста + baseline_sha256 (content-addressed) | hub `GET /workflow/:id` (allowlist манифестов) | sha256 совпадает с манифестом | — |

**Phase 3.1: версии имеют один источник истины.** Hub читает версии из
canonical `package.json` файлов при запросе (без config-дублей); backend
Setup Contract получает версию из hub-probe (что реально раздаётся), с
fallback на canonical файл репозитория. Артефакт без canonical версии не
раздаётся (404). `worker.cjs` сообщает в beacon ту же версию из своего
`package.json` (override — `WORKER_VERSION` env).

**Phase 3.1: availability соответствует реальности.** Backend probe'ит hub
(`GET /worker-bundle/sha256`, `GET /installer/sha256`, TTL-кэш 30 с):
`available: true` только если hub действительно раздаёт артефакт. Probe
неудачен ⇒ `available: false, status: "unavailable", download_url: null`
(fake-ссылки невозможны). Статусы артефактов: `available` | `draft`
(implemented, E2E acceptance pending) | `planned` (не implemented) |
`unavailable` (не раздаётся этим деплоем).

Детерминизм: tar-архивы собираются pure-JS ustar-райтером
(`gpu-hub/tarball.js`) с фиксированными mtime=0/uid/gid/mode и сортировкой
файлов ⇒ одинаковый контент ⇒ одинаковый sha256. Кэш hub'а инвалидируется по
fingerprint'у исходных файлов (size+mtime).

`download_url` в контракте — origin-relative (`/gpu/…`): frontend резолвит
против своего origin (Web — `location.origin`, Android — `BASE_URL`).
sha256 backend резолвит server-side из hub (`HUB_URL` env); hub недоступен ⇒
`sha256: null`, `available: false` (metadata не ломается).

Workflow metadata (Phase 3.1): `baseline_available` отражает реальное
наличие canonical файла в дереве, которое раздаёт hub; файл отсутствует ⇒
`download_url: null, sha256: null`. `revision` — версия манифеста,
определяющего workflow-артефакт.

---

## 5. Worker bundle model

`GET /gpu/worker-bundle` → `animastor-worker-2.0.0.tar.gz`:

```
animastor-worker/
  worker.cjs
  worker-cleanup.cjs
  worker-cleanup-journal.cjs
  package.json
  package-lock.json
  .env.example          # только имена переменных + placeholder
```

- **Worker Key НЕ в bundle**: `.env` и любые `.env.*` (кроме `.env.example`)
  исключены фильтром hub'а независимо от содержимого смонтированной
  директории; токен передаётся отдельно (one-time disclosure → hidden prompt
  installer'а на GPU-машине, merge-семантика `.env`, chmod 600);
- single-file допущение (`/gpu/worker-source`) помечено deprecated —
  `worker.cjs` делает `require('./worker-cleanup.cjs')` и
  `require('./worker-cleanup-journal.cjs')`, установка одного файла сломана;
- docker-compose монтирует `./worker/worker:/app/worker-bundle:ro`
  (+ `./backend/ai/workflows`, `./backend/src/installer`,
  `./backend/ai/install-manifests` для installer'а).

---

## 6. Migration from `/gpu/worker-source`

| Стадия | Что |
|---|---|
| Сейчас (Phase 3) | `/gpu/worker-source` работает без изменений + заголовки `Deprecation: true`, `Link: </worker-bundle>; rel="successor-version"`; код помечен DEPRECATED. Canonical source для будущих фронтов — Setup Contract |
| Web UI / Android UI (следующие фазы) | фронты переходят на `setup/*` endpoints + `/gpu/worker-bundle`; старая i18n-инструкция остаётся fallback'ом |
| Cleanup (после принятия новой UX) | `/gpu/worker-source` сужается до deprecated-alias'а или удаляется отдельным решением |

Deployment note: hub получает новые endpoints после пересборки образа
(`docker compose build gpu-hub && docker compose up -d gpu-hub`); backend
подхватывает маршруты после рестарта (src смонтирован live).

---

## 7. Что НЕ менялось на этой фазе

- Android UI — не тронут (тот же Setup Contract будет использован позже);
- Web: старый single-file flow удалён из основного onboarding, но его
  helpers/строки сохранены как compatibility fallback (Phase 3.1 §9);
- Worker (`worker/worker/*`), GPU Hub protocol (`protocol_version=2`),
  dispatch/task-контур — не тронуты;
- существующий Worker API (`/api/v1/workers*`, `/api/v1/worker/verify`) —
  без breaking changes (покрыто тестами);
- Worker Key lifecycle — без изменений;
- remote installation через HTTP — не реализуется (plan = preview);
- Windows installer/uninstaller — не реализуются (только schema).
