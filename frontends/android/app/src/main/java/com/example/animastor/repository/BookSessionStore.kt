package com.example.animastor.repository

import android.content.SharedPreferences

/**
 * Book session persistence + per-user logout/login stash.
 *
 * Web parity: frontends/app/src/state/generateStore.ts
 *   BOOK_STORE_KEY = 'animastor:currentBook'
 *   userStashKey   = 'animastor:currentBook:user:<userId>'
 *   stashBookSessionForUser / restoreStashedBookSessionForUser
 *
 * The live session (bookId/buildId) survives an app restart. On logout it is
 * stashed under a user-scoped key and the live session is cleared, so the
 * previous user's book never leaks into the anonymous/guest context (the
 * backend treats a cookie-less request as pre-auth and would otherwise allow
 * access to any book). On login the same user's stashed session is re-attached,
 * never clobbering a newer live one. Book ownership in the DB is untouched —
 * only the client-side session pointer moves.
 *
 * The class is pure (no Android framework calls) so the logout/login isolation
 * rules can be unit-tested on the JVM with an in-memory [KeyValueStore]; the
 * production build wires it over SharedPreferences via [SharedPrefsKeyValueStore].
 */
class BookSessionStore(private val kv: KeyValueStore) {

    /** Minimal key-value abstraction (SharedPreferences in prod, in-memory map in tests). */
    interface KeyValueStore {
        fun getString(key: String): String?

        /** A null [value] removes the key. */
        fun putString(key: String, value: String?)
    }

    data class Session(val bookId: String, val buildId: String) {
        val isEmpty: Boolean get() = bookId.isBlank()
    }

    companion object {
        // Live (currently open) book session keys — the same SharedPreferences
        // keys the GenerateViewModel has always used, kept for backward compatibility.
        const val LIVE_BOOK_KEY = "bookId"
        const val LIVE_BUILD_KEY = "buildId"

        // Per-user stash key, web parity with 'animastor:currentBook:user:<userId>'.
        fun userStashKey(userId: String): String = "currentBook:user:$userId"

        private fun userStashBuildKey(userId: String): String = "currentBook:user:$userId:build"
    }

    fun loadLive(): Session =
        Session(kv.getString(LIVE_BOOK_KEY) ?: "", kv.getString(LIVE_BUILD_KEY) ?: "")

    fun persistLive(bookId: String, buildId: String) {
        kv.putString(LIVE_BOOK_KEY, bookId)
        kv.putString(LIVE_BUILD_KEY, buildId)
    }

    fun clearLive() {
        kv.putString(LIVE_BOOK_KEY, null)
        kv.putString(LIVE_BUILD_KEY, null)
    }

    /**
     * Logout: stash the live session for [userId] and clear it. Mirrors
     * stashBookSessionForUser. Stashing with no open book removes any previous
     * stash for that user (web parity: logging out with no book open leaves no
     * stale stash to resurrect on the next login).
     */
    fun stashForUser(userId: String?) {
        val live = loadLive()
        if (!userId.isNullOrBlank()) {
            if (!live.isEmpty) {
                kv.putString(userStashKey(userId), live.bookId)
                kv.putString(userStashBuildKey(userId), live.buildId)
            } else {
                kv.putString(userStashKey(userId), null)
                kv.putString(userStashBuildKey(userId), null)
            }
        }
        clearLive()
    }

    /**
     * Login: re-attach [userId]'s stashed session unless a live session
     * already exists (never clobber a newer one). Mirrors
     * restoreStashedBookSessionForUser. No-op for a null/blank [userId].
     */
    fun restoreStashedForUser(userId: String?) {
        if (userId.isNullOrBlank()) return
        if (!loadLive().isEmpty) return
        val stashedBook = kv.getString(userStashKey(userId))
        if (stashedBook.isNullOrBlank()) return
        val stashedBuild = kv.getString(userStashBuildKey(userId)) ?: ""
        persistLive(stashedBook, stashedBuild)
    }
}

/** Production [BookSessionStore.KeyValueStore] over [SharedPreferences]. */
class SharedPrefsKeyValueStore(private val prefs: SharedPreferences) : BookSessionStore.KeyValueStore {
    override fun getString(key: String): String? = prefs.getString(key, null)
    override fun putString(key: String, value: String?) {
        val editor = prefs.edit()
        if (value == null) editor.remove(key) else editor.putString(key, value)
        editor.apply()
    }
}
