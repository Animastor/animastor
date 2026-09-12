// Architecture contour guards — Web Player extraction Phase 1 prep
// (docs/architecture/web-player-module-extraction-audit.md).
//
// Phase 1 (ports in-app, BEFORE any physical move): the Player contour —
// the engine (state/playbackStore.ts), the pure gate (state/playbackGate.ts),
// the media cache (cache/mediaCache.ts) and the Play surface
// (pages/PlayPage.tsx) — still lives inside frontends/app, but it must
// already honor the future @animastor/web-player package boundary:
//
//   - NO direct imports of host infrastructure (state stores other than the
//     contour itself, api/*, app/*) — everything arrives via PlayerPorts;
//   - the ONLY host place wiring those modules together is
//     app/playerAdapters.ts (the composition seam);
//   - the host consumes the contour through the module entry only
//     (no deep imports — there is nothing deeper than the entry today;
//     the guard keeps it that way);
//   - the engine must not become a second public identity source: the
//     session bookId/buildId singletons live in generateStore and reach the
//     Play surface ONLY through the session port.
//
// When the physical package is cut (Phase 3), the import specifiers change
// to @animastor/web-player and these assertions re-aim mechanically; the
// boundary rules themselves stay frozen from today.

import { describe, it, expect } from 'vitest';

// Raw source map (Vite import.meta.glob, typed by vite/client) — lets the
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

// ── The Player contour (measured in the audit §1; moves together later) ──────
const PLAYER_ENGINE = 'state/playbackStore.ts';
const PLAYER_GATE = 'state/playbackGate.ts';
const PLAYER_CACHE = 'cache/mediaCache.ts';
const PLAYER_PAGE = 'pages/PlayPage.tsx';
const PLAYER_CONTOUR = [PLAYER_ENGINE, PLAYER_GATE, PLAYER_CACHE, PLAYER_PAGE];
const PLAYER_ADAPTERS = 'app/playerAdapters.ts';

// The player-closure modules the contour may import relatively (itself + the
// ports/models contract files that will move with the package).
const PLAYER_CLOSURE_SPECIFIERS = [
  './playbackGate',            // engine → gate (internal, zero-import leaf)
  '../cache/mediaCache',       // engine → media cache (moves with the package)
  '../state/playbackStore',    // PlayPage → engine (page renders engine signals)
  '../modules/player/ports',   // engine/page → PlayerPorts contract
  '../modules/player/models',  // engine → vendored structural models
];

// Host files allowed to import the Player contour by module entry (audit
// §2.3 — the six host consumers; PlayPage and the engine itself are contour,
// not host consumers; playerAdapters is the composition seam, asserted
// separately):
const PLAYER_HOST_CONSUMERS_ALLOWED = [
  'main.tsx',                  // route mount + wirePlayback* calls
  'app/fileAdapters.ts',       // player release seam (closeBook)
  'app/navigatorAdapters.ts',  // seek port (seekToPosition)
  'pages/EditPage.tsx',        // external seek + delete-invalidations
  'pages/SettingsPage.tsx',    // closeBook + clearMediaCache
];

// ─────────────────────────────────────────────────────────────────────────────
// Player boundary guard — the future package boundary, held in-app from today
// ─────────────────────────────────────────────────────────────────────────────

