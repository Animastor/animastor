// ======================================================
// Book Structure Detector — COMPATIBILITY BARREL (C19)
// ======================================================
// C19 physical extraction (docs/architecture/structure-analyzer-extraction-c19.md)
// split the former dual-role structure-detector.js (C18 H7) into:
//
//   1. DETERMINISTIC HALF (Parser-side, host-injected into @animastor/parser
//      via setStructureDetector): ./structure-detector-deterministic.js
//      — extractCandidates / buildDeterministicMap / mapToStructureChapters.
//
//   2. AI HALF (the Structure Analyzer functional module):
//      ./structure-analyzer/ — sanitizeStructure / mergeAiDecisions /
//      analyzeStructure + the port-based entry point
//      analyzeBookStructure(input, ports).
//
// This barrel preserves the historical `services/structure-detector` import
// path and the frozen C17 seam surface so the composition root binding
// (backend.cjs → setStructureDetector) and existing consumers keep working
// unchanged. It does NOT hold its own implementation — there is no hidden
// duplicate of either half (C19 guard 8).
// ======================================================

const deterministic = require('@animastor/ai-analysis/tasks/structure-detector-deterministic');
const { analyzeStructure, mergeAiDecisions, sanitizeStructure } = require('@animastor/ai-analysis/tasks/structure-analyzer');

module.exports = {
    // ── Deterministic half (Parser adapter, injected into @animastor/parser) ──
    STRUCTURE_KEYWORDS: deterministic.STRUCTURE_KEYWORDS,
    extractCandidates: deterministic.extractCandidates,
    matchKeyword: deterministic.matchKeyword,
    buildDeterministicMap: deterministic.buildDeterministicMap,
    mapToStructureChapters: deterministic.mapToStructureChapters,
    isAuthorSurnameACharacter: deterministic.isAuthorSurnameACharacter,
    looksLikeAuthorName: deterministic.looksLikeAuthorName,
    TYPE_LABELS: deterministic.TYPE_LABELS,
    // internals exposed for tests
    _extractNumber: deterministic._extractNumber,
    _romanToInt: deterministic._romanToInt,
    _extractSurname: deterministic._extractSurname,
    _countSurnameInText: deterministic._countSurnameInText,

    // ── AI half (Structure Analyzer merge seam, frozen C17 surface) ──
    analyzeStructure,
    mergeAiDecisions,
    sanitizeStructure,
};
