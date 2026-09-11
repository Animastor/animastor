// ======================================================
// S-6 — Generation host boundary guards (architecture)
// ======================================================
// S-6 introduced the Generation-owned host ports (now physically inside the
// @animastor/generation package, packages/animastor-generation/src/ports/ —
// S-7 moved them from backend/src/generation/ports/) and migrated every
// confirmed host edge of the Generation Core contour onto them. The
// ownership rule:
//
//   Port interface/contract (package src/ports/* — Generation-owned)
//        ↓ consumed by
//   Generation Core (package src/** + the host media pipeline consumers)
//        ↑ implemented/wired by
//   Host adapters (gpu-dispatcher, ai-loader, book facade, runtime-config)
//
// …NOT generation → backend service / Redis / pg / runtime-config / VBook /
// Express / GPU implementation.
//
// S-7: the scanned contour is the PACKAGE (packages/animastor-generation/src)
// — the host-side scan additionally covers backend/src for port-wiring leaks.
// The package-level boundary guards proper live in
// tests/architecture/generation-package-boundary.test.js (G7-A…G7-M).
//
// Guards:
//   S6-A  Generation Core imports NO host modules (pg, ioredis, fs backend,
//         runtime-config, Express, VBook/Book, GPU Hub, storage, services,
//         orchestration/runtime dirs) — the two adapter-classified seam
//         files (comfyui-provider, default-registrations) carry only their
//         pinned contract-package specifiers
//   S6-B  Core consumes ONLY Generation-owned ports (the four migrations
//         pinned: provider→dispatch-transport, default-registrations→
//         generation-config, assembly-profile→profile-store,
//         video-workflows→book-data); port surfaces frozen at runtime
//   S6-C  Host adapters implement the ports and are wired ONLY at the
//         composition roots (backend.cjs + test bindings + config adapter);
//         Core does not import adapters
//   S6-D  Ports contain no host implementation details (zero requires,
//         no host handles, semantic method surface only)
//   S6-E  No giant HostServices/GenerationContext/universal repository port;
//         the ports directory holds exactly the four frozen files
//   S6-F  Every port has exactly one obvious owner (consumer set pinned)
//   S6-G  The S-5 result stays GREEN — ports cannot resurrect the runtime ↔
//         orchestration cycle (zero-require ports, closed consumer set)
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §28–29

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { BACKEND_SRC, listSourceFiles, readSource, requireSpecifiers, rel } = require('./helpers');

const PKG_SRC = path.join(BACKEND_SRC, '..', '..', 'packages', 'animastor-generation', 'src');
const GENERATION_DIR = PKG_SRC; // the Generation Core contour (S-7: the package)
const RUNTIME_DIR = path.join(BACKEND_SRC, 'runtime');
const ORCH_DIR = path.join(BACKEND_SRC, 'orchestration');

// The frozen S-6 port set — the surface cannot grow silently (S6-E).
// Paths are relative to the package src/ (S-7: package-owned ports).
const PORT_FILES = [
    'ports/dispatch-transport.js',
    'ports/generation-config.js',
    'ports/profile-store.js',
    'ports/book-data.js',
];

// The two adapter-classified seam files inside the package (reconnaissance
// §25.1/§26.3): comfyui-provider is the S-3 ComfyUI provider adapter (consumes
// the DispatchTransport port + the frozen contract packages), and
// default-registrations is the registration adapter (S-2 bootstrap; reads the
// config port — its former host-adapter fallback require was removed in S-7).
// EVERY other file in the package must be completely host-free (S6-A
// core-proper set).
const ADAPTER_CLASSIFIED = new Set([
    'packages/animastor-generation/src/providers/comfyui-provider.js',
    'packages/animastor-generation/src/core/default-registrations.js',
]);

