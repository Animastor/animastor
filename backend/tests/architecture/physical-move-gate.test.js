// ======================================================
// §32.30 POST-MOVE BOUNDARY GUARDS — packages/animastor-orchestration
// ======================================================
// Adapted from the §32.29 pre-move physical-move-gate suite (that gate's
// verdict was READY FOR PHYSICAL MOVE; the move has now LANDED). This suite
// freezes the post-move reality (PM-G1..PM-G10):
//
//   PM-G1  backend/src/orchestration is gone
//   PM-G2  the moved runtime files are gone from backend/src/runtime
//   PM-G3  the package root API is frozen (measured host consumption surface)
//   PM-G4  no deep imports of @animastor/orchestration from backend/src
//   PM-G5  no backend-relative requires inside the package
//   PM-G6  no forbidden host dependencies from the package (storage/book/
//          routes/services/PG/Redis/Express, no host transport internals)
//   PM-G7  the host-stays remain host-side (incl. the S-5 seam registry and
//          the pinned gpu-dispatcher transport)
//   PM-G8  no reverse dependency / no new SCC spanning host and package
//   PM-G9  composition-root wiring preserved (ports + host bindings + seams
//          registered from backend.cjs; result consumer injected)
//   PM-G10 the §32.29 pre-move contract still holds post-move: move-set
//          closure at the package location (every require of every package
//          file resolves in-package, to a builtin/external, or to the
//          host-binding seam), zero Generation deep imports, no
//          __dirname/require.cache in the package, no dynamic bypass
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md
//       §32.29 (pre-move gate) · §32.30 (physical extraction landed)

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const {
    BACKEND_SRC,
    REPO_ROOT,
    ORCH_PKG_DIR,
    ORCH_PKG_SRC,
    ORCH_PKG_RUNTIME_DIR,
    ORCH_PKG_ORCH_DIR,
    listSourceFiles,
    readSource,
    requireSpecifiers,
    resolveSpecifier,
    rel,
} = require('./helpers');

const RUNTIME_DIR = path.join(BACKEND_SRC, 'runtime');
const ORCH_HOST_DIR = path.join(BACKEND_SRC, 'orchestration');
const PKG_ROOT_FILE = path.join(ORCH_PKG_SRC, 'index.js');
const PKG_HOST_BINDINGS = path.join(ORCH_PKG_SRC, 'host', 'host-bindings.js');

// ── The moved set: 28 files (21 runtime + 7 orchestration), §32.29 §32.30 ──
const MOVED_RUNTIME = [
    'active-scenes-index.js', 'audio-fsm-port.js', 'circuit-breaker.js',
    'counter-reconciliation.js', 'dispatch-engine.js', 'failure-taxonomy.js',
    'hub-cancel-port.js', 'layer-config-port.js', 'lease-manager.js',
    'persistence-port.js', 'placeholder-audio-port.js',
    'progress-events-port.js', 'reconciliation-engine.js',
    'retry-budget-manager.js', 'runtime-metrics.js',
    'runtime-result-emitter.js', 'runtime-scheduler.js',
    'scene-data-port.js', 'scene-window.js', 'video-fsm-port.js',
    'worker-health.js',
];
const MOVED_ORCHESTRATION = [
    'index.js', 'orchestrator.js', 'runtime-result-consumer.js',
    'scene-callbacks.js', 'scene-orchestrator.js', 'scene-restoration.js',
    'scene-utils.js',
];

// ── The seven classified host stays (§32.29) ──
const HOST_STAYS_RUNTIME = {
    'gpu-dispatcher.js': 'pinned host transport (§32.19)',
    'runtime-loop.js': 'pinned host timer shell (§32.13)',
    'index.js': 'host facade barrel (composition root)',
    'orchestration-seams.js': 'S-5 seam registry (inbound channel)',
    'job-schema.js': 'contracts facade (Phase 9C choke point)',
    'runtime-persistence.js': 'dead — deleted at cleanup (§32.13)',
    'retention-manager.js': 'orphaned — deleted at cleanup (§32.13)',
};
const ALIVE_HOST_STAYS = ['gpu-dispatcher.js', 'runtime-loop.js', 'index.js', 'orchestration-seams.js', 'job-schema.js'];