describe('Player boundary guard (web-player-module-extraction-audit.md, Phase 1)', () => {
  it('boundary — the engine imports NO host state store, api/* or app/* module directly (ports only)', () => {
    // The contour's own modules are exempt (page → engine, engine → gate /
    // mediaCache): only the HOST half of the tree is forbidden below.
    const CONTOUR_INTERNAL = new Set([
      './playbackGate',
      '../cache/mediaCache',
      '../state/playbackStore',
    ]);
    for (const f of PLAYER_CONTOUR) {
      for (const spec of importSpecifiers(f)) {
        if (CONTOUR_INTERNAL.has(spec)) continue;
        // Host state stores: the engine's former direct edges (generateStore,
        // positionStore, resourceInvalidations) are now injected ports.
        expect(spec, `${f} must not import the host state stores (use PlayerPorts)`).not.toMatch(/^\.\/(?:generateStore|positionStore|resourceInvalidations|fileStore|authStore|resilientReloader)$/);
        expect(spec, `${f} must not import sibling state stores via ../state/`).not.toMatch(/^\.\.\/state\//);
        // api/* — HTTP goes through the http port; models are vendored in
        // modules/player/models.ts.
        expect(spec, `${f} must not import api/* (http port + vendored models)`).not.toMatch(/^\.\.\/api\//);
        // app/* — i18n/icons/desktop/router are page-side ports.
        expect(spec, `${f} must not import app/* (i18n/shellMode/icons ports)`).not.toMatch(/^\.\.\/app\//);
      }
    }
  });

  it('boundary — the contour resolves relative imports only inside the player closure', () => {
    for (const f of PLAYER_CONTOUR) {
      const rel = importSpecifiers(f).filter((s) => s.startsWith('.'));
      for (const spec of rel) {
        expect(
          PLAYER_CLOSURE_SPECIFIERS,
          `${f} imports "${spec}" outside the player closure (engine + gate + mediaCache + ports + models only)`,
        ).toContain(spec);
      }
    }
  });

  it('boundary — external imports are preact/@preact/signals peers only (no npm host deps)', () => {
    for (const f of PLAYER_CONTOUR) {
      for (const spec of importSpecifiers(f)) {
        if (spec.startsWith('.')) continue;
        expect(
          spec,
          `${f} imports non-peer external "${spec}" (package runtime deps: preact + @preact/signals only)`,
        ).toMatch(/^(?:preact|preact\/hooks|@preact\/signals)$/);
      }
    }
  });

  it('boundary — the ports contract imports nothing but Preact types + vendored models', () => {
    const specs = importSpecifiers('modules/player/ports.ts');
    for (const spec of specs) {
      expect(spec).toMatch(/^(?:@preact\/signals|preact|\.\/models)$/);
    }
    // models.ts is fully self-contained structural types + the pure sceneRefs.
    expect(importSpecifiers('modules/player/models.ts')).toEqual([]);
  });

  it('identity — the Play surface reads session identity ONLY through the session port (no generateStore import)', () => {
    const specs = importSpecifiers(PLAYER_PAGE);
    expect(specs, 'PlayPage must not import generateStore (session port only)').not.toContain('../state/generateStore');
    // The engine keeps its internal projection, but it must not be re-exported
    // as a second public source of truth for the session identity.
    const engineSrc = requireRaw(PLAYER_ENGINE);
    expect(engineSrc, 'the engine must not re-export bookId/buildId as a public identity source')
      .not.toMatch(/export\s+\{[^}]*\b(?:bookId|buildId)\b[^}]*\}/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Host contour guard — composition seam + consumer set (File/Navigator pattern)
// ─────────────────────────────────────────────────────────────────────────────

describe('Player host contour guard (Phase 1 prep)', () => {
  const PLAYER_ADAPTERS_REQUIRED = [
    '../state/generateStore',
    '../state/positionStore',
    '../state/resourceInvalidations',
    '../api/client',
    './i18n',
    './desktop',
    './icons',
    '../modules/player/ports',
  ].sort();

  it('composition seam — app/playerAdapters.ts exists and wires every host infrastructure seam', () => {
    const specs = importSpecifiers(PLAYER_ADAPTERS);
    for (const required of PLAYER_ADAPTERS_REQUIRED) {
      expect(specs, `playerAdapters must wire ${required}`).toContain(required);
    }
    // The adapter is a seam, not a surface: it must not render or run engine flows.
    expect(requireRaw(PLAYER_ADAPTERS)).not.toContain('preparePlayback');
    expect(requireRaw(PLAYER_ADAPTERS)).not.toContain('seekToPosition');
  });

  it('composition seam — playerAdapters is the ONLY host file wiring PlayerPorts (no parallel composition)', () => {
    // The PlayerPorts OBJECT (the bridge from host modules to the port
    // contract) must be constructed in exactly one host place: the adapter.
    // Consumers (main/Edit/Settings/fileAdapters/navigatorAdapters) import the
    // engine entry — that is the sanctioned direction — but none of them may
    // build a ports object themselves.
    const builders = allSourceFiles()
      .filter((f) => !f.includes('.test.'))
      .filter((f) => {
        const specs = importSpecifiers(f);
        const importsPortContract = specs.includes('../modules/player/ports') || specs.includes('./ports');
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
  });

  it('consumers — only the pinned host set imports the Player contour by module entry', () => {
    const consumers = allSourceFiles()
      .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))
      // the contour itself is not a host consumer:
      .filter((f) => !PLAYER_CONTOUR.includes(f))
      .filter((f) => {
        const specs = importSpecifiers(f);
        return specs.includes('../state/playbackStore') ||
          specs.includes('../cache/mediaCache') ||
          specs.includes('../state/playbackGate') ||
          specs.includes('./state/playbackStore');
      })
      .sort();
    expect(consumers).toEqual(PLAYER_HOST_CONSUMERS_ALLOWED.slice().sort());
  });

  it('consumers — no deep imports into the Player contour (module entries only)', () => {
    // A deep import would be any specifier reaching INTO a contour module's
    // internals — today the contour modules have no subpaths, so any
    // playbackStore/... style specifier (package-style deep reach) is caught
    // here before it can ever exist.
    for (const f of allSourceFiles()) {
      for (const spec of importSpecifiers(f)) {
        expect(
          spec,
          `${f} deep-imports the Player contour via "${spec}"`,
        ).not.toMatch(/(?:playbackStore|playbackGate|mediaCache)\/(?:src|dist|test|internal)/);
      }
    }
  });

  it('reverse dependency — the host does not read the engine-internal identity projection', () => {
    // The engine's bookId/buildId signals are a projection set by
    // preparePlayback; host code must read the identity from generateStore
    // (the singleton) — importing the engine's signals would fork the truth.
    const offenders = allSourceFiles()
      .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))
      .filter((f) => f !== PLAYER_PAGE && f !== PLAYER_ENGINE)
      .filter((f) => {
        const src = requireRaw(f);
        const importsEngine = src.includes("from '../state/playbackStore'") || src.includes("from './state/playbackStore'");
        if (!importsEngine) return false;
        // Extract the named bindings of that import statement.
        const m = src.match(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*playbackStore["']/);
        if (!m) return false;
        const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
        return names.includes('bookId') || names.includes('buildId');
      });
    expect(offenders).toEqual([]);
  });

  it('test mocks — playback suites inject fake PlayerPorts (no host-store module mocks left)', () => {
    // The engine suites must not vi.mock('../api/client') /
    // ('./generateStore') / ('./positionStore') anymore — the host reach is
    // the injected ports, so the mocks became the fake-ports object. The pure
    // gate suite never touched host modules and keeps its zero imports.
    const suites = allSourceFiles()
      .filter((f) => f.startsWith('state/playback') && f.includes('.test.'))
      // the gate suite is pure math — it drives no engine/host reach at all:
      .filter((f) => !f.startsWith('state/playbackGate.'));
    const offenders: string[] = [];
    for (const f of suites) {
      const src = requireRaw(f);
      if (/vi\.mock\(['"]\.\.\/api\/client['"]\s*,/.test(src) ||
          /vi\.mock\(['"]\.\/generateStore['"]\s*,/.test(src) ||
          /vi\.mock\(['"]\.\/positionStore['"]\s*,/.test(src)) {
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
    // And each suite wires the fake ports before driving the engine.
    const unwired = suites.filter((f) => !requireRaw(f).includes('wirePlaybackCoordination(fakePorts'));
    expect(unwired).toEqual([]);
  });
});
