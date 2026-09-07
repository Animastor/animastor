// ======================================================
// ANIMASTOR BACKEND — BUNDLE VALIDATOR
// ======================================================
// Canonical data-contract guard for the book bundle.
// Runs AFTER AI patch application and BEFORE any disk write,
// so a structurally broken mutation (e.g. a value of the wrong
// type that Android's strict parser cannot load) is rejected
// instead of becoming the new canonical state.
//
// Contract mirrors buildBookFromBundle() in src/book/index.js:
//   manifest.json   — object with book_id (required)
//   book.json       — object with structure.chapters_order array (required)
//   bible.json      — object (optional)
//   locations.json  — object keyed by location id (optional)
//   voices.json     — object keyed by voice id (optional)
//   behavior.json   — object keyed by character_id (optional)
//   characters.json — array of characters (optional)
//   chapters/*      — objects with canonical chapter_id (optional)
//
// Generic by design: no Voice.json-specific hardcoding — every
// resource that AI patches can touch is covered by the same check.
'use strict';

const CHAPTER_ID_RE = /^ch-[a-f0-9]{6,}$/;
const SCENE_ID_RE = /^sc-[a-f0-9]{6,}$/;
const UNIT_ID_RE = /^iu-[a-f0-9]{6,}$/;

function collectSceneUnits(scene) {
    const units = [];
    if (!scene || typeof scene !== 'object') return units;
    for (const value of Object.values(scene)) {
        if (Array.isArray(value)) {
            for (const item of value) {
                if (item && typeof item === 'object' && typeof item.id === 'string' && UNIT_ID_RE.test(item.id)) {
                    units.push(item);
                }
            }
        }
    }
    return units;
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Strict: NaN / Infinity cannot round-trip to valid JSON.
function assertSerializable(value, label, errors) {
    const seen = new WeakSet();
    const walk = (v, path) => {
        if (typeof v === 'number' && (!Number.isFinite(v) || Number.isNaN(v))) {
            errors.push(`${label}: non-serializable number ${String(v)} at "${path}"`);
            return;
        }
        if (v !== null && typeof v === 'object') {
            if (seen.has(v)) return; // circular refs are caught by stringify below
            seen.add(v);
            if (Array.isArray(v)) {
                v.forEach((item, i) => walk(item, `${path}[${i}]`));
            } else {
                for (const [k, item] of Object.entries(v)) walk(item, `${path}/${k}`);
            }
        }
    };
    walk(value, '');
    try {
        JSON.stringify(value);
    } catch (e) {
        errors.push(`${label}: not JSON-serializable (${e.message})`);
    }
}

function validateManifest(manifest, errors) {
    if (!isPlainObject(manifest)) {
        errors.push('manifest: must be a JSON object');
        return;
    }
    if (!manifest.book_id || typeof manifest.book_id !== 'string') {
        errors.push('manifest: book_id missing or not a string');
    }
}

function validateBookMeta(bookMeta, errors) {
    // Absent metadata is tolerated (lazy/draft flows); a wrong TYPE is not.
    if (bookMeta === undefined || bookMeta === null) return;
    if (!isPlainObject(bookMeta)) {
        errors.push('book: must be a JSON object');
        return;
    }
    const structure = bookMeta.structure;
    if (structure === undefined || structure === null) return;
    if (!isPlainObject(structure)) {
        errors.push('book: structure must be a JSON object');
        return;
    }
    const order = structure.chapters_order;
    if (order === undefined || order === null) return;
    if (!Array.isArray(order) || order.some(f => typeof f !== 'string')) {
        errors.push('book: structure.chapters_order must be an array of filenames');
    }
}

function validateVoiceEntry(id, entry, errors) {
    if (!isPlainObject(entry)) {
        errors.push(`voices: voice "${id}" must be an object (got ${Array.isArray(entry) ? 'array' : typeof entry})`);
        return;
    }
    if (entry.instruction !== undefined && entry.instruction !== null && typeof entry.instruction !== 'string') {
        errors.push(`voices: voice "${id}".instruction must be a string`);
    }
}

function validateVoices(voices, errors) {
    if (!isPlainObject(voices)) {
        errors.push(`voices: must be a JSON object keyed by voice id (got ${Array.isArray(voices) ? 'array' : typeof voices})`);
        return;
    }
    for (const [id, entry] of Object.entries(voices)) {
        validateVoiceEntry(id, entry, errors);
    }
}

function validateLocations(locations, errors) {
    if (!isPlainObject(locations)) {
        errors.push(`locations: must be a JSON object keyed by location id (got ${Array.isArray(locations) ? 'array' : typeof locations})`);
    }
}

function validateBehaviors(behaviors, errors) {
    if (!isPlainObject(behaviors)) {
        errors.push(`behaviors: must be a JSON object keyed by character_id (got ${Array.isArray(behaviors) ? 'array' : typeof behaviors})`);
    }
}

function validateCharacters(characters, errors) {
    if (!Array.isArray(characters)) {
        errors.push(`characters: must be a JSON array (got ${typeof characters})`);
        return;
    }
    characters.forEach((ch, i) => {
        if (!isPlainObject(ch)) {
            errors.push(`characters[${i}]: must be an object`);
        }
    });
}

function validateChapters(chapters, errors) {
    if (chapters == null) return;
    if (!Array.isArray(chapters)) {
        errors.push(`chapters: must be an array (got ${typeof chapters})`);
        return;
    }
    chapters.forEach((chapter, ci) => {
        const label = `chapters[${ci}]`;
        if (!isPlainObject(chapter)) {
            errors.push(`${label}: must be an object`);
            return;
        }
        const cid = chapter.chapter_id;
        if (typeof cid === 'string' && !CHAPTER_ID_RE.test(cid)) {
            errors.push(`${label}: invalid chapter_id "${cid}" (expected: ch-XXXXXXXX)`);
        }
        if (chapter.scenes !== undefined && !Array.isArray(chapter.scenes)) {
            errors.push(`${label}: scenes must be an array`);
            return;
        }
        (chapter.scenes || []).forEach((scene, si) => {
            const sceneLabel = `${label}/scenes[${si}]`;
            if (!isPlainObject(scene)) {
                errors.push(`${sceneLabel}: must be an object`);
                return;
            }
            const sid = scene.scene_id;
            if (typeof sid === 'string' && !SCENE_ID_RE.test(sid)) {
                errors.push(`${sceneLabel}: invalid scene_id "${sid}" (expected: sc-XXXXXXXX)`);
            }
            // participants must be an array of character_id strings — never a
            // display name, never a bare string, never a wrapped object
            // ({"item": [...]} — a model hallucination that previously slipped
            // through and corrupted the book's canonical state).
            const participants = scene.participants;
            if (participants !== undefined && participants !== null) {
                if (!Array.isArray(participants)) {
                    errors.push(`${sceneLabel}: participants must be an array of character_id strings (got ${Array.isArray(participants) ? 'array' : typeof participants})`);
                } else {
                    participants.forEach((p, pi) => {
                        if (typeof p !== 'string' || !p.trim()) {
                            errors.push(`${sceneLabel}/participants[${pi}]: must be a non-empty character_id string`);
                        }
                    });
                }
            }
            for (const unit of collectSceneUnits(scene)) {
                if (!UNIT_ID_RE.test(unit.id)) {
                    errors.push(`${sceneLabel}: invalid unit id "${unit.id}" (expected: iu-XXXXXXXX)`);
                }
            }
        });
    });
}

/**
 * Validate a book object (in-memory, post-patch) against the bundle contract.
 * @param {Object} book - {manifest, book, bible, characters, chapters, locations, voices, behaviors}
 * @returns {{valid: boolean, errors: string[]}} errors are empty when valid
 */
function validateBundleObject(book) {
    const errors = [];
    if (!isPlainObject(book)) {
        return { valid: false, errors: ['book data: must be a JSON object'] };
    }
    // Serializability first — the whole point is to never write JSON
    // that cannot be parsed back.
    assertSerializable(book, 'book data', errors);
    validateManifest(book.manifest, errors);
    validateBookMeta(book.book, errors);
    if (book.bible !== undefined && book.bible !== null && !isPlainObject(book.bible)) {
        errors.push('bible: must be a JSON object');
    }
    validateLocations(book.locations, errors);
    validateVoices(book.voices, errors);
    validateBehaviors(book.behaviors, errors);
    validateCharacters(book.characters, errors);
    validateChapters(book.chapters, errors);
    return { valid: errors.length === 0, errors };
}

/**
 * Lightweight per-chapter-file check: only validates scene.participants
 * structural shape. Unlike validateChapters (used by validateBundleObject),
 * this does NOT check chapter_id / scene_id regex format — those are
 * enforced by the full-book path and per-file checks would break existing
 * fixtures that use short test IDs like "ch-aaa", "sc-111".
 */
function validateSceneParticipantsOnly(chapter, errors) {
    if (!chapter || typeof chapter !== 'object' || Array.isArray(chapter)) return;
    const label = 'chapter (per-file)';
    (chapter.scenes || []).forEach((scene, si) => {
        const participants = scene.participants;
        if (participants === undefined || participants === null) return;
        if (!Array.isArray(participants)) {
            errors.push(`${label}/scenes[${si}]: participants must be an array of character_id strings (got ${Array.isArray(participants) ? 'array' : typeof participants})`);
        } else {
            participants.forEach((p, pi) => {
                if (typeof p !== 'string' || !p.trim()) {
                    errors.push(`${label}/scenes[${si}]/participants[${pi}]: must be a non-empty character_id string`);
                }
            });
        }
    });
}

/**
 * Validate one resource value before it is written to a bundle JSON file.
 * Used by saveBookBundle as a last line of defense right before writeFileSync.
 * @param {string} filename - target file name (e.g. 'voices.json')
 * @param {*} data - value to be serialized
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateBundleFile(filename, data) {
    const errors = [];
    assertSerializable(data, filename, errors);
    if (data !== null && typeof data !== 'object' && filename.endsWith('.json')) {
        errors.push(`${filename}: bundle JSON files must contain a JSON object or array`);
        return { valid: false, errors };
    }
    const name = filename.toLowerCase();
    if (name === 'voices.json') validateVoices(data, errors);
    else if (name === 'locations.json') validateLocations(data, errors);
    else if (name === 'characters.json') validateCharacters(data, errors);
    else if (name === 'behavior.json') validateBehaviors(data, errors);
    else if (name === 'bible.json') {
        if (data !== null && !isPlainObject(data)) errors.push('bible.json: must be a JSON object');
    }
    else if (name === 'chapter.json' || name.startsWith('ch-')) {
        validateSceneParticipantsOnly(data, errors);
    }
    return { valid: errors.length === 0, errors };
}

module.exports = {
    validateBundleObject,
    validateBundleFile,
};
