# animastor-ai-connector

Local AI Connector (V1, Phase 4) — outbound bridge between an Animastor
workspace and a local OpenAI-compatible runtime (Ollama / vLLM / llama.cpp /
LM Studio). The connector ALWAYS dials out to the cloud (outbound WebSocket);
no inbound ports, no port forwarding.

Spec: `docs/04-planning/local-ai-connector-v1.md` (§3.4, §4, §5, §6, §7, §10, AD-5/AD-6/AD-7).

## What V1 (Phase 4) does

- registers/activates against Animastor over WebSocket (`hello` → `ready`),
  exchanging the one-time `llmcreg.*` token for the persistent `llmc.*`
  credential (disclosed exactly once, printed by the CLI on activation);
- discovers models on the local runtime via `GET {base}/v1/models` —
  **explicitly, only when the cloud asks** (`models.refresh`) — and reports
  normalized model-id strings back (`models.list`);
- heartbeats with discovered models + runtime reachability;
- performs **non-streaming inference** on the cloud's explicit request:
  `chat.request` → `POST {base}/v1/chat/completions` (`stream:false`
  hardcoded) → `chat.response` / `chat.error` (sanitized allowlisted codes);
  `chat.cancel` aborts the local fetch and frees the slot.

What it deliberately does NOT do: streaming (`chat.delta` is Phase 5),
model loading, probes, filesystem/shell access, arbitrary HTTP (it is an
allowlist adapter with exactly two paths, not a proxy — AD-5).

## Run

```bash
cd local-ai-connector
npm install
node index.cjs \
  --url wss://<your-animastor-host>/api/v1/ai-connector/ws \
  --token llmcreg.<…>.<…> \
  --runtime-type ollama
```

On first connect the one-time registration token is exchanged for the
persistent `llmc.*` credential, printed once — store it (e.g. in
`ANIMASTOR_CONNECTOR_TOKEN`) for subsequent runs.

## Options

| Flag | Meaning |
|---|---|
| `--url` | Animastor connector WS endpoint (`wss://` mandatory off-loopback) |
| `--token` | `llmcreg.*` (registration) or `llmc.*` (persistent) credential |
| `--base-url` | local runtime base URL; default `http://127.0.0.1:11434` |
| `--runtime-type` | `ollama` \| `vllm` \| `llamacpp` \| `lmstudio` \| `openai-compatible` |
| `--allow-lan` | explicitly allow a non-loopback runtime base URL |
| `--log-file` | accepted for compatibility; V1 keeps the metadata log in memory |

Env fallbacks: `ANIMASTOR_CONNECTOR_URL`, `ANIMASTOR_CONNECTOR_TOKEN`.

## Security posture (summary)

- The runtime base URL is LOCAL CONFIG ONLY — it can never come from the
  cloud or any frame (AD-5). The adapter knows exactly two paths
  (`GET {base}/v1/models`, `POST {base}/v1/chat/completions`); no redirects
  are followed; responses are size-capped and strictly validated.
- No automatic probes (AD-7): discovery runs only on explicit
  `models.refresh`; inference runs only on explicit `chat.request`.
- Every chat limit is enforced HERE (message count/size, prompt size,
  max_tokens, temperature, timeout, response size, concurrency — default 2
  in-flight, overflow → `busy`); a request_id executes at most once per
  session lifecycle.
- Logging is metadata-only (AD-6): op, status, error code, duration, byte
  count — never prompts, responses, or credential material.
- Credentials are validated by shape and never logged or echoed.

## Layout

```
index.cjs                     CLI entrypoint
lib/config.cjs                strict, fail-closed config parsing (loopback default)
lib/runtime-adapters/         the allowlist seam (AD-5)
  index.cjs                     runtime-type → adapter registry
  openai-compatible.cjs         V1 adapter: GET {base}/v1/models +
                                POST {base}/v1/chat/completions + strict normalization
lib/chat.cjs                  chat.request validation + limits (Phase 4)
lib/connector.cjs             WS session (hello/ready/heartbeat, discovery,
                              chat.request/chat.cancel — non-streaming)
lib/log.cjs                   metadata-only operation log (AD-6)
```