// Pinned require specifiers for the adapter-classified files (contract
// packages + core-internal/ports requires) — everything else is banned.
const ADAPTER_ALLOWED_SPECS = {
    'packages/animastor-generation/src/providers/comfyui-provider.js': [
        'animastor-comfyui-workflow-connector',          // extracted zero-dep workflow/connector package (S-3 seam)
        '@animastor/contracts',                          // S-7: Job Protocol v2 canonical package (the backend job-schema facade is its zero-logic re-export)
        '../ports/dispatch-transport',                   // S-6: Generation-owned port
    ],
    'packages/animastor-generation/src/core/default-registrations.js': [
        './media-registry',                              // core-internal bootstrap pair (S-2)
        '../ports/generation-config',                    // S-6: Generation-owned port (S-7: the host fallback require is GONE — wiring is composition-root-only)
    ],
};

function generationFiles() {
    return listSourceFiles(GENERATION_DIR);
}

// The fixture wires the ports at mocha startup (module-cache no-op on the
// second require). For fail-fast checks we reset the port under test and
// restore the wiring manually afterwards.
describe('S6: Generation host boundary (ports)', () => {

    // ─────────────────────────────────────────────────────────────
    // S6-A — no host modules in the Generation Core contour
    // ─────────────────────────────────────────────────────────────
    it('S6-A: package imports no host modules (pg/ioredis/fs/runtime-config/express/vbook/gpu-hub/storage/services/runtime-dir)', () => {
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

    it('S6-A: core-proper package files are COMPLETELY host-free (only core-internal + ports + neutral utils requires)', () => {
        const allowed = [
            /^\.\/(media-registry|default-registrations)$/,          // core-internal (registry bootstrap pair)
            /^\.\/prompt-text-utils$/, /^\.\/prompt-profiles\//,     // core-internal
            /^\.\/(core|providers|ports)\//,                         // package entrypoint namespace requires (S-7 index.js)
            /^\.\.\/ports\//, /^\.\/ports\//,                        // Generation-owned ports
            /^\.\.\/utils\//, /^\.\/utils\//,                        // package-internal pure utils (S-7)
            /^crypto$/,                                              // node builtin
            /^@animastor\/contracts$/,                               // frozen Job Protocol package (provider only, S6-B pin)
            /^animastor-comfyui-workflow-connector$/,                // provider contract package (S-3)
        ];
        const offenders = [];
        for (const file of generationFiles()) {
            const r = rel(file);
            if (ADAPTER_CLASSIFIED.has(r) || r.startsWith('packages/animastor-generation/src/ports/')) continue;
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
        const provider = readSource(path.join(GENERATION_DIR, 'providers', 'comfyui-provider.js'));
        expect(requireSpecifiers(provider)).to.include('../ports/dispatch-transport');
        expect(provider).to.match(/dispatch\(taskSpec\)/);
        // S-7: the Job Protocol comes from the frozen contracts package (the
        // backend job-schema facade is its zero-logic re-export)
        expect(requireSpecifiers(provider)).to.include('@animastor/contracts');

        const assembly = readSource(path.join(GENERATION_DIR, 'prompt-profiles', 'assembly-profile.js'));
        expect(requireSpecifiers(assembly)).to.include('../ports/profile-store');
        expect(assembly).to.match(/getAssemblyProfile\(`/);

        const registrations = readSource(path.join(GENERATION_DIR, 'core', 'default-registrations.js'));
        expect(requireSpecifiers(registrations)).to.include('../ports/generation-config');
        expect(registrations).to.match(/generationConfig\(\)/);
        // S-7: no host fallback require left in the registration adapter
        expect(requireSpecifiers(registrations).some(s => /config-adapter|runtime-config/.test(s)),
            'default-registrations must not reach the host config adapter').to.equal(false);

        const videoWf = readSource(path.join(BACKEND_SRC, 'workflows', 'video', 'video-workflows.js'));
        expect(requireSpecifiers(videoWf)).to.include('@animastor/generation');
        expect(videoWf).to.match(/bookData\.collectSceneUnits\(/);
        expect(videoWf).to.match(/bookData\.tokensToString\(/);
    });

    it('S6-B: the four port surfaces are frozen (exports + fail-fast unwired semantics)', () => {
        const dispatchPort = require('@animastor/generation').ports.dispatchTransport;
        for (const fn of ['setDispatchTransport', 'dispatch', 'isDispatchTransportWired', '_resetDispatchTransport']) {
            expect(dispatchPort[fn], `dispatch-transport.${fn}`).to.be.a('function');
        }
        const configPort = require('@animastor/generation').ports.generationConfig;
        for (const fn of ['setGenerationConfig', 'generationConfig', 'isGenerationConfigWired', '_resetGenerationConfig']) {
            expect(configPort[fn], `generation-config.${fn}`).to.be.a('function');
        }
        expect(configPort.CONFIG_KEYS).to.deep.equal(['leaseTtlS', 'quotas', 'stuckThresholds']);
        const profilePort = require('@animastor/generation').ports.profileStore;
        for (const fn of ['setProfileStore', 'getAssemblyProfile', 'isProfileStoreWired', '_resetProfileStore']) {
            expect(profilePort[fn], `profile-store.${fn}`).to.be.a('function');
        }
        const bookPort = require('@animastor/generation').ports.bookData;
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
            ...PORT_FILES.map(p => `packages/animastor-generation/src/${p}`), // port modules define the surface (zero-require, S6-D)
        ]);
        const offenders = [];
        for (const root of [BACKEND_SRC, PKG_SRC]) {
            for (const file of listSourceFiles(root)) {
                const r = rel(file);
                if (allowed.has(r)) continue;
                const src = readSource(file);
                if (setters.some(re => re.test(src))) offenders.push(r);
            }
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
        // packages) NO package file may reach an adapter module directly —
        // the ports own those edges. The former default-registrations
        // config-adapter fallback is GONE in S-7 (wiring is
        // composition-root-only).
        expect(offenders, 'Generation Core must not import host adapters — ports own the edges').to.deep.equal([]);
    });

    // ─────────────────────────────────────────────────────────────
    // S6-D — ports carry no host implementation details
    // ─────────────────────────────────────────────────────────────
    it('S6-D: port modules are zero-require pure registries (no host handles inside)', () => {
        for (const relPath of PORT_FILES) {
            const src = readSource(path.join(PKG_SRC, relPath));
            expect(requireSpecifiers(src), `${relPath} must be a zero-require pure registry`).to.deep.equal([]);
            expect(src, `${relPath} must not reference host handles`).to.not.match(/\bredis\b|pgPool|ioredis|expressRequest|process\.env|fs\.|res\.|req\./);
        }
    });

    // ─────────────────────────────────────────────────────────────
    // S6-E — no DI-dump: no HostServices/GenerationContext/universal port
    // ─────────────────────────────────────────────────────────────
    it('S6-E: no giant HostServices/GenerationContext/createGeneration aggregator exists', () => {
        const offenders = [];
        for (const root of [BACKEND_SRC, PKG_SRC]) {
            for (const file of listSourceFiles(root)) {
                const src = readSource(file);
                if (/setHostServices|GenerationContext|createGeneration\s*\(/.test(src)) {
                    offenders.push(rel(file));
                }
            }
        }
        expect(offenders, 'capability ports only — no DI-swal aggregator').to.deep.equal([]);
    });

    it('S6-E: the ports directory holds exactly the frozen four files (surface cannot grow silently)', () => {
        const present = listSourceFiles(path.join(PKG_SRC, 'ports'))
            .map(f => path.relative(PKG_SRC, f).split(path.sep).join('/'))
            .sort();
        expect(present, 'a new port must consciously update the S-6 baseline (doc §28 + this guard)').to.deep.equal([...PORT_FILES].sort());
    });

    // ─────────────────────────────────────────────────────────────
    // S6-F — every port has exactly one obvious owner
    // ─────────────────────────────────────────────────────────────
    it('S6-F: each port has a single pinned owner plus the composition-root wiring sites', () => {
        // port base name → allowed consumers: the ONE domain owner + the
        // composition roots that wire the adapter into the port (S6-C pins
        // those sites; here we pin that no OTHER module consumes the port).
        // S-7 detection: host files consume ports through the package root
        // (`require('@animastor/generation').ports.<name>`); package-internal
        // owners require the port modules relatively.
        const OWNERS = {
            'dispatch-transport': [
                'packages/animastor-generation/src/providers/comfyui-provider.js', // domain owner (S-3 provider seam)
                'packages/animastor-generation/src/index.js',                      // package entrypoint (materializes the ports namespace)
                'backend/src/backend.cjs',                                         // wiring
            ],
            'generation-config': [
                'packages/animastor-generation/src/core/default-registrations.js', // domain owner (S-2 registration)
                'packages/animastor-generation/src/index.js',                      // package entrypoint (materializes the ports namespace)
                'backend/src/config/generation-config-adapter.js',                 // host adapter (implements the binding)
            ],
            'profile-store': [
                'packages/animastor-generation/src/prompt-profiles/assembly-profile.js', // domain owner (S-4 relocation)
                'packages/animastor-generation/src/index.js',                      // package entrypoint (materializes the ports namespace)
                'backend/src/backend.cjs',                                         // wiring
            ],
            'book-data': [
                'backend/src/workflows/video/video-workflows.js',                  // domain owner (video pipeline)
                'packages/animastor-generation/src/index.js',                      // package entrypoint (materializes the ports namespace)
                'backend/src/backend.cjs',                                         // wiring
            ],
        };
        const consumers = {};
        for (const port of Object.keys(OWNERS)) consumers[port] = [];
        for (const root of [BACKEND_SRC, PKG_SRC]) {
            for (const file of listSourceFiles(root)) {
                const r = rel(file);
                const src = readSource(file);
                for (const spec of requireSpecifiers(src)) {
                    for (const port of Object.keys(OWNERS)) {
                        if (new RegExp(`ports/${port}['"]`).test(`${spec}'`)) consumers[port].push(r);
                    }
                }
                for (const port of Object.keys(OWNERS)) {
                    const camel = port.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                    if (new RegExp(`\\.ports\\.${camel}\\b`).test(src) &&
                        !consumers[port].includes(r)) consumers[port].push(r);
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
                const src = readSource(file);
                const specs = requireSpecifiers(src);
                if (specs.some(s => s.includes('generation/ports/') || /ports\/(dispatch-transport|generation-config|profile-store|book-data)/.test(s)) ||
                    /\.ports\.(dispatchTransport|generationConfig|profileStore|bookData)\b/.test(src)) {
                    offenders.push(rel(file));
                }
            }
        }
        expect(offenders, 'ports are consumed by Generation Core only (host adapters wire, they do not consume)').to.deep.equal([]);
    });

    it('S6-G: production wiring exists in backend.cjs for all four ports (composition root, S5-C convention)', () => {
        const backend = readSource(path.join(BACKEND_SRC, 'backend.cjs'));
        expect(backend).to.include('bindGenerationConfig()');
        expect(backend).to.include("require('@animastor/generation').ports.dispatchTransport");
        expect(backend).to.include("require('@animastor/generation').ports.profileStore");
        expect(backend).to.include("require('@animastor/generation').ports.bookData");
        // wired BEFORE the first generation module load (default-registrations
        // reads the config port at load time) and BEFORE the eager bootstrap
        const wiringIdx = backend.indexOf('bindGenerationConfig()');
        const bootstrapIdx = backend.indexOf("require('@animastor/generation').bootstrap()");
        expect(wiringIdx, 'port wiring must precede the package bootstrap').to.be.greaterThan(-1);
        expect(bootstrapIdx, 'package bootstrap must load after the wiring').to.be.greaterThan(wiringIdx);
    });
});
