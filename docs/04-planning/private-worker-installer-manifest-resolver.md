# Private Worker Installer — Phase 1: Manifest & Runtime Compatibility Architecture

> **Status:** implemented (Phase 1 — foundation only; no installer, no downloads).
> **Superseded in part by Phase 1.5** — workflows as first-class artifacts,
> worker entries, interactive plan, safety rules: see
> `docs/04-planning/private-worker-installer-phase15.md`.
> **Date:** 2026-08-26
> **Companion docs:**
> - `docs/04-planning/private-worker-installer-architecture.md` — overall architecture draft
> - `docs/04-planning/private-worker-installer-dependency-research.md` — factual dependency research

---

## 1. What Phase 1 Delivers

Phase 1 establishes the **reliable dependency model and compatibility architecture**
on which a real GPU Worker Installer can be safely built later. It contains:

- **Canonical install manifests** for the three production profiles
  (`audio/qwen-tts`, `image/qwen-image`, `video/ltx-2.3`);
- **Manifest loader/validator** that loads, validates, and exposes manifests;
- **Compatibility resolver** that accepts manifests + environment probe data
  and produces a structured, non-destructive resolution report;
- **47 unit tests** covering 12+ scenarios, manifest validation, and guard
  rails (extended by Phase 1.5 to 78 tests incl. the 15 required installer
  scenarios — see the Phase 1.5 doc).
- Updated architecture documentation (this document + cross-references).

**Phase 1 does NOT:**
- Write a full installer (no file writes, no downloads);
- Change any production workflow, connector, GPU Hub, or worker runtime;
- Change profile schemas;
- Ingest real GPU/CUDA downloads;
- Perform any destructive operation on any environment.

---

## 2. Pipeline

The dependency pipeline from profile to installed machine is:

```
Profile
   ↓  references
Production Workflows   ← single source of truth for "required"
   ↓  scan class_type / file refs
Dependency Resolver    ← compares against manifest + environment
   ↓  produces
Canonical Install Manifest  ← versioned, human-reviewed document
   ↓  executed by (future)
Installer             ← Phase 2 (not yet implemented)
   ↓  starts
Worker
```

**Key invariant:** Production workflows are the **only source** of `required`.
Runtime audits are reference/verification material only — never the source
of truth for manifests.

---

## 3. Evidence Taxonomy

Each manifest entry carries a `basis` field classifying the evidence level:

| `basis` | Meaning | Example |
|---|---|---|
| `required` | Required by production workflows (workflow-derived) | `ComfyUI-GGUF` is used by `img-qwen-image` |
| `known_working` | Required AND verified present on a working instance | Video ComfyUI v0.27.0 + torch 2.6.0+cu124 |
| `minimum_supported` | Minimal admissible config, justified from code/docs | Python ≥3.10, Node.js ≥20 |
| `optional` | Not required; utility / for growth | ComfyUI-Manager |
| `environment_reference` | Provider/image-specific; never a universal requirement | E2E driver version 550.127.08 |
| `unknown` | Insufficient data; explicit TODO required | Audio/image ComfyUI pin (D1 decision pending) |

**Separation rules:**
- `basis: required` without `known_working` means the item is required by
  workflows but its version/source has not been independently verified.
- `basis: known_working` requires a specific audit/instance reference.
- `basis: environment_reference` is **never** treated as a universal
  requirement — it describes what was found on a particular provider's image.
- Unknowns carry explicit `todo` strings; the manifest validator emits
  warnings for unknowns — these are honesty gaps, not errors.

---

## 4. Three Levels of Environment Knowledge

The architecture distinguishes three fundamentally different claims about
a dependency:

| Concept | Source | Reliability | Use |
|---|---|---|---|
| **Canonical requirement** | manifest runtime_requirements / dependencies | Evidence-backed, human-reviewed | Installer must install it |
| **Known-working environment** | audit / reference instance | Proven on a specific instance | Verification target; not universal |
| **Local existing environment** | live probe of the user's machine | May differ from all references | Compared to manifest; never auto-replaced |

The resolver never conflates these. In `existing` mode it compares the
local environment against the manifest, reports matches/mismatches, and
**never automatically replaces** the user's environment.

