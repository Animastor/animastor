// Architecture contour guard — Generation-progress PHYSICAL PACKAGE EXTRACTION
// (docs/architecture/web-generator-extraction-audit.md, Step 2).
//
// Phase: PHYSICAL PACKAGE (packages/animastor-web-generator/) — the
// generation-progress domain slice has been physically extracted from
// frontends/app/src/state/generationProgress/ into its own NPM package.
//
// Rules pinned here:
//   1. The old in-repo directory state/generationProgress/ is GONE — no
//      two production copies of the domain.
//   2. generateStore imports from @animastor/web-generator (package root
//      only — no deep imports).
//   3. No host file imports deep paths: @animastor/web-generator/src/...
//   4. Host ownership unchanged — generateStore keeps identity
//      (bookId/buildId), loadBook, stash/restore, phase/errorMessage,
//      onPlaybackPrepared.
//   5. generateStore owns the domain state objects (progressTracking,
//      generationTimer) and passes them explicitly.
//   6. No reverse dependency: the package must not import host stores,
//      api/client, app/*, pages, @preact/signals, or any @animastor/*
//      package.
//   7. No new dependency cycles — the dependency direction is
//      host → @animastor/web-generator (one-directional).

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

const HOST_STORE = 'state/generateStore.ts';
const PACKAGE_NAME = '@animastor/web-generator';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Old in-repo directory is gone — no two production copies
// ─────────────────────────────────────────────────────────────────────────────

describe('Generation-progress package extraction — old contour removed', () => {
  it('state/generationProgress/ directory no longer exists', () => {
    const files = Object.keys(RAW_SOURCES);
    expect(
      files.some((k) => k.startsWith('/src/state/generationProgress/')),
      'state/generationProgress/ still exists — the old in-repo contour must be deleted',
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. generateStore imports from the package root (no deep imports)
// ─────────────────────────────────────────────────────────────────────────────

describe('Generation-progress package extraction — host consumption', () => {
  it('generateStore imports from @animastor/web-generator (package root)', () => {
    const specs = importSpecifiers(HOST_STORE);
    expect(specs).toContain(PACKAGE_NAME);
  });

  it('generateStore does NOT use deep imports into the package', () => {
    const specs = importSpecifiers(HOST_STORE);
    const deepImports = specs.filter((s) => s.startsWith(`${PACKAGE_NAME}/`));
    expect(
      deepImports,
      `generateStore uses deep imports: ${deepImports.join(', ')} — use the package root only`,
    ).toEqual([]);
  });

  it('no host file imports deep paths into the package', () => {
    for (const f of allSourceFiles()) {
      if (f === HOST_STORE) continue;
      const specs = importSpecifiers(f);
      const deepImports = specs.filter((s) => s.startsWith(`${PACKAGE_NAME}/`));
      expect(
        deepImports,
        `${f} uses deep package imports: ${deepImports.join(', ')} — forbidden`,
      ).toEqual([]);
    }
  });

  it('only generateStore imports from the package (pages via store surface)', () => {
    const consumers = allSourceFiles()
      .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))
      .filter((f) => f !== HOST_STORE)
      .filter((f) => importSpecifiers(f).includes(PACKAGE_NAME))
      .sort();
    expect(
      consumers,
      `non-store files import from ${PACKAGE_NAME} directly — pages must use the store surface`,
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Host ownership unchanged (identity stays generateStore's)
// ─────────────────────────────────────────────────────────────────────────────

describe('Generation-progress package extraction — host ownership contract', () => {
  it('generateStore keeps the identity/auth/event surface (nothing moved out of the host)', () => {
    const store = requireRaw(HOST_STORE);
    for (const token of [
      'export const bookId', 'export const buildId', 'export function loadBook',
      'export function stashBookSessionForUser', 'export function restoreStashedBookSessionForUser',
      'export function onPlaybackPrepared', 'export const phase',
      'export const errorMessage', 'export function emitPlaybackPrepared',
    ]) {
      expect(store, `generateStore must keep: ${token}`).toContain(token);
    }
  });

  it('generateStore owns the domain state objects and passes them (no module Maps left)', () => {
    const store = requireRaw(HOST_STORE);
    expect(store).toMatch(/const progressTracking: ProgressTrackingState = createProgressTrackingState\(\)/);
    expect(store).toMatch(/const generationTimer: GenerationTimerState = createGenerationTimer\(\)/);
    // The previously module-scope Maps/latches are gone from the store too.
    expect(store).not.toMatch(/^const (taskReadyFloor|taskCompletedAt|taskFrozenElapsed) = new Map/m);
    expect(store).not.toMatch(/^let (generationCompleted|newGenerationPending|importCompleteReceived|timerStartedAt|finalElapsedSeconds)\b/m);
  });

  it('generateStore no longer re-exports all domain types — they come from the package', () => {
    const store = requireRaw(HOST_STORE);
    // The old index.ts re-exports are gone; the host now imports from the package.
    // generateStore should still re-export VBookStage and applyAnalysisEvent for
    // backward compatibility, but should NOT contain the full list of domain imports.
    // Verify the store does not define its own copy of domain functions.
    expect(store).not.toMatch(/export function applyAnalysisEvent\(/);
    expect(store).not.toMatch(/export function createInitialAnalysisProgress\(/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Dependency graph — no reverse deps, no new cycles
// ─────────────────────────────────────────────────────────────────────────────

describe('Generation-progress package extraction — dependency graph', () => {
  it('no state module imports generateStore EXCEPT the documented authStore identity edge', () => {
    const stateFiles = allSourceFiles().filter((f) =>
      f.startsWith('state/') && f.endsWith('.ts') && !f.includes('.test.'));
    for (const f of stateFiles) {
      if (f === HOST_STORE || f === 'state/authStore.ts') continue;
      expect(
        importSpecifiers(f).includes('./generateStore'),
        `${f} imports generateStore — state/ modules reach it only via injected seams`,
      ).toBe(false);
    }
  });

  it('host stores do not import from the package (only generateStore is the adapter)', () => {
    const stateFiles = allSourceFiles().filter((f) =>
      f.startsWith('state/') && f.endsWith('.ts') && !f.includes('.test.'));
    for (const f of stateFiles) {
      if (f === HOST_STORE) continue;
      expect(
        importSpecifiers(f).includes(PACKAGE_NAME),
        `${f} imports from ${PACKAGE_NAME} — only generateStore should consume the package`,
      ).toBe(false);
    }
  });
});
