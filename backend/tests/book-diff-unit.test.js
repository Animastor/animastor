const { expect } = require('chai');
const path = require('path');

// Stub deps for the book-diff factory
function createBookDiff(overrides = {}) {
    const state = {
        // SceneState removed in v2.2.0
        // kept minimal for backward compat in this test
        SceneState: {
            NEW: 'new',
            AUDIO_PENDING: 'audio_pending',
            AUDIO_GENERATING: 'audio_generating',
            AUDIO_READY: 'audio_ready',
            IMAGE_PENDING: 'image_pending',
            IMAGE_GENERATING: 'image_generating',
            IMAGE_READY: 'image_ready',
            VIDEO_PENDING: 'video_pending',
            VIDEO_GENERATING: 'video_generating',
            VIDEO_READY: 'video_ready',
            FAILED: 'failed',
        },
        AssetState: {
            NEW: 'new',
            DIRTY: 'dirty',
            PENDING: 'pending',
            GENERATING: 'generating',
            READY: 'ready',
            FAILED: 'failed',
            PLACEHOLDER: 'placeholder',
        },
        SCENE_STATE_KEY_PREFIX: 'animastor:scene-state',
        ASSET_STATE_KEY_PREFIX: 'animastor:asset-state',
        // syncLinearState removed in v2.2.0
        setAssetState: async () => {},
        setAssetStates: async () => {},
        getAssetStates: async () => ({ audio: 'new', image: 'new', video: 'new' }),
        setSceneStateWithBuildId: async () => {},
        validateAssetTransition: () => ({ valid: true }),
    };

    const book = {
        loadBook: () => null,
        findSceneRuntimeData: () => null,
        collectScenes: () => [],
    };

    const layerConfig = { get: async () => null, set: async () => null };
    const genScope = { getScope: async () => null, scopeBounds: () => ({ startIndex: 0, endIndex: 0 }) };
    const activeScenes = { addActiveScene: async () => ({ added: true }) };
    const getChunk = async () => null;
    const saveChunk = async () => {};

    const deps = {
        state,
        book,
        layerConfig,
        genScope,
        activeScenes,
        getChunk,
        saveChunk,
        utils: {
            log: () => {},
            collectScenes: (bookData) => {
                // Matches real collectScenes from book/index.js:
                // participants and location are copied from scene to entry level
                if (!bookData || !bookData.chapters) return [];
                const scenes = [];
                for (const ch of bookData.chapters) {
                    for (const sc of (ch.scenes || [])) {
                        scenes.push({
                            chapter_id: ch.chapter,
                            scene_id: sc.scene_id,
                            scene_order: sc.scene_order || 0,
                            participants: sc.participants || [],
                            location: sc.location || null,
                            scene: sc,
                            payload: sc,
                        });
                    }
                }
                return scenes;
            },
        },
    };

    const bookDiffFactory = require('../src/services/book-diff.cjs');
    return bookDiffFactory({}, {}, deps);
}

