// ======================================================
// Scene List — server-side scene flattening (thin-client contract)
// ======================================================
// GET /api/v1/book/:bookId now returns a flat `scene_list`
// so clients (Android, Web, ...) build playback queues and
// navigation from it instead of re-implementing chapter→scene
// traversal. Cover detection is centralized too: the first
// entry with type "cover" is the book cover.
//
// These tests cover the pure function `collectSceneList`.

const { expect } = require('chai');

const bookModule = require('../src/book/index');

describe('collectSceneList — flat scene list (thin-client contract)', () => {

    it('returns an empty array for null/undefined book', () => {
        expect(bookModule.collectSceneList(null)).to.deep.equal([]);
        expect(bookModule.collectSceneList(undefined)).to.deep.equal([]);
        expect(bookModule.collectSceneList({})).to.deep.equal([]);
    });

    it('returns an empty array when there are no chapters', () => {
        expect(bookModule.collectSceneList({ chapters: [] })).to.deep.equal([]);
        expect(bookModule.collectSceneList({ chapters: null })).to.deep.equal([]);
    });

    it('skips chapters without a scenes array', () => {
        const book = { chapters: [{ chapter_id: 'ch1', scenes: null }] };
        expect(bookModule.collectSceneList(book)).to.deep.equal([]);
    });

    it('flattens chapters → scenes in book order', () => {
        const book = {
            chapters: [
                {
                    chapter_id: 'ch-cover',
                    scenes: [
                        { scene_id: 'sc-1', type: 'cover' },
                        { scene_id: 'sc-2', type: 'narration' },
                    ],
                },
                {
                    chapter_id: 'ch-2',
                    scenes: [
                        { scene_id: 'sc-3', type: 'dialogue' },
                        { scene_id: 'sc-4', type: 'narration' },
                    ],
                },
            ],
        };
        const list = bookModule.collectSceneList(book);
        expect(list).to.deep.equal([
            { chapter_id: 'ch-cover', scene_id: 'sc-1', type: 'cover' },
            { chapter_id: 'ch-cover', scene_id: 'sc-2', type: 'narration' },
            { chapter_id: 'ch-2', scene_id: 'sc-3', type: 'dialogue' },
            { chapter_id: 'ch-2', scene_id: 'sc-4', type: 'narration' },
        ]);
    });

    it('defaults a missing scene type to narration', () => {
        const book = {
            chapters: [
                { chapter_id: 'ch-1', scenes: [{ scene_id: 'sc-1' }] },
            ],
        };
        const list = bookModule.collectSceneList(book);
        expect(list).to.deep.equal([
            { chapter_id: 'ch-1', scene_id: 'sc-1', type: 'narration' },
        ]);
    });

    it('preserves chapter and scene ids verbatim (no reordering)', () => {
        const book = {
            chapters: [
                { chapter_id: 'ch-A', scenes: [{ scene_id: 's-1' }, { scene_id: 's-2' }] },
                { chapter_id: 'ch-B', scenes: [{ scene_id: 's-3' }] },
            ],
        };
        const ids = bookModule.collectSceneList(book).map(s => `${s.chapter_id}/${s.scene_id}`);
        expect(ids).to.deep.equal(['ch-A/s-1', 'ch-A/s-2', 'ch-B/s-3']);
    });
});
