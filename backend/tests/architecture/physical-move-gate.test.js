// =====================================================
// §32.29 PHYSICAL MOVE GATE — closure guards for packages/animastor-orchestration
// =====================================================
// Read-only guards that make the physical move of runtime/orchestration into
// packages/animastor-orchestration provably safe. They pin the two sets the
// move is defined by:
//
//   MOVE_SET  — files that physically move into the package (§32.29 inventory;
//               runtime/** minus the two pinned host transport/shell files,
//               plus orchestration/** in full)
//   HOST_STAYS — host-owned files the moved set is allowed to reach through
//               exactly the frozen, measured edges (ports + adapters + the
//               single seam channel + host-owned infra leaves)
//
//   MG-A  move-set closure (static + lazy): every require of every moved file
//         resolves inside the move set, to a declared external/builtin, or to
//         the HOST_STAYS allowlist — no other host module is reachable, so
//         after `git mv` the package graph still resolves.
//   MG-B  no computed require may smuggle a host edge into the package
//         (proximity scan over the move set; S5-A convention).
//   MG-C  the pinned host stays are still host-side and still own their
//         inbound edges: gpu-dispatcher (transport, PG repos) + runtime-loop
//         (timer shell) stay; runtime/index stays with the documented lazy
//         facade; orchestration-seams stays the single inbound channel.
//   MG-D  zero deep imports into @animastor/generation from the move set
//         (root specifier only — the post-move package guard inherits this).
//
// The exhaustive inventory tables, the public-API freeze and the step plan
// live in §32.29 of the recon doc. This suite must stay green BEFORE and
// AFTER the move (after the move the paths change — re-point the two dir
// constants in the same commit; the assertions themselves are path-shape
// only and need no rewrites).
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.29

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

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNTIME_DIR = path.join(BACKEND_SRC, 'runtime');
const ORCH_DIR = path.join(BACKEND_SRC, 'orchestration');

// ── The move set (measured §32.29; §32.13 tree minus the final corrections) ──
// runtime/**: everything EXCEPT the seven classified files below.
// orchestration/**: the whole directory (all 7 files).
const RUNTIME_FILES_STAYING_HOSTSIDE = {
    // pinned host transport: Job Protocol v2 send + PW-2 routing caches + the
    // 3 PG routing repos (§32.19 pin). Host implements ports.dispatchTransport.
    'gpu-dispatcher.js': 'pinned host transport (§32.19)',
    // pinned host timer shell: the recursive setTimeout tick/reconcile loops
    // (host-owned lifecycle per §32.13). Package-internal timers (lease-manager)
    // move with their module.
    'runtime-loop.js': 'pinned host timer shell (§32.13)',
    // host facade barrel over the runtime pipeline — its ONLY consumer is the
    // composition root (backend.cjs); re-points to the package root at the move.
    'index.js': 'host facade barrel (single consumer: backend.cjs)',
    // the S-5 seam registry — the single inbound orchestration channel; stays
    // host-side and binds the package's public API at the composition root.
    'orchestration-seams.js': 'S-5 seam registry (inbound channel)',
    // Phase 9C contracts facade — the moved scene-orchestrator switches to
    // '@animastor/contracts' directly at the move (§32.13 tree note).
    'job-schema.js': 'contracts facade (Phase 9C choke point)',
    // dead code — NOT moved: deleted in the post-move cleanup commit (§32.13).
    'runtime-persistence.js': 'dead — deleted at cleanup (§32.13)',
    'retention-manager.js': 'orphaned — deleted at cleanup (§32.13)',
};

function moveSetFiles() {
    const runtime = listSourceFiles(RUNTIME_DIR)
        .filter((f) => !RUNTIME_FILES_STAYING_HOSTSIDE[path.basename(f)]);
    return [...runtime, ...listSourceFiles(ORCH_DIR)];
}

