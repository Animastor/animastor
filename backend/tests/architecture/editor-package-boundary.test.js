// ======================================================
// EDITOR PACKAGE BOUNDARY — @animastor/editor guards
// (Phase 4.1 — NPM publication readiness)
// ======================================================
// The Editor is physically extracted to packages/animastor-editor
// (@animastor/editor — Phase 4). Phase 4.1 closes the package boundary for
// NPM publication: the host consumes the package ONLY through its root
// entrypoint; every internal file becomes unreachable from the host.
// Docs: docs/architecture/editor-module-extraction-audit.md §Phase 4.1.
//
//   PB1 — Deep-import guard: no host source file (backend/src/**) contains
//         a deep import of the package ("@animastor/editor/...", a path
//         into packages/animastor-editor/src, or a relative path reaching
//         the package directory). The package root require is the ONLY
//         sanctioned specifier.
//   PB2 — Export map freeze: package.json exports == { ".": "./src/index.cjs" }
//         (root-only, closed map — no subpaths, no "./package.json");
//         files list carries no tests/dev artifacts; the frozen dependency
//         set is exactly @animastor/vbook-runtime; the manifest is
//         publish-complete (name/version/description/keywords/repository/
//         homepage/bugs/license/engines/files/main/exports).
//   PB3 — Public API surface: require('@animastor/editor') resolves and
//         exposes EXACTLY the four public factories — createEditorModel,
//         createEditorRoutes, createEntityCrudRoutes, createEditorPorts —
//         nothing more. The frozen 7-port seam factory is public; internal
//         helpers (scene-patch-utils, read-recovery, entity-id,
//         cyr-latin-map) are NOT.
//   PB4 — No reverse imports: no package source file requires the host
//         backend or any other @animastor package; the require closure of
//         the package (registrars + helpers + facade + ports + entrypoint)
//         reaches only intra-package files, node builtins and
//         @animastor/vbook-runtime (the declared dependency).
//   PB5 — cyr-latin-map twin parity: the host image domain consumes a
//         HOST-LOCAL byte-parity twin (backend/src/utils/cyr-latin-map.js)
//         of the package's canonical pure module — the body below the
//         canonical-source marker is byte-identical to the package file.
//         Not a second implementation: a generated leg, guarded like the
//         worker's job-protocol-v2.cjs copy (Phase 9D playbook).
//
// Static checks follow the Phase 1 helpers (pure source scan, CI-safe).

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { builtinModules } = require('module');
const {
    REPO_ROOT, BACKEND_SRC, listSourceFiles, readSource, rel, requireSpecifiers,
} = require('./helpers');

const PACKAGE_DIR = path.join(REPO_ROOT, 'packages', 'animastor-editor');
const PACKAGE_SRC = path.join(PACKAGE_DIR, 'src');
const PACKAGE_ENTRY = path.join(PACKAGE_SRC, 'index.cjs');

/** Strip comments so doc mentions are not edges (same shape as E-guards). */
function codeOf(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/\s\/\/.*$/, ''))
        .filter((line) => !/^\s*\/\//.test(line))
        .join('\n');
}

