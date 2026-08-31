package com.example.animastor.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Parallel AI Analysis — pure state machine tests (web parity f661a922,
 * frontends/app/src/state/generateStore.analysis.test.ts — 19-test suite).
 *
 * Validates the contract the Generate screen depends on:
 *  1. applyAnalysisEvent is PURE — same input → same output.
 *  2. Reset wipes state cleanly (no leaked timestamps).
 *  3. Concurrent running tasks produce a coherent overall %.
 *  4. Sequential mode routing does NOT populate the state.
 *  5. Cancellation propagates; timers freeze.
 *  6. analysis_mode / analysis_parallelism coercion (layer-config roundtrip).
 *
 * Timers are injected (nowMs) — no wall-clock dependency, fully deterministic.
 */
class AnalysisProgressTest {

    // ── applyAnalysisEvent — pure transition ─────────────────────────

    @Test
    fun `unknown task id event leaves state unchanged`() {
        val prev = resetAnalysisProgress()
        val next = applyProgressEventToAnalysis(
            prev, type = "analysis", stage = null, task = "cover", status = "running",
            durationMs = null, error = null,
            analysisCompleted = null, analysisFailed = null, analysisTotal = null, nowMs = 1000L
        )
        assertEquals(prev, next)
        assertFalse(next.active)
    }

    @Test
    fun `first event of any task marks active`() {
        val next = applyAnalysisEvent(resetAnalysisProgress(), AnalysisTaskId.CHARACTERS, "running", null, null, nowMs = 1000L)
        assertTrue(next.active)
        assertEquals(AnalysisStatus.RUNNING, next.tasks[AnalysisTaskId.CHARACTERS]!!.status)
    }

    @Test
    fun `pending to running starts the phase timer`() {
        val p1 = applyAnalysisEvent(resetAnalysisProgress(), AnalysisTaskId.CHARACTERS, "pending", null, null, nowMs = 900L)
        assertEquals(AnalysisStatus.PENDING, p1.tasks[AnalysisTaskId.CHARACTERS]!!.status)
        assertNull(p1.phaseStartedAt)

        val p2 = applyAnalysisEvent(p1, AnalysisTaskId.CHARACTERS, "running", null, null, nowMs = 1000L)
        assertEquals(AnalysisStatus.RUNNING, p2.tasks[AnalysisTaskId.CHARACTERS]!!.status)
        assertEquals(1000L, p2.tasks[AnalysisTaskId.CHARACTERS]!!.startedAt)
        assertEquals(1000L, p2.phaseStartedAt)
    }

    @Test
    fun `running to completed freezes the task timer`() {
        val p1 = applyAnalysisEvent(resetAnalysisProgress(), AnalysisTaskId.CHARACTERS, "running", null, null, nowMs = 1000L)
        val p2 = applyAnalysisEvent(p1, AnalysisTaskId.CHARACTERS, "completed", durationMs = 18_000L, error = null, nowMs = 1900L)
        val row = p2.tasks[AnalysisTaskId.CHARACTERS]!!
        assertEquals(AnalysisStatus.COMPLETED, row.status)
        assertEquals(18_000L, row.durationMs)
        assertEquals(1000L + 18_000L, row.finishedAt)
        assertEquals(1, p2.completedTasks)
    }

    @Test
    fun `running to failed keeps siblings and surfaces error`() {
        var p = applyAnalysisEvent(resetAnalysisProgress(), AnalysisTaskId.CHARACTERS, "running", null, null, nowMs = 1000L)
        p = applyAnalysisEvent(p, AnalysisTaskId.LOCATIONS, "running", null, null, nowMs = 1100L)
        p = applyAnalysisEvent(p, AnalysisTaskId.LOCATIONS, "failed", durationMs = 5_000L, error = "LLM timeout", nowMs = 1200L)

        assertEquals(AnalysisStatus.FAILED, p.tasks[AnalysisTaskId.LOCATIONS]!!.status)
        assertEquals("LLM timeout", p.tasks[AnalysisTaskId.LOCATIONS]!!.error)
        // Failure isolation — the running sibling is untouched.
        assertEquals(AnalysisStatus.RUNNING, p.tasks[AnalysisTaskId.CHARACTERS]!!.status)
        assertEquals(1, p.failedTasks)
        assertEquals(0, p.completedTasks)
    }