describe('Book Diff (pure unit tests)', () => {
    let bookDiff;

    before(() => {
        bookDiff = createBookDiff();
    });

    describe('diffScene', () => {
        it('returns empty for identical scenes', () => {
            const scene = { audio: { full_text: 'Hello' } };
            const result = bookDiff.diffScene(scene, scene);
            expect(result.dirty_layers).to.deep.equal([]);
            expect(result.changes).to.be.null;
        });

        it('delegates to registry — detects audio full_text change', () => {
            const oldScene = { audio: { full_text: 'Hello' } };
            const newScene = { audio: { full_text: 'Hello world' } };
            const result = bookDiff.diffScene(oldScene, newScene);
            expect(result.dirty_layers).to.include.members(['audio', 'image', 'video']);
        });

        it('delegates to registry — voice change is audio-only', () => {
            const oldScene = { audio: { voice: 'narrator' } };
            const newScene = { audio: { voice: 'character' } };
            const result = bookDiff.diffScene(oldScene, newScene);
            expect(result.dirty_layers).to.deep.equal(['audio']);
        });
    });

    describe('computeBookDiff', () => {
        it('detects added scenes', () => {
            const oldBook = { chapters: [] };
            const newBook = {
                chapters: [{ chapter: 'ch-1', scenes: [{ scene_id: 'sc-1' }] }],
            };
            const result = bookDiff.computeBookDiff(oldBook, newBook);
            expect(result.dirty_scenes).to.have.length(1);
            expect(result.dirty_scenes[0].reason).to.equal('added');
            expect(result.dirty_scenes[0].dirty_layers).to.include.members(['audio', 'image', 'video']);
            expect(result.changes.added).to.equal(1);
        });

        it('detects removed scenes', () => {
            const oldBook = {
                chapters: [{ chapter: 'ch-1', scenes: [{ scene_id: 'sc-1' }, { scene_id: 'sc-2' }] }],
            };
            const newBook = {
                chapters: [{ chapter: 'ch-1', scenes: [{ scene_id: 'sc-1' }] }],
            };
            const result = bookDiff.computeBookDiff(oldBook, newBook);
            expect(result.dirty_scenes).to.have.length(1);
            expect(result.dirty_scenes[0].reason).to.equal('removed');
            expect(result.changes.removed).to.equal(1);
        });

        it('detects changed scenes (scene text change)', () => {
            const oldBook = {
                chapters: [{ chapter: 'ch-1', scenes: [{ scene_id: 'sc-1', audio: { full_text: 'Hello' } }] }],
            };
            const newBook = {
                chapters: [{ chapter: 'ch-1', scenes: [{ scene_id: 'sc-1', audio: { full_text: 'World' } }] }],
            };
            const result = bookDiff.computeBookDiff(oldBook, newBook);
            expect(result.dirty_scenes).to.have.length(1);
            expect(result.dirty_scenes[0].reason).to.equal('changed');
            expect(result.dirty_scenes[0].dirty_layers).to.include.members(['audio', 'image', 'video']);
            expect(result.changes.modified).to.equal(1);
        });

        it('detects reorder', () => {
            const oldBook = {
                chapters: [{ chapter: 'ch-1', scenes: [{ scene_id: 'sc-1', scene_order: 0 }, { scene_id: 'sc-2', scene_order: 1 }] }],
            };
            const newBook = {
                chapters: [{ chapter: 'ch-1', scenes: [{ scene_id: 'sc-2', scene_order: 0 }, { scene_id: 'sc-1', scene_order: 1 }] }],
            };
            const result = bookDiff.computeBookDiff(oldBook, newBook);
            expect(result.reindex_needed).to.be.true;
        });
    });

    describe('filterDirtyScenesByScope', () => {
        const dirtyScenes = [
            { chapter_id: 'ch-1', scene_id: 'sc-1', reason: 'changed', dirty_layers: ['audio'], changes: {} },
            { chapter_id: 'ch-1', scene_id: 'sc-2', reason: 'changed', dirty_layers: ['image'], changes: {} },
            { chapter_id: 'ch-2', scene_id: 'sc-3', reason: 'added', dirty_layers: ['audio', 'image', 'video'], changes: {} },
        ];
        const allScenes = [
            { chapter_id: 'ch-1', scene_id: 'sc-1', scene_order: 0 },
            { chapter_id: 'ch-1', scene_id: 'sc-2', scene_order: 1 },
            { chapter_id: 'ch-2', scene_id: 'sc-3', scene_order: 2 },
        ];

        it('whole_book returns all dirty scenes', () => {
            const result = bookDiff.filterDirtyScenesByScope(dirtyScenes, 'whole_book', null, null, null);
            expect(result).to.have.length(3);
        });

        it('current_scene filters by chapter + scene', () => {
            const result = bookDiff.filterDirtyScenesByScope(dirtyScenes, 'current_scene', 'ch-1', 'sc-1', null);
            expect(result).to.have.length(1);
            expect(result[0].scene_id).to.equal('sc-1');
        });

        it('current_chapter filters by chapter', () => {
            const result = bookDiff.filterDirtyScenesByScope(dirtyScenes, 'current_chapter', 'ch-2', null, null);
            expect(result).to.have.length(1);
            expect(result[0].chapter_id).to.equal('ch-2');
        });

        it('from_current_scene filters scenes at or after the given index (including current chapter)', () => {
            const result = bookDiff.filterDirtyScenesByScope(dirtyScenes, 'from_current_scene', 'ch-1', 'sc-2', allScenes);
            // ch-1/sc-1 is included because it shares fromChapter='ch-1'
            // ch-1/sc-2 is at the current index
            // ch-2/sc-3 is after the current index
            expect(result).to.have.length(3);
            const ids = result.map(d => `${d.chapter_id}/${d.scene_id}`);
            expect(ids).to.include('ch-1/sc-1');
            expect(ids).to.include('ch-1/sc-2');
            expect(ids).to.include('ch-2/sc-3');
        });

        it('empty array for empty input', () => {
            const result = bookDiff.filterDirtyScenesByScope([], 'whole_book', null, null, null);
            expect(result).to.deep.equal([]);
        });
    });

    describe('isInScope', () => {
        const chunk = { chapter_id: 'ch-1', scene_id: 'sc-1' };

        it('whole_book matches everything', () => {
            expect(bookDiff.isInScope(chunk, 'whole_book', null, null)).to.be.true;
        });

        it('current_scene matches exact chapter + scene', () => {
            expect(bookDiff.isInScope(chunk, 'current_scene', 'ch-1', 'sc-1')).to.be.true;
            expect(bookDiff.isInScope(chunk, 'current_scene', 'ch-1', 'sc-2')).to.be.false;
        });

        it('current_chapter matches chapter only', () => {
            expect(bookDiff.isInScope(chunk, 'current_chapter', 'ch-1', 'sc-999')).to.be.true;
            expect(bookDiff.isInScope(chunk, 'current_chapter', 'ch-2', null)).to.be.false;
        });

        it('unknown scope defaults to true', () => {
            expect(bookDiff.isInScope(chunk, 'some_unknown_scope', null, null)).to.be.true;
        });
    });
});

