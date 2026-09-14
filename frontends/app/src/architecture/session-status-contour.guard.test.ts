// Architecture contour guard — B6 SESSION-STATUS (phase / errorMessage)
// (docs/architecture/web-generator-extraction-audit.md §25, restructured in
// Step 15A §26 from the generation-progress contour guard, where the group was
// topologically misplaced: this boundary is about the shared session-status
// signals, not the generation-progress package contour).
//
// Step 20 (audit §31) PHYSICALLY SEPARATED the two signals:
//
//   `phase` — SHARED cross-slice status (unchanged boundary):
//     1. Owner: generateStore declares `phase` (one declaration).
//     2. Sole second writer: fileStore, EXCLUSIVELY through the SessionSeam
//        (`session.phase.value`) — never its own signal declaration.
//     3. No production module outside {generateStore, fileStore} writes it.
//
//   `errorMessage` — FILE-STORE-OWNED since Step 20:
//     4. Owner: fileStore declares `errorMessage` (one declaration); the
//        signal is a plain module export beside the other file-flow signals.
//     5. Writer set: fileStore ONLY — every write is a file-flow lifecycle
//        event (beginBookTransition clear-on-entry, the three failure catches,
//        closeBook clear-on-close). generateStore is NOT an owner: the old
//        cancel-settle clear was a provable null-over-null in every reachable
//        state (§30.4) and was removed together with the declaration.
//     6. Reader: FilePage consumes the SAME signal object through the
//        by-reference FileSessionPort (`ports.session.errorMessage`) — the
//        web-file public API is unchanged.
//     7. The scans below are token-scoped (declarations / `.value =`
//        assignments on the signal identifiers), NOT overly broad greps —
//        unrelated identifiers that merely contain the substring are ignored.
//
// The documented last-writer-wins contract (§25.2/§25.5 for phase; §30.5 for
// errorMessage) describes behavior — it is NOT pinned here beyond the writer
// sets; ordering contracts live in the Step-14A regression tests and the
// Step-20 error-preservation matrix (state/fileStore.test.ts).

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
// 1. Ownership: one declaration per signal, in its owning module (audit §31)
// ─────────────────────────────────────────────────────────────────────────────

