// ======================================================
// Option E — WORK_TO_DO rebuild integration test (real PG + real FS)
// ======================================================
// Cathedral Recon #4 design proof → implementation. Proves that after a total
// Redis loss the startup reconcileCycle phase C7:
//   - materializes per-asset Redis states from PG + FS (NOT trusting Redis),
//   - SADD's only scenes that need work into the active index,
//   - skips cancelled (tombstoned) books fail-closed,
//   - respects disabled layers (never writes PENDING for a disabled layer —
//     the isInFlight override in shouldScheduleAssets would dispatch it),
//   - never touches fully-valid scenes (no duplicate generation),
//   - dispatches NOTHING itself — generation stays owned by the normal
//     scheduler (tick), verified via shouldScheduleAssets.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockRedis } = require('./mocks/redis-mock');
// NOTE: these are `let` and re-required inside before() AFTER purgeMockedModules().
// Earlier test files (happy-path.test.js replaces the config module in
// require.cache with a stub; scope-slide.test.js deletes it entirely) leave
// require.cache in a state where the module instances captured at top-level
// load time are NOT the instances Phase C7's lazy requires will get at call
// time. Re-requiring here binds the test to the SAME instances the real
// rebuildWorkList uses, so config.BOOKS_DIR/OUTPUT_DIR mutations are visible.
let config = require('../src/config/runtime-config');
let postgres = require('../src/storage/postgres');
let reconciliation = require('../src/runtime/reconciliation-engine');
let runtimeScheduler = require('../src/runtime/runtime-scheduler');
let state = require('../src/state');
let generationCancelRepo = require('../src/storage/postgres/repositories/generation-cancel-repo');

// ── require.cache purge (runs in before(), see below) ──
// reconciliation-engine.test.js (alphabetically earlier: 'r' < 'w') replaces
// these modules in require.cache with mocks in mockDeps() (per-test beforeEach)
// and never restores them. Mocha loads ALL test files BEFORE running any tests,
// so a top-level purge would be a no-op — the mocks are installed only when the
// other suite actually runs. Purging in our before() hook (which executes AFTER
// that suite finished) makes the real modules load again for Phase C7's lazy
// requires, so storage.postgres.query and state are the real ones.
// ⚠️ ORDER-DEPENDENT ISOLATION WORKAROUND — read before adding test files.
// This file sorts alphabetically LAST among today's tests ('w' > 'v'). The purge
// below is safe ONLY because no test file loads after this one. If a new file is
// added that sorts later, deleting src/config/runtime-config.js here would change
// what that later file loads. The durable fix is in happy-path.test.js and
// scope-slide.test.js (restore require.cache[runtime-config] after stubbing) —
// revisit this workaround if the test corpus grows past 'w'.
//
// Why the purge exists: happy-path.test.js (alphabetically earlier) temporarily
// replaces require.cache for src/config/runtime-config with a stub; any module
// first required inside that window captures the STUB as its module-scope
// `config` const — and restoring the cache entry does NOT undo that captured
// reference. book/scene-window then read a stale BOOKS_DIR/OUTPUT_DIR forever.
// scope-slide.test.js additionally DELETES runtime-config from the cache, so the
// module instances captured at this file's top-level load time are not the ones
// Phase C7's lazy requires get at call time. Purging + re-binding here makes the
// test use the SAME instances rebuildWorkList uses, so config mutations apply.
const MOCKED_PATHS = [
    'src/state/index.js',
    'src/storage/index.js',
    'src/image/index.js',
    'src/services/audio-orchestrator.js',
    'src/orchestration/orchestrator.js',
    'src/orchestration/event-journal.js',
    'src/runtime/reconciliation-engine.js',
    'src/runtime/runtime-scheduler.js',
    'src/book/index.js',
    'src/runtime/scene-window.js',
    'src/services/layer-config.js',
    'src/services/placeholder-audio.js',
    'src/config/runtime-config.js',
];
function purgeMockedModules() {
    for (const rel of MOCKED_PATHS) {
        try {
            delete require.cache[require.resolve(path.join(__dirname, '..', rel))];
        } catch (_) { /* not in cache */ }
    }
}

