// ======================================================
// Book Source - canonical scene index
// ======================================================
// Single source of truth for what scenes exist in a book.
// Wraps the file-based loader (book/index.js) with helpers
// that answer: does this scene exist? what is its hash?
// give me all scenes, walk the scene graph.
//
// Every service that reads or writes scene-keyed data in
// the database MUST go through this module to validate
// that the (book, chapter, scene) triple exists in the
// Book JSON before persisting.

const bookLoader = require('../book');
const { computeSceneHash } = require('../utils/scene-hash');

const logPrefix = '[BOOK-SOURCE]';
function log(msg) { console.log(`${logPrefix} ${msg}`); }
function warn(msg) { console.warn(`${logPrefix} ⚠️  ${msg}`); }

const SCENE_KEY = (chapterId, sceneId) => `${chapterId}::${sceneId}`;

// ======================================================
// BOOK LOAD (delegates to file loader)
// ======================================================

function loadBookJson(bookId) {
    return bookLoader.loadBook(bookId);
}

function loadBookJsonOrThrow(bookId) {
    const b = bookLoader.loadBook(bookId);
    if (!b) throw new Error(`Book JSON not found: ${bookId}`);
    return b;
}

function bookJsonExists(bookId) {
    return bookLoader.loadBook(bookId) !== null;
}

// ======================================================
// CANONICAL SCENE INDEX
// ======================================================

/**
 * Get the set of canonical (chapter, scene) pairs that exist in the Book JSON.
 * @returns {Set<string>} Set of `${chapterId}::${sceneId}` keys.
 */
function getCanonicalScenes(bookId) {
    const b = bookLoader.loadBook(bookId);
    if (!b) {
        warn(`Book JSON missing for ${bookId}; canonical scene set is empty (all DB rows treated as unverified)`);
        return new Set();
    }
    const set = new Set();
    for (const ch of b.chapters || []) {
        if (!ch.scenes || !Array.isArray(ch.scenes)) continue;
        for (const sc of ch.scenes) {
            if (sc && sc.scene_id) {
                set.add(SCENE_KEY(ch.chapter, sc.scene_id));
            }
        }
    }
    return set;
}

function getCanonicalChapters(bookId) {
    const b = bookLoader.loadBook(bookId);
    if (!b) return [];
    return (b.chapters || []).map(ch => ch.chapter).filter(Boolean);
}

function getCanonicalScene(bookId, chapterId, sceneId) {
    const b = bookLoader.loadBook(bookId);
    if (!b) return null;
    return bookLoader.findSceneRuntimeData(b, chapterId, sceneId);
}

function sceneExists(bookId, chapterId, sceneId) {
    return getCanonicalScene(bookId, chapterId, sceneId) !== null;
}

function chapterExists(bookId, chapterId) {
    const b = bookLoader.loadBook(bookId);
    if (!b) return false;
    return (b.chapters || []).some(ch => ch.chapter === chapterId);
}

function assertSceneExists(bookId, chapterId, sceneId) {
    if (!sceneExists(bookId, chapterId, sceneId)) {
        const err = new Error(
            `Scene not in Book JSON: book=${bookId} chapter=${chapterId} scene=${sceneId}`
        );
        err.code = 'SCENE_NOT_IN_JSON';
        err.bookId = bookId;
        err.chapterId = chapterId;
        err.sceneId = sceneId;
        throw err;
    }
}

function assertChapterExists(bookId, chapterId) {
    if (!chapterExists(bookId, chapterId)) {
        const err = new Error(
            `Chapter not in Book JSON: book=${bookId} chapter=${chapterId}`
        );
        err.code = 'CHAPTER_NOT_IN_JSON';
        throw err;
    }
}

// ======================================================
// LIST / WALK
// ======================================================

function listScenes(bookId) {
    const b = loadBookJsonOrThrow(bookId);
    return bookLoader.collectScenes(b);
}

function listChapters(bookId) {
    const b = loadBookJsonOrThrow(bookId);
    return (b.chapters || []).map((ch, i) => ({
        chapter_id: ch.chapter,
        chapter_order: i + 1,
        type: ch.type || null,
        scene_count: Array.isArray(ch.scenes) ? ch.scenes.length : 0,
    }));
}

function walkScenes(bookId, callback) {
    for (const scene of listScenes(bookId)) {
        const stop = callback(scene);
        if (stop === false) break;
    }
}

// ======================================================
// FINGERPRINT (canonical hashes of all scenes)
// ======================================================

/**
 * Compute scene hashes for every scene in the Book JSON.
 * @returns {Map<string, string>} Map of `${chapterId}::${sceneId}` → sha256 hash
 */
function getBookFingerprint(bookId) {
    const b = bookLoader.loadBook(bookId);
    if (!b) return new Map();
    const fp = new Map();
    for (const ch of b.chapters || []) {
        if (!ch.scenes || !Array.isArray(ch.scenes)) continue;
        for (const sc of ch.scenes) {
            if (!sc || !sc.scene_id) continue;
            const hash = computeSceneHash(sc);
            if (hash) fp.set(SCENE_KEY(ch.chapter, sc.scene_id), hash);
        }
    }
    return fp;
}

function getSceneHash(bookId, chapterId, sceneId) {
    const scene = getCanonicalScene(bookId, chapterId, sceneId);
    if (!scene) return null;
    return computeSceneHash(scene.payload || scene.scene);
}

function getBookContentHash(bookId) {
    const b = bookLoader.loadBook(bookId);
    if (!b) return null;
    return computeSceneHash(b);
}

// ======================================================
// SAVE (write canonical JSON)
// ======================================================

function saveBookJson(bookId, book) {
    bookLoader.saveBookBundle(book);
    log(`SAVED Book JSON: ${bookId}`);
}

function deleteBookJson(bookId) {
    return bookLoader.resetBook(bookId);
}

module.exports = {
    SCENE_KEY,

    loadBookJson,
    loadBookJsonOrThrow,
    bookJsonExists,
    saveBookJson,
    deleteBookJson,

    getCanonicalScenes,
    getCanonicalChapters,
    getCanonicalScene,
    sceneExists,
    chapterExists,
    assertSceneExists,
    assertChapterExists,

    listScenes,
    listChapters,
    walkScenes,

    getBookFingerprint,
    getSceneHash,
    getBookContentHash,
};
