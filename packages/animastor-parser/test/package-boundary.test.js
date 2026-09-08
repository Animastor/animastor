// ======================================================
// @animastor/parser — package boundary guards
// ======================================================
// Proves the package has ZERO coupling to VBook runtime, host services,
// databases, AI pipeline, Book Writer, or Importer.
const { expect } = require('chai');
const path = require('path');
const fs = require('fs');

const PKG_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(PKG_DIR, 'src');

function listSourceFiles(rootDir) {
    const out = [];
    if (!fs.existsSync(rootDir)) return out;
    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (['.js', '.cjs'].includes(path.extname(entry.name))) out.push(full);
        }
    })(rootDir);
    return out;
}

function readSource(filePath) {
    return fs.readFileSync(filePath, 'utf8');
}

function rel(filePath) {
    return path.relative(path.join(__dirname, '..', '..', '..'), filePath).split(path.sep).join('/');
}

const REQUIRE_RE = /require\(\s*(['"])([^'"]+)\1\s*\)|from\s+(['"])([^'"]+)\3/g;
function requireSpecifiers(source) {
    const specs = [];
    let m;
    while ((m = REQUIRE_RE.exec(source)) !== null) {
        specs.push(m[2] || m[4]);
    }
    return specs;
}

// ── Forbidden imports ────────────────────────────────────────────────────────
const FORBIDDEN_PATTERNS = [
    { pattern: /require\(\s*['"]pg['"]\)/, label: 'PostgreSQL' },
    { pattern: /require\(\s*['"]ioredis['"]\)/, label: 'Redis' },
    { pattern: /require\(\s*['"]mongoose['"]\)/, label: 'MongoDB' },
    { pattern: /require\(\s*['"]fs['"]\)/, label: 'fs (filesystem)' },
    { pattern: /require\(\s*['"]path['"]\)/, label: 'path' },
    { pattern: /require\(\s*['"][^'"]*structure-detector[^'"]*['"]\)/, label: 'structure-detector' },
    { pattern: /require\(\s*['"][^'"]*txt-importer[^'"]*['"]\)/, label: 'txt-importer' },
    { pattern: /require\(\s*['"][^'"]*book-deletion[^'"]*['"]\)/, label: 'book-deletion' },
    { pattern: /require\(\s*['"][^'"]*runtime-config[^'"]*['"]\)/, label: 'runtime-config' },
    { pattern: /require\(\s*['"][^'"]*openai[^'"]*['"]\)/, label: 'openai' },
    { pattern: /require\(\s*['"][^'"]*anthropic[^'"]*['"]\)/, label: 'anthropic' },
    { pattern: /require\(\s*['"][^'"]*draft[^'"]*['"]\)/, label: 'draft/persistence' },
    { pattern: /require\(\s*['"][^'"]*vbook-runtime[^'"]*['"]\)/, label: '@animastor/vbook-runtime' },
];

const ALLOWED_EXTERNALS = new Set(['tinyld']);

// ── Guard 1: no forbidden imports in any source file ─────────────────────────
describe('@animastor/parser boundary: no forbidden imports', () => {
    const srcFiles = listSourceFiles(SRC_DIR);
    for (const filePath of srcFiles) {
        const relPath = rel(filePath);
        it(`${relPath}: no host-side imports`, () => {
            const src = readSource(filePath);
            const violations = [];
            for (const { pattern, label } of FORBIDDEN_PATTERNS) {
                if (pattern.test(src)) violations.push(label);
            }
            expect(violations, `${relPath} must not import: ${violations.join(', ')}`).to.deep.equal([]);
        });
    }
});

// ── Guard 2: require graph stays within package or allowed externals ──────────
describe('@animastor/parser boundary: require graph isolation', () => {
    const srcFiles = listSourceFiles(SRC_DIR);
    for (const filePath of srcFiles) {
        const relPath = rel(filePath);
        it(`${relPath}: all requires resolve inside the package or are allowed externals`, () => {
            const src = readSource(filePath);
            const specs = requireSpecifiers(src);
            const offenders = [];
            for (const spec of specs) {
                if (spec.startsWith('.')) {
                    const base = path.resolve(path.dirname(filePath), spec);
                    const candidates = [base, base + '.js', base + '.cjs', path.join(base, 'index.js')];
                    const resolved = candidates.find(c => fs.existsSync(c) && fs.statSync(c).isFile());
                    const targetRel = resolved ? rel(resolved) : null;
                    const inside = targetRel && targetRel.startsWith('packages/animastor-parser/src/');
                    if (!inside) offenders.push(`${spec} → ${targetRel || 'NOT FOUND'}`);
                    continue;
                }
                if (ALLOWED_EXTERNALS.has(spec)) continue;
                offenders.push(`${spec} (bare specifier, not in allowlist)`);
            }
            expect(offenders, `${relPath} has cross-boundary requires`).to.deep.equal([]);
        });
    }
});

// ── Guard 3: zero dependencies on @animastor/vbook-runtime ───────────────────
describe('@animastor/parser boundary: no reverse dependency on vbook-runtime', () => {
    it('package.json does not declare @animastor/vbook-runtime', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
        expect(pkg.dependencies || {}).to.not.have.property('@animastor/vbook-runtime');
        expect(pkg.devDependencies || {}).to.not.have.property('@animastor/vbook-runtime');
    });

    it('no source file requires @animastor/vbook-runtime', () => {
        const srcFiles = listSourceFiles(SRC_DIR);
        const offenders = [];
        for (const filePath of srcFiles) {
            const src = readSource(filePath);
            const specs = requireSpecifiers(src);
            for (const spec of specs) {
                if (/vbook-runtime/.test(spec)) offenders.push(`${rel(filePath)}: ${spec}`);
            }
        }
        expect(offenders, `Parser must not depend on VBook runtime: ${offenders.join('; ')}`).to.deep.equal([]);
    });
});

// ── Guard 4: only tinyld as external dependency ──────────────────────────────
describe('@animastor/parser boundary: dependency surface', () => {
    it('package.json declares exactly tinyld', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
        expect(Object.keys(pkg.dependencies || {}).sort()).to.deep.equal(['tinyld']);
    });
});

// ── Guard 5: parser-contract.js is pure (zero requires) ─────────────────────
describe('@animastor/parser purity: parser-contract.js', () => {
    it('has zero requires', () => {
        const src = readSource(path.join(SRC_DIR, 'contracts', 'parser-contract.js'));
        expect(requireSpecifiers(src)).to.deep.equal([]);
    });
});

// ── Guard 6: legacy-projection.js is pure (zero requires) ───────────────────
describe('@animastor/parser purity: legacy-projection.js', () => {
    it('has zero requires', () => {
        const src = readSource(path.join(SRC_DIR, 'contracts', 'legacy-projection.js'));
        expect(requireSpecifiers(src)).to.deep.equal([]);
    });
});

// ── Guard 7: language-detector.js depends only on tinyld ────────────────────
describe('@animastor parser purity: language-detector.js', () => {
    it('depends only on tinyld', () => {
        const src = readSource(path.join(SRC_DIR, 'language-detector.js'));
        expect(requireSpecifiers(src)).to.deep.equal(['tinyld']);
    });
});

// ── Guard 8: no AI pipeline imports ─────────────────────────────────────────
describe('@animastor/parser boundary: no AI pipeline', () => {
    it('no openai/anthropic/agent/pipeline imports', () => {
        const srcFiles = listSourceFiles(SRC_DIR);
        const offenders = [];
        for (const filePath of srcFiles) {
            const src = readSource(filePath);
            const specs = requireSpecifiers(src);
            for (const spec of specs) {
                if (/openai|anthropic|agent|pipeline|llm/i.test(spec)) {
                    offenders.push(`${rel(filePath)}: ${spec}`);
                }
            }
        }
        expect(offenders).to.deep.equal([]);
    });
});

// ── Guard 9: no Importer imports ────────────────────────────────────────────
describe('@animastor/parser boundary: no Importer', () => {
    it('no txt-importer imports', () => {
        const srcFiles = listSourceFiles(SRC_DIR);
        const offenders = [];
        for (const filePath of srcFiles) {
            const src = readSource(filePath);
            const specs = requireSpecifiers(src);
            for (const spec of specs) {
                if (/txt-importer|importer/i.test(spec)) {
                    offenders.push(`${rel(filePath)}: ${spec}`);
                }
            }
        }
        expect(offenders).to.deep.equal([]);
    });
});

// ── Guard 10: no Book Writer imports ────────────────────────────────────────
describe('@animastor/parser boundary: no Book Writer', () => {
    it('no draft/parse.js/book-writer imports', () => {
        const srcFiles = listSourceFiles(SRC_DIR);
        const offenders = [];
        for (const filePath of srcFiles) {
            const src = readSource(filePath);
            const specs = requireSpecifiers(src);
            for (const spec of specs) {
                if (/draft|parse\.js|book-writer|lazyParse/i.test(spec)) {
                    offenders.push(`${rel(filePath)}: ${spec}`);
                }
            }
        }
        expect(offenders).to.deep.equal([]);
    });
});
