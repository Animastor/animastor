const { expect } = require('chai');
const registry = require('../src/services/prompt-dependency-registry');

describe('Prompt Dependency Registry', () => {
    describe('isEqual', () => {
        it('returns true for identical primitives', () => {
            expect(registry.isEqual(42, 42)).to.be.true;
            expect(registry.isEqual('hello', 'hello')).to.be.true;
            expect(registry.isEqual(true, true)).to.be.true;
        });

        it('returns false for different primitives', () => {
            expect(registry.isEqual(42, 43)).to.be.false;
            expect(registry.isEqual('hello', 'world')).to.be.false;
            expect(registry.isEqual(true, false)).to.be.false;
        });

        it('handles null and undefined', () => {
            expect(registry.isEqual(null, null)).to.be.true;
            expect(registry.isEqual(undefined, undefined)).to.be.true;
            expect(registry.isEqual(null, undefined)).to.be.false;
            expect(registry.isEqual(null, 'value')).to.be.false;
        });

        it('compares arrays element-wise', () => {
            expect(registry.isEqual([1, 2, 3], [1, 2, 3])).to.be.true;
            expect(registry.isEqual([1, 2, 3], [1, 2, 4])).to.be.false;
            expect(registry.isEqual([1, 2], [1, 2, 3])).to.be.false;
        });

        it('compares objects by keys', () => {
            expect(registry.isEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).to.be.true;
            expect(registry.isEqual({ a: 1 }, { a: 2 })).to.be.false;
            expect(registry.isEqual({ a: 1 }, { b: 1 })).to.be.false;
        });

        it('compares nested objects', () => {
            expect(registry.isEqual({ a: { b: 1 } }, { a: { b: 1 } })).to.be.true;
            expect(registry.isEqual({ a: { b: 1 } }, { a: { b: 2 } })).to.be.false;
        });
    });

    describe('extractPassport', () => {
        it('extracts passport fields from a character', () => {
            const char = {
                passport: {
                    base_appearance: 'tall',
                    detailed_appearance: 'blue eyes',
                    clothing_base: 'robe',
                    clothing_details: 'gold trim',
                },
            };
            const result = registry.extractPassport(char);
            expect(result).to.deep.equal({
                base_appearance: 'tall',
                detailed_appearance: 'blue eyes',
                clothing_base: 'robe',
                clothing_details: 'gold trim',
            });
        });

        it('returns null for null character', () => {
            expect(registry.extractPassport(null)).to.be.null;
        });

        it('defaults missing passport fields', () => {
            const char = { passport: { base_appearance: 'tall' } };
            const result = registry.extractPassport(char);
            expect(result.base_appearance).to.equal('tall');
            expect(result.detailed_appearance).to.be.undefined;
            expect(result.clothing_base).to.be.undefined;
        });
    });

    describe('sceneReferencesCharacter', () => {
        it('finds character at scene participants level', () => {
            const scene = { participants: ['char-1', 'char-2'] };
            expect(registry.sceneReferencesCharacter(scene, 'char-1')).to.be.true;
            expect(registry.sceneReferencesCharacter(scene, 'char-3')).to.be.false;
        });

        it('returns false for scene with no participants data', () => {
            expect(registry.sceneReferencesCharacter({}, 'char-1')).to.be.false;
            expect(registry.sceneReferencesCharacter({ scene: {} }, 'char-1')).to.be.false;
        });

        it('returns false for unit-level participants (removed — only scene-level used)', () => {
            const scene = {
                scene: {
                    units: [
                        { text: 'test' },
                    ],
                },
            };
            // unit-level participants no longer exist
            expect(registry.sceneReferencesCharacter(scene, 'char-1')).to.be.false;
        });

        it('returns false for scene with null/undefined scene entry', () => {
            expect(registry.sceneReferencesCharacter(null, 'char-1')).to.be.false;
            expect(registry.sceneReferencesCharacter(undefined, 'char-1')).to.be.false;
        });
    });

    describe('computeSceneDirtyLayers', () => {
        it('returns empty for identical scenes', () => {
            const scene = { audio: { full_text: 'Hello' } };
            const result = registry.computeSceneDirtyLayers(scene, scene);
            expect(result.dirtyLayers).to.deep.equal([]);
            expect(result.changes).to.be.null;
        });

        it('detects audio full_text change → audio + image + video', () => {
            const oldScene = { audio: { full_text: 'Hello' } };
            const newScene = { audio: { full_text: 'Hello world' } };
            const result = registry.computeSceneDirtyLayers(oldScene, newScene);
            expect(result.dirtyLayers).to.include.members(['audio', 'image', 'video']);
            expect(result.changes.audio_full_text).to.deep.equal({ changed: true });
        });

        it('detects audio voice change → audio only', () => {
            const oldScene = { audio: { voice: 'narrator' } };
            const newScene = { audio: { voice: 'character' } };
            const result = registry.computeSceneDirtyLayers(oldScene, newScene);
            expect(result.dirtyLayers).to.deep.equal(['audio']);
            expect(result.changes.audio_voice).to.deep.equal({ changed: true });
        });

        it('detects scene visual style change → image + video', () => {
            const oldScene = { visual: { style: 'cinematic' } };
            const newScene = { visual: { style: 'cartoon' } };
            const result = registry.computeSceneDirtyLayers(oldScene, newScene);
            expect(result.dirtyLayers).to.include.members(['image', 'video']);
            expect(result.dirtyLayers).to.not.include('audio');
        });

        it('detects scene location change → image + video', () => {
            const oldScene = { location: { id: 'forest' } };
            const newScene = { location: { id: 'castle' } };
            const result = registry.computeSceneDirtyLayers(oldScene, newScene);
            expect(result.dirtyLayers).to.include.members(['image', 'video']);
        });

        it('detects scene participants change → image + video', () => {
            const oldScene = { participants: ['char-1'] };
            const newScene = { participants: ['char-1', 'char-2'] };
            const result = registry.computeSceneDirtyLayers(oldScene, newScene);
            expect(result.dirtyLayers).to.include.members(['image', 'video']);
        });

        it('detects scene.passport override change → image + video (no audio)', () => {
            const oldScene = { passport: { 'char-1': { clothing_base: 'grey coat' } } };
            const newScene = { passport: { 'char-1': { clothing_base: 'black suit' } } };
            const result = registry.computeSceneDirtyLayers(oldScene, newScene);
            expect(result.dirtyLayers).to.include.members(['image', 'video']);
            expect(result.dirtyLayers).to.not.include('audio');
            expect(result.changes.scene_passport).to.deep.equal({ changed: true });
        });

        it('does not mark dirty when scene.passport unchanged', () => {
            const scene = { passport: { 'char-1': { clothing_base: 'grey coat' } } };
            const result = registry.computeSceneDirtyLayers(
                JSON.parse(JSON.stringify(scene)),
                JSON.parse(JSON.stringify(scene))
            );
            expect(result.dirtyLayers).to.deep.equal([]);
        });

        it('detects units change → image + video + audio', () => {
            const oldScene = { units: [{ text: 'Hello' }] };
            const newScene = { units: [{ text: 'Hello world' }] };
            const result = registry.computeSceneDirtyLayers(oldScene, newScene);
            expect(result.dirtyLayers).to.include.members(['image', 'video', 'audio']);
            expect(result.changes.units).to.deep.equal({ old_count: 1, new_count: 1, unit_ids: [] });
        });

        it('detects dialogue_blocks units change', () => {
            const oldScene = { dialogue_blocks: [{ units: [{ text: 'A' }] }] };
            const newScene = { dialogue_blocks: [{ units: [{ text: 'B' }] }] };
            const result = registry.computeSceneDirtyLayers(oldScene, newScene);
            expect(result.dirtyLayers).to.include.members(['image', 'video', 'audio']);
        });

        it('handles null/undefined scenes without crashing', () => {
            expect(() => registry.computeSceneDirtyLayers(null, null)).to.not.throw();
            expect(() => registry.computeSceneDirtyLayers(undefined, undefined)).to.not.throw();
            expect(() => registry.computeSceneDirtyLayers(null, { audio: { full_text: 'test' } })).to.not.throw();
        });

        it('deduplicates layers when multiple fields change', () => {
            const oldScene = {
                audio: { full_text: 'Hello' },
                visual: { style: 'cinematic' },
            };
            const newScene = {
                audio: { full_text: 'World' },
                visual: { style: 'cartoon' },
            };
            const result = registry.computeSceneDirtyLayers(oldScene, newScene);
            // Both changes push 'image' and 'video' — should be deduplicated
            expect(result.dirtyLayers.sort()).to.deep.equal(['audio', 'image', 'video']);
        });
    });

    describe('getFieldsForLayer', () => {
        it('returns audio-triggered fields', () => {
            const fields = registry.getFieldsForLayer('audio');
            const keys = fields.map(f => f.key);
            expect(keys).to.include('audio.full_text');
            expect(keys).to.include('audio.voice');
            expect(keys).to.not.include('scene.visual.style');
        });

        it('returns image-triggered fields', () => {
            const fields = registry.getFieldsForLayer('image');
            const keys = fields.map(f => f.key);
            expect(keys).to.include('scene.visual.style');
            expect(keys).to.include('scene.location');
        });

        it('returns video-triggered fields', () => {
            const fields = registry.getFieldsForLayer('video');
            const keys = fields.map(f => f.key);
            expect(keys).to.include('scene.visual.style');
            expect(keys).to.include('scene.location');
            expect(keys).to.not.include('audio.voice');  // audio doesn't trigger video
        });
    });

    describe('getLayerDependencies', () => {
        it('audio regenerates only audio', () => {
            const deps = registry.getLayerDependencies();
            expect(deps.audio.regenerate).to.deep.equal(['audio']);
        });

        it('image regenerates image + video', () => {
            const deps = registry.getLayerDependencies();
            expect(deps.image.regenerate).to.include.members(['image', 'video']);
        });

        it('video regenerates only video', () => {
            const deps = registry.getLayerDependencies();
            expect(deps.video.regenerate).to.deep.equal(['video']);
        });

        it('video is NOT triggered by audio fields', () => {
            const deps = registry.getLayerDependencies();
            const audioKeys = deps.video.triggeredBy.filter(k => k.startsWith('audio.'));
            expect(audioKeys).to.deep.equal([]);
        });
    });

    describe('getCrossFields', () => {
        it('returns 4 cross-cutting fields', () => {
            const fields = registry.getCrossFields();
            expect(fields).to.have.length(4);
        });

        it('includes characters.passport, characters.voice, bible.locations, book.voices', () => {
            const keys = registry.getCrossFields().map(f => f.key);
            expect(keys).to.include('characters.passport');
            expect(keys).to.include('characters.voice');
            expect(keys).to.include('bible.locations');
            expect(keys).to.include('book.voices');
        });

        describe('book.voices entitySource', () => {
            it('extracts voices map entries with id from book', () => {
                const field = registry.getCrossFields().find(f => f.key === 'book.voices');
                const book = { voices: { narrator: { instruction: 'a' }, dialogue: { instruction: 'b' } } };
                const entities = field.entitySource(book);
                expect(entities).to.have.length(2);
                expect(entities[0].id).to.equal('narrator');
            });

            it('isChanged compares instruction strings', () => {
                const field = registry.getCrossFields().find(f => f.key === 'book.voices');
                expect(field.isChanged({ instruction: 'x' }, { instruction: 'y' })).to.equal(true);
                expect(field.isChanged({ instruction: 'x' }, { instruction: 'x' })).to.equal(false);
            });
        });

        describe('characters.passport entitySource', () => {
            it('extracts characters array from book', () => {
                const field = registry.getCrossFields().find(f => f.key === 'characters.passport');
                const book = { characters: [{ id: 'c1' }, { id: 'c2' }] };
                expect(field.entitySource(book)).to.have.length(2);
            });

            it('returns empty array for missing characters', () => {
                const field = registry.getCrossFields().find(f => f.key === 'characters.passport');
                expect(field.entitySource({})).to.deep.equal([]);
            });

            it('isChanged detects passport differences', () => {
                const field = registry.getCrossFields().find(f => f.key === 'characters.passport');
                const oldChar = { passport: { base_appearance: 'tall' } };
                const newChar = { passport: { base_appearance: 'short' } };
                expect(field.isChanged(oldChar, newChar)).to.be.true;
            });

            it('isChanged ignores non-passport fields', () => {
                const field = registry.getCrossFields().find(f => f.key === 'characters.passport');
                const oldChar = { name: 'Alice', passport: { base_appearance: 'tall' } };
                const newChar = { name: 'Alice', passport: { base_appearance: 'tall' } };
                expect(field.isChanged(oldChar, newChar)).to.be.false;
            });

            it('findAffectedScenes finds scenes with matching participant', () => {
                const field = registry.getCrossFields().find(f => f.key === 'characters.passport');
                const scenes = [
                    { participants: ['c1'], scene: {} },
                    { participants: ['c2'], scene: {} },
                ];
                const affected = field.findAffectedScenes(scenes, 'c1');
                expect(affected).to.have.length(1);
                expect(affected[0].participants).to.include('c1');
            });
        });

        describe('bible.locations entitySource', () => {
            it('converts locations object to array with id', () => {
                const field = registry.getCrossFields().find(f => f.key === 'bible.locations');
                const book = {
                    locations: {
                        forest: { description: 'A dark forest' },
                        castle: { description: 'A castle' },
                    },
                };
                const entities = field.entitySource(book);
                expect(entities).to.have.length(2);
                expect(entities[0].id).to.equal('forest');
                expect(entities[1].id).to.equal('castle');
            });

            it('findAffectedScenes finds scenes with matching location id', () => {
                const field = registry.getCrossFields().find(f => f.key === 'bible.locations');
                const scenes = [
                    { location: { id: 'forest' }, scene: {} },
                    { location: { id: 'castle' }, scene: {} },
                ];
                const affected = field.findAffectedScenes(scenes, 'forest');
                expect(affected).to.have.length(1);
                expect(affected[0].location.id).to.equal('forest');
            });
        });
    });
});
