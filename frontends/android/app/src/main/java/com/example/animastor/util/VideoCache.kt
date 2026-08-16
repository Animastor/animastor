package com.example.animastor.util

import android.content.Context
import android.util.Log
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import java.io.File

/**
 * Application-scoped persistent disk cache for VIDEO, backed by Media3's native
 * SimpleCache + CacheDataSource.
 *
 * The video keeps streaming on-demand (progressive MP4 over HTTP Range) — nothing
 * is pre-downloaded. Byte ranges already fetched are written to the disk cache and
 * served from it on repeat seeks (jumping back into a watched range never hits the
 * network again); ranges not yet cached go to the server as ordinary Range requests
 * and are then cached. Audio/image/iu caching (SimpleDiskCache) is untouched.
 *
 * The cache lives for the whole process (survives Player-screen re-creation and
 * re-opens) and is capped by an LRU evictor: when the cap is reached, the least
 * recently used ranges are evicted.
 */
object VideoCache {

    private const val TAG = "VideoCache"

    /** Size cap for the whole video cache. Tune per device class — old ranges are
     *  evicted LRU, so the cache can never outgrow this. */
    private const val MAX_CACHE_BYTES = 250L * 1024 * 1024 // 250 MB

    @Volatile
    private var cache: SimpleCache? = null

    /** Returns the shared SimpleCache, creating it on first use. Never returns a
     *  broken cache: if initialization fails (corrupted DB etc.) the cache dir is
     *  wiped once and rebuilt; if that still fails, null is returned and the player
     *  simply streams without a disk cache. */
    fun get(context: Context): SimpleCache? {
        cache?.let { return it }
        synchronized(this) {
            cache?.let { return it }
            val dir = File(context.cacheDir, "media3-video")
            cache = build(dir, context)
            return cache
        }
    }

    /** DataSource.Factory that reads through the disk cache (if available), falling
     *  back to plain upstream streaming otherwise. Used ONLY for the network video
     *  URL — the local audio file keeps its plain factory. */
    fun dataSourceFactory(context: Context, upstream: DataSource.Factory): DataSource.Factory {
        val c = get(context) ?: return upstream
        return CacheDataSource.Factory()
            .setCache(c)
            .setUpstreamDataSourceFactory(upstream)
    }

    private fun build(dir: File, context: Context): SimpleCache? {
        runCatching {
            return SimpleCache(
                dir,
                LeastRecentlyUsedCacheEvictor(MAX_CACHE_BYTES),
                StandaloneDatabaseProvider(context)
            )
        }.onFailure { e ->
            Log.e(TAG, "cache init failed: ${e.message} — wiping and retrying once")
        }
        // Corrupted cache (e.g. app killed mid-write) — wipe and rebuild once.
        runCatching { dir.deleteRecursively() }
        return runCatching {
            SimpleCache(
                dir,
                LeastRecentlyUsedCacheEvictor(MAX_CACHE_BYTES),
                StandaloneDatabaseProvider(context)
            )
        }.getOrElse { e ->
            Log.e(TAG, "cache init failed twice: ${e.message} — continuing without cache")
            null
        }
    }
}
