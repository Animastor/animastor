# Private Worker Installer — Architecture Draft

> **Version:** 0.2.0 (draft — architecture; Phase 1 + Phase 1.5 foundation implemented)
> **Status:** Planning + foundation implemented
> **Date:** 2026-08-26
>
> This document is an architectural draft for a new simple Installer for
> **Animastor Private Workers**. It is NOT an installation guide and
> does NOT replace existing systems: workflow/connector layer, GPU Hub,
> runtime audits, `worker/start-worker.sh`.
>
> **Phase 1.5** (Existing ComfyUI, Workflows, flexible profile mode) —
> see `docs/04-planning/private-worker-installer-phase15.md`.

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

Key Phase 1.5 principle: **a profile is a baseline, not a prison**.
Baseline workflow is a starting point for the user and may be
customized locally (installer never overwrites the user's copy).

### Runtime Modes (fixed)

| Mode | Environment owner | Installer behavior |
|---|---|---|
| **Managed** | Installer (V1 target) | full install: ComfyUI → runtime → nodes → models → workflows → worker → .env → verify |
| **Existing** | User | detect → compare → report → offer missing components; NEVER auto-remove/downgrade/replace |
| **Isolated** | One GPU machine, N independent ComfyUI environments | each environment resolved independently under its own root (data model; full implementation later) |
| **Shared** | One ComfyUI for multiple profiles | dependency union + compatibility check; on conflict → "Isolation recommended", no automatic split |

---

## 1. Problem

Today, deploying a GPU worker for Animastor is a manual multi-step
process: set up ComfyUI of the correct version, install torch with the
right CUDA, install custom nodes, download models to the correct directories,
place `worker.cjs`, fill in `.env`, register the worker.

Existing artifacts solve parts of the problem, but not the whole:

| Artifact | What it does | What it doesn't do |
|---|---|---|
| `worker/start-video.sh` | installs ComfyUI v0.27.0 + torch cu124 | doesn't know about profiles/models/custom nodes |
| `worker/start-worker.sh` | starts worker, reads `.env` | doesn't install dependencies |
| `scripts/animastor-runtime-audit.sh` | read-only audit of a live instance | doesn't install anything |
| `docs/runtime-audits/*` | reference snapshots of working environments | explicitly "not installation instructions" |
| `backend/ai/profiles/**` | backend prompt-assembly profiles | don't describe install dependencies |

Goal of the installer: **one command on a GPU server → ready Private Worker**
for the selected Generation Profile.

## 2. Goals

1. One command: `installer --profile <profile>` → ready working worker.
2. Determinism: same result on repeat runs (idempotency).
3. Clear dependency model: what is required, what is already installed, what is missing.
4. Security: Worker Key — interactive user secret;
   never reaches logs, git, or argv.
5. Verifiability: post-install automatic verification
   (including reuse of runtime-audit as reference).
6. Reuse of existing architecture: workflows remain on VPS,
   delivery via GPU Hub unchanged, runtime/orchestration logic
   untouched.

## 3. Non-goals

- Don't change runtime / orchestration / dispatch logic of backend, hub, worker.
- Don't do dependency research (specific model/node URLs — separate task).
- Don't download models as part of preparing this document.
- Don't replace GPU Hub provisioning (see `RunPod_Integration_GPU_Hub.md`) —
  installer works on top of existing worker contract, not instead of it.
- Don't support Windows/macOS — only Linux GPU servers (Ubuntu-like).
- Don't do multi-profile installation in one directory (v1: one profile
  = one install; extensibility to be considered).

## 4. Architecture Overview

