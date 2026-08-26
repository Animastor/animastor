# Private Worker Installer — Architecture Draft

> **Version:** 0.2.0 (draft — architecture; Phase 1 + Phase 1.5 foundation implemented)
> **Status:** Planning + foundation implemented
> **Date:** 2026-08-26
>
> Этот документ — архитектурный draft нового простого Installer для
> **Animastor Private Workers**. Он НЕ является инструкцией по установке и
> НЕ отменяет существующие системы: workflow/connector слой, GPU Hub,
> runtime audits, `worker/start-worker.sh`.
>
> **Phase 1.5** (Existing ComfyUI, Workflows, гибкий профильный режим) —
> см. `docs/04-planning/private-worker-installer-phase15.md`.

---

## 0. Fixed Pipeline (Phase 1.5)

```
Animastor Profile
       ↓
Baseline Requirements        (manifest: runtime, nodes, models, workflows, worker)
       ↓
Dependency Resolver          (required ∪ installed → missing/incompatible/unused/unknown)
       ↓
Runtime Mode                 (managed | existing | isolated | shared)
       ↓
Installer                    (interactive plan → confirmation gates → execution)
       ↓
ComfyUI + Models + Nodes + Workflow
       ↓
Animastor Worker
```

Ключевая установка Phase 1.5: **профиль — это baseline, а не тюрьма**.
Baseline workflow является отправной точкой для пользователя и может быть
изменён локально (installer никогда не перезаписывает пользовательскую копию).

### Runtime Modes (зафиксированы)

| Режим | Владелец окружения | Поведение installer'а |
|---|---|---|
| **Managed** | Installer (V1 target) | полная установка: ComfyUI → runtime → nodes → models → workflows → worker → .env → verify |
| **Existing** | Пользователь | detect → compare → report → предложить недостающее; НИКОГДА не удалять/downgrade/заменять автоматически |
| **Isolated** | Одна GPU-машина, N независимых ComfyUI-окружений | каждое окружение резолвится независимо под своим root (data model; полная реализация позже) |
| **Shared** | Один ComfyUI на несколько профилей | dependency union + compatibility check; при конфликте — «Isolation recommended», без автоматического split |

---

## 1. Problem

Сегодня развёртывание GPU-воркера для Animastor — это ручной многошаговый
процесс: поднять ComfyUI нужной версии, поставить torch с правильным CUDA,
установить custom nodes, скачать модели в правильные каталоги, положить
`worker.cjs`, заполнить `.env`, зарегистрировать worker.

Существующие артефакты решают части задачи, но не всю:

| Артефакт | Что делает | Чего не делает |
|---|---|---|
| `worker/start-video.sh` | ставит ComfyUI v0.27.0 + torch cu124 | не знает про profiles/models/custom nodes |
| `worker/start-worker.sh` | стартует worker, читает `.env` | не устанавливает зависимости |
| `scripts/animastor-runtime-audit.sh` | read-only аудит живого инстанса | ничего не устанавливает |
| `docs/runtime-audits/*` | справочные снимки рабочих сред | явно «not installation instructions» |
| `backend/ai/profiles/**` | prompt-assembly профили backend'а | не описывают install-зависимости |

Цель installer'а: **одна команда на GPU-сервере → готовый Private Worker**
для выбранного Generation Profile.

## 2. Goals

1. Одна команда: `installer --profile <profile>` → готовый работающий worker.
2. Детерминизм: одинаковый результат при повторном запуске (идемпотентность).
3. Явная модель зависимостей: что required, что уже стоит, чего не хватает.
4. Безопасность: Worker Key — интерактивный пользовательский секрет;
   никогда не попадает в логи, git или argv.
5. Проверяемость: после установки — автоматическая верификация
   (включая переиспользование runtime-audit как reference).
6. Переиспользование существующей архитектуры: workflows остаются на VPS,
   delivery через GPU Hub не меняется, runtime/orchestration логика
   не затрагивается.

