# Experimental Beta — Private Worker Setup

Practical guide for connecting your own GPU as a **Private Worker** to Animastor.
A private worker processes only **your workspace's** jobs.

> Scope: Experimental Beta. This document covers the existing private
> (workspace-owned) worker only. There is no Share Worker / GPU marketplace.

---

## 1. Prerequisites

| Requirement | Details |
|---|---|
| **Node.js 20+** | `worker.cjs` uses the global `fetch` API. No npm dependencies are required — the file is self-contained (Node builtins only). |
| **ComfyUI running locally** | The worker talks to the ComfyUI HTTP API at `http://127.0.0.1:8188` by default. Override the port with `COMFY_PORT`. The worker does **not** install or start ComfyUI. |
| **Models matching the platform workflows** | See [Model requirements](#model-requirements) below. |
| **Network access to the GPU Hub** | The worker must reach `HUB_URL` (your Animastor origin + `/gpu`). |
| **GPU** | A CUDA GPU capable of running the models below. We do not publish a hard minimum; the verified reference setup (NVIDIA L40S 46 GB, ComfyUI v0.27.0, PyTorch 2.6.0+cu124) is documented in `worker/new/SYSTEM.md`. |

### Model requirements

The exact model files are referenced by the shipped workflows in
`backend/ai/workflows/*.json`. As of this writing they reference:

- **Video (LTX 2.3):** `LTX-2.3-distilled-Q4_K_M.gguf` (UNet),
  `ltx-2-19b-ic-lora-detailer.safetensors` (LoRA),
  `ltx-2.3-spatial-upscaler-x2-1.0.safetensors` (upscaler)
- **Image (Qwen-Image):** `qwen-image-2512-Q4_K_M.gguf` (UNet),
  `Wuli-Qwen-Image-2512-Turbo-LoRA-4steps-V3.0.safetensors` (LoRA)
- **Audio (Qwen3-TTS):** `Qwen/Qwen3-TTS-12Hz-1.7B-Base` and
  `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` (downloaded by the Qwen3-TTS custom nodes)

Place these in the corresponding ComfyUI `models/` directories. If a workflow
references a file you do not have, that layer will fail at generation time —
check the workflow JSON for the authoritative, current list.

Video generation additionally requires custom nodes (kjnodes — patched for the
AudioVAE signature, comfyui-videohelpersuite, comfyui-easy-use, rgthree-comfy);
audio requires the Qwen3-TTS custom nodes. The verified node set and patches are
listed in `worker/new/SYSTEM.md`.

---

## 2. Obtain the worker

The worker is a **single self-contained file**: `worker.cjs`. The GPU Hub serves
it directly (the repository mirror is private):

```bash
curl -o worker.cjs https://<your-animastor-host>/gpu/worker-source
```

The same file ships in the project repository at `worker/worker/worker.cjs`
(operators with repo access can copy it from there).

The Settings UI (Settings → Private Workers → create worker) shows the exact
download command for your deployment.

---

## 3. Create the worker in the UI

1. Open **Settings → Private Workers**.
2. Press **Add Worker**, choose a name and the worker type
   (`image` / `audio` / `video`).
3. The credential (`wrk.<worker_id>.<secret>`) is shown **exactly once**.
   Copy it now — after closing the dialog it cannot be recovered, only rotated.

The dialog also shows a copyable configuration block:

```
HUB_URL=https://<your-animastor-host>/gpu
ANIMASTOR_WORKER_TOKEN=wrk.<worker_id>.<secret>
WORKER_TYPE=image
WORKER_ID=<worker-label>
```

These are the exact variable names `worker.cjs` reads.

---

## 4. Configure the worker

Export the variables, or put them in a `.env` file next to `worker.cjs`
(template: `worker/worker/.env.example`). `start-worker.sh` loads `./.env`
automatically.

| Variable | Required | Notes |
|---|---|---|
| `HUB_URL` | yes | Your Animastor origin + `/gpu`. |
| `ANIMASTOR_WORKER_TOKEN` | yes (private mode) | The one-time credential from the UI. **Without it the worker runs in the legacy system-pool mode.** Never put it in a URL. |
| `WORKER_TYPE` | yes | `image`, `audio` or `video` — must match the type chosen in the UI. |
| `WORKER_ID` | no | A label. With a token, identity is derived from the token. |
| `COMFY_PORT` | no | Default `8188`. |
| `COMFY_INPUT_DIR` | no | ComfyUI `input/` dir. Default assumes the Jovyan notebook layout (`/home/jovyan/ComfyUI/input`) — **override it** for a normal install, e.g. `$HOME/ComfyUI/input`. |
| `NOTEBOOK_PATH` | no | Reverse-proxy base path in front of ComfyUI (notebook deployments). |

---

## 5. Start the worker

```bash
node worker.cjs
```

with the variables exported, e.g.:

```bash
HUB_URL=https://<host>/gpu \
ANIMASTOR_WORKER_TOKEN=wrk.<id>.<secret> \
WORKER_TYPE=image \
WORKER_ID=my-worker \
COMFY_INPUT_DIR=$HOME/ComfyUI/input \
node worker.cjs
```

Alternatively use `worker/start-worker.sh [image|audio|video]` (GPU-box helper:
checks GPU/Node, detects the ComfyUI port, loads `./.env`, restarts the worker).
If `ANIMASTOR_WORKER_TOKEN` is missing it warns and falls back to system-pool mode.

---

## 6. Verify ONLINE

- The worker beacons to the hub every 10 s; the hub keeps a heartbeat with a
  30 s TTL.
- In **Settings → Private Workers** the status pill flips from **OFFLINE** to
  **ONLINE** within ~30 s of the first successful beacon.
- `last seen` updates continuously while the worker runs.

Status is a derived liveness hint only — authorization is always decided by the
credential, never by the status pill.

---

## 7. Troubleshooting (worker stays OFFLINE)

1. **HUB_URL** — must be your Animastor origin + `/gpu`; test with
   `curl <HUB_URL>/health`.
2. **Token** — `ANIMASTOR_WORKER_TOKEN` must be the latest credential; rotating
   in the UI invalidates the previous one immediately. A rejected credential
   returns `401 invalid_worker_credential` in the worker log.
3. **Process** — `node worker.cjs` must be running; check its log output.
4. **Network** — the worker machine must reach the hub (firewall/proxy).
5. **ComfyUI** — must be up before tasks arrive; the worker logs a warning if
   `system_stats` is unreachable.

---

## Security notes (invariants)

- The plaintext credential is disclosed **once** (create/rotate response only);
  it is never returned by GET endpoints, never placed in URLs, and the web UI
  never persists it (no localStorage/sessionStorage/URL).
- At rest only a SHA-256 hash is stored (`workers.token_hash`).
- Workspace isolation is enforced by the hub queue layout and backend dispatch;
  a private worker can only ever see its own workspace queue.
