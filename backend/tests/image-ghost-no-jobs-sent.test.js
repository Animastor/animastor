// ======================================================
// Image ghost GENERATING (no_jobs_sent) — regression tests
// ======================================================
// Fix for docs/03-audit/image-ghost-generating/
//        image-ghost-generating-forensic-audit-2026-08-28.md
//
// Proven root cause:
//   dispatch #1 aborted → its animastor:iu-in-flight:* markers survive →
//   dispatch #2/#3 skip every IU → no_jobs_sent → finalizeDispatch(cancelled)
//   → rollback tried generating→pending (FORBIDDEN by FSM) → rejection was
//   swallowed → scene stuck in GENERATING forever → scheduler skips it each
//   tick (no_dispatchable_stages) → UI shows ghost "0/9".
//
// Fix under test:
//   1. FSM-valid rollback GENERATING → DIRTY → PENDING
//      (orchestrator.rollbackStageToPending), errors are NOT swallowed
//      (error log + TRANSITION_FAILED journal + stateRollbackFailures metric).
//   2. iu-in-flight marker ownership: marker value = dispatch_id, per-dispatch
//      index; finalizeDispatch(cancelled|failure) removes only markers whose
//      GPU job was NEVER sent (a sent job is unregistered from the index right
//      after gpu.send and its marker is untouched by cancellation).
//   3. Stale-marker self-heal: a marker whose owning dispatch is dead
//      (finalized/crashed/restarted) is cleared on the next dispatch instead
//      of blocking it forever.
//
// TEST A — full no_jobs_sent: rollback + cleanup + next dispatch sends
// TEST B — partial dispatch (3 sent / 6 not): cancellation keeps running-job
//          markers, redispatch is safe
// TEST C — dispatch #1 → no_jobs_sent → cancel → dispatch #2 really sends
// TEST D — force reset during an image dispatch
// TEST E — backend restart: survived markers/leases do not block forever

const { expect } = require('chai');
const state = require('../src/state');
const orchestrator = require('../src/orchestration/orchestrator');
const dispatchEngine = require('../src/runtime/dispatch-engine');
const gpu = require('../src/runtime/gpu-dispatcher');
const wfLoader = require('../src/workflows/workflow-loader');
const config = require('../src/config/runtime-config');
const iuProcessor = require('../src/image/iu-processor');
const imageModule = require('../src/image');
const callbacks = require('../src/orchestration/scene-callbacks');
const { createMockRedis } = require('./mocks/redis-mock');

const B = 'ghost_book', C = 'ch-1', S = 'sc-1', BUILD = 'build-ghost';
const IU_COUNT = 9;

function makeBook(unitCount = IU_COUNT) {
    const units = Array.from({ length: unitCount }, (_, i) => ({
        id: `iu-${i + 1}`,
        text: `Unit text ${i + 1}`,
    }));
    return {
        manifest: { book_id: B, build_id: BUILD },
        chapters: [{ chapter_id: C, scenes: [{ scene_id: S, units }] }],
    };
}

function markerKey(iuId) {
    return `animastor:iu-in-flight:${B}_${C}_${S}_${iuId}`;
}

async function allMarkers(redis) {
    let cursor = '0';
    const keys = [];
    do {
        const [next, batch] = await redis.scan(cursor, 'MATCH', 'animastor:iu-in-flight:*', 'COUNT', 200);
        cursor = next;
        keys.push(...batch);
    } while (cursor !== '0');
    return keys;
}

async function imageState(redis) {
    return (await state.getAssetStates(redis, B, C, S)).image;
}

async function journalEvents(redis) {
    return (await redis.lrange(`animastor:event-journal:${B}:${C}:${S}`, 0, -1)).map(JSON.parse);
}

// gpu.send stub factory: behavior is a label ('sent'|'failed'|'throw'),
// an array of labels (one per call), or fn(call, jobId) → label
function stubGpuSend(behavior) {
    let call = 0;
    gpu.send = async (jobId, wf, type, buildId, dispatchId) => {
        call++;
        let action;
        if (typeof behavior === 'function') action = behavior(call, jobId);
        else if (Array.isArray(behavior)) action = behavior[Math.min(call - 1, behavior.length - 1)];
        else action = behavior;
        if (action === 'throw') throw new Error('hub_unreachable');
        if (action === 'sent') return { sent: true, jobId, dispatchId };
        return { sent: false, error: 'enqueue_failed' };
    };
}