## 3. Non-goals

- Не менять runtime / orchestration / dispatch логику backend, hub, worker.
- Не делать dependency research (конкретные URLs моделей/нод — отдельная задача).
- Не скачивать модели в рамках подготовки этого документа.
- Не заменять GPU Hub provisioning (см. `RunPod_Integration_GPU_Hub.md`) —
  installer работает поверх существующего worker contract, а не вместо него.
- Не поддерживать Windows/macOS — только Linux GPU-серверы (Ubuntu-подобные).
- Не делать multi-profile установку в одной директории (v1: один profile
  = один инсталл; расширяемость предусмотреть).

## 4. Architecture Overview

```
                    ┌──────────────────────────────────────────┐
                    │            Generation Profile             │
                    │   (декларативное описание «что нужно»)    │
                    │   backend/ai/profiles/{type}/{name}.json  │
                    └───────────────┬──────────────────────────┘
                                    │ references
                    ┌───────────────▼──────────────────────────┐
                    │         Production Workflows              │
                    │  backend/ai/workflows/*.json + connectors │
                    │  (источник истины по required deps)       │
                    └───────────────┬──────────────────────────┘
                                    │ scan (class_type, file refs)
                    ┌───────────────▼──────────────────────────┐
                    │        Dependency Resolver                │
                    │  required ∪ installed → missing/unused/…  │
                    └───────────────┬──────────────────────────┘
                                    │ produces
                    ┌───────────────▼──────────────────────────┐
                    │      Canonical Install Manifest           │
                    │  (версионируемый, подписываемый документ) │
                    └───────────────┬──────────────────────────┘
                                    │ executes
        ┌───────────────────────────▼────────────────────────────┐
        │                      Installer                          │
        │  system check → ComfyUI → deps → worker → .env → verify │
        └───────────────────────────┬────────────────────────────┘
                                    │ starts
                    ┌───────────────▼──────────────────────────┐
                    │              Worker                       │
                    │  worker.cjs + .env → GPU Hub registration │
                    └──────────────────────────────────────────┘

    Runtime Audit ─── verification/reference only ───► Installer & docs
    (НЕ источник истины для manifest)
```

### Ключевой принцип

> **Runtime audit НЕ является источником истины для install manifest.**
> Источник истины по required dependencies — **production workflows**,
> связанные с профилем. Runtime audit используется только для:
> - verification («похоже ли установленное на известную рабочую среду»);
> - reference при составлении/ревизии manifest'а человеком;
> - диагностики расхождений (`unused`, `unknown`).

Причина: audit фиксирует *историческое* состояние одного инстанса
(включая UI-тестовые артефакты оператора, см. замечание в
`docs/runtime-audits/image-qwen/...md`), а workflow определяет, что
*реально необходимо* во время выполнения задачи.

## 5. Components

### 5.1 Generation Profile

**Расположение:** `backend/ai/profiles/{type}/{profile}.json`
(существующие: `audio/qwen-tts.json`, `image/qwen-image.json`,
`video/ltx-2.3.json` — сегодня они описывают prompt-assembly).

Расширение роли: профиль становится **корнем декларации** — он ссылается
на production workflows и на install-спецификацию, но сам по себе не
перечисляет модели/ноды вручную там, где их можно вывести из workflows.

Ответственность:
- выбрать набор production workflows (`workflow: "video-ltx-*"` уже есть);
- сослаться на install spec (см. ниже) и на ComfyUI version policy;
- объявить hardware requirements (минимальный VRAM, CUDA tier) — draft.

Не ответственность: пути установки, механика скачивания.

### 5.2 Production Workflows

**Источник:** `backend/ai/workflows/*.json` + `backend/ai/connectors/*.json`.
Уже содержат машиночитаемую информацию о потребностях:
- `class_type` каждой ноды → какие custom nodes требуются;
- строковые refs на файлы моделей (`*.gguf`, `*.safetensors`, …);
- `model_repo` значения (например, Qwen3TTS) → Hugging Face источники.

