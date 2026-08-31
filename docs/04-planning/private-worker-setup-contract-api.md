# Private Worker Setup Contract — API Reference (Phase 3 / 3.1)

> **Status:** Phase 3 implemented; **Phase 3.1** — backend production-ready
> (canonical versions, probe-based availability, integrity/security tests) +
> Web Setup Center integrated. Android UI not yet modified.
> **Date:** 2026-08-27
> **Proposal:** `docs/04-planning/private-worker-installer-frontend-integration.md`
> **Code:** `backend/src/routes/worker-setup-routes.cjs`,
> `backend/src/installer/setup-contract.js`, `gpu-hub/gpu-hub.js` (artifacts),
> `gpu-hub/tarball.js`; Web — `frontends/app/src/features/workers/workerSetup.ts`,
> `frontends/app/src/features/workers/PrivateWorkersSection.tsx`
> **Tests:** `backend/tests/worker-setup-api.test.js`,
> `backend/tests/installer-setup-contract.test.js`,
> `backend/tests/gpu-hub-artifacts.test.js`,
> `frontends/app/src/features/workers/workerSetup.test.ts`

Unified backend Setup Contract for Web and Android:

```
                Backend
                   │
        Private Worker Setup Contract
              ┌────┴────┐
             Web     Android
```

Both frontends receive the same semantics: profiles, installation methods,
installer/uninstaller artifacts, worker bundle, workflows, worker status,
instructions, capabilities, installation plan.

---

## 1. Authentication & security model

All contract endpoints use the **same** session model as
`/api/v1/workers`:

- `authContext` → session of registered user;
- guests → `403 guest_forbidden`; anonymous → `401 auth_required`;
- `workspace_id` is always resolved server-side from session — never from request;
- `setup/workers/:id` returns identical `404` for foreign/unknown
  ids (no existence oracle);
- Worker Bearer token (`wrk.…`) is **not** a user session —
  setup endpoints return `401` for it.

Content guarantees:

| Rule | How ensured |
|---|---|
| No plaintext token | token exists only in create/rotate response; contract never reads or returns it |
| No `token_hash` | worker projections exclude the column; at most `token_prefix` (already public in list) |
| No internal model URLs / provenance / repo paths | `setup-contract.js` projects manifests to UI-safe DTO; raw manifest never leaves |
| No fabricated data | unknown VRAM = `null`; unresearched model sources = explicit block; missing artifact = `available:false, status:"planned"` |
| Frontend doesn't set download URLs | all `download_url` — origin-relative constants, backend-authorized (`/gpu/…`) |
| `.env` never enters bundle | `isServableBundleFile` filter in hub (`.env*` except `.env.example` excluded) + test |

Worker Key lifecycle **unchanged**: created by backend
(`POST /api/v1/workers`), shown once, only SHA-256 stored,
entered on GPU machine via installer's hidden prompt. Contract answers
"what to download / how to install / which profile / how to verify", not "where
is the key".

---

## 2. Endpoints

Base: `/api/v1/private-worker/setup`

| Method | Path | Purpose |
|---|---|---|
| GET | `/profiles` | install profiles from canonical installer metadata |
| GET | `/methods` | installation methods: platform × installer/uninstaller/worker-bundle |
| GET | `/artifacts` | artifacts for one platform |
| GET | `/workflows` | baseline workflow metadata (editable) |
| GET | `/instructions` | dynamic instructions (server-assembled) |
| GET | `/workers/:id` | UI-safe worker status (extended model) |
| POST | `/plan` | UI-safe installation plan (preview, never executed) |

Public artifacts on GPU Hub (no auth — no secrets; nginx proxies
`/gpu` → hub):

| Method | Path | Purpose |
|---|---|---|
| GET | `/gpu/worker-bundle` | full worker bundle (tar.gz) |
| GET | `/gpu/worker-bundle/sha256` | checksum + bundle version |
| GET | `/gpu/workflow/:id` | baseline workflow JSON (manifest allowlist) |
| GET | `/gpu/installer` | **bootstrap installer script** (bash): downloads bundle, verifies SHA-256, extracts to temp directory, launches real installer with embedded `profile`/`mode` (`?profile=…&mode=…`, manifest allowlist validation; no params → runtime guard). Requires bash/curl|wget/tar/sha256sum/Node ≥ 20; actively rejects credentials in env/argv (exit 3) |
| GET | `/gpu/installer/bundle` | self-contained installer package (tar.gz) |
| GET | `/gpu/installer/sha256` | checksum + installer version |
| GET | `/gpu/worker-source` | **DEPRECATED** (only `worker.cjs`); works, marked with headers `Deprecation: true` + `Link: </worker-bundle>` |

