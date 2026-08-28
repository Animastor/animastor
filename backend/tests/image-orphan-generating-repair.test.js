// ======================================================
// Orphan GENERATING repair — regression tests (audit d9d67a3)
// ======================================================
// Docs: docs/03-audit/image-ghost-generating/
//       image-ghost-runtime-incident-forensic-2026-08-28.md
//
// Proven incident chain under test:
//   pre-fix no_jobs_sent ghost (image=GENERATING, no task/dispatch/lease)
//   → backend restart (state survives in persistent Redis)
//   → UI synthesizes ghost "0/9" from active-scenes + asset-state
//   → Stop All powerless (cancellation only worked lease-backed)
//   → reconciliation resurrected the scene into active-scenes ignoring
//     the cancellation tombstone
//   → hardcoded buildId='default' false-flagged orphan audio every cycle.
//
// Fix under test:
//   1. Stop All orphan sweep: dispatchEngine.repairOrphanGeneratingStates —
//      GENERATING + no lease/meta/in-flight evidence → FSM-safe rollback
//      GENERATING → DIRTY → PENDING (never a direct forbidden transition).
//   2. Cancellation tombstone/cancel flag precedence: reconciliation
//      resurrection actions never re-add a cancelled book to active-scenes.
//   3. Canonical build identity (book manifest build_id) in orphan checks
//      instead of hardcoded 'default'.
//   4. Autonomous orphan self-heal in reconciliation (stage-scoped
//      MOVE_TO_PENDING) with strict liveness re-verification — a live
//      GENERATING (lease OR meta OR in-flight marker OR active PG task)
//      is NEVER repaired.
//
// TEST A — getDispatchEvidence liveness semantics
// TEST B — repairOrphanGeneratingStates sweep unit
// TEST C — full incident E2E: ghost 0/9 → Stop All → 3 reconcile cycles →
//          ghost gone, tombstone honored, panel empty
// TEST D — autonomous recovery without Stop All (no tombstone) → dispatchable
// TEST E — live GENERATING is never repaired (lease/meta/marker/PG task)
// TEST F — tombstone precedence + new generation after cancellation
// TEST G — buildId fix in orphan audio/image checks
// TEST H — repair needs no workers and creates no dispatch at 0 workers

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockRedis } = require('./mocks/redis-mock');

const B = 'orphan_book', C = 'ch-1', S = 'sc-1', S2 = 'sc-2';
const BUILD = 'build-orphan-test';
const IU_COUNT = 9;

const ASSET_STATE_KEY = `animastor:asset-state:${B}:${C}:${S}`;
const ASSET_STATE_KEY_S2 = `animastor:asset-state:${B}:${C}:${S2}`;
const JOURNAL_KEY = `animastor:event-journal:${B}:${C}:${S}`;
const JOURNAL_KEY_S2 = `animastor:event-journal:${B}:${C}:${S2}`;
const ACTIVE_SCENES_KEY = 'animastor:active-scenes';
const CANCEL_FLAG_KEY = `animastor:generation:cancel:${B}`;
const leaseKey = (scene, stage) => `animastor:dispatch-lease:${B}:${C}:${scene}:${stage}`;
const metaKey = (scene, stage) => `animastor:dispatch-meta:${B}:${C}:${scene}:${stage}`;
const markerKey = (iuId) => `animastor:iu-in-flight:${B}_${C}_${S}_${iuId}`;

