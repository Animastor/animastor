package com.example.animastor.ui

import com.example.animastor.repository.SharedWithMeAccessReason
import com.example.animastor.repository.SharedWithMeWorker
import com.example.animastor.repository.SharePolicy
import org.junit.Assert.assertEquals
import org.junit.After
import org.junit.Before
import org.junit.Test

// Share notifications — minimal adapter (SH-2 UX §5/§6, web parity:
// frontends/app features/workers/shareNotifications.test.ts). Backend
// state is the source of truth; the module derives a session-only unread
// badge and a notice-transport seam subscribers can plug into.
class ShareNotificationsTest {

    private fun swm(
        id: String,
        sharedBy: String = "ivan"
    ): SharedWithMeWorker = SharedWithMeWorker(
        worker_id = id, name = "Worker $id", worker_type = "audio",
        capabilities = null, owner_workspace_id = "ws1", revoked_at = null,
        last_seen = null, created_at = null, granted_at = null,
        share_policy = SharePolicy(
            policy_id = "p", scope_kind = "users",
            starts_at = null, expires_at = null
        ),
        access_reason = SharedWithMeAccessReason(
            kind = "shared_by_user", shared_by = sharedBy,
            shared_by_display_name = null, owner_workspace_name = null
        )
    )

    @Before fun setUp() = ShareNotifications.resetShareNotifications()
    @After fun tearDown() = ShareNotifications.resetShareNotifications()

    // ── transport seam ──────────────────────────────────────────────────

    @Test fun subscribersReceiveEmittedNotices_unsubscribeStops() {
        val seen = mutableListOf<String?>()
        val off = ShareNotifications.onShareNotice { seen.add(it.worker_name) }
        ShareNotifications.emitShareNotice(ShareNotifications.ShareNotice(
            event = "worker.shared_with_user", worker_id = "w1",
            worker_name = "Home GPU", actor_username = "ivan", ts = 1,
        ))
        off()
        ShareNotifications.emitShareNotice(ShareNotifications.ShareNotice(
            event = "worker.shared_with_user", worker_id = "w1",
            worker_name = "Again", actor_username = "ivan", ts = 2,
        ))
        assertEquals(listOf("Home GPU"), seen)
    }

    @Test fun throwingSubscriberNeverBreaksOthers() {
        var okCalls = 0
        val off1 = ShareNotifications.onShareNotice { throw RuntimeException("boom") }
        val off2 = ShareNotifications.onShareNotice { okCalls++ }
        ShareNotifications.emitShareNotice(ShareNotifications.ShareNotice(
            "worker.shared_with_user", "w", "n", "a", 1,
        ))
        assertEquals(1, okCalls)
        off1(); off2()
    }

    @Test fun noticeFromEntryMirrorsEventContract() {
        val n = ShareNotifications.noticeFromEntry(swm("w9", "maria"), ts = 42)
        assertEquals(ShareNotifications.ShareNotice.EVENT_WORKER_SHARED, n.event)
        assertEquals("w9", n.worker_id)
        assertEquals("Worker w9", n.worker_name)
        assertEquals("maria", n.actor_username)
        assertEquals(42, n.ts)
    }

    // ── syncSharedWithMe (badge + derived notices) ─────────────────────

    @Test fun initialSyncSeedsCountWithoutToasting() {
        val spy = mutableListOf<ShareNotifications.ShareNotice>()
        val off = ShareNotifications.onShareNotice { spy.add(it) }
        val fresh = ShareNotifications.syncSharedWithMe(
            prev = emptyList(),
            next = listOf(swm("w1"), swm("w2")),
        )
        assertEquals(emptyList<SharedWithMeWorker>(), fresh)
        assertEquals(2, ShareNotifications.sharedWithMeCount)
        assertEquals(2, ShareNotifications.sharedUnreadCount)
        assertEquals(0, spy.size)
        off()
    }

    @Test fun laterSyncWithNewGrantRaisesExactlyOneNotice() {
        val spy = mutableListOf<ShareNotifications.ShareNotice>()
        val off = ShareNotifications.onShareNotice { spy.add(it) }
        ShareNotifications.syncSharedWithMe(emptyList(), listOf(swm("w1")))
        val fresh = ShareNotifications.syncSharedWithMe(
            prev = listOf(swm("w1")),
            next = listOf(swm("w1"), swm("w2", sharedBy = "maria")),
        )
        assertEquals(listOf("w2"), fresh.map { it.worker_id })
        assertEquals(1, spy.size)
        assertEquals("maria", spy[0].actor_username)
        // Badge: 2 entries total, 1 unseen (w2 is the fresh one).
        assertEquals(2, ShareNotifications.sharedWithMeCount)
        assertEquals(2, ShareNotifications.sharedUnreadCount)
        off()
    }

    @Test fun revokedOrExpiredEntriesVanishFromCount() {
        ShareNotifications.syncSharedWithMe(emptyList(), listOf(swm("w1"), swm("w2")))
        ShareNotifications.syncSharedWithMe(
            prev = listOf(swm("w1"), swm("w2")),
            next = listOf(swm("w1")),
        )
        assertEquals(1, ShareNotifications.sharedWithMeCount)
    }

    @Test fun markSharedSeenClearsUnreadBadgeButNotTotal() {
        val list = listOf(swm("w1"), swm("w2"))
        ShareNotifications.syncSharedWithMe(emptyList(), list)
        ShareNotifications.markSharedSeen(list)
        assertEquals(0, ShareNotifications.sharedUnreadCount)
        assertEquals(2, ShareNotifications.sharedWithMeCount)
    }

    @Test fun markSharedSeenOnEmptyListIsNoop() {
        ShareNotifications.syncSharedWithMe(emptyList(), emptyList())
        ShareNotifications.markSharedSeen(emptyList())
        assertEquals(0, ShareNotifications.sharedUnreadCount)
    }
}
