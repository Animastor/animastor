// ======================================================
// C13 Parser Contract — canonical ParserResult / ChapterMap DTO
// ======================================================
// Freezes the contract between the deterministic Parser Core and the rest
// of the system (docs/parser-contract-c13.md — derived from
// docs/parser-ai-importer-boundary-audit.md §11.1).
//
// Main contract:
//   Text (exact string instance, no trim/normalize/re-decode)
//     ↓ Parser (deterministic, sync, no fs/PG/Redis/AI)
//   ParserResult (≈ ChapterMap)
//
// This module is PURE (zero requires) and owns:
//   - the contract version constant;
//   - validation of ParserResult / ParserSegment / LanguageResult
//     (checks only — never mutates, never normalizes);
//   - the StructureDetectorPort shape check that backs the
//     setStructureDetector() binding in lazy-book/parser.js.
//
// The legacy chapter DTO projection lives in contracts/legacy-projection.js.
// ======================================================

/**
 * Contract version of the canonical ParserResult DTO.
 *
 * Versioning rule (additive-only): v1 producers (structure-detector
 * buildDeterministicMap / mergeAiDecisions) may omit the field — an absent
 * `contractVersion` is treated as 1. When the field IS present it must equal
 * 1; anything else is a contract violation. v2 will require the field
 * explicitly and bump the constant.
 */
const PARSER_CONTRACT_VERSION = 1;

/**
 * Canonical segment types (structure-detector TYPE_LABELS + body/poem).
 * @readonly
 */
const PARSER_SEGMENT_TYPES = Object.freeze([
    'chapter', 'prologue', 'epilogue', 'part',
    'introduction', 'afterword', 'appendix', 'body', 'poem',
]);

/**
 * Canonical segment sources. 'legacy' appears only in reverse projections
 * (legacy DTO → canonical), never in a live Parser output.
 * @readonly
 */
const PARSER_SEGMENT_SOURCES = Object.freeze(['detect', 'ai', 'legacy']);

/**
 * Chapter-map level sources (buildDeterministicMap → 'detect',
 * mergeAiDecisions → 'ai').
 * @readonly
 */
const PARSER_MAP_SOURCES = Object.freeze(['detect', 'ai']);

/**
 * @typedef {Object} TextMetaField
 * @property {string} text            Clean detected/merged text (may be the
 *                                    source line minus decorative punctuation).
 * @property {string} source          'detect' | 'ai'.
 * @property {string} [candidateId]   Candidate line the value is anchored to
 *                                    ('c<N>'); absent on unanchored merges.
 */

/**
 * @typedef {Object} ParserSegment
 * Canonical structure unit produced by the deterministic detector
 * (buildDeterministicMap) or the AI merge (mergeAiDecisions).
 * @property {string} type        One of PARSER_SEGMENT_TYPES.
 * @property {string|null} label  Verbatim structural keyword ("Глава",
 *                                "Пролог", ...) or null for plain segments.
 * @property {string|null} title  Clean segment title or null.
 * @property {number|null} number Chapter number (positive integer) or null.
 * @property {string|null} headerLine Verbatim header line text or null.
 * @property {number} startOffset Char offset INTO THE EXACT source Text
 *                                instance passed to the Parser. Invariant:
 *                                0 <= startOffset <= endOffset <= text.length.
 * @property {number} endOffset   Exclusive end char offset (same text).
 * @property {string} source      'detect' | 'ai'.
 */

/**
 * @typedef {Object} ParserChapter
 * LEGACY chapter DTO — the array contract preserved for host callers
 * (pipeline-runner, status-routes, txt-importer, source-coverage-audit).
 * Produced ONLY by projecting ParserSegments (see contracts/legacy-projection.js).
 * @property {string|null} title      Null for plain (body/poem→chapter) segments.
 * @property {string} type            'chapter' | 'prologue' | 'epilogue' | 'part'
 *                                    | 'introduction' | 'afterword' | 'appendix'
 *                                    (body/poem collapse into 'chapter').
 * @property {string|null} label      Null for plain segments.
 * @property {number|null} number
 * @property {number} startLine       0-based line derived from startOffset.
 * @property {number} endLine         0-based line derived from endOffset-1.
 * @property {number} startOffset
 * @property {number} endOffset
 * @property {number} length          endOffset - startOffset.
 */

/**
 * @typedef {string} ParserScene
 * Scene text produced by splitIntoScenes(chapterText): a trimmed,
 * non-empty string slice of the chapter text.
 */