Это единственный источник `required`. Скан workflows уже реализован в
audit script'е ([7] WORKFLOWS) — та же логика переиспользуется resolver'ом.

Важно (подтверждено `docs/runtime-audits/README.md`): workflow JSON
**не доставляется на GPU-бокс** — он приходит по сети от backend через
GPU Hub в `task.params`. Поэтому «установка workflows» installer'ом — это
опциональная offline/debug-выкладка, а не production-требование.

### 5.3 Dependency Resolver

Отдельный компонент (в будущем — часть tooling репозитория), который:

1. Берёт профиль → раскрывает список production workflows.
2. Сканирует каждый workflow: `class_type` → custom node packages;
   file refs → model artifacts.
3. Сопоставляет с install spec (декларативная таблица соответствий
   «ref → canonical dependency», см. §8).
4. Сравнивает с фактическим состоянием машины (как это делает audit).
5. Выдаёт **resolution report**: каждая зависимость в одном из состояний.

Состояния зависимостей (обязательная семантика):

| Состояние | Значение |
|---|---|
| `required` | присутствует в manifest для данного профиля |
| `installed` | найдена на машине и соответствует manifest (version/checksum) |
| `missing` | required, но на машине отсутствует → installer должен поставить |
| `unused` | есть на машине, но не требуется данным профилем (информационно; НЕ удалять автоматически) |
| `unknown` | есть на машине, но не удаётся сопоставить ни с одной записью manifest (нет git remote, plain dir, неизвестное имя файла) |

Правила:
- `unused` и `unknown` никогда не триггерят удаление в v1.
- `installed` подтверждается filename + revision/version (+ checksum, если
  доступен без полного перехеширования больших файлов).
- Отчёт resolver'а — вход для installer'а; installer не принимает решений
  о том, что «нужно», самостоятельно.

### 5.4 Canonical Install Manifest

Единый версионированный документ, описывающий полный install footprint
профиля. Схема — §9. Manifest:

- генерируется/ревизируется **оффлайн** (в репозитории Animastor),
  на основе workflows + подтверждённого человеком research;
- потребляется installer'ом на GPU-машине;
- содержит всё: ComfyUI policy, python/torch, models, custom nodes,
  worker bundle, env template.

Манифест ≠ snapshot аудита. Аудит может быть использован при подготовке
manifest'а как reference, но каждая запись должна быть выведена из
workflows или явно помечена как `optional` / `debug`.

### 5.5 Installer

Один исполняемый скрипт/binary, запускаемый на GPU-сервере. Фазы — §11.
Installer — единственный компонент с правом записи на целевой машине.
Он исполняет manifest буквально и не «знает» специфику профилей.

### 5.6 Worker

Существующий `worker/worker/worker.cjs` (v2.0.0, fail-closed auth).
Изменений в коде worker'а не требуется. Installer:
- размещает worker bundle (`worker.cjs`, cleanup/journal, package.json);
- создаёт `.env` (§12);
- запускает через существующий механизм (`start-worker.sh <type>`
  или прямой вызов — открытый вопрос, §16).

Регистрация в GPU Hub происходит самим worker'ом при старте
(`Authorization: Bearer wrk.<id>.<secret>`); installer лишь обеспечивает
наличие корректного токена.

### 5.7 Runtime Audit (verification role)

`scripts/animastor-runtime-audit.sh` остаётся read-only инструментом.
Новая роль: **post-install verification step**. Installer в конце может
предложить/запустить audit и сравнить его вывод с manifest:
- все `required` присутствуют → PASS;
- есть `unknown`/`unused` → WARN (список в отчёт пользователю);
- отсутствует `required` → FAIL.

Дополнительно audit-снимки свежеустановленных машин пополняют
`docs/runtime-audits/<profile>/` как reference для следующих ревизий
manifest'а (человек в цикле).

## 6. Data Flow

