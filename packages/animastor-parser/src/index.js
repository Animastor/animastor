// ======================================================
// @animastor/parser — public API
// ======================================================
// Deterministic text parser: chapter/segment detection, offsets,
// language detection, canonical ParserResult/ChapterMap DTO.
//
// Pure sync, no IO, no AI, no DB, no filesystem.
// The only external dependency is tinyld (language detection).
//
// The structureDetector port is the composition root seam:
// the host binds the real detector implementation at startup.
// ======================================================

const parser = require('./lazy-book/parser');
const contracts = require('./contracts/parser-contract');
const legacyProjection = require('./contracts/legacy-projection');
const languageDetector = require('./language-detector');

module.exports = {
    // ── Parser facade (deterministic, sync, no IO) ────────────────
    splitIntoChapters: parser.splitIntoChapters,
    splitIntoScenes: parser.splitIntoScenes,
    splitIntoUnits: parser.splitIntoUnits,
    firstMeaningfulChapter: parser.firstMeaningfulChapter,
    detectLanguage: parser.detectLanguage,
    injectChapterMarkers: parser.injectChapterMarkers,

    // ── Port binding (composition root seam) ──────────────────────
    setStructureDetector: parser.setStructureDetector,
    getStructureDetector: parser.getStructureDetector,

    // ── C13 Parser contract (canonical types + validation) ────────
    PARSER_CONTRACT_VERSION: contracts.PARSER_CONTRACT_VERSION,
    PARSER_SEGMENT_TYPES: contracts.PARSER_SEGMENT_TYPES,
    PARSER_SEGMENT_SOURCES: contracts.PARSER_SEGMENT_SOURCES,
    PARSER_MAP_SOURCES: contracts.PARSER_MAP_SOURCES,
    isValidStructureDetectorPort: contracts.isValidStructureDetectorPort,
    assertStructureDetectorPort: contracts.assertStructureDetectorPort,
    validateParserSegment: contracts.validateParserSegment,
    validateParserResult: contracts.validateParserResult,
    assertValidParserResult: contracts.assertValidParserResult,
    validateLanguageResult: contracts.validateLanguageResult,

    // ── Legacy projection (ParserResult → legacy chapter DTO) ─────
    offsetToLine: legacyProjection.offsetToLine,
    segmentToLegacyChapter: legacyProjection.segmentToLegacyChapter,
    mapToLegacyChapters: legacyProjection.mapToLegacyChapters,

    // ── Language detection (pure utility, tinyld-based) ───────────
    detectLanguageWithConfidence: languageDetector.detectLanguageWithConfidence,
};
