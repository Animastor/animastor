// ======================================================
// O-9 ARCHITECTURE GUARDS — HubCancelPort extraction seam
// ======================================================
// Freezes the O-9 state of docs/architecture/generation-module-extraction-
// reconnaissance.md §32.26: runtime/** and orchestration/** purge cancelled
// dispatches from the GPU Hub queue ONLY through runtime/hub-cancel-port.js
// (tier-owned contract); the host adapter (storage/hub-cancel-adapter.js)
// owns the hub-HTTP cleanup channel (runtime/dispatch-engine.js
// clearHubDispatches — hub URL/API-key resolution, the DELETE /queue/clear
// endpoint shape, per-id best-effort accounting). Composition root:
// backend.cjs. Lease cancellation itself (cancelActiveDispatch /
// clearLeasesForScenes / clearLeasesForBookByStage / clearAllLeasesForBook)
// stays a DIRECT dispatch-engine call — those are Redis-key domain
// operations, deliberately NOT in this port.
//
// This suite TIGHTENS the reconnaissance baseline:
//   O9-G1  zero tier call sites of dispatch-engine.clearHubDispatches
//          (the two former direct call sites now resolve via the port);
//   O9-G2  the port is a zero-require contract with no hub-transport
//          knowledge (no HUB_URL, no API key, no fetch, no HTTP method/
//          endpoint strings);
//   O9-G3  the port op set stays minimal: the exact measured set is ONE
//          op — clearHubDispatches; every declared op has a live tier
//          consumer;
//   O9-G4  no hub-transport leakage through the port or adapter surface
//          (frozen one-op adapter export set; the adapter delegates to
//          dispatch-engine only — no gpu-dispatcher, no direct fetch);
//   O9-G5  the composition root wires the adapter BEFORE the first
//          top-level tier require (backend.cjs + test bindings mirror,
//          order O-2 → O-3 → O-4 → O-5 → O-7 → O-8 → O-9);
//   O9-G6  no lazy/dynamic dispatch-engine hub-cancel bypass around the
//          port (tier proximity scan for clearHubDispatches) + the
//          adapter keeps call-time lazy resolution (require.cache
//          stubbing parity);
//   O9-G7  the O-1 boundary does not regress (shim stays deleted);
//   O9-G8  the O-2/O-3/O-4/O-5/O-7/O-8 boundaries do not regress (ports
//          stay zero-require, wires stay present);
//   O9-G9  runtime → orchestration stays 0 (S-5 direction untouched);
//   O9-G10 the adapter is the single bridge — the dispatch-engine
//          clearHubDispatches consumer set outside the adapter stays at
//          the frozen host set (routes/generation-routes.cjs,
//          services/entity-cleanup.cjs, backend tests), and the port
//          never widens into lease cancellation (no cancelActiveDispatch
//          / clearLeases* in the port OPS).
//
// Non-duplication note: requires/calls of dispatch-engine.clearHubDispatches
// OUTSIDE the two tiers (routes/generation-routes.cjs, services/
// entity-cleanup.cjs, backend tests) stay host-side by design — O-9 covers
// only the runtime/orchestration seam. The O-G series (runtime-
// orchestration-recon) pins the tier-wide env/Redis/HTTP baselines; this
// suite adds only the tier-level tightening O-9 introduced.
//
// Docs: generation-module-extraction-reconnaissance.md §32.26 (O-9)
// ======================================================

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const {
    BACKEND_SRC,
    listSourceFiles,
    readSource,
    requireSpecifiers,
    rel,
} = require('./helpers');

const RUNTIME_DIR = path.join(BACKEND_SRC, 'runtime');
const ORCH_DIR = path.join(BACKEND_SRC, 'orchestration');
const PORT_FILE = path.join(RUNTIME_DIR, 'hub-cancel-port.js');
const ADAPTER_FILE = path.join(BACKEND_SRC, 'storage', 'hub-cancel-adapter.js');
const ENGINE_FILE = path.join(RUNTIME_DIR, 'dispatch-engine.js');
const TEST_BINDINGS_FILE = path.join(BACKEND_SRC, '..', 'tests', 'generation-test-bindings.cjs');

function allTierFiles() {
    return [...listSourceFiles(RUNTIME_DIR), ...listSourceFiles(ORCH_DIR)];
}

