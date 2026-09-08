// ======================================================
// PLAYER PACKAGE — BOUNDARY GUARDS (physical move COMPLETE)
// ======================================================
// Guards for the playback contour after the route split (4d1f6f0e), the
// final boundary audit, and the PHYSICAL EXTRACTION to
// packages/animastor-player (@animastor/player).
// Docs: docs/architecture/PLAYER_ROUTE_SPLIT_CHECKLIST.md
//       §PHYSICAL MOVE COMPLETE
//
//   P1 — Route surface parity: the package registrar registers EXACTLY the
//        frozen 17-endpoint playback surface (method + path), byte-identical
//        to the pre-split inventory (15 routes in the old
//        routes/generation-routes.cjs + 2 in the old
//        routes/book/chunks-routes.cjs); no generation endpoint leaks in.
//   P2 — Require isolation (forward direction): every require inside
//        packages/animastor-player/src/** resolves within the package, is
//        @animastor/vbook-runtime, or is a node builtin — no backend host
//        implementation, no generation, no workflows/, no video-timeline,
//        no middleware, no waveform-service, no config, no ioredis/pg, and
//        no possible cycle with the generation contour.
//   P3 — Reverse direction: generation-routes.cjs never requires a player
//        module and contains none of the 17 player route literals (the
//        generation contour cannot register Player endpoints); nothing
//        requires into the package by path (only the package entrypoint is
//        consumed, via '@animastor/player').
//   P4 — No direct config access: the package never reads `config.*` — the
//        artifact root arrives as the outputRoot seam (composition root).
//   P5 — Seam shape: playerPorts is the ONLY host-port object and carries
//        exactly { assertBookAccess, computeVideoStartMs, computeWaveform };
//        the wide video-timeline MODULE seam stays out of routeDeps;
//        bookProjections is injected as a narrow port.
//   P6 — Book access: package files read book content through playerModel
//        only; the book module never reaches the package (bookProjections
//        is the narrow pure-read port); the player model facade depends
//        only on the VBook runtime Book Model layer.
//   P7 — Artifact-naming contract: artifact-naming.cjs is dependency-free
//        and stays byte-identical to the canonical generation writers in
//        storage/filesystem-store.js; nothing outside the package imports
//        it (the grammar pin is the cross-domain bridge, not an import
//        edge).
//   P8 — Physical move is complete: no legacy backend copy exists
//        (backend/src/routes/player/, backend/src/player/, the empty
//        chunks-routes registrar stub); the composition root consumes the
//        package through its entrypoint only.
//   P9 — Package manifest: single entrypoint export, no host/runtime
//        dependencies beyond @animastor/vbook-runtime.
//
// Static checks follow the Phase 1 helpers (pure source scan, CI-safe).

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const { builtinModules } = require('module');
const {
    BACKEND_SRC, listSourceFiles, readSource, rel, requireSpecifiers, resolveSpecifier, REPO_ROOT,
} = require('./helpers');

const PLAYER_DIR = path.join(REPO_ROOT, 'packages', 'animastor-player');
const PLAYER_SRC_DIR = path.join(PLAYER_DIR, 'src');
const PLAYER_REGISTRAR = path.join(PLAYER_SRC_DIR, 'player-routes.cjs');
const PLAYER_ENTRYPOINT = path.join(PLAYER_SRC_DIR, 'index.cjs');
const GENERATION_ROUTES = path.join(BACKEND_SRC, 'routes', 'generation-routes.cjs');
const NAMING = path.join(PLAYER_SRC_DIR, 'artifact-naming.cjs');
const FILESYSTEM_STORE = path.join(BACKEND_SRC, 'storage', 'filesystem-store.js');
const BACKEND_ROOT = path.join(BACKEND_SRC, 'backend.cjs');
const PLAYER_PACKAGE_JSON = path.join(PLAYER_DIR, 'package.json');

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
    return listSourceFiles(PLAYER_SRC_DIR);
}

