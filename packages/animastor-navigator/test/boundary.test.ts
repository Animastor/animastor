// Package boundary tests — verify that @animastor/navigator never imports
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

// Forbidden imports — these must NEVER appear inside @animastor/navigator
const FORBIDDEN_IMPORTS: (string | RegExp)[] = [
  // Host stores
  '../state/playbackStore',
  '../state/generateStore',
  '../state/positionStore',
  '../state/resourceInvalidations',
  '../state/resilientReloader',
  'state/playbackStore',
  'state/generateStore',
  'state/positionStore',
  'state/resourceInvalidations',
  'state/resilientReloader',
  // Host infrastructure
  '../app/AppShell',
  '../app/navigatorAdapters',
  '../api/client',
  '../app/i18n',
  '../app/icons',
  '../app/router',
  '../app/desktop',
  'app/AppShell',
  'app/navigatorAdapters',
  'api/client',
  'app/i18n',
  'app/icons',
  'app/router',
  'app/desktop',
  // api/models (host-owned types — package uses its own models.ts)
  '../api/models',
  'api/models',
];

describe('@animastor/navigator package boundary', () => {
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
          expect(spec, `${file} imports host app via "${spec}"`).not.toMatch(/\.\.\/(?:app|pages|state|api|modules|features)\//);
        }
      }
    });
  }
});