```
[offline, в репозитории]
  production workflows ──scan──► dependency table (research, человек)
                                        │
  profiles ────────────────────────────►│
                                        ▼
                          Canonical Install Manifest (vX.Y.Z)

[на GPU-сервере]
  installer --profile video/ltx-2.3
      │
      ├─ 1..N фаз установки (§11), сверяясь с manifest
      │      каждый шаг: check → skip|install → record
      ├─ state file: ~/animastor/install-state.json (что сделано)
      ├─ интерактивный запрос ANIMASTOR_WORKER_TOKEN
      ├─ запуск worker → регистрация в GPU Hub
      └─ финальная верификация (health + optional audit diff)
             │
             ▼
        READY Private Worker → обычный dispatch-контур Animastor
```

## 7. Profile → Workflow → Dependency → Manifest model

Цепочка ответственности (каждое звено знает только о соседях):

| Звено | Владеет | Производит |
|---|---|---|
| **Profile** | выбор generation capability; ссылки на workflows + install spec | идентичность профиля, hardware reqs |
| **Workflow(s)** | фактические потребности выполнения: node classes, model file refs | данные для dependency discovery |
| **Dependency Resolver** | правила маппинга ref→dependency, сравнение с машиной | resolution report (required/installed/missing/unused/unknown) |
| **Manifest** | канонический install footprint: точные версии, checksums, target paths | исполняемая спецификация для installer'а |
| **Installer** | механика исполнения: download, pip, git, запись .env | установленная машина, install log/state |
| **Worker** | runtime: подключение к Hub, выполнение задач | работающий сервис |

Инварианты:
1. Workflow — единственный источник `required`.
2. Manifest может добавлять только то, что можно классифицировать как
   `required` (из workflows) либо явно `optional`/`bootstrap` (например,
   ComfyUI-Manager как utility — открытый вопрос, §16).
3. Installer не содержит знаний о профилях — только об операциях.
4. Worker не знает, как он был установлен.

## 8. Dependency model

### 8.1 Типы зависимостей

- `model` — файлы моделей (gguf/safetensors): unet, text_encoders, vae,
  loras, upscale_models, TTS и т.д. Target — подкаталоги `ComfyUI/models/`.
- `custom_node` — пакеты в `ComfyUI/custom_nodes/` (git-репозитории).
- `python_package` — pip-зависимости (torch с CUDA-индексом, требования
  нод). Особый случай: torch pin'ится отдельно (см. start-video.sh).
- `runtime` — Node.js ≥ 18/20, NVIDIA driver, CUDA userland.
- `comfyui` — сам ComfyUI (особая запись, §10).
- `worker_bundle` — файлы Animastor worker'а.

### 8.2 Источники

| Источник | Для чего | Механика |
|---|---|---|
| GitHub | ComfyUI, custom nodes | `git clone --branch/--depth 1` + checkout pinned tag/commit |
| Hugging Face | модели (gguf/safetensors) | resolve URL → HTTPS download; поддержка `HF_TOKEN` для gated |
| ComfyUI registry / Manager ecosystem | custom nodes (если применимо) | опциональный канал; вопрос открыт (§16) |
| PyPI / pytorch index | python-зависимости | pip с явным `--index-url` для cu12x |
| Animastor origin | worker_bundle, manifest, lock-файлы | тот же origin, что HUB_URL |

Каждая запись манифеста указывает ровно один primary source + fallback-
политику (v1: fallback = fail с понятной ошибкой, без авто-зеркал).

### 8.3 Поля записи зависимости

