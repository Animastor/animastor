// Package-side architecture guard — @animastor/web-book-session (Step 12).
// Mirrors the guard discipline of the other extracted packages
// (web-generator-vbook test/guard.test.ts): forbid host reach, keep the
// dependency surface minimal, ensure no duplicate identity implementation
// sneaks back into the package.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listSources(p));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

function importSpecifiers(file: string): string[] {
  const src = readFileSync(file, 'utf8');
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

const SRC_FILES = listSources(join(PKG_ROOT, 'src'));

describe('book-session package — dependency cleanliness', () => {
  it('imports ONLY @preact/signals at runtime', () => {
    const specs = SRC_FILES.flatMap((f) => importSpecifiers(f));
    const external = specs.filter((s) => !s.startsWith('.'));
    expect(external).toEqual(['@preact/signals']);
  });

  it('imports no host modules (stores, api, app, pages)', () => {
    const forbidden = [
      'generateStore', 'fileStore', 'authStore', 'positionStore',
      'api/client', '../app/', '../pages/', '../state/',
    ];
    for (const f of SRC_FILES) {
      for (const spec of importSpecifiers(f)) {
        for (const bad of forbidden) {
          expect(spec.includes(bad), `${f} imports "${spec}" — host reach forbidden`).toBe(false);
        }
      }
    }
  });

  it('imports no other @animastor/* package (zero cross-package deps)', () => {
    for (const f of SRC_FILES) {
      for (const spec of importSpecifiers(f)) {
        expect(
          spec.startsWith('@animastor/') && spec !== '@preact/signals',
          `${f} imports "${spec}" — no cross-package dependencies`,
        ).toBe(false);
      }
    }
  });
});

describe('book-session package — single identity implementation', () => {
  it('owns the identity definitions exactly once', () => {
    const src = readFileSync(join(PKG_ROOT, 'src/index.ts'), 'utf8');
    for (const token of [
      'export const bookId = signal',
      'export const buildId = signal',
      'export function loadBook(',
      'export function setGenerationBuildId(',
      'export function readPersistedBookSession(',
      'export function stashBookSessionForUser(',
      'export function restoreStashedBookSessionForUser(',
      "export const BOOK_STORE_KEY = 'animastor:currentBook'",
    ]) {
      expect(src, `package must own: ${token}`).toContain(token);
      // exactly ONE definition of each (no duplicated implementation)
      expect(src.split(token).length - 1).toBe(1);
    }
  });

  it('contains no phase/errorMessage (excluded from the identity boundary)', () => {
    const src = readFileSync(join(PKG_ROOT, 'src/index.ts'), 'utf8');
    expect(src).not.toMatch(/export const (phase|errorMessage)\b/);
    expect(src).not.toContain('PlayerPhase');
  });

  it('contains no restoreBookSession export (File-flow orchestration stays in fileStore)', () => {
    const src = readFileSync(join(PKG_ROOT, 'src/index.ts'), 'utf8');
    // only documentation references are allowed — no export/function definition
    expect(src).not.toMatch(/export (async )?function restoreBookSession/);
    expect(src).not.toMatch(/export const restoreBookSession/);
  });

  it('has no module-global mutable state beyond the two signals', () => {
    for (const f of SRC_FILES) {
      const src = readFileSync(f, 'utf8');
      expect(src, `${f} declares module-global let`).not.toMatch(/^let\s+\w+/m);
      expect(src, `${f} declares module-global var`).not.toMatch(/^var\s+\w+/m);
    }
  });
});
