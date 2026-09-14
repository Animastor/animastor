// Architecture guard — GenerationPorts boundary (Step 4)
// (docs/architecture/web-generator-extraction-audit.md §13).
//
// Pins the forward-looking GenerationPorts interfaces as a clean
// boundary that future orchestration can depend on. No production
// code depends on this file yet — it documents the proposed split.
//
// Rules pinned here:
//   1. generationPorts.ts has NO forbidden imports (no @preact/signals,
//      no state/* stores, no api/client, no pages, no @animastor/*
//      packages).
//   2. generateStore does NOT import generationPorts.ts — the host
//      provides the implementation, it does not depend on the port
//      contract.
//   3. The port interfaces contain only plain TS types — no signal
//      wrappers, no DOM references, no framework-specific constructs.

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

const PORTS_FILE = 'app/generationPorts.ts';
const HOST_STORE = 'state/generateStore.ts';

// Forbidden import targets for the ports file — it must be a pure
// interface-only module with zero runtime dependencies.
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

describe('GenerationPorts boundary — ports file is pure', () => {
  it('generationPorts.ts exists', () => {
    const src = requireRaw(PORTS_FILE);
    expect(src).toBeTruthy();
  });

  it('has no forbidden imports', () => {
    const specs = importSpecifiers(PORTS_FILE);
    for (const forbidden of FORBIDDEN_IMPORTS) {
      expect(
        specs.includes(forbidden),
        `generationPorts.ts imports forbidden target: ${forbidden}`,
      ).toBe(false);
    }
  });

  it('has no @preact/signals usage', () => {
    const src = requireRaw(PORTS_FILE);
    // Strip comment lines before checking — the guard doc mentions @preact/signals
    // as a forbidden target, which is not an actual import.
    const nonCommentLines = src.split('\n').filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });
    const nonCommentSrc = nonCommentLines.join('\n');
    expect(nonCommentSrc).not.toContain('@preact/signals');
    expect(nonCommentSrc).not.toContain('signal<');
    expect(nonCommentSrc).not.toContain('Signal<');
  });

  it('has no api/client imports', () => {
    const specs = importSpecifiers(PORTS_FILE);
    const apiImports = specs.filter((s) => s.includes('api/client'));
    expect(apiImports, `generationPorts.ts imports api/client: ${apiImports.join(', ')}`).toEqual([]);
  });

  it('has no state/* store imports', () => {
    const specs = importSpecifiers(PORTS_FILE);
    const stateImports = specs.filter((s) => s.startsWith('state/') || s.includes('/state/'));
    expect(stateImports, `generationPorts.ts imports state stores: ${stateImports.join(', ')}`).toEqual([]);
  });

  it('has no page or app component imports', () => {
    const specs = importSpecifiers(PORTS_FILE);
    const uiImports = specs.filter((s) => s.includes('pages/') || s.includes('app/icons') || s.includes('app/AppShell'));
    expect(uiImports, `generationPorts.ts imports UI components: ${uiImports.join(', ')}`).toEqual([]);
  });
});

describe('GenerationPorts boundary — generateStore does not depend on ports', () => {
  it('generateStore does NOT import generationPorts.ts', () => {
    const specs = importSpecifiers(HOST_STORE);
    expect(
      specs.includes('./app/generationPorts') || specs.includes('../app/generationPorts'),
      'generateStore imports generationPorts — the host provides the implementation, not the contract',
    ).toBe(false);
  });
});

describe('GenerationPorts boundary — interface-only surface', () => {
  it('all exports are interfaces or type aliases (no runtime values)', () => {
    const src = requireRaw(PORTS_FILE);
    // Should only contain: export interface, export type
    const lines = src.split('\n').filter((l) => l.startsWith('export '));
    for (const line of lines) {
      const trimmed = line.trim();
      expect(
        trimmed.startsWith('export interface') || trimmed.startsWith('export type'),
        `generationPorts.ts has a runtime export: ${trimmed}`,
      ).toBe(true);
    }
  });

  it('no function implementations (only interface method signatures)', () => {
    const src = requireRaw(PORTS_FILE);
    // Interface method signatures use `name(...):` — implementations use `name(...) {`
    // or `function name(...)`. The ports file should not have any of the latter.
    expect(src).not.toMatch(/export\s+function\s+\w+/);
    expect(src).not.toMatch(/export\s+const\s+\w+\s*=\s*\(/);
    expect(src).not.toMatch(/export\s+class\s+/);
  });
});
