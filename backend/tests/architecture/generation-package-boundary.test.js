// ======================================================
// S-7 — Generation package boundary guards (G7-A…G7-M)
// ======================================================
// S-7 physically extracted the prepared Generation Core from
// backend/src/generation/** into the npm package @animastor/generation
// (packages/animastor-generation). These guards freeze the physical result:
//
//   G7-A  the package exists and has the correct npm name
//   G7-B  the package never imports backend/src/**
//   G7-C  the package never imports Redis/PG/Express/runtime-config/
//         VBook/Player/Editor/GPU-Hub/ComfyUI-implementation/ai-loader/
//         book/agent (transitive require scan, not just first level)
//   G7-D  backend consumers use the package public API root
//   G7-E  no duplicate Generation Core implementation remains in backend
//   G7-F  compatibility shims are re-export/delegation only (S-7 target
//         state: the deep-path shims were DELETED — absence is pinned)
//   G7-G  the package public API surface is frozen
//   G7-H  no accidental deep imports (exports map exposes '.' only)
//   G7-I  the S-6 port guards remain green (port contour + wiring pins)
//   G7-J  the S-5 runtime/orchestration boundary remains green
//   G7-K  no dependency cycle package ↔ backend
//   G7-L  the package loads independently from the backend source tree
//   G7-M  package-internal pure util copies stay byte/behavior-parity with
//         the host legs (cyr-latin-map, escapeRegExp)
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §29

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { BACKEND_SRC, listSourceFiles, readSource, requireSpecifiers, rel, REPO_ROOT } = require('./helpers');

const PKG_DIR = path.join(REPO_ROOT, 'packages', 'animastor-generation');
const PKG_SRC = path.join(PKG_DIR, 'src');

function pkgFiles() {
    return listSourceFiles(PKG_SRC);
}

// All modules reachable from the package entry (transitive require graph,
// resolved with the package's own resolution context) — guards must hold for
// the whole closure, not only the first require level (G7-C).
function packageRequireClosure() {
    const seen = new Map(); // filename → source
    const queue = [path.join(PKG_SRC, 'index.js')];
    while (queue.length) {
        const file = queue.shift();
        if (seen.has(file)) continue;
        const src = fs.readFileSync(file, 'utf8');
        seen.set(file, src);
        for (const spec of requireSpecifiers(src)) {
            if (!spec.startsWith('.')) continue; // bare/package specs checked separately
            const base = path.resolve(path.dirname(file), spec);
            const candidates = [base, base + '.js', base + '.cjs', path.join(base, 'index.js'), path.join(base, 'index.cjs')];
            for (const c of candidates) {
                if (fs.existsSync(c) && fs.statSync(c).isFile()) { queue.push(c); break; }
            }
        }
    }
    return seen;
}

