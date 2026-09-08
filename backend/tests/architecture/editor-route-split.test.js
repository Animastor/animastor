// ======================================================
// EDITOR CONTOUR — ROUTE-SPLIT BOUNDARY GUARDS (E1–E3)
// ======================================================
// Guards for the Editor HTTP contour after the route split (Phase 1 of
// the Editor extraction, docs/architecture/editor-module-extraction-audit.md
// §13 — the 4d1f6f0e Player-split playbook). The contour lives in
// backend/src/routes/editor/** and is the future packages/animastor-editor.
//
//   E1 — Route surface parity: the contour registrars register EXACTLY the
//        frozen 26-endpoint edit surface (method + path), byte-identical to
//        the pre-split inventory (11 in the old routes/book/core-routes.cjs
//        + 15 in the old routes/book/entity-crud-routes.cjs); no
//        import/generation/player endpoint leaks in.
//   E2 — Require isolation (forward direction): contour REGISTRARS and pure
//        helpers require only intra-contour modules, the host Book Model
//        shim (lazy-book/paths id grammar), utils/entity-id, and node
//        builtins — no PG/storage, no Redis clients, no orchestration, no
//        middleware, no services. The one deliberate exception is
//        editor-ports.cjs itself: it is the composition-root seam whose
//        job is to wire host implementations into the port object (the
//        Player analog: backend.cjs wires playerPorts; here the port
//        assembly lives in a contour file so the future package can carry
//        the shape with it — its require set is frozen separately).
//   E3 — Reverse direction: no host module (generation/AI/import/other
//        contours, packages) requires an Editor contour implementation
//        file by path, and the non-editor book contours contain none of
//        the 26 editor route literals (the edit surface is registered
//        only by the editor contour).
//
// Static checks follow the Phase 1 helpers (pure source scan, CI-safe).
// The E-guards are the audit §12.3 items 1–2 (authored with the split).

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { builtinModules } = require('module');
const {
    BACKEND_SRC, listSourceFiles, readSource, rel, requireSpecifiers, resolveSpecifier, REPO_ROOT,
} = require('./helpers');

const EDITOR_DIR = path.join(BACKEND_SRC, 'routes', 'editor');
const EDITOR_REGISTRARS = [
    path.join(EDITOR_DIR, 'editor-routes.cjs'),
    path.join(EDITOR_DIR, 'entity-crud-routes.cjs'),
];
const EDITOR_PORTS = path.join(EDITOR_DIR, 'editor-ports.cjs');
const BOOK_ROUTES = path.join(BACKEND_SRC, 'routes', 'book-routes.cjs');
const BACKEND_ROOT = path.join(BACKEND_SRC, 'backend.cjs');
// Host contours that must not reach the Editor implementation.
const HOST_CONTOUR_DIRS = [
    path.join(BACKEND_SRC, 'routes'),          // non-editor route files (scan skips routes/editor)
    path.join(BACKEND_SRC, 'services'),
    path.join(BACKEND_SRC, 'orchestration'),
    path.join(BACKEND_SRC, 'runtime'),
    path.join(REPO_ROOT, 'packages', 'animastor-player', 'src'),
];

