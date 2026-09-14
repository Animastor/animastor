// Architecture contour guard — VBook agent lifecycle PHYSICAL PACKAGE
// EXTRACTION (docs/architecture/web-generator-extraction-audit.md, Step 9).
//
// Phase: PHYSICAL PACKAGE (packages/animastor-web-generator-vbook/) — the
// VBook agent lifecycle orchestration (checkVBookAgentStatus +
// startVBookGeneration + pollVBookProgress + updateVBookProgress) has been
// physically extracted from state/generateStore.ts.
//
// Rules pinned here:
//   1. generateStore imports from @animastor/web-generator-vbook (package
//      root only — no deep imports).
//   2. Only generateStore consumes the package in production — GeneratePage
//      keeps its imports from the generateStore surface.
//   3. No host file imports deep paths: @animastor/web-generator-vbook/src/...
//   4. Host ownership preserved: generateStore keeps the vbookProgress
//      signal, poll-token authority (VBookPollState + bumpVBookPollToken),
//      timer ownership, SSE AbortController/epoch lifecycle,
//      applyGenerationResults, fileAdapters seams surface.
//   5. No duplicate production implementation — the old VBook
//      orchestration (poll loop / bootstrap decision / agent-status
//      classification) is GONE from generateStore; the host wrappers are
//      composition only.
//   6. No module-global mutable poll token in the host — the poll token is
//      the explicit VBookPollState object.
//   7. No reverse dependency: the package must not be imported by host
//      state modules other than generateStore; no package → host imports.
//   8. GeneratePage public surface unchanged — it still imports
//      startVBookGeneration / checkVBookAgentStatus from generateStore.

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
const VBOOK_PACKAGE = '@animastor/web-generator-vbook';
const GENERATE_PAGE = 'pages/GeneratePage.tsx';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Host consumption — root-only, single production consumer
// ─────────────────────────────────────────────────────────────────────────────

