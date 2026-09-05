# LAC v1 — Wire Protocol Specification

**Status:** normative as-implemented. This document describes the protocol
exactly as shipped in this package and by the Animastor backend
(`backend/src/routes/ai-connector-routes.cjs`,
`backend/src/services/ai-connector/transport.js`). It does not invent new
behavior; where code and this document disagree, that is a defect (see
"Discrepancies" at the bottom).

**protocol_version:** `1` (carried in `hello`; peers rejecting it close with
reason `protocol_version_unsupported`).

- **Transport:** a single outbound WebSocket (JSON text frames only; binary
  frames are ignored) from the connector to the Animastor backend at
  `GET /api/v1/ai-connector/ws`.
- **Roles:** C = connector (this package), S = server/cloud (Animastor backend).
- **Frame envelope:** every frame is a JSON object with a string `type`
  (≤ 64 chars). Unknown frame `type`s are ignored by both peers. Unknown
  fields on known frames are dropped at each peer's validation seam.

---

## 1. Frame types

| Frame | Direction | Purpose |
|---|---|---|
| `hello` | C→S | opening frame: protocol version + exactly one credential |
| `ready` | S→C | session accepted; cadence + identity (+ minted credential on activation) |
| `heartbeat` | C→S | liveness + runtime facts (models, runtime_ok) |
| `models.refresh` | S→C | server asks for explicit local discovery |
| `models.list` | C→S | reply to `models.refresh` only |
| `chat.request` | S→C | inference request (non-streaming or streaming) |
| `chat.delta` | C→S | one streaming text increment |
| `chat.response` | C→S | terminal success frame (both modes) |
| `chat.error` | C→S | terminal failure frame (sanitized codes only) |
| `chat.cancel` | S→C | abort one in-flight request |

That is the entire surface. `chat.request` and `chat.cancel` are strictly
S→C: a connector sending them is ignored. `models.refresh`, `chat.request`
and `chat.cancel` are strictly C-facing: this package never emits them.

## 2. hello (C→S)

```json
{ "type": "hello", "protocol_version": 1, "credential": "llmc.… | reg_token": "llmcreg.…" }
```

- `protocol_version` — **required**, must be exactly `1`. Anything else →
  server closes with reason `protocol_version_unsupported`.
- Exactly ONE of `credential` (`llmc.*` persistent) or `reg_token`
  (`llmcreg.*` one-time registration) — **XOR, not fallback**. Presenting
  both or neither is a policy violation → close reason `auth_failed`.
- `hello` is the OPENING frame only; a second `hello` on an authenticated
  session is closed with `auth_failed`.
- Token grammar (both peers validate shape; never logged, never echoed):
  `^(llmc|llmcreg)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$` — three dot-separated
  segments: family, connector-id (base64url), secret (base64url).
- Auth must complete within the server's auth window (default 10 s) →
  otherwise close reason `auth_timeout`.
- Registration is an atomic exactly-once exchange: the `llmcreg.*` token is
  consumed and the minted `llmc.*` credential is disclosed exactly once in
  `ready` (see §3). A replayed/used/expired registration token → close
  `auth_failed`.

## 3. ready (S→C)

```json
{
  "type": "ready",
  "connector_id": "uuid",
  "heartbeat_interval_ms": 15000,
  "server_time": 1699999999999,
  "credential": "llmc.…",        // OPTIONAL — activation only
  "credential_prefix": "llmc.ab" // OPTIONAL — activation only
}
```

- `connector_id` — server-assigned identity (string).
- `heartbeat_interval_ms` — advertised heartbeat cadence in ms (number).
- `server_time` — server epoch ms (number).
- `credential` / `credential_prefix` — present ONLY on the activation path
  (hello carried `reg_token`). The plaintext `llmc.*` appears exactly this
  once; the connector prints it once to stdout and never logs it. The
  connector never persists it (the user stores it, e.g. in
  `ANIMASTOR_CONNECTOR_TOKEN`).

## 4. heartbeat (C→S)

```json
{ "type": "heartbeat", "runtime": { "type": "ollama" }, "models": ["qwen3:32b"], "runtime_ok": true }
```

- `runtime.type` — string, the configured runtime label (one of the §10
  runtime types). Sent from local config, never from server frames.
- `models` — OPTIONAL array of model-id strings, **omitted** until the first
  successful local discovery (an omitted field ≠ empty list: an empty list
  would erase last-known server state). After a discovery failure the last
  known-good list is kept. Server clamps: ≤ 256 entries, each 1–512 chars.
- `runtime_ok` — OPTIONAL boolean; present only after a real observation.
- The server accepts optional extras (`capabilities{tools,vision,context}`,
  `latency_ms`, `runtime.version`) that this package does not yet send; the
  server drops unknown fields field-by-field and never fails a session on a
  malformed heartbeat.
- Cadence: from `ready.heartbeat_interval_ms` (server default 15 000 ms);
  the connector clamps any value into 250 ms–600 000 ms and may override
  locally via `--heartbeat-interval-ms`. Server silence window: 45 000 ms
  without any well-formed frame → close reason `heartbeat_timeout`.
