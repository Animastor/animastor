// ======================================================
// Dispatch metadata / lease lifecycle — regression tests
// ======================================================
// Follow-up to fix 172b3315 (orphan GENERATING repair, audit d9d67a3).
//
// getDispatchEvidence() treats dispatch metadata as proof of a LIVE
// generation. That is only safe if the metadata lifecycle is provably
// synchronized with the lease lifecycle. This file proves it:
//
//   create   acquireStageLease   SET lease  EX LEASE_TTLS[stage]   (NX)
//            setDispatchMetadata SET meta   EX LEASE_TTLS[stage]
//   renew    renewLeaseIfOwner   ONE Lua step: EXPIRE lease = EXPIRE meta
//                                (= LEASE_TTLS + LEASE_RENEWAL_TTL_ADD);
//                                if the lease is gone the metadata is NOT
//                                prolonged (no_lease branch)
//   finalize finalizeDispatch     ONE Lua step: DEL meta + DEL lease
//   cancel   cancelActiveDispatch finalize (both) or orphan-lease release
//   bulk     clearAllLeasesForBook / ByStage: cancel + orphan-meta sweep
//
// Invariant under test: metadata can NEVER outlive its lease (creation gap
// is milliseconds), so after crash/restart an orphaned metadata key dies
// with its own TTL and the orphan-GENERATING repair unblocks.
//
// NOTE: runtime-persistence.recoverDispatchMetadata (EX 3600) could break
// this invariant, but initializeRuntime/restoreFromSnapshot is dead code —
// never called from backend startup (backend.cjs uses reconcileCycle).
//
// TEST A — creation: equal TTLs for lease+metadata (audio/image/video)
// TEST B — renewal: atomic re-pin of both; dead lease → meta not prolonged
// TEST C — finalization/cancellation: both keys deleted atomically
// TEST D — clearAllLeasesForBook: lease+metadata incl. orphan metadata
// TEST E — crash/restart: metadata blocks repair only until its own TTL,
//          then orphan GENERATING is repaired (the critical scenario)
// TEST F — live renewed generation stays GENERATING across many cycles
// TEST G — Stop All leaves no metadata behind; tombstone blocks resurrection

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockRedis } = require('./mocks/redis-mock');

const B = 'lifecycle_book', C = 'ch-1', S = 'sc-1';
const STAGES = ['audio', 'image', 'video'];

const ASSET_STATE_KEY = `animastor:asset-state:${B}:${C}:${S}`;
const JOURNAL_KEY = `animastor:event-journal:${B}:${C}:${S}`;
const ACTIVE_SCENES_KEY = 'animastor:active-scenes';
const leaseKeyOf = (stage) => `animastor:dispatch-lease:${B}:${C}:${S}:${stage}`;
const metaKeyOf = (stage) => `animastor:dispatch-meta:${B}:${C}:${S}:${stage}`;

const P = {
    storage: require.resolve('../src/storage'),
    book: require.resolve('../src/book'),
    taskRepo: require.resolve('../src/storage/postgres/repositories/task-repo'),
    cancelRepo: require.resolve('../src/storage/postgres/repositories/generation-cancel-repo'),
    sceneAssetsRepo: require.resolve('../src/storage/postgres/repositories/scene-assets-repo'),
    database: require.resolve('../src/storage/postgres/database'),
    reconciler: require.resolve('../src/runtime/reconciliation-engine'),
    dispatchEngine: require.resolve('../src/runtime/dispatch-engine'),
    leaseManager: require.resolve('../src/runtime/lease-manager'),
    orchestrator: require.resolve('../src/orchestration/orchestrator'),
    state: require.resolve('../src/state'),
    scheduler: require.resolve('../src/runtime/runtime-scheduler'),
    sceneWindow: require.resolve('../src/runtime/scene-window'),
    journal: require.resolve('../src/orchestration/event-journal'),
    cancelRoute: require.resolve('../src/routes/book/generation-routes.cjs'),
};

