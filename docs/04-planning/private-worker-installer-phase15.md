# Private Worker Installer — Phase 1.5: Existing ComfyUI, Workflows, Flexible Profile Mode

> **Status:** implemented (architecture + manifest/resolver foundation; no installer executable yet)
> **Date:** 2026-08-26
> **Companion docs:**
> - `docs/04-planning/private-worker-installer-architecture.md` — overall architecture draft
> - `docs/04-planning/private-worker-installer-manifest-resolver.md` — Phase 1 (manifests + resolver)
> - `docs/04-planning/private-worker-installer-dependency-research.md` — factual dependency research

---

## 0. Guiding Principle

> **Installer предоставляет проверенную Animastor baseline-конфигурацию,
> но не забирает контроль над пользовательским ComfyUI.**
>
> The installer delivers a verified Animastor baseline configuration, but it
> never takes control of the user's ComfyUI.

Two real scenarios must both work:

1. **Managed / isolated GPU instance** — E2E Networks, RunPod, Vast AI,
   Docker/VM, a clean machine. The installer owns the environment (V1 target).
2. **Existing local ComfyUI** — the user already installed ComfyUI and knows
   how to use it. The installer detects, compares, and offers — never takes over.

The installer must support both and must NOT force a separate ComfyUI per
profile on the user.

---

## 1. Pipeline

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

A **profile is a baseline, not a prison**:

```
profile
   ↓
baseline requirements
   ↓
baseline workflow
   ↓
user may customize
```

---

## 2. Runtime Modes (fixed)

| Mode | Who owns the environment | Installer behavior | Phase 1.5 status |
|---|---|---|---|
| **Managed** | Installer | Full install: ComfyUI → runtime → nodes → models → workflows → worker → .env → verify | data model + resolver + plan builder ready |
| **Existing** | User | detect ComfyUI/version/Python/Torch/CUDA/GPU/VRAM/nodes/models → compare with profile requirements → offer missing components; **never** auto-remove/downgrade/replace | resolver + prompts ready |
| **Isolated** | One GPU machine, N independent ComfyUI environments (audio / image / video) | each environment resolved independently under its own root | data model + interface only (by design; full implementation later) |
| **Shared** | One ComfyUI serves several profiles | resolver computes the **dependency union** and runs a compatibility check | manifest-level resolution ready |

### Existing mode: version prompts

If an older ComfyUI is detected, the installer asks — the decision stays with
the user:

```
ComfyUI X detected.
Recommended version: Y.

Update?
[Yes] [No]
```

- `Yes` → `update_comfyui` becomes a **confirmed destructive operation**
  (checkpoint before execution);
- `No` + version below minimum → the plan **aborts** with an explanation
  (nothing changed);
- version above the tested maximum → NEVER auto-downgrade; the user chooses
  `Keep` (continue at own risk, recorded) or `Downgrade` (explicit consent).

### Shared mode: conflict semantics

```
Image + Video
       ↓
dependency union
       ↓
compatibility check
```

- all compatible → `shared-compatible` — one ComfyUI is allowed;
- runtime requirements conflict →

```
Profiles cannot safely share this ComfyUI runtime.
Isolation recommended.
```

No automatic split in this phase — recommendation only.

---

## 3. Interactive Installation Flow

The installer is a sequential interactive flow (canonical 12 steps,
`install-plan.js FLOW_STEPS`):

```
1.  Detect GPU
2.  Detect existing ComfyUI
3.  Detect runtime
4.  Select profile(s)
5.  Resolve dependencies
6.  Ask about ComfyUI update
7.  Ask about missing custom nodes
8.  Ask about missing models
9.  Ask about baseline workflows
10. Configure Worker
11. Enter Worker Key securely
12. Verify
```

Before any change the installer shows a plan:

```
Profile: image/qwen-image

Detected:
✓ NVIDIA L40S (45 GB VRAM)
✓ ComfyUI
✓ Torch
✓ ComfyUI-GGUF

Missing:
✗ Wuli-Qwen-Image-2512-Turbo-LoRA-4steps-V3.0.safetensors
✗ Qwen Image (baseline workflow)

Actions:
- Download model ...
- Download baseline workflow Qwen Image
- Configure Animastor worker (image) (.env)

Continue?
[Yes] [No]
```

Potentially destructive operations never run without explicit consent:
prompts without a recorded decision leave the plan `awaiting_decision`;
`buildInstallPlan` is pure — the future execution engine consumes the plan.

---

## 4. Workflows as First-Class Installer Artifacts

A workflow is a separate artifact category (not "just a dependency").

Per-profile production/baseline workflows:

| Profile | Baseline workflows |
|---|---|
| `image/qwen-image` | Qwen Image (`img-qwen-image.json`) |
| `audio/qwen-tts` | Qwen TTS narrator, Qwen TTS dialogue |
| `video/ltx-2.3` | LTX 2.3 1P / 2P / 3P / 4P |

Manifest section (`workflows`, policy `editable-baseline`):