```
                    ┌──────────────────────────────────────────┐
                    │            Generation Profile             │
                    │   (declarative description "what is needed") │
                    │   backend/ai/profiles/{type}/{name}.json  │
                    └───────────────┬──────────────────────────┘
                                    │ references
                    ┌───────────────▼──────────────────────────┐
                    │         Production Workflows              │
                    │  backend/ai/workflows/*.json + connectors │
                    │  (source of truth for required deps)      │
                    └───────────────┬──────────────────────────┘
                                    │ scan (class_type, file refs)
                    ┌───────────────▼──────────────────────────┐
                    │        Dependency Resolver                │
                    │  required ∪ installed → missing/unused/…  │
                    └───────────────┬──────────────────────────┘
                                    │ produces
                    ┌───────────────▼──────────────────────────┐
                    │      Canonical Install Manifest           │
                    │  (versioned, signed document)             │
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
    (NOT source of truth for manifest)
```

### Key principle

> **Runtime audit is NOT the source of truth for install manifest.**
> Source of truth for required dependencies is **production workflows**
> associated with the profile. Runtime audit is used only for:
> - verification ("does installed look like known working environment");
> - reference when preparing/revisioning manifest by a human;
> - diagnosing discrepancies (`unused`, `unknown`).

Reason: audit captures *historical* state of one instance
(including UI test artifacts by the operator, see note in
`docs/runtime-audits/image-qwen/...md`), while workflow defines what
is *actually required* during task execution.

## 5. Components

### 5.1 Generation Profile

**Location:** `backend/ai/profiles/{type}/{profile}.json`
(existing: `audio/qwen-tts.json`, `image/qwen-image.json`,
`video/ltx-2.3.json` — currently they describe prompt-assembly).

Extended role: profile becomes the **root of declaration** — it references
production workflows and install specification, but does not
manually list models/nodes where they can be derived from workflows.

Responsibilities:
- select set of production workflows (`workflow: "video-ltx-*"` already exists);
- reference install spec (see below) and ComfyUI version policy;
- declare hardware requirements (minimum VRAM, CUDA tier) — draft.

Not responsible: installation paths, download mechanics.

### 5.2 Production Workflows

**Source:** `backend/ai/workflows/*.json` + `backend/ai/connectors/*.json`.
Already contain machine-readable information about requirements:
- `class_type` of each node → which custom nodes are required;
- string refs to model files (`*.gguf`, `*.safetensors`, …);
- `model_repo` values (e.g., Qwen3TTS) → Hugging Face sources.

This is the sole source of `required`. Workflow scanning is already implemented in
audit script ([7] WORKFLOWS) — same logic is reused by resolver.

Important (confirmed by `docs/runtime-audits/README.md`): workflow JSON
is **NOT delivered to the GPU box** — it arrives over the network from backend through
GPU Hub in `task.params`. Therefore, "installing workflows" by installer is
an optional offline/debug deployment, not a production requirement.

### 5.3 Dependency Resolver

Separate component (in the future — part of tooling repository) that:

1. Takes profile → expands list of production workflows.
2. Scans each workflow: `class_type` → custom node packages;
   file refs → model artifacts.
3. Maps to install spec (declarative mapping table
   "ref → canonical dependency", see §8).
4. Compares with actual machine state (as audit does).
5. Outputs **resolution report**: each dependency in one of states.

Dependency states (mandatory semantics):

| State | Meaning |
|---|---|
| `required` | present in manifest for this profile |
| `installed` | found on machine and matches manifest (version/checksum) |
| `missing` | required but absent on machine → installer must install |
| `unused` | present on machine but not required by this profile (informational; do NOT auto-remove) |
| `unknown` | present on machine but cannot be matched to any manifest entry (no git remote, plain dir, unknown filename) |

Rules:
- `unused` and `unknown` never trigger removal in v1.
- `installed` is confirmed by filename + revision/version (+ checksum if
  available without full re-hashing of large files).
- Resolver report — input for installer; installer does not make decisions
  about what is "needed" on its own.

### 5.4 Canonical Install Manifest

Single versioned document describing complete install footprint
of a profile. Schema — §9. Manifest:

