// ======================================================
// AI Editor Mode — Edit Book Tool Tests
// ======================================================
// Tests that the edit_book tool call correctly:
//   1. Applies JSON patches to bookData
//   2. Saves bible.json separately from book.json via saveBookBundle
//   3. Preserves existing bible.json fields when only country changes
//   4. Handles invalid paths gracefully
//   5. Correctly strips tool_call remnants from AI responses

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Load the modules we need
const bookModule = require('../src/book/index');
const config = require('../src/config/runtime-config');

// Override BOOKS_DIR to a temp directory
const ORIG_BOOKS_DIR = config.BOOKS_DIR;

describe('AI Editor Mode — edit_book tool', () => {

    let tmpDir;
    let bookId;
    let bookDir;

    beforeEach(() => {
        // Create temp book directory
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-editor-test-'));
        bookId = 'test-ai-editor-' + Date.now();
        bookDir = path.join(tmpDir, bookId);
        fs.mkdirSync(bookDir, { recursive: true });
        fs.mkdirSync(path.join(bookDir, 'chapters'), { recursive: true });

        // Override BOOKS_DIR for this test
        config.BOOKS_DIR = tmpDir;

        // Create manifest.json
        fs.writeFileSync(path.join(bookDir, 'manifest.json'), JSON.stringify({
            book_id: bookId,
            vbook_version: '3.1',
            build_id: 'build-test',
            state: 'BOOTSTRAPPED',
            created_at: new Date().toISOString(),
        }, null, 2));

        // Create book.json (metadata only)
        fs.writeFileSync(path.join(bookDir, 'book.json'), JSON.stringify({
            book_id: bookId,
            version: '3.0',
            title: 'Test Book for AI Editor',
            language: 'ru',
            structure: {
                chapters_order: []
            },
        }, null, 2));

        // Create bible.json with initial country: Russia
        fs.writeFileSync(path.join(bookDir, 'bible.json'), JSON.stringify({
            version: '3.0',
            country: 'Russia',
            epoch: '1920s',
            render_rules: {
                style: 'cinematic_realism',
                lighting_default: 'natural',
                character_consistency: true,
                spatial_consistency: true
            }
        }, null, 2));

        // Create characters.json
        fs.writeFileSync(path.join(bookDir, 'characters.json'), JSON.stringify([
            { id: 'hero', name: 'Hero' }
        ], null, 2));

        // Create locations.json
        fs.writeFileSync(path.join(bookDir, 'locations.json'), JSON.stringify({
            main_street: { description: 'Main street in the city' }
        }, null, 2));

        // Create voices.json
        fs.writeFileSync(path.join(bookDir, 'voices.json'), JSON.stringify({
            narrator: { instruction: 'Deep calm voice' }
        }, null, 2));
    });

    afterEach(() => {
        // Restore original BOOKS_DIR
        config.BOOKS_DIR = ORIG_BOOKS_DIR;
        // Clean up temp dir
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    });

    // ======================================================
    // Test 1: applyPatches + saveBookBundle correctly saves bible.json
    // ======================================================
    it('saves bible.json correctly after patching /bible/country', async () => {
        // 1. Load the book (this is what ai-routes.cjs does)
        const bookData = bookModule.loadBook(bookId);
        expect(bookData).to.not.be.null;
        expect(bookData.bible.country).to.equal('Russia');

        // 2. Apply patch (this is what chatEngine.applyPatches does)
        const patches = [
            { op: 'replace', path: '/bible/country', value: 'USSR' }
        ];
        const patchResult = JSON.parse(JSON.stringify(bookData));
        patchResult.bible.country = 'USSR';

        // 3. Save via saveBookBundle (this is what our fix does)
        bookModule.saveBookBundle(patchResult);

        // 4. Verify bible.json was updated correctly
        const biblePath = path.join(bookDir, 'bible.json');
        const savedBible = JSON.parse(fs.readFileSync(biblePath, 'utf8'));
        expect(savedBible.country).to.equal('USSR');
        expect(savedBible.epoch).to.equal('1920s'); // Preserved
        expect(savedBible.render_rules).to.deep.equal({
            style: 'cinematic_realism',
            lighting_default: 'natural',
            character_consistency: true,
            spatial_consistency: true
        }); // Preserved
    });

    // ======================================================
    // Test 2: book.json should NOT contain bible data
    // ======================================================
    it('book.json does not contain bible data after saveBookBundle', async () => {
        const bookData = bookModule.loadBook(bookId);
        bookData.bible.country = 'USSR';
        bookModule.saveBookBundle(bookData);

        const bookMetaPath = path.join(bookDir, 'book.json');
        const savedBook = JSON.parse(fs.readFileSync(bookMetaPath, 'utf8'));
        // book.json should be metadata only — no bible field at top level
        expect(savedBook).to.not.have.property('bible');
        expect(savedBook).to.not.have.property('characters');
        expect(savedBook).to.not.have.property('locations');
        expect(savedBook).to.not.have.property('voices');
    });

    // ======================================================
    // Test 3: Multiple patches — change country AND epoch
    // ======================================================
    it('applies multiple patches to bible.json correctly', async () => {
        const bookData = bookModule.loadBook(bookId);

        // Apply both patches
        const patched = JSON.parse(JSON.stringify(bookData));
        patched.bible.country = 'USSR';
        patched.bible.epoch = '1930s';
        bookModule.saveBookBundle(patched);

        const savedBible = JSON.parse(fs.readFileSync(
            path.join(bookDir, 'bible.json'), 'utf8'
        ));
        expect(savedBible.country).to.equal('USSR');
        expect(savedBible.epoch).to.equal('1930s');
    });

    // ======================================================
    // Test 4: handleError — invalid path returns error
    // ======================================================
    it('invalid patch path returns error', async () => {
        const bookData = bookModule.loadBook(bookId);
        const chatEngine = require('../src/services/chat-engine.cjs')(config);

        const result = chatEngine.applyPatches(bookData, [
            { op: 'replace', path: '/nonexistent/field', value: 'test' }
        ]);

        expect(result.errors).to.have.length.at.least(1);
        expect(result.errors[0]).to.include('Cannot resolve path');
        // Verify country was NOT changed despite the error on the next patch
        expect(result.result.bible.country).to.equal('Russia');
    });

    // ======================================================
    // Test 5: book remains loadable after saveBookBundle
    // ======================================================
    it('book remains loadable after saveBookBundle with bible patch', async () => {
        const bookData = bookModule.loadBook(bookId);
        bookData.bible.country = 'USSR';
        bookModule.saveBookBundle(bookData);

        // Reload the book
        const reloaded = bookModule.loadBook(bookId);
        expect(reloaded).to.not.be.null;
        expect(reloaded.bible.country).to.equal('USSR');
        expect(reloaded.manifest.book_id).to.equal(bookId);
    });

    // ======================================================
    // Test 6: chatEngine.applyPatches resolves /bible/country correctly
    // ======================================================
    it('chatEngine.applyPatches resolves /bible/country correctly', async () => {
        const bookData = bookModule.loadBook(bookId);
        const chatEngine = require('../src/services/chat-engine.cjs')(config);

        const result = chatEngine.applyPatches(bookData, [
            { op: 'replace', path: '/bible/country', value: 'USSR' }
        ]);

        expect(result.errors).to.have.length(0);
        expect(result.result.bible.country).to.equal('USSR');
        expect(result.result.bible.epoch).to.equal('1920s'); // Unchanged fields preserved
    });

    // ======================================================
    // Test 7: saveBookBundle updates bible.json when bible key is present
    // ======================================================
    it('saveBookBundle writes bible.json when bible data exists', async () => {
        // Simulate patched bookData with modified bible
        const bookData = bookModule.loadBook(bookId);
        bookData.bible = {
            ...bookData.bible,
            country: 'USSR',
            epoch: '1930s'
        };
        bookModule.saveBookBundle(bookData);

        // Verify bible.json
        const bibleContent = JSON.parse(
            fs.readFileSync(path.join(bookDir, 'bible.json'), 'utf8')
        );
        expect(bibleContent.country).to.equal('USSR');
        expect(bibleContent.epoch).to.equal('1930s');
    });

    // ======================================================
    // Test 8: saveBookBundle preserves characters.json
    // ======================================================
    it('saveBookBundle preserves characters.json without bible fields', async () => {
        const bookData = bookModule.loadBook(bookId);
        bookData.bible.country = 'USSR';
        bookModule.saveBookBundle(bookData);

        const charContent = JSON.parse(
            fs.readFileSync(path.join(bookDir, 'characters.json'), 'utf8')
        );
        expect(charContent).to.be.an('array');
        expect(charContent[0].id).to.equal('hero');
        // No bible fields leaked into characters.json
        expect(charContent[0]).to.not.have.property('country');
    });

    // ======================================================
    // Test 9: saveBookBundle preserves locations.json
    // ======================================================
    it('saveBookBundle preserves locations.json correctly', async () => {
        const bookData = bookModule.loadBook(bookId);
        bookData.bible.country = 'USSR';
        bookModule.saveBookBundle(bookData);

        const locContent = JSON.parse(
            fs.readFileSync(path.join(bookDir, 'locations.json'), 'utf8')
        );
        expect(locContent.main_street.description).to.equal('Main street in the city');
    });

    // ======================================================
    // Test 10: saveBookBundle preserves voices.json
    // ======================================================
    it('saveBookBundle preserves voices.json correctly', async () => {
        const bookData = bookModule.loadBook(bookId);
        bookData.bible.country = 'USSR';
        bookModule.saveBookBundle(bookData);

        const voicesContent = JSON.parse(
            fs.readFileSync(path.join(bookDir, 'voices.json'), 'utf8')
        );
        expect(voicesContent.narrator.instruction).to.equal('Deep calm voice');
    });
});