describe('Session-status ownership — Step 20 split', () => {
  it('phase stays declared in generateStore (shared two-writer signal, B6)', () => {
    const store = requireRaw(HOST_STORE);
    expect(store).toMatch(/export const phase = signal<PlayerPhase>\('IDLE'\)/);
    // Step 20: generateStore no longer declares errorMessage.
    expect(store).not.toMatch(/export const errorMessage = signal/);
  });

  it('errorMessage is declared ONLY in fileStore (fileStore-owned, Step 20)', () => {
    const fileStore = requireRaw(FILE_STORE);
    expect(fileStore).toMatch(/export const errorMessage = signal<string \| null>\(null\)/);
    // One declaration in the whole src/ tree.
    for (const f of allSourceFiles()) {
      if (f.includes('.test.')) continue;
      if (f === FILE_STORE) continue;
      expect(
        requireRaw(f).match(/export const errorMessage = signal/),
        `${f}: errorMessage declared outside fileStore — sole owner is fileStore (Step 20, audit §31)`,
      ).toBeNull();
    }
  });

  it('errorMessage is not reachable through the SessionSeam anymore (seam slims to identity + phase)', () => {
    const fileStore = requireRaw(FILE_STORE);
    // The seam interface must not re-expose the now file-local signal.
    expect(fileStore).not.toMatch(/readonly errorMessage: Signal/);
    // And the store writes its OWN signal directly (no seam indirection).
    expect(fileStore).not.toContain('session.errorMessage');
    expect(fileStore).toContain('errorMessage.value');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Writer sets (audit §25.1 for phase; §31 for errorMessage)
// ─────────────────────────────────────────────────────────────────────────────

describe('Session-status writer sets', () => {
  it('phase: exactly TWO documented writers — generateStore + fileStore (via SessionSeam)', () => {
    // Sole second writer: fileStore, exclusively through the SessionSeam —
    // never its own signal, never a third module.
    const fileStore = requireRaw(FILE_STORE);
    expect(fileStore).toContain('session.phase.value');
    // fileStore owns errorMessage (Step 20) but must NOT re-declare phase —
    // that would fork the shared session-status signal.
    expect(fileStore).not.toMatch(/export const phase\b/);
  });

  it('no production module outside {generateStore, fileStore} writes phase', () => {
    for (const f of allSourceFiles()) {
      if (f.includes('.test.')) continue;
      if (f === HOST_STORE || f === FILE_STORE) continue;
      const src = requireRaw(f);
      expect(
        src.match(/^\s*(session\.)?phase\.value\s*=/m),
        `${f}: undocumented phase writer found — B6 writer set is generateStore + fileStore only`,
      ).toBeNull();
    }
  });

  it('errorMessage: production writer set is fileStore ONLY (audit §31)', () => {
    for (const f of allSourceFiles()) {
      if (f.includes('.test.')) continue;
      const src = requireRaw(f);
      if (f === FILE_STORE) {
        // The owner: writes must be direct `errorMessage.value =` writes.
        expect(src).toMatch(/^\s*errorMessage\.value\s*=/m);
        continue;
      }
      expect(
        src.match(/^\s*(session\.)?errorMessage\.value\s*=/m),
        `${f}: errorMessage writer found — the production writer set is fileStore only (Step 20); generateStore/generation packages must never write the file-flow error state`,
      ).toBeNull();
    }
  });

  it('generateStore holds no hidden alias/reference to the file error signal (no declaration, write, import, or re-export)', () => {
    const store = requireRaw(HOST_STORE);
    // No declaration…
    expect(store).not.toMatch(/export const errorMessage\b/);
    // …no write…
    expect(store).not.toMatch(/^\s*errorMessage\.value\s*=/m);
    // …no import binding…
    expect(store).not.toMatch(/import \{[^}]*\berrorMessage\b[^}]*\} from/);
    // …and no re-export/alias surface (the remaining token occurrences are
    // boundary documentation comments only — the task forbids an overly broad
    // grep that would fail on prose).
    expect(store).not.toMatch(/export \{[^}]*\berrorMessage\b[^}]*\}/);
    expect(store).not.toMatch(/import \{[^}]*\berrorMessage\b[^}]*\}/);
    // The composition root binds filePorts.session.errorMessage from
    // fileStore, never from generateStore — pinned by fileAdapters.test.ts.
  });

  it('GenerationPorts does not own the file error signal (type-only design record stays unwired)', () => {
    const ports = requireRaw('app/generationPorts.ts');
    expect(ports).not.toMatch(/export const errorMessage/);
    expect(ports).not.toMatch(/errorMessage\.value\s*=/);
  });

  it('web-book-session contains no errorMessage (identity boundary exclusion holds)', () => {
    // The package lives outside the vite root; its own guard pins this too
    // (packages/animastor-web-book-session/test/guard.test.ts) — here we pin
    // that the HOST identity re-export surface never grows an errorMessage
    // token (no ownership drift into the identity module).
    const store = requireRaw(HOST_STORE);
    expect(store).not.toMatch(/export \{[^}]*\berrorMessage\b[^}]*\} from '@animastor\/web-book-session'/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. One-boundary declarations (audit §25.5, Step-20-adjusted)
// ─────────────────────────────────────────────────────────────────────────────

describe('Session-status declaration adjacency', () => {
  it('fileStore declares errorMessage adjacent to its file-flow signals (one file-flow boundary)', () => {
    const fileStore = requireRaw(FILE_STORE);
    const iImport = fileStore.indexOf('export const importMessages = signal');
    const iError = fileStore.indexOf('export const errorMessage = signal');
    expect(iImport).toBeGreaterThanOrEqual(0);
    expect(iError).toBeGreaterThan(iImport);
    expect(iError - iImport).toBeLessThan(400); // same file section, one boundary
  });
});