```jsonc
"workflows": {
  "policy": "editable-baseline",
  "baseline_dir": "user/default/workflows/animastor",
  "artifacts": [{
    "id": "workflow:img-qwen-image",
    "name": "Qwen Image",
    "filename": "img-qwen-image.json",
    "target_dir": "user/default/workflows/animastor/image",
    "editable": true,
    "baseline_sha256": "fb4c25e5...",   // hash of the canonical production file
    "source": { "kind": "animastor", "repository_path": "backend/ai/workflows/img-qwen-image.json" },
    "provenance": { "workflows": ["img-qwen-image"] }
  }]
}
```

Installer capabilities (planning layer implemented, execution later):

- list the profile's available workflows;
- download selected baselines into a user-visible location
  (`user/default/workflows/animastor/<type>/` — the ComfyUI gallery);
- **never modify a workflow after download**;
- let the user choose which workflows to download (`All / Select / None`).

> **A baseline workflow is an editable starting point for the user and may be
> customized locally.** It is NOT immutable configuration.

Note: in production the workflow JSON still travels with each task via GPU Hub
(`task.params`); installed copies serve the user's local ComfyUI
(open/edit/debug) and offline use. Nothing about workflow delivery changes.

---

## 5. Local Customization

A user workflow that differs from the canonical Animastor workflow is **not
an error**. The user may open it in ComfyUI, replace nodes, change
connections, swap models, add their own nodes, tweak parameters, save their
own version.

Resolver semantics (`checkWorkflow`):

| State on disk | Entry verdict |
|---|---|
| baseline file absent | `missing` → offer download (writes a NEW file only) |
| present, hash == `baseline_sha256` | `installed` / grade `canonical-baseline` |
| present, hash differs | `installed` / grade `customized` — ALLOWED, never overwritten |
| present, no hash evidence | `installed` / grade `presence` |
| any other workflow file | extra `unused`/`unknown`, action `none` — never touched |

Restoring the official baseline never conflicts with the user's copy:

```
user/default/workflows/animastor/image/img-qwen-image.json                  ← user's customized copy (untouched)
user/default/workflows/animastor/image/img-qwen-image.animastor-baseline.json ← fresh official copy (on explicit request only)
```

---

## 6. Profile as Baseline, Not Prison

A Generation Profile defines:

- production workflows;
- required dependencies;
- baseline models;
- required custom nodes;
- runtime compatibility;
- worker requirements.

But a user's local profile may differ. The installer is NOT designed as if
`profile == exact immutable workflow`.

**Future extension point (not implemented in this phase):** a custom/local
profile = an existing profile's baseline requirements + different
workflows/dependencies. The manifest schema (separate `workflows` section,
per-entry `requirement`, evidence `basis`) already allows this without
schema surgery.

---

## 7. Dependency Resolver (Phase 1.5 additions)

Statuses: `required | installed | missing | incompatible | unused | unknown`.

Entry kinds now distinguished:

| Kind | Source |
|---|---|
| `runtime` | comfyui / python / torch / nodejs |
| `custom_node` | manifest dependencies |
| `model`, `model_repo` | manifest dependencies |
| `workflow` | manifest `workflows.artifacts` (Phase 1.5) |
| `worker` | manifest `worker_bundle` (Phase 1.5) |

Actions: `install | skip | review | none | configure` (`configure` =
interactive worker/.env setup; still non-destructive).

Multi-profile resolution computes the union (Phase 1) and now also resolves
workflows + worker per profile; shared mode produces one worker entry per
`worker_type`.

---

## 8. Model Installation

For every model the canonical manifest records: source, filename, target
directory, expected revision/version, optional checksum. Sources of truth:
production workflows + confirmed dependency research. **New model URLs are
never invented** — an unresearched source yields `ready: false` with explicit
blockers (D5).

Architecturally supported sources:

- **Hugging Face** — `resolve/<rev>/<file>` URL, HTTP-Range resume, optional
  `HF_TOKEN` for gated repos (hidden input, never logged);
- **ModelScope** — snapshot download; repos delivered by node auto-download
  (Qwen3-TTS) surface the open D2 decision instead of hiding it.

Resumable/idempotent contract for the future engine:

```
download → <target>.part → rename on completion
resume   → HTTP Range where supported
skip     → final file already verifies (checksum > size)
mismatch → FAIL the step; never continue with a possibly corrupt model
```

`download-planner.js` produces these specs purely (no network), so tests run
without downloading tens of GiB.

---

## 9. Custom Node Installation

Each required custom node declares: canonical repository/source, target
directory (`custom_nodes/<dir>`), revision policy (pinned commit where
known), Python dependencies, verification method.

- already installed → `✓ installed`
- installed but incompatible → `! incompatible` (review; a git-safe checkout
  is SUGGESTED via `checkout_custom_node`, never applied automatically)

Options are offered; destructive replacement never happens without consent.

---

## 10. Worker Setup

After ComfyUI/runtime preparation:

