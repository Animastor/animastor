// ======================================================
// Runtime adapter seam — the allowlist (AD-5, §3.4, §10.1, §6)
// ======================================================
// Every runtime operation the connector performs goes through this registry.
// It is a structural allowlist, NOT a proxy: each runtime type maps to ONE
// adapter, and each adapter supports only its explicitly declared operations
// with fixed paths built from the LOCAL base URL. Adding vLLM / llama.cpp /
// LM Studio later means adding an adapter entry here — the WS protocol and
// the session layer never change.
//
// V1: one `openai-compatible` adapter covers all four runtimes (§6) —
// `runtime_type` is a UI label, not a behavioral branch on the cloud side.
// ======================================================

const openaiCompatible = require('./openai-compatible.cjs');

// Runtime types (mirror of the cloud-side ai_connectors allowlist).
const RUNTIME_TYPES = ['ollama', 'vllm', 'llamacpp', 'lmstudio', 'openai-compatible'];

const ADAPTER_FOR_RUNTIME = {
    ollama: 'openai-compatible',
    vllm: 'openai-compatible',
    llamacpp: 'openai-compatible',
    lmstudio: 'openai-compatible',
    'openai-compatible': 'openai-compatible',
};

/**
 * Resolve the adapter for a runtime type. Unknown types fail closed —
 * the connector refuses to run against a runtime it cannot classify.
 * @returns {Function|null} discoverModels implementation or null
 */
function getAdapter(runtimeType) {
    return ADAPTER_FOR_RUNTIME[runtimeType] ? openaiCompatible : null;
}

module.exports = {
    RUNTIME_TYPES,
    getAdapter,
    discoverModels: openaiCompatible.discoverModels,
    normalizeOpenAiModels: openaiCompatible.normalizeOpenAiModels,
    isLoopbackBase: openaiCompatible.isLoopbackBase,
};
