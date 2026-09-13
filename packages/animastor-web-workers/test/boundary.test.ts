// Package boundary tests — verify that @animastor/web-workers never imports
// host stores, host infrastructure, or app-level modules.
//
// The package imports nothing but its own internal modules + preact peers.
// This guard pins that rule statically by scanning the package tree.

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

// Allowed external imports for the package
const ALLOWED_EXTERNAL = [
  'preact',
  'preact/hooks',
  '@preact/signals',
].sort();

// The pinned physical inventory (exact — no unscanned files).
const SRC_FILES = [
  'index.ts',
  'ports.ts',
  'privateWorkers.ts',
  'workerSetup.ts',
  'sharing.ts',
  'shareNotifications.ts',
  'PrivateWorkersSection.tsx',
  'WorkerSharingUI.tsx',
].map((f) => `src/${f}`);

const TEST_FILES = [
  'boundary.test.ts',
  'privateWorkers.test.ts',
  'workerSetup.test.ts',
  'sharing.test.ts',
  'shareNotifications.test.ts',
].map((f) => `test/${f}`);

// ── src/ boundary: no package→host edge ─────────────────────────────────────

describe('@animastor/web-workers src boundary (no host reach)', () => {
  it('src/ imports NO host module (state/, api/, app/, pages/, features/, lib/)', () => {
    for (const f of allSourceFiles().filter((f) => f.startsWith('src/'))) {
      for (const spec of importSpecifiers(f)) {
        const isHost = HOST_FORBIDDEN.some((re) => re.test(spec));
        expect(
          isHost,
          `${f} imports host infrastructure via "${spec}" (everything arrives via WorkerPorts)`,
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

  it('src/ external imports are preact peers only', () => {
    for (const f of allSourceFiles().filter((f) => f.startsWith('src/'))) {
      for (const spec of importSpecifiers(f)) {
        if (spec.startsWith('.')) continue;
        expect(
          spec,
          `${f} imports non-peer external "${spec}" (runtime deps: preact + @preact/signals only)`,
        ).toMatch(/^(?:preact|preact\/hooks|@preact\/signals)$/);
      }
    }
  });

  it('ports.ts imports nothing but Preact types (no runtime host deps)', () => {
    const specs = importSpecifiers('src/ports.ts');
    for (const spec of specs) {
      expect(
        ALLOWED_EXTERNAL,
        `ports.ts imports unexpected module "${spec}"`,
      ).toContain(spec);
    }
  });
});

// ── test/ isolation: suites are package-owned ────────────────────────────────

describe('@animastor/web-workers test isolation (suites move verbatim with the package)', () => {
  it('every suite imports only vitest + src/-internal modules', () => {
    const offenders: string[] = [];
    for (const f of allSourceFiles().filter((f) => f.startsWith('test/') && f !== 'test/boundary.test.ts')) {
      for (const spec of importSpecifiers(f)) {
        if (spec.startsWith('.')) {
          const resolved = resolveRelative(f, spec);
          if (!resolved.startsWith('src/')) {
            offenders.push(`${f}: "${spec}" → ${resolved} (outside src/)`);
          }
        } else if (!['vitest'].includes(spec) && !spec.startsWith('node:')) {
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

// ── Physical inventory: exactly the contour + suites, nothing else ──────────

describe('@animastor/web-workers physical inventory', () => {
  it('src/ contains exactly the pinned inventory', () => {
    const srcFiles = readdirSync(SRC_DIR)
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .sort();
    expect(srcFiles).toEqual([
      'PrivateWorkersSection.tsx',
      'WorkerSharingUI.tsx',
      'index.ts',
      'ports.ts',
      'privateWorkers.ts',
      'shareNotifications.ts',
      'sharing.ts',
      'workerSetup.ts',
    ]);
  });

  it('test/ contains exactly the pinned inventory', () => {
    const testFiles = readdirSync(TEST_DIR)
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .sort();
    expect(testFiles).toEqual([
      'boundary.test.ts',
      'privateWorkers.test.ts',
      'shareNotifications.test.ts',
      'sharing.test.ts',
      'workerSetup.test.ts',
    ]);
  });

  it('src/ + test/ contain exactly the pinned files (no unscanned third category)', () => {
    const actual = allSourceFiles().sort();
    expect(actual).toEqual([...SRC_FILES, ...TEST_FILES].sort());
  });
});