// ── Module paths under our control ──────────────────────
const P = {
    storage: require.resolve('../src/storage'),
    book: require.resolve('../src/book'),
    image: require.resolve('../src/image'),
    taskRepo: require.resolve('../src/storage/postgres/repositories/task-repo'),
    cancelRepo: require.resolve('../src/storage/postgres/repositories/generation-cancel-repo'),
    sceneAssetsRepo: require.resolve('../src/storage/postgres/repositories/scene-assets-repo'),
    database: require.resolve('../src/storage/postgres/database'),
    reconciler: require.resolve('../src/runtime/reconciliation-engine'),
    dispatchEngine: require.resolve('../src/runtime/dispatch-engine'),
    orchestrator: require.resolve('../src/orchestration/orchestrator'),
    state: require.resolve('../src/state'),
    scheduler: require.resolve('../src/runtime/runtime-scheduler'),
    sceneWindow: require.resolve('../src/runtime/scene-window'),
    journal: require.resolve('../src/orchestration/event-journal'),
    genProgress: require.resolve('../src/services/generation-progress'),
    cancelRoute: require.resolve('../src/routes/book/generation-routes.cjs'),
    progressPanel: require.resolve('../src/routes/book/progress-panel.cjs'),
};

// ── Shared stub state (reset per test) ──────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-gen-test-'));
const pgState = {
    activeTasks: new Set(),      // "book:scene:type"
    cancelledBooks: new Set(),   // tombstones
};
const imageProbe = { calls: [], filePresent: false };

function makeBook() {
    const units = Array.from({ length: IU_COUNT }, (_, i) => ({
        id: `iu-${i + 1}`,
        text: `Unit text ${i + 1}`,
    }));
    return {
        manifest: { book_id: B, build_id: BUILD },
        chapters: [{ chapter_id: C, scenes: [{ scene_id: S, units }] }],
    };
}

const storageStub = {
    filesystem: {
        // Records the buildId it was called with (TEST G assertion target).
        getSceneAudioPath: (dir, buildId, b, c, s) =>
            path.join(tmpRoot, buildId, `${b}_${c}_${s}.mp3`),
    },
    registry: {
        getSceneAssetsRedis: async () => null,
    },
    postgres: { query: async () => ({ rows: [] }) },
};
const bookStub = { loadBook: (id) => (id === B ? makeBook() : null) };
const imageStub = {
    resolveCanonicalSceneImage: (dir, buildId, b, c, s) => {
        imageProbe.calls.push({ buildId });
        return imageProbe.filePresent ? `${b}_${c}_${s}_iu-1.png` : null;
    },
};
const taskRepoStub = {
    createTask: async () => ({}),
    updateTaskStatus: async () => {},
    getSceneTasks: async () => [],
    getPendingTasks: async () => [],
    cancelActiveTasksForBook: async (bookId) => {
        for (const key of [...pgState.activeTasks]) {
            if (key.startsWith(`${bookId}:`)) pgState.activeTasks.delete(key);
        }
        return 1;
    },
    hasActiveTaskForScene: async (b, s, t) => pgState.activeTasks.has(`${b}:${s}:${t}`),
};
const cancelRepoStub = {
    setCancelled: async (b) => { pgState.cancelledBooks.add(b); return { book_id: b, cancelled: true }; },
    clear: async (b) => { pgState.cancelledBooks.delete(b); return { book_id: b, cancelled: false }; },
    isCancelled: async (b) => pgState.cancelledBooks.has(b),
    getAllCancelled: async () => [...pgState.cancelledBooks].map((book_id) => ({ book_id })),
};
const sceneAssetsRepoStub = {
    markStale: async () => {},
    getDirtyUnitIds: async () => [],
};
const databaseStub = { query: async () => ({ rows: [], rowCount: 0 }) };

// ── Load real modules once, with stubs in place ─────────
let state, orchestrator, dispatchEngine, reconciler, scheduler, sceneWindow, genProgress;
const savedCache = new Map();
let cacheSnapshot;

function installStubs() {
    require.cache[P.storage] = { exports: storageStub, loaded: true };
    require.cache[P.book] = { exports: bookStub, loaded: true };
    require.cache[P.image] = { exports: imageStub, loaded: true };
    require.cache[P.taskRepo] = { exports: taskRepoStub, loaded: true };
    require.cache[P.cancelRepo] = { exports: cancelRepoStub, loaded: true };
    require.cache[P.sceneAssetsRepo] = { exports: sceneAssetsRepoStub, loaded: true };
    require.cache[P.database] = { exports: databaseStub, loaded: true };
}

