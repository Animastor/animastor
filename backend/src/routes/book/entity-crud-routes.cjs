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
const { normalizeFieldValue } = require('./scene-patch-utils.cjs');

module.exports = function (app, redis, deps) {
    const { book, utils } = deps;
    const { log } = utils;

    function loadBook(bookId) {
        const b = book.loadBook(bookId);
        if (!b) {
            const err = new Error('Book not found');
            err.statusCode = 404;
            throw err;
        }
        return b;
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
};