---

## 3. Response schemas

### 3.1 `GET /profiles`

Query: `?type=audio|image|video` (optional; otherwise 400 `invalid_type`).

```jsonc
{
  "profiles": [{
    "id": "image/qwen-image",
    "name": "Qwen Image",
    "description": "Qwen Image — private image generation via ComfyUI on your own GPU worker.",
    "worker_type": "image",
    "status": "draft",                       // draft | stable; hidden/internal not served
    "supported_install_modes": ["managed", "existing", "shared", "isolated"],
    "gpu": {
      "min_vram_gb": null,                   // unknown — honestly null, not fabricated
      "reference_gpu": "NVIDIA L40S (46068 MiB)"
    },
    "disk_budget_bytes_approx": 22780911288,
    "workflows": ["img-qwen-image"],
    "dependencies_summary": { "custom_nodes": 1, "models": 4, "approx_bytes": 22780911288 }
  }]
}
```

Source: `install-manifest.loadAllManifests()` + projection
(`setup-contract.projectProfile`). Manifest with `status: "internal"|"hidden"`
is excluded from contract.

### 3.2 `GET /methods`

```jsonc
{
  "methods": [
    {
      "platform": "linux",
      "architectures": ["x86_64"],
      "status": "available",                  // hub probe: artifact actually served
      "installer": {
        "available": true,                    // Phase 3.1: only based on hub-probe results
        "status": "draft",                    // E2E on real GPU not yet accepted
        "version": "1.0.0",                   // canonical: backend/src/installer/package.json
        "download_url": "/gpu/installer",     // null if artifact unavailable
        "sha256": "…64 hex…",                 // from hub-probe; null when hub unavailable
        "signature": null,                    // future: signature + signature_algorithm
        "signature_algorithm": null
      },
      "uninstaller": {
        "available": false,                   // uninstaller does not exist — honestly planned
        "status": "planned",
        "version": null, "download_url": null, "sha256": null,
        "signature": null, "signature_algorithm": null
      },
      "worker_bundle": {
        "available": true,
        "status": "available",
        "version": "2.0.0",                   // canonical: worker/worker/package.json
        "download_url": "/gpu/worker-bundle",
        "sha256": "…64 hex…",
        "files": ["worker.cjs", "worker-cleanup.cjs", "worker-cleanup-journal.cjs",
                   "package.json", "package-lock.json", ".env.example"]
      },
      "supported_profiles": ["audio/qwen-tts", "image/qwen-image", "video/ltx-2.3"],
      "minimum_requirements": { "node": "20", "python": "3.10", "gpu": "NVIDIA GPU …" }
    },
    { "platform": "windows", "status": "planned", "installer": { "available": false, "status": "planned", … }, … },
    { "platform": "docker",  "status": "planned", … }
  ]
}
```

Installer and Uninstaller are **different** versioned artifacts; contract does not
assume `uninstall = install --remove`. Windows/Docker ready for
`available: true` without frontend API changes. Metadata contains neither
file extensions (`.sh/.bat/.exe`), shells, nor commands — only
availability.

### 3.3 `GET /artifacts`

Query: `?platform=linux|windows|docker` (default `linux`; unknown →
`404 unsupported_platform`).

```jsonc
{
  "platform": "linux",
  "architecture": "x86_64",
  "status": "available",
  "installer":   { …as in methods… },
  "uninstaller": { … },
  "worker_bundle": { … },
  "supported_profiles": ["audio/qwen-tts", "image/qwen-image", "video/ltx-2.3"]
}
```

### 3.4 `GET /workflows`

Query: `?profile_id=<id>` (optional; unknown → `400 invalid_profile`).

```jsonc
{
  "workflows": [{
    "id": "img-qwen-image",
    "name": "Qwen Image",
    "profile_id": "image/qwen-image",
    "baseline_available": true,
    "download_url": "/gpu/workflow/img-qwen-image",
    "sha256": "fb4c25e5…",                   // baseline_sha256 from manifest
    "editable": true                          // baseline can be downloaded and modified
  }]
}
```

Workflow is not immutable: `editable` cannot be `false` (manifest validation).
Hub serves only workflows from the manifest allowlist — legacy `old_*.json`
not served; path traversal excluded.

### 3.5 `GET /instructions`