- generated/revised **offline** (in Animastor repository),
  based on workflows + human-confirmed research;
- consumed by installer on GPU machine;
- contains everything: ComfyUI policy, python/torch, models, custom nodes,
  worker bundle, env template.

Manifest ≠ audit snapshot. Audit may be used when preparing
manifest as reference, but each entry must be derived from
workflows or explicitly marked as `optional` / `debug`.

### 5.5 Installer

Single executable script/binary run on GPU server. Phases — §11.
Installer is the only component with write access to target machine.
It executes manifest literally and does not "know" profile specifics.

### 5.6 Worker

Existing `worker/worker/worker.cjs` (v2.0.0, fail-closed auth).
No changes to worker code required. Installer:
- deploys worker bundle (`worker.cjs`, cleanup/journal, package.json);
- creates `.env` (§12);
- starts via existing mechanism (`start-worker.sh <type>`
  or direct call — open question, §16).

Registration with GPU Hub happens by worker itself on startup
(`Authorization: Bearer wrk.<id>.<secret>`); installer only ensures
correct token is present.

### 5.7 Runtime Audit (verification role)

`scripts/animastor-runtime-audit.sh` remains a read-only tool.
New role: **post-install verification step**. Installer at the end may
offer/run audit and compare its output with manifest:
- all `required` present → PASS;
- `unknown`/`unused` present → WARN (list in report to user);
- `required` missing → FAIL.

Additionally, audit snapshots of freshly installed machines populate
`docs/runtime-audits/<profile>/` as reference for next manifest
revisions (human in the loop).

## 6. Data Flow

```
[offline, in repository]
  production workflows ──scan──► dependency table (research, human)
                                        │
  profiles ────────────────────────────►│
                                        ▼
                          Canonical Install Manifest (vX.Y.Z)

[on GPU server]
  installer --profile video/ltx-2.3
      │
      ├─ 1..N installation phases (§11), checking against manifest
      │      each step: check → skip|install → record
      ├─ state file: ~/animastor/install-state.json (what was done)
      ├─ interactive prompt for ANIMASTOR_WORKER_TOKEN
      ├─ start worker → register with GPU Hub
      └─ final verification (health + optional audit diff)
             │
             ▼
        READY Private Worker → standard Animastor dispatch circuit
```

## 7. Profile → Workflow → Dependency → Manifest model

Chain of responsibility (each link knows only its neighbors):

| Link | Owns | Produces |
|---|---|---|
| **Profile** | selection of generation capability; references to workflows + install spec | profile identity, hardware reqs |
| **Workflow(s)** | actual execution requirements: node classes, model file refs | data for dependency discovery |
| **Dependency Resolver** | mapping rules ref→dependency, comparison with machine | resolution report (required/installed/missing/unused/unknown) |
| **Manifest** | canonical install footprint: exact versions, checksums, target paths | executable specification for installer |
| **Installer** | execution mechanics: download, pip, git, writing .env | installed machine, install log/state |
| **Worker** | runtime: connection to Hub, task execution | working service |

Invariants:
1. Workflow is the sole source of `required`.
2. Manifest may add only what can be classified as
   `required` (from workflows) or explicitly `optional`/`bootstrap` (e.g.,
   ComfyUI-Manager as utility — open question, §16).
3. Installer contains no knowledge about profiles — only about operations.
4. Worker does not know how it was installed.

## 8. Dependency model

### 8.1 Dependency types

- `model` — model files (gguf/safetensors): unet, text_encoders, vae,
  loras, upscale_models, TTS, etc. Target — subdirectories of `ComfyUI/models/`.
- `custom_node` — packages in `ComfyUI/custom_nodes/` (git repositories).
- `python_package` — pip dependencies (torch with CUDA index, node requirements).
  Special case: torch is pinned separately (see start-video.sh).
- `runtime` — Node.js ≥ 18/20, NVIDIA driver, CUDA userland.
- `comfyui` — ComfyUI itself (special entry, §10).
- `worker_bundle` — Animastor worker files.