// ── PB1 — deep-import guard (host → package root ONLY) ───────────────────
describe('PB1: the host never deep-imports the editor package', () => {
    // Sanctioned: the bare package root specifier, nothing else.
    const DEEP_EDITOR_RE = /require\(\s*['"]@animastor\/editor\/[^'"]*['"]\s*\)/;
    const SRC_PATH_RE = /require\(\s*['"][^'"]*packages\/animastor-editor\/src\/[^'"]*['"]\s*\)/;
    const REL_ESCAPE_RE = /require\(\s*['"]\.\.[^'"]*animastor-editor[^'"]*['"]\s*\)/;

    it('no backend/src file deep-imports @animastor/editor (package root only)', () => {
        const offenders = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            const code = codeOf(readSource(file));
            if (DEEP_EDITOR_RE.test(code) || SRC_PATH_RE.test(code) || REL_ESCAPE_RE.test(code)) {
                offenders.push(rel(file));
            }
        }
        expect(offenders, 'host must consume @animastor/editor through the package root only')
            .to.deep.equal([]);
    });

    it('no host file reaches the package src/ by a relative path either', () => {
        const offenders = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            const code = codeOf(readSource(file));
            if (/require\(\s*['"][^'"]*animastor-editor[^'"]*['"]\s*\)/.test(code)) {
                offenders.push(rel(file));
            }
        }
        expect(offenders).to.deep.equal([]);
    });
});

// ── PB2 — export map + manifest freeze ───────────────────────────────────
describe('PB2: the package manifest is publish-ready and boundary-closed', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));

    it('the export map is exactly the package root', () => {
        expect(pkg.exports).to.deep.equal({ '.': './src/index.cjs' });
    });

    it('the manifest is publish-complete', () => {
        expect(pkg.name).to.equal('@animastor/editor');
        expect(pkg.version).to.match(/^\d+\.\d+\.\d+$/);
        expect(pkg.description).to.be.a('string').with.length.above(10);
        expect(Array.isArray(pkg.keywords) && pkg.keywords.length > 0).to.equal(true);
        expect(pkg.license).to.equal('MIT');
        expect(pkg.repository && pkg.repository.url).to.include('animastor');
        expect(pkg.homepage).to.be.a('string');
        expect(pkg.bugs && pkg.bugs.url).to.be.a('string');
        expect(pkg.engines && pkg.engines.node).to.be.a('string');
        expect(pkg.main).to.equal('src/index.cjs');
        expect(pkg.files).to.deep.equal(['src/', 'README.md', 'LICENSE']);
        expect(pkg.scripts && pkg.scripts.test).to.match(/mocha/);
    });

    it('the frozen dependency set is exactly @animastor/vbook-runtime', () => {
        expect(Object.keys(pkg.dependencies)).to.deep.equal(['@animastor/vbook-runtime']);
    });
});

// ── PB3 — public API surface (root entrypoint) ───────────────────────────
describe('PB3: the package root exposes exactly the public API', () => {
    const api = require(PACKAGE_ENTRY);
    const PUBLIC_API = [
        'createEditorModel',
        'createEditorRoutes',
        'createEntityCrudRoutes',
        'createEditorPorts',
    ].sort();

    it('exports exactly the four public factories (nothing more)', () => {
        expect(Object.keys(api).sort()).to.deep.equal(PUBLIC_API);
    });

    it('every export is a function', () => {
        for (const key of PUBLIC_API) {
            expect(api[key], `${key} must be a function`).to.be.a('function');
        }
    });

    it('the ports factory is the frozen 7-port seam (no expansion)', () => {
        const ports = api.createEditorPorts({
            deps: {
                sceneAssetsRepo: {}, placeholderAudio: {}, auditCoverage: {},
                promptLimit: 2000, purge: {}, resolveOwnership: {}, recoveryCtx: {},
            },
        });
        expect(Object.keys(ports).sort()).to.deep.equal([
            'sceneAssetsRepo', 'placeholderAudio', 'auditCoverage', 'promptLimit',
            'purge', 'resolveOwnership', 'recoveryCtx',
        ].sort());
    });
});

// ── PB4 — package closure (no reverse imports, no cycles) ────────────────
describe('PB4: the package require closure stays self-contained', () => {
    const DECLARED_EXTERNALS = new Set(['@animastor/vbook-runtime', '@animastor/vbook-runtime/']);

    function walk(startFiles) {
        const edges = [];
        const visited = new Set();
        const queue = [...startFiles];
        while (queue.length > 0) {
            const file = queue.shift();
            const key = path.resolve(file);
            if (visited.has(key)) continue;
            visited.add(key);
            for (const spec of requireSpecifiers(codeOf(readSource(file)))) {
                if (builtinModules.includes(spec) || builtinModules.includes(spec.split('/')[0])) continue;
                if (!spec.startsWith('.')) {
                    // bare specifiers: only the declared dependency is allowed
                    if (DECLARED_EXTERNALS.has(spec) || spec.startsWith('@animastor/vbook-runtime/')) continue;
                    edges.push(`${rel(file)}: ${spec} (undeclared external)`);
                    continue;
                }
                const base = path.resolve(path.dirname(file), spec);
                const candidates = [base, base + '.js', base + '.cjs', path.join(base, 'index.js'), path.join(base, 'index.cjs')];
                const resolved = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
                if (!resolved) { edges.push(`${rel(file)}: ${spec} (unresolved)`); continue; }
                if (resolved.startsWith(PACKAGE_DIR + path.sep)) { queue.push(resolved); continue; }
                edges.push(`${rel(file)} → ${rel(resolved)} (host module)`);
            }
        }
        return edges;
    }

    it('the whole package (entrypoint included) reaches only intra-package files + the declared dep', () => {
        const edges = walk([PACKAGE_ENTRY]);
        expect(edges, 'editor package closure must stay self-contained (editorPorts is the only host seam)')
            .to.deep.equal([]);
    });

    it('the package require graph has no cycles', () => {
        // DFS with a gray set: any back edge is a cycle.
        const graph = new Map();
        for (const file of listSourceFiles(PACKAGE_SRC)) {
            const specs = [];
            for (const spec of requireSpecifiers(codeOf(readSource(file)))) {
                if (!spec.startsWith('.')) continue;
                const base = path.resolve(path.dirname(file), spec);
                const candidates = [base, base + '.js', base + '.cjs', path.join(base, 'index.js'), path.join(base, 'index.cjs')];
                const resolved = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
                if (resolved && resolved.startsWith(PACKAGE_DIR + path.sep)) specs.push(resolved);
            }
            graph.set(path.resolve(file), specs);
        }
        const WHITE = 0, GRAY = 1, BLACK = 2;
        const color = new Map();
        let cyclic = false;
        const visit = (node) => {
            if (cyclic) return;
            color.set(node, GRAY);
            for (const next of graph.get(node) || []) {
                const c = color.get(next) || WHITE;
                if (c === GRAY) { cyclic = true; return; }
                if (c === WHITE) visit(next);
            }
            color.set(node, BLACK);
        };
        for (const node of graph.keys()) {
            if ((color.get(node) || WHITE) === WHITE) visit(node);
            if (cyclic) break;
        }
        expect(cyclic, 'editor package must not gain require cycles').to.equal(false);
    });

    it('no package file requires the backend host or any other @animastor package', () => {
        const offenders = [];
        for (const file of listSourceFiles(PACKAGE_SRC)) {
            for (const spec of requireSpecifiers(codeOf(readSource(file)))) {
                if (/backend|@animastor\/(player|contracts|parser|worker|gpu-hub)/.test(spec)) {
                    offenders.push(`${rel(file)}: ${spec}`);
                }
            }
        }
        expect(offenders).to.deep.equal([]);
    });
});

// ── PB5 — cyr-latin-map host twin parity ─────────────────────────────────
describe('PB5: the host cyr-latin-map is a byte-parity twin of the package source', () => {
    const HOST_TWIN = path.join(BACKEND_SRC, 'utils', 'cyr-latin-map.js');
    const PACKAGE_SOURCE = path.join(PACKAGE_SRC, 'cyr-latin-map.js');
    const MARKER = '// ===8<=== canonical source (verbatim, do not edit) ====================';

    function canonicalBody(file) {
        const src = readSource(file);
        const idx = src.indexOf(MARKER);
        if (idx === -1) return null;
        let body = src.slice(idx + MARKER.length);
        if (body.startsWith('\n')) body = body.slice(1);
        const endIdx = body.indexOf('// ===8<=== end canonical source');
        if (endIdx !== -1) body = body.slice(0, endIdx);
        return body;
    }

    it('the host twin exists and carries the generated-file marker', () => {
        expect(fs.existsSync(HOST_TWIN)).to.equal(true);
        expect(readSource(HOST_TWIN)).to.include(MARKER);
    });

    it('the twin body is byte-identical to the package canonical source', () => {
        const twinBody = canonicalBody(HOST_TWIN);
        const packageBody = readSource(PACKAGE_SOURCE);
        expect(twinBody, 'twin marker missing').to.not.equal(null);
        expect(twinBody).to.equal(packageBody);
    });

    it('both modules export the same surface (CYR_LATIN_MAP + cyrToLatin) with equal output', () => {
        const host = require(HOST_TWIN);
        const pkgSrc = require(PACKAGE_SOURCE);
        expect(Object.keys(host).sort()).to.deep.equal(Object.keys(pkgSrc).sort());
        expect(host.cyrToLatin('Привет, Михаил!')).to.equal(pkgSrc.cyrToLatin('Привет, Михаил!'));
        expect(host.CYR_LATIN_MAP['Ж']).to.equal(pkgSrc.CYR_LATIN_MAP['Ж']);
    });

    it('the twin has zero requires (pure data + pure function)', () => {
        expect(requireSpecifiers(codeOf(readSource(HOST_TWIN)))).to.deep.equal([]);
    });
});
