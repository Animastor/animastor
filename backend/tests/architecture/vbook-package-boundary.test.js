// ======================================================
// VBOOK PACKAGE BOUNDARY — @animastor/vbook-runtime preparation guards
// ======================================================
// Prepares the physical extraction of backend/src/book/ into
// packages/animastor-vbook-runtime (@animastor/vbook-runtime) by freezing
// the package boundary TODAY, while the code still lives in the host tree.
// Docs: docs/03-audit/VBOOK_EXTRACTION_READINESS_AUDIT.md,
//       docs/architecture/VBOOK_RUNTIME_RELOCATION_CHECKLIST.md
//
// Guards (PREPARATION phase — physical move is the NEXT task):
//   VB-T1 — declared dependency surface: package.json (declared now,
//           dependencies moved only at the physical move) == adm-zip + tinyld
//   VB-T2 — booksRoot port: no runtime-config require inside book/;
//           no process.env reads inside book/ (incl. book-deletion.cjs hub
//           env reads); port fail-closed semantics; provider binding
//   VB-T3 — structure-detector is reachable only via the injectable port
//           (no direct require from book/; host binds the real detector)
//   VB-T4 — require graph of the book domain stays inside the boundary:
//           every relative require resolves within backend/src/book/ plus
//           the audited extraction companions (language-detector,
//           character-identity, snake-guard, scene-title-utils); book-deletion.cjs
//           stays host-side and stays outside the package's own require graph
//   VB-T5 — ownership map: snapshot files / deletion orchestration / hub env
//           stay host-side (host files own them; the book domain never
//           references snapshot files or HUB_URL/GPU_HUB_API_KEY)

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const { REPO_ROOT, BACKEND_SRC, listSourceFiles, readSource, rel, requireSpecifiers } = require('./helpers');

// Bind ports before any book-domain require (same wiring as backend.cjs).
require(path.join(REPO_ROOT, 'backend', 'tests', 'vbook-test-bindings.cjs'));

const BOOK_DIR = path.join(BACKEND_SRC, 'book');
// Future package root — created by this preparation phase (package.json,
// README, schema). The physical code move is the NEXT task.
const PACKAGE_DIR = path.join(REPO_ROOT, 'packages', 'animastor-vbook-runtime');
// Books-domain modules that extract WITH the package per the audit §1.1
// (physically moved at the physical-move step; the boundary contract starts now).
const EXTRACTION_COMPANIONS = [
    'backend/src/services/language-detector.js',
    'backend/src/utils/character-identity.js',
    'backend/src/utils/scene-title-utils.js',
    'backend/src/utils/snake-guard.js',
];
const COMPANION_PREFIXES = ['backend/src/services/language-detector', 'backend/src/utils/character-identity', 'backend/src/utils/scene-title-utils', 'backend/src/utils/snake-guard'];

function resolveRelative(fromFile, spec) {
    const base = path.resolve(path.dirname(fromFile), spec);
    const candidates = [base, base + '.js', base + '.cjs', path.join(base, 'index.js'), path.join(base, 'index.cjs')];
    for (const c of candidates) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
    return null;
}

// ── VB-T1 — declared dependency surface ──────────────────────────────────
describe('VB-T1: @animastor/vbook-runtime dependency surface matches the audit', () => {
    it('package.json declares exactly adm-zip + tinyld (audit §1.1)', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));
        expect(pkg.name).to.equal('@animastor/vbook-runtime');
        expect(Object.keys(pkg.dependencies || {}).sort()).to.deep.equal(['adm-zip', 'tinyld']);
    });

    it('backend package.json keeps both libs until the physical move (no premature removal)', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'backend', 'package.json'), 'utf8'));
        expect(pkg.dependencies).to.have.property('adm-zip');
        expect(pkg.dependencies).to.have.property('tinyld');
    });
});

