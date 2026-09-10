// ======================================================
// S-6 — Generation host boundary guards (architecture)
// ======================================================
// S-6 introduced the Generation-owned host ports (backend/src/generation/
// ports/) and migrated every confirmed host edge of the Generation Core
// contour onto them. The ownership rule:
//
//   Port interface/contract (generation/ports/* — Generation-owned)
//        ↓ consumed by
//   Generation Core (generation/** + media pipeline consumers)
//        ↑ implemented/wired by
//   Host adapters (gpu-dispatcher, ai-loader, book facade, runtime-config)
//
// …NOT generation → backend service / Redis / pg / runtime-config / VBook /
// Express / GPU implementation.
//
// Guards:
//   S6-A  Generation Core imports NO host modules (pg, ioredis, fs backend,
//         runtime-config, Express, VBook/Book, GPU Hub, storage, services,
//         orchestration/runtime dirs) — the two adapter-classified seam
//         files (comfyui-provider, default-registrations) carry only their
//         pinned contract-package / host-adapter specifiers
//   S6-B  Core consumes ONLY Generation-owned ports (the four migrations
//         pinned: provider→dispatch-transport, default-registrations→
//         generation-config, assembly-profile→profile-store,
//         video-workflows→book-data); port surfaces frozen at runtime
//   S6-C  Host adapters implement the ports and are wired ONLY at the
//         composition roots (backend.cjs + test bindings); Core does not
//         import adapters
//   S6-D  Ports contain no host implementation details (zero requires,
//         no host handles, semantic method surface only)
//   S6-E  No giant HostServices/GenerationContext/universal repository port;
//         the ports directory holds exactly the four frozen files
//   S6-F  Every port has exactly one obvious owner (consumer set pinned)
//   S6-G  The S-5 result stays GREEN — ports cannot resurrect the runtime ↔
//         orchestration cycle (zero-require ports, closed consumer set)
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §28

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { BACKEND_SRC, listSourceFiles, readSource, requireSpecifiers, rel } = require('./helpers');

const GENERATION_DIR = path.join(BACKEND_SRC, 'generation');
const RUNTIME_DIR = path.join(BACKEND_SRC, 'runtime');
const ORCH_DIR = path.join(BACKEND_SRC, 'orchestration');

// The frozen S-6 port set — the surface cannot grow silently (S6-E).
const PORT_FILES = [
    'generation/ports/dispatch-transport.js',
    'generation/ports/generation-config.js',
    'generation/ports/profile-store.js',
    'generation/ports/book-data.js',
];

// The two adapter-classified seam files inside generation/ (reconnaissance
// §25.1/§26.3): comfyui-provider is the S-3 ComfyUI provider adapter (lives
// in the package seed, consumes the DispatchTransport port), and
// default-registrations is the host-side registration adapter (S-2
// bootstrap; falls back to the host config adapter). EVERY other file under
// generation/ must be completely host-free (S6-A core-proper set).
const ADAPTER_CLASSIFIED = new Set([
    'backend/src/generation/comfyui-provider.js',
    'backend/src/generation/default-registrations.js',
]);

// Pinned require specifiers for the adapter-classified files (contract
// packages + the single host-adapter fallback) — everything else is banned.
const ADAPTER_ALLOWED_SPECS = {
    'backend/src/generation/comfyui-provider.js': [
        'animastor-comfyui-workflow-connector',          // extracted zero-dep workflow/connector package (S-3 seam)
        '../runtime/job-schema',                         // Job Protocol v2 facade (Phase 9C choke point — contracts, not host logic)
        './ports/dispatch-transport',                    // S-6: Generation-owned port
    ],
    'backend/src/generation/default-registrations.js': [
        './media-registry',                              // core-internal bootstrap pair (S-2)
        './ports/generation-config',                     // S-6: Generation-owned port
        '../../config/generation-config-adapter',        // host adapter (lazy-bootstrap fallback ONLY)
    ],
};

function generationFiles() {
    return listSourceFiles(GENERATION_DIR);
}

function rewireAllPorts() {
    require('../generation-test-bindings.cjs');
}