---

## 5. Runtime Modes

| Mode | Who owns the environment | Installer behavior | Status |
|---|---|---|---|
| **Managed** | Installer (V1 target) | Full install: ComfyUI → nodes → models → worker → .env → verify | Phase 1 data model + resolver; Phase 2 implementation |
| **Existing** | User (pre-existing ComfyUI) | detect → compare → report → optionally install missing; never destructive | Phase 1 resolver ready |
| **Isolated** | One GPU machine, N independent ComfyUI + venv dirs | Each worker gets its own isolated environment | Phase 1 data model + interface; implementation later |
| **Shared** | One ComfyUI serves multiple profiles | Resolver computes union of runtime requirements; detects conflicts | Phase 1 manifest-level resolution ready; full implementation later |

**Shared conflict semantics:**
- `shared-compatible`: union of runtime requirements is satisfiable by a
  single ComfyUI install.
- `shared-conflict`: runtime (torch/CUDA) pins differ across profiles →
  "profiles cannot safely share one ComfyUI runtime."
- `requires-isolation`: ComfyUI version pins differ → separate ComfyUI
  environments needed (isolated mode).

---

## 6. Manifest Schema (v1.0.0)

Location: `backend/ai/install-manifests/{type}/{profile}.json`

```
manifest_version   "1.0.0"
revision           monotonic revision string
status             "draft" | "stable" (stable = all checksums/research confirmed)
profile            { id, type, name }
provenance         { workflows[], connectors_backend_only[], sources[] }
hardware           { gpu_min_vram_gb, reference_gpu, basis, todo }
runtime_requirements
  ├─ comfyui       { policy, pin, min/max_version, basis, known_working_reference, todo }
  ├─ python        { policy, minimum, basis, known_working_reference }
  ├─ torch         { policy, pin, index_url, cuda_tier, basis, known_working_reference, todo }
  ├─ nodejs        { policy, minimum, basis, notes }
  └─ nvidia_driver { policy, reference, basis, notes }
dependencies[]
  ├─ id, kind, name, requirement, basis
  ├─ install { directory, source { kind, repository, commit, verification } }
  ├─ provenance { workflows[], evidence }
  └─ (kind-specific: filename, target_dir, size, checksum, patches, etc.)
worker_bundle
verification
environment_reference[]
disk_budget
open_questions[]
open_class_attributions (video)
```

Each `source.verification`: `"confirmed"` | `"needs_verification"` | `"unknown"`.

---

## 7. Resolver Entry Statuses

| Status | Meaning | Action |
|---|---|---|
| `required` | Manifest requires it, but environment was not probed for this kind | `review` |
| `installed` | Required and found compatible | `skip` |
| `missing` | Required and absent | `install` (for required) / `review` (for unknown requirement) / `none` (optional) |
| `incompatible` | Found, but version/config conflicts | `review` (never auto-replace) |
| `unused` | Present on machine, not required by selected profiles | `none` (never auto-remove) |
| `unknown` | Cannot be matched or verified | `none` / `review` |

**Actions:** `install` | `skip` | `review` | `none`. The resolver
**never** produces `remove`, `delete`, `downgrade`, `replace`, or
`uninstall`. This is a hard invariant enforced in tests.

---

## 8. Current State of Evidence (per profile)

### audio/qwen-tts

| Component | Canonical pin | Known-working reference | Status |
|---|---|---|---|
| ComfyUI | unknown (D1) | fork `rajsingh1-dev/ComfyUI` @ c4cfee7 | needs golden run on v0.27.0 |
| Torch | unknown (D1) | 2.10.0+cu128 | needs decision |
| Custom node: Qwen3-TTS | commit 2ee1131 (confirmed) | — | ready for manifest |
| Models: 2 TTS repos (ModelScope) | revision unknown | present in audit, sizes confirmed | D2: preinstall vs auto_download |

### image/qwen-image

