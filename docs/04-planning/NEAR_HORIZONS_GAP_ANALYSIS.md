# Gap Analysis: "Animastor: Near Horizons" vs Current Code

> Companion to the vision document [`../Animastor_Близкие_горизонты.md`](../Animastor_Близкие_горизонты.md).
> Task: compare each vision section with actual code and show what already
> works, what's partial, and what hasn't started. Language — Russian (vision text
> was not translated).
>
> Snapshot date: August 18, 2026.

## Status Legend

| Status | Meaning |
|---|---|
| ✅ | Implemented and working (in production) |
| 🔶 | Partial: foundation exists, key detail missing |
| ⛔ | Not started / missing |

---

## 1. Summary Table by Document Sections

| § | Idea | Status | Where in code / comment |
|---|---|---|---|
| 1 | Cloud = control plane, Worker = compute | ✅ | `backend/` (orchestration) + `gpu-hub/` (dispatcher) + `worker/` (executors) |
| 2 | Horizon 1: Cloud + user's own GPUs | ✅ | `gpu-hub/gpu-hub.js`, `worker/worker/worker.cjs`, `worker/start-worker.sh` (image/audio/video), prod: GPU instance E2E (L40S, LTX 2.3) |
| 3 | Horizon 2: fully local Animastor | ⛔ | No local build; everything works as cloud + remote workers |
| 4 | Unified Worker architecture, capabilities | 🔶 | Beacon sends `id/type/gpu/vram/version/image_tag/protocol_version`; **no model list** → routing only by `type` |
| 5 | Heartbeat, outbound connection, jobs/progress/result | ✅ | Worker polls `HUB_URL` (outbound, no inbound ports); beacon 10s; heartbeat-refresh 15s (TTL 30s); `animastor:queue:*`, `running`, `processing`, result/error keys with retries. **No per-worker tokens** — only optional `GPU_HUB_API_KEY` |
| 6 | Bring Your Own Model | 🔶 | Worker executes arbitrary ComfyUI workflows — machine provides models (LTX 2.3, qwen-tts, qwen-image etc.). But **no model-based worker selection** |
| 7 | Community Compute ("torrent model" GPU) | ⛔ | Completely absent |
| 8 | Contribution model (GPU-hours, tiers) | ⛔ | Absent |
| 9 | Community worker security (sandbox) | ⛔ | Workers trusted (team); no isolation for foreign machines |
| 10 | Auto data cleanup + GC | 🔶 | Hub cleans Redis state (running/processing/dedup, timeouts, `queue/clear`), but **worker files remain** (`ComfyUI/input`, `output`); TTL-GC for temp job directories absent |
| 11 | Community flywheel | ⛔ | Not applicable until §7 |
| 12 | Marketing effect | ⛔ | Not applicable |
| 13 | Horizon 3: managed service | ⛔ | Not applicable |
| 14 | Monetization (Free/BYOG, Community, Managed) | ⛔ | No business model |
| 15 | What to lay now | ✅ | Principle followed: worker independent of launch location, protocol versioned, dispatch-lease + re-dispatch |
| 16 | Main strategic principle | 🔶 | Architectural foundation in place (orchestration over heterogeneous inference systems), but model-aware resource selection not yet implemented |
| 17 | Priority (9 items) | 🔶 | Items 1–4 (partially 6) implemented; 5, 7–9 — not (see below) |

---

## 2. What's Already Implemented — Details with Paths

### §1, §2, §5 — control plane separated from compute ✅

Actual production scheme (document drew it as goal):

```text
backend (control plane: orchestration, queues, dispatch-lease, re-dispatch)
    ↓ POST /gpu/task (dispatch_id, build_id, book/chapter/scene/stage, timeout_ms)
gpu-hub (dumb transport: queues by type, dedup, timeouts, error-delivery)
    ↓ animastor:queue:{image|audio|video}
worker.cjs (ComfyUI + Node.js) — outbound polling /task/next
```

Key files:

- `gpu-hub/gpu-hub.js` — worker registry in Redis (`animastor:gpu-hub:workers`, TTL 15 min), beacon, queues, dedup (`animastor:job:{dispatch_id}:{job_id}`), timeouts (per-job + per-GPU), error delivery to backend with retries and Redis fallback (`animastor:error:{job_id}`).
- `worker/worker/worker.cjs` — beacon every 10s, task polling, asset loading into `ComfyUI/input`, workflow launch, result waiting (per-job `timeout_ms` with 10 min / 2h video fallback), OOM-safe result reading from disk, result/error sending.
- `backend/src/runtime/` — `gpu-dispatcher.js` (POST `/task`), `dispatch-engine.js` (lease, re-dispatch), `reconciliation-engine.js` (watchdog), `worker-health.js`, `job-schema.js` (unified job_id contract, `PROTOCOL_VERSION = 2`).
- `backend/src/routes/generation-routes.cjs` — `/api/v1/worker/heartbeat`, `/status`, `/counts` (worker panel).
- `backend/src/routes/book/generation-routes.cjs` — `/cancel-worker` (per task/type, lease and hub queue cleanup).

