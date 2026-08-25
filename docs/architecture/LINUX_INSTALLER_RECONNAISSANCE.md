# Animastor — Linux Installer Architecture Reconnaissance

> **Status:** reconnaissance only. No installer implementation, no code changes, no
> profile mutations. The goal of this document is to map the existing
> profile / workflow / worker surface and to propose an architecture for a
> declarative Linux installer that can turn a fresh GPU box into a fully wired
> Animastor worker (ComfyUI + custom nodes + models + workflows + worker +
> systemd unit) in one `curl … | bash` invocation.

---

## 1. What already exists

### 1.1 Profiles — `backend/ai/profiles/`

Three active profiles, each holding only **UX metadata** (type, model label,
workflow glob, skill, assembly sections, defaults). No runtime dependencies
(models, custom nodes, paths, env vars) are declared here.

| Profile | Type | Model | Workflow glob | Skill |
|---|---|---|---|---|
| `audio/qwen-tts.json` | audio | Qwen3-TTS | `tts-qwen-*` | `audio/qwen-tts` |
| `image/qwen-image.json` | image | Qwen2.5-VL | `img-qwen-image` | `image/qwen-image` |
| `video/ltx-2.3.json` | video | LTX-2.3 | `video-ltx-*` | `video/ltx-2.3` |

`ltx-2.3.json` additionally carries `video.frameAlignment = 8`,
`requiresTrim`, `requiresKeyframeForcing` — these are the only **non-UX**
fields in any of the profiles.

### 1.2 Workflows — `backend/ai/workflows/`

Seven active workflows, three legacy (`old_*` prefix). Models are referenced
inline by class-specific node fields:

| Workflow | Loader fields used | Files referenced |
|---|---|---|
| `tts-qwen-narrator.json` | `Qwen3TTSLoader.model_repo` | `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` (ModelScope) |
| `tts-qwen-dialogue.json` | `Qwen3TTSLoader.model_repo` | `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign`, `…-Base` (ModelScope) |
| `img-qwen-image.json` | `UnetLoaderGGUF`, `CLIPLoaderGGUF`, `VAELoader`, `LoraLoaderModelOnly` | `qwen-image-2512-Q4_K_M.gguf`, `Qwen2.5-VL-7B-Instruct-Q8_0.gguf`, `qwen_image_vae.safetensors`, `Wuli-Qwen-Image-2512-Turbo-LoRA-4steps-V3.0.safetensors` |
| `video-ltx-{1,2,3,4}p.json` | `UnetLoaderGGUF`, `DualCLIPLoaderGGUF`, `VAELoader`, `VAELoaderKJ`, `LoraLoaderModelOnly` | `LTX-2.3-distilled-Q4_K_M.gguf`, `gemma-3-12b-it-qat-UD-Q4_K_XL.gguf`, `ltx-2.3_text_projection_bf16.safetensors`, `ltx-2.3-22b-dev_video_vae.safetensors`, `ltx-2.3-22b-dev_audio_vae.safetensors`, `taeltx2_3.safetensors`, `ltx-2-19b-ic-lora-detailer.safetensors` |
| `old_img-qwen-image.json` | (legacy) | `Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf` (different quant from the active workflow — **footgun**) |
| `old_video-ltx.json` | (legacy) | Same video model set as active LTX workflows |

### 1.3 Connectors — `backend/ai/connectors/conn-*.json`

Seven connectors (`conn-image-generation.json`, `conn-tts-{dialogue,narration}.json`,
`conn-video-{1,2,3,4}p.json`). These are **declarative manifests** with
`connectorVersion`, `workflow` name, `profile` reference, `inputs` / `outputs` /
`parameters` keyed by `entityType` → `nodeId` → `field` → `expectedClass`.
Connectors are validated against the workflow hash on load. This is the
closest existing analogue to what a profile manifest should look like — see §3.

### 1.4 Worker infrastructure (current state)

The worker stack lives in `worker/worker/` (canonical) with legacy snapshots
in `worker/new/` and a leftover `worker/image/worker/`.

