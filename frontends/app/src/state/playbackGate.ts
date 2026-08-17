// Pure reveal-gate logic for the player (T2.2 — unit tested). No DOM, no
// signals, no imports from playbackStore.ts: the whole gate math lives here so
// the three T2.2 scenarios (frame vs position) are testable without a browser.
// playbackStore.ts imports these; IuImageItem satisfies GateIu structurally.
//
// The gate (audio master timeline): after a unit seek the video may reveal the
// surface only once the player is positioned INSIDE the selected unit — the
// raw seek target plus a tolerance (the video can drift a few frames from the
// audio timeline; revealing at start_ms could show the PREVIOUS unit's tail
// frame), clamped so a unit shorter than the tolerance never reveals the video
// already inside the NEXT unit:
//
//   revealPosition = min(unitStart + tolerance, unitEnd - safetyMargin)
//
// T2.1/T2.2: reveal is an AND-gate — the position must be past the gate AND a
// frame must actually be decodable (web: readyState >= HAVE_CURRENT_DATA;
// Android: STATE_READY). Either condition alone must NOT reveal.

/** Minimal shape of an IU item the gate math needs (IuImageItem satisfies it
 *  structurally). */
export interface GateIu {
  startMs: number | null;
  durationMs: number;
}

// Reveal tolerance for the video layer after a unit seek: ~4 frames at 24fps.
export const UNIT_REVEAL_TOLERANCE_MS = 150;
// Keep the reveal position inside the SELECTED unit: never land on (or past)
// the unit's end boundary — a unit shorter than the tolerance would otherwise
// reveal the video already inside the NEXT unit. ~1 frame at 24fps.
export const UNIT_REVEAL_SAFETY_MARGIN_MS = 40;

/** Start offset (ms) of a unit on the AUDIO master timeline. Falls back to
 *  cumulative durationMs for legacy storyboards without timestamps. */
export function unitStartMs(ius: GateIu[], unitIndex: number): number {
  const startMs = ius[unitIndex]?.startMs;
  if (startMs != null && startMs > 0) return startMs;
  let seekMs = 0;
  for (let i = 0; i < unitIndex; i++) seekMs += ius[i].durationMs;
  return seekMs;
}

/** End offset (ms) of a unit on the AUDIO master timeline: the next unit's
 *  start_ms when present (server boundaries), else start_ms + durationMs, else
 *  cumulative durationMs (legacy). Bounds the reveal gate so a unit shorter
 *  than the reveal tolerance never reveals the video inside the NEXT unit. */
export function unitEndMs(ius: GateIu[], unitIndex: number): number {
  const nextStart = ius[unitIndex + 1]?.startMs;
  if (nextStart != null && nextStart > 0) return nextStart;
  const startMs = ius[unitIndex]?.startMs;
  if (startMs != null && startMs > 0) return startMs + (ius[unitIndex]?.durationMs ?? 0);
  let endMs = 0;
  for (let i = 0; i <= unitIndex; i++) endMs += ius[i].durationMs;
  return endMs;
}

/** Reveal gate (sec) for the video layer after a unit seek: the raw seek
 *  target plus the tolerance, clamped to stay INSIDE the selected unit
 *  (audio master timeline) — `revealPosition = min(unitStart + tolerance,
 *  unitEnd - safetyMargin)`. Falls back to the raw gate when the unit
 *  boundaries aren't available. */
export function unitRevealGateSec(ius: GateIu[], unitIndex: number, targetSec: number): number {
  const raw = targetSec + UNIT_REVEAL_TOLERANCE_MS / 1000;
  if (!ius || ius.length === 0 || unitIndex < 0 || unitIndex >= ius.length) return raw;
  const end = unitEndMs(ius, unitIndex) / 1000;
  return Math.max(targetSec, Math.min(raw, end - UNIT_REVEAL_SAFETY_MARGIN_MS / 1000));
}

/** T2.1/T2.2 AND-gate for the unit-seek reveal. Reveal only when ALL hold:
 *  the seek has landed (not in flight), a frame is actually decodable
 *  ([hasFrame] — web: readyState >= HAVE_CURRENT_DATA), a gate is armed
 *  ([revealGateSec] >= 0), the position is past the gate AND still inside the
 *  selected unit ([withinUnit]). Each condition alone must NOT reveal. */
export function shouldRevealSeekVideo(o: {
  seekInFlight: boolean;
  hasFrame: boolean;
  revealGateSec: number; // < 0 ⇒ no gate armed
  posSec: number;
  withinUnit: boolean;
}): boolean {
  if (o.seekInFlight || !o.hasFrame || o.revealGateSec < 0) return false;
  return o.posSec >= o.revealGateSec && o.withinUnit;
}