const CHAPTER = 'ch-000001';
const SCENE = 'sc-000001';

const TEST_BOOKS = ['wl-half', 'wl-valid', 'wl-cancelled', 'wl-disabled', 'wl-stale', 'wl-gen', 'wl-c0', 'wl-units', 'wl-failed', 'wl-pending', 'wl-toc'];

async function insertScene(bookId, chapterId = CHAPTER, sceneId = SCENE, contentVersion = 1, audioCfgVersion = 1, dirtyUnitIds = null, isDirty = false) {
    await postgres.query(
        `INSERT INTO scenes (book_id, chapter_id, scene_id, content_version, audio_config_version, dirty_unit_ids, is_dirty)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (book_id, chapter_id, scene_id) DO NOTHING`,
        [bookId, chapterId, sceneId, contentVersion, audioCfgVersion, dirtyUnitIds || [], isDirty]
    );
}

async function insertAsset(bookId, assetType, { status = 'ready', buildId = 'b1', contentVersion = 1, audioCfgVersion = 1 } = {}) {
    await postgres.query(
        `INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, status, path, build_id,
                                   scene_content_version, scene_audio_config_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (book_id, chapter_id, scene_id, asset_type, build_id) DO UPDATE SET status = EXCLUDED.status`,
        [bookId, CHAPTER, SCENE, assetType, status, `/tmp/x/${bookId}_${CHAPTER}_${SCENE}.${assetType === 'image' ? 'png' : assetType === 'video' ? 'mp4' : 'mp3'}`, buildId,
         contentVersion, audioCfgVersion]
    );
}

