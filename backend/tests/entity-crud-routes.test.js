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

// ======================================================
// SCENE / UNIT DELETE — deep cleanup
// ======================================================
// The DELETE handlers now run entity-cleanup after saveBookBundle:
// PostgreSQL purge (reuses bookSync.purgeRemovedSceneRows), in-flight dispatch
// cancellation (dispatch-engine), active-index removal (scheduler), Redis key
// cleanup (chunks/asset-states/registry/dedup) and filesystem asset removal.
// These tests mount the real sub-registrar with mocked storage/runtime/redis and
// assert the cleanup side-effects for scene and unit deletion.
describe('ENTITY CRUD ROUTES — scene/unit delete deep cleanup', () => {
    let tmpDir;
    let bookId;
    let bookDir;
    let handlers;
    let app;
    let calls;
    let redisMock;

    const CHAPTER_ID = 'ch-deep';
    const SCENE_ID = 'sc-deep';
    const UNIT_ID = 'iu-deep1';
    let PREFIX;

    function globToRe(pattern) {
        return new RegExp('^' + pattern
            .split('*')
            .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('.*') + '$');
    }

    function makeRedis() {
        const store = {};
        return {
            _store: store,
            async scan(cursor, _mode, pattern) {
                return ['0', Object.keys(store).filter(k => globToRe(pattern).test(k))];
            },
            async del(...keys) {
                let n = 0;
                for (const k of keys) { if (k in store) { delete store[k]; n++; } }
                return n;
            },
            async srem(set, ...members) {
                const s = store[set] || [];
                let n = 0;
                for (const m of members) {
                    const i = s.indexOf(m);
                    if (i >= 0) { s.splice(i, 1); n++; }
                }
                store[set] = s;
                return n;
            },
            async set(k, v) { store[k] = v; },
        };
    }

    function registerRoutes() {
        handlers = new Map();
        app = {
            post(path, handler) { handlers.set(path, handler); },
            get() {},
            put() {},
            patch() {},
            delete(path, handler) { handlers.set(path, handler); },
        };
        calls = { pg: [], purgeScenes: [], cancellations: [], activeRemoved: [], reconcile: [], bump: [] };
        const deps = {
            book: bookModule,
            utils: { log: () => {} },
            config: { OUTPUT_DIR: tmpDir },
            storage: {
                bookSync: {
                    purgeRemovedSceneRows: async (_bookId, keys) => {
                        calls.purgeScenes.push(keys);
                        return { scenes: keys.length };
                    },
                    reconcileFromDiff: async (_bookId, dirtyScenes) => {
                        calls.reconcile.push(dirtyScenes);
                        return { reconciled: 1 };
                    },
                },
                registry: {},
                postgres: {
                    query: async (text, params) => {
                        calls.pg.push({ text: text.trim().replace(/\s+/g, ' '), params });
                        return { rowCount: 1 };
                    },
                },
            },
            sceneAssetsRepo: {
                bumpSceneVersions: async (_bookId, dirtyScenes) => {
                    calls.bump.push(dirtyScenes);
                    return 1;
                },
            },
            runtime: {
                dispatch: {
                    clearLeasesForScenes: async (_r, _b, scenes) => {
                        calls.cancellations.push(scenes);
                        return { cancelled: 0, dispatchIds: [] };
                    },
                    clearHubDispatches: async () => ({}),
                },
                scheduler: {
                    removeSceneFromActiveIndex: async (_r, bookId2, chapterId2, sceneId2) => {
                        calls.activeRemoved.push(true);
                        await redisMock.srem('animastor:active-scenes', `${bookId2}:${chapterId2}:${sceneId2}`);
                        return { removed: true };
                    },
                },
            },
        };
        require('../src/routes/book/entity-crud-routes.cjs')(app, redisMock, deps);
    }

    async function invoke(pathTemplate, params, body) {
        const handler = handlers.get(pathTemplate);
        if (!handler) throw new Error(`No handler for ${pathTemplate}`);
        const res = createResponse();
        const ret = await handler({ params, body: body || {} }, res);
        return ret || res;
    }

    function writeBook() {
        fs.mkdirSync(bookDir, { recursive: true });
        fs.mkdirSync(path.join(bookDir, 'chapters'), { recursive: true });
        fs.writeFileSync(path.join(bookDir, 'manifest.json'), JSON.stringify({
            book_id: bookId, vbook_version: '3.1', build_id: 'build-test',
            state: 'BOOTSTRAPPED', created_at: new Date().toISOString(),
        }));
        fs.writeFileSync(path.join(bookDir, 'book.json'), JSON.stringify({
            book_id: bookId, version: '3.0', title: 'Test Book', author: 'Test Author', language: 'ru',
            structure: { chapters_order: [`chapters/${CHAPTER_ID}.json`] },
        }));
        fs.writeFileSync(path.join(bookDir, 'chapters', `${CHAPTER_ID}.json`), JSON.stringify({
            chapter_id: CHAPTER_ID,
            chapter_title: 'Chapter',
            scenes: [
                {
                    scene_id: SCENE_ID,
                    scene_title: 'Scene A',
                    type: 'narration',
                    participants: ['hero'],
                    units: [
                        { id: UNIT_ID, text: 'first unit' },
                        { id: 'iu-deep2', text: 'second unit' },
                    ],
                },
                {
                    scene_id: 'sc-keep',
                    scene_title: 'Scene B',
                    type: 'narration',
                    participants: [],
                    units: [{ id: 'iu-keep1', text: 'keep' }],
                },
            ],
        }));
        fs.writeFileSync(path.join(bookDir, 'characters.json'), JSON.stringify([
            { id: 'hero', name: 'Hero', passport: {} },
        ]));
        fs.writeFileSync(path.join(bookDir, 'locations.json'), JSON.stringify({}));
        fs.writeFileSync(path.join(bookDir, 'voices.json'), JSON.stringify({}));
    }

    const SCENE_DEL = '/api/v1/book/:bookId/chapters/:chapterId/scenes/:sceneId';
    const UNIT_DEL = '/api/v1/book/:bookId/chapters/:chapterId/scenes/:sceneId/units/:unitId';

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-crud-deep-'));
        bookId = 'test-deep-' + Date.now();
        PREFIX = `${bookId}_${CHAPTER_ID}_${SCENE_ID}`;
        bookDir = path.join(tmpDir, bookId);
        config.BOOKS_DIR = tmpDir;
        redisMock = makeRedis();
        writeBook();
        registerRoutes();
    });

    afterEach(() => {
        config.BOOKS_DIR = ORIG_BOOKS_DIR;
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    });

    it('DELETE scene purges PG/Redis/FS and cancels in-flight dispatch', async () => {
        // Seed derived state for the deleted scene.
        const store = redisMock._store;
        store[`animastor:chunk:${PREFIX}_0000`] = '{}';
        store[`animastor:chunks:${bookId}`] = [`${PREFIX}_0000`, 'other_chunk'];
        store[`animastor:asset-state:${bookId}:${CHAPTER_ID}:${SCENE_ID}`] = '{}';
        store[`animastor:assets:${bookId}:${CHAPTER_ID}:${SCENE_ID}`] = '{}';
        store[`animastor:audio-orch:${bookId}:${CHAPTER_ID}:${SCENE_ID}`] = '{}';
        store[`animastor:active-scenes`] = [`${bookId}:${CHAPTER_ID}:${SCENE_ID}`, 'bk9:x:y'];
        store[`animastor:iu-registry:${PREFIX}_${UNIT_ID}`] = '{}';

        // Fake output build directory with scene asset files.
        const buildDir = path.join(tmpDir, 'build-test');
        fs.mkdirSync(buildDir, { recursive: true });
        const fakeFiles = [`${PREFIX}.mp3`, `${PREFIX}_0000.png`, `${PREFIX}_0000.mp3`];
        for (const f of fakeFiles) fs.writeFileSync(path.join(buildDir, f), 'x');

        const res = await invoke(SCENE_DEL, { bookId, chapterId: CHAPTER_ID, sceneId: SCENE_ID });

        expect(res.statusCode).to.equal(200);
        expect(res.body).to.include({ saved: true, scene_id: SCENE_ID });

        // PG purge reuses bookSync.purgeRemovedSceneRows with the scene key.
        expect(calls.purgeScenes).to.have.length(1);
        expect(calls.purgeScenes[0]).to.deep.equal([`${CHAPTER_ID}::${SCENE_ID}`]);

        // In-flight cancellation + active-index removal ran.
        expect(calls.cancellations).to.have.length(1);
        expect(calls.activeRemoved).to.have.length(1);

        // Redis: chunk key gone, chunk set updated, asset-state/registry gone,
        // active-scenes member removed.
        expect(store[`animastor:chunk:${PREFIX}_0000`]).to.be.undefined;
        expect(store[`animastor:chunks:${bookId}`]).to.not.include(`${PREFIX}_0000`);
        expect(store[`animastor:chunks:${bookId}`]).to.include('other_chunk');
        expect(store[`animastor:asset-state:${bookId}:${CHAPTER_ID}:${SCENE_ID}`]).to.be.undefined;
        expect(store[`animastor:assets:${bookId}:${CHAPTER_ID}:${SCENE_ID}`]).to.be.undefined;
        expect(store[`animastor:audio-orch:${bookId}:${CHAPTER_ID}:${SCENE_ID}`]).to.be.undefined;
        expect(store['animastor:active-scenes']).to.not.include(`${bookId}:${CHAPTER_ID}:${SCENE_ID}`);
        expect(store['animastor:active-scenes']).to.include('bk9:x:y');

        // Filesystem: scene files removed, sibling build files untouched.
        for (const f of fakeFiles) expect(fs.existsSync(path.join(buildDir, f))).to.equal(false);
        expect(fs.readdirSync(buildDir)).to.be.empty;

        // JSON: scene removed, other scene stays.
        const fresh = bookModule.loadBook(bookId);
        const scenes = fresh.chapters[0].scenes;
        expect(scenes.map(s => s.scene_id)).to.not.include(SCENE_ID);
        expect(scenes.map(s => s.scene_id)).to.include('sc-keep');
    });

    it('DELETE unit purges image_units row + iu registry/in-flight/GPU keys + IU files and invalidates the scene', async () => {
        const store = redisMock._store;
        const iuPrefix = `${PREFIX}_${UNIT_ID}`;
        store[`animastor:iu-registry:${iuPrefix}`] = '{}';
        store[`animastor:iu-in-flight:${iuPrefix}`] = '1';
        store[`animastor:job:${iuPrefix}:image`] = '1';
        store[`animastor:result-processed:${iuPrefix}:iu_image:build-test`] = '1';
        store[`animastor:result:${iuPrefix}:iu_image:build-test`] = 'legacy';
        store[`animastor:error-processed:disp1:${iuPrefix}:iu_image:build-test`] = '1';

        const buildDir = path.join(tmpDir, 'build-test');
        fs.mkdirSync(buildDir, { recursive: true });
        const iuFile = path.join(buildDir, `${iuPrefix}.png`);
        fs.writeFileSync(iuFile, 'x');

        const res = await invoke(UNIT_DEL, { bookId, chapterId: CHAPTER_ID, sceneId: SCENE_ID, unitId: UNIT_ID });

        expect(res.statusCode).to.equal(200);
        expect(res.body).to.include({ saved: true, unit_id: UNIT_ID });
        expect(res.body.cleanup.complete).to.equal(true);
        expect(res.body.cleanup.failed_steps).to.deep.equal([]);

        // PG: image_units DELETE with the unit params.
        const unitDel = calls.pg.find(c => c.text.startsWith('DELETE FROM image_units'));
        expect(unitDel).to.not.be.undefined;
        expect(unitDel.params).to.deep.equal([bookId, CHAPTER_ID, SCENE_ID, UNIT_ID]);

        // PG invalidation: dirty_unit_ids scrub on the parent scene.
        const scrub = calls.pg.find(c => c.text.startsWith('UPDATE scenes'));
        expect(scrub).to.not.be.undefined;
        expect(scrub.params).to.deep.equal([bookId, CHAPTER_ID, SCENE_ID, UNIT_ID]);

        // Redis iu keys removed (registry, in-flight, job, result, error).
        expect(store[`animastor:iu-registry:${iuPrefix}`]).to.be.undefined;
        expect(store[`animastor:iu-in-flight:${iuPrefix}`]).to.be.undefined;
        expect(store[`animastor:job:${iuPrefix}:image`]).to.be.undefined;
        expect(store[`animastor:result-processed:${iuPrefix}:iu_image:build-test`]).to.be.undefined;
        expect(store[`animastor:result:${iuPrefix}:iu_image:build-test`]).to.be.undefined;
        expect(store[`animastor:error-processed:disp1:${iuPrefix}:iu_image:build-test`]).to.be.undefined;

        // In-flight dispatch cancelled for the scene (all layers).
        expect(calls.cancellations).to.have.length(1);
        expect(calls.cancellations[0][0].stages).to.deep.equal(['audio', 'image', 'video']);

        // Parent scene invalidated through the canonical path (changed + 3 layers).
        expect(calls.reconcile).to.have.length(1);
        expect(calls.reconcile[0]).to.deep.equal([{
            chapter_id: CHAPTER_ID,
            scene_id: SCENE_ID,
            reason: 'changed',
            dirty_layers: ['audio', 'image', 'video'],
        }]);
        expect(calls.bump).to.have.length(1);

        // IU image file removed.
        expect(fs.existsSync(iuFile)).to.equal(false);

        // JSON: unit gone, sibling unit + other scene intact.
        const fresh = bookModule.loadBook(bookId);
        const sc = fresh.chapters[0].scenes.find(s => s.scene_id === SCENE_ID);
        expect(sc.units.map(u => u.id)).to.not.include(UNIT_ID);
        expect(sc.units.map(u => u.id)).to.include('iu-deep2');
        expect(fresh.chapters[0].scenes).to.have.length(2);
    });

    it('DELETE scene does not remove files of a sibling scene that shares the id prefix', async () => {
        // sc-deep vs sc-deepX: the longer id starts with the shorter id but the
        // cleanup boundary requires `_` after the prefix, so sc-deepX survives.
        const buildDir = path.join(tmpDir, 'build-test');
        fs.mkdirSync(buildDir, { recursive: true });
        const keep = `${bookId}_${CHAPTER_ID}_sc-deepX`;
        for (const f of [`${keep}.mp3`, `${keep}_0000.png`, `${keep}_iu-q1.png`]) {
            fs.writeFileSync(path.join(buildDir, f), 'x');
        }

        const res = await invoke(SCENE_DEL, { bookId, chapterId: CHAPTER_ID, sceneId: SCENE_ID });
        expect(res.statusCode).to.equal(200);
        expect(res.body.cleanup.complete).to.equal(true);

        const files = fs.readdirSync(buildDir);
        expect(files).to.deep.equal([`${keep}.mp3`, `${keep}_0000.png`, `${keep}_iu-q1.png`]);
    });
});

