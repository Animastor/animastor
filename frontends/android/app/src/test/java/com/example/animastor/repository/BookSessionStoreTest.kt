package com.example.animastor.repository

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Book session stash/restore + cross-user isolation — Android parity with
 * frontends/app/src/state/__tests__/auth-book-session.test.ts and the
 * ownership-scoped TXT import contract (identity + TXT → owned book).
 *
 * Pure JVM: exercises [BookSessionStore] over an in-memory [MemKv] so no
 * Android framework or device is required.
 */
class BookSessionStoreTest {

    /** In-memory KeyValueStore standing in for SharedPreferences. */
    private class MemKv : BookSessionStore.KeyValueStore {
        val m = HashMap<String, String>()
        override fun getString(key: String): String? = m[key]
        override fun putString(key: String, value: String?) {
            if (value == null) m.remove(key) else m[key] = value
        }
    }

    private lateinit var kv: MemKv
    private lateinit var store: BookSessionStore

    @Before
    fun setUp() {
        kv = MemKv()
        store = BookSessionStore(kv)
    }

    // ── stash / restore primitives (web parity) ─────────────────────────

    @Test
    fun stash_movesLiveSessionToPerUserKey_andClearsLive() {
        store.persistLive("book-abc", "build-1")
        store.stashForUser("user-42")

        assertTrue(store.loadLive().isEmpty)
        assertEquals("book-abc", kv.getString(BookSessionStore.userStashKey("user-42")))
        assertNull(kv.getString(BookSessionStore.LIVE_BOOK_KEY))
    }

    @Test
    fun restore_reattachesStashedSession_whenLiveEmpty() {
        kv.putString(BookSessionStore.userStashKey("u1"), "x9")
        kv.putString("currentBook:user:u1:build", "b2")

        store.restoreStashedForUser("u1")
        assertEquals("x9", store.loadLive().bookId)
        assertEquals("b2", store.loadLive().buildId)
    }

    @Test
    fun restore_doesNotClobberExistingLiveSession() {
        store.persistLive("live-book", "")
        kv.putString(BookSessionStore.userStashKey("u1"), "stashed-book")

        store.restoreStashedForUser("u1")
        assertEquals("live-book", store.loadLive().bookId)
    }

    @Test
    fun restore_isNoOpForNullOrBlankUserId() {
        kv.putString(BookSessionStore.userStashKey("u1"), "x")
        store.restoreStashedForUser(null)
        store.restoreStashedForUser("")
        assertTrue(store.loadLive().isEmpty)
    }

    @Test
    fun stash_withNoOpenBook_removesPreviousStash() {
        kv.putString(BookSessionStore.userStashKey("u1"), "old-book")
        store.stashForUser("u1")
        assertNull(kv.getString(BookSessionStore.userStashKey("u1")))
    }

    // ── TXT import ownership contract (identity + TXT → book) ───────────
    // The backend resolves dedup server-side from the cookie identity and
    // returns the book_id to open; the client's job is to make that returned
    // book the current session. These tests pin the client-side session
    // behaviour that underpins the required regression scenarios.

    @Test
    fun sureg_importsExistingTxt_opensReturnedSameBook() {
        // sureg + existing TXT → backend dedup returns the SAME owned book_id;
        // persisting it again must keep it as the current book (idempotent).
        store.persistLive("import_1786345731767", "bld")
        store.persistLive("import_1786345731767", "bld") // re-import dedup hit
        assertEquals("import_1786345731767", store.loadLive().bookId)
    }

    @Test
    fun userB_sameTxt_getsTheirOwnNewBook_notSuregs() {
        // sureg's book is stashed under sureg's key; user B's live session is a
        // different book and must never resolve to sureg's.
        store.persistLive("sureg-book", "")
        store.stashForUser("sureg")

        store.persistLive("userB-book", "")
        assertEquals("userB-book", store.loadLive().bookId)
        // B's restore must not surface sureg's stashed book.
        store.restoreStashedForUser("userB")
        assertEquals("userB-book", store.loadLive().bookId)
    }

    @Test
    fun guest_sameTxt_getsTheirOwnNewBook() {
        // A guest identity importing the same TXT gets a fresh guest-owned book,
        // distinct from any authenticated user's book for the same content.
        store.persistLive("sureg-book", "")
        store.stashForUser("sureg")

        store.persistLive("guest-book", "")
        assertEquals("guest-book", store.loadLive().bookId)
    }

    @Test
    fun guest_reimports_getsSameGuestBook() {
        // Repeat guest import → backend dedup returns the guest's OWN book;
        // the client keeps it as the current session.
        store.persistLive("guest-book", "")
        store.persistLive("guest-book", "") // repeat import dedup hit
        assertEquals("guest-book", store.loadLive().bookId)
    }

    // ── logout / login isolation (the core cross-user guarantee) ────────

    @Test
    fun logoutSureg_guestDoesNotReceiveSuregsBook() {
        store.persistLive("import_1786345731767", "bld")
        store.stashForUser("sureg")

        // After logout the live session is empty — the anonymous/guest context
        // sees no book, and sureg's book only exists under sureg's stash key.
        assertTrue(store.loadLive().isEmpty)
        assertEquals("import_1786345731767", kv.getString(BookSessionStore.userStashKey("sureg")))
        // A guest restore attempt must not surface sureg's book.
        store.restoreStashedForUser(null)
        assertTrue(store.loadLive().isEmpty)
    }

    @Test
    fun loginSureg_restoresHisBook() {
        store.persistLive("import_1786345731767", "bld")
        store.stashForUser("sureg")
        assertTrue(store.loadLive().isEmpty)

        store.restoreStashedForUser("sureg")
        assertEquals("import_1786345731767", store.loadLive().bookId)
        assertEquals("bld", store.loadLive().buildId)
    }

    @Test
    fun crossUserSessionIsolation_loginNeverRestoresAnotherUsersStash() {
        store.persistLive("their-book", "")
        store.stashForUser("other-user")

        store.restoreStashedForUser("sureg")
        assertTrue(store.loadLive().isEmpty)
    }

    // ── restart equivalence (process / Activity recreation) ─────────────

    @Test
    fun appRestart_keepsCurrentBookForSameIdentity() {
        store.persistLive("book-xyz", "b9")
        // A fresh store over the same backing storage (process recreation) must
        // read back the same live session.
        val recreated = BookSessionStore(kv)
        assertEquals("book-xyz", recreated.loadLive().bookId)
        assertEquals("b9", recreated.loadLive().buildId)
    }

    @Test
    fun restartAfterLogout_doesNotLeakStashedBook() {
        store.persistLive("sureg-book", "")
        store.stashForUser("sureg")

        // Recreate the store (app restart) in the now-anonymous context: the live
        // session stays empty and sureg's stash is not auto-restored.
        val recreated = BookSessionStore(kv)
        assertTrue(recreated.loadLive().isEmpty)
        recreated.restoreStashedForUser(null)
        assertTrue(recreated.loadLive().isEmpty)
    }
}