/**
 * @typedef {Object} ParserUnit
 * Unit produced by splitIntoUnits(sceneText): today always one narration
 * unit covering the whole (trimmed) scene.
 * @property {string} type            Always 'narration'.
 * @property {string} text            Trimmed scene text ('' for empty input).
 * @property {string[]} participants  Always [] today.
 */

/**
 * @typedef {Object} ParserResult
 * Canonical Parser output (≈ ChapterMap). Deterministic producers emit
 * `source: 'detect'`; the AI merge emits `source: 'ai'`.
 * @property {number} [contractVersion]  1 when present; absence means 1.
 * @property {TextMetaField|null} title
 * @property {TextMetaField|null} author
 * @property {boolean} hasPrologue
 * @property {boolean} hasEpilogue
 * @property {{ name: string, order: number }[]} parts
 * @property {ParserSegment[]} segments   Offsets anchor the EXACT input Text.
 *                                        Typically ≥ 1 (body fallback);
 *                                        may legitimately be empty only when
 *                                        the source is empty or fully
 *                                        consumed by the head zone
 *                                        (documented discrepancy — see
 *                                        docs/parser-contract-c13.md §4).
 * @property {string} source              'detect' | 'ai'.
 */

/**
 * @typedef {{ code: string, confidence: number }|null} LanguageResult
 * Result of detectLanguageWithConfidence(): ISO 639-1 code + confidence in
 * [0,1], or null when the text is empty/undetectable/low-confidence.
 * detectLanguage() collapses this to a plain ISO 639-1 string ('en' fallback).
 */

/**
 * @typedef {Object} StructureDetectorPort
 * The port bound via setStructureDetector() (composition root: backend.cjs).
 * REQUIRED API — exactly one method:
 *   buildDeterministicMap(sourceText: string) → ParserResult
 * Acceptable alias: buildChapterMap (the audit's port-level name).
 * Everything else on structure-detector.js (extractCandidates,
 * analyzeStructure, mergeAiDecisions, sanitizeStructure) is the AI Analyzer
 * seam — host-side, NOT part of this port.
 */

/**
 * @typedef {Object} Parser
 * Deterministic parser facade (lazy-book/parser.js exports).
 * Sync, pure with respect to its inputs; no filesystem, no PG, no Redis,
 * no AI provider, no Book Writer.
 * @property {(text: string) => ParserChapter[]} splitIntoChapters
 * @property {(chapterText: string) => ParserScene[]} splitIntoScenes
 * @property {(sceneText: string) => ParserUnit[]} splitIntoUnits
 * @property {(chapters: ParserChapter[], sourceText: string) => ParserChapter|null} firstMeaningfulChapter
 * @property {(text: string) => string} detectLanguage
 * @property {(text: string) => string} injectChapterMarkers
 * @property {(detector: StructureDetectorPort) => void} setStructureDetector
 * @property {() => StructureDetectorPort} getStructureDetector
 */

// ── Port shape check ─────────────────────────────────────────────

/**
 * Structural check for the StructureDetectorPort. Mirrors the fail-closed
 * check inside setStructureDetector() (lazy-book/parser.js) so hosts can
 * validate a candidate implementation before binding.
 * @param {StructureDetectorPort|null|undefined} detector
 * @returns {boolean}
 */
function isValidStructureDetectorPort(detector) {
    return !!detector && (
        typeof detector.buildDeterministicMap === 'function' ||
        typeof detector.buildChapterMap === 'function'
    );
}

/**
 * Fail-closed port assertion. The error message stays byte-identical to the
 * one thrown by setStructureDetector() (tests pin it via /buildDeterministicMap/).
 * @param {StructureDetectorPort|null|undefined} detector
 * @throws {Error} when the detector does not expose the required API.
 */
function assertStructureDetectorPort(detector) {
    if (!isValidStructureDetectorPort(detector)) {
        throw new Error('vbook: structureDetector must expose buildDeterministicMap(sourceText)');
    }
}

// ── Validation helpers ───────────────────────────────────────────
// Validation NEVER mutates or normalizes data: valid → ok:true,
// invalid → ok:false with explicit error entries.

/**
 * Validate a single canonical segment.
 * @param {ParserSegment|null|undefined} seg
 * @returns {{ ok: boolean, errors: Array<{ code: string, message: string, path: string }> }}
 */
