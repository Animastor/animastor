// ======================================================
// O-4 ARCHITECTURE GUARDS — PlaceholderAudioPort extraction seam
// ======================================================
// Freezes the O-4 state of docs/architecture/generation-module-extraction-
// reconnaissance.md §32.7 (O-P7) and §32.14 step O-4: runtime/** and
// orchestration/** consume placeholder-audio operations ONLY through
// runtime/placeholder-audio-port.js (tier-owned contract); the host
// adapter (storage/placeholder-audio-adapter.js) owns the ffmpeg/fs host
// service (services/placeholder-audio.js). Composition root: backend.cjs.
//
// This suite TIGHTENS the reconnaissance baseline:
//   O4-G1  zero `../services/placeholder-audio` requires from the two
//          tiers (static scan);
//   O4-G2  the port is a zero-require contract with no host-implementation
//          knowledge (no ffmpeg, no fs, no SQL/tables, no scene_assets);
//   O4-G3  the port op set stays minimal: every tier placeholderAudioOp('…')
//          call is declared in the port OPS list AND every declared op has
//          a live tier consumer (no CRUD "for later");
//   O4-G4  no placeholder-audio implementation leakage through the port
//          or adapter surface (frozen three-op adapter export set);
//   O4-G5  the composition root wires the adapter BEFORE the first
//          top-level tier require (backend.cjs + test bindings mirror);
//   O4-G6  no lazy/dynamic placeholder-audio bypass around the port
//          (tier dynamic-require proximity scan + adapter lazy-resolution
//          stays the single channel);
//   O4-G7  the O-1 boundary does not regress (shim stays deleted);
//   O4-G8  the O-2 PersistencePort boundary does not regress;
//   O4-G9  the O-3 SceneDataPort boundary does not regress;
//   O4-G10 runtime → orchestration stays 0 (S-5 direction untouched).
//
// Non-duplication note: requires of placeholder-audio OUTSIDE the two
// tiers (routes/import workflows, window-generator, backend.cjs DI) stay
// host-side by design — O-P7 covers only the runtime/orchestration seam.
// The O-G series (runtime-orchestration-recon) pins the tier-wide env/
// Redis/HTTP baselines; this suite adds only the tier-level tightening
// O-4 introduced.
//
// Docs: generation-module-extraction-reconnaissance.md §32.14 step O-4 (DONE)
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
const PORT_FILE = path.join(RUNTIME_DIR, 'placeholder-audio-port.js');
const ADAPTER_FILE = path.join(BACKEND_SRC, 'storage', 'placeholder-audio-adapter.js');
const SERVICE_FILE = path.join(BACKEND_SRC, 'services', 'placeholder-audio.js');
const TEST_BINDINGS_FILE = path.join(BACKEND_SRC, '..', 'tests', 'generation-test-bindings.cjs');

function allTierFiles() {
    return [...listSourceFiles(RUNTIME_DIR), ...listSourceFiles(ORCH_DIR)];
}

// Strip line comments and doc-comment continuation lines — boundary
// EXPLANATIONS may mention what the boundary excludes; CODE may not
// (O2-G5/O3-G1 convention: scan the code, not the prose).
function codeOnly(src) {
    return src.split('\n')
        .map((line) => line.replace(/(^|\s)\/\/.*$/, '').replace(/^\s*\*.*$/, ''))
        .join('\n');
}

// Static placeholder-audio service requires in a tier file.
function staticPlaceholderRequires(file) {
    const hits = [];
    for (const s of requireSpecifiers(readSource(file))) {
        if (s === '../services/placeholder-audio' || s === '../../services/placeholder-audio' ||
            s === './services/placeholder-audio' || s.endsWith('services/placeholder-audio')) {
            hits.push(s);
        }
    }
    return hits;
}

