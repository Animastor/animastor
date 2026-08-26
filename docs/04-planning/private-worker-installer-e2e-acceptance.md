# E2E Acceptance — Private Worker Installer (Phase 2)

## Overview

This document defines the manual acceptance procedure for the Phase 2
executable installation engine on a real clean GPU instance.

**Status:** Not yet accepted — all items below must be verified on real hardware.

## Prerequisites

- Clean GPU instance (Ubuntu 22.04, NVIDIA driver installed)
- Node.js v22+
- Network access to GitHub, Hugging Face, ComfyUI repos
- Animastor Hub running with valid worker registration endpoint
- `ANIMASTOR_WORKER_TOKEN` set in environment

## Acceptance Checklist

### A. Clean Managed Install (no existing ComfyUI)

| # | Step | Expected |
|---|------|----------|
| A1 | Run `node backend/src/installer/cli.js detect --root /tmp/comfy` | Detects GPU, no ComfyUI, no runtime |
| A2 | Run `node backend/src/installer/cli.js plan --root /tmp/comfy --profile video/ltx-2.3` | Generates plan with comfyui-install, custom-nodes, models, workflows, worker-setup steps |
| A3 | Run `node backend/src/installer/cli.js plan --root /tmp/comfy --profile video/ltx-2.3 --dry-run` | Same plan text, zero mutations on disk |
| A4 | Run `node backend/src/installer/cli.js install --root /tmp/comfy --profile video/ltx-2.3 --yes` | ComfyUI installed, models downloaded, worker bundle deployed, .env created |

### B. Existing Compatible ComfyUI

| # | Step | Expected |
|---|------|----------|
| B1 | With compatible ComfyUI (v0.27.0) present, run `detect` | Shows ComfyUI installed at v0.27.0 |
| B2 | Run `plan` | ComfyUI step is noop; models/workflows may still be missing |
| C3 | Run `install --yes` | Only missing components installed; ComfyUI untouched |

### C. Model Downloads

| # | Step | Expected |
|---|------|----------|
| C1 | Download a model with known SHA-256 | Checksum verified, file at correct path |
| C2 | Re-run install (idempotent) | Model skipped (already verified) |
| C3 | Interrupt download, re-run | Resume from `.part` file |
| C4 | Download with wrong checksum | Fails with clear error, `.part` removed |

### D. Worker Registration

| # | Step | Expected |
|---|------|----------|
| D1 | Worker bundle deployed to `workerDir` | `worker.cjs` + `.env` present |
| D2 | `.env` contains required keys | `HUB_URL`, `ANIMASTOR_WORKER_TOKEN`, `WORKER_TYPE`, `WORKER_ID` |
| D3 | Registration verified against Hub | `POST /api/v1/worker/verify` returns `verified: true` |

### E. Resume

| # | Step | Expected |
|---|------|----------|
| E1 | Interrupt install mid-download | State file records partial progress |
| E2 | Re-run install | Resumes from last completed step |

### F. Safety

| # | Step | Expected |
|---|------|----------|
| F1 | Existing user workflow present | Never overwritten; baseline installed to distinct path |
| F2 | Secret values (tokens) | Never appear in logs, state files, or plan text |
| F3 | `--dry-run` | Zero filesystem mutations, no network downloads |

## Blocked Items (Known)

| ID | Description | Impact |
|----|-------------|--------|
| D1 | Model source URLs unknown in some manifests | Downloads BLOCKED until manifest researched |
| D2 | Hugging Face gated repos need HF_TOKEN | Token must be provided interactively |
| D5 | Some model sources not yet verified | Installer refuses to guess URLs |

## How to Accept

1. Run through all items in sections A–F on a real clean GPU instance
2. Check off each item
3. Sign and date this document
4. Commit with message: `accept: Phase 2 installer engine — E2E verified`
