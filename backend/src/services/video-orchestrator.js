// ======================================================
// Video Orchestrator — state machine для видео-генерации сцены
// ======================================================
// Проблема (2026-08-11): видео сцены разбивается на N групп
// (`_g1`..`_gN`), но приём результатов был «первый забрал всё»:
// первый пришедший результат вызывал completeStage → finalizeDispatch
// удалял metadata/lease, и остальные группы отклонялись с
// `no_active_dispatch` — на диск попадал только первый файл.
//
// Решение — оркестрация по образцу audio-orchestrator (T7):
// единая state machine на Redis-ключе
// `animastor:video-orch:{bookId}:{chapterId}:{sceneId}`.
//
// Phase machine:
//
//   NEW ──→ GENERATING ──→ WAITING_CHUNKS ──→ MERGING ──→ DONE
//                                ↘              ↘
//                                FAILED ────────→ FAILED
//
// | Phase | Владелец перехода | Когда |
// |-------|-------------------|-------|
// | NEW → GENERATING | executeVideoDispatch() | Перед отправкой групп в GPU hub |
// | GENERATING → WAITING_CHUNKS | executeVideoDispatch() | После отправки всех групп |
// | WAITING_CHUNKS → MERGING | completeGroup() | Когда все группы на диске |
// | MERGING → DONE | completeGroup() → completeMerge() | После успешной склейки для плеера |
// | WAITING_CHUNKS → FAILED | failWaitingScene() (watchdog/recovery) | Застой групп или сбой |
// | FAILED → WAITING_CHUNKS | completeGroup() (late group) | Все группы пришли после FAILED |
// | FAILED → GENERATING | scheduler re-dispatch | На следующем scheduler tick |
//
// Инварианты:
//   phase=DONE   ⇒ asset.video = READY
//   phase=FAILED ⇒ asset.video = FAILED (→ PENDING после re-dispatch)
//   промежуточные ⇒ asset.video = GENERATING
//
// Отличие от аудио: видео-группы НЕ склеиваются в обязательный единый
// файл для хранения — чанки остаются отдельными файлами `_gN.mp4`
// (нужны для точечной dirty-регенерации). Склейка `_g1.._gN` → `scene.mp4`
// выполняется только для плеера (mergeSceneVideoGroups) и НЕ удаляет
// групповые файлы.

const path = require('path');
const fs = require('fs');
const config = require('../config/runtime-config');

const logPrefix = '[VIDEO-ORCH]';
function log(msg) { console.log(`${logPrefix} ${msg}`); }
function warn(msg) { console.warn(`${logPrefix} ⚠️ ${msg}`); }

const PREFIX = 'animastor:video-orch';
// Склеенный файл считается готовым, если >= этого размера (байт).
// Групповые файлы валидируются тем же порогом.
const MIN_VIDEO_BYTES = 10240; // 10 KB — совпадает с video.validateVideoFile

const PHASES = {
    NEW: 'NEW',
    GENERATING: 'GENERATING',
    WAITING_CHUNKS: 'WAITING_CHUNKS',
    MERGING: 'MERGING',
    DONE: 'DONE',
    FAILED: 'FAILED',
};

// Valid transitions map
const VALID_TRANSITIONS = {
    [PHASES.NEW]: [PHASES.GENERATING],
    [PHASES.GENERATING]: [PHASES.WAITING_CHUNKS, PHASES.FAILED],
    [PHASES.WAITING_CHUNKS]: [PHASES.MERGING, PHASES.FAILED],
    [PHASES.MERGING]: [PHASES.DONE, PHASES.FAILED],
    [PHASES.FAILED]: [PHASES.GENERATING, PHASES.WAITING_CHUNKS],
    [PHASES.DONE]: [], // terminal
};

/**
 * Build the Redis key for a scene's video-orch state.
 */
function key(bookId, chapterId, sceneId) {
    return `${PREFIX}:${bookId}:${chapterId}:${sceneId}`;
}

/**
 * Create initial video-orch state for a scene.
 * @param {string} buildId
 * @param {Array<{suffix: string, unit_ids: string[]}>} groups — '_g1'..'_gN' (legacy '' допустим)
 */
function createState(buildId, groups = []) {
    return {
        phase: PHASES.GENERATING,
        expected_count: groups.length,
        groups_received: 0,
        groups: groups.map(g => ({
            suffix: g.suffix || '',
            unit_ids: Array.isArray(g.unit_ids) ? g.unit_ids : [],
            status: 'pending',
        })),
        started_at: Date.now(),
        last_group_at: null,
        build_id: buildId,
    };
}

/**
 * Read the current video-orch state from Redis. Returns null if absent (phase = NEW).
 */
