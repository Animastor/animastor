const { expect } = require('chai');
const book = require('../src/book');

const TEST_BOOK_ID = 'test-book-phaseB-source';

function buildBook({ bookId, chapters }) {
    return {
        manifest: { book_id: bookId, vbook_version: '3.1' },
        book: { book_id: bookId, title: bookId, structure: { chapters_order: [] } },
        bible: { version: '3.0' },
        characters: [],
        chapters,
    };
}

describe('Book Source (Phase B.1)', () => {
    let bookSource;

    before(async () => {
        const postgres = require('../src/storage/postgres');
        await postgres.initialize();
        bookSource = require('../src/services/book-source');
        book.resetBook(TEST_BOOK_ID);
        book.saveBookBundle(buildBook({
            bookId: TEST_BOOK_ID,
            chapters: [
                { chapter_id: 'ch-aaa', scenes: [
                    { scene_id: 'sc-111', type: 'narration', text: 'one' },
                    { scene_id: 'sc-222', type: 'narration', text: 'two' },
                ]},
                { chapter_id: 'ch-bbb', scenes: [
                    { scene_id: 'sc-333', type: 'chapter_intro', text: 'three' },
                ]},
            ],
        }), null);
    });

    after(() => { book.resetBook(TEST_BOOK_ID); });

    it('bookJsonExists returns true for present book', () => {
        expect(bookSource.bookJsonExists(TEST_BOOK_ID)).to.be.true;
    });

    it('bookJsonExists returns false for missing book', () => {
        expect(bookSource.bookJsonExists('does-not-exist-' + Date.now())).to.be.false;
    });

    it('getCanonicalScenes returns set of all (chapter::scene) keys', () => {
        const set = bookSource.getCanonicalScenes(TEST_BOOK_ID);
        expect(set.size).to.equal(3);
        expect(set.has('ch-aaa::sc-111')).to.be.true;
        expect(set.has('ch-aaa::sc-222')).to.be.true;
        expect(set.has('ch-bbb::sc-333')).to.be.true;
    });

    it('getCanonicalChapters returns all chapter ids', () => {
        const list = bookSource.getCanonicalChapters(TEST_BOOK_ID);
        expect(list).to.have.members(['ch-aaa', 'ch-bbb']);
    });

    it('sceneExists returns true for existing scene', () => {
        expect(bookSource.sceneExists(TEST_BOOK_ID, 'ch-aaa', 'sc-111')).to.be.true;
    });

    it('sceneExists returns false for non-existent scene', () => {
        expect(bookSource.sceneExists(TEST_BOOK_ID, 'ch-aaa', 'sc-999')).to.be.false;
        expect(bookSource.sceneExists(TEST_BOOK_ID, 'ch-zzz', 'sc-111')).to.be.false;
    });

    it('chapterExists works for existing/missing chapters', () => {
        expect(bookSource.chapterExists(TEST_BOOK_ID, 'ch-aaa')).to.be.true;
        expect(bookSource.chapterExists(TEST_BOOK_ID, 'ch-zzz')).to.be.false;
    });

    it('assertSceneExists throws for missing scene with code SCENE_NOT_IN_JSON', () => {
        let err;
        try { bookSource.assertSceneExists(TEST_BOOK_ID, 'ch-aaa', 'sc-999'); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.code).to.equal('SCENE_NOT_IN_JSON');
    });

    it('assertSceneExists passes for present scene', () => {
        expect(() => bookSource.assertSceneExists(TEST_BOOK_ID, 'ch-aaa', 'sc-111')).to.not.throw();
    });

    it('assertChapterExists throws with code CHAPTER_NOT_IN_JSON', () => {
        let err;
        try { bookSource.assertChapterExists(TEST_BOOK_ID, 'ch-zzz'); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.code).to.equal('CHAPTER_NOT_IN_JSON');
    });

    it('getCanonicalScene returns the scene payload', () => {
        const s = bookSource.getCanonicalScene(TEST_BOOK_ID, 'ch-aaa', 'sc-111');
        expect(s).to.not.be.null;
        expect(s.scene_id).to.equal('sc-111');
        expect(s.chapter_id).to.equal('ch-aaa');
    });

    it('getCanonicalScene returns null for missing scene', () => {
        expect(bookSource.getCanonicalScene(TEST_BOOK_ID, 'ch-aaa', 'sc-999')).to.be.null;
    });

    it('listScenes returns flat list of all scenes', () => {
        const list = bookSource.listScenes(TEST_BOOK_ID);
        expect(list).to.have.length(3);
    });

    it('listChapters returns chapter summary', () => {
        const list = bookSource.listChapters(TEST_BOOK_ID);
        expect(list).to.have.length(2);
        expect(list[0]).to.have.property('chapter_id');
        expect(list[0]).to.have.property('scene_count');
    });

    it('walkScenes iterates every scene', () => {
        const ids = [];
        bookSource.walkScenes(TEST_BOOK_ID, (s) => { ids.push(s.scene_id); });
        expect(ids.sort()).to.deep.equal(['sc-111', 'sc-222', 'sc-333']);
    });

    it('walkScenes can be stopped with return false', () => {
        const ids = [];
        bookSource.walkScenes(TEST_BOOK_ID, (s) => {
            ids.push(s.scene_id);
            if (ids.length === 1) return false;
        });
        expect(ids).to.have.length(1);
    });

    it('getBookFingerprint returns hashes for all scenes', () => {
        const fp = bookSource.getBookFingerprint(TEST_BOOK_ID);
        expect(fp.size).to.equal(3);
        for (const hash of fp.values()) {
            expect(hash).to.have.length(64);
        }
    });

    it('getSceneHash returns a 64-char hex for a valid scene', () => {
        const h = bookSource.getSceneHash(TEST_BOOK_ID, 'ch-aaa', 'sc-111');
        expect(h).to.have.length(64);
    });

    it('getSceneHash returns null for a missing scene', () => {
        expect(bookSource.getSceneHash(TEST_BOOK_ID, 'ch-aaa', 'sc-999')).to.be.null;
    });

    it('hash is invariant under JSON re-save with same content', () => {
        const h1 = bookSource.getSceneHash(TEST_BOOK_ID, 'ch-aaa', 'sc-111');
        book.saveBookBundle(buildBook({
            bookId: TEST_BOOK_ID,
            chapters: [
                { chapter_id: 'ch-aaa', scenes: [
                    { scene_id: 'sc-111', type: 'narration', text: 'one' },
                    { scene_id: 'sc-222', type: 'narration', text: 'two' },
                ]},
                { chapter_id: 'ch-bbb', scenes: [
                    { scene_id: 'sc-333', type: 'chapter_intro', text: 'three' },
                ]},
            ],
        }), null);
        const h2 = bookSource.getSceneHash(TEST_BOOK_ID, 'ch-aaa', 'sc-111');
        expect(h1).to.equal(h2);
    });

    it('hash changes when scene text changes', () => {
        const h1 = bookSource.getSceneHash(TEST_BOOK_ID, 'ch-aaa', 'sc-111');
        book.saveBookBundle(buildBook({
            bookId: TEST_BOOK_ID,
            chapters: [
                { chapter_id: 'ch-aaa', scenes: [
                    { scene_id: 'sc-111', type: 'narration', text: 'one CHANGED' },
                    { scene_id: 'sc-222', type: 'narration', text: 'two' },
                ]},
                { chapter_id: 'ch-bbb', scenes: [
                    { scene_id: 'sc-333', type: 'chapter_intro', text: 'three' },
                ]},
            ],
        }), null);
        const h2 = bookSource.getSceneHash(TEST_BOOK_ID, 'ch-aaa', 'sc-111');
        expect(h1).to.not.equal(h2);
    });

    it('loadBookJsonOrThrow throws for missing book', () => {
        expect(() => bookSource.loadBookJsonOrThrow('nonexistent-' + Date.now())).to.throw(/Book JSON not found/);
    });
});
