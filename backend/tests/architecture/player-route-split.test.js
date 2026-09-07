// ======================================================
// PLAYER ROUTE SPLIT — FINAL PACKAGE BOUNDARY GUARDS
// ======================================================
// Guards for the playback contour after the route split (4d1f6f0e) and the
// final boundary audit, in preparation for the physical move to
// packages/animastor-player/ (no physical move in this commit).
// Docs: docs/architecture/PLAYER_ROUTE_SPLIT_CHECKLIST.md
//       §FINAL PACKAGE BOUNDARY AUDIT
//
//   P1 — Route surface parity: the player registrar registers EXACTLY the
//        frozen 17-endpoint playback surface (method + path), byte-identical
//        to the pre-split inventory (15 routes in generation-routes.cjs + 2
//        in routes/book/chunks-routes.cjs); no generation endpoint leaks in.
//   P2 — Require isolation (forward direction): every require inside
//        routes/player/** resolves within routes/player or is a node builtin
//        — no generation-routes, no workflows/, no video-timeline, no
//        middleware, no waveform-service, no config, no ioredis/pg, and no
//        possible cycle with the generation contour.
//   P3 — Reverse direction: generation-routes.cjs never requires a player
//        module and contains none of the 17 player route literals (the
//        generation contour cannot register Player endpoints).
//   P4 — No direct config access: the contour never reads `config.*` — the
//        artifact root arrives as the outputRoot seam (composition root).
//   P5 — Seam shape: playerPorts is the ONLY host-port object and carries
//        exactly { assertBookAccess, computeVideoStartMs, computeWaveform };
//        the wide video-timeline MODULE seam stayed out of routeDeps.
//   P6 — Book access: contour files read book content through playerModel
//        only; the book module reaches scene-data only as the two pure
//        VBook-runtime read projections (bookProjections).
//   P7 — Artifact-naming contract: artifact-naming.cjs is dependency-free
//        (moves with the package) and stays byte-identical to the canonical
//        generation writers in storage/filesystem-store.js; nothing outside
//        routes/player imports it (the grammar pin is the cross-domain
//        bridge, not an import edge).
//
// Static checks follow the Phase 1 helpers (pure source scan, CI-safe).

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const { builtinModules } = require('module');
const {
    BACKEND_SRC, listSourceFiles, readSource, rel, requireSpecifiers, resolveSpecifier,
} = require('./helpers');

const PLAYER_DIR = path.join(BACKEND_SRC, 'routes', 'player');
const PLAYER_REGISTRAR = path.join(PLAYER_DIR, 'player-routes.cjs');
const GENERATION_ROUTES = path.join(BACKEND_SRC, 'routes', 'generation-routes.cjs');
const NAMING = path.join(PLAYER_DIR, 'artifact-naming.cjs');
const FILESYSTEM_STORE = path.join(BACKEND_SRC, 'storage', 'filesystem-store.js');
const BACKEND_ROOT = path.join(BACKEND_SRC, 'backend.cjs');

// ── The frozen playback HTTP surface (pre-split inventory, 17 endpoints) ──
const PLAYER_ROUTES = [
    ['get', '/api/v1/chunk/:id'],
    ['get', '/api/v1/chunk/:id/audio'],
    ['get', '/api/v1/chunk/:id/image'],
    ['get', '/api/v1/chunk/:id/video'],
    ['get', '/api/v1/chunk/:id/storyboard'],
    ['get', '/api/v1/scene/:bookId/:chapterId/:sceneId/audio'],
    ['get', '/api/v1/scene/:bookId/:chapterId/:sceneId/video'],
    ['get', '/api/v1/scene/:bookId/:chapterId/:sceneId/image'],
    ['get', '/api/v1/scene/:bookId/:chapterId/:sceneId/status'],
    ['get', '/api/v1/scene/:bookId/:chapterId/:sceneId/storyboard'],
    ['get', '/api/v1/scene/:bookId/:chapterId/:sceneId/waveform'],
    ['get', '/api/v1/scene/:bookId/:chapterId/:sceneId/timings'],
    ['put', '/api/v1/scene/:bookId/:chapterId/:sceneId/timings'],
    ['get', '/api/v1/iu-image/:bookId/:chapterId/:sceneId/:iuId'],
    ['get', '/api/v1/preview/:bookId/:chapterId/:sceneId/:iuId'],
    ['get', '/api/v1/book/:bookId/chunks'],
    ['get', '/api/v1/book/:bookId/assets-state'],
];

