// Architecture contour guards — Web Player extraction Phase 2 (physical
// relocation) per docs/architecture/web-player-module-extraction-audit.md.
//
// Phase 2: the Player contour — the engine (modules/player/playbackStore.ts),
// the pure gate (modules/player/playbackGate.ts), the media cache
// (modules/player/mediaCache.ts) and the Play surface
// (modules/player/PlayPage.tsx) — physically lives in
// frontends/app/src/modules/player/, in the future @animastor/web-player
// package layout. No package exists yet (Phase 3 cuts it); this guard holds
// the package boundary rules from today so the Phase 3 re-aim is mechanical:
//
//   - Player implementation exists ONLY under modules/player/ (no state/,
//     cache/, pages/ remnants);
//   - the host consumes the contour ONLY through the public entry
//     modules/player/index.ts — no deep imports (playbackStore, playbackGate,
//     mediaCache, models, ports as specifiers);
//   - the contour imports NO host infrastructure (state stores, api/*, app/*)
//     — everything arrives via PlayerPorts;
//   - app/playerAdapters.ts stays the ONLY composition seam (the single host
//     file where host infrastructure meets the Player contract);
//   - zero reverse dependencies: modules/player never imports pages/, app/
//     or state/;
//   - the engine never becomes a second public identity source (bookId/
//     buildId singletons live in generateStore; the engine keeps its
//     internal projection);
//   - Phase 2.1 identity closure: the Play surface consumes the session
//     identity (bookId/buildId) ONLY through PlayerPorts.session — never via
//     the engine's internal projection signals.
//   - Phase 2.2 test isolation: the suites physically inside modules/player/
//     import vitest + package-internal modules ONLY (resolution-checked
//     relative paths — no "./../…"/"../../…" escapes, no bare host
//     specifiers, no host-reaching dynamic imports or vi.mock paths) — they
//     move verbatim into the package's vitest run at the Phase 3 cut.
//
// The guard is written specifier-driven (no file-path coupling of the rules
// themselves): when Phase 3 moves the directory into
// packages/animastor-web-player, the module-relative assertions below carry
// over to the package's test/boundary.test.ts almost verbatim.

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

// ── The Player contour (Phase 2 physical location = future package src/) ────
const PLAYER_MODULE = 'modules/player';
const PLAYER_ENGINE = `${PLAYER_MODULE}/playbackStore.ts`;
const PLAYER_GATE = `${PLAYER_MODULE}/playbackGate.ts`;
const PLAYER_CACHE = `${PLAYER_MODULE}/mediaCache.ts`;
const PLAYER_PAGE = `${PLAYER_MODULE}/PlayPage.tsx`;
const PLAYER_ENTRY = `${PLAYER_MODULE}/index.ts`;
const PLAYER_CONTRACT = [`${PLAYER_MODULE}/ports.ts`, `${PLAYER_MODULE}/models.ts`];
const PLAYER_CONTOUR = [PLAYER_ENGINE, PLAYER_GATE, PLAYER_CACHE, PLAYER_PAGE];
const PLAYER_MODULE_FILES = [...PLAYER_CONTOUR, PLAYER_ENTRY, ...PLAYER_CONTRACT];
const PLAYER_ADAPTERS = 'app/playerAdapters.ts';

// The player-closure specifiers (module-relative imports inside the contour):
// engine → gate / mediaCache / models / ports; page → engine / ports.
const PLAYER_CLOSURE_SPECIFIERS = [
  './playbackGate',   // engine → gate (internal, zero-import leaf)
  './mediaCache',     // engine → media cache (moves with the package)
  './playbackStore',  // PlayPage → engine (page renders engine signals)
  './ports',          // engine/page → PlayerPorts contract
  './models',         // engine → vendored structural models
];

