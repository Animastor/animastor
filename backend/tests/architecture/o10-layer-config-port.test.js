// ======================================================
// O-10 ARCHITECTURE GUARDS — LayerConfigPort extraction seam
// ======================================================
// Freezes the O-10 state of docs/architecture/generation-module-extraction-
// reconnaissance.md §32.27: runtime/** and orchestration/** consume the
// per-book layer-config host service ONLY through
// runtime/layer-config-port.js (tier-owned contract); the host adapter
// (storage/layer-config-adapter.js) owns the service channel
// (services/layer-config.js — the `animastor:layer-config:*` key grammar,
// the normalize/clamp pipeline, the durable book.json recovery scan).
// Composition root: backend.cjs.
//
// The tier-local RAW Redis reads of `animastor:layer-config:*`
// (reconciliation-engine video-stall threshold, scene-window
// isWindowComplete/isSceneWindowDone, runtime-scheduler getLayerConfig)
// are NOT part of the port — they are bespoke partial-parse reads of an
// injected redis parameter, not host-service edges; O10-G3 pins their
// count so the seam decision stays measurable.
//
// This suite TIGHTENS the reconnaissance baseline:
//   O10-G1 zero tier requires of services/layer-config (static scan);
//   O10-G2 the port is a zero-require contract with no host-service
//          knowledge (no Redis key, no BOOKS_DIR, no normalize/clamp);
//   O10-G3 the port op set stays minimal: the exact measured set is TWO
//          ops — get, restoreFromBooks; every declared op has a live
//          tier consumer;
//   O10-G4 no layer-config implementation leakage through the port or
//          adapter surface (frozen two-op adapter export set; the
//          adapter delegates to services/layer-config only);
//   O10-G5 the composition root wires the adapter BEFORE the first
//          top-level tier require (backend.cjs + test bindings mirror,
//          order O-2 → … → O-9 → O-10);
//   O10-G6 no lazy/dynamic layer-config bypass around the port (tier
//          proximity scan) + the adapter keeps call-time lazy
//          resolution (require.cache stubbing parity);
//   O10-G7 the O-1 boundary does not regress (shim stays deleted);
//   O10-G8 the O-2/O-3/O-4/O-5/O-7/O-8/O-9 boundaries do not regress
//          (ports stay zero-require, wires stay present);
//   O10-G9 runtime → orchestration stays 0 (S-5 direction untouched);
//   O10-G10 the adapter is the single bridge — the services/layer-config
//          consumer set outside the tiers stays at the frozen host set
//          (routes, agent services, storage barrel, backend.cjs), and
//          the port never widens into host CRUD (no set/getChunkSize/
//          persistToBook/normalize in the port OPS).
//
// Non-duplication note: requires of services/layer-config OUTSIDE the
// two tiers (routes/generation-routes.cjs, routes/book/*,
// services/agent/**, storage/index.js barrel, backend.cjs, backend
// tests) stay host-side by design — O-10 covers only the
// runtime/orchestration seam. The O-G series (runtime-orchestration-
// recon) pins the tier-wide env/Redis/HTTP baselines; this suite adds
// only the tier-level tightening O-10 introduced.
//
// Docs: generation-module-extraction-reconnaissance.md §32.27 (O-10)
// ======================================================

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const {
    BACKEND_SRC,
    listSourceFiles,
    readSource,
    requireSpecifiers,
    resolveSpecifier,
    rel,
} = require('./helpers');

const RUNTIME_DIR = path.join(BACKEND_SRC, 'runtime');
const ORCH_DIR = path.join(BACKEND_SRC, 'orchestration');
const PORT_FILE = path.join(RUNTIME_DIR, 'layer-config-port.js');
const ADAPTER_FILE = path.join(BACKEND_SRC, 'storage', 'layer-config-adapter.js');
const SERVICE_FILE = path.join(BACKEND_SRC, 'services', 'layer-config.js');
const TEST_BINDINGS_FILE = path.join(BACKEND_SRC, '..', 'tests', 'generation-test-bindings.cjs');

function allTierFiles() {
    return [...listSourceFiles(RUNTIME_DIR), ...listSourceFiles(ORCH_DIR)];
}

