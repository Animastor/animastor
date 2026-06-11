const { expect } = require('chai');
const layerConfig = require('../src/services/layer-config');

function makeDirtyScenes(items) {
    return items.map(([chapter_id, scene_id]) => ({
        chapter_id,
        scene_id,
        dirty_layers: ['audio', 'image', 'video'],
        changes: {},
    }));
}

const allCanonical = [
    { chapter_id: 'ch-1', scene_id: 's-1' },
    { chapter_id: 'ch-1', scene_id: 's-2' },
    { chapter_id: 'ch-1', scene_id: 's-3' },
    { chapter_id: 'ch-2', scene_id: 's-1' },
    { chapter_id: 'ch-2', scene_id: 's-2' },
    { chapter_id: 'ch-3', scene_id: 's-1' },
];

const dirty = makeDirtyScenes([
    ['ch-1', 's-1'],
    ['ch-1', 's-2'],
    ['ch-1', 's-3'],
    ['ch-2', 's-1'],
    ['ch-2', 's-2'],
    ['ch-3', 's-1'],
]);

function filterByScope(dirtyScenes, scope, chapterId, sceneId, allScenes) {
    if (!scope || scope === layerConfig.SCOPES.WHOLE_BOOK) return dirtyScenes;
    if (scope === layerConfig.SCOPES.CURRENT_SCENE) {
        if (!chapterId || !sceneId) return [];
        return dirtyScenes.filter(s => s.chapter_id === chapterId && s.scene_id === sceneId);
    }
    if (scope === layerConfig.SCOPES.CURRENT_CHAPTER) {
        if (!chapterId) return [];
        return dirtyScenes.filter(s => s.chapter_id === chapterId);
    }
    if (scope === layerConfig.SCOPES.FROM_CURRENT_SCENE) {
        if (!chapterId || !sceneId) return dirtyScenes;
        const fromIdx = (allScenes || []).findIndex(s => s.chapter_id === chapterId && s.scene_id === sceneId);
        if (fromIdx < 0) return [];
        const tail = (allScenes || []).slice(fromIdx);
        const tailKeys = new Set(tail.map(s => `${s.chapter_id}::${s.scene_id}`));
        return dirtyScenes.filter(s => tailKeys.has(`${s.chapter_id}::${s.scene_id}`));
    }
    return dirtyScenes;
}

describe('Scope Filtering (regenerate)', () => {
    it('whole_book (or undefined) returns all', () => {
        expect(filterByScope(dirty, undefined).length).to.equal(6);
        expect(filterByScope(dirty, layerConfig.SCOPES.WHOLE_BOOK).length).to.equal(6);
    });

    it('current_scene returns only matching scene', () => {
        const out = filterByScope(dirty, layerConfig.SCOPES.CURRENT_SCENE, 'ch-2', 's-1', allCanonical);
        expect(out.length).to.equal(1);
        expect(out[0].chapter_id).to.equal('ch-2');
        expect(out[0].scene_id).to.equal('s-1');
    });

    it('current_scene without chapter_id returns []', () => {
        expect(filterByScope(dirty, layerConfig.SCOPES.CURRENT_SCENE).length).to.equal(0);
    });

    it('current_scene without scene_id returns []', () => {
        expect(filterByScope(dirty, layerConfig.SCOPES.CURRENT_SCENE, 'ch-1').length).to.equal(0);
    });

    it('current_chapter returns all scenes in chapter', () => {
        const out = filterByScope(dirty, layerConfig.SCOPES.CURRENT_CHAPTER, 'ch-1', null, allCanonical);
        expect(out.length).to.equal(3);
        expect(out.every(s => s.chapter_id === 'ch-1')).to.be.true;
    });

    it('current_chapter without chapter_id returns []', () => {
        expect(filterByScope(dirty, layerConfig.SCOPES.CURRENT_CHAPTER).length).to.equal(0);
    });

    it('from_current_scene returns scene + all after (cross-chapter)', () => {
        const out = filterByScope(dirty, layerConfig.SCOPES.FROM_CURRENT_SCENE, 'ch-2', 's-1', allCanonical);
        const expected = [
            ['ch-2', 's-1'],
            ['ch-2', 's-2'],
            ['ch-3', 's-1'],
        ];
        expect(out.map(s => [s.chapter_id, s.scene_id])).to.deep.equal(expected);
    });

    it('from_current_scene at first scene returns all', () => {
        const out = filterByScope(dirty, layerConfig.SCOPES.FROM_CURRENT_SCENE, 'ch-1', 's-1', allCanonical);
        expect(out.length).to.equal(6);
    });

    it('from_current_scene at last scene returns just that scene', () => {
        const out = filterByScope(dirty, layerConfig.SCOPES.FROM_CURRENT_SCENE, 'ch-3', 's-1', allCanonical);
        expect(out.length).to.equal(1);
        expect(out[0].chapter_id).to.equal('ch-3');
    });

    it('from_current_scene with unknown scene returns []', () => {
        const out = filterByScope(dirty, layerConfig.SCOPES.FROM_CURRENT_SCENE, 'ch-9', 's-9', allCanonical);
        expect(out.length).to.equal(0);
    });

    it('from_current_scene without chapter_id returns all (fallback)', () => {
        const out = filterByScope(dirty, layerConfig.SCOPES.FROM_CURRENT_SCENE, null, null, allCanonical);
        expect(out.length).to.equal(6);
    });

    it('empty dirty list returns empty', () => {
        const empty = [];
        expect(filterByScope(empty, layerConfig.SCOPES.CURRENT_SCENE, 'ch-1', 's-1', allCanonical).length).to.equal(0);
    });
});