### 8.2 Sources

| Source | For what | Mechanic |
|---|---|---|
| GitHub | ComfyUI, custom nodes | `git clone --branch/--depth 1` + checkout pinned tag/commit |
| Hugging Face | models (gguf/safetensors) | resolve URL → HTTPS download; `HF_TOKEN` support for gated repos |
| ComfyUI registry / Manager ecosystem | custom nodes (if applicable) | optional channel; question open (§16) |
| PyPI / pytorch index | python dependencies | pip with explicit `--index-url` for cu12x |
| Animastor origin | worker_bundle, manifest, lock files | same origin as HUB_URL |

Each manifest entry specifies exactly one primary source + fallback
policy (v1: fallback = fail with clear error, no auto-mirrors).

### 8.3 Dependency entry fields

```jsonc
{
  "id": "video.ltx-2.3.unet.LTX-2.3-distilled-Q4_K_M",  // stable ID
  "type": "model",                 // model | custom_node | python_package | runtime | comfyui
  "filename": "LTX-2.3-distilled-Q4_K_M.gguf",
  "target_dir": "models/unet/",    // relative to ComfyUI root
  "source": {
    "kind": "huggingface",          // github | huggingface | comfy_registry | pypi | animastor
    "repository": "<to-be-confirmed>", // repo id / URL — do NOT fabricate without research
    "revision": "<tag-or-commit-or-hash>"
  },
  "size_bytes": 17760858112,        // expected size (for pre-check disk and sanity)
  "checksum": { "algo": "sha256", "value": null },  // value filled after confirmed research
  "requirement": "required",        // required | optional
  "profiles": ["ltx-2.3"],          // association (may be multiple)
  "provenance": {
    "derived_from_workflow": ["video-ltx-2p"],  // which workflow requires it
    "verified_by_audit": ["docs/runtime-audits/video-ltx-2.3/audit-2026-08-26.txt"]
  }
}
```

Mandatory fields: `id`, `type`, `filename`, `target_dir`, `source`,
`revision`, `requirement`, `profiles` — always. `size_bytes`,
`checksum.value` — filled during confirmed research; until then
entry cannot be moved from draft to stable.

## 9. Manifest schema draft

```jsonc
{
  "manifest_version": "1.0.0",       // schema version itself
  "revision": "2026.08.26-r1",        // content revision (monotonic)
  "profiles": [{
    "id": "video/ltx-2.3",
    "type": "video",
    "workflows": ["video-ltx-1p","video-ltx-2p","video-ltx-3p","video-ltx-4p"],
    "hardware": {
      "gpu_min_vram_gb": 24,          // draft, confirm
      "nvidia_driver_min": "550.x",
      "cuda_tier": "12.4"
    }
  }],

  "comfyui": {
    "required_version": "v0.27.0",     // exact tested pin (see start-video.sh)
    "min_version": "v0.27.0",
    "max_tested_version": "v0.27.0",
    "install_source": {
      "kind": "github",
      "repository": "https://github.com/comfyanonymous/ComfyUI.git"
    },
    "compatibility_policy": "exact-pin-preferred | range-if-approved",
    "policy_notes": "see §10"
  },

  "python": {
    "min_version": "3.10",
    "torch": { "pin": "2.6.0+cu124", "index_url": "https://download.pytorch.org/whl/cu124" },
    "lock_file": true                  // pip freeze lock, as in start-video.sh
  },

  "dependencies": [ /* array of §8.3 entries */ ],

  "worker": {
    "bundle_source": { "kind": "animastor", "path": "worker/worker/" },
    "min_worker_version": "v2.0.0",
    "env_template": "worker/worker/.env.example",
    "required_env": ["HUB_URL","ANIMASTOR_WORKER_TOKEN","WORKER_TYPE","WORKER_ID"],
    "optional_env": ["COMFY_PORT","COMFY_INPUT_DIR","WORKER_JOURNAL_DIR","NOTEBOOK_PATH"]
  },

  "disk_budget": { "estimated_total_bytes": 0 },  // sum of size_bytes, filled by research

  "verification": {
    "method": "audit-diff",
    "audit_script": "scripts/animastor-runtime-audit.sh",
    "pass_criteria": "all required=installed; missing=∅",
    "warn_criteria": "unknown/unused > 0"
  }
}
```

