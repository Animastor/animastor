// Architecture contour guard — BookSession identity module (Step 11)
// (docs/architecture/web-generator-extraction-audit.md §20, prep step P1).
//
// state/bookSession.ts is the SINGLE OWNER of the book-identity contour:
// bookId/buildId signals, loadBook, the persisted localStorage session
// (write path + key constants) and the per-user stash/restore pair.
//
// Rules pinned here (architecture, not file existence):
//   1. Identity signals have exactly ONE owner: state/bookSession.ts.
//      generateStore re-exports them 1:1 — it must not re-declare them.
//   2. loadBook has exactly ONE owner (bookSession.ts); generateStore only
//     re-exports. No other module defines a `loadBook` identity mutator.
//   3. buildId has exactly ONE signal / source of truth. The generation flow
//      writes through the controlled setGenerationBuildId adapter — no second
//      `buildId` signal anywhere.
//   4. localStorage book-session access: the write path exists ONLY in
//      bookSession.ts. fileStore reads via the read-only
//      readPersistedBookSession() — no inline key literal remains outside
//      bookSession.ts (tests excluded).
//   5. restoreBookSession stays in fileStore (File-flow orchestration).
//   6. phase/errorMessage stay OUT of the identity module (dual-writer
//      shared session status — generateStore + fileStore SessionSeam).
//   7. authStore stays the login/logout lifecycle owner; it must not own
//      identity state, and bookSession must NOT import authStore.
//   8. Dependency direction: bookSession imports nothing but @preact/signals;
//      generateStore does not import authStore; no reverse dependencies.

import { describe, it, expect } from 'vitest';

const RAW_SOURCES = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function importSpecifiers(rel: string): string[] {
  const src = requireRaw(rel);
  const specs = new Set<string>();
  const patterns = [
    /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) specs.add(m[1]);
  }
  return [...specs].sort();
}

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

function productionFiles(): string[] {
  return allSourceFiles().filter((f) => !f.includes('.test.'));
}

const IDENTITY_MODULE = 'state/bookSession.ts';
const HOST_STORE = 'state/generateStore.ts';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Single identity ownership
// ─────────────────────────────────────────────────────────────────────────────

