// Architecture contour guard — Generation-progress domain split
// (docs/architecture/web-generator-extraction-audit.md §4.3.1, Step 1 of
// the preparation sequence).
//
// Phase: IN-REPO domain module (state/generationProgress/) — the preparatory
// refactoring BEFORE any physical package extraction. No
// packages/animastor-web-generator and no generation-progress NPM package
// exist yet; this guard pins the contour so the future cut is mechanical.
//
// Rules pinned here (audit §6 blocker 6 + the task constraints):
//   1. Boundary — the domain imports ONLY api/models (wire types to be
//      vendored at package-cut time, web-player models.ts precedent);
//      NO api/client (transport stays host-side), NO app/* (router, i18n,
//      desktop, icons), NO state siblings (positionStore, authStore,
//      fileStore, playbackStore), NO pages/, NO @animastor/*.
//   2. No hidden module-global state — the tracking Maps/latches
//      (taskReadyFloor/taskCompletedAt/taskFrozenElapsed/generationCompleted/
//      newGenerationPending/importCompleteReceived) and the timer state must
//      be parameterized through explicit state objects; the domain modules
//      must not declare module-level `let` mutable state or bare Maps.
//   3. No signals in the domain — @preact/signals must not appear in
//      state/generationProgress/ sources (host binding only).
//   4. Host ownership unchanged — generateStore keeps identity
//      (bookId/buildId), loadBook, stash/restore, phase/errorMessage,
//      onPlaybackPrepared; the domain must not reach them.
//   5. No new dependency cycles — the state/ module graph stays acyclic
//      (generateStore → generationProgress one-directional).
//   6. Consumers — only generateStore (the host) imports the domain
//      (plus its own tests); pages reach it via the store surface.

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

const DOMAIN_DIR = 'state/generationProgress';
const HOST_STORE = 'state/generateStore.ts';

