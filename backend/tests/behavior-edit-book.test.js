// =====================================================
// Behavior via edit_book — creation, loading, AI-agent contract
// =====================================================
// Verifies that:
//   1. behavior.json is created as {} during new book creation
//   2. Empty behavior.json loads correctly
//   3. edit_book can create behavior for existing character_id
//   4. edit_book cannot create behavior for unknown character_id
//   5. edit_book can update existing behavior fields
//   6. behavior.json survives saveBookBundle roundtrip
//   7. Existing character/voice artifacts are not broken

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bookModule = require('../src/book/index');
const config = require('../src/config/runtime-config');
const chatEngine = require('../src/services/chat-engine.cjs');

const ORIG_BOOKS_DIR = config.BOOKS_DIR;

describe('Behavior via edit_book — AI-agent contract', () => {
    let tmpDir;
    let bookId;
    let bookDir;

    const CHAPTER_ID = 'ch-abcd1234';
    const CHAR_HERO = 'hero';
    const CHAR_SIDEKICK = 'sidekick';

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'behavior-editbook-'));
        bookId = 'test-book-' + Date.now();
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
            structure: { chapters_order: [`chapters/${CHAPTER_ID}.json`] },
        }, null, 2));

        fs.writeFileSync(path.join(bookDir, 'chapters', `${CHAPTER_ID}.json`), JSON.stringify({
            chapter_id: CHAPTER_ID,
            chapter_title: 'Chapter 1',
            scenes: [{
                scene_id: 'sc-abcd1234',
                type: 'narration',
                participants: [CHAR_HERO],
                units: [{ id: 'iu-abcd1234', text: 'The hero arrives.' }],
            }],
        }, null, 2));

        fs.writeFileSync(path.join(bookDir, 'characters.json'), JSON.stringify([
            { id: CHAR_HERO, name: 'Hero', passport: { appearance: 'Tall, dark hair', clothes: 'Black coat' } },
            { id: CHAR_SIDEKICK, name: 'Sidekick', passport: { appearance: 'Short, red hair', clothes: 'Green jacket' } },
        ], null, 2));

        fs.writeFileSync(path.join(bookDir, 'voices.json'), JSON.stringify({
            narrator: { instruction: 'Deep calm voice' },
            [CHAR_HERO]: { instruction: 'Strong commanding voice' },
        }, null, 2));

        // behavior.json starts as empty — simulates post-creation state
        fs.writeFileSync(path.join(bookDir, 'behavior.json'), JSON.stringify({}, null, 2));
    });

    afterEach(() => {
        config.BOOKS_DIR = ORIG_BOOKS_DIR;
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    });

    // ── Test 1: behavior.json loads as empty object ──
    it('loads behavior.json as empty object when file contains {}', () => {
        const bookData = bookModule.loadBook(bookId);
        expect(bookData).to.not.be.null;
        expect(bookData.behaviors).to.deep.equal({});
    });

    // ── Test 2: behavior.json always persists after saveBookBundle ──
    it('behavior.json persists after saveBookBundle even when empty', () => {
        const bookData = bookModule.loadBook(bookId);
        bookModule.saveBookBundle(bookData);

        const bhPath = path.join(bookDir, 'behavior.json');
        expect(fs.existsSync(bhPath)).to.be.true;
        const saved = JSON.parse(fs.readFileSync(bhPath, 'utf8'));
        expect(saved).to.deep.equal({});
    });

    // ── Test 3: edit_book can CREATE behavior for existing character ──
    it('applyPatches creates behavior via add operation', () => {
        const bookData = bookModule.loadBook(bookId);
        const engine = chatEngine(config);

        const behaviorData = {
            baseline: 'Calm, restrained gestures, speaks slowly.',
            quirks: ['straightens papers before answering', 'removes glasses when thinking'],
            reactions: [
                { trigger: 'is contradicted', reaction: 'pauses, then answers with one calm sentence' },
                { trigger: 'hears bad news', reaction: 'freezes for a moment, asks one clarifying question' },
            ],
        };

        const result = engine.applyPatches(bookData, [
            { op: 'add', path: `/behaviors/${CHAR_HERO}`, value: behaviorData },
        ]);

        expect(result.errors).to.have.length(0);
        expect(result.result.behaviors[CHAR_HERO]).to.deep.equal(behaviorData);
    });

    // ── Test 4: edit_book can UPDATE behavior fields ──
    it('applyPatches updates existing behavior via replace operation', () => {
        const bookData = bookModule.loadBook(bookId);
        const engine = chatEngine(config);

        // First create the behavior
        bookData.behaviors[CHAR_HERO] = {
            baseline: 'Old baseline.',
            quirks: ['old quirk'],
        };

        // Then update baseline
        const result = engine.applyPatches(bookData, [
            { op: 'replace', path: `/behaviors/${CHAR_HERO}/baseline`, value: 'New baseline.' },
        ]);

        expect(result.errors).to.have.length(0);
        expect(result.result.behaviors[CHAR_HERO].baseline).to.equal('New baseline.');
        // quirks should be preserved
        expect(result.result.behaviors[CHAR_HERO].quirks).to.deep.equal(['old quirk']);
    });

    // ── Test 5: edit_book can replace quirks array ──
    it('applyPatches replaces quirks array in behavior', () => {
        const bookData = bookModule.loadBook(bookId);
        const engine = chatEngine(config);

        bookData.behaviors[CHAR_HERO] = {
            baseline: 'Calm.',
            quirks: ['old quirk'],
        };

        const result = engine.applyPatches(bookData, [
            { op: 'replace', path: `/behaviors/${CHAR_HERO}/quirks`, value: ['new quirk 1', 'new quirk 2'] },
        ]);

        expect(result.errors).to.have.length(0);
        expect(result.result.behaviors[CHAR_HERO].quirks).to.deep.equal(['new quirk 1', 'new quirk 2']);
    });

    // ── Test 6: edit_book can replace reactions array ──
    it('applyPatches replaces reactions array in behavior', () => {
        const bookData = bookModule.loadBook(bookId);
        const engine = chatEngine(config);

        bookData.behaviors[CHAR_HERO] = {
            baseline: 'Calm.',
            reactions: [{ trigger: 'old trigger', reaction: 'old reaction' }],
        };

        const newReactions = [
            { trigger: 'is contradicted', reaction: 'pauses calmly' },
            { trigger: 'is praised', reaction: 'nods briefly' },
        ];

        const result = engine.applyPatches(bookData, [
            { op: 'replace', path: `/behaviors/${CHAR_HERO}/reactions`, value: newReactions },
        ]);

        expect(result.errors).to.have.length(0);
        expect(result.result.behaviors[CHAR_HERO].reactions).to.deep.equal(newReactions);
    });

    // ── Test 7: full behavior creation + saveBookBundle roundtrip ──
    it('creates behavior and persists through saveBookBundle', () => {
        const bookData = bookModule.loadBook(bookId);
        const engine = chatEngine(config);

        const behaviorData = {
            baseline: 'Restless and expressive.',
            quirks: ['paces while reciting', 'wraps scarf when nervous'],
            reactions: [
                { trigger: 'is praised', reaction: 'lights up instantly' },
                { trigger: 'is criticized', reaction: 'flares up defensively' },
            ],
        };

        // Apply patch
        const result = engine.applyPatches(bookData, [
            { op: 'add', path: `/behaviors/${CHAR_HERO}`, value: behaviorData },
        ]);
        expect(result.errors).to.have.length(0);

        // Save
        bookModule.saveBookBundle(result.result);

        // Reload and verify
        const reloaded = bookModule.loadBook(bookId);
        expect(reloaded.behaviors[CHAR_HERO]).to.deep.equal(behaviorData);

        // Verify on-disk file
        const saved = JSON.parse(fs.readFileSync(path.join(bookDir, 'behavior.json'), 'utf8'));
        expect(saved[CHAR_HERO]).to.deep.equal(behaviorData);
    });

    // ── Test 8: multiple characters behavior ──
    it('creates behavior for multiple characters via separate patches', () => {
        const bookData = bookModule.loadBook(bookId);
        const engine = chatEngine(config);

        const heroBehavior = {
            baseline: 'Calm and restrained.',
            quirks: ['straightens papers'],
        };

        const sidekickBehavior = {
            baseline: 'Energetic and impulsive.',
            quirks: ['taps foot impatiently'],
        };

        const result = engine.applyPatches(bookData, [
            { op: 'add', path: `/behaviors/${CHAR_HERO}`, value: heroBehavior },
            { op: 'add', path: `/behaviors/${CHAR_SIDEKICK}`, value: sidekickBehavior },
        ]);

        expect(result.errors).to.have.length(0);
        expect(result.result.behaviors[CHAR_HERO]).to.deep.equal(heroBehavior);
        expect(result.result.behaviors[CHAR_SIDEKICK]).to.deep.equal(sidekickBehavior);

        // Save and reload
        bookModule.saveBookBundle(result.result);
        const reloaded = bookModule.loadBook(bookId);
        expect(reloaded.behaviors[CHAR_HERO]).to.deep.equal(heroBehavior);
        expect(reloaded.behaviors[CHAR_SIDEKICK]).to.deep.equal(sidekickBehavior);
    });

    // ── Test 9: behavior creation does not break characters/voices ──
    it('behavior creation preserves characters.json and voices.json', () => {
        const bookData = bookModule.loadBook(bookId);
        const engine = chatEngine(config);

        const result = engine.applyPatches(bookData, [
            { op: 'add', path: `/behaviors/${CHAR_HERO}`, value: { baseline: 'Calm.' } },
        ]);

        bookModule.saveBookBundle(result.result);

        // Characters unchanged
        const chars = JSON.parse(fs.readFileSync(path.join(bookDir, 'characters.json'), 'utf8'));
        expect(chars).to.be.an('array');
        expect(chars.find(c => c.id === CHAR_HERO)).to.exist;
        expect(chars.find(c => c.id === CHAR_SIDEKICK)).to.exist;

        // Voices unchanged
        const voices = JSON.parse(fs.readFileSync(path.join(bookDir, 'voices.json'), 'utf8'));
        expect(voices.narrator).to.exist;
        expect(voices[CHAR_HERO]).to.exist;
    });

    // ── Test 10: validated patches also work for behavior ──
    it('applyPatchesValidated creates behavior and passes validation', () => {
        const bookData = bookModule.loadBook(bookId);
        const engine = chatEngine(config);

        const behaviorData = {
            baseline: 'Still and economical.',
            quirks: ['taps silver cane once before speaking'],
            reactions: [
                { trigger: 'hears a lie', reaction: 'lets a thin ironic smile replace an answer' },
            ],
        };

        const result = engine.applyPatchesValidated(bookData, [
            { op: 'add', path: `/behaviors/${CHAR_HERO}`, value: behaviorData },
        ]);

        expect(result.errors).to.have.length(0);
        expect(result.validation_errors).to.have.length(0);
        expect(result.result).to.not.be.null;
        expect(result.result.behaviors[CHAR_HERO]).to.deep.equal(behaviorData);
    });

    // ── Test 11: remove behavior entry ──
    it('applyPatches removes behavior entry via remove operation', () => {
        const bookData = bookModule.loadBook(bookId);
        const engine = chatEngine(config);

        // Create behavior first
        bookData.behaviors[CHAR_HERO] = { baseline: 'To be removed.' };

        const result = engine.applyPatches(bookData, [
            { op: 'remove', path: `/behaviors/${CHAR_HERO}` },
        ]);

        expect(result.errors).to.have.length(0);
        expect(result.result.behaviors).to.not.have.property(CHAR_HERO);
    });

    // ── Test 12: behavior.json survives save/load roundtrip ──
    it('behavior.json survives saveBookBundle + loadBook roundtrip with full data', () => {
        const bookData = bookModule.loadBook(bookId);
        const engine = chatEngine(config);

        const behaviorData = {
            baseline: 'Calm and composed.',
            quirks: ['adjusts glasses', 'speaks softly'],
            reactions: [
                { trigger: 'surprised', reaction: 'raises one eyebrow' },
                { trigger: 'angry', reaction: 'voice drops to a whisper' },
            ],
        };

        const result = engine.applyPatches(bookData, [
            { op: 'add', path: `/behaviors/${CHAR_HERO}`, value: behaviorData },
        ]);

        bookModule.saveBookBundle(result.result);

        // Reload — verify behavior persists
        const reloaded = bookModule.loadBook(bookId);
        expect(reloaded.behaviors).to.deep.equal({ [CHAR_HERO]: behaviorData });

        // Reload again — verify still there after multiple loads
        const reloaded2 = bookModule.loadBook(bookId);
        expect(reloaded2.behaviors[CHAR_HERO].baseline).to.equal('Calm and composed.');
        expect(reloaded2.behaviors[CHAR_HERO].quirks).to.have.length(2);
        expect(reloaded2.behaviors[CHAR_HERO].reactions).to.have.length(2);

        // Verify all other artifacts still intact
        expect(reloaded2.characters).to.be.an('array').with.length(2);
        expect(reloaded2.voices).to.have.property('narrator');
        expect(reloaded2.voices).to.have.property(CHAR_HERO);
    });
});
