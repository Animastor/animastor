// ======================================================
// Provider Gateway — Phase 3 modular boundary
// ======================================================
// The Provider Gateway is a LOGICAL module boundary inside the modular
// monolith — NOT a separate service. It formalizes the three already
// existing AI provider directions as explicit, stable contracts so later
// phases can change internal implementations without breaking consumers:
//
//   ProviderGateway
//   ├── resolve      — provider resolution seam (transport-independent)
//   ├── agent        — non-streaming JSON completions (agent pipelines)
//   ├── chat         — SSE chat transport contract (tools/abort/connector)
//   └── generation   — ComfyUI / GPU generation job dispatch
//
// The three directions are INTENTIONALLY separate. There is deliberately
// NO universal method like `provider.generate(...)` on this facade:
// callAI and the chat transport serve different consumers with different
// protocols (JSON vs SSE, no-tools vs tools lifecycle, no-abort vs
// cancel-on-disconnect) and merging them is forbidden by the Phase 1
// guardrails (tests/architecture/chat-transport.test.js, final review §
// "chat transport vs callAI").
//
// This facade DELEGATES — it does not reimplement. Existing implementation
// stays in place:
//   agent      → services/ai-service.js + services/agent/ai-caller.js
//   chat       → routes/ai-routes.cjs transport + ai-connector/shared-pool.js
//   generation → runtime/gpu-dispatcher.js + generation/comfyui-provider.js
// Docs: docs/architecture/PHASE_3_PROVIDER_GATEWAY.md

const aiService = require('./ai-service');
const aiCaller = require('./agent/ai-caller');
const workspaceAi = require('./workspace-ai-provider');
const gpuDispatcher = require('../runtime/gpu-dispatcher');
const comfyuiProvider = require('../generation/comfyui-provider');

// ── provider resolution (transport-independent seam) ────────────────────
//   workspace/provider config → resolve provider → Provider Gateway →
//   concrete transport (cloud HTTP / connector WS / GPU Hub).
// Delegates to workspace-ai-provider (the existing 3-stage chain:
// workspace row → shared pool → gated system fallback → fail closed).
// The LAC/shared-pool coupling inside the resolver is a CURRENT
// dependency, deliberately not rewritten in Phase 3 (documented seam).
const resolve = {
    forWorkspace: (workspaceId, opts) => workspaceAi.resolveAIForWorkspace(workspaceId, opts),
    forBook: (bookId, opts) => workspaceAi.resolveAIForBook(bookId, opts),
    byPurpose: (workspaceId, purpose) => workspaceAi.resolveAIProvider(workspaceId, purpose),
    systemFallback: () => workspaceAi.resolveSystemFallback(),
};

// ── AGENT provider contract ─────────────────────────────────────────────
// callAI(messages, options, provider) → { content, finishReason, usage }
//   - non-streaming JSON (stream:false upstream);
//   - no SSE, no chat tools lifecycle, no per-turn session persistence;
//   - retries live ABOVE this seam (ai-caller STEP_RETRIES);
//   - connector snapshots ride the shared-pool reservation-aware entry and
//     fail closed with sanitized errors (never a silent system-AI fallback).
const agent = {
    callAI: (messages, options = {}, provider = null) => aiService.callAI(messages, options, provider),
    callForPipeline: (messages, options) => aiCaller.callAI(messages, options),
    parseJsonResponse: (content) => aiService.parseJsonResponse(content),
    checkAIHealth: (cfg, provider) => aiService.checkAIHealth(cfg, provider),
    runWithProvider: (provider, fn) => aiCaller.runWithProvider(provider, fn),
    getActiveProvider: () => aiCaller.getActiveProvider(),
};

