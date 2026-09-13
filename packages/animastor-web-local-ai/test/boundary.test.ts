// Package boundary tests — verify that @animastor/web-local-ai never imports
// host stores, host infrastructure, or app-level modules, and that the
// first web-layer package→package dependency (@animastor/web-local-ai →
// @animastor/web-settings) stays the ONLY allowed @animastor/* edge.
//
// The package imports nothing but its own internal modules + preact peers +
// the pure web-settings package. This guard pins that rule statically by
// scanning the package tree.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, join, extname } from 'node:path';

const PKG_ROOT = resolve(process.cwd());
const SRC_DIR = resolve(PKG_ROOT, 'src');
const TEST_DIR = resolve(PKG_ROOT, 'test');

function walk(dir: string, base: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { files.push(...walk(full, base)); continue; }
    if (extname(full) === '.ts' || extname(full) === '.tsx') {
      files.push(relative(base, full).split('\\').join('/'));
    }
  }
  return files;
}

function allSourceFiles(): string[] {
  return [...walk(SRC_DIR, PKG_ROOT), ...walk(TEST_DIR, PKG_ROOT)].sort();
}

function requireRaw(rel: string): string {
  return readFileSync(resolve(PKG_ROOT, rel), 'utf-8');
}

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

/** Resolve a relative specifier against the importing file's directory (posix,
 *  pure string ops). */
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

// ── Host import forbidden specifiers ──────────────────────────────────────

const HOST_FORBIDDEN = [
  /^(\.\.\/)+state\//,
  /^(\.\.\/)+api\//,
  /^(\.\.\/)+app\//,
  /^(\.\.\/)+pages\//,
  /^(\.\.\/)+features\//,
  /^(\.\.\/)+lib\//,
  /^(\.\.\/)+styles\//,
];

// The ONLY @animastor/* package this package may depend on (audit §6.7):
// web-settings is a pure Tier B package (sideEffects: false, zero peers) —
// a provable DAG. Any other @animastor/* edge is forbidden.
const ALLOWED_ANIMASTOR = '@animastor/web-settings';

// Allowed external imports for src/ (preact peers only — the component uses
// zero @preact/signals) plus the package→package dependency above.
const ALLOWED_SRC_EXTERNAL = /^(?:preact|preact\/hooks|@animastor\/web-settings)$/;

// The pinned physical inventory (exact — no unscanned files).
const SRC_FILES = [
  'index.ts',
  'ports.ts',
  'LocalAISection.tsx',
].map((f) => `src/${f}`);

const TEST_FILES = [
  'boundary.test.ts',
  'section.test.tsx',
].map((f) => `test/${f}`);

// ── src/ boundary: no package→host edge ─────────────────────────────────────

