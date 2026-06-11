const { expect } = require('chai');
const book = require('../src/book');

const TEST_BOOK_ID = 'test-book-phaseB-integrity';

function buildBook({ bookId, chapters }) {
    return {
        manifest: { book_id: bookId, vbook_version: '3.1' },
        book: { book_id: bookId, title: bookId, structure: { chapters_order: [] } },
        bible: { version: '3.0' },
        characters: [],
        chapters,
    };
}

describe('Book Integrity (Phase B.2)', () => {
    let bookIntegrity;
    let sceneAssetRegistry;
    const chReal = 'ch-real';
    const chOrphan = 'ch-orphan';

    before(async () => {
        const postgres = require('../src/storage/postgres');
        await postgres.initialize();
        bookIntegrity = require('../src/services/book-integrity');
        sceneAssetRegistry = require('../src/services/scene-asset-registry');
        book.resetBook(TEST_BOOK_ID);
        await bookIntegrity.purgeOrphans(TEST_BOOK_ID, { dryRun: false });
    });

    afterEach(async () => {
        await bookIntegrity.purgeOrphans(TEST_BOOK_ID, { dryRun: false });
        book.resetBook(TEST_BOOK_ID);
    });

    it('report for book with no JSON present flags book_json_missing', async () => {
        await bookIntegrity.purgeOrphans(TEST_BOOK_ID, { dryRun: false });
        const r = await bookIntegrity.generateIntegrityReport(TEST_BOOK_ID);
        expect(r.book_json_present).to.be.false;
        expect(r.orphans).to.equal('book_json_missing');
    });

    it('report for book with JSON but no DB rows shows zero counts', async () => {
        book.resetBook(TEST_BOOK_ID);
        book.saveBookBundle(buildBook({
            bookId: TEST_BOOK_ID,
            chapters: [{ chapter: chReal, scenes: [{ scene_id: 'sc-r1' }] }],
        }), null);
        const r = await bookIntegrity.generateIntegrityReport(TEST_BOOK_ID);
        expect(r.book_json_present).to.be.true;
        expect(r.canonical_scene_count).to.equal(1);
        expect(r.orphan_total).to.equal(0);
    });

    it('detects orphan rows in scene_assets', async () => {
        book.resetBook(TEST_BOOK_ID);
        book.saveBookBundle(buildBook({
            bookId: TEST_BOOK_ID,
            chapters: [{ chapter: chReal, scenes: [{ scene_id: 'sc-r1' }] }],
        }), null);
        await sceneAssetRegistry.registerSceneAudio(TEST_BOOK_ID, chReal, 'sc-r1', {
            canonicalPath: '/tmp/r1.mp3', duration: 1, buildId: 'b1',
        });
        await sceneAssetRegistry.registerSceneAudio(TEST_BOOK_ID, chOrphan, 'sc-orphan', {
            canonicalPath: '/tmp/o1.mp3', duration: 1, buildId: 'b1',
        });

        const r = await bookIntegrity.generateIntegrityReport(TEST_BOOK_ID);
        expect(r.orphans.scene_assets).to.equal(1);
        expect(r.orphan_total).to.equal(1);

        const orphans = await bookIntegrity.getOrphansForBook(TEST_BOOK_ID);
        const audioOrphans = orphans.tables.scene_assets;
        expect(audioOrphans).to.have.length(1);
        expect(audioOrphans[0].chapter_id).to.equal(chOrphan);
        expect(audioOrphans[0].scene_id).to.equal('sc-orphan');
    });

    it('detects orphans in generation_tasks', async () => {
        const taskRepo = require('../src/storage/postgres/repositories/task-repo');
        book.resetBook(TEST_BOOK_ID);
        book.saveBookBundle(buildBook({
            bookId: TEST_BOOK_ID,
            chapters: [{ chapter: chReal, scenes: [{ scene_id: 'sc-r1' }] }],
        }), null);
        await taskRepo.createTask('t-real', TEST_BOOK_ID, chReal, 'sc-r1', 'audio');
        await taskRepo.createTask('t-orphan', TEST_BOOK_ID, chOrphan, 'sc-orphan', 'audio');

        const r = await bookIntegrity.generateIntegrityReport(TEST_BOOK_ID);
        expect(r.orphans.generation_tasks).to.equal(1);
    });

    it('purgeOrphans dry-run does not delete', async () => {
        book.resetBook(TEST_BOOK_ID);
        book.saveBookBundle(buildBook({
            bookId: TEST_BOOK_ID,
            chapters: [{ chapter: chReal, scenes: [{ scene_id: 'sc-r1' }] }],
        }), null);
        await sceneAssetRegistry.registerSceneAudio(TEST_BOOK_ID, chOrphan, 'sc-orphan', {
            canonicalPath: '/tmp/p1.mp3', duration: 1, buildId: 'b1',
        });

        const r = await bookIntegrity.purgeOrphans(TEST_BOOK_ID, { dryRun: true });
        const a = r.results.find(x => x.table === 'scene_assets');
        expect(a.dry_run).to.be.true;
        expect(a.would_delete).to.equal(1);

        const stillOrphan = await bookIntegrity.getOrphanSummary(TEST_BOOK_ID);
        expect(stillOrphan.counts.scene_assets).to.equal(1);
    });

    it('purgeOrphans actually deletes with dryRun=false', async () => {
        book.resetBook(TEST_BOOK_ID);
        book.saveBookBundle(buildBook({
            bookId: TEST_BOOK_ID,
            chapters: [{ chapter: chReal, scenes: [{ scene_id: 'sc-r1' }] }],
        }), null);
        await sceneAssetRegistry.registerSceneAudio(TEST_BOOK_ID, chOrphan, 'sc-orphan', {
            canonicalPath: '/tmp/p2.mp3', duration: 1, buildId: 'b2',
        });

        const beforeSummary = await bookIntegrity.getOrphanSummary(TEST_BOOK_ID);
        expect(beforeSummary.counts.scene_assets).to.equal(1);

        const r = await bookIntegrity.purgeOrphans(TEST_BOOK_ID, { dryRun: false });
        const a = r.results.find(x => x.table === 'scene_assets');
        expect(a.deleted).to.equal(1);
        expect(a.dry_run).to.be.false;

        const afterSummary = await bookIntegrity.getOrphanSummary(TEST_BOOK_ID);
        expect(afterSummary.counts.scene_assets).to.equal(0);
    });

    it('generateIntegrityReportAllBooks iterates all books with data', async () => {
        book.resetBook(TEST_BOOK_ID);
        book.saveBookBundle(buildBook({
            bookId: TEST_BOOK_ID,
            chapters: [{ chapter: chReal, scenes: [{ scene_id: 'sc-r1' }] }],
        }), null);
        const reports = await bookIntegrity.generateIntegrityReportAllBooks();
        expect(reports).to.be.an('array');
        const ours = reports.find(r => r.book_id === TEST_BOOK_ID);
        expect(ours).to.exist;
    });

    it('SCENE_TABLES contains the expected six tables', () => {
        expect(bookIntegrity.SCENE_TABLES.map(t => t.table))
            .to.have.members(['scene_assets', 'generation_tasks', 'image_units',
                              'storyboard_elements', 'audio_layers', 'scenes']);
    });
});
