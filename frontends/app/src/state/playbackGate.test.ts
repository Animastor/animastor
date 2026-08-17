// T2.2 — reveal-gate test scenarios (docs/03-audit/PLAYER_AUDIO_MASTER_TIMELINE_TODO.md):
//  1. Seek → первый кадр есть, позиция < гейта → не показываем.
//  2. Позиция >= гейта, первый кадр ещё не готов → не показываем.
//  3. Оба условия выполнены → показываем.
// Plus the gate math (unitStartMs / unitEndMs / unitRevealGateSec) and the
// reveal bound (unit end — a short unit must never reveal inside the NEXT unit).
import { describe, expect, it } from 'vitest';
import {
  shouldRevealSeekVideo,
  unitEndMs,
  unitRevealGateSec,
  unitStartMs,
  UNIT_REVEAL_SAFETY_MARGIN_MS,
  UNIT_REVEAL_TOLERANCE_MS,
} from './playbackGate';
import type { GateIu } from './playbackGate';

const SEC = 1000;

function iu(startMs: number | null, durationMs: number): GateIu {
  return { startMs, durationMs };
}

// Server-boundary storyboard: unit 2 is SHORT (100 ms < the 150 ms tolerance).
const serverBounds: GateIu[] = [
  iu(0, 3000),      // unit 0: 0..3000
  iu(3000, 2000),   // unit 1: 3000..5000
  iu(5000, 100),    // unit 2: 5000..5100 (shorter than the tolerance)
  iu(5100, 2000),   // unit 3: 5100..7100 (last)
];

// Legacy storyboard without timestamps (cumulative durationMs fallback).
const legacy: GateIu[] = [
  iu(null, 2500),
  iu(null, 2500),
  iu(null, 2500),
];

// ── T2.2 #1: frame ready + position < gate → NO reveal ──────────────────────
describe('T2.2 — AND-gate: frame ready, position below the gate', () => {
  it('does NOT reveal when the position is still below the gate', () => {
    expect(shouldRevealSeekVideo({
      seekInFlight: false,
      hasFrame: true,
      revealGateSec: 5.15, // unit 2 gate (5000 ms + 150 ms tolerance)
      posSec: 5.1,         // inside unit 2 but before the gate
      withinUnit: true,
    })).toBe(false);
  });

  it('does NOT reveal when the position raced past the unit end', () => {
    // pos past unitEnd even though pos >= gate — belt-and-suspenders bound.
    expect(shouldRevealSeekVideo({
      seekInFlight: false,
      hasFrame: true,
      revealGateSec: 5.15,
      posSec: 5.2, // already inside the NEXT unit
      withinUnit: false,
    })).toBe(false);
  });
});

// ── T2.2 #2: position >= gate + no frame → NO reveal ────────────────────────
describe('T2.2 — AND-gate: position past the gate, no decodable frame', () => {
  it('does NOT reveal when the frame is not decoded yet (readyState < 2)', () => {
    expect(shouldRevealSeekVideo({
      seekInFlight: false,
      hasFrame: false, // readyState < HAVE_CURRENT_DATA
      revealGateSec: 5.15,
      posSec: 5.2,     // >= gate
      withinUnit: true,
    })).toBe(false);
  });

  it('does NOT reveal while the seek is still in flight', () => {
    expect(shouldRevealSeekVideo({
      seekInFlight: true,
      hasFrame: true,
      revealGateSec: 5.15,
      posSec: 5.2,
      withinUnit: true,
    })).toBe(false);
  });

  it('does NOT reveal when no gate is armed', () => {
    expect(shouldRevealSeekVideo({
      seekInFlight: false,
      hasFrame: true,
      revealGateSec: -1, // no pending unit seek
      posSec: 5.2,
      withinUnit: true,
    })).toBe(false);
  });
});

// ── T2.2 #3: both conditions hold → reveal ──────────────────────────────────
describe('T2.2 — AND-gate: frame ready AND position past the gate', () => {
  it('reveals when both conditions hold', () => {
    expect(shouldRevealSeekVideo({
      seekInFlight: false,
      hasFrame: true,
      revealGateSec: 5.15,
      posSec: 5.16, // >= gate
      withinUnit: true,
    })).toBe(true);
  });
});

// ── Gate math: unit boundaries on the audio master timeline ─────────────────
describe('unitStartMs / unitEndMs — audio master timeline', () => {
  it('reads server start_ms boundaries', () => {
    expect(unitStartMs(serverBounds, 2)).toBe(5000);
    expect(unitEndMs(serverBounds, 2)).toBe(5100); // next unit's start_ms
  });

  it('last unit falls back to start_ms + durationMs', () => {
    expect(unitEndMs(serverBounds, 3)).toBe(7100);
  });

  it('legacy storyboards fall back to cumulative durationMs', () => {
    expect(unitStartMs(legacy, 2)).toBe(5000);
    expect(unitEndMs(legacy, 2)).toBe(7500);
  });
});

// ── Gate clamping: short unit must never reveal inside the NEXT unit ────────
describe('unitRevealGateSec — bounded by the selected unit', () => {
  it('clamps the gate to unitEnd - safetyMargin for a short unit', () => {
    // unit 2: start 5000, end 5100 — raw gate would be 5150 (inside unit 3).
    const gate = unitRevealGateSec(serverBounds, 2, 5.0);
    const expected = 5.0 + UNIT_REVEAL_TOLERANCE_MS / SEC;
    const clamped = 5.1 - UNIT_REVEAL_SAFETY_MARGIN_MS / SEC;
    expect(gate).toBe(Math.min(expected, clamped));
    expect(gate).toBeLessThan(5.1); // never inside the next unit
    expect(gate).toBeGreaterThanOrEqual(5.0); // never before the seek target
  });

  it('keeps the raw gate for a unit longer than the tolerance', () => {
    const gate = unitRevealGateSec(serverBounds, 0, 0);
    expect(gate).toBe(UNIT_REVEAL_TOLERANCE_MS / SEC);
  });

  it('last unit clamps to start_ms + durationMs - safetyMargin', () => {
    // Target near the unit end: raw gate (7.15) would pass the end (7.10).
    const gate = unitRevealGateSec(serverBounds, 3, 7.0);
    expect(gate).toBe(7.1 - UNIT_REVEAL_SAFETY_MARGIN_MS / SEC);
  });

  it('falls back to the raw gate when the sequence is empty', () => {
    expect(unitRevealGateSec([], 0, 5.0)).toBe(5.0 + UNIT_REVEAL_TOLERANCE_MS / SEC);
  });

  it('falls back to the raw gate when the unit index is out of range', () => {
    expect(unitRevealGateSec(serverBounds, 99, 5.0)).toBe(5.0 + UNIT_REVEAL_TOLERANCE_MS / SEC);
  });
});
