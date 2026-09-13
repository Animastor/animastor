// Package-owned structural types for the Editor surface.
//
// These types mirror the subset of host api/models needed by waveform.tsx
// WITHOUT importing the host api layer. The host adapter bridges
// api/models.WaveformData → this package's WaveformPeak at the boundary;
// TypeScript enforces structural compatibility.

/** A single peak pair (positive / negative amplitude, 0..1 range). */
export interface WaveformPeak {
  pos: number;
  neg: number;
}
