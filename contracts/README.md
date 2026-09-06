# @animastor/contracts

Frozen wire contracts shared by Animastor components. **Single source of
truth** so backend, GPU Hub and Worker stop drifting apart before/after the
worker physical extraction.

Currently published contract:

- **Job Protocol v2** (`src/job-protocol-v2.js`) — the frozen wire contract
  between backend (orchestrator/dispatcher), GPU Hub (queues/claim) and
  Worker (ComfyUI execution). The normative specification is
  [`docs/architecture/JOB_PROTOCOL_V2.md`](../docs/architecture/JOB_PROTOCOL_V2.md)
  (Phase 9A, FROZEN) — this package implements it verbatim, no more.

## What is inside (Job Protocol v2)

| Export | Meaning |
|---|---|
| `PROTOCOL_VERSION` | `2` — frozen for the whole Phase 9 (§3.1) |
| `JOB_TYPES` | job_id suffix family: `audio, image, iu_image, video` |
| `SYSTEM_JOB_TYPES` | hub transport/scan-queue family: `audio, image, video` |
| `STAGE_BY_KIND` | parse `kind` → `stage` mapping |
| `buildJobId / splitJobId / parseJobId / getStageForJobId` | canonical job_id grammar (`${assetId}:${type}`, parse-from-end) |
| `TASK_ENVELOPE_REQUIRED_FIELDS`, `TASK_ENVELOPE_FIELDS` | task envelope contract (§3.2) |
| `RESULT_ENVELOPE_REQUIRED_FIELDS`, `ERROR_ENVELOPE_REQUIRED_FIELDS`, `BEACON_ENVELOPE_REQUIRED_FIELDS` | callback envelope contract (§3.10–3.12) |
| `ERROR_TOKENS` | canonical wire error tokens (§3.13) |
| `validateTaskEnvelopeIdentity`, `validateResultEnvelopeIdentity` | advisory identity-block helpers mirroring hub checks |

**No business logic.** Nothing here performs I/O, HTTP, Redis or workflow
work; the package is dependency-free (Node >= 18, CommonJS).

## Consumers

| Component | How it consumes |
|---|---|
| backend | `backend/src/runtime/job-schema.js` — compatibility facade re-exporting this package (12 import sites unchanged) |
| gpu-hub | still carries its own inline copy (Phase 9C blocker: docker build context — see `docs/architecture/PHASE_9C_CONTRACTS_EXTRACTION_AUDIT.md`) |
| worker | still carries its own inline copy (Phase 9B zero-dep bundle freeze — same audit) |

Parity between the package and the remaining copies is enforced by
`backend/tests/architecture/phase9c-contracts.test.js` (cross-side contract
test) and the package's own suite (`npm test` here).

### Bootstrap for a fresh checkout (backend tests)

The backend deliberately has **no npm dependency** on this package yet (a
`file:../contracts` dep would break the backend docker build whose context is
`./backend` — see `docs/architecture/PHASE_9C_CONTRACTS_EXTRACTION_AUDIT.md`
§3.1). Resolve it with a one-time symlink from the repo root:

```bash
mkdir -p node_modules/@animastor && ln -sfn ../../contracts node_modules/@animastor/contracts
```

In docker-compose deployments the backend service mounts
`./contracts:/app/node_modules/@animastor/contracts:ro` automatically.

## Usage

```js
const { PROTOCOL_VERSION, parseJobId, buildJobId } = require('@animastor/contracts');
// or namespaced:
const { jobProtocolV2 } = require('@animastor/contracts');
```

## Rules for contributors

- `protocol_version` stays `2` for the whole Phase 9. Any change goes through
  the versioning policy (`JOB_PROTOCOL_V2.md` §4) with a coordinated bump in
  all three components.
- Grammar/envelope changes are breaking (v3 material) unless explicitly
  additive and wire-compatible.
- This package must never depend on backend, GPU Hub, Worker or any npm
  package. Zero runtime dependencies.
- Not published to the npm registry.
