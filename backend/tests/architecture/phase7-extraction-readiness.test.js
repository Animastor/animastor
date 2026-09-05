// ======================================================
// PHASE 7 — Extraction readiness guards
// ======================================================
// Freezes the module boundaries measured by the Phase 7 extraction-readiness
// audit so they cannot degrade silently. This suite does NOT repeat the
// Phase 1–6 rules (worker/hub/LAC outbound allowlists, book allowlist R4,
// runtime→orchestration edge freeze R5, Phase 6 player/editor T1–T7) — it
// guards the *inbound* and *membership* sides those suites do not cover.
// Docs: docs/architecture/PHASE_7_EXTRACTION_READINESS.md
//
//   P7-T1 — LAC package isolation (inbound + outbound + manifest)
//   P7-T2 — Worker inbound isolation (nothing requires into worker/)
//   P7-T3 — GPU Hub inbound code isolation (nothing requires into gpu-hub/)
//   P7-T4 — VBook internals consumer freeze (raw book/lazy-book reach-ins)
//   P7-T5 — Book Model facade edge freeze
//   P7-T6 — Provider Gateway delegate + consumer set freeze
//   P7-T7 — Cycle membership freeze (no new module joins the SCCs)
//   P7-T8 — gpu-dispatcher bypass set freeze (Provider Gateway seam)

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const { REPO_ROOT, BACKEND_SRC, listSourceFiles, readSource, rel } = require('./helpers');

const LAC_DIR = path.join(REPO_ROOT, 'ai-connector');
const WORKER_DIR = path.join(REPO_ROOT, 'worker', 'worker');
const HUB_DIR = path.join(REPO_ROOT, 'gpu-hub');

function walkSource(dir, extensions = ['.js', '.cjs']) {
    return listSourceFiles(dir, extensions);
}

/** Resolved relative require targets of a file (repo-relative posix paths). */
function relativeTargets(file) {
    const out = [];
    for (const spec of require('./helpers').requireSpecifiers(readSource(file))) {
        if (!spec.startsWith('.')) continue;
        const base = path.resolve(path.dirname(file), spec);
        const candidates = [base, base + '.js', base + '.cjs', path.join(base, 'index.js'), path.join(base, 'index.cjs')];
        let resolved = null;
        for (const c of candidates) {
            if (fs.existsSync(c) && fs.statSync(c).isFile()) { resolved = c; break; }
        }
        out.push({ spec, target: rel(resolved || base) });
    }
    return out;
}

// ── P7-T1 — Local AI Connector package isolation ─────────────────────────
describe('P7-T1: LAC stays an isolated package (extraction candidate)', () => {
    it('has its own package manifest with ws as the only runtime dep', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(LAC_DIR, 'package.json'), 'utf8'));
        expect(pkg.name).to.equal('animastor-ai-connector');
        expect(Object.keys(pkg.dependencies || {})).to.deep.equal(['ws']);
    });

    it('no file inside LAC requires outside the LAC directory', () => {
        const offenders = [];
        for (const file of walkSource(LAC_DIR)) {
            for (const { spec, target } of relativeTargets(file)) {
                if (!target.startsWith('ai-connector/')) offenders.push(`${rel(file)}: ${spec}`);
            }
        }
        expect(offenders, 'LAC must stay a standalone distributable (Phase 7 audit §2.6)').to.deep.equal([]);
    });

    it('no repo file requires into LAC (the only interface is the WS protocol)', () => {
        const offenders = [];
        for (const dir of [BACKEND_SRC, WORKER_DIR, HUB_DIR]) {
            for (const file of walkSource(dir)) {
                for (const { spec, target } of relativeTargets(file)) {
                    if (target.startsWith('ai-connector/')) offenders.push(`${rel(file)}: ${spec}`);
                }
            }
        }
        expect(offenders, 'nothing may code-depend on the connector; the boundary is LAC v1 over WS').to.deep.equal([]);
    });
});

// ── P7-T2 — Worker inbound isolation ─────────────────────────────────────
describe('P7-T2: worker bundle gains no inbound code dependencies', () => {
    it('no repo file requires into worker/worker/', () => {
        const offenders = [];
        for (const dir of [BACKEND_SRC, HUB_DIR, LAC_DIR]) {
            for (const file of walkSource(dir)) {
                for (const { spec, target } of relativeTargets(file)) {
                    if (target.startsWith('worker/')) offenders.push(`${rel(file)}: ${spec}`);
                }
            }
        }
        expect(offenders, 'the worker is reached only via the GPU Hub HTTP contract').to.deep.equal([]);
    });
});

