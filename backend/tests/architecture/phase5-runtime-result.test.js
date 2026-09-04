// ======================================================
// PHASE 5 — Break Orchestration ↔ Runtime Cycle
// ======================================================
// Tests for the Runtime Result Contract seam:
//   T1  contract shape
//   T2  runtime does not import orchestration (static dependency check)
//   T3  orchestration consumes runtime result through the seam
//   T4  'completed' passes through the seam
//   T5  'failed' passes through the seam
//   T6  'cancelled' passes through the seam
//   T7  no Job Protocol v2 regression
//   T8  no new architectural cycle through services/event helpers
//   T9  no dynamic/template require or import() can reach orchestration
//   T10 runtime→services imports open no orchestration endpoint beyond the pins
//   T11 runtime-result-emitter is the only producer of the runtime-result contract
//
// Docs: docs/architecture/PHASE_5_ORCHESTRATION_RUNTIME.md

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const {
    listSourceFiles,
    readSource,
    rel,
    REPO_ROOT,
    requireSpecifiers,
    resolveSpecifier,
} = require('./helpers');

const BACKEND_SRC = path.join(REPO_ROOT, 'backend', 'src');
const CONTRACTS_DIR = path.join(BACKEND_SRC, 'contracts');
const RUNTIME_DIR = path.join(BACKEND_SRC, 'runtime');
const ORCH_DIR = path.join(BACKEND_SRC, 'orchestration');
const SERVICES_DIR = path.join(BACKEND_SRC, 'services');

const contract = require('../../src/contracts/runtime-result');
const emitter = require('../../src/runtime/runtime-result-emitter');

// ── T1 — Runtime result contract ────────────────────────
describe('Phase 5 T1: runtime result contract', () => {
    it('exposes exactly the documented stable shape', () => {
        const result = contract.createRuntimeResult({
            bookId: 'b1',
            chapterId: 'c1',
            sceneId: 's1',
            stage: 'audio',
            status: 'completed',
            jobId: 'job-1',
            dispatchId: 'disp-1',
            error: null,
            metadata: { outcome: 'success' },
        });

        expect(Object.keys(result).sort()).to.deep.equal([
            'bookId', 'chapterId', 'dispatchId', 'error', 'jobId',
            'metadata', 'result', 'sceneId', 'stage', 'status',
        ]);
        expect(result.bookId).to.equal('b1');
        expect(result.chapterId).to.equal('c1');
        expect(result.sceneId).to.equal('s1');
        expect(result.stage).to.equal('audio');
        expect(result.status).to.equal('completed');
        expect(result.jobId).to.equal('job-1');
        expect(result.dispatchId).to.equal('disp-1');
        expect(result.result).to.equal(null);
        expect(result.error).to.equal(null);
        expect(result.metadata).to.deep.equal({ outcome: 'success' });
    });

    it('limits status to completed | failed | cancelled', () => {
        expect([...contract.RUNTIME_RESULT_STATUSES].sort()).to.deep.equal(
            ['cancelled', 'completed', 'failed']
        );
    });

    it('rejects unknown status and invalid ids', () => {
        expect(() => contract.createRuntimeResult({
            bookId: 'b', chapterId: 'c', sceneId: 's', status: 'pending',
        })).to.throw(/status/);
        expect(() => contract.createRuntimeResult({
            chapterId: 'c', sceneId: 's', status: 'completed',
        })).to.throw(/bookId/);
        expect(() => contract.createRuntimeResult({
            bookId: 'b', chapterId: 'c', sceneId: 's', status: 'completed',
        })).to.throw(/jobId or dispatchId/);
    });

    it('returns a frozen object', () => {
        const result = contract.createRuntimeResult({
            bookId: 'b', chapterId: 'c', sceneId: 's',
            status: 'failed', dispatchId: 'd', error: 'boom',
        });
        expect(Object.isFrozen(result)).to.equal(true);
        expect(Object.isFrozen(result.metadata)).to.equal(true);
    });
});