// Strip line comments and doc-comment continuation lines — boundary
// EXPLANATIONS may mention what the boundary excludes; CODE may not
// (O2-G5/O3-G1/O8-G2 convention: scan the code, not the prose).
function codeOnly(src) {
    return src.split('\n')
        .map((line) => line.replace(/(^|\s)\/\/.*$/, '').replace(/^\s*\*.*$/, ''))
        .join('\n');
}

describe('§32.26 O-9 guards: hub-queue cleanup happens only via the HubCancelPort', () => {

    it('O9-G1: the two tiers call ZERO dispatch-engine.clearHubDispatches sites (the port is the only channel)', () => {
        const offenders = [];
        for (const file of allTierFiles()) {
            const src = codeOnly(readSource(file));
            const matches = src.match(/\.clearHubDispatches\s*\(/g) || [];
            for (let i = 0; i < matches.length; i++) {
                offenders.push(`${rel(file)} (call site)`);
            }
        }
        expect(offenders, 'runtime/** + orchestration/** must purge hub copies only via runtime/hub-cancel-port (the dispatch-engine call stays host-side)').to.deep.equal([]);
    });

    it('O9-G2: the port is a zero-require contract with no hub-transport knowledge', () => {
        const src = readSource(PORT_FILE);
        expect(requireSpecifiers(src), 'hub-cancel-port.js must require nothing (O-2..O-8 port convention)').to.deep.equal([]);
        const code = codeOnly(src);
        expect(code, 'the port must never know the hub URL').to.not.include('HUB_URL');
        expect(code, 'the port must never know the hub API key').to.not.include('GPU_HUB_API_KEY');
        expect(code, 'the port must never mention fetch').to.not.match(/\bfetch\b/);
        expect(code, 'the port must never know the hub HTTP endpoint').to.not.include('/queue/clear');
        expect(code, 'the port must never hardcode the host module path in code').to.not.include("require('../runtime/dispatch-engine')");
    });

    it('O9-G3: the port op set stays minimal — one op, declared and consumed live', () => {
        const portSrc = readSource(PORT_FILE);
        const opBlock = portSrc.match(/const OPS = \[([\s\S]*?)\];/);
        expect(opBlock, 'OPS list must stay declarative').to.not.be.null;
        const declaredOps = (opBlock[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1));
        // The measured O-9 operation set is exactly ONE op (§32.26).
        expect(declaredOps, 'the frozen O-9 contract').to.deep.equal(['clearHubDispatches']);
        // Live consumption: at least one tier call site resolves the op
        // through the port resolver.
        const consumers = [];
        for (const file of allTierFiles()) {
            if (rel(file) === 'backend/src/runtime/hub-cancel-port.js') continue;
            const src = codeOnly(readSource(file));
            if (/hubCancelOp\(\s*'clearHubDispatches'\s*\)/.test(src)) {
                consumers.push(rel(file));
            }
        }
        expect(consumers.sort(), 'the port op must have live tier consumers').to.deep.equal([
            'backend/src/orchestration/orchestrator.js',
            'backend/src/runtime/reconciliation-engine.js',
        ]);
        // And no undeclared op may be resolved through the port.
        const offenders = [];
        for (const file of allTierFiles()) {
            const src = codeOnly(readSource(file));
            for (const m of src.match(/hubCancelOp\(\s*'([^']+)'\s*\)/g) || []) {
                const op = m.match(/hubCancelOp\(\s*'([^']+)'/)[1];
                if (!declaredOps.includes(op)) offenders.push(`${rel(file)} -> ${op}`);
            }
        }
        expect(offenders, 'tier hub-cancel calls must be declared in the port OPS list').to.deep.equal([]);
    });

    it('O9-G4: no hub-transport leakage through the port or adapter surface', () => {
        const portSrc = codeOnly(readSource(PORT_FILE));
        // The port must not know hub-transport internals or lease-domain ops.
        for (const banned of ['HUB_URL', 'GPU_HUB_API_KEY', '/queue/clear', 'fetch(', 'x-api-key', 'cancelActiveDispatch', 'clearLeasesForScenes', 'clearLeasesForBookByStage', 'clearAllLeasesForBook']) {
            expect(portSrc, `the port must not know host internals (${banned})`).to.not.include(banned);
        }
        // The adapter must NOT grow exports silently: only the one frozen op
        // may exist (no whole-engine passthrough).
        const adapterSrc = readSource(ADAPTER_FILE);
        const exportBlock = adapterSrc.match(/module\.exports = \{([\s\S]*?)\};/);
        expect(exportBlock, 'adapter exports must stay declarative').to.not.be.null;
        const exportedOps = [];
        for (const raw of exportBlock[1].split('\n')) {
            const line = raw.trim();
            const m = line.match(/^(?:get\s+)?([a-zA-Z_]\w*)\s*[,(]/) ||
                line.match(/^([a-zA-Z_]\w*)[,\s]*$/);
            if (m) exportedOps.push(m[1]);
        }
        expect(exportedOps.sort(), 'the frozen O-9 adapter surface').to.deep.equal(['clearHubDispatches']);
        // The adapter delegates to dispatch-engine ONLY (no gpu-dispatcher,
        // no direct fetch/HTTP in the adapter).
        const adapterCode = codeOnly(adapterSrc);
        expect(adapterCode, 'the adapter must reach the host channel through dispatch-engine').to.include("require('../runtime/dispatch-engine')");
        for (const banned of ['gpu-dispatcher', 'fetch(', 'HUB_URL', '/queue/clear']) {
            expect(adapterCode, `the adapter must not own hub transport itself (${banned})`).to.not.include(banned);
        }
        // The host channel keeps its full public API unchanged (O-9 removed
        // tier call sites only — routes/entity-cleanup/test consumers keep
        // working; the export is pinned so a silent rename fails).
        const engineSrc = readSource(ENGINE_FILE);
        for (const op of ['clearHubDispatches', 'clearLeasesForScenes', 'clearLeasesForBookByStage', 'clearAllLeasesForBook', 'cancelActiveDispatch']) {
            expect(engineSrc, `dispatch-engine must keep exporting ${op}`).to.include(op);
        }
    });

    it('O9-G5: the composition root wires the adapter before the first top-level tier require', () => {
        const rootSrc = readSource(path.join(BACKEND_SRC, 'backend.cjs')).replace(/\s+/g, ' ');
        const wireIdx = rootSrc.indexOf('setHubCancelPort(');
        expect(wireIdx, 'backend.cjs must call setHubCancelPort(...)').to.be.greaterThan(-1);
        // First TOP-LEVEL tier require: strip lazy `=> require(...)` arrow
        // bodies (they execute at dispatch time, long after module
        // evaluation), then exclude the port contract modules themselves
        // (zero side effects, loadable before wiring).
        const topLevelSrc = rootSrc.replace(/\)\s*=>\s*require\([^)]*\)/g, '=>LAZY');
        const firstTierRequire = topLevelSrc.search(/require\('\.\/(?:runtime|orchestration)(?:\/(?!persistence-port|scene-data-port|placeholder-audio-port|progress-events-port|audio-fsm-port|video-fsm-port|hub-cancel-port)|')/);
        expect(firstTierRequire, 'backend.cjs must require at least one tier module at top level').to.be.greaterThan(-1);
        expect(wireIdx, 'wiring must happen BEFORE the first top-level runtime/orchestration require').to.be.lessThan(firstTierRequire);
        expect(/require\(\s*'\.\/storage\/hub-cancel-adapter'\s*\)/.test(rootSrc),
            'the wired adapter must be the host-side storage adapter').to.equal(true);
        // Wiring order stability: O-2 → O-3 → O-4 → O-5 → O-7 → O-8 → O-9
        // (composition-root sequence).
        const o2Idx = rootSrc.indexOf('setPersistencePort(');
        const o3Idx = rootSrc.indexOf('setSceneDataPort(');
        const o4Idx = rootSrc.indexOf('setPlaceholderAudioPort(');
        const o5Idx = rootSrc.indexOf('setProgressEventsPort(');
        const o7Idx = rootSrc.indexOf('setAudioFsmPort(');
        const o8Idx = rootSrc.indexOf('setVideoFsmPort(');
        expect(o2Idx, 'backend.cjs must still wire the O-2 persistence adapter').to.be.greaterThan(-1);
        expect(o3Idx, 'backend.cjs must still wire the O-3 scene-data adapter').to.be.greaterThan(-1);
        expect(o4Idx, 'backend.cjs must still wire the O-4 placeholder-audio adapter').to.be.greaterThan(-1);
        expect(o5Idx, 'backend.cjs must still wire the O-5 progress-events adapter').to.be.greaterThan(-1);
        expect(o7Idx, 'backend.cjs must still wire the O-7 audio-fsm adapter').to.be.greaterThan(-1);
        expect(o8Idx, 'backend.cjs must still wire the O-8 video-fsm adapter').to.be.greaterThan(-1);
        expect(wireIdx).to.be.greaterThan(o8Idx);
        expect(o8Idx).to.be.greaterThan(o7Idx);
        expect(o7Idx).to.be.greaterThan(o5Idx);
        expect(o5Idx).to.be.greaterThan(o4Idx);
        expect(o4Idx).to.be.greaterThan(o3Idx);
        expect(o3Idx).to.be.greaterThan(o2Idx);

        // Test-bindings mirror: the mocharc require chain must wire the port
        // too (same order discipline), or plain tier requires in tests would
        // fail-fast on an unwired port.
        const bindingsSrc = readSource(TEST_BINDINGS_FILE);
        const bWire = bindingsSrc.indexOf('setHubCancelPort(');
        expect(bWire, 'generation-test-bindings.cjs must mirror the O-9 wiring').to.be.greaterThan(-1);
        expect(bindingsSrc.indexOf('setVideoFsmPort('), 'bindings must wire O-8 before O-9').to.be.lessThan(bWire);
    });

    it('O9-G6: no lazy/dynamic dispatch-engine hub-cancel bypass around the port', () => {
        // Tier proximity scan: no tier file may reach dispatch-engine for hub
        // cleanup by any channel except the port — i.e. a dynamic
        // require(identifier) whose surrounding text mentions hub cleanup.
        const offenders = [];
        for (const file of allTierFiles()) {
            if (rel(file) === 'backend/src/runtime/dispatch-engine.js') continue; // host channel itself
            const src = readSource(file);
            const dyn = src.match(/require\(\s*[A-Za-z_$][\w$.]*\s*\)/g) || [];
            for (const call of dyn) {
                const idx = src.indexOf(call);
                const near = src.slice(Math.max(0, idx - 300), idx + 300);
                if (/clearHubDispatches|hub[-_ ]?cancel|queue\/clear/.test(near)) {
                    offenders.push(`${rel(file)} -> dynamic ${call}`);
                }
            }
        }
        expect(offenders, 'no smuggled require(identifier) may re-introduce a direct hub-cancel dispatch-engine edge').to.deep.equal([]);

        // The adapter resolves the host channel via a lazy call-time resolver
        // (the single channel — require.cache stubbing discipline); it must
        // not capture the module at load time.
        const adapterSrc = readSource(ADAPTER_FILE);
        expect(adapterSrc, 'the adapter must keep call-time (lazy) dispatch-engine resolution for test-stub parity')
            .to.include("() => require('../runtime/dispatch-engine')");
        expect(/const\s+\w+\s*=\s*require\('\.\.\/runtime\/dispatch-engine'/.test(adapterSrc),
            'the adapter must not capture the dispatch-engine module at load time').to.equal(false);
    });

    it('O9-G7: the O-1 boundary does not regress (event-journal shim stays deleted)', () => {
        expect(fs.existsSync(path.join(ORCH_DIR, 'event-journal.js')),
            'the O-1 deleted shim must not come back').to.equal(false);
    });

    it('O9-G8: the O-2/O-3/O-4/O-5/O-7/O-8 boundaries do not regress', () => {
        const p2 = readSource(path.join(RUNTIME_DIR, 'persistence-port.js'));
        expect(requireSpecifiers(p2), 'persistence-port.js must stay zero-require').to.deep.equal([]);
        const p3 = readSource(path.join(RUNTIME_DIR, 'scene-data-port.js'));
        expect(requireSpecifiers(p3), 'scene-data-port.js must stay zero-require').to.deep.equal([]);
        const p4 = readSource(path.join(RUNTIME_DIR, 'placeholder-audio-port.js'));
        expect(requireSpecifiers(p4), 'placeholder-audio-port.js must stay zero-require').to.deep.equal([]);
        const p5 = readSource(path.join(RUNTIME_DIR, 'progress-events-port.js'));
        expect(requireSpecifiers(p5), 'progress-events-port.js must stay zero-require').to.deep.equal([]);
        const p7 = readSource(path.join(RUNTIME_DIR, 'audio-fsm-port.js'));
        expect(requireSpecifiers(p7), 'audio-fsm-port.js must stay zero-require').to.deep.equal([]);
        const p8 = readSource(path.join(RUNTIME_DIR, 'video-fsm-port.js'));
        expect(requireSpecifiers(p8), 'video-fsm-port.js must stay zero-require').to.deep.equal([]);
        const consumers = allTierFiles().filter((f) => readSource(f).includes("require('./persistence-port')") || readSource(f).includes("require('../runtime/persistence-port')"));
        expect(consumers.length, 'at least one tier file must still consume persistence via the O-2 port').to.be.greaterThan(0);
        // Tier files still require ZERO ../book modules (O-3), ZERO
        // placeholder-audio host requires (O-4), ZERO progress host
        // requires (O-5), ZERO audio/video-orchestrator host requires
        // (O-7/O-8).
        const offenders = [];
        for (const file of allTierFiles()) {
            for (const s of requireSpecifiers(readSource(file))) {
                if (s === '../book' || s === '../../book' || s === './book' ||
                    s.startsWith('../book/') || s.startsWith('../../book/') ||
                    s.includes('@animastor/vbook-runtime') ||
                    s.endsWith('services/placeholder-audio') ||
                    s.endsWith('services/progress-pubsub.cjs') || s.endsWith('services/progress-pubsub') ||
                    s.endsWith('services/generation-progress') ||
                    s.endsWith('services/audio-orchestrator') ||
                    s.endsWith('services/video-orchestrator')) {
                    offenders.push(`${rel(file)} -> ${s}`);
                }
            }
        }
        expect(offenders, 'O-3 book, O-4 placeholder-audio, O-5 progress, O-7 audio-FSM and O-8 video-FSM boundaries must stay closed').to.deep.equal([]);
        const rootSrc = readSource(path.join(BACKEND_SRC, 'backend.cjs')).replace(/\s+/g, ' ');
        for (const wire of ['setPersistencePort(', 'setSceneDataPort(', 'setPlaceholderAudioPort(', 'setProgressEventsPort(', 'setAudioFsmPort(', 'setVideoFsmPort(']) {
            expect(rootSrc.indexOf(wire), `backend.cjs must still wire ${wire}`).to.be.greaterThan(-1);
        }
    });

    it('O9-G9: runtime → orchestration stays 0 (S-5 direction untouched)', () => {
        for (const file of listSourceFiles(RUNTIME_DIR)) {
            const specs = requireSpecifiers(readSource(file));
            expect(specs.filter((s) => s.startsWith('../orchestration')),
                `${rel(file)} must not require orchestration directly (S-5 parity)`).to.deep.equal([]);
        }
    });

    it('O9-G10: the adapter is the single bridge — no new dispatch-engine consumers appeared; the port never widens into lease cancellation', () => {
        // Outside the two tiers, the dispatch-engine consumers are frozen at
        // the pre-O-9 measured set (routes, entity-cleanup, backend.cjs,
        // backend tests… the adapter's own edge is the only new one O-9
        // introduced among SRC files). Resolve specifiers so same-directory
        // requires are not missed.
        const { resolveSpecifier } = require('./helpers');
        const consumers = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            if (file === ENGINE_FILE) continue;
            for (const spec of requireSpecifiers(readSource(file))) {
                const target = resolveSpecifier(file, spec);
                if (target === ENGINE_FILE) consumers.push(rel(file));
            }
        }
        // The frozen pre-O-9 dispatch-engine consumer set (the tier files
        // keep their OTHER dispatch-engine deps — lease ops, dispatchStage,
        // finalize…; only the two clearHubDispatches CALL SITES moved to the
        // port, checked in O9-G1) + the O-9 adapter bridge.
        expect([...new Set(consumers)].sort(), 'the frozen pre-O-9 host consumer set + the O-9 adapter bridge').to.deep.equal([
            'backend/src/backend.cjs',
            'backend/src/image/iu-processor.js',
            'backend/src/orchestration/orchestrator.js',
            'backend/src/orchestration/scene-callbacks.js',
            'backend/src/routes/book/generation-routes.cjs',
            'backend/src/routes/generation-routes.cjs',
            'backend/src/runtime/reconciliation-engine.js',
            'backend/src/runtime/runtime-loop.js',
            'backend/src/runtime/runtime-scheduler.js',
            'backend/src/services/task-handler.cjs',
            'backend/src/services/video-orchestrator.js',
            'backend/src/storage/hub-cancel-adapter.js',
        ]);
        // The port module itself must not be required by dispatch-engine
        // (dependency direction: tier → port ← adapter → engine only).
        const engineSpecs = requireSpecifiers(readSource(ENGINE_FILE));
        expect(engineSpecs.filter((s) => /hub-cancel/.test(s)),
            'dispatch-engine must not know the port/adapter (no reverse edge)').to.deep.equal([]);
    });

});