// ── P7-T3 — GPU Hub inbound code isolation ───────────────────────────────
describe('P7-T3: GPU Hub gains no inbound code dependencies', () => {
    it('no backend/worker/LAC file requires into gpu-hub/', () => {
        const offenders = [];
        for (const dir of [BACKEND_SRC, WORKER_DIR, LAC_DIR]) {
            for (const file of walkSource(dir)) {
                for (const { spec, target } of relativeTargets(file)) {
                    if (target.startsWith('gpu-hub/')) offenders.push(`${rel(file)}: ${spec}`);
                }
            }
        }
        expect(offenders, 'backend↔hub coupling stays at HTTP + shared Redis contract only').to.deep.equal([]);
    });
});

// ── P7-T4 — VBook internals consumer freeze ──────────────────────────────
describe('P7-T4: VBook internals are not reached by new direct consumers', () => {
    // The Canonical Book Model facade (Phase 4) is the consumer-facing entry.
    // The files below still reach the raw book domain directly — that is the
    // measured, baselined state (Phase 7 audit §2.1/§2.3/§2.4). A NEW file
    // requiring the book domain fails; migrating an existing one to the
    // facade must remove its baseline entry in the same change.
    const RAW_BOOK_BASELINE = [
        'backend/src/backend.cjs: ./book',
        'backend/src/backend.cjs: ./book/book-deletion.cjs',
        'backend/src/backend.cjs: ./book/lazy-book',
        'backend/src/helpers/redis-helpers.cjs: ../book',
        'backend/src/orchestration/scene-callbacks.js: ../book',
        'backend/src/orchestration/scene-orchestrator.js: ../book',
        'backend/src/routes/ai-routes.cjs: ../book/bundle-validator.cjs',
        'backend/src/routes/book/entity-crud-routes.cjs: ../../book/lazy-book/paths',
        'backend/src/runtime/reconciliation-engine.js: ../book',
        'backend/src/runtime/runtime-scheduler.js: ../book',
        'backend/src/runtime/scene-window.js: ../book',
        'backend/src/services/agent-prompts.js: ../book/lazy-book/parser',
        'backend/src/services/agent/bootstrap.js: ../../book/lazy-book',
        'backend/src/services/agent/pipeline-runner.js: ../../book/lazy-book',
        'backend/src/services/agent/pipeline-steps.js: ../../book/lazy-book/appearance',
        'backend/src/services/book-source.js: ../book',
        'backend/src/services/chat-engine.cjs: ../book/bundle-validator.cjs',
        'backend/src/services/placeholder-audio.js: ../book',
        'backend/src/services/placeholder-audio.js: ../book/lazy-book',
        'backend/src/services/source-coverage-audit.js: ../book/lazy-book',
        'backend/src/services/txt-importer.js: ../book/lazy-book',
        'backend/src/workflows/video/video-workflows.js: ../../book',
        'backend/src/workflows/video/video-workflows.js: ../../book/lazy-book/appearance',
    ];

    function bookDomainEdges() {
        const bookRoot = path.join(BACKEND_SRC, 'book');
        const edges = [];
        for (const file of walkSource(BACKEND_SRC)) {
            if (rel(file).startsWith('backend/src/book/')) continue; // intra-domain
            for (const { spec, target } of relativeTargets(file)) {
                if (target.startsWith('backend/src/book/')) edges.push(`${rel(file)}: ${spec}`);
            }
        }
        return [...new Set(edges)].sort();
    }

    it('the raw-book consumer set matches the frozen baseline exactly', () => {
        // backend.cjs book-model.cjs + the two facades are the ALLOWED
        // consumer-facing entries (Phase 4/6); they are excluded here because
        // they are pinned by their own suites (phase4/phase6).
        const allowed = new Set([
            'backend/src/backend.cjs: ./book/book-model.cjs',
            'backend/src/editor/index.cjs: ../book/book-model.cjs',
            'backend/src/player/index.cjs: ../book/book-model.cjs',
        ]);
        const set = bookDomainEdges().filter((e) => !allowed.has(e));
        expect(set, 'VBook internals gained a new direct consumer — go through the Book Model facade (or update the Phase 7 baseline consciously)').to.deep.equal([...RAW_BOOK_BASELINE].sort());
    });
});

