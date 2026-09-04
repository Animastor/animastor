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
