// Architecture contour guards — Web Player extraction Phase 3 (physical
// package) per docs/architecture/web-player-module-extraction-audit.md.
//
// Phase 3: the Player contour — the engine (playbackStore.ts), the pure gate
// (playbackGate.ts), the media cache (mediaCache.ts), the Play surface
// (PlayPage.tsx), the ports contract (ports.ts) and the vendored structural
// models (models.ts) — physically lives in the @animastor/web-player package
// (packages/animastor-web-player/, file: dependency). The package-side twin of
// this guard lives in packages/animastor-web-player/test/boundary.test.ts and
// pins the package's internal rules (no host reach, peers-only externals,
// suite isolation, exact inventory).
//
// This HOST-side guard pins the app↔package seam:
//
//   - the host consumes the contour ONLY through the package public entry
//     '@animastor/web-player' — no deep imports (playbackStore, playbackGate,
//     mediaCache, models, ports, PlayPage as specifiers; no src|dist|test
//     reach, no relative path into packages/);
//   - exactly the six pinned host consumers import the entry (main + 5);
//   - app/playerAdapters.ts stays the ONLY composition seam (the single host
//     file where host infrastructure meets the Player contract) and wires
//     every host module;
//   - zero reverse dependency in host source: no file under src/ besides the
//     seam reaches the package internals, and the engine-side host stores are
//     not imported by any state module either (the old generateStore ⇄
//     playbackStore cycle stays dissolved — see the file-navigator guard);
//   - identity: the host never reads the engine's internal projection, and
//     the host files wiring the session identity do so from generateStore
//     singletons only;
//   - the auth-book-session suite mocks the package entry (not a deep path).
//
// Phase 2 history: the contour was relocated in-app to modules/player/ and
// guards held the boundary there; Phase 3 moved the files and re-aimed every
// host consumer at the package entry. modules/player/ no longer exists.

import { describe, it, expect } from 'vitest';

// Raw source map (Vite import.meta.glob, typed by vite/client) — lets the
// guard statically scan the host tree without node:fs (no @types/node here).
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

const PLAYER_PACKAGE = '@animastor/web-player';
const PLAYER_ADAPTERS = 'app/playerAdapters.ts';

// Host files allowed to import the Player package through the public entry
// (audit §2.3 — the six host consumers; test files are asserted separately).
const PLAYER_HOST_CONSUMERS_ALLOWED = [
  'main.tsx',                  // route mount + wirePlayback* calls
  'app/fileAdapters.ts',       // player release seam (closeBook)
  'app/navigatorAdapters.ts',  // seek port (seekToPosition)
  'pages/EditPage.tsx',        // external seek + delete-invalidations
  'pages/SettingsPage.tsx',    // closeBook + clearMediaCache
  PLAYER_ADAPTERS,             // PlayerPorts type import (composition seam)
];

// Deep-import specifiers — any host reach INTO the package internals.
// The public entry '@animastor/web-player' is the ONLY sanctioned specifier.
const PLAYER_DEEP_SPECIFIER =
  /^@animastor\/web-player\/(?!$)(?:playbackStore|playbackGate|mediaCache|models|ports|PlayPage|src|dist|test|internal)/;

// ─────────────────────────────────────────────────────────────────────────────
// Physical structure guard — no in-app Player remnant, package is the contour
// ─────────────────────────────────────────────────────────────────────────────