// ======================================================
// ENTITY CLEANUP SERVICE — partial failure & retry
// ======================================================
// The route surfaces cleanup failures and records a pending-purge marker; the
// reconcile cycle retries it via retryPendingPurges. Verified at the service
// level with mocked storage so a failing step can be injected.
describe('ENTITY CLEANUP — partial failure → pending purge retry', () => {
    let redisMock;

    function makeRedis() {
        const store = {};
        return {
            _store: store,
            async scan(cursor, _mode, pattern) {
                const re = new RegExp('^' + pattern
                    .split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
                return ['0', Object.keys(store).filter(k => re.test(k))];
            },
            async del(...keys) {
                let n = 0;
                for (const k of keys) { if (k in store) { delete store[k]; n++; } }
                return n;
            },
            async srem(set, ...members) {
                const s = store[set] || [];
                let n = 0;
                for (const m of members) { const i = s.indexOf(m); if (i >= 0) { s.splice(i, 1); n++; } }
                store[set] = s;
                return n;
            },
            async sadd(set, ...members) {
                const s = store[set] || [];
                for (const m of members) if (!s.includes(m)) s.push(m);
                store[set] = s;
                return s.length;
            },
            async smembers(set) { return store[set] || []; },
            async incr(k) { store[k] = (store[k] || 0) + 1; return store[k]; },
            async expire() { return 1; },
            async get(k) { return store[k]; },
        };
    }

    function buildService(postgresOverrides) {
        const deps = {
            utils: { log: () => {} },
            config: { OUTPUT_DIR: '/tmp/nonexistent' },
            storage: {
                bookSync: {},
                registry: {},
                postgres: {
                    query: async (t, p) => {
                        if (postgresOverrides && postgresOverrides.fail) throw new Error('pg down');
                        return { rowCount: 1 };
                    },
                },
            },
            runtime: {
                dispatch: {
                    clearLeasesForScenes: async () => ({ cancelled: 0, dispatchIds: [] }),
                    clearHubDispatches: async () => ({}),
                },
                scheduler: { removeSceneFromActiveIndex: async () => ({ removed: true }) },
            },
            book: { loadBook: () => ({ chapters: [] }) },
            bookDiff: {},
            sceneAssetsRepo: {},
        };
        return require('../src/services/entity-cleanup.cjs')(redisMock, deps.config, deps);
    }

    beforeEach(() => {
        redisMock = makeRedis();
    });

    it('partial failure surfaces in result, records a pending marker, and retry clears it', async () => {
        const failing = buildService({ fail: true });
        const result = await failing.purgeUnit('bk1', 'ch-1', 'sc-1', 'iu-zz1');

        expect(result.complete).to.equal(false);
        expect(result.failed_steps).to.deep.equal(['pg_purge']);

        const markers = redisMock._store['animastor:pending-purge'] || [];
        expect(markers).to.include('unit:bk1:ch-1:sc-1:iu-zz1');

        // Retry with a healthy service clears the marker.
        const healthy = buildService({});
        const cleared = await healthy.retryPendingPurges();
        expect(cleared).to.equal(1);
        expect(redisMock._store['animastor:pending-purge'] || []).to.deep.equal([]);
    });

    it('gives up a marker after the attempt cap instead of hot-looping', async () => {
        const failing = buildService({ fail: true });
        await failing.purgeUnit('bk1', 'ch-1', 'sc-1', 'iu-zz1');

        const healthy = buildService({ fail: true }); // still failing
        for (let i = 0; i < 5; i++) {
            await healthy.retryPendingPurges();
        }
        // Marker dropped after the cap, attempt counter removed.
        expect(redisMock._store['animastor:pending-purge'] || []).to.deep.equal([]);
        expect(redisMock._store['animastor:pending-purge-attempts:unit:bk1:ch-1:sc-1:iu-zz1']).to.be.undefined;
    });
});
