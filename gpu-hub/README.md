# @animastor/gpu-hub

GPU Hub — standalone HTTP orchestration boundary between the Animastor backend and GPU workers. It owns the Redis-backed task queues, dispatches GPU jobs, relays results/errors back to the backend, and serves worker onboarding artifacts (bootstrap installer, worker bundle, workflows).

Job Protocol v2 is consumed from the canonical [`@animastor/contracts`](https://www.npmjs.com/package/@animastor/contracts) package — the hub carries no local protocol copy.

## Standalone run

```bash
npm ci
npm start          # node server.js
```

`@animastor/contracts` resolves from npm registry as a regular dependency. No special setup required.

Tests:

```bash
npm test           # zero-dependency suite: package smoke, import isolation,
                   # canonical contracts import, protocol parity, route freeze,
                   # Redis ownership
```

## Required env

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5000` | HTTP listen port |
| `REDIS_URL` | `redis://animastor-redis:6379` | Redis connection |
| `BACKEND_URL` | `http://animastor-backend:3000` | Backend base URL for result/error callbacks |
| `GPU_HUB_API_KEY` | — (empty) | Shared API key for backend → hub calls (`/task`, `/queue/clear`). Empty = no auth (dev only) |
| `GPU_TIMEOUT_MS` / `GPU_TIMEOUT` | `600000` | GPU task hard timeout (ms) |
| `SHARE_FEATURES_ENABLED` | `0` | Worker-sharing V1 kill-switch (default OFF) |

## Exposed port

`5000` (HTTP only; in production always behind the nginx `/gpu/` proxy).

## HTTP contract

Frozen route set (14 routes — see `docs/architecture/GPU_HUB_CONTRACT.md` §3):

- `POST /beacon` — worker heartbeat
- `POST /task` — backend submits a GPU job (API key)
- `GET /task/next` — worker claims next job (worker credential)
- `POST /task/result` — worker posts result → backend callback
- `POST /task/error` — worker reports failure → backend callback
- `DELETE /queue/clear` — backend clears queues (API key)
- `GET /worker-source` — deprecated legacy `worker.cjs` (backward compat)
- `GET /worker-bundle`, `GET /worker-bundle/sha256` — worker runtime bundle
- `GET /workflow/:id` — baseline workflow by allowlisted id
- `GET /installer`, `GET /installer/bundle`, `GET /installer/sha256` — private worker onboarding installer
- `GET /health` — queue depths

Additions/removals are guarded by tests (route freeze).

## Redis dependency

Hub connects to a single Redis instance (`REDIS_URL`). Hub-owned keyspace: `animastor:gpu-hub:workers`, queue/running/heartbeat/dead-letter families (constants frozen, ownership guarded). The backend-owned `animastor:worker-auth` mirror is **read-only** for the hub — the hub never writes it (frozen debt, guarded).

## Backend callback

For `POST /task/result` and `POST /task/error` the hub POSTs the Job Protocol v2 envelope to `BACKEND_URL` (callback URL supplied by the backend at dispatch). Hub → backend is HTTP only.

## Job Protocol v2 dependency

`@animastor/contracts` is the single canonical implementation of Job Protocol v2 (`PROTOCOL_VERSION` import). The hub must never carry a local protocol literal — guarded by tests on both sides (hub + monorepo architecture guards).

## Security warning

The hub exposes worker onboarding artifacts, queue introspection and (without `GPU_HUB_API_KEY`) task submission. **Do not expose the hub directly to the internet.** In production it is reachable only through the internal docker network and the authenticated nginx `/gpu/` proxy prefix. Running it publicly without an API key and reverse proxy is unsafe.