// ── The frozen edit HTTP surface (pre-split inventory, 26 endpoints) ────
// 11 from the old core-routes.cjs + 15 from the old entity-crud-routes.cjs.
// (The audit's 28-endpoint de-facto contract counts POST /book/:id/snapshot
// in parse-routes.cjs and GET /config in config-routes.cjs — those two stay
// host-side and are NOT registered by this contour.)
const EDITOR_ROUTES = [
    // core-routes.cjs (11)
    ['get', '/api/v1/book/:bookId'],
    ['get', '/api/v1/book/:bookId/source-coverage'],
    ['get', '/api/v1/book/:bookId/cover'],
    ['put', '/api/v1/book/:bookId'],
    ['patch', '/api/v1/book/:bookId/scene/:chapterId/:sceneId'],
    ['patch', '/api/v1/book/:bookId/metadata'],
    ['patch', '/api/v1/book/:bookId/locations/:locationId'],
    ['patch', '/api/v1/book/:bookId/characters/:characterId'],
    ['patch', '/api/v1/book/:bookId/voices/:voiceId'],
    ['patch', '/api/v1/book/:bookId/behaviors/:characterId'],
    ['delete', '/api/v1/book/:bookId'],
    // entity-crud-routes.cjs (15)
    ['post', '/api/v1/book/blank'],
    ['post', '/api/v1/book/:bookId/characters'],
    ['delete', '/api/v1/book/:bookId/characters/:characterId'],
    ['post', '/api/v1/book/:bookId/locations'],
    ['delete', '/api/v1/book/:bookId/locations/:locationId'],
    ['post', '/api/v1/book/:bookId/voices'],
    ['delete', '/api/v1/book/:bookId/voices/:voiceId'],
    ['post', '/api/v1/book/:bookId/behaviors'],
    ['delete', '/api/v1/book/:bookId/behaviors/:characterId'],
    ['post', '/api/v1/book/:bookId/chapters'],
    ['delete', '/api/v1/book/:bookId/chapters/:chapterId'],
    ['post', '/api/v1/book/:bookId/chapters/:chapterId/scenes'],
    ['delete', '/api/v1/book/:bookId/chapters/:chapterId/scenes/:sceneId'],
    ['post', '/api/v1/book/:bookId/chapters/:chapterId/scenes/:sceneId/units'],
    ['delete', '/api/v1/book/:bookId/chapters/:chapterId/scenes/:sceneId/units/:unitId'],
];

// Non-editor surface literals that must never appear in the contour files.
const NON_EDITOR_ROUTE_LITERALS = [
    // import/generation contour
    '/api/v1/generate', '/api/v1/worker/status', '/api/v1/worker/counts',
    // player contour (packages/animastor-player owns these)
    '/api/v1/scene/:bookId/:chapterId/:sceneId/timings',
    '/api/v1/scene/:bookId/:chapterId/:sceneId/waveform',
    '/api/v1/iu-image/', '/api/v1/preview/',
    '/api/v1/book/:bookId/chunks', '/api/v1/book/:bookId/assets-state',
];

/** Strip comments (block, full-line and trailing ` // …`) so doc mentions are not edges. */
function codeOf(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/\s\/\/.*$/, ''))
        .filter((line) => !/^\s*\/\//.test(line))
        .join('\n');
}

function contourFiles() {
    return listSourceFiles(EDITOR_DIR);
}

// Minimal deps for mounting both registrars: the port object carries the
// host legs; handlers under registration never invoke them.
function stubDeps() {
    const noop = () => {};
    return {
        book: { collectSceneList: noop },
        bookDiff: { computeBookDiff: () => ({ dirty_scenes: [] }) },
        storage: { bookSync: { reconcileFromDiff: async () => ({ reconciled: 0 }) } },
        bookDeletion: { deleteBook: async () => ({}) },
        editorModel: { read: () => null, commit: noop },
        editorPorts: {
            sceneAssetsRepo: { bumpSceneVersions: async () => 0, setDirtyUnitIds: async () => 0 },
            placeholderAudio: { recoverMissingPlaceholders: async () => ({ created: 0, errors: [] }) },
            auditCoverage: { auditBookCoverage: () => ({}) },
            promptLimit: 2000,
            purge: { purgeScene: async () => ({}), purgeUnit: async () => ({}) },
            resolveOwnership: async () => ({}),
            recoveryCtx: {},
        },
        utils: { log: noop },
    };
}

