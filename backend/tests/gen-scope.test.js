const { expect } = require('chai');
const genScope = require('../src/services/gen-scope');
const { createMockRedis } = require('./mocks/redis-mock');

const allScenes = [
    { chapter_id: 'ch-1', scene_id: 's-1' },
    { chapter_id: 'ch-1', scene_id: 's-2' },
    { chapter_id: 'ch-1', scene_id: 's-3' },
    { chapter_id: 'ch-2', scene_id: 's-1' },
    { chapter_id: 'ch-2', scene_id: 's-2' },
    { chapter_id: 'ch-3', scene_id: 's-1' },
];

describe('gen-scope service', () => {
    let redis;
    beforeEach(() => { redis = createMockRedis(); });

    it('setScope + getScope round-trip', async () => {
        await genScope.setScope(redis, 'book-1', 'current_scene', 'ch-1', 's-2');
        const got = await genScope.getScope(redis, 'book-1');
        expect(got).to.not.be.null;
        expect(got.scope).to.equal('current_scene');
        expect(got.chapter_id).to.equal('ch-1');
        expect(got.scene_id).to.equal('s-2');
        expect(got.set_at).to.be.a('string');
    });

    it('setScope without scope defaults to whole_book', async () => {
        await genScope.setScope(redis, 'book-1', null, null, null);
        const got = await genScope.getScope(redis, 'book-1');
        expect(got.scope).to.equal('whole_book');
    });

    it('getScope returns null for unknown book', async () => {
        const got = await genScope.getScope(redis, 'unknown');
        expect(got).to.be.null;
    });

    it('getScope returns null for corrupt JSON', async () => {
        await redis.set(genScope.key('book-1'), '{not json');
        const got = await genScope.getScope(redis, 'book-1');
        expect(got).to.be.null;
    });

    it('clearScope removes the entry', async () => {
        await genScope.setScope(redis, 'book-1', 'whole_book', null, null);
        await genScope.clearScope(redis, 'book-1');
        const got = await genScope.getScope(redis, 'book-1');
        expect(got).to.be.null;
    });

    it('setScope overwrites previous value', async () => {
        await genScope.setScope(redis, 'book-1', 'whole_book', null, null);
        await genScope.setScope(redis, 'book-1', 'current_chapter', 'ch-2', null);
        const got = await genScope.getScope(redis, 'book-1');
        expect(got.scope).to.equal('current_chapter');
        expect(got.chapter_id).to.equal('ch-2');
    });

    it('setScope/getScope are no-ops with missing redis/bookId', async () => {
        const r1 = await genScope.setScope(null, 'book-1', 'whole_book');
        expect(r1).to.be.null;
        const r2 = await genScope.getScope(null, 'book-1');
        expect(r2).to.be.null;
        await genScope.clearScope(null, 'book-1');
    });
});

