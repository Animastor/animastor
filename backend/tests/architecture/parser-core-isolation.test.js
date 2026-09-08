// ======================================================
// PARSER CORE ISOLATION — architecture guard for C14 extraction seam
// ======================================================
// Proves that the Parser Core surface has ZERO coupling to VBook persistence,
// Redis, PostgreSQL, AI pipeline, Book Writer, or Importer. When @animastor/parser
// is physically extracted, these guards guarantee the package can be built
// without any host-side dependencies.
//
// Files in scope (Parser Core boundary):
//   - packages/.../src/parser-core.js              (extraction barrel)
//   - packages/.../src/lazy-book/parser.js          (Parser facade)
//   - packages/.../src/contracts/parser-contract.js  (pure contract)
//   - packages/.../src/contracts/legacy-projection.js (pure projection)
//   - packages/.../src/language-detector.js          (pure utility)

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const { REPO_ROOT, listSourceFiles, readSource, rel, requireSpecifiers } = require('./helpers');

const PACKAGE_DIR = path.join(REPO_ROOT, 'packages', 'animastor-parser');
const PACKAGE_SRC = path.join(PACKAGE_DIR, 'src');

// ── Parser Core file set ────────────────────────────────────────────────────
const PARSER_CORE_FILES = [
    'packages/animastor-parser/src/index.js',
    'packages/animastor-parser/src/lazy-book/parser.js',
    'packages/animastor-parser/src/contracts/parser-contract.js',
    'packages/animastor-parser/src/contracts/legacy-projection.js',
    'packages/animastor-parser/src/language-detector.js',
].map(f => path.join(REPO_ROOT, f));

