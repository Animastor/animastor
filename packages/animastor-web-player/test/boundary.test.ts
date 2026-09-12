// Package boundary tests — verify that @animastor/web-player never imports
// host stores, host infrastructure, or app-level modules, and that its test
// suites stay package-owned (vitest + package-internal only).
//
// Phase 3 re-aim of the Phase 2.2 in-app guards
// (frontends/app/src/architecture/player-contour.guard.test.ts): the Player
// contour physically lives in packages/animastor-web-player/src/ and the
// suites in test/ — these are the package-side twins of those rules, scanning
// the package's own tree (node:fs is available in the package, like web-file's
// boundary test):
//
//   - src/ imports host infrastructure ONLY via ./ports types (no state/,
//     api/, app/, pages/ specifiers — the re-introduced package→host edge
//     fails here);
//   - external imports are preact peers only;
//   - test/ suites import vitest + package-internal relatives ONLY —
//     relative specifiers are RESOLVED (the "./../…"/"../../…" escape hole)
//     and bare specifiers must be in the allowlist;
//   - dynamic import('…') and vi.mock('…') module paths are scanned on
//     comment-stripped source (a mock path is a module reach too);
//   - src/ + test/ contain exactly the pinned contour/suite inventory — no
//     unscanned third category can appear silently;
//   - the public entry exports the host-facing surface and does NOT leak
//     bookId/buildId or other engine internals.

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

/** Strip comments and full/line-trailing // comments — the scan must read
 *  CODE, not prose. Line count is preserved for debugging. NOTE: real /*block
 *  comments are NOT matched globally — a prose "app/*" inside a // comment
 *  would swallow the rest of the file (PlayPage.tsx line 10). Instead: strip
 *  per line, only when the line is comment-led (indent + /* at line start,
 *  closing on the same or later lines); otherwise drop only // tails. */
function stripComments(src: string): string {
  const lines = src
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, (_m, p1: string) => p1));
  // Remove /* … */ blocks only when they start at (leading-whitespace +) the
  // line start — the JSDoc convention used in this package's sources.
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (inBlock) {
      out.push(line.replace(/[^\n]/g, ''));
      if (/\*\/\s*$/.test(line)) inBlock = false;
      continue;
    }
    const blockStart = line.match(/^(\s*)\/\*/);
    if (blockStart) {
      out.push('');
      if (!/\*\/\s*$/.test(line)) inBlock = true;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** ALL module reaches of a test file — static + type + side-effect imports,
 *  dynamic import('…') and vi.mock('…') module paths — from stripped source. */
function suiteImportSpecifiers(rel: string): string[] {
  const src = stripComments(requireRaw(rel));
  const specs = new Set<string>();
  for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g)) specs.add(m[1]);
  for (const m of src.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) specs.add(m[1]);
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1]);
  for (const m of src.matchAll(/\bvi\.mock\s*\(\s*['"]([^'"]+)['"]/g)) specs.add(m[1]);
  return [...specs];
}

/** Resolve a relative specifier against the importing file's directory (posix,
 *  pure string ops). "./../state/x" and "../../api/x" collapse to paths
 *  OUTSIDE the package. */
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

/** Comment stripping for assertion targets (alias of stripComments). */
function stripCommentsRaw(src: string): string {
  return stripComments(src);
}

// The pinned physical inventory (Phase 3 move; exact — no third category).
const CONTOUR_FILES = [
  'index.ts',
  'models.ts',
  'mediaCache.ts',
  'playbackGate.ts',
  'playbackStore.ts',
  'ports.ts',
  'PlayPage.tsx',
].map((f) => `src/${f}`);
const SUITE_FILES = [
  'mediaCache.test.ts',
  'playbackBookSwitch.test.ts',
  'playbackCacheInvalidation.test.ts',
  'playbackGate.test.ts',
  'playbackIdentityUiStates.test.ts',
  'playbackRevealOvershoot.test.ts',
  'playbackStickySeeking.test.ts',
  'playbackStore.test.ts',
  'playbackTargetCleanup.test.ts',
  'playbackVideoListener.test.ts',
  'boundary.test.ts', // this file — pinned too
].map((f) => `test/${f}`);
const BOUNDARY_TEST = 'test/boundary.test.ts';

