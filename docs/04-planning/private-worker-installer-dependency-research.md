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
│ backend/ai/profiles/**.json      (prompt-assembly: sections,  │
│                                   defaults, video-metadata) │
│ backend/ai/skills/**.md          (LLM-prompting rules)      │
│ backend/ai/connectors/conn-*.json(entity→nodeId bindings)   │
│ backend/ai/workflows/*.json      (ComfyUI API-format JSON)  │
│                                                             │
│ startup: workflow-loader.js:25-76 loads workflows,            │
│          connector-loader.js:553-593 validates connectors     │
│ dispatch: service patches workflow via connector              │
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
                    output → /history + files → base64 → hub → backend
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

| Field | audio/qwen-tts | image/qwen-image | video/ltx-2.3 |
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
audio/qwen-tts ─┬─ conn-tts-narration ──→ tts-qwen-narrator.json   (62 lines, 3 nodes)
                └─ conn-tts-dialogue ───→ tts-qwen-dialogue.json   (246 lines, 12 nodes)

image/qwen-image ── conn-image-generation → img-qwen-image.json    (153 lines, 11 nodes)

video/ltx-2.3 ─┬─ conn-video-1p ─→ video-ltx-1p.json  (639 lines, 43 nodes, 1×LTXVAddGuide)
               ├─ conn-video-2p ─→ video-ltx-2p.json  (668 lines, 44 nodes, 2×LTXVAddGuide)
               ├─ conn-video-3p ─→ video-ltx-3p.json  (698 lines, 45 nodes, 3×LTXVAddGuide)
               └─ conn-video-4p ─→ video-ltx-4p.json  (728 lines, 46 nodes, 4×LTXVAddGuide)

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

| class_type | Nodes | Package | Source | Version/revision |
|---|---|---|---|---|
| `UnetLoaderGGUF` | 10 | `ComfyUI-GGUF` | `https://github.com/city96/ComfyUI-GGUF` (attribution by package name; URL in repo not pinned — NEEDS VERIFICATION) | commit `6ea2651` (image audit) |
| `CLIPLoaderGGUF` | 11 | `ComfyUI-GGUF` | same | same |
| `VAELoader`, `CLIPTextEncode`, `EmptySD3LatentImage`, `KSampler`, `VAEDecode`, `SaveImage`, `LoraLoaderModelOnly`, `ModelSamplingAuraFlow` | 12, 108, 109, 110, 120, 130, 1008, 1010, 1011 | **ComfyUI core** | — | bundled with ComfyUI |

**video-ltx-{1,2,3,4}p (profile video/ltx-2.3)** — identical set across all 4
workflows (differing only in `LTXVAddGuide` count):

| class_type | Nodes (1p) | Package | Justification |
|---|---|---|---|
| `UnetLoaderGGUF` | 141 | `ComfyUI-GGUF` | GGUF loader; installed on video instance |
| `DualCLIPLoaderGGUF` | 227 | `ComfyUI-GGUF` | same |
| `VAELoaderKJ` | 222, 226 | `comfyui-kjnodes` (KJNodes) | confirmed by `worker/new/SYSTEM.md:45` ("VAELoaderKJ etc.") + AudioVAE patch (§8 SYSTEM.md) |
| `LoraLoaderModelOnly`, `VAELoader`, `CLIPTextEncode`, `KSamplerSelect`, `RandomNoise`, `SamplerCustomAdvanced`, `CFGGuider`, `VAEDecodeTiled`, `EmptyImage`, `LoadImage`, `GetImageSize` | 188, 191, 110/121, 135, 115, 172, 128, 205, 111, 149/179/187/216, 105 | **ComfyUI core** | standard core nodes |
| `LTXVConditioning`, `EmptyLTXVLatentVideo`, `LTXVPreprocess`, `LTXVCropGuides`, `LTXVAddGuide`, `LTXVChunkFeedForward` | 107, 108, 152/180/186/213, 203, 214, 211 | **likely ComfyUI core (comfy_extras/nodes_ltxv*)** | see rationale below |
| `LTXVConcatAVLatent`, `LTXVSeparateAVLatent`, `LTXVEmptyLatentAudio`, `LTXVAudioVAEDecode` | 109, 116, 171, 204 | **likely ComfyUI core (LTX-2 AV support v0.27.0)** | see rationale below |
| `LTX2SamplingPreviewOverride` | 190 | **UNKNOWN — NEEDS VERIFICATION** | candidates: core v0.27.0 / kjnodes |
| `ManualSigmas` | 164 | **UNKNOWN — NEEDS VERIFICATION** | candidates: core / kjnodes / rgthree |
| `ResizeImageMaskNode` | 206, 209, 210, 215 | **UNKNOWN — NEEDS VERIFICATION** | candidates: core / kjnodes / easy-use |
| `PrimitiveInt`, `PrimitiveFloat` | 112 (+2nd PrimitiveInt), 129 | **UNKNOWN — NEEDS VERIFICATION** | candidates: core v0.27.0 / rgthree |
| `SaveVideo`, `CreateVideo` | 75, 122 | **UNKNOWN: core v0.27.0 or comfyui-videohelpersuite** | VHS installed; SYSTEM.md:46 attributes VHS `VHS_VideoCombine`, but workflow uses `SaveVideo`/`CreateVideo` |

Rationale for "likely core" for LTXV*: on the verified video instance
(E2E generation confirmed, `worker/new/SYSTEM.md:3`,
`worker/new/MEMORY.md:5-8`) the custom node set of 9 packages
(`SYSTEM.md:39-53`, video audit `[6]`) **does not contain** the
ComfyUI-LTXVideo package; yet "all workflow classes are present" in backend
(`MEMORY.md:16`), and the error traceback references module `nodes_lt.py`
(`MEMORY.md:59`) inside a running ComfyUI. By elimination, LTXV nodes
are provided by ComfyUI v0.27.0 itself. **Precise attribution of all
UNKNOWN entries requires checking `/object_info` on the reference instance —
this is the only reliable method.**

### 6.2 Required custom nodes summary by profile

| Profile | REQUIRED (derived from workflow) | Versions from audits |
|---|---|---|
| audio/qwen-tts | `ComfyUI-Qwen3-TTS` | commit `2ee1131`, directory `qwen3-tts` |
| image/qwen-image | `ComfyUI-GGUF` | commit `6ea2651` |
| video/ltx-2.3 | `ComfyUI-GGUF` (+ python library `gguf`), `comfyui-kjnodes` (**with AudioVAE patch**), `comfyui-videohelpersuite` (if SaveVideo/CreateVideo from VHS — NEEDS VERIFICATION) | GGUF/kjnodes/VHS — plain dirs without `.git` (SYSTEM.md:53) |

**Critical for video:** 6 of 9 packages installed on the reference are
plain directories without `.git` — they cannot be re-cloned with a single command
(`SYSTEM.md:53`; `LINUX_INSTALLER_RECONNAISSANCE.md:164-168`). For
the installer this means either `source: bundle` or finding
upstream repositories and pinning commits.

**Mandatory patch (video):** `comfyui-kjnodes` — AudioVAE call fix
(`VAELoaderKJ` called `AudioVAE(sd, metadata)`, but in v0.27.0
the signature is `metadata` only) — `SYSTEM.md:104`,
`LINUX_INSTALLER_RECONNAISSANCE.md:208-211, 602`. The patch is not declarative
(prose in SYSTEM.md) — the installer needs `patches[]` in the manifest.

---

## 7. Workflow → Model Mapping

### 7.1 Audio / qwen-tts

| Workflow | Model Ref (node field) | Filename / Repo | Target Directory | Source | Revision |
|---|---|---|---|---|---|
| tts-qwen-narrator (node 78), tts-qwen-dialogue (node 78) | `Qwen3TTSLoader.model_repo` | repo `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` | `models/TTS/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign/` (+ `speech_tokenizer/`) | **ModelScope** (`download_source: "ModelScope"`, `auto_download: true`) | not pinned |
| tts-qwen-dialogue (node 79) | `Qwen3TTSLoader.model_repo` | repo `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | `models/TTS/Qwen/Qwen3-TTS-12Hz-1.7B-Base/` (+ `speech_tokenizer/`) | **ModelScope**, `auto_download: true` | not pinned |

Sizes from audio audit (`[5]`): VoiceDesign 3.57 GiB + tokenizer
650.69 MiB; Base 3.59 GiB + tokenizer 650.69 MiB. Total ≈ 8.5 GB.

Special note: TTS models **are not files in the traditional sense** —
`Qwen3TTSLoader` downloads the repo itself on first run
(`LINUX_INSTALLER_RECONNAISSANCE.md:144-148, 212-215`). The installer can
either preload them (determinism + offline) or rely on
`auto_download` (see §13, question 3).

### 7.2 Image / qwen-image

| Workflow | Node / field | Filename | Target Directory | Size (audit) | Source |
|---|---|---|---|---:|---|
| img-qwen-image | 10 `UnetLoaderGGUF.unet_name` | `qwen-image-2512-Q4_K_M.gguf` | `models/unet/` | 12.34 GiB | UNKNOWN — NEEDS RESEARCH (GGUF quant Qwen-Image 2512, HF) |
| img-qwen-image | 11 `CLIPLoaderGGUF.clip_name` (type `qwen_image`) | `Qwen2.5-VL-7B-Instruct-Q8_0.gguf` | `models/clip/` | 7.54 GiB | UNKNOWN — NEEDS RESEARCH (GGUF Q8_0, HF) |
| img-qwen-image | 12 `VAELoader.vae_name` | `qwen_image_vae.safetensors` | `models/vae/` | 242.05 MiB (sha256[:12] `a70580f0213e`) | UNKNOWN — NEEDS RESEARCH (HF) |
| img-qwen-image | 1010 `LoraLoaderModelOnly.lora_name` | `Wuli-Qwen-Image-2512-Turbo-LoRA-4steps-V3.0.safetensors` | `models/loras/` | 1.10 GiB | UNKNOWN — NEEDS RESEARCH (community LoRA, HF/Civitai) |

Total ≈ 21.2 GB.

Footgun: legacy `old_img-qwen-image.json` references
`Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf` (different quant). Only Q8_0 should
appear in the manifest (active workflow)
(`LINUX_INSTALLER_RECONNAISSANCE.md:126-129`).
| img-qwen-image | 12 `VAELoader.vae_name` | `qwen_image_vae.safetensors` | `models/vae/` | 242.05 MiB (sha256[:12] `a70580f0213e`) | UNKNOWN — NEEDS RESEARCH (HF) |
| img-qwen-image | 1010 `LoraLoaderModelOnly.lora_name` | `Wuli-Qwen-Image-2512-Turbo-LoRA-4steps-V3.0.safetensors` | `models/loras/` | 1.10 GiB | UNKNOWN — NEEDS RESEARCH (community LoRA, HF/Civitai) |



### 7.3 Video / ltx-2.3

Identical set across all four `video-ltx-*p`:

| Node / field | Filename | Target Directory | Size (audit) | Source |
|---|---|---|---:|---|
| 141 `UnetLoaderGGUF.unet_name` | `LTX-2.3-distilled-Q4_K_M.gguf` | `models/unet/` | 16.54 GiB | UNKNOWN — NEEDS RESEARCH (HF) |
| 227 `DualCLIPLoaderGGUF.clip_name1` | `gemma-3-12b-it-qat-UD-Q4_K_XL.gguf` | `models/text_encoders/` | 6.92 GiB | UNKNOWN — NEEDS RESEARCH (HF; UD quant Gemma-3-12B; possible gated access) |
| 227 `DualCLIPLoaderGGUF.clip_name2` | `ltx-2.3_text_projection_bf16.safetensors` | `models/text_encoders/` | 2.15 GiB | UNKNOWN — NEEDS RESEARCH (HF) |
| 188 `LoraLoaderModelOnly.lora_name` | `ltx-2-19b-ic-lora-detailer.safetensors` | `models/loras/` | 2.44 GiB | UNKNOWN — NEEDS RESEARCH (HF) |
| 222 `VAELoaderKJ.vae_name` | `ltx-2.3-22b-dev_video_vae.safetensors` | `models/vae/` | 1.35 GiB | UNKNOWN — NEEDS RESEARCH (HF) |
| 226 `VAELoaderKJ.vae_name` | `ltx-2.3-22b-dev_audio_vae.safetensors` | `models/vae/` | 347.95 MiB | UNKNOWN — NEEDS RESEARCH (HF) |
| 191 `VAELoader.vae_name` | `taeltx2_3.safetensors` | `models/vae/` | 22.44 MiB | UNKNOWN — NEEDS RESEARCH (HF) |

Total ≈ 29.8 GB.

**NOT in required** (present in audits/docs but not referenced by any
production workflow node):

| File | Where mentioned | Status |
|---|---|---|
| `latent_upscale_models/ltx-2.3-spatial-upscaler-x2-1.0.safetensors` (949.62 MiB) | video audit `[5]`; `EXPERIMENTAL_BETA_WORKER_SETUP.md:46`; `SYSTEM.md:66` | **UNUSED by workflow** — no latent-upscale nodes in production workflows. Exclude from manifest (or optional — decision §14) |
| `gemma-3-12b-it-qat-q4_0-unquantized_readout_proj/model/model.safetensors` | video audit `[7]` — references from local UI workflows | UI artifact, not required |
| `ltx-av-step-1751000_vocoder_24K.safetensors` | video audit `[7]` — references from local UI workflows | UI artifact, not required |

---

## 8. Download Sources

Nothing was downloaded. Below are only identified sources.

### 8.1 Confirmed in code/docs repos

| What | Source | Justification |
|---|---|---|
| ComfyUI (video) | GitHub `https://github.com/Comfy-Org/ComfyUI.git`, tag `v0.27.0` (commit `bb131be9e83d2f773c90f1d6f1e4b248a498c8c5`) | `worker/start-video.sh:19-25`; video audit `[4]` (remote `comfyanonymous/ComfyUI`) |
| ComfyUI (audio/image) | GitHub fork `https://github.com/rajsingh1-dev/ComfyUI.git`, commit `c4cfee7ad16cfeb082e12f43cf4751b4a67a4e11` | audio audit `[4]`, image audit "ComfyUI" |
| `ComfyUI-Qwen3-TTS` | GitHub `https://github.com/wanaigc/ComfyUI-Qwen3-TTS`, commit `2ee1131` | audio audit `[6]` |
| `ComfyUI-Manager` | GitHub `https://github.com/ltdrdata/ComfyUI-Manager`, commit `df1eaff8` (audio/image) / `bbafbb12` (video) | audits `[6]`, `SYSTEM.md:50` |
| `ComfyUI-PromptRelay` | GitHub `kijai/ComfyUI-PromptRelay`, commit `ca5d4e3` | `SYSTEM.md:49`, video audit `[6]` |
| `rgthree-comfy` | GitHub `rgthree/rgthree-comfy`, commit `683836c` | `SYSTEM.md:51`, video audit `[6]` |
| TTS models `Qwen/Qwen3-TTS-12Hz-1.7B-{Base,VoiceDesign}` | **ModelScope** (workflow field `download_source`) | `tts-qwen-narrator.json:35-39`, `tts-qwen-dialogue.json:111-128` |
| PyTorch cu124 | `https://download.pytorch.org/whl/cu124` | `worker/start-video.sh:61` |
| Worker bundle | Animastor origin `GET {HUB_URL}/worker-source` | `gpu-hub.js:1050-1060`, `EXPERIMENTAL_BETA_WORKER_SETUP.md:65-73` |

### 8.2 Unconfirmed (UNKNOWN — NEEDS RESEARCH)

For all gguf/safetensors files in image/video (§7.2, §7.3) **the repository
contains no URLs, HF repos, or revisions** — only filenames in workflow JSON
and actual sizes in audits. Specific upstream repos (HF
quants Qwen-Image/Gemma/LTX, LoRA Wuli, VAE) must be identified by a separate
download-research documenting: repo, file path, revision/commit, sha256,
license/gated status. Prior reconnaissance recommendation is to mirror everything into
the organizational HF account `animastor` after license verification
(`LINUX_INSTALLER_RECONNAISSANCE.md:460-476`). **In this research,
URLs are not fabricated.**

### 8.3 Gated access (preliminary)

Potentially gated: Gemma-3-12B variants, some Qwen3-TTS
(`LINUX_INSTALLER_RECONNAISSANCE.md:455, 605`). Exact status — only
via download-research. The installer must support optional
`HF_TOKEN` (never log it).

---

## 9. Runtime Requirements

### 9.1 By profile (actual audit + script data)

| Parameter | audio/qwen-tts | image/qwen-image | video/ltx-2.3 |
|---|---|---|---|
| ComfyUI | fork `rajsingh1-dev/ComfyUI` @ `c4cfee7` (audit) | fork `rajsingh1-dev/ComfyUI` @ `c4cfee7` (audit) | **official** `Comfy-Org/ComfyUI` tag `v0.27.0` @ `bb131be9` (`start-video.sh:19`) |
| Python | 3.10.12 (audit) | 3.10.12 (audit) | 3.10.12 (`SYSTEM.md:17`, audit) |
| PyTorch | **2.10.0+cu128** (audit) | **2.10.0+cu128** (audit) | **2.6.0+cu124** (`start-video.sh:61`, `SYSTEM.md:22`) |
| cuDNN | 91002 (audit) | 91002 (audit) | 9.1.0.70 / 90100 (`SYSTEM.md:24`) |
| CUDA tier | 12.8 (torch build) | 12.8 (torch build) | 12.4 (torch build; driver 550.127.08 reports 12.4) |
| NVIDIA driver (reference) | 550.127.08 | 550.127.08 | 550.127.08 |
| Min. VRAM | not documented | not documented | not documented; reference L40S 46 GB; draft 24 GB in `private-worker-installer-architecture.md:333` not confirmed |
| Node.js | 20+ (`worker.cjs:4` "Node 20+ with global fetch"; `start-worker.sh:80-87` installs 18 — discrepancy) | same | same |
| Other | — | — | frontend-package 1.45.20, comfy-kitchen 0.2.16 (`SYSTEM.md:20-21`); purge cu13 stack; remove stale `comfyui.db`; pip lock `comfy-v0.27.0.lock.txt` |

### 9.2 One shared policy or different?

**Currently — different, and this is not a documented decision but historical
drift:**

- video: official ComfyUI v0.27.0 + torch 2.6.0+cu124 (fully
  scripted, `start-video.sh`);
- audio/image: ComfyUI fork + torch 2.10.0+cu128 (no install script for
  these profiles in the repo**; only `fix-nodes-audio.sh` /
  `fix-nodes-image.sh` which install pip dependencies after launch).

This same discrepancy is explicitly flagged in
`private-worker-installer-architecture.md:596-598` ("audits show different:
v0.27.0 vs fork c4cfee7a — decision needed").

Options (decision — §14):

1. Shared policy: all three profiles on official ComfyUI v0.27.0 +
   cu124. Risk: audio/image were never tested on v0.27.0 — a golden run
   of both profiles is needed.
2. Per-profile policy: manifest carries ComfyUI pin and torch tier per profile.
   More expensive, but reflects the actual state.

---

## 10. Runtime Audit Comparison

Method: required = derived from production workflows (§6, §7); installed =
from audits (`docs/runtime-audits/{audio-qwen,image-qwen,video-ltx-2.3}/`).
Audits — reference only (`docs/runtime-audits/README.md:11-17`).

### 10.1 audio-qwen (audit 2026-08-25)

| Dependency | Required (workflow) | In audit | Status |
|---|---|---|---|
| `ComfyUI-Qwen3-TTS` (all Qwen3TTS* + SaveAudioMP3) | yes | yes, commit `2ee1131` | **found in audit** |
| `comfyui-manager` | no | yes, `df1eaff8` | **present but unused** (utility; question of inclusion — §13) |
| `Qwen3-TTS-12Hz-1.7B-VoiceDesign` (+speech_tokenizer) | yes | yes (3.57 GiB + 650.69 MiB) | **found in audit** |
| `Qwen3-TTS-12Hz-1.7B-Base` (+speech_tokenizer) | yes | yes (3.59 GiB + 650.69 MiB) | **found in audit** |
| ComfyUI fork `c4cfee7` + torch 2.10.0+cu128 | runtime baseline | yes | **cannot determine** — no install script/manifest for audio; unclear whether the fork is required or the official version would suffice |

MISSING: ∅.

### 10.2 image-qwen (audit 2026-08-26)

| Dependency | Required | In audit | Status |
|---|---|---|---|
| `ComfyUI-GGUF` | yes | yes, commit `6ea2651` | **found in audit** |
| `qwen-image-2512-Q4_K_M.gguf` | yes | yes, 12.34 GiB, `models/unet/` | **found in audit** |
| `Qwen2.5-VL-7B-Instruct-Q8_0.gguf` | yes | yes, 7.54 GiB, `models/clip/` | **found in audit** |
| `qwen_image_vae.safetensors` | yes | yes, 242.05 MiB, sha256[:12] `a70580f0213e` | **found in audit** |
| `Wuli-Qwen-Image-2512-Turbo-LoRA-4steps-V3.0.safetensors` | yes | yes, 1.10 GiB, `models/loras/` | **found in audit** |
| `ComfyUI-Florence2`, `ComfyUI-KJNodes`, `ComfyUI-RMBG`, `ComfyUI-segment-anything-2`, `qwen3-tts`, `comfyui-manager` | no | yes | **present but unused** (not referenced in `img-qwen-image`) |
| Local workflow files (`user/default/workflows/`) | no | yes (6 files) | **present but unused** — explicitly marked as UI test artifacts in the audit itself |
| ComfyUI fork `c4cfee7` + torch 2.10.0+cu128 | runtime baseline | yes | **cannot determine** (same as for audio) |

MISSING: ∅.

### 10.3 video-ltx-2.3 (audit 2026-08-26) — detailed breakdown

| Dependency | Required | In audit | Status |
|---|---|---|---|
| `ComfyUI-GGUF` (+ `gguf` lib) | yes | yes (both — plain dirs) | **found in audit** |
| `comfyui-kjnodes` (VAELoaderKJ; **patched**) | yes | yes (patch not visible in audit — only recorded via SYSTEM.md) | **found in audit**; patch status = **cannot determine** from audit |
| `comfyui-videohelpersuite` | likely (SaveVideo/CreateVideo — NEEDS VERIFICATION) | yes | **found in audit** (required status conditional until verification) |
| LTXV* / LTX2* / ManualSigmas / ResizeImageMaskNode / Primitive* | yes (workflow classes) | provider not identified in audit | **cannot determine** — likely core v0.27.0 (§6.1); requires `/object_info` |
| `LTX-2.3-distilled-Q4_K_M.gguf` | yes | yes, 16.54 GiB, `models/unet/` | **found in audit** |
| `gemma-3-12b-it-qat-UD-Q4_K_XL.gguf` | yes | yes, 6.92 GiB, `models/text_encoders/` | **found in audit** |
| `ltx-2.3_text_projection_bf16.safetensors` | yes | yes, 2.15 GiB, `models/text_encoders/` | **found in audit** |
| `ltx-2-19b-ic-lora-detailer.safetensors` | yes | yes, 2.44 GiB, `models/loras/` | **found in audit** |
| `ltx-2.3-22b-dev_video_vae.safetensors` | yes | yes, 1.35 GiB, `models/vae/` | **found in audit** |
| `ltx-2.3-22b-dev_audio_vae.safetensors` | yes | yes, 347.95 MiB, `models/vae/` | **found in audit** |
| `taeltx2_3.safetensors` | yes | yes, 22.44 MiB, `models/vae/` | **found in audit** |
| `ltx-2.3-spatial-upscaler-x2-1.0.safetensors` | **no** (no upscale nodes in workflow) | yes, 949.62 MiB | **present but unused** (mentioned in WORKER_SETUP doc — discrepancy recorded, §14) |
| `comfyui-easy-use`, `ComfyUI-MelBandRoFormer`, `ComfyUI-PromptRelay`, `rgthree-comfy`, `ComfyUI-Manager` | no (classes not referenced in production workflow) | yes | **present but unused** per workflow criteria. ⚠ Discrepancy: `EXPERIMENTAL_BETA_WORKER_SETUP.md:56-58` claims video "also requires comfyui-easy-use, rgthree-comfy". Workflow scan does not confirm → decision needed (possibly the doc is outdated or nodes needed for local UI workflows) |
| 14 local workflow files + their model refs (gemma unquantized, ltx-av vocoder) | no | yes | **present but unused** — UI artifacts (audits `[7]`, `[11]` note this themselves) |
| ComfyUI v0.27.0 + torch 2.6.0+cu124 | yes (runtime baseline) | yes | **found in audit** |

MISSING: ∅.

### 10.4 Comparison summary

- In all three profiles, all workflow-derived required dependencies are **found** in
  the audits — audits were captured from working instances, no "required but
  missing" discrepancies.
- Audits contain significant UNUSED volume (operator custom nodes,
  UI-workflows, upscaler) — confirming the principle "audit ≠ source of truth".
- Three classes of problems not solvable by audits: (a) provider of some video
  class_type (core vs package); (b) kjnodes patch status; (c) whether
  ComfyUI fork is required for audio/image or if this is historical accident.

---

## 11. Installer Boundary

Statuses: `INSTALL` = INSTALLER MUST INSTALL · `KNOW` = INSTALLER MUST KNOW
ABOUT · `BACKEND` = BACKEND ONLY · `WORKER` = WORKER ONLY · `REF` =
REFERENCE ONLY · `UNKNOWN` = NEEDS DECISION.

```
PROFILE (audio/qwen-tts | image/qwen-image | video/ltx-2.3)
   │   backend/ai/profiles/**.json ........................ BACKEND
   │   (profile id = install key for installer) ........... KNOW
   │
   ├── CONNECTOR (conn-*.json) ............................ BACKEND
   │      │  not installed; does not cross VPS→GPU boundary
   │      │  workflowHash/class expectations ............... KNOW (optional, drift-check)
   │      │
   │      └── WORKFLOW (backend/ai/workflows/*.json) ...... BACKEND
   │              │  delivered at runtime as task.params;
   │              │  no installation on worker disk required
   │              │  (optional offline/debug copy) ......... REF
   │              │
   │              ├── CUSTOM NODES ........................ INSTALL
   │              │     audio: ComfyUI-Qwen3-TTS
   │              │     image: ComfyUI-GGUF
   │              │     video: ComfyUI-GGUF(+gguf), kjnodes(+AudioVAE patch),
   │              │            VHS (NEEDS VERIFICATION),
   │              │            other class_type — UNKNOWN (§6.1)
   │              │
   │              └── MODELS .............................. INSTALL
   │                    audio: 2×ModelScope repo (or KNOW —
   │                           if relying on auto_download) ... UNKNOWN
   │                    image: 4 files (~21 GB)
   │                    video: 7 files (~30 GB)
   │
   └── RUNTIME REQUIREMENTS
          ComfyUI (pin per profile) ...................... INSTALL
          Python 3.10 + pip lock ......................... INSTALL
          PyTorch + CUDA tier (cu124/cu128 — decision) ... INSTALL
          Node.js 20+ .................................... INSTALL
          NVIDIA driver / CUDA userland .................. WORKER
            (installer v1 only verifies, does not install —
             private-worker-installer-architecture.md §13)
          worker bundle (worker.cjs, cleanup, journal,
            package.json, .env) .......................... INSTALL
          worker mode (private/share/system) ............. BACKEND
            (determined by hub from token — PW-4;
             installer does NOT ask for mode)
          Runtime audits ................................. REF
          Skills / rules / examples (backend/ai) ......... BACKEND
```

Boundary verified by code (matches the one proposed in the task):

```
                 BACKEND / VPS
┌─────────────────────────────────────────┐
│ Profile    (prompt-assembly metadata)   │
│    ↓ (connector.profile.{type}Profile)  │
│ Connector  (entity→node bindings)       │
│    ↓ (setValue: patches workflow JSON)     │
│ Production Workflow (complete JSON)        │
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

What can already go into manifest drafts (without fabricated URLs/revisions):

### 12.1 Common across all profiles

- `worker` bundle: `worker/worker/{worker.cjs, worker-cleanup.cjs,
  worker-cleanup-journal.cjs, package.json, .env.example}`; min version
  v2.0.0 (`worker.cjs:2`); source — origin `GET /gpu/worker-source`
  or repo.
- required env: `HUB_URL`, `ANIMASTOR_WORKER_TOKEN` (fail-closed),
  `WORKER_TYPE`, `WORKER_ID`; optional: `COMFY_PORT`, `COMFY_INPUT_DIR`,
  `WORKER_JOURNAL_DIR`, `NOTEBOOK_PATH` (`worker/worker/.env.example`).
- Node.js ≥ 20 (per worker code; discrepancy with 18 in start-worker.sh —
  §13).
- verification: `scripts/animastor-runtime-audit.sh` as post-install
  diff tool (`private-worker-installer-architecture.md` §5.7).

### 12.2 Per-profile

| Field | audio/qwen-tts | image/qwen-image | video/ltx-2.3 |
|---|---|---|---|
| workflows (provenance) | tts-qwen-narrator, tts-qwen-dialogue | img-qwen-image | video-ltx-1p…4p |
| custom_nodes | ComfyUI-Qwen3-TTS @ 2ee1131 | ComfyUI-GGUF @ 6ea2651 | ComfyUI-GGUF (+gguf), comfyui-kjnodes (+patch AudioVAE), [VHS — NEEDS VERIFICATION] |
| models | 2 model_repo entries (ModelScope; type=model_repo) | 4 files: unet/clip/vae/loras | 7 files: unet/text_encoders×2/loras/vae×3 |
| disk budget (from audits) | ≈ 8.5 GB + ComfyUI | ≈ 21.2 GB + ComfyUI | ≈ 29.8 GB + ComfyUI (~32 GB with upscaler, if included) |
| comfyui pin | UNKNOWN (fork c4cfee7 — decision) | UNKNOWN (fork c4cfee7 — decision) | v0.27.0 @ bb131be9 |
| torch pin | UNKNOWN (2.10.0+cu128 in audit — decision) | UNKNOWN (2.10.0+cu128 — decision) | 2.6.0+cu124, index cu124 |
| special operations | — | — | purge cu13; stale comfyui.db cleanup; kjnodes patch; pip lock |
| hardware | VRAM min UNKNOWN | VRAM min UNKNOWN | VRAM min UNKNOWN (reference 46 GB) |

### 12.3 What the manifest cannot take from audits without annotation

- upscaler model (video) — not referenced in workflow;
- easy-use/MelBandRoFormer/PromptRelay/rgthree/Manager (video) and
  Florence2/KJNodes/RMBG/SAM2/qwen3-tts (image) — not referenced in workflow;
- local UI-workflows and their model refs;
- torch 2.10.0+cu128 for audio/image — unified runtime policy not yet decided.

---

## 13. Open Questions

1. **ComfyUI pin for audio/image** (largest): fork
   `rajsingh1-dev/ComfyUI@c4cfee7` — required, or do profiles work on
   official v0.27.0? A golden run of audio+image on v0.27.0 is needed, or
   a decision to include the fork in the manifest. (§9.2)
2. **Torch/CUDA tier**: cu124 (video) vs cu128 (audio/image) — unified
   tier or per-profile?
3. **TTS models**: installer preloads ModelScope repo (determinism,
   offline) or relies on `Qwen3TTSLoader.auto_download`? If
   preloading — need `modelscope download` mechanics and target layout
   `models/TTS/Qwen/...` (including `speech_tokenizer/`).
4. **class_type provider**: `SaveVideo`, `CreateVideo`,
   `LTX2SamplingPreviewOverride`, `ManualSigmas`, `ResizeImageMaskNode`,
   `PrimitiveInt`, `PrimitiveFloat`, and exact attribution of
   LTXV*/AV nodes (core vs package) — verify via `/object_info` on
   the reference video instance. The answer determines the custom_nodes
   list in the video manifest.
