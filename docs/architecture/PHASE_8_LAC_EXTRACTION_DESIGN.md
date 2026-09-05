# PHASE 8 — LAC Extraction Design Audit

**Status:** design only. Nothing was extracted or moved. No production
code, Phase 1–7 guards, or existing tests were changed. No new guards
created.
**Date:** 2026-09-05
**Baseline:** HEAD `c1c0fb1d` (Phase 8 reconnaissance confirmed Local AI
Connector as the top extraction candidate, risk LOW).
**Inputs:** full source read of `local-ai-connector/` (index.cjs + 5 lib
files, 1085 LOC), `package.json`, README, backend WS route
(`routes/ai-connector-routes.cjs`), backend transport mirrors
(`services/ai-connector/transport.js`), the LAC v1 planning spec
(`docs/04-planning/local-ai-connector-v1.md`, 1130 lines), all repo-side
references (tests, guards, scripts, frontends).

**Purpose:** a detailed design audit of the future extraction of
`local-ai-connector/` into a standalone product/package — BEFORE anything
is moved.

---

## 1. Current structure (measured)

```
local-ai-connector/
├── index.cjs                       CLI entrypoint (68 LOC) — parse config,
│                                   create session, SIGINT/SIGTERM shutdown,
│                                   print llmc.* credential EXACTLY ONCE
├── lib/config.cjs                  strict fail-closed CLI parsing (133 LOC)
├── lib/connector.cjs               WS session state machine (610 LOC)
├── lib/chat.cjs                    chat.request validation + LIMITS (231 LOC)
├── lib/log.cjs                     metadata-only ring buffer (43 LOC)
├── lib/runtime-adapters/index.cjs  adapter registry / allowlist (55 LOC)
├── lib/runtime-adapters/openai-compatible.cjs  the one V1 adapter (839 LOC)
├── package.json                    animastor-ai-connector 0.1.0, dep: ws only
├── package-lock.json
└── README.md                       run instructions, options, security posture
```

- **Dependencies:** `ws@^8.21.3` only (runtime); node builtins elsewhere.
  Global `fetch` is used (node >= 18, matching `engines`).
- **Entrypoints:** `bin.animastor-ai-connector → index.cjs` + `main` +
  direct `node index.cjs`. `module.exports = { main }` (double duty).
- **Public API today (de facto):** the CLI flags `--url --token --base-url
  --runtime-type --allow-lan --log-file --heartbeat-interval-ms` + env
  fallbacks `ANIMASTOR_CONNECTOR_URL`, `ANIMASTOR_CONNECTOR_TOKEN`.
- **Internal API (NOT public by intent):** `createConnectorSession`,
  `parseConfig`, `validateChatRequest`, `LIMITS`, opLog — consumed today by
  backend unit tests via direct require (test-time coupling, not a
  contract).
- **Test seams inside the session:** `_handleMessage`, `_sendHeartbeat`,
  injectable `WebSocketImpl`, `hooks.onReady/onModelsList/onCredential` —
  deliberately NOT part of any user-facing surface.
- **Runtime assumptions:** node >= 18 (global fetch, AbortController); an
  OpenAI-compatible local runtime reachable at the (loopback by default)
  base URL; outbound-only WS to the Animastor endpoint. No inbound ports,
  no filesystem persistence (in-memory log), no config files (flags/env
  only).

## 2. The real public boundary of the future product

**Inside the LAC package:**
- the CLI surface (flags + env fallbacks + exit codes: 0 ok, 2 config
  error);
- the LAC v1 WS client implementation — everything in `lib/`;
- the runtime-adapter allowlist (adding a runtime = adding an adapter
  entry; the cloud-side `RUNTIME_TYPES` list is mirrored in
  `runtime-adapters/index.cjs` — that mirror is part of the contract).

**Host/backend-owned (NOT in the package):**
- the WS endpoint `/api/v1/ai-connector/ws` and its route handlers;
- registration token issuance, `llmc.*` credential minting, revocation;
- Redis liveness mirror, shared-pool slots, PG `ai_connectors` storage;
- the UI copy-paste command builder (`frontends/app/src/features/localAi/
  localAi.ts:218`, android `LocalAiHelpers.kt:104`).

**Official public API of the product (only two things):**
1. the CLI (`npx animastor-ai-connector …` with the documented flags);
2. the LAC v1 wire protocol (frames below).

**Accidentally public today, must NOT stay public:**
- `lib/chat.cjs LIMITS`, `createConnectorSession`, `validateChatRequest`,
  `opLog` — required directly by 11 backend test files. After extraction
  these become package-internal; the backend keeps only the mirrored
  numbers as a **contract test against the published spec**, not against
  the package internals.

