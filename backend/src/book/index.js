// ======================================================
// Book Module - v2.1.0
// ======================================================
// Handles book loading, saving, and bundle operations.
// NOT stateful - just pure file/book operations.
//
// Storage format (v2.1): multi-file directory structure
// Cover is a standard chapter stored in chapters/ directory
// with chapter_title: "Обложка". No standalone cover.json.
//
//   /data/books/<bookId>/
//     manifest.json
//     book.json
//     bible.json            (optional)
//     characters.json       (optional)
//     chapters/
//       ch-XXXXXXXX.json    (one per chapter, Cover is first)
//
// Legacy single-file format is still readable for migration:
//   /data/books/<bookId>.json

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const config = require('../config/runtime-config');

// ======================================================
// PATH HELPERS
// ======================================================

function getBooksDir() {
    return config.BOOKS_DIR;
}

function getBookDir(bookId) {
    return path.join(getBooksDir(), bookId);
}

function getBookPath(bookId) {
    return path.join(getBooksDir(), `${bookId}.json`);
}

function getChapterDir(bookDir) {
    return path.join(bookDir, 'chapters');
}

function getChapterPath(bookDir, chapterFile) {
    return path.join(getChapterDir(bookDir), chapterFile);
}

// ======================================================
// BOOK BUNDLE OPERATIONS
// ======================================================

/**
 * Extract book bundle from buffer.
 * @param {Buffer} buffer - The zipped bundle buffer
 * @returns {Object} - Object with file contents keyed by filename (string values like backend expects)
 */
function extractBookBundle(buffer) {
    const zip = new AdmZip(buffer);
    const files = {};

    zip.getEntries().forEach(entry => {
        if (!entry.isDirectory) {
            files[entry.entryName] = zip.readAsText(entry);
        }
    });

    return files;
}

/**
 * Build book from extracted bundle.
 * @param {Object} rawFiles - Object with file contents keyed by filename
 * @returns {Object} - The built book object with full metadata
 */
function buildBookFromBundle(rawFiles) {
    const normalize = (p) =>
        p
            .replace(/\\\\/g, "/")
            .replace(/\r/g, "")
            .replace(/^(\.\/)+/, "")
            .trim()
    const files = {}
    Object.entries(rawFiles).forEach(([k, v]) => {
        files[normalize(k)] = v
    })
    const keys = Object.keys(files)

    const findFile = (name) =>
        keys.find(k => k.toLowerCase().endsWith(name))

    // Manifest
    const manifestKey = findFile("manifest.json")
    if (!manifestKey) {
        throw new Error("manifest.json not found. Files: " + keys.join(", "))
    }
    let manifest
    try {
        manifest = JSON.parse(files[manifestKey])
    } catch {
        throw new Error("Invalid JSON in manifest.json")
    }
    if (!manifest.book_id) {
        throw new Error("manifest.book_id missing")
    }

    // Bible, locations & characters
    const bibleKey = findFile("bible.json")
    const locationsKey = findFile("locations.json")
    const charactersKey = findFile("characters.json")
    let bible = {}
    let characters = []
    if (bibleKey) {
        try {
            bible = JSON.parse(files[bibleKey])
        } catch {
            throw new Error("Invalid JSON in bible.json")
        }
    }
    let locations = {};
    if (locationsKey) {
        try {
            locations = JSON.parse(files[locationsKey]);
        } catch {
            throw new Error("Invalid JSON in locations.json")
        }
    }

    // Voices
    const voicesKey = findFile("voices.json");
    let voices = {};
    if (voicesKey) {
        try {
            voices = JSON.parse(files[voicesKey]);
        } catch {
            throw new Error("Invalid JSON in voices.json")
        }
    }
    if (charactersKey) {
        try {
            characters = JSON.parse(files[charactersKey])
        } catch {
            throw new Error("Invalid JSON in characters.json")
        }
    }

    // Book metadata
    const bookKey = findFile("book.json")
    if (!bookKey) {
        throw new Error("book.json not found. Files: " + keys.join(", "))
    }
    let parsedBook
    try {
        parsedBook = JSON.parse(files[bookKey])
    } catch {
        throw new Error("Invalid JSON in book.json")
    }
    if (!parsedBook.structure?.chapters_order) {
        throw new Error("book.structure.chapters_order missing")
    }

    // Chapters
    const chapters = parsedBook.structure.chapters_order.map(file => {
        const fullKey = keys.find(k => k.endsWith(file))
        if (!fullKey) {
            throw new Error("Missing chapter file: " + file)
        }
        try {
            return JSON.parse(files[fullKey])
        } catch {
            throw new Error("Invalid JSON in " + fullKey)
        }
    })
    if (!chapters.length) {
        throw new Error("No chapters loaded")
    }

    // CANONICAL ID VALIDATION — format: sc-XXXXXXXX, ch-XXXXXXXX, iu-XXXXXXXX
    function assertCanonicalChapterId(id) {
        if (!id || !/^ch-[a-f0-9]{6,}$/.test(id)) {
            throw new Error("Invalid chapter_id: " + id + " (expected: ch-XXXXXXXX)")
        }
    }
    function assertCanonicalSceneId(id) {
        if (!id || !/^sc-[a-f0-9]{6,}$/.test(id)) {
            throw new Error("Invalid scene_id: " + id + " (expected: sc-XXXXXXXX)")
        }
    }
    function assertCanonicalUnitId(id) {
        if (!id || !/^iu-[a-f0-9]{6,}$/.test(id)) {
            throw new Error("Invalid unit_id: " + id + " (expected: iu-XXXXXXXX)")
        }
    }

    for (const chapter of chapters) {
        assertCanonicalChapterId(chapter.chapter_id)
        if (chapter.scenes) {
            for (const scene of chapter.scenes) {
                assertCanonicalSceneId(scene.scene_id)
                const allUnits = collectSceneUnits(scene)
                for (const unit of allUnits) {
                    assertCanonicalUnitId(unit.id)
                }
            }
        }
    }

    return {
        manifest,
        book: parsedBook,
        bible,
        characters,
        chapters,
        locations,
        voices
    }
}