### §4 — capabilities: foundation exists, models missing 🔶

Worker advertises itself as (already close to document schema):

```text
id, type (image|audio|video), gpu (name), vram, version, image_tag, protocol_version
```

Hub checks `worker_type_mismatch` and `protocol_version_mismatch`. But document's
capabilities richer: **models by type + cpu/ram/status**. This is missing → server can't
select worker "that has LTX 2.3".

### §6 — BYOM: de facto exists, de jure not 🔶

Task arrives as complete ComfyUI workflow (`task.params`), models reside on
worker machine (`~/ComfyUI/models`: LTX 2.3 GGUF, gemma-3, qwen-tts, qwen-image).
So "bring your own model" already works at hardware level, but system doesn't know
about worker models and can't route by them. Plus missing UI
"Connect your GPU" — only technically proficient users
can connect GPU via scripts.

### §10 — cleanup: half done 🔶

Done: hub cleans all Redis state — `running`, `processing`, dedup keys,
result/error keys by TTL (1h), `/queue/clear` (full or per book/dispatch).
Not done: **on worker side** input images and output files remain in
`ComfyUI/input` and `ComfyUI/output`; GC "temp job directory older than TTL
deleted" absent.

---

## 3. Gaps — What's Needed to Approach the Vision

By document priority (§17):

| # | Priority item | Status | What's needed |
|---|---|---|---|
| 1 | Stable Cloud + Worker protocol | ✅ | — |
| 2 | Independent workers with capabilities | 🔶 | Extend beacon: `models` (by type), `cpu/ram`; store in hub registry |
| 3 | Heartbeat / registration / jobs / progress / result | ✅ | — |
| 4 | User's local worker | ✅ | (only UX onboarding "Connect your GPU" needed) |
| 5 | Worker selection by capability/model | ⛔ | Routing in backend/hub by models, not just `type` |
| 6 | Safe temp area + auto cleanup | 🔶 | Delete input/output job files on worker + TTL-GC; (for foreign machines — sandbox, see §9) |
| 7 | Community compute | ⛔ | After §2 foundation; requires per-worker tokens (§5) and isolation (§9) |
| 8 | Fully local build | ⛔ | Same architecture, local control plane |
| 9 | Managed services and monetization | ⛔ | After community |

Additional from document:

- **Per-worker tokens** (§5): currently auth — optional shared `GPU_HUB_API_KEY`
  only on `/task*`; beacon open. Without individual tokens community compute
  impossible.
- **Sandbox/isolation** (§9): workers trusted; "user provides compute,
  not machine access" not implemented and not needed while workers only
  team-owned.

---

## 4. Conclusions and Recommendations

**Document's first horizon — not a plan, but already working architecture.**
Foundation the document asks to "lay now" (§15, §17) is laid:
control plane separated, worker independent of launch location, protocol
versioned, dispatch/lease/re-dispatch working.

Three steps giving maximum approach to vision with minimum effort:

1. **Capabilities + model-aware routing** (§4, §6, §17.2/17.5) — extend beacon
   with model list, select worker by model. This turns "BYOM de facto"
   into "BYOM de jure" and opens §2 model "who has what hardware".
2. **Worker-side cleanup** (§10) — cheap, closes garbage accumulation on
   foreign machines today.
3. **Per-worker tokens** (§5) — mandatory foundation before any community
   compute; without them §7–§9 unimplementable.

Community compute and fully local build — next horizons, shouldn't start
until at least one external (untrusted) worker appears.

---

## 5. Related Files

- Vision: `docs/Animastor_Близкие_горизонты.md`
- Architecture: `ARCHITECTURE.md` (repo root), `docs/01-overview/SYSTEM_MAP.md`
- Code: `gpu-hub/gpu-hub.js`, `worker/worker/worker.cjs`, `backend/src/runtime/{gpu-dispatcher,dispatch-engine,reconciliation-engine,worker-health,job-schema}.js`
- GPU instance notes: `worker/new/SYSTEM.md`, `worker/new/MEMORY.md`
