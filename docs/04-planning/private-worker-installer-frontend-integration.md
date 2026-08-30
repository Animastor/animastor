# Private GPU Worker Installer — Frontend Integration Proposal

> **Status:** Phase 3 (Backend Setup Contract) **implemented**; Web/Android UI — not yet modified
> **Date:** 2026-08-27
> **Scope:** Web frontend (priority 1), Android frontend (priority 2), shared backend contract.
> **API reference (Phase 3):** `docs/04-planning/private-worker-setup-contract-api.md`
> **Companion docs:**
> - `docs/04-planning/private-worker-installer-architecture.md` — installer architecture (Phase 1/1.5)
> - `docs/04-planning/private-worker-installer-phase15.md` — existing ComfyUI, workflows, runtime modes
> - `docs/04-planning/private-worker-installer-e2e-acceptance.md` — Phase 2 acceptance status
> - `docs/architecture/EXPERIMENTAL_BETA_WORKER_SETUP.md` — current (outdated) instructions
> - `docs/architecture/LINUX_INSTALLER_RECONNAISSANCE.md` — reconnaissance of same-named installer
>
> Sections §1–§15 — original proposal. Final backend contract, implemented
> in Phase 3, documented in §16 and separate API document. UI tasks
> (Web/Android) proceed as separate phases on top of implemented contract.

---

## 0. Executive summary

Today both frontends (Web and Android) show users the **old model**:
"download one file `worker.cjs` → paste Worker Key → run `node worker.cjs`".
This model no longer matches reality:

- worker consists of **6 files** (`worker.cjs`, `worker-cleanup.cjs`,
  `worker-cleanup-journal.cjs`, `package.json`, `package-lock.json`, `.env.example`);
  `worker.cjs` does `require('./worker-cleanup.cjs')` and
  `require('./worker-cleanup-journal.cjs')` — single file install is **broken**;
- new **Installer** exists in repository (`backend/src/installer/`,
  CLI `animastor-installer`, phases 1–2.1), automating the entire path:
  profile → ComfyUI → dependencies → models → workflows → worker → key → verification;
  but it has **no HTTP surface** and is unknown to frontends;
- hub only serves `worker.cjs` (`GET /gpu/worker-source`) — remaining bundle files
  and baseline workflows unavailable via API.

Proposal: introduce unified **Setup Contract** for Web and Android — backend endpoints serving UI-safe metadata (profiles, installation methods,
installer/uninstaller artifacts, instructions, worker status), and rebuild
Private Workers screen around two scenarios (**Managed GPU Server** and
**Existing Local ComfyUI**). Frontend explains "what to do", Installer handles
"how". Frontend doesn't hardcode installer versions, commands, or file lists —
all comes from backend metadata. Key new abstraction —
**Installation Method / Platform** (§15) — so Linux installer doesn't become
the only assumed path, and Windows/Docker added without UI rewrite.

---

## 1. Current Web flow

**Route:** `/settings/private-workers` → `frontends/app/src/main.tsx:47` →
`pages/SettingsPage.tsx:33` → `features/workers/PrivateWorkersSection.tsx:23`.
Stack: Preact + preact-router + @preact/signals (not React), Vite.

**UX today:**
- Worker list: name, status pill (ONLINE/OFFLINE/REVOKED), type
  (audio/image/video), "Last seen: …", Rotate/Revoke buttons.
- OFFLINE rows: expandable `<details>` "Worker still OFFLINE?" with 4 tips.
- **Add Worker** (modal): name + type `<select>` (audio/image/video, default audio).
  No concept of "install profile" — only worker_type.
- After create/rotate — **CredentialDisclosure** modal
  (`PrivateWorkersSection.tsx:228`): warning, token in `<code>` (shown
  once), Copy button, **5 instruction steps**, prerequisites (3 items),
  copyable env block (4 variables) and "Done".

**Data and API** (`features/workers/privateWorkers.ts`, `PrivateWorkersSection.tsx`):

| Endpoint | Method | Location | Usage |
|---|---|---|---|
| `/api/v1/workers` | GET | `PrivateWorkersSection.tsx:40` | list (name, status, worker_type, last_seen) |
| `/api/v1/workers` | POST `{name, worker_type}` | `:55` | `worker` + one-time `token` |
| `/api/v1/workers/:id/rotate` | POST | `:73` | new one-time `token` |
| `/api/v1/workers/:id` | DELETE | `:90` | revoke |

Indirectly: `GET /api/v1/worker/counts` (GeneratePage, poll 5s; SettingsPage
WorkerSection) — aggregated counters, including `private_*`.

**Instructions generated client-side** — `buildSetupContract`
(`privateWorkers.ts:105-132`): `HUB_URL=${origin}/gpu`,
`downloadCommand: curl -o worker.cjs ${HUB_URL}/worker-source`,
`runCommand: node worker.cjs`, env block `HUB_URL / ANIMASTOR_WORKER_TOKEN /
WORKER_TYPE / WORKER_ID`. Step texts — in `i18n.ts` (RU: 124–178, EN: 646–700).

**Worker Key:** entered manually by user on GPU machine (no input fields in UI);
shown once; stored only in modal transient state,
cleared on Done/close; never reaches localStorage/URL.