    @Test
    fun `running to cancelled freezes timers`() {
        var p = applyAnalysisEvent(resetAnalysisProgress(), AnalysisTaskId.VOICES, "running", null, null, nowMs = 1000L)
        p = applyAnalysisEvent(p, AnalysisTaskId.VOICES, "cancelled", null, null, nowMs = 2500L)
        val row = p.tasks[AnalysisTaskId.VOICES]!!
        assertEquals(AnalysisStatus.CANCELLED, row.status)
        assertNotNull(row.startedAt)
        assertNotNull(row.finishedAt)
        assertEquals(1, p.cancelledTasks)
    }

    @Test
    fun `two tasks can run simultaneously (parallel)`() {
        var p = applyAnalysisEvent(resetAnalysisProgress(), AnalysisTaskId.CHARACTERS, "running", null, null, nowMs = 1000L)
        p = applyAnalysisEvent(p, AnalysisTaskId.LOCATIONS, "running", null, null, nowMs = 1200L)
        assertEquals(AnalysisStatus.RUNNING, p.tasks[AnalysisTaskId.CHARACTERS]!!.status)
        assertEquals(AnalysisStatus.RUNNING, p.tasks[AnalysisTaskId.LOCATIONS]!!.status)
        assertEquals(AnalysisStatus.PENDING, p.tasks[AnalysisTaskId.VOICES]!!.status)
    }

    @Test
    fun `all tasks terminal sets phaseFinishedAt`() {
        var p = applyAnalysisEvent(resetAnalysisProgress(), AnalysisTaskId.CHARACTERS, "running", null, null, nowMs = 1000L)
        p = applyAnalysisEvent(p, AnalysisTaskId.LOCATIONS, "running", null, null, nowMs = 1100L)
        p = applyAnalysisEvent(p, AnalysisTaskId.VOICES, "running", null, null, nowMs = 1200L)
        assertNull(p.phaseFinishedAt)
        p = applyAnalysisEvent(p, AnalysisTaskId.CHARACTERS, "completed", durationMs = 10_000L, error = null, nowMs = 1300L)
        p = applyAnalysisEvent(p, AnalysisTaskId.LOCATIONS, "completed", durationMs = 12_000L, error = null, nowMs = 1400L)
        p = applyAnalysisEvent(p, AnalysisTaskId.VOICES, "completed", durationMs = 14_000L, error = null, nowMs = 1500L)
        assertNotNull(p.phaseFinishedAt)
        assertEquals(1_500L - 1_000L, p.phaseDurationMs)
        assertTrue(p.allTerminal)
    }

    @Test
    fun `mixed completed and failed still finishes the phase (failure isolation)`() {
        var p = applyAnalysisEvent(resetAnalysisProgress(), AnalysisTaskId.CHARACTERS, "running", null, null, nowMs = 1000L)
        p = applyAnalysisEvent(p, AnalysisTaskId.CHARACTERS, "completed", durationMs = 10_000L, error = null, nowMs = 1100L)
        p = applyAnalysisEvent(p, AnalysisTaskId.LOCATIONS, "running", null, null, nowMs = 1200L)
        p = applyAnalysisEvent(p, AnalysisTaskId.LOCATIONS, "failed", durationMs = 3_000L, error = "boom", nowMs = 1300L)
        p = applyAnalysisEvent(p, AnalysisTaskId.VOICES, "running", null, null, nowMs = 1400L)
        p = applyAnalysisEvent(p, AnalysisTaskId.VOICES, "completed", durationMs = 4_000L, error = null, nowMs = 1500L)
        assertNotNull(p.phaseFinishedAt)
        assertEquals(2, p.completedTasks)
        assertEquals(1, p.failedTasks)
    }

    @Test
    fun `all tasks cancelled sets phaseFinishedAt and counts`() {
        var p = applyAnalysisEvent(resetAnalysisProgress(), AnalysisTaskId.CHARACTERS, "running", null, null, nowMs = 1000L)
        p = applyAnalysisEvent(p, AnalysisTaskId.CHARACTERS, "cancelled", null, null, nowMs = 1100L)
        p = applyAnalysisEvent(p, AnalysisTaskId.LOCATIONS, "pending", null, null, nowMs = 1150L)
        p = applyAnalysisEvent(p, AnalysisTaskId.LOCATIONS, "cancelled", null, null, nowMs = 1200L)
        p = applyAnalysisEvent(p, AnalysisTaskId.VOICES, "cancelled", null, null, nowMs = 1300L)
        assertNotNull(p.phaseFinishedAt)
        assertEquals(3, p.cancelledTasks)
    }