| File | Role | Status |
|---|---|---|
| `worker/worker/worker.cjs` | Main Node.js worker (CJS, ~734 LOC, `global.fetch` + `node-fetch@3`) | **Canonical** |
| `worker/worker/worker-cleanup.cjs` | Per-job artifact unlink (input files + output after DELIVERED) | **Canonical** |
| `worker/worker/worker-cleanup-journal.cjs` | Crash-safe journal lifecycle (`created → generated → delivered → cleaned`) | **Canonical** |
| `worker/worker/.env.example` | Worker env template | Canonical |
| `worker/worker/package.json` | `name: worker`, dep `node-fetch@^3.3.2` | Canonical |
| `worker/start-worker.sh` | Wrapper: GPU check, Node 18+ install, port auto-detect, `.env` load, fail-closed on missing token, setsid + verify | Canonical |
| `worker/start-video.sh` | Full ComfyUI v0.27.0 install: pin to tag, deps from lock, custom-node deps loop, cu13 purge, torch 2.6.0+cu124, health-check, write `comfy-v0.27.0.lock.txt` | Canonical |
| `worker/bootstrap-{light,video}.sh` | `@reboot`-style auto-launch | Legacy helper |
| `worker/fix-nodes-{audio,image}.sh` | `pip install -r custom_nodes/<node>/requirements.txt` after ComfyUI starts | Legacy helper |
| `worker/mc.sh` | Async `apt install -y mc` | Convenience only |
| `worker/new/SYSTEM.md` | **Authoritative system description** of the verified L40S reference install (ComfyUI v0.27.0, torch 2.6.0+cu124, cuDNN 9.1.0.70, custom node set, kjnodes AudioVAE patch, comfyui.db stale-cleanup, frontend 1.45.20, comfy-kitchen 0.2.16) | Source of truth for `start-video.sh` |
| `worker/new/MEMORY.md` | Diagnostic + decisions log (cuDNN CUDNN_STATUS_NOT_INITIALIZED, AudioVAE patch, frontend 1.41.x breakage) | Source of truth for known gotchas |
| `worker/image/worker/package.json` | `main: worker.js`, **no node-fetch** | **Legacy artefact — do not use** |

Per `worker/worker/.env.example` and `worker.cjs:28`, the worker reads at
runtime: `HUB_URL`, `ANIMASTOR_WORKER_TOKEN`, `WORKER_TYPE`, `WORKER_ID`,
`COMFY_PORT`, `COMFY_INPUT_DIR`, `NOTEBOOK_PATH`, `WORKER_JOURNAL_DIR`,
optional `RESULT_TIMEOUT_MS` / `VIDEO_RESULT_TIMEOUT_MS` / `TASK_SLEEP_MS` /
`BEACON_INTERVAL_MS`.

**Fail-closed invariant (PW-4)** is enforced at three layers:
`worker.cjs:97` (`process.exit(1)` on auth rejection),
`start-worker.sh:174` (refuse to start without `ANIMASTOR_WORKER_TOKEN`),
`worker.cjs:28` + `start-worker.sh:174` documentation. A missing credential
must never silently turn the box into a shared/system worker — the hub
verifies the token and derives identity / mode from the registry.

### 1.5 .env — three files, three scopes

`worker/worker/.env.example` is the **only** env file the worker reads.
The root `.env.example` documents backend deployment secrets
(`POSTGRES_PASSWORD`, `WORKSPACE_SECRET_KEY`, `GPU_HUB_API_KEY`, `GPU_TIMEOUT`,
`LETS_ENCRYPT_DIR`, `COOKIE_DOMAIN`, `KEEP_AUDIO_CHUNKS`, `AUDIO_CLEANUP_TAIL_ONLY`,
`TRACK_CHUNK_DURATIONS`) and ends with a copy of the worker block for
operator convenience. The worker block in root `.env.example` is a
documentation copy, not what `start-worker.sh` actually loads.

| Variable | Category | Source |
|---|---|---|
| `HUB_URL` | required, user | user input (default `https://animastor.in/gpu`) |
| `ANIMASTOR_WORKER_TOKEN` | required, secret | user input (issued once in Settings → Private Workers) |
| `WORKER_TYPE` | required, choice | installer menu (`image` / `audio` / `video`) |
| `WORKER_ID` | optional, auto | `gpu-$(hostname)` or user label |
| `COMFY_PORT` | optional, auto | `8188`, auto-detect from running ComfyUI |
| `COMFY_INPUT_DIR` | optional, auto | `$HOME/ComfyUI/input` |
| `NOTEBOOK_PATH` | optional | empty for normal install |
| `WORKER_JOURNAL_DIR` | optional, auto | next to `worker.cjs` or `$HOME/animastor/cleanup-journal` |
| `RESULT_TIMEOUT_MS`, `VIDEO_RESULT_TIMEOUT_MS`, `TASK_SLEEP_MS`, `BEACON_INTERVAL_MS` | optional, auto | defaults from `worker.cjs` |

The worker **never decides its own mode**. `private` / `share` / `system` is
resolved by the hub from the registry using the token. The installer must
not ask the user to pick a mode — that would violate PW-4.

### 1.6 Models — full inventory

Sizes and confirmed sources from `worker/new/SYSTEM.md` and the workflow JSONs.

**Image (Qwen-Image) — ≈16 GB total**

| File | ComfyUI path | Source |
|---|---|---|
| `qwen-image-2512-Q4_K_M.gguf` | `models/unet/` | GGUF (Q4_K_M quant of Qwen-Image 2512) |
| `Qwen2.5-VL-7B-Instruct-Q8_0.gguf` | `models/clip/` | GGUF Q8_0 |
| `qwen_image_vae.safetensors` | `models/vae/` | safetensors |
| `Wuli-Qwen-Image-2512-Turbo-LoRA-4steps-V3.0.safetensors` | `models/loras/` | community LoRA |