- Honesty rules: facts only from real local observations; no auto-probing —
  runtime facts are re-checked at most once per cache TTL (default 30 s) and
  only while a session is live.

## 5. models.refresh (S→C) → models.list (C→S)

```json
{ "type": "models.refresh" }                        // S→C — only `type` is read
{ "type": "models.list", "models": ["m1", "m2"] }   // C→S success
{ "type": "models.list", "models": [], "error_code": "runtime_unreachable" } // C→S failure
```

- Discovery is EXPLICIT-only (no polling, no probes): the connector performs
  exactly one `GET {base}/v1/models` per refresh burst.
- Concurrent refreshes coalesce — one local HTTP fetch answers all.
- `models.list` is sent ONLY as the reply to `models.refresh`; a
  heartbeat-driven cache refresh is reported through the next heartbeat
  instead.
- `error_code` (optional, failure only) comes from a sanitized set:
  `timeout | runtime_unreachable | bad_response | runtime_error |
  response_too_large`.
- Any URL-ish fields the server attaches to `models.refresh` are structurally
  ignored (AD-5): the runtime base URL is local config only.
- The server treats a well-formed `models.list` as a liveness proof.

## 6. chat.request (S→C)

```json
{
  "type": "chat.request",
  "request_id": "uuid",
  "model": "qwen3:32b",
  "messages": [{ "role": "user", "content": "…" }],
  "params": { "max_tokens": 128, "temperature": 0.5, "stream": false },
  "timeout_ms": 30000
}
```

- `request_id` — required string, cloud-generated UUID, printable, ≤ 128
  chars (`^[\x21-\x7e]{1,128}$`).
- `model` — required string, 1–512 chars after trim, no control characters.
- `messages` — required non-empty array of `{role, content}`:
  - `role` ∈ `system | user | assistant`;
  - `content` non-empty string.
- `params` — OPTIONAL object; only `max_tokens` (integer 1–8192),
  `temperature` (number 0–2) and `stream` (strict boolean) are contractual.
  Unknown param keys are dropped, never forwarded.
- `timeout_ms` — OPTIONAL number; defensively clamped by the connector into
  1 000–180 000 ms (never trusted).
- There is deliberately NO url/base_url/endpoint field: the runtime call
  always targets the connector's LOCAL base URL (AD-5).

## 7. chat.response / chat.delta / chat.error / chat.cancel

```json
{ "type": "chat.response", "request_id": "…", "model": "…", "content": "…",
  "finish_reason": "stop", "usage": { "prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3 } }

{ "type": "chat.delta", "request_id": "…", "delta": "text increment" }

{ "type": "chat.error", "request_id": "…", "code": "model_not_found", "message": "Model not found on the local runtime" }

{ "type": "chat.cancel", "request_id": "…" }
```

- `chat.response`: `content` required string; `finish_reason` optional
  (≤ 64 chars, no control chars); `usage` optional with the three integer
  counters only (each ≤ 1e9). The serialized frame must stay ≤ 60 KB —
  otherwise the connector answers `response_too_large` instead of sending
  an oversized frame.
- `chat.delta`: one text increment (≤ 16 384 chars). Cumulative streamed
  text ≤ 32 768 chars. Text only — never role/tool payloads.
- `chat.error`: `code` from the fixed §8 allowlist; `message` is a fixed
  sanitized string (the cloud truncates/ignores anything else; unknown codes
  degrade to `runtime_error`).
- `chat.cancel`: aborts the local runtime fetch, frees the concurrency
  slot, and the connector sends NOTHING back for that `request_id` — no
  terminal frame of any kind. Unknown/finished ids are ignored silently.

## 8. Error codes (chat.error allowlist)

| Code | Meaning |
|---|---|
| `invalid_request` | request rejected by connector validation |
| `request_too_large` | request exceeds connector size limits |
| `model_not_found` | runtime answered 404 for the model |
| `busy` | connector at its concurrency limit |
| `timeout` | local inference timed out |
| `runtime_unreachable` | local runtime not reachable |
| `context_length` | prompt exceeds the model context window |
| `bad_response` | runtime returned an unreadable response |
| `runtime_error` | local runtime error (generic) |
| `response_too_large` | local response exceeded the size limit |
| `cancelled` | request cancelled |

Raw runtime error text never crosses the WebSocket. The adapter may also
settle a stream that already delivered text as `stream_failed` internally;
upstream of the WS that maps to §7 sanitized codes.

## 9. request_id semantics

- A `request_id` executes AT MOST ONCE per session lifecycle. In-flight or
  completed ids are rejected `invalid_request` on replay — no re-execution.
- Rejected (invalid) request ids are also remembered: a rejected id never
  becomes executable later.
- The seen-id store is fingerprinted (SHA-256, 16 hex chars) and NEVER
  evicted; at 100 000 entries the session turns fail-closed for NEW ids
  (memory bound without weakening at-most-once).
- The store is per-SESSION-LIFECYCLE: a reconnect starts a fresh lifecycle
  (seen ids do not survive a socket close).
- Cloud-side: request_id is a cloud-generated UUID; replies are correlated
  only against requests sent on the SAME session; the cloud timer is
  authoritative — on expiry the cloud sends `chat.cancel` and settles
  `timeout`; late/unsolicited frames are dropped at zero cost.

