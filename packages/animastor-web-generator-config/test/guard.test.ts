// Architecture guard — @animastor/web-generator-config boundary
// (docs/architecture/web-generator-extraction-audit.md, Step 5).
//
// Rules pinned here:
//   1. Package source has NO forbidden imports: no @preact/signals,
//      no state/* stores, no api/client, no pages, no @animastor/*
//      packages.
//   2. All exports are interfaces or pure functions (no signal
//      wrappers, no DOM references).
//   3. The package has zero host reach.

import { describe, it, expect } from 'vitest';

const RAW_SOURCES = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

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

function allSourceFiles(): string[] {
  return Object.keys(RAW_SOURCES)
    .filter((k) => !k.startsWith('/src/architecture/'))
    .map((k) => k.replace(/^\/src\//, ''))
    .sort();
}

const FORBIDDEN_IMPORTS = [
  '@preact/signals',
  'state/generateStore',
  'state/positionStore',
  'state/authStore',
  'state/fileStore',
  'state/playbackStore',
  '../api/client',
  '../../api/client',
  '@animastor/web-generator',
  '@animastor/web-player',
  '@animastor/web-file',
  '@animastor/web-navigator',
  '@animastor/web-editor',
  '@animastor/web-settings',
  '@animastor/web-local-ai',
  '@animastor/orchestration',
];

describe('web-generator-config package — no forbidden imports', () => {
  for (const file of allSourceFiles()) {
    it(`${file} has no forbidden imports`, () => {
      const specs = importSpecifiers(file);
      for (const forbidden of FORBIDDEN_IMPORTS) {
        expect(
          specs.includes(forbidden),
          `${file} imports forbidden target: ${forbidden}`,
        ).toBe(false);
      }
    });
  }
});

describe('web-generator-config package — no @preact/signals', () => {
  for (const file of allSourceFiles()) {
    it(`${file} has no signal usage`, () => {
      const src = requireRaw(file);
      const nonCommentLines = src.split('\n').filter((l) => {
        const t = l.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      });
      const nonCommentSrc = nonCommentLines.join('\n');
      expect(nonCommentSrc).not.toContain('@preact/signals');
      expect(nonCommentSrc).not.toContain('signal<');
      expect(nonCommentSrc).not.toContain('Signal<');
    });
  }
});

describe('web-generator-config package — no api/client imports', () => {
  for (const file of allSourceFiles()) {
    it(`${file} has no api/client imports`, () => {
      const specs = importSpecifiers(file);
      const apiImports = specs.filter((s) => s.includes('api/client'));
      expect(apiImports, `${file} imports api/client: ${apiImports.join(', ')}`).toEqual([]);
    });
  }
});

describe('web-generator-config package — no state store imports', () => {
  for (const file of allSourceFiles()) {
    it(`${file} has no state/* imports`, () => {
      const specs = importSpecifiers(file);
      const stateImports = specs.filter((s) => s.startsWith('state/') || s.includes('/state/'));
      expect(stateImports, `${file} imports state stores: ${stateImports.join(', ')}`).toEqual([]);
    });
  }
});

describe('web-generator-config package — no page/UI imports', () => {
  for (const file of allSourceFiles()) {
    it(`${file} has no page or UI imports`, () => {
      const specs = importSpecifiers(file);
      const uiImports = specs.filter((s) =>
        s.includes('pages/') || s.includes('app/icons') || s.includes('app/AppShell'),
      );
      expect(uiImports, `${file} imports UI: ${uiImports.join(', ')}`).toEqual([]);
    });
  }
});

describe('web-generator-config package — interface-only exports', () => {
  it('index.ts exports only interfaces and async functions', () => {
    const src = requireRaw('index.ts');
    const exportLines = src.split('\n').filter((l) => l.startsWith('export '));
    for (const line of exportLines) {
      const trimmed = line.trim();
      // Allow: export interface, export type, export async function, export function, export { ... }
      const valid = (
        trimmed.startsWith('export interface') ||
        trimmed.startsWith('export type') ||
        trimmed.startsWith('export async function') ||
        trimmed.startsWith('export function') ||
        trimmed.startsWith('export {')
      );
      expect(valid, `index.ts has unexpected export: ${trimmed}`).toBe(true);
    }
  });
});