The active workflow uses **Q8_0** for the text encoder; the legacy
`old_img-qwen-image.json` uses **Q4_K_M**. Both can exist on disk, but only
one is loaded by the active workflow — explicit evidence that model
selection must be declarative and pinned.

**Video (LTX 2.3) — ≈31 GB total**

| File | ComfyUI path | Size |
|---|---|---|
| `LTX-2.3-distilled-Q4_K_M.gguf` | `models/unet/` | 17 GB |
| `gemma-3-12b-it-qat-UD-Q4_K_XL.gguf` | `models/text_encoders/` | 7.0 GB |
| `ltx-2.3_text_projection_bf16.safetensors` | `models/text_encoders/` | 2.2 GB |
| `ltx-2-19b-ic-lora-detailer.safetensors` | `models/loras/` | 2.5 GB |
| `ltx-2.3-22b-dev_video_vae.safetensors` | `models/vae/` | 1.4 GB |
| `ltx-2.3-22b-dev_audio_vae.safetensors` | `models/vae/` | 348 MB |
| `taeltx2_3.safetensors` | `models/vae/` | 23 MB |
| `ltx-2.3-spatial-upscaler-x2-1.0.safetensors` | `models/latent_upscale_models/` | 950 MB |

**Audio (Qwen3-TTS)** — models are **not** in the ComfyUI `models/` tree.
`Qwen3TTSLoader` takes `model_repo` + `download_source: "ModelScope"` and
downloads on demand. The profile must therefore describe a different
acquisition path for TTS (ModelScope, not HF) — the manifest cannot assume
all models live in `~/ComfyUI/models/`.

### 1.7 Custom nodes — `worker/new/SYSTEM.md` (single source of truth)

| Directory | Source | Notes |
|---|---|---|
| `ComfyUI-GGUF` | plain dir | GGUF loaders |
| `gguf` | plain dir | GGUF library |
| `comfyui-kjnodes` | plain dir | **patched** (AudioVAE signature) |
| `comfyui-videohelpersuite` | plain dir | |
| `comfyui-easy-use` | plain dir | |
| `ComfyUI-MelBandRoFormer` | plain dir | |
| `ComfyUI-PromptRelay` | git `kijai/ComfyUI-PromptRelay` @ `ca5d4e3` | |
| `ComfyUI-Manager` | git `ltdrdata/ComfyUI-Manager` @ `bbafbb12` | |
| `rgthree-comfy` | git `rgthree/rgthree-comfy` @ `683836c` | |

Six of the nine are **plain directories without `.git`** — they cannot be
re-cloned with one command. This is the single biggest blocker for a
declarative installer and dictates that the manifest must support
`source: bundle` (tarball shipped in the installer release) in addition to
`source: git`.

### 1.8 ComfyUI pin

`worker/start-video.sh` pins `COMFY_VER="v0.27.0"`, clone via `--branch` or
`fetch tag` + `checkout -f FETCH_HEAD`. Verified commit recorded in
`worker/new/SYSTEM.md`. Lock file `~/animastor/logs/comfy-v0.27.0.lock.txt`
holds the `pip freeze` minus the torch trio. PyTorch is pinned separately
to `2.6.0+cu124` from `https://download.pytorch.org/whl/cu124`.

---

## 2. Inconsistencies and gaps

1. **Profiles don't describe runtime.** `backend/ai/profiles/*.json` carry
   only UX metadata; there is no link to models, custom nodes, env vars, or
   the worker. The runtime must be discovered from workflows + scripts +
   `worker/new/SYSTEM.md` prose, all three of which can drift independently.
2. **Models are hardcoded in workflow JSON.** No separate `models/`
   manifest means no single place holds source, sha256, size, fallback URL.
   The legacy / active image workflow differ only in the CLIP quant
   (`Q4_K_M` vs `Q8_0`) — a silent footgun for any installer that derives
   models purely from the workflow.
3. **Custom nodes are described in prose** (`worker/new/SYSTEM.md` table).
   The bash fix scripts cover only GGUF and `qwen3-tts` deps, and six of the
   nine nodes are plain dirs that cannot be re-cloned.
4. **Triple worker directory.** `worker/worker/` (canonical code),
   `worker/new/` (canonical docs / legacy scripts), `worker/image/worker/`
   (legacy `package.json` with `main: worker.js` and no `node-fetch`).
   The fact that this audit discovered a third `package.json` proves the
   documentation drift hazard.
5. **Worker mode is server-decided** but not currently communicated to the
   user. `start-worker.sh` and the `Settings → Private Workers` UI are the
   only places that hint at the private/share/system distinction. An
   installer that asks the user "private or shared?" would violate PW-4
   (the worker must not be the one choosing its mode).
6. **No installer-versioning system.** ComfyUI tag is pinned in
   `start-video.sh`; node versions in `SYSTEM.md`; worker is just "the file
   in `worker/worker/`". There is no manifest-level concept of "installer
   release X.Y.Z pulls ComfyUI commit abc + worker commit def".
