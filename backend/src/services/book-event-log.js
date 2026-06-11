// ======================================================
// Book Event Log - PostgreSQL-backed persistent journal
// ======================================================
// Replaces the ephemeral Redis-based event journal
// (animastor:event-journal:*) that was used for scene
// lifecycle observability. The Postgres-backed log is
// append-only, queryable, and survives restarts.

const eventsRepo = require('../storage/postgres/repositories/events-repo');

const logPrefix = '[BOOK-EVENT-LOG]';
function log(msg) { console.log(`${logPrefix} ${msg}`); }

// ======================================================
// EVENT TYPES (canonical set, extensible)
// ======================================================

const EventType = {
    SCENE_CREATED: 'SCENE_CREATED',
    SCENE_UPDATED: 'SCENE_UPDATED',
    SCENE_DELETED: 'SCENE_DELETED',
    CHAPTER_CREATED: 'CHAPTER_CREATED',
    CHAPTER_UPDATED: 'CHAPTER_UPDATED',
    CHAPTER_DELETED: 'CHAPTER_DELETED',
    CHARACTER_CREATED: 'CHARACTER_CREATED',
    CHARACTER_UPDATED: 'CHARACTER_UPDATED',
    CHARACTER_DELETED: 'CHARACTER_DELETED',
    BOOK_IMPORTED: 'BOOK_IMPORTED',
    BOOK_UPDATED: 'BOOK_UPDATED',

    AUDIO_QUEUED: 'AUDIO_QUEUED',
    AUDIO_STARTED: 'AUDIO_STARTED',
    AUDIO_COMPLETED: 'AUDIO_COMPLETED',
    AUDIO_FAILED: 'AUDIO_FAILED',
    AUDIO_MERGED: 'AUDIO_MERGED',

    IMAGE_QUEUED: 'IMAGE_QUEUED',
    IMAGE_STARTED: 'IMAGE_STARTED',
    IMAGE_COMPLETED: 'IMAGE_COMPLETED',
    IMAGE_FAILED: 'IMAGE_FAILED',

    VIDEO_QUEUED: 'VIDEO_QUEUED',
    VIDEO_STARTED: 'VIDEO_STARTED',
    VIDEO_COMPLETED: 'VIDEO_COMPLETED',
    VIDEO_FAILED: 'VIDEO_FAILED',

    ASSET_REGISTERED: 'ASSET_REGISTERED',
    ASSET_INVALIDATED: 'ASSET_INVALIDATED',
    ASSET_DOWNLOADED: 'ASSET_DOWNLOADED',

    CHAT_DISCUSSION: 'CHAT_DISCUSSION',
    CHAT_DECISION: 'CHAT_DECISION',

    BUILD_STARTED: 'BUILD_STARTED',
    BUILD_COMPLETED: 'BUILD_COMPLETED',
    BUILD_FAILED: 'BUILD_FAILED',

    RECOVERY_STARTED: 'RECOVERY_STARTED',
    RECOVERY_COMPLETED: 'RECOVERY_COMPLETED',
    RECOVERY_FAILED: 'RECOVERY_FAILED',
};

const DEFAULT_ACTOR = 'system';

// ======================================================
// APPEND
// ======================================================

async function append(bookId, eventType, payload = {}) {
    const {
        chapterId = null, sceneId = null,
        state = null, actor = DEFAULT_ACTOR,
        refType = null, refId = null, details = null,
    } = payload;

    const event = await eventsRepo.appendEvent({
        book_id: bookId,
        chapter_id: chapterId,
        scene_id: sceneId,
        event_type: eventType,
        state, actor, ref_type: refType, ref_id: refId,
        details,
    });
    log(`APPEND ${eventType} (book=${bookId}${sceneId ? ` scene=${sceneId}` : ''})`);
    return event;
}

