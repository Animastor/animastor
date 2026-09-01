// ======================================================
// Share Events (Experimental Beta — SH-2, worker sharing V2)
// ======================================================
// MINIMAL event contract for personal sharing (§14.2/§15 of
// worker-sharing-model-design.md). There is deliberately NO notification
// subsystem yet: this module only fixes the stable event PAYLOAD and the
// single emission seam. A future notification consumer (V3+) attaches via
// setSink() — or reads the structured `[SHARE-EVENT]` log lines — without
// re-plumbing the share routes.
//
// Contract — one JSON object per event:
//   {
//     event:    'worker.shared_with_user',       (stable event type)
//     ts:       <epoch ms>,
//     resource: { kind: 'worker', id, name },    (generic resource seam)
//     recipient:{ user_id, username },           (who gained access)
//     actor:    { user_id, username },           (who shared)
//     reason:   'shared_by_user'                 (access reason, §14.2)
//   }
//
// Enough to render: «<actor.username> поделился с вами Worker
// <resource.name>». Future event types (revocation, group share) follow the
// same shape with their own `event` / `reason` values.

const EVENT_WORKER_SHARED_WITH_USER = 'worker.shared_with_user';
const REASON_SHARED_BY_USER = 'shared_by_user';

const sinks = new Set();

/** Attach a test/consumer sink. Returns a detach function. */
function setSink(fn) {
    if (typeof fn === 'function') sinks.add(fn);
    return () => sinks.delete(fn);
}

/** Build the canonical payload (pure — unit-testable). */
function buildWorkerSharedWithUserEvent({ workerId, workerName, recipient, actor }) {
    return {
        event: EVENT_WORKER_SHARED_WITH_USER,
        resource: {
            kind: 'worker',
            id: workerId || null,
            name: workerName || null,
        },
        recipient: {
            user_id: (recipient && recipient.user_id) || null,
            username: (recipient && recipient.username) || null,
        },
        actor: {
            user_id: (actor && actor.user_id) || null,
            username: (actor && actor.username) || null,
        },
        reason: REASON_SHARED_BY_USER,
    };
}

/** Emit one event: structured log line + every attached sink. Non-fatal. */
function emitShareEvent(event) {
    try {
        const payload = { ts: Date.now(), ...(event || {}) };
        console.log(`[SHARE-EVENT] ${JSON.stringify(payload)}`);
        for (const fn of sinks) {
            try { fn(payload); } catch (_) { /* sinks must never break the API */ }
        }
    } catch (_) { /* non-fatal by contract */ }
}

module.exports = {
    EVENT_WORKER_SHARED_WITH_USER,
    REASON_SHARED_BY_USER,
    buildWorkerSharedWithUserEvent,
    emitShareEvent,
    setSink,
};
