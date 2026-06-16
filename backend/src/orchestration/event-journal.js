// ======================================================
// Event Journal - v1.0.0
// ======================================================
// Redis-based event journal for scene lifecycle observability.
// Nothing is overwritten - only appended.
// Key: animastor:event-journal:${bookId}:${chapterId}:${sceneId}

const logPrefix = '[JOURNAL]'

function log(msg) {
    console.log(`${logPrefix} ${msg}`)
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`)
}

// ======================================================
// EVENT TYPES
// ======================================================

const EventType = {
    SCENE_STARTED: 'SCENE_STARTED',
    AUDIO_STARTED: 'AUDIO_STARTED',
    AUDIO_COMPLETED: 'AUDIO_COMPLETED',
    AUDIO_FAILED: 'AUDIO_FAILED',
    AUDIO_MERGED: 'AUDIO_MERGED',
    IMAGE_STARTED: 'IMAGE_STARTED',
    IMAGE_COMPLETED: 'IMAGE_COMPLETED',
    IMAGE_FAILED: 'IMAGE_FAILED',
    VIDEO_STARTED: 'VIDEO_STARTED',
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

    // Phase 8: Failure Taxonomy events
    FAILURE_CLASSIFIED: 'FAILURE_CLASSIFIED',
    RETRY_SCHEDULED: 'RETRY_SCHEDULED',
    RETRY_SKIPPED: 'RETRY_SKIPPED',
    RETENTION_CLEANUP: 'RETENTION_CLEANUP',
    SNAPSHOT_GENERATED: 'SNAPSHOT_GENERATED',

    // Phase 9: Circuit Breaker events
    CIRCUIT_OPENED: 'CIRCUIT_OPENED',
    CIRCUIT_HALF_OPEN: 'CIRCUIT_HALF_OPEN',
    CIRCUIT_CLOSED: 'CIRCUIT_CLOSED',
    DISPATCH_BLOCKED_CIRCUIT: 'DISPATCH_BLOCKED_CIRCUIT',

    // Phase 9: Retry budget events
    RETRY_BUDGET_EXCEEDED: 'RETRY_BUDGET_EXCEEDED',

    // Phase 9: Fairness events
    STARVATION_DETECTED: 'STARVATION_DETECTED',
    PRIORITY_BOOSTED: 'PRIORITY_BOOSTED',
    OVERLOAD_PROTECTION_ENABLED: 'OVERLOAD_PROTECTION_ENABLED',

    // Phase 10: Policy events
    POLICY_POLICY_BLOCKED: 'POLICY_BLOCKED',
    POLICY_POLICY_DELAYED: 'POLICY_DELAYED',
    POLICY_POLICY_ALLOWED: 'POLICY_ALLOWED',
    POLICY_POLICY_THROTTLED: 'POLICY_THROTTLED',
    WORKLOAD_WORKLOAD_CLASSIFIED: 'WORKLOAD_CLASSIFIED',
    COST_COST_ESTIMATED: 'COST_ESTIMATED',
    THROTTLE_APPLIED: 'THROTTLE_APPLIED',

    // Phase 11: Persistence events
    SNAPSHOT_TAKEN: 'SNAPSHOT_TAKEN',
    SNAPSHOT_SAVED: 'SNAPSHOT_SAVED',
    RECOVERY_INITIATED: 'RECOVERY_INITIATED',
    RECOVERY_COMPLETED: 'RECOVERY_COMPLETED',
    CHECKPOINT_CREATED: 'CHECKPOINT_CREATED',

    // Phase 11: Compaction events
    RETRY_SUMMARY_COMPACTED: 'RETRY_SUMMARY_COMPACTED',
    DISPATCH_SUMMARY_COMPACTED: 'DISPATCH_SUMMARY_COMPACTED',
    STATE_SUMMARY_COMPACTED: 'STATE_SUMMARY_COMPACTED',
    BUILD_SUMMARY_COMPACTED: 'BUILD_SUMMARY_COMPACTED',

    // Phase 12: Governance events
    ADMISSION_ACCEPTED: 'ADMISSION_ACCEPTED',
    ADMISSION_REJECTED: 'ADMISSION_REJECTED',
    ADMISSION_DELAYED: 'ADMISSION_DELAYED',
    ADMISSION_THROTTLED: 'ADMISSION_THROTTLED',
    POLICY_COMPOSED: 'POLICY_COMPOSED',
    POLICY_OVERRIDE: 'POLICY_OVERRIDE',
    ADAPTIVE_ADJUSTMENT: 'ADAPTIVE_ADJUSTMENT',
    FEEDBACK_APPLIED: 'FEEDBACK_APPLIED',
    COST_MODEL_UPDATED: 'COST_MODEL_UPDATED',
    ADMISSION_TIGHTENED: 'ADMISSION_TIGHTENED',
    ADMISSION_RELAXED: 'ADMISSION_RELAXED',
    DECISION_TRACED: 'DECISION_TRACED',
    STARVATION_CORRECTED: 'STARVATION_CORRECTED',

    // Phase 13: Stability events
    ADAPTATION_DAMPED: 'ADAPTATION_DAMPED',
    ADAPTATION_COOLDOWN_ACTIVE: 'ADAPTATION_COOLDOWN_ACTIVE',
    TRACE_COMPACTED: 'TRACE_COMPACTED',
    GOVERNANCE_STABILIZED: 'GOVERNANCE_STABILIZED',
    OSCILLATION_DETECTED: 'OSCILLATION_DETECTED',
    HEALTH_SCORE_UPDATED: 'HEALTH_SCORE_UPDATED',
    POLICY_CONVERGED: 'POLICY_CONVERGED',
    BOUNDED_ADAPTATION: 'BOUNDED_ADAPTATION',

    // Phase 14: Simulation events
    POLICY_SIMULATED: 'POLICY_SIMULATED',
    FAILURE_REPLAYED: 'FAILURE_REPLAYED',
    DECISION_REPLAYED: 'DECISION_REPLAYED',
    GOVERNANCE_DIFF_CALCULATED: 'GOVERNANCE_DIFF_CALCULATED',
    SANDBOX_EXPERIMENT_RUN: 'SANDBOX_EXPERIMENT_RUN',
    POLICY_VERSION_REGISTERED: 'POLICY_VERSION_REGISTERED',
    POLICY_VERSION_CHANGED: 'POLICY_VERSION_CHANGED',
    A_B_TEST_COMPLETE: 'A_B_TEST_COMPLETE',
    POLICY_REGRESSION_DETECTED: 'POLICY_REGRESSION_DETECTED',
    POLICY_EVOLUTION_TRACKED: 'POLICY_EVOLUTION_TRACKED',

    // Phase 15: Safety and invariant events
    INVARIANT_VALIDATED: 'INVARIANT_VALIDATED',
    INVARIANT_VIOLATED: 'INVARIANT_VIOLATED',
    SAFE_MODE_ENTERED: 'SAFE_MODE_ENTERED',
    SAFE_MODE_EXITED: 'SAFE_MODE_EXITED',
    POLICY_CERTIFIED: 'POLICY_CERTIFIED',
    POLICY_REJECTED: 'POLICY_REJECTED',
    GOVERNANCE_VALIDATION_FAILED: 'GOVERNANCE_VALIDATION_FAILED',
    REPLAY_INVARIANT_DETECTED: 'REPLAY_INVARIANT_DETECTED',

    // Phase 16: State graph and causal ordering events
    STATE_GRAPH_VALIDATED: 'STATE_GRAPH_VALIDATED',
    INVALID_TRANSITION_BLOCKED: 'INVALID_TRANSITION_BLOCKED',
    REPLAY_DIVERGENCE_DETECTED: 'REPLAY_DIVERGENCE_DETECTED',
    CAUSAL_ORDER_VERIFIED: 'CAUSAL_ORDER_VERIFIED',
    SUBSYSTEM_ISOLATED: 'SUBSYSTEM_ISOLATED',

    // Phase 17: Graph visualization and protocol testing events
    GRAPH_VALIDATED: 'GRAPH_VALIDATED',
    GRAPH_LINT_FAILED: 'GRAPH_LINT_FAILED',
    SEMANTIC_BREAKING_CHANGE_DETECTED: 'SEMANTIC_BREAKING_CHANGE_DETECTED',
    PROTOCOL_TEST_FAILED: 'PROTOCOL_TEST_FAILED',
    REPLAY_SEMANTIC_MISMATCH: 'REPLAY_SEMANTIC_MISMATCH',
    GRAPH_HEALTH_UPDATED: 'GRAPH_HEALTH_UPDATED'
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

    // ==================================================
    // CAUSAL ORDERING HELPERS (PHASE 16)
    // ==================================================

    /**
     * Generate causal ID for deterministic replay.
     * Format: timestamp:sequence
     * Ensures strict ordering within same timestamp.
     */
    generateCausalId: (timestamp = Date.now()) => {
        const seq = Math.random().toString(36).slice(2, 10);
        return `${timestamp}:${seq}`;
    },

    /**
     * Parse causal ID into timestamp and sequence.
     */
    parseCausalId: (causalId) => {
        const parts = causalId.split(':');
        return {
            timestamp: parseInt(parts[0], 10),
            sequence: parts[1] || ''
        };
    },

    /**
     * Verify causal ordering of events.
     * Events should be sorted by (timestamp, sequence).
     */
    verifyCausalOrder: (events) => {
        const issues = [];

        for (let i = 1; i < events.length; i++) {
            const prev = journal.parseCausalId(events[i - 1].causalId || '');
            const curr = journal.parseCausalId(events[i].causalId || '');

            // Check timestamp ordering
            if (curr.timestamp < prev.timestamp) {
                issues.push({
                    index: i,
                    prevCausalId: events[i - 1].causalId,
                    currCausalId: events[i].causalId,
                    reason: 'Timestamp out of order'
                });
            }

            // Check sequence ordering for same timestamp
            if (curr.timestamp === prev.timestamp && curr.sequence <= prev.sequence) {
                issues.push({
                    index: i,
                    prevCausalId: events[i - 1].causalId,
                    currCausalId: events[i].causalId,
                    reason: 'Sequence out of order'
                });
            }
        }

        return {
            valid: issues.length === 0,
            issues
        };
    },

    /**
     * Get missing causal IDs by comparing expected vs actual.
     */
    findMissingCausalIds: (expectedIds, actualIds) => {
        const expectedSet = new Set(expectedIds.filter(Boolean));
        const actualSet = new Set(actualIds.filter(Boolean));

        const missing = [];
        for (const id of expectedIds) {
            if (id && !actualSet.has(id)) {
                missing.push(id);
            }
        }

        return {
            expectedCount: expectedIds.length,
            actualCount: actualIds.length,
            missingCount: missing.length,
            missingIds: missing
        };
    },

    /**
     * Check if events are causally consistent.
     */
    checkCausalConsistency: (events) => {
        const result = verifyCausalOrder(events);

        if (!result.valid) {
            return {
                consistent: false,
                issues: result.issues,
                explanation: 'Events are not in causal order'
            };
        }

        // Check for causal loops (self-referencing)
        for (const evt of events) {
            if (evt.causalId && evt.refersTo && evt.refersTo === evt.causalId) {
                return {
                    consistent: false,
                    issues: [{
                        type: 'causal_loop',
                        eventId: evt.causalId
                    }],
                    explanation: 'Causal loop detected'
                };
            }
        }

        return {
            consistent: true,
            issues: [],
            explanation: null
        };
    }
}
