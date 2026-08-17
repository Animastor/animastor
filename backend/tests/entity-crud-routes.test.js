// ======================================================
// ENTITY CRUD ROUTES — manual add/delete (Editor)
// ======================================================
// Verifies the endpoints the Editors use for the
// Characters / Locations / Voices tabs:
//   1. POST /characters (and /locations, /voices) create a FULL entity through
//      the existing book.loadBook/saveBookBundle persistence.
//   2. Canonical ids are kept verbatim; Cyrillic / free-form input is
//      transliterated server-side to snake_case (utils/entity-id reuses the
//      existing cyrToLatin map — neither frontend duplicates the algorithm).
//   3. Duplicate ids are rejected (409), missing names rejected (400).
//   4. DELETE removes the WHOLE entity object (entire passport), not just the
//      id — plus the dangling same-id voice when a character is deleted.
//
// Mounts the real sub-registrar with minimal deps (book + utils.log), like
// generation-routes.test.js; fixtures follow character-passport-patch.test.js.

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

describe('ENTITY CRUD ROUTES — manual add/delete', () => {
    let tmpDir;
    let bookId;
    let bookDir;
    let handlers;
    let app;

    const CHAPTER_ID = 'ch-test';
    const SCENE_ID = 'sc-0001';

    function registerRoutes() {
        handlers = new Map();
        app = {
            post(path, handler) { handlers.set(path, handler); },
            get() {},
            put() {},
            patch() {},
            delete(path, handler) { handlers.set(path, handler); },
        };
        require('../src/routes/book/entity-crud-routes.cjs')(app, {}, {
            book: bookModule,
            utils: { log: () => {} },
        });
    }

    // Direct handler invocation with explicit params (route templates above are
    // registered once; tests pass concrete ids via params).
    function invoke(pathTemplate, params, body) {
        const handler = handlers.get(pathTemplate);
        if (!handler) throw new Error(`No handler for ${pathTemplate}`);
        const res = createResponse();
        return handler({ params, body: body || {} }, res) || res;
    }

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-crud-'));
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

        fs.writeFileSync(path.join(bookDir, 'voices.json'), JSON.stringify({
            hero: { instruction: 'A calm male voice.' },
        }));

        registerRoutes();
    });

    afterEach(() => {
        config.BOOKS_DIR = ORIG_BOOKS_DIR;
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    });

    function readCharacters() {
        return JSON.parse(fs.readFileSync(path.join(bookDir, 'characters.json'), 'utf8'));
    }
    function readLocations() {
        return JSON.parse(fs.readFileSync(path.join(bookDir, 'locations.json'), 'utf8'));
    }
    function readVoices() {
        return JSON.parse(fs.readFileSync(path.join(bookDir, 'voices.json'), 'utf8'));
    }
    // When the LAST entity is deleted, saveBookBundle unlinks the registry file
    // (existing mechanism: empty collection → file removed). loadBook is the
    // canonical read path — it defaults to empty lists/maps for absent files.
    function loadedCharacters() {
        return bookModule.loadBook(bookId).characters || [];
    }
    function loadedLocations() {
        return bookModule.loadBook(bookId).locations || {};
    }
    function loadedVoices() {
        return bookModule.loadBook(bookId).voices || {};
    }

    const CHAR_POST = '/api/v1/book/:bookId/characters';
    const CHAR_DEL = '/api/v1/book/:bookId/characters/:characterId';
    const LOC_POST = '/api/v1/book/:bookId/locations';
    const LOC_DEL = '/api/v1/book/:bookId/locations/:locationId';
    const VOICE_POST = '/api/v1/book/:bookId/voices';
    const VOICE_DEL = '/api/v1/book/:bookId/voices/:voiceId';

    // ======================================================
    // Characters
    // ======================================================
    it('POST character with a canonical id keeps the id and stores the full passport', () => {
        const res = invoke(CHAR_POST, { bookId }, {
            id: 'margarita',
            name: 'Margarita',
            passport: {
                appearance: 'dark-haired beauty, 1930s Moscow',
                clothes: 'elegant black dress',
                video_tokens: 'black dress, dark hair',
            },
        });
        expect(res.statusCode).to.equal(200);
        expect(res.body).to.include({ saved: true, character_id: 'margarita' });

        const chars = readCharacters();
        const m = chars.find(c => c.id === 'margarita');
        expect(m).to.not.be.undefined;
        expect(m.name).to.equal('Margarita');
        expect(m.passport.appearance).to.equal('dark-haired beauty, 1930s Moscow');
        expect(m.passport.clothes).to.equal('elegant black dress');
        // comma text → array (normalizeFieldValue parity with PATCH)
        expect(m.passport.video_tokens).to.deep.equal(['black dress', 'dark hair']);
        // pre-existing character untouched
        expect(chars.find(c => c.id === 'hero').name).to.equal('Hero');
    });

    it('POST character with a Cyrillic name and no id derives a transliterated snake id', () => {
        const res = invoke(CHAR_POST, { bookId }, {
            name: 'Михаил Александрович Берлиоз',
            passport: { appearance: 'slim intellectual man' },
        });
        expect(res.statusCode).to.equal(200);
        expect(res.body.character_id).to.equal('mikhail_aleksandrovich_berlioz');
        const chars = readCharacters();
        expect(chars.some(c => c.id === 'mikhail_aleksandrovich_berlioz')).to.equal(true);
    });

    it('POST character with a free-form Cyrillic id transliterates it', () => {
        const res = invoke(CHAR_POST, { bookId }, {
            id: 'Воланд',
            name: 'Woland',
        });
        expect(res.statusCode).to.equal(200);
        expect(res.body.character_id).to.equal('voland');
    });

    it('POST character rejects a duplicate id with 409', () => {
        const res = invoke(CHAR_POST, { bookId }, { id: 'hero', name: 'Another Hero' });
        expect(res.statusCode).to.equal(409);
        expect(res.body.error).to.include('already exists');
        expect(readCharacters()).to.have.length(1);
    });

    it('POST character rejects a missing name with 400', () => {
        const res = invoke(CHAR_POST, { bookId }, { id: 'ghost' });
        expect(res.statusCode).to.equal(400);
    });

    it('DELETE character removes the WHOLE object (entire passport), not just the id', () => {
        const res = invoke(CHAR_DEL, { bookId, characterId: 'hero' });
        expect(res.statusCode).to.equal(200);
        expect(loadedCharacters()).to.have.length(0);
    });

    it('DELETE character also removes the dangling same-id voice', () => {
        invoke(CHAR_DEL, { bookId, characterId: 'hero' });
        expect(loadedVoices()).to.not.have.property('hero');
    });

    it('DELETE unknown character returns 404', () => {
        const res = invoke(CHAR_DEL, { bookId, characterId: 'nobody' });
        expect(res.statusCode).to.equal(404);
    });

    // ======================================================
    // Locations
    // ======================================================
    it('POST location creates the full location object (name/description/environment)', () => {
        const res = invoke(LOC_POST, { bookId }, {
            id: 'griboedov_house',
            name: 'Грибоедов',
            description: 'Moscow restaurant',
            environment: { time: 'night', lighting: 'dim', mood: 'tense' },
        });
        expect(res.statusCode).to.equal(200);
        expect(res.body).to.include({ saved: true, location_id: 'griboedov_house' });

        const locs = readLocations();
        expect(locs.griboedov_house.name).to.equal('Грибоедов');
        expect(locs.griboedov_house.description).to.equal('Moscow restaurant');
        expect(locs.griboedov_house.environment).to.deep.equal({ time: 'night', lighting: 'dim', mood: 'tense' });
        expect(locs.main_street.description).to.equal('Main street');
    });

    it('POST location with Cyrillic name derives a transliterated id', () => {
        const res = invoke(LOC_POST, { bookId }, { name: 'Патриаршие пруды' });
        expect(res.statusCode).to.equal(200);
        expect(res.body.location_id).to.equal('patriarshie_prudy');
    });

    it('DELETE location removes the whole object', () => {
        const res = invoke(LOC_DEL, { bookId, locationId: 'main_street' });
        expect(res.statusCode).to.equal(200);
        expect(loadedLocations()).to.not.have.property('main_street');
        expect(Object.keys(loadedLocations())).to.have.length(0);
    });

    // ======================================================
    // Voices
    // ======================================================
    it('POST voice creates the voice entry', () => {
        const res = invoke(VOICE_POST, { bookId }, {
            id: 'woland',
            name: 'Woland',
            instruction: 'A calm deep voice with a foreign accent.',
        });
        expect(res.statusCode).to.equal(200);
        expect(res.body).to.include({ saved: true, voice_id: 'woland' });
        const voices = readVoices();
        expect(voices.woland.instruction).to.equal('A calm deep voice with a foreign accent.');
        expect(voices.hero.instruction).to.equal('A calm male voice.');
    });

    it('POST voice rejects duplicates and DELETE removes the whole entry', () => {
        const dup = invoke(VOICE_POST, { bookId }, { id: 'hero', name: 'Hero' });
        expect(dup.statusCode).to.equal(409);

        const res = invoke(VOICE_DEL, { bookId, voiceId: 'hero' });
        expect(res.statusCode).to.equal(200);
        expect(loadedVoices()).to.not.have.property('hero');
    });

    // ======================================================
    // Persistence is real — a fresh loadBook sees the changes
    // ======================================================
    it('a freshly loaded book sees entities added through the routes', () => {
        invoke(CHAR_POST, { bookId }, { id: 'kisa', name: 'Kisa Vorobyaninov' });
        invoke(LOC_POST, { bookId }, { id: 'stargorod', name: 'Stargorod' });
        invoke(VOICE_POST, { bookId }, { id: 'kisa', name: 'Kisa', instruction: 'A nervous voice.' });

        const fresh = bookModule.loadBook(bookId);
        expect(fresh.characters.some(c => c.id === 'kisa')).to.equal(true);
        expect(fresh.locations).to.have.property('stargorod');
        expect(fresh.voices).to.have.property('kisa');
    });
});
