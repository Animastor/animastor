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

const TEST_BOOKS = ['wl-half', 'wl-valid', 'wl-cancelled', 'wl-disabled', 'wl-stale'];

async function insertScene(bookId, chapterId = CHAPTER, sceneId = SCENE, contentVersion = 1, audioCfgVersion = 1) {
    await postgres.query(
        `INSERT INTO scenes (book_id, chapter_id, scene_id, content_version, audio_config_version, dirty_unit_ids)
         VALUES ($1, $2, $3, $4, $5, '{}')
         ON CONFLICT (book_id, chapter_id, scene_id) DO NOTHING`,
        [bookId, chapterId, sceneId, contentVersion, audioCfgVersion]
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
});