    @Test
    fun `totals derived from row statuses — orchestrator counters are ignored`() {
        // A late per-task event with bogus completed_tasks must NOT change the
        // row-derived totals — rows are the single source of truth (web parity).
        var p = applyAnalysisEvent(resetAnalysisProgress(), AnalysisTaskId.CHARACTERS, "completed", durationMs = 100L, error = null, nowMs = 1000L)
        p = applyAnalysisEvent(p, AnalysisTaskId.LOCATIONS, "completed", durationMs = 100L, error = null, nowMs = 1100L)
        p = applyAnalysisEvent(p, AnalysisTaskId.VOICES, "pending", null, null, nowMs = 1200L)
        val before = p.completedTasks
        p = applyProgressEventToAnalysis(
            p, type = "analysis", stage = null, task = "voices", status = "pending",
            durationMs = null, error = null,
            analysisCompleted = 99, analysisFailed = null, analysisTotal = null, nowMs = 1300L
        )
        assertEquals(before, p.completedTasks)
        // Heartbeat counters only ratchet their own fields, never the rows.
        p = applyAnalysisHeartbeat(p, analysisCompleted = 3, analysisFailed = 0, analysisTotal = 3)
        assertEquals(2, p.tasks.values.count { it.status == AnalysisStatus.COMPLETED })
    }

    @Test
    fun `re-emitting completed is idempotent`() {
        var p = applyAnalysisEvent(resetAnalysisProgress(), AnalysisTaskId.CHARACTERS, "running", null, null, nowMs = 1000L)
        p = applyAnalysisEvent(p, AnalysisTaskId.CHARACTERS, "completed", durationMs = 100L, error = null, nowMs = 1100L)
        val again = applyAnalysisEvent(p, AnalysisTaskId.CHARACTERS, "completed", durationMs = 100L, error = null, nowMs = 1200L)
        assertEquals(p.completedTasks, again.completedTasks)
        assertEquals(p.tasks[AnalysisTaskId.CHARACTERS]!!.finishedAt, again.tasks[AnalysisTaskId.CHARACTERS]!!.finishedAt)
    }

    // ── analysisOverallPercent ───────────────────────────────────────

    @Test
    fun `overall percent is 0 before work starts`() {
        assertEquals(0, analysisOverallPercent(resetAnalysisProgress()))
    }

    @Test
    fun `failed task counts as done for the bar (failure isolation)`() {
        var p = applyAnalysisEvent(resetAnalysisProgress(), AnalysisTaskId.CHARACTERS, "running", null, null, nowMs = 1000L)
        p = applyAnalysisEvent(p, AnalysisTaskId.CHARACTERS, "completed", durationMs = 100L, error = null, nowMs = 1100L)
        p = applyAnalysisEvent(p, AnalysisTaskId.LOCATIONS, "running", null, null, nowMs = 1200L)
        p = applyAnalysisEvent(p, AnalysisTaskId.LOCATIONS, "failed", durationMs = 100L, error = "x", nowMs = 1300L)
        assertEquals(67, analysisOverallPercent(p))
    }

    @Test
    fun `overall percent is 100 when all terminal including failures`() {
        var p = applyAnalysisEvent(resetAnalysisProgress(), AnalysisTaskId.CHARACTERS, "completed", durationMs = 100L, error = null, nowMs = 1000L)
        p = applyAnalysisEvent(p, AnalysisTaskId.LOCATIONS, "failed", durationMs = 100L, error = "x", nowMs = 1100L)
        p = applyAnalysisEvent(p, AnalysisTaskId.VOICES, "completed", durationMs = 100L, error = null, nowMs = 1200L)
        assertEquals(100, analysisOverallPercent(p))
        assertEquals(1, p.failedTasks)
    }

    // ── resetAnalysisProgress ────────────────────────────────────────

