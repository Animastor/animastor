package com.example.animastor.repository

/**
 * Authentication models — 1:1 with the backend /api/v1/auth shapes
 * (web parity: frontends/app state/authStore.ts).
 */

data class AuthUser(
    val id: String? = null,
    val username: String? = null,
    val display_name: String? = null
)

data class AuthWorkspace(
    val id: String? = null,
    val name: String? = null,
    val type: String? = null,
    val status: String? = null,
    val expires_at: Long? = null
)

/** GET /api/v1/auth/me — identity: "user" | "guest" | "none". */
data class AuthMe(
    val authenticated: Boolean = false,
    val identity: String? = null,
    val user: AuthUser? = null,
    val workspace: AuthWorkspace? = null
)

data class AuthLoginRequest(
    val username: String,
    val password: String
)

data class AuthRegisterRequest(
    val username: String,
    val password: String,
    val email: String? = null
)