describe('image ghost GENERATING — no_jobs_sent lifecycle fix (audit 6929ba5)', function () {
    this.timeout(20000);

    let redis;
    const originalSend = gpu.send;

    before(() => {
        wfLoader.loadWorkflows();
    });

    beforeEach(() => {
        redis = createMockRedis();
    });

    afterEach(() => {
        gpu.send = originalSend;
        // Lease renewal timers are module-level — always stop them so mocha exits
        dispatchEngine.stopDispatchRenewal(B, C, S, 'image');
    });

    // ────────────────────────────────────────────────────────────
    // TEST A — full no_jobs_sent
    // ────────────────────────────────────────────────────────────
    describe('TEST A: full no_jobs_sent (0 of 9 actually sent)', () => {

        it('cancelled no_jobs_sent rolls back GENERATING via dirty→pending and leaves no markers', async () => {
            await state.setAssetState(redis, B, C, S, 'image', state.AssetState.PENDING);
            stubGpuSend('failed'); // all 9 gpu.send → sent:false, no real GPU job

            const res = await dispatchEngine.dispatchStage(redis, B, C, S, 'image', makeBook(), BUILD, {});

            expect(res.dispatched).to.equal(false);
            expect(res.result.reason).to.equal('no_jobs_sent');

            // Scene must NOT stay GENERATING — FSM-valid path back to dispatchable
            expect(await imageState(redis)).to.equal(state.AssetState.PENDING);

            // All stale markers cleaned, nothing orphaned
            expect(await allMarkers(redis)).to.have.length(0);

            // Lease/metadata/quota released by finalizeDispatch(cancelled)
            const lease = await redis.get(`animastor:dispatch-lease:${B}:${C}:${S}:image`);
            expect(lease).to.equal(null);
            expect(await dispatchEngine.getDispatchMetadata(redis, B, C, S, 'image')).to.equal(null);
            expect(await dispatchEngine.getActiveCounter(redis, 'image')).to.equal(0);

            // Cancellation is visible in the journal (not a silent success)
            const events = await journalEvents(redis);
            const cancelled = events.find(e => e.type === 'DISPATCH_CANCELLED');
            expect(cancelled).to.exist;
            expect(cancelled.details.reason).to.equal('no_jobs_sent');
            // Rollback path is journaled as SCENE_PENDING with rollback:true
            const rollbackEvent = events.find(e => e.type === 'SCENE_PENDING' && e.details && e.details.rollback === true);
            expect(rollbackEvent).to.exist;
            expect(rollbackEvent.details.via).to.equal('dirty->pending');
        });

        it('next dispatch after no_jobs_sent really sends all 9 IU jobs', async () => {
            await state.setAssetState(redis, B, C, S, 'image', state.AssetState.PENDING);
            stubGpuSend('failed');
            await dispatchEngine.dispatchStage(redis, B, C, S, 'image', makeBook(), BUILD, {});
            expect(await imageState(redis)).to.equal(state.AssetState.PENDING);

            const sentJobs = [];
            gpu.send = async (jobId) => { sentJobs.push(jobId); return { sent: true, jobId }; };
            const res2 = await dispatchEngine.dispatchStage(redis, B, C, S, 'image', makeBook(), BUILD, {});

            expect(res2.dispatched).to.equal(true);
            expect(res2.result.jobs).to.equal(IU_COUNT);
            expect(sentJobs).to.have.length(IU_COUNT);
            expect(await imageState(redis)).to.equal(state.AssetState.GENERATING);
        });

        it('audit leftovers: 9 stale markers of a dead dispatch do not block the next dispatch', async () => {
            // Ghost state exactly as found in production: markers from an
            // aborted dispatch #1, no job/lease/worker behind them.
            const deadDispatch = 'dispatch-dead-0000000000000000';
            for (let i = 1; i <= IU_COUNT; i++) {
                await redis.set(markerKey(`iu-${i}`), deadDispatch, 'EX', 1200);
            }
            await state.setAssetState(redis, B, C, S, 'image', state.AssetState.PENDING);

            const sentJobs = [];
            gpu.send = async (jobId) => { sentJobs.push(jobId); return { sent: true, jobId }; };
            const res = await dispatchEngine.dispatchStage(redis, B, C, S, 'image', makeBook(), BUILD, {});

            // Stale markers self-healed (owner dead) → all IU sent, no no_jobs_sent
            expect(res.dispatched).to.equal(true);
            expect(res.result.jobs).to.equal(IU_COUNT);
            expect(sentJobs).to.have.length(IU_COUNT);

            // No dead-owner markers left; all 9 re-owned by the live dispatch
            const markers = await allMarkers(redis);
            expect(markers).to.have.length(IU_COUNT);
            for (const key of markers) {
                expect(await redis.get(key)).to.equal(res.dispatchId);
            }
        });

        it('dispatch failure (gpu.send throws before any job) aborts with cleanup, no ghost', async () => {
            // "backend-side abort до отправки GPU job" + "dispatch failure":
            // marker was set, gpu.send threw → marker never unregistered →
            // finalizeDispatch(cancelled) must clean it via the dispatch index.
            await state.setAssetState(redis, B, C, S, 'image', state.AssetState.PENDING);
            stubGpuSend('throw');

            const res = await dispatchEngine.dispatchStage(redis, B, C, S, 'image', makeBook(), BUILD, {});

            expect(res.dispatched).to.equal(false);
            // executor catches the send error itself → generation_error reason,
            // but the abort semantics are the same: cancelled + rollback + cleanup
            expect(res.result.reason).to.equal('generation_error');
            expect(await imageState(redis)).to.equal(state.AssetState.PENDING);
            expect(await allMarkers(redis)).to.have.length(0);
            expect(await redis.get(`animastor:dispatch-lease:${B}:${C}:${S}:image`)).to.equal(null);
            const events = await journalEvents(redis);
            const cancelled = events.find(e => e.type === 'DISPATCH_CANCELLED');
            expect(cancelled).to.exist;
            expect(cancelled.details.reason).to.equal('generation_error');
        });

        it('executor exception past the executor (dispatch-engine catch) also rolls back state', async () => {
            // dispatch-engine catch path: orchestrator.dispatchStage throws after
            // the stage was set GENERATING → rollback + finalize(cancelled).
            const orchestration = require('../src/orchestration');
            const originalExec = orchestration.dispatchStage;
            orchestration.dispatchStage = async () => { throw new Error('executor exploded'); };
            try {
                await state.setAssetState(redis, B, C, S, 'image', state.AssetState.GENERATING);
                const res = await dispatchEngine.dispatchStage(redis, B, C, S, 'image', makeBook(), BUILD, {});
                expect(res.dispatched).to.equal(false);
                expect(res.reason).to.equal('dispatch_error');
                // No ghost GENERATING
                expect(await imageState(redis)).to.equal(state.AssetState.PENDING);
                expect(await redis.get(`animastor:dispatch-lease:${B}:${C}:${S}:image`)).to.equal(null);
                expect(await dispatchEngine.getDispatchMetadata(redis, B, C, S, 'image')).to.equal(null);
            } finally {
                orchestration.dispatchStage = originalExec;
            }
        });
    });

    // ────────────────────────────────────────────────────────────
    // TEST B — partial dispatch: 3 really sent, 6 not sent
    // ────────────────────────────────────────────────────────────
    describe('TEST B: partial dispatch (3 sent / 6 not sent) then cancellation', () => {
        let dispatchId1;

        beforeEach(async () => {
            await state.setAssetState(redis, B, C, S, 'image', state.AssetState.PENDING);
            // First 3 gpu.send succeed, remaining 6 fail
            stubGpuSend(call => (call <= 3 ? 'sent' : 'failed'));
            const res = await dispatchEngine.dispatchStage(redis, B, C, S, 'image', makeBook(), BUILD, {});
            expect(res.dispatched).to.equal(true);
            expect(res.result.jobs).to.equal(3);
            dispatchId1 = res.dispatchId;
        });

        it('running-job markers survive; unsent IUs left no orphan markers', async () => {
            const markers = await allMarkers(redis);
            expect(markers).to.have.length(3);
            for (let i = 1; i <= 3; i++) {
                expect(markers).to.include(markerKey(`iu-${i}`));
                // Marker value carries the owning dispatch
                expect(await redis.get(markerKey(`iu-${i}`))).to.equal(dispatchId1);
            }
            // Sent jobs are NOT in the dispatch abort-scope index anymore
            const index = await redis.smembers(dispatchEngine.getInFlightIndexKey(dispatchId1));
            expect(index).to.have.length(0);
        });

        it('cancellation does NOT break markers/ownership of the 3 running jobs', async () => {
            const cancel = await dispatchEngine.cancelActiveDispatch(redis, B, C, S, 'image', 'partial_failure_cancel');
            expect(cancel.cancelled).to.equal(true);

            // The 3 really-running jobs keep their markers (cleanup is
            // ownership-scoped: only never-sent markers may be removed)
            const markers = await allMarkers(redis);
            expect(markers).to.have.length(3);
            for (let i = 1; i <= 3; i++) {
                expect(await redis.get(markerKey(`iu-${i}`))).to.equal(dispatchId1);
            }
            // Lease/metadata/quota released
            expect(await redis.get(`animastor:dispatch-lease:${B}:${C}:${S}:image`)).to.equal(null);
            expect(await dispatchEngine.getDispatchMetadata(redis, B, C, S, 'image')).to.equal(null);
            expect(await dispatchEngine.getActiveCounter(redis, 'image')).to.equal(0);
        });

        it('redispatch sends all 9 (no false no_jobs_sent), stale markers re-owned', async () => {
            await dispatchEngine.cancelActiveDispatch(redis, B, C, S, 'image', 'partial_failure_cancel');

            const sentJobs = [];
            gpu.send = async (jobId) => { sentJobs.push(jobId); return { sent: true, jobId }; };
            // Force mode: the way resetScenes/regen re-enters dispatch after cancel
            const res = await dispatchEngine.dispatchStage(redis, B, C, S, 'image', makeBook(), BUILD, { force: true });

            expect(res.dispatched).to.equal(true);
            expect(res.result.reason).to.not.equal('no_jobs_sent');
            // 6 never-sent IUs + 3 whose dead dispatch can no longer receive results
            expect(res.result.jobs).to.equal(IU_COUNT);
            expect(sentJobs).to.have.length(IU_COUNT);

            const markers = await allMarkers(redis);
            expect(markers).to.have.length(IU_COUNT);
            for (const key of markers) {
                expect(await redis.get(key)).to.equal(res.dispatchId);
            }
        });
    });

    // ────────────────────────────────────────────────────────────
    // TEST C — re-dispatch after no_jobs_sent is safe (idempotency)
    // ────────────────────────────────────────────────────────────
    describe('TEST C: dispatch #1 → no_jobs_sent → cancel → dispatch #2 sends', () => {

        it('dispatch #2 really sends jobs after #1 was cancelled with no_jobs_sent', async () => {
            await state.setAssetState(redis, B, C, S, 'image', state.AssetState.PENDING);

            // dispatch #1: all sends fail → no_jobs_sent → cancelled
            stubGpuSend('failed');
            const res1 = await dispatchEngine.dispatchStage(redis, B, C, S, 'image', makeBook(), BUILD, {});
            expect(res1.dispatched).to.equal(false);
            expect(res1.result.reason).to.equal('no_jobs_sent');
            expect(await imageState(redis)).to.equal(state.AssetState.PENDING);
            expect(await allMarkers(redis)).to.have.length(0);

            // dispatch #2: must NOT see phantom in-flight IUs
            const sentJobs = [];
            gpu.send = async (jobId) => { sentJobs.push(jobId); return { sent: true, jobId }; };
            const res2 = await dispatchEngine.dispatchStage(redis, B, C, S, 'image', makeBook(), BUILD, {});

            expect(res2.dispatched).to.equal(true);
            expect(res2.result.jobs).to.equal(IU_COUNT);
            expect(sentJobs).to.have.length(IU_COUNT);
            expect(res2.dispatchId).to.not.equal(res1.dispatchId);
        });

        it('marker of #1 cannot survive its cancellation (index cleanup is ownership-scoped)', async () => {
            await state.setAssetState(redis, B, C, S, 'image', state.AssetState.PENDING);

            // Simulate the pre-fix leak directly: marker set, gpu.send throws
            // before the job exists, dispatch aborted mid-loop.
            stubGpuSend(call => (call === 1 ? 'throw' : 'sent'));
            const res1 = await dispatchEngine.dispatchStage(redis, B, C, S, 'image', makeBook(), BUILD, {});
            expect(res1.dispatched).to.equal(false);

            // No marker of the dead dispatch may remain
            const markers = await allMarkers(redis);
            expect(markers).to.have.length(0);
            expect(await redis.get(dispatchEngine.getInFlightIndexKey(res1.dispatchId))).to.equal(null);

            // #2 sends everything
            const sentJobs = [];
            gpu.send = async (jobId) => { sentJobs.push(jobId); return { sent: true, jobId }; };
            const res2 = await dispatchEngine.dispatchStage(redis, B, C, S, 'image', makeBook(), BUILD, {});
            expect(res2.dispatched).to.equal(true);
            expect(sentJobs).to.have.length(IU_COUNT);
        });
    });

    // ────────────────────────────────────────────────────────────
    // TEST D — force reset during an image dispatch
    // ────────────────────────────────────────────────────────────
    describe('TEST D: force reset during image dispatch', () => {
        let dispatchId1;

        it('mid-flight force_reset cleans unsent markers, keeps running-job markers', async () => {
            await state.setAssetState(redis, B, C, S, 'image', state.AssetState.PENDING);

            // IU 1-2 really sent; IU 3's send triggers a concurrent force_reset
            // cancellation; IU 4-9 fail to send.
            let call = 0;
            gpu.send = async (jobId) => {
                call++;
                if (call <= 2) return { sent: true, jobId };
                if (call === 3) {
                    await dispatchEngine.cancelActiveDispatch(redis, B, C, S, 'image', 'force_reset');
                    return { sent: false, error: 'force_reset' };
                }
                return { sent: false, error: 'hub_down' };
            };

            const res = await dispatchEngine.dispatchStage(redis, B, C, S, 'image', makeBook(), BUILD, {});
            dispatchId1 = res.dispatchId;

            // Executor finished the loop with the 2 really-sent jobs
            expect(res.dispatched).to.equal(true);
            expect(res.result.jobs).to.equal(2);

            // force_reset finalization cleaned the IU-3 marker (never sent),
            // while IU 1-2 (really running) keep their markers/ownership.
            expect(await redis.get(markerKey('iu-1'))).to.equal(dispatchId1);
            expect(await redis.get(markerKey('iu-2'))).to.equal(dispatchId1);
            expect(await redis.get(markerKey('iu-3'))).to.equal(null);
            for (let i = 4; i <= IU_COUNT; i++) {
                expect(await redis.get(markerKey(`iu-${i}`))).to.equal(null);
            }
            expect(await allMarkers(redis)).to.have.length(2);

            // Cancelled dispatch left no lease/metadata/quota behind
            expect(await redis.get(`animastor:dispatch-lease:${B}:${C}:${S}:image`)).to.equal(null);
            expect(await dispatchEngine.getDispatchMetadata(redis, B, C, S, 'image')).to.equal(null);
            expect(await dispatchEngine.getActiveCounter(redis, 'image')).to.equal(0);
        });

        it('after force reset the scene reaches a dispatchable state (no ghost GENERATING)', async () => {
            await state.setAssetState(redis, B, C, S, 'image', state.AssetState.PENDING);
            let call = 0;
            gpu.send = async (jobId) => {
                call++;
                if (call <= 2) return { sent: true, jobId };
                if (call === 3) {
                    await dispatchEngine.cancelActiveDispatch(redis, B, C, S, 'image', 'force_reset');
                    return { sent: false, error: 'force_reset' };
                }
                return { sent: false, error: 'hub_down' };
            };
            const res1 = await dispatchEngine.dispatchStage(redis, B, C, S, 'image', makeBook(), BUILD, {});
            dispatchId1 = res1.dispatchId;
            // Mid-flight cancel: executor still returned dispatched:true, so the
            // stage is GENERATING while its dispatch is dead. resetScenes owns the
            // state transition in the real flow — exercise the same facade path.
            expect(await imageState(redis)).to.equal(state.AssetState.GENERATING);

            const rollback = await orchestrator.rollbackStageToPending(
                redis, B, C, S, 'image', BUILD, 'force_reset'
            );
            expect(rollback.changed).to.equal(true);
            expect(rollback.path).to.deep.equal([state.AssetState.DIRTY, state.AssetState.PENDING]);
            expect(await imageState(redis)).to.equal(state.AssetState.PENDING);

            // Re-dispatch: no ghost, no orphan markers, all 9 IU sent
            const sentJobs = [];
            gpu.send = async (jobId) => { sentJobs.push(jobId); return { sent: true, jobId }; };
            const res2 = await dispatchEngine.dispatchStage(redis, B, C, S, 'image', makeBook(), BUILD, {});
            expect(res2.dispatched).to.equal(true);
            expect(res2.result.jobs).to.equal(IU_COUNT);
            expect(sentJobs).to.have.length(IU_COUNT);

            // GENERATING now belongs to a LIVE dispatch (lease + metadata present)
            expect(await imageState(redis)).to.equal(state.AssetState.GENERATING);
            expect(await redis.get(`animastor:dispatch-lease:${B}:${C}:${S}:image`)).to.not.equal(null);
            const meta = await dispatchEngine.getDispatchMetadata(redis, B, C, S, 'image');
            expect(meta.dispatch_id).to.equal(res2.dispatchId);
            const markers = await allMarkers(redis);
            expect(markers).to.have.length(IU_COUNT);
            for (const key of markers) {
                expect(await redis.get(key)).to.equal(res2.dispatchId);
            }
        });
    });

    // ────────────────────────────────────────────────────────────
    // TEST E — backend restart: survived Redis state must not block forever
    // ────────────────────────────────────────────────────────────
    describe('TEST E: backend restart — TTL-survived markers do not block a new dispatch', () => {

        it('markers of a crashed dispatch (no metadata after restart) are self-healed', async () => {
            // Crash leftovers: markers still alive via Redis TTL, but their
            // dispatch metadata/lease are gone (process died, nothing finalized).
            const crashed = 'dispatch-crashed-1111111111111111';
            for (let i = 1; i <= IU_COUNT; i++) {
                await redis.set(markerKey(`iu-${i}`), crashed, 'EX', 1200);
            }
            await state.setAssetState(redis, B, C, S, 'image', state.AssetState.GENERATING);

            const sentJobs = [];
            gpu.send = async (jobId) => { sentJobs.push(jobId); return { sent: true, jobId }; };
            const res = await dispatchEngine.dispatchStage(redis, B, C, S, 'image', makeBook(), BUILD, {});

            expect(res.dispatched).to.equal(true);
            expect(res.result.jobs).to.equal(IU_COUNT);
            expect(sentJobs).to.have.length(IU_COUNT);

            const markers = await allMarkers(redis);
            expect(markers).to.have.length(IU_COUNT);
            for (const key of markers) {
                expect(await redis.get(key)).to.not.equal(crashed);
            }
            // Stale self-heal is observable via metric
            const metric = await redis.get('animastor:runtime:metrics:current:iuInFlightStaleCleared');
            expect(parseInt(metric, 10)).to.be.at.least(IU_COUNT);
        });

        it('legacy marker value ("1", pre-fix format) is treated as stale and cleared', async () => {
            await redis.set(markerKey('iu-1'), '1', 'EX', 1200);
            await state.setAssetState(redis, B, C, S, 'image', state.AssetState.PENDING);

            const sentJobs = [];
            gpu.send = async (jobId) => { sentJobs.push(jobId); return { sent: true, jobId }; };
            const res = await dispatchEngine.dispatchStage(redis, B, C, S, 'image', makeBook(), BUILD, {});

            expect(res.dispatched).to.equal(true);
            expect(res.result.jobs).to.equal(IU_COUNT);
            expect(await redis.get(markerKey('iu-1'))).to.equal(res.dispatchId);
        });

        it('restart with decayed lease+metadata: stale_lease_recovery cleans the index and redispatches', async () => {
            // Restart where lease & metadata survived but renewals stopped:
            // TTL decayed below the stale threshold.
            const crashed = 'dispatch-crashed-2222222222222222';
            const leaseKey = `animastor:dispatch-lease:${B}:${C}:${S}:image`;
            await redis.set(leaseKey, crashed, 'EX', 100); // stale: 100 < target(1380)-grace(600)
            const meta = dispatchEngine.createDispatchMetadata(crashed, 'image', 'test', {
                leaseKey,
                leaseToken: crashed,
                quotaOwned: true,
            });
            await redis.set(dispatchEngine.getDispatchMetaKey(B, C, S, 'image'), JSON.stringify(meta), 'EX', 100);

            // Crash left 4 unsent markers registered in the dead dispatch index
            // and 1 marker of a job that was really sent (NOT in the index).
            for (let i = 1; i <= 5; i++) {
                await redis.set(markerKey(`iu-${i}`), crashed, 'EX', 1200);
            }
            const indexKey = dispatchEngine.getInFlightIndexKey(crashed);
            for (let i = 2; i <= 5; i++) {
                await redis.sadd(indexKey, markerKey(`iu-${i}`));
            }
            await redis.expire(indexKey, 1200);
            await state.setAssetState(redis, B, C, S, 'image', state.AssetState.GENERATING);

            const sentJobs = [];
            gpu.send = async (jobId) => { sentJobs.push(jobId); return { sent: true, jobId }; };
            const res = await dispatchEngine.dispatchStage(redis, B, C, S, 'image', makeBook(), BUILD, {});

            // stale_lease_recovery cancelled the dead dispatch (index cleaned),
            // then the new dispatch self-healed the remaining sent-job marker.
            expect(res.dispatched).to.equal(true);
            expect(res.result.jobs).to.equal(IU_COUNT);
            expect(sentJobs).to.have.length(IU_COUNT);

            // Unsent markers of the dead dispatch are gone; new ones re-owned
            const markers = await allMarkers(redis);
            expect(markers).to.have.length(IU_COUNT);
            for (const key of markers) {
                expect(await redis.get(key)).to.equal(res.dispatchId);
            }
            expect(await redis.get(indexKey)).to.equal(null);
        });
    });

    // ────────────────────────────────────────────────────────────
    // Rollback facade unit coverage (FSM paths + non-swallowed errors)
    // ────────────────────────────────────────────────────────────
    describe('rollbackStageToPending facade', () => {

        it('GENERATING → DIRTY → PENDING (both edges FSM-valid)', async () => {
            await state.setAssetState(redis, B, C, S, 'image', state.AssetState.GENERATING);
            const rb = await orchestrator.rollbackStageToPending(redis, B, C, S, 'image', BUILD, 'no_jobs_sent');
            expect(rb.changed).to.equal(true);
            expect(rb.path).to.deep.equal([state.AssetState.DIRTY, state.AssetState.PENDING]);
            expect(await imageState(redis)).to.equal(state.AssetState.PENDING);
        });

        it('NEW/DIRTY/FAILED roll back to PENDING directly', async () => {
            for (const from of [state.AssetState.NEW, state.AssetState.DIRTY, state.AssetState.FAILED]) {
                await state.setAssetState(redis, B, C, S, 'image', from);
                const rb = await orchestrator.rollbackStageToPending(redis, B, C, S, 'image', BUILD, 'test');
                expect(rb.changed, `from ${from}`).to.equal(true);
                expect(await imageState(redis)).to.equal(state.AssetState.PENDING);
            }
        });

        it('READY is never rolled back', async () => {
            await state.setAssetState(redis, B, C, S, 'image', state.AssetState.READY);
            const rb = await orchestrator.rollbackStageToPending(redis, B, C, S, 'image', BUILD, 'test');
            expect(rb.changed).to.equal(false);
            expect(rb.reason).to.equal('already_ready');
            expect(await imageState(redis)).to.equal(state.AssetState.READY);
        });

        it('PENDING is a no-op', async () => {
            await state.setAssetState(redis, B, C, S, 'image', state.AssetState.PENDING);
            const rb = await orchestrator.rollbackStageToPending(redis, B, C, S, 'image', BUILD, 'test');
            expect(rb.changed).to.equal(false);
            expect(rb.alreadyPending).to.equal(true);
        });

        it('rollback failure is NOT swallowed: journal event + metric counter', async () => {
            await state.setAssetState(redis, B, C, S, 'image', state.AssetState.GENERATING);
            const originalUnsafe = state.unsafeRestoreAssetState;
            state.unsafeRestoreAssetState = async () => { throw new Error('redis down'); };
            let rb;
            try {
                rb = await orchestrator.rollbackStageToPending(redis, B, C, S, 'image', BUILD, 'no_jobs_sent');
            } finally {
                state.unsafeRestoreAssetState = originalUnsafe;
            }

            expect(rb.changed).to.equal(false);
            expect(rb.reason).to.match(/^rollback_failed:/);
            // Diagnostic state: metric incremented, TRANSITION_FAILED journaled
            const metric = await redis.get('animastor:runtime:metrics:current:stateRollbackFailures');
            expect(parseInt(metric, 10)).to.equal(1);
            const events = await journalEvents(redis);
            expect(events.find(e => e.type === 'TRANSITION_FAILED')).to.exist;
            // Scene stays GENERATING — but now visibly (logged + journaled + metric),
            // not silently
            expect(await imageState(redis)).to.equal(state.AssetState.GENERATING);
        });
    });
});

