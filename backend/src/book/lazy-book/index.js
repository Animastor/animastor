// ======================================================
// Lazy Book - Barrel Index
// ======================================================
// Re-exports all lazy-book sub-modules for backward compatibility.
// Split from the original monolithic lazy-book/index.js.
//
// Sub-modules:
//   draft.js        - createDraftBook, loadDraftBook, updateBookState
//   parse.js        - lazyParseNextWindow, lazyParseChapter
//   status.js       - getBookStatus, getChaptersSummary
//   create.js       - createFromAnalysis, appendToBook, createOrAppendScenes
//   chapter-utils.js - createChapterIntroScene, createCoverChapter, saveCoverChapter, extractSceneTitle, isGenericSceneTitle
//   appearance.js   - fragmentAppearanceForVideo, extractClothing
//   metadata.js     - updateBookMetadata
//   constants.js    - BookState, SceneStatus, SourceType, UnitType, DEFAULT_WINDOW_SIZE (existing)
//   paths.js        - getBookDir, getSourcePath, getManifestPath, etc. (existing)
//   parser.js       - splitIntoChapters, splitIntoScenes, splitIntoUnits, etc. (existing)

const { BookState, SceneStatus, SourceType, UnitType, DEFAULT_WINDOW_SIZE } = require('./constants');

// Re-export everything from sub-modules
const draftModule = require('./draft');
const parseModule = require('./parse');
const statusModule = require('./status');
const createModule = require('./create');
const chapterUtilsModule = require('./chapter-utils');
const appearanceModule = require('./appearance');
const metadataModule = require('./metadata');

// Re-export paths and parsers (kept as separate files)
const {
    getBooksDir, getBookDir, getSourcePath, getManifestPath, getBookMetaPath,
    getCharactersPath, getBiblePath, getChapterDir, getChapterPath,
    chapterId, sceneId, unitId, generateBookId,
} = require('./paths');

const {
    splitIntoChapters, splitIntoScenes, splitIntoUnits,
    firstMeaningfulChapter, detectLanguage,
    injectChapterMarkers,
} = require('./parser');

module.exports = {
    // Constants
    BookState, SceneStatus, SourceType, UnitType,
    DEFAULT_WINDOW_SIZE,

    // Paths
    getBooksDir, getBookDir, getSourcePath, getManifestPath, getBookMetaPath,
    getCharactersPath, getBiblePath, getChapterDir, getChapterPath,

    // Parsers
    splitIntoChapters, splitIntoScenes, splitIntoUnits,
    firstMeaningfulChapter, detectLanguage, injectChapterMarkers,

    // ID generators
    chapterId, sceneId, unitId, generateBookId,

    // Draft (createDraftBook, loadDraftBook, updateBookState)
    createDraftBook: draftModule.createDraftBook,
    loadDraftBook: draftModule.loadDraftBook,
    updateBookState: draftModule.updateBookState,

    // Parse (lazyParseNextWindow, lazyParseChapter)
    lazyParseNextWindow: parseModule.lazyParseNextWindow,
    lazyParseChapter: parseModule.lazyParseChapter,

    // Status (getBookStatus, getChaptersSummary)
    getBookStatus: statusModule.getBookStatus,
    getChaptersSummary: statusModule.getChaptersSummary,

    // Create (createFromAnalysis, appendToBook, createOrAppendScenes)
    createFromAnalysis: createModule.createFromAnalysis,
    appendToBook: createModule.appendToBook,
    createOrAppendScenes: createModule.createOrAppendScenes,

    // Chapter utilities
    createChapterIntroScene: chapterUtilsModule.createChapterIntroScene,
    createCoverChapter: chapterUtilsModule.createCoverChapter,
    saveCoverChapter: chapterUtilsModule.saveCoverChapter,
    extractSceneTitle: chapterUtilsModule.extractSceneTitle,
    isGenericSceneTitle: chapterUtilsModule.isGenericSceneTitle,

    // Appearance
    fragmentAppearanceForVideo: appearanceModule.fragmentAppearanceForVideo,
    extractClothing: appearanceModule.extractClothing,

    // Metadata
    updateBookMetadata: metadataModule.updateBookMetadata,
};
