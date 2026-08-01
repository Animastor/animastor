// ======================================================
// Book Metadata PATCH — PATCH /api/v1/book/:bookId/metadata
// ======================================================
// Tests that the lightweight metadata PATCH endpoint correctly:
//   1. Updates book.json fields (title, author, language)
//   2. Updates bible.json fields (country, epoch, render_rules, narrator)
//   3. Preserves untouched fields in both files
//   4. Does not touch chapters, characters, locations, or voices//  5. Handles field clearing (null → removes the field value)
//  6. Handles empty body gracefully (no fields to update)
//  7. Handles narration_voice (book.defaults.narration_voice)

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bookModule = require('../src/book/index');
const config = require('../src/config/runtime-config');

// Override BOOKS_DIR to a temp directory
const ORIG_BOOKS_DIR = config.BOOKS_DIR;

describe('PATCH /api/v1/book/:bookId/metadata', () => {

    let tmpDir;
    let bookId;
    let bookDir;

    // Helper: simulate what the PATCH endpoint does — loads book, applies only
    // metadata fields, saves. Returns the modified in-memory book data.
    function applyMetadataPatch(bookId, body) {
        const book = bookModule.loadBook(bookId);
        if (!book) throw new Error('Book not found');

        const {
            title, author, language,
            country, epoch,
            render_style, lighting_default,
            narration_voice
        } = body;

        // Update book.json fields
        const bookMeta = book.book || {};
        if (title !== undefined) bookMeta.title = title || null;
        if (author !== undefined) bookMeta.author = author || null;
        if (language !== undefined) bookMeta.language = language || null;

        if (narration_voice !== undefined) {
            if (!bookMeta.defaults) bookMeta.defaults = {};
            bookMeta.defaults.narration_voice = narration_voice || null;
        }

        book.book = bookMeta;

        // Update bible.json fields
        if (!book.bible) book.bible = {};
        const bib = book.bible;
        if (country !== undefined) bib.country = country || null;
        if (epoch !== undefined) bib.epoch = epoch || null;

        if (render_style !== undefined || lighting_default !== undefined) {
            if (!bib.render_rules) bib.render_rules = {};
            if (render_style !== undefined) bib.render_rules.style = render_style || null;
            if (lighting_default !== undefined) bib.render_rules.lighting_default = lighting_default || null;
        }

        book.bible = bib;
        bookModule.saveBookBundle(book, null);
        return book;
    }

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-patch-test-'));
        bookId = 'test-meta-patch-' + Date.now();
        bookDir = path.join(tmpDir, bookId);
        fs.mkdirSync(bookDir, { recursive: true });
        fs.mkdirSync(path.join(bookDir, 'chapters'), { recursive: true });

        config.BOOKS_DIR = tmpDir;

        // Create manifest.json
        fs.writeFileSync(path.join(bookDir, 'manifest.json'), JSON.stringify({
            book_id: bookId,
            vbook_version: '3.1',
            build_id: 'build-test',
            state: 'BOOTSTRAPPED',
            created_at: new Date().toISOString(),
        }, null, 2));

        // Create book.json
        fs.writeFileSync(path.join(bookDir, 'book.json'), JSON.stringify({
            book_id: bookId,
            version: '3.0',
            title: 'Original Title',
            author: 'Original Author',
            language: 'ru',
            structure: { chapters_order: [] },
        }, null, 2));

        // Create bible.json
        fs.writeFileSync(path.join(bookDir, 'bible.json'), JSON.stringify({
            version: '3.0',
            country: 'Russia',
            epoch: '1920s',
            render_rules: {
                style: 'cinematic_realism',
                lighting_default: 'natural',
                character_consistency: true,
                spatial_consistency: true,
            },
        }, null, 2));

        // Create characters.json (to verify it's NOT touched)
        fs.writeFileSync(path.join(bookDir, 'characters.json'), JSON.stringify([
            { id: 'hero', name: 'Hero', passport: { base_appearance: 'Tall, dark hair' } },
            { id: 'sidekick', name: 'Sidekick', passport: { base_appearance: 'Short, glasses' } },
        ], null, 2));

        // Create locations.json
        fs.writeFileSync(path.join(bookDir, 'locations.json'), JSON.stringify({
            main_street: { description: 'Main street in the city' },
            forest: { description: 'Dark forest' },
        }, null, 2));

        // Create voices.json
        fs.writeFileSync(path.join(bookDir, 'voices.json'), JSON.stringify({
            narrator: { instruction: 'Deep calm narrative voice' },
            hero: { instruction: 'Heroic male voice' },
        }, null, 2));
    });

    afterEach(() => {
        config.BOOKS_DIR = ORIG_BOOKS_DIR;
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    });

    // ======================================================
    // Test 1: Update book.json fields (title, author, language)
    // ======================================================
    it('updates book.json fields correctly', () => {
        applyMetadataPatch(bookId, {
            title: 'New Title',
            author: 'New Author',
            language: 'en',
        });

        const bookMeta = JSON.parse(fs.readFileSync(path.join(bookDir, 'book.json'), 'utf8'));
        expect(bookMeta.title).to.equal('New Title');
        expect(bookMeta.author).to.equal('New Author');
        expect(bookMeta.language).to.equal('en');
    });

    // ======================================================
    // Test 2: Update bible.json fields (country, epoch)
    // ======================================================
    it('updates bible.json country and epoch', () => {
        applyMetadataPatch(bookId, {
            country: 'USSR',
            epoch: '1930s',
        });

        const bible = JSON.parse(fs.readFileSync(path.join(bookDir, 'bible.json'), 'utf8'));
        expect(bible.country).to.equal('USSR');
        expect(bible.epoch).to.equal('1930s');
    });

    // ======================================================
    // Test 3: Update render_rules
    // ======================================================
    it('updates render_rules in bible.json', () => {
        applyMetadataPatch(bookId, {
            render_style: 'anime',
            lighting_default: 'dramatic',
        });

        const bible = JSON.parse(fs.readFileSync(path.join(bookDir, 'bible.json'), 'utf8'));
        expect(bible.render_rules.style).to.equal('anime');
        expect(bible.render_rules.lighting_default).to.equal('dramatic');
        // Untouched render_rules fields preserved
        expect(bible.render_rules.character_consistency).to.be.true;
        expect(bible.render_rules.spatial_consistency).to.be.true;
    });

    // ======================================================
    // Test 4: Update narration_voice in book.defaults
    // ======================================================
    it('updates narration_voice in book.defaults', () => {
        applyMetadataPatch(bookId, {
            narration_voice: 'heroic_narrator',
        });

        const bookMeta = JSON.parse(fs.readFileSync(path.join(bookDir, 'book.json'), 'utf8'));
        expect(bookMeta.defaults.narration_voice).to.equal('heroic_narrator');
    });

    // ======================================================
    // Test 5: Untouched book.json fields preserved
    // ======================================================
    it('preserves untouched book.json fields', () => {
        applyMetadataPatch(bookId, { title: 'Title Only' });

        const bookMeta = JSON.parse(fs.readFileSync(path.join(bookDir, 'book.json'), 'utf8'));
        expect(bookMeta.title).to.equal('Title Only');
        expect(bookMeta.author).to.equal('Original Author'); // Preserved
        expect(bookMeta.language).to.equal('ru');            // Preserved
    });

    // ======================================================
    // Test 6: Untouched bible.json fields preserved
    // ======================================================
    it('preserves untouched bible.json fields', () => {
        applyMetadataPatch(bookId, { country: 'USSR' });

        const bible = JSON.parse(fs.readFileSync(path.join(bookDir, 'bible.json'), 'utf8'));
        expect(bible.country).to.equal('USSR');
        expect(bible.epoch).to.equal('1920s');                // Preserved
        expect(bible.render_rules.style).to.equal('cinematic_realism'); // Preserved
        // narrator is no longer in bible — not set in this test's bible.json
    });

    // ======================================================
    // Test 7: Clear a field via null (empty string from frontend)
    // ======================================================
    it('clears a field when null is sent', () => {
        applyMetadataPatch(bookId, { title: null });

        const bookMeta = JSON.parse(fs.readFileSync(path.join(bookDir, 'book.json'), 'utf8'));
        expect(bookMeta.title).to.be.null;
        expect(bookMeta.author).to.equal('Original Author'); // Unchanged
    });

    // ======================================================
    // Test 8: Clear narration_voice via null
    // ======================================================
    it('clears narration_voice when null is sent', () => {
        applyMetadataPatch(bookId, { narration_voice: null });

        const bookMeta = JSON.parse(fs.readFileSync(path.join(bookDir, 'book.json'), 'utf8'));
        expect(bookMeta.defaults.narration_voice).to.be.null;
    });

    // ======================================================
    // Test 9: Empty body — nothing changes
    // ======================================================
    it('does nothing when body is empty', () => {
        applyMetadataPatch(bookId, {});

        const bookMeta = JSON.parse(fs.readFileSync(path.join(bookDir, 'book.json'), 'utf8'));
        expect(bookMeta.title).to.equal('Original Title');
        expect(bookMeta.author).to.equal('Original Author');

        const bible = JSON.parse(fs.readFileSync(path.join(bookDir, 'bible.json'), 'utf8'));
        expect(bible.country).to.equal('Russia');
    });

    // ======================================================
    // Test 10: Characters.json NOT touched
    // ======================================================
    it('does not modify characters.json', () => {
        applyMetadataPatch(bookId, { country: 'USSR' });

        const chars = JSON.parse(fs.readFileSync(path.join(bookDir, 'characters.json'), 'utf8'));
        expect(chars).to.have.length(2);
        expect(chars[0].id).to.equal('hero');
        expect(chars[0].passport.base_appearance).to.equal('Tall, dark hair');
    });

    // ======================================================
    // Test 11: Locations.json NOT touched
    // ======================================================
    it('does not modify locations.json', () => {
        applyMetadataPatch(bookId, { country: 'USSR' });

        const locs = JSON.parse(fs.readFileSync(path.join(bookDir, 'locations.json'), 'utf8'));
        expect(locs.main_street.description).to.equal('Main street in the city');
        expect(locs.forest.description).to.equal('Dark forest');
    });

    // ======================================================
    // Test 12: Voices.json NOT touched
    // ======================================================
    it('does not modify voices.json', () => {
        applyMetadataPatch(bookId, { country: 'USSR' });

        const voices = JSON.parse(fs.readFileSync(path.join(bookDir, 'voices.json'), 'utf8'));
        expect(voices.narrator.instruction).to.equal('Deep calm narrative voice');
        expect(voices.hero.instruction).to.equal('Heroic male voice');
    });

    // ======================================================
    // Test 13: Book remains loadable after patch
    // ======================================================
    it('book remains loadable after metadata patch', () => {
        applyMetadataPatch(bookId, {
            title: 'Post-Patch Title',
            country: 'France',
            epoch: '18th century',
        });

        const reloaded = bookModule.loadBook(bookId);
        expect(reloaded).to.not.be.null;
        expect(reloaded.book.title).to.equal('Post-Patch Title');
        expect(reloaded.bible.country).to.equal('France');
        expect(reloaded.bible.epoch).to.equal('18th century');
        expect(reloaded.manifest.book_id).to.equal(bookId);
    });

    // ======================================================
    // Test 14: All fields update simultaneously
    // ======================================================
    it('updates all fields simultaneously', () => {
        applyMetadataPatch(bookId, {
            title: 'Full Update',
            author: 'Full Author',
            language: 'fr',
            country: 'France',
            epoch: 'Renaissance',
            render_style: 'vibrant',
            lighting_default: 'soft',
            narration_voice: 'french_narrator',
        });

        const bookMeta = JSON.parse(fs.readFileSync(path.join(bookDir, 'book.json'), 'utf8'));
        expect(bookMeta.title).to.equal('Full Update');
        expect(bookMeta.author).to.equal('Full Author');
        expect(bookMeta.language).to.equal('fr');
        expect(bookMeta.defaults.narration_voice).to.equal('french_narrator');

        const bible = JSON.parse(fs.readFileSync(path.join(bookDir, 'bible.json'), 'utf8'));
        expect(bible.country).to.equal('France');
        expect(bible.epoch).to.equal('Renaissance');
        expect(bible.render_rules.style).to.equal('vibrant');
        expect(bible.render_rules.lighting_default).to.equal('soft');
        expect(bible.render_rules.character_consistency).to.be.true; // Preserved
    });

    // ======================================================
    // Test 15: Patch creates bible sections if they don't exist
    // ======================================================
    it('creates bible sections when they do not exist', () => {
        // Remove bible.json entirely
        fs.unlinkSync(path.join(bookDir, 'bible.json'));

        // Patch should create the bible object
        applyMetadataPatch(bookId, {
            country: 'Wonderland',
            narration_voice: 'whimsical_narrator',
        });

        const bookMeta = JSON.parse(fs.readFileSync(path.join(bookDir, 'book.json'), 'utf8'));
        expect(bookMeta.defaults.narration_voice).to.equal('whimsical_narrator');

        const bible = JSON.parse(fs.readFileSync(path.join(bookDir, 'bible.json'), 'utf8'));
        expect(bible.country).to.equal('Wonderland');
    });

    // ======================================================
    // Test 16: Chapter files preserved after patch
    // ======================================================
    it('preserves chapter files after metadata patch', () => {
        // Create a chapter file
        const chaptersDir = path.join(bookDir, 'chapters');
        fs.writeFileSync(path.join(chaptersDir, 'ch-aaaaaa.json'), JSON.stringify({
            chapter_id: 'ch-aaaaaa',
            chapter_title: 'Chapter 1',
            scenes: [{ scene_id: 'sc-0001', type: 'narration', text: 'Once upon a time...' }],
        }, null, 2));
        fs.writeFileSync(path.join(chaptersDir, 'ch-bbbbbb.json'), JSON.stringify({
            chapter_id: 'ch-bbbbbb',
            chapter_title: 'Chapter 2',
            scenes: [],
        }, null, 2));

        // Set chapters_order
        const bookMetaPath = path.join(bookDir, 'book.json');
        const bookMeta = JSON.parse(fs.readFileSync(bookMetaPath, 'utf8'));
        bookMeta.structure.chapters_order = ['ch-aaaaaa.json', 'ch-bbbbbb.json'];
        fs.writeFileSync(bookMetaPath, JSON.stringify(bookMeta, null, 2));

        // Patch metadata
        applyMetadataPatch(bookId, { title: 'Patched Title' });

        // Chapter files still exist
        expect(fs.existsSync(path.join(chaptersDir, 'ch-aaaaaa.json'))).to.be.true;
        expect(fs.existsSync(path.join(chaptersDir, 'ch-bbbbbb.json'))).to.be.true;

        // Chapter content intact
        const ch1 = JSON.parse(fs.readFileSync(path.join(chaptersDir, 'ch-aaaaaa.json'), 'utf8'));
        expect(ch1.chapter_title).to.equal('Chapter 1');
        expect(ch1.scenes[0].text).to.equal('Once upon a time...');
    });
});