7. **kjnodes AudioVAE patch is not declarative.** It lives as a prose
   instruction in `worker/new/SYSTEM.md` and a manual diff in the
   reference install. If the installer drops it, video generation breaks
   silently.
8. **TTS models bypass `models/`.** `Qwen3TTSLoader.model_repo` downloads
   from ModelScope on first run, not from a file the installer placed.
   This means the manifest must support a non-CUDA-tree acquisition path
   (ModelScope repo) alongside HF file downloads.

---

## 3. What to lift into manifests / profiles

Extend (or replace) the existing `backend/ai/profiles/*.json` payload with
a **runtime section** that captures every dependency the installer needs.
Recommended shape (YAML used here for readability; JSON is equally fine for
machine consumers):

```yaml
profile:
  id: qwen-image
  type: image
  version: 1.0.0

comfyui:
  version: v0.27.0           # exact tag
  pin: tag                   # tag | commit-sha
  repo: https://github.com/Comfy-Org/ComfyUI.git
  lock_file: comfyui/lock.txt        # pip freeze snapshot
  torch: 2.6.0+cu124
  torch_index: https://download.pytorch.org/whl/cu124
  purge_cu13: true                    # mitigates cuDNN clobber
  stale_db_cleanup: ['comfyui.db', 'comfyui.db.lock', 'comfyui.db.bkp']

custom_nodes:
  - id: ComfyUI-GGUF
    source: bundle                    # git | bundle
    bundle: custom_nodes/bundles/ComfyUI-GGUF.tar.zst
  - id: comfyui-kjnodes
    source: bundle
    bundle: custom_nodes/bundles/comfyui-kjnodes.tar.zst
    patches:
      - kind: replace_file
        target: nodes/nodes.py
        diff: custom_nodes/patches/kjnodes-audiovae.diff
        reason: "VAELoaderKJ.AudioVAE(sd, metadata) → VAE(sd=sd, …, metadata=metadata) (ComfyUI v0.27+ removed `sd` arg)"
  - id: rgthree-comfy
    source: git
    repo: https://github.com/rgthree/rgthree-comfy.git
    ref: 683836c
  - id: qwen3-tts
    source: bundle                    # until upstream ships a tagged release we can pin
    bundle: custom_nodes/bundles/qwen3-tts.tar.zst

models:
  - id: qwen-image-unet
    filename: qwen-image-2512-Q4_K_M.gguf
    target: ComfyUI/models/unet/
    source:
      primary: { type: huggingface, repo: animastor/qwen-image-gguf, file: qwen-image-2512-Q4_K_M.gguf }
      mirrors:
        - { type: url, url: https://huggingface.co/<upstream>/resolve/main/qwen-image-2512-Q4_K_M.gguf }
    sha256: <required>
    min_size: 6000000000
    expected_size: 7000000000
  - id: qwen-image-clip
    filename: Qwen2.5-VL-7B-Instruct-Q8_0.gguf
    target: ComfyUI/models/clip/
    # …same shape
  - id: qwen-image-tts-base
    type: model_repo                  # not a file — a ModelScope / HF repo
    repo: Qwen/Qwen3-TTS-12Hz-1.7B-Base
    download_via: modelscope
    triggered_by_class: Qwen3TTSLoader

workflows:
  - file: img-qwen-image.json
    target: ComfyUI/user/default/workflows/
    sha256: <required>
    workflow_hash_field: workflowHash  # matches connector field name

worker:
  source: github-release
  release_repo: animastor/animastor-installer
  release_ref: installer-v1.0.0
  files:
    - worker.cjs
    - worker-cleanup.cjs
    - worker-cleanup-journal.cjs
    - .env.example
    - package.json
  npm_install: true

environment:
  required:
    HUB_URL: { prompt: "Animastor GPU Hub URL", default: "https://animastor.in/gpu" }
    ANIMASTOR_WORKER_TOKEN: { prompt: "Worker token (from Settings → Private Workers)", secret: true }
    WORKER_TYPE: { enum: [image, audio, video], default: image }
  auto:
    WORKER_ID: "gpu-$(hostname)"
    COMFY_PORT: 8188
    COMFY_INPUT_DIR: "$HOME/ComfyUI/input"
    WORKER_JOURNAL_DIR: "$HOME/animastor/cleanup-journal"
    RESULT_TIMEOUT_MS: 600000
    VIDEO_RESULT_TIMEOUT_MS: 7200000
  fail_closed_on_missing: [ANIMASTOR_WORKER_TOKEN]

startup:
  systemd_unit: animastor-worker.service
  fallback_cron: bootstrap-light.sh
  log: ~/animastor/logs/worker.log

cleanup:
  strategy: per-job-journal
  journal_module: worker-cleanup-journal.cjs
  recovery_on_start: true

verify:
  - command: "pgrep -f 'node worker.cjs'"
    label: "worker process"
  - command: "curl -fsS http://127.0.0.1:8188/system_stats"
    label: "ComfyUI API"
  - command: "curl -fsS ${HUB_URL%/gpu}/health"
    label: "GPU Hub"
  - file: installer.lock.yaml
    label: "reproducibility lock"
```

