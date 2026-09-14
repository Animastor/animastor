// Architecture guard — @animastor/web-generator-sse boundary
// (docs/architecture/web-generator-extraction-audit.md, Step 7).

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
    .filter((k) => !k.startsWith('/test/'))
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
  '@animastor/web-generator-config',
  '@animastor/web-player',
  '@animastor/web-file',
  '@animastor/web-navigator',
  '@animastor/web-editor',
  '@animastor/web-settings',
  '@animastor/web-local-ai',
  '@animastor/orchestration',
];

const ALLOWED_IMPORT = '@animastor/web-generator';

describe('web-generator-sse package — no forbidden imports', () => {
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

describe('web-generator-sse package — only imports @animastor/web-generator', () => {
  it('index.ts imports from @animastor/web-generator', () => {
    const specs = importSpecifiers('index.ts');
    expect(specs).toContain(ALLOWED_IMPORT);
  });

  it('index.ts has no other @animastor imports', () => {
    const specs = importSpecifiers('index.ts');
    const animastorImports = specs.filter((s) => s.startsWith('@animastor/') && s !== ALLOWED_IMPORT);
    expect(animastorImports).toEqual([]);
  });
});

describe('web-generator-sse package — no @preact/signals', () => {
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

describe('web-generator-sse package — no module-global mutable state', () => {
  it('index.ts has no let/const module-scope mutable state', () => {
    const src = requireRaw('index.ts');
    // Only function-scope locals and constants are allowed at module level
    const moduleScopeLets = src.match(/^let\s+\w+/gm);
    expect(moduleScopeLets, 'index.ts has module-scope let declarations').toBeNull();
  });

  it('index.ts has no module-scope mutable arrays or objects', () => {
    const src = requireRaw('index.ts');
    // No module-scope state beyond function definitions and type exports
    const moduleScopeConst = src.match(/^const\s+\w+\s*=\s*(?:new\s+|(?:\[|\{))/gm);
    expect(moduleScopeConst, 'index.ts has module-scope mutable state').toBeNull();
  });
});
