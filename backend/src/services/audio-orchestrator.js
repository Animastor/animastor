// ======================================================
// Audio Orchestrator — единая state machine для аудио-генерации сцены
// ======================================================
// T7: Единственный владелец merge-оркестрации. Все компоненты
// (startScene, executeAudioDispatch, completeChunk, completeMerge)
// читают phase из Redis-ключа `animastor:audio-orch:{bookId}:{chapterId}:{sceneId}`
// и принимают решения ТОЛЬКО на основе phase.
//
// Phase machine:
//
//   NEW ──→ PLACEHOLDER_READY ──→ GENERATING ──→ WAITING_CHUNKS ──→ MERGING ──→ DONE
//                                                                    ↘ FAILED ↗
//
// Инварианты (проверяются в reconcileCycle, T6):
//   phase=DONE     ⇔ asset.audio = READY
//   phase=FAILED   ⇒ asset.audio = FAILED
//   промежуточные  ⇒ asset.audio = GENERATING
//
// | Phase | Владелец перехода | Когда |
// |-------|-------------------|-------|
// | NEW → PLACEHOLDER_READY | startScene() | После создания placeholder + chunk metadata |
// | PLACEHOLDER_READY → GENERATING | executeAudioDispatch() | Перед отправкой TTS |
// | GENERATING → WAITING_CHUNKS | executeAudioDispatch() | После отправки TTS |
// | WAITING_CHUNKS → MERGING | completeChunk() | Когда все чанки на диске |
// | MERGING → DONE | completeChunk() → completeMerge() | После успешного merge |
// | WAITING_CHUNKS → FAILED | completeChunk() (retry exhausted) | После MAX_RETRIES |
// | FAILED → WAITING_CHUNKS | completeChunk() (late chunk) | Когда все чанки пришли после FAILED |
// | FAILED → GENERATING | scheduler re-dispatch | На следующем scheduler tick |

const path = require('path');
const fs = require('fs');
const config = require('../config/runtime-config');

const logPrefix = '[AUDIO-ORCH]';
function log(msg) { console.log(`${logPrefix} ${msg}`); }
function warn(msg) { console.warn(`${logPrefix} ⚠️ ${msg}`); }

const PREFIX = 'animastor:audio-orch';

const PHASES = {
    NEW: 'NEW',
    PLACEHOLDER_READY: 'PLACEHOLDER_READY',
    GENERATING: 'GENERATING',
    WAITING_CHUNKS: 'WAITING_CHUNKS',
    MERGING: 'MERGING',
    DONE: 'DONE',
    FAILED: 'FAILED',
};

// Valid transitions map
const VALID_TRANSITIONS = {
    [PHASES.NEW]: [PHASES.PLACEHOLDER_READY],
    [PHASES.PLACEHOLDER_READY]: [PHASES.GENERATING],
    [PHASES.GENERATING]: [PHASES.WAITING_CHUNKS],
    [PHASES.WAITING_CHUNKS]: [PHASES.MERGING, PHASES.FAILED],
    [PHASES.MERGING]: [PHASES.DONE],
    [PHASES.FAILED]: [PHASES.GENERATING, PHASES.WAITING_CHUNKS],
    [PHASES.DONE]: [], // terminal
};


/**
 * Build the Redis key for a scene's audio-orch state.
 */
function key(bookId, chapterId, sceneId) {
    return `${PREFIX}:${bookId}:${chapterId}:${sceneId}`;
}

/**
 * Create initial audio-orch state for a scene.
 */
function createState(buildId, expectedCount) {
    return {
        phase: PHASES.PLACEHOLDER_READY,
        expected_count: expectedCount,
        chunks_received: 0,
        started_at: Date.now(),
        build_id: buildId,
    };
}

/**
 * Read the current audio-orch state from Redis.
 * Returns null if no state exists (phase = NEW).
 */
async function getState(redis, bookId, chapterId, sceneId) {
    const raw = await redis.get(key(bookId, chapterId, sceneId));
    return raw ? JSON.parse(raw) : null;
}

/**
 * Set (overwrite) the audio-orch state in Redis.
 */
async function setState(redis, bookId, chapterId, sceneId, state) {
    await redis.set(key(bookId, chapterId, sceneId), JSON.stringify(state));
}

/**
 * Delete the audio-orch state from Redis.
 */
async function deleteState(redis, bookId, chapterId, sceneId) {
    await redis.del(key(bookId, chapterId, sceneId));
}

/**
 * Transition the audio-orch state to a new phase.
 * Validates that the transition is allowed.
 * Returns { success: true, state } or { success: false, reason }.
 */
