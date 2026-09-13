// Package boundary tests — verify that @animastor/web-ai-chat never imports
// host stores, host infrastructure, or app-level modules.
//
// The package imports nothing but its own internal modules — zero host imports.
// This guard pins that rule statically by scanning the package tree.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, extname } from 'node:path';

const PKG_ROOT = resolve(process.cwd());
const SRC_DIR = resolve(PKG_ROOT, 'src');
const TEST_DIR = resolve(PKG_ROOT, 'test');

/** All .ts/.tsx files in the package (src + test). */
function allFiles(): string[] {
  const files: string[] = [];
  for (const dir of [SRC_DIR, TEST_DIR]) {
    if (!statSync(dir).isDirectory()) continue;
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isFile() && /\.(ts|tsx)$/.test(entry)) {
        files.push(relative(PKG_ROOT, full));
      }
    }
  }
  return files;
}

/** Import specifiers from a file (static + type imports). */
function importSpecifiers(rel: string): string[] {
  const src = readFileSync(resolve(PKG_ROOT, rel), 'utf-8');
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

// ── Host import forbidden specifiers ──────────────────────────────────────

const HOST_FORBIDDEN = [
  /^(\.\.\/)+state\//,
  /^(\.\.\/)+api\//,
  /^(\.\.\/)+app\//,
  /^(\.\.\/)+pages\//,
  /^(\.\.\/)+features\//,
  /^(\.\.\/)+lib\//,
  /^(\.\.\/)+styles\//,
  /^\.\.\/(state|api|app|pages|features|lib|styles)\//,
];

describe('Package boundary — @animastor/web-ai-chat', () => {
  it('src/ imports zero host infrastructure (no state/, api/, app/, pages/, features/, lib/)', () => {
    const srcFiles = allFiles().filter((f) => f.startsWith('src/'));
    for (const file of srcFiles) {
      for (const spec of importSpecifiers(file)) {
        const isHost = HOST_FORBIDDEN.some((re) => re.test(spec));
        expect(
          isHost,
          `${file} imports host infrastructure via "${spec}"`,
        ).toBe(false);
      }
    }
  });

  it('test/ imports only vitest + package-internal relatives', () => {
    const testFiles = allFiles().filter((f) => f.startsWith('test/'));
    for (const file of testFiles) {
      for (const spec of importSpecifiers(file)) {
        // Allow vitest and relative imports into src/
        const isVitest = spec === 'vitest';
        const isInternal = spec.startsWith('../src/') || spec.startsWith('./');
        const isNode = spec.startsWith('node:');
        expect(
          isVitest || isInternal || isNode,
          `${file} imports non-package module "${spec}"`,
        ).toBe(true);
      }
    }
  });

  it('src/ contains exactly the pinned inventory (index.ts + chatStream.ts)', () => {
    const srcFiles = readdirSync(SRC_DIR)
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .sort();
    expect(srcFiles).toEqual(['chatStream.ts', 'index.ts']);
  });

  it('test/ contains exactly the pinned inventory (chatStream.test.ts + boundary.test.ts)', () => {
    const testFiles = readdirSync(TEST_DIR)
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .sort();
    expect(testFiles).toEqual(['boundary.test.ts', 'chatStream.test.ts']);
  });
});
