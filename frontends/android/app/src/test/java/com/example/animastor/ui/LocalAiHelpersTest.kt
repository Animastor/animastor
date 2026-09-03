// ─────────────────────────────────────────────────────────────────────────
// Local AI Connector helper tests (Local AI Connector V1 — Phase 6)
// Web parity: frontends/app/src/features/localAi/localAi.test.ts
// ─────────────────────────────────────────────────────────────────────────
package com.example.animastor.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalAiHelpersTest {

    // ── create validation ─────────────────────────────────────────────────

    @Test
    fun create_validInput() {
        val v = LocalAiHelpers.validateCreateInput("  Home Ollama ", "ollama")
        assertTrue(v.ok)
        assertEquals("Home Ollama", v.name)
        assertEquals("ollama", v.runtimeType)
    }

    @Test
    fun create_nameRequired() {
        val v = LocalAiHelpers.validateCreateInput("   ", "vllm")
        assertFalse(v.ok)
        assertEquals("local_ai_name_required", v.errorKey)
    }

    @Test
    fun create_nameTooLong() {
        assertFalse(LocalAiHelpers.validateCreateInput("x".repeat(121), "ollama").ok)
        assertTrue(LocalAiHelpers.validateCreateInput("x".repeat(120), "ollama").ok)
    }

    @Test
    fun create_runtimeMustBeValid() {
        val v = LocalAiHelpers.validateCreateInput("Home", "anthropic")
        assertFalse(v.ok)
        assertEquals("local_ai_runtime_invalid", v.errorKey)
    }

    @Test
    fun create_runtimeAllowlistMatchesBackend() {
        // The backend ai-connector-repo RUNTIME_TYPES, verbatim.
        assertEquals(
            listOf("ollama", "vllm", "llamacpp", "lmstudio", "openai-compatible"),
            LocalAiHelpers.RUNTIME_TYPES,
        )
    }

    // ── token shapes (one-time disclosures) ───────────────────────────────

    @Test
    fun tokenShape_registration() {
        assertTrue(LocalAiHelpers.looksLikeRegToken("llmcreg.abc.def"))
        assertFalse(LocalAiHelpers.looksLikeRegToken("llmc.abc.def"))
        assertFalse(LocalAiHelpers.looksLikeRegToken("wrk.abc.def"))
        assertFalse(LocalAiHelpers.looksLikeRegToken(null))
        assertFalse(LocalAiHelpers.looksLikeRegToken("llmcreg.onlyonepart"))
    }

    @Test
    fun tokenShape_credential() {
        assertTrue(LocalAiHelpers.looksLikeConnectorCredential("llmc.abc.def"))
        assertFalse(LocalAiHelpers.looksLikeConnectorCredential("llmcreg.abc.def"))
        assertFalse(LocalAiHelpers.looksLikeConnectorCredential("llmc.abc"))
    }

    // ── status mapping (registry truth beats stale rows) ──────────────────

    @Test
    fun status_pending() {
        assertEquals("local_ai_status_pending", LocalAiHelpers.statusKey("pending", live = false))
    }

    @Test
    fun status_liveSessionIsOnline() {
        assertEquals("local_ai_status_online", LocalAiHelpers.statusKey("online", live = true))
        assertEquals("local_ai_status_online", LocalAiHelpers.statusKey("offline", live = true))
    }

    @Test
    fun status_offlineHonest() {
        assertEquals("local_ai_status_offline", LocalAiHelpers.statusKey("offline", live = false))
        assertEquals("local_ai_status_offline", LocalAiHelpers.statusKey(null, live = false))
    }

    // ── runtime reachability is distinct from online (§7) ─────────────────

    @Test
    fun runtimeReachability_failsHonest() {
        assertTrue(LocalAiHelpers.runtimeReachable(true))
        assertFalse(LocalAiHelpers.runtimeReachable(false))
        assertFalse(LocalAiHelpers.runtimeReachable(null))
    }

    // ── sanitized error mapping ───────────────────────────────────────────

    @Test
    fun errorMapping_coversBackendVocabulary() {
        val known = listOf(
            "connector_offline", "session_closed", "timeout", "runtime_unreachable",
            "model_not_found", "busy", "context_length", "bad_response", "runtime_error",
            "response_too_large", "request_too_large", "invalid_request", "stream_failed",
            "no_models", "connector_not_bound", "discovery_failed", "persist_failed",
            "registration_expired", "registration_already_used", "local_ai_not_ready",
        )
        for (code in known) {
            val key = LocalAiHelpers.errorKey(code)
            assertTrue(key.startsWith("local_ai_err_"))
            assertTrue(key != "local_ai_err_generic")
        }
    }

    @Test
    fun errorMapping_unknownDegradesToGeneric() {
        assertEquals("local_ai_err_generic", LocalAiHelpers.errorKey("something_new"))
        assertEquals("local_ai_err_generic", LocalAiHelpers.errorKey(null))
        assertEquals("local_ai_err_generic", LocalAiHelpers.errorKey(""))
    }

    // ── registration token expiry ─────────────────────────────────────────

    @Test
    fun regTokenExpiry() {
        val now = 1_700_000_000_000L
        assertTrue(LocalAiHelpers.regTokenExpired(now - 1, now))
        assertFalse(LocalAiHelpers.regTokenExpired(now + 60_000, now))
        assertFalse(LocalAiHelpers.regTokenExpired(null, now))
    }

    // ── launch command mirrors the CLI contract ───────────────────────────

    @Test
    fun runCommand_buildsAgainstOriginAndWsPath() {
        assertEquals(
            "npx animastor-ai-connector --url https://animastor.example/api/v1/ai-connector/ws --token llmcreg.abc.def",
            LocalAiHelpers.buildRunCommand(
                "llmcreg.abc.def",
                "/api/v1/ai-connector/ws",
                "https://animastor.example",
            ),
        )
    }

    @Test
    fun runCommand_stripsTrailingSlashes() {
        val cmd = LocalAiHelpers.buildRunCommand("llmcreg.a.b", "/api/v1/ai-connector/ws", "https://x.example/")
        assertTrue(cmd.contains("--url https://x.example/api/v1/ai-connector/ws"))
    }

    // ── provider binding body (web parity) ────────────────────────────────

    @Test
    fun bindingBody_carriesConnectorAndTrimmedModel() {
        val body = LocalAiHelpers.buildBindingBody("c-1", "  qwen3:32b ")
        assertEquals(
            mapOf<String, Any?>(
                "provider_type" to "local-ai",
                "connector_id" to "c-1",
                "model" to "qwen3:32b",
            ),
            body,
        )
    }
}