**Status:** only ONLINE/OFFLINE/REVOKED + last_seen. Data loaded
once on mount; **no polling on screen** (status doesn't auto-refresh).

**Profiles/download:** no install profile selection; download — only
copy-paste `curl` command (no clickable button; i18n key
`worker_download_label` defined but unused).

---

## 2. Current Android flow

**Path:** Settings → "Private Workers" (`fragment_settings.xml:181-206`) →
`PrivateWorkersFragment.kt` (506 lines). Stack: classic Views + Fragments
(not Compose), Retrofit + Gson (`network/RetrofitClient.kt`, all endpoints in
`repository/BackendApi.kt`), base URL from `BuildConfig.BASE_URL`
(default `https://app.animastor.in/`), cookie-auth (`PersistentCookieJar`).

**UX — Web mirror** (intentional parity, comments "web parity: i18n worker_*"):
same list, Add dialog (name + type Spinner), same one-time disclosure
dialog (warning → token + Copy → 5 steps → prerequisites → env block + Copy →
Done; `PrivateWorkersFragment.kt:334-455`). Differences minimal:
- troubleshooting block always expanded inline (no title);
- dialog has no header (`worker_created_title` defined but unused);
- copy error silently ignored (`worker_copy_failed` unused);
- `PrivateWorker` model without `capabilities`; `GET /workers/:id` not called
  (`PrivateWorkerDetailResponse` model exists but unused).

**Instruction contract** — `BetaSettingsHelpers.kt:127-162`: same
`curl -o worker.cjs $hubUrl/worker-source`, `node worker.cjs`, same env block.
Test fixtures: `BetaSettingsHelpersTest.kt:154-176`
(hardcode `https://app.animastor.in/gpu/worker-source`).

**Strings:** `res/values/strings.xml:526-578` (EN) and `values-ru/strings.xml:503-555`
(RU) — keys and wording identical to Web.

**Worker Key / status / polling:** identical to Web (shown once, not
persisted, status ONLINE/OFFLINE/REVOKED + last_seen, single load on
screen open sufficient; polling only `worker/counts` in Generate/WorkerSettings).

**Conclusion:** Android flow differs from Web only in presentation. Both frontends
implement the same old model; new installer doesn't know either.

---

## 3. Current backend API

### 3.1 Private Worker management — `backend/src/routes/worker-routes.cjs`

Auth: user session + `userWorkspaceGuard` (guests — 403, workspace
always resolved server-side).

| Endpoint | Purpose | Response |
|---|---|---|
| `POST /api/v1/workers` | create worker (`name`, `worker_type: audio\|image\|video`, `mode: private\|share`) | `201 { worker: PublicWorker, token }` — **token one-time** |
| `GET /api/v1/workers` | workspace worker list | `{ workers: PublicWorker[] }` |
| `GET /api/v1/workers/:id` | one worker details | `{ worker: PublicWorker }` (not used by frontends) |
| `POST /api/v1/workers/:id/rotate` | credential rotation | `{ worker, token }` — old token dies immediately |
| `DELETE /api/v1/workers/:id` | revoke (soft delete) | `{ revoked: true }` |
| `POST /api/v1/worker/verify` | **worker-side**: credential check on startup (Bearer `wrk.…`), touches `last_seen` | `{ verified, worker_id, name, worker_type, mode, workspace_id }` |

`PublicWorker`: `{ worker_id, workspace_id, name, worker_type, capabilities,
mode, status: ONLINE|OFFLINE|REVOKED (derived), token_prefix, last_seen,
revoked_at, created_at }`. Raw PG columns `status` and `token_hash` not
exposed. Admin variant for SYSTEM-workers: `admin-routes.cjs:186-261`.

### 3.2 Status/counters — `generation-routes.cjs`

- `GET /api/v1/worker/status` — public, only liveness system/share-pool
  (private not shown), `heartbeat_ttl_sec: 30`.
- `GET /api/v1/worker/counts` — session-based, includes `private_*` fields for
  caller's own workers.

### 3.3 GPU Hub — `gpu-hub/gpu-hub.js` (proxy `/gpu`, port 5000)

Worker-facing auth: Bearer `wrk.…` against Redis mirror `animastor:worker-auth`
(fail-closed). Backend-facing: `x-api-key`.

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /gpu/beacon` | worker | heartbeat/registration: `{gpu, vram, version, image_tag, protocol_version=2}`; writes heartbeat key (TTL 30s) and GPU registry |
| `POST /gpu/task` | api-key | task dispatch by backend |
| `GET /gpu/task/next` | worker | mode-scoped pop (private → workspace queue) |
| `POST /gpu/task/result`, `/gpu/task/error` | worker, claimer only | results/errors → callback to backend |
| `GET /gpu/worker-source` | public | **only `worker.cjs`** (ro-mount `worker/worker/worker.cjs`, `docker-compose.yml:110-112`) |
| `GET /gpu/health` | public | queue depths, running, gpus |

### 3.4 Worker Key lifecycle (actual)

- Format `wrk.<worker_id_b64url>.<secret_b64url>` (32 random bytes).
- PG stores only `SHA-256(secret)` (`workers.token_hash`, UNIQUE) +
  `token_prefix` mask; plaintext returned **once** in create/rotate response.
- Redis mirror (`animastor:worker-auth`) — hot path for hub; sync on
  startup + every 5 min (`services/worker-auth.js`).
- Validation: backend `requireWorkerAuth` (timing-safe, fail-closed); hub —
  mirror + worker_id cross-check. Worker without valid token doesn't start
  (`worker.cjs:697-709`, fail-closed).

### 3.5 Installer (new) — `backend/src/installer/`

CLI-only (`bin: animastor-installer`, `backend/package.json:6-8`). Commands:
`detect`, `plan --profile P`, `install --profile P [--yes] [--dry-run]
[--mode managed|existing|shared] [--root] [--worker-dir] [--hub-url]]`,
`verify`, `resume`. Modules: `install-manifest.js` (manifest loading/validation),
`compatibility-resolver.js` (required ∪ installed →
missing/incompatible/unused/unknown; modes managed/existing/isolated/shared),
`install-plan.js` (12 steps: detect-gpu → detect-comfyui → detect-runtime →
select-profiles → resolve-dependencies → comfyui-update → custom-nodes →
models → workflows → worker-setup → worker-key → verify), `download-planner.js`,
`safety-rules.js` (NEVER_AUTOMATIC ops, redaction), `verification-report.js`
(PASS/WARN/FAIL), `workflow-artifacts.js` (editable-baseline, never
overwrites user copies), `engine/*` (execution: idempotent,
resumable, dry-run, secrets only via secretProvider).

**Manifests:** `backend/ai/install-manifests/{audio/qwen-tts, image/qwen-image,
video/ltx-2.3}.json` — all `status: "draft"`, revision `2026.08.26-r2`.
Contain: runtime requirements (comfyui/python/torch/nodejs/nvidia_driver),
dependencies (custom_node/model/model_repo/python_package with basis taxonomy),
workflows (policy `editable-baseline`, `baseline_sha256`), `worker_bundle`
(6 files, env required/secrets), verification, disk_budget
(image ≈21.2 GiB, audio ≈8.4 GiB, video ≈29.8 GiB).
**VRAM minimums unknown** (`gpu_min_vram_gb: null` in all three);
model sources mostly unresearched (`repository: null` →
installer honestly reports BLOCKED, doesn't fabricate URLs).

**No HTTP surface for installer**: profiles, manifests, install-plan,
instructions not served via API. Manifests reference
`GET {HUB_URL}/workflow/<id>` — **this endpoint doesn't exist in hub**.

### 3.6 Worker bundle (actual install contents)

`worker/worker/`: `worker.cjs` (v2.0.0, Node 20+), `worker-cleanup.cjs`,
`worker-cleanup-journal.cjs`, `package.json`/`package-lock.json` (dep:
node-fetch@3), `.env.example` (required: `HUB_URL`, `ANIMASTOR_WORKER_TOKEN`,
`WORKER_TYPE`, `WORKER_ID`). Operational scripts: `worker/start-worker.sh`
(installs Node 18 when <18 — conflicts with Node 20+ requirement of worker.cjs),
`worker/start-video.sh` (full provisioning ComfyUI v0.27.0 + torch cu124),
`worker/bootstrap-*.sh`, `worker/fix-nodes-*.sh`.

### 3.7 Workflows (delivery)

Production: workflow JSON **doesn't live on GPU machine** — backend provides
per-task template and delivers via hub in `task.params`
(`runtime/gpu-dispatcher.js`). Baseline copies on machine — installer artifact
for local editing/offline (Phase 1.5), source: repo checkout
(`backend/ai/workflows/*.json`) or (future) hub endpoint.

---

## 4. Outdated locations (old instruction inventory)

The old model "Worker → one file → Worker Key" exists in the following places:

| # | Where | What exactly | Action |
|---|---|---|---|
| 1 | `frontends/app/src/app/i18n.ts:662-668` (EN), `:134-148` (RU) | `worker_setup_step_1`: "Download worker.cjs (one self-contained file; only Node.js 20+ is required)"; `worker_source_label`: "The worker file is served by the GPU Hub: GET {0} (worker.cjs … worker/worker/worker.cjs)"; prerequisites Node 20+/ComfyUI/models | **Replace** with dynamic instructions from backend (§6.5). Don't rewrite text manually — remove truth source from frontend |
| 2 | `frontends/app/src/features/workers/privateWorkers.ts:105-132` | `buildSetupContract`: `curl -o worker.cjs …/worker-source`, `node worker.cjs`, env block | **Replace** with setup-contract API consumption; keep env block (variable names unchanged) |
| 3 | `frontends/app/src/features/workers/privateWorkers.test.ts:85-132` | Old command test fixtures | Rewrite for new contract |
| 4 | `frontends/android/.../res/values/strings.xml:542-548,553-555` and `values-ru/strings.xml:519-536` | Same 5 steps and prerequisites | **Replace** (mirror Web) |
| 5 | `frontends/android/.../ui/BetaSettingsHelpers.kt:127-162` | `buildSetupContract` (identical to web) | **Replace** |
| 6 | `frontends/android/.../test/.../BetaSettingsHelpersTest.kt:154-176` | `curl … app.animastor.in/gpu/worker-source` fixtures | Rewrite |
| 7 | `docs/architecture/EXPERIMENTAL_BETA_WORKER_SETUP.md` §2 | "The worker is a **single self-contained file**: worker.cjs" — already incorrect (worker requires cleanup/journal files + npm dep) | **Rewrite** for new model after new UX ready; until then — mark "outdated, see new setup" |
| 8 | `gpu-hub/gpu-hub.js:1047-1060` + `docker-compose.yml:110-112` | `GET /gpu/worker-source` serves only `worker.cjs` | **Expand** to full bundle (§7) — otherwise manual install still broken |
| 9 | `frontends/app/dist/assets/index-BpTKW-lQ.js` | Old prod bundle with old strings | Rebuilt on implementation (not separate action) |

What we **don't** delete and what gets replaced with dynamic info:
- env names (`HUB_URL`, `ANIMASTOR_WORKER_TOKEN`, `WORKER_TYPE`, `WORKER_ID`) —
  stable worker protocol; remain, but displayed from backend contract.
- Worker Key warning/one-time-disclosure — stays (model is correct).
- Troubleshooting hints — stay, but supplemented by installer diagnostics.
- Everything describing "which files go where" — **removed** from frontends and
  becomes installer's responsibility.

Duplication: instructions exist in **4 independent copies** (Web i18n RU/EN,
Web code constants, Android strings RU/EN, Android helpers) + docs. Target
model — single source (backend setup contract), frontends only render.

---

## 5. Proposed UX

### 5.1 Principles

1. **Frontend explains "what to do", Installer/backend handles "how".**
   User doesn't go through technical steps manually where installer
   can handle them.
2. Screen remains single: **Settings → Private Workers** (Web route and Android
   fragment unchanged), but internal flow restructured.
3. UI renders from backend metadata (§6): no per-OS hardcoded pages,
   no hardcoded versions/files/commands.

### 5.2 Target screen (both frontends)

```
Settings → Private Workers
├── My workers (existing list: status pill, type/profile, last seen)
│     row actions: Details | Rotate key | Revoke
│     + Management block (§15.7): Repair/Reinstall | Uninstall
└── [Add Worker] → Setup Wizard
      Step 1  Choose profile(s):  Image / Video / Audio   (multi-select; ≥1)
      Step 2  Installation method:
                • Managed GPU server  (E2E / RunPod / Vast / Docker / VM)
                • Existing local ComfyUI
      Step 3  Platform: Linux (installer available) / Windows (coming soon) / Docker
      Step 4  Install: one command/link to installer (from backend metadata)
      Step 5  Worker Key: create worker → show key once →
              "installer will ask for it on GPU machine" (or copy)
      Step 6  Verification: status Installing → Connecting → Online;
              instruction "return here — status will update automatically"
```

### 5.3 Scenario A — Managed GPU Server

User: clean E2E Networks / RunPod / Vast / Docker / VM instance.
- Selects profile(s) → "Managed" method → platform.
- Frontend shows **current** installer launch command (from
  `GET …/setup/installer`, §6.4): e.g.,
  `curl -fsSL https://<origin>/gpu/installer | bash -s -- --profile image/qwen-image`
  or download link + checksum. No "download file X and
  put in directory Y".
- Installer on machine: GPU detect → ComfyUI → torch/deps → nodes → models →
  workflows → worker bundle → interactive Worker Key prompt → verify.
- Frontend shows disk budget (from manifest: image ≈21 GiB, video ≈30 GiB)
  and known requirements; VRAM minimum — when added to manifests (currently
  unknown, §14 Q2).

### 5.4 Scenario B — Existing Local ComfyUI

Banner in wizard: **"Already have ComfyUI installed? Use Existing ComfyUI mode."**
- Same command, with `--mode existing` (installer detects ComfyUI, Python,
  Torch, CUDA, GPU, custom nodes, models, workflows and offers only
  missing; never auto-removes/downgrades/replaces —
  `safety-rules.js`).
- Frontend doesn't ask user to manually copy technical files:
  worker bundle placed by installer (from repo or hub, `engine/worker.js:30-74`).
- Version conflicts (ComfyUI newer/older than pin, incompatible torch) installer
  resolves via interactive prompts on GPU machine; frontend just explains
  decisions happen there, then shows verification result.

### 5.5 Worker status model (Settings)

Proposed UI states and their mapping to what backend already supports today:

| UI state | Today's source | Future source |
|---|---|---|
| **Not configured** | worker not created | — |
| **Installing** | no signal (see §14 Q5) | installer check-in endpoint (optional) |
| **Configured** | created, `last_seen == null` | + install-state |
| **Connecting** | created, no heartbeat yet | — |
| **Online** | `status == ONLINE` | + details from heartbeat payload |
| **Offline** | `status == OFFLINE`, `last_seen != null` | — |
| **Error** | no signal | worker error reporting / verification FAIL |
| **Requires attention** | no signal | verification WARN / stale version |
| Revoked | `status == REVOKED` | — |

Online details (when available): GPU/VRAM — from hub beacon payload
(`gpu, vram, version, image_tag, protocol_version`); today these fields **not
served** by user-API — small extension needed (§6.3).

Problem UX (offline/error):
```
Worker offline
Last seen: 2 h ago
[View diagnostics]  [Reinstall]  [Copy troubleshooting info]
```
Diagnostics — без secrets (token никогда; только token_prefix).

### 5.6 Error UX (installer errors)

Installer already generates human-readable resolution reports
(`compatibility-resolver.js`, `verification-report.js`). Frontend principles:
- show structured error (Required X / Detected Y) + actions
  ([Update runtime] [Keep current] [Cancel] — decisions installer already
  asks on GPU machine; frontend doesn't duplicate interactive, explains where
  it happens);
- "Missing model: …" + [Download] — only when source confirmed
  (installer BLOCKED when `repository: null` — frontend shows "source not
  yet available", not fake download);
- stack traces not shown to regular users; "Copy troubleshooting
  info" copies redacted summary (based on `SECRET_NAMES` from `safety-rules.js`).

---

## 6. Proposed backend contract

Current API is sufficient for worker management, but **insufficient** for setup
flow. Minimal additions proposed (all under same session +
`userWorkspaceGuard` as `/api/v1/workers`; guest — 403). None of
the listed to be implemented now.

### 6.1 `GET /api/v1/workers/setup/profiles`

- **Purpose:** UI-safe list of install profiles (not full internal manifest).
- **Request:** query `?type=image|video|audio` (optional).
- **Response:**
  ```jsonc
  { "profiles": [{
      "id": "image/qwen-image", "worker_type": "image",
      "display_name": "Qwen Image", "description": "…",
      "status": "draft",                    // draft | stable
      "disk_budget_bytes_approx": 22780911288,
      "gpu_min_vram_gb": null,              // currently unknown — frontend shows "unknown"
      "workflows": [{ "id": "workflow:img-qwen-image", "display_name": "…" }],
      "modes": ["managed", "existing", "shared"],
      "dependencies_summary": { "models": 4, "custom_nodes": 1, "approx_bytes": … }
  }] }
  ```
- **Auth:** user session. **Sensitive fields:** none (internal model source URLs,
  checksums, repo paths — NOT exposed).
- **Source:** `install-manifest.loadAllManifests()` + projection.
- **Web:** wizard Step 1. **Android:** same.

### 6.2 `GET /api/v1/workers/setup/methods`

- **Purpose:** available installation methods/platforms (§15) — foundation
  for platform-agnostic UI.
- **Response:**
  ```jsonc
  { "methods": [
    { "platform": "linux", "arch": "x86_64",
      "installer":  { "available": true,  "version": "1.2.0", "channel": "…" },
      "uninstaller":{ "available": true,  "version": "1.0.1" },
      "supported_profiles": ["image/qwen-image","audio/qwen-tts","video/ltx-2.3"],
      "minimum_requirements": { "node": "20", "os": "Ubuntu 22.04+" } },
    { "platform": "windows", "installer": { "available": false, "status": "planned" }, … },
    { "platform": "docker",  "installer": { "available": false, "status": "planned" }, … }
  ] }
  ```
- **Auth:** user session. **Sensitive:** none.
- **Web/Android:** wizard Step 2–3, availability badges (§15.8).

### 6.3 `GET /api/v1/workers/:id/status` (extension of existing `GET /:id`)

- **Purpose:** details for Online card and diagnostics.
- **Response (добавить к PublicWorker):**
  ```jsonc
  { "worker": { …, "details": {
      "gpu": "NVIDIA L40S", "vram_gb": 46, "worker_version": "2.0.0",
      "protocol_version": 2, "current_job": true|false, "image_tag": "…" } } }
  ```
  (from hub heartbeat payload; no heartbeat — `details: null`).
- **Sensitive:** no tokens; `token_prefix` already served.
- **Web:** worker details/diagnostics. **Android:** same.

### 6.4 `GET /api/v1/workers/setup/installer`

- **Purpose:** installer/uninstaller metadata + download (single distribution
  point, §7). Query: `?platform=linux&arch=x86_64&profile=…`.
- **Response:**
  ```jsonc
  { "platform": "linux",
    "installer": { "version": "1.2.0",
      "command": "curl -fsSL https://<origin>/gpu/installer.sh | bash",
      "download_url": "https://<origin>/gpu/installer/animastor-installer-1.2.0.tar.gz",
      "sha256": "…", "release_notes": "…" },
    "uninstaller": { "version": "1.0.1", "download_url": "…", "sha256": "…" },
    "worker_bundle": { "version": "2.0.0",
      "download_url": "https://<origin>/gpu/worker-bundle",   // full bundle, §7
      "files": ["worker.cjs","worker-cleanup.cjs","worker-cleanup-journal.cjs",
                 "package.json","package-lock.json",".env.example"] } }
  ```
- **Auth:** user session for metadata; artifacts may be public
  (like current `/gpu/worker-source`) — decision in §7.
- **Sensitive:** none. **Web:** wizard Step 4 + Management block.
  **Android:** copy command / open link.

### 6.5 `GET /api/v1/workers/setup/instructions`

- **Purpose:** server-side instruction assembly (single truth source instead of 4
  copies in frontends). Query: `?profile=…&platform=…&mode=managed|existing`.
- **Response:** structured steps (title, body, code blocks, links) —
  same 6 wizard steps, but generated from manifests + installer metadata.
- **Auth:** user session. **Sensitive:** instructions don't contain token
  (placeholder `ANIMASTOR_WORKER_TOKEN=<your-worker-key>`).
- **Web/Android:** render steps; when endpoint unavailable — fallback to
  current local contract (migration, §11).

### 6.6 Hub additions (`gpu-hub/gpu-hub.js`)

| Endpoint | Purpose | Status |
|---|---|---|
| `GET /gpu/worker-bundle` (or `/worker-source` extension) | full 6-file bundle (tar.gz or per-file) | **needed** — current single-file broken |
| `GET /gpu/workflow/:id` | baseline workflow download | **needed** — manifests already reference, endpoint missing |
| `GET /gpu/installer.sh`, `GET /gpu/installer/<artifact>` | installer distribution | **needed** (§7) |

### 6.7 What doesn't change

`POST /workers`, `POST /:id/rotate`, `DELETE /:id`, `POST /worker/verify`,
worker protocol (`protocol_version=2`), hub task pipeline, dispatch logic.
Worker Key lifecycle (§9) stays as is — already correct.

---

## 7. Installer distribution model

**Recommended option: versioned backend/hub endpoint (Variant C from current
repo) + single self-contained installer package.**

Comparison:

| Model | Pros | Cons | Verdict |
|---|---|---|---|
| GitHub release | ready infrastructure, versions | public repo = public artifacts; frontend must know repo; no per-deployment control | fallback/mirror |
| Official download endpoint (hub) | single origin with HUB_URL; precedent `/gpu/worker-source` exists | need to store/mount artifacts | **yes — for artifacts** |
| Versioned backend endpoint | frontend gets latest compatible version, no hardcoding | — | **yes — for metadata** |
| Container command | good for Docker scenario | narrow scenario | later, as separate method |
| `curl \| bash` script | single command, familiar to GPU audience | needs careful signing/checksum | **yes — as wrapper**, with checksum in UI |

Target chain (matches "frontend doesn't hardcode version" requirement):

```
GET /api/v1/workers/setup/installer   →  latest compatible version
        ↓
download_url / command + sha256       →  frontend показывает/копирует
        ↓
installer package (self-contained)    →  сам содержит/получает:
                                          manifests, worker bundle, workflow baselines
```

**Worker files — recommended option A**: single installer package that itself
contains/obtains necessary components. Installer already does this
(`engine/worker.js`: bundle from repo or `GET /gpu/worker-source`;
`engine/workflows.js`: baselines from repo or hub endpoint). User shouldn't
need to figure out which of six files goes where.
Manual fallback (until installer E2E accepted) — `GET /gpu/worker-bundle`
(full archive), but UI primarily guides user to installer.

**Open:** installer packaging (currently `backend/src/installer/` as
part of backend repo — distribution requires either tarball build or
single-file bundle; see §14 Q1).

---

## 8. Web/Android parity model

```
                Backend
                   │
        Installer/Worker Setup API (§6)
             /           \
          Web           Android
```

- Both frontends consume **same** §6 endpoints: profiles, methods,
  installer metadata, instructions, worker status.
- Presentation differs only: Web — wizard in page; Android —
  dialog fragment + copy-to-clipboard + external links (Android **doesn't run**
  installer locally, §14).
- Parity rules (already followed, preserve): same keys/texts
  (i18n.ts ↔ strings.xml), same validation (`validateCreateInput` ↔
  `BetaSettingsHelpers`), one-time disclosure, no key persistence.
- Contract helpers (`buildSetupContract` in both frontends) replaced with shared
  API client; parity tests (`privateWorkers.test.ts` ↔
  `BetaSettingsHelpersTest.kt`) rewritten on shared §6 response fixture.
- `ANDROID_WEB_PARITY.md` currently doesn't cover Private Workers —
  supplement section after implementation.

---

## 9. Worker Key flow

Current lifecycle **correct and preserved**:

| Question | Answer (current + proposed) |
|---|---|
| Where created | Backend, `POST /api/v1/workers` (server-generated `wrk.…`) |
| Where stored | PG: only `SHA-256(secret)`; Redis mirror for hub hot path. Plaintext — nowhere after issuance |
| When shown | Once: create/rotate response → Web modal / Android dialog |
| Who passes to Installer | **User**: installer prompts interactively (hidden input, `cli.js:123-152`); not via argv/URL |
| Manual entry | Yes, on GPU machine (installer prompt). No key input fields in frontends — and shouldn't be |
| How to prevent logs | Installer: `safety-rules.js` SECRET_NAMES + redaction; `.env` chmod 600; merge semantics (existing valid token untouched); frontends: transient state only, no localStorage/URL/analytics |
| How to know worker registered | Installer: `verifyRegistration` → `POST /api/v1/worker/verify`; UI: статус OFFLINE → ONLINE в течение ~30 с (heartbeat TTL). Wizard Step 6 явно говорит «вернитесь — статус обновится» |

Дополнительно для новой UX:
- Wizard показывает key **рядом с командой installer'а** и объясняет: «installer
  запросит этот ключ на сервере; вставьте его там» (+ кнопка Copy).
- Env-блок с токеном (как сегодня) остаётся доступным для ручного сценария, но
  не является основным путём.
- Rotate: подтверждение → новый key показывается один раз → инструкция
  «перезапустите worker / installer обновит .env при rerun» (merge-семантика
  installer'а не затирает токен автоматически — пользователь обновляет сам).

---

## 10. Workflow flow

Workflow — first-class artifact (Phase 1.5, policy `editable-baseline`).

UI-модель:
```
Profile (wizard Step 1)
   ↓
Available workflows          (из setup/profiles: workflow ids + display names)
   ↓
Download baseline workflow   (GET /gpu/workflow/:id — когда появится;
                              сегодня — только repo checkout, installer делает сам)
```

Сообщения пользователю (ключевые формулировки):
- «Это официальный Animastor baseline workflow. Его можно открыть и изменить
  в ComfyUI.» — baseline является отправной точкой, не тюрьмой.
- «В production workflow доставляется сервером per-task — локальная копия
  нужна только для редактирования/отладки.» (факт: worker получает workflow в
  `task.params`, `gpu-dispatcher.js`).
- Installer никогда не перезаписывает изменённые пользователем копии
  (`workflow-artifacts.js`: fresh copy → отдельный путь
  `*.animastor-baseline.json`).

Frontend не даёт редактировать workflow в Settings — только скачать/открыть
ссылку; редактирование происходит в ComfyUI.

---

## 11. Migration plan (old → new)

```
old:  one worker file + worker key
new:  profile + installer + (ComfyUI/deps/models/workflow) + worker + key + verification
```

Фазы (старую инструкцию НЕ удалять до готовности новой):

1. **Backend groundwork** (отдельная задача):
   - endpoints §6.1–6.5 (read-only, на базе существующих манифестов);
   - hub: `/gpu/worker-bundle` (чинит сломанный single-file download — можно
     сделать первым, независимо от фронтов);
   - packaging installer'а (§7); `GET /gpu/workflow/:id`.
2. **Web** (приоритет 1): wizard в `/settings/private-workers`; список workers
   без изменений; старые i18n-строки помечаются deprecated, но остаются
   fallback'ом при недоступности setup API.
3. **Android** (приоритет 2): тот же wizard на Fragments; parity-тесты.
4. **Docs**: переписать `EXPERIMENTAL_BETA_WORKER_SETUP.md` под новую модель;
   обновить `ANDROID_WEB_PARITY.md`.
5. **Cleanup** (только после принятия новой UX): удалить старые строки
   §4 #1–#6, удалить/заменить §4 #7, сузить `/gpu/worker-source` до
   deprecated-alias'а `/gpu/worker-bundle`.

Гейты: installer E2E на реальном GPU ещё **не принят**
(`private-worker-installer-e2e-acceptance.md`: нет GPU на dev-хосте) — до
принятия UI обязан показывать `status: "draft"` профилей и сохранять ручной
fallback. Манифесты draft → stable только после подтверждённого research
(checksum'ы/URL'ы моделей) и golden run.

---

## 12. Security considerations

| Секрет/канал | Правило |
|---|---|
| **Worker Key** (`wrk.…`) | Показывается один раз (create/rotate). Не в URL, не в query, не в argv installer'а (hidden prompt). PG: только SHA-256. Фронты: transient state, никакого localStorage/sessionStorage/IndexedDB/analytics. Crash reports: redaction по `SECRET_NAMES`. Clipboard: допустим (основной перенос на GPU-машину), но clip-метки нейтральны (`animastor-worker-token`), автоочистка не обязательна — ключ одноразово показан и ротируем |
| **Installer credentials** | Installer аутентифицируется только Worker Key'ом при `verify`; никаких отдельных installer-секретов не вводить. Download артефактов — публичный HTTPS + sha256 в UI (целостность), подпись — будущее улучшение |
| **Hugging Face / ModelScope tokens** | Вводятся **только на GPU-машине** (installer prompt, как `HF_TOKEN`); фронты никогда не запрашивают и не передают их; в download-planner'е токены — только headers (`engine/downloader.js`) |
| **Logs** | Backend: token не логируется (существующее правило). Installer: `registerSecret` + redaction. Фронты: не логировать содержимое token/env-блока (сегодня не логируют — сохранить; при добавлении error-tracking — mask `wrk.*` целиком) |
| **Analytics** | Запрещено отправлять token, env-блок, содержимое `.env` в любую аналитику; события wizard'а — только без параметров-секретов (profile id, platform, mode — можно) |
| **Deep links** | `https://app.animastor.in/settings/private-workers?...` допустимы только с несекретными параметрами (`?profile=image/qwen-image`); token в deep link — запрещён |
| **Setup API** | §6 — только сессия + workspace guard; setup/metadata не содержит секретов; `instructions` содержит token-placeholder, не значение |
| **Worker bundle download** | Публичный (как сегодня `/gpu/worker-source`) — в bundle нет секретов; `.env.example` — только имена переменных |

---

## 13. Файлы, которые потребуется изменить (реализация — отдельная задача)

**Backend (новые endpoints + дистрибуция):**
- `backend/src/routes/worker-routes.cjs` — setup endpoints §6.1–6.5 (или новый `worker-setup-routes.cjs`)
- `backend/src/installer/` — projection манифестов в UI-safe вид; packaging-скрипт (tarball/single-file)
- `gpu-hub/gpu-hub.js` — `/gpu/worker-bundle`, `/gpu/workflow/:id`, `/gpu/installer*`
- `docker-compose.yml` — mounts для bundle/артефактов (сейчас только `worker.cjs:110-112`)
- `backend/src/storage/postgres/repositories/worker-repo.js` — при расширении status-деталей (heartbeat read)

**Web:**
- `frontends/app/src/features/workers/PrivateWorkersSection.tsx` — wizard, management block, status details
- `frontends/app/src/features/workers/privateWorkers.ts` — замена `buildSetupContract` на API-клиент; типы
- `frontends/app/src/features/workers/privateWorkers.test.ts` — новые фикстуры
- `frontends/app/src/app/i18n.ts` — RU/EN блоки worker_* (замена старых шагов)
- `frontends/app/src/api/models.ts`, `src/api/client.ts` — типы/вызовы §6
- новые компоненты wizard'а в `features/workers/` (по реализации)

**Android:**
- `frontends/android/app/src/main/java/com/example/animastor/ui/PrivateWorkersFragment.kt` — wizard/management
- `.../ui/BetaSettingsHelpers.kt` — замена `buildSetupContract`
- `.../ui/BetaSettingsHelpersTest.kt` (test) — новые фикстуры
- `.../repository/BackendApi.kt`, `.../repository/PrivateWorkerModels.kt` — endpoints §6
- `res/values/strings.xml`, `res/values-ru/strings.xml` — worker_* строки
- возможно новый Fragment для wizard'а + layout XML

**Docs:**
- `docs/architecture/EXPERIMENTAL_BETA_WORKER_SETUP.md` — переписать
- `ANDROID_WEB_PARITY.md` — раздел Private Workers setup

---

## 14. Открытые вопросы

1. **Packaging installer'а.** Сегодня это модуль backend-репо
   (`backend/src/installer/`, bin `animastor-installer`). Нужен артефакт для
   GPU-машин: tarball? single-file bundle? npm-пакет? Кто и когда его собирает
   (CI/release)? От этого зависит §6.4 и §7.
2. **VRAM-минимумы неизвестны** (`gpu_min_vram_gb: null` во всех манифестах,
   open question 12 архитектуры). UI пока может показывать только «verified
   reference: L40S 46 GB» — приемлемо ли на старте?
3. **Model sources не исследованы** (большинство записей `repository: null`,
   verification unknown) → installer BLOCKED по моделям. Frontend должен
   честно показывать draft-статус. Когда research завершится?
4. **Node 18 vs 20**: `start-worker.sh` ставит Node 18, `worker.cjs` требует
   20+ (open question 11 архитектуры). Инструкции должны давать одну версию.
5. **Сигнал «Installing».** Сегодня backend не знает, что installer запущен.
   Нужен ли check-in endpoint (`POST /worker/install-state`)? Это изменение
   installer'а (не worker protocol) — отложить или включить в backend-фазу?
6. **Multi-profile.** `worker_type` у worker'а один; wizard допускает выбор
   нескольких профилей. Модель: один worker = один профиль (N workers), или
   multi-profile worker (требует worker protocol изменений — вне scope)?
   Рекомендуется: один worker на профиль; shared-режим — один ComfyUI, несколько
   worker-процессов (open question 4 архитектуры).
7. **`/gpu/worker-source`**: расширить in-place (breaking для старых команд?)
   или добавить `/gpu/worker-bundle` рядом (рекомендуется)?
8. **Windows installer format** (.bat / PowerShell / .exe / packaged) —
   отложен; сейчас только `installer.available=false, status=planned` (§15.4).
9. **Uninstaller** не существует — нужен отдельный дизайн (ownership-модель
   §15.6) до того, как UI пообещает кнопку Uninstall.
10. **E2E acceptance** installer'а заблокирован (нет GPU на dev-хосте) —
    гейт для stable-статуса профилей и для удаления старой инструкции.
11. **ComfyUI pin-конфликт профилей** (v0.27.0 vs форк c4cfee7a) — влияет на
    shared-режим и на то, что wizard покажет при выборе нескольких профилей.
12. **Instructions: серверная сборка vs клиентская.** §6.5 предлагает серверную;
    альтернатива — фронты собирают шаги из §6.1/6.4 (меньше endpoint'ов, но
    больше дублирования). Решение при реализации.

---

## 15. Platform & Installation Lifecycle (дополнение)

### 15.1 Принцип: frontend не привязан к Linux

Новый installer реализован для Linux, но архитектура frontend'а **не** должна
содержать предположение «Private Worker = Linux Installer». Вводится сущность
**Installation Method** (platform + lifecycle artifacts), отдаваемая через
`GET /api/v1/workers/setup/methods` (§6.2):

```jsonc
{ "platform": "linux",   "installer": { "available": true,  "version": "…" },
                          "uninstaller": { "available": true, "version": "…" } }
{ "platform": "windows", "installer": { "available": false, "status": "planned" },
                          "uninstaller": { "available": false, "status": "planned" } }
{ "platform": "docker",  "installer": { "available": false, "status": "planned" },
                          "uninstaller": { "available": false, "status": "planned" } }
```

Точные значения `platform` — `linux | windows | docker` (docker покрывает
container/VM-сценарии managed-серверов; при необходимости позже выделить
`cloud` отдельно).

### 15.2 Installer metadata contract (минимальный безопасный)

Поля (§6.4 — надмножество): `platform, arch, installer{available, version,
download_url|command, sha256, release_notes}, uninstaller{…то же…},
supported_profiles[], minimum_requirements{}`. Полный набор
(signature, отдельные checksum-манифесты, auto-update channel) — не нужен
сейчас; схема расширяема. `sha256` — обязателен с первого релиза;
`signature` — будущее улучшение.

### 15.3 Linux

- **Linux Installer** — существует (Phase 2.1, тесты passing; E2E на железе —
  blocked, §14 Q10). UI: `installer.available=true` только после E2E-принятия;
  до этого — `available=true, status=draft` с предупреждением.
- **Linux Uninstaller** — самостоятельный lifecycle artifact, **не** существует
  сегодня. Не предполагать `reinstall = uninstall + install`: это разные
  операции (reinstall/repair = идемпотентный rerun installer'а — уже
  поддерживается engine'ом через resume/idempotency; uninstall = отдельный
  артефакт со своей логикой и версией).

### 15.4 Windows

Не реализуется сейчас. Архитектурная возможность заложена: frontend получает
`platform=windows, installer.available=false|true` и рендерит соответствующий
блок («coming soon» / команду). Формат (.bat / PowerShell / .exe / packaged)
выбирается позже; рекомендация на сегодня — PowerShell-скрипт как ближайший
аналог linux-обёртки, packaged installer как целевой. В contracts ничего
windows-специфичного не добавлять.

### 15.5 Операции lifecycle в UX

Отдельные операции, не спрятанные в troubleshooting:

```
Private Worker
  Status: Online
  [Worker details]
  Management
  ├── Reinstall / Repair     (rerun installer'а; идемпотентно, resume)
  └── Uninstall Worker       (отдельный uninstaller-артефакт)
```

Расположение: Settings → Private Workers → строка worker'а → Management
(Web: row actions/details; Android: row menu). Install — в wizard'е;
Repair/Uninstall — у существующего worker'а.

### 15.6 Uninstall safety (ownership model)

Uninstaller различает:

| Класс | Примеры | Действие |
|---|---|---|
| **Animastor-managed** | Animastor Worker (bundle), Animastor-generated config (`.env`-ключи installer'а), installer state (`.animastor-installer/`), Animastor-specific services, Animastor-managed deps (если безопасно и установлено installer'ом) | можно удалить |
| **User-owned** | пользовательский ComfyUI, workflows, models, custom nodes, python-окружения | **никогда** автоматически |

UX (обязательное подтверждение):
```
Remove Animastor Worker?
This will not remove your ComfyUI, models, custom nodes or workflows.
[Uninstall]  [Cancel]
```
Особенно для **Existing ComfyUI**: удаляется только Animastor-managed
компоненты; пользовательское окружение не трогается. Для **Managed**
installer владеет большим набором компонентов — uninstall может предложить
удалить и установленные им модели/ноды, но только явным отдельным
подтверждением (по логике `safety-rules.js`: delete_model/delete_custom_node —
NEVER_AUTOMATIC).

### 15.7 Managed vs Existing uninstall

- **Managed:** installer владеет ComfyUI/deps/models → uninstall может удалить
  всё им установленное (по явному выбору), worker bundle и state — всегда.
- **Existing:** пользователь владел ComfyUI до installer'а → uninstall удаляет
  **только** Animastor-managed компоненты (worker bundle, .env-ключи
  Animastor, baseline-копии workflows, созданные installer'ом; модели/ноды —
  только если пользователь явно отметил их как установленные installer'ом).

### 15.8 Frontend UI, управляемый metadata

UI автоматически меняется от `platform × installation status × installer
availability × uninstaller availability × worker status`:

```
Linux     ✓ Installer available   ✓ Uninstaller available
Windows   ! Installer coming soon
Windows   ✓ Installer available   ✓ Uninstaller available   (будущее)
```

Никаких отдельных захардкоженных страниц под ОС: один wizard/management,
данные — из §6.2/§6.4; недоступный артефакт → disabled-блок с пояснением.

### 15.9 Android lifecycle parity

Android имеет ту же lifecycle-модель (Install / Repair / Uninstall / Status /
Diagnostics), но **не запускает installer локально**. Android предоставляет:
download link, инструкцию, copy command, open external link, worker status,
uninstall instructions/action (команда/ссылка на uninstaller-артефакт).
Web и Android используют один backend metadata contract (§6.2, §6.4).

### 15.10 Versioning

Installer и Uninstaller версионируются **независимо**:

```
Linux Installer 1.2.0      Linux Uninstaller 1.0.1
Windows Installer 1.0.0    Windows Uninstaller 1.0.0   (будущее)
```

Frontend получает актуальные версии из backend/release metadata (§6.2/§6.4) и
никогда не хранит их hardcoded. Worker bundle version — отдельно
(`worker_bundle.version`, сегодня v2.0.0; `min_version` в манифестах).

### 15.11 Future-proof model

```
Private Worker
      ↓
Installation Manager        (setup API §6, wizard, management block)
      ↓
Platform                    (linux | windows | docker — из setup/methods)
      ↓
Installation Artifact
      ├── Installer         (versioned, per-platform)
      └── Uninstaller       (versioned, per-platform, independent)
```

— а не `Private Worker → Linux Installer`. Добавление Windows/Docker позже =
новая запись в `setup/methods`, без переписывания Private Worker UI.

---

## 16. Phase 3 Implementation (Backend Setup Contract) — реализовано 2026-08-27

Единый backend contract для Web и Android реализован как дополнительный слой
поверх существующего Worker API (без breaking changes; UI не менялся).
Полные схемы ответов, auth/security, artifact/worker-bundle модели и план
миграции с `/gpu/worker-source` — в
`docs/04-planning/private-worker-setup-contract-api.md`.

### 16.1 Endpoints

| Endpoint | Назначение |
|---|---|
| `GET /api/v1/private-worker/setup/profiles` | UI-safe профили из canonical installer манифестов (`?type=`) |
| `GET /api/v1/private-worker/setup/methods` | platforms × installer/uninstaller/worker_bundle metadata |
| `GET /api/v1/private-worker/setup/artifacts` | артефакты одной platform (`?platform=`, неизвестная → 404) |
| `GET /api/v1/private-worker/setup/workflows` | baseline workflows: sha256, `editable: true`, download_url |
| `GET /api/v1/private-worker/setup/instructions` | динамическая инструкция (`?profile_id=&platform=&mode=`) |
| `GET /api/v1/private-worker/setup/workers/:id` | расширенный UI-safe статус (adapter) + normalized capabilities |
| `POST /api/v1/private-worker/setup/plan` | UI-safe installation plan (preview; никогда не исполняется) |
| `GET /gpu/worker-bundle` (+`/sha256`) | полный worker bundle tar.gz (Worker Key НЕ внутри) |
| `GET /gpu/workflow/:id` | baseline workflow (allowlist из манифестов; `old_*.json` не отдаются) |
| `GET /gpu/installer` (+`/sha256`) | self-contained installer package tar.gz |
| `GET /gpu/worker-source` | **DEPRECATED** — работает, помечен `Deprecation: true` + `Link` |

### 16.2 Ключевые решения реализации

- **Проекции, а не манифесты:** `backend/src/installer/setup-contract.js` —
  единственный выход манифестов наружу; сырые манифесты, source URL'ы моделей,
  provenance, resolver-детали не покидают backend.
- **Честность вместо выдумок:** VRAM unknown → `null`; uninstaller не
  существует → `available:false, status:"planned"` (schema готова к
  `available:true` без изменения фронтов); неисследованные источники моделей
  → plan `BLOCKED` c `MODEL_SOURCE_NOT_PUBLISHED`; Windows/Docker →
  `PLATFORM_NOT_SUPPORTED`.
- **Installer artifact реален:** hub собирает self-contained пакет
  (`src/installer/**` + `ai/install-manifests/**` + generated package.json)
  детерминированным pure-JS ustar-райтером (`gpu-hub/tarball.js`); версия
  `1.0.0`, статус `draft` (E2E на железе не принят), sha256 публикуется и
  резолвится backend'ом server-side.
- **Worker bundle:** tar.gz из 6 файлов; `.env*` (кроме `.env.example`)
  исключены фильтром hub'а; токен — только через существующий one-time
  disclosure + installer hidden prompt. Single-file `/gpu/worker-source`
  помечен deprecated (не удалён).
- **Статус worker'а:** adapter поверх существующей derivation —
  ONLINE/OFFLINE/REVOKED не ломаются; создан и ни разу не виделся →
  `CONNECTING`; `NOT_CONFIGURED/INSTALLING/ERROR` задокументированы как
  состояния фронта/будущих сигналов. `base_status` отдаётся рядом.
- **Sharing:** реальные verdict'ы resolver'а — audio+image ⇒
  `SHARED_COMPATIBLE`, image+video ⇒ `REQUIRES_ISOLATION` (разные ComfyUI
  commit'ы reference-окружений); multi-ComfyUI orchestration не реализуется.
- **Instructions** собираются сервером (решение §14 Q12 — серверная сборка):
  фронтам не хардкодить ни команд, ни версий; токен только placeholder'ом.
- **Security:** все endpoints под сессией зарегистрированного пользователя +
  workspace guard; чужой worker → неразличимый 404; download URL'ы — только
  backend-авторизованные origin-relative константы; тесты на отсутствие
  token/token_hash/секретов во всех ответах.

### 16.3 Покрытие тестами (все passing)

- `backend/tests/worker-setup-api.test.js` — API: auth/isolation, profiles,
  platforms, artifacts+checksum, workflows, instructions, worker status,
  security sweep, plan (image/video/audio, managed/existing/shared/isolated,
  SHARED_COMPATIBLE/REQUIRES_ISOLATION), legacy API intact;
- `backend/tests/installer-setup-contract.test.js` — проекции: hidden
  profiles не отдаются, planned-платформы, editable workflows, token
  placeholder, status adapter, capabilities, plan-семантика, hub outage →
  sha256 null;
- `backend/tests/gpu-hub-artifacts.test.js` — bundle состав/детерминизм/
  `.env`-исключение, workflow allowlist + traversal, installer package,
  sha256 integrity, deprecated worker-source работает.
- Полный backend suite: 1705 тестов passing.

### 16.4 Открытые blockers (унаследованы, не блокируют UI-фазы)

1. Linux uninstaller не существует (нужен отдельный ownership-design, §15.6)
   — в контракте `planned`.
2. Model sources не исследованы (D5) → plan честно BLOCKED по моделям.
3. E2E installer'а на реальном GPU не принят → installer `status: draft`.
4. VRAM-минимумы неизвестны → `gpu.min_vram_gb: null`.
5. `details` (GPU/VRAM online-детали) требуют расширения heartbeat payload
   hub'а — в контракте пока `null`.

---

### Связанные документы

- `docs/04-planning/private-worker-setup-contract-api.md` — **Phase 3 API reference (реализовано)**
- `docs/04-planning/private-worker-installer-architecture.md`
- `docs/04-planning/private-worker-installer-phase15.md`
- `docs/04-planning/private-worker-installer-manifest-resolver.md`
- `docs/04-planning/private-worker-installer-e2e-acceptance.md`
- `docs/architecture/EXPERIMENTAL_BETA_WORKER_SETUP.md` (к переписыванию, §11)
- `docs/architecture/LINUX_INSTALLER_RECONNAISSANCE.md`
- `docs/04-planning/RunPod_Integration_GPU_Hub.md` (managed-сценарии)
- `ANDROID_WEB_PARITY.md`
