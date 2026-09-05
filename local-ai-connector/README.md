# animastor-ai-connector

Local AI Connector — a small, security-first bridge that lets an
**Animastor workspace use your own local AI models** (Ollama, vLLM,
llama.cpp, LM Studio, or any OpenAI-compatible server) instead of — or
alongside — cloud providers.

The connector is a **long-lived local process** on YOUR machine. It always
**dials out** with a single WebSocket to your Animastor backend; it never
listens on any port, never needs port forwarding, and never exposes your
machine to inbound connections from the internet.

```
Animastor workspace  ──WS (LAC v1)──▶  animastor-ai-connector  ──HTTP──▶  local runtime
        (cloud)                                   (your machine)          (Ollama, vLLM, …)
```

## Why a connector?

- **Privacy:** prompts and completions go to *your* local model; the cloud
  only relays bytes, it never stores them.
- **Cost:** your own GPU, your own tokens.
- **Control:** the connector enforces every limit locally — a compromised
  or buggy server can never push oversized prompts, unbounded generation,
  arbitrary URLs or duplicate requests through to your runtime.

## Requirements

- **Node.js ≥ 18** (uses the built-in global `fetch` and `AbortController`)
- A local OpenAI-compatible runtime reachable on loopback by default:
  - Ollama → `http://127.0.0.1:11434` (the default)
  - vLLM / llama.cpp / LM Studio → pass `--base-url`
- The connector WS URL + a token issued by your Animastor workspace
  (Local AI settings page shows the exact copy-paste command)

## Installation & run

No install step is needed — run it directly with npx:

```bash
npx animastor-ai-connector \
  --url wss://<your-animastor-host>/api/v1/ai-connector/ws \
  --token llmcreg.<one-time-registration-token> \
  --runtime-type ollama
```

(Or install globally once: `npm i -g animastor-ai-connector`, then run
`animastor-ai-connector …`.)

**First run (activation):** the one-time `llmcreg.*` registration token is
exchanged for a persistent `llmc.*` credential, which is printed to your
terminal **exactly once**:

```
Connector activated. Persistent credential (store it now, shown once):
llmc.…
```

Store that credential safely (e.g. in the `ANIMASTOR_CONNECTOR_TOKEN`
environment variable) — it is never shown again. Subsequent runs use it to
re-authenticate without re-registering.

Keep the process running while you want the workspace to see your models;
stop it with Ctrl-C (SIGINT/SIGTERM are handled cleanly).

## CLI options

| Flag | Meaning | Default |
|---|---|---|
| `--url <wss://…>` | Animastor connector WebSocket endpoint | required* |
| `--token <llmc.\|llmcreg.>` | persistent credential or one-time registration token | required* |
| `--base-url <http://…>` | local runtime base URL | `http://127.0.0.1:11434` |
| `--runtime-type <type>` | `ollama` \| `vllm` \| `llamacpp` \| `lmstudio` \| `openai-compatible` | `openai-compatible` |
| `--allow-lan` | explicitly allow a NON-loopback runtime base URL (e.g. a GPU box on your LAN) | off (loopback only) |
| `--heartbeat-interval-ms <ms>` | override the server-advertised heartbeat cadence (250–600 000) | from server (15 000 ms) |
| `--log-file <path>` | accepted for compatibility; V1 keeps the metadata log in memory only | — |
| `--help`, `-h` | usage | |

\* also resolvable from the environment (see below).

### Environment variables

| Variable | Purpose |
|---|---|
| `ANIMASTOR_CONNECTOR_URL` | fallback for `--url` |
| `ANIMASTOR_CONNECTOR_TOKEN` | fallback for `--token` — the recommended place to keep the persistent `llmc.*` credential |

CLI flags win over environment variables.

### Exit codes

- `0` — clean run / shutdown (SIGINT/SIGTERM, `--help`)
- `2` — configuration error (invalid flags, bad URL/token shape, …)

## What it does

- **Registration & heartbeat:** activates via `hello`/`ready`, then sends
  heartbeats with honest runtime facts (models, reachability). Reconnects
  automatically with exponential backoff if the connection drops.
- **Model discovery:** the workspace can ask for a model refresh at any
  time; the connector performs exactly ONE `GET {base}/v1/models` per
  request burst and reports normalized model ids. No polling, no probing.
- **Inference:** on the workspace's explicit request the connector calls
  `POST {base}/v1/chat/completions` on your runtime — non-streaming
  (`chat.response`) or streaming (`chat.delta` × N + one terminal
  `chat.response`). The workspace can cancel mid-flight (`chat.cancel`),
  which aborts the local fetch immediately.