function domainModules(includeTests = false): string[] {
  return allSourceFiles().filter((f) =>
    f.startsWith(`${DOMAIN_DIR}/`) && f.endsWith('.ts') &&
    (includeTests || !f.endsWith('.test.ts')));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Boundary — allowed imports only (api/models wire types; domain-internal)
// ─────────────────────────────────────────────────────────────────────────────

describe('Generation-progress domain boundary (in-repo Step 1)', () => {
  it('every domain module imports only the sanctioned specifiers', () => {
    for (const f of domainModules()) {
      const specs = importSpecifiers(f);
      for (const spec of specs) {
        // Domain-internal relative imports (./siblings, ../../api/models).
        const internal = spec.startsWith('./') || spec === '../../api/models';
        expect(
          internal,
          `${f} imports "${spec}" — only domain siblings + ../../api/models are allowed`,
        ).toBe(true);
      }
    }
  });

  it('no forbidden host/package reach: api/client, app/*, state siblings, pages, @animastor/*', () => {
    const FORBIDDEN = /(^|\/)(api\/client|app\/|state\/(positionStore|authStore|fileStore|playbackStore|generateStore|resourceInvalidations|resilientReloader)|pages\/)|^@animastor\//;
    for (const f of domainModules()) {
      for (const spec of importSpecifiers(f)) {
        expect(
          spec,
          `${f} must not reach "${spec}" — transport/UI/identity/host stores stay host-side`,
        ).not.toMatch(FORBIDDEN);
      }
    }
  });

  it('no @preact/signals in the domain (signals are the host binding)', () => {
    for (const f of domainModules()) {
      expect(
        importSpecifiers(f),
        `${f} imports @preact/signals — the domain must stay signal-free`,
      ).not.toContain('@preact/signals');
    }
  });

  it('wire-contract types are imported as types only (no runtime api/models reach)', () => {
    for (const f of domainModules()) {
      const src = requireRaw(f);
      const runtimeModelImports = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\.\.\/\.\.\/api\/models['"]/g)]
        .flatMap((m) => m[1].split(',').map((s) => s.trim()))
        .filter((s) => s.length > 0 && !s.startsWith('type ') && !s.startsWith('export type'));
      expect(
        runtimeModelImports,
        `${f} imports runtime values from api/models — only type imports are sanctioned (values get vendored at package-cut time)`,
      ).toEqual([]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. No hidden module-global mutable state (audit §6 blocker 6, resolved)
// ─────────────────────────────────────────────────────────────────────────────

describe('Generation-progress domain — explicit state parameterization', () => {
  it('no module-level mutable state declarations (let / bare Map latches)', () => {
    for (const f of domainModules()) {
      const src = requireRaw(f);
      // Module-scope `let` (column 0) — the previously hidden Maps/latches.
      expect(
        src,
        `${f} declares module-level let state — parameterize via explicit state objects`,
      ).not.toMatch(/^let\s/m);
      // Bare module-scope Map/Set instantiation (const x = new Map...).
      expect(
        src,
        `${f} declares a module-scope Map/Set — state must arrive via parameters`,
      ).not.toMatch(/^const\s+\w+\s*=\s*new (Map|Set)\(/m);
    }
  });

  it('the tracking Maps/latches live in the explicit ProgressTrackingState interface', () => {
    const src = requireRaw(`${DOMAIN_DIR}/progressRows.ts`);
    for (const field of [
      'taskReadyFloor', 'taskCompletedAt', 'taskFrozenElapsed',
      'generationCompleted', 'newGenerationPending', 'importCompleteReceived',
    ]) {
      expect(src).toContain(`${field}:`);
    }
    expect(src).toMatch(/export function createProgressTrackingState\(/);
    expect(src).toMatch(/export function resetProgressTracking\(/);
  });

  it('the timer state is an explicit object (no wall-clock lets)', () => {
    const src = requireRaw(`${DOMAIN_DIR}/timer.ts`);
    expect(src).toMatch(/export interface GenerationTimerState/);
    expect(src).toMatch(/startedAt: number;/);
    expect(src).toMatch(/finalElapsedSeconds: number;/);
  });

  it('domain functions receive state explicitly (no zero-arg global state reach)', () => {
    const rows = requireRaw(`${DOMAIN_DIR}/progressRows.ts`);
    expect(rows).toMatch(/export function computeProgressRows\(\s*ctx: ProgressRowContext,/);
    const sse = requireRaw(`${DOMAIN_DIR}/sseRouting.ts`);
    expect(sse).toMatch(/export function routeProgressEvent\(\s*sink: ProgressEventSink,\s*tracking: ProgressTrackingState,/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Host ownership unchanged (identity stays generateStore's)
// ─────────────────────────────────────────────────────────────────────────────

describe('Generation-progress domain — host ownership contract', () => {
  it('the domain never USES host-owned identity/session duties (code-level tokens)', () => {
    // Code-shaped tokens: signal reads/writes and host-fn calls. These cannot
    // appear in prose comments ("bookId stays host-owned" is fine; binding
    // bookId.value is not).
    const FORBIDDEN_TOKENS = [
      'bookId.value', 'buildId.value', 'loadBook(', 'stashBookSession',
      'restoreStashedBookSession', 'onPlaybackPrepared(', 'emitPlaybackPrepared(',
      'authStore', 'localStorage', 'phase.value', 'errorMessage.value',
    ];
    for (const f of domainModules()) {
      const src = requireRaw(f);
      for (const token of FORBIDDEN_TOKENS) {
        expect(
          src.includes(token),
          `${f} uses "${token}" — host-owned duty leaked into the domain`,
        ).toBe(false);
      }
    }
  });

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
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Dependency graph — no new cycles, entry consumption
// ─────────────────────────────────────────────────────────────────────────────

describe('Generation-progress domain — dependency graph', () => {
  it('the domain is a leaf: it imports no module OUTSIDE its directory (except api/models types)', () => {
    for (const f of domainModules()) {
      for (const spec of importSpecifiers(f)) {
        if (spec === '../../api/models') continue;
        expect(
          spec.startsWith('./'),
          `${f} imports "${spec}" — the domain must be a leaf (siblings + wire types only)`,
        ).toBe(true);
      }
    }
  });

  it('no state module imports generateStore EXCEPT the documented authStore identity edge (no NEW cycles)', () => {
    // The authStore → generateStore edge is the pre-existing, audit-registered
    // host identity seam (§3.2, blocker 2) — one-directional, not a cycle.
    // Everything else in state/ reaches generateStore only via injected seams.
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

  it('production consumers of the domain directory: only generateStore (pages via store surface)', () => {
    const consumers = allSourceFiles()
      .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))
      .filter((f) => !f.startsWith(`${DOMAIN_DIR}/`))
      .filter((f) => importSpecifiers(f).some((s) => s.includes('generationProgress')))
      .sort();
    expect(consumers).toEqual([HOST_STORE]);
  });

  it('domain tests import only the domain (independent of generateStore)', () => {
    const domainTests = domainModules(true).filter((f) => f.endsWith('.test.ts'));
    expect(domainTests.length).toBeGreaterThanOrEqual(4);
    for (const f of domainTests) {
      const specs = importSpecifiers(f);
      expect(
        specs.some((s) => s.includes('generateStore')),
        `${f} imports generateStore — domain unit tests must run standalone`,
      ).toBe(false);
    }
  });

  it('no new package/dir was created (no physical extraction yet — prep only)', () => {
    const files = Object.keys(RAW_SOURCES);
    expect(files.some((k) => k.startsWith('/src/state/generationProgress/'))).toBe(true);
    // No packages/animastor-web-generator (the app tree cannot see packages/,
    // but the guard also pins that no module-level reference creeps in).
    for (const f of allSourceFiles()) {
      expect(requireRaw(f)).not.toContain('animastor-web-generator');
    }
  });
});