---

## 4. Linking profile → workflow → models → custom nodes → worker

**Workflow parsing is possible but insufficient on its own.**
`UnetLoaderGGUF.unet_name`, `CLIPLoaderGGUF.clip_name`,
`DualCLIPLoaderGGUF.{clip_name1,clip_name2}`, `VAELoader.vae_name`,
`VAELoaderKJ.vae_name`, `LoraLoaderModelOnly.lora_name`,
`Qwen3TTSLoader.model_repo` — all of these are extractable by a small
JSON walk and produce a deterministic dependency list. `class_type` can
then be resolved against a `class_type → node_id` registry to derive the
custom-node set.

But what parsing alone **cannot** give you:
- target path under `ComfyUI/models/<subdir>/` (only the filename is in the
  workflow);
- source URL / HF repo / ModelScope repo;
- sha256 and size for integrity;
- which path is gated and needs `HF_TOKEN`;
- which quantisation variant to install when both exist (the
  `Q4_K_M` vs `Q8_0` CLIP footgun).

**Strategy: manifest is source of truth, workflow is a sanity check.**
The installer validates that every model named in the workflow is present
on disk, parses the workflow to generate the final checklist, and refuses
to start ComfyUI if either side disagrees. This makes the two
authoritative documents cross-check each other and prevents silent drift
when someone edits a workflow JSON without updating the manifest.

---

## 5. .env — what is required, what is generated

**Required, asked of the user:** `HUB_URL`, `ANIMASTOR_WORKER_TOKEN`,
`WORKER_TYPE` (the latter via menu). `HF_TOKEN` is asked only if the
selected profile's manifest marks any model as `gated: true`.

**Auto-generated by the installer:** `WORKER_ID`, `COMFY_PORT`,
`COMFY_INPUT_DIR`, `WORKER_JOURNAL_DIR`, all `*_TIMEOUT_MS` /
`*_SLEEP_MS` / `BEACON_INTERVAL_MS` from the worker defaults.

**Not set anywhere (intentionally):** the `private` / `share` / `system`
mode selector. The hub derives mode from the token + registry. The
installer must not introduce a mode env var — that would create a second
authority and violate PW-4.

The installer writes a single `worker/worker/.env` from this two-secret
input plus the auto-generated block, then double-checks
`ANIMASTOR_WORKER_TOKEN` is non-empty before invoking `start-worker.sh`
(which checks it again — defense in depth).

---

## 6. Recommended file layout

The installer should live in a **new top-level directory** rather than be
shoehorned into `backend/ai/`, because:

- it is the runtime for a *separate machine* (the GPU box) and has no
  reason to be a backend deployment artefact;
- it should release independently of the backend;
- `backend/ai/profiles/` already follows a per-medium convention that
  conflates UX and runtime, and we want the runtime half cleanly separated.

Recommended layout:

```
installer/
├── profiles/                        # declarative runtime manifests
│   ├── audio/qwen-tts.yaml
│   ├── image/qwen-image.yaml
│   └── video/ltx-2.3.yaml
├── models/
│   ├── registry.yaml                # global model catalogue
│   └── manifests/                   # per-profile subsets (generated)
├── custom_nodes/
│   ├── registry.yaml                # id → repo@ref | bundle, patch list
│   ├── bundles/                     # tar.zst for plain_dir nodes
│   └── patches/                     # *.diff for source patches (e.g. kjnodes)
├── workflows/
│   ├── audio/  image/  video/       # files copied from backend/ai/workflows
├── worker/
│   ├── worker.cjs
│   ├── worker-cleanup.cjs
│   ├── worker-cleanup-journal.cjs
│   ├── .env.example
│   └── package.json
├── comfyui/
│   ├── version.txt                  # v0.27.0
│   ├── lock.txt                     # pip freeze snapshot
│   └── torch.txt                    # 2.6.0+cu124
├── systemd/
│   └── animastor-worker.service
├── lib/
│   ├── ui.sh                        # whiptail or stdin fallback
│   ├── manifest.sh                  # YAML/JSON parser
│   ├── download.sh                  # HF + mirror + sha256
│   ├── comfyui.sh                   # clone, deps, lock, torch
│   ├── nodes.sh                     # git clone + bundle extract + patch apply
│   ├── models.sh                    # per-manifest model acquisition
│   ├── worker.sh                    # copy + .env generation + systemd
│   └── verify.sh                    # post-install health check
├── install.sh                       # entry point (curl | bash)
├── installer.lock.yaml.example      # produced after first successful run
└── VERSION                          # semver of the installer release
```

**Alternative (flatter):** extend `backend/ai/profiles/*.json` with a
`runtime:` section. Less clean, but avoids a new top-level root. The
trade-off is a longer-term coupling between backend profiles and GPU
install semantics. The recommended option above is preferable.

---