Query: `?profile_id=<id>[,<id2>]&platform=linux|windows|docker&mode=managed|existing|shared|isolated`
(defaults: `linux`, `managed`). Errors: unknown profile → `400
invalid_profile`; unknown platform → `404 unsupported_platform`;
invalid mode → `400 invalid_mode`.

 Worker is **already created** at this point (wizard: profile → mode → platform →
 create worker → install) — there is no `create-worker` step in instructions
 and cannot be: frontend always shows instructions only to key holder.

```jsonc
{
  "platform": "linux",
  "mode": "managed",
  "profile_ids": ["image/qwen-image"],
  "worker_key_policy": {
    "disclosed_once": true,
    "disclosed_by": "POST /api/v1/workers (create) or POST /api/v1/workers/:id/rotate",
    "entered_on": "GPU machine — the installer asks interactively (hidden input)",
    "never": ["setup contract responses", "logs", "argv", "URLs", "installer state files"]
  },
  "env": {
    "required": ["HUB_URL", "ANIMASTOR_WORKER_TOKEN", "WORKER_TYPE", "WORKER_ID"],
    "secrets": ["ANIMASTOR_WORKER_TOKEN"],
    "template_block": "HUB_URL=<hub-url>\nANIMASTOR_WORKER_TOKEN=<your-worker-key>\nWORKER_TYPE=<worker-type>\nWORKER_ID=<worker-id>"
  },
  // Bootstrap installer metadata for UI: version — main line,
  // sha256 — in collapsed block (shown once). For managed/existing
  // download_url — bootstrap script with embedded profile/mode (nothing
  // to enter); for isolated — tar.gz bundle.
  "installer": {
    "version": "1.3.0",
    "sha256": "…",
    "status": "available",
    "download_url": "https://<origin>/gpu/installer?profile=image%2Fqwen-image&mode=managed"
  },
  "steps": [
    // managed/existing (bootstrap flow):
    { "id": "download-bootstrap", "title": "…", "body": "…",
      "code": "curl -fsSL -o animastor-installer.sh https://<origin>/gpu/installer?profile=image%2Fqwen-image&mode=managed" },
    { "id": "run-bootstrap", "title": "…", "body": "…",
      "code": "bash animastor-installer.sh" },
    { "id": "verify", "title": "…", "body": "…" }
    // existing adds prerequisites before them
    // (ComfyUI / Python / Torch / CUDA / GPU — detection done by installer).
  ],
  // Optional terminal diagnostics — NEVER a required step:
  // page itself shows worker status (Online after heartbeat).
  "verify_command": "$HOME/animastor/tools/status.sh"
}
```

