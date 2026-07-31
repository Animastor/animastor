// ======================================================
// Scene PATCH — scene.passport overrides
// ======================================================
// Tests that PATCH /api/v1/book/:bookId/scene/:chapterId/:sceneId with flat
// passport.<charId>.<field> keys (sent WITHOUT unit_id, so they hit the scene
// branch of the handler) correctly:
//   1. Applies overrides to scene.passport[charId][field] via setDeep
//   2. Empty string → null clears the field (falls back to global passport)
//   3. bookDiff detects the change → image + video dirty (no audio)
//   4. resolvePassport() prefers the scene override over the global passport
//
// The test follows the project's route-testing pattern (book-metadata-patch.test.js):
// it simulates exactly what the PATCH handler does (setDeep over fields + save)
// rather than spinning up the express app.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bookModule = require('../src/book/index');
const config = require('../src/config/runtime-config');
const { setDeep } = require('../src/routes/book/scene-patch-utils.cjs');
const promptBuilder = require('../src/image/prompt-builder');

const ORIG_BOOKS_DIR = config.BOOKS_DIR;

// Stub deps for the book-diff factory (mirrors book-diff-unit.test.js)
function createBookDiff() {
    const state = {
        SceneState: {
            NEW: 'new', AUDIO_PENDING: 'audio_pending', AUDIO_GENERATING: 'audio_generating',
            AUDIO_READY: 'audio_ready', IMAGE_PENDING: 'image_pending', IMAGE_GENERATING: 'image_generating',
            IMAGE_READY: 'image_ready', VIDEO_PENDING: 'video_pending', VIDEO_GENERATING: 'video_generating',
            VIDEO_READY: 'video_ready', FAILED: 'failed',
        },
        AssetState: {
            NEW: 'new', DIRTY: 'dirty', PENDING: 'pending', GENERATING: 'generating',
            READY: 'ready', FAILED: 'failed', PLACEHOLDER: 'placeholder',
        },
        SCENE_STATE_KEY_PREFIX: 'animastor:scene-state',
        ASSET_STATE_KEY_PREFIX: 'animastor:asset-state',
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
                if (!bookData || !bookData.chapters) return [];
                const scenes = [];
                for (const ch of bookData.chapters) {
                    for (const sc of (ch.scenes || [])) {
                        scenes.push({
                            chapter_id: ch.chapter_id,
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

describe('Scene PATCH — scene.passport overrides', () => {

    let tmpDir;
    let bookId;
    let bookDir;
    let bookDiff;

    const CHAPTER_ID = 'ch-test';
    const SCENE_ID = 'sc-0001';

    before(() => {
        bookDiff = createBookDiff();
    });

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-passport-patch-'));
        bookId = 'test-passport-' + Date.now();
        bookDir = path.join(tmpDir, bookId);
        fs.mkdirSync(bookDir, { recursive: true });
        fs.mkdirSync(path.join(bookDir, 'chapters'), { recursive: true });

        config.BOOKS_DIR = tmpDir;

        fs.writeFileSync(path.join(bookDir, 'manifest.json'), JSON.stringify({
            book_id: bookId,
            vbook_version: '3.1',
            build_id: 'build-test',
            state: 'BOOTSTRAPPED',
            created_at: new Date().toISOString(),
        }, null, 2));

        fs.writeFileSync(path.join(bookDir, 'book.json'), JSON.stringify({
            book_id: bookId,
            version: '3.0',
            title: 'Test Book',
            author: 'Test Author',
            language: 'ru',
            structure: { chapters_order: ['chapters/ch-test.json'] },
        }, null, 2));

        fs.writeFileSync(path.join(bookDir, 'chapters', 'ch-test.json'), JSON.stringify({
            chapter_id: CHAPTER_ID,
            chapter_title: 'Chapter 1',
            scenes: [{
                scene_id: SCENE_ID,
                scene_title: 'Opening',
                type: 'narration',
                participants: ['hero'],
                location: { id: 'main_street' },
                units: [{ id: 'u1', text: 'The hero arrives.' }],
            }],
        }, null, 2));

        // characters.json with a global passport
        fs.writeFileSync(path.join(bookDir, 'characters.json'), JSON.stringify([
            {
                id: 'hero',
                name: 'Hero',
                passport: {
                    base_appearance: 'Tall, dark hair',
                    clothing_base: 'dark suit',
                    video_tokens: 'global video tokens',
                },
            },
        ], null, 2));

        fs.writeFileSync(path.join(bookDir, 'locations.json'), JSON.stringify({
            main_street: { description: 'Main street', environment: { time: 'day' } },
        }, null, 2));

        fs.writeFileSync(path.join(bookDir, 'voices.json'), JSON.stringify({}));
    });

    afterEach(() => {
        config.BOOKS_DIR = ORIG_BOOKS_DIR;
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    });

    // ── Helper: simulate the scene branch of the PATCH handler ──
    // (fields without unit_id → applied to the scene via setDeep)
    function applySceneFieldsPatch(fields) {
        const oldBook = bookModule.loadBook(bookId);
        const bookBeforePatch = JSON.parse(JSON.stringify(oldBook));

        let targetScene = null;
        for (const ch of oldBook.chapters) {
            if (ch.chapter_id === CHAPTER_ID && ch.scenes) {
                targetScene = ch.scenes.find(s => s.scene_id === SCENE_ID);
                if (targetScene) break;
            }
        }
        if (!targetScene) throw new Error('Scene not found');

        for (const [key, value] of Object.entries(fields)) {
            const resolvedKey = key.startsWith('env.') ? 'location.environment.' + key.slice(4) : key;
            setDeep(targetScene, resolvedKey, value === '' ? null : value);
        }

        bookModule.saveBookBundle(oldBook, null);
        const newBook = bookModule.loadBook(bookId) || oldBook;
        const diff = bookDiff.computeBookDiff(bookBeforePatch, newBook);
        return { newBook, diff };
    }

    // ======================================================
    // Test 1: passport.<charId>.<field> lands on scene.passport
    // ======================================================
    it('applies passport.<charId>.<field> keys to scene.passport', () => {
        applySceneFieldsPatch({
            'passport.hero.clothing_base': 'long grey coat',
        });

        const book = bookModule.loadBook(bookId);
        const scene = book.chapters[0].scenes[0];
        expect(scene.passport.hero.clothing_base).to.equal('long grey coat');
        // Other passport fields untouched — override is per-field
        expect(scene.passport.hero.base_appearance).to.be.undefined;
    });

    // ======================================================
    // Test 2: multiple fields for the same character
    // ======================================================
    it('applies multiple override fields for one character', () => {
        applySceneFieldsPatch({
            'passport.hero.clothing_base': 'long grey coat',
            'passport.hero.clothing_details': 'hat in hand',
            'passport.hero.video_tokens': 'scene override tokens',
        });

        const book = bookModule.loadBook(bookId);
        const scene = book.chapters[0].scenes[0];
        expect(scene.passport.hero).to.deep.equal({
            clothing_base: 'long grey coat',
            clothing_details: 'hat in hand',
            video_tokens: 'scene override tokens',
        });
    });

    // ======================================================
    // Test 3: empty string clears the field (null)
    // ======================================================
    it('clears a previously-set override when empty string is sent', () => {
        // First set the override
        applySceneFieldsPatch({ 'passport.hero.clothing_base': 'long grey coat' });
        // Then clear it — the frontend sends '' for removed values
        applySceneFieldsPatch({ 'passport.hero.clothing_base': '' });

        const book = bookModule.loadBook(bookId);
        const scene = book.chapters[0].scenes[0];
        expect(scene.passport.hero.clothing_base).to.be.null;
    });

    // ======================================================
    // Test 4: bookDiff marks image + video dirty (no audio)
    // ======================================================
    it('bookDiff detects scene.passport change → image + video dirty', () => {
        const { diff } = applySceneFieldsPatch({
            'passport.hero.clothing_base': 'long grey coat',
        });

        expect(diff.dirty_scenes).to.have.length(1);
        expect(diff.dirty_scenes[0].scene_id).to.equal(SCENE_ID);
        expect(diff.dirty_scenes[0].dirty_layers).to.include.members(['image', 'video']);
        expect(diff.dirty_scenes[0].dirty_layers).to.not.include('audio');
    });

    // ======================================================
    // Test 5: no dirty scenes when nothing changed
    // ======================================================
    it('produces no dirty scenes when the override is unchanged', () => {
        applySceneFieldsPatch({ 'passport.hero.clothing_base': 'long grey coat' });
        // Same value again → no diff
        const { diff } = applySceneFieldsPatch({ 'passport.hero.clothing_base': 'long grey coat' });
        expect(diff.dirty_scenes).to.have.length(0);
    });

    // ======================================================
    // Test 6: resolvePassport prefers the scene override
    // ======================================================
    it('resolvePassport prefers the scene override over the global passport', () => {
        const book = bookModule.loadBook(bookId);
        const hero = book.characters.find(c => c.id === 'hero');
        const scene = {
            scene_id: SCENE_ID,
            passport: { hero: { clothing_base: 'long grey coat' } },
        };

        const resolved = promptBuilder.resolvePassport(hero, {}, scene);

        // Overridden field → scene value
        expect(resolved.clothing_base).to.equal('long grey coat');
        // Non-overridden fields → global passport
        expect(resolved.base_appearance).to.equal('Tall, dark hair');
        expect(resolved.detailed_appearance).to.equal('');
    });

    // ======================================================
    // Test 7: resolvePassport falls back to global after a clear
    // ======================================================
    it('resolvePassport falls back to global passport once the override is cleared', () => {
        const book = bookModule.loadBook(bookId);
        const hero = book.characters.find(c => c.id === 'hero');
        const scene = {
            scene_id: SCENE_ID,
            passport: { hero: { clothing_base: null } },  // '' → null on the server
        };

        const resolved = promptBuilder.resolvePassport(hero, {}, scene);
        expect(resolved.clothing_base).to.equal('dark suit');  // global fallback
    });
});