async function transitionState(redis, bookId, chapterId, sceneId, newPhase, additionalFields = {}) {
    const current = await getState(redis, bookId, chapterId, sceneId);
    if (!current) {
        return { success: false, reason: 'no_state' };
    }

    const allowed = VALID_TRANSITIONS[current.phase] || [];
    if (current.phase !== newPhase && !allowed.includes(newPhase)) {
        warn(`Invalid transition: ${current.phase} → ${newPhase} for ${bookId}/${chapterId}/${sceneId}`);
        return { success: false, reason: 'invalid_transition', from: current.phase, to: newPhase };
    }

    current.phase = newPhase;
    Object.assign(current, additionalFields);
    await setState(redis, bookId, chapterId, sceneId, current);

    log(`${bookId}/${chapterId}/${sceneId}: ${current.phase}`);
    return { success: true, state: current };
}

// ── INIT ───────────────────────────────────────────────

async function initPlaceholderReady(redis, bookId, chapterId, sceneId, buildId, expectedCount) {
    const state = createState(buildId, expectedCount);
    await setState(redis, bookId, chapterId, sceneId, state);
    log(`${bookId}/${chapterId}/${sceneId}: ${PHASES.PLACEHOLDER_READY} (expected=${expectedCount}, build=${buildId})`);
    return state;
}

// ── PHASE TRANSITIONS (simple) ────────────────────────

async function setGenerating(redis, bookId, chapterId, sceneId) {
    return await transitionState(redis, bookId, chapterId, sceneId, PHASES.GENERATING);
}

async function setWaitingChunks(redis, bookId, chapterId, sceneId) {
    return await transitionState(redis, bookId, chapterId, sceneId, PHASES.WAITING_CHUNKS);
}

async function setMerging(redis, bookId, chapterId, sceneId) {
    return await transitionState(redis, bookId, chapterId, sceneId, PHASES.MERGING);
}

async function setDone(redis, bookId, chapterId, sceneId) {
    return await transitionState(redis, bookId, chapterId, sceneId, PHASES.DONE);
}

async function setFailed(redis, bookId, chapterId, sceneId, reason) {
    return await transitionState(redis, bookId, chapterId, sceneId, PHASES.FAILED, { fail_reason: reason, failed_at: Date.now() });
}

// ════════════════════════════════════════════════════════
// T7: COMPLETE CHUNK — приём чанка, проверка комплектности,
// retry-логика, решение о мерже. Перенесено из task-handler.cjs.
// ════════════════════════════════════════════════════════

