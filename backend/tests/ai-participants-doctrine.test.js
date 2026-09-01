// ======================================================
// Scene Participants Doctrine — Normalization & Validation
// ======================================================
// Regression coverage for the real incident: the AI assistant was asked
// to keep only character_ids in scene.participants ("оставь только id
// героев, имена убери"). The model:
//   1. wrapped values in {"item": [...]} (a JSON-Schema `items`
//      hallucination) — which previously passed the bundle contract and
//      corrupted the book on disk,
//   2. left display names alongside IDs (["Юра","yura"]) — the task was
//      only half-done.
//
// Guards added:
//   - bundle-validator rejects a non-array / non-string participants value,
//   - chat-engine.applyPatchesValidated normalizes participants across ALL
//     scenes (unwrap {"item": x}, map display names → character_id, dedupe)
//     before validation, so the request always lands in canonical form.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bookModule = require('../src/book/index');
const chatEngine = require('../src/services/chat-engine.cjs')({});
const { validateBundleObject } = require('../src/book/bundle-validator.cjs');
const config = require('../src/config/runtime-config');

const ORIG_BOOKS_DIR = config.BOOKS_DIR;

function makeFixtureBook(overrides = {}) {
    return {
        manifest: { book_id: 'test-part', vbook_version: '3.1', state: 'BOOTSTRAPPED' },
        book: { book_id: 'test-part', title: 'Participants Test', structure: { chapters_order: [] } },
        bible: {},
        locations: {},
        voices: {},
        behaviors: {},
        characters: [
            { id: 'yura', name: 'Юра' },
            { id: 'svetlana', name: 'Светлана' },
        ],
        chapters: [
            {
                chapter_id: 'ch-aaaaaa',
                chapter_title: 'Ch 1',
                scenes: [
                    { scene_id: 'sc-bbbbbb', participants: ['yura', 'svetlana'] },
                    { scene_id: 'sc-cccccc', participants: ['Юра', 'yura'] },
                    { scene_id: 'sc-dddddd', participants: { item: ['yura', 'svetlana'] } },
                    { scene_id: 'sc-eeeeee', participants: { item: 'svetlana' } },
                    { scene_id: 'sc-ffffff', participants: 'yura' },
                    { scene_id: 'sc-000001', participants: null },
                    { scene_id: 'sc-000002', participants: ['yura', 'yura', 'svetlana'] },
                ],
            },
        ],
        ...overrides,
    };
}

describe('Scene Participants doctrine — normalization + validation', () => {
    it('applyPatchesValidated unwraps {"item": x} into an ID array across all scenes', () => {
        const book = makeFixtureBook();
        // Model hallucination: patches that wrap values in {"item": ...}.
        const patchResult = chatEngine.applyPatchesValidated(book, [
            { op: 'replace', path: '/chapters/0/scenes/2/participants', value: { item: ['yura', 'svetlana'] } },
            { op: 'replace', path: '/chapters/0/scenes/3/participants', value: { item: 'svetlana' } },
        ]);
        expect(patchResult.errors).to.have.lengthOf(0);
        const scenes = patchResult.result.chapters[0].scenes;
        expect(scenes[0].participants).to.deep.equal(['yura', 'svetlana']);
        expect(scenes[2].participants).to.deep.equal(['yura', 'svetlana']);
        expect(scenes[3].participants).to.deep.equal(['svetlana']);
    });

    it('applyPatchesValidated maps display names to character_ids and dedupes', () => {
        const book = makeFixtureBook();
        const patchResult = chatEngine.applyPatchesValidated(book, [
            // Replace one scene with names-only; the rest are normalized too.
            { op: 'replace', path: '/chapters/0/scenes/1/participants', value: ['Юра', 'Светлана', 'yura'] },
        ]);
        expect(patchResult.errors).to.have.lengthOf(0);
        const scenes = patchResult.result.chapters[0].scenes;
        // Scene 1: names mapped to ids, deduped.
        expect(scenes[1].participants).to.deep.equal(['yura', 'svetlana']);
        // Untouched scenes are still normalized deterministically.
        expect(scenes[0].participants).to.deep.equal(['yura', 'svetlana']);
        expect(scenes[2].participants).to.deep.equal(['yura', 'svetlana']);
        expect(scenes[3].participants).to.deep.equal(['svetlana']);
        // Bare-string participant becomes a one-element array.
        expect(scenes[4].participants).to.deep.equal(['yura']);
        // null is left alone.
        expect(scenes[5].participants).to.equal(null);
        // Duplicates collapse without changing order.
        expect(scenes[6].participants).to.deep.equal(['yura', 'svetlana']);
    });

    it('bundle validator rejects an object-shaped participants value', () => {
        const book = makeFixtureBook();
        book.chapters[0].scenes[0].participants = { item: ['yura'] };
        const validation = validateBundleObject(book);
        expect(validation.valid).to.be.false;
        expect(validation.errors.join(' ')).to.include('participants');
        expect(validation.errors.join(' ')).to.include('array');
    });

    it('bundle validator rejects non-string participants entries', () => {
        const book = makeFixtureBook();
        book.chapters[0].scenes[0].participants = ['yura', 42];
        const validation = validateBundleObject(book);
        expect(validation.valid).to.be.false;
        expect(validation.errors.join(' ')).to.include('participants[1]');
    });

    it('bundle validator accepts a clean ID-only participants array', () => {
        const book = makeFixtureBook();
        book.chapters[0].scenes = book.chapters[0].scenes.map((sc, i) => ({
            ...sc,
            participants: i % 2 === 0 ? ['yura', 'svetlana'] : ['svetlana'],
        }));
        const validation = validateBundleObject(book);
        expect(validation.valid).to.be.true;
    });

    it('saveBookBundle persists normalized participants and rejects broken ones (defense in depth)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-part-doctrine-'));
        const bookId = 'test-part-doctrine-' + Date.now();
        const bookDir = path.join(tmpDir, bookId);
        fs.mkdirSync(path.join(bookDir, 'chapters'), { recursive: true });
        config.BOOKS_DIR = tmpDir;
        try {
            // Fix corrupted value on disk first: unwrap {"item": ...} via the
            // normalized engine result, then save.
            const book = makeFixtureBook({ manifest: { book_id: bookId, vbook_version: '3.1', state: 'BOOTSTRAPPED' }, book: { book_id: bookId, title: 'Participants Test', structure: { chapters_order: [] } } });
            const fixed = chatEngine.applyPatchesValidated(book, []).result;
            expect(fixed).to.not.be.null;
            bookModule.saveBookBundle(fixed);

            const onDisk = bookModule.loadBook(bookId);
            const scenes = onDisk.chapters[0].scenes;
            expect(scenes[0].participants).to.deep.equal(['yura', 'svetlana']);
            expect(scenes[1].participants).to.deep.equal(['yura']);
            expect(scenes[2].participants).to.deep.equal(['yura', 'svetlana']);

            // Defense in depth: a manually broken value must be refused on save.
            onDisk.chapters[0].scenes[0].participants = { item: ['yura'] };
            expect(() => bookModule.saveBookBundle(onDisk)).to.throw(/participants/);
        } finally {
            config.BOOKS_DIR = ORIG_BOOKS_DIR;
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
        }
    });

    it('edit mode system prompt documents the participants doctrine', () => {
        const prompt = chatEngine.buildChatSystemPrompt({
            mode: 'edit',
            topic: 'book',
            lang: 'ru',
            bookData: makeFixtureBook(),
            modelName: 'test-model',
        });
        expect(prompt).to.include('participants');
        expect(prompt).to.include('character_id');
        expect(prompt).to.include('{"item"');
    });
});