## 3. Standalone package design (proposal)

- **Name:** `animastor-ai-connector` — CONFIRMED. The name is already a
  runtime contract: both frontends display `npx animastor-ai-connector …`
  to users (web + Android + i18n). Renaming means changing product UI on
  two platforms. Also: an unpublished npm name is squatting territory —
  reserving it early is a security task, not cosmetics.
- **Versioning:** package semver (independent) + wire `protocol_version`
  (currently 1, exchanged in `hello`, rejected fail-closed with
  `protocol_version_unsupported` at `ai-connector-routes.cjs:178`). The
  two are deliberately separate: a package v1.4.2 can speak protocol v1.
- **Metadata to add (Phase B):** `version: 1.0.0`, LICENSE (currently
  UNLICENSED — legal decision required), CHANGELOG.md, self-contained
  README (current one references `docs/04-planning/local-ai-connector-v1.md`
  which stays in the monorepo — the package README must inline what users
  need), `files` allowlist for publish.
- **Directory model:** unchanged — the current layout is already the
  package layout (`index.cjs` + `lib/`). Phase C is a `git mv` of the
  directory, not a restructure.
- **Build/run/install model:** zero-build (plain CJS, no transpile).
  Install = `npm i -g` or `npx`. No postinstall scripts (security posture).
- **Distribution:** **public npm registry** — the only model under which
  the UI-promised `npx animastor-ai-connector` actually works for
  end users. Private registry/GitHub-releases only make sense if the
  product pivots to non-public distribution (then the UI command must
  change too — a bigger decision than the extraction itself).

## 4. LAC v1 protocol contract (to be published as the spec — Phase A)

**Frames (C→S / S→C):**

| Frame | Direction | Fields | Notes |
|---|---|---|---|
| `hello` | C→S | `protocol_version` (1), `credential` XOR `reg_token` | activation path exchanges `llmcreg.*` → minted `llmc.*` |
| `ready` | S→C | `connector_id`, `heartbeat_interval_ms`, `server_time`, `credential` (activation only) | credential disclosed exactly once, printed by CLI, never logged |
| `heartbeat` | C→S | `runtime{type}`, `models[]` (omitted pre-first-discovery), `runtime_ok` | honesty rules: facts only from real observations |
| `models.refresh` | S→C | `{}` | only `type` is read; any URL-ish fields ignored (AD-5) |
| `models.list` | C→S | `models[]`, `error_code?` | reply to refresh only |
| `chat.request` | S→C | `request_id`, `model`, `messages`, `params{max_tokens,temperature,stream}`, `timeout_ms` | unknown fields dropped at the seam |
| `chat.response` | C→S | `request_id`, `model`, `content`, `finish_reason?`, `usage?` | frame cap 60 KB |
| `chat.delta` | C→S | `request_id`, `delta` | Phase 5 streaming; cumulative cap 32 768 chars |
| `chat.error` | C→S | `request_id`, `code`, `message` | fixed allowlist codes only |
| `chat.cancel` | S→C | `request_id` | aborts local fetch, frees slot, sends NOTHING back |

**Errors:** allowlisted codes only (`invalid_request`, `request_too_large`,
`model_not_found`, `busy`, `timeout`, `runtime_unreachable`,
`context_length`, `bad_response`, `runtime_error`, `response_too_large`,
`cancelled`); raw runtime text never crosses the WS; cloud truncates
messages to 256 chars.

**Lifecycle:** outbound connect → hello → ready → heartbeats (cadence from
`ready`, fallback 15 s, clamp 250 ms–600 s) → frames; reconnect with
exponential backoff + jitter (1 s base, 30 s cap); `request_id` executed
at-most-once per session lifecycle; seen-id store fail-closed at 100 000
entries; per-session state cleared on close.

**Limits (both sides enforce; mirrored):** messages ≤ 64 × 32 KB,
prompt ≤ 128 KB, `max_tokens` ≤ 8192, temperature 0–2, timeout 1–180 s,
concurrency 2, response frame ≤ 60 KB, deltas ≤ 16 KB, streamed content
≤ 32 768 chars.

**Compatibility policy (proposal):**
- **Breaking (needs protocol_version bump):** removing/renaming a frame;
  changing the meaning of a documented field; tightening limits below the
  documented contract; making an optional field mandatory; changing token
  grammar or error-code semantics.
- **Non-breaking (minor/patch):** new OPTIONAL fields; new error codes;
  new `runtime_type` labels; relaxing limits; new frame types the peer
  may ignore (the connector already ignores unknown types safely).

