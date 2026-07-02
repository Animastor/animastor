// ======================================================
// TXT Importer Service - v3.0.0
// ======================================================
// Pipeline:
//   1. Validate TXT (encoding, size)
//   2. Create draft (RAW_IMPORTED)
//   3. Bootstrap: quick analysis → AI refinement → create structure → BOOTSTRAPPED
//   4. Fallback to programmatic bootstrap if AI unavailable
//   5. Lazy parse further scenes on demand
// ======================================================

const fs = require('fs');
const config = require('../config/runtime-config');
const lazyBook = require('../book/lazy-book');
const aiService = require('./ai-service');
const encodingDetect = require('./encoding-detect');

// ======================================================
// PROGRESS STAGES
// ======================================================

const ProgressStage = {
    VALIDATING: 'validating',
    LOADING: 'loading',
    ANALYZING: 'analyzing',
    EXTRACTING_CHARACTERS: 'extracting_characters',
    EXTRACTING_LOCATIONS: 'extracting_locations',
    AI_ANALYSIS: 'ai_analysis',
    CREATING_STRUCTURE: 'creating_structure',
    CREATING_SCENES: 'creating_scenes',
    COMPLETING: 'completing',
    DONE: 'done',
};

// ======================================================
// VALIDATION + ENCODING DETECTION
// ======================================================

function decodeTxtBuffer(buffer) {
    const result = { text: null, encoding: null, warnings: [], error: null };

    if (buffer.length > config.TXT_MAX_SIZE) {
        const maxMb = Math.floor(config.TXT_MAX_SIZE / (1024 * 1024));
        const actualMb = (buffer.length / (1024 * 1024)).toFixed(2);
        result.error = `File too large: ${actualMb} MB (max ${maxMb} MB)`;
        return result;
    }

    // Try to detect encoding and decode
    const detection = encodingDetect.decodeBuffer(buffer);
    if (detection.error) {
        result.error = detection.error;
        return result;
    }

    result.text = detection.text;
    result.encoding = detection.encoding;
    result.label = detection.label;
    result.warnings = detection.warnings || [];

    return result;
}

function validateAiText(text) {
    const errors = [];
    if (!text || typeof text !== 'string') { errors.push('No text provided'); return { valid: false, errors }; }
    if (Buffer.byteLength(text, 'utf8') > config.TXT_MAX_SIZE) {
        const maxMb = Math.floor(config.TXT_MAX_SIZE / (1024 * 1024));
        const actualMb = (Buffer.byteLength(text, 'utf8') / (1024 * 1024)).toFixed(2);
        errors.push(`Text too large: ${actualMb} MB (max ${maxMb} MB)`);
    }
    return { valid: errors.length === 0, errors };
}

// ======================================================
// FULL IMPORT PIPELINE
// ======================================================

async function importTxtFile(buffer, filename, progressCallback) {
    const progress = progressCallback || (() => {});

    progress(ProgressStage.VALIDATING, 'Decoding file...');
    const decoded = decodeTxtBuffer(buffer);
    if (decoded.error) {
        throw new Error('TXT import failed: ' + decoded.error);
    }

    // Report encoding info
    if (decoded.label && decoded.label !== 'UTF-8') {
        progress(ProgressStage.VALIDATING, `Detected encoding: ${decoded.label}`);
    }

    const sourceText = decoded.text;
    const title = require('path').basename(filename, '.txt');

    progress(ProgressStage.LOADING, 'Loading file...');
    const draft = lazyBook.createDraftBook(sourceText, lazyBook.SourceType.TXT, title);

    const bookDir = lazyBook.getBookDir(draft.bookId);
    const mp = lazyBook.getManifestPath(bookDir);
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
    m.import_meta.original_filename = filename;
    fs.writeFileSync(mp, JSON.stringify(m, null, 2));

    // Bootstrap: quick analysis → AI refinement → structure
    const bootstrapResult = await bootstrapImportedText(draft.bookId, progress);

    return {
        bookId: draft.bookId,
        title: bootstrapResult.title,
        author: bootstrapResult.author,
        language: bootstrapResult.language,
        state: lazyBook.BookState.BOOTSTRAPPED,
        characters: bootstrapResult.characters,
        locations: bootstrapResult.locations,
        scenes: bootstrapResult.scenes,
    };
}

async function importAiText(text, title, progressCallback) {
    const progress = progressCallback || (() => {});

    progress(ProgressStage.VALIDATING, 'Validating text...');
    const validation = validateAiText(text);
    if (!validation.valid) {
        throw new Error('Text validation failed: ' + validation.errors.join('; '));
    }

    progress(ProgressStage.LOADING, 'Loading text...');
    const draft = lazyBook.createDraftBook(text, lazyBook.SourceType.AI_IMPORT, title || 'Imported Text');

    const bootstrapResult = await bootstrapImportedText(draft.bookId, progress);

    return {
        bookId: draft.bookId,
        title: bootstrapResult.title,
        author: bootstrapResult.author,
        language: bootstrapResult.language,
        state: lazyBook.BookState.BOOTSTRAPPED,
        characters: bootstrapResult.characters,
        locations: bootstrapResult.locations,
        scenes: bootstrapResult.scenes,
    };
}

// ======================================================
// BOOTSTRAP INTERNAL — Two-stage pipeline
// ======================================================