    @Test
    fun `reset clears all state — phase timer, rows, counters`() {
        var p = applyAnalysisEvent(resetAnalysisProgress(), AnalysisTaskId.CHARACTERS, "running", null, null, nowMs = 1000L)
        p = applyAnalysisEvent(p, AnalysisTaskId.CHARACTERS, "completed", durationMs = 100L, error = null, nowMs = 1100L)
        assertTrue(p.active)

        val fresh = resetAnalysisProgress()
        assertFalse(fresh.active)
        assertEquals(0, fresh.completedTasks)
        assertEquals(0, fresh.failedTasks)
        assertEquals(0, fresh.cancelledTasks)
        assertNull(fresh.phaseStartedAt)
        assertNull(fresh.phaseFinishedAt)
        assertNull(fresh.phaseDurationMs)
        for (row in fresh.tasks.values) {
            assertEquals(AnalysisStatus.PENDING, row.status)
            assertNull(row.startedAt)
            assertNull(row.finishedAt)
            assertNull(row.durationMs)
            assertNull(row.error)
        }
    }

    // ── Sequential compatibility (routing) ───────────────────────────

    @Test
    fun `sequential mode never populates the analysis state`() {
        val prev = resetAnalysisProgress()
        // Sequential vbook events (stage != analysis_parallel) must not touch it.
        val next = applyProgressEventToAnalysis(
            prev, type = "vbook", stage = "extracting_chars", task = null, status = null,
            durationMs = null, error = null,
            analysisCompleted = null, analysisFailed = null, analysisTotal = null, nowMs = 1000L
        )
        assertEquals(prev, next)
        assertFalse(next.active)
    }

    @Test
    fun `analysis_parallel heartbeat activates the state without rows`() {
        val next = applyProgressEventToAnalysis(
            resetAnalysisProgress(), type = "vbook", stage = "analysis_parallel", task = null, status = null,
            durationMs = null, error = null,
            analysisCompleted = 1, analysisFailed = 0, analysisTotal = 3, nowMs = 1000L
        )
        assertTrue(next.active)
        assertEquals(3, next.totalTasks)
        assertEquals(1, next.completedTasks)
        // Rows untouched by the heartbeat — still all pending.
        assertEquals(AnalysisStatus.PENDING, next.tasks[AnalysisTaskId.VOICES]!!.status)
    }

    // ── Out-of-order SSE events ──────────────────────────────────────

    @Test
    fun `out-of-order events do not corrupt the state`() {
        // Realistic delivery order: locations completes BEFORE the heartbeat
        // with its stale counters arrives. Row statuses win — the stale
        // heartbeat must not roll completedTasks backwards.
        var p = applyAnalysisEvent(resetAnalysisProgress(), AnalysisTaskId.CHARACTERS, "running", null, null, nowMs = 1000L)
        p = applyAnalysisEvent(p, AnalysisTaskId.LOCATIONS, "running", null, null, nowMs = 1100L)
        p = applyAnalysisEvent(p, AnalysisTaskId.LOCATIONS, "completed", durationMs = 500L, error = null, nowMs = 1200L)
        assertEquals(1, p.completedTasks)
        // Stale heartbeat (orchestrator lag): completed_tasks=0 arrives late.
        p = applyProgressEventToAnalysis(
            p, type = "vbook", stage = "analysis_parallel", task = null, status = null,
            durationMs = null, error = null,
            analysisCompleted = 0, analysisFailed = 0, analysisTotal = 3, nowMs = 1250L
        )
        assertEquals(1, p.completedTasks)
        assertEquals(1000L, p.phaseStartedAt) // phase timer never restarts
        // A re-delivered 'pending' for a running row does not clear its start stamp.
        p = applyAnalysisEvent(p, AnalysisTaskId.CHARACTERS, "pending", null, null, nowMs = 1300L)
        assertEquals(1000L, p.tasks[AnalysisTaskId.CHARACTERS]!!.startedAt)
    }

    // ── Analysis mode / parallelism coercion (layer-config parity) ───

    @Test
    fun `analysis mode coercion — only parallel maps to parallel`() {
        assertEquals("parallel", analysisModeFromWire("parallel"))
        for (v in listOf(null, "sequential", "unknown_future_mode", "")) {
            assertEquals("sequential", analysisModeFromWire(v))
        }
    }

    @Test
    fun `analysis parallelism clamps into range`() {
        assertEquals(1, 0.coerceIn(1, 8))
        assertEquals(1, (-3).coerceIn(1, 8))
        assertEquals(8, 99.coerceIn(1, 8))
        assertEquals(4, 4.coerceIn(1, 8))
    }
}