// ── E1 — route surface parity (functional registration) ──────────────────
describe('E1: editor registrars register exactly the frozen edit surface', () => {
    const MODULE_KEYS = EDITOR_REGISTRARS.map((p) => [p, require.resolve(p)]);

    after(() => {
        for (const [, resolved] of MODULE_KEYS) delete require.cache[resolved];
    });

    function register() {
        for (const [, resolved] of MODULE_KEYS) delete require.cache[resolved];
        const registered = [];
        const app = {};
        for (const m of ['get', 'post', 'put', 'delete', 'patch', 'use']) {
            app[m] = (p, h) => registered.push({ method: m, path: p });
        }
        const deps = stubDeps();
        require(EDITOR_REGISTRARS[0])(app, {}, deps);
        require(EDITOR_REGISTRARS[1])(app, {}, deps);
        return registered;
    }

    it('registers exactly the 26 frozen method+path pairs (nothing more)', () => {
        const got = register().map((r) => [r.method, r.path]).sort();
        expect(got, 'edit route surface changed').to.deep.equal([...EDITOR_ROUTES].sort());
    });

    it('registers no non-editor endpoint (no player/generation/import leakage)', () => {
        const paths = register().map((r) => r.path);
        for (const lit of NON_EDITOR_ROUTE_LITERALS) {
            expect(paths, `editor contour must not register ${lit}`).to.not.include(lit);
        }
    });

    it('mutates no HTTP semantics: book is GET+PUT+DELETE, scene patch is PATCH only, blank is POST', () => {
        const registered = register();
        const byPath = (p) => registered.filter((r) => r.path === p).map((r) => r.method);
        expect(byPath('/api/v1/book/:bookId')).to.deep.equal(['get', 'put', 'delete']);
        expect(byPath('/api/v1/book/:bookId/metadata')).to.deep.equal(['patch']);
        expect(byPath('/api/v1/book/:bookId/scene/:chapterId/:sceneId')).to.deep.equal(['patch']);
        expect(byPath('/api/v1/book/blank')).to.deep.equal(['post']);
        // Unit deletes stay deep-purging deletes; units create is POST only.
        expect(byPath('/api/v1/book/:bookId/chapters/:chapterId/scenes/:sceneId/units/:unitId')).to.deep.equal(['delete']);
    });
});