Storage: `backend/ai/install-manifests/{type}/{profile}.json` — next to
profiles, but separate tree, to avoid mixing prompt-assembly and
install semantics. (Alternative — embed in profile; see §16.)

## 10. Version compatibility strategy (ComfyUI)

Fields: `required_version` (exact tested pin), `min_version`,
`max_tested_version`, install source, policy.

Default policy — **exact-pin-preferred**:

| Situation | Action |
|---|---|
| no ComfyUI | clone/checkout `required_version` |
| version == required | OK, skip |
| version within [min, max_tested] but ≠ required | OK with warning (range-if-approved) |
| version < min_version | suggest upgrade to required; refuse → abort with explanation |
| version > max_tested_version | do NOT silently downgrade; ask user: downgrade to pin OR continue at-your-own-risk (record in state) |
| not a git repository / version cannot be determined | scenario D/unknown — ask user |

Upgrade/downgrade is performed via `git fetch tag && checkout -f`
(as in existing `start-video.sh`), preserving `custom_nodes/`,
`models/`, `user/`. Before version change — mandatory state checkpoint
(§14). After change — reinstall dependencies from `requirements.txt` +
requirements of all custom nodes.

Pin is updated only through new manifest revision after the
"ComfyUI + torch + nodes" combo has been verified by real generation
(golden run) — also see lock file practice in `start-video.sh`.

## 11. Installer lifecycle

```
Phase 0  Preflight
         - OS/arch, disk space (≥ disk_budget), RAM
         - nvidia-smi: GPU present, VRAM vs profile.hardware
         - network reachability: GitHub, HF, Animastor origin
         - permissions: don't run as root unless necessary; write to $HOME

Phase 1  System runtime
         - Node.js ≥18 (nodesource), git, curl — as in start-worker.sh
         - Python + venv

Phase 2  ComfyUI
         - detection (same heuristics as audit script)
         - applying policy §10 (scenarios A–D)

Phase 3  Python deps
         - ComfyUI requirements (from lock file if available)
         - torch pin with CUDA index
         - requirements of each custom node

Phase 4  Custom nodes
         - for each type=custom_node entry: clone/pin or skip (F/G)

Phase 5  Models
         - pre-check: free space ≥ size_bytes
         - download to *.part → rename on completion (H/I/J-safe)
         - checksum verify (if specified)

Phase 6  Worker bundle
         - deploy worker files to ~/animastor/worker/
         - npm install (node-fetch)

Phase 7  .env + Worker Key
         - create/update .env (merge, don't overwrite other keys)
         - interactively prompt for ANIMASTOR_WORKER_TOKEN
           (hidden input, no echo in logs; check format wrk.<id>.<secret>)
         - WORKER_TYPE from profile; HUB_URL default https://animastor.in/gpu

Phase 8  Start & register
         - stop old worker processes (as in start-worker.sh §9)
         - start worker → wait for successful Hub registration
           (heartbeat/registry confirmation in worker log)

Phase 9  Final verification
         - worker process alive; registered; ComfyUI /system_stats OK
         - smoke test: test task (open question, §16)
         - optional: run runtime-audit → diff against manifest → report
           (PASS / WARN(unknown, unused) / FAIL(missing))

Output: print summary: what was installed, what was skipped, where logs are,
how to restart worker (start-worker.sh <type>).
```

CLI (draft):