// ── Frozen package root API (§32.29 §32.30: the measured host surface) ──
const ROOT_FACADE_EXPORTS = [
    'ensureStageDispatchable', 'dispatchStage', 'restoreSceneChunkStatus',
    'handleAudioCompleted', 'handleImageCompleted', 'handleVideoCompleted',
    'completeStage', 'failStage', 'markDirty', 'markDirtyScene', 'planScene',
    'beginStage', 'completeStageWithoutVideo', 'completeStageWithoutImage',
    'setScenePending', 'setSceneGenerating', 'setSceneAllReady',
    'setScenePlaceholder', 'rollbackStageToPending', 'reconcile', 'resetScenes',
    'orchestrator', 'createRuntimeResultConsumer',
];
const ROOT_PORT_EXPORTS = ['persistence', 'sceneData', 'placeholderAudio', 'progressEvents', 'audioFsm', 'videoFsm', 'hubCancel', 'layerConfig'];
const ROOT_BINDING_EXPORTS = ['bindHostModules', 'clearHostBindings', 'hostBinding', 'isHostBindingWired', 'lazyHostBinding', 'requiredHostBindings', 'BINDING_NAMES'];
const ROOT_RUNTIME_NS = ['scheduler', 'activeScenes', 'reconciliation', 'dispatch', 'leaseManager', 'counterReconciliation', 'metrics', 'workerHealth', 'sceneWindow', 'failureTaxonomy', 'runtimeResultEmitter'];

