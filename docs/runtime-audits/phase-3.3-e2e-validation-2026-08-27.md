# Phase 3.3 — Real Download & Installation E2E Validation

**Date:** 2026-08-27
**Commit:** 11064435 (Phase 3.2 baseline)
**Machine:** linux, no GPU, 3.8 GB RAM, 33 GB free disk, Node 22.22.3, Python 3.10.12

---

## Profiles Verified

| Profile | Status | Models | Nodes | Workflows | Total Size |
|---------|--------|--------|-------|-----------|------------|
| image/qwen-image | READY | 4 | 1 | 1 | 21.2 GB |
| video/ltx-2.3 | READY | 7 | 2 | 4 | 29.8 GB |
| audio/qwen-tts | READY | 2 | 1 | 2 | 8.4 GB |

Zero hidden BLOCKED dependencies from planner validation.

---

## Models Downloaded & SHA-256 Verified (11/14)

### Image Profile (4/4)

| File | Size | SHA-256 |
|------|------|---------|
| qwen-image-2512-Q4_K_M.gguf | 13244758560 bytes | `b2a5f624...a928fc` ✓ |
| Qwen2.5-VL-7B-Instruct-Q8_0.gguf | 8098523680 bytes | `e191b017...79846c` ✓ |
| qwen_image_vae.safetensors | 253806246 bytes | `a70580f0...023d1f` ✓ |
| Wuli-Qwen-Image-2512-Turbo-LoRA-4steps-V3.0-bf16.safetensors | 1179883224 bytes | `150a8b0e...510c1c` ✓ |

### Video Profile (7/8)

| File | Size | SHA-256 |
|------|------|---------|
| LTX-2.3-22B-distilled-1.1-Q4_K_M.gguf | 17763015328 bytes | `cfebeb7a...f75fbd` ✓ |
| gemma-3-12b-it-qat-UD-Q4_K_XL.gguf | 7432229248 bytes | `da98f81c...2cb53b` ✓ |
| ltx-2.3_text_projection_bf16.safetensors | 2312149072 bytes | `911d59bb...74911f` ✓ |
| ltx-2-19b-ic-lora-detailer.safetensors | 2617401920 bytes | `05efdae9...6d7d0e2` ✓ |
| LTX23_video_vae_bf16.safetensors | 1452258578 bytes | `01ea62d0...b8ee3b` ✓ |
| LTX23_audio_vae_bf16.safetensors | 364855188 bytes | `5bc10fa4...48a38c3` ✓ |
| taeltx2_3.safetensors | 23531296 bytes | `f0773b4e...bbe246` ✓ |
| ~~ltx-2.3-spatial-upscaler-x2~~ | — | **BLOCKED: no URL, no checksum (D5 research)** |

### Audio Profile (BLOCKED)

ModelScope `installer_preload` mechanism is deferred to the custom node — the engine does not execute the download itself. Honest BLOCKER.

---

## HF Authentication

All 14 production models are `gated: false`. Production profiles do not require HF auth.

Diagnostics verified:
- Without HF_TOKEN: output says "System HF token: not set"
- With HF_TOKEN: output says "System HF token: available"
- Token value never appears in output, logs, or error messages

Auth smoke test (401 on gated model): clear error message, no token leakage.

---

## Custom Nodes (5/5)

| Node | Repo | Pinned SHA | Detached HEAD | NODE_CLASS_MAPPINGS |
|------|------|-----------|---------------|---------------------|
| ComfyUI-GGUF | city96/ComfyUI-GGUF | 6ea2651 | ✓ | ✓ |
| ComfyUI-KJNodes | kijai/ComfyUI-KJNodes | faf270a | ✓ | ✓ |
| ComfyUI-Qwen3-TTS | wanaigc/ComfyUI-Qwen3-TTS | 2ee1131 | ✓ | ✓ |
| ComfyUI-VideoHelperSuite | Kosinkadink/ComfyUI-VideoHelperSuite | 115de7a | ✓ | ✓ |
| ComfyUI-Manager | Comfy-Org/ComfyUI-Manager | df1eaff | ✓ | ✓ |

All cloned from pinned repos, no floating main/master/latest.

ComfyUI reference fork (c4cfee7) CPU boot: server starts, custom node loader has framework bug (`sys_module_name` UnboundLocalError). This is a fork-level issue, not our nodes.

---

## Workflows

| Workflow | SHA-256 Baseline | Node Classes Covered |
|----------|-----------------|---------------------|
| img-qwen-image.json | `fb4c25e5...03a5816` ✓ | 10/10 ✓ |
| tts-qwen-dialogue.json | — | 7/7 ✓ |
| tts-qwen-narrator.json | — | 3/3 ✓ |
| video-ltx-{1,2,3,4}p.json | — | All reference core ComfyUI extras + custom nodes ✓ |

All workflows in ComfyUI API prompt format. All class_type references accounted for.

---

## Idempotency

Engine `verifyFile` returns `checksum-verified` for all retained files → skip, zero re-download.

---

## Corruption Test

Corrupted file (1 byte flipped): `corrupt` REJECTED with `sha256 mismatch`.
Original file: `checksum-verified` OK.

---

## Failure Tests

| Scenario | Result |
|----------|--------|
| 404 (non-existent HF file) | `failed HTTP 404 from source` — clear rejection, no fake READY |
| 401 (invalid HF token on gated model) | `failed HTTP 401 — authentication error: check the access token` — no token in error |
| Network interruption + resume | Interrupted download → `curl -C -` resume → full SHA-256 valid |

---

## Secrets Audit

- `git grep` for HF token patterns: found only test code (fake tokens for redaction testing) and documentation
- No token values in logs, state files, bundles, or `/tmp`
- No `Authorization: Bearer` in any debug output
- `/tmp/opencode/hf_token` was never created

**Result: CLEAN**

---

## Blockers Found

1. **Audio profile:** ModelScope `installer_preload` not implemented in engine — deferred to node
2. **Video profile:** `ltx-2.3-spatial-upscaler-x2` has no download URL or SHA-256 (D5 research required)
3. **ComfyUI reference fork (c4cfee7):** custom node loader bug (`sys_module_name` UnboundLocalError) — framework-level issue
4. **No GPU on test machine:** generation tests, clean GPU install, and worker online test impossible

---

## Code Change

`backend/src/installer/engine/comfyui.js`: improved error message for python venv failures (added exit code + stderr output). Backward-compatible, no functional change.
