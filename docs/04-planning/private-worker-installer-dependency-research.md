# Private Worker Installer — Dependency Research

> **Status:** research only. No implementation, no runtime changes, no profile
> schema changes, no downloads, no model/node installation.
> **Date:** 2026-08-26
> **Scope:** Generation Profiles `audio/qwen-tts`, `image/qwen-image`,
> `video/ltx-2.3` and their actual production dependencies.
> **Companion docs:** `docs/04-planning/private-worker-installer-architecture.md`
> (architecture draft), `docs/architecture/LINUX_INSTALLER_RECONNAISSANCE.md`
> (previous reconnaissance), `docs/runtime-audits/README.md` (verified delivery chain).

---

## 1. Executive Summary

Research answered the fundamental question: **source of truth for
install manifest is production workflow JSON**
(`backend/ai/workflows/*.json`), linked to profile via
`profile.{type}Profile` field in connector. **Connectors are backend-side
execution metadata**: they live only on VPS, patch workflow JSON before
sending and **don't cross GPU worker boundary**. Installer must NOT
install connectors.

Key established facts:

1. **Chain confirmed by code:** Profile (prompt-assembly) → Connector
   (entity→node bindings) → Workflow (ComfyUI API JSON) → `task.params`
   via GPU Hub → `worker.cjs` → `POST http://127.0.0.1:8188/prompt`.
   Workflow JSON delivered to worker over network at runtime; worker disk
   doesn't require workflow files (`docs/runtime-audits/README.md:19-52`,
   `worker/worker/worker.cjs:310-339`).
2. **Connector adds no runtime dependencies.** Its
   `compatibility.nodeClasses` is subset of `class_type` of same workflow
   (validated on backend startup, `connector-loader.js:204-311`).
   Model references absent in connectors. Only
   installer-relevant connector artifact — `workflowHash` (sha256
   workflow JSON) — usable for drift-check, not for
   installation.
3. **7 production workflows found**: `tts-qwen-narrator`,
   `tts-qwen-dialogue`, `img-qwen-image`, `video-ltx-{1,2,3,4}p`
   (4 video variants identical in dependencies, differ only in
   `LTXVAddGuide` node count). Legacy `old_*` excluded by loader
   (`workflow-loader.js:29`).
4. **Model inventory derived from workflows**: audio — 2 ModelScope repos
   (installed by custom node itself, `auto_download: true`); image — 4 files
   (~21 GB); video — 7 files (~30 GB). All target directories confirmed by
   runtime audits.
5. **Custom nodes**: audio — `ComfyUI-Qwen3-TTS` (only required);
   image — `ComfyUI-GGUF` (only required); video — `ComfyUI-GGUF` +
   `comfyui-kjnodes` (with mandatory AudioVAE patch) + likely
   `comfyui-videohelpersuite`; some video workflow class_type
   not uniquely attributed (UNKNOWN — requires `/object_info`
   check on reference instance).
6. **No unified runtime policy yet**: video instance runs on
   official ComfyUI `v0.27.0` + torch `2.6.0+cu124`; audio/image instances
   — on fork `rajsingh1-dev/ComfyUI` (commit `c4cfee7`) + torch
   `2.10.0+cu128`. Decision needed (§9, §14).
7. **Audits as reference**: all three audits have required dependencies
   present (MISSING = ∅); significant UNUSED components found
   (operator nodes, UI-test workflows, upscaler model) that must NOT
   appear in manifest.

---

## 2. Current Architecture

### 2.1 Actual chain (confirmed by code)

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

Boundary confirmed:

- Worker never reads `backend/ai/*`: neither profiles, connectors, nor
  workflow files (`worker/worker/worker.cjs` — sole consumer
  of `task.params`; `docs/runtime-audits/README.md:19-52`).
- Workflow JSON not stored on GPU box for production; empty
  `~/ComfyUI/user/default/workflows/` — expected state
  (`docs/runtime-audits/README.md:47-52`;
  `docs/runtime-audits/image-qwen/...md:70-103` — local workflow files
  explicitly marked as UI test artifacts).
- Backend cannot start without workflows+connectors:
  `backend.cjs:307-316` → `process.exit(1)` on load error. This is
  boot-critical backend configuration, not worker dependency.

### 2.2 Components and their owners

| Component | Location | Owner | Consumer |
|---|---|---|---|
| Profiles | `backend/ai/profiles/{type}/{name}.json` | VPS | `ai-loader.js:213-219` → `assembly-profile.js:93-97` → prompt builders |
| Skills | `backend/ai/skills/{type}/{name}.md` | VPS | `prompt-profile-loader.js:27-33` → agent pipeline |
| Connectors | `backend/ai/connectors/conn-*.json` | VPS | `connector-loader.js:141-178` → audio/image/video services |
| Workflows | `backend/ai/workflows/*.json` | VPS | `workflow-loader.js:25-76`; at runtime delivered to worker as `task.params` |
| Worker bundle | `worker/worker/worker.cjs` + cleanup/journal | GPU box | installed manually / hub `GET /worker-source` (`gpu-hub.js:1050-1060`) |
| ComfyUI + nodes + models | `~/ComfyUI` on GPU box | GPU box | ComfyUI runtime |