## 7. Hugging Face as the primary model source

| Scenario | Approach |
|---|---|
| Public models (Qwen-Image, LTX, Gemma) | `huggingface-cli download` or `hf_hub_download` — no token needed |
| Gated (Qwen3-TTS text encoder, certain Gemma variants) | requires `HF_TOKEN`; installer prompts once, writes to `worker/worker/.env` as `HF_TOKEN`; **never logged** |
| CLI vs API | CLI for single-file downloads (`huggingface-cli download <repo> <file> --local-dir <path>`), Python `huggingface_hub.snapshot_download` for repos with multiple files |
| Env var | `HF_TOKEN` and `HUGGINGFACE_HUB_TOKEN` are both supported; persist `HF_TOKEN` |
| Fallback | manifest supports `source.primary` + `source.mirrors[]`; on primary failure (404, network) the installer walks the mirror list |

**Architectural recommendation: create an organisational HF account
`animastor`.** Mirror every model currently used (Qwen-Image, Qwen3-TTS,
LTX-2.3, Gemma) into `huggingface.co/animastor/…` and set
`source.primary` to our org's repo in every manifest. Reasons:

- removes dependence on personal developer accounts and on upstream
  renames / private-toggles;
- mirrors the existing "registry is the source of truth" principle —
  the hub already decides the worker's identity from the registry, the
  model source should similarly be a registry we control;
- allows a single read-only service token bound to the org, not to a
  human;
- per-model licence compatibility must be checked (LTX / Qwen are
  Apache-2.0 or community-compatible — verify before any actual mirror).

**Do not create the account or any token in this reconnaissance.** This
document only records the recommendation.

---

## 8. GitHub as the installer / worker source

**Recommendation: GitHub Releases, pinned by tag, with versioned manifests.**

- **Never** pull from `main` / `master`. The repo is the source of truth
  for production code; an installer pinned to a branch will drift.
- Each installer release = a GitHub Release tagged `installer-vX.Y.Z`,
  containing:
  - `install.sh` (the entry point);
  - `installer.tar.gz` (manifests + lib + registry);
  - `worker-bundle.tar.gz` (`worker.cjs`, `worker-cleanup.cjs`,
    `worker-cleanup-journal.cjs`, `.env.example`, `package.json`);
  - `custom-nodes-bundles.tar.zst` (for plain-dir nodes);
  - `comfyui-lock-<tag>.txt` (pip freeze snapshot, matching `start-video.sh`).
- The installer accepts an `INSTALLER_REF` env var (default `latest`) and
  **always** records the resolved tag and commit into
  `/etc/animastor/installer.lock.yaml` after a successful run.
- Every `repo` / `ref` / `commit` field in the manifest is a tag or a
  commit SHA. ComfyUI is already pinned to `v0.27.0`; the manifest should
  record the resolved commit SHA alongside the tag for forensic
  reproducibility (mirroring what `start-video.sh:36-38` already does
  inline).
- `install.sh --reproduce` reads `installer.lock.yaml` and re-installs
  **strictly** against the recorded versions. This is the same pattern
  that `start-video.sh` uses with `comfy-v0.27.0.lock.txt`.

---

## 9. How the future `install.sh` should work

Target UX:

```bash
curl -fsSL https://github.com/anomalyco/animastor-installer/releases/latest/download/install.sh \
  | bash -s -- --profile image
```

Inside `install.sh` (driven by `lib/*.sh`):

1. **Pre-flight.** `nvidia-smi`, `python3 --version` (≥3.10),
   `arch`, free disk (warn <50 GB for video profile),
   `--profile <id>` argument parsing.
2. **UI.** `whiptail` if TTY available, otherwise stdin questions;
   `DEBIAN_FRONTEND=noninteractive` for `apt`.
3. **User input.**
   - `WORKER_TYPE` (image / audio / video) — menu.
   - `HUB_URL` — default `https://animastor.in/gpu`.
   - `ANIMASTOR_WORKER_TOKEN` — single secret.
   - `HF_TOKEN` — only if the manifest marks any model as `gated: true`.
4. **Resolve manifest.** `installer/profiles/<type>/<id>.yaml`.
5. **ComfyUI install** (`lib/comfyui.sh`).
   - `git clone --branch v0.27.0 --depth 1 … ~/ComfyUI`.
   - If `~/ComfyUI` exists, `fetch tag` + `checkout -f FETCH_HEAD`.
   - Verify exact tag / commit, log both.
   - `pip install -r <lock>` if present, else `requirements.txt`; afterwards
     save `pip freeze` (minus torch trio, minus cu13 packages) as the
     lock.
   - Loop `for req in custom_nodes/*/requirements.txt` and install.
   - `pip uninstall -y cuda-toolkit cuda-bindings … nvidia-*-cu13 …`
     (cuDNN clobber mitigation, see `worker/new/SYSTEM.md` §8).
   - `pip install torch==2.6.0+cu124 torchvision==0.21.0+cu124
     torchaudio==2.6.0+cu124 --index-url
     https://download.pytorch.org/whl/cu124`.
   - `rm -f ~/ComfyUI/user/comfyui.db{,.lock,.bkp}`.
   - `nohup python ~/ComfyUI/main.py --listen 127.0.0.1 --port 8188
     > output.log 2>&1 &`.
   - Health-check `curl -fsS http://127.0.0.1:8188/system_stats`
     for up to 5 minutes; on success, write the lock; on failure,
     tail `output.log` and `exit 1`.
