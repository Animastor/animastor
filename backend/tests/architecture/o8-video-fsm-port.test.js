// ======================================================
// O-8 ARCHITECTURE GUARDS — VideoFsmPort extraction seam
// ======================================================
// Freezes the O-8 state of docs/architecture/generation-module-extraction-
// reconnaissance.md §32.25: runtime/** and orchestration/** drive the video
// scene FSM ONLY through runtime/video-fsm-port.js (tier-owned contract);
// the host adapter (storage/video-fsm-adapter.js) owns the video-orchestrator
// host service (services/video-orchestrator.js — Redis key grammar, state
// envelope, transition map, group-file validation, merge/source-cap
// pipeline, hub-dedup cleanup). Composition root: backend.cjs. The audio
// FSM (runtime/audio-fsm-port) is deliberately NOT part of this port — the
// O-6 MediaFsmPort rejection stands: two independent FSMs never merge.
//
// This suite TIGHTENS the reconnaissance baseline:
//   O8-G1  zero `../services/video-orchestrator` requires from the two
//          tiers (static scan);
//   O8-G2  the port is a zero-require contract with no host-implementation
//          knowledge (no Redis key strings, no state-envelope encoding, no
//          transition-map internals);
//   O8-G3  the port op set stays minimal: every tier videoFsmOp('…') call is
//          declared in the port OPS list AND every declared op has a live
//          tier consumer (no CRUD "for later") — the exact measured set is
//          13 ops + PHASES;
//   O8-G4  no FSM implementation leakage through the port or adapter surface
//          (frozen 13-op adapter export set; no audio FSM, no key/PREFIX/
//          createState/transitionState internals);
//   O8-G5  the composition root wires the adapter BEFORE the first
//          top-level tier require (backend.cjs + test bindings mirror,
//          order O-2 → O-3 → O-4 → O-5 → O-7 → O-8);
//   O8-G6  no lazy/dynamic video-orchestrator bypass around the port (tier
//          dynamic-require proximity scan + adapter lazy-resolution stays
//          the single channel);
//   O8-G7  the O-1 boundary does not regress (shim stays deleted);
//   O8-G8  the O-2/O-3/O-4/O-5/O-7 boundaries do not regress (ports stay
//          zero-require, wires stay present);
//   O8-G9  runtime → orchestration stays 0 (S-5 direction untouched);
//   O8-G10 the host-side adapter edge is the ONLY new video-orchestrator
//          consumer inside the seam (no new host consumers appeared, the
//          host service keeps its full public API unchanged).
//
// Non-duplication note: requires of the video-orchestrator host service
// OUTSIDE the two tiers (routes/generation-routes.cjs, services/
// task-handler.cjs, backend tests) stay host-side by design — O-8 covers
// only the runtime/orchestration seam. The O-G series (runtime-
// orchestration-recon) pins the tier-wide env/Redis/HTTP baselines; this
// suite adds only the tier-level tightening O-8 introduced.
//
// Docs: generation-module-extraction-reconnaissance.md §32.25 (O-8 DONE)
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
const PORT_FILE = path.join(RUNTIME_DIR, 'video-fsm-port.js');
const ADAPTER_FILE = path.join(BACKEND_SRC, 'storage', 'video-fsm-adapter.js');
const SERVICE_FILE = path.join(BACKEND_SRC, 'services', 'video-orchestrator.js');
const TEST_BINDINGS_FILE = path.join(BACKEND_SRC, '..', 'tests', 'generation-test-bindings.cjs');

function allTierFiles() {
    return [...listSourceFiles(RUNTIME_DIR), ...listSourceFiles(ORCH_DIR)];
}

// Strip line comments and doc-comment continuation lines — boundary
// EXPLANATIONS may mention what the boundary excludes; CODE may not
// (O2-G5/O3-G1/O4-G1/O5-G1/O7-G2 convention: scan the code, not the prose).
function codeOnly(src) {
    return src.split('\n')
        .map((line) => line.replace(/(^|\s)\/\/.*$/, '').replace(/^\s*\*.*$/, ''))
        .join('\n');
}

// Static video-orchestrator requires in a tier file.
function staticVideoOrchRequires(file) {
    const hits = [];
    for (const s of requireSpecifiers(readSource(file))) {
        if (s === '../services/video-orchestrator' || s === '../../services/video-orchestrator' ||
            s === './services/video-orchestrator' || s.endsWith('services/video-orchestrator')) {
            hits.push(s);
        }
    }
    return hits;
}