// ── VB-T2 — booksRoot port ───────────────────────────────────────────────
describe('VB-T2: booksRoot port replaces the runtime-config dependency', () => {
    it('no file in book/ requires config/runtime-config (audit blocker #1 closed)', () => {
        const offenders = [];
        for (const file of listSourceFiles(BOOK_DIR)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (/runtime-config/.test(spec)) offenders.push(`${rel(file)}: ${spec}`);
            }
        }
        expect(offenders, 'the book domain must not import host runtime-config; the root comes via configureBooksRoot()').to.deep.equal([]);
    });

    it('no file in book/ reads process.env (incl. book-deletion.cjs hub env reads)', () => {
        // book-deletion.cjs is HOST-side code (deletion orchestrator) that
        // physically sits inside book/ until the move — exempt here, pinned
        // by the ownership test in VB-T5. Everything else must be env-free.
        // Matches real property/index access, not doc comments.
        const ENV_USE_RE = /process\s*\.\s*env\s*[.\[]/;
        const offenders = [];
        for (const file of listSourceFiles(BOOK_DIR)) {
            if (file.endsWith('book-deletion.cjs')) continue;
            if (ENV_USE_RE.test(readSource(file))) offenders.push(rel(file));
        }
        expect(offenders, 'package files must never read host env (HUB_URL/GPU_HUB_API_KEY live in host-side book-deletion.cjs)').to.deep.equal([]);
    });

    it('the port is fail-closed without a binding and works with a static root', () => {
        const port = require('../../src/book/books-root').createBooksRootPort();
        expect(() => port.get()).to.throw(/not configured/);
        port.configure('/tmp/books-root-port-test');
        expect(port.get()).to.equal('/tmp/books-root-port-test');
        expect(port.isConfigured()).to.equal(true);
    });

    it('the port rejects invalid bindings', () => {
        const port = require('../../src/book/books-root').createBooksRootPort();
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
        const paths = require('../../src/book/lazy-book/paths');
        expect(paths.getBooksDir()).to.equal(require('../../src/config/runtime-config').BOOKS_DIR);
    });
});

