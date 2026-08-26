# Private Worker Installer — Dependency Research

> **Status:** research only. No implementation, no runtime changes, no profile
> schema changes, no downloads, no model/node installation.
> **Date:** 2026-08-26
> **Scope:** Generation Profiles `audio/qwen-tts`, `image/qwen-image`,
> `video/ltx-2.3` и их фактические production dependencies.
> **Companion docs:** `docs/04-planning/private-worker-installer-architecture.md`
> (architecture draft), `docs/architecture/LINUX_INSTALLER_RECONNAISSANCE.md`
> (предыдущая разведка), `docs/runtime-audits/README.md` (verified delivery chain).

---

## 1. Executive Summary

Исследование ответило на фундаментальный вопрос: **источником истины для
install manifest является production workflow JSON**
(`backend/ai/workflows/*.json`), связанный с профилем через поле
`profile.{type}Profile` в connector'е. **Connector'ы — это backend-side
execution metadata**: они живут только на VPS, патчат workflow JSON до
отправки и **не пересекают границу GPU-воркера**. Installer НЕ должен
устанавливать connector'ы.

Ключевые установленные факты:

1. **Цепочка подтверждена кодом:** Profile (prompt-assembly) → Connector
   (entity→node bindings) → Workflow (ComfyUI API JSON) → `task.params`
   через GPU Hub → `worker.cjs` → `POST http://127.0.0.1:8188/prompt`.
   Workflow JSON доставляется на воркер по сети в runtime; на диске воркера
   workflow-файлы не требуются (`docs/runtime-audits/README.md:19-52`,
   `worker/worker/worker.cjs:310-339`).
2. **Connector не добавляет runtime-зависимостей.** Его
   `compatibility.nodeClasses` — подмножество `class_type` того же workflow
   (валидируется при старте backend'а, `connector-loader.js:204-311`).
   Model references в connector'ах отсутствуют. Единственный
   installer-релевантный артефакт connector'а — `workflowHash` (sha256
   workflow JSON) — может использоваться для drift-проверки, но не для
   установки.
3. **Найдено 7 production workflows**: `tts-qwen-narrator`,
   `tts-qwen-dialogue`, `img-qwen-image`, `video-ltx-{1,2,3,4}p`
   (4 видео-варианта идентичны по зависимостям, различаются только числом
   нод `LTXVAddGuide`). Legacy `old_*` исключены загрузчиком
   (`workflow-loader.js:29`).
4. **Model inventory выведен из workflows**: audio — 2 ModelScope-репо
   (ставятся самим custom node'ом, `auto_download: true`); image — 4 файла
   (~21 GB); video — 7 файлов (~30 GB). Все target-каталоги подтверждены
   runtime-аудитами.
5. **Custom nodes**: audio — `ComfyUI-Qwen3-TTS` (единственный required);
   image — `ComfyUI-GGUF` (единственный required); video — `ComfyUI-GGUF` +
   `comfyui-kjnodes` (с обязательным AudioVAE-патчем) + вероятно
   `comfyui-videohelpersuite`; часть class_type видео-workflow не
   атрибутирована однозначно (UNKNOWN — требуется проверка `/object_info`
   на референсном инстансе).
6. **Единой runtime policy сейчас нет**: video-инстанс работает на
   официальном ComfyUI `v0.27.0` + torch `2.6.0+cu124`; audio/image-инстансы
   — на форке `rajsingh1-dev/ComfyUI` (commit `c4cfee7`) + torch
   `2.10.0+cu128`. Требуется решение (§9, §14).
7. **Аудиты как reference**: во всех трёх аудитах required-зависимости
   присутствуют (MISSING = ∅); найдено значительное число UNUSED-компонентов
   (операторские ноды, UI-тестовые workflow, upscaler-модель), которые НЕ
   должны попадать в manifest.

---

## 2. Current Architecture

### 2.1 Фактическая цепочка (подтверждена кодом)

```
                 BACKEND / VPS
┌─────────────────────────────────────────────────────────────┐
│ backend/ai/profiles/**.json      (prompt-assembly: секции,  │
│                                   defaults, video-метаданные)│
│ backend/ai/skills/**.md          (LLM-prompting rules)      │
│ backend/ai/connectors/conn-*.json(entity→nodeId bindings)   │
│ backend/ai/workflows/*.json      (ComfyUI API-format JSON)  │
│                                                             │
│ startup: workflow-loader.js:25-76 грузит workflows,         │
│          connector-loader.js:553-593 валидирует коннекторы  │
│ dispatch: сервис патчит workflow через connector            │
│          (connector-loader.setValue, connector-loader.js:401)│
│          gpu-dispatcher.sendUnified → POST {HUB_URL}/task   │
│          (gpu-dispatcher.js:101-182)                        │
└──────────────────────────┬───────────────────────────────┘
                           │ task = { job_id, params: <patched workflow JSON>,
                           │          job_type, assets, dispatch_id, ... }
                           ▼
                    GPU Hub (gpu-hub/gpu-hub.js)
                    Redis list: animastor:queue:{type}[:ws:{workspace}]
                           │ GET /task/next (Bearer wrk.… token)
                           ▼
                      GPU Worker
                    worker/worker/worker.cjs — stateless bridge:
                    runWorkflow() → POST http://127.0.0.1:8188/prompt
                    { prompt: task.params, client_id }  (worker.cjs:310-339)
                           │
                           ▼
                        ComfyUI
                    custom_nodes + models + torch/CUDA
                    output → /history + файлы → base64 → hub → backend
```

Граница подтверждена:

- Worker никогда не читает `backend/ai/*`: ни profiles, ни connectors, ни
  workflow-файлы (`worker/worker/worker.cjs` — единственный consumer
  `task.params`; `docs/runtime-audits/README.md:19-52`).
- Workflow JSON не хранится на GPU-боксе для production; пустой
  `~/ComfyUI/user/default/workflows/` — ожидаемое состояние
  (`docs/runtime-audits/README.md:47-52`;
  `docs/runtime-audits/image-qwen/...md:70-103` — локальные workflow-файлы
  явно помечены как UI test artifacts).
- Backend не может стартовать без workflows+connectors:
  `backend.cjs:307-316` → `process.exit(1)` при ошибке загрузки. Это
  boot-critical backend-конфигурация, а не worker-зависимость.

### 2.2 Компоненты и их владельцы

| Компонент | Расположение | Владелец | Кто потребляет |
|---|---|---|---|
| Profiles | `backend/ai/profiles/{type}/{name}.json` | VPS | `ai-loader.js:213-219` → `assembly-profile.js:93-97` → prompt builders |
| Skills | `backend/ai/skills/{type}/{name}.md` | VPS | `prompt-profile-loader.js:27-33` → agent pipeline |
| Connectors | `backend/ai/connectors/conn-*.json` | VPS | `connector-loader.js:141-178` → сервисы audio/image/video |
| Workflows | `backend/ai/workflows/*.json` | VPS | `workflow-loader.js:25-76`; в runtime уходят на воркер как `task.params` |
| Worker bundle | `worker/worker/worker.cjs` + cleanup/journal | GPU-бокс | ставится вручную / hub `GET /worker-source` (`gpu-hub.js:1050-1060`) |
| ComfyUI + nodes + models | `~/ComfyUI` на GPU-боксе | GPU-бокс | ComfyUI runtime |

---

## 3. Generation Profiles

### 3.1 Инвентаризация

Все три профиля: `backend/ai/profiles/{audio,image,video}/*.json`.
Загружаются рекурсивно (`ai-loader.js:84-113, 213-219`), кэш 60 с.

| Поле | audio/qwen-tts | image/qwen-image | video/ltx-2.3 |
|---|---|---|---|
| `profile` | `qwen-tts` | `qwen-image` | `ltx-2.3` |
| `type` | `audio` | `image` | `video` |
| `model` | `Qwen3-TTS` | `Qwen2.5-VL` (*) | `LTX-2.3` |
| `workflow` | `tts-qwen-*` (glob) | `img-qwen-image` | `video-ltx-*` (glob) |
| `skill` | `audio/qwen-tts` | `image/qwen-image` | `video/ltx-2.3` |
| `assembly.sections` | voiceInstruction, defaultInstruct | 14 секций (renderMode…quality) | characters, storyboard, renderInfo |
| `assembly.defaults` | defaultInstruct: "" | quality, negativeBase | negativeBase |
| `video` | — | — | frameAlignment: 8, requiresTrim: true, requiresKeyframeForcing: true |

(\*) Замечание: `model: "Qwen2.5-VL"` в image-профиле — это text encoder;
фактическая diffusion-модель — Qwen-Image (см. §7). Поле `model` — UX-лейбл.

### 3.2 Как профиль связан с connector'ом и workflow

Направление связи — **от connector'а к профилю**, не наоборот:

- Connector содержит `profile.{audioProfile|imageProfile|videoProfile}`
  (например, `conn-video-1p.json:8-10` → `videoProfile: "ltx-2.3"`).
- Resolution: user override (Settings, Redis
  `animastor:prompt-profiles`) → connector's profile field → null
  (`backend/src/services/profile-override.js:1-26`;
  `backend/src/audio/generation.js:30-33`).
- Профиль НЕ содержит поля, ссылающегося на connector.

**Важно:** поле `workflow` в профиле (`"tts-qwen-*"`, `"video-ltx-*"`)
**не читается кодом нигде** (проверено grep по
`assembly-profile.js`/`ai-loader.js` и всем потребителям
`resolveAssembly`). Реальный выбор workflow захардкожен в сервисах:

| Профиль | Фактический выбор workflow | Код |
|---|---|---|
| qwen-tts | `tts-qwen-narrator` / `tts-qwen-dialogue` (по типу сцены) | `audio/generation.js:19-20` |
| qwen-image | `img-qwen-image` | `image/iu-processor.js:182`, `image/connector-utils.js:8` |
| ltx-2.3 | `` `video-ltx-${groupSize}p` `` (1–4 картинки в группе) | `workflows/video/video-workflows.js:634` |

### 3.3 Что профиль уже содержит vs что нужно Installer'у

**Уже существует:** только prompt-assembly метаданные (секции, defaults)
и video-метаданные постобработки (frameAlignment/trim/keyframes —
используются в `video/video-merge.js:27-39`). Никаких runtime/install
полей нет — это подтверждено и ранее
(`LINUX_INSTALLER_RECONNAISSANCE.md:14-28`).

**Потенциально понадобится Installer'у** (по
`private-worker-installer-architecture.md` §5.1, §9 — draft, не решать здесь):

