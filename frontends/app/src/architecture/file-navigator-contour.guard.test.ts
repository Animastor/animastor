// Architecture contour guards — File & Navigator extraction reconnaissance
// (docs/architecture/file-module-extraction-audit.md,
//  docs/architecture/navigator-module-extraction-audit.md).
//
// Phase-0 guards only: they FREEZE the measured boundary so drift before the
// physical extraction is caught. They do not create packages and do not move
// production code. Each assertion cites the audit section it pins.

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
const NAV_PAGE = 'pages/NavigatePage.tsx';

// ── Audit §Phase 1 — allowed import sets (measured at baseline 8987fb84) ──
// New specifier ⇒ boundary drift ⇒ update the audit BEFORE touching code.
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

const NAV_ALLOWED = [
  'preact',
  'preact/hooks',
  '../api/client',
  '../api/models',
  '../app/desktop',
  '../app/i18n',
  '../app/icons',
  '../app/router',
  '../state/generateStore',
  '../state/playbackStore',
  '../state/positionStore',
  '../state/resilientReloader',
  '../state/resourceInvalidations',
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

describe('Navigator contour guard (navigator-module-extraction-audit.md)', () => {
  it('Phase 1 — dependency boundary: NavigatePage imports only the frozen set', () => {
    expect(importSpecifiers(NAV_PAGE)).toEqual(NAV_ALLOWED);
  });

  it('Phase 0 — entry points: route "/navigate" + desktop panel mount', () => {
    expect(requireRaw('main.tsx')).toContain('<NavigatePage path="/navigate" />');
    expect(requireRaw('app/AppShell.tsx')).toContain('<NavigatePage />');
  });

  it('Phase 2 — zero reverse dependencies: only main.tsx and AppShell import the pages', () => {
    const consumers = allSourceFiles()
      .filter((f) => f !== 'main.tsx' && f !== 'app/AppShell.tsx' && !f.startsWith('pages/'))
      .filter((f) => {
        const src = requireRaw(f);
        return src.includes('pages/FilePage') || src.includes('pages/NavigatePage');
      });
    expect(consumers).toEqual([]);
  });
});

describe('Shared guards (both contours)', () => {
  it('Cycle guard — no page imports AppShell (desktop.ts:1-6 contract)', () => {
    for (const page of [FILE_PAGE, NAV_PAGE]) {
      expect(importSpecifiers(page)).not.toContain('../app/AppShell');
    }
  });

  it('Package boundary — pages never import features/ or other pages', () => {
    for (const page of [FILE_PAGE, NAV_PAGE]) {
      for (const spec of importSpecifiers(page)) {
        expect(spec, `${page} must not import ${spec}`).not.toMatch(/features\//);
        expect(spec, `${page} must not import another page`).not.toMatch(/\.\.\/pages\//);
      }
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
