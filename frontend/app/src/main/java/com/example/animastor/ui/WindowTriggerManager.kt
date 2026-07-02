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
 * units of the current book tail scene.
 *
 * Works from any screen — Edit, Navigate, Play.
 *
 * The backend advances TXT/VBook imports by the scenes it actually created,
 * not by fixed three-scene chunks. Therefore the frontend treats the last
 * currently loaded content scene as the generation frontier and lets the
 * backend decide where the next window starts.
 */
class WindowTriggerManager(
    private val repository: Repository,
    private val scope: CoroutineScope
) {

    companion object {
        private const val TAG = "WindowTrigger"
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

        // Trigger only at the current generated frontier: the last content
        // scene across the loaded book JSON. If the backend adds fewer than
        // 3 scenes in a pass, this still advances naturally from that tail.
        val contentTail = chapters.asSequence()
            .flatMap { chapter ->
                (chapter.scenes ?: emptyList()).asSequence()
                    .filter { it.type != "chapter_intro" && it.type != "cover" }
                    .map { scene -> chapter.chapter to scene.scene_id }
            }
            .lastOrNull() ?: return

        val isLoadedTail = contentTail.first == pos.chapterId && contentTail.second == pos.sceneId
        if (!isLoadedTail) return

        // Dedup by generated frontier. When the backend appends scenes, the
        // tail scene id changes and a future trigger is allowed.
        val windowKey = "${contentTail.first}:${contentTail.second}"
        if (triggeredWindows.contains(windowKey)) return
        triggeredWindows.add(windowKey)

        // ── One-shot per unit position within the scene ────────────
        // Avoid re-triggering as auto-play cycles through the last 3 units.
        if (idx == lastCheckedUnitIndex && pos.sceneId == lastCheckedSceneId) return
        lastCheckedUnitIndex = idx
        lastCheckedSceneId = pos.sceneId

        val unitId = units.getOrNull(idx)?.id
        Log.i(TAG, "triggering next window at generated tail (ch=${pos.chapterId} sc=$scIdx unit=$idx tail=$windowKey)")

        try {
            val result = repository.triggerNextWindow(
                bookId = bookId,
                chapterId = pos.chapterId,
                sceneId = pos.sceneId,
                unitId = unitId,
                registerForGpu = true
            )
            Log.i(TAG, "triggerNextWindow: triggered=${result.triggered} queued=${result.queued} all_done=${result.all_done}")
            if (!result.triggered && !result.queued && !result.all_done && result.error != null) {
                triggeredWindows.remove(windowKey)
            }
        } catch (e: Exception) {
            triggeredWindows.remove(windowKey)
            Log.w(TAG, "triggerNextWindow failed: ${e.message}")
        }
        // Always update cooldown — even on queue/error — to prevent rapid retries
        lastTriggerTime = System.currentTimeMillis()
    }
}
