// ======================================================
// BEHAVIOR CRUD ROUTES — manual Behavior editor (schema v2.1)
// ======================================================
// Verifies the endpoints the Editors use for the Behaviors tab:
//   1. behavior.json mirrors voices.json: a map keyed by the EXISTING
//      character_id (no id transliteration — the key is a character id).
//      Fields: baseline (string), quirks (string[]), reactions
//      ([{trigger, reaction}]) — the pass-1 `instruction` field is gone.
//   2. POST /behaviors requires character_id (400), an existing character
//      (404) and no behavior yet for that character (409); seeds {baseline}.
//   3. PATCH /behaviors/{characterId} merges fields via setDeep — unknown
//      keys pass through so a future schema extension survives round-trips.
//   4. DELETE removes the whole entry; deleting the CHARACTER removes the
//      dangling behavior too.
//   5. Persistence goes through the EXISTING book.loadBook/saveBookBundle
//      (no parallel storage path); buildBookFromBundle parses behavior.json
//      on vbook import.
//
// Mounts the real sub-registrar with minimal deps, like
// entity-crud-routes.test.js; fixtures follow the same pattern.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bookModule = require('../src/book/index');
const config = require('../src/config/runtime-config');

const ORIG_BOOKS_DIR = config.BOOKS_DIR;

function createResponse() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
}