describe('Book Diff — Cross-cutting dependencies', () => {
    let bookDiff;

    before(() => {
        bookDiff = createBookDiff();
    });

    it('detects character passport changes and marks scenes', () => {
        const oldBook = {
            characters: [
                { id: 'hero', passport: { base_appearance: 'tall' } },
            ],
            chapters: [{
                chapter: 'ch-1',
                scenes: [{ scene_id: 'sc-1', participants: ['hero'] }],
            }],
        };
        const newBook = {
            characters: [
                { id: 'hero', passport: { base_appearance: 'short' } },
            ],
            chapters: [{
                chapter: 'ch-1',
                scenes: [{ scene_id: 'sc-1', participants: ['hero'] }],
            }],
        };
        const result = bookDiff.computeBookDiff(oldBook, newBook);
        // Scene itself is unchanged, but character change marks it dirty
        const dirty = result.dirty_scenes;
        expect(dirty).to.have.length(1);
        expect(dirty[0].reason).to.equal('characters_passport_changed');
        expect(dirty[0].dirty_layers).to.include.members(['image', 'video']);
        expect(dirty[0].dirty_layers).to.not.include('audio');
    });

    it('detects character voice changes and marks scenes (audio only)', () => {
        const oldBook = {
            characters: [
                { id: 'hero', voice: { instruction: 'deep' } },
            ],
            chapters: [{
                chapter: 'ch-1',
                scenes: [{ scene_id: 'sc-1', participants: ['hero'] }],
            }],
        };
        const newBook = {
            characters: [
                { id: 'hero', voice: { instruction: 'soft' } },
            ],
            chapters: [{
                chapter: 'ch-1',
                scenes: [{ scene_id: 'sc-1', participants: ['hero'] }],
            }],
        };
        const result = bookDiff.computeBookDiff(oldBook, newBook);
        const dirty = result.dirty_scenes;
        expect(dirty).to.have.length(1);
        expect(dirty[0].reason).to.equal('characters_voice_changed');
        expect(dirty[0].dirty_layers).to.deep.equal(['audio']);
    });

    it('detects location changes and marks scenes', () => {
        const oldBook = {
            locations: {
                forest: { description: 'Dark forest' },
            },
            chapters: [{
                chapter: 'ch-1',
                scenes: [{ scene_id: 'sc-1', location: { id: 'forest' } }],
            }],
        };
        const newBook = {
            locations: {
                forest: { description: 'Bright forest' },
            },
            chapters: [{
                chapter: 'ch-1',
                scenes: [{ scene_id: 'sc-1', location: { id: 'forest' } }],
            }],
        };
        const result = bookDiff.computeBookDiff(oldBook, newBook);
        const dirty = result.dirty_scenes;
        expect(dirty).to.have.length(1);
        expect(dirty[0].reason).to.equal('bible_locations_changed');
        expect(dirty[0].dirty_layers).to.include.members(['image', 'video']);
    });

    it('character change affects all scenes referencing that character', () => {
        const oldBook = {
            characters: [
                { id: 'hero', passport: { base_appearance: 'tall' } },
                { id: 'sidekick', passport: { base_appearance: 'short' } },
            ],
            chapters: [{
                chapter: 'ch-1',
                scenes: [
                    { scene_id: 'sc-1', participants: ['hero'] },
                    { scene_id: 'sc-2', participants: ['sidekick'] },
                    { scene_id: 'sc-3', participants: ['hero', 'sidekick'] },
                ],
            }],
        };
        const newBook = {
            characters: [
                { id: 'hero', passport: { base_appearance: 'very tall' } },  // changed
                { id: 'sidekick', passport: { base_appearance: 'short' } },  // unchanged
            ],
            chapters: [{
                chapter: 'ch-1',
                scenes: [
                    { scene_id: 'sc-1', participants: ['hero'] },
                    { scene_id: 'sc-2', participants: ['sidekick'] },
                    { scene_id: 'sc-3', participants: ['hero', 'sidekick'] },
                ],
            }],
        };
        const result = bookDiff.computeBookDiff(oldBook, newBook);
        const dirty = result.dirty_scenes;
        // sc-1 and sc-3 reference 'hero' which changed → both dirty
        const dirtyIds = dirty.map(d => d.scene_id).sort();
        expect(dirtyIds).to.deep.equal(['sc-1', 'sc-3']);
        expect(result.changes['characters.passport']).to.equal(1);  // 1 char changed
    });

    it('new character is detected', () => {
        const oldBook = {
            characters: [{ id: 'hero', passport: { base_appearance: 'tall' } }],
            chapters: [{
                chapter: 'ch-1',
                scenes: [{ scene_id: 'sc-1', participants: ['hero', 'sidekick'] }],
            }],
        };
        const newBook = {
            characters: [
                { id: 'hero', passport: { base_appearance: 'tall' } },
                { id: 'sidekick', passport: { base_appearance: 'short' } },  // new
            ],
            chapters: [{
                chapter: 'ch-1',
                scenes: [{ scene_id: 'sc-1', participants: ['hero', 'sidekick'] }],
            }],
        };
        const result = bookDiff.computeBookDiff(oldBook, newBook);
        const dirty = result.dirty_scenes;
        expect(dirty).to.have.length(1);
        expect(dirty[0].scene_id).to.equal('sc-1');
    });

    it('removed character marks scenes', () => {
        const oldBook = {
            characters: [
                { id: 'hero', passport: { base_appearance: 'tall' } },
                { id: 'sidekick', passport: { base_appearance: 'short' } },
            ],
            chapters: [{
                chapter: 'ch-1',
                scenes: [{ scene_id: 'sc-1', participants: ['hero', 'sidekick'] }],
            }],
        };
        const newBook = {
            characters: [{ id: 'hero', passport: { base_appearance: 'tall' } }],  // sidekick removed
            chapters: [{
                chapter: 'ch-1',
                scenes: [{ scene_id: 'sc-1', participants: ['hero', 'sidekick'] }],
            }],
        };
        const result = bookDiff.computeBookDiff(oldBook, newBook);
        expect(result.dirty_scenes).to.have.length(1);
    });

    it('unchanged book produces no dirty scenes', () => {
        const book = {
            characters: [{ id: 'hero', passport: { base_appearance: 'tall' } }],
            locations: { forest: { description: 'Dark' } },
            chapters: [{
                chapter: 'ch-1',
                scenes: [{ scene_id: 'sc-1', participants: ['hero'], location: { id: 'forest' } }],
            }],
        };
        const result = bookDiff.computeBookDiff(book, book);
        expect(result.dirty_scenes).to.have.length(0);
        expect(result.changes.added).to.equal(0);
        expect(result.changes.removed).to.equal(0);
        expect(result.changes.modified).to.equal(0);
    });
});