describe('Option E — WORK_TO_DO rebuild through real reconcileCycle (real PG + FS)', function () {
    this.timeout(30000);

    let tmpBooks;
    let tmpOut;
    let savedBooksDir;
    let savedOutDir;
    let redis;

    before(async () => {
        purgeMockedModules(); // must run AFTER the mocking test-suite finished
        // Re-bind every module the test uses to the fresh instances that Phase C7
        // will lazily require — see the top-of-file comment.
        config = require('../src/config/runtime-config');
        postgres = require('../src/storage/postgres');
        reconciliation = require('../src/runtime/reconciliation-engine');
        runtimeScheduler = require('../src/runtime/runtime-scheduler');
        state = require('../src/state');
        generationCancelRepo = require('../src/storage/postgres/repositories/generation-cancel-repo');
        await postgres.initialize();
    });

    beforeEach(() => {
        tmpBooks = fs.mkdtempSync(path.join(os.tmpdir(), 'animastor-wl-books-'));
        tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'animastor-wl-out-'));
        savedBooksDir = config.BOOKS_DIR;
        savedOutDir = config.OUTPUT_DIR;
        config.BOOKS_DIR = tmpBooks;
        config.OUTPUT_DIR = tmpOut;
        redis = createMockRedis();
    });

    afterEach(async () => {
        for (const bookId of TEST_BOOKS) {
            await postgres.query('DELETE FROM generation_cancellations WHERE book_id = $1', [bookId]);
            await postgres.query('DELETE FROM scene_assets WHERE book_id = $1', [bookId]);
            await postgres.query('DELETE FROM scenes WHERE book_id = $1', [bookId]);
        }
        config.BOOKS_DIR = savedBooksDir;
        config.OUTPUT_DIR = savedOutDir;
        fs.rmSync(tmpBooks, { recursive: true, force: true });
        fs.rmSync(tmpOut, { recursive: true, force: true });
    });

    function writeBook(bookId, buildId = 'b1') {
        const bookDir = path.join(tmpBooks, bookId);
        fs.mkdirSync(path.join(bookDir, 'chapters'), { recursive: true });
        fs.writeFileSync(path.join(bookDir, 'manifest.json'), JSON.stringify({ book_id: bookId, build_id: buildId }));
        fs.writeFileSync(path.join(bookDir, 'book.json'), JSON.stringify({
            structure: { chapters_order: [`${CHAPTER}.json`] },
        }));
        fs.writeFileSync(path.join(bookDir, 'chapters', `${CHAPTER}.json`), JSON.stringify({
            chapter_id: CHAPTER,
            scenes: [{ scene_id: SCENE, type: 'narration' }],
        }));
        return bookDir;
    }

    function writeArtifact(bookId, kind) {
        const buildDir = path.join(tmpOut, 'b1');
        fs.mkdirSync(buildDir, { recursive: true });
        const files = {
            audio: `${bookId}_${CHAPTER}_${SCENE}.mp3`,
            image: `${bookId}_${CHAPTER}_${SCENE}_iu-000001.png`,
            video: `${bookId}_${CHAPTER}_${SCENE}.mp4`,
        };
        fs.writeFileSync(path.join(buildDir, files[kind]), 'x');
    }

    async function assetStates(bookId) {
        return state.getAssetStates(redis, bookId, CHAPTER, SCENE);
    }

    const activeScenes = async () => redis.smembers('animastor:active-scenes');

    it('half-generated scene (audio valid, image/video missing) is materialized and re-added', async () => {
        writeBook('wl-half');
        writeArtifact('wl-half', 'audio');
        await insertScene('wl-half');
        await insertAsset('wl-half', 'audio', { status: 'ready' }); // real audio (PG ready)

        const result = await reconciliation.reconcileCycle(redis, {}, { startup: true });

        expect(result.ok).to.be.true;
        expect(result.phases).to.include('worklist_rebuild:1');
        expect(await activeScenes()).to.deep.equal(['wl-half:ch-000001:sc-000001']);

        const states = await assetStates('wl-half');
        expect(states.audio).to.equal('ready');   // valid on disk — NOT re-dispatched
        expect(states.image).to.equal('pending'); // missing — resumed
        expect(states.video).to.equal('pending'); // missing — resumed (scheduler gates on image)
    });

    it('C7 is idempotent — a second startup cycle changes nothing', async () => {
        writeBook('wl-half');
        writeArtifact('wl-half', 'audio');
        await insertScene('wl-half');
        await insertAsset('wl-half', 'audio', { status: 'ready' });

        await reconciliation.reconcileCycle(redis, {}, { startup: true });
        const states1 = await assetStates('wl-half');
        const active1 = await activeScenes();

        // Second startup cycle: SADD no-op, state writes idempotent.
        const result2 = await reconciliation.reconcileCycle(redis, {}, { startup: true });

        expect(result2.ok).to.be.true;
        expect(result2.phases).to.include('worklist_rebuild:1');
        expect(await activeScenes()).to.deep.equal(active1);
        expect(await assetStates('wl-half')).to.deep.equal(states1);
    });

    it('fully-valid scene is NOT re-added (no duplicate generation)', async () => {
        writeBook('wl-valid');
        writeArtifact('wl-valid', 'audio');
        writeArtifact('wl-valid', 'image');
        writeArtifact('wl-valid', 'video');
        await insertScene('wl-valid');
        await insertAsset('wl-valid', 'audio');
        await insertAsset('wl-valid', 'image');
        await insertAsset('wl-valid', 'video');

        const result = await reconciliation.reconcileCycle(redis, {}, { startup: true });

        expect(result.phases).to.not.include('worklist_rebuild:1');
        expect(await activeScenes()).to.deep.equal([]);
    });

    it('cancelled (tombstoned) book is skipped fail-closed — no resurrection', async () => {
        writeBook('wl-cancelled'); // no artifacts — would need work if not cancelled
        await insertScene('wl-cancelled');
        await generationCancelRepo.setCancelled('wl-cancelled', { reason: 'user_cancelled' });

        const result = await reconciliation.reconcileCycle(redis, {}, { startup: true });

        expect(result.ok).to.be.true;
        expect(result.phases).to.not.include('worklist_rebuild:1');
        expect(await activeScenes()).to.deep.equal([]);
        const states = await assetStates('wl-cancelled');
        expect(states.audio).to.equal('new'); // untouched — no resurrection
    });

    it('disabled layer is never set PENDING (isInFlight override would dispatch it)', async () => {
        writeBook('wl-disabled'); // no artifacts at all
        await insertScene('wl-disabled');
        // image_enabled=false (audio + video enabled). C6 would restore from
        // book.json, but simulate the durable key being present already.
        await redis.set('animastor:layer-config:wl-disabled', JSON.stringify({
            audio_enabled: true, image_enabled: false, video_enabled: true,
        }));

        const result = await reconciliation.reconcileCycle(redis, {}, { startup: true });

        expect(result.phases).to.include('worklist_rebuild:1');
        const states = await assetStates('wl-disabled');
        expect(states.audio).to.equal('pending');
        expect(states.image).to.equal('new');     // disabled — NOT pending
        expect(states.video).to.equal('pending');
        expect(await activeScenes()).to.deep.equal(['wl-disabled:ch-000001:sc-000001']);

        // End-to-end: the scheduler would dispatch EXACTLY audio now (video waits
        // for image=ready which is disabled+missing → blocked by existing logic).
        const plan = await runtimeScheduler.shouldScheduleAssets(redis, 'wl-disabled', CHAPTER, SCENE);
        expect(plan.stages).to.deep.equal(['audio']);
    });

    it('version-stale ready asset is re-dispatched (PENDING, not trusted as valid)', async () => {
        writeBook('wl-stale');
        writeArtifact('wl-stale', 'audio'); // file exists, but PG says content_version bumped
        await insertScene('wl-stale', CHAPTER, SCENE, 2, 1); // content_version=2
        await insertAsset('wl-stale', 'audio', { status: 'ready', contentVersion: 1 }); // stale (1 < 2)

        const result = await reconciliation.reconcileCycle(redis, {}, { startup: true });

        expect(result.phases).to.include('worklist_rebuild:1');
        const states = await assetStates('wl-stale');
        expect(states.audio).to.equal('pending'); // stale despite valid-looking file
        expect(await activeScenes()).to.deep.equal(['wl-stale:ch-000001:sc-000001']);
    });

    // ── Audit gap 1: safe state materialization ────────────────────────────
    it('GENERATING stage is NEVER downgraded to PENDING by recovery', async () => {
        writeBook('wl-gen');
        writeArtifact('wl-gen', 'audio');
        await insertScene('wl-gen');
        await insertAsset('wl-gen', 'audio', { status: 'ready' });
        // Simulate a worker mid-flight: image = GENERATING, no file on disk yet.
        await redis.hset('animastor:asset-state:wl-gen:ch-000001:sc-000001', 'image', 'generating');

        const result = await reconciliation.reconcileCycle(redis, {}, { startup: true });

        expect(result.ok).to.be.true;
        const states = await assetStates('wl-gen');
        // In-flight generation must be left untouched — recovery has no right to
        // downgrade GENERATING → PENDING (audit gap 1).
        expect(states.image).to.equal('generating');
        expect(states.audio).to.equal('ready');
        expect(states.video).to.equal('pending'); // missing → resumed
    });

    it('C0 over-mark (READY with no file) is self-healed via valid transitions READY→DIRTY→PENDING', async () => {
        writeBook('wl-c0');
        writeArtifact('wl-c0', 'audio');
        await insertScene('wl-c0');
        await insertAsset('wl-c0', 'audio', { status: 'ready' });
        // C0 quirk (Recon #2 P1): sets ALL THREE to READY even though image/video
        // have no files on disk.
        await redis.hset('animastor:asset-state:wl-c0:ch-000001:sc-000001',
            { audio: 'ready', image: 'ready', video: 'ready' });

        const result = await reconciliation.reconcileCycle(redis, {}, { startup: true });

        expect(result.ok).to.be.true;
        const states = await assetStates('wl-c0');
        // The work-set decision is PG+FS based, not Redis based → image/video
        // missing files must be PENDING despite C0's over-marking.
        expect(states.image).to.equal('pending');
        expect(states.video).to.equal('pending');
        expect(states.audio).to.equal('ready');
        expect(await activeScenes()).to.deep.equal(['wl-c0:ch-000001:sc-000001']);
    });

    it('TOCTOU: concurrent tick dispatching image between guard-read and write is NEVER overwritten (fresh-state check)', async () => {
        writeBook('wl-toc');
        writeArtifact('wl-toc', 'audio');
        await insertScene('wl-toc');
        await insertAsset('wl-toc', 'audio', { status: 'ready' });
        // C0 over-mark (P1): all three READY, but image/video have no files →
        // the predicate wants image PENDING. Simulate the exact TOCTOU the
        // scheduler tick can produce: it runs concurrently with the startup
        // cycle (runtime.loop.start() happens BEFORE reconcileCycle in
        // backend.cjs), and markVersionStaleDirty → dispatch can set GENERATING
        // between C7's guard-read and its state write. The rebuild's
        // markDirtyScene would otherwise overwrite GENERATING → DIRTY via
        // unsafeRestoreAssetState without re-validation.
        await redis.hset('animastor:asset-state:wl-toc:ch-000001:sc-000001',
            { audio: 'ready', image: 'ready', video: 'ready' });

        const origGet = state.getAssetStates;
        let guardRead = false;
        state.getAssetStates = async (...args) => {
            const [r, bookId, chapterId, sceneId] = args;
            const res = await origGet.apply(state, args);
            if (bookId === 'wl-toc') {
                // 1st call = C7's guard-read; 2nd call = the two-step's fresh
                // re-read for image. On the 2nd, simulate the concurrent tick
                // having just dispatched image (GENERATING) in real Redis.
                if (!guardRead) {
                    guardRead = true;
                } else {
                    await redis.hset(`animastor:asset-state:${bookId}:${chapterId}:${sceneId}`, 'image', 'generating');
                    return { ...res, image: 'generating' };
                }
            }
            return res;
        };

        try {
            const added = await reconciliation.rebuildWorkList(redis);
            expect(added).to.equal(1);
            const states = await origGet.apply(state, [redis, 'wl-toc', CHAPTER, SCENE]);
            // In-flight generation won the race → recovery must leave it untouched.
            expect(states.image).to.equal('generating');
            // Video had no concurrent racer → still self-healed via the valid
            // READY → DIRTY → PENDING bridge.
            expect(states.video).to.equal('pending');
            expect(states.audio).to.equal('ready');
        } finally {
            state.getAssetStates = origGet;
        }
    });

    it('PLACEHOLDER audio with NO real file is moved to PENDING via DIRTY (valid transition)', async () => {
        writeBook('wl-c0');
        await insertScene('wl-c0');
        // No real audio artifact on disk — predicate says audio needs work.
        await redis.hset('animastor:asset-state:wl-c0:ch-000001:sc-000001', 'audio', 'placeholder');

        const result = await reconciliation.reconcileCycle(redis, {}, { startup: true });

        expect(result.ok).to.be.true;
        const states = await assetStates('wl-c0');
        // PLACEHOLDER → PENDING is not a direct transition; the facade bridge is
        // PLACEHOLDER → DIRTY → PENDING.
        expect(states.audio).to.equal('pending');
    });

    // ── Audit gap 2: dirty markers must influence WORK_TO_DO ───────────────
    it('dirty_unit_ids forces image regeneration despite a valid-looking file', async () => {
        writeBook('wl-units');
        writeArtifact('wl-units', 'image'); // file exists and looks valid
        await insertScene('wl-units', CHAPTER, SCENE, 1, 1, ['iu-000001']); // dirty_unit_ids
        await insertAsset('wl-units', 'image', { status: 'ready', contentVersion: 1 });

        const result = await reconciliation.reconcileCycle(redis, {}, { startup: true });

        expect(result.ok).to.be.true;
        const states = await assetStates('wl-units');
        // dirty_unit_ids = granular force-regen intent — a valid-looking file must
        // NOT suppress it (audit gap 2).
        expect(states.image).to.equal('pending');
        expect(await activeScenes()).to.deep.equal(['wl-units:ch-000001:sc-000001']);
    });

    it('scene_assets status=failed forces re-dispatch despite leftover file', async () => {
        writeBook('wl-failed');
        writeArtifact('wl-failed', 'video'); // leftover from an old build
        await insertScene('wl-failed');
        await insertAsset('wl-failed', 'video', { status: 'failed' }); // PG says failed

        const result = await reconciliation.reconcileCycle(redis, {}, { startup: true });

        expect(result.ok).to.be.true;
        const states = await assetStates('wl-failed');
        // A 'failed' PG row is regeneration intent — must not be treated as ready
        // just because a leftover file exists (audit gap 2).
        expect(states.video).to.equal('pending');
        expect(await activeScenes()).to.deep.equal(['wl-failed:ch-000001:sc-000001']);
    });

    it('scene_assets status=pending forces re-dispatch despite leftover file', async () => {
        writeBook('wl-pending');
        writeArtifact('wl-pending', 'image'); // leftover
        await insertScene('wl-pending');
        await insertAsset('wl-pending', 'image', { status: 'pending' });

        const result = await reconciliation.reconcileCycle(redis, {}, { startup: true });

        expect(result.ok).to.be.true;
        const states = await assetStates('wl-pending');
        expect(states.image).to.equal('pending');
        expect(await activeScenes()).to.deep.equal(['wl-pending:ch-000001:sc-000001']);
    });

    // ── Audit gap 3: disabled-layer semantics via REAL shouldScheduleAssets ──
    it('absent Redis state for a disabled layer NEVER becomes NEW → dispatch (real call graph)', async () => {
        writeBook('wl-disabled');
        await insertScene('wl-disabled');
        await redis.set('animastor:layer-config:wl-disabled', JSON.stringify({
            audio_enabled: true, image_enabled: false, video_enabled: true,
        }));
        // Deliberately do NOT write any asset state for image — absent key.
        // shouldScheduleAssets: imageEnabled = layerCfg.image_enabled !== false ||
        // isInFlight(state) = false || isInFlight('new') = false → never dispatched.
        const plan = await runtimeScheduler.shouldScheduleAssets(redis, 'wl-disabled', CHAPTER, SCENE);
        expect(plan.stages).to.not.include('image');
        // audio is dispatched; video is gated on image=ready (image disabled+missing → blocked)
        expect(plan.stages).to.include('audio');
    });

    it('disabled layer with PENDING state WOULD dispatch (isInFlight override) — proof C7 must never write PENDING for it', async () => {
        writeBook('wl-disabled');
        await insertScene('wl-disabled');
        await redis.set('animastor:layer-config:wl-disabled', JSON.stringify({
            audio_enabled: true, image_enabled: false, video_enabled: true,
        }));
        // Hypothetical: if C7 wrote PENDING for the disabled layer, isInFlight
        // would flip imageEnabled to true and the scheduler WOULD dispatch it.
        await redis.hset('animastor:asset-state:wl-disabled:ch-000001:sc-000001', 'image', 'pending');

        const plan = await runtimeScheduler.shouldScheduleAssets(redis, 'wl-disabled', CHAPTER, SCENE);
        expect(plan.stages).to.include('image'); // isInFlight override proves the danger

        // And C7 must never produce that state: run the real cycle on a fresh book.
        const result = await reconciliation.reconcileCycle(redis, {}, { startup: true });
        expect(result.ok).to.be.true;
    });
});