// ======================================================
// DIRECTORY HELPERS
// ======================================================

/**
 * Recursively add directory contents to a ZIP archive.
 * @param {AdmZip} zip
 * @param {string} dirPath - Absolute path on disk
 * @param {string} zipPath - Prefix path inside ZIP
 */
function addDirToZip(zip, dirPath, zipPath) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const entryZipPath = zipPath ? `${zipPath}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            addDirToZip(zip, fullPath, entryZipPath);
        } else {
            zip.addFile(entryZipPath, fs.readFileSync(fullPath));
        }
    }
}

// ======================================================
// BOOK PERSISTENCE (multi-file format, v2)
// ======================================================

/**
 * Save book bundle to disk using multi-file format.
 * @param {Object} book - The book object {manifest, book, bible, characters, chapters}
 * @param {Object|null} files - Optional raw file contents from extractBookBundle.
 *        When provided, files are written with original content preserving formatting.
 *        When null, book object is serialised into individual files.
 */
function saveBookBundle(book, files) {
    const bookId = book.manifest?.book_id;
    if (!bookId) {
        throw new Error('Book ID not found in manifest');
    }

    const booksDir = getBooksDir();
    if (!fs.existsSync(booksDir)) {
        fs.mkdirSync(booksDir, { recursive: true });
    }

    const bookDir = getBookDir(bookId);
    if (!fs.existsSync(bookDir)) {
        fs.mkdirSync(bookDir, { recursive: true });
    }

    // When raw files map is provided, write them in canonical multi-file format:
    // non-chapter files → book root, chapter files → chapters/ subdirectory.
    if (files && typeof files === 'object' && Object.keys(files).length > 0) {
        const normalize = (p) =>
            p.replace(/\\\\/g, "/").replace(/\r/g, "").replace(/^(\.\/)+/, "").trim()

        // Determine which files are chapters from book.structure.chapters_order
        const chaptersOrder = book.book?.structure?.chapters_order || [];
        const chapterBasenames = new Set(
            chaptersOrder.map(cf => cf.split('/').pop())
        );
        const rootBasenames = new Set(
            ['manifest.json', 'book.json', 'bible.json', 'locations.json', 'voices.json', 'characters.json']
        );

        for (const [filePath, content] of Object.entries(files)) {
            const normalized = normalize(filePath);
            const basename = normalized.split('/').pop();

            let targetPath;
            if (chapterBasenames.has(basename)) {
                // Chapter file → chapters/ subdirectory
                targetPath = path.join(bookDir, 'chapters', basename);
            } else {
                targetPath = path.join(bookDir, normalized);
            }

            const dir = path.dirname(targetPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(targetPath, content);
        }

        // Ensure chapters_order in book.json references filenames without path
        const bookMetaPath = path.join(bookDir, 'book.json');
        if (fs.existsSync(bookMetaPath)) {
            try {
                const bookMeta = JSON.parse(fs.readFileSync(bookMetaPath, 'utf8'));
                if (bookMeta.structure?.chapters_order) {
                    bookMeta.structure.chapters_order = bookMeta.structure.chapters_order.map(
                        cf => cf.split('/').pop()
                    );
                    fs.writeFileSync(bookMetaPath, JSON.stringify(bookMeta, null, 2));
                }
            } catch (e) {
                // Ignore book.json rewrite errors
            }
        }

        console.log(`[SAVE] Book: ${bookId} (from raw files, canonical format)`);
        return;
    }

    console.log(`[SAVE] Book: ${bookId}, chapters: ${book.chapters?.length}`);

    // Save manifest.json
    fs.writeFileSync(
        path.join(bookDir, 'manifest.json'),
        JSON.stringify(book.manifest, null, 2)
    );

    // Save book.json with chapters_order synced to actual chapters.
    // ⚠️ Only overwrite chapters_order when book.chapters is non-empty.
    // Lazy books keep chapters as files on disk; calling saveBookBundle
    // with an empty chapters array (e.g. from a stale GET response) would
    // destroy the existing chapters_order and make all chapters invisible.
    const bookMeta = book.book ? JSON.parse(JSON.stringify(book.book)) : {};
    if (!bookMeta.structure) bookMeta.structure = {};
    const chapterFilenames = (book.chapters || []).map(ch => `${ch.chapter_id}.json`);
    if (chapterFilenames.length > 0) {
        bookMeta.structure.chapters_order = chapterFilenames;
    }
    fs.writeFileSync(
        path.join(bookDir, 'book.json'),
        JSON.stringify(bookMeta, null, 2)
    );

    // Save bible.json (optional, without locations)
    const biblePath = path.join(bookDir, 'bible.json');
    if (book.bible && Object.keys(book.bible).length > 0) {
        const { locations: _bibleLocs, ...bibleWithoutLocations } = book.bible;
        fs.writeFileSync(biblePath, JSON.stringify(bibleWithoutLocations, null, 2));
    } else if (fs.existsSync(biblePath)) {
        fs.unlinkSync(biblePath);
    }

    // Save locations.json separately
    const locsPath = path.join(bookDir, 'locations.json');
    const hasLocations = book.locations && Object.keys(book.locations).length > 0;
    if (hasLocations) {
        fs.writeFileSync(locsPath, JSON.stringify(book.locations, null, 2));
    } else if (fs.existsSync(locsPath)) {
        fs.unlinkSync(locsPath);
    }

    // Save voices.json separately
    const voPath = path.join(bookDir, 'voices.json');
    const hasVoices = book.voices && Object.keys(book.voices).length > 0;
    if (hasVoices) {
        fs.writeFileSync(voPath, JSON.stringify(book.voices, null, 2));
    } else if (fs.existsSync(voPath)) {
        fs.unlinkSync(voPath);
    }

    // Save characters.json (optional)
    const charPath = path.join(bookDir, 'characters.json');
    if (book.characters && book.characters.length > 0) {
        fs.writeFileSync(charPath, JSON.stringify(book.characters, null, 2));
    } else if (fs.existsSync(charPath)) {
        fs.unlinkSync(charPath);
    }

    // Save chapters
    const chaptersDir = getChapterDir(bookDir);
    if (!fs.existsSync(chaptersDir)) {
        fs.mkdirSync(chaptersDir, { recursive: true });
    }

    const activeChapterFiles = new Set();
    for (const chapter of book.chapters || []) {
        const chapterFile = `${chapter.chapter_id}.json`;
        activeChapterFiles.add(chapterFile);
        fs.writeFileSync(
            path.join(chaptersDir, chapterFile),
            JSON.stringify(chapter, null, 2)
        );
    }

    // Clean up orphaned chapter files — ONLY when we have a known chapter list.
    // If chapters array is empty (e.g. from a stale/corrupted load), we don't know
    // which files belong, so NEVER delete anything to avoid data loss.
    if (chapterFilenames.length > 0) {
        try {
            const existingFiles = fs.readdirSync(chaptersDir);
            for (const f of existingFiles) {
                if (!activeChapterFiles.has(f)) {
                    const fp = path.join(chaptersDir, f);
                    if (fs.statSync(fp).isFile()) {
                        fs.unlinkSync(fp);
                    }
                }
            }
        } catch (e) {
            // Ignore cleanup errors
        }
    }
}

/**
 * Load book from disk (multi-file directory or legacy single JSON).
 * @param {string} bookId - The book ID to load
 * @returns {Object|null} - The loaded book {manifest, book, bible, characters, chapters}
 */
function loadBook(bookId) {
    const bookDir = getBookDir(bookId);
    const bookPath = getBookPath(bookId);

    // Multi-file directory format
    if (fs.existsSync(bookDir)) {
        try {
            const stat = fs.statSync(bookDir);
            if (stat.isDirectory()) {
                return loadBookFromDir(bookId, bookDir);
            }
        } catch (e) {
            // Fall through to single-file check
        }
    }

    // Legacy single-file format (for migration)
    if (fs.existsSync(bookPath)) {
        try {
            const content = fs.readFileSync(bookPath, 'utf8');
            return JSON.parse(content);
        } catch (err) {
            console.error(`Failed to load book ${bookId}:`, err.message);
            return null;
        }
    }

    return null;
}

/**
 * Load book from multi-file directory.
 * @param {string} bookId
 * @param {string} bookDir
 * @returns {Object|null}
 */
function loadBookFromDir(bookId, bookDir) {
    try {
        const manifestPath = path.join(bookDir, 'manifest.json');
        const bookMetaPath = path.join(bookDir, 'book.json');

        if (!fs.existsSync(manifestPath) || !fs.existsSync(bookMetaPath)) {
            return null;
        }

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const bookMeta = JSON.parse(fs.readFileSync(bookMetaPath, 'utf8'));

        // Optional bible.json
        let bible = {};
        const biblePath = path.join(bookDir, 'bible.json');
        if (fs.existsSync(biblePath)) {
            bible = JSON.parse(fs.readFileSync(biblePath, 'utf8'));
        }

        // Optional locations.json — load as top-level key
        let locations = {};
        const locationsPath = path.join(bookDir, 'locations.json');
        if (fs.existsSync(locationsPath)) {
            locations = JSON.parse(fs.readFileSync(locationsPath, 'utf8'));
        }

        // Optional voices.json — load as top-level key
        let voices = {};
        const voicesPath = path.join(bookDir, 'voices.json');
        if (fs.existsSync(voicesPath)) {
            voices = JSON.parse(fs.readFileSync(voicesPath, 'utf8'));
        }

        // Optional characters.json
        let characters = [];
        const charPath = path.join(bookDir, 'characters.json');
        if (fs.existsSync(charPath)) {
            characters = JSON.parse(fs.readFileSync(charPath, 'utf8'));
        }

        // Chapters: look in chapters/ subdirectory first, fall back to root
        const chaptersDir = getChapterDir(bookDir);
        const chapters = [];
        const chaptersOrder = bookMeta.structure?.chapters_order || [];

        for (const chapterFile of chaptersOrder) {
            const basename = chapterFile.split('/').pop();
            let cp = path.join(chaptersDir, basename);
            if (!fs.existsSync(cp)) {
                cp = path.join(bookDir, basename);
            }
            if (fs.existsSync(cp)) {
                chapters.push(JSON.parse(fs.readFileSync(cp, 'utf8')));
            }
        }

        return { manifest, book: bookMeta, bible, characters, chapters, locations, voices };
    } catch (err) {
        console.error(`Failed to load book from dir ${bookId}:`, err.message);
        return null;
    }
}

/**
 * Reset book (delete from disk).
 * @param {string} bookId - The book ID to delete
 */
async function resetBook(bookId) {
    const bookDir = getBookDir(bookId);
    const bookPath = getBookPath(bookId);

    if (fs.existsSync(bookDir)) {
        try {
            const stat = fs.statSync(bookDir);
            if (stat.isDirectory()) {
                fs.rmSync(bookDir, { recursive: true, force: true });
                return;
            }
        } catch (e) {
            // Fall through
        }
    }

    if (fs.existsSync(bookPath)) {
        fs.unlinkSync(bookPath);
    }
}

// ======================================================
// SCENE COLLECTION
// ======================================================

/**
 * Collect a flat scene list in book order (server-computed, thin-client contract).
 *
 * Every client (Android, Web, ...) builds playback queues and navigation from
 * this list instead of re-implementing chapter→scene traversal. Cover detection
 * is also centralized: the first entry with type "cover" is the book cover.
 *
 * @param {Object} book - The loaded book object
 * @returns {Array} - [{ chapter_id, scene_id, type }] in book order
 */
function collectSceneList(book) {
    const list = [];
    if (!book || !Array.isArray(book.chapters)) return list;
    for (const ch of book.chapters) {
        if (!ch.scenes || !Array.isArray(ch.scenes)) continue;
        for (const sc of ch.scenes) {
            list.push({
                // chapter_id for modern lazy-book chapters, `chapter` for legacy.
                chapter_id: ch.chapter_id ?? ch.chapter,
                scene_id: sc.scene_id,
                type: sc.type || 'narration',
            });
        }
    }
    return list;
}

/**
 * Collect all scenes from book chapters.
 * Cover is now a regular chapter (chapters[0]), no special handling needed.
 * @param {Object} book - The loaded book object
 * @returns {Array} - Array of scene runtime entries
 */
function collectScenes(book) {
    const scenes = [];
    
    if (!book || !Array.isArray(book.chapters)) {
        return scenes;
    }

    for (const chapter of book.chapters) {
        if (!chapter.scenes || !Array.isArray(chapter.scenes)) {
            continue;
        }
        
        for (let scIndex = 0; scIndex < chapter.scenes.length; scIndex++) {
            const scene = chapter.scenes[scIndex];
            scenes.push({
                book_id: book.manifest?.book_id,
                // chapter_id for modern lazy-book chapters, `chapter` for legacy.
                chapter_id: chapter.chapter_id ?? chapter.chapter,
                scene_id: scene.scene_id,
                runtime_type: 'scene',
                scene_type: scene.type || 'narration',
                location: scene.location || null,
                participants: scene.participants || [],
                chapter: chapter,
                scene: scene,
                sceneIndex: scIndex,
                scene_order: scenes.length + 1,
                payload: scene
            });
        }
    }
    
    return scenes;
}

// ======================================================
// IU HELPERS
// ======================================================

/**
 * Collect scene units from scene payload.
 * @param {Object} scenePayload - The scene payload object
 * @returns {Array} - Array of unit objects
 */
function collectSceneUnits(scenePayload) {
    const result = [];
    if (scenePayload?.units?.length) {
        for (const unit of scenePayload.units) {
            if (unit && unit.id) {
                result.push(unit);
            }
        }
    }
    if (scenePayload?.dialogue_blocks?.length) {
        for (const block of scenePayload.dialogue_blocks) {
            if (block?.units?.length) {
                for (const unit of block.units) {
                    if (unit && unit.id) {
                        result.push(unit);
                    }
                }
            }
        }
    }
    return result;
}

/**
 * Find scene runtime data by chapter and scene ID.
 * @param {Object} loadedBook - The loaded book object
 * @param {string} chapterId - The chapter ID
 * @param {string} sceneId - The scene ID
 * @returns {Object|null} - The scene data or null if not found
 */
function findSceneRuntimeData(loadedBook, chapterId, sceneId) {
    if (!loadedBook || !Array.isArray(loadedBook.chapters)) {
        return null;
    }

    const bookId = loadedBook.manifest?.book_id;

    for (const chapter of loadedBook.chapters) {
        if (chapter.chapter_id !== chapterId) continue;

        if (!chapter.scenes || !Array.isArray(chapter.scenes)) {
            continue;
        }

        for (let scIndex = 0; scIndex < chapter.scenes.length; scIndex++) {
            const scene = chapter.scenes[scIndex];
            if (scene.scene_id === sceneId) {
                return {
                    runtime_type: 'scene',
                    book_id: bookId,
                    chapter_id: chapter.chapter_id ?? chapter.chapter,
                    scene_id: scene.scene_id,
                    scene_type: scene.type || 'narration',
                    location: scene.location || null,
                    participants: scene.participants || [],
                    chapter: chapter,
                    scene: scene,
                    sceneIndex: scIndex,
                    scene_order: scIndex + 1,
                    payload: scene
                };
            }
        }
    }
    
    return null;
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    // Bundle operations
    extractBookBundle,
    buildBookFromBundle,
    saveBookBundle,
    
    // Persistence
    loadBook,
    resetBook,
    
    // ZIP helpers
    addDirToZip,
    

    
    // Scene collection
    collectScenes,
    collectSceneList,
    collectSceneUnits,
    findSceneRuntimeData
};