```jsonc
{
  "id": "video.ltx-2.3.unet.LTX-2.3-distilled-Q4_K_M",  // stable ID
  "type": "model",                 // model | custom_node | python_package | runtime | comfyui
  "filename": "LTX-2.3-distilled-Q4_K_M.gguf",
  "target_dir": "models/unet/",    // относительно ComfyUI root
  "source": {
    "kind": "huggingface",          // github | huggingface | comfy_registry | pypi | animastor
    "repository": "<to-be-confirmed>", // repo id / URL — НЕ выдумывать без research
    "revision": "<tag-or-commit-or-hash>"
  },
  "size_bytes": 17760858112,        // ожидаемый размер (для pre-check диска и sanity)
  "checksum": { "algo": "sha256", "value": null },  // value заполняется после подтверждённого research
  "requirement": "required",        // required | optional
  "profiles": ["ltx-2.3"],          // association (может быть несколько)
  "provenance": {
    "derived_from_workflow": ["video-ltx-2p"],  // какой workflow требует
    "verified_by_audit": ["docs/runtime-audits/video-ltx-2.3/audit-2026-08-26.txt"]
  }
}
```

Обязательность полей: `id`, `type`, `filename`, `target_dir`, `source`,
`revision`, `requirement`, `profiles` — всегда. `size_bytes`,
`checksum.value` — заполняются в ходе подтверждённого research; до этого
запись не может быть переведена из draft в stable.

## 9. Manifest schema draft

```jsonc
{
  "manifest_version": "1.0.0",       // версия самой схемы
  "revision": "2026.08.26-r1",        // ревизия содержимого (monotonic)
  "profiles": [{
    "id": "video/ltx-2.3",
    "type": "video",
    "workflows": ["video-ltx-1p","video-ltx-2p","video-ltx-3p","video-ltx-4p"],
    "hardware": {
      "gpu_min_vram_gb": 24,          // draft, подтвердить
      "nvidia_driver_min": "550.x",
      "cuda_tier": "12.4"
    }
  }],

  "comfyui": {
    "required_version": "v0.27.0",     // exact tested pin (см. start-video.sh)
    "min_version": "v0.27.0",
    "max_tested_version": "v0.27.0",
    "install_source": {
      "kind": "github",
      "repository": "https://github.com/comfyanonymous/ComfyUI.git"
    },
    "compatibility_policy": "exact-pin-preferred | range-if-approved",
    "policy_notes": "см. §10"
  },

  "python": {
    "min_version": "3.10",
    "torch": { "pin": "2.6.0+cu124", "index_url": "https://download.pytorch.org/whl/cu124" },
    "lock_file": true                  // pip freeze lock, как в start-video.sh
  },

  "dependencies": [ /* массив записей §8.3 */ ],

  "worker": {
    "bundle_source": { "kind": "animastor", "path": "worker/worker/" },
    "min_worker_version": "v2.0.0",
    "env_template": "worker/worker/.env.example",
    "required_env": ["HUB_URL","ANIMASTOR_WORKER_TOKEN","WORKER_TYPE","WORKER_ID"],
    "optional_env": ["COMFY_PORT","COMFY_INPUT_DIR","WORKER_JOURNAL_DIR","NOTEBOOK_PATH"]
  },

  "disk_budget": { "estimated_total_bytes": 0 },  // сумма size_bytes, заполняется research'ом

  "verification": {
    "method": "audit-diff",
    "audit_script": "scripts/animastor-runtime-audit.sh",
    "pass_criteria": "все required=installed; missing=∅",
    "warn_criteria": "unknown/unused > 0"
  }
}
```

Хранение: `backend/ai/install-manifests/{type}/{profile}.json` — рядом с
профилями, но отдельное дерево, чтобы не смешивать prompt-assembly и
install-семантику. (Альтернатива — вложить в профиль; см. §16.)

## 10. Version compatibility strategy (ComfyUI)

Поля: `required_version` (точный tested pin), `min_version`,
`max_tested_version`, install source, policy.

Политика по умолчанию — **exact-pin-preferred**:

| Ситуация | Действие |
|---|---|
| нет ComfyUI | клонировать/checkout `required_version` |
| версия == required | OK, пропустить |
| версия внутри [min, max_tested] но ≠ required | OK с предупреждением (range-if-approved) |
| версия < min_version | предложить upgrade до required; отказ → abort с объяснением |
| версия > max_tested_version | НЕ понижать молча; спросить пользователя: downgrade до pin ИЛИ продолжить at-your-own-risk (запись в state) |
| не git-репозиторий / версия не определяется | сценарий D/unknown — спросить пользователя |