// The fixture wires the ports at mocha startup (module-cache no-op on the
// second require). For fail-fast checks we reset the port under test and
// restore the wiring manually afterwards.
describe('S6: Generation host boundary (ports)', () => {

    // ─────────────────────────────────────────────────────────────
    // S6-A — no host modules in the Generation Core contour
    // ─────────────────────────────────────────────────────────────
    it('S6-A: generation/** imports no host modules (pg/ioredis/fs/runtime-config/express/vbook/gpu-hub/storage/services/runtime-dir)', () => {
        const forbidden = [
            /require\(\s*['"]pg['"]\s*\)/, /postgres/, /storage\//, /database/,
            /require\(\s*['"](ioredis|redis)['"]\s*\)/,
            /require\(\s*['"](fs|fs\/promises|node:fs(?:\/promises)?)['"]\s*\)/,
            /runtime-config/,
            /^express$/, /^http$/, /^https$/,
            /gpu-dispatcher/, /animastor-gpu-hub/, /animastor-worker/,
            /(^|\/|\.\.\/|\.\.\/\.\.\/)book(\.js|\.cjs|\/|')/, /vbook/,
            /(^|\.\.\/)services\//, /orchestration\//, /(^|\.\.\/)runtime\//,
            /middleware\//, /routes\//,
        ];
        const offenders = [];
        for (const file of generationFiles()) {
            const r = rel(file);
            const specs = requireSpecifiers(readSource(file));
            for (const spec of specs) {
                if (ADAPTER_CLASSIFIED.has(r) && ADAPTER_ALLOWED_SPECS[r].includes(spec)) continue;
                for (const re of forbidden) {
                    if (re.test(spec)) offenders.push(`${r}: '${spec}'`);
                }
            }
        }
        expect(offenders, 'Generation Core must not import host implementation modules (S-6 ports own the edges)').to.deep.equal([]);
    });

    it('S6-A: core-proper generation files are COMPLETELY host-free (only core-internal + ports + neutral utils requires)', () => {
        const allowed = [
            /^\.\/(media-registry|default-registrations)$/,          // core-internal (registry bootstrap pair)
            /^\.\/prompt-text-utils$/, /^\.\/prompt-profiles\//,     // core-internal
            /^\.\.\/ports\//, /^\.\/ports\//,                        // Generation-owned ports
            /^\.\.\/\.\.\/utils\//,                                  // neutral shared pure utils (prompt-text-utils)
            /^crypto$/,                                              // node builtin
        ];
        const offenders = [];
        for (const file of generationFiles()) {
            const r = rel(file);
            if (ADAPTER_CLASSIFIED.has(r) || r.startsWith('backend/src/generation/ports/')) continue;
            for (const spec of requireSpecifiers(readSource(file))) {
                if (!allowed.some(re => re.test(spec))) offenders.push(`${r}: '${spec}'`);
            }
        }
        expect(offenders, 'core-proper files may only require core internals, Generation ports and neutral utils').to.deep.equal([]);
    });

    // ─────────────────────────────────────────────────────────────
    // S6-B — Core consumes ONLY Generation-owned ports
    // ─────────────────────────────────────────────────────────────
    it('S6-B: every migrated host edge resolves through its Generation-owned port', () => {
        const provider = readSource(path.join(GENERATION_DIR, 'comfyui-provider.js'));
        expect(requireSpecifiers(provider)).to.include('./ports/dispatch-transport');
        expect(provider).to.match(/dispatch\(taskSpec\)/);

        const assembly = readSource(path.join(GENERATION_DIR, 'prompt-profiles', 'assembly-profile.js'));
        expect(requireSpecifiers(assembly)).to.include('../ports/profile-store');
        expect(assembly).to.match(/getAssemblyProfile\(`/);

        const registrations = readSource(path.join(GENERATION_DIR, 'default-registrations.js'));
        expect(requireSpecifiers(registrations)).to.include('./ports/generation-config');
        expect(registrations).to.match(/generationConfig\(\)/);

        const videoWf = readSource(path.join(BACKEND_SRC, 'workflows', 'video', 'video-workflows.js'));
        expect(requireSpecifiers(videoWf)).to.include('../../generation/ports/book-data');
        expect(videoWf).to.match(/bookData\.collectSceneUnits\(/);
        expect(videoWf).to.match(/bookData\.tokensToString\(/);
    });

    it('S6-B: the four port surfaces are frozen (exports + fail-fast unwired semantics)', () => {
        const dispatchPort = require('../../src/generation/ports/dispatch-transport');
        for (const fn of ['setDispatchTransport', 'dispatch', 'isDispatchTransportWired', '_resetDispatchTransport']) {
            expect(dispatchPort[fn], `dispatch-transport.${fn}`).to.be.a('function');
        }
        const configPort = require('../../src/generation/ports/generation-config');
        for (const fn of ['setGenerationConfig', 'generationConfig', 'isGenerationConfigWired', '_resetGenerationConfig']) {
            expect(configPort[fn], `generation-config.${fn}`).to.be.a('function');
        }
        expect(configPort.CONFIG_KEYS).to.deep.equal(['leaseTtlS', 'quotas', 'stuckThresholds']);
        const profilePort = require('../../src/generation/ports/profile-store');
        for (const fn of ['setProfileStore', 'getAssemblyProfile', 'isProfileStoreWired', '_resetProfileStore']) {
            expect(profilePort[fn], `profile-store.${fn}`).to.be.a('function');
        }
        const bookPort = require('../../src/generation/ports/book-data');
        for (const fn of ['setBookData', 'collectSceneUnits', 'tokensToString', 'isBookDataWired', '_resetBookData']) {
            expect(bookPort[fn], `book-data.${fn}`).to.be.a('function');
        }
        expect(bookPort.OPERATIONS).to.deep.equal(['collectSceneUnits', 'tokensToString']);

        // fail-fast: an unwired port throws with a wiring instruction —
        // never a silent no-op (S-5 seam convention)
        const wired = {
            dispatch: dispatchPort.isDispatchTransportWired(),
            config: configPort.isGenerationConfigWired(),
            profile: profilePort.isProfileStoreWired(),
            book: bookPort.isBookDataWired(),
        };
        try {
            dispatchPort._resetDispatchTransport();
            expect(() => dispatchPort.dispatch({})).to.throw(/not wired/);
            expect(() => dispatchPort.setDispatchTransport({ nope: 1 })).to.throw(/must implement dispatch/);
            configPort._resetGenerationConfig();
            expect(() => configPort.generationConfig()).to.throw(/not wired/);
            expect(() => configPort.setGenerationConfig({ leaseTtlS: {} })).to.throw(/must provide 'quotas'/);
            profilePort._resetProfileStore();
            expect(() => profilePort.getAssemblyProfile('image/x')).to.throw(/not wired/);
            bookPort._resetBookData();
            expect(() => bookPort.tokensToString(['x'])).to.throw(/not wired/);
            expect(() => bookPort.setBookData({ collectSceneUnits: () => [] })).to.throw(/must implement tokensToString/);
        } finally {
            if (wired.dispatch) dispatchPort.setDispatchTransport({ dispatch: (spec) => require('../../src/runtime/gpu-dispatcher').sendUnified(spec) });
            if (wired.config) require('../../src/config/generation-config-adapter').bindGenerationConfig();
            if (wired.profile) profilePort.setProfileStore({ getAssemblyProfile: require('../../src/services/ai-loader').getAssemblyProfile });
            if (wired.book) bookPort.setBookData({
                collectSceneUnits: require('../../src/book').collectSceneUnits,
                tokensToString: require('../../src/book/lazy-book/appearance').tokensToString,
            });
        }
        // wiring restored — consumers resolve again
        expect(dispatchPort.isDispatchTransportWired() || !wired.dispatch).to.equal(true);
    });

    // ─────────────────────────────────────────────────────────────
    // S6-C — adapters implement ports; wiring only at composition roots
    // ─────────────────────────────────────────────────────────────
    it('S6-C: port wiring happens ONLY in the composition roots (backend.cjs + test bindings + config adapter)', () => {
        // CALL sites only (function definitions in the port modules do not count)
        const setters = [
            /(?<!function )setDispatchTransport\s*\(/,
            /(?<!function )setProfileStore\s*\(/,
            /(?<!function )setBookData\s*\(/,
            /(?<!function )bindGenerationConfig\s*\(/,
        ];
        const allowed = new Set([
            'backend/src/backend.cjs',                          // production composition root
            'backend/src/generation/default-registrations.js',  // documented lazy-bootstrap fallback (host-side registration adapter)
            ...PORT_FILES.map(p => `backend/src/${p}`),         // port modules define the surface (zero-require, S6-D)
        ]);
        const offenders = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            const r = rel(file);
            if (allowed.has(r)) continue;
            const src = readSource(file);
            if (setters.some(re => re.test(src))) offenders.push(r);
        }
        expect(offenders, 'port wiring leaked outside the composition root').to.deep.equal([]);
        // the mocha fixture mirrors the production wiring (vbook-test-bindings pattern)
        const fixture = readSource(path.join(BACKEND_SRC, '..', 'tests', 'generation-test-bindings.cjs'));
        for (const re of setters) expect(fixture, 'test bindings must mirror the production port wiring').to.match(re);
    });

    it('S6-C: the host adapters implement the port contracts (shape compatibility, live)', () => {
        // DispatchTransport ← gpu-dispatcher.sendUnified
        const gpuDispatcher = require('../../src/runtime/gpu-dispatcher');
        expect(gpuDispatcher.sendUnified).to.be.a('function');
        // ProfileStore ← ai-loader.getAssemblyProfile
        const aiLoader = require('../../src/services/ai-loader');
        expect(aiLoader.getAssemblyProfile).to.be.a('function');
        // BookDataPort ← book facade + appearance tokens
        const book = require('../../src/book');
        const appearance = require('../../src/book/lazy-book/appearance');
        expect(book.collectSceneUnits).to.be.a('function');
        expect(appearance.tokensToString).to.be.a('function');
        // GenerationConfig ← runtime-config canonical slices
        const cfg = require('../../src/config/runtime-config');
        for (const key of ['LEASE_TTL_S', 'QUOTAS', 'STUCK_THRESHOLDS']) {
            expect(cfg[key], `runtime-config.${key}`).to.be.an('object');
        }
    });

    it('S6-C: Core does not import the adapters (adapters required only host-side)', () => {
        const adapterSpecs = [
            /gpu-dispatcher/, /services\/ai-loader/, /(^|\/|\.\.\/)book(\.js|\.cjs|\/|')/,
            /generation-config-adapter/,
        ];
        const offenders = [];
        for (const file of generationFiles()) {
            const r = rel(file);
            for (const spec of requireSpecifiers(readSource(file))) {
                for (const re of adapterSpecs) {
                    if (!re.test(spec)) continue;
                    const pinned = ADAPTER_CLASSIFIED.has(r) &&
                        (ADAPTER_ALLOWED_SPECS[r] || []).includes(spec);
                    if (!pinned) offenders.push(`${r}: '${spec}'`);
                }
            }
        }
        // After the S6-A pinned allowances (comfyui-provider: contract
        // packages; default-registrations: the documented lazy-bootstrap
        // config-adapter fallback, §26.3) NO generation file may reach an
        // adapter module directly — the ports own those edges.
        expect(offenders, 'Generation Core must not import host adapters — ports own the edges').to.deep.equal([]);
    });

    // ─────────────────────────────────────────────────────────────
    // S6-D — ports carry no host implementation details
    // ─────────────────────────────────────────────────────────────
    it('S6-D: port modules are zero-require pure registries (no host handles inside)', () => {
        for (const relPath of PORT_FILES) {
            const src = readSource(path.join(BACKEND_SRC, relPath));
            expect(requireSpecifiers(src), `${relPath} must be a zero-require pure registry`).to.deep.equal([]);
            expect(src, `${relPath} must not reference host handles`).to.not.match(/\bredis\b|pgPool|ioredis|expressRequest|process\.env|fs\.|res\.|req\./);
        }
    });

    // ─────────────────────────────────────────────────────────────
    // S6-E — no DI-dump: no HostServices/GenerationContext/universal port
    // ─────────────────────────────────────────────────────────────
    it('S6-E: no giant HostServices/GenerationContext/createGeneration aggregator exists', () => {
        const offenders = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            const src = readSource(file);
            if (/setHostServices|GenerationContext|createGeneration\s*\(/.test(src)) {
                offenders.push(rel(file));
            }
        }
        expect(offenders, 'capability ports only — no DI-swal aggregator').to.deep.equal([]);
    });

    it('S6-E: the ports directory holds exactly the frozen four files (surface cannot grow silently)', () => {
        const present = listSourceFiles(path.join(GENERATION_DIR, 'ports'))
            .map(f => path.relative(BACKEND_SRC, f).split(path.sep).join('/'))
            .sort();
        expect(present, 'a new port must consciously update the S-6 baseline (doc §28 + this guard)').to.deep.equal([...PORT_FILES].sort());
    });

    // ─────────────────────────────────────────────────────────────
    // S6-F — every port has exactly one obvious owner
    // ─────────────────────────────────────────────────────────────
    it('S6-F: each port has a single pinned owner plus the composition-root wiring sites', () => {
        // port base name → allowed consumers: the ONE domain owner + the
        // composition roots that wire the adapter into the port (S6-C pins
        // those sites; here we pin that no OTHER module consumes the port)
        const OWNERS = {
            'dispatch-transport': [
                'backend/src/generation/comfyui-provider.js',  // domain owner (S-3 provider seam)
                'backend/src/backend.cjs',                     // wiring
            ],
            'generation-config': [
                'backend/src/generation/default-registrations.js',             // domain owner (S-2 registration)
                'backend/src/config/generation-config-adapter.js',             // host adapter (implements the binding)
            ],
            'profile-store': [
                'backend/src/generation/prompt-profiles/assembly-profile.js',  // domain owner (S-4 relocation)
                'backend/src/backend.cjs',                                     // wiring
            ],
            'book-data': [
                'backend/src/workflows/video/video-workflows.js',              // domain owner (video pipeline)
                'backend/src/backend.cjs',                                     // wiring
            ],
        };
        const consumers = {};
        for (const port of Object.keys(OWNERS)) consumers[port] = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            const r = rel(file);
            for (const spec of requireSpecifiers(readSource(file))) {
                for (const port of Object.keys(OWNERS)) {
                    if (new RegExp(`ports/${port}['"]`).test(`${spec}'`)) consumers[port].push(r);
                }
            }
        }
        for (const [port, allowed] of Object.entries(OWNERS)) {
            const found = [...new Set(consumers[port])].sort();
            expect(found, `${port} consumer set drifted — a port has exactly one owner (wiring sites included)`).to.deep.equal([...allowed].sort());
        }
    });

    // ─────────────────────────────────────────────────────────────
    // S6-G — the S-5 result stays green (no cycle resurrection)
    // ─────────────────────────────────────────────────────────────
    it('S6-G: runtime → orchestration policy edges stay ZERO (S-5 invariant, re-pinned)', () => {
        const offenders = [];
        for (const file of listSourceFiles(RUNTIME_DIR)) {
            const specs = requireSpecifiers(readSource(file));
            if (specs.some(s => s.startsWith('../orchestration') || s.startsWith('../../orchestration'))) {
                offenders.push(rel(file));
            }
        }
        expect(offenders, 'S-6 ports must not reintroduce the runtime ↔ orchestration cycle').to.deep.equal([]);
    });

    it('S6-G: orchestration/runtime never consume generation ports (consumer set stays closed; no new SCC)', () => {
        const offenders = [];
        for (const dir of [RUNTIME_DIR, ORCH_DIR]) {
            for (const file of listSourceFiles(dir)) {
                const specs = requireSpecifiers(readSource(file));
                if (specs.some(s => s.includes('generation/ports/') || /ports\/(dispatch-transport|generation-config|profile-store|book-data)/.test(s))) {
                    offenders.push(rel(file));
                }
            }
        }
        expect(offenders, 'ports are consumed by Generation Core only (host adapters wire, they do not consume)').to.deep.equal([]);
    });

    it('S6-G: production wiring exists in backend.cjs for all four ports (composition root, S5-C convention)', () => {
        const backend = readSource(path.join(BACKEND_SRC, 'backend.cjs'));
        expect(backend).to.include('bindGenerationConfig()');
        expect(backend).to.include("require('./generation/ports/dispatch-transport')");
        expect(backend).to.include("require('./generation/ports/profile-store')");
        expect(backend).to.include("require('./generation/ports/book-data')");
        // wired BEFORE the first generation module load (default-registrations
        // reads the config port at require time)
        const wiringIdx = backend.indexOf('bindGenerationConfig()');
        const registrationsIdx = backend.indexOf("require('./generation/default-registrations')");
        expect(wiringIdx, 'port wiring must precede default-registrations load').to.be.greaterThan(-1);
        expect(registrationsIdx, 'default-registrations must load after the wiring').to.be.greaterThan(wiringIdx);
    });
});
