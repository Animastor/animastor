const lazyBook = require('../book/lazy-book');
const sourceCoverage = require('./source-coverage');

function sceneText(scene) {
    return scene?.audio?.full_text || scene?.text || '';
}

function collectNarrativeScenes(draft) {
    const out = [];
    for (const chapter of draft?.chapters || []) {
        for (const scene of chapter.scenes || []) {
            if (scene.type === 'cover' || scene.type === 'chapter_intro') continue;
            const text = sceneText(scene);
            if (!text.trim()) continue;
            out.push({
                chapter_id: chapter.chapter,
                scene_id: scene.scene_id,
                title: scene.scene_title || scene.title || null,
                source_start: scene.source_start,
                source_end: scene.source_end,
                text,
            });
        }
    }
    return out;
}

function findSceneSpan(sourceIndex, scene, cursorNorm) {
    if (Number.isInteger(scene.source_start) && Number.isInteger(scene.source_end)) {
        return {
            source_start: scene.source_start,
            source_end: scene.source_end,
            normalized_start: sourceCoverage.rawOffsetToNormalizedIndex(sourceIndex, scene.source_start),
            normalized_end: sourceCoverage.rawOffsetToNormalizedIndex(sourceIndex, Math.max(scene.source_end - 1, scene.source_start)) + 1,
            found_by: 'stored_span',
        };
    }

    const needle = sourceCoverage.normalizeTextForCoverage(scene.text).trim();
    const pos = sourceIndex.normalized.indexOf(needle, cursorNorm);
    if (pos < 0) return null;
    return {
        source_start: sourceIndex.rawStarts[pos],
        source_end: sourceIndex.rawEnds[pos + needle.length - 1],
        normalized_start: pos,
        normalized_end: pos + needle.length,
        found_by: 'text_match',
    };
}

function findAuditStartOffset(sourceText) {
    const chapters = lazyBook.splitIntoChapters(sourceText);
    const firstChapter = lazyBook.firstMeaningfulChapter
        ? lazyBook.firstMeaningfulChapter(chapters, sourceText)
        : (chapters[0] || null);
    if (!firstChapter) return sourceCoverage.findNarrativeStartOffset(sourceText);

    const chapterStart = firstChapter.startOffset || 0;
    const chapterEnd = firstChapter.endOffset || sourceText.length;
    const chapterText = sourceText.substring(chapterStart, chapterEnd);
    return Math.min(
        chapterStart + sourceCoverage.findNarrativeStartOffset(chapterText),
        sourceText.length
    );
}

function auditBookCoverage(bookId) {
    const draft = lazyBook.loadDraftBook(bookId);
    if (!draft || !draft.sourceText) {
        throw new Error(`Book ${bookId} not found or has no source text`);
    }

    const sourceIndex = sourceCoverage.buildCoverageIndex(draft.sourceText);
    const auditStartOffset = findAuditStartOffset(draft.sourceText);
    const auditStartNorm = sourceCoverage.rawOffsetToNormalizedIndex(sourceIndex, auditStartOffset);
    const scenes = collectNarrativeScenes(draft);
    const sceneReports = [];
    const gaps = [];
    const overlaps = [];
    let cursorNorm = auditStartNorm;
    let coveredChars = 0;

    for (const scene of scenes) {
        const span = findSceneSpan(sourceIndex, scene, cursorNorm);
        if (!span) {
            sceneReports.push({
                ...scene,
                ok: false,
                reason: 'scene_text_not_found',
            });
            continue;
        }

        if (span.normalized_start > cursorNorm) {
            const gapText = sourceIndex.normalized.slice(cursorNorm, span.normalized_start);
            if (gapText.trim()) {
                gaps.push({
                    from: sourceIndex.rawStarts[cursorNorm] ?? null,
                    to: sourceIndex.rawStarts[span.normalized_start] ?? null,
                    chars: gapText.length,
                    preview: gapText.trim().slice(0, 200),
                    before_scene: scene.scene_id,
                });
            }
        } else if (span.normalized_start < cursorNorm) {
            overlaps.push({
                scene_id: scene.scene_id,
                chars: cursorNorm - span.normalized_start,
            });
        }

        const spanChars = Math.max(0, span.source_end - span.source_start);
        coveredChars += spanChars;
        cursorNorm = Math.max(cursorNorm, span.normalized_end);
        sceneReports.push({
            chapter_id: scene.chapter_id,
            scene_id: scene.scene_id,
            title: scene.title,
            ok: true,
            source_start: span.source_start,
            source_end: span.source_end,
            chars: spanChars,
            found_by: span.found_by,
        });
    }

    return {
        book_id: bookId,
        source_chars: draft.sourceText.length,
        audit_start_offset: auditStartOffset,
        scene_count: scenes.length,
        covered_chars: coveredChars,
        gap_count: gaps.length,
        overlap_count: overlaps.length,
        first_gap: gaps[0] || null,
        gaps,
        overlaps,
        scenes: sceneReports,
    };
}

module.exports = {
    auditBookCoverage,
    collectNarrativeScenes,
    findAuditStartOffset,
};