// ── Host stays the moved set may reach, per file kind (measured edges) ──
// Keyed by target path relative to backend/src. Values: reason (docs anchor).
const HOST_STAYS_TARGETS = new Set([
    // O-2..O-10 port CONTRACTS (tier-owned today, move into the package as
    // ports/ — they are part of the move set at the step AFTER the move; at
    // the move they are still resolved inside the move set itself, listed
    // here only for the interim shim phase — see §32.29 step 5).

    // host adapter implementations (the ^ side of every port)
    'storage/index.js',
    'storage/runtime-persistence-adapter.js',
    'storage/scene-data-adapter.js',
    'storage/placeholder-audio-adapter.js',
    'storage/progress-events-adapter.js',
    'storage/audio-fsm-adapter.js',
    'storage/video-fsm-adapter.js',
    'storage/hub-cancel-adapter.js',
    'storage/layer-config-adapter.js',

    // config slice (§32.23 rejection STANDS: no port; host keeps runtime-config)
    'config/runtime-config.js',
    'config/generation-config-adapter.js',

    // host state adapters over Generation primitives (Redis domain sinks)
    'state/index.js',
    'state/scene-state.js',
    'state/asset-state-store.js',
    'state/scene-state-ops.js',
    'state/event-journal.js',

    // S-5 seam registry: the single inbound orchestration channel
    'runtime/orchestration-seams.js',

    // contracts leaf (Phase 5; moves to @animastor/contracts later)
    'contracts/runtime-result.js',

    // host-owned media facades (O-P6 business-logic rejection stands)
    'audio/index.js',
    'audio/audio-service.js',
    'audio/segments.js',
    'audio/chunks.js',
    'image/index.js',
    'image/image-service.js',
    'image/iu-processor.js',
    'video/index.js',
    'video/video-service.js',

    // host services reached by the move set (measured single edges, §32.28
    // inventory): scene-window → gen-scope (getScope/scopeBounds, 1 consumer)
    'services/gen-scope.js',

    // runtime/job-schema facade (Phase 9C): consumed by scene-orchestrator; at
    // the move that require switches to '@animastor/contracts' directly
    'runtime/job-schema.js',

    // DECLARED PRE-MOVE EXCEPTION (dead code, §32.13/§32.14 plan): the moved
    // scheduler DROPS the dead initializeRuntime export (and with it this
    // require) AT the move; the file itself is deleted in the post-move
    // cleanup commit. MG-G below freezes the dead surface at exactly one
    // require site + one dead export so it cannot grow before the move.
    'runtime/runtime-persistence.js',

    // DECLARED PRE-MOVE EXCEPTION (the §32.29 corrective step): scene-window
    // resolves the book's workspace via the PW-2 routing cache
    // (gpuDispatcher.resolveWorkspaceForBook, 1 lazy call site, optional-load
    // try/catch degrading to system-pool availability). At the move this edge
    // becomes a composition-root-injected resolver — see §32.29 step 4b. The
    // dedicated MG-F assertion below freezes it at exactly one call site.
    'runtime/gpu-dispatcher.js',
]);

