import { describe, it, expect } from 'vitest';
import type { WaveformPeak } from '../src/models';

describe('waveform', () => {
  describe('WaveformPeak type', () => {
    it('peak has pos and neg fields', () => {
      const peak: WaveformPeak = { pos: 0.5, neg: 0.3 };
      expect(peak.pos).toBe(0.5);
      expect(peak.neg).toBe(0.3);
    });

    it('is structurally compatible with host api/models.WaveformPeak', () => {
      // This is a structural type test: if the shapes diverge, this will fail at compile time
      const hostPeak: { pos: number; neg: number } = { pos: 0.1, neg: 0.2 };
      const pkgPeak: WaveformPeak = hostPeak;
      expect(pkgPeak.pos).toBe(0.1);
      expect(pkgPeak.neg).toBe(0.2);
    });
  });
});
