// ======================================================
// Agent Pipeline Runner
// ======================================================
// Orchestrates the full AI pipeline: window text extraction, scene splitting,
// character/location extraction, unit creation, and visual prompt generation.

const sourceCoverage = require('../source-coverage');
const lazyBook = require('../../book/lazy-book');
const config = require('../../config/runtime-config');
const { updateSession, createSession, isSessionCancelled, isBookCancelled } = require('../agent-session');
const { PROGRESS_STAGES, MAX_WINDOW_CHARS, MAX_SCENES_PER_CHUNK } = require('../agent-prompts');
const { mergeCharacterLists } = require('../../utils/character-identity');
const { estimateSpeechDurationSec } = require('../placeholder-audio');
const pipelineSteps = require('./pipeline-steps');
const textUtils = require('./text-utils');
const coreference = require('./coreference');
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
            // Если для window > 0 не передали startOffset — это баг в вызывающем коде.
            // Никогда не падаем в 0 (это приведёт к повторной обработке начала книги).
            // Вместо этого бросаем исключение.
            throw new Error(
                `getWindowText: startOffset is required for windowIndex=${windowIndex}. ` +
                `Passing undefined/null would default to 0 and re-process the beginning of the book.`
            );
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

    // Guard: для window > 0 проверяем, что startOffset не подозрительно мал
    if (windowIndex > 0 && startOffset < 100) {
        throw new Error(
            `getWindowText: windowIndex=${windowIndex} with startOffset=${startOffset} is suspiciously low. ` +
            `This would re-process the beginning of the book instead of continuing from offset=${startOffset}.`
        );
    }

    let endPos = Math.min(startOffset + MAX_WINDOW_CHARS, sourceText.length);
    let windowText = sourceText.substring(startOffset, endPos);

    const skipLen = sourceCoverage.findNarrativeStartOffset(windowText);

    const actualStart = startOffset + skipLen;
    if (skipLen > 0 && actualStart < endPos) {
        windowText = sourceText.substring(actualStart, endPos);
    }

    // Guard: actualStart должен быть рядом с startOffset (не больше чем на заголовок)
    if (windowIndex > 0 && actualStart < startOffset - 50) {
        throw new Error(
            `getWindowText: computed actualStart=${actualStart} << startOffset=${startOffset} ` +
            `for windowIndex=${windowIndex}. Pipeline would walk backwards.`
        );
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
    console.log(`[CANCEL-DEBUG] runPipeline START sessionId=${sessionId}, bookId=${options.bookId}, stepIndex=${stepIndex}, textLen=${text.length}, redis=${!!options.redis}`);
    const _progress = progress || (() => {});
    const { publishProgress, bookId, redis: redisClient } = options;
    const sceneOffset = baseSceneCount || 0;

    // ── Cancellation helper ──
    // Checks if the agent session has been marked as cancelled in the DB.
    // If so, throws an error to abort pipeline execution immediately.
    // Called between major pipeline steps; DB query overhead is negligible
    // because each AI step takes multiple seconds.
    //
    // Checks TWO conditions:
    //   1. Current session's status in DB (isSessionCancelled)
    //   2. Any cancelled session for this book (isBookCancelled) — covers case where
    //      cancel-worker cancelled old sessions and a new session was created afterwards
    //      (new session has status='running' but the book is cancelled).
    async function checkCancelled() {
        // LEVEL 1: session-level DB check
        const sessCancelled = await isSessionCancelled(sessionId);
        console.log(`[CANCEL-DEBUG] checkCancelled(sessionId=${sessionId}, bookId=${bookId}) level1(isSessionCancelled)=${sessCancelled}`);
        if (sessCancelled) {
            console.log(`[CANCEL-DEBUG] 🎯 LEVEL 1 TRIGGERED — session ${sessionId} status=cancelled`);
            const err = new Error('Agent session was cancelled by user');
            err.code = 'SESSION_CANCELLED';
            throw err;
        }

        // LEVEL 2: book-level DB check — any cancelled session for this book
        if (bookId) {
            const bookCancelled = await isBookCancelled(bookId);
            console.log(`[CANCEL-DEBUG] checkCancelled(sessionId=${sessionId}, bookId=${bookId}) level2(isBookCancelled)=${bookCancelled}`);
            if (bookCancelled) {
                console.log(`[CANCEL-DEBUG] 🎯 LEVEL 2 TRIGGERED — isBookCancelled(${bookId})=true, setting session ${sessionId} to cancelled`);
                try { await updateSession(sessionId, { status: 'cancelled' }); } catch (_) {}
                const err = new Error('Agent session was cancelled by user');
                err.code = 'SESSION_CANCELLED';
                throw err;
            }
        }

        // LEVEL 3: Redis cancelled-workers check — cancel-worker ALWAYS sets this Redis key
        // even if the DB UPDATE fails (e.g. no running/paused sessions found).
        // This is the most reliable cancellation signal.
        //
        // ВАЖНО: try/catch покрывает ТОЛЬКО redisClient.sismember (ошибка соединения),
        // НЕ throw SESSION_CANCELLED. Раньше throw был внутри try и catch (_) {} 
        // проглатывал SESSION_CANCELLED — агент продолжал работу после отмены.
        let cancelledByRedis = false;
        if (bookId && redisClient) {
            try {
                const redisCancelled = await redisClient.sismember(`animastor:cancelled-workers:${bookId}`, 'vbook');
                console.log(`[CANCEL-DEBUG] checkCancelled(sessionId=${sessionId}, bookId=${bookId}) level3(redis cancelled-workers)=${!!redisCancelled}`);
                cancelledByRedis = !!redisCancelled;
            } catch (_) { /* Redis check is best-effort */ }
        }
        if (cancelledByRedis) {
            console.log(`[CANCEL-DEBUG] 🎯 LEVEL 3 TRIGGERED — Redis cancelled-workers:${bookId} has vbook, setting session ${sessionId} to cancelled`);
            try { await updateSession(sessionId, { status: 'cancelled' }); } catch (_) {}
            const err = new Error('Agent session was cancelled by user');
            err.code = 'SESSION_CANCELLED';
            throw err;  // ← этот throw теперь НЕ может быть проглочен
        }

        console.log(`[CANCEL-DEBUG] checkCancelled(sessionId=${sessionId}, bookId=${bookId}) → NOT cancelled, continuing pipeline`);
    }
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
        // Persist current window_scene_index in Redis so the agent-status
        // endpoint can return it (instead of always returning null).
        // The frontend poller reads agent-status every 1.5s — this ensures
        // the scene counter advances even if SSE events are delayed/lost.
        if (event.window_scene_index != null && redisClient && bookId) {
            try {
                redisClient.set(
                    `animastor:vbook-scene-idx:${bookId}`,
                    String(event.window_scene_index),
                    'EX', 3600
                ).catch(() => {});
            } catch (_) {}
        }
    };

    publishVBook({ stage: 'extracting_chars', scene_index: 0, total_scenes: 0, window_size: MAX_SCENES_PER_CHUNK, message: PROGRESS_STAGES.extracting_chars });

    const sceneText = rawWindowText.trimEnd();

    publishVBook({ stage: 'analyzing', scene_index: 0, total_scenes: 0, window_size: MAX_SCENES_PER_CHUNK, message: PROGRESS_STAGES.analyzing_structure });

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

    await checkCancelled();

    // ── Dedicated voice generation step ──
    // Generate rich voice descriptions for characters using the current window text
    // for dialogue style analysis. Overrides weak/generic voices from character
    // extraction with focused, vivid voice descriptions.
    // In subsequent windows, skips characters that already have meaningful voices
    // and only generates for newly discovered characters.
    if (characters.length > 0) {
        const voiceResult = await pipelineSteps.stepGenerateVoices(sessionId, text, characters, stepIndex, _progress);
        if (voiceResult && voiceResult.voices) {
            const voiced = Object.keys(voiceResult.voices).length;
            console.log(`[AGENT] Voice generation: ${voiced} characters got voice descriptions`);
        }
    }

    await checkCancelled();

    publishVBook({ stage: 'extracting_chars', scene_index: 0, total_scenes: 0, window_size: MAX_SCENES_PER_CHUNK, message: PROGRESS_STAGES.extracting_chars });

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

    await checkCancelled();

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
    publishVBook({ stage: 'creating_scenes', scene_index: 0, total_scenes: totalScenesEstimate, window_size: MAX_SCENES_PER_CHUNK, message: PROGRESS_STAGES.creating_scenes });

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

    // ── Duration validation loop (targeted retries for oversized scenes) ──
    // After coverage is resolved, validate each scene's estimated duration.
    // If any scene exceeds SCENE_MAX_SEC (30s), retry the scene split with
    // specific feedback about which scene is too long and by how much.
    // The agent may either shorten the scene or split it into two+ scenes.
    const MAX_DURATION_RETRIES = 3;
    let durRetryCount = 0;

    while (oversized.length > 0 && durRetryCount < MAX_DURATION_RETRIES) {
        durRetryCount++;

        const preview = oversized
            .map(o => {
                const snippet = (windowScenes[o.i]?.text || '').slice(0, 80).replace(/\n/g, ' ');
                return `- scene ${o.i + 1}: ${o.dur.toFixed(1)}s (hard limit: ${SCENE_MAX_SEC}s) — "${snippet}..."`;
            })
            .join('\n');

        console.warn(`[AGENT] ${oversized.length} scene(s) exceed ${SCENE_MAX_SEC}s (duration retry ${durRetryCount}/${MAX_DURATION_RETRIES}); retrying scene split`);

        const repairHint = {
            reason: 'duration_exceeded',
            duration_preview: preview,
        };

        const retryScenes = capScenes(await pipelineSteps.stepCreateScenes(sessionId, sceneText, characters, locations, stepIndex, _progress, repairHint));
        const retryEval = evaluate(retryScenes);

        // If retry broke coverage, keep previous result and break — don't lose valid scenes
        if (!retryEval.cov.ok) {
            console.warn(`[AGENT] duration retry #${durRetryCount} broke source coverage — keeping previous scene split`);
            break;
        }

        windowScenes = retryScenes;
        ({ progressInfo, cov: coverage, oversized, undersized } = retryEval);
    }

    if (oversized.length > 0) {
        console.warn(JSON.stringify({
            event: 'scene_duration_over_max',
            step_index: stepIndex,
            max_sec: SCENE_MAX_SEC,
            target_sec: SCENE_TARGET_SEC,
            remaining_after_retries: durRetryCount,
            max_retries: MAX_DURATION_RETRIES,
            oversized: oversized.map(o => ({ scene_index: o.i, est_sec: o.dur })),
        }));
        if (durRetryCount >= MAX_DURATION_RETRIES) {
            console.error(`[AGENT] DURATION LIMIT EXCEEDED after ${MAX_DURATION_RETRIES} retries — scenes are longer than ${SCENE_MAX_SEC}s. Check agent output for ${bookId || sessionId}`);
        }
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
        duration_retry_count: durRetryCount,
    }));

    await checkCancelled();

    // ── Normalize characters_present → participants ──
    // The AI scene split returns characters_present, but downstream steps
    // (stepCreateVisuals, enrich, etc.) expect scene.participants.
    windowScenes = windowScenes.map(s => ({
        ...s,
        participants: s.participants || s.characters_present || [],
    }));

    // ── Scene enrichment ──
    windowScenes = await pipelineSteps.stepEnrichScenes(sessionId, windowScenes, characters, locations, stepIndex, _progress);

    const enrichedScenes = [];
    for (let si = 0; si < windowScenes.length; si++) {
        await checkCancelled();
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
            window_size: MAX_SCENES_PER_CHUNK,
            window_scene_index: windowSceneIndex,
            window_total_scenes: windowTotalScenes,
            window_start_scene: windowStartScene,
            message: unitMsg,
        });

        const units = await pipelineSteps.stepCreateUnits(sessionId, scene, globalSceneIndex, characters, stepIndex, _progress, mentions);

        // unit.participants removed — participants come from scene.participants
        // (authoritative source set during scene creation)

        const visualMsg = PROGRESS_STAGES.creating_visuals(globalSceneIndex);
        publishVBook({
            stage: 'creating_visuals',
            scene_index: globalSceneIndex + 1,
            total_scenes: sceneOffset + windowTotalScenes,
            window_size: MAX_SCENES_PER_CHUNK,
            window_scene_index: windowSceneIndex,
            window_total_scenes: windowTotalScenes,
            window_start_scene: windowStartScene,
            message: visualMsg,
        });

        const nextScene = windowScenes[si + 1] || null;
        const visualUnits = await pipelineSteps.stepCreateVisuals(sessionId, scene, units, globalSceneIndex, characters, locations, stepIndex, _progress, nextScene, mentions, options.promptProfiles);
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

    await checkCancelled();

    // ── Passport reconciliation pass ──
    // Before storyboard polish: remove semantically duplicate descriptions
    // that conflict with automatically-injected character passports.
    if (enrichedScenes.length > 0) {
        const allVisualUnits = enrichedScenes.flatMap((scene, si) =>
            (scene.units || []).map((unit, ui) => ({
                sceneIndex: si,
                unitIndex: ui,
                sceneTitle: scene.title || '',
                sceneText: scene.text || '',
                text: unit.text,
                type: unit.type,
                image: unit.image || {},
            }))
        );

        if (allVisualUnits.length >= 1) {
            const reconciled = await pipelineSteps.stepReconcilePassports(sessionId, allVisualUnits, characters, stepIndex, _progress);

            // Map results back into enrichedScenes
            for (const rec of reconciled) {
                const scene = enrichedScenes[rec.sceneIndex];
                if (scene && scene.units[rec.unitIndex]) {
                    const unit = scene.units[rec.unitIndex];
                    // Update image section from reconciliation result
                    if (rec.image?.prompt) {
                        unit.image = unit.image || {};
                        unit.image.prompt = rec.image.prompt;
                        if (rec.image?.shot) unit.image.shot = rec.image.shot;
                    }
                    // Update video section from reconciliation result
                    if (rec.video?.action) {
                        unit.video = unit.video || {};
                        unit.video.action = rec.video.action;
                    }
                }
            }
        }
    }

    await checkCancelled();

    // ── Video action reconciliation pass ──
    // After passport reconciliation, fix video.actions: remove static,
    // keep only temporal/dynamic descriptions.
    if (enrichedScenes.length > 0) {
        const allVisualUnits = enrichedScenes.flatMap((scene, si) =>
            (scene.units || []).map((unit, ui) => ({
                sceneIndex: si,
                unitIndex: ui,
                sceneTitle: scene.title || '',
                sceneText: scene.text || '',
                text: unit.text,
                type: unit.type,
                image: unit.image || {},
                video: unit.video || {},
            }))
        );

        if (allVisualUnits.length >= 1) {
            const reconciled = await pipelineSteps.stepReconcileVideoActions(sessionId, allVisualUnits, characters, stepIndex, _progress, options.promptProfiles);

            // Map results back into enrichedScenes
            for (const rec of reconciled) {
                const scene = enrichedScenes[rec.sceneIndex];
                if (scene && scene.units[rec.unitIndex]) {
                    const unit = scene.units[rec.unitIndex];
                    if (rec.video?.action) {
                        unit.video = unit.video || {};
                        unit.video.action = rec.video.action;
                    }
                }
            }
        }
    }

    await checkCancelled();

    // ── Storyboard polish pass ──
    // After passport reconciliation, do a cross-scene continuity correction.
    if (enrichedScenes.length > 0) {
        const allVisualUnits = enrichedScenes.flatMap((scene, si) =>
            (scene.units || []).map((unit, ui) => ({
                sceneIndex: si,
                unitIndex: ui,
                sceneTitle: scene.title || '',
                sceneText: scene.text || '',
                text: unit.text,
                type: unit.type,
                image: unit.image || {},
            }))
        );

        if (allVisualUnits.length >= 2) {
            const polished = await pipelineSteps.stepPolishStoryboard(sessionId, allVisualUnits, characters, locations, stepIndex, _progress, options.promptProfiles);

            // Map results back into enrichedScenes
            for (const pu of polished) {
                const scene = enrichedScenes[pu.sceneIndex];
                if (scene && scene.units[pu.unitIndex]) {
                    const unit = scene.units[pu.unitIndex];
                    // Update image section from polish result
                    if (pu.image?.prompt) {
                        unit.image = unit.image || {};
                        unit.image.prompt = pu.image.prompt;
                        if (pu.image?.shot) unit.image.shot = pu.image.shot;
                    }
                    // Update video section from polish result
                    if (pu.video?.action) {
                        unit.video = unit.video || {};
                        unit.video.action = pu.video.action;
                    }
                }
            }
        } else {
            console.log(`[AGENT] Storyboard polish skipped: ${allVisualUnits.length} unit(s) in window (need >= 2)`);
        }
    }

    await checkCancelled();

    // ── Video action polish pass ──
    // After storyboard polish, check video.actions for gesture continuity,
    // narrative consistency, and emotional progression across the sequence.
    if (enrichedScenes.length > 0) {
        const allVisualUnits = enrichedScenes.flatMap((scene, si) =>
            (scene.units || []).map((unit, ui) => ({
                sceneIndex: si,
                unitIndex: ui,
                sceneTitle: scene.title || '',
                sceneText: scene.text || '',
                text: unit.text,
                type: unit.type,
                image: unit.image || {},
                video: unit.video || {},
            }))
        );

        if (allVisualUnits.length >= 2) {
            const polished = await pipelineSteps.stepPolishVideoActions(sessionId, allVisualUnits, characters, locations, stepIndex, _progress, options.promptProfiles);

            // Map results back into enrichedScenes
            for (const pu of polished) {
                const scene = enrichedScenes[pu.sceneIndex];
                if (scene && scene.units[pu.unitIndex]) {
                    const unit = scene.units[pu.unitIndex];
                    if (pu.video?.action) {
                        unit.video = unit.video || {};
                        unit.video.action = pu.video.action;
                    }
                }
            }
        } else {
            console.log(`[AGENT] Video action polish skipped: ${allVisualUnits.length} unit(s) in window (need >= 2)`);
        }
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