- `mode=existing` adds `prerequisites` step (ComfyUI / Python / Torch /
  CUDA / GPU — detection done by installer, frontends don't hardcode);
- `mode=shared` passes `--mode shared` (CLI supports);
- `mode=isolated` — bootstrap not used (single launch doesn't express
  independent environments): explicit tar.gz flow, one installer launch
  per profile with separate `--root`; `installer.download_url` points to
  `/gpu/installer/bundle`, steps receive checksum + verify_code;
- degradation: installer unavailable + bundle available → step
  `installer-unavailable` (or bundle-flow for existing); platform not
  published → step `platform-planned` (no commands);
- token — placeholder only `<your-worker-key>`; bootstrap script actively
  rejects credentials in env/argv (fail closed, exit 3);
- old instructions (`curl … worker-source`, `node worker.cjs`) absent from
  contract — being phased out.

### 3.6 `GET /workers/:id`

```jsonc
{
  "worker": {
    "worker_id": "…uuid…",
    "workspace_id": "…uuid…",
    "name": "alice-image",
    "worker_type": "image",
    "mode": "private",
    "status": "CONNECTING",                  // extended model (adapter)
    "base_status": "OFFLINE",                // existing derivation — unchanged
    "status_model": ["NOT_CONFIGURED", "INSTALLING", "CONNECTING",
                      "ONLINE", "OFFLINE", "ERROR", "REVOKED"],
    "token_prefix": "wrk.…prefix…",          // max mask — same as in list
    "last_seen": 1756000000000,
    "revoked_at": null,
    "created_at": 1756000000000,
    "capabilities": {                         // normalized; null if no data
      "profiles": ["image/qwen-image"],
      "workflows": ["img-qwen-image"],
      "gpu": { "name": "NVIDIA L40S", "vram_gb": 45 }
    },
    "details": null                           // online details from hub heartbeat — future extension
  }
}
```

Adapter (doesn't break ONLINE/OFFLINE/REVOKED):

| base | last_seen | setup status |
|---|---|---|
| REVOKED | — | `REVOKED` |
| ONLINE | — | `ONLINE` |
| OFFLINE | `null` (never seen) | `CONNECTING` |
| OFFLINE | number | `OFFLINE` |

`NOT_CONFIGURED` — frontend state (worker not created); `INSTALLING` and
`ERROR` reserved for future signals (installer check-in / worker
error reporting) — backend currently doesn't receive or fabricate them.

`capabilities` — normalized passthrough of real data
(`profiles[]`, `workflows[]`, `gpu{name, vram_gb}`; `vram_mib` →
`vram_gb`); no fabricated fields added: empty → `null`.

### 3.7 `POST /plan`

Request:

```jsonc
{
  "profile_ids": ["image/qwen-image"],       // ≥1, all must exist
  "mode": "managed",                          // managed | existing | shared | isolated
  "platform": "linux"                         // linux | windows | docker (default linux)
}
```

Response:

```jsonc
{
  "result": "BLOCKED",                        // READY | READY_WITH_WARNINGS | BLOCKED
  "platform": "linux",
  "mode": "managed",
  "profiles": ["image/qwen-image"],
  "actions": [
    { "type": "INSTALL",  "component": "runtime",       "name": "ComfyUI", "profiles": ["image/qwen-image"], "conditional": false },
    { "type": "INSTALL",  "component": "custom-node",   "name": "ComfyUI-GGUF", … },
    { "type": "DOWNLOAD", "component": "model",         "name": "qwen-image-2512-Q4_K_M.gguf", "blocked": true, "size_bytes_approx": 13249974108, … },
    { "type": "DOWNLOAD", "component": "workflow",      "name": "Qwen Image", "editable": true, … },
    { "type": "INSTALL",  "component": "worker-bundle", "name": "Animastor worker (image)", … },
    { "type": "CONFIGURE","component": "worker-env",    "name": "Worker configuration (Worker Key entered on the GPU machine — never via this API)", … },
    { "type": "VERIFY",   "component": "verification",  "name": "Post-install verification (resolver diff + registration check)", … }
  ],
  "warnings": ["profile image/qwen-image is \"draft\" — E2E acceptance …", "…minimum VRAM is unknown…"],
  "blocks": [
    { "code": "MODEL_SOURCE_NOT_PUBLISHED",
      "message": "qwen-image-2512-Q4_K_M.gguf: download source is not researched yet — the installer refuses to guess URLs (manifest status: draft)" }
  ],
  "sharing": null,                            // or { verdict, can_share, message } when >1 profile
  "disk_budget_bytes_approx": 22780911288
}
```

Semantics:

- plan — **preview** based on canonical manifests + resolver against clean
  environment; HTTP call installs nothing (backend is not remote shell);
- `mode=existing` — all INSTALL/DOWNLOAD actions `conditional: true`
  (installer does detection on machine and installs only missing;
  user components never auto-replaced);
- `mode=shared` (≥2 profiles) — `sharing.verdict`:
  `SHARED_COMPATIBLE` / `SHARED_CONFLICT` / `REQUIRES_ISOLATION` / `UNKNOWN`
  (real data: audio+image ⇒ `SHARED_COMPATIBLE`; image+video ⇒
  `REQUIRES_ISOLATION` — different ComfyUI commits in reference environments);
- `mode=isolated` — each profile planned in its own environment
  (data model; multi-ComfyUI orchestration not implemented);
- `platform=windows|docker` ⇒ `BLOCKED` with `PLATFORM_NOT_SUPPORTED`;
  unresearched model sources ⇒ `MODEL_SOURCE_NOT_PUBLISHED`
  (installer also reports BLOCKED — URLs not fabricated);
  validation errors: `400 invalid_profile` / `400 invalid_mode` /
  `404 unsupported_platform`.

---

## 4. Artifact model

| Artifact | Version (canonical source) | Source | Integrity | Signature |
|---|---|---|---|---|
| Installer | `backend/src/installer/package.json` → `version` (currently `1.0.0`) | hub `GET /installer` — tar.gz: `src/installer/**` + `ai/install-manifests/**` + generated root `package.json`/`README.txt` | sha256 (deterministic build: fixed mtime/order) | `signature: null` — schema ready |
| Uninstaller | absent ⇒ `version: null` | doesn't exist | — | planned; separate artifact, not `install --remove` |
| Worker bundle | `worker/worker/package.json` → `version` (currently `2.0.0`) | hub `GET /worker-bundle` — tar.gz 6 files | sha256 | — |
| Baseline workflow | `revision` of manifest + baseline_sha256 (content-addressed) | hub `GET /workflow/:id` (manifest allowlist) | sha256 matches manifest | — |

**Phase 3.1: versions have single source of truth.** Hub reads versions from
canonical `package.json` files on request (no config duplicates); backend
Setup Contract gets version from hub-probe (what's actually served), with
fallback to repository's canonical file. Artifact without canonical version is
not served (404). `worker.cjs` reports same version from its own
`package.json` in beacon (override — `WORKER_VERSION` env).

**Phase 3.1: availability matches reality.** Backend probes hub
(`GET /worker-bundle/sha256`, `GET /installer/sha256`, TTL cache 30s):
`available: true` only if hub actually serves artifact. Probe
failure ⇒ `available: false, status: "unavailable", download_url: null`
(fake links impossible). Artifact statuses: `available` | `draft`
(implemented, E2E acceptance pending) | `planned` (not implemented) |
`unavailable` (not served by this deployment).

Determinism: tar archives built by pure-JS ustar-writer
(`gpu-hub/tarball.js`) with fixed mtime=0/uid/gid/mode and file
sorting ⇒ same content ⇒ same sha256. Hub cache invalidated by
source file fingerprint (size+mtime).

`download_url` in contract — origin-relative (`/gpu/…`): frontend resolves
against its origin (Web — `location.origin`, Android — `BASE_URL`).
sha256 backend resolves server-side from hub (`HUB_URL` env); hub unavailable ⇒
`sha256: null`, `available: false` (metadata not broken).

Workflow metadata (Phase 3.1): `baseline_available` reflects actual
presence of canonical file in tree served by hub; file absent ⇒
`download_url: null, sha256: null`. `revision` — version of manifest
defining workflow artifact.

---

## 5. Worker bundle model

`GET /gpu/worker-bundle` → `animastor-worker-2.0.0.tar.gz`:

```
animastor-worker/
  worker.cjs
  worker-cleanup.cjs
  worker-cleanup-journal.cjs
  package.json
  package-lock.json
  .env.example          # variable names only + placeholder
```

- **Worker Key NOT in bundle**: `.env` and any `.env.*` (except `.env.example`)
  excluded by hub filter regardless of mounted directory content;
  token delivered separately (one-time disclosure → hidden prompt
  by installer on GPU machine, `.env` merge semantics, chmod 600);
- single-file assumption (`/gpu/worker-source`) marked deprecated —
  `worker.cjs` does `require('./worker-cleanup.cjs')` and
  `require('./worker-cleanup-journal.cjs')`, single file install is broken;
- docker-compose mounts `./worker/worker:/app/worker-bundle:ro`
  (+ `./backend/ai/workflows`, `./backend/src/installer`,
  `./backend/ai/install-manifests` for installer).

---

## 6. Migration from `/gpu/worker-source`

| Stage | What |
|---|---|
| Now (Phase 3) | `/gpu/worker-source` works unchanged + headers `Deprecation: true`, `Link: </worker-bundle>; rel="successor-version"`; code marked DEPRECATED. Canonical source for future frontends — Setup Contract |
| Web UI / Android UI (next phases) | frontends migrate to `setup/*` endpoints + `/gpu/worker-bundle`; old i18n instructions remain fallback |
| Cleanup (after new UX adoption) | `/gpu/worker-source` narrowed to deprecated alias or removed by separate decision |

Deployment note: hub gets new endpoints after image rebuild
(`docker compose build gpu-hub && docker compose up -d gpu-hub`); backend
picks up routes after restart (src mounted live).

---

## 7. What was NOT changed in this phase

- Android UI — untouched (same Setup Contract to be used later);
- Web: old single-file flow removed from main onboarding, but its
  helpers/strings preserved as compatibility fallback (Phase 3.1 §9);
- Worker (`worker/worker/*`), GPU Hub protocol (`protocol_version=2`),
  dispatch/task pipeline — untouched;
- existing Worker API (`/api/v1/workers*`, `/api/v1/worker/verify`) —
  no breaking changes (covered by tests);
- Worker Key lifecycle — unchanged;
- remote installation via HTTP — not implemented (plan = preview);
- Windows installer/uninstaller — not implemented (schema only).
