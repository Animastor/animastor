package com.example.animastor.ui

// Pure reveal-gate logic for the player (T2.2 — unit tested in
// PlayerGateTest.kt). No Android framework calls: the whole gate math lives
// here so the three T2.2 scenarios (frame vs position) are testable on the
// JVM. PlayFragment.kt uses these; the tolerance constants moved here so the
// tests exercise the exact values the player uses.

// Reveal tolerance for the video layer after a unit seek: the whole-scene
// video may drift a few frames (~40 ms on LTX builds) from the audio
// master timeline, so revealing exactly at start_ms could show the
// PREVIOUS unit's tail frame. Reveal only once the player is positioned
// comfortably INSIDE the selected unit (150 ms = ~4 frames at 24 fps)
// — the storyboard overlay covers the transition. Audio master timeline
// only: no video_start_ms is computed or consumed.
const val UNIT_REVEAL_TOLERANCE_MS = 150L
// Keep the reveal position inside the SELECTED unit: never land on (or
// past) the unit's end boundary — a unit shorter than the tolerance
// would otherwise reveal the video already inside the NEXT unit.
// ~1 frame at 24fps.
const val UNIT_REVEAL_SAFETY_MARGIN_MS = 40L

/** Start offset (ms) of a unit on the AUDIO master timeline. The audio
 *  timeline is the ONLY semantic timeline the player knows: a unit exists
 *  there (start_ms), its storyboard belongs to it, and the whole-scene
 *  video is a subordinate visualization that we seek to the same position.
 *  No second video timeline (video_start_ms) is computed or consumed — the
 *  player never analyzes the video file. Falls back to cumulative durationMs
 *  for legacy storyboards without timestamps. */
fun unitStartMs(ius: List<IuImageItem>, unitIndex: Int): Long {
    val startMs = ius.getOrNull(unitIndex)?.startMs
    if (startMs != null && startMs > 0) return startMs
    var seekMs = 0L
    for (i in 0 until unitIndex) seekMs += ius[i].durationMs
    return seekMs
}

/** End offset (ms) of a unit on the AUDIO master timeline: the next unit's
 *  start_ms when present (server boundaries), else start_ms + durationMs,
 *  else cumulative durationMs (legacy). Used to bound the reveal gate so a
 *  unit shorter than the reveal tolerance never reveals the video already
 *  inside the NEXT unit. */
fun unitEndMs(ius: List<IuImageItem>, unitIndex: Int): Long {
    val nextStart = ius.getOrNull(unitIndex + 1)?.startMs
    if (nextStart != null && nextStart > 0) return nextStart
    val startMs = ius.getOrNull(unitIndex)?.startMs
    if (startMs != null && startMs > 0) {
        return startMs + (ius.getOrNull(unitIndex)?.durationMs ?: 0L)
    }
    var endMs = 0L
    for (i in 0..unitIndex) endMs += ius[i].durationMs
    return endMs
}

/** Reveal gate (ms) for the video layer after a unit seek: the raw seek
 *  target plus the tolerance, clamped to stay INSIDE the selected unit
 *  (audio master timeline) — `revealPosition = min(unitStart + tolerance,
 *  unitEnd - safetyMargin)`. Falls back to the raw gate when the unit
 *  boundaries aren't available. */
fun unitRevealGateMs(ius: List<IuImageItem>?, unitIndex: Int, startPosMs: Long): Long {
    val raw = startPosMs + UNIT_REVEAL_TOLERANCE_MS
    if (ius.isNullOrEmpty() || unitIndex !in ius.indices) return raw
    val end = unitEndMs(ius, unitIndex)
    // Clamp to stay inside the selected unit; a unit shorter than the
    // safety margin falls back to the raw target (best effort — sub-frame
    // units can't hold a tolerance window).
    return maxOf(startPosMs, minOf(raw, end - UNIT_REVEAL_SAFETY_MARGIN_MS))
}

/** T2.1/T2.2 AND-gate for the unit-seek reveal. Reveal only when ALL hold:
 *  the player is READY ([playerReady] — a frame is decodable/rendered:
 *  ExoPlayer is READY only when it has buffered data at the current position,
 *  so no separate frame flag is needed on Android), the video has not been
 *  revealed yet, a gate is armed ([revealGateMs] >= 0), the seek has landed
 *  (not in flight), the position is past the gate AND still inside the
 *  selected unit. Each condition alone must NOT reveal. */
fun shouldRevealSeekVideo(
    playerReady: Boolean,
    videoReadyToShow: Boolean,
    hasVideo: Boolean,
    seekInFlight: Boolean,
    revealGateMs: Long,
    posMs: Long,
    unitEndMs: Long,
): Boolean {
    if (!playerReady || videoReadyToShow || !hasVideo || revealGateMs < 0 || seekInFlight) return false
    return posMs >= revealGateMs && posMs < unitEndMs
}
