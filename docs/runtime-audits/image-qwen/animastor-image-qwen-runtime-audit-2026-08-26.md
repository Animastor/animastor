# Animastor Image/Qwen Runtime Audit

**Captured:** 2026-08-26T03:15:24Z  
**Instance:** `n-c0ff8487-cd83-48d6-96ac-c30baac6cfcb-0`

## System

- OS: Ubuntu 22.04.5 LTS
- Kernel: 5.15.0-94-generic x86_64
- CPU: AMD EPYC 9555, 2 sockets, 128 physical cores / 256 threads
- RAM: 1.1 TiB
- Root filesystem: 730G total, 437G used, 256G available

## NVIDIA / CUDA

- GPU: NVIDIA L40S
- VRAM: 46,068 MiB
- Driver: 550.127.08
- CUDA reported by driver: 12.4
- `nvcc`: not on PATH
- GPU memory at audit: 23,675 MiB used / 46,068 MiB total

## Python / Torch

- Python: 3.10.12
- Python path: `/home/jovyan/animastor/python3`
- No active `VIRTUAL_ENV`
- pip: 25.3
- PyTorch: 2.10.0+cu128
- PyTorch CUDA build: 12.8
- cuDNN: 91002
- CUDA available: True
- Device count: 1

## ComfyUI

- Directory: `/home/jovyan/ComfyUI`
- Size: 22G
- `main.py`: present
- Remote: `https://github.com/rajsingh1-dev/ComfyUI.git`
- Commit: `c4cfee7ad16cfeb082e12f43cf4751b4a67a4e11`

## Image / Qwen Models

| Location | Model | Size |
|---|---|---:|
| `models/clip/` | `Qwen2.5-VL-7B-Instruct-Q8_0.gguf` | 7.54 GiB |
| `models/unet/` | `qwen-image-2512-Q4_K_M.gguf` | 12.34 GiB |
| `models/loras/` | `Wuli-Qwen-Image-2512-Turbo-LoRA-4steps-V3.0.safetensors` | 1.10 GiB |
| `models/vae/` | `qwen_image_vae.safetensors` | 242.05 MiB |

SHA-256 recorded for the VAE:
`a70580f0213e`

Hashes for model files larger than 256 MiB were skipped by the audit script.

## Custom Nodes

- `ComfyUI-Florence2` — commit `2752591`
- `ComfyUI-GGUF` — commit `6ea2651`
- `ComfyUI-KJNodes` — commit `faf270a`
- `comfyui-manager` — commit `df1eaff8`
- `ComfyUI-RMBG` — commit `d740251`
- `ComfyUI-segment-anything-2` — commit `0c35fff`
- `qwen3-tts` — commit `2ee1131`
- `__pycache__` — non-git directory

## Workflows

> **⚠ UI test artifacts only — not part of production deployment.**
>
> The files listed below are **local user workflows** saved in the ComfyUI
> browser UI for offline testing and debugging by the instance operator.
> They are **not** required for production operation and are **not** the
> mechanism by which Animastor delivers workflows to the worker.
>
> Production Animastor workflows are **not stored on the GPU worker** as
> required files. They are transmitted at runtime via the Animastor VPS
> (backend) → GPU Hub → worker API pipeline. See
> `docs/runtime-audits/README.md` ("Workflow delivery architecture")
> for the verified delivery chain.
>
> These local files are listed here for completeness and transparency.
> Their presence or absence has **no effect** on production deployment.

Local directory:

`/home/jovyan/ComfyUI/user/default/workflows`

Observed local workflow files (UI test artifacts / operator convenience):

- `Animastor 01.json` — UI test artifact
- `Animastor 03-flor-1.json` — UI test artifact
- `animastor_workflow_clean_ids.json` — UI test artifact
- `Full power.json` — UI test artifact
- `img-qwen-image_2_image.json` — UI test artifact
- `img-qwen-image.json` — UI test artifact

**Production status:** these files are **not** counted as part of
production deployment. Production workflows are supplied by the VPS
over HTTP and are forwarded by `worker.cjs runWorkflow()` to ComfyUI's
`/prompt` endpoint. The worker does **not** read any workflow file from
disk.

## Worker

Directory:

`/home/jovyan/animastor/worker`

Files:

- `worker.cjs` — 27.87 KiB
- `worker-cleanup.cjs` — 2.31 KiB
- `worker-cleanup-journal.cjs` — 8.68 KiB
- `package.json` — 294 B
- `.env.example` — missing

Worker header reports:

`GPU Worker — v2.0.0 (fail-closed authorization, PW-4)`

Relevant configuration:

- `HUB_URL` defaults to `https://animastor.in/gpu`
- `COMFY_PORT` defaults to `8188`
- `WORKER_TYPE` defaults to `image`
- worker credential is required and sent as `Authorization: Bearer <token>`

Worker directory is not itself a Git repository.

## Environment

From `/home/jovyan/animastor/worker/.env`:

- `HUB_URL` — set
- `ANIMASTOR_WORKER_TOKEN` — present, secret redacted
- `WORKER_TYPE` — set
- `WORKER_ID` — set

## Storage

- ComfyUI total: 22G
- ComfyUI models: 22G
- Custom nodes: 206M
- ComfyUI user: 18M
- Local workflows: 92K
- ComfyUI output: 72K
- Worker directory: 9.4M
- `~/animastor`: 23M

## Audit Interpretation

This instance is a working reference configuration for Animastor's **Image/Qwen runtime**.

The important reproducibility anchors are:

1. NVIDIA L40S + driver 550.127.08
2. PyTorch 2.10.0+cu128
3. ComfyUI commit `c4cfee7ad16cfeb082e12f43cf4751b4a67a4e11`
4. The four Qwen/Image model artifacts listed above
5. The custom-node set and commits listed above
6. Worker version `v2.0.0` with fail-closed authorization

**Workflow deployment scope (clarified):**

- The workflow files listed under `user/default/workflows/` are **UI test
  artifacts** placed there by the operator for local testing. They are
  **not** part of the production deployment footprint.
- Production Animastor workflows are delivered at runtime via the VPS
  (backend → GPU Hub → `worker.cjs` → ComfyUI `/prompt`). No workflow
  JSON file is required to be stored on the GPU worker for production
  operation.
- An empty `user/default/workflows/` directory would be the **expected
  state** on a clean production install. The files observed here are
  operator-convenience copies and should not be treated as deployment
  requirements.

This document is a **read-only runtime snapshot** captured from the live Image/Qwen worker on 2026-08-26.