// Strip line comments and doc-comment continuation lines — boundary
// EXPLANATIONS may mention what the boundary excludes; CODE may not
// (O2-G5/O3-G1/O9-G1 convention: scan the code, not the prose).
function codeOnly(src) {
    return src.split('\n')
        .map((line) => line.replace(/(^|\s)\/\/.*$/, '').replace(/^\s*\*.*$/, ''))
        .join('\n');
}

describe('§32.27 O-10 guards: per-book layer config reaches the tiers only via the LayerConfigPort', () => {

    it('O10-G1: the two tiers require ZERO services/layer-config modules (static scan)', () => {
        const offenders = [];
        for (const file of allTierFiles()) {
            for (const s of requireSpecifiers(readSource(file))) {
                if (s.endsWith('services/layer-config') || s.endsWith('../layer-config') ||
                    s.includes('services/layer-config.js')) {
                    offenders.push(`${rel(file)} -> ${s}`);
                }
            }
        }
        expect(offenders, 'runtime/** + orchestration/** must consume layer config only via runtime/layer-config-port').to.deep.equal([]);
    });

    it('O10-G2: the port is a zero-require contract with no host-service knowledge', () => {
        const src = readSource(PORT_FILE);
        expect(requireSpecifiers(src), 'layer-config-port.js must require nothing (O-2..O-9 port convention)').to.deep.equal([]);
        const code = codeOnly(src);
        expect(code, 'the port must never know the Redis key grammar').to.not.include('animastor:layer-config');
        expect(code, 'the port must never know the books root').to.not.include('BOOKS_DIR');
        expect(code, 'the port must never know the clamp pipeline').to.not.include('normalize');
        expect(code, 'the port must never hardcode the host module path in code').to.not.include("require('../services/layer-config')");
    });

    it('O10-G3: the port op set stays minimal — two ops, declared and consumed live', () => {
        const portSrc = readSource(PORT_FILE);
        const opBlock = portSrc.match(/const OPS = \[([\s\S]*?)\];/);
        expect(opBlock, 'OPS list must stay declarative').to.not.be.null;
        const declaredOps = (opBlock[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1));
        // The measured O-10 operation set is exactly TWO ops (§32.27).
        expect(declaredOps, 'the frozen O-10 contract').to.deep.equal(['get', 'restoreFromBooks']);
        // Live consumption: every declared op resolves through the port
        // resolver at a real tier call site.
        const liveOps = new Set();
        for (const file of allTierFiles()) {
            if (rel(file) === 'backend/src/runtime/layer-config-port.js') continue;
            const src = codeOnly(readSource(file));
            for (const m of src.match(/layerConfigOp\(\s*'([^']+)'\s*\)/g) || []) {
                liveOps.add(m.match(/layerConfigOp\(\s*'([^']+)'/)[1]);
            }
        }
        expect([...liveOps].sort(), 'every declared op must be consumed live through the port').to.deep.equal(['get', 'restoreFromBooks']);
        // And no undeclared op may be resolved through the port.
        const offenders = [];
        for (const file of allTierFiles()) {
            if (rel(file) === 'backend/src/runtime/layer-config-port.js') continue;
            const src = codeOnly(readSource(file));
            for (const m of src.match(/layerConfigOp\(\s*'([^']+)'\s*\)/g) || []) {
                const op = m.match(/layerConfigOp\(\s*'([^']+)'/)[1];
                if (!declaredOps.includes(op)) offenders.push(`${rel(file)} -> ${op}`);
            }
        }
        expect(offenders, 'tier layer-config calls must be declared in the port OPS list').to.deep.equal([]);
    });

    it('O10-G4: no layer-config implementation leakage through the port or adapter surface', () => {
        const portSrc = codeOnly(readSource(PORT_FILE));
        // The port must not know host-service internals or host CRUD ops.
        for (const banned of ['animastor:layer-config', 'BOOKS_DIR', 'getChunkSize', 'persistToBook', 'SCOPES', 'ANALYSIS_MODES', 'DEFAULTS', 'layerConfigService']) {
            expect(portSrc, `the port must not know host internals (${banned})`).to.not.include(banned);
        }
        // The adapter must NOT grow exports silently: only the two frozen
        // ops may exist (no whole-service passthrough).
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
        expect(exportedOps.sort(), 'the frozen O-10 adapter surface').to.deep.equal(['get', 'restoreFromBooks']);
        // The adapter delegates to services/layer-config ONLY.
        const adapterCode = codeOnly(adapterSrc);
        expect(adapterCode, 'the adapter must reach the host channel through services/layer-config').to.include("require('../services/layer-config')");
        for (const banned of ['redis.set', 'redis.get', 'fs.', 'BOOKS_DIR', 'getChunkSize', 'persistToBook']) {
            expect(adapterCode, `the adapter must not re-implement the service (${banned})`).to.not.include(banned);
        }
        // The host channel keeps its full public API unchanged (O-10 removed
        // tier require edges only — routes/agent/test consumers keep working;
        // the export is pinned so a silent rename fails).
        const serviceSrc = readSource(SERVICE_FILE);
        for (const op of ['module.exports', 'get', 'set', 'restoreFromBooks', 'getChunkSize', 'SCOPES']) {
            expect(serviceSrc, `services/layer-config must keep exporting ${op}`).to.include(op);
        }
    });

    it('O10-G5: the composition root wires the adapter before the first top-level tier require', () => {
        const rootSrc = readSource(path.join(BACKEND_SRC, 'backend.cjs')).replace(/\s+/g, ' ');
        const wireIdx = rootSrc.indexOf('setLayerConfigPort(');
        expect(wireIdx, 'backend.cjs must call setLayerConfigPort(...)').to.be.greaterThan(-1);
        // First TOP-LEVEL tier require: strip lazy `=> require(...)` arrow
        // bodies (they execute at dispatch time, long after module
        // evaluation), then exclude the port contract modules themselves
        // (zero side effects, loadable before wiring).
        const topLevelSrc = rootSrc.replace(/\)\s*=>\s*require\([^)]*\)/g, '=>LAZY');
        const firstTierRequire = topLevelSrc.search(/require\('\.\/(?:runtime|orchestration)(?:\/(?!persistence-port|scene-data-port|placeholder-audio-port|progress-events-port|audio-fsm-port|video-fsm-port|hub-cancel-port|layer-config-port)|')/);
        expect(firstTierRequire, 'backend.cjs must require at least one tier module at top level').to.be.greaterThan(-1);
        expect(wireIdx, 'wiring must happen BEFORE the first top-level runtime/orchestration require').to.be.lessThan(firstTierRequire);
        expect(/require\(\s*'\.\/storage\/layer-config-adapter'\s*\)/.test(rootSrc),
            'the wired adapter must be the host-side storage adapter').to.equal(true);
        // Wiring order stability: O-2 → O-3 → O-4 → O-5 → O-7 → O-8 → O-9 → O-10
        // (composition-root sequence).
        const o2Idx = rootSrc.indexOf('setPersistencePort(');
        const o3Idx = rootSrc.indexOf('setSceneDataPort(');
        const o4Idx = rootSrc.indexOf('setPlaceholderAudioPort(');
        const o5Idx = rootSrc.indexOf('setProgressEventsPort(');
        const o7Idx = rootSrc.indexOf('setAudioFsmPort(');
        const o8Idx = rootSrc.indexOf('setVideoFsmPort(');
        const o9Idx = rootSrc.indexOf('setHubCancelPort(');
        expect(o2Idx, 'backend.cjs must still wire the O-2 persistence adapter').to.be.greaterThan(-1);
        expect(o3Idx, 'backend.cjs must still wire the O-3 scene-data adapter').to.be.greaterThan(-1);
        expect(o4Idx, 'backend.cjs must still wire the O-4 placeholder-audio adapter').to.be.greaterThan(-1);
        expect(o5Idx, 'backend.cjs must still wire the O-5 progress-events adapter').to.be.greaterThan(-1);
        expect(o7Idx, 'backend.cjs must still wire the O-7 audio-fsm adapter').to.be.greaterThan(-1);
        expect(o8Idx, 'backend.cjs must still wire the O-8 video-fsm adapter').to.be.greaterThan(-1);
        expect(o9Idx, 'backend.cjs must still wire the O-9 hub-cancel adapter').to.be.greaterThan(-1);
        expect(wireIdx).to.be.greaterThan(o9Idx);
        expect(o9Idx).to.be.greaterThan(o8Idx);
        expect(o8Idx).to.be.greaterThan(o7Idx);
        expect(o7Idx).to.be.greaterThan(o5Idx);
        expect(o5Idx).to.be.greaterThan(o4Idx);
        expect(o4Idx).to.be.greaterThan(o3Idx);
        expect(o3Idx).to.be.greaterThan(o2Idx);

        // Test-bindings mirror: the mocharc require chain must wire the port
        // too (same order discipline), or plain tier requires in tests would
        // fail-fast on an unwired port.
        const bindingsSrc = readSource(TEST_BINDINGS_FILE);
        const bWire = bindingsSrc.indexOf('setLayerConfigPort(');
        expect(bWire, 'generation-test-bindings.cjs must mirror the O-10 wiring').to.be.greaterThan(-1);
        expect(bindingsSrc.indexOf('setHubCancelPort('), 'bindings must wire O-9 before O-10').to.be.lessThan(bWire);
    });

    it('O10-G6: no lazy/dynamic layer-config bypass around the port', () => {
        // Tier proximity scan: no tier file may reach the layer-config
        // service by any channel except the port — i.e. a dynamic
        // require(identifier) whose surrounding text mentions layer-config
        // restoration, or a `.restoreFromBooks(`/service-handle `.get(`
        // call on a non-port handle.
        const offenders = [];
        for (const file of allTierFiles()) {
            const src = readSource(file);
            const dyn = src.match(/require\(\s*[A-Za-z_$][\w$.]*\s*\)/g) || [];
            for (const call of dyn) {
                const idx = src.indexOf(call);
                const near = src.slice(Math.max(0, idx - 300), idx + 300);
                if (/layer[-_]?config|restoreFromBooks/.test(near)) {
                    offenders.push(`${rel(file)} -> dynamic ${call}`);
                }
            }
        }
        expect(offenders, 'no smuggled require(identifier) may re-introduce a direct layer-config service edge').to.deep.equal([]);

        // The tier-local RAW Redis reads of `animastor:layer-config:*` stay
        // pinned at the measured O-10 inventory (bespoke partial-parse
        // reads of an injected redis parameter — not host-service edges;
        // they must not grow silently, the seam decision stays measurable).
        const rawReads = [];
        for (const file of allTierFiles()) {
            const src = codeOnly(readSource(file));
            const count = (src.match(/animastor:layer-config:/g) || []).length;
            if (count > 0) rawReads.push(`${rel(file)} x${count}`);
        }
        expect(rawReads, 'the pinned raw-Redis layer-config read set (§32.27: deliberately NOT in the port)').to.deep.equal([
            'backend/src/runtime/reconciliation-engine.js x1',
            'backend/src/runtime/runtime-scheduler.js x1',
            'backend/src/runtime/scene-window.js x3',
        ]);

        // The adapter resolves the host channel via a lazy call-time
        // resolver (the single channel — require.cache stubbing discipline);
        // it must not capture the module at load time.
        const adapterSrc = readSource(ADAPTER_FILE);
        expect(adapterSrc, 'the adapter must keep call-time (lazy) service resolution for test-stub parity')
            .to.include("() => require('../services/layer-config')");
        expect(/const\s+\w+\s*=\s*require\('\.\.\/services\/layer-config'/.test(adapterSrc),
            'the adapter must not capture the service module at load time').to.equal(false);
    });

    it('O10-G7: the O-1 boundary does not regress (event-journal shim stays deleted)', () => {
        expect(fs.existsSync(path.join(ORCH_DIR, 'event-journal.js')),
            'the O-1 deleted shim must not come back').to.equal(false);
    });

    it('O10-G8: the O-2/O-3/O-4/O-5/O-7/O-8/O-9 boundaries do not regress', () => {
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
        const p9 = readSource(path.join(RUNTIME_DIR, 'hub-cancel-port.js'));
        expect(requireSpecifiers(p9), 'hub-cancel-port.js must stay zero-require').to.deep.equal([]);
        const consumers = allTierFiles().filter((f) => readSource(f).includes("require('./persistence-port')") || readSource(f).includes("require('../runtime/persistence-port')"));
        expect(consumers.length, 'at least one tier file must still consume persistence via the O-2 port').to.be.greaterThan(0);
        // Tier files still require ZERO ../book modules (O-3), ZERO
        // placeholder-audio host requires (O-4), ZERO progress host
        // requires (O-5), ZERO audio/video-orchestrator host requires
        // (O-7/O-8), and keep ZERO dispatch-engine.clearHubDispatches call
        // sites (O-9).
        const offenders = [];
        for (const file of allTierFiles()) {
            const src = codeOnly(readSource(file));
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
            const hubCancelCalls = src.match(/\.clearHubDispatches\s*\(/g) || [];
            for (let i = 0; i < hubCancelCalls.length; i++) {
                offenders.push(`${rel(file)} (clearHubDispatches call)`);
            }
        }
        expect(offenders, 'O-3 book, O-4 placeholder-audio, O-5 progress, O-7 audio-FSM, O-8 video-FSM and O-9 hub-cancel boundaries must stay closed').to.deep.equal([]);
        const rootSrc = readSource(path.join(BACKEND_SRC, 'backend.cjs')).replace(/\s+/g, ' ');
        for (const wire of ['setPersistencePort(', 'setSceneDataPort(', 'setPlaceholderAudioPort(', 'setProgressEventsPort(', 'setAudioFsmPort(', 'setVideoFsmPort(', 'setHubCancelPort(']) {
            expect(rootSrc.indexOf(wire), `backend.cjs must still wire ${wire}`).to.be.greaterThan(-1);
        }
    });

    it('O10-G9: runtime → orchestration stays 0 (S-5 direction untouched)', () => {
        for (const file of listSourceFiles(RUNTIME_DIR)) {
            const specs = requireSpecifiers(readSource(file));
            expect(specs.filter((s) => s.startsWith('../orchestration')),
                `${rel(file)} must not require orchestration directly (S-5 parity)`).to.deep.equal([]);
        }
    });

    it('O10-G10: the adapter is the single bridge — the frozen host consumer set; the port never widens into host CRUD', () => {
        // Outside the two tiers, the services/layer-config consumers are
        // frozen at the pre-O-10 measured host set (routes, agent
        // services, the storage barrel, backend.cjs) + the O-10 adapter
        // bridge. Resolve specifiers so same-directory requires are not
        // missed.
        const consumers = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            if (file === SERVICE_FILE) continue;
            for (const spec of requireSpecifiers(readSource(file))) {
                const target = resolveSpecifier(file, spec);
                if (target === SERVICE_FILE) consumers.push(rel(file));
            }
        }
        expect([...new Set(consumers)].sort(), 'the frozen pre-O-10 host consumer set + the O-10 adapter bridge (routes consume via deps injection, not require)').to.deep.equal([
            'backend/src/services/agent/bootstrap.js',
            'backend/src/services/agent/pipeline-runner.js',
            'backend/src/storage/index.js',
            'backend/src/storage/layer-config-adapter.js',
        ]);
        // The port module itself must not be required by the host service
        // (dependency direction: tier → port ← adapter → service only).
        const serviceSpecs = requireSpecifiers(readSource(SERVICE_FILE));
        expect(serviceSpecs.filter((s) => /layer-config-port/.test(s)),
            'services/layer-config must not know the port/adapter (no reverse edge)').to.deep.equal([]);
        // The port OPS never widen into host CRUD or vocabulary.
        const portSrc = readSource(PORT_FILE);
        const opBlock = portSrc.match(/const OPS = \[([\s\S]*?)\];/);
        const declaredOps = (opBlock[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1));
        for (const banned of ['set', 'getChunkSize', 'persistToBook', 'normalize', 'key', 'restoreFromBooks']) {
            if (banned === 'restoreFromBooks') continue;
            expect(declaredOps, `the port must not grow host CRUD (${banned})`).to.not.include(banned);
        }
    });

});
