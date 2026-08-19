const assert = require('assert');
const { setDeep, findUnitInScene, rebuildFullText } = require('../src/routes/book/scene-patch-utils.cjs');

describe('scene-patch-utils', () => {
    describe('setDeep', () => {
        it('sets a top-level key', () => {
            const o = {};
            setDeep(o, 'a', 1);
            assert.strictEqual(o.a, 1);
        });

        it('creates intermediate objects for a dotted path', () => {
            const o = {};
            setDeep(o, 'a.b.c', 'x');
            assert.deepStrictEqual(o, { a: { b: { c: 'x' } } });
        });

        it('overwrites an existing leaf without clobbering siblings', () => {
            const o = { a: { b: 1, keep: 2 } };
            setDeep(o, 'a.b', 9);
            assert.deepStrictEqual(o, { a: { b: 9, keep: 2 } });
        });

        it('treats a null intermediate as missing and replaces it', () => {
            const o = { a: null };
            setDeep(o, 'a.b', 5);
            assert.deepStrictEqual(o, { a: { b: 5 } });
        });
    });

    describe('findUnitInScene', () => {
        it('finds a unit in scene.units', () => {
            const scene = { units: [{ id: 'u1' }, { id: 'u2' }] };
            assert.strictEqual(findUnitInScene(scene, 'u2').id, 'u2');
        });

        it('finds a unit inside dialogue_blocks[].units', () => {
            const scene = { dialogue_blocks: [{ units: [{ id: 'd1' }] }, { units: [{ id: 'd2' }] }] };
            assert.strictEqual(findUnitInScene(scene, 'd2').id, 'd2');
        });

        it('prefers scene.units over dialogue_blocks when both match-eligible', () => {
            const scene = { units: [{ id: 'u1' }], dialogue_blocks: [{ units: [{ id: 'x' }] }] };
            assert.strictEqual(findUnitInScene(scene, 'u1').id, 'u1');
        });

        it('returns null when the unit is absent', () => {
            assert.strictEqual(findUnitInScene({ units: [{ id: 'a' }] }, 'missing'), null);
        });

        it('tolerates a scene with neither units nor dialogue_blocks', () => {
            assert.strictEqual(findUnitInScene({}, 'whatever'), null);
        });

        it('skips null entries in a units array without throwing', () => {
            const scene = { units: [null, { id: 'u9' }] };
            assert.strictEqual(findUnitInScene(scene, 'u9').id, 'u9');
        });
    });

    describe('rebuildFullText', () => {
        it('joins unit texts for narration scenes', () => {
            const scene = { type: 'narration', units: [
                { id: 'u1', text: 'Hello' },
                { id: 'u2', text: 'World' },
            ] };
            rebuildFullText(scene);
            assert.strictEqual(scene.audio.full_text, 'Hello World');
        });

        it('joins unit texts when scene.type is undefined (default narration)', () => {
            const scene = { units: [
                { id: 'u1', text: 'Alpha' },
                { id: 'u2', text: 'Beta' },
            ] };
            rebuildFullText(scene);
            assert.strictEqual(scene.audio.full_text, 'Alpha Beta');
        });

        it('does NOT overwrite full_text for dialogue scenes', () => {
            const scene = { type: 'dialogue', audio: { full_text: 'custom text' }, units: [
                { id: 'u1', text: 'A' },
            ] };
            rebuildFullText(scene);
            assert.strictEqual(scene.audio.full_text, 'custom text');
        });

        it('clears full_text when all units have empty text', () => {
            const scene = { type: 'narration', audio: { full_text: 'old text' }, units: [
                { id: 'u1', text: '' },
                { id: 'u2', text: '  ' },
            ] };
            rebuildFullText(scene);
            assert.strictEqual(scene.audio.full_text, '');
        });

        it('filters out empty unit texts', () => {
            const scene = { type: 'narration', units: [
                { id: 'u1', text: 'Keep' },
                { id: 'u2', text: '' },
                { id: 'u3', text: 'Also' },
            ] };
            rebuildFullText(scene);
            assert.strictEqual(scene.audio.full_text, 'Keep Also');
        });

        it('handles null scene gracefully', () => {
            rebuildFullText(null); // should not throw
        });

        it('handles scene with no units', () => {
            const scene = { type: 'narration', audio: { full_text: 'something' } };
            rebuildFullText(scene);
            assert.strictEqual(scene.audio.full_text, '');
        });

        it('handles chapter_intro type', () => {
            const scene = { type: 'chapter_intro', units: [
                { id: 'u1', text: 'Intro text' },
            ] };
            rebuildFullText(scene);
            assert.strictEqual(scene.audio.full_text, 'Intro text');
        });

        it('includes all unit types in narration rebuild (perception, description, etc.)', () => {
            const scene = { type: 'narration', units: [
                { id: 'u1', type: 'narration', text: 'A' },
                { id: 'u2', type: 'perception', text: 'B' },
                { id: 'u3', type: 'description', text: 'C' },
                { id: 'u4', type: 'action', text: 'D' },
            ] };
            rebuildFullText(scene);
            assert.strictEqual(scene.audio.full_text, 'A B C D');
        });

        it('does NOT rebuild for dialogue scenes even with type changes', () => {
            const scene = { type: 'dialogue', audio: { full_text: 'original' }, units: [
                { id: 'u1', type: 'dialogue', text: 'X' },
            ] };
            scene.units[0].type = 'narration'; // simulate type change
            rebuildFullText(scene);
            // dialogue scenes: full_text is preview-only, not rebuilt
            assert.strictEqual(scene.audio.full_text, 'original');
        });

        it('rebuild removes stale text from deleted unit', () => {
            // Simulates: scene had units A+B, unit B deleted, rebuild from A only
            const scene = { type: 'narration', audio: { full_text: 'Hello World' }, units: [
                { id: 'u1', text: 'Hello' },
                // u2 ("World") was deleted
            ] };
            rebuildFullText(scene);
            assert.strictEqual(scene.audio.full_text, 'Hello');
        });

        it('rebuild includes newly added unit text', () => {
            const scene = { type: 'narration', audio: { full_text: 'A' }, units: [
                { id: 'u1', text: 'A' },
                { id: 'u2', text: 'B' },  // newly added
            ] };
            rebuildFullText(scene);
            assert.strictEqual(scene.audio.full_text, 'A B');
        });

        it('cover type is treated as narration ( rebuilds full_text)', () => {
            const scene = { type: 'cover', units: [
                { id: 'u1', text: 'Book Title' },
            ] };
            rebuildFullText(scene);
            assert.strictEqual(scene.audio.full_text, 'Book Title');
        });
    });
});
