// ─────────────────────────────────────────────────────────────────────────
// Local AI Connector DTOs (Local AI Connector V1 — Phase 6)
// ─────────────────────────────────────────────────────────────────────────
// 1:1 with backend/src/routes/ai-connector-routes.cjs + settings-ai-routes.cjs.
// NEVER carries credential material: the status/models/detail surfaces
// return no token fields at all; the reg_token/token fields exist ONLY on
// the one-time disclosure responses (create / reissue / rotate) and live in
// transient fragment state, never persisted.
package com.example.animastor.repository

import com.google.gson.annotations.SerializedName

data class AiConnector(
    @SerializedName("connector_id") val connectorId: String,
    @SerializedName("workspace_id") val workspaceId: String? = null,
    @SerializedName("name") val name: String,
    @SerializedName("runtime_type") val runtimeType: String,
    @SerializedName("status") val status: String, // pending | online | offline
    @SerializedName("token_prefix") val tokenPrefix: String? = null,
    @SerializedName("last_seen") val lastSeen: Long? = null, // epoch ms
    @SerializedName("models") val models: List<String>? = null,
    @SerializedName("capabilities") val capabilities: AiConnectorCapabilities? = null,
    @SerializedName("runtime_meta") val runtimeMeta: AiConnectorRuntimeMeta? = null,
    @SerializedName("revoked_at") val revokedAt: Long? = null,
    @SerializedName("created_at") val createdAt: Long? = null,
)

data class AiConnectorCapabilities(
    @SerializedName("tools") val tools: Boolean? = null,
    @SerializedName("vision") val vision: Boolean? = null,
    @SerializedName("context") val context: Long? = null,
)

data class AiConnectorRuntimeMeta(
    @SerializedName("runtime_ok") val runtimeOk: Boolean? = null,
    @SerializedName("latency_ms") val latencyMs: Long? = null,
    @SerializedName("runtime") val runtime: AiConnectorRuntimeInfo? = null,
)

data class AiConnectorRuntimeInfo(
    @SerializedName("type") val type: String? = null,
    @SerializedName("version") val version: String? = null,
)

/** GET /api/v1/ai-connector/status — live flag from the WS registry. */
data class AiConnectorStatusRow(
    @SerializedName("connector_id") val connectorId: String,
    @SerializedName("name") val name: String,
    @SerializedName("runtime_type") val runtimeType: String,
    @SerializedName("status") val status: String,
    @SerializedName("live") val live: Boolean = false,
    @SerializedName("last_seen") val lastSeen: Long? = null,
    @SerializedName("models_count") val modelsCount: Int = 0,
    @SerializedName("capabilities") val capabilities: AiConnectorCapabilities? = null,
    @SerializedName("runtime_meta") val runtimeMeta: AiConnectorRuntimeMeta? = null,
    @SerializedName("created_at") val createdAt: Long? = null,
)

data class AiConnectorStatusResponse(
    @SerializedName("connectors") val connectors: List<AiConnectorStatusRow> = emptyList(),
)

/** GET /api/v1/ai-connector/models — PG read-only, never a runtime fetch. */
data class AiConnectorModelsRow(
    @SerializedName("connector_id") val connectorId: String,
    @SerializedName("name") val name: String,
    @SerializedName("runtime_type") val runtimeType: String,
    @SerializedName("status") val status: String,
    @SerializedName("live") val live: Boolean = false,
    @SerializedName("last_seen") val lastSeen: Long? = null,
    @SerializedName("models") val models: List<String> = emptyList(),
)

data class AiConnectorModelsResponse(
    @SerializedName("connectors") val connectors: List<AiConnectorModelsRow> = emptyList(),
)

/** POST /api/v1/ai-connector/registrations — one-time reg token disclosure. */
data class CreateAiConnectorRequest(
    @SerializedName("name") val name: String,
    @SerializedName("runtime_type") val runtimeType: String,
)

data class CreateAiConnectorResponse(
    @SerializedName("connector") val connector: AiConnector,
    @SerializedName("reg_token") val regToken: String, // one-time disclosure
    @SerializedName("reg_expires_at") val regExpiresAt: Long? = null,
    @SerializedName("ws_url") val wsUrl: String? = null,
)

/** GET /registrations/:id/token — re-arm (pending only). Same shape as create. */
data class ReissueAiConnectorTokenResponse(
    @SerializedName("connector") val connector: AiConnector,
    @SerializedName("reg_token") val regToken: String, // one-time disclosure
    @SerializedName("reg_expires_at") val regExpiresAt: Long? = null,
    @SerializedName("ws_url") val wsUrl: String? = null,
)

/** POST /ai-connector/connectors/:id/models/refresh — explicit discovery. */
data class RefreshAiConnectorModelsResponse(
    @SerializedName("ok") val ok: Boolean,
    @SerializedName("models") val models: List<String>? = null,
    @SerializedName("code") val code: String? = null, // sanitized code only
)

/** POST /ai-connector/connectors/:id/rotate — one-time llmc.* disclosure. */
data class RotateAiConnectorResponse(
    @SerializedName("connector") val connector: AiConnector,
    @SerializedName("token") val token: String, // one-time disclosure
)

/** DELETE /ai-connector/connectors/:id */
data class RevokeAiConnectorResponse(
    @SerializedName("revoked") val revoked: Boolean,
)

/** POST /settings/ai/test — connector path (max_tokens:1 probe). */
data class TestAiConnectorResponse(
    @SerializedName("ok") val ok: Boolean,
    @SerializedName("model") val model: String? = null,
    @SerializedName("error") val error: String? = null,
    @SerializedName("code") val code: String? = null, // sanitized code only
)
