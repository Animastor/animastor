package com.example.animastor.ui

import com.example.animastor.repository.SharedWithMeWorker

typealias NoticeHandler = (n: ShareNotifications.ShareNotice) -> Unit

// ─────────────────────────────────────────────────────────────────────────
// Share notifications — minimal adapter (SH-2 UX §5/§6, web parity:
// frontends/app features/workers/shareNotifications.ts). Backend-driven
// state is the source of truth; this module derives (1) a session-only
// unread badge counter and (2) a notice-seam subscribers can plug into.
// A future SSE/WS transport (or a real notification feed) calls
// [emitShareNotice] directly; until then, notices are derived from
// [syncSharedWithMe] state diffs — every worker_id newly present in a
// sync (after the first) raises exactly one notice per session.
//
// Web parity invariants:
//   • The badge counts PERSONAL shared workers only — the community pool
//     is never leaked in. Revoked/expired entries simply stop arriving
//     (server truth) and the count follows.
//   • markSharedSeen() clears the SESSION-ONLY unread badge; it does NOT
//     touch the total (the user has not lost any grants).
//   • Initial sync seeds the badge without toasting pre-existing access.
// ─────────────────────────────────────────────────────────────────────────

object ShareNotifications {

    /** Mirrors share-events.js event contract. */
    data class ShareNotice(
        val event: String,
        val worker_id: String?,
        val worker_name: String?,
        val actor_username: String?,
        val ts: Long
    ) {
        companion object {
            const val EVENT_WORKER_SHARED = "worker.shared_with_user"
        }
    }

    // NOTICE dedup: every worker_id ever seen in a sync (across view state) —
    // a grant toasts once per session, even if the user views and it stays.
    private val knownWorkerIds = mutableSetOf<String>()
    // BADGE state: worker_ids the user has explicitly viewed this session.
    private val viewedWorkerIds = mutableSetOf<String>()

    /** Personal shared-worker count from the latest backend fetch (truth). */
    @Volatile var sharedWithMeCount: Int = 0
        private set
    /** How many of those entries the user has not viewed this session. */
    @Volatile var sharedUnreadCount: Int = 0
        private set

    // ── transport seam ──────────────────────────────────────────────────

    private val handlers = mutableSetOf<NoticeHandler>()

    /** Subscribe to share notices. Returns the unsubscribe function. */
    fun onShareNotice(fn: NoticeHandler): () -> Unit {
        handlers.add(fn)
        return { handlers.remove(fn) }
    }

    /** Raise a notice to every subscriber (never throws). */
    fun emitShareNotice(n: ShareNotice) {
        for (fn in handlers.toList()) {
            try { fn(n) } catch (_: Throwable) { /* subscribers must not break the flow */ }
        }
    }

    /** Build a notice from a shared-with-me entry + now (pure). */
    fun noticeFromEntry(entry: SharedWithMeWorker, ts: Long = System.currentTimeMillis()): ShareNotice {
        return ShareNotice(
            event = ShareNotice.EVENT_WORKER_SHARED,
            worker_id = entry.worker_id,
            worker_name = entry.name,
            actor_username = entry.access_reason?.shared_by,
            ts = ts,
        )
    }

    /** Re-initialize the session-only notification state (used by tests and
     *  a full re-login). Access itself is always re-fetched from the backend. */
    @Synchronized
    fun resetShareNotifications() {
        knownWorkerIds.clear()
        viewedWorkerIds.clear()
        sharedWithMeCount = 0
        sharedUnreadCount = 0
        handlers.clear()
    }

    // ── badge + derived notices ────────────────────────────────────────

    /** Sync the badge + derive notices from a fresh shared-with-me read.
     *  The FIRST sync of a session only seeds state (no surprise toasts
     *  for access granted before the page loaded — the badge already
     *  reflects it); every later sync raises notices for genuinely new
     *  worker_ids. Returns the entries that raised notices (empty on
     *  initial sync). */
    @Synchronized
    fun syncSharedWithMe(
        prev: List<SharedWithMeWorker>,
        next: List<SharedWithMeWorker>,
    ): List<SharedWithMeWorker> {
        sharedWithMeCount = next.size
        val isInitialSync = prev.isEmpty() && knownWorkerIds.isEmpty()
        val freshForNotices = next.filter { (it.worker_id ?: "") !in knownWorkerIds }
        for (w in next) w.worker_id?.let { knownWorkerIds.add(it) }
        sharedUnreadCount = next.count { (it.worker_id ?: "") !in viewedWorkerIds }
        if (!isInitialSync) {
            for (w in freshForNotices) emitShareNotice(noticeFromEntry(w))
        }
        return if (isInitialSync) emptyList() else freshForNotices
    }

    /** User opened "Shared with me" — badge clears (session sugar only). */
    @Synchronized
    fun markSharedSeen(current: List<SharedWithMeWorker>) {
        for (w in current) w.worker_id?.let { viewedWorkerIds.add(it) }
        sharedUnreadCount = 0
    }
}
