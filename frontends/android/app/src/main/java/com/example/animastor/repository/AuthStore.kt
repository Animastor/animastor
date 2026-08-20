package com.example.animastor.repository

import com.example.animastor.network.RetrofitClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import retrofit2.HttpException

/**
 * Authentication state — web parity with frontends/app state/authStore.ts.
 *
 * The server-side cookie is the only source of truth (HttpOnly `animastor_sid`
 * session + `animastor_gid` guest); this store only mirrors GET /auth/me and
 * forwards login/register/logout to the /api/v1/auth endpoints. No tokens are
 * ever stored or handled here.
 */
object AuthStore {

    data class AuthState(
        val authenticated: Boolean = false,
        /** "user" | "guest" | "none" — mirrors /auth/me identity. */
        val identity: String = "none",
        val user: AuthUser? = null,
        val workspace: AuthWorkspace? = null
    )

    private val _state = MutableStateFlow(AuthState())
    val state: StateFlow<AuthState> = _state.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    /** Refresh identity from the server. Safe on network failure. */
    suspend fun refresh(): AuthState {
        val me = try {
            RetrofitClient.api.me()
        } catch (_: Exception) {
            null
        }
        val next = me?.let {
            AuthState(
                authenticated = it.authenticated,
                identity = it.identity ?: if (it.authenticated) "user" else "none",
                user = it.user,
                workspace = it.workspace
            )
        } ?: AuthState()
        _state.value = next
        return next
    }

    suspend fun login(username: String, password: String) {
        _busy.value = true
        try {
            val me = RetrofitClient.api.login(AuthLoginRequest(username, password))
            _state.value = AuthState(true, me.identity ?: "user", me.user, me.workspace)
        } finally {
            _busy.value = false
        }
    }

    suspend fun register(username: String, password: String, email: String?) {
        _busy.value = true
        try {
            val me = RetrofitClient.api.register(AuthRegisterRequest(username, password, email))
            _state.value = AuthState(true, me.identity ?: "user", me.user, me.workspace)
        } finally {
            _busy.value = false
        }
    }

    /** Logout is idempotent server-side; the cookie jar clears regardless. */
    suspend fun logout() {
        _busy.value = true
        try {
            runCatching { RetrofitClient.api.logout() }
        } finally {
            com.example.animastor.AnimastorApp.authCookies?.clear()
            _state.value = AuthState()
            _busy.value = false
        }
    }
}