Upgrade/downgrade выполняется через `git fetch tag && checkout -f`
(как в существующем `start-video.sh`), с сохранением `custom_nodes/`,
`models/`, `user/`. Перед сменой версии — обязательный checkpoint состояния
(§14). После смены — reinstall зависимостей из `requirements.txt` +
requirements всех custom nodes.

Pin обновляется только через новую ревизию manifest'а после того, как
комбо «ComfyUI + torch + ноды» проверено реальной генерацией (golden run)
— см. также практику lock-файла в `start-video.sh`.

## 11. Installer lifecycle

```
Phase 0  Preflight
         - OS/arch, disk space (≥ disk_budget), RAM
         - nvidia-smi: GPU present, VRAM vs profile.hardware
         - network reachability: GitHub, HF, Animastor origin
         - права: не запускать от root без необходимости; писать в $HOME

Phase 1  System runtime
         - Node.js ≥18 (nodesource), git, curl — как в start-worker.sh
         - Python + venv

Phase 2  ComfyUI
         - обнаружение (те же эвристики, что в audit script)
         - применение политики §10 (сценарии A–D)

Phase 3  Python deps
         - requirements ComfyUI (из lock-файла при наличии)
         - torch pin с CUDA index
         - requirements каждого custom node

Phase 4  Custom nodes
         - для каждой записи type=custom_node: clone/pin или skip (F/G)

Phase 5  Models
         - pre-check: свободное место ≥ size_bytes
         - download в *.part → rename по завершении (H/I/J-safe)
         - checksum verify (если задан)

Phase 6  Worker bundle
         - deploy файлов worker'а в ~/animastor/worker/
         - npm install (node-fetch)

Phase 7  .env + Worker Key
         - создать/обновить .env (merge, не затирать чужие ключи)
         - интерактивно запросить ANIMASTOR_WORKER_TOKEN
           (hidden input, без echo в логи; проверка формата wrk.<id>.<secret>)
         - WORKER_TYPE из профиля; HUB_URL default https://animastor.in/gpu

Phase 8  Start & register
         - stop старых worker-процессов (как в start-worker.sh §9)
         - start worker → дождаться успешной регистрации в Hub
           (heartbeat/registry confirmation в логе worker'а)

Phase 9  Final verification
         - worker process alive; registered; ComfyUI /system_stats OK
         - smoke-возможность: тестовая задача (открытый вопрос, §16)
         - optional: прогон runtime-audit → diff против manifest → отчёт
           (PASS / WARN(unknown, unused) / FAIL(missing))

Выход: печатается summary: что установлено, что пропущено, где логи,
как перезапускать worker (start-worker.sh <type>).
```

CLI (draft):

```
animastor-installer --profile video/ltx-2.3 [--dry-run] [--yes]
                    [--env-file PATH] [--skip-models] [--resume]
--dry-run   : только resolution report, ничего не менять
--yes       : не спрашивать подтверждений (кроме Worker Key)
--resume    : продолжить прерванную установку по state file
```

## 12. Worker configuration / .env

Используется существующий формат `worker/worker/.env.example`:

- REQUIRED: `HUB_URL`, `ANIMASTOR_WORKER_TOKEN` (wrk.…), `WORKER_TYPE`,
  `WORKER_ID`;
- OPTIONAL: `COMFY_PORT`, `COMFY_INPUT_DIR`, `WORKER_JOURNAL_DIR`,
  `NOTEBOOK_PATH`.

Правила installer'а:
- merge-семантика: существующий `.env` не перезаписывается целиком;
  обновляются только ключи installer'а; существующий токен НЕ трогается
  (если валиден) — это делает rerun безопасным;
