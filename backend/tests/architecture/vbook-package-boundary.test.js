// ======================================================
// VBOOK PACKAGE BOUNDARY — @animastor/vbook-runtime guards
// ======================================================
// The VBook runtime is physically extracted to packages/animastor-vbook-runtime
// (relocation checklist §2 COMPLETE). The host keeps one-line re-export shims
// at backend/src/book + the companion legacy paths.
// Docs: docs/03-audit/VBOOK_EXTRACTION_READINESS_AUDIT.md,
//       docs/architecture/VBOOK_RUNTIME_RELOCATION_CHECKLIST.md
//
// Guards (PHYSICAL MOVE phase):
//   VB-T1 — declared dependency surface: package.json == adm-zip + tinyld;
//           backend keeps adm-zip (export routes) but no longer tinyld
//   VB-T2 — booksRoot port: no runtime-config require inside the package;
//           no process.env reads inside the package; port fail-closed
//           semantics; provider binding
//   VB-T3 — structure-detector is reachable only via the injectable port
//           (no direct require from the package; host binds the real detector)
//   VB-T4 — package isolation: every require inside the package resolves
//           within the package except node builtins + adm-zip + tinyld;
//           host shims are the only host→package seam (one-line re-exports);
//           no cycles inside the package require graph
//   VB-T5 — ownership map: snapshot files / deletion orchestration / hub env
//           stay host-side (services/book-deletion.cjs owns them; the package
//           never references snapshot files or HUB_URL/GPU_HUB_API_KEY);
//           book-deletion.cjs is excluded from the package files allowlist

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const { REPO_ROOT, BACKEND_SRC, listSourceFiles, readSource, rel, requireSpecifiers } = require('./helpers');

// Bind ports before any book-domain require (same wiring as backend.cjs).
require(path.join(REPO_ROOT, 'backend', 'tests', 'vbook-test-bindings.cjs'));

const BOOK_DIR = path.join(BACKEND_SRC, 'book');
const PACKAGE_DIR = path.join(REPO_ROOT, 'packages', 'animastor-vbook-runtime');
const PACKAGE_SRC = path.join(PACKAGE_DIR, 'src');
// Host shim files (one-line re-exports) — the sanctioned host→package seam.
const SHIM_PATHS = [
    'backend/src/book/index.js',
    'backend/src/book/book-model.cjs',
    'backend/src/book/bundle-validator.cjs',
    'backend/src/book/books-root.js',
    'backend/src/book/lazy-book/index.js',
    'backend/src/book/lazy-book/parser.js',
    'backend/src/book/lazy-book/paths.js',
    'backend/src/book/lazy-book/constants.js',
    'backend/src/book/lazy-book/draft.js',
    'backend/src/book/lazy-book/parse.js',
    'backend/src/book/lazy-book/create.js',
    'backend/src/book/lazy-book/status.js',
    'backend/src/book/lazy-book/metadata.js',
    'backend/src/book/lazy-book/chapter-utils.js',
    'backend/src/book/lazy-book/appearance.js',
    'backend/src/services/language-detector.js',
    'backend/src/utils/character-identity.js',
    'backend/src/utils/snake-guard.js',
    'backend/src/utils/scene-title-utils.js',
];
const PACKAGE_EXTERNALS = new Set(['adm-zip', 'tinyld']);
const NODE_BUILTIN_RE = /^(assert|async_hooks|buffer|child_process|cluster|console|constants|crypto|dgram|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|timers|tls|trace_events|tty|url|util|v8|vm|worker_threads|zlib)(\/|$)/;

function resolveRelative(fromFile, spec) {
    const base = path.resolve(path.dirname(fromFile), spec);
    const candidates = [base, base + '.js', base + '.cjs', path.join(base, 'index.js'), path.join(base, 'index.cjs')];
    for (const c of candidates) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
    return null;
}

function isShim(file) {
    return SHIM_PATHS.includes(rel(file));
}

