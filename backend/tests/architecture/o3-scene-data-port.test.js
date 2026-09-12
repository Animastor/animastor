// ======================================================
// O-3 ARCHITECTURE GUARDS — SceneDataPort extraction seam
// ======================================================
// Freezes the O-3 state of docs/architecture/generation-module-extraction-
// reconnaissance.md §32.11 ("VBook / Player / Editor boundaries") and
// §32.14 step O-3: runtime/** and orchestration/** consume scene content
// ONLY through runtime/scene-data-port.js (tier-owned contract); the host
// adapter (storage/scene-data-adapter.js) owns the Book Model facade
// (backend/src/book → @animastor/vbook-runtime). Composition root:
// backend.cjs.
//
// This suite TIGHTENS the reconnaissance baseline:
//   O3-G1  zero `../book` requires from the two tiers (static scan);
//   O3-G2  zero lazy/dynamic VBook requires from orchestration/**;
//   O3-G3  the port is a zero-require contract with no host-implementation
//          knowledge (no book facade, no SQL/tables, no VBook internals);
//   O3-G4  the port op set stays minimal: every tier sceneData('…') call is
//          declared in the port OPS list;
//   O3-G5  no VBook implementation leakage through the port surface;
//   O3-G6  services/scene-asset-registry has ZERO orchestration requires;
//   O3-G7  the composition root wires the adapter BEFORE the first
//          top-level tier require (backend.cjs + test bindings mirror);
//   O3-G8  the O-1 event-journal shim stays deleted;
//   O3-G9  the O-2 PersistencePort boundary does not regress (port intact,
//          wiring intact, tiers still clean);
//   O3-G10 runtime → orchestration stays 0 (S-5 direction untouched).
//
// Non-duplication note: requires of the book domain OUTSIDE the two tiers
// are pinned by dependency-guardrails (host book shims stay one-line) and
// vbook-package-boundary (VB-T4); O-G9 pins the runtime/** env baseline.
// This suite adds only the tier-level tightening O-3 introduced.
//
// Docs: generation-module-extraction-reconnaissance.md §32.14 step O-3 (DONE)
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
const SERVICES_DIR = path.join(BACKEND_SRC, 'services');
const PORT_FILE = path.join(RUNTIME_DIR, 'scene-data-port.js');
const ADAPTER_FILE = path.join(BACKEND_SRC, 'storage', 'scene-data-adapter.js');
const REGISTRY_FILE = path.join(SERVICES_DIR, 'scene-asset-registry.js');
const TEST_BINDINGS_FILE = path.join(BACKEND_SRC, '..', 'tests', 'generation-test-bindings.cjs');

function allTierFiles() {
    return [...listSourceFiles(RUNTIME_DIR), ...listSourceFiles(ORCH_DIR)];
}

// Strip line comments and doc-comment continuation lines — boundary
// EXPLANATIONS may mention what the boundary excludes; CODE may not
// (O2-G5 convention: scan the code, not the prose).
function codeOnly(src) {
    return src.split('\n')
        .map((line) => line.replace(/(^|\s)\/\/.*$/, '').replace(/^\s*\*.*$/, ''))
        .join('\n');
}

// VBook deep-package specifier fragment.
const VBOOK_DEEP_RE = '@animastor/vbook-runtime';

// Static VBook requires in a file: the `book` facade shim and every deep
// module of the VBook runtime package.
function staticBookRequires(file) {
    const hits = [];
    for (const s of requireSpecifiers(readSource(file))) {
        if (s === '../book' || s === '../../book' || s === './book' ||
            s.startsWith('../book/') || s.startsWith('../../book/') ||
            s.includes(VBOOK_DEEP_RE)) {
            hits.push(s);
        }
    }
    return hits;
}

// Identifier-based require calls in a file whose surrounding text (±300
// chars) mentions the VBook/book domain — the shape a smuggled
// `require(someBookPath)` would take (S5-A proximity scan convention).
function dynamicBookRequires(file) {
    const src = readSource(file);
    const dyn = src.match(/require\(\s*[A-Za-z_$][\w$.]*\s*\)/g) || [];
    return dyn.filter((call) => {
        const idx = src.indexOf(call);
        const near = src.slice(Math.max(0, idx - 300), idx + 300);
        return /vbook|book facade|Book Model|book-module|\bbook\b/.test(near);
    });
}

