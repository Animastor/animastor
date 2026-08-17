package com.example.animastor.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// T2.2 — reveal-gate test scenarios (docs/03-audit/PLAYER_AUDIO_MASTER_TIMELINE_TODO.md):
//  1. Seek → первый кадр есть, позиция < гейта → не показываем.
//  2. Позиция >= гейта, первый кадр ещё не готов → не показываем.
//  3. Оба условия выполнены → показываем.
// Plus the gate math (unitStartMs / unitEndMs / unitRevealGateMs) and the
// reveal bound (unit end — a short unit must never reveal inside the NEXT unit).
// Pure JVM tests: PlayerGate.kt has no Android framework calls.
class PlayerGateTest {

    private fun iu(startMs: Long?, durationMs: Long) = IuImageItem(
        bitmap = null,
        durationMs = durationMs,
        unitId = null,
        text = null,
        status = IuStatus.READY,
        startMs = startMs,
    )

    // Server-boundary storyboard: unit 2 is SHORT (100 ms < the 150 ms tolerance).
    private val serverBounds = listOf(
        iu(0, 3000),     // unit 0: 0..3000
        iu(3000, 2000),  // unit 1: 3000..5000
        iu(5000, 100),   // unit 2: 5000..5100 (shorter than the tolerance)
        iu(5100, 2000),  // unit 3: 5100..7100 (last)
    )

    // Legacy storyboard without timestamps (cumulative durationMs fallback).
    private val legacy = listOf(iu(null, 2500), iu(null, 2500), iu(null, 2500))

    // ── T2.2 #1: frame ready + position < gate → NO reveal ──────────────────
    @Test
    fun frameReady_positionBelowGate_noReveal() {
        assertFalse(
            shouldRevealSeekVideo(
                playerReady = true, videoReadyToShow = false, hasVideo = true,
                seekInFlight = false, revealGateMs = 5150, posMs = 5100, unitEndMs = 5100,
            )
        )
    }

    @Test
    fun positionPastUnitEnd_noReveal() {
        // pos past unitEnd even though pos >= gate — belt-and-suspenders bound.
        assertFalse(
            shouldRevealSeekVideo(
                playerReady = true, videoReadyToShow = false, hasVideo = true,
                seekInFlight = false, revealGateMs = 5150, posMs = 5200, unitEndMs = 5100,
            )
        )
    }

    // ── T2.2 #2: position >= gate + no frame → NO reveal ────────────────────
    @Test
    fun positionPastGate_playerNotReady_noReveal() {
        // No decodable frame yet (player not READY) — the T2.1 Android decision:
        // STATE_READY is the frame gate.
        assertFalse(
            shouldRevealSeekVideo(
                playerReady = false, videoReadyToShow = false, hasVideo = true,
                seekInFlight = false, revealGateMs = 5150, posMs = 5200, unitEndMs = 5300,
            )
        )
    }

    @Test
    fun seekStillInFlight_noReveal() {
        assertFalse(
            shouldRevealSeekVideo(
                playerReady = true, videoReadyToShow = false, hasVideo = true,
                seekInFlight = true, revealGateMs = 5150, posMs = 5200, unitEndMs = 5300,
            )
        )
    }

    @Test
    fun noGateArmed_noReveal() {
        assertFalse(
            shouldRevealSeekVideo(
                playerReady = true, videoReadyToShow = false, hasVideo = true,
                seekInFlight = false, revealGateMs = -1, posMs = 5200, unitEndMs = 5300,
            )
        )
    }

    @Test
    fun alreadyRevealed_noReveal() {
        assertFalse(
            shouldRevealSeekVideo(
                playerReady = true, videoReadyToShow = true, hasVideo = true,
                seekInFlight = false, revealGateMs = 5150, posMs = 5200, unitEndMs = 5300,
            )
        )
    }

    @Test
    fun audioOnlyScene_noReveal() {
        assertFalse(
            shouldRevealSeekVideo(
                playerReady = true, videoReadyToShow = false, hasVideo = false,
                seekInFlight = false, revealGateMs = 5150, posMs = 5200, unitEndMs = 5300,
            )
        )
    }

    // ── T2.2 #3: both conditions hold → reveal ──────────────────────────────
    @Test
    fun frameReady_and_positionPastGate_reveal() {
        assertTrue(
            shouldRevealSeekVideo(
                playerReady = true, videoReadyToShow = false, hasVideo = true,
                seekInFlight = false, revealGateMs = 5150, posMs = 5151, unitEndMs = 5300,
            )
        )
    }

    // ── Gate math: unit boundaries on the audio master timeline ─────────────
    @Test
    fun unitStart_readsServerBoundaries() {
        assertEquals(5000L, unitStartMs(serverBounds, 2))
        assertEquals(5100L, unitEndMs(serverBounds, 2)) // next unit's start_ms
    }

    @Test
    fun lastUnitEnd_fallsBackToStartPlusDuration() {
        assertEquals(7100L, unitEndMs(serverBounds, 3))
    }

    @Test
    fun legacy_fallsBackToCumulativeDuration() {
        assertEquals(5000L, unitStartMs(legacy, 2))
        assertEquals(7500L, unitEndMs(legacy, 2))
    }

    // ── Gate clamping: short unit must never reveal inside the NEXT unit ────
    @Test
    fun shortUnit_gateClampedInsideSelectedUnit() {
        // unit 2: start 5000, end 5100 — raw gate would be 5150 (inside unit 3).
        val gate = unitRevealGateMs(serverBounds, 2, 5000)
        val expected = minOf(5000L + UNIT_REVEAL_TOLERANCE_MS, 5100L - UNIT_REVEAL_SAFETY_MARGIN_MS)
        assertEquals(expected, gate)
        assertTrue(gate < 5100) // never inside the next unit
        assertTrue(gate >= 5000) // never before the seek target
    }

    @Test
    fun longUnit_keepsRawGate() {
        assertEquals(UNIT_REVEAL_TOLERANCE_MS, unitRevealGateMs(serverBounds, 0, 0))
    }

    @Test
    fun lastUnit_gateClampedToStartPlusDuration() {
        // Target near the unit end: raw gate (7150) would pass the end (7100).
        assertEquals(7100L - UNIT_REVEAL_SAFETY_MARGIN_MS, unitRevealGateMs(serverBounds, 3, 7000))
    }

    @Test
    fun emptySequence_fallsBackToRawGate() {
        assertEquals(5000L + UNIT_REVEAL_TOLERANCE_MS, unitRevealGateMs(emptyList(), 0, 5000))
    }

    @Test
    fun outOfRangeIndex_fallsBackToRawGate() {
        assertEquals(5000L + UNIT_REVEAL_TOLERANCE_MS, unitRevealGateMs(serverBounds, 99, 5000))
    }
}
