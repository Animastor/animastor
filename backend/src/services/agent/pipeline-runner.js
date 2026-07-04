// ======================================================
// Agent Pipeline Runner
// ======================================================
// Orchestrates the full AI pipeline: window text extraction, scene splitting,
// character/location extraction, unit creation, and visual prompt generation.

const sourceCoverage = require('../source-coverage');
const lazyBook = require('../../book/lazy-book');
const config = require('../../config/runtime-config');
const { updateSession, createSession } = require('../agent-session');
const { PROGRESS_STAGES, WINDOW_SIZE, MAX_WINDOW_CHARS, MAX_SCENES_PER_CHUNK } = require('../agent-prompts');
const { mergeCharacterLists } = require('../../utils/character-identity');
const { estimateSpeechDurationSec } = require('../placeholder-audio');
const pipelineSteps = require('./pipeline-steps');
const textUtils = require('./text-utils');
const coreference = require('./coreference');
const visualUtils = require('./visual-utils');
const { SCENE_TARGET_SEC, SCENE_MAX_SEC, SCENE_MIN_SEC } = require('../agent-prompts');

function getWindowText(sourceText, existingChars, existingLocs, windowIndex, startOffset) {
    const chapters = lazyBook.splitIntoChapters(sourceText);

    if (startOffset === undefined || startOffset === null) {
        if (windowIndex === 0) {
            const firstChapter = lazyBook.firstMeaningfulChapter
                ? lazyBook.firstMeaningfulChapter(chapters, sourceText)
                : (chapters[0] || null);

            if (firstChapter) {
                const chStart = firstChapter.startOffset || 0;
                const chEnd = firstChapter.endOffset || sourceText.length;
                const chText = sourceText.substring(chStart, chEnd);
                const headerLen = sourceCoverage.findNarrativeStartOffset(chText);
                startOffset = Math.min(chStart + headerLen, sourceText.length);
            } else {
                startOffset = 0;
            }
        } else {
            startOffset = 0;
        }
    }

    if (startOffset >= sourceText.length) {
        const lastIdx = chapters.length > 0 ? chapters.length - 1 : 0;
        return {
            text: '',
            chapterIndex: lastIdx,
            remainingText: '',
            fullChapter: '',
            chapterTitle: chapters[lastIdx]?.title || null,
            currentOffset: startOffset,
            windowStartOffset: startOffset,
        };
    }

    let endPos = Math.min(startOffset + MAX_WINDOW_CHARS, sourceText.length);
    let windowText = sourceText.substring(startOffset, endPos);

    const skipLen = sourceCoverage.findNarrativeStartOffset(windowText);

    const actualStart = startOffset + skipLen;
    if (skipLen > 0 && actualStart < endPos) {
        windowText = sourceText.substring(actualStart, endPos);
    }

    if (endPos < sourceText.length && (endPos - actualStart) >= MAX_WINDOW_CHARS) {
        const lastPeriod = windowText.lastIndexOf('.');
        const lastNewline = windowText.lastIndexOf('\n\n');
        const breakAt = Math.max(lastPeriod, lastNewline);
        if (breakAt > MAX_WINDOW_CHARS / 2) {
            windowText = windowText.substring(0, breakAt + 1).trim();
            endPos = actualStart + breakAt + 1;
        }
    }

    const newOffset = endPos;
    const remaining = sourceText.substring(newOffset).trim();

    let chIdx = 0;
    for (let ci = 0; ci < chapters.length; ci++) {
        const chStart = chapters[ci].startOffset || 0;
        const chEnd = chapters[ci].endOffset || sourceText.length;
        if (actualStart >= chStart && actualStart < chEnd) {
            chIdx = ci;
            break;
        }
    }

    const chTitle = chapters[chIdx]?.title || null;

    const aiText = lazyBook.injectChapterMarkers(windowText.trim());

    console.log(`[WINDOW] getWindowText: startOffset=${startOffset}, skipLen=${skipLen}, actualStart=${actualStart}, endPos=${endPos}, newOffset=${newOffset}, chIdx=${chIdx}, chTitle="${chTitle}", textLen=${windowText.trim().length}, sourceLen=${sourceText.length}`);

    return {
        text: aiText,
        chapterIndex: chIdx,
        remainingText: remaining,
        fullChapter: windowText,
        chapterTitle: chTitle,
        currentOffset: newOffset,
        windowStartOffset: actualStart,
    };
}