## 5. Extraction seam

```
Animastor backend (host)          LAC public contract          Standalone package
──────────────────────────         ─────────────────────         ───────────────────
routes/ai-connector-routes.cjs  ←─ WS frames (LAC v1) ───────→  index.cjs CLI
services/ai-connector/*         ←─ protocol_version: 1 ──        lib/** (private)
frontends UI command builder    ←─ CLI name + flags ──           package.json
```

- Backend production code has **zero** code-level dependency on LAC
  (verified: only comments/docs name it). After Phase C the backend
  acquires no new hidden dependency: its only connection point is the WS
  endpoint + the mirrored contract numbers.
- Test-time requires (11 files) migrate INTO the package as its own unit
  tests; the backend keeps protocol-level tests (frames, endpoint
  behavior) that speak the published contract, not package internals.
- The mirror numbers (`transport.js:60+` limits, token regex, heartbeat
  cadence) become a pinned contract test against the SPEC document — a
  conscious SYNC list with named owners, not silent drift.

## 6. Deployment model

- **Install:** `npx animastor-ai-connector …` (UI already shows the
  exact command with the ws URL and one-time token embedded); global
  install optional.
- **Run:** long-lived local process; reads flags/env; user keeps the
  `llmc.*` credential in `ANIMASTOR_CONNECTOR_TOKEN`.
- **Update:** `npx` pulls latest by default — package semver is the
  update channel; a pinned major = stable protocol.
- **Compatibility:** already solved — `hello.protocol_version` is checked
  by the backend (fail-closed `protocol_version_unsupported`). No new
  capability negotiation is needed for V1; future capabilities ride
  optional fields per §4 policy.

## 7. Release readiness (current state → required)

| Item | Now | Required before publish |
|---|---|---|
| `package.json` | name/desc/main/bin/engines ok; `version 0.1.0`; scripts ok | version 1.0.0, `files` allowlist, repository/homepage/bugs fields |
| semver | absent (0.1.0) | adopt 1.0.0 = protocol v1 GA |
| CHANGELOG | missing | add, seeded with V1 scope |
| README | good but references monorepo docs | self-contained (inline the user-facing parts; keep spec link for the published spec) |
| LICENSE | **UNLICENSED** | legal decision (blocker) |
| Distribution | none | public npm (see §3) |
| Name | `animastor-ai-connector` | CONFIRMED — UI contract; reserve early |
| Tests | all live in backend/tests | package-owned unit tests (migrated copies, see Phase C) |
| Security review | monorepo privacy | pre-publish security pass (public surface changes threat model) |

## 8. Step-by-step extraction plan

### Phase A — Documentation / spec
- **What changes:** new standalone LAC v1 spec (frames/limits/errors/
  lifecycle/breaking policy) in the package; README made self-contained.
- **Files:** `local-ai-connector/SPEC.md` (or docs/ shipped with pkg),
  README edit. Docs only.
- **Risk:** none.
- **Regression check:** `test:arch` unchanged; no code touched.
- **Guards preserved:** all (nothing they scan changes).
- **Rollback:** delete the doc.

### Phase B — Package preparation
- **What changes:** package.json metadata (version, files, repository),
  LICENSE, CHANGELOG; migrate unit tests of LAC internals into the
  package (copies; backend keeps protocol-level tests); `npm pack`
  dry-run review.
- **Files:** package.json, LICENSE, CHANGELOG, new `local-ai-connector/
  test/` (or similar), README.
- **Risk:** low — metadata + test moves; no runtime code.
- **Regression check:** backend full suite still green (migrated test
  copies may exist in both places temporarily); `npm pack --dry-run`
  contains no secrets, no extra files.
- **Guards preserved:** P7-T1 manifest assertion reads the same
  package.json (keep dep set `ws`-only); dependency-guardrails LAC rules.
- **Rollback:** revert commit.

### Phase C — Physical extraction (blocked until §blockers close)
- **What changes:** `git mv local-ai-connector <new repo/location>`; fix
  require paths in the 11 backend test files + 4 guard suites +
  `scripts/syntax-smoke.sh`; backend protocol tests switch to speaking
  the published contract (or are pinned to the spec numbers).
- **Files:** the moved tree; `backend/tests/ai-connector-*.test.js`,
  `backend/tests/architecture/{phase2-lac-transport-contract,
  phase7-extraction-readiness, dependency-guardrails}.test.js`,
  `backend/tests/architecture/redis-registry.js` (if it names LAC),
  `scripts/syntax-smoke.sh`.