// ── VB-T1 — declared dependency surface ──────────────────────────────────
describe('VB-T1: @animastor/vbook-runtime dependency surface matches the audit', () => {
    it('package.json declares exactly adm-zip + tinyld (audit §1.1)', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));
        expect(pkg.name).to.equal('@animastor/vbook-runtime');
        expect(Object.keys(pkg.dependencies || {}).sort()).to.deep.equal(['adm-zip', 'tinyld']);
    });

    it('backend keeps adm-zip (export routes) and no longer declares tinyld', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'backend', 'package.json'), 'utf8'));
        expect(pkg.dependencies).to.have.property('adm-zip');
        expect(pkg.dependencies, 'tinyld moved into the package with language-detector').to.not.have.property('tinyld');
        expect(pkg.dependencies).to.have.property('@animastor/vbook-runtime');
    });

    it('the package resolves standalone (installed/linkable) and exposes its entry points', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));
        expect(pkg.main).to.equal('src/index.js');
        for (const key of Object.keys(pkg.exports || {})) {
            if (key.includes('*')) continue; // wildcard targets — resolved dynamically at runtime
            const target = path.join(PACKAGE_DIR, pkg.exports[key]);
            expect(fs.existsSync(target), `exports target missing: ${key} -> ${pkg.exports[key]}`).to.equal(true);
        }
    });
});

// ── VB-T2 — booksRoot port ───────────────────────────────────────────────
describe('VB-T2: booksRoot port replaces the runtime-config dependency', () => {
    it('no file in the package requires config/runtime-config (audit blocker #1 closed)', () => {
        const offenders = [];
        for (const file of listSourceFiles(PACKAGE_SRC)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (/runtime-config/.test(spec)) offenders.push(`${rel(file)}: ${spec}`);
            }
        }
        expect(offenders, 'the package must not import host runtime-config; the root comes via configureBooksRoot()').to.deep.equal([]);
    });

    it('no file in the package reads process.env', () => {
        // Matches real property/index access, not doc comments.
        const ENV_USE_RE = /process\s*\.\s*env\s*[.\[]/;
        const offenders = [];
        for (const file of listSourceFiles(PACKAGE_SRC)) {
            if (ENV_USE_RE.test(readSource(file))) offenders.push(rel(file));
        }
        expect(offenders, 'package files must never read host env (HUB_URL/GPU_HUB_API_KEY live in host-side book-deletion.cjs)').to.deep.equal([]);
    });

    it('the port is fail-closed without a binding and works with a static root', () => {
        const port = require(path.join(PACKAGE_SRC, 'books-root.js')).createBooksRootPort();
        expect(() => port.get()).to.throw(/not configured/);
        port.configure('/tmp/books-root-port-test');
        expect(port.get()).to.equal('/tmp/books-root-port-test');
        expect(port.isConfigured()).to.equal(true);
    });

    it('the port rejects invalid bindings', () => {
        const port = require(path.join(PACKAGE_SRC, 'books-root.js')).createBooksRootPort();
        expect(() => port.configure('')).to.throw(/non-empty string/);
        expect(() => port.configure(42)).to.throw(/expects a non-empty string or a \(\) => string provider/);
        // Provider bindings validate lazily (per resolve) — a provider may
        // close over config that is not loaded yet at bind time.
        port.configure(() => '');
        expect(() => port.get()).to.throw(/invalid root/);
        port.configure(() => null);
        expect(() => port.get()).to.throw(/invalid root/);
    });

    it('paths.getBooksDir() resolves through the port (live provider)', () => {
        const paths = require(path.join(PACKAGE_SRC, 'lazy-book', 'paths.js'));
        expect(paths.getBooksDir()).to.equal(require('../../src/config/runtime-config').BOOKS_DIR);
    });
});

