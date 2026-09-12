// ======================================================
// O-5 ARCHITECTURE GUARDS — ProgressEventsPort extraction seam
// ======================================================
// Freezes the O-5 state of docs/architecture/generation-module-extraction-
// reconnaissance.md §32.7 (O-P4) and §32.14 step O-5: runtime/** and
// orchestration/** consume progress operations ONLY through
// runtime/progress-events-port.js (tier-owned contract); the host
// adapter (storage/progress-events-adapter.js) owns the two Redis
// progress host services (services/progress-pubsub.cjs — the SSE
// pub/sub channel — and services/generation-progress.js — the
// generation task registry). Composition root: backend.cjs.
//
// This suite TIGHTENS the reconnaissance baseline:
//   O5-G1  zero `../services/progress-pubsub` and `../services/
//          generation-progress` requires from the two tiers (static scan);
//   O5-G2  the port is a zero-require contract with no host-implementation
//          knowledge (no Redis key strings, no pub/sub transport, no TTLs);
//   O5-G3  the port op set stays minimal: every tier progressEventsOp('…')
//          call is declared in the port OPS list AND every declared op has
//          a live tier consumer (no CRUD "for later");
//   O5-G4  no progress implementation leakage through the port or adapter
//          surface (frozen four-op adapter export set);
//   O5-G5  the composition root wires the adapter BEFORE the first
//          top-level tier require (backend.cjs + test bindings mirror);
//   O5-G6  no lazy/dynamic progress bypass around the port (tier
//          dynamic-require proximity scan + adapter lazy-resolution stays
//          the single channel);
//   O5-G7  the O-1 boundary does not regress (shim stays deleted);
//   O5-G8  the O-2/O-3/O-4 boundaries do not regress;
//   O5-G9  runtime → orchestration stays 0 (S-5 direction untouched);
//   O5-G10 the O-G9 env baseline does not grow (progress wiring does not
//          smuggle env/config into the tiers).
//
// Non-duplication note: requires of the progress host services OUTSIDE
// the two tiers (routes SSE contour, import-routes, window-generator,
// backend.cjs DI, host tests) stay host-side by design — O-P4 covers only
// the runtime/orchestration seam. The O-G series (runtime-orchestration-
// recon) pins the tier-wide env/Redis/HTTP baselines; this suite adds
// only the tier-level tightening O-5 introduced.
//
// Docs: generation-module-extraction-reconnaissance.md §32.14 step O-5 (DONE)
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
const PORT_FILE = path.join(RUNTIME_DIR, 'progress-events-port.js');
const ADAPTER_FILE = path.join(BACKEND_SRC, 'storage', 'progress-events-adapter.js');
const PUBSUB_FILE = path.join(BACKEND_SRC, 'services', 'progress-pubsub.cjs');
const REGISTRY_FILE = path.join(BACKEND_SRC, 'services', 'generation-progress.js');
const TEST_BINDINGS_FILE = path.join(BACKEND_SRC, '..', 'tests', 'generation-test-bindings.cjs');

function allTierFiles() {
    return [...listSourceFiles(RUNTIME_DIR), ...listSourceFiles(ORCH_DIR)];
}

// Strip line comments and doc-comment continuation lines — boundary
// EXPLANATIONS may mention what the boundary excludes; CODE may not
// (O2-G5/O3-G1/O4-G1 convention: scan the code, not the prose).
function codeOnly(src) {
    return src.split('\n')
        .map((line) => line.replace(/(^|\s)\/\/.*$/, '').replace(/^\s*\*.*$/, ''))
        .join('\n');
}

// Static progress host-service requires in a tier file.
function staticProgressRequires(file) {
    const hits = [];
    for (const s of requireSpecifiers(readSource(file))) {
        if (s === '../services/progress-pubsub.cjs' || s === '../services/progress-pubsub' ||
            s === '../../services/progress-pubsub.cjs' || s === '../../services/progress-pubsub' ||
            s.endsWith('services/progress-pubsub') || s.endsWith('services/progress-pubsub.cjs') ||
            s === '../services/generation-progress' || s === '../../services/generation-progress' ||
            s === './services/generation-progress' || s.endsWith('services/generation-progress')) {
            hits.push(s);
        }
    }
    return hits;
}

