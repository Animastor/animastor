# LLM Sharing — Phase 3: Production SSE & UX

> 2026-09-04 · Implementation document for the THIRD production phase of
> LLM sharing: the first real user-facing streaming path. Companions
> (authorities): `llm-sharing-phase1-control-plane.md` (entities, policy,
> pool seam), `llm-sharing-phase2-consumer-inference.md` (consumer resolver,
> slot lifecycle, sanitized errors), `local-ai-connector-v1.md` (§4 Phase-5
> `chat.delta` streaming — the only streaming protocol in the system).
>
> Core path realized here:
>
> ```
> Web chat → AI route → resolver → shared endpoint → connector WS
>          → local runtime SSE → connector chat.delta → cloud → browser SSE
> ```
>
> NO second transport, NO second protocol: the production route re-emits
> the existing connector `chat.delta` stream over plain HTTP SSE. Cloud
> providers and private Local AI ride the same route with their existing
> transports.

---

## 1. Production streaming route (the missing LAC gap)

`POST /api/v1/ai/chat/stream` (`backend/src/routes/ai-routes.cjs`) —
greenfield route on the EXISTING seams (LAC §4 Phase-5 note: the re-emit
route lands with the resolver/provider work):

- **One resolver seam.** `resolveChatAI(bookId)` is shared verbatim with
  the non-streaming chat route: workspace row (cloud or local-ai binding)
  → shared pool (Phase 2 stage 2) → gated system fallback → fail closed.
- **One transport.** Connector snapshots ride
  `sharedPool.runSharedInference(..., { onDelta, signal })` — the exact
  Phase 2 entry with `params.stream:true` over the connector WS and the
  per-inference slot lifecycle. Private connectors behave exactly as
  before (no pool interaction); SHARED snapshots reserve/release the pool
  slot through the same finally.
- **Cloud providers unchanged upstream.** The cloud branch keeps the
  existing non-streaming `/chat/completions` fetch (safeFetch + SSRF
  guard) and re-emits the full answer as ONE delta + terminal — no second
  upstream protocol, no fake chunk parsing.
- **Correct SSE semantics.** `Content-Type: text/event-stream;
  charset=utf-8`, `Cache-Control: no-cache, no-transform`,
  `Connection: keep-alive`, `X-Accel-Buffering: no` (nginx bypass); 15 s
  `: ping` heartbeat comments keep proxies alive during model cold-loads.

## 2. Terminal-event contract (wire format)

One JSON object per `data:` frame, `event:` typed:

| Event | Payload | Count |
|---|---|---|
| `meta` | `{session_id, ai_source, model}` | once, after resolution |
| `delta` | `{delta}` — visible incremental text | 0..N |
| `done` | `{reply, tool_calls, tool_results, patches_applied, validation_errors, session_id, ai_source, usage?, finish_reason}` | **exactly one** terminal |
| `error` | `{error, code, partial?}` — sanitized code + fixed message only | **exactly one** terminal |

- **done XOR error — exactly one terminal frame, ever** (`sendTerminal` is
  guarded; a mid-flight disconnect suppresses the frame entirely).
- `done.reply` is the FULLY post-processed canonical text (the same
  strip/tool-extract/patch pipeline as the non-streaming route); clients
  converge on it. `<think>` reasoning blocks are filtered out of the delta
  stream incrementally (partial-tag hold-back) and never reach the UI.
- Partial output is never lost: deltas already delivered stay delivered;
  a terminal `error` may carry `partial` (connector-side failures).
- Every failure degrades to the sanitized code surface (Phase 2 §5):
  `shared_unavailable` / `connector_offline` / `busy` / `timeout` /
  `cancelled` / `stream_failed` / `session_closed` / `runtime_error` … —
  raw runtime errors, URLs, credentials and owner detail never cross.
- A client-side `timeout_ms` may tighten the inference window; the cloud
  timer stays authoritative and clamps to the 180 s chat ceiling.

## 3. Cancellation path (critical)

```
HTTP disconnect / AbortSignal / navigation / stop button
  → res 'close' → AbortController
  → connectorChat signal → chat.cancel downstream
  → local runtime abort (SSE read dies with the connector's controller)
  → transport settles `cancelled` → runSharedInference finally → slot released
```

- Applies to EVERY source on the stream route (the non-streaming route
  keeps its existing shared-only semantics unchanged).
- User cancel vs timeout vs runtime death are distinguishable only by
  their sanitized code (`cancelled` / `timeout` / `session_closed`) — the
  slot lifecycle is identical for all of them.
