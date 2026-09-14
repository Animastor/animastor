// Architecture guard — @animastor/web-generator-vbook boundary
// (docs/architecture/web-generator-extraction-audit.md, Step 9).
//
// Rules pinned here:
//   1. Package source has NO forbidden imports: no @preact/signals,
//      no host stores (generateStore/authStore/fileStore/playbackStore/
//      positionStore), no api/client, no app/*, no pages, no other
//      @animastor/* packages.
//   2. Dependency direction: the package imports ONLY
//      @animastor/web-generator (allowed sibling domain package).
//   3. No @preact/signals usage anywhere (comment-stripped check).
//   4. No module-global mutable state — all mutable state must be
//      explicit (VBookPollState / VBookPollContract passed in by the
//      host). No module-scope `let` declarations.
//   5. Explicit polling state: VBookPollState + VBookPollContract
//      are exported; the poll loop checks the token through the
//      contract, never through a module-global counter.
//   6. No SSE implementation — the package must not define an SSE
//      stream/reconnect loop (that lives in @animastor/web-generator-sse);
//      stream initiation goes through the injected startStream callback.
//   7. Transport only through VBookTransportPort — no direct API
//      client access (no fetch( calls at module level).

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url)); // .../test
const SRC_ROOT = join(PACKAGE_ROOT, '..', 'src');

/** Package src files as {relPath: rawSource}. */
function packageSources(): Record<string, string> {
  const out: Record<string, string> = {};
  function walk(dir: string, prefix: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (existsSync(join(full, 'package.json'))) continue;
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
        out[rel] = readFileSync(full, 'utf8');
      }
    }
  }
  walk(SRC_ROOT, '');
  return out;
}

const RAW_PACKAGE_SOURCES = packageSources();

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
  const raw = RAW_PACKAGE_SOURCES[rel];
  if (raw === undefined) throw new Error(`guard: source not found: ${rel}`);
  return raw;
}

function allSourceFiles(): string[] {
  return Object.keys(RAW_PACKAGE_SOURCES).sort();
}

const FORBIDDEN_IMPORTS = [
  '@preact/signals',
  'state/generateStore',
  'generateStore',
  'state/positionStore',
  'positionStore',
  'state/authStore',
  'authStore',
  'state/fileStore',
  'fileStore',
  'state/playbackStore',
  'playbackStore',
  '../api/client',
  '../../api/client',
  'api/client',
  'app/',
  'pages/',
  '@animastor/web-generator-sse',
  '@animastor/web-generator-config',
  '@animastor/web-player',
  '@animastor/web-file',
  '@animastor/web-navigator',
  '@animastor/web-editor',
  '@animastor/web-settings',
  '@animastor/web-local-ai',
  '@animastor/web-workers',
  '@animastor/contracts',
];

const ALLOWED_ANIMASTOR_IMPORT = '@animastor/web-generator';

describe('web-generator-vbook package — no forbidden imports', () => {
  for (const file of allSourceFiles()) {
    it(`${file} has no forbidden imports`, () => {
      const specs = importSpecifiers(file);
      for (const forbidden of FORBIDDEN_IMPORTS) {
        expect(
          specs.some((s) => s === forbidden || s.includes(forbidden)),
          `${file} imports forbidden target: ${forbidden}`,
        ).toBe(false);
      }
    });
  }
});

