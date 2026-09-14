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
//      (bookId/buildId — owned by state/bookSession.ts since the Step 11
//      identity module split and re-exported 1:1), loadBook, stash/restore,
//      phase/errorMessage, onPlaybackPrepared.
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
// 3. Host ownership unchanged (identity surface stays generateStore's)
// ─────────────────────────────────────────────────────────────────────────────

describe('Generation-progress package extraction — host ownership contract', () => {
  it('generateStore keeps the identity/auth/event surface (nothing moved out of the host)', () => {
    const store = requireRaw(HOST_STORE);
    for (const token of [
      // bookId/buildId/loadBook/stash/restore are OWNED by the
      // @animastor/web-book-session package (Step 12 physical extraction,
      // in-repo at Step 11) and RE-EXPORTED from generateStore 1:1 — the
      // consumer surface is unchanged.
      'bookId, buildId, loadBook,',
      'stashBookSessionForUser, restoreStashedBookSessionForUser,',
      "} from '@animastor/web-book-session';",
      'export const phase',
      // Step 20: errorMessage is fileStore-owned — the store must NOT declare it.
      // (The negative pin lives in session-status-contour.guard.test.ts.)
      'export function onPlaybackPrepared',
      'export function emitPlaybackPrepared',
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

  it('Step 17: nav-pulse lifetime lives in ONE explicit NavPulseState (no bare module-scope lets)', () => {
    const store = requireRaw(HOST_STORE);
    // The explicit state object with a single owner.
    expect(store).toMatch(/interface NavPulseState\s*\{/);
    expect(store).toMatch(/statusTimer: ReturnType<typeof setTimeout> \| null/);
    expect(store).toMatch(/watchdog: ReturnType<typeof setInterval> \| null/);
    expect(store).toMatch(/successSince: number/);
    expect(store).toMatch(/const navPulse = createNavPulseState\(\)/);
    // setGenerationStatus arms/clears exclusively through the explicit object.
    expect(store).toContain('navPulse.statusTimer');
    expect(store).toContain('navPulse.watchdog');
    expect(store).toContain('navPulse.successSince');
    // The bare module-scope let trio is GONE — from every host source file.
    for (const f of allSourceFiles()) {
      if (!f.endsWith('.ts') && !f.endsWith('.tsx')) continue;
      const src = requireRaw(f);
      for (const bare of ['navStatusTimer', 'navWatchdog', 'successSince']) {
        expect(
          src.match(new RegExp(`^let ${bare}\\b`, 'm')),
          `${f}: module-scope 'let ${bare}' found — nav-pulse lifetime must live in the explicit NavPulseState object (audit §28)`,
        ).toBeNull();
      }
    }
    // Single definition site.
    const definers = allSourceFiles()
      .filter((f) => !f.includes('.test.'))
      .filter((f) => requireRaw(f).includes('interface NavPulseState'))
      .sort();
    expect(definers, 'NavPulseState must have exactly one definition site').toEqual([HOST_STORE]);
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

// ─────────────────────────────────────────────────────────────────────────────
// 5. Step 14 prep — explicit SSE stream state + cancel request/teardown split
//    (docs/architecture/web-generator-extraction-audit.md §23)
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 14 prep — SSE stream state ownership (single explicit object)', () => {
  it('generateStore owns the SSE stream state as an explicit object (no module-scope pair)', () => {
    const store = requireRaw(HOST_STORE);
    // The explicit state object with a single owner.
    expect(store).toMatch(/interface SseStreamState\s*\{/);
    expect(store).toMatch(/controller: AbortController \| null/);
    expect(store).toMatch(/epoch: number/);
    expect(store).toMatch(/const sseStream = createSseStreamState\(\)/);
    // start/stop operate through the explicit state object only.
    expect(store).toMatch(/\+\+sseStream\.epoch/);
    expect(store).toMatch(/sseStream\.epoch\+\+/);
    expect(store).toContain('sseStream.controller');
  });

  it('the old module-scope SSE bindings are GONE from every host source file', () => {
    for (const f of allSourceFiles()) {
      if (!f.endsWith('.ts') && !f.endsWith('.tsx')) continue;
      const src = requireRaw(f);
      expect(
        src.match(/^let sseController\b/m),
        `${f}: module-scope 'let sseController' found — SSE state must be the explicit SseStreamState object`,
      ).toBeNull();
      expect(
        src.match(/^let sseEpoch\b/m),
        `${f}: module-scope 'let sseEpoch' found — the epoch lives on SseStreamState`,
      ).toBeNull();
    }
  });

  it('no other host module reaches into the SSE state (single owner, no aliasing)', () => {
    for (const f of allSourceFiles()) {
      if (f === HOST_STORE || f.includes('.test.')) continue;
      const src = requireRaw(f);
      expect(
        src.match(/\bsseStream\b/),
        `${f}: touches generateStore's SSE stream state — single-owner rule violated`,
      ).toBeNull();
    }
  });

  it('no duplicate SSE state implementation in host sources or package sources', () => {
    const hostDefiners = allSourceFiles()
      .filter((f) => !f.includes('.test.'))
      .filter((f) => requireRaw(f).includes('interface SseStreamState'))
      .sort();
    expect(hostDefiners, 'SseStreamState must have exactly one definition site').toEqual([HOST_STORE]);
  });
});

describe('Step 14 prep — cancel: request vs session teardown boundary', () => {
  it('the backend cancel request is an isolated transport-only leg', () => {
    const store = requireRaw(HOST_STORE);
    expect(store).toMatch(/async function requestCancelGeneration\(/);
    const leg = store.slice(store.indexOf('async function requestCancelGeneration('));
    const legBody = leg.slice(0, leg.indexOf('\n}'));
    // The request leg performs ONLY the transport call — no host-state writes.
    expect(legBody).toContain('cancel-generation');
    expect(legBody).not.toMatch(/\.value\s*=/);
    expect(legBody).not.toMatch(/\b(setGenerationStatus|stopTimer|stopProgressStream|resetProgressState|resetAnalysisProgress)\b/);
  });

  it('the local session teardown is an isolated state-only leg (no transport calls)', () => {
    const store = requireRaw(HOST_STORE);
    expect(store).toMatch(/function teardownGenerationSessionLocal\(\): void/);
    const leg = store.slice(store.indexOf('function teardownGenerationSessionLocal(): void'));
    const legBody = leg.slice(0, leg.indexOf('\n}'));
    expect(legBody).not.toMatch(/\bpostJson\b|\bgetJson\b|\bputJson\b|\bpostJsonLong\b/);
    // It owns the documented PRE-AWAIT reset sequence (behavior parity with
    // the old cancelGeneration — Step 14A: the settle writes live in their
    // own post-await leg and must NOT creep back in here).
    for (const token of [
      "setGenerationStatus('IDLE')",
      'progressTracking.newGenerationPending = false',
      'stopTimer()',
      'stopProgressStream()',
      'resetProgressState()',
      'vbookPollState.token++',
      'resetAnalysisProgress()',
    ]) {
      expect(legBody, `teardown leg must own: ${token}`).toContain(token);
    }
    for (const token of ['isRegenerating.value = false', "phase.value = 'IDLE'"]) {
      expect(
        legBody,
        `teardown leg must NOT own: ${token} — that write ran AFTER the await in the old cancelGeneration (Step 14A ordering contract)`,
      ).not.toContain(token);
    }
    // Step 20: the error leg left the cancel contour entirely (fileStore-owned);
    // no generation leg may write the file-flow error state.
    expect(legBody).not.toContain('errorMessage');
  });

  it('the post-request settle leg owns exactly the OLD post-await writes minus the removed error leg (Step 14A ordering × Step 20 ownership)', () => {
    const store = requireRaw(HOST_STORE);
    expect(store).toMatch(/function settleGenerationSessionAfterCancel\(\): void/);
    const leg = store.slice(store.indexOf('function settleGenerationSessionAfterCancel(): void'));
    const legBody = leg.slice(0, leg.indexOf('\n}'));
    // Step 14A: the writes the old cancelGeneration performed after await…
    expect(legBody).toContain('isRegenerating.value = false');
    expect(legBody).toContain("phase.value = 'IDLE'");
    // Step 20: …minus the errorMessage clear — the signal is fileStore-owned
    // (§30.4: the write was a null-over-null in every reachable state).
    expect(legBody).not.toContain('errorMessage');
    // No transport, no teardown bleed-in.
    expect(legBody).not.toMatch(/\bpostJson\b|\bgetJson\b|\bstopTimer\b|\bstopProgressStream\b|\bresetProgressState\b/);
  });

  it('cancelGeneration composes teardown → request → settle → conditional finalization (no hidden bridge)', () => {
    const store = requireRaw(HOST_STORE);
    const fn = store.slice(store.indexOf('export async function cancelGeneration(): Promise<void>'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('teardownGenerationSessionLocal()');
    expect(body).toContain('await requestCancelGeneration(bId)');
    // Step 14A: the settle writes happen AFTER the request resolves — never
    // before the await (the old cancelGeneration observable contract).
    expect(body).toContain('settleGenerationSessionAfterCancel()');
    // The navigation/playback bridge is NOT owned by the request contour —
    // it is an explicit host finalization leg after the request returns.
    expect(body).toContain('applyGenerationResults()');
    expect(body).not.toMatch(/\bpostJson\b/);
  });

  it('cancel call order is source-pinned: pre-await teardown, await request, post-await settle (Step 14A)', () => {
    const store = requireRaw(HOST_STORE);
    const fn = store.slice(store.indexOf('export async function cancelGeneration(): Promise<void>'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    const iTeardown = body.indexOf('teardownGenerationSessionLocal()');
    const iRequest = body.indexOf('await requestCancelGeneration(bId)');
    const iSettle = body.indexOf('settleGenerationSessionAfterCancel()');
    const iFinalize = body.indexOf('applyGenerationResults()');
    expect(iTeardown).toBeGreaterThanOrEqual(0);
    expect(iTeardown).toBeLessThan(iRequest);
    expect(iRequest).toBeLessThan(iSettle);
    expect(iSettle).toBeLessThan(iFinalize);
  });

  it('cancelTask still carries no hidden teardown of the shared session', () => {
    const store = requireRaw(HOST_STORE);
    const fn = store.slice(store.indexOf('export async function cancelTask('));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).not.toContain('teardownGenerationSessionLocal()');
    expect(body).not.toContain('stopProgressStream()');
  });

  it('no other module calls the private cancel legs (host-internal boundary)', () => {
    for (const f of allSourceFiles()) {
      if (f === HOST_STORE) continue;
      const src = requireRaw(f);
      expect(src, `${f}: reaches into the cancel request/teardown legs`).not.toMatch(
        /requestCancelGeneration|teardownGenerationSessionLocal|settleGenerationSessionAfterCancel/,
      );
    }
  });
});
// NOTE: the Step-15 session-status (phase/errorMessage) writer-set pins were
// relocated in Step 15A to their own boundary guard:
// architecture/session-status-contour.guard.test.ts (audit §26).
