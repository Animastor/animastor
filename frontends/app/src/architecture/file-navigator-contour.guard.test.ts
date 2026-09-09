// Architecture contour guards — File & Navigator extraction
// (docs/architecture/file-module-extraction-audit.md,
//  docs/architecture/navigator-module-extraction-audit.md).
//
// Phase 2 guards: Navigator physically extracted to @animastor/navigator package.
// File Phase 1-prep guards: FilePage consumes ONLY injected FilePorts; the host
// composition root (app/fileAdapters.ts) is the single seam to the shared
// infrastructure. Each assertion cites the audit section it pins.
//
// B1 split guards: File state lives in state/fileStore.ts (host-owned); the
// File UI contour (pages/FilePage.tsx + modules/file/**) reaches it only via
// FilePorts + fileAdapters, the shared session identity is NOT forked, and the
// generateStore ⇄ playbackStore cycle is dissolved (the File-slice closeBook
// player release moved with the slice into fileStore's `player` seam).

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
const FILE_ADAPTERS = 'app/fileAdapters.ts';
const FILE_PORTS = 'modules/file/ports.ts';
const FILE_STORE = 'state/fileStore.ts';

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

// ── Audit §Phase 1-prep — File host boundary (the FilePorts seam) ──

// FilePage may import ONLY preact + the ports contract. Everything else is
// host infrastructure and must be reached through injected FilePorts.
const FILE_PAGE_ALLOWED = [
  'preact',
  'preact/hooks',
  '../modules/file/ports',
].sort();

// The composition root is the ONLY host place where the File contract meets
// the shared infrastructure (same seam rule as navigatorAdapters). B1 split:
// the root now wires BOTH the fileStore (File-owned state) and generateStore
// (shared session identity) + playbackStore (player release port).
const FILE_ADAPTERS_REQUIRED = [
  '../api/client',
  './i18n',
  './router',
  '../lib/ui',
  './icons',
  '../state/generateStore',
  '../state/fileStore',
  '../state/playbackStore',
  '../modules/file/ports',
].sort();

// Host files allowed to reference the File page or its ports (entry points +
// composition root + this guard's subject files).
const FILE_CONSUMERS_ALLOWED = [
  'main.tsx',
  'app/AppShell.tsx',
  'app/fileAdapters.ts',
].sort();