- права на файл: `chmod 600`;
- значения никогда не печатаются (тот же принцип redaction, что в audit
  script'е: секретные KEY=value → `KEY=<REDACTED>`).

Worker Key UX: **пользовательский секрет**, вводится интерактивно в Phase 7.
Не принимать токен через CLI-argv (виден в `ps`); допустимо — через
stdin/prompt или переменную окружения на свой страх.

## 13. Version compatibility (общая модель)

| Компонент | Как пинится |
|---|---|
| ComfyUI | git tag/commit (§10) |
| custom_node | git commit/tag per entry |
| model | source revision + checksum + size |
| python/torch | explicit pin + index-url + pip lock |
| worker | min_worker_version в manifest; bundle поставляется из origin |
| driver/CUDA | проверяется preflight, не устанавливается installer'ом (v1) |

Совместимость manifest ↔ workflows: manifest хранит список workflows, из
которых выведены зависимости (`provenance.derived_from_workflow`). При
изменении workflow JSON (новый class_type/file ref) CI-check должен
флаговать: «workflow изменился → manifest требует ревизии». Это защищает
от дрейфа между источником истины и manifest'ом.

## 14. Error handling / rollback strategy

Сценарии (обязательные к обработке):

| # | Сценарий | Политика |
|---|---|---|
| A | ComfyUI отсутствует | установить exact-pin; если GitHub недоступен — fail с retry-подсказкой |
| B | ComfyUI совместим | skip, зафиксировать в state |
| C | Версия слишком старая (< min) | предложить upgrade до pin; отказ → abort (не работать на неподдерживаемой версии) |
| D | Версия новее max_tested | спросить: downgrade до pin / continue-at-own-risk; молча ничего не менять |
| E | Dependency отсутствует | скачать по manifest (Phase 4/5) |
| F | Dependency уже установлена (совпадает) | skip + verify (filename+revision; checksum — если дёшево) |
| G | Установлена, но другая версия | политика per-type: model → заменить (после бэкапа имени) или спросить; custom_node → checkout на pin (git-safe) или спросить; python → привести к pin |
| H | Download interrupted | `.part`-файлы, resume/range при поддержке источника, иначе удалить part и начать заново при rerun |
| I | Checksum mismatch | удалить файл, FAIL шага, не продолжать с битой моделью; чёткое сообщение |
| J | Rerun installer | идемпотентно: по state file + фактическому состоянию машины повторно вычислить missing и доделать; уже сделанное — skip |
| K | Partial installation | state file (`~/animastor/install-state.json`) пишет каждый завершённый шаг; `--resume` продолжает; повторный запуск без resume тоже безопасен (check-before-do) |
| L | Worker registration failure | различать причины: неверный токен (401/fail-closed) → повторный ввод ключа; сеть/HUB недоступен → retry с backoff; Hub отверг тип → сообщение о несоответствии WORKER_TYPE |

Rollback:
- v1 — **forward-only с checkpoint'ами**, без полного undo (полный rollback
  моделей на десятки GiB нецелесообразен).
- Перед изменением ComfyUI версии / заменой существующих файлов —
  checkpoint: записать предыдущий commit/tag и список заменённых файлов в
  state; дать команду `--rollback-last` для возврата ComfyUI на предыдущий
  pin (модели не трогаются).
- Любой FAIL оставляет машину в консистентном состоянии: частичные
  `.part`-файлы удаляются, state помечает шаг как failed с причиной.

## 15. Idempotency & Security

Idempotency:
- каждый шаг = pure function от (manifest, фактическое состояние) → действие;
- check-before-do везде: наличие, версия, checksum;
- повторный запуск после успеха — no-op с отчётом;
- state file — оптимизация, а не источник истины (истина — диск).

Security:
- Worker Key: интерактивный ввод, hidden, chmod 600 на .env, redaction в
  любых логах (по списку SECRET_NAMES из audit script);
