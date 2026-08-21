package com.example.animastor.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Experimental Beta helpers — pure JVM tests (web parity:
// frontends/app features/workers/privateWorkers.test.ts and
// features/aiProviders/aiProviders.test.ts). BetaSettingsHelpers.kt has no
// Android framework calls.
class BetaSettingsHelpersTest {

    // ── AI provider validation (validateProviderInput) ──────────────────

    @Test
    fun provider_addRequiresApiKey() {
        val v = BetaSettingsHelpers.validateProviderInput(
            "openai-compatible", "https://api.example.com/v1", "", "", isExisting = false
        )
        assertFalse(v.ok)
        assertEquals("ai_provider_api_key_required", v.errorKey)
    }

    @Test
    fun provider_editAllowsEmptyApiKey() {
        val v = BetaSettingsHelpers.validateProviderInput(
            "openai-compatible", "https://api.example.com/v1", "", "my-model", isExisting = true
        )
        assertTrue(v.ok)
        assertNull(v.apiKey) // empty key = keep the stored credential
        assertEquals("my-model", v.model)
    }

    @Test
    fun provider_rejectsNonHttpEndpoint() {
        for (bad in listOf("javascript:alert(1)", "file:///etc/passwd", "data:text/plain,x", "ftp://x")) {
            val v = BetaSettingsHelpers.validateProviderInput(
                "custom", bad, "sk-123", "", isExisting = false
            )
            assertFalse(v.ok)
            assertEquals("ai_provider_endpoint_http", v.errorKey)
        }
    }

    @Test
    fun provider_rejectsEmptyEndpoint() {
        val v = BetaSettingsHelpers.validateProviderInput(
            "custom", "   ", "sk-123", "", isExisting = false
        )
        assertFalse(v.ok)
        assertEquals("ai_provider_endpoint_required", v.errorKey)
    }

    @Test
    fun provider_rejectsUnknownType() {
        val v = BetaSettingsHelpers.validateProviderInput(
            "azure", "https://api.example.com/v1", "sk-123", "", isExisting = false
        )
        assertFalse(v.ok)
        assertEquals("ai_provider_invalid_type", v.errorKey)
    }

    @Test
    fun provider_acceptsAllValidTypes() {
        for (type in listOf("openrouter", "openai-compatible", "custom")) {
            val v = BetaSettingsHelpers.validateProviderInput(
                type, "https://api.example.com/v1", "sk-123", "", isExisting = false
            )
            assertTrue(v.ok)
            assertEquals(type, v.providerType)
            assertEquals("sk-123", v.apiKey)
        }
    }

    @Test
    fun provider_openrouterDefaultEndpoint() {
        assertEquals(
            "https://openrouter.ai/api/v1",
            BetaSettingsHelpers.endpointPlaceholderFor("openrouter")
        )
        assertEquals(
            "https://api.example.com/v1",
            BetaSettingsHelpers.endpointPlaceholderFor("custom")
        )
    }

    @Test
    fun provider_formatLastTested_epochSeconds() {
        val now = 1_000_000_000_000L
        assertEquals("\u2014", BetaSettingsHelpers.formatLastTested(null, now))
        assertEquals("30s", BetaSettingsHelpers.formatLastTested((now - 30_000) / 1000, now))
        assertEquals("5m", BetaSettingsHelpers.formatLastTested((now - 5 * 60_000) / 1000, now))
        assertEquals("2h", BetaSettingsHelpers.formatLastTested((now - 2 * 3_600_000) / 1000, now))
        assertEquals("3d", BetaSettingsHelpers.formatLastTested((now - 3 * 86_400_000) / 1000, now))
    }

    // ── Private worker validation (validateCreateInput) ─────────────────

    @Test
    fun worker_nameRequired() {
        val v = BetaSettingsHelpers.validateCreateInput("   ", "audio")
        assertFalse(v.ok)
        assertEquals("worker_name_required", v.errorKey)
    }

    @Test
    fun worker_nameTooLong() {
        val v = BetaSettingsHelpers.validateCreateInput("x".repeat(121), "audio")
        assertFalse(v.ok)
        assertEquals("worker_name_too_long", v.errorKey)
    }

    @Test
    fun worker_typeMustBeValid() {
        val v = BetaSettingsHelpers.validateCreateInput("gpu-1", "vbook")
        assertFalse(v.ok)
        assertEquals("worker_type_invalid", v.errorKey)
    }

    @Test
    fun worker_validCreate() {
        val v = BetaSettingsHelpers.validateCreateInput("  Home RTX 3090  ", "video")
        assertTrue(v.ok)
        assertEquals("Home RTX 3090", v.name)
        assertEquals("video", v.workerType)
    }

    @Test
    fun worker_tokenShape() {
        assertTrue(BetaSettingsHelpers.looksLikeWorkerToken("wrk.abc123.secret456"))
        assertFalse(BetaSettingsHelpers.looksLikeWorkerToken(null))
        assertFalse(BetaSettingsHelpers.looksLikeWorkerToken(""))
        assertFalse(BetaSettingsHelpers.looksLikeWorkerToken("short"))
        assertFalse(BetaSettingsHelpers.looksLikeWorkerToken("usr.abc.secret"))
        assertFalse(BetaSettingsHelpers.looksLikeWorkerToken("wrk..secret"))
        assertFalse(BetaSettingsHelpers.looksLikeWorkerToken("wrk.abc."))
    }

    @Test
    fun worker_formatLastSeen_epochMs() {
        val now = 1_000_000_000_000L
        assertEquals("\u2014", BetaSettingsHelpers.formatLastSeen(null, now))
        assertEquals("1s", BetaSettingsHelpers.formatLastSeen(now - 500, now))
        assertEquals("45s", BetaSettingsHelpers.formatLastSeen(now - 45_000, now))
        assertEquals("10m", BetaSettingsHelpers.formatLastSeen(now - 10 * 60_000, now))
        assertEquals("3h", BetaSettingsHelpers.formatLastSeen(now - 3 * 3_600_000, now))
        assertEquals("2d", BetaSettingsHelpers.formatLastSeen(now - 2 * 86_400_000, now))
    }

    // ── Worker setup contract (buildSetupContract / renderEnvBlock) ─────

    @Test
    fun worker_setupContract_matchesWorkerCjsEnv() {
        val c = BetaSettingsHelpers.buildSetupContract(
            baseUrl = "https://app.animastor.in/",
            token = "wrk.abc.secret",
            workerType = "image",
            workerName = "Home RTX 3090"
        )
        assertEquals("https://app.animastor.in/gpu", c.hubUrl)
        assertEquals("https://app.animastor.in/gpu/worker-source", c.sourceUrl)
        assertEquals("curl -o worker.cjs https://app.animastor.in/gpu/worker-source", c.downloadCommand)
        assertEquals("node worker.cjs", c.runCommand)
        assertEquals("home-rtx-3090", c.workerId)

        // EXACT env var names worker.cjs reads — the contract must not drift.
        assertEquals(
            "HUB_URL=https://app.animastor.in/gpu\n" +
                "ANIMASTOR_WORKER_TOKEN=wrk.abc.secret\n" +
                "WORKER_TYPE=image\n" +
                "WORKER_ID=home-rtx-3090",
            BetaSettingsHelpers.renderEnvBlock(c)
        )
    }
}