// ── E2 — require isolation (forward direction) ────────────────────────────
describe('E2: the editor contour requires no host implementation (ports seam only)', () => {
    it('registrars and helpers require only intra-contour, book/paths, entity-id, and builtins', () => {
        const ALLOWED = /^(\.\.?\/)+(book\/lazy-book\/paths|utils\/entity-id)/;
        const offenders = [];
        for (const file of contourFiles()) {
            const isPorts = file === EDITOR_PORTS; // the seam itself — pinned below
            for (const spec of requireSpecifiers(codeOf(readSource(file)))) {
                if (builtinModules.includes(spec) || builtinModules.includes(spec.split('/')[0])) continue;
                if (!spec.startsWith('.')) {
                    offenders.push(`${rel(file)}: ${spec} (bare, non-builtin)`);
                    continue;
                }
                if (isPorts) continue; // port-wiring requires pinned separately
                if (ALLOWED.test(spec)) continue; // id grammar + entity-id (pre-split shape)
                const resolved = resolveSpecifier(file, spec);
                if (resolved && resolved.startsWith(EDITOR_DIR + path.sep)) continue; // intra-contour
                offenders.push(`${rel(file)}: ${spec} (host implementation require)`);
            }
        }
        expect(offenders, 'editor contour must receive host legs via editorPorts only').to.deep.equal([]);
    });

    it('editor-ports.cjs (the seam) has its host-wiring require set frozen', () => {
        const src = codeOf(readSource(EDITOR_PORTS));
        const specs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
        expect(specs.sort(), 'editor-ports host-wiring set changed — update the freeze consciously').to.deep.equal([
            '../../middleware/workspace-ownership',
            '../../services/agent-prompts',
            '../../services/entity-cleanup.cjs',
            '../../services/source-coverage-audit',
        ]);
    });

    it('no contour file opens Redis or raw PG client connections directly', () => {
        for (const file of contourFiles()) {
            const src = codeOf(readSource(file));
            expect(src, `${rel(file)} must not open PG connections`).to.not.match(/require\(['"](pg|.*postgres)['"]\)/);
            expect(src, `${rel(file)} must not open Redis connections`).to.not.match(/require\(['"]ioredis['"]\)/);
        }
    });

    it('the contour never requires the Player package (zero Editor→Player deps)', () => {
        const offenders = [];
        for (const file of contourFiles()) {
            for (const spec of requireSpecifiers(codeOf(readSource(file)))) {
                if (/animastor-player|routes\/player|player-routes|player-model|playerPorts/.test(spec)) {
                    offenders.push(`${rel(file)}: ${spec}`);
                }
            }
        }
        expect(offenders, 'Editor must not gain any dependency on Player (audit §8: zero, both directions)').to.deep.equal([]);
    });
});

// ── E3 — reverse direction: nothing reaches the contour by path ──────────
describe('E3: no host module requires the editor contour implementation by path', () => {
    it('only book-routes.cjs (delegation) and backend.cjs (ports wiring) mention the contour', () => {
        const offenders = [];
        const seen = [];
        for (const dir of HOST_CONTOUR_DIRS) {
            for (const file of listSourceFiles(dir)) {
                if (rel(file).startsWith('backend/src/routes/editor/')) continue;
                for (const spec of requireSpecifiers(codeOf(readSource(file)))) {
                    if (/routes\/editor\/|editor-routes\.cjs|entity-crud-routes\.cjs|editor-ports\.cjs|read-recovery\.cjs/.test(spec)) {
                        seen.push(`${rel(file)}: ${spec}`);
                    }
                }
            }
        }
        // The two sanctioned edges: book-routes.cjs delegates registration to
        // the contour registrars; backend.cjs wires editorPorts.
        const allowed = (edge) =>
            edge.startsWith('backend/src/routes/book-routes.cjs: ./editor/') ||
            edge.startsWith('backend/src/backend.cjs: ./routes/editor/editor-ports.cjs');
        for (const edge of seen) if (!allowed(edge)) offenders.push(edge);
        expect(offenders, 'the editor contour is consumed only via book-routes delegation + the ports seam').to.deep.equal([]);
    });

    it('book-routes.cjs delegates the contour and registers no editor route literal itself', () => {
        const src = codeOf(readSource(BOOK_ROUTES));
        expect(src).to.match(/require\('\.\/editor\/editor-routes\.cjs'\)/);
        expect(src).to.match(/require\('\.\/editor\/entity-crud-routes\.cjs'\)/);
        // The old core/entity registrar paths are gone.
        expect(src).to.not.match(/\.\/book\/(core|entity-crud)-routes\.cjs/);
        // No editor endpoint literal re-registered host-side (double-mount risk).
        for (const [, p] of EDITOR_ROUTES) {
            expect(src, `book-routes.cjs must not register ${p}`).to.not.include(`'${p}'`);
        }
    });

    it('the old contour paths are vacated (no legacy copies remain)', () => {
        expect(fs.existsSync(path.join(BACKEND_SRC, 'routes', 'book', 'core-routes.cjs'))).to.equal(false);
        expect(fs.existsSync(path.join(BACKEND_SRC, 'routes', 'book', 'entity-crud-routes.cjs'))).to.equal(false);
        expect(fs.existsSync(path.join(BACKEND_SRC, 'routes', 'book', 'scene-patch-utils.cjs'))).to.equal(false);
        expect(fs.existsSync(path.join(BACKEND_SRC, 'routes', 'book', 'recover-chunks.cjs'))).to.equal(false);
    });

    it('no editor route literal appears in the player package (Player stays Player)', () => {
        const playerDir = path.join(REPO_ROOT, 'packages', 'animastor-player', 'src');
        const offenders = [];
        for (const file of listSourceFiles(playerDir)) {
            const src = codeOf(readSource(file));
            for (const [, p] of EDITOR_ROUTES) {
                if (src.includes(`'${p}'`) || src.includes(`"${p}"`)) offenders.push(`${rel(file)}: ${p}`);
            }
        }
        expect(offenders, 'edit endpoints must not be registered by the Player package').to.deep.equal([]);
    });
});