function stubDeps(tmpDir) {
    const noop = () => {};
    return {
        outputRoot: tmpDir,
        state: {}, audio: {}, image: {}, video: {},
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
describe('P2: the player package requires only package-internal modules, the VBook runtime, and node builtins', () => {
    it('every require resolves within the package, to @animastor/vbook-runtime, or is a node builtin', () => {
        const offenders = [];
        for (const file of playerFiles()) {
            for (const spec of requireSpecifiers(codeOf(readSource(file)))) {
                if (builtinModules.includes(spec) || builtinModules.includes(spec.split('/')[0])) continue;
                if (spec.startsWith('@animastor/vbook-runtime')) continue; // the VBook boundary
                if (!spec.startsWith('.')) {
                    offenders.push(`${rel(file)}: ${spec} (bare, non-builtin)`);
                    continue;
                }
                const resolved = resolveSpecifier(file, spec);
                if (!resolved || !resolved.startsWith(PLAYER_SRC_DIR + path.sep)) {
                    offenders.push(`${rel(file)}: ${spec} (escapes the player package)`);
                }
            }
        }
        expect(offenders, 'player package must not import host/generation implementation').to.deep.equal([]);
    });

    it('the package never requires the backend host (config, generation, workflows, middleware, services, storage, runtime)', () => {
        const FORBIDDEN = /config|generation-routes|workflows|video-timeline|waveform-service|middleware|storage|runtime|orchestration|services|image\/|state\/|backend\.cjs|routes\//;
        const offenders = [];
        for (const file of playerFiles()) {
            for (const spec of requireSpecifiers(codeOf(readSource(file)))) {
                if (spec.startsWith('.') || spec.startsWith('@animastor/')) continue;
                if (builtinModules.includes(spec) || builtinModules.includes(spec.split('/')[0])) continue;
                if (FORBIDDEN.test(spec)) offenders.push(`${rel(file)}: ${spec}`);
            }
        }
        expect(offenders).to.deep.equal([]);
    });
});

// ── P3 — reverse direction: generation cannot reach the player package ──
describe('P3: generation contour does not import or register Player endpoints', () => {
    it('generation-routes.cjs requires no player module (package internals included)', () => {
        const src = readSource(GENERATION_ROUTES);
        const playerRequires = requireSpecifiers(src).filter((s) => /routes\/player|player-routes|playback-queue|scene-media|scene-data|iu-media|artifact-naming|player-shared|animastor-player/.test(s));
        expect(playerRequires, 'generation contour must not require player implementation').to.deep.equal([]);
    });

    it('generation-routes.cjs contains none of the 17 player route literals', () => {
        const code = codeOf(readSource(GENERATION_ROUTES));
        const offenders = PLAYER_ROUTES
            .map(([, p]) => p)
            .filter((p) => code.includes(`'${p}'`) || code.includes(`"${p}"`));
        expect(offenders, 'playback endpoints reappeared in the generation contour').to.deep.equal([]);
    });

    it('nothing in the repo requires the package by path (entrypoint only)', () => {
        const offenders = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            for (const spec of requireSpecifiers(codeOf(readSource(file)))) {
                if (/animastor-player|routes\/player|src\/player/.test(spec)) {
                    offenders.push(`${rel(file)}: ${spec}`);
                }
            }
        }
        expect(offenders, 'the host must consume @animastor/player via the entrypoint, never by path').to.deep.equal([]);
    });
});

// ── P4 — no direct config access from the player package ────────────────
describe('P4: the player package never reads config directly (outputRoot seam)', () => {
    it('no `config.` usage and no config destructure in packages/animastor-player/src/**', () => {
        const offenders = [];
        for (const file of playerFiles()) {
            const code = codeOf(readSource(file));
            if (/\bconfig\s*\./.test(code)) offenders.push(`${rel(file)}: config.* read`);
            if (/(^|[^a-zA-Z])config\s*[,}]/.test(code) && /module\.exports|const \{/.test(code) && file.endsWith('player-routes.cjs')) {
                offenders.push(`${rel(file)}: destructures config`);
            }
        }
        expect(offenders, 'player package must receive the artifact root via outputRoot').to.deep.equal([]);
    });

    it('the composition root injects outputRoot from config.OUTPUT_DIR (seam preserved)', () => {
        const backend = readSource(BACKEND_ROOT);
        expect(backend).to.match(/outputRoot:\s*config\.OUTPUT_DIR/);
    });
});

// ── P5 — seam shape: playerPorts is the only host-port object ────────────
describe('P5: host seams stay minimal (playerPorts, outputRoot, computeIuReady, bookProjections)', () => {
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
        const src = readSource(path.join(PLAYER_SRC_DIR, 'scene-data.cjs'));
        expect(src).to.match(/ctx\.playerPorts\.computeVideoStartMs\(/);
        expect(src).to.not.match(/videoTimelinePort/);
        expect(src).to.not.match(/require\([^)]*video-timeline/);
    });

    it('computeIuReady is still injected (pure IU math consumed via DI)', () => {
        const backend = readSource(BACKEND_ROOT);
        expect(backend).to.match(/computeIuReady\s*[,:]/);
        expect(readSource(path.join(PLAYER_SRC_DIR, 'playback-queue.cjs'))).to.match(/computeIuReady/);
    });

    it('bookProjections is a narrow injected port (findSceneRuntimeData + collectSceneUnits only)', () => {
        const backend = readSource(BACKEND_ROOT);
        const block = backend.match(/bookProjections:\s*\{([\s\S]*?)\},/);
        expect(block, 'routeDeps.bookProjections block').to.not.be.null;
        const keys = [...block[1].matchAll(/([a-zA-Z]+)\s*:/g)].map((m) => m[1]).sort();
        expect(keys).to.deep.equal(['collectSceneUnits', 'findSceneRuntimeData']);
        // The whole book module must not be handed to the package.
        expect(backend).to.not.match(/bookProjections:\s*book\b/);
    });
});

