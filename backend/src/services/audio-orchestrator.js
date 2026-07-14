// ======================================================
// Audio Orchestrator — единая state machine для аудио-генерации сцены
// ======================================================
// Единственный арбитр состояния аудио-генерации. Все компоненты
// (startScene, executeAudioDispatch, triggerAudioMerge, completeStage)
// читают phase из Redis-ключа `animastor:audio-orch:{bookId}:{chapterId}:{sceneId}`
// и принимают решения ТОЛЬКО на основе phase.
//
// Phase machine:
//
//   NEW ──→ PLACEHOLDER_READY ──→ GENERATING ──→ WAITING_CHUNKS ──→ MERGING ──→ DONE
//                                                                    ↘ FAILED ↗
//
// | Phase | Владелец перехода | Когда |
// |-------|-------------------|-------|
// | NEW → PLACEHOLDER_READY | startScene() | После создания placeholder + chunk metadata |
// | PLACEHOLDER_READY → GENERATING | executeAudioDispatch() | Перед отправкой TTS |
// | GENERATING → WAITING_CHUNKS | executeAudioDispatch() | После отправки TTS |
// | WAITING_CHUNKS → MERGING | triggerAudioMerge() | Когда все чанки на диске |
// | MERGING → DONE | triggerAudioMerge() | После успешного merge |
// | WAITING_CHUNKS → FAILED | triggerAudioMerge() | После MAX_RETRIES |
// | FAILED → GENERATING | scheduler re-dispatch | На следующем scheduler tick |

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
    [PHASES.FAILED]: [PHASES.GENERATING],
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
        const logPrefix = '[AUDIO-ORCH]';
        console.warn(`${logPrefix} ⚠️ Invalid transition: ${current.phase} → ${newPhase} for ${bookId}/${chapterId}/${sceneId}`);
        return { success: false, reason: 'invalid_transition', from: current.phase, to: newPhase };
    }

    current.phase = newPhase;
    Object.assign(current, additionalFields);
    await setState(redis, bookId, chapterId, sceneId, current);

    const logPrefix = '[AUDIO-ORCH]';
    console.log(`${logPrefix} ${bookId}/${chapterId}/${sceneId}: ${current.phase}`);
    return { success: true, state: current };
}

/**
 * Initialize the audio-orch state for a scene (NEW → PLACEHOLDER_READY).
 * Called from startScene() after placeholder creation.
 */
async function initPlaceholderReady(redis, bookId, chapterId, sceneId, buildId, expectedCount) {
    const state = createState(buildId, expectedCount);
    await setState(redis, bookId, chapterId, sceneId, state);
    const logPrefix = '[AUDIO-ORCH]';
    console.log(`${logPrefix} ${bookId}/${chapterId}/${sceneId}: ${PHASES.PLACEHOLDER_READY} (expected=${expectedCount}, build=${buildId})`);
    return state;
}

/**
 * Transition to GENERATING phase.
 * Called from executeAudioDispatch() before TTS dispatch.
 */
async function setGenerating(redis, bookId, chapterId, sceneId) {
    return await transitionState(redis, bookId, chapterId, sceneId, PHASES.GENERATING);
}

/**
 * Transition to WAITING_CHUNKS phase.
 * Called from executeAudioDispatch() after TTS dispatch.
 */
async function setWaitingChunks(redis, bookId, chapterId, sceneId) {
    return await transitionState(redis, bookId, chapterId, sceneId, PHASES.WAITING_CHUNKS);
}

/**
 * Transition to MERGING phase.
 * Called from triggerAudioMerge() when all chunks are ready.
 */
async function setMerging(redis, bookId, chapterId, sceneId) {
    return await transitionState(redis, bookId, chapterId, sceneId, PHASES.MERGING);
}

/**
 * Transition to DONE phase.
 * Called from triggerAudioMerge() after successful merge.
 */
async function setDone(redis, bookId, chapterId, sceneId) {
    return await transitionState(redis, bookId, chapterId, sceneId, PHASES.DONE);
}

/**
 * Transition to FAILED phase.
 * Called from triggerAudioMerge() after MAX_RETRIES.
 */
async function setFailed(redis, bookId, chapterId, sceneId, reason) {
    return await transitionState(redis, bookId, chapterId, sceneId, PHASES.FAILED, { fail_reason: reason, failed_at: Date.now() });
}

/**
 * Scan all audio-orch keys (for startup recovery).
 */
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
            // Parse bookId, chapterId, sceneId from key:
            // animastor:audio-orch:{bookId}:{chapterId}:{sceneId}
            // After splitting by ':', parts[0]='animastor', parts[1]='audio-orch',
            // and the remaining parts (starting at index 2) are [bookId, chapterId, sceneId].
            // bookId may contain colons (e.g. 'book:name'), so we pop from the end.
            const parts = k.split(':');
            if (parts.length >= 5) {
                const sceneParts = parts.slice(2); // [bookId, chapterId, sceneId] + any colons in bookId
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
    scanAllStates,
};