5. **SaveAudioMP3** — confirm attribution to
   ComfyUI-Qwen3-TTS package (`/object_info` on audio instance).
6. **Upstreams for plain-dir nodes** (GGUF, gguf, kjnodes, VHS etc.): find
   git repositories and commits or prepare bundle archives
   (`LINUX_INSTALLER_RECONNAISSANCE.md:164-168`).
7. **Model download-research**: all 11 image/video files — repo,
   revision, sha256, license/gated (§8.2).
8. **ComfyUI-Manager**: include in manifest as optional utility
   (present in all audits, but not required by workflow)?
9. **Documentation discrepancy**: `EXPERIMENTAL_BETA_WORKER_SETUP.md:56-58`
   requires easy-use/rgthree for video; workflow scan does not. Which is correct?
10. **Upscaler model** (`ltx-2.3-spatial-upscaler-x2-1.0.safetensors`):
    exclude from manifest or keep optional "for future use"?
11. **Node.js**: 18 (start-worker.sh) vs 20 (worker.cjs header) —
    unify the requirement.
12. **Minimum VRAM** per profile — not documented anywhere; measurements
    or a conservative draft are needed.

---

## 14. Findings / Decisions Needed

### Established with certainty (evidence in code)

1. **Source of truth for install manifest — production workflows**
   (`backend/ai/workflows/*.json`), linked to profiles via
   `profile.{type}Profile` in connectors. Profile files carry only
   prompt-assembly metadata; the `workflow` field in them is decorative (not read by code).