describe('§32.14 O-3 guards: scene content arrives only via the SceneDataPort', () => {

    it('O3-G1: the two tiers require ZERO `../book` modules (static scan)', () => {
        const offenders = [];
        for (const file of allTierFiles()) {
            for (const s of staticBookRequires(file)) {
                offenders.push(`${rel(file)} -> ${s}`);
            }
        }
        expect(offenders, 'runtime/** + orchestration/** must consume scene content only via runtime/scene-data-port (host adapter stays in storage/**)').to.deep.equal([]);
    });

    it('O3-G2: orchestration/** has zero lazy/dynamic VBook requires', () => {
        const offenders = [];
        for (const file of listSourceFiles(ORCH_DIR)) {
            for (const d of dynamicBookRequires(file)) {
                offenders.push(`${rel(file)} -> dynamic ${d}`);
            }
        }
        expect(offenders, 'no smuggled require(identifier) may re-introduce the VBook edge').to.deep.equal([]);
    });

    it('O3-G3: the port is a zero-require contract with no host-implementation knowledge', () => {
        const src = readSource(PORT_FILE);
        expect(requireSpecifiers(src), 'scene-data-port.js must require nothing (S-6/O-2 port convention)').to.deep.equal([]);
        const code = codeOnly(src);
        expect(code, 'the port must never name the book facade or VBook package').to.not.match(/require\(['"][^'"]*book|@animastor\/vbook-runtime/);
        expect(code, 'the port must never mention SQL statements').to.not.match(/\bSELECT\s+[A-Za-z_*,\s]+\s+FROM\s+\w+|\bINSERT\s+INTO\s+\w+|\bUPDATE\s+\w+\s+SET\s|\bDELETE\s+FROM\s+\w+/);
        expect(code, 'the port must never name a PostgreSQL table').to.not.match(/\b(?:FROM|INTO|UPDATE|JOIN)\s+(?:scenes|scene_assets|generation_tasks|image_units|generation_cancellations)\b/i);
    });

    it('O3-G4: the port op set stays minimal — every tier sceneData(…) call is declared', () => {
        const portSrc = readSource(PORT_FILE);
        const opBlock = portSrc.match(/const OPS = \[([\s\S]*?)\];/);
        expect(opBlock, 'OPS list must stay declarative').to.not.be.null;
        const declaredOps = new Set(
            (opBlock[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1))
        );
        const usedOps = new Set();
        for (const file of allTierFiles()) {
            if (rel(file) === 'backend/src/runtime/scene-data-port.js') continue;
            const src = codeOnly(readSource(file));
            // Consumers bind the resolver under either local name:
            // sceneData(...) (scene-callbacks, scene-window,
            // reconciliation rebuildWorkList) or sceneDataPort(...)
            // (scene-orchestrator, where a local `sceneData` result
            // variable already exists).
            for (const m of src.match(/sceneData(?:Port)?\('([^']+)'\)/g) || []) {
                usedOps.add(m.slice(m.indexOf("('") + 2, -2));
            }
        }
        const undeclared = [...usedOps].filter((op) => !declaredOps.has(op)).sort();
        expect(undeclared, 'tier sceneData() ops must be declared in the port OPS list').to.deep.equal([]);
        // Minimality in the other direction: no op may be declared without a
        // live tier consumer (no CRUD "for later").
        const unused = [...declaredOps].filter((op) => !usedOps.has(op)).sort();
        expect(unused, 'every declared op must have a live tier consumer').to.deep.equal([]);
    });

    it('O3-G5: no VBook implementation leakage through the port surface', () => {
        const portSrc = codeOnly(readSource(PORT_FILE));
        // The adapter is the only place allowed to know the facade; the port
        // itself must not name its internals (lazy-book, book-model,
        // books-root, bundle-validator, structure detector).
        for (const banned of ['lazy-book', 'book-model', 'books-root', 'bundle-validator', 'structure-detector', 'configureBooksRoot']) {
            expect(portSrc, `the port must not know VBook internals (${banned})`).to.not.include(banned);
        }
        // The adapter must NOT grow exports silently: only the three frozen
        // ops may exist (no whole-facade passthrough).
        const adapterSrc = readSource(ADAPTER_FILE);
        const exportBlock = adapterSrc.match(/module\.exports = \{([\s\S]*?)\};/);
        expect(exportBlock, 'adapter exports must stay declarative').to.not.be.null;
        const exportedOps = (exportBlock[1].match(/[a-zA-Z_]\w*(?=,|\s*$)/gm) || [])
            .map((s) => s.trim()).filter(Boolean);
        expect(exportedOps.sort()).to.deep.equal(['collectScenes', 'findSceneRuntimeData', 'loadBook']);
    });

    it('O3-G6: services/scene-asset-registry no longer depends on orchestration', () => {
        const specs = requireSpecifiers(readSource(REGISTRY_FILE));
        expect(specs.filter((s) => s.includes('orchestration')),
            'scene-asset-registry must not require orchestration (O-3: markDirtyScene comes from its canonical owner state/scene-state-ops)').to.deep.equal([]);
        // The registry keeps consuming the canonical host-owned FSM writer.
        expect(readSource(REGISTRY_FILE), 'the registry must consume markDirtyScene from state/scene-state-ops (canonical owner)')
            .to.include("require('../state/scene-state-ops')");
    });

    it('O3-G7: the composition root wires the adapter before the first top-level tier require', () => {
        const rootSrc = readSource(path.join(BACKEND_SRC, 'backend.cjs')).replace(/\s+/g, ' ');
        const wireIdx = rootSrc.indexOf('setSceneDataPort(');
        expect(wireIdx, 'backend.cjs must call setSceneDataPort(...)').to.be.greaterThan(-1);
        // First TOP-LEVEL tier require: strip lazy `=> require(...)` arrow
        // bodies (they execute at dispatch time, long after module evaluation),
        // then exclude the port contract modules themselves (zero side
        // effects, loadable before wiring).
        const topLevelSrc = rootSrc.replace(/\)\s*=>\s*require\([^)]*\)/g, '=>LAZY');
        const firstTierRequire = topLevelSrc.search(/require\('\.\/(?:runtime|orchestration)(?:\/(?!persistence-port|scene-data-port)|')/);
        expect(firstTierRequire, 'backend.cjs must require at least one tier module at top level').to.be.greaterThan(-1);
        expect(wireIdx, 'wiring must happen BEFORE the first top-level runtime/orchestration require').to.be.lessThan(firstTierRequire);
        expect(/require\(\s*'\.\/storage\/scene-data-adapter'\s*\)/.test(rootSrc),
            'the wired adapter must be the host-side storage adapter').to.equal(true);

        // Test-bindings mirror: the mocharc require chain must wire the port
        // too (same order discipline), or plain tier requires in tests would
        // fail-fast on an unwired port.
        const bindingsSrc = readSource(TEST_BINDINGS_FILE);
        const bWire = bindingsSrc.indexOf('setSceneDataPort(');
        expect(bWire, 'generation-test-bindings.cjs must mirror the O-3 wiring').to.be.greaterThan(-1);
    });

    it('O3-G8: the O-1 event-journal shim stays deleted', () => {
        expect(fs.existsSync(path.join(ORCH_DIR, 'event-journal.js')),
            'the O-1 deleted shim must not come back').to.equal(false);
    });

    it('O3-G9: the O-2 PersistencePort boundary does not regress', () => {
        // Contract file intact and zero-require.
        const portSrc = readSource(path.join(RUNTIME_DIR, 'persistence-port.js'));
        expect(requireSpecifiers(portSrc), 'persistence-port.js must stay zero-require').to.deep.equal([]);
        // Tier files still require the O-2 port (the seam stays in use).
        const consumers = allTierFiles().filter((f) => readSource(f).includes("require('../runtime/persistence-port')") || readSource(f).includes("require('./persistence-port')"));
        expect(consumers.length, 'at least one tier file must still consume persistence via the O-2 port').to.be.greaterThan(0);
        // Composition-root O-2 wiring stays present, wired before O-3 (order stability).
        const rootSrc = readSource(path.join(BACKEND_SRC, 'backend.cjs')).replace(/\s+/g, ' ');
        const o2Idx = rootSrc.indexOf('setPersistencePort(');
        const o3Idx = rootSrc.indexOf('setSceneDataPort(');
        expect(o2Idx, 'backend.cjs must still wire the O-2 persistence adapter').to.be.greaterThan(-1);
        expect(o3Idx).to.be.greaterThan(o2Idx);
    });

    it('O3-G10: runtime → orchestration stays 0 (S-5 direction untouched)', () => {
        for (const file of listSourceFiles(RUNTIME_DIR)) {
            const specs = requireSpecifiers(readSource(file));
            expect(specs.filter((s) => s.startsWith('../orchestration')),
                `${rel(file)} must not require orchestration directly (S-5 parity)`).to.deep.equal([]);
        }
    });

});