// ── VB-T3 — structure-detector port ──────────────────────────────────────
describe('VB-T3: structure-detector connects only via the injectable port', () => {
    it('no file in the package requires services/structure-detector directly (audit blocker #2 closed)', () => {
        const offenders = [];
        for (const file of listSourceFiles(PACKAGE_SRC)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (/structure-detector/.test(spec)) offenders.push(`${rel(file)}: ${spec}`);
            }
        }
        expect(offenders, 'the parser consumes the detector through setStructureDetector() injection only').to.deep.equal([]);
    });

    it('parser.js exports the port binding API (setStructureDetector/getStructureDetector)', () => {
        const parser = require(path.join(PACKAGE_SRC, 'lazy-book', 'parser.js'));
        expect(parser.setStructureDetector).to.be.a('function');
        expect(parser.getStructureDetector).to.be.a('function');
        expect(parser.getStructureDetector().buildDeterministicMap).to.be.a('function');
    });

    it('the port is fail-closed: splitIntoChapters throws without a bound detector', () => {
        // Fresh module instance — binding state is process-global, so load an
        // isolated copy of the module to probe the unbound state.
        const Module = require('module');
        const parserPath = path.join(PACKAGE_SRC, 'lazy-book', 'parser.js');
        const src = fs.readFileSync(parserPath, 'utf8');
        const m = new Module('parser-unbound-probe', null);
        m._compile(src, parserPath);
        expect(() => m.exports.splitIntoChapters('текст')).to.throw(/structureDetector is not bound/);
    });

    it('setStructureDetector rejects implementations without buildDeterministicMap', () => {
        const parser = require(path.join(PACKAGE_SRC, 'lazy-book', 'parser.js'));
        expect(() => parser.setStructureDetector({})).to.throw(/buildDeterministicMap/);
        expect(() => parser.setStructureDetector(null)).to.throw(/buildDeterministicMap/);
    });

    it('injected stub ChapterMap drives splitIntoChapters (port contract works end-to-end)', () => {
        const Module = require('module');
        const parserPath = path.join(PACKAGE_SRC, 'lazy-book', 'parser.js');
        const src = fs.readFileSync(parserPath, 'utf8');
        const m = new Module('parser-stub-probe', null);
        m._compile(src, parserPath);
        const text = 'Пролог\n\n' + 'x'.repeat(60) + '\n\nГлава 1\n\n' + 'y'.repeat(60);
        m.exports.setStructureDetector({
            buildDeterministicMap: (t) => ({
                hasPrologue: true, hasEpilogue: false, parts: [],
                segments: [
                    { type: 'prologue', label: 'Пролог', title: 'Пролог', number: null, headerLine: 0, startOffset: 0, endOffset: 10, source: t.slice(0, 10) },
                    { type: 'body', label: null, title: null, number: 1, headerLine: 12, startOffset: 12, endOffset: t.length, source: t.slice(12) },
                ],
            }),
        });
        const chapters = m.exports.splitIntoChapters(text);
        expect(chapters).to.have.lengthOf(2);
        expect(chapters[0]).to.include({ type: 'prologue', label: 'Пролог' });
        expect(chapters[1]).to.include({ type: 'chapter', number: 1 });
        expect(chapters[1].startOffset).to.equal(12);
    });
});