6. **Custom nodes** (`lib/nodes.sh`).
   - For each `custom_nodes` entry: `git clone --branch <ref>` or extract
     `bundle`.
   - Apply each declared `patches[]` (e.g. `kjnodes-audiovae.diff`)
     with `patch -p1`, fail the install if the patch rejects.
7. **Models** (`lib/models.sh`).
   - For each `models` entry: prefer `source.primary`, fall back through
     `source.mirrors[]`; resume on HTTP Range; parallel downloads
     (configurable, default 4).
   - Validate `sha256` if present, else `min_size` / `expected_size`.
   - Skip silently if the file already exists and matches the recorded
     hash (idempotent re-runs).
   - For `type: model_repo` entries (TTS), record the
     `(repo, download_via)` pair so ComfyUI can pull on first run; do
     not download a model the loader fetches on demand.
8. **Workflows** (`lib/workflows.sh`).
   - Copy `workflows/<file>.json` into
     `~/ComfyUI/user/default/workflows/`, verify `sha256`.
   - Update the `workflowHash` field in the corresponding
     `backend/ai/connectors/conn-*.json` if the connector registry is
     present (or note this for the backend restart).
9. **Worker** (`lib/worker.sh`).
   - Extract `worker-bundle.tar.gz` into `~/animastor/worker/`.
   - `npm install` (only `node-fetch@^3.3.2`).
   - Generate `~/animastor/worker/worker/.env` from the user input plus
     auto defaults. Reject if `ANIMASTOR_WORKER_TOKEN` is empty.
   - Install and `systemctl enable --now animastor-worker.service`
     (preferred) or fall back to a cron `@reboot` entry that calls
     `bootstrap-light.sh`.
10. **Verify** (`lib/verify.sh`).
    - `pgrep -f "node worker.cjs"` returns a PID.
    - `curl -fsS http://127.0.0.1:8188/system_stats` returns 200.
    - `curl -fsS ${HUB_URL%/gpu}/health` returns 200.
    - `install.sh` writes `/etc/animastor/installer.lock.yaml` with all
      resolved versions, commits, sha256.
11. **Cleanup infrastructure.** No extra setup: the worker already ships
    `worker-cleanup.cjs` and `worker-cleanup-journal.cjs` and the journal
    path is auto-resolved from `WORKER_JOURNAL_DIR`. The installer just
    needs to ensure the directory exists and is on persistent storage.
12. **Fail-closed.** `start-worker.sh:174` already refuses to start without
    a token; `worker.cjs:97` exits on auth rejection. The installer enforces
    the same invariant upstream — if `ANIMASTOR_WORKER_TOKEN` is empty, the
    installer **does not** reach step 9.

---

## 10. Risks and edge cases

| Risk | Detail | Mitigation |
|---|---|---|
| ComfyUI backend / workflow drift | `v0.27.0` already deprecated upstream; newer tags may not boot the pinned workflows | Manifest pins `comfyui.pin: <exact-commit-sha>`; cross-check with `workflow-hash.txt` |
| Plain-dir custom nodes | Six of nine nodes have no `.git` — cannot be re-cloned | Manifest supports `source: bundle`; bundles ship in the installer release |
| CUDA 12/13 stack clash | `nvidia-cudnn-cu13` clobbers cu12 libs → `CUDNN_STATUS_NOT_INITIALIZED` (see `worker/new/SYSTEM.md` §8) | `comfyui.sh` purges cu13 packages before torch install; lock excludes cu13 entries |
| kjnodes AudioVAE patch | Required for video profile; drop = silent video breakage | `custom_nodes[].patches[]` in manifest; `patch -p1` with explicit failure on reject |
| Stale `comfyui.db` | Migration error on upgrade | `comfyui.sh` removes `~/ComfyUI/user/comfyui.db{,.lock,.bkp}` before start |
| ~33 GB of models | Video profile requires substantial disk | Pre-flight free-space check; refuse with a clear message |
| Gated HF models | Gemma 12B variants and Qwen3-TTS text encoder parts | `gated: true` in manifest; `HF_TOKEN` prompted only when needed; never logged |
| Installer drift | A yesterday-installed installer pulling today's manifests | `INSTALLER_REF` recorded in `installer.lock.yaml`; `--reproduce` reinstalls by lock |
| Fail-closed invariant (PW-4) | A credential-less installer run turning the box into a shared worker | Double fail-closed: installer refuses step 9 without token, `start-worker.sh:174` refuses to start, `worker.cjs:97` exits on auth rejection |
| Legacy `worker.js` artefact | `worker/image/worker/package.json` still references `main: worker.js` | Documented; installer never reads from this directory |
| Triple worker directory | `worker/worker/`, `worker/new/`, `worker/image/worker/` can confuse humans and AI coders | Single source of truth: `worker/new/SYSTEM.md` describes reality, `installer/` is generated from it |
| Network timeouts on multi-GB downloads | Long-running `curl` interrupted | `curl -C -` (resume on Range), retry with backoff, parallel `aria2c` for very large files |
| Parallel worker instances | systemd + manual `setsid` from `start-worker.sh` may both start | Choose one — `systemd` (preferred) — and document the choice; remove manual `setsid` from the systemd path |
| Multi-GPU boxes | `WORKER_ID` collision; one worker.cjs per GPU | `WORKER_ID=gpu-$(hostname)-gpu$(nvidia-smi --query-gpu=index --format=csv,noheader)`; manifest field `multi_gpu: optional` |
| Upstream HF renames | `huggingface-cli download` 404 | `source.mirrors[]`; pre-flight `HEAD` check; alert on missing model |
| TTS models bypass `models/` | `Qwen3TTSLoader` pulls from ModelScope on first run | Manifest supports `type: model_repo` entries that record `(repo, download_via)` without staging a file |

