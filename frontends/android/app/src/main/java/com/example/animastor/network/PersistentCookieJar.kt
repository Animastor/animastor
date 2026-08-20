package com.example.animastor.network

import android.content.Context
import android.content.SharedPreferences
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import org.json.JSONArray
import org.json.JSONObject

/**
 * Persistent cookie jar (web parity). The backend is cookie-authenticated:
 * it sets an HttpOnly `animastor_sid` session cookie on login/register and a
 * `animastor_gid` guest cookie on first write. OkHttp does not persist cookies
 * across process restarts by default, so without this jar the app would lose
 * the session every cold start and silently behave as a guest.
 *
 * Cookies are stored in SharedPreferences (not in-memory) so a restart keeps
 * the logged-in identity. Only the backend's host is relevant (HttpUrl.host),
 * matching browser scoping per-domain.
 */
class PersistentCookieJar(private val prefs: SharedPreferences) : CookieJar {

    private val cache = mutableMapOf<String, MutableList<Cookie>>()

    init {
        // Hydrate from disk once.
        val raw = prefs.getString(KEY_COOKIES, null)
        if (raw != null) try {
            val byHost = JSONObject(raw)
            for (host in byHost.keys()) {
                val arr = byHost.getJSONArray(host)
                val list = mutableListOf<Cookie>()
                for (i in 0 until arr.length()) {
                    val cookieStr = arr.getString(i)
                    // Parse against the host to reconstruct a valid Cookie.
                    val url = HttpUrl.Builder().scheme("https").host(host).build()
                    Cookie.parse(url, cookieStr)?.let(list::add)
                }
                if (list.isNotEmpty()) cache[host] = list
            }
        } catch (_: Exception) {
            // Corrupt store → start clean.
        }
    }

    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        val host = url.host
        val list = cache.getOrPut(host) { mutableListOf() }
        // Replace same-name cookies (session refresh) rather than appending.
        cookies.forEach { incoming ->
            list.removeAll { it.name == incoming.name }
            list.add(incoming)
        }
        // Drop expired / cleared cookies (Max-Age=0 deletes the session).
        list.removeAll { it.expiresAt <= System.currentTimeMillis() }
        persist()
    }

    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        val list = cache[url.host] ?: return emptyList()
        // Expired entries should not be sent.
        val now = System.currentTimeMillis()
        return list.filter { it.expiresAt > now }
    }

    private fun persist() {
        try {
            val json = JSONObject()
            for ((host, list) in cache) {
                val arr = JSONArray()
                list.forEach { arr.put(it.toString()) }
                json.put(host, arr)
            }
            prefs.edit().putString(KEY_COOKIES, json.toString()).apply()
        } catch (_: Exception) {
            // Persistence is best-effort; auth still works in-memory.
        }
    }

    /** Remove all stored cookies (on logout). */
    fun clear() {
        cache.clear()
        prefs.edit().remove(KEY_COOKIES).apply()
    }

    companion object {
        private const val KEY_COOKIES = "animastor_cookies"
    }
}