- ссылка на install spec / manifest (id профиля как ключ установки);
- hardware requirements (min VRAM, CUDA tier);
- ComfyUI version policy per profile;
- формализация поля `workflow` (сейчас декоративное) как перечня
  production workflows профиля.

Profile schema в этом исследовании **не менялась**.

---

## 4. Connector Architecture

### 4.1 Что такое connector в текущей архитектуре

Connector — декларативный JSON-контракт между backend-сущностями Animastor
и нодами конкретного ComfyUI workflow
(`docs/06-workflows/CONNECTOR_ARCHITECTURE.md` §2). Файлы:
`backend/ai/connectors/conn-*.json` (загрузчик принимает только файлы с
префиксом `conn-`, `connector-loader.js:151`).

Структура (все 7 файлов):

| Поле | Назначение |
|---|---|
| `connectorVersion` | версия коннектора (`1.0.0` у всех) |
| `workflow` | имя workflow-файла без `.json` |
| `workflowHash` | sha256 workflow JSON; пустые значения автозаполняются при старте (`connector-loader.js:561-568`) |
| `label`, `description`, `type`, `metadata` | UX/описательные |
| `profile.{type}Profile` | **связь с Generation Profile** |
| `compatibility.nodeClasses` | map nodeId → ожидаемый class_type |
| `inputs` / `outputs` / `parameters` | bindings: entityKey → { nodeId, field, expectedClass, default, min/max } |
| `guideNodes` | только video: bindings LTXVAddGuide (frame_idx/strength/image) |

### 4.2 Production connector'ы и их связи

| Connector | Workflow | Profile (`profile.*`) | Что передаёт в workflow | Что читает из результата |
|---|---|---|---|---|
| `conn-tts-narration.json` | `tts-qwen-narrator` | `audioProfile: qwen-tts` | narrationText→108.text, voiceInstruction→108.voice_instruction, seed/language/temperature→108, quality/filename→1008 | generatedAudio (node 1008 SaveAudioMP3) |
| `conn-tts-dialogue.json` | `tts-qwen-dialogue` | `audioProfile: qwen-tts` | dialogueScript→108.script, defaultInstruct→108, character{1,2,3}Voice→71/80/82, roleName{1,2,3}→74, seed/temperature→75, quality/filename→1008 | generatedAudio (1008) |
| `conn-image-generation.json` | `img-qwen-image` | `imageProfile: qwen-image` | positivePrompt→108.text, negativePrompt→109.text, width/height→110, steps/cfg/sampler/scheduler/seed→120, filename→1008 | generatedImage (1008 SaveImage) |
| `conn-video-1p.json` | `video-ltx-1p` | `videoProfile: ltx-2.3` | sourceImages→216 (LoadImage), prompts→121/110, totalFrames→112, fps→129, cfg→128, guideStrength_0→214, filename→75 | generatedVideo (75 SaveVideo) |
| `conn-video-2p.json` | `video-ltx-2p` | `videoProfile: ltx-2.3` | то же + guide bindings 199, 214 | generatedVideo |
| `conn-video-3p.json` | `video-ltx-3p` | `videoProfile: ltx-2.3` | то же + guide bindings 199, 200, 214 | generatedVideo |
| `conn-video-4p.json` | `video-ltx-4p` | `videoProfile: ltx-2.3` | то же + guide bindings 199, 200, 201, 214 | generatedVideo |

### 4.3 Ответы на поставленные вопросы

**Как происходит связь Backend → Connector → Workflow → ComfyUI → GPU
Worker?** Именно так, с уточнением: connector существует только на шаге
«Backend патчит Workflow». Дальше идёт уже готовый JSON:
`setValue()` (`connector-loader.js:401-422`) → `gpu.sendUnified()`
(`gpu-dispatcher.js:101-182`) → hub → worker → ComfyUI `/prompt`
(`worker.cjs:310-339`). Connector не «вызывает» workflow — он описывает,
куда в нём писать.

**Какие данные connector передаёт в workflow?** Только значения сущностей
(тексты промптов, голоса, имена ролей, размеры, seed, strength guide'ов,
filename prefix) по bindings `nodeId`+`field`. Изображения передаются НЕ
через connector: reference-кадры видео приходят в `task.assets.images`
(base64) и кладутся worker'ом в `COMFY_INPUT_DIR` как `{scene}_{unit}.png`
(`worker.cjs:600-624`), а имена файлов в `LoadImage`-ноды вписывает
`video-workflows.js:372-390`.