// ── CHAT provider contract ──────────────────────────────────────────────
// The chat transport itself lives in routes/ai-routes.cjs (SSE + tools +
// cancellation + session persistence). The gateway owns the pieces a chat
// consumer must be able to reach WITHOUT importing route internals:
// provider resolution for chat, the connector inference entry, the
// sanitized error surface and the safe ai_source tokens.
const chat = {
    /**
     * Resolve the chat provider for a book — the SAME seam the chat routes
     * use (moved verbatim from routes/ai-routes.cjs resolveChatAI in Phase 3).
     * Connector snapshots get the first DISCOVERED model when no model is
     * bound (discovered ≠ loaded); cloud snapshots keep the workspace/env
     * model chain. The route passes its own fallback base URL
     * (chatEngine.AI_API_BASE_URL) — the gateway does not know chat-engine
     * internals.
     */
    async resolveProvider(bookId, { fallbackBaseUrl } = {}) {
        const provider = bookId
            ? await workspaceAi.resolveAIForBook(bookId, { purpose: 'chat' })
            : await workspaceAi.resolveSystemFallback();
        if (provider && provider.transport === 'connector') {
            let model = provider.model || null;
            if (!model && provider.connectorId) {
                try {
                    const { getConnector } = require('../storage/postgres/repositories/ai-connector-repo');
                    const row = await getConnector(provider.connectorId);
                    const models = Array.isArray(row && row.models) ? row.models : [];
                    if (models.length > 0) model = String(models[0]);
                } catch (_) { /* transport reports the honest error downstream */ }
            }
            return {
                transport: 'connector',
                connectorId: provider.connectorId,
                baseUrl: null,
                apiKey: '',
                model: model || '',
                source: provider.source,
                shared: provider.shared || null,
                workspaceId: provider.workspaceId || null,
                validatePublic: false,
            };
        }
        return {
            baseUrl: provider.endpoint || fallbackBaseUrl,
            apiKey: provider.apiKey || '',
            model: provider.model || process.env.AI_MODEL || 'qwen/qwen3-32b',
            source: provider.source,
            shared: null,
            workspaceId: null,
            // Only the user-controlled workspace endpoint is an SSRF surface;
            // operator-controlled env config (system fallback) is trusted.
            validatePublic: provider.source === 'workspace' && !!provider.endpoint,
        };
    },

    /**
     * Map a resolved chat provider snapshot to the SAFE consumer-facing
     * ai_source token (Phase 2 §6 discipline): 'private-local' | 'shared' |
     * 'cloud' | 'system' — never endpoint/owner detail. Moved verbatim from
     * routes/ai-routes.cjs chatAiSourceToken.
     */
    sourceToken(ai) {
        if (ai.transport === 'connector') return ai.source === 'shared' ? 'shared' : 'private-local';
        if (ai.source === 'workspace') return 'cloud';
        if (ai.source === 'system') return 'system';
        return ai.source || 'system';
    },

    // Connector/shared inference: reservation-aware entry (per-inference
    // slot lifecycle) — the same seam the routes and ai-service use.
    // Sanitized codes only, never raw runtime detail.
    runSharedInference: (...args) => require('./ai-connector/shared-pool').runSharedInference(...args),
    describeSharedError: (...args) => require('./ai-connector/shared-pool').describeSharedError(...args),

    DEFAULT_TIMEOUT_MS: 180_000,
    SSE_EVENTS: ['meta', 'delta', 'done', 'error'],
    SOURCE_TOKENS: ['private-local', 'shared', 'cloud', 'system'],
};

// ── GENERATION provider contract ────────────────────────────────────────
// generate(request, context) → job/result, expressed with the CURRENT
// protocol shape: a ComfyUI workflow job spec dispatched to the GPU Hub
// (Job Protocol v2). Provider-specific workflow knowledge (workflow JSON,
// node mapping) stays inside the generation domain — the gateway only
// exposes the dispatch boundary and the ComfyUIProvider seam.
const GENERATION_JOB_TYPES = ['audio', 'image', 'video'];

const generation = {
    // dispatch boundary — backend → GPU Hub POST /task (sendUnified owns
    // routing, timeouts and the server-derived workspace lane).
    sendJob: (taskSpec) => gpuDispatcher.sendUnified(taskSpec),
    JOB_TYPES: GENERATION_JOB_TYPES,
    // Provider-specific seam: ComfyUI workflows/connectors. The workflow
    // implementations are NOT rewritten in Phase 3; this seam is the
    // future single entry for generation code that still touches
    // workflow-loader / gpu.send directly (see docs, §Current gaps).
    comfyui: comfyuiProvider,
};

module.exports = {
    DIRECTIONS: ['agent', 'chat', 'generation'],
    resolve,
    agent,
    chat,
    generation,
};