---

## 11. Open questions deferred to a future design pass

- **systemd vs nohup.** `start-worker.sh` uses `setsid` + `nohup`; modern
  practice on Ubuntu prefers systemd. The installer should pick one
  (systemd recommended) and remove the other path to avoid two competing
  supervisors.
- **Where the organisational HF org actually lives.** Recommendation is
  `animastor` on HF; the licence-compatibility review of every model
  (Qwen-Image, Qwen3-TTS, LTX-2.3, Gemma-3, Wuli LoRA) is out of scope for
  this reconnaissance.
- **Connector `workflowHash` regeneration.** The connectors carry a
  `workflowHash` field; if the installer overwrites a workflow file, the
  connector must be rebuilt. The mechanism (build-time vs runtime) is not
  yet defined.
- **Frontend pinning.** `worker/new/SYSTEM.md` notes that `v1.41.x` broke
  link rendering and the verified-good version is `1.45.20`. The manifest
  should record the `comfyui-frontend-package` pin and the
  `comfy-kitchen` pin (currently implicit via the ComfyUI tag) to make
  this explicit.

---

## 12. TL;DR

What exists: profiles (UX-only), workflows (ComfyUI JSON with inline model
names), connectors (declarative `entityType` → `nodeId` bindings, the
closest existing analogue to a runtime manifest), worker.cjs +
worker-cleanup.cjs + worker-cleanup-journal.cjs (the real worker
infrastructure, already split from a single file), `start-video.sh` (full
ComfyUI v0.27.0 install with locked deps), `worker/new/SYSTEM.md` (the
canonical prose description of the reference L40S install).

What can be reused: connector JSON shape, lock-file pattern from
`start-video.sh`, fail-closed three-layer enforcement, hf-hub download
idioms, systemd / `setsid` choice, journal lifecycle already in
`worker-cleanup-journal.cjs`.

What is inconsistent: profile ↔ workflow ↔ model ↔ custom-node ↔ worker
is not declared anywhere; the triple worker directory layout
(`worker/worker/`, `worker/new/`, `worker/image/worker/`); six plain-dir
custom nodes; legacy `old_img-qwen-image.json` with a different CLIP
quant than the active one.

What to lift into manifests: every model with target path, source, sha256,
size, mirrors; every custom node with `source: git|bundle` and patches;
worker files, env block, startup unit, verify commands; ComfyUI pin and
torch pin.

How to link them: manifest is the source of truth; workflow parsing
produces a checklist the installer cross-validates; refuse to start
ComfyUI on disagreement.

How to organise Hugging Face: mirror every model under an `animastor` org
account; `source.primary` always points at the org; one read-only service
token; licence check before mirroring.

How to organise versions: GitHub Releases tagged `installer-vX.Y.Z`,
never pull from `main`; every repo / file pin is a tag or commit SHA;
record resolved versions in `installer.lock.yaml`; `install.sh
--reproduce` reinstalls strictly by lock.

How `install.sh` works: pre-flight → manifest resolve → ComfyUI install
(pinned, locked, torch pinned, cu13 purged) → custom nodes (git or
bundle, patches applied) → models (HF with mirror fallback, sha256,
idempotent) → workflows (copy + hash) → worker (extract + `.env` from
two-secret input + systemd) → verify (worker pid, ComfyUI API, hub
health, lock file). Fail-closed at every credential gate.

Risks to call out: ComfyUI deprecation, plain-dir nodes, cu12/13 clash,
kjnodes patch, stale `comfyui.db`, ~33 GB video models, gated HF, drift
between installer and repo, fail-closed bypass, multi-GPU, network
resume, upstream renames, TTS-on-demand models.