describe('@animastor/web-local-ai src boundary (no host reach)', () => {
  it('src/ imports NO host module (state/, api/, app/, pages/, features/, lib/)', () => {
    for (const f of allSourceFiles().filter((f) => f.startsWith('src/'))) {
      for (const spec of importSpecifiers(f)) {
        const isHost = HOST_FORBIDDEN.some((re) => re.test(spec));
        expect(
          isHost,
          `${f} imports host infrastructure via "${spec}" (everything arrives via LocalAiPorts)`,
        ).toBe(false);
        // Also check that relative imports don't escape the package
        if (spec.startsWith('..')) {
          const resolved = resolveRelative(f, spec);
          expect(
            resolved.startsWith('src/'),
            `${f} imports outside the package via "${spec}" → ${resolved}`,
          ).toBe(true);
        }
      }
    }
  });

  it('src/ imports NO @animastor/* package except @animastor/web-settings (first package→package dep — the only one)', () => {
    for (const f of allSourceFiles().filter((f) => f.startsWith('src/'))) {
      for (const spec of importSpecifiers(f)) {
        if (!spec.startsWith('@animastor/')) continue;
        expect(
          spec,
          `${f} imports forbidden @animastor/* "${spec}" (web-settings is the ONLY allowed package dep)`,
        ).toBe(ALLOWED_ANIMASTOR);
      }
    }
  });

  it('src/ external imports are preact peers + @animastor/web-settings only', () => {
    for (const f of allSourceFiles().filter((f) => f.startsWith('src/'))) {
      for (const spec of importSpecifiers(f)) {
        if (spec.startsWith('.') || spec.startsWith('node:')) continue;
        expect(
          spec,
          `${f} imports non-allowed external "${spec}" (runtime: preact peer + web-settings dep only)`,
        ).toMatch(ALLOWED_SRC_EXTERNAL);
      }
    }
  });

  it('no deep imports into @animastor/web-settings (public package root only)', () => {
    for (const f of allSourceFiles()) {
      for (const spec of importSpecifiers(f)) {
        expect(
          spec,
          `${f} deep-imports web-settings via "${spec}" (package root is the only sanctioned specifier)`,
        ).not.toMatch(/^@animastor\/web-settings\//);
      }
    }
  });

  it('ports.ts imports nothing but Preact types (no runtime host deps)', () => {
    const specs = importSpecifiers('src/ports.ts');
    for (const spec of specs) {
      expect(
        spec,
        `ports.ts imports unexpected module "${spec}"`,
      ).toMatch(/^preact$/);
    }
  });
});

// ── test/ isolation: suites are package-owned ────────────────────────────────

describe('@animastor/web-local-ai test isolation (suites move verbatim with the package)', () => {
  it('every suite imports only vitest + src/-internal modules + allowed externals', () => {
    const offenders: string[] = [];
    for (const f of allSourceFiles().filter((f) => f.startsWith('test/') && f !== 'test/boundary.test.ts')) {
      for (const spec of importSpecifiers(f)) {
        if (spec.startsWith('.')) {
          const resolved = resolveRelative(f, spec);
          if (!resolved.startsWith('src/')) {
            offenders.push(`${f}: "${spec}" → ${resolved} (outside src/)`);
          }
        } else if (!['vitest', 'preact/hooks', '@animastor/web-settings', '@testing-library/preact'].includes(spec) && !spec.startsWith('node:')) {
          offenders.push(`${f}: "${spec}" (bare specifier not in allowlist)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('this boundary suite itself stays package-owned too', () => {
    for (const spec of importSpecifiers('test/boundary.test.ts')) {
      if (spec.includes('\\')) continue; // regex literal artifacts
      expect(spec).toMatch(/^(?:vitest|node:(?:fs|path))$/);
    }
  });
});

// ── package.json dependency contract (audit §6.8) ───────────────────────────

describe('@animastor/web-local-ai package.json dependency contract', () => {
  const pkg = JSON.parse(requireRaw('package.json'));

  it('dependencies contain EXACTLY the allowed runtime dependency @animastor/web-settings', () => {
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([ALLOWED_ANIMASTOR]);
  });

  it('peerDependencies contain EXACTLY preact', () => {
    expect(Object.keys(pkg.peerDependencies ?? {}).sort()).toEqual(['preact']);
  });

  it('no other @animastor/* entries anywhere in dependencies/peerDependencies', () => {
    const allDeps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    const animastorDeps = allDeps.filter((d) => d.startsWith('@animastor/'));
    expect(animastorDeps.sort()).toEqual([ALLOWED_ANIMASTOR]);
  });

  it('sideEffects: false (treeshakeable pure UI module)', () => {
    expect(pkg.sideEffects).toBe(false);
  });

  it('public API is root-only (exports map serves the package entry, no subpaths)', () => {
    expect(Object.keys(pkg.exports ?? {}).sort()).toEqual(['.', './package.json']);
    expect(pkg.files?.sort()).toEqual(['LICENSE', 'README.md', 'dist'].sort());
  });
});

// ── Physical inventory: exactly the contour + suites, nothing else ──────────

describe('@animastor/web-local-ai physical inventory', () => {
  it('src/ contains exactly the pinned inventory', () => {
    const srcFiles = readdirSync(SRC_DIR)
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .sort();
    expect(srcFiles).toEqual([
      'LocalAISection.tsx',
      'index.ts',
      'ports.ts',
    ]);
  });

  it('test/ contains exactly the pinned inventory', () => {
    const testFiles = readdirSync(TEST_DIR)
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .sort();
    expect(testFiles).toEqual([
      'boundary.test.ts',
      'section.test.tsx',
    ]);
  });

  it('src/ + test/ contain exactly the pinned files (no unscanned third category)', () => {
    const actual = allSourceFiles().sort();
    expect(actual).toEqual([...SRC_FILES, ...TEST_FILES].sort());
  });
});