// Host files allowed to import the Player contour through the public entry
// (audit §2.3 — the six host consumers; the contour itself and its tests are
// not host consumers; playerAdapters is the composition seam, asserted
// separately; the moved contour test suites import the contour internally).
const PLAYER_HOST_CONSUMERS_ALLOWED = [
  'main.tsx',                  // route mount + wirePlayback* calls
  'app/fileAdapters.ts',       // player release seam (closeBook)
  'app/navigatorAdapters.ts',  // seek port (seekToPosition)
  'pages/EditPage.tsx',        // external seek + delete-invalidations
  'pages/SettingsPage.tsx',    // closeBook + clearMediaCache
  PLAYER_ADAPTERS,             // PlayerPorts type import (composition seam)
];

// Deep-import specifiers — any host reach INTO the contour's internals.
// The public entry (modules/player) is the ONLY sanctioned specifier.
const PLAYER_DEEP_SPECIFIER =
  /^\.\/modules\/player\/(?!index$)(?:playbackStore|playbackGate|mediaCache|models|ports|PlayPage)$/;

// ─────────────────────────────────────────────────────────────────────────────
// Physical structure guard — the contour exists ONLY under modules/player/
// ─────────────────────────────────────────────────────────────────────────────

describe('Player physical structure guard (Phase 2 — modules/player relocation)', () => {
  it('the Player contour files exist ONLY under modules/player/', () => {
    for (const f of PLAYER_MODULE_FILES) {
      expect(requireRaw(f), `${f} must exist under modules/player/`).toBeTruthy();
    }
  });

  it('no Player contour remnants outside modules/player/ (state/, cache/, pages/)', () => {
    const files = Object.keys(RAW_SOURCES);
    expect(files).not.toContain('/src/state/playbackStore.ts');
    expect(files).not.toContain('/src/state/playbackGate.ts');
    expect(files).not.toContain('/src/cache/mediaCache.ts');
    expect(files).not.toContain('/src/pages/PlayPage.tsx');
    // No stray playback* files anywhere outside the module either.
    const strays = files
      .filter((k) => !k.startsWith(`/src/${PLAYER_MODULE}/`))
      .filter((k) => /\/(?:playbackStore|playbackGate|mediaCache|PlayPage)\.(?:ts|tsx)$/.test(k));
    expect(strays).toEqual([]);
  });

  it('the public entry modules/player/index.ts exists and re-exports the host-facing symbols', () => {
    const src = requireRaw(PLAYER_ENTRY);
    // The entry is the package public API: page + engine commands + media
    // cache clear + the ports contract type. Nothing deeper is re-exported.
    expect(src).toMatch(/export\s*\{[^}]*\bPlayPage\b[^}]*\}\s*from\s*'\.\/PlayPage'/);
    expect(src).toMatch(/export\s*\{[^}]*\bwirePlaybackCoordination\b[^}]*\}\s*from\s*'\.\/playbackStore'/);
    expect(src).toMatch(/export\s*\{[^}]*\bseekToPosition\b[^}]*\}\s*from\s*'\.\/playbackStore'/);
    expect(src).toMatch(/export\s*\{[^}]*\bcloseBook\b[^}]*\}\s*from\s*'\.\/playbackStore'/);
    expect(src).toMatch(/export\s*\{[^}]*\bclearCache as clearMediaCache\b[^}]*\}\s*from\s*'\.\/mediaCache'/);
    expect(src).toMatch(/export\s+type\s*\{\s*PlayerPorts\s*\}\s*from\s*'\.\/ports'/);
    // The entry must NOT leak the engine-internal identity projection as a
    // second public source of truth for the session identity.
    expect(src, 'the entry must not export bookId/buildId (identity stays generateStore-owned)')
      .not.toMatch(/export\s*\{[^}]*\b(?:bookId|buildId)\b[^}]*\}/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Player boundary guard — the future package boundary, held in-app from today
// (Phase 3: these rules carry into packages/animastor-web-player boundary.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