// ── P7-T5 — Book Model facade edge freeze ────────────────────────────────
describe('P7-T5: Book Model facade stays implementation-free', () => {
    it('book-model.cjs requires only inside the book domain', () => {
        const offenders = relativeTargets(path.join(BACKEND_SRC, 'book', 'book-model.cjs'))
            .filter(({ target }) => !target.startsWith('backend/src/book/'));
        expect(offenders.map(({ spec }) => spec), 'the facade must not grow backend implementation deps (Phase 7 audit §2.2)').to.deep.equal([]);
    });
});

// ── P7-T6 — Provider Gateway boundary freeze ─────────────────────────────
describe('P7-T6: Provider Gateway delegate and consumer sets stay explicit', () => {
    // The gateway is a delegation-only facade (Phase 3). Its delegate module
    // set and its direct-consumer set are frozen: adding a delegate or a
    // consumer must update this baseline consciously (extraction-relevant,
    // Phase 7 audit §2.5).
    const GATEWAY = path.join(BACKEND_SRC, 'services', 'provider-gateway.js');
    const DELEGATE_BASELINE = [
        './ai-service',
        './agent/ai-caller',
        './workspace-ai-provider',
        './ai-connector/shared-pool',
        '../generation/comfyui-provider',
        '../runtime/gpu-dispatcher',
        '../storage/postgres/repositories/ai-connector-repo',
    ];
    const CONSUMER_BASELINE = ['backend/src/routes/ai-routes.cjs'];

    it('the delegate module set matches the baseline', () => {
        const specs = [...new Set(relativeTargets(GATEWAY).map(({ spec }) => spec))].sort();
        expect(specs, 'Provider Gateway delegate set changed — update docs/architecture/PHASE_7_EXTRACTION_READINESS.md §2.5').to.deep.equal([...DELEGATE_BASELINE].sort());
    });

    it('the direct consumer set matches the baseline', () => {
        const consumers = [];
        for (const file of walkSource(BACKEND_SRC)) {
            if (rel(file) === 'backend/src/services/provider-gateway.js') continue;
            const { requireSpecifiers } = require('./helpers');
            for (const spec of requireSpecifiers(readSource(file))) {
                const base = path.resolve(path.dirname(file), spec);
                const candidates = [base, base + '.js', base + '.cjs', path.join(base, 'index.js'), path.join(base, 'index.cjs')];
                for (const c of candidates) {
                    if (fs.existsSync(c) && fs.statSync(c).isFile() && c === GATEWAY) { consumers.push(rel(file)); break; }
                }
            }
        }
        expect([...new Set(consumers)].sort(), 'a new module bypasses the seam consumers baseline').to.deep.equal([...CONSUMER_BASELINE].sort());
    });
});