async function completeChunk(redis, bookId, chapterId, sceneId, chunkIndex, buildId, deps = {}) {
    const startTime = Date.now();
    const { audio, orchestrator, getChunk, saveChunk, dispatchId } = deps;
    const OUTPUT_DIR = config.OUTPUT_DIR;
    const buildDir = path.join(OUTPUT_DIR, buildId);
    if (!fs.existsSync(buildDir)) {
        warn(`completeChunk: build dir not found: ${buildDir}`);
        return;
    }

    const orchState = await getState(redis, bookId, chapterId, sceneId);
    if (!orchState || orchState.phase === PHASES.DONE) {
        log(`Audio already done for ${bookId}/${chapterId}/${sceneId} — skipping`);
        return;
    }
    if (orchState.phase === PHASES.MERGING) {
        log(`Merge in progress for ${bookId}/${chapterId}/${sceneId} — waiting`);
        return;
    }

    // ── SAFETY NET: GENERATING → WAITING_CHUNKS ──
    // Если чанк пришёл до того, как executeAudioDispatch успел вызвать
    // setWaitingChunks (race condition при быстрых TTS), переходим в
    // WAITING_CHUNKS самостоятельно и продолжаем проверку комплектности.
    if (orchState.phase === PHASES.GENERATING) {
        log(`GENERATING→WAITING_CHUNKS: chunk ${chunkIndex} arrived early for ${bookId}/${chapterId}/${sceneId}`);
        const transResult = await transitionState(redis, bookId, chapterId, sceneId, PHASES.WAITING_CHUNKS);
        if (!transResult.success) {
            warn(`GENERATING→WAITING_CHUNKS failed: ${transResult.reason}`);
            return;
        }
        // Sync local variable — transitionState обновила Redis, но orchState
        // всё ещё кешированная копия с phase=GENERATING.
        orchState.phase = PHASES.WAITING_CHUNKS;
    }

    const expectedCount = parseInt(orchState.expected_count || '1', 10);
    const pad = (n) => String(n).padStart(4, '0');

    // ── LATE CHUNK RECOVERY: FAILED → WAITING_CHUNKS ──
    if (orchState.phase === PHASES.FAILED) {
        let allPresent = true;
        for (let i = 1; i <= expectedCount; i++) {
            if (!fs.existsSync(path.join(buildDir, `${bookId}_${chapterId}_${sceneId}_${pad(i)}.mp3`))) {
                allPresent = false;
                break;
            }
        }
        if (allPresent) {
            log(`RECOVERY: All ${expectedCount} chunks present despite FAILED — resuming merge`);
            const transResult = await transitionState(redis, bookId, chapterId, sceneId, PHASES.WAITING_CHUNKS);
            if (!transResult.success) {
                warn(`RECOVERY: transition FAILED→WAITING_CHUNKS failed: ${transResult.reason}`);
                return;
            }
        } else {
            log(`Phase is FAILED but not all chunks present yet — waiting for re-dispatch (${Date.now() - startTime}ms)`);
            return;
        }
    } else if (orchState.phase !== PHASES.WAITING_CHUNKS) {
        log(`Phase is ${orchState.phase} — not ready for merge, skipping (${Date.now() - startTime}ms)`);
        return;
    }

    // ── CHECK CHUNK COMPLETENESS ──
    const chunkPaths = [];
    let allChunksExist = true;
    let missingChunks = 0;
    for (let i = 1; i <= expectedCount; i++) {
        const chunkPath = path.join(buildDir, `${bookId}_${chapterId}_${sceneId}_${pad(i)}.mp3`);
        chunkPaths.push(chunkPath);
        if (!fs.existsSync(chunkPath)) {
            allChunksExist = false;
            missingChunks++;
        }
    }

    if (!allChunksExist) {
        // ── RETRY LOGIC ──
        const { AUDIO_MERGE_RETRY_MAX, AUDIO_MERGE_RETRY_DEDUP_TTL_S, AUDIO_MERGE_RETRY_COUNTER_TTL_S, AUDIO_MERGE_RETRY_DELAY_MS } = config.TIMEOUTS;
        const retryKey = `animastor:audio-merge-retry:${bookId}:${chapterId}:${sceneId}`;
        const retryCountKey = `${retryKey}:count`;
        const attempt = parseInt(await redis.get(retryCountKey) || '0', 10);

        if (attempt >= AUDIO_MERGE_RETRY_MAX) {
            // RETRY EXHAUSTED → failStage
            const missingIndices = [];
            for (let i = 1; i <= expectedCount; i++) {
                if (!fs.existsSync(path.join(buildDir, `${bookId}_${chapterId}_${sceneId}_${pad(i)}.mp3`))) {
                    missingIndices.push(i);
                }
            }
            warn(`Max retries (${AUDIO_MERGE_RETRY_MAX}) reached for ${bookId}/${chapterId}/${sceneId} — ${missingIndices.length} missing`);

            await setFailed(redis, bookId, chapterId, sceneId,
                `max_retries_exceeded:${missingIndices.length}_missing`);

            // Clear GPU hub dedup for missing chunks
            for (const idx of missingIndices) {
                const chunkId = `${bookId}_${chapterId}_${sceneId}_${pad(idx)}`;
                await redis.del(`animastor:job:${chunkId}:audio`).catch(() => {});
                await redis.del(`animastor:result-processed:${chunkId}:audio`).catch(() => {});
                const raw = await redis.get(`animastor:chunk:${chunkId}`);
                if (raw) {
                    try {
                        const ch = JSON.parse(raw);
                        ch.audio = false;
                        ch.audio_status = 'pending';
                        await redis.set(`animastor:chunk:${chunkId}`, JSON.stringify(ch));
                    } catch (e) {}
                }
            }
            await redis.del(retryKey).catch(() => {});
            await redis.del(retryCountKey).catch(() => {});

            // T5: orchestrator.failStage делает FAILED→PENDING + markDispatchCompleted + journal
            if (orchestrator) {
                try {
                    await orchestrator.failStage(redis, bookId, chapterId, sceneId, 'audio', buildId,
                        `max_retries_exceeded:${missingIndices.length}_missing`,
                        { dispatchId });
                    log(`Audio FAILED→PENDING via failStage for ${bookId}/${chapterId}/${sceneId}`);
                } catch (fsErr) {
                    warn(`failStage failed: ${fsErr.message}`);
                }
            }
            return;
        }

        // Schedule retry
        const scheduled = await redis.set(retryKey, '1', 'NX', 'EX', AUDIO_MERGE_RETRY_DEDUP_TTL_S);
        if (scheduled) {
            await redis.set(retryCountKey, String(attempt + 1), 'EX', AUDIO_MERGE_RETRY_COUNTER_TTL_S);
            setTimeout(async () => {
                try {
                    await redis.del(retryKey).catch(() => {});
                    const currentChunkId = `${bookId}_${chapterId}_${sceneId}_${pad(chunkIndex)}`;
                    const refreshed = getChunk ? await getChunk(currentChunkId) : null;
                    if (refreshed) {
                        log(`Merge retry (${attempt + 1}/${AUDIO_MERGE_RETRY_MAX}): ${bookId}/${chapterId}/${sceneId}`);
                        await completeChunk(redis, bookId, chapterId, sceneId, chunkIndex, buildId, deps);
                    }
                } catch (e) {
                    warn(`Merge retry failed: ${e.message}`);
                }
            }, AUDIO_MERGE_RETRY_DELAY_MS);
        }
        return;
    }

    // ══════════════════════════════════════════════════
    // ALL CHUNKS PRESENT → MERGE
    // ══════════════════════════════════════════════════
    await setMerging(redis, bookId, chapterId, sceneId);
    log(`${bookId}/${chapterId}/${sceneId} → MERGING`);

    try {
        // Trim padded chunks
        if (audio && typeof audio.trimPaddedSceneAudio === 'function') {
            for (let i = 0; i < chunkPaths.length; i++) {
                const currentChunkId = `${bookId}_${chapterId}_${sceneId}_${pad(i + 1)}`;
                try {
                    const currentMeta = getChunk ? await getChunk(currentChunkId) : null;
                    if (currentMeta && currentMeta.padded_text) {
                        log(`Padded chunk ${i + 1}/${chunkPaths.length}: trimming`);
                        await audio.trimPaddedSceneAudio(chunkPaths[i]);
                    }
                } catch (_) {}
            }
        }

        // Merge chunks
        let mergeSuccess = false;
        if (audio && typeof audio.mergeSceneAudioChunks === 'function') {
            const mergeResult = await audio.mergeSceneAudioChunks(redis, bookId, chapterId, sceneId, buildId, expectedCount);
            if (mergeResult) {
                mergeSuccess = true;
            } else if (chunkPaths.length === 1 && fs.existsSync(chunkPaths[0])) {
                // Single chunk fallback
                const outputPath = path.join(buildDir, `${bookId}_${chapterId}_${sceneId}.mp3`);
                if (!fs.existsSync(outputPath)) {
                    fs.copyFileSync(chunkPaths[0], outputPath);
                    log(`Single chunk fallback: ${outputPath}`);
                    mergeSuccess = true;
                }
            }
        }

        if (mergeSuccess) {
            await setDone(redis, bookId, chapterId, sceneId);
            // T7: Итог машины публикуется только через фасад
            if (orchestrator) {
                await orchestrator.completeStage(
                    redis,
                    bookId,
                    chapterId,
                    sceneId,
                    'audio',
                    buildId,
                    dispatchId
                );
            }
            log(`Audio merge complete for ${bookId}/${chapterId}/${sceneId}`);
        } else {
            await setFailed(redis, bookId, chapterId, sceneId, 'merge_failed_no_output');
        }
    } catch (err) {
        warn(`Merge failed for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
        await setFailed(redis, bookId, chapterId, sceneId, `merge_error:${err.message}`);
    }
}

// ════════════════════════════════════════════════════════
// SCAN ALL STATES (для startup recovery)
// ════════════════════════════════════════════════════════

async function scanAllStates(redis) {
    const keys = [];
    let cursor = '0';
    do {
        const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', `${PREFIX}:*`, 'COUNT', 200);
        cursor = nextCursor;
        keys.push(...batch);
    } while (cursor !== '0');

    const results = [];
    for (const k of keys) {
        const raw = await redis.get(k);
        if (raw) {
            const parts = k.split(':');
            if (parts.length >= 5) {
                const sceneParts = parts.slice(2);
                if (sceneParts.length >= 3) {
                    const sceneId = sceneParts.pop();
                    const chapterId = sceneParts.pop();
                    const bookId = sceneParts.join(':');
                    results.push({
                        key: k,
                        bookId,
                        chapterId,
                        sceneId,
                        state: JSON.parse(raw),
                    });
                }
            }
        }
    }
    return results;
}

module.exports = {
    PREFIX,
    PHASES,
    key,
    createState,
    getState,
    setState,
    deleteState,
    transitionState,
    initPlaceholderReady,
    setGenerating,
    setWaitingChunks,
    setMerging,
    setDone,
    setFailed,
    completeChunk,
    scanAllStates,
};