async function bootstrapImportedText(bookId, progress, publishProgress) {
    const _progress = progress || function(){};
    const fs = require('fs');
    const path = require('path');

    // Check current book state
    const draft = lazyBook.loadDraftBook(bookId);
    if (!draft || !draft.sourceText) throw new Error(`Book ${bookId} not found`);

    // If already bootstrapped, verify and return
    if (draft.manifest?.state === lazyBook.BookState.BOOTSTRAPPED) {
        console.log(`[BOOTSTRAP] ${bookId} already BOOTSTRAPPED, checking consistency...`);
        const bookDir = lazyBook.getBookDir(bookId);
        const chDir = lazyBook.getChapterDir(bookDir);
        if (fs.existsSync(chDir) && fs.readdirSync(chDir).length > 0) {
            console.log(`[BOOTSTRAP] ${bookId} consistent, skipping`);
            return {
                bookId,
                state: lazyBook.BookState.BOOTSTRAPPED,
                title: draft.book?.title || 'Unknown',
                author: draft.book?.author || null,
                characters: null,
                locations: null,
                scenes: null,
            };
        }
        console.log(`[BOOTSTRAP] ${bookId} stuck in BOOTSTRAPPED with no chapters, re-bootstrapping...`);
    }

    // Clean up partial bootstrap artifacts from previous failed attempts
    const bookDir = lazyBook.getBookDir(bookId);
    const chDir = lazyBook.getChapterDir(bookDir);
    const charPath = lazyBook.getCharactersPath(bookDir);
    const biblePath = lazyBook.getBiblePath(bookDir);

    if (fs.existsSync(chDir)) {
        const partialChapters = fs.readdirSync(chDir).filter(f => f.endsWith('.json'));
        if (partialChapters.length > 0) {
            console.log(`[BOOTSTRAP] Cleaning ${partialChapters.length} partial chapter files...`);
            for (const f of partialChapters) {
                fs.unlinkSync(path.join(chDir, f));
            }
        }
    }
    if (fs.existsSync(charPath)) {
        console.log('[BOOTSTRAP] Removing partial characters.json...');
        fs.unlinkSync(charPath);
    }
    if (fs.existsSync(biblePath)) {
        console.log('[BOOTSTRAP] Removing partial bible.json...');
        fs.unlinkSync(biblePath);
    }

    // Use the new agent pipeline (pass publishProgress for SSE)
    const agentService = require('./agent-service');
    const result = await agentService.bootstrapWithAgent(bookId, progress, publishProgress);

    return {
        ...result,
        locations: result.locations || 0,
    };
}

// ======================================================
// BOOTSTRAP NEXT WINDOW — process subsequent scene windows
// ======================================================

async function bootstrapNextWindow(bookId, progress, publishProgress) {
    const _progress = progress || (() => {});

    const draft = lazyBook.loadDraftBook(bookId);
    if (!draft || !draft.sourceText) {
        throw new Error(`Book ${bookId} not found`);
    }

    const agentService = require('./agent-service');
    const result = await agentService.bootstrapNextWindow(bookId, _progress, publishProgress);

    return {
        book_id: result.bookId,
        title: result.title,
        state: result.state,
        characters: result.characters || 0,
        locations: result.locations || 0,
        scenes: result.scenes || 0,
        added_scenes: result.added_scenes || 0,
        remaining_cached: result.remaining_cached || 0,
        all_done: result.all_done || false,
        cached: result.cached || false,
        chapters: result.chapter ? [{
            chapter: result.chapter.chapter,
            chapter_title: result.chapter.chapter_title,
            chapter_index: result.chapter.chapter_index,
            status: result.chapter.status,
            scene_count: result.chapter.scenes ? result.chapter.scenes.length : 0,
        }] : [],
    };
}

// ======================================================
// LAZY PARSE WRAPPERS
// ======================================================

function lazyParseNext(bookId, windowSize) {
    return lazyBook.lazyParseNextWindow(bookId, windowSize || lazyBook.DEFAULT_WINDOW_SIZE);
}

function lazyParseToPosition(bookId, chapterIndex, windowSize) {
    const ws = windowSize || lazyBook.DEFAULT_WINDOW_SIZE;
    const result = lazyBook.lazyParseChapter(bookId, chapterIndex);

    if (!result.wasExisting) {
        const draft = lazyBook.loadDraftBook(bookId);
        const parsedIndices = new Set(
            draft.chapters.filter(c => c.chapter_index !== undefined).map(c => c.chapter_index)
        );
        let parsed = 1;
        for (let i = chapterIndex + 1; i < chapterIndex + ws && i < (draft.sourceText ? lazyBook.splitIntoChapters(draft.sourceText).length : 0); i++) {
            if (!parsedIndices.has(i)) {
                lazyBook.lazyParseChapter(bookId, i);
                parsed++;
            }
        }
        return { chapter: result.chapter, wasExisting: false, preParsedAhead: parsed - 1 };
    }

    return result;
}

function getParsedChaptersSummary(bookId) {
    return lazyBook.getChaptersSummary(bookId);
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    ProgressStage,
    decodeTxtBuffer,
    validateAiText,
    importTxtFile,
    importAiText,
    bootstrapImportedText,
    bootstrapNextWindow,
    lazyParseNext,
    lazyParseToPosition,
    getParsedChaptersSummary,
};