```
animastor-installer --profile video/ltx-2.3 [--dry-run] [--yes]
                    [--env-file PATH] [--skip-models] [--resume]
--dry-run   : resolution report only, don't change anything
--yes       : don't ask for confirmations (except Worker Key)
--resume    : continue interrupted installation from state file
```

## 12. Worker configuration / .env

Uses existing `worker/worker/.env.example` format:

- REQUIRED: `HUB_URL`, `ANIMASTOR_WORKER_TOKEN` (wrk.…), `WORKER_TYPE`,
  `WORKER_ID`;
- OPTIONAL: `COMFY_PORT`, `COMFY_INPUT_DIR`, `WORKER_JOURNAL_DIR`,
  `NOTEBOOK_PATH`.

Installer rules:
- merge semantics: existing `.env` is not overwritten entirely;
  only installer keys are updated; existing token is NOT touched
  (if valid) — this makes rerun safe;
- file permissions: `chmod 600`;
- values are never printed (same redaction principle as in audit
  script: secret KEY=value → `KEY=<REDACTED>`).

Worker Key UX: **user secret**, entered interactively in Phase 7.
Do not accept token via CLI-argv (visible in `ps`); acceptable via
stdin/prompt or environment variable at own risk.

## 13. Version compatibility (general model)

| Component | How it is pinned |
|---|---|
| ComfyUI | git tag/commit (§10) |
| custom_node | git commit/tag per entry |
| model | source revision + checksum + size |
| python/torch | explicit pin + index-url + pip lock |
| worker | min_worker_version in manifest; bundle delivered from origin |
| driver/CUDA | checked in preflight, not installed by installer (v1) |

Manifest ↔ workflows compatibility: manifest stores list of workflows from
which dependencies were derived (`provenance.derived_from_workflow`). When
workflow JSON changes (new class_type/file ref) CI-check should
flag: "workflow changed → manifest requires revision". This protects
against drift between source of truth and manifest.

## 14. Error handling / rollback strategy

Scenarios (mandatory to handle):