describe('web-generator-vbook package — dependency direction', () => {
  it('only imports @animastor/web-generator among @animastor packages', () => {
    for (const file of allSourceFiles()) {
      const specs = importSpecifiers(file);
      const animastorImports = specs.filter(
        (s) => s.startsWith('@animastor/') && s !== ALLOWED_ANIMASTOR_IMPORT,
      );
      expect(
        animastorImports,
        `${file} imports non-sibling @animastor packages: ${animastorImports.join(', ')}`,
      ).toEqual([]);
    }
  });

  it('index.ts imports from @animastor/web-generator (sibling domain dependency)', () => {
    const specs = importSpecifiers('index.ts');
    expect(specs).toContain(ALLOWED_ANIMASTOR_IMPORT);
  });

  it('no deep imports into the sibling package', () => {
    for (const file of allSourceFiles()) {
      const specs = importSpecifiers(file);
      const deep = specs.filter((s) => s.startsWith(`${ALLOWED_ANIMASTOR_IMPORT}/`));
      expect(deep, `${file} deep-imports the sibling package: ${deep.join(', ')}`).toEqual([]);
    }
  });

  it('no reverse dependency: the sibling packages do not import this package', () => {
    const siblingRoot = join(PACKAGE_ROOT, '..', '..', 'animastor-web-generator', 'src');
    const siblingSources: string[] = [];
    function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if ((entry.endsWith('.ts') || entry.endsWith('.tsx')) && !entry.endsWith('.d.ts')) {
          siblingSources.push(readFileSync(full, 'utf8'));
        }
      }
    }
    walk(siblingRoot);
    expect(siblingSources.length).toBeGreaterThan(0);
    for (const src of siblingSources) {
      expect(
        src.includes('@animastor/web-generator-vbook'),
        'sibling package imports @animastor/web-generator-vbook — reverse dependency',
      ).toBe(false);
    }
  });
});

describe('web-generator-vbook package — no signals', () => {
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
      expect(nonCommentSrc).not.toContain('.value =');
    });
  }
});

describe('web-generator-vbook package — no module-global mutable state', () => {
  it('no module-scope let declarations', () => {
    for (const file of allSourceFiles()) {
      const src = requireRaw(file);
      const moduleScopeLets = src.match(/^let\s+\w+/gm);
      expect(moduleScopeLets, `${file} has module-scope let declarations`).toBeNull();
    }
  });

  it('no module-scope mutable objects/arrays (state must be explicit parameters)', () => {
    for (const file of allSourceFiles()) {
      const src = requireRaw(file);
      const moduleScopeConst = src.match(/^const\s+\w+\s*=\s*(?:new\s+|(?:\[|\{))/gm);
      expect(moduleScopeConst, `${file} has module-scope mutable state`).toBeNull();
    }
  });
});

describe('web-generator-vbook package — explicit polling state', () => {
  it('exports VBookPollState and VBookPollContract', () => {
    const src = requireRaw('index.ts');
    expect(src).toMatch(/export interface VBookPollState/);
    expect(src).toMatch(/export interface VBookPollContract/);
    expect(src).toMatch(/export function createVBookPollState/);
  });

  it('the poll loop checks staleness only through the injected contract', () => {
    const src = requireRaw('index.ts');
    expect(src).toContain('ports.poll.getPollToken()');
    expect(src).not.toMatch(/(export\s+)?(let|var)\s+vbookPollToken/);
  });
});

describe('web-generator-vbook package — no SSE implementation', () => {
  it('does not define an SSE stream/reconnect loop (lives in web-generator-sse)', () => {
    const src = requireRaw('index.ts');
    expect(src).not.toContain('AsyncIterable');
    expect(src).not.toContain('EventSource');
    expect(src).not.toMatch(/reconnect|backoff/i);
    expect(src).toContain('startStream'); // injected callback instead
  });

  it('finalization hands back to the host via onGenerationFinalized', () => {
    const src = requireRaw('index.ts');
    expect(src).toMatch(/onGenerationFinalized\(\): void \| Promise<void>/);
    expect(src).toContain('await ports.lifecycle.onGenerationFinalized()');
  });
});

describe('web-generator-vbook package — transport only through the port', () => {
  it('no direct fetch / API client usage', () => {
    for (const file of allSourceFiles()) {
      const src = requireRaw(file);
      const nonCommentSrc = src
        .split('\n')
        .filter((l) => {
          const t = l.trim();
          return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
        })
        .join('\n');
      expect(nonCommentSrc, `${file} uses fetch directly`).not.toMatch(/\bfetch\(/);
    }
  });

  it('transport calls go through ports.transport', () => {
    const src = requireRaw('index.ts');
    expect(src).toContain('ports.transport.getJson');
    expect(src).toContain('ports.transport.postJsonLong');
  });
});
