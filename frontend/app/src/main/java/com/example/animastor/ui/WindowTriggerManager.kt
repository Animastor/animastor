package com.example.animastor.ui

import android.util.Log
import com.example.animastor.repository.Repository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * Global observer of [SharedPositionManager] that delegates the
 * "should I trigger the next window" decision to the backend.
 *
 * The server checks: content-tail position, last-3 units, cooldown (60s),
 * and frontier dedup. The client is a thin relay — it observes position
 * changes and calls POST /trigger-next-window at most once per 2s.
 *
 * Works from any screen — Edit, Navigate, Play.
 */
class WindowTriggerManager(
    private val repository: Repository,
    private val scope: CoroutineScope
) {

    companion object {
        private const val TAG = "WindowTrigger"
        /** Throttle — at most one API call per interval, regardless of outcome. */
        private const val THROTTLE_MS = 2_000L
    }

    private var collectionJob: Job? = null
    private var lastApiCallTime = 0L
    private var lastChapterId: String? = null
    private var lastSceneId: String? = null
    private var lastUnitIndex = -1

    /**
     * Start observing position changes. Call this when a book is loaded.
     */
    fun start(bookId: String) {
        if (bookId.isBlank()) return
        // Cancel the previous collection job BEFORE starting a new one.
        // Without this, two jobs run in parallel sharing the same throttle
        // state (lastApiCallTime, etc.), causing the new job to be permanently
        // throttled by the stale job's API calls with the wrong bookId.
        collectionJob?.cancel()
        collectionJob = null
        resetState()
        collectionJob = scope.launch {
            SharedPositionManager.current.collectLatest { pos ->
                if (pos.chapterId == null || pos.sceneId == null) return@collectLatest
                checkEndOfWindow(bookId, pos)
            }
        }
        Log.i(TAG, "started watching position for $bookId")
    }

    /**
     * Stop observing. Call this when the book is closed.
     */
    fun stop() {
        collectionJob?.cancel()
        collectionJob = null
        resetState()
        Log.i(TAG, "stopped")
    }

    private fun resetState() {
        lastApiCallTime = 0L
        lastChapterId = null
        lastSceneId = null
        lastUnitIndex = -1
    }

    private suspend fun checkEndOfWindow(bookId: String, pos: ActivePosition) {
        val idx = pos.unitIndex
        if (idx < 0) return

        // Skip if position hasn't changed since last check
        if (pos.chapterId == lastChapterId && pos.sceneId == lastSceneId && idx == lastUnitIndex) return

        // ── Throttle: at most one API call per interval.  Wait instead of
        // dropping: the position flow only emits on change, so a dropped
        // position would never be re-delivered and its trigger would be lost
        // (dedup above would then suppress it forever).  collectLatest cancels
        // this delay if a newer position arrives.
        val wait = THROTTLE_MS - (System.currentTimeMillis() - lastApiCallTime)
        if (wait > 0) delay(wait)

        lastChapterId = pos.chapterId
        lastSceneId = pos.sceneId
        lastUnitIndex = idx
        lastApiCallTime = System.currentTimeMillis()

        // Delegate to server — it decides based on content tail, last-3, cooldown, dedup
        try {
            val result = repository.triggerNextWindow(
                bookId = bookId,
                chapterId = pos.chapterId,
                sceneId = pos.sceneId,
                unitId = pos.unitId,
                unitIndex = idx,
                registerForGpu = true
            )
            if (result.triggered || result.queued) {
                Log.i(TAG, "triggerNextWindow: triggered=${result.triggered} queued=${result.queued} window=${result.window_index} all_done=${result.all_done}")
            } else if (result.reason != null) {
                Log.d(TAG, "triggerNextWindow: skipped (reason=${result.reason})")
            }
        } catch (e: Exception) {
            Log.w(TAG, "triggerNextWindow failed: ${e.message}")
        }
    }
}