// ── Forbidden imports (host-side dependencies) ──────────────────────────────
// Only match actual require()/import specifiers, not comments or string literals.
const FORBIDDEN_IMPORTS = [
    // Persistence / infrastructure
    { pattern: /require\(\s*['"]pg['"]\)/, label: 'PostgreSQL' },
    { pattern: /require\(\s*['"]ioredis['"]\)/, label: 'Redis' },
    { pattern: /require\(\s*['"]mongoose['"]\)/, label: 'MongoDB' },
    // Filesystem (Book Writer / persistence)
    { pattern: /require\(\s*['"]fs['"]\)/, label: 'fs (filesystem)' },
    { pattern: /require\(\s*['"]path['"]\)/, label: 'path' },
    // Host-side services (require specifiers only)
    { pattern: /require\(\s*['"][^'"]*structure-detector[^'"]*['"]\)/, label: 'structure-detector' },
    { pattern: /require\(\s*['"][^'"]*txt-importer[^'"]*['"]\)/, label: 'txt-importer' },
    { pattern: /require\(\s*['"][^'"]*book-deletion[^'"]*['"]\)/, label: 'book-deletion' },
    { pattern: /require\(\s*['"][^'"]*runtime-config[^'"]*['"]\)/, label: 'runtime-config' },
    // AI pipeline (require specifiers only)
    { pattern: /require\(\s*['"][^'"]*openai[^'"]*['"]\)/, label: 'openai' },
    { pattern: /require\(\s*['"][^'"]*anthropic[^'"]*['"]\)/, label: 'anthropic' },
    // Book Writer / draft / persistence (require specifiers only)
    { pattern: /require\(\s*['"][^'"]*draft[^'"]*['"]\)/, label: 'draft/persistence' },
    { pattern: /require\(\s*['"][^'"]*parse\.js['"]\)/, label: 'parse.js (Book Writer)' },
];

// Allowed external dependencies for Parser Core
const ALLOWED_EXTERNALS = new Set(['tinyld']);

function resolveRelative(fromFile, spec) {
    const base = path.resolve(path.dirname(fromFile), spec);
    const candidates = [base, base + '.js', base + '.cjs', path.join(base, 'index.js'), path.join(base, 'index.cjs')];
    for (const c of candidates) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
    return null;
}

// ── Guard 1: Parser Core files have no forbidden imports ────────────────────
describe('Parser Core isolation: no forbidden imports', () => {
    for (const filePath of PARSER_CORE_FILES) {
        const relPath = rel(filePath);
        it(`${relPath}: no forbidden host-side imports`, () => {
            const src = readSource(filePath);
            const violations = [];
            for (const { pattern, label } of FORBIDDEN_IMPORTS) {
                if (pattern.test(src)) {
                    violations.push(label);
                }
            }
            expect(violations, `${relPath} must not import host-side dependencies: ${violations.join(', ')}`).to.deep.equal([]);
        });
    }
});

// ── Guard 2: Parser Core files only resolve within package or allowed deps ──
describe('Parser Core isolation: require graph stays within boundary', () => {
    for (const filePath of PARSER_CORE_FILES) {
        const relPath = rel(filePath);
        it(`${relPath}: all requires resolve inside the package or are allowed externals`, () => {
            const src = readSource(filePath);
            const specs = requireSpecifiers(src);
            const offenders = [];
            for (const spec of specs) {
                if (spec.startsWith('.')) {
                    const target = resolveRelative(filePath, spec);
                    const targetRel = target ? rel(target) : null;
                    const inside = targetRel && targetRel.startsWith('packages/animastor-parser/src/');
                    if (!inside) offenders.push(`${spec} (resolves to ${targetRel || 'NOT FOUND'})`);
                    continue;
                }
                // Bare specifiers: only tinyld is allowed
                if (ALLOWED_EXTERNALS.has(spec)) continue;
                offenders.push(`${spec} (bare specifier, not in allowlist)`);
            }
            expect(offenders, `${relPath} has cross-boundary requires: ${offenders.join('; ')}`).to.deep.equal([]);
        });
    }
});

// ── Guard 3: parser-contract.js is pure (zero requires) ─────────────────────
describe('Parser Core purity: parser-contract.js has zero requires', () => {
    it('parser-contract.js exports without any require/import', () => {
        const filePath = path.join(REPO_ROOT, 'packages/animastor-parser/src/contracts/parser-contract.js');
        const src = readSource(filePath);
        const specs = requireSpecifiers(src);
        expect(specs, 'parser-contract.js must be pure (zero requires)').to.deep.equal([]);
    });
});

// ── Guard 4: legacy-projection.js is pure (zero requires) ───────────────────
describe('Parser Core purity: legacy-projection.js has zero requires', () => {
    it('legacy-projection.js exports without any require/import', () => {
        const filePath = path.join(REPO_ROOT, 'packages/animastor-parser/src/contracts/legacy-projection.js');
        const src = readSource(filePath);
        const specs = requireSpecifiers(src);
        expect(specs, 'legacy-projection.js must be pure (zero requires)').to.deep.equal([]);
    });
});

// ── Guard 5: language-detector.js only depends on tinyld ────────────────────
describe('Parser Core purity: language-detector.js depends only on tinyld', () => {
    it('language-detector.js requires only tinyld (no host deps)', () => {
        const filePath = path.join(REPO_ROOT, 'packages/animastor-parser/src/language-detector.js');
        const src = readSource(filePath);
        const specs = requireSpecifiers(src);
        expect(specs, 'language-detector.js must only require tinyld').to.deep.equal(['tinyld']);
    });
});

// ── Guard 6: parser.js has no VBook persistence imports ─────────────────────
describe('Parser Core purity: parser.js has no persistence/state imports', () => {
    it('parser.js does not import fs, draft, paths, constants, or BookState', () => {
        const filePath = path.join(REPO_ROOT, 'packages/animastor-parser/src/lazy-book/parser.js');
        const src = readSource(filePath);
        const specs = requireSpecifiers(src);
        // parser.js should only import from contracts/ and language-detector
        const allowed = [
            '../contracts/parser-contract',
            '../contracts/legacy-projection',
            '../language-detector',
        ];
        const offenders = specs.filter(s => s.startsWith('.') && !allowed.includes(s));
        expect(offenders, `parser.js has unexpected relative imports: ${offenders.join('; ')}`).to.deep.equal([]);
    });
});

// ── Guard 7: parse.js (Book Writer) is NOT part of Parser Core ──────────────
describe('Parser Core boundary: parse.js (Book Writer) is excluded', () => {
    it('parse.js is not in the Parser Core file set', () => {
        const parseJsPath = path.join(REPO_ROOT, 'packages/animastor-vbook-runtime/src/lazy-book/parse.js');
        expect(PARSER_CORE_FILES).to.not.include(parseJsPath);
    });

    it('parse.js imports fs (confirming it is NOT pure parser)', () => {
        const parseJsPath = path.join(REPO_ROOT, 'packages/animastor-vbook-runtime/src/lazy-book/parse.js');
        const src = readSource(parseJsPath);
        expect(src).to.include("require('fs')", 'parse.js uses fs (Book Writer, not Parser Core)');
    });
});

// ── Guard 8: index.js barrel re-exports correctly ─────────────────────────
describe('Parser Core barrel: index.js exports the full surface', () => {
    it('index.js re-exports all Parser Core functions', () => {
        const barrel = require(path.join(PACKAGE_SRC, 'index'));
        // Parser facade
        expect(barrel.splitIntoChapters).to.be.a('function');
        expect(barrel.splitIntoScenes).to.be.a('function');
        expect(barrel.splitIntoUnits).to.be.a('function');
        expect(barrel.firstMeaningfulChapter).to.be.a('function');
        expect(barrel.detectLanguage).to.be.a('function');
        expect(barrel.injectChapterMarkers).to.be.a('function');
        // Port binding
        expect(barrel.setStructureDetector).to.be.a('function');
        expect(barrel.getStructureDetector).to.be.a('function');
        // Contract
        expect(barrel.PARSER_CONTRACT_VERSION).to.equal(1);
        expect(barrel.validateParserResult).to.be.a('function');
        expect(barrel.validateParserSegment).to.be.a('function');
        expect(barrel.assertValidParserResult).to.be.a('function');
        expect(barrel.validateLanguageResult).to.be.a('function');
        expect(barrel.isValidStructureDetectorPort).to.be.a('function');
        expect(barrel.assertStructureDetectorPort).to.be.a('function');
        // Legacy projection
        expect(barrel.offsetToLine).to.be.a('function');
        expect(barrel.segmentToLegacyChapter).to.be.a('function');
        expect(barrel.mapToLegacyChapters).to.be.a('function');
        // Language detection
        expect(barrel.detectLanguageWithConfidence).to.be.a('function');
    });

    it('index.js barrel is idempotent with individual module exports', () => {
        const barrel = require(path.join(PACKAGE_SRC, 'index'));
        const parser = require(path.join(PACKAGE_SRC, 'lazy-book', 'parser'));
        const contracts = require(path.join(PACKAGE_SRC, 'contracts', 'parser-contract'));
        const legacy = require(path.join(PACKAGE_SRC, 'contracts', 'legacy-projection'));
        const lang = require(path.join(PACKAGE_SRC, 'language-detector'));

        expect(barrel.splitIntoChapters).to.equal(parser.splitIntoChapters);
        expect(barrel.PARSER_CONTRACT_VERSION).to.equal(contracts.PARSER_CONTRACT_VERSION);
        expect(barrel.offsetToLine).to.equal(legacy.offsetToLine);
        expect(barrel.detectLanguageWithConfidence).to.equal(lang.detectLanguageWithConfidence);
    });
});

// ── Guard 9: Parser Core works without PostgreSQL/Redis ─────────────────────
describe('Parser Core isolation: no PostgreSQL or Redis dependency', () => {
    it('no Parser Core file imports pg, ioredis, or any database client', () => {
        const offenders = [];
        for (const filePath of PARSER_CORE_FILES) {
            const src = readSource(filePath);
            const specs = requireSpecifiers(src);
            for (const spec of specs) {
                if (/^(pg|ioredis|mongoose|mongodb|redis)/.test(spec)) {
                    offenders.push(`${rel(filePath)}: ${spec}`);
                }
            }
        }
        expect(offenders, `Parser Core must not depend on database clients: ${offenders.join('; ')}`).to.deep.equal([]);
    });
});

// ── Guard 10: Parser Core works without AI pipeline ────────────────────────
describe('Parser Core isolation: no AI pipeline dependency', () => {
    it('no Parser Core file imports openai, anthropic, or agent modules', () => {
        const offenders = [];
        for (const filePath of PARSER_CORE_FILES) {
            const src = readSource(filePath);
            const specs = requireSpecifiers(src);
            for (const spec of specs) {
                if (/openai|anthropic|agent|pipeline|llm/i.test(spec)) {
                    offenders.push(`${rel(filePath)}: ${spec}`);
                }
            }
        }
        expect(offenders, `Parser Core must not depend on AI pipeline: ${offenders.join('; ')}`).to.deep.equal([]);
    });
});

// ── Guard 11: Parser Core works without Importer ───────────────────────────
describe('Parser Core isolation: no Importer dependency', () => {
    it('no Parser Core file imports txt-importer or Importer modules', () => {
        const offenders = [];
        for (const filePath of PARSER_CORE_FILES) {
            const src = readSource(filePath);
            const specs = requireSpecifiers(src);
            for (const spec of specs) {
                if (/txt-importer|importer/i.test(spec)) {
                    offenders.push(`${rel(filePath)}: ${spec}`);
                }
            }
        }
        expect(offenders, `Parser Core must not depend on Importer: ${offenders.join('; ')}`).to.deep.equal([]);
    });
});

// ── Guard 12: Parser Core works without Book Writer ────────────────────────
describe('Parser Core isolation: no Book Writer dependency', () => {
    it('no Parser Core file imports draft, parse.js, or Book Writer modules', () => {
        const offenders = [];
        for (const filePath of PARSER_CORE_FILES) {
            const src = readSource(filePath);
            const specs = requireSpecifiers(src);
            for (const spec of specs) {
                if (/draft|parse\.js|book-writer|lazyParse/i.test(spec)) {
                    offenders.push(`${rel(filePath)}: ${spec}`);
                }
            }
        }
        expect(offenders, `Parser Core must not depend on Book Writer: ${offenders.join('; ')}`).to.deep.equal([]);
    });
});
