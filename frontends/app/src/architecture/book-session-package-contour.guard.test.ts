// Architecture contour guard — @animastor/web-book-session PHYSICAL PACKAGE
// (docs/architecture/web-generator-extraction-audit.md §21, Step 12).
//
// The book-session identity contour was prepared in-repo at Step 11
// (state/bookSession.ts) and is now a physical package at
// packages/animastor-web-book-session/. This guard freezes the REAL source
// graph (raw-source scan, not file existence):
//
//   1.  The package is the SINGLE owner of the identity signals.
//   2.  generateStore does NOT declare identity signals.
//   3.  generateStore has NO persistence implementation.
//   4.  generateStore has NO stash/restore implementation.
//   5.  generateStore contains no BOOK_STORE_KEY.
//   6.  buildId is NOT written directly from generateStore.
//   7.  generation updates buildId ONLY through the controlled setter.
//   8.  fileStore has NO identity storage implementation.
//   9.  restoreBookSession() stays in fileStore.
//   10. the package imports no host modules.
//   11. the package does not import authStore.
//   12. the package does not import api/client.
//   13. the package does not import pages/app/state modules.
//   14. no reverse dependency (book-session → host).
//   15. no second production implementation of identity anywhere in src/.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAW_SOURCES = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// The package source lives OUTSIDE the vite root (../../packages/...), so
// import.meta.glob cannot reach it — read the real files via node:fs (the
// vitest runtime runs from the repo; this checks the ACTUAL shipped source).

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'packages', 'animastor-web-book-session');

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listSources(p));
    else if (/\.ts$/.test(name) && !name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

function importSpecifiers(src: string): string[] {
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

function allSourceFiles(): string[] {
  return Object.keys(RAW_SOURCES)
    .filter((k) => !k.startsWith('/src/architecture/'))
    .map((k) => k.replace(/^\/src\//, ''))
    .sort();
}

function productionFiles(): string[] {
  return allSourceFiles().filter((f) => !f.includes('.test.'));
}

const HOST_STORE = 'state/generateStore.ts';
const FILE_STORE = 'state/fileStore.ts';
const PACKAGE_NAME = '@animastor/web-book-session';

// ─────────────────────────────────────────────────────────────────────────────
// Rules 1–5: single ownership, no duplicate implementation in the host
// ─────────────────────────────────────────────────────────────────────────────

describe('book-session package — single identity owner (host side)', () => {
  it('generateStore re-exports identity from the package root (compatibility surface)', () => {
    const store = requireRaw(HOST_STORE);
    expect(store).toContain(`} from '${PACKAGE_NAME}'`);
    expect(store).toContain('setGenerationBuildId, readPersistedBookSession,');
  });

  it('rule 2 — generateStore does NOT declare the identity signals or loadBook', () => {
    const store = requireRaw(HOST_STORE);
    expect(store).not.toMatch(/export const (bookId|buildId) = signal/);
    expect(store).not.toMatch(/export function loadBook\(/);
    expect(store).not.toMatch(/^function (persistBookSession|clearBookSession|userStashKey)\(/m);
  });

  it('rule 3 — generateStore has NO persistence implementation (no localStorage writes for the session)', () => {
    const store = requireRaw(HOST_STORE);
    expect(store).not.toMatch(/localStorage\.(setItem|removeItem)/);
  });

  it('rule 4 — generateStore has NO stash/restore implementation', () => {
    const store = requireRaw(HOST_STORE);
    // consumption via re-export only — no local bodies
    expect(store).not.toMatch(/^export function stashBookSessionForUser/m);
    expect(store).not.toMatch(/^export function restoreStashedBookSessionForUser/m);
    expect(store).not.toMatch(/function stashBookSessionForUser\([^)]*\): void \{/m);
    expect(store).not.toMatch(/function restoreStashedBookSessionForUser\([^)]*\): void \{/m);
  });

  it('rule 5 — generateStore contains no BOOK_STORE_KEY definition', () => {
    const store = requireRaw(HOST_STORE);
    expect(store).not.toMatch(/BOOK_STORE_KEY\s*=/);
  });

  it('the old in-repo contour state/bookSession.ts is deleted (one physical implementation)', () => {
    expect(Object.keys(RAW_SOURCES).some((k) => k.startsWith('/src/state/bookSession'))).toBe(false);
  });

  it('no host TEST file imports the package directly (test-mock discipline: via generateStore surface)', () => {
    const testConsumers = allSourceFiles()
      .filter((f) => f.endsWith('.test.ts') || f.endsWith('.test.tsx'))
      .filter((f) => importSpecifiers(requireRaw(f)).includes(PACKAGE_NAME))
      .sort();
    expect(testConsumers).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rules 6–7: buildId hybrid ownership
// ─────────────────────────────────────────────────────────────────────────────

describe('book-session package — buildId hybrid ownership', () => {
  it('rule 6 — buildId is NOT written directly from generateStore', () => {
    const store = requireRaw(HOST_STORE);
    expect(store, 'direct buildId.value write in generateStore — use setGenerationBuildId')
      .not.toMatch(/buildId\.value\s*=/);
  });

  it('rule 7 — generation updates buildId ONLY through the controlled setter', () => {
    const store = requireRaw(HOST_STORE);
    expect(store).toContain('setGenerationBuildId(res.build_id)');
    // the setter is consumed from the package (single writer surface)
    const pkgImport = importSpecifiers(store).find((s) => s === PACKAGE_NAME);
    expect(pkgImport).toBe(PACKAGE_NAME);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rules 8–9: fileStore boundary
// ─────────────────────────────────────────────────────────────────────────────

describe('book-session package — fileStore boundary', () => {
  it('rule 8 — fileStore has NO identity storage implementation (read-only package API only)', () => {
    const src = requireRaw(FILE_STORE);
    expect(src).toContain('readPersistedBookSession'); // consumes the package API
    expect(src).not.toMatch(/localStorage\.setItem/);
    expect(src).not.toMatch(/localStorage\.removeItem/);
    expect(src).not.toMatch(/['"]animastor:currentBook['"]/);
    expect(src).not.toMatch(/BOOK_STORE_KEY\s*=/);
    expect(src).not.toMatch(/:user:\$/);
  });

  it('rule 9 — restoreBookSession() stays in fileStore (File-flow orchestration)', () => {
    const src = requireRaw(FILE_STORE);
    expect(src).toContain('export async function restoreBookSession');
  });

  it('fileStore consumes the package through its public API (root import, no deep path)', () => {
    const src = requireRaw(FILE_STORE);
    expect(importSpecifiers(src)).toContain(PACKAGE_NAME);
    expect(importSpecifiers(src).some((s) => s.startsWith(`${PACKAGE_NAME}/`))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rules 10–14: package dependency cleanliness (the source graph itself)
// ─────────────────────────────────────────────────────────────────────────────

describe('book-session package — package source graph', () => {
  const pkgFiles = listSources(join(PKG_ROOT, 'src'));

  it('the package source is present and non-empty', () => {
    expect(pkgFiles.length).toBeGreaterThan(0);
    expect(pkgFiles.some((f) => f.endsWith(join('src', 'index.ts')))).toBe(true);
  });

  it('rules 10/13/14 — the package imports ONLY @preact/signals (no host, no @animastor/*)', () => {
    const specs = [...new Set(pkgFiles.flatMap((f) => importSpecifiers(readFileSync(f, 'utf8'))))];
    const external = specs.filter((s) => !s.startsWith('.'));
    expect(external, 'package external imports must be exactly [@preact/signals]')
      .toEqual(['@preact/signals']);
    for (const f of pkgFiles) {
      for (const spec of importSpecifiers(readFileSync(f, 'utf8'))) {
        // relative imports inside the package are fine; anything crossing out is not
        expect(spec.startsWith('../') && !spec.startsWith('../../'), `${f}: suspicious relative escape "${spec}"`).toBe(false);
      }
    }
  });

  it('rule 11 — the package does not import authStore', () => {
    for (const f of pkgFiles) {
      expect(
        importSpecifiers(readFileSync(f, 'utf8')).some((s) => s.includes('authStore')),
        `${f} imports authStore — reverse auth dependency forbidden`,
      ).toBe(false);
    }
  });

  it('rule 12 — the package does not import api/client', () => {
    for (const f of pkgFiles) {
      expect(
        importSpecifiers(readFileSync(f, 'utf8')).some((s) => s.includes('api/client')),
        `${f} imports api/client — transport is not an identity concern`,
      ).toBe(false);
    }
  });

  it('the package source contains no forbidden implementation tokens', () => {
    for (const f of pkgFiles) {
      const src = readFileSync(f, 'utf8');
      expect(src).not.toMatch(/from\s+['"](@preact\/signals-core|preact)['"]/);
      expect(src).not.toMatch(/export const (phase|errorMessage)\b/);
      expect(src).not.toMatch(/export (async )?function (restoreBookSession|applyGenerationResults|setPhase|setErrorMessage)/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 15: no second production implementation anywhere in src/
// ─────────────────────────────────────────────────────────────────────────────

describe('book-session package — no duplicate identity implementation', () => {
  it('rule 15 — no production file outside the re-export site declares the identity signals', () => {
    for (const f of productionFiles()) {
      if (f === HOST_STORE) continue; // re-export surface (rule 1 check above)
      const src = requireRaw(f);
      expect(src, `${f} re-declares an identity signal — single owner is the package`)
        .not.toMatch(/export const (bookId|buildId) = signal/);
      expect(src, `${f} declares a loadBook identity mutator — single owner is the package`)
        .not.toMatch(/export function loadBook\(/);
    }
  });

  it('the session key contract literal exists ONLY in the package', () => {
    for (const f of productionFiles()) {
      const src = requireRaw(f);
      expect(
        src,
        `${f} contains the session key literal — owned by the package`,
      ).not.toMatch(/['"]animastor:currentBook['"]/);
    }
  });

  it('no state module imports the package EXCEPT generateStore and fileStore', () => {
    const allowed = new Set([HOST_STORE, FILE_STORE]);
    const stateFiles = allSourceFiles()
      .filter((f) => f.startsWith('state/') && f.endsWith('.ts') && !f.includes('.test.'));
    for (const f of stateFiles) {
      if (allowed.has(f)) continue;
      expect(
        importSpecifiers(requireRaw(f)).some((s) => s.includes('web-book-session')),
        `${f} imports the book-session package — identity reaches host modules via generateStore re-exports only`,
      ).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth boundary
// ─────────────────────────────────────────────────────────────────────────────

describe('book-session package — auth boundary', () => {
  it('authStore keeps consuming the stash pair through the generateStore surface, owns no identity state', () => {
    const src = requireRaw('state/authStore.ts');
    expect(src).toContain('stashBookSessionForUser');
    expect(src).toContain('restoreStashedBookSessionForUser');
    expect(src).not.toMatch(/export const (bookId|buildId)\b/);
    expect(src).not.toContain('BOOK_STORE_KEY');
    expect(src).not.toMatch(/localStorage\.setItem/);
    // unchanged direction: authStore → generateStore (re-export) → package
    expect(importSpecifiers(src)).toContain('./generateStore');
  });

  it('generateStore does not import authStore (auth→identity edge stays one-directional)', () => {
    expect(importSpecifiers(requireRaw(HOST_STORE))).not.toContain('./authStore');
  });
});
