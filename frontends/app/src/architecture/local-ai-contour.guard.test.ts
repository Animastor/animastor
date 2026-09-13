// Architecture contour guards — Local AI extraction (physical package)
// per docs/architecture/web-local-ai-extraction-audit.md.
//
// The Local AI contour (LocalAISection + LocalAiPorts) physically lives in
// the @animastor/web-local-ai package (packages/animastor-web-local-ai/,
// file: dependency). The package-side twin of this guard lives in
// packages/animastor-web-local-ai/test/boundary.test.ts and pins the
// package's internal rules (no host reach, preact peers only, the single
// allowed @animastor/web-settings package dep, exact inventory).
//
// This HOST-side guard pins the app↔package seam:
//
//   - SettingsPage imports LocalAISection ONLY from '@animastor/web-local-ai'
//     and passes localAiPorts (the package requires ports injection);
//   - no host file imports features/localAi anymore (the old contour is
//     physically gone — no host copy of Local AI exists);
//   - app/localAiAdapters.ts is the ONLY composition seam (the single host
//     file where host infrastructure meets the LocalAiPorts contract);
//   - no package→host dependency: no host module is imported by the contour
//     (pinned package-side; here the host side pins the reverse edge — only
//     the pinned consumers reach the package);
//   - the section routing/ownership stays in SettingsPage (section === 'local-ai').

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

const LOCAL_AI_PACKAGE = '@animastor/web-local-ai';
const LOCAL_AI_ADAPTERS = 'app/localAiAdapters.ts';
const SETTINGS_PAGE = 'pages/SettingsPage.tsx';

// Host files allowed to import the Local AI package through the public entry
// (the section owner + the composition seam).
const LOCAL_AI_HOST_CONSUMERS_ALLOWED = [
  SETTINGS_PAGE,
  LOCAL_AI_ADAPTERS,
].sort();

// Deep-import specifiers — any host reach INTO the package internals.
const LOCAL_AI_DEEP_SPECIFIER =
  /^@animastor\/web-local-ai\/(?!$)(?:LocalAISection|ports|src|dist|test|internal)/;

// ─────────────────────────────────────────────────────────────────────────────
// Physical structure guard — no in-host Local AI remnant, package is the contour
// ─────────────────────────────────────────────────────────────────────────────

describe('Local AI physical structure guard (local-ai extraction audit)', () => {
  it('no in-host Local AI contour remnants (features/localAi is gone)', () => {
    const files = Object.keys(RAW_SOURCES);
    const strays = files.filter((k) => k.startsWith('/src/features/localAi/'));
    expect(strays).toEqual([]);
    expect(files).not.toContain('/src/features/localAi/LocalAISection.tsx');
    // No compatibility shim: nothing re-exports the old path.
    const shims = allSourceFiles()
      .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))
      .filter((f) => /from\s+['"][^'"]*features\/localAi/.test(requireRaw(f)));
    expect(shims).toEqual([]);
    // features/ still holds its unrelated contours only.
    const featuresDirs = new Set(
      Object.keys(RAW_SOURCES)
        .filter((k) => k.startsWith('/src/features/'))
        .map((k) => k.split('/').slice(0, 4).join('/')),
    );
    for (const dir of featuresDirs) {
      expect(dir, 'no localAi directory may exist under features/').not.toMatch(/localAi/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Local AI host boundary guard — entry-only consumption, single composition seam
// ─────────────────────────────────────────────────────────────────────────────

describe('Local AI host boundary guard (@animastor/web-local-ai entry only)', () => {
  const LOCAL_AI_ADAPTERS_REQUIRED = [
    '../api/client',
    './i18n',
    '../lib/ui',
    LOCAL_AI_PACKAGE, // the package public entry (LocalAiPorts type)
  ].sort();

  it('composition seam — app/localAiAdapters.ts exists and wires every host infrastructure seam', () => {
    const specs = importSpecifiers(LOCAL_AI_ADAPTERS);
    for (const required of LOCAL_AI_ADAPTERS_REQUIRED) {
      expect(specs, `localAiAdapters must wire ${required}`).toContain(required);
    }
    // The adapter imports the Local AI contract ONLY through the public entry.
    expect(specs.filter((s) => s.startsWith(`${LOCAL_AI_PACKAGE}/`)), 'localAiAdapters must not deep-import the local-ai package').toEqual([]);
  });

  it('composition seam — localAiAdapters is the ONLY host file wiring LocalAiPorts (no parallel composition)', () => {
    // The LocalAiPorts OBJECT (the bridge from host modules to the port
    // contract) must be constructed in exactly one host place: the adapter.
    const builders = allSourceFiles()
      .filter((f) => !f.includes('.test.'))
      .filter((f) => {
        const specs = importSpecifiers(f);
        const importsPortContract = specs.some(
          (s) => s === LOCAL_AI_PACKAGE || s.startsWith(`${LOCAL_AI_PACKAGE}/`),
        );
        if (!importsPortContract) return false;
        const declaresPortsObject = requireRaw(f).match(/LocalAiPorts\s*=\s*\{|localAiPorts\s*:\s*LocalAiPorts/) != null;
        return declaresPortsObject;
      });
    expect(builders).toEqual([LOCAL_AI_ADAPTERS]);
  });

  it('section routing — SettingsPage imports the package and passes localAiPorts (ownership stays in SettingsPage)', () => {
    const page = requireRaw(SETTINGS_PAGE);
    expect(page).toContain(`import { LocalAISection } from '${LOCAL_AI_PACKAGE}'`);
    expect(page).toContain("import { localAiPorts } from '../app/localAiAdapters'");
    expect(page).toContain("if (section === 'local-ai') return <LocalAISection ports={localAiPorts} />;");
    // No reach into the old host contour.
    expect(page).not.toMatch(/features\/localAi/);
  });

  it('consumers — only the pinned host set imports the Local AI package, and only via the public entry', () => {
    const consumers = allSourceFiles()
      .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))
      .filter((f) => importSpecifiers(f).includes(LOCAL_AI_PACKAGE))
      .sort();
    expect(consumers).toEqual(LOCAL_AI_HOST_CONSUMERS_ALLOWED.slice().sort());
  });

  it('consumers — no deep imports into the Local AI package (public entry only)', () => {
    for (const f of allSourceFiles()) {
      for (const spec of importSpecifiers(f)) {
        expect(
          spec,
          `${f} deep-imports the Local AI package via "${spec}"`,
        ).not.toMatch(LOCAL_AI_DEEP_SPECIFIER);
        // No relative reach into the package directory either.
        expect(
          spec,
          `${f} reaches the package by relative path "${spec}" (entry specifier only)`,
        ).not.toMatch(/packages\/animastor-web-local-ai/);
      }
    }
  });

  it('reverse dependency — no host state module re-exports the package (package → host edge is impossible in host source)', () => {
    const stateFiles = allSourceFiles().filter((f) => f.startsWith('state/') && !f.includes('.test.'));
    for (const f of stateFiles) {
      expect(
        importSpecifiers(f).includes(LOCAL_AI_PACKAGE),
        `${f} imports the local-ai package — state/ must not reach Local AI`,
      ).toBe(false);
    }
  });

  it('package→package DAG — host reaches @animastor/web-settings only through pure usage, never to re-export Local AI', () => {
    // The first package→package dep (web-local-ai → web-settings) must stay
    // package-side: no host file may bridge the two packages by re-exporting
    // web-settings bindings through local-ai adapters or vice versa.
    const adapter = requireRaw(LOCAL_AI_ADAPTERS);
    expect(adapter).not.toContain('@animastor/web-settings');
  });
});