- токен не в argv, не в state file, не в логах, не в git;
- downloads: только HTTPS, checksum обязательное поле схемы (value может
  появиться после research); без checksum — минимум size sanity check;
- installer не открывает наружу портов (ComfyUI слушает 127.0.0.1, как в
  start-video.sh); весь трафик — исходящие соединения к Hub;
- не запускать произвольный код из сторонних источников кроме как через
  стандартные механизмы (pip requirements нод, git clone) — риск принят,
  задокументирован;
- HF_TOKEN (если нужен для gated-моделей) — опциональный ввод, те же
  правила хранения, что для worker key.

## 16. Open questions

1. Расположение manifest: `backend/ai/install-manifests/` vs вложенность в
   `backend/ai/profiles/**`. Требуется ли manifest'у доставка на машину
   через origin (и тогда — endpoint на backend/hub)?
2. ComfyUI registry / ComfyUI-Manager как канал установки custom nodes —
   использовать или ограничиться прямым GitHub?
3. Нужен ли smoke-test генерации в Phase 9 (требует отправки тестовой
   задачи через Hub — затрагивает production очередь) или достаточно
   health/registration проверки?
4. Multi-profile на одной машине: несколько worker-процессов с одним
   ComfyUI? Пока v1 = один profile, но схема каталогов должна это учитывать.
5. Gated Hugging Face модели: какие требуют токена? (research)
6. `qwen3-tts` node и `gguf` (plain dir без git в audio-аудите): как
   представлять non-git custom node installs в manifest?
7. Обновление worker bundle: auto-update при rerun installer'а или
   отдельный путь обновления?
8. Драйвер NVIDIA: оставить вне scope installer'а навсегда или добавить
   проверку минимальной версии в manifest.hardware?
9. Кто владеет процессом подтверждения checksum'ов моделей (человек в
   цикле)? Нужен лёгкий процесс «research → review → manifest revision».
10. Связь с будущим RunPod provisioning: installer = то, что выполняется
    внутри Pod'а при provider-based создании воркера? (Да по смыслу, но
    интерфейс запуска не определён.)

## 17. Recommended next steps

1. **Workflow dependency extraction (research, read-only):** прогнать
   скан class_type/file-ref по всем production workflows
   (`tts-qwen-*`, `img-qwen-image`, `video-ltx-*`) и получить черновые
   таблицы зависимостей по трём профилям. Результат — input для manifest
   draft'ов. Не скачивать ничего.
2. **Manifest schema v0 → два пилотных manifest'а** (рекомендуется
   `image/qwen-image` — самый маленький footprint ~22G, затем
   `video/ltx-2.3`): заполнить записи с подтверждёнными repository/URL,
   sizes, checksums; зафиксировать ComfyUI pin'ы per profile (сейчас в
   аудитах разные: v0.27.0 vs форк c4cfee7a — требуется решение).
3. **Installer skeleton (Phase 0–2 + dry-run):** реализовать preflight,
   ComfyUI detection/policy и resolution-report в режиме `--dry-run`,
   переиспользуя логику audit script'а; только после этого — фазы записи.

---

### Связанные документы

- `ARCHITECTURE.md` — карта репозитория
- `docs/runtime-audits/README.md` — роль аудитов и verified delivery chain
- `docs/06-workflows/WORKFLOW_ARCHITECTURE.md` — three-layer workflow model
- `worker/worker/.env.example`, `worker/start-worker.sh`, `worker/start-video.sh`
- `docs/04-planning/RunPod_Integration_GPU_Hub.md` — будущий provider-based provisioning
- `docs/04-planning/private-worker-installer-dependency-research.md` — factual dependency research (Phase 1 input)
- `docs/04-planning/private-worker-installer-manifest-resolver.md` — Phase 1 implementation: manifests + resolver + evidence taxonomy + runtime modes
- `docs/04-planning/private-worker-installer-phase15.md` — Phase 1.5: existing ComfyUI, workflows as first-class artifacts, flexible profile mode, interactive flow, safety rules