describe('§32.30 post-move boundary guards — packages/animastor-orchestration', () => {

    it('PM-G1: backend/src/orchestration is gone (the package is the single home)', () => {
        expect(fs.existsSync(ORCH_HOST_DIR), 'backend/src/orchestration must not exist after the move').to.equal(false);
    });

    it('PM-G2: the moved runtime files are gone from backend/src/runtime; exactly the classified stays remain', () => {
        for (const name of MOVED_RUNTIME) {
            expect(fs.existsSync(path.join(RUNTIME_DIR, name)), `${name} must live in the package now`).to.equal(false);
        }
        for (const name of MOVED_RUNTIME) {
            expect(fs.existsSync(path.join(ORCH_PKG_RUNTIME_DIR, name)), `${name} must exist in the package`).to.equal(true);
        }
        for (const name of MOVED_ORCHESTRATION) {
            expect(fs.existsSync(path.join(ORCH_PKG_ORCH_DIR, name)), `${name} must exist in the package`).to.equal(true);
        }
        // the classified stays are exactly the runtime files left behind
        const remaining = listSourceFiles(RUNTIME_DIR).map((f) => path.basename(f)).sort();
        expect(remaining, 'backend/src/runtime keeps exactly the classified host stays').to.deep.equal([...ALIVE_HOST_STAYS].sort());
    });

    it('PM-G3: the package root API is frozen to the measured host consumption surface', () => {
        // The root re-exports the moved facade verbatim (lazy accessors), so the
        // FACADE module is the surface carrier; the root adds the eager parts.
        const facadeSrc = readSource(path.join(ORCH_PKG_ORCH_DIR, 'index.js'));
        expect(facadeSrc).to.include("require('./scene-orchestrator')");
        expect(facadeSrc).to.include("require('./orchestrator')");
        const rootSrc = readSource(PKG_ROOT_FILE);
        for (const name of ROOT_PORT_EXPORTS) {
            expect(rootSrc, `root ports must include '${name}'`).to.include(`${name}:`);
        }
        for (const name of ROOT_BINDING_EXPORTS) {
            expect(rootSrc, `root must expose binding surface '${name}'`).to.include(name);
        }
        for (const name of ROOT_RUNTIME_NS) {
            expect(rootSrc, `root runtime namespace must include '${name}'`).to.include(name);
        }
        // behavioral freeze: the ACTUAL export object carries the full frozen
        // facade surface (evaluated, not source-grepped)
        delete require.cache[require.resolve(PKG_ROOT_FILE)];
        const pkg = require(PKG_ROOT_FILE);
        for (const name of ROOT_FACADE_EXPORTS) {
            expect(pkg[name], `root export '${name}' must exist`).to.not.equal(undefined);
        }
        // exports map: root-only — no subpath exports (deep-import blocking)
        const pkgJson = JSON.parse(fs.readFileSync(path.join(ORCH_PKG_DIR, 'package.json'), 'utf8'));
        expect(pkgJson.name).to.equal('@animastor/orchestration');
        expect(Object.keys(pkgJson.exports || {}), 'exports must be root-only (deep-import blocking)').to.deep.equal(['.']);
    });

    it('PM-G4: backend/src never deep-imports the package (root specifier only)', () => {
        const offenders = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (spec.startsWith('@animastor/orchestration/')) {
                    offenders.push(`${rel(file)} -> ${spec}`);
                }
            }
        }
        expect(offenders, 'deep package imports from host source are forbidden').to.deep.equal([]);
    });

    it('PM-G5: no backend-relative requires inside the package', () => {
        const offenders = [];
        for (const file of [...listSourceFiles(ORCH_PKG_SRC)]) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (spec.includes('backend/src') || spec.startsWith('../../backend')) {
                    offenders.push(`${rel(file)} -> ${spec}`);
                }
            }
        }
        expect(offenders, 'the package must never require backend/src').to.deep.equal([]);
    });

    it('PM-G6: no forbidden host dependencies from the package (storage/book/routes/services/PG/Redis/Express)', () => {
        const offenders = [];
        const FORBIDDEN_HOST_SPEC = /(^|[\\/])(storage|book|routes|services|config|state|media|helpers|middleware)([\\/]|['"])/;
        for (const file of listSourceFiles(ORCH_PKG_SRC)) {
            const src = readSource(file);
            for (const spec of requireSpecifiers(src)) {
                if (FORBIDDEN_HOST_SPEC.test(spec)) offenders.push(`${rel(file)} -> ${spec}`);
                if (spec === 'pg' || spec.startsWith('pg/') || spec === 'ioredis' || spec === 'express') offenders.push(`${rel(file)} -> ${spec}`);
            }
            // host transports are reached ONLY through the injected resolver
            if (src.includes("require('./gpu-dispatcher')") || src.includes("require('../runtime/gpu-dispatcher')")) {
                offenders.push(`${rel(file)} -> gpu-dispatcher require (must go through host-bindings)`);
            }
        }
        expect(offenders, 'forbidden host dependency from the orchestration package').to.deep.equal([]);
    });

    it('PM-G7: the host-stays remain host-side and own their inbound edges', () => {
        for (const name of ALIVE_HOST_STAYS) {
            expect(fs.existsSync(path.join(RUNTIME_DIR, name)), `${name} must stay host-side`).to.equal(true);
        }
        // the pinned transport keeps its PG routing repos (§32.19 pin)
        const gpu = readSource(path.join(RUNTIME_DIR, 'gpu-dispatcher.js'));
        expect(gpu).to.include("require('../storage/postgres/repositories/book-repo')");
        expect(gpu).to.include("require('../storage/postgres/repositories/worker-repo')");
        // the S-5 registry stays hollow and is the single inbound channel
        const seams = readSource(path.join(RUNTIME_DIR, 'orchestration-seams.js'));
        expect(requireSpecifiers(seams), 'the seams registry stays a zero-require hollow registry').to.deep.equal([]);
        // the package never requires the seams registry by path — only via the binding
        // (mentioning the name in the binding DOC comment is fine; a require is not)
        for (const file of listSourceFiles(ORCH_PKG_SRC)) {
            expect(requireSpecifiers(readSource(file)).filter((s) => s.includes('orchestration-seams')),
                `${rel(file)} must not require orchestration-seams by path`).to.deep.equal([]);
        }
    });

    it('PM-G8: no reverse dependency and no new SCC spanning host and package', () => {
        // package → package root specifier (self-import) is forbidden
        for (const file of listSourceFiles(ORCH_PKG_SRC)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                expect(spec.startsWith('@animastor/orchestration'), `${rel(file)} must not self-import the package specifier`).to.equal(false);
            }
        }
        // host → package edges are one-directional: the package contains zero
        // requires of any backend/src module (PM-G5 covers paths; this covers
        // the builtins check: nothing in the package resolves into backend/src)
        const resolveIntoBackend = [];
        for (const file of listSourceFiles(ORCH_PKG_SRC)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (!spec.startsWith('.')) continue;
                const target = resolveSpecifier(file, spec);
                if (target && target.startsWith(BACKEND_SRC)) resolveIntoBackend.push(`${rel(file)} -> ${rel(target)}`);
            }
        }
        expect(resolveIntoBackend, 'a package file resolves into backend/src — reverse dependency').to.deep.equal([]);
    });

    it('PM-G9: composition-root wiring preserved (ports + host bindings + seams + result consumer)', () => {
        const rootSrc = readSource(path.join(BACKEND_SRC, 'backend.cjs'));
        expect(rootSrc).to.include("require('@animastor/orchestration')");
        expect(rootSrc).to.include('bindHostModules({');
        // all nine bindings wired by name
        for (const name of ['config', 'state', 'stateOps', 'journal', 'media', 'genScope', 'seams', 'artifactRoot', 'resolveWorkspaceForBook']) {
            expect(rootSrc, `backend.cjs must bind '${name}'`).to.include(`${name}:`);
        }
        // seams still registered from the composition root
        expect(rootSrc).to.include('registerOrchestrationSeams({');
        // result consumer still injected, never required by runtime modules
        expect(rootSrc).to.include('createRuntimeResultConsumer(');
        expect(rootSrc).to.include('setConsumer(');
        // the eight ports still bound to the host adapters
        for (const port of ROOT_PORT_EXPORTS) {
            expect(rootSrc, `backend.cjs must bind the ${port} port`).to.match(new RegExp(`ports\\.${port}`));
        }
    });

    it('PM-G10: the §32.29 move-set contract holds post-move — closure, Generation root-only, no hidden host access, no dynamic bypass', () => {
        const pkgFiles = [...listSourceFiles(ORCH_PKG_RUNTIME_DIR), ...listSourceFiles(ORCH_PKG_ORCH_DIR), PKG_ROOT_FILE, PKG_HOST_BINDINGS];
        // closure: every relative require of every package file resolves
        // inside the package (host modules arrive via the host-bindings seam)
        const outside = [];
        for (const file of pkgFiles) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (!spec.startsWith('.')) continue;
                const target = resolveSpecifier(file, spec);
                if (!target) { outside.push(`${rel(file)} -> unresolved ${spec}`); continue; }
                if (!target.startsWith(ORCH_PKG_DIR)) outside.push(`${rel(file)} -> ${rel(target)}`);
            }
        }
        expect(outside, 'package closure broken — a relative require escapes the package').to.deep.equal([]);

        // Generation root-only (§32.29 MG-D parity)
        const deep = [];
        for (const file of pkgFiles) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (spec.startsWith('@animastor/generation/')) deep.push(`${rel(file)} -> ${spec}`);
            }
        }
        expect(deep, 'deep Generation import in the package').to.deep.equal([]);

        // no __dirname / require.cache / process.env in the package source
        const stripComments = (src) => src
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/\/\/[^\n]*/g, ' ');
        const hidden = [];
        for (const file of pkgFiles) {
            const code = stripComments(readSource(file));
            if (code.includes('__dirname') || code.includes('require.cache') || code.includes('process.env')) hidden.push(rel(file));
        }
        expect(hidden, 'hidden host access (__dirname/require.cache/process.env) in the package').to.deep.equal([]);

        // no computed require near host path text (dynamic bypass parity)
        const bypass = [];
        for (const file of pkgFiles) {
            const src = readSource(file);
            const dyn = src.match(/require\(\s*[A-Za-z_$][\w$.]*\s*\)/g) || [];
            for (const call of dyn) {
                const idx = src.indexOf(call);
                const near = src.slice(Math.max(0, idx - 400), idx);
                if (/backend\/src|storage\/|routes\/|services\//.test(near)) bypass.push(rel(file));
            }
        }
        expect(bypass, 'dynamic require near host path text — boundary bypass').to.deep.equal([]);
    });

});
