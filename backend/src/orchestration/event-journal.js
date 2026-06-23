// ======================================================
// Event Journal - v1.1.0
// ======================================================
// Redis-based event journal for scene lifecycle observability.
// Nothing is overwritten - only appended.
// Key: animastor:event-journal:${bookId}:${chapterId}:${sceneId}
//
// R5.1: Core scene lifecycle types only. Governance/phase-specific
// types (Phases 8-17) removed — those modules were cleaned up in R6.4.

const logPrefix = '[JOURNAL]'

function log(msg) {
    console.log(`${logPrefix} ${msg}`)
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`)
}

// ======================================================
// EVENT TYPES (core scene lifecycle only)
// ======================================================

const EventType = {
    SCENE_STARTED: 'SCENE_STARTED',
    AUDIO_STARTED: 'AUDIO_STARTED',
    AUDIO_DISPATCHED: 'AUDIO_DISPATCHED',
    AUDIO_DISPATCH_FAILED: 'AUDIO_DISPATCH_FAILED',
    AUDIO_COMPLETED: 'AUDIO_COMPLETED',
    AUDIO_FAILED: 'AUDIO_FAILED',
    AUDIO_MERGED: 'AUDIO_MERGED',
    IMAGE_STARTED: 'IMAGE_STARTED',
    IMAGE_DISPATCHED: 'IMAGE_DISPATCHED',
    IMAGE_DISPATCH_FAILED: 'IMAGE_DISPATCH_FAILED',
    IMAGE_COMPLETED: 'IMAGE_COMPLETED',
    IMAGE_FAILED: 'IMAGE_FAILED',
    VIDEO_STARTED: 'VIDEO_STARTED',
    VIDEO_DISPATCHED: 'VIDEO_DISPATCHED',
    VIDEO_COMPLETED: 'VIDEO_COMPLETED',
    VIDEO_FAILED: 'VIDEO_FAILED',
    RECOVERY_STARTED: 'RECOVERY_STARTED',
    RECOVERY_COMPLETED: 'RECOVERY_COMPLETED',
    RECOVERY_FAILED: 'RECOVERY_FAILED',
    TRANSITION_FAILED: 'TRANSITION_FAILED',
    DUPLICATE_CALLBACK: 'DUPLICATE_CALLBACK',
    INVALID_STATE_CALLBACK: 'INVALID_STATE_CALLBACK',
    LOCK_ACQUIRED: 'LOCK_ACQUIRED',
    LOCK_RELEASED: 'LOCK_RELEASED',
    ASSET_REGISTERED: 'ASSET_REGISTERED',
    ORCHESTRATION_PROGRESS: 'ORCHESTRATION_PROGRESS',
    AUTO_RECOVER: 'AUTO_RECOVER',
    DISPATCH_BLOCKED_CIRCUIT: 'DISPATCH_BLOCKED_CIRCUIT',
    RETRY_BUDGET_EXCEEDED: 'RETRY_BUDGET_EXCEEDED',
    STARVATION_DETECTED: 'STARVATION_DETECTED',
    PRIORITY_BOOSTED: 'PRIORITY_BOOSTED',
    OVERLOAD_PROTECTION_ENABLED: 'OVERLOAD_PROTECTION_ENABLED',
}

// ======================================================
// INTERNAL: GET EVENT JOURNAL KEY
// ======================================================

function getEventJournalKey(bookId, chapterId, sceneId) {
    return `animastor:event-journal:${bookId}:${chapterId}:${sceneId}`
}

// ======================================================
// APPEND EVENT
// ======================================================

/**
 * Append an event to scene journal.
 * Append-only - never overwrites existing events.
 */
async function appendSceneEvent(redis, bookId, chapterId, sceneId, type, state, details = {}) {
    const key = getEventJournalKey(bookId, chapterId, sceneId)
    
    const event = {
        ts: Date.now(),
        type,
        scene: {
            bookId,
            chapterId,
            sceneId
        },
        state,
        details
    }
    
    // Use Redis pipeline for atomic append
    const result = await redis.rpush(key, JSON.stringify(event))
    
    log(`APPEND: ${type} (scene: ${bookId}/${chapterId}/${sceneId})`)
    
    return {
        success: true,
        event,
        ttl: 604800,  // 7 days TTL on key
        length: result
    }
}

// ======================================================
// GET SCENE EVENTS
// ======================================================

/**
 * Get all events for a scene.
 * Returns array of event objects, oldest first.
 */
async function getSceneEvents(redis, bookId, chapterId, sceneId, limit = 1000) {
    const key = getEventJournalKey(bookId, chapterId, sceneId)
    
    const eventsRaw = await redis.lrange(key, 0, limit - 1)
    
    const events = eventsRaw.map(evt => JSON.parse(evt))
    
    return events
}

/**
 * Get events for scene within time range.
 */
async function getSceneEventsByTime(redis, bookId, chapterId, sceneId, startTime, endTime) {
    const allEvents = await getSceneEvents(redis, bookId, chapterId, sceneId)
    
    return allEvents.filter(evt => {
        return evt.ts >= startTime && evt.ts <= endTime
    })
}

/**
 * Get last N events for scene.
 */
async function getLastEvents(redis, bookId, chapterId, sceneId, n = 10) {
    const key = getEventJournalKey(bookId, chapterId, sceneId)
    
    const eventsRaw = await redis.lrange(key, -n, -1)
    
    const events = eventsRaw.map(evt => JSON.parse(evt))
    
    return events.reverse()  // Reverse to get newest first
}

/**
 * Get events by type.
 */
async function getEventsByType(redis, bookId, chapterId, sceneId, eventType) {
    const allEvents = await getSceneEvents(redis, bookId, chapterId, sceneId)
    
    return allEvents.filter(evt => evt.type === eventType)
}

// ======================================================
// GET SCENE JOURNAL METADATA
// ======================================================

/**
 * Get event count for scene.
 */
async function getEventCount(redis, bookId, chapterId, sceneId) {
    const key = getEventJournalKey(bookId, chapterId, sceneId)
    
    return await redis.llen(key)
}

/**
 * Get first event timestamp.
 */
async function getFirstEventTime(redis, bookId, chapterId, sceneId) {
    const key = getEventJournalKey(bookId, chapterId, sceneId)
    
    const first = await redis.lindex(key, 0)
    
    if (!first) return null
    
    const event = JSON.parse(first)
    return event.ts
}

/**
 * Get last event timestamp.
 */
async function getLastEventTime(redis, bookId, chapterId, sceneId) {
    const key = getEventJournalKey(bookId, chapterId, sceneId)
    
    const last = await redis.lindex(key, -1)
    
    if (!last) return null
    
    const event = JSON.parse(last)
    return event.ts
}

// ======================================================
// GET SCENE JOURNAL AGE
// ======================================================

/**
 * Get time range of events in milliseconds.
 */
async function getEventTimeRange(redis, bookId, chapterId, sceneId) {
    const firstTime = await getFirstEventTime(redis, bookId, chapterId, sceneId)
    const lastTime = await getLastEventTime(redis, bookId, chapterId, sceneId)
    
    if (!firstTime || !lastTime) return 0
    
    return lastTime - firstTime
}

// ======================================================
// DELETE SCENE JOURNAL
// ======================================================

/**
 * Delete all events for a scene.
 * USE WITH CAUTION.
 */
async function deleteSceneEvents(redis, bookId, chapterId, sceneId) {
    const key = getEventJournalKey(bookId, chapterId, sceneId)
    
    return await redis.del(key)
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    EventType,
    appendSceneEvent,
    getSceneEvents,
    getSceneEventsByTime,
    getLastEvents,
    getEventsByType,
    getEventCount,
    getFirstEventTime,
    getLastEventTime,
    getEventTimeRange,
    deleteSceneEvents,
}
