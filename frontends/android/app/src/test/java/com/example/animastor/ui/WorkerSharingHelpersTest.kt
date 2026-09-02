package com.example.animastor.ui

import com.example.animastor.repository.PrivateWorker
import com.example.animastor.repository.ShareGrant
import com.example.animastor.repository.SharedWithMeAccessReason
import com.example.animastor.repository.SharedWithMeWorker
import com.example.animastor.repository.SharePolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Worker Sharing V2 (SH-2) pure helpers — JVM tests (web parity:
// frontends/app features/workers/sharing.test.ts). Same fixtures, same
// rules; WorkerSharingHelpers.kt has no Android framework calls.
class WorkerSharingHelpersTest {

    private val NOW = 1_700_000_000_000L

    private fun policy(
        scope: String = "public",
        expiresAt: Long? = null,
        revokedAt: Long? = null
    ) = SharePolicy(
        policy_id = "p1", scope_kind = scope, starts_at = NOW - 1000,
        expires_at = expiresAt, revoked_at = revokedAt
    )

    private fun grant(
        username: String = "ivan",
        display: String? = "Ivan Petrov"
    ) = ShareGrant(
        grant_id = "g1", policy_id = "p1", user_id = "u2",
        created_at = NOW - 500, username = username, display_name = display
    )

    private fun swm(
        lastSeen: Long? = NOW - 30_000,
        revoked: Long? = null,
        expiresAt: Long? = null,
        sharedBy: String? = "ivan"
    ) = SharedWithMeWorker(
        worker_id = "w1", name = "Home GPU", worker_type = "audio",
        owner_workspace_id = "ws1", revoked_at = revoked, last_seen = lastSeen,
        granted_at = NOW - 1000,
        share_policy = SharePolicy(
            policy_id = "p1", scope_kind = "users",
            starts_at = NOW - 1000, expires_at = expiresAt
        ),
        access_reason = SharedWithMeAccessReason(
            kind = "shared_by_user", shared_by = sharedBy,
            shared_by_display_name = "Ivan Petrov", owner_workspace_name = "Ivan ws"
        )
    )

    // ── mode derivation (owner view: off / public / users) ─────────────

    @Test
    fun mode_derivesOffPublicUsersFromPolicy() {
        assertEquals("off", WorkerSharingHelpers.shareModeOf(null))
        assertEquals("public", WorkerSharingHelpers.shareModeOf(policy("public")))
        assertEquals("users", WorkerSharingHelpers.shareModeOf(policy("users")))
    }

    @Test
    fun mode_treatsRevokedPolicyAsOff() {
        assertEquals("off", WorkerSharingHelpers.shareModeOf(policy(revokedAt = NOW)))
    }

    @Test
    fun mode_unknownScopeIsOff() {
        assertEquals("off", WorkerSharingHelpers.shareModeOf(policy("group")))
        assertEquals("off", WorkerSharingHelpers.shareModeOf(SharePolicy()))
    }

    // ── expiry re-check (mirrors the backend read rule) ────────────────

    @Test
    fun expiry_expiredPolicyIsNotActive() {
        assertTrue(WorkerSharingHelpers.isPolicyExpired(policy(expiresAt = NOW - 1), NOW))
        assertFalse(WorkerSharingHelpers.isPolicyExpired(policy(expiresAt = NOW + 1), NOW))
        assertFalse(WorkerSharingHelpers.isPolicyExpired(policy(expiresAt = null), NOW))
        assertFalse(WorkerSharingHelpers.isPolicyExpired(null, NOW))
    }

    // ── shared-with-me entry (§14.2 access reason) ─────────────────────

    @Test
    fun sharedBy_rendersUsername() {
        assertEquals("ivan", WorkerSharingHelpers.sharedByLabel(swm().access_reason))
    }

    @Test
    fun sharedBy_fallsBackThroughDisplayNameAndWorkspace() {
        assertEquals(
            "Ivan ws",
            WorkerSharingHelpers.sharedByLabel(
                SharedWithMeAccessReason("shared_by_user", null, null, "Ivan ws")
            )
        )
        assertEquals("", WorkerSharingHelpers.sharedByLabel(null))
        assertEquals(
            "",
            WorkerSharingHelpers.sharedByLabel(SharedWithMeAccessReason("shared_by_user", null, null, null))
        )
    }

    @Test
    fun status_onlineWhenFreshOfflineWhenRevokedOrExpired() {
        assertEquals("online", WorkerSharingHelpers.sharedStatusOf(swm(), NOW))
        assertEquals("offline", WorkerSharingHelpers.sharedStatusOf(swm(lastSeen = NOW - 10 * 60_000), NOW))
        assertEquals("offline", WorkerSharingHelpers.sharedStatusOf(swm(revoked = NOW), NOW))
        assertEquals("offline", WorkerSharingHelpers.sharedStatusOf(swm(expiresAt = NOW - 1), NOW))
        assertEquals("offline", WorkerSharingHelpers.sharedStatusOf(swm(lastSeen = null), NOW))
    }

    // ── recipient input (exact username, pre-lookup) ───────────────────

    @Test
    fun username_trimsAndAccepts() {
        val ok = WorkerSharingHelpers.normalizeUsername("  ivan  ")
            as WorkerSharingHelpers.UsernameValidation.Ok
        assertEquals("ivan", ok.username)
    }

    @Test
    fun username_rejectsEmptyAndTooLong() {
        val empty = WorkerSharingHelpers.normalizeUsername("   ")
            as WorkerSharingHelpers.UsernameValidation.Fail
        assertEquals("share_err_username_required", empty.errorKey)
        val long = WorkerSharingHelpers.normalizeUsername("x".repeat(121))
            as WorkerSharingHelpers.UsernameValidation.Fail
        assertEquals("share_err_username_too_long", long.errorKey)
    }

    @Test
    fun duplicateRecipient_detectedCaseSensitivelyLikeWeb() {
        val grants = listOf(grant("ivan"))
        assertTrue(WorkerSharingHelpers.isDuplicateRecipient("ivan", grants))
        assertTrue(WorkerSharingHelpers.isDuplicateRecipient(" ivan ", grants))
        assertFalse(WorkerSharingHelpers.isDuplicateRecipient("maria", grants))
        assertFalse(WorkerSharingHelpers.isDuplicateRecipient("ivan", emptyList()))
    }

    // ── owner row eligibility (D7) ──────────────────────────────────────

    @Test
    fun canBeShared_privateNonRevokedOnly() {
        assertTrue(WorkerSharingHelpers.canBeShared(PrivateWorker(mode = "private", status = "ONLINE")))
        assertTrue(WorkerSharingHelpers.canBeShared(PrivateWorker(mode = "private", status = "OFFLINE")))
        assertFalse(WorkerSharingHelpers.canBeShared(PrivateWorker(mode = "private", status = "REVOKED")))
        assertFalse(WorkerSharingHelpers.canBeShared(PrivateWorker(mode = "share", status = "ONLINE")))
        assertFalse(WorkerSharingHelpers.canBeShared(PrivateWorker(mode = "system", status = "ONLINE")))
    }

    // ── expiry formatting / presets ─────────────────────────────────────

    @Test
    fun expiryFormats_relativeThenDate() {
        assertEquals("45m", WorkerSharingHelpers.formatExpiry(NOW + 45 * 60_000, NOW))
        assertEquals("1m", WorkerSharingHelpers.formatExpiry(NOW + 10_000, NOW))
        assertEquals("3h", WorkerSharingHelpers.formatExpiry(NOW + 3 * 3_600_000, NOW))
        assertEquals("2d", WorkerSharingHelpers.formatExpiry(NOW + 2 * 86_400_000, NOW))
        assertTrue(WorkerSharingHelpers.formatExpiry(NOW - 1, NOW).isNotEmpty())
        assertEquals("", WorkerSharingHelpers.formatExpiry(null, NOW))
    }

    @Test
    fun expiryPresets_mapToEpochs() {
        assertEquals(NOW + 3_600_000, WorkerSharingHelpers.expiryEpochForPreset(WorkerSharingHelpers.EXPIRY_1H, NOW))
        assertEquals(NOW + 4 * 3_600_000, WorkerSharingHelpers.expiryEpochForPreset(WorkerSharingHelpers.EXPIRY_4H, NOW))
        assertEquals(null, WorkerSharingHelpers.expiryEpochForPreset(WorkerSharingHelpers.EXPIRY_NONE, NOW))
        assertEquals(null, WorkerSharingHelpers.expiryEpochForPreset("bogus", NOW))
    }

    // ── state diff (§14.2 notification seam) ────────────────────────────

    @Test
    fun diff_newEntriesByWorkerId() {
        val prev = listOf(swm())
        val next = listOf(swm(), swm().copy(worker_id = "w2"))
        val diff = WorkerSharingHelpers.diffSharedWorkers(prev, next)
        assertEquals(1, diff.size)
        assertEquals("w2", diff[0].worker_id)
        assertTrue(WorkerSharingHelpers.diffSharedWorkers(next, next).isEmpty())
        assertEquals(1, WorkerSharingHelpers.diffSharedWorkers(emptyList(), prev).size)
    }

    // ── error mapping (ApiError → i18n key) ─────────────────────────────

    @Test
    fun errors_mapStatusAndMessage() {
        assertEquals("worker_err_auth_required", WorkerSharingHelpers.shareErrorKey(401, null))
        assertEquals("share_err_forbidden", WorkerSharingHelpers.shareErrorKey(403, null))
        assertEquals("worker_err_not_found", WorkerSharingHelpers.shareErrorKey(404, null))
        assertEquals("worker_err_unavailable", WorkerSharingHelpers.shareErrorKey(500, null))
    }

    @Test
    fun errors_map409Buckets() {
        assertEquals(
            "share_err_already_active",
            WorkerSharingHelpers.shareErrorKey(409, "Worker is already shared — stop sharing first")
        )
        assertEquals(
            "share_err_no_users_policy",
            WorkerSharingHelpers.shareErrorKey(409, "Worker has no active users sharing — start sharing with users first")
        )
    }

    @Test
    fun errors_map400Buckets() {
        assertEquals("share_err_unknown_user", WorkerSharingHelpers.shareErrorKey(400, "Unknown user(s): zzz"))
        assertEquals("share_err_self_grant", WorkerSharingHelpers.shareErrorKey(400, "Cannot share with yourself"))
        assertEquals("share_err_expiry_past", WorkerSharingHelpers.shareErrorKey(400, "expires_at must be in the future"))
        assertEquals("share_err_invalid_users", WorkerSharingHelpers.shareErrorKey(400, "users must be a non-empty array"))
        assertEquals("share_err_invalid_scope", WorkerSharingHelpers.shareErrorKey(400, "scope must be one of"))
        assertEquals("share_err_unavailable", WorkerSharingHelpers.shareErrorKey(400, "something else"))
    }
}