function resolveSceneProgress(sceneText, scenes, sourceOffsetBase) {
    const sceneTexts = (scenes || []).map(s => s?.text || '');
    const coverage = sourceCoverage.computeSceneCoverage(sceneText, sceneTexts, { sourceOffsetBase });

    if (!coverage.ok) {
        return {
            coverage,
            nextOffset: null,
            progressMethod: 'coverage_failed',
        };
    }

    const lastSceneText = sceneTexts[sceneTexts.length - 1] || '';
    const tailProgress = sourceCoverage.findLastSceneEndOffset(sceneText, lastSceneText, { sourceOffsetBase });
    const tailMatchesCoverage = tailProgress.ok && tailProgress.source_end === coverage.covered_end_offset;
    if (tailProgress.ok && !tailMatchesCoverage) {
        console.warn(JSON.stringify({
            event: 'last_scene_tail_offset_mismatch',
            source_offset_base: sourceOffsetBase,
            coverage_end: coverage.covered_end_offset,
            tail_end: tailProgress.source_end,
            tail_method: tailProgress.method,
        }));
    }

    return {
        coverage: {
            ...coverage,
            progress_method: tailMatchesCoverage ? `coverage:${tailProgress.method}` : 'coverage',
            last_scene_end_offset: coverage.covered_end_offset,
        },
        nextOffset: coverage.next_offset,
        progressMethod: tailMatchesCoverage ? `coverage:${tailProgress.method}` : 'coverage',
    };
}