// ── src/ boundary: no package→host edge ─────────────────────────────────────

describe('@animastor/web-player src boundary (no host reach)', () => {
  it('src/ imports NO host module (state/, api/, app/, pages/, features/, lib/)', () => {
    for (const f of allSourceFiles().filter((f) => f.startsWith('src/'))) {
      for (const spec of importSpecifiers(f)) {
        expect(
          spec,
          `${f} imports "${spec}" — a package→host edge (everything arrives via PlayerPorts)`,
        ).not.toMatch(/(?:^|\/)(?:state|api|app|pages|features|lib)\//);
        expect(
          spec,
          `${f} relative-imports outside the package via "${spec}"`,
        ).not.toMatch(/^\.\./);
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

  it('src/ relative imports resolve only inside src/ (the engine + gate + mediaCache + ports + models + page closure)', () => {
    for (const f of allSourceFiles().filter((f) => f.startsWith('src/') && f !== 'src/index.ts')) {
      for (const spec of importSpecifiers(f)) {
        if (!spec.startsWith('.')) continue;
        const resolved = resolveRelative(f, spec);
        expect(
          resolved.startsWith('src/'),
          `${f} imports "${spec}" → ${resolved} (outside the package closure)`,
        ).toBe(true);
      }
    }
  });

  it('the public entry exports ONLY the host-facing API (no bookId/buildId, no engine internals)', () => {
    const src = requireRaw('src/index.ts');
    expect(src).toMatch(/export\s*\{[^}]*\bPlayPage\b[^}]*\}\s*from\s*'\.\/PlayPage'/);
    expect(src).toMatch(/export\s*\{[^}]*\bwirePlaybackCoordination\b[^}]*\}\s*from\s*'\.\/playbackStore'/);
    expect(src).toMatch(/export\s*\{[^}]*\bwirePlaybackLifecycle\b[^}]*\}\s*from\s*'\.\/playbackStore'/);
    expect(src).toMatch(/export\s*\{[^}]*\bseekToPosition\b[^}]*\}\s*from\s*'\.\/playbackStore'/);
    expect(src).toMatch(/export\s*\{[^}]*\bcloseBook\b[^}]*\}\s*from\s*'\.\/playbackStore'/);
    expect(src).toMatch(/export\s*\{[^}]*\binvalidateDeletedScene\b[^}]*\}\s*from\s*'\.\/playbackStore'/);
    expect(src).toMatch(/export\s*\{[^}]*\binvalidateDeletedChapter\b[^}]*\}\s*from\s*'\.\/playbackStore'/);
    expect(src).toMatch(/export\s*\{[^}]*\bclearCache as clearMediaCache\b[^}]*\}\s*from\s*'\.\/mediaCache'/);
    expect(src).toMatch(/export\s+type\s*\{\s*PlayerPorts\s*\}\s*from\s*'\.\/ports'/);
    // No second public identity source; no internal state/helpers leak.
    expect(src, 'the entry must not export bookId/buildId').not.toMatch(/export\s*\{[^}]*\b(?:bookId|buildId)\b[^}]*\}/);
    expect(src).toMatch(/^export \{ PlayPage \} from '\.\/PlayPage';\n(?:export[\s\S]*)*$/m); // entry-only shape
    // No engine-internal escape hatches: the entry exports exactly the nine
    // host-facing symbols above and nothing else.
    const exported = [...stripCommentsRaw(src).matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)]
      .flatMap((m) => m[1].split(','))
      .map((s) => s.trim().split(/\s+as\s+/).pop()!)
      .filter(Boolean)
      .sort();
    expect(exported).toEqual([
      'PlayPage',
      'PlayerPorts',
      'clearMediaCache',
      'closeBook',
      'invalidateDeletedChapter',
      'invalidateDeletedScene',
      'seekToPosition',
      'wirePlaybackCoordination',
      'wirePlaybackLifecycle',
    ].sort());
    // The engine must not re-export its internal identity projection either.
    const engine = stripCommentsRaw(requireRaw('src/playbackStore.ts'));
    expect(engine, 'the engine must not re-export bookId/buildId').not.toMatch(/export\s*\{[^}]*\b(?:bookId|buildId)\b[^}]*\}/);
  });

  it('the Play surface consumes session identity ONLY through PlayerPorts.session', () => {
    const page = stripCommentsRaw(requireRaw('src/PlayPage.tsx'));
    for (const m of page.matchAll(/(?:import|export)\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      expect(
        names.filter((n) => n === 'bookId' || n === 'buildId'),
        `PlayPage imports the identity signals from "${m[2]}" — session identity must arrive through props.ports.session only`,
      ).toEqual([]);
    }
    expect(page).not.toMatch(/\b(?:bookId|buildId)\.value\b/);
    expect(page).toMatch(/ports\.session\.bookId/);
    expect(page).toMatch(/ports\.session\.buildId/);
  });
});

