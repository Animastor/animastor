# Phase 3.4 — Close E2E Blockers: Code Changes Report

**Date:** 2026-08-27
**Commit baseline:** 8db06339 (Phase 3.3 report)

---

## Blocker 1: Audio — ModelScope `installer_preload` Implementation

**Status: RESOLVED (code)**

### Problem
The audio manifest specified `delivery.mechanism: "installer_preload"` for ModelScope repos, but the engine had no implementation — it fell through to `downloadArtifact()` which used a page URL, not a download URL.

### Changes

**`backend/src/installer/engine/downloader.js`** — Added ModelScope snapshot download:
- `listModelScopeFiles(io, repository, revision, token)` — Lists files via ModelScope REST API (`/api/v1/models/{repo}/repo?Revision={rev}`)
- `downloadModelScopeRepo(io, spec, opts)` — Downloads all files from a ModelScope repo with retry/resume/verify
- `modelscopeFileUrl(repository, filePath, revision)` — Builds per-file download URL
- `MODELSCOPE_API_BASE` — Constant for the API base URL

### Behavior
- Lists files via ModelScope REST API
- Downloads each file individually with the same retry/resume/verify logic as HF downloads
- **Idempotent**: verified files are skipped
- **Size check**: files within 5% tolerance pass
- **Checksum mismatch**: file deleted and re-downloaded
- **Subdirectory creation**: nested paths (e.g. `speech_tokenizer/`) are created automatically
- **`expected_files` filter**: only downloads files listed in the manifest

**`backend/src/installer/engine/engine.js`** — Updated section 4.4 (Models):
- When `delivery.mechanism === 'installer_preload'` and `source.kind === 'modelscope'`, calls `downloadModelScopeRepo()` instead of `downloadArtifact()`
- Passes `expected_files` from the manifest dependency

**`backend/src/installer/download-planner.js`** — Added `repository` and `revision` to ModelScope planner specs for the engine to construct API URLs.

### Tests
**`backend/tests/installer-modelscope.test.js`** — 18 tests covering:
- MS1: `listModelScopeFiles` (API listing, directory filtering, 401 error, flat array format)
- MS2: `downloadModelScopeRepo` (multi-file download with correct sizes)
- MS3: Idempotency (size-verified files skipped)
- MS4: Size mismatch triggers re-download
- MS5: `expected_files` filter
- MS6: Subdirectory creation
- MS7: API error handling
- MS8: Empty repo failure
- MS9: URL construction
- MS10: `modelscopeStrategy` mechanism routing

---

## Blocker 2: Video — Spatial Upscaler Research

**Status: RESOLVED (research)**

### Problem
`ltx-2.3-spatial-upscaler-x2` had no download URL or SHA-256 in the manifest.

### Research Findings
- **File exists** at `Lightricks/LTX-2.3` on HuggingFace and ModelScope
- **Two versions available**: `-1.0` and `-1.1` (newer)
- **Download URLs verified**:
  - HF v1.0: `https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-spatial-upscaler-x2-1.0.safetensors`
  - HF v1.1: `https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-spatial-upscaler-x2-1.1.safetensors`
  - ModelScope: `https://modelscope.cn/models/Lightricks/LTX-2.3/resolve/master/ltx-2.3-spatial-upscaler-x2-1.0.safetensors`
- **NOT referenced by any production workflow** (no latent-upscale nodes)
- Manifest correctly marks it `requirement: "optional"` with `todo: "D6"`

### Recommendation
The upscaler is **available but optional**. No manifest change needed — it's correctly marked as optional/D6. The `-1.1` version exists but since no production workflow uses it, the manifest should stay as-is until a workflow actually needs it.

---

## Blocker 3: ComfyUI Canonical Runtime — `sys_module_name` Bug

**Status: RESEARCHED (upstream bug, not ours)**

### Problem
Reference fork `c4cfee7` (rajsingh1-dev/ComfyUI) throws `UnboundLocalError: local variable 'sys_module_name' referenced before assignment` in the custom node loader.

### Research Findings
- This is a **known upstream ComfyUI bug** (issues #8491, #10340, #1644)
- Bug is in `nodes.py` `load_custom_node()` function — `sys_module_name` referenced before assignment
- **Triggered by `comfy_api_nodes/canary.py`** import failure — not by our custom nodes
- The bug exists in the **fork** (`c4cfee7`) which is an older ComfyUI version
- **ComfyUI v0.27.0** (used by video profile) likely has the fix — the video profile already works
- The audio and image profiles reference the fork as `known_working_reference` (not canonical pin)

### Impact
- **Video profile**: unaffected — uses official ComfyUI v0.27.0
- **Audio/Image profiles**: use fork c4cfee7 — this bug will occur on clean managed installs
- The bug is in the **fork's node loader**, not in our custom nodes
- Custom nodes themselves load fine when the loader bug is bypassed

### Recommendation
- **Video profile**: already has canonical pin `v0.27.0` — no change needed
- **Audio/Image profiles**: need to decide between:
  - **(A)** Test if official ComfyUI v0.27.0 works for these profiles (golden run)
  - **(B)** Patch the fork's `nodes.py` to fix the `sys_module_name` issue
  - **(C)** Accept the fork as-is with the caveat that custom node loading may fail on first boot

This is a **D1 decision** that requires a GPU golden run to validate.

---

## Test Results

| Metric | Before | After |
|--------|--------|-------|
| Total tests | 1749 | 1774 |
| ModelScope tests | 0 | 18 (all passing) |
| Status | — | All passing |

---

## Remaining Blockers (require GPU / infrastructure)

1. **GPU E2E test** — requires clean Linux GPU instance
2. **ComfyUI canonical pin for audio/image** — requires golden run on GPU
3. **ComfyUI v0.27.0 compatibility with audio/image profiles** — requires testing
4. **Worker Online verification** — requires real backend + GPU worker
5. **Generation smoke tests** — requires GPU + all models downloaded

---

## Files Changed

| File | Change |
|------|--------|
| `backend/src/installer/engine/downloader.js` | Added ModelScope snapshot download functions |
| `backend/src/installer/engine/engine.js` | Route `installer_preload` to ModelScope download |
| `backend/src/installer/download-planner.js` | Added `repository`/`revision` to ModelScope specs |
| `backend/tests/installer-modelscope.test.js` | New: 18 ModelScope download tests |
| `docs/runtime-audits/phase-3.4-e2e-blockers-2026-08-27.md` | This report |