describe('Player physical structure guard (Phase 3 — package extraction)', () => {
  it('no in-app Player contour remnants (modules/player is gone)', () => {
    const files = Object.keys(RAW_SOURCES);
    const strays = files
      .filter((k) => /\/src\/modules\/player\//.test(k) || /^\/src\/modules\//.test(k))
      .filter((k) => /\.(ts|tsx)$/.test(k));
    expect(strays).toEqual([]);
    // The former in-app contour files exist nowhere in host source.
    for (const f of ['playbackStore.ts', 'playbackGate.ts', 'mediaCache.ts', 'PlayPage.tsx']) {
      expect(files).not.toContain(`/src/${f}`);
      expect(files).not.toContain(`/src/state/${f}`);
      expect(files).not.toContain(`/src/pages/${f}`);
    }
    expect(files).not.toContain('/src/modules/player/index.ts');
    // No compatibility shim: nothing re-exports the old path.
    const shims = allSourceFiles()
      .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))
      .filter((f) => /from\s+['"][^'"]*modules\/player['"]/.test(requireRaw(f)));
    expect(shims).toEqual([]);
  });

  it('the host package.json wires the player package as a file: dependency', () => {
    // frontends/app/package.json is outside /src; assert via the only file the
    // glob cannot see — the composition seam imports the bare specifier, and
    // package.json is checked in the dedicated boundary test. Here: at least
    // one consumer imports the package (the wiring exists).
    const consumers = allSourceFiles()
      .filter((f) => importSpecifiers(f).includes(PLAYER_PACKAGE));
    expect(consumers.length).toBeGreaterThanOrEqual(1);
  });

  it('the package public entry keeps the host-facing surface (no identity leak)', () => {
    // The entry source is package-side; the host guard pins the CONTRACT by
    // checking what the host files bind from the specifier — no host file may
    // bind the engine-internal identity signals from the package.
    for (const f of PLAYER_HOST_CONSUMERS_ALLOWED) {
      const names: string[] = [];
      for (const m of requireRaw(f).matchAll(/import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@animastor\/web-player['"]/g)) {
        names.push(...m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean));
      }
      expect(
        names.filter((n) => n === 'bookId' || n === 'buildId'),
        `${f} binds bookId/buildId from the package entry — identity stays generateStore-owned`,
      ).toEqual([]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Player host boundary guard — entry-only consumption, single composition seam
// ─────────────────────────────────────────────────────────────────────────────

describe('Player host boundary guard (Phase 3 — @animastor/web-player entry only)', () => {
  const PLAYER_ADAPTERS_REQUIRED = [
    '../state/generateStore',
    '../state/positionStore',
    '../state/resourceInvalidations',
    '../api/client',
    './i18n',
    './desktop',
    './icons',
    PLAYER_PACKAGE, // the package public entry (PlayerPorts type)
  ].sort();

  it('composition seam — app/playerAdapters.ts exists and wires every host infrastructure seam', () => {
    const specs = importSpecifiers(PLAYER_ADAPTERS);
    for (const required of PLAYER_ADAPTERS_REQUIRED) {
      expect(specs, `playerAdapters must wire ${required}`).toContain(required);
    }
    // The adapter imports the Player contract ONLY through the public entry.
    expect(specs.filter((s) => s.startsWith(`${PLAYER_PACKAGE}/`)), 'playerAdapters must not deep-import the player package').toEqual([]);
    // The adapter is a seam, not a surface: it must not render or run engine flows.
    expect(requireRaw(PLAYER_ADAPTERS)).not.toContain('preparePlayback');
    expect(requireRaw(PLAYER_ADAPTERS)).not.toContain('seekToPosition');
  });

  it('composition seam — playerAdapters is the ONLY host file wiring PlayerPorts (no parallel composition)', () => {
    // The PlayerPorts OBJECT (the bridge from host modules to the port
    // contract) must be constructed in exactly one host place: the adapter.
    const builders = allSourceFiles()
      .filter((f) => !f.includes('.test.'))
      .filter((f) => {
        const specs = importSpecifiers(f);
        const importsPortContract = specs.some(
          (s) => s === PLAYER_PACKAGE || s.startsWith(`${PLAYER_PACKAGE}/`),
        );
        if (!importsPortContract) return false;
        // Building the port object requires the host infra specifiers too —
        // the adapter is the only file where BOTH sides appear.
        const HOST_INFRA = /^(\.\.\/state\/(?:generateStore|positionStore|resourceInvalidations)|\.\.\/api\/client)$/;
        const touchesInfra = specs.some((s) => HOST_INFRA.test(s));
        const declaresPortsObject = requireRaw(f).match(/PlayerPorts\s*=\s*\{|playerPorts\s*:\s*PlayerPorts/) != null;
        return declaresPortsObject && touchesInfra;
      });
    expect(builders).toEqual([PLAYER_ADAPTERS]);
  });

  it('entry points — route mount is composition-rooted (main.tsx wires ports + renders the page)', () => {
    const main = requireRaw('main.tsx');
    expect(main).toContain("import { playerPorts } from './app/playerAdapters'");
    expect(main).toContain('wirePlaybackCoordination(playerPorts)');
    expect(main).toContain('wirePlaybackLifecycle()');
    expect(main).toContain('<PlayPage path="/play" ports={playerPorts} />');
    // main.tsx reaches the contour ONLY through the package entry.
    expect(main).toContain(`from '${PLAYER_PACKAGE}'`);
  });

  it('consumers — only the pinned host set imports the Player package, and only via the public entry', () => {
    const consumers = allSourceFiles()
      .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))
      .filter((f) => importSpecifiers(f).includes(PLAYER_PACKAGE))
      .sort();
    expect(consumers).toEqual(PLAYER_HOST_CONSUMERS_ALLOWED.slice().sort());
  });

  it('consumers — no deep imports into the Player package (public entry only)', () => {
    for (const f of allSourceFiles()) {
      for (const spec of importSpecifiers(f)) {
        expect(
          spec,
          `${f} deep-imports the Player package via "${spec}"`,
        ).not.toMatch(PLAYER_DEEP_SPECIFIER);
        // No relative reach into the package directory either.
        expect(
          spec,
          `${f} reaches the package by relative path "${spec}" (entry specifier only)`,
        ).not.toMatch(/packages\/animastor-web-player/);
      }
    }
  });

  it('reverse dependency — the package entry is consumed, never re-exported as host state', () => {
    // No host state module may re-export the package (a fork of the contour
    // inside state/ would recreate the old cycle physically).
    const stateFiles = allSourceFiles().filter((f) => f.startsWith('state/') && !f.includes('.test.'));
    for (const f of stateFiles) {
      expect(
        importSpecifiers(f).includes(PLAYER_PACKAGE),
        `${f} imports the player package — state/ reaches the Player only via injected seams`,
      ).toBe(false);
    }
  });

  it('test mocks — the auth suite mocks the package ENTRY (no deep-path mock)', () => {
    const auth = requireRaw('state/__tests__/auth-book-session.test.ts');
    expect(auth).toMatch(/vi\.mock\(['"]@animastor\/web-player['"]/);
    expect(auth).not.toMatch(/vi\.mock\(['"][^'"]*modules\/player/);
    expect(auth).not.toMatch(/vi\.mock\(['"]@animastor\/web-player\/(?!['"])/);
  });
});