---

## 3. Generation Profiles

### 3.1 Inventory

All three profiles: `backend/ai/profiles/{audio,image,video}/*.json`.
Loaded recursively (`ai-loader.js:84-113, 213-219`), 60s cache.

| Поле | audio/qwen-tts | image/qwen-image | video/ltx-2.3 |
|---|---|---|---|
| `profile` | `qwen-tts` | `qwen-image` | `ltx-2.3` |
| `type` | `audio` | `image` | `video` |
| `model` | `Qwen3-TTS` | `Qwen2.5-VL` (*) | `LTX-2.3` |
| `workflow` | `tts-qwen-*` (glob) | `img-qwen-image` | `video-ltx-*` (glob) |
| `skill` | `audio/qwen-tts` | `image/qwen-image` | `video/ltx-2.3` |
| `assembly.sections` | voiceInstruction, defaultInstruct | 14 sections (renderMode…quality) | characters, storyboard, renderInfo |
| `assembly.defaults` | defaultInstruct: "" | quality, negativeBase | negativeBase |
| `video` | — | — | frameAlignment: 8, requiresTrim: true, requiresKeyframeForcing: true |

(\*) Note: `model: "Qwen2.5-VL"` in image profile — this is text encoder;
actual diffusion model — Qwen-Image (see §7). `model` field — UX label.

### 3.2 How profile links to connector and workflow

Link direction — **from connector to profile**, not reverse:

- Connector contains `profile.{audioProfile|imageProfile|videoProfile}`
  (e.g., `conn-video-1p.json:8-10` → `videoProfile: "ltx-2.3"`).
- Resolution: user override (Settings, Redis
  `animastor:prompt-profiles`) → connector's profile field → null
  (`backend/src/services/profile-override.js:1-26`;
  `backend/src/audio/generation.js:30-33`).
- Profile does NOT contain field referencing connector.

**Important:** `workflow` field in profile (`"tts-qwen-*"`, `"video-ltx-*"`)
**is not read by code anywhere** (verified via grep on
`assembly-profile.js`/`ai-loader.js` and all consumers of
`resolveAssembly`). Actual workflow selection hardcoded in services:

| Profile | Actual workflow selection | Code |
|---|---|---|
| qwen-tts | `tts-qwen-narrator` / `tts-qwen-dialogue` (by scene type) | `audio/generation.js:19-20` |
| qwen-image | `img-qwen-image` | `image/iu-processor.js:182`, `image/connector-utils.js:8` |
| ltx-2.3 | `` `video-ltx-${groupSize}p` `` (1–4 images in group) | `workflows/video/video-workflows.js:634` |

### 3.3 What profile already contains vs what Installer needs

**Already exists:** only prompt-assembly metadata (sections, defaults)
and video post-processing metadata (frameAlignment/trim/keyframes —
used in `video/video-merge.js:27-39`). No runtime/install
fields — confirmed previously
(`LINUX_INSTALLER_RECONNAISSANCE.md:14-28`).

**Potentially needed by Installer** (per
`private-worker-installer-architecture.md` §5.1, §9 — draft, not decided here):

- reference to install spec / manifest (profile id as install key);
  hardware requirements (min VRAM, CUDA tier);
- ComfyUI version policy per profile;
- formalization of `workflow` field (currently decorative) as list of
  profile's production workflows.

Profile schema **not changed** in this research.

---

## 4. Connector Architecture

### 4.1 What is connector in current architecture

Connector — declarative JSON contract between Animastor backend entities
and specific ComfyUI workflow nodes
(`docs/06-workflows/CONNECTOR_ARCHITECTURE.md` §2). Files:
`backend/ai/connectors/conn-*.json` (loader accepts only files with
`conn-` prefix, `connector-loader.js:151`).

Structure (all 7 files):

| Field | Purpose |
|---|---|
| `connectorVersion` | connector version (`1.0.0` for all) |
| `workflow` | workflow filename without `.json` |
| `workflowHash` | sha256 workflow JSON; empty values auto-populated on startup (`connector-loader.js:561-568`) |
| `label`, `description`, `type`, `metadata` | UX/descriptive |
| `profile.{type}Profile` | **link to Generation Profile** |
| `compatibility.nodeClasses` | map nodeId → expected class_type |
| `inputs` / `outputs` / `parameters` | bindings: entityKey → { nodeId, field, expectedClass, default, min/max } |
| `guideNodes` | video only: LTXVAddGuide bindings (frame_idx/strength/image) |

