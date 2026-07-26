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
// | WAITING_CHUNKS → FAILED | failWaitingScene() (watchdog/recovery) | Застой чанков или сбой |
// | FAILED → WAITING_CHUNKS | completeChunk() (late chunk) | Когда все чанки пришли после FAILED |
// | FAILED → GENERATING | scheduler re-dispatch | На следующем scheduler tick |

const path = require('path');
const fs = require('fs');
const config = require('../config/runtime-config');

const logPrefix = '[AUDIO-ORCH]';
function log(msg) { console.log(`${logPrefix} ${msg}`); }
function warn(msg) { console.warn(`${logPrefix} ⚠️ ${msg}`); }

const PREFIX = 'animastor:audio-orch';
const MIN_CHUNK_BYTES = 100; // Chunks smaller than this are treated as empty (TTS failure)

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
    const { audio, orchestrator, getChunk, dispatchId } = deps;
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
    let expectedCount = parseInt(orchState.expected_count || '1', 10);
    const pad = (n) => String(n).padStart(4, '0');

    // 🔧 FIX: если expected_count = 0, но чанки на диске есть —
    // восстанавливаем реальное количество из файловой системы.
    // Это происходит после restart'а, когда stale recovery reset'нул
    // expected_count в 0 (buildSegments вернул 0), но GPU уже успел
    // сгенерировать чанки до restart'а.
    if (expectedCount === 0) {
        const chunks = require('../audio/chunks');
        const actualChunks = chunks.findExistingSceneChunks(bookId, chapterId, sceneId, buildId, null);
        if (actualChunks.length > 0) {
            expectedCount = actualChunks.length;
            orchState.expected_count = expectedCount;
            log(`🛠 completeChunk: expected=0, detected ${expectedCount} chunks on disk — recovering`);
            await setState(redis, bookId, chapterId, sceneId, orchState);
        } else {
            // Нет чанков и expected=0 — сцена реально пустая (0 сегментов)
            // Переходим DONE сразу, чтобы не циклиться
            log(`completeChunk ${bookId}/${chapterId}/${sceneId}: expected=0, no chunks on disk — setting DONE`);
            await setMerging(redis, bookId, chapterId, sceneId);
            await setDone(redis, bookId, chapterId, sceneId);
            if (orchestrator) {
                await orchestrator.completeStage(redis, bookId, chapterId, sceneId, 'audio', buildId, dispatchId);
            }
            return;
        }
    }

    if (orchState.phase === PHASES.GENERATING) {
        const transResult = await transitionState(redis, bookId, chapterId, sceneId, PHASES.WAITING_CHUNKS);
        if (!transResult.success) {
            warn(`GENERATING→WAITING_CHUNKS failed: ${transResult.reason}`);
            return;
        }
        // Sync local variable — transitionState обновила Redis, но orchState
        // всё ещё кешированная копия с phase=GENERATING.
        orchState.phase = PHASES.WAITING_CHUNKS;
    }

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

    // ── CHECK CHUNK COMPLETENESS (with file size validation) ──
    const chunkPaths = [];
    const presentIndices = [];
    const missingIndices = [];
    const emptyIndices = [];
    const chunkSizes = [];
    for (let i = 1; i <= expectedCount; i++) {
        const chunkPath = path.join(buildDir, `${bookId}_${chapterId}_${sceneId}_${pad(i)}.mp3`);
        chunkPaths.push(chunkPath);
        let size = 0;
        try {
            if (fs.existsSync(chunkPath)) {
                size = fs.statSync(chunkPath).size;
            }
        } catch (_) {}
        chunkSizes.push(size);
        if (size >= MIN_CHUNK_BYTES) {
            presentIndices.push(i);
        } else if (size > 0 && size < MIN_CHUNK_BYTES) {
            emptyIndices.push(i);
            warn(`[DEBUG] completeChunk: chunk ${pad(i)} exists but too small (${size} bytes) — deleting so re-dispatch can resend`);
            try { fs.unlinkSync(chunkPath); } catch (_) {}
            // Also clear Redis dedup keys so the re-sent job isn't rejected as duplicate
            const staleChunkId = `${bookId}_${chapterId}_${sceneId}_${pad(i)}`;
            await redis.del(`animastor:job:${staleChunkId}:audio`).catch(() => {});
            await redis.del(`animastor:result-processed:${staleChunkId}:audio`).catch(() => {});
        } else {
            missingIndices.push(i);
        }
    }

    log(`[DEBUG] completeChunk ${bookId}/${chapterId}/${sceneId}: expected=${expectedCount}, present=[${presentIndices.join(',')}], empty=[${emptyIndices.join(',')}], missing=[${missingIndices.join(',')}], sizes=[${chunkSizes.join(',')}] (${Date.now() - startTime}ms)`);

    if (missingIndices.length > 0 || emptyIndices.length > 0) {
        // Не все чанки на месте или есть пустые — фиксируем прогресс и выходим.
        // Пустые чанки будут перезапрошены при re-dispatch (failWaitingScene очистит dedup).
        await transitionState(redis, bookId, chapterId, sceneId, PHASES.WAITING_CHUNKS, {
            chunks_received: presentIndices.length,
            last_chunk_at: Date.now(),
        });
        log(`${bookId}/${chapterId}/${sceneId}: ${presentIndices.length}/${expectedCount} chunks valid, empty=[${emptyIndices.join(',')}], missing=[${missingIndices.join(',')}] (${Date.now() - startTime}ms)`);
        return;
    }

    // ══════════════════════════════════════════════════
    // ALL CHUNKS PRESENT → MERGE
    // ══════════════════════════════════════════════════
    await transitionState(redis, bookId, chapterId, sceneId, PHASES.MERGING, {
        chunks_received: expectedCount,
        last_chunk_at: Date.now(),
    });
    log(`${bookId}/${chapterId}/${sceneId} → MERGING (${expectedCount} chunks, ${Date.now() - startTime}ms since first check)`);

    try {
        // Trim padded chunks
        if (audio && typeof audio.trimPaddedSceneAudio === 'function') {
            for (let i = 0; i < chunkPaths.length; i++) {
                const currentChunkId = `${bookId}_${chapterId}_${sceneId}_${pad(i + 1)}`;
                try {
                    const currentMeta = getChunk ? await getChunk(currentChunkId) : null;
                    if (currentMeta && currentMeta.padded_text) {
                        log(`[DEBUG] TRIM: padded chunk ${i + 1}/${chunkPaths.length} (${currentChunkId}), original_text_length=${currentMeta.original_text_length}`);
                        await audio.trimPaddedSceneAudio(chunkPaths[i], currentMeta.original_text_length);
                    }
                } catch (trimErr) {
                    warn(`[DEBUG] TRIM failed for ${currentChunkId}: ${trimErr.message}`);
                }
            }
        }

        // Merge chunks
        let mergeSuccess = false;
        if (audio && typeof audio.mergeSceneAudioChunks === 'function') {
            log(`[DEBUG] MERGE: calling mergeSceneAudioChunks expected=${expectedCount}`);
            const mergeResult = await audio.mergeSceneAudioChunks(redis, bookId, chapterId, sceneId, buildId, expectedCount);
            log(`[DEBUG] MERGE: result=${mergeResult ? 'ok' : 'null'}`);
            if (mergeResult) {
                mergeSuccess = true;
            } else if (chunkPaths.length === 1 && fs.existsSync(chunkPaths[0])) {
                // Single chunk fallback
                const outputPath = path.join(buildDir, `${bookId}_${chapterId}_${sceneId}.mp3`);
                if (!fs.existsSync(outputPath)) {
                    fs.copyFileSync(chunkPaths[0], outputPath);
                    log(`[DEBUG] MERGE: single chunk fallback: ${outputPath}`);
                    mergeSuccess = true;
                }
            }
        }

        if (mergeSuccess) {
            await setDone(redis, bookId, chapterId, sceneId);
            // T7: Итог машины публикуется только через фасад
            if (orchestrator) {
                log(`[DEBUG] MERGE: calling completeStage for ${bookId}/${chapterId}/${sceneId}`);
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
            log(`[DEBUG] MERGE: Audio merge complete for ${bookId}/${chapterId}/${sceneId}`);
        } else {
            warn(`[DEBUG] MERGE: merge produced no output for ${bookId}/${chapterId}/${sceneId}`);
            await setFailed(redis, bookId, chapterId, sceneId, 'merge_failed_no_output');
        }
    } catch (err) {
        warn(`[DEBUG] MERGE: failed for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
        await setFailed(redis, bookId, chapterId, sceneId, `merge_error:${err.message}`);
    }
}

// ════════════════════════════════════════════════════════
// FAIL WAITING SCENE — единственный владелец WAITING_CHUNKS → FAILED.
// Вызывается watchdog'ом застоя (reconcileCycle.checkStalledAudioScenes)
// и recovery. Чистит hub-dedup недостающих чанков, сбрасывает их
// metadata в pending и публикует итог через orchestrator.failStage
// (FAILED → PENDING → scheduler передиспатчит).
// ════════════════════════════════════════════════════════

async function failWaitingScene(redis, bookId, chapterId, sceneId, buildId, reason, deps = {}) {
    const { orchestrator, dispatchId } = deps;
    const pad = (n) => String(n).padStart(4, '0');

    const orchState = await getState(redis, bookId, chapterId, sceneId);
    if (!orchState || orchState.phase !== PHASES.WAITING_CHUNKS) {
        return { failed: false, reason: 'not_waiting_chunks', phase: orchState ? orchState.phase : null };
    }

    const expectedCount = parseInt(orchState.expected_count || '1', 10);
    const buildDir = path.join(config.OUTPUT_DIR, buildId);
    const missingIndices = [];
    for (let i = 1; i <= expectedCount; i++) {
        const chunkPath = path.join(buildDir, `${bookId}_${chapterId}_${sceneId}_${pad(i)}.mp3`);
        let exists = false;
        try {
            if (fs.existsSync(chunkPath)) {
                const size = fs.statSync(chunkPath).size;
                if (size < MIN_CHUNK_BYTES) {
                    warn(`failWaitingScene: chunk ${pad(i)} is empty (${size} bytes) — treating as missing, deleting`);
                    try { fs.unlinkSync(chunkPath); } catch (_) {}
                } else {
                    exists = true;
                }
            }
        } catch (_) {}
        if (!exists) missingIndices.push(i);
    }

    warn(`failWaitingScene: ${bookId}/${chapterId}/${sceneId} — ${missingIndices.length}/${expectedCount} missing (${reason})`);
    await setFailed(redis, bookId, chapterId, sceneId, reason);

    // Освобождаем hub-dedup и chunk-metadata недостающих чанков, чтобы
    // передиспатч смог отправить их заново.
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

    // Итог машины публикуется только через фасад: FAILED → PENDING +
    // finalizeDispatch + событие AUDIO_FAILED в journal.
    if (orchestrator) {
        try {
            await orchestrator.failStage(redis, bookId, chapterId, sceneId, 'audio', buildId,
                reason, { dispatchId });
            log(`Audio FAILED→PENDING via failStage for ${bookId}/${chapterId}/${sceneId}`);
        } catch (fsErr) {
            warn(`failStage failed: ${fsErr.message}`);
        }
    }
    return { failed: true, missing: missingIndices };
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
    failWaitingScene,
    scanAllStates,
};
