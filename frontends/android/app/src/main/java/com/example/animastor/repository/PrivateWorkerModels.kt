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