- Verified for: browser disconnect after several deltas, pre-flight abort,
  runtime timeout, connector disconnect, and every failure path releasing
  the slot (`backend/tests/ai-shared-stream.test.js` — C1–C5, CON1–CON2).
  No pending requests (`transport.stats().pending === 0`) and no leaked
  slots after any path.

## 4. Streaming semantics preserved (Phase 5/2 regression intact)

- request_id at-most-once (cloud-generated UUIDs, session-bound pending);
- strict requested-model propagation (the selected model is never
  replaced by another — R1/R2);
- `chat.delta` only for the matching pending streaming request;
- unsolicited/late deltas dropped at zero cost;
- per-delta ≤ 16 KB, cumulative ≤ 32 768 chars (oversized → sanitized
  terminal — S8/S9);
- sanitized errors end-to-end (SEC1–SEC2);
- exactly one terminal response/error on the wire.

## 5. Web UX (existing chat UI — no new surface)

`frontends/app/src/pages/AiAssistantPage.tsx` now rides
`postChatStream` (`src/api/client.ts`) → `/ai/chat/stream`:

- **Streaming states**: text appears incrementally; the typing dots give
  way to the streaming bubble on the first delta.
- **Cancel**: the send button becomes a stop button while generating;
  abort → backend chat.cancel; the partial answer is kept and the bubble
  is marked "Generation stopped" (no error banner, no stuck spinner).
- **Honest terminal states**: completed / cancelled / failed bubbles;
  known backend codes map to localized honest messages
  (`src/features/aiChat/chatStream.ts` — `streamErrorKey`): unavailable,
  no compatible model, shared endpoint offline, runtime unavailable,
  timeout, busy, stream_failed. UI never hangs on any of them.
- **Source indicator**: the `ai_source` safe token from the stream meta/
  done frames maps to a Private AI / Shared AI / Cloud AI / System AI
  badge (`sourceBadgeKey`) on every assistant bubble. The token is all the
  UI ever sees — no connector id, runtime URL, credential or owner
  workspace is sent, so none can leak.
- **Session continuity**: `session_id` arrives via the meta frame;
  partial answers are persisted client-side into the running message
  history; teardown/navigation aborts the in-flight stream.
- i18n: EN + RU (`ai_cancel`, `ai_cancelled`, `ai_state_*`,
  `ai_source_*`).

## 6. Security boundary (unchanged — re-verified)

Everything remains:

```
Browser → Animastor Cloud → registered Connector WS → local runtime
```

Still forbidden (structurally unchanged): browser → runtime URL;
browser → owner's localhost; runtime URL in any API/SSE frame; connector
credentials in SSE; registration tokens after the one-time disclosure;
arbitrary URL / universal proxy / filesystem / shell; a new direct
cloud → runtime HTTP path. The SEC suite scans the FULL SSE wire for
URLs, `llmc.*`/`llmcreg.*`, credential markers, endpoint ids and owner
detail — nothing crosses.

## 7. What is deliberately NOT in Phase 3

- Horizontal scheduler — the pool is still the in-process gate
  (`inflight` Map, phase 1 limitation kept by design); no Redis/global
  scheduler, no distributed concurrency.
- Health probing of a stranger's runtime — still never performed
  (AD-7 discipline; availability is derived from the owner's heartbeat).
- Billing, credits, payments, marketplace, reputation, public profiles,
  usage ledger/counters — untouched, as before.
- Model file transfer, GPU sharing, gpu-hub, workers — untouched (D9).
- A second AI provider system / connector protocol — none introduced.
- Android UI mirror of the streaming UX — backend/API-ready, later step.
- Cloud-branch token-level streaming (the upstream cloud call stays
  non-streaming and is re-emitted as one delta; upstream cloud SSE would
  be a separate, opt-in change).

## 8. Files

- Route: `backend/src/routes/ai-routes.cjs` (`POST /api/v1/ai/chat/stream`,
  `makeThinkFilter`, `processChatReply`, terminal/cancel machinery)
- Tests: `backend/tests/ai-shared-stream.test.js` (28 cases — SSE matrix,
  cancellation/slot lifecycle, resolver regression, security, concurrency,
  one full E2E over the real wire)
- Web client: `frontends/app/src/api/client.ts` (`postChatStream`,
  `ApiError.code`), `frontends/app/src/features/aiChat/chatStream.ts`
  (+ `chatStream.test.ts`), `frontends/app/src/pages/AiAssistantPage.tsx`
  (streaming send/stop/bubble states), `src/styles/base.css` (bubble
  badges/states), `src/app/i18n.ts` (EN/RU), `src/api/models.ts`
  (`AiChatResponse.ai_source`)
- This document.