## 10. Limits (enforced on BOTH sides; mirrored numbers)

| Limit | Value |
|---|---|
| messages per request | 64 |
| per-message content | 32 768 chars (32 KB) |
| total prompt | 131 072 chars (128 KB) |
| `max_tokens` | ≤ 8 192 |
| `temperature` | 0 … 2 |
| `timeout_ms` | 1 000 … 180 000 |
| concurrent local runtime requests | 2 (overflow → `busy`) |
| serialized `chat.response` frame | ≤ 60 KB (61 440 bytes) |
| one `chat.delta` | ≤ 16 384 chars |
| cumulative streamed content | ≤ 32 768 chars |
| runtime SSE event / line buffer | ≤ 64 KB each |
| runtime HTTP response (discovery) | ≤ 512 KB |
| runtime HTTP response (chat) | ≤ 1 MB |
| inbound WS frame (cloud cap) | 64 KB |
| seen request ids per session | 100 000 (then fail-closed) |
| model id | ≤ 512 chars, no control characters |
| request id | ≤ 128 printable chars |

## 11. Runtime types

`ollama | vllm | llamacpp | lmstudio | openai-compatible`

V1 maps all five to one OpenAI-compatible adapter with exactly two paths:
`GET {base}/v1/models` and `POST {base}/v1/chat/completions` (`stream:false`
hardcoded for non-streaming, `stream:true` only via the dedicated streaming
call). The label is informational; it never selects a different protocol.

## 12. Lifecycle, heartbeat, reconnect

1. Connector dials OUT (never listens). On open → `hello`.
2. Server authenticates (≤ 10 s window) → `ready`; connector starts the
   heartbeat timer from the advertised cadence and sends an immediate first
   heartbeat (pre-discovery: no `models`, no `runtime_ok`).
3. Steady state: heartbeats at cadence; server closes after 45 s of
   silence (`heartbeat_timeout`).
4. On socket close (any reason): the connector aborts in-flight local
   fetches, clears the request-id lifecycle, and reconnects with
   exponential backoff + jitter (1 s base, doubling, 30 s cap, ≤ 250 ms
   jitter). Server-side the session is unregistered and the connector is
   marked offline (unless replaced).
5. Single live session per connector: a newer authentication REPLACES the
   older session (older socket closed with code 4000 `replaced`).
6. Credential rotation/revocation evict a live session (close codes 4001
   `rotated` / 1008 `revoked`).

Close reasons (server → connector, also delivered as WS close reason
strings): `auth_failed`, `auth_timeout`, `protocol_version_unsupported`,
`malformed_frame`, `heartbeat_timeout`, `revoked`, `replaced`, `rotated`,
`server_shutdown`.

## 13. Credential handling

- Two families: `llmc.*` (persistent, hash-stored server-side) and
  `llmcreg.*` (one-time registration, TTL ≤ 15 min, exactly-once).
- The plaintext credential crosses the wire exactly twice in its life:
  once in `hello` (client → server) and, for activation only, once in
  `ready` (server → client) as the minted `llmc.*`.
- Never logged by either peer; never echoed in error messages; validated by
  shape only.
- The connector process never persists credentials to disk; the user stores
  the persistent credential (recommended: `ANIMASTOR_CONNECTOR_TOKEN`).

## 14. Unknown frames / unknown fields

- Unknown frame `type` → ignored by both peers (never closes the session).
- Unknown fields on known frames → dropped at the validation seam; they
  never reach the runtime adapter, the logs, or PG.
- Malformed JSON / non-object frames: connector ignores silently; server
  closes with `malformed_frame`.
- A hostile server attaching `url`/`base_url`/`endpoint`/identity fields to
  any frame changes nothing (AD-5): the runtime target is local config only.

## 15. Breaking vs non-breaking changes

**Breaking (requires a `protocol_version` bump):**
- removing or renaming a frame type;
- changing the documented meaning of a field;
- making an optional field mandatory;
- tightening a §10 limit below the documented value;
- changing the token grammar or an error-code meaning;
- removing an error code from the allowlist.

**Non-breaking (minor/patch):**
- adding OPTIONAL fields (peers drop unknown fields by design);
- adding new error codes (unknown codes degrade to `runtime_error`);
- adding runtime-type labels;
- relaxing limits;
- adding new frame types (peers ignore unknown types by design).

## 16. Discrepancies / known V1 quirks (documented, not changed)

1. `--log-file` is accepted for CLI compatibility but V1 keeps the
   metadata operation log in memory only (nothing is written to disk).
2. The server's `ready` always includes `heartbeat_interval_ms`, but the
   connector treats it as optional (falls back to 15 000 ms).
3. The server accepts `heartbeat.capabilities`/`latency_ms` that this
   package does not emit yet (reserved optional fields, see §4).
4. Cloud-side `transport.js` mirrors §10 limits in its own source; the
   mirrored numbers are pinned by the cross-side contract test
   (`backend/tests/architecture/lac-contract-sync.test.js`) so the two
   implementations cannot silently drift.