| # | Scenario | Policy |
|---|---|---|
| A | ComfyUI missing | install exact-pin; if GitHub unavailable — fail with retry hint |
| B | ComfyUI compatible | skip, record in state |
| C | Version too old (< min) | suggest upgrade to pin; refuse → abort (don't work on unsupported version) |
| D | Version newer than max_tested | ask: downgrade to pin / continue-at-own-risk; don't change anything silently |
| E | Dependency missing | download per manifest (Phase 4/5) |
| F | Dependency already installed (matches) | skip + verify (filename+revision; checksum — if cheap) |
| G | Installed but different version | policy per-type: model → replace (after name backup) or ask; custom_node → checkout to pin (git-safe) or ask; python → bring to pin |
| H | Download interrupted | `.part` files, resume/range if source supports it, otherwise delete part and start fresh on rerun |
| I | Checksum mismatch | delete file, FAIL step, don't continue with corrupt model; clear message |
| J | Rerun installer | idempotent: based on state file + actual machine state recompute missing and finish; already done → skip |
| K | Partial installation | state file (`~/animastor/install-state.json`) writes each completed step; `--resume` continues; rerun without resume also safe (check-before-do) |
| L | Worker registration failure | distinguish causes: invalid token (401/fail-closed) → re-prompt key; network/HUB unavailable → retry with backoff; Hub rejects type → message about WORKER_TYPE mismatch |

Rollback:
- v1 — **forward-only with checkpoints**, no full undo (full rollback
  of models worth tens of GiB is impractical).
- Before changing ComfyUI version / replacing existing files —
  checkpoint: write previous commit/tag and list of replaced files to
  state; provide `--rollback-last` command to return ComfyUI to previous
  pin (models not touched).
- Any FAIL leaves machine in consistent state: partial
  `.part` files deleted, state marks step as failed with reason.

## 15. Idempotency & Security

Idempotency:
- each step = pure function of (manifest, actual state) → action;
- check-before-do everywhere: existence, version, checksum;
- rerun after success — no-op with report;
- state file — optimization, not source of truth (truth is disk).

Security:
- Worker Key: interactive input, hidden, chmod 600 on .env, redaction in
  any logs (based on SECRET_NAMES list from audit script);
- token not in argv, not in state file, not in logs, not in git;
- downloads: HTTPS only, checksum mandatory schema field (value may
  appear after research); without checksum — at minimum size sanity check;
- installer does not expose ports externally (ComfyUI listens on 127.0.0.1, as in
  start-video.sh); all traffic — outgoing connections to Hub;
- no arbitrary code execution from external sources except through
  standard mechanisms (pip node requirements, git clone) — risk accepted,
  documented;
- HF_TOKEN (if needed for gated models) — optional input, same
  storage rules as for worker key.

## 16. Open questions

1. Manifest location: `backend/ai/install-manifests/` vs nesting in
   `backend/ai/profiles/**`. Does manifest need delivery to machine
   via origin (and then — endpoint on backend/hub)?
2. ComfyUI registry / ComfyUI-Manager as custom node installation channel —
   use or stick to direct GitHub?
3. Is smoke-test generation needed in Phase 9 (requires sending test
   task through Hub — touches production queue) or is health/registration
   check sufficient?
4. Multi-profile on one machine: multiple worker processes with one
   ComfyUI? For now v1 = one profile, but directory schema should account for this.
5. Gated Hugging Face models: which require token? (research)
6. `qwen3-tts` node and `gguf` (plain dir without git in audio audit): how
   to represent non-git custom node installs in manifest?
7. Worker bundle update: auto-update on installer rerun or
   separate update path?
8. NVIDIA driver: keep outside installer scope permanently or add
   minimum version check in manifest.hardware?
9. Who owns the model checksum verification process (human in
   the loop)? Need a lightweight "research → review → manifest revision" process.
10. Connection to future RunPod provisioning: installer = what runs
    inside Pod when creating worker via provider? (Yes in spirit, but
    launch interface undefined.)

## 17. Recommended next steps

1. **Workflow dependency extraction (research, read-only):** run
   class_type/file-ref scan across all production workflows
   (`tts-qwen-*`, `img-qwen-image`, `video-ltx-*`) and obtain draft
   dependency tables for three profiles. Result — input for manifest
   drafts. Download nothing.
2. **Manifest schema v0 → two pilot manifests** (recommended
   `image/qwen-image` — smallest footprint ~22G, then
   `video/ltx-2.3`): fill entries with confirmed repository/URL,
   sizes, checksums; fix ComfyUI pins per profile (currently in
   audits different: v0.27.0 vs fork c4cfee7a — decision needed).
3. **Installer skeleton (Phase 0–2 + dry-run):** implement preflight,
   ComfyUI detection/policy and resolution-report in `--dry-run` mode,
   reusing audit script logic; only after that — write phases.

---

### Related documents

- `ARCHITECTURE.md` — repository map
- `docs/runtime-audits/README.md` — role of audits and verified delivery chain
- `docs/06-workflows/WORKFLOW_ARCHITECTURE.md` — three-layer workflow model
- `worker/worker/.env.example`, `worker/start-worker.sh`, `worker/start-video.sh`
- `docs/04-planning/RunPod_Integration_GPU_Hub.md` — future provider-based provisioning
- `docs/04-planning/private-worker-installer-dependency-research.md` — factual dependency research (Phase 1 input)
- `docs/04-planning/private-worker-installer-manifest-resolver.md` — Phase 1 implementation: manifests + resolver + evidence taxonomy + runtime modes
- `docs/04-planning/private-worker-installer-phase15.md` — Phase 1.5: existing ComfyUI, workflows as first-class artifacts, flexible profile mode, interactive flow, safety rules