// ── Stubs (PG + fs are irrelevant for the lifecycle under test) ──
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-lease-test-'));
const pgState = { cancelledBooks: new Set() };
const storageStub = {
    filesystem: {
        getSceneAudioPath: (dir, buildId, b, c, s) =>
            path.join(tmpRoot, buildId, `${b}_${c}_${s}.mp3`),
    },
    registry: { getSceneAssetsRedis: async () => null },
    postgres: { query: async () => ({ rows: [] }) },
};
const bookStub = { loadBook: () => null };
const taskRepoStub = {
    createTask: async () => ({}),
    updateTaskStatus: async () => {},
    getSceneTasks: async () => [],
    cancelActiveTasksForBook: async () => 1,
    hasActiveTaskForScene: async () => false,
};
const cancelRepoStub = {
    setCancelled: async (b) => { pgState.cancelledBooks.add(b); return { book_id: b, cancelled: true }; },
    clear: async (b) => { pgState.cancelledBooks.delete(b); return { book_id: b, cancelled: false }; },
    isCancelled: async (b) => pgState.cancelledBooks.has(b),
    getAllCancelled: async () => [...pgState.cancelledBooks].map((book_id) => ({ book_id })),
};
const sceneAssetsRepoStub = { markStale: async () => {}, getDirtyUnitIds: async () => [] };
const databaseStub = { query: async () => ({ rows: [], rowCount: 0 }) };

let state, orchestrator, dispatchEngine, leaseManager, reconciler, scheduler, sceneWindow;
const savedCache = new Map();
let cacheSnapshot;
let redis;

function installStubs() {
    require.cache[P.storage] = { exports: storageStub, loaded: true };
    require.cache[P.book] = { exports: bookStub, loaded: true };
    require.cache[P.taskRepo] = { exports: taskRepoStub, loaded: true };
    require.cache[P.cancelRepo] = { exports: cancelRepoStub, loaded: true };
    require.cache[P.sceneAssetsRepo] = { exports: sceneAssetsRepoStub, loaded: true };
    require.cache[P.database] = { exports: databaseStub, loaded: true };
}

// ── Helpers ─────────────────────────────────────────────

async function createLiveDispatch(stage, dispatchId = `dispatch-${stage}-1`) {
    const lease = await dispatchEngine.acquireStageLease(redis, B, C, S, stage);
    expect(lease.acquired, `lease acquired (${stage})`).to.equal(true);
    const metadata = dispatchEngine.createDispatchMetadata(dispatchId, stage, 'scheduler', {
        leaseKey: lease.leaseKey,
        leaseToken: lease.token,
        quotaOwned: false,
    });
    await dispatchEngine.setDispatchMetadata(redis, B, C, S, stage, metadata);
    return { lease, metadata };
}

async function seedGenerating(stage) {
    await redis.hset(ASSET_STATE_KEY, stage, 'generating');
    await redis.rpush(JOURNAL_KEY, JSON.stringify({ ts: Date.now(), type: 'TEST_SEED' }));
}

async function allKeysByPattern(pattern) {
    let cursor = '0';
    const keys = [];
    do {
        const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = next;
        keys.push(...batch);
    } while (cursor !== '0');
    return keys;
}

async function runCycles(n) {
    for (let i = 0; i < n; i++) {
        const result = await reconciler.reconcileCycle(redis, {}, { startup: false });
        expect(result.ok, `reconcile cycle ${i + 1} ok`).to.equal(true);
    }
}

function mountCancelRoute() {
    delete require.cache[P.cancelRoute];
    const handlers = new Map();
    const app = {
        post: (p, h) => handlers.set(`POST ${p}`, h),
        get: () => {}, put: () => {}, delete: () => {},
    };
    const deps = {
        config: { HUB_URL: 'http://gpu-hub.test', GPU_HUB_API_KEY: '' },
        state,
        runtime: { sceneWindow, scheduler },
        utils: { log: () => {} },
    };
    require(P.cancelRoute)(app, redis, deps);
    return handlers.get('POST /api/v1/book/:bookId/cancel-generation');
}

function makeRes() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

