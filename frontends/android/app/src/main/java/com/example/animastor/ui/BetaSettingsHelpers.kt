package com.example.animastor.ui

// ─────────────────────────────────────────────────────────────────────────
// Pure helpers for the Experimental Beta settings screens (Phase 3/4).
// Web parity: frontends/app features/workers/privateWorkers.ts and
// features/aiProviders/aiProviders.ts. No Android framework calls — unit
// tested on the JVM (PrivateWorkerHelpersTest / AiProviderHelpersTest).
//
// SECURITY INVARIANT: the plaintext worker credential and the AI api_key are
// ONE-TIME entries. They live only transiently in dialog/fragment memory and
// are NEVER persisted — not in SharedPreferences, files, URLs or logs.
// ─────────────────────────────────────────────────────────────────────────

object BetaSettingsHelpers {

    const val OPENROUTER_DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1"
    const val GENERIC_ENDPOINT_PLACEHOLDER = "https://api.example.com/v1"

    val VALID_PROVIDER_TYPES = listOf("openrouter", "openai-compatible", "custom")
    val VALID_WORKER_TYPES = listOf("audio", "image", "video")

    // ── AI provider validation (web parity: validateProviderInput) ──────

    data class ProviderValidation(
        val ok: Boolean,
        /** i18n key of the error when !ok (ai_provider_*). */
        val errorKey: String? = null,
        val providerType: String = "openai-compatible",
        val endpoint: String = "",
        val model: String? = null,
        /** Present only when a non-blank key was entered. */
        val apiKey: String? = null
    )

    fun validateProviderInput(
        providerType: String,
        endpoint: String,
        apiKey: String,
        model: String,
        isExisting: Boolean
    ): ProviderValidation {
        val type = if (VALID_PROVIDER_TYPES.contains(providerType)) providerType else null
            ?: return ProviderValidation(false, "ai_provider_invalid_type")

        val trimmedEndpoint = endpoint.trim()
        if (trimmedEndpoint.isEmpty()) {
            return ProviderValidation(false, "ai_provider_endpoint_required", type)
        }
        if (!Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(trimmedEndpoint)) {
            return ProviderValidation(false, "ai_provider_endpoint_http", type, trimmedEndpoint)
        }

        val trimmedKey = apiKey.trim()
        // On ADD the key is mandatory. On EDIT an empty key keeps the stored
        // credential (spec §5 edit semantic).
        if (!isExisting && trimmedKey.isEmpty()) {
            return ProviderValidation(
                false, "ai_provider_api_key_required", type, trimmedEndpoint,
                model.ifEmpty { null }
            )
        }

        return ProviderValidation(
            ok = true,
            providerType = type,
            endpoint = trimmedEndpoint,
            model = model.ifEmpty { null },
            apiKey = trimmedKey.ifEmpty { null }
        )
    }

    /** Endpoint placeholder for the given provider type (web parity). */
    fun endpointPlaceholderFor(providerType: String): String =
        if (providerType == "openrouter") OPENROUTER_DEFAULT_ENDPOINT else GENERIC_ENDPOINT_PLACEHOLDER

    /** Relative/short age of an epoch-SECONDS timestamp (last_tested_at). */
    fun formatLastTested(tsSeconds: Long?, nowMs: Long = System.currentTimeMillis()): String {
        if (tsSeconds == null) return "\u2014"
        val ms = tsSeconds * 1000
        val diff = nowMs - ms
        if (diff < 0) return java.text.DateFormat.getDateTimeInstance().format(java.util.Date(ms))
        if (diff < 60_000) return "${maxOf(1, (diff / 1000))}s"
        if (diff < 3_600_000) return "${diff / 60_000}m"
        if (diff < 86_400_000) return "${diff / 3_600_000}h"
        return "${diff / 86_400_000}d"
    }

    // ── Private worker validation (web parity: validateCreateInput) ─────

    data class WorkerCreateValidation(
        val ok: Boolean,
        /** i18n key of the error when !ok (worker_*). */
        val errorKey: String? = null,
        val name: String = "",
        val workerType: String = "audio"
    )

    fun validateCreateInput(name: String, workerType: String): WorkerCreateValidation {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return WorkerCreateValidation(false, "worker_name_required")
        if (trimmed.length > 120) return WorkerCreateValidation(false, "worker_name_too_long")
        if (!VALID_WORKER_TYPES.contains(workerType)) {
            return WorkerCreateValidation(false, "worker_type_invalid")
        }
        return WorkerCreateValidation(true, name = trimmed, workerType = workerType)
    }

    /** A `wrk.<id>.<secret>` token, as issued by the backend one-time. */
    fun looksLikeWorkerToken(token: String?): Boolean {
        if (token == null || token.length < 8) return false
        val parts = token.split(".")
        if (parts.size != 3 || parts[0] != "wrk") return false
        return parts[1].isNotEmpty() && parts[2].isNotEmpty()
    }

    /** Relative/short age of an epoch-ms timestamp (worker last_seen). */
    fun formatLastSeen(tsMs: Long?, nowMs: Long = System.currentTimeMillis()): String {
        if (tsMs == null) return "\u2014"
        val diff = nowMs - tsMs
        if (diff < 0) return java.text.DateFormat.getDateTimeInstance().format(java.util.Date(tsMs))
        if (diff < 60_000) return "${maxOf(1, (diff / 1000))}s"
        if (diff < 3_600_000) return "${diff / 60_000}m"
        if (diff < 86_400_000) return "${diff / 3_600_000}h"
        return "${diff / 86_400_000}d"
    }

    // ── Worker setup contract (web parity: buildSetupContract) ──────────
    // The EXACT env var names worker.cjs reads (HUB_URL,
    // ANIMASTOR_WORKER_TOKEN, WORKER_TYPE, WORKER_ID). Changing these here
    // without the worker breaks Beta.

    data class WorkerSetupContract(
        val hubUrl: String,
        val token: String,
        val workerType: String,
        val workerId: String,
        val sourceUrl: String,
        val downloadCommand: String,
        val runCommand: String
    )

    fun buildSetupContract(baseUrl: String, token: String, workerType: String, workerName: String): WorkerSetupContract {
        val origin = baseUrl.trimEnd('/')
        val hubUrl = "$origin/gpu"
        return WorkerSetupContract(
            hubUrl = hubUrl,
            token = token,
            workerType = workerType,
            workerId = workerName.trim().replace(Regex("\\s+"), "-").lowercase(),
            sourceUrl = "$hubUrl/worker-source",
            downloadCommand = "curl -o worker.cjs $hubUrl/worker-source",
            runCommand = "node worker.cjs"
        )
    }

    /** Render the copyable env block — EXACTLY the vars worker.cjs reads. */
    fun renderEnvBlock(contract: WorkerSetupContract): String = listOf(
        "HUB_URL=${contract.hubUrl}",
        "ANIMASTOR_WORKER_TOKEN=${contract.token}",
        "WORKER_TYPE=${contract.workerType}",
        "WORKER_ID=${contract.workerId}"
    ).joinToString("\n")
}