| Component | Canonical pin | Known-working reference | Status |
|---|---|---|---|
| ComfyUI | unknown (D1) | fork `rajsingh1-dev/ComfyUI` @ c4cfee7 | needs golden run on v0.27.0 |
| Torch | unknown (D1) | 2.10.0+cu128 | needs decision |
| Custom node: GGUF | commit 6ea2651 (confirmed) | — | repo URL needs verification |
| Models: 4 files (~21 GB) | source unknown | present, sizes confirmed | D5: download research needed |

### video/ltx-2.3

| Component | Canonical pin | Known-working reference | Status |
|---|---|---|---|
| ComfyUI | **v0.27.0** @ bb131be9 (known_working) | same | ready |
| Torch | **2.6.0+cu124** (known_working) | same | ready |
| Custom nodes: GGUF, kjnodes | commits unknown (plain dirs) | present | D4: upstream repos needed |
| VHS: requirement **unknown** | — | present | D3: /object_info verification needed |
| Models: 7 files (~30 GB) | sources unknown | present, sizes confirmed | D5: download research needed |
| kjnodes AudioVAE patch | documented (SYSTEM.md) | not declarative yet | needs manifest artifact |

---

## 9. Open Decisions Carried Forward

| ID | Decision | Impact | Status |
|---|---|---|---|
| D1 | Unified ComfyUI/torch policy vs per-profile | All three manifests' runtime_requirements.comfyui/torch.pin | audio/image pin=null; video pin=v0.27.0 |
| D2 | TTS model repos: preinstall vs auto_download | Audio manifest delivery mechanism | Open |
| D3 | /object_info verification of unknown class_types | Video manifest custom_nodes list completeness | Open |
| D4 | Upstream repos for plain-dir nodes (GGUF, kjnodes, VHS) | Manifest source fields for video nodes | Open |
| D5 | Download research: 11 model files (repo/sha256/gated) | All image + video model source fields | Open |
| D6 | Upscaler + easy-use/rgthree contradiction | Video manifest optional entries | Open |
| D7 | ComfyUI-Manager inclusion | All manifests (currently optional) | Open |

---

## 10. File Layout

```
backend/ai/install-manifests/
  audio/qwen-tts.json          ← canonical manifest (draft; + workflows section in Phase 1.5)
  image/qwen-image.json        ← canonical manifest (draft; + workflows section in Phase 1.5)
  video/ltx-2.3.json           ← canonical manifest (draft; + workflows section in Phase 1.5)

backend/src/installer/
  index.js                     ← module entry point
  install-manifest.js          ← load/validate manifests (+ workflows validation)
  compatibility-resolver.js    ← resolveInstallation, resolveSharedRuntime, planIsolatedEnvironments
                                 (+ workflow/worker entries, configure action in Phase 1.5)
  workflow-artifacts.js        ← Phase 1.5: baseline workflow registry + fresh-copy planning
  download-planner.js          ← Phase 1.5: resumable HF/ModelScope download specs (pure)
  install-plan.js              ← Phase 1.5: 12-step interactive flow + plan rendering
  safety-rules.js              ← Phase 1.5: never-automatic ops, confirmation gates, redaction
  verification-report.js       ← Phase 1.5: INSTALLATION COMPLETE / FAIL / WARN rendering

backend/tests/
  install-manifest.test.js     ← manifest validation tests (incl. workflow artifacts)
  installer-resolver.test.js   ← resolver scenarios + guard rails
  installer-phase15.test.js    ← Phase 1.5: the 15 required installer scenarios
```

---

## 11. What Phase 2 Must Build (next steps)

1. **Installer skeleton (Phase 0–2 + dry-run):** preflight, ComfyUI
   detection/policy, resolution report via `--dry-run`, reusing audit
   script logic. Only after this — write phases.
2. **Download mechanics:** implement `source.kind` handlers (huggingface,
   github, model-scope); `.part` file resume; checksum verification;
   resume via `install-state.json`.
3. **ComfyUI version policy execution:** implement §10 scenarios A–D from
   the architecture draft (checkout, upgrade, downgrade with user consent).
4. **Worker deployment + .env:** place worker bundle, create `.env` with
   merge semantics, prompt for `ANIMASTOR_WORKER_TOKEN`.
5. **Post-install verification:** resolver diff + optional runtime audit.
6. **Resolve D1–D7** with golden runs on reference instances.