// ======================================================
// TESTS — hooks are describe-scoped on purpose: root-level
// hooks would leak the stubs into other test files.
// ======================================================
describe('dispatch metadata/lease lifecycle — getDispatchEvidence premise (172b3315 follow-up)', () => {

    before(() => {
        cacheSnapshot = new Set(Object.keys(require.cache));
        for (const p of Object.values(P)) savedCache.set(p, require.cache[p]);
        installStubs();
        for (const p of [P.reconciler, P.dispatchEngine, P.leaseManager, P.orchestrator,
            P.state, P.scheduler, P.sceneWindow, P.journal, P.cancelRoute]) {
            delete require.cache[p];
        }
        state = require(P.state);
        orchestrator = require(P.orchestrator);
        leaseManager = require(P.leaseManager);
        dispatchEngine = require(P.dispatchEngine);
        scheduler = require(P.scheduler);
        sceneWindow = require(P.sceneWindow);
        reconciler = require(P.reconciler);
    });

    after(() => {
        for (const [p, entry] of savedCache) {
            if (entry) require.cache[p] = entry;
            else delete require.cache[p];
        }
        for (const k of Object.keys(require.cache)) {
            if (!cacheSnapshot.has(k)) delete require.cache[k];
        }
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    beforeEach(() => {
        redis = createMockRedis();
        pgState.cancelledBooks.clear();
    });

    // ── TEST A: creation TTL synchronization ────────────
    describe('A. creation: lease and metadata get equal TTLs', () => {
        for (const stage of STAGES) {
            it(`${stage}: both keys are created with EX = LEASE_TTLS.${stage}`, async () => {
                await createLiveDispatch(stage);
                expect(await redis.ttl(leaseKeyOf(stage)))
                    .to.equal(dispatchEngine.LEASE_TTLS[stage]);
                expect(await redis.ttl(metaKeyOf(stage)))
                    .to.equal(dispatchEngine.LEASE_TTLS[stage]);
            });
        }
    });

    // ── TEST B: renewal keeps both in sync ──────────────
    describe('B. renewal: atomic re-pin of lease AND metadata', () => {
        it('renewal re-pins both keys to the same TTL', async () => {
            const { lease } = await createLiveDispatch('image');
            const renewed = await leaseManager.renewLeaseIfOwner(redis, lease.leaseKey, lease.token);
            expect(renewed.renewed).to.equal(true);
            const expected = leaseManager.LEASE_TOTAL_TTLS.image + leaseManager.LEASE_RENEWAL_TTL_ADD;
            expect(await redis.ttl(leaseKeyOf('image'))).to.equal(expected);
            expect(await redis.ttl(metaKeyOf('image'))).to.equal(expected);
        });

        it('token mismatch → nothing is prolonged', async () => {
            const { lease } = await createLiveDispatch('image');
            const renewed = await leaseManager.renewLeaseIfOwner(redis, lease.leaseKey, 'wrong-token');
            expect(renewed.renewed).to.equal(false);
            expect(await redis.ttl(leaseKeyOf('image')))
                .to.equal(dispatchEngine.LEASE_TTLS.image);
            expect(await redis.ttl(metaKeyOf('image')))
                .to.equal(dispatchEngine.LEASE_TTLS.image);
        });

        it('dead lease → metadata is NOT prolonged (no_lease branch)', async () => {
            const { lease } = await createLiveDispatch('image');
            await redis.del(leaseKeyOf('image')); // lease expired / crashed away
            const renewed = await leaseManager.renewLeaseIfOwner(redis, lease.leaseKey, lease.token);
            expect(renewed.renewed).to.equal(false);
            expect(renewed.reason).to.equal('lease_expired');
            // metadata keeps its original countdown — it dies with its own TTL
            expect(await redis.ttl(metaKeyOf('image')))
                .to.equal(dispatchEngine.LEASE_TTLS.image);
        });
    });

    // ── TEST C: finalization/cancellation deletes both ──
    describe('C. finalization and cancellation delete lease+metadata', () => {
        for (const stage of STAGES) {
            it(`${stage}: finalizeDispatch(success) deletes both keys`, async () => {
                const { metadata } = await createLiveDispatch(stage, `dispatch-fin-${stage}`);
                const result = await dispatchEngine.finalizeDispatch(redis, B, C, S, stage, {
                    outcome: 'success',
                    dispatchId: metadata.dispatch_id,
                });
                expect(result.finalized).to.equal(true);
                expect(await redis.get(leaseKeyOf(stage))).to.equal(null);
                expect(await redis.get(metaKeyOf(stage))).to.equal(null);
            });
        }

        it('finalizeDispatch(cancelled) deletes both keys', async () => {
            const { metadata } = await createLiveDispatch('image', 'dispatch-cancel-1');
            const result = await dispatchEngine.finalizeDispatch(redis, B, C, S, 'image', {
                outcome: 'cancelled',
                dispatchId: metadata.dispatch_id,
                reason: 'test_cancel',
            });
            expect(result.finalized).to.equal(true);
            expect(await redis.get(leaseKeyOf('image'))).to.equal(null);
            expect(await redis.get(metaKeyOf('image'))).to.equal(null);
        });

        it('cancelActiveDispatch with metadata → both keys deleted', async () => {
            await createLiveDispatch('video');
            const result = await dispatchEngine.cancelActiveDispatch(redis, B, C, S, 'video', 'test');
            expect(result.cancelled).to.equal(true);
            expect(await redis.get(leaseKeyOf('video'))).to.equal(null);
            expect(await redis.get(metaKeyOf('video'))).to.equal(null);
        });

        it('cancelActiveDispatch with lease only → lease deleted, no metadata left', async () => {
            await dispatchEngine.acquireStageLease(redis, B, C, S, 'audio');
            const result = await dispatchEngine.cancelActiveDispatch(redis, B, C, S, 'audio', 'test');
            expect(result.cancelled).to.equal(true);
            expect(result.reason).to.equal('orphan_lease');
            expect(await redis.get(leaseKeyOf('audio'))).to.equal(null);
            expect(await redis.get(metaKeyOf('audio'))).to.equal(null);
        });
    });

    // ── TEST D: bulk cleanup ────────────────────────────
    describe('D. clearAllLeasesForBook removes lease+metadata incl. orphans', () => {
        it('lease-backed and orphan metadata are both removed', async () => {
            await createLiveDispatch('image'); // lease + metadata
            // orphan metadata without any lease (e.g. lease already expired)
            await redis.set(metaKeyOf('video'),
                JSON.stringify({ dispatch_id: 'dispatch-orphan', stage: 'video' }),
                'EX', 1200);

            await dispatchEngine.clearAllLeasesForBook(redis, B);

            expect(await allKeysByPattern(`animastor:dispatch-lease:${B}:*`)).to.have.length(0);
            expect(await allKeysByPattern(`animastor:dispatch-meta:${B}:*`)).to.have.length(0);
        });
    });

    // ── TEST E: crash/restart — the critical scenario ───
    describe('E. crash/restart: metadata cannot block repair beyond its own TTL', () => {
        it('lease expires → metadata alone keeps generation "alive" only until its TTL → orphan repaired', async function () {
            this.timeout(10000);
            // 1. Live image generation: lease + metadata + GENERATING
            const { lease } = await createLiveDispatch('image');
            await seedGenerating('image');

            // 2. Proof: metadata TTL == lease TTL (metadata dies with the lease)
            expect(await redis.ttl(metaKeyOf('image')))
                .to.equal(await redis.ttl(leaseKeyOf('image')));

            // 3. Crash before completion: lease expires first (renewal timers
            //    are in-memory and died with the process)
            await redis.del(leaseKeyOf('image'));

            // 4. Backend restart: metadata still present → generation is
            //    conservatively considered alive → NO orphan repair
            const ev = await dispatchEngine.getDispatchEvidence(redis, B, C, S, 'image');
            expect(ev).to.deep.equal({ alive: true, reason: 'dispatch_meta_present' });
            await runCycles(1);
            expect((await state.getAssetStates(redis, B, C, S)).image).to.equal('generating');

            // 5. Metadata TTL expires (guaranteed by step 2: same TTL as lease)
            await redis.del(metaKeyOf('image'));

            // 6. Next reconciliation: no lease, no meta, no marker, no PG task
            //    → proven dead → FSM-safe repair GENERATING → DIRTY → PENDING
            await runCycles(1);
            expect((await state.getAssetStates(redis, B, C, S)).image).to.equal('pending');
            expect(await allKeysByPattern(`animastor:dispatch-meta:${B}:*`)).to.have.length(0);
            expect(await allKeysByPattern(`animastor:dispatch-lease:${B}:*`)).to.have.length(0);
        });

        it('restart with lease+metadata both alive → untouched; after expiry → repaired', async function () {
            this.timeout(10000);
            await createLiveDispatch('image');
            await seedGenerating('image');

            // Restart within the TTL grace window: both keys survived in
            // persistent Redis → still "alive" → reconciliation must not touch it
            await runCycles(2);
            expect((await state.getAssetStates(redis, B, C, S)).image).to.equal('generating');

            // Both keys expire (equal TTLs, no renewal after crash)
            await redis.del(leaseKeyOf('image'), metaKeyOf('image'));
            await runCycles(1);
            expect((await state.getAssetStates(redis, B, C, S)).image).to.equal('pending');
        });
    });

    // ── TEST F: live renewed generation is protected ────
    describe('F. live renewed generation stays GENERATING', () => {
        it('lease+metadata renewed between cycles → no orphan repair, TTLs stay equal', async function () {
            this.timeout(10000);
            const { lease } = await createLiveDispatch('image');
            await seedGenerating('image');

            for (let i = 0; i < 3; i++) {
                const renewed = await leaseManager.renewLeaseIfOwner(redis, lease.leaseKey, lease.token);
                expect(renewed.renewed, `renewal ${i + 1}`).to.equal(true);
                await runCycles(1);
                expect((await state.getAssetStates(redis, B, C, S)).image,
                    `cycle ${i + 1}: live generation untouched`).to.equal('generating');
            }
            // Renewal keeps both keys pinned to the same TTL
            expect(await redis.ttl(leaseKeyOf('image')))
                .to.equal(await redis.ttl(metaKeyOf('image')));
        });
    });

    // ── TEST G: Stop All leaves no blocking metadata ────
    describe('G. Stop All: lease+metadata cleanup + orphan sweep + tombstone', () => {
        it('Stop All removes lease and metadata; state repaired; no resurrection', async function () {
            this.timeout(10000);
            // Live dispatch + GENERATING + scene in the active index
            await createLiveDispatch('image');
            await seedGenerating('image');
            await redis.sadd(ACTIVE_SCENES_KEY, `${B}:${C}:${S}`);

            const originalFetch = global.fetch;
            global.fetch = async () => ({ ok: true, status: 200 });
            try {
                const cancelGeneration = mountCancelRoute();
                const res = makeRes();
                await cancelGeneration({ params: { bookId: B } }, res);
                expect(res.statusCode).to.equal(200);
                expect(res.body.ok).to.equal(true);
            } finally {
                global.fetch = originalFetch;
            }

            // No lease, no metadata — nothing left that could block self-heal
            expect(await allKeysByPattern(`animastor:dispatch-lease:${B}:*`)).to.have.length(0);
            expect(await allKeysByPattern(`animastor:dispatch-meta:${B}:*`)).to.have.length(0);
            // Lease-backed GENERATING was rolled back (cancel → evidence gone → sweep)
            expect((await state.getAssetStates(redis, B, C, S)).image).to.equal('pending');
            // Tombstone + cancel flag recorded
            expect(pgState.cancelledBooks.has(B)).to.equal(true);
            expect(await redis.get(`animastor:generation:cancel:${B}`)).to.equal('true');

            // Reconciliation after Stop All: no resurrection, no new dispatch keys
            await runCycles(2);
            expect(await redis.smembers(ACTIVE_SCENES_KEY)).to.have.length(0);
            expect((await state.getAssetStates(redis, B, C, S)).image).to.equal('pending');
            expect(await allKeysByPattern(`animastor:dispatch-lease:${B}:*`)).to.have.length(0);
            expect(await allKeysByPattern(`animastor:dispatch-meta:${B}:*`)).to.have.length(0);
        });
    });
});
