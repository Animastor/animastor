// ======================================================
// Parser Core — extraction boundary for @animastor/parser
// ======================================================
// This barrel groups the Parser Core surface: deterministic text parsing,
// chapter/segment detection, offsets, language detection, and canonical
// ParserResult. It has ZERO dependencies on VBook persistence, Redis,
// PostgreSQL, AI pipeline, Book Writer, or Importer.
//
// When @animastor/parser is physically extracted, this barrel becomes
// its public API surface.
//
// Dependencies:
//   - contracts/parser-contract.js  (pure, zero requires)
//   - contracts/legacy-projection.js (pure, zero requires)
//   - lazy-book/parser.js           (Parser facade, depends only on contracts)
//   - language-detector.js          (pure utility, depends only on tinyld)
//
// NOT included (host-side):
//   - lazy-book/parse.js            (Book Writer — fs, draft, paths)
//   - services/structure-detector.js (AI + Deterministic combined)
//   - services/txt-importer.js       (Importer)
//   - services/agent/*               (AI pipeline)
//   - Redis, PostgreSQL, Book Writer
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
