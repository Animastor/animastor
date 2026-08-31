// ======================================================
// Entity CRUD Routes — manual add/delete of characters,
// locations and voices from the Editor (web + Android).
//
// Split out of book-routes.cjs (sub-registrar pattern —
// see cache-routes.cjs / status-routes.cjs). Writes go
// through the EXISTING book.loadBook / saveBookBundle
// persistence — no parallel storage path. The existing
// PATCH /characters/{id} /locations/{id} /voices/{id}
// endpoints stay the edit path; these cover create/delete.
//
// ID handling (spec): a user-entered canonical id is kept
// verbatim; free-form input (Cyrillic, spaces, mixed case)
// is transliterated to the project's snake_case standard
// server-side via utils/entity-id (reusing cyrToLatin) so
// neither frontend duplicates the algorithm.
// ======================================================

const { toEntityId, isCanonicalEntityId } = require('../../utils/entity-id');
const { normalizeFieldValue, rebuildFullText } = require('./scene-patch-utils.cjs');
// The project's single hex-id generator (lazy-book paths): ch-<hex8> / sc-<hex8>
// / iu-<hex8>. No second generator is ever introduced on the clients.
const { chapterId, sceneId, unitId, generateBookId } = require('../../book/lazy-book/paths');

module.exports = function (app, redis, deps) {
    const { book, utils } = deps;
    const { log } = utils;
    const cleanup = require('../../services/entity-cleanup.cjs')(redis, deps.config, deps);

    function loadBook(bookId) {
        const b = book.loadBook(bookId);
        if (!b) {
            const err = new Error('Book not found');
            err.statusCode = 404;
            throw err;
        }
        return b;
    }

    // ── Structure id resolution: a client-proposed id (the readonly dialog
    //    preview) is kept when unique; otherwise the canonical generator from
    //    lazy-book/paths.js produces a fresh one. The server stays the authority. ──
    function resolveStructureId(proposed, generate, isTaken) {
        if (proposed && !isTaken(proposed)) return proposed;
        let id = generate();
        let guard = 0;
        while (isTaken(id) && guard < 24) { id = generate(); guard++; }
        return id;
    }

    // ── Resolve the entity id: canonical input kept, otherwise the existing
    //    transliteration folded into snake_case (empty id → derive from name).
    function resolveId(rawId, name) {
        if (rawId && isCanonicalEntityId(rawId)) return rawId;
        if (rawId) {
            const normalized = toEntityId(rawId);
            if (normalized) return normalized;
        }
        return toEntityId(name || '');
    }

    // ── Passport: keep only real fields, empty values dropped, video_tokens
    //    normalized like the PATCH path (comma text → array). ──
    function buildPassport(raw) {
        if (!raw || typeof raw !== 'object') return {};
        const passport = {};
        for (const key of ['appearance', 'clothes', 'video_tokens']) {
            const v = normalizeFieldValue(key, raw[key]);
            if (v !== undefined && v !== null && v !== '') passport[key] = v;
        }
        return passport;
    }

    function buildLocation(raw) {
        const loc = {};
        if (raw.name && String(raw.name).trim()) loc.name = String(raw.name).trim();
        if (raw.description && String(raw.description).trim()) loc.description = String(raw.description).trim();
        if (raw.environment && typeof raw.environment === 'object') {
            const env = {};
            for (const key of ['time', 'season', 'lighting', 'weather', 'mood', 'atmosphere']) {
                const v = raw.environment[key];
                if (v !== undefined && v !== null && String(v).trim() !== '') env[key] = String(v).trim();
            }
            if (Object.keys(env).length > 0) loc.environment = env;
        }
        return loc;
    }

    // ======================================================
    // CHARACTERS — add / delete
    // ======================================================
    app.post('/api/v1/book/:bookId/characters', (req, res) => {
        try {
            const { bookId } = req.params;
            const { id, name, passport } = req.body || {};
            if (!name || !String(name).trim()) {
                return res.status(400).json({ error: 'Character name is required' });
            }
            const entityId = resolveId(id, name);
            if (!entityId) {
                return res.status(400).json({ error: 'Could not derive an id from the character name' });
            }

            const oldBook = loadBook(bookId);
            const chars = oldBook.characters || [];
            if (chars.some(c => c && c.id === entityId)) {
                return res.status(409).json({ error: `Character "${entityId}" already exists` });
            }

            chars.push({
                id: entityId,
                name: String(name).trim(),
                passport: buildPassport(passport),
            });
            oldBook.characters = chars;

            book.saveBookBundle(oldBook, null);
            log(`[ADD CHARACTER] ${bookId}/${entityId} (name=${String(name).trim().slice(0, 40)})`);
            return res.json({ saved: true, book_id: bookId, character_id: entityId });
        } catch (err) {
            console.error('[ADD CHARACTER] Error:', err.message);
            return res.status(err.statusCode || 500).json({ error: err.message });
        }
    });

    app.delete('/api/v1/book/:bookId/characters/:characterId', (req, res) => {
        try {
            const { bookId, characterId } = req.params;
            const oldBook = loadBook(bookId);

            const before = oldBook.characters || [];
            const after = before.filter(c => !(c && c.id === characterId));
            if (after.length === before.length) {
                return res.status(404).json({ error: `Character ${characterId} not found` });
            }
            oldBook.characters = after;

            // Dangling-data cleanup: a voice keyed by the deleted character's id
            // no longer has a character to belong to (voices mirror character ids).
            const voices = oldBook.voices || {};
            if (voices[characterId]) {
                delete voices[characterId];
                oldBook.voices = voices;
            }

            // Same dangling-data cleanup for the character's behavior
            // (behavior.json is keyed by character_id).
            const behaviors = oldBook.behaviors || {};
            if (behaviors[characterId]) {
                delete behaviors[characterId];
                oldBook.behaviors = behaviors;
            }

            book.saveBookBundle(oldBook, null);
            log(`[DELETE CHARACTER] ${bookId}/${characterId} (removed ${before.length - after.length} character(s))`);
            return res.json({ saved: true, book_id: bookId, character_id: characterId });
        } catch (err) {
            console.error('[DELETE CHARACTER] Error:', err.message);
            return res.status(err.statusCode || 500).json({ error: err.message });
        }
    });

    // ======================================================
    // LOCATIONS — add / delete
    // ======================================================
    app.post('/api/v1/book/:bookId/locations', (req, res) => {
        try {
            const { bookId } = req.params;
            const body = req.body || {};
            const name = body.name;
            if (!name || !String(name).trim()) {
                return res.status(400).json({ error: 'Location name is required' });
            }
            const entityId = resolveId(body.id, name);
            if (!entityId) {
                return res.status(400).json({ error: 'Could not derive an id from the location name' });
            }

            const oldBook = loadBook(bookId);
            const locations = oldBook.locations || {};
            if (locations[entityId]) {
                return res.status(409).json({ error: `Location "${entityId}" already exists` });
            }

            locations[entityId] = buildLocation(body);
            oldBook.locations = locations;

            book.saveBookBundle(oldBook, null);
            log(`[ADD LOCATION] ${bookId}/${entityId} (name=${String(name).trim().slice(0, 40)})`);
            return res.json({ saved: true, book_id: bookId, location_id: entityId });
        } catch (err) {
            console.error('[ADD LOCATION] Error:', err.message);
            return res.status(err.statusCode || 500).json({ error: err.message });
        }
    });

    app.delete('/api/v1/book/:bookId/locations/:locationId', (req, res) => {
        try {
            const { bookId, locationId } = req.params;
            const oldBook = loadBook(bookId);

            const locations = oldBook.locations || {};
            if (!locations[locationId]) {
                return res.status(404).json({ error: `Location ${locationId} not found` });
            }
            delete locations[locationId];
            oldBook.locations = locations;

            book.saveBookBundle(oldBook, null);
            log(`[DELETE LOCATION] ${bookId}/${locationId}`);
            return res.json({ saved: true, book_id: bookId, location_id: locationId });
        } catch (err) {
            console.error('[DELETE LOCATION] Error:', err.message);
            return res.status(err.statusCode || 500).json({ error: err.message });
        }
    });

    // ======================================================
    // VOICES — add / delete
    // ======================================================
    app.post('/api/v1/book/:bookId/voices', (req, res) => {
        try {
            const { bookId } = req.params;
            const body = req.body || {};
            const name = body.name;
            if (!name || !String(name).trim()) {
                return res.status(400).json({ error: 'Voice name is required' });
            }
            const entityId = resolveId(body.id, name);
            if (!entityId) {
                return res.status(400).json({ error: 'Could not derive an id from the voice name' });
            }

            const oldBook = loadBook(bookId);
            const voices = oldBook.voices || {};
            if (voices[entityId]) {
                return res.status(409).json({ error: `Voice "${entityId}" already exists` });
            }

            voices[entityId] = {
                instruction: body.instruction && String(body.instruction).trim()
                    ? String(body.instruction).trim()
                    : '',
            };
            oldBook.voices = voices;

            book.saveBookBundle(oldBook, null);
            log(`[ADD VOICE] ${bookId}/${entityId} (name=${String(name).trim().slice(0, 40)})`);
            return res.json({ saved: true, book_id: bookId, voice_id: entityId });
        } catch (err) {
            console.error('[ADD VOICE] Error:', err.message);
            return res.status(err.statusCode || 500).json({ error: err.message });
        }
    });

    app.delete('/api/v1/book/:bookId/voices/:voiceId', (req, res) => {
        try {
            const { bookId, voiceId } = req.params;
            const oldBook = loadBook(bookId);

            const voices = oldBook.voices || {};
            if (!voices[voiceId]) {
                return res.status(404).json({ error: `Voice ${voiceId} not found` });
            }
            delete voices[voiceId];
            oldBook.voices = voices;

            book.saveBookBundle(oldBook, null);
            log(`[DELETE VOICE] ${bookId}/${voiceId}`);
            return res.json({ saved: true, book_id: bookId, voice_id: voiceId });
        } catch (err) {
            console.error('[DELETE VOICE] Error:', err.message);
            return res.status(err.statusCode || 500).json({ error: err.message });
        }
    });

    // ======================================================
    // BEHAVIORS — add / delete (manual, keyed by character_id)
    //
    // behavior.json mirrors voices.json: a map keyed by the existing
    // character_id ({"berlioz": {"instruction": "..."}}). A behavior belongs
    // to a character that must already exist — no id transliteration here,
    // the key is a character id, not a free-form entity id.
    // ======================================================
    app.post('/api/v1/book/:bookId/behaviors', (req, res) => {
        try {
            const { bookId } = req.params;
            const body = req.body || {};
            const characterId = body.character_id && String(body.character_id).trim()
                ? String(body.character_id).trim()
                : null;
            if (!characterId) {
                return res.status(400).json({ error: 'character_id is required' });
            }

            const oldBook = loadBook(bookId);
            const chars = oldBook.characters || [];
            if (!chars.some(c => c && c.id === characterId)) {
                return res.status(404).json({ error: `Character ${characterId} not found` });
            }

            const behaviors = oldBook.behaviors || {};
            if (behaviors[characterId]) {
                return res.status(409).json({ error: `Behavior for character "${characterId}" already exists` });
            }

            behaviors[characterId] = {
                instruction: body.instruction && String(body.instruction).trim()
                    ? String(body.instruction).trim()
                    : '',
            };
            oldBook.behaviors = behaviors;

            book.saveBookBundle(oldBook, null);
            log(`[ADD BEHAVIOR] ${bookId}/${characterId}`);
            return res.json({ saved: true, book_id: bookId, character_id: characterId });
        } catch (err) {
            console.error('[ADD BEHAVIOR] Error:', err.message);
            return res.status(err.statusCode || 500).json({ error: err.message });
        }
    });

    app.delete('/api/v1/book/:bookId/behaviors/:characterId', (req, res) => {
        try {
            const { bookId, characterId } = req.params;
            const oldBook = loadBook(bookId);

            const behaviors = oldBook.behaviors || {};
            if (!behaviors[characterId]) {
                return res.status(404).json({ error: `Behavior for character ${characterId} not found` });
            }
            delete behaviors[characterId];
            oldBook.behaviors = behaviors;

            book.saveBookBundle(oldBook, null);
            log(`[DELETE BEHAVIOR] ${bookId}/${characterId}`);
            return res.json({ saved: true, book_id: bookId, character_id: characterId });
        } catch (err) {
            console.error('[DELETE BEHAVIOR] Error:', err.message);
            return res.status(err.statusCode || 500).json({ error: err.message });
        }
    });

    // ======================================================
    // CHAPTERS — add / delete (Editor structure CRUD)
    //
    // New chapters get a canonical hex id (lazy-book paths), sensible JSON
    // defaults and are inserted AFTER a given chapter (after_chapter_id) so the
    // reading order stays exactly where the user asked. saveBookBundle keeps
    // book.json's chapters_order in sync and cleans up the deleted chapter file.
    // ======================================================
    function findChapterIndex(chapters, chapterIdLike) {
        return chapters.findIndex((c) =>
            c && (c.chapter_id === chapterIdLike || c.chapter === chapterIdLike));
    }

    app.post('/api/v1/book/:bookId/chapters', (req, res) => {
        try {
            const { bookId } = req.params;
            const { title, after_chapter_id, id } = req.body || {};
            const oldBook = loadBook(bookId);

            const chapters = oldBook.chapters || [];
            const newId = resolveStructureId(
                String(id || '').trim(),
                chapterId,
                (proposed) => findChapterIndex(chapters, proposed) >= 0,
            );
            // A chapter is only reachable/usable in the editor through a valid
            // chapter+scene position — an empty chapter would be unreachable, so
            // every new chapter is seeded with one narration scene + one unit
            // (same minimal structure as POST /book/blank). The user edits or
            // adds more scenes/units afterwards.
            const seedScId = sceneId();
            const seedUnitId = unitId();
            const newChapter = {
                chapter_id: newId,
                chapter_title: title && String(title).trim() ? String(title).trim() : null,
                type: 'chapter',
                scenes: [{
                    scene_id: seedScId,
                    scene_title: null,
                    type: 'narration',
                    participants: [],
                    audio: { voice: 'narrator', full_text: '' },
                    units: [{ id: seedUnitId, type: 'narration', text: '' }],
                }],
            };

            const idx = after_chapter_id ? findChapterIndex(chapters, after_chapter_id) : -1;
            if (idx >= 0) chapters.splice(idx + 1, 0, newChapter);
            else chapters.push(newChapter);
            oldBook.chapters = chapters;

            book.saveBookBundle(oldBook, null);
            log(`[ADD CHAPTER] ${bookId}/${newId} (after=${after_chapter_id || 'end'})`);
            return res.json({
                saved: true, book_id: bookId, chapter_id: newId,
                scene_id: seedScId, unit_id: seedUnitId,
            });
        } catch (err) {
            console.error('[ADD CHAPTER] Error:', err.message);
            return res.status(err.statusCode || 500).json({ error: err.message });
        }
    });

    app.delete('/api/v1/book/:bookId/chapters/:chapterId', async (req, res) => {
        try {
            const { bookId, chapterId } = req.params;
            const oldBook = loadBook(bookId);

            const chapters = oldBook.chapters || [];
            if (chapters.length <= 1) {
                // A book must always keep its initial/zero chapter — never allow
                // a state where the editor faces a completely empty structure.
                return res.status(400).json({ error: 'Cannot delete the last chapter' });
            }
            const targetChapter = chapters.find((c) => c && (c.chapter_id === chapterId || c.chapter === chapterId));
            if (!targetChapter) {
                return res.status(404).json({ error: `Chapter ${chapterId} not found` });
            }
            // Collect scene IDs BEFORE modifying the book, so we know
            // exactly which scenes need deep cleanup.
            const scenesToPurge = (targetChapter.scenes || []).map((s) => s.scene_id).filter(Boolean);

            const before = chapters.length;
            const after = chapters.filter((c) => !(c && (c.chapter_id === chapterId || c.chapter === chapterId)));
            oldBook.chapters = after;

            book.saveBookBundle(oldBook, null);

            // Deep cleanup: for each scene in the deleted chapter, purge PG + Redis
            // + filesystem + in-flight dispatch (reuses the canonical purgeScene from
            // entity-cleanup). Partial failures are surfaced per-scene and retried
            // by the pending-purge mechanism — a scene purge failure NEVER fails the
            // already-successful chapter delete response.
            const sceneCleanupResults = [];
            for (const sceneId of scenesToPurge) {
                let result;
                try {
                    result = await cleanup.purgeScene(bookId, chapterId, sceneId);
                } catch (err) {
                    console.warn(`[DELETE CHAPTER] scene cleanup error for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
                    result = { complete: false, failed_steps: ['route_await'], steps: [] };
                }
                sceneCleanupResults.push({ scene_id: sceneId, ...result });
            }
            const allComplete = sceneCleanupResults.every((r) => r.complete);
            const failedScenes = sceneCleanupResults.filter((r) => !r.complete);

            log(`[DELETE CHAPTER] ${bookId}/${chapterId} (removed ${before - after.length}, scenes purged=${scenesToPurge.length}, complete=${allComplete})`);
            return res.json({
                saved: true, book_id: bookId, chapter_id: chapterId,
                cleanup: {
                    complete: allComplete,
                    scenes_purged: scenesToPurge.length,
                    failed_scenes: failedScenes.map((r) => r.scene_id),
                },
            });
        } catch (err) {
            console.error('[DELETE CHAPTER] Error:', err.message);
            return res.status(err.statusCode || 500).json({ error: err.message });
        }
    });

    // ======================================================
    // SCENES — add / delete inside a chapter
    // ======================================================
    app.post('/api/v1/book/:bookId/chapters/:chapterId/scenes', (req, res) => {
        try {
            const { bookId, chapterId } = req.params;
            const { title, after_scene_id, id } = req.body || {};
            const oldBook = loadBook(bookId);

            const chIdx = findChapterIndex(oldBook.chapters || [], chapterId);
            if (chIdx < 0) return res.status(404).json({ error: `Chapter ${chapterId} not found` });
            const ch = oldBook.chapters[chIdx];
            const scenes = ch.scenes || [];

            const newId = resolveStructureId(
                String(id || '').trim(),
                sceneId,
                (proposed) => (oldBook.chapters || []).some((c) =>
                    (c.scenes || []).some((s) => s.scene_id === proposed)),
            );
            // Like chapters, a scene is seeded with one unit so the editor has a
            // usable anchor (module) right away; the user edits or adds more.
            const seedUnitId = unitId();
            const newScene = {
                scene_id: newId,
                scene_title: title && String(title).trim() ? String(title).trim() : null,
                type: 'narration',
                participants: [],
                audio: { voice: 'narrator', full_text: '' },
                units: [{ id: seedUnitId, type: 'narration', text: '' }],
            };

            const idx = after_scene_id ? scenes.findIndex((s) => s.scene_id === after_scene_id) : -1;
            if (idx >= 0) scenes.splice(idx + 1, 0, newScene);
            else scenes.push(newScene);
            ch.scenes = scenes;

            book.saveBookBundle(oldBook, null);
            log(`[ADD SCENE] ${bookId}/${chapterId}/${newId} (after=${after_scene_id || 'end'})`);
            return res.json({
                saved: true, book_id: bookId, chapter_id: chapterId,
                scene_id: newId, unit_id: seedUnitId,
            });
        } catch (err) {
            console.error('[ADD SCENE] Error:', err.message);
            return res.status(err.statusCode || 500).json({ error: err.message });
        }
    });

    app.delete('/api/v1/book/:bookId/chapters/:chapterId/scenes/:sceneId', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const oldBook = loadBook(bookId);

            const chIdx = findChapterIndex(oldBook.chapters || [], chapterId);
            if (chIdx < 0) return res.status(404).json({ error: `Chapter ${chapterId} not found` });
            const ch = oldBook.chapters[chIdx];
            const scenes = ch.scenes || [];
            if (scenes.length <= 1) {
                // A chapter always keeps at least one scene — an empty chapter is
                // unreachable through the editor's chapter+scene position.
                return res.status(400).json({ error: 'Cannot delete the last scene of a chapter' });
            }
            const before = scenes.length;
            const after = scenes.filter((s) => !(s && s.scene_id === sceneId));
            if (after.length === before) {
                return res.status(404).json({ error: `Scene ${sceneId} not found` });
            }
            ch.scenes = after;

            book.saveBookBundle(oldBook, null);
            // Deep cleanup: PostgreSQL + Redis + filesystem + in-flight dispatch
            // (reuses bookSync.purgeRemovedSceneRows / dispatch-engine / scheduler).
            // Cleanup is best-effort and surfaced in the response — a partial
            // failure is recorded for the reconcile cycle to retry, never hidden.
            let cleanupResult;
            try {
                cleanupResult = await cleanup.purgeScene(bookId, chapterId, sceneId);
            } catch (err) {
                console.warn(`[DELETE SCENE] cleanup error for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
                cleanupResult = { complete: false, failed_steps: ['route_await'], steps: [] };
            }
            log(`[DELETE SCENE] ${bookId}/${chapterId}/${sceneId} (removed ${before - after.length})`);
            return res.json({
                saved: true, book_id: bookId, chapter_id: chapterId, scene_id: sceneId,
                cleanup: {
                    complete: cleanupResult.complete,
                    failed_steps: cleanupResult.failed_steps || [],
                },
            });
        } catch (err) {
            console.error('[DELETE SCENE] Error:', err.message);
            return res.status(err.statusCode || 500).json({ error: err.message });
        }
    });

    // ======================================================
    // UNITS (modules) — add / delete inside a scene
    // ======================================================
    app.post('/api/v1/book/:bookId/chapters/:chapterId/scenes/:sceneId/units', (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const { after_unit_id, id } = req.body || {};
            const oldBook = loadBook(bookId);

            const chIdx = findChapterIndex(oldBook.chapters || [], chapterId);
            if (chIdx < 0) return res.status(404).json({ error: `Chapter ${chapterId} not found` });
            const sc = (oldBook.chapters[chIdx].scenes || []).find((s) => s.scene_id === sceneId);
            if (!sc) return res.status(404).json({ error: `Scene ${sceneId} not found` });

            const units = sc.units || [];
            const newId = resolveStructureId(
                String(id || '').trim(),
                unitId,
                (proposed) => units.some((u) => u.id === proposed),
            );
            const newUnit = { id: newId, type: 'narration', text: '' };

            const idx = after_unit_id ? units.findIndex((u) => u.id === after_unit_id) : -1;
            if (idx >= 0) units.splice(idx + 1, 0, newUnit);
            else units.push(newUnit);
            sc.units = units;
            rebuildFullText(sc);

            book.saveBookBundle(oldBook, null);
            log(`[ADD UNIT] ${bookId}/${chapterId}/${sceneId}/${newId} (after=${after_unit_id || 'end'})`);
            return res.json({
                saved: true, book_id: bookId, chapter_id: chapterId,
                scene_id: sceneId, unit_id: newId,
                unit_index: idx >= 0 ? idx + 1 : units.length - 1,
            });
        } catch (err) {
            console.error('[ADD UNIT] Error:', err.message);
            return res.status(err.statusCode || 500).json({ error: err.message });
        }
    });

    app.delete('/api/v1/book/:bookId/chapters/:chapterId/scenes/:sceneId/units/:unitId', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId, unitId } = req.params;
            const oldBook = loadBook(bookId);

            const chIdx = findChapterIndex(oldBook.chapters || [], chapterId);
            if (chIdx < 0) return res.status(404).json({ error: `Chapter ${chapterId} not found` });
            const sc = (oldBook.chapters[chIdx].scenes || []).find((s) => s.scene_id === sceneId);
            if (!sc) return res.status(404).json({ error: `Scene ${sceneId} not found` });

            const units = sc.units || [];
            const before = units.length;
            const after = units.filter((u) => !(u && u.id === unitId));
            if (after.length === before) {
                return res.status(404).json({ error: `Unit ${unitId} not found` });
            }
            sc.units = after;
            // Rebuild audio.full_text from remaining units so narration audio
            // generation does not use stale text that included the deleted unit.
            rebuildFullText(sc);

            book.saveBookBundle(oldBook, null);
            // Deep cleanup: PostgreSQL (image_units) + Redis (iu registry, in-flight,
            // GPU dedup) + filesystem (IU/preview PNG) + cancel in-flight + mark the
            // parent scene dirty for regeneration. Partial failures are surfaced in
            // the response and retried by the reconcile cycle.
            let cleanupResult;
            try {
                cleanupResult = await cleanup.purgeUnit(bookId, chapterId, sceneId, unitId, oldBook);
            } catch (err) {
                console.warn(`[DELETE UNIT] cleanup error for ${bookId}/${chapterId}/${sceneId}/${unitId}: ${err.message}`);
                cleanupResult = { complete: false, failed_steps: ['route_await'], steps: [] };
            }
            log(`[DELETE UNIT] ${bookId}/${chapterId}/${sceneId}/${unitId} (removed ${before - after.length})`);
            return res.json({
                saved: true, book_id: bookId, chapter_id: chapterId, scene_id: sceneId, unit_id: unitId,
                cleanup: {
                    complete: cleanupResult.complete,
                    failed_steps: cleanupResult.failed_steps || [],
                },
            });
        } catch (err) {
            console.error('[DELETE UNIT] Error:', err.message);
            return res.status(err.statusCode || 500).json({ error: err.message });
        }
    });

    // ======================================================
    // BLANK BOOK — "Create visual book" scaffold (File page)
    //
    // Builds the minimal valid structure the Editor can anchor on right away:
    //   chapters[0] → one scene → one module. The user then builds the book
    //   manually with the Editor's +/- controls (AI stays an optional assistant).
    // Reuses generateBookId (paths.js) for the book id — no new id mechanism.
    // ======================================================
    app.post('/api/v1/book/blank', async (req, res) => {
        try {
            const { title } = req.body || {};
            const label = title && String(title).trim() ? String(title).trim() : 'Новая книга';
            const bookId = generateBookId(label);
            if (book.loadBook(bookId)) {
                // Extremely unlikely (timestamp-suffixed), but never clobber.
                return res.status(409).json({ error: `Book ${bookId} already exists` });
            }

            const chFile = `${chapterId()}.json`;
            const scId = sceneId();
            const uId = unitId();
            const now = new Date().toISOString();

            const blankBook = {
                manifest: {
                    vbook_version: '3.1',
                    book_id: bookId,
                    build_id: `manual_${Date.now()}`,
                    created_at: now,
                },
                book: {
                    book_id: bookId,
                    version: '3.0',
                    title: label,
                    author: '',
                    language: 'ru',
                    structure: { chapters_order: [chFile] },
                    defaults: { narration_voice: 'narrator' },
                },
                bible: {},
                characters: [],
                voices: {},
                locations: {},
                chapters: [{
                    chapter_id: chFile.replace('.json', ''),
                    chapter_title: 'Новая глава',
                    type: 'chapter',
                    scenes: [{
                        scene_id: scId,
                        scene_title: 'Сцена 1',
                        type: 'narration',
                        participants: [],
                        audio: { voice: 'narrator', full_text: '' },
                        units: [{ id: uId, type: 'narration', text: '' }],
                    }],
                }],
            };

            try {
                const workspaceOwnership = require('../../middleware/workspace-ownership');
                await workspaceOwnership.resolveWorkspaceForBook(bookId, {
                    bookTitle: label,
                    preferredWorkspaceId: req.workspace?.id || null,
                });
            } catch (err) {
                console.warn(`[CREATE BLANK BOOK] Ownership attach failed for ${bookId} (non-fatal): ${err.message}`);
            }

            book.saveBookBundle(blankBook, null);
            log(`[CREATE BLANK BOOK] ${bookId} (title=${label.slice(0, 40)})`);
            return res.json({ saved: true, book_id: bookId, title: label });
        } catch (err) {
            console.error('[CREATE BLANK BOOK] Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });
};
