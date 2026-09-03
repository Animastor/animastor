// ─────────────────────────────────────────────────────────────────────────
// Local AI Connector UI helpers (Local AI Connector V1 — Phase 6)
// ─────────────────────────────────────────────────────────────────────────
// Pure JVM helpers shared by LocalAiSettingsFragment and its unit tests —
// no Android framework calls (the BetaSettingsHelpers pattern).
//
// Web parity: frontends/app/src/features/localAi/localAi.ts.
//
// Model honesty (spec §7): "discovered" models are ids the runtime REPORTED
// via /v1/models — never claimed as loaded/warm.
//
// SECURITY: the one-time llmcreg.*/llmc.* credentials are disclosed ONLY
// where the backend registration flow provides them; helpers here do shape
// checks only — no storage, no logging.

package com.example.animastor.ui

/** Error keys returned by validation/helpers — mapped to R.string in the fragment. */
object LocalAiHelpers {

    const val MAX_NAME_LEN = 120

    /** The backend RUNTIME_TYPES allowlist (ai-connector-repo). */
    val RUNTIME_TYPES = listOf("ollama", "vllm", "llamacpp", "lmstudio", "openai-compatible")

    data class CreateValidation(
        val ok: Boolean,
        val errorKey: String? = null,
        val name: String? = null,
        val runtimeType: String? = null,
    )

    fun validateCreateInput(name: String, runtimeType: String): CreateValidation {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return CreateValidation(false, "local_ai_name_required")
        if (trimmed.length > MAX_NAME_LEN) return CreateValidation(false, "local_ai_name_too_long")
        if (!RUNTIME_TYPES.contains(runtimeType)) return CreateValidation(false, "local_ai_runtime_invalid")
        return CreateValidation(true, null, trimmed, runtimeType)
    }

    /** A `llmcreg.<id>.<secret>` one-time registration token. */
    fun looksLikeRegToken(token: String?): Boolean {
        if (token == null || token.length < 8) return false
        val parts = token.split(".")
        return parts.size == 3 && parts[0] == "llmcreg" && parts[1].isNotEmpty() && parts[2].isNotEmpty()
    }

    /** A `llmc.<id>.<secret>` persistent credential (disclosed once). */
    fun looksLikeConnectorCredential(token: String?): Boolean {
        if (token == null || token.length < 8) return false
        val parts = token.split(".")
        return parts.size == 3 && parts[0] == "llmc" && parts[1].isNotEmpty() && parts[2].isNotEmpty()
    }

    /** Status label key — the registry `live` flag is authoritative for
     *  Online; a stale PG online row without a live session renders Online
     *  only while PG says so, offline rows never fake liveness. */
    fun statusKey(status: String?, live: Boolean): String = when {
        status == "pending" -> "local_ai_status_pending"
        live || status == "online" -> "local_ai_status_online"
        else -> "local_ai_status_offline"
    }

    /** Runtime reachability is DISTINCT from connector online (§7): the WS
     *  session is alive AND the runtime answered /v1/models (runtime_ok). */
    fun runtimeReachable(runtimeOk: Boolean?): Boolean = runtimeOk == true

    /** Sanitized connector error code → string key. NEVER surface raw
     *  runtime errors, URLs or secrets — the backend sanitizes; this maps
     *  the fixed code vocabulary to localized strings. */
    fun errorKey(code: String?): String = when (code) {
        "connector_offline", "session_closed", "connector_not_bound" -> "local_ai_err_offline"
        "timeout" -> "local_ai_err_timeout"
        "runtime_unreachable" -> "local_ai_err_runtime_unreachable"
        "model_not_found" -> "local_ai_err_model_not_found"
        "busy" -> "local_ai_err_busy"
        "context_length" -> "local_ai_err_context_length"
        "bad_response" -> "local_ai_err_bad_response"
        "runtime_error", "stream_failed" -> "local_ai_err_runtime_error"
        "response_too_large" -> "local_ai_err_response_too_large"
        "request_too_large" -> "local_ai_err_request_too_large"
        "invalid_request" -> "local_ai_err_invalid_request"
        "no_models", "local_ai_not_ready" -> "local_ai_err_no_models"
        "discovery_failed", "persist_failed" -> "local_ai_err_discovery_failed"
        "registration_expired" -> "local_ai_err_registration_expired"
        "registration_already_used" -> "local_ai_err_registration_used"
        else -> "local_ai_err_generic"
    }

    /** Registration token countdown — expired tokens guide the user to
     *  reissue instead of presenting a dead token. */
    fun regTokenExpired(expiresAt: Long?, nowMs: Long = System.currentTimeMillis()): Boolean =
        expiresAt != null && nowMs >= expiresAt

    /**
     * The copy-paste launch command shown in the one-time registration
     * dialog. Mirrors local-ai-connector/README.md (npx package). The
     * command embeds the one-time token the user just received.
     */
    fun buildRunCommand(token: String, wsUrl: String, origin: String): String {
        val base = origin.trimEnd('/')
        return "npx animastor-ai-connector --url $base$wsUrl --token $token"
    }

    /** The provider-binding body for PUT /settings/ai/provider (web parity). */
    fun buildBindingBody(connectorId: String, model: String): Map<String, Any?> = mapOf(
        "provider_type" to "local-ai",
        "connector_id" to connectorId,
        "model" to model.trim(),
    )
}
