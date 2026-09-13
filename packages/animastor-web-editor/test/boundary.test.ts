// Package boundary tests — verify that @animastor/web-editor never imports
// host stores, host infrastructure, or app-level modules.
//
// These tests scan the raw source of every file in the package's src/ directory
// and assert that no forbidden import specifiers appear. If the package needs
// new dependencies, update the ALLOWED list first (with an audit justification).

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, join, extname } from 'node:path';

const SRC_DIR = resolve(process.cwd(), 'src');

function allSourceFiles(): string[] {
  const files: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (extname(full) === '.ts' || extname(full) === '.tsx') {
        files.push(relative(SRC_DIR, full));
      }
    }
  }
  walk(SRC_DIR);
  return files.sort();
}

function importSpecifiers(relPath: string): string[] {
  const src = readFileSync(resolve(SRC_DIR, relPath), 'utf-8');
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

// Allowed external imports for the package
const ALLOWED_EXTERNAL = [
  'preact',
  'preact/hooks',
  '@preact/signals',
].sort();

// Forbidden imports — these must NEVER appear inside @animastor/web-editor
const FORBIDDEN_IMPORTS: (string | RegExp)[] = [
  // Host stores
  '../state/generateStore',
  '../state/playbackStore',
  '../state/positionStore',
  '../state/resourceInvalidations',
  '../state/resilientReloader',
  'state/generateStore',
  'state/playbackStore',
  'state/positionStore',
  'state/resourceInvalidations',
  'state/resilientReloader',
  // Host infrastructure
  '../app/AppShell',
  '../app/editorAdapters',
  '../app/playerAdapters',
  '../app/navigatorAdapters',
  '../app/fileAdapters',
  '../api/client',
  '../api/models',
  '../app/i18n',
  '../app/icons',
  '../app/router',
  '../app/desktop',
  'app/AppShell',
  'app/editorAdapters',
  'app/playerAdapters',
  'app/navigatorAdapters',
  'app/fileAdapters',
  'api/client',
  'api/models',
  'app/i18n',
  'app/icons',
  'app/router',
  'app/desktop',
  // Backend packages
  '@animastor/editor',
  '@animastor/player',
  // Host lib
  '../lib/ui',
  '../lib/entityEditor',
  '../lib/waveform',
  '../lib/idgen',
  'lib/ui',
  'lib/entityEditor',
  'lib/waveform',
  'lib/idgen',
];

describe('@animastor/web-editor package boundary', () => {
  const srcFiles = allSourceFiles();

  it('package source files exist', () => {
    expect(srcFiles.length).toBeGreaterThan(0);
  });

  for (const file of srcFiles) {
    it(`${file} — no forbidden host imports`, () => {
      const specs = importSpecifiers(file);
      for (const spec of specs) {
        for (const forbidden of FORBIDDEN_IMPORTS) {
          if (typeof forbidden === 'string') {
            expect(spec, `${file} must not import "${forbidden}"`).not.toBe(forbidden);
          } else {
            expect(spec, `${file} must not import pattern ${forbidden}`).not.toMatch(forbidden);
          }
        }
      }
    });

    it(`${file} — only external deps are preact/@preact/signals`, () => {
      const specs = importSpecifiers(file);
      const externalSpecs = specs.filter((s) => !s.startsWith('.') && !s.startsWith('/'));
      for (const spec of externalSpecs) {
        expect(ALLOWED_EXTERNAL, `${file} imports unknown external "${spec}"`).toContain(spec);
      }
    });

    it(`${file} — no relative imports into host app`, () => {
      const specs = importSpecifiers(file);
      for (const spec of specs) {
        if (spec.startsWith('..') || spec.startsWith('.')) {
          expect(spec, `${file} imports host app via "${spec}"`).not.toMatch(/\.\.\/(?:app|pages|state|api|modules|features|lib)\//);
        }
      }
    });
  }

  it('dist/ build output (if present) contains no host paths or host imports', () => {
    const distDir = resolve(process.cwd(), 'dist');
    const distStat = statSync(distDir, { throwIfNoEntry: false });
    if (!distStat || !distStat.isDirectory()) return; // build not run yet — skip
    const distFiles: string[] = [];
    for (const entry of readdirSync(distDir)) {
      if (entry.endsWith('.js') || entry.endsWith('.d.ts')) distFiles.push(join(distDir, entry));
    }
    expect(distFiles.length).toBeGreaterThan(0);
    for (const file of distFiles) {
      const content = readFileSync(file, 'utf-8');
      // No absolute monorepo paths may leak into the artifact
      expect(content, `${file} leaks an absolute monorepo path`).not.toMatch(/\/home\/|\/Users\/|frontends\/app/);
      // No host-owned module specifiers may appear in the artifact
      for (const forbidden of FORBIDDEN_IMPORTS) {
        if (typeof forbidden === 'string' && forbidden.startsWith('.')) {
          expect(content, `${file} references host module "${forbidden}"`).not.toContain(forbidden);
        }
      }
      // External imports must be peers only
      const externals = [...content.matchAll(/from ['\"]([^'\"]+)['\"]/g)].map((m) => m[1]);
      for (const ext of externals) {
        expect(
          ['preact', 'preact/hooks', 'preact/jsx-runtime', '@preact/signals'],
          `${file} imports unknown external "${ext}"`,
        ).toContain(ext);
      }
    }
  });

  it('src/ contains exactly the pinned inventory', () => {
    const srcFiles = readdirSync(SRC_DIR)
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .sort();
    expect(srcFiles).toEqual([
      'entityEditor.tsx',
      'idgen.ts',
      'index.ts',
      'models.ts',
      'ports.ts',
      'waveform.tsx',
    ]);
  });

  it('test/ contains exactly the pinned inventory', () => {
    const testDir = resolve(process.cwd(), 'test');
    const testFiles = readdirSync(testDir)
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .sort();
    expect(testFiles).toEqual([
      'boundary.test.ts',
      'entityEditor.test.ts',
      'idgen.test.ts',
      'waveform.test.ts',
    ]);
  });

  it('ports.ts imports nothing but Preact types (no runtime host deps)', () => {
    const specs = importSpecifiers('ports.ts');
    for (const spec of specs) {
      expect(
        ALLOWED_EXTERNAL.concat(['./models']),
        `ports.ts imports unexpected module "${spec}"`,
      ).toContain(spec);
    }
  });

  it('models.ts has zero imports (pure type definitions)', () => {
    const specs = importSpecifiers('models.ts');
    expect(specs, 'models.ts should have no imports').toHaveLength(0);
  });

  it('idgen.ts has zero imports (pure utility)', () => {
    const specs = importSpecifiers('idgen.ts');
    expect(specs, 'idgen.ts should have no imports').toHaveLength(0);
  });
});
