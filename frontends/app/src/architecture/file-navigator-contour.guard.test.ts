// Architecture contour guards — File & Navigator extraction
// (docs/architecture/file-module-extraction-audit.md,
//  docs/architecture/navigator-module-extraction-audit.md).
//
// Phase 2 guards: Navigator physically extracted to @animastor/navigator package.
// Each assertion cites the audit section it pins.

import { describe, it, expect } from 'vitest';

// Raw source map (Vite `import.meta.glob`, typed by vite/client) — lets the
// guard statically scan the tree without node:fs (no @types/node in this app).
const RAW_SOURCES = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Import specifiers of a module (static + type + side-effect imports). */
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

/** All .ts/.tsx source paths (posix, relative to src), excluding this guard dir. */
function allSourceFiles(): string[] {
  return Object.keys(RAW_SOURCES)
    .filter((k) => !k.startsWith('/src/architecture/'))
    .map((k) => k.replace(/^\/src\//, ''))
    .sort();
}

const FILE_PAGE = 'pages/FilePage.tsx';
const NAV_ADAPTERS = 'app/navigatorAdapters.ts';

// ── Audit §Phase 1 — Navigator host boundary (frozen, carries into Phase 2) ──

// The host adapter is the single seam that wires the shared infrastructure.
// Phase 2: adapter imports from @animastor/navigator instead of local modules.
const ADAPTERS_REQUIRED = [
  '../state/generateStore',
  '../state/positionStore',
  '../state/resourceInvalidations',
  '../state/resilientReloader',
  '../state/playbackStore',
  '../api/client',
  '@animastor/navigator',
  './i18n',
  './router',
  './desktop',
  './icons',
].sort();

// ── Audit §Phase 1 — allowed import sets (frozen at baseline) ──
const FILE_ALLOWED = [
  'preact',
  'preact/hooks',
  '../api/client',
  '../app/i18n',
  '../app/icons',
  '../app/router',
  '../lib/ui',
  '../state/generateStore',
].sort();

describe('File contour guard (file-module-extraction-audit.md)', () => {
  it('Phase 1 — dependency boundary: FilePage imports only the frozen set', () => {
    expect(importSpecifiers(FILE_PAGE)).toEqual(FILE_ALLOWED);
  });

  it('Phase 1 — FilePage touches no Player store directly (state reach goes through generateStore)', () => {
    const specs = importSpecifiers(FILE_PAGE);
    expect(specs).not.toContain('../state/playbackStore');
    expect(specs).not.toContain('../state/positionStore');
  });

  it('Phase 0 — entry points: routes "/" + "/file", START_ROUTE, desktop panel mount', () => {
    const main = requireRaw('main.tsx');
    expect(main).toContain('<FilePage path="/" />');
    expect(main).toContain('<FilePage path="/file" />');
    expect(requireRaw('app/router.ts')).toMatch(/START_ROUTE:\s*Route\s*=\s*'\/file'/);
    expect(requireRaw('app/AppShell.tsx')).toContain('<FilePage />');
  });

  it('Phase 2 — hidden dependency frozen: "animastor:open-file" lives only in AppShell + FilePage', () => {
    const holders = allSourceFiles().filter((f) => requireRaw(f).includes('animastor:open-file')).sort();
    expect(holders).toEqual(['app/AppShell.tsx', 'pages/FilePage.tsx']);
  });

  it('Phase 4 — session-stash test ownership (auth-book-session covers the File session slice)', () => {
    const test = requireRaw('state/__tests__/auth-book-session.test.ts');
    expect(test).toContain('stashBookSessionForUser');
  });
});

describe('Navigator contour guard (navigator-module-extraction-audit.md, Phase 2)', () => {
  it('Phase 2 — host imports NavigatePage ONLY from @animastor/navigator', () => {
    const main = requireRaw('main.tsx');
    expect(main).toContain("import { NavigatePage } from '@animastor/navigator'");
    expect(main).not.toContain("import { NavigatePage } from './pages/NavigatePage'");
    expect(main).not.toContain("import { NavigatePage } from '../pages/NavigatePage'");

    const shell = requireRaw('app/AppShell.tsx');
    expect(shell).toContain("import { NavigatePage } from '@animastor/navigator'");
    expect(shell).not.toContain("import { NavigatePage } from '../pages/NavigatePage'");
  });

  it('Phase 2 — host adapter imports from @animastor/navigator (not local modules/navigator)', () => {
    const specs = importSpecifiers(NAV_ADAPTERS);
    expect(specs).toContain('@animastor/navigator');
    expect(specs).not.toContain('../modules/navigator/ports');
    expect(specs).not.toContain('../pages/NavigatePage');
  });

  it('Phase 2 — adapter wires all host infrastructure seams', () => {
    const specs = importSpecifiers(NAV_ADAPTERS);
    for (const required of ADAPTERS_REQUIRED) {
      expect(specs, `navigatorAdapters must wire ${required}`).toContain(required);
    }
  });

  it('Phase 0 — entry points: route "/navigate" + desktop panel mount (ports composed)', () => {
    expect(requireRaw('main.tsx')).toContain('<NavigatePage path="/navigate" ports={navigatorPorts} />');
    expect(requireRaw('app/AppShell.tsx')).toContain('<NavigatePage ports={navigatorPorts} />');
  });

  it('Phase 2 — no old Navigator remnants: pages/NavigatePage.tsx deleted from host', () => {
    const fileKeys = Object.keys(RAW_SOURCES);
    expect(fileKeys).not.toContain('/src/pages/NavigatePage.tsx');
  });

  it('Phase 2 — no old Navigator remnants: modules/navigator/ deleted from host', () => {
    const fileKeys = Object.keys(RAW_SOURCES);
    const navModuleKeys = fileKeys.filter((k) => k.startsWith('/src/modules/navigator/'));
    expect(navModuleKeys).toEqual([]);
  });

  it('Phase 2 — zero reverse dependencies: only main.tsx, AppShell, and navigatorAdapters import @animastor/navigator', () => {
    const allowedConsumers = ['main.tsx', 'app/AppShell.tsx', 'app/navigatorAdapters.ts'];
    const consumers = allSourceFiles()
      .filter((f) => !allowedConsumers.includes(f))
      .filter((f) => {
        const src = requireRaw(f);
        return src.includes('@animastor/navigator');
      });
    expect(consumers).toEqual([]);
  });

  it('Phase 2 — no duplicate Navigator implementation in host (no pages/NavigatePage references)', () => {
    const fileKeys = Object.keys(RAW_SOURCES);
    const hasOldPage = fileKeys.some((k) => k.includes('NavigatePage') && k.startsWith('/src/pages/'));
    expect(hasOldPage).toBe(false);
  });

  it('npm prep — host reaches the package ONLY through the public entry point', () => {
    for (const f of allSourceFiles()) {
      const src = requireRaw(f);
      if (!src.includes('@animastor/navigator')) continue;
      // Deep-import specifiers into package internals are forbidden
      expect(src, `${f} deep-imports package internals`).not.toMatch(/@animastor\/navigator\/(?:src|dist|test)\//);
      expect(src, `${f} imports @animastor/navigator/package.json`).not.toContain('@animastor/navigator/package.json');
    }
  });

  it('npm prep — no host file resolves the navigator package by relative path', () => {
    for (const f of allSourceFiles()) {
      for (const spec of importSpecifiers(f)) {
        expect(spec, `${f} bypasses the package entry via "${spec}"`).not.toMatch(/\.\.\/\.\.\/packages\/animastor-navigator/);
        expect(spec, `${f} imports navigator package internals via "${spec}"`).not.toMatch(/packages\/animastor-navigator\/src\//);
      }
    }
  });
});

describe('Shared guards', () => {
  it('Cycle guard — no page imports AppShell (desktop.ts:1-6 contract)', () => {
    expect(importSpecifiers(FILE_PAGE)).not.toContain('../app/AppShell');
  });

  it('Package boundary — FilePage never imports features/ or other pages', () => {
    for (const spec of importSpecifiers(FILE_PAGE)) {
      expect(spec, `FilePage must not import ${spec}`).not.toMatch(/features\//);
      expect(spec, `FilePage must not import another page`).not.toMatch(/\.\.\/pages\//);
    }
  });

  it('Cycle guard — generateStore ⇄ playbackStore stays the ONLY state-module cycle (frozen, documented)', () => {
    const stateModules = allSourceFiles()
      .filter((f) => f.startsWith('state/') && f.endsWith('.ts') && !f.includes('.test.'));

    const edges = new Map<string, string[]>(); // module → its ./ sibling targets
    const known = new Set(stateModules);
    for (const mod of stateModules) {
      const base = `./${mod.split('/').pop()}`;
      const targets = importSpecifiers(mod)
        .filter((s) => s.startsWith('./') && s !== base)
        .map((s) => `state/${s.replace('./', '')}`)
        // Bundler imports are extensionless ("./playbackStore"); keep only
        // specifiers that point at a state/*.ts module that actually exists.
        .filter((t) => known.has(`${t}.ts`) || known.has(t))
        .map((t) => (known.has(`${t}.ts`) ? `${t}.ts` : t));
      edges.set(mod, targets);
    }

    // The documented runtime cycle (generateStore.ts:21-23, playbackStore.test.ts:30).
    expect(edges.get('state/generateStore.ts')).toContain('state/playbackStore.ts');
    expect(edges.get('state/playbackStore.ts')).toContain('state/generateStore.ts');

    // No other state-module cycle may appear.
    for (const [from, targets] of edges) {
      for (const to of targets) {
        if (edges.get(to)?.includes(from)) {
          expect(
            [from, to].sort(),
            'unexpected state-module cycle — see audits Phase 2',
          ).toEqual(['state/generateStore.ts', 'state/playbackStore.ts']);
        }
      }
    }
  });
});
