// ======================================================
// PATCH CHARACTER — global passport persistence
// ======================================================
// Verifies the save path the editors use for the Characters tab:
//   1. PATCH /characters/{id} with flat "passport.<field>" keys → setDeep on
//      the character → characters.json updated (the generator reads this file)
//   2. Empty string → null clears a passport field (so clearing persists)
//   3. video_tokens comma-text → array (normalizeFieldValue)
//   4. Regression guard: the OLD Android behavior (char.* keys sent to the
//      scene PATCH with unit_id) must NOT touch characters.json — it only
//      wrote junk keys into the unit object.
//
// Mirrors the project's route-testing pattern (book-metadata-patch.test.js /
// scene-passport-patch.test.js): it simulates exactly what the PATCH handler
// does (setDeep over fields + save) rather than spinning up the express app.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bookModule = require('../src/book/index');
const config = require('../src/config/runtime-config');
const { setDeep, normalizeFieldValue, findUnitInScene } = require('../src/routes/book/scene-patch-utils.cjs');
const promptBuilder = require('../src/image/prompt-builder');

const ORIG_BOOKS_DIR = config.BOOKS_DIR;

describe('PATCH CHARACTER — global passport persistence', () => {

    let tmpDir;
    let bookId;
    let bookDir;

    const CHAPTER_ID = 'ch-test';
    const SCENE_ID = 'sc-0001';

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'character-patch-'));
        bookId = 'test-char-' + Date.now();
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

        fs.writeFileSync(path.join(bookDir, 'characters.json'), JSON.stringify([
            {
                id: 'hero',
                name: 'Hero',
                passport: {
                    appearance: 'Tall, dark hair',
                    clothes: 'dark suit',
                    video_tokens: ['global video tokens'],
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

    function readCharacters() {
        return JSON.parse(fs.readFileSync(path.join(bookDir, 'characters.json'), 'utf8'));
    }

    function readScene() {
        return JSON.parse(fs.readFileSync(path.join(bookDir, 'chapters', 'ch-test.json'), 'utf8')).scenes[0];
    }

    // ── Helper: simulate the PATCH CHARACTER handler ──
    // (fields = flat dotted keys like "passport.appearance" → setDeep on the char)
    function applyCharacterFieldsPatch(characterId, fields) {
        const oldBook = bookModule.loadBook(bookId);
        const char = (oldBook.characters || []).find(c => c && c.id === characterId);
        if (!char) throw new Error(`Character ${characterId} not found`);

        for (const [key, value] of Object.entries(fields)) {
            setDeep(char, key, normalizeFieldValue(key, value));
        }
        bookModule.saveBookBundle(oldBook, null);
        return bookModule.loadBook(bookId) || oldBook;
    }

    // ── Helper: simulate the OLD Android leak ──
    // (char.* keys sent to the scene PATCH WITH unit_id → setDeep on the unit)
    function applyLeakyScenePatch(fields) {
        const oldBook = bookModule.loadBook(bookId);
        const targetScene = oldBook.chapters[0].scenes[0];
        const unit = findUnitInScene(targetScene, 'u1');
        if (!unit) throw new Error('Unit not found');

        for (const [key, value] of Object.entries(fields)) {
            setDeep(unit, key, normalizeFieldValue(key, value));
        }
        bookModule.saveBookBundle(oldBook, null);
    }

    // ======================================================
    // Test 1: passport.appearance lands in characters.json
    // ======================================================
    it('persists passport.<field> keys to characters.json', () => {
        applyCharacterFieldsPatch('hero', {
            'passport.appearance': 'short blond hair',
            'passport.clothes': 'leather jacket',
        });

        const chars = readCharacters();
        const hero = chars.find(c => c.id === 'hero');
        expect(hero.passport.appearance).to.equal('short blond hair');
        expect(hero.passport.clothes).to.equal('leather jacket');
        // Unrelated field untouched
        expect(hero.passport.video_tokens).to.deep.equal(['global video tokens']);
    });

    // ======================================================
    // Test 2: empty string clears a passport field (null)
    // ======================================================
    it('clears a passport field when the editor sends an empty string', () => {
        applyCharacterFieldsPatch('hero', { 'passport.appearance': '' });

        const chars = readCharacters();
        const hero = chars.find(c => c.id === 'hero');
        expect(hero.passport.appearance).to.be.null;
        expect(hero.passport.clothes).to.equal('dark suit');
    });

    // ======================================================
    // Test 3: video_tokens comma-text → array
    // ======================================================
    it('normalizes comma-joined video_tokens text back into an array', () => {
        applyCharacterFieldsPatch('hero', {
            'passport.video_tokens': 'short blond hair, leather jacket',
        });

        const chars = readCharacters();
        const hero = chars.find(c => c.id === 'hero');
        expect(hero.passport.video_tokens).to.deep.equal(['short blond hair', 'leather jacket']);
    });

    // ======================================================
    // Test 4: the generator reads the updated passport
    // ======================================================
    it('image prompt builder sees the updated global passport', () => {
        applyCharacterFieldsPatch('hero', {
            'passport.appearance': 'tall and thin, grey eyes',
            'passport.clothes': 'long grey coat',
        });

        const book = bookModule.loadBook(bookId);
        const scene = book.chapters[0].scenes[0];
        const out = promptBuilder.buildCharacters(scene, null, book.chapters[0], book);
        expect(out).to.have.length(1);
        expect(out[0]).to.include('tall and thin, grey eyes');
        expect(out[0]).to.include('long grey coat');
    });

    // ======================================================
    // Test 5: regression — old Android leak never touches characters.json
    // ======================================================
    it('char.* keys sent to the scene PATCH must NOT reach characters.json', () => {
        // Before: canonical appearance
        expect(readCharacters()[0].passport.appearance).to.equal('Tall, dark hair');

        // The OLD Android save pushed the whole fieldValues (char.<id>.passport.*)
        // into the scene PATCH with unit_id — the server setDeep'd them into the
        // unit. Characters.json must stay untouched.
        applyLeakyScenePatch({
            'char.hero.passport.appearance': 'short hair',
            'char.hero.passport.clothes': 'leather jacket',
        });

        const chars = readCharacters();
        expect(chars[0].passport.appearance).to.equal('Tall, dark hair');
        expect(chars[0].passport.clothes).to.equal('dark suit');

        // The junk DID land in the unit — that is exactly why the leak is wrong
        // (it saves "successfully" while persisting nothing the generator reads).
        const scene = readScene();
        expect(findUnitInScene(scene, 'u1')).to.have.property('char');
    });
});