### 4.2 Production connectors and their links

| Connector | Workflow | Profile (`profile.*`) | What passes to workflow | What reads from result |
|---|---|---|---|---|
| `conn-tts-narration.json` | `tts-qwen-narrator` | `audioProfile: qwen-tts` | narrationText→108.text, voiceInstruction→108.voice_instruction, seed/language/temperature→108, quality/filename→1008 | generatedAudio (node 1008 SaveAudioMP3) |
| `conn-tts-dialogue.json` | `tts-qwen-dialogue` | `audioProfile: qwen-tts` | dialogueScript→108.script, defaultInstruct→108, character{1,2,3}Voice→71/80/82, roleName{1,2,3}→74, seed/temperature→75, quality/filename→1008 | generatedAudio (1008) |
| `conn-image-generation.json` | `img-qwen-image` | `imageProfile: qwen-image` | positivePrompt→108.text, negativePrompt→109.text, width/height→110, steps/cfg/sampler/scheduler/seed→120, filename→1008 | generatedImage (1008 SaveImage) |
| `conn-video-1p.json` | `video-ltx-1p` | `videoProfile: ltx-2.3` | sourceImages→216 (LoadImage), prompts→121/110, totalFrames→112, fps→129, cfg→128, guideStrength_0→214, filename→75 | generatedVideo (75 SaveVideo) |
| `conn-video-2p.json` | `video-ltx-2p` | `videoProfile: ltx-2.3` | same + guide bindings 199, 214 | generatedVideo |
| `conn-video-3p.json` | `video-ltx-3p` | `videoProfile: ltx-2.3` | same + guide bindings 199, 200, 214 | generatedVideo |
| `conn-video-4p.json` | `video-ltx-4p` | `videoProfile: ltx-2.3` | same + guide bindings 199, 200, 201, 214 | generatedVideo |

### 4.3 Answers to posed questions

**How does Backend → Connector → Workflow → ComfyUI → GPU Worker linking
happen?** Exactly so, with clarification: connector exists only at step
"Backend patches Workflow". After that comes ready JSON:
`setValue()` (`connector-loader.js:401-422`) → `gpu.sendUnified()`
(`gpu-dispatcher.js:101-182`) → hub → worker → ComfyUI `/prompt`
(`worker.cjs:310-339`). Connector doesn't "call" workflow — it describes
where to write in it.

**What data does connector pass to workflow?** Only entity values
(prompt texts, voices, role names, sizes, seed, guide strength,
filename prefix) via `nodeId`+`field` bindings. Images NOT passed
through connector: video reference frames arrive in `task.assets.images`
(base64) and placed by worker in `COMFY_INPUT_DIR` as `{scene}_{unit}.png`
(`worker.cjs:600-624`), filenames in `LoadImage` nodes written by
`video-workflows.js:372-390`.

**What data does workflow return?** Nothing "through connector": result —
is ComfyUI files (`output/`), which worker finds via output nodes
(`SaveImage*`/`SaveAudio*`/`SaveVideo*`/`CreateVideo*`,
`worker.cjs:145-157`) and sends base64 to hub (`worker.cjs:509-527`).
Output binding of connector (`outputs.generatedVideo` etc.) used by
backend declaratively (to understand which node is output), actual
search — by class_type prefix in worker.

**Does connector have:**

- profile — **yes**, `profile.{type}Profile` (only link to
  Generation Profile);
- workflow — **yes**, `workflow` field (filename);
  workflow_id — **yes**, `workflowHash` (sha256, auto-populated;
  validated on startup `connector-loader.js:208-218`);
- model references — **no** (none in any of 7 files);
  node references — **yes**, all bindings and `compatibility.nodeClasses`;
- ComfyUI parameters — **no** (no URL/port/launch arguments);
  other dependency references — **no**.

**Are there connector-specific dependencies not visible from workflow JSON?**
**No.** `compatibility.nodeClasses` of each connector — strict
subset of `class_type` of its workflow (verified: all nodeId from
compatibility present in workflow; validator guarantees this,
`connector-loader.js:221-241`). Connector introduces no new
class_type, model file or package.

**Can one connector use multiple workflows?** In current
scheme — no: `workflow` field is single, loading is 1:1
(`connector-loader.js:185-194` indexes connector by workflow name).

**Can one workflow be used by multiple connectors/profiles?**
Technically index allows lookup by name, but currently —
strictly 1 workflow : 1 connector : 1 profile
(7 connectors for 7 workflows).

