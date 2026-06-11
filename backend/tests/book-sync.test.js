const { expect } = require('chai');
const book = require('../src/book');

const TEST_BOOK_ID = 'test-book-phaseB-sync';

function buildBook({ bookId, chapters }) {
    return {
        manifest: { book_id: bookId, vbook_version: '3.1' },
        book: { book_id: bookId, title: bookId, structure: { chapters_order: [] } },
        bible: { version: '3.0' },
        characters: [],
        chapters,
    };
}

describe('Book Sync (Phase B.3)', () => {
    let bookSync;
    let sceneAssetRegistry;
    const taskRepo = () => require('../src/storage/postgres/repositories/task-repo');
    const query = () => require('../src/storage/postgres/database').query;

    before(async () => {
        const postgres = require('../src/storage/postgres');
        await postgres.initialize();
        bookSync = require('../src/services/book-sync');
        sceneAssetRegistry = require('../src/services/scene-asset-registry');
        book.resetBook(TEST_BOOK_ID);
    });

    afterEach(async () => {
        await query()(`DELETE FROM scene_assets WHERE book_id = $1`, [TEST_BOOK_ID]);
        await query()(`DELETE FROM generation_tasks WHERE book_id = $1`, [TEST_BOOK_ID]);
        await query()(`DELETE FROM image_units WHERE book_id = $1`, [TEST_BOOK_ID]);
        await query()(`DELETE FROM scenes WHERE book_id = $1`, [TEST_BOOK_ID]);
        book.resetBook(TEST_BOOK_ID);
    });

    function saveFixture(chapters) {
        book.resetBook(TEST_BOOK_ID);
        book.saveBookBundle(buildBook({ bookId: TEST_BOOK_ID, chapters }), null);
    }

    it('detectChangedScenes reports added when first seen', async () => {
        saveFixture([{ chapter: 'ch-1', scenes: [{ scene_id: 'sc-1' }] }]);
        const diff = await bookSync.detectChangedScenes(TEST_BOOK_ID);
        expect(diff.added).to.have.length(1);
        expect(diff.changed).to.have.length(0);
        expect(diff.removed).to.have.length(0);
    });

    it('detectChangedScenes reports changed when hash drifts', async () => {
        saveFixture([{ chapter: 'ch-1', scenes: [{ scene_id: 'sc-1', text: 'a' }] }]);
        await bookSync.syncBook(TEST_BOOK_ID);

        saveFixture([{ chapter: 'ch-1', scenes: [{ scene_id: 'sc-1', text: 'b' }] }]);
        const diff = await bookSync.detectChangedScenes(TEST_BOOK_ID);
        expect(diff.added).to.have.length(0);
        expect(diff.changed).to.have.length(1);
        expect(diff.changed[0].old_hash).to.not.equal(diff.changed[0].new_hash);
    });

    it('detectChangedScenes reports removed when scene deleted from JSON', async () => {
        saveFixture([{ chapter: 'ch-1', scenes: [{ scene_id: 'sc-1' }, { scene_id: 'sc-2' }] }]);
        await bookSync.syncBook(TEST_BOOK_ID);

        saveFixture([{ chapter: 'ch-1', scenes: [{ scene_id: 'sc-1' }] }]);
        const diff = await bookSync.detectChangedScenes(TEST_BOOK_ID);
        expect(diff.removed).to.have.length(1);
        expect(diff.removed[0].chapter_scene).to.equal('ch-1::sc-2');
    });

    it('syncBook persists hashes for new scenes', async () => {
        saveFixture([{ chapter: 'ch-1', scenes: [{ scene_id: 'sc-1' }, { scene_id: 'sc-2' }] }]);
        const r = await bookSync.syncBook(TEST_BOOK_ID);
        expect(r.added).to.equal(2);

        const stored = await query()(
            `SELECT scene_id, scene_hash FROM scenes WHERE book_id = $1 ORDER BY scene_id`,
            [TEST_BOOK_ID]
        );
        expect(stored.rows).to.have.length(2);
        for (const row of stored.rows) {
            expect(row.scene_hash).to.have.length(64);
        }
    });

    it('syncBook marks assets stale for changed scenes', async () => {
        saveFixture([{ chapter: 'ch-1', scenes: [{ scene_id: 'sc-1', text: 'a' }] }]);
        await bookSync.syncBook(TEST_BOOK_ID);
        await sceneAssetRegistry.registerSceneAudio(TEST_BOOK_ID, 'ch-1', 'sc-1', {
            canonicalPath: '/tmp/x.mp3', duration: 1, buildId: 'b1',
        });

        saveFixture([{ chapter: 'ch-1', scenes: [{ scene_id: 'sc-1', text: 'b' }] }]);

        const r = await bookSync.syncBook(TEST_BOOK_ID);
        expect(r.changed).to.equal(1);
        expect(r.assets_marked_stale).to.equal(1);

        const after = await sceneAssetRegistry.getAudioAsset(TEST_BOOK_ID, 'ch-1', 'sc-1');
        expect(after.status).to.equal('stale');
    });

    it('syncBook cancels running generation_tasks for changed scenes', async () => {
        saveFixture([{ chapter: 'ch-1', scenes: [{ scene_id: 'sc-1', text: 'a' }] }]);
        await bookSync.syncBook(TEST_BOOK_ID);
        await taskRepo().createTask('t1', TEST_BOOK_ID, 'ch-1', 'sc-1', 'audio');
        await taskRepo().updateTaskStatus('t1', 'running');

        saveFixture([{ chapter: 'ch-1', scenes: [{ scene_id: 'sc-1', text: 'b' }] }]);
        const r = await bookSync.syncBook(TEST_BOOK_ID);
        expect(r.generation_tasks_cancelled).to.equal(1);

        const after = await taskRepo().getSceneTasks(TEST_BOOK_ID, 'ch-1', 'sc-1');
        expect(after[0].status).to.equal('cancelled');
    });

    it('syncBook purges DB rows for scenes removed from JSON', async () => {
        saveFixture([{ chapter: 'ch-1', scenes: [{ scene_id: 'sc-1' }, { scene_id: 'sc-2' }] }]);
        await bookSync.syncBook(TEST_BOOK_ID);
        await sceneAssetRegistry.registerSceneAudio(TEST_BOOK_ID, 'ch-1', 'sc-2', {
            canonicalPath: '/tmp/y.mp3', duration: 1, buildId: 'b1',
        });
        await taskRepo().createTask('t2', TEST_BOOK_ID, 'ch-1', 'sc-2', 'audio');

        saveFixture([{ chapter: 'ch-1', scenes: [{ scene_id: 'sc-1' }] }]);
        const r = await bookSync.syncBook(TEST_BOOK_ID);
        expect(r.removed).to.equal(1);
        expect(r.purged.scene_assets).to.be.gte(1);
        expect(r.purged.generation_tasks).to.be.gte(1);

        const after = await query()(
            `SELECT count(*)::int as c FROM scenes WHERE book_id = $1 AND scene_id = 'sc-2'`,
            [TEST_BOOK_ID]
        );
        expect(after.rows[0].c).to.equal(0);
    });

    it('dryRun reports counts without modifying DB', async () => {
        saveFixture([{ chapter: 'ch-1', scenes: [{ scene_id: 'sc-1' }] }]);
        const r = await bookSync.syncBook(TEST_BOOK_ID, { dryRun: true });
        expect(r.dry_run).to.be.true;

        const stored = await query()(
            `SELECT count(*)::int as c FROM scenes WHERE book_id = $1`, [TEST_BOOK_ID]
        );
        expect(stored.rows[0].c).to.equal(0);
    });

    it('purgeRemoved=false keeps removed-scene rows', async () => {
        saveFixture([{ chapter: 'ch-1', scenes: [{ scene_id: 'sc-1' }, { scene_id: 'sc-2' }] }]);
        await bookSync.syncBook(TEST_BOOK_ID);
        await sceneAssetRegistry.registerSceneAudio(TEST_BOOK_ID, 'ch-1', 'sc-2', {
            canonicalPath: '/tmp/z.mp3', duration: 1, buildId: 'b1',
        });

        saveFixture([{ chapter: 'ch-1', scenes: [{ scene_id: 'sc-1' }] }]);
        const r = await bookSync.syncBook(TEST_BOOK_ID, { purgeRemoved: false });
        expect(r.removed).to.equal(1);
        expect(Object.keys(r.purged).length).to.equal(0);
    });
});
