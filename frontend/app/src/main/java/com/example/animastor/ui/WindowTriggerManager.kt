package com.example.animastor.ui

import android.util.Log
import com.example.animastor.repository.Repository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * Global observer of [SharedPositionManager] that automatically triggers
 * the next-window generation when the user navigates to one of the last 3
 * units of the last scene in a window (WINDOW_SIZE = 3 scenes per window).
 *
 * Works from any screen — Edit, Navigate, Play — because it observes the
 * shared position flow via [SharedPositionManager.current].
 */
class WindowTriggerManager(
    private val repository: Repository,
    private val scope: CoroutineScope
) {

    companion object {
        private const val TAG = "WindowTrigger"
        private const val WINDOW_SIZE = 3
    }

    private var collectionJob: Job? = null
    private val triggeredWindows = mutableSetOf<String>()

    // Cache for book data — only re-fetch when chapter or scene changes
    // to avoid excessive API calls during playback (position fires every 50ms).
    private var cachedBookChapters: List<com.example.animastor.repository.Chapter>? = null
    private var lastChapterId: String? = null
    private var lastSceneId: String? = null

    /**
     * Start observing position changes. Call this when a book is loaded.
     */
    fun start(bookId: String) {
        if (bookId.isBlank()) return
        cachedBookChapters = null
        lastChapterId = null
        lastSceneId = null
        collectionJob?.cancel()
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
        triggeredWindows.clear()
        cachedBookChapters = null
        lastChapterId = null
        lastSceneId = null
        Log.i(TAG, "stopped")
    }

    /**
     * Reset dedup set — call after a fresh generation so windows can be retriggered.
     */
    fun resetDedup() {
        triggeredWindows.clear()
        Log.i(TAG, "dedup reset")
    }

    private suspend fun checkEndOfWindow(bookId: String, pos: ActivePosition) {
        val idx = pos.unitIndex
        if (idx < 0) return

        // Fetch book data — only re-fetch when chapter or scene changes
        // (unit-to-unit navigation within the same scene reuses the cache).
        val chapters = if (pos.chapterId != lastChapterId || pos.sceneId != lastSceneId) {
            lastChapterId = pos.chapterId
            lastSceneId = pos.sceneId
            try {
                val bookData = repository.getBook(bookId)
                bookData.chapters
            } catch (e: Exception) {
                Log.w(TAG, "getBook failed: ${e.message}")
                return
            }
        } else {
            cachedBookChapters
        } ?: return
        cachedBookChapters = chapters

        // Find the chapter
        val ch = chapters.firstOrNull { it.chapter == pos.chapterId } ?: return
        val scenes = ch.scenes ?: return
        val scIdx = scenes.indexOfFirst { it.scene_id == pos.sceneId }
        if (scIdx < 0) return

        // Find the scene
        val sc = scenes.getOrNull(scIdx) ?: return
        val units = sc.units ?: return
        if (units.isEmpty()) return

        // Condition 1: unit must be among the last 3 of the scene
        val last3Start = if (units.size <= 3) 0 else units.size - 3
        if (idx < last3Start) return

        // Condition 2: scene must be the last in its window (WINDOW_SIZE=3)
        val isLastOfWindow = scIdx % WINDOW_SIZE == (WINDOW_SIZE - 1)
        val isLastChapterScene = scIdx == scenes.size - 1
        if (!isLastOfWindow && !isLastChapterScene) return

        // Dedup by window key
        val windowKey = "${pos.chapterId}:${scIdx / WINDOW_SIZE}"
        if (triggeredWindows.contains(windowKey)) return
        triggeredWindows.add(windowKey)

        val unitId = units.getOrNull(idx)?.id
        Log.i(TAG, "triggering next window (ch=${pos.chapterId} sc=$scIdx unit=$idx windowKey=$windowKey)")

        try {
            val result = repository.triggerNextWindow(
                bookId = bookId,
                chapterId = pos.chapterId,
                sceneId = pos.sceneId,
                unitId = unitId,
                registerForGpu = true
            )
            Log.i(TAG, "triggerNextWindow: triggered=${result.triggered} queued=${result.queued} all_done=${result.all_done}")
        } catch (e: Exception) {
            Log.w(TAG, "triggerNextWindow failed: ${e.message}")
        }
    }
}