// ======================================================
// iu-in-flight marker lifecycle after SUCCESSFUL gpu.send
// (follow-up verification of fix 226178f0)
// ======================================================
// Lifecycle under test:
//   set marker (owner=dispatch_id) → gpu.send SUCCESS → job really runs →
//   completion clears the marker (scene callback, NOT TTL).
// Emergency path:
//   set marker → gpu.send SUCCESS → backend crash BEFORE completion →
//   old dispatch dead → new dispatch → stale marker detected →
//   atomic compare-and-delete removes ONLY the old owner's marker →
//   IU is dispatched again.
describe('iu-in-flight marker lifecycle after successful gpu.send (follow-up 226178f0)', function () {
    this.timeout(20000);

    let redis;
    const originalSend = gpu.send;

    before(() => {
        wfLoader.loadWorkflows();
    });

    beforeEach(() => {
        redis = createMockRedis();
    });

    afterEach(() => {
        gpu.send = originalSend;
        dispatchEngine.stopDispatchRenewal(B, C, S, 'image');
    });

    // Test helper: create a full active dispatch (quota+lease+metadata)
    async function createActiveDispatch(dispatchId) {
        await dispatchEngine.acquireQuota(redis, 'image');
        const lease = await dispatchEngine.acquireStageLease(redis, B, C, S, 'image');
        await dispatchEngine.setDispatchMetadata(
            redis, B, C, S, 'image',
            dispatchEngine.createDispatchMetadata(dispatchId, 'image', 'test', {
                leaseKey: lease.leaseKey,
                leaseToken: lease.token,
                quotaOwned: true,
            })
        );
        return lease;
    }

    const unit1 = { id: 'iu-1', text: 'Unit text 1' };
    const sceneData1 = { payload: { units: [unit1] }, chapter: {} };

    async function sendSingleIU(dispatchId, sendResult = { sent: true }) {
        let sends = 0;
        gpu.send = async (jobId) => { sends++; return { ...sendResult, jobId }; };
        const result = await iuProcessor.processSingleIU(
            redis, unit1, 0, sceneData1, makeBook(1), BUILD,
            B, C, S, 0, 'full text', new Set(), dispatchId
        );
        return { result, getSends: () => sends };
    }

    // ────────────────────────────────────────────────────────────
    // 1. Normal completion clears the marker (lifecycle, not TTL)
    // ────────────────────────────────────────────────────────────
    describe('normal completion', () => {

        it('marker → gpu.send SUCCESS → completion clears the marker before TTL', async () => {
            const dispatchId = 'dispatch-complete';
            await createActiveDispatch(dispatchId);
            await state.setAssetState(redis, B, C, S, 'image', state.AssetState.GENERATING);

            const { result } = await sendSingleIU(dispatchId);
            expect(result.sent).to.equal(true);
            // Marker lives while the job runs (owner = dispatch)
            expect(await redis.get(markerKey('iu-1'))).to.equal(dispatchId);

            // Scene-level completion (all IUs done → completeStage → handleImageCompleted)
            const origResolve = imageModule.resolveCanonicalSceneImage;
            const origMeta = imageModule.getImageMetadata;
            imageModule.resolveCanonicalSceneImage = () => '/tmp/ghost-scene.png';
            imageModule.getImageMetadata = async () => ({ width: 640, height: 480 });
            let cb;
            try {
                cb = await callbacks.handleImageCompleted(redis, B, C, S, BUILD);
            } finally {
                imageModule.resolveCanonicalSceneImage = origResolve;
                imageModule.getImageMetadata = origMeta;
            }

            expect(cb.ok).to.equal(true);
            // Marker removed by the completion lifecycle — not left to TTL
            expect(await allMarkers(redis)).to.have.length(0);
        });
    });

    // ────────────────────────────────────────────────────────────
    // 2. Critical crash/restart race
    // ────────────────────────────────────────────────────────────
    describe('crash/restart race (send SUCCESS → crash before completion)', () => {

        it('dead dispatch marker is detected stale and removed by atomic CAS; IU re-dispatched', async () => {
            // 1. Image dispatch A created
            const dispatchIdA = 'dispatch-A-crash';
            await createActiveDispatch(dispatchIdA);
            await state.setAssetState(redis, B, C, S, 'image', state.AssetState.GENERATING);

            // 2-3. Marker created with owner dispatch_id, gpu.send returns SUCCESS
            let sends = 0;
            gpu.send = async (jobId) => { sends++; return { sent: true, jobId }; };
            const r1 = await iuProcessor.processSingleIU(
                redis, unit1, 0, sceneData1, makeBook(1), BUILD,
                B, C, S, 0, 'full text', new Set(), dispatchIdA
            );
            expect(r1.sent).to.equal(true);
            expect(sends).to.equal(1);
            expect(await redis.get(markerKey('iu-1'))).to.equal(dispatchIdA);
            // Sent job is NOT in the dispatch abort-scope index anymore
            expect(await redis.smembers(dispatchEngine.getInFlightIndexKey(dispatchIdA))).to.have.length(0);

            // 4. Backend crash BEFORE completion callback: no finalizeDispatch —
            //    lease/metadata vanish with the process, marker survives via TTL
            await redis.del(`animastor:dispatch-lease:${B}:${C}:${S}:image`);
            await redis.del(dispatchEngine.getDispatchMetaKey(B, C, S, 'image'));
            expect(await redis.get(markerKey('iu-1'))).to.equal(dispatchIdA);

            // 5-6. Restart: new dispatch B for the same scene/IU
            const dispatchIdB = 'dispatch-B-after-restart';
            await createActiveDispatch(dispatchIdB);

            // 7-9. checkInFlightMarker: owner A is dead (metadata belongs to B)
            //      → stale → atomic compare-and-delete removes ONLY A's marker
            const flight = await iuProcessor.checkInFlightMarker(
                redis, markerKey('iu-1'), B, C, S, dispatchIdB
            );
            expect(flight.inFlight).to.equal(false);
            expect(flight.staleCleared).to.equal(true);
            expect(await redis.get(markerKey('iu-1'))).to.equal(null);

            // 10. IU is really dispatched again, marker re-owned by B
            const r2 = await iuProcessor.processSingleIU(
                redis, unit1, 0, sceneData1, makeBook(1), BUILD,
                B, C, S, 0, 'full text', new Set(), dispatchIdB
            );
            expect(r2.sent).to.equal(true);
            expect(sends).to.equal(2);
            expect(await redis.get(markerKey('iu-1'))).to.equal(dispatchIdB);
        });

        it('while the owner dispatch is ALIVE, its marker blocks duplicate send', async () => {
            // The flip side of stale self-heal: a live owner (metadata == marker
            // owner) means the job may really be running → no duplicate dispatch.
            const dispatchIdA = 'dispatch-A-alive';
            await createActiveDispatch(dispatchIdA);

            const { result: r1, getSends } = await sendSingleIU(dispatchIdA);
            expect(r1.sent).to.equal(true);
            expect(getSends()).to.equal(1);

            // A second attempt for the same IU while A is active → skipped, no send
            const r2 = await iuProcessor.processSingleIU(
                redis, unit1, 0, sceneData1, makeBook(1), BUILD,
                B, C, S, 0, 'full text', new Set(), 'dispatch-B-concurrent'
            );
            expect(r2.skipped).to.equal(true);
            expect(getSends()).to.equal(1); // gpu.send NOT called again
            expect(await redis.get(markerKey('iu-1'))).to.equal(dispatchIdA);
        });
    });

    // ────────────────────────────────────────────────────────────
    // 3. Ownership race: late cleanup of A must not delete B's marker
    // ────────────────────────────────────────────────────────────
    describe('ownership race (dispatch A cleanup runs after dispatch B re-owns the marker)', () => {

        it('compare-and-delete checks owner: A cleanup never deletes B marker', async () => {
            const A = 'dispatch-A-late';
            const Bf = 'dispatch-B-fast';

            // A registered the marker (pre-send) and died; B already re-owned it
            await redis.set(markerKey('iu-1'), A, 'EX', 1200);
            await dispatchEngine.registerInFlightMarker(redis, A, markerKey('iu-1'));
            await redis.set(markerKey('iu-1'), Bf, 'EX', 1200);

            // A's cleanup runs LATE
            const cleanup = await dispatchEngine.releaseDispatchInFlightMarkers(redis, A);
            expect(cleanup.removed).to.equal(0);
            expect(cleanup.kept).to.equal(1);
            expect(cleanup.errors).to.have.length(0);
            // B's marker intact
            expect(await redis.get(markerKey('iu-1'))).to.equal(Bf);
        });

        it('compareAndDeleteMarker is owner-exact (atomic CAS semantics)', async () => {
            await redis.set(markerKey('iu-1'), 'owner-A', 'EX', 1200);

            const wrong = await dispatchEngine.compareAndDeleteMarker(redis, markerKey('iu-1'), 'owner-X');
            expect(wrong).to.deep.equal({ deleted: false, reason: 'owner_changed' });
            expect(await redis.get(markerKey('iu-1'))).to.equal('owner-A');

            const right = await dispatchEngine.compareAndDeleteMarker(redis, markerKey('iu-1'), 'owner-A');
            expect(right).to.deep.equal({ deleted: true });
            expect(await redis.get(markerKey('iu-1'))).to.equal(null);

            const missing = await dispatchEngine.compareAndDeleteMarker(redis, markerKey('iu-1'), 'owner-A');
            expect(missing).to.deep.equal({ deleted: false, reason: 'missing' });
        });

        it('finalizeDispatch(cancelled) cleanup keeps a re-owned marker end-to-end', async () => {
            const A = 'dispatch-A-finalize';
            const Bf = 'dispatch-B-reowner';
            await createActiveDispatch(A);
            // Marker registered by A before send, then re-owned by B before A finalizes
            await redis.set(markerKey('iu-1'), Bf, 'EX', 1200);
            await dispatchEngine.registerInFlightMarker(redis, A, markerKey('iu-1'));

            const fin = await dispatchEngine.finalizeDispatch(redis, B, C, S, 'image', {
                outcome: 'cancelled',
                dispatchId: A,
                reason: 'test_late_cleanup',
            });
            expect(fin.finalized).to.equal(true);
            expect(await redis.get(markerKey('iu-1'))).to.equal(Bf);
        });
    });

    // ────────────────────────────────────────────────────────────
    // 4. Partial dispatch follow-up: dead-dispatch identity
    // ────────────────────────────────────────────────────────────
    describe('partial dispatch — why orphaned running jobs are re-sent after cancel', () => {

        it('after cancel the dead dispatch identity is invalid (its results cannot be delivered)', async () => {
            await state.setAssetState(redis, B, C, S, 'image', state.AssetState.PENDING);
            let call = 0;
            gpu.send = async (jobId) => { call++; return call <= 3 ? { sent: true, jobId } : { sent: false, error: 'down' }; };
            const res = await dispatchEngine.dispatchStage(redis, B, C, S, 'image', makeBook(), BUILD, {});
            expect(res.dispatched).to.equal(true);
            const dispatchIdA = res.dispatchId;

            // While A is alive its 3 running IUs are protected from duplicate send
            const flight = await iuProcessor.checkInFlightMarker(
                redis, markerKey('iu-1'), B, C, S, 'dispatch-X'
            );
            expect(flight.inFlight).to.equal(true);

            await dispatchEngine.cancelActiveDispatch(redis, B, C, S, 'image', 'partial_cancel');

            // A is dead: a late result of its running jobs is rejected by the
            // task-handler identity gate (image stage has no stale-acceptance
            // window) — therefore the redispatch MUST re-send those IUs or the
            // scene would never complete. Duplicate GPU work for the still-
            // running orphan jobs is absorbed by idempotent result processing;
            // queued jobs of A are removed by clearHubDispatches in the
            // production cancel path (resetScenes).
            const identity = await dispatchEngine.verifyDispatchIdentity(
                redis, B, C, S, 'image', dispatchIdA
            );
            expect(identity.valid).to.equal(false);
            expect(identity.reason).to.equal('no_active_dispatch');

            // The 6 never-sent IUs redispatch cleanly (no false no_jobs_sent)
            const sentJobs = [];
            gpu.send = async (jobId) => { sentJobs.push(jobId); return { sent: true, jobId }; };
            const res2 = await dispatchEngine.dispatchStage(redis, B, C, S, 'image', makeBook(), BUILD, { force: true });
            expect(res2.dispatched).to.equal(true);
            expect(res2.result.reason).to.not.equal('no_jobs_sent');
            expect(sentJobs.length).to.be.at.least(6);
        });
    });

    // ────────────────────────────────────────────────────────────
    // 5. TTL is a safety net only
    // ────────────────────────────────────────────────────────────
    describe('TTL semantics', () => {

        it('marker/index TTL is 1200s (unchanged) and is only a backstop', async () => {
            // Not raised to mask lifecycle gaps: normal completion (test above)
            // and stale-owner detection clear markers far earlier.
            expect(config.TIMEOUTS.IU_IN_FLIGHT_TTL_S).to.equal(1200);
            expect(dispatchEngine.IU_IN_FLIGHT_MARKER_TTL_S).to.equal(1200);

            const dispatchId = 'dispatch-ttl';
            await createActiveDispatch(dispatchId);
            // Register a marker through the real pre-send path
            await redis.set(markerKey('iu-1'), dispatchId, 'EX', config.TIMEOUTS.IU_IN_FLIGHT_TTL_S);
            await dispatchEngine.registerInFlightMarker(redis, dispatchId, markerKey('iu-1'));

            expect(await redis.ttl(markerKey('iu-1'))).to.equal(1200);
            expect(await redis.ttl(dispatchEngine.getInFlightIndexKey(dispatchId))).to.equal(1200);
        });
    });
});
