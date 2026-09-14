// Architecture contour guard — B6 SESSION-STATUS (phase / errorMessage)
// (docs/architecture/web-generator-extraction-audit.md §25, restructured in
// Step 15A §26 from the generation-progress contour guard, where the group was
// topologically misplaced: this boundary is about the shared session-status
// signals, not the generation-progress package contour).
//
// Rules pinned here (audit-only; ownership is NOT moved):
//   1. Owner: generateStore declares `phase` and `errorMessage` (one boundary,
//      declarations adjacent — audit §25.5).
//   2. Sole second writer: fileStore, EXCLUSIVELY through the SessionSeam
//      (`session.phase.value` / `session.errorMessage.value`) — never its own
//      signal declaration.
//   3. No production module outside {generateStore, fileStore} writes the
//      shared status — an undocumented third writer fails with a message
//      pointing at the audit (§25.1: 14 phase + 6 errorMessage assignment
//      sites, counted by raw `.value =` assignment statements).
//   4. The documented contract (last-writer-wins + convergence via
//      re-derivation) is described in §25.2/§25.5 — behavior is NOT pinned
//      here beyond the writer set; ordering contracts live in the
//      Step-14A regression tests.

import { describe, it, expect } from 'vitest';

const RAW_SOURCES = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function requireRaw(rel: string): string {
  const key = `/src/${rel}`;
  const raw = RAW_SOURCES[key];
  if (raw === undefined) throw new Error(`guard: source not found: ${key}`);
  return raw;
}

function allSourceFiles(): string[] {
  return Object.keys(RAW_SOURCES)
    .filter((k) => !k.startsWith('/src/architecture/'))
    .map((k) => k.replace(/^\/src\//, ''))
    .sort();
}

const HOST_STORE = 'state/generateStore.ts';
const FILE_STORE = 'state/fileStore.ts';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Ownership + writer set (audit §25.1)
// ─────────────────────────────────────────────────────────────────────────────

describe('Session-status (phase/errorMessage) — writer set', () => {
  it('phase/errorMessage have exactly TWO documented writers and one owner', () => {
    // Owner: generateStore (the signals are declared there — B6).
    const store = requireRaw(HOST_STORE);
    expect(store).toMatch(/export const phase = signal<PlayerPhase>\('IDLE'\)/);
    expect(store).toMatch(/export const errorMessage = signal<string \| null>\(null\)/);
    // Sole second writer: fileStore, exclusively through the SessionSeam
    // (`session.phase.value` / `session.errorMessage.value`) — never its own
    // signal, never a third module.
    const fileStore = requireRaw(FILE_STORE);
    expect(fileStore).toContain('session.phase.value');
    expect(fileStore).toContain('session.errorMessage.value');
    expect(fileStore).not.toMatch(/export const (phase|errorMessage)\b/);
  });

  it('no production module outside generateStore/fileStore writes the shared status', () => {
    for (const f of allSourceFiles()) {
      if (f.includes('.test.')) continue;
      if (f !== HOST_STORE && f !== FILE_STORE) {
        const src = requireRaw(f);
        expect(
          src.match(/^\s*(session\.)?phase\.value\s*=/m),
          `${f}: undocumented phase writer found — B6 writer set is generateStore + fileStore only`,
        ).toBeNull();
        expect(
          src.match(/^\s*(session\.)?errorMessage\.value\s*=/m),
          `${f}: undocumented errorMessage writer found — B6 writer set is generateStore + fileStore only`,
        ).toBeNull();
      }
    }
  });

  it('the errorMessage declaration stays adjacent to phase (one boundary, audit §25.5)', () => {
    const store = requireRaw(HOST_STORE);
    const iPhase = store.indexOf('export const phase = signal');
    const iError = store.indexOf('export const errorMessage = signal');
    expect(iPhase).toBeGreaterThanOrEqual(0);
    expect(iError).toBeGreaterThan(iPhase);
    expect(iError - iPhase).toBeLessThan(400); // same file section, one boundary
  });
});