describe('gen-scope.scopeBounds', () => {
    it('whole_book returns full range', () => {
        const b = genScope.scopeBounds({ scope: 'whole_book' }, allScenes);
        expect(b).to.deep.equal({ startIndex: 0, endIndex: 6 });
    });

    it('null/undefined scope returns full range', () => {
        expect(genScope.scopeBounds(null, allScenes)).to.deep.equal({ startIndex: 0, endIndex: 6 });
        expect(genScope.scopeBounds(undefined, allScenes)).to.deep.equal({ startIndex: 0, endIndex: 6 });
        expect(genScope.scopeBounds({}, allScenes)).to.deep.equal({ startIndex: 0, endIndex: 6 });
    });

    it('current_scene returns single-element range at scene index', () => {
        const b = genScope.scopeBounds({ scope: 'current_scene', chapter_id: 'ch-1', scene_id: 's-2' }, allScenes);
        expect(b).to.deep.equal({ startIndex: 1, endIndex: 2 });
    });

    it('current_scene for last scene', () => {
        const b = genScope.scopeBounds({ scope: 'current_scene', chapter_id: 'ch-3', scene_id: 's-1' }, allScenes);
        expect(b).to.deep.equal({ startIndex: 5, endIndex: 6 });
    });

    it('current_scene for unknown scene returns empty range', () => {
        const b = genScope.scopeBounds({ scope: 'current_scene', chapter_id: 'ch-X', scene_id: 's-Y' }, allScenes);
        expect(b).to.deep.equal({ startIndex: 0, endIndex: 0 });
    });

    it('current_chapter returns range of scenes in chapter', () => {
        const b = genScope.scopeBounds({ scope: 'current_chapter', chapter_id: 'ch-1' }, allScenes);
        expect(b).to.deep.equal({ startIndex: 0, endIndex: 3 });
    });

    it('current_chapter for middle chapter (ch-2)', () => {
        const b = genScope.scopeBounds({ scope: 'current_chapter', chapter_id: 'ch-2' }, allScenes);
        expect(b).to.deep.equal({ startIndex: 3, endIndex: 5 });
    });

    it('current_chapter for last chapter (ch-3)', () => {
        const b = genScope.scopeBounds({ scope: 'current_chapter', chapter_id: 'ch-3' }, allScenes);
        expect(b).to.deep.equal({ startIndex: 5, endIndex: 6 });
    });

    it('current_chapter for unknown chapter returns empty range', () => {
        const b = genScope.scopeBounds({ scope: 'current_chapter', chapter_id: 'ch-X' }, allScenes);
        expect(b).to.deep.equal({ startIndex: 0, endIndex: 0 });
    });

    it('from_current_scene returns tail from that scene', () => {
        const b = genScope.scopeBounds({ scope: 'from_current_scene', chapter_id: 'ch-2', scene_id: 's-1' }, allScenes);
        expect(b).to.deep.equal({ startIndex: 3, endIndex: 6 });
    });

    it('from_current_scene for first scene returns full', () => {
        const b = genScope.scopeBounds({ scope: 'from_current_scene', chapter_id: 'ch-1', scene_id: 's-1' }, allScenes);
        expect(b).to.deep.equal({ startIndex: 0, endIndex: 6 });
    });

    it('from_current_scene for unknown scene returns empty range', () => {
        const b = genScope.scopeBounds({ scope: 'from_current_scene', chapter_id: 'ch-X', scene_id: 's-Y' }, allScenes);
        expect(b).to.deep.equal({ startIndex: 0, endIndex: 0 });
    });

    it('handles empty allScenes', () => {
        expect(genScope.scopeBounds({ scope: 'whole_book' }, [])).to.deep.equal({ startIndex: 0, endIndex: 0 });
        expect(genScope.scopeBounds({ scope: 'current_scene', chapter_id: 'c', scene_id: 's' }, [])).to.deep.equal({ startIndex: 0, endIndex: 0 });
    });

    it('handles undefined allScenes', () => {
        expect(genScope.scopeBounds({ scope: 'whole_book' }, undefined)).to.deep.equal({ startIndex: 0, endIndex: 0 });
        expect(genScope.scopeBounds({ scope: 'current_chapter', chapter_id: 'ch-1' }, undefined)).to.deep.equal({ startIndex: 0, endIndex: 0 });
    });
});

describe('gen-scope.inScope', () => {
    it('whole_book matches everything', () => {
        const s = { scope: 'whole_book' };
        expect(genScope.inScope(s, 'ch-1', 's-1')).to.be.true;
        expect(genScope.inScope(s, 'ch-9', 's-9')).to.be.true;
    });

    it('null/undefined scope matches everything', () => {
        expect(genScope.inScope(null, 'c', 's')).to.be.true;
        expect(genScope.inScope(undefined, 'c', 's')).to.be.true;
    });

    it('current_scene only matches that scene', () => {
        const s = { scope: 'current_scene', chapter_id: 'ch-1', scene_id: 's-1' };
        expect(genScope.inScope(s, 'ch-1', 's-1')).to.be.true;
        expect(genScope.inScope(s, 'ch-1', 's-2')).to.be.false;
        expect(genScope.inScope(s, 'ch-2', 's-1')).to.be.false;
    });

    it('current_chapter matches any scene in that chapter', () => {
        const s = { scope: 'current_chapter', chapter_id: 'ch-1' };
        expect(genScope.inScope(s, 'ch-1', 's-1')).to.be.true;
        expect(genScope.inScope(s, 'ch-1', 's-3')).to.be.true;
        expect(genScope.inScope(s, 'ch-2', 's-1')).to.be.false;
    });

    it('from_current_scene only matches the exact scene in the simple form', () => {
        const s = { scope: 'from_current_scene', chapter_id: 'ch-1', scene_id: 's-2' };
        expect(genScope.inScope(s, 'ch-1', 's-2')).to.be.true;
        expect(genScope.inScope(s, 'ch-1', 's-3')).to.be.false;
    });
});
