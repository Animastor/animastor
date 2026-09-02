package com.example.animastor.repository

// ======================================================
// Private Worker models (Experimental Beta — Phase 3)
// ======================================================
// 1:1 with the backend shapes in routes/worker-routes.cjs (web parity:
// frontends/app features/workers/privateWorkers.ts). List/detail NEVER carry
// token/token_hash — only safe metadata + at most token_prefix. The plaintext
// credential is a ONE-TIME disclosure in the create/rotate responses.

data class PrivateWorker(
    val worker_id: String? = null,
    val workspace_id: String? = null,
    val name: String? = null,
    val worker_type: String? = null,
    /** "private" | "share". */
    val mode: String? = null,
    /** Derived operational status: "ONLINE" | "OFFLINE" | "REVOKED". */
    val status: String? = null,
    val token_prefix: String? = null,
    /** Epoch ms (Redis heartbeat ts / last seen). */
    val last_seen: Long? = null,
    val revoked_at: Long? = null,
    val created_at: Long? = null
)

data class PrivateWorkerListResponse(
    val workers: List<PrivateWorker> = emptyList()
)

data class PrivateWorkerDetailResponse(
    val worker: PrivateWorker? = null
)

data class CreateWorkerRequest(
    val name: String,
    val worker_type: String
)

data class CreateWorkerResponse(
    val worker: PrivateWorker? = null,
    /** One-time disclosure — never returned again. */
    val token: String? = null
)

data class RotateWorkerResponse(
    val worker: PrivateWorker? = null,
    /** One-time disclosure — the old credential dies immediately. */
    val token: String? = null
)

data class RevokeWorkerResponse(
    val revoked: Boolean = false
)

// ======================================================
// Worker Sharing V2 (SH-2) — wire models. Web parity:
// frontends/app features/workers/sharing.ts (1:1 with the backend JSON).
// The backend is the single source of truth: every read replaces local
// state wholesale; the UI never fabricates grants, policies or expiry.
// ======================================================

/** share_policies row (active policy snapshot, owner or read view). */
data class SharePolicy(
    val policy_id: String? = null,
    val worker_id: String? = null,
    val workspace_id: String? = null,
    /** "public" | "users" (V1/V2 scope kinds). */
    val scope_kind: String? = null,
    val starts_at: Long? = null,
    /** Epoch ms; null = "until manually stopped". */
    val expires_at: Long? = null,
    val revoked_at: Long? = null,
    val created_by: String? = null,
    val created_at: Long? = null
)

/** share_policy_grants row joined with the recipient's public projection. */
data class ShareGrant(
    val grant_id: String? = null,
    val policy_id: String? = null,
    val user_id: String? = null,
    val created_at: Long? = null,
    val username: String? = null,
    val display_name: String? = null
)

/** GET /workers/:id/share — owner view of the current sharing state. */
data class ShareStateResponse(
    val sharing: Boolean = false,
    val policy: SharePolicy? = null,
    val grants: List<ShareGrant> = emptyList()
)

data class StartShareRequest(
    /** "public" (no recipients) | "users" (+ usernames). */
    val scope: String,
    /** Recipients by exact username; required for scope "users". */
    val users: List<String>? = null,
    /** Epoch ms, strictly in the future; omitted = no expiry. */
    val expires_at: Long? = null
)

data class StopShareResponse(
    val sharing: Boolean = false,
    val stopped: Boolean = false
)

data class AddShareUsersRequest(
    val users: List<String>
)

data class AddShareUsersResponse(
    val grants: List<ShareGrant> = emptyList()
)

data class RemoveShareUserRequest(
    val username: String
)

data class RemoveShareUserResponse(
    val revoked: Boolean = false
)

/** GET /workers/shared-with-me entry — §14.2 access reason included. */
data class SharedWithMeWorker(
    val worker_id: String? = null,
    val name: String? = null,
    val worker_type: String? = null,
    val capabilities: Any? = null,
    val owner_workspace_id: String? = null,
    val revoked_at: Long? = null,
    val last_seen: Long? = null,
    val created_at: Long? = null,
    val granted_at: Long? = null,
    val share_policy: SharePolicy? = null,
    val access_reason: SharedWithMeAccessReason? = null
)

/** §14.2: exactly why this resource is accessible (V2: shared_by_user only). */
data class SharedWithMeAccessReason(
    /** V2 constant: "shared_by_user". */
    val kind: String? = null,
    val shared_by: String? = null,
    val shared_by_display_name: String? = null,
    val owner_workspace_name: String? = null
)

data class SharedWithMeResponse(
    val workers: List<SharedWithMeWorker> = emptyList()
)

/** GET /users/lookup — exact username match, public projection only. */
data class LookupUser(
    val user_id: String? = null,
    val username: String? = null,
    val display_name: String? = null
)

data class LookupUserResponse(
    val user: LookupUser? = null
)
