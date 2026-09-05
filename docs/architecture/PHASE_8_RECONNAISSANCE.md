# PHASE 8 — Architectural Reconnaissance & Extraction Candidacy

**Status:** audit only. Nothing was extracted. No production code, guards or
Phase 1–7 boundaries were changed. No old tests were touched.
**Date:** 2026-09-05
**Baseline:** HEAD `9ac64c77` (code state of commit `a7c56fd`, verified by
`PHASE_7_FINAL_VERIFICATION.md` — 0 regressions, P7-T1…T8 executable and
non-vacuous).
**Inputs:** all `docs/architecture/` Phase 1–7 documents, the 16 architecture
guard suites in `backend/tests/architecture/`, architectural commits
`16065722…a7c56fd`, and direct source inspection of `local-ai-connector/`,
`worker/worker/`, `gpu-hub/` (manifests, requires, Redis key literals,
docker-compose mounts).

**Phase rule honored:** no refactoring, no production-code changes, no changes
to Phase 1–7 architectural boundaries, no new guards created (proposals only).

---

## 1. Method

Re-verification of the Phase 7 extraction matrix against HEAD plus targeted
measurement of the three already-isolated packages (LAC, Worker, GPU Hub):

- inbound coupling: repo-wide `require` scan into each contour
  (P7-T1/T2/T3 enforcement verified as executable);
- outbound coupling: dependency manifests + external requires in source;
- cyclic dependencies: SCC baselines (P7-T7) + SYNC-copy scan;
- external contracts: which protocol/contract surfaces are pinned by tests;
- deployment/runtime coupling: docker-compose mounts, Redis key literals,
  artifact delivery paths.

---

## 2. Candidate map (measured at HEAD `9ac64c77`)

| Module | Inbound | Outbound | Cycles | External contract | Verdict |
|---|---|---|---|---|---|
| **Local AI Connector** | 0 repo requires (P7-T1) | 0 — `ws` + builtins only | none | LAC v1 frames pinned (`phase2-lac-transport-contract.test.js`) | 🟢 |
| **Worker** | 0 (P7-T2) | builtins + global `fetch` | none | Job Protocol v2 — **3 SYNC copies** (`job-schema.js` ↔ `gpu-hub.js:32/758` ↔ `worker.cjs:49`); bundle delivered to hub via docker volume mounts | 🟢→🟡 (grammar unpublished) |
| **GPU Hub** | 0 code requires (P7-T3) | 17 shared Redis key literals (`animastor:queue/result/error/job/worker-auth/heartbeat/gpu-hub:workers/…`) | none | Redis keys implicit; envelope REQUIRES book identity (`gpu-hub.js:766`: `build_id/book_id/chapter_id/scene_id/stage`); backend cross-owner writes (drainPolicyLane RPOPLPUSH + task-body mutation, `worker-routes.cjs:414` hdel); artifact mounts from repo (`docker-compose.yml:123-132`) | 🔴 (contractual, not code-level) |
| **VBook Runtime / Book Model** | 23 baseline raw consumers (P7-T4) | detectors in `services/`, `config/runtime-config`, PG ownership handshake | none | Phase 2 bundle contract + Phase 4 facade | 🟡 |
| **Provider Gateway** | 1 consumer (`ai-routes.cjs`) | 5 delegates; 8 bypass call sites (P7-T8) | yes — `workspace-ai-provider ⇄ system-ai` SCC | Phase 3 three-direction facade | 🟡 |
| **Player / Editor** | 0 into facades; route contours mixed | pinned baselines (Phase 6 T5/T6) | none | Phase 6 facades + `mediaUrl`/client seam | 🟠 |
| Cache | — | Redis chunk families + `OUTPUT_DIR` + PG, 4+ writer subsystems | — | none | 🔴 not a module |
| Generation | — | runtime + state + storage + FS; workflows→book violation | in 14-module SCC | ComfyUI seam only | 🔴 |
| Orchestration / Runtime | — | same SCC; Redis/PG/FS owners | 14-module SCC (P7-T7 frozen) | result-contract seam | 🔴 |

---

## 3. Per-candidate extraction assessment

### 3.1 Local AI Connector — 🟢 LOW RISK

- **Inbound coupling:** zero. Verified by P7-T1 (no repo file requires into
  `local-ai-connector/`), with the negative-control proof from the Phase 7
  final verification.
- **Outbound coupling:** zero repo edges; the only runtime dependency is
  `ws` (pinned in both manifest and the P7-T1 manifest assertion).
- **Cycles:** none (not part of any backend SCC — it is outside `backend/src`).
- **Consumers:** none in code. The only interface is the WS protocol
  `/api/v1/ai-connector/ws` + LAC v1 frames. Backend-side coupling
  (shared-pool liveness, transport limits mirrored in
  `services/ai-connector/transport.js:60`) is host-side, not package-side.
- **External contract:** LAC v1 frame set is pinned by tests; protocol
  semantics documented across Phase 2/3 docs.
- **Extraction safety:** highest of all candidates. No SYNC copies with repo
  code, no volume-mount coupling, no Redis/PG/FS usage.