// Identifier-based require calls in a tier file whose surrounding text
// (±300 chars) mentions the progress domain — the shape a smuggled
// `require(someProgressPath)` would take (S5-A/O2-G1/O4-G6 proximity
// scan convention).
function dynamicProgressRequires(file) {
    const src = readSource(file);
    const dyn = src.match(/require\(\s*[A-Za-z_$][\w$.]*\s*\)/g) || [];
    return dyn.filter((call) => {
        const idx = src.indexOf(call);
        const near = src.slice(Math.max(0, idx - 300), idx + 300);
        return /progress[-_](pubsub|events)|generation[-_]progress/.test(near);
    });
}

describe('§32.7 O-5 guards: progress events arrive only via the ProgressEventsPort', () => {

    it('O5-G1: the two tiers require ZERO progress host-service modules (static scan)', () => {
        const offenders = [];
        for (const file of allTierFiles()) {
            if (rel(file) === 'backend/src/runtime/progress-events-port.js') continue;
            for (const s of staticProgressRequires(file)) {
                offenders.push(`${rel(file)} -> ${s}`);
            }
        }
        expect(offenders, 'runtime/** + orchestration/** must consume progress only via runtime/progress-events-port (host services stay host-side)').to.deep.equal([]);
    });

    it('O5-G2: the port is a zero-require contract with no host-implementation knowledge', () => {
        const src = readSource(PORT_FILE);
        expect(requireSpecifiers(src), 'progress-events-port.js must require nothing (S-6/O-2 port convention)').to.deep.equal([]);
        const code = codeOnly(src);
        expect(code, 'the port must never name the pub/sub host service path').to.not.include('progress-pubsub');
        expect(code, 'the port must never name the task-registry host service path').to.not.include('generation-progress');
        expect(code, 'the port must never compose a Redis channel/key string').to.not.match(/animastor:(progress|generation-progress)/);
        expect(code, 'the port must never mention Redis client APIs').to.not.match(/\b(redis\.(publish|hset|hgetall|hdel)|\.publish\()/);
        expect(code, 'the port must never mention pub/sub transport knowledge').to.not.match(/\b(SSE|EventSource|pub\/sub|pubsub)\b/);
    });

    it('O5-G3: the port op set stays minimal — every tier progressEventsOp(…) call is declared and live', () => {
        const portSrc = readSource(PORT_FILE);
        const opBlock = portSrc.match(/const OPS = \[([\s\S]*?)\];/);
        expect(opBlock, 'OPS list must stay declarative').to.not.be.null;
        const declaredOps = new Set(
            (opBlock[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1))
        );
        const usedOps = new Set();
        for (const file of allTierFiles()) {
            if (rel(file) === 'backend/src/runtime/progress-events-port.js') continue;
            const src = codeOnly(readSource(file));
            for (const m of src.match(/progressEventsOp\('([^']+)'\)/g) || []) {
                usedOps.add(m.slice("progressEventsOp('".length, -2));
            }
        }
        const undeclared = [...usedOps].filter((op) => !declaredOps.has(op)).sort();
        expect(undeclared, 'tier progressEventsOp() calls must be declared in the port OPS list').to.deep.equal([]);
        // Minimality in the other direction: no op may be declared without a
        // live tier consumer (no CRUD "for later").
        const unused = [...declaredOps].filter((op) => !usedOps.has(op)).sort();
        expect(unused, 'every declared op must have a live tier consumer').to.deep.equal([]);
        // The measured O-5 operation set is exactly four ops (§32.7 O-P4).
        expect([...declaredOps].sort(), 'the frozen O-5 contract').to.deep.equal([
            'getSceneTaskState',
            'hasActiveTasks',
            'publishProgress',
            'reconcileCompletedTasks',
        ]);
    });

    it('O5-G4: no progress implementation leakage through the port or adapter surface', () => {
        const portSrc = codeOnly(readSource(PORT_FILE));
        // The adapter is the only place allowed to know the host services;
        // the port itself must not name their internals.
        for (const banned of ['createTasks', 'listTasks', 'getTask', 'updateTask', 'markCompleted', 'markCancelled', 'removeTask', 'getActiveTasksByType', 'getSceneTaskStateRaw', 'channel']) {
            expect(portSrc, `the port must not know host-service internals (${banned})`).to.not.include(banned);
        }
        // The adapter must NOT grow exports silently: only the four frozen
        // ops may exist (no whole-service passthrough).
        const adapterSrc = readSource(ADAPTER_FILE);
        const exportBlock = adapterSrc.match(/module\.exports = \{([\s\S]*?)\};/);
        expect(exportBlock, 'adapter exports must stay declarative').to.not.be.null;
        const exportedOps = (exportBlock[1].match(/[a-zA-Z_]\w*(?=,|\s*$)/gm) || [])
            .map((s) => s.trim()).filter(Boolean);
        expect(exportedOps.sort()).to.deep.equal([
            'getSceneTaskState',
            'hasActiveTasks',
            'publishProgress',
            'reconcileCompletedTasks',
        ]);
        // The host services keep their full public surface unchanged (O-5
        // removed tier consumers only — routes/window-generator consumers
        // keep working; the export sets are pinned so a silent rename fails).
        const pubsubSrc = readSource(PUBSUB_FILE);
        for (const op of ['channel', 'publishProgress']) {
            expect(pubsubSrc, `the pubsub host service must keep exporting ${op}`).to.include(op);
        }
        const registrySrc = readSource(REGISTRY_FILE);
        for (const op of ['createTasks', 'getSceneTaskState', 'hasActiveTasks', 'reconcileCompletedTasks']) {
            expect(registrySrc, `the task-registry host service must keep exporting ${op}`).to.include(op);
        }
    });

    it('O5-G5: the composition root wires the adapter before the first top-level tier require', () => {
        const rootSrc = readSource(path.join(BACKEND_SRC, 'backend.cjs')).replace(/\s+/g, ' ');
        const wireIdx = rootSrc.indexOf('setProgressEventsPort(');
        expect(wireIdx, 'backend.cjs must call setProgressEventsPort(...)').to.be.greaterThan(-1);
        // First TOP-LEVEL tier require: strip lazy `=> require(...)` arrow
        // bodies (they execute at dispatch time, long after module
        // evaluation), then exclude the port contract modules themselves
        // (zero side effects, loadable before wiring).
        const topLevelSrc = rootSrc.replace(/\)\s*=>\s*require\([^)]*\)/g, '=>LAZY');
        const firstTierRequire = topLevelSrc.search(/require\('\.\/(?:runtime|orchestration)(?:\/(?!persistence-port|scene-data-port|placeholder-audio-port|progress-events-port)|')/);
        expect(firstTierRequire, 'backend.cjs must require at least one tier module at top level').to.be.greaterThan(-1);
        expect(wireIdx, 'wiring must happen BEFORE the first top-level runtime/orchestration require').to.be.lessThan(firstTierRequire);
        expect(/require\(\s*'\.\/storage\/progress-events-adapter'\s*\)/.test(rootSrc),
            'the wired adapter must be the host-side storage adapter').to.equal(true);
        // Wiring order stability: O-2 → O-3 → O-4 → O-5 (composition-root sequence).
        const o2Idx = rootSrc.indexOf('setPersistencePort(');
        const o3Idx = rootSrc.indexOf('setSceneDataPort(');
        const o4Idx = rootSrc.indexOf('setPlaceholderAudioPort(');
        expect(o2Idx, 'backend.cjs must still wire the O-2 persistence adapter').to.be.greaterThan(-1);
        expect(o3Idx, 'backend.cjs must still wire the O-3 scene-data adapter').to.be.greaterThan(-1);
        expect(o4Idx, 'backend.cjs must still wire the O-4 placeholder-audio adapter').to.be.greaterThan(-1);
        expect(wireIdx).to.be.greaterThan(o4Idx);
        expect(o4Idx).to.be.greaterThan(o3Idx);
        expect(o3Idx).to.be.greaterThan(o2Idx);

        // Test-bindings mirror: the mocharc require chain must wire the port
        // too (same order discipline), or plain tier requires in tests would
        // fail-fast on an unwired port.
        const bindingsSrc = readSource(TEST_BINDINGS_FILE);
        const bWire = bindingsSrc.indexOf('setProgressEventsPort(');
        expect(bWire, 'generation-test-bindings.cjs must mirror the O-5 wiring').to.be.greaterThan(-1);
        expect(bindingsSrc.indexOf('setPlaceholderAudioPort('), 'bindings must wire O-4 before O-5').to.be.lessThan(bWire);
    });

    it('O5-G6: no lazy/dynamic progress bypass around the port', () => {
        // Static + dynamic tier scan: no tier file may reach the progress
        // host services by any channel except the port.
        const offenders = [];
        for (const file of allTierFiles()) {
            if (rel(file) === 'backend/src/runtime/progress-events-port.js') continue;
            for (const d of dynamicProgressRequires(file)) {
                offenders.push(`${rel(file)} -> dynamic ${d}`);
            }
        }
        expect(offenders, 'no smuggled require(identifier) may re-introduce the progress edge').to.deep.equal([]);

        // The adapter resolves the host services via lazy call-time
        // resolvers (the single channel — require.cache stubbing discipline);
        // it must not capture the modules at load time.
        const adapterSrc = readSource(ADAPTER_FILE);
        expect(adapterSrc, 'the adapter must keep call-time (lazy) pubsub resolution for test-stub parity')
            .to.include('() => require(\'../services/progress-pubsub.cjs\')');
        expect(adapterSrc, 'the adapter must keep call-time (lazy) task-registry resolution for test-stub parity')
            .to.include('() => require(\'../services/generation-progress\')');
        expect(/const\s+\w+\s*=\s*require\('\.\.\/services\/(progress-pubsub|generation-progress)'/.test(adapterSrc),
            'the adapter must not capture a host service module at load time').to.equal(false);
    });

    it('O5-G7: the O-1 boundary does not regress (event-journal shim stays deleted)', () => {
        expect(fs.existsSync(path.join(ORCH_DIR, 'event-journal.js')),
            'the O-1 deleted shim must not come back').to.equal(false);
    });

    it('O5-G8: the O-2/O-3/O-4 boundaries do not regress', () => {
        const p2 = readSource(path.join(RUNTIME_DIR, 'persistence-port.js'));
        expect(requireSpecifiers(p2), 'persistence-port.js must stay zero-require').to.deep.equal([]);
        const p3 = readSource(path.join(RUNTIME_DIR, 'scene-data-port.js'));
        expect(requireSpecifiers(p3), 'scene-data-port.js must stay zero-require').to.deep.equal([]);
        const p4 = readSource(path.join(RUNTIME_DIR, 'placeholder-audio-port.js'));
        expect(requireSpecifiers(p4), 'placeholder-audio-port.js must stay zero-require').to.deep.equal([]);
        const consumers = allTierFiles().filter((f) => readSource(f).includes("require('./persistence-port')") || readSource(f).includes("require('../runtime/persistence-port')"));
        expect(consumers.length, 'at least one tier file must still consume persistence via the O-2 port').to.be.greaterThan(0);
        // Tier files still require ZERO ../book modules (O-3) and ZERO
        // placeholder-audio host requires (O-4).
        const offenders = [];
        for (const file of allTierFiles()) {
            for (const s of requireSpecifiers(readSource(file))) {
                if (s === '../book' || s === '../../book' || s === './book' ||
                    s.startsWith('../book/') || s.startsWith('../../book/') ||
                    s.includes('@animastor/vbook-runtime') ||
                    s.endsWith('services/placeholder-audio')) {
                    offenders.push(`${rel(file)} -> ${s}`);
                }
            }
        }
        expect(offenders, 'O-3 book boundary and O-4 placeholder-audio boundary must stay closed').to.deep.equal([]);
        const rootSrc = readSource(path.join(BACKEND_SRC, 'backend.cjs')).replace(/\s+/g, ' ');
        for (const wire of ['setPersistencePort(', 'setSceneDataPort(', 'setPlaceholderAudioPort(']) {
            expect(rootSrc.indexOf(wire), `backend.cjs must still wire ${wire}`).to.be.greaterThan(-1);
        }
    });

    it('O5-G9: runtime → orchestration stays 0 (S-5 direction untouched)', () => {
        for (const file of listSourceFiles(RUNTIME_DIR)) {
            const specs = requireSpecifiers(readSource(file));
            expect(specs.filter((s) => s.startsWith('../orchestration')),
                `${rel(file)} must not require orchestration directly (S-5 parity)`).to.deep.equal([]);
        }
    });

    it('O5-G10: the O-G9 env baseline does not grow (no env/config smuggled via the progress wiring)', () => {
        // The progress port/adapter must not introduce env or runtime-config
        // reads into the tiers (O-P5 stays a separate, later seam).
        const portSrc = codeOnly(readSource(PORT_FILE));
        const adapterSrc = codeOnly(readSource(ADAPTER_FILE));
        for (const src of [portSrc, adapterSrc]) {
            expect(src, 'no process.env access in the seam').to.not.include('process.env');
            expect(src, 'no runtime-config require in the seam').to.not.include('runtime-config');
        }
        // O-G9 baseline (runtime-orchestration-recon) unchanged: zero env
        // reads in runtime/**, the pinned 3 sites in orchestration/**.
        const runtimeOffenders = [];
        for (const file of listSourceFiles(RUNTIME_DIR)) {
            if (/process\.env/.test(readSource(file))) runtimeOffenders.push(rel(file));
        }
        expect(runtimeOffenders, 'runtime env must come only from config/runtime-config (O-P5)').to.deep.equal([]);
    });

});