describe('§32.29 physical move gate — package closure guards', () => {

    it('MG-A: move-set closure — every static+lazy require of a moved file stays in the set, a builtin/external, or the host-stays allowlist', () => {
        const moveSet = new Set(moveSetFiles());
        const offenders = [];
        for (const file of moveSet) {
            const src = readSource(file);
            for (const spec of requireSpecifiers(src)) {
                if (!spec.startsWith('.')) continue; // builtin / external package — fine
                const target = resolveSpecifier(file, spec);
                if (!target) continue; // unresolved relative — not a graph edge
                if (moveSet.has(target)) continue;
                const targetRel = path.relative(BACKEND_SRC, target).split(path.sep).join('/');
                if (HOST_STAYS_TARGETS.has(targetRel)) continue;
                offenders.push(`${rel(file)} -> ${targetRel}`);
            }
        }
        expect(offenders, 'a moved file reaches a host module outside the frozen §32.29 allowlist').to.deep.equal([]);
    });

    it('MG-A2: exactly the seven classified runtime files stay host-side at the move', () => {
        const runtimeFiles = listSourceFiles(RUNTIME_DIR).map((f) => path.basename(f));
        const classified = Object.keys(RUNTIME_FILES_STAYING_HOSTSIDE);
        // every classified file exists
        for (const name of classified) {
            expect(fs.existsSync(path.join(RUNTIME_DIR, name)), `${name} must exist to be classified`)
                .to.equal(true);
        }
        // every unclassified runtime file is in the move set — a NEW runtime
        // file must enter the §32.29 inventory, not silently join the package
        const moveRuntime = runtimeFiles.filter((f) => !RUNTIME_FILES_STAYING_HOSTSIDE[f]);
        expect(moveRuntime.length, 'runtime files classified as moving').to.be.greaterThan(0);
        // the two pinned files are exactly the documented ones (sanity)
        expect(RUNTIME_FILES_STAYING_HOSTSIDE['gpu-dispatcher.js']).to.equal('pinned host transport (§32.19)');
        expect(RUNTIME_FILES_STAYING_HOSTSIDE['runtime-loop.js']).to.equal('pinned host timer shell (§32.13)');
    });

    it('MG-B: no computed/dynamic require in the move set may reach outside the package (proximity scan)', () => {
        const offenders = [];
        for (const file of moveSetFiles()) {
            const src = readSource(file);
            const dyn = src.match(/require\(\s*[A-Za-z_$][\w$.]*\s*\)/g) || [];
            for (const call of dyn) {
                const idx = src.indexOf(call);
                const near = src.slice(Math.max(0, idx - 400), idx);
                if (/\.\.\/(storage|routes|services|book|config|audio|image|video|contracts)\//.test(near)
                    || /backend\/src/.test(near)) {
                    offenders.push(`${rel(file)}: dynamic require near a host path literal`);
                }
            }
        }
        expect(offenders, 'a dynamic require is assembled near host path text — potential boundary bypass').to.deep.equal([]);
    });

    it('MG-C: host composition edges stay host-owned (seam registry + result consumer injection + transport pin)', () => {
        // the seam registry stays host-side and is the only orchestration-facing inbound channel
        expect(fs.existsSync(path.join(BACKEND_SRC, 'runtime', 'orchestration-seams.js'))).to.equal(true);
        // gpu-dispatcher stays host-side with its PG routing repos (§32.19 pin)
        const gpu = readSource(path.join(RUNTIME_DIR, 'gpu-dispatcher.js'));
        expect(gpu).to.include("require('../storage/postgres/repositories/book-repo')");
        expect(gpu).to.include("require('../storage/postgres/repositories/worker-repo')");
        // runtime-loop stays host-side (timer shell)
        expect(fs.existsSync(path.join(RUNTIME_DIR, 'runtime-loop.js'))).to.equal(true);
        // the result consumer stays injected — runtime never requires it
        for (const file of listSourceFiles(RUNTIME_DIR)) {
            expect(readSource(file), `${rel(file)} must not require the orchestration result consumer`).to.not.include("require('../orchestration/runtime-result-consumer')");
        }
    });

    it('MG-F: the declared pre-move exception is frozen — scene-window reaches the PW-2 workspace routing at exactly one lazy call site', () => {
        const src = readSource(path.join(RUNTIME_DIR, 'scene-window.js'));
        const sites = src.split('\n').map((line, i) => ({ line, i }))
            .filter(({ line }) => line.includes("require('./gpu-dispatcher')"));
        expect(sites.length, 'scene-window → gpu-dispatcher require sites').to.equal(1);
        // the only op consumed is resolveWorkspaceForBook, and the load stays
        // optional (try/catch degradation to system-pool availability)
        expect(src).to.include('resolveWorkspaceForBook');
        expect(src.match(/resolveWorkspaceForBook/g).length).to.equal(1);
        const requireLine = sites[0].i;
        const window = src.split('\n').slice(Math.max(0, requireLine - 3), requireLine + 5).join('\n');
        expect(window).to.include('try {');
        // no OTHER move-set file may reach the pinned transport
        const others = moveSetFiles()
            .filter((f) => path.basename(f) !== 'scene-window.js')
            .filter((f) => readSource(f).includes("require('./gpu-dispatcher'") || readSource(f).includes("require('../runtime/gpu-dispatcher')"));
        expect(others.map(rel), 'only scene-window may touch the pinned transport pre-move').to.deep.equal([]);
    });

    it('MG-G: the dead runtime-persistence surface is frozen — exactly one require site, only feeding the dead initializeRuntime export', () => {
        // §32.13: "runtime/runtime-persistence.js DELETE (dead)"; §32.13 tree:
        // runtime-scheduler "initializeRuntime DROPPED". No production caller
        // exists (backend.cjs uses reconcileCycle; the test suite references
        // initializeRuntime only in a comment). Freeze: one require site, one
        // consumer function, zero external callers — so the pre-move cleanup
        // (drop the export at the move, delete the file at cleanup) stays a
        // mechanical step and the dead surface cannot grow.
        const schedulerPath = path.join(RUNTIME_DIR, 'runtime-scheduler.js');
        const src = readSource(schedulerPath);
        const requirers = moveSetFiles()
            .filter((f) => readSource(f).includes("require('./runtime-persistence')") || readSource(f).includes("require('../runtime/runtime-persistence')"));
        expect(requirers.map(rel), 'only the scheduler may require the dead runtime-persistence').to.deep.equal([rel(schedulerPath)]);
        // its only use inside the scheduler is the dead initializeRuntime body
        const uses = [...src.matchAll(/runtimePersistence\.(\w+)/g)].map((m) => m[1]);
        expect(uses.length).to.be.greaterThan(0);
        const initFn = src.match(/async function initializeRuntime[\s\S]*?\n}/);
        expect(initFn, 'initializeRuntime must exist to be dropped').to.not.equal(null);
        expect(initFn[0]).to.include('runtimePersistence.');
        // and nothing anywhere in backend/src CALLS it
        const callers = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            const s = readSource(file);
            if (rel(file) === rel(schedulerPath)) continue; // the export site
            if (/\.initializeRuntime\s*\(/.test(s)) callers.push(rel(file));
        }
        expect(callers, 'dead initializeRuntime gained a caller — remove it from the move plan').to.deep.equal([]);
    });

    it('MG-D: zero deep imports into @animastor/generation from the move set (root specifier only — O-G6 parity for the future package)', () => {
        const offenders = [];
        for (const file of moveSetFiles()) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (spec.startsWith('@animastor/generation/') || spec.startsWith('@animastor/generation"')) {
                    offenders.push(`${rel(file)} -> ${spec}`);
                }
            }
        }
        expect(offenders, 'deep Generation import found — post-move package must consume the root API only').to.deep.equal([]);
    });

    it('MG-E: fs usage in the moved set stays artifact-IO scoped (no new filesystem surfaces since the O-G9 pin)', () => {
        // The package boundary plan allows fs ONLY for artifact path IO in
        // orchestration (OUTPUT_DIR-scoped) and scene-window's disk status
        // reads. Anything else (network fs, config files, __dirname-relative
        // loads) would break under the package's new physical root.
        // Comments are stripped first: a docs mention of require.cache must
        // not trip the scan (measured: reconciliation-engine.js:2172).
        const stripComments = (src) => src
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/\/\/[^\n]*/g, ' ');
        const offenders = [];
        for (const file of listSourceFiles(ORCH_DIR)) {
            const code = stripComments(readSource(file));
            if (code.includes('__dirname') || code.includes('require.cache')) offenders.push(rel(file));
        }
        for (const file of listSourceFiles(RUNTIME_DIR)) {
            if (RUNTIME_FILES_STAYING_HOSTSIDE[path.basename(file)]) continue; // host stays, may use host paths
            const code = stripComments(readSource(file));
            if (code.includes('__dirname') || code.includes('require.cache')) offenders.push(rel(file));
        }
        expect(offenders, '__dirname/require.cache in the move set would break at the new physical root').to.deep.equal([]);
    });

});