async function appendBatch(bookId, events) {
    if (!Array.isArray(events) || events.length === 0) return [];
    const enriched = events.map(e => ({
        book_id: bookId,
        event_type: e.eventType || e.event_type,
        chapter_id: e.chapterId || e.chapter_id || null,
        scene_id: e.sceneId || e.scene_id || null,
        state: e.state || null,
        actor: e.actor || DEFAULT_ACTOR,
        ref_type: e.refType || e.ref_type || null,
        ref_id: e.refId || e.ref_id || null,
        details: e.details || null,
    }));
    return eventsRepo.appendBatch(enriched);
}

// ======================================================
// CONVENIENCE HELPERS
// ======================================================

async function sceneCreated(bookId, chapterId, sceneId, details = {}) {
    return append(bookId, EventType.SCENE_CREATED, {
        chapterId, sceneId, refType: 'scene', refId: sceneId, details,
    });
}

async function sceneUpdated(bookId, chapterId, sceneId, details = {}) {
    return append(bookId, EventType.SCENE_UPDATED, {
        chapterId, sceneId, refType: 'scene', refId: sceneId, details,
    });
}

async function sceneDeleted(bookId, chapterId, sceneId, details = {}) {
    return append(bookId, EventType.SCENE_DELETED, {
        chapterId, sceneId, refType: 'scene', refId: sceneId, details,
    });
}

async function characterUpdated(bookId, characterId, details = {}) {
    return append(bookId, EventType.CHARACTER_UPDATED, {
        refType: 'character', refId: characterId, details,
    });
}

async function audioGenerated(bookId, chapterId, sceneId, details = {}) {
    return append(bookId, EventType.AUDIO_COMPLETED, {
        chapterId, sceneId, refType: 'asset', refId: 'audio', details,
    });
}

async function videoGenerated(bookId, chapterId, sceneId, details = {}) {
    return append(bookId, EventType.VIDEO_COMPLETED, {
        chapterId, sceneId, refType: 'asset', refId: 'video', details,
    });
}

async function chatDiscussion(bookId, sceneId, characterId, topic, details = {}) {
    return append(bookId, EventType.CHAT_DISCUSSION, {
        sceneId, refType: 'chat', refId: `${sceneId || ''}:${characterId || ''}:${topic || ''}`,
        details: { ...details, character_id: characterId, topic },
    });
}

// ======================================================
// QUERIES
// ======================================================

async function getBookEvents(bookId, options = {}) {
    return eventsRepo.getBookEvents(bookId, options);
}

async function getSceneEvents(bookId, chapterId, sceneId, options = {}) {
    return eventsRepo.getSceneEvents(bookId, chapterId, sceneId, options);
}

async function getEventsByRef(bookId, refType, refId, options = {}) {
    return eventsRepo.getEventsByRef(bookId, refType, refId, options);
}

async function getRecentByType(bookId, eventType, sinceTs, options = {}) {
    return eventsRepo.getRecentByType(bookId, eventType, sinceTs, options);
}

async function countByTypeSince(bookId, sinceTs) {
    return eventsRepo.countByType(bookId, sinceTs);
}

// ======================================================
// CLEANUP
// ======================================================

async function deleteBookEvents(bookId) {
    return eventsRepo.deleteBookEvents(bookId);
}

async function deleteSceneEvents(bookId, chapterId, sceneId) {
    return eventsRepo.deleteSceneEvents(bookId, chapterId, sceneId);
}

async function purgeOlderThan(beforeTs) {
    const removed = await eventsRepo.deleteEventsBefore(beforeTs);
    log(`PURGED ${removed} events older than ${beforeTs}`);
    return removed;
}

module.exports = {
    EventType,
    append,
    appendBatch,
    sceneCreated,
    sceneUpdated,
    sceneDeleted,
    characterUpdated,
    audioGenerated,
    videoGenerated,
    chatDiscussion,
    getBookEvents,
    getSceneEvents,
    getEventsByRef,
    getRecentByType,
    countByTypeSince,
    deleteBookEvents,
    deleteSceneEvents,
    purgeOlderThan,
};