// Generation-contour route literals that must never appear in the player files.
const GENERATION_ROUTE_LITERALS = [
    '/api/v1/generate', '/api/v1/worker/status', '/api/v1/worker/counts',
    '/api/v1/book/:bookId/progress-stream', '/gpu/task/result', '/gpu/task/error',
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

function playerFiles() {
    return listSourceFiles(PLAYER_DIR);
}

function stubDeps(tmpDir) {
    const noop = () => {};
    return {
        outputRoot: tmpDir,
        state: {}, audio: {}, image: {}, video: {}, book: {},
        playerModel: { loadBook: () => null },
        playerPorts: {
            assertBookAccess: async () => ({}),
            computeVideoStartMs: async () => false,
            computeWaveform: async () => [],
        },
        activeScenes: {}, placeholderAudio: {}, layerConfig: {},
        utils: { log: noop },
        getChunk: async () => null, getAllChunks: async () => [],
        getBookWindowStatus: async () => ({}),
        iuRepo: {}, sceneAssetsRepo: {},
        computeIuReady: async () => 0,
        bookProjections: { findSceneRuntimeData: () => null, collectSceneUnits: () => [] },
    };
}

// ── P1 — route surface parity (functional registration) ─────────────────
describe('P1: player registrar registers exactly the frozen playback surface', () => {
    const MODULE_RESOLVED = require.resolve(PLAYER_REGISTRAR);
    const originalCacheEntry = require.cache[MODULE_RESOLVED];

    after(() => {
        if (originalCacheEntry) require.cache[MODULE_RESOLVED] = originalCacheEntry;
        else delete require.cache[MODULE_RESOLVED];
    });

    function register() {
        delete require.cache[MODULE_RESOLVED];
        const registered = [];
        const app = {};
        for (const m of ['get', 'post', 'put', 'delete', 'patch', 'use']) {
            app[m] = (p, h) => registered.push({ method: m, path: p });
        }
        require(PLAYER_REGISTRAR)(app, {}, stubDeps(fs.mkdtempSync('player-split-guard-')));
        return registered;
    }

    it('registers exactly the 17 frozen method+path pairs (nothing more)', () => {
        const registered = register();
        const got = registered.map((r) => [r.method, r.path]).sort();
        expect(got, 'playback route surface changed').to.deep.equal([...PLAYER_ROUTES].sort());
    });

    it('registers no generation-contour endpoint (no leakage into the player)', () => {
        const registered = register();
        const paths = registered.map((r) => r.path);
        for (const lit of GENERATION_ROUTE_LITERALS) {
            expect(paths, `player registrar must not register ${lit}`).to.not.include(lit);
        }
    });

    it('mutates no HTTP semantics: every media route is a GET, timings is GET+PUT', () => {
        const registered = register();
        const byPath = (p) => registered.filter((r) => r.path === p).map((r) => r.method);
        expect(byPath('/api/v1/scene/:bookId/:chapterId/:sceneId/timings')).to.deep.equal(['get', 'put']);
        expect(byPath('/api/v1/chunk/:id/video')).to.deep.equal(['get']);
        expect(byPath('/api/v1/book/:bookId/assets-state')).to.deep.equal(['get']);
    });
});

// ── P2 — require isolation (forward direction, kills cycles too) ────────
describe('P2: routes/player requires only intra-contour modules and node builtins', () => {
    it('every require resolves within routes/player or is a node builtin', () => {
        const offenders = [];
        for (const file of playerFiles()) {
            for (const spec of requireSpecifiers(codeOf(readSource(file)))) {
                if (builtinModules.includes(spec) || builtinModules.includes(spec.split('/')[0])) continue;
                if (!spec.startsWith('.')) {
                    offenders.push(`${rel(file)}: ${spec} (bare, non-builtin)`);
                    continue;
                }
                const resolved = resolveSpecifier(file, spec);
                if (!resolved || !resolved.startsWith(PLAYER_DIR + path.sep)) {
                    offenders.push(`${rel(file)}: ${spec} (escapes the player contour)`);
                }
            }
        }
        expect(offenders, 'player contour must not import host/generation implementation').to.deep.equal([]);
    });
});

// ── P3 — reverse direction: generation cannot reach the player contour ──
describe('P3: generation contour does not import or register Player endpoints', () => {
    it('generation-routes.cjs requires no routes/player module', () => {
        const src = readSource(GENERATION_ROUTES);
        const playerRequires = requireSpecifiers(src).filter((s) => /routes\/player|player-routes|playback-queue|scene-media|scene-data|iu-media|artifact-naming|player-shared/.test(s));
        expect(playerRequires, 'generation contour must not require player implementation').to.deep.equal([]);
    });

    it('generation-routes.cjs contains none of the 17 player route literals', () => {
        const code = codeOf(readSource(GENERATION_ROUTES));
        const offenders = PLAYER_ROUTES
            .map(([, p]) => p)
            .filter((p) => code.includes(`'${p}'`) || code.includes(`"${p}"`));
        expect(offenders, 'playback endpoints reappeared in the generation contour').to.deep.equal([]);
    });
});

// ── P4 — no direct config access from the player contour ────────────────
describe('P4: player contour never reads config directly (outputRoot seam)', () => {
    it('no `config.` usage and no config destructure in routes/player/**', () => {
        const offenders = [];
        for (const file of playerFiles()) {
            const code = codeOf(readSource(file));
            if (/\bconfig\s*\./.test(code)) offenders.push(`${rel(file)}: config.* read`);
            if (/(^|[^a-zA-Z])config\s*[,}]/.test(code) && /module\.exports|const \{/.test(code) && file.endsWith('player-routes.cjs')) {
                offenders.push(`${rel(file)}: destructures config`);
            }
        }
        expect(offenders, 'player contour must receive the artifact root via outputRoot').to.deep.equal([]);
    });

    it('the composition root injects outputRoot from config.OUTPUT_DIR (seam preserved)', () => {
        const backend = readSource(BACKEND_ROOT);
        expect(backend).to.match(/outputRoot:\s*config\.OUTPUT_DIR/);
    });
});

// ── P5 — seam shape: playerPorts is the only host-port object ────────────
describe('P5: host seams stay minimal (playerPorts, outputRoot, computeIuReady)', () => {
    it('playerPorts carries exactly { assertBookAccess, computeVideoStartMs, computeWaveform }', () => {
        const backend = readSource(BACKEND_ROOT);
        const block = backend.match(/playerPorts:\s*\{([\s\S]*?)\},/);
        expect(block, 'routeDeps.playerPorts block').to.not.be.null;
        const keys = [...block[1].matchAll(/(?<![.\w])([a-zA-Z]+)\s*[,:]/g)].map((m) => m[1]).sort();
        expect(keys).to.deep.equal(['assertBookAccess', 'computeVideoStartMs', 'computeWaveform']);
    });

    it('the wide video-timeline module seam never returns to routeDeps', () => {
        const backend = readSource(BACKEND_ROOT);
        expect(backend, 'routeDeps must not carry the videoTimeline module').to.not.match(/^\s*videoTimeline\s*,?\s*$/m);
    });

    it('scene-data computes video_start_ms through the playerPorts port only', () => {
        const src = readSource(path.join(PLAYER_DIR, 'scene-data.cjs'));
        expect(src).to.match(/ctx\.playerPorts\.computeVideoStartMs\(/);
        expect(src).to.not.match(/videoTimelinePort/);
        expect(src).to.not.match(/require\([^)]*video-timeline/);
    });

    it('computeIuReady is still injected (pure IU math consumed via DI)', () => {
        const backend = readSource(BACKEND_ROOT);
        expect(backend).to.match(/computeIuReady\s*[,:]/);
        expect(readSource(path.join(PLAYER_DIR, 'playback-queue.cjs'))).to.match(/computeIuReady/);
    });
});

// ── P6 — book access goes through playerModel (VBook boundary) ──────────
describe('P6: player contour reaches the Book Model only via playerModel', () => {
    it('no contour file calls book.loadBook / book.saveBookBundle directly', () => {
        const offenders = [];
        for (const file of playerFiles()) {
            const code = codeOf(readSource(file));
            if (/\bbook\.loadBook\s*\(/.test(code) || /\bbook\.saveBookBundle\s*\(/.test(code)) {
                offenders.push(rel(file));
            }
        }
        expect(offenders).to.deep.equal([]);
    });

    it('book content reads in the contour go through playerModel.loadBook', () => {
        for (const f of ['iu-media.cjs', 'scene-data.cjs', 'playback-queue.cjs', 'player-shared.cjs']) {
            expect(readSource(path.join(PLAYER_DIR, f)), `${f} must read via playerModel`).to.match(/playerModel\.loadBook\(/);
        }
    });

    it('scene-data receives pure book projections, not the book module', () => {
        const registrar = readSource(PLAYER_REGISTRAR);
        expect(registrar).to.match(/bookProjections:\s*\{[\s\S]*?findSceneRuntimeData:\s*book\.findSceneRuntimeData[\s\S]*?collectSceneUnits:\s*book\.collectSceneUnits[\s\S]*?\}/);
        const sceneData = readSource(path.join(PLAYER_DIR, 'scene-data.cjs'));
        expect(sceneData).to.match(/bookProjections\.findSceneRuntimeData\(/);
        expect(sceneData).to.match(/bookProjections\.collectSceneUnits\(/);
        expect(sceneData, 'whole book module must not reach scene-data').to.not.match(/\bdeps\.book\b/);
    });

    it('the player model facade still depends only on the Book Model layer', () => {
        const src = readSource(path.join(BACKEND_SRC, 'player', 'index.cjs'));
        expect(src).to.include("require('../book/book-model.cjs')");
        expect(requireSpecifiers(src).filter((s) => !s.startsWith('.'))).to.deep.equal([]);
    });
});

// ── P7 — artifact-naming contract (Player-serving grammar) ──────────────
describe('P7: artifact-naming grammar is dependency-free and writer-identical', () => {
    const naming = require(NAMING);

    it('artifact-naming.cjs has zero requires (physically moveable with the package)', () => {
        expect(requireSpecifiers(readSource(NAMING)), 'naming grammar must stay dependency-free').to.deep.equal([]);
    });

    it('nothing outside routes/player imports the naming grammar', () => {
        const routesDir = path.join(BACKEND_SRC, 'routes');
        const offenders = [];
        for (const file of listSourceFiles(routesDir)) {
            if (file.startsWith(PLAYER_DIR + path.sep)) continue;
            const specs = requireSpecifiers(readSource(file)).map((s) => resolveSpecifier(file, s));
            if (specs.includes(NAMING)) offenders.push(rel(file));
        }
        expect(offenders, 'naming grammar is read-side Player contract; generation must not import it').to.deep.equal([]);
    });

    it('reader grammar is byte-identical to the canonical generation writers', () => {
        const writers = require(FILESYSTEM_STORE);
        const probe = ['b1', 'ch2', 'sc3'];
        // Canonical exported writers (filesystem-store):
        expect(naming.sceneAudioName(...probe)).to.equal(writers.makeSceneAudioFilename(...probe));
        // The URL :iuId carries the `iu` prefix (frontend unitId: u.id ?? 'iu0001';
        // preview.js strips ^iu before the writer call) — so route `_iu1.png` ==
        // writer makeIUImageFilename with the stripped id.
        expect(naming.iuImageName(...probe, 'iu1')).to.equal(writers.makeIUImageFilename(...probe, '1'));
        // Inline writer templates (filesystem-store getSceneVideoPath / probeSceneImage):
        expect(naming.sceneVideoName(...probe)).to.equal('b1_ch2_sc3.mp4');
        expect(naming.sceneImageName(...probe)).to.equal('b1_ch2_sc3.png');
        expect(naming.iuImagePrefix(...probe)).to.equal('b1_ch2_sc3_iu');
        expect(naming.sceneVideoGroupName(...probe, 4)).to.equal('b1_ch2_sc3_g4.mp4');
        expect(naming.sceneArtifactPrefix(...probe)).to.equal('b1_ch2_sc3');
    });
});
