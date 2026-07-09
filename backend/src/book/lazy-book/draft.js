// ======================================================
// Lazy Book — Draft Management
// ======================================================

const fs = require('fs');
const path = require('path');
const {
    BookState, SceneStatus, SourceType,
} = require('./constants');
const {
    getBookDir, getSourcePath, getManifestPath, getBookMetaPath,
    getCharactersPath, getMentionsPath, getBiblePath, getLocationsPath, getVoicesPath, getChapterDir,
    generateBookId,
} = require('./paths');

function createDraftBook(sourceText, sourceType, title) {
    const bookId = generateBookId(title || 'untitled');
    const bookDir = getBookDir(bookId);
    fs.mkdirSync(bookDir, { recursive: true });

    const buildId = `build_${bookId}`;
    const manifest = {
        vbook_version: '3.1',
        book_id: bookId,
        build_id: buildId,
        source: sourceType,
        state: BookState.RAW_IMPORTED,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        import_meta: {
            source_type: sourceType,
            original_size: Buffer.byteLength(sourceText, 'utf8'),
            import_timestamp: new Date().toISOString(),
        },
    };

    const bookMeta = {
        book_id: bookId,
        version: '3.0',
        title: title || 'Imported Book',
        author: null,
        language: null,
        structure: {
            has_prologue: false,
            chapters_order: [],
        },
        defaults: {
            narration_voice: 'narrator',
            language: 'ru',
            scene: { auto_anchors: true, spatial_lock: true },
            iu: { character_binding: true },
        },
        transitions: {
            chapter_intro_style: 'soviet_book_page',
            default_transition: 'cut',
            soft_transition: 'fade',
        },
    };

    fs.writeFileSync(getManifestPath(bookDir), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(getBookMetaPath(bookDir), JSON.stringify(bookMeta, null, 2));
    fs.writeFileSync(getSourcePath(bookDir), sourceText, 'utf8');

    console.log(`[LAZY-BOOK] RAW_IMPORTED: ${bookId} (${sourceType}, ${manifest.import_meta.original_size} bytes)`);
    return { bookId, manifest, book: bookMeta };
}

function loadDraftBook(bookId) {
    const bookDir = getBookDir(bookId);
    if (!fs.existsSync(bookDir)) return null;

    try {
        const mp = getManifestPath(bookDir);
        const bp = getBookMetaPath(bookDir);
        if (!fs.existsSync(mp) || !fs.existsSync(bp)) return null;

        const manifest = JSON.parse(fs.readFileSync(mp, 'utf8'));
        const bookMeta = JSON.parse(fs.readFileSync(bp, 'utf8'));
        const sourceText = fs.existsSync(getSourcePath(bookDir))
            ? fs.readFileSync(getSourcePath(bookDir), 'utf8') : null;

        let characters = [];
        const charPath = getCharactersPath(bookDir);
        if (fs.existsSync(charPath)) characters = JSON.parse(fs.readFileSync(charPath, 'utf8'));

        let mentions = {};
        const mPath = getMentionsPath(bookDir);
        if (fs.existsSync(mPath)) mentions = JSON.parse(fs.readFileSync(mPath, 'utf8'));

        let bible = {};
        const bibPath = getBiblePath(bookDir);
        if (fs.existsSync(bibPath)) bible = JSON.parse(fs.readFileSync(bibPath, 'utf8'));

        // Load locations from separate file (top-level key)
        let locations = {};
        const locPath = getLocationsPath(bookDir);
        if (fs.existsSync(locPath)) {
            locations = JSON.parse(fs.readFileSync(locPath, 'utf8'));
        }

        // Load voices from separate file (top-level key)
        let voices = {};
        const voPath = getVoicesPath(bookDir);
        if (fs.existsSync(voPath)) {
            voices = JSON.parse(fs.readFileSync(voPath, 'utf8'));
        }

        const chapters = [];
        const chDir = getChapterDir(bookDir);
        if (fs.existsSync(chDir)) {
            const chFiles = fs.readdirSync(chDir).filter(f => f.endsWith('.json')).sort();
            for (const cf of chFiles) {
                try { chapters.push(JSON.parse(fs.readFileSync(path.join(chDir, cf), 'utf8'))); }
                catch (e) { console.warn(`[LAZY-BOOK] Skipping bad chapter ${cf}: ${e.message}`); }
            }
        }

        return { manifest, book: bookMeta, sourceText, characters, mentions, bible, chapters, locations, voices };
    } catch (err) {
        console.error(`[LAZY-BOOK] Failed to load ${bookId}:`, err.message);
        return null;
    }
}

function updateBookState(bookId, newState) {
    const mp = getManifestPath(getBookDir(bookId));
    if (!fs.existsSync(mp)) throw new Error(`Book ${bookId} not found`);
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
    m.state = newState;
    m.updated_at = new Date().toISOString();
    fs.writeFileSync(mp, JSON.stringify(m, null, 2));
    console.log(`[LAZY-BOOK] ${bookId}: ${newState}`);
    return m;
}

module.exports = {
    createDraftBook,
    loadDraftBook,
    updateBookState,
};