- **Risk:** MEDIUM — path churn across tests/guards; single atomic commit
  required; contract numbers must not drift during the move.
- **Regression check:** full backend suite + `test:arch` + syntax smoke;
  E2E: run the moved package against a dev backend (hello → ready →
  heartbeat → chat.request).
- **Guards preserved (semantics):** P7-T1 becomes structural (out of
  scope of backend scans) — replace or consciously retire with ADR;
  phase2-lac-transport-contract survives as the cross-repo contract pin
  (it reads spec/contract surfaces, not internals).
- **Rollback:** `git mv` back, revert path fixes.

### Phase D — Backend integration
- **What changes:** nothing in backend production code (endpoint already
  speaks the contract); only test/guard references finalized; UI command
  optionally gains version pinning guidance.
- **Risk:** low.
- **Regression check:** full contour, LAC E2E acceptance green.
- **Guards:** unchanged.
- **Rollback:** revert commit.

### Phase E — Guard / test migration cleanup
- **What changes:** remove duplicated migrated unit tests from backend if
  Phase B kept copies; finalize P7-T1 disposition (retire with ADR or
  keep as cross-repo check); document the SYNC mirror list (token regex,
  limits, protocol_version) with owners.
- **Risk:** low.
- **Regression check:** `test:arch` full pass; no guard vacuously green
  (negative control).
- **Rollback:** revert.

### Phase F — Independent release
- **What changes:** `npm publish` (after security pass + license);
  CHANGELOG 1.0.0; optionally GitHub release tag.
- **Risk:** MEDIUM — public surface; irreversible-ish (unpublish windows
  are short).
- **Regression check:** `npx animastor-ai-connector@1.0.0` E2E against
  production-like backend.
- **Rollback:** deprecate version; cannot fully unpublish after 72 h.
- **Guards:** none affected.

## 9. Hidden dependencies (beyond the require-scan)

| Kind | Detail | Severity |
|---|---|---|
| UI copy-paste contract | `npx animastor-ai-connector --url … --token …` shown to users in web (`localAi.ts:218`), Android (`LocalAiHelpers.kt:104`), i18n strings, and tests pin it | high — name/flags are frozen |
| WS endpoint path | `/api/v1/ai-connector/ws` appears in UI-built URL | contract, document in spec |
| Env vars | `ANIMASTOR_CONNECTOR_URL/TOKEN` (config.cjs:65-66) | contract, document |
| Token grammar | `llmc.*` / `llmcreg.*` regex duplicated backend-side | SYNC mirror, needs contract test |
| Limits mirrors | `chat.cjs LIMITS` ↔ `transport.js:60+` (32 KB msg, 32 768 streamed, etc.) | SYNC mirror, needs contract test |
| protocol_version SYNC | `connector.cjs:548` (hardcoded 1) ↔ `routes:85` | contract test after extraction |
| CLI dead flag | `--log-file` accepted, ignored (in-memory log) | document as V1 behavior |
| Ports | none inbound; assumes local runtime ports (default 11434) | document |
| Filesystem | none persisted; in-memory ring buffer only | none |
| Docker | LAC runs on USER machines, not in docker-compose — no images reference it | none |
| Logging | metadata-only via console/`logger` injection | fine |
| Node version | `engines >= 18` (global fetch) | document |

## 10. Verdict

**PHASE 8 EXTRACTION DESIGN: READY** — Phases A–B can start immediately;
the physical move (C) and publish (F) wait for the blockers below.

**EXTRACTION RISK: LOW** overall (A: zero, B: low) / **MEDIUM** at the
Phase C point (path churn across 11 test files + 4 guard suites +
syntax-smoke).

**BLOCKERS (must close before C/F):**
1. LICENSE decision (package is UNLICENSED).
2. Package has no tests of its own — migration required.
3. Test/guard/script path references to the monorepo location.
4. README references the monorepo-internal spec doc.
5. SYNC mirrors (protocol_version, token regex, limits) need a cross-repo
   contract test before the sources separate.
6. Security review before public npm exposure.

**Safe to do now:** Phase A (spec), Phase B (metadata/license/tests/
dry-run). **NOT yet:** physical move, publish, any guard change.

**3 mandatory pre-extraction checks (immediately before Phase C):**
1. Full test contour green at the pre-move commit (known 7 pre-existing
   failures unchanged) — establishes the baseline.
2. After the move-commit: `test:arch` (P7-T1 semantics, phase2-lac
   contract, dependency-guardrails) green with unchanged assertions.
3. E2E smoke of the moved package against a dev backend: hello → ready →
   heartbeat → chat.request → chat.response (`ai-connector-acceptance`
   green).