- **Needed for independent distribution:** packaging/release only —
  version 1.0.0, CHANGELOG, license decision (currently UNLICENSED),
  publish the LAC v1 frame spec as the public contract, distribution
  channel (npm `animastor-ai-connector`).

### 3.2 Worker — 🟢 structure / 🟡 contract

- Structure fully ready (P7-T2: zero inbound; builtins-only outbound;
  `node-fetch` in `package.json` is a **dead dependency** — `worker.cjs:82`
  uses global `fetch`).
- Blockers are protocol-level: Job Protocol v2 `job_id` grammar synced across
  three copies; worker bundle + workflows + installer delivered to the hub
  via repo volume mounts. Extraction requires publishing the grammar as a
  versioned contract and serving artifacts through the hub API (already
  exists: `/worker-bundle*`, `/workflow/:id`, `/installer*`) instead of mounts.

### 3.3 GPU Hub — 🔴 for now (the trap)

- Code-level isolation (P7-T3) masks contractual coupling:
  - 17 shared Redis key families with the backend, including cross-owner
    writes by the backend (policy-lane drain with task-body mutation,
    workers-registry `hdel`);
  - the job envelope makes book-identity fields **mandatory**
    (`gpu-hub.js:766` `incomplete_dispatch_identity` check) — the hub must
    know `book_id/chapter_id/scene_id/stage`;
  - artifact delivery is repo volume mounts, not the hub API.
- The original roadmap's "Phase 5 GPU Hub contract" (payload.meta,
  hub-owned auth/heartbeat, API-served artifacts, `MODULAR_PRODUCT_ARCHITECTURE_FINAL_REVIEW.md`
  §5 Phase 5) was **not executed as written** — the executed Phase 5 was
  orchestration/runtime. Hub extraction is blocked until the Redis/queue
  contract is published and the envelope identity is decoupled.

### 3.4 Not candidates (audit-confirmed, unchanged from Phase 7)

VBook Runtime (🟡 — detector/config/ownership decoupling first), Provider
Gateway (🟡 — 8 bypass call sites frozen by P7-T8; resolver SCC), Player /
Editor (🟠 — contour routes still mix concerns, pinned by Phase 6 T5/T6),
Cache / Generation / Orchestration / Runtime (🔴).

---

## 4. Final verdict

**PHASE 8 STATUS:** READY

**TOP CANDIDATE:** Local AI Connector (`local-ai-connector/`)

**RISK:** LOW

**Why (architectural facts, not preference):**

1. The only module with **zero coupling in both directions** — enforced by
   P7-T1 and proven non-vacuous by the Phase 7 negative control.
2. Single dependency `ws` (+ builtins); no Redis/PG/FS inside the package —
   the liveness mirror belongs to the backend host.
3. An external contract **already exists and is test-pinned** (LAC v1
   frames, `phase2-lac-transport-contract.test.js`) — nothing has to be
   invented for extraction.
4. No SYNC grammar copies with the repo (unlike Worker's 3-way Job Protocol
   sync) and no volume-mount coupling (unlike the hub's artifact mounts).
5. Already operationally autonomous — it runs on user machines today;
   extraction is a packaging/release act, not an architectural one.

---

## 5. Next three safe steps

1. **Publish LAC v1 as a versioned spec** — frame set + mirrored limits
   (`transport.js:60`), timeouts, error semantics. Doc-only.
2. **Release readiness for `animastor-ai-connector`:** version 1.0.0,
   CHANGELOG, license decision, distribution channel — no code changes.
3. **On repo extraction:** P7-T1 moves with the package (or is replaced by
   structural separation); backend keeps `phase2-lac-transport-contract` as
   the cross-repo contract pin. Run the full test contour afterwards and
   confirm zero Phase 1–7 guard degradation.

---

## 6. Guards impact (proposal — nothing was created/changed)

**Must be preserved as-is:**

- `phase7-extraction-readiness.test.js` P7-T1 — the core of this candidate;
- `phase2-lac-transport-contract.test.js` — LAC v1 contract pin;
- `dependency-guardrails.test.js` — LAC ws-only allowlist.

**Not affected:** P7-T2/T3/T7, `sql-boundary`, `redis-ownership` (LAC never
touches Redis), Phase 4/6 facades, `chat-transport`.

**Proposed extension (only when extraction actually happens):** a
version-handshake assertion in `phase2-lac-transport-contract` (frame-set
compatibility across a published package version). Do NOT create it now.

---

## 7. Critical findings

- **GPU Hub is the trap:** code isolation (P7-T3) hides 17 shared Redis key
  families, backend cross-owner writes (queue-body mutations, registry
  hdel), mandatory book-identity envelope fields, and artifact volume
  mounts. The roadmap's GPU-hub contract phase was never executed as
  written; hub extraction stays blocked until the Redis/queue contract is
  published and envelope identity is decoupled.
- **Worker dead dependency:** `node-fetch` in `worker/worker/package.json`
  is unused (global `fetch` at `worker.cjs:82`); clean up before extraction.
  Job Protocol v2 grammar must be published as one contract instead of 3
  SYNC copies.
- **No regressions or blockers found for the Local AI Connector.**