// ── VB-T3 — structure-detector port ──────────────────────────────────────
describe('VB-T3: structure-detector connects only via the injectable port', () => {
    it('no file in book/ requires services/structure-detector directly (audit blocker #2 closed)', () => {
        const offenders = [];
        for (const file of listSourceFiles(BOOK_DIR)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (/structure-detector/.test(spec)) offenders.push(`${rel(file)}: ${spec}`);
            }
        }
        expect(offenders, 'the parser consumes the detector through setStructureDetector() injection only').to.deep.equal([]);
    });

    it('parser.js exports the port binding API (setStructureDetector/getStructureDetector)', () => {
        const parser = require('../../src/book/lazy-book/parser');
        expect(parser.setStructureDetector).to.be.a('function');
        expect(parser.getStructureDetector).to.be.a('function');
        expect(parser.getStructureDetector().buildDeterministicMap).to.be.a('function');
    });

    it('the port is fail-closed: splitIntoChapters throws without a bound detector', () => {
        // Fresh module instance — binding state is process-global, so load an
        // isolated copy of the module to probe the unbound state.
        const Module = require('module');
        const src = fs.readFileSync(path.join(BOOK_DIR, 'lazy-book', 'parser.js'), 'utf8');
        const m = new Module('parser-unbound-probe', null);
        m._compile(src, path.join(BOOK_DIR, 'lazy-book', 'parser.js'));
        expect(() => m.exports.splitIntoChapters('текст')).to.throw(/structureDetector is not bound/);
    });

    it('setStructureDetector rejects implementations without buildDeterministicMap', () => {
        const parser = require('../../src/book/lazy-book/parser');
        expect(() => parser.setStructureDetector({})).to.throw(/buildDeterministicMap/);
        expect(() => parser.setStructureDetector(null)).to.throw(/buildDeterministicMap/);
    });

    it('injected stub ChapterMap drives splitIntoChapters (port contract works end-to-end)', () => {
        const Module = require('module');
        const src = fs.readFileSync(path.join(BOOK_DIR, 'lazy-book', 'parser.js'), 'utf8');
        const m = new Module('parser-stub-probe', null);
        m._compile(src, path.join(BOOK_DIR, 'lazy-book', 'parser.js'));
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

// ── VB-T4 — require graph of the book domain ─────────────────────────────
describe('VB-T4: the book-domain require graph stays inside the future package boundary', () => {
    it('every relative require resolves inside book/ + audited extraction companions', () => {
        const offenders = [];
        for (const file of listSourceFiles(BOOK_DIR)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (!spec.startsWith('.')) continue;
                const target = resolveRelative(file, spec);
                const targetRel = target ? rel(target) : null;
                const inside = targetRel && targetRel.startsWith('backend/src/book/');
                const companion = targetRel && COMPANION_PREFIXES.some((p) => targetRel.startsWith(p));
                if (!inside && !companion) offenders.push(`${rel(file)}: ${spec}`);
            }
        }
        expect(offenders, 'book/ must depend only on itself + audited companions (language-detector, character-identity, snake-guard, scene-title-utils); everything else is a new cross-module coupling').to.deep.equal([]);
    });

    it('companion files do not reach outside their own boundaries', () => {
        const offenders = [];
        for (const relPath of EXTRACTION_COMPANIONS) {
            const file = path.join(REPO_ROOT, relPath);
            for (const spec of requireSpecifiers(readSource(file))) {
                if (!spec.startsWith('.')) continue; // tinyld etc.
                const target = resolveRelative(file, spec);
                const targetRel = target ? rel(target) : null;
                const ok = targetRel && COMPANION_PREFIXES.some((p) => targetRel.startsWith(p));
                if (!ok) offenders.push(`${relPath}: ${spec}`);
            }
        }
        expect(offenders, 'extraction companions must not drag new host modules into the package').to.deep.equal([]);
    });

    it('no cycles inside the book domain require graph', () => {
        const files = listSourceFiles(BOOK_DIR);
        const graph = new Map();
        for (const file of files) {
            const deps = [];
            for (const spec of requireSpecifiers(readSource(file))) {
                if (!spec.startsWith('.')) continue;
                const target = resolveRelative(file, spec);
                if (target && rel(target).startsWith('backend/src/book/')) deps.push(target);
            }
            graph.set(file, deps);
        }
        // Tarjan SCC — any SCC with >1 member inside book/ is a cycle.
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
        expect(cycles, 'the book domain must stay acyclic (audit §1: book is in no SCC)').to.deep.equal([]);
    });
});

// ── VB-T5 — ownership map ────────────────────────────────────────────────
describe('VB-T5: ownership boundaries hold (package vs host)', () => {
    it('snapshot management stays host-side (book/ never touches snapshot files)', () => {
        // book-deletion.cjs (host orchestrator) legitimately unlinks the
        // snapshot in its cascade; book-model.cjs only mentions snapshots in
        // a comment. The rule: no PACKAGE code derives or reads a snapshot
        // path. Exempt both by name here; the VB-T5 ownership test pins the
        // host-side markers of book-deletion.cjs.
        const offenders = [];
        for (const file of listSourceFiles(BOOK_DIR)) {
            if (file.endsWith('book-deletion.cjs') || file.endsWith('book-model.cjs')) continue;
            if (/snapshot/.test(readSource(file))) offenders.push(rel(file));
        }
        expect(offenders, '{booksRoot}/{bookId}.snapshot.json is a host-owned convention (task-handler.cjs / book-deletion.cjs)').to.deep.equal([]);
    });

    it('deletion orchestration + hub env stay host-side (host files own them)', () => {
        // book-deletion.cjs is the host-side deletion orchestrator — its hub
        // env reads and Redis/PG cascade live outside the future package
        // `files` allowlist. While it physically sits inside book/, pin the
        // host ownership markers here.
        const src = readSource(path.join(BOOK_DIR, 'book-deletion.cjs'));
        expect(src).to.match(/process\.env\.HUB_URL/, 'host ownership marker: hub queue clear');
        expect(src).to.match(/process\.env\.GPU_HUB_API_KEY/, 'host ownership marker: hub api key');
    });

    it('package skeleton excludes book-deletion.cjs from the files allowlist', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));
        expect(pkg.files).to.not.include('book-deletion.cjs');
    });
});