// Identifier-based require calls in a tier file whose surrounding text
// (±300 chars) mentions the video-FSM domain — the shape a smuggled
// `require(someVideoOrchPath)` would take (S5-A/O2-G1/O4-G6/O5-G6/
// O7-G6 proximity scan convention).
function dynamicVideoOrchRequires(file) {
    const src = readSource(file);
    const dyn = src.match(/require\(\s*[A-Za-z_$][\w$.]*\s*\)/g) || [];
    return dyn.filter((call) => {
        const idx = src.indexOf(call);
        const near = src.slice(Math.max(0, idx - 300), idx + 300);
        return /video[-_]orch|videoFsm|video[-_]fsm/.test(near);
    });
}

describe('§32.25 O-8 guards: the video scene FSM is driven only via the VideoFsmPort', () => {

    it('O8-G1: the two tiers require ZERO video-orchestrator host-service modules (static scan)', () => {
        const offenders = [];
        for (const file of allTierFiles()) {
            for (const s of staticVideoOrchRequires(file)) {
                offenders.push(`${rel(file)} -> ${s}`);
            }
        }
        expect(offenders, 'runtime/** + orchestration/** must drive the video FSM only via runtime/video-fsm-port (the host service stays host-side)').to.deep.equal([]);
    });

    it('O8-G2: the port is a zero-require contract with no host-implementation knowledge', () => {
        const src = readSource(PORT_FILE);
        expect(requireSpecifiers(src), 'video-fsm-port.js must require nothing (O-2..O-7 port convention)').to.deep.equal([]);
        const code = codeOnly(src);
        expect(code, 'the port must never compose the video-orch Redis key prefix').to.not.include('animastor:video-orch');
        expect(code, 'the port must never mention the audio FSM (never merged)').to.not.include('audio-orchestrator');
        expect(code, 'the port must never mention Redis client APIs').to.not.match(/\bredis\.(get|set|del|scan)\b/);
        expect(code, 'the port must never mention storage internals').to.not.match(/\b(PREFIX|createState|transitionState|VALID_TRANSITIONS|MIN_VIDEO_BYTES|mergeSceneVideoGroups)\b/);
    });

    it('O8-G3: the port op set stays minimal — every declared op is consumed, live, through the port', () => {
        const portSrc = readSource(PORT_FILE);
        const opBlock = portSrc.match(/const OPS = \[([\s\S]*?)\];/);
        expect(opBlock, 'OPS list must stay declarative').to.not.be.null;
        const declaredOps = new Set(
            (opBlock[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1))
        );
        // Two sanctioned consumption styles (both measured in the wild):
        //   1. `videoFsmOp('op')(...)` — per-call resolver;
        //   2. `const h = require('./video-fsm-port'…).videoFsm()` then
        //      `h.op(...)` — the reconciliation optional-load legs and the
        //      scene-orchestrator dispatch resolve the whole adapter ONCE
        //      through the port, then use it 1:1 (the try/catch
        //      optional-load semantics live around the videoFsm()
        //      resolution, never around a raw host require).
        const usedOps = new Set();
        const handleRe = /(\w+)\s*=\s*require\([^)]*video-fsm-port['"]?\)\.videoFsm\(\)/g;
        for (const file of allTierFiles()) {
            if (rel(file) === 'backend/src/runtime/video-fsm-port.js') continue;
            const src = codeOnly(readSource(file));
            for (const m of src.match(/videoFsmOp\('([^']+)'\)/g) || []) {
                usedOps.add(m.slice("videoFsmOp('".length, -2));
            }
            // Whole-adapter handle (reconciliation optional-load legs +
            // scene-orchestrator dispatch):
            // `const videoOrch = require('./video-fsm-port').videoFsm()` —
            // then every `videoOrch.op(` call is a port op consumption.
            let hm;
            while ((hm = handleRe.exec(src)) !== null) {
                const callRe = new RegExp(`\\b${hm[1]}\\.(\\w+)\\s*\\(`, 'g');
                let cm;
                while ((cm = callRe.exec(src)) !== null) {
                    usedOps.add(cm[1]);
                }
            }
        }
        const undeclared = [...usedOps].filter((op) => !declaredOps.has(op)).sort();
        expect(undeclared, 'tier video-FSM calls must be declared in the port OPS list').to.deep.equal([]);
        // Minimality in the other direction: no op may be declared without a
        // live tier consumer (no CRUD "for later").
        const unused = [...declaredOps].filter((op) => !usedOps.has(op)).sort();
        expect(unused, 'every declared op must have a live tier consumer').to.deep.equal([]);
        // The measured O-8 operation set is exactly 13 ops + PHASES (§32.25).
        expect([...declaredOps].sort(), 'the frozen O-8 contract').to.deep.equal([
            'completeGroup',
            'deleteState',
            'failWaitingScene',
            'getState',
            'groupFilePath',
            'groupSuffixes',
            'initState',
            'isGroupFileValid',
            'markGroupDone',
            'scanAllStates',
            'setDone',
            'setFailed',
            'setWaitingChunks',
        ]);
        // PHASES: the tier consumers use videoFsmPhases() for phase
        // comparisons — the phase vocabulary is part of the contract.
        expect(codeOnly(portSrc), 'the port must expose the phase constants resolver').to.include('videoFsmPhases');
        for (const file of allTierFiles()) {
            if (rel(file) === 'backend/src/runtime/video-fsm-port.js') continue;
            const src = codeOnly(readSource(file));
            if (/videoFsm/.test(src)) {
                // Any BARE `PHASES.<phase>` usage must be a local alias bound
                // to a port resolver (audioFsmPhases() or videoFsmPhases())
                // — never hardcoded phase knowledge. `videoOrch.PHASES.X`
                // through a videoFsm() handle is also sanctioned (the handle
                // resolves the ADAPTER through the port — but the measured
                // O-8 consumers use the videoFsmPhases() alias, so the bare
                // form is pinned to the resolvers).
                const bare = src.match(/(?<!\w\.)PHASES\.(?:DONE|FAILED|NEW|PLACEHOLDER_READY|GENERATING|WAITING_CHUNKS|MERGING)/g);
                if (bare) {
                    expect(src, `${rel(file)} a bare PHASES handle must be an audioFsmPhases()/videoFsmPhases() port alias`)
                        .to.match(/PHASES\s*=\s*[^\n]*(?:audioFsmPhases|videoFsmPhases)\s*\(\s*\)/);
                }
            }
        }
    });

    it('O8-G4: no FSM implementation leakage through the port or adapter surface', () => {
        const portSrc = codeOnly(readSource(PORT_FILE));
        // The port must not know host-service internals beyond the frozen
        // op vocabulary and the phase names.
        for (const banned of ['PREFIX', 'createState', 'transitionState', 'VALID_TRANSITIONS', 'MIN_VIDEO_BYTES', 'key(', 'fail_reason', 'encodeSourceProfile']) {
            expect(portSrc, `the port must not know FSM internals (${banned})`).to.not.include(banned);
        }
        // The adapter must NOT grow exports silently: only the thirteen
        // frozen ops + the PHASES getter may exist (no whole-service
        // passthrough).
        const adapterSrc = readSource(ADAPTER_FILE);
        const exportBlock = adapterSrc.match(/module\.exports = \{([\s\S]*?)\};/);
        expect(exportBlock, 'adapter exports must stay declarative').to.not.be.null;
        const exportedOps = [];
        for (const raw of exportBlock[1].split('\n')) {
            const line = raw.trim();
            const m = line.match(/^(?:get\s+)?([a-zA-Z_]\w*)\s*[,(]/) ||
                line.match(/^([a-zA-Z_]\w*)[,\s]*$/);
            if (m) exportedOps.push(m[1]);
            else if (/^(get\s+[a-zA-Z_]\w*)/.test(line)) exportedOps.push(line.split(/\s+/)[1]);
        }
        expect(exportedOps.sort(), 'the frozen O-8 adapter surface').to.deep.equal([
            'PHASES',
            'completeGroup',
            'deleteState',
            'failWaitingScene',
            'getState',
            'groupFilePath',
            'groupSuffixes',
            'initState',
            'isGroupFileValid',
            'markGroupDone',
            'scanAllStates',
            'setDone',
            'setFailed',
            'setWaitingChunks',
        ]);
        // The audio FSM must not ride this adapter (the O-6 MediaFsmPort
        // rejection stands — two independent FSMs never merge).
        expect(adapterSrc, 'the adapter must not touch the audio FSM').to.not.include('audio-orchestrator');
        // The host service keeps its full public API unchanged (O-8 removed
        // tier consumers only — routes/task-handler consumers keep working;
        // the export set is pinned so a silent rename fails).
        const serviceSrc = readSource(SERVICE_FILE);
        for (const op of ['initState', 'setGenerating', 'setWaitingChunks', 'setMerging', 'setDone', 'setFailed', 'markGroupDone', 'groupSuffixes', 'groupFilePath', 'isGroupFileValid', 'completeGroup', 'failWaitingScene', 'scanAllStates', 'getState', 'setState', 'deleteState', 'PHASES']) {
            expect(serviceSrc, `the video-orchestrator host service must keep exporting ${op}`).to.include(op);
        }
    });

    it('O8-G5: the composition root wires the adapter before the first top-level tier require', () => {
        const rootSrc = readSource(path.join(BACKEND_SRC, 'backend.cjs')).replace(/\s+/g, ' ');
        const wireIdx = rootSrc.indexOf('setVideoFsmPort(');
        expect(wireIdx, 'backend.cjs must call setVideoFsmPort(...)').to.be.greaterThan(-1);
        // First TOP-LEVEL tier require: strip lazy `=> require(...)` arrow
        // bodies (they execute at dispatch time, long after module
        // evaluation), then exclude the port contract modules themselves
        // (zero side effects, loadable before wiring).
        const topLevelSrc = rootSrc.replace(/\)\s*=>\s*require\([^)]*\)/g, '=>LAZY');
        const firstTierRequire = topLevelSrc.search(/require\('\.\/(?:runtime|orchestration)(?:\/(?!persistence-port|scene-data-port|placeholder-audio-port|progress-events-port|audio-fsm-port|video-fsm-port)|')/);
        expect(firstTierRequire, 'backend.cjs must require at least one tier module at top level').to.be.greaterThan(-1);
        expect(wireIdx, 'wiring must happen BEFORE the first top-level runtime/orchestration require').to.be.lessThan(firstTierRequire);
        expect(/require\(\s*'\.\/storage\/video-fsm-adapter'\s*\)/.test(rootSrc),
            'the wired adapter must be the host-side storage adapter').to.equal(true);
        // Wiring order stability: O-2 → O-3 → O-4 → O-5 → O-7 → O-8
        // (composition-root sequence).
        const o2Idx = rootSrc.indexOf('setPersistencePort(');
        const o3Idx = rootSrc.indexOf('setSceneDataPort(');
        const o4Idx = rootSrc.indexOf('setPlaceholderAudioPort(');
        const o5Idx = rootSrc.indexOf('setProgressEventsPort(');
        const o7Idx = rootSrc.indexOf('setAudioFsmPort(');
        expect(o2Idx, 'backend.cjs must still wire the O-2 persistence adapter').to.be.greaterThan(-1);
        expect(o3Idx, 'backend.cjs must still wire the O-3 scene-data adapter').to.be.greaterThan(-1);
        expect(o4Idx, 'backend.cjs must still wire the O-4 placeholder-audio adapter').to.be.greaterThan(-1);
        expect(o5Idx, 'backend.cjs must still wire the O-5 progress-events adapter').to.be.greaterThan(-1);
        expect(o7Idx, 'backend.cjs must still wire the O-7 audio-fsm adapter').to.be.greaterThan(-1);
        expect(wireIdx).to.be.greaterThan(o7Idx);
        expect(o7Idx).to.be.greaterThan(o5Idx);
        expect(o5Idx).to.be.greaterThan(o4Idx);
        expect(o4Idx).to.be.greaterThan(o3Idx);
        expect(o3Idx).to.be.greaterThan(o2Idx);

        // Test-bindings mirror: the mocharc require chain must wire the port
        // too (same order discipline), or plain tier requires in tests would
        // fail-fast on an unwired port.
        const bindingsSrc = readSource(TEST_BINDINGS_FILE);
        const bWire = bindingsSrc.indexOf('setVideoFsmPort(');
        expect(bWire, 'generation-test-bindings.cjs must mirror the O-8 wiring').to.be.greaterThan(-1);
        expect(bindingsSrc.indexOf('setAudioFsmPort('), 'bindings must wire O-7 before O-8').to.be.lessThan(bWire);
    });

    it('O8-G6: no lazy/dynamic video-orchestrator bypass around the port', () => {
        // Static + dynamic tier scan: no tier file may reach the video
        // orchestrator host service by any channel except the port.
        const offenders = [];
        for (const file of allTierFiles()) {
            for (const d of dynamicVideoOrchRequires(file)) {
                offenders.push(`${rel(file)} -> dynamic ${d}`);
            }
        }
        expect(offenders, 'no smuggled require(identifier) may re-introduce the video-orchestrator edge').to.deep.equal([]);

        // The adapter resolves the host service via a lazy call-time resolver
        // (the single channel — require.cache stubbing discipline); it must
        // not capture the module at load time.
        const adapterSrc = readSource(ADAPTER_FILE);
        expect(adapterSrc, 'the adapter must keep call-time (lazy) video-FSM resolution for test-stub parity')
            .to.include("() => require('../services/video-orchestrator')");
        expect(/const\s+\w+\s*=\s*require\('\.\.\/services\/video-orchestrator'/.test(adapterSrc),
            'the adapter must not capture the host service module at load time').to.equal(false);
    });

    it('O8-G7: the O-1 boundary does not regress (event-journal shim stays deleted)', () => {
        expect(fs.existsSync(path.join(ORCH_DIR, 'event-journal.js')),
            'the O-1 deleted shim must not come back').to.equal(false);
    });

    it('O8-G8: the O-2/O-3/O-4/O-5/O-7 boundaries do not regress', () => {
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
        const consumers = allTierFiles().filter((f) => readSource(f).includes("require('./persistence-port')") || readSource(f).includes("require('../runtime/persistence-port')"));
        expect(consumers.length, 'at least one tier file must still consume persistence via the O-2 port').to.be.greaterThan(0);
        // Tier files still require ZERO ../book modules (O-3), ZERO
        // placeholder-audio host requires (O-4), ZERO progress host
        // requires (O-5) and ZERO audio-orchestrator host requires (O-7).
        const offenders = [];
        for (const file of allTierFiles()) {
            for (const s of requireSpecifiers(readSource(file))) {
                if (s === '../book' || s === '../../book' || s === './book' ||
                    s.startsWith('../book/') || s.startsWith('../../book/') ||
                    s.includes('@animastor/vbook-runtime') ||
                    s.endsWith('services/placeholder-audio') ||
                    s.endsWith('services/progress-pubsub.cjs') || s.endsWith('services/progress-pubsub') ||
                    s.endsWith('services/generation-progress') ||
                    s.endsWith('services/audio-orchestrator')) {
                    offenders.push(`${rel(file)} -> ${s}`);
                }
            }
        }
        expect(offenders, 'O-3 book, O-4 placeholder-audio, O-5 progress and O-7 audio-FSM boundaries must stay closed').to.deep.equal([]);
        const rootSrc = readSource(path.join(BACKEND_SRC, 'backend.cjs')).replace(/\s+/g, ' ');
        for (const wire of ['setPersistencePort(', 'setSceneDataPort(', 'setPlaceholderAudioPort(', 'setProgressEventsPort(', 'setAudioFsmPort(']) {
            expect(rootSrc.indexOf(wire), `backend.cjs must still wire ${wire}`).to.be.greaterThan(-1);
        }
    });

    it('O8-G9: runtime → orchestration stays 0 (S-5 direction untouched)', () => {
        for (const file of listSourceFiles(RUNTIME_DIR)) {
            const specs = requireSpecifiers(readSource(file));
            expect(specs.filter((s) => s.startsWith('../orchestration')),
                `${rel(file)} must not require orchestration directly (S-5 parity)`).to.deep.equal([]);
        }
    });

    it('O8-G10: the adapter is the single bridge — no new host-side video-orchestrator consumers appeared', () => {
        // Outside the two tiers, the host service consumers are frozen at
        // the pre-O-8 measured set: routes/generation-routes.cjs,
        // services/task-handler.cjs and backend tests. The storage adapter
        // is the ONLY new edge O-8 introduced (the bridge). Specifiers are
        // RESOLVED to files so a same-directory './video-orchestrator'
        // require (task-handler.cjs) is not missed.
        const { resolveSpecifier } = require('./helpers');
        const consumers = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            if (file === SERVICE_FILE) continue;
            for (const spec of requireSpecifiers(readSource(file))) {
                const target = resolveSpecifier(file, spec);
                if (target === SERVICE_FILE) consumers.push(rel(file));
            }
        }
        expect([...new Set(consumers)].sort(), 'the frozen pre-O-8 host consumer set + the O-8 adapter bridge').to.deep.equal([
            'backend/src/routes/generation-routes.cjs',
            'backend/src/services/task-handler.cjs',
            'backend/src/storage/video-fsm-adapter.js',
        ]);
        // The host service itself must not require its adapter or the port
        // (dependency direction: tier → port ← adapter → service only).
        const serviceSpecs = requireSpecifiers(readSource(SERVICE_FILE));
        expect(serviceSpecs.filter((s) => /video-fsm/.test(s)),
            'the host service must not know the port/adapter (no reverse edge)').to.deep.equal([]);
    });

});