// Identifier-based require calls in a tier file whose surrounding text
// (±300 chars) mentions the placeholder-audio domain — the shape a
// smuggled `require(somePlaceholderPath)` would take (S5-A/O2-G1
// proximity scan convention).
function dynamicPlaceholderRequires(file) {
    const src = readSource(file);
    const dyn = src.match(/require\(\s*[A-Za-z_$][\w$.]*\s*\)/g) || [];
    return dyn.filter((call) => {
        const idx = src.indexOf(call);
        const near = src.slice(Math.max(0, idx - 300), idx + 300);
        return /placeholder[-_]audio/.test(near);
    });
}

describe('§32.7 O-4 guards: placeholder audio arrives only via the PlaceholderAudioPort', () => {

    it('O4-G1: the two tiers require ZERO placeholder-audio service modules (static scan)', () => {
        const offenders = [];
        for (const file of allTierFiles()) {
            if (rel(file) === 'backend/src/runtime/placeholder-audio-port.js') continue;
            for (const s of staticPlaceholderRequires(file)) {
                offenders.push(`${rel(file)} -> ${s}`);
            }
        }
        expect(offenders, 'runtime/** + orchestration/** must consume placeholder audio only via runtime/placeholder-audio-port (host adapter stays in storage/**)').to.deep.equal([]);
    });

    it('O4-G2: the port is a zero-require contract with no host-implementation knowledge', () => {
        const src = readSource(PORT_FILE);
        expect(requireSpecifiers(src), 'placeholder-audio-port.js must require nothing (S-6/O-2 port convention)').to.deep.equal([]);
        const code = codeOnly(src);
        expect(code, 'the port must never name the host service path').to.not.include('services/placeholder-audio');
        expect(code, 'the port must never mention ffmpeg/child processes').to.not.match(/ffmpeg|child_process|spawn|execFile/);
        expect(code, 'the port must never mention SQL statements').to.not.match(/\bSELECT\s+[A-Za-z_*,\s]+\s+FROM\s+\w+|\bINSERT\s+INTO\s+\w+|\bUPDATE\s+\w+\s+SET\s|\bDELETE\s+FROM\s+\w+/);
        expect(code, 'the port must never name a PostgreSQL table').to.not.match(/\b(?:FROM|INTO|UPDATE|JOIN)\s+(?:scenes|scene_assets|generation_tasks|image_units|generation_cancellations)\b/i);
        expect(code, 'the port must never name raw fs access').to.not.match(/\bfs\b|writeFileSync|mkdirSync/);
    });

    it('O4-G3: the port op set stays minimal — every tier placeholderAudioOp(…) call is declared and live', () => {
        const portSrc = readSource(PORT_FILE);
        const opBlock = portSrc.match(/const OPS = \[([\s\S]*?)\];/);
        expect(opBlock, 'OPS list must stay declarative').to.not.be.null;
        const declaredOps = new Set(
            (opBlock[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1))
        );
        const usedOps = new Set();
        for (const file of allTierFiles()) {
            if (rel(file) === 'backend/src/runtime/placeholder-audio-port.js') continue;
            const src = codeOnly(readSource(file));
            for (const m of src.match(/placeholderAudioOp\('([^']+)'\)/g) || []) {
                usedOps.add(m.slice("placeholderAudioOp('".length, -2));
            }
        }
        const undeclared = [...usedOps].filter((op) => !declaredOps.has(op)).sort();
        expect(undeclared, 'tier placeholderAudioOp() calls must be declared in the port OPS list').to.deep.equal([]);
        // Minimality in the other direction: no op may be declared without a
        // live tier consumer (no CRUD "for later").
        const unused = [...declaredOps].filter((op) => !usedOps.has(op)).sort();
        expect(unused, 'every declared op must have a live tier consumer').to.deep.equal([]);
        // The measured O-4 operation set is exactly three ops (§32.7 O-P7).
        expect([...declaredOps].sort(), 'the frozen O-4 contract').to.deep.equal([
            'ensurePlaceholderAudio',
            'hasRealAudio',
            'replacePlaceholderWithRealAudio',
        ]);
    });

    it('O4-G4: no placeholder-audio implementation leakage through the port or adapter surface', () => {
        const portSrc = codeOnly(readSource(PORT_FILE));
        // The adapter is the only place allowed to know the host service;
        // the port itself must not name its internals.
        for (const banned of ['estimateSpeechDurationSec', 'ensureAllPlaceholderAudio', 'getScenesNeedingPlaceholder', 'markPlaceholderStale', 'recoverMissingPlaceholders', 'generateSilentAudio']) {
            expect(portSrc, `the port must not know host-service internals (${banned})`).to.not.include(banned);
        }
        // The adapter must NOT grow exports silently: only the three frozen
        // ops may exist (no whole-service passthrough).
        const adapterSrc = readSource(ADAPTER_FILE);
        const exportBlock = adapterSrc.match(/module\.exports = \{([\s\S]*?)\};/);
        expect(exportBlock, 'adapter exports must stay declarative').to.not.be.null;
        const exportedOps = (exportBlock[1].match(/[a-zA-Z_]\w*(?=,|\s*$)/gm) || [])
            .map((s) => s.trim()).filter(Boolean);
        expect(exportedOps.sort()).to.deep.equal([
            'ensurePlaceholderAudio',
            'hasRealAudio',
            'replacePlaceholderWithRealAudio',
        ]);
        // The host service keeps its full public surface unchanged (O-4
        // removed tier consumers only — routes/window-generator consumers
        // keep working; the export set is pinned so a silent rename fails).
        const svcSrc = readSource(SERVICE_FILE);
        for (const op of ['hasRealAudio', 'ensurePlaceholderAudio', 'replacePlaceholderWithRealAudio', 'ensureAllPlaceholderAudio', 'estimateSpeechDurationSec']) {
            expect(svcSrc, `the host service must keep exporting ${op} (host consumers depend on it)`).to.include(op);
        }
    });

    it('O4-G5: the composition root wires the adapter before the first top-level tier require', () => {
        const rootSrc = readSource(path.join(BACKEND_SRC, 'backend.cjs')).replace(/\s+/g, ' ');
        const wireIdx = rootSrc.indexOf('setPlaceholderAudioPort(');
        expect(wireIdx, 'backend.cjs must call setPlaceholderAudioPort(...)').to.be.greaterThan(-1);
        // First TOP-LEVEL tier require: strip lazy `=> require(...)` arrow
        // bodies (they execute at dispatch time, long after module
        // evaluation), then exclude the port contract modules themselves
        // (zero side effects, loadable before wiring).
        const topLevelSrc = rootSrc.replace(/\)\s*=>\s*require\([^)]*\)/g, '=>LAZY');
        const firstTierRequire = topLevelSrc.search(/require\('\.\/(?:runtime|orchestration)(?:\/(?!persistence-port|scene-data-port|placeholder-audio-port)|')/);
        expect(firstTierRequire, 'backend.cjs must require at least one tier module at top level').to.be.greaterThan(-1);
        expect(wireIdx, 'wiring must happen BEFORE the first top-level runtime/orchestration require').to.be.lessThan(firstTierRequire);
        expect(/require\(\s*'\.\/storage\/placeholder-audio-adapter'\s*\)/.test(rootSrc),
            'the wired adapter must be the host-side storage adapter').to.equal(true);
        // Wiring order stability: O-2 → O-3 → O-4 (composition-root sequence).
        const o2Idx = rootSrc.indexOf('setPersistencePort(');
        const o3Idx = rootSrc.indexOf('setSceneDataPort(');
        expect(o2Idx, 'backend.cjs must still wire the O-2 persistence adapter').to.be.greaterThan(-1);
        expect(o3Idx, 'backend.cjs must still wire the O-3 scene-data adapter').to.be.greaterThan(-1);
        expect(wireIdx).to.be.greaterThan(o3Idx);
        expect(o3Idx).to.be.greaterThan(o2Idx);

        // Test-bindings mirror: the mocharc require chain must wire the port
        // too (same order discipline), or plain tier requires in tests would
        // fail-fast on an unwired port.
        const bindingsSrc = readSource(TEST_BINDINGS_FILE);
        const bWire = bindingsSrc.indexOf('setPlaceholderAudioPort(');
        expect(bWire, 'generation-test-bindings.cjs must mirror the O-4 wiring').to.be.greaterThan(-1);
        expect(bindingsSrc.indexOf('setSceneDataPort('), 'bindings must wire O-3 before O-4').to.be.lessThan(bWire);
    });

    it('O4-G6: no lazy/dynamic placeholder-audio bypass around the port', () => {
        // Static + dynamic tier scan: no tier file may reach the host
        // service by any channel except the port.
        const offenders = [];
        for (const file of allTierFiles()) {
            if (rel(file) === 'backend/src/runtime/placeholder-audio-port.js') continue;
            for (const d of dynamicPlaceholderRequires(file)) {
                offenders.push(`${rel(file)} -> dynamic ${d}`);
            }
        }
        expect(offenders, 'no smuggled require(identifier) may re-introduce the placeholder-audio edge').to.deep.equal([]);

        // The adapter resolves the host service via a lazy call-time
        // resolver (the single channel — require.cache stubbing discipline);
        // it must not capture the module at load time.
        const adapterSrc = readSource(ADAPTER_FILE);
        expect(adapterSrc, 'the adapter must keep call-time (lazy) service resolution for test-stub parity')
            .to.include('() => require(\'../services/placeholder-audio\')');
        expect(/const\s+\w+\s*=\s*require\('\.\.\/services\/placeholder-audio'\)/.test(adapterSrc),
            'the adapter must not capture the service module at load time').to.equal(false);
    });

    it('O4-G7: the O-1 boundary does not regress (event-journal shim stays deleted)', () => {
        expect(fs.existsSync(path.join(ORCH_DIR, 'event-journal.js')),
            'the O-1 deleted shim must not come back').to.equal(false);
    });

    it('O4-G8: the O-2 PersistencePort boundary does not regress', () => {
        const portSrc = readSource(path.join(RUNTIME_DIR, 'persistence-port.js'));
        expect(requireSpecifiers(portSrc), 'persistence-port.js must stay zero-require').to.deep.equal([]);
        const consumers = allTierFiles().filter((f) => readSource(f).includes("require('../runtime/persistence-port')") || readSource(f).includes("require('./persistence-port')"));
        expect(consumers.length, 'at least one tier file must still consume persistence via the O-2 port').to.be.greaterThan(0);
        const rootSrc = readSource(path.join(BACKEND_SRC, 'backend.cjs')).replace(/\s+/g, ' ');
        expect(rootSrc.indexOf('setPersistencePort('), 'backend.cjs must still wire the O-2 persistence adapter').to.be.greaterThan(-1);
    });

    it('O4-G9: the O-3 SceneDataPort boundary does not regress', () => {
        const portSrc = readSource(path.join(RUNTIME_DIR, 'scene-data-port.js'));
        expect(requireSpecifiers(portSrc), 'scene-data-port.js must stay zero-require').to.deep.equal([]);
        // Tier files still require ZERO `../book` modules.
        const offenders = [];
        for (const file of allTierFiles()) {
            for (const s of requireSpecifiers(readSource(file))) {
                if (s === '../book' || s === '../../book' || s === './book' ||
                    s.startsWith('../book/') || s.startsWith('../../book/') ||
                    s.includes('@animastor/vbook-runtime')) {
                    offenders.push(`${rel(file)} -> ${s}`);
                }
            }
        }
        expect(offenders, 'O-3 book boundary must stay closed').to.deep.equal([]);
        const rootSrc = readSource(path.join(BACKEND_SRC, 'backend.cjs')).replace(/\s+/g, ' ');
        expect(rootSrc.indexOf('setSceneDataPort('), 'backend.cjs must still wire the O-3 scene-data adapter').to.be.greaterThan(-1);
    });

    it('O4-G10: runtime → orchestration stays 0 (S-5 direction untouched)', () => {
        for (const file of listSourceFiles(RUNTIME_DIR)) {
            const specs = requireSpecifiers(readSource(file));
            expect(specs.filter((s) => s.startsWith('../orchestration')),
                `${rel(file)} must not require orchestration directly (S-5 parity)`).to.deep.equal([]);
        }
    });

});