**Какие данные workflow возвращает?** Ничего «через connector»: результат —
это файлы ComfyUI (`output/`), которые worker находит по output-нодам
(`SaveImage*`/`SaveAudio*`/`SaveVideo*`/`CreateVideo*`,
`worker.cjs:145-157`) и шлёт base64 в hub (`worker.cjs:509-527`).
Output-связь connector'а (`outputs.generatedVideo` и т.п.) используется
backend'ом декларативно (для понимания, какая нода — выход), фактический
поиск — по префиксу class_type в worker'е.

**Есть ли у connector'а:**

- profile — **да**, `profile.{type}Profile` (единственная связь с
  Generation Profile);
- workflow — **да**, поле `workflow` (имя файла);
- workflow_id — **да**, `workflowHash` (sha256, автозаполняется;
  проверка при старте `connector-loader.js:208-218`);
- model references — **нет** (ни в одном из 7 файлов);
- node references — **да**, все bindings и `compatibility.nodeClasses`;
- параметры ComfyUI — **нет** (нет URL/портов/аргументов запуска);
- другие dependency references — **нет**.

**Есть ли connector-specific зависимости, не видные из workflow JSON?**
**Нет.** `compatibility.nodeClasses` каждого connector'а — строгое
подмножество `class_type` его workflow (проверено: все nodeId из
compatibility присутствуют в workflow; валидатор это гарантирует,
`connector-loader.js:221-241`). Connector не вносит ни одного нового
class_type, файла модели или пакета.

**Может ли один connector использовать несколько workflow?** В текущей
схеме — нет: поле `workflow` одно, загрузка 1:1
(`connector-loader.js:185-194` индексирует connector по имени workflow).