describe('BEHAVIOR CRUD ROUTES — manual Behavior editor', () => {
    let tmpDir;
    let bookId;
    let bookDir;
    let handlers;
    let app;

    const CHAPTER_ID = 'ch-123456';

    function registerRoutes() {
        handlers = new Map();
        app = {
            post(path, handler) { handlers.set('POST ' + path, handler); },
            get() {},
            put() {},
            patch(path, handler) { handlers.set('PATCH ' + path, handler); },
            delete(path, handler) { handlers.set('DELETE ' + path, handler); },
        };
        const editorFacade = {                  // Phase 6: Editor boundary fake over the real module
            read: (id) => bookModule.loadBook(id),
            commit: (b, files) => bookModule.saveBookBundle(b, files),
        };
        require('../src/routes/book/entity-crud-routes.cjs')(app, {}, {
            book: bookModule,
            editorModel: editorFacade,
            utils: { log: () => {} },
        });
        require('../src/routes/book/core-routes.cjs')(app, {}, {
            book: bookModule,
            editorModel: editorFacade,
            utils: { log: () => {} },
        });
    }

    // Direct handler invocation with explicit params (route templates above are
    // registered once; tests pass concrete ids via params). PATCH and DELETE
    // share the path template, so the method is part of the key. Async handlers
    // (core-routes PATCH) execute synchronously up to their first await — the
    // response object is populated after the call either way.
    function invoke(pathTemplate, params, body) {
        const handler = handlers.get(pathTemplate);
        if (!handler) throw new Error(`No handler for ${pathTemplate}`);
        const res = createResponse();
        handler({ params, body: body || {} }, res);
        return res;
    }

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'behavior-crud-'));
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
                scene_id: 'sc-123456',
                type: 'narration',
                participants: ['hero'],
                units: [{ id: 'iu-123456', text: 'The hero arrives.' }],
            }],
        }, null, 2));

        fs.writeFileSync(path.join(bookDir, 'characters.json'), JSON.stringify([
            { id: 'hero', name: 'Hero', passport: { appearance: 'Tall, dark hair' } },
            { id: 'sidekick', name: 'Sidekick', passport: { appearance: 'Short, red hair' } },
        ], null, 2));

        registerRoutes();
    });

    afterEach(() => {
        config.BOOKS_DIR = ORIG_BOOKS_DIR;
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    });

    function readBehaviorsFile() {
        return JSON.parse(fs.readFileSync(path.join(bookDir, 'behavior.json'), 'utf8'));
    }
    // When the LAST behavior is deleted, saveBookBundle unlinks the registry
    // file (empty collection → file removed). loadBook is the canonical read
    // path — it defaults to an empty map for an absent file.
    function loadedBehaviors() {
        return bookModule.loadBook(bookId).behaviors || {};
    }

    const BEH_POST = 'POST /api/v1/book/:bookId/behaviors';
    const BEH_PATCH = 'PATCH /api/v1/book/:bookId/behaviors/:characterId';
    const BEH_DEL = 'DELETE /api/v1/book/:bookId/behaviors/:characterId';
    const CHAR_DEL = 'DELETE /api/v1/book/:bookId/characters/:characterId';

    // ======================================================
    // POST — create
    // ======================================================
    it('POST creates behavior.json keyed by the existing character_id', () => {
        const res = invoke(BEH_POST, { bookId }, {
            character_id: 'hero',
            baseline: 'Calm, restrained gestures, speaks slowly.',
        });
        expect(res.statusCode).to.equal(200);
        expect(res.body).to.include({ saved: true, character_id: 'hero' });

        const behaviors = readBehaviorsFile();
        expect(behaviors.hero).to.deep.equal({ baseline: 'Calm, restrained gestures, speaks slowly.' });
        // Sidekick untouched — no phantom entries.
        expect(Object.keys(behaviors)).to.deep.equal(['hero']);
    });

    it('POST without baseline seeds an empty behavior object', () => {
        const res = invoke(BEH_POST, { bookId }, { character_id: 'hero' });
        expect(res.statusCode).to.equal(200);
        expect(readBehaviorsFile().hero).to.deep.equal({});
    });

    it('POST without character_id is rejected (400)', () => {
        const res = invoke(BEH_POST, { bookId }, { baseline: 'no owner' });
        expect(res.statusCode).to.equal(400);
    });

    it('POST for an unknown character is rejected (404)', () => {
        const res = invoke(BEH_POST, { bookId }, { character_id: 'ghost', baseline: 'x' });
        expect(res.statusCode).to.equal(404);
    });

    it('POST a second behavior for the same character is rejected (409)', () => {
        expect(invoke(BEH_POST, { bookId }, { character_id: 'hero', baseline: 'a' }).statusCode).to.equal(200);
        const res = invoke(BEH_POST, { bookId }, { character_id: 'hero', baseline: 'b' });
        expect(res.statusCode).to.equal(409);
        // The original entry is intact.
        expect(readBehaviorsFile().hero.baseline).to.equal('a');
    });

    // ======================================================
    // PATCH — edit (free-form fields, passthrough of unknown keys)
    // ======================================================
    it('PATCH accepts structured fields (baseline, quirks, reactions) and stores them verbatim', () => {
        invoke(BEH_POST, { bookId }, { character_id: 'hero', baseline: 'seed' });
        const res = invoke(BEH_PATCH, { bookId, characterId: 'hero' }, {
            fields: {
                baseline: 'Usually composed and measured.',
                quirks: ['adjusts his tie', 'taps the table'],
                reactions: [
                    { trigger: 'is contradicted in public', reaction: 'freezes, then smiles coldly' },
                    { trigger: 'is praised', reaction: null },
                ],
            },
        });
        expect(res.statusCode).to.equal(200);
        expect(readBehaviorsFile().hero).to.deep.equal({
            baseline: 'Usually composed and measured.',
            quirks: ['adjusts his tie', 'taps the table'],
            reactions: [
                { trigger: 'is contradicted in public', reaction: 'freezes, then smiles coldly' },
                { trigger: 'is praised', reaction: null },
            ],
        });
    });

    it('PATCH updates baseline and keeps unknown keys (schema-tolerant storage)', () => {
        invoke(BEH_POST, { bookId }, { character_id: 'hero', baseline: 'first draft' });
        // A future schema writes an extra key straight into behavior.json.
        const behaviors = readBehaviorsFile();
        behaviors.hero.gestures = 'minimal';
        fs.writeFileSync(path.join(bookDir, 'behavior.json'), JSON.stringify(behaviors, null, 2));

        const res = invoke(BEH_PATCH, { bookId, characterId: 'hero' }, {
            fields: { baseline: 'edited baseline' },
        });
        expect(res.statusCode).to.equal(200);

        const after = readBehaviorsFile();
        expect(after.hero.baseline).to.equal('edited baseline');
        expect(after.hero.gestures).to.equal('minimal');
    });

    it('pass-1 instruction key survives as an inert passthrough key (no special handling)', () => {
        // A pre-v2.1 file: the old `instruction` field is no longer part of the
        // schema — it must not break anything, it just passes through untouched.
        fs.writeFileSync(path.join(bookDir, 'behavior.json'), JSON.stringify({
            hero: { instruction: 'Calm.' },
        }, null, 2));

        const res = invoke(BEH_PATCH, { bookId, characterId: 'hero' }, { fields: { baseline: 'Calm and deliberate.' } });
        expect(res.statusCode).to.equal(200);
        expect(readBehaviorsFile().hero).to.deep.equal({ instruction: 'Calm.', baseline: 'Calm and deliberate.' });
    });

    it('PATCH for a character without behavior is rejected (404)', () => {
        const res = invoke(BEH_PATCH, { bookId, characterId: 'sidekick' }, { fields: { baseline: 'x' } });
        expect(res.statusCode).to.equal(404);
    });

    it('PATCHing one field never rewrites sibling fields (future per-reaction keys survive untouched cards)', () => {
        invoke(BEH_POST, { bookId }, { character_id: 'hero', baseline: 'seed' });
        const reactions = [{ trigger: 'x', reaction: 'y', intensity: 0.7 }];
        const behaviors = readBehaviorsFile();
        behaviors.hero.reactions = reactions;
        fs.writeFileSync(path.join(bookDir, 'behavior.json'), JSON.stringify(behaviors, null, 2));

        invoke(BEH_PATCH, { bookId, characterId: 'hero' }, { fields: { baseline: 'b' } });
        expect(readBehaviorsFile().hero.reactions).to.deep.equal(reactions);
    });

    // ======================================================
    // DELETE — remove behavior / character
    // ======================================================
    it('DELETE removes the whole behavior entry; the file stays as {} when empty', () => {
        invoke(BEH_POST, { bookId }, { character_id: 'hero', baseline: 'a' });
        invoke(BEH_POST, { bookId }, { character_id: 'sidekick', baseline: 'b' });

        const res = invoke(BEH_DEL, { bookId, characterId: 'hero' });
        expect(res.statusCode).to.equal(200);
        expect(loadedBehaviors().sidekick.baseline).to.equal('b');

        invoke(BEH_DEL, { bookId, characterId: 'sidekick' });
        // behavior.json persists as empty {} (always present after book creation)
        expect(fs.existsSync(path.join(bookDir, 'behavior.json'))).to.equal(true);
        expect(loadedBehaviors()).to.deep.equal({});
    });

    it('DELETE for a missing behavior is rejected (404)', () => {
        const res = invoke(BEH_DEL, { bookId, characterId: 'hero' });
        expect(res.statusCode).to.equal(404);
    });

    it('DELETE character removes the dangling behavior (dangling-data cleanup)', () => {
        invoke(BEH_POST, { bookId }, { character_id: 'hero', baseline: 'a' });

        const res = invoke(CHAR_DEL, { bookId, characterId: 'hero' });
        expect(res.statusCode).to.equal(200);

        const chars = JSON.parse(fs.readFileSync(path.join(bookDir, 'characters.json'), 'utf8'));
        expect(chars.find(c => c.id === 'hero')).to.be.undefined;
        expect(loadedBehaviors()).to.deep.equal({});
    });

    // ======================================================
    // Persistence roundtrip — vbook import parses behavior.json
    // ======================================================
    it('buildBookFromBundle parses behavior.json from a vbook bundle', () => {
        fs.writeFileSync(path.join(bookDir, 'behavior.json'), JSON.stringify({
            hero: {
                baseline: 'Composed.',
                quirks: ['adjusts his tie'],
                reactions: [{ trigger: 'is contradicted', reaction: 'smiles coldly' }],
            },
        }, null, 2));

        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        bookModule.addDirToZip(zip, bookDir, '');
        const built = bookModule.buildBookFromBundle(bookModule.extractBookBundle(zip.toBuffer()));

        expect(built.behaviors).to.deep.equal({
            hero: {
                baseline: 'Composed.',
                quirks: ['adjusts his tie'],
                reactions: [{ trigger: 'is contradicted', reaction: 'smiles coldly' }],
            },
        });
    });
});