**Are there dependencies between connector and installed
Worker/ComfyUI runtime?** Indirect: connector is valid as long as
`workflowHash` and nodeIds/classes in workflow match. If worker's ComfyUI doesn't
know some class_type — task execution fails on GPU box, but not
connector. No direct connector → runtime dependency.

### 4.4 Boundary: connector in install manifest or only backend metadata?

**Confirmed by code: connector — BACKEND ONLY.**

Evidence:

1. Worker has no code reading connectors
   (`worker/worker/worker.cjs` — 734 lines, only inputs: env vars,
   `task.params`, `task.assets`, ComfyUI HTTP API).
2. Hub operates opaque `task.params` (`gpu-hub.js:661-688`) — doesn't need
   workflow JSON content, let alone connectors.
3. Connectors loaded and validated only in backend process
   (`backend.cjs:307-316`), directory mounted in backend container
   (`docker-compose.yml:86-89`), not in worker.
4. Delivery model: GPU box receives already-patched workflow JSON —
   connector "traces" (specific values in nodes) inside `task.params`
   present, connector itself — not.

**Installer conclusion:** installer does NOT install connectors. This is
explicitly documented. Only thing installer can *know* about connectors
(optional, for drift verification): `workflowHash` and expected set of
class_type — but installer can derive this directly from workflow
JSON. Decision — §11, status BACKEND ONLY.

**Fragility note (documented, not to change):** merged-dialogue path
audio (`audio/generation.js:51-137`) patches nodes 108/71/80/82/74 directly
by hardcoded id, bypassing connector; hardcoded fallbacks exist in
per-segment path (`generation.js:492, 521-524, 543-546`). Doesn't affect install
footprint (same nodes/models), but shows connector
is not sole consumer of workflow structure.

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

legacy (NOT production, excluded by loader via old_ prefix, workflow-loader.js:29):
  old_img-qwen-image.json  — differs in CLIP quant (Q4_K_M vs Q8_0) — footgun
  old_video-ltx.json       — same video model set
```

All 7 production workflows — in ComfyUI **API** format (dict nodeId →
{inputs, class_type, _meta}), not UI format. This is the format
sent to `/prompt` as-is.

What each workflow expects from runtime:

| Expectation | Provider |
|---|---|
| ComfyUI HTTP API `/prompt`, `/history`, `/system_stats`, `/view` on `127.0.0.1:8188` | ComfyUI (launch — `start-video.sh:65` / manual) |
| All class_type registered (core + custom nodes) | ComfyUI + custom_nodes |
| Model files in corresponding `models/<subdir>/` | installation (currently manual; goal — installer) |
| `input/` directory writable (video reference frames) | worker `COMFY_INPUT_DIR` (`worker.cjs:51, 600-624`) |
| `output/` directory, for video — `output/video/*.mp4` fallback scan | worker `COMFY_OUTPUT_DIR` (`worker.cjs:52, 421-433`) |
| Network to ModelScope on first TTS run (if models not preloaded) | `Qwen3TTSLoader.auto_download: true` |
| ffmpeg-compatible video/audio encoding (CreateVideo/SaveVideo, SaveAudioMP3) | node package dependencies (imageio-ffmpeg etc.; see MEMORY.md:112) |

---

## 6. Workflow → Custom Node Mapping

### 6.1 Full class_type table

**tts-qwen-narrator / tts-qwen-dialogue (profile audio/qwen-tts):**

| class_type | Nodes | Package | Source | Version/revision |
|---|---|---|---|---|
| `Qwen3TTSVoiceDesign` | 108 (narrator); 71, 80, 82 (dialogue) | `ComfyUI-Qwen3-TTS` | `https://github.com/wanaigc/ComfyUI-Qwen3-TTS` | commit `2ee1131` (audio audit) |
| `Qwen3TTSLoader` | 78 (both); 79 (dialogue) | `ComfyUI-Qwen3-TTS` | same | same |
| `Qwen3TTSVoiceClonePrompt` | 73, 81, 83 | `ComfyUI-Qwen3-TTS` | same | same |
| `Qwen3TTSRoleBank` | 74 | `ComfyUI-Qwen3-TTS` | same | same |
| `Qwen3TTSAdvancedDialogue` | 75 | `ComfyUI-Qwen3-TTS` | same | same |
| `Qwen3TTSScriptProcessor` | 108 (dialogue) | `ComfyUI-Qwen3-TTS` | same | same |
| `SaveAudioMP3` | 1008 (both) | `ComfyUI-Qwen3-TTS` (attribution by elimination — see below) | same | same |

`SaveAudioMP3` attribution: ComfyUI core has `SaveAudio`, but not
MP3 variant; on running audio instance only
`comfyui-manager` and `qwen3-tts` custom nodes installed (audit `[6]`), so `SaveAudioMP3`
provided by `qwen3-tts` package. **High confidence, requires
verification** (`/object_info` on instance).

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
