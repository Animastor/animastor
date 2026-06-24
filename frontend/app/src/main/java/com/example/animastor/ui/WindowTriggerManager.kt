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
 * Works from any screen — Edit, Navigate, Play.
 *
 * **Important**: Only triggers on explicit `isLastOfWindow` boundaries
 * (every 3rd scene). Does NOT trigger on `isLastChapterScene` alone,
 * which previously caused infinite re-triggering during auto-playback.
 * A cooldown prevents rapid re-triggers.
 */
class WindowTriggerManager(
    private val repository: Repository,
    private val scope: CoroutineScope
) {

    companion object {
        private const val TAG = "WindowTrigger"
        private const val WINDOW_SIZE = 3
        private const val COOLDOWN_MS = 60_000L // 1 min between triggers
    }

    private var collectionJob: Job? = null
    private val triggeredWindows = mutableSetOf<String>()

    // Cache for book data — only re-fetch when chapter or scene changes
    private var cachedBookChapters: List<com.example.animastor.repository.Chapter>? = null
    private var lastChapterId: String? = null
    private var lastSceneId: String? = null

    // Cooldown: prevents rapid re-triggers during playback auto-cycling
    private var lastTriggerTime = 0L

    // Track last-scene-unit to only trigger once when entering the last-3-zone,
    // not on every auto-cycling step within it.
    private var lastCheckedUnitIndex = -1
    private var lastCheckedSceneId: String? = null

    /**
     * Start observing position changes. Call this when a book is loaded.
     */
    fun start(bookId: String) {
        if (bookId.isBlank()) return
        cachedBookChapters = null
        lastChapterId = null
        lastSceneId = null
        lastTriggerTime = 0L
        lastCheckedUnitIndex = -1
        lastCheckedSceneId = null
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
        lastTriggerTime = 0L
        lastCheckedUnitIndex = -1
        lastCheckedSceneId = null
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

        // ── Cooldown: don't trigger more often than once per interval ──
        val now = System.currentTimeMillis()
        if (now - lastTriggerTime < COOLDOWN_MS) return

        // Fetch book data — only re-fetch when chapter or scene changes
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

        // ── Only trigger on IS_LAST_OF_WINDOW boundary ─────────────
        // Not on isLastChapterScene alone — that caused infinite
        // re-triggers during playback (auto-play hits every last scene).
        val isLastOfWindow = scIdx % WINDOW_SIZE == (WINDOW_SIZE - 1)
        if (!isLastOfWindow) return

        // ── One-shot per unit position within the scene ────────────
        // Avoid re-triggering as auto-play cycles through the last 3 units.
        if (idx == lastCheckedUnitIndex && pos.sceneId == lastCheckedSceneId) return
        lastCheckedUnitIndex = idx
        lastCheckedSceneId = pos.sceneId

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
        // Always update cooldown — even on queue/error — to prevent rapid retries
        lastTriggerTime = System.currentTimeMillis()
    }
}