function validateParserSegment(seg) {
    const errors = [];
    const push = (code, message) => errors.push({ code, message, path: '' });

    if (!seg || typeof seg !== 'object' || Array.isArray(seg)) {
        push('SEGMENT_NOT_AN_OBJECT', 'segment must be an object');
        return { ok: false, errors };
    }

    if (!PARSER_SEGMENT_TYPES.includes(seg.type)) {
        push('INVALID_SEGMENT_TYPE', `type must be one of [${PARSER_SEGMENT_TYPES.join(', ')}], got ${JSON.stringify(seg.type)}`);
    }
    for (const field of ['label', 'title', 'headerLine']) {
        const v = seg[field];
        if (v !== null && v !== undefined && typeof v !== 'string') {
            push('INVALID_SEGMENT_FIELD', `${field} must be a string or null, got ${typeof v}`);
        }
    }
    if (seg.number !== null && seg.number !== undefined &&
        (typeof seg.number !== 'number' || !Number.isInteger(seg.number) || seg.number < 1)) {
        push('INVALID_SEGMENT_NUMBER', 'number must be a positive integer or null');
    }
    if (!PARSER_SEGMENT_SOURCES.includes(seg.source)) {
        push('INVALID_SEGMENT_SOURCE', `source must be one of [${PARSER_SEGMENT_SOURCES.join(', ')}], got ${JSON.stringify(seg.source)}`);
    }
    if (!Number.isInteger(seg.startOffset) || seg.startOffset < 0) {
        push('INVALID_OFFSET', `startOffset must be a non-negative integer, got ${JSON.stringify(seg.startOffset)}`);
    }
    if (!Number.isInteger(seg.endOffset) || seg.endOffset < 0) {
        push('INVALID_OFFSET', `endOffset must be a non-negative integer, got ${JSON.stringify(seg.endOffset)}`);
    }
    if (Number.isInteger(seg.startOffset) && Number.isInteger(seg.endOffset) &&
        seg.startOffset > seg.endOffset) {
        push('OFFSET_ORDER', 'startOffset must be <= endOffset');
    }
    return { ok: errors.length === 0, errors };
}

/**
 * Validate a canonical ParserResult / ChapterMap.
 *
 * @param {ParserResult|null|undefined} map
 * @param {Object} [opts]
 * @param {string} [opts.sourceText]  When provided, offsets are additionally
 *   checked against the exact source length (0 <= offset <= text.length) and
 *   the body-fallback rule applies: a NON-EMPTY source with zero segments is
 *   flagged (canonical maps always keep a body segment except for empty or
 *   all-head-zone sources — the documented discrepancy, see §4 of the doc).
 * @returns {{ ok: boolean, errors: Array<{ code: string, message: string, path: string }>,
 *            contractVersion: number }}
 */