describe('File contour guard (file-module-extraction-audit.md)', () => {
  it('Phase 1-prep — dependency boundary: FilePage imports ONLY preact + FilePorts (host infra FORBIDDEN)', () => {
    expect(importSpecifiers(FILE_PAGE)).toEqual(FILE_PAGE_ALLOWED);
  });

  it('Phase 1-prep — FilePorts contract imports nothing but Preact types', () => {
    for (const spec of importSpecifiers(FILE_PORTS)) {
      expect(spec, `modules/file/ports.ts must not depend on ${spec}`).toMatch(/^(@preact\/signals|preact(?:\/.*)?)$/);
    }
  });

  it('Phase 1-prep — "File → frontends/app infrastructure" is FORBIDDEN for the whole modules/file/ contour', () => {
    const contourFiles = allSourceFiles().filter((f) => f.startsWith('modules/file/') && !f.includes('.test.'));
    expect(contourFiles.length).toBeGreaterThan(0);
    for (const f of [...contourFiles, FILE_PAGE]) {
      for (const spec of importSpecifiers(f)) {
        expect(spec, `${f} reaches host infrastructure via "${spec}"`).not.toMatch(/\.\.\/(api|app|state|lib|features|pages)\//);
        expect(spec, `${f} reaches host infrastructure via "${spec}"`).not.toMatch(/^\.\/(api|app|state|lib|features|pages)\//);
        expect(spec, `${f} reaches AppShell directly`).not.toContain('AppShell');
      }
    }
  });

  it('Phase 1-prep — host → File: only entry points and the composition root reference the File contour', () => {
    const consumers = allSourceFiles()
      .filter((f) => !f.includes('.test.'))
      .filter((f) => !FILE_CONSUMERS_ALLOWED.includes(f) && !f.startsWith('modules/file/') && f !== FILE_PAGE)
      .filter((f) => {
        const specs = importSpecifiers(f).join(' ');
        return specs.includes('pages/FilePage') || specs.includes('modules/file');
      });
    expect(consumers).toEqual([]);
  });

  it('Phase 1 — FilePage touches no Player store directly (state reach goes through FilePorts)', () => {
    const specs = importSpecifiers(FILE_PAGE);
    expect(specs).not.toContain('../state/playbackStore');
    expect(specs).not.toContain('../state/positionStore');
  });

  it('Phase 1-prep — adapter wires all host infrastructure seams (single composition root)', () => {
    const specs = importSpecifiers(FILE_ADAPTERS);
    for (const required of FILE_ADAPTERS_REQUIRED) {
      expect(specs, `fileAdapters must wire ${required}`).toContain(required);
    }
  });

  it('Phase 0 — entry points: routes "/" + "/file", START_ROUTE, desktop panel mount (ports composed)', () => {
    const main = requireRaw('main.tsx');
    expect(main).toContain('<FilePage path="/" ports={filePorts} />');
    expect(main).toContain('<FilePage path="/file" ports={filePorts} />');
    expect(requireRaw('app/router.ts')).toMatch(/START_ROUTE:\s*Route\s*=\s*'\/file'/);
    expect(requireRaw('app/AppShell.tsx')).toContain('<FilePage ports={filePorts} />');
  });

  it('Phase 1-prep — hidden dependency made explicit: "animastor:open-file" has ONE definition (fileAdapters) and AppShell dispatches through it', () => {
    // The raw event-name literal lives ONLY in the host adapter (single source
    // of truth); the File surface must not know it at all.
    const holders = allSourceFiles().filter((f) => requireRaw(f).includes('animastor:open-file')).sort();
    expect(holders).toEqual(['app/fileAdapters.ts']);
    // AppShell dispatches the open request through the adapter's constant.
    const shell = requireRaw('app/AppShell.tsx');
    expect(shell).toContain("import { filePorts, OPEN_FILE_EVENT } from './fileAdapters'");
    expect(shell).toContain('new CustomEvent(OPEN_FILE_EVENT)');
    expect(requireRaw(FILE_PAGE).includes('animastor:open-file')).toBe(false);
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
  it('Cycle guard — FilePage never imports AppShell (desktop.ts:1-6 contract)', () => {
    expect(importSpecifiers(FILE_PAGE)).not.toContain('../app/AppShell');
  });

  it('Package boundary — FilePage never imports features/ or other pages', () => {
    for (const spec of importSpecifiers(FILE_PAGE)) {
      expect(spec, `FilePage must not import ${spec}`).not.toMatch(/features\//);
      expect(spec, `FilePage must not import another page`).not.toMatch(/\.\.\/pages\//);
    }
  });
});

describe('B4+B6 extraction readiness guards (file-module-extraction-audit.md)', () => {
  it('B6 — fileStore only writes File-owned phase values through the session seam (LOADING_BOOK / IMPORTING_TXT / SCENE_READY / IDLE)', () => {
    const src = requireRaw(FILE_STORE);
    // All session.phase.value = assignments in fileStore must use only the
    // File-owned subset. Generation-owned values (GENERATING, DOWNLOADING,
    // PLAYING, PAUSED) must never appear as writes in this file.
    const FILE_PHASE_WRITES = /session\.phase\.value\s*=/g;
    const allWrites = [...src.matchAll(FILE_PHASE_WRITES)];
    expect(allWrites.length).toBeGreaterThan(0); // fileStore must actually write phase

    // Extract the value written by each assignment: look for the string literal
    // on the right-hand side of session.phase.value =
    const FILE_OWNED = new Set(['IDLE', 'LOADING_BOOK', 'IMPORTING_TXT', 'SCENE_READY']);
    const GENERATION_OWNED = new Set(['GENERATING', 'DOWNLOADING', 'PLAYING', 'PAUSED']);

    for (const m of allWrites) {
      const after = src.slice(m.index! + m[0].length, m.index! + m[0].length + 80);
      // Match string literal values like 'SCENE_READY' or scenes.length ? 'SCENE_READY' : 'IDLE'
      const literals = [...after.matchAll(/'([A-Z_]+)'/g)].map((v) => v[1]);
      for (const lit of literals) {
        if (FILE_OWNED.has(lit)) continue; // OK — File-owned
        if (GENERATION_OWNED.has(lit)) {
          // If this is a ternary like scenes.length ? 'SCENE_READY' : 'IDLE',
          // the generation-owned value is the false-branch. This means fileStore
          // is using GENERATING etc. as a fallback — which is a B6 violation.
          expect(
            false,
            `fileStore writes generation-owned phase '${lit}' — B6 violation: File may only write LOADING_BOOK / IMPORTING_TXT / SCENE_READY / IDLE`,
          ).toBe(true);
        }
        // Other string literals (non-phase) are fine (error messages, etc.)
      }
    }
  });

  it('B4 — fileStore calls cross-module backend endpoints via HTTP only (no backend-package imports)', () => {
    const specs = importSpecifiers(FILE_STORE);
    // fileStore legitimately uses api/client for HTTP calls to Editor/Player
    // endpoints. It must NOT import backend packages or route implementations.
    for (const spec of specs) {
      expect(spec, `fileStore must not import backend package "${spec}"`).not.toMatch(/backend\//);
      expect(spec, `fileStore must not import @animastor/editor`).not.toMatch(/animastor\/editor/);
      expect(spec, `fileStore must not import @animastor/player`).not.toMatch(/animastor\/player/);
    }
    // fileStore may only use api/client and positionStore — the API seam.
    const allowedHostImports = new Set([
      '../api/client',
      '../api/models',
      './positionStore',
    ]);
    const hostImports = specs.filter((s) => s.startsWith('../') || s.startsWith('./'));
    for (const imp of hostImports) {
      expect(allowedHostImports.has(imp), `fileStore host import "${imp}" is not in the allowed set`).toBe(true);
    }
  });

  it('B6 — generateStore only writes generation-owned phase values (GENERATING / SCENE_READY / IDLE)', () => {
    const src = requireRaw('state/generateStore.ts');
    const WRITE_PATTERN = /phase\.value\s*=/g;
    const allWrites = [...src.matchAll(WRITE_PATTERN)];
    expect(allWrites.length).toBeGreaterThan(0);

    const GENERATION_OWNED = new Set(['GENERATING', 'SCENE_READY', 'IDLE']);
    const FILE_OWNED = new Set(['LOADING_BOOK', 'IMPORTING_TXT']);

    for (const m of allWrites) {
      const after = src.slice(m.index! + m[0].length, m.index! + m[0].length + 80);
      const literals = [...after.matchAll(/'([A-Z_]+)'/g)].map((v) => v[1]);
      for (const lit of literals) {
        if (GENERATION_OWNED.has(lit)) continue;
        if (FILE_OWNED.has(lit)) {
          expect(
            false,
            `generateStore writes file-owned phase '${lit}' — B6 violation: Generation may only write GENERATING / SCENE_READY / IDLE`,
          ).toBe(true);
        }
      }
    }
  });

  it('B4 — File page never references backend implementation paths (HTTP is the only contract)', () => {
    // FilePage + fileStore must not reference backend route files, packages,
    // or any backend implementation detail — the API client is the seam.
    for (const f of [FILE_PAGE, FILE_STORE]) {
      const src = requireRaw(f);
      expect(src, `${f} must not reference backend routes`).not.toMatch(/backend\/(routes|src|packages)/);
      expect(src, `${f} must not reference @animastor/editor`).not.toMatch(/@animastor\/editor/);
      expect(src, `${f} must not reference @animastor/player`).not.toMatch(/@animastor\/player/);
    }
  });

  it('B6 — phase ownership: File-owned and Generation-owned values partition cleanly (no overlap)', () => {
    // The File-owned values (LOADED through session seam) and Generation-owned
    // values (written directly in generateStore) must not overlap.
    // SCENE_READY is shared (both writers) — it appears in the shared union.
    // The non-shared values must be exclusive to one writer.
    const FILE_EXCLUSIVE = ['LOADING_BOOK', 'IMPORTING_TXT'];
    const GEN_EXCLUSIVE = ['GENERATING'];

    const fileSrc = requireRaw(FILE_STORE);
    const genSrc = requireRaw('state/generateStore.ts');

    for (const v of FILE_EXCLUSIVE) {
      expect(genSrc, `generateStore must not write file-exclusive phase '${v}'`).not.toMatch(new RegExp(`phase\.value\s*=\s*'${v}'`));
    }
    for (const v of GEN_EXCLUSIVE) {
      expect(fileSrc, `fileStore must not write generation-exclusive phase '${v}'`).not.toMatch(new RegExp(`session\.phase\.value\s*=\s*'${v}'`));
    }
  });
});

describe('B1 split guards — fileStore ownership + cycle dissolution (file-module-extraction-audit.md)', () => {
  it('B1 — File UI never imports the fileStore (FilePage knows only FilePorts)', () => {
    const specs = importSpecifiers(FILE_PAGE);
    expect(specs).not.toContain('../state/fileStore');
    expect(specs).not.toContain('state/fileStore');
  });

  it('B1 — the File contour never reaches generateStore or fileStore directly (both via FilePorts)', () => {
    const contourFiles = allSourceFiles()
      .filter((f) => (f.startsWith('modules/file/') || f === FILE_PAGE) && !f.includes('.test.'));
    expect(contourFiles.length).toBeGreaterThan(0);
    for (const f of contourFiles) {
      const specs = importSpecifiers(f).join(' ');
      expect(specs, `${f} must not import generateStore`).not.toContain('generateStore');
      expect(specs, `${f} must not import fileStore`).not.toContain('fileStore');
    }
  });

  it('B1 — fileStore owns NO identity: bookId/buildId/phase/errorMessage are not re-declared there', () => {
    const src = requireRaw(FILE_STORE);
    // A fork would re-declare these signals; fileStore must only receive them
    // through the injected session seam.
    expect(src).not.toMatch(/export const (bookId|buildId|phase|errorMessage)\b/);
    expect(src).toMatch(/interface SessionSeam/); // the seam contract exists
  });

  it('B1 — fileStore reaches shared state only downward (generateStore NOT re-exported through it)', () => {
    const specs = importSpecifiers(FILE_STORE);
    // fileStore may import positionStore + api client; it must NOT import
    // generateStore or playbackStore (both arrive via the injected seams —
    // that is what keeps the future package boundary honest).
    expect(specs).not.toContain('./generateStore');
    expect(specs).not.toContain('./playbackStore');
  });

  it('Cycle guard (dissolved) — generateStore no longer imports playbackStore; playbackStore → generateStore stays one-way', () => {
    // The old generateStore ⇄ playbackStore cycle existed ONLY for the File
    // slice's closeBook player release. B1 moved closeBook into fileStore with
    // an injected player port, so the generateStore leg is gone. This is a
    // strengthening of the old "one allowed cycle" rule: ZERO cycles now.
    expect(importSpecifiers('state/generateStore.ts')).not.toContain('./playbackStore');
    expect(importSpecifiers('state/playbackStore.ts')).toContain('./generateStore');
    // The player release moved into the composition root's wiring:
    expect(importSpecifiers(FILE_ADAPTERS)).toContain('../state/playbackStore');
  });

  it('Cycle guard — NO state-module cycle exists at all (was: one frozen cycle allowed)', () => {
    const stateModules = allSourceFiles()
      .filter((f) => f.startsWith('state/') && f.endsWith('.ts') && !f.includes('.test.'));

    const edges = new Map<string, string[]>(); // module → its ./ sibling targets
    const known = new Set(stateModules);
    for (const mod of stateModules) {
      const base = `./${mod.split('/').pop()}`;
      const targets = importSpecifiers(mod)
        .filter((s) => s.startsWith('./') && s !== base)
        .map((s) => `state/${s.replace('./', '')}`)
        .filter((t) => known.has(`${t}.ts`) || known.has(t))
        .map((t) => (known.has(`${t}.ts`) ? `${t}.ts` : t));
      edges.set(mod, targets);
    }

    for (const [from, targets] of edges) {
      for (const to of targets) {
        expect(edges.get(to), `state cycle ${from} → ${to}`).not.toContain(from);
      }
    }
    // Documented post-B1 shape (all one-directional):
    expect(edges.get('state/playbackStore.ts')).toContain('state/generateStore.ts');
    expect(edges.get('state/generateStore.ts')).not.toContain('state/playbackStore.ts');
  });
});