1. install the existing Animastor Worker bundle (no runtime-contract changes);
2. create/update `.env` — **merge semantics**, never overwrite an existing
   valid token, `chmod 600`;
3. prompt for the Worker Key interactively (hidden input);
4. **never print the Worker Key in logs**;
5. **never pass the secret via command-line arguments**;
6. registration/health verification against GPU Hub.

The resolver/plan model accepts key NAMES and boolean flags only — there is
no field that could hold a secret value (`env.set_keys`, `worker_key_provided`).
`worker_bundle.env.secrets` drives which missing keys trigger the secure
prompt.

---

## 11. Verification

Post-install checks (static from the resolver + optional live):

- **Machine** — GPU, VRAM, CUDA, Python, Torch;
- **ComfyUI** — running, API reachable, version, required custom nodes;
- **Models** — required models present, paths correct;
- **Workflow** — baseline present, accepted by ComfyUI, missing node classes
  diagnosed clearly;
- **Worker** — `.env`, Worker Key, GPU Hub connection, registration, health.

Result:

```
INSTALLATION COMPLETE

✓ GPU
✓ ComfyUI
✓ Runtime
✓ Custom Nodes
✓ Models
✓ Workflows
✓ Worker
✓ GPU Hub registration
```

or precise `✗ FAIL` / `! WARN` lines. A check that was not performed is
`! WARN — not checked`, never a silent pass. A user-customized workflow is
reported as allowed, not failed.

---

## 12. Safety Rules

The installer NEVER automatically:

- deletes user models / custom nodes / workflows;
- downgrades ComfyUI or Torch;
- changes CUDA / the NVIDIA driver;
- replaces a user workflow;
- destroys an existing Python environment;
- overwrites an existing valid Worker Key.

Formalized in `safety-rules.js`:

- `NEVER_AUTOMATIC` — the operation list; a subset is **forbidden outright**
  in v1 (deletions, torch downgrade, CUDA changes, workflow replacement,
  env destruction, token overwrite);
- consent-gated operations (`update_comfyui`, `downgrade_comfyui`,
  `checkout_custom_node`) pass `confirmationGate` only with an explicit
  matching confirmation;
- `assertSafeReport` — hard invariant: a resolver report never contains
  destructive actions or embedded secret values (enforced in tests);
- `redactSecrets` — defense-in-depth masking for any text that may reach logs.

---

## 13. E2E Test Target

The next phase tests the installer on a clean E2E Networks GPU instance.

- No E2E-specific hacks in the installer: provider details live only in
  `environment_reference` (disclaimed, non-canonical).
- E2E runtime audits remain **reference known-working environments** —
  verification material, never universal requirements.
- The plan/verification modules are pure and probe-driven, so the same code
  runs against any probe (E2E, RunPod, local).

---

## 14. Phase Constraints (what this phase did NOT do)

- no backend rewrite; no GPU Hub changes; no worker protocol changes;
- no production workflow changes; no connector changes;
- no full custom-profile system (extension point documented only);
- no multi-ComfyUI orchestration (isolated mode = data model + interface);
- no automatic updates of a user's ComfyUI;
- no real downloads, no file writes — all modules are pure planning logic.

**Main result:** architecture + manifest/resolver on which a real interactive
installer can be safely implemented.

---

## 15. File Layout

```
backend/ai/install-manifests/
  audio/qwen-tts.json          ← + workflows section (2 baselines, sha256)
  image/qwen-image.json        ← + workflows section (1 baseline, sha256)
  video/ltx-2.3.json           ← + workflows section (4 baselines, sha256)

backend/src/installer/
  index.js                     ← module entry point
  install-manifest.js          ← loader/validator (+ workflows validation)
  compatibility-resolver.js    ← + workflow/worker entries, configure action
  workflow-artifacts.js        ← baseline registry, fresh-copy planning
  download-planner.js          ← HF/ModelScope resumable download specs
  install-plan.js              ← 12-step interactive flow + plan rendering
  safety-rules.js              ← never-automatic ops, gates, redaction
  verification-report.js       ← INSTALLATION COMPLETE / FAIL / WARN

backend/tests/
  install-manifest.test.js     ← manifest validation (+ workflow artifacts)
  installer-resolver.test.js   ← Phase 1 resolver scenarios
  installer-phase15.test.js    ← Phase 1.5: the 15 required scenarios
```

## 16. Open Items Carried Forward

| ID | Item |
|---|---|
| D1 | canonical ComfyUI/torch pins for audio/image (golden run) |
| D2 | TTS ModelScope repos: installer preinstall vs node auto_download |
| D3 | /object_info verification of unknown video class_types |
| D4 | upstream repos/commits for plain-dir video nodes |
| D5 | download research for 11 model files (repo/revision/sha256/gated) |
| D6 | upscaler + easy-use/rgthree contradiction |
| D7 | ComfyUI-Manager inclusion |
| new | minimum VRAM measurement (blocks a fully green verification report) |
| new | kjnodes AudioVAE patch → declarative manifest artifact |
