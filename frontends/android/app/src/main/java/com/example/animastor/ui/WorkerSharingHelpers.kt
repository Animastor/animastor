package com.example.animastor.ui

import com.example.animastor.repository.PrivateWorker
import com.example.animastor.repository.ShareGrant
import com.example.animastor.repository.SharedWithMeAccessReason
import com.example.animastor.repository.SharedWithMeWorker
import com.example.animastor.repository.SharePolicy
import java.text.SimpleDateFormat
import java.util.Locale

// ─────────────────────────────────────────────────────────────────────────
// Worker Sharing V2 (SH-2) — pure helpers. Web parity: frontends/app
// features/workers/sharing.ts (same rules, same key names, same diffs).
// No Android framework calls — unit tested on the JVM
// (WorkerSharingHelpersTest), same pattern as BetaSettingsHelpers.
//
// The backend is the single source of truth: these helpers only DERIVE
// presentation from server state — they never fabricate grants, policies
// or expiry (§14.4 of worker-sharing-model-design.md).
// ─────────────────────────────────────────────────────────────────────────

object WorkerSharingHelpers {

    const val MAX_USERNAME_LEN = 120
    /** Online threshold for a foreign worker's last_seen (web parity: 90s). */
    const val ONLINE_WINDOW_MS = 90_000L

    // ── Mode derivation (owner view: Off / Public / Specific users) ─────

    const val MODE_OFF = "off"
    const val MODE_PUBLIC = "public"
    const val MODE_USERS = "users"

    /** User-facing sharing mode from the active policy (or null). */
    fun shareModeOf(policy: SharePolicy?): String {
        if (policy == null || policy.revoked_at != null) return MODE_OFF
        return when (policy.scope_kind) {
            "users" -> MODE_USERS
            "public" -> MODE_PUBLIC
            else -> MODE_OFF
        }
    }

    /** Expiry re-check on read — mirrors the backend read rule: an expired
     *  policy is NOT active (a stale cache can never extend sharing). */
    fun isPolicyExpired(policy: SharePolicy?, now: Long): Boolean {
        val exp = policy?.expires_at ?: return false
        return exp <= now
    }

    // ── "Shared with me" entry rendering (§14.2 access reason) ──────────

    /** "Shared by <username>" — falls back through display name /
     *  workspace name (same order as web sharedByLabel). */
    fun sharedByLabel(reason: SharedWithMeAccessReason?): String {
        if (reason == null) return ""
        return reason.shared_by ?: reason.shared_by_display_name
            ?: reason.owner_workspace_name ?: ""
    }

    /** 'online' | 'offline' for a shared-with-me row: revoked or expired
     *  policy ⇒ offline; otherwise fresh last_seen wins. */
    fun sharedStatusOf(w: SharedWithMeWorker, now: Long): String {
        if (w.revoked_at != null) return "offline"
        if (isPolicyExpired(w.share_policy, now)) return "offline"
        val seen = w.last_seen ?: return "offline"
        return if (now - seen < ONLINE_WINDOW_MS) "online" else "offline"
    }

    // ── Recipient input validation (exact username, pre-lookup) ─────────

    sealed class UsernameValidation {
        data class Ok(val username: String) : UsernameValidation()
        data class Fail(val errorKey: String) : UsernameValidation()
    }

    /** Trim + validate a recipient input BEFORE the exact-match lookup. */
    fun normalizeUsername(raw: String): UsernameValidation {
        val username = raw.trim()
        if (username.isEmpty()) {
            return UsernameValidation.Fail("share_err_username_required")
        }
        if (username.length > MAX_USERNAME_LEN) {
            return UsernameValidation.Fail("share_err_username_too_long")
        }
        return UsernameValidation.Ok(username)
    }

    /** True when the username is already among the visible recipients. */
    fun isDuplicateRecipient(username: String, grants: List<ShareGrant>): Boolean {
        val u = username.trim()
        return grants.any { it.username == u }
    }

    // ── Owner row eligibility ────────────────────────────────────────────

    /** Private, non-revoked workers only (D7): ownership/mode are never
     *  editable; the backend enforces the same predicates — this only
     *  avoids rendering a button that would 404. */
    fun canBeShared(w: PrivateWorker): Boolean {
        return w.mode == "private" && w.status != "REVOKED"
    }

    // ── Expiry formatting (short localized-style "until" suffix) ────────

    /** Relative for <7d ("45m"/"3h"/"2d"), else an absolute short date.
     *  Web parity: formatExpiry in sharing.ts. */
    fun formatExpiry(ts: Long?, now: Long): String {
        if (ts == null) return ""
        val diff = ts - now
        if (diff <= 0) {
            val fmt = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.ROOT)
            return fmt.format(java.util.Date(ts))
        }
        if (diff < 3_600_000) return "${maxOf(1, diff / 60_000)}m"
        if (diff < 86_400_000) return "${diff / 3_600_000}h"
        if (diff < 7 * 86_400_000) return "${diff / 86_400_000}d"
        val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.ROOT)
        return fmt.format(java.util.Date(ts))
    }

    // ── Expiry presets (Android §10 parity: 1h / 4h / until stopped) ────

    const val EXPIRY_NONE = "none"
    const val EXPIRY_1H = "1h"
    const val EXPIRY_4H = "4h"

    /** Preset → epoch-ms (null = no expiry). Pure. */
    fun expiryEpochForPreset(preset: String, now: Long): Long? = when (preset) {
        EXPIRY_1H -> now + 3_600_000L
        EXPIRY_4H -> now + 4 * 3_600_000L
        else -> null
    }

    // ── State diff (§14.2 notification seam) ────────────────────────────

    /** Which entries of [next] are NEW compared to [prev] (by worker_id).
     *  Pure — used to raise «<username> поделился воркером с вами». */
    fun diffSharedWorkers(prev: List<SharedWithMeWorker>, next: List<SharedWithMeWorker>): List<SharedWithMeWorker> {
        val seen = prev.mapNotNull { it.worker_id }.toSet()
        return next.filter { it.worker_id !in seen }
    }

    // ── Error mapping (HTTP status + message → i18n key) ────────────────

    /** Map share-flow failures to i18n keys; hides DB/Redis internals the
     *  same way web shareErrorKey() does. Pass the Retrofit status code and
     *  the parsed backend error message. Unknown errors → generic key. */
    fun shareErrorKey(status: Int, message: String?): String {
        val msg = message ?: ""
        return when {
            status == 401 -> "worker_err_auth_required"
            status == 403 -> "share_err_forbidden"
            status == 404 -> "worker_err_not_found"
            status == 409 -> when {
                msg.contains("already shared") -> "share_err_already_active"
                msg.contains("no active users sharing") -> "share_err_no_users_policy"
                else -> "share_err_unavailable"
            }
            status == 400 -> when {
                msg.contains("Unknown user") -> "share_err_unknown_user"
                msg.contains("yourself") -> "share_err_self_grant"
                msg.contains("expires_at must be in the future") -> "share_err_expiry_past"
                msg.contains("users must be") -> "share_err_invalid_users"
                msg.contains("scope") -> "share_err_invalid_scope"
                else -> "share_err_unavailable"
            }
            status in 500..599 -> "worker_err_unavailable"
            else -> "share_err_unavailable"
        }
    }
}