async function getState(redis, bookId, chapterId, sceneId) {
    const raw = await redis.get(key(bookId, chapterId, sceneId));
    return raw ? JSON.parse(raw) : null;
}

/**
 * Set (overwrite) the video-orch state in Redis.
 */
async function setState(redis, bookId, chapterId, sceneId, state) {
    await redis.set(key(bookId, chapterId, sceneId), JSON.stringify(state));
}

/**
 * Delete the video-orch state from Redis.
 */
async function deleteState(redis, bookId, chapterId, sceneId) {
    await redis.del(key(bookId, chapterId, sceneId));
}

/**
 * Transition the video-orch state to a new phase with transition validation.
 * Returns { success: true, state } or { success: false, reason, from }.
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

/**
 * Create/replace video-orch state for a dispatch. Все группы — pending.
 * Терминальный DONE перезаписывается (dirty-регенерация) — ожидаемое
 * поведение: предыдущий результат остаётся на диске и используется как
 * cache-hit при совпадении unit_ids (см. executeVideoDispatch).
 */
async function initState(redis, bookId, chapterId, sceneId, buildId, groups) {
    const state = createState(buildId, groups);
    await setState(redis, bookId, chapterId, sceneId, state);
    log(`${bookId}/${chapterId}/${sceneId}: ${PHASES.GENERATING} (${groups.length} group(s), build=${buildId})`);
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

// ── GROUP HELPERS ──────────────────────────────────────

/**
 * Отметить группу как done в state (по суффиксу).
 * Возвращает обновлённый state.
 */
async function markGroupDone(redis, bookId, chapterId, sceneId, groupSuffix) {
    const state = await getState(redis, bookId, chapterId, sceneId);
    if (!state || !Array.isArray(state.groups)) return state;

    const group = state.groups.find(g => g.suffix === (groupSuffix || ''));
    if (group && group.status !== 'done') {
        group.status = 'done';
        state.groups_received = (state.groups_received || 0) + 1;
        state.last_group_at = Date.now();
        await setState(redis, bookId, chapterId, sceneId, state);
    }
    return state;
}

/**
 * Все ли группы отмечены done.
 */
function allGroupsDone(state) {
    return !!(state && Array.isArray(state.groups) && state.groups.length > 0
        && state.groups.every(g => g.status === 'done'));
}

/**
 * Список суффиксов групп в порядке генерации (для склейки).
 */
function groupSuffixes(state) {
    if (!state || !Array.isArray(state.groups)) return [];
    return state.groups.map(g => g.suffix);
}

/**
 * Полный путь группового файла.
 */
function groupFilePath(buildId, bookId, chapterId, sceneId, suffix) {
    return path.join(config.OUTPUT_DIR, buildId, `${bookId}_${chapterId}_${sceneId}${suffix || ''}.mp4`);
}

/**
 * Проверить валидность группового файла на диске (существует, не пустой).
 */
function isGroupFileValid(buildId, bookId, chapterId, sceneId, suffix) {
    try {
        const p = groupFilePath(buildId, bookId, chapterId, sceneId, suffix);
        if (!fs.existsSync(p)) return false;
        return fs.statSync(p).size >= MIN_VIDEO_BYTES;
    } catch (_) {
        return false;
    }
}

// ════════════════════════════════════════════════════════
// COMPLETE GROUP — приём результата одной группы,
// проверка комплектности, склейка для плеера, completeStage.
// Вызывается из task-handler.cjs (scene_video) и recovery.
// ════════════════════════════════════════════════════════

async function completeGroup(redis, bookId, chapterId, sceneId, groupSuffix, buildId, deps = {}) {
    const { orchestrator, dispatchId } = deps;
    const buildDir = path.join(config.OUTPUT_DIR, buildId);

    const orchState = await getState(redis, bookId, chapterId, sceneId);
    if (!orchState) {
        // Результат без state — старый формат (одна группа, до video-orch).
        // Принимаем как есть: файл уже записан task-handler'ом.
        log(`completeGroup: no video-orch state for ${bookId}/${chapterId}/${sceneId} — legacy single-group path`);
        if (orchestrator) {
            const meta = await require('../runtime/dispatch-engine').getDispatchMetadata(redis, bookId, chapterId, sceneId, 'video');
            await orchestrator.completeStage(redis, bookId, chapterId, sceneId, 'video', buildId, meta?.dispatch_id || dispatchId);
        }
        return { completed: false, reason: 'no_state_legacy' };
    }
    if (orchState.phase === PHASES.DONE) {
        log(`Video already done for ${bookId}/${chapterId}/${sceneId} — skipping`);
        return { completed: true, reason: 'already_done' };
    }
    if (orchState.phase === PHASES.MERGING) {
        log(`Merge in progress for ${bookId}/${chapterId}/${sceneId} — waiting`);
        return { completed: false, reason: 'merging' };
    }

    // ── SAFETY NET: GENERATING → WAITING_CHUNKS ──
    // Первый результат может прийти раньше, чем executeVideoDispatch
    // успел вызвать setWaitingChunks (race при быстрых группах).
    if (orchState.phase === PHASES.GENERATING) {
        const trans = await transitionState(redis, bookId, chapterId, sceneId, PHASES.WAITING_CHUNKS);
        if (!trans.success) {
            warn(`GENERATING→WAITING_CHUNKS failed: ${trans.reason}`);
            return { completed: false, reason: trans.reason };
        }
        orchState.phase = PHASES.WAITING_CHUNKS;
    }

    // ── LATE GROUP RECOVERY: FAILED → WAITING_CHUNKS ──
    // Сцена была переведена в FAILED watchdog'ом, но группы продолжают
    // приезжать. Если недостающие группы уже на диске — возобновляем склейку.
    if (orchState.phase === PHASES.FAILED) {
        const suffixes = groupSuffixes(orchState);
        const allPresent = suffixes.length > 0 && suffixes.every(s => isGroupFileValid(buildId, bookId, chapterId, sceneId, s));
        if (allPresent) {
            log(`RECOVERY: All ${suffixes.length} groups present despite FAILED — resuming merge`);
            const trans = await transitionState(redis, bookId, chapterId, sceneId, PHASES.WAITING_CHUNKS);
            if (!trans.success) {
                warn(`RECOVERY: transition FAILED→WAITING_CHUNKS failed: ${trans.reason}`);
                return { completed: false, reason: trans.reason };
            }
        } else {
            log(`Phase is FAILED but not all groups present — waiting for re-dispatch`);
            return { completed: false, reason: 'failed_waiting_redispatch' };
        }
    }

    if (orchState.phase !== PHASES.WAITING_CHUNKS) {
        log(`Phase is ${orchState.phase} — not ready for merge, skipping`);
        return { completed: false, reason: 'not_waiting' };
    }

    // ── Отмечаем пришедшую группу done + проверяем комплектность ──
    await markGroupDone(redis, bookId, chapterId, sceneId, groupSuffix);

    const suffixes = groupSuffixes(orchState);
    const missing = suffixes.filter(s => !isGroupFileValid(buildId, bookId, chapterId, sceneId, s));
    if (missing.length > 0) {
        log(`${bookId}/${chapterId}/${sceneId}: ${suffixes.length - missing.length}/${suffixes.length} groups valid, missing=[${missing.join(',')}]`);
        return { completed: false, reason: 'waiting_groups', missing };
    }

    // ══════════════════════════════════════════════════
    // ALL GROUPS PRESENT → MERGE (для плеера) → DONE
    // ══════════════════════════════════════════════════
    const trans = await transitionState(redis, bookId, chapterId, sceneId, PHASES.MERGING, {
        groups_received: suffixes.length,
        last_group_at: Date.now(),
    });
    if (!trans.success) {
        warn(`→MERGING failed: ${trans.reason}`);
        return { completed: false, reason: trans.reason };
    }

    try {
        const videoMerge = deps.videoMerge || require('../video/video-merge');
        const mergedPath = await videoMerge.mergeSceneVideoGroups(
            redis, buildId, bookId, chapterId, sceneId, suffixes
        );

        // ── MERGE-LOCK RACE GUARD ──
        // Два результата могут прийти одновременно и оба дойти до merge.
        // mergeSceneVideoGroups защищён NX-локом: проигравший получает null
        // («merge already in progress»), что НЕ является ошибкой. Перечитываем
        // state: если победитель уже довёл до DONE — считаем успехом;
        // если merge всё ещё идёт (MERGING) — ждём, ничего не валим.
        if (!mergedPath) {
            const after = await getState(redis, bookId, chapterId, sceneId);
            if (after && after.phase === PHASES.DONE) {
                log(`Merge won by another caller — scene already DONE for ${bookId}/${chapterId}/${sceneId}`);
                return { completed: true, reason: 'merged_by_other' };
            }
            if (after && after.phase === PHASES.MERGING) {
                log(`Merge in progress by another caller for ${bookId}/${chapterId}/${sceneId} — waiting`);
                return { completed: false, reason: 'merging' };
            }
            // Реального merge не было (нет групп/файлов) — терминальный сбой.
            warn(`merge produced no output for ${bookId}/${chapterId}/${sceneId}`);
            await setFailed(redis, bookId, chapterId, sceneId, 'merge_failed_no_output');
            return { completed: false, reason: 'merge_failed' };
        }

        if (!fs.existsSync(mergedPath) || fs.statSync(mergedPath).size < MIN_VIDEO_BYTES) {
            warn(`merge output invalid for ${bookId}/${chapterId}/${sceneId}`);
            await setFailed(redis, bookId, chapterId, sceneId, 'merge_failed_no_output');
            return { completed: false, reason: 'merge_failed' };
        }

        await setDone(redis, bookId, chapterId, sceneId);
        log(`VIDEO-ORCH: ${bookId}/${chapterId}/${sceneId} → DONE (${suffixes.length} groups merged → ${path.basename(mergedPath)})`);

        if (orchestrator) {
            // Используем dispatch_id из ТЕКУЩЕЙ metadata (а не из последнего
            // результата): поздние группы могут прийти со stale-dispatch
            // (WAITING_CHUNKS stale-accept), но completeStage обязан пройти
            // verifyDispatchIdentity по активному dispatch.
            const meta = await require('../runtime/dispatch-engine').getDispatchMetadata(redis, bookId, chapterId, sceneId, 'video');
            await orchestrator.completeStage(redis, bookId, chapterId, sceneId, 'video', buildId, meta?.dispatch_id || dispatchId);
        }
        return { completed: true, reason: 'merged' };
    } catch (err) {
        warn(`merge failed for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
        await setFailed(redis, bookId, chapterId, sceneId, `merge_error:${err.message}`);
        return { completed: false, reason: 'merge_error' };
    }
}

// ════════════════════════════════════════════════════════
// FAIL WAITING SCENE — единственный владелец WAITING_CHUNKS → FAILED.
// Вызывается watchdog'ом застоя (reconcileCycle.checkStalledVideoScenes)
// и recovery. Чистит hub-dedup недостающих групп и публикует итог через
// orchestrator.failStage (FAILED → PENDING → scheduler передиспатчит).
// ════════════════════════════════════════════════════════

async function failWaitingScene(redis, bookId, chapterId, sceneId, buildId, reason, deps = {}) {
    const { orchestrator, dispatchId } = deps;

    const orchState = await getState(redis, bookId, chapterId, sceneId);
    if (!orchState || orchState.phase !== PHASES.WAITING_CHUNKS) {
        return { failed: false, reason: 'not_waiting_chunks', phase: orchState ? orchState.phase : null };
    }

    const suffixes = groupSuffixes(orchState);
    const missing = suffixes.filter(s => !isGroupFileValid(buildId, bookId, chapterId, sceneId, s));
    warn(`failWaitingScene: ${bookId}/${chapterId}/${sceneId} — ${missing.length}/${suffixes.length} missing (${reason})`);
    await setFailed(redis, bookId, chapterId, sceneId, reason);

    // Освобождаем hub-dedup недостающих групп, чтобы re-dispatch смог
    // отправить их заново. Ключ вида animastor:job:{dispatch_id}:{job_id}.
    for (const suffix of missing) {
        const jobId = `${bookId}_${chapterId}_${sceneId}${suffix || ''}:video`;
        let cursor = '0';
        do {
            const [next, keys] = await redis.scan(cursor, 'MATCH', `animastor:job:*:${jobId}`, 'COUNT', 50);
            cursor = next;
            if (keys.length > 0) await redis.del(...keys);
        } while (cursor !== '0');
    }

    if (orchestrator) {
        try {
            const meta = await require('../runtime/dispatch-engine').getDispatchMetadata(redis, bookId, chapterId, sceneId, 'video');
            await orchestrator.failStage(redis, bookId, chapterId, sceneId, 'video', buildId,
                reason, { dispatchId: meta?.dispatch_id || dispatchId });
            log(`Video FAILED→PENDING via failStage for ${bookId}/${chapterId}/${sceneId}`);
        } catch (fsErr) {
            warn(`failStage failed: ${fsErr.message}`);
        }
    }
    return { failed: true, missing };
}

// ════════════════════════════════════════════════════════
// SCAN ALL STATES (для startup recovery и watchdog)
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
                    results.push({ key: k, bookId, chapterId, sceneId, state: JSON.parse(raw) });
                }
            }
        }
    }
    return results;
}

module.exports = {
    PREFIX,
    PHASES,
    MIN_VIDEO_BYTES,
    key,
    createState,
    getState,
    setState,
    deleteState,
    transitionState,
    initState,
    setGenerating,
    setWaitingChunks,
    setMerging,
    setDone,
    setFailed,
    markGroupDone,
    allGroupsDone,
    groupSuffixes,
    groupFilePath,
    isGroupFileValid,
    completeGroup,
    failWaitingScene,
    scanAllStates,
};