describe('Player boundary guard (web-player-module-extraction-audit.md, Phase 2)', () => {
  it('boundary — the engine imports NO host state store, api/* or app/* module directly (ports only)', () => {
    for (const f of PLAYER_CONTOUR) {
      for (const spec of importSpecifiers(f)) {
        // Host state stores: the engine's former direct edges (generateStore,
        // positionStore, resourceInvalidations) are injected ports.
        expect(spec, `${f} must not import the host state stores (use PlayerPorts)`).not.toMatch(/^\.\.\/(?:\.\.\/)*(?:state\/)?(?:generateStore|positionStore|resourceInvalidations|fileStore|authStore|resilientReloader)$/);
        expect(spec, `${f} must not import any host state module`).not.toMatch(/(?:^|\/)state\//);
        // api/* — HTTP goes through the http port; models are vendored in
        // modules/player/models.ts.
        expect(spec, `${f} must not import api/* (http port + vendored models)`).not.toMatch(/(?:^|\/)api\//);
        // app/* — i18n/icons/desktop/router are page-side ports.
        expect(spec, `${f} must not import app/* (i18n/shellMode/icons ports)`).not.toMatch(/(?:^|\/)app\//);
        // pages/* — the surface is INSIDE the contour; no page imports.
        expect(spec, `${f} must not import pages/*`).not.toMatch(/(?:^|\/)pages\//);
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
    const specs = importSpecifiers(`${PLAYER_MODULE}/ports.ts`);
    for (const spec of specs) {
      expect(spec).toMatch(/^(?:@preact\/signals|preact|\.\/models)$/);
    }
    // models.ts is fully self-contained structural types + the pure sceneRefs.
    expect(importSpecifiers(`${PLAYER_MODULE}/models.ts`)).toEqual([]);
  });

  it('identity — the Play surface reads session identity ONLY through the session port (no generateStore import)', () => {
    const specs = importSpecifiers(PLAYER_PAGE);
    expect(specs.filter((s) => /generateStore/.test(s)), 'PlayPage must not import generateStore (session port only)').toEqual([]);
    // The engine keeps its internal projection, but it must not be re-exported
    // as a second public source of truth for the session identity.
    const engineSrc = requireRaw(PLAYER_ENGINE);
    expect(engineSrc, 'the engine must not re-export bookId/buildId as a public identity source')
      .not.toMatch(/export\s*\{[^}]*\b(?:bookId|buildId)\b[^}]*\}/);
  });

  it('identity — PlayPage takes bookId/buildId ONLY through PlayerPorts.session (Phase 2.1 identity closure)', () => {
    const pageSrc = requireRaw(PLAYER_PAGE);
    // 1. No import statement (named, aliased, type or side-effect form) may
    //    bind the engine-internal identity signals from playbackStore —
    //    they are projection bookkeeping set by preparePlayback, not the
    //    public session identity.
    for (const m of pageSrc.matchAll(/(?:import|export)\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      expect(
        names.filter((n) => n === 'bookId' || n === 'buildId'),
        `PlayPage imports the engine-internal identity signals from "${m[2]}" — session identity must arrive through props.ports.session only`,
      ).toEqual([]);
    }
    // 2. No free-standing signal reads either — `bookId.value` anywhere in
    //    the surface would fork the identity source.
    expect(pageSrc, 'PlayPage must not read bookId.value/buildId.value (use props.ports.session)')
      .not.toMatch(/\b(?:bookId|buildId)\.value\b/);
    // 3. And the session port IS the consumed identity seam.
    expect(pageSrc, 'PlayPage must read session bookId through props.ports.session')
      .toMatch(/props\.ports\.session\.bookId/);
    expect(pageSrc, 'PlayPage must read session buildId through props.ports.session')
      .toMatch(/props\.ports\.session\.buildId/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Host contour guard — composition seam + consumer set (File/Navigator pattern)
// ─────────────────────────────────────────────────────────────────────────────

describe('Player host contour guard (Phase 2 — public entry only)', () => {
  const PLAYER_ADAPTERS_REQUIRED = [
    '../state/generateStore',
    '../state/positionStore',
    '../state/resourceInvalidations',
    '../api/client',
    './i18n',
    './desktop',
    './icons',
    '../modules/player', // the public entry (PlayerPorts type)
  ].sort();

  it('composition seam — app/playerAdapters.ts exists and wires every host infrastructure seam', () => {
    const specs = importSpecifiers(PLAYER_ADAPTERS);
    for (const required of PLAYER_ADAPTERS_REQUIRED) {
      expect(specs, `playerAdapters must wire ${required}`).toContain(required);
    }
    // The adapter imports the Player contract ONLY through the public entry.
    expect(specs.filter((s) => /^\.\/modules\/player\/(?!index$)/.test(s)), 'playerAdapters must not deep-import the player module').toEqual([]);
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
        const importsPortContract =
          specs.includes('../modules/player') || specs.includes('./modules/player') ||
          specs.includes('../modules/player/ports') || specs.includes('./ports');
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
    // main.tsx reaches the contour ONLY through the public entry.
    expect(main).toContain("from './modules/player'");
    expect(main).not.toMatch(/from\s+'\.\/modules\/player\/(?!index)/);
  });

  it('consumers — only the pinned host set imports the Player contour, and only via the public entry', () => {
    const consumers = allSourceFiles()
      .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))
      // the contour itself is not a host consumer:
      .filter((f) => !PLAYER_MODULE_FILES.includes(f))
      .filter((f) => importSpecifiers(f).some((s) => s.startsWith('./modules/player') || s.startsWith('../modules/player')))
      .sort();
    expect(consumers).toEqual(PLAYER_HOST_CONSUMERS_ALLOWED.slice().sort());
  });

  it('consumers — no deep imports into the Player module (public entry only)', () => {
    for (const f of allSourceFiles()) {
      if (f.startsWith(`${PLAYER_MODULE}/`)) continue; // internal contour imports are module-relative
      for (const spec of importSpecifiers(f)) {
        expect(
          spec,
          `${f} deep-imports the Player contour via "${spec}"`,
        ).not.toMatch(PLAYER_DEEP_SPECIFIER);
        // Package-style deep reach (the Phase 3 form) is pre-empted too.
        expect(
          spec,
          `${f} deep-imports the Player package via "${spec}"`,
        ).not.toMatch(/(?:playbackStore|playbackGate|mediaCache)\/(?:src|dist|test|internal)/);
      }
    }
  });

  it('reverse dependency — the Player module imports NO host code (pages/, app/, state/)', () => {
    for (const f of PLAYER_MODULE_FILES) {
      for (const spec of importSpecifiers(f)) {
        expect(
          spec,
          `${f} reverse-imports the host via "${spec}" (allowed: package-internal relative + preact peers)`,
        ).not.toMatch(/(?:^|\/)(?:pages|app|state|api|features|lib)\//);
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
        const importsEngine = /from\s+['"][^'"]*modules\/player['"]/.test(src);
        if (!importsEngine) return false;
        // Extract the named bindings of the player entry import statement(s).
        const names: string[] = [];
        for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*modules\/player['"]/g)) {
          names.push(...m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean));
        }
        return names.includes('bookId') || names.includes('buildId');
      });
    expect(offenders).toEqual([]);
  });

  it('test mocks — the relocated playback suites keep fake-ports injection (no host-store module mocks)', () => {
    // The engine suites must not vi.mock('../api/client') /
    // ('./generateStore') / ('./positionStore') anymore — the host reach is
    // the injected ports, so the mocks became the fake-ports object. The pure
    // gate suite never touched host modules and keeps its zero imports.
    const suites = allSourceFiles()
      .filter((f) => f.startsWith(`${PLAYER_MODULE}/playback`) && f.includes('.test.'))
      // the gate suite is pure math — it drives no engine/host reach at all:
      .filter((f) => !f.startsWith(`${PLAYER_MODULE}/playbackGate.`));
    const offenders: string[] = [];
    for (const f of suites) {
      const src = requireRaw(f);
      if (/vi\.mock\(['"][^'"]*api\/client['"]\s*,/.test(src) ||
          /vi\.mock\(['"][^'"]*generateStore['"]\s*,/.test(src) ||
          /vi\.mock\(['"][^'"]*positionStore['"]\s*,/.test(src)) {
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
    // And each suite wires the fake ports before driving the engine.
    const unwired = suites.filter((f) => !requireRaw(f).includes('wirePlaybackCoordination(fakePorts'));
    expect(unwired).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2.2 test-isolation guard — the relocated suites are package-owned too
// ─────────────────────────────────────────────────────────────────────────────

// External modules a player suite may import (the future package's
// devDependencies at the Phase 3 cut). vitest is the only one used today; any
// addition must be a conscious edit of this list — a bare specifier is never
// free to appear in a suite ("@animastor/web-*" siblings, happy-dom etc. are
// host/dev infrastructure, not package-test surface).
const PLAYER_TEST_EXTERNALS = ['vitest'] as const;

/** Resolve a relative specifier against the importing file's directory (posix,
 *  pure string ops — no node:path in this app). "./../state/x" and
 *  "../../api/x" collapse to host paths OUTSIDE modules/player/. */
function resolveRelative(fromFile: string, spec: string): string {
  const parts = `${fromFile.slice(0, fromFile.lastIndexOf('/'))}/${spec}`.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** Strip block comments and full/line-trailing // comments from a module's
 *  raw source — the isolation scan must read CODE, not prose (a comment
 *  mentioning vi.mock('../api/client') is documentation, not a reach; the
 *  (^|\s) anchor keeps "https://…" string literals intact). Line count is
 *  preserved for debugging. */
function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''));
  return noBlock
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, (_m, p1) => p1))
    .join('\n');
}

/** ALL module reaches of a suite — static + type + side-effect imports,
 *  dynamic `import('…')` and `vi.mock('…')` module paths (a mock path is a
 *  module reach too: vi.mock('../../api/client') escapes the contour without
 *  any import statement) — extracted from comment-stripped source. */
function suiteImportSpecifiers(rel: string): string[] {
  const src = stripComments(requireRaw(rel));
  const specs = new Set<string>();
  for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g)) specs.add(m[1]);
  for (const m of src.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) specs.add(m[1]);
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1]);
  for (const m of src.matchAll(/\bvi\.mock\s*\(\s*['"]([^'"]+)['"]/g)) specs.add(m[1]);
  return [...specs];
}

/** The isolation rule for ONE import of a player suite: null = allowed,
 *  otherwise the violation message. Relative specifiers are RESOLVED against
 *  the suite's directory and must stay inside modules/player/ (the Phase 2.2
 *  hole: "./../state/…" and "../../api/…" start with '.' but leave the
 *  contour); bare specifiers must be in PLAYER_TEST_EXTERNALS. */
function suiteImportViolation(suite: string, spec: string): string | null {
  if (spec.startsWith('.')) {
    const resolved = resolveRelative(suite, spec);
    return resolved.startsWith(`${PLAYER_MODULE}/`)
      ? null
      : `resolves outside ${PLAYER_MODULE}/ (→ ${resolved})`;
  }
  return (PLAYER_TEST_EXTERNALS as readonly string[]).includes(spec)
    ? null
    : `bare specifier not in PLAYER_TEST_EXTERNALS [${PLAYER_TEST_EXTERNALS.join(', ')}]`;
}

describe('Player test isolation guard (Phase 2.2 — suites move verbatim with the package)', () => {
  // Every suite physically inside modules/player/ moves verbatim into
  // packages/animastor-web-player/test/ at the Phase 3 cut. A host-reaching
  // import in a suite would become a package→host edge in the package's own
  // vitest run — the exact edge the boundary rules forbid in src/. Pin the
  // suites' import surface today: vitest + contour-internal relatives only,
  // checked by PATH RESOLUTION (not specifier shape): fake ports are
  // constructed in-suite, never imported from the host.
  it('test isolation — every player suite imports only vitest + contour-internal modules (resolution-checked, no host reach)', () => {
    const suites = allSourceFiles().filter(
      (f) => f.startsWith(`${PLAYER_MODULE}/`) && f.includes('.test.'),
    );
    // The relocated suites must exist — else this guard scans an empty set
    // and pins nothing (Phase 2 moved 9 suites in; they stay here).
    expect(suites.length).toBeGreaterThanOrEqual(9);
    const offenders: string[] = [];
    for (const f of suites) {
      for (const spec of suiteImportSpecifiers(f)) {
        const violation = suiteImportViolation(f, spec);
        if (violation) offenders.push(`${f}: "${spec}" — ${violation}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The isolation scan only inspects *.test.* files, and the production
  // boundary suite scans a FIXED file list — a file in neither category would
  // escape every scan (e.g. a "fakePorts.ts" helper reaching the host, then
  // imported by the suites; or a new engine-internal module never added to
  // PLAYER_MODULE_FILES). Pin the directory's exact physical inventory: every
  // file under modules/player/ is either pinned production contour or a
  // pinned suite — no third category can exist silently.
  it('test isolation — modules/player/ contains exactly the pinned contour files + suites (no unscanned third category)', () => {
    const expectedSuites = [
      'playbackBookSwitch',
      'playbackCacheInvalidation',
      'playbackGate',
      'playbackIdentityUiStates',
      'playbackRevealOvershoot',
      'playbackStickySeeking',
      'playbackStore',
      'playbackTargetCleanup',
      'playbackVideoListener',
      'mediaCache',
    ].map((n) => `${PLAYER_MODULE}/${n}.test.ts`).sort();
    const actual = allSourceFiles()
      .filter((f) => f.startsWith(`${PLAYER_MODULE}/`))
      .sort();
    // Exact inventory: nothing extra (unscanned helper), nothing missing
    // (a "silently deleted" suite must fail, unlike the >= 9 count check).
    expect(actual).toEqual([...PLAYER_MODULE_FILES, ...expectedSuites].sort());
  });

  // Regression cases for the resolution rule itself — the escaped-relative
  // forms the original specifier-shape regex let through.
  describe('isolation rule regression (the relative-path escape hole)', () => {
    const SUITE = `${PLAYER_MODULE}/playbackStore.test.ts`;

    it('"./models" — inside the contour → allowed', () => {
      expect(suiteImportViolation(SUITE, './models')).toBeNull();
    });

    it('"../state/generateStore" — one-level escape → forbidden', () => {
      expect(suiteImportViolation(SUITE, '../state/generateStore')).toMatch(/outside modules\/player\/.*state\/generateStore/);
    });

    it('"../../api/client" — two-level escape → forbidden', () => {
      expect(suiteImportViolation(SUITE, '../../api/client')).toMatch(/outside modules\/player\/.*api\/client/);
    });

    it('"./../state/foo" — the "./"-masked escape → forbidden', () => {
      expect(suiteImportViolation(SUITE, './../state/foo')).toMatch(/outside modules\/player\//);
    });

    it('"../../../../app/i18n" — deep escape → forbidden', () => {
      expect(suiteImportViolation(SUITE, '../../../../app/i18n')).toMatch(/outside modules\/player\/.*app\/i18n/);
    });

    it('"vitest" — the only allowlisted external; other bare specifiers are forbidden', () => {
      expect(suiteImportViolation(SUITE, 'vitest')).toBeNull();
      expect(suiteImportViolation(SUITE, '@animastor/web-file')).toMatch(/PLAYER_TEST_EXTERNALS/);
      expect(suiteImportViolation(SUITE, 'happy-dom')).toMatch(/PLAYER_TEST_EXTERNALS/);
    });
  });
});