// NOTE: all require.cache mutations live inside the describe-scoped hooks
// below. Root-level hooks would apply to the whole mocha run and leak the
// stubs into other test files.

// ── Helpers ─────────────────────────────────────────────
let redis;

function createAudioFile(buildId = BUILD) {
    const dir = path.join(tmpRoot, buildId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${B}_${C}_${S}.mp3`), 'fake-mp3');
}

async function seedGhost(scene = S, { evidence = null, journalKey = JOURNAL_KEY, active = true } = {}) {
    const key = scene === S ? ASSET_STATE_KEY : ASSET_STATE_KEY_S2;
    await redis.hset(key, 'audio', 'ready');
    await redis.hset(key, 'image', 'generating');
    // reconcileAll discovers scenes via the event-journal key scan
    await redis.rpush(journalKey, JSON.stringify({ ts: Date.now(), type: 'TEST_SEED' }));
    if (active) await redis.sadd(ACTIVE_SCENES_KEY, `${B}:${C}:${scene}`);
    if (evidence === 'lease') {
        // A real live dispatch always holds lease AND metadata (same TTL,
        // renewed together). EX keeps the lease out of the stale-lease
        // recovery path (ttl -1 would be flagged broken by isLeaseStale).
        await redis.set(leaseKey(scene, 'image'), 'tok-live', 'EX', 3600);
        await redis.set(metaKey(scene, 'image'),
            JSON.stringify({ dispatch_id: 'dispatch-live', stage: 'image', lease_token: 'tok-live' }));
    }
    if (evidence === 'meta') {
        await redis.set(metaKey(scene, 'image'),
            JSON.stringify({ dispatch_id: 'dispatch-live', stage: 'image' }));
    }
    if (evidence === 'inflight') await redis.set(markerKey('iu-1'), 'dispatch-live');
}

async function imageState(scene = S) {
    const states = await state.getAssetStates(redis, B, C, scene);
    return states.image;
}

async function activeScenes() {
    return redis.smembers(ACTIVE_SCENES_KEY);
}

async function journalEvents(scene = S) {
    const key = scene === S ? JOURNAL_KEY : JOURNAL_KEY_S2;
    return (await redis.lrange(key, 0, -1)).map(JSON.parse);
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
        get: (p, h) => handlers.set(`GET ${p}`, h),
        put: (p, h) => handlers.set(`PUT ${p}`, h),
        delete: (p, h) => handlers.set(`DELETE ${p}`, h),
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

function mountProgressPanel() {
    delete require.cache[P.progressPanel];
    const handlers = new Map();
    const app = {
        get: (p, h) => handlers.set(`GET ${p}`, h),
        post: () => {}, put: () => {}, delete: () => {},
    };
    const deps = {
        state,
        activeScenes: require('../src/runtime/active-scenes-index'),
        iuRepo: {
            getImageUnitsForScene: async () =>
                Array.from({ length: IU_COUNT }, (_, i) => ({ unit_id: `iu-${i + 1}` })),
        },
        book: bookStub,
        utils: { log: () => {} },
        // The mock redis has no mget → loadChunks falls back to getChunk.
        // A real chunk carries the build identity, so countImage resolves
        // the 9 image units exactly like production.
        getChunk: async () => ({
            chapter_id: C, scene_id: S, build_id: BUILD,
            image_status: 'pending', audio_status: 'ready',
        }),
        getAllChunks: async () => [`${B}_${C}_${S}_0001`],
    };
    require(P.progressPanel)(app, redis, deps);
    return handlers.get('GET /api/v1/book/:bookId/progress-panel');
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
// TEST A — getDispatchEvidence liveness semantics
// ======================================================
describe('orphan GENERATING repair (audit d9d67a3)', () => {

    before(() => {
        cacheSnapshot = new Set(Object.keys(require.cache));
        for (const p of Object.values(P)) savedCache.set(p, require.cache[p]);
        installStubs();
        for (const p of [P.reconciler, P.dispatchEngine, P.orchestrator, P.state,
            P.scheduler, P.sceneWindow, P.journal, P.genProgress,
            P.cancelRoute, P.progressPanel]) {
            delete require.cache[p];
        }
        state = require(P.state);
        orchestrator = require(P.orchestrator);
        dispatchEngine = require(P.dispatchEngine);
        scheduler = require(P.scheduler);
        sceneWindow = require(P.sceneWindow);
        genProgress = require(P.genProgress);
        reconciler = require(P.reconciler);
        // Route modules are required per test (they capture handlers).
    });

    after(() => {
        for (const [p, entry] of savedCache) {
            if (entry) require.cache[p] = entry;
            else delete require.cache[p];
        }
        // Purge every module first loaded during this suite: those instances
        // may hold references to the stubs above (book/database/scene-assets)
        // and would leak them into subsequent test files.
        for (const k of Object.keys(require.cache)) {
            if (!cacheSnapshot.has(k)) delete require.cache[k];
        }
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    beforeEach(() => {
        redis = createMockRedis();
        pgState.activeTasks.clear();
        pgState.cancelledBooks.clear();
        imageProbe.calls.length = 0;
        imageProbe.filePresent = false;
        // files created by a previous test must not leak into the next one
        fs.rmSync(path.join(tmpRoot, BUILD), { recursive: true, force: true });
    });

    describe('A. getDispatchEvidence', () => {
        it('reports no evidence when lease/meta/markers are absent', async () => {
            const ev = await dispatchEngine.getDispatchEvidence(redis, B, C, S, 'image');
            expect(ev.alive).to.equal(false);
        });

        it('lease alone proves a live generation', async () => {
            await redis.set(leaseKey(S, 'image'), 'tok');
            const ev = await dispatchEngine.getDispatchEvidence(redis, B, C, S, 'image');
            expect(ev).to.deep.equal({ alive: true, reason: 'lease_present' });
        });

        it('dispatch metadata alone proves a live generation', async () => {
            await redis.set(metaKey(S, 'image'), JSON.stringify({ dispatch_id: 'd1' }));
            const ev = await dispatchEngine.getDispatchEvidence(redis, B, C, S, 'image');
            expect(ev).to.deep.equal({ alive: true, reason: 'dispatch_meta_present' });
        });

        it('iu-in-flight marker alone proves a live image generation', async () => {
            await redis.set(markerKey('iu-3'), 'd1');
            const ev = await dispatchEngine.getDispatchEvidence(redis, B, C, S, 'image');
            expect(ev).to.deep.equal({ alive: true, reason: 'iu_in_flight_present' });
        });

        it('a marker of another scene is not evidence for this scene', async () => {
            await redis.set(`animastor:iu-in-flight:${B}_${C}_${S2}_iu-1`, 'd1');
            const ev = await dispatchEngine.getDispatchEvidence(redis, B, C, S, 'image');
            expect(ev.alive).to.equal(false);
        });
    });

    // ======================================================
    // TEST B — repairOrphanGeneratingStates sweep
    // ======================================================
    describe('B. repairOrphanGeneratingStates (Stop All sweep core)', () => {
        it('rolls back orphan GENERATING via FSM-safe GENERATING → DIRTY → PENDING', async () => {
            await seedGhost(S);
            const result = await dispatchEngine.repairOrphanGeneratingStates(redis, B, { reason: 'test_sweep' });
            expect(result.repaired).to.have.length(1);
            expect(result.repaired[0]).to.include({ chapterId: C, sceneId: S, stage: 'image' });
            expect(result.repaired[0].path).to.deep.equal(['dirty', 'pending']);
            expect(await imageState()).to.equal('pending');
            // rollback journaled (SCENE_PENDING with rollback:true)
            const events = await journalEvents();
            const rollback = events.find(e => e.type === 'SCENE_PENDING' && e.details?.rollback === true);
            expect(rollback, 'rollback journal event').to.exist;
            expect(rollback.details.via).to.equal('dirty->pending');
        });

        it('never touches a GENERATING stage with live evidence', async () => {
            await seedGhost(S, { evidence: 'lease' });
            await redis.hset(ASSET_STATE_KEY_S2, 'image', 'generating');
            await redis.set(metaKey(S2, 'image'), JSON.stringify({ dispatch_id: 'd2' }));
            await redis.rpush(JOURNAL_KEY_S2, JSON.stringify({ ts: Date.now(), type: 'SEED' }));

            const result = await dispatchEngine.repairOrphanGeneratingStates(redis, B);
            expect(result.repaired).to.have.length(0);
            expect(await imageState(S)).to.equal('generating');
            expect(await imageState(S2)).to.equal('generating');
        });

        it('does not touch ready/dirty states and needs no workers', async () => {
            await seedGhost(S); // audio=ready, image=generating (orphan)
            // zero worker heartbeats in redis — repair must still work
            const result = await dispatchEngine.repairOrphanGeneratingStates(redis, B);
            expect(result.repaired).to.have.length(1);
            const states = await state.getAssetStates(redis, B, C, S);
            expect(states.audio).to.equal('ready');
            // no dispatch was created by the repair
            expect(await allKeysByPattern('animastor:dispatch-lease:*')).to.have.length(0);
            expect(await allKeysByPattern('animastor:dispatch-meta:*')).to.have.length(0);
        });
    });

    // ======================================================
    // TEST C — full incident E2E: ghost 0/9 → Stop All → cycles
    // ======================================================
    describe('C. incident E2E: ghost 0/9 → Stop All → 3 reconcile cycles', () => {
        it('UI synthesizes ghost 0/9 before Stop All', async () => {
            await seedGhost(S);
            const panel = mountProgressPanel();
            const res = makeRes();
            await panel({ params: { bookId: B } }, res);
            expect(res.statusCode).to.equal(200);
            const imageRows = res.body.tasks.filter(t => t.type === 'image');
            expect(imageRows, 'ghost image row synthesized from active-scenes').to.have.length(1);
            expect(imageRows[0].total).to.equal(IU_COUNT);
            expect(imageRows[0].ready).to.equal(0);
            expect(imageRows[0].done).to.equal(false);
        });

        it('Stop All clears the orphan GENERATING, tombstone + cancel flag set', async () => {
            await seedGhost(S);
            createAudioFile();
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

            // orphan state repaired: GENERATING → DIRTY → PENDING
            expect(await imageState()).to.equal('pending');
            const states = await state.getAssetStates(redis, B, C, S);
            expect(states.audio).to.equal('ready');
            // scene removed from active index
            expect(await activeScenes()).to.have.length(0);
            // cancellation recorded: Redis flag + PG tombstone
            expect(await redis.get(CANCEL_FLAG_KEY)).to.equal('true');
            expect(pgState.cancelledBooks.has(B)).to.equal(true);
            // no dispatch artifacts left or created
            expect(await allKeysByPattern('animastor:dispatch-lease:*')).to.have.length(0);
            expect(await allKeysByPattern('animastor:dispatch-meta:*')).to.have.length(0);
            expect(await allKeysByPattern('animastor:iu-in-flight:*')).to.have.length(0);
        });

        it('3 reconcile cycles after Stop All: ghost does not resurrect', async function () {
            this.timeout(10000);
            await seedGhost(S);
            createAudioFile();
            const originalFetch = global.fetch;
            global.fetch = async () => ({ ok: true, status: 200 });
            try {
                const cancelGeneration = mountCancelRoute();
                await cancelGeneration({ params: { bookId: B } }, makeRes());
            } finally {
                global.fetch = originalFetch;
            }

            await runCycles(3);

            // tombstone honored: scene NOT re-added to active-scenes
            expect(await activeScenes()).to.have.length(0);
            // state stays out of GENERATING (no resurrection, no new ghost)
            expect(await imageState()).to.equal('pending');
            // no new dispatch was created
            expect(await allKeysByPattern('animastor:dispatch-lease:*')).to.have.length(0);
            const events = await journalEvents();
            expect(events.find(e => e.type === 'IMAGE_DISPATCHED'), 'no re-dispatch').to.not.exist;
            // progress panel no longer synthesizes the ghost row
            const panel = mountProgressPanel();
            const res = makeRes();
            await panel({ params: { bookId: B } }, res);
            expect(res.body.tasks.filter(t => t.type === 'image')).to.have.length(0);
            expect(res.body.any_incomplete).to.equal(false);
        });
    });

    // ======================================================
    // TEST D — autonomous recovery without Stop All
    // ======================================================
    describe('D. autonomous orphan self-heal (no tombstone)', () => {
        it('reconciliation repairs orphan GENERATING and makes it dispatchable', async function () {
            this.timeout(10000);
            await seedGhost(S); // no evidence, no tombstone, no cancel flag
            createAudioFile();

            await runCycles(1);

            // FSM-safe repair landed
            expect(await imageState()).to.equal('pending');
            // scene re-added to active index → dispatchable again
            expect(await activeScenes()).to.include(`${B}:${C}:${S}`);
            // AUTO_RECOVER journaled
            const events = await journalEvents();
            expect(events.find(e => e.type === 'AUTO_RECOVER' && e.details?.stage === 'image'),
                'AUTO_RECOVER journal event').to.exist;
            // scheduler sees the stage as dispatchable
            const { stages, allDone } = await scheduler.shouldScheduleAssets(redis, B, C, S);
            expect(allDone).to.equal(false);
            expect(stages).to.include('image');
        });

        it('repair is stable across cycles and creates no dispatch at 0 workers', async function () {
            this.timeout(10000);
            await seedGhost(S);
            createAudioFile();

            await runCycles(3);

            expect(await imageState()).to.equal('pending');
            expect(await activeScenes()).to.include(`${B}:${C}:${S}`);
            // reconciliation repairs state but never dispatches (dispatch is the
            // scheduler's job) — and does not require any worker to be alive
            expect(await allKeysByPattern('animastor:dispatch-lease:*')).to.have.length(0);
            expect(await allKeysByPattern('animastor:worker-heartbeat:*')).to.have.length(0);
        });
    });

    // ======================================================
    // TEST E — live GENERATING is NEVER repaired
    // ======================================================
    describe('E. live GENERATING protection', () => {
        it('lease present → many cycles → no repair', async function () {
            this.timeout(10000);
            await seedGhost(S, { evidence: 'lease' });
            await runCycles(3);
            expect(await imageState()).to.equal('generating');
            const events = await journalEvents();
            expect(events.find(e => e.type === 'AUTO_RECOVER')).to.not.exist;
        });

        it('dispatch metadata present → no repair', async function () {
            this.timeout(10000);
            await seedGhost(S, { evidence: 'meta' });
            await runCycles(3);
            expect(await imageState()).to.equal('generating');
        });

        it('iu-in-flight marker present (GPU job may run) → no repair', async function () {
            this.timeout(10000);
            await seedGhost(S, { evidence: 'inflight' });
            await runCycles(3);
            expect(await imageState()).to.equal('generating');
        });

        it('active PG generation task present → no repair (fail-safe)', async function () {
            this.timeout(10000);
            await seedGhost(S); // no redis evidence...
            pgState.activeTasks.add(`${B}:${S}:image`); // ...but a live PG task
            await runCycles(3);
            expect(await imageState()).to.equal('generating');
        });
    });

    // ======================================================
    // TEST F — tombstone precedence + new generation after cancel
    // ======================================================
    describe('F. cancellation tombstone precedence', () => {
        it('orphan repair runs for a cancelled book but does NOT re-add to active index', async function () {
            this.timeout(10000);
            // Stop All already removed the scene from the active index; the
            // orphan GENERATING state is what survived in Redis.
            await seedGhost(S, { active: false });
            createAudioFile();
            pgState.cancelledBooks.add(B); // tombstone from Stop All

            await runCycles(3);

            // state hygiene performed...
            expect(await imageState()).to.equal('pending');
            // ...but no resurrection
            expect(await activeScenes()).to.have.length(0);
        });

        it('resurrection fixes are blocked while the tombstone exists', async () => {
            await seedGhost(S, { active: false });
            pgState.cancelledBooks.add(B);
            const fix = {
                scene: { bookId: B, chapterId: C, sceneId: S },
                action: 'REGENERATE_MISSING_ASSET',
                reason: 'AUDIO_READY but no audio file',
                safeToExecute: true,
            };
            const result = await reconciler.applyFix(redis, fix);
            expect(result.success).to.equal(false);
            expect(result.details).to.include('cancelled');
            expect(await activeScenes()).to.have.length(0);
        });

        it('a legitimate new generation (tombstone cleared) is not blocked', async () => {
            await seedGhost(S, { active: false });
            pgState.cancelledBooks.add(B);
            await redis.set(CANCEL_FLAG_KEY, 'true');

            // new generation B: the regenerate path clears tombstone + flag
            await cancelRepoStub.clear(B);
            await sceneWindow.clearCancelFlag(redis, B);

            const fix = {
                scene: { bookId: B, chapterId: C, sceneId: S },
                action: 'REGENERATE_MISSING_ASSET',
                reason: 'AUDIO_READY but no audio file',
                safeToExecute: true,
            };
            const result = await reconciler.applyFix(redis, fix);
            expect(result.success).to.equal(true);
            expect(await activeScenes()).to.include(`${B}:${C}:${S}`);
        });
    });

    // ======================================================
    // TEST G — canonical buildId in orphan checks
    // ======================================================
    describe('G. buildId fix in orphan audio/image checks', () => {
        it('resolveBookBuildId returns the manifest build_id, not default', () => {
            expect(reconciler.resolveBookBuildId(B)).to.equal(BUILD);
            expect(reconciler.resolveBookBuildId('unknown-book')).to.equal('default');
        });

        it('checkOrphanAudioState uses the real build dir: file exists → no orphan', async () => {
            await redis.hset(ASSET_STATE_KEY, 'audio', 'ready');
            createAudioFile(BUILD);
            const result = await reconciler.checkOrphanAudioState(redis, B, C, S);
            expect(result).to.equal(null);
        });

        it('checkOrphanAudioState: file missing in the real build dir → orphan', async () => {
            await redis.hset(ASSET_STATE_KEY, 'audio', 'ready');
            // no file created
            const result = await reconciler.checkOrphanAudioState(redis, B, C, S);
            expect(result).to.exist;
            expect(result.type).to.equal('orphan_audio_state');
            // the old bug: detection went to buildId='default' and false-flagged
            // every book with a real build directory
            expect(result.missingFile).to.include(BUILD);
            expect(result.missingFile).to.not.include(`${path.sep}default${path.sep}`);
        });

        it('checkOrphanImageState probes the manifest build_id', async () => {
            await redis.hset(ASSET_STATE_KEY, 'image', 'ready');
            imageProbe.filePresent = true;
            const ok = await reconciler.checkOrphanImageState(redis, B, C, S);
            expect(ok).to.equal(null);
            imageProbe.filePresent = false;
            const orphan = await reconciler.checkOrphanImageState(redis, B, C, S);
            expect(orphan?.type).to.equal('orphan_image_state');
            expect(imageProbe.calls.length).to.be.greaterThan(0);
            for (const call of imageProbe.calls) {
                expect(call.buildId, 'probe must use the canonical build_id').to.equal(BUILD);
            }
        });
    });
});