**Может ли один workflow использоваться несколькими connector/profile?**
Технически индекс допускает lookup по имени, но фактически сейчас —
строго 1 workflow : 1 connector : 1 profile
(7 connector'ов на 7 workflow).

**Есть ли зависимости между connector'ом и установленным
Worker/ComfyUI runtime?** Косвенная: connector валиден, пока совпадают
`workflowHash` и nodeIds/class'ы в workflow. Если на воркере ComfyUI не
знает какой-то class_type — упадёт выполнение задачи на GPU-боксе, но не
connector. Прямой зависимости connector → runtime нет.

### 4.4 Граница: connector в install manifest или только backend metadata?

**Установлено по коду: connector — BACKEND ONLY.**

Доказательства:

1. Worker не имеет кода, читающего connector'ы
   (`worker/worker/worker.cjs` — 734 строки, единственные входы: env vars,
   `task.params`, `task.assets`, ComfyUI HTTP API).
2. Hub оперирует opaque `task.params` (`gpu-hub.js:661-688`) — содержимое
   workflow JSON ему не нужно, connector'ы тем более.
3. Connector'ы грузятся и валидируются только в backend-процессе
   (`backend.cjs:307-316`), каталог монтируется в backend-контейнер
   (`docker-compose.yml:86-89`), а не в worker.
4. Delivery-модель: на GPU-бокс приходит уже пропатченный workflow JSON —
   «следы» connector'а (конкретные значения в нодах) внутри `task.params`
   есть, сам connector — нет.

**Вывод для Installer:** installer НЕ устанавливает connector'ы. Это
явно фиксируется. Единственное, что installer может *знать* о connector'ах
(опционально, для drift-верификации): `workflowHash` и ожидаемый набор
class_type — но эти данные installer может вывести и прямо из workflow
JSON. Решение — §11, статус BACKEND ONLY.

**Замечание о хрупкости (зафиксировано, не менять):** merged-dialogue путь
audio (`audio/generation.js:51-137`) патчит ноды 108/71/80/82/74 напрямую
по hardcoded id, минуя connector; hardcoded-fallback'и есть и в
per-segment пути (`generation.js:492, 521-524, 543-546`). На install
footprint это не влияет (те же ноды/модели), но показывает, что connector
— не единственный consumer структуры workflow.

---

## 5. Profile → Connector → Workflow Mapping

```
audio/qwen-tts ─┬─ conn-tts-narration ──→ tts-qwen-narrator.json   (62 строки, 3 ноды)
                └─ conn-tts-dialogue ───→ tts-qwen-dialogue.json   (246 строк, 12 нод)

image/qwen-image ── conn-image-generation → img-qwen-image.json    (153 строки, 11 нод)

video/ltx-2.3 ─┬─ conn-video-1p ─→ video-ltx-1p.json  (639 строк, 43 ноды, 1×LTXVAddGuide)
               ├─ conn-video-2p ─→ video-ltx-2p.json  (668 строк, 44 ноды, 2×LTXVAddGuide)
               ├─ conn-video-3p ─→ video-ltx-3p.json  (698 строк, 45 нод, 3×LTXVAddGuide)
               └─ conn-video-4p ─→ video-ltx-4p.json  (728 строк, 46 нод, 4×LTXVAddGuide)

legacy (НЕ production, исключены загрузчиком по префиксу old_, workflow-loader.js:29):
  old_img-qwen-image.json  — отличается квантом CLIP (Q4_K_M вместо Q8_0) — footgun
  old_video-ltx.json       — тот же video model set
```

Все 7 production workflow — в формате ComfyUI **API** (dict nodeId →
{inputs, class_type, _meta}), не UI-формат. Это формат, который
отправляется в `/prompt` как есть.

Что каждый workflow ожидает от runtime:

| Ожидание | Кто обеспечивает |
|---|---|
| ComfyUI HTTP API `/prompt`, `/history`, `/system_stats`, `/view` на `127.0.0.1:8188` | ComfyUI (запуск — `start-video.sh:65` / вручную) |
| Все class_type зарегистрированы (core + custom nodes) | ComfyUI + custom_nodes |
| Файлы моделей в соответствующих `models/<subdir>/` | установка (сейчас вручную; цель — installer) |
| `input/` каталог доступен для записи (video reference frames) | worker `COMFY_INPUT_DIR` (`worker.cjs:51, 600-624`) |
| `output/` каталог, для video — `output/video/*.mp4` fallback-скан | worker `COMFY_OUTPUT_DIR` (`worker.cjs:52, 421-433`) |
| Сеть до ModelScope при первом запуске TTS (если модели не предзагружены) | `Qwen3TTSLoader.auto_download: true` |
| ffmpeg-совместимое кодирование видео/аудио (CreateVideo/SaveVideo, SaveAudioMP3) | зависимости пакетов нод (imageio-ffmpeg и т.п.; см. MEMORY.md:112) |

---

## 6. Workflow → Custom Node Mapping

### 6.1 Полная таблица class_type

**tts-qwen-narrator / tts-qwen-dialogue (profile audio/qwen-tts):**

| class_type | Ноды | Пакет | Источник | Версия/ревизия |
|---|---|---|---|---|
| `Qwen3TTSVoiceDesign` | 108 (narrator); 71, 80, 82 (dialogue) | `ComfyUI-Qwen3-TTS` | `https://github.com/wanaigc/ComfyUI-Qwen3-TTS` | commit `2ee1131` (audio-аудит) |
| `Qwen3TTSLoader` | 78 (оба); 79 (dialogue) | `ComfyUI-Qwen3-TTS` | то же | то же |
| `Qwen3TTSVoiceClonePrompt` | 73, 81, 83 | `ComfyUI-Qwen3-TTS` | то же | то же |
| `Qwen3TTSRoleBank` | 74 | `ComfyUI-Qwen3-TTS` | то же | то же |
| `Qwen3TTSAdvancedDialogue` | 75 | `ComfyUI-Qwen3-TTS` | то же | то же |
| `Qwen3TTSScriptProcessor` | 108 (dialogue) | `ComfyUI-Qwen3-TTS` | то же | то же |
| `SaveAudioMP3` | 1008 (оба) | `ComfyUI-Qwen3-TTS` (атрибуция по исключению — см. ниже) | то же | то же |

Атрибуция `SaveAudioMP3`: в ComfyUI core есть `SaveAudio`, но не
MP3-вариант; на работающем audio-инстансе из custom nodes стоят только
`comfyui-manager` и `qwen3-tts` (аудит `[6]`), значит `SaveAudioMP3`
предоставляется пакетом `qwen3-tts`. **Высокая уверенность, требуется
подтверждение** (`/object_info` на инстансе).

**img-qwen-image (profile image/qwen-image):**

| class_type | Ноды | Пакет | Источник | Версия/ревизия |
|---|---|---|---|---|
| `UnetLoaderGGUF` | 10 | `ComfyUI-GGUF` | `https://github.com/city96/ComfyUI-GGUF` (атрибуция по имени пакета; URL в репо не зафиксирован — NEEDS VERIFICATION) | commit `6ea2651` (image-аудит) |
| `CLIPLoaderGGUF` | 11 | `ComfyUI-GGUF` | то же | то же |
| `VAELoader`, `CLIPTextEncode`, `EmptySD3LatentImage`, `KSampler`, `VAEDecode`, `SaveImage`, `LoraLoaderModelOnly`, `ModelSamplingAuraFlow` | 12, 108, 109, 110, 120, 130, 1008, 1010, 1011 | **ComfyUI core** | — | в составе ComfyUI |

**video-ltx-{1,2,3,4}p (profile video/ltx-2.3)** — единый набор на все 4
workflow (различается только количество `LTXVAddGuide`):

| class_type | Ноды (1p) | Пакет | Основание |
|---|---|---|---|
| `UnetLoaderGGUF` | 141 | `ComfyUI-GGUF` | GGUF-лоадер; установлен на video-инстансе |
| `DualCLIPLoaderGGUF` | 227 | `ComfyUI-GGUF` | то же |
| `VAELoaderKJ` | 222, 226 | `comfyui-kjnodes` (KJNodes) | подтверждено `worker/new/SYSTEM.md:45` («VAELoaderKJ и др.») + AudioVAE-патч (§8 SYSTEM.md) |
| `LoraLoaderModelOnly`, `VAELoader`, `CLIPTextEncode`, `KSamplerSelect`, `RandomNoise`, `SamplerCustomAdvanced`, `CFGGuider`, `VAEDecodeTiled`, `EmptyImage`, `LoadImage`, `GetImageSize` | 188, 191, 110/121, 135, 115, 172, 128, 205, 111, 149/179/187/216, 105 | **ComfyUI core** | стандартные ноды core |
| `LTXVConditioning`, `EmptyLTXVLatentVideo`, `LTXVPreprocess`, `LTXVCropGuides`, `LTXVAddGuide`, `LTXVChunkFeedForward` | 107, 108, 152/180/186/213, 203, 214, 211 | **вероятно ComfyUI core (comfy_extras/nodes_ltxv*)** | см. обоснование ниже |
| `LTXVConcatAVLatent`, `LTXVSeparateAVLatent`, `LTXVEmptyLatentAudio`, `LTXVAudioVAEDecode` | 109, 116, 171, 204 | **вероятно ComfyUI core (LTX-2 AV support v0.27.0)** | см. обоснование ниже |
| `LTX2SamplingPreviewOverride` | 190 | **UNKNOWN — NEEDS VERIFICATION** | кандидаты: core v0.27.0 / kjnodes |
| `ManualSigmas` | 164 | **UNKNOWN — NEEDS VERIFICATION** | кандидаты: core / kjnodes / rgthree |
| `ResizeImageMaskNode` | 206, 209, 210, 215 | **UNKNOWN — NEEDS VERIFICATION** | кандидаты: core / kjnodes / easy-use |
| `PrimitiveInt`, `PrimitiveFloat` | 112 (+2-й PrimitiveInt), 129 | **UNKNOWN — NEEDS VERIFICATION** | кандидаты: core v0.27.0 / rgthree |
| `SaveVideo`, `CreateVideo` | 75, 122 | **UNKNOWN: core v0.27.0 или comfyui-videohelpersuite** | VHS установлен; SYSTEM.md:46 приписывает VHS `VHS_VideoCombine`, но workflow использует `SaveVideo`/`CreateVideo` |

Обоснование «вероятно core» для LTXV*: на верифицированном video-инстансе
(E2E-генерация подтверждена, `worker/new/SYSTEM.md:3`,
`worker/new/MEMORY.md:5-8`) custom node set из 9 пакетов
(`SYSTEM.md:39-53`, видео-аудит `[6]`) **не содержит** пакета
ComfyUI-LTXVideo; при этом «все классы воркфлоу есть» в backend
(`MEMORY.md:16`), а traceback ошибки ссылается на модуль `nodes_lt.py`
(`MEMORY.md:59`) внутри работающего ComfyUI. Методом исключения LTXV-ноды
предоставляются самим ComfyUI v0.27.0. **Точная атрибуция всех
UNKNOWN-строк требует проверки `/object_info` на референсном инстансе —
это единственный надёжный способ.**

### 6.2 Сводка required custom nodes по профилям

| Profile | REQUIRED (выведено из workflow) | Версии из аудитов |
|---|---|---|
| audio/qwen-tts | `ComfyUI-Qwen3-TTS` | commit `2ee1131`, каталог `qwen3-tts` |
| image/qwen-image | `ComfyUI-GGUF` | commit `6ea2651` |
| video/ltx-2.3 | `ComfyUI-GGUF` (+ python-библиотека `gguf`), `comfyui-kjnodes` (**с AudioVAE-патчем**), `comfyui-videohelpersuite` (если SaveVideo/CreateVideo из VHS — NEEDS VERIFICATION) | GGUF/kjnodes/VHS — plain dirs без `.git` (SYSTEM.md:53) |

**Критично для video:** 6 из 9 установленных на референсе пакетов —
обычные каталоги без `.git`, их нельзя пере-клонировать одной командой
(`SYSTEM.md:53`; `LINUX_INSTALLER_RECONNAISSANCE.md:164-168`). Для
installer'а это означает необходимость `source: bundle` либо поиска
upstream-репозиториев и фиксацию commit'ов.

**Обязательный патч (video):** `comfyui-kjnodes` — исправление вызова
AudioVAE (`VAELoaderKJ` вызывал `AudioVAE(sd, metadata)`, в v0.27.0
сигнатура только `metadata`) — `SYSTEM.md:104`,
`LINUX_INSTALLER_RECONNAISSANCE.md:208-211, 602`. Патч не декларативен
(проза в SYSTEM.md) — для installer'а нужен `patches[]` в manifest'е.

---

## 7. Workflow → Model Mapping

### 7.1 Audio / qwen-tts

| Workflow | Model Ref (поле ноды) | Filename / Repo | Target Directory | Source | Revision |
|---|---|---|---|---|---|
| tts-qwen-narrator (node 78), tts-qwen-dialogue (node 78) | `Qwen3TTSLoader.model_repo` | repo `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` | `models/TTS/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign/` (+ `speech_tokenizer/`) | **ModelScope** (`download_source: "ModelScope"`, `auto_download: true`) | не зафиксирована |
| tts-qwen-dialogue (node 79) | `Qwen3TTSLoader.model_repo` | repo `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | `models/TTS/Qwen/Qwen3-TTS-12Hz-1.7B-Base/` (+ `speech_tokenizer/`) | **ModelScope**, `auto_download: true` | не зафиксирована |

Размеры по audio-аудиту (`[5]`): VoiceDesign 3.57 GiB + tokenizer
650.69 MiB; Base 3.59 GiB + tokenizer 650.69 MiB. Итого ≈ 8.5 GB.

Особенность: TTS-модели **не являются файлами в обычном смысле** —
`Qwen3TTSLoader` сам скачивает репо при первом запуске
(`LINUX_INSTALLER_RECONNAISSANCE.md:144-148, 212-215`). Installer может
либо предзагрузить их (детерминизм + offline), либо положиться на
`auto_download` (см. §13, вопрос 3).

### 7.2 Image / qwen-image

| Workflow | Node / поле | Filename | Target Directory | Размер (аудит) | Source |
|---|---|---|---|---:|---|
| img-qwen-image | 10 `UnetLoaderGGUF.unet_name` | `qwen-image-2512-Q4_K_M.gguf` | `models/unet/` | 12.34 GiB | UNKNOWN — NEEDS RESEARCH (GGUF-квант Qwen-Image 2512, HF) |
| img-qwen-image | 11 `CLIPLoaderGGUF.clip_name` (type `qwen_image`) | `Qwen2.5-VL-7B-Instruct-Q8_0.gguf` | `models/clip/` | 7.54 GiB | UNKNOWN — NEEDS RESEARCH (GGUF Q8_0, HF) |
| img-qwen-image | 12 `VAELoader.vae_name` | `qwen_image_vae.safetensors` | `models/vae/` | 242.05 MiB (sha256[:12] `a70580f0213e`) | UNKNOWN — NEEDS RESEARCH (HF) |
| img-qwen-image | 1010 `LoraLoaderModelOnly.lora_name` | `Wuli-Qwen-Image-2512-Turbo-LoRA-4steps-V3.0.safetensors` | `models/loras/` | 1.10 GiB | UNKNOWN — NEEDS RESEARCH (community LoRA, HF/Civitai) |

Итого ≈ 21.2 GB.

Footgun: legacy `old_img-qwen-image.json` ссылается на
`Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf` (другой квант). В manifest должен
попасть только Q8_0 (active workflow)
(`LINUX_INSTALLER_RECONNAISSANCE.md:126-129`).

### 7.3 Video / ltx-2.3

Одинаковый набор во всех четырёх `video-ltx-*p`:

| Node / поле | Filename | Target Directory | Размер (аудит) | Source |
|---|---|---|---:|---|
| 141 `UnetLoaderGGUF.unet_name` | `LTX-2.3-distilled-Q4_K_M.gguf` | `models/unet/` | 16.54 GiB | UNKNOWN — NEEDS RESEARCH (HF) |
| 227 `DualCLIPLoaderGGUF.clip_name1` | `gemma-3-12b-it-qat-UD-Q4_K_XL.gguf` | `models/text_encoders/` | 6.92 GiB | UNKNOWN — NEEDS RESEARCH (HF; UD-квант Gemma-3-12B; возможен gated-доступ) |
| 227 `DualCLIPLoaderGGUF.clip_name2` | `ltx-2.3_text_projection_bf16.safetensors` | `models/text_encoders/` | 2.15 GiB | UNKNOWN — NEEDS RESEARCH (HF) |
| 188 `LoraLoaderModelOnly.lora_name` | `ltx-2-19b-ic-lora-detailer.safetensors` | `models/loras/` | 2.44 GiB | UNKNOWN — NEEDS RESEARCH (HF) |
| 222 `VAELoaderKJ.vae_name` | `ltx-2.3-22b-dev_video_vae.safetensors` | `models/vae/` | 1.35 GiB | UNKNOWN — NEEDS RESEARCH (HF) |
| 226 `VAELoaderKJ.vae_name` | `ltx-2.3-22b-dev_audio_vae.safetensors` | `models/vae/` | 347.95 MiB | UNKNOWN — NEEDS RESEARCH (HF) |
| 191 `VAELoader.vae_name` | `taeltx2_3.safetensors` | `models/vae/` | 22.44 MiB | UNKNOWN — NEEDS RESEARCH (HF) |

Итого ≈ 29.8 GB.

**НЕ входят в required** (присутствуют в аудите/доках, но не
referenced ни одной нодой production workflows):

| Файл | Где упоминается | Статус |
|---|---|---|
| `latent_upscale_models/ltx-2.3-spatial-upscaler-x2-1.0.safetensors` (949.62 MiB) | video-аудит `[5]`; `EXPERIMENTAL_BETA_WORKER_SETUP.md:46`; `SYSTEM.md:66` | **UNUSED по workflow** — в production workflows нет latent-upscale нод. В manifest не включать (или optional — решение §14) |
| `gemma-3-12b-it-qat-q4_0-unquantized_readout_proj/model/model.safetensors` | video-аудит `[7]` — ссылки из локальных UI-workflow | UI-артефакт, не required |
| `ltx-av-step-1751000_vocoder_24K.safetensors` | video-аудит `[7]` — ссылки из локальных UI-workflow | UI-артефакт, не required |

---

## 8. Download Sources

Ничего не скачивалось. Ниже — только установленные источники.

### 8.1 Подтверждённые в коде/доках репо

| Что | Источник | Основание |
|---|---|---|
| ComfyUI (video) | GitHub `https://github.com/Comfy-Org/ComfyUI.git`, tag `v0.27.0` (commit `bb131be9e83d2f773c90f1d6f1e4b248a498c8c5`) | `worker/start-video.sh:19-25`; видео-аудит `[4]` (remote `comfyanonymous/ComfyUI`) |
| ComfyUI (audio/image) | GitHub форк `https://github.com/rajsingh1-dev/ComfyUI.git`, commit `c4cfee7ad16cfeb082e12f43cf4751b4a67a4e11` | audio-аудит `[4]`, image-аудит «ComfyUI» |
| `ComfyUI-Qwen3-TTS` | GitHub `https://github.com/wanaigc/ComfyUI-Qwen3-TTS`, commit `2ee1131` | audio-аудит `[6]` |
| `ComfyUI-Manager` | GitHub `https://github.com/ltdrdata/ComfyUI-Manager`, commit `df1eaff8` (audio/image) / `bbafbb12` (video) | аудиты `[6]`, `SYSTEM.md:50` |
| `ComfyUI-PromptRelay` | GitHub `kijai/ComfyUI-PromptRelay`, commit `ca5d4e3` | `SYSTEM.md:49`, видео-аудит `[6]` |
| `rgthree-comfy` | GitHub `rgthree/rgthree-comfy`, commit `683836c` | `SYSTEM.md:51`, видео-аудит `[6]` |
| TTS-модели `Qwen/Qwen3-TTS-12Hz-1.7B-{Base,VoiceDesign}` | **ModelScope** (workflow field `download_source`) | `tts-qwen-narrator.json:35-39`, `tts-qwen-dialogue.json:111-128` |
| PyTorch cu124 | `https://download.pytorch.org/whl/cu124` | `worker/start-video.sh:61` |
| Worker bundle | Animastor origin `GET {HUB_URL}/worker-source` | `gpu-hub.js:1050-1060`, `EXPERIMENTAL_BETA_WORKER_SETUP.md:65-73` |

### 8.2 Не подтверждённые (UNKNOWN — NEEDS RESEARCH)

Для всех gguf/safetensors-файлов image/video (§7.2, §7.3) **в репозитории
нет ни URL, ни HF-репо, ни ревизий** — только имена файлов в workflow JSON
и фактические размеры в аудитах. Конкретные upstream-репозитории (HF
кванты Qwen-Image/Gemma/LTX, LoRA Wuli, VAE) должен установить отдельный
download-research с фиксацией: repo, file path, revision/commit, sha256,
license/gated-статус. Рекомендация предыдущей разведки — зеркалить всё в
организационный HF-аккаунт `animastor` после проверки лицензий
(`LINUX_INSTALLER_RECONNAISSANCE.md:460-476`). **В этом исследовании
URL не выдумываются.**

### 8.3 Gated-доступ (предварительно)

Потенциально gated: Gemma-3-12B варианты, части Qwen3-TTS
(`LINUX_INSTALLER_RECONNAISSANCE.md:455, 605`). Точный статус — только
при download-research. Installer должен поддерживать опциональный
`HF_TOKEN` (никогда не логировать).

---

## 9. Runtime Requirements

### 9.1 По профилям (фактические данные аудитов + скриптов)

| Параметр | audio/qwen-tts | image/qwen-image | video/ltx-2.3 |
|---|---|---|---|
| ComfyUI | форк `rajsingh1-dev/ComfyUI` @ `c4cfee7` (аудит) | форк `rajsingh1-dev/ComfyUI` @ `c4cfee7` (аудит) | **официальный** `Comfy-Org/ComfyUI` tag `v0.27.0` @ `bb131be9` (`start-video.sh:19`) |
| Python | 3.10.12 (аудит) | 3.10.12 (аудит) | 3.10.12 (`SYSTEM.md:17`, аудит) |
| PyTorch | **2.10.0+cu128** (аудит) | **2.10.0+cu128** (аудит) | **2.6.0+cu124** (`start-video.sh:61`, `SYSTEM.md:22`) |
| cuDNN | 91002 (аудит) | 91002 (аудит) | 9.1.0.70 / 90100 (`SYSTEM.md:24`) |
| CUDA tier | 12.8 (torch build) | 12.8 (torch build) | 12.4 (torch build; драйвер 550.127.08 сообщает 12.4) |
| Драйвер NVIDIA (референс) | 550.127.08 | 550.127.08 | 550.127.08 |
| Мин. VRAM | не задокументирован | не задокументирован | не задокументирован; референс L40S 46 GB; draft 24 GB в `private-worker-installer-architecture.md:333` не подтверждён |
| Node.js | 20+ (`worker.cjs:4` «Node 20+ with global fetch»; `start-worker.sh:80-87` ставит 18 — расхождение) | то же | то же |
| Прочее | — | — | frontend-package 1.45.20, comfy-kitchen 0.2.16 (`SYSTEM.md:20-21`); purge cu13-стека; удаление stale `comfyui.db`; pip lock `comfy-v0.27.0.lock.txt` |

### 9.2 Одна общая policy или разные?

**Сейчас — разные, и это не задокументированное решение, а исторический
дрейф:**

- video: официальный ComfyUI v0.27.0 + torch 2.6.0+cu124 (полностью
  скриптовано, `start-video.sh`);
- audio/image: форк ComfyUI + torch 2.10.0+cu128 (install-скрипта для
  этих профилей в репо **нет**; есть только `fix-nodes-audio.sh` /
  `fix-nodes-image.sh`, ставящие pip-зависимости нод после запуска).

Это же расхождение явно flagged в
`private-worker-installer-architecture.md:596-598` («в аудитах разные:
v0.27.0 vs форк c4cfee7a — требуется решение»).

Варианты (решение — §14):

1. Общая policy: все три профиля на официальном ComfyUI v0.27.0 +
   cu124. Риск: audio/image никогда не проверялись на v0.27.0 — нужен
   golden run обоих профилей.
2. Per-profile policy: manifest несёт ComfyUI pin и torch tier на профиль.
   Дороже, но отражает фактическое положение.

---

## 10. Runtime Audit Comparison

Метод: required = выведено из production workflows (§6, §7); installed =
из аудитов (`docs/runtime-audits/{audio-qwen,image-qwen,video-ltx-2.3}/`).
Аудиты — reference only (`docs/runtime-audits/README.md:11-17`).

### 10.1 audio-qwen (аудит 2026-08-25)

| Зависимость | Required (workflow) | В аудите | Статус |
|---|---|---|---|
| `ComfyUI-Qwen3-TTS` (все Qwen3TTS* + SaveAudioMP3) | да | да, commit `2ee1131` | **found in audit** |
| `comfyui-manager` | нет | да, `df1eaff8` | **present but unused** (utility; вопрос о включении — §13) |
| `Qwen3-TTS-12Hz-1.7B-VoiceDesign` (+speech_tokenizer) | да | да (3.57 GiB + 650.69 MiB) | **found in audit** |
| `Qwen3-TTS-12Hz-1.7B-Base` (+speech_tokenizer) | да | да (3.59 GiB + 650.69 MiB) | **found in audit** |
| ComfyUI-форк `c4cfee7` + torch 2.10.0+cu128 | runtime baseline | да | **cannot determine** — нет install-скрипта/манифеста для audio; неясно, форк ли required или подойдёт официальный |

MISSING: ∅.

### 10.2 image-qwen (аудит 2026-08-26)

| Зависимость | Required | В аудите | Статус |
|---|---|---|---|
| `ComfyUI-GGUF` | да | да, commit `6ea2651` | **found in audit** |
| `qwen-image-2512-Q4_K_M.gguf` | да | да, 12.34 GiB, `models/unet/` | **found in audit** |
| `Qwen2.5-VL-7B-Instruct-Q8_0.gguf` | да | да, 7.54 GiB, `models/clip/` | **found in audit** |
| `qwen_image_vae.safetensors` | да | да, 242.05 MiB, sha256[:12] `a70580f0213e` | **found in audit** |
| `Wuli-Qwen-Image-2512-Turbo-LoRA-4steps-V3.0.safetensors` | да | да, 1.10 GiB, `models/loras/` | **found in audit** |
| `ComfyUI-Florence2`, `ComfyUI-KJNodes`, `ComfyUI-RMBG`, `ComfyUI-segment-anything-2`, `qwen3-tts`, `comfyui-manager` | нет | да | **present but unused** (не referenced в `img-qwen-image`) |
| Локальные workflow-файлы (`user/default/workflows/`) | нет | да (6 файлов) | **present but unused** — явно помечены как UI test artifacts в самом аудите |
| ComfyUI-форк `c4cfee7` + torch 2.10.0+cu128 | runtime baseline | да | **cannot determine** (как и для audio) |

MISSING: ∅.

### 10.3 video-ltx-2.3 (аудит 2026-08-26) — разбор особенно внимательно

| Зависимость | Required | В аудите | Статус |
|---|---|---|---|
| `ComfyUI-GGUF` (+ `gguf` lib) | да | да (оба — plain dirs) | **found in audit** |
| `comfyui-kjnodes` (VAELoaderKJ; **патчен**) | да | да (патч не виден в аудите — фиксируется только по SYSTEM.md) | **found in audit**; состояние патча = **cannot determine** по аудиту |
| `comfyui-videohelpersuite` | вероятно (SaveVideo/CreateVideo — NEEDS VERIFICATION) | да | **found in audit** (required-статус до верификации условный) |
| LTXV* / LTX2* / ManualSigmas / ResizeImageMaskNode / Primitive* | да (class'ы workflow) | поставщик не идентифицирован в аудите | **cannot determine** — вероятно core v0.27.0 (§6.1); требует `/object_info` |
| `LTX-2.3-distilled-Q4_K_M.gguf` | да | да, 16.54 GiB, `models/unet/` | **found in audit** |
| `gemma-3-12b-it-qat-UD-Q4_K_XL.gguf` | да | да, 6.92 GiB, `models/text_encoders/` | **found in audit** |
| `ltx-2.3_text_projection_bf16.safetensors` | да | да, 2.15 GiB, `models/text_encoders/` | **found in audit** |
| `ltx-2-19b-ic-lora-detailer.safetensors` | да | да, 2.44 GiB, `models/loras/` | **found in audit** |
| `ltx-2.3-22b-dev_video_vae.safetensors` | да | да, 1.35 GiB, `models/vae/` | **found in audit** |
| `ltx-2.3-22b-dev_audio_vae.safetensors` | да | да, 347.95 MiB, `models/vae/` | **found in audit** |
| `taeltx2_3.safetensors` | да | да, 22.44 MiB, `models/vae/` | **found in audit** |
| `ltx-2.3-spatial-upscaler-x2-1.0.safetensors` | **нет** (нет upscale-нод в workflow) | да, 949.62 MiB | **present but unused** (упоминается в WORKER_SETUP-доке — противоречие зафиксировано, §14) |
| `comfyui-easy-use`, `ComfyUI-MelBandRoFormer`, `ComfyUI-PromptRelay`, `rgthree-comfy`, `ComfyUI-Manager` | нет (class'ы не referenced в production workflow) | да | **present but unused** по workflow-критерию. ⚠ Противоречие: `EXPERIMENTAL_BETA_WORKER_SETUP.md:56-58` утверждает, что video «дополнительно требует comfyui-easy-use, rgthree-comfy». Workflow-скан это не подтверждает → требуется решение (возможно, дока устарела или ноды нужны для локальных UI-workflow оператора) |
| 14 локальных workflow-файлов + их model refs (gemma unquantized, ltx-av vocoder) | нет | да | **present but unused** — UI-артефакты (аудит `[7]`, `[11]` сами это отмечают) |
| ComfyUI v0.27.0 + torch 2.6.0+cu124 | да (runtime baseline) | да | **found in audit** |

MISSING: ∅.

### 10.4 Итог сравнения

- Во всех трёх профилях всё workflow-derived required **найдено** в
  аудитах — аудиты сняты с рабочих инстансов, расхождений «required, но
  отсутствует» нет.
- Аудиты содержат существенный объём UNUSED (операторские custom nodes,
  UI-workflow, upscaler) — подтверждён принцип «audit ≠ source of truth».
- Три класса проблем, не решаемых аудитом: (а) поставщик части video
  class_type (core vs пакет); (б) состояние kjnodes-патча; (в) required
  ли ComfyUI-форк для audio/image или это историческая случайность.

---

## 11. Installer Boundary

Статусы: `INSTALL` = INSTALLER MUST INSTALL · `KNOW` = INSTALLER MUST KNOW
ABOUT · `BACKEND` = BACKEND ONLY · `WORKER` = WORKER ONLY · `REF` =
REFERENCE ONLY · `UNKNOWN` = NEEDS DECISION.

```
PROFILE (audio/qwen-tts | image/qwen-image | video/ltx-2.3)
   │   backend/ai/profiles/**.json ........................ BACKEND
   │   (id профиля = ключ установки для installer'а) ...... KNOW
   │
   ├── CONNECTOR (conn-*.json) ............................ BACKEND
   │      │  не устанавливается; не пересекает границу VPS→GPU
   │      │  workflowHash/class expectations ............... KNOW (опц., drift-check)
   │      │
   │      └── WORKFLOW (backend/ai/workflows/*.json) ...... BACKEND
   │              │  доставляется в runtime как task.params;
   │              │  установка на диск воркера НЕ требуется
   │              │  (опц. offline/debug копия) ............ REF
   │              │
   │              ├── CUSTOM NODES ........................ INSTALL
   │              │     audio: ComfyUI-Qwen3-TTS
   │              │     image: ComfyUI-GGUF
   │              │     video: ComfyUI-GGUF(+gguf), kjnodes(+AudioVAE patch),
   │              │            VHS (NEEDS VERIFICATION),
   │              │            прочие class_type — UNKNOWN (§6.1)
   │              │
   │              └── MODELS .............................. INSTALL
   │                    audio: 2×ModelScope repo (или KNOW —
   │                           если полагаемся на auto_download) ... UNKNOWN
   │                    image: 4 файла (~21 GB)
   │                    video: 7 файлов (~30 GB)
   │
   └── RUNTIME REQUIREMENTS
          ComfyUI (pin per profile) ...................... INSTALL
          Python 3.10 + pip lock ......................... INSTALL
          PyTorch + CUDA tier (cu124/cu128 — решение) .... INSTALL
          Node.js 20+ .................................... INSTALL
          NVIDIA driver / CUDA userland .................. WORKER
            (installer v1 только проверяет, не ставит —
             private-worker-installer-architecture.md §13)
          worker bundle (worker.cjs, cleanup, journal,
            package.json, .env) .......................... INSTALL
          worker mode (private/share/system) ............. BACKEND
            (определяется hub'ом из токена — PW-4;
             installer НЕ спрашивает режим)
          Runtime audits ................................. REF
          Skills / rules / examples (backend/ai) ......... BACKEND
```

Граница, проверенная по коду (совпадает с предложенной в задании):

```
                 BACKEND / VPS
┌─────────────────────────────────────────┐
│ Profile    (prompt-assembly metadata)   │
│    ↓ (connector.profile.{type}Profile)  │
│ Connector  (entity→node bindings)       │
│    ↓ (setValue: патч workflow JSON)     │
│ Production Workflow (полный JSON)       │
└──────────────────┬──────────────────────┘
                   │ task.params / workflow (HTTP → Redis → HTTP)
                   ▼
              GPU Worker (worker.cjs — stateless bridge)
                   │ POST /prompt
                   ▼
                ComfyUI (custom nodes + models + torch/CUDA)
```

---

## 12. Proposed Manifest Inputs

Что уже может войти в manifest draft'ы (без выдуманных URL/ревизий):

### 12.1 Общее для всех профилей

- `worker` bundle: `worker/worker/{worker.cjs, worker-cleanup.cjs,
  worker-cleanup-journal.cjs, package.json, .env.example}`; min version
  v2.0.0 (`worker.cjs:2`); источник — origin `GET /gpu/worker-source`
  или repo.
- required env: `HUB_URL`, `ANIMASTOR_WORKER_TOKEN` (fail-closed),
  `WORKER_TYPE`, `WORKER_ID`; optional: `COMFY_PORT`, `COMFY_INPUT_DIR`,
  `WORKER_JOURNAL_DIR`, `NOTEBOOK_PATH` (`worker/worker/.env.example`).
- Node.js ≥ 20 (по коду worker'а; расхождение с 18 в start-worker.sh —
  §13).
- verification: `scripts/animastor-runtime-audit.sh` как post-install
  diff-инструмент (`private-worker-installer-architecture.md` §5.7).

### 12.2 Per-profile

| Поле | audio/qwen-tts | image/qwen-image | video/ltx-2.3 |
|---|---|---|---|
| workflows (provenance) | tts-qwen-narrator, tts-qwen-dialogue | img-qwen-image | video-ltx-1p…4p |
| custom_nodes | ComfyUI-Qwen3-TTS @ 2ee1131 | ComfyUI-GGUF @ 6ea2651 | ComfyUI-GGUF (+gguf), comfyui-kjnodes (+patch AudioVAE), [VHS — NEEDS VERIFICATION] |
| models | 2 model_repo записи (ModelScope; type=model_repo) | 4 файла: unet/clip/vae/loras | 7 файлов: unet/text_encoders×2/loras/vae×3 |
| disk budget (по аудитам) | ≈ 8.5 GB + ComfyUI | ≈ 21.2 GB + ComfyUI | ≈ 29.8 GB + ComfyUI (~32 GB с upscaler'ом, если решим включить) |
| comfyui pin | UNKNOWN (форк c4cfee7 — решение) | UNKNOWN (форк c4cfee7 — решение) | v0.27.0 @ bb131be9 |
| torch pin | UNKNOWN (2.10.0+cu128 в аудите — решение) | UNKNOWN (2.10.0+cu128 — решение) | 2.6.0+cu124, index cu124 |
| особые операции | — | — | purge cu13; stale comfyui.db cleanup; kjnodes patch; pip lock |
| hardware | VRAM min UNKNOWN | VRAM min UNKNOWN | VRAM min UNKNOWN (референс 46 GB) |

### 12.3 Чего manifest'у нельзя брать из аудитов без пометки

- upscaler-модель (video) — не referenced workflow;
- easy-use/MelBandRoFormer/PromptRelay/rgthree/Manager (video) и
  Florence2/KJNodes/RMBG/SAM2/qwen3-tts (image) — не referenced workflow;
- локальные UI-workflow и их model refs;
- torch 2.10.0+cu128 для audio/image — пока не принято решение о единой
  runtime policy.

---

## 13. Open Questions

1. **ComfyUI pin для audio/image** (самый крупный): форк
   `rajsingh1-dev/ComfyUI@c4cfee7` — required, или профили работают на
   официальном v0.27.0? Нужен golden run audio+image на v0.27.0 либо
   решение перенести форк в manifest. (§9.2)
2. **Torch/CUDA tier**: cu124 (video) vs cu128 (audio/image) — единый
   tier или per-profile?
3. **TTS-модели**: installer предзагружает ModelScope-репо (детерминизм,
   offline) или полагается на `Qwen3TTSLoader.auto_download`? Если
   предзагружает — нужен механик `modelscope download` и target layout
   `models/TTS/Qwen/...` (включая `speech_tokenizer/`).
4. **Поставщик class_type**: `SaveVideo`, `CreateVideo`,
   `LTX2SamplingPreviewOverride`, `ManualSigmas`, `ResizeImageMaskNode`,
   `PrimitiveInt`, `PrimitiveFloat`, а также точная принадлежность
   LTXV*/AV-нод (core vs пакет) — проверить `/object_info` на
   референсном video-инстансе. От ответа зависит список custom_nodes
   video-манифеста.
5. **SaveAudioMP3** — подтвердить принадлежность пакету
   ComfyUI-Qwen3-TTS (`/object_info` на audio-инстансе).
6. **Upstream'ы plain-dir нод** (GGUF, gguf, kjnodes, VHS и др.): найти
   git-репозитории и commit'ы либо готовить bundle-архивы
   (`LINUX_INSTALLER_RECONNAISSANCE.md:164-168`).
7. **Download-research моделей**: все 11 файлов image/video — repo,
   revision, sha256, license/gated (§8.2).
8. **ComfyUI-Manager**: включать ли в manifest как optional utility
   (присутствует во всех аудитах, но workflow не требуется)?
9. **Противоречие документов**: `EXPERIMENTAL_BETA_WORKER_SETUP.md:56-58`
   требует easy-use/rgthree для video; workflow-скан — нет. Что истина?
10. **Upscaler-модель** (`ltx-2.3-spatial-upscaler-x2-1.0.safetensors`):
    исключить из manifest или оставить optional «на вырост»?
11. **Node.js**: 18 (start-worker.sh) vs 20 (worker.cjs header) —
    унифицировать требование.
12. **Минимальный VRAM** по профилям — не задокументирован нигде; нужны
    измерения или консервативный draft.

---

## 14. Findings / Decisions Needed

### Установлено точно (с доказательствами в коде)

1. **Источник истины для install manifest — production workflows**
   (`backend/ai/workflows/*.json`), связанные с профилями через
   `profile.{type}Profile` в connector'ах. Profile-файлы несут только
   prompt-assembly metadata; поле `workflow` в них декоративное (кодом
   не читается).
2. **Connector = backend-side execution metadata.** Не устанавливается,
   не пересекает границу VPS→GPU, runtime-зависимостей не добавляет.
   Installer'у достаточно *знать* о них (workflowHash) для опционального
   drift-check.
3. **Workflow JSON на GPU-бокс не устанавливается** — доставляется в
   runtime через `task.params` (hub → worker → ComfyUI `/prompt`).
4. **7 production workflows**, полный список class_type и model/file
   refs извлечён (§5–§7); legacy `old_*` исключены.
5. **Model inventory**: audio 2 repo (ModelScope, auto_download),
   image 4 файла ≈21 GB, video 7 файлов ≈30 GB; target-каталоги
   подтверждены аудитами; размеры зафиксированы.
6. **Required custom nodes**: audio — ComfyUI-Qwen3-TTS; image —
   ComfyUI-GGUF; video — ComfyUI-GGUF(+gguf) + kjnodes (с обязательным
   AudioVAE-патчем) + вероятно VHS.
7. **Во всех аудитах required присутствует (MISSING = ∅)**; найдено
   много UNUSED, что подтверждает: audit — reference, не source of truth.
8. **Worker bundle и env-контракт** полностью описаны и стабильны
   (v2.0.0, fail-closed PW-4).

### Роль connector'ов — подтверждённая формулировка

Connector — это **механизм заполнения workflow значениями сущностей на
VPS**: декларативные bindings (entity → nodeId.field), валидируемые
против workflow при старте backend'а. В install footprint connector не
входит никак; единственная его «тень» на GPU-боксе — уже подставленные
значения внутри присланного workflow JSON.

### Решения, которые нужно принять до manifest draft'ов

| # | Решение | Влияние |
|---|---|---|
| D1 | Единая ComfyUI/torch policy (v0.27.0+cu124 для всех?) или per-profile | структура manifest'а: один общий runtime-блок или три |
| D2 | TTS-модели: предзагрузка vs auto_download | тип записей audio-моделей в manifest |
| D3 | Верификация UNKNOWN class_type через /object_info | окончательный custom_nodes list video |
| D4 | Upstream'ы/bundles для plain-dir нод | механика установки video-нод |
| D5 | Download-research 11 файлов моделей (repo/sha256/gated) | заполнение `source`/`checksum` полей |
| D6 | Upscaler и «документально требуемые» easy-use/rgthree: вкл/выкл | объём video-манифеста |
| D7 | ComfyUI-Manager: optional utility или нет | объём всех манифестов |

После этого исследования **к реализации Installer не переходим** —
следующий шаг по architecture draft'у (§17): manifest draft'ы
(рекомендуемый пилот — `image/qwen-image` как наименьший footprint) на
основе §12 настоящего документа.
