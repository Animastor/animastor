// ═══════════════════════════════════════════════════════════════
//  GENERATION-PROGRESS DOMAIN — generation timer tests
// ═══════════════════════════════════════════════════════════════
//  The wall-clock session timer, injected-clock variants (pure).
// ═══════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest';
import {
  createGenerationTimer, elapsedSeconds, formatTimerText,
  startGenerationTimer, stopGenerationTimer,
} from '../src/timer';

describe('generation timer', () => {
  it('starts at 0 (never started) — elapsed reads 0', () => {
    const t = createGenerationTimer();
    expect(t.startedAt).toBe(0);
    expect(elapsedSeconds(t, 5_000)).toBe(0);
  });

  it('start anchors the wall clock and zeroes the final value', () => {
    const t = createGenerationTimer();
    startGenerationTimer(t, 10_000);
    expect(t.startedAt).toBe(10_000);
    expect(t.finalElapsedSeconds).toBe(0);
    expect(elapsedSeconds(t, 13_500)).toBe(3);
  });

  it('stop freezes the final elapsed and parks startedAt at -1', () => {
    const t = createGenerationTimer();
    startGenerationTimer(t, 10_000);
    stopGenerationTimer(t, 15_000);
    expect(t.startedAt).toBe(-1);
    expect(t.finalElapsedSeconds).toBe(5);
    expect(elapsedSeconds(t, 100_000)).toBe(5);
  });

  it('stop on a never-started timer freezes 0 (no negative elapsed)', () => {
    const t = createGenerationTimer();
    stopGenerationTimer(t, 10_000);
    expect(t.finalElapsedSeconds).toBe(0);
    expect(elapsedSeconds(t, 20_000)).toBe(0);
  });

  it('restart resets the final value (fresh window)', () => {
    const t = createGenerationTimer();
    startGenerationTimer(t, 10_000);
    stopGenerationTimer(t, 15_000);
    expect(t.finalElapsedSeconds).toBe(5);
    startGenerationTimer(t, 50_000);
    expect(t.finalElapsedSeconds).toBe(0);
    expect(elapsedSeconds(t, 51_000)).toBe(1);
  });

  it('formatTimerText renders hh:mm:ss with zero-padding', () => {
    expect(formatTimerText(0)).toBe('00:00:00');
    expect(formatTimerText(5)).toBe('00:00:05');
    expect(formatTimerText(65)).toBe('00:01:05');
    expect(formatTimerText(3_725)).toBe('01:02:05');
    expect(formatTimerText(372_325)).toBe('103:25:25');
  });
});
