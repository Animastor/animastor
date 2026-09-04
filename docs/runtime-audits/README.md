# Animastor Runtime Audits

Snapshots of known-working Animastor GPU instances.

## Profiles

- `audio-qwen/` — Audio / Qwen TTS
- `image-qwen/` — Image / Qwen Image
- `video-ltx-2.3/` — Video / LTX 2.3

## Point-in-time E2E validations

- `phase-3.3-e2e-validation-2026-08-27.md` — Phase 3.3 E2E validation
- `phase-3.4-e2e-blockers-2026-08-27.md` — Phase 3.4 blocker analysis
- `local-ai-connector-e2e-2026-09-04.md` — Local AI Connector + Ollama E2E on the production VPS (CPU inference, registration → WS → discovery → chat non-streaming/streaming)

These audits are reference snapshots for designing the profile-based
runtime configuration and automated installers.

The audit files describe actual working environments and are not,
by themselves, installation instructions.

Secrets are intentionally redacted by the audit script.

## Workflow delivery architecture (verified)

Confirmed by reading the source:

- Workflow JSON templates live on the **Animastor VPS** (backend), under
  `backend/ai/workflows/*.json` and `backend/ai/connectors/conn-*.json`.
- The **GPU worker** (`worker/worker/worker.cjs`, `runWorkflow()`) receives
  the fully-resolved workflow as `task.params` over the GPU Hub
  connection. It does **not** read any workflow file from disk; it
  forwards the JSON straight to ComfyUI.
- The worker POSTs the workflow to ComfyUI at
  `http://127.0.0.1:${COMFY_PORT}/prompt` with body
  `{ prompt: <workflow-json>, client_id: <WORKER_ID> }`.
- ComfyUI parses the prompt, executes it, and writes the output under
  `~/ComfyUI/output/`. The worker reads the result back via
  `/history/<prompt_id>` and the file system, and ships it to the hub.

Delivery chain:

```
Animastor VPS
  └─ backend workflow builder (fills connector-bound values)
       └─ gpu-dispatcher.send() → POST /gpu/task (gpu-hub)
            └─ worker.cjs receives task.params
                 └─ POST http://127.0.0.1:8188/prompt
                      └─ ComfyUI executes → output/*.png|mp4|…
```

Consequence: a GPU instance is **not expected** to keep workflow JSON
files locally for runtime use. The audit script therefore reports the
absence of `~/ComfyUI/user/default/workflows/` as an **expected state**
on a remote-delivery install, not as a configuration error. Workflow
files in the audit are only present when an operator explicitly stages
them for offline / debug use.

The audit script also scans the **Animastor repository** (when run from
inside a checkout) under `backend/ai/workflows/` — those files live on
the VPS, not on the GPU box, and are reported separately.