// ── test/ isolation: suites are package-owned ────────────────────────────────

// External modules a player suite may import (the package's devDependencies).
const TEST_EXTERNALS = ['vitest'] as const;

/** The isolation rule for ONE import of a suite: null = allowed, else message. */
function suiteImportViolation(suite: string, spec: string): string | null {
  if (spec.startsWith('.')) {
    const resolved = resolveRelative(suite, spec);
    return resolved.startsWith('src/')
      ? null
      : `resolves outside src/ (→ ${resolved})`;
  }
  return (TEST_EXTERNALS as readonly string[]).includes(spec)
    ? null
    : `bare specifier not in TEST_EXTERNALS [${TEST_EXTERNALS.join(', ')}]`;
}

describe('@animastor/web-player test isolation (suites move verbatim with the package)', () => {
  it('every suite imports only vitest + src/-internal modules (resolution-checked: static, dynamic, vi.mock)', () => {
    const offenders: string[] = [];
    for (const f of allSourceFiles().filter((f) => f.startsWith('test/') && f !== BOUNDARY_TEST)) {
      for (const spec of suiteImportSpecifiers(f)) {
        const violation = suiteImportViolation(f, spec);
        if (violation) offenders.push(`${f}: "${spec}" — ${violation}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('this boundary suite itself stays package-owned too', () => {
    for (const spec of suiteImportSpecifiers(BOUNDARY_TEST)) {
      // Real import specifiers never contain backslashes — skip the regex
      // literal artifacts (e.g. /from '\.\/PlayPage'/) this suite's own
      // assertion regexes produce when scanning its own source.
      if (spec.includes('\\')) continue;
      expect(spec).toMatch(/^(?:vitest|node:(?:fs|path))$/);
    }
  });

  // Regression cases for the resolution rule (the escaped-relative hole).
  describe('isolation rule regression (relative-path escape hole)', () => {
    const SUITE = 'test/playbackStore.test.ts';

    it('"../src/models" — inside the package → allowed', () => {
      expect(suiteImportViolation(SUITE, '../src/models')).toBeNull();
    });

    it('"../../frontends/app/src/state/x" — escape outside the package → forbidden', () => {
      expect(suiteImportViolation(SUITE, '../../frontends/app/src/state/x')).toMatch(/outside src\//);
    });

    it('"./../test/foo" — the "./"-masked escape → forbidden', () => {
      expect(suiteImportViolation(SUITE, './../test/foo')).toMatch(/outside src\//);
    });

    it('"vitest" — the only allowlisted external; other bare specifiers are forbidden', () => {
      expect(suiteImportViolation(SUITE, 'vitest')).toBeNull();
      expect(suiteImportViolation(SUITE, '@animastor/web-file')).toMatch(/TEST_EXTERNALS/);
      expect(suiteImportViolation(SUITE, 'happy-dom')).toMatch(/TEST_EXTERNALS/);
    });
  });
});

// ── Physical inventory: exactly the contour + suites, nothing else ──────────

describe('@animastor/web-player physical inventory', () => {
  it('src/ + test/ contain exactly the pinned contour files + suites (no unscanned third category)', () => {
    const actual = allSourceFiles().sort();
    expect(actual).toEqual([...CONTOUR_FILES, ...SUITE_FILES].sort());
  });
});