2. **Connector = backend-side execution metadata.** Not installed,
   does not cross VPS→GPU boundary, adds no runtime dependencies.
   The installer only needs to *know* about them (workflowHash) for optional
   drift-check.
3. **Workflow JSON is not installed on GPU box** — delivered at
   runtime via `task.params` (hub → worker → ComfyUI `/prompt`).
4. **7 production workflows**, full class_type and model/file
   ref list extracted (§5–§7); legacy `old_*` excluded.
5. **Model inventory**: audio 2 repos (ModelScope, auto_download),
   image 4 files ≈21 GB, video 7 files ≈30 GB; target directories
   confirmed by audits; sizes documented.
6. **Required custom nodes**: audio — ComfyUI-Qwen3-TTS; image —
   ComfyUI-GGUF; video — ComfyUI-GGUF(+gguf) + kjnodes (with mandatory
   AudioVAE patch) + likely VHS.
7. **All required dependencies found in all audits (MISSING = ∅)**; significant
   UNUSED discovered, confirming: audit = reference, not source of truth.
8. **Worker bundle and env contract** fully described and stable
   (v2.0.0, fail-closed PW-4).

### Connector role — confirmed formulation

A connector is **a mechanism for filling workflow values with entity data on
the VPS**: declarative bindings (entity → nodeId.field), validated
against the workflow at backend startup. The connector does not enter
the install footprint in any way; its only "shadow" on the GPU box is the
already-substituted values inside the delivered workflow JSON.

### Decisions needed before manifest drafts

| # | Decision | Impact |
|---|---|---|
| D1 | Unified ComfyUI/torch policy (v0.27.0+cu124 for all?) or per-profile | manifest structure: one shared runtime block or three |
| D2 | TTS models: preload vs auto_download | audio model entry type in manifest |
| D3 | UNKNOWN class_type verification via /object_info | final video custom_nodes list |
| D4 | Upstreams/bundles for plain-dir nodes | video node installation mechanics |
| D5 | Download-research for 11 model files (repo/sha256/gated) | populating `source`/`checksum` fields |
| D6 | Upscaler and "documented" easy-use/rgthree: include/exclude | video manifest size |
| D7 | ComfyUI-Manager: optional utility or not | all manifest sizes |

After this research, **we do NOT proceed to Installer implementation** —
the next step per the architecture draft (§17): manifest drafts
(recommended pilot — `image/qwen-image` as smallest footprint) based
on §12 of this document.