function validateParserResult(map, opts = {}) {
    const errors = [];
    const push = (code, message, path) => errors.push({ code, message, path: path || '' });

    if (!map || typeof map !== 'object' || Array.isArray(map)) {
        return {
            ok: false,
            contractVersion: PARSER_CONTRACT_VERSION,
            errors: [{ code: 'MAP_NOT_AN_OBJECT', message: 'ParserResult must be an object', path: '' }],
        };
    }

    // contractVersion: absence means 1; presence must be exactly 1.
    if (map.contractVersion !== undefined && map.contractVersion !== PARSER_CONTRACT_VERSION) {
        push('INVALID_CONTRACT_VERSION',
            `contractVersion must be ${PARSER_CONTRACT_VERSION} (or omitted = ${PARSER_CONTRACT_VERSION}), got ${JSON.stringify(map.contractVersion)}`,
            'contractVersion');
    }

    // title / author
    for (const field of ['title', 'author']) {
        const v = map[field];
        if (v === null || v === undefined) continue;
        if (typeof v !== 'object' || typeof v.text !== 'string' || v.text.length === 0) {
            push('INVALID_META_FIELD', `${field} must be null or { text: string, source: 'detect'|'ai', candidateId? }`, field);
        }
    }

    if (typeof map.hasPrologue !== 'boolean') {
        push('INVALID_FIELD_TYPE', `hasPrologue must be boolean, got ${typeof map.hasPrologue}`, 'hasPrologue');
    }
    if (typeof map.hasEpilogue !== 'boolean') {
        push('INVALID_FIELD_TYPE', `hasEpilogue must be boolean, got ${typeof map.hasEpilogue}`, 'hasEpilogue');
    }

    if (!Array.isArray(map.parts)) {
        push('INVALID_FIELD_TYPE', 'parts must be an array', 'parts');
    } else {
        map.parts.forEach((p, i) => {
            if (!p || typeof p !== 'object' || typeof p.name !== 'string' || p.name.length === 0 ||
                typeof p.order !== 'number' || !Number.isInteger(p.order)) {
                push('INVALID_PART', 'part must be { name: string, order: integer }', `parts[${i}]`);
            }
        });
    }

    if (map.source !== 'detect' && map.source !== 'ai') {
        push('INVALID_MAP_SOURCE', `source must be 'detect' or 'ai', got ${JSON.stringify(map.source)}`, 'source');
    }

    const textLength = typeof opts.sourceText === 'string' ? opts.sourceText.length : null;

    if (!Array.isArray(map.segments)) {
        push('SEGMENTS_MISSING', 'segments must be an array', 'segments');
    } else {
        if (map.segments.length === 0 && textLength !== null && textLength > 0) {
            push('NO_BODY_FALLBACK',
                'non-empty source text must yield at least one segment (body fallback); zero segments is valid only for an empty source (see contract doc §4)',
                'segments');
        }
        let prevEndOffset = -1;
        map.segments.forEach((seg, i) => {
            const res = validateParserSegment(seg);
            for (const err of res.errors) {
                errors.push({ ...err, path: err.path ? `segments[${i}].${err.path}` : `segments[${i}]` });
            }
            if (seg && typeof seg === 'object' && Number.isInteger(seg.startOffset) && Number.isInteger(seg.endOffset)) {
                if (textLength !== null && (seg.startOffset > textLength || seg.endOffset > textLength)) {
                    push('OFFSET_OUT_OF_RANGE',
                        `offsets must be within [0, ${textLength}] of the exact source text`,
                        `segments[${i}]`);
                }
                if (prevEndOffset >= 0 && seg.startOffset < prevEndOffset) {
                    push('SEGMENT_OVERLAP',
                        `segments[${i}].startOffset (${seg.startOffset}) precedes the previous endOffset (${prevEndOffset}) — order/overlap violated`,
                        `segments[${i}]`);
                }
                prevEndOffset = Math.max(prevEndOffset, seg.endOffset);
            }
        });
    }

    return {
        ok: errors.length === 0,
        errors,
        contractVersion: map.contractVersion === undefined ? PARSER_CONTRACT_VERSION : map.contractVersion,
    };
}

/**
 * validateParserResult + explicit throw on violation. Never mutates data.
 * @param {ParserResult} map
 * @param {Object} [opts]  Same options as validateParserResult.
 * @returns {ParserResult} The SAME map instance (pass-through).
 * @throws {Error} when the map violates the contract.
 */
function assertValidParserResult(map, opts) {
    const res = validateParserResult(map, opts);
    if (!res.ok) {
        const detail = res.errors.map(e => `[${e.code}] ${e.path || ''}: ${e.message}`).join('; ');
        throw new Error(`vbook: ParserResult violates the C13 contract — ${detail}`);
    }
    return map;
}

/**
 * Validate a LanguageResult (detectLanguageWithConfidence output).
 * @param {LanguageResult} result
 * @returns {{ ok: boolean, errors: Array<{ code: string, message: string, path: string }> }}
 */
function validateLanguageResult(result) {
    if (result === null || result === undefined) return { ok: true, errors: [] };
    const errors = [];
    const push = (code, message) => errors.push({ code, message, path: '' });
    if (typeof result !== 'object' || Array.isArray(result)) {
        push('LANGUAGE_RESULT_NOT_AN_OBJECT', 'LanguageResult must be { code, confidence } or null');
        return { ok: false, errors };
    }
    if (typeof result.code !== 'string' || !/^[a-z]{2}$/.test(result.code)) {
        push('INVALID_LANGUAGE_CODE', 'code must be a lowercase ISO 639-1 string');
    }
    if (typeof result.confidence !== 'number' || result.confidence < 0 || result.confidence > 1) {
        push('INVALID_LANGUAGE_CONFIDENCE', 'confidence must be a number in [0, 1]');
    }
    return { ok: errors.length === 0, errors };
}

module.exports = {
    PARSER_CONTRACT_VERSION,
    PARSER_SEGMENT_TYPES,
    PARSER_SEGMENT_SOURCES,
    PARSER_MAP_SOURCES,
    isValidStructureDetectorPort,
    assertStructureDetectorPort,
    validateParserSegment,
    validateParserResult,
    assertValidParserResult,
    validateLanguageResult,
};