describe('VBook package extraction — host consumption', () => {
  it('generateStore imports from @animastor/web-generator-vbook (package root)', () => {
    const specs = importSpecifiers(HOST_STORE);
    expect(specs).toContain(VBOOK_PACKAGE);
  });

  it('no host file uses deep imports into the package', () => {
    for (const f of allSourceFiles()) {
      const specs = importSpecifiers(f);
      const deepImports = specs.filter((s) => s.startsWith(`${VBOOK_PACKAGE}/`));
      expect(
        deepImports,
        `${f} uses deep package imports: ${deepImports.join(', ')} — forbidden`,
      ).toEqual([]);
    }
  });

  it('only generateStore consumes the package in production (pages via store surface)', () => {
    const consumers = allSourceFiles()
      .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))
      .filter((f) => f !== HOST_STORE)
      .filter((f) => importSpecifiers(f).includes(VBOOK_PACKAGE))
      .sort();
    expect(
      consumers,
      `non-store files import from ${VBOOK_PACKAGE} directly — pages must use the store surface`,
    ).toEqual([]);
  });

  it('no host TEST file imports the package directly (test-mock discipline)', () => {
    const testConsumers = allSourceFiles()
      .filter((f) => f.endsWith('.test.ts') || f.endsWith('.test.tsx'))
      .filter((f) => importSpecifiers(f).includes(VBOOK_PACKAGE))
      .sort();
    expect(testConsumers).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Host ownership preserved
// ─────────────────────────────────────────────────────────────────────────────

describe('VBook package extraction — host ownership contract', () => {
  it('generateStore keeps the vbookProgress signal + VBook poll/token seams', () => {
    const store = requireRaw(HOST_STORE);
    for (const token of [
      'export const vbookProgress',
      'export function bumpVBookPollToken',
      'export function stopGenerationSession',
      'export function clearVBookProgress',
      'export async function checkVBookAgentStatus',
      'export async function startVBookGeneration',
      'createVBookPollState()',
      'onGenerationFinalized',
    ]) {
      expect(store, `generateStore must keep: ${token}`).toContain(token);
    }
  });

  it('applyGenerationResults stays host-side (navigation/playback boundary)', () => {
    const store = requireRaw(HOST_STORE);
    expect(store).toContain('export async function applyGenerationResults');
    expect(store).toContain('emitPlaybackPrepared');
    expect(store).toContain('navigateTo');
  });

  it('SSE lifecycle stays host-owned (no re-implementation in the VBook path)', () => {
    const store = requireRaw(HOST_STORE);
    expect(store).toContain('startProgressStream');
    expect(store).toContain('stopProgressStream');
    expect(store).toContain('sseController');
  });

  it('the module-global poll-token let is gone — explicit VBookPollState only', () => {
    const store = requireRaw(HOST_STORE);
    expect(store).not.toMatch(/^let\s+vbookPollToken/m);
    expect(store).toMatch(/const vbookPollState/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. No duplicate production implementation
// ─────────────────────────────────────────────────────────────────────────────

describe('VBook package extraction — no duplicate implementation', () => {
  it('the VBook poll loop / bootstrap decision no longer live in generateStore', () => {
    const store = requireRaw(HOST_STORE);
    // The old inline poll loop's distinctive tokens must be gone…
    expect(store).not.toMatch(/async function pollVBookProgress/);
    expect(store).not.toMatch(/needsBootstrap/);
    expect(store).not.toMatch(/consecutiveInactive/);
    expect(store).not.toMatch(/safetyCapTripped/);
    // …and the host wrappers delegate to the package.
    expect(store).toContain('checkVBookAgentStatusDomain(vbookAgentPorts)');
    expect(store).toContain('startVBookGenerationDomain(vbookAgentPorts)');
  });

  it('generateStore hosts a ports composition, not a second implementation', () => {
    const store = requireRaw(HOST_STORE);
    expect(store).toMatch(/const vbookAgentPorts: VBookAgentPorts/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Dependency direction — no reverse edges, no new cycles
// ─────────────────────────────────────────────────────────────────────────────

describe('VBook package extraction — dependency graph', () => {
  it('no state module imports the package (generateStore is the only adapter)', () => {
    const stateFiles = allSourceFiles().filter((f) =>
      f.startsWith('state/') && f.endsWith('.ts') && !f.includes('.test.'));
    for (const f of stateFiles) {
      if (f === HOST_STORE) continue;
      expect(
        importSpecifiers(f).includes(VBOOK_PACKAGE),
        `${f} imports from ${VBOOK_PACKAGE} — only generateStore should consume the package`,
      ).toBe(false);
    }
  });

  it('the package does not import host modules (source scan of the package)', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    // Vitest runs with cwd = frontends/app; the package lives at the repo root.
    const pkgSrcDir = join(
      process.cwd(), '..', '..', 'packages', 'animastor-web-generator-vbook', 'src',
    );
    const files = readdirSync(pkgSrcDir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const src = readFileSync(join(pkgSrcDir, file), 'utf8');
      // Scan import/export specifiers only — comments may legitimately
      // mention host module names in boundary documentation.
      const specs = new Set<string>();
      for (const re of [
        /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g,
        /import\s+['"]([^'"]+)['"]/g,
      ]) {
        for (const m of src.matchAll(re)) specs.add(m[1]);
      }
      const forbidden = [
        'generateStore', 'positionStore', 'authStore', 'fileStore',
        'playbackStore', '@preact/signals', 'api/client',
        'app/', 'pages/',
      ];
      for (const token of forbidden) {
        const hit = [...specs].find((s) => s === token || s.includes(token));
        expect(hit, `${file} imports forbidden target: ${token}`).toBeUndefined();
      }
    }
  });

  it('GeneratePage public surface is unchanged (still imports from generateStore)', () => {
    const page = requireRaw(GENERATE_PAGE);
    expect(page).toContain('startVBookGeneration');
    expect(page).toContain('checkVBookAgentStatus');
    expect(page).toMatch(/from '\.\.\/state\/generateStore'/);
  });
});