// ── T2 — Runtime does not import orchestration ──────────
describe('Phase 5 T2: runtime does not import orchestration through the seam', () => {
    const SEAM_FILES = [
        path.join(BACKEND_SRC, 'contracts', 'runtime-result.js'),
        path.join(RUNTIME_DIR, 'runtime-result-emitter.js'),
    ];

    it('seam modules require nothing from orchestration', () => {
        for (const file of SEAM_FILES) {
            const specs = requireSpecifiers(readSource(file))
                .filter(s => /^\.\.\/orchestration|^orchestration/.test(s));
            expect(specs, `${rel(file)} must not import orchestration`).to.deep.equal([]);
        }
    });

    it('contracts layer is a leaf (no relative requires at all)', () => {
        const specs = requireSpecifiers(
            readSource(path.join(BACKEND_SRC, 'contracts', 'runtime-result.js'))
        ).filter(s => s.startsWith('.'));
        expect(specs).to.deep.equal([]);
    });

    it('residual runtime→orchestration edges stay pinned (cannot grow)', () => {
        // Same baseline as dependency-guardrails.test.js R5 (post-Phase-5).
        // Duplicated here so the Phase 5 suite fails independently if a new
        // edge appears or the baseline is loosened elsewhere.
        const BASELINE = new Set([
            'backend/src/runtime/dispatch-engine.js:../orchestration/event-journal',
            'backend/src/runtime/reconciliation-engine.js:../orchestration/event-journal',
            'backend/src/runtime/scene-window.js:../orchestration/orchestrator',
            'backend/src/runtime/runtime-scheduler.js:../orchestration/orchestrator',
            'backend/src/runtime/dispatch-engine.js:../orchestration/orchestrator',
            'backend/src/runtime/dispatch-engine.js:../orchestration',
            'backend/src/runtime/reconciliation-engine.js:../orchestration/orchestrator',
        ]);
        const edges = new Set();
        for (const file of listSourceFiles(RUNTIME_DIR)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (/^\.\.\/orchestration/.test(spec)) {
                    edges.add(`${rel(file)}:${spec}`);
                }
            }
        }
        expect([...edges].sort()).to.deep.equal([...BASELINE].sort());
    });

    it('runtime-persistence no longer imports orchestration (dead edge removed)', () => {
        const src = readSource(path.join(RUNTIME_DIR, 'runtime-persistence.js'));
        expect(src).to.not.match(/require\(\s*['"]\.\.\/orchestration\/event-journal['"]/);
    });
});

// ── T3 — Orchestration consumes runtime result through the seam ──
describe('Phase 5 T3: orchestration consumes runtime result through the seam', () => {
    it('runtime emitter exposes the DI boundary (setConsumer / emitRuntimeResult)', () => {
        expect(emitter.setConsumer).to.be.a('function');
        expect(emitter.emitRuntimeResult).to.be.a('function');
        expect(emitter.resetConsumer).to.be.a('function');
    });

    it('orchestration ships a runtime result consumer adapter', () => {
        const { createRuntimeResultConsumer } = require('../../src/orchestration/runtime-result-consumer');
        expect(createRuntimeResultConsumer).to.be.a('function');
        const consumer = createRuntimeResultConsumer({ log: () => {} });
        expect(consumer).to.be.a('function');
    });

    it('the consumer adapter does not require orchestration or runtime modules', () => {
        const src = readSource(path.join(ORCH_DIR, 'runtime-result-consumer.js'));
        const relativeSpecs = requireSpecifiers(src).filter(s => s.startsWith('.'));
        expect(relativeSpecs, 'consumer must stay a leaf so the seam cannot create a cycle').to.deep.equal([]);
    });

    it('composition root wires emitter ← consumer', () => {
        const src = readSource(path.join(BACKEND_SRC, 'backend.cjs'));
        expect(src).to.include("require('./runtime/runtime-result-emitter')");
        expect(src).to.include("require('./orchestration/runtime-result-consumer')");
        expect(src).to.match(/setConsumer\s*\(\s*createRuntimeResultConsumer\s*\(/);
    });

    it('dispatch-engine emits runtime results at finalization', () => {
        const src = readSource(path.join(RUNTIME_DIR, 'dispatch-engine.js'));
        expect(src).to.include("require('./runtime-result-emitter')");
        expect(src).to.match(/emitRuntimeResult\(/);
    });
});

// ── T4/T5/T6 — Behavior through the seam ────────────────
describe('Phase 5 T4-T6: runtime results pass through the seam', () => {
    let consumerCalls;

    beforeEach(() => {
        consumerCalls = [];
        emitter.resetConsumer();
        emitter.setConsumer(async (result) => {
            consumerCalls.push(result);
        });
    });

    afterEach(() => {
        emitter.resetConsumer();
    });

    it('T4: completed result reaches the consumer', async () => {
        const { delivered } = await emitter.emitRuntimeResult({
            bookId: 'b', chapterId: 'c', sceneId: 's', stage: 'audio',
            outcome: 'success', dispatchId: 'd1', error: null,
        });
        expect(delivered).to.equal(true);
        expect(consumerCalls).to.have.lengthOf(1);
        expect(consumerCalls[0].status).to.equal('completed');
        expect(consumerCalls[0].dispatchId).to.equal('d1');
        expect(consumerCalls[0].stage).to.equal('audio');
        expect(consumerCalls[0].error).to.equal(null);
    });

    it('T5: failed result reaches the consumer with the error reason', async () => {
        const { delivered } = await emitter.emitRuntimeResult({
            bookId: 'b', chapterId: 'c', sceneId: 's', stage: 'image',
            outcome: 'failure', dispatchId: 'd2', error: 'worker_timeout',
        });
        expect(delivered).to.equal(true);
        expect(consumerCalls[0].status).to.equal('failed');
        expect(consumerCalls[0].error).to.equal('worker_timeout');
    });

    it('T6: cancelled result reaches the consumer', async () => {
        const { delivered } = await emitter.emitRuntimeResult({
            bookId: 'b', chapterId: 'c', sceneId: 's', stage: 'video',
            outcome: 'cancelled', dispatchId: 'd3', error: 'user_cancel',
        });
        expect(delivered).to.equal(true);
        expect(consumerCalls[0].status).to.equal('cancelled');
    });

    it('finalization semantics: consumer errors never propagate', async () => {
        emitter.resetConsumer();
        emitter.setConsumer(async () => { throw new Error('consumer blew up'); });
        const { delivered, reason } = await emitter.emitRuntimeResult({
            bookId: 'b', chapterId: 'c', sceneId: 's',
            outcome: 'failure', dispatchId: 'd4', error: 'x',
        });
        expect(delivered).to.equal(false);
        expect(reason).to.equal('consumer_error');
    });

    it('no consumer registered: emit is a safe no-op', async () => {
        emitter.resetConsumer();
        const { delivered, reason } = await emitter.emitRuntimeResult({
            bookId: 'b', chapterId: 'c', sceneId: 's',
            outcome: 'success', dispatchId: 'd5',
        });
        expect(delivered).to.equal(false);
        expect(reason).to.equal('no_consumer');
    });

    it('dispatch-engine outcome→status mapping covers all finalizeDispatch outcomes', () => {
        expect(contract.statusFromOutcome('success')).to.equal('completed');
        expect(contract.statusFromOutcome('failure')).to.equal('failed');
        expect(contract.statusFromOutcome('cancelled')).to.equal('cancelled');
        expect(contract.statusFromOutcome('bogus')).to.equal(null);
    });
});

// ── T7 — No protocol regression ─────────────────────────
describe('Phase 5 T7: no Job Protocol v2 regression', () => {
    it('Job Protocol v2 stays at version 2 with parseJobId/STAGE_BY_KIND intact', () => {
        const jobSchema = require('../../src/runtime/job-schema');
        expect(jobSchema.PROTOCOL_VERSION).to.equal(2);
        expect(jobSchema.parseJobId).to.be.a('function');
        expect(jobSchema.STAGE_BY_KIND).to.be.an('object');
    });

    it('parseJobId behavior is unchanged by the seam', () => {
        const jobSchema = require('../../src/runtime/job-schema');
        // Canonical job id: {book}_{chapter}_{scene}_{asset}:{type}
        const parsed = jobSchema.parseJobId('b1_c1_s1_0001:audio');
        expect(parsed).to.not.equal(null);
        expect(parsed.kind).to.equal('audio_chunk');
        expect(parsed.bookId).to.equal('b1');
        expect(parsed.chapterId).to.equal('c1');
        expect(parsed.sceneId).to.equal('s1');
        expect(parsed.chunkIndex).to.equal('0001');
    });

    it('the seam is notification-only: handleTaskResult path untouched', () => {
        const taskHandler = readSource(path.join(SERVICES_DIR, 'task-handler.cjs'));
        expect(taskHandler).to.not.include('runtime-result-emitter');
        expect(taskHandler).to.not.include('runtime-result');
        expect(taskHandler).to.include('handleTaskResult');
    });

    it('emitter does not sit on the artifact path (no gpu/task/result coupling)', () => {
        const emitterSrc = readSource(path.join(RUNTIME_DIR, 'runtime-result-emitter.js'));
        expect(emitterSrc).to.not.include('/gpu/task/result');
        expect(emitterSrc).to.not.include('result_base64');
    });
});

// ── T8 — No new architectural cycle ─────────────────────
describe('Phase 5 T8: the seam creates no new architectural cycle', () => {
    it('contracts layer imports nothing from orchestration/runtime/services', () => {
        for (const file of listSourceFiles(CONTRACTS_DIR)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                expect(
                    spec,
                    `${rel(file)} must not require ${spec} — contracts must stay a leaf`
                ).to.not.match(/^(\.\.\/)*(orchestration|runtime|services)(\/|$)/);
            }
        }
    });

    it('runtime result emitter imports only the contracts layer (inside runtime)', () => {
        const specs = requireSpecifiers(
            readSource(path.join(RUNTIME_DIR, 'runtime-result-emitter.js'))
        ).filter(s => s.startsWith('.'));
        expect(specs).to.deep.equal(['../contracts/runtime-result']);
    });

    it('orchestration consumer is a leaf (imports nothing relative)', () => {
        const specs = requireSpecifiers(
            readSource(path.join(ORCH_DIR, 'runtime-result-consumer.js'))
        ).filter(s => s.startsWith('.'));
        expect(specs).to.deep.equal([]);
    });

    it('no services module participates in the seam', () => {
        for (const file of listSourceFiles(SERVICES_DIR)) {
            const src = readSource(file);
            expect(src, `${rel(file)} must not be part of the result seam`).to.not.include('runtime-result-emitter');
            expect(src, `${rel(file)} must not be part of the result seam`).to.not.include('runtime-result-consumer');
        }
    });

    it('no global event bus was introduced for the seam', () => {
        // The seam is a plain injected callback: setConsumer, no EventEmitter,
        // no Redis pub/sub channel, no new global registry.
        for (const file of [
            path.join(BACKEND_SRC, 'contracts', 'runtime-result.js'),
            path.join(RUNTIME_DIR, 'runtime-result-emitter.js'),
            path.join(ORCH_DIR, 'runtime-result-consumer.js'),
        ]) {
            const src = readSource(file);
            expect(src, `${rel(file)} must not use EventEmitter`).to.not.include('EventEmitter');
            expect(src, `${rel(file)} must not use Redis pub/sub`).to.not.match(/publish|subscribe/i);
        }
    });
});

// ── T9–T11 — Final audit: full runtime/** boundary freeze ──
// Static scan helpers only catch quoted specifiers. These guards close the
// gaps for the Phase 5 close: computed/template requires, services-mediated
// edges, and the single-egress rule for the runtime-result contract.
describe('Phase 5 final audit: full runtime/** boundary', () => {
    // requireSpecifiers()/LITERAL_REQUIRE_RE only see plain quoted specifiers.
    // After stripping those, any surviving `require(` is computed, template or
    // string-concatenated — the forms a future edit could use to smuggle an
    // orchestration import past the pinned baseline above.
    const LITERAL_REQUIRE_RE = /require\s*\(\s*(['"])([^'"]+)\1\s*\)|from\s+(['"])([^'"]+)\3/g;

    it('T9: no dynamic/template/concat require or import() can reach orchestration from runtime/**', () => {
        const hosts = [];
        for (const file of listSourceFiles(RUNTIME_DIR)) {
            const residual = readSource(file).replace(LITERAL_REQUIRE_RE, '');
            if (/\brequire\s*\(/.test(residual) || /\bimport\s*\(/.test(residual)) {
                hosts.push(rel(file));
            }
        }
        expect(hosts, 'computed/template/concat require or import() is only allowed in runtime/index.js (lazyRequire)').to.deep.equal([
            'backend/src/runtime/index.js',
        ]);

        // The one allowed host may only lazy-load runtime-internal './' modules.
        const indexSrc = readSource(path.join(RUNTIME_DIR, 'index.js'));
        const nonInternal = requireSpecifiers(indexSrc).filter((s) => !s.startsWith('./'));
        expect(nonInternal, 'lazyRequire targets must stay runtime-internal (./...)').to.deep.equal([]);
        expect(indexSrc, 'lazyRequire must never reference orchestration').to.not.include('../orchestration');
    });

    it('T10: runtime→services imports open no orchestration endpoint beyond the pinned direct edges', () => {
        // For each runtime file, walk the services modules it imports
        // (transitively within services/**) and collect any orchestration
        // module they reach. That endpoint set must never exceed the direct
        // runtime→orchestration edges already pinned in T2 — today the only
        // bridge is services/placeholder-audio.js → orchestration/orchestrator,
        // imported by two files that already hold that exact direct edge.
        const orchEndpointOf = (svcFile) => requireSpecifiers(readSource(svcFile))
            .filter((s) => /^\.\.\/orchestration\//.test(s))
            .map((s) => s.replace(/^\.\.\//, '')); // 'orchestration/orchestrator'

        const indirect = [];
        for (const file of listSourceFiles(RUNTIME_DIR)) {
            const queue = [];
            for (const spec of requireSpecifiers(readSource(file))) {
                if (!/^\.\.\/services\//.test(spec)) continue;
                const target = resolveSpecifier(file, spec);
                if (target) queue.push(target);
            }
            const seen = new Set(queue);
            while (queue.length > 0) {
                const svcFile = queue.shift();
                for (const endpoint of orchEndpointOf(svcFile)) {
                    indirect.push(`${rel(file)} → ${endpoint}`);
                }
                for (const spec of requireSpecifiers(readSource(svcFile))) {
                    if (!spec.startsWith('./')) continue; // same-dir services hop
                    const target = resolveSpecifier(svcFile, spec);
                    if (target && !seen.has(target)) {
                        seen.add(target);
                        queue.push(target);
                    }
                }
            }
        }

        expect(indirect.sort(), 'services-mediated runtime→orchestration endpoints (must stay inside the pinned direct set)').to.deep.equal([
            'backend/src/runtime/reconciliation-engine.js → orchestration/orchestrator',
            'backend/src/runtime/scene-window.js → orchestration/orchestrator',
        ]);

        // Every indirect endpoint must already be a direct pinned edge of the
        // same runtime file — the services hop must never open a NEW endpoint.
        const direct = new Map(); // file → Set(orchestration endpoints)
        for (const file of listSourceFiles(RUNTIME_DIR)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (!/^\.\.\/orchestration\//.test(spec)) continue;
                const key = rel(file);
                if (!direct.has(key)) direct.set(key, new Set());
                direct.get(key).add(spec.replace(/^\.\.\//, ''));
            }
        }
        for (const entry of indirect) {
            const [file, endpoint] = entry.split(' → ');
            expect(direct.get(file), `${file} must reach ${endpoint} directly before using it via services`).to.include(endpoint);
        }
    });

    it('T11: runtime-result-emitter is the only module that can produce a runtime result', () => {
        // The contract is materialized in exactly one place in src/: the
        // emitter. No other runtime/orchestration/services module may require
        // contracts/runtime-result and hand a result to orchestration on its
        // own — the emitter is the single egress point for runtime results.
        const producers = [];
        for (const dir of [CONTRACTS_DIR, RUNTIME_DIR, ORCH_DIR, SERVICES_DIR]) {
            for (const file of listSourceFiles(dir)) {
                if (rel(file) === 'backend/src/contracts/runtime-result.js') continue;
                for (const spec of requireSpecifiers(readSource(file))) {
                    if (/contracts\/runtime-result$/.test(spec)) producers.push(rel(file));
                }
            }
        }
        expect(producers, 'only runtime/runtime-result-emitter.js may require the runtime-result contract').to.deep.equal([
            'backend/src/runtime/runtime-result-emitter.js',
        ]);
    });
});