// ── P6 — book access goes through playerModel (VBook boundary) ──────────
describe('P6: the player package reaches the Book Model only via playerModel', () => {
    it('no package file calls book.loadBook / book.saveBookBundle directly', () => {
        const offenders = [];
        for (const file of playerFiles()) {
            const code = codeOf(readSource(file));
            if (/\bbook\.loadBook\s*\(/.test(code) || /\bbook\.saveBookBundle\s*\(/.test(code)) {
                offenders.push(rel(file));
            }
        }
        expect(offenders).to.deep.equal([]);
    });

    it('book content reads in the package go through playerModel.loadBook', () => {
        for (const f of ['iu-media.cjs', 'scene-data.cjs', 'playback-queue.cjs', 'player-shared.cjs']) {
            expect(readSource(path.join(PLAYER_SRC_DIR, f)), `${f} must read via playerModel`).to.match(/playerModel\.loadBook\(/);
        }
    });

    it('the registrar never receives the whole book module (bookProjections port only)', () => {
        const registrar = readSource(PLAYER_REGISTRAR);
        expect(registrar).to.not.match(/\bbook\b\s*[,}]/);
        expect(registrar).to.match(/bookProjections\s*[,}]/);
        const sceneData = readSource(path.join(PLAYER_SRC_DIR, 'scene-data.cjs'));
        expect(sceneData).to.match(/bookProjections\.findSceneRuntimeData\(/);
        expect(sceneData).to.match(/bookProjections\.collectSceneUnits\(/);
        expect(sceneData, 'whole book module must not reach scene-data').to.not.match(/\bdeps\.book\b/);
    });

    it('the player model facade depends only on the VBook runtime Book Model layer', () => {
        const src = readSource(path.join(PLAYER_SRC_DIR, 'player-model.cjs'));
        expect(src).to.include("require('@animastor/vbook-runtime/book-model.cjs')");
        const specs = requireSpecifiers(src).filter((s) => !s.startsWith('.') && !s.startsWith('@animastor/vbook-runtime'));
        expect(specs).to.deep.equal([]);
    });
});

// ── P7 — artifact-naming contract (Player-serving grammar) ──────────────
describe('P7: artifact-naming grammar is dependency-free and writer-identical', () => {
    const naming = require(NAMING);

    it('artifact-naming.cjs has zero requires (lives inside the package)', () => {
        expect(requireSpecifiers(readSource(NAMING)), 'naming grammar must stay dependency-free').to.deep.equal([]);
    });

    it('nothing outside the player package imports the naming grammar', () => {
        const offenders = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            const specs = requireSpecifiers(readSource(file)).map((s) => resolveSpecifier(file, s));
            if (specs.includes(NAMING)) offenders.push(rel(file));
        }
        // Also scan the other packages — the grammar belongs to @animastor/player.
        for (const dir of listSourceFiles(path.join(REPO_ROOT, 'backend', 'src'))) {
            const specs = requireSpecifiers(readSource(dir)).map((s) => resolveSpecifier(dir, s));
            if (specs.includes(NAMING)) offenders.push(rel(dir));
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

// ── P8 — the physical move is complete (no legacy backend copy) ─────────
describe('P8: no legacy backend copy of the Player contour remains', () => {
    it('backend/src/routes/player/ and backend/src/player/ are gone', () => {
        expect(fs.existsSync(path.join(BACKEND_SRC, 'routes', 'player')),
            'legacy routes/player/ still exists').to.equal(false);
        expect(fs.existsSync(path.join(BACKEND_SRC, 'player')),
            'legacy src/player/ still exists').to.equal(false);
    });

    it('the empty chunks-routes.cjs registrar stub is deleted and unreferenced', () => {
        expect(fs.existsSync(path.join(BACKEND_SRC, 'routes', 'book', 'chunks-routes.cjs')),
            'chunks-routes stub still exists').to.equal(false);
        const bookRoutes = readSource(path.join(BACKEND_SRC, 'routes', 'book-routes.cjs'));
        expect(requireSpecifiers(bookRoutes)).to.not.include('./book/chunks-routes.cjs');
    });

    it('the package physically lives in packages/animastor-player/ with all 8 owned files', () => {
        for (const f of ['index.cjs', 'player-routes.cjs', 'player-shared.cjs', 'player-model.cjs',
            'scene-media.cjs', 'scene-data.cjs', 'iu-media.cjs', 'playback-queue.cjs', 'artifact-naming.cjs']) {
            expect(fs.existsSync(path.join(PLAYER_SRC_DIR, f)), `missing package file: ${f}`).to.equal(true);
        }
    });
});

// ── P9 — package manifest + entrypoint consumption ──────────────────────
describe('P9: the host consumes the player package through its public entrypoint only', () => {
    it('the package exposes a single entrypoint export', () => {
        const pkg = JSON.parse(fs.readFileSync(PLAYER_PACKAGE_JSON, 'utf8'));
        expect(pkg.name).to.equal('@animastor/player');
        expect(Object.keys(pkg.exports || {})).to.deep.equal(['.']);
        expect(fs.existsSync(path.join(PLAYER_DIR, pkg.exports['.']))).to.equal(true);
    });

    it('the package declares no host/runtime dependencies beyond @animastor/vbook-runtime', () => {
        const pkg = JSON.parse(fs.readFileSync(PLAYER_PACKAGE_JSON, 'utf8'));
        expect(Object.keys(pkg.dependencies || {}).sort()).to.deep.equal(['@animastor/vbook-runtime']);
    });

    it('backend.cjs requires only the package entrypoint (never package internals)', () => {
        const backend = readSource(BACKEND_ROOT);
        expect(backend).to.match(/require\('@animastor\/player'\)/);
        expect(requireSpecifiers(backend).filter((s) => s.startsWith('@animastor/player'))).to.deep.equal(['@animastor/player']);
    });

    it('player routes are registered through the package API (createPlayerRoutes)', () => {
        const backend = readSource(BACKEND_ROOT);
        expect(backend).to.match(/createPlayerRoutes\(app,\s*redis,\s*routeDeps\)/);
        expect(backend).to.not.match(/require\('\.\/routes\/player/);
    });
});