## Security model

- **Outbound-only:** one WebSocket out; zero listening sockets.
- **Loopback by default:** the runtime base URL must be loopback unless you
  explicitly opt in with `--allow-lan`. It can NEVER be set from the
  server or from any network frame.
- **Allowlist adapter, not a proxy:** the connector talks to your runtime
  on exactly two paths (`GET /v1/models`, `POST /v1/chat/completions`).
  No arbitrary path, no arbitrary method, redirects are refused. There is
  no field in the protocol that can redirect the runtime call anywhere.
- **No filesystem, no shell, no config files:** flags and env only; the
  operation log is an in-memory ring buffer.
- **Metadata-only logging:** op, status, sanitized error code, duration,
  byte counts — never prompts, responses, or credentials.
- **Every limit enforced locally** (defense in depth): message count/size,
  prompt size, `max_tokens`, temperature, timeouts, response sizes,
  concurrency (2 in-flight requests, overflow → `busy`), and at-most-once
  execution per request id per session.
- **Credential handling:** tokens are validated by shape and never echoed
  to logs or errors. The persistent `llmc.*` credential is disclosed once
  on activation (stdout), then only you hold it.

## Credential handling (details)

- `llmcreg.*` — one-time registration token (TTL ≤ 15 min), consumed at
  activation; presenting it again fails.
- `llmc.*` — persistent credential, kept by you; rotate/revoke it from the
  Animastor workspace at any time (a rotated/revoked credential kills the
  live session immediately).
- Exactly one live session per connector: connecting a second time with
  the same credential replaces the first session.

## Supported runtimes

| Runtime | `--runtime-type` | Notes |
|---|---|---|
| Ollama | `ollama` | default base URL matches |
| vLLM | `vllm` | pass `--base-url` |
| llama.cpp | `llamacpp` | OpenAI-compatible server mode; pass `--base-url` |
| LM Studio | `lmstudio` | pass `--base-url` |
| Any OpenAI-compatible | `openai-compatible` | default type |

V1 treats the type as a label — the wire protocol is identical; all five
go through the same OpenAI-compatible adapter.

## Protocol version

The connector speaks **LAC v1** (`protocol_version: 1`, fixed in the
`hello` frame). The full wire specification — every frame type, field,
limit, error code, lifecycle rule, and the breaking-change policy — is
shipped with this package as [SPEC.md](SPEC.md).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Configuration invalid: … token is required…` | Bad token shape — copy it again; the token must start with `llmc.` or `llmcreg.` (3 dot-separated segments) |
| `url must use wss://` | Plain `ws://` is allowed only for loopback hosts; use `wss://` for your real server |
| `base-url must be loopback` | You pointed at a LAN address without `--allow-lan` — add the flag if the machine is really yours |
| Reconnect loop (`reconnecting in …ms`) | The server is unreachable or the credential was revoked/rotated — check the URL, re-check the token, check the workspace's Local AI status page |
| `discovery failed: runtime_unreachable` | The local runtime is not running or is on a different port — check `--base-url` and that the runtime serves `/v1/models` |
| Models never appear in the workspace | Discovery is explicit: press "refresh models" in the workspace once; the connector reports facts only from real observations |
| `busy` errors at the workspace | The connector allows 2 concurrent local requests; queue or reduce parallelism |
| Session dies right after start (`replaced`) | Another connector process authenticated with the same credential — only one live session per connector |

Logs (metadata-only) go to stdout/stderr; the process writes no files.

## Compatibility & versioning

- **Package version** (semver, independent) and **protocol version**
  (wire, currently 1) are separate: a package v1.x.y speaks protocol v1.
- Breaking protocol changes require a `protocol_version` bump — the server
  rejects mismatched versions fail-closed, so old connectors never
  half-work against a new server (and vice versa).
- Non-breaking additions (optional fields, new error codes, relaxed limits)
  ride the existing protocol version; unknown frames/fields are ignored
  by design on both sides.
- Node < 18 is not supported (the CLI relies on built-in fetch).

## Development

Layout (zero-build CommonJS):

```
index.cjs                  CLI entrypoint
lib/config.cjs             strict fail-closed config parsing
lib/connector.cjs          WS session state machine
lib/chat.cjs               chat.request validation + limits
lib/log.cjs                metadata-only ring buffer log
lib/runtime-adapters/      adapter allowlist (openai-compatible)
test/                      package-owned test suite (node:test)
```

Run the package test suite (no backend, no database needed):

```bash
npm test
```

Further background documentation lives in the
[Animastor monorepo](https://github.com/Animastor/animastor) — this package
is fully self-contained for use and operation.
