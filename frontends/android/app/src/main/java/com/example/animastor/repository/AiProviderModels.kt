package com.example.animastor.repository

// ======================================================
// Workspace AI Provider models (Experimental Beta — Phase 4)
// ======================================================
// 1:1 with the backend shapes in routes/settings-ai-routes.cjs (web parity:
// frontends/app features/aiProviders/aiProviders.ts). The meta NEVER carries
// the plaintext api_key — only safe metadata + the masked hint. The plaintext
// key is a ONE-TIME client→server entry (PUT body) and is never persisted or
// echoed back.

data class AiProviderMeta(
    val workspace_id: String? = null,
    val provider: String? = null,
    val provider_type: String? = null,
    val endpoint: String? = null,
    val model: String? = null,
    val enabled: Boolean = true,
    val configured: Boolean = false,
    val has_api_key: Boolean = false,
    val api_key_masked: String? = null,
    /** "ok" | "failed" | "untested" — persisted by Test Connection. */
    val status: String? = null,
    /** Epoch SECONDS (PG BIGINT), not ms. */
    val last_tested_at: Long? = null,
    val created_at: Long? = null,
    val updated_at: Long? = null
)

data class AiProviderRead(
    val provider: AiProviderMeta? = null,
    val has_workspace_provider: Boolean = false
)

data class AiProviderUpsertResponse(
    val provider: AiProviderMeta? = null
)

data class AiProviderDeleteResponse(
    val deleted: Boolean = false,
    val has_workspace_provider: Boolean = false
)

data class AiProviderTestResponse(
    val ok: Boolean = false,
    val model: String? = null,
    val status: Int? = null,
    val error: String? = null
    // never includes apiKey — the backend strips it.
)