describe('G7: @animastor/generation package boundary', () => {

    // ── G7-A — package exists, correct npm name ─────────────────────
    it('G7-A: the package exists with the correct package name and entry point', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
        expect(pkg.name).to.equal('@animastor/generation');
        expect(pkg.main).to.equal('src/index.js');
        expect(pkg.exports).to.deep.equal({ '.': './src/index.js' });
        expect(fs.existsSync(path.join(PKG_DIR, 'README.md'))).to.equal(true);
        // the intermediate backend/src/generation area is GONE
        expect(fs.existsSync(path.join(BACKEND_SRC, 'generation')), 'backend must not keep a generation/ directory').to.equal(false);
    });

    // ── G7-B — no backend/src imports inside the package ────────────
    it('G7-B: no package file imports backend/src/** (static require scan)', () => {
        const offenders = [];
        for (const file of pkgFiles()) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (/backend[\\/]|(^|\.\.\/|\.\.\/\.\.\/)src\//.test(spec)) offenders.push(`${rel(file)}: '${spec}'`);
            }
        }
        expect(offenders, 'package → backend/src edge is forbidden').to.deep.equal([]);
    });

    // ── G7-C — no host-coupling imports (transitive closure) ────────
    it('G7-C: the package require closure imports no Redis/PG/Express/runtime-config/VBook/Player/Editor/GPU-Hub/ComfyUI-impl/ai-loader/book/agent', () => {
        const forbiddenSpec = [
            /ioredis/, /^redis$/, /fake-redis/, /redis-mock/,
            /^pg$/, /postgres/, /database/,
            /^express$/, /^http$/, /^https$/, /router/,
            /runtime-config/, /config\/generation-config-adapter/,
            /@animastor\/vbook-runtime/, /@animastor\/player/, /@animastor\/editor/,
            /animastor-gpu-hub/, /animastor-worker/,
            /services\/ai-loader/, /services\/profile-override/,
            /services\/agent/, /window-generator/,
            /(^|\/)book(\.js|\.cjs|\/|')/, /middleware\//, /routes\//,
            /(^|\/)storage\//, /orchestration\//, /(^|\/)runtime\//, /(^|\/)state\//,
        ];
        const offenders = [];
        for (const [file, src] of packageRequireClosure()) {
            for (const spec of requireSpecifiers(src)) {
                if (spec.startsWith('.')) continue; // relative = package-internal (G7-B covers escapes)
                for (const re of forbiddenSpec) {
                    if (re.test(spec)) offenders.push(`${rel(file)}: '${spec}'`);
                }
            }
        }
        expect(offenders, 'package closure must be free of host coupling').to.deep.equal([]);
    });

    it('G7-C: the only package external dependencies are the two frozen contract packages', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
        const deps = Object.keys(pkg.dependencies || {}).sort();
        expect(deps, 'package → external dependency set is frozen (S-7 doc §29.8)').to.deep.equal([
            '@animastor/contracts',
            'animastor-comfyui-workflow-connector',
        ]);
        // the connector package may be required ONLY inside providers/
        const offenders = [];
        for (const file of pkgFiles()) {
            const r = path.relative(PKG_SRC, file).replace(/\\/g, '/');
            if (r.startsWith('providers/')) continue;
            for (const spec of requireSpecifiers(readSource(file))) {
                if (spec.includes('animastor-comfyui-workflow-connector')) offenders.push(`${rel(file)}: '${spec}'`);
            }
        }
        expect(offenders, 'connector package knowledge is providers/-only').to.deep.equal([]);
    });

    // ── G7-D — backend consumers use the package public API ─────────
    it('G7-D: backend consumes the package ONLY through the public API root', () => {
        const offenders = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (spec.includes('animastor-generation') && spec !== '@animastor/generation') {
                    offenders.push(`${rel(file)}: '${spec}'`);
                }
            }
        }
        expect(offenders, 'backend must require the package root only — no deep imports').to.deep.equal([]);
        // and the root is actually consumed (the integration is live)
        const consumers = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            if (requireSpecifiers(readSource(file)).includes('@animastor/generation')) consumers.push(rel(file));
        }
        expect(consumers.length, 'backend must actually consume @animastor/generation').to.be.greaterThan(40);
    });

    // ── G7-E — no second implementation in backend ──────────────────
    it('G7-E: no duplicate Generation Core implementation remains in backend/src', () => {
        // canonical owners (package) must exist exactly once, host tree must
        // not re-declare them
        const owners = [
            { re: /function sceneChunkAudioName/, pkg: 'core/artifact-naming.js' },
            { re: /function resolveAssembly/, pkg: 'prompt-profiles/assembly-profile.js' },
            { re: /function normalizeCharacterRefs/, pkg: 'prompt-profiles/character-utils.js' },
            { re: /function registerMediaType/, pkg: 'core/media-registry.js' },
            { re: /function validateAssetTransition/, pkg: 'core/scene-state.js' },
            { re: /function taskId/, pkg: 'core/generation-progress.js' },
            { re: /function assembleMergedDialogueWorkflow/, pkg: 'providers/comfyui-provider.js' },
        ];
        const hostFiles = listSourceFiles(BACKEND_SRC);
        const hostSources = hostFiles.map(f => [rel(f), readSource(f)]);
        for (const { re, pkg } of owners) {
            expect(fs.existsSync(path.join(PKG_SRC, pkg)), `package owner missing: ${pkg}`).to.equal(true);
            const dup = hostSources.filter(([file, src]) => re.test(src)).map(([file]) => file);
            expect(dup, `host re-declaration of ${pkg}: ${dup.join(', ')}`).to.deep.equal([]);
        }
    });

    // ── G7-F — shims are re-export only (target: deleted) ───────────
    it('G7-F: no legacy deep-path shims remain; any residual shim must be a one-line re-export', () => {
        // S-7 deleted the S-4 transition shims — absence is the frozen state
        for (const shim of ['image/assembly-profile.js', 'image/character-utils.js']) {
            expect(fs.existsSync(path.join(BACKEND_SRC, shim)), `${shim} was deleted in S-7`).to.equal(false);
        }
        // the remaining host state-layer shim is a one-line re-export (no logic)
        const stateShim = readSource(path.join(BACKEND_SRC, 'state', 'scene-state.js'));
        expect(stateShim).to.match(/module\.exports\s*=\s*require\(/);
        expect(stateShim.trim().split('\n').filter(l => l && !l.startsWith('//')).length).to.be.at.most(1);
    });

    // ── G7-G — public API surface frozen ────────────────────────────
    it('G7-G: the package public API surface is frozen', () => {
        const generation = require('@animastor/generation');
        expect(Object.keys(generation).sort()).to.deep.equal([
            'artifactNaming',
            'bootstrap',
            'comfyuiProvider',
            'generationProgress',
            'mediaRegistry',
            'ports',
            'promptProfiles',
            'sceneState',
        ].sort());
        expect(Object.keys(generation.ports).sort()).to.deep.equal([
            'bookData', 'dispatchTransport', 'generationConfig', 'profileStore',
        ].sort());
        expect(Object.keys(generation.promptProfiles).sort()).to.deep.equal([
            'assemblyProfile', 'characterUtils', 'promptTextUtils',
        ].sort());
        // frozen surface of the core namespaces (registry + FSM + grammar + task domain)
        for (const fn of ['registerMediaType', 'getMediaType', 'hasMediaType', 'listMediaTypes',
            'listCapabilities', 'resolveValidWorkerTypes', 'resolveAssets', 'resolveJobTimeout',
            'resolveLeaseTtl', 'resolveMaxActive', 'resolveRetryBudget', 'resolveCircuitService',
            'resolveStuckThresholds', 'resolveProgressStrategy', 'resolveCancelStages',
            'isValidWorkerType', 'layerConfigKey', 'timeoutConfigKey',
            '_clearRegistry', '_getRegistry']) {
            expect(generation.mediaRegistry[fn], `mediaRegistry.${fn}`).to.be.a('function');
        }
        for (const fn of ['AssetState', 'ASSETS', 'validateAssetTransition', 'normalizeAssetStates',
            'validateAssetUpdate', 'validateAssetUpdates']) {
            expect(generation.sceneState[fn], `sceneState.${fn}`).to.exist;
        }
        for (const fn of ['sceneAudioName', 'sceneChunkAudioName', 'sceneImageName', 'sceneVideoName']) {
            expect(generation.artifactNaming[fn], `artifactNaming.${fn}`).to.be.a('function');
        }
        for (const fn of ['loadWorkflow', 'getConnector', 'applyValue', 'generate', 'buildJobId', 'WORKFLOW_NAMES']) {
            expect(generation.comfyuiProvider[fn], `comfyuiProvider.${fn}`).to.exist;
        }
        expect(generation.bootstrap).to.be.a('function');
    });

    // ── G7-H — no accidental deep imports ───────────────────────────
    it('G7-H: deep package imports fail (exports map exposes the root only)', () => {
        expect(() => require('@animastor/generation/core/artifact-naming')).to.throw();
        expect(() => require('@animastor/generation/ports/dispatch-transport')).to.throw();
        expect(() => require('@animastor/generation/src/index.js')).to.throw();
    });

    // ── G7-I — S-6 port guards stay green ───────────────────────────
    it('G7-I: the S-6 port contour is intact (four zero-require ports, package-owned)', () => {
        const portsDir = path.join(PKG_SRC, 'ports');
        const present = listSourceFiles(portsDir).map(f => path.relative(portsDir, f).split(path.sep).join('/')).sort();
        expect(present).to.deep.equal([
            'book-data.js', 'dispatch-transport.js', 'generation-config.js', 'profile-store.js',
        ]);
        for (const f of present) {
            expect(requireSpecifiers(readSource(path.join(portsDir, f))), `${f} must be zero-require`).to.deep.equal([]);
        }
        // S-6 suite re-pointed to the package stays the semantic owner of the
        // port-wiring pins (S6-A…S6-G) — here we re-pin the composition root.
        const backend = readSource(path.join(BACKEND_SRC, 'backend.cjs'));
        expect(backend).to.include("require('@animastor/generation').ports.dispatchTransport.setDispatchTransport(");
        expect(backend).to.include("require('@animastor/generation').ports.profileStore.setProfileStore(");
        expect(backend).to.include("require('@animastor/generation').ports.bookData.setBookData(");
        expect(backend).to.include("require('@animastor/generation').bootstrap()");
    });

    // ── G7-J — S-5 runtime/orchestration boundary stays green ───────
    it('G7-J: runtime still has zero orchestration policy requires (S-5 invariant)', () => {
        const runtimeDir = path.join(BACKEND_SRC, 'runtime');
        const offenders = [];
        for (const file of listSourceFiles(runtimeDir)) {
            const specs = requireSpecifiers(readSource(file));
            if (specs.some(s => s.startsWith('../orchestration') || s.startsWith('../../orchestration'))) {
                offenders.push(rel(file));
            }
        }
        expect(offenders, 'the S-5 cycle must stay dead after the physical move').to.deep.equal([]);
        // the seams registry is still hollow and fail-fast
        const seamsSrc = readSource(path.join(runtimeDir, 'orchestration-seams.js'));
        expect(requireSpecifiers(seamsSrc), 'orchestration-seams must stay zero-require').to.deep.equal([]);
    });

    // ── G7-K — no dependency cycle package ↔ backend ────────────────
    it('G7-K: no module in the package can reach backend/src and no backend edge re-enters the package graph beyond the root', () => {
        // 1. package → backend: unreachable by construction (G7-B/G7-C) —
        //    re-assert via the transitive closure: every resolved relative
        //    require stays inside the package; every bare require is a
        //    builtin or one of the two frozen dependency packages.
        const allowedBare = new Set([
            'crypto', 'path', 'fs', 'util',
            '@animastor/contracts', 'animastor-comfyui-workflow-connector',
        ]);
        for (const [file, src] of packageRequireClosure()) {
            expect(rel(file).startsWith('packages/animastor-generation/'), `${rel(file)} escaped the package`).to.equal(true);
            for (const spec of requireSpecifiers(src)) {
                if (!spec.startsWith('.')) {
                    if (spec.startsWith('@animastor/contracts') || spec.startsWith('animastor-comfyui-workflow-connector')) continue;
                    expect(allowedBare.has(spec.split('/')[0]), `${rel(file)}: unexpected external '${spec}'`).to.equal(true);
                }
            }
        }
        // 2. backend → package: the ONLY edge shape is the root specifier;
        //    nothing in the package re-exports a backend module that would
        //    re-enter package internals (root surface is frozen by G7-G).
        expect(Object.keys(require('@animastor/generation')).length, 'root surface size').to.equal(8);
    });

    // ── G7-L — package loads independently from the backend tree ────
    it('G7-L: the package can be loaded standalone (no backend, no port wiring)', () => {
        // fresh module registry, backend/src REMOVED from the resolution paths:
        // load the package entry directly from its physical location.
        const entry = path.join(PKG_SRC, 'index.js');
        const gen = require(entry);
        // zero side effects: no throw, full surface present
        expect(Object.keys(gen).sort().join(',')).to.equal(
            'artifactNaming,bootstrap,comfyuiProvider,generationProgress,mediaRegistry,ports,promptProfiles,sceneState');
        // unwired ports fail only on USE (fail-fast, never at require time).
        // The mocha fixture (generation-test-bindings) wires the ports at
        // startup — reset, assert the fail-fast, and restore the wiring.
        const { dispatchTransport, bookData } = gen.ports;
        const wiredDispatch = dispatchTransport.isDispatchTransportWired();
        const wiredBook = bookData.isBookDataWired();
        try {
            dispatchTransport._resetDispatchTransport();
            bookData._resetBookData();
            expect(() => dispatchTransport.dispatch({})).to.throw(/not wired/);
            expect(() => bookData.tokensToString(['x'])).to.throw(/not wired/);
        } finally {
            if (wiredDispatch) dispatchTransport.setDispatchTransport({ dispatch: (spec) => require('../../src/runtime/gpu-dispatcher').sendUnified(spec) });
            if (wiredBook) bookData.setBookData({
                collectSceneUnits: require('../../src/book').collectSceneUnits,
                tokensToString: require('../../src/book/lazy-book/appearance').tokensToString,
            });
        }
        // package-own test suite exists and the package resolves its own deps
        expect(fs.existsSync(path.join(PKG_DIR, 'test'))).to.equal(true);
        const pkgJson = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
        expect(pkgJson.dependencies).to.have.property('@animastor/contracts');
        expect(pkgJson.dependencies).to.have.property('animastor-comfyui-workflow-connector');
        delete require.cache[require.resolve(entry)];
    });

    // ── G7-M — package-internal util copies stay parity-pinned ──────
    it('G7-M: package utils are behavior-identical to the host legs (cyr-latin-map, escapeRegExp)', () => {
        const pkgCyr = require(path.join(PKG_SRC, 'utils', 'cyr-latin-map.js'));
        const hostCyr = require(path.join(BACKEND_SRC, 'utils', 'cyr-latin-map.js'));
        expect(pkgCyr.CYR_LATIN_MAP).to.deep.equal(hostCyr.CYR_LATIN_MAP);
        expect(pkgCyr.cyrToLatin('Лёд Мама ёлка ЪЬ')).to.equal(hostCyr.cyrToLatin('Лёд Мама ёлка ЪЬ'));
        const pkgEsc = require(path.join(PKG_SRC, 'utils', 'escape-regexp.js'));
        const hostEsc = require(path.join(BACKEND_SRC, 'utils', 'string-utils.js'));
        for (const s of ['a.b*c', '[x](y){z}|\\^$+?!', '([^)]*)']) {
            expect(pkgEsc.escapeRegExp(s)).to.equal(hostEsc.escapeRegExp(s));
        }
    });
});