async function runPipeline(sessionId, text, existingChars, existingLocs, stepIndex, progress, baseSceneCount, options = {}) {
    const _progress = progress || (() => {});
    const { publishProgress, bookId } = options;
    const sceneOffset = baseSceneCount || 0;
    let characters = existingChars || [];
    let locations = existingLocs || [];
    const rawWindowText = options.rawWindowText || text;
    const sourceOffsetBase = options.sourceOffsetBase || 0;

    const publishVBook = (event) => {
        if (publishProgress && bookId) {
            try {
                publishProgress(bookId, { type: 'vbook', ...event });
            } catch (_) { /* best-effort */ }
        }
    };

    publishVBook({ stage: 'extracting_chars', scene_index: 0, total_scenes: 0, window_size: WINDOW_SIZE, message: PROGRESS_STAGES.extracting_chars });

    const sceneText = rawWindowText.trimEnd();

    publishVBook({ stage: 'analyzing', scene_index: 0, total_scenes: 0, window_size: WINDOW_SIZE, message: PROGRESS_STAGES.analyzing_structure });

    const charResult = await pipelineSteps.stepExtractCharacters(sessionId, text, stepIndex, _progress);
    let mentions = options.existingMentions || {};
    if (!charResult || !charResult.characters || charResult.characters.length === 0) {
        console.warn('[AGENT] No characters extracted from window, keeping existing set');
        characters = existingChars.length > 0
            ? existingChars
            : [{ id: 'unknown', name: 'Unknown', role: 'minor', description: 'Unidentified character' }];
    } else {
        const newCharacters = charResult.characters;
        const mergeResult = mergeCharacterLists(existingChars || [], newCharacters || [], { skipGeneric: true });
        characters = mergeResult.characters;
        if (charResult.mentions && typeof charResult.mentions === 'object') {
            for (const [alias, charId] of Object.entries(charResult.mentions)) {
                if (!mentions[alias]) mentions[alias] = charId;
            }
        }
        console.log(`[AGENT] Characters: ${existingChars.length} existing + ${mergeResult.added} new + ${mergeResult.enriched} enriched + ${mergeResult.skippedGeneric} generic skipped = ${characters.length} total, mentions: ${Object.keys(mentions).length}`);
    }

    publishVBook({ stage: 'extracting_chars', scene_index: 0, total_scenes: 0, window_size: WINDOW_SIZE, message: PROGRESS_STAGES.extracting_chars });

    const newLocations = await pipelineSteps.stepExtractLocations(sessionId, text, characters, stepIndex, _progress);
    if (!newLocations || newLocations.length === 0) {
        console.warn('[AGENT] No locations extracted from window, keeping existing set');
        locations = existingLocs.length > 0
            ? existingLocs
            : [{ id: 'unknown', name: 'Unknown', type: 'outdoor', description: 'Unspecified location' }];
    } else {
        const mergedMap = new Map((existingLocs || []).map(l => [l.id, l]));
        let enriched = 0;
        let added = 0;
        for (const loc of newLocations) {
            if (mergedMap.has(loc.id)) {
                const existing = mergedMap.get(loc.id);
                if (loc.description && loc.description.length > (existing.description || '').length) {
                    mergedMap.set(loc.id, {
                        ...existing,
                        description: existing.description
                            ? existing.description + ' ' + loc.description
                            : loc.description,
                    });
                    enriched++;
                }
            } else {
                mergedMap.set(loc.id, loc);
                added++;
            }
        }
        locations = Array.from(mergedMap.values());
        console.log(`[AGENT] Locations: ${existingLocs.length} existing + ${added} new + ${enriched} enriched = ${locations.length} total`);
    }

    // ── Scene split with unified validation ──
    const capScenes = (arr) => (arr || []).slice(0, MAX_SCENES_PER_CHUNK);

    const findOversized = (arr) => arr
        .map((s, i) => ({ i, dur: estimateSpeechDurationSec(s.text || '') }))
        .filter(o => o.dur > SCENE_MAX_SEC);

    const findUndersized = (arr) => arr
        .map((s, i) => ({ i, dur: estimateSpeechDurationSec(s.text || '') }))
        .filter(o => o.dur < SCENE_MIN_SEC);

    const evaluate = (arr) => {
        const progressInfo = resolveSceneProgress(sceneText, arr, sourceOffsetBase);
        const oversized = progressInfo.coverage.ok ? findOversized(arr) : [];
        const undersized = progressInfo.coverage.ok ? findUndersized(arr) : [];
        return { progressInfo, cov: progressInfo.coverage, oversized, undersized };
    };

    const totalScenesEstimate = Math.min(MAX_SCENES_PER_CHUNK, Math.ceil(sceneText.length / 200) || 1);
    publishVBook({ stage: 'creating_scenes', scene_index: 0, total_scenes: totalScenesEstimate, window_size: WINDOW_SIZE, message: PROGRESS_STAGES.creating_scenes });

    let scenes = capScenes(await pipelineSteps.stepCreateScenes(sessionId, sceneText, characters, locations, stepIndex, _progress));
    if (!scenes || scenes.length === 0) throw new Error('AI returned no scenes');

    let windowScenes = scenes;
    let { progressInfo, cov: coverage, oversized, undersized } = evaluate(windowScenes);
    let coverageRetryCount = 0;

    if (!coverage.ok || oversized.length > 0) {
        let repairHint;
        if (!coverage.ok) {
            console.warn(`[AGENT] scene coverage failed: ${coverage.reason} scene=${coverage.scene_index} gap=${coverage.gap_chars || 0}; retrying scene split`);
            repairHint = coverage;
        } else {
            const preview = oversized
                .map(o => `- scene ${o.i + 1}: ~${o.dur}s, "${(windowScenes[o.i].text || '').slice(0, 80).replace(/\n/g, ' ')}..."`)
                .join('\n');
            console.warn(`[AGENT] ${oversized.length} scene(s) exceed ${SCENE_MAX_SEC}s; retrying scene split for shorter scenes`);
            repairHint = { reason: 'duration_exceeded', duration_preview: preview };
        }
        coverageRetryCount += 1;
        windowScenes = capScenes(await pipelineSteps.stepCreateScenes(sessionId, sceneText, characters, locations, stepIndex, _progress, repairHint));
        ({ progressInfo, cov: coverage, oversized, undersized } = evaluate(windowScenes));
    }

    if (!coverage.ok) {
        console.warn(`[AGENT] scene coverage retry failed: ${coverage.reason}; using deterministic fallback`);
        coverageRetryCount += 1;
        windowScenes = capScenes(textUtils.buildFallbackScenes(sceneText));
        ({ progressInfo, cov: coverage, oversized, undersized } = evaluate(windowScenes));
        if (!coverage.ok) {
            throw new Error(`Scene coverage failed after fallback: ${coverage.reason}`);
        }
    }

    if (oversized.length > 0) {
        console.warn(JSON.stringify({
            event: 'scene_duration_over_max',
            step_index: stepIndex,
            max_sec: SCENE_MAX_SEC,
            oversized: oversized.map(o => ({ scene_index: o.i, est_sec: o.dur })),
        }));
    }

    if (undersized.length > 0) {
        console.warn(JSON.stringify({
            event: 'scene_duration_below_min',
            step_index: stepIndex,
            min_sec: SCENE_MIN_SEC,
            undersized: undersized.map(o => ({ scene_index: o.i, est_sec: o.dur })),
        }));
    }

    console.log(JSON.stringify({
        event: 'agent_window_coverage',
        step_index: stepIndex,
        planned_start: sourceOffsetBase,
        planned_end: sourceOffsetBase + sceneText.length,
        covered_start: coverage.covered_start_offset ?? null,
        covered_end: coverage.covered_end_offset ?? null,
        next_offset: progressInfo.nextOffset ?? null,
        progress_method: progressInfo.progressMethod,
        gap_chars: coverage.gap_chars || 0,
        retry_count: coverageRetryCount,
    }));

    // ── Scene enrichment ──
    windowScenes = await pipelineSteps.stepEnrichScenes(sessionId, windowScenes, characters, locations, stepIndex, _progress);

    const enrichedScenes = [];
    for (let si = 0; si < windowScenes.length; si++) {
        const scene = windowScenes[si];
        const globalSceneIndex = sceneOffset + si;

        const windowSceneIndex = si + 1;
        const windowTotalScenes = windowScenes.length;
        const windowStartScene = sceneOffset + 1;
        const unitMsg = PROGRESS_STAGES.creating_units(globalSceneIndex);
        publishVBook({
            stage: 'creating_units',
            scene_index: globalSceneIndex + 1,
            total_scenes: sceneOffset + windowTotalScenes,
            window_size: WINDOW_SIZE,
            window_scene_index: windowSceneIndex,
            window_total_scenes: windowTotalScenes,
            window_start_scene: windowStartScene,
            message: unitMsg,
        });

        const units = await pipelineSteps.stepCreateUnits(sessionId, scene, globalSceneIndex, characters, stepIndex, _progress, mentions);

        const unitParticipants = coreference.assignUnitParticipants(units, characters, mentions);
        const resolvedUnitParticipants = visualUtils.applyScenePairParticipantFallback(
            units,
            unitParticipants,
            scene.participants || []
        );
        const unitsWithParticipants = units.map((u, ui) => ({
            ...u,
            participants: resolvedUnitParticipants[ui] || u.participants || [],
        }));

        const visualMsg = PROGRESS_STAGES.creating_visuals(globalSceneIndex);
        publishVBook({
            stage: 'creating_visuals',
            scene_index: globalSceneIndex + 1,
            total_scenes: sceneOffset + windowTotalScenes,
            window_size: WINDOW_SIZE,
            window_scene_index: windowSceneIndex,
            window_total_scenes: windowTotalScenes,
            window_start_scene: windowStartScene,
            message: visualMsg,
        });

        const visualUnits = await pipelineSteps.stepCreateVisuals(sessionId, scene, unitsWithParticipants, globalSceneIndex, characters, locations, stepIndex, _progress);
        const sceneSpan = coverage.scene_spans[si] || null;
        let annotatedUnits = visualUnits;

        if (sceneSpan) {
            const unitCoverage = sourceCoverage.computeSceneCoverage(
                scene.text || '',
                visualUnits.map(u => u.text || ''),
                { sourceOffsetBase: sceneSpan.source_start }
            );
            if (unitCoverage.ok) {
                annotatedUnits = visualUnits.map((u, ui) => ({
                    ...u,
                    source_start: unitCoverage.scene_spans[ui]?.source_start ?? sceneSpan.source_start,
                    source_end: unitCoverage.scene_spans[ui]?.source_end ?? sceneSpan.source_end,
                }));
            } else {
                console.warn(`[AGENT] unit coverage failed scene ${globalSceneIndex}: ${unitCoverage.reason}`);
                annotatedUnits = visualUnits.map(u => ({
                    ...u,
                    source_start: sceneSpan.source_start,
                    source_end: sceneSpan.source_end,
                }));
            }
        }

        enrichedScenes.push({
            ...scene,
            source_start: sceneSpan?.source_start ?? null,
            source_end: sceneSpan?.source_end ?? null,
            units: annotatedUnits,
        });
    }

    return {
        characters,
        locations,
        mentions,
        scenes: enrichedScenes,
        allScenes: windowScenes,
        sceneConsumedLength: (progressInfo.nextOffset ?? coverage.next_offset) - sourceOffsetBase,
        nextOffset: progressInfo.nextOffset ?? coverage.next_offset,
        coverage,
    };
}

module.exports = {
    getWindowText,
    resolveSceneProgress,
    runPipeline,
};