// ── VB-T4 — package isolation ────────────────────────────────────────────
describe('VB-T4: the package require graph is fully isolated', () => {
    it('every package require resolves inside the package or is a builtin/declared dep', () => {
        const offenders = [];
        for (const file of listSourceFiles(PACKAGE_SRC)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (spec.startsWith('.')) {
                    const target = resolveRelative(file, spec);
                    const targetRel = target ? rel(target) : null;
                    const inside = targetRel && targetRel.startsWith('packages/animastor-vbook-runtime/src/');
                    if (!inside) offenders.push(`${rel(file)}: ${spec}`);
                    continue;
                }
                if (NODE_BUILTIN_RE.test(spec)) continue;
                if (PACKAGE_EXTERNALS.has(spec)) continue;
                offenders.push(`${rel(file)}: ${spec}`);
            }
        }
        expect(offenders, 'the package must depend only on node builtins + adm-zip + tinyld (audit §1.1); anything else is a new cross-module coupling').to.deep.equal([]);
    });

    it('host shims are one-line re-exports of the package (no logic migrates back)', () => {
        const offenders = [];
        for (const relPath of SHIM_PATHS) {
            const file = path.join(REPO_ROOT, relPath);
            const src = readSource(file);
            const lines = src.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//')).length;
            if (lines > 1) offenders.push(`${relPath} (${lines} code lines)`);
            const specs = requireSpecifiers(src);
            if (specs.length !== 1 || !specs[0].startsWith('@animastor/vbook-runtime')) {
                offenders.push(`${relPath}: must re-export exactly one @animastor/vbook-runtime specifier`);
            }
        }
        expect(offenders, 'shims must stay one-line re-exports').to.deep.equal([]);
    });

    it('no host file requires into package internals except through shims/entry points', () => {
        const offenders = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            if (isShim(file)) continue;
            for (const spec of requireSpecifiers(readSource(file))) {
                if (!spec.startsWith('.')) continue;
                const target = resolveRelative(file, spec);
                const targetRel = target ? rel(target) : null;
                if (targetRel && targetRel.startsWith('packages/animastor-vbook-runtime/src/')) {
                    offenders.push(`${rel(file)}: ${spec}`);
                }
            }
        }
        expect(offenders, 'host code must reach the package through its entry points/shims, never deep into src/').to.deep.equal([]);
    });

    it('no cycles inside the package require graph', () => {
        const files = listSourceFiles(PACKAGE_SRC);
        const graph = new Map();
        for (const file of files) {
            const deps = [];
            for (const spec of requireSpecifiers(readSource(file))) {
                if (!spec.startsWith('.')) continue;
                const target = resolveRelative(file, spec);
                if (target && rel(target).startsWith('packages/animastor-vbook-runtime/src/')) deps.push(target);
            }
            graph.set(file, deps);
        }
        // Tarjan SCC — any SCC with >1 member inside the package is a cycle.
        const index = new Map(); const low = new Map(); const onStack = new Set();
        const stack = []; const cycles = []; let counter = 0;
        function strong(v) {
            index.set(v, counter); low.set(v, counter); counter++;
            stack.push(v); onStack.add(v);
            for (const w of graph.get(v) || []) {
                if (!index.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
                else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
            }
            if (low.get(v) === index.get(v)) {
                const scc = []; let w;
                do { w = stack.pop(); onStack.delete(w); scc.push(w); } while (w !== v);
                if (scc.length > 1) cycles.push(scc.map(rel).sort());
            }
        }
        for (const f of files) if (!index.has(f)) strong(f);
        expect(cycles, 'the package must stay acyclic (audit §1: book is in no SCC)').to.deep.equal([]);
    });
});

// ── VB-T5 — ownership map ────────────────────────────────────────────────
describe('VB-T5: ownership boundaries hold (package vs host)', () => {
    it('snapshot management stays host-side (the package never touches snapshot files)', () => {
        // services/book-deletion.cjs (host orchestrator) legitimately unlinks
        // the snapshot in its cascade; book-model.cjs only mentions snapshots
        // in a comment. The rule: no PACKAGE code derives or reads a snapshot
        // path.
        const offenders = [];
        for (const file of listSourceFiles(PACKAGE_SRC)) {
            if (file.endsWith('book-model.cjs')) continue;
            if (/snapshot/.test(readSource(file))) offenders.push(rel(file));
        }
        expect(offenders, '{booksRoot}/{bookId}.snapshot.json is a host-owned convention (task-handler.cjs / book-deletion.cjs)').to.deep.equal([]);
    });

    it('deletion orchestration + hub env stay host-side (services/book-deletion.cjs)', () => {
        const src = readSource(path.join(BACKEND_SRC, 'services', 'book-deletion.cjs'));
        expect(src).to.match(/process\.env\.HUB_URL/, 'host ownership marker: hub queue clear');
        expect(src).to.match(/process\.env\.GPU_HUB_API_KEY/, 'host ownership marker: hub api key');
    });

    it('book-deletion.cjs is excluded from the package files allowlist', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));
        expect(JSON.stringify(pkg.files)).to.not.include('book-deletion');
        expect(fs.existsSync(path.join(PACKAGE_SRC, 'book-deletion.cjs')), 'book-deletion.cjs must not live in the package src/').to.equal(false);
    });
});