// ── P7-T7 — Cycle membership freeze ──────────────────────────────────────
describe('P7-T7: no new module joins the orchestration↔runtime cycles', () => {
    // Tarjan SCC over backend/src. Phase 1 R5 freezes runtime→orchestration
    // EDGES; this freezes cycle MEMBERSHIP — even a new edge through services
    // or another layer cannot silently pull a new module into the cycle.
    // Baseline measured at the Phase 7 audit commit (§2.11).
    const BIG_CYCLE_BASELINE = [
        'backend/src/image/image-service.js',
        'backend/src/image/index.js',
        'backend/src/image/iu-processor.js',
        'backend/src/orchestration/index.js',
        'backend/src/orchestration/orchestrator.js',
        'backend/src/orchestration/scene-callbacks.js',
        'backend/src/orchestration/scene-orchestrator.js',
        'backend/src/orchestration/scene-restoration.js',
        'backend/src/runtime/dispatch-engine.js',
        'backend/src/runtime/reconciliation-engine.js',
        'backend/src/runtime/runtime-scheduler.js',
        'backend/src/runtime/scene-window.js',
        'backend/src/services/placeholder-audio.js',
        'backend/src/services/video-orchestrator.js',
    ];
    const RESOLVER_CYCLE_BASELINE = [
        'backend/src/services/system-ai.js',
        'backend/src/services/workspace-ai-provider.js',
    ];

    function buildGraph() {
        const files = walkSource(BACKEND_SRC);
        const graph = new Map();
        for (const file of files) {
            const deps = [];
            for (const { target } of relativeTargets(file)) {
                const abs = path.join(REPO_ROOT, target);
                if (fs.existsSync(abs) && fs.statSync(abs).isFile()) deps.push(abs);
            }
            graph.set(file, deps);
        }
        return { files, graph };
    }

    function tarjanSCC(graph, files) {
        const index = new Map(), low = new Map(), onStack = new Set(), stack = [], sccs = [];
        let counter = 0;
        function strong(v) {
            index.set(v, counter); low.set(v, counter); counter++;
            stack.push(v); onStack.add(v);
            for (const w of graph.get(v) || []) {
                if (!index.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
                else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
            }
            if (low.get(v) === index.get(v)) {
                const scc = [];
                let w;
                do { w = stack.pop(); onStack.delete(w); scc.push(w); } while (w !== v);
                if (scc.length > 1) sccs.push(scc);
            }
        }
        for (const f of files) if (!index.has(f)) strong(f);
        return sccs;
    }

    it('the big orchestration↔runtime↔services↔image SCC has exactly the baseline members', () => {
        const { files, graph } = buildGraph();
        const sccs = tarjanSCC(graph, files);
        const target = sccs.find((s) => s.some((f) => rel(f).startsWith('backend/src/runtime/')));
        expect(target, 'the runtime cycle disappeared (baseline update needed)').to.exist;
        const members = target.map(rel).sort();
        expect(members, 'a NEW module joined the orchestration↔runtime cycle (Phase 7 audit §2.11)').to.deep.equal([...BIG_CYCLE_BASELINE].sort());
    });

    it('the workspace-ai-provider ⇄ system-ai SCC has exactly the baseline members', () => {
        const { files, graph } = buildGraph();
        const sccs = tarjanSCC(graph, files);
        const target = sccs.find((s) => s.some((f) => rel(f) === 'backend/src/services/workspace-ai-provider.js'));
        expect(target, 'the resolver cycle disappeared (baseline update needed)').to.exist;
        const members = target.map(rel).sort();
        expect(members, 'a NEW module joined the provider-resolver cycle (Phase 7 audit §2.5)').to.deep.equal([...RESOLVER_CYCLE_BASELINE].sort());
    });
});

// ── P7-T8 — gpu-dispatcher bypass set freeze ─────────────────────────────
describe('P7-T8: the Provider Gateway generation seam bypass set stays frozen', () => {
    // Phase 3 created generation.sendJob / ComfyUIProvider as the dispatch
    // seam; these modules still call runtime/gpu-dispatcher directly
    // (documented Phase 3 §12 debt, measured Phase 7 §2.5). The set is
    // pinned: migration to the seam removes entries here consciously.
    const BYPASS_BASELINE = [
        'backend/src/audio/generation.js: ../runtime/gpu-dispatcher',
        'backend/src/generation/comfyui-provider.js: ../runtime/gpu-dispatcher',
        'backend/src/helpers/redis-helpers.cjs: ../runtime/gpu-dispatcher',
        'backend/src/image/iu-processor.js: ../runtime/gpu-dispatcher',
        'backend/src/orchestration/scene-orchestrator.js: ../runtime/gpu-dispatcher',
        'backend/src/runtime/scene-window.js: ./gpu-dispatcher',
        'backend/src/services/provider-gateway.js: ../runtime/gpu-dispatcher',
        'backend/src/video/video-service.js: ../runtime/gpu-dispatcher',
    ];

    it('direct gpu-dispatcher require set matches the baseline exactly', () => {
        const edges = [];
        for (const file of walkSource(BACKEND_SRC)) {
            for (const { spec, target } of relativeTargets(file)) {
                if (target === 'backend/src/runtime/gpu-dispatcher.js') edges.push(`${rel(file)}: ${spec}`);
            }
        }
        expect([...new Set(edges)].sort(), 'a new module bypasses the generation dispatch seam (route through ProviderGateway.generation or update the Phase 7 baseline)').to.deep.equal([...BYPASS_BASELINE].sort());
    });
});