describe('BookSession contour — single identity owner', () => {
  it('bookSession.ts owns the identity signals + loadBook (definitions, not re-exports)', () => {
    const src = requireRaw(IDENTITY_MODULE);
    for (const token of [
      'export const bookId = signal',
      'export const buildId = signal',
      'export function loadBook(',
      'export function stashBookSessionForUser(',
      'export function restoreStashedBookSessionForUser(',
      'export function setGenerationBuildId(',
      'export function readPersistedBookSession(',
      "export const BOOK_STORE_KEY = 'animastor:currentBook'",
    ]) {
      expect(src, `bookSession.ts must own: ${token}`).toContain(token);
    }
  });

  it('generateStore re-exports identity 1:1 but does NOT re-declare the signals or loadBook', () => {
    const store = requireRaw(HOST_STORE);
    // re-export surface present (consumer compatibility)
    expect(store).toContain("} from './bookSession'");
    expect(store).toContain('setGenerationBuildId');
    // no second declaration — single source of truth
    expect(store).not.toMatch(/export const (bookId|buildId) = signal/);
    expect(store).not.toMatch(/export function loadBook\(/);
    expect(store).not.toMatch(/function (persistBookSession|clearBookSession|userStashKey)\(/);
  });

  it('no production module re-declares the identity signals or a second buildId', () => {
    for (const f of productionFiles()) {
      if (f === IDENTITY_MODULE) continue;
      const src = requireRaw(f);
      expect(
        src,
        `${f} re-declares an identity signal — single owner is ${IDENTITY_MODULE}`,
      ).not.toMatch(/export const (bookId|buildId) = signal/);
      expect(
        src,
        `${f} declares a second BOOK_STORE_KEY — the key contract lives in ${IDENTITY_MODULE}`,
      ).not.toMatch(/['"]animastor:currentBook['"]/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. buildId: one signal, two legal writers
// ─────────────────────────────────────────────────────────────────────────────

describe('BookSession contour — buildId hybrid ownership', () => {
  it('generation writes buildId ONLY through the controlled setGenerationBuildId adapter', () => {
    const store = requireRaw(HOST_STORE);
    // the adapter is consumed from the identity module (single writer surface)
    expect(store).toMatch(/setGenerationBuildId[^)]*}\s*from\s+'\.\/bookSession'/);
    // the ONLY direct write in generateStore is via the adapter
    expect(store).toContain('setGenerationBuildId(res.build_id)');
    expect(
      store,
      'generateStore writes buildId.value directly — use setGenerationBuildId',
    ).not.toMatch(/buildId\.value\s*=/);
  });

  it('the identity module does not import the generation slice (no reverse reach)', () => {
    const specs = importSpecifiers(IDENTITY_MODULE);
    expect(specs).toEqual(['@preact/signals']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. localStorage write path + restore ownership
// ─────────────────────────────────────────────────────────────────────────────

describe('BookSession contour — localStorage boundary', () => {
  it('fileStore reads the persisted session through the read-only API (no inline key, no write)', () => {
    const src = requireRaw('state/fileStore.ts');
    expect(src).toContain('readPersistedBookSession');
    // restoreBookSession stays here — File-flow orchestration
    expect(src).toContain('export async function restoreBookSession');
    // no duplicated key constant, no direct write to the live key
    expect(src).not.toMatch(/['"]animastor:currentBook['"]/);
    expect(src).not.toMatch(/localStorage\.setItem\(\s*BOOK_STORE_KEY/);
  });

  it('auth stash/restore write paths exist only in the identity module', () => {
    for (const f of productionFiles()) {
      if (f === IDENTITY_MODULE) continue;
      const src = requireRaw(f);
      expect(
        src,
        `${f} touches the user stash key contract — owned by ${IDENTITY_MODULE}`,
      ).not.toMatch(/:user:\$/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. phase/errorMessage stay outside the identity module
// ─────────────────────────────────────────────────────────────────────────────

describe('BookSession contour — phase/errorMessage excluded', () => {
  it('the identity module does not declare or re-export phase/errorMessage', () => {
    const src = requireRaw(IDENTITY_MODULE);
    expect(src).not.toMatch(/export const phase\b/);
    expect(src).not.toMatch(/export const errorMessage\b/);
    expect(src).not.toContain('PlayerPhase');
  });

  it('generateStore still owns the shared session-status signals (B6 dual-writer contract)', () => {
    const store = requireRaw(HOST_STORE);
    expect(store).toMatch(/export const phase = signal/);
    expect(store).toMatch(/export const errorMessage = signal/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Auth boundary — lifecycle owner vs session persistence owner
// ─────────────────────────────────────────────────────────────────────────────

describe('BookSession contour — auth boundary', () => {
  it('authStore calls the stash pair but owns no identity state and no session keys', () => {
    const src = requireRaw('state/authStore.ts');
    // consumption only
    expect(src).toContain('stashBookSessionForUser');
    expect(src).toContain('restoreStashedBookSessionForUser');
    // authStore keeps the lifecycle decisions
    expect(src).toContain('export async function logout');
    expect(src).toContain('export async function login');
    // no identity state ownership
    expect(src).not.toMatch(/export const (bookId|buildId)\b/);
    expect(src).not.toContain('BOOK_STORE_KEY');
    expect(src).not.toMatch(/localStorage\.setItem/);
  });

  it('the identity module does NOT import authStore (no reverse dependency)', () => {
    const specs = importSpecifiers(IDENTITY_MODULE);
    expect(specs, 'bookSession must not import authStore').not.toContain('./authStore');
  });

  it('generateStore does not import authStore (auth→identity edge stays one-directional)', () => {
    const specs = importSpecifiers(HOST_STORE);
    expect(specs, 'generateStore must not import authStore').not.toContain('./authStore');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Dependency graph — no reverse deps, no cycles, explicit state only
// ─────────────────────────────────────────────────────────────────────────────

describe('BookSession contour — dependency graph', () => {
  it('identity module imports NOTHING from host modules (package-cut ready)', () => {
    const forbidden = [
      './generateStore', './fileStore', './authStore', './positionStore',
      '../api/client', '../app/', '../pages/', '@animastor/',
    ];
    for (const spec of importSpecifiers(IDENTITY_MODULE)) {
      for (const bad of forbidden) {
        expect(
          spec.startsWith(bad) || spec === bad,
          `bookSession.ts imports "${spec}" — identity module must stay dependency-free (only @preact/signals)`,
        ).toBe(false);
      }
    }
  });

  it('no state module imports bookSession EXCEPT generateStore and fileStore', () => {
    const allowed = new Set([HOST_STORE, 'state/fileStore.ts']);
    const stateFiles = allSourceFiles()
      .filter((f) => f.startsWith('state/') && f.endsWith('.ts') && !f.includes('.test.'));
    for (const f of stateFiles) {
      if (allowed.has(f)) continue;
      expect(
        importSpecifiers(f).some((s) => s.includes('./bookSession')),
        `${f} imports bookSession — identity reaches host modules only via generateStore re-exports`,
      ).toBe(false);
    }
  });

  it('no module-global mutable state beyond the explicit signal ownership', () => {
    const src = requireRaw(IDENTITY_MODULE);
    // the only exported mutable bindings are the two signals
    expect(src).not.toMatch(/^let\s+\w+/m);
    expect(src).not.toMatch(/^var\s+\w+/m);
    expect(src).toMatch(/^export const bookId = signal/m);
    expect(src).toMatch(/^export const buildId = signal/m);
  });
});
